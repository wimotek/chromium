package api

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"

	"github.com/redis/go-redis/v9"
	"github.com/wimotek/oauth/internal/cache"
	"github.com/wimotek/oauth/internal/config"
	"github.com/wimotek/oauth/internal/crypto"
	"github.com/wimotek/oauth/internal/oidc"
	"github.com/wimotek/oauth/internal/store"
	"github.com/wimotek/oauth/web"
)

func NewRouter(cfgMgr *config.Manager, keys *crypto.KeyManager) (http.Handler, func(), error) {
	mux := http.NewServeMux()
	cfg := cfgMgr.Get()

	var repo *store.SQLRepository
	var cacheStore *cache.ResilientCache

	cleanup := func() {
		if cacheStore != nil {
			_ = cacheStore.Close()
		}
		if repo != nil {
			_ = repo.Close()
		}
	}

	if cfg.Initialized {
		var err error
		repo, err = store.Open(cfg.Database.Driver, cfg.Database.DSN)
		if err != nil {
			return nil, cleanup, err
		}
		if err := repo.Migrate(context.Background()); err != nil {
			return nil, cleanup, err
		}
		var rdb *redis.Client
		if cfg.Redis.Enabled && cfg.Redis.Addr != "" {
			rdb = redis.NewClient(&redis.Options{
				Addr:     cfg.Redis.Addr,
				Password: cfg.Redis.Password,
				DB:       cfg.Redis.DB,
			})
		}
		cacheStore = cache.NewResilientCache(rdb, repo.DB(), repo.Driver())
	}

	provider := oidc.NewProvider(cfg.IssuerURL, keys, cacheStore)

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	// Standard OIDC discovery & JWKS endpoints
	mux.HandleFunc("GET /.well-known/openid-configuration", provider.DiscoveryHandler)
	mux.HandleFunc("GET /.well-known/jwks.json", provider.JWKSHandler)

	// Setup Wizard status & completion endpoints
	mux.HandleFunc("GET /api/setup/status", func(w http.ResponseWriter, _ *http.Request) {
		current := cfgMgr.Get()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"initialized": current.Initialized,
			"issuer_url":  current.IssuerURL,
			"db_driver":   current.Database.Driver,
		})
	})

	// Embedded React SPA fallback
	subFS, err := fs.Sub(web.DistFS, "dist")
	if err == nil {
		fileServer := http.FileServer(http.FS(subFS))
		mux.Handle("/", fileServer)
	}

	return mux, cleanup, nil
}
