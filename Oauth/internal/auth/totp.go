package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// GenerateTOTPSecret creates a 160-bit Base32 secret compatible with Google/Microsoft Authenticator & 1Password.
func GenerateTOTPSecret() (string, error) {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw), nil
}

func BuildOTPAuthURI(issuer, accountEmail, secret string) string {
	label := url.PathEscape(issuer + ":" + accountEmail)
	q := url.Values{
		"secret":    {secret},
		"issuer":    {issuer},
		"algorithm": {"SHA1"},
		"digits":    {"6"},
		"period":    {"30"},
	}
	return fmt.Sprintf("otpauth://totp/%s?%s", label, q.Encode())
}

// GenerateTOTP computes a 6-digit RFC 6238 TOTP code for the given timestamp.
func GenerateTOTP(secret string, at time.Time) (string, error) {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil {
		return "", err
	}
	counter := uint64(at.Unix() / 30)
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], counter)

	mac := hmac.New(sha1.New, key)
	mac.Write(buf[:])
	sum := mac.Sum(nil)

	offset := sum[len(sum)-1] & 0x0f
	code := (uint32(sum[offset]&0x7f) << 24) |
		(uint32(sum[offset+1]) << 16) |
		(uint32(sum[offset+2]) << 8) |
		uint32(sum[offset+3])

	return fmt.Sprintf("%06d", code%1_000_000), nil
}

// VerifyTOTP validates a 6-digit code across a ±1 step (30s) clock-skew window in constant time.
func VerifyTOTP(secret, inputCode string, now time.Time) bool {
	clean := strings.TrimSpace(inputCode)
	if len(clean) != 6 {
		return false
	}
	for _, delta := range []time.Duration{-30 * time.Second, 0, 30 * time.Second} {
		expected, err := GenerateTOTP(secret, now.Add(delta))
		if err == nil && subtle.ConstantTimeCompare([]byte(clean), []byte(expected)) == 1 {
			return true
		}
	}
	return false
}
