package ca_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"testing"

	"golang.org/x/crypto/ocsp"
	pkcs12 "software.sslmate.com/src/go-pkcs12"

	"github.com/wimotek/ca/internal/ca"
	"github.com/wimotek/ca/internal/cache"
	"github.com/wimotek/ca/internal/store"
)

func TestPKILifecycleProfilesPFXRevocationOCSP(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite store: %v", err)
	}
	defer st.Close()

	hc := cache.NewHybridCache(st, cache.RedisConfig{})
	defer hc.Close()

	engine, err := ca.NewEngine(ctx, st, hc, ca.Config{
		OrgName:   "Acme Test Corp",
		BaseURL:   "https://ca.acme.test",
		MasterKey: []byte("0123456789abcdef0123456789abcdef"),
	})
	if err != nil {
		t.Fatalf("bootstrap pki engine: %v", err)
	}

	// 1. PDF Signing profile with auto-keygen Modern2023 PFX
	pdfRes, err := engine.Issue(ctx, ca.IssueRequest{
		Profile:     ca.ProfilePDFSigning,
		CommonName:  "Jane Signer",
		Email:       "jane@acme.test",
		PFXPassword: "TestPass#2026",
	})
	if err != nil {
		t.Fatalf("issue pdf_signing: %v", err)
	}
	if pdfRes.PFXBase64 == "" {
		t.Fatalf("expected Modern2023 PFX payload when no CSR provided")
	}
	pfxRaw, err := base64.StdEncoding.DecodeString(pdfRes.PFXBase64)
	if err != nil {
		t.Fatalf("decode pfx base64: %v", err)
	}
	_, leafCert, caChain, err := pkcs12.DecodeChain(pfxRaw, "TestPass#2026")
	if err != nil {
		t.Fatalf("decode Modern2023 PFX chain: %v", err)
	}
	if len(caChain) != 2 {
		t.Fatalf("expected 2 CA certs in PFX chain, got %d", len(caChain))
	}
	if len(leafCert.UnknownExtKeyUsage) != 3 {
		t.Fatalf("expected 3 PDF signing OIDs, got %d", len(leafCert.UnknownExtKeyUsage))
	}

	// 2. Entra ID CBA profile with msUPN OtherName + ClientAuth + HTTP CRL
	entraRes, err := engine.Issue(ctx, ca.IssueRequest{
		Profile:     ca.ProfileEntraCBA,
		CommonName:  "Alice Wang",
		UPN:         "alice@acme.test",
		Email:       "alice@acme.test",
		PFXPassword: "EntraPass#2026",
	})
	if err != nil {
		t.Fatalf("issue entra_cba: %v", err)
	}
	blk, _ := pem.Decode([]byte(entraRes.Record.CertPEM))
	entraCert, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		t.Fatalf("parse entra cert: %v", err)
	}
	if len(entraCert.CRLDistributionPoints) == 0 || entraCert.CRLDistributionPoints[0] != "https://ca.acme.test/ca/crl.der" {
		t.Fatalf("expected HTTP CRL distribution point, got %v", entraCert.CRLDistributionPoints)
	}

	// 3. TLS Server profile via CSR signing
	srvKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	csrDER, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject:  pkix.Name{CommonName: "api.acme.internal"},
		DNSNames: []string{"api.acme.internal", "gateway.acme.internal"},
	}, srvKey)
	csrPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER}))

	tlsRes, err := engine.Issue(ctx, ca.IssueRequest{
		Profile:    ca.ProfileTLSServer,
		CommonName: "api.acme.internal",
		SANs:       []string{"10.20.0.15"},
		CSRPEM:     csrPEM,
	})
	if err != nil {
		t.Fatalf("issue tls_server CSR: %v", err)
	}
	if tlsRes.PFXBase64 != "" {
		t.Fatalf("did not expect PFX when CSR was provided")
	}

	// 4. CRL & Revocation + OCSP check
	if _, err := engine.GetCRLDER(ctx); err != nil {
		t.Fatalf("initial CRL generation failed: %v", err)
	}
	if err := engine.Revoke(ctx, entraRes.Record.SerialHex, 1, "admin", "127.0.0.1"); err != nil {
		t.Fatalf("revoke cert: %v", err)
	}
	crlDER, err := engine.GetCRLDER(ctx)
	if err != nil {
		t.Fatalf("post-revoke CRL failed: %v", err)
	}
	parsedCRL, err := x509.ParseRevocationList(crlDER)
	if err != nil {
		t.Fatalf("parse CRL: %v", err)
	}
	if len(parsedCRL.RevokedCertificateEntries) != 1 {
		t.Fatalf("expected 1 revoked cert in CRL, got %d", len(parsedCRL.RevokedCertificateEntries))
	}

	// Verify OCSP returns Revoked for revoked cert
	issBlk, _ := pem.Decode([]byte(engine.IssuingPEM()))
	issCert, _ := x509.ParseCertificate(issBlk.Bytes)
	ocspReqDER, err := ocsp.CreateRequest(entraCert, issCert, nil)
	if err != nil {
		t.Fatalf("create ocsp req: %v", err)
	}
	ocspRespDER, err := engine.HandleOCSP(ctx, ocspReqDER)
	if err != nil {
		t.Fatalf("handle ocsp: %v", err)
	}
	ocspResp, err := ocsp.ParseResponse(ocspRespDER, issCert)
	if err != nil {
		t.Fatalf("parse ocsp resp: %v", err)
	}
	if ocspResp.Status != ocsp.Revoked {
		t.Fatalf("expected OCSP Revoked status, got %d", ocspResp.Status)
	}
}
