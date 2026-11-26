package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// ManagedUpstreamRecord stores an upstream public trusted ACME v2 CA configuration.
type ManagedUpstreamRecord struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Provider       string `json:"provider"`
	DirectoryURL   string `json:"directory_url"`
	RequiresEAB    bool   `json:"requires_eab"`
	EABKID         string `json:"eab_kid"`
	EABHMACEnc     string `json:"-"`
	EABHMACPrefix  string `json:"eab_hmac_prefix"`
	ContactEmail   string `json:"contact_email"`
	Priority       int    `json:"priority"`
	Enabled        bool   `json:"enabled"`
	AccountURL     string `json:"-"`
	AccountKeyEnc  string `json:"-"`
	LastProbeAt    int64  `json:"last_probe_at"`
	LastProbeOK    bool   `json:"last_probe_ok"`
	LastProbeMS    int    `json:"last_probe_ms"`
	LastProbeError string `json:"last_probe_error"`
	CreatedAt      int64  `json:"created_at"`
	UpdatedAt      int64  `json:"updated_at"`
}

// ManagedDnsCredentialRecord stores an encrypted DNS API credential for DNS-01 automation.
type ManagedDnsCredentialRecord struct {
	ID            string `json:"id"`
	OwnerUsername string `json:"owner_username"`
	Name          string `json:"name"`
	Provider      string `json:"provider"`
	ZoneHint      string `json:"zone_hint"`
	SecretEnc     string `json:"-"`
	SecretPrefix  string `json:"secret_prefix"`
	CreatedAt     int64  `json:"created_at"`
	UpdatedAt     int64  `json:"updated_at"`
}

// ManagedCertificateRecord stores a hosted/managed SSL certificate with CNAME delegation & auto-renewal.
type ManagedCertificateRecord struct {
	ID                        string `json:"id"`
	OwnerUsername             string `json:"owner_username"`
	CommonName                string `json:"common_name"`
	DomainsJSON               string `json:"domains_json"`
	EngineMode                string `json:"engine_mode"`
	UpstreamID                string `json:"upstream_id"`
	ResolvedUpstreamID        string `json:"resolved_upstream_id"`
	ResolvedIssuerName        string `json:"resolved_issuer_name"`
	ChallengeMethod           string `json:"challenge_method"`
	DnsCredentialID           string `json:"dns_credential_id"`
	CnameDelegationToken      string `json:"cname_delegation_token"`
	CnameDelegationTarget     string `json:"cname_delegation_target"`
	Status                    string `json:"status"`
	AutoRenew                 bool   `json:"auto_renew"`
	RenewBeforeDays           int    `json:"renew_before_days"`
	UpstreamOrderURL          string `json:"upstream_order_url"`
	UpstreamFinalizeURL       string `json:"upstream_finalize_url"`
	ChallengesJSON            string `json:"challenges_json"`
	SerialHex                 string `json:"serial_hex"`
	FingerprintSHA256         string `json:"fingerprint_sha256"`
	NotBefore                 int64  `json:"not_before"`
	NotAfter                  int64  `json:"not_after"`
	CertPEM                   string `json:"cert_pem"`
	ChainPEM                  string `json:"chain_pem"`
	PrivateKeyEnc             string `json:"-"`
	DeployWebhookURL          string `json:"deploy_webhook_url"`
	DeployWebhookSecretEnc    string `json:"-"`
	DeployWebhookSecretPrefix string `json:"deploy_webhook_secret_prefix"`
	LastDeployAt              int64  `json:"last_deploy_at"`
	LastDeployStatus          string `json:"last_deploy_status"`
	LastError                 string `json:"last_error"`
	LastRenewedAt             int64  `json:"last_renewed_at"`
	CreatedAt                 int64  `json:"created_at"`
	UpdatedAt                 int64  `json:"updated_at"`
}

// ManagedDeployLogRecord tracks issuance, renewal, and deploy webhook events.
type ManagedDeployLogRecord struct {
	ID            string `json:"id"`
	CertID        string `json:"cert_id"`
	OwnerUsername string `json:"owner_username"`
	CommonName    string `json:"common_name"`
	Action        string `json:"action"`
	Target        string `json:"target"`
	Status        string `json:"status"`
	Detail        string `json:"detail"`
	CreatedAt     int64  `json:"created_at"`
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

// UpsertManagedUpstream inserts or updates an upstream public CA record.
func (s *Store) UpsertManagedUpstream(ctx context.Context, rec ManagedUpstreamRecord) error {
	now := time.Now().Unix()
	if rec.CreatedAt == 0 {
		rec.CreatedAt = now
	}
	rec.UpdatedAt = now
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			DELETE FROM managed_upstreams WHERE id = ?
		`, rec.ID)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `
			INSERT INTO managed_upstreams (
				id, name, provider, directory_url, requires_eab, eab_kid, eab_hmac_enc, eab_hmac_prefix,
				contact_email, priority, enabled, account_url, account_key_enc,
				last_probe_at, last_probe_ok, last_probe_ms, last_probe_error, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, rec.ID, rec.Name, rec.Provider, rec.DirectoryURL, boolToInt(rec.RequiresEAB), rec.EABKID,
			rec.EABHMACEnc, rec.EABHMACPrefix, rec.ContactEmail, rec.Priority, boolToInt(rec.Enabled),
			rec.AccountURL, rec.AccountKeyEnc, rec.LastProbeAt, boolToInt(rec.LastProbeOK),
			rec.LastProbeMS, rec.LastProbeError, rec.CreatedAt, rec.UpdatedAt)
		return err
	})
}

// ListManagedUpstreams returns all configured upstream public CAs ordered by priority.
func (s *Store) ListManagedUpstreams(ctx context.Context) ([]ManagedUpstreamRecord, error) {
	rows, err := s.ReadDB.QueryContext(ctx, `
		SELECT id, name, provider, directory_url, requires_eab, eab_kid, eab_hmac_enc, eab_hmac_prefix,
		       contact_email, priority, enabled, account_url, account_key_enc,
		       last_probe_at, last_probe_ok, last_probe_ms, last_probe_error, created_at, updated_at
		FROM managed_upstreams ORDER BY priority ASC, created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ManagedUpstreamRecord, 0)
	for rows.Next() {
		var r ManagedUpstreamRecord
		var reqEab, en, probeOk int
		if err := rows.Scan(
			&r.ID, &r.Name, &r.Provider, &r.DirectoryURL, &reqEab, &r.EABKID, &r.EABHMACEnc, &r.EABHMACPrefix,
			&r.ContactEmail, &r.Priority, &en, &r.AccountURL, &r.AccountKeyEnc,
			&r.LastProbeAt, &probeOk, &r.LastProbeMS, &r.LastProbeError, &r.CreatedAt, &r.UpdatedAt,
		); err != nil {
			return nil, err
		}
		r.RequiresEAB = reqEab == 1
		r.Enabled = en == 1
		r.LastProbeOK = probeOk == 1
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetManagedUpstream fetches a single upstream CA by ID.
func (s *Store) GetManagedUpstream(ctx context.Context, id string) (*ManagedUpstreamRecord, error) {
	row := s.ReadDB.QueryRowContext(ctx, `
		SELECT id, name, provider, directory_url, requires_eab, eab_kid, eab_hmac_enc, eab_hmac_prefix,
		       contact_email, priority, enabled, account_url, account_key_enc,
		       last_probe_at, last_probe_ok, last_probe_ms, last_probe_error, created_at, updated_at
		FROM managed_upstreams WHERE id = ?
	`, id)
	var r ManagedUpstreamRecord
	var reqEab, en, probeOk int
	if err := row.Scan(
		&r.ID, &r.Name, &r.Provider, &r.DirectoryURL, &reqEab, &r.EABKID, &r.EABHMACEnc, &r.EABHMACPrefix,
		&r.ContactEmail, &r.Priority, &en, &r.AccountURL, &r.AccountKeyEnc,
		&r.LastProbeAt, &probeOk, &r.LastProbeMS, &r.LastProbeError, &r.CreatedAt, &r.UpdatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	r.RequiresEAB = reqEab == 1
	r.Enabled = en == 1
	r.LastProbeOK = probeOk == 1
	return &r, nil
}

// DeleteManagedUpstream deletes an upstream CA by ID.
func (s *Store) DeleteManagedUpstream(ctx context.Context, id string) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM managed_upstreams WHERE id = ?`, id)
		return err
	})
}

// InsertManagedDnsCredential persists a new encrypted DNS provider credential.
func (s *Store) InsertManagedDnsCredential(ctx context.Context, rec ManagedDnsCredentialRecord) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO managed_dns_credentials (id, owner_username, name, provider, zone_hint, secret_enc, secret_prefix, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, rec.ID, rec.OwnerUsername, rec.Name, rec.Provider, rec.ZoneHint, rec.SecretEnc, rec.SecretPrefix, rec.CreatedAt, rec.UpdatedAt)
		return err
	})
}

// ListManagedDnsCredentials lists DNS credentials for a user (or all if owner == "").
func (s *Store) ListManagedDnsCredentials(ctx context.Context, owner string) ([]ManagedDnsCredentialRecord, error) {
	var rows *sql.Rows
	var err error
	if owner == "" {
		rows, err = s.ReadDB.QueryContext(ctx, `
			SELECT id, owner_username, name, provider, zone_hint, secret_enc, secret_prefix, created_at, updated_at
			FROM managed_dns_credentials ORDER BY created_at DESC
		`)
	} else {
		rows, err = s.ReadDB.QueryContext(ctx, `
			SELECT id, owner_username, name, provider, zone_hint, secret_enc, secret_prefix, created_at, updated_at
			FROM managed_dns_credentials WHERE owner_username = ? ORDER BY created_at DESC
		`, owner)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ManagedDnsCredentialRecord, 0)
	for rows.Next() {
		var r ManagedDnsCredentialRecord
		if err := rows.Scan(&r.ID, &r.OwnerUsername, &r.Name, &r.Provider, &r.ZoneHint, &r.SecretEnc, &r.SecretPrefix, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteManagedDnsCredential deletes a DNS credential by ID.
func (s *Store) DeleteManagedDnsCredential(ctx context.Context, id string) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM managed_dns_credentials WHERE id = ?`, id)
		return err
	})
}

// UpsertManagedCertificate inserts or updates a managed SSL certificate.
func (s *Store) UpsertManagedCertificate(ctx context.Context, rec ManagedCertificateRecord) error {
	now := time.Now().Unix()
	if rec.CreatedAt == 0 {
		rec.CreatedAt = now
	}
	rec.UpdatedAt = now
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `DELETE FROM managed_certificates WHERE id = ?`, rec.ID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `
			INSERT INTO managed_certificates (
				id, owner_username, common_name, domains_json, engine_mode, upstream_id, resolved_upstream_id, resolved_issuer_name,
				challenge_method, dns_credential_id, cname_delegation_token, cname_delegation_target,
				status, auto_renew, renew_before_days, upstream_order_url, upstream_finalize_url, challenges_json,
				serial_hex, fingerprint_sha256, not_before, not_after, cert_pem, chain_pem, private_key_enc,
				deploy_webhook_url, deploy_webhook_secret_enc, deploy_webhook_secret_prefix,
				last_deploy_at, last_deploy_status, last_error, last_renewed_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, rec.ID, rec.OwnerUsername, rec.CommonName, rec.DomainsJSON, rec.EngineMode, rec.UpstreamID,
			rec.ResolvedUpstreamID, rec.ResolvedIssuerName, rec.ChallengeMethod, rec.DnsCredentialID,
			rec.CnameDelegationToken, rec.CnameDelegationTarget, rec.Status, boolToInt(rec.AutoRenew),
			rec.RenewBeforeDays, rec.UpstreamOrderURL, rec.UpstreamFinalizeURL, rec.ChallengesJSON,
			rec.SerialHex, rec.FingerprintSHA256, rec.NotBefore, rec.NotAfter, rec.CertPEM, rec.ChainPEM,
			rec.PrivateKeyEnc, rec.DeployWebhookURL, rec.DeployWebhookSecretEnc, rec.DeployWebhookSecretPrefix,
			rec.LastDeployAt, rec.LastDeployStatus, rec.LastError, rec.LastRenewedAt, rec.CreatedAt, rec.UpdatedAt)
		return err
	})
}

// GetManagedCertificate fetches one managed certificate by ID.
func (s *Store) GetManagedCertificate(ctx context.Context, id string) (*ManagedCertificateRecord, error) {
	row := s.ReadDB.QueryRowContext(ctx, `
		SELECT id, owner_username, common_name, domains_json, engine_mode, upstream_id, resolved_upstream_id, resolved_issuer_name,
		       challenge_method, dns_credential_id, cname_delegation_token, cname_delegation_target,
		       status, auto_renew, renew_before_days, upstream_order_url, upstream_finalize_url, challenges_json,
		       serial_hex, fingerprint_sha256, not_before, not_after, cert_pem, chain_pem, private_key_enc,
		       deploy_webhook_url, deploy_webhook_secret_enc, deploy_webhook_secret_prefix,
		       last_deploy_at, last_deploy_status, last_error, last_renewed_at, created_at, updated_at
		FROM managed_certificates WHERE id = ?
	`, id)
	var r ManagedCertificateRecord
	var autoRenew int
	if err := row.Scan(
		&r.ID, &r.OwnerUsername, &r.CommonName, &r.DomainsJSON, &r.EngineMode, &r.UpstreamID,
		&r.ResolvedUpstreamID, &r.ResolvedIssuerName, &r.ChallengeMethod, &r.DnsCredentialID,
		&r.CnameDelegationToken, &r.CnameDelegationTarget, &r.Status, &autoRenew, &r.RenewBeforeDays,
		&r.UpstreamOrderURL, &r.UpstreamFinalizeURL, &r.ChallengesJSON, &r.SerialHex, &r.FingerprintSHA256,
		&r.NotBefore, &r.NotAfter, &r.CertPEM, &r.ChainPEM, &r.PrivateKeyEnc, &r.DeployWebhookURL,
		&r.DeployWebhookSecretEnc, &r.DeployWebhookSecretPrefix, &r.LastDeployAt, &r.LastDeployStatus,
		&r.LastError, &r.LastRenewedAt, &r.CreatedAt, &r.UpdatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	r.AutoRenew = autoRenew == 1
	return &r, nil
}

// ListManagedCertificates lists managed certificates for an owner (or all if owner == "").
func (s *Store) ListManagedCertificates(ctx context.Context, owner string) ([]ManagedCertificateRecord, error) {
	var rows *sql.Rows
	var err error
	if owner == "" {
		rows, err = s.ReadDB.QueryContext(ctx, `
			SELECT id, owner_username, common_name, domains_json, engine_mode, upstream_id, resolved_upstream_id, resolved_issuer_name,
			       challenge_method, dns_credential_id, cname_delegation_token, cname_delegation_target,
			       status, auto_renew, renew_before_days, upstream_order_url, upstream_finalize_url, challenges_json,
			       serial_hex, fingerprint_sha256, not_before, not_after, cert_pem, chain_pem, private_key_enc,
			       deploy_webhook_url, deploy_webhook_secret_enc, deploy_webhook_secret_prefix,
			       last_deploy_at, last_deploy_status, last_error, last_renewed_at, created_at, updated_at
			FROM managed_certificates ORDER BY created_at DESC
		`)
	} else {
		rows, err = s.ReadDB.QueryContext(ctx, `
			SELECT id, owner_username, common_name, domains_json, engine_mode, upstream_id, resolved_upstream_id, resolved_issuer_name,
			       challenge_method, dns_credential_id, cname_delegation_token, cname_delegation_target,
			       status, auto_renew, renew_before_days, upstream_order_url, upstream_finalize_url, challenges_json,
			       serial_hex, fingerprint_sha256, not_before, not_after, cert_pem, chain_pem, private_key_enc,
			       deploy_webhook_url, deploy_webhook_secret_enc, deploy_webhook_secret_prefix,
			       last_deploy_at, last_deploy_status, last_error, last_renewed_at, created_at, updated_at
			FROM managed_certificates WHERE owner_username = ? ORDER BY created_at DESC
		`, owner)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ManagedCertificateRecord, 0)
	for rows.Next() {
		var r ManagedCertificateRecord
		var autoRenew int
		if err := rows.Scan(
			&r.ID, &r.OwnerUsername, &r.CommonName, &r.DomainsJSON, &r.EngineMode, &r.UpstreamID,
			&r.ResolvedUpstreamID, &r.ResolvedIssuerName, &r.ChallengeMethod, &r.DnsCredentialID,
			&r.CnameDelegationToken, &r.CnameDelegationTarget, &r.Status, &autoRenew, &r.RenewBeforeDays,
			&r.UpstreamOrderURL, &r.UpstreamFinalizeURL, &r.ChallengesJSON, &r.SerialHex, &r.FingerprintSHA256,
			&r.NotBefore, &r.NotAfter, &r.CertPEM, &r.ChainPEM, &r.PrivateKeyEnc, &r.DeployWebhookURL,
			&r.DeployWebhookSecretEnc, &r.DeployWebhookSecretPrefix, &r.LastDeployAt, &r.LastDeployStatus,
			&r.LastError, &r.LastRenewedAt, &r.CreatedAt, &r.UpdatedAt,
		); err != nil {
			return nil, err
		}
		r.AutoRenew = autoRenew == 1
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteManagedCertificate removes a managed certificate by ID.
func (s *Store) DeleteManagedCertificate(ctx context.Context, id string) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM managed_certificates WHERE id = ?`, id)
		return err
	})
}

// AppendManagedDeployLog records an issuance, renewal, or webhook delivery log entry.
func (s *Store) AppendManagedDeployLog(ctx context.Context, rec ManagedDeployLogRecord) error {
	if rec.ID == "" {
		rec.ID = "mlog_" + GenerateRandomID(8)
	}
	if rec.CreatedAt == 0 {
		rec.CreatedAt = time.Now().Unix()
	}
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO managed_deploy_logs (id, cert_id, owner_username, common_name, action, target, status, detail, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, rec.ID, rec.CertID, rec.OwnerUsername, rec.CommonName, rec.Action, rec.Target, rec.Status, rec.Detail, rec.CreatedAt)
		return err
	})
}

// ListManagedDeployLogs lists recent deploy logs for an owner (or all if owner == "").
func (s *Store) ListManagedDeployLogs(ctx context.Context, owner string, limit int) ([]ManagedDeployLogRecord, error) {
	if limit <= 0 || limit > 200 {
		limit = 40
	}
	var rows *sql.Rows
	var err error
	if owner == "" {
		rows, err = s.ReadDB.QueryContext(ctx, `
			SELECT id, cert_id, owner_username, common_name, action, target, status, detail, created_at
			FROM managed_deploy_logs ORDER BY created_at DESC LIMIT ?
		`, limit)
	} else {
		rows, err = s.ReadDB.QueryContext(ctx, `
			SELECT id, cert_id, owner_username, common_name, action, target, status, detail, created_at
			FROM managed_deploy_logs WHERE owner_username = ? ORDER BY created_at DESC LIMIT ?
		`, owner, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ManagedDeployLogRecord, 0)
	for rows.Next() {
		var r ManagedDeployLogRecord
		if err := rows.Scan(&r.ID, &r.CertID, &r.OwnerUsername, &r.CommonName, &r.Action, &r.Target, &r.Status, &r.Detail, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
