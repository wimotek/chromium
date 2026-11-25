package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	_ "modernc.org/sqlite"
)

//go:embed sql/*.sql
var schemaFS embed.FS

// Driver identifies the active relational backend.
type Driver string

const (
	DriverSQLite Driver = "sqlite"
	DriverMySQL  Driver = "mysql"
)

// Store provides dual-mode SQLite/MySQL persistence with SQLite read/write separation
// and automatic deadlock/busy transaction retries.
type Store struct {
	Driver  Driver
	WriteDB *sql.DB
	ReadDB  *sql.DB
}

// AuthorityRecord stores an encrypted CA certificate & private key pair.
type AuthorityRecord struct {
	Tier              string `json:"tier"`
	SubjectDN         string `json:"subject_dn"`
	SerialHex         string `json:"serial_hex"`
	FingerprintSHA256 string `json:"fingerprint_sha256"`
	CertPEM           string `json:"cert_pem"`
	KeyPEMEnc         string `json:"-"`
	NotBefore         int64  `json:"not_before"`
	NotAfter          int64  `json:"not_after"`
	CreatedAt         int64  `json:"created_at"`
}

// CertificateRecord represents an issued end-entity certificate.
type CertificateRecord struct {
	SerialHex         string `json:"serial_hex"`
	Profile           string `json:"profile"`
	CommonName        string `json:"common_name"`
	SubjectDN         string `json:"subject_dn"`
	SANsJSON          string `json:"sans_json"`
	EKUOIDsJSON       string `json:"eku_oids_json"`
	UPN               string `json:"upn"`
	KeyMode           string `json:"key_mode"`
	FingerprintSHA256 string `json:"fingerprint_sha256"`
	CertPEM           string `json:"cert_pem"`
	Status            string `json:"status"`
	RevokedAt         int64  `json:"revoked_at"`
	RevocationReason  int    `json:"revocation_reason"`
	NotBefore         int64  `json:"not_before"`
	NotAfter          int64  `json:"not_after"`
	IssuedBy          string `json:"issued_by"`
	CreatedAt         int64  `json:"created_at"`
}

// AdminAuthRecord stores persistent admin password hash and lockout counters.
type AdminAuthRecord struct {
	Username       string
	PasswordHash   string
	FailedAttempts int
	LockedUntil    int64
	UpdatedAt      int64
}

// ProvisionerRecord stores Step-CA / OpenBao automation credentials.
type ProvisionerRecord struct {
	ID                  string `json:"id"`
	Name                string `json:"name"`
	Protocol            string `json:"protocol"`
	TokenHash           string `json:"-"`
	TokenPrefix         string `json:"token_prefix"`
	AllowedProfilesJSON string `json:"allowed_profiles_json"`
	MaxTTLDays          int    `json:"max_ttl_days"`
	Enabled             bool   `json:"enabled"`
	CreatedAt           int64  `json:"created_at"`
}

// AuditRecord stores an immutable security audit entry.
type AuditRecord struct {
	ID           string `json:"id"`
	Actor        string `json:"actor"`
	Action       string `json:"action"`
	TargetSerial string `json:"target_serial"`
	ClientIP     string `json:"client_ip"`
	DetailJSON   string `json:"detail_json"`
	CreatedAt    int64  `json:"created_at"`
}

// Open initializes either SQLite (with strict WriteDB/ReadDB split) or MySQL.
func Open(driverName, dsn string) (*Store, error) {
	drv := Driver(strings.ToLower(strings.TrimSpace(driverName)))
	if drv == "" {
		drv = DriverSQLite
	}

	s := &Store{Driver: drv}

	switch drv {
	case DriverSQLite:
		if dsn == "" {
			dsn = "./data/wimotek-ca.db"
		}
		if !strings.HasPrefix(dsn, "file:") && dsn != ":memory:" {
			if err := os.MkdirAll(filepath.Dir(dsn), 0o750); err != nil {
				return nil, fmt.Errorf("create sqlite data dir: %w", err)
			}
		}

		writeDSN := buildSQLiteDSN(dsn, true)
		readDSN := buildSQLiteDSN(dsn, false)

		writeDB, err := sql.Open("sqlite", writeDSN)
		if err != nil {
			return nil, fmt.Errorf("open sqlite write db: %w", err)
		}
		// Strictly enforce MaxOpenConns=1 on WriteDB to avoid SQLITE_BUSY write contention.
		writeDB.SetMaxOpenConns(1)
		writeDB.SetMaxIdleConns(1)
		writeDB.SetConnMaxLifetime(0)

		if err := configureSQLitePragmas(writeDB, true); err != nil {
			_ = writeDB.Close()
			return nil, err
		}

		readDB, err := sql.Open("sqlite", readDSN)
		if err != nil {
			_ = writeDB.Close()
			return nil, fmt.Errorf("open sqlite read db: %w", err)
		}
		readConns := runtime.NumCPU() * 2
		if readConns < 4 {
			readConns = 4
		}
		readDB.SetMaxOpenConns(readConns)
		readDB.SetMaxIdleConns(readConns)
		readDB.SetConnMaxLifetime(5 * time.Minute)

		if err := configureSQLitePragmas(readDB, false); err != nil {
			_ = writeDB.Close()
			_ = readDB.Close()
			return nil, err
		}

		s.WriteDB = writeDB
		s.ReadDB = readDB

	case DriverMySQL:
		if dsn == "" {
			return nil, errors.New("CA_DB_DSN is required for mysql driver")
		}
		db, err := sql.Open("mysql", dsn)
		if err != nil {
			return nil, fmt.Errorf("open mysql db: %w", err)
		}
		db.SetMaxOpenConns(25)
		db.SetMaxIdleConns(10)
		db.SetConnMaxLifetime(5 * time.Minute)
		if err := db.Ping(); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("ping mysql db: %w", err)
		}
		s.WriteDB = db
		s.ReadDB = db

	default:
		return nil, fmt.Errorf("unsupported database driver: %s", driverName)
	}

	if err := s.migrate(context.Background()); err != nil {
		_ = s.Close()
		return nil, err
	}

	return s, nil
}

func buildSQLiteDSN(raw string, isWrite bool) string {
	if raw == ":memory:" {
		if isWrite {
			return "file:wimotek_mem?mode=memory&cache=shared&_txlock=immediate&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
		}
		return "file:wimotek_mem?mode=memory&cache=shared&_pragma=busy_timeout(5000)"
	}

	base := raw
	if !strings.HasPrefix(base, "file:") {
		base = "file:" + filepath.ToSlash(base)
	}

	parts := strings.SplitN(base, "?", 2)
	q := url.Values{}
	if len(parts) == 2 {
		parsed, err := url.ParseQuery(parts[1])
		if err == nil {
			q = parsed
		}
	}

	q.Add("_pragma", "busy_timeout(5000)")
	if isWrite {
		q.Set("_txlock", "immediate")
		q.Add("_pragma", "journal_mode(WAL)")
		q.Add("_pragma", "synchronous(NORMAL)")
		q.Add("_pragma", "foreign_keys(ON)")
	} else {
		q.Add("_pragma", "query_only(ON)")
	}

	return parts[0] + "?" + q.Encode()
}

func configureSQLitePragmas(db *sql.DB, isWrite bool) error {
	if isWrite {
		pragmas := []string{
			"PRAGMA journal_mode=WAL;",
			"PRAGMA busy_timeout=5000;",
			"PRAGMA synchronous=NORMAL;",
			"PRAGMA foreign_keys=ON;",
		}
		for _, p := range pragmas {
			if _, err := db.Exec(p); err != nil {
				return fmt.Errorf("apply sqlite write pragma %q: %w", p, err)
			}
		}
		return nil
	}
	if _, err := db.Exec("PRAGMA busy_timeout=5000;"); err != nil {
		return fmt.Errorf("apply sqlite read pragma: %w", err)
	}
	return nil
}

func (s *Store) migrate(ctx context.Context) error {
	file := "sql/sqlite.sql"
	if s.Driver == DriverMySQL {
		file = "sql/mysql.sql"
	}
	raw, err := schemaFS.ReadFile(file)
	if err != nil {
		return fmt.Errorf("read embedded schema %s: %w", file, err)
	}

	stmts := splitSQLStatements(string(raw))
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		for _, stmt := range stmts {
			if _, err := tx.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("execute migration statement: %w", err)
			}
		}
		return nil
	})
}

func splitSQLStatements(sqlText string) []string {
	lines := strings.Split(sqlText, "\n")
	var cleaned strings.Builder
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}
		cleaned.WriteString(line)
		cleaned.WriteByte('\n')
	}
	rawStmts := strings.Split(cleaned.String(), ";")
	var out []string
	for _, st := range rawStmts {
		s := strings.TrimSpace(st)
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// Close closes both WriteDB and ReadDB pools cleanly.
func (s *Store) Close() error {
	var firstErr error
	if s.ReadDB != nil && s.ReadDB != s.WriteDB {
		if err := s.ReadDB.Close(); err != nil {
			firstErr = err
		}
	}
	if s.WriteDB != nil {
		if err := s.WriteDB.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// WithTx executes fn inside a write transaction with automatic retries on
// SQLITE_BUSY and MySQL deadlock / lock wait timeout errors (1213, 1205).
func (s *Store) WithTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	const maxAttempts = 6
	backoff := 25 * time.Millisecond

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		tx, err := s.WriteDB.BeginTx(ctx, nil)
		if err != nil {
			if isRetryableLockErr(err) && attempt < maxAttempts {
				sleepWithContext(ctx, backoff)
				backoff *= 2
				continue
			}
			return err
		}

		err = fn(tx)
		if err != nil {
			_ = tx.Rollback()
			if isRetryableLockErr(err) && attempt < maxAttempts {
				sleepWithContext(ctx, backoff)
				backoff *= 2
				continue
			}
			return err
		}

		if err = tx.Commit(); err != nil {
			if isRetryableLockErr(err) && attempt < maxAttempts {
				sleepWithContext(ctx, backoff)
				backoff *= 2
				continue
			}
			return err
		}
		return nil
	}
	return errors.New("transaction failed after maximum retry attempts")
}

func isRetryableLockErr(err error) bool {
	if err == nil {
		return false
	}
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		return mysqlErr.Number == 1213 || mysqlErr.Number == 1205
	}
	msg := strings.ToUpper(err.Error())
	return strings.Contains(msg, "SQLITE_BUSY") ||
		strings.Contains(msg, "SQLITE_LOCKED") ||
		strings.Contains(msg, "DATABASE IS LOCKED") ||
		strings.Contains(msg, "DEADLOCK") ||
		strings.Contains(msg, "LOCK WAIT TIMEOUT")
}

func sleepWithContext(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// GenerateSerial128 produces an RFC 5280 compliant 128-bit positive CSPRNG certificate serial number.
func GenerateSerial128() (*big.Int, string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return nil, "", fmt.Errorf("csprng serial generation: %w", err)
	}
	// Clear MSB to ensure positive ASN.1 INTEGER without extra 0x00 prefix byte; set bit 6 to avoid leading zero collapse.
	b[0] = (b[0] & 0x7F) | 0x40
	serial := new(big.Int).SetBytes(b)
	return serial, strings.ToUpper(hex.EncodeToString(b)), nil
}

// GenerateRandomID creates a URL-safe random hex identifier.
func GenerateRandomID(byteLen int) string {
	b := make([]byte, byteLen)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// UpsertAuthority persists Root or Issuing CA record via WithTx.
func (s *Store) UpsertAuthority(ctx context.Context, rec AuthorityRecord) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		if s.Driver == DriverMySQL {
			_, err := tx.ExecContext(ctx, `
				INSERT INTO ca_authorities (tier, subject_dn, serial_hex, fingerprint_sha256, cert_pem, key_pem_enc, not_before, not_after, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON DUPLICATE KEY UPDATE
					subject_dn=VALUES(subject_dn), serial_hex=VALUES(serial_hex), fingerprint_sha256=VALUES(fingerprint_sha256),
					cert_pem=VALUES(cert_pem), key_pem_enc=VALUES(key_pem_enc), not_before=VALUES(not_before), not_after=VALUES(not_after)
			`, rec.Tier, rec.SubjectDN, rec.SerialHex, rec.FingerprintSHA256, rec.CertPEM, rec.KeyPEMEnc, rec.NotBefore, rec.NotAfter, rec.CreatedAt)
			return err
		}
		_, err := tx.ExecContext(ctx, `
			INSERT INTO ca_authorities (tier, subject_dn, serial_hex, fingerprint_sha256, cert_pem, key_pem_enc, not_before, not_after, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(tier) DO UPDATE SET
				subject_dn=excluded.subject_dn, serial_hex=excluded.serial_hex, fingerprint_sha256=excluded.fingerprint_sha256,
				cert_pem=excluded.cert_pem, key_pem_enc=excluded.key_pem_enc, not_before=excluded.not_before, not_after=excluded.not_after
		`, rec.Tier, rec.SubjectDN, rec.SerialHex, rec.FingerprintSHA256, rec.CertPEM, rec.KeyPEMEnc, rec.NotBefore, rec.NotAfter, rec.CreatedAt)
		return err
	})
}

// GetAuthority reads a CA record from ReadDB.
func (s *Store) GetAuthority(ctx context.Context, tier string) (*AuthorityRecord, error) {
	row := s.ReadDB.QueryRowContext(ctx, `
		SELECT tier, subject_dn, serial_hex, fingerprint_sha256, cert_pem, key_pem_enc, not_before, not_after, created_at
		FROM ca_authorities WHERE tier = ?
	`, tier)
	var rec AuthorityRecord
	if err := row.Scan(&rec.Tier, &rec.SubjectDN, &rec.SerialHex, &rec.FingerprintSHA256, &rec.CertPEM, &rec.KeyPEMEnc, &rec.NotBefore, &rec.NotAfter, &rec.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &rec, nil
}

// InsertCertificate inserts an issued certificate inside WithTx.
func (s *Store) InsertCertificate(ctx context.Context, rec CertificateRecord) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO certificates (
				serial_hex, profile, common_name, subject_dn, sans_json, eku_oids_json, upn,
				key_mode, fingerprint_sha256, cert_pem, status, revoked_at, revocation_reason,
				not_before, not_after, issued_by, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, rec.SerialHex, rec.Profile, rec.CommonName, rec.SubjectDN, rec.SANsJSON, rec.EKUOIDsJSON, rec.UPN,
			rec.KeyMode, rec.FingerprintSHA256, rec.CertPEM, rec.Status, rec.RevokedAt, rec.RevocationReason,
			rec.NotBefore, rec.NotAfter, rec.IssuedBy, rec.CreatedAt)
		return err
	})
}

// ListCertificates reads all certificates ordered by created_at DESC from ReadDB.
func (s *Store) ListCertificates(ctx context.Context) ([]CertificateRecord, error) {
	rows, err := s.ReadDB.QueryContext(ctx, `
		SELECT serial_hex, profile, common_name, subject_dn, sans_json, eku_oids_json, upn,
		       key_mode, fingerprint_sha256, cert_pem, status, revoked_at, revocation_reason,
		       not_before, not_after, issued_by, created_at
		FROM certificates ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []CertificateRecord
	for rows.Next() {
		var r CertificateRecord
		if err := rows.Scan(
			&r.SerialHex, &r.Profile, &r.CommonName, &r.SubjectDN, &r.SANsJSON, &r.EKUOIDsJSON, &r.UPN,
			&r.KeyMode, &r.FingerprintSHA256, &r.CertPEM, &r.Status, &r.RevokedAt, &r.RevocationReason,
			&r.NotBefore, &r.NotAfter, &r.IssuedBy, &r.CreatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetCertificate fetches a single certificate by hex serial from ReadDB.
func (s *Store) GetCertificate(ctx context.Context, serialHex string) (*CertificateRecord, error) {
	row := s.ReadDB.QueryRowContext(ctx, `
		SELECT serial_hex, profile, common_name, subject_dn, sans_json, eku_oids_json, upn,
		       key_mode, fingerprint_sha256, cert_pem, status, revoked_at, revocation_reason,
		       not_before, not_after, issued_by, created_at
		FROM certificates WHERE serial_hex = ?
	`, strings.ToUpper(strings.TrimSpace(serialHex)))
	var r CertificateRecord
	if err := row.Scan(
		&r.SerialHex, &r.Profile, &r.CommonName, &r.SubjectDN, &r.SANsJSON, &r.EKUOIDsJSON, &r.UPN,
		&r.KeyMode, &r.FingerprintSHA256, &r.CertPEM, &r.Status, &r.RevokedAt, &r.RevocationReason,
		&r.NotBefore, &r.NotAfter, &r.IssuedBy, &r.CreatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &r, nil
}

// RevokeCertificate marks a certificate revoked atomically inside WithTx.
func (s *Store) RevokeCertificate(ctx context.Context, serialHex string, reason int, revokedAt int64) (bool, error) {
	var updated bool
	err := s.WithTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `
			UPDATE certificates
			SET status = 'revoked', revoked_at = ?, revocation_reason = ?
			WHERE serial_hex = ? AND status != 'revoked'
		`, revokedAt, reason, strings.ToUpper(strings.TrimSpace(serialHex)))
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		updated = n > 0
		return nil
	})
	return updated, err
}

// ListRevokedCertificates fetches all revoked entries for CRL compilation.
func (s *Store) ListRevokedCertificates(ctx context.Context) ([]CertificateRecord, error) {
	rows, err := s.ReadDB.QueryContext(ctx, `
		SELECT serial_hex, profile, common_name, subject_dn, sans_json, eku_oids_json, upn,
		       key_mode, fingerprint_sha256, cert_pem, status, revoked_at, revocation_reason,
		       not_before, not_after, issued_by, created_at
		FROM certificates WHERE status = 'revoked' ORDER BY revoked_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []CertificateRecord
	for rows.Next() {
		var r CertificateRecord
		if err := rows.Scan(
			&r.SerialHex, &r.Profile, &r.CommonName, &r.SubjectDN, &r.SANsJSON, &r.EKUOIDsJSON, &r.UPN,
			&r.KeyMode, &r.FingerprintSHA256, &r.CertPEM, &r.Status, &r.RevokedAt, &r.RevocationReason,
			&r.NotBefore, &r.NotAfter, &r.IssuedBy, &r.CreatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetAdminAuth returns the admin record for a username.
func (s *Store) GetAdminAuth(ctx context.Context, username string) (*AdminAuthRecord, error) {
	row := s.ReadDB.QueryRowContext(ctx, `
		SELECT username, password_hash, failed_attempts, locked_until, updated_at
		FROM admin_auth WHERE username = ?
	`, username)
	var r AdminAuthRecord
	if err := row.Scan(&r.Username, &r.PasswordHash, &r.FailedAttempts, &r.LockedUntil, &r.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &r, nil
}

// UpsertAdminAuth creates or updates an admin auth record via WithTx.
func (s *Store) UpsertAdminAuth(ctx context.Context, rec AdminAuthRecord) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		if s.Driver == DriverMySQL {
			_, err := tx.ExecContext(ctx, `
				INSERT INTO admin_auth (username, password_hash, failed_attempts, locked_until, updated_at)
				VALUES (?, ?, ?, ?, ?)
				ON DUPLICATE KEY UPDATE
					password_hash=VALUES(password_hash), failed_attempts=VALUES(failed_attempts),
					locked_until=VALUES(locked_until), updated_at=VALUES(updated_at)
			`, rec.Username, rec.PasswordHash, rec.FailedAttempts, rec.LockedUntil, rec.UpdatedAt)
			return err
		}
		_, err := tx.ExecContext(ctx, `
			INSERT INTO admin_auth (username, password_hash, failed_attempts, locked_until, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(username) DO UPDATE SET
				password_hash=excluded.password_hash, failed_attempts=excluded.failed_attempts,
				locked_until=excluded.locked_until, updated_at=excluded.updated_at
		`, rec.Username, rec.PasswordHash, rec.FailedAttempts, rec.LockedUntil, rec.UpdatedAt)
		return err
	})
}

// RecordAuthFailure atomically increments failed_attempts and locks for 15 minutes at >= 5 failures.
func (s *Store) RecordAuthFailure(ctx context.Context, username string, now int64) (int, int64, error) {
	var attempts int
	var lockedUntil int64
	err := s.WithTx(ctx, func(tx *sql.Tx) error {
		var currentAttempts int
		var currentLocked int64
		var hash string
		err := tx.QueryRowContext(ctx, `SELECT password_hash, failed_attempts, locked_until FROM admin_auth WHERE username = ?`, username).
			Scan(&hash, &currentAttempts, &currentLocked)
		if errors.Is(err, sql.ErrNoRows) {
			attempts = 1
			lockedUntil = 0
			_, err = tx.ExecContext(ctx, `
				INSERT INTO admin_auth (username, password_hash, failed_attempts, locked_until, updated_at)
				VALUES (?, '', ?, ?, ?)
			`, username, attempts, lockedUntil, now)
			return err
		}
		if err != nil {
			return err
		}
		if currentLocked > 0 && currentLocked <= now {
			currentAttempts = 0
			currentLocked = 0
		}
		attempts = currentAttempts + 1
		lockedUntil = currentLocked
		if attempts >= 5 {
			lockedUntil = now + 900 // 15 minutes lockout
		}
		_, err = tx.ExecContext(ctx, `
			UPDATE admin_auth SET failed_attempts = ?, locked_until = ?, updated_at = ?
			WHERE username = ?
		`, attempts, lockedUntil, now, username)
		return err
	})
	return attempts, lockedUntil, err
}

// ResetAuthFailures clears failure counters after successful login.
func (s *Store) ResetAuthFailures(ctx context.Context, username string, now int64) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE admin_auth SET failed_attempts = 0, locked_until = 0, updated_at = ?
			WHERE username = ?
		`, now, username)
		return err
	})
}

// InsertProvisioner saves a new automation provisioner token record.
func (s *Store) InsertProvisioner(ctx context.Context, rec ProvisionerRecord) error {
	enabled := 0
	if rec.Enabled {
		enabled = 1
	}
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO provisioners (id, name, protocol, token_hash, token_prefix, allowed_profiles_json, max_ttl_days, enabled, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, rec.ID, rec.Name, rec.Protocol, rec.TokenHash, rec.TokenPrefix, rec.AllowedProfilesJSON, rec.MaxTTLDays, enabled, rec.CreatedAt)
		return err
	})
}

// ListProvisioners returns all automation provisioners.
func (s *Store) ListProvisioners(ctx context.Context) ([]ProvisionerRecord, error) {
	rows, err := s.ReadDB.QueryContext(ctx, `
		SELECT id, name, protocol, token_hash, token_prefix, allowed_profiles_json, max_ttl_days, enabled, created_at
		FROM provisioners ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProvisionerRecord
	for rows.Next() {
		var r ProvisionerRecord
		var enabled int
		if err := rows.Scan(&r.ID, &r.Name, &r.Protocol, &r.TokenHash, &r.TokenPrefix, &r.AllowedProfilesJSON, &r.MaxTTLDays, &enabled, &r.CreatedAt); err != nil {
			return nil, err
		}
		r.Enabled = enabled == 1
		out = append(out, r)
	}
	return out, rows.Err()
}

// FindProvisionerByHash looks up an enabled provisioner by SHA-256 token hash.
func (s *Store) FindProvisionerByHash(ctx context.Context, tokenHash string) (*ProvisionerRecord, error) {
	row := s.ReadDB.QueryRowContext(ctx, `
		SELECT id, name, protocol, token_hash, token_prefix, allowed_profiles_json, max_ttl_days, enabled, created_at
		FROM provisioners WHERE token_hash = ? AND enabled = 1
	`, tokenHash)
	var r ProvisionerRecord
	var enabled int
	if err := row.Scan(&r.ID, &r.Name, &r.Protocol, &r.TokenHash, &r.TokenPrefix, &r.AllowedProfilesJSON, &r.MaxTTLDays, &enabled, &r.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	r.Enabled = enabled == 1
	return &r, nil
}

// DeleteProvisioner removes a provisioner by ID.
func (s *Store) DeleteProvisioner(ctx context.Context, id string) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM provisioners WHERE id = ?`, id)
		return err
	})
}

// AppendAudit writes a new audit entry via WithTx.
func (s *Store) AppendAudit(ctx context.Context, rec AuditRecord) error {
	if rec.ID == "" {
		rec.ID = GenerateRandomID(12)
	}
	if rec.CreatedAt == 0 {
		rec.CreatedAt = time.Now().Unix()
	}
	if rec.DetailJSON == "" {
		rec.DetailJSON = "{}"
	}
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO audit_logs (id, actor, action, target_serial, client_ip, detail_json, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`, rec.ID, rec.Actor, rec.Action, rec.TargetSerial, rec.ClientIP, rec.DetailJSON, rec.CreatedAt)
		return err
	})
}

// ListAudits returns the latest audit logs ordered by created_at DESC.
func (s *Store) ListAudits(ctx context.Context, limit int) ([]AuditRecord, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.ReadDB.QueryContext(ctx, `
		SELECT id, actor, action, target_serial, client_ip, detail_json, created_at
		FROM audit_logs ORDER BY created_at DESC LIMIT ?
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditRecord
	for rows.Next() {
		var r AuditRecord
		if err := rows.Scan(&r.ID, &r.Actor, &r.Action, &r.TargetSerial, &r.ClientIP, &r.DetailJSON, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
