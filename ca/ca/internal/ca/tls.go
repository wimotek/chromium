package ca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// TLSManager handles read-only mounted certificates in /certs:ro with permission checks,
// periodic hot-reload, and automatic self-signed/Issuing-CA-signed fallback into /data/tls.
type TLSManager struct {
	mu          sync.RWMutex
	certsDir    string
	dataDir     string
	mode        string // "mounted_ro" | "auto_self_signed" | "disabled"
	certPath    string
	keyPath     string
	cert        *tls.Certificate
	lastModTime time.Time
	lastChecked time.Time
}

// Mode returns the active TLS certificate source mode.
func (m *TLSManager) Mode() string {
	if m == nil {
		return "disabled"
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.mode
}

// TLSConfig builds a hardened TLS 1.2+ config with dynamic GetCertificate hot-reloading.
func (m *TLSManager) TLSConfig() *tls.Config {
	return &tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: m.getCertificate,
	}
}

func (m *TLSManager) getCertificate(_ *tls.ClientHelloInfo) (*tls.Certificate, error) {
	m.mu.RLock()
	shouldCheck := m.mode == "mounted_ro" && time.Since(m.lastChecked) > 30*time.Second
	current := m.cert
	m.mu.RUnlock()

	if shouldCheck {
		m.reloadIfChanged()
		m.mu.RLock()
		current = m.cert
		m.mu.RUnlock()
	}
	if current == nil {
		return nil, errors.New("tls certificate not loaded")
	}
	return current, nil
}

func (m *TLSManager) reloadIfChanged() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lastChecked = time.Now()

	st, err := os.Stat(m.certPath)
	if err != nil || !st.ModTime().After(m.lastModTime) {
		return
	}
	loaded, err := loadKeyPairWithPermCheck(m.certPath, m.keyPath)
	if err != nil {
		log.Printf("[tls] hot-reload warning for %s: %v (keeping previous cert)", m.certPath, err)
		return
	}
	m.cert = loaded
	m.lastModTime = st.ModTime()
	log.Printf("[tls] hot-reloaded mounted certificate from %s", m.certPath)
}

// SetupServerTLS inspects certsDir (/certs:ro) first. If valid readable certs exist, loads them
// without ever writing to certsDir. If no cert is mounted, generates an ECDSA P-256 certificate
// into dataDir/tls (/data/tls) so zero-config HTTPS works out of the box even as non-root UID 10001.
func SetupServerTLS(certsDir, dataDir, extraHosts string, pki *Engine) (*TLSManager, error) {
	if certsDir == "" {
		certsDir = "/certs"
	}
	if dataDir == "" {
		dataDir = "/data"
	}

	// Candidate pairs commonly mounted into /certs:ro (Kubernetes TLS Secret, Certbot, custom)
	candidates := [][2]string{
		{"tls.crt", "tls.key"},
		{"fullchain.pem", "privkey.pem"},
		{"server.crt", "server.key"},
	}

	for _, pair := range candidates {
		cPath := filepath.Join(certsDir, pair[0])
		kPath := filepath.Join(certsDir, pair[1])
		cStat, cErr := os.Stat(cPath)
		_, kErr := os.Stat(kPath)

		if cErr == nil && kErr == nil {
			loaded, err := loadKeyPairWithPermCheck(cPath, kPath)
			if err != nil {
				return nil, fmt.Errorf("mounted TLS files found in %s but unreadable (check non-root UID 10001 read permissions on /certs:ro): %w", certsDir, err)
			}
			log.Printf("[tls] loaded read-only mounted certificate: %s", cPath)
			return &TLSManager{
				certsDir:    certsDir,
				dataDir:     dataDir,
				mode:        "mounted_ro",
				certPath:    cPath,
				keyPath:     kPath,
				cert:        loaded,
				lastModTime: cStat.ModTime(),
				lastChecked: time.Now(),
			}, nil
		}
		if errors.Is(cErr, os.ErrPermission) || errors.Is(kErr, os.ErrPermission) {
			return nil, fmt.Errorf("permission denied accessing %s (ensure directory is 0755 and cert/key readable by UID 10001)", certsDir)
		}
	}

	// No mounted certificate found in /certs -> generate or reuse auto self-signed/Issuing-CA-signed cert in /data/tls
	tlsDir := filepath.Join(dataDir, "tls")
	if err := os.MkdirAll(tlsDir, 0o750); err != nil {
		return nil, fmt.Errorf("create auto-tls directory %s (check /data permissions for UID 10001): %w", tlsDir, err)
	}

	autoCertPath := filepath.Join(tlsDir, "server.crt")
	autoKeyPath := filepath.Join(tlsDir, "server.key")

	if loaded, err := loadValidReusableAutoCert(autoCertPath, autoKeyPath); err == nil {
		log.Printf("[tls] reused persisted auto-generated TLS certificate from %s", autoCertPath)
		return &TLSManager{
			certsDir:    certsDir,
			dataDir:     dataDir,
			mode:        "auto_self_signed",
			certPath:    autoCertPath,
			keyPath:     autoKeyPath,
			cert:        loaded,
			lastChecked: time.Now(),
		}, nil
	}

	loaded, err := generateAutoServerCert(autoCertPath, autoKeyPath, extraHosts, pki)
	if err != nil {
		return nil, fmt.Errorf("generate auto TLS certificate: %w", err)
	}
	log.Printf("[tls] no certificate mounted in %s; generated ECDSA P-256 HTTPS certificate at %s", certsDir, autoCertPath)
	return &TLSManager{
		certsDir:    certsDir,
		dataDir:     dataDir,
		mode:        "auto_self_signed",
		certPath:    autoCertPath,
		keyPath:     autoKeyPath,
		cert:        loaded,
		lastChecked: time.Now(),
	}, nil
}

func loadKeyPairWithPermCheck(certPath, keyPath string) (*tls.Certificate, error) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return nil, err
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, err
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, err
	}
	return &pair, nil
}

func loadValidReusableAutoCert(certPath, keyPath string) (*tls.Certificate, error) {
	pair, err := loadKeyPairWithPermCheck(certPath, keyPath)
	if err != nil {
		return nil, err
	}
	if len(pair.Certificate) == 0 {
		return nil, errors.New("empty cert chain")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, err
	}
	// Regenerate automatically if expiring within 15 days.
	if time.Until(leaf.NotAfter) < 15*24*time.Hour {
		return nil, errors.New("auto cert expiring soon")
	}
	return pair, nil
}

func generateAutoServerCert(certPath, keyPath, extraHosts string, pki *Engine) (*tls.Certificate, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}

	serialBytes := make([]byte, 16)
	_, _ = rand.Read(serialBytes)
	serialBytes[0] = (serialBytes[0] & 0x7F) | 0x40
	serial := new(big.Int).SetBytes(serialBytes)

	dnsNames := []string{"localhost", "wimotek-ca"}
	ips := []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}
	if hn, err := os.Hostname(); err == nil && hn != "" && hn != "localhost" {
		dnsNames = append(dnsNames, hn)
	}
	for _, raw := range strings.Split(extraHosts, ",") {
		h := strings.TrimSpace(raw)
		if h == "" {
			continue
		}
		if ip := net.ParseIP(h); ip != nil {
			ips = append(ips, ip)
		} else {
			dnsNames = append(dnsNames, h)
		}
	}

	now := time.Now().UTC().Truncate(time.Second)
	tpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   dnsNames[0],
			Organization: []string{"wimotek/ca Auto TLS"},
		},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.AddDate(1, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              dnsNames,
		IPAddresses:           ips,
	}

	var certDER []byte
	var chainPEM []byte

	// Sign with Issuing CA if available so endpoints trusting Root CA trust the console HTTPS automatically;
	// otherwise create a standalone self-signed ECDSA P-256 certificate.
	if pki != nil && pki.issCrt != nil && pki.issKey != nil {
		pki.mu.RLock()
		issCrt, issKey, issPEM := pki.issCrt, pki.issKey, pki.issPEM
		pki.mu.RUnlock()
		tpl.AuthorityKeyId = issCrt.SubjectKeyId
		certDER, err = x509.CreateCertificate(rand.Reader, tpl, issCrt, &priv.PublicKey, issKey)
		if err != nil {
			return nil, err
		}
		leafPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
		chainPEM = append(leafPEM, []byte("\n"+issPEM)...)
	} else {
		certDER, err = x509.CreateCertificate(rand.Reader, tpl, tpl, &priv.PublicKey, priv)
		if err != nil {
			return nil, err
		}
		chainPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	}

	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return nil, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	if err := os.WriteFile(certPath, chainPEM, 0o644); err != nil {
		return nil, err
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return nil, err
	}

	pair, err := tls.X509KeyPair(chainPEM, keyPEM)
	if err != nil {
		return nil, err
	}
	return &pair, nil
}
