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

CREATE TABLE IF NOT EXISTS acme_eab_credentials (
    kid VARCHAR(64) PRIMARY KEY,
    owner_username VARCHAR(128) NOT NULL,
    label VARCHAR(255) NOT NULL DEFAULT '',
    hmac_key_enc LONGTEXT NOT NULL,
    hmac_prefix VARCHAR(32) NOT NULL DEFAULT '',
    bound_count INT NOT NULL DEFAULT 0,
    last_used_at BIGINT NOT NULL DEFAULT 0,
    enabled TINYINT NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    INDEX idx_acme_eab_owner (owner_username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS acme_accounts (
    id VARCHAR(64) PRIMARY KEY,
    owner_username VARCHAR(128) NOT NULL DEFAULT '',
    eab_kid VARCHAR(64) NOT NULL DEFAULT '',
    jwk_thumbprint VARCHAR(128) NOT NULL UNIQUE,
    jwk_json TEXT NOT NULL,
    contacts_json TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'valid',
    created_at BIGINT NOT NULL,
    INDEX idx_acme_accounts_owner (owner_username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS acme_orders (
    id VARCHAR(64) PRIMARY KEY,
    account_id VARCHAR(64) NOT NULL,
    owner_username VARCHAR(128) NOT NULL DEFAULT '',
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    identifiers_json TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    cert_serial VARCHAR(64) NOT NULL DEFAULT '',
    error_json TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    INDEX idx_acme_orders_account (account_id),
    INDEX idx_acme_orders_owner (owner_username),
    INDEX idx_acme_orders_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS acme_authorizations (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL,
    account_id VARCHAR(64) NOT NULL,
    identifier_type VARCHAR(32) NOT NULL DEFAULT 'dns',
    identifier_value VARCHAR(255) NOT NULL,
    wildcard TINYINT NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    expires_at BIGINT NOT NULL,
    challenges_json LONGTEXT NOT NULL,
    created_at BIGINT NOT NULL,
    INDEX idx_acme_authz_order (order_id),
    INDEX idx_acme_authz_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS managed_upstreams (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    directory_url VARCHAR(512) NOT NULL,
    requires_eab TINYINT NOT NULL DEFAULT 0,
    eab_kid VARCHAR(255) NOT NULL DEFAULT '',
    eab_hmac_enc LONGTEXT NOT NULL,
    eab_hmac_prefix VARCHAR(32) NOT NULL DEFAULT '',
    contact_email VARCHAR(255) NOT NULL DEFAULT '',
    priority INT NOT NULL DEFAULT 1,
    enabled TINYINT NOT NULL DEFAULT 1,
    account_url VARCHAR(512) NOT NULL DEFAULT '',
    account_key_enc LONGTEXT NOT NULL,
    last_probe_at BIGINT NOT NULL DEFAULT 0,
    last_probe_ok TINYINT NOT NULL DEFAULT 0,
    last_probe_ms INT NOT NULL DEFAULT 0,
    last_probe_error TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS managed_dns_credentials (
    id VARCHAR(64) PRIMARY KEY,
    owner_username VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    zone_hint VARCHAR(128) NOT NULL DEFAULT '',
    secret_enc LONGTEXT NOT NULL,
    secret_prefix VARCHAR(32) NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    INDEX idx_managed_dns_owner (owner_username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS managed_certificates (
    id VARCHAR(64) PRIMARY KEY,
    owner_username VARCHAR(128) NOT NULL,
    common_name VARCHAR(255) NOT NULL,
    domains_json TEXT NOT NULL,
    engine_mode VARCHAR(32) NOT NULL DEFAULT 'upstream_public',
    upstream_id VARCHAR(64) NOT NULL DEFAULT 'auto',
    resolved_upstream_id VARCHAR(64) NOT NULL DEFAULT '',
    resolved_issuer_name VARCHAR(128) NOT NULL DEFAULT '',
    challenge_method VARCHAR(32) NOT NULL DEFAULT 'cname_delegation',
    dns_credential_id VARCHAR(64) NOT NULL DEFAULT '',
    cname_delegation_token VARCHAR(64) NOT NULL DEFAULT '',
    cname_delegation_target VARCHAR(255) NOT NULL DEFAULT '',
    status VARCHAR(32) NOT NULL DEFAULT 'pending_validation',
    auto_renew TINYINT NOT NULL DEFAULT 1,
    renew_before_days INT NOT NULL DEFAULT 30,
    upstream_order_url VARCHAR(512) NOT NULL DEFAULT '',
    upstream_finalize_url VARCHAR(512) NOT NULL DEFAULT '',
    challenges_json LONGTEXT NOT NULL,
    serial_hex VARCHAR(64) NOT NULL DEFAULT '',
    fingerprint_sha256 VARCHAR(128) NOT NULL DEFAULT '',
    not_before BIGINT NOT NULL DEFAULT 0,
    not_after BIGINT NOT NULL DEFAULT 0,
    cert_pem LONGTEXT NOT NULL,
    chain_pem LONGTEXT NOT NULL,
    private_key_enc LONGTEXT NOT NULL,
    deploy_webhook_url VARCHAR(512) NOT NULL DEFAULT '',
    deploy_webhook_secret_enc LONGTEXT NOT NULL,
    deploy_webhook_secret_prefix VARCHAR(32) NOT NULL DEFAULT '',
    last_deploy_at BIGINT NOT NULL DEFAULT 0,
    last_deploy_status VARCHAR(255) NOT NULL DEFAULT '',
    last_error TEXT NOT NULL,
    last_renewed_at BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    INDEX idx_managed_certs_owner (owner_username),
    INDEX idx_managed_certs_not_after (not_after)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS managed_deploy_logs (
    id VARCHAR(64) PRIMARY KEY,
    cert_id VARCHAR(64) NOT NULL,
    owner_username VARCHAR(128) NOT NULL,
    common_name VARCHAR(255) NOT NULL,
    action VARCHAR(32) NOT NULL,
    target VARCHAR(512) NOT NULL,
    status VARCHAR(16) NOT NULL,
    detail TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    INDEX idx_managed_logs_owner (owner_username),
    INDEX idx_managed_logs_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


