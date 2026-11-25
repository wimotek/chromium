-- wimotek/ca MySQL Schema (All timestamps strictly stored as BIGINT Unix seconds)

CREATE TABLE IF NOT EXISTS ca_authorities (
    tier VARCHAR(32) PRIMARY KEY,
    subject_dn VARCHAR(512) NOT NULL,
    serial_hex VARCHAR(64) NOT NULL,
    fingerprint_sha256 VARCHAR(128) NOT NULL,
    cert_pem LONGTEXT NOT NULL,
    key_pem_enc LONGTEXT NOT NULL,
    not_before BIGINT NOT NULL,
    not_after BIGINT NOT NULL,
    created_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS certificates (
    serial_hex VARCHAR(64) PRIMARY KEY,
    profile VARCHAR(64) NOT NULL,
    common_name VARCHAR(255) NOT NULL,
    subject_dn VARCHAR(512) NOT NULL,
    sans_json TEXT NOT NULL,
    eku_oids_json TEXT NOT NULL,
    upn VARCHAR(255) NOT NULL DEFAULT '',
    key_mode VARCHAR(32) NOT NULL DEFAULT 'auto_pfx',
    fingerprint_sha256 VARCHAR(128) NOT NULL,
    cert_pem LONGTEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    revoked_at BIGINT NOT NULL DEFAULT 0,
    revocation_reason INT NOT NULL DEFAULT 0,
    not_before BIGINT NOT NULL,
    not_after BIGINT NOT NULL,
    issued_by VARCHAR(128) NOT NULL DEFAULT 'admin',
    created_at BIGINT NOT NULL,
    INDEX idx_certificates_status (status),
    INDEX idx_certificates_profile (profile),
    INDEX idx_certificates_not_after (not_after),
    INDEX idx_certificates_issued_by (issued_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS admin_auth (
    username VARCHAR(128) PRIMARY KEY,
    password_hash VARCHAR(255) NOT NULL,
    failed_attempts INT NOT NULL DEFAULT 0,
    locked_until BIGINT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
    username VARCHAR(128) PRIMARY KEY,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'standard',
    cert_quota INT NOT NULL DEFAULT 10,
    full_name VARCHAR(255) NOT NULL DEFAULT '',
    email VARCHAR(255) NOT NULL DEFAULT '',
    email_verified TINYINT NOT NULL DEFAULT 0,
    upn VARCHAR(255) NOT NULL DEFAULT '',
    organization VARCHAR(255) NOT NULL DEFAULT '',
    department VARCHAR(255) NOT NULL DEFAULT '',
    country VARCHAR(16) NOT NULL DEFAULT '',
    province VARCHAR(128) NOT NULL DEFAULT '',
    locality VARCHAR(128) NOT NULL DEFAULT '',
    enabled TINYINT NOT NULL DEFAULT 1,
    mfa_email_enabled TINYINT NOT NULL DEFAULT 0,
    mfa_passkey_enabled TINYINT NOT NULL DEFAULT 0,
    webhook_key_hash VARCHAR(128) NOT NULL DEFAULT '',
    webhook_key_prefix VARCHAR(32) NOT NULL DEFAULT '',
    failed_attempts INT NOT NULL DEFAULT 0,
    locked_until BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    INDEX idx_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_social_accounts (
    provider VARCHAR(32) NOT NULL,
    provider_id VARCHAR(255) NOT NULL,
    username VARCHAR(128) NOT NULL,
    email VARCHAR(255) NOT NULL DEFAULT '',
    display_name VARCHAR(255) NOT NULL DEFAULT '',
    linked_at BIGINT NOT NULL,
    PRIMARY KEY (provider, provider_id),
    INDEX idx_user_social_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_passkeys (
    id VARCHAR(64) PRIMARY KEY,
    username VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    credential_id VARCHAR(255) NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    device_type VARCHAR(64) NOT NULL DEFAULT 'platform',
    created_at BIGINT NOT NULL,
    last_used_at BIGINT NOT NULL DEFAULT 0,
    INDEX idx_user_passkeys_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS system_settings (
    k VARCHAR(128) PRIMARY KEY,
    v TEXT NOT NULL,
    updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notification_channels (
    id VARCHAR(64) PRIMARY KEY,
    owner_username VARCHAR(128) NOT NULL DEFAULT '',
    name VARCHAR(128) NOT NULL,
    channel_type VARCHAR(32) NOT NULL,
    config_enc LONGTEXT NOT NULL,
    config_masked TEXT NOT NULL,
    advance_days_json VARCHAR(255) NOT NULL DEFAULT '[30,7,1]',
    enabled TINYINT NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notification_logs (
    id VARCHAR(64) PRIMARY KEY,
    owner_username VARCHAR(128) NOT NULL DEFAULT '',
    channel_id VARCHAR(64) NOT NULL,
    channel_name VARCHAR(128) NOT NULL,
    channel_type VARCHAR(32) NOT NULL,
    cert_serial VARCHAR(64) NOT NULL DEFAULT '',
    cert_cn VARCHAR(255) NOT NULL DEFAULT '',
    threshold_days INT NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL,
    message TEXT NOT NULL,
    sent_at BIGINT NOT NULL,
    INDEX idx_notification_logs_dedup (channel_id, cert_serial, threshold_days),
    INDEX idx_notification_logs_sent_at (sent_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS provisioners (
    id VARCHAR(64) PRIMARY KEY,
    owner_username VARCHAR(128) NOT NULL DEFAULT 'admin',
    name VARCHAR(128) NOT NULL,
    purpose VARCHAR(512) NOT NULL DEFAULT '',
    protocol VARCHAR(32) NOT NULL DEFAULT 'api_token',
    scopes_json TEXT NOT NULL,
    token_hash VARCHAR(128) NOT NULL,
    token_prefix VARCHAR(32) NOT NULL,
    allowed_profiles_json TEXT NOT NULL,
    max_ttl_days INT NOT NULL DEFAULT 365,
    expires_at BIGINT NOT NULL DEFAULT 0,
    last_used_at BIGINT NOT NULL DEFAULT 0,
    enabled TINYINT NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cache_kv (
    k VARCHAR(255) PRIMARY KEY,
    v LONGBLOB NOT NULL,
    expires_at BIGINT NOT NULL,
    INDEX idx_cache_kv_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    actor VARCHAR(128) NOT NULL,
    action VARCHAR(64) NOT NULL,
    target_serial VARCHAR(64) NOT NULL DEFAULT '',
    client_ip VARCHAR(64) NOT NULL DEFAULT '',
    detail_json TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    INDEX idx_audit_logs_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
