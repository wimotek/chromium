package risk

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/wimotek/oauth/internal/cache"
)

// BackoffDuration computes progressive exponential account lockout duration after failed logins.
func BackoffDuration(failedAttempts int) time.Duration {
	if failedAttempts < 3 {
		return 0
	}
	shift := failedAttempts - 3
	if shift > 6 {
		shift = 6
	}
	return time.Duration(15<<shift) * time.Second
}

// CheckIPRateLimit enforces sliding-window IP request throttling backed by Redis or SQL fallback cache.
func CheckIPRateLimit(ctx context.Context, c cache.Cache, ip string, limit int, window time.Duration) (allowed bool, current int) {
	key := fmt.Sprintf("rl:ip:%s", ip)
	raw, err := c.Get(ctx, key)
	count := 0
	if err == nil {
		count, _ = strconv.Atoi(raw)
	}
	count++
	_ = c.Set(ctx, key, strconv.Itoa(count), window)
	return count <= limit, count
}

// SignWebhookPayload generates an HMAC-SHA256 signature header (X-Wimotek-Signature-256)
// for downstream account suspension / session revocation notifications.
func SignWebhookPayload(secret string, payload []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// DispatchBanWebhook delivers a signed user.banned event to downstream business apps with SSRF protection.
func DispatchBanWebhook(ctx context.Context, targetURL, secret, userID, email string) error {
	parsed, err := url.Parse(targetURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return errors.New("invalid webhook URL scheme")
	}
	host := parsed.Hostname()
	if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()) {
		return errors.New("blocked private or link-local webhook host")
	}

	body, _ := json.Marshal(map[string]any{
		"event":     "user.banned",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"data": map[string]string{
			"user_id": userID,
			"email":   email,
			"action":  "revoke_all_sessions",
		},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wimotek-Event", "user.banned")
	req.Header.Set("X-Wimotek-Signature-256", SignWebhookPayload(secret, body))

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("webhook target returned HTTP %d", resp.StatusCode)
	}
	return nil
}
