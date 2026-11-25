package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "modernc.org/sqlite"
)

type User struct {
	ID             string `json:"id"`
	Email          string `json:"email"`
	EmailVerified  bool   `json:"email_verified"`
	DisplayName    string `json:"display_name"`
	PasswordHash   string `json:"-"` // Argon2id PHC string
	TotpEnabled    bool   `json:"totp_enabled"`
	TotpSecretEnc  string `json:"-"`
	RecoveryHashes string `json:"-"`
	Status         string `json:"status"` // "active" | "banned"
	CreatedAt      int64  `json:"created_at"`
}

// UserIdentity maps multiple upstream login methods (Microsoft, WeChat, Google, GitHub, Passkey)
// onto a single core User ID for seamless cross-channel authentication & JIT verified-email linking.
type UserIdentity struct {
	ID            string `json:"id"`
	UserID        string `json:"user_id"`
	Provider      string `json:"provider"` // microsoft, apple, google, wechat, github, passkey
	ProviderSub   string `json:"provider_sub"`
	Email         string `json:"email"`
	CredentialPub string `json:"-"` // WebAuthn COSE public key when provider == "passkey"
	LinkedAt      int64  `json:"linked_at"`
}

type Repository interface {
	DB() *sql.DB
	Driver() string
	Ping(ctx context.Context) error
	Migrate(ctx context.Context) error
	Close() error
}

type SQLRepository struct {
	db     *sql.DB
	driver string
}

// Open initializes SQLite3 (with WAL + busy_timeout + single writer pool) or MySQL 8.
// Never hold a SQL transaction across outbound HTTP requests.
func Open(driver, dsn string) (*SQLRepository, error) {
	switch driver {
	case "sqlite3", "sqlite":
		sep := "?"
		if strings.Contains(dsn, "?") {
			sep = "&"
		}
		walDSN := fmt.Sprintf("%s%s_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)", dsn, sep)
		db, err := sql.Open("sqlite", walDSN)
		if err != nil {
			return nil, err
		}
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
		db.SetConnMaxLifetime(0)

		if _, err := db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("failed to enable sqlite WAL: %w", err)
		}
		return &SQLRepository{db: db, driver: "sqlite3"}, nil

	case "mysql":
		db, err := sql.Open("mysql", dsn)
		if err != nil {
			return nil, err
		}
		db.SetMaxOpenConns(25)
		db.SetMaxIdleConns(10)
		db.SetConnMaxLifetime(5 * time.Minute)
		return &SQLRepository{db: db, driver: "mysql"}, nil

	default:
		return nil, errors.New("unsupported database driver: must be sqlite3 or mysql")
	}
}

func (r *SQLRepository) DB() *sql.DB    { return r.db }
func (r *SQLRepository) Driver() string { return r.driver }
func (r *SQLRepository) Close() error   { return r.db.Close() }
func (r *SQLRepository) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	return r.db.PingContext(ctx)
}

func (r *SQLRepository) Migrate(ctx context.Context) error {
	stmts := []string{
		// Lightweight Identity Core: stores only essential auth identity (not heavy business profiles)
		`CREATE TABLE IF NOT EXISTS users (
			id VARCHAR(64) PRIMARY KEY,
			email VARCHAR(191) NOT NULL UNIQUE,
			email_verified TINYINT(1) NOT NULL DEFAULT 0,
			display_name VARCHAR(128) NOT NULL DEFAULT '',
			password_hash TEXT NOT NULL DEFAULT '',
			totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
			totp_secret_enc TEXT NOT NULL DEFAULT '',
			recovery_hashes TEXT NOT NULL DEFAULT '',
			status VARCHAR(32) NOT NULL DEFAULT 'active',
			created_at BIGINT NOT NULL
		);`,
		// Multi-channel identity bindings (Microsoft / Apple / Google / WeChat / GitHub / Passkey WebAuthn)
		`CREATE TABLE IF NOT EXISTS user_identities (
			id VARCHAR(64) PRIMARY KEY,
			user_id VARCHAR(64) NOT NULL,
			provider VARCHAR(64) NOT NULL,
			provider_sub VARCHAR(255) NOT NULL,
			email VARCHAR(191) NOT NULL DEFAULT '',
			credential_pub TEXT NOT NULL DEFAULT '',
			linked_at BIGINT NOT NULL,
			UNIQUE(provider, provider_sub)
		);`,
		`CREATE TABLE IF NOT EXISTS oauth_applications (
			id VARCHAR(64) PRIMARY KEY,
			name VARCHAR(191) NOT NULL,
			client_id VARCHAR(128) NOT NULL UNIQUE,
			encrypted_secret TEXT NOT NULL,
			redirect_uris TEXT NOT NULL,
			created_at BIGINT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS social_connectors (
			id VARCHAR(64) PRIMARY KEY,
			provider VARCHAR(64) NOT NULL,
			display_name VARCHAR(128) NOT NULL,
			enabled TINYINT(1) NOT NULL DEFAULT 0,
			sort_order INT NOT NULL DEFAULT 0,
			client_id VARCHAR(255) NOT NULL DEFAULT '',
			encrypted_secret TEXT NOT NULL,
			extra_json TEXT NOT NULL
		);`,
		// Downstream Webhook subscriptions for user.banned / session.revoked push notifications
		`CREATE TABLE IF NOT EXISTS webhooks (
			id VARCHAR(64) PRIMARY KEY,
			target_url VARCHAR(512) NOT NULL,
			signing_secret_enc TEXT NOT NULL,
			events TEXT NOT NULL,
			enabled TINYINT(1) NOT NULL DEFAULT 1,
			created_at BIGINT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS sys_caches (
			cache_key VARCHAR(255) PRIMARY KEY,
			cache_value TEXT NOT NULL,
			expires_at BIGINT NOT NULL
		);`,
		`CREATE INDEX IF NOT EXISTS idx_sys_caches_expires ON sys_caches (expires_at);`,
	}

	for _, q := range stmts {
		if r.driver == "mysql" && strings.HasPrefix(q, "CREATE INDEX IF NOT EXISTS") {
			continue
		}
		if _, err := r.db.ExecContext(ctx, q); err != nil {
			return fmt.Errorf("migration failed: %w", err)
		}
	}
	return nil
}
