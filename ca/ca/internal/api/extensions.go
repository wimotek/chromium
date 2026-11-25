package api

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/wimotek/ca/internal/auth"
	"github.com/wimotek/ca/internal/ca"
	"github.com/wimotek/ca/internal/store"
)

func (s *Server) registerExtensionRoutes() {
	// Extended Automation APIs
	s.mux.HandleFunc("GET /api/certificates/expiring", s.requireAuthOrProvisioner(s.handleExpiringCerts))
	s.mux.HandleFunc("POST /api/certificates/{serial}/renew", s.requireAuthOrProvisioner(s.handleRenewCert))
	s.mux.HandleFunc("POST /api/certificates/batch-issue", s.requireAuthOrProvisioner(s.handleBatchIssue))
	s.mux.HandleFunc("GET /api/ca/bundle", s.handleCABundle)
	s.mux.HandleFunc("GET /api/openapi.json", s.handleOpenAPISpec)

	// Multi-Purpose User API Tokens (compatible alias over provisioners)
	s.mux.HandleFunc("GET /api/tokens", s.requireSession(s.handleListTokens))
	s.mux.HandleFunc("POST /api/tokens", s.requireSession(s.handleCreateToken))
	s.mux.HandleFunc("DELETE /api/tokens/{id}", s.requireSession(s.handleDeleteToken))

	// Personal ServerChan-Compatible Webhook Relay
	s.mux.HandleFunc("GET /api/webhook/me", s.requireSession(s.handleGetMyWebhook))
	s.mux.HandleFunc("POST /api/webhook/rotate", s.requireSession(s.handleRotateMyWebhook))
	s.mux.HandleFunc("POST /api/webhook/send", s.requireAuthOrProvisioner(s.handleWebhookSendAPI))
	s.mux.HandleFunc("GET /webhook/{username}/{key}", s.handlePersonalWebhookRelay)
	s.mux.HandleFunc("POST /webhook/{username}/{key}", s.handlePersonalWebhookRelay)

	// Model Context Protocol (MCP) JSON-RPC 2.0 Server
	s.mux.HandleFunc("GET /mcp/manifest", s.handleMCPManifest)
	s.mux.HandleFunc("POST /mcp", s.requireAuthOrProvisioner(s.handleMCPJSONRPC))
}

func (s *Server) handleExpiringCerts(w http.ResponseWriter, r *http.Request, _ string) {
	days := 30
	if raw := strings.TrimSpace(r.URL.Query().Get("days")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= 3650 {
			days = parsed
		}
	}
	certs, err := s.store.ListCertificates(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().Unix()
	cutoff := now + int64(days)*86400
	expiring := make([]store.CertificateRecord, 0)
	for _, c := range certs {
		if c.Status == "active" && c.NotAfter > now && c.NotAfter <= cutoff {
			expiring = append(expiring, c)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"days":         days,
		"certificates": expiring,
	})
}

func (s *Server) handleRenewCert(w http.ResponseWriter, r *http.Request, actor string) {
	serial := strings.TrimSpace(r.PathValue("serial"))
	orig, err := s.store.GetCertificate(r.Context(), serial)
	if err != nil || orig == nil {
		writeErr(w, http.StatusNotFound, "certificate not found")
		return
	}
	var body struct {
		ValidityDays int    `json:"validity_days"`
		RevokeOld    bool   `json:"revoke_old"`
		PFXPassword  string `json:"pfx_password"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body)

	var sans []string
	_ = json.Unmarshal([]byte(orig.SANsJSON), &sans)
	validityDays := body.ValidityDays
	if validityDays <= 0 {
		validityDays = int((orig.NotAfter - orig.NotBefore) / 86400)
		if validityDays <= 0 {
			validityDays = 90
		}
	}

	res, err := s.pki.Issue(r.Context(), ca.IssueRequest{
		Profile:      orig.Profile,
		CommonName:   orig.CommonName,
		UPN:          orig.UPN,
		SANs:         sans,
		ValidityDays: validityDays,
		PFXPassword:  body.PFXPassword,
		IssuedBy:     actor,
		ClientIP:     clientIP(r),
		MaxQuota:     -1,
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	oldRevoked := false
	if body.RevokeOld && orig.Status == "active" {
		if revErr := s.pki.Revoke(r.Context(), orig.SerialHex, 4, actor, clientIP(r)); revErr == nil {
			oldRevoked = true
		}
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"certificate":       res.Record,
		"chain_pem":         res.ChainPEM,
		"pfx_base64":        res.PFXBase64,
		"filename":          res.Filename,
		"old_serial_revoked": oldRevoked,
	})
}

func (s *Server) handleBatchIssue(w http.ResponseWriter, r *http.Request, actor string) {
	var body struct {
		Items []struct {
			Profile      string   `json:"profile"`
			CommonName   string   `json:"common_name"`
			Organization string   `json:"organization"`
			Department   string   `json:"department"`
			Email        string   `json:"email"`
			UPN          string   `json:"upn"`
			SANs         []string `json:"sans"`
			ValidityDays int      `json:"validity_days"`
		} `json:"items"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json payload")
		return
	}
	if len(body.Items) == 0 || len(body.Items) > 25 {
		writeErr(w, http.StatusBadRequest, "items must contain between 1 and 25 entries")
		return
	}
	results := make([]map[string]any, 0, len(body.Items))
	for _, item := range body.Items {
		res, err := s.pki.Issue(r.Context(), ca.IssueRequest{
			Profile:      item.Profile,
			CommonName:   item.CommonName,
			Organization: item.Organization,
			Department:   item.Department,
			Email:        item.Email,
			UPN:          item.UPN,
			SANs:         item.SANs,
			ValidityDays: item.ValidityDays,
			IssuedBy:     actor,
			ClientIP:     clientIP(r),
			MaxQuota:     -1,
		})
		if err != nil {
			results = append(results, map[string]any{
				"common_name": item.CommonName,
				"error":       err.Error(),
			})
			continue
		}
		results = append(results, map[string]any{
			"certificate": res.Record,
			"chain_pem":   res.ChainPEM,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (s *Server) handleCABundle(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"root_pem":    s.pki.RootPEM(),
		"issuing_pem": s.pki.IssuingPEM(),
		"chain_pem":   s.pki.IssuingPEM() + "\n" + s.pki.RootPEM(),
		"base_url":    s.base,
	})
}

func (s *Server) handleOpenAPISpec(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"openapi": "3.0.3",
		"info": map[string]any{
			"title":   "wimotek/ca Enterprise PKI API",
			"version": "2.0.0",
		},
		"servers": []map[string]string{{"url": s.base}},
		"paths": map[string]any{
			"/api/certificates":                map[string]any{"get": map[string]string{"summary": "List certificates"}, "post": map[string]string{"summary": "Issue certificate"}},
			"/api/certificates/expiring":       map[string]any{"get": map[string]string{"summary": "List expiring certificates"}},
			"/api/certificates/{serial}/renew": map[string]any{"post": map[string]string{"summary": "Renew certificate"}},
			"/api/certificates/batch-issue":    map[string]any{"post": map[string]string{"summary": "Batch issue certificates"}},
			"/api/tokens":                      map[string]any{"get": map[string]string{"summary": "List API tokens"}, "post": map[string]string{"summary": "Create scoped API token"}},
			"/api/webhook/send":                map[string]any{"post": map[string]string{"summary": "Send ServerChan-format webhook relay"}},
			"/webhook/{username}/{key}.send":   map[string]any{"post": map[string]string{"summary": "Personal ServerChan webhook endpoint"}},
			"/v1/pki/issue/{role}":             map[string]any{"post": map[string]string{"summary": "OpenBao / Vault PKI compatible issue"}},
			"/acme/directory":                  map[string]any{"get": map[string]string{"summary": "ACME directory discovery"}},
			"/mcp":                             map[string]any{"post": map[string]string{"summary": "MCP JSON-RPC 2.0 server"}},
		},
	})
}

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request, _ *auth.SessionInfo) {
	provs, err := s.store.ListProvisioners(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": provs})
}

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	var body struct {
		Name       string `json:"name"`
		Purpose    string `json:"purpose"`
		MaxTTLDays int    `json:"max_ttl_days"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json payload")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "token name is required")
		return
	}
	if body.MaxTTLDays <= 0 || body.MaxTTLDays > 1095 {
		body.MaxTTLDays = 365
	}
	rawToken := "wca_" + store.GenerateRandomID(24)
	rec := store.ProvisionerRecord{
		ID:                  store.GenerateRandomID(8),
		Name:                name,
		Protocol:            "api_token",
		TokenHash:           auth.HashToken(rawToken),
		TokenPrefix:         rawToken[:12],
		AllowedProfilesJSON: `["tls_server","pdf_signing","entra_cba","tls_client","code_signing","smime_email","wifi_eap","iot_device"]`,
		MaxTTLDays:          body.MaxTTLDays,
		Enabled:             true,
		CreatedAt:           time.Now().Unix(),
	}
	if err := s.store.InsertProvisioner(r.Context(), rec); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		ID:         store.GenerateRandomID(8),
		Actor:      sess.Username,
		Action:     "token.create",
		ClientIP:   clientIP(r),
		DetailJSON: fmt.Sprintf(`{"name":%q,"purpose":%q}`, name, body.Purpose),
		CreatedAt:  time.Now().Unix(),
	})
	writeJSON(w, http.StatusCreated, map[string]any{
		"token_record": rec,
		"token":        rawToken,
	})
}

func (s *Server) handleDeleteToken(w http.ResponseWriter, r *http.Request, _ *auth.SessionInfo) {
	id := strings.TrimSpace(r.PathValue("id"))
	if err := s.store.DeleteProvisioner(r.Context(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (s *Server) ensureUserWebhookKey(r *http.Request, username string, forceRotate bool) string {
	settingKey := "webhook_key:" + username
	if !forceRotate {
		if existing, err := s.store.GetSetting(r.Context(), settingKey); err == nil && existing != "" {
			return existing
		}
	}
	fresh := "wkh_" + store.GenerateRandomID(18)
	_ = s.store.SetSetting(r.Context(), settingKey, fresh)
	return fresh
}

func (s *Server) handleGetMyWebhook(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	key := s.ensureUserWebhookKey(r, sess.Username, false)
	channels, _ := s.store.ListNotificationChannels(r.Context())
	enabledCount := 0
	for _, ch := range channels {
		if ch.Enabled {
			enabledCount++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"webhook": map[string]any{
			"username":           sess.Username,
			"webhook_key_prefix": key[:12],
			"webhook_key":        key,
			"serverchan_url":     fmt.Sprintf("%s/webhook/%s/%s.send", s.base, sess.Username, key),
			"rest_url":           s.base + "/api/webhook/send",
			"enabled_channels":   enabledCount,
		},
	})
}

func (s *Server) handleRotateMyWebhook(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	key := s.ensureUserWebhookKey(r, sess.Username, true)
	channels, _ := s.store.ListNotificationChannels(r.Context())
	enabledCount := 0
	for _, ch := range channels {
		if ch.Enabled {
			enabledCount++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"webhook": map[string]any{
			"username":           sess.Username,
			"webhook_key_prefix": key[:12],
			"webhook_key":        key,
			"serverchan_url":     fmt.Sprintf("%s/webhook/%s/%s.send", s.base, sess.Username, key),
			"rest_url":           s.base + "/api/webhook/send",
			"enabled_channels":   enabledCount,
		},
	})
}

func parseServerChanInput(r *http.Request) (title, desp, short, tags, channel string) {
	q := r.URL.Query()
	title = firstNonEmpty(q.Get("title"), q.Get("text"))
	desp = firstNonEmpty(q.Get("desp"), q.Get("content"), q.Get("body"), q.Get("message"))
	short = q.Get("short")
	tags = q.Get("tags")
	channel = q.Get("channel")

	if r.Body != nil && r.Method == http.MethodPost {
		ct := strings.ToLower(r.Header.Get("Content-Type"))
		if strings.Contains(ct, "application/json") {
			var payload map[string]any
			if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&payload); err == nil {
				str := func(k string) string {
					if v, ok := payload[k]; ok && v != nil {
						return fmt.Sprint(v)
					}
					return ""
				}
				title = firstNonEmpty(str("title"), str("text"), title)
				desp = firstNonEmpty(str("desp"), str("content"), str("body"), str("message"), desp)
				short = firstNonEmpty(str("short"), short)
				tags = firstNonEmpty(str("tags"), tags)
				channel = firstNonEmpty(str("channel"), channel)
			}
		} else {
			_ = r.ParseForm()
			title = firstNonEmpty(r.FormValue("title"), r.FormValue("text"), title)
			desp = firstNonEmpty(r.FormValue("desp"), r.FormValue("content"), r.FormValue("body"), r.FormValue("message"), desp)
			short = firstNonEmpty(r.FormValue("short"), short)
			tags = firstNonEmpty(r.FormValue("tags"), tags)
			channel = firstNonEmpty(r.FormValue("channel"), channel)
		}
	}
	return strings.TrimSpace(title), strings.TrimSpace(desp), strings.TrimSpace(short), strings.TrimSpace(tags), strings.TrimSpace(channel)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func (s *Server) dispatchWebhookRelayResponse(w http.ResponseWriter, r *http.Request, username string) {
	title, desp, short, tags, channel := parseServerChanInput(r)
	if title == "" {
		writeErr(w, http.StatusBadRequest, "title (or text) is required")
		return
	}
	fullBody := desp
	if fullBody == "" {
		fullBody = short
	}
	if tags != "" {
		fullBody = fmt.Sprintf("[%s]\n\n%s", tags, fullBody)
	}
	results, err := s.notifier.DispatchRelay(r.Context(), username, title, fullBody, channel)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	succeeded, failed := 0, 0
	for _, item := range results {
		if item.Status == "failed" {
			failed++
		} else {
			succeeded++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"code":    0,
		"message": "ok",
		"data": map[string]any{
			"pushid":     store.GenerateRandomID(8),
			"user":       username,
			"title":      title,
			"dispatched": len(results),
			"succeeded":  succeeded,
			"failed":     failed,
			"results":    results,
		},
	})
}

func (s *Server) handleWebhookSendAPI(w http.ResponseWriter, r *http.Request, actor string) {
	s.dispatchWebhookRelayResponse(w, r, actor)
}

func (s *Server) handlePersonalWebhookRelay(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.PathValue("username"))
	rawKey := strings.TrimSuffix(strings.TrimSpace(r.PathValue("key")), ".send")
	expected, err := s.store.GetSetting(r.Context(), "webhook_key:"+username)
	if err != nil || expected == "" || subtle.ConstantTimeCompare([]byte(rawKey), []byte(expected)) != 1 {
		writeErr(w, http.StatusUnauthorized, "invalid webhook key")
		return
	}
	s.dispatchWebhookRelayResponse(w, r, username)
}

func (s *Server) handleMCPManifest(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"protocolVersion": "2024-11-05",
		"serverInfo": map[string]string{
			"name":    "wimotek-ca-mcp",
			"version": "2.0.0",
		},
		"endpoint": s.base + "/mcp",
		"tools": []string{
			"get_ca_overview",
			"list_certificates",
			"list_expiring_certificates",
			"check_ocsp_status",
			"issue_certificate",
			"renew_certificate",
			"revoke_certificate",
			"send_webhook_notification",
		},
	})
}

func (s *Server) handleMCPJSONRPC(w http.ResponseWriter, r *http.Request, actor string) {
	var req struct {
		JSONRPC string         `json:"jsonrpc"`
		ID      any            `json:"id"`
		Method  string         `json:"method"`
		Params  map[string]any `json:"params"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 128*1024)).Decode(&req); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"jsonrpc": "2.0",
			"id":      nil,
			"error":   map[string]any{"code": -32700, "message": "parse error"},
		})
		return
	}

	reply := func(result any) {
		writeJSON(w, http.StatusOK, map[string]any{
			"jsonrpc": "2.0",
			"id":      req.ID,
			"result":  result,
		})
	}
	fail := func(code int, msg string) {
		writeJSON(w, http.StatusOK, map[string]any{
			"jsonrpc": "2.0",
			"id":      req.ID,
			"error":   map[string]any{"code": code, "message": msg},
		})
	}

	switch req.Method {
	case "initialize":
		reply(map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities": map[string]any{
				"tools":     map[string]any{},
				"resources": map[string]any{},
			},
			"serverInfo": map[string]string{
				"name":    "wimotek-ca-mcp",
				"version": "2.0.0",
			},
		})
	case "notifications/initialized", "ping":
		reply(map[string]any{})
	case "tools/list":
		reply(map[string]any{
			"tools": []map[string]any{
				{"name": "get_ca_overview", "description": "Get Root/Issuing CA overview and counts"},
				{"name": "list_certificates", "description": "List issued certificates"},
				{"name": "list_expiring_certificates", "description": "List certificates expiring within N days"},
				{"name": "check_ocsp_status", "description": "Check certificate revocation status by serial_hex"},
				{"name": "issue_certificate", "description": "Issue an X.509 certificate from an enterprise template"},
				{"name": "renew_certificate", "description": "Renew an existing certificate by serial_hex"},
				{"name": "revoke_certificate", "description": "Revoke an active certificate by serial_hex"},
				{"name": "send_webhook_notification", "description": "Send a ServerChan-format message via personal webhook relay"},
			},
		})
	case "resources/list":
		reply(map[string]any{
			"resources": []map[string]string{
				{"uri": "ca://root.crt", "name": "Root CA PEM", "mimeType": "application/x-pem-file"},
				{"uri": "ca://chain.pem", "name": "Full CA Chain PEM", "mimeType": "application/x-pem-file"},
				{"uri": "ca://overview", "name": "CA Overview JSON", "mimeType": "application/json"},
			},
		})
	case "resources/read":
		uri, _ := req.Params["uri"].(string)
		switch uri {
		case "ca://root.crt":
			reply(map[string]any{"contents": []map[string]string{{"uri": uri, "mimeType": "application/x-pem-file", "text": s.pki.RootPEM()}}})
		case "ca://chain.pem":
			reply(map[string]any{"contents": []map[string]string{{"uri": uri, "mimeType": "application/x-pem-file", "text": s.pki.IssuingPEM() + "\n" + s.pki.RootPEM()}}})
		default:
			ov, _ := s.pki.Overview(r.Context())
			b, _ := json.MarshalIndent(ov, "", "  ")
			reply(map[string]any{"contents": []map[string]string{{"uri": uri, "mimeType": "application/json", "text": string(b)}}})
		}
	case "tools/call":
		name, _ := req.Params["name"].(string)
		args, _ := req.Params["arguments"].(map[string]any)
		if args == nil {
			args = map[string]any{}
		}
		var out any
		switch name {
		case "get_ca_overview":
			ov, err := s.pki.Overview(r.Context())
			if err != nil {
				fail(-32000, err.Error())
				return
			}
			out = ov
		case "list_certificates":
			certs, err := s.store.ListCertificates(r.Context())
			if err != nil {
				fail(-32000, err.Error())
				return
			}
			out = map[string]any{"certificates": certs}
		case "list_expiring_certificates":
			days := 30
			if d, ok := args["days"].(float64); ok && d >= 1 {
				days = int(d)
			}
			certs, _ := s.store.ListCertificates(r.Context())
			now := time.Now().Unix()
			cutoff := now + int64(days)*86400
			exp := make([]store.CertificateRecord, 0)
			for _, c := range certs {
				if c.Status == "active" && c.NotAfter > now && c.NotAfter <= cutoff {
					exp = append(exp, c)
				}
			}
			out = map[string]any{"days": days, "certificates": exp}
		case "check_ocsp_status":
			serial, _ := args["serial_hex"].(string)
			cert, _ := s.store.GetCertificate(r.Context(), serial)
			status := "unknown"
			if cert != nil {
				if cert.Status == "revoked" {
					status = "revoked"
				} else {
					status = "good"
				}
			}
			out = map[string]any{"serial_hex": serial, "status": status, "checked_at": time.Now().Unix()}
		case "issue_certificate":
			profile, _ := args["profile"].(string)
			cn, _ := args["common_name"].(string)
			validity := 90
			if v, ok := args["validity_days"].(float64); ok && v > 0 {
				validity = int(v)
			}
			var sans []string
			if rawSans, ok := args["sans"].([]any); ok {
				for _, x := range rawSans {
					if sVal, ok := x.(string); ok {
						sans = append(sans, sVal)
					}
				}
			}
			res, err := s.pki.Issue(r.Context(), ca.IssueRequest{
				Profile:      profile,
				CommonName:   cn,
				SANs:         sans,
				ValidityDays: validity,
				IssuedBy:     actor,
				ClientIP:     clientIP(r),
				MaxQuota:     -1,
			})
			if err != nil {
				fail(-32000, err.Error())
				return
			}
			out = map[string]any{"certificate": res.Record, "chain_pem": res.ChainPEM}
		case "revoke_certificate":
			serial, _ := args["serial_hex"].(string)
			reason := 0
			if rv, ok := args["reason"].(float64); ok {
				reason = int(rv)
			}
			if err := s.pki.Revoke(r.Context(), serial, reason, actor, clientIP(r)); err != nil {
				fail(-32000, err.Error())
				return
			}
			out = map[string]any{"revoked": true, "serial_hex": serial}
		case "send_webhook_notification":
			title, _ := args["title"].(string)
			desp, _ := args["desp"].(string)
			channel, _ := args["channel"].(string)
			res, err := s.notifier.DispatchRelay(r.Context(), actor, title, desp, channel)
			if err != nil {
				fail(-32000, err.Error())
				return
			}
			out = map[string]any{"dispatched": len(res), "results": res}
		default:
			fail(-32601, "unknown tool: "+name)
			return
		}
		b, _ := json.MarshalIndent(out, "", "  ")
		reply(map[string]any{
			"content": []map[string]string{{"type": "text", "text": string(b)}},
		})
	default:
		fail(-32601, "method not found")
	}
}
