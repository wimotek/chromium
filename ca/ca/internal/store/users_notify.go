package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	RoleAdmin    = "admin"
	RoleOperator = "operator"
	RoleStandard = "standard"
	RoleBasic    = "basic"
)

// ErrQuotaExceeded is returned atomically inside WithTx when a user reaches their active certificate quota.
var ErrQuotaExceeded = errors.New("certificate quota exceeded for your account tier")

// DefaultQuotaForRole returns the default active certificate quota (-1 means unlimited).
func DefaultQuotaForRole(role string) int {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case RoleAdmin:
		return -1
	case RoleOperator:
		return 50
	case RoleBasic:
		return 3
	default:
		return 10
	}
}

// NormalizeRole clamps unknown roles to standard.
func NormalizeRole(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case RoleAdmin:
		return RoleAdmin
	case RoleOperator:
		return RoleOperator
	case RoleBasic:
		return RoleBasic
	default:
		return RoleStandard
	}
}

// UserRecord stores user credentials, role tier, certificate quota, and X.509 identity profile.
type UserRecord struct {
	Username       string `json:"username"`
	PasswordHash   string `json:"-"`
	Role           string `json:"role"`
	CertQuota      int    `json:"cert_quota"` // -1 = unlimited
	ActiveCerts    int    `json:"active_certs"`
	FullName       string `json:"full_name"`
	Email          string `json:"email"`
	UPN            string `json:"upn"`
	Organization   string `json:"organization"`
	Department     string `json:"department"`
	Country        string `json:"country"`
	Province       string `json:"province"`
	Locality       string `json:"locality"`
	Enabled        bool   `json:"enabled"`
	FailedAttempts int    `json:"failed_attempts"`
	LockedUntil    int64  `json:"locked_until"`
	CreatedAt      int64  `json:"created_at"`
	UpdatedAt      int64  `json:"updated_at"`
}

// NotificationChannelRecord stores an outbound expiry notification channel.
type NotificationChannelRecord struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	ChannelType     string `json:"channel_type"` // email, serverchan, telegram, webhook
	ConfigEnc       string `json:"-"`
	ConfigMasked    string `json:"config_masked"`
	AdvanceDaysJSON string `json:"advance_days_json"`
	Enabled         bool   `json:"enabled"`
	CreatedAt       int64  `json:"created_at"`
	UpdatedAt       int64  `json:"updated_at"`
}

// NotificationLogRecord records dispatched or failed expiry notifications and provides deduplication.
type NotificationLogRecord struct {
	ID            string `json:"id"`
	ChannelID     string `json:"channel_id"`
	ChannelName   string `json:"channel_name"`
	ChannelType   string `json:"channel_type"`
	CertSerial    string `json:"cert_serial"`
	CertCN        string `json:"cert_cn"`
	ThresholdDays int    `json:"threshold_days"`
	Status        string `json:"status"` // sent, failed, simulated
	Message       string `json:"message"`
	SentAt        int64  `json:"sent_at"`
}

// UpsertUser creates or updates a user inside WithTx.
func (s *Store) UpsertUser(ctx context.Context, rec UserRecord) error {
	now := time.Now().Unix()
	if rec.CreatedAt == 0 {
		rec.CreatedAt = now
	}
	if rec.UpdatedAt == 0 {
		rec.UpdatedAt = now
	}
	rec.Role = NormalizeRole(rec.Role)
	enabled := 0
	if rec.Enabled {
		enabled = 1
	}

	return s.WithTx(ctx, func(tx *sql.Tx) error {
		if s.Driver == DriverMySQL {
			_, err := tx.ExecContext(ctx, `
				INSERT INTO users (
					username, password_hash, role, cert_quota, full_name, email, upn,
					organization, department, country, province, locality,
					enabled, failed_attempts, locked_until, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON DUPLICATE KEY UPDATE
					password_hash=IF(VALUES(password_hash)='', password_hash, VALUES(password_hash)),
					role=VALUES(role), cert_quota=VALUES(cert_quota),
					full_name=VALUES(full_name), email=VALUES(email), upn=VALUES(upn),
					organization=VALUES(organization), department=VALUES(department),
					country=VALUES(country), province=VALUES(province), locality=VALUES(locality),
					enabled=VALUES(enabled), updated_at=VALUES(updated_at)
			`, rec.Username, rec.PasswordHash, rec.Role, rec.CertQuota, rec.FullName, rec.Email, rec.UPN,
				rec.Organization, rec.Department, rec.Country, rec.Province, rec.Locality,
				enabled, rec.FailedAttempts, rec.LockedUntil, rec.CreatedAt, rec.UpdatedAt)
			return err
		}
		_, err := tx.ExecContext(ctx, `
			INSERT INTO users (
				username, password_hash, role, cert_quota, full_name, email, upn,
				organization, department, country, province, locality,
				enabled, failed_attempts, locked_until, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(username) DO UPDATE SET
				password_hash=CASE WHEN excluded.password_hash='' THEN users.password_hash ELSE excluded.password_hash END,
				role=excluded.role, cert_quota=excluded.cert_quota,
				full_name=excluded.full_name, email=excluded.email, upn=excluded.upn,
				organization=excluded.organization, department=excluded.department,
				country=excluded.country, province=excluded.province, locality=excluded.locality,
				enabled=excluded.enabled, updated_at=excluded.updated_at
		`, rec.Username, rec.PasswordHash, rec.Role, rec.CertQuota, rec.FullName, rec.Email, rec.UPN,
			rec.Organization, rec.Department, rec.Country, rec.Province, rec.Locality,
			enabled, rec.FailedAttempts, rec.LockedUntil, rec.CreatedAt, rec.UpdatedAt)
		return err
	})
}

// UpdateUserProfile updates only self-service X.509 identity profile fields for a user.
func (s *Store) UpdateUserProfile(ctx context.Context, username, fullName, email, upn, org, dept, country, province, locality string) error {
	now := time.Now().Unix()
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE users
			SET full_name=?, email=?, upn=?, organization=?, department=?, country=?, province=?, locality=?, updated_at=?
			WHERE username=?
		`, fullName, email, upn, org, dept, country, province, locality, now, username)
		return err
	})
}

// GetUser fetches a single user record with their current active certificate count.
func (s *Store) GetUser(ctx context.Context, username string) (*UserRecord, error) {
	row := s.ReadDB.QueryRowContext(ctx, `
		SELECT username, password_hash, role, cert_quota, full_name, email, upn,
		       organization, department, country, province, locality,
		       enabled, failed_attempts, locked_until, created_at, updated_at
		FROM users WHERE username = ?
	`, username)
	var r UserRecord
	var enabled int
	if err := row.Scan(
		&r.Username, &r.PasswordHash, &r.Role, &r.CertQuota, &r.FullName, &r.Email, &r.UPN,
		&r.Organization, &r.Department, &r.Country, &r.Province, &r.Locality,
		&enabled, &r.FailedAttempts, &r.LockedUntil, &r.CreatedAt, &r.UpdatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	r.Enabled = enabled == 1
	r.ActiveCerts, _ = s.CountActiveCertificatesByUser(ctx, r.Username)
	return &r, nil
}

// ListUsers returns all users ordered by created_at ASC along with active certificate counts.
func (s *Store) ListUsers(ctx context.Context) ([]UserRecord, error) {
	rows, err := s.ReadDB.QueryContext(ctx, `
		SELECT username, password_hash, role, cert_quota, full_name, email, upn,
		       organization, department, country, province, locality,
		       enabled, failed_attempts, locked_until, created_at, updated_at
		FROM users ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UserRecord
	for rows.Next() {
		var r UserRecord
		var enabled int
		if err := rows.Scan(
			&r.Username, &r.PasswordHash, &r.Role, &r.CertQuota, &r.FullName, &r.Email, &r.UPN,
			&r.Organization, &r.Department, &r.Country, &r.Province, &r.Locality,
			&enabled, &r.FailedAttempts, &r.LockedUntil, &r.CreatedAt, &r.UpdatedAt,
		); err != nil {
			return nil, err
		}
		r.Enabled = enabled == 1
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].ActiveCerts, _ = s.CountActiveCertificatesByUser(ctx, out[i].Username)
	}
	return out, nil
}

// CountUsers returns total registered users.
func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var cnt int
	err := s.ReadDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE password_hash != ''`).Scan(&cnt)
	return cnt, err
}

// DeleteUser removes a non-root user record.
func (s *Store) DeleteUser(ctx context.Context, username string) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM users WHERE username = ?`, username)
		return err
	})
}

// RecordUserAuthFailure atomically increments failed_attempts and locks for 15 minutes at >= 5 failures.
func (s *Store) RecordUserAuthFailure(ctx context.Context, username string, now int64) (int, int64, error) {
	var attempts int
	var lockedUntil int64
	err := s.WithTx(ctx, func(tx *sql.Tx) error {
		var currentAttempts int
		var currentLocked int64
		err := tx.QueryRowContext(ctx, `SELECT failed_attempts, locked_until FROM users WHERE username = ?`, username).
			Scan(&currentAttempts, &currentLocked)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
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
			lockedUntil = now + 900
		}
		_, err = tx.ExecContext(ctx, `
			UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ?
			WHERE username = ?
		`, attempts, lockedUntil, now, username)
		return err
	})
	return attempts, lockedUntil, err
}

// ResetUserAuthFailures clears failure counters after successful sign-in.
func (s *Store) ResetUserAuthFailures(ctx context.Context, username string, now int64) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE users SET failed_attempts = 0, locked_until = 0, updated_at = ?
			WHERE username = ?
		`, now, username)
		return err
	})
}

// CountActiveCertificatesByUser counts non-revoked, non-expired manual/REST certificates issued by a specific user.
// ACME-issued certificates (key_mode = 'acme_csr') are unlimited and excluded from manual tier quotas.
func (s *Store) CountActiveCertificatesByUser(ctx context.Context, username string) (int, error) {
	now := time.Now().Unix()
	var cnt int
	err := s.ReadDB.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM certificates
		WHERE issued_by = ? AND status = 'active' AND not_after > ? AND key_mode != 'acme_csr'
	`, username, now).Scan(&cnt)
	return cnt, err
}

// CountActiveACMECertificatesByUser counts non-revoked, non-expired ACME-issued certificates for a specific user.
func (s *Store) CountActiveACMECertificatesByUser(ctx context.Context, username string) (int, error) {
	now := time.Now().Unix()
	var cnt int
	err := s.ReadDB.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM certificates
		WHERE issued_by = ? AND status = 'active' AND not_after > ? AND key_mode = 'acme_csr'
	`, username, now).Scan(&cnt)
	return cnt, err
}

// ListCertificatesByUser returns certificates owned by a specific user ordered by created_at DESC.
func (s *Store) ListCertificatesByUser(ctx context.Context, username string) ([]CertificateRecord, error) {
	rows, err := s.ReadDB.QueryContext(ctx, `
		SELECT serial_hex, profile, common_name, subject_dn, sans_json, eku_oids_json, upn,
		       key_mode, fingerprint_sha256, cert_pem, status, revoked_at, revocation_reason,
		       not_before, not_after, issued_by, created_at
		FROM certificates WHERE issued_by = ? ORDER BY created_at DESC
	`, username)
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

// InsertCertificateWithQuota atomically enforces a user's certificate quota inside WithTx before inserting.
// This eliminates TOCTOU race conditions when multiple concurrent issuance requests arrive for the same user.
func (s *Store) InsertCertificateWithQuota(ctx context.Context, rec CertificateRecord, ownerUsername string, maxQuota int) error {
	now := time.Now().Unix()
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		if maxQuota >= 0 && ownerUsername != "" && rec.KeyMode != "acme_csr" {
			var activeCount int
			if err := tx.QueryRowContext(ctx, `
				SELECT COUNT(*) FROM certificates
				WHERE issued_by = ? AND status = 'active' AND not_after > ? AND key_mode != 'acme_csr'
			`, ownerUsername, now).Scan(&activeCount); err != nil {
				return err
			}
			if activeCount >= maxQuota {
				return fmt.Errorf("%w (%d/%d active certificates)", ErrQuotaExceeded, activeCount, maxQuota)
			}
		}
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

// SetSetting persists a key-value system setting inside WithTx.
func (s *Store) SetSetting(ctx context.Context, key, val string) error {
	now := time.Now().Unix()
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		if s.Driver == DriverMySQL {
			_, err := tx.ExecContext(ctx, `
				INSERT INTO system_settings (k, v, updated_at) VALUES (?, ?, ?)
				ON DUPLICATE KEY UPDATE v=VALUES(v), updated_at=VALUES(updated_at)
			`, key, val, now)
			return err
		}
		_, err := tx.ExecContext(ctx, `
			INSERT INTO system_settings (k, v, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at
		`, key, val, now)
		return err
	})
}

// GetSetting retrieves a setting value by key from ReadDB.
func (s *Store) GetSetting(ctx context.Context, key string) (string, error) {
	var val string
	err := s.ReadDB.QueryRowContext(ctx, `SELECT v FROM system_settings WHERE k = ?`, key).Scan(&val)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return val, err
}

// UpsertNotificationChannel creates or updates a notification channel via WithTx.
func (s *Store) UpsertNotificationChannel(ctx context.Context, rec NotificationChannelRecord) error {
	now := time.Now().Unix()
	if rec.ID == "" {
		rec.ID = GenerateRandomID(8)
	}
	if rec.CreatedAt == 0 {
		rec.CreatedAt = now
	}
	rec.UpdatedAt = now
	if rec.AdvanceDaysJSON == "" {
		rec.AdvanceDaysJSON = "[30,7,1]"
	}
	enabled := 0
	if rec.Enabled {
		enabled = 1
	}
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		if s.Driver == DriverMySQL {
			_, err := tx.ExecContext(ctx, `
				INSERT INTO notification_channels (id, name, channel_type, config_enc, config_masked, advance_days_json, enabled, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON DUPLICATE KEY UPDATE
					name=VALUES(name), channel_type=VALUES(channel_type),
					config_enc=IF(VALUES(config_enc)='', config_enc, VALUES(config_enc)),
					config_masked=VALUES(config_masked), advance_days_json=VALUES(advance_days_json),
					enabled=VALUES(enabled), updated_at=VALUES(updated_at)
			`, rec.ID, rec.Name, rec.ChannelType, rec.ConfigEnc, rec.ConfigMasked, rec.AdvanceDaysJSON, enabled, rec.CreatedAt, rec.UpdatedAt)
			return err
		}
		_, err := tx.ExecContext(ctx, `
			INSERT INTO notification_channels (id, name, channel_type, config_enc, config_masked, advance_days_json, enabled, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				name=excluded.name, channel_type=excluded.channel_type,
				config_enc=CASE WHEN excluded.config_enc='' THEN notification_channels.config_enc ELSE excluded.config_enc END,
				config_masked=excluded.config_masked, advance_days_json=excluded.advance_days_json,
				enabled=excluded.enabled, updated_at=excluded.updated_at
		`, rec.ID, rec.Name, rec.ChannelType, rec.ConfigEnc, rec.ConfigMasked, rec.AdvanceDaysJSON, enabled, rec.CreatedAt, rec.UpdatedAt)
		return err
	})
}

// ListNotificationChannels lists all configured notification channels.
func (s *Store) ListNotificationChannels(ctx context.Context) ([]NotificationChannelRecord, error) {
	rows, err := s.ReadDB.QueryContext(ctx, `
		SELECT id, name, channel_type, config_enc, config_masked, advance_days_json, enabled, created_at, updated_at
		FROM notification_channels ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []NotificationChannelRecord
	for rows.Next() {
		var r NotificationChannelRecord
		var enabled int
		if err := rows.Scan(&r.ID, &r.Name, &r.ChannelType, &r.ConfigEnc, &r.ConfigMasked, &r.AdvanceDaysJSON, &enabled, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		r.Enabled = enabled == 1
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetNotificationChannel returns a single notification channel by ID.
func (s *Store) GetNotificationChannel(ctx context.Context, id string) (*NotificationChannelRecord, error) {
	row := s.ReadDB.QueryRowContext(ctx, `
		SELECT id, name, channel_type, config_enc, config_masked, advance_days_json, enabled, created_at, updated_at
		FROM notification_channels WHERE id = ?
	`, id)
	var r NotificationChannelRecord
	var enabled int
	if err := row.Scan(&r.ID, &r.Name, &r.ChannelType, &r.ConfigEnc, &r.ConfigMasked, &r.AdvanceDaysJSON, &enabled, &r.CreatedAt, &r.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	r.Enabled = enabled == 1
	return &r, nil
}

// DeleteNotificationChannel removes a notification channel by ID.
func (s *Store) DeleteNotificationChannel(ctx context.Context, id string) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM notification_channels WHERE id = ?`, id)
		return err
	})
}

// HasNotificationBeenSent checks if a certificate expiry alert was already sent for a channel + threshold.
func (s *Store) HasNotificationBeenSent(ctx context.Context, channelID, certSerial string, thresholdDays int) (bool, error) {
	var cnt int
	err := s.ReadDB.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM notification_logs
		WHERE channel_id = ? AND cert_serial = ? AND threshold_days = ? AND status IN ('sent', 'simulated')
	`, channelID, certSerial, thresholdDays).Scan(&cnt)
	return cnt > 0, err
}

// RecordNotificationLog writes a notification delivery log entry inside WithTx.
func (s *Store) RecordNotificationLog(ctx context.Context, rec NotificationLogRecord) error {
	if rec.ID == "" {
		rec.ID = GenerateRandomID(10)
	}
	if rec.SentAt == 0 {
		rec.SentAt = time.Now().Unix()
	}
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO notification_logs (id, channel_id, channel_name, channel_type, cert_serial, cert_cn, threshold_days, status, message, sent_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, rec.ID, rec.ChannelID, rec.ChannelName, rec.ChannelType, rec.CertSerial, rec.CertCN, rec.ThresholdDays, rec.Status, rec.Message, rec.SentAt)
		return err
	})
}

// ListNotificationLogs returns recent notification delivery logs ordered by sent_at DESC.
func (s *Store) ListNotificationLogs(ctx context.Context, limit int) ([]NotificationLogRecord, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.ReadDB.QueryContext(ctx, `
		SELECT id, channel_id, channel_name, channel_type, cert_serial, cert_cn, threshold_days, status, message, sent_at
		FROM notification_logs ORDER BY sent_at DESC LIMIT ?
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []NotificationLogRecord
	for rows.Next() {
		var r NotificationLogRecord
		if err := rows.Scan(&r.ID, &r.ChannelID, &r.ChannelName, &r.ChannelType, &r.CertSerial, &r.CertCN, &r.ThresholdDays, &r.Status, &r.Message, &r.SentAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
