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
	Role           string `json:"role"` // "super_admin" | "member"
	PasswordHash   string `json:"-"`    // Argon2id PHC string
	TotpEnabled    bool   `json:"totp_enabled"`
	TotpSecretEnc  string `json:"-"`
	RecoveryHashes string `json:"-"`
	Status         string `json:"status"` // "active" | "banned"
	CreatedAt      int64  `json:"created_at"`
	LastLoginAt    int64  `json:"last_login_at"`
}

// UserIdentity maps multiple upstream login methods (Microsoft, WeChat, Google, GitHub, Passkey)
// onto a single core User ID for seamless cross-channel authentication & JIT verified-email linking.
type UserIdentity struct {
	ID            string `json:"id"`
	UserID        string `json:"user_id"`
	Provider      string `json:"provider"`
	ProviderLabel string `json:"provider_label"`
	ProviderSub   string `json:"provider_sub"`
	Email         string `json:"email"`
	CredentialPub string `json:"-"`
	LinkedAt      int64  `json:"linked_at"`
}

type PasskeyCredential struct {
	ID            string `json:"id"`
	UserID        string `json:"user_id"`
	CredentialID  string `json:"credential_id"`
	PublicKeySPKI string `json:"-"`
	Algorithm     int    `json:"algorithm"`
	Label         string `json:"label"`
	RPID          string `json:"rp_id"`
	SignCount     uint32 `json:"sign_count"`
	CreatedAt     int64  `json:"created_at"`
	LastUsedAt    int64  `json:"last_used_at"`
}

type OAuthApplicationRecord struct {
	ID               string
	Name             string
	Description      string
	ClientID         string
	EncryptedSecret  string
	RedirectUrisJSON string
	ScopesJSON       string
	LoginThemeJSON   string
	CreatedAt        int64
}

type SocialConnectorRecord struct {
	ID              string
	Provider        string
	DisplayName     string
	Enabled         bool
	SortOrder       int
	ClientID        string
	EncryptedSecret string
	SecretMasked    string
	ExtraJSON       string
	UpdatedAt       int64
}

type WebhookRecord struct {
	ID               string
	Name             string
	TargetURL        string
	SigningSecretEnc string
	SecretMasked     string
	EventsJSON       string
	Enabled          bool
	CreatedAt        int64
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
		`CREATE TABLE IF NOT EXISTS users (
			id VARCHAR(64) PRIMARY KEY,
			email VARCHAR(191) NOT NULL UNIQUE,
			email_verified TINYINT(1) NOT NULL DEFAULT 0,
			display_name VARCHAR(128) NOT NULL DEFAULT '',
			role VARCHAR(32) NOT NULL DEFAULT 'member',
			password_hash TEXT,
			totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
			totp_secret_enc TEXT,
			recovery_hashes TEXT,
			status VARCHAR(32) NOT NULL DEFAULT 'active',
			created_at BIGINT NOT NULL,
			last_login_at BIGINT NOT NULL DEFAULT 0
		);`,
		`CREATE TABLE IF NOT EXISTS user_identities (
			id VARCHAR(64) PRIMARY KEY,
			user_id VARCHAR(64) NOT NULL,
			provider VARCHAR(64) NOT NULL,
			provider_label VARCHAR(128) NOT NULL DEFAULT '',
			provider_sub VARCHAR(255) NOT NULL,
			email VARCHAR(191) NOT NULL DEFAULT '',
			credential_pub TEXT,
			linked_at BIGINT NOT NULL,
			UNIQUE(provider, provider_sub)
		);`,
		`CREATE TABLE IF NOT EXISTS passkey_credentials (
			id VARCHAR(64) PRIMARY KEY,
			user_id VARCHAR(64) NOT NULL,
			credential_id VARCHAR(255) NOT NULL UNIQUE,
			public_key_spki TEXT NOT NULL,
			algorithm INT NOT NULL DEFAULT -7,
			label VARCHAR(128) NOT NULL DEFAULT '',
			rp_id VARCHAR(255) NOT NULL DEFAULT '',
			sign_count BIGINT NOT NULL DEFAULT 0,
			created_at BIGINT NOT NULL,
			last_used_at BIGINT NOT NULL DEFAULT 0
		);`,
		`CREATE TABLE IF NOT EXISTS oauth_applications (
			id VARCHAR(64) PRIMARY KEY,
			name VARCHAR(191) NOT NULL,
			description TEXT,
			client_id VARCHAR(128) NOT NULL UNIQUE,
			encrypted_secret TEXT NOT NULL,
			redirect_uris TEXT NOT NULL,
			scopes_json TEXT,
			login_theme_json TEXT,
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
			secret_masked VARCHAR(128) NOT NULL DEFAULT '',
			extra_json TEXT NOT NULL,
			updated_at BIGINT NOT NULL DEFAULT 0
		);`,
		`CREATE TABLE IF NOT EXISTS webhooks (
			id VARCHAR(64) PRIMARY KEY,
			name VARCHAR(191) NOT NULL DEFAULT '',
			target_url VARCHAR(512) NOT NULL,
			signing_secret_enc TEXT NOT NULL,
			secret_masked VARCHAR(128) NOT NULL DEFAULT '',
			events TEXT NOT NULL,
			enabled TINYINT(1) NOT NULL DEFAULT 1,
			created_at BIGINT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS sys_settings (
			setting_key VARCHAR(128) PRIMARY KEY,
			setting_value TEXT NOT NULL,
			updated_at BIGINT NOT NULL
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

	// Safe additive migrations for upgrading existing databases created by earlier releases.
	additive := []string{
		`ALTER TABLE users ADD COLUMN role VARCHAR(32) NOT NULL DEFAULT 'member'`,
		`ALTER TABLE users ADD COLUMN last_login_at BIGINT NOT NULL DEFAULT 0`,
		`ALTER TABLE user_identities ADD COLUMN provider_label VARCHAR(128) NOT NULL DEFAULT ''`,
		`ALTER TABLE oauth_applications ADD COLUMN description TEXT`,
		`ALTER TABLE oauth_applications ADD COLUMN scopes_json TEXT`,
		`ALTER TABLE oauth_applications ADD COLUMN login_theme_json TEXT`,
		`ALTER TABLE social_connectors ADD COLUMN secret_masked VARCHAR(128) NOT NULL DEFAULT ''`,
		`ALTER TABLE social_connectors ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0`,
		`ALTER TABLE webhooks ADD COLUMN name VARCHAR(191) NOT NULL DEFAULT ''`,
		`ALTER TABLE webhooks ADD COLUMN secret_masked VARCHAR(128) NOT NULL DEFAULT ''`,
	}
	for _, alter := range additive {
		if _, err := r.db.ExecContext(ctx, alter); err != nil {
			msg := strings.ToLower(err.Error())
			if strings.Contains(msg, "duplicate column") || strings.Contains(msg, "already exists") {
				continue
			}
			return fmt.Errorf("additive migration failed (%s): %w", alter, err)
		}
	}
	return nil
}

// ============================================================================
// Settings (Auth Policy, One-Time Seed Flags)
// ============================================================================

func (r *SQLRepository) GetSetting(ctx context.Context, key string) (string, bool, error) {
	var val string
	err := r.db.QueryRowContext(ctx, `SELECT setting_value FROM sys_settings WHERE setting_key = ?`, key).Scan(&val)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return val, true, nil
}

func (r *SQLRepository) SetSetting(ctx context.Context, key, val string) error {
	now := time.Now().UTC().Unix()
	if r.driver == "mysql" {
		_, err := r.db.ExecContext(ctx,
			`INSERT INTO sys_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
			 ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = VALUES(updated_at)`,
			key, val, now,
		)
		return err
	}
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO sys_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
		key, val, now,
	)
	return err
}

// ============================================================================
// OAuth Applications
// ============================================================================

func (r *SQLRepository) ListApplications(ctx context.Context) ([]OAuthApplicationRecord, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, name, COALESCE(description, ''), client_id, encrypted_secret,
		       redirect_uris, COALESCE(scopes_json, ''), COALESCE(login_theme_json, ''), created_at
		FROM oauth_applications
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]OAuthApplicationRecord, 0)
	for rows.Next() {
		var rec OAuthApplicationRecord
		if err := rows.Scan(
			&rec.ID, &rec.Name, &rec.Description, &rec.ClientID, &rec.EncryptedSecret,
			&rec.RedirectUrisJSON, &rec.ScopesJSON, &rec.LoginThemeJSON, &rec.CreatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

func (r *SQLRepository) UpsertApplication(ctx context.Context, rec OAuthApplicationRecord) error {
	if r.driver == "mysql" {
		_, err := r.db.ExecContext(ctx, `
			INSERT INTO oauth_applications
			(id, name, description, client_id, encrypted_secret, redirect_uris, scopes_json, login_theme_json, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE
				name = VALUES(name),
				description = VALUES(description),
				client_id = VALUES(client_id),
				encrypted_secret = VALUES(encrypted_secret),
				redirect_uris = VALUES(redirect_uris),
				scopes_json = VALUES(scopes_json),
				login_theme_json = VALUES(login_theme_json)
		`, rec.ID, rec.Name, rec.Description, rec.ClientID, rec.EncryptedSecret, rec.RedirectUrisJSON, rec.ScopesJSON, rec.LoginThemeJSON, rec.CreatedAt)
		return err
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO oauth_applications
		(id, name, description, client_id, encrypted_secret, redirect_uris, scopes_json, login_theme_json, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			description = excluded.description,
			client_id = excluded.client_id,
			encrypted_secret = excluded.encrypted_secret,
			redirect_uris = excluded.redirect_uris,
			scopes_json = excluded.scopes_json,
			login_theme_json = excluded.login_theme_json
	`, rec.ID, rec.Name, rec.Description, rec.ClientID, rec.EncryptedSecret, rec.RedirectUrisJSON, rec.ScopesJSON, rec.LoginThemeJSON, rec.CreatedAt)
	return err
}

func (r *SQLRepository) DeleteApplication(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM oauth_applications WHERE id = ?`, id)
	return err
}

// ============================================================================
// Social Connectors
// ============================================================================

func (r *SQLRepository) ListConnectors(ctx context.Context) ([]SocialConnectorRecord, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, provider, display_name, enabled, sort_order, client_id,
		       encrypted_secret, COALESCE(secret_masked, ''), extra_json, COALESCE(updated_at, 0)
		FROM social_connectors
		ORDER BY sort_order ASC, id ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]SocialConnectorRecord, 0)
	for rows.Next() {
		var rec SocialConnectorRecord
		var enabledInt int
		if err := rows.Scan(
			&rec.ID, &rec.Provider, &rec.DisplayName, &enabledInt, &rec.SortOrder,
			&rec.ClientID, &rec.EncryptedSecret, &rec.SecretMasked, &rec.ExtraJSON, &rec.UpdatedAt,
		); err != nil {
			return nil, err
		}
		rec.Enabled = enabledInt != 0
		out = append(out, rec)
	}
	return out, rows.Err()
}

func (r *SQLRepository) UpsertConnector(ctx context.Context, rec SocialConnectorRecord) error {
	enabledInt := 0
	if rec.Enabled {
		enabledInt = 1
	}
	if r.driver == "mysql" {
		_, err := r.db.ExecContext(ctx, `
			INSERT INTO social_connectors
			(id, provider, display_name, enabled, sort_order, client_id, encrypted_secret, secret_masked, extra_json, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE
				provider = VALUES(provider),
				display_name = VALUES(display_name),
				enabled = VALUES(enabled),
				sort_order = VALUES(sort_order),
				client_id = VALUES(client_id),
				encrypted_secret = VALUES(encrypted_secret),
				secret_masked = VALUES(secret_masked),
				extra_json = VALUES(extra_json),
				updated_at = VALUES(updated_at)
		`, rec.ID, rec.Provider, rec.DisplayName, enabledInt, rec.SortOrder, rec.ClientID, rec.EncryptedSecret, rec.SecretMasked, rec.ExtraJSON, rec.UpdatedAt)
		return err
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO social_connectors
		(id, provider, display_name, enabled, sort_order, client_id, encrypted_secret, secret_masked, extra_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			provider = excluded.provider,
			display_name = excluded.display_name,
			enabled = excluded.enabled,
			sort_order = excluded.sort_order,
			client_id = excluded.client_id,
			encrypted_secret = excluded.encrypted_secret,
			secret_masked = excluded.secret_masked,
			extra_json = excluded.extra_json,
			updated_at = excluded.updated_at
	`, rec.ID, rec.Provider, rec.DisplayName, enabledInt, rec.SortOrder, rec.ClientID, rec.EncryptedSecret, rec.SecretMasked, rec.ExtraJSON, rec.UpdatedAt)
	return err
}

func (r *SQLRepository) DeleteConnector(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM social_connectors WHERE id = ?`, id)
	return err
}

func (r *SQLRepository) UpdateConnectorOrders(ctx context.Context, orderedIDs []string) error {
	for idx, id := range orderedIDs {
		if _, err := r.db.ExecContext(ctx, `UPDATE social_connectors SET sort_order = ? WHERE id = ?`, idx, id); err != nil {
			return err
		}
	}
	return nil
}

// ============================================================================
// Users & User Identities
// ============================================================================

func (r *SQLRepository) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, email, email_verified, display_name, COALESCE(role, 'member'),
		       COALESCE(password_hash, ''), totp_enabled, COALESCE(totp_secret_enc, ''),
		       COALESCE(recovery_hashes, ''), status, created_at, COALESCE(last_login_at, 0)
		FROM users
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]User, 0)
	for rows.Next() {
		var u User
		var verifiedInt, totpInt int
		if err := rows.Scan(
			&u.ID, &u.Email, &verifiedInt, &u.DisplayName, &u.Role,
			&u.PasswordHash, &totpInt, &u.TotpSecretEnc, &u.RecoveryHashes,
			&u.Status, &u.CreatedAt, &u.LastLoginAt,
		); err != nil {
			return nil, err
		}
		u.EmailVerified = verifiedInt != 0
		u.TotpEnabled = totpInt != 0
		if u.Role == "" {
			u.Role = "member"
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (r *SQLRepository) UpsertUser(ctx context.Context, u User) error {
	verifiedInt := 0
	if u.EmailVerified {
		verifiedInt = 1
	}
	totpInt := 0
	if u.TotpEnabled {
		totpInt = 1
	}
	role := u.Role
	if role != "super_admin" {
		role = "member"
	}
	if r.driver == "mysql" {
		_, err := r.db.ExecContext(ctx, `
			INSERT INTO users
			(id, email, email_verified, display_name, role, password_hash, totp_enabled, totp_secret_enc, recovery_hashes, status, created_at, last_login_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE
				email = VALUES(email),
				email_verified = VALUES(email_verified),
				display_name = VALUES(display_name),
				role = VALUES(role),
				password_hash = VALUES(password_hash),
				totp_enabled = VALUES(totp_enabled),
				totp_secret_enc = VALUES(totp_secret_enc),
				recovery_hashes = VALUES(recovery_hashes),
				status = VALUES(status),
				last_login_at = VALUES(last_login_at)
		`, u.ID, u.Email, verifiedInt, u.DisplayName, role, u.PasswordHash, totpInt, u.TotpSecretEnc, u.RecoveryHashes, u.Status, u.CreatedAt, u.LastLoginAt)
		return err
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO users
		(id, email, email_verified, display_name, role, password_hash, totp_enabled, totp_secret_enc, recovery_hashes, status, created_at, last_login_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			email = excluded.email,
			email_verified = excluded.email_verified,
			display_name = excluded.display_name,
			role = excluded.role,
			password_hash = excluded.password_hash,
			totp_enabled = excluded.totp_enabled,
			totp_secret_enc = excluded.totp_secret_enc,
			recovery_hashes = excluded.recovery_hashes,
			status = excluded.status,
			last_login_at = excluded.last_login_at
	`, u.ID, u.Email, verifiedInt, u.DisplayName, role, u.PasswordHash, totpInt, u.TotpSecretEnc, u.RecoveryHashes, u.Status, u.CreatedAt, u.LastLoginAt)
	return err
}

func (r *SQLRepository) DeleteUser(ctx context.Context, id string) error {
	if _, err := r.db.ExecContext(ctx, `DELETE FROM passkey_credentials WHERE user_id = ?`, id); err != nil {
		return err
	}
	if _, err := r.db.ExecContext(ctx, `DELETE FROM user_identities WHERE user_id = ?`, id); err != nil {
		return err
	}
	_, err := r.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, id)
	return err
}

func (r *SQLRepository) ListUserIdentities(ctx context.Context) ([]UserIdentity, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, user_id, provider, COALESCE(provider_label, ''), provider_sub, email, COALESCE(credential_pub, ''), linked_at
		FROM user_identities
		ORDER BY linked_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]UserIdentity, 0)
	for rows.Next() {
		var ident UserIdentity
		if err := rows.Scan(
			&ident.ID, &ident.UserID, &ident.Provider, &ident.ProviderLabel,
			&ident.ProviderSub, &ident.Email, &ident.CredentialPub, &ident.LinkedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, ident)
	}
	return out, rows.Err()
}

func (r *SQLRepository) UpsertUserIdentity(ctx context.Context, ident UserIdentity) error {
	if r.driver == "mysql" {
		_, err := r.db.ExecContext(ctx, `
			INSERT INTO user_identities (id, user_id, provider, provider_label, provider_sub, email, credential_pub, linked_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE
				provider_label = VALUES(provider_label),
				email = VALUES(email),
				credential_pub = VALUES(credential_pub)
		`, ident.ID, ident.UserID, ident.Provider, ident.ProviderLabel, ident.ProviderSub, ident.Email, ident.CredentialPub, ident.LinkedAt)
		return err
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO user_identities (id, user_id, provider, provider_label, provider_sub, email, credential_pub, linked_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			provider_label = excluded.provider_label,
			email = excluded.email,
			credential_pub = excluded.credential_pub
	`, ident.ID, ident.UserID, ident.Provider, ident.ProviderLabel, ident.ProviderSub, ident.Email, ident.CredentialPub, ident.LinkedAt)
	return err
}

func (r *SQLRepository) DeleteUserIdentity(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM user_identities WHERE id = ?`, id)
	return err
}

// ============================================================================
// Passkey (WebAuthn) Credentials
// ============================================================================

func (r *SQLRepository) ListPasskeys(ctx context.Context) ([]PasskeyCredential, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, user_id, credential_id, public_key_spki, algorithm, label, rp_id, sign_count, created_at, last_used_at
		FROM passkey_credentials
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]PasskeyCredential, 0)
	for rows.Next() {
		var pk PasskeyCredential
		var sc int64
		if err := rows.Scan(
			&pk.ID, &pk.UserID, &pk.CredentialID, &pk.PublicKeySPKI,
			&pk.Algorithm, &pk.Label, &pk.RPID, &sc, &pk.CreatedAt, &pk.LastUsedAt,
		); err != nil {
			return nil, err
		}
		if sc >= 0 {
			pk.SignCount = uint32(sc)
		}
		out = append(out, pk)
	}
	return out, rows.Err()
}

func (r *SQLRepository) InsertPasskey(ctx context.Context, pk PasskeyCredential) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO passkey_credentials
		(id, user_id, credential_id, public_key_spki, algorithm, label, rp_id, sign_count, created_at, last_used_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, pk.ID, pk.UserID, pk.CredentialID, pk.PublicKeySPKI, pk.Algorithm, pk.Label, pk.RPID, int64(pk.SignCount), pk.CreatedAt, pk.LastUsedAt)
	return err
}

func (r *SQLRepository) UpdatePasskeyUsage(ctx context.Context, id string, signCount uint32, lastUsedAt int64) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE passkey_credentials SET sign_count = ?, last_used_at = ? WHERE id = ?`,
		int64(signCount), lastUsedAt, id,
	)
	return err
}

func (r *SQLRepository) DeletePasskey(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM passkey_credentials WHERE id = ?`, id)
	return err
}

// ============================================================================
// Webhooks
// ============================================================================

func (r *SQLRepository) ListWebhooks(ctx context.Context) ([]WebhookRecord, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, COALESCE(name, ''), target_url, signing_secret_enc, COALESCE(secret_masked, ''), events, enabled, created_at
		FROM webhooks
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]WebhookRecord, 0)
	for rows.Next() {
		var wh WebhookRecord
		var enabledInt int
		if err := rows.Scan(
			&wh.ID, &wh.Name, &wh.TargetURL, &wh.SigningSecretEnc,
			&wh.SecretMasked, &wh.EventsJSON, &enabledInt, &wh.CreatedAt,
		); err != nil {
			return nil, err
		}
		wh.Enabled = enabledInt != 0
		out = append(out, wh)
	}
	return out, rows.Err()
}

func (r *SQLRepository) UpsertWebhook(ctx context.Context, wh WebhookRecord) error {
	enabledInt := 0
	if wh.Enabled {
		enabledInt = 1
	}
	if r.driver == "mysql" {
		_, err := r.db.ExecContext(ctx, `
			INSERT INTO webhooks (id, name, target_url, signing_secret_enc, secret_masked, events, enabled, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE
				name = VALUES(name),
				target_url = VALUES(target_url),
				signing_secret_enc = VALUES(signing_secret_enc),
				secret_masked = VALUES(secret_masked),
				events = VALUES(events),
				enabled = VALUES(enabled)
		`, wh.ID, wh.Name, wh.TargetURL, wh.SigningSecretEnc, wh.SecretMasked, wh.EventsJSON, enabledInt, wh.CreatedAt)
		return err
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO webhooks (id, name, target_url, signing_secret_enc, secret_masked, events, enabled, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			target_url = excluded.target_url,
			signing_secret_enc = excluded.signing_secret_enc,
			secret_masked = excluded.secret_masked,
			events = excluded.events,
			enabled = excluded.enabled
	`, wh.ID, wh.Name, wh.TargetURL, wh.SigningSecretEnc, wh.SecretMasked, wh.EventsJSON, enabledInt, wh.CreatedAt)
	return err
}

func (r *SQLRepository) DeleteWebhook(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM webhooks WHERE id = ?`, id)
	return err
}

// ============================================================================
// Persistent Admin Sessions (backed by sys_caches)
// ============================================================================

func (r *SQLRepository) SaveSession(ctx context.Context, token, payloadJSON string, expiresAt int64) error {
	key := "sess:" + token
	if r.driver == "mysql" {
		_, err := r.db.ExecContext(ctx, `
			INSERT INTO sys_caches (cache_key, cache_value, expires_at) VALUES (?, ?, ?)
			ON DUPLICATE KEY UPDATE cache_value = VALUES(cache_value), expires_at = VALUES(expires_at)
		`, key, payloadJSON, expiresAt)
		return err
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO sys_caches (cache_key, cache_value, expires_at) VALUES (?, ?, ?)
		ON CONFLICT(cache_key) DO UPDATE SET cache_value = excluded.cache_value, expires_at = excluded.expires_at
	`, key, payloadJSON, expiresAt)
	return err
}

func (r *SQLRepository) LoadSession(ctx context.Context, token string) (string, bool, error) {
	var val string
	var expiresAt int64
	err := r.db.QueryRowContext(ctx, `SELECT cache_value, expires_at FROM sys_caches WHERE cache_key = ?`, "sess:"+token).Scan(&val, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if time.Now().UTC().Unix() > expiresAt {
		_, _ = r.db.ExecContext(ctx, `DELETE FROM sys_caches WHERE cache_key = ?`, "sess:"+token)
		return "", false, nil
	}
	return val, true, nil
}

func (r *SQLRepository) DeleteSession(ctx context.Context, token string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM sys_caches WHERE cache_key = ?`, "sess:"+token)
	return err
}
