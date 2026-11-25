package ca

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ocsp"
	pkcs12 "software.sslmate.com/src/go-pkcs12"

	"github.com/wimotek/ca/internal/cache"
	"github.com/wimotek/ca/internal/store"
)

const (
	ProfilePDFSigning  = "pdf_signing"
	ProfileEntraCBA    = "entra_cba"
	ProfileTLSServer   = "tls_server"
	ProfileTLSClient   = "tls_client"
	ProfileCodeSigning = "code_signing"
	ProfileSMIMEEmail  = "smime_email"
	ProfileWiFiEAP     = "wifi_eap"
	ProfileIoTDevice   = "iot_device"
)

var (
	// PDF Document Signing OIDs
	OIDAdobeAuthenticDocs = asn1.ObjectIdentifier{1, 2, 840, 113583, 1, 1, 5}
	OIDRFC9336DocSigning  = asn1.ObjectIdentifier{1, 3, 6, 1, 5, 5, 7, 3, 36}
	OIDMSDocSigning       = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 10, 3, 12}

	// Entra ID CBA OIDs
	OIDMSSmartCardLogon = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 20, 2, 2}
	OIDMSUPN            = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 20, 2, 3}
	OIDSubjectAltName   = asn1.ObjectIdentifier{2, 5, 29, 17}
)

// Config configures the two-tier PKI engine.
type Config struct {
	OrgName   string
	BaseURL   string
	MasterKey []byte // 32 bytes for AES-256-GCM at-rest private key encryption
	DataDir   string
	CertsDir  string
	TLSMode   string
}

// IssueRequest holds parameters for issuing an end-entity certificate.
type IssueRequest struct {
	Profile      string   `json:"profile"`
	CommonName   string   `json:"common_name"`
	Organization string   `json:"organization"`
	Department   string   `json:"department"`
	Country      string   `json:"country"`
	Province     string   `json:"province"`
	Locality     string   `json:"locality"`
	Email        string   `json:"email"`
	UPN          string   `json:"upn"`
	SANs         []string `json:"sans"`
	ValidityDays int      `json:"validity_days"`
	CSRPEM       string   `json:"csr_pem"`
	PFXPassword  string   `json:"pfx_password"`
	IssuedBy     string   `json:"-"`
	ClientIP     string   `json:"-"`
	MaxQuota     int      `json:"-"` // -1 = unlimited; >=0 enforced atomically inside WithTx
}

// IssueResult returns the issued certificate record and optional Modern2023 .pfx bundle.
type IssueResult struct {
	Record    store.CertificateRecord `json:"certificate"`
	ChainPEM  string                  `json:"chain_pem"`
	PFXBase64 string                  `json:"pfx_base64,omitempty"`
	Filename  string                  `json:"filename"`
}

// Overview summarizes Root CA, Issuing CA, and inventory counts.
type Overview struct {
	RootCA      AuthoritySummary `json:"root_ca"`
	IssuingCA   AuthoritySummary `json:"issuing_ca"`
	ActiveCount int              `json:"active_count"`
	RevokedCnt  int              `json:"revoked_count"`
	Expiring30d int              `json:"expiring_30d"`
	CRLURL      string           `json:"crl_url"`
	OCSPURL     string           `json:"ocsp_url"`
	BaseURL     string           `json:"base_url"`
	OrgName     string           `json:"org_name"`
	DBDriver    string           `json:"db_driver"`
	DataDir     string           `json:"data_dir"`
	CertsDir    string           `json:"certs_dir"`
	TLSMode     string           `json:"tls_mode"`
}

// AuthoritySummary represents public metadata of a CA tier.
type AuthoritySummary struct {
	Tier              string `json:"tier"`
	SubjectDN         string `json:"subject_dn"`
	SerialHex         string `json:"serial_hex"`
	FingerprintSHA256 string `json:"fingerprint_sha256"`
	Algorithm         string `json:"algorithm"`
	NotBefore         int64  `json:"not_before"`
	NotAfter          int64  `json:"not_after"`
	CertPEM           string `json:"cert_pem"`
}

// Engine manages Root CA -> Issuing CA ECDSA P-256 operations, CRL, and OCSP.
type Engine struct {
	mu      sync.RWMutex
	cfg     Config
	store   *store.Store
	cache   *cache.HybridCache
	rootCrt *x509.Certificate
	rootKey *ecdsa.PrivateKey
	rootPEM string
	issCrt  *x509.Certificate
	issKey  *ecdsa.PrivateKey
	issPEM  string
}

// NewEngine loads existing Root & Issuing CAs or bootstraps a fresh two-tier ECDSA P-256 hierarchy.
func NewEngine(ctx context.Context, st *store.Store, hc *cache.HybridCache, cfg Config) (*Engine, error) {
	if savedOrg, err := st.GetSetting(ctx, "org_name"); err == nil && strings.TrimSpace(savedOrg) != "" {
		cfg.OrgName = savedOrg
	}
	if savedBase, err := st.GetSetting(ctx, "base_url"); err == nil && strings.TrimSpace(savedBase) != "" {
		cfg.BaseURL = savedBase
	}
	if cfg.OrgName == "" {
		cfg.OrgName = "Wimotek Enterprise"
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "http://localhost:3000"
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")

	if len(cfg.MasterKey) != 32 {
		sum := sha256.Sum256(cfg.MasterKey)
		cfg.MasterKey = sum[:]
	}

	e := &Engine{
		cfg:   cfg,
		store: st,
		cache: hc,
	}

	if err := e.bootstrap(ctx, false); err != nil {
		return nil, err
	}
	return e, nil
}

// ReconfigureFromWizard updates OrgName and BaseURL during the first-run Setup Wizard.
// If no end-entity certificates exist yet and org/base changed, re-bootstraps Root & Issuing CA cleanly.
func (e *Engine) ReconfigureFromWizard(ctx context.Context, orgName, baseURL string) error {
	org := strings.TrimSpace(orgName)
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")

	e.mu.Lock()
	changed := false
	if org != "" && org != e.cfg.OrgName {
		e.cfg.OrgName = org
		changed = true
	}
	if base != "" && base != e.cfg.BaseURL {
		e.cfg.BaseURL = base
		changed = true
	}
	e.mu.Unlock()

	if org != "" {
		_ = e.store.SetSetting(ctx, "org_name", org)
	}
	if base != "" {
		_ = e.store.SetSetting(ctx, "base_url", base)
	}
	if !changed {
		return nil
	}
	existingCerts, err := e.store.ListCertificates(ctx)
	if err == nil && len(existingCerts) == 0 {
		e.mu.Lock()
		defer e.mu.Unlock()
		return e.bootstrap(ctx, true)
	}
	return nil
}

func (e *Engine) bootstrap(ctx context.Context, forceRegenerate bool) error {
	if !forceRegenerate {
		rootRec, err := e.store.GetAuthority(ctx, "root")
		if err != nil {
			return fmt.Errorf("load root ca: %w", err)
		}
		issRec, err := e.store.GetAuthority(ctx, "issuing")
		if err != nil {
			return fmt.Errorf("load issuing ca: %w", err)
		}

		if rootRec != nil && issRec != nil {
			rCrt, rKey, err := e.parseAuthority(rootRec)
			if err != nil {
				return fmt.Errorf("parse stored root ca: %w", err)
			}
			iCrt, iKey, err := e.parseAuthority(issRec)
			if err != nil {
				return fmt.Errorf("parse stored issuing ca: %w", err)
			}
			e.rootCrt, e.rootKey, e.rootPEM = rCrt, rKey, rootRec.CertPEM
			e.issCrt, e.issKey, e.issPEM = iCrt, iKey, issRec.CertPEM
			return nil
		}
	}

	// First-boot auto-generation: Root CA (20y, ECDSA P-256) -> Issuing CA (10y, ECDSA P-256)
	now := time.Now().UTC().Truncate(time.Second)

	rootKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate root key: %w", err)
	}
	rootSerial, rootSerialHex, err := store.GenerateSerial128()
	if err != nil {
		return err
	}
	rootSKI := subjectKeyID(&rootKey.PublicKey)

	rootTpl := &x509.Certificate{
		SerialNumber: rootSerial,
		Subject: pkix.Name{
			CommonName:   e.cfg.OrgName + " Root CA",
			Organization: []string{e.cfg.OrgName},
		},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.AddDate(20, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            1,
		MaxPathLenZero:        false,
		SubjectKeyId:          rootSKI,
	}

	rootDER, err := x509.CreateCertificate(rand.Reader, rootTpl, rootTpl, &rootKey.PublicKey, rootKey)
	if err != nil {
		return fmt.Errorf("sign root ca: %w", err)
	}
	rootCrt, err := x509.ParseCertificate(rootDER)
	if err != nil {
		return err
	}
	rootPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: rootDER}))
	rootKeyEnc, err := e.encryptPrivateKey(rootKey)
	if err != nil {
		return err
	}

	if err := e.store.UpsertAuthority(ctx, store.AuthorityRecord{
		Tier:              "root",
		SubjectDN:         rootCrt.Subject.String(),
		SerialHex:         rootSerialHex,
		FingerprintSHA256: certFingerprint(rootDER),
		CertPEM:           rootPEM,
		KeyPEMEnc:         rootKeyEnc,
		NotBefore:         rootCrt.NotBefore.Unix(),
		NotAfter:          rootCrt.NotAfter.Unix(),
		CreatedAt:         now.Unix(),
	}); err != nil {
		return fmt.Errorf("persist root ca: %w", err)
	}

	issKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate issuing key: %w", err)
	}
	issSerial, issSerialHex, err := store.GenerateSerial128()
	if err != nil {
		return err
	}
	issSKI := subjectKeyID(&issKey.PublicKey)

	issTpl := &x509.Certificate{
		SerialNumber: issSerial,
		Subject: pkix.Name{
			CommonName:   e.cfg.OrgName + " Issuing CA G1",
			Organization: []string{e.cfg.OrgName},
		},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
		SubjectKeyId:          issSKI,
		AuthorityKeyId:        rootSKI,
		CRLDistributionPoints: []string{e.cfg.BaseURL + "/ca/crl.der"},
		IssuingCertificateURL: []string{e.cfg.BaseURL + "/ca/root.crt"},
		OCSPServer:            []string{e.cfg.BaseURL + "/ca/ocsp"},
	}

	issDER, err := x509.CreateCertificate(rand.Reader, issTpl, rootCrt, &issKey.PublicKey, rootKey)
	if err != nil {
		return fmt.Errorf("sign issuing ca: %w", err)
	}
	issCrt, err := x509.ParseCertificate(issDER)
	if err != nil {
		return err
	}
	issPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: issDER}))
	issKeyEnc, err := e.encryptPrivateKey(issKey)
	if err != nil {
		return err
	}

	if err := e.store.UpsertAuthority(ctx, store.AuthorityRecord{
		Tier:              "issuing",
		SubjectDN:         issCrt.Subject.String(),
		SerialHex:         issSerialHex,
		FingerprintSHA256: certFingerprint(issDER),
		CertPEM:           issPEM,
		KeyPEMEnc:         issKeyEnc,
		NotBefore:         issCrt.NotBefore.Unix(),
		NotAfter:          issCrt.NotAfter.Unix(),
		CreatedAt:         now.Unix(),
	}); err != nil {
		return fmt.Errorf("persist issuing ca: %w", err)
	}

	_ = e.store.AppendAudit(ctx, store.AuditRecord{
		Actor:        "system",
		Action:       "ca.bootstrap",
		TargetSerial: issSerialHex,
		ClientIP:     "127.0.0.1",
		DetailJSON:   fmt.Sprintf(`{"root_serial":"%s","issuing_serial":"%s","algorithm":"ECDSA P-256"}`, rootSerialHex, issSerialHex),
		CreatedAt:    now.Unix(),
	})

	e.rootCrt, e.rootKey, e.rootPEM = rootCrt, rootKey, rootPEM
	e.issCrt, e.issKey, e.issPEM = issCrt, issKey, issPEM
	return nil
}

func (e *Engine) parseAuthority(rec *store.AuthorityRecord) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	blk, _ := pem.Decode([]byte(rec.CertPEM))
	if blk == nil {
		return nil, nil, errors.New("invalid ca cert pem")
	}
	crt, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		return nil, nil, err
	}
	key, err := e.decryptPrivateKey(rec.KeyPEMEnc)
	if err != nil {
		return nil, nil, err
	}
	return crt, key, nil
}

func (e *Engine) encryptPrivateKey(key *ecdsa.PrivateKey) (string, error) {
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(e.cfg.MasterKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, der, nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

func (e *Engine) decryptPrivateKey(encoded string) (*ecdsa.PrivateKey, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(e.cfg.MasterKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(raw) < gcm.NonceSize() {
		return nil, errors.New("encrypted key truncated")
	}
	nonce, ciphertext := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	der, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}
	return x509.ParseECPrivateKey(der)
}

func subjectKeyID(pub *ecdsa.PublicKey) []byte {
	b, _ := x509.MarshalPKIXPublicKey(pub)
	sum := sha256.Sum256(b)
	return sum[:20]
}

func certFingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	hexStr := strings.ToUpper(hex.EncodeToString(sum[:]))
	parts := make([]string, 0, len(hexStr)/2)
	for i := 0; i < len(hexStr); i += 2 {
		parts = append(parts, hexStr[i:i+2])
	}
	return strings.Join(parts, ":")
}

// RootPEM returns the Root CA certificate in PEM format.
func (e *Engine) RootPEM() string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.rootPEM
}

// IssuingPEM returns the Issuing CA certificate in PEM format.
func (e *Engine) IssuingPEM() string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.issPEM
}

// ChainPEM returns Issuing CA + Root CA PEM bundle.
func (e *Engine) ChainPEM() string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.issPEM + "\n" + e.rootPEM
}

// Overview gathers Root/Issuing CA metadata and current inventory counters.
func (e *Engine) Overview(ctx context.Context) (*Overview, error) {
	certs, err := e.store.ListCertificates(ctx)
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	in30d := now + 30*86400
	var active, revoked, expiring int
	for _, c := range certs {
		if c.Status == "revoked" {
			revoked++
		} else if c.NotAfter > now {
			active++
			if c.NotAfter <= in30d {
				expiring++
			}
		}
	}

	e.mu.RLock()
	defer e.mu.RUnlock()

	return &Overview{
		RootCA: AuthoritySummary{
			Tier:              "root",
			SubjectDN:         e.rootCrt.Subject.String(),
			SerialHex:         strings.ToUpper(e.rootCrt.SerialNumber.Text(16)),
			FingerprintSHA256: certFingerprint(e.rootCrt.Raw),
			Algorithm:         "ECDSA P-256 / SHA-256",
			NotBefore:         e.rootCrt.NotBefore.Unix(),
			NotAfter:          e.rootCrt.NotAfter.Unix(),
			CertPEM:           e.rootPEM,
		},
		IssuingCA: AuthoritySummary{
			Tier:              "issuing",
			SubjectDN:         e.issCrt.Subject.String(),
			SerialHex:         strings.ToUpper(e.issCrt.SerialNumber.Text(16)),
			FingerprintSHA256: certFingerprint(e.issCrt.Raw),
			Algorithm:         "ECDSA P-256 / SHA-256",
			NotBefore:         e.issCrt.NotBefore.Unix(),
			NotAfter:          e.issCrt.NotAfter.Unix(),
			CertPEM:           e.issPEM,
		},
		ActiveCount: active,
		RevokedCnt:  revoked,
		Expiring30d: expiring,
		CRLURL:      e.cfg.BaseURL + "/ca/crl.der",
		OCSPURL:     e.cfg.BaseURL + "/ca/ocsp",
		BaseURL:     e.cfg.BaseURL,
		OrgName:     e.cfg.OrgName,
		DBDriver:    string(e.store.Driver),
		DataDir:     e.cfg.DataDir,
		CertsDir:    e.cfg.CertsDir,
		TLSMode:     e.cfg.TLSMode,
	}, nil
}

// SetTLSMode updates the runtime TLS mode reported by Overview once TLSManager initializes.
func (e *Engine) SetTLSMode(mode string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cfg.TLSMode = mode
}

// IsSupportedProfile reports whether a profile ID is valid.
func IsSupportedProfile(profile string) bool {
	switch strings.TrimSpace(strings.ToLower(profile)) {
	case ProfilePDFSigning, ProfileEntraCBA, ProfileTLSServer, ProfileTLSClient,
		ProfileCodeSigning, ProfileSMIMEEmail, ProfileWiFiEAP, ProfileIoTDevice:
		return true
	default:
		return false
	}
}

// Issue mints an X.509 end-entity certificate across all 8 enterprise templates.
// When CSRPEM is empty, generates a fresh ECDSA P-256 key and packages Modern2023 .pfx.
// Enforces user quota atomically inside WithTx when req.MaxQuota >= 0.
func (e *Engine) Issue(ctx context.Context, req IssueRequest) (*IssueResult, error) {
	profile := strings.TrimSpace(strings.ToLower(req.Profile))
	if !IsSupportedProfile(profile) {
		return nil, fmt.Errorf("unsupported profile %q", req.Profile)
	}

	cn := strings.TrimSpace(req.CommonName)
	csrPEM := strings.TrimSpace(req.CSRPEM)

	var pubKey any
	var leafKey *ecdsa.PrivateKey
	var keyMode string
	var csrSubject pkix.Name
	var csrDNS []string
	var csrIPs []net.IP
	var csrEmails []string

	if csrPEM != "" {
		keyMode = "csr_signed"
		blk, _ := pem.Decode([]byte(csrPEM))
		if blk == nil {
			return nil, errors.New("invalid PEM CSR block")
		}
		csr, err := x509.ParseCertificateRequest(blk.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse csr: %w", err)
		}
		if err := csr.CheckSignature(); err != nil {
			return nil, fmt.Errorf("invalid csr signature: %w", err)
		}
		pubKey = csr.PublicKey
		csrSubject = csr.Subject
		csrDNS = csr.DNSNames
		csrIPs = csr.IPAddresses
		csrEmails = csr.EmailAddresses
		if cn == "" {
			cn = csr.Subject.CommonName
		}
	} else {
		keyMode = "auto_pfx"
		var err error
		leafKey, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, fmt.Errorf("generate leaf key: %w", err)
		}
		pubKey = &leafKey.PublicKey
	}

	if cn == "" {
		return nil, errors.New("common_name is required")
	}

	ttlDays := req.ValidityDays
	if ttlDays <= 0 {
		switch profile {
		case ProfilePDFSigning, ProfileCodeSigning:
			ttlDays = 1095
		case ProfileSMIMEEmail, ProfileWiFiEAP:
			ttlDays = 730
		default:
			ttlDays = 365
		}
	}
	if ttlDays > 3650 {
		ttlDays = 3650
	}

	e.mu.RLock()
	defaultOrg := e.cfg.OrgName
	baseURL := e.cfg.BaseURL
	issCrt, issKey, rootCrt := e.issCrt, e.issKey, e.rootCrt
	e.mu.RUnlock()

	org := strings.TrimSpace(req.Organization)
	if org == "" {
		if len(csrSubject.Organization) > 0 {
			org = csrSubject.Organization[0]
		} else {
			org = defaultOrg
		}
	}

	subject := pkix.Name{
		CommonName:   cn,
		Organization: []string{org},
	}
	if ou := strings.TrimSpace(req.Department); ou != "" {
		subject.OrganizationalUnit = []string{ou}
	}
	if c := strings.ToUpper(strings.TrimSpace(req.Country)); len(c) == 2 {
		subject.Country = []string{c}
	}
	if st := strings.TrimSpace(req.Province); st != "" {
		subject.Province = []string{st}
	}
	if l := strings.TrimSpace(req.Locality); l != "" {
		subject.Locality = []string{l}
	}

	serial, serialHex, err := store.GenerateSerial128()
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC().Truncate(time.Second)

	tpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               subject,
		NotBefore:             now.Add(-2 * time.Minute),
		NotAfter:              now.AddDate(0, 0, ttlDays),
		BasicConstraintsValid: true,
		IsCA:                  false,
		AuthorityKeyId:        issCrt.SubjectKeyId,
		CRLDistributionPoints: []string{baseURL + "/ca/crl.der"},
		IssuingCertificateURL: []string{baseURL + "/ca/issuing.crt"},
		OCSPServer:            []string{baseURL + "/ca/ocsp"},
	}

	var sanLabels []string
	var ekuOIDLabels []string
	upn := strings.TrimSpace(req.UPN)
	email := strings.TrimSpace(req.Email)
	if email == "" && len(csrEmails) > 0 {
		email = csrEmails[0]
	}

	addNetworkSANs := func(fallbackCN bool) {
		seenDNS := map[string]struct{}{}
		seenIP := map[string]struct{}{}
		addSAN := func(entry string) {
			s := strings.TrimSpace(entry)
			if s == "" {
				return
			}
			if ip := net.ParseIP(s); ip != nil {
				key := ip.String()
				if _, ok := seenIP[key]; !ok {
					seenIP[key] = struct{}{}
					tpl.IPAddresses = append(tpl.IPAddresses, ip)
					sanLabels = append(sanLabels, "IP:"+key)
				}
			} else {
				lower := strings.ToLower(s)
				if _, ok := seenDNS[lower]; !ok {
					seenDNS[lower] = struct{}{}
					tpl.DNSNames = append(tpl.DNSNames, lower)
					sanLabels = append(sanLabels, "DNS:"+lower)
				}
			}
		}
		for _, s := range req.SANs {
			addSAN(s)
		}
		for _, d := range csrDNS {
			addSAN(d)
		}
		for _, ip := range csrIPs {
			addSAN(ip.String())
		}
		if fallbackCN && len(tpl.DNSNames) == 0 && len(tpl.IPAddresses) == 0 {
			addSAN(cn)
		}
	}

	switch profile {
	case ProfilePDFSigning:
		tpl.KeyUsage = x509.KeyUsageDigitalSignature | x509.KeyUsageContentCommitment
		tpl.UnknownExtKeyUsage = []asn1.ObjectIdentifier{
			OIDAdobeAuthenticDocs,
			OIDRFC9336DocSigning,
			OIDMSDocSigning,
		}
		ekuOIDLabels = []string{
			"1.2.840.113583.1.1.5 (Adobe Authentic Documents Trust)",
			"1.3.6.1.5.5.7.3.36 (RFC 9336 Document Signing)",
			"1.3.6.1.4.1.311.10.3.12 (Microsoft Document Signing)",
		}
		if email != "" {
			tpl.EmailAddresses = []string{email}
			sanLabels = append(sanLabels, "email:"+email)
		}

	case ProfileEntraCBA:
		if upn == "" {
			return nil, errors.New("upn (msUPN, e.g. user@company.com) is required for entra_cba profile")
		}
		tpl.KeyUsage = x509.KeyUsageDigitalSignature
		tpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
		tpl.UnknownExtKeyUsage = []asn1.ObjectIdentifier{OIDMSSmartCardLogon}
		ekuOIDLabels = []string{
			"1.3.6.1.5.5.7.3.2 (TLS Web Client Authentication)",
			"1.3.6.1.4.1.311.20.2.2 (Microsoft Smart Card Logon)",
		}
		sanExt, err := buildEntraCBASANExtension(upn, email)
		if err != nil {
			return nil, fmt.Errorf("build entra_cba SAN extension: %w", err)
		}
		tpl.ExtraExtensions = append(tpl.ExtraExtensions, sanExt)
		sanLabels = append(sanLabels, "msUPN:"+upn)
		if email != "" {
			sanLabels = append(sanLabels, "email:"+email)
		}

	case ProfileTLSServer:
		tpl.KeyUsage = x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment
		tpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}
		ekuOIDLabels = []string{
			"1.3.6.1.5.5.7.3.1 (TLS Web Server Authentication)",
			"1.3.6.1.5.5.7.3.2 (TLS Web Client Authentication)",
		}
		addNetworkSANs(true)

	case ProfileTLSClient:
		tpl.KeyUsage = x509.KeyUsageDigitalSignature
		tpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
		ekuOIDLabels = []string{
			"1.3.6.1.5.5.7.3.2 (TLS Web Client Authentication / mTLS / VPN)",
		}
		if email != "" {
			tpl.EmailAddresses = []string{email}
			sanLabels = append(sanLabels, "email:"+email)
		}
		addNetworkSANs(false)

	case ProfileCodeSigning:
		tpl.KeyUsage = x509.KeyUsageDigitalSignature | x509.KeyUsageContentCommitment
		tpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning}
		ekuOIDLabels = []string{
			"1.3.6.1.5.5.7.3.3 (Code Signing)",
		}
		if email != "" {
			tpl.EmailAddresses = []string{email}
			sanLabels = append(sanLabels, "email:"+email)
		}

	case ProfileSMIMEEmail:
		if email == "" {
			return nil, errors.New("email address is required for smime_email profile")
		}
		tpl.KeyUsage = x509.KeyUsageDigitalSignature | x509.KeyUsageContentCommitment | x509.KeyUsageKeyEncipherment
		tpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageEmailProtection}
		ekuOIDLabels = []string{
			"1.3.6.1.5.5.7.3.4 (E-mail Protection / S/MIME)",
		}
		tpl.EmailAddresses = []string{email}
		sanLabels = append(sanLabels, "email:"+email)

	case ProfileWiFiEAP:
		tpl.KeyUsage = x509.KeyUsageDigitalSignature
		tpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
		ekuOIDLabels = []string{
			"1.3.6.1.5.5.7.3.2 (TLS Web Client Authentication / 802.1X EAP-TLS)",
		}
		if upn != "" {
			sanExt, err := buildEntraCBASANExtension(upn, email)
			if err != nil {
				return nil, fmt.Errorf("build wifi_eap SAN extension: %w", err)
			}
			tpl.ExtraExtensions = append(tpl.ExtraExtensions, sanExt)
			sanLabels = append(sanLabels, "msUPN:"+upn)
			if email != "" {
				sanLabels = append(sanLabels, "email:"+email)
			}
		} else {
			if email != "" {
				tpl.EmailAddresses = []string{email}
				sanLabels = append(sanLabels, "email:"+email)
			}
			addNetworkSANs(false)
		}

	case ProfileIoTDevice:
		tpl.KeyUsage = x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment
		tpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth}
		ekuOIDLabels = []string{
			"1.3.6.1.5.5.7.3.2 (TLS Web Client Authentication)",
			"1.3.6.1.5.5.7.3.1 (TLS Web Server Authentication)",
		}
		addNetworkSANs(true)
	}

	der, err := x509.CreateCertificate(rand.Reader, tpl, issCrt, pubKey, issKey)
	if err != nil {
		return nil, fmt.Errorf("sign leaf certificate: %w", err)
	}
	leafCrt, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}

	leafPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	chainPEM := leafPEM + "\n" + e.IssuingPEM() + "\n" + e.RootPEM()

	var pfxB64 string
	if leafKey != nil {
		pfxPass := req.PFXPassword
		if pfxPass == "" {
			pfxPass = "changeit"
		}
		// Modern2023 PKCS#12 encoding (AES-256-CBC + PBES2 + SHA-256) for Windows 11 / macOS / iOS / Adobe
		pfxBytes, err := pkcs12.Modern2023.Encode(leafKey, leafCrt, []*x509.Certificate{issCrt, rootCrt}, pfxPass)
		if err != nil {
			return nil, fmt.Errorf("encode modern2023 pfx: %w", err)
		}
		pfxB64 = base64.StdEncoding.EncodeToString(pfxBytes)
	}

	sansJSON, _ := json.Marshal(sanLabels)
	ekuJSON, _ := json.Marshal(ekuOIDLabels)
	actor := req.IssuedBy
	if actor == "" {
		actor = "admin"
	}

	rec := store.CertificateRecord{
		SerialHex:         serialHex,
		Profile:           profile,
		CommonName:        cn,
		SubjectDN:         leafCrt.Subject.String(),
		SANsJSON:          string(sansJSON),
		EKUOIDsJSON:       string(ekuJSON),
		UPN:               upn,
		KeyMode:           keyMode,
		FingerprintSHA256: certFingerprint(der),
		CertPEM:           leafPEM,
		Status:            "active",
		RevokedAt:         0,
		RevocationReason:  0,
		NotBefore:         leafCrt.NotBefore.Unix(),
		NotAfter:          leafCrt.NotAfter.Unix(),
		IssuedBy:          actor,
		CreatedAt:         now.Unix(),
	}

	// Enforce quota atomically inside WithTx (prevents concurrent issuance race conditions)
	maxQuota := req.MaxQuota
	if maxQuota == 0 {
		maxQuota = -1 // Default for internal/legacy callers unless explicitly bounded
	}
	if err := e.store.InsertCertificateWithQuota(ctx, rec, actor, maxQuota); err != nil {
		return nil, err
	}

	_ = e.store.AppendAudit(ctx, store.AuditRecord{
		Actor:        actor,
		Action:       "cert.issue",
		TargetSerial: serialHex,
		ClientIP:     req.ClientIP,
		DetailJSON:   fmt.Sprintf(`{"profile":%q,"cn":%q,"key_mode":%q}`, profile, cn, keyMode),
		CreatedAt:    now.Unix(),
	})

	safeName := sanitizeFilename(cn)
	return &IssueResult{
		Record:    rec,
		ChainPEM:  chainPEM,
		PFXBase64: pfxB64,
		Filename:  safeName,
	}, nil
}

// buildEntraCBASANExtension builds RFC 5280 SubjectAltName with OtherName msUPN (1.3.6.1.4.1.311.20.2.3).
func buildEntraCBASANExtension(upn, email string) (pkix.Extension, error) {
	type otherName struct {
		TypeID asn1.ObjectIdentifier
		Value  asn1.RawValue `asn1:"tag:0,explicit"`
	}
	upnBytes, err := asn1.MarshalWithParams(upn, "utf8")
	if err != nil {
		return pkix.Extension{}, err
	}
	on := otherName{
		TypeID: OIDMSUPN,
		Value: asn1.RawValue{
			Class:      asn1.ClassContextSpecific,
			Tag:        0,
			IsCompound: true,
			Bytes:      upnBytes,
		},
	}
	onDER, err := asn1.Marshal(on)
	if err != nil {
		return pkix.Extension{}, err
	}

	rawValues := []asn1.RawValue{
		{
			Class:      asn1.ClassContextSpecific,
			Tag:        0,
			IsCompound: true,
			Bytes:      stripOuterTLV(onDER),
		},
	}
	if email != "" {
		rawValues = append(rawValues, asn1.RawValue{
			Class: asn1.ClassContextSpecific,
			Tag:   1, // rfc822Name IA5String
			Bytes: []byte(email),
		})
	}
	sanDER, err := asn1.Marshal(rawValues)
	if err != nil {
		return pkix.Extension{}, err
	}
	return pkix.Extension{
		Id:       OIDSubjectAltName,
		Critical: false,
		Value:    sanDER,
	}, nil
}

func stripOuterTLV(der []byte) []byte {
	var rv asn1.RawValue
	if _, err := asn1.Unmarshal(der, &rv); err == nil {
		return rv.Bytes
	}
	return der
}

// Revoke marks a certificate revoked and double-deletes CRL keys in SQL + Redis caches.
func (e *Engine) Revoke(ctx context.Context, serialHex string, reason int, actor, clientIP string) error {
	now := time.Now().UTC().Unix()
	ok, err := e.store.RevokeCertificate(ctx, serialHex, reason, now)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("certificate not found or already revoked")
	}

	// CRITICAL REDLINE: Double-delete CRL cache in both SQL cache_kv and Redis.
	_ = e.cache.DoubleDelete(ctx, cache.CRLIssuingDERKey, cache.CRLIssuingPEMKey)

	_ = e.store.AppendAudit(ctx, store.AuditRecord{
		Actor:        actor,
		Action:       "cert.revoke",
		TargetSerial: strings.ToUpper(strings.TrimSpace(serialHex)),
		ClientIP:     clientIP,
		DetailJSON:   fmt.Sprintf(`{"reason":%d}`, reason),
		CreatedAt:    now,
	})
	return nil
}

// GetCRLDER returns cached RFC 5280 v2 DER CRL or compiles and caches a fresh one.
func (e *Engine) GetCRLDER(ctx context.Context) ([]byte, error) {
	if cached, ok, err := e.cache.Get(ctx, cache.CRLIssuingDERKey); err == nil && ok && len(cached) > 0 {
		return cached, nil
	}

	revoked, err := e.store.ListRevokedCertificates(ctx)
	if err != nil {
		return nil, err
	}

	entries := make([]x509.RevocationListEntry, 0, len(revoked))
	for _, r := range revoked {
		sn, ok := new(big.Int).SetString(r.SerialHex, 16)
		if !ok {
			continue
		}
		entries = append(entries, x509.RevocationListEntry{
			SerialNumber:   sn,
			RevocationTime: time.Unix(r.RevokedAt, 0).UTC(),
			ReasonCode:     r.RevocationReason,
		})
	}

	now := time.Now().UTC().Truncate(time.Second)
	e.mu.RLock()
	issCrt, issKey := e.issCrt, e.issKey
	e.mu.RUnlock()

	crlTpl := &x509.RevocationList{
		Number:                    big.NewInt(now.Unix()),
		ThisUpdate:                now,
		NextUpdate:                now.Add(24 * time.Hour),
		RevokedCertificateEntries: entries,
	}

	der, err := x509.CreateRevocationList(rand.Reader, crlTpl, issCrt, issKey)
	if err != nil {
		return nil, fmt.Errorf("create crl: %w", err)
	}

	_ = e.cache.Set(ctx, cache.CRLIssuingDERKey, der, 10*time.Minute)
	return der, nil
}

// GetCRLPEM returns RFC 5280 v2 CRL in PEM encoding.
func (e *Engine) GetCRLPEM(ctx context.Context) ([]byte, error) {
	der, err := e.GetCRLDER(ctx)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "X509 CRL", Bytes: der}), nil
}

// HandleOCSP parses an RFC 6960 DER OCSP request and signs the OCSP response with Issuing CA.
func (e *Engine) HandleOCSP(ctx context.Context, reqDER []byte) ([]byte, error) {
	ocspReq, err := ocsp.ParseRequest(reqDER)
	if err != nil {
		return nil, fmt.Errorf("parse ocsp request: %w", err)
	}
	serialHex := strings.ToUpper(fmt.Sprintf("%032X", ocspReq.SerialNumber))
	rec, err := e.store.GetCertificate(ctx, serialHex)
	if err != nil {
		return nil, err
	}
	if rec == nil {
		rec, err = e.store.GetCertificate(ctx, strings.ToUpper(ocspReq.SerialNumber.Text(16)))
		if err != nil {
			return nil, err
		}
	}

	now := time.Now().UTC()
	tmpl := ocsp.Response{
		SerialNumber: ocspReq.SerialNumber,
		ThisUpdate:   now,
		NextUpdate:   now.Add(1 * time.Hour),
		Status:       ocsp.Unknown,
	}
	if rec != nil {
		if rec.Status == "revoked" {
			tmpl.Status = ocsp.Revoked
			tmpl.RevokedAt = time.Unix(rec.RevokedAt, 0).UTC()
			tmpl.RevocationReason = rec.RevocationReason
		} else {
			tmpl.Status = ocsp.Good
		}
	}

	e.mu.RLock()
	issCrt, issKey := e.issCrt, e.issKey
	e.mu.RUnlock()

	return ocsp.CreateResponse(issCrt, issCrt, tmpl, issKey)
}

func sanitizeFilename(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
		} else if r == ' ' {
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), ".-")
	if out == "" {
		return "certificate"
	}
	return out
}
