package handlers

import (
	"database/sql"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/wimotek/url/internal/audit"
	"github.com/wimotek/url/internal/auth"
	"github.com/wimotek/url/internal/cache"
	"github.com/wimotek/url/internal/config"
	"github.com/wimotek/url/internal/db"
	"github.com/wimotek/url/internal/geoip"
	"github.com/wimotek/url/internal/mcp"
	"github.com/wimotek/url/internal/scheduler"
)

type Deps struct {
	Config    *config.Manager
	Store     *db.Store
	Cache     cache.Store
	Auth      *auth.Service
	GeoIP     *geoip.Locator
	Audit     *audit.Logger
	MCP       *mcp.Server
	Scheduler *scheduler.Scheduler
	StaticFS  fs.FS
	DataDir   string
}

func NewRouter(d Deps) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":      "ok",
			"initialized": d.Config.Get().Initialized,
			"cache":       d.Cache.EngineName(),
		})
	})

	// First-Run Setup Wizard Endpoints (permanently locked once initialized)
	mux.HandleFunc("/api/setup/status", func(w http.ResponseWriter, _ *http.Request) {
		cfg := d.Config.Get()
		writeJSON(w, http.StatusOK, map[string]any{
			"initialized": cfg.Initialized,
			"locked":      d.Config.IsLocked(),
		})
	})

	mux.HandleFunc("/api/setup/test-db", func(w http.ResponseWriter, r *http.Request) {
		if d.Config.IsLocked() {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "system is already initialized and locked"})
			return
		}
		var req config.DatabaseConfig
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid payload"})
			return
		}
		if err := d.Store.TestConnection(req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	mux.HandleFunc("/api/setup/complete", func(w http.ResponseWriter, r *http.Request) {
		if d.Config.IsLocked() {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "system is already initialized and locked"})
			return
		}
		var req struct {
			Database      config.DatabaseConfig `json:"database"`
			Redis         config.RedisConfig    `json:"redis"`
			IssuerURL     string                `json:"issuer_url"`
			AdminPath     string                `json:"admin_path"`
			AdminEmail    string                `json:"admin_email"`
			AdminPassword string                `json:"admin_password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
			return
		}
		if req.AdminEmail == "" || len(req.AdminPassword) < 8 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "admin email and >=8 char password are required"})
			return
		}
		if err := d.Store.Connect(req.Database); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := d.Store.Migrate(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		hash, err := auth.HashPassword(req.AdminPassword)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "password hashing failed"})
			return
		}
		adminSlug := strings.Trim(strings.TrimSpace(req.AdminPath), "/")
		if adminSlug == "" {
			adminSlug = "admin"
		}

		cfg := d.Config.Get()
		cfg.Database = req.Database
		cfg.Redis = req.Redis
		cfg.IssuerURL = strings.TrimRight(req.IssuerURL, "/")
		cfg.AdminPath = "/" + adminSlug
		cfg.Initialized = true

		err = d.Store.WithWriteLock(func(conn *sql.DB) error {
			if _, err := conn.Exec(
				`INSERT INTO users (id, email, name, password_hash, role, status, auth_provider) VALUES ('usr_super_admin', ?, 'Super Admin', ?, 'super_admin', 'active', 'local')`,
				req.AdminEmail, hash,
			); err != nil {
				return err
			}
			// Seed system-protected admin portal short link (cannot be deleted)
			_, err := conn.Exec(
				`INSERT INTO short_links (id, slug, domain, target_url, title, seo_description, seo_indexable, redirect_code, enabled, is_system_protected, owner_id)
				 VALUES ('lnk_system_admin', ?, ?, ?, 'Admin Portal', 'Protected administration portal entry', FALSE, 302, TRUE, TRUE, 'usr_super_admin')`,
				adminSlug, cfg.IssuerHostname(), cfg.IssuerURL+cfg.AdminPath,
			)
			return err
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		if err := d.Config.Save(cfg); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if err := d.Config.LockSetup(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		d.Scheduler.Start(cfg.BackupRetentionCount)
		d.Audit.Record(req.AdminEmail, "setup_initialize", cfg.AdminPath, r.RemoteAddr, "LOCAL", "success", "System initialized and setup wizard locked")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "admin_path": cfg.AdminPath})
	})

	// MCP Server Endpoint
	mux.Handle("/mcp", d.MCP)

	// SEO Sitemap
	mux.HandleFunc("/sitemap.xml", func(w http.ResponseWriter, _ *http.Request) {
		cfg := d.Config.Get()
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>` + cfg.IssuerURL + `/</loc></url></urlset>`))
	})

	// Protected Link Deletion Endpoint (enforces system-protected admin link guard)
	mux.HandleFunc("/api/links/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/api/links/")
		var protected bool
		var slug string
		if conn := d.Store.DB(); conn != nil {
			err := conn.QueryRow(`SELECT slug, is_system_protected FROM short_links WHERE id = ?`, id).Scan(&slug, &protected)
			if err == sql.ErrNoRows {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "short link not found"})
				return
			}
			if protected || "/"+slug == d.Config.Get().AdminPath {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "system-protected admin short link cannot be deleted"})
				return
			}
			_ = d.Store.WithWriteLock(func(c *sql.DB) error {
				_, err := c.Exec(`DELETE FROM short_links WHERE id = ? AND is_system_protected = FALSE`, id)
				return err
			})
			_ = d.Cache.Delete(r.Context(), "slug:"+slug)
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
	})

	// Embedded SPA + Root Redirect + Short Link Resolution
	fileServer := http.FileServer(http.FS(d.StaticFS))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		cfg := d.Config.Get()

		// Root `/` handling: forward if enabled, else serve embedded SPA
		if r.URL.Path == "/" {
			if cfg.Initialized && cfg.RootRedirectEnabled && isSafeHTTPURL(cfg.RootRedirectURL) {
				http.Redirect(w, r, cfg.RootRedirectURL, http.StatusFound)
				return
			}
			fileServer.ServeHTTP(w, r)
			return
		}

		// Custom admin path always renders SPA portal
		if r.URL.Path == cfg.AdminPath || strings.HasPrefix(r.URL.Path, cfg.AdminPath+"/") {
			r.URL.Path = "/"
			fileServer.ServeHTTP(w, r)
			return
		}

		// Serve static assets if they exist in embedded frontend
		clean := strings.TrimPrefix(r.URL.Path, "/")
		if f, err := d.StaticFS.Open(clean); err == nil {
			_ = f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}

		// Resolve short link
		if cfg.Initialized && d.Store.DB() != nil {
			var targetURL string
			var redirectCode int
			var enabled bool
			var expiresAt sql.NullTime
			err := d.Store.DB().QueryRow(
				`SELECT target_url, redirect_code, enabled, expires_at FROM short_links WHERE slug = ? LIMIT 1`,
				clean,
			).Scan(&targetURL, &redirectCode, &enabled, &expiresAt)
			if err == nil && enabled && isSafeHTTPURL(targetURL) {
				if expiresAt.Valid && expiresAt.Time.Before(time.Now().UTC()) {
					http.Error(w, "Short link has expired", http.StatusGone)
					return
				}
				loc := d.GeoIP.Lookup(r)
				go func() {
					_ = d.Store.WithWriteLock(func(conn *sql.DB) error {
						_, err := conn.Exec(`UPDATE short_links SET clicks = clicks + 1 WHERE slug = ?`, clean)
						return err
					})
					_ = loc
				}()
				if redirectCode != 301 && redirectCode != 307 {
					redirectCode = http.StatusFound
				}
				http.Redirect(w, r, targetURL, redirectCode)
				return
			}
		}

		// SPA fallback
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})

	return mux
}

func isSafeHTTPURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
