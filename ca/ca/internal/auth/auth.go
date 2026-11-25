package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/wimotek/ca/internal/cache"
	"github.com/wimotek/ca/internal/store"
)

const (
	powTTLSeconds   = 120
	sessionTTL      = 12 * time.Hour
	rateLimitMax    = 20
	rateLimitWindow = 60 * time.Second
)

// Config holds authentication security settings.
type Config struct {
	AdminUser     string
	EnvPassword   string // Optional env override; when empty, first-run wizard sets DB admin hash.
	HMACSecret    []byte
	PoWDifficulty int // Leading zero bits required (default 16)
}

// Challenge represents a stateless HMAC-signed SHA-256 offline PoW challenge.
type Challenge struct {
	Token      string `json:"challenge"`
	Difficulty int    `json:"difficulty"`
	ExpiresAt  int64  `json:"expires_at"`
}

// SessionInfo identifies the authenticated principal and role tier.
type SessionInfo struct {
	Username string `json:"username"`
	Role     string `json:"role"`
}

// SetupAdminInput holds initial administrator credentials and X.509 profile fields from the Setup Wizard.
type SetupAdminInput struct {
	Username     string
	Password     string
	FullName     string
	Email        string
	UPN          string
	Organization string
	Department   string
	Country      string
	Province     string
	Locality     string
}

// Service implements multi-user RBAC auth with stateless HMAC PoW (+ SetNX anti-replay),
// IP window rate limiting, DB-persisted 5-failure 15-minute lockout, and Bearer session tokens.
type Service struct {
	cfg   Config
	store *store.Store
	cache *cache.HybridCache
}

// NewService creates a new auth service.
func NewService(st *store.Store, hc *cache.HybridCache, cfg Config) *Service {
	if cfg.AdminUser == "" {
		cfg.AdminUser = "admin"
	}
	if cfg.PoWDifficulty < 8 || cfg.PoWDifficulty > 24 {
		cfg.PoWDifficulty = 16
	}
	if len(cfg.HMACSecret) == 0 {
		b := make([]byte, 32)
		_, _ = rand.Read(b)
		cfg.HMACSecret = b
	}
	return &Service{cfg: cfg, store: st, cache: hc}
}

// NeedsInitialSetup returns true when CA_ADMIN_PASSWORD is unset and no user/admin hash exists in DB.
func (s *Service) NeedsInitialSetup(ctx context.Context) (bool, error) {
	if strings.TrimSpace(s.cfg.EnvPassword) != "" {
		return false, nil
	}
	if cnt, err := s.store.CountUsers(ctx); err == nil && cnt > 0 {
		return false, nil
	}
	rec, err := s.store.GetAdminAuth(ctx, s.cfg.AdminUser)
	if err != nil {
		return false, err
	}
	return rec == nil || rec.PasswordHash == "", nil
}

// ClaimInitialAdmin atomically hashes and stores the initial admin password on first run.
func (s *Service) ClaimInitialAdmin(ctx context.Context, username, password, clientIP string) (string, error) {
	token, _, err := s.ClaimInitialAdminWithProfile(ctx, SetupAdminInput{
		Username: username,
		Password: password,
	}, clientIP)
	return token, err
}

// ClaimInitialAdminWithProfile creates the first administrator account with profile metadata from the Setup Wizard.
func (s *Service) ClaimInitialAdminWithProfile(ctx context.Context, in SetupAdminInput, clientIP string) (string, *store.UserRecord, error) {
	needs, err := s.NeedsInitialSetup(ctx)
	if err != nil {
		return "", nil, err
	}
	if !needs {
		return "", nil, errors.New("administrator access is already initialized")
	}
	if len(in.Password) < 8 {
		return "", nil, errors.New("password must be at least 8 characters")
	}
	user := strings.TrimSpace(in.Username)
	if user == "" {
		user = s.cfg.AdminUser
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	if err != nil {
		return "", nil, err
	}
	now := time.Now().Unix()

	if err := s.store.UpsertAdminAuth(ctx, store.AdminAuthRecord{
		Username:       user,
		PasswordHash:   string(hash),
		FailedAttempts: 0,
		LockedUntil:    0,
		UpdatedAt:      now,
	}); err != nil {
		return "", nil, err
	}

	fullName := strings.TrimSpace(in.FullName)
	if fullName == "" {
		fullName = "PKI Administrator"
	}
	userRec := store.UserRecord{
		Username:     user,
		PasswordHash: string(hash),
		Role:         store.RoleAdmin,
		CertQuota:    -1,
		FullName:     fullName,
		Email:        strings.TrimSpace(in.Email),
		UPN:          strings.TrimSpace(in.UPN),
		Organization: strings.TrimSpace(in.Organization),
		Department:   strings.TrimSpace(in.Department),
		Country:      strings.ToUpper(strings.TrimSpace(in.Country)),
		Province:     strings.TrimSpace(in.Province),
		Locality:     strings.TrimSpace(in.Locality),
		Enabled:      true,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := s.store.UpsertUser(ctx, userRec); err != nil {
		return "", nil, err
	}

	_ = s.store.SetSetting(ctx, "setup_completed", "1")
	_ = s.store.AppendAudit(ctx, store.AuditRecord{
		Actor:     user,
		Action:    "auth.setup_wizard_complete",
		ClientIP:  clientIP,
		CreatedAt: now,
	})
	return s.IssueSessionTokenWithRole(user, store.RoleAdmin), &userRec, nil
}

// CreateOrUpdateUser creates or updates a user with bcrypt password hashing and tier quota.
func (s *Service) CreateOrUpdateUser(ctx context.Context, rec store.UserRecord, rawPassword string) (*store.UserRecord, error) {
	rec.Username = strings.TrimSpace(rec.Username)
	if rec.Username == "" || len(rec.Username) > 64 {
		return nil, errors.New("valid username is required (1-64 chars)")
	}
	rec.Role = store.NormalizeRole(rec.Role)
	existing, _ := s.store.GetUser(ctx, rec.Username)

	if existing == nil && len(rawPassword) < 8 {
		return nil, errors.New("password must be at least 8 characters")
	}
	if rawPassword != "" {
		if len(rawPassword) < 8 {
			return nil, errors.New("password must be at least 8 characters")
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(rawPassword), bcrypt.DefaultCost)
		if err != nil {
			return nil, err
		}
		rec.PasswordHash = string(hash)
	}
	if rec.Role == store.RoleAdmin && rec.CertQuota == 0 {
		rec.CertQuota = -1
	} else if rec.Role != store.RoleAdmin && rec.CertQuota == 0 {
		rec.CertQuota = store.DefaultQuotaForRole(rec.Role)
	}
	if err := s.store.UpsertUser(ctx, rec); err != nil {
		return nil, err
	}
	return s.store.GetUser(ctx, rec.Username)
}

// GenerateChallenge creates a stateless HMAC-SHA256 signed PoW challenge token.
func (s *Service) GenerateChallenge() Challenge {
	nonce := store.GenerateRandomID(16)
	now := time.Now().Unix()
	payload := fmt.Sprintf("%s|%d|%d", nonce, now, s.cfg.PoWDifficulty)
	payloadB64 := base64.RawURLEncoding.EncodeToString([]byte(payload))
	sig := s.signHMAC(payloadB64)
	return Challenge{
		Token:      payloadB64 + "." + sig,
		Difficulty: s.cfg.PoWDifficulty,
		ExpiresAt:  now + powTTLSeconds,
	}
}

// VerifyPoW checks HMAC integrity, expiration, SHA-256 leading zero bits, and one-time SetNX replay guard.
func (s *Service) VerifyPoW(ctx context.Context, challengeToken, solution string) error {
	parts := strings.Split(challengeToken, ".")
	if len(parts) != 2 {
		return errors.New("malformed pow challenge")
	}
	payloadB64, sig := parts[0], parts[1]
	expectedSig := s.signHMAC(payloadB64)
	if subtle.ConstantTimeCompare([]byte(sig), []byte(expectedSig)) != 1 {
		return errors.New("invalid pow challenge signature")
	}

	rawPayload, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return errors.New("corrupt pow payload")
	}
	fields := strings.Split(string(rawPayload), "|")
	if len(fields) != 3 {
		return errors.New("invalid pow payload fields")
	}
	nonce := fields[0]
	issuedAt, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		return errors.New("invalid pow timestamp")
	}
	difficulty, err := strconv.Atoi(fields[2])
	if err != nil || difficulty < 8 {
		return errors.New("invalid pow difficulty")
	}
	now := time.Now().Unix()
	if now-issuedAt > powTTLSeconds || issuedAt > now+30 {
		return errors.New("pow challenge expired")
	}

	sum := sha256.Sum256([]byte(challengeToken + ":" + solution))
	if !HasLeadingZeroBits(sum[:], difficulty) {
		return errors.New("pow proof does not meet difficulty")
	}

	// One-time replay prevention via HybridCache.SetNX
	accepted, err := s.cache.SetNX(ctx, "pow:used:"+nonce, []byte("1"), (powTTLSeconds+30)*time.Second)
	if err != nil {
		return fmt.Errorf("pow replay check failed: %w", err)
	}
	if !accepted {
		return errors.New("pow challenge already redeemed")
	}
	return nil
}

// HasLeadingZeroBits verifies that hash starts with at least bits zero bits.
func HasLeadingZeroBits(hash []byte, bits int) bool {
	fullBytes := bits / 8
	remBits := bits % 8
	for i := 0; i < fullBytes; i++ {
		if hash[i] != 0 {
			return false
		}
	}
	if remBits > 0 {
		mask := byte(0xFF << (8 - remBits))
		if (hash[fullBytes] & mask) != 0 {
			return false
		}
	}
	return true
}

// Login authenticates any registered user or admin with IP rate limit, offline PoW, and 5-failure 15-min lockout.
func (s *Service) Login(ctx context.Context, username, password, challengeToken, solution, clientIP string) (string, error) {
	token, _, err := s.LoginWithUser(ctx, username, password, challengeToken, solution, clientIP)
	return token, err
}

// LoginWithUser authenticates a user and returns both the signed Bearer token and their UserRecord.
func (s *Service) LoginWithUser(ctx context.Context, username, password, challengeToken, solution, clientIP string) (string, *store.UserRecord, error) {
	// 1. Distributed window IP rate limiting
	count, err := s.cache.IncrWindow(ctx, "rl:login:"+clientIP, rateLimitWindow)
	if err == nil && count > rateLimitMax {
		return "", nil, errors.New("rate limit exceeded; wait 60 seconds")
	}

	// 2. Stateless HMAC SHA-256 PoW + SetNX anti-replay
	if err := s.VerifyPoW(ctx, challengeToken, solution); err != nil {
		return "", nil, err
	}

	user := strings.TrimSpace(username)
	if user == "" {
		user = s.cfg.AdminUser
	}

	now := time.Now().Unix()

	// Check multi-user table first, then legacy admin_auth fallback
	userRec, err := s.store.GetUser(ctx, user)
	if err != nil {
		return "", nil, err
	}
	adminRec, err := s.store.GetAdminAuth(ctx, user)
	if err != nil {
		return "", nil, err
	}

	if userRec != nil && !userRec.Enabled {
		return "", nil, errors.New("account is disabled by administrator")
	}
	if userRec != nil && userRec.LockedUntil > now {
		remaining := userRec.LockedUntil - now
		return "", nil, fmt.Errorf("account locked for %d more seconds after repeated failed attempts", remaining)
	}
	if adminRec != nil && adminRec.LockedUntil > now {
		remaining := adminRec.LockedUntil - now
		return "", nil, fmt.Errorf("account locked for %d more seconds after repeated failed attempts", remaining)
	}

	valid := false
	role := store.RoleStandard
	if strings.TrimSpace(s.cfg.EnvPassword) != "" && user == s.cfg.AdminUser {
		valid = subtle.ConstantTimeCompare([]byte(password), []byte(s.cfg.EnvPassword)) == 1
		role = store.RoleAdmin
	} else if userRec != nil && userRec.PasswordHash != "" {
		valid = bcrypt.CompareHashAndPassword([]byte(userRec.PasswordHash), []byte(password)) == nil
		role = userRec.Role
	} else if adminRec != nil && adminRec.PasswordHash != "" {
		valid = bcrypt.CompareHashAndPassword([]byte(adminRec.PasswordHash), []byte(password)) == nil
		role = store.RoleAdmin
	}

	if !valid {
		var attempts int
		var lockedUntil int64
		if userRec != nil {
			attempts, lockedUntil, _ = s.store.RecordUserAuthFailure(ctx, user, now)
		} else {
			attempts, lockedUntil, _ = s.store.RecordAuthFailure(ctx, user, now)
		}
		_ = s.store.AppendAudit(ctx, store.AuditRecord{
			Actor:      user,
			Action:     "auth.login_failed",
			ClientIP:   clientIP,
			DetailJSON: fmt.Sprintf(`{"attempts":%d,"locked_until":%d}`, attempts, lockedUntil),
			CreatedAt:  now,
		})
		if lockedUntil > now {
			return "", nil, errors.New("account locked for 15 minutes after 5 failed attempts")
		}
		return "", nil, errors.New("invalid username or password")
	}

	if userRec != nil {
		_ = s.store.ResetUserAuthFailures(ctx, user, now)
	}
	if adminRec != nil {
		_ = s.store.ResetAuthFailures(ctx, user, now)
	}
	if userRec == nil {
		userRec = &store.UserRecord{
			Username:  user,
			Role:      role,
			CertQuota: store.DefaultQuotaForRole(role),
			Enabled:   true,
		}
	}

	_ = s.store.AppendAudit(ctx, store.AuditRecord{
		Actor:      user,
		Action:     "auth.login_success",
		ClientIP:   clientIP,
		DetailJSON: fmt.Sprintf(`{"role":%q}`, role),
		CreatedAt:  now,
	})
	return s.IssueSessionTokenWithRole(user, role), userRec, nil
}

// IssueSessionToken creates a stateless HMAC-SHA256 signed Bearer token (defaults to admin role for compat).
func (s *Service) IssueSessionToken(username string) string {
	return s.IssueSessionTokenWithRole(username, store.RoleAdmin)
}

// IssueSessionTokenWithRole creates a stateless HMAC-SHA256 signed Bearer token carrying username and role.
func (s *Service) IssueSessionTokenWithRole(username, role string) string {
	exp := time.Now().Add(sessionTTL).Unix()
	nonce := store.GenerateRandomID(8)
	payload := fmt.Sprintf("%s|%s|%d|%s", username, store.NormalizeRole(role), exp, nonce)
	payloadB64 := base64.RawURLEncoding.EncodeToString([]byte(payload))
	return payloadB64 + "." + s.signHMAC("sess:"+payloadB64)
}

// VerifySessionToken validates a Bearer token and returns the authenticated username.
func (s *Service) VerifySessionToken(token string) (string, error) {
	info, err := s.VerifySession(token)
	if err != nil {
		return "", err
	}
	return info.Username, nil
}

// VerifySession validates a Bearer token and returns username + role.
func (s *Service) VerifySession(token string) (*SessionInfo, error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 2 {
		return nil, errors.New("invalid session token")
	}
	payloadB64, sig := parts[0], parts[1]
	expected := s.signHMAC("sess:" + payloadB64)
	if subtle.ConstantTimeCompare([]byte(sig), []byte(expected)) != 1 {
		return nil, errors.New("invalid session signature")
	}
	raw, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return nil, errors.New("corrupt session payload")
	}
	fields := strings.Split(string(raw), "|")
	switch len(fields) {
	case 3:
		exp, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil || time.Now().Unix() > exp {
			return nil, errors.New("session expired")
		}
		return &SessionInfo{Username: fields[0], Role: store.RoleAdmin}, nil
	case 4:
		exp, err := strconv.ParseInt(fields[2], 10, 64)
		if err != nil || time.Now().Unix() > exp {
			return nil, errors.New("session expired")
		}
		return &SessionInfo{Username: fields[0], Role: store.NormalizeRole(fields[1])}, nil
	default:
		return nil, errors.New("malformed session payload")
	}
}

// HashToken returns SHA-256 hex digest for provisioner API tokens.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *Service) signHMAC(msg string) string {
	mac := hmac.New(sha256.New, s.cfg.HMACSecret)
	mac.Write([]byte(msg))
	return hex.EncodeToString(mac.Sum(nil))
}
