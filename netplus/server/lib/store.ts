import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AuditLogEntry,
  AuditStats,
  BoundOAuthAccount,
  CloudAccount,
  CloudHost,
  CronJob,
  DnsProvider,
  DnsSyncRule,
  ManagedDnsRecord,
  ManagedDomain,
  ManagedIpRecord,
  MonitorTarget,
  NotificationChannel,
  OAuthProviderId,
  OciProfile,
  OciSniperTask,
  SecurityConfig,
} from '../../src/types/models.ts';
import { computeNextCronRun } from './cron.ts';
import { decryptSecret, encryptSecret, hashPassword, maskSecret, safeEqualStrings, verifyPassword } from './crypto.ts';

export interface StoredDnsProvider extends Omit<DnsProvider, 'hasSecret' | 'secretPreview'> {
  secretEncrypted?: string;
  secretIdEncrypted?: string;
  secretPreview?: string;
}

export interface StoredOciProfile extends Omit<OciProfile, 'hasPrivateKey' | 'privateKeyPreview'> {
  privateKeyEncrypted?: string;
  privateKeyPreview?: string;
}

export interface StoredCloudAccount extends Omit<CloudAccount, 'hasCredentials'> {
  accessKeyIdEncrypted?: string;
  secretKeyEncrypted?: string;
  serviceAccountJsonEncrypted?: string;
}

export type StoredOciSniperTask = OciSniperTask;

export interface StoredCloudHost extends Omit<CloudHost, 'hasApiSecret'> {
  apiSecretEncrypted?: string;
}

export interface StoredNotificationChannel extends Omit<NotificationChannel, 'hasSecret' | 'secretPreview'> {
  secretEncrypted?: string;
  secretPreview?: string;
}

export interface AdminRecord {
  username: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredOAuthProviderConfig {
  provider: OAuthProviderId;
  enabled: boolean;
  clientId?: string;
  clientSecretEncrypted?: string;
  secretPreview?: string;
  tenantId?: string; // Microsoft Entra tenant (default 'common')
  teamId?: string; // Apple Team ID
  keyId?: string; // Apple Key ID
  privateKeyEncrypted?: string; // Apple .p8 key
  updatedAt?: string;
}

export interface PersistedSessionRecord {
  token: string;
  username: string;
  ip: string;
  createdAt: number;
  expiresAt: number;
  loginMethod?: string;
}

export interface PersistedState {
  admin?: AdminRecord;
  security: SecurityConfig;
  oauthProviders: StoredOAuthProviderConfig[];
  boundOAuthAccounts: BoundOAuthAccount[];
  dnsProviders: StoredDnsProvider[];
  dnsRules: DnsSyncRule[];
  dnsRecords: ManagedDnsRecord[];
  managedDomains: ManagedDomain[];
  ociProfiles: StoredOciProfile[];
  ociSniperTasks: StoredOciSniperTask[];
  cloudAccounts: StoredCloudAccount[];
  cloudHosts: StoredCloudHost[];
  managedIps: ManagedIpRecord[];
  monitors: MonitorTarget[];
  notificationChannels: StoredNotificationChannel[];
  cronJobs: CronJob[];
  auditMeta: {
    pruneCount: number;
    lastPrunedAt?: string;
    lastPrunedBytes?: number;
  };
}

const DEFAULT_MAX_AUDIT_BYTES = Math.max(
  65536,
  parseInt(process.env.AUDIT_MAX_SIZE_BYTES || '5242880', 10) || 5242880
);

function getDataDir(): string {
  const configured = process.env.DATA_DIR?.trim() || './data';
  return path.resolve(process.cwd(), configured);
}

function resolveConfinedPath(baseDir: string, filename: string): string {
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(resolvedBase, filename);
  if (!target.startsWith(resolvedBase + path.sep)) {
    throw new Error('Path escapes confined data directory');
  }
  return target;
}

export function getHostLinkedRuleIds(host: {
  linkedDnsRuleId?: string;
  linkedDnsRuleIds?: string[];
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  if (Array.isArray(host.linkedDnsRuleIds)) {
    for (const id of host.linkedDnsRuleIds) {
      const clean = String(id || '').trim();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
      }
    }
  }
  if (host.linkedDnsRuleId) {
    const clean = String(host.linkedDnsRuleId).trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

export function setHostLinkedRuleIds(
  host: { linkedDnsRuleId?: string; linkedDnsRuleIds?: string[] },
  ruleIds: string[]
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of ruleIds) {
    const clean = String(id || '').trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      normalized.push(clean);
    }
  }
  host.linkedDnsRuleIds = normalized;
  host.linkedDnsRuleId = normalized[0] || undefined;
  return normalized;
}

function createDefaultState(): PersistedState {
  const now = new Date().toISOString();

  return {
    security: {
      maxLoginAttempts: 5,
      lockoutMinutes: 15,
      rateLimitWindowSeconds: 60,
      rateLimitMaxRequests: 30,
      captchaDifficulty: 'high',
      powDifficulty: 3,
      requireSliderVerify: true,
      sliderFailureThreshold: 2,
      minFormDwellMs: 800,
      sessionTimeoutMinutes: 120,
      maxAuditSizeBytes: DEFAULT_MAX_AUDIT_BYTES,
      auditRetentionPercent: 75,
    },
    oauthProviders: [],
    boundOAuthAccounts: [],
    dnsProviders: [],
    dnsRules: [],
    dnsRecords: [],
    managedDomains: [],
    ociProfiles: [],
    ociSniperTasks: [],
    cloudAccounts: [],
    cloudHosts: [],
    managedIps: [],
    monitors: [],
    notificationChannels: [],
    cronJobs: [
      {
        id: 'cron-audit-quota-15m',
        name: 'Audit Log Size Quota Enforcement',
        type: 'audit_cleanup',
        expression: '*/15 * * * *',
        targetIds: [],
        enabled: true,
        nextRunAt: computeNextCronRun('*/15 * * * *'),
        lastStatus: 'success',
        lastSummary: 'Verifies audit.ndjson stays below configured byte cap',
        runCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    ],
    auditMeta: {
      pruneCount: 0,
    },
  };
}

function generateInitialPassword(length = 16): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

class DataStore {
  private dataDir: string;
  private stateFile: string;
  private auditFile: string;
  private sessionsFile: string;
  private state: PersistedState;
  private adminInitMode: 'persisted' | 'env_seed' | 'auto_generated' = 'persisted';
  private generatedInitialPassword: string | null = null;

  constructor() {
    this.dataDir = getDataDir();
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.stateFile = resolveConfinedPath(this.dataDir, 'state.json');
    this.auditFile = resolveConfinedPath(this.dataDir, 'audit.ndjson');
    this.sessionsFile = resolveConfinedPath(this.dataDir, 'sessions.json');
    this.state = this.loadState();

    // Always ensure an admin account exists before accepting any HTTP request (no public web bootstrap page).
    // ADMIN_USERNAME / ADMIN_PASSWORD act as first-run initial seed only; if omitted, a random strong
    // password is generated once, stored as a scrypt hash in state.json, and printed once to startup logs.
    if (this.state.admin) {
      this.adminInitMode = 'persisted';
    } else {
      const initialUser = process.env.ADMIN_USERNAME?.trim() || 'admin';
      const envPass = process.env.ADMIN_PASSWORD?.trim();
      const now = new Date().toISOString();
      if (envPass) {
        this.state.admin = {
          username: initialUser,
          passwordHash: hashPassword(envPass),
          createdAt: now,
          updatedAt: now,
        };
        this.adminInitMode = 'env_seed';
      } else {
        const randomPass = generateInitialPassword(16);
        this.state.admin = {
          username: initialUser,
          passwordHash: hashPassword(randomPass),
          createdAt: now,
          updatedAt: now,
        };
        this.generatedInitialPassword = randomPass;
        this.adminInitMode = 'auto_generated';
      }
      this.save();
    }

    if (!fs.existsSync(this.auditFile)) {
      fs.writeFileSync(this.auditFile, '', 'utf8');
      this.appendAudit({
        category: 'audit',
        severity: 'info',
        action: 'SYSTEM_INIT',
        actor: 'system',
        ip: '127.0.0.1',
        details: `Initialized NetPlus data store (${
          this.adminInitMode === 'env_seed'
            ? `seeded initial admin "${this.state.admin?.username}" from env`
            : this.adminInitMode === 'auto_generated'
            ? `auto-generated initial admin "${this.state.admin?.username}" (printed to container logs)`
            : 'loaded persisted admin'
        })`,
      });
    }
  }

  private loadState(): PersistedState {
    if (fs.existsSync(this.stateFile)) {
      try {
        const raw = fs.readFileSync(this.stateFile, 'utf8');
        const parsed = JSON.parse(raw) as Partial<PersistedState>;
        const defaults = createDefaultState();
        const mergedSnipers = (parsed.ociSniperTasks ?? defaults.ociSniperTasks).map((t) => ({
          ...t,
          adaptiveInterval: t.adaptiveInterval !== false,
          minIntervalSeconds: typeof t.minIntervalSeconds === 'number' ? t.minIntervalSeconds : 20,
          maxIntervalSeconds: typeof t.maxIntervalSeconds === 'number' ? t.maxIntervalSeconds : 120,
          stepUp429Seconds: typeof t.stepUp429Seconds === 'number' ? t.stepUp429Seconds : 15,
          stepDownOkSeconds: typeof t.stepDownOkSeconds === 'number' ? t.stepDownOkSeconds : 5,
          currentIntervalSeconds:
            typeof t.currentIntervalSeconds === 'number'
              ? t.currentIntervalSeconds
              : Math.max(15, t.intervalSeconds || 30),
          consecutive429Count: typeof t.consecutive429Count === 'number' ? t.consecutive429Count : 0,
          consecutiveOkCount: typeof t.consecutiveOkCount === 'number' ? t.consecutiveOkCount : 0,
          useSystemNotifications: t.useSystemNotifications !== false,
          notifyChannelIds: Array.isArray(t.notifyChannelIds) ? t.notifyChannelIds : [],
        }));
        const mergedMonitors = (Array.isArray(parsed.monitors) ? parsed.monitors : []).map((m) => ({
          ...m,
          notifyOnDown: m.notifyOnDown !== undefined ? Boolean(m.notifyOnDown) : Boolean(m.notifyOnAlert),
          notifyOnRecover: m.notifyOnRecover !== undefined ? Boolean(m.notifyOnRecover) : Boolean(m.notifyOnAlert),
          notifyChannelIds: Array.isArray(m.notifyChannelIds) ? m.notifyChannelIds : [],
          history: Array.isArray(m.history) ? m.history : [],
        }));
        const managedProviders = new Set(['oracle', 'aws', 'aliyun', 'gcp']);
        const cleanedHosts = (parsed.cloudHosts ?? defaults.cloudHosts)
          .filter((h) => managedProviders.has(h.provider))
          .map((h) => {
            const ruleIds = getHostLinkedRuleIds(h);
            return {
              ...h,
              groupName: h.groupName || (h.region ? h.region : '默认分组'),
              linkedDnsRuleIds: ruleIds,
              linkedDnsRuleId: ruleIds[0] || undefined,
            };
          });
        return {
          ...defaults,
          ...parsed,
          oauthProviders: Array.isArray(parsed.oauthProviders) ? parsed.oauthProviders : [],
          boundOAuthAccounts: Array.isArray(parsed.boundOAuthAccounts) ? parsed.boundOAuthAccounts : [],
          dnsProviders: Array.isArray(parsed.dnsProviders) ? parsed.dnsProviders : [],
          dnsRules: Array.isArray(parsed.dnsRules) ? parsed.dnsRules : [],
          dnsRecords: Array.isArray(parsed.dnsRecords) ? parsed.dnsRecords : [],
          managedDomains: Array.isArray(parsed.managedDomains) ? parsed.managedDomains : [],
          ociProfiles: Array.isArray(parsed.ociProfiles) ? parsed.ociProfiles : [],
          cloudAccounts: Array.isArray(parsed.cloudAccounts) ? parsed.cloudAccounts : [],
          cloudHosts: cleanedHosts,
          ociSniperTasks: mergedSnipers,
          managedIps: Array.isArray(parsed.managedIps) ? parsed.managedIps : [],
          monitors: mergedMonitors,
          notificationChannels: Array.isArray(parsed.notificationChannels) ? parsed.notificationChannels : [],
          cronJobs: Array.isArray(parsed.cronJobs) ? parsed.cronJobs : defaults.cronJobs,
          security: { ...defaults.security, ...(parsed.security ?? {}) },
          auditMeta: { ...defaults.auditMeta, ...(parsed.auditMeta ?? {}) },
        };
      } catch (err) {
        console.warn(
          `[NetPlus][Store] Failed to parse ${this.stateFile}, initializing clean state:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    const fresh = createDefaultState();
    this.persistState(fresh);
    return fresh;
  }

  private persistState(target: PersistedState = this.state) {
    const tmpFile = resolveConfinedPath(this.dataDir, `state.${crypto.randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmpFile, JSON.stringify(target, null, 2), { mode: 0o600 });
    fs.renameSync(tmpFile, this.stateFile);
  }

  getDataDirectory(): string {
    return this.dataDir;
  }

  getState(): PersistedState {
    return this.state;
  }

  save() {
    this.persistState(this.state);
  }

  getAdminInitSummary(): { mode: 'persisted' | 'env_seed' | 'auto_generated'; username: string } {
    return {
      mode: this.adminInitMode,
      username: this.state.admin?.username || 'admin',
    };
  }

  consumeGeneratedInitialPassword(): string | null {
    const pwd = this.generatedInitialPassword;
    this.generatedInitialPassword = null;
    return pwd;
  }

  // ---- Admin Auth ----
  // Initial credentials are stored in state.json and always editable in Security Settings.
  isEnvAdminConfigured(): boolean {
    return false;
  }

  verifyAdminCredentials(username: string, password: string): { ok: boolean; canonicalUsername: string } {
    if (!this.state.admin) {
      return { ok: false, canonicalUsername: '' };
    }
    const userOk = safeEqualStrings(username.trim(), this.state.admin.username);
    const passOk = verifyPassword(password, this.state.admin.passwordHash);
    return { ok: userOk && passOk, canonicalUsername: this.state.admin.username };
  }

  updateAdminCredentials(params: {
    newUsername?: string;
    newPassword?: string;
  }): { ok: boolean; username: string; usernameChanged: boolean; passwordChanged: boolean } {
    if (!this.state.admin) {
      return { ok: false, username: '', usernameChanged: false, passwordChanged: false };
    }
    let usernameChanged = false;
    let passwordChanged = false;
    const cleanUser = params.newUsername?.trim();
    if (cleanUser && cleanUser !== this.state.admin.username) {
      this.state.admin.username = cleanUser;
      usernameChanged = true;
    }
    if (params.newPassword) {
      this.state.admin.passwordHash = hashPassword(params.newPassword);
      passwordChanged = true;
    }
    if (usernameChanged || passwordChanged) {
      this.state.admin.updatedAt = new Date().toISOString();
      this.adminInitMode = 'persisted';
      this.save();
    }
    return {
      ok: true,
      username: this.state.admin.username,
      usernameChanged,
      passwordChanged,
    };
  }

  updateAdminPassword(newPassword: string): boolean {
    return this.updateAdminCredentials({ newPassword }).ok;
  }

  // ---- Secret sanitization helpers ----
  toPublicDnsProvider(p: StoredDnsProvider): DnsProvider {
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      zoneId: p.zoneId,
      domain: p.domain,
      endpointUrl: p.endpointUrl,
      accountEmail: p.accountEmail,
      hasSecret: Boolean(p.secretEncrypted),
      secretPreview: p.secretPreview,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  getDnsProviderSecrets(id: string): { secret: string; secretId: string } {
    const p = this.state.dnsProviders.find((item) => item.id === id);
    if (!p) return { secret: '', secretId: '' };
    return {
      secret: decryptSecret(p.secretEncrypted),
      secretId: decryptSecret(p.secretIdEncrypted),
    };
  }

  setDnsProviderSecrets(p: StoredDnsProvider, secret?: string, secretId?: string) {
    if (secret && secret.trim()) {
      p.secretEncrypted = encryptSecret(secret.trim());
      p.secretPreview = maskSecret(secret.trim());
    }
    if (secretId && secretId.trim()) {
      p.secretIdEncrypted = encryptSecret(secretId.trim());
    }
  }

  toPublicOciProfile(p: StoredOciProfile): OciProfile {
    return {
      id: p.id,
      name: p.name,
      region: p.region,
      homeRegion: p.homeRegion,
      tenancyOcid: p.tenancyOcid,
      userOcid: p.userOcid,
      compartmentOcid: p.compartmentOcid,
      fingerprint: p.fingerprint,
      subnetOcid: p.subnetOcid,
      availabilityDomains: p.availabilityDomains,
      hasPrivateKey: Boolean(p.privateKeyEncrypted),
      privateKeyPreview: p.privateKeyPreview,
      instanceCount: p.instanceCount,
      status: p.status,
      lastCheckedAt: p.lastCheckedAt,
      notes: p.notes,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  getOciPrivateKey(profileId: string): string {
    const p = this.state.ociProfiles.find((item) => item.id === profileId);
    return decryptSecret(p?.privateKeyEncrypted);
  }

  setOciPrivateKey(p: StoredOciProfile, pem?: string) {
    if (pem && pem.trim()) {
      p.privateKeyEncrypted = encryptSecret(pem.trim());
      p.privateKeyPreview = 'PEM ••••' + pem.trim().slice(-12).replace(/\s+/g, '');
    }
  }

  toPublicSniperTask(t: StoredOciSniperTask): OciSniperTask {
    return { ...t };
  }

  toPublicCloudAccount(a: StoredCloudAccount): CloudAccount {
    const hasCredentials =
      a.provider === 'gcp'
        ? Boolean(a.serviceAccountJsonEncrypted)
        : Boolean(a.accessKeyIdEncrypted && a.secretKeyEncrypted);
    return {
      id: a.id,
      name: a.name,
      provider: a.provider,
      region: a.region,
      zone: a.zone,
      projectId: a.projectId,
      clientEmail: a.clientEmail,
      accessKeyIdPreview: a.accessKeyIdPreview,
      hasCredentials,
      instanceCount: a.instanceCount,
      status: a.status,
      lastCheckedAt: a.lastCheckedAt,
      notes: a.notes,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }

  setCloudAccountSecrets(
    a: StoredCloudAccount,
    secrets: { accessKeyId?: string; secretKey?: string; serviceAccountJson?: string }
  ) {
    if (secrets.accessKeyId && secrets.accessKeyId.trim()) {
      const clean = secrets.accessKeyId.trim();
      a.accessKeyIdEncrypted = encryptSecret(clean);
      a.accessKeyIdPreview = maskSecret(clean);
    }
    if (secrets.secretKey && secrets.secretKey.trim()) {
      a.secretKeyEncrypted = encryptSecret(secrets.secretKey.trim());
    }
    if (secrets.serviceAccountJson && secrets.serviceAccountJson.trim()) {
      a.serviceAccountJsonEncrypted = encryptSecret(secrets.serviceAccountJson.trim());
    }
  }

  getCloudAccountSecrets(accountId: string): {
    accessKeyId: string;
    secretKey: string;
    serviceAccountJson: string;
  } {
    const a = this.state.cloudAccounts.find((item) => item.id === accountId);
    if (!a) return { accessKeyId: '', secretKey: '', serviceAccountJson: '' };
    return {
      accessKeyId: decryptSecret(a.accessKeyIdEncrypted),
      secretKey: decryptSecret(a.secretKeyEncrypted),
      serviceAccountJson: decryptSecret(a.serviceAccountJsonEncrypted),
    };
  }

  toPublicCloudHost(h: StoredCloudHost): CloudHost {
    const { apiSecretEncrypted, ...rest } = h;
    return {
      ...rest,
      hasApiSecret: Boolean(apiSecretEncrypted),
    };
  }

  setCloudHostSecret(h: StoredCloudHost, secret?: string) {
    if (secret && secret.trim()) {
      h.apiSecretEncrypted = encryptSecret(secret.trim());
    }
  }

  toPublicNotificationChannel(ch: StoredNotificationChannel): NotificationChannel {
    const { secretEncrypted, ...rest } = ch;
    return {
      ...rest,
      hasSecret: Boolean(secretEncrypted),
    };
  }

  getNotificationSecret(channelId: string): string {
    const ch = this.state.notificationChannels.find((c) => c.id === channelId);
    return decryptSecret(ch?.secretEncrypted);
  }

  setNotificationSecret(ch: StoredNotificationChannel, secret?: string) {
    if (secret && secret.trim()) {
      ch.secretEncrypted = encryptSecret(secret.trim());
      ch.secretPreview = maskSecret(secret.trim());
    }
  }

  // ---- OAuth provider encrypted secrets ----
  setOAuthProviderSecrets(
    cfg: StoredOAuthProviderConfig,
    secrets: { clientSecret?: string; privateKey?: string }
  ) {
    if (secrets.clientSecret && secrets.clientSecret.trim()) {
      const clean = secrets.clientSecret.trim();
      cfg.clientSecretEncrypted = encryptSecret(clean);
      cfg.secretPreview = maskSecret(clean);
    }
    if (secrets.privateKey && secrets.privateKey.trim()) {
      cfg.privateKeyEncrypted = encryptSecret(secrets.privateKey.trim());
    }
  }

  getOAuthProviderDecryptedSecrets(provider: OAuthProviderId): {
    clientSecret: string;
    privateKey: string;
  } {
    const cfg = this.state.oauthProviders.find((p) => p.provider === provider);
    return {
      clientSecret: decryptSecret(cfg?.clientSecretEncrypted),
      privateKey: decryptSecret(cfg?.privateKeyEncrypted),
    };
  }

  // ---- Persisted Sessions (survives page refresh & container restart) ----
  loadSessions(): PersistedSessionRecord[] {
    if (!fs.existsSync(this.sessionsFile)) return [];
    try {
      const raw = fs.readFileSync(this.sessionsFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const now = Date.now();
      return parsed.filter(
        (s): s is PersistedSessionRecord =>
          s &&
          typeof s.token === 'string' &&
          typeof s.username === 'string' &&
          typeof s.expiresAt === 'number' &&
          s.expiresAt > now
      );
    } catch {
      return [];
    }
  }

  saveSessions(records: PersistedSessionRecord[]) {
    const now = Date.now();
    const active = records.filter((s) => s.expiresAt > now).slice(-100);
    const tmpFile = resolveConfinedPath(this.dataDir, `sessions.${crypto.randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmpFile, JSON.stringify(active, null, 2), { mode: 0o600 });
    fs.renameSync(tmpFile, this.sessionsFile);
  }

  // ---- Real Size-Capped Audit Logging ----
  appendAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): AuditLogEntry {
    const record: AuditLogEntry = {
      id: `aud-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(this.auditFile, line, { encoding: 'utf8', mode: 0o600 });
    this.enforceAuditSizeLimit();
    return record;
  }

  enforceAuditSizeLimit(): { pruned: boolean; removedBytes: number; currentBytes: number } {
    if (!fs.existsSync(this.auditFile)) {
      return { pruned: false, removedBytes: 0, currentBytes: 0 };
    }
    const maxBytes = Math.max(16384, this.state.security.maxAuditSizeBytes || DEFAULT_MAX_AUDIT_BYTES);
    const stat = fs.statSync(this.auditFile);
    if (stat.size <= maxBytes) {
      return { pruned: false, removedBytes: 0, currentBytes: stat.size };
    }

    const retentionRatio = Math.min(0.9, Math.max(0.3, (this.state.security.auditRetentionPercent || 75) / 100));
    const targetBytes = Math.floor(maxBytes * retentionRatio);

    const raw = fs.readFileSync(this.auditFile, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    const kept: string[] = [];
    let accBytes = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const byteLen = Buffer.byteLength(lines[i] + '\n', 'utf8');
      if (accBytes + byteLen > targetBytes && kept.length > 0) {
        break;
      }
      kept.push(lines[i]);
      accBytes += byteLen;
    }
    kept.reverse();

    const pruneNotice: AuditLogEntry = {
      id: `aud-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      category: 'audit',
      severity: 'warning',
      action: 'AUDIT_AUTO_PRUNE',
      actor: 'system',
      ip: '127.0.0.1',
      details: `Auto-deleted oldest audit entries (${stat.size} B exceeded cap ${maxBytes} B; trimmed to ${accBytes} B)`,
    };
    kept.push(JSON.stringify(pruneNotice));

    const newContent = kept.join('\n') + '\n';
    const tmpAudit = resolveConfinedPath(this.dataDir, `audit.${crypto.randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmpAudit, newContent, { mode: 0o600 });
    fs.renameSync(tmpAudit, this.auditFile);

    const newSize = Buffer.byteLength(newContent, 'utf8');
    const removedBytes = Math.max(0, stat.size - newSize);

    this.state.auditMeta.pruneCount += 1;
    this.state.auditMeta.lastPrunedAt = new Date().toISOString();
    this.state.auditMeta.lastPrunedBytes = removedBytes;
    this.save();

    return { pruned: true, removedBytes, currentBytes: newSize };
  }

  readAuditLogs(options?: {
    category?: string;
    severity?: string;
    search?: string;
    limit?: number;
  }): AuditLogEntry[] {
    if (!fs.existsSync(this.auditFile)) return [];
    const raw = fs.readFileSync(this.auditFile, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const entries: AuditLogEntry[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const item = JSON.parse(lines[i]) as AuditLogEntry;
        if (options?.category && options.category !== 'all' && item.category !== options.category) continue;
        if (options?.severity && options.severity !== 'all' && item.severity !== options.severity) continue;
        if (options?.search) {
          const q = options.search.toLowerCase();
          const haystack = `${item.action} ${item.actor} ${item.ip} ${item.target ?? ''} ${item.details}`.toLowerCase();
          if (!haystack.includes(q)) continue;
        }
        entries.push(item);
        if (options?.limit && entries.length >= options.limit) break;
      } catch {
        // skip malformed line
      }
    }
    return entries;
  }

  getAuditStats(): AuditStats {
    let fileSizeBytes = 0;
    let totalEntries = 0;
    if (fs.existsSync(this.auditFile)) {
      const stat = fs.statSync(this.auditFile);
      fileSizeBytes = stat.size;
      const raw = fs.readFileSync(this.auditFile, 'utf8');
      totalEntries = raw.split('\n').filter((l) => l.trim().length > 0).length;
    }
    return {
      fileSizeBytes,
      maxSizeBytes: this.state.security.maxAuditSizeBytes,
      retentionTargetPercent: this.state.security.auditRetentionPercent,
      totalEntries,
      pruneCount: this.state.auditMeta.pruneCount,
      lastPrunedAt: this.state.auditMeta.lastPrunedAt,
      lastPrunedBytes: this.state.auditMeta.lastPrunedBytes,
    };
  }

  purgeAuditLogs(actor: string, ip: string) {
    fs.writeFileSync(this.auditFile, '', { mode: 0o600 });
    this.appendAudit({
      category: 'audit',
      severity: 'warning',
      action: 'AUDIT_MANUAL_PURGE',
      actor,
      ip,
      details: 'Administrator manually cleared the audit log file',
    });
  }
}

export const store = new DataStore();
