package webui

import (
	"bytes"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/wimotek/cli/internal/certutil"
	"github.com/wimotek/cli/internal/config"
	"github.com/wimotek/cli/internal/renewer"
)

func TestWebUIBootstrapIssueRenewRevokeAndSecurity(t *testing.T) {
	// 1. Spin up a real in-memory mock wimotek/ca server
	caSigner, _, _, err := certutil.GenerateKeyPair("EC", "P-256", 2048)
	if err != nil {
		t.Fatal(err)
	}
	rootPEM, err := certutil.CreateSelfSignedCert("Test Root CA", "Wimotek Test", nil, 365*24*time.Hour, true, caSigner)
	if err != nil {
		t.Fatal(err)
	}
	rootCerts, err := certutil.ParseCertChainPEM(rootPEM)
	if err != nil {
		t.Fatal(err)
	}
	rootCert := rootCerts[0]
	rootFP, _ := certutil.FingerprintSHA256(rootCert)

	var revokedSerial string
	mockCA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/ca/root.crt":
			w.Header().Set("Content-Type", "application/x-pem-file")
			_, _ = w.Write(rootPEM)
		case r.Method == http.MethodGet && r.URL.Path == "/api/health":
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
		case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/v1/pki/issue/"):
			if r.Header.Get("X-Vault-Token") != "wca_test_secret_token" {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}
			var req struct {
				CommonName string `json:"common_name"`
				CSR        string `json:"csr"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			blk, _ := pem.Decode([]byte(req.CSR))
			csr, err := x509.ParseCertificateRequest(blk.Bytes)
			if err != nil {
				http.Error(w, `{"error":"bad csr"}`, http.StatusBadRequest)
				return
			}
			serialBytes := make([]byte, 8)
			_, _ = rand.Read(serialBytes)
			serialBytes[0] = (serialBytes[0] & 0x7F) | 0x40
			serial := new(big.Int).SetBytes(serialBytes)
			now := time.Now().UTC()
			tmpl := &x509.Certificate{
				SerialNumber: serial,
				Subject:      csr.Subject,
				DNSNames:     csr.DNSNames,
				IPAddresses:  csr.IPAddresses,
				NotBefore:    now.Add(-time.Minute),
				NotAfter:     now.Add(30 * 24 * time.Hour),
				KeyUsage:     x509.KeyUsageDigitalSignature,
				ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			}
			der, err := x509.CreateCertificate(rand.Reader, tmpl, rootCert, csr.PublicKey, caSigner)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			leafPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{
					"serial_number": strings.ToUpper(serial.Text(16)),
					"certificate":   leafPEM,
					"ca_chain":      []string{string(rootPEM)},
					"expiration":    tmpl.NotAfter.Unix(),
				},
			})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/pki/revoke":
			var req struct {
				SerialNumber string `json:"serial_number"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			revokedSerial = req.SerialNumber
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "revoked"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer mockCA.Close()

	// 2. Setup CLI web server with temp dir & web password
	tmpDir := t.TempDir()
	mgr, err := config.Open(tmpDir)
	if err != nil {
		t.Fatal(err)
	}
	// Verify path confinement rejects traversal
	if _, err := mgr.ResolveConfinedCertPath("../escape.key"); err == nil {
		t.Fatal("expected traversal path to be rejected")
	}

	srv := NewServer(Options{
		Manager:     mgr,
		Renewer:     renewer.New(mgr),
		WebPassword: "cli-ui-password",
		Version:     "test",
	})

	doReq := func(method, path string, body any, authed bool) *httptest.ResponseRecorder {
		var buf bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&buf).Encode(body)
		}
		req := httptest.NewRequest(method, path, &buf)
		req.Header.Set("Content-Type", "application/json")
		if authed {
			req.Header.Set("Authorization", "Bearer cli-ui-password")
		}
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		return rec
	}

	// Unauthenticated request must return 401
	if rec := doReq(http.MethodGet, "/cli/api/overview", nil, false); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without password, got %d", rec.Code)
	}

	// Bootstrap with wrong fingerprint must fail
	if rec := doReq(http.MethodPost, "/cli/api/contexts/bootstrap", map[string]any{
		"name":        "prod",
		"ca_url":      mockCA.URL,
		"fingerprint": "0000000000000000000000000000000000000000000000000000000000000000",
		"token":       "wca_test_secret_token",
	}, true); rec.Code == http.StatusOK {
		t.Fatal("expected bootstrap with wrong fingerprint to fail")
	}

	// Bootstrap with correct fingerprint succeeds
	if rec := doReq(http.MethodPost, "/cli/api/contexts/bootstrap", map[string]any{
		"name":        "prod",
		"ca_url":      mockCA.URL,
		"fingerprint": rootFP,
		"token":       "wca_test_secret_token",
	}, true); rec.Code != http.StatusOK {
		t.Fatalf("bootstrap failed: %d %s", rec.Code, rec.Body.String())
	}

	// Issue managed certificate
	issueRec := doReq(http.MethodPost, "/cli/api/certs/issue", map[string]any{
		"profile":     "tls_server",
		"common_name": "svc.corp.internal",
		"sans":        []string{"svc.corp.internal"},
		"key_type":    "EC",
		"auto_renew":  true,
	}, true)
	if issueRec.Code != http.StatusCreated {
		t.Fatalf("issue failed: %d %s", issueRec.Code, issueRec.Body.String())
	}
	var issueResp struct {
		Certificate config.ManagedCert `json:"certificate"`
	}
	_ = json.Unmarshal(issueRec.Body.Bytes(), &issueResp)
	cert := issueResp.Certificate
	if cert.ID == "" || cert.SerialHex == "" {
		t.Fatalf("invalid issued cert: %+v", cert)
	}

	// Private key permissions must be 0600
	fi, err := os.Stat(cert.KeyPath)
	if err != nil {
		t.Fatalf("key file missing: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("expected 0600 key permissions, got %o", fi.Mode().Perm())
	}

	// Verify issued cert against active Root CA
	certPEM, _ := os.ReadFile(cert.CertPath)
	verRec := doReq(http.MethodPost, "/cli/api/verify", map[string]any{
		"cert_pem":    string(certPEM),
		"server_name": "svc.corp.internal",
	}, true)
	var verResp certutil.VerifyResult
	_ = json.Unmarshal(verRec.Body.Bytes(), &verResp)
	if !verResp.Valid {
		t.Fatalf("verify failed: %s", verResp.Error)
	}

	// Force renew changes serial number atomically
	renRec := doReq(http.MethodPost, "/cli/api/certs/"+cert.ID+"/renew", map[string]any{"force": true}, true)
	if renRec.Code != http.StatusOK {
		t.Fatalf("renew failed: %d %s", renRec.Code, renRec.Body.String())
	}
	var renResp struct {
		Certificate config.ManagedCert `json:"certificate"`
		Renewed     bool               `json:"renewed"`
	}
	_ = json.Unmarshal(renRec.Body.Bytes(), &renResp)
	if !renResp.Renewed || renResp.Certificate.SerialHex == cert.SerialHex {
		t.Fatalf("expected new serial after force renew: old=%s new=%s", cert.SerialHex, renResp.Certificate.SerialHex)
	}

	// Revoke calls CA revoke endpoint
	revRec := doReq(http.MethodPost, "/cli/api/certs/"+cert.ID+"/revoke", map[string]any{"reason": 1}, true)
	if revRec.Code != http.StatusOK {
		t.Fatalf("revoke failed: %d %s", revRec.Code, revRec.Body.String())
	}
	if revokedSerial != renResp.Certificate.SerialHex {
		t.Fatalf("expected CA to receive revoked serial %s, got %s", renResp.Certificate.SerialHex, revokedSerial)
	}
}
