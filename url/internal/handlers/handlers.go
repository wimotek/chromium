package handlers

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/wimotek/url/internal/audit"
	"github.com/wimotek/url/internal/auth"
	"github.com/wimotek/url/internal/cache"
	"github.com/wimotek/url/internal/config"
	"github.com/wimotek/url/internal/db"
	"github.com/wimotek/url/internal/geoip"
	"github.com/wimotek/url/internal/mcp"
	"github.com/wimotek/url/internal/scheduler"
)

const (
	sessionCookieName = "wimotek_session"
	oauthTxCookieName = "wimotek_oauth_tx"
)

type Deps struct {
	Config    *config.Manager
	Store     *db.Store
	Cache     cache.Store
	Auth      *auth.Service
	GeoIP     *geoip.Locator
	Audit     *audit.Logger
	MCP       *mcp.Server
	Scheduler *scheduler.Scheduler
	StaticFS  fs.FS
	DataDir   string
	Version   string
	Commit    string
	BuildDate string
}

type authUser struct {
	ID           string `json:"id"`
	Email        string `json:"email"`
	Name         string `json:"name"`
	Role         string `json:"role"`
	Tier         string `json:"tier"`
	Status       string `json:"status"`
	AuthProvider string `json:"auth_provider"`
}

func NewRouter(d Deps) http.Handler {
	mux := http.NewServeMux()
	fileServer := http.FileServer(http.FS(d.StaticFS))

	serveSPA := func(w http.ResponseWriter, r *http.Request) {
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/"
		fileServer.ServeHTTP(w, r2)
	}

	requireUser := func(w http.ResponseWriter, r *http.Request) (*authUser, bool) {
		token := extractAuthToken(r)
		if token == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
			return nil, false
		}
		claims, err := d.Auth.VerifyToken(token)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
			return nil, false
		}
		conn := d.Store.DB()
		if conn == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "database not initialized"})
			return nil, false
		}
		var u authUser
		err = conn.QueryRow(
			`SELECT id, email, name, role, tier, status, auth_provider FROM users WHERE id = ? LIMIT 1`,
			claims.UserID,
		).Scan(&u.ID, &u.Email, &u.Name, &u.Role, &u.Tier, &u.Status, &u.AuthProvider)
		if err != nil || u.Status != "active" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "account inactive or not found"})
			return nil, false
		}
		return &u, true
	}

	isAdminRole := func(role string) bool {
		return role == "super_admin" || role == "admin"
	}

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":      "ok",
			"version":     d.Version,
			"commit":      d.Commit,
			"build_date":  d.BuildDate,
			"initialized": d.Config.Get().Initialized,
			"cache":       d.Cache.EngineName(),
		})
	})

	// First-Run Setup Wizard Endpoints (permanently locked once initialized)
	mux.HandleFunc("/api/setup/status", func(w http.ResponseWriter, _ *http.Request) {
		cfg := d.Config.Get()
		writeJSON(w, http.StatusOK, map[string]any{
			"initialized":         cfg.Initialized,
			"locked":              d.Config.IsLocked(),
			"oauth_active":        cfg.IsOAuthActive(),
			"oauth_auto_redirect": cfg.OAuth.AutoRedirect,
			"oauth_issuer_url":    cfg.EffectiveOAuthIssuer(),
			"oauth_client_id":     cfg.EffectiveOAuthClientID(),
			"admin_path":          cfg.AdminPath,
			"antibot_mode":        cfg.AntiBot.Mode,
			"turnstile_site_key":  cfg.EffectiveTurnstileSiteKey(),
		})
	})

	mux.HandleFunc("/api/setup/test-db", func(w http.ResponseWriter, r *http.Request) {
		if d.Config.IsLocked() {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "system is already initialized and locked"})
			return
		}
		var req config.DatabaseConfig
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid payload"})
			return
		}
		if err := d.Store.TestConnection(req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	mux.HandleFunc("/api/setup/complete", func(w http.ResponseWriter, r *http.Request) {
		if d.Config.IsLocked() {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "system is already initialized and locked"})
			return
		}
		var req struct {
			Database      config.DatabaseConfig `json:"database"`
			Redis         config.RedisConfig    `json:"redis"`
			IssuerURL     string                `json:"issuer_url"`
			AdminPath     string                `json:"admin_path"`
			AdminEmail    string                `json:"admin_email"`
			AdminPassword string                `json:"admin_password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
			return
		}
		if strings.TrimSpace(req.AdminEmail) == "" || len(req.AdminPassword) < 8 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "admin email and >=8 char password are required"})
			return
		}
		if err := d.Store.Connect(req.Database); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := d.Store.Migrate(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		hash, err := auth.HashPassword(req.AdminPassword)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "password hashing failed"})
			return
		}
		adminSlug := strings.Trim(strings.TrimSpace(req.AdminPath), "/")
		if adminSlug == "" {
			adminSlug = "admin"
		}

		cfg := d.Config.Get()
		cfg.Database = req.Database
		cfg.Redis = req.Redis
		cfg.IssuerURL = strings.TrimRight(strings.TrimSpace(req.IssuerURL), "/")
		if cfg.IssuerURL == "" {
			cfg.IssuerURL = "https://u.wimotek.com"
		}
		cfg.AdminPath = "/" + adminSlug
		cfg.Initialized = true
		// First login: never force OAuth unless OAUTH_SECRET env is configured
		if cfg.EffectiveOAuthSecret() == "" {
			cfg.OAuth.Enabled = false
		}

		err = d.Store.WithWriteLock(func(conn *sql.DB) error {
			if _, err := conn.Exec(
				`INSERT INTO users (id, email, name, password_hash, role, tier, status, auth_provider) VALUES ('usr_super_admin', ?, 'Super Admin', ?, 'super_admin', 'unlimited', 'active', 'local')`,
				strings.ToLower(strings.TrimSpace(req.AdminEmail)), hash,
			); err != nil {
				return err
			}
			_, _ = conn.Exec(
				`INSERT INTO domains (id, host, is_default, root_redirect_enabled, root_redirect_url, allowed_tiers, dns_verified) VALUES ('dom_primary', ?, TRUE, FALSE, ?, '', TRUE)`,
				cfg.IssuerHostname(), cfg.RootRedirectURL,
			)
			_, err := conn.Exec(
				`INSERT INTO short_links (id, slug, domain, target_url, title, seo_description, seo_indexable, redirect_code, cache_ttl_seconds, enabled, is_system_protected, owner_id)
				 VALUES ('lnk_system_admin', ?, ?, ?, 'Admin Portal', 'Protected administration portal entry', FALSE, 302, 0, TRUE, TRUE, 'usr_super_admin')`,
				adminSlug, cfg.IssuerHostname(), cfg.IssuerURL+cfg.AdminPath,
			)
			return err
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		if err := d.Config.Save(cfg); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if err := d.Config.LockSetup(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		d.Scheduler.Start(cfg.BackupRetentionCount)
		d.Audit.Record(req.AdminEmail, "setup_initialize", cfg.AdminPath, clientIP(r), "LOCAL", "success", "System initialized and setup wizard locked")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "admin_path": cfg.AdminPath})
	})

	// =========================================================================
	// wimotek/Oauth OIDC 1.0 + OAuth 2.0 PKCE (S256) Routes (Mode A)
	// =========================================================================
	startOAuthRedirect := func(w http.ResponseWriter, r *http.Request) {
		cfg := d.Config.Get()
		if !cfg.Initialized {
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		if r.URL.Query().Get("local") == "1" || !cfg.IsOAuthActive() {
			serveSPA(w, r)
			return
		}
		returnTo := auth.ValidateReturnTo(r.URL.Query().Get("returnTo"), cfg.AdminPath)
		authorizeURL, state, verifier := d.Auth.StartOAuthFlow(returnTo, cfg.EffectiveOAuthRedirectURI())
		http.SetCookie(w, &http.Cookie{
			Name:     oauthTxCookieName,
			Value:    state + "|" + verifier,
			Path:     "/",
			MaxAge:   300,
			HttpOnly: true,
			Secure:   r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
			SameSite: http.SameSiteLaxMode,
		})
		http.Redirect(w, r, authorizeURL, http.StatusFound)
	}

	mux.HandleFunc("/login", startOAuthRedirect)
	mux.HandleFunc("/api/auth/oauth/login", startOAuthRedirect)

	handleOAuthCallback := func(w http.ResponseWriter, r *http.Request) {
		// Always clear PKCE transaction cookie immediately
		http.SetCookie(w, &http.Cookie{
			Name:     oauthTxCookieName,
			Value:    "",
			Path:     "/",
			MaxAge:   -1,
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
		})

		if oauthErr := r.URL.Query().Get("error"); oauthErr != "" {
			renderOAuthErrorPage(w, http.StatusBadRequest, "OAuth 认证失败: "+oauthErr)
			return
		}
		code := strings.TrimSpace(r.URL.Query().Get("code"))
		state := strings.TrimSpace(r.URL.Query().Get("state"))
		if code == "" || state == "" {
			renderOAuthErrorPage(w, http.StatusBadRequest, "回调参数缺少 code 或 state")
			return
		}

		var cookieState, cookieVerifier string
		if c, err := r.Cookie(oauthTxCookieName); err == nil {
			parts := strings.SplitN(c.Value, "|", 2)
			if len(parts) == 2 {
				cookieState, cookieVerifier = parts[0], parts[1]
			}
		}

		entry, err := d.Auth.ConsumeOAuthState(state, cookieState, cookieVerifier)
		if err != nil {
			renderOAuthErrorPage(w, http.StatusBadRequest, err.Error())
			return
		}

		info, err := d.Auth.ExchangeCodeAndUserInfo(r.Context(), code, entry.CodeVerifier, entry.RedirectURI)
		if err != nil {
			renderOAuthErrorPage(w, http.StatusBadGateway, "OIDC 换票失败: "+err.Error())
			return
		}

		conn := d.Store.DB()
		if conn == nil {
			renderOAuthErrorPage(w, http.StatusServiceUnavailable, "数据库未初始化")
			return
		}

		var user authUser
		err = conn.QueryRow(
			`SELECT id, email, name, role, tier, status, auth_provider FROM users WHERE oauth_sub = ? LIMIT 1`,
			info.Sub,
		).Scan(&user.ID, &user.Email, &user.Name, &user.Role, &user.Tier, &user.Status, &user.AuthProvider)

		if err == sql.ErrNoRows && info.EmailVerified && strings.TrimSpace(info.Email) != "" {
			normEmail := strings.ToLower(strings.TrimSpace(info.Email))
			err = conn.QueryRow(
				`SELECT id, email, name, role, tier, status, auth_provider FROM users WHERE email = ? LIMIT 1`,
				normEmail,
			).Scan(&user.ID, &user.Email, &user.Name, &user.Role, &user.Tier, &user.Status, &user.AuthProvider)
			if err == nil {
				_ = d.Store.WithWriteLock(func(c *sql.DB) error {
					_, e := c.Exec(`UPDATE users SET oauth_sub = ?, auth_provider = 'wimotek_oauth', last_login_at = CURRENT_TIMESTAMP WHERE id = ?`, info.Sub, user.ID)
					return e
				})
				user.AuthProvider = "wimotek_oauth"
			}
		}

		if err == sql.ErrNoRows {
			newID := "usr_oauth_" + auth.RandomToken(6)
			email := strings.ToLower(strings.TrimSpace(info.Email))
			if email == "" {
				email = info.Sub + "@oauth.wimotek.local"
			}
			displayName := strings.TrimSpace(info.Name)
			if displayName == "" {
				displayName = strings.TrimSpace(info.PreferredName)
			}
			if displayName == "" {
				displayName = email
			}
			randomHash, _ := auth.HashPassword(auth.RandomToken(16))
			createErr := d.Store.WithWriteLock(func(c *sql.DB) error {
				_, e := c.Exec(
					`INSERT INTO users (id, email, name, password_hash, role, tier, status, auth_provider, oauth_sub, last_login_at) VALUES (?, ?, ?, ?, 'member', 'free', 'active', 'wimotek_oauth', ?, CURRENT_TIMESTAMP)`,
					newID, email, displayName, randomHash, info.Sub,
				)
				return e
			})
			if createErr != nil {
				renderOAuthErrorPage(w, http.StatusInternalServerError, "自动创建本地账号失败")
				return
			}
			user = authUser{
				ID:           newID,
				Email:        email,
				Name:         displayName,
				Role:         "member",
				Tier:         "free",
				Status:       "active",
				AuthProvider: "wimotek_oauth",
			}
		} else if err != nil {
			renderOAuthErrorPage(w, http.StatusInternalServerError, "读取本地用户记录失败")
			return
		}

		if user.Status != "active" {
			renderOAuthErrorPage(w, http.StatusForbidden, "该账号已被封禁或停用")
			return
		}

		cfg := d.Config.Get()
		ttl := time.Duration(maxInt(cfg.TrustedDeviceDays, 7)) * 24 * time.Hour
		token, err := d.Auth.SignToken(auth.SessionClaims{
			UserID:   user.ID,
			Email:    user.Email,
			Role:     user.Role,
			IssuedAt: time.Now().Unix(),
			Expires:  time.Now().Add(ttl).Unix(),
			Provider: "wimotek_oauth",
		})
		if err != nil {
			renderOAuthErrorPage(w, http.StatusInternalServerError, "会话签发失败")
			return
		}

		setSessionCookie(w, r, token, int(ttl.Seconds()))
		d.Audit.Record(user.Email, "oauth_login", "/auth/callback", clientIP(r), d.GeoIP.Lookup(r).CountryCode, "success", "Signed in via wimotek/Oauth PKCE S256")
		http.Redirect(w, r, auth.ValidateReturnTo(entry.ReturnTo, cfg.AdminPath), http.StatusFound)
	}

	mux.HandleFunc("/auth/callback", handleOAuthCallback)
	mux.HandleFunc("/callback", handleOAuthCallback)

	mux.HandleFunc("/logout", func(w http.ResponseWriter, r *http.Request) {
		clearSessionCookie(w, r)
		if strings.Contains(r.Header.Get("Accept"), "application/json") || r.Method == http.MethodPost {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "redirect": "/logged-out"})
			return
		}
		http.Redirect(w, r, "/logged-out", http.StatusFound)
	})

	mux.HandleFunc("/logged-out", func(w http.ResponseWriter, r *http.Request) {
		serveSPA(w, r)
	})

	// OAuth Webhook for instant ban & session revocation
	mux.HandleFunc("/webhooks/oauth-events", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		secret := d.Config.Get().EffectiveWebhookSecret()
		if secret == "" {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "OAUTH_WEBHOOK_SECRET not configured"})
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		sig := r.Header.Get("X-Wimotek-Signature-256")
		if !auth.VerifyWebhookSignature(body, sig, secret) {
			d.Auth.RecordBlocked()
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid X-Wimotek-Signature-256"})
			return
		}
		var evt struct {
			Event string `json:"event"`
			Type  string `json:"type"`
			Sub   string `json:"sub"`
			Email string `json:"email"`
			Data  struct {
				Sub   string `json:"sub"`
				Email string `json:"email"`
			} `json:"data"`
		}
		_ = json.Unmarshal(body, &evt)
		eventName := evt.Event
		if eventName == "" {
			eventName = evt.Type
		}
		sub := evt.Sub
		if sub == "" {
			sub = evt.Data.Sub
		}
		email := strings.ToLower(strings.TrimSpace(evt.Email))
		if email == "" {
			email = strings.ToLower(strings.TrimSpace(evt.Data.Email))
		}
		if eventName == "user.banned" && d.Store.DB() != nil {
			var uid string
			_ = d.Store.DB().QueryRow(`SELECT id FROM users WHERE (oauth_sub <> '' AND oauth_sub = ?) OR (email <> '' AND email = ?) LIMIT 1`, sub, email).Scan(&uid)
			if uid != "" {
				d.Auth.RevokeUser(uid)
				_ = d.Store.WithWriteLock(func(c *sql.DB) error {
					_, e := c.Exec(`UPDATE users SET status = 'suspended' WHERE id = ?`, uid)
					return e
				})
				d.Audit.Record("wimotek/Oauth", "webhook_user_banned", uid, clientIP(r), "WEBHOOK", "warning", "Revoked local session via webhook")
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"received": true, "event": eventName})
	})

	// =========================================================================
	// Local Auth + Anti-Bot + Rate Limiting
	// =========================================================================
	mux.HandleFunc("/api/auth/challenge", func(w http.ResponseWriter, r *http.Request) {
		cfg := d.Config.Get()
		ip := clientIP(r)
		win := time.Duration(maxInt(cfg.AntiBot.LoginWindowMinutes, 15)) * time.Minute
		rem := d.Auth.RemainingLoginAttempts(ip, cfg.AntiBot.LoginMaxAttempts, win)
		token, question := d.Auth.CreateBotChallenge()
		writeJSON(w, http.StatusOK, map[string]any{
			"antiBotMode":       cfg.AntiBot.Mode,
			"turnstileSiteKey":  cfg.EffectiveTurnstileSiteKey(),
			"challengeToken":    token,
			"question":          question,
			"remainingAttempts": rem,
			"loginRateLimitMax": cfg.AntiBot.LoginMaxAttempts,
		})
	})

	mux.HandleFunc("/api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		cfg := d.Config.Get()
		if !cfg.Initialized || d.Store.DB() == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "system not initialized"})
			return
		}

		ip := clientIP(r)
		win := time.Duration(maxInt(cfg.AntiBot.LoginWindowMinutes, 15)) * time.Minute
		allowed, _, retrySec := d.Auth.AllowLoginAttempt(ip, cfg.AntiBot.LoginMaxAttempts, win)
		if !allowed {
			w.Header().Set("Retry-After", strconv.Itoa(retrySec))
			d.Audit.Record("anonymous", "login_rate_limited", "/api/auth/login", ip, d.GeoIP.Lookup(r).CountryCode, "blocked", "Exceeded login rate limit")
			writeJSON(w, http.StatusTooManyRequests, map[string]string{
				"error": fmt.Sprintf("登录尝试过于频繁，请 %d 秒后再试。", retrySec),
			})
			return
		}

		var req struct {
			Email           string `json:"email"`
			Password        string `json:"password"`
			ChallengeToken  string `json:"challengeToken"`
			ChallengeAnswer string `json:"challengeAnswer"`
			Website         string `json:"website"`
			TurnstileToken  string `json:"turnstileToken"`
			TrustDeviceDays int    `json:"trustDeviceDays"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid login payload"})
			return
		}

		// Anti-bot verification
		switch cfg.AntiBot.Mode {
		case "builtin":
			if err := d.Auth.VerifyBotChallenge(req.ChallengeToken, req.ChallengeAnswer, req.Website); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
		case "turnstile":
			if strings.TrimSpace(req.Website) != "" {
				d.Auth.RecordBlocked()
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bot traffic rejected"})
				return
			}
			if err := d.Auth.VerifyTurnstile(r.Context(), req.TurnstileToken, ip); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
		}

		email := strings.ToLower(strings.TrimSpace(req.Email))
		var u authUser
		var passHash string
		err := d.Store.DB().QueryRow(
			`SELECT id, email, name, password_hash, role, tier, status, auth_provider FROM users WHERE email = ? LIMIT 1`,
			email,
		).Scan(&u.ID, &u.Email, &u.Name, &passHash, &u.Role, &u.Tier, &u.Status, &u.AuthProvider)
		if err != nil || !auth.VerifyPassword(passHash, req.Password) {
			d.Audit.Record(email, "local_login", "/api/auth/login", ip, d.GeoIP.Lookup(r).CountryCode, "failed", "Invalid credentials")
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "邮箱或密码错误"})
			return
		}
		if u.Status != "active" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "该账号已被停用"})
			return
		}

		d.Auth.ResetLoginAttempts(ip)
		_ = d.Store.WithWriteLock(func(c *sql.DB) error {
			_, e := c.Exec(`UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`, u.ID)
			return e
		})

		days := req.TrustDeviceDays
		if days <= 0 {
			days = maxInt(cfg.TrustedDeviceDays, 7)
		}
		ttl := time.Duration(days) * 24 * time.Hour
		token, err := d.Auth.SignToken(auth.SessionClaims{
			UserID:   u.ID,
			Email:    u.Email,
			Role:     u.Role,
			IssuedAt: time.Now().Unix(),
			Expires:  time.Now().Add(ttl).Unix(),
			Provider: "local",
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "token signing failed"})
			return
		}

		setSessionCookie(w, r, token, int(ttl.Seconds()))
		d.Audit.Record(u.Email, "local_login", "/api/auth/login", ip, d.GeoIP.Lookup(r).CountryCode, "success", "Signed in via local credentials + anti-bot")
		writeJSON(w, http.StatusOK, map[string]any{
			"token": token,
			"user":  u,
		})
	})

	mux.HandleFunc("/api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		token := extractAuthToken(r)
		if token == "" {
			writeJSON(w, http.StatusOK, map[string]any{"authenticated": false})
			return
		}
		claims, err := d.Auth.VerifyToken(token)
		if err != nil || d.Store.DB() == nil {
			writeJSON(w, http.StatusOK, map[string]any{"authenticated": false})
			return
		}
		var u authUser
		err = d.Store.DB().QueryRow(
			`SELECT id, email, name, role, tier, status, auth_provider FROM users WHERE id = ? LIMIT 1`,
			claims.UserID,
		).Scan(&u.ID, &u.Email, &u.Name, &u.Role, &u.Tier, &u.Status, &u.AuthProvider)
		if err != nil || u.Status != "active" {
			writeJSON(w, http.StatusOK, map[string]any{"authenticated": false})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"authenticated": true,
			"token":         token,
			"user":          u,
		})
	})

	// =========================================================================
	// Short Links API (Role-enforced 302 vs Admin Dub 301 TTL / 307 + Batch + Per-Link Stats)
	// =========================================================================
	mux.HandleFunc("/api/links", func(w http.ResponseWriter, r *http.Request) {
		u, ok := requireUser(w, r)
		if !ok {
			return
		}
		conn := d.Store.DB()

		switch r.Method {
		case http.MethodGet:
			var rows *sql.Rows
			var err error
			if isAdminRole(u.Role) {
				rows, err = conn.Query(`SELECT id, slug, domain, target_url, title, seo_description, seo_indexable, redirect_code, cache_ttl_seconds, clicks, unique_clicks, enabled, is_system_protected, owner_id, created_at FROM short_links ORDER BY created_at DESC LIMIT 500`)
			} else {
				rows, err = conn.Query(`SELECT id, slug, domain, target_url, title, seo_description, seo_indexable, redirect_code, cache_ttl_seconds, clicks, unique_clicks, enabled, is_system_protected, owner_id, created_at FROM short_links WHERE owner_id = ? ORDER BY created_at DESC LIMIT 500`, u.ID)
			}
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			defer rows.Close()
			list := make([]map[string]any, 0)
			for rows.Next() {
				var id, slug, dom, target, title, seoDesc, ownerID string
				var seoIdx, enabled, protected bool
				var redir, ttl int
				var clicks, uniqueClicks int64
				var createdAt time.Time
				if err := rows.Scan(&id, &slug, &dom, &target, &title, &seoDesc, &seoIdx, &redir, &ttl, &clicks, &uniqueClicks, &enabled, &protected, &ownerID, &createdAt); err == nil {
					list = append(list, map[string]any{
						"id":                id,
						"slug":              slug,
						"domain":            dom,
						"targetUrl":         target,
						"title":             title,
						"seoDescription":    seoDesc,
						"seoIndexable":      seoIdx,
						"redirectCode":      redir,
						"cacheTtlSeconds":   ttl,
						"clicks":            clicks,
						"uniqueClicks":      uniqueClicks,
						"enabled":           enabled,
						"isSystemProtected": protected,
						"ownerId":           ownerID,
						"createdAt":         createdAt.UTC().Format(time.RFC3339),
					})
				}
			}
			writeJSON(w, http.StatusOK, map[string]any{"links": list})

		case http.MethodPost:
			var req struct {
				TargetURL       string `json:"targetUrl"`
				Slug            string `json:"slug"`
				Domain          string `json:"domain"`
				Title           string `json:"title"`
				SeoDescription  string `json:"seoDescription"`
				SeoIndexable    *bool  `json:"seoIndexable"`
				RedirectCode    int    `json:"redirectCode"`
				CacheTtlSeconds int    `json:"cacheTtlSeconds"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid payload"})
				return
			}
			if !isSafeHTTPURL(req.TargetURL) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "targetUrl must be a valid http/https URL"})
				return
			}
			slug := strings.Trim(strings.TrimSpace(req.Slug), "/")
			if slug == "" {
				slug = auth.RandomToken(3)
			}
			cfg := d.Config.Get()
			if "/"+slug == cfg.AdminPath || isReservedSlug(slug) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "slug conflicts with a reserved system route"})
				return
			}
			dom := strings.TrimSpace(req.Domain)
			if dom == "" {
				dom = cfg.IssuerHostname()
			}
			// Role enforcement: regular users are strictly fixed to HTTP 302 (cache_ttl_seconds=0)
			redirectCode := 302
			cacheTTL := 0
			if isAdminRole(u.Role) {
				if req.RedirectCode == 301 || req.RedirectCode == 307 {
					redirectCode = req.RedirectCode
				}
				if redirectCode == 301 {
					cacheTTL = normalizeTTL(req.CacheTtlSeconds)
				}
			}
			seoIdx := true
			if req.SeoIndexable != nil {
				seoIdx = *req.SeoIndexable
			}
			title := strings.TrimSpace(req.Title)
			if title == "" {
				title = slug
			}
			newID := "lnk_" + auth.RandomToken(6)
			err := d.Store.WithWriteLock(func(c *sql.DB) error {
				_, e := c.Exec(
					`INSERT INTO short_links (id, slug, domain, target_url, title, seo_description, seo_indexable, redirect_code, cache_ttl_seconds, enabled, is_system_protected, owner_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, FALSE, ?)`,
					newID, slug, dom, strings.TrimSpace(req.TargetURL), title, strings.TrimSpace(req.SeoDescription), seoIdx, redirectCode, cacheTTL, u.ID,
				)
				return e
			})
			if err != nil {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "short link slug already exists or DB error"})
				return
			}
			d.Audit.Record(u.Email, "create_link", "/"+slug, clientIP(r), d.GeoIP.Lookup(r).CountryCode, "success", fmt.Sprintf("HTTP %d (TTL=%ds)", redirectCode, cacheTTL))
			writeJSON(w, http.StatusCreated, map[string]any{"id": newID, "slug": slug, "redirectCode": redirectCode, "cacheTtlSeconds": cacheTTL})

		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})

	// Batch link updates (supports admin batch 301 + Cache TTL / 302 / 307)
	mux.HandleFunc("/api/links/batch", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		u, ok := requireUser(w, r)
		if !ok {
			return
		}
		var req struct {
			IDs             []string `json:"ids"`
			Action          string   `json:"action"`
			RedirectCode    int      `json:"redirectCode"`
			CacheTtlSeconds int      `json:"cacheTtlSeconds"`
			SeoIndexable    *bool    `json:"seoIndexable"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.IDs) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid batch payload"})
			return
		}
		if req.Action == "set_redirect" && !isAdminRole(u.Role) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "普通用户固定使用 HTTP 302，无权批量修改跳转类型或 301 回源缓存"})
			return
		}

		affected := 0
		_ = d.Store.WithWriteLock(func(c *sql.DB) error {
			for _, id := range req.IDs {
				var ownerID string
				var protected bool
				if err := c.QueryRow(`SELECT owner_id, is_system_protected FROM short_links WHERE id = ?`, id).Scan(&ownerID, &protected); err != nil {
					continue
				}
				if !isAdminRole(u.Role) && ownerID != u.ID {
					continue
				}
				switch req.Action {
				case "delete":
					if protected {
						continue
					}
					if _, err := c.Exec(`DELETE FROM short_links WHERE id = ? AND is_system_protected = FALSE`, id); err == nil {
						affected++
					}
				case "enable":
					if _, err := c.Exec(`UPDATE short_links SET enabled = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, id); err == nil {
						affected++
					}
				case "pause":
					if protected {
						continue
					}
					if _, err := c.Exec(`UPDATE short_links SET enabled = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, id); err == nil {
						affected++
					}
				case "set_seo":
					if req.SeoIndexable != nil {
						if _, err := c.Exec(`UPDATE short_links SET seo_indexable = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, *req.SeoIndexable, id); err == nil {
							affected++
						}
					}
				case "set_redirect":
					code := 302
					ttl := 0
					if req.RedirectCode == 301 || req.RedirectCode == 307 {
						code = req.RedirectCode
					}
					if code == 301 {
						ttl = normalizeTTL(req.CacheTtlSeconds)
					}
					if _, err := c.Exec(`UPDATE short_links SET redirect_code = ?, cache_ttl_seconds = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, code, ttl, id); err == nil {
						affected++
					}
				}
			}
			return nil
		})
		writeJSON(w, http.StatusOK, map[string]any{"affected": affected})
	})

	// Single Link PATCH / DELETE / GET stats
	mux.HandleFunc("/api/links/", func(w http.ResponseWriter, r *http.Request) {
		u, ok := requireUser(w, r)
		if !ok {
			return
		}
		rest := strings.TrimPrefix(r.URL.Path, "/api/links/")
		conn := d.Store.DB()

		// GET /api/links/{id}/stats
		if strings.HasSuffix(rest, "/stats") && r.Method == http.MethodGet {
			id := strings.TrimSuffix(rest, "/stats")
			var slug, dom, target, title, ownerID string
			var redir, ttl int
			var clicks, uniqueClicks int64
			err := conn.QueryRow(
				`SELECT slug, domain, target_url, title, redirect_code, cache_ttl_seconds, clicks, unique_clicks, owner_id FROM short_links WHERE id = ?`,
				id,
			).Scan(&slug, &dom, &target, &title, &redir, &ttl, &clicks, &uniqueClicks, &ownerID)
			if err == sql.ErrNoRows {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "short link not found"})
				return
			}
			if !isAdminRole(u.Role) && ownerID != u.ID {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
				return
			}

			refRows, _ := conn.Query(`SELECT referrer_host, referrer, COUNT(*) AS cnt, COUNT(DISTINCT ip_hash) AS uv FROM click_events WHERE link_id = ? GROUP BY referrer_host, referrer ORDER BY cnt DESC LIMIT 20`, id)
			sites := make([]map[string]any, 0)
			var totalEvents int64
			if refRows != nil {
				defer refRows.Close()
				for refRows.Next() {
					var host, chanName string
					var cnt, uv int64
					if refRows.Scan(&host, &chanName, &cnt, &uv) == nil {
						totalEvents += cnt
						sites = append(sites, map[string]any{"host": host, "channel": chanName, "clicks": cnt, "uniqueVisitors": uv})
					}
				}
			}
			for i := range sites {
				cnt := sites[i]["clicks"].(int64)
				share := 0.0
				if totalEvents > 0 {
					share = float64(cnt*1000/totalEvents) / 10.0
				}
				sites[i]["share"] = share
			}

			recentRows, _ := conn.Query(`SELECT id, referrer_host, referrer_url, referrer, country_code, region, device, created_at FROM click_events WHERE link_id = ? ORDER BY created_at DESC LIMIT 30`, id)
			recent := make([]map[string]any, 0)
			if recentRows != nil {
				defer recentRows.Close()
				for recentRows.Next() {
					var cid, rHost, rURL, rChan, cc, reg, dev string
					var ts time.Time
					if recentRows.Scan(&cid, &rHost, &rURL, &rChan, &cc, &reg, &dev, &ts) == nil {
						recent = append(recent, map[string]any{
							"id":           cid,
							"referrerHost": rHost,
							"referrerUrl":  rURL,
							"channel":      rChan,
							"countryCode":  cc,
							"region":       reg,
							"device":       dev,
							"timestamp":    ts.UTC().Format(time.RFC3339),
						})
					}
				}
			}

			writeJSON(w, http.StatusOK, map[string]any{
				"link": map[string]any{
					"id": id, "slug": slug, "domain": dom, "targetUrl": target, "title": title,
					"redirectCode": redir, "cacheTtlSeconds": ttl,
				},
				"totalClicks":    clicks,
				"uniqueVisitors": uniqueClicks,
				"referrerSites":  sites,
				"recentClicks":   recent,
			})
			return
		}

		id := rest
		var ownerID, slug, targetURL, title string
		var protected, enabled, seoIdx bool
		var curCode, curTTL int
		err := conn.QueryRow(
			`SELECT owner_id, slug, target_url, title, is_system_protected, enabled, seo_indexable, redirect_code, cache_ttl_seconds FROM short_links WHERE id = ?`,
			id,
		).Scan(&ownerID, &slug, &targetURL, &title, &protected, &enabled, &seoIdx, &curCode, &curTTL)
		if err == sql.ErrNoRows {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "short link not found"})
			return
		}
		if !isAdminRole(u.Role) && ownerID != u.ID {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}

		switch r.Method {
		case http.MethodPatch:
			var req struct {
				TargetURL       *string `json:"targetUrl"`
				Title           *string `json:"title"`
				Enabled         *bool   `json:"enabled"`
				SeoIndexable    *bool   `json:"seoIndexable"`
				RedirectCode    *int    `json:"redirectCode"`
				CacheTtlSeconds *int    `json:"cacheTtlSeconds"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid payload"})
				return
			}
			if (req.RedirectCode != nil || req.CacheTtlSeconds != nil) && !isAdminRole(u.Role) {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "普通用户固定 HTTP 302，无权修改跳转码或 301 回源缓存"})
				return
			}
			if req.TargetURL != nil {
				if !isSafeHTTPURL(*req.TargetURL) {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid targetUrl"})
					return
				}
				targetURL = strings.TrimSpace(*req.TargetURL)
			}
			if req.Title != nil {
				title = strings.TrimSpace(*req.Title)
			}
			if req.Enabled != nil && !protected {
				enabled = *req.Enabled
			}
			if req.SeoIndexable != nil {
				seoIdx = *req.SeoIndexable
			}
			if req.RedirectCode != nil && isAdminRole(u.Role) {
				if *req.RedirectCode == 301 || *req.RedirectCode == 302 || *req.RedirectCode == 307 {
					curCode = *req.RedirectCode
				}
			}
			if curCode == 301 {
				if req.CacheTtlSeconds != nil {
					curTTL = normalizeTTL(*req.CacheTtlSeconds)
				} else if curTTL <= 0 {
					curTTL = 300
				}
			} else {
				curTTL = 0
			}
			_ = d.Store.WithWriteLock(func(c *sql.DB) error {
				_, e := c.Exec(
					`UPDATE short_links SET target_url = ?, title = ?, enabled = ?, seo_indexable = ?, redirect_code = ?, cache_ttl_seconds = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
					targetURL, title, enabled, seoIdx, curCode, curTTL, id,
				)
				return e
			})
			_ = d.Cache.Delete(r.Context(), "slug:"+slug)
			writeJSON(w, http.StatusOK, map[string]any{"updated": true, "redirectCode": curCode, "cacheTtlSeconds": curTTL})

		case http.MethodDelete:
			if protected || "/"+slug == d.Config.Get().AdminPath {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "system-protected admin short link cannot be deleted"})
				return
			}
			_ = d.Store.WithWriteLock(func(c *sql.DB) error {
				_, e := c.Exec(`DELETE FROM short_links WHERE id = ? AND is_system_protected = FALSE`, id)
				return e
			})
			_ = d.Cache.Delete(r.Context(), "slug:"+slug)
			writeJSON(w, http.StatusOK, map[string]any{"deleted": true})

		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})

	// =========================================================================
	// Global Analytics + Referring Websites (来源网站信息)
	// =========================================================================
	mux.HandleFunc("/api/analytics", func(w http.ResponseWriter, r *http.Request) {
		_, ok := requireUser(w, r)
		if !ok {
			return
		}
		conn := d.Store.DB()
		var totalClicks, uniqueClicks, activeLinks int64
		_ = conn.QueryRow(`SELECT COALESCE(SUM(clicks),0), COALESCE(SUM(unique_clicks),0), COALESCE(SUM(CASE WHEN enabled THEN 1 ELSE 0 END),0) FROM short_links`).Scan(&totalClicks, &uniqueClicks, &activeLinks)

		geoRows, _ := conn.Query(`SELECT country_code, region, COUNT(*) AS cnt FROM click_events GROUP BY country_code, region ORDER BY cnt DESC LIMIT 12`)
		geoList := make([]map[string]any, 0)
		if geoRows != nil {
			defer geoRows.Close()
			for geoRows.Next() {
				var cc, reg string
				var cnt int64
				if geoRows.Scan(&cc, &reg, &cnt) == nil {
					geoList = append(geoList, map[string]any{"countryCode": cc, "region": reg, "clicks": cnt})
				}
			}
		}

		siteRows, _ := conn.Query(`SELECT referrer_host, referrer, COUNT(*) AS cnt, COUNT(DISTINCT ip_hash) AS uv FROM click_events GROUP BY referrer_host, referrer ORDER BY cnt DESC LIMIT 20`)
		sites := make([]map[string]any, 0)
		var totalRef int64
		if siteRows != nil {
			defer siteRows.Close()
			for siteRows.Next() {
				var host, chanName string
				var cnt, uv int64
				if siteRows.Scan(&host, &chanName, &cnt, &uv) == nil {
					totalRef += cnt
					sites = append(sites, map[string]any{"host": host, "channel": chanName, "clicks": cnt, "uniqueVisitors": uv})
				}
			}
		}
		for i := range sites {
			cnt := sites[i]["clicks"].(int64)
			share := 0.0
			if totalRef > 0 {
				share = float64(cnt*1000/totalRef) / 10.0
			}
			sites[i]["share"] = share
		}

		recentRows, _ := conn.Query(`
			SELECT c.id, COALESCE(l.slug,''), COALESCE(l.domain,''), c.referrer_host, c.referrer_url, c.referrer, c.country_code, c.region, c.device, COALESCE(l.redirect_code,302), c.created_at
			FROM click_events c LEFT JOIN short_links l ON l.id = c.link_id
			ORDER BY c.created_at DESC LIMIT 30`)
		recent := make([]map[string]any, 0)
		if recentRows != nil {
			defer recentRows.Close()
			for recentRows.Next() {
				var cid, slug, dom, rHost, rURL, rChan, cc, reg, dev string
				var redir int
				var ts time.Time
				if recentRows.Scan(&cid, &slug, &dom, &rHost, &rURL, &rChan, &cc, &reg, &dev, &redir, &ts) == nil {
					recent = append(recent, map[string]any{
						"id": cid, "slug": slug, "domain": dom, "referrerHost": rHost, "referrerUrl": rURL,
						"channel": rChan, "countryCode": cc, "region": reg, "device": dev, "redirectCode": redir,
						"timestamp": ts.UTC().Format(time.RFC3339),
					})
				}
			}
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"totalClicks":    totalClicks,
			"uniqueVisitors": uniqueClicks,
			"activeLinks":    activeLinks,
			"geoBreakdown":   geoList,
			"referrerSites":  sites,
			"recentClicks":   recent,
		})
	})

	// =========================================================================
	// 307 Local Interstitial Template API
	// =========================================================================
	mux.HandleFunc("/api/interstitial", func(w http.ResponseWriter, r *http.Request) {
		u, ok := requireUser(w, r)
		if !ok {
			return
		}
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{"interstitial": d.Config.Get().Interstitial})
		case http.MethodPut:
			if !isAdminRole(u.Role) {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin required to edit 307 interstitial template"})
				return
			}
			var next config.InterstitialConfig
			if err := json.NewDecoder(r.Body).Decode(&next); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid interstitial payload"})
				return
			}
			if next.CountdownSeconds < 0 {
				next.CountdownSeconds = 0
			}
			if next.CountdownSeconds > 15 {
				next.CountdownSeconds = 15
			}
			next.PrimaryColor = sanitizeHexColor(next.PrimaryColor)
			cfg := d.Config.Get()
			cfg.Interstitial = next
			if err := d.Config.Save(cfg); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			d.Audit.Record(u.Email, "update_interstitial", "/api/interstitial", clientIP(r), d.GeoIP.Lookup(r).CountryCode, "success", "Preset="+next.Preset)
			writeJSON(w, http.StatusOK, map[string]any{"interstitial": cfg.Interstitial})
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})

	// =========================================================================
	// Settings (wimotek/Oauth + Anti-Bot + Root 301 Forwarding)
	// =========================================================================
	mux.HandleFunc("/api/settings", func(w http.ResponseWriter, r *http.Request) {
		u, ok := requireUser(w, r)
		if !ok {
			return
		}
		switch r.Method {
		case http.MethodGet:
			cfg := d.Config.Get()
			writeJSON(w, http.StatusOK, map[string]any{
				"issuerUrl":               cfg.IssuerURL,
				"adminPath":               cfg.AdminPath,
				"rootRedirectEnabled":     cfg.RootRedirectEnabled,
				"rootRedirectUrl":         cfg.RootRedirectURL,
				"oauthEnabled":            cfg.OAuth.Enabled,
				"oauthConfigured":         cfg.EffectiveOAuthSecret() != "",
				"oauthAutoRedirect":       cfg.OAuth.AutoRedirect,
				"oauthIssuerUrl":          cfg.EffectiveOAuthIssuer(),
				"oauthClientId":           cfg.EffectiveOAuthClientID(),
				"oauthRedirectUri":        cfg.EffectiveOAuthRedirectURI(),
				"antiBotMode":             cfg.AntiBot.Mode,
				"turnstileSiteKey":        cfg.EffectiveTurnstileSiteKey(),
				"loginRateLimitMax":       cfg.AntiBot.LoginMaxAttempts,
				"loginRateLimitWindowMin": cfg.AntiBot.LoginWindowMinutes,
				"redirectRateLimitPerMin": cfg.AntiBot.RedirectRatePerMin,
				"blockedRequestsCount":    d.Auth.BlockedCount(),
				"interstitial":            cfg.Interstitial,
			})
		case http.MethodPatch:
			if !isAdminRole(u.Role) {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin required"})
				return
			}
			var req struct {
				RootRedirectEnabled     *bool   `json:"rootRedirectEnabled"`
				RootRedirectURL         *string `json:"rootRedirectUrl"`
				OAuthEnabled            *bool   `json:"oauthEnabled"`
				OAuthAutoRedirect       *bool   `json:"oauthAutoRedirect"`
				OAuthIssuerURL          *string `json:"oauthIssuerUrl"`
				OAuthClientID           *string `json:"oauthClientId"`
				OAuthRedirectURI        *string `json:"oauthRedirectUri"`
				AntiBotMode             *string `json:"antiBotMode"`
				TurnstileSiteKey        *string `json:"turnstileSiteKey"`
				LoginRateLimitMax       *int    `json:"loginRateLimitMax"`
				LoginRateLimitWindowMin *int    `json:"loginRateLimitWindowMin"`
				RedirectRateLimitPerMin *int    `json:"redirectRateLimitPerMin"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid settings payload"})
				return
			}
			cfg := d.Config.Get()
			if req.RootRedirectEnabled != nil {
				cfg.RootRedirectEnabled = *req.RootRedirectEnabled
			}
			if req.RootRedirectURL != nil && isSafeHTTPURL(*req.RootRedirectURL) {
				cfg.RootRedirectURL = strings.TrimSpace(*req.RootRedirectURL)
			}
			if req.OAuthEnabled != nil {
				cfg.OAuth.Enabled = *req.OAuthEnabled
			}
			if req.OAuthAutoRedirect != nil {
				cfg.OAuth.AutoRedirect = *req.OAuthAutoRedirect
			}
			if req.OAuthIssuerURL != nil && isSafeHTTPURL(*req.OAuthIssuerURL) {
				cfg.OAuth.IssuerURL = strings.TrimRight(strings.TrimSpace(*req.OAuthIssuerURL), "/")
			}
			if req.OAuthClientID != nil && strings.TrimSpace(*req.OAuthClientID) != "" {
				cfg.OAuth.ClientID = strings.TrimSpace(*req.OAuthClientID)
			}
			if req.OAuthRedirectURI != nil && isSafeHTTPURL(*req.OAuthRedirectURI) {
				cfg.OAuth.RedirectURI = strings.TrimSpace(*req.OAuthRedirectURI)
			}
			if req.AntiBotMode != nil && (*req.AntiBotMode == "builtin" || *req.AntiBotMode == "turnstile" || *req.AntiBotMode == "off") {
				cfg.AntiBot.Mode = *req.AntiBotMode
				cfg.Turnstile.Enabled = *req.AntiBotMode == "turnstile"
			}
			if req.TurnstileSiteKey != nil {
				cfg.Turnstile.SiteKey = strings.TrimSpace(*req.TurnstileSiteKey)
			}
			if req.LoginRateLimitMax != nil && *req.LoginRateLimitMax >= 3 && *req.LoginRateLimitMax <= 50 {
				cfg.AntiBot.LoginMaxAttempts = *req.LoginRateLimitMax
			}
			if req.LoginRateLimitWindowMin != nil && *req.LoginRateLimitWindowMin >= 1 && *req.LoginRateLimitWindowMin <= 120 {
				cfg.AntiBot.LoginWindowMinutes = *req.LoginRateLimitWindowMin
			}
			if req.RedirectRateLimitPerMin != nil && *req.RedirectRateLimitPerMin >= 10 && *req.RedirectRateLimitPerMin <= 10000 {
				cfg.AntiBot.RedirectRatePerMin = *req.RedirectRateLimitPerMin
			}
			if err := d.Config.Save(cfg); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			d.Audit.Record(u.Email, "update_settings", "/api/settings", clientIP(r), d.GeoIP.Lookup(r).CountryCode, "success", "Updated system/OAuth/Anti-Bot config")
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})

	// MCP Server Endpoint
	mux.Handle("/mcp", d.MCP)

	// SEO Sitemap
	mux.HandleFunc("/sitemap.xml", func(w http.ResponseWriter, _ *http.Request) {
		cfg := d.Config.Get()
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>` + html.EscapeString(cfg.IssuerURL) + `/</loc></url></urlset>`))
	})

	// =========================================================================
	// Embedded SPA + Root `/` Fixed 301 + Short Link Resolution (Dub 301 TTL / 302 / 307 Interstitial)
	// =========================================================================
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		cfg := d.Config.Get()

		// Root `/` handling: FIXED HTTP 301 Moved Permanently when forwarding is enabled
		if r.URL.Path == "/" {
			if cfg.Initialized && cfg.RootRedirectEnabled && isSafeHTTPURL(cfg.RootRedirectURL) {
				w.Header().Set("Cache-Control", "public, max-age=300, s-maxage=300")
				http.Redirect(w, r, cfg.RootRedirectURL, http.StatusMovedPermanently)
				return
			}
			fileServer.ServeHTTP(w, r)
			return
		}

		// Custom admin path always renders SPA portal
		if r.URL.Path == cfg.AdminPath || strings.HasPrefix(r.URL.Path, cfg.AdminPath+"/") {
			serveSPA(w, r)
			return
		}

		// Never leak unknown /api/* paths into HTML SPA fallback
		if strings.HasPrefix(r.URL.Path, "/api/") {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "API endpoint not found"})
			return
		}

		// Serve static assets if they exist in embedded frontend
		clean := strings.TrimPrefix(r.URL.Path, "/")
		if f, err := d.StaticFS.Open(clean); err == nil {
			_ = f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}

		// Resolve short link
		if cfg.Initialized && d.Store.DB() != nil {
			var linkID, targetURL, title, dom string
			var redirectCode, cacheTTL int
			var enabled bool
			var expiresAt sql.NullTime
			err := d.Store.DB().QueryRow(
				`SELECT id, domain, target_url, title, redirect_code, cache_ttl_seconds, enabled, expires_at FROM short_links WHERE slug = ? LIMIT 1`,
				clean,
			).Scan(&linkID, &dom, &targetURL, &title, &redirectCode, &cacheTTL, &enabled, &expiresAt)
			if err == nil && enabled && isSafeHTTPURL(targetURL) {
				ip := clientIP(r)
				if !d.Auth.AllowRedirect(ip, cfg.AntiBot.RedirectRatePerMin) {
					w.Header().Set("Retry-After", "60")
					http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
					return
				}
				if expiresAt.Valid && expiresAt.Time.Before(time.Now().UTC()) {
					http.Error(w, "Short link has expired", http.StatusGone)
					return
				}

				loc := d.GeoIP.Lookup(r)
				refHost, refURL, refChan := parseReferrerHeader(r.Referer())
				device := detectDevice(r.UserAgent())
				ipHash := hashIP(ip)

				go func() {
					_ = d.Store.WithWriteLock(func(conn *sql.DB) error {
						var existing int
						_ = conn.QueryRow(`SELECT COUNT(1) FROM click_events WHERE link_id = ? AND ip_hash = ?`, linkID, ipHash).Scan(&existing)
						isUnique := 0
						if existing == 0 {
							isUnique = 1
						}
						_, _ = conn.Exec(`UPDATE short_links SET clicks = clicks + 1, unique_clicks = unique_clicks + ? WHERE id = ?`, isUnique, linkID)
						_, err := conn.Exec(
							`INSERT INTO click_events (id, link_id, ip_hash, country_code, region, city, referrer, referrer_host, referrer_url, device, browser) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Web')`,
							"clk_"+auth.RandomToken(6), linkID, ipHash, loc.CountryCode, loc.Region, loc.City, refChan, refHost, refURL, device,
						)
						return err
					})
				}()

				// 307 renders local configurable HTML interstitial page
				if redirectCode == 307 {
					w.Header().Set("Content-Type", "text/html; charset=utf-8")
					w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
					w.Header().Set("X-Robots-Tag", "noindex, nofollow")
					w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; frame-ancestors 'none'")
					w.WriteHeader(http.StatusOK)
					shortURL := "https://" + dom + "/" + clean
					_, _ = w.Write([]byte(renderInterstitialHTML(cfg.Interstitial, title, targetURL, shortURL)))
					return
				}

				// 301 with Dub-style Cache-Control TTL for timed origin revalidation
				if redirectCode == 301 {
					ttl := normalizeTTL(cacheTTL)
					swr := minInt(ttl, 60)
					w.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d, s-maxage=%d, stale-while-revalidate=%d, must-revalidate", ttl, ttl, swr))
					w.Header().Set("CDN-Cache-Control", fmt.Sprintf("max-age=%d", ttl))
					w.Header().Set("Expires", time.Now().UTC().Add(time.Duration(ttl)*time.Second).Format(http.TimeFormat))
					http.Redirect(w, r, targetURL, http.StatusMovedPermanently)
					return
				}

				// Default 302 Found (real-time origin hit)
				w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
				http.Redirect(w, r, targetURL, http.StatusFound)
				return
			}
		}

		// SPA fallback
		serveSPA(w, r)
	})

	return mux
}

func extractAuthToken(r *http.Request) string {
	authz := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(authz), "bearer ") {
		return strings.TrimSpace(authz[7:])
	}
	if c, err := r.Cookie(sessionCookieName); err == nil && strings.TrimSpace(c.Value) != "" {
		return strings.TrimSpace(c.Value)
	}
	return ""
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, token string, maxAgeSec int) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   maxAgeSec,
		HttpOnly: true,
		Secure:   r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
		SameSite: http.SameSiteLaxMode,
	})
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
		SameSite: http.SameSiteLaxMode,
	})
}

func renderOAuthErrorPage(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>登录校验失败 · wimotek/url</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a}.card{max-width:420px;width:100%%;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:28px;text-align:center}h1{margin:0 0 10px;font-size:18px}p{margin:0 0 20px;font-size:13px;color:#b91c1c;line-height:1.6}.btn{display:inline-block;padding:10px 18px;border-radius:8px;background:#2563eb;color:#fff;text-decoration:none;font-size:13px;font-weight:600;margin:0 6px}.alt{background:#fff;color:#334155;border:1px solid #cbd5e1}</style></head><body><div class="card"><h1>OAuth 认证未能完成</h1><p>%s</p><div><a class="btn" href="/login">重新登录</a><a class="btn alt" href="/?local=1">本地登录</a></div></div></body></html>`, html.EscapeString(message))
}

func parseReferrerHeader(raw string) (host, fullURL, channel string) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return "direct", "", "Direct / QR"
	}
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return "direct", "", "Direct / QR"
	}
	h := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	if len(v) > 300 {
		v = v[:300]
	}
	ch := h
	switch {
	case strings.Contains(h, "weixin") || strings.Contains(h, "wechat"):
		ch = "WeChat"
	case strings.Contains(h, "github.com"):
		ch = "GitHub"
	case strings.Contains(h, "zhihu.com"):
		ch = "Zhihu"
	case strings.Contains(h, "google."):
		ch = "Google"
	case strings.Contains(h, "baidu.com"):
		ch = "Baidu"
	case h == "x.com" || strings.Contains(h, "twitter.com") || h == "t.co":
		ch = "X / Twitter"
	}
	return h, v, ch
}

func detectDevice(ua string) string {
	lower := strings.ToLower(ua)
	switch {
	case strings.Contains(lower, "ipad") || strings.Contains(lower, "tablet"):
		return "Tablet"
	case strings.Contains(lower, "mobile") || strings.Contains(lower, "iphone") || strings.Contains(lower, "android"):
		return "Mobile"
	default:
		return "Desktop"
	}
}

func hashIP(ip string) string {
	sum := sha256.Sum256([]byte("wimotek:" + ip))
	return hex.EncodeToString(sum[:12])
}

func clientIP(r *http.Request) string {
	if cf := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); cf != "" {
		return cf
	}
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}

func isReservedSlug(slug string) bool {
	switch strings.ToLower(slug) {
	case "api", "mcp", "login", "logout", "logged-out", "callback", "auth", "health", "sitemap.xml", "webhooks":
		return true
	default:
		return false
	}
}

func normalizeTTL(sec int) int {
	if sec < 10 {
		return 300
	}
	if sec > 604800 {
		return 604800
	}
	return sec
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func isSafeHTTPURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
