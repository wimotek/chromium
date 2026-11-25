package certutil

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/mail"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	pkcs12 "software.sslmate.com/src/go-pkcs12"
)

var (
	oidExtSAN               = asn1.ObjectIdentifier{2, 5, 29, 17}
	oidMSUPN                = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 20, 2, 3}
	oidEKUAdobePDF          = asn1.ObjectIdentifier{1, 2, 840, 113583, 1, 1, 5}
	oidEKURFC9336DocSign    = asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 3, 36}
	oidEKUMSDocSign         = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 10, 3, 12}
	oidEKUServerAuth        = asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 3, 1}
	oidEKUClientAuth        = asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 3, 2}
	oidEKUCodeSigning       = asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 3, 3}
	oidEKUEmailProtection   = asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 3, 4}
)

// Signer re-exports crypto.Signer for callers working with certutil keypairs.
type Signer = crypto.Signer

// CertInspection is the structured output of `wimotek-cli certificate inspect`.
type CertInspection struct {
	Kind               string   `json:"kind"` // certificate | csr
	SubjectDN          string   `json:"subject_dn"`
	CommonName         string   `json:"common_name"`
	IssuerDN           string   `json:"issuer_dn,omitempty"`
	SerialHex          string   `json:"serial_hex,omitempty"`
	SerialColon        string   `json:"serial_colon,omitempty"`
	FingerprintSHA256  string   `json:"fingerprint_sha256,omitempty"`
	FingerprintColon   string   `json:"fingerprint_colon,omitempty"`
	SignatureAlgorithm string   `json:"signature_algorithm"`
	PublicKeyAlgorithm string   `json:"public_key_algorithm"`
	Version            int      `json:"version"`
	IsCA               bool     `json:"is_ca"`
	NotBefore          int64    `json:"not_before,omitempty"`
	NotAfter           int64    `json:"not_after,omitempty"`
	NotBeforeUTC       string   `json:"not_before_utc,omitempty"`
	NotAfterUTC        string   `json:"not_after_utc,omitempty"`
	RemainingDays      int      `json:"remaining_days,omitempty"`
	LifetimeUsedPct    float64  `json:"lifetime_used_pct,omitempty"`
	NeedsRenewal       bool     `json:"needs_renewal"`
	DNSNames           []string `json:"dns_names"`
	IPAddresses        []string `json:"ip_addresses"`
	EmailAddresses     []string `json:"email_addresses"`
	URIs               []string `json:"uris"`
	UPN                string   `json:"upn,omitempty"`
	KeyUsages          []string `json:"key_usages"`
	ExtKeyUsages       []string `json:"ext_key_usages"`
	CRLDistPoints      []string `json:"crl_distribution_points"`
	OCSPServers        []string `json:"ocsp_servers"`
	ChainLength        int      `json:"chain_length"`
}

// VerifyResult captures the outcome of `wimotek-cli certificate verify`.
type VerifyResult struct {
	Valid       bool     `json:"valid"`
	Error       string   `json:"error,omitempty"`
	SubjectDN   string   `json:"subject_dn,omitempty"`
	IssuerDN    string   `json:"issuer_dn,omitempty"`
	ChainSubjects []string `json:"chain_subjects,omitempty"`
}

// GenerateKeyPair creates a pure-Go ECDSA (P-256/P-384), Ed25519 (OKP), or RSA (2048/4096) keypair.
func GenerateKeyPair(kty, crv string, rsaBits int) (crypto.Signer, []byte, []byte, error) {
	kt := strings.ToUpper(strings.TrimSpace(kty))
	if kt == "" {
		kt = "EC"
	}
	var signer crypto.Signer
	var err error
	switch kt {
	case "EC", "ECDSA":
		curve := elliptic.P256()
		if strings.EqualFold(strings.TrimSpace(crv), "P-384") || strings.EqualFold(strings.TrimSpace(crv), "P384") {
			curve = elliptic.P384()
		}
		signer, err = ecdsa.GenerateKey(curve, rand.Reader)
	case "OKP", "ED25519":
		_, priv, genErr := ed25519.GenerateKey(rand.Reader)
		signer, err = priv, genErr
	case "RSA":
		if rsaBits < 2048 || rsaBits > 4096 {
			rsaBits = 2048
		}
		signer, err = rsa.GenerateKey(rand.Reader, rsaBits)
	default:
		return nil, nil, nil, fmt.Errorf("unsupported key type %q (use EC, OKP, or RSA)", kty)
	}
	if err != nil {
		return nil, nil, nil, err
	}

	privDER, err := x509.MarshalPKCS8PrivateKey(signer)
	if err != nil {
		return nil, nil, nil, err
	}
	privPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privDER})

	pubDER, err := x509.MarshalPKIXPublicKey(signer.Public())
	if err != nil {
		return nil, nil, nil, err
	}
	pubPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDER})

	return signer, pubPEM, privPEM, nil
}

// ParsePrivateKeyPEM parses PKCS8, EC, or PKCS1 PEM private keys.
func ParsePrivateKeyPEM(raw []byte) (crypto.Signer, error) {
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, errors.New("no PEM private key block found")
	}
	if k, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if s, ok := k.(crypto.Signer); ok {
			return s, nil
		}
	}
	if k, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		return k, nil
	}
	if k, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return k, nil
	}
	return nil, errors.New("unsupported or invalid private key format")
}

// CreateCSR generates a PEM Certificate Signing Request with DNS/IP/Email SANs.
func CreateCSR(commonName, org, ou string, sans []string, email string, signer crypto.Signer) ([]byte, error) {
	cn := strings.TrimSpace(commonName)
	if cn == "" {
		return nil, errors.New("common name (subject) is required")
	}
	subj := pkix.Name{CommonName: cn}
	if strings.TrimSpace(org) != "" {
		subj.Organization = []string{strings.TrimSpace(org)}
	}
	if strings.TrimSpace(ou) != "" {
		subj.OrganizationalUnit = []string{strings.TrimSpace(ou)}
	}

	tmpl := &x509.CertificateRequest{Subject: subj}
	seenDNS := map[string]struct{}{}
	seenIP := map[string]struct{}{}
	seenEmail := map[string]struct{}{}

	addSAN := func(raw string) {
		v := strings.TrimSpace(raw)
		if v == "" {
			return
		}
		if ip := net.ParseIP(v); ip != nil {
			s := ip.String()
			if _, ok := seenIP[s]; !ok {
				seenIP[s] = struct{}{}
				tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
			}
			return
		}
		if strings.Contains(v, "@") {
			if _, err := mail.ParseAddress(v); err == nil {
				if _, ok := seenEmail[v]; !ok {
					seenEmail[v] = struct{}{}
					tmpl.EmailAddresses = append(tmpl.EmailAddresses, v)
				}
				return
			}
		}
		if u, err := url.Parse(v); err == nil && u.Scheme != "" && u.Host != "" {
			tmpl.URIs = append(tmpl.URIs, u)
			return
		}
		if _, ok := seenDNS[v]; !ok {
			seenDNS[v] = struct{}{}
			tmpl.DNSNames = append(tmpl.DNSNames, v)
		}
	}

	for _, s := range sans {
		addSAN(s)
	}
	if strings.TrimSpace(email) != "" {
		addSAN(email)
	}
	if len(tmpl.DNSNames) == 0 && len(tmpl.IPAddresses) == 0 && strings.Contains(cn, ".") && !strings.Contains(cn, " ") && !strings.Contains(cn, "@") {
		addSAN(cn)
	}

	der, err := x509.CreateCertificateRequest(rand.Reader, tmpl, signer)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}), nil
}

// CreateSelfSignedCert creates an offline self-signed leaf or root CA certificate (`step certificate create`).
func CreateSelfSignedCert(commonName, org string, sans []string, validFor time.Duration, isCA bool, signer crypto.Signer) ([]byte, error) {
	if validFor <= 0 {
		validFor = 365 * 24 * time.Hour
	}
	serial, err := randomSerial128()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: strings.TrimSpace(commonName)},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.Add(validFor),
		BasicConstraintsValid: true,
		IsCA:                  isCA,
	}
	if strings.TrimSpace(org) != "" {
		tmpl.Subject.Organization = []string{strings.TrimSpace(org)}
	}
	if isCA {
		tmpl.KeyUsage = x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature
		tmpl.MaxPathLen = 1
	} else {
		tmpl.KeyUsage = x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment
		tmpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}
		for _, s := range sans {
			v := strings.TrimSpace(s)
			if v == "" {
				continue
			}
			if ip := net.ParseIP(v); ip != nil {
				tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
			} else if strings.Contains(v, "@") {
				tmpl.EmailAddresses = append(tmpl.EmailAddresses, v)
			} else {
				tmpl.DNSNames = append(tmpl.DNSNames, v)
			}
		}
		if len(tmpl.DNSNames) == 0 && len(tmpl.IPAddresses) == 0 && strings.Contains(commonName, ".") {
			tmpl.DNSNames = append(tmpl.DNSNames, strings.TrimSpace(commonName))
		}
	}

	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, signer.Public(), signer)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), nil
}

func randomSerial128() (*big.Int, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	b[0] = (b[0] & 0x7F) | 0x40
	return new(big.Int).SetBytes(b), nil
}

// ParseCertChainPEM extracts all X.509 certificates from a PEM bundle (or a single DER cert).
func ParseCertChainPEM(raw []byte) ([]*x509.Certificate, error) {
	var certs []*x509.Certificate
	rest := raw
	for {
		var blk *pem.Block
		blk, rest = pem.Decode(rest)
		if blk == nil {
			break
		}
		if blk.Type == "CERTIFICATE" {
			c, err := x509.ParseCertificate(blk.Bytes)
			if err != nil {
				return nil, fmt.Errorf("parse certificate PEM: %w", err)
			}
			certs = append(certs, c)
		}
	}
	if len(certs) > 0 {
		return certs, nil
	}
	// Fallback: raw DER
	c, err := x509.ParseCertificate(raw)
	if err != nil {
		return nil, errors.New("no valid PEM or DER X.509 certificate found")
	}
	return []*x509.Certificate{c}, nil
}

// FingerprintSHA256 returns lowercase hex and uppercase colon-separated SHA-256 certificate fingerprints.
func FingerprintSHA256(cert *x509.Certificate) (string, string) {
	sum := sha256.Sum256(cert.Raw)
	hexStr := hex.EncodeToString(sum[:])
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = fmt.Sprintf("%02X", b)
	}
	return hexStr, strings.Join(parts, ":")
}

// FormatColonHex formats a hex string into colon-separated uppercase byte pairs.
func FormatColonHex(h string) string {
	clean := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(h), ":", ""))
	if len(clean)%2 == 1 {
		clean = "0" + clean
	}
	parts := make([]string, 0, len(clean)/2)
	for i := 0; i < len(clean); i += 2 {
		parts = append(parts, clean[i:i+2])
	}
	return strings.Join(parts, ":")
}

// InspectPEM inspects a PEM/DER X.509 certificate or PEM CSR (`step certificate inspect`).
func InspectPEM(raw []byte) (*CertInspection, error) {
	if certs, err := ParseCertChainPEM(raw); err == nil && len(certs) > 0 {
		c := certs[0]
		fpHex, fpColon := FingerprintSHA256(c)
		serialHex := strings.ToUpper(fmt.Sprintf("%x", c.SerialNumber))
		now := time.Now().UTC()
		remDays := int(c.NotAfter.Sub(now).Hours() / 24)
		totalDur := c.NotAfter.Sub(c.NotBefore).Seconds()
		usedPct := 100.0
		if totalDur > 0 {
			usedPct = (now.Sub(c.NotBefore).Seconds() / totalDur) * 100
			if usedPct < 0 {
				usedPct = 0
			}
			if usedPct > 100 {
				usedPct = 100
			}
		}
		needsRenew, _ := NeedsRenewal(c, "33%")

		ips := make([]string, 0, len(c.IPAddresses))
		for _, ip := range c.IPAddresses {
			ips = append(ips, ip.String())
		}
		uris := make([]string, 0, len(c.URIs))
		for _, u := range c.URIs {
			uris = append(uris, u.String())
		}
		dns := c.DNSNames
		if dns == nil {
			dns = []string{}
		}
		emails := c.EmailAddresses
		if emails == nil {
			emails = []string{}
		}
		crls := c.CRLDistributionPoints
		if crls == nil {
			crls = []string{}
		}
		ocsps := c.OCSPServer
		if ocsps == nil {
			ocsps = []string{}
		}

		return &CertInspection{
			Kind:               "certificate",
			SubjectDN:          c.Subject.String(),
			CommonName:         c.Subject.CommonName,
			IssuerDN:           c.Issuer.String(),
			SerialHex:          serialHex,
			SerialColon:        FormatColonHex(serialHex),
			FingerprintSHA256:  fpHex,
			FingerprintColon:   fpColon,
			SignatureAlgorithm: c.SignatureAlgorithm.String(),
			PublicKeyAlgorithm: describePublicKey(c.PublicKey),
			Version:            c.Version,
			IsCA:               c.IsCA,
			NotBefore:          c.NotBefore.Unix(),
			NotAfter:           c.NotAfter.Unix(),
			NotBeforeUTC:       c.NotBefore.UTC().Format("2006-01-02 15:04:05 UTC"),
			NotAfterUTC:        c.NotAfter.UTC().Format("2006-01-02 15:04:05 UTC"),
			RemainingDays:      remDays,
			LifetimeUsedPct:    float64(int(usedPct*10)) / 10,
			NeedsRenewal:       needsRenew,
			DNSNames:           dns,
			IPAddresses:        ips,
			EmailAddresses:     emails,
			URIs:               uris,
			UPN:                extractMSUPN(c.Extensions),
			KeyUsages:          describeKeyUsage(c.KeyUsage),
			ExtKeyUsages:       describeEKUs(c.ExtKeyUsage, c.UnknownExtKeyUsage),
			CRLDistPoints:      crls,
			OCSPServers:        ocsps,
			ChainLength:        len(certs),
		}, nil
	}

	// Fallback: inspect PEM CSR
	blk, _ := pem.Decode(raw)
	if blk != nil && (blk.Type == "CERTIFICATE REQUEST" || blk.Type == "NEW CERTIFICATE REQUEST") {
		csr, err := x509.ParseCertificateRequest(blk.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse CSR: %w", err)
		}
		ips := make([]string, 0, len(csr.IPAddresses))
		for _, ip := range csr.IPAddresses {
			ips = append(ips, ip.String())
		}
		uris := make([]string, 0, len(csr.URIs))
		for _, u := range csr.URIs {
			uris = append(uris, u.String())
		}
		dns := csr.DNSNames
		if dns == nil {
			dns = []string{}
		}
		emails := csr.EmailAddresses
		if emails == nil {
			emails = []string{}
		}
		return &CertInspection{
			Kind:               "csr",
			SubjectDN:          csr.Subject.String(),
			CommonName:         csr.Subject.CommonName,
			SignatureAlgorithm: csr.SignatureAlgorithm.String(),
			PublicKeyAlgorithm: describePublicKey(csr.PublicKey),
			Version:            csr.Version,
			DNSNames:           dns,
			IPAddresses:        ips,
			EmailAddresses:     emails,
			URIs:               uris,
			UPN:                extractMSUPN(csr.Extensions),
			KeyUsages:          []string{},
			ExtKeyUsages:       []string{},
			CRLDistPoints:      []string{},
			OCSPServers:        []string{},
		}, nil
	}

	return nil, errors.New("input is neither a valid X.509 certificate nor a PEM CSR")
}

// VerifyCertificate verifies a certificate chain against rootsPEM and optional serverName (`step certificate verify`).
func VerifyCertificate(certPEM, rootsPEM []byte, serverName string) VerifyResult {
	certs, err := ParseCertChainPEM(certPEM)
	if err != nil {
		return VerifyResult{Valid: false, Error: err.Error()}
	}
	leaf := certs[0]
	intermediates := x509.NewCertPool()
	for _, ic := range certs[1:] {
		intermediates.AddCert(ic)
	}
	roots := x509.NewCertPool()
	if len(rootsPEM) > 0 {
		if !roots.AppendCertsFromPEM(rootsPEM) {
			return VerifyResult{Valid: false, Error: "failed to parse root CA PEM"}
		}
	} else {
		sys, err := x509.SystemCertPool()
		if err == nil && sys != nil {
			roots = sys
		}
	}

	opts := x509.VerifyOptions{
		Roots:         roots,
		Intermediates: intermediates,
		DNSName:       strings.TrimSpace(serverName),
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageAny},
	}
	chains, err := leaf.Verify(opts)
	if err != nil {
		return VerifyResult{
			Valid:     false,
			Error:     err.Error(),
			SubjectDN: leaf.Subject.String(),
			IssuerDN:  leaf.Issuer.String(),
		}
	}
	subjects := make([]string, 0)
	if len(chains) > 0 {
		for _, c := range chains[0] {
			subjects = append(subjects, c.Subject.String())
		}
	}
	return VerifyResult{
		Valid:         true,
		SubjectDN:     leaf.Subject.String(),
		IssuerDN:      leaf.Issuer.String(),
		ChainSubjects: subjects,
	}
}

// NeedsRenewal evaluates `step certificate needs-renewal` threshold ("33%", "168h", "30d").
func NeedsRenewal(cert *x509.Certificate, expiresIn string) (bool, error) {
	now := time.Now().UTC()
	if !now.Before(cert.NotAfter) {
		return true, nil
	}
	spec := strings.TrimSpace(expiresIn)
	if spec == "" {
		spec = "33%"
	}
	remaining := cert.NotAfter.Sub(now)
	if strings.HasSuffix(spec, "%") {
		pctStr := strings.TrimSuffix(spec, "%")
		pct, err := strconv.ParseFloat(strings.TrimSpace(pctStr), 64)
		if err != nil || pct <= 0 || pct >= 100 {
			return false, fmt.Errorf("invalid renewal percentage %q", spec)
		}
		total := cert.NotAfter.Sub(cert.NotBefore)
		threshold := time.Duration(float64(total) * (pct / 100.0))
		return remaining <= threshold, nil
	}
	d, err := ParseDurationExtended(spec)
	if err != nil {
		return false, err
	}
	return remaining <= d, nil
}

// ParseDurationExtended supports Go durations (e.g. "24h", "30m") plus day suffix ("90d").
func ParseDurationExtended(s string) (time.Duration, error) {
	v := strings.TrimSpace(strings.ToLower(s))
	if strings.HasSuffix(v, "d") {
		days, err := strconv.ParseFloat(strings.TrimSuffix(v, "d"), 64)
		if err != nil || days <= 0 {
			return 0, fmt.Errorf("invalid day duration %q", s)
		}
		return time.Duration(days * 24 * float64(time.Hour)), nil
	}
	return time.ParseDuration(v)
}

// EncodeModernPFX builds a Modern2023 PKCS#12 (.pfx) bundle compatible with Windows 11, macOS, and OpenSSL 3.
func EncodeModernPFX(certPEM, keyPEM, chainPEM []byte, password string) ([]byte, error) {
	certs, err := ParseCertChainPEM(certPEM)
	if err != nil {
		return nil, err
	}
	signer, err := ParsePrivateKeyPEM(keyPEM)
	if err != nil {
		return nil, err
	}
	caCerts := append([]*x509.Certificate{}, certs[1:]...)
	if len(chainPEM) > 0 {
		if extra, err := ParseCertChainPEM(chainPEM); err == nil {
			caCerts = append(caCerts, extra...)
		}
	}
	return pkcs12.Modern2023.Encode(signer, certs[0], caCerts, password)
}

// ConvertFormat converts PEM certificate to DER, or DER certificate to PEM (`step certificate format`).
func ConvertFormat(raw []byte) ([]byte, string, error) {
	if blk, _ := pem.Decode(raw); blk != nil && blk.Type == "CERTIFICATE" {
		if _, err := x509.ParseCertificate(blk.Bytes); err != nil {
			return nil, "", err
		}
		return blk.Bytes, "der", nil
	}
	if _, err := x509.ParseCertificate(raw); err == nil {
		return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: raw}), "pem", nil
	}
	return nil, "", errors.New("input is not a valid PEM or DER certificate")
}

// RandomString generates a CSPRNG secret (`step crypto rand`).
func RandomString(format string, length int) (string, error) {
	if length <= 0 || length > 256 {
		length = 32
	}
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "hex", "":
		b := make([]byte, (length+1)/2)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		return hex.EncodeToString(b)[:length], nil
	case "base64":
		b := make([]byte, length)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		return base64.RawURLEncoding.EncodeToString(b)[:length], nil
	case "alphanumeric", "ascii":
		const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
		out := make([]byte, length)
		buf := make([]byte, length)
		if _, err := rand.Read(buf); err != nil {
			return "", err
		}
		for i, v := range buf {
			out[i] = alphabet[int(v)%len(alphabet)]
		}
		return string(out), nil
	default:
		return "", fmt.Errorf("unsupported format %q (use hex, base64, or alphanumeric)", format)
	}
}

// TrustInstallCommands returns platform-specific copyable commands for installing a Root CA certificate.
func TrustInstallCommands(rootPath, caURL string) map[string]string {
	cleanPath := rootPath
	if cleanPath == "" {
		cleanPath = "root_ca.crt"
	}
	cleanURL := strings.TrimRight(caURL, "/")
	if cleanURL == "" {
		cleanURL = "https://ca.company.internal:8443"
	}
	return map[string]string{
		"windows": fmt.Sprintf("curl -fsSL %s/ca/root.crt -o root_ca.crt\ncertutil -addstore -f \"ROOT\" \"%s\"", cleanURL, cleanPath),
		"macos":   fmt.Sprintf("sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"%s\"", cleanPath),
		"linux":   fmt.Sprintf("sudo cp \"%s\" /usr/local/share/ca-certificates/wimotek-root.crt\nsudo update-ca-certificates", cleanPath),
	}
}

// InstallRootTrust installs a Root CA certificate into the current OS trust store (`step certificate install`).
func InstallRootTrust(rootPath string, dryRun bool) (string, error) {
	absPath, err := filepath.Abs(rootPath)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(absPath); err != nil {
		return "", fmt.Errorf("root certificate not found at %s: %w", absPath, err)
	}
	switch runtime.GOOS {
	case "darwin":
		args := []string{"add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain", absPath}
		cmdStr := "security " + strings.Join(args, " ")
		if dryRun {
			return cmdStr, nil
		}
		out, err := exec.Command("security", args...).CombinedOutput()
		if err != nil {
			return string(out), fmt.Errorf("macOS trust install failed (try sudo): %w (%s)", err, strings.TrimSpace(string(out)))
		}
		return "Installed into macOS System Keychain", nil
	case "windows":
		args := []string{"-addstore", "-f", "ROOT", absPath}
		cmdStr := "certutil " + strings.Join(args, " ")
		if dryRun {
			return cmdStr, nil
		}
		out, err := exec.Command("certutil", args...).CombinedOutput()
		if err != nil {
			return string(out), fmt.Errorf("Windows trust install failed (run as Administrator): %w (%s)", err, strings.TrimSpace(string(out)))
		}
		return "Installed into Windows ROOT trust store", nil
	default:
		dst := "/usr/local/share/ca-certificates/wimotek-root.crt"
		cmdStr := fmt.Sprintf("cp %s %s && update-ca-certificates", absPath, dst)
		if dryRun {
			return cmdStr, nil
		}
		raw, err := os.ReadFile(absPath)
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(dst, raw, 0o644); err != nil {
			return "", fmt.Errorf("write %s failed (try sudo): %w", dst, err)
		}
		out, err := exec.Command("update-ca-certificates").CombinedOutput()
		if err != nil {
			return string(out), fmt.Errorf("update-ca-certificates failed: %w (%s)", err, strings.TrimSpace(string(out)))
		}
		return "Installed into Linux system trust store via update-ca-certificates", nil
	}
}

func describePublicKey(pub any) string {
	switch k := pub.(type) {
	case *ecdsa.PublicKey:
		return fmt.Sprintf("ECDSA %s", k.Curve.Params().Name)
	case ed25519.PublicKey:
		return "Ed25519"
	case *rsa.PublicKey:
		return fmt.Sprintf("RSA %d-bit", k.N.BitLen())
	default:
		return fmt.Sprintf("%T", pub)
	}
}

func describeKeyUsage(ku x509.KeyUsage) []string {
	out := []string{}
	pairs := []struct {
		flag x509.KeyUsage
		name string
	}{
		{x509.KeyUsageDigitalSignature, "DigitalSignature"},
		{x509.KeyUsageContentCommitment, "ContentCommitment"},
		{x509.KeyUsageKeyEncipherment, "KeyEncipherment"},
		{x509.KeyUsageDataEncipherment, "DataEncipherment"},
		{x509.KeyUsageKeyAgreement, "KeyAgreement"},
		{x509.KeyUsageCertSign, "CertSign"},
		{x509.KeyUsageCRLSign, "CRLSign"},
	}
	for _, p := range pairs {
		if ku&p.flag != 0 {
			out = append(out, p.name)
		}
	}
	return out
}

func describeEKUs(known []x509.ExtKeyUsage, unknown []asn1.ObjectIdentifier) []string {
	out := []string{}
	for _, e := range known {
		switch e {
		case x509.ExtKeyUsageServerAuth:
			out = append(out, "ServerAuth (1.3.6.1.5.5.7.3.1)")
		case x509.ExtKeyUsageClientAuth:
			out = append(out, "ClientAuth (1.3.6.1.5.5.7.3.2)")
		case x509.ExtKeyUsageCodeSigning:
			out = append(out, "CodeSigning (1.3.6.1.5.5.7.3.3)")
		case x509.ExtKeyUsageEmailProtection:
			out = append(out, "EmailProtection (1.3.6.1.5.5.7.3.4)")
		case x509.ExtKeyUsageTimeStamping:
			out = append(out, "TimeStamping (1.3.6.1.5.5.7.3.8)")
		case x509.ExtKeyUsageOCSPSigning:
			out = append(out, "OCSPSigning (1.3.6.1.5.5.7.3.9)")
		}
	}
	for _, oid := range unknown {
		switch {
		case oid.Equal(oidEKUAdobePDF):
			out = append(out, "AdobeAuthenticDocumentsTrust ("+oid.String()+")")
		case oid.Equal(oidEKURFC9336DocSign):
			out = append(out, "DocumentSigning RFC9336 ("+oid.String()+")")
		case oid.Equal(oidEKUMSDocSign):
			out = append(out, "MSDocumentSigning ("+oid.String()+")")
		default:
			out = append(out, oid.String())
		}
	}
	return out
}

func extractMSUPN(exts []pkix.Extension) string {
	for _, ext := range exts {
		if !ext.Id.Equal(oidExtSAN) {
			continue
		}
		var seq asn1.RawValue
		if _, err := asn1.Unmarshal(ext.Value, &seq); err != nil {
			continue
		}
		rest := seq.Bytes
		for len(rest) > 0 {
			var elem asn1.RawValue
			var err error
			rest, err = asn1.Unmarshal(rest, &elem)
			if err != nil {
				break
			}
			// SAN OtherName is context-specific tag 0, constructed
			if elem.Class == asn1.ClassContextSpecific && elem.Tag == 0 {
				var oid asn1.ObjectIdentifier
				valRest, err := asn1.Unmarshal(elem.Bytes, &oid)
				if err == nil && oid.Equal(oidMSUPN) {
					var tagged asn1.RawValue
					if _, err := asn1.Unmarshal(valRest, &tagged); err == nil {
						var upnStr string
						if _, err := asn1.Unmarshal(tagged.Bytes, &upnStr); err == nil {
							return upnStr
						}
					}
				}
			}
		}
	}
	return ""
}
