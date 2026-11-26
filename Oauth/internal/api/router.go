package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
	"github.com/wimotek/oauth/internal/auth"
	"github.com/wimotek/oauth/internal/cache"
	"github.com/wimotek/oauth/internal/config"
	"github.com/wimotek/oauth/internal/crypto"
	"github.com/wimotek/oauth/internal/oidc"
	"github.com/wimotek/oauth/internal/risk"
	"github.com/wimotek/oauth/internal/store"
	"github.com/wimotek/oauth/web"
)

type apiConfigPayload struct {
	Initialized         bool   `json:"initialized"`
	DBDriver            string `json:"dbDriver"`
	DBDsn               string `json:"dbDsn"`
	SQLiteWalEnabled    bool   `json:"sqliteWalEnabled"`
	SQLiteBusyTimeoutMs int    `json:"sqliteBusyTimeoutMs"`
	SQLiteMaxWriteConns int    `json:"sqliteMaxWriteConns"`
	RedisEnabled        bool   `json:"redisEnabled"`
	RedisAddr           string `json:"redisAddr"`
	RedisSimulatedDown  bool   `json:"redisSimulatedDown"`
	ActiveCacheMode     string `json:"activeCacheMode"`
	IssuerURL           string `json:"issuerUrl"`
	AdminEmail          string `json:"adminEmail"`
	TLSSource           string `json:"tlsSource"`
}

type authUser struct {
	Sub      string `json:"sub"`
	Email    string `json:"email"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	Provider string `json:"provider"`
}

type authPolicyConfig struct {
	EnablePasswordArgon2id   bool   `json:"enablePasswordArgon2id"`
	EnableEmailOtpMagicLink  bool   `json:"enableEmailOtpMagicLink"`
	EnableTotp2fa            bool   `json:"enableTotp2fa"`
	EnablePasskeysWebAuthn   bool   `json:"enablePasskeysWebAuthn"`
	EnableDeviceFlowRfc8628  bool   `json:"enableDeviceFlowRfc8628"`
	JitVerifiedEmailAutoLink bool   `json:"jitVerifiedEmailAutoLink"`
	IpRateLimitPerMin        int    `json:"ipRateLimitPerMin"`
	LockoutThreshold         int    `json:"lockoutThreshold"`
	CaptchaProvider          string `json:"captchaProvider"`
	CaptchaSiteKey           string `json:"captchaSiteKey"`
}

type loginThemeConfig struct {
	Layout          string `json:"layout"`
	SurfaceMode     string `json:"surfaceMode"`
	BrandTitle      string `json:"brandTitle"`
	BrandSubtitle   string `json:"brandSubtitle"`
	HeroTitle       string `json:"heroTitle"`
	HeroSubtitle    string `json:"heroSubtitle"`
	LogoURL         string `json:"logoUrl"`
	PrimaryColor    string `json:"primaryColor"`
	BackgroundColor string `json:"backgroundColor"`
	CardColor       string `json:"cardColor"`
	TextColor       string `json:"textColor"`
	BorderRadius    string `json:"borderRadius"`
	FontFamily      string `json:"fontFamily"`
	SocialLayout    string `json:"socialLayout"`
	FooterText      string `json:"footerText"`
	CustomCSS       string `json:"customCss"`
}

type oauthApplication struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Description  string            `json:"description"`
	ClientID     string            `json:"clientId"`
	ClientSecret string            `json:"clientSecret"`
	RedirectUris []string          `json:"redirectUris"`
	Scopes       []string          `json:"scopes"`
	CreatedAt    string            `json:"createdAt"`
	LoginTheme   *loginThemeConfig `json:"loginTheme,omitempty"`
}

type storedConnector struct {
	ID              string
	Provider        string
	DisplayName     string
	Enabled         bool
	ClientID        string
	EncryptedSecret string
	SecretPreview   string
	Extra           map[string]string
	UpdatedAt       string
}

type connectorDTO struct {
	ID           string            `json:"id"`
	Provider     string            `json:"provider"`
	DisplayName  string            `json:"displayName"`
	Enabled      bool              `json:"enabled"`
	ClientID     string            `json:"clientId"`
	HasSecret    bool              `json:"hasSecret"`
	SecretMasked string            `json:"secretMasked"`
	Extra        map[string]string `json:"extra"`
	UpdatedAt    string            `json:"updatedAt"`
}

type userIdentityLink struct {
	ID            string `json:"id"`
	Provider      string `json:"provider"`
	ProviderLabel string `json:"providerLabel"`
	ProviderSub   string `json:"providerSub"`
	Email         string `json:"email"`
	LinkedAt      string `json:"linkedAt"`
}

type identityUser struct {
	ID            string             `json:"id"`
	Email         string             `json:"email"`
	EmailVerified bool               `json:"emailVerified"`
	DisplayName   string             `json:"displayName"`
	Status        string             `json:"status"`
	PasswordAlgo  string             `json:"passwordAlgo"`
	TotpEnabled   bool               `json:"totpEnabled"`
	PasskeyCount  int                `json:"passkeyCount"`
	Identities    []userIdentityLink `json:"identities"`
	CreatedAt     string             `json:"createdAt"`
	LastLoginAt   string             `json:"lastLoginAt"`
}

type storedWebhook struct {
	ID           string
	Name         string
	TargetURL    string
	Events       []string
	Enabled      bool
	SecretEnc    string
	SecretMasked string
	CreatedAt    string
}

type webhookDTO struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	TargetURL    string   `json:"targetUrl"`
	Events       []string `json:"events"`
	Enabled      bool     `json:"enabled"`
	SecretMasked string   `json:"secretMasked"`
	CreatedAt    string   `json:"createdAt"`
}

type webhookDeliveryLog struct {
	ID              string `json:"id"`
	WebhookID       string `json:"webhookId"`
	TargetURL       string `json:"targetUrl"`
	Event           string `json:"event"`
	UserEmail       string `json:"userEmail"`
	SignatureHeader string `json:"signatureHeader"`
	PayloadPreview  string `json:"payloadPreview"`
	Status          string `json:"status"`
	Timestamp       string `json:"timestamp"`
}

type memEntry struct {
	Value     string
	ExpiresAt time.Time
}

type authCodeRecord struct {
	ClientID      string
	RedirectURI   string
	CodeChallenge string
	Nonce         string
	Scope         string
	Sub           string
	Email         string
	Name          string
	Provider      string
}

type deviceSessionRecord struct {
	DeviceCode      string
	UserCode        string
	VerificationURI string
	ClientID        string
	Status          string
	ApprovedEmail   string
	ExpiresAt       time.Time
}

type totpRecord struct {
	SecretEnc     string
	RecoveryCodes []string
}

type appServer struct {
	mu           sync.RWMutex
	cfgMgr       *config.Manager
	keys         *crypto.KeyManager
	certSource   string
	repo         *store.SQLRepository
	resilient    *cache.ResilientCache
	oidcProvider *oidc.Provider

	policy       authPolicyConfig
	apps         []oauthApplication
	connectors   []storedConnector
	users        []identityUser
	webhooks     []storedWebhook
	webhookLogs  []webhookDeliveryLog
	sessions     map[string]authUser
	memCache     map[string]memEntry
	authCodes    map[string]authCodeRecord
	refreshToks  map[string]authCodeRecord
	deviceCodes  map[string]*deviceSessionRecord
	deviceByUser map[string]string
	totpPending  map[string]totpRecord
	totpEnrolled map[string]totpRecord
	loginFails   map[string]int
	lockUntil    map[string]time.Time
}

func NewRouter(cfgMgr *config.Manager, keys *crypto.KeyManager, certSources ...string) (http.Handler, func(), error) {
	certSource := "auto-generated self-signed (/data/certs/selfsigned.crt)"
	if len(certSources) > 0 && certSources[0] != "" {
		certSource = certSources[0]
	}
	nowISO := time.Now().UTC().Format(time.RFC3339)

	encMs, _ := keys.EncryptSecret("ms_demo_entra_secret")
	encApple, _ := keys.EncryptSecret("-----BEGIN PRIVATE KEY-----\nDEMO_APPLE_P8\n-----END PRIVATE KEY-----")
	encGoogle, _ := keys.EncryptSecret("GOCSPX-demo-google-secret")
	encWeChat, _ := keys.EncryptSecret("wx_demo_secret_890123")
	encGithub, _ := keys.EncryptSecret("ghs_demo_github_secret")
	encWh, _ := keys.EncryptSecret("whsec_demo_erp_revoker_2736")

	s := &appServer{
		cfgMgr:     cfgMgr,
		keys:       keys,
		certSource: certSource,
		policy: authPolicyConfig{
			EnablePasswordArgon2id:   true,
			EnableEmailOtpMagicLink:  true,
			EnableTotp2fa:            true,
			EnablePasskeysWebAuthn:   true,
			EnableDeviceFlowRfc8628:  true,
			JitVerifiedEmailAutoLink: true,
			IpRateLimitPerMin:        60,
			LockoutThreshold:         3,
			CaptchaProvider:          "turnstile",
			CaptchaSiteKey:           "0x4AAAAAA_demo_turnstile_slot",
		},
		apps: []oauthApplication{
			{
				ID:           "app_erp_01",
				Name:         "Enterprise ERP Portal",
				Description:  "Internal finance, HR & supply-chain OIDC client",
				ClientID:     "wimotek_erp_portal",
				ClientSecret: "wms_" + randomHex(12),
				RedirectUris: []string{"http://localhost:4000/callback", "https://erp.wimotek.dev/auth/callback"},
				Scopes:       []string{"openid", "profile", "email", "offline_access"},
				CreatedAt:    nowISO,
				LoginTheme: func() *loginThemeConfig {
					t := defaultLoginTheme("Enterprise ERP Portal")
					return &t
				}(),
			},
			{
				ID:           "app_wiki_02",
				Name:         "Engineering Docs & Wiki",
				Description:  "Knowledge base with PKCE S256 SSO",
				ClientID:     "wimotek_docs_wiki",
				ClientSecret: "wms_" + randomHex(12),
				RedirectUris: []string{"http://localhost:4100/oauth/callback"},
				Scopes:       []string{"openid", "profile", "email"},
				CreatedAt:    nowISO,
				LoginTheme: func() *loginThemeConfig {
					t := defaultLoginTheme("Engineering Docs & Wiki")
					t.SurfaceMode = "dark"
					t.PrimaryColor = "#6366F1"
					t.BackgroundColor = "#090D16"
					t.CardColor = "#111827"
					t.TextColor = "#F8FAFC"
					t.FontFamily = "mono"
					t.SocialLayout = "grid"
					return &t
				}(),
			},
		},
		connectors: []storedConnector{
			{
				ID:              "conn_microsoft",
				Provider:        "microsoft",
				DisplayName:     "Microsoft (Entra ID)",
				Enabled:         true,
				ClientID:        "ms-entra-tenant-app-id",
				EncryptedSecret: encMs,
				SecretPreview:   maskSecret("ms_demo_entra_secret"),
				Extra:           map[string]string{"tenant_id": "common"},
				UpdatedAt:       nowISO,
			},
			{
				ID:              "conn_apple",
				Provider:        "apple",
				DisplayName:     "Apple",
				Enabled:         true,
				ClientID:        "com.wimotek.oauth.service",
				EncryptedSecret: encApple,
				SecretPreview:   "-----BEG••••••••KEY-----",
				Extra:           map[string]string{"team_id": "A1B2C3D4E5", "key_id": "K9X8Y7Z6W5"},
				UpdatedAt:       nowISO,
			},
			{
				ID:              "conn_google",
				Provider:        "google",
				DisplayName:     "Google",
				Enabled:         true,
				ClientID:        "492018472910-demo.apps.googleusercontent.com",
				EncryptedSecret: encGoogle,
				SecretPreview:   maskSecret("GOCSPX-demo-google-secret"),
				Extra:           map[string]string{},
				UpdatedAt:       nowISO,
			},
			{
				ID:              "conn_wechat",
				Provider:        "wechat",
				DisplayName:     "微信 WeChat",
				Enabled:         true,
				ClientID:        "wx9f8e7d6c5b4a3210",
				EncryptedSecret: encWeChat,
				SecretPreview:   maskSecret("wx_demo_secret_890123"),
				Extra:           map[string]string{"wechat_mode": "qr"},
				UpdatedAt:       nowISO,
			},
			{
				ID:              "conn_github",
				Provider:        "github",
				DisplayName:     "GitHub",
				Enabled:         true,
				ClientID:        "Ov23liDemoGitHubClient",
				EncryptedSecret: encGithub,
				SecretPreview:   maskSecret("ghs_demo_github_secret"),
				Extra:           map[string]string{},
				UpdatedAt:       nowISO,
			},
		},
		users: []identityUser{
			{
				ID:            "usr_super_admin",
				Email:         cfgMgr.Get().AdminEmail,
				EmailVerified: true,
				DisplayName:   "Wimotek Admin",
				Status:        "active",
				PasswordAlgo:  "argon2id",
				TotpEnabled:   false,
				PasskeyCount:  1,
				Identities: []userIdentityLink{
					{ID: "ident_ms_1", Provider: "microsoft", ProviderLabel: "Microsoft (Entra ID)", ProviderSub: "ms_oid_8821a", Email: cfgMgr.Get().AdminEmail, LinkedAt: nowISO},
					{ID: "ident_pk_1", Provider: "passkey", ProviderLabel: "Passkey (TouchID / FIDO2)", ProviderSub: "cred_fido2_a91f", Email: cfgMgr.Get().AdminEmail, LinkedAt: nowISO},
				},
				CreatedAt:   nowISO,
				LastLoginAt: nowISO,
			},
			{
				ID:            "usr_alice_ops",
				Email:         "alice.chen@acme-corp.com",
				EmailVerified: true,
				DisplayName:   "Alice Chen",
				Status:        "active",
				PasswordAlgo:  "argon2id",
				TotpEnabled:   false,
				PasskeyCount:  0,
				Identities: []userIdentityLink{
					{ID: "ident_wx_2", Provider: "wechat", ProviderLabel: "微信 WeChat", ProviderSub: "wx_union_9042c", Email: "alice.chen@acme-corp.com", LinkedAt: nowISO},
					{ID: "ident_gh_2", Provider: "github", ProviderLabel: "GitHub", ProviderSub: "gh_448192", Email: "alice.chen@acme-corp.com", LinkedAt: nowISO},
				},
				CreatedAt:   nowISO,
				LastLoginAt: nowISO,
			},
		},
		webhooks: []storedWebhook{
			{
				ID:           "wh_erp_01",
				Name:         "ERP Portal Session Revoker",
				TargetURL:    "https://erp.wimotek.dev/api/webhooks/oauth-events",
				Events:       []string{"user.banned", "session.revoked"},
				Enabled:      true,
				SecretEnc:    encWh,
				SecretMasked: maskSecret("whsec_demo_erp_revoker_2736"),
				CreatedAt:    nowISO,
			},
		},
		webhookLogs:  []webhookDeliveryLog{},
		sessions:     make(map[string]authUser),
		memCache:     make(map[string]memEntry),
		authCodes:    make(map[string]authCodeRecord),
		refreshToks:  make(map[string]authCodeRecord),
		deviceCodes:  make(map[string]*deviceSessionRecord),
		deviceByUser: make(map[string]string),
		totpPending:  make(map[string]totpRecord),
		totpEnrolled: make(map[string]totpRecord),
		loginFails:   make(map[string]int),
		lockUntil:    make(map[string]time.Time),
	}

	// Open SQLite/MySQL & ResilientCache if already initialized
	cfg := cfgMgr.Get()
	if cfg.Initialized {
		if repo, err := store.Open(cfg.Database.Driver, cfg.Database.DSN); err == nil {
			_ = repo.Migrate(context.Background())
			s.repo = repo
			var rdb *redis.Client
			if cfg.Redis.Enabled && cfg.Redis.Addr != "" && !cfg.Redis.SimulatedDown {
				rdb = redis.NewClient(&redis.Options{
					Addr:     cfg.Redis.Addr,
					Password: cfg.Redis.Password,
					DB:       cfg.Redis.DB,
				})
			}
			s.resilient = cache.NewResilientCache(rdb, repo.DB(), repo.Driver())
		}
	}
	s.oidcProvider = oidc.NewProvider(cfg.IssuerURL, keys, s.resilient)

	cleanup := func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.resilient != nil {
			_ = s.resilient.Close()
		}
		if s.repo != nil {
			_ = s.repo.Close()
		}
	}

	mux := http.NewServeMux()

	// Health & OIDC Protocol Endpoints
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /.well-known/openid-configuration", s.handleDiscovery)
	mux.HandleFunc("GET /.well-known/jwks.json", s.oidcProvider.JWKSHandler)
	mux.HandleFunc("GET /oauth/authorize", s.handleAuthorize)
	mux.HandleFunc("POST /oauth/token", s.handleToken)
	mux.HandleFunc("POST /oauth/device_authorization", s.handleDeviceAuth)
	mux.HandleFunc("GET /oauth/userinfo", s.handleUserInfo)
	mux.HandleFunc("GET /oauth/logout", s.handleLogout)

	// Device Flow Sandbox Helpers
	mux.HandleFunc("POST /api/oauth/device/approve", s.handleDeviceApprove)
	mux.HandleFunc("POST /api/oauth/device/poll", s.handleDevicePoll)

	// Setup Wizard
	mux.HandleFunc("GET /api/setup/status", s.handleSetupStatus)
	mux.HandleFunc("POST /api/setup/test-db", s.handleTestDB)
	mux.HandleFunc("POST /api/setup/test-redis", s.handleTestRedis)
	mux.HandleFunc("POST /api/setup/complete", s.handleSetupComplete)
	mux.HandleFunc("POST /api/setup/reset", s.requireAdmin(s.handleSetupReset))

	// Authentication Flows
	mux.HandleFunc("POST /api/auth/login", s.handlePasswordLogin)
	mux.HandleFunc("POST /api/auth/email-otp/send", s.handleSendEmailOTP)
	mux.HandleFunc("POST /api/auth/email-otp/verify", s.handleVerifyEmailOTP)
	mux.HandleFunc("POST /api/auth/passkey/challenge", s.handlePasskeyChallenge)
	mux.HandleFunc("POST /api/auth/passkey/authenticate", s.handlePasskeyAuth)
	mux.HandleFunc("POST /api/auth/totp/enroll", s.requireAdmin(s.handleTotpEnroll))
	mux.HandleFunc("POST /api/auth/totp/verify", s.requireAdmin(s.handleTotpVerify))
	mux.HandleFunc("GET /api/auth/me", s.requireAdmin(s.handleAuthMe))

	// Overview & Cache Failover
	mux.HandleFunc("GET /api/system/overview", s.requireAdmin(s.handleOverview))
	mux.HandleFunc("POST /api/system/cache-sim", s.requireAdmin(s.handleCacheSim))

	// Applications CRUD & Per-Client Hosted Login Theme APIs
	mux.HandleFunc("GET /api/public/theme", s.handlePublicTheme)
	mux.HandleFunc("GET /api/applications", s.requireAdmin(s.handleListApps))
	mux.HandleFunc("POST /api/applications", s.requireAdmin(s.handleCreateApp))
	mux.HandleFunc("DELETE /api/applications/{id}", s.requireAdmin(s.handleDeleteApp))
	mux.HandleFunc("GET /api/applications/{clientId}/theme", s.requireAdmin(s.handleGetAppTheme))
	mux.HandleFunc("PUT /api/applications/{clientId}/theme", s.requireAdmin(s.handleUpdateAppTheme))

	// Social Connectors CRUD + Reorder
	mux.HandleFunc("GET /api/connectors/public", s.handlePublicConnectors)
	mux.HandleFunc("GET /api/connectors", s.requireAdmin(s.handleListConnectors))
	mux.HandleFunc("PUT /api/connectors/reorder", s.requireAdmin(s.handleReorderConnectors))
	mux.HandleFunc("PUT /api/connectors/{id}", s.requireAdmin(s.handleUpdateConnector))
	mux.HandleFunc("POST /api/connectors", s.requireAdmin(s.handleCreateConnector))

	// Identity Directory, JIT Linking & Account Ban Webhooks
	mux.HandleFunc("GET /api/users", s.requireAdmin(s.handleListUsers))
	mux.HandleFunc("POST /api/users/jit-simulate", s.requireAdmin(s.handleSimulateJit))
	mux.HandleFunc("POST /api/users/{id}/status", s.requireAdmin(s.handleUserStatus))
	mux.HandleFunc("POST /api/webhooks", s.requireAdmin(s.handleCreateWebhook))
	mux.HandleFunc("DELETE /api/webhooks/{id}", s.requireAdmin(s.handleDeleteWebhook))

	// Security & Risk Policy
	mux.HandleFunc("GET /api/security/policy/public", s.handleGetPolicy)
	mux.HandleFunc("GET /api/security/policy", s.requireAdmin(s.handleGetPolicy))
	mux.HandleFunc("PUT /api/security/policy", s.requireAdmin(s.handleUpdatePolicy))
	mux.HandleFunc("POST /api/security/risk/test-bruteforce", s.requireAdmin(s.handleTestBruteForce))
	mux.HandleFunc("POST /api/security/signing-key/rotate", s.requireAdmin(s.handleRotateSigningKey))
	mux.HandleFunc("POST /api/security/signing-key/purge-retiring", s.requireAdmin(s.handlePurgeRetiringKeys))

	// Embedded React SPA with clean index.html fallback
	subFS, err := fs.Sub(web.DistFS, "dist")
	if err == nil {
		fileServer := http.FileServer(http.FS(subFS))
		indexBytes, _ := fs.ReadFile(subFS, "index.html")
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			clean := strings.TrimPrefix(r.URL.Path, "/")
			if clean == "" {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				_, _ = w.Write(indexBytes)
				return
			}
			if _, statErr := fs.Stat(subFS, clean); statErr == nil {
				fileServer.ServeHTTP(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(indexBytes)
		})
	}

	return mux, cleanup, nil
}

// ============================================================================
// Helpers
// ============================================================================

func (s *appServer) getIssuer(r *http.Request) string {
	cfg := s.cfgMgr.Get()
	if cfg.IssuerURL != "" && !strings.HasPrefix(cfg.IssuerURL, "http://localhost") {
		return strings.TrimRight(cfg.IssuerURL, "/")
	}
	proto := r.Header.Get("X-Forwarded-Proto")
	if proto == "" {
		if r.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	if host == "" {
		return "http://localhost:8080"
	}
	return fmt.Sprintf("%s://%s", proto, host)
}

func (s *appServer) activeCacheModeLocked() string {
	cfg := s.cfgMgr.Get()
	if cfg.Redis.Enabled && !cfg.Redis.SimulatedDown {
		if s.resilient != nil {
			return s.resilient.Mode()
		}
		return "redis"
	}
	return "sql_fallback"
}

func (s *appServer) buildConfigPayloadLocked(r *http.Request) apiConfigPayload {
	cfg := s.cfgMgr.Get()
	return apiConfigPayload{
		Initialized:         cfg.Initialized,
		DBDriver:            cfg.Database.Driver,
		DBDsn:               cfg.Database.DSN,
		SQLiteWalEnabled:    true,
		SQLiteBusyTimeoutMs: 5000,
		SQLiteMaxWriteConns: 1,
		RedisEnabled:        cfg.Redis.Enabled,
		RedisAddr:           cfg.Redis.Addr,
		RedisSimulatedDown:  cfg.Redis.SimulatedDown,
		ActiveCacheMode:     s.activeCacheModeLocked(),
		IssuerURL:           s.getIssuer(r),
		AdminEmail:          cfg.AdminEmail,
		TLSSource:           s.certSource,
	}
}

func (s *appServer) cacheStatsLocked() map[string]any {
	mode := s.activeCacheModeLocked()
	count := len(s.memCache)
	if mode == "redis" {
		return map[string]any{"mode": mode, "redisKeys": count, "sqlFallbackKeys": 0}
	}
	return map[string]any{"mode": mode, "redisKeys": 0, "sqlFallbackKeys": count}
}

func (s *appServer) cacheSetLocked(key, val string, ttl time.Duration) {
	s.memCache[key] = memEntry{Value: val, ExpiresAt: time.Now().Add(ttl)}
	if s.resilient != nil {
		_ = s.resilient.Set(context.Background(), key, val, ttl)
	}
}

func (s *appServer) cacheGetLocked(key string) (string, bool) {
	if e, ok := s.memCache[key]; ok {
		if time.Now().Before(e.ExpiresAt) {
			return e.Value, true
		}
		delete(s.memCache, key)
	}
	if s.resilient != nil {
		if val, err := s.resilient.Get(context.Background(), key); err == nil {
			return val, true
		}
	}
	return "", false
}

func (s *appServer) cacheDeleteLocked(key string) {
	delete(s.memCache, key)
	if s.resilient != nil {
		_ = s.resilient.Delete(context.Background(), key)
	}
}

func (s *appServer) serializeConnectorsLocked() []connectorDTO {
	out := make([]connectorDTO, 0, len(s.connectors))
	for _, c := range s.connectors {
		out = append(out, connectorDTO{
			ID:           c.ID,
			Provider:     c.Provider,
			DisplayName:  c.DisplayName,
			Enabled:      c.Enabled,
			ClientID:     c.ClientID,
			HasSecret:    c.EncryptedSecret != "",
			SecretMasked: c.SecretPreview,
			Extra:        c.Extra,
			UpdatedAt:    c.UpdatedAt,
		})
	}
	return out
}

func (s *appServer) serializeWebhooksLocked() []webhookDTO {
	out := make([]webhookDTO, 0, len(s.webhooks))
	for _, wh := range s.webhooks {
		out = append(out, webhookDTO{
			ID:           wh.ID,
			Name:         wh.Name,
			TargetURL:    wh.TargetURL,
			Events:       wh.Events,
			Enabled:      wh.Enabled,
			SecretMasked: wh.SecretMasked,
			CreatedAt:    wh.CreatedAt,
		})
	}
	return out
}

func (s *appServer) signJWT(claims jwt.MapClaims) (string, error) {
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = s.keys.KeyID()
	return tok.SignedString(s.keys.PrivateKey())
}

func (s *appServer) verifyJWT(tokenStr string) (jwt.MapClaims, bool) {
	parsed, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		kid, _ := t.Header["kid"].(string)
		pub := s.keys.PublicKeyByID(kid)
		if pub == nil {
			return nil, fmt.Errorf("unknown or revoked signing key")
		}
		return pub, nil
	})
	if err != nil || !parsed.Valid {
		return nil, false
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	return claims, ok
}

func (s *appServer) resolveOrLinkIdentityLocked(provider, providerLabel, providerSub, email, displayName string, emailVerified bool) (string, identityUser) {
	normEmail := strings.ToLower(strings.TrimSpace(email))
	nowISO := time.Now().UTC().Format(time.RFC3339)

	// 1. Exact provider + sub match
	for i := range s.users {
		for _, ident := range s.users[i].Identities {
			if ident.Provider == provider && ident.ProviderSub == providerSub {
				s.users[i].LastLoginAt = nowISO
				return "matched_existing_identity", s.users[i]
			}
		}
	}

	// 2. Smooth linking by verified email onto existing legacy account
	if s.policy.JitVerifiedEmailAutoLink && emailVerified && normEmail != "" {
		for i := range s.users {
			if strings.ToLower(s.users[i].Email) == normEmail && s.users[i].EmailVerified {
				s.users[i].Identities = append(s.users[i].Identities, userIdentityLink{
					ID:            "ident_" + randomHex(4),
					Provider:      provider,
					ProviderLabel: providerLabel,
					ProviderSub:   providerSub,
					Email:         normEmail,
					LinkedAt:      nowISO,
				})
				if provider == "passkey" {
					s.users[i].PasskeyCount++
				}
				s.users[i].LastLoginAt = nowISO
				return "linked_existing_verified_email", s.users[i]
			}
		}
	}

	// 3. JIT provision new lightweight identity
	if displayName == "" {
		displayName = strings.Split(normEmail, "@")[0]
	}
	newUser := identityUser{
		ID:            "usr_" + randomHex(4),
		Email:         normEmail,
		EmailVerified: emailVerified,
		DisplayName:   displayName,
		Status:        "active",
		PasswordAlgo:  "none",
		TotpEnabled:   false,
		PasskeyCount:  0,
		Identities: []userIdentityLink{
			{
				ID:            "ident_" + randomHex(4),
				Provider:      provider,
				ProviderLabel: providerLabel,
				ProviderSub:   providerSub,
				Email:         normEmail,
				LinkedAt:      nowISO,
			},
		},
		CreatedAt:   nowISO,
		LastLoginAt: nowISO,
	}
	if provider == "passkey" {
		newUser.PasskeyCount = 1
	}
	s.users = append([]identityUser{newUser}, s.users...)
	return "provisioned_new_user", newUser
}

func (s *appServer) issueLiveTraceLocked(r *http.Request, clientID, email, name, providerKey, providerLabel, authMethod string) map[string]any {
	started := time.Now()
	issuer := s.getIssuer(r)
	if clientID == "" && len(s.apps) > 0 {
		clientID = s.apps[0].ClientID
	}
	jitAction, matched := s.resolveOrLinkIdentityLocked(providerKey, providerLabel, providerKey+"_"+randomHex(4), email, name, true)

	verifier := randomHex(24)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	code := "wm_code_" + randomHex(10)
	nonce := randomHex(8)
	now := time.Now()

	idClaims := jwt.MapClaims{
		"iss":            issuer,
		"sub":            matched.ID,
		"aud":            clientID,
		"nonce":          nonce,
		"email":          matched.Email,
		"email_verified": true,
		"name":           matched.DisplayName,
		"provider":       providerLabel,
		"amr":            []string{authMethod},
		"iat":            now.Unix(),
		"exp":            now.Add(1 * time.Hour).Unix(),
	}
	idToken, _ := s.signJWT(idClaims)
	accessToken, _ := s.signJWT(jwt.MapClaims{
		"iss":      issuer,
		"sub":      matched.ID,
		"aud":      clientID,
		"scope":    "openid profile email",
		"email":    matched.Email,
		"name":     matched.DisplayName,
		"provider": providerLabel,
		"iat":      now.Unix(),
		"exp":      now.Add(1 * time.Hour).Unix(),
	})

	u := authUser{
		Sub:      matched.ID,
		Email:    matched.Email,
		Name:     matched.DisplayName,
		Role:     "super_admin",
		Provider: providerLabel,
	}
	sessionTok := "wm_sess_" + randomHex(18)
	s.sessions[sessionTok] = u

	elapsed := time.Since(started).Milliseconds()
	if elapsed < 1 {
		elapsed = 1
	}

	return map[string]any{
		"user":         u,
		"sessionToken": sessionTok,
		"config":       s.buildConfigPayloadLocked(r),
		"trace": map[string]any{
			"clientId":          clientID,
			"provider":          providerLabel,
			"authMethod":        authMethod,
			"jitAction":         jitAction,
			"codeChallenge":     challenge,
			"authorizationCode": code,
			"cacheBackendUsed":  s.activeCacheModeLocked(),
			"idToken":           idToken,
			"accessToken":       accessToken,
			"decodedIdToken": map[string]any{
				"header":            map[string]any{"alg": "RS256", "typ": "JWT", "kid": s.keys.KeyID()},
				"payload":           idClaims,
				"signatureVerified": true,
			},
			"userInfo": map[string]any{
				"sub":            matched.ID,
				"email":          matched.Email,
				"email_verified": true,
				"name":           matched.DisplayName,
				"provider":       providerLabel,
			},
			"elapsedMs": elapsed,
		},
	}
}

func (s *appServer) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hdr := r.Header.Get("Authorization")
		if !strings.HasPrefix(hdr, "Bearer ") {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized", "message": "Missing bearer token"})
			return
		}
		tok := strings.TrimSpace(strings.TrimPrefix(hdr, "Bearer "))
		s.mu.RLock()
		_, ok := s.sessions[tok]
		s.mu.RUnlock()
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized", "message": "Session expired"})
			return
		}
		next(w, r)
	}
}

// ============================================================================
// Standard OIDC / OAuth 2.0 Handlers
// ============================================================================

func (s *appServer) handleDiscovery(w http.ResponseWriter, r *http.Request) {
	issuer := s.getIssuer(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                issuer,
		"authorization_endpoint":                issuer + "/oauth/authorize",
		"token_endpoint":                        issuer + "/oauth/token",
		"device_authorization_endpoint":         issuer + "/oauth/device_authorization",
		"userinfo_endpoint":                     issuer + "/oauth/userinfo",
		"end_session_endpoint":                  issuer + "/oauth/logout",
		"jwks_uri":                              issuer + "/.well-known/jwks.json",
		"response_types_supported":              []string{"code"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"code_challenge_methods_supported":      []string{"S256"},
		"scopes_supported":                      []string{"openid", "profile", "email", "offline_access"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"},
	})
}

func (s *appServer) handleAuthorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	clientID := q.Get("client_id")
	redirectURI := q.Get("redirect_uri")
	state := q.Get("state")
	challenge := q.Get("code_challenge")
	method := q.Get("code_challenge_method")
	nonce := q.Get("nonce")

	s.mu.Lock()
	defer s.mu.Unlock()

	var matchedApp *oauthApplication
	for i := range s.apps {
		if s.apps[i].ClientID == clientID {
			matchedApp = &s.apps[i]
			break
		}
	}
	if matchedApp == nil || !isAllowedRedirect(redirectURI, matchedApp.RedirectUris) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "error_description": "Invalid client_id or redirect_uri"})
		return
	}
	if method != "S256" || challenge == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request", "error_description": "PKCE S256 code_challenge is required"})
		return
	}

	code := "wm_code_" + randomHex(12)
	cfg := s.cfgMgr.Get()
	s.authCodes[code] = authCodeRecord{
		ClientID:      clientID,
		RedirectURI:   redirectURI,
		CodeChallenge: challenge,
		Nonce:         nonce,
		Scope:         defaultStr(q.Get("scope"), "openid profile email"),
		Sub:           "usr_super_admin",
		Email:         defaultStr(cfg.AdminEmail, "admin@wimotek.dev"),
		Name:          "Wimotek Admin",
		Provider:      "oidc_direct",
	}

	target, _ := url.Parse(redirectURI)
	params := target.Query()
	params.Set("code", code)
	if state != "" {
		params.Set("state", state)
	}
	target.RawQuery = params.Encode()
	http.Redirect(w, r, target.String(), http.StatusFound)
}

func (s *appServer) handleToken(w http.ResponseWriter, r *http.Request) {
	var body struct {
		GrantType    string `json:"grant_type"`
		Code         string `json:"code"`
		RedirectURI  string `json:"redirect_uri"`
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
		CodeVerifier string `json:"code_verifier"`
		RefreshToken string `json:"refresh_token"`
		DeviceCode   string `json:"device_code"`
	}
	if strings.Contains(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded") {
		_ = r.ParseForm()
		body.GrantType = r.FormValue("grant_type")
		body.Code = r.FormValue("code")
		body.RedirectURI = r.FormValue("redirect_uri")
		body.ClientID = r.FormValue("client_id")
		body.ClientSecret = r.FormValue("client_secret")
		body.CodeVerifier = r.FormValue("code_verifier")
		body.RefreshToken = r.FormValue("refresh_token")
		body.DeviceCode = r.FormValue("device_code")
	} else {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}

	issuer := s.getIssuer(r)
	now := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()

	if body.GrantType == "refresh_token" {
		rec, ok := s.refreshToks[body.RefreshToken]
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_grant"})
			return
		}
		delete(s.refreshToks, body.RefreshToken)
		nextRT := "wm_rt_" + randomHex(14)
		s.refreshToks[nextRT] = rec
		at, _ := s.signJWT(jwt.MapClaims{"iss": issuer, "sub": rec.Sub, "aud": rec.ClientID, "scope": rec.Scope, "email": rec.Email, "name": rec.Name, "provider": rec.Provider, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()})
		idt, _ := s.signJWT(jwt.MapClaims{"iss": issuer, "sub": rec.Sub, "aud": rec.ClientID, "email": rec.Email, "email_verified": true, "name": rec.Name, "provider": rec.Provider, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()})
		writeJSON(w, http.StatusOK, map[string]any{"token_type": "Bearer", "expires_in": 3600, "access_token": at, "refresh_token": nextRT, "id_token": idt, "scope": rec.Scope})
		return
	}

	if body.GrantType == "urn:ietf:params:oauth:grant-type:device_code" {
		sess, ok := s.deviceCodes[body.DeviceCode]
		if !ok || time.Now().After(sess.ExpiresAt) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "expired_token"})
			return
		}
		if sess.Status != "approved" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "authorization_pending"})
			return
		}
		at, _ := s.signJWT(jwt.MapClaims{"iss": issuer, "sub": "usr_super_admin", "aud": sess.ClientID, "scope": "openid profile email", "email": sess.ApprovedEmail, "name": "Wimotek Admin", "provider": "Device Flow (RFC 8628)", "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()})
		idt, _ := s.signJWT(jwt.MapClaims{"iss": issuer, "sub": "usr_super_admin", "aud": sess.ClientID, "email": sess.ApprovedEmail, "email_verified": true, "name": "Wimotek Admin", "provider": "Device Flow (RFC 8628)", "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()})
		writeJSON(w, http.StatusOK, map[string]any{"token_type": "Bearer", "expires_in": 3600, "access_token": at, "id_token": idt, "scope": "openid profile email"})
		return
	}

	if body.GrantType != "authorization_code" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unsupported_grant_type"})
		return
	}

	rec, ok := s.authCodes[body.Code]
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_grant"})
		return
	}
	delete(s.authCodes, body.Code)

	if rec.ClientID != body.ClientID || rec.RedirectURI != body.RedirectURI || !oidc.VerifyPKCES256(body.CodeVerifier, rec.CodeChallenge) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_grant", "error_description": "PKCE S256 or client verification failed"})
		return
	}

	at, _ := s.signJWT(jwt.MapClaims{"iss": issuer, "sub": rec.Sub, "aud": rec.ClientID, "scope": rec.Scope, "email": rec.Email, "name": rec.Name, "provider": rec.Provider, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()})
	idClaims := jwt.MapClaims{"iss": issuer, "sub": rec.Sub, "aud": rec.ClientID, "email": rec.Email, "email_verified": true, "name": rec.Name, "provider": rec.Provider, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()}
	if rec.Nonce != "" {
		idClaims["nonce"] = rec.Nonce
	}
	idt, _ := s.signJWT(idClaims)
	rt := "wm_rt_" + randomHex(14)
	s.refreshToks[rt] = rec

	writeJSON(w, http.StatusOK, map[string]any{
		"token_type":    "Bearer",
		"expires_in":    3600,
		"access_token":  at,
		"refresh_token": rt,
		"id_token":      idt,
		"scope":         rec.Scope,
	})
}

func (s *appServer) handleDeviceAuth(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClientID string `json:"client_id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	s.mu.Lock()
	defer s.mu.Unlock()
	if body.ClientID == "" && len(s.apps) > 0 {
		body.ClientID = s.apps[0].ClientID
	}
	devCode := "wm_dev_" + randomHex(12)
	userCode := generateUserCode()
	verifyURI := s.getIssuer(r) + "/device"
	sess := &deviceSessionRecord{
		DeviceCode:      devCode,
		UserCode:        userCode,
		VerificationURI: verifyURI,
		ClientID:        body.ClientID,
		Status:          "pending",
		ExpiresAt:       time.Now().Add(10 * time.Minute),
	}
	s.deviceCodes[devCode] = sess
	s.deviceByUser[userCode] = devCode

	writeJSON(w, http.StatusOK, map[string]any{
		"device_code":               devCode,
		"user_code":                 userCode,
		"verification_uri":          verifyURI,
		"verification_uri_complete": verifyURI + "?user_code=" + userCode,
		"expires_in":                600,
		"interval":                  5,
	})
}

func (s *appServer) handleDeviceApprove(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserCode string `json:"user_code"`
		Email    string `json:"email"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	s.mu.Lock()
	defer s.mu.Unlock()
	devCode, ok := s.deviceByUser[strings.ToUpper(strings.TrimSpace(body.UserCode))]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "invalid_user_code", "message": "Device code not found or expired"})
		return
	}
	sess := s.deviceCodes[devCode]
	sess.Status = "approved"
	sess.ApprovedEmail = defaultStr(body.Email, s.cfgMgr.Get().AdminEmail)
	writeJSON(w, http.StatusOK, map[string]any{"approved": true, "user_code": sess.UserCode})
}

func (s *appServer) handleDevicePoll(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DeviceCode string `json:"device_code"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.deviceCodes[body.DeviceCode]
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "expired_token"})
		return
	}
	if sess.Status != "approved" {
		writeJSON(w, http.StatusAccepted, map[string]any{"status": "authorization_pending"})
		return
	}
	issued := s.issueLiveTraceLocked(r, sess.ClientID, defaultStr(sess.ApprovedEmail, "admin@wimotek.dev"), "Wimotek Admin", "microsoft", "Device Flow (RFC 8628)", "device_code_qr")
	writeJSON(w, http.StatusOK, issued)
}

func (s *appServer) handleUserInfo(w http.ResponseWriter, r *http.Request) {
	hdr := r.Header.Get("Authorization")
	if !strings.HasPrefix(hdr, "Bearer ") {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_token"})
		return
	}
	claims, ok := s.verifyJWT(strings.TrimSpace(strings.TrimPrefix(hdr, "Bearer ")))
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_token"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sub":            claims["sub"],
		"email":          claims["email"],
		"email_verified": true,
		"name":           claims["name"],
		"provider":       claims["provider"],
	})
}

func (s *appServer) handleLogout(w http.ResponseWriter, r *http.Request) {
	postLogout := r.URL.Query().Get("post_logout_redirect_uri")
	if postLogout != "" {
		if u, err := url.Parse(postLogout); err == nil && (u.Scheme == "http" || u.Scheme == "https") {
			http.Redirect(w, r, postLogout, http.StatusFound)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "logged_out"})
}

// ============================================================================
// Setup Wizard Handlers
// ============================================================================

func (s *appServer) handleSetupStatus(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"config":     s.buildConfigPayloadLocked(r),
		"connectors": s.serializeConnectorsLocked(),
		"authPolicy": s.policy,
		"cacheStats": s.cacheStatsLocked(),
	})
}

func (s *appServer) handleTestDB(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DBDriver string `json:"dbDriver"`
		DBDsn    string `json:"dbDsn"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.DBDriver != "sqlite3" && body.DBDriver != "mysql" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "Driver must be sqlite3 or mysql"})
		return
	}
	if strings.TrimSpace(body.DBDsn) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "Database path or DSN is required"})
		return
	}
	start := time.Now()
	repo, err := store.Open(body.DBDriver, body.DBDsn)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": err.Error()})
		return
	}
	defer repo.Close()
	if err := repo.Ping(r.Context()); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": err.Error()})
		return
	}
	details := "SQLite3 verified · PRAGMA journal_mode=WAL · busy_timeout=5000ms · MaxOpenConns(1)"
	if body.DBDriver == "mysql" {
		details = "MySQL 8 connection pool verified · utf8mb4 · MaxOpenConns(25)"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"latencyMs": time.Since(start).Milliseconds(),
		"details":   details,
	})
}

func (s *appServer) handleTestRedis(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RedisAddr string `json:"redisAddr"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if !strings.Contains(body.RedisAddr, ":") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "Provide host:port (e.g. 127.0.0.1:6379)"})
		return
	}
	start := time.Now()
	rdb := redis.NewClient(&redis.Options{Addr: strings.TrimSpace(body.RedisAddr)})
	defer rdb.Close()
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "Redis unreachable: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"latencyMs": time.Since(start).Milliseconds(),
		"details":   "Redis PONG from " + body.RedisAddr,
	})
}

func (s *appServer) handleSetupComplete(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DBDriver      string `json:"dbDriver"`
		DBDsn         string `json:"dbDsn"`
		RedisEnabled  bool   `json:"redisEnabled"`
		RedisAddr     string `json:"redisAddr"`
		IssuerURL     string `json:"issuerUrl"`
		AdminEmail    string `json:"adminEmail"`
		AdminPassword string `json:"adminPassword"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	if !strings.Contains(body.AdminEmail, "@") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_email", "message": "Valid super-admin email is required"})
		return
	}
	if len(body.AdminPassword) < 8 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "weak_password", "message": "Admin password must be at least 8 characters"})
		return
	}

	hash, err := auth.HashPasswordArgon2id(body.AdminPassword)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "hash_error", "message": err.Error()})
		return
	}

	driver := "sqlite3"
	if body.DBDriver == "mysql" {
		driver = "mysql"
	}
	dsn := defaultStr(strings.TrimSpace(body.DBDsn), s.cfgMgr.Get().Database.DSN)

	repo, err := store.Open(driver, dsn)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "db_open_failed", "message": err.Error()})
		return
	}
	if err := repo.Migrate(r.Context()); err != nil {
		_ = repo.Close()
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "db_migrate_failed", "message": err.Error()})
		return
	}

	newCfg := config.SystemConfig{
		Initialized:       true,
		IssuerURL:         strings.TrimRight(defaultStr(strings.TrimSpace(body.IssuerURL), s.getIssuer(r)), "/"),
		AdminEmail:        strings.TrimSpace(body.AdminEmail),
		AdminPasswordHash: hash,
		Database:          config.DBConfig{Driver: driver, DSN: dsn},
		Redis:             config.RedisConfig{Enabled: body.RedisEnabled, Addr: strings.TrimSpace(body.RedisAddr)},
	}

	if err := s.cfgMgr.CompleteSetup(newCfg); err != nil {
		_ = repo.Close()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "already_initialized", "message": err.Error()})
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.repo != nil {
		_ = s.repo.Close()
	}
	s.repo = repo
	var rdb *redis.Client
	if newCfg.Redis.Enabled && newCfg.Redis.Addr != "" {
		rdb = redis.NewClient(&redis.Options{Addr: newCfg.Redis.Addr})
	}
	if s.resilient != nil {
		_ = s.resilient.Close()
	}
	s.resilient = cache.NewResilientCache(rdb, repo.DB(), repo.Driver())

	if len(s.users) > 0 && s.users[0].ID == "usr_super_admin" {
		s.users[0].Email = newCfg.AdminEmail
	}

	u := authUser{Sub: "usr_super_admin", Email: newCfg.AdminEmail, Name: "Wimotek Admin", Role: "super_admin", Provider: "local_setup"}
	tok := "wm_sess_" + randomHex(18)
	s.sessions[tok] = u

	writeJSON(w, http.StatusOK, map[string]any{
		"initialized":  true,
		"config":       s.buildConfigPayloadLocked(r),
		"user":         u,
		"sessionToken": tok,
	})
}

func (s *appServer) handleSetupReset(w http.ResponseWriter, _ *http.Request) {
	_ = s.cfgMgr.ResetSetup()
	writeJSON(w, http.StatusOK, map[string]any{"initialized": false})
}

// ============================================================================
// Authentication Handlers (Argon2id, Email OTP, Passkey, TOTP)
// ============================================================================

func (s *appServer) handlePasswordLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	normEmail := strings.ToLower(strings.TrimSpace(body.Email))

	s.mu.Lock()
	defer s.mu.Unlock()

	if until, locked := s.lockUntil[normEmail]; locked && time.Now().Before(until) {
		retry := int(time.Until(until).Seconds()) + 1
		writeJSON(w, http.StatusLocked, map[string]any{"error": "account_locked", "message": fmt.Sprintf("Account locked due to repeated failures. Retry in %ds.", retry)})
		return
	}

	cfg := s.cfgMgr.Get()
	if cfg.AdminPasswordHash == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "setup_required", "message": "Complete the first-run setup wizard to configure the administrator account."})
		return
	}

	ok, _ := auth.VerifyPasswordArgon2id(body.Password, cfg.AdminPasswordHash)
	if normEmail != strings.ToLower(cfg.AdminEmail) || !ok {
		s.loginFails[normEmail]++
		dur := risk.BackoffDuration(s.loginFails[normEmail])
		if dur > 0 {
			s.lockUntil[normEmail] = time.Now().Add(dur)
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_credentials", "message": fmt.Sprintf("Invalid credentials. Exponential backoff active (%ds).", int(dur.Seconds()))})
			return
		}
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_credentials", "message": "Invalid email or password."})
		return
	}

	delete(s.loginFails, normEmail)
	delete(s.lockUntil, normEmail)
	u := authUser{Sub: "usr_super_admin", Email: cfg.AdminEmail, Name: "Wimotek Admin", Role: "super_admin", Provider: "argon2id_password"}
	tok := "wm_sess_" + randomHex(18)
	s.sessions[tok] = u
	writeJSON(w, http.StatusOK, map[string]any{"user": u, "sessionToken": tok})
}

func (s *appServer) handleSendEmailOTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	email := strings.ToLower(strings.TrimSpace(body.Email))
	if !strings.Contains(email, "@") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_email", "message": "Please enter a valid email address"})
		return
	}

	code := randomDigits(6)
	magicTok := randomHex(16)
	payload, _ := json.Marshal(map[string]string{"code": code, "magicToken": magicTok})

	s.mu.Lock()
	s.cacheSetLocked("otp:email:"+email, string(payload), 5*time.Minute)
	s.cacheSetLocked("otp:magic:"+magicTok, email, 5*time.Minute)
	mode := s.activeCacheModeLocked()
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"sent":         true,
		"email":        email,
		"expiresInSec": 300,
		"cacheBackend": mode,
	})
}

func (s *appServer) handleVerifyEmailOTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email      string `json:"email"`
		Code       string `json:"code"`
		MagicToken string `json:"magicToken"`
		ClientID   string `json:"clientId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	s.mu.Lock()
	defer s.mu.Unlock()

	var verifiedEmail string
	if body.MagicToken != "" {
		found, ok := s.cacheGetLocked("otp:magic:" + strings.TrimSpace(body.MagicToken))
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_magic_link", "message": "Magic link expired or already consumed"})
			return
		}
		verifiedEmail = found
		s.cacheDeleteLocked("otp:magic:" + strings.TrimSpace(body.MagicToken))
		s.cacheDeleteLocked("otp:email:" + found)
	} else {
		email := strings.ToLower(strings.TrimSpace(body.Email))
		raw, ok := s.cacheGetLocked("otp:email:" + email)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "expired_otp", "message": "OTP expired or not requested"})
			return
		}
		var saved map[string]string
		_ = json.Unmarshal([]byte(raw), &saved)
		if saved["code"] != strings.TrimSpace(body.Code) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_otp", "message": "Incorrect 6-digit verification code"})
			return
		}
		verifiedEmail = email
		s.cacheDeleteLocked("otp:email:" + email)
		s.cacheDeleteLocked("otp:magic:" + saved["magicToken"])
	}

	label := "Email OTP (Passwordless)"
	method := "email_otp"
	if body.MagicToken != "" {
		label = "Magic Link (Passwordless)"
		method = "magic_link"
	}
	issued := s.issueLiveTraceLocked(r, body.ClientID, verifiedEmail, strings.Split(verifiedEmail, "@")[0], "email_otp", label, method)
	writeJSON(w, http.StatusOK, issued)
}

func (s *appServer) handlePasskeyChallenge(w http.ResponseWriter, r *http.Request) {
	ch := randomHex(20)
	host := strings.Split(defaultStr(r.Header.Get("X-Forwarded-Host"), r.Host), ":")[0]
	if host == "" {
		host = "localhost"
	}
	s.mu.Lock()
	s.cacheSetLocked("webauthn:ch:"+ch, host, 2*time.Minute)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"challenge":        ch,
		"rpId":             host,
		"timeout":          60000,
		"userVerification": "preferred",
	})
}

func (s *appServer) handlePasskeyAuth(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Challenge     string `json:"challenge"`
		Email         string `json:"email"`
		ClientID      string `json:"clientId"`
		Authenticator string `json:"authenticator"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	s.mu.Lock()
	defer s.mu.Unlock()
	rpID, ok := s.cacheGetLocked("webauthn:ch:" + body.Challenge)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_challenge", "message": "WebAuthn challenge expired or invalid"})
		return
	}
	s.cacheDeleteLocked("webauthn:ch:" + body.Challenge)
	authLabel := defaultStr(body.Authenticator, "Platform Biometric (FIDO2)")
	email := defaultStr(body.Email, defaultStr(s.cfgMgr.Get().AdminEmail, "admin@wimotek.dev"))
	issued := s.issueLiveTraceLocked(r, body.ClientID, email, "Wimotek Admin", "passkey", fmt.Sprintf("Passkey (%s · RP: %s)", authLabel, rpID), "hwk_webauthn")
	issued["rpId"] = rpID
	writeJSON(w, http.StatusOK, issued)
}

func (s *appServer) handleTotpEnroll(w http.ResponseWriter, _ *http.Request) {
	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	email := defaultStr(s.cfgMgr.Get().AdminEmail, "admin@wimotek.dev")
	uri := auth.BuildOTPAuthURI("wimotek/Oauth", email, secret)
	code, _ := auth.GenerateTOTP(secret, time.Now())
	codes := make([]string, 8)
	for i := range codes {
		h := strings.ToUpper(randomHex(4))
		codes[i] = h[:4] + "-" + h[4:8]
	}
	enc, _ := s.keys.EncryptSecret(secret)

	s.mu.Lock()
	s.totpPending[email] = totpRecord{SecretEnc: enc, RecoveryCodes: codes}
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"secret":        secret,
		"otpauthUri":    uri,
		"currentCode":   code,
		"recoveryCodes": codes,
	})
}

func (s *appServer) handleTotpVerify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	email := defaultStr(s.cfgMgr.Get().AdminEmail, "admin@wimotek.dev")

	s.mu.Lock()
	defer s.mu.Unlock()

	if pending, ok := s.totpPending[email]; ok {
		plain, _ := s.keys.DecryptSecret(pending.SecretEnc)
		if !auth.VerifyTOTP(plain, body.Code, time.Now()) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "Invalid 6-digit TOTP code"})
			return
		}
		s.totpEnrolled["usr_super_admin"] = pending
		delete(s.totpPending, email)
		for i := range s.users {
			if s.users[i].ID == "usr_super_admin" {
				s.users[i].TotpEnabled = true
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "enrolled": true, "message": "TOTP 2FA verified and enabled for account."})
		return
	}

	enrolled, ok := s.totpEnrolled["usr_super_admin"]
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "No TOTP secret enrolled yet"})
		return
	}
	plain, _ := s.keys.DecryptSecret(enrolled.SecretEnc)
	if auth.VerifyTOTP(plain, body.Code, time.Now()) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "TOTP 2FA code verified."})
		return
	}
	writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "Incorrect TOTP code."})
}

func (s *appServer) handleAuthMe(w http.ResponseWriter, r *http.Request) {
	tok := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	s.mu.RLock()
	u := s.sessions[tok]
	s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"user": u})
}

// ============================================================================
// Admin Console APIs
// ============================================================================

func (s *appServer) handleOverview(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	enabledCount := 0
	for _, c := range s.connectors {
		if c.Enabled {
			enabledCount++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"config":     s.buildConfigPayloadLocked(r),
		"cacheStats": s.cacheStatsLocked(),
		"counts": map[string]int{
			"applications":      len(s.apps),
			"enabledConnectors": enabledCount,
			"totalConnectors":   len(s.connectors),
			"users":             len(s.users),
		},
		"jwksKid":          s.keys.KeyID(),
		"signingKeyStatus": s.keys.Status(),
		"authPolicy":       s.policy,
	})
}

func (s *appServer) handleRotateSigningKey(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode         string `json:"mode"`
		GraceMinutes int    `json:"graceMinutes"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	emergency := body.Mode == "emergency"
	graceMins := body.GraceMinutes
	if graceMins < 5 {
		graceMins = 120
	}
	if graceMins > 1440 {
		graceMins = 1440
	}

	prevKid, status, err := s.keys.RotateRSA(emergency, time.Duration(graceMins)*time.Minute)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error":   "rotation_failed",
			"message": err.Error(),
		})
		return
	}

	mode := "graceful"
	if emergency {
		mode = "emergency"
		s.mu.Lock()
		s.refreshToks = make(map[string]authCodeRecord)
		s.mu.Unlock()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"mode":             mode,
		"previousKid":      prevKid,
		"jwksKid":          status.ActiveKid,
		"signingKeyStatus": status,
	})
}

func (s *appServer) handlePurgeRetiringKeys(w http.ResponseWriter, _ *http.Request) {
	purged, status := s.keys.PurgeRetiring()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"purgedCount":      purged,
		"jwksKid":          status.ActiveKid,
		"signingKeyStatus": status,
	})
}

func (s *appServer) handleCacheSim(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SimulatedDown bool `json:"simulatedDown"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	cfg := s.cfgMgr.Get()
	cfg.Redis.SimulatedDown = body.SimulatedDown
	_ = s.cfgMgr.Update(cfg)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.cacheSetLocked("probe:failover", "ok", 30*time.Second)
	writeJSON(w, http.StatusOK, map[string]any{
		"config":     s.buildConfigPayloadLocked(r),
		"cacheStats": s.cacheStatsLocked(),
	})
}

func (s *appServer) handleListApps(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"applications": s.apps})
}

func (s *appServer) handleCreateApp(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name         string `json:"name"`
		Description  string `json:"description"`
		RedirectUris string `json:"redirectUris"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if strings.TrimSpace(body.Name) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_name", "message": "Application name is required"})
		return
	}
	var uris []string
	for _, line := range strings.Split(body.RedirectUris, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if u, err := url.Parse(trimmed); err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_uri", "message": "Invalid redirect URI: " + trimmed})
			return
		}
		uris = append(uris, trimmed)
	}
	if len(uris) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_uris", "message": "At least one http(s) redirect URI is required"})
		return
	}
	appTheme := defaultLoginTheme(strings.TrimSpace(body.Name))
	created := oauthApplication{
		ID:           "app_" + randomHex(4),
		Name:         strings.TrimSpace(body.Name),
		Description:  strings.TrimSpace(body.Description),
		ClientID:     "wimotek_" + randomHex(6),
		ClientSecret: "wms_" + randomHex(14),
		RedirectUris: uris,
		Scopes:       []string{"openid", "profile", "email", "offline_access"},
		CreatedAt:    time.Now().UTC().Format(time.RFC3339),
		LoginTheme:   &appTheme,
	}
	s.mu.Lock()
	s.apps = append([]oauthApplication{created}, s.apps...)
	s.mu.Unlock()
	writeJSON(w, http.StatusCreated, map[string]any{"application": created})
}

func (s *appServer) handleDeleteApp(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, a := range s.apps {
		if a.ID == id {
			s.apps = append(s.apps[:i], s.apps[i+1:]...)
			writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
}

var (
	themeHexColorRe  = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)
	cssStyleTagRe    = regexp.MustCompile(`(?i)</?style[^>]*>`)
	cssImportRe      = regexp.MustCompile(`(?i)@import\b[^;]*;?`)
	cssExpressionRe  = regexp.MustCompile(`(?i)expression\s*\([^)]*\)`)
	cssJsSchemeRe    = regexp.MustCompile(`(?i)(?:javascript|vbscript)\s*:`)
	cssBehaviorRe    = regexp.MustCompile(`(?i)behavior\s*:`)
	cssUnsafeUrlRe   = regexp.MustCompile(`(?i)url\s*\(\s*['"]?\s*(?:javascript|data:text/html)`)
)

func defaultLoginTheme(brand string) loginThemeConfig {
	title := strings.TrimSpace(brand)
	if title == "" {
		title = "wimotek/Oauth"
	}
	footer := "wimotek/Oauth"
	if title != "wimotek/Oauth" {
		footer = title + " · wimotek/Oauth"
	}
	return loginThemeConfig{
		Layout:          "centered",
		SurfaceMode:     "auto",
		BrandTitle:      title,
		BrandSubtitle:   "",
		HeroTitle:       "One unified identity for every workspace.",
		HeroSubtitle:    "Sign in once with Passkeys, Social OIDC, or Passwordless Email OTP — secured with RS256 and PKCE S256.",
		LogoURL:         "",
		PrimaryColor:    "#4F46E5",
		BackgroundColor: "#F8FAFC",
		CardColor:       "#FFFFFF",
		TextColor:       "#0F172A",
		BorderRadius:    "rounded",
		FontFamily:      "sans",
		SocialLayout:    "stack",
		FooterText:      footer,
		CustomCSS:       "",
	}
}

func truncateRunes(val string, max int) string {
	r := []rune(strings.TrimSpace(val))
	if len(r) > max {
		return string(r[:max])
	}
	return string(r)
}

func sanitizeLoginLogoURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, "/") && !strings.HasPrefix(trimmed, "//") {
		return truncateRunes(trimmed, 400)
	}
	if u, err := url.Parse(trimmed); err == nil && (u.Scheme == "https" || u.Scheme == "http") {
		return truncateRunes(trimmed, 400)
	}
	return ""
}

func sanitizeLoginCustomCSS(raw string) string {
	out := cssStyleTagRe.ReplaceAllString(raw, "")
	out = cssImportRe.ReplaceAllString(out, "")
	out = cssExpressionRe.ReplaceAllString(out, "")
	out = cssJsSchemeRe.ReplaceAllString(out, "")
	out = cssBehaviorRe.ReplaceAllString(out, "")
	out = cssUnsafeUrlRe.ReplaceAllString(out, "url(about:blank")
	return truncateRunes(out, 4000)
}

func normalizeLoginTheme(in loginThemeConfig, fallbackBrand string) loginThemeConfig {
	base := defaultLoginTheme(fallbackBrand)
	switch in.Layout {
	case "centered", "split_left", "split_right", "minimal":
		base.Layout = in.Layout
	}
	switch in.SurfaceMode {
	case "auto", "light", "dark":
		base.SurfaceMode = in.SurfaceMode
	}
	if strings.TrimSpace(in.BrandTitle) != "" {
		base.BrandTitle = truncateRunes(in.BrandTitle, 80)
	}
	base.BrandSubtitle = truncateRunes(in.BrandSubtitle, 160)
	if strings.TrimSpace(in.HeroTitle) != "" {
		base.HeroTitle = truncateRunes(in.HeroTitle, 120)
	}
	if strings.TrimSpace(in.HeroSubtitle) != "" {
		base.HeroSubtitle = truncateRunes(in.HeroSubtitle, 240)
	}
	base.LogoURL = sanitizeLoginLogoURL(in.LogoURL)
	if themeHexColorRe.MatchString(strings.TrimSpace(in.PrimaryColor)) {
		base.PrimaryColor = strings.TrimSpace(in.PrimaryColor)
	}
	if themeHexColorRe.MatchString(strings.TrimSpace(in.BackgroundColor)) {
		base.BackgroundColor = strings.TrimSpace(in.BackgroundColor)
	}
	if themeHexColorRe.MatchString(strings.TrimSpace(in.CardColor)) {
		base.CardColor = strings.TrimSpace(in.CardColor)
	}
	if themeHexColorRe.MatchString(strings.TrimSpace(in.TextColor)) {
		base.TextColor = strings.TrimSpace(in.TextColor)
	}
	switch in.BorderRadius {
	case "sharp", "rounded", "pill":
		base.BorderRadius = in.BorderRadius
	}
	switch in.FontFamily {
	case "sans", "serif", "mono":
		base.FontFamily = in.FontFamily
	}
	if in.SocialLayout == "grid" {
		base.SocialLayout = "grid"
	} else {
		base.SocialLayout = "stack"
	}
	if strings.TrimSpace(in.FooterText) != "" {
		base.FooterText = truncateRunes(in.FooterText, 80)
	}
	base.CustomCSS = sanitizeLoginCustomCSS(in.CustomCSS)
	return base
}

func (s *appServer) handlePublicTheme(w http.ResponseWriter, r *http.Request) {
	clientID := strings.TrimSpace(r.URL.Query().Get("client_id"))
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, a := range s.apps {
		if clientID != "" && (a.ClientID == clientID || a.ID == clientID) {
			theme := defaultLoginTheme(a.Name)
			if a.LoginTheme != nil {
				theme = normalizeLoginTheme(*a.LoginTheme, a.Name)
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"clientId": a.ClientID,
				"appName":  a.Name,
				"theme":    theme,
			})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"clientId": "default",
		"appName":  "wimotek/Oauth",
		"theme":    defaultLoginTheme("wimotek/Oauth"),
	})
}

func (s *appServer) handleGetAppTheme(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimSpace(r.PathValue("clientId"))
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, a := range s.apps {
		if a.ClientID == key || a.ID == key {
			theme := defaultLoginTheme(a.Name)
			if a.LoginTheme != nil {
				theme = normalizeLoginTheme(*a.LoginTheme, a.Name)
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"clientId": a.ClientID,
				"appName":  a.Name,
				"theme":    theme,
			})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "application_not_found"})
}

func (s *appServer) handleUpdateAppTheme(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimSpace(r.PathValue("clientId"))
	var payload loginThemeConfig
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json", "message": "Invalid theme JSON payload"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.apps {
		if s.apps[i].ClientID == key || s.apps[i].ID == key {
			normalized := normalizeLoginTheme(payload, s.apps[i].Name)
			s.apps[i].LoginTheme = &normalized
			writeJSON(w, http.StatusOK, map[string]any{
				"ok":          true,
				"clientId":    s.apps[i].ClientID,
				"appName":     s.apps[i].Name,
				"theme":       normalized,
				"application": s.apps[i],
			})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "application_not_found"})
}

func (s *appServer) handlePublicConnectors(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]map[string]any, 0, len(s.connectors))
	for _, c := range s.connectors {
		out = append(out, map[string]any{
			"id":          c.ID,
			"provider":    c.Provider,
			"displayName": c.DisplayName,
			"enabled":     c.Enabled,
			"extra":       map[string]string{"wechat_mode": c.Extra["wechat_mode"]},
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"connectors": out})
}

func (s *appServer) handleListConnectors(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"connectors": s.serializeConnectorsLocked()})
}

func (s *appServer) handleReorderConnectors(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OrderedIDs []string `json:"orderedIds"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if len(body.OrderedIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_order"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	byID := make(map[string]storedConnector, len(s.connectors))
	for _, c := range s.connectors {
		byID[c.ID] = c
	}
	seen := make(map[string]bool)
	next := make([]storedConnector, 0, len(s.connectors))
	for _, id := range body.OrderedIDs {
		if c, ok := byID[id]; ok && !seen[id] {
			next = append(next, c)
			seen[id] = true
		}
	}
	for _, c := range s.connectors {
		if !seen[c.ID] {
			next = append(next, c)
		}
	}
	s.connectors = next
	writeJSON(w, http.StatusOK, map[string]any{"connectors": s.serializeConnectorsLocked()})
}

func (s *appServer) handleUpdateConnector(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Enabled      *bool             `json:"enabled"`
		ClientID     *string           `json:"clientId"`
		ClientSecret *string           `json:"clientSecret"`
		DisplayName  *string           `json:"displayName"`
		Extra        map[string]string `json:"extra"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.connectors {
		if s.connectors[i].ID == id {
			if body.Enabled != nil {
				s.connectors[i].Enabled = *body.Enabled
			}
			if body.DisplayName != nil && strings.TrimSpace(*body.DisplayName) != "" {
				s.connectors[i].DisplayName = strings.TrimSpace(*body.DisplayName)
			}
			if body.ClientID != nil {
				s.connectors[i].ClientID = strings.TrimSpace(*body.ClientID)
			}
			if body.ClientSecret != nil && strings.TrimSpace(*body.ClientSecret) != "" {
				sec := strings.TrimSpace(*body.ClientSecret)
				s.connectors[i].EncryptedSecret, _ = s.keys.EncryptSecret(sec)
				s.connectors[i].SecretPreview = maskSecret(sec)
			}
			if body.Extra != nil {
				if s.connectors[i].Extra == nil {
					s.connectors[i].Extra = map[string]string{}
				}
				for k, v := range body.Extra {
					s.connectors[i].Extra[k] = v
				}
			}
			s.connectors[i].UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			writeJSON(w, http.StatusOK, map[string]any{"connectors": s.serializeConnectorsLocked()})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
}

func (s *appServer) handleCreateConnector(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DisplayName  string `json:"displayName"`
		ClientID     string `json:"clientId"`
		ClientSecret string `json:"clientSecret"`
		IssuerURL    string `json:"issuerUrl"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if strings.TrimSpace(body.DisplayName) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_name"})
		return
	}
	enc := ""
	preview := ""
	if strings.TrimSpace(body.ClientSecret) != "" {
		enc, _ = s.keys.EncryptSecret(strings.TrimSpace(body.ClientSecret))
		preview = maskSecret(strings.TrimSpace(body.ClientSecret))
	}
	created := storedConnector{
		ID:              "conn_custom_" + randomHex(4),
		Provider:        "custom_oidc",
		DisplayName:     strings.TrimSpace(body.DisplayName),
		Enabled:         true,
		ClientID:        defaultStr(strings.TrimSpace(body.ClientID), "oidc_"+randomHex(4)),
		EncryptedSecret: enc,
		SecretPreview:   preview,
		Extra:           map[string]string{"discovery_url": strings.TrimSpace(body.IssuerURL)},
		UpdatedAt:       time.Now().UTC().Format(time.RFC3339),
	}
	s.mu.Lock()
	s.connectors = append(s.connectors, created)
	s.mu.Unlock()
	writeJSON(w, http.StatusCreated, map[string]any{"id": created.ID})
}

func (s *appServer) handleListUsers(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"users":       s.users,
		"webhooks":    s.serializeWebhooksLocked(),
		"webhookLogs": s.webhookLogs,
	})
}

func (s *appServer) handleSimulateJit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email         string `json:"email"`
		DisplayName   string `json:"displayName"`
		Provider      string `json:"provider"`
		EmailVerified bool   `json:"emailVerified"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	labels := map[string]string{
		"microsoft": "Microsoft (Entra ID)",
		"apple":     "Apple",
		"google":    "Google",
		"wechat":    "微信 WeChat",
		"github":    "GitHub",
		"passkey":   "Passkey (FIDO2)",
	}
	s.mu.Lock()
	action, usr := s.resolveOrLinkIdentityLocked(body.Provider, defaultStr(labels[body.Provider], body.Provider), body.Provider+"_"+randomHex(4), body.Email, body.DisplayName, body.EmailVerified)
	usersCopy := s.users
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"action": action, "user": usr, "users": usersCopy})
}

func (s *appServer) handleUserStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Status string `json:"status"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	nextStatus := "active"
	if body.Status == "banned" {
		nextStatus = "banned"
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.users {
		if s.users[i].ID == id {
			s.users[i].Status = nextStatus
			if nextStatus == "banned" {
				for _, wh := range s.webhooks {
					if !wh.Enabled {
						continue
					}
					sec, _ := s.keys.DecryptSecret(wh.SecretEnc)
					payloadBytes, _ := json.Marshal(map[string]any{
						"event":     "user.banned",
						"timestamp": time.Now().UTC().Format(time.RFC3339),
						"data": map[string]string{
							"user_id": s.users[i].ID,
							"email":   s.users[i].Email,
							"action":  "revoke_all_sessions",
						},
					})
					sig := risk.SignWebhookPayload(sec, payloadBytes)
					entry := webhookDeliveryLog{
						ID:              "whlog_" + randomHex(4),
						WebhookID:       wh.ID,
						TargetURL:       wh.TargetURL,
						Event:           "user.banned",
						UserEmail:       s.users[i].Email,
						SignatureHeader: sig,
						PayloadPreview:  string(payloadBytes),
						Status:          "signed_dispatched",
						Timestamp:       time.Now().UTC().Format(time.RFC3339),
					}
					s.webhookLogs = append([]webhookDeliveryLog{entry}, s.webhookLogs...)
				}
			}
			writeJSON(w, http.StatusOK, map[string]any{"user": s.users[i], "webhookLogs": s.webhookLogs})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
}

func (s *appServer) handleCreateWebhook(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name          string `json:"name"`
		TargetURL     string `json:"targetUrl"`
		SigningSecret string `json:"signingSecret"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if strings.TrimSpace(body.Name) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_name", "message": "Webhook name is required"})
		return
	}
	u, err := url.Parse(strings.TrimSpace(body.TargetURL))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_url", "message": "Webhook URL must use http(s)"})
		return
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" || host == "169.254.169.254" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_url", "message": "Blocked private or metadata webhook host"})
		return
	}
	if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_url", "message": "Blocked private or loopback IP address"})
		return
	}

	rawSec := defaultStr(strings.TrimSpace(body.SigningSecret), "whsec_"+randomHex(12))
	enc, _ := s.keys.EncryptSecret(rawSec)
	created := storedWebhook{
		ID:           "wh_" + randomHex(4),
		Name:         strings.TrimSpace(body.Name),
		TargetURL:    strings.TrimSpace(body.TargetURL),
		Events:       []string{"user.banned", "session.revoked"},
		Enabled:      true,
		SecretEnc:    enc,
		SecretMasked: maskSecret(rawSec),
		CreatedAt:    time.Now().UTC().Format(time.RFC3339),
	}
	s.mu.Lock()
	s.webhooks = append([]storedWebhook{created}, s.webhooks...)
	s.mu.Unlock()
	writeJSON(w, http.StatusCreated, map[string]any{"id": created.ID})
}

func (s *appServer) handleDeleteWebhook(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, wh := range s.webhooks {
		if wh.ID == id {
			s.webhooks = append(s.webhooks[:i], s.webhooks[i+1:]...)
			writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
}

func (s *appServer) handleGetPolicy(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"policy": s.policy})
}

func (s *appServer) handleUpdatePolicy(w http.ResponseWriter, r *http.Request) {
	var next authPolicyConfig
	if err := json.NewDecoder(r.Body).Decode(&next); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	s.mu.Lock()
	s.policy = next
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"policy": next})
}

func (s *appServer) handleTestBruteForce(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	email := strings.ToLower(defaultStr(body.Email, "probe@acme-corp.com"))

	s.mu.Lock()
	defer s.mu.Unlock()
	s.loginFails[email]++
	attempts := s.loginFails[email]
	dur := risk.BackoffDuration(attempts)
	locked := attempts >= s.policy.LockoutThreshold && dur > 0
	if locked {
		s.lockUntil[email] = time.Now().Add(dur)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"email":        email,
		"attempts":     attempts,
		"backoffSec":   int(dur.Seconds()),
		"locked":       locked,
		"cacheBackend": s.activeCacheModeLocked(),
	})
}

// ============================================================================
// Pure Utilities
// ============================================================================

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func randomHex(nBytes int) string {
	b := make([]byte, nBytes)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func randomDigits(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	var sb strings.Builder
	for _, v := range b {
		sb.WriteByte('0' + (v % 10))
	}
	return sb.String()
}

func generateUserCode() string {
	const alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789"
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	var sb strings.Builder
	for i, v := range b {
		if i == 4 {
			sb.WriteByte('-')
		}
		sb.WriteByte(alphabet[int(v)%len(alphabet)])
	}
	return sb.String()
}

func maskSecret(s string) string {
	if len(s) <= 8 {
		return "••••••••"
	}
	return s[:4] + "••••••••" + s[len(s)-4:]
}

func defaultStr(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

func isAllowedRedirect(target string, allowlist []string) bool {
	u, err := url.Parse(target)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	for _, allowed := range allowlist {
		if allowed == target {
			return true
		}
	}
	return false
}
