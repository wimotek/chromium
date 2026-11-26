package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/wimotek/ca/internal/api"
	"github.com/wimotek/ca/internal/auth"
	"github.com/wimotek/ca/internal/ca"
	"github.com/wimotek/ca/internal/cache"
	"github.com/wimotek/ca/internal/i18n"
	"github.com/wimotek/ca/internal/notify"
	"github.com/wimotek/ca/internal/store"
	"github.com/wimotek/ca/web"
)

func main() {
	ctx, stopApp := context.WithCancel(context.Background())
	defer stopApp()

	// All environment variables carry safe production-ready defaults.
	tlsEnabled := parseBoolDefault("CA_TLS_ENABLED", true)
	defaultListen := ":8443"
	defaultScheme := "https"
	if !tlsEnabled {
		defaultListen = ":8080"
		defaultScheme = "http"
	}

	listenAddr := envOrDefault("CA_LISTEN_ADDR", defaultListen)
	dataDir := resolveWritableDataDir(envOrDefault("CA_DATA_DIR", "/data"))
	certsDir := envOrDefault("CA_CERTS_DIR", "/certs")
	dbDriver := strings.ToLower(envOrDefault("CA_DB_DRIVER", "sqlite"))
	dbDSN := envOrDefault("CA_DB_DSN", filepath.Join(dataDir, "wimotek-ca.db"))
	orgName := envOrDefault("CA_ORG_NAME", "Wimotek Enterprise")
	baseURL := envOrDefault("CA_BASE_URL", buildDefaultBaseURL(defaultScheme, listenAddr))
	adminUser := envOrDefault("CA_ADMIN_USER", "admin")
	adminPass := strings.TrimSpace(os.Getenv("CA_ADMIN_PASSWORD"))
	powDiff := parseIntDefault("CA_POW_DIFFICULTY", 16)
	tlsHostsCSV := envOrDefault("CA_TLS_HOSTS", "localhost,127.0.0.1")
	notifyIntervalMin := parseIntDefault("CA_NOTIFY_INTERVAL_MIN", 60)
	allowPrivateWebhooks := parseBoolDefault("CA_ALLOW_PRIVATE_WEBHOOKS", false)

	masterKey := loadOrCreateMasterKey(dataDir, os.Getenv("CA_MASTER_KEY"))

	st, err := store.Open(dbDriver, dbDSN)
	if err != nil {
		log.Fatalf("[wimotek/ca] failed to open %s store: %v", dbDriver, err)
	}
	defer st.Close()

	hc := cache.NewHybridCache(st, cache.RedisConfig{
		Addr:        strings.TrimSpace(os.Getenv("CA_REDIS_ADDR")),
		Password:    strings.TrimSpace(os.Getenv("CA_REDIS_PASSWORD")),
		UseTLS:      parseBoolDefault("CA_REDIS_TLS", false),
		TLSInsecure: parseBoolDefault("CA_REDIS_TLS_INSECURE", false),
	})
	defer hc.Close()

	pki, err := ca.NewEngine(ctx, st, hc, ca.Config{
		OrgName:   orgName,
		BaseURL:   baseURL,
		MasterKey: masterKey,
		DataDir:   dataDir,
		CertsDir:  certsDir,
		TLSMode:   "disabled",
	})
	if err != nil {
		log.Fatalf("[wimotek/ca] failed to bootstrap PKI engine: %v", err)
	}

	authSvc := auth.NewService(st, hc, auth.Config{
		AdminUser:     adminUser,
		EnvPassword:   adminPass,
		HMACSecret:    masterKey,
		PoWDifficulty: powDiff,
	})

	notifySvc := notify.NewService(st, masterKey, allowPrivateWebhooks)
	notifySvc.StartScheduler(ctx, time.Duration(notifyIntervalMin)*time.Minute)

	var tlsMgr *ca.TLSManager
	if tlsEnabled {
		tlsMgr, err = ca.SetupServerTLS(certsDir, dataDir, tlsHostsCSV, pki)
		if err != nil {
			log.Fatalf("[wimotek/ca] failed to initialize TLS manager: %v", err)
		}
		pki.SetTLSMode(tlsMgr.Mode())
	}

	locales, err := i18n.NewBundle()
	if err != nil {
		log.Fatalf("[wimotek/ca] failed to load embedded i18n locales: %v", err)
	}

	webFS, err := web.Assets()
	if err != nil {
		log.Fatalf("[wimotek/ca] failed to load embedded web UI: %v", err)
	}

	handler := api.NewServer(st, hc, pki, authSvc, locales, webFS, api.ServerOptions{
		BaseURL:  baseURL,
		Notifier: notifySvc,
	})

	srv := &http.Server{
		Addr:              listenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	if tlsMgr != nil {
		srv.TLSConfig = tlsMgr.TLSConfig()
	}

	go func() {
		tlsModeLabel := "disabled"
		if tlsMgr != nil {
			tlsModeLabel = tlsMgr.Mode()
		}
		log.Printf("[wimotek/ca] listening on %s (tls=%s, db=%s, data=%s, certs=%s, cache=%s)",
			listenAddr, tlsModeLabel, st.Driver, dataDir, certsDir, hc.Status().Mode)
		var listenErr error
		if tlsMgr != nil {
			listenErr = srv.ListenAndServeTLS("", "")
		} else {
			listenErr = srv.ListenAndServe()
		}
		if listenErr != nil && listenErr != http.ErrServerClosed {
			log.Fatalf("[wimotek/ca] http server error: %v", listenErr)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	stopApp()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}

func envOrDefault(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func buildDefaultBaseURL(scheme, listenAddr string) string {
	host, port, err := net.SplitHostPort(listenAddr)
	if err != nil {
		if strings.HasPrefix(listenAddr, ":") {
			return fmt.Sprintf("%s://localhost%s", scheme, listenAddr)
		}
		return fmt.Sprintf("%s://%s", scheme, listenAddr)
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "localhost"
	}
	return fmt.Sprintf("%s://%s", scheme, net.JoinHostPort(host, port))
}

func parseIntDefault(key string, fallback int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func parseBoolDefault(key string, fallback bool) bool {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "yes")
	}
	return fallback
}

func resolveWritableDataDir(preferred string) string {
	ensureWritable := func(dir string) error {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return err
		}
		probe := filepath.Join(dir, ".write-probe")
		if err := os.WriteFile(probe, []byte("ok"), 0o600); err != nil {
			return err
		}
		_ = os.Remove(probe)
		return nil
	}

	if err := ensureWritable(preferred); err == nil {
		return preferred
	} else if os.Getenv("CA_DATA_DIR") == "" && preferred == "/data" {
		fallback := "./data"
		if fbErr := ensureWritable(fallback); fbErr == nil {
			log.Printf("[wimotek/ca] /data is not writable by uid=%d; falling back to %s (for Docker, chown -R 10001:10001 your /data volume)", os.Getuid(), fallback)
			return fallback
		}
	}
	log.Fatalf("[wimotek/ca] data directory %s is not writable by uid=%d gid=%d (hint: chown -R 10001:10001 %s)",
		preferred, os.Getuid(), os.Getgid(), preferred)
	return preferred
}

func loadOrCreateMasterKey(dataDir, envKey string) []byte {
	if strings.TrimSpace(envKey) != "" {
		sum := sha256.Sum256([]byte(envKey))
		return sum[:]
	}
	keyPath := filepath.Join(dataDir, ".master.key")
	if raw, err := os.ReadFile(keyPath); err == nil {
		if decoded, decErr := hex.DecodeString(strings.TrimSpace(string(raw))); decErr == nil && len(decoded) == 32 {
			return decoded
		}
	}
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	_ = os.WriteFile(keyPath, []byte(hex.EncodeToString(key)), 0o600)
	return key
}
