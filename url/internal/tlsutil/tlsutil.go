package tlsutil

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// LoadOrGenerate inspects read-only /certs for fullchain.pem & privkey.pem (or cert.pem & key.pem).
// If empty, unmounted, or unreadable, it automatically generates and persists an ECDSA P-256
// self-signed certificate inside the writable fallbackDir (/data/certs).
func LoadOrGenerate(mountedDir, fallbackDir, hostname string) (*tls.Config, string, error) {
	candidates := [][2]string{
		{"fullchain.pem", "privkey.pem"},
		{"cert.pem", "key.pem"},
	}

	for _, pair := range candidates {
		certPath := filepath.Join(mountedDir, pair[0])
		keyPath := filepath.Join(mountedDir, pair[1])
		if fileNonEmpty(certPath) && fileNonEmpty(keyPath) {
			cert, err := tls.LoadX509KeyPair(certPath, keyPath)
			if err == nil {
				return &tls.Config{
					MinVersion:   tls.VersionTLS12,
					Certificates: []tls.Certificate{cert},
				}, "mounted_certs", nil
			}
		}
	}

	if err := os.MkdirAll(fallbackDir, 0o700); err != nil {
		return nil, "", err
	}
	fbCert := filepath.Join(fallbackDir, "selfsigned-fullchain.pem")
	fbKey := filepath.Join(fallbackDir, "selfsigned-privkey.pem")

	if !fileNonEmpty(fbCert) || !fileNonEmpty(fbKey) {
		if err := generateSelfSigned(fbCert, fbKey, hostname); err != nil {
			return nil, "", err
		}
	}

	cert, err := tls.LoadX509KeyPair(fbCert, fbKey)
	if err != nil {
		return nil, "", err
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{cert},
	}, "self_signed", nil
}

func fileNonEmpty(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Size() > 0
}

func generateSelfSigned(certPath, keyPath, hostname string) error {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}

	if hostname == "" {
		hostname = "localhost"
	}

	tmpl := x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			Organization: []string{"wimotek/url Self-Signed"},
			CommonName:   hostname,
		},
		NotBefore:             time.Now().Add(-5 * time.Minute),
		NotAfter:              time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{hostname, "localhost"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}

	derBytes, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return err
	}

	keyBytes, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: derBytes})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes})

	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		return err
	}
	return os.WriteFile(keyPath, keyPEM, 0o600)
}
