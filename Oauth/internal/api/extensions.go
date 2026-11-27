package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/wimotek/oauth/internal/providers"
)

type userAuthMethods struct {
	Password   bool `json:"password"`
	Passkey    bool `json:"passkey"`
	EmailOtp   bool `json:"emailOtp"`
	Totp       bool `json:"totp"`
	DeviceFlow bool `json:"deviceFlow"`
	Social     bool `json:"social"`
}

type backupSettings struct {
	Enabled       bool `json:"enabled"`
	RetentionDays int  `json:"retentionDays"`
	IntervalHours int  `json:"intervalHours"`
}

type backupRecord struct {
	ID        string `json:"id"`
	Filename  string `json:"filename"`
	Driver    string `json:"driver"`
	SizeBytes int64  `json:"sizeBytes"`
	CreatedAt string `json:"createdAt"`
	ExpiresAt string `json:"expiresAt"`
	Trigger   string `json:"trigger"` // "manual" | "scheduled"
}

func defaultUserAuthMethods() userAuthMethods {
	return userAuthMethods{
		Password:   true,
		Passkey:    true,
		EmailOtp:   true,
		Totp:       true,
		DeviceFlow: true,
		Social:     true,
	}
}

func defaultBackupSettings() backupSettings {
	return backupSettings{
		Enabled:       true,
		RetentionDays: 7,
		IntervalHours: 24,
	}
}

func (s *appServer) effectiveUserMethodsLocked(u identityUser) userAuthMethods {
	m := defaultUserAuthMethods()
	if u.AllowedMethods != nil {
		m = *u.AllowedMethods
	}
	if !s.policy.EnablePasswordArgon2id {
		m.Password = false
	}
	if !s.policy.EnablePasskeysWebAuthn {
		m.Passkey = false
	}
	if !s.policy.EnableEmailOtpMagicLink {
		m.EmailOtp = false
	}
	if !s.policy.EnableTotp2fa {
		m.Totp = false
	}
	if !s.policy.EnableDeviceFlowRfc8628 {
		m.DeviceFlow = false
	}
	return m
}

func countPrimaryMethods(m userAuthMethods) int {
	n := 0
	if m.Password {
		n++
	}
	if m.Passkey {
		n++
	}
	if m.EmailOtp {
		n++
	}
	if m.DeviceFlow {
		n++
	}
	if m.Social {
		n++
	}
	return n
}

func (s *appServer) loadExtensionSettingsLocked(ctx context.Context) {
	if s.repo == nil {
		return
	}
	// Load application locks
	if raw, ok, err := s.repo.GetSetting(ctx, "app_locks"); err == nil && ok && raw != "" {
		var locks map[string]bool
		if json.Unmarshal([]byte(raw), &locks) == nil {
			for i := range s.apps {
				if locked, exists := locks[s.apps[i].ID]; exists {
					s.apps[i].Locked = locked
				}
			}
		}
	}
	// Load per-user allowed methods
	if raw, ok, err := s.repo.GetSetting(ctx, "user_allowed_methods"); err == nil && ok && raw != "" {
		var mapMethods map[string]userAuthMethods
		if json.Unmarshal([]byte(raw), &mapMethods) == nil {
			for i := range s.users {
				if m, exists := mapMethods[s.users[i].ID]; exists {
					mc := m
					s.users[i].AllowedMethods = &mc
				}
			}
		}
	}
	// Ensure every user has initialized AllowedMethods
	for i := range s.users {
		if s.users[i].AllowedMethods == nil {
			m := defaultUserAuthMethods()
			s.users[i].AllowedMethods = &m
		}
	}
	// Load backup settings
	if raw, ok, err := s.repo.GetSetting(ctx, "backup_settings"); err == nil && ok && raw != "" {
		var bs backupSettings
		if json.Unmarshal([]byte(raw), &bs) == nil {
			if bs.RetentionDays < 1 {
				bs.RetentionDays = 7
			}
			if bs.RetentionDays > 365 {
				bs.RetentionDays = 365
			}
			if bs.IntervalHours < 1 {
				bs.IntervalHours = 24
			}
			s.backupCfg = bs
		}
	}
	s.loadAdminTokensLocked(ctx)
}

func (s *appServer) persistAppLocksLocked() {
	if s.repo == nil {
		return
	}
	locks := make(map[string]bool, len(s.apps))
	for _, a := range s.apps {
		if a.Locked {
			locks[a.ID] = true
		}
	}
	if raw, err := json.Marshal(locks); err == nil {
		_ = s.repo.SetSetting(context.Background(), "app_locks", string(raw))
	}
}

func (s *appServer) persistUserAllowedMethodsLocked() {
	if s.repo == nil {
		return
	}
	out := make(map[string]userAuthMethods, len(s.users))
	for _, u := range s.users {
		if u.AllowedMethods != nil {
			out[u.ID] = *u.AllowedMethods
		}
	}
	if raw, err := json.Marshal(out); err == nil {
		_ = s.repo.SetSetting(context.Background(), "user_allowed_methods", string(raw))
	}
}

func (s *appServer) persistBackupSettingsLocked() {
	if s.repo == nil {
		return
	}
	if raw, err := json.Marshal(s.backupCfg); err == nil {
		_ = s.repo.SetSetting(context.Background(), "backup_settings", string(raw))
	}
}

// ============================================================================
// Application Lock Endpoint
// ============================================================================

func (s *appServer) handleToggleAppLock(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimSpace(r.PathValue("id"))
	var body struct {
		Locked *bool `json:"locked"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.apps {
		if s.apps[i].ID == key || s.apps[i].ClientID == key {
			if body.Locked != nil {
				s.apps[i].Locked = *body.Locked
			} else {
				s.apps[i].Locked = !s.apps[i].Locked
			}
			s.persistAppLocksLocked()
			writeJSON(w, http.StatusOK, map[string]any{
				"ok":           true,
				"locked":       s.apps[i].Locked,
				"application":  s.apps[i],
				"applications": s.apps,
			})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found", "message": "Application not found"})
}

// ============================================================================
// Per-User Security Factors Endpoint (Enforces Admin Ceiling + Min 1 Factor)
// ============================================================================

func (s *appServer) handleUpdateUserFactors(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	var body struct {
		AllowedMethods userAuthMethods `json:"allowedMethods"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json", "message": "Invalid JSON payload"})
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	idx := -1
	for i := range s.users {
		if s.users[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found", "message": "User not found"})
		return
	}

	req := body.AllowedMethods
	// Enforce global admin policy ceiling: cannot enable a factor disabled by admin policy
	if req.Password && !s.policy.EnablePasswordArgon2id {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error":   "disabled_by_admin_policy",
			"message": "Password login is globally disabled by administrator Security Policy.",
		})
		return
	}
	if req.Passkey && !s.policy.EnablePasskeysWebAuthn {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error":   "disabled_by_admin_policy",
			"message": "Passkeys (WebAuthn) is globally disabled by administrator Security Policy.",
		})
		return
	}
	if req.EmailOtp && !s.policy.EnableEmailOtpMagicLink {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error":   "disabled_by_admin_policy",
			"message": "Email OTP / Magic Link is globally disabled by administrator Security Policy.",
		})
		return
	}
	if req.Totp && !s.policy.EnableTotp2fa {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error":   "disabled_by_admin_policy",
			"message": "TOTP 2FA is globally disabled by administrator Security Policy.",
		})
		return
	}
	if req.DeviceFlow && !s.policy.EnableDeviceFlowRfc8628 {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error":   "disabled_by_admin_policy",
			"message": "Device Flow (RFC 8628) is globally disabled by administrator Security Policy.",
		})
		return
	}

	// Enforce minimum 1 primary authentication method
	if countPrimaryMethods(req) < 1 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":   "min_one_method_required",
			"message": "At least one primary sign-in method (Password, Passkeys, Email OTP, Device Flow, or Social Login) must remain enabled.",
		})
		return
	}

	next := req
	s.users[idx].AllowedMethods = &next
	s.persistUserAllowedMethodsLocked()

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":    true,
		"user":  s.users[idx],
		"users": s.users,
	})
}

// ============================================================================
// Live Upstream Social Login (Start Redirect + OAuth Callback)
// ============================================================================

type socialOAuthState struct {
	ConnectorID string `json:"connectorId"`
	Provider    string `json:"provider"`
	RedirectTo  string `json:"redirectTo"`
	CreatedAt   int64  `json:"createdAt"`
}

func (s *appServer) findConnectorBySlugLocked(slug string) (*storedConnector, int) {
	norm := strings.ToLower(strings.TrimSpace(slug))
	for i := range s.connectors {
		if strings.ToLower(s.connectors[i].ID) == norm || strings.ToLower(s.connectors[i].Provider) == norm {
			return &s.connectors[i], i
		}
	}
	return nil, -1
}

func (s *appServer) connectorCallbackURI(r *http.Request, conn storedConnector) string {
	issuer := strings.TrimRight(s.getIssuer(r), "/")
	slug := conn.Provider
	if conn.Provider == "custom_oidc" {
		slug = conn.ID
	}
	return issuer + "/oauth/callback/" + url.PathEscape(slug)
}

func (s *appServer) handleSocialStart(w http.ResponseWriter, r *http.Request) {
	slug := strings.TrimSpace(r.PathValue("provider"))
	redirectTo := strings.TrimSpace(r.URL.Query().Get("redirect_to"))
	if redirectTo == "" || !strings.HasPrefix(redirectTo, "/") || strings.HasPrefix(redirectTo, "//") {
		redirectTo = "/"
	}

	s.mu.Lock()
	conn, _ := s.findConnectorBySlugLocked(slug)
	if conn == nil {
		s.mu.Unlock()
		http.Redirect(w, r, "/?auth_error="+url.QueryEscape("Social connector '"+slug+"' was not found."), http.StatusFound)
		return
	}
	if !conn.Enabled {
		s.mu.Unlock()
		http.Redirect(w, r, "/?auth_error="+url.QueryEscape(conn.DisplayName+" connector is currently disabled."), http.StatusFound)
		return
	}
	if strings.TrimSpace(conn.ClientID) == "" || strings.TrimSpace(conn.EncryptedSecret) == "" {
		s.mu.Unlock()
		http.Redirect(w, r, "/?auth_error="+url.QueryEscape("Configure "+conn.DisplayName+" Client ID and Client Secret in Social Connectors before signing in."), http.StatusFound)
		return
	}

	connCopy := *conn
	extraCopy := make(map[string]string, len(conn.Extra))
	for k, v := range conn.Extra {
		extraCopy[k] = v
	}
	connCopy.Extra = extraCopy

	state := "st_" + randomHex(18)
	stateBytes, _ := json.Marshal(socialOAuthState{
		ConnectorID: connCopy.ID,
		Provider:    connCopy.Provider,
		RedirectTo:  redirectTo,
		CreatedAt:   time.Now().UTC().Unix(),
	})
	s.cacheSetLocked("social_state:"+state, string(stateBytes), 10*time.Minute)
	s.mu.Unlock()

	reg := providers.NewDefaultRegistry()
	adapter, ok := reg.Get(connCopy.Provider)
	if !ok {
		http.Redirect(w, r, "/?auth_error="+url.QueryEscape("Unsupported social provider: "+connCopy.Provider), http.StatusFound)
		return
	}

	authURL, err := adapter.BuildAuthURL(providers.Config{
		ClientID:    connCopy.ClientID,
		RedirectURI: s.connectorCallbackURI(r, connCopy),
		Extra:       connCopy.Extra,
	}, state)
	if err != nil {
		http.Redirect(w, r, "/?auth_error="+url.QueryEscape(err.Error()), http.StatusFound)
		return
	}

	http.Redirect(w, r, authURL, http.StatusFound)
}

func (s *appServer) handleSocialCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		_ = r.ParseForm()
	}
	param := func(name string) string {
		if v := strings.TrimSpace(r.FormValue(name)); v != "" {
			return v
		}
		return strings.TrimSpace(r.URL.Query().Get(name))
	}

	if errCode := param("error"); errCode != "" {
		desc := param("error_description")
		msg := errCode
		if desc != "" {
			msg = errCode + ": " + desc
		}
		http.Redirect(w, r, "/?auth_error="+url.QueryEscape(msg), http.StatusFound)
		return
	}

	state := param("state")
	code := param("code")
	if state == "" || code == "" {
		http.Redirect(w, r, "/?auth_error="+url.QueryEscape("Upstream IdP callback missing code or state parameter."), http.StatusFound)
		return
	}

	s.mu.Lock()
	rawState, ok := s.cacheGetLocked("social_state:" + state)
	if ok {
		s.cacheDeleteLocked("social_state:" + state)
	}
	if !ok {
		s.mu.Unlock()
		http.Redirect(w, r, "/?auth_error="+url.QueryEscape("Social login state expired or already used. Please try again."), http.StatusFound)
		return
	}

	var st socialOAuthState
	if err := json.Unmarshal([]byte(rawState), &st); err != nil {
		s.mu.Unlock()
		http.Redirect(w, r, "/?auth_error="+url.QueryEscape("Invalid social login state."), http.StatusFound)
		return
	}

	conn, _ := s.findConnectorBySlugLocked(st.ConnectorID)
	if conn == nil {
		conn, _ = s.findConnectorBySlugLocked(st.Provider)
	}
	if conn == nil || !conn.Enabled {
		s.mu.Unlock()
		http.Redirect(w, r, "/?auth_error="+url.QueryEscape("Social connector is no longer enabled."), http.StatusFound)
		return
	}
	plainSecret, decErr := s.keys.DecryptSecret(conn.EncryptedSecret)
	if decErr != nil || strings.TrimSpace(plainSecret) == "" {
		s.mu.Unlock()
		http.Redirect(w, r, "/?auth_error="+url.QueryEscape("Unable to decrypt connector secret; please re-save credentials in Social Connectors."), http.StatusFound)
		return
	}
	connCopy := *conn
	extraCopy := make(map[string]string, len(conn.Extra))
	for k, v := range conn.Extra {
		extraCopy[k] = v
	}
	connCopy.Extra = extraCopy
	s.mu.Unlock()

	reg := providers.NewDefaultRegistry()
	adapter, ok := reg.Get(connCopy.Provider)
	if !ok {
		http.Redirect(w, r, "/?auth_error="+url.QueryEscape("No adapter registered for "+connCopy.Provider), http.StatusFound)
		return
	}

	profile, err := adapter.ExchangeCode(r.Context(), providers.Config{
		ClientID:     connCopy.ClientID,
		ClientSecret: plainSecret,
		RedirectURI:  s.connectorCallbackURI(r, connCopy),
		Extra:        connCopy.Extra,
	}, code)
	if err != nil {
		http.Redirect(w, r, "/?auth_error="+url.QueryEscape(err.Error()), http.StatusFound)
		return
	}

	s.mu.Lock()
	// Check if an existing user disabled Social Login in their personal security factors
	normEmail := strings.ToLower(strings.TrimSpace(profile.Email))
	for _, existing := range s.users {
		if strings.ToLower(existing.Email) == normEmail {
			if existing.Status != "active" {
				s.mu.Unlock()
				http.Redirect(w, r, "/?auth_error="+url.QueryEscape("This account has been suspended by an administrator."), http.StatusFound)
				return
			}
			eff := s.effectiveUserMethodsLocked(existing)
			if !eff.Social {
				s.mu.Unlock()
				http.Redirect(w, r, "/?auth_error="+url.QueryEscape("Social login has been disabled for this account's security factors."), http.StatusFound)
				return
			}
			break
		}
	}

	_, usr := s.resolveOrLinkIdentityLocked(
		connCopy.Provider,
		connCopy.DisplayName,
		profile.ProviderID,
		profile.Email,
		profile.Name,
		profile.EmailVerified,
	)
	if usr.Status != "active" {
		s.mu.Unlock()
		http.Redirect(w, r, "/?auth_error="+url.QueryEscape("This account has been suspended by an administrator."), http.StatusFound)
		return
	}
	role := usr.Role
	if role != "super_admin" {
		role = "member"
	}
	sessUser := authUser{
		Sub:      usr.ID,
		Email:    usr.Email,
		Name:     defaultStr(usr.DisplayName, usr.Email),
		Role:     role,
		Provider: connCopy.Provider,
	}
	tok := "wm_sess_" + randomHex(18)
	s.persistSessionLocked(tok, sessUser)
	s.mu.Unlock()

	s.setSessionCookie(w, r, tok)
	target := st.RedirectTo
	if target == "" || !strings.HasPrefix(target, "/") || strings.HasPrefix(target, "//") {
		target = "/"
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// ============================================================================
// Microsoft Entra ID Auto-Registration via Microsoft Graph API
// ============================================================================

func (s *appServer) handleAutoProvisionMicrosoft(w http.ResponseWriter, r *http.Request) {
	var body struct {
		GraphAccessToken string `json:"graphAccessToken"`
		DisplayName      string `json:"displayName"`
		TenantID         string `json:"tenantId"`
		SignInAudience   string `json:"signInAudience"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json", "message": "Invalid JSON payload"})
		return
	}
	token := strings.TrimSpace(body.GraphAccessToken)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimSpace(token)
	if len(token) < 20 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":   "missing_graph_token",
			"message": "Provide a valid Microsoft Graph access token with Application.ReadWrite.All scope.",
		})
		return
	}

	appDisplayName := strings.TrimSpace(body.DisplayName)
	if appDisplayName == "" {
		appDisplayName = "Wimotek OAuth SSO"
	}
	audience := strings.TrimSpace(body.SignInAudience)
	if audience == "" {
		audience = "AzureADandPersonalMicrosoftAccount"
	}
	tenant := strings.TrimSpace(body.TenantID)
	if tenant == "" {
		tenant = "common"
	}
	callbackURI := strings.TrimRight(s.getIssuer(r), "/") + "/oauth/callback/microsoft"

	httpClient := &http.Client{Timeout: 15 * time.Second}

	// Step 1: Create App Registration in Microsoft Entra ID
	createPayload, _ := json.Marshal(map[string]any{
		"displayName":    appDisplayName,
		"signInAudience": audience,
		"web": map[string]any{
			"redirectUris": []string{callbackURI},
		},
	})
	createReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, "https://graph.microsoft.com/v1.0/applications", bytes.NewReader(createPayload))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "request_error", "message": err.Error()})
		return
	}
	createReq.Header.Set("Authorization", "Bearer "+token)
	createReq.Header.Set("Content-Type", "application/json")
	createReq.Header.Set("Accept", "application/json")

	createResp, err := httpClient.Do(createReq)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "graph_unreachable", "message": "Could not reach Microsoft Graph API: " + err.Error()})
		return
	}
	defer createResp.Body.Close()
	createRaw, _ := io.ReadAll(io.LimitReader(createResp.Body, 262144))

	if createResp.StatusCode < 200 || createResp.StatusCode >= 300 {
		var errDoc struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(createRaw, &errDoc)
		msg := errDoc.Error.Message
		if msg == "" {
			msg = fmt.Sprintf("Microsoft Graph returned HTTP %d when creating App Registration.", createResp.StatusCode)
		}
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "graph_create_failed", "message": msg})
		return
	}

	var createdApp struct {
		ID    string `json:"id"`
		AppID string `json:"appId"`
	}
	if err := json.Unmarshal(createRaw, &createdApp); err != nil || createdApp.ID == "" || createdApp.AppID == "" {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "graph_invalid_response", "message": "Microsoft Graph response missing application id/appId."})
		return
	}

	// Step 2: Generate Client Secret via /addPassword
	secretPayload, _ := json.Marshal(map[string]any{
		"passwordCredential": map[string]any{
			"displayName": "Wimotek OAuth Auto-Provisioned Secret",
			"endDateTime": time.Now().UTC().AddDate(2, 0, 0).Format(time.RFC3339),
		},
	})
	secURL := fmt.Sprintf("https://graph.microsoft.com/v1.0/applications/%s/addPassword", url.PathEscape(createdApp.ID))
	secReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, secURL, bytes.NewReader(secretPayload))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "request_error", "message": err.Error()})
		return
	}
	secReq.Header.Set("Authorization", "Bearer "+token)
	secReq.Header.Set("Content-Type", "application/json")
	secReq.Header.Set("Accept", "application/json")

	secResp, err := httpClient.Do(secReq)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "graph_secret_unreachable", "message": "App registered (" + createdApp.AppID + ") but failed to add client secret: " + err.Error()})
		return
	}
	defer secResp.Body.Close()
	secRaw, _ := io.ReadAll(io.LimitReader(secResp.Body, 131072))

	if secResp.StatusCode < 200 || secResp.StatusCode >= 300 {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error":   "graph_secret_failed",
			"message": fmt.Sprintf("App registered (appId=%s), but addPassword failed with HTTP %d.", createdApp.AppID, secResp.StatusCode),
		})
		return
	}

	var pwdResp struct {
		SecretText string `json:"secretText"`
	}
	if err := json.Unmarshal(secRaw, &pwdResp); err != nil || strings.TrimSpace(pwdResp.SecretText) == "" {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "graph_secret_empty", "message": "Microsoft Graph addPassword response did not contain secretText."})
		return
	}

	// Step 3: Encrypt secret & save directly into Microsoft connector
	encSecret, _ := s.keys.EncryptSecret(pwdResp.SecretText)
	masked := maskSecret(pwdResp.SecretText)

	s.mu.Lock()
	for i := range s.connectors {
		if s.connectors[i].Provider == "microsoft" {
			s.connectors[i].Enabled = true
			s.connectors[i].ClientID = createdApp.AppID
			s.connectors[i].EncryptedSecret = encSecret
			s.connectors[i].SecretPreview = masked
			if s.connectors[i].Extra == nil {
				s.connectors[i].Extra = map[string]string{}
			}
			s.connectors[i].Extra["tenant_id"] = tenant
			s.connectors[i].UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			s.persistConnectorLocked(s.connectors[i], i)
			break
		}
	}
	conns := s.serializeConnectorsLocked()
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"appId":       createdApp.AppID,
		"objectId":    createdApp.ID,
		"tenantId":    tenant,
		"callbackUri": callbackURI,
		"connectors":  conns,
	})
}

// ============================================================================
// Database Backup & Configurable Retention (Default 7 Days)
// ============================================================================

var safeBackupFilenameRe = regexp.MustCompile(`^[a-zA-Z0-9._-]+\.(db|json)$`)

func (s *appServer) backupDirectory() string {
	cfg := s.cfgMgr.Get()
	if cfg.Database.Driver == "sqlite3" && strings.TrimSpace(cfg.Database.DSN) != "" && cfg.Database.DSN != ":memory:" {
		clean := strings.Split(cfg.Database.DSN, "?")[0]
		dir := filepath.Dir(clean)
		if dir != "" && dir != "." {
			return filepath.Join(dir, "backups")
		}
	}
	return filepath.Join(".", "data", "backups")
}

func (s *appServer) listBackupFilesLocked() []backupRecord {
	dir := s.backupDirectory()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []backupRecord{}
	}
	retDays := s.backupCfg.RetentionDays
	if retDays < 1 {
		retDays = 7
	}
	out := make([]backupRecord, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !safeBackupFilenameRe.MatchString(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		created := info.ModTime().UTC()
		trigger := "manual"
		if strings.Contains(entry.Name(), "_auto_") {
			trigger = "scheduled"
		}
		driver := "sqlite3"
		if strings.HasSuffix(entry.Name(), ".json") {
			driver = s.cfgMgr.Get().Database.Driver
			if driver == "" {
				driver = "json"
			}
		}
		out = append(out, backupRecord{
			ID:        entry.Name(),
			Filename:  entry.Name(),
			Driver:    driver,
			SizeBytes: info.Size(),
			CreatedAt: created.Format(time.RFC3339),
			ExpiresAt: created.AddDate(0, 0, retDays).Format(time.RFC3339),
			Trigger:   trigger,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt > out[j].CreatedAt
	})
	return out
}

func (s *appServer) pruneExpiredBackupsLocked() int {
	dir := s.backupDirectory()
	retDays := s.backupCfg.RetentionDays
	if retDays < 1 {
		retDays = 7
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -retDays)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	removed := 0
	for _, entry := range entries {
		if entry.IsDir() || !safeBackupFilenameRe.MatchString(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if info.ModTime().UTC().Before(cutoff) {
			if os.Remove(filepath.Join(dir, entry.Name())) == nil {
				removed++
			}
		}
	}
	return removed
}

func (s *appServer) createBackupSnapshotLocked(trigger string) (*backupRecord, error) {
	dir := s.backupDirectory()
	if err := os.MkdirAll(dir, 0750); err != nil {
		return nil, err
	}
	if trigger != "scheduled" {
		trigger = "manual"
	}
	tag := "manual"
	if trigger == "scheduled" {
		tag = "auto"
	}
	stamp := time.Now().UTC().Format("20060102_150405")
	cfg := s.cfgMgr.Get()

	var filename string
	var fullPath string

	if s.repo != nil && s.repo.Driver() == "sqlite3" {
		filename = fmt.Sprintf("wimotek_backup_%s_%s.db", tag, stamp)
		fullPath = filepath.Join(dir, filename)
		escaped := strings.ReplaceAll(fullPath, "'", "''")
		if _, err := s.repo.DB().ExecContext(context.Background(), fmt.Sprintf("VACUUM INTO '%s'", escaped)); err != nil {
			// Fallback to JSON logical snapshot if VACUUM INTO fails
			filename = fmt.Sprintf("wimotek_backup_%s_%s.json", tag, stamp)
			fullPath = filepath.Join(dir, filename)
			if writeErr := s.writeJSONBackupSnapshotLocked(fullPath); writeErr != nil {
				return nil, writeErr
			}
		}
	} else {
		filename = fmt.Sprintf("wimotek_backup_%s_%s.json", tag, stamp)
		fullPath = filepath.Join(dir, filename)
		if err := s.writeJSONBackupSnapshotLocked(fullPath); err != nil {
			return nil, err
		}
	}

	_ = s.pruneExpiredBackupsLocked()
	info, err := os.Stat(fullPath)
	if err != nil {
		return nil, err
	}
	created := info.ModTime().UTC()
	retDays := s.backupCfg.RetentionDays
	if retDays < 1 {
		retDays = 7
	}
	return &backupRecord{
		ID:        filename,
		Filename:  filename,
		Driver:    defaultStr(cfg.Database.Driver, "sqlite3"),
		SizeBytes: info.Size(),
		CreatedAt: created.Format(time.RFC3339),
		ExpiresAt: created.AddDate(0, 0, retDays).Format(time.RFC3339),
		Trigger:   trigger,
	}, nil
}

func (s *appServer) writeJSONBackupSnapshotLocked(fullPath string) error {
	snapshot := map[string]any{
		"format":       "wimotek_oauth_snapshot_v1",
		"createdAt":    time.Now().UTC().Format(time.RFC3339),
		"dbDriver":     s.cfgMgr.Get().Database.Driver,
		"policy":       s.policy,
		"applications": s.apps,
		"connectors":   s.serializeConnectorsLocked(),
		"users":        s.users,
		"passkeys":     s.serializePasskeysLocked(""),
		"webhooks":     s.serializeWebhooksLocked(),
	}
	raw, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(fullPath, raw, 0600)
}

func (s *appServer) startBackupScheduler(stopCh <-chan struct{}) {
	ticker := time.NewTicker(1 * time.Hour)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-stopCh:
				return
			case <-ticker.C:
				s.mu.Lock()
				if s.backupCfg.Enabled && s.cfgMgr.Get().Initialized {
					_ = s.pruneExpiredBackupsLocked()
					existing := s.listBackupFilesLocked()
					needBackup := len(existing) == 0
					if !needBackup {
						if latest, err := time.Parse(time.RFC3339, existing[0].CreatedAt); err == nil {
							interval := s.backupCfg.IntervalHours
							if interval < 1 {
								interval = 24
							}
							if time.Since(latest) >= time.Duration(interval)*time.Hour {
								needBackup = true
							}
						}
					}
					if needBackup {
						_, _ = s.createBackupSnapshotLocked("scheduled")
					}
				}
				s.mu.Unlock()
			}
		}
	}()
}

func (s *appServer) handleListBackups(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.pruneExpiredBackupsLocked()
	writeJSON(w, http.StatusOK, map[string]any{
		"settings":  s.backupCfg,
		"backups":   s.listBackupFilesLocked(),
		"backupDir": s.backupDirectory(),
	})
}

func (s *appServer) handleUpdateBackupSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled       *bool `json:"enabled"`
		RetentionDays *int  `json:"retentionDays"`
		IntervalHours *int  `json:"intervalHours"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json", "message": "Invalid JSON payload"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if body.Enabled != nil {
		s.backupCfg.Enabled = *body.Enabled
	}
	if body.RetentionDays != nil {
		d := *body.RetentionDays
		if d < 1 || d > 365 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_retention_days", "message": "Backup retention days must be between 1 and 365."})
			return
		}
		s.backupCfg.RetentionDays = d
	}
	if body.IntervalHours != nil {
		h := *body.IntervalHours
		if h < 1 {
			h = 1
		}
		if h > 168 {
			h = 168
		}
		s.backupCfg.IntervalHours = h
	}
	s.persistBackupSettingsLocked()
	pruned := s.pruneExpiredBackupsLocked()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"settings": s.backupCfg,
		"pruned":   pruned,
		"backups":  s.listBackupFilesLocked(),
	})
}

func (s *appServer) handleCreateBackupNow(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, err := s.createBackupSnapshotLocked("manual")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "backup_failed", "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"ok":      true,
		"backup":  rec,
		"backups": s.listBackupFilesLocked(),
	})
}

func (s *appServer) handleDownloadBackup(w http.ResponseWriter, r *http.Request) {
	id := filepath.Base(strings.TrimSpace(r.PathValue("id")))
	if !safeBackupFilenameRe.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_backup_id"})
		return
	}
	fullPath := filepath.Join(s.backupDirectory(), id)
	data, err := os.ReadFile(fullPath)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found", "message": "Backup file not found."})
		return
	}
	if strings.HasSuffix(id, ".json") {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, id))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *appServer) handleDeleteBackup(w http.ResponseWriter, r *http.Request) {
	id := filepath.Base(strings.TrimSpace(r.PathValue("id")))
	if !safeBackupFilenameRe.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_backup_id"})
		return
	}
	fullPath := filepath.Join(s.backupDirectory(), id)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(fullPath); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found", "message": "Backup file not found."})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"deleted": id,
		"backups": s.listBackupFilesLocked(),
	})
}
