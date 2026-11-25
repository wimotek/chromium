package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/wimotek/ca/internal/api"
	"github.com/wimotek/ca/internal/auth"
	"github.com/wimotek/ca/internal/ca"
	"github.com/wimotek/ca/internal/cache"
	"github.com/wimotek/ca/internal/i18n"
	"github.com/wimotek/ca/internal/notify"
	"github.com/wimotek/ca/internal/store"
)

func buildProductionTestServer(t *testing.T) (*api.Server, *store.Store) {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	hc := cache.NewHybridCache(st, cache.RedisConfig{})
	t.Cleanup(func() {
		_ = hc.Close()
		_ = st.Close()
	})
	key := []byte("0123456789abcdef0123456789abcdef")
	pki, err := ca.NewEngine(ctx, st, hc, ca.Config{
		OrgName:   "Pure Production Corp",
		BaseURL:   "https://localhost:8443",
		MasterKey: key,
		DataDir:   "/data",
		CertsDir:  "/certs",
		TLSMode:   "auto_self_signed",
	})
	if err != nil {
		t.Fatalf("bootstrap pki: %v", err)
	}
	authSvc := auth.NewService(st, hc, auth.Config{
		AdminUser:     "admin",
		HMACSecret:    key,
		PoWDifficulty: 10,
	})
	notifySvc := notify.NewService(st, key, false)
	locales, err := i18n.NewBundle()
	if err != nil {
		t.Fatalf("load locales: %v", err)
	}
	webFS := fstest.MapFS{"index.html": {Data: []byte("<html></html>")}}
	srv := api.NewServer(st, hc, pki, authSvc, locales, webFS, api.ServerOptions{
		BaseURL:  "https://localhost:8443",
		Notifier: notifySvc,
	})
	return srv, st
}

func TestPureProductionZeroSeedAndSetupWizard(t *testing.T) {
	srv, st := buildProductionTestServer(t)

	// 1. Fresh instance must have zero seeded certificates and zero seeded users
	certs, err := st.ListCertificates(context.Background())
	if err != nil || len(certs) != 0 {
		t.Fatalf("expected 0 seeded certificates, got %d (err=%v)", len(certs), err)
	}
	users, err := st.ListUsers(context.Background())
	if err != nil || len(users) != 0 {
		t.Fatalf("expected 0 seeded users, got %d (err=%v)", len(users), err)
	}

	// 2. Auth status requires First-Run Setup Wizard
	stReq := httptest.NewRequest(http.MethodGet, "/api/auth/status", nil)
	stRec := httptest.NewRecorder()
	srv.ServeHTTP(stRec, stReq)
	if stRec.Code != http.StatusOK {
		t.Fatalf("auth status expected 200, got %d", stRec.Code)
	}
	var stPayload map[string]any
	_ = json.Unmarshal(stRec.Body.Bytes(), &stPayload)
	if stPayload["needs_setup"] != true {
		t.Fatalf("expected needs_setup=true on fresh production instance, got %+v", stPayload)
	}

	// 3. No demo endpoints exist in the production binary
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/demo/quick-login"},
		{http.MethodGet, "/api/demo/download-bundle"},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("expected 404 for %s %s, got %d", tc.method, tc.path, rec.Code)
		}
	}

	// 4. First-Run Setup Wizard completes cleanly and returns admin token + profile
	wizardBody := []byte(`{
		"username":"admin",
		"password":"ProdStrongPassword!2026",
		"org_name":"Acme Pure Production",
		"base_url":"https://ca.acme.internal:8443",
		"full_name":"Chief PKI Officer",
		"email":"pki@acme.internal",
		"department":"Security"
	}`)
	setupReq := httptest.NewRequest(http.MethodPost, "/api/auth/setup", bytes.NewReader(wizardBody))
	setupRec := httptest.NewRecorder()
	srv.ServeHTTP(setupRec, setupReq)
	if setupRec.Code != http.StatusOK {
		t.Fatalf("wizard setup expected 200, got %d: %s", setupRec.Code, setupRec.Body.String())
	}
	var setupPayload map[string]any
	_ = json.Unmarshal(setupRec.Body.Bytes(), &setupPayload)
	if setupPayload["token"] == "" || setupPayload["role"] != "admin" {
		t.Fatalf("unexpected setup response: %+v", setupPayload)
	}
}
