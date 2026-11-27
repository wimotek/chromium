package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/wimotek/ca/internal/store"
)

func setupAdminToken(t *testing.T, srv http.Handler) string {
	t.Helper()
	body := `{"username":"admin","password":"StrongPassword123!","org_name":"Test PKI"}`
	req := httptest.NewRequest(http.MethodPost, "/api/auth/setup", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("setup failed: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.Token == "" {
		t.Fatalf("expected setup token, got %q (err=%v)", out.Token, err)
	}
	return out.Token
}

func TestDirectIdPConfigURLAndSocialUnlink(t *testing.T) {
	srv, st := buildProductionTestServer(t)
	token := setupAdminToken(t, srv)

	// 1. Verify /api/auth/oauth/providers returns all 4 providers with request-aware callback URLs
	provReq := httptest.NewRequest(http.MethodGet, "https://ca.example.com/api/auth/oauth/providers", nil)
	provReq.Header.Set("X-Forwarded-Proto", "https")
	provReq.Header.Set("X-Forwarded-Host", "ca.example.com")
	provRec := httptest.NewRecorder()
	srv.ServeHTTP(provRec, provReq)
	if provRec.Code != http.StatusOK {
		t.Fatalf("providers status=%d", provRec.Code)
	}
	var provBody struct {
		Providers []struct {
			Provider           string `json:"provider"`
			Configured         bool   `json:"configured"`
			CallbackURL        string `json:"callback_url"`
			DefaultCallbackURL string `json:"default_callback_url"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(provRec.Body.Bytes(), &provBody); err != nil {
		t.Fatalf("decode providers: %v", err)
	}
	if len(provBody.Providers) != 4 {
		t.Fatalf("expected 4 providers, got %d", len(provBody.Providers))
	}
	if provBody.Providers[0].CallbackURL != "https://ca.example.com/auth/callback" {
		t.Fatalf("unexpected wimotek default callback: %s", provBody.Providers[0].CallbackURL)
	}
	if provBody.Providers[1].CallbackURL != "https://ca.example.com/api/auth/oauth/microsoft/callback" {
		t.Fatalf("unexpected microsoft default callback: %s", provBody.Providers[1].CallbackURL)
	}

	// 2. Admin saves Microsoft Entra ID configuration (with encrypted secret & tenant ID)
	savePayload := `{"client_id":"ms-app-123","client_secret":"super-secret-ms-9999","tenant_id":"contoso.onmicrosoft.com"}`
	saveReq := httptest.NewRequest(http.MethodPut, "https://ca.example.com/api/admin/oauth/providers/microsoft", bytes.NewBufferString(savePayload))
	saveReq.Header.Set("Authorization", "Bearer "+token)
	saveReq.Header.Set("Content-Type", "application/json")
	saveReq.Header.Set("X-Forwarded-Proto", "https")
	saveReq.Header.Set("X-Forwarded-Host", "ca.example.com")
	saveRec := httptest.NewRecorder()
	srv.ServeHTTP(saveRec, saveReq)
	if saveRec.Code != http.StatusOK {
		t.Fatalf("save direct provider status=%d body=%s", saveRec.Code, saveRec.Body.String())
	}
	var saveResp struct {
		DirectProviders []struct {
			Provider           string `json:"provider"`
			ClientID           string `json:"client_id"`
			HasClientSecret    bool   `json:"has_client_secret"`
			ClientSecretMasked string `json:"client_secret_masked"`
			TenantID           string `json:"tenant_id"`
			Configured         bool   `json:"configured"`
			Source             string `json:"source"`
			DefaultCallbackURL string `json:"default_callback_url"`
		} `json:"direct_providers"`
	}
	if err := json.Unmarshal(saveRec.Body.Bytes(), &saveResp); err != nil {
		t.Fatalf("decode save response: %v", err)
	}
	var foundMS bool
	for _, dp := range saveResp.DirectProviders {
		if dp.Provider == "microsoft" {
			foundMS = true
			if !dp.Configured || dp.ClientID != "ms-app-123" || !dp.HasClientSecret || dp.ClientSecretMasked != "****9999" || dp.TenantID != "contoso.onmicrosoft.com" || dp.Source != "database" {
				t.Fatalf("unexpected microsoft config: %+v", dp)
			}
			if dp.DefaultCallbackURL != "https://ca.example.com/api/auth/oauth/microsoft/callback" {
				t.Fatalf("unexpected microsoft default callback url: %s", dp.DefaultCallbackURL)
			}
		}
	}
	if !foundMS {
		t.Fatalf("microsoft not returned in direct_providers")
	}

	// 3. Binding URL requires authentication when mode=bind
	unauthBindReq := httptest.NewRequest(http.MethodGet, "https://ca.example.com/api/auth/oauth/microsoft/url?mode=bind", nil)
	unauthBindRec := httptest.NewRecorder()
	srv.ServeHTTP(unauthBindRec, unauthBindReq)
	if unauthBindRec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauthenticated bind, got %d", unauthBindRec.Code)
	}

	// 4. Authenticated bind URL succeeds and targets tenant authorize endpoint
	bindReq := httptest.NewRequest(http.MethodGet, "https://ca.example.com/api/auth/oauth/microsoft/url?mode=bind", nil)
	bindReq.Header.Set("Authorization", "Bearer "+token)
	bindReq.Header.Set("X-Forwarded-Proto", "https")
	bindReq.Header.Set("X-Forwarded-Host", "ca.example.com")
	bindRec := httptest.NewRecorder()
	srv.ServeHTTP(bindRec, bindReq)
	if bindRec.Code != http.StatusOK {
		t.Fatalf("bind url status=%d body=%s", bindRec.Code, bindRec.Body.String())
	}
	var bindOut struct {
		Configured bool   `json:"configured"`
		URL        string `json:"url"`
	}
	_ = json.Unmarshal(bindRec.Body.Bytes(), &bindOut)
	if !bindOut.Configured || !strings.Contains(bindOut.URL, "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize") {
		t.Fatalf("unexpected microsoft authorize URL: %+v", bindOut)
	}

	// 5. Persist linked social account, verify GET /api/profile returns it, then DELETE /api/profile/social/microsoft removes it
	if err := st.UpsertUserSocialAccount(context.Background(), store.SocialAccountRecord{
		Provider:    "microsoft",
		ProviderID:  "oid-42",
		Username:    "admin",
		Email:       "admin@contoso.com",
		DisplayName: "Admin User",
	}); err != nil {
		t.Fatalf("upsert social account: %v", err)
	}

	profReq := httptest.NewRequest(http.MethodGet, "/api/profile", nil)
	profReq.Header.Set("Authorization", "Bearer "+token)
	profRec := httptest.NewRecorder()
	srv.ServeHTTP(profRec, profReq)
	if profRec.Code != http.StatusOK {
		t.Fatalf("get profile status=%d", profRec.Code)
	}
	if !strings.Contains(profRec.Body.String(), "admin@contoso.com") {
		t.Fatalf("expected linked social account in profile, got %s", profRec.Body.String())
	}

	delReq := httptest.NewRequest(http.MethodDelete, "/api/profile/social/microsoft", nil)
	delReq.Header.Set("Authorization", "Bearer "+token)
	delRec := httptest.NewRecorder()
	srv.ServeHTTP(delRec, delReq)
	if delRec.Code != http.StatusOK {
		t.Fatalf("unlink social status=%d body=%s", delRec.Code, delRec.Body.String())
	}
	if strings.Contains(delRec.Body.String(), "admin@contoso.com") {
		t.Fatalf("expected microsoft account to be unlinked, got %s", delRec.Body.String())
	}
}
