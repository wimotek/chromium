package main

import (
	"context"
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/wimotek/url/internal/audit"
	"github.com/wimotek/url/internal/auth"
	"github.com/wimotek/url/internal/cache"
	"github.com/wimotek/url/internal/config"
	"github.com/wimotek/url/internal/db"
	"github.com/wimotek/url/internal/geoip"
	"github.com/wimotek/url/internal/handlers"
	"github.com/wimotek/url/internal/mcp"
	"github.com/wimotek/url/internal/scheduler"
	"github.com/wimotek/url/internal/tlsutil"
)

//go:embed all:web/dist
var embeddedFrontend embed.FS

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

func main() {
	dataDir := getenv("WIMOTEK_DATA_DIR", "/data")
	certsDir := getenv("WIMOTEK_CERTS_DIR", "/certs")
	httpAddr := getenv("WIMOTEK_HTTP_ADDR", ":8080")
	httpsAddr := getenv("WIMOTEK_HTTPS_ADDR", ":8443")

	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		log.Fatalf("failed to create data directory %s: %v", dataDir, err)
	}

	cfgManager := config.NewManager(filepath.Join(dataDir, "config.json"), filepath.Join(dataDir, ".setup.lock"))
	cfg, err := cfgManager.Load()
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	store := db.NewStore(dataDir)
	var cacheLayer cache.Store = cache.NewMemorySQLFallback(store)

	if cfg.Initialized {
		if err := store.Connect(cfg.Database); err != nil {
			log.Printf("warning: database connection failed on startup: %v", err)
		} else {
			_ = store.Migrate()
			cacheLayer = cache.NewWithFallback(cfg.Redis, store)
		}
	}

	geoLocator := geoip.NewLocator(filepath.Join(dataDir, "GeoLite2-City.mmdb"))
	auditLogger := audit.NewLogger(store, filepath.Join(dataDir, "audit"), cfg.AuditRetentionDays, cfg.AuditMaxRows)
	authService := auth.NewService(cfgManager, store)
	mcpServer := mcp.NewServer(store, cacheLayer, auditLogger)
	sched := scheduler.New(store, auditLogger, dataDir)
	if cfg.Initialized {
		sched.Start(cfg.BackupRetentionCount)
	}

	staticFS, err := fs.Sub(embeddedFrontend, "web/dist")
	if err != nil {
		log.Fatalf("failed to load embedded frontend: %v", err)
	}

	router := handlers.NewRouter(handlers.Deps{
		Config:    cfgManager,
		Store:     store,
		Cache:     cacheLayer,
		Auth:      authService,
		GeoIP:     geoLocator,
		Audit:     auditLogger,
		MCP:       mcpServer,
		Scheduler: sched,
		StaticFS:  staticFS,
		DataDir:   dataDir,
		Version:   Version,
		Commit:    Commit,
		BuildDate: BuildDate,
	})

	tlsCfg, tlsSource, err := tlsutil.LoadOrGenerate(certsDir, filepath.Join(dataDir, "certs"), cfg.IssuerHostname())
	if err != nil {
		log.Fatalf("TLS initialization failed: %v", err)
	}
	log.Printf("wimotek/url %s (%s) starting (TLS source: %s, initialized: %v)", Version, Commit, tlsSource, cfg.Initialized)

	httpSrv := &http.Server{
		Addr:              httpAddr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	httpsSrv := &http.Server{
		Addr:              httpsAddr,
		Handler:           router,
		TLSConfig:         tlsCfg,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("HTTP listening on %s", httpAddr)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP server error: %v", err)
		}
	}()

	go func() {
		log.Printf("HTTPS listening on %s", httpsAddr)
		if err := httpsSrv.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTPS server error: %v", err)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("shutting down gracefully...")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sched.Stop()
	_ = httpSrv.Shutdown(ctx)
	_ = httpsSrv.Shutdown(ctx)
	_ = store.Close()
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
