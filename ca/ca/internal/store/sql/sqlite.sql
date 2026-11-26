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

CREATE TABLE IF NOT EXISTS acme_eab_credentials (
    kid TEXT PRIMARY KEY,
    owner_username TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    hmac_key_enc TEXT NOT NULL,
    hmac_prefix TEXT NOT NULL DEFAULT '',
    bound_count INTEGER NOT NULL DEFAULT 0,
    last_used_at BIGINT NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_acme_eab_owner ON acme_eab_credentials(owner_username);

CREATE TABLE IF NOT EXISTS acme_accounts (
    id TEXT PRIMARY KEY,
    owner_username TEXT NOT NULL DEFAULT '',
    eab_kid TEXT NOT NULL DEFAULT '',
    jwk_thumbprint TEXT NOT NULL UNIQUE,
    jwk_json TEXT NOT NULL,
    contacts_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'valid',
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_acme_accounts_owner ON acme_accounts(owner_username);

CREATE TABLE IF NOT EXISTS acme_orders (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    owner_username TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    identifiers_json TEXT NOT NULL DEFAULT '[]',
    expires_at BIGINT NOT NULL,
    cert_serial TEXT NOT NULL DEFAULT '',
    error_json TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_acme_orders_account ON acme_orders(account_id);
CREATE INDEX IF NOT EXISTS idx_acme_orders_owner ON acme_orders(owner_username);
CREATE INDEX IF NOT EXISTS idx_acme_orders_created_at ON acme_orders(created_at);

CREATE TABLE IF NOT EXISTS acme_authorizations (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    identifier_type TEXT NOT NULL DEFAULT 'dns',
    identifier_value TEXT NOT NULL,
    wildcard INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at BIGINT NOT NULL,
    challenges_json TEXT NOT NULL DEFAULT '[]',
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_acme_authz_order ON acme_authorizations(order_id);
CREATE INDEX IF NOT EXISTS idx_acme_authz_account ON acme_authorizations(account_id);

CREATE TABLE IF NOT EXISTS managed_upstreams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    directory_url TEXT NOT NULL,
    requires_eab INTEGER NOT NULL DEFAULT 0,
    eab_kid TEXT NOT NULL DEFAULT '',
    eab_hmac_enc TEXT NOT NULL DEFAULT '',
    eab_hmac_prefix TEXT NOT NULL DEFAULT '',
    contact_email TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    account_url TEXT NOT NULL DEFAULT '',
    account_key_enc TEXT NOT NULL DEFAULT '',
    last_probe_at BIGINT NOT NULL DEFAULT 0,
    last_probe_ok INTEGER NOT NULL DEFAULT 0,
    last_probe_ms INTEGER NOT NULL DEFAULT 0,
    last_probe_error TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_dns_credentials (
    id TEXT PRIMARY KEY,
    owner_username TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    zone_hint TEXT NOT NULL DEFAULT '',
    secret_enc TEXT NOT NULL,
    secret_prefix TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_managed_dns_owner ON managed_dns_credentials(owner_username);

CREATE TABLE IF NOT EXISTS managed_certificates (
    id TEXT PRIMARY KEY,
    owner_username TEXT NOT NULL,
    common_name TEXT NOT NULL,
    domains_json TEXT NOT NULL DEFAULT '[]',
    engine_mode TEXT NOT NULL DEFAULT 'upstream_public',
    upstream_id TEXT NOT NULL DEFAULT 'auto',
    resolved_upstream_id TEXT NOT NULL DEFAULT '',
    resolved_issuer_name TEXT NOT NULL DEFAULT '',
    challenge_method TEXT NOT NULL DEFAULT 'cname_delegation',
    dns_credential_id TEXT NOT NULL DEFAULT '',
    cname_delegation_token TEXT NOT NULL DEFAULT '',
    cname_delegation_target TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending_validation',
    auto_renew INTEGER NOT NULL DEFAULT 1,
    renew_before_days INTEGER NOT NULL DEFAULT 30,
    upstream_order_url TEXT NOT NULL DEFAULT '',
    upstream_finalize_url TEXT NOT NULL DEFAULT '',
    challenges_json TEXT NOT NULL DEFAULT '[]',
    serial_hex TEXT NOT NULL DEFAULT '',
    fingerprint_sha256 TEXT NOT NULL DEFAULT '',
    not_before BIGINT NOT NULL DEFAULT 0,
    not_after BIGINT NOT NULL DEFAULT 0,
    cert_pem TEXT NOT NULL DEFAULT '',
    chain_pem TEXT NOT NULL DEFAULT '',
    private_key_enc TEXT NOT NULL DEFAULT '',
    deploy_webhook_url TEXT NOT NULL DEFAULT '',
    deploy_webhook_secret_enc TEXT NOT NULL DEFAULT '',
    deploy_webhook_secret_prefix TEXT NOT NULL DEFAULT '',
    last_deploy_at BIGINT NOT NULL DEFAULT 0,
    last_deploy_status TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    last_renewed_at BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_managed_certs_owner ON managed_certificates(owner_username);
CREATE INDEX IF NOT EXISTS idx_managed_certs_not_after ON managed_certificates(not_after);

CREATE TABLE IF NOT EXISTS managed_deploy_logs (
    id TEXT PRIMARY KEY,
    cert_id TEXT NOT NULL,
    owner_username TEXT NOT NULL,
    common_name TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_managed_logs_owner ON managed_deploy_logs(owner_username);
CREATE INDEX IF NOT EXISTS idx_managed_logs_created ON managed_deploy_logs(created_at);


