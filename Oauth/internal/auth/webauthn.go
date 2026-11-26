package auth

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

type webAuthnClientData struct {
	Type      string `json:"type"`
	Challenge string `json:"challenge"`
	Origin    string `json:"origin"`
}

func decodeBase64URL(raw string) ([]byte, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "=")
	if trimmed == "" {
		return nil, errors.New("empty base64url payload")
	}
	return base64.RawURLEncoding.DecodeString(trimmed)
}

func validateOriginForRPID(origin, rpID string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	rp := strings.ToLower(strings.TrimSpace(rpID))
	if rp == "" {
		return false
	}
	if host == rp {
		return true
	}
	return strings.HasSuffix(host, "."+rp)
}

// VerifyWebAuthnRegistration verifies clientDataJSON (type, challenge, origin) and parses the SPKI public key.
func VerifyWebAuthnRegistration(expectedChallenge, rpID, clientDataB64, publicKeySpkiB64 string) error {
	cdBytes, err := decodeBase64URL(clientDataB64)
	if err != nil {
		return fmt.Errorf("invalid clientDataJSON encoding: %w", err)
	}
	var cd webAuthnClientData
	if err := json.Unmarshal(cdBytes, &cd); err != nil {
		return fmt.Errorf("malformed clientDataJSON: %w", err)
	}
	if cd.Type != "webauthn.create" {
		return errors.New("unexpected WebAuthn ceremony type: expected webauthn.create")
	}
	if subtle.ConstantTimeCompare([]byte(cd.Challenge), []byte(expectedChallenge)) != 1 {
		return errors.New("WebAuthn challenge mismatch")
	}
	if !validateOriginForRPID(cd.Origin, rpID) {
		return fmt.Errorf("WebAuthn origin %q does not match RP ID %q", cd.Origin, rpID)
	}

	spkiBytes, err := decodeBase64URL(publicKeySpkiB64)
	if err != nil {
		return fmt.Errorf("invalid publicKeySpki encoding: %w", err)
	}
	pub, err := x509.ParsePKIXPublicKey(spkiBytes)
	if err != nil {
		return fmt.Errorf("invalid SPKI public key: %w", err)
	}
	switch pub.(type) {
	case *ecdsa.PublicKey, *rsa.PublicKey:
		return nil
	default:
		return errors.New("unsupported Passkey public key algorithm (must be ES256 or RS256)")
	}
}

// VerifyWebAuthnAssertion verifies a FIDO2/WebAuthn assertion against the stored SPKI public key.
// Returns the authenticator's new signCount on success.
func VerifyWebAuthnAssertion(expectedChallenge, rpID, publicKeySpkiB64, clientDataB64, authDataB64, signatureB64 string, prevSignCount uint32) (uint32, error) {
	cdBytes, err := decodeBase64URL(clientDataB64)
	if err != nil {
		return 0, fmt.Errorf("invalid clientDataJSON: %w", err)
	}
	var cd webAuthnClientData
	if err := json.Unmarshal(cdBytes, &cd); err != nil {
		return 0, fmt.Errorf("malformed clientDataJSON: %w", err)
	}
	if cd.Type != "webauthn.get" {
		return 0, errors.New("unexpected WebAuthn ceremony type: expected webauthn.get")
	}
	if subtle.ConstantTimeCompare([]byte(cd.Challenge), []byte(expectedChallenge)) != 1 {
		return 0, errors.New("WebAuthn challenge mismatch")
	}
	if !validateOriginForRPID(cd.Origin, rpID) {
		return 0, fmt.Errorf("WebAuthn origin %q does not match RP ID %q", cd.Origin, rpID)
	}

	authData, err := decodeBase64URL(authDataB64)
	if err != nil || len(authData) < 37 {
		return 0, errors.New("invalid authenticatorData")
	}
	expectedRPIDHash := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(rpID))))
	if subtle.ConstantTimeCompare(authData[:32], expectedRPIDHash[:]) != 1 {
		return 0, errors.New("authenticatorData rpIdHash mismatch")
	}
	flags := authData[32]
	if flags&0x01 == 0 {
		return 0, errors.New("user presence flag not set in WebAuthn assertion")
	}
	signCount := binary.BigEndian.Uint32(authData[33:37])
	if prevSignCount > 0 && signCount > 0 && signCount <= prevSignCount {
		return 0, errors.New("WebAuthn signCount rollback detected (possible cloned authenticator)")
	}

	sigBytes, err := decodeBase64URL(signatureB64)
	if err != nil {
		return 0, fmt.Errorf("invalid signature encoding: %w", err)
	}
	spkiBytes, err := decodeBase64URL(publicKeySpkiB64)
	if err != nil {
		return 0, fmt.Errorf("invalid stored publicKeySpki: %w", err)
	}
	pub, err := x509.ParsePKIXPublicKey(spkiBytes)
	if err != nil {
		return 0, fmt.Errorf("failed to parse stored public key: %w", err)
	}

	clientDataHash := sha256.Sum256(cdBytes)
	signedPayload := make([]byte, 0, len(authData)+len(clientDataHash))
	signedPayload = append(signedPayload, authData...)
	signedPayload = append(signedPayload, clientDataHash[:]...)
	digest := sha256.Sum256(signedPayload)

	switch k := pub.(type) {
	case *ecdsa.PublicKey:
		if !ecdsa.VerifyASN1(k, digest[:], sigBytes) {
			return 0, errors.New("ECDSA Passkey signature verification failed")
		}
		return signCount, nil
	case *rsa.PublicKey:
		if err := rsa.VerifyPKCS1v15(k, crypto.SHA256, digest[:], sigBytes); err != nil {
			return 0, errors.New("RSA Passkey signature verification failed")
		}
		return signCount, nil
	default:
		return 0, errors.New("unsupported Passkey public key type")
	}
}
