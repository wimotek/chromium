package oidc

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/wimotek/oauth/internal/cache"
	"github.com/wimotek/oauth/internal/crypto"
)

type Provider struct {
	issuer string
	keys   *crypto.KeyManager
	cache  cache.Cache
}

func NewProvider(issuer string, keys *crypto.KeyManager, c cache.Cache) *Provider {
	return &Provider{
		issuer: strings.TrimRight(issuer, "/"),
		keys:   keys,
		cache:  c,
	}
}

func (p *Provider) DiscoveryHandler(w http.ResponseWriter, _ *http.Request) {
	doc := map[string]any{
		"issuer":                                p.issuer,
		"authorization_endpoint":                p.issuer + "/oauth/authorize",
		"token_endpoint":                        p.issuer + "/oauth/token",
		"userinfo_endpoint":                     p.issuer + "/oauth/userinfo",
		"end_session_endpoint":                  p.issuer + "/oauth/logout",
		"jwks_uri":                              p.issuer + "/.well-known/jwks.json",
		"response_types_supported":              []string{"code"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"code_challenge_methods_supported":      []string{"S256"},
		"scopes_supported":                      []string{"openid", "profile", "email", "offline_access"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
	}
	writeJSON(w, http.StatusOK, doc)
}

func (p *Provider) JWKSHandler(w http.ResponseWriter, _ *http.Request) {
	pubKeys := p.keys.PublicKeys()
	keys := make([]map[string]any, 0, len(pubKeys))
	for _, info := range pubKeys {
		n := base64.RawURLEncoding.EncodeToString(info.Key.N.Bytes())
		e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(info.Key.E)).Bytes())
		keys = append(keys, map[string]any{
			"kty": "RSA",
			"use": "sig",
			"alg": "RS256",
			"kid": info.KeyID,
			"n":   n,
			"e":   e,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"keys": keys,
	})
}

func VerifyPKCES256(verifier, expectedChallenge string) bool {
	if verifier == "" || expectedChallenge == "" {
		return false
	}
	sum := sha256.Sum256([]byte(verifier))
	computed := base64.RawURLEncoding.EncodeToString(sum[:])
	return subtle.ConstantTimeCompare([]byte(computed), []byte(expectedChallenge)) == 1
}

func (p *Provider) IssueIDToken(sub, aud, email, name, nonce string) (string, error) {
	now := time.Now()
	claims := jwt.MapClaims{
		"iss":   p.issuer,
		"sub":   sub,
		"aud":   aud,
		"iat":   now.Unix(),
		"exp":   now.Add(1 * time.Hour).Unix(),
		"email": email,
		"name":  name,
	}
	if nonce != "" {
		claims["nonce"] = nonce
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = p.keys.KeyID()
	return tok.SignedString(p.keys.PrivateKey())
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
