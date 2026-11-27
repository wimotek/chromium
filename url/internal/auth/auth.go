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
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/wimotek/url/internal/config"
	"github.com/wimotek/url/internal/db"
)

type Service struct {
	cfg      *config.Manager
	store    *db.Store
	rateMu   sync.Mutex
	attempts map[string][]time.Time
}

type SessionClaims struct {
	UserID   string `json:"uid"`
	Email    string `json:"email"`
	Role     string `json:"role"`
	Expires  int64  `json:"exp"`
	Provider string `json:"prv"`
}

func NewService(cfg *config.Manager, store *db.Store) *Service {
	return &Service{
		cfg:      cfg,
		store:    store,
		attempts: make(map[string][]time.Time),
	}
}

func HashPassword(plain string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	return string(b), err
}

func VerifyPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}

// AllowLoginAttempt enforces per-IP sliding window rate limiting against brute-force attacks.
func (s *Service) AllowLoginAttempt(ip string, maxPerWindow int, window time.Duration) bool {
	s.rateMu.Lock()
	defer s.rateMu.Unlock()

	now := time.Now()
	cutoff := now.Add(-window)
	prev := s.attempts[ip]
	kept := prev[:0]
	for _, ts := range prev {
		if ts.After(cutoff) {
			kept = append(kept, ts)
		}
	}
	if len(kept) >= maxPerWindow {
		s.attempts[ip] = kept
		return false
	}
	s.attempts[ip] = append(kept, now)
	return true
}

// VerifyTurnstile verifies Cloudflare Turnstile response token on the server.
func (s *Service) VerifyTurnstile(ctx context.Context, token, remoteIP string) error {
	cfg := s.cfg.Get().Turnstile
	if !cfg.Enabled || cfg.SecretKey == "" {
		return nil
	}
	if strings.TrimSpace(token) == "" {
		return errors.New("missing Cloudflare Turnstile verification token")
	}

	form := url.Values{}
	form.Set("secret", cfg.SecretKey)
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
		return errors.New("turnstile verification failed")
	}
	return nil
}

func (s *Service) SignToken(claims SessionClaims) (string, error) {
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
	return &claims, nil
}

func (s *Service) BuildOAuthAuthorizeURL(state string) string {
	cfg := s.cfg.Get()
	callback := strings.TrimRight(cfg.IssuerURL, "/") + "/api/auth/oauth/callback"
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", cfg.OAuth.ClientID)
	q.Set("redirect_uri", callback)
	q.Set("scope", "openid profile email")
	q.Set("state", state)
	return strings.TrimRight(cfg.OAuth.IssuerURL, "/") + "/oauth/authorize?" + q.Encode()
}

func RandomToken(bytesLen int) string {
	b := make([]byte, bytesLen)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
