package certutil

import (
	"crypto/x509"
	"encoding/pem"
	"testing"
	"time"
)

func TestKeypairCSRInspectAndFormat(t *testing.T) {
	for _, tc := range []struct {
		kty string
		crv string
	}{
		{"EC", "P-256"},
		{"EC", "P-384"},
		{"OKP", ""},
		{"RSA", ""},
	} {
		signer, pubPEM, privPEM, err := GenerateKeyPair(tc.kty, tc.crv, 2048)
		if err != nil {
			t.Fatalf("GenerateKeyPair(%s,%s): %v", tc.kty, tc.crv, err)
		}
		if len(pubPEM) == 0 || len(privPEM) == 0 {
			t.Fatalf("empty PEM output for %s", tc.kty)
		}
		if _, err := ParsePrivateKeyPEM(privPEM); err != nil {
			t.Fatalf("ParsePrivateKeyPEM(%s): %v", tc.kty, err)
		}

		csrPEM, err := CreateCSR("api.corp.internal", "Wimotek", "Ops", []string{"api.corp.internal", "10.0.0.5"}, "ops@corp.internal", signer)
		if err != nil {
			t.Fatalf("CreateCSR(%s): %v", tc.kty, err)
		}
		info, err := InspectPEM(csrPEM)
		if err != nil {
			t.Fatalf("InspectPEM(CSR %s): %v", tc.kty, err)
		}
		if info.Kind != "csr" || info.CommonName != "api.corp.internal" {
			t.Fatalf("unexpected CSR inspection: %+v", info)
		}
		if len(info.DNSNames) != 1 || len(info.IPAddresses) != 1 || len(info.EmailAddresses) != 1 {
			t.Fatalf("expected DNS/IP/Email SANs, got %+v", info)
		}
	}
}

func TestSelfSignedVerifyNeedsRenewalPFXAndConvert(t *testing.T) {
	signer, _, privPEM, err := GenerateKeyPair("EC", "P-256", 2048)
	if err != nil {
		t.Fatal(err)
	}
	certPEM, err := CreateSelfSignedCert("app.corp.internal", "Wimotek", []string{"app.corp.internal"}, 10*24*time.Hour, false, signer)
	if err != nil {
		t.Fatal(err)
	}
	info, err := InspectPEM(certPEM)
	if err != nil {
		t.Fatal(err)
	}
	if info.Kind != "certificate" || info.CommonName != "app.corp.internal" || info.FingerprintSHA256 == "" {
		t.Fatalf("unexpected cert inspection: %+v", info)
	}

	// Self-signed verifies against itself
	vr := VerifyCertificate(certPEM, certPEM, "app.corp.internal")
	if !vr.Valid {
		t.Fatalf("expected valid verification, got error: %s", vr.Error)
	}
	vrWrong := VerifyCertificate(certPEM, certPEM, "wrong.corp.internal")
	if vrWrong.Valid {
		t.Fatal("expected verification failure for mismatched hostname")
	}

	// NeedsRenewal checks
	certs, err := ParseCertChainPEM(certPEM)
	if err != nil {
		t.Fatal(err)
	}
	due33, err := NeedsRenewal(certs[0], "33%")
	if err != nil || due33 {
		t.Fatalf("fresh 10d cert should not need renewal at 33%%: due=%v err=%v", due33, err)
	}
	due15d, err := NeedsRenewal(certs[0], "15d")
	if err != nil || !due15d {
		t.Fatalf("10d cert should need renewal at 15d threshold: due=%v err=%v", due15d, err)
	}

	// Modern2023 PKCS#12 encoding
	pfx, err := EncodeModernPFX(certPEM, privPEM, nil, "s3cr3t")
	if err != nil || len(pfx) < 100 {
		t.Fatalf("EncodeModernPFX failed: len=%d err=%v", len(pfx), err)
	}

	// PEM -> DER -> PEM roundtrip
	der, fmt1, err := ConvertFormat(certPEM)
	if err != nil || fmt1 != "der" {
		t.Fatalf("PEM->DER failed: fmt=%s err=%v", fmt1, err)
	}
	if _, err := x509.ParseCertificate(der); err != nil {
		t.Fatalf("invalid DER output: %v", err)
	}
	pemBack, fmt2, err := ConvertFormat(der)
	if err != nil || fmt2 != "pem" {
		t.Fatalf("DER->PEM failed: fmt=%s err=%v", fmt2, err)
	}
	if blk, _ := pem.Decode(pemBack); blk == nil || blk.Type != "CERTIFICATE" {
		t.Fatal("roundtripped PEM invalid")
	}

	// CSPRNG secrets
	for _, f := range []string{"hex", "base64", "alphanumeric"} {
		s, err := RandomString(f, 32)
		if err != nil || len(s) != 32 {
			t.Fatalf("RandomString(%s) failed: len=%d err=%v", f, len(s), err)
		}
	}
}
