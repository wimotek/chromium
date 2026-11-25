package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type PublicKeyInfo struct {
	KeyID string
	Key   *rsa.PublicKey
}

type RetiringKeyMeta struct {
	KeyID     string `json:"kid"`
	ExpiresAt string `json:"expiresAt"`
}

type SigningKeyStatus struct {
	ActiveKid    string            `json:"activeKid"`
	RotatedAt    string            `json:"rotatedAt"`
	JwksKeyCount int               `json:"jwksKeyCount"`
	RetiringKeys []RetiringKeyMeta `json:"retiringKeys"`
}

type retiringPublicKey struct {
	kid       string
	pub       *rsa.PublicKey
	expiresAt time.Time
}

type KeyManager struct {
	mu        sync.RWMutex
	rsaPath   string
	masterKey [32]byte
	rsaKey    *rsa.PrivateKey
	keyID     string
	rotatedAt time.Time
	retiring  []retiringPublicKey
}

func NewKeyManager(dataDir, envMasterKey string) (*KeyManager, error) {
	keysDir := filepath.Join(dataDir, "keys")
	if err := os.MkdirAll(keysDir, 0o700); err != nil {
		return nil, err
	}

	// Derive 32-byte AES-256 key from env or persistent /data/keys/master.key
	var master [32]byte
	if envMasterKey != "" {
		master = sha256.Sum256([]byte(envMasterKey))
	} else {
		masterPath := filepath.Join(keysDir, "master.key")
		raw, err := os.ReadFile(masterPath)
		if err != nil {
			buf := make([]byte, 32)
			if _, rErr := io.ReadFull(rand.Reader, buf); rErr != nil {
				return nil, rErr
			}
			if wErr := os.WriteFile(masterPath, buf, 0o600); wErr != nil {
				return nil, wErr
			}
			master = sha256.Sum256(buf)
		} else {
			master = sha256.Sum256(raw)
		}
	}

	// Load or generate persistent RSA-2048 signing key for OIDC RS256 ID Tokens
	rsaPath := filepath.Join(keysDir, "oidc_rs256.pem")
	priv, err := loadOrGenerateRSAKey(rsaPath)
	if err != nil {
		return nil, err
	}

	kid := computeRSAKeyID(&priv.PublicKey)

	return &KeyManager{
		rsaPath:   rsaPath,
		masterKey: master,
		rsaKey:    priv,
		keyID:     kid,
		rotatedAt: time.Now().UTC(),
	}, nil
}

func computeRSAKeyID(pub *rsa.PublicKey) string {
	pubBytes := x509.MarshalPKCS1PublicKey(pub)
	thumb := sha256.Sum256(pubBytes)
	return base64.RawURLEncoding.EncodeToString(thumb[:8])
}

func (km *KeyManager) PrivateKey() *rsa.PrivateKey {
	km.mu.RLock()
	defer km.mu.RUnlock()
	return km.rsaKey
}

func (km *KeyManager) KeyID() string {
	km.mu.RLock()
	defer km.mu.RUnlock()
	return km.keyID
}

func (km *KeyManager) pruneExpiredLocked(now time.Time) {
	kept := km.retiring[:0]
	for _, r := range km.retiring {
		if r.expiresAt.After(now) {
			kept = append(kept, r)
		}
	}
	km.retiring = kept
}

func (km *KeyManager) PublicKeys() []PublicKeyInfo {
	km.mu.Lock()
	defer km.mu.Unlock()
	km.pruneExpiredLocked(time.Now().UTC())
	out := make([]PublicKeyInfo, 0, 1+len(km.retiring))
	out = append(out, PublicKeyInfo{KeyID: km.keyID, Key: &km.rsaKey.PublicKey})
	for _, r := range km.retiring {
		out = append(out, PublicKeyInfo{KeyID: r.kid, Key: r.pub})
	}
	return out
}

func (km *KeyManager) PublicKeyByID(kid string) *rsa.PublicKey {
	km.mu.Lock()
	defer km.mu.Unlock()
	km.pruneExpiredLocked(time.Now().UTC())
	if kid == "" || kid == km.keyID {
		return &km.rsaKey.PublicKey
	}
	for _, r := range km.retiring {
		if r.kid == kid {
			return r.pub
		}
	}
	return nil
}

func (km *KeyManager) statusLocked(now time.Time) SigningKeyStatus {
	km.pruneExpiredLocked(now)
	retiring := make([]RetiringKeyMeta, 0, len(km.retiring))
	for _, r := range km.retiring {
		retiring = append(retiring, RetiringKeyMeta{
			KeyID:     r.kid,
			ExpiresAt: r.expiresAt.UTC().Format(time.RFC3339),
		})
	}
	return SigningKeyStatus{
		ActiveKid:    km.keyID,
		RotatedAt:    km.rotatedAt.UTC().Format(time.RFC3339),
		JwksKeyCount: 1 + len(retiring),
		RetiringKeys: retiring,
	}
}

func (km *KeyManager) Status() SigningKeyStatus {
	km.mu.Lock()
	defer km.mu.Unlock()
	return km.statusLocked(time.Now().UTC())
}

// RotateRSA generates and atomically persists a brand-new RSA-2048 signing keypair.
// In graceful mode (emergency=false), the previous public key remains in JWKS for `grace`.
// In emergency mode (emergency=true), all previous keys are purged immediately.
func (km *KeyManager) RotateRSA(emergency bool, grace time.Duration) (string, SigningKeyStatus, error) {
	newKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return "", SigningKeyStatus{}, err
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(newKey),
	})

	km.mu.Lock()
	defer km.mu.Unlock()

	tmpPath := km.rsaPath + ".tmp"
	if err := os.WriteFile(tmpPath, pemBytes, 0o600); err != nil {
		return "", SigningKeyStatus{}, err
	}
	if err := os.Rename(tmpPath, km.rsaPath); err != nil {
		return "", SigningKeyStatus{}, err
	}

	now := time.Now().UTC()
	prevKid := km.keyID
	prevPub := km.rsaKey.PublicKey

	if emergency {
		km.retiring = nil
	} else {
		if grace < time.Minute {
			grace = 2 * time.Hour
		}
		km.pruneExpiredLocked(now)
		km.retiring = append([]retiringPublicKey{{
			kid:       prevKid,
			pub:       &prevPub,
			expiresAt: now.Add(grace),
		}}, km.retiring...)
		if len(km.retiring) > 5 {
			km.retiring = km.retiring[:5]
		}
	}

	km.rsaKey = newKey
	km.keyID = computeRSAKeyID(&newKey.PublicKey)
	km.rotatedAt = now

	return prevKid, km.statusLocked(now), nil
}

func (km *KeyManager) PurgeRetiring() (int, SigningKeyStatus) {
	km.mu.Lock()
	defer km.mu.Unlock()
	count := len(km.retiring)
	km.retiring = nil
	return count, km.statusLocked(time.Now().UTC())
}

func (km *KeyManager) EncryptSecret(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	block, err := aes.NewCipher(km.masterKey[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return "enc:v1:" + base64.StdEncoding.EncodeToString(ciphertext), nil
}

func (km *KeyManager) DecryptSecret(encoded string) (string, error) {
	if encoded == "" {
		return "", nil
	}
	const prefix = "enc:v1:"
	if len(encoded) <= len(prefix) || encoded[:len(prefix)] != prefix {
		return "", errors.New("invalid encrypted secret envelope")
	}
	raw, err := base64.StdEncoding.DecodeString(encoded[len(prefix):])
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(km.masterKey[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("ciphertext too short")
	}
	nonce, payload := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, payload, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func loadOrGenerateRSAKey(path string) (*rsa.PrivateKey, error) {
	if raw, err := os.ReadFile(path); err == nil {
		block, _ := pem.Decode(raw)
		if block != nil {
			if key, parseErr := x509.ParsePKCS1PrivateKey(block.Bytes); parseErr == nil {
				return key, nil
			}
		}
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
	if err := os.WriteFile(path, pemBytes, 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

// ResolveTLSCertificate checks read-only /certs first (never writes to /certs).
// If empty or missing, generates and persists a self-signed cert inside writable /data/certs.
func ResolveTLSCertificate(roCertsDir, writableCertsDir string) (tls.Certificate, string, error) {
	candidates := [][2]string{
		{"tls.crt", "tls.key"},
		{"server.crt", "server.key"},
		{"fullchain.pem", "privkey.pem"},
	}

	for _, pair := range candidates {
		certPath := filepath.Join(roCertsDir, pair[0])
		keyPath := filepath.Join(roCertsDir, pair[1])
		if fileExists(certPath) && fileExists(keyPath) {
			cert, err := tls.LoadX509KeyPair(certPath, keyPath)
			if err != nil {
				return tls.Certificate{}, "", fmt.Errorf("invalid cert pair in %s: %w", roCertsDir, err)
			}
			return cert, fmt.Sprintf("read-only mount (%s)", certPath), nil
		}
	}

	// Fallback: never touch /certs; persist self-signed cert in /data/certs
	if err := os.MkdirAll(writableCertsDir, 0o700); err != nil {
		return tls.Certificate{}, "", err
	}
	autoCert := filepath.Join(writableCertsDir, "selfsigned.crt")
	autoKey := filepath.Join(writableCertsDir, "selfsigned.key")

	if fileExists(autoCert) && fileExists(autoKey) {
		if cert, err := tls.LoadX509KeyPair(autoCert, autoKey); err == nil {
			return cert, fmt.Sprintf("persisted self-signed (%s)", autoCert), nil
		}
	}

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	tmpl := x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "wimotek-oauth-local"},
		NotBefore:    time.Now().Add(-5 * time.Minute),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost", "wimotek-oauth"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}
	derBytes, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	keyBytes, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: derBytes})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes})

	if err := os.WriteFile(autoCert, certPEM, 0o644); err != nil {
		return tls.Certificate{}, "", err
	}
	if err := os.WriteFile(autoKey, keyPEM, 0o600); err != nil {
		return tls.Certificate{}, "", err
	}

	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	return cert, fmt.Sprintf("auto-generated self-signed (%s)", autoCert), err
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}
