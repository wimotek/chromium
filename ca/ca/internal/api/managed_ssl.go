package api

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/wimotek/ca/internal/auth"
	"github.com/wimotek/ca/internal/ca"
	"github.com/wimotek/ca/internal/store"
)

// ManagedProxyPolicy defines global dual-engine ACME proxy & auto-renewal settings.
type ManagedProxyPolicy struct {
	Mode                   string `json:"mode"`
	AutoFailover           bool   `json:"auto_failover"`
	DefaultRenewBeforeDays int    `json:"default_renew_before_days"`
	CnameDelegationZone    string `json:"cname_delegation_zone"`
	AllowPrivateWebhooks   bool   `json:"allow_private_webhooks"`
}

type managedChallengeItem struct {
	Domain                string `json:"domain"`
	Method                string `json:"method"`
	RecordType            string `json:"record_type"`
	RecordHost            string `json:"record_host"`
	RecordValue           string `json:"record_value"`
	DelegationCnameHost   string `json:"delegation_cname_host,omitempty"`
	DelegationCnameTarget string `json:"delegation_cname_target,omitempty"`
	Status                string `json:"status"`
}

func defaultManagedProxyPolicy() ManagedProxyPolicy {
	return ManagedProxyPolicy{
		Mode:                   "dual_engine",
		AutoFailover:           true,
		DefaultRenewBeforeDays: 30,
		CnameDelegationZone:    "",
		AllowPrivateWebhooks:   false,
	}
}

func (s *Server) registerManagedSSLRoutes() {
	s.mux.HandleFunc("GET /acme/proxy/{upstreamId}/directory", s.handlePublicProxyDirectory)
	s.mux.HandleFunc("GET /api/managed/overview", s.requireSession(s.handleManagedOverview))
	s.mux.HandleFunc("PUT /api/managed/proxy-policy", s.requireAdmin(s.handleUpdateManagedPolicy))
	s.mux.HandleFunc("POST /api/managed/upstreams", s.requireAdmin(s.handleSaveManagedUpstream))
	s.mux.HandleFunc("DELETE /api/managed/upstreams/{id}", s.requireAdmin(s.handleDeleteManagedUpstream))
	s.mux.HandleFunc("POST /api/managed/upstreams/{id}/probe", s.requireAdmin(s.handleProbeManagedUpstream))
	s.mux.HandleFunc("POST /api/managed/dns-credentials", s.requireSession(s.handleCreateManagedDnsCred))
	s.mux.HandleFunc("DELETE /api/managed/dns-credentials/{id}", s.requireSession(s.handleDeleteManagedDnsCred))
	s.mux.HandleFunc("POST /api/managed/certs", s.requireSession(s.handleCreateManagedCert))
	s.mux.HandleFunc("POST /api/managed/certs/{id}/verify", s.requireSession(s.handleVerifyManagedCert))
	s.mux.HandleFunc("POST /api/managed/certs/{id}/renew", s.requireSession(s.handleRenewManagedCert))
	s.mux.HandleFunc("POST /api/managed/certs/{id}/check-dns", s.requireSession(s.handleCheckManagedCertDNS))
	s.mux.HandleFunc("POST /api/managed/certs/{id}/deploy", s.requireSession(s.handleDeployManagedCert))
	s.mux.HandleFunc("GET /api/managed/certs/{id}/bundle", s.requireSession(s.handleDownloadManagedBundle))
	s.mux.HandleFunc("DELETE /api/managed/certs/{id}", s.requireSession(s.handleDeleteManagedCert))
	s.mux.HandleFunc("POST /api/managed/scan-renew", s.requireAdmin(s.handleScanRenewManagedCerts))
}

func (s *Server) loadManagedPolicy(ctx context.Context) ManagedProxyPolicy {
	pol := defaultManagedProxyPolicy()
	raw, err := s.store.GetSetting(ctx, "managed_proxy_policy")
	if err == nil && strings.TrimSpace(raw) != "" {
		_ = json.Unmarshal([]byte(raw), &pol)
	}
	if pol.Mode == "" {
		pol.Mode = "dual_engine"
	}
	if pol.DefaultRenewBeforeDays < 1 || pol.DefaultRenewBeforeDays > 60 {
		pol.DefaultRenewBeforeDays = 30
	}
	return pol
}

func (s *Server) ensureDefaultManagedUpstreams(ctx context.Context) ([]store.ManagedUpstreamRecord, error) {
	list, err := s.store.ListManagedUpstreams(ctx)
	if err != nil {
		return nil, err
	}
	if len(list) > 0 {
		return list, nil
	}
	now := time.Now().Unix()
	presets := []store.ManagedUpstreamRecord{
		{
			ID:           "up_letsencrypt_prod",
			Name:         "Let's Encrypt (Production)",
			Provider:     "letsencrypt_prod",
			DirectoryURL: "https://acme-v02.api.letsencrypt.org/directory",
			RequiresEAB:  false,
			Priority:     1,
			Enabled:      true,
			CreatedAt:    now,
			UpdatedAt:    now,
		},
		{
			ID:           "up_google_trust",
			Name:         "Google Trust Services (GTS)",
			Provider:     "google_trust",
			DirectoryURL: "https://dv.acme-v02.api.pki.goog/directory",
			RequiresEAB:  true,
			Priority:     2,
			Enabled:      false,
			CreatedAt:    now,
			UpdatedAt:    now,
		},
		{
			ID:           "up_zerossl",
			Name:         "ZeroSSL (ACME v2 DV90)",
			Provider:     "zerossl",
			DirectoryURL: "https://acme.zerossl.com/v2/DV90",
			RequiresEAB:  true,
			Priority:     3,
			Enabled:      false,
			CreatedAt:    now,
			UpdatedAt:    now,
		},
		{
			ID:           "up_letsencrypt_staging",
			Name:         "Let's Encrypt (Staging / Sandbox)",
			Provider:     "letsencrypt_staging",
			DirectoryURL: "https://acme-staging-v02.api.letsencrypt.org/directory",
			RequiresEAB:  false,
			Priority:     4,
			Enabled:      true,
			CreatedAt:    now,
			UpdatedAt:    now,
		},
	}
	for _, p := range presets {
		_ = s.store.UpsertManagedUpstream(ctx, p)
	}
	return s.store.ListManagedUpstreams(ctx)
}

func validatePublicHTTPSURL(ctx context.Context, raw string, allowPrivate bool) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return nil, errors.New("invalid URL")
	}
	if u.Scheme != "https" && !(allowPrivate && u.Scheme == "http") {
		return nil, errors.New("only HTTPS URLs are permitted")
	}
	if u.User != nil {
		return nil, errors.New("embedded credentials in URLs are not permitted")
	}
	host := strings.ToLower(u.Hostname())
	if !allowPrivate {
		if host == "localhost" || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
			return nil, fmt.Errorf("blocked non-public host: %s", host)
		}
		if ip := net.ParseIP(host); ip != nil {
			if !isPublicRoutableIP(ip) {
				return nil, fmt.Errorf("blocked non-public IP: %s", host)
			}
		} else {
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil || len(ips) == 0 {
				return nil, fmt.Errorf("DNS lookup failed for %s", host)
			}
			for _, ipAddr := range ips {
				if !isPublicRoutableIP(ipAddr.IP) {
					return nil, fmt.Errorf("blocked non-public IP %s for %s", ipAddr.IP.String(), host)
				}
			}
		}
	}
	return u, nil
}

func safeManagedHTTPClient(allowPrivate bool) *http.Client {
	dialer := &net.Dialer{Timeout: 8 * time.Second}
	return &http.Client{
		Timeout: 12 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				host, port, err := net.SplitHostPort(addr)
				if err != nil {
					return nil, err
				}
				ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
				if err != nil || len(ips) == 0 {
					return nil, fmt.Errorf("resolve %s failed", host)
				}
				for _, ipAddr := range ips {
					if !allowPrivate && !isPublicRoutableIP(ipAddr.IP) {
						continue
					}
					return dialer.DialContext(ctx, network, net.JoinHostPort(ipAddr.IP.String(), port))
				}
				return nil, errors.New("no public routable IP available")
			},
		},
	}
}

func maskManagedPrefix(val string) string {
	s := strings.TrimSpace(val)
	if s == "" {
		return ""
	}
	if len(s) <= 10 {
		return "****"
	}
	return s[:6] + "..." + s[len(s)-4:]
}

func generateECKeyAndCSR(domains []string) (keyPEM string, csrPEM string, err error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", err
	}
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return "", "", err
	}
	tmpl := &x509.CertificateRequest{
		Subject:  pkix.Name{CommonName: domains[0]},
		DNSNames: domains,
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, tmpl, priv)
	if err != nil {
		return "", "", err
	}
	keyBlock := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	csrBlock := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER})
	return string(keyBlock), string(csrBlock), nil
}

func (s *Server) formatManagedCertJSON(c store.ManagedCertificateRecord) map[string]any {
	var domains []string
	_ = json.Unmarshal([]byte(c.DomainsJSON), &domains)
	var challenges []managedChallengeItem
	_ = json.Unmarshal([]byte(c.ChallengesJSON), &challenges)
	if domains == nil {
		domains = []string{}
	}
	if challenges == nil {
		challenges = []managedChallengeItem{}
	}
	return map[string]any{
		"id":                           c.ID,
		"owner_username":               c.OwnerUsername,
		"common_name":                  c.CommonName,
		"domains":                      domains,
		"engine_mode":                  c.EngineMode,
		"upstream_id":                  c.UpstreamID,
		"resolved_upstream_id":         c.ResolvedUpstreamID,
		"resolved_issuer_name":         c.ResolvedIssuerName,
		"challenge_method":             c.ChallengeMethod,
		"dns_credential_id":            c.DnsCredentialID,
		"cname_delegation_token":       c.CnameDelegationToken,
		"cname_delegation_target":      c.CnameDelegationTarget,
		"status":                       c.Status,
		"auto_renew":                   c.AutoRenew,
		"renew_before_days":            c.RenewBeforeDays,
		"upstream_order_url":           c.UpstreamOrderURL,
		"upstream_finalize_url":        c.UpstreamFinalizeURL,
		"challenges":                   challenges,
		"serial_hex":                   c.SerialHex,
		"fingerprint_sha256":           c.FingerprintSHA256,
		"not_before":                   c.NotBefore,
		"not_after":                    c.NotAfter,
		"cert_pem":                     c.CertPEM,
		"chain_pem":                    c.ChainPEM,
		"has_private_key":              c.PrivateKeyEnc != "",
		"deploy_webhook_url":           c.DeployWebhookURL,
		"deploy_webhook_secret_prefix": c.DeployWebhookSecretPrefix,
		"has_deploy_secret":            c.DeployWebhookSecretEnc != "",
		"last_deploy_at":               c.LastDeployAt,
		"last_deploy_status":           c.LastDeployStatus,
		"last_error":                   c.LastError,
		"last_renewed_at":              c.LastRenewedAt,
		"created_at":                   c.CreatedAt,
		"updated_at":                   c.UpdatedAt,
	}
}

func (s *Server) handlePublicProxyDirectory(w http.ResponseWriter, r *http.Request) {
	upID := strings.TrimSpace(r.PathValue("upstreamId"))
	up, err := s.store.GetManagedUpstream(r.Context(), upID)
	if err != nil || up == nil || !up.Enabled {
		writeErr(w, http.StatusNotFound, "upstream ACME proxy profile not found or disabled")
		return
	}
	base := s.acmeBaseURL(r)
	pol := s.loadManagedPolicy(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		"newNonce":   base + "/acme/new-nonce",
		"newAccount": base + "/acme/new-account",
		"newOrder":   base + "/acme/new-order",
		"revokeCert": base + "/acme/revoke-cert",
		"keyChange":  base + "/acme/key-change",
		"meta": map[string]any{
			"website":                 base,
			"externalAccountRequired": true,
			"upstreamProxy": map[string]any{
				"id":           up.ID,
				"name":         up.Name,
				"provider":     up.Provider,
				"directoryUrl": up.DirectoryURL,
				"autoFailover": pol.AutoFailover,
			},
		},
	})
}

func (s *Server) handleManagedOverview(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	ctx := r.Context()
	upstreams, _ := s.ensureDefaultManagedUpstreams(ctx)
	owner := sess.Username
	if sess.Role == store.RoleAdmin && r.URL.Query().Get("all") == "1" {
		owner = ""
	}
	certs, _ := s.store.ListManagedCertificates(ctx, owner)
	dnsCreds, _ := s.store.ListManagedDnsCredentials(ctx, owner)
	logs, _ := s.store.ListManagedDeployLogs(ctx, owner, 40)
	pol := s.loadManagedPolicy(ctx)
	base := s.acmeBaseURL(r)
	if pol.CnameDelegationZone == "" {
		if u, err := url.Parse(base); err == nil && u.Hostname() != "" {
			pol.CnameDelegationZone = "acme-auth." + u.Hostname()
		} else {
			pol.CnameDelegationZone = "acme-auth.wimotek.local"
		}
	}

	outUpstreams := make([]map[string]any, 0, len(upstreams))
	enabledUp := 0
	for _, u := range upstreams {
		if u.Enabled {
			enabledUp++
		}
		outUpstreams = append(outUpstreams, map[string]any{
			"id":                  u.ID,
			"name":                u.Name,
			"provider":            u.Provider,
			"directory_url":       u.DirectoryURL,
			"requires_eab":        u.RequiresEAB,
			"eab_kid":             u.EABKID,
			"eab_hmac_configured": u.EABHMACEnc != "",
			"eab_hmac_prefix":     u.EABHMACPrefix,
			"contact_email":       u.ContactEmail,
			"priority":            u.Priority,
			"enabled":             u.Enabled,
			"account_registered":  u.AccountURL != "",
			"last_probe_at":       u.LastProbeAt,
			"last_probe_ok":       u.LastProbeOK,
			"last_probe_ms":       u.LastProbeMS,
			"last_probe_error":    u.LastProbeError,
			"created_at":          u.CreatedAt,
			"updated_at":          u.UpdatedAt,
		})
	}

	now := time.Now().Unix()
	outCerts := make([]map[string]any, 0, len(certs))
	activeCnt, pendingCnt, dueCnt := 0, 0, 0
	for _, c := range certs {
		if c.Status == "active" {
			activeCnt++
			if c.NotAfter > 0 && c.NotAfter-now <= int64(c.RenewBeforeDays)*86400 {
				dueCnt++
			}
		} else if c.Status == "pending_validation" {
			pendingCnt++
		}
		outCerts = append(outCerts, s.formatManagedCertJSON(c))
	}

	if dnsCreds == nil {
		dnsCreds = make([]store.ManagedDnsCredentialRecord, 0)
	}
	if logs == nil {
		logs = make([]store.ManagedDeployLogRecord, 0)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"proxy_policy":    pol,
		"proxy_base_url":  base + "/acme/proxy",
		"upstreams":       outUpstreams,
		"dns_credentials": dnsCreds,
		"certificates":    outCerts,
		"deploy_logs":     logs,
		"stats": map[string]int{
			"total_certs":       len(outCerts),
			"active_certs":      activeCnt,
			"pending_certs":     pendingCnt,
			"due_renewal":       dueCnt,
			"enabled_upstreams": enabledUp,
		},
	})
}

func (s *Server) handleUpdateManagedPolicy(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	pol := s.loadManagedPolicy(r.Context())
	var body struct {
		Mode                   *string `json:"mode"`
		AutoFailover           *bool   `json:"auto_failover"`
		DefaultRenewBeforeDays *int    `json:"default_renew_before_days"`
		CnameDelegationZone    *string `json:"cname_delegation_zone"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json payload")
		return
	}
	if body.Mode != nil {
		m := strings.TrimSpace(*body.Mode)
		if m != "dual_engine" && m != "private_ca" && m != "upstream_proxy" {
			writeErr(w, http.StatusBadRequest, "invalid proxy mode")
			return
		}
		pol.Mode = m
	}
	if body.AutoFailover != nil {
		pol.AutoFailover = *body.AutoFailover
	}
	if body.DefaultRenewBeforeDays != nil {
		if *body.DefaultRenewBeforeDays < 1 || *body.DefaultRenewBeforeDays > 60 {
			writeErr(w, http.StatusBadRequest, "default_renew_before_days must be between 1 and 60")
			return
		}
		pol.DefaultRenewBeforeDays = *body.DefaultRenewBeforeDays
	}
	if body.CnameDelegationZone != nil {
		pol.CnameDelegationZone = strings.Trim(strings.ToLower(strings.TrimSpace(*body.CnameDelegationZone)), ".")
	}
	raw, _ := json.Marshal(pol)
	if err := s.store.SetSetting(r.Context(), "managed_proxy_policy", string(raw)); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:      sess.Username,
		Action:     "managed.policy_update",
		ClientIP:   clientIP(r),
		DetailJSON: string(raw),
	})
	writeJSON(w, http.StatusOK, map[string]any{"proxy_policy": pol})
}

func (s *Server) handleSaveManagedUpstream(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	var body struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		Provider     string `json:"provider"`
		DirectoryURL string `json:"directory_url"`
		RequiresEAB  bool   `json:"requires_eab"`
		EABKID       string `json:"eab_kid"`
		EABHMAC      string `json:"eab_hmac"`
		ContactEmail string `json:"contact_email"`
		Priority     int    `json:"priority"`
		Enabled      *bool  `json:"enabled"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json payload")
		return
	}
	name := strings.TrimSpace(body.Name)
	dirURL := strings.TrimSpace(body.DirectoryURL)
	if name == "" || dirURL == "" {
		writeErr(w, http.StatusBadRequest, "name and directory_url are required")
		return
	}
	if _, err := validatePublicHTTPSURL(r.Context(), dirURL, false); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	id := strings.TrimSpace(body.ID)
	if id == "" {
		id = "up_" + store.GenerateRandomID(6)
	}
	existing, _ := s.store.GetManagedUpstream(r.Context(), id)
	rec := store.ManagedUpstreamRecord{
		ID:           id,
		Name:         name,
		Provider:     strings.TrimSpace(body.Provider),
		DirectoryURL: dirURL,
		RequiresEAB:  body.RequiresEAB,
		EABKID:       strings.TrimSpace(body.EABKID),
		ContactEmail: strings.TrimSpace(body.ContactEmail),
		Priority:     body.Priority,
		Enabled:      true,
	}
	if rec.Provider == "" {
		rec.Provider = "custom"
	}
	if rec.Priority < 1 {
		rec.Priority = 1
	}
	if body.Enabled != nil {
		rec.Enabled = *body.Enabled
	}
	if existing != nil {
		rec.CreatedAt = existing.CreatedAt
		rec.EABHMACEnc = existing.EABHMACEnc
		rec.EABHMACPrefix = existing.EABHMACPrefix
		rec.AccountURL = existing.AccountURL
		rec.AccountKeyEnc = existing.AccountKeyEnc
		rec.LastProbeAt = existing.LastProbeAt
		rec.LastProbeOK = existing.LastProbeOK
		rec.LastProbeMS = existing.LastProbeMS
		rec.LastProbeError = existing.LastProbeError
	}
	if hmacPlain := strings.TrimSpace(body.EABHMAC); hmacPlain != "" {
		enc, err := s.pki.EncryptSecret([]byte(hmacPlain))
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		rec.EABHMACEnc = enc
		rec.EABHMACPrefix = maskManagedPrefix(hmacPlain)
	}
	if err := s.store.UpsertManagedUpstream(r.Context(), rec); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:      sess.Username,
		Action:     "managed.upstream_save",
		ClientIP:   clientIP(r),
		DetailJSON: fmt.Sprintf(`{"id":%q,"name":%q}`, rec.ID, rec.Name),
	})
	status := http.StatusCreated
	if existing != nil {
		status = http.StatusOK
	}
	writeJSON(w, status, map[string]any{"upstream": rec})
}

func (s *Server) handleDeleteManagedUpstream(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	id := strings.TrimSpace(r.PathValue("id"))
	if err := s.store.DeleteManagedUpstream(r.Context(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:    sess.Username,
		Action:   "managed.upstream_delete",
		ClientIP: clientIP(r),
	})
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

func (s *Server) handleProbeManagedUpstream(w http.ResponseWriter, r *http.Request, _ *auth.SessionInfo) {
	id := strings.TrimSpace(r.PathValue("id"))
	up, err := s.store.GetManagedUpstream(r.Context(), id)
	if err != nil || up == nil {
		writeErr(w, http.StatusNotFound, "upstream CA not found")
		return
	}
	if _, err := validatePublicHTTPSURL(r.Context(), up.DirectoryURL, false); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	start := time.Now()
	client := safeManagedHTTPClient(false)
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, up.DirectoryURL, nil)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Wimotek-PKI-Proxy/1.0")
	resp, err := client.Do(req)
	latency := int(time.Since(start).Milliseconds())
	up.LastProbeAt = time.Now().Unix()
	up.LastProbeMS = latency
	if err != nil {
		up.LastProbeOK = false
		up.LastProbeError = err.Error()
		_ = s.store.UpsertManagedUpstream(r.Context(), *up)
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error(), "upstream": up})
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	var dir map[string]any
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && json.Unmarshal(body, &dir) == nil && dir["newOrder"] != nil {
		up.LastProbeOK = true
		up.LastProbeError = ""
		_ = s.store.UpsertManagedUpstream(r.Context(), *up)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "latency_ms": latency, "directory": dir, "upstream": up})
		return
	}
	up.LastProbeOK = false
	up.LastProbeError = fmt.Sprintf("HTTP %d invalid ACME directory", resp.StatusCode)
	_ = s.store.UpsertManagedUpstream(r.Context(), *up)
	writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": up.LastProbeError, "upstream": up})
}

func (s *Server) handleCreateManagedDnsCred(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	var body struct {
		Name            string `json:"name"`
		Provider        string `json:"provider"`
		ZoneHint        string `json:"zone_hint"`
		APIToken        string `json:"api_token"`
		AccessKeyID     string `json:"access_key_id"`
		AccessKeySecret string `json:"access_key_secret"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json payload")
		return
	}
	if strings.TrimSpace(body.Name) == "" || (strings.TrimSpace(body.APIToken) == "" && strings.TrimSpace(body.AccessKeyID) == "") {
		writeErr(w, http.StatusBadRequest, "name and API credentials are required")
		return
	}
	secretPayload, _ := json.Marshal(map[string]string{
		"api_token":         strings.TrimSpace(body.APIToken),
		"access_key_id":     strings.TrimSpace(body.AccessKeyID),
		"access_key_secret": strings.TrimSpace(body.AccessKeySecret),
	})
	enc, err := s.pki.EncryptSecret(secretPayload)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	prefixSeed := strings.TrimSpace(body.APIToken)
	if prefixSeed == "" {
		prefixSeed = strings.TrimSpace(body.AccessKeyID)
	}
	now := time.Now().Unix()
	rec := store.ManagedDnsCredentialRecord{
		ID:            "dns_" + store.GenerateRandomID(6),
		OwnerUsername: sess.Username,
		Name:          strings.TrimSpace(body.Name),
		Provider:      strings.TrimSpace(body.Provider),
		ZoneHint:      strings.ToLower(strings.TrimSpace(body.ZoneHint)),
		SecretEnc:     enc,
		SecretPrefix:  maskManagedPrefix(prefixSeed),
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := s.store.InsertManagedDnsCredential(r.Context(), rec); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"credential": rec})
}

func (s *Server) handleDeleteManagedDnsCred(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	id := strings.TrimSpace(r.PathValue("id"))
	list, _ := s.store.ListManagedDnsCredentials(r.Context(), "")
	var found *store.ManagedDnsCredentialRecord
	for i := range list {
		if list[i].ID == id {
			found = &list[i]
			break
		}
	}
	if found == nil {
		writeErr(w, http.StatusNotFound, "DNS credential not found")
		return
	}
	if found.OwnerUsername != sess.Username && sess.Role != store.RoleAdmin {
		writeErr(w, http.StatusForbidden, "forbidden")
		return
	}
	_ = s.store.DeleteManagedDnsCredential(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

func (s *Server) handleCreateManagedCert(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	var body struct {
		Domains             []string `json:"domains"`
		EngineMode          string   `json:"engine_mode"`
		UpstreamID          string   `json:"upstream_id"`
		ChallengeMethod     string   `json:"challenge_method"`
		DnsCredentialID     string   `json:"dns_credential_id"`
		AutoRenew           *bool    `json:"auto_renew"`
		RenewBeforeDays     int      `json:"renew_before_days"`
		DeployWebhookURL    string   `json:"deploy_webhook_url"`
		DeployWebhookSecret string   `json:"deploy_webhook_secret"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json payload")
		return
	}
	var domains []string
	seen := map[string]bool{}
	for _, raw := range body.Domains {
		norm, _, err := validateACMEDomain(raw, true)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		if !seen[norm] {
			seen[norm] = true
			domains = append(domains, norm)
		}
	}
	if len(domains) == 0 {
		writeErr(w, http.StatusBadRequest, "at least one valid domain is required")
		return
	}
	pol := s.loadManagedPolicy(r.Context())
	if wh := strings.TrimSpace(body.DeployWebhookURL); wh != "" {
		if _, err := validatePublicHTTPSURL(r.Context(), wh, pol.AllowPrivateWebhooks); err != nil {
			writeErr(w, http.StatusBadRequest, "deploy webhook blocked: "+err.Error())
			return
		}
	}

	engineMode := "upstream_public"
	if body.EngineMode == "private_ca" {
		engineMode = "private_ca"
	}
	method := strings.TrimSpace(body.ChallengeMethod)
	if method == "" {
		method = "cname_delegation"
	}
	renewDays := body.RenewBeforeDays
	if renewDays < 1 || renewDays > 60 {
		renewDays = pol.DefaultRenewBeforeDays
	}
	zone := pol.CnameDelegationZone
	if zone == "" {
		if u, err := url.Parse(s.acmeBaseURL(r)); err == nil && u.Hostname() != "" {
			zone = "acme-auth." + u.Hostname()
		} else {
			zone = "acme-auth.wimotek.local"
		}
	}

	token := store.GenerateRandomID(8)
	target := token + "." + zone
	now := time.Now().Unix()
	autoRenew := true
	if body.AutoRenew != nil {
		autoRenew = *body.AutoRenew
	}

	domJSON, _ := json.Marshal(domains)
	challenges := make([]managedChallengeItem, 0, len(domains))
	for _, d := range domains {
		baseDom := strings.TrimPrefix(d, "*.")
		challenges = append(challenges, managedChallengeItem{
			Domain:                d,
			Method:                method,
			RecordType:            "CNAME",
			RecordHost:            "_acme-challenge." + baseDom,
			RecordValue:           target,
			DelegationCnameHost:   "_acme-challenge." + baseDom,
			DelegationCnameTarget: target,
			Status:                "pending",
		})
	}
	challJSON, _ := json.Marshal(challenges)

	rec := store.ManagedCertificateRecord{
		ID:                    "mcert_" + store.GenerateRandomID(6),
		OwnerUsername:         sess.Username,
		CommonName:            domains[0],
		DomainsJSON:           string(domJSON),
		EngineMode:            engineMode,
		UpstreamID:            strings.TrimSpace(body.UpstreamID),
		ChallengeMethod:       method,
		DnsCredentialID:       strings.TrimSpace(body.DnsCredentialID),
		CnameDelegationToken:  token,
		CnameDelegationTarget: target,
		Status:                "pending_validation",
		AutoRenew:             autoRenew,
		RenewBeforeDays:       renewDays,
		ChallengesJSON:        string(challJSON),
		DeployWebhookURL:      strings.TrimSpace(body.DeployWebhookURL),
		CreatedAt:             now,
		UpdatedAt:             now,
	}
	if rec.UpstreamID == "" {
		rec.UpstreamID = "auto"
	}
	if whSec := strings.TrimSpace(body.DeployWebhookSecret); whSec != "" {
		if enc, err := s.pki.EncryptSecret([]byte(whSec)); err == nil {
			rec.DeployWebhookSecretEnc = enc
			rec.DeployWebhookSecretPrefix = maskManagedPrefix(whSec)
		}
	}

	if engineMode == "private_ca" {
		keyPEM, csrPEM, err := generateECKeyAndCSR(domains)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		issued, err := s.pki.Issue(r.Context(), ca.IssueRequest{
			Profile:         ca.ProfileTLSServer,
			CommonName:      domains[0],
			SANs:            domains,
			ValidityDays:    90,
			CSRPEM:          csrPEM,
			IssuedBy:        sess.Username,
			ClientIP:        clientIP(r),
			MaxQuota:        -1,
			KeyModeOverride: "acme_csr",
		})
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		encKey, _ := s.pki.EncryptSecret([]byte(keyPEM))
		rec.Status = "active"
		rec.ResolvedIssuerName = "Wimotek Private Issuing CA"
		rec.SerialHex = issued.Record.SerialHex
		rec.FingerprintSHA256 = issued.Record.FingerprintSHA256
		rec.NotBefore = issued.Record.NotBefore
		rec.NotAfter = issued.Record.NotAfter
		rec.CertPEM = issued.Record.CertPEM
		rec.ChainPEM = issued.ChainPEM
		rec.PrivateKeyEnc = encKey
		rec.LastRenewedAt = now
		for i := range challenges {
			challenges[i].Status = "valid"
		}
		cj, _ := json.Marshal(challenges)
		rec.ChallengesJSON = string(cj)
		_ = s.store.AppendManagedDeployLog(r.Context(), store.ManagedDeployLogRecord{
			CertID:        rec.ID,
			OwnerUsername: sess.Username,
			CommonName:    rec.CommonName,
			Action:        "issue",
			Target:        "Wimotek Private Issuing CA",
			Status:        "ok",
			Detail:        "Issued managed certificate " + rec.SerialHex,
		})
	} else {
		ups, _ := s.ensureDefaultManagedUpstreams(r.Context())
		for _, u := range ups {
			if (rec.UpstreamID == "auto" && u.Enabled) || u.ID == rec.UpstreamID {
				rec.ResolvedUpstreamID = u.ID
				rec.ResolvedIssuerName = u.Name
				break
			}
		}
	}

	if err := s.store.UpsertManagedCertificate(r.Context(), rec); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"certificate": s.formatManagedCertJSON(rec)})
}

func (s *Server) handleVerifyManagedCert(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	s.issueOrRenewManagedCert(w, r, sess, false)
}

func (s *Server) handleRenewManagedCert(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	s.issueOrRenewManagedCert(w, r, sess, true)
}

func (s *Server) issueOrRenewManagedCert(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo, isRenew bool) {
	id := strings.TrimSpace(r.PathValue("id"))
	rec, err := s.store.GetManagedCertificate(r.Context(), id)
	if err != nil || rec == nil {
		writeErr(w, http.StatusNotFound, "managed certificate not found")
		return
	}
	if rec.OwnerUsername != sess.Username && sess.Role != store.RoleAdmin {
		writeErr(w, http.StatusForbidden, "forbidden")
		return
	}
	var domains []string
	_ = json.Unmarshal([]byte(rec.DomainsJSON), &domains)
	if len(domains) == 0 {
		domains = []string{rec.CommonName}
	}

	if rec.EngineMode == "private_ca" {
		keyPEM, csrPEM, err := generateECKeyAndCSR(domains)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		issued, err := s.pki.Issue(r.Context(), ca.IssueRequest{
			Profile:         ca.ProfileTLSServer,
			CommonName:      rec.CommonName,
			SANs:            domains,
			ValidityDays:    90,
			CSRPEM:          csrPEM,
			IssuedBy:        rec.OwnerUsername,
			ClientIP:        clientIP(r),
			MaxQuota:        -1,
			KeyModeOverride: "acme_csr",
		})
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		encKey, _ := s.pki.EncryptSecret([]byte(keyPEM))
		rec.Status = "active"
		rec.SerialHex = issued.Record.SerialHex
		rec.FingerprintSHA256 = issued.Record.FingerprintSHA256
		rec.NotBefore = issued.Record.NotBefore
		rec.NotAfter = issued.Record.NotAfter
		rec.CertPEM = issued.Record.CertPEM
		rec.ChainPEM = issued.ChainPEM
		rec.PrivateKeyEnc = encKey
		rec.LastError = ""
		rec.LastRenewedAt = time.Now().Unix()
		_ = s.store.UpsertManagedCertificate(r.Context(), *rec)
		act := "issue"
		if isRenew {
			act = "renew"
		}
		_ = s.store.AppendManagedDeployLog(r.Context(), store.ManagedDeployLogRecord{
			CertID:        rec.ID,
			OwnerUsername: rec.OwnerUsername,
			CommonName:    rec.CommonName,
			Action:        act,
			Target:        "Wimotek Private Issuing CA",
			Status:        "ok",
			Detail:        "Serial " + rec.SerialHex,
		})
		writeJSON(w, http.StatusOK, map[string]any{"certificate": s.formatManagedCertJSON(*rec)})
		return
	}

	writeErr(w, http.StatusBadRequest, "verify CNAME/DNS-01 propagation on public DNS before completing upstream public CA issuance")
}

func (s *Server) handleCheckManagedCertDNS(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	id := strings.TrimSpace(r.PathValue("id"))
	rec, err := s.store.GetManagedCertificate(r.Context(), id)
	if err != nil || rec == nil {
		writeErr(w, http.StatusNotFound, "managed certificate not found")
		return
	}
	if rec.OwnerUsername != sess.Username && sess.Role != store.RoleAdmin {
		writeErr(w, http.StatusForbidden, "forbidden")
		return
	}
	var challs []managedChallengeItem
	_ = json.Unmarshal([]byte(rec.ChallengesJSON), &challs)
	checks := make([]map[string]any, 0, len(challs))
	allMatched := len(challs) > 0
	for _, ch := range challs {
		host := ch.DelegationCnameHost
		if host == "" {
			host = ch.RecordHost
		}
		observed := []string{}
		matched := false
		if cname, err := net.DefaultResolver.LookupCNAME(r.Context(), host); err == nil && cname != "" {
			clean := strings.TrimSuffix(strings.ToLower(cname), ".")
			observed = append(observed, "CNAME "+clean)
			if clean == strings.TrimSuffix(strings.ToLower(ch.DelegationCnameTarget), ".") {
				matched = true
			}
		}
		if txts, err := net.DefaultResolver.LookupTXT(r.Context(), host); err == nil {
			for _, t := range txts {
				observed = append(observed, "TXT "+t)
				if t == ch.RecordValue {
					matched = true
				}
			}
		}
		if !matched {
			allMatched = false
		}
		checks = append(checks, map[string]any{
			"domain":   ch.Domain,
			"host":     host,
			"expected": ch.RecordValue,
			"observed": observed,
			"matched":  matched,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"all_matched": allMatched, "checks": checks})
}

func (s *Server) handleDeployManagedCert(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	id := strings.TrimSpace(r.PathValue("id"))
	rec, err := s.store.GetManagedCertificate(r.Context(), id)
	if err != nil || rec == nil {
		writeErr(w, http.StatusNotFound, "managed certificate not found")
		return
	}
	if rec.OwnerUsername != sess.Username && sess.Role != store.RoleAdmin {
		writeErr(w, http.StatusForbidden, "forbidden")
		return
	}
	if rec.DeployWebhookURL == "" || rec.ChainPEM == "" {
		writeErr(w, http.StatusBadRequest, "certificate must be issued and have a deploy_webhook_url configured")
		return
	}
	pol := s.loadManagedPolicy(r.Context())
	if _, err := validatePublicHTTPSURL(r.Context(), rec.DeployWebhookURL, pol.AllowPrivateWebhooks); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	keyPEM := ""
	if rec.PrivateKeyEnc != "" {
		if raw, err := s.pki.DecryptSecret(rec.PrivateKeyEnc); err == nil {
			keyPEM = string(raw)
		}
	}
	payloadBytes, _ := json.Marshal(map[string]any{
		"event":           "managed_cert.manual_deploy",
		"cert_id":         rec.ID,
		"common_name":     rec.CommonName,
		"serial_hex":      rec.SerialHex,
		"not_after":       rec.NotAfter,
		"chain_pem":       rec.ChainPEM,
		"private_key_pem": keyPEM,
	})
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, rec.DeployWebhookURL, bytes.NewReader(payloadBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wimotek-Event", "managed_cert.deployed")
	if rec.DeployWebhookSecretEnc != "" {
		if sec, err := s.pki.DecryptSecret(rec.DeployWebhookSecretEnc); err == nil {
			mac := hmac.New(sha256.New, sec)
			mac.Write(payloadBytes)
			req.Header.Set("X-Wimotek-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		}
	}
	resp, err := safeManagedHTTPClient(pol.AllowPrivateWebhooks).Do(req)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	ok := resp.StatusCode >= 200 && resp.StatusCode < 300
	detail := fmt.Sprintf("HTTP %d", resp.StatusCode)
	rec.LastDeployAt = time.Now().Unix()
	if ok {
		rec.LastDeployStatus = "ok (" + detail + ")"
	} else {
		rec.LastDeployStatus = "failed (" + detail + ")"
	}
	_ = s.store.UpsertManagedCertificate(r.Context(), *rec)
	st := "ok"
	if !ok {
		st = "error"
	}
	_ = s.store.AppendManagedDeployLog(r.Context(), store.ManagedDeployLogRecord{
		CertID:        rec.ID,
		OwnerUsername: rec.OwnerUsername,
		CommonName:    rec.CommonName,
		Action:        "deploy_webhook",
		Target:        rec.DeployWebhookURL,
		Status:        st,
		Detail:        detail,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": ok, "status": resp.StatusCode, "detail": detail, "certificate": s.formatManagedCertJSON(*rec)})
}

func (s *Server) handleDownloadManagedBundle(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	id := strings.TrimSpace(r.PathValue("id"))
	rec, err := s.store.GetManagedCertificate(r.Context(), id)
	if err != nil || rec == nil {
		writeErr(w, http.StatusNotFound, "managed certificate not found")
		return
	}
	if rec.OwnerUsername != sess.Username && sess.Role != store.RoleAdmin {
		writeErr(w, http.StatusForbidden, "forbidden")
		return
	}
	if rec.ChainPEM == "" {
		writeErr(w, http.StatusBadRequest, "certificate not yet issued")
		return
	}
	keyPEM := ""
	if rec.PrivateKeyEnc != "" {
		if raw, err := s.pki.DecryptSecret(rec.PrivateKeyEnc); err == nil {
			keyPEM = string(raw)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":              rec.ID,
		"common_name":     rec.CommonName,
		"serial_hex":      rec.SerialHex,
		"cert_pem":        rec.CertPEM,
		"chain_pem":       rec.ChainPEM,
		"private_key_pem": keyPEM,
	})
}

func (s *Server) handleDeleteManagedCert(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	id := strings.TrimSpace(r.PathValue("id"))
	rec, err := s.store.GetManagedCertificate(r.Context(), id)
	if err != nil || rec == nil {
		writeErr(w, http.StatusNotFound, "managed certificate not found")
		return
	}
	if rec.OwnerUsername != sess.Username && sess.Role != store.RoleAdmin {
		writeErr(w, http.StatusForbidden, "forbidden")
		return
	}
	_ = s.store.DeleteManagedCertificate(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

func (s *Server) handleScanRenewManagedCerts(w http.ResponseWriter, r *http.Request, _ *auth.SessionInfo) {
	certs, _ := s.store.ListManagedCertificates(r.Context(), "")
	now := time.Now().Unix()
	due := 0
	renewed := []string{}
	for _, rec := range certs {
		if !rec.AutoRenew || rec.Status != "active" || rec.NotAfter == 0 {
			continue
		}
		if rec.NotAfter-now <= int64(rec.RenewBeforeDays)*86400 {
			due++
			if rec.EngineMode == "private_ca" {
				var domains []string
				_ = json.Unmarshal([]byte(rec.DomainsJSON), &domains)
				if len(domains) == 0 {
					domains = []string{rec.CommonName}
				}
				if keyPEM, csrPEM, err := generateECKeyAndCSR(domains); err == nil {
					if issued, err := s.pki.Issue(r.Context(), ca.IssueRequest{
						Profile:         ca.ProfileTLSServer,
						CommonName:      rec.CommonName,
						SANs:            domains,
						ValidityDays:    90,
						CSRPEM:          csrPEM,
						IssuedBy:        rec.OwnerUsername,
						ClientIP:        clientIP(r),
						MaxQuota:        -1,
						KeyModeOverride: "acme_csr",
					}); err == nil {
						encKey, _ := s.pki.EncryptSecret([]byte(keyPEM))
						rec.SerialHex = issued.Record.SerialHex
						rec.FingerprintSHA256 = issued.Record.FingerprintSHA256
						rec.NotBefore = issued.Record.NotBefore
						rec.NotAfter = issued.Record.NotAfter
						rec.CertPEM = issued.Record.CertPEM
						rec.ChainPEM = issued.ChainPEM
						rec.PrivateKeyEnc = encKey
						rec.LastRenewedAt = time.Now().Unix()
						_ = s.store.UpsertManagedCertificate(r.Context(), rec)
						renewed = append(renewed, rec.ID)
					}
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"scanned": len(certs), "due": due, "renewed": renewed})
}
