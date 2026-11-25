package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/wimotek/oauth/internal/api"
	"github.com/wimotek/oauth/internal/config"
	"github.com/wimotek/oauth/internal/crypto"
)

func main() {
	dataDir := envOrDefault("WIMOTEK_DATA_DIR", "/data")
	certsDir := envOrDefault("WIMOTEK_CERTS_DIR", "/certs")
	httpAddr := envOrDefault("WIMOTEK_HTTP_ADDR", ":8080")
	httpsAddr := envOrDefault("WIMOTEK_HTTPS_ADDR", ":8443")

	// 1. Verify writable /data volume and emit clear non-root permission diagnostics
	if err := ensureWritableDir(dataDir); err != nil {
		log.Fatalf(
			"[FATAL] Data directory %q is not writable by UID=%d GID=%d: %v\n"+
				"Remediation: Run `chown -R %d:%d <host-data-dir>` on the host before starting the container.",
			dataDir, os.Getuid(), os.Getgid(), err, os.Getuid(), os.Getgid(),
		)
	}

	// 2. Initialize encryption key & persistent OIDC RS256 signing keypair under /data/keys
	keyManager, err := crypto.NewKeyManager(dataDir, os.Getenv("WIMOTEK_MASTER_KEY"))
	if err != nil {
		log.Fatalf("[FATAL] Failed to initialize key manager: %v", err)
	}

	// 3. Resolve TLS certificates: check read-only /certs first, never write to /certs.
	//    If /certs is empty or unmounted, generate & persist self-signed certs under /data/certs.
	tlsCert, certSource, err := crypto.ResolveTLSCertificate(certsDir, filepath.Join(dataDir, "certs"))
	if err != nil {
		log.Fatalf("[FATAL] Failed to resolve TLS certificate: %v", err)
	}
	log.Printf("[TLS] Loaded certificate from %s", certSource)

	// 4. Load system configuration (enters Setup Wizard mode if not yet initialized)
	cfgManager := config.NewManager(dataDir)
	router, cleanup, err := api.NewRouter(cfgManager, keyManager)
	if err != nil {
		log.Fatalf("[FATAL] Failed to initialize HTTP router: %v", err)
	}
	defer cleanup()

	httpServer := &http.Server{
		Addr:              httpAddr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	httpsServer := &http.Server{
		Addr:              httpsAddr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		TLSConfig: &tls.Config{
			MinVersion:   tls.VersionTLS12,
			Certificates: []tls.Certificate{tlsCert},
		},
	}

	errCh := make(chan error, 2)
	go func() {
		log.Printf("[HTTP] wimotek/Oauth listening on %s", httpAddr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("http server error: %w", err)
		}
	}()

	go func() {
		log.Printf("[HTTPS] wimotek/Oauth listening on %s", httpsAddr)
		if err := httpsServer.ListenAndServeTLS("", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("https server error: %w", err)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-sigCh:
		log.Printf("[SHUTDOWN] Received signal %v, draining connections...", sig)
	case err := <-errCh:
		log.Printf("[ERROR] %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
	_ = httpsServer.Shutdown(ctx)
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func ensureWritableDir(dir string) error {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	probe := filepath.Join(dir, ".write_probe")
	if err := os.WriteFile(probe, []byte("ok"), 0o600); err != nil {
		return err
	}
	return os.Remove(probe)
}
