export type LanguageCode = 'zh-CN' | 'en' | 'ja' | 'de' | 'es';

export type DnsProviderType =
  | 'cloudflare'
  | 'dnspod'
  | 'aliyun'
  | 'route53'
  | 'porkbun'
  | 'namecheap'
  | 'huawei'
  | 'webhook';

export interface DnsProvider {
  id: string;
  name: string;
  type: DnsProviderType;
  zoneId?: string;
  domain?: string;
  endpointUrl?: string;
  accountEmail?: string;
  hasSecret: boolean;
  secretPreview?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DnsZoneSummary {
  id: string;
  name: string;
  status: string;
}

export interface DnsIpv6Target {
  id: string;
  recordName: string;
  address: string;
  proxied?: boolean;
  enabled: boolean;
  ociIpv6Id?: string;
  lastSyncedAt?: string;
  lastStatus?: 'synced' | 'failed' | 'pending' | 'dry_run';
  lastMessage?: string;
}

export interface DnsSyncRule {
  id: string;
  name: string;
  providerId: string;
  domain: string;
  resolvedZoneId?: string;
  recordName: string;
  ttl: number;
  proxied: boolean;
  line: string;
  syncIpv4: boolean;
  ipv4Address: string;
  ipv4Source: 'manual' | 'auto_public' | 'cloud_host';
  syncIpv6: boolean;
  ipv6Mode: 'round_robin' | 'per_host';
  ipv6Targets: DnsIpv6Target[];
  linkedHostId?: string;
  // Real OCI VNIC binding so IP add/swap/delete executes against Oracle Cloud API
  ociProfileId?: string;
  ociInstanceId?: string;
  ociInstanceName?: string;
  ociVnicId?: string;
  ociPrimaryPrivateIpId?: string;
  ociPublicIpId?: string;
  ociPublicIpLifetime?: 'EPHEMERAL' | 'RESERVED';
  dryRun: boolean;
  enabled: boolean;
  lastSyncedAt?: string;
  lastStatus?: 'synced' | 'partial' | 'failed' | 'pending' | 'dry_run';
  lastMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'NS' | 'SRV' | 'CAA' | 'PTR';

export interface ManagedDnsRecord {
  id: string;
  providerId: string;
  domain: string;
  zoneId?: string;
  remoteRecordId?: string;
  name: string;
  fqdn: string;
  type: DnsRecordType;
  content: string;
  ttl: number;
  proxied?: boolean;
  priority?: number;
  line?: string;
  groupName: string;
  notes?: string;
  source: 'remote_sync' | 'manual';
  syncState: 'synced' | 'local_only' | 'error';
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedDomain {
  id: string;
  providerId: string;
  domain: string;
  zoneId?: string;
  status: string;
  nameServers: string[];
  originalNameServers?: string[];
  currentLiveNs?: string[];
  nsVerified?: boolean;
  nsCheckedAt?: string;
  nsNote?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DnsPullPolicy {
  /** Active filter mode: mutually exclusive whitelist or blacklist, or none */
  filterMode: 'none' | 'whitelist' | 'blacklist';
  /** Active pattern list matching filterMode */
  patterns: string[];
  /** Whitelist patterns (mutually exclusive with blacklistPatterns) */
  whitelistPatterns?: string[];
  /** Blacklist patterns (mutually exclusive with whitelistPatterns) */
  blacklistPatterns?: string[];
  /** Empty means all record types are allowed */
  recordTypes: DnsRecordType[];
  updatedAt?: string;
}

export interface DnsPullSnapshot {
  id: string;
  createdAt: string;
  providerId: string;
  providerName: string;
  scope: 'single' | 'all';
  domain?: string;
  domains: string[];
  recordCount: number;
  filteredOutCount?: number;
  filterSummary?: string;
  records: ManagedDnsRecord[];
}

export interface OciProfile {
  id: string;
  name: string;
  region: string;
  homeRegion?: string;
  tenancyOcid: string;
  userOcid: string;
  compartmentOcid: string;
  fingerprint: string;
  subnetOcid: string;
  availabilityDomains: string[];
  hasPrivateKey: boolean;
  privateKeyPreview?: string;
  instanceCount: number;
  status: 'active' | 'unverified' | 'error';
  lastCheckedAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OciRegionSummary {
  regionName: string;
  regionKey: string;
  status: string;
  isHomeRegion: boolean;
}

export interface OciCompartmentSummary {
  id: string;
  name: string;
  description?: string;
}

export interface OciSubnetSummary {
  id: string;
  displayName: string;
  cidrBlock: string;
  ipv6CidrBlock?: string;
  isPublic: boolean;
  vcnId: string;
}

export interface OciDiscoveredResources {
  fingerprint: string;
  homeRegion?: string;
  regions: OciRegionSummary[];
  compartments: OciCompartmentSummary[];
  availabilityDomains: string[];
  subnets: OciSubnetSummary[];
  instanceCount: number;
}

export interface OciImageSummary {
  id: string;
  displayName: string;
  operatingSystem: string;
  operatingSystemVersion: string;
  timeCreated?: string;
}

export interface OciVnicSummary {
  instanceId: string;
  instanceName: string;
  instanceShape: string;
  instanceState: string;
  availabilityDomain: string;
  vnicId: string;
  vnicName: string;
  subnetId: string;
  isPrimary: boolean;
  privateIp: string;
  primaryPrivateIpId: string;
  publicIp?: string;
  publicIpId?: string;
  publicIpLifetime?: 'EPHEMERAL' | 'RESERVED';
  ipv6s: Array<{ id: string; ipAddress: string }>;
}

export interface OciSniperTask {
  id: string;
  name: string;
  profileId: string;
  displayName: string;
  shape: 'VM.Standard.A1.Flex' | 'VM.Standard.E2.1.Micro';
  ocpus: number;
  memoryInGBs: number;
  bootVolumeSizeInGBs: number;
  imageOcid: string;
  osPreset: string;
  sshPublicKey: string;
  availabilityDomains: string[];
  assignPublicIp: boolean;
  assignIpv6: boolean;
  /** Adaptive AIMD 429 avoidance + jitter (recommended default: true) */
  adaptiveInterval?: boolean;
  /** Minimum interval in seconds when unthrottled (default: 20s) */
  minIntervalSeconds?: number;
  /** Base / initial interval in seconds (default: 30s) */
  intervalSeconds: number;
  /** Maximum adaptive ceiling on repeated 429s (default: 120s) */
  maxIntervalSeconds?: number;
  /** Increment added to current interval on HTTP 429 (default: +15s) */
  stepUp429Seconds?: number;
  /** Decrement subtracted after consecutive non-429 attempts (default: -5s) */
  stepDownOkSeconds?: number;
  /** Current runtime interval chosen by adaptive controller */
  currentIntervalSeconds?: number;
  consecutive429Count?: number;
  consecutiveOkCount?: number;
  jitterPercent: number;
  retryOnOutOfCapacity: boolean;
  backoffOn429Seconds: number;
  maxAttempts: number;
  autoStopOnSuccess: boolean;
  autoBindDnsRuleId?: string;
  /** Uses system-wide notification channels configured in Notifications Center */
  useSystemNotifications: boolean;
  /** Optional subset of system NotificationChannel IDs; empty = all enabled channels matching event */
  notifyChannelIds: string[];
  status: 'running' | 'paused' | 'succeeded' | 'failed';
  attempts: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  lastResponseCode?: number;
  lastMessage?: string;
  createdInstanceId?: string;
  createdPublicIp?: string;
  createdAt: string;
  updatedAt: string;
}

export type ManagedCloudProvider = 'oracle' | 'aws' | 'aliyun' | 'gcp';
export type ExternalCloudProvider = 'aws' | 'aliyun' | 'gcp';

export type CloudProviderType =
  | 'oracle'
  | 'aws'
  | 'digitalocean'
  | 'vultr'
  | 'hetzner'
  | 'linode'
  | 'aliyun'
  | 'tencent'
  | 'gcp'
  | 'custom';

export type OciInstanceAction = 'SOFTRESET' | 'RESET' | 'START' | 'SOFTSTOP' | 'STOP';

export interface CloudAccount {
  id: string;
  name: string;
  provider: ExternalCloudProvider;
  region: string;
  zone?: string;
  projectId?: string;
  clientEmail?: string;
  accessKeyIdPreview?: string;
  hasCredentials: boolean;
  instanceCount: number;
  status: 'active' | 'unverified' | 'error';
  lastCheckedAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudDiscoveredInstance {
  provider: ManagedCloudProvider;
  instanceId: string;
  displayName: string;
  region: string;
  zone?: string;
  shape: string;
  architecture: 'arm64' | 'x86_64';
  specs: string;
  lifecycleState: string;
  networkInterfaceId?: string;
  privateIp?: string;
  publicIp?: string;
  eipAllocationId?: string;
  eipAssociationId?: string;
  ipv6List: string[];
  alreadyImported: boolean;
  importedHostId?: string;
}

export interface OciDiscoveredInstance {
  instanceId: string;
  displayName: string;
  region: string;
  availabilityDomain: string;
  shape: string;
  ocpus?: number;
  memoryInGBs?: number;
  architecture: 'arm64' | 'x86_64';
  specs: string;
  lifecycleState: string;
  vnicId?: string;
  primaryPrivateIpId?: string;
  privateIp?: string;
  publicIp?: string;
  publicIpId?: string;
  publicIpLifetime?: 'EPHEMERAL' | 'RESERVED';
  ipv6List: string[];
  ipv6Entries?: Array<{ id: string; ipAddress: string }>;
  timeCreated?: string;
  alreadyImported: boolean;
  importedHostId?: string;
}

export interface CloudHost {
  id: string;
  name: string;
  groupName?: string;
  provider: CloudProviderType;
  region: string;
  instanceId: string;
  architecture: 'arm64' | 'x86_64';
  specs: string;
  ipv4: string;
  ipv6List: string[];
  sshPort: number;
  sshUser: string;
  linkedDnsRuleId?: string;
  linkedDnsRuleIds?: string[];
  // OCI bindings
  ociProfileId?: string;
  ociVnicId?: string;
  ociPrimaryPrivateIpId?: string;
  ociPublicIpId?: string;
  ociPublicIpLifetime?: 'EPHEMERAL' | 'RESERVED';
  ociIpv6Entries?: Array<{ id: string; ipAddress: string }>;
  ociLifecycleState?: string;
  availabilityDomain?: string;
  // Multi-cloud bindings (AWS EC2 / Aliyun ECS / GCP Compute Engine)
  cloudAccountId?: string;
  cloudZone?: string;
  cloudNetworkInterfaceId?: string;
  cloudEipAllocationId?: string;
  cloudAllocationAssociationId?: string;
  status: 'online' | 'degraded' | 'offline' | 'provisioning';
  lastCheckedAt?: string;
  lastLatencyMs?: number;
  lastProbeMessage?: string;
  notes?: string;
  hasApiSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedIpRecord {
  id: string;
  address: string;
  version: 'ipv4' | 'ipv6';
  label: string;
  domain?: string;
  dnsRuleId?: string;
  hostId?: string;
  hostName?: string;
  provider?: CloudProviderType;
  region?: string;
  ociProfileId?: string;
  ociVnicId?: string;
  ociResourceId?: string;
  ociPrivateIpId?: string;
  ociLifetime?: 'EPHEMERAL' | 'RESERVED' | 'IPV6';
  linkedDnsRuleIds: string[];
  status: 'active' | 'replaced' | 'standby';
  previousAddress?: string;
  replacedAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export type MonitorProbeType = 'http' | 'https' | 'tcp' | 'dns';

export interface MonitorCheckSample {
  timestamp: string;
  status: 'up' | 'degraded' | 'down';
  latencyMs: number;
  message: string;
}

export interface MonitorTarget {
  id: string;
  name: string;
  groupName?: string;
  type: MonitorProbeType;
  target: string; // IP, host:port, URL, or FQDN
  port?: number; // used for TCP probes
  expectedIp?: string; // used for DNS drift probes
  httpMethod?: 'GET' | 'HEAD'; // HTTP/HTTPS request method (default GET)
  httpKeyword?: string; // optional body keyword assertion for HTTP(S) probes
  expectedStatusCodes?: string; // e.g. "200-399" or "200,204"
  /** Ignore TLS/SSL certificate errors (self-signed, expired, hostname mismatch) for HTTPS websites */
  ignoreTlsErrors?: boolean;
  /** Inspect SSL/TLS certificate expiration for HTTPS URLs (default true) */
  checkTlsCert?: boolean;
  /** Warn/notify when certificate expires within N days (default 14) */
  tlsCertWarningDays?: number;
  tlsCertExpiry?: string;
  tlsDaysRemaining?: number;
  tlsCertIssuer?: string;
  tlsCertSubject?: string;
  tlsCertCheckedAt?: string;
  tlsCertError?: string;
  lastTlsAlertAt?: string;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  enabled: boolean;
  notifyOnAlert: boolean;
  notifyOnDown?: boolean;
  notifyOnRecover?: boolean;
  notifyChannelIds?: string[];
  linkedHostId?: string;
  linkedIpId?: string;
  status: 'up' | 'degraded' | 'down' | 'pending';
  consecutiveFailures: number;
  lastCheckedAt?: string;
  lastLatencyMs?: number;
  lastMessage?: string;
  uptimePercent: number;
  history: MonitorCheckSample[];
  createdAt: string;
  updatedAt: string;
}

export type NotificationChannelType =
  | 'email'
  | 'serverchan'
  | 'telegram'
  | 'bark'
  | 'discord'
  | 'webhook';

export type NotificationEventType =
  | 'oci_sniper_success'
  | 'oci_sniper_error'
  | 'monitor_down'
  | 'monitor_recover'
  | 'dns_sync_fail'
  | 'ip_changed'
  | 'audit_prune'
  | 'security_lockout';

export interface NotificationChannel {
  id: string;
  name: string;
  type: NotificationChannelType;
  enabled: boolean;
  events: NotificationEventType[];
  // Email SMTP fields
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  emailFrom?: string;
  emailTo?: string;
  // ServerChan / Telegram / Bark / Discord / Webhook fields
  serverChanVersion?: 'turbo' | 'sc3';
  target?: string; // Telegram chat_id, Bark/Discord/Webhook URL
  hasSecret: boolean;
  secretPreview?: string;
  lastSentAt?: string;
  lastStatus?: 'ok' | 'error';
  lastMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TlsCertificateStatus {
  enabled: boolean;
  source: 'mounted' | 'self_signed' | 'none';
  httpsListening: boolean;
  httpsPort: number;
  certDir: string;
  customCertDir: string;
  activeDir: string;
  certPath?: string;
  keyPath?: string;
  stagedFromReadOnly: boolean;
  readable: boolean;
  permissionIssue?: string;
  subject?: string;
  issuer?: string;
  sanList?: string[];
  validFrom?: string;
  validTo?: string;
  daysRemaining?: number;
  lastLoadedAt?: string;
}

export type CronJobType =
  | 'oci_ip_dns_policy'
  | 'dns_batch_sync'
  | 'oci_sniper_sweep'
  | 'cloud_ip_refresh'
  | 'monitor_sweep'
  | 'audit_cleanup';

export type IpPolicyTargetScope = 'all' | 'group' | 'hosts';

export type IpPolicyAction =
  | 'sync_dns_only'
  | 'swap_ipv4'
  | 'add_ipv6'
  | 'swap_all_ipv6'
  | 'delete_excess_ipv6'
  | 'rotate_dual_stack';

export interface CronIpSyncPolicy {
  scope: IpPolicyTargetScope;
  targetGroups: string[];
  targetHostIds: string[];
  action: IpPolicyAction;
  ipv6Count?: number;
  syncDnsAfter: boolean;
  notifyOnComplete: boolean;
}

export interface CronJob {
  id: string;
  name: string;
  type: CronJobType;
  expression: string;
  targetIds: string[];
  ipPolicy?: CronIpSyncPolicy;
  enabled: boolean;
  /** Built-in / system jobs cannot be deleted (can still be disabled/enabled) */
  systemProtected?: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  lastStatus?: 'success' | 'partial' | 'failed' | 'running';
  lastSummary?: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export type AuditSeverity = 'info' | 'success' | 'warning' | 'error';

export type AuditCategory =
  | 'auth'
  | 'dns'
  | 'oci'
  | 'cloud'
  | 'ip'
  | 'monitor'
  | 'notify'
  | 'tls'
  | 'cron'
  | 'security'
  | 'audit';

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  category: AuditCategory;
  severity: AuditSeverity;
  action: string;
  actor: string;
  ip: string;
  target?: string;
  details: string;
}

export interface AuditStats {
  fileSizeBytes: number;
  maxSizeBytes: number;
  retentionTargetPercent: number;
  totalEntries: number;
  pruneCount: number;
  lastPrunedAt?: string;
  lastPrunedBytes?: number;
}

export interface SecurityConfig {
  maxLoginAttempts: number;
  lockoutMinutes: number;
  rateLimitWindowSeconds: number;
  rateLimitMaxRequests: number;
  captchaDifficulty: 'standard' | 'high';
  powDifficulty: number;
  requireSliderVerify: boolean;
  sliderFailureThreshold?: number;
  minFormDwellMs: number;
  sessionTimeoutMinutes: number;
  maxAuditSizeBytes: number;
  auditRetentionPercent: number;
}

export interface CaptchaChallengeResponse {
  challengeId: string;
  svg: string;
  powSalt: string;
  powDifficulty: number;
  sliderTarget: number;
  requireSlider: boolean;
  failedAttempts?: number;
  sliderThreshold?: number;
  issuedAt: number;
  expiresAt: number;
}

export type OAuthProviderId = 'wimotek' | 'microsoft' | 'github' | 'google' | 'apple';

export interface OAuthProviderPublicConfig {
  provider: OAuthProviderId;
  enabled: boolean;
  configured: boolean;
  envManaged: boolean;
  clientId?: string;
  issuerUrl?: string; // wimotek OIDC issuer (default http://ca.wimotek.com)
  redirectUri?: string; // custom redirect URI override (e.g. https://jp3.wimotek.com/auth/callback)
  directLogin?: boolean; // when enabled, auto-use wimotek hosted login directly (disable -> fallback to local login)
  adminEmail?: string; // optional legacy admin email for verified email auto-linking
  restrictToBoundOnly?: boolean; // when true, only pre-bound wimotek subjects/emails can log in
  tenantId?: string; // Microsoft Entra tenant (default 'common')
  teamId?: string; // Apple Team ID
  keyId?: string; // Apple Key ID
  hasClientSecret: boolean;
  secretPreview?: string;
  hasPrivateKey?: boolean; // Apple .p8 private key
  boundCount: number;
  callbackUri?: string;
}

export interface BoundOAuthAccount {
  id: string;
  provider: OAuthProviderId;
  subject: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
  boundAt: string;
  lastLoginAt?: string;
}

export interface WimotekOAuthPublicStatus {
  enabled: boolean;
  configured: boolean;
  directLogin: boolean;
  issuerUrl: string;
  clientId: string;
  loginPath: string;
  logoutPath: string;
}

export interface AuthStatusResponse {
  envManagedAdmin: boolean;
  authenticated: boolean;
  username?: string;
  loginMethod?: string;
  wimotekOAuth?: WimotekOAuthPublicStatus;
  oauthProviders?: Array<{
    provider: OAuthProviderId;
    configured: boolean;
    enabled: boolean;
    boundCount: number;
  }>;
  security: {
    captchaDifficulty: 'standard' | 'high';
    powDifficulty: number;
    requireSliderVerify: boolean;
    minFormDwellMs: number;
  };
}

export interface OverviewSummary {
  dnsProviders: number;
  dnsRules: number;
  totalIpv4Targets: number;
  totalIpv6Targets: number;
  ociProfiles: number;
  runningSnipers: number;
  totalSniperAttempts: number;
  cloudHosts: number;
  managedIps: number;
  monitorsTotal: number;
  monitorsUp: number;
  monitorsDown: number;
  notificationChannels: number;
  activeCronJobs: number;
  tlsStatus: TlsCertificateStatus;
  auditStats: AuditStats;
  recentLogs: AuditLogEntry[];
  containerInfo: {
    hostname: string;
    nodeVersion: string;
    platform: string;
    arch: string;
    uptimeSeconds: number;
    dataDir: string;
  };
}
