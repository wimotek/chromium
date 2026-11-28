package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/wimotek/url/internal/config"
	"github.com/wimotek/url/internal/db"
)

type OAuthStateEntry struct {
	State        string
	CodeVerifier string
	ReturnTo     string
	RedirectURI  string
	ExpiresAt    time.Time
}

type OAuthUserInfo struct {
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
	PreferredName string `json:"preferred_username"`
}

type Service struct {
	cfg            *config.Manager
	store          *db.Store
	rateMu         sync.Mutex
	loginAttempts  map[string][]time.Time
	redirAttempts  map[string][]time.Time
	oauthMu        sync.Mutex
	oauthStates    map[string]OAuthStateEntry
	challengeMu    sync.Mutex
	usedChallenges map[string]time.Time
	revokeMu       sync.RWMutex
	revokedUsers   map[string]time.Time
	blockedCount   atomic.Int64
}

type SessionClaims struct {
	UserID   string `json:"uid"`
	Email    string `json:"email"`
	Role     string `json:"role"`
	IssuedAt int64  `json:"iat"`
	Expires  int64  `json:"exp"`
	Provider string `json:"prv"`
}

func NewService(cfg *config.Manager, store *db.Store) *Service {
	return &Service{
		cfg:            cfg,
		store:          store,
		loginAttempts:  make(map[string][]time.Time),
		redirAttempts:  make(map[string][]time.Time),
		oauthStates:    make(map[string]OAuthStateEntry),
		usedChallenges: make(map[string]time.Time),
		revokedUsers:   make(map[string]time.Time),
	}
}

func HashPassword(plain string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	return string(b), err
}

func VerifyPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}

func (s *Service) RecordBlocked() {
	s.blockedCount.Add(1)
}

func (s *Service) BlockedCount() int64 {
	return s.blockedCount.Load()
}

// ValidateReturnTo strictly allows only same-origin relative paths starting with "/" and not "//".
func ValidateReturnTo(raw, fallback string) string {
	if fallback == "" {
		fallback = "/"
	}
	v := strings.TrimSpace(raw)
	if v == "" || !strings.HasPrefix(v, "/") || strings.HasPrefix(v, "//") || strings.ContainsAny(v, "\\\r\n") {
		return fallback
	}
	blocked := []string{"/logged-out", "/login", "/callback", "/auth/callback"}
	for _, b := range blocked {
		if v == b || strings.HasPrefix(v, b+"?") || strings.HasPrefix(v, b+"/") {
			return fallback
		}
	}
	return v
}

// RemainingLoginAttempts reports remaining attempts without consuming one.
func (s *Service) RemainingLoginAttempts(ip string, maxPerWindow int, window time.Duration) int {
	s.rateMu.Lock()
	defer s.rateMu.Unlock()
	if maxPerWindow <= 0 {
		maxPerWindow = 5
	}
	cutoff := time.Now().Add(-window)
	prev := s.loginAttempts[ip]
	count := 0
	for _, ts := range prev {
		if ts.After(cutoff) {
			count++
		}
	}
	rem := maxPerWindow - count
	if rem < 0 {
		return 0
	}
	return rem
}

// AllowLoginAttempt enforces per-IP sliding window rate limiting against brute-force attacks.
func (s *Service) AllowLoginAttempt(ip string, maxPerWindow int, window time.Duration) (bool, int, int) {
	s.rateMu.Lock()
	defer s.rateMu.Unlock()

	if maxPerWindow <= 0 {
		maxPerWindow = 5
	}
	now := time.Now()
	cutoff := now.Add(-window)
	prev := s.loginAttempts[ip]
	kept := prev[:0]
	for _, ts := range prev {
		if ts.After(cutoff) {
			kept = append(kept, ts)
		}
	}
	if len(kept) >= maxPerWindow {
		s.loginAttempts[ip] = kept
		retrySec := int(time.Until(kept[0].Add(window)).Seconds())
		if retrySec < 1 {
			retrySec = 1
		}
		s.RecordBlocked()
		return false, 0, retrySec
	}
	kept = append(kept, now)
	s.loginAttempts[ip] = kept
	return true, maxPerWindow - len(kept), 0
}

// ResetLoginAttempts clears failed login history after successful login.
func (s *Service) ResetLoginAttempts(ip string) {
	s.rateMu.Lock()
	defer s.rateMu.Unlock()
	delete(s.loginAttempts, ip)
}

// AllowRedirect enforces per-IP 1-minute sliding window rate limiting on short link resolution.
func (s *Service) AllowRedirect(ip string, maxPerMin int) bool {
	if maxPerMin <= 0 {
		return true
	}
	s.rateMu.Lock()
	defer s.rateMu.Unlock()

	now := time.Now()
	cutoff := now.Add(-time.Minute)
	prev := s.redirAttempts[ip]
	kept := prev[:0]
	for _, ts := range prev {
		if ts.After(cutoff) {
			kept = append(kept, ts)
		}
	}
	if len(kept) >= maxPerMin {
		s.redirAttempts[ip] = kept
		s.RecordBlocked()
		return false
	}
	s.redirAttempts[ip] = append(kept, now)
	return true
}

// CreateBotChallenge generates a signed zero-dependency math challenge (HMAC-SHA256, 5-min TTL).
func (s *Service) CreateBotChallenge() (string, string) {
	a := cryptoRandInt(2, 11)
	b := cryptoRandInt(1, 9)
	ans := a + b
	nonce := RandomToken(8)
	exp := time.Now().Add(5 * time.Minute).Unix()
	payload := fmt.Sprintf("%s.%d.%d", nonce, ans, exp)
	mac := hmac.New(sha256.New, []byte(s.cfg.Get().SessionSecret))
	_, _ = mac.Write([]byte("bot:" + payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	token := base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + sig
	question := fmt.Sprintf("%d + %d = ?", a, b)
	return token, question
}

// VerifyBotChallenge validates the built-in signed challenge, replay protection, and honeypot field.
func (s *Service) VerifyBotChallenge(token, answer, honeypot string) error {
	if strings.TrimSpace(honeypot) != "" {
		s.RecordBlocked()
		return errors.New("bot traffic rejected")
	}
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 2 {
		s.RecordBlocked()
		return errors.New("请刷新并完成防机器人人机验证")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		s.RecordBlocked()
		return errors.New("人机验证令牌无效，请重试")
	}
	payload := string(raw)
	mac := hmac.New(sha256.New, []byte(s.cfg.Get().SessionSecret))
	_, _ = mac.Write([]byte("bot:" + payload))
	expectedSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(parts[1]), []byte(expectedSig)) {
		s.RecordBlocked()
		return errors.New("人机验证签名校验失败")
	}
	fields := strings.Split(payload, ".")
	if len(fields) != 3 {
		return errors.New("人机验证令牌格式无效")
	}
	nonce := fields[0]
	expectedAns, err1 := strconv.Atoi(fields[1])
	expUnix, err2 := strconv.ParseInt(fields[2], 10, 64)
	if err1 != nil || err2 != nil || time.Now().Unix() > expUnix {
		return errors.New("人机验证码已过期，请刷新重试")
	}

	s.challengeMu.Lock()
	now := time.Now()
	for k, t := range s.usedChallenges {
		if now.After(t) {
			delete(s.usedChallenges, k)
		}
	}
	if _, used := s.usedChallenges[nonce]; used {
		s.challengeMu.Unlock()
		return errors.New("人机验证码已使用，请刷新后重试")
	}
	s.usedChallenges[nonce] = time.Unix(expUnix, 0)
	s.challengeMu.Unlock()

	provided, err := strconv.Atoi(strings.TrimSpace(answer))
	if err != nil || provided != expectedAns {
		s.RecordBlocked()
		return errors.New("人机验证计算结果不正确，请重试")
	}
	return nil
}

// VerifyTurnstile verifies Cloudflare Turnstile response token on the server.
func (s *Service) VerifyTurnstile(ctx context.Context, token, remoteIP string) error {
	secret := s.cfg.Get().EffectiveTurnstileSecretKey()
	if secret == "" {
		return nil
	}
	if strings.TrimSpace(token) == "" {
		s.RecordBlocked()
		return errors.New("missing Cloudflare Turnstile verification token")
	}

	form := url.Values{}
	form.Set("secret", secret)
	form.Set("response", token)
	if remoteIP != "" {
		form.Set("remoteip", remoteIP)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://challenges.cloudflare.com/turnstile/v0/siteverify", strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("turnstile siteverify request failed: %w", err)
	}
	defer resp.Body.Close()

	var body struct {
		Success bool `json:"success"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return err
	}
	if !body.Success {
		s.RecordBlocked()
		return errors.New("turnstile verification failed")
	}
	return nil
}

func (s *Service) SignToken(claims SessionClaims) (string, error) {
	if claims.IssuedAt == 0 {
		claims.IssuedAt = time.Now().Unix()
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(s.cfg.Get().SessionSecret))
	_, _ = mac.Write([]byte(enc))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return enc + "." + sig, nil
}

func (s *Service) VerifyToken(token string) (*SessionClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return nil, errors.New("invalid token structure")
	}
	mac := hmac.New(sha256.New, []byte(s.cfg.Get().SessionSecret))
	_, _ = mac.Write([]byte(parts[0]))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(parts[1]), []byte(expected)) {
		return nil, errors.New("invalid token signature")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, err
	}
	var claims SessionClaims
	if err := json.Unmarshal(raw, &claims); err != nil {
		return nil, err
	}
	if claims.Expires < time.Now().Unix() {
		return nil, errors.New("session expired")
	}
	if s.IsRevoked(claims.UserID, claims.IssuedAt) {
		return nil, errors.New("session revoked")
	}
	return &claims, nil
}

func (s *Service) RevokeUser(userID string) {
	s.revokeMu.Lock()
	defer s.revokeMu.Unlock()
	s.revokedUsers[userID] = time.Now()
}

func (s *Service) IsRevoked(userID string, issuedAt int64) bool {
	s.revokeMu.RLock()
	defer s.revokeMu.RUnlock()
	revokedAt, ok := s.revokedUsers[userID]
	if !ok {
		return false
	}
	return issuedAt <= revokedAt.Unix()
}

// StartOAuthFlow creates an Authorization Code + PKCE (S256) request with 5-minute TTL state.
func (s *Service) StartOAuthFlow(returnTo, redirectURI string) (authorizeURL, state, verifier string) {
	cfg := s.cfg.Get()
	if strings.TrimSpace(redirectURI) == "" {
		redirectURI = cfg.EffectiveOAuthRedirectURI()
	}
	safeReturn := ValidateReturnTo(returnTo, cfg.AdminPath)
	state = randomBase64URL(24)
	verifier = randomBase64URL(32)

	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	s.oauthMu.Lock()
	now := time.Now()
	for k, v := range s.oauthStates {
		if now.After(v.ExpiresAt) {
			delete(s.oauthStates, k)
		}
	}
	s.oauthStates[state] = OAuthStateEntry{
		State:        state,
		CodeVerifier: verifier,
		ReturnTo:     safeReturn,
		RedirectURI:  redirectURI,
		ExpiresAt:    now.Add(5 * time.Minute),
	}
	s.oauthMu.Unlock()

	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", cfg.EffectiveOAuthClientID())
	q.Set("redirect_uri", redirectURI)
	q.Set("scope", "openid profile email")
	q.Set("state", state)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	authorizeURL = cfg.EffectiveOAuthIssuer() + "/oauth/authorize?" + q.Encode()
	return authorizeURL, state, verifier
}

// ConsumeOAuthState validates and immediately destroys the single-use PKCE state.
func (s *Service) ConsumeOAuthState(state, cookieState, cookieVerifier string) (OAuthStateEntry, error) {
	if state == "" {
		return OAuthStateEntry{}, errors.New("missing OAuth state parameter")
	}
	s.oauthMu.Lock()
	entry, ok := s.oauthStates[state]
	delete(s.oauthStates, state)
	s.oauthMu.Unlock()

	if !ok || time.Now().After(entry.ExpiresAt) {
		return OAuthStateEntry{}, errors.New("OAuth state expired or invalid (possible CSRF)")
	}
	if cookieState != "" && !hmac.Equal([]byte(cookieState), []byte(state)) {
		return OAuthStateEntry{}, errors.New("OAuth cookie state mismatch")
	}
	if cookieVerifier != "" && !hmac.Equal([]byte(cookieVerifier), []byte(entry.CodeVerifier)) {
		return OAuthStateEntry{}, errors.New("PKCE code_verifier mismatch")
	}
	return entry, nil
}

// ExchangeCodeAndUserInfo performs the PKCE S256 token exchange and fetches OIDC userinfo.
func (s *Service) ExchangeCodeAndUserInfo(ctx context.Context, code, verifier, redirectURI string) (*OAuthUserInfo, error) {
	cfg := s.cfg.Get()
	issuer := cfg.EffectiveOAuthIssuer()
	clientID := cfg.EffectiveOAuthClientID()
	clientSecret := cfg.EffectiveOAuthSecret()
	if clientSecret == "" {
		return nil, errors.New("OAUTH_SECRET environment variable is not configured")
	}

	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	form.Set("client_id", clientID)
	form.Set("client_secret", clientSecret)
	form.Set("code_verifier", verifier)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, issuer+"/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("token exchange failed: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("oauth token endpoint returned HTTP %d", resp.StatusCode)
	}

	var tok struct {
		AccessToken string `json:"access_token"`
		IDToken     string `json:"id_token"`
	}
	if err := json.Unmarshal(bodyBytes, &tok); err != nil || tok.AccessToken == "" {
		return nil, errors.New("missing access_token in OAuth token response")
	}

	uiReq, err := http.NewRequestWithContext(ctx, http.MethodGet, issuer+"/oauth/userinfo", nil)
	if err != nil {
		return nil, err
	}
	uiReq.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	uiReq.Header.Set("Accept", "application/json")

	uiResp, err := client.Do(uiReq)
	if err != nil {
		return nil, fmt.Errorf("userinfo request failed: %w", err)
	}
	defer uiResp.Body.Close()

	if uiResp.StatusCode < 200 || uiResp.StatusCode >= 300 {
		return nil, fmt.Errorf("oauth userinfo endpoint returned HTTP %d", uiResp.StatusCode)
	}

	var info OAuthUserInfo
	if err := json.NewDecoder(io.LimitReader(uiResp.Body, 1<<20)).Decode(&info); err != nil {
		return nil, err
	}
	if strings.TrimSpace(info.Sub) == "" {
		return nil, errors.New("userinfo response missing sub")
	}
	return &info, nil
}

// VerifyWebhookSignature validates X-Wimotek-Signature-256 (HMAC-SHA256).
func VerifyWebhookSignature(body []byte, sigHeader, secret string) bool {
	if strings.TrimSpace(secret) == "" || strings.TrimSpace(sigHeader) == "" {
		return false
	}
	sig := strings.TrimPrefix(strings.TrimSpace(sigHeader), "sha256=")
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(strings.ToLower(sig)), []byte(strings.ToLower(expected)))
}

func RandomToken(bytesLen int) string {
	b := make([]byte, bytesLen)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func randomBase64URL(bytesLen int) string {
	b := make([]byte, bytesLen)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func cryptoRandInt(minVal, maxVal int) int {
	if maxVal <= minVal {
		return minVal
	}
	n, err := rand.Int(rand.Reader, big.NewInt(int64(maxVal-minVal+1)))
	if err != nil {
		return minVal
	}
	return minVal + int(n.Int64())
}
