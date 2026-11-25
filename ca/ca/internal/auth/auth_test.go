package auth_test

import (
	"context"
	"crypto/sha256"
	"strconv"
	"strings"
	"testing"

	"github.com/wimotek/ca/internal/auth"
	"github.com/wimotek/ca/internal/cache"
	"github.com/wimotek/ca/internal/store"
)

func solvePoW(challenge string, bits int) string {
	for i := 0; ; i++ {
		sol := strconv.Itoa(i)
		sum := sha256.Sum256([]byte(challenge + ":" + sol))
		if auth.HasLeadingZeroBits(sum[:], bits) {
			return sol
		}
	}
}

func TestAuthPoWAntiReplayAndLockout(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer st.Close()

	hc := cache.NewHybridCache(st, cache.RedisConfig{})
	defer hc.Close()

	svc := auth.NewService(st, hc, auth.Config{
		AdminUser:     "admin",
		HMACSecret:    []byte("test-hmac-secret-32-bytes-length"),
		PoWDifficulty: 10,
	})

	needs, err := svc.NeedsInitialSetup(ctx)
	if err != nil || !needs {
		t.Fatalf("expected initial setup required")
	}

	if _, err := svc.ClaimInitialAdmin(ctx, "admin", "SuperSecret#2026", "127.0.0.1"); err != nil {
		t.Fatalf("claim admin failed: %v", err)
	}

	// Verify PoW one-time replay protection
	ch := svc.GenerateChallenge()
	sol := solvePoW(ch.Token, ch.Difficulty)
	token, err := svc.Login(ctx, "admin", "SuperSecret#2026", ch.Token, sol, "127.0.0.1")
	if err != nil || token == "" {
		t.Fatalf("valid login failed: %v", err)
	}
	if _, err := svc.Login(ctx, "admin", "SuperSecret#2026", ch.Token, sol, "127.0.0.1"); err == nil {
		t.Fatalf("expected replayed PoW challenge to be rejected")
	}

	// Verify 5 failed logins trigger 15-minute lockout
	for i := 1; i <= 5; i++ {
		c := svc.GenerateChallenge()
		s := solvePoW(c.Token, c.Difficulty)
		_, err := svc.Login(ctx, "admin", "wrong-password", c.Token, s, "127.0.0.1")
		if err == nil {
			t.Fatalf("expected wrong password to fail on attempt %d", i)
		}
		if i == 5 && !strings.Contains(err.Error(), "locked") {
			t.Fatalf("expected lockout message on 5th failure, got: %v", err)
		}
	}

	// Even with correct password, locked account must stay rejected
	c := svc.GenerateChallenge()
	s := solvePoW(c.Token, c.Difficulty)
	if _, err := svc.Login(ctx, "admin", "SuperSecret#2026", c.Token, s, "127.0.0.1"); err == nil || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("expected locked account error, got: %v", err)
	}
}
