package api

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"hash"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wimotek/ca/internal/auth"
	"github.com/wimotek/ca/internal/ca"
	"github.com/wimotek/ca/internal/store"
)

// ACMEPolicy configures commercial public-facing ACME server behavior (ZeroSSL-aligned).
type ACMEPolicy struct {
	RequireEAB             bool   `json:"require_eab"`
	DefaultTTLDays         int    `json:"default_ttl_days"`
	RateLimitOrdersPerHour int    `json:"rate_limit_orders_per_hour"`
	RateLimitReqPerMin     int    `json:"rate_limit_req_per_min"`
	AllowWildcard          bool   `json:"allow_wildcard"`
	TermsURL               string `json:"terms_url"`
}

func defaultACMEPolicy() ACMEPolicy {
	return ACMEPolicy{
		RequireEAB:             true,
		DefaultTTLDays:         90,
		RateLimitOrdersPerHour: 50,
		RateLimitReqPerMin:     300,
		AllowWildcard:          true,
		TermsURL:               "",
	}
}

type acmeIdentifier struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

type acmeProblem struct {
	Type   string `json:"type"`
	Detail string `json:"detail"`
	Status int    `json:"status,omitempty"`
}

type acmeChallenge struct {
	ID        string       `json:"id,omitempty"`
	Type      string       `json:"type"`
	URL       string       `json:"url"`
	Status    string       `json:"status"`
	Token     string       `json:"token"`
	Validated string       `json:"validated,omitempty"`
	Error     *acmeProblem `json:"error,omitempty"`
}

type acmeJWS struct {
	Protected string `json:"protected"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

type acmeProtectedHeader struct {
	Alg   string          `json:"alg"`
	Nonce string          `json:"nonce"`
	URL   string          `json:"url"`
	JWK   json.RawMessage `json:"jwk"`
	KID   string          `json:"kid"`
}

type acmeJWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv,omitempty"`
	X   string `json:"x,omitempty"`
	Y   string `json:"y,omitempty"`
	N   string `json:"n,omitempty"`
	E   string `json:"e,omitempty"`
}

var acmeDomainLabelRe = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func (s *Server) registerACMERoutes() {
	// RFC 8555 ACME v2 Public Protocol Endpoints
	s.mux.HandleFunc("GET /acme/directory", s.handleACMEDirectory)
	s.mux.HandleFunc("HEAD /acme/new-nonce", s.handleACMENonce)
	s.mux.HandleFunc("GET /acme/new-nonce", s.handleACMENonce)
	s.mux.HandleFunc("POST /acme/new-account", s.handleACMENewAccount)
	s.mux.HandleFunc("POST /acme/acct/{id}", s.handleACMEAccount)
	s.mux.HandleFunc("POST /acme/acct/{id}/orders", s.handleACMEAccountOrders)
	s.mux.HandleFunc("POST /acme/new-order", s.handleACMENewOrder)
	s.mux.HandleFunc("POST /acme/order/{id}", s.handleACMEOrder)
	s.mux.HandleFunc("POST /acme/order/{id}/finalize", s.handleACMEFinalizeOrder)
	s.mux.HandleFunc("POST /acme/authz/{id}", s.handleACMEAuthz)
	s.mux.HandleFunc("POST /acme/chall/{id}", s.handleACMEChallenge)
	s.mux.HandleFunc("POST /acme/cert/{serial}", s.handleACMECert)
	s.mux.HandleFunc("POST /acme/revoke-cert", s.handleACMERevokeCert)
	s.mux.HandleFunc("POST /acme/key-change", s.handleACMEKeyChange)

	// Console ACME & EAB Management APIs
	s.mux.HandleFunc("GET /api/acme/eab", s.requireSession(s.handleListACMEEAB))
	s.mux.HandleFunc("POST /api/acme/eab", s.requireSession(s.handleCreateACMEEAB))
	s.mux.HandleFunc("DELETE /api/acme/eab/{kid}", s.requireSession(s.handleDeleteACMEEAB))
	s.mux.HandleFunc("GET /api/acme/policy", s.requireSession(s.handleGetACMEPolicy))
	s.mux.HandleFunc("PUT /api/acme/policy", s.requireAdmin(s.handleUpdateACMEPolicy))
}

func (s *Server) loadACMEPolicy(ctx context.Context) ACMEPolicy {
	pol := defaultACMEPolicy()
	raw, err := s.store.GetSetting(ctx, "acme_policy")
	if err == nil && strings.TrimSpace(raw) != "" {
		_ = json.Unmarshal([]byte(raw), &pol)
	}
	if pol.DefaultTTLDays < 1 || pol.DefaultTTLDays > 365 {
		pol.DefaultTTLDays = 90
	}
	if pol.RateLimitOrdersPerHour < 1 || pol.RateLimitOrdersPerHour > 10000 {
		pol.RateLimitOrdersPerHour = 50
	}
	if pol.RateLimitReqPerMin < 10 || pol.RateLimitReqPerMin > 10000 {
		pol.RateLimitReqPerMin = 300
	}
	return pol
}

func (s *Server) acmeBaseURL(r *http.Request) string {
	if s.base != "" {
		return strings.TrimRight(s.base, "/")
	}
	scheme := "https"
	if r.TLS == nil && strings.ToLower(r.Header.Get("X-Forwarded-Proto")) != "https" {
		scheme = "http"
	}
	return scheme + "://" + r.Host
}

func (s *Server) issueACMENonce(ctx context.Context) string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	nonce := base64.RawURLEncoding.EncodeToString(b)
	_ = s.cache.Set(ctx, "acme:nonce:"+nonce, []byte("1"), 30*time.Minute)
	return nonce
}

func (s *Server) consumeACMENonce(ctx context.Context, nonce string) bool {
	if len(nonce) < 16 || len(nonce) > 128 {
		return false
	}
	key := "acme:nonce:" + nonce
	_, ok, err := s.cache.Get(ctx, key)
	if err != nil || !ok {
		return false
	}
	_ = s.cache.Del(ctx, key)
	return true
}

func (s *Server) checkACMEIPRateLimit(ctx context.Context, r *http.Request, pol ACMEPolicy) bool {
	ip := clientIP(r)
	cnt, err := s.cache.IncrWindow(ctx, "acme:rl:ip:"+ip, time.Minute)
	if err != nil {
		return true
	}
	return cnt <= int64(pol.RateLimitReqPerMin)
}

func (s *Server) setACMECommonHeaders(w http.ResponseWriter, r *http.Request) {
	base := s.acmeBaseURL(r)
	w.Header().Set("Replay-Nonce", s.issueACMENonce(r.Context()))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Link", fmt.Sprintf("<%s/acme/directory>;rel=\"index\"", base))
}

func (s *Server) writeACMEJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	s.setACMECommonHeaders(w, r)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) writeACMEError(w http.ResponseWriter, r *http.Request, status int, errType, detail string) {
	s.setACMECommonHeaders(w, r)
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(acmeProblem{
		Type:   "urn:ietf:params:acme:error:" + errType,
		Detail: detail,
		Status: status,
	})
}

func (s *Server) handleACMEDirectory(w http.ResponseWriter, r *http.Request) {
	base := s.acmeBaseURL(r)
	pol := s.loadACMEPolicy(r.Context())
	caaHost := ""
	if u, err := url.Parse(base); err == nil && u.Hostname() != "" {
		caaHost = u.Hostname()
	}
	meta := map[string]any{
		"website":                 base,
		"externalAccountRequired": pol.RequireEAB,
	}
	if pol.TermsURL != "" {
		meta["termsOfService"] = pol.TermsURL
	}
	if caaHost != "" {
		meta["caaIdentities"] = []string{caaHost}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{
		"newNonce":   base + "/acme/new-nonce",
		"newAccount": base + "/acme/new-account",
		"newOrder":   base + "/acme/new-order",
		"revokeCert": base + "/acme/revoke-cert",
		"keyChange":  base + "/acme/key-change",
		"meta":       meta,
	})
}

func (s *Server) handleACMENonce(w http.ResponseWriter, r *http.Request) {
	s.setACMECommonHeaders(w, r)
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// =========================================================================
// RFC 8555 JWS, RFC 7638 Thumbprint & EAB Verification Helpers
// =========================================================================

func canonicalJWKThumbprint(rawJWK json.RawMessage) (string, string, crypto.PublicKey, error) {
	var jwk acmeJWK
	if err := json.Unmarshal(rawJWK, &jwk); err != nil {
		return "", "", nil, errors.New("invalid JWK JSON")
	}
	var canonical []byte
	var pub crypto.PublicKey

	switch jwk.Kty {
	case "EC":
		var curve elliptic.Curve
		switch jwk.Crv {
		case "P-256":
			curve = elliptic.P256()
		case "P-384":
			curve = elliptic.P384()
		case "P-521":
			curve = elliptic.P521()
		default:
			return "", "", nil, fmt.Errorf("unsupported EC curve %q", jwk.Crv)
		}
		xb, err := base64.RawURLEncoding.DecodeString(jwk.X)
		if err != nil {
			return "", "", nil, errors.New("invalid EC x coordinate")
		}
		yb, err := base64.RawURLEncoding.DecodeString(jwk.Y)
		if err != nil {
			return "", "", nil, errors.New("invalid EC y coordinate")
		}
		x := new(big.Int).SetBytes(xb)
		y := new(big.Int).SetBytes(yb)
		if !curve.IsOnCurve(x, y) {
			return "", "", nil, errors.New("EC point not on curve")
		}
		pub = &ecdsa.PublicKey{Curve: curve, X: x, Y: y}
		// RFC 7638 lexicographical order: crv, kty, x, y
		canonical, _ = json.Marshal(struct {
			Crv string `json:"crv"`
			Kty string `json:"kty"`
			X   string `json:"x"`
			Y   string `json:"y"`
		}{Crv: jwk.Crv, Kty: "EC", X: jwk.X, Y: jwk.Y})

	case "RSA":
		nb, err := base64.RawURLEncoding.DecodeString(jwk.N)
		if err != nil || len(nb) < 256 {
			return "", "", nil, errors.New("invalid or weak RSA modulus (minimum 2048-bit)")
		}
		eb, err := base64.RawURLEncoding.DecodeString(jwk.E)
		if err != nil || len(eb) == 0 || len(eb) > 8 {
			return "", "", nil, errors.New("invalid RSA exponent")
		}
		eInt := new(big.Int).SetBytes(eb)
		if !eInt.IsInt64() || eInt.Int64() < 3 {
			return "", "", nil, errors.New("invalid RSA exponent value")
		}
		pub = &rsa.PublicKey{N: new(big.Int).SetBytes(nb), E: int(eInt.Int64())}
		// RFC 7638 lexicographical order: e, kty, n
		canonical, _ = json.Marshal(struct {
			E   string `json:"e"`
			Kty string `json:"kty"`
			N   string `json:"n"`
		}{E: jwk.E, Kty: "RSA", N: jwk.N})

	case "OKP":
		if jwk.Crv != "Ed25519" {
			return "", "", nil, fmt.Errorf("unsupported OKP curve %q", jwk.Crv)
		}
		xb, err := base64.RawURLEncoding.DecodeString(jwk.X)
		if err != nil || len(xb) != ed25519.PublicKeySize {
			return "", "", nil, errors.New("invalid Ed25519 public key")
		}
		pub = ed25519.PublicKey(xb)
		// RFC 7638 lexicographical order: crv, kty, x
		canonical, _ = json.Marshal(struct {
			Crv string `json:"crv"`
			Kty string `json:"kty"`
			X   string `json:"x"`
		}{Crv: "Ed25519", Kty: "OKP", X: jwk.X})

	default:
		return "", "", nil, fmt.Errorf("unsupported JWK kty %q", jwk.Kty)
	}

	sum := sha256.Sum256(canonical)
	return base64.RawURLEncoding.EncodeToString(sum[:]), string(canonical), pub, nil
}

func verifyJWSSignature(alg string, pub crypto.PublicKey, signingInput []byte, sigB64 string) error {
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return errors.New("malformed base64url signature")
	}

	switch alg {
	case "ES256", "ES384", "ES512":
		ecPub, ok := pub.(*ecdsa.PublicKey)
		if !ok {
			return errors.New("algorithm/key mismatch for ECDSA")
		}
		var h hash.Hash
		var keyBytes int
		switch alg {
		case "ES256":
			if ecPub.Curve != elliptic.P256() {
				return errors.New("ES256 requires P-256 key")
			}
			h = sha256.New()
			keyBytes = 32
		case "ES384":
			if ecPub.Curve != elliptic.P384() {
				return errors.New("ES384 requires P-384 key")
			}
			h = sha512.New384()
			keyBytes = 48
		case "ES512":
			if ecPub.Curve != elliptic.P521() {
				return errors.New("ES512 requires P-521 key")
			}
			h = sha512.New()
			keyBytes = 66
		}
		if len(sig) != 2*keyBytes {
			return errors.New("invalid ECDSA raw signature length")
		}
		rInt := new(big.Int).SetBytes(sig[:keyBytes])
		sInt := new(big.Int).SetBytes(sig[keyBytes:])
		h.Write(signingInput)
		if !ecdsa.Verify(ecPub, h.Sum(nil), rInt, sInt) {
			return errors.New("ECDSA signature verification failed")
		}
		return nil

	case "RS256", "RS384", "RS512":
		rsaPub, ok := pub.(*rsa.PublicKey)
		if !ok {
			return errors.New("algorithm/key mismatch for RSA")
		}
		var h crypto.Hash
		switch alg {
		case "RS256":
			h = crypto.SHA256
		case "RS384":
			h = crypto.SHA384
		case "RS512":
			h = crypto.SHA512
		}
		hasher := h.New()
		hasher.Write(signingInput)
		if err := rsa.VerifyPKCS1v15(rsaPub, h, hasher.Sum(nil), sig); err != nil {
			return errors.New("RSA signature verification failed")
		}
		return nil

	case "EdDSA":
		edPub, ok := pub.(ed25519.PublicKey)
		if !ok {
			return errors.New("algorithm/key mismatch for EdDSA")
		}
		if !ed25519.Verify(edPub, signingInput, sig) {
			return errors.New("Ed25519 signature verification failed")
		}
		return nil

	default:
		return fmt.Errorf("unsupported JWS algorithm %q", alg)
	}
}

type verifiedACMEReq struct {
	Header     acmeProtectedHeader
	Payload    []byte
	Account    *store.ACMEAccountRecord
	JWKThumb   string
	JWKCanon   string
	PubKey     crypto.PublicKey
}

func (s *Server) verifyACMERequest(r *http.Request, expectedPath string, allowJWK bool, allowKID bool) (*verifiedACMEReq, int, string, string) {
	pol := s.loadACMEPolicy(r.Context())
	if !s.checkACMEIPRateLimit(r.Context(), r, pol) {
		return nil, http.StatusTooManyRequests, "rateLimited", "per-IP ACME request rate limit exceeded"
	}

	var env acmeJWS
	if err := json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&env); err != nil {
		return nil, http.StatusBadRequest, "malformed", "invalid JWS JSON body"
	}
	protBytes, err := base64.RawURLEncoding.DecodeString(env.Protected)
	if err != nil {
		return nil, http.StatusBadRequest, "malformed", "invalid base64url protected header"
	}
	var hdr acmeProtectedHeader
	if err := json.Unmarshal(protBytes, &hdr); err != nil {
		return nil, http.StatusBadRequest, "malformed", "invalid protected header JSON"
	}

	// Single-use Replay-Nonce check
	if !s.consumeACMENonce(r.Context(), hdr.Nonce) {
		return nil, http.StatusBadRequest, "badNonce", "invalid or expired Replay-Nonce"
	}

	// Verify URL matches requested endpoint path (prevents cross-endpoint replay)
	parsedURL, err := url.Parse(hdr.URL)
	if err != nil || parsedURL.Path != expectedPath {
		return nil, http.StatusUnauthorized, "unauthorized", "JWS protected url does not match request endpoint"
	}

	hasJWK := len(hdr.JWK) > 0 && string(hdr.JWK) != "null"
	hasKID := strings.TrimSpace(hdr.KID) != ""
	if hasJWK && hasKID {
		return nil, http.StatusBadRequest, "malformed", "JWS header must not include both jwk and kid"
	}
	if !hasJWK && !hasKID {
		return nil, http.StatusBadRequest, "malformed", "JWS header requires jwk or kid"
	}

	var payloadBytes []byte
	if env.Payload != "" {
		payloadBytes, err = base64.RawURLEncoding.DecodeString(env.Payload)
		if err != nil {
			return nil, http.StatusBadRequest, "malformed", "invalid base64url payload"
		}
	}

	signingInput := []byte(env.Protected + "." + env.Payload)

	if hasJWK {
		if !allowJWK {
			return nil, http.StatusBadRequest, "malformed", "this endpoint requires kid authentication"
		}
		thumb, canon, pub, err := canonicalJWKThumbprint(hdr.JWK)
		if err != nil {
			return nil, http.StatusBadRequest, "badPublicKey", err.Error()
		}
		if err := verifyJWSSignature(hdr.Alg, pub, signingInput, env.Signature); err != nil {
			return nil, http.StatusForbidden, "unauthorized", err.Error()
		}
		return &verifiedACMEReq{
			Header:   hdr,
			Payload:  payloadBytes,
			JWKThumb: thumb,
			JWKCanon: canon,
			PubKey:   pub,
		}, 0, "", ""
	}

	// KID authentication
	if !allowKID {
		return nil, http.StatusBadRequest, "malformed", "this endpoint requires jwk authentication"
	}
	kidURL, err := url.Parse(hdr.KID)
	if err != nil || !strings.HasPrefix(kidURL.Path, "/acme/acct/") {
		return nil, http.StatusBadRequest, "accountDoesNotExist", "invalid kid account URL"
	}
	acctID := strings.TrimPrefix(kidURL.Path, "/acme/acct/")
	acct, err := s.store.GetACMEAccountByID(r.Context(), acctID)
	if err != nil || acct == nil {
		return nil, http.StatusBadRequest, "accountDoesNotExist", "ACME account not found"
	}
	if acct.Status != "valid" {
		return nil, http.StatusForbidden, "unauthorized", "ACME account is not valid"
	}
	thumb, canon, pub, err := canonicalJWKThumbprint(json.RawMessage(acct.JWKJSON))
	if err != nil {
		return nil, http.StatusInternalServerError, "serverInternal", "corrupt account JWK"
	}
	if err := verifyJWSSignature(hdr.Alg, pub, signingInput, env.Signature); err != nil {
		return nil, http.StatusForbidden, "unauthorized", err.Error()
	}

	return &verifiedACMEReq{
		Header:   hdr,
		Payload:  payloadBytes,
		Account:  acct,
		JWKThumb: thumb,
		JWKCanon: canon,
		PubKey:   pub,
	}, 0, "", ""
}

func (s *Server) verifyEABBinding(ctx context.Context, eab *acmeJWS, expectedURLPath, accountJWKThumbprint string) (*store.ACMEEABRecord, error) {
	if eab == nil || eab.Protected == "" || eab.Payload == "" || eab.Signature == "" {
		return nil, errors.New("externalAccountBinding is required")
	}
	protBytes, err := base64.RawURLEncoding.DecodeString(eab.Protected)
	if err != nil {
		return nil, errors.New("malformed EAB protected header")
	}
	var hdr struct {
		Alg string `json:"alg"`
		KID string `json:"kid"`
		URL string `json:"url"`
	}
	if err := json.Unmarshal(protBytes, &hdr); err != nil {
		return nil, errors.New("invalid EAB protected JSON")
	}
	if hdr.Alg != "HS256" && hdr.Alg != "HS384" && hdr.Alg != "HS512" {
		return nil, fmt.Errorf("unsupported EAB alg %q (expected HS256)", hdr.Alg)
	}
	if strings.TrimSpace(hdr.KID) == "" {
		return nil, errors.New("EAB kid is required")
	}
	parsedURL, err := url.Parse(hdr.URL)
	if err != nil || parsedURL.Path != expectedURLPath {
		return nil, errors.New("EAB protected url does not match newAccount endpoint")
	}

	eabRec, err := s.store.GetACMEEAB(ctx, hdr.KID)
	if err != nil || eabRec == nil || !eabRec.Enabled {
		return nil, errors.New("invalid or revoked EAB KID")
	}
	rawKeyBytes, err := s.pki.DecryptSecret(eabRec.HMACKeyEnc)
	if err != nil {
		return nil, errors.New("failed to decrypt EAB HMAC key")
	}
	// Accept either raw bytes decoded from base64url HMAC string (standard RFC 8555)
	hmacSecret, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(string(rawKeyBytes), "="))
	if err != nil {
		hmacSecret = rawKeyBytes
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(eab.Payload)
	if err != nil {
		return nil, errors.New("malformed EAB payload")
	}
	innerThumb, _, _, err := canonicalJWKThumbprint(json.RawMessage(payloadBytes))
	if err != nil || innerThumb != accountJWKThumbprint {
		return nil, errors.New("EAB payload JWK does not match ACME account key")
	}

	sigBytes, err := base64.RawURLEncoding.DecodeString(eab.Signature)
	if err != nil {
		return nil, errors.New("malformed EAB signature")
	}
	var mac hash.Hash
	switch hdr.Alg {
	case "HS256":
		mac = hmac.New(sha256.New, hmacSecret)
	case "HS384":
		mac = hmac.New(sha512.New384, hmacSecret)
	case "HS512":
		mac = hmac.New(sha512.New, hmacSecret)
	}
	mac.Write([]byte(eab.Protected + "." + eab.Payload))
	if !hmac.Equal(mac.Sum(nil), sigBytes) {
		return nil, errors.New("EAB HMAC signature verification failed")
	}
	return eabRec, nil
}

// =========================================================================
// RFC 8555 Handlers
// =========================================================================

func (s *Server) handleACMENewAccount(w http.ResponseWriter, r *http.Request) {
	v, code, errType, detail := s.verifyACMERequest(r, "/acme/new-account", true, false)
	if code != 0 {
		s.writeACMEError(w, r, code, errType, detail)
		return
	}

	var req struct {
		TermsOfServiceAgreed   bool     `json:"termsOfServiceAgreed"`
		OnlyReturnExisting     bool     `json:"onlyReturnExisting"`
		Contact                []string `json:"contact"`
		ExternalAccountBinding *acmeJWS `json:"externalAccountBinding"`
	}
	if len(v.Payload) > 0 {
		if err := json.Unmarshal(v.Payload, &req); err != nil {
			s.writeACMEError(w, r, http.StatusBadRequest, "malformed", "invalid newAccount JSON payload")
			return
		}
	}

	base := s.acmeBaseURL(r)
	existing, err := s.store.GetACMEAccountByThumbprint(r.Context(), v.JWKThumb)
	if err != nil {
		s.writeACMEError(w, r, http.StatusInternalServerError, "serverInternal", err.Error())
		return
	}
	if existing != nil {
		var contacts []string
		_ = json.Unmarshal([]byte(existing.ContactsJSON), &contacts)
		w.Header().Set("Location", base+"/acme/acct/"+existing.ID)
		s.writeACMEJSON(w, r, http.StatusOK, map[string]any{
			"status":  existing.Status,
			"contact": contacts,
			"orders":  base + "/acme/acct/" + existing.ID + "/orders",
		})
		return
	}
	if req.OnlyReturnExisting {
		s.writeACMEError(w, r, http.StatusBadRequest, "accountDoesNotExist", "account does not exist")
		return
	}

	pol := s.loadACMEPolicy(r.Context())
	ownerUsername := "anonymous"
	eabKID := ""
	if pol.RequireEAB || req.ExternalAccountBinding != nil {
		eabRec, err := s.verifyEABBinding(r.Context(), req.ExternalAccountBinding, "/acme/new-account", v.JWKThumb)
		if err != nil {
			s.writeACMEError(w, r, http.StatusForbidden, "externalAccountRequired", err.Error())
			return
		}
		ownerUsername = eabRec.OwnerUsername
		eabKID = eabRec.KID
	}

	if req.Contact == nil {
		req.Contact = []string{}
	}
	contactsJSON, _ := json.Marshal(req.Contact)
	acctID := "acct_" + store.GenerateRandomID(12)
	rec := store.ACMEAccountRecord{
		ID:            acctID,
		OwnerUsername: ownerUsername,
		EABKID:        eabKID,
		JWKThumbprint: v.JWKThumb,
		JWKJSON:       v.JWKCanon,
		ContactsJSON:  string(contactsJSON),
		Status:        "valid",
		CreatedAt:     time.Now().Unix(),
	}
	if err := s.store.InsertACMEAccount(r.Context(), rec); err != nil {
		s.writeACMEError(w, r, http.StatusInternalServerError, "serverInternal", err.Error())
		return
	}
	if eabKID != "" {
		_ = s.store.TouchACMEEABUsage(r.Context(), eabKID)
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:      ownerUsername,
		Action:     "acme.account_register",
		ClientIP:   clientIP(r),
		DetailJSON: fmt.Sprintf(`{"account_id":%q,"eab_kid":%q}`, acctID, eabKID),
		CreatedAt:  time.Now().Unix(),
	})

	w.Header().Set("Location", base+"/acme/acct/"+acctID)
	s.writeACMEJSON(w, r, http.StatusCreated, map[string]any{
		"status":  "valid",
		"contact": req.Contact,
		"orders":  base + "/acme/acct/" + acctID + "/orders",
	})
}

func (s *Server) handleACMEAccount(w http.ResponseWriter, r *http.Request) {
	acctID := strings.TrimSpace(r.PathValue("id"))
	v, code, errType, detail := s.verifyACMERequest(r, "/acme/acct/"+acctID, false, true)
	if code != 0 {
		s.writeACMEError(w, r, code, errType, detail)
		return
	}
	if v.Account.ID != acctID {
		s.writeACMEError(w, r, http.StatusForbidden, "unauthorized", "account mismatch")
		return
	}

	var contacts []string
	_ = json.Unmarshal([]byte(v.Account.ContactsJSON), &contacts)
	status := v.Account.Status

	if len(v.Payload) > 0 {
		var upd struct {
			Contact []string `json:"contact"`
			Status  string   `json:"status"`
		}
		if err := json.Unmarshal(v.Payload, &upd); err != nil {
			s.writeACMEError(w, r, http.StatusBadRequest, "malformed", "invalid account update JSON")
			return
		}
		changed := false
		if upd.Contact != nil {
			contacts = upd.Contact
			changed = true
		}
		if upd.Status == "deactivated" {
			status = "deactivated"
			changed = true
		}
		if changed {
			cj, _ := json.Marshal(contacts)
			_ = s.store.UpdateACMEAccount(r.Context(), acctID, string(cj), status)
		}
	}

	base := s.acmeBaseURL(r)
	s.writeACMEJSON(w, r, http.StatusOK, map[string]any{
		"status":  status,
		"contact": contacts,
		"orders":  base + "/acme/acct/" + acctID + "/orders",
	})
}

func (s *Server) handleACMEAccountOrders(w http.ResponseWriter, r *http.Request) {
	acctID := strings.TrimSpace(r.PathValue("id"))
	v, code, errType, detail := s.verifyACMERequest(r, "/acme/acct/"+acctID+"/orders", false, true)
	if code != 0 {
		s.writeACMEError(w, r, code, errType, detail)
		return
	}
	if v.Account.ID != acctID {
		s.writeACMEError(w, r, http.StatusForbidden, "unauthorized", "account mismatch")
		return
	}
	orders, err := s.store.ListACMEOrders(r.Context(), "", acctID, 100)
	if err != nil {
		s.writeACMEError(w, r, http.StatusInternalServerError, "serverInternal", err.Error())
		return
	}
	base := s.acmeBaseURL(r)
	urls := make([]string, 0, len(orders))
	for _, o := range orders {
		urls = append(urls, base+"/acme/order/"+o.ID)
	}
	s.writeACMEJSON(w, r, http.StatusOK, map[string]any{"orders": urls})
}

func validateACMEDomain(raw string, allowWildcard bool) (string, bool, error) {
	d := strings.ToLower(strings.TrimSpace(strings.TrimSuffix(raw, ".")))
	if d == "" || len(d) > 253 {
		return "", false, errors.New("invalid domain length")
	}
	if net.ParseIP(d) != nil {
		return "", false, errors.New("IP identifiers are not permitted in ACME DNS orders")
	}
	wildcard := false
	base := d
	if strings.HasPrefix(d, "*.") {
		if !allowWildcard {
			return "", false, errors.New("wildcard domains are disabled by CA policy")
		}
		wildcard = true
		base = strings.TrimPrefix(d, "*.")
	}
	if strings.Contains(base, "*") {
		return "", false, errors.New("malformed wildcard identifier")
	}
	labels := strings.Split(base, ".")
	if len(labels) < 2 {
		return "", false, errors.New("domain must contain at least two labels (FQDN)")
	}
	for _, lbl := range labels {
		if !acmeDomainLabelRe.MatchString(lbl) {
			return "", false, fmt.Errorf("invalid DNS label %q", lbl)
		}
	}
	// Block localhost and reserved local TLDs for public deployment hygiene
	tld := labels[len(labels)-1]
	if base == "localhost" || tld == "localhost" || tld == "invalid" {
		return "", false, fmt.Errorf("reserved domain %q cannot be validated via public ACME", d)
	}
	return d, wildcard, nil
}

func (s *Server) handleACMENewOrder(w http.ResponseWriter, r *http.Request) {
	v, code, errType, detail := s.verifyACMERequest(r, "/acme/new-order", false, true)
	if code != 0 {
		s.writeACMEError(w, r, code, errType, detail)
		return
	}

	pol := s.loadACMEPolicy(r.Context())
	// ZeroSSL-style commercial ACME policy: unlimited total certificates, protected by hourly order rate limit
	since := time.Now().Add(-time.Hour).Unix()
	recentCount, err := s.store.CountACMEOrdersSince(r.Context(), v.Account.ID, since)
	if err == nil && recentCount >= pol.RateLimitOrdersPerHour {
		w.Header().Set("Retry-After", "600")
		s.writeACMEError(w, r, http.StatusTooManyRequests, "rateLimited",
			fmt.Sprintf("hourly ACME order rate limit exceeded (%d/%d orders per hour)", recentCount, pol.RateLimitOrdersPerHour))
		return
	}

	var req struct {
		Identifiers []acmeIdentifier `json:"identifiers"`
	}
	if err := json.Unmarshal(v.Payload, &req); err != nil {
		s.writeACMEError(w, r, http.StatusBadRequest, "malformed", "invalid newOrder JSON payload")
		return
	}
	if len(req.Identifiers) == 0 || len(req.Identifiers) > 100 {
		s.writeACMEError(w, r, http.StatusBadRequest, "malformed", "identifiers must contain between 1 and 100 DNS entries")
		return
	}

	now := time.Now().UTC()
	expires := now.Add(24 * time.Hour)
	orderID := "ord_" + store.GenerateRandomID(12)
	base := s.acmeBaseURL(r)

	seen := map[string]bool{}
	cleanIdents := make([]acmeIdentifier, 0, len(req.Identifiers))
	authzs := make([]store.ACMEAuthorizationRecord, 0, len(req.Identifiers))
	authzURLs := make([]string, 0, len(req.Identifiers))

	for _, ident := range req.Identifiers {
		if strings.ToLower(ident.Type) != "dns" {
			s.writeACMEError(w, r, http.StatusBadRequest, "unsupportedIdentifier", fmt.Sprintf("unsupported identifier type %q", ident.Type))
			return
		}
		norm, isWildcard, err := validateACMEDomain(ident.Value, pol.AllowWildcard)
		if err != nil {
			s.writeACMEError(w, r, http.StatusBadRequest, "rejectedIdentifier", err.Error())
			return
		}
		if seen[norm] {
			continue
		}
		seen[norm] = true
		cleanIdents = append(cleanIdents, acmeIdentifier{Type: "dns", Value: norm})

		authzID := "authz_" + store.GenerateRandomID(12)
		challs := make([]acmeChallenge, 0, 2)
		if !isWildcard {
			cID := "ch_" + store.GenerateRandomID(12)
			challs = append(challs, acmeChallenge{
				ID:     cID,
				Type:   "http-01",
				URL:    base + "/acme/chall/" + authzID + "." + cID,
				Status: "pending",
				Token:  base64.RawURLEncoding.EncodeToString([]byte(store.GenerateRandomID(24))),
			})
		}
		dnsCID := "ch_" + store.GenerateRandomID(12)
		challs = append(challs, acmeChallenge{
			ID:     dnsCID,
			Type:   "dns-01",
			URL:    base + "/acme/chall/" + authzID + "." + dnsCID,
			Status: "pending",
			Token:  base64.RawURLEncoding.EncodeToString([]byte(store.GenerateRandomID(24))),
		})
		chJSON, _ := json.Marshal(challs)
		authzs = append(authzs, store.ACMEAuthorizationRecord{
			ID:              authzID,
			OrderID:         orderID,
			AccountID:       v.Account.ID,
			IdentifierType:  "dns",
			IdentifierValue: strings.TrimPrefix(norm, "*."),
			Wildcard:        isWildcard,
			Status:          "pending",
			ExpiresAt:       expires.Unix(),
			ChallengesJSON:  string(chJSON),
			CreatedAt:       now.Unix(),
		})
		authzURLs = append(authzURLs, base+"/acme/authz/"+authzID)
	}

	identsJSON, _ := json.Marshal(cleanIdents)
	orderRec := store.ACMEOrderRecord{
		ID:              orderID,
		AccountID:       v.Account.ID,
		OwnerUsername:   v.Account.OwnerUsername,
		Status:          "pending",
		IdentifiersJSON: string(identsJSON),
		ExpiresAt:       expires.Unix(),
		CreatedAt:       now.Unix(),
	}
	if err := s.store.InsertACMEOrder(r.Context(), orderRec, authzs); err != nil {
		s.writeACMEError(w, r, http.StatusInternalServerError, "serverInternal", err.Error())
		return
	}

	w.Header().Set("Location", base+"/acme/order/"+orderID)
	s.writeACMEJSON(w, r, http.StatusCreated, map[string]any{
		"status":         "pending",
		"expires":        expires.Format(time.RFC3339),
		"identifiers":    cleanIdents,
		"authorizations": authzURLs,
		"finalize":       base + "/acme/order/" + orderID + "/finalize",
	})
}

func (s *Server) formatACMEOrderResponse(base string, order *store.ACMEOrderRecord, authzs []store.ACMEAuthorizationRecord) map[string]any {
	var idents []acmeIdentifier
	_ = json.Unmarshal([]byte(order.IdentifiersJSON), &idents)
	authzURLs := make([]string, 0, len(authzs))
	for _, a := range authzs {
		authzURLs = append(authzURLs, base+"/acme/authz/"+a.ID)
	}
	resp := map[string]any{
		"status":         order.Status,
		"expires":        time.Unix(order.ExpiresAt, 0).UTC().Format(time.RFC3339),
		"identifiers":    idents,
		"authorizations": authzURLs,
		"finalize":       base + "/acme/order/" + order.ID + "/finalize",
	}
	if order.CertSerial != "" {
		resp["certificate"] = base + "/acme/cert/" + order.CertSerial
	}
	if order.ErrorJSON != "" {
		var p acmeProblem
		if json.Unmarshal([]byte(order.ErrorJSON), &p) == nil {
			resp["error"] = p
		}
	}
	return resp
}

func (s *Server) handleACMEOrder(w http.ResponseWriter, r *http.Request) {
	orderID := strings.TrimSpace(r.PathValue("id"))
	v, code, errType, detail := s.verifyACMERequest(r, "/acme/order/"+orderID, false, true)
	if code != 0 {
		s.writeACMEError(w, r, code, errType, detail)
		return
	}
	order, err := s.store.GetACMEOrder(r.Context(), orderID)
	if err != nil || order == nil {
		s.writeACMEError(w, r, http.StatusNotFound, "malformed", "order not found")
		return
	}
	if order.AccountID != v.Account.ID {
		s.writeACMEError(w, r, http.StatusForbidden, "unauthorized", "order belongs to a different ACME account")
		return
	}
	authzs, _ := s.store.ListACMEAuthorizationsByOrder(r.Context(), orderID)
	s.writeACMEJSON(w, r, http.StatusOK, s.formatACMEOrderResponse(s.acmeBaseURL(r), order, authzs))
}

func (s *Server) handleACMEAuthz(w http.ResponseWriter, r *http.Request) {
	authzID := strings.TrimSpace(r.PathValue("id"))
	v, code, errType, detail := s.verifyACMERequest(r, "/acme/authz/"+authzID, false, true)
	if code != 0 {
		s.writeACMEError(w, r, code, errType, detail)
		return
	}
	authz, err := s.store.GetACMEAuthorization(r.Context(), authzID)
	if err != nil || authz == nil {
		s.writeACMEError(w, r, http.StatusNotFound, "malformed", "authorization not found")
		return
	}
	if authz.AccountID != v.Account.ID {
		s.writeACMEError(w, r, http.StatusForbidden, "unauthorized", "authorization belongs to a different account")
		return
	}
	var challs []acmeChallenge
	_ = json.Unmarshal([]byte(authz.ChallengesJSON), &challs)
	resp := map[string]any{
		"identifier": acmeIdentifier{Type: authz.IdentifierType, Value: authz.IdentifierValue},
		"status":     authz.Status,
		"expires":    time.Unix(authz.ExpiresAt, 0).UTC().Format(time.RFC3339),
		"challenges": challs,
	}
	if authz.Wildcard {
		resp["wildcard"] = true
	}
	s.writeACMEJSON(w, r, http.StatusOK, resp)
}

// isPublicRoutableIP strictly blocks loopback, private RFC1918, link-local/metadata, CGNAT, and ULA addresses.
func isPublicRoutableIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	if ip4 := ip.To4(); ip4 != nil {
		// Block 100.64.0.0/10 (CGNAT) and 192.0.0.0/24, 198.18.0.0/15, 0.0.0.0/8
		if ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127 {
			return false
		}
		if ip4[0] == 0 {
			return false
		}
		if ip4[0] == 169 && ip4[1] == 254 {
			return false
		}
	}
	return true
}

func validateHTTP01Public(ctx context.Context, domain, token, expectedKeyAuth string) error {
	resolver := net.DefaultResolver
	ips, err := resolver.LookupIPAddr(ctx, domain)
	if err != nil || len(ips) == 0 {
		return fmt.Errorf("DNS lookup failed for %s: %v", domain, err)
	}
	var safeIP net.IP
	for _, ipa := range ips {
		if isPublicRoutableIP(ipa.IP) {
			safeIP = ipa.IP
			break
		}
	}
	if safeIP == nil {
		return fmt.Errorf("domain %s resolves only to private or loopback addresses; public HTTP-01 validation blocked", domain)
	}

	dialer := &net.Dialer{Timeout: 4 * time.Second}
	client := &http.Client{
		Timeout: 6 * time.Second,
		Transport: &http.Transport{
			DialContext: func(dctx context.Context, network, addr string) (net.Conn, error) {
				host, port, err := net.SplitHostPort(addr)
				if err != nil {
					return nil, err
				}
				if port != "80" && port != "443" {
					return nil, errors.New("HTTP-01 only permits port 80/443")
				}
				resolved, err := resolver.LookupIPAddr(dctx, host)
				if err != nil || len(resolved) == 0 {
					return nil, fmt.Errorf("failed to resolve %s", host)
				}
				for _, rIP := range resolved {
					if isPublicRoutableIP(rIP.IP) {
						return dialer.DialContext(dctx, network, net.JoinHostPort(rIP.IP.String(), port))
					}
				}
				return nil, fmt.Errorf("refusing connection to non-public address for %s", host)
			},
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return errors.New("too many HTTP redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return errors.New("disallowed redirect scheme")
			}
			return nil
		},
	}

	targetURL := fmt.Sprintf("http://%s/.well-known/acme-challenge/%s", domain, token)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Wimotek-ACME-Validator/2.0 (+RFC8555)")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("HTTP-01 fetch failed for %s: %v", domain, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP-01 endpoint returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return err
	}
	actual := strings.TrimSpace(string(body))
	if actual != expectedKeyAuth {
		return errors.New("HTTP-01 key authorization mismatch")
	}
	return nil
}

func validateDNS01Public(ctx context.Context, domain, expectedKeyAuth string) error {
	sum := sha256.Sum256([]byte(expectedKeyAuth))
	expectedTXT := base64.RawURLEncoding.EncodeToString(sum[:])
	fqdn := "_acme-challenge." + strings.TrimPrefix(domain, "*.")
	records, err := net.DefaultResolver.LookupTXT(ctx, fqdn)
	if err != nil {
		return fmt.Errorf("DNS-01 TXT lookup failed for %s: %v", fqdn, err)
	}
	for _, rec := range records {
		if strings.TrimSpace(rec) == expectedTXT {
			return nil
		}
	}
	return fmt.Errorf("DNS-01 TXT record mismatch on %s (expected %s)", fqdn, expectedTXT)
}

func (s *Server) handleACMEChallenge(w http.ResponseWriter, r *http.Request) {
	compositeID := strings.TrimSpace(r.PathValue("id"))
	v, code, errType, detail := s.verifyACMERequest(r, "/acme/chall/"+compositeID, false, true)
	if code != 0 {
		s.writeACMEError(w, r, code, errType, detail)
		return
	}
	parts := strings.SplitN(compositeID, ".", 2)
	if len(parts) != 2 {
		s.writeACMEError(w, r, http.StatusNotFound, "malformed", "invalid challenge identifier")
		return
	}
	authzID, challID := parts[0], parts[1]
	authz, err := s.store.GetACMEAuthorization(r.Context(), authzID)
	if err != nil || authz == nil {
		s.writeACMEError(w, r, http.StatusNotFound, "malformed", "authorization not found")
		return
	}
	if authz.AccountID != v.Account.ID {
		s.writeACMEError(w, r, http.StatusForbidden, "unauthorized", "challenge belongs to a different account")
		return
	}

	var challs []acmeChallenge
	if err := json.Unmarshal([]byte(authz.ChallengesJSON), &challs); err != nil {
		s.writeACMEError(w, r, http.StatusInternalServerError, "serverInternal", "corrupt challenge data")
		return
	}
	idx := -1
	for i := range challs {
		if challs[i].ID == challID {
			idx = i
			break
		}
	}
	if idx < 0 {
		s.writeACMEError(w, r, http.StatusNotFound, "malformed", "challenge not found")
		return
	}

	ch := &challs[idx]
	if ch.Status == "pending" {
		keyAuth := ch.Token + "." + v.JWKThumb
		valCtx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		var valErr error
		switch ch.Type {
		case "http-01":
			valErr = validateHTTP01Public(valCtx, authz.IdentifierValue, ch.Token, keyAuth)
		case "dns-01":
			valErr = validateDNS01Public(valCtx, authz.IdentifierValue, keyAuth)
		default:
			valErr = fmt.Errorf("unsupported challenge type %q", ch.Type)
		}
		cancel()

		if valErr == nil {
			ch.Status = "valid"
			ch.Validated = time.Now().UTC().Format(time.RFC3339)
			ch.Error = nil
			authz.Status = "valid"
		} else {
			ch.Status = "invalid"
			ch.Error = &acmeProblem{
				Type:   "urn:ietf:params:acme:error:incorrectResponse",
				Detail: valErr.Error(),
				Status: http.StatusForbidden,
			}
			authz.Status = "invalid"
		}

		updatedJSON, _ := json.Marshal(challs)
		_ = s.store.UpdateACMEAuthorization(r.Context(), authz.ID, authz.Status, string(updatedJSON))

		// Recompute parent order state
		order, err := s.store.GetACMEOrder(r.Context(), authz.OrderID)
		if err == nil && order != nil && (order.Status == "pending" || order.Status == "ready") {
			allAuthzs, _ := s.store.ListACMEAuthorizationsByOrder(r.Context(), order.ID)
			allValid := len(allAuthzs) > 0
			anyInvalid := false
			for _, a := range allAuthzs {
				if a.Status == "invalid" {
					anyInvalid = true
				}
				if a.Status != "valid" {
					allValid = false
				}
			}
			if anyInvalid {
				errBytes, _ := json.Marshal(ch.Error)
				_ = s.store.UpdateACMEOrder(r.Context(), order.ID, "invalid", "", string(errBytes))
			} else if allValid {
				_ = s.store.UpdateACMEOrder(r.Context(), order.ID, "ready", "", "")
			}
		}
	}

	base := s.acmeBaseURL(r)
	w.Header().Set("Link", fmt.Sprintf("<%s/acme/authz/%s>;rel=\"up\"", base, authz.ID))
	s.writeACMEJSON(w, r, http.StatusOK, ch)
}

func (s *Server) handleACMEFinalizeOrder(w http.ResponseWriter, r *http.Request) {
	orderID := strings.TrimSpace(r.PathValue("id"))
	v, code, errType, detail := s.verifyACMERequest(r, "/acme/order/"+orderID+"/finalize", false, true)
	if code != 0 {
		s.writeACMEError(w, r, code, errType, detail)
		return
	}
	order, err := s.store.GetACMEOrder(r.Context(), orderID)
	if err != nil || order == nil {
		s.writeACMEError(w, r, http.StatusNotFound, "malformed", "order not found")
		return
	}
	if order.AccountID != v.Account.ID {
		s.writeACMEError(w, r, http.StatusForbidden, "unauthorized", "order belongs to a different account")
		return
	}
	if order.Status != "ready" {
		s.writeACMEError(w, r, http.StatusForbidden, "orderNotReady", fmt.Sprintf("order status is %q, expected ready", order.Status))
		return
	}

	var req struct {
		CSR string `json:"csr"`
	}
	if err := json.Unmarshal(v.Payload, &req); err != nil || strings.TrimSpace(req.CSR) == "" {
		s.writeACMEError(w, r, http.StatusBadRequest, "badCSR", "csr field is required")
		return
	}
	csrDER, err := base64.RawURLEncoding.DecodeString(req.CSR)
	if err != nil {
		s.writeACMEError(w, r, http.StatusBadRequest, "badCSR", "invalid base64url CSR")
		return
	}
	csr, err := x509.ParseCertificateRequest(csrDER)
	if err != nil {
		s.writeACMEError(w, r, http.StatusBadRequest, "badCSR", "failed to parse X.509 CSR")
		return
	}
	if err := csr.CheckSignature(); err != nil {
		s.writeACMEError(w, r, http.StatusBadRequest, "badCSR", "CSR signature verification failed")
		return
	}
	// RFC 8555 §11.1: CSR public key must not match the ACME account key
	csrPubBytes, _ := x509.MarshalPKIXPublicKey(csr.PublicKey)
	acctPubBytes, _ := x509.MarshalPKIXPublicKey(v.PubKey)
	if len(csrPubBytes) > 0 && hmac.Equal(csrPubBytes, acctPubBytes) {
		s.writeACMEError(w, r, http.StatusBadRequest, "badCSR", "CSR public key must differ from ACME account key")
		return
	}

	var idents []acmeIdentifier
	_ = json.Unmarshal([]byte(order.IdentifiersJSON), &idents)
	allowedSet := map[string]bool{}
	orderedDomains := make([]string, 0, len(idents))
	for _, id := range idents {
		d := strings.ToLower(strings.TrimSpace(id.Value))
		allowedSet[d] = true
		orderedDomains = append(orderedDomains, d)
	}

	// Verify CSR domains strictly belong to authorized identifiers
	csrDomains := map[string]bool{}
	for _, d := range csr.DNSNames {
		low := strings.ToLower(strings.TrimSpace(d))
		if !allowedSet[low] {
			s.writeACMEError(w, r, http.StatusBadRequest, "badCSR", fmt.Sprintf("unauthorized domain %q in CSR", d))
			return
		}
		csrDomains[low] = true
	}
	if cn := strings.ToLower(strings.TrimSpace(csr.Subject.CommonName)); cn != "" {
		if !allowedSet[cn] {
			s.writeACMEError(w, r, http.StatusBadRequest, "badCSR", fmt.Sprintf("unauthorized CN %q in CSR", csr.Subject.CommonName))
			return
		}
		csrDomains[cn] = true
	}
	if len(csrDomains) == 0 {
		s.writeACMEError(w, r, http.StatusBadRequest, "badCSR", "CSR must include at least one authorized DNS identifier")
		return
	}
	// Ensure all order identifiers are covered
	for d := range allowedSet {
		if !csrDomains[d] {
			s.writeACMEError(w, r, http.StatusBadRequest, "badCSR", fmt.Sprintf("CSR missing ordered identifier %q", d))
			return
		}
	}

	pol := s.loadACMEPolicy(r.Context())
	csrPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER}))
	cn := orderedDomains[0]
	if csr.Subject.CommonName != "" {
		cn = strings.ToLower(strings.TrimSpace(csr.Subject.CommonName))
	}

	// ZeroSSL-style commercial policy: ACME issuance uses MaxQuota = -1 (unlimited count) & KeyModeOverride = "acme_csr"
	res, err := s.pki.Issue(r.Context(), ca.IssueRequest{
		Profile:         ca.ProfileTLSServer,
		CommonName:      cn,
		SANs:            orderedDomains,
		ValidityDays:    pol.DefaultTTLDays,
		CSRPEM:          csrPEM,
		IssuedBy:        v.Account.OwnerUsername,
		ClientIP:        clientIP(r),
		MaxQuota:        -1,
		KeyModeOverride: "acme_csr",
	})
	if err != nil {
		s.writeACMEError(w, r, http.StatusInternalServerError, "serverInternal", err.Error())
		return
	}

	_ = s.store.UpdateACMEOrder(r.Context(), order.ID, "valid", res.Record.SerialHex, "")
	order.Status = "valid"
	order.CertSerial = res.Record.SerialHex
	authzs, _ := s.store.ListACMEAuthorizationsByOrder(r.Context(), order.ID)

	base := s.acmeBaseURL(r)
	w.Header().Set("Location", base+"/acme/order/"+order.ID)
	s.writeACMEJSON(w, r, http.StatusOK, s.formatACMEOrderResponse(base, order, authzs))
}

func (s *Server) handleACMECert(w http.ResponseWriter, r *http.Request) {
	serial := strings.TrimSpace(r.PathValue("serial"))
	v, code, errType, detail := s.verifyACMERequest(r, "/acme/cert/"+serial, false, true)
	if code != 0 {
		s.writeACMEError(w, r, code, errType, detail)
		return
	}
	ord, err := s.store.GetACMEOrderByCertSerial(r.Context(), serial)
	if err != nil || ord == nil {
		s.writeACMEError(w, r, http.StatusNotFound, "malformed", "certificate order not found")
		return
	}
	if ord.AccountID != v.Account.ID && ord.OwnerUsername != v.Account.OwnerUsername {
		s.writeACMEError(w, r, http.StatusForbidden, "unauthorized", "certificate belongs to a different account")
		return
	}
	certRec, err := s.store.GetCertificate(r.Context(), serial)
	if err != nil || certRec == nil {
		s.writeACMEError(w, r, http.StatusNotFound, "malformed", "certificate not found")
		return
	}
	chain := strings.TrimSpace(certRec.CertPEM) + "\n" + strings.TrimSpace(s.pki.IssuingPEM()) + "\n" + strings.TrimSpace(s.pki.RootPEM()) + "\n"
	s.setACMECommonHeaders(w, r)
	w.Header().Set("Content-Type", "application/pem-certificate-chain")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(chain))
}

func (s *Server) handleACMERevokeCert(w http.ResponseWriter, r *http.Request) {
	// RFC 8555 §7.6: either KID (owning account) or JWK (matching certificate's own key)
	v, code, errType, detail := s.verifyACMERequest(r, "/acme/revoke-cert", true, true)
	if code != 0 {
		s.writeACMEError(w, r, code, errType, detail)
		return
	}
	var req struct {
		Certificate string `json:"certificate"`
		Reason      int    `json:"reason"`
	}
	if err := json.Unmarshal(v.Payload, &req); err != nil || req.Certificate == "" {
		s.writeACMEError(w, r, http.StatusBadRequest, "malformed", "certificate field is required")
		return
	}
	certDER, err := base64.RawURLEncoding.DecodeString(req.Certificate)
	if err != nil {
		s.writeACMEError(w, r, http.StatusBadRequest, "malformed", "invalid base64url certificate")
		return
	}
	parsedCert, err := x509.ParseCertificate(certDER)
	if err != nil {
		s.writeACMEError(w, r, http.StatusBadRequest, "malformed", "invalid X.509 certificate")
		return
	}
	serialHex := strings.ToUpper(fmt.Sprintf("%032X", parsedCert.SerialNumber))
	certRec, err := s.store.GetCertificate(r.Context(), serialHex)
	if err != nil || certRec == nil {
		certRec, _ = s.store.GetCertificate(r.Context(), strings.ToUpper(parsedCert.SerialNumber.Text(16)))
	}
	if certRec == nil {
		s.writeACMEError(w, r, http.StatusNotFound, "malformed", "certificate not found")
		return
	}
	if certRec.Status == "revoked" {
		s.writeACMEError(w, r, http.StatusBadRequest, "alreadyRevoked", "certificate already revoked")
		return
	}

	authorized := false
	actor := "acme-key"
	if v.Account != nil {
		if certRec.IssuedBy == v.Account.OwnerUsername {
			authorized = true
			actor = v.Account.OwnerUsername
		}
	} else if v.PubKey != nil {
		certPub, _ := x509.MarshalPKIXPublicKey(parsedCert.PublicKey)
		jwkPub, _ := x509.MarshalPKIXPublicKey(v.PubKey)
		if len(certPub) > 0 && hmac.Equal(certPub, jwkPub) {
			authorized = true
		}
	}
	if !authorized {
		s.writeACMEError(w, r, http.StatusForbidden, "unauthorized", "not authorized to revoke this certificate")
		return
	}

	if err := s.pki.Revoke(r.Context(), certRec.SerialHex, req.Reason, actor, clientIP(r)); err != nil {
		s.writeACMEError(w, r, http.StatusInternalServerError, "serverInternal", err.Error())
		return
	}
	s.setACMECommonHeaders(w, r)
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleACMEKeyChange(w http.ResponseWriter, r *http.Request) {
	v, code, errType, detail := s.verifyACMERequest(r, "/acme/key-change", false, true)
	if code != 0 {
		s.writeACMEError(w, r, code, errType, detail)
		return
	}
	var inner acmeJWS
	if err := json.Unmarshal(v.Payload, &inner); err != nil {
		s.writeACMEError(w, r, http.StatusBadRequest, "malformed", "invalid inner key-change JWS")
		return
	}
	innerProtBytes, err := base64.RawURLEncoding.DecodeString(inner.Protected)
	if err != nil {
		s.writeACMEError(w, r, http.StatusBadRequest, "malformed", "invalid inner protected header")
		return
	}
	var innerHdr acmeProtectedHeader
	if err := json.Unmarshal(innerProtBytes, &innerHdr); err != nil {
		s.writeACMEError(w, r, http.StatusBadRequest, "malformed", "invalid inner protected JSON")
		return
	}
	newThumb, newCanon, newPub, err := canonicalJWKThumbprint(innerHdr.JWK)
	if err != nil {
		s.writeACMEError(w, r, http.StatusBadRequest, "badPublicKey", err.Error())
		return
	}
	if err := verifyJWSSignature(innerHdr.Alg, newPub, []byte(inner.Protected+"."+inner.Payload), inner.Signature); err != nil {
		s.writeACMEError(w, r, http.StatusForbidden, "unauthorized", "inner key-change signature failed")
		return
	}
	if existing, _ := s.store.GetACMEAccountByThumbprint(r.Context(), newThumb); existing != nil {
		s.writeACMEError(w, r, http.StatusConflict, "malformed", "new key already bound to an account")
		return
	}
	if err := s.store.UpdateACMEAccountKey(r.Context(), v.Account.ID, newThumb, newCanon); err != nil {
		s.writeACMEError(w, r, http.StatusInternalServerError, "serverInternal", err.Error())
		return
	}
	var contacts []string
	_ = json.Unmarshal([]byte(v.Account.ContactsJSON), &contacts)
	s.writeACMEJSON(w, r, http.StatusOK, map[string]any{
		"status":  v.Account.Status,
		"contact": contacts,
	})
}

// =========================================================================
// Console Management APIs (/api/acme/*)
// =========================================================================

func (s *Server) handleListACMEEAB(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	scopeOwner := sess.Username
	if sess.Role == store.RoleAdmin && r.URL.Query().Get("all") == "1" {
		scopeOwner = ""
	}
	eabs, err := s.store.ListACMEEAB(r.Context(), scopeOwner)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	accts, _ := s.store.ListACMEAccounts(r.Context(), scopeOwner)
	orders, _ := s.store.ListACMEOrders(r.Context(), scopeOwner, "", 30)
	manualActive, _ := s.store.CountActiveCertificatesByUser(r.Context(), sess.Username)
	acmeActive, _ := s.store.CountActiveACMECertificatesByUser(r.Context(), sess.Username)
	manualQuota := store.DefaultQuotaForRole(sess.Role)
	if u, err := s.store.GetUser(r.Context(), sess.Username); err == nil && u != nil {
		manualQuota = u.CertQuota
	}

	// Ensure deterministic newest-first order
	sort.SliceStable(eabs, func(i, j int) bool { return eabs[i].CreatedAt > eabs[j].CreatedAt })

	pol := s.loadACMEPolicy(r.Context())
	base := s.acmeBaseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"directory_url":       base + "/acme/directory",
		"policy":              pol,
		"credentials":         eabs,
		"accounts":            accts,
		"orders":              orders,
		"manual_active_certs": manualActive,
		"manual_quota":        manualQuota,
		"acme_active_certs":   acmeActive,
		"acme_quota":          -1,
	})
}

func (s *Server) handleCreateACMEEAB(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	var body struct {
		Label string `json:"label"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body)
	label := strings.TrimSpace(body.Label)
	if label == "" {
		label = "ACME EAB Credential"
	}
	if len(label) > 120 {
		label = label[:120]
	}

	kid := "eab_" + store.GenerateRandomID(12)
	rawBytes := make([]byte, 32)
	if _, err := rand.Read(rawBytes); err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to generate EAB key")
		return
	}
	hmacB64 := base64.RawURLEncoding.EncodeToString(rawBytes)
	enc, err := s.pki.EncryptSecret([]byte(hmacB64))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	prefix := hmacB64[:8] + "..." + hmacB64[len(hmacB64)-4:]
	rec := store.ACMEEABRecord{
		KID:           kid,
		OwnerUsername: sess.Username,
		Label:         label,
		HMACKeyEnc:    enc,
		HMACPrefix:    prefix,
		BoundCount:    0,
		LastUsedAt:    0,
		Enabled:       true,
		CreatedAt:     time.Now().Unix(),
	}
	if err := s.store.InsertACMEEAB(r.Context(), rec); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:      sess.Username,
		Action:     "acme.eab_create",
		ClientIP:   clientIP(r),
		DetailJSON: fmt.Sprintf(`{"kid":%q,"label":%q}`, kid, label),
		CreatedAt:  time.Now().Unix(),
	})

	writeJSON(w, http.StatusCreated, map[string]any{
		"credential": rec,
		"eab_kid":    kid,
		"eab_hmac":   hmacB64,
	})
}

func (s *Server) handleDeleteACMEEAB(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	kid := strings.TrimSpace(r.PathValue("kid"))
	rec, err := s.store.GetACMEEAB(r.Context(), kid)
	if err != nil || rec == nil {
		writeErr(w, http.StatusNotFound, "EAB credential not found")
		return
	}
	if rec.OwnerUsername != sess.Username && sess.Role != store.RoleAdmin {
		writeErr(w, http.StatusForbidden, "not authorized to revoke this EAB credential")
		return
	}
	if err := s.store.DeleteACMEEAB(r.Context(), kid); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:      sess.Username,
		Action:     "acme.eab_delete",
		ClientIP:   clientIP(r),
		DetailJSON: fmt.Sprintf(`{"kid":%q}`, kid),
		CreatedAt:  time.Now().Unix(),
	})
	writeJSON(w, http.StatusOK, map[string]any{"deleted": kid})
}

func (s *Server) handleGetACMEPolicy(w http.ResponseWriter, r *http.Request, _ *auth.SessionInfo) {
	writeJSON(w, http.StatusOK, map[string]any{
		"directory_url": s.acmeBaseURL(r) + "/acme/directory",
		"policy":        s.loadACMEPolicy(r.Context()),
	})
}

func (s *Server) handleUpdateACMEPolicy(w http.ResponseWriter, r *http.Request, sess *auth.SessionInfo) {
	pol := s.loadACMEPolicy(r.Context())
	var body struct {
		RequireEAB             *bool   `json:"require_eab"`
		DefaultTTLDays         *int    `json:"default_ttl_days"`
		RateLimitOrdersPerHour *int    `json:"rate_limit_orders_per_hour"`
		RateLimitReqPerMin     *int    `json:"rate_limit_req_per_min"`
		AllowWildcard          *bool   `json:"allow_wildcard"`
		TermsURL               *string `json:"terms_url"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json payload")
		return
	}
	if body.RequireEAB != nil {
		pol.RequireEAB = *body.RequireEAB
	}
	if body.DefaultTTLDays != nil {
		if *body.DefaultTTLDays < 1 || *body.DefaultTTLDays > 365 {
			writeErr(w, http.StatusBadRequest, "default_ttl_days must be between 1 and 365")
			return
		}
		pol.DefaultTTLDays = *body.DefaultTTLDays
	}
	if body.RateLimitOrdersPerHour != nil {
		if *body.RateLimitOrdersPerHour < 1 || *body.RateLimitOrdersPerHour > 10000 {
			writeErr(w, http.StatusBadRequest, "rate_limit_orders_per_hour must be between 1 and 10000")
			return
		}
		pol.RateLimitOrdersPerHour = *body.RateLimitOrdersPerHour
	}
	if body.RateLimitReqPerMin != nil {
		if *body.RateLimitReqPerMin < 10 || *body.RateLimitReqPerMin > 10000 {
			writeErr(w, http.StatusBadRequest, "rate_limit_req_per_min must be between 10 and 10000")
			return
		}
		pol.RateLimitReqPerMin = *body.RateLimitReqPerMin
	}
	if body.AllowWildcard != nil {
		pol.AllowWildcard = *body.AllowWildcard
	}
	if body.TermsURL != nil {
		tu := strings.TrimSpace(*body.TermsURL)
		if tu != "" && !strings.HasPrefix(tu, "https://") && !strings.HasPrefix(tu, "http://") {
			writeErr(w, http.StatusBadRequest, "terms_url must start with https:// or http://")
			return
		}
		pol.TermsURL = tu
	}

	raw, _ := json.Marshal(pol)
	if err := s.store.SetSetting(r.Context(), "acme_policy", string(raw)); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = s.store.AppendAudit(r.Context(), store.AuditRecord{
		Actor:      sess.Username,
		Action:     "acme.policy_update",
		ClientIP:   clientIP(r),
		DetailJSON: string(raw),
		CreatedAt:  time.Now().Unix(),
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"directory_url": s.acmeBaseURL(r) + "/acme/directory",
		"policy":        pol,
		"updated_at":    strconv.FormatInt(time.Now().Unix(), 10),
	})
}
