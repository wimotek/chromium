package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/wimotek/ca/internal/store"
	"github.com/wimotek/ca/internal/wimotekoauth"
)

const defaultWimotekOAuthIssuer = "https://ais-dev-mjxg7khj3qsigvnmjpozen-587929382584.asia-northeast1.run.app"

type oauthProviderMeta struct {
	Provider    string `json:"provider"`
	Label       string `json:"label"`
	Configured  bool   `json:"configured"`
	CallbackURL string `json:"callback_url"`
	Issuer      string `json:"issuer,omitempty"`
}

func (s *Server) wimotekOAuthClient(callbackPath string) (*wimotekoauth.Client, bool) {
	issuer := strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_ISSUER"))
	if issuer == "" {
		issuer = defaultWimotekOAuthIssuer
	}
	if norm, err := wimotekoauth.NormalizeIssuer(issuer); err == nil {
		issuer = norm
	}
	clientID := strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_CLIENT_ID"))
	if clientID == "" {
		clientID = "wimotek_ca"
	}
	clientSecret := strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_CLIENT_SECRET"))
	if clientSecret == "" {
		clientSecret = strings.TrimSpace(os.Getenv("OAUTH_SECRET"))
	}
	rawScopes := strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_SCOPES"))
	if rawScopes == "" {
		rawScopes = "openid profile email"
	}
	scopes := strings.Fields(strings.ReplaceAll(rawScopes, ",", " "))
	base := strings.TrimRight(s.base, "/")
	if base == "" {
		base = "http://localhost:8443"
	}
	if callbackPath == "" {
		callbackPath = "/api/auth/oauth/wimotek/callback"
	}
	c := &wimotekoauth.Client{
		Issuer:                issuer,
		ClientID:              clientID,
		ClientSecret:          clientSecret,
		RedirectURI:           base + callbackPath,
		Scopes:                scopes,
		AuthorizationEndpoint: strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_AUTH_URL")),
		TokenEndpoint:         strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_TOKEN_URL")),
		UserinfoEndpoint:      strings.TrimSpace(os.Getenv("WIMOTEK_OAUTH_USERINFO_URL")),
	}
	return c, clientID != "" && clientSecret != ""
}

func (s *Server) oauthProvidersMeta() []oauthProviderMeta {
	c, configured := s.wimotekOAuthClient("/api/auth/oauth/wimotek/callback")
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
	s.mux.HandleFunc("GET /callback", s.handleWimotekOAuthCallback)
	s.mux.HandleFunc("GET /login", s.handleWimotekOAuthDirectLogin)
}

func (s *Server) handleOAuthProviders(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"providers": s.oauthProvidersMeta(),
	})
}

func (s *Server) handleWimotekOAuthURL(w http.ResponseWriter, r *http.Request) {
	client, configured := s.wimotekOAuthClient("/api/auth/oauth/wimotek/callback")
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
		"state":    state,
		"verifier": verifier,
		"mode":     mode,
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

// handleWimotekOAuthDirectLogin mirrors the standard Go wimotek/oauth /login redirect handler.
func (s *Server) handleWimotekOAuthDirectLogin(w http.ResponseWriter, r *http.Request) {
	client, configured := s.wimotekOAuthClient("/callback")
	if !configured {
		http.Error(w, "wimotek/OAuth gateway is not configured (set WIMOTEK_OAUTH_CLIENT_SECRET)", http.StatusServiceUnavailable)
		return
	}
	loginURL, state, verifier := client.BuildLoginURL()
	payload, _ := json.Marshal(map[string]string{
		"state":    state,
		"verifier": verifier,
		"mode":     "login",
	})
	_ = s.cache.Set(r.Context(), "oauth:pkce:"+state, payload, 10*time.Minute)
	http.SetCookie(w, &http.Cookie{Name: "oauth_state", Value: state, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteNoneMode, MaxAge: 300})
	http.SetCookie(w, &http.Cookie{Name: "oauth_verifier", Value: verifier, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteNoneMode, MaxAge: 300})
	http.Redirect(w, r, loginURL, http.StatusFound)
}

func (s *Server) handleWimotekOAuthCallback(w http.ResponseWriter, r *http.Request) {
	callbackPath := "/api/auth/oauth/wimotek/callback"
	if strings.HasPrefix(r.URL.Path, "/callback") {
		callbackPath = "/callback"
	}
	client, configured := s.wimotekOAuthClient(callbackPath)
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
		_ = s.cache.Delete(r.Context(), "oauth:pkce:"+state)
		var saved map[string]string
		if json.Unmarshal(raw, &saved) == nil {
			expectedState = saved["state"]
			verifier = saved["verifier"]
			if saved["mode"] != "" {
				mode = saved["mode"]
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
	http.SetCookie(w, &http.Cookie{Name: "oauth_state", Value: "", Path: "/", MaxAge: -1})
	http.SetCookie(w, &http.Cookie{Name: "oauth_verifier", Value: "", Path: "/", MaxAge: -1})

	res, err := client.HandleCallback(r.Context(), code, state, expectedState, verifier)
	if err != nil {
		writeOAuthPopupHTML(w, map[string]any{"type": "OAUTH_AUTH_ERROR", "error": err.Error()})
		return
	}

	email := strings.TrimSpace(fmt.Sprintf("%v", res.User["email"]))
	if email == "<nil>" {
		email = ""
	}
	displayName := strings.TrimSpace(fmt.Sprintf("%v", res.User["name"]))
	if displayName == "" || displayName == "<nil>" {
		displayName = email
	}
	sub := strings.TrimSpace(fmt.Sprintf("%v", res.User["sub"]))
	if sub == "<nil>" {
		sub = ""
	}
	username := strings.TrimSpace(fmt.Sprintf("%v", res.User["preferred_username"]))
	if username == "" || username == "<nil>" {
		if idx := strings.Index(email, "@"); idx > 0 {
			username = email[:idx]
		} else if sub != "" {
			username = "sso_" + sub
		} else {
			username = "sso_user"
		}
	}
	username = strings.ToLower(strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' || r == '.' {
			return r
		}
		return '_'
	}, username))
	if len(username) > 48 {
		username = username[:48]
	}

	userRec, _ := s.store.GetUser(r.Context(), username)
	now := time.Now().Unix()
	if userRec == nil {
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

	token := s.auth.IssueSessionTokenWithRole(userRec.Username, userRec.Role)
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
<p>Authentication complete. Returning to wimotek/ca...</p>
<script>
(function(){
  var data = %s;
  if (window.opener) {
    window.opener.postMessage(data, window.location.origin);
    window.close();
  }
})();
</script>
</body></html>`, safe)
}
