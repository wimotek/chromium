package webui

import (
	"crypto/subtle"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wimotek/cli/internal/certutil"
	"github.com/wimotek/cli/internal/client"
	"github.com/wimotek/cli/internal/config"
	"github.com/wimotek/cli/internal/renewer"
)

//go:embed static/index.html
var staticFS embed.FS

// Options configures the embedded Web Management Console for wimotek-cli.
type Options struct {
	Manager     *config.Manager
	Renewer     *renewer.Service
	WebPassword string // Optional access password (required when binding to non-loopback interfaces)
	Version     string
}

// Server serves the embedded Web Management UI and local PKI client APIs.
type Server struct {
	mgr         *config.Manager
	ren         *renewer.Service
	webPassword string
	version     string
	mux         *http.ServeMux
}

// NewServer builds the http.Handler for `wimotek-cli web`.
func NewServer(opts Options) *Server {
	s := &Server{
		mgr:         opts.Manager,
		ren:         opts.Renewer,
		webPassword: strings.TrimSpace(opts.WebPassword),
		version:     opts.Version,
		mux:         http.NewServeMux(),
	}
	if s.version == "" {
		s.version = "dev"
	}
	s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Basic security headers for local web management UI
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	w.Header().Set("Referrer-Policy", "no-referrer")
	s.mux.ServeHTTP(w, r)
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /", s.handleIndex)
	s.mux.HandleFunc("GET /cli", s.handleIndex)
	s.mux.HandleFunc("GET /cli/", s.handleIndex)

	// Auth status endpoint (public so UI knows whether password is required)
	s.mux.HandleFunc("GET /cli/api/auth/status", s.handleAuthStatus)

	// Protected API endpoints
	s.mux.HandleFunc("GET /cli/api/overview", s.withAuth(s.handleOverview))
	s.mux.HandleFunc("GET /cli/api/contexts", s.withAuth(s.handleListContexts))
	s.mux.HandleFunc("POST /cli/api/contexts/bootstrap", s.withAuth(s.handleBootstrap))
	s.mux.HandleFunc("POST /cli/api/contexts/select", s.withAuth(s.handleSelectContext))
	s.mux.HandleFunc("DELETE /cli/api/contexts/{name}", s.withAuth(s.handleDeleteContext))
	s.mux.HandleFunc("POST /cli/api/contexts/health", s.withAuth(s.handleContextHealth))

	s.mux.HandleFunc("GET /cli/api/certs", s.withAuth(s.handleListCerts))
	s.mux.HandleFunc("POST /cli/api/certs/issue", s.withAuth(s.handleIssueCert))
	s.mux.HandleFunc("POST /cli/api/certs/{id}/renew", s.withAuth(s.handleRenewCert))
	s.mux.HandleFunc("POST /cli/api/certs/{id}/revoke", s.withAuth(s.handleRevokeCert))
	s.mux.HandleFunc("DELETE /cli/api/certs/{id}", s.withAuth(s.handleDeleteCert))
	s.mux.HandleFunc("GET /cli/api/certs/{id}/download", s.withAuth(s.handleDownloadCert))

	s.mux.HandleFunc("POST /cli/api/inspect", s.withAuth(s.handleInspect))
	s.mux.HandleFunc("POST /cli/api/verify", s.withAuth(s.handleVerify))
	s.mux.HandleFunc("POST /cli/api/crypto/keypair", s.withAuth(s.handleCryptoKeypair))
	s.mux.HandleFunc("POST /cli/api/crypto/self-signed", s.withAuth(s.handleCryptoSelfSigned))
	s.mux.HandleFunc("POST /cli/api/crypto/pfx", s.withAuth(s.handleCryptoPFX))
	s.mux.HandleFunc("POST /cli/api/crypto/rand", s.withAuth(s.handleCryptoRand))
}

func (s *Server) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.webPassword != "" {
			got := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
			if got == "" {
				got = strings.TrimSpace(r.Header.Get("X-CLI-Password"))
			}
			if subtle.ConstantTimeCompare([]byte(got), []byte(s.webPassword)) != 1 {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "authentication required"})
				return
			}
		}
		next(w, r)
	}
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	raw, err := staticFS.ReadFile("static/index.html")
	if err != nil {
		http.Error(w, "embedded UI unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(raw)
}

func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"password_required": s.webPassword != "",
		"version":           s.version,
		"preview_mode":      false,
	})
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	st, err := s.mgr.Load()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	current, contexts, err := s.mgr.ListContexts(true)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	now := time.Now().Unix()
	var activeCount, dueCount, revokedCount int
	for _, c := range st.ManagedCerts {
		switch c.Status {
		case "revoked":
			revokedCount++
		default:
			activeCount++
			if c.NotAfter > 0 && c.NotAfter-now <= 15*86400 {
				dueCount++
			}
		}
	}
	var activeCtx *config.Context
	for i := range contexts {
		if contexts[i].Name == current {
			activeCtx = &contexts[i]
			break
		}
	}
	trustCmds := map[string]string{}
	if activeCtx != nil {
		trustCmds = certutil.TrustInstallCommands(activeCtx.RootCertPath, activeCtx.CAURL)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"version":          s.version,
		"base_dir":         s.mgr.BaseDir,
		"certs_dir":        s.mgr.CertsDir,
		"current_context":  current,
		"active_context":   activeCtx,
		"contexts":         contexts,
		"managed_certs":    st.ManagedCerts,
		"auto_renew_min":   st.AutoRenewMin,
		"trust_commands":   trustCmds,
		"stats": map[string]int{
			"contexts": len(contexts),
			"active":   activeCount,
			"due_soon": dueCount,
			"revoked":  revokedCount,
		},
	})
}

func (s *Server) handleListContexts(w http.ResponseWriter, r *http.Request) {
	cur, list, err := s.mgr.ListContexts(true)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"current_context": cur,
		"contexts":        list,
	})
}

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name               string `json:"name"`
		CAURL              string `json:"ca_url"`
		Fingerprint        string `json:"fingerprint"`
		Token              string `json:"token"`
		Username           string `json:"username"`
		Password           string `json:"password"`
		InsecureSkipVerify bool   `json:"insecure_skip_verify"`
		SetCurrent         bool   `json:"set_current"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if strings.TrimSpace(body.CAURL) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "ca_url is required"})
		return
	}
	rootPEM, actualFP, err := client.FetchRoot(r.Context(), body.CAURL, body.Fingerprint, body.InsecureSkipVerify)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	tok := strings.TrimSpace(body.Token)
	if tok == "" && strings.TrimSpace(body.Username) != "" && body.Password != "" {
		cli := client.New(body.CAURL, "", rootPEM, body.InsecureSkipVerify)
		tok, err = cli.LoginWithPoW(r.Context(), strings.TrimSpace(body.Username), body.Password)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "CA login failed: " + err.Error()})
			return
		}
	}
	saved, err := s.mgr.SaveContext(config.Context{
		Name:               body.Name,
		CAURL:              body.CAURL,
		Fingerprint:        actualFP,
		Token:              tok,
		InsecureSkipVerify: body.InsecureSkipVerify,
	}, rootPEM, body.SetCurrent || true)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	saved.Token = ""
	writeJSON(w, http.StatusOK, map[string]any{
		"context":        saved,
		"fingerprint":    actualFP,
		"trust_commands": certutil.TrustInstallCommands(saved.RootCertPath, saved.CAURL),
	})
}

func (s *Server) handleSelectContext(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	c, err := s.mgr.SelectContext(strings.TrimSpace(body.Name))
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	c.Token = ""
	writeJSON(w, http.StatusOK, map[string]any{"context": c})
}

func (s *Server) handleDeleteContext(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.PathValue("name"))
	if err := s.mgr.RemoveContext(name); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": name})
}

func (s *Server) handleContextHealth(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	_ = decodeJSON(r, &body)
	ctxRec, cli, err := s.ren.ClientForContext(body.Name, "")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	start := time.Now()
	health, err := cli.Health(r.Context())
	latencyMs := time.Since(start).Milliseconds()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"ok":         false,
			"context":    ctxRec.Name,
			"latency_ms": latencyMs,
			"error":      err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"context":    ctxRec.Name,
		"ca_url":     ctxRec.CAURL,
		"latency_ms": latencyMs,
		"health":     health,
	})
}

func (s *Server) handleListCerts(w http.ResponseWriter, r *http.Request) {
	st, err := s.mgr.Load()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"managed_certs": st.ManagedCerts})
}

func (s *Server) handleIssueCert(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Context      string   `json:"context"`
		Name         string   `json:"name"`
		Profile      string   `json:"profile"`
		CommonName   string   `json:"common_name"`
		SANs         []string `json:"sans"`
		UPN          string   `json:"upn"`
		Email        string   `json:"email"`
		KeyType      string   `json:"key_type"`
		Curve        string   `json:"curve"`
		RSABits      int      `json:"rsa_bits"`
		ValidityDays int      `json:"validity_days"`
		RenewBefore  string   `json:"renew_before"`
		AutoRenew    bool     `json:"auto_renew"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	// Web UI always confines files strictly under CertsDir (never accepts raw CertOutPath/KeyOutPath).
	rec, err := s.ren.Issue(r.Context(), renewer.IssueParams{
		ContextName:  body.Context,
		Name:         body.Name,
		Profile:      body.Profile,
		CommonName:   body.CommonName,
		SANs:         body.SANs,
		UPN:          body.UPN,
		Email:        body.Email,
		KeyType:      body.KeyType,
		Curve:        body.Curve,
		RSABits:      body.RSABits,
		ValidityDays: body.ValidityDays,
		RenewBefore:  body.RenewBefore,
		AutoRenew:    body.AutoRenew,
	})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"certificate": rec})
}

func (s *Server) handleRenewCert(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	var body struct {
		Force bool `json:"force"`
	}
	_ = decodeJSON(r, &body)
	rec, renewed, err := s.ren.RenewEntry(r.Context(), id, body.Force)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"certificate": rec,
		"renewed":     renewed,
	})
}

func (s *Server) handleRevokeCert(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	var body struct {
		Reason int `json:"reason"`
	}
	_ = decodeJSON(r, &body)
	rec, err := s.ren.RevokeEntry(r.Context(), id, body.Reason)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"certificate": rec})
}

func (s *Server) handleDeleteCert(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if err := s.mgr.DeleteManagedCert(id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

func (s *Server) handleDownloadCert(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format == "" {
		format = "crt"
	}
	st, err := s.mgr.Load()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	var target *config.ManagedCert
	for i := range st.ManagedCerts {
		if st.ManagedCerts[i].ID == id {
			c := st.ManagedCerts[i]
			target = &c
			break
		}
	}
	if target == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "managed certificate not found"})
		return
	}

	safeName := filepath.Base(target.Name)
	switch format {
	case "crt", "pem":
		raw, err := os.ReadFile(target.CertPath)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "certificate file missing on disk"})
			return
		}
		if r.URL.Query().Get("inline") == "1" {
			writeJSON(w, http.StatusOK, map[string]any{"pem": string(raw)})
			return
		}
		w.Header().Set("Content-Type", "application/x-pem-file")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", safeName+".crt"))
		_, _ = w.Write(raw)
	case "key":
		raw, err := os.ReadFile(target.KeyPath)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "private key file missing on disk"})
			return
		}
		w.Header().Set("Content-Type", "application/x-pem-file")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", safeName+".key"))
		_, _ = w.Write(raw)
	case "pfx", "p12":
		certRaw, err := os.ReadFile(target.CertPath)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "certificate file missing"})
			return
		}
		keyRaw, err := os.ReadFile(target.KeyPath)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "private key file missing"})
			return
		}
		pw := r.URL.Query().Get("password")
		pfxBytes, err := certutil.EncodeModernPFX(certRaw, keyRaw, nil, pw)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/x-pkcs12")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", safeName+".pfx"))
		_, _ = w.Write(pfxBytes)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unsupported format (use crt, key, or pfx)"})
	}
}

func (s *Server) handleInspect(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PEM     string `json:"pem"`
		CertID  string `json:"cert_id"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	raw := []byte(strings.TrimSpace(body.PEM))
	if len(raw) == 0 && strings.TrimSpace(body.CertID) != "" {
		st, err := s.mgr.Load()
		if err == nil {
			for _, c := range st.ManagedCerts {
				if c.ID == body.CertID {
					raw, _ = os.ReadFile(c.CertPath)
					break
				}
			}
		}
	}
	if len(raw) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "pem or cert_id is required"})
		return
	}
	info, err := certutil.InspectPEM(raw)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"inspection": info,
		"pem":        string(raw),
	})
}

func (s *Server) handleVerify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CertPEM    string `json:"cert_pem"`
		RootsPEM   string `json:"roots_pem"`
		Context    string `json:"context"`
		ServerName string `json:"server_name"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	roots := []byte(strings.TrimSpace(body.RootsPEM))
	if len(roots) == 0 {
		if ctxRec, err := s.mgr.GetContext(body.Context); err == nil && ctxRec.RootCertPath != "" {
			roots, _ = os.ReadFile(ctxRec.RootCertPath)
		}
	}
	res := certutil.VerifyCertificate([]byte(body.CertPEM), roots, body.ServerName)
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleCryptoKeypair(w http.ResponseWriter, r *http.Request) {
	var body struct {
		KeyType string `json:"key_type"`
		Curve   string `json:"curve"`
		RSABits int    `json:"rsa_bits"`
	}
	_ = decodeJSON(r, &body)
	_, pubPEM, privPEM, err := certutil.GenerateKeyPair(body.KeyType, body.Curve, body.RSABits)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"public_pem":  string(pubPEM),
		"private_pem": string(privPEM),
	})
}

func (s *Server) handleCryptoSelfSigned(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CommonName   string   `json:"common_name"`
		Organization string   `json:"organization"`
		SANs         []string `json:"sans"`
		ValidityDays int      `json:"validity_days"`
		IsCA         bool     `json:"is_ca"`
		KeyType      string   `json:"key_type"`
		Curve        string   `json:"curve"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if strings.TrimSpace(body.CommonName) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "common_name is required"})
		return
	}
	days := body.ValidityDays
	if days <= 0 || days > 3650 {
		days = 365
	}
	signer, _, privPEM, err := certutil.GenerateKeyPair(body.KeyType, body.Curve, 2048)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	certPEM, err := certutil.CreateSelfSignedCert(body.CommonName, body.Organization, body.SANs, time.Duration(days)*24*time.Hour, body.IsCA, signer)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	info, _ := certutil.InspectPEM(certPEM)
	writeJSON(w, http.StatusOK, map[string]any{
		"cert_pem":    string(certPEM),
		"private_pem": string(privPEM),
		"inspection":  info,
	})
}

func (s *Server) handleCryptoPFX(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CertPEM  string `json:"cert_pem"`
		KeyPEM   string `json:"key_pem"`
		ChainPEM string `json:"chain_pem"`
		Password string `json:"password"`
		Filename string `json:"filename"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	pfxBytes, err := certutil.EncodeModernPFX([]byte(body.CertPEM), []byte(body.KeyPEM), []byte(body.ChainPEM), body.Password)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	fn, err := config.SanitizeName(strings.TrimSuffix(body.Filename, ".pfx"))
	if err != nil || fn == "" {
		fn = "bundle"
	}
	w.Header().Set("Content-Type", "application/x-pkcs12")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", fn+".pfx"))
	_, _ = w.Write(pfxBytes)
}

func (s *Server) handleCryptoRand(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Format string `json:"format"`
		Length int    `json:"length"`
	}
	_ = decodeJSON(r, &body)
	val, err := certutil.RandomString(body.Format, body.Length)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"value": val})
}

func decodeJSON(r *http.Request, dst any) error {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 2*1024*1024))
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	return json.Unmarshal(raw, dst)
}

func writeJSON(w http.ResponseWriter, code int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(payload)
}
