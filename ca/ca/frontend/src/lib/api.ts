import type { CertProfile, UserRole } from './pki-utils';
import type { PowChallenge } from './pow';

export interface AuthoritySummary {
  tier: string;
  subject_dn: string;
  serial_hex: string;
  fingerprint_sha256: string;
  algorithm: string;
  not_before: number;
  not_after: number;
  cert_pem: string;
}

export interface CacheStatus {
  mode: string;
  redis_configured: boolean;
  redis_healthy: boolean;
  circuit_open_until: number;
  fallback_sql_active: boolean;
}

export type OAuthProvider = 'wimotek' | 'microsoft' | 'github' | 'google';

export interface SocialAccount {
  provider: OAuthProvider;
  provider_id: string;
  email: string;
  display_name: string;
  linked_at: number;
}

export interface PasskeyRecord {
  id: string;
  name: string;
  credential_id: string;
  device_type: string;
  created_at: number;
  last_used_at: number;
}

export interface UserProfile {
  username: string;
  role: UserRole;
  cert_quota: number;
  active_certs?: number;
  full_name: string;
  email: string;
  email_verified?: boolean;
  upn: string;
  organization: string;
  department: string;
  country: string;
  province: string;
  locality: string;
  enabled: boolean;
  mfa_email_enabled?: boolean;
  mfa_passkey_enabled?: boolean;
  social_accounts?: SocialAccount[];
  passkeys?: PasskeyRecord[];
  webhook_key_prefix?: string;
  created_at?: number;
  updated_at?: number;
}

export interface OverviewData {
  org_name?: string;
  root_ca: AuthoritySummary;
  issuing_ca: AuthoritySummary;
  active_count: number;
  revoked_count: number;
  expiring_30d: number;
  crl_url: string;
  ocsp_url: string;
  base_url: string;
  db_driver: string;
  data_dir?: string;
  certs_dir?: string;
  tls_mode?: string;
}

export interface CertificateRecord {
  serial_hex: string;
  profile: CertProfile;
  common_name: string;
  subject_dn: string;
  sans_json: string;
  eku_oids_json: string;
  upn: string;
  key_mode: string;
  fingerprint_sha256: string;
  cert_pem: string;
  status: string;
  revoked_at: number;
  revocation_reason: number;
  not_before: number;
  not_after: number;
  issued_by: string;
  created_at: number;
}

export interface AuditRecord {
  id: string;
  actor: string;
  action: string;
  target_serial: string;
  client_ip: string;
  detail_json: string;
  created_at: number;
}

export type TokenScope =
  | 'certs:read'
  | 'certs:issue'
  | 'certs:revoke'
  | 'webhook:send'
  | 'mcp:access';

export interface ApiTokenRecord {
  id: string;
  name: string;
  purpose: string;
  owner_username: string;
  protocol: string;
  scopes: TokenScope[];
  token_prefix: string;
  allowed_profiles_json: string;
  max_ttl_days: number;
  expires_at: number;
  last_used_at: number;
  enabled: boolean;
  created_at: number;
}

export type ProvisionerRecord = ApiTokenRecord;

export interface CRLInfo {
  crl_number: number;
  this_update: number;
  next_update: number;
  revoked_count: number;
  der_bytes: number;
  der_url: string;
  pem_url: string;
}

export interface OCSPCheckResult {
  serial_hex: string;
  common_name?: string;
  status: 'good' | 'revoked' | 'unknown';
  revoked_at?: number;
  revocation_reason?: number;
  checked_at: number;
}

export interface IssueCertPayload {
  profile: CertProfile;
  common_name: string;
  organization?: string;
  department?: string;
  email?: string;
  upn?: string;
  country?: string;
  province?: string;
  locality?: string;
  sans?: string[];
  validity_days?: number;
  csr_pem?: string;
  pfx_password?: string;
}

export interface IssueCertResponse {
  certificate: CertificateRecord;
  chain_pem: string;
  pfx_base64?: string;
  filename: string;
}

export type NotifyChannelType = 'email' | 'serverchan' | 'telegram' | 'webhook';

export interface NotifyChannelConfig {
  smtp_host?: string;
  smtp_port?: number;
  smtp_user?: string;
  smtp_password?: string;
  from_email?: string;
  to_emails?: string;
  use_tls?: boolean;
  sendkey?: string;
  custom_url?: string;
  bot_token?: string;
  chat_id?: string;
  webhook_url?: string;
  webhook_secret?: string;
}

export interface NotifyChannelRecord {
  id: string;
  owner_username?: string;
  name: string;
  channel_type: NotifyChannelType;
  config_masked: string;
  advance_days_json: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface NotifyLogRecord {
  id: string;
  owner_username?: string;
  channel_id: string;
  channel_name: string;
  channel_type: string;
  cert_serial: string;
  cert_cn: string;
  threshold_days: number;
  status: string;
  message: string;
  sent_at: number;
}

export interface ScanSummary {
  checked_certs: number;
  expiring_found: number;
  alerts_sent: number;
  alerts_skipped: number;
  alerts_failed: number;
}

export interface PersonalWebhookInfo {
  username: string;
  webhook_key_prefix: string;
  webhook_key?: string;
  serverchan_url: string;
  rest_url: string;
  enabled_channels: number;
}

export interface WebhookRelayResult {
  code: number;
  message: string;
  data: {
    pushid: string;
    user: string;
    title: string;
    dispatched: number;
    succeeded: number;
    failed: number;
    results: Array<{
      channel_id: string;
      channel_name: string;
      channel_type: string;
      status: string;
      message: string;
    }>;
  };
}

export interface OAuthProviderInfo {
  provider: OAuthProvider;
  label: string;
  configured: boolean;
  callback_url: string;
  issuer?: string;
}

export interface OAuthGatewayConfig {
  issuer: string;
  client_id: string;
  has_client_secret: boolean;
  client_secret_masked: string;
  scopes: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  callback_url: string;
  alias_callback_url: string;
  configured: boolean;
  source: 'database' | 'env' | 'unconfigured';
}

export interface ACMEPolicy {
  require_eab: boolean;
  default_ttl_days: number;
  rate_limit_orders_per_hour: number;
  rate_limit_req_per_min: number;
  allow_wildcard: boolean;
  terms_url: string;
}

export interface ACMEEABRecord {
  kid: string;
  owner_username: string;
  label: string;
  hmac_prefix: string;
  bound_count: number;
  last_used_at: number;
  enabled: boolean;
  created_at: number;
}

export interface ACMEAccountRecord {
  id: string;
  owner_username: string;
  eab_kid: string;
  jwk_thumbprint: string;
  contacts_json: string;
  status: string;
  created_at: number;
}

export interface ACMEOrderRecord {
  id: string;
  account_id: string;
  owner_username: string;
  status: string;
  identifiers_json: string;
  expires_at: number;
  cert_serial: string;
  error_json: string;
  created_at: number;
}

export interface ACMEOverviewResponse {
  directory_url: string;
  policy: ACMEPolicy;
  credentials: ACMEEABRecord[];
  accounts: ACMEAccountRecord[];
  orders: ACMEOrderRecord[];
  manual_active_certs: number;
  manual_quota: number;
  acme_active_certs: number;
  acme_quota: number;
}

export type UpstreamProviderType =
  | 'letsencrypt_prod'
  | 'letsencrypt_staging'
  | 'google_trust'
  | 'zerossl'
  | 'custom';

export type ManagedChallengeMethod = 'cname_delegation' | 'dns_api' | 'dns_manual' | 'http_01';
export type ManagedEngineMode = 'upstream_public' | 'private_ca';
export type DnsProviderType = 'cloudflare' | 'aliyun' | 'dnspod' | 'webhook';

export interface ManagedUpstreamRecord {
  id: string;
  name: string;
  provider: UpstreamProviderType;
  directory_url: string;
  requires_eab: boolean;
  eab_kid: string;
  eab_hmac_configured: boolean;
  eab_hmac_prefix: string;
  contact_email: string;
  priority: number;
  enabled: boolean;
  account_registered: boolean;
  last_probe_at: number;
  last_probe_ok: boolean;
  last_probe_ms: number;
  last_probe_error: string;
  created_at: number;
  updated_at: number;
}

export interface ManagedDnsCredential {
  id: string;
  owner_username: string;
  name: string;
  provider: DnsProviderType;
  zone_hint: string;
  secret_prefix: string;
  created_at: number;
  updated_at: number;
}

export interface ManagedChallengeRecord {
  domain: string;
  method: ManagedChallengeMethod;
  record_type: 'CNAME' | 'TXT' | 'HTTP';
  record_host: string;
  record_value: string;
  delegation_cname_host?: string;
  delegation_cname_target?: string;
  status: 'pending' | 'valid' | 'invalid';
  last_error?: string;
}

export interface ManagedCertificateRecord {
  id: string;
  owner_username: string;
  common_name: string;
  domains: string[];
  engine_mode: ManagedEngineMode;
  upstream_id: string;
  resolved_upstream_id: string;
  resolved_issuer_name: string;
  challenge_method: ManagedChallengeMethod;
  dns_credential_id: string;
  cname_delegation_token: string;
  cname_delegation_target: string;
  status: 'pending_validation' | 'issuing' | 'active' | 'renewing' | 'error' | 'revoked';
  auto_renew: boolean;
  renew_before_days: number;
  challenges: ManagedChallengeRecord[];
  serial_hex: string;
  fingerprint_sha256: string;
  not_before: number;
  not_after: number;
  cert_pem: string;
  chain_pem: string;
  has_private_key: boolean;
  deploy_webhook_url: string;
  deploy_webhook_secret_prefix: string;
  has_deploy_secret: boolean;
  last_deploy_at: number;
  last_deploy_status: string;
  last_error: string;
  last_renewed_at: number;
  created_at: number;
  updated_at: number;
}

export interface ManagedDeployLog {
  id: string;
  cert_id: string;
  owner_username: string;
  common_name: string;
  action: string;
  target: string;
  status: 'ok' | 'error';
  detail: string;
  created_at: number;
}

export interface ManagedProxyPolicy {
  mode: 'dual_engine' | 'private_ca' | 'upstream_proxy';
  auto_failover: boolean;
  default_renew_before_days: number;
  cname_delegation_zone: string;
  allow_private_webhooks?: boolean;
}

export interface ManagedOverviewResponse {
  proxy_policy: ManagedProxyPolicy;
  proxy_base_url: string;
  upstreams: ManagedUpstreamRecord[];
  dns_credentials: ManagedDnsCredential[];
  certificates: ManagedCertificateRecord[];
  deploy_logs: ManagedDeployLog[];
  stats: {
    total_certs: number;
    active_certs: number;
    pending_certs: number;
    due_renewal: number;
    enabled_upstreams: number;
  };
}

export interface SetupWizardPayload {
  username: string;
  password: string;
  org_name?: string;
  base_url?: string;
  full_name?: string;
  email?: string;
  upn?: string;
  department?: string;
  country?: string;
  province?: string;
  locality?: string;
  default_lang?: string;
  notify_name?: string;
  notify_type?: NotifyChannelType | '';
  notify_config?: NotifyChannelConfig;
  advance_days?: number[];
}

export interface AuthResponse {
  token?: string;
  username?: string;
  role?: UserRole;
  user?: UserProfile;
  mfa_required?: boolean;
  mfa_token?: string;
  methods?: Array<'passkey' | 'email'>;
  email_masked?: string;
  preview_email_code?: string;
}

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has('Content-Type') && init.body) {
      headers.set('Content-Type', 'application/json');
    }
    if (!headers.has('X-Requested-With')) {
      headers.set('X-Requested-With', 'XMLHttpRequest');
    }
    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }
    const res = await fetch(path, { credentials: 'same-origin', ...init, headers });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: text || res.statusText };
    }
    if (!res.ok) {
      const err = new Error(parsed?.error || `HTTP ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return parsed as T;
  }

  getAuthStatus() {
    return this.request<{
      needs_setup: boolean;
      preview_mode?: boolean;
      org_name?: string;
      base_url?: string;
      languages: string[];
      oauth_providers?: OAuthProviderInfo[];
    }>('/api/auth/status');
  }

  getSession() {
    return this.request<{
      authenticated: boolean;
      token?: string;
      username?: string;
      role?: UserRole;
      user?: UserProfile;
      preview_mode?: boolean;
    }>('/api/auth/session');
  }

  logout() {
    return this.request<{ logged_out: boolean }>('/api/auth/logout', {
      method: 'POST',
    });
  }

  demoQuickLogin(username?: string) {
    return this.request<AuthResponse>('/api/demo/quick-login', {
      method: 'POST',
      body: JSON.stringify(username ? { username } : {}),
    });
  }

  setupAdmin(payload: SetupWizardPayload) {
    return this.request<AuthResponse>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  getPowChallenge() {
    return this.request<PowChallenge>('/api/auth/challenge');
  }

  login(username: string, password: string, challenge: string, solution: string) {
    return this.request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, challenge, solution }),
    });
  }

  // Self-Registration & Email Verification
  sendRegisterEmailCode(email: string) {
    return this.request<{ sent: boolean; expires_in: number; delivery: string; preview_code?: string }>(
      '/api/auth/email/send-code',
      {
        method: 'POST',
        body: JSON.stringify({ email, purpose: 'register' }),
      }
    );
  }

  register(payload: {
    username: string;
    password: string;
    email: string;
    email_code: string;
    full_name?: string;
    challenge: string;
    solution: string;
  }) {
    return this.request<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  // 2FA: Email OTP & Passkeys
  sendLoginMfaEmail(mfaToken: string) {
    return this.request<{ sent: boolean; delivery: string; email_masked: string; preview_code?: string }>(
      '/api/auth/mfa/email/send',
      {
        method: 'POST',
        body: JSON.stringify({ mfa_token: mfaToken }),
      }
    );
  }

  verifyMfaEmail(mfaToken: string, code: string) {
    return this.request<AuthResponse>('/api/auth/mfa/email/verify', {
      method: 'POST',
      body: JSON.stringify({ mfa_token: mfaToken, code }),
    });
  }

  getPasskeyLoginOptions(username?: string, mfaToken?: string) {
    return this.request<{
      challenge: string;
      rpId: string;
      allowCredentials: Array<{ id: string; type: 'public-key' }>;
      challenge_id: string;
    }>('/api/auth/passkey/login/options', {
      method: 'POST',
      body: JSON.stringify({ username, mfa_token: mfaToken }),
    });
  }

  verifyPasskeyLogin(payload: {
    challenge_id: string;
    credential_id: string;
    client_data_json?: string;
    authenticator_data?: string;
    signature?: string;
    mfa_token?: string;
    simulated?: boolean;
  }) {
    return this.request<AuthResponse>('/api/auth/passkey/login/verify', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  getPasskeyRegisterOptions(name: string) {
    return this.request<{
      challenge: string;
      challenge_id: string;
      rp: { name: string; id: string };
      user: { id: string; name: string; displayName: string };
      excludeCredentials: Array<{ id: string; type: 'public-key' }>;
    }>('/api/auth/passkey/register/options', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  verifyPasskeyRegister(payload: {
    challenge_id: string;
    name: string;
    credential_id: string;
    public_key?: string;
    device_type?: string;
    simulated?: boolean;
  }) {
    return this.request<{ passkey: PasskeyRecord; user: UserProfile }>('/api/auth/passkey/register/verify', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  deletePasskey(id: string) {
    return this.request<{ deleted: boolean; user: UserProfile }>(
      `/api/auth/passkey/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
  }

  updateMfaSettings(payload: { mfa_email_enabled?: boolean; mfa_passkey_enabled?: boolean }) {
    return this.request<{ user: UserProfile }>('/api/profile/mfa', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  // Unified OAuth Gateway (wimotek/oauth PKCE S256 + optional direct IdPs)
  getOAuthProviders() {
    return this.request<{ providers: OAuthProviderInfo[] }>('/api/auth/oauth/providers');
  }

  getOAuthUrl(provider: OAuthProvider, mode: 'login' | 'bind') {
    return this.request<{
      url?: string;
      configured: boolean;
      callback_url: string;
      issuer?: string;
      pkce?: string;
      preview_mode?: boolean;
    }>(`/api/auth/oauth/${encodeURIComponent(provider)}/url?mode=${encodeURIComponent(mode)}`);
  }

  demoOAuthSimulate(provider: OAuthProvider, mode: 'login' | 'bind', email?: string, displayName?: string) {
    return this.request<AuthResponse & { linked?: boolean }>(`/api/demo/oauth/${encodeURIComponent(provider)}`, {
      method: 'POST',
      body: JSON.stringify({ mode, email, display_name: displayName }),
    });
  }

  unlinkSocialAccount(provider: OAuthProvider) {
    return this.request<{ unlinked: boolean; user: UserProfile }>(
      `/api/profile/social/${encodeURIComponent(provider)}`,
      { method: 'DELETE' }
    );
  }

  getOAuthGatewayConfig() {
    return this.request<{ gateway: OAuthGatewayConfig }>('/api/admin/oauth/gateway');
  }

  saveOAuthGatewayConfig(payload: {
    issuer: string;
    client_id: string;
    client_secret?: string;
    clear_secret?: boolean;
    scopes?: string;
    authorization_endpoint?: string;
    token_endpoint?: string;
    userinfo_endpoint?: string;
  }) {
    return this.request<{ gateway: OAuthGatewayConfig; providers?: OAuthProviderInfo[] }>(
      '/api/admin/oauth/gateway',
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      }
    );
  }

  // Profile & Email Change Verification
  getProfile() {
    return this.request<{ user: UserProfile }>('/api/profile');
  }

  updateProfile(profile: Partial<UserProfile> & { email_code?: string }) {
    return this.request<{ user: UserProfile }>('/api/profile', {
      method: 'PUT',
      body: JSON.stringify(profile),
    });
  }

  sendProfileEmailCode(email: string) {
    return this.request<{ sent: boolean; expires_in: number; delivery: string; preview_code?: string }>(
      '/api/profile/email/send-code',
      {
        method: 'POST',
        body: JSON.stringify({ email }),
      }
    );
  }

  verifyProfileEmail(email: string, code: string) {
    return this.request<{ verified: boolean; user: UserProfile }>('/api/profile/email/verify', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    });
  }

  // Overview & Users
  getOverview() {
    return this.request<{
      overview: OverviewData;
      cache: CacheStatus;
      recent_audits: AuditRecord[];
      current_user?: UserProfile;
    }>('/api/ca/overview');
  }

  listUsers() {
    return this.request<{ users: UserProfile[] }>('/api/users');
  }

  saveUser(payload: Partial<UserProfile> & { username: string; password?: string }) {
    return this.request<{ user: UserProfile }>('/api/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  deleteUser(username: string) {
    return this.request<{ deleted: boolean }>(`/api/users/${encodeURIComponent(username)}`, {
      method: 'DELETE',
    });
  }

  // Notifications & Personal Webhook Relay
  listNotifyChannels() {
    return this.request<{ channels: NotifyChannelRecord[] }>('/api/notifications/channels');
  }

  saveNotifyChannel(payload: {
    id?: string;
    name: string;
    channel_type: NotifyChannelType;
    config: NotifyChannelConfig;
    advance_days: number[];
    enabled: boolean;
  }) {
    return this.request<{ channel: NotifyChannelRecord }>('/api/notifications/channels', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  deleteNotifyChannel(id: string) {
    return this.request<{ deleted: boolean }>(`/api/notifications/channels/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  testNotifyChannel(id: string) {
    return this.request<{ log: NotifyLogRecord }>(
      `/api/notifications/channels/${encodeURIComponent(id)}/test`,
      { method: 'POST' }
    );
  }

  scanExpiring() {
    return this.request<{ summary: ScanSummary }>('/api/notifications/scan', {
      method: 'POST',
    });
  }

  listNotifyLogs() {
    return this.request<{ logs: NotifyLogRecord[] }>('/api/notifications/logs');
  }

  getMyWebhook() {
    return this.request<{ webhook: PersonalWebhookInfo }>('/api/webhook/me');
  }

  rotateMyWebhookKey() {
    return this.request<{ webhook: PersonalWebhookInfo }>('/api/webhook/rotate', {
      method: 'POST',
    });
  }

  sendWebhookMessage(payload: {
    title: string;
    desp?: string;
    short?: string;
    tags?: string;
    channel?: string;
  }) {
    return this.request<WebhookRelayResult>('/api/webhook/send', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  // Certificates & Automation
  listCertificates() {
    return this.request<{ certificates: CertificateRecord[] }>('/api/certificates');
  }

  listExpiringCertificates(days = 30) {
    return this.request<{ days: number; certificates: CertificateRecord[] }>(
      `/api/certificates/expiring?days=${encodeURIComponent(String(days))}`
    );
  }

  issueCertificate(payload: IssueCertPayload) {
    return this.request<IssueCertResponse>('/api/certificates', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  renewCertificate(serialHex: string, payload?: { validity_days?: number; revoke_old?: boolean; pfx_password?: string }) {
    return this.request<IssueCertResponse & { old_serial_revoked?: boolean }>(
      `/api/certificates/${encodeURIComponent(serialHex)}/renew`,
      {
        method: 'POST',
        body: JSON.stringify(payload || {}),
      }
    );
  }

  revokeCertificate(serialHex: string, reason: number) {
    return this.request<{ revoked: boolean; serial_hex: string; cache_purged: boolean }>(
      `/api/certificates/${encodeURIComponent(serialHex)}/revoke`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }
    );
  }

  getCRLInfo() {
    return this.request<CRLInfo>('/api/crl/info');
  }

  checkOCSP(serialHex: string) {
    return this.request<OCSPCheckResult>('/api/ocsp/check', {
      method: 'POST',
      body: JSON.stringify({ serial_hex: serialHex }),
    });
  }

  // Multi-Purpose User API Tokens (compatible with /api/provisioners)
  listTokens() {
    return this.request<{ tokens: ApiTokenRecord[] }>('/api/tokens');
  }

  createToken(payload: {
    name: string;
    purpose?: string;
    scopes?: TokenScope[];
    max_ttl_days?: number;
    expires_in_days?: number;
  }) {
    return this.request<{ token_record: ApiTokenRecord; token: string }>('/api/tokens', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  deleteToken(id: string) {
    return this.request<{ deleted: boolean }>(`/api/tokens/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  listProvisioners() {
    return this.request<{ provisioners: ProvisionerRecord[] }>('/api/provisioners');
  }

  createProvisioner(name: string, protocol: string, maxTtlDays: number) {
    return this.request<{ provisioner: ProvisionerRecord; token: string }>('/api/provisioners', {
      method: 'POST',
      body: JSON.stringify({ name, protocol, max_ttl_days: maxTtlDays }),
    });
  }

  deleteProvisioner(id: string) {
    return this.request<{ deleted: boolean }>(`/api/provisioners/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  // MCP JSON-RPC 2.0 Client Helper (for Live Tester)
  callMcp(method: string, params: Record<string, unknown> = {}) {
    return this.request<{ jsonrpc: string; id: string | number; result?: any; error?: { code: number; message: string } }>(
      '/mcp',
      {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params,
        }),
      }
    );
  }

  listAudits() {
    return this.request<{ audits: AuditRecord[] }>('/api/audit');
  }

  // Commercial ACME v2 & EAB (External Account Binding) Management
  getAcmeOverview(all = false) {
    return this.request<ACMEOverviewResponse>(`/api/acme/eab${all ? '?all=1' : ''}`);
  }

  createAcmeEab(label: string) {
    return this.request<{ credential: ACMEEABRecord; eab_kid: string; eab_hmac: string }>(
      '/api/acme/eab',
      {
        method: 'POST',
        body: JSON.stringify({ label }),
      }
    );
  }

  deleteAcmeEab(kid: string) {
    return this.request<{ deleted: string }>(`/api/acme/eab/${encodeURIComponent(kid)}`, {
      method: 'DELETE',
    });
  }

  updateAcmePolicy(payload: Partial<ACMEPolicy>) {
    return this.request<{ directory_url: string; policy: ACMEPolicy }>('/api/acme/policy', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  // Public Trusted CA ACME Proxy & Managed SSL Hosting
  getManagedOverview(all = false) {
    return this.request<ManagedOverviewResponse>(`/api/managed/overview${all ? '?all=1' : ''}`);
  }

  updateManagedPolicy(payload: Partial<ManagedProxyPolicy>) {
    return this.request<{ proxy_policy: ManagedProxyPolicy }>('/api/managed/proxy-policy', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  saveManagedUpstream(payload: {
    id?: string;
    name: string;
    provider: UpstreamProviderType;
    directory_url: string;
    requires_eab: boolean;
    eab_kid?: string;
    eab_hmac?: string;
    contact_email?: string;
    priority?: number;
    enabled?: boolean;
  }) {
    return this.request<{ upstream: ManagedUpstreamRecord }>('/api/managed/upstreams', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  deleteManagedUpstream(id: string) {
    return this.request<{ deleted: string }>(`/api/managed/upstreams/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  probeManagedUpstream(id: string) {
    return this.request<{
      ok: boolean;
      latency_ms: number;
      directory?: { newNonce: string; newAccount: string; newOrder: string; externalAccountRequired: boolean };
      upstream: ManagedUpstreamRecord;
    }>(`/api/managed/upstreams/${encodeURIComponent(id)}/probe`, {
      method: 'POST',
    });
  }

  createManagedDnsCred(payload: {
    name: string;
    provider: DnsProviderType;
    zone_hint?: string;
    api_token?: string;
    access_key_id?: string;
    access_key_secret?: string;
  }) {
    return this.request<{ credential: ManagedDnsCredential }>('/api/managed/dns-credentials', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  deleteManagedDnsCred(id: string) {
    return this.request<{ deleted: string }>(`/api/managed/dns-credentials/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  createManagedCert(payload: {
    domains: string[];
    engine_mode: ManagedEngineMode;
    upstream_id?: string;
    challenge_method: ManagedChallengeMethod;
    dns_credential_id?: string;
    auto_renew?: boolean;
    renew_before_days?: number;
    deploy_webhook_url?: string;
    deploy_webhook_secret?: string;
  }) {
    return this.request<{ certificate: ManagedCertificateRecord }>('/api/managed/certs', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  verifyManagedCert(id: string) {
    return this.request<{ certificate: ManagedCertificateRecord }>(
      `/api/managed/certs/${encodeURIComponent(id)}/verify`,
      { method: 'POST' }
    );
  }

  renewManagedCert(id: string) {
    return this.request<{ certificate: ManagedCertificateRecord }>(
      `/api/managed/certs/${encodeURIComponent(id)}/renew`,
      { method: 'POST' }
    );
  }

  checkManagedCertDns(id: string) {
    return this.request<{
      all_matched: boolean;
      checks: Array<{ domain: string; host: string; expected: string; observed: string[]; matched: boolean }>;
    }>(`/api/managed/certs/${encodeURIComponent(id)}/check-dns`, { method: 'POST' });
  }

  deployManagedCert(id: string) {
    return this.request<{ ok: boolean; status: number; detail: string; certificate: ManagedCertificateRecord }>(
      `/api/managed/certs/${encodeURIComponent(id)}/deploy`,
      { method: 'POST' }
    );
  }

  downloadManagedBundle(id: string) {
    return this.request<{
      id: string;
      common_name: string;
      serial_hex: string;
      cert_pem: string;
      chain_pem: string;
      private_key_pem: string;
    }>(`/api/managed/certs/${encodeURIComponent(id)}/bundle`);
  }

  deleteManagedCert(id: string) {
    return this.request<{ deleted: string }>(`/api/managed/certs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  scanRenewManagedCerts() {
    return this.request<{ scanned: number; due: number; renewed: string[]; failed?: Array<{ id: string; error: string }> }>(
      '/api/managed/scan-renew',
      { method: 'POST' }
    );
  }
}

export const api = new ApiClient();
