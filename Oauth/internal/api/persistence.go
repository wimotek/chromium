package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/wimotek/oauth/internal/auth"
	"github.com/wimotek/oauth/internal/store"
)

const adminSessionCookieName = "wimotek_admin_session"

type storedPasskey struct {
	ID            string
	UserID        string
	CredentialID  string
	PublicKeySPKI string
	Algorithm     int
	Label         string
	RPID          string
	SignCount     uint32
	CreatedAt     string
	LastUsedAt    string
}

type passkeyDTO struct {
	ID           string `json:"id"`
	UserID       string `json:"userId"`
	UserEmail    string `json:"userEmail"`
	CredentialID string `json:"credentialId"`
	Label        string `json:"label"`
	RPID         string `json:"rpId"`
	Algorithm    int    `json:"algorithm"`
	SignCount    uint32 `json:"signCount"`
	CreatedAt    string `json:"createdAt"`
	LastUsedAt   string `json:"lastUsedAt"`
}

func formatUnixISO(ts int64) string {
	if ts <= 0 {
		return ""
	}
	return time.Unix(ts, 0).UTC().Format(time.RFC3339)
}

func parseISOUnix(raw string) int64 {
	if strings.TrimSpace(raw) == "" {
		return 0
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UTC().Unix()
	}
	return time.Now().UTC().Unix()
}

func randomBase64URL(nBytes int) string {
	rawHex := randomHex(nBytes)
	b := make([]byte, nBytes)
	for i := 0; i < nBytes && (i*2+1) < len(rawHex); i++ {
		var hi, lo byte
		hi = hexVal(rawHex[i*2])
		lo = hexVal(rawHex[i*2+1])
		b[i] = (hi << 4) | lo
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func hexVal(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10
	default:
		return 0
	}
}

func (s *appServer) defaultBuiltinConnectorsLocked() []storedConnector {
	nowISO := time.Now().UTC().Format(time.RFC3339)
	return []storedConnector{
		{
			ID:          "conn_microsoft",
			Provider:    "microsoft",
			DisplayName: "Microsoft (Entra ID)",
			Enabled:     false,
			ClientID:    "",
			Extra:       map[string]string{"tenant_id": "common"},
			UpdatedAt:   nowISO,
		},
		{
			ID:          "conn_apple",
			Provider:    "apple",
			DisplayName: "Apple",
			Enabled:     false,
			ClientID:    "",
			Extra:       map[string]string{"team_id": "", "key_id": ""},
			UpdatedAt:   nowISO,
		},
		{
			ID:          "conn_google",
			Provider:    "google",
			DisplayName: "Google",
			Enabled:     false,
			ClientID:    "",
			Extra:       map[string]string{},
			UpdatedAt:   nowISO,
		},
		{
			ID:          "conn_wechat",
			Provider:    "wechat",
			DisplayName: "微信 WeChat",
			Enabled:     false,
			ClientID:    "",
			Extra:       map[string]string{"wechat_mode": "qr"},
			UpdatedAt:   nowISO,
		},
		{
			ID:          "conn_github",
			Provider:    "github",
			DisplayName: "GitHub",
			Enabled:     false,
			ClientID:    "",
			Extra:       map[string]string{},
			UpdatedAt:   nowISO,
		},
	}
}

func (s *appServer) seedAndLoadDBLocked(ctx context.Context) {
	if s.repo == nil {
		return
	}
	cfg := s.cfgMgr.Get()
	seeded, ok, _ := s.repo.GetSetting(ctx, "seeded_v1")
	if !ok || seeded == "" {
		existingConns, err := s.repo.ListConnectors(ctx)
		if err == nil && len(existingConns) == 0 {
			builtins := s.defaultBuiltinConnectorsLocked()
			for idx, c := range builtins {
				s.persistConnectorLocked(c, idx)
			}
		}

		existingUsers, err := s.repo.ListUsers(ctx)
		if err == nil && len(existingUsers) == 0 && strings.TrimSpace(cfg.AdminEmail) != "" {
			nowISO := time.Now().UTC().Format(time.RFC3339)
			adminUser := identityUser{
				ID:            "usr_super_admin",
				Email:         strings.ToLower(strings.TrimSpace(cfg.AdminEmail)),
				EmailVerified: true,
				DisplayName:   "System Admin",
				Role:          "super_admin",
				Status:        "active",
				PasswordAlgo:  "argon2id",
				PasswordHash:  cfg.AdminPasswordHash,
				TotpEnabled:   false,
				PasskeyCount:  0,
				Identities:    []userIdentityLink{},
				CreatedAt:     nowISO,
				LastLoginAt:   nowISO,
			}
			s.persistUserLocked(adminUser)
		}

		if _, hasPolicy, _ := s.repo.GetSetting(ctx, "auth_policy"); !hasPolicy {
			s.persistPolicyLocked()
		}
		_ = s.repo.SetSetting(ctx, "seeded_v1", "1")
	}

	s.loadStateFromDBLocked(ctx)
}

func (s *appServer) loadStateFromDBLocked(ctx context.Context) {
	if s.repo == nil {
		return
	}

	// 1. Auth Policy
	if rawPolicy, ok, err := s.repo.GetSetting(ctx, "auth_policy"); err == nil && ok && rawPolicy != "" {
		var p authPolicyConfig
		if json.Unmarshal([]byte(rawPolicy), &p) == nil {
			s.policy = p
		}
	}

	// 2. OAuth Applications
	if appRecs, err := s.repo.ListApplications(ctx); err == nil {
		apps := make([]oauthApplication, 0, len(appRecs))
		for _, rec := range appRecs {
			plainSecret, decErr := s.keys.DecryptSecret(rec.EncryptedSecret)
			if decErr != nil {
				plainSecret = rec.EncryptedSecret
			}
			var uris []string
			_ = json.Unmarshal([]byte(rec.RedirectUrisJSON), &uris)
			if uris == nil {
				uris = []string{}
			}
			var scopes []string
			if rec.ScopesJSON != "" {
				_ = json.Unmarshal([]byte(rec.ScopesJSON), &scopes)
			}
			if len(scopes) == 0 {
				scopes = []string{"openid", "profile", "email", "offline_access"}
			}
			var themePtr *loginThemeConfig
			if rec.LoginThemeJSON != "" {
				var parsed loginThemeConfig
				if json.Unmarshal([]byte(rec.LoginThemeJSON), &parsed) == nil {
					norm := normalizeLoginTheme(parsed, rec.Name)
					themePtr = &norm
				}
			}
			if themePtr == nil {
				t := defaultLoginTheme(rec.Name)
				themePtr = &t
			}
			apps = append(apps, oauthApplication{
				ID:           rec.ID,
				Name:         rec.Name,
				Description:  rec.Description,
				ClientID:     rec.ClientID,
				ClientSecret: plainSecret,
				RedirectUris: uris,
				Scopes:       scopes,
				CreatedAt:    formatUnixISO(rec.CreatedAt),
				LoginTheme:   themePtr,
			})
		}
		s.apps = apps
	}

	// 3. Social Connectors
	if connRecs, err := s.repo.ListConnectors(ctx); err == nil {
		conns := make([]storedConnector, 0, len(connRecs))
		for _, rec := range connRecs {
			extra := map[string]string{}
			if rec.ExtraJSON != "" {
				_ = json.Unmarshal([]byte(rec.ExtraJSON), &extra)
			}
			masked := rec.SecretMasked
			if masked == "" && rec.EncryptedSecret != "" {
				if plain, decErr := s.keys.DecryptSecret(rec.EncryptedSecret); decErr == nil && plain != "" {
					masked = maskSecret(plain)
				}
			}
			conns = append(conns, storedConnector{
				ID:              rec.ID,
				Provider:        rec.Provider,
				DisplayName:     rec.DisplayName,
				Enabled:         rec.Enabled,
				ClientID:        rec.ClientID,
				EncryptedSecret: rec.EncryptedSecret,
				SecretPreview:   masked,
				Extra:           extra,
				UpdatedAt:       formatUnixISO(rec.UpdatedAt),
			})
		}
		s.connectors = conns
	}

	// 4. Users, Identities & Passkeys
	identByUser := make(map[string][]userIdentityLink)
	if idents, err := s.repo.ListUserIdentities(ctx); err == nil {
		for _, idRec := range idents {
			label := idRec.ProviderLabel
			if label == "" {
				label = idRec.Provider
			}
			identByUser[idRec.UserID] = append(identByUser[idRec.UserID], userIdentityLink{
				ID:            idRec.ID,
				Provider:      idRec.Provider,
				ProviderLabel: label,
				ProviderSub:   idRec.ProviderSub,
				Email:         idRec.Email,
				LinkedAt:      formatUnixISO(idRec.LinkedAt),
			})
		}
	}

	if pkRecs, err := s.repo.ListPasskeys(ctx); err == nil {
		pks := make([]storedPasskey, 0, len(pkRecs))
		for _, rec := range pkRecs {
			pks = append(pks, storedPasskey{
				ID:            rec.ID,
				UserID:        rec.UserID,
				CredentialID:  rec.CredentialID,
				PublicKeySPKI: rec.PublicKeySPKI,
				Algorithm:     rec.Algorithm,
				Label:         rec.Label,
				RPID:          rec.RPID,
				SignCount:     rec.SignCount,
				CreatedAt:     formatUnixISO(rec.CreatedAt),
				LastUsedAt:    formatUnixISO(rec.LastUsedAt),
			})
		}
		s.passkeys = pks
	}

	if userRecs, err := s.repo.ListUsers(ctx); err == nil {
		users := make([]identityUser, 0, len(userRecs))
		for _, rec := range userRecs {
			idents := identByUser[rec.ID]
			if idents == nil {
				idents = []userIdentityLink{}
			}
			algo := "none"
			if rec.PasswordHash != "" {
				algo = "argon2id"
			}
			role := rec.Role
			if role != "super_admin" {
				role = "member"
			}
			if rec.ID == "usr_super_admin" {
				role = "super_admin"
			}
			if rec.TotpEnabled && rec.TotpSecretEnc != "" {
				var recCodes []string
				if rec.RecoveryHashes != "" {
					_ = json.Unmarshal([]byte(rec.RecoveryHashes), &recCodes)
				}
				s.totpEnrolled[rec.ID] = totpRecord{SecretEnc: rec.TotpSecretEnc, RecoveryCodes: recCodes}
			}
			users = append(users, identityUser{
				ID:             rec.ID,
				Email:          rec.Email,
				EmailVerified:  rec.EmailVerified,
				DisplayName:    rec.DisplayName,
				Role:           role,
				Status:         defaultStr(rec.Status, "active"),
				PasswordAlgo:   algo,
				PasswordHash:   rec.PasswordHash,
				TotpEnabled:    rec.TotpEnabled,
				TotpSecretEnc:  rec.TotpSecretEnc,
				RecoveryHashes: rec.RecoveryHashes,
				PasskeyCount:   0,
				Identities:     idents,
				CreatedAt:      formatUnixISO(rec.CreatedAt),
				LastLoginAt:    formatUnixISO(rec.LastLoginAt),
			})
		}
		s.users = users
	}

	// Ensure initialized system always has its super_admin row present in users table
	cfg := s.cfgMgr.Get()
	if cfg.Initialized && strings.TrimSpace(cfg.AdminEmail) != "" && s.countActiveAdminsLocked() == 0 {
		nowISO := time.Now().UTC().Format(time.RFC3339)
		adminUser := identityUser{
			ID:            "usr_super_admin",
			Email:         strings.ToLower(strings.TrimSpace(cfg.AdminEmail)),
			EmailVerified: true,
			DisplayName:   "System Admin",
			Role:          "super_admin",
			Status:        "active",
			PasswordAlgo:  "argon2id",
			PasswordHash:  cfg.AdminPasswordHash,
			TotpEnabled:   false,
			PasskeyCount:  0,
			Identities:    []userIdentityLink{},
			CreatedAt:     nowISO,
			LastLoginAt:   nowISO,
		}
		s.users = append([]identityUser{adminUser}, s.users...)
		s.persistUserLocked(adminUser)
	}
	s.syncPasskeyCountsLocked()

	// 5. Webhooks
	if whRecs, err := s.repo.ListWebhooks(ctx); err == nil {
		whs := make([]storedWebhook, 0, len(whRecs))
		for _, rec := range whRecs {
			var evts []string
			_ = json.Unmarshal([]byte(rec.EventsJSON), &evts)
			if len(evts) == 0 {
				evts = []string{"user.banned", "session.revoked"}
			}
			masked := rec.SecretMasked
			if masked == "" && rec.SigningSecretEnc != "" {
				if plain, decErr := s.keys.DecryptSecret(rec.SigningSecretEnc); decErr == nil && plain != "" {
					masked = maskSecret(plain)
				}
			}
			whs = append(whs, storedWebhook{
				ID:           rec.ID,
				Name:         defaultStr(rec.Name, "Webhook"),
				TargetURL:    rec.TargetURL,
				Events:       evts,
				Enabled:      rec.Enabled,
				SecretEnc:    rec.SigningSecretEnc,
				SecretMasked: masked,
				CreatedAt:    formatUnixISO(rec.CreatedAt),
			})
		}
		s.webhooks = whs
	}

	// 6. Extension settings (App locks, Per-User Allowed Methods, Backup retention config)
	s.loadExtensionSettingsLocked(ctx)
}

func (s *appServer) syncPasskeyCountsLocked() {
	counts := make(map[string]int)
	for _, pk := range s.passkeys {
		counts[pk.UserID]++
	}
	for i := range s.users {
		s.users[i].PasskeyCount = counts[s.users[i].ID]
	}
}

func (s *appServer) countActiveAdminsLocked() int {
	n := 0
	for _, u := range s.users {
		if u.Role == "super_admin" && u.Status == "active" {
			n++
		}
	}
	return n
}

func (s *appServer) persistPolicyLocked() {
	if s.repo == nil {
		return
	}
	raw, err := json.Marshal(s.policy)
	if err == nil {
		_ = s.repo.SetSetting(context.Background(), "auth_policy", string(raw))
	}
}

func (s *appServer) persistAppLocked(a oauthApplication) {
	if s.repo == nil {
		return
	}
	encSecret, err := s.keys.EncryptSecret(a.ClientSecret)
	if err != nil {
		encSecret = a.ClientSecret
	}
	urisJSON, _ := json.Marshal(a.RedirectUris)
	scopesJSON, _ := json.Marshal(a.Scopes)
	themeJSON := ""
	if a.LoginTheme != nil {
		if b, err := json.Marshal(a.LoginTheme); err == nil {
			themeJSON = string(b)
		}
	}
	_ = s.repo.UpsertApplication(context.Background(), store.OAuthApplicationRecord{
		ID:               a.ID,
		Name:             a.Name,
		Description:      a.Description,
		ClientID:         a.ClientID,
		EncryptedSecret:  encSecret,
		RedirectUrisJSON: string(urisJSON),
		ScopesJSON:       string(scopesJSON),
		LoginThemeJSON:   themeJSON,
		CreatedAt:        parseISOUnix(a.CreatedAt),
	})
}

func (s *appServer) persistDeleteAppLocked(id string) {
	if s.repo == nil {
		return
	}
	_ = s.repo.DeleteApplication(context.Background(), id)
}

func (s *appServer) persistConnectorLocked(c storedConnector, order int) {
	if s.repo == nil {
		return
	}
	extraJSON, _ := json.Marshal(c.Extra)
	_ = s.repo.UpsertConnector(context.Background(), store.SocialConnectorRecord{
		ID:              c.ID,
		Provider:        c.Provider,
		DisplayName:     c.DisplayName,
		Enabled:         c.Enabled,
		SortOrder:       order,
		ClientID:        c.ClientID,
		EncryptedSecret: c.EncryptedSecret,
		SecretMasked:    c.SecretPreview,
		ExtraJSON:       string(extraJSON),
		UpdatedAt:       parseISOUnix(c.UpdatedAt),
	})
}

func (s *appServer) persistDeleteConnectorLocked(id string) {
	if s.repo == nil {
		return
	}
	_ = s.repo.DeleteConnector(context.Background(), id)
}

func (s *appServer) persistConnectorOrderLocked() {
	if s.repo == nil {
		return
	}
	ids := make([]string, 0, len(s.connectors))
	for _, c := range s.connectors {
		ids = append(ids, c.ID)
	}
	_ = s.repo.UpdateConnectorOrders(context.Background(), ids)
}

func (s *appServer) persistUserLocked(u identityUser) error {
	if s.repo == nil {
		return nil
	}
	return s.repo.UpsertUser(context.Background(), store.User{
		ID:             u.ID,
		Email:          u.Email,
		EmailVerified:  u.EmailVerified,
		DisplayName:    u.DisplayName,
		Role:           u.Role,
		PasswordHash:   u.PasswordHash,
		TotpEnabled:    u.TotpEnabled,
		TotpSecretEnc:  u.TotpSecretEnc,
		RecoveryHashes: u.RecoveryHashes,
		Status:         u.Status,
		CreatedAt:      parseISOUnix(u.CreatedAt),
		LastLoginAt:    parseISOUnix(u.LastLoginAt),
	})
}

func (s *appServer) persistDeleteUserLocked(id string) {
	if s.repo == nil {
		return
	}
	_ = s.repo.DeleteUser(context.Background(), id)
}

func (s *appServer) persistIdentityLocked(userID string, ident userIdentityLink) {
	if s.repo == nil {
		return
	}
	_ = s.repo.UpsertUserIdentity(context.Background(), store.UserIdentity{
		ID:            ident.ID,
		UserID:        userID,
		Provider:      ident.Provider,
		ProviderLabel: ident.ProviderLabel,
		ProviderSub:   ident.ProviderSub,
		Email:         ident.Email,
		LinkedAt:      parseISOUnix(ident.LinkedAt),
	})
}

func (s *appServer) persistDeleteIdentityLocked(id string) {
	if s.repo == nil {
		return
	}
	_ = s.repo.DeleteUserIdentity(context.Background(), id)
}

func (s *appServer) persistPasskeyLocked(pk storedPasskey) {
	if s.repo == nil {
		return
	}
	_ = s.repo.InsertPasskey(context.Background(), store.PasskeyCredential{
		ID:            pk.ID,
		UserID:        pk.UserID,
		CredentialID:  pk.CredentialID,
		PublicKeySPKI: pk.PublicKeySPKI,
		Algorithm:     pk.Algorithm,
		Label:         pk.Label,
		RPID:          pk.RPID,
		SignCount:     pk.SignCount,
		CreatedAt:     parseISOUnix(pk.CreatedAt),
		LastUsedAt:    parseISOUnix(pk.LastUsedAt),
	})
}

func (s *appServer) persistPasskeyUsageLocked(pk storedPasskey) {
	if s.repo == nil {
		return
	}
	_ = s.repo.UpdatePasskeyUsage(context.Background(), pk.ID, pk.SignCount, parseISOUnix(pk.LastUsedAt))
}

func (s *appServer) persistDeletePasskeyLocked(id string) {
	if s.repo == nil {
		return
	}
	_ = s.repo.DeletePasskey(context.Background(), id)
}

func (s *appServer) persistWebhookLocked(wh storedWebhook) {
	if s.repo == nil {
		return
	}
	eventsJSON, _ := json.Marshal(wh.Events)
	_ = s.repo.UpsertWebhook(context.Background(), store.WebhookRecord{
		ID:               wh.ID,
		Name:             wh.Name,
		TargetURL:        wh.TargetURL,
		SigningSecretEnc: wh.SecretEnc,
		SecretMasked:     wh.SecretMasked,
		EventsJSON:       string(eventsJSON),
		Enabled:          wh.Enabled,
		CreatedAt:        parseISOUnix(wh.CreatedAt),
	})
}

func (s *appServer) persistDeleteWebhookLocked(id string) {
	if s.repo == nil {
		return
	}
	_ = s.repo.DeleteWebhook(context.Background(), id)
}

func (s *appServer) persistSessionLocked(tok string, u authUser) {
	s.sessions[tok] = u
	if s.repo == nil {
		return
	}
	if raw, err := json.Marshal(u); err == nil {
		_ = s.repo.SaveSession(context.Background(), tok, string(raw), time.Now().UTC().Add(7*24*time.Hour).Unix())
	}
}

func (s *appServer) resolveSessionLocked(tok string) (authUser, bool) {
	if strings.HasPrefix(tok, "wmk_pat_") {
		return s.verifyAdminAPITokenLocked(tok)
	}
	if u, ok := s.sessions[tok]; ok {
		return u, true
	}
	if s.repo != nil {
		if raw, ok, err := s.repo.LoadSession(context.Background(), tok); err == nil && ok {
			var u authUser
			if json.Unmarshal([]byte(raw), &u) == nil && u.Sub != "" {
				s.sessions[tok] = u
				return u, true
			}
		}
	}
	return authUser{}, false
}

func isHTTPSRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	proto := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")))
	return proto == "https"
}

func (s *appServer) setSessionCookie(w http.ResponseWriter, r *http.Request, tok string) {
	if isHTTPSRequest(r) {
		w.Header().Add("Set-Cookie", adminSessionCookieName+"="+tok+"; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=None; Partitioned")
		return
	}
	w.Header().Add("Set-Cookie", adminSessionCookieName+"="+tok+"; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax")
}

func (s *appServer) clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	if isHTTPSRequest(r) {
		w.Header().Add("Set-Cookie", adminSessionCookieName+"=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned")
		return
	}
	w.Header().Add("Set-Cookie", adminSessionCookieName+"=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
}

// extractSessionToken checks Authorization: Bearer first, then the HttpOnly session cookie.
// Returns (token, fromCookie).
func extractSessionToken(r *http.Request) (string, bool) {
	hdr := r.Header.Get("Authorization")
	if strings.HasPrefix(hdr, "Bearer ") {
		tok := strings.TrimSpace(strings.TrimPrefix(hdr, "Bearer "))
		if tok != "" && tok != "cookie_session" {
			return tok, false
		}
	}
	if c, err := r.Cookie(adminSessionCookieName); err == nil {
		tok := strings.TrimSpace(c.Value)
		if tok != "" {
			return tok, true
		}
	}
	return "", false
}

// verifyCookieCSRF protects cookie-authenticated state-changing requests against CSRF
// by requiring either X-Requested-With or a same-host Origin header.
func verifyCookieCSRF(r *http.Request) bool {
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	if strings.TrimSpace(r.Header.Get("X-Requested-With")) != "" {
		return true
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	expectedHost := defaultStr(r.Header.Get("X-Forwarded-Host"), r.Host)
	if idx := strings.Index(expectedHost, ","); idx != -1 {
		expectedHost = strings.TrimSpace(expectedHost[:idx])
	}
	return strings.EqualFold(parsed.Host, expectedHost)
}

func (s *appServer) currentSessionUser(r *http.Request) (authUser, bool) {
	tok, _ := extractSessionToken(r)
	if tok == "" {
		return authUser{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.resolveSessionLocked(tok)
}

func (s *appServer) handleAdminLogout(w http.ResponseWriter, r *http.Request) {
	tok, _ := extractSessionToken(r)
	if tok != "" {
		s.mu.Lock()
		delete(s.sessions, tok)
		if s.repo != nil {
			_ = s.repo.DeleteSession(context.Background(), tok)
		}
		s.mu.Unlock()
	}
	s.clearSessionCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *appServer) serializePasskeysLocked(filterUserID string) []passkeyDTO {
	emailByID := make(map[string]string, len(s.users))
	for _, u := range s.users {
		emailByID[u.ID] = u.Email
	}
	out := make([]passkeyDTO, 0, len(s.passkeys))
	for _, pk := range s.passkeys {
		if filterUserID != "" && pk.UserID != filterUserID {
			continue
		}
		out = append(out, passkeyDTO{
			ID:           pk.ID,
			UserID:       pk.UserID,
			UserEmail:    emailByID[pk.UserID],
			CredentialID: pk.CredentialID,
			Label:        pk.Label,
			RPID:         pk.RPID,
			Algorithm:    pk.Algorithm,
			SignCount:    pk.SignCount,
			CreatedAt:    pk.CreatedAt,
			LastUsedAt:   pk.LastUsedAt,
		})
	}
	return out
}

func (s *appServer) requestRPID(r *http.Request) string {
	host := defaultStr(r.Header.Get("X-Forwarded-Host"), r.Host)
	if idx := strings.Index(host, ","); idx != -1 {
		host = strings.TrimSpace(host[:idx])
	}
	if idx := strings.LastIndex(host, ":"); idx != -1 && !strings.Contains(host[idx:], "]") {
		host = host[:idx]
	}
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	if host == "" {
		return "localhost"
	}
	return host
}

// ============================================================================
// Custom OIDC Connector Deletion
// ============================================================================

func (s *appServer) handleDeleteConnector(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, c := range s.connectors {
		if c.ID == id {
			if c.Provider != "custom_oidc" {
				writeJSON(w, http.StatusBadRequest, map[string]any{
					"error":   "builtin_connector_protected",
					"message": "Built-in social connectors cannot be deleted; disable them instead.",
				})
				return
			}
			s.connectors = append(s.connectors[:i], s.connectors[i+1:]...)
			s.persistDeleteConnectorLocked(id)
			s.persistConnectorOrderLocked()
			writeJSON(w, http.StatusOK, map[string]any{
				"deleted":    true,
				"id":         id,
				"connectors": s.serializeConnectorsLocked(),
			})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found", "message": "Connector not found"})
}

// ============================================================================
// User Directory CRUD Management
// ============================================================================

func (s *appServer) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email         string `json:"email"`
		DisplayName   string `json:"displayName"`
		Password      string `json:"password"`
		Role          string `json:"role"`
		EmailVerified *bool  `json:"emailVerified"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json", "message": "Invalid JSON payload"})
		return
	}
	normEmail := strings.ToLower(strings.TrimSpace(body.Email))
	if !strings.Contains(normEmail, "@") || len(normEmail) < 5 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_email", "message": "Please enter a valid email address."})
		return
	}
	if len(body.Password) > 0 && len(body.Password) < 8 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "weak_password", "message": "Password must be at least 8 characters."})
		return
	}
	role := "member"
	if body.Role == "super_admin" {
		role = "super_admin"
	}
	if role == "super_admin" && len(body.Password) < 8 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "password_required", "message": "Administrator accounts require a password of at least 8 characters."})
		return
	}

	pwHash := ""
	pwAlgo := "none"
	if len(body.Password) >= 8 {
		h, err := auth.HashPasswordArgon2id(body.Password)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "hash_error", "message": err.Error()})
			return
		}
		pwHash = h
		pwAlgo = "argon2id"
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.users {
		if strings.ToLower(existing.Email) == normEmail {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "email_exists", "message": "A user with this email already exists."})
			return
		}
	}

	verified := true
	if body.EmailVerified != nil {
		verified = *body.EmailVerified
	}
	displayName := strings.TrimSpace(body.DisplayName)
	if displayName == "" {
		displayName = strings.Split(normEmail, "@")[0]
	}
	nowISO := time.Now().UTC().Format(time.RFC3339)
	created := identityUser{
		ID:            "usr_" + randomHex(4),
		Email:         normEmail,
		EmailVerified: verified,
		DisplayName:   displayName,
		Role:          role,
		Status:        "active",
		PasswordAlgo:  pwAlgo,
		PasswordHash:  pwHash,
		TotpEnabled:   false,
		PasskeyCount:  0,
		Identities:    []userIdentityLink{},
		CreatedAt:     nowISO,
		LastLoginAt:   "",
	}
	if err := s.persistUserLocked(created); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db_write_error", "message": "Failed to save user to database: " + err.Error()})
		return
	}
	s.users = append([]identityUser{created}, s.users...)
	writeJSON(w, http.StatusCreated, map[string]any{"user": created, "users": s.users})
}

func (s *appServer) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	var body struct {
		Email         *string `json:"email"`
		DisplayName   *string `json:"displayName"`
		Role          *string `json:"role"`
		EmailVerified *bool   `json:"emailVerified"`
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
	if idx == -1 {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found", "message": "User not found"})
		return
	}

	prevEmail := s.users[idx].Email
	if body.Email != nil {
		norm := strings.ToLower(strings.TrimSpace(*body.Email))
		if !strings.Contains(norm, "@") {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_email", "message": "Invalid email address"})
			return
		}
		for i, u := range s.users {
			if i != idx && strings.ToLower(u.Email) == norm {
				writeJSON(w, http.StatusConflict, map[string]any{"error": "email_exists", "message": "Another account already uses this email"})
				return
			}
		}
		s.users[idx].Email = norm
	}
	if body.DisplayName != nil && strings.TrimSpace(*body.DisplayName) != "" {
		s.users[idx].DisplayName = strings.TrimSpace(*body.DisplayName)
	}
	if body.EmailVerified != nil {
		s.users[idx].EmailVerified = *body.EmailVerified
	}
	if body.Role != nil {
		nextRole := "member"
		if *body.Role == "super_admin" {
			nextRole = "super_admin"
		}
		if s.users[idx].Role == "super_admin" && nextRole != "super_admin" && s.countActiveAdminsLocked() <= 1 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "last_admin", "message": "Cannot demote the last active system administrator."})
			return
		}
		s.users[idx].Role = nextRole
	}

	s.persistUserLocked(s.users[idx])

	// Keep config.json AdminEmail in sync if editing the primary admin
	cfg := s.cfgMgr.Get()
	if s.users[idx].ID == "usr_super_admin" || strings.EqualFold(prevEmail, cfg.AdminEmail) {
		if s.users[idx].Role == "super_admin" && !strings.EqualFold(cfg.AdminEmail, s.users[idx].Email) {
			cfg.AdminEmail = s.users[idx].Email
			_ = s.cfgMgr.Update(cfg)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"user": s.users[idx], "users": s.users})
}

func (s *appServer) handleResetUserPassword(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json", "message": "Invalid JSON payload"})
		return
	}
	if len(body.Password) < 8 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "weak_password", "message": "Password must be at least 8 characters."})
		return
	}
	hash, err := auth.HashPasswordArgon2id(body.Password)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "hash_error", "message": err.Error()})
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.users {
		if s.users[i].ID == id {
			s.users[i].PasswordHash = hash
			s.users[i].PasswordAlgo = "argon2id"
			if err := s.persistUserLocked(s.users[i]); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db_write_error", "message": "Failed to persist password: " + err.Error()})
				return
			}

			cfg := s.cfgMgr.Get()
			if s.users[i].ID == "usr_super_admin" || strings.EqualFold(s.users[i].Email, cfg.AdminEmail) {
				cfg.AdminPasswordHash = hash
				_ = s.cfgMgr.Update(cfg)
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "user": s.users[i], "users": s.users})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found", "message": "User not found"})
}

func (s *appServer) handleDeleteUserPassword(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.users {
		if s.users[i].ID == id {
			if s.users[i].Role == "super_admin" && s.countActiveAdminsLocked() <= 1 && s.users[i].PasskeyCount == 0 {
				writeJSON(w, http.StatusBadRequest, map[string]any{
					"error":   "last_admin_factor",
					"message": "Register at least one Passkey before clearing the password on the last active administrator.",
				})
				return
			}
			s.users[i].PasswordHash = ""
			s.users[i].PasswordAlgo = "none"
			if err := s.persistUserLocked(s.users[i]); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db_write_error", "message": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "user": s.users[i], "users": s.users})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found", "message": "User not found"})
}

func (s *appServer) handleAdminTotpEnroll(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	s.mu.Lock()
	if !s.policy.EnableTotp2fa {
		s.mu.Unlock()
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "auth_method_disabled", "message": "TOTP 2FA is globally disabled by administrator Security Policy."})
		return
	}
	var target *identityUser
	for i := range s.users {
		if s.users[i].ID == id {
			target = &s.users[i]
			break
		}
	}
	if target == nil {
		s.mu.Unlock()
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found", "message": "User not found"})
		return
	}
	email := target.Email
	s.mu.Unlock()

	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	uri := auth.BuildOTPAuthURI("wimotek/Oauth", email, secret)
	code, _ := auth.GenerateTOTP(secret, time.Now())
	codes := make([]string, 8)
	for i := range codes {
		h := strings.ToUpper(randomHex(4))
		codes[i] = h[:4] + "-" + h[4:8]
	}
	enc, _ := s.keys.EncryptSecret(secret)

	s.mu.Lock()
	s.totpPending[id] = totpRecord{SecretEnc: enc, RecoveryCodes: codes}
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"userId":        id,
		"email":         email,
		"secret":        secret,
		"otpauthUri":    uri,
		"currentCode":   code,
		"recoveryCodes": codes,
	})
}

func (s *appServer) handleAdminTotpVerify(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	var body struct {
		Code string `json:"code"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.policy.EnableTotp2fa {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "auth_method_disabled", "message": "TOTP 2FA is globally disabled by administrator Security Policy."})
		return
	}

	pending, ok := s.totpPending[id]
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no_pending_totp", "message": "Start TOTP enrollment first before verifying a code."})
		return
	}
	plain, _ := s.keys.DecryptSecret(pending.SecretEnc)
	if !auth.VerifyTOTP(plain, strings.TrimSpace(body.Code), time.Now()) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_totp", "message": "Invalid 6-digit TOTP code."})
		return
	}

	s.totpEnrolled[id] = pending
	delete(s.totpPending, id)
	recBytes, _ := json.Marshal(pending.RecoveryCodes)
	for i := range s.users {
		if s.users[i].ID == id {
			s.users[i].TotpEnabled = true
			s.users[i].TotpSecretEnc = pending.SecretEnc
			s.users[i].RecoveryHashes = string(recBytes)
			if err := s.persistUserLocked(s.users[i]); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db_write_error", "message": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "user": s.users[i], "users": s.users})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found", "message": "User not found"})
}

func (s *appServer) handleAdminTotpDisable(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.totpPending, id)
	delete(s.totpEnrolled, id)
	for i := range s.users {
		if s.users[i].ID == id {
			s.users[i].TotpEnabled = false
			s.users[i].TotpSecretEnc = ""
			s.users[i].RecoveryHashes = ""
			if err := s.persistUserLocked(s.users[i]); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "db_write_error", "message": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "user": s.users[i], "users": s.users})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found", "message": "User not found"})
}

func (s *appServer) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	me, _ := s.currentSessionUser(r)

	s.mu.Lock()
	defer s.mu.Unlock()

	if me.Sub == id {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "cannot_delete_self", "message": "You cannot delete the administrator account you are currently signed into."})
		return
	}
	for i := range s.users {
		if s.users[i].ID == id {
			if s.users[i].Role == "super_admin" && s.users[i].Status == "active" && s.countActiveAdminsLocked() <= 1 {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "last_admin", "message": "Cannot delete the last active system administrator."})
				return
			}
			s.users = append(s.users[:i], s.users[i+1:]...)
			keptPK := make([]storedPasskey, 0, len(s.passkeys))
			for _, pk := range s.passkeys {
				if pk.UserID != id {
					keptPK = append(keptPK, pk)
				}
			}
			s.passkeys = keptPK
			for tok, sess := range s.sessions {
				if sess.Sub == id {
					delete(s.sessions, tok)
					if s.repo != nil {
						_ = s.repo.DeleteSession(context.Background(), tok)
					}
				}
			}
			s.persistDeleteUserLocked(id)
			writeJSON(w, http.StatusOK, map[string]any{"deleted": true, "users": s.users, "passkeys": s.serializePasskeysLocked("")})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found", "message": "User not found"})
}

func (s *appServer) handleDeleteUserIdentity(w http.ResponseWriter, r *http.Request) {
	userID := strings.TrimSpace(r.PathValue("id"))
	identID := strings.TrimSpace(r.PathValue("identId"))

	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.users {
		if s.users[i].ID == userID {
			for j, ident := range s.users[i].Identities {
				if ident.ID == identID {
					s.users[i].Identities = append(s.users[i].Identities[:j], s.users[i].Identities[j+1:]...)
					s.persistDeleteIdentityLocked(identID)
					writeJSON(w, http.StatusOK, map[string]any{"deleted": true, "user": s.users[i], "users": s.users})
					return
				}
			}
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found", "message": "Identity link not found"})
}

// ============================================================================
// WebAuthn Passkey Credential Management (Register / List / Revoke)
// ============================================================================

func (s *appServer) handleListPasskeys(w http.ResponseWriter, r *http.Request) {
	userID := strings.TrimSpace(r.URL.Query().Get("userId"))
	s.mu.RLock()
	defer s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"passkeys": s.serializePasskeysLocked(userID)})
}

func (s *appServer) handlePasskeyRegisterOptions(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID string `json:"userId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	me, _ := s.currentSessionUser(r)

	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.policy.EnablePasskeysWebAuthn {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "auth_method_disabled", "message": "Passkeys (WebAuthn) are disabled by Auth Policy."})
		return
	}

	targetID := strings.TrimSpace(body.UserID)
	if targetID == "" {
		targetID = me.Sub
	}
	var target *identityUser
	for i := range s.users {
		if s.users[i].ID == targetID {
			target = &s.users[i]
			break
		}
	}
	if target == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "user_not_found", "message": "Target user account not found."})
		return
	}
	if target.Status != "active" {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "user_banned", "message": "Cannot register Passkeys for a suspended account."})
		return
	}

	challenge := randomBase64URL(32)
	rpID := s.requestRPID(r)
	regMeta, _ := json.Marshal(map[string]string{
		"userId": target.ID,
		"rpId":   rpID,
	})
	s.cacheSetLocked("webauthn:reg:"+challenge, string(regMeta), 3*time.Minute)

	exclude := make([]map[string]string, 0)
	for _, pk := range s.passkeys {
		if pk.UserID == target.ID {
			exclude = append(exclude, map[string]string{"id": pk.CredentialID, "type": "public-key"})
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"challenge": challenge,
		"rpId":      rpID,
		"rpName":    "wimotek/Oauth",
		"user": map[string]string{
			"id":          target.ID,
			"name":        target.Email,
			"displayName": defaultStr(target.DisplayName, target.Email),
		},
		"excludeCredentials": exclude,
	})
}

func (s *appServer) handlePasskeyRegisterVerify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Challenge      string `json:"challenge"`
		CredentialID   string `json:"credentialId"`
		PublicKeySpki  string `json:"publicKeySpki"`
		Algorithm      int    `json:"algorithm"`
		ClientDataJSON string `json:"clientDataJSON"`
		Label          string `json:"label"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json", "message": "Invalid JSON payload"})
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	rawMeta, ok := s.cacheGetLocked("webauthn:reg:" + strings.TrimSpace(body.Challenge))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_challenge", "message": "Registration challenge expired or invalid."})
		return
	}
	s.cacheDeleteLocked("webauthn:reg:" + strings.TrimSpace(body.Challenge))

	var meta map[string]string
	_ = json.Unmarshal([]byte(rawMeta), &meta)
	userID := meta["userId"]
	rpID := meta["rpId"]

	if strings.TrimSpace(body.CredentialID) == "" || strings.TrimSpace(body.PublicKeySpki) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_credential", "message": "Missing WebAuthn credentialId or SPKI public key."})
		return
	}
	if err := auth.VerifyWebAuthnRegistration(body.Challenge, rpID, body.ClientDataJSON, body.PublicKeySpki); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "verification_failed", "message": err.Error()})
		return
	}
	for _, existing := range s.passkeys {
		if existing.CredentialID == body.CredentialID {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "credential_exists", "message": "This Passkey credential is already registered."})
			return
		}
	}

	alg := body.Algorithm
	if alg == 0 {
		alg = -7
	}
	nowISO := time.Now().UTC().Format(time.RFC3339)
	created := storedPasskey{
		ID:            "pk_" + randomHex(4),
		UserID:        userID,
		CredentialID:  strings.TrimSpace(body.CredentialID),
		PublicKeySPKI: strings.TrimSpace(body.PublicKeySpki),
		Algorithm:     alg,
		Label:         defaultStr(strings.TrimSpace(body.Label), "Browser Passkey"),
		RPID:          rpID,
		SignCount:     0,
		CreatedAt:     nowISO,
		LastUsedAt:    "",
	}
	s.passkeys = append([]storedPasskey{created}, s.passkeys...)
	s.persistPasskeyLocked(created)
	s.syncPasskeyCountsLocked()

	writeJSON(w, http.StatusCreated, map[string]any{
		"passkeys": s.serializePasskeysLocked(""),
		"users":    s.users,
	})
}

func (s *appServer) handleDeletePasskey(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, pk := range s.passkeys {
		if pk.ID == id {
			s.passkeys = append(s.passkeys[:i], s.passkeys[i+1:]...)
			s.persistDeletePasskeyLocked(id)
			s.syncPasskeyCountsLocked()
			writeJSON(w, http.StatusOK, map[string]any{
				"deleted":  true,
				"passkeys": s.serializePasskeysLocked(""),
				"users":    s.users,
			})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found", "message": "Passkey credential not found."})
}
