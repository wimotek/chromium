package auth

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/wimotek/oauth/internal/cache"
)

// PasswordlessOTPChallenge supports both 6-digit Email OTP and one-click Magic Link sign-in.
type PasswordlessOTPChallenge struct {
	Email      string `json:"email"`
	Code       string `json:"code"`
	MagicToken string `json:"magic_token"`
	CreatedAt  int64  `json:"created_at"`
}

func IssueEmailOTP(ctx context.Context, c cache.Cache, email string) (*PasswordlessOTPChallenge, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return nil, err
	}
	tokBytes := make([]byte, 24)
	if _, err := rand.Read(tokBytes); err != nil {
		return nil, err
	}
	ch := &PasswordlessOTPChallenge{
		Email:      strings.ToLower(strings.TrimSpace(email)),
		Code:       fmt.Sprintf("%06d", n.Int64()),
		MagicToken: base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(tokBytes),
		CreatedAt:  time.Now().Unix(),
	}
	raw, _ := json.Marshal(ch)
	if err := c.Set(ctx, "otp:email:"+ch.Email, string(raw), 5*time.Minute); err != nil {
		return nil, err
	}
	if err := c.Set(ctx, "otp:magic:"+ch.MagicToken, ch.Email, 5*time.Minute); err != nil {
		return nil, err
	}
	return ch, nil
}

// DeviceAuthorization implements RFC 8628 (OAuth 2.0 Device Authorization Grant)
// for CLI tools, TVs, and cross-device QR login flows.
type DeviceAuthorization struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresIn       int    `json:"expires_in"`
	Interval        int    `json:"interval"`
	Status          string `json:"status"` // pending | approved | denied
	ApprovedEmail   string `json:"approved_email,omitempty"`
}

func IssueDeviceAuthorization(ctx context.Context, c cache.Cache, issuer string) (*DeviceAuthorization, error) {
	const alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789"
	var codeBuilder strings.Builder
	for i := 0; i < 8; i++ {
		if i == 4 {
			codeBuilder.WriteByte('-')
		}
		idx, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			return nil, err
		}
		codeBuilder.WriteByte(alphabet[idx.Int64()])
	}
	devBytes := make([]byte, 24)
	_, _ = rand.Read(devBytes)
	devCode := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(devBytes)

	da := &DeviceAuthorization{
		DeviceCode:      devCode,
		UserCode:        codeBuilder.String(),
		VerificationURI: strings.TrimRight(issuer, "/") + "/device",
		ExpiresIn:       600,
		Interval:        5,
		Status:          "pending",
	}
	raw, _ := json.Marshal(da)
	_ = c.Set(ctx, "device:code:"+da.DeviceCode, string(raw), 10*time.Minute)
	_ = c.Set(ctx, "device:user:"+da.UserCode, da.DeviceCode, 10*time.Minute)
	return da, nil
}
