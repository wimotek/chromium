package ca_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/wimotek/ca/internal/ca"
	"github.com/wimotek/ca/internal/cache"
	"github.com/wimotek/ca/internal/store"
)

func TestTLSAutoFallbackAndMountedReadOnly(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	hc := cache.NewHybridCache(st, cache.RedisConfig{})
	defer hc.Close()

	engine, err := ca.NewEngine(ctx, st, hc, ca.Config{
		OrgName:   "TLS Test Corp",
		BaseURL:   "https://localhost:8443",
		MasterKey: []byte("0123456789abcdef0123456789abcdef"),
	})
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}

	// 1. Empty /certs dir -> generates auto cert inside /data/tls without writing to /certs
	tmpRoot := t.TempDir()
	emptyCerts := filepath.Join(tmpRoot, "certs-empty")
	dataDir := filepath.Join(tmpRoot, "data")
	_ = os.MkdirAll(emptyCerts, 0o555)
	_ = os.MkdirAll(dataDir, 0o750)

	mgr, err := ca.SetupServerTLS(emptyCerts, dataDir, "ca.corp.local,10.0.0.5", engine)
	if err != nil {
		t.Fatalf("SetupServerTLS auto fallback failed: %v", err)
	}
	if mgr.Mode() != "auto_self_signed" {
		t.Fatalf("expected auto_self_signed mode, got %s", mgr.Mode())
	}
	if _, err := os.Stat(filepath.Join(dataDir, "tls", "server.crt")); err != nil {
		t.Fatalf("expected auto cert written in /data/tls/server.crt: %v", err)
	}

	// 2. Copy generated cert/key into a read-only /certs dir and verify mounted_ro mode
	mountedCerts := filepath.Join(tmpRoot, "certs-ro")
	_ = os.MkdirAll(mountedCerts, 0o755)
	crtBytes, _ := os.ReadFile(filepath.Join(dataDir, "tls", "server.crt"))
	keyBytes, _ := os.ReadFile(filepath.Join(dataDir, "tls", "server.key"))
	_ = os.WriteFile(filepath.Join(mountedCerts, "tls.crt"), crtBytes, 0o444)
	_ = os.WriteFile(filepath.Join(mountedCerts, "tls.key"), keyBytes, 0o444)
	_ = os.Chmod(mountedCerts, 0o555)
	defer os.Chmod(mountedCerts, 0o755)

	mgrMounted, err := ca.SetupServerTLS(mountedCerts, dataDir, "", engine)
	if err != nil {
		t.Fatalf("SetupServerTLS mounted_ro failed: %v", err)
	}
	if mgrMounted.Mode() != "mounted_ro" {
		t.Fatalf("expected mounted_ro mode, got %s", mgrMounted.Mode())
	}
}
