package notify_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/wimotek/ca/internal/ca"
	"github.com/wimotek/ca/internal/cache"
	"github.com/wimotek/ca/internal/notify"
	"github.com/wimotek/ca/internal/store"
)

func TestOutboundURLValidationBlocksPrivateTargets(t *testing.T) {
	blocked := []string{
		"http://127.0.0.1:8080/hook",
		"http://localhost:9000/hook",
		"http://169.254.169.254/latest/meta-data/",
		"http://10.0.0.5/internal",
		"http://192.168.1.10/webhook",
		"file:///etc/passwd",
	}
	for _, u := range blocked {
		if err := notify.ValidateOutboundURL(u, false); err == nil {
			t.Fatalf("expected URL %q to be blocked when allowPrivate=false", u)
		}
	}
	if err := notify.ValidateOutboundURL("https://sctapi.ftqq.com/test.send", false); err != nil {
		t.Fatalf("expected public HTTPS URL to pass, got %v", err)
	}
	if err := notify.ValidateOutboundURL("http://10.0.0.5/internal", true); err != nil {
		t.Fatalf("expected private URL to pass when allowPrivate=true, got %v", err)
	}
}

func TestExpiryScanAndDeduplication(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer st.Close()
	hc := cache.NewHybridCache(st, cache.RedisConfig{})
	defer hc.Close()

	var received atomic.Int32
	mockWebhook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received.Add(1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer mockWebhook.Close()

	key := []byte("0123456789abcdef0123456789abcdef")
	pki, err := ca.NewEngine(ctx, st, hc, ca.Config{
		OrgName:   "Notify Test Corp",
		BaseURL:   "https://ca.example.com",
		MasterKey: key,
	})
	if err != nil {
		t.Fatalf("new pki: %v", err)
	}

	// Issue a certificate expiring in 4 days
	_, err = pki.Issue(ctx, ca.IssueRequest{
		Profile:      ca.ProfileTLSServer,
		CommonName:   "expiring.example.com",
		ValidityDays: 4,
		IssuedBy:     "admin",
		MaxQuota:     -1,
	})
	if err != nil {
		t.Fatalf("issue expiring cert: %v", err)
	}

	// Test real HTTP dispatch against local httptest server (allowPrivateWebhooks=true for test listener)
	svc := notify.NewService(st, key, true)
	ch, err := svc.SaveChannel(ctx, "", "Ops Webhook", notify.ChannelWebhook, notify.ChannelConfig{
		WebhookURL:    mockWebhook.URL,
		WebhookSecret: "secret-hmac-key",
	}, []int{30, 7, 1}, true)
	if err != nil {
		t.Fatalf("save channel: %v", err)
	}
	if ch.ConfigMasked == "" || ch.ConfigEnc == "" {
		t.Fatalf("expected encrypted config and masked summary")
	}

	// First scan should dispatch 1 real HTTP notification (threshold 7d)
	sum1, err := svc.ScanExpiringCertificates(ctx)
	if err != nil {
		t.Fatalf("first scan: %v", err)
	}
	if sum1.AlertsSent != 1 || sum1.ExpiringFound != 1 || received.Load() != 1 {
		t.Fatalf("expected 1 real HTTP alert on first scan, got %+v (received=%d)", sum1, received.Load())
	}

	// Second scan MUST deduplicate and skip without sending another HTTP request!
	sum2, err := svc.ScanExpiringCertificates(ctx)
	if err != nil {
		t.Fatalf("second scan: %v", err)
	}
	if sum2.AlertsSent != 0 || sum2.AlertsSkipped != 1 || received.Load() != 1 {
		t.Fatalf("expected deduplication skip on second scan, got %+v (received=%d)", sum2, received.Load())
	}
}
