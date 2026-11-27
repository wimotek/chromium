package api

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/wimotek/ca/internal/auth"
	"github.com/wimotek/ca/internal/store"
	"github.com/wimotek/ca/internal/wimotekoauth"
)

const (
	oauthGatewaySettingKey = "oauth:wimotek_gateway"
	oauthEncKeySettingKey  = "oauth:wimotek_enc_key"
)

var validTenantRe = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,128}$`)

type storedOAuthGateway struct {
	Issuer                string   `json:"issuer"`
	ClientID              string   `json:"client_id"`
	ClientSecretEnc       string   `json:"client_secret_enc,omitempty"`
	RedirectURI           string   `json:"redirect_uri,omitempty"`
	Scopes                []string `json:"scopes,omitempty"`
	AuthorizationEndpoint string   `json:"authorization_endpoint,omitempty"`
	TokenEndpoint         string   `json:"token_endpoint,omitempty"`
	UserinfoEndpoint      string   `json:"userinfo_endpoint,omitempty"`
	UpdatedAt             int64    `json:"updated_at,omitempty"`
}

type storedDirectOAuth struct {
	ClientID        string `json:"client_id"`
	ClientSecretEnc string `json:"client_secret_enc,omitempty"`
	TenantID        string `json:"tenant_id,omitempty"`
	RedirectURI     string `json:"redirect_uri,omitempty"`
	UpdatedAt       int64  `json:"updated_at,omitempty"`
}

type resolvedDirectOAuth struct {
	Provider           string
	Label              string
	ClientID           string
	ClientSecret       string
	TenantID           string
	CustomRedirect     string
	DefaultCallbackURL string
	CallbackURL        string
	Configured         bool
	Source             string
}

type oauthProviderMeta struct {
	Provider           string `json:"provider"`
	Label              string `json:"label"`
	Configured         bool   `json:"configured"`
	CallbackURL        string `json:"callback_url"`
	DefaultCallbackURL string `json:"default_callback_url,omitempty"`
	Issuer             string `json:"issuer,omitempty"`
}

type oauthIdentity struct {
	Provider      string
	ProviderID    string
	Email         string
	EmailVerified bool
	DisplayName   string
	PreferredUser string
}

func isDirectOAuthProvider(provider string) bool {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "microsoft", "github", "google":
		return true
	default:
		return false
	}
}

func isValidOAuthProvider(provider string) bool {
	p := strings.ToLower(strings.TrimSpace(provider))
	return p == "wimotek" || isDirectOAuthProvider(p)
}

func directProviderLabel(provider string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "microsoft":
		return "Microsoft Entra ID"
	case "github":
		return "GitHub"
	case "google":
		return "Google"
	default:
		return provider
	}
}

func directProviderSettingKey(provider string) string {
	return "oauth:direct:" + strings.ToLower(strings.TrimSpace(provider))
}

func (s *Server) resolveRequestBaseURL(r *http.Request) string {
	configured := strings.TrimRight(strings.TrimSpace(s.base), "/")
	if configured != "" {
		if u, err := url.Parse(configured); err == nil && u.Host != "" {
			hostLower := strings.ToLower(u.Hostname())
			if hostLower != "localhost" && hostLower != "127.0.0.1" && hostLower != "::1" {
				return configured
			}
		}
	}
	if r != nil {
		host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
		if idx := strings.Index(host, ","); idx > 0 {
			host = strings.TrimSpace(host[:idx])
		}
		if host == "" {
			host = strings.TrimSpace(r.Host)
		}
		if host != "" {
			scheme := "http"
			if isRequestHTTPS(r) {
				scheme = "https"
			}
			return scheme + "://" + host
		}
	}
	if configured != "" {
		return configured
	}
	return "https://localhost:8443"
}

func (s *Server) oauthEncKey(ctx context.Context) []byte {
	if raw, err := s.store.GetSetting(ctx, oauthEncKeySettingKey); err == nil && strings.TrimSpace(raw) != "" {
		sum := sha256.Sum256([]byte(raw))
		return sum[:]
	}
	generated := store.GenerateRandomID(32)
	_ = s.store.SetSetting(ctx, oauthEncKeySettingKey, generated)
	sum := sha256.Sum256([]byte(generated))
	return sum[:]
}

func (s *Server) encryptOAuthSecret(ctx context.Context, plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	block, err := aes.NewCipher(s.oauthEncKey(ctx))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ct := gcm.Seal(nonce, nonce, []byte(plain), nil)
	return base64.StdEncoding.EncodeToString(ct), nil
}

func (s *Server) decryptOAuthSecret(ctx context.Context, enc string) string {
	if strings.TrimSpace(enc) == "" {
		return ""
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return ""
	}
	block, err := aes.NewCipher(s.oauthEncKey(ctx))
	if err != nil {
		return ""
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil || len(raw) < gcm.NonceSize() {
		return ""
	}
	nonce, ciphertext := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	pt, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return ""
	}
	return string(pt)
}

func maskOAuthSecret(secret string) string {
	s := strings.TrimSpace(secret)
	if s == "" {
		return ""
	}
	if len(s) <= 4 {
		return "****"
	}
	return "****" + s[len(s)-4:]
}

func validateOptionalHTTPURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}
	u, err := url.Parse(trimmed)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", fmt.Errorf("invalid http(s) URL: %s", trimmed)
	}
	return trimmed, nil
}

func (s *Server) loadStoredOAuthGateway(ctx context.Context) (*storedOAuthGateway, bool) {
	raw, err := s.store.GetSetting(ctx, oauthGatewaySettingKey)
	if err != nil || strings.TrimSpace(raw) == "" {
		return nil, false
	}
	var rec storedOAuthGateway
	if json.Unmarshal([]byte(raw), &rec) != nil {
		return nil, false
	}
	return &rec, true
}

func (s *Server) loadStoredDirectOAuth(ctx context.Context, provider string) (*storedDirectOAuth, bool) {
	raw, err := s.store.GetSetting(ctx, directProviderSettingKey(provider))
	if err != nil || strings.TrimSpace(raw) == "" {
		return nil, false
	}
	var rec storedDirectOAuth
	if json.Unmarshal([]byte(raw), &rec) != nil {
		return nil, false
	}
	return &rec, true
}

func (s *Server) wimotekOAuthClient(ctx context.Context, r *http.Request, callbackPath string) (*wimotekoauth.Client, bool, string, string, string) {
	var (
		issuer         string
		clientID       string
		clientSecret   string
		customRedirect string
		scopes         []string
		authURL        string
		tokenURL       string
		userinfoURL    string
		source         = "unconfigured"
	)

	if saved, ok := s.loadStoredOAuthGateway(ctx); ok && (saved.Issuer != "" || saved.ClientID != "" || saved.ClientSecretEnc != "" || saved.RedirectURI != "" || saved.AuthorizationEndpoint != "" || saved.TokenEndpoint != "" || saved.UserinfoEndpoint != "") {
		issuer = strings.TrimSpace(saved.Issuer)
		clientID = strings.TrimSpace(saved.ClientID)
		clientSecret = s.decryptOAuthSecret(ctx, saved.ClientSecretEnc)
		customRedirect = strings.TrimSpace(saved.RedirectURI)
		scopes = saved.Scopes
		authURL = strings.TrimSpace(saved.AuthorizationEndpoint)
		tokenURL = strings.TrimSpace(saved.TokenEndpoint)
		userinfoURL = strings.TrimSpace(saved.UserinfoEndpoint)
		source = "database"
	} else {
		issuer = strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_ISSUER"))
		clientID = strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_CLIENT_ID"))
		clientSecret = strings.TrimSpace(os.Getenv("OAUTH_SECRET"))
		if clientSecret == "" {
			clientSecret = strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_CLIENT_SECRET"))
		}
		customRedirect = strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_REDIRECT_URI"))
		rawScopes := strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_SCOPES"))
		if rawScopes != "" {
			scopes = strings.Fields(strings.ReplaceAll(rawScopes, ",", " "))
		}
		authURL = strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_AUTH_URL"))
		tokenURL = strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_TOKEN_URL"))
		userinfoURL = strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_USERINFO_URL"))
		if issuer != "" || clientID != "" || clientSecret != "" || customRedirect != "" {
			source = "env"
		}
	}

	if issuer != "" {
		if norm, err := wimotekoauth.NormalizeIssuer(issuer); err == nil {
			issuer = norm
		}
	}
	if len(scopes) == 0 {
		scopes = []string{"openid", "profile", "email"}
	}

	base := s.resolveRequestBaseURL(r)
	defaultCallback := base + "/auth/callback"
	redirectURI := ""
	if callbackPath == "" {
		if customRedirect != "" {
			redirectURI = customRedirect
		} else {
			redirectURI = defaultCallback
		}
	} else {
		redirectURI = base + callbackPath
	}
	c := &wimotekoauth.Client{
		Issuer:                issuer,
		ClientID:              clientID,
		ClientSecret:          clientSecret,
		RedirectURI:           redirectURI,
		Scopes:                scopes,
		AuthorizationEndpoint: authURL,
		TokenEndpoint:         tokenURL,
		UserinfoEndpoint:      userinfoURL,
	}
	configured := issuer != "" && clientID != "" && clientSecret != ""
	return c, configured, source, customRedirect, defaultCallback
}

func (s *Server) resolveDirectOAuthConfig(ctx context.Context, r *http.Request, provider string) resolvedDirectOAuth {
	p := strings.ToLower(strings.TrimSpace(provider))
	base := s.resolveRequestBaseURL(r)
	defaultCallback := fmt.Sprintf("%s/api/auth/oauth/%s/callback", base, p)
	out := resolvedDirectOAuth{
		Provider:           p,
		Label:              directProviderLabel(p),
		DefaultCallbackURL: defaultCallback,
		CallbackURL:        defaultCallback,
		Source:             "unconfigured",
	}
	if p == "microsoft" {
		out.TenantID = "common"
	}

	if saved, ok := s.loadStoredDirectOAuth(ctx, p); ok && (saved.ClientID != "" || saved.ClientSecretEnc != "" || saved.RedirectURI != "" || (p == "microsoft" && saved.TenantID != "")) {
		out.ClientID = strings.TrimSpace(saved.ClientID)
		out.ClientSecret = s.decryptOAuthSecret(ctx, saved.ClientSecretEnc)
		out.CustomRedirect = strings.TrimSpace(saved.RedirectURI)
		if p == "microsoft" {
			if t := strings.TrimSpace(saved.TenantID); t != "" {
				out.TenantID = t
			}
		}
		out.Source = "database"
	} else {
		prefix := "OAUTH_" + strings.ToUpper(p) + "_"
		out.ClientID = strings.TrimSpace(os.Getenv(prefix + "CLIENT_ID"))
		out.ClientSecret = strings.TrimSpace(os.Getenv(prefix + "CLIENT_SECRET"))
		out.CustomRedirect = strings.TrimSpace(os.Getenv(prefix + "REDIRECT_URI"))
		if p == "microsoft" {
			if t := strings.TrimSpace(os.Getenv("OAUTH_MICROSOFT_TENANT_ID")); t != "" {
				out.TenantID = t
			}
		}
		if out.ClientID != "" || out.ClientSecret != "" || out.CustomRedirect != "" {
			out.Source = "env"
		}
	}

	if out.CustomRedirect != "" {
		out.CallbackURL = out.CustomRedirect
	}
	out.Configured = out.ClientID != "" && out.ClientSecret != ""
	return out
}

func (s *Server) directProvidersPayload(ctx context.Context, r *http.Request) []map[string]any {
	order := []string{"microsoft", "github", "google"}
	res := make([]map[string]any, 0, len(order))
	for _, p := range order {
		cfg := s.resolveDirectOAuthConfig(ctx, r, p)
		item := map[string]any{
			"provider":             cfg.Provider,
			"label":                cfg.Label,
			"client_id":            cfg.ClientID,
			"has_client_secret":    cfg.ClientSecret != "",
			"client_secret_masked": maskOAuthSecret(cfg.ClientSecret),
			"redirect_uri":         cfg.CustomRedirect,
			"callback_url":         cfg.CallbackURL,
			"default_callback_url": cfg.DefaultCallbackURL,
			"configured":           cfg.Configured,
			"source":               cfg.Source,
		}
		if cfg.Provider == "microsoft" {
			item["tenant_id"] = cfg.TenantID
		}
		res = append(res, item)
	}
	return res
}

func (s *Server) oauthProvidersMeta(r *http.Request) []oauthProviderMeta {
	ctx := context.Background()
	if r != nil {
		ctx = r.Context()
	}
	c, configured, _, _, defaultCallback := s.wimotekOAuthClient(ctx, r, "")
	out := []oauthProviderMeta{
		{
			Provider:           "wimotek",
			Label:              "wimotek/OAuth (Unified IdP)",
			Configured:         configured,
			CallbackURL:        c.RedirectURI,
			DefaultCallbackURL: defaultCallback,
			Issuer:             c.Issuer,
		},
	}
	for _, p := range []string{"microsoft", "github", "google"} {
		cfg := s.resolveDirectOAuthConfig(ctx, r, p)
		out = append(out, oauthProviderMeta{
			Provider:           cfg.Provider,
			Label:              cfg.Label,
			Configured:         cfg.Configured,
			CallbackURL:        cfg.CallbackURL,
			DefaultCallbackURL: cfg.DefaultCallbackURL,
		})
	}
	return out
}

func (s *Server) registerOAuthGatewayRoutes() {
	s.mux.HandleFunc("GET /api/auth/oauth/providers", s.handleOAuthProviders)
	s.mux.HandleFunc("GET /api/auth/oauth/{provider}/url", s.handleOAuthURL)
	s.mux.HandleFunc("GET /api/auth/oauth/{provider}/callback", s.handleOAuthCallbackByProvider)
	s.mux.HandleFunc("GET /auth/callback", s.handleWimotekOAuthCallback)
	s.mux.HandleFunc("GET /login", s.handleWimotekOAuthDirectLogin)
	s.mux.HandleFunc("GET /logout", s.handleWimotekOAuthLogout)

	// Linked social account management for signed-in user
	s.mux.HandleFunc("DELETE /api/profile/social/{provider}", s.requireSession(s.handleUnlinkSocialAccount))

	// Admin-editable OAuth Gateway & Direct IdP configuration
	s.mux.HandleFunc("GET /api/admin/oauth/gateway", s.requireAdmin(s.handleGetOAuthGatewayConfig))
	s.mux.HandleFunc("PUT /api/admin/oauth/gateway", s.requireAdmin(s.handleSaveOAuthGatewayConfig))
	s.mux.HandleFunc("PUT /api/admin/oauth/providers/{provider}", s.requireAdmin(s.handleSaveDirectOAuthConfig))
}

func (s *Server) handleGetOAuthGatewayConfig(w http.ResponseWriter, r *http.Request, _ *auth.SessionInfo) {
	c, configured, source, customRedirect, defaultCallback := s.wimotekOAuthClient(r.Context(), r, "")
	writeJSON(w, http.StatusOK, map[string]any{
		"gateway": map[string]any{
			"issuer":                 c.Issuer,
			"client_id":              c.ClientID,
			"has_client_secret":      c.ClientSecret != "",
			"client_secret_masked":   maskOAuthSecret(c.ClientSecret),
			"redirect_uri":           customRedirect,
			"scopes":                 strings.Join(c.Scopes, " "),
			"authorization_endpoint": c.AuthorizationEndpoint,
			"token_endpoint":         c.TokenEndpoint,
			"userinfo_endpoint":      c.UserinfoEndpoint,
			"callback_url":           c.RedirectURI,
			"default_callback_url":   defaultCallback,
			"configured":             configured,
			"source":                 source,
		},
		"direct_providers": s.directProvidersPayload(r.Context(), r),
		"providers":        s.oauthProvidersMeta(r),
	})
}

func (s *Server) handleSaveOAuthGatewayConfig(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	var body struct {
		Issuer                string `json:"issuer"`
		ClientID              string `json:"client_id"`
		ClientSecret          string `json:"client_secret"`
		ClearSecret           bool   `json:"clear_secret"`
		RedirectURI           string `json:"redirect_uri"`
		Scopes                string `json:"scopes"`
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		TokenEndpoint         string `json:"token_endpoint"`
		UserinfoEndpoint      string `json:"userinfo_endpoint"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json payload")
		return
	}

	issuer := strings.TrimSpace(body.Issuer)
	if issuer != "" {
		norm, err := wimotekoauth.NormalizeIssuer(issuer)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		issuer = norm
	}

	redirectURI, err := validateOptionalHTTPURL(body.RedirectURI)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "redirect_uri: "+err.Error())
		return
	}
	authURL, err := validateOptionalHTTPURL(body.AuthorizationEndpoint)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "authorization_endpoint: "+err.Error())
		return
	}
	tokenURL, err := validateOptionalHTTPURL(body.TokenEndpoint)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "token_endpoint: "+err.Error())
		return
	}
	userinfoURL, err := validateOptionalHTTPURL(body.UserinfoEndpoint)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "userinfo_endpoint: "+err.Error())
		return
	}

	existing, _ := s.loadStoredOAuthGateway(r.Context())
	secretEnc := ""
	if body.ClearSecret {
		secretEnc = ""
	} else if trimmedSec := strings.TrimSpace(body.ClientSecret); trimmedSec != "" {
		enc, encErr := s.encryptOAuthSecret(r.Context(), trimmedSec)
		if encErr != nil {
			writeErr(w, http.StatusInternalServerError, "failed to encrypt client secret")
			return
		}
		secretEnc = enc
	} else if existing != nil {
		secretEnc = existing.ClientSecretEnc
	}

	scopes := strings.Fields(strings.ReplaceAll(strings.TrimSpace(body.Scopes), ",", " "))
	if len(scopes) == 0 {
		scopes = []string{"openid", "profile", "email"}
	}

	rec := storedOAuthGateway{
		Issuer:                issuer,
		ClientID:              strings.TrimSpace(body.ClientID),
		ClientSecretEnc:       secretEnc,
		RedirectURI:           redirectURI,
		Scopes:                scopes,
		AuthorizationEndpoint: authURL,
		TokenEndpoint:         tokenURL,
		UserinfoEndpoint:      userinfoURL,
		UpdatedAt:             time.Now().Unix(),
	}
	raw, _ := json.Marshal(rec)
	if err := s.store.SetSetting(r.Context(), oauthGatewaySettingKey, string(raw)); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		ID:         store.GenerateRandomID(8),
		Actor:      sess.Username,
		Action:     "oauth.gateway_update",
		ClientIP:   clientIP(r),
		DetailJSON: fmt.Sprintf(`{"issuer":%q,"client_id":%q,"redirect_uri":%q}`, rec.Issuer, rec.ClientID, rec.RedirectURI),
		CreatedAt:  time.Now().Unix(),
	})

	s.handleGetOAuthGatewayConfig(w, r, sess)
}

func (s *Server) handleSaveDirectOAuthConfig(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	provider := strings.ToLower(strings.TrimSpace(r.PathValue("provider")))
	if !isDirectOAuthProvider(provider) {
		writeErr(w, http.StatusBadRequest, "unsupported direct OAuth provider")
		return
	}

	var body struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
		ClearSecret  bool   `json:"clear_secret"`
		TenantID     string `json:"tenant_id"`
		RedirectURI  string `json:"redirect_uri"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json payload")
		return
	}

	redirectURI, err := validateOptionalHTTPURL(body.RedirectURI)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "redirect_uri: "+err.Error())
		return
	}

	tenantID := ""
	if provider == "microsoft" {
		tenantID = strings.TrimSpace(body.TenantID)
		if tenantID == "" {
			tenantID = "common"
		}
		if !validTenantRe.MatchString(tenantID) {
			writeErr(w, http.StatusBadRequest, "invalid tenant_id format")
			return
		}
	}

	existing, _ := s.loadStoredDirectOAuth(r.Context(), provider)
	secretEnc := ""
	if body.ClearSecret {
		secretEnc = ""
	} else if trimmedSec := strings.TrimSpace(body.ClientSecret); trimmedSec != "" {
		enc, encErr := s.encryptOAuthSecret(r.Context(), trimmedSec)
		if encErr != nil {
			writeErr(w, http.StatusInternalServerError, "failed to encrypt client secret")
			return
		}
		secretEnc = enc
	} else if existing != nil {
		secretEnc = existing.ClientSecretEnc
	}

	clientID := strings.TrimSpace(body.ClientID)
	// If cleared completely, reset stored entry so env fallback or clean unconfigured state applies
	rec := storedDirectOAuth{
		ClientID:        clientID,
		ClientSecretEnc: secretEnc,
		TenantID:        tenantID,
		RedirectURI:     redirectURI,
		UpdatedAt:       time.Now().Unix(),
	}
	if clientID == "" && secretEnc == "" && redirectURI == "" {
		rec.TenantID = ""
	}
	raw, _ := json.Marshal(rec)
	if err := s.store.SetSetting(r.Context(), directProviderSettingKey(provider), string(raw)); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		ID:         store.GenerateRandomID(8),
		Actor:      sess.Username,
		Action:     "oauth.provider_update",
		ClientIP:   clientIP(r),
		DetailJSON: fmt.Sprintf(`{"provider":%q,"client_id":%q,"redirect_uri":%q}`, provider, rec.ClientID, rec.RedirectURI),
		CreatedAt:  time.Now().Unix(),
	})

	s.handleGetOAuthGatewayConfig(w, r, sess)
}

func (s *Server) handleOAuthProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"providers": s.oauthProvidersMeta(r),
	})
}

func (s *Server) handleUnlinkSocialAccount(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	provider := strings.ToLower(strings.TrimSpace(r.PathValue("provider")))
	if !isValidOAuthProvider(provider) {
		writeErr(w, http.StatusBadRequest, "unsupported OAuth provider")
		return
	}
	if err := s.store.DeleteUserSocialAccount(r.Context(), sess.Username, provider); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		ID:         store.GenerateRandomID(8),
		Actor:      sess.Username,
		Action:     "profile.social_unbind",
		ClientIP:   clientIP(r),
		DetailJSON: fmt.Sprintf(`{"provider":%q}`, provider),
		CreatedAt:  time.Now().Unix(),
	})
	userRec, err := s.store.GetUser(r.Context(), sess.Username)
	if err != nil || userRec == nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"unlinked": true,
		"user":     userRec,
	})
}

func (s *Server) resolveBindActor(r *http.Request) (string, string, int, error) {
	if r.URL.Query().Get("mode") != "bind" {
		return "login", "", 0, nil
	}
	tok, _ := extractSessionToken(r)
	if tok == "" {
		return "bind", "", http.StatusUnauthorized, errors.New("sign in required to bind SSO account")
	}
	sess, err := s.auth.VerifySession(tok)
	if err != nil {
		return "bind", "", http.StatusUnauthorized, errors.New("invalid session")
	}
	return "bind", sess.Username, 0, nil
}

func (s *Server) handleOAuthURL(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(strings.TrimSpace(r.PathValue("provider")))
	if !isValidOAuthProvider(provider) {
		writeErr(w, http.StatusBadRequest, "unsupported OAuth provider")
		return
	}

	if provider == "wimotek" {
		s.handleWimotekOAuthURL(w, r)
		return
	}

	cfg := s.resolveDirectOAuthConfig(r.Context(), r, provider)
	if !cfg.Configured {
		writeJSON(w, http.StatusOK, map[string]any{
			"configured":   false,
			"callback_url": cfg.CallbackURL,
		})
		return
	}

	mode, actor, status, err := s.resolveBindActor(r)
	if err != nil {
		writeErr(w, status, err.Error())
		return
	}

	state := store.GenerateRandomID(24)
	payload, _ := json.Marshal(map[string]string{
		"state":        state,
		"provider":     provider,
		"mode":         mode,
		"actor":        actor,
		"redirect_uri": cfg.CallbackURL,
	})
	_ = s.cache.Set(r.Context(), "oauth:state:"+provider+":"+state, payload, 10*time.Minute)

	var authURL string
	switch provider {
	case "microsoft":
		q := url.Values{}
		q.Set("client_id", cfg.ClientID)
		q.Set("response_type", "code")
		q.Set("redirect_uri", cfg.CallbackURL)
		q.Set("response_mode", "query")
		q.Set("scope", "openid profile email User.Read")
		q.Set("state", state)
		authURL = fmt.Sprintf("https://login.microsoftonline.com/%s/oauth2/v2.0/authorize?%s", url.PathEscape(cfg.TenantID), q.Encode())
	case "github":
		q := url.Values{}
		q.Set("client_id", cfg.ClientID)
		q.Set("redirect_uri", cfg.CallbackURL)
		q.Set("scope", "read:user user:email")
		q.Set("state", state)
		authURL = "https://github.com/login/oauth/authorize?" + q.Encode()
	case "google":
		q := url.Values{}
		q.Set("client_id", cfg.ClientID)
		q.Set("redirect_uri", cfg.CallbackURL)
		q.Set("response_type", "code")
		q.Set("scope", "openid email profile")
		q.Set("access_type", "online")
		q.Set("state", state)
		authURL = "https://accounts.google.com/o/oauth2/v2/auth?" + q.Encode()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"configured":   true,
		"url":          authURL,
		"callback_url": cfg.CallbackURL,
	})
}

func (s *Server) handleWimotekOAuthURL(w http.ResponseWriter, r *http.Request) {
	client, configured, _, _, _ := s.wimotekOAuthClient(r.Context(), r, "")
	if !configured {
		writeJSON(w, http.StatusOK, map[string]any{
			"configured":   false,
			"callback_url": client.RedirectURI,
			"issuer":       client.Issuer,
		})
		return
	}
	mode, actor, status, err := s.resolveBindActor(r)
	if err != nil {
		writeErr(w, status, err.Error())
		return
	}
	loginURL, state, verifier := client.BuildLoginURLWithParams(r.Context(), "", "")
	payload, _ := json.Marshal(map[string]string{
		"state":        state,
		"verifier":     verifier,
		"mode":         mode,
		"actor":        actor,
		"redirect_uri": client.RedirectURI,
	})
	_ = s.cache.Set(r.Context(), "oauth:pkce:"+state, payload, 10*time.Minute)

	writeJSON(w, http.StatusOK, map[string]any{
		"configured":   true,
		"url":          loginURL,
		"callback_url": client.RedirectURI,
		"issuer":       client.Issuer,
		"pkce":         "S256",
	})
}

// handleWimotekOAuthDirectLogin mirrors the standard OIDC /login redirect handler (supports ?mode=local fallback).
func (s *Server) handleWimotekOAuthDirectLogin(w http.ResponseWriter, r *http.Request) {
	if strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("mode")), "local") {
		http.Redirect(w, r, "/?auth=local", http.StatusFound)
		return
	}
	client, configured, _, _, _ := s.wimotekOAuthClient(r.Context(), r, "")
	if !configured {
		http.Redirect(w, r, "/?auth=local", http.StatusFound)
		return
	}
	loginURL, state, verifier := client.BuildLoginURLWithParams(r.Context(), "", "")
	payload, _ := json.Marshal(map[string]string{
		"state":        state,
		"verifier":     verifier,
		"mode":         "login",
		"redirect_uri": client.RedirectURI,
	})
	_ = s.cache.Set(r.Context(), "oauth:pkce:"+state, payload, 10*time.Minute)
	secure := isRequestHTTPS(r)
	sameSite := http.SameSiteLaxMode
	if secure {
		sameSite = http.SameSiteNoneMode
	}
	http.SetCookie(w, &http.Cookie{Name: "oauth_state", Value: state, Path: "/", HttpOnly: true, Secure: secure, SameSite: sameSite, MaxAge: 300})
	http.SetCookie(w, &http.Cookie{Name: "oauth_verifier", Value: verifier, Path: "/", HttpOnly: true, Secure: secure, SameSite: sameSite, MaxAge: 300})
	http.Redirect(w, r, loginURL, http.StatusFound)
}

func (s *Server) handleWimotekOAuthLogout(w http.ResponseWriter, r *http.Request) {
	s.clearSessionCookie(w, r)
	base := s.resolveRequestBaseURL(r)
	if strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("local")), "1") {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	client, configured, _, _, _ := s.wimotekOAuthClient(r.Context(), r, "")
	if configured {
		logoutURL := client.BuildLogoutURL(r.Context(), base+"/")
		if logoutURL != "" {
			http.Redirect(w, r, logoutURL, http.StatusFound)
			return
		}
	}
	http.Redirect(w, r, "/", http.StatusFound)
}

func (s *Server) handleOAuthCallbackByProvider(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(strings.TrimSpace(r.PathValue("provider")))
	if provider == "wimotek" {
		s.handleWimotekOAuthCallback(w, r)
		return
	}
	if !isDirectOAuthProvider(provider) {
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "error": "unsupported OAuth provider"})
		return
	}
	s.handleDirectOAuthCallback(w, r, provider)
}

func (s *Server) handleWimotekOAuthCallback(w http.ResponseWriter, r *http.Request) {
	client, configured, _, _, _ := s.wimotekOAuthClient(r.Context(), r, "")
	if !configured {
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "error": "wimotek/OAuth is not configured"})
		return
	}
	if errParam := strings.TrimSpace(r.URL.Query().Get("error")); errParam != "" {
		desc := strings.TrimSpace(r.URL.Query().Get("error_description"))
		if desc == "" {
			desc = errParam
		}
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "error": desc})
		return
	}

	code := strings.TrimSpace(r.URL.Query().Get("code"))
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if code == "" || state == "" {
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "error": "missing OAuth code or state"})
		return
	}

	var expectedState, verifier, bindActor string
	mode := "login"

	if raw, hit, _ := s.cache.Get(r.Context(), "oauth:pkce:"+state); hit && len(raw) > 0 {
		_ = s.cache.Del(r.Context(), "oauth:pkce:"+state)
		var saved map[string]string
		if json.Unmarshal(raw, &saved) == nil {
			expectedState = saved["state"]
			verifier = saved["verifier"]
			if saved["mode"] != "" {
				mode = saved["mode"]
			}
			bindActor = strings.TrimSpace(saved["actor"])
			if saved["redirect_uri"] != "" {
				client.RedirectURI = saved["redirect_uri"]
			}
		}
	} else {
		sc, err1 := r.Cookie("oauth_state")
		vc, err2 := r.Cookie("oauth_verifier")
		if err1 == nil && err2 == nil {
			expectedState = sc.Value
			verifier = vc.Value
		}
	}

	// Clear transient cookies if present
	secure := isRequestHTTPS(r)
	sameSite := http.SameSiteLaxMode
	if secure {
		sameSite = http.SameSiteNoneMode
	}
	http.SetCookie(w, &http.Cookie{Name: "oauth_state", Value: "", Path: "/", HttpOnly: true, Secure: secure, SameSite: sameSite, MaxAge: -1})
	http.SetCookie(w, &http.Cookie{Name: "oauth_verifier", Value: "", Path: "/", HttpOnly: true, Secure: secure, SameSite: sameSite, MaxAge: -1})

	res, err := client.HandleCallback(r.Context(), code, state, expectedState, verifier)
	if err != nil {
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "mode": mode, "error": err.Error()})
		return
	}

	email := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", res.User["email"])))
	if email == "<nil>" {
		email = ""
	}
	emailVerified := false
	switch v := res.User["email_verified"].(type) {
	case bool:
		emailVerified = v
	case string:
		emailVerified = strings.EqualFold(strings.TrimSpace(v), "true")
	case float64:
		emailVerified = v == 1
	}
	displayName := strings.TrimSpace(fmt.Sprintf("%v", res.User["name"]))
	if displayName == "" || displayName == "<nil>" {
		displayName = email
	}
	preferredUser := strings.TrimSpace(fmt.Sprintf("%v", res.User["preferred_username"]))
	if preferredUser == "<nil>" {
		preferredUser = ""
	}
	sub := strings.TrimSpace(fmt.Sprintf("%v", res.User["sub"]))
	if sub == "<nil>" {
		sub = ""
	}
	if sub == "" {
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "mode": mode, "error": "OAuth provider returned no subject identifier"})
		return
	}

	s.completeOAuthIdentity(w, r, mode, bindActor, oauthIdentity{
		Provider:      "wimotek",
		ProviderID:    sub,
		Email:         email,
		EmailVerified: emailVerified,
		DisplayName:   displayName,
		PreferredUser: preferredUser,
	})
}

func (s *Server) handleDirectOAuthCallback(w http.ResponseWriter, r *http.Request, provider string) {
	cfg := s.resolveDirectOAuthConfig(r.Context(), r, provider)
	if !cfg.Configured {
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "error": fmt.Sprintf("%s OAuth is not configured", cfg.Label)})
		return
	}
	if errParam := strings.TrimSpace(r.URL.Query().Get("error")); errParam != "" {
		desc := strings.TrimSpace(r.URL.Query().Get("error_description"))
		if desc == "" {
			desc = errParam
		}
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "error": desc})
		return
	}

	code := strings.TrimSpace(r.URL.Query().Get("code"))
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if code == "" || state == "" {
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "error": "missing OAuth code or state"})
		return
	}

	cacheKey := "oauth:state:" + provider + ":" + state
	raw, hit, _ := s.cache.Get(r.Context(), cacheKey)
	if !hit || len(raw) == 0 {
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "error": "expired or invalid OAuth state"})
		return
	}
	_ = s.cache.Del(r.Context(), cacheKey)

	var saved map[string]string
	if err := json.Unmarshal(raw, &saved); err != nil || subtle.ConstantTimeCompare([]byte(state), []byte(saved["state"])) != 1 {
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "error": "mismatched OAuth state"})
		return
	}
	mode := saved["mode"]
	if mode == "" {
		mode = "login"
	}
	bindActor := strings.TrimSpace(saved["actor"])
	redirectURI := saved["redirect_uri"]
	if redirectURI == "" {
		redirectURI = cfg.CallbackURL
	}

	ident, err := exchangeDirectOAuth(r.Context(), cfg, code, redirectURI)
	if err != nil {
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "mode": mode, "error": err.Error()})
		return
	}

	s.completeOAuthIdentity(w, r, mode, bindActor, ident)
}

func formatOAuthNetError(stage string, err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if strings.Contains(msg, "no such host") || strings.Contains(msg, "127.0.0.11") {
		return fmt.Errorf("%s failed: %w (hint: Docker container DNS could not resolve the OAuth hostname; check container dns/extra_hosts or network egress)", stage, err)
	}
	return fmt.Errorf("%s failed: %w", stage, err)
}

func exchangeDirectOAuth(ctx context.Context, cfg resolvedDirectOAuth, code, redirectURI string) (oauthIdentity, error) {
	hc := &http.Client{Timeout: 12 * time.Second}
	ident := oauthIdentity{Provider: cfg.Provider}

	switch cfg.Provider {
	case "microsoft":
		form := url.Values{}
		form.Set("client_id", cfg.ClientID)
		form.Set("client_secret", cfg.ClientSecret)
		form.Set("code", code)
		form.Set("redirect_uri", redirectURI)
		form.Set("grant_type", "authorization_code")
		form.Set("scope", "openid profile email User.Read")

		tokenURL := fmt.Sprintf("https://login.microsoftonline.com/%s/oauth2/v2.0/token", url.PathEscape(cfg.TenantID))
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
		if err != nil {
			return ident, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Accept", "application/json")
		resp, err := hc.Do(req)
		if err != nil {
			return ident, formatOAuthNetError("Microsoft token exchange", err)
		}
		defer resp.Body.Close()
		var tok struct {
			AccessToken      string `json:"access_token"`
			Error            string `json:"error"`
			ErrorDescription string `json:"error_description"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&tok); err != nil {
			return ident, fmt.Errorf("failed to parse Microsoft token response: %w", err)
		}
		if resp.StatusCode >= 400 || tok.AccessToken == "" {
			if tok.ErrorDescription != "" {
				return ident, errors.New(tok.ErrorDescription)
			}
			if tok.Error != "" {
				return ident, errors.New(tok.Error)
			}
			return ident, fmt.Errorf("Microsoft token exchange HTTP %d", resp.StatusCode)
		}

		meReq, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://graph.microsoft.com/v1.0/me", nil)
		if err != nil {
			return ident, err
		}
		meReq.Header.Set("Authorization", "Bearer "+tok.AccessToken)
		meReq.Header.Set("Accept", "application/json")
		meResp, err := hc.Do(meReq)
		if err != nil {
			return ident, formatOAuthNetError("Microsoft Graph profile fetch", err)
		}
		defer meResp.Body.Close()
		var me struct {
			ID                string `json:"id"`
			Mail              string `json:"mail"`
			UserPrincipalName string `json:"userPrincipalName"`
			DisplayName       string `json:"displayName"`
		}
		if err := json.NewDecoder(io.LimitReader(meResp.Body, 64*1024)).Decode(&me); err != nil {
			return ident, fmt.Errorf("failed to parse Microsoft profile: %w", err)
		}
		if strings.TrimSpace(me.ID) == "" {
			return ident, errors.New("Microsoft Graph returned no user id")
		}
		email := strings.ToLower(strings.TrimSpace(me.Mail))
		if email == "" {
			email = strings.ToLower(strings.TrimSpace(me.UserPrincipalName))
		}
		ident.ProviderID = strings.TrimSpace(me.ID)
		ident.Email = email
		ident.EmailVerified = email != ""
		ident.DisplayName = strings.TrimSpace(me.DisplayName)
		if ident.DisplayName == "" {
			ident.DisplayName = email
		}
		return ident, nil

	case "github":
		form := url.Values{}
		form.Set("client_id", cfg.ClientID)
		form.Set("client_secret", cfg.ClientSecret)
		form.Set("code", code)
		form.Set("redirect_uri", redirectURI)

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://github.com/login/oauth/access_token", strings.NewReader(form.Encode()))
		if err != nil {
			return ident, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Accept", "application/json")
		resp, err := hc.Do(req)
		if err != nil {
			return ident, formatOAuthNetError("GitHub token exchange", err)
		}
		defer resp.Body.Close()
		var tok struct {
			AccessToken      string `json:"access_token"`
			Error            string `json:"error"`
			ErrorDescription string `json:"error_description"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&tok); err != nil {
			return ident, fmt.Errorf("failed to parse GitHub token response: %w", err)
		}
		if resp.StatusCode >= 400 || tok.AccessToken == "" {
			if tok.ErrorDescription != "" {
				return ident, errors.New(tok.ErrorDescription)
			}
			if tok.Error != "" {
				return ident, errors.New(tok.Error)
			}
			return ident, fmt.Errorf("GitHub token exchange HTTP %d", resp.StatusCode)
		}

		meReq, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user", nil)
		if err != nil {
			return ident, err
		}
		meReq.Header.Set("Authorization", "Bearer "+tok.AccessToken)
		meReq.Header.Set("Accept", "application/vnd.github+json")
		meReq.Header.Set("User-Agent", "wimotek-ca")
		meResp, err := hc.Do(meReq)
		if err != nil {
			return ident, formatOAuthNetError("GitHub profile fetch", err)
		}
		defer meResp.Body.Close()
		var gh struct {
			ID    int64  `json:"id"`
			Login string `json:"login"`
			Name  string `json:"name"`
			Email string `json:"email"`
		}
		if err := json.NewDecoder(io.LimitReader(meResp.Body, 64*1024)).Decode(&gh); err != nil {
			return ident, fmt.Errorf("failed to parse GitHub profile: %w", err)
		}
		if gh.ID == 0 {
			return ident, errors.New("GitHub returned no user id")
		}
		email := strings.ToLower(strings.TrimSpace(gh.Email))
		emailVerified := false
		// Fetch verified primary email from GitHub /user/emails
		emReq, emErr := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user/emails", nil)
		if emErr == nil {
			emReq.Header.Set("Authorization", "Bearer "+tok.AccessToken)
			emReq.Header.Set("Accept", "application/vnd.github+json")
			emReq.Header.Set("User-Agent", "wimotek-ca")
			if emResp, doErr := hc.Do(emReq); doErr == nil {
				defer emResp.Body.Close()
				if emResp.StatusCode == http.StatusOK {
					var emails []struct {
						Email    string `json:"email"`
						Primary  bool   `json:"primary"`
						Verified bool   `json:"verified"`
					}
					if json.NewDecoder(io.LimitReader(emResp.Body, 64*1024)).Decode(&emails) == nil {
						for _, item := range emails {
							if item.Primary && item.Verified && strings.TrimSpace(item.Email) != "" {
								email = strings.ToLower(strings.TrimSpace(item.Email))
								emailVerified = true
								break
							}
						}
						if !emailVerified {
							for _, item := range emails {
								if item.Verified && strings.TrimSpace(item.Email) != "" {
									email = strings.ToLower(strings.TrimSpace(item.Email))
									emailVerified = true
									break
								}
							}
						}
					}
				}
			}
		}
		ident.ProviderID = fmt.Sprintf("%d", gh.ID)
		ident.Email = email
		ident.EmailVerified = emailVerified
		ident.DisplayName = strings.TrimSpace(gh.Name)
		if ident.DisplayName == "" {
			ident.DisplayName = strings.TrimSpace(gh.Login)
		}
		ident.PreferredUser = strings.TrimSpace(gh.Login)
		return ident, nil

	case "google":
		form := url.Values{}
		form.Set("client_id", cfg.ClientID)
		form.Set("client_secret", cfg.ClientSecret)
		form.Set("code", code)
		form.Set("redirect_uri", redirectURI)
		form.Set("grant_type", "authorization_code")

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://oauth2.googleapis.com/token", strings.NewReader(form.Encode()))
		if err != nil {
			return ident, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Accept", "application/json")
		resp, err := hc.Do(req)
		if err != nil {
			return ident, formatOAuthNetError("Google token exchange", err)
		}
		defer resp.Body.Close()
		var tok struct {
			AccessToken      string `json:"access_token"`
			Error            string `json:"error"`
			ErrorDescription string `json:"error_description"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&tok); err != nil {
			return ident, fmt.Errorf("failed to parse Google token response: %w", err)
		}
		if resp.StatusCode >= 400 || tok.AccessToken == "" {
			if tok.ErrorDescription != "" {
				return ident, errors.New(tok.ErrorDescription)
			}
			if tok.Error != "" {
				return ident, errors.New(tok.Error)
			}
			return ident, fmt.Errorf("Google token exchange HTTP %d", resp.StatusCode)
		}

		meReq, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://openidconnect.googleapis.com/v1/userinfo", nil)
		if err != nil {
			return ident, err
		}
		meReq.Header.Set("Authorization", "Bearer "+tok.AccessToken)
		meReq.Header.Set("Accept", "application/json")
		meResp, err := hc.Do(meReq)
		if err != nil {
			return ident, formatOAuthNetError("Google userinfo fetch", err)
		}
		defer meResp.Body.Close()
		var g struct {
			Sub           string `json:"sub"`
			Email         string `json:"email"`
			EmailVerified bool   `json:"email_verified"`
			Name          string `json:"name"`
		}
		if err := json.NewDecoder(io.LimitReader(meResp.Body, 64*1024)).Decode(&g); err != nil {
			return ident, fmt.Errorf("failed to parse Google profile: %w", err)
		}
		if strings.TrimSpace(g.Sub) == "" {
			return ident, errors.New("Google returned no subject identifier")
		}
		ident.ProviderID = strings.TrimSpace(g.Sub)
		ident.Email = strings.ToLower(strings.TrimSpace(g.Email))
		ident.EmailVerified = g.EmailVerified
		ident.DisplayName = strings.TrimSpace(g.Name)
		if ident.DisplayName == "" {
			ident.DisplayName = ident.Email
		}
		return ident, nil
	}

	return ident, errors.New("unsupported OAuth provider")
}

func (s *Server) completeOAuthIdentity(w http.ResponseWriter, r *http.Request, mode, bindActor string, ident oauthIdentity) {
	now := time.Now().Unix()
	subHash := fmt.Sprintf("%x", sha256.Sum256([]byte(ident.Provider+":"+ident.ProviderID)))
	legacyWimotekKey := ""
	if ident.Provider == "wimotek" {
		wHash := fmt.Sprintf("%x", sha256.Sum256([]byte(ident.ProviderID)))
		legacyWimotekKey = "oauth:sub:wimotek:" + wHash[:32]
	}

	if mode == "bind" && bindActor != "" {
		actorRec, err := s.store.GetUser(r.Context(), bindActor)
		if err != nil || actorRec == nil {
			writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "mode": "bind", "error": "target user account not found"})
			return
		}
		if err := s.store.UpsertUserSocialAccount(r.Context(), store.SocialAccountRecord{
			Provider:    ident.Provider,
			ProviderID:  ident.ProviderID,
			Username:    actorRec.Username,
			Email:       ident.Email,
			DisplayName: ident.DisplayName,
			LinkedAt:    now,
		}); err != nil {
			writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "mode": "bind", "error": "failed to save linked SSO account"})
			return
		}
		if legacyWimotekKey != "" {
			_ = s.store.SetSetting(r.Context(), legacyWimotekKey, actorRec.Username)
		}
		_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
			ID:         store.GenerateRandomID(8),
			Actor:      actorRec.Username,
			Action:     "profile.social_bind",
			ClientIP:   clientIP(r),
			DetailJSON: fmt.Sprintf(`{"provider":%q,"email":%q}`, ident.Provider, ident.Email),
			CreatedAt:  now,
		})
		refreshed, _ := s.store.GetUser(r.Context(), actorRec.Username)
		if refreshed != nil {
			actorRec = refreshed
		}
		writeOAuthPopupHTML(w, map[string]any{
			"type":     "OAUTH_AUTH_SUCCESS",
			"mode":     "bind",
			"provider": ident.Provider,
			"user":     actorRec,
		})
		return
	}

	var userRec *store.UserRecord
	// 1. Primary mapping: user_social_accounts (provider, provider_id)
	if mappedUsername, err := s.store.FindUsernameBySocialAccount(r.Context(), ident.Provider, ident.ProviderID); err == nil && mappedUsername != "" {
		userRec, _ = s.store.GetUser(r.Context(), mappedUsername)
	}
	// 1b. Legacy wimotek sub mapping in system_settings
	if userRec == nil && legacyWimotekKey != "" {
		if mappedUsername, err := s.store.GetSetting(r.Context(), legacyWimotekKey); err == nil && strings.TrimSpace(mappedUsername) != "" {
			userRec, _ = s.store.GetUser(r.Context(), strings.TrimSpace(mappedUsername))
		}
	}

	// 2. Email linking: ONLY link by email when email_verified === true
	if userRec == nil && ident.Email != "" && ident.EmailVerified {
		if allUsers, err := s.store.ListUsers(r.Context()); err == nil {
			for i := range allUsers {
				if strings.EqualFold(strings.TrimSpace(allUsers[i].Email), ident.Email) {
					userRec, _ = s.store.GetUser(r.Context(), allUsers[i].Username)
					break
				}
			}
		}
	}

	if userRec == nil {
		baseUsername := strings.TrimSpace(ident.PreferredUser)
		if baseUsername == "" {
			if idx := strings.Index(ident.Email, "@"); idx > 0 {
				baseUsername = ident.Email[:idx]
			} else {
				baseUsername = "sso_" + subHash[:10]
			}
		}
		baseUsername = strings.ToLower(strings.Map(func(r rune) rune {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' || r == '.' {
				return r
			}
			return '_'
		}, baseUsername))
		if len(baseUsername) > 40 {
			baseUsername = baseUsername[:40]
		}
		if baseUsername == "" {
			baseUsername = "sso_" + subHash[:10]
		}
		username := baseUsername
		if existing, _ := s.store.GetUser(r.Context(), username); existing != nil {
			username = baseUsername + "_" + subHash[:6]
		}

		newUser := store.UserRecord{
			Username:  username,
			Role:      store.RoleStandard,
			CertQuota: store.DefaultQuotaForRole(store.RoleStandard),
			FullName:  ident.DisplayName,
			Email:     ident.Email,
			UPN:       ident.Email,
			Enabled:   true,
			CreatedAt: now,
			UpdatedAt: now,
		}
		_ = s.store.UpsertUser(r.Context(), newUser)
		userRec = &newUser
	}

	if !userRec.Enabled {
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "error": "account is disabled"})
		return
	}

	// Persist stable (provider, provider_id) -> username link
	_ = s.store.UpsertUserSocialAccount(r.Context(), store.SocialAccountRecord{
		Provider:    ident.Provider,
		ProviderID:  ident.ProviderID,
		Username:    userRec.Username,
		Email:       ident.Email,
		DisplayName: ident.DisplayName,
		LinkedAt:    now,
	})
	if legacyWimotekKey != "" {
		_ = s.store.SetSetting(r.Context(), legacyWimotekKey, userRec.Username)
	}
	if refreshed, err := s.store.GetUser(r.Context(), userRec.Username); err == nil && refreshed != nil {
		userRec = refreshed
	}

	token := s.auth.IssueSessionTokenWithRole(userRec.Username, userRec.Role)
	s.setSessionCookie(w, r, token)
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		ID:        store.GenerateRandomID(8),
		Actor:     userRec.Username,
		Action:    "auth.oauth_" + ident.Provider,
		ClientIP:  clientIP(r),
		CreatedAt: now,
	})

	writeOAuthPopupHTML(w, map[string]any{
		"type":     "OAUTH_AUTH_SUCCESS",
		"mode":     mode,
		"provider": ident.Provider,
		"token":    token,
		"username": userRec.Username,
		"role":     userRec.Role,
		"user":     userRec,
	})
}

func writeOAuthPopupHTML(w http.ResponseWriter, payload map[string]any) {
	raw, _ := json.Marshal(payload)
	safe := strings.ReplaceAll(string(raw), "<", `\u003c`)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = fmt.Fprintf(w, `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Wimotek CA OAuth</title></head>
<body style="font-family:system-ui,sans-serif;padding:24px;color:#0f172a;background:#f8fafc;">
<p>Authentication complete. Returning to Wimotek CA...</p>
<script>
(function(){
  var data = %s;
  if (window.opener) {
    window.opener.postMessage(data, window.location.origin);
    window.close();
  } else if (data && data.mode === 'bind') {
    if (data.type === 'OAUTH_AUTH_SUCCESS') {
      var prov = encodeURIComponent(String(data.provider || 'wimotek'));
      window.location.replace('/?oauth_linked=' + prov + '#oauth');
    } else {
      var bErr = encodeURIComponent(String((data && data.error) || 'oauth_bind_failed'));
      window.location.replace('/?oauth_bind_error=' + bErr + '#oauth');
    }
  } else if (data && data.type === 'OAUTH_AUTH_SUCCESS') {
    window.location.replace('/');
  } else {
    var msg = (data && data.error) ? encodeURIComponent(data.error) : 'oauth_failed';
    window.location.replace('/?oauth_error=' + msg);
  }
})();
</script>
</body></html>`, safe)
}
