package api

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
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

type storedOAuthGateway struct {
	Issuer                string   `json:"issuer"`
	ClientID              string   `json:"client_id"`
	ClientSecretEnc       string   `json:"client_secret_enc,omitempty"`
	Scopes                []string `json:"scopes,omitempty"`
	AuthorizationEndpoint string   `json:"authorization_endpoint,omitempty"`
	TokenEndpoint         string   `json:"token_endpoint,omitempty"`
	UserinfoEndpoint      string   `json:"userinfo_endpoint,omitempty"`
	UpdatedAt             int64    `json:"updated_at,omitempty"`
}

type oauthProviderMeta struct {
	Provider    string `json:"provider"`
	Label       string `json:"label"`
	Configured  bool   `json:"configured"`
	CallbackURL string `json:"callback_url"`
	Issuer      string `json:"issuer,omitempty"`
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

func (s *Server) wimotekOAuthClient(ctx context.Context, callbackPath string) (*wimotekoauth.Client, bool, string) {
	var (
		issuer       string
		clientID     string
		clientSecret string
		scopes       []string
		authURL      string
		tokenURL     string
		userinfoURL  string
		source       = "unconfigured"
	)

	if saved, ok := s.loadStoredOAuthGateway(ctx); ok && (saved.Issuer != "" || saved.ClientID != "" || saved.ClientSecretEnc != "") {
		issuer = strings.TrimSpace(saved.Issuer)
		clientID = strings.TrimSpace(saved.ClientID)
		clientSecret = s.decryptOAuthSecret(ctx, saved.ClientSecretEnc)
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
		rawScopes := strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_SCOPES"))
		if rawScopes != "" {
			scopes = strings.Fields(strings.ReplaceAll(rawScopes, ",", " "))
		}
		authURL = strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_AUTH_URL"))
		tokenURL = strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_TOKEN_URL"))
		userinfoURL = strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_USERINFO_URL"))
		if issuer != "" || clientID != "" || clientSecret != "" {
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

	base := strings.TrimRight(s.base, "/")
	if base == "" {
		base = "http://localhost:8443"
	}
	redirectURI := ""
	if callbackPath == "" {
		if envRedirect := strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_REDIRECT_URI")); envRedirect != "" {
			redirectURI = envRedirect
		} else {
			callbackPath = "/auth/callback"
		}
	}
	if redirectURI == "" {
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
	return c, configured, source
}

func (s *Server) oauthProvidersMeta(ctx context.Context) []oauthProviderMeta {
	c, configured, _ := s.wimotekOAuthClient(ctx, "/api/auth/oauth/wimotek/callback")
	return []oauthProviderMeta{
		{
			Provider:    "wimotek",
			Label:       "wimotek/OAuth (Unified IdP)",
			Configured:  configured,
			CallbackURL: c.RedirectURI,
			Issuer:      c.Issuer,
		},
	}
}

func (s *Server) registerOAuthGatewayRoutes() {
	s.mux.HandleFunc("GET /api/auth/oauth/providers", s.handleOAuthProviders)
	s.mux.HandleFunc("GET /api/auth/oauth/wimotek/url", s.handleWimotekOAuthURL)
	s.mux.HandleFunc("GET /api/auth/oauth/wimotek/callback", s.handleWimotekOAuthCallback)
	s.mux.HandleFunc("GET /auth/callback", s.handleWimotekOAuthCallback)
	s.mux.HandleFunc("GET /callback", s.handleWimotekOAuthCallback)
	s.mux.HandleFunc("GET /login", s.handleWimotekOAuthDirectLogin)
	s.mux.HandleFunc("GET /logout", s.handleWimotekOAuthLogout)

	// Admin-editable wimotek/OAuth Gateway configuration
	s.mux.HandleFunc("GET /api/admin/oauth/gateway", s.requireAdmin(s.handleGetOAuthGatewayConfig))
	s.mux.HandleFunc("PUT /api/admin/oauth/gateway", s.requireAdmin(s.handleSaveOAuthGatewayConfig))
}

func (s *Server) handleGetOAuthGatewayConfig(w http.ResponseWriter, r *http.Request, _ *auth.SessionInfo) {
	c, configured, source := s.wimotekOAuthClient(r.Context(), "/api/auth/oauth/wimotek/callback")
	base := strings.TrimRight(s.base, "/")
	if base == "" {
		base = "http://localhost:8443"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"gateway": map[string]any{
			"issuer":                 c.Issuer,
			"client_id":              c.ClientID,
			"has_client_secret":      c.ClientSecret != "",
			"client_secret_masked":   maskOAuthSecret(c.ClientSecret),
			"scopes":                 strings.Join(c.Scopes, " "),
			"authorization_endpoint": c.AuthorizationEndpoint,
			"token_endpoint":         c.TokenEndpoint,
			"userinfo_endpoint":      c.UserinfoEndpoint,
			"callback_url":           base + "/auth/callback",
			"alias_callback_url":     base + "/api/auth/oauth/wimotek/callback",
			"configured":             configured,
			"source":                 source,
		},
	})
}

func (s *Server) handleSaveOAuthGatewayConfig(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	var body struct {
		Issuer                string `json:"issuer"`
		ClientID              string `json:"client_id"`
		ClientSecret          string `json:"client_secret"`
		ClearSecret           bool   `json:"clear_secret"`
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
		DetailJSON: fmt.Sprintf(`{"issuer":%q,"client_id":%q}`, rec.Issuer, rec.ClientID),
		CreatedAt:  time.Now().Unix(),
	})

	s.handleGetOAuthGatewayConfig(w, r, sess)
}

func (s *Server) handleOAuthProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"providers": s.oauthProvidersMeta(r.Context()),
	})
}

func (s *Server) handleWimotekOAuthURL(w http.ResponseWriter, r *http.Request) {
	callbackPath := "/auth/callback"
	if strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_REDIRECT_URI")) != "" {
		callbackPath = ""
	}
	client, configured, _ := s.wimotekOAuthClient(r.Context(), callbackPath)
	if !configured {
		writeJSON(w, http.StatusOK, map[string]any{
			"configured":   false,
			"callback_url": client.RedirectURI,
			"issuer":       client.Issuer,
		})
		return
	}
	mode := "login"
	if r.URL.Query().Get("mode") == "bind" {
		mode = "bind"
	}
	loginURL, state, verifier := client.BuildLoginURL()
	payload, _ := json.Marshal(map[string]string{
		"state":        state,
		"verifier":     verifier,
		"mode":         mode,
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
	callbackPath := "/auth/callback"
	if strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_REDIRECT_URI")) != "" {
		callbackPath = ""
	}
	client, configured, _ := s.wimotekOAuthClient(r.Context(), callbackPath)
	if !configured {
		http.Redirect(w, r, "/?auth=local", http.StatusFound)
		return
	}
	loginURL, state, verifier := client.BuildLoginURL()
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
	base := strings.TrimRight(s.base, "/")
	if base == "" {
		base = "/"
	}
	if strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("local")), "1") {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	client, configured, _ := s.wimotekOAuthClient(r.Context(), "/auth/callback")
	if configured {
		logoutURL := client.BuildLogoutURL(r.Context(), base+"/")
		if logoutURL != "" {
			http.Redirect(w, r, logoutURL, http.StatusFound)
			return
		}
	}
	http.Redirect(w, r, "/", http.StatusFound)
}

func (s *Server) handleWimotekOAuthCallback(w http.ResponseWriter, r *http.Request) {
	callbackPath := "/auth/callback"
	if strings.HasPrefix(r.URL.Path, "/callback") {
		callbackPath = "/callback"
	} else if strings.HasPrefix(r.URL.Path, "/api/auth/oauth/wimotek/callback") {
		callbackPath = "/api/auth/oauth/wimotek/callback"
	}
	client, configured, _ := s.wimotekOAuthClient(r.Context(), callbackPath)
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

	var expectedState, verifier string
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
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "error": err.Error()})
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
	sub := strings.TrimSpace(fmt.Sprintf("%v", res.User["sub"]))
	if sub == "<nil>" {
		sub = ""
	}
	if sub == "" {
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "error": "OAuth provider returned no subject identifier"})
		return
	}

	subHash := fmt.Sprintf("%x", sha256.Sum256([]byte(sub)))
	subKey := "oauth:sub:wimotek:" + subHash[:32]

	var userRec *store.UserRecord
	// 1. Primary mapping: resolve by stable OIDC `sub`
	if mappedUsername, err := s.store.GetSetting(r.Context(), subKey); err == nil && strings.TrimSpace(mappedUsername) != "" {
		userRec, _ = s.store.GetUser(r.Context(), strings.TrimSpace(mappedUsername))
	}

	// 2. Legacy account linking: ONLY link by email when email_verified === true
	if userRec == nil && email != "" && emailVerified {
		if allUsers, err := s.store.ListUsers(r.Context()); err == nil {
			for i := range allUsers {
				if strings.EqualFold(strings.TrimSpace(allUsers[i].Email), email) {
					u := allUsers[i]
					userRec = &u
					break
				}
			}
		}
	}

	now := time.Now().Unix()
	if userRec == nil {
		baseUsername := strings.TrimSpace(fmt.Sprintf("%v", res.User["preferred_username"]))
		if baseUsername == "" || baseUsername == "<nil>" {
			if idx := strings.Index(email, "@"); idx > 0 {
				baseUsername = email[:idx]
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
			FullName:  displayName,
			Email:     email,
			UPN:       email,
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

	// Persist stable sub -> username link
	_ = s.store.SetSetting(r.Context(), subKey, userRec.Username)

	token := s.auth.IssueSessionTokenWithRole(userRec.Username, userRec.Role)
	s.setSessionCookie(w, r, token)
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:     userRec.Username,
		Action:    "auth.oauth_wimotek",
		ClientIP:  clientIP(r),
		CreatedAt: now,
	})

	writeOAuthPopupHTML(w, map[string]any{
		"type":     "OAUTH_AUTH_SUCCESS",
		"mode":     mode,
		"provider": "wimotek",
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
<html lang="en"><head><meta charset="utf-8"><title>wimotek/OAuth</title></head>
<body style="font-family:system-ui,sans-serif;padding:24px;color:#0f172a;background:#f8fafc;">
<p>Authentication complete. Returning to Wimotek CA...</p>
<script>
(function(){
  var data = %s;
  if (window.opener) {
    window.opener.postMessage(data, window.location.origin);
    window.close();
  } else if (data && data.type === 'OAUTH_AUTH_SUCCESS') {
    window.location.replace('/');
  } else {
    var msg = (data && data.error) ? encodeURIComponent(data.error) : 'oauth_failed';
    window.location.replace('/?auth=local&oauth_error=' + msg);
  }
})();
</script>
</body></html>`, safe)
}
