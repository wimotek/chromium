package client

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/wimotek/cli/internal/certutil"
)

// Client communicates with a wimotek/ca (or OpenBao/Vault PKI compatible) server.
type Client struct {
	BaseURL    string
	Token      string
	HTTPClient *http.Client
}

// New constructs a CA HTTP client trusting rootPEM (if supplied) or optional insecureSkipVerify.
func New(baseURL, token string, rootPEM []byte, insecureSkipVerify bool) *Client {
	tlsCfg := &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: insecureSkipVerify, //nolint:gosec // explicit opt-in for bootstrap/dev self-signed CAs
	}
	if len(rootPEM) > 0 {
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		pool.AppendCertsFromPEM(rootPEM)
		tlsCfg.RootCAs = pool
	}
	return &Client{
		BaseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		Token:   strings.TrimSpace(token),
		HTTPClient: &http.Client{
			Timeout: 20 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: tlsCfg,
			},
		},
	}
}

// FetchRoot downloads /ca/root.crt and validates SHA-256 fingerprint in constant time when expectedFingerprint is non-empty.
func FetchRoot(ctx context.Context, caURL, expectedFingerprint string, insecureSkipTLS bool) ([]byte, string, error) {
	c := New(caURL, "", nil, insecureSkipTLS)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/ca/root.crt", nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("download root CA: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, "", fmt.Errorf("GET /ca/root.crt returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	rootPEM, err := io.ReadAll(io.LimitReader(resp.Body, 128*1024))
	if err != nil {
		return nil, "", err
	}
	certs, err := certutil.ParseCertChainPEM(rootPEM)
	if err != nil {
		return nil, "", fmt.Errorf("invalid root CA PEM from server: %w", err)
	}
	actualHex, _ := certutil.FingerprintSHA256(certs[0])
	cleanExp := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(expectedFingerprint), ":", ""))
	if cleanExp != "" {
		if subtle.ConstantTimeCompare([]byte(actualHex), []byte(cleanExp)) != 1 {
			return nil, "", fmt.Errorf("root CA SHA-256 fingerprint mismatch! expected %s, got %s", cleanExp, actualHex)
		}
	}
	return rootPEM, actualHex, nil
}

// Health calls GET /api/health.
func (c *Client) Health(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.doJSON(ctx, http.MethodGet, "/api/health", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// LoginWithPoW solves wimotek/ca's offline HMAC SHA-256 Proof-of-Work challenge and exchanges username+password for a Bearer token.
func (c *Client) LoginWithPoW(ctx context.Context, username, password string) (string, error) {
	var ch struct {
		Challenge  string `json:"challenge"`
		Difficulty int    `json:"difficulty"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/auth/challenge", nil, &ch); err != nil {
		return "", fmt.Errorf("fetch PoW challenge: %w", err)
	}
	sol := SolvePoW(ch.Challenge, ch.Difficulty)
	var resp struct {
		Token string `json:"token"`
	}
	if err := c.doJSON(ctx, http.MethodPost, "/api/auth/login", map[string]string{
		"username":  username,
		"password":  password,
		"challenge": ch.Challenge,
		"solution":  sol,
	}, &resp); err != nil {
		return "", err
	}
	if resp.Token == "" {
		return "", errors.New("server returned empty session token")
	}
	c.Token = resp.Token
	return resp.Token, nil
}

// SolvePoW finds a nonce such that SHA-256(challenge + ":" + solution) has at least difficulty leading zero bits.
func SolvePoW(challenge string, difficulty int) string {
	if difficulty < 1 || difficulty > 24 {
		difficulty = 16
	}
	for i := 0; ; i++ {
		cand := strconv.Itoa(i)
		sum := sha256.Sum256([]byte(challenge + ":" + cand))
		if hasLeadingZeroBits(sum[:], difficulty) {
			return cand
		}
	}
}

func hasLeadingZeroBits(hash []byte, bits int) bool {
	full := bits / 8
	rem := bits % 8
	for i := 0; i < full; i++ {
		if hash[i] != 0 {
			return false
		}
	}
	if rem > 0 {
		mask := byte(0xFF << (8 - rem))
		if hash[full]&mask != 0 {
			return false
		}
	}
	return true
}

// SignRequest specifies parameters to sign a CSR via wimotek/ca.
type SignRequest struct {
	Profile      string   `json:"profile"`
	CommonName   string   `json:"common_name"`
	SANs         []string `json:"sans,omitempty"`
	UPN          string   `json:"upn,omitempty"`
	Email        string   `json:"email,omitempty"`
	CSRPEM       string   `json:"csr_pem"`
	ValidityDays int      `json:"validity_days,omitempty"`
}

// SignResponse holds the issued certificate chain and serial metadata.
type SignResponse struct {
	SerialHex  string `json:"serial_hex"`
	CertPEM    string `json:"cert_pem"`
	ChainPEM   string `json:"chain_pem"`
	NotBefore  int64  `json:"not_before"`
	NotAfter   int64  `json:"not_after"`
}

// SignCSR submits a locally generated CSR to wimotek/ca (supports both Provisioner tokens via /v1/pki/issue/{role} and User Bearer tokens via /api/certificates).
func (c *Client) SignCSR(ctx context.Context, req SignRequest) (*SignResponse, error) {
	if strings.TrimSpace(req.Profile) == "" {
		req.Profile = "tls_server"
	}
	// Provisioner tokens start with "wca_" -> use OpenBao/Vault PKI compatible endpoint directly.
	if strings.HasPrefix(c.Token, "wca_") {
		return c.signViaVaultRoute(ctx, req)
	}
	// User Bearer token -> use /api/certificates (respects user quotas & profile defaults).
	var apiResp struct {
		Certificate struct {
			SerialHex string `json:"serial_hex"`
			CertPEM   string `json:"cert_pem"`
			NotBefore int64  `json:"not_before"`
			NotAfter  int64  `json:"not_after"`
		} `json:"certificate"`
		ChainPEM string `json:"chain_pem"`
	}
	err := c.doJSON(ctx, http.MethodPost, "/api/certificates", map[string]any{
		"profile":       req.Profile,
		"common_name":   req.CommonName,
		"sans":          req.SANs,
		"upn":           req.UPN,
		"email":         req.Email,
		"csr_pem":       req.CSRPEM,
		"validity_days": req.ValidityDays,
	}, &apiResp)
	if err == nil && apiResp.Certificate.CertPEM != "" {
		chain := apiResp.ChainPEM
		if chain == "" {
			chain = apiResp.Certificate.CertPEM
		}
		return &SignResponse{
			SerialHex: apiResp.Certificate.SerialHex,
			CertPEM:   apiResp.Certificate.CertPEM,
			ChainPEM:  chain,
			NotBefore: apiResp.Certificate.NotBefore,
			NotAfter:  apiResp.Certificate.NotAfter,
		}, nil
	}
	// Fallback to /v1/pki/issue/{profile} if caller passed an arbitrary provisioner token
	return c.signViaVaultRoute(ctx, req)
}

func (c *Client) signViaVaultRoute(ctx context.Context, req SignRequest) (*SignResponse, error) {
	var vaultResp struct {
		Data struct {
			SerialNumber string   `json:"serial_number"`
			Certificate  string   `json:"certificate"`
			IssuingCA    string   `json:"issuing_ca"`
			CAChain      []string `json:"ca_chain"`
			Expiration   int64    `json:"expiration"`
		} `json:"data"`
	}
	err := c.doJSON(ctx, http.MethodPost, "/v1/pki/issue/"+req.Profile, map[string]any{
		"common_name": req.CommonName,
		"alt_names":   strings.Join(req.SANs, ","),
		"upn":         req.UPN,
		"email":       req.Email,
		"csr":         req.CSRPEM,
		"ttl_days":    req.ValidityDays,
	}, &vaultResp)
	if err != nil {
		return nil, err
	}
	chainParts := []string{strings.TrimSpace(vaultResp.Data.Certificate)}
	for _, caPem := range vaultResp.Data.CAChain {
		if strings.TrimSpace(caPem) != "" {
			chainParts = append(chainParts, strings.TrimSpace(caPem))
		}
	}
	chainPEM := strings.Join(chainParts, "\n") + "\n"
	var nb, na int64
	if certs, parseErr := certutil.ParseCertChainPEM([]byte(vaultResp.Data.Certificate)); parseErr == nil && len(certs) > 0 {
		nb = certs[0].NotBefore.Unix()
		na = certs[0].NotAfter.Unix()
	} else {
		na = vaultResp.Data.Expiration
	}
	return &SignResponse{
		SerialHex: vaultResp.Data.SerialNumber,
		CertPEM:   vaultResp.Data.Certificate,
		ChainPEM:  chainPEM,
		NotBefore: nb,
		NotAfter:  na,
	}, nil
}

// Revoke revokes a certificate by serial hex on the CA server.
func (c *Client) Revoke(ctx context.Context, serialHex string, reason int) error {
	clean := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(serialHex), ":", ""))
	if clean == "" {
		return errors.New("serial number is required")
	}
	if strings.HasPrefix(c.Token, "wca_") {
		return c.doJSON(ctx, http.MethodPost, "/v1/pki/revoke", map[string]any{
			"serial_number": clean,
			"reason":        reason,
		}, nil)
	}
	return c.doJSON(ctx, http.MethodPost, "/api/certificates/"+clean+"/revoke", map[string]any{
		"reason": reason,
	}, nil)
}

// FetchCRL downloads the Issuing CA CRL in DER or PEM format.
func (c *Client) FetchCRL(ctx context.Context, pemFormat bool) ([]byte, error) {
	path := "/ca/crl.der"
	if pemFormat {
		path = "/ca/crl.pem"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("GET %s returned HTTP %d: %s", path, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
}

// ListCertificates fetches remote certificates visible to the authenticated token.
func (c *Client) ListCertificates(ctx context.Context) ([]map[string]any, error) {
	var resp struct {
		Certificates []map[string]any `json:"certificates"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/certificates", nil, &resp); err != nil {
		return nil, err
	}
	return resp.Certificates, nil
}

func (c *Client) doJSON(ctx context.Context, method, route string, body any, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+route, rdr)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
		req.Header.Set("X-Vault-Token", c.Token)
	}
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		var errObj struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(raw, &errObj) == nil && errObj.Error != "" {
			return fmt.Errorf("%s %s: %s (HTTP %d)", method, route, errObj.Error, resp.StatusCode)
		}
		return fmt.Errorf("%s %s: HTTP %d: %s", method, route, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out != nil && len(raw) > 0 {
		return json.Unmarshal(raw, out)
	}
	return nil
}
