package db

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "modernc.org/sqlite"

	"github.com/wimotek/url/internal/config"
)

// Store wraps SQLite3 (WAL + serialized writer mutex to prevent SQLITE_BUSY/deadlocks)
// and MySQL (pooled connections) behind a unified concurrency-safe interface.
type Store struct {
	mu      sync.RWMutex
	writeMu sync.Mutex
	db      *sql.DB
	driver  string
	dsn     string
	dataDir string
}

func NewStore(dataDir string) *Store {
	return &Store{dataDir: dataDir}
}

func (s *Store) TestConnection(cfg config.DatabaseConfig) error {
	driverName, dsn, err := resolveDriver(cfg)
	if err != nil {
		return err
	}
	conn, err := sql.Open(driverName, dsn)
	if err != nil {
		return err
	}
	defer conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return conn.PingContext(ctx)
}

func (s *Store) Connect(cfg config.DatabaseConfig) error {
	driverName, dsn, err := resolveDriver(cfg)
	if err != nil {
		return err
	}
	conn, err := sql.Open(driverName, dsn)
	if err != nil {
		return err
	}

	if cfg.Driver == "sqlite3" {
		conn.SetMaxOpenConns(1)
		conn.SetMaxIdleConns(1)
		conn.SetConnMaxLifetime(0)
		pragmas := []string{
			"PRAGMA journal_mode=WAL;",
			"PRAGMA synchronous=NORMAL;",
			"PRAGMA busy_timeout=8000;",
			"PRAGMA foreign_keys=ON;",
			"PRAGMA temp_store=MEMORY;",
		}
		for _, p := range pragmas {
			if _, err := conn.Exec(p); err != nil {
				_ = conn.Close()
				return fmt.Errorf("sqlite pragma %s failed: %w", p, err)
			}
		}
	} else {
		conn.SetMaxOpenConns(40)
		conn.SetMaxIdleConns(10)
		conn.SetConnMaxLifetime(30 * time.Minute)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.PingContext(ctx); err != nil {
		_ = conn.Close()
		return err
	}

	s.mu.Lock()
	if s.db != nil {
		_ = s.db.Close()
	}
	s.db = conn
	s.driver = cfg.Driver
	s.dsn = cfg.DSN
	s.mu.Unlock()
	return nil
}

func resolveDriver(cfg config.DatabaseConfig) (string, string, error) {
	switch cfg.Driver {
	case "sqlite3":
		return "sqlite", cfg.DSN, nil
	case "mysql":
		dsn := cfg.DSN
		if !strings.Contains(dsn, "parseTime=") {
			sep := "?"
			if strings.Contains(dsn, "?") {
				sep = "&"
			}
			dsn += sep + "parseTime=true&charset=utf8mb4&collation=utf8mb4_unicode_ci"
		}
		return "mysql", dsn, nil
	default:
		return "", "", fmt.Errorf("unsupported database driver: %s", cfg.Driver)
	}
}

func (s *Store) DB() *sql.DB {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.db
}

func (s *Store) Driver() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.driver
}

func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db != nil {
		return s.db.Close()
	}
	return nil
}

func (s *Store) WithWriteLock(fn func(db *sql.DB) error) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	conn := s.DB()
	if conn == nil {
		return fmt.Errorf("database not initialized")
	}
	return fn(conn)
}

func (s *Store) Migrate() error {
	return s.WithWriteLock(func(conn *sql.DB) error {
		stmts := []string{
			`CREATE TABLE IF NOT EXISTS users (
				id VARCHAR(64) PRIMARY KEY,
				email VARCHAR(255) NOT NULL UNIQUE,
				name VARCHAR(128) NOT NULL,
				password_hash VARCHAR(255) NOT NULL,
				role VARCHAR(32) NOT NULL DEFAULT 'member',
				tier VARCHAR(32) NOT NULL DEFAULT 'free',
				status VARCHAR(32) NOT NULL DEFAULT 'active',
				auth_provider VARCHAR(32) NOT NULL DEFAULT 'local',
				oauth_sub VARCHAR(128) NOT NULL DEFAULT '',
				last_login_at TIMESTAMP NULL,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE TABLE IF NOT EXISTS link_groups (
				id VARCHAR(64) PRIMARY KEY,
				name VARCHAR(128) NOT NULL UNIQUE,
				description TEXT NOT NULL,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE TABLE IF NOT EXISTS domains (
				id VARCHAR(64) PRIMARY KEY,
				host VARCHAR(255) NOT NULL UNIQUE,
				is_default BOOLEAN NOT NULL DEFAULT FALSE,
				root_redirect_enabled BOOLEAN NOT NULL DEFAULT FALSE,
				root_redirect_url TEXT NOT NULL,
				allowed_tiers VARCHAR(255) NOT NULL DEFAULT '',
				dns_verified BOOLEAN NOT NULL DEFAULT TRUE,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE TABLE IF NOT EXISTS short_links (
				id VARCHAR(64) PRIMARY KEY,
				slug VARCHAR(64) NOT NULL,
				domain VARCHAR(255) NOT NULL,
				target_url TEXT NOT NULL,
				title VARCHAR(255) NOT NULL DEFAULT '',
				group_id VARCHAR(64) NULL,
				seo_description TEXT NOT NULL,
				seo_indexable BOOLEAN NOT NULL DEFAULT TRUE,
				redirect_code INTEGER NOT NULL DEFAULT 302,
				cache_ttl_seconds INTEGER NOT NULL DEFAULT 0,
				password_hash VARCHAR(255) NOT NULL DEFAULT '',
				expires_at TIMESTAMP NULL,
				max_clicks INTEGER NULL,
				clicks BIGINT NOT NULL DEFAULT 0,
				unique_clicks BIGINT NOT NULL DEFAULT 0,
				enabled BOOLEAN NOT NULL DEFAULT TRUE,
				is_system_protected BOOLEAN NOT NULL DEFAULT FALSE,
				owner_id VARCHAR(64) NOT NULL,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(domain, slug)
			);`,
			`CREATE TABLE IF NOT EXISTS click_events (
				id VARCHAR(64) PRIMARY KEY,
				link_id VARCHAR(64) NOT NULL,
				ip_hash VARCHAR(64) NOT NULL,
				country_code VARCHAR(8) NOT NULL DEFAULT 'XX',
				region VARCHAR(128) NOT NULL DEFAULT '',
				city VARCHAR(128) NOT NULL DEFAULT '',
				referrer VARCHAR(255) NOT NULL DEFAULT 'Direct',
				referrer_host VARCHAR(255) NOT NULL DEFAULT 'direct',
				referrer_url TEXT NOT NULL DEFAULT '',
				device VARCHAR(64) NOT NULL DEFAULT 'Desktop',
				browser VARCHAR(64) NOT NULL DEFAULT 'Other',
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE TABLE IF NOT EXISTS api_keys (
				id VARCHAR(64) PRIMARY KEY,
				user_id VARCHAR(64) NOT NULL,
				name VARCHAR(128) NOT NULL,
				key_prefix VARCHAR(32) NOT NULL,
				key_hash VARCHAR(255) NOT NULL,
				scopes VARCHAR(255) NOT NULL DEFAULT 'links:read,links:write',
				revoked BOOLEAN NOT NULL DEFAULT FALSE,
				last_used_at TIMESTAMP NULL,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE TABLE IF NOT EXISTS audit_logs (
				id VARCHAR(64) PRIMARY KEY,
				actor VARCHAR(128) NOT NULL,
				action VARCHAR(64) NOT NULL,
				resource VARCHAR(255) NOT NULL,
				ip VARCHAR(64) NOT NULL,
				region VARCHAR(64) NOT NULL DEFAULT '',
				status VARCHAR(32) NOT NULL DEFAULT 'success',
				detail TEXT NOT NULL,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE TABLE IF NOT EXISTS kv_cache (
				cache_key VARCHAR(255) PRIMARY KEY,
				cache_value TEXT NOT NULL,
				expires_at BIGINT NOT NULL
			);`,
			`CREATE TABLE IF NOT EXISTS trusted_devices (
				id VARCHAR(64) PRIMARY KEY,
				user_id VARCHAR(64) NOT NULL,
				token_hash VARCHAR(255) NOT NULL UNIQUE,
				user_agent VARCHAR(255) NOT NULL,
				expires_at TIMESTAMP NOT NULL,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			);`,
		}
		for _, stmt := range stmts {
			if _, err := conn.Exec(stmt); err != nil {
				return fmt.Errorf("migration failed: %w", err)
			}
		}

		// Idempotent additive migrations for existing databases
		alters := []string{
			`ALTER TABLE users ADD COLUMN oauth_sub VARCHAR(128) NOT NULL DEFAULT ''`,
			`ALTER TABLE short_links ADD COLUMN cache_ttl_seconds INTEGER NOT NULL DEFAULT 0`,
			`ALTER TABLE click_events ADD COLUMN referrer_host VARCHAR(255) NOT NULL DEFAULT 'direct'`,
			`ALTER TABLE click_events ADD COLUMN referrer_url TEXT NOT NULL DEFAULT ''`,
		}
		for _, alter := range alters {
			_, _ = conn.Exec(alter)
		}
		return nil
	})
}

// Backup performs a consistent online backup and enforces backup retention count.
func (s *Store) Backup(retentionCount int) (string, error) {
	backupDir := filepath.Join(s.dataDir, "backups")
	if err := os.MkdirAll(backupDir, 0o750); err != nil {
		return "", err
	}

	ts := time.Now().UTC().Format("20060102-150405")
	if s.Driver() == "sqlite3" {
		dest := filepath.Join(backupDir, fmt.Sprintf("wimotek-url-sqlite-%s.db", ts))
		err := s.WithWriteLock(func(conn *sql.DB) error {
			_, _ = conn.Exec("PRAGMA wal_checkpoint(TRUNCATE);")
			src, err := os.Open(s.dsn)
			if err != nil {
				return err
			}
			defer src.Close()
			out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
			if err != nil {
				return err
			}
			defer out.Close()
			_, err = io.Copy(out, src)
			return err
		})
		if err != nil {
			return "", err
		}
		_ = pruneOldBackups(backupDir, retentionCount)
		return dest, nil
	}

	dest := filepath.Join(backupDir, fmt.Sprintf("wimotek-url-mysql-%s.meta.json", ts))
	if err := os.WriteFile(dest, []byte(fmt.Sprintf(`{"engine":"mysql","timestamp":"%s","status":"logical_snapshot_recorded"}`, ts)), 0o600); err != nil {
		return "", err
	}
	_ = pruneOldBackups(backupDir, retentionCount)
	return dest, nil
}

func pruneOldBackups(dir string, keep int) error {
	if keep < 1 {
		keep = 7
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Name() > entries[j].Name()
	})
	for idx, entry := range entries {
		if idx >= keep && !entry.IsDir() {
			_ = os.Remove(filepath.Join(dir, entry.Name()))
		}
	}
	return nil
}
