package api

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/wimotek/ca/internal/auth"
	"github.com/wimotek/ca/internal/ca"
	"github.com/wimotek/ca/internal/cache"
	"github.com/wimotek/ca/internal/i18n"
	"github.com/wimotek/ca/internal/store"
)

func TestACMEPublicIPAndDomainGuards(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "10.0.0.1", "172.16.5.1", "192.168.0.1",
		"169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1",
	}
	for _, raw := range blocked {
		if isPublicRoutableIP(net.ParseIP(raw)) {
			t.Fatalf("expected %s to be blocked as non-public IP", raw)
		}
	}
	if !isPublicRoutableIP(net.ParseIP("93.184.216.34")) {
		t.Fatalf("expected 93.184.216.34 to be allowed")
	}

	norm, wc, err := validateACMEDomain("*.Example.COM.", true)
	if err != nil || norm != "*.example.com" || !wc {
		t.Fatalf("unexpected wildcard result: %q %v %v", norm, wc, err)
	}
	if _, _, err := validateACMEDomain("*.example.com", false); err == nil {
		t.Fatalf("expected wildcard rejection when policy disables wildcards")
	}
	if _, _, err := validateACMEDomain("127.0.0.1", true); err == nil {
		t.Fatalf("expected IP identifier rejection")
	}
}

func TestACMEDirectoryAndEABAccountRegistration(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	hc := cache.NewHybridCache(st, cache.RedisConfig{})
	defer hc.Close()
	master := sha256.Sum256([]byte("test-acme-master-key"))
	eng, err := ca.NewEngine(ctx, st, hc, ca.Config{
		OrgName:   "Test Commercial CA",
		BaseURL:   "https://ca.example.com",
		MasterKey: master[:],
	})
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}
	authSvc := auth.NewService(st, hc, auth.Config{HMACSecret: master[:], AdminUser: "admin", EnvPassword: "TestPassword123!"})
	locales, err := i18n.NewBundle()
	if err != nil {
		t.Fatalf("new i18n bundle: %v", err)
	}
	srv := NewServer(st, hc, eng, authSvc, locales, nil, ServerOptions{BaseURL: "https://ca.example.com"})

	// 1. Directory check
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "https://ca.example.com/acme/directory", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 directory, got %d", rec.Code)
	}
	var dir map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &dir)
	meta := dir["meta"].(map[string]any)
	if meta["externalAccountRequired"] != true {
		t.Fatalf("expected externalAccountRequired=true")
	}

	// 2. Seed an EAB credential in store directly
	hmacRaw := make([]byte, 32)
	_, _ = rand.Read(hmacRaw)
	hmacB64 := base64.RawURLEncoding.EncodeToString(hmacRaw)
	enc, _ := eng.EncryptSecret([]byte(hmacB64))
	kid := "eab_testkid001"
	if err := st.InsertACMEEAB(ctx, store.ACMEEABRecord{
		KID:           kid,
		OwnerUsername: "alice",
		Label:         "Unit Test EAB",
		HMACKeyEnc:    enc,
		HMACPrefix:    hmacB64[:8] + "...",
		Enabled:       true,
		CreatedAt:     1700000000,
	}); err != nil {
		t.Fatalf("insert EAB: %v", err)
	}

	// 3. Fetch Replay-Nonce
	nRec := httptest.NewRecorder()
	srv.ServeHTTP(nRec, httptest.NewRequest(http.MethodHead, "https://ca.example.com/acme/new-nonce", nil))
	nonce := nRec.Header().Get("Replay-Nonce")
	if nonce == "" {
		t.Fatalf("expected Replay-Nonce header")
	}

	// 4. Generate ECDSA P-256 client key + EAB binding
	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	xBytes := make([]byte, 32)
	yBytes := make([]byte, 32)
	priv.X.FillBytes(xBytes)
	priv.Y.FillBytes(yBytes)
	jwk := map[string]string{
		"crv": "P-256",
		"kty": "EC",
		"x":   base64.RawURLEncoding.EncodeToString(xBytes),
		"y":   base64.RawURLEncoding.EncodeToString(yBytes),
	}

	eabProtB64 := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","kid":"` + kid + `","url":"https://ca.example.com/acme/new-account"}`))
	jwkJSON, _ := json.Marshal(jwk)
	eabPayB64 := base64.RawURLEncoding.EncodeToString(jwkJSON)
	mac := hmac.New(sha256.New, hmacRaw)
	mac.Write([]byte(eabProtB64 + "." + eabPayB64))
	eabSigB64 := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	outerProt, _ := json.Marshal(map[string]any{
		"alg":   "ES256",
		"nonce": nonce,
		"url":   "https://ca.example.com/acme/new-account",
		"jwk":   jwk,
	})
	outerPay, _ := json.Marshal(map[string]any{
		"termsOfServiceAgreed": true,
		"contact":              []string{"mailto:alice@example.com"},
		"externalAccountBinding": map[string]string{
			"protected": eabProtB64,
			"payload":   eabPayB64,
			"signature": eabSigB64,
		},
	})
	protB64 := base64.RawURLEncoding.EncodeToString(outerProt)
	payB64 := base64.RawURLEncoding.EncodeToString(outerPay)
	digest := sha256.Sum256([]byte(protB64 + "." + payB64))
	rInt, sInt, _ := ecdsa.Sign(rand.Reader, priv, digest[:])
	sigBuf := make([]byte, 64)
	rInt.FillBytes(sigBuf[:32])
	sInt.FillBytes(sigBuf[32:])
	body, _ := json.Marshal(map[string]string{
		"protected": protB64,
		"payload":   payB64,
		"signature": base64.RawURLEncoding.EncodeToString(sigBuf),
	})

	regRec := httptest.NewRecorder()
	srv.ServeHTTP(regRec, httptest.NewRequest(http.MethodPost, "https://ca.example.com/acme/new-account", bytes.NewReader(body)))
	if regRec.Code != http.StatusCreated {
		t.Fatalf("expected 201 Created for EAB registration, got %d: %s", regRec.Code, regRec.Body.String())
	}
	if regRec.Header().Get("Location") == "" {
		t.Fatalf("expected Location header with ACME account URL")
	}
}
