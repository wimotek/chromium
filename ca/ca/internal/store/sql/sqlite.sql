-- wimotek/ca SQLite Schema (All timestamps strictly stored as BIGINT Unix seconds)

CREATE TABLE IF NOT EXISTS ca_authorities (
    tier TEXT PRIMARY KEY,
    subject_dn TEXT NOT NULL,
    serial_hex TEXT NOT NULL,
    fingerprint_sha256 TEXT NOT NULL,
    cert_pem TEXT NOT NULL,
    key_pem_enc TEXT NOT NULL,
    not_before BIGINT NOT NULL,
    not_after BIGINT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS certificates (
    serial_hex TEXT PRIMARY KEY,
    profile TEXT NOT NULL,
    common_name TEXT NOT NULL,
    subject_dn TEXT NOT NULL,
    sans_json TEXT NOT NULL DEFAULT '[]',
    eku_oids_json TEXT NOT NULL DEFAULT '[]',
    upn TEXT NOT NULL DEFAULT '',
    key_mode TEXT NOT NULL DEFAULT 'auto_pfx',
    fingerprint_sha256 TEXT NOT NULL,
    cert_pem TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    revoked_at BIGINT NOT NULL DEFAULT 0,
    revocation_reason INTEGER NOT NULL DEFAULT 0,
    not_before BIGINT NOT NULL,
    not_after BIGINT NOT NULL,
    issued_by TEXT NOT NULL DEFAULT 'admin',
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_certificates_status ON certificates(status);
CREATE INDEX IF NOT EXISTS idx_certificates_profile ON certificates(profile);
CREATE INDEX IF NOT EXISTS idx_certificates_not_after ON certificates(not_after);
CREATE INDEX IF NOT EXISTS idx_certificates_issued_by ON certificates(issued_by);

CREATE TABLE IF NOT EXISTS admin_auth (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until BIGINT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'standard',
    cert_quota INTEGER NOT NULL DEFAULT 10,
    full_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    email_verified INTEGER NOT NULL DEFAULT 0,
    upn TEXT NOT NULL DEFAULT '',
    organization TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    province TEXT NOT NULL DEFAULT '',
    locality TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    mfa_email_enabled INTEGER NOT NULL DEFAULT 0,
    mfa_passkey_enabled INTEGER NOT NULL DEFAULT 0,
    webhook_key_hash TEXT NOT NULL DEFAULT '',
    webhook_key_prefix TEXT NOT NULL DEFAULT '',
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS user_social_accounts (
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    username TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    linked_at BIGINT NOT NULL,
    PRIMARY KEY (provider, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_user_social_username ON user_social_accounts(username);

CREATE TABLE IF NOT EXISTS user_passkeys (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    credential_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL DEFAULT '',
    device_type TEXT NOT NULL DEFAULT 'platform',
    created_at BIGINT NOT NULL,
    last_used_at BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_user_passkeys_username ON user_passkeys(username);

CREATE TABLE IF NOT EXISTS system_settings (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_channels (
    id TEXT PRIMARY KEY,
    owner_username TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    channel_type TEXT NOT NULL,
    config_enc TEXT NOT NULL,
    config_masked TEXT NOT NULL DEFAULT '{}',
    advance_days_json TEXT NOT NULL DEFAULT '[30,7,1]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_logs (
    id TEXT PRIMARY KEY,
    owner_username TEXT NOT NULL DEFAULT '',
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    channel_type TEXT NOT NULL,
    cert_serial TEXT NOT NULL DEFAULT '',
    cert_cn TEXT NOT NULL DEFAULT '',
    threshold_days INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    sent_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_dedup ON notification_logs(channel_id, cert_serial, threshold_days);
CREATE INDEX IF NOT EXISTS idx_notification_logs_sent_at ON notification_logs(sent_at);

CREATE TABLE IF NOT EXISTS provisioners (
    id TEXT PRIMARY KEY,
    owner_username TEXT NOT NULL DEFAULT 'admin',
    name TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT '',
    protocol TEXT NOT NULL DEFAULT 'api_token',
    scopes_json TEXT NOT NULL DEFAULT '["certs:read","certs:issue","certs:revoke","webhook:send","mcp:access"]',
    token_hash TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    allowed_profiles_json TEXT NOT NULL DEFAULT '["tls_server","pdf_signing","entra_cba","tls_client","code_signing","smime_email","wifi_eap","iot_device"]',
    max_ttl_days INTEGER NOT NULL DEFAULT 365,
    expires_at BIGINT NOT NULL DEFAULT 0,
    last_used_at BIGINT NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_kv (
    k TEXT PRIMARY KEY,
    v BLOB NOT NULL,
    expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cache_kv_expires_at ON cache_kv(expires_at);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target_serial TEXT NOT NULL DEFAULT '',
    client_ip TEXT NOT NULL DEFAULT '',
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
