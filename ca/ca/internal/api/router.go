package api

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/wimotek/ca/internal/auth"
	"github.com/wimotek/ca/internal/ca"
	"github.com/wimotek/ca/internal/cache"
	"github.com/wimotek/ca/internal/i18n"
	"github.com/wimotek/ca/internal/notify"
	"github.com/wimotek/ca/internal/store"
)

// ServerOptions configures HTTP server dependencies.
type ServerOptions struct {
	BaseURL  string
	Notifier *notify.Service
}

// Server wires HTTP routes for Web Console, Multi-User RBAC, Notifications, Public PKI/CRL/OCSP, OpenBao/Vault PKI, and Step-CA ACME.
type Server struct {
	store    *store.Store
	cache    *cache.HybridCache
	pki      *ca.Engine
	auth     *auth.Service
	i18n     *i18n.Bundle
	notifier *notify.Service
	webFS    fs.FS
	base     string
	mux      *http.ServeMux
}

// NewServer builds the unified pure-production HTTP handler.
func NewServer(st *store.Store, hc *cache.HybridCache, pki *ca.Engine, authSvc *auth.Service, locales *i18n.Bundle, webFS fs.FS, opts ServerOptions) *Server {
	notifier := opts.Notifier
	if notifier == nil {
		notifier = notify.NewService(st, []byte("default-notify-key"), false)
	}
	s := &Server{
		store:    st,
		cache:    hc,
		pki:      pki,
		auth:     authSvc,
		i18n:     locales,
		notifier: notifier,
		webFS:    webFS,
		base:     strings.TrimRight(opts.BaseURL, "/"),
		mux:      http.NewServeMux(),
	}
	s.registerRoutes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func (s *Server) registerRoutes() {
	// Health & i18n
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.HandleFunc("GET /api/i18n/{lang}", s.handleI18n)

	// Auth & First-Run Setup Wizard (Offline PoW + Rate Limit + Lockout)
	s.mux.HandleFunc("GET /api/auth/status", s.handleAuthStatus)
	s.mux.HandleFunc("POST /api/auth/setup", s.handleAuthSetup)
	s.mux.HandleFunc("GET /api/auth/challenge", s.handleAuthChallenge)
	s.mux.HandleFunc("POST /api/auth/login", s.handleAuthLogin)

	// Authenticated User Profile & Quota
	s.mux.HandleFunc("GET /api/profile", s.requireSession(s.handleGetProfile))
	s.mux.HandleFunc("PUT /api/profile", s.requireSession(s.handleUpdateProfile))

	// Admin User & Tier Quota Management
	s.mux.HandleFunc("GET /api/users", s.requireAdmin(s.handleListUsers))
	s.mux.HandleFunc("POST /api/users", s.requireAdmin(s.handleUpsertUser))
	s.mux.HandleFunc("PUT /api/users/{username}", s.requireAdmin(s.handleUpsertUser))
	s.mux.HandleFunc("DELETE /api/users/{username}", s.requireAdmin(s.handleDeleteUser))

	// Notification Channels & Certificate Expiry Monitor (Admin)
	s.mux.HandleFunc("GET /api/notifications/channels", s.requireAdmin(s.handleListNotifyChannels))
	s.mux.HandleFunc("POST /api/notifications/channels", s.requireAdmin(s.handleSaveNotifyChannel))
	s.mux.HandleFunc("DELETE /api/notifications/channels/{id}", s.requireAdmin(s.handleDeleteNotifyChannel))
	s.mux.HandleFunc("POST /api/notifications/channels/{id}/test", s.requireAdmin(s.handleTestNotifyChannel))
	s.mux.HandleFunc("POST /api/notifications/scan", s.requireAdmin(s.handleScanExpiring))
	s.mux.HandleFunc("GET /api/notifications/logs", s.requireAdmin(s.handleListNotifyLogs))

	// Protected Console APIs
	s.mux.HandleFunc("GET /api/ca/overview", s.requireSession(s.handleOverview))
	s.mux.HandleFunc("GET /api/certificates", s.requireSession(s.handleListCerts))
	s.mux.HandleFunc("POST /api/certificates", s.requireSession(s.handleIssueCert))
	s.mux.HandleFunc("POST /api/certificates/{serial}/revoke", s.requireSession(s.handleRevokeCert))
	s.mux.HandleFunc("GET /api/crl/info", s.requireSession(s.handleCRLInfo))
	s.mux.HandleFunc("POST /api/ocsp/check", s.requireSession(s.handleOCSPCheckJSON))
	s.mux.HandleFunc("GET /api/provisioners", s.requireAdmin(s.handleListProvisioners))
	s.mux.HandleFunc("POST /api/provisioners", s.requireAdmin(s.handleCreateProvisioner))
	s.mux.HandleFunc("DELETE /api/provisioners/{id}", s.requireAdmin(s.handleDeleteProvisioner))
	s.mux.HandleFunc("GET /api/audit", s.requireSession(s.handleListAudit))

	// Public RFC 5280 / RFC 6960 PKI Endpoints
	s.mux.HandleFunc("GET /ca/root.crt", s.handleDownloadRoot)
	s.mux.HandleFunc("GET /ca/issuing.crt", s.handleDownloadIssuing)
	s.mux.HandleFunc("GET /ca/chain.pem", s.handleDownloadChain)
	s.mux.HandleFunc("GET /ca/crl.der", s.handleDownloadCRLDER)
	s.mux.HandleFunc("GET /ca/crl.pem", s.handleDownloadCRLPEM)
	s.mux.HandleFunc("POST /ca/ocsp", s.handleOCSPResponder)

	// OpenBao / HashiCorp Vault PKI Engine Compatible Routes
	s.mux.HandleFunc("GET /v1/pki/ca/pem", s.handleDownloadIssuing)
	s.mux.HandleFunc("GET /v1/pki/ca_chain", s.handleDownloadChain)
	s.mux.HandleFunc("GET /v1/pki/crl/pem", s.handleDownloadCRLPEM)
	s.mux.HandleFunc("POST /v1/pki/issue/{role}", s.requireAuthOrProvisioner(s.handleVaultIssue))
	s.mux.HandleFunc("POST /v1/pki/sign/{role}", s.requireAuthOrProvisioner(s.handleVaultIssue))
	s.mux.HandleFunc("POST /v1/pki/revoke", s.requireAuthOrProvisioner(s.handleVaultRevoke))

	// Step-CA Style ACME Discovery Endpoints
	s.mux.HandleFunc("GET /acme/directory", s.handleACMEDirectory)
	s.mux.HandleFunc("HEAD /acme/new-nonce", s.handleACMENonce)
	s.mux.HandleFunc("GET /acme/new-nonce", s.handleACMENonce)

	// Extended Automation, Multi-Purpose Tokens, Personal ServerChan Webhook Relay, and MCP Server
	s.registerExtensionRoutes()
	// Unified wimotek/OAuth PKCE S256 Gateway (/api/auth/oauth/*, /login, /callback)
	s.registerOAuthGatewayRoutes()

	// Ensure unmatched /api/* routes (including disabled /api/demo/* in production) return strict 404 JSON
	s.mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeErr(w, http.StatusNotFound, "not found")
	})

	// Embedded SPA Static Handler
	s.mux.Handle("/", s.handleSPA())
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"db":     string(s.store.Driver),
		"cache":  s.cache.Status(),
		"time":   time.Now().Unix(),
	})
}

func (s *Server) handleI18n(w http.ResponseWriter, r *http.Request) {
	lang := r.PathValue("lang")
	resolved, payload := s.i18n.Resolve(lang)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Resolved-Lang", resolved)
	_, _ = w.Write(payload)
}

func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	needsSetup, err := s.auth.NeedsInitialSetup(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	ov, _ := s.pki.Overview(r.Context())
	orgName := "Wimotek Enterprise"
	if ov != nil && ov.OrgName != "" {
		orgName = ov.OrgName
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"needs_setup":     needsSetup,
		"org_name":        orgName,
		"base_url":        s.base,
		"languages":       i18n.SupportedLanguages,
		"oauth_providers": s.oauthProvidersMeta(r.Context()),
	})
}

func (s *Server) handleAuthSetup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username     string                `json:"username"`
		Password     string                `json:"password"`
		OrgName      string                `json:"org_name"`
		BaseURL      string                `json:"base_url"`
		FullName     string                `json:"full_name"`
		Email        string                `json:"email"`
		UPN          string                `json:"upn"`
		Department   string                `json:"department"`
		Country      string                `json:"country"`
		Province     string                `json:"province"`
		Locality     string                `json:"locality"`
		DefaultLang  string                `json:"default_lang"`
		NotifyName   string                `json:"notify_name"`
		NotifyType   string                `json:"notify_type"`
		NotifyConfig *notify.ChannelConfig `json:"notify_config"`
		AdvanceDays  []int                 `json:"advance_days"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}

	if strings.TrimSpace(body.OrgName) != "" || strings.TrimSpace(body.BaseURL) != "" {
		if err := s.pki.ReconfigureFromWizard(r.Context(), body.OrgName, body.BaseURL); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		if strings.TrimSpace(body.BaseURL) != "" {
			s.base = strings.TrimRight(strings.TrimSpace(body.BaseURL), "/")
		}
	}
	if strings.TrimSpace(body.DefaultLang) != "" {
		_ = s.store.SetSetting(r.Context(), "default_lang", strings.TrimSpace(body.DefaultLang))
	}

	token, userRec, err := s.auth.ClaimInitialAdminWithProfile(r.Context(), auth.SetupAdminInput{
		Username:     body.Username,
		Password:     body.Password,
		FullName:     body.FullName,
		Email:        body.Email,
		UPN:          body.UPN,
		Organization: body.OrgName,
		Department:   body.Department,
		Country:      body.Country,
		Province:     body.Province,
		Locality:     body.Locality,
	}, clientIP(r))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	// Optional Step 3: configure initial expiry notification channel
	if strings.TrimSpace(body.NotifyType) != "" && body.NotifyConfig != nil {
		chName := strings.TrimSpace(body.NotifyName)
		if chName == "" {
			chName = "Default Expiry Alerts"
		}
		_, _ = s.notifier.SaveChannel(r.Context(), "", chName, body.NotifyType, *body.NotifyConfig, body.AdvanceDays, true)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"token":    token,
		"username": userRec.Username,
		"role":     userRec.Role,
		"user":     userRec,
	})
}

func (s *Server) handleAuthChallenge(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.auth.GenerateChallenge())
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username  string `json:"username"`
		Password  string `json:"password"`
		Challenge string `json:"challenge"`
		Solution  string `json:"solution"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	token, userRec, err := s.auth.LoginWithUser(r.Context(), body.Username, body.Password, body.Challenge, body.Solution, clientIP(r))
	if err != nil {
		status := http.StatusUnauthorized
		if strings.Contains(err.Error(), "locked") || strings.Contains(err.Error(), "rate limit") {
			status = http.StatusTooManyRequests
		}
		writeErr(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":    token,
		"username": userRec.Username,
		"role":     userRec.Role,
		"user":     userRec,
	})
}

func (s *Server) handleGetProfile(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	u, err := s.store.GetUser(r.Context(), sess.Username)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if u == nil {
		active, _ := s.store.CountActiveCertificatesByUser(r.Context(), sess.Username)
		u = &store.UserRecord{
			Username:    sess.Username,
			Role:        sess.Role,
			CertQuota:   store.DefaultQuotaForRole(sess.Role),
			ActiveCerts: active,
			Enabled:     true,
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u})
}

func (s *Server) handleUpdateProfile(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	var body struct {
		FullName     string `json:"full_name"`
		Email        string `json:"email"`
		UPN          string `json:"upn"`
		Organization string `json:"organization"`
		Department   string `json:"department"`
		Country      string `json:"country"`
		Province     string `json:"province"`
		Locality     string `json:"locality"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	existing, _ := s.store.GetUser(r.Context(), sess.Username)
	if existing == nil {
		_ = s.store.UpsertUser(r.Context(), store.UserRecord{
			Username:     sess.Username,
			Role:         sess.Role,
			CertQuota:    store.DefaultQuotaForRole(sess.Role),
			FullName:     strings.TrimSpace(body.FullName),
			Email:        strings.TrimSpace(body.Email),
			UPN:          strings.TrimSpace(body.UPN),
			Organization: strings.TrimSpace(body.Organization),
			Department:   strings.TrimSpace(body.Department),
			Country:      strings.ToUpper(strings.TrimSpace(body.Country)),
			Province:     strings.TrimSpace(body.Province),
			Locality:     strings.TrimSpace(body.Locality),
			Enabled:      true,
		})
	} else {
		if err := s.store.UpdateUserProfile(
			r.Context(), sess.Username,
			strings.TrimSpace(body.FullName),
			strings.TrimSpace(body.Email),
			strings.TrimSpace(body.UPN),
			strings.TrimSpace(body.Organization),
			strings.TrimSpace(body.Department),
			strings.ToUpper(strings.TrimSpace(body.Country)),
			strings.TrimSpace(body.Province),
			strings.TrimSpace(body.Locality),
		); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:     sess.Username,
		Action:    "profile.update",
		ClientIP:  clientIP(r),
		CreatedAt: time.Now().Unix(),
	})
	updated, _ := s.store.GetUser(r.Context(), sess.Username)
	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request, _ *auth.SessionInfo) {
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if users == nil {
		users = []store.UserRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

func (s *Server) handleUpsertUser(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	var body struct {
		Username     string `json:"username"`
		Password     string `json:"password"`
		Role         string `json:"role"`
		CertQuota    int    `json:"cert_quota"`
		FullName     string `json:"full_name"`
		Email        string `json:"email"`
		UPN          string `json:"upn"`
		Organization string `json:"organization"`
		Department   string `json:"department"`
		Country      string `json:"country"`
		Province     string `json:"province"`
		Locality     string `json:"locality"`
		Enabled      *bool  `json:"enabled"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	username := strings.TrimSpace(r.PathValue("username"))
	if username == "" {
		username = strings.TrimSpace(body.Username)
	}
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	rec, err := s.auth.CreateOrUpdateUser(r.Context(), store.UserRecord{
		Username:     username,
		Role:         body.Role,
		CertQuota:    body.CertQuota,
		FullName:     strings.TrimSpace(body.FullName),
		Email:        strings.TrimSpace(body.Email),
		UPN:          strings.TrimSpace(body.UPN),
		Organization: strings.TrimSpace(body.Organization),
		Department:   strings.TrimSpace(body.Department),
		Country:      strings.ToUpper(strings.TrimSpace(body.Country)),
		Province:     strings.TrimSpace(body.Province),
		Locality:     strings.TrimSpace(body.Locality),
		Enabled:      enabled,
	}, body.Password)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:      sess.Username,
		Action:     "user.upsert",
		ClientIP:   clientIP(r),
		DetailJSON: `{"target":"` + rec.Username + `","role":"` + rec.Role + `"}`,
		CreatedAt:  time.Now().Unix(),
	})
	writeJSON(w, http.StatusOK, map[string]any{"user": rec})
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	target := strings.TrimSpace(r.PathValue("username"))
	if target == "" || target == sess.Username {
		writeErr(w, http.StatusBadRequest, "cannot delete active administrator account")
		return
	}
	if err := s.store.DeleteUser(r.Context(), target); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:      sess.Username,
		Action:     "user.delete",
		ClientIP:   clientIP(r),
		DetailJSON: `{"target":"` + target + `"}`,
		CreatedAt:  time.Now().Unix(),
	})
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (s *Server) handleListNotifyChannels(w http.ResponseWriter, r *http.Request, _ *auth.SessionInfo) {
	list, err := s.store.ListNotificationChannels(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if list == nil {
		list = []store.NotificationChannelRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": list})
}

func (s *Server) handleSaveNotifyChannel(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	var body struct {
		ID          string               `json:"id"`
		Name        string               `json:"name"`
		ChannelType string               `json:"channel_type"`
		Config      notify.ChannelConfig `json:"config"`
		AdvanceDays []int                `json:"advance_days"`
		Enabled     *bool                `json:"enabled"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	rec, err := s.notifier.SaveChannel(r.Context(), body.ID, body.Name, body.ChannelType, body.Config, body.AdvanceDays, enabled)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:      sess.Username,
		Action:     "notify.channel_save",
		ClientIP:   clientIP(r),
		DetailJSON: `{"channel_type":"` + rec.ChannelType + `","name":"` + rec.Name + `"}`,
		CreatedAt:  time.Now().Unix(),
	})
	writeJSON(w, http.StatusOK, map[string]any{"channel": rec})
}

func (s *Server) handleDeleteNotifyChannel(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	id := r.PathValue("id")
	if err := s.store.DeleteNotificationChannel(r.Context(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:     sess.Username,
		Action:    "notify.channel_delete",
		ClientIP:  clientIP(r),
		CreatedAt: time.Now().Unix(),
	})
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (s *Server) handleTestNotifyChannel(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	id := r.PathValue("id")
	logRec, err := s.notifier.SendTest(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:      sess.Username,
		Action:     "notify.test",
		ClientIP:   clientIP(r),
		DetailJSON: `{"status":"` + logRec.Status + `"}`,
		CreatedAt:  time.Now().Unix(),
	})
	writeJSON(w, http.StatusOK, map[string]any{"log": logRec})
}

func (s *Server) handleScanExpiring(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	summary, err := s.notifier.ScanExpiringCertificates(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:     sess.Username,
		Action:    "notify.scan_expiring",
		ClientIP:  clientIP(r),
		CreatedAt: time.Now().Unix(),
	})
	writeJSON(w, http.StatusOK, map[string]any{"summary": summary})
}

func (s *Server) handleListNotifyLogs(w http.ResponseWriter, r *http.Request, _ *auth.SessionInfo) {
	logs, err := s.store.ListNotificationLogs(r.Context(), 50)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if logs == nil {
		logs = []store.NotificationLogRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"logs": logs})
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	ov, err := s.pki.Overview(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	audits, _ := s.store.ListAudits(r.Context(), 8)
	userRec, _ := s.store.GetUser(r.Context(), sess.Username)
	if userRec == nil {
		active, _ := s.store.CountActiveCertificatesByUser(r.Context(), sess.Username)
		userRec = &store.UserRecord{
			Username:    sess.Username,
			Role:        sess.Role,
			CertQuota:   store.DefaultQuotaForRole(sess.Role),
			ActiveCerts: active,
			Enabled:     true,
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"overview":      ov,
		"cache":         s.cache.Status(),
		"recent_audits": audits,
		"current_user":  userRec,
	})
}

func (s *Server) handleListCerts(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	var certs []store.CertificateRecord
	var err error
	if sess.Role == store.RoleAdmin || sess.Role == store.RoleOperator {
		certs, err = s.store.ListCertificates(r.Context())
	} else {
		certs, err = s.store.ListCertificatesByUser(r.Context(), sess.Username)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if certs == nil {
		certs = []store.CertificateRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"certificates": certs})
}

func (s *Server) handleIssueCert(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	var req ca.IssueRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}

	// Look up user record for quota enforcement & profile fallback defaults
	maxQuota := store.DefaultQuotaForRole(sess.Role)
	if u, err := s.store.GetUser(r.Context(), sess.Username); err == nil && u != nil {
		if !u.Enabled {
			writeErr(w, http.StatusForbidden, "account is disabled")
			return
		}
		maxQuota = u.CertQuota
		if strings.TrimSpace(req.Organization) == "" && u.Organization != "" {
			req.Organization = u.Organization
		}
		if strings.TrimSpace(req.Department) == "" && u.Department != "" {
			req.Department = u.Department
		}
		if strings.TrimSpace(req.Email) == "" && u.Email != "" {
			req.Email = u.Email
		}
		if strings.TrimSpace(req.UPN) == "" && u.UPN != "" && (req.Profile == ca.ProfileEntraCBA || req.Profile == ca.ProfileWiFiEAP) {
			req.UPN = u.UPN
		}
		if strings.TrimSpace(req.Country) == "" {
			req.Country = u.Country
		}
		if strings.TrimSpace(req.Province) == "" {
			req.Province = u.Province
		}
		if strings.TrimSpace(req.Locality) == "" {
			req.Locality = u.Locality
		}
	}

	req.IssuedBy = sess.Username
	req.ClientIP = clientIP(r)
	req.MaxQuota = maxQuota

	res, err := s.pki.Issue(r.Context(), req)
	if err != nil {
		if errors.Is(err, store.ErrQuotaExceeded) {
			writeErr(w, http.StatusForbidden, err.Error())
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

func (s *Server) handleRevokeCert(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	serial := r.PathValue("serial")
	if sess.Role != store.RoleAdmin && sess.Role != store.RoleOperator {
		rec, err := s.store.GetCertificate(r.Context(), serial)
		if err != nil || rec == nil || rec.IssuedBy != sess.Username {
			writeErr(w, http.StatusForbidden, "you may only revoke certificates issued by your own account")
			return
		}
	}
	var body struct {
		Reason int `json:"reason"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body)
	if err := s.pki.Revoke(r.Context(), serial, body.Reason, sess.Username, clientIP(r)); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"revoked":      true,
		"serial_hex":   strings.ToUpper(serial),
		"cache_purged": true,
	})
}

func (s *Server) handleCRLInfo(w http.ResponseWriter, r *http.Request, _ *auth.SessionInfo) {
	revoked, err := s.store.ListRevokedCertificates(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	der, err := s.pki.GetCRLDER(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UTC().Unix()
	writeJSON(w, http.StatusOK, map[string]any{
		"crl_number":    now,
		"this_update":   now,
		"next_update":   now + 86400,
		"revoked_count": len(revoked),
		"der_bytes":     len(der),
		"der_url":       s.base + "/ca/crl.der",
		"pem_url":       s.base + "/ca/crl.pem",
	})
}

func (s *Server) handleOCSPCheckJSON(w http.ResponseWriter, r *http.Request, _ *auth.SessionInfo) {
	var body struct {
		SerialHex string `json:"serial_hex"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	clean := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(body.SerialHex), ":", ""))
	rec, err := s.store.GetCertificate(r.Context(), clean)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if rec == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"serial_hex": clean,
			"status":     "unknown",
			"checked_at": time.Now().Unix(),
		})
		return
	}
	ocspStatus := "good"
	if rec.Status == "revoked" {
		ocspStatus = "revoked"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"serial_hex":        rec.SerialHex,
		"common_name":       rec.CommonName,
		"status":            ocspStatus,
		"revoked_at":        rec.RevokedAt,
		"revocation_reason": rec.RevocationReason,
		"checked_at":        time.Now().Unix(),
	})
}

func (s *Server) handleListProvisioners(w http.ResponseWriter, r *http.Request, _ *auth.SessionInfo) {
	list, err := s.store.ListProvisioners(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if list == nil {
		list = []store.ProvisionerRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"provisioners": list})
}

func (s *Server) handleCreateProvisioner(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	var body struct {
		Name       string `json:"name"`
		Protocol   string `json:"protocol"`
		MaxTTLDays int    `json:"max_ttl_days"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "name is required")
		return
	}
	proto := strings.TrimSpace(body.Protocol)
	if proto == "" {
		proto = "vault_pki"
	}
	maxTTL := body.MaxTTLDays
	if maxTTL <= 0 || maxTTL > 1095 {
		maxTTL = 365
	}

	rawToken := "wca_" + store.GenerateRandomID(24)
	rec := store.ProvisionerRecord{
		ID:                  store.GenerateRandomID(8),
		Name:                name,
		Protocol:            proto,
		TokenHash:           auth.HashToken(rawToken),
		TokenPrefix:         rawToken[:12] + "...",
		AllowedProfilesJSON: `["tls_server","pdf_signing","entra_cba","tls_client","code_signing","smime_email","wifi_eap","iot_device"]`,
		MaxTTLDays:          maxTTL,
		Enabled:             true,
		CreatedAt:           time.Now().Unix(),
	}
	if err := s.store.InsertProvisioner(r.Context(), rec); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:     sess.Username,
		Action:    "provisioner.create",
		ClientIP:  clientIP(r),
		CreatedAt: rec.CreatedAt,
	})
	writeJSON(w, http.StatusCreated, map[string]any{
		"provisioner": rec,
		"token":       rawToken,
	})
}

func (s *Server) handleDeleteProvisioner(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	id := r.PathValue("id")
	if err := s.store.DeleteProvisioner(r.Context(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:     sess.Username,
		Action:    "provisioner.delete",
		ClientIP:  clientIP(r),
		CreatedAt: time.Now().Unix(),
	})
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (s *Server) handleListAudit(w http.ResponseWriter, r *http.Request, _ *auth.SessionInfo) {
	logs, err := s.store.ListAudits(r.Context(), 100)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if logs == nil {
		logs = []store.AuditRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"audits": logs})
}

func (s *Server) handleDownloadRoot(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/x-pem-file")
	w.Header().Set("Content-Disposition", `attachment; filename="wimotek-root-ca.crt"`)
	_, _ = w.Write([]byte(s.pki.RootPEM()))
}

func (s *Server) handleDownloadIssuing(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/x-pem-file")
	w.Header().Set("Content-Disposition", `attachment; filename="wimotek-issuing-ca.crt"`)
	_, _ = w.Write([]byte(s.pki.IssuingPEM()))
}

func (s *Server) handleDownloadChain(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/x-pem-file")
	w.Header().Set("Content-Disposition", `attachment; filename="wimotek-ca-chain.pem"`)
	_, _ = w.Write([]byte(s.pki.ChainPEM()))
}

func (s *Server) handleDownloadCRLDER(w http.ResponseWriter, r *http.Request) {
	der, err := s.pki.GetCRLDER(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/pkix-crl")
	w.Header().Set("Content-Disposition", `attachment; filename="wimotek-issuing.crl"`)
	_, _ = w.Write(der)
}

func (s *Server) handleDownloadCRLPEM(w http.ResponseWriter, r *http.Request) {
	pemBytes, err := s.pki.GetCRLPEM(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/x-pem-file")
	w.Header().Set("Content-Disposition", `attachment; filename="wimotek-issuing.crl.pem"`)
	_, _ = w.Write(pemBytes)
}

func (s *Server) handleOCSPResponder(w http.ResponseWriter, r *http.Request) {
	reqDER, err := io.ReadAll(io.LimitReader(r.Body, 64*1024))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "failed to read ocsp request")
		return
	}
	respDER, err := s.pki.HandleOCSP(r.Context(), reqDER)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/ocsp-response")
	_, _ = w.Write(respDER)
}

func (s *Server) handleVaultIssue(w http.ResponseWriter, r *http.Request, actor string) {
	role := r.PathValue("role")
	var body struct {
		CommonName string `json:"common_name"`
		AltNames   string `json:"alt_names"`
		IPSans     string `json:"ip_sans"`
		UPN        string `json:"upn"`
		Email      string `json:"email"`
		CSR        string `json:"csr"`
		TTLDays    int    `json:"ttl_days"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 128*1024)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid vault pki payload")
		return
	}
	var sans []string
	for _, s := range strings.Split(body.AltNames+","+body.IPSans, ",") {
		if trimmed := strings.TrimSpace(s); trimmed != "" {
			sans = append(sans, trimmed)
		}
	}
	res, err := s.pki.Issue(r.Context(), ca.IssueRequest{
		Profile:      role,
		CommonName:   body.CommonName,
		UPN:          body.UPN,
		Email:        body.Email,
		SANs:         sans,
		CSRPEM:       body.CSR,
		ValidityDays: body.TTLDays,
		IssuedBy:     actor,
		ClientIP:     clientIP(r),
		MaxQuota:     -1,
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"serial_number": res.Record.SerialHex,
			"certificate":   res.Record.CertPEM,
			"issuing_ca":    s.pki.IssuingPEM(),
			"ca_chain":      []string{s.pki.IssuingPEM(), s.pki.RootPEM()},
			"expiration":    res.Record.NotAfter,
		},
	})
}

func (s *Server) handleVaultRevoke(w http.ResponseWriter, r *http.Request, actor string) {
	var body struct {
		SerialNumber string `json:"serial_number"`
		Reason       int    `json:"reason"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid payload")
		return
	}
	clean := strings.ReplaceAll(body.SerialNumber, ":", "")
	if err := s.pki.Revoke(r.Context(), clean, body.Reason, actor, clientIP(r)); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{
			"revocation_time": time.Now().Unix(),
		},
	})
}

func (s *Server) handleACMEDirectory(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"newNonce":   s.base + "/acme/new-nonce",
		"newAccount": s.base + "/acme/new-account",
		"newOrder":   s.base + "/acme/new-order",
		"revokeCert": s.base + "/v1/pki/revoke",
		"meta": map[string]any{
			"website": s.base,
		},
	})
}

func (s *Server) handleACMENonce(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Replay-Nonce", store.GenerateRandomID(16))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
}

func (s *Server) requireSession(next func(http.ResponseWriter, *http.Request, *auth.SessionInfo)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := extractBearer(r)
		sess, err := s.auth.VerifySession(token)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r, sess)
	}
}

func (s *Server) requireAdmin(next func(http.ResponseWriter, *http.Request, *auth.SessionInfo)) http.HandlerFunc {
	return s.requireSession(func(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
		if sess.Role != store.RoleAdmin {
			writeErr(w, http.StatusForbidden, "administrator privileges required")
			return
		}
		next(w, r, sess)
	})
}

func (s *Server) requireAuthOrProvisioner(next func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := extractBearer(r)
		if token == "" {
			token = strings.TrimSpace(r.Header.Get("X-Vault-Token"))
		}
		if sess, err := s.auth.VerifySession(token); err == nil {
			next(w, r, sess.Username)
			return
		}
		if token != "" {
			prov, err := s.store.FindProvisionerByHash(r.Context(), auth.HashToken(token))
			if err == nil && prov != nil {
				next(w, r, "provisioner:"+prov.Name)
				return
			}
		}
		writeErr(w, http.StatusUnauthorized, "unauthorized")
	}
}

func (s *Server) handleSPA() http.Handler {
	fileServer := http.FileServer(http.FS(s.webFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := strings.TrimPrefix(r.URL.Path, "/")
		if clean == "" {
			clean = "index.html"
		}
		if f, err := s.webFS.Open(clean); err == nil {
			_ = f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}
		data, err := fs.ReadFile(s.webFS, "index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(data)
	})
}

func extractBearer(r *http.Request) string {
	h := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(h), "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeErr(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
