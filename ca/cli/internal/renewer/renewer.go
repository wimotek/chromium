package renewer

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wimotek/cli/internal/certutil"
	"github.com/wimotek/cli/internal/client"
	"github.com/wimotek/cli/internal/config"
)

// IssueParams configures local key generation, CSR submission, and managed cert tracking.
type IssueParams struct {
	ContextName  string
	Name         string
	Profile      string
	CommonName   string
	SANs         []string
	UPN          string
	Email        string
	KeyType      string // EC | OKP | RSA
	Curve        string // P-256 | P-384
	RSABits      int    // 2048 | 4096
	ValidityDays int
	RenewBefore  string
	AutoRenew    bool
	CertOutPath  string // Optional explicit path (CLI); if empty, confined under CertsDir
	KeyOutPath   string // Optional explicit path (CLI); if empty, confined under CertsDir
	TokenOverride string
}

// Service orchestrates local certificate issuance, atomic renewal, and revocation against a CA context.
type Service struct {
	Mgr *config.Manager
}

func New(mgr *config.Manager) *Service {
	return &Service{Mgr: mgr}
}

// ClientForContext constructs an authenticated CA HTTP client for the specified context (or active context).
func (s *Service) ClientForContext(contextName, tokenOverride string) (*config.Context, *client.Client, error) {
	ctxRec, err := s.Mgr.GetContext(contextName)
	if err != nil {
		return nil, nil, err
	}
	var rootPEM []byte
	if ctxRec.RootCertPath != "" {
		if raw, readErr := os.ReadFile(ctxRec.RootCertPath); readErr == nil {
			rootPEM = raw
		}
	}
	tok := strings.TrimSpace(tokenOverride)
	if tok == "" {
		tok = ctxRec.Token
	}
	return ctxRec, client.New(ctxRec.CAURL, tok, rootPEM, ctxRec.InsecureSkipVerify), nil
}

// Issue generates a local private key + CSR, requests signing from wimotek/ca, writes files atomically, and tracks the certificate.
func (s *Service) Issue(ctx context.Context, p IssueParams) (*config.ManagedCert, error) {
	if strings.TrimSpace(p.CommonName) == "" {
		return nil, errors.New("common_name is required")
	}
	ctxRec, cli, err := s.ClientForContext(p.ContextName, p.TokenOverride)
	if err != nil {
		return nil, err
	}
	if cli.Token == "" {
		return nil, errors.New("no API or session token configured for this CA context; run 'wimotek-cli ca token' or save a provisioner token")
	}

	kty := strings.ToUpper(strings.TrimSpace(p.KeyType))
	if kty == "" {
		kty = "EC"
	}
	signer, _, privPEM, err := certutil.GenerateKeyPair(kty, p.Curve, p.RSABits)
	if err != nil {
		return nil, fmt.Errorf("generate keypair: %w", err)
	}
	csrPEM, err := certutil.CreateCSR(p.CommonName, "", "", p.SANs, p.Email, signer)
	if err != nil {
		return nil, fmt.Errorf("create CSR: %w", err)
	}

	profile := strings.TrimSpace(p.Profile)
	if profile == "" {
		profile = "tls_server"
	}
	signResp, err := cli.SignCSR(ctx, client.SignRequest{
		Profile:      profile,
		CommonName:   strings.TrimSpace(p.CommonName),
		SANs:         p.SANs,
		UPN:          strings.TrimSpace(p.UPN),
		Email:        strings.TrimSpace(p.Email),
		CSRPEM:       string(csrPEM),
		ValidityDays: p.ValidityDays,
	})
	if err != nil {
		return nil, fmt.Errorf("CA sign failed: %w", err)
	}

	slugBase := strings.TrimSpace(p.Name)
	if slugBase == "" {
		slugBase = slugify(p.CommonName)
	}
	safeSlug, err := config.SanitizeName(slugBase)
	if err != nil {
		safeSlug = "cert-" + config.RandomID(4)
	}

	certPath := strings.TrimSpace(p.CertOutPath)
	keyPath := strings.TrimSpace(p.KeyOutPath)
	if certPath == "" {
		certPath, err = s.Mgr.ResolveConfinedCertPath(filepath.Join(safeSlug, safeSlug+".crt"))
		if err != nil {
			return nil, err
		}
	}
	if keyPath == "" {
		keyPath, err = s.Mgr.ResolveConfinedCertPath(filepath.Join(safeSlug, safeSlug+".key"))
		if err != nil {
			return nil, err
		}
	}

	chainBytes := []byte(signResp.ChainPEM)
	if len(chainBytes) == 0 {
		chainBytes = []byte(signResp.CertPEM)
	}
	if err := atomicWriteFile(keyPath, privPEM, 0o600); err != nil {
		return nil, fmt.Errorf("write private key: %w", err)
	}
	if err := atomicWriteFile(certPath, chainBytes, 0o644); err != nil {
		return nil, fmt.Errorf("write certificate: %w", err)
	}

	notBefore := signResp.NotBefore
	notAfter := signResp.NotAfter
	serialHex := signResp.SerialHex
	if parsed, parseErr := certutil.ParseCertChainPEM(chainBytes); parseErr == nil && len(parsed) > 0 {
		notBefore = parsed[0].NotBefore.Unix()
		notAfter = parsed[0].NotAfter.Unix()
		if serialHex == "" {
			serialHex = strings.ToUpper(fmt.Sprintf("%x", parsed[0].SerialNumber))
		}
	}

	renewBefore := strings.TrimSpace(p.RenewBefore)
	if renewBefore == "" {
		renewBefore = "33%"
	}
	sans := p.SANs
	if sans == nil {
		sans = []string{}
	}

	rec := config.ManagedCert{
		Name:          safeSlug,
		Context:       ctxRec.Name,
		Profile:       profile,
		CommonName:    strings.TrimSpace(p.CommonName),
		SANs:          sans,
		UPN:           strings.TrimSpace(p.UPN),
		Email:         strings.TrimSpace(p.Email),
		KeyType:       kty,
		CertPath:      certPath,
		KeyPath:       keyPath,
		SerialHex:     strings.ToUpper(serialHex),
		NotBefore:     notBefore,
		NotAfter:      notAfter,
		RenewBefore:   renewBefore,
		AutoRenew:     p.AutoRenew,
		Status:        "active",
		LastRenewedAt: time.Now().Unix(),
	}
	return s.Mgr.UpsertManagedCert(rec)
}

// RenewEntry checks whether a managed certificate needs renewal (or forces renewal) and rotates the cert atomically.
func (s *Service) RenewEntry(ctx context.Context, id string, force bool) (*config.ManagedCert, bool, error) {
	st, err := s.Mgr.Load()
	if err != nil {
		return nil, false, err
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
		return nil, false, fmt.Errorf("managed certificate %q not found", id)
	}
	if target.Status == "revoked" && !force {
		return target, false, errors.New("certificate is marked revoked; pass force=true to re-issue")
	}

	if !force {
		rawCert, readErr := os.ReadFile(target.CertPath)
		if readErr == nil {
			if certs, parseErr := certutil.ParseCertChainPEM(rawCert); parseErr == nil && len(certs) > 0 {
				due, checkErr := certutil.NeedsRenewal(certs[0], target.RenewBefore)
				if checkErr == nil && !due {
					return target, false, nil
				}
			}
		}
	}

	_, cli, err := s.ClientForContext(target.Context, "")
	if err != nil {
		return nil, false, err
	}
	if cli.Token == "" {
		return nil, false, errors.New("CA context has no saved token for automated renewal")
	}

	// Reuse existing private key if present; otherwise generate fresh keypair.
	var signerKeyPEM []byte
	var signer, parseErr = func() (certutil.Signer, error) {
		rawKey, rErr := os.ReadFile(target.KeyPath)
		if rErr == nil {
			if k, pErr := certutil.ParsePrivateKeyPEM(rawKey); pErr == nil {
				signerKeyPEM = rawKey
				return k, nil
			}
		}
		k, _, privPEM, gErr := certutil.GenerateKeyPair(target.KeyType, "", 2048)
		if gErr != nil {
			return nil, gErr
		}
		signerKeyPEM = privPEM
		return k, nil
	}()
	if parseErr != nil {
		return nil, false, fmt.Errorf("load/generate key: %w", parseErr)
	}

	csrPEM, err := certutil.CreateCSR(target.CommonName, "", "", target.SANs, target.Email, signer)
	if err != nil {
		return nil, false, fmt.Errorf("create renewal CSR: %w", err)
	}

	signResp, err := cli.SignCSR(ctx, client.SignRequest{
		Profile:    target.Profile,
		CommonName: target.CommonName,
		SANs:       target.SANs,
		UPN:        target.UPN,
		Email:      target.Email,
		CSRPEM:     string(csrPEM),
	})
	if err != nil {
		target.LastError = err.Error()
		_, _ = s.Mgr.UpsertManagedCert(*target)
		return target, false, fmt.Errorf("CA renewal failed: %w", err)
	}

	chainBytes := []byte(signResp.ChainPEM)
	if len(chainBytes) == 0 {
		chainBytes = []byte(signResp.CertPEM)
	}
	if err := atomicWriteFile(target.KeyPath, signerKeyPEM, 0o600); err != nil {
		return nil, false, err
	}
	if err := atomicWriteFile(target.CertPath, chainBytes, 0o644); err != nil {
		return nil, false, err
	}

	if certs, pErr := certutil.ParseCertChainPEM(chainBytes); pErr == nil && len(certs) > 0 {
		target.NotBefore = certs[0].NotBefore.Unix()
		target.NotAfter = certs[0].NotAfter.Unix()
		target.SerialHex = strings.ToUpper(fmt.Sprintf("%x", certs[0].SerialNumber))
	} else {
		target.SerialHex = strings.ToUpper(signResp.SerialHex)
		target.NotBefore = signResp.NotBefore
		target.NotAfter = signResp.NotAfter
	}
	target.Status = "active"
	target.LastError = ""
	target.LastRenewedAt = time.Now().Unix()

	updated, err := s.Mgr.UpsertManagedCert(*target)
	return updated, true, err
}

// RenewFile renews an arbitrary certificate/key pair on disk (aligned with `step ca renew cert.crt cert.key`).
func (s *Service) RenewFile(ctx context.Context, contextName, tokenOverride, certPath, keyPath, profile, expiresIn string, force bool) (*client.SignResponse, bool, error) {
	rawCert, err := os.ReadFile(certPath)
	if err != nil {
		return nil, false, fmt.Errorf("read certificate %s: %w", certPath, err)
	}
	certs, err := certutil.ParseCertChainPEM(rawCert)
	if err != nil {
		return nil, false, err
	}
	leaf := certs[0]
	if !force {
		due, err := certutil.NeedsRenewal(leaf, expiresIn)
		if err != nil {
			return nil, false, err
		}
		if !due {
			return nil, false, nil
		}
	}

	rawKey, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, false, fmt.Errorf("read private key %s: %w", keyPath, err)
	}
	signer, err := certutil.ParsePrivateKeyPEM(rawKey)
	if err != nil {
		return nil, false, err
	}

	sans := append([]string{}, leaf.DNSNames...)
	for _, ip := range leaf.IPAddresses {
		sans = append(sans, ip.String())
	}
	var email string
	if len(leaf.EmailAddresses) > 0 {
		email = leaf.EmailAddresses[0]
	}
	csrPEM, err := certutil.CreateCSR(leaf.Subject.CommonName, "", "", sans, email, signer)
	if err != nil {
		return nil, false, err
	}
	if strings.TrimSpace(profile) == "" {
		profile = "tls_server"
	}

	_, cli, err := s.ClientForContext(contextName, tokenOverride)
	if err != nil {
		return nil, false, err
	}
	signResp, err := cli.SignCSR(ctx, client.SignRequest{
		Profile:    profile,
		CommonName: leaf.Subject.CommonName,
		SANs:       sans,
		Email:      email,
		CSRPEM:     string(csrPEM),
	})
	if err != nil {
		return nil, false, err
	}
	chainBytes := []byte(signResp.ChainPEM)
	if len(chainBytes) == 0 {
		chainBytes = []byte(signResp.CertPEM)
	}
	if err := atomicWriteFile(certPath, chainBytes, 0o644); err != nil {
		return nil, false, err
	}
	return signResp, true, nil
}

// RevokeEntry revokes a managed certificate on the CA and updates local tracking status.
func (s *Service) RevokeEntry(ctx context.Context, id string, reason int) (*config.ManagedCert, error) {
	st, err := s.Mgr.Load()
	if err != nil {
		return nil, err
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
		return nil, fmt.Errorf("managed certificate %q not found", id)
	}
	_, cli, err := s.ClientForContext(target.Context, "")
	if err != nil {
		return nil, err
	}
	if err := cli.Revoke(ctx, target.SerialHex, reason); err != nil {
		return nil, err
	}
	target.Status = "revoked"
	target.AutoRenew = false
	target.LastError = ""
	return s.Mgr.UpsertManagedCert(*target)
}

// RenewAllDue scans all auto_renew managed certificates and renews any that have reached their RenewBefore threshold.
func (s *Service) RenewAllDue(ctx context.Context) (renewed int, failed int) {
	st, err := s.Mgr.Load()
	if err != nil {
		return 0, 0
	}
	for _, mc := range st.ManagedCerts {
		if !mc.AutoRenew || mc.Status == "revoked" {
			continue
		}
		_, did, rErr := s.RenewEntry(ctx, mc.ID, false)
		if rErr != nil {
			failed++
			log.Printf("[wimotek-cli renewer] failed to renew %s (%s): %v", mc.Name, mc.CommonName, rErr)
			continue
		}
		if did {
			renewed++
			log.Printf("[wimotek-cli renewer] renewed %s (%s)", mc.Name, mc.CommonName)
		}
	}
	return renewed, failed
}

// StartDaemon runs periodic background renewal checks until ctx is canceled.
func (s *Service) StartDaemon(ctx context.Context, interval time.Duration) {
	if interval < time.Minute {
		interval = 15 * time.Minute
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.RenewAllDue(ctx)
			}
		}
	}()
}

func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp." + config.RandomID(4)
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func slugify(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-.")
	if out == "" {
		return "cert-" + config.RandomID(3)
	}
	if len(out) > 48 {
		out = out[:48]
	}
	return out
}
