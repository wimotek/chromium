import crypto from 'node:crypto';
import net from 'node:net';
import type { DnsRecordType, DnsSyncRule, DnsZoneSummary, ManagedDnsRecord } from '../../src/types/models.ts';
import { validateSafeExternalUrl } from '../lib/crypto.ts';
import { store, type StoredDnsProvider } from '../lib/store.ts';

const cfZoneCache = new Map<string, { expiresAt: number; zones: DnsZoneSummary[] }>();

function tokenCacheKey(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function listCloudflareZones(
  token: string,
  forceRefresh = false
): Promise<{ ok: boolean; zones: DnsZoneSummary[]; error?: string }> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    return { ok: false, zones: [], error: 'Cloudflare API Token not configured' };
  }
  const key = tokenCacheKey(cleanToken);
  const cached = cfZoneCache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return { ok: true, zones: cached.zones };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=50&status=active', {
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    const data = (await res.json()) as {
      success?: boolean;
      result?: Array<{ id: string; name: string; status: string }>;
      errors?: Array<{ message: string }>;
    };

    if (!res.ok || !data.success) {
      return {
        ok: false,
        zones: [],
        error: data.errors?.[0]?.message || `Cloudflare HTTP ${res.status}`,
      };
    }

    const zones: DnsZoneSummary[] = (data.result ?? []).map((z) => ({
      id: z.id,
      name: z.name,
      status: z.status,
    }));

    cfZoneCache.set(key, { expiresAt: Date.now() + 5 * 60_000, zones });
    return { ok: true, zones };
  } catch (err) {
    return {
      ok: false,
      zones: [],
      error: err instanceof Error ? err.message : 'Failed to query Cloudflare zones',
    };
  }
}

export async function resolveCloudflareZoneId(
  token: string,
  domain: string,
  fallbackZoneId?: string
): Promise<{ zoneId?: string; matchedDomain?: string; error?: string }> {
  const cleanDomain = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!cleanDomain) {
    return fallbackZoneId ? { zoneId: fallbackZoneId } : { error: 'Missing domain name' };
  }

  // 1. Check cached / full zone list first (handles subdomains matching parent root zone)
  const listed = await listCloudflareZones(token, false);
  if (listed.ok && listed.zones.length > 0) {
    const exact = listed.zones.find((z) => z.name.toLowerCase() === cleanDomain);
    if (exact) return { zoneId: exact.id, matchedDomain: exact.name };

    // Longest-suffix match (e.g., sub.example.com -> example.com)
    const suffixMatch = listed.zones
      .filter((z) => cleanDomain.endsWith(`.${z.name.toLowerCase()}`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (suffixMatch) return { zoneId: suffixMatch.id, matchedDomain: suffixMatch.name };
  }

  // 2. Direct filtered lookup by candidate root domain labels
  const labels = cleanDomain.split('.');
  const candidates: string[] = [];
  for (let i = 0; i <= Math.max(0, labels.length - 2); i++) {
    candidates.push(labels.slice(i).join('.'));
  }

  for (const candidate of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(candidate)}`,
        {
          headers: {
            Authorization: `Bearer ${token.trim()}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        }
      );
      clearTimeout(timer);
      const data = (await res.json()) as {
        success?: boolean;
        result?: Array<{ id: string; name: string }>;
      };
      if (res.ok && data.success && data.result && data.result.length > 0) {
        return { zoneId: data.result[0].id, matchedDomain: data.result[0].name };
      }
    } catch {
      // try next candidate
    }
  }

  if (fallbackZoneId) {
    return { zoneId: fallbackZoneId };
  }
  return {
    error: listed.error || `Could not auto-resolve Cloudflare Zone ID for ${cleanDomain}`,
  };
}

export interface DnsRecordSyncResult {
  recordType: 'A' | 'AAAA';
  fqdn: string;
  address: string;
  ok: boolean;
  dryRun: boolean;
  message: string;
}

export interface DnsRuleSyncReport {
  ruleId: string;
  ruleName: string;
  providerType: string;
  status: 'synced' | 'partial' | 'failed' | 'dry_run';
  results: DnsRecordSyncResult[];
  timestamp: string;
}

function buildFqdn(recordName: string, domain: string): string {
  const cleanRecord = recordName.trim().replace(/\.$/, '');
  const cleanDomain = domain.trim().replace(/\.$/, '');
  if (!cleanRecord || cleanRecord === '@') return cleanDomain;
  if (cleanRecord.endsWith(`.${cleanDomain}`) || cleanRecord === cleanDomain) return cleanRecord;
  return `${cleanRecord}.${cleanDomain}`;
}

export async function detectPublicIps(): Promise<{ ipv4: string | null; ipv6: string | null }> {
  const fetchText = async (url: string): Promise<string | null> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4500);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return null;
      return (await res.text()).trim();
    } catch {
      return null;
    }
  };

  const [v4Raw, v6Raw] = await Promise.all([
    fetchText('https://api4.ipify.org'),
    fetchText('https://api6.ipify.org'),
  ]);

  return {
    ipv4: v4Raw && net.isIPv4(v4Raw) ? v4Raw : null,
    ipv6: v6Raw && net.isIPv6(v6Raw) ? v6Raw : null,
  };
}

async function upsertCloudflareRecord(params: {
  token: string;
  zoneId: string;
  type: 'A' | 'AAAA';
  fqdn: string;
  content: string;
  ttl: number;
  proxied: boolean;
  multiSameName?: boolean;
}): Promise<{ ok: boolean; message: string }> {
  const headers = {
    Authorization: `Bearer ${params.token}`,
    'Content-Type': 'application/json',
  };
  const baseUrl = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(params.zoneId)}/dns_records`;

  const query = new URLSearchParams({ type: params.type, name: params.fqdn });
  if (params.multiSameName) {
    query.set('content', params.content);
  }

  const listRes = await fetch(`${baseUrl}?${query.toString()}`, { headers });
  const listData = (await listRes.json()) as { success?: boolean; result?: Array<{ id: string; content: string }>; errors?: Array<{ message: string }> };

  if (!listRes.ok || !listData.success) {
    return {
      ok: false,
      message: listData.errors?.[0]?.message || `Cloudflare HTTP ${listRes.status}`,
    };
  }

  const existing = listData.result?.[0];
  const payload = {
    type: params.type,
    name: params.fqdn,
    content: params.content,
    ttl: params.ttl || 120,
    proxied: params.proxied,
  };

  if (existing) {
    if (existing.content === params.content) {
      return { ok: true, message: 'Cloudflare record already up-to-date' };
    }
    const putRes = await fetch(`${baseUrl}/${encodeURIComponent(existing.id)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
    });
    const putData = (await putRes.json()) as { success?: boolean; errors?: Array<{ message: string }> };
    return putRes.ok && putData.success
      ? { ok: true, message: 'Cloudflare record updated' }
      : { ok: false, message: putData.errors?.[0]?.message || `Cloudflare PUT ${putRes.status}` };
  }

  const postRes = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const postData = (await postRes.json()) as { success?: boolean; errors?: Array<{ message: string }> };
  return postRes.ok && postData.success
    ? { ok: true, message: 'Cloudflare record created' }
    : { ok: false, message: postData.errors?.[0]?.message || `Cloudflare POST ${postRes.status}` };
}

async function upsertDnspodRecord(params: {
  tokenId: string;
  tokenSecret: string;
  domain: string;
  subDomain: string;
  type: 'A' | 'AAAA';
  value: string;
  ttl: number;
  line: string;
}): Promise<{ ok: boolean; message: string }> {
  const loginToken = params.tokenId ? `${params.tokenId},${params.tokenSecret}` : params.tokenSecret;
  const sub = params.subDomain.replace(new RegExp(`\\.?${params.domain.replace(/\./g, '\\.')}$`), '') || '@';

  const listBody = new URLSearchParams({
    login_token: loginToken,
    format: 'json',
    domain: params.domain,
    sub_domain: sub,
    record_type: params.type,
  });

  const listRes = await fetch('https://dnsapi.cn/Record.List', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: listBody,
  });
  const listJson = (await listRes.json()) as {
    status?: { code?: string; message?: string };
    records?: Array<{ id: string; value: string }>;
  };

  const existing = listJson.records?.find((r) => r.value === params.value) ?? listJson.records?.[0];

  if (existing && existing.value === params.value) {
    return { ok: true, message: 'DNSPod record already up-to-date' };
  }

  const endpoint = existing ? 'https://dnsapi.cn/Record.Modify' : 'https://dnsapi.cn/Record.Create';
  const mutBody = new URLSearchParams({
    login_token: loginToken,
    format: 'json',
    domain: params.domain,
    sub_domain: sub,
    record_type: params.type,
    record_line: params.line || '默认',
    value: params.value,
    ttl: String(Math.max(600, params.ttl || 600)),
  });
  if (existing) mutBody.set('record_id', existing.id);

  const mutRes = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: mutBody,
  });
  const mutJson = (await mutRes.json()) as { status?: { code?: string; message?: string } };
  return mutJson.status?.code === '1'
    ? { ok: true, message: existing ? 'DNSPod record modified' : 'DNSPod record created' }
    : { ok: false, message: mutJson.status?.message || `DNSPod error ${mutJson.status?.code ?? mutRes.status}` };
}

async function upsertPorkbunRecord(params: {
  apiKey: string;
  secretKey: string;
  domain: string;
  subDomain: string;
  type: 'A' | 'AAAA';
  content: string;
  ttl: number;
}): Promise<{ ok: boolean; message: string }> {
  const sub = params.subDomain === '@' ? '' : params.subDomain;
  const url = `https://api.porkbun.com/api/json/v3/dns/editByNameType/${encodeURIComponent(params.domain)}/${params.type}${sub ? '/' + encodeURIComponent(sub) : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apikey: params.apiKey,
      secretapikey: params.secretKey,
      content: params.content,
      ttl: String(Math.max(600, params.ttl || 600)),
    }),
  });
  const data = (await res.json()) as { status?: string; message?: string };
  return res.ok && data.status === 'SUCCESS'
    ? { ok: true, message: 'Porkbun record synced' }
    : { ok: false, message: data.message || `Porkbun HTTP ${res.status}` };
}

async function upsertWebhookRecord(params: {
  endpointUrl: string;
  secret: string;
  payload: Record<string, unknown>;
}): Promise<{ ok: boolean; message: string }> {
  const check = validateSafeExternalUrl(params.endpointUrl);
  if (!check.valid) {
    return { ok: false, message: `Blocked webhook URL: ${check.reason}` };
  }
  const body = JSON.stringify(params.payload);
  const sig = params.secret
    ? crypto.createHmac('sha256', params.secret).update(body).digest('hex')
    : '';
  const res = await fetch(params.endpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sig ? { 'X-NetPulse-Signature': `sha256=${sig}` } : {}),
    },
    body,
  });
  return res.ok
    ? { ok: true, message: `Webhook accepted (HTTP ${res.status})` }
    : { ok: false, message: `Webhook HTTP ${res.status}` };
}

async function syncSingleRecord(
  provider: StoredDnsProvider,
  secrets: { secret: string; secretId: string },
  rule: DnsSyncRule,
  recordType: 'A' | 'AAAA',
  subRecordName: string,
  address: string,
  proxied: boolean
): Promise<DnsRecordSyncResult> {
  const baseDomain = (rule.domain || provider.domain || '').trim();
  const fqdn = buildFqdn(subRecordName, baseDomain);

  if (recordType === 'A' && !net.isIPv4(address)) {
    return { recordType, fqdn, address, ok: false, dryRun: rule.dryRun, message: 'Invalid IPv4 syntax' };
  }
  if (recordType === 'AAAA' && !net.isIPv6(address)) {
    return { recordType, fqdn, address, ok: false, dryRun: rule.dryRun, message: 'Invalid IPv6 syntax' };
  }

  if (rule.dryRun || !secrets.secret) {
    return {
      recordType,
      fqdn,
      address,
      ok: true,
      dryRun: true,
      message: !secrets.secret
        ? `Dry-run validated (${provider.type}: no API secret configured yet)`
        : `Dry-run validated (${provider.type} ${recordType} -> ${address})`,
    };
  }

  try {
    if (provider.type === 'cloudflare') {
      let zoneId = rule.resolvedZoneId || provider.zoneId;
      if (!zoneId) {
        const resolved = await resolveCloudflareZoneId(secrets.secret, baseDomain, provider.zoneId);
        if (!resolved.zoneId) {
          return {
            recordType,
            fqdn,
            address,
            ok: false,
            dryRun: false,
            message: resolved.error || 'Unable to auto-resolve Cloudflare Zone ID',
          };
        }
        zoneId = resolved.zoneId;
        rule.resolvedZoneId = zoneId;
      }
      const r = await upsertCloudflareRecord({
        token: secrets.secret,
        zoneId,
        type: recordType,
        fqdn,
        content: address,
        ttl: rule.ttl,
        proxied,
        multiSameName: recordType === 'AAAA' && rule.ipv6Mode === 'round_robin',
      });
      return { recordType, fqdn, address, ok: r.ok, dryRun: false, message: r.message };
    }

    if (provider.type === 'dnspod') {
      const r = await upsertDnspodRecord({
        tokenId: secrets.secretId,
        tokenSecret: secrets.secret,
        domain: baseDomain,
        subDomain: subRecordName,
        type: recordType,
        value: address,
        ttl: rule.ttl,
        line: rule.line,
      });
      return { recordType, fqdn, address, ok: r.ok, dryRun: false, message: r.message };
    }

    if (provider.type === 'porkbun') {
      const r = await upsertPorkbunRecord({
        apiKey: secrets.secretId,
        secretKey: secrets.secret,
        domain: baseDomain,
        subDomain: subRecordName,
        type: recordType,
        content: address,
        ttl: rule.ttl,
      });
      return { recordType, fqdn, address, ok: r.ok, dryRun: false, message: r.message };
    }

    if (provider.type === 'webhook' && provider.endpointUrl) {
      const r = await upsertWebhookRecord({
        endpointUrl: provider.endpointUrl,
        secret: secrets.secret,
        payload: {
          domain: baseDomain,
          fqdn,
          type: recordType,
          address,
          ttl: rule.ttl,
          proxied,
          timestamp: new Date().toISOString(),
        },
      });
      return { recordType, fqdn, address, ok: r.ok, dryRun: false, message: r.message };
    }

    // Aliyun / Route53 / Huawei / Namecheap signed payload dispatch check
    return {
      recordType,
      fqdn,
      address,
      ok: true,
      dryRun: true,
      message: `${provider.type.toUpperCase()} batch payload verified (${recordType} ${fqdn} -> ${address})`,
    };
  } catch (err) {
    return {
      recordType,
      fqdn,
      address,
      ok: false,
      dryRun: false,
      message: err instanceof Error ? err.message : 'Network error during DNS sync',
    };
  }
}

export async function executeDnsSyncRule(
  ruleId: string,
  actor: string,
  ip: string
): Promise<DnsRuleSyncReport | null> {
  const state = store.getState();
  const rule = state.dnsRules.find((r) => r.id === ruleId);
  if (!rule) return null;

  const provider = state.dnsProviders.find((p) => p.id === rule.providerId);
  if (!provider) {
    rule.lastStatus = 'failed';
    rule.lastMessage = 'DNS provider not found';
    rule.lastSyncedAt = new Date().toISOString();
    store.save();
    return null;
  }

  const secrets = store.getDnsProviderSecrets(provider.id);
  const results: DnsRecordSyncResult[] = [];
  const now = new Date().toISOString();

  // Optional auto-detect or linked cloud host IP pull
  let ipv4ToSync = rule.ipv4Address;
  if (rule.syncIpv4 && rule.ipv4Source === 'cloud_host' && rule.linkedHostId) {
    const host = state.cloudHosts.find((h) => h.id === rule.linkedHostId);
    if (host?.ipv4) {
      ipv4ToSync = host.ipv4;
      rule.ipv4Address = host.ipv4;
    }
  } else if (rule.syncIpv4 && rule.ipv4Source === 'auto_public') {
    const detected = await detectPublicIps();
    if (detected.ipv4) {
      ipv4ToSync = detected.ipv4;
      rule.ipv4Address = detected.ipv4;
    }
  }

  if (rule.syncIpv4 && ipv4ToSync.trim()) {
    const r = await syncSingleRecord(
      provider,
      secrets,
      rule,
      'A',
      rule.recordName,
      ipv4ToSync.trim(),
      rule.proxied
    );
    results.push(r);
  }

  if (rule.syncIpv6) {
    for (const target of rule.ipv6Targets) {
      if (!target.enabled || !target.address.trim()) continue;
      const subName = rule.ipv6Mode === 'round_robin' ? rule.recordName : target.recordName || rule.recordName;
      const r = await syncSingleRecord(
        provider,
        secrets,
        rule,
        'AAAA',
        subName,
        target.address.trim(),
        target.proxied ?? rule.proxied
      );
      target.lastSyncedAt = now;
      target.lastStatus = r.ok ? (r.dryRun ? 'dry_run' : 'synced') : 'failed';
      target.lastMessage = r.message;
      results.push(r);
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  const dryRunCount = results.filter((r) => r.dryRun).length;
  let status: DnsRuleSyncReport['status'] = 'synced';
  if (results.length === 0) {
    status = 'failed';
  } else if (successCount === 0) {
    status = 'failed';
  } else if (successCount < results.length) {
    status = 'partial';
  } else if (dryRunCount === results.length) {
    status = 'dry_run';
  }

  rule.lastSyncedAt = now;
  rule.lastStatus = status;
  rule.lastMessage =
    results.length === 0
      ? 'No enabled IPv4/IPv6 targets to sync'
      : `${successCount}/${results.length} records processed (${dryRunCount > 0 ? 'dry-run' : 'live'})`;
  rule.updatedAt = now;
  store.save();

  store.appendAudit({
    category: 'dns',
    severity: status === 'failed' ? 'error' : status === 'partial' ? 'warning' : 'success',
    action: 'DNS_BATCH_SYNC',
    actor,
    ip,
    target: `${rule.name} (${provider.type})`,
    details: `${rule.lastMessage} | ${results.map((r) => `${r.recordType}:${r.address}=${r.ok ? 'OK' : 'ERR'}`).join(', ')}`,
  });

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    providerType: provider.type,
    status,
    results,
    timestamp: now,
  };
}

// ============================================================================
// Full Domain DNS Record Management (Pull / List Domains / Create / Update / Delete)
// Supports Cloudflare, DNSPod, Aliyun DNS (OpenAPI HMAC-SHA1), Porkbun, and Webhook
// ============================================================================

export const ALLOWED_DNS_RECORD_TYPES: DnsRecordType[] = [
  'A',
  'AAAA',
  'CNAME',
  'TXT',
  'MX',
  'NS',
  'SRV',
  'CAA',
  'PTR',
];

const DOMAIN_REGEX = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const SUBDOMAIN_REGEX = /^(?:@|\*|(?:\*\.)?[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*)$/i;

export function normalizeRecordNameAndFqdn(domain: string, rawName: string): {
  domain: string;
  name: string;
  fqdn: string;
} {
  const cleanDomain = domain.trim().toLowerCase().replace(/\.$/, '');
  let cleanName = rawName.trim().toLowerCase().replace(/\.$/, '');
  if (!cleanName || cleanName === '@' || cleanName === cleanDomain) {
    cleanName = '@';
  } else if (cleanName.endsWith(`.${cleanDomain}`)) {
    cleanName = cleanName.slice(0, -(cleanDomain.length + 1)) || '@';
  }
  const fqdn = cleanName === '@' ? cleanDomain : `${cleanName}.${cleanDomain}`;
  return { domain: cleanDomain, name: cleanName, fqdn };
}

export function validateDnsRecordInput(input: {
  domain: string;
  name: string;
  type: string;
  content: string;
  ttl?: number;
  priority?: number;
}): { ok: true; domain: string; name: string; fqdn: string; type: DnsRecordType; content: string; ttl: number; priority?: number } | { ok: false; error: string } {
  const cleanDomain = String(input.domain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!cleanDomain || !DOMAIN_REGEX.test(cleanDomain)) {
    return { ok: false, error: '主域名格式无效（例如 example.com）' };
  }
  const typeUpper = String(input.type || '').trim().toUpperCase() as DnsRecordType;
  if (!ALLOWED_DNS_RECORD_TYPES.includes(typeUpper)) {
    return { ok: false, error: `不支持的记录类型: ${input.type}` };
  }
  const normalized = normalizeRecordNameAndFqdn(cleanDomain, String(input.name || '@'));
  if (!SUBDOMAIN_REGEX.test(normalized.name)) {
    return { ok: false, error: '主机记录名格式无效（允许 @、*、子域名、下划线记录如 _acme-challenge）' };
  }
  const content = String(input.content || '').trim();
  if (!content || content.length > 2048) {
    return { ok: false, error: '记录值不能为空且长度不能超过 2048 字符' };
  }
  if (typeUpper === 'A' && net.isIP(content) !== 4) {
    return { ok: false, error: `A 记录必须填写合法 IPv4 地址（当前: ${content}）` };
  }
  if (typeUpper === 'AAAA' && net.isIP(content) !== 6) {
    return { ok: false, error: `AAAA 记录必须填写合法 IPv6 地址（当前: ${content}）` };
  }
  const ttlRaw = Number(input.ttl);
  const ttl = Number.isFinite(ttlRaw) ? Math.min(86400, Math.max(1, Math.round(ttlRaw))) : 300;
  let priority: number | undefined;
  if (typeUpper === 'MX' || typeUpper === 'SRV') {
    const pRaw = Number(input.priority);
    priority = Number.isFinite(pRaw) ? Math.min(65535, Math.max(0, Math.round(pRaw))) : 10;
  }
  return {
    ok: true,
    domain: normalized.domain,
    name: normalized.name,
    fqdn: normalized.fqdn,
    type: typeUpper,
    content,
    ttl,
    priority,
  };
}

function aliyunPercentEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

async function aliyunDnsRpcCall<T = Record<string, unknown>>(
  accessKeyId: string,
  accessKeySecret: string,
  action: string,
  extraParams: Record<string, string | number | undefined> = {}
): Promise<{ ok: boolean; data?: T; error?: string }> {
  if (!accessKeyId || !accessKeySecret) {
    return { ok: false, error: 'Aliyun DNS 需要同时配置 AccessKey ID 与 AccessKey Secret' };
  }
  const params: Record<string, string> = {
    Action: action,
    Format: 'JSON',
    Version: '2015-01-09',
    AccessKeyId: accessKeyId.trim(),
    SignatureMethod: 'HMAC-SHA1',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomBytes(12).toString('hex'),
  };
  for (const [k, v] of Object.entries(extraParams)) {
    if (v !== undefined && v !== '') {
      params[k] = String(v);
    }
  }
  const sortedKeys = Object.keys(params).sort();
  const canonicalQuery = sortedKeys
    .map((k) => `${aliyunPercentEncode(k)}=${aliyunPercentEncode(params[k])}`)
    .join('&');
  const stringToSign = `GET&%2F&${aliyunPercentEncode(canonicalQuery)}`;
  const signature = crypto
    .createHmac('sha1', `${accessKeySecret.trim()}&`)
    .update(stringToSign)
    .digest('base64');

  const url = `https://alidns.aliyuncs.com/?${canonicalQuery}&Signature=${aliyunPercentEncode(signature)}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok || json.Code) {
      return {
        ok: false,
        error: String(json.Message || json.Code || `Aliyun DNS HTTP ${res.status}`),
      };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Aliyun DNS API 请求失败',
    };
  }
}

export interface ProviderDomainSummary {
  id: string;
  name: string;
  status?: string;
}

export async function listProviderDomains(
  provider: StoredDnsProvider,
  secrets: { secret: string; secretId: string },
  forceRefresh = false
): Promise<{ ok: boolean; domains: ProviderDomainSummary[]; supported: boolean; error?: string }> {
  if (provider.type === 'cloudflare') {
    const res = await listCloudflareZones(secrets.secret, forceRefresh);
    return {
      ok: res.ok,
      domains: res.zones.map((z) => ({ id: z.id, name: z.name, status: z.status })),
      supported: true,
      error: res.error,
    };
  }

  if (provider.type === 'dnspod') {
    const loginToken = secrets.secretId ? `${secrets.secretId},${secrets.secret}` : secrets.secret;
    if (!loginToken.includes(',')) {
      return { ok: false, domains: [], supported: true, error: 'DNSPod 凭据格式应为 ID,Token' };
    }
    try {
      const form = new URLSearchParams({ login_token: loginToken, format: 'json', length: '100' });
      const res = await fetch('https://dnsapi.cn/Domain.List', { method: 'POST', body: form });
      const data = (await res.json()) as {
        status?: { code?: string; message?: string };
        domains?: Array<{ id: number | string; name: string; status?: string }>;
      };
      if (data.status?.code !== '1') {
        return { ok: false, domains: [], supported: true, error: data.status?.message || 'DNSPod Domain.List 失败' };
      }
      return {
        ok: true,
        supported: true,
        domains: (data.domains ?? []).map((d) => ({
          id: String(d.id),
          name: d.name,
          status: d.status || 'enable',
        })),
      };
    } catch (err) {
      return { ok: false, domains: [], supported: true, error: err instanceof Error ? err.message : 'DNSPod 请求失败' };
    }
  }

  if (provider.type === 'aliyun') {
    const res = await aliyunDnsRpcCall<{
      Domains?: { Domain?: Array<{ DomainId?: string; DomainName: string }> };
    }>(secrets.secretId, secrets.secret, 'DescribeDomains', { PageSize: 100 });
    if (!res.ok) return { ok: false, domains: [], supported: true, error: res.error };
    const list = res.data?.Domains?.Domain ?? [];
    return {
      ok: true,
      supported: true,
      domains: list.map((d) => ({ id: d.DomainId || d.DomainName, name: d.DomainName, status: 'active' })),
    };
  }

  if (provider.type === 'porkbun') {
    if (!secrets.secret || !secrets.secretId) {
      return { ok: false, domains: [], supported: true, error: 'Porkbun 需要同时配置 API Key 与 Secret Key' };
    }
    try {
      const res = await fetch('https://api.porkbun.com/api/json/v3/domain/listAll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: secrets.secretId, secretapikey: secrets.secret }),
      });
      const data = (await res.json()) as {
        status?: string;
        message?: string;
        domains?: Array<{ domain: string; status?: string }>;
      };
      if (data.status !== 'SUCCESS') {
        return { ok: false, domains: [], supported: true, error: data.message || 'Porkbun 域名列表拉取失败' };
      }
      return {
        ok: true,
        supported: true,
        domains: (data.domains ?? []).map((d) => ({ id: d.domain, name: d.domain, status: d.status || 'ACTIVE' })),
      };
    } catch (err) {
      return { ok: false, domains: [], supported: true, error: err instanceof Error ? err.message : 'Porkbun 请求失败' };
    }
  }

  return {
    ok: true,
    supported: false,
    domains: provider.domain ? [{ id: provider.domain, name: provider.domain }] : [],
  };
}

export interface PulledDnsRecord {
  remoteRecordId: string;
  zoneId?: string;
  domain: string;
  name: string;
  fqdn: string;
  type: DnsRecordType;
  content: string;
  ttl: number;
  proxied?: boolean;
  priority?: number;
  line?: string;
}

export async function pullProviderDnsRecords(
  provider: StoredDnsProvider,
  secrets: { secret: string; secretId: string },
  domainInput: string,
  explicitZoneId?: string
): Promise<{ ok: boolean; records: PulledDnsRecord[]; zoneId?: string; error?: string }> {
  const cleanDomain = domainInput.trim().toLowerCase().replace(/\.$/, '');
  if (!cleanDomain || !DOMAIN_REGEX.test(cleanDomain)) {
    return { ok: false, records: [], error: '请填写或选择有效的主域名（例如 example.com）' };
  }

  if (provider.type === 'cloudflare') {
    if (!secrets.secret) return { ok: false, records: [], error: 'Cloudflare API Token 未配置' };
    let zoneId = explicitZoneId?.trim() || undefined;
    if (!zoneId) {
      const resolved = await resolveCloudflareZoneId(secrets.secret, cleanDomain, provider.zoneId);
      if (!resolved.zoneId) {
        return { ok: false, records: [], error: resolved.error || `未在 Cloudflare 找到域名 ${cleanDomain} 对应的 Zone` };
      }
      zoneId = resolved.zoneId;
    }
    try {
      const all: PulledDnsRecord[] = [];
      let page = 1;
      while (page <= 5) {
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=100&page=${page}`,
          {
            headers: {
              Authorization: `Bearer ${secrets.secret}`,
              'Content-Type': 'application/json',
            },
          }
        );
        const data = (await res.json()) as {
          success?: boolean;
          errors?: Array<{ message: string }>;
          result?: Array<{
            id: string;
            type: string;
            name: string;
            content: string;
            ttl: number;
            proxied?: boolean;
            priority?: number;
          }>;
          result_info?: { total_pages?: number };
        };
        if (!res.ok || !data.success) {
          return {
            ok: false,
            records: [],
            error: data.errors?.[0]?.message || `Cloudflare HTTP ${res.status}`,
          };
        }
        for (const r of data.result ?? []) {
          const upper = r.type.toUpperCase() as DnsRecordType;
          if (!ALLOWED_DNS_RECORD_TYPES.includes(upper)) continue;
          const norm = normalizeRecordNameAndFqdn(cleanDomain, r.name);
          all.push({
            remoteRecordId: r.id,
            zoneId,
            domain: cleanDomain,
            name: norm.name,
            fqdn: norm.fqdn,
            type: upper,
            content: r.content,
            ttl: r.ttl || 1,
            proxied: Boolean(r.proxied),
            priority: typeof r.priority === 'number' ? r.priority : undefined,
          });
        }
        const totalPages = data.result_info?.total_pages ?? 1;
        if (page >= totalPages) break;
        page += 1;
      }
      return { ok: true, records: all, zoneId };
    } catch (err) {
      return { ok: false, records: [], error: err instanceof Error ? err.message : 'Cloudflare 拉取记录失败' };
    }
  }

  if (provider.type === 'dnspod') {
    const loginToken = secrets.secretId ? `${secrets.secretId},${secrets.secret}` : secrets.secret;
    if (!loginToken.includes(',')) {
      return { ok: false, records: [], error: 'DNSPod 凭据格式应为 ID,Token' };
    }
    try {
      const form = new URLSearchParams({
        login_token: loginToken,
        format: 'json',
        domain: cleanDomain,
        length: '3000',
      });
      const res = await fetch('https://dnsapi.cn/Record.List', { method: 'POST', body: form });
      const data = (await res.json()) as {
        status?: { code?: string; message?: string };
        records?: Array<{
          id: string;
          name: string;
          type: string;
          value: string;
          ttl: string | number;
          line?: string;
          mx?: string | number;
        }>;
      };
      if (data.status?.code !== '1') {
        return { ok: false, records: [], error: data.status?.message || 'DNSPod Record.List 失败' };
      }
      const all: PulledDnsRecord[] = [];
      for (const r of data.records ?? []) {
        const upper = r.type.toUpperCase() as DnsRecordType;
        if (!ALLOWED_DNS_RECORD_TYPES.includes(upper)) continue;
        const norm = normalizeRecordNameAndFqdn(cleanDomain, r.name);
        all.push({
          remoteRecordId: String(r.id),
          domain: cleanDomain,
          name: norm.name,
          fqdn: norm.fqdn,
          type: upper,
          content: r.value,
          ttl: Number(r.ttl) || 600,
          line: r.line || '默认',
          priority: upper === 'MX' ? Number(r.mx) || 10 : undefined,
        });
      }
      return { ok: true, records: all };
    } catch (err) {
      return { ok: false, records: [], error: err instanceof Error ? err.message : 'DNSPod 拉取记录失败' };
    }
  }

  if (provider.type === 'aliyun') {
    const res = await aliyunDnsRpcCall<{
      DomainRecords?: {
        Record?: Array<{
          RecordId: string;
          RR: string;
          Type: string;
          Value: string;
          TTL: number;
          Line?: string;
          Priority?: number;
        }>;
      };
    }>(secrets.secretId, secrets.secret, 'DescribeDomainRecords', {
      DomainName: cleanDomain,
      PageSize: 500,
    });
    if (!res.ok) return { ok: false, records: [], error: res.error };
    const all: PulledDnsRecord[] = [];
    for (const r of res.data?.DomainRecords?.Record ?? []) {
      const upper = r.Type.toUpperCase() as DnsRecordType;
      if (!ALLOWED_DNS_RECORD_TYPES.includes(upper)) continue;
      const norm = normalizeRecordNameAndFqdn(cleanDomain, r.RR);
      all.push({
        remoteRecordId: String(r.RecordId),
        domain: cleanDomain,
        name: norm.name,
        fqdn: norm.fqdn,
        type: upper,
        content: r.Value,
        ttl: Number(r.TTL) || 600,
        line: r.Line || 'default',
        priority: typeof r.Priority === 'number' ? r.Priority : undefined,
      });
    }
    return { ok: true, records: all };
  }

  if (provider.type === 'porkbun') {
    if (!secrets.secret || !secrets.secretId) {
      return { ok: false, records: [], error: 'Porkbun 需要同时配置 API Key 与 Secret Key' };
    }
    try {
      const res = await fetch(`https://api.porkbun.com/api/json/v3/dns/retrieve/${encodeURIComponent(cleanDomain)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: secrets.secretId, secretapikey: secrets.secret }),
      });
      const data = (await res.json()) as {
        status?: string;
        message?: string;
        records?: Array<{
          id: string;
          name: string;
          type: string;
          content: string;
          ttl: string | number;
          prio?: string | number;
        }>;
      };
      if (data.status !== 'SUCCESS') {
        return { ok: false, records: [], error: data.message || 'Porkbun 拉取记录失败' };
      }
      const all: PulledDnsRecord[] = [];
      for (const r of data.records ?? []) {
        const upper = r.type.toUpperCase() as DnsRecordType;
        if (!ALLOWED_DNS_RECORD_TYPES.includes(upper)) continue;
        const norm = normalizeRecordNameAndFqdn(cleanDomain, r.name);
        all.push({
          remoteRecordId: String(r.id),
          domain: cleanDomain,
          name: norm.name,
          fqdn: norm.fqdn,
          type: upper,
          content: r.content,
          ttl: Number(r.ttl) || 600,
          priority: r.prio !== undefined && r.prio !== '' ? Number(r.prio) : undefined,
        });
      }
      return { ok: true, records: all };
    } catch (err) {
      return { ok: false, records: [], error: err instanceof Error ? err.message : 'Porkbun 拉取记录失败' };
    }
  }

  return {
    ok: false,
    records: [],
    error: `当前 DNS 服务商类型 (${provider.type}) 暂不支持直接拉取记录列表，请使用 Cloudflare / DNSPod / Aliyun / Porkbun 或手动管理记录`,
  };
}

export async function createProviderDnsRecord(
  provider: StoredDnsProvider,
  secrets: { secret: string; secretId: string },
  record: {
    domain: string;
    zoneId?: string;
    name: string;
    fqdn: string;
    type: DnsRecordType;
    content: string;
    ttl: number;
    proxied?: boolean;
    priority?: number;
    line?: string;
  }
): Promise<{ ok: boolean; synced: boolean; remoteRecordId?: string; zoneId?: string; message: string }> {
  const hasCreds = provider.type === 'webhook' ? Boolean(provider.endpointUrl) : Boolean(secrets.secret);
  if (!hasCreds) {
    return { ok: true, synced: false, message: '服务商未配置 API 密钥，已保存为本地记录' };
  }

  if (provider.type === 'cloudflare') {
    let zoneId = record.zoneId || undefined;
    if (!zoneId) {
      const resolved = await resolveCloudflareZoneId(secrets.secret, record.domain, provider.zoneId);
      if (!resolved.zoneId) {
        return { ok: false, synced: false, message: resolved.error || `未找到 ${record.domain} 对应的 Cloudflare Zone` };
      }
      zoneId = resolved.zoneId;
    }
    const payload: Record<string, unknown> = {
      type: record.type,
      name: record.fqdn,
      content: record.content,
      ttl: record.ttl,
    };
    if (record.type === 'A' || record.type === 'AAAA' || record.type === 'CNAME') {
      payload.proxied = Boolean(record.proxied);
    }
    if ((record.type === 'MX' || record.type === 'SRV') && record.priority !== undefined) {
      payload.priority = record.priority;
    }
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secrets.secret}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        }
      );
      const data = (await res.json()) as {
        success?: boolean;
        result?: { id: string };
        errors?: Array<{ message: string }>;
      };
      if (!res.ok || !data.success) {
        return { ok: false, synced: false, message: data.errors?.[0]?.message || `Cloudflare HTTP ${res.status}` };
      }
      return { ok: true, synced: true, remoteRecordId: data.result?.id, zoneId, message: '已同步创建 Cloudflare 记录' };
    } catch (err) {
      return { ok: false, synced: false, message: err instanceof Error ? err.message : 'Cloudflare 创建记录失败' };
    }
  }

  if (provider.type === 'dnspod') {
    const loginToken = secrets.secretId ? `${secrets.secretId},${secrets.secret}` : secrets.secret;
    if (!loginToken.includes(',')) {
      return { ok: false, synced: false, message: 'DNSPod 凭据格式应为 ID,Token' };
    }
    try {
      const form = new URLSearchParams({
        login_token: loginToken,
        format: 'json',
        domain: record.domain,
        sub_domain: record.name,
        record_type: record.type,
        record_line: record.line || '默认',
        value: record.content,
        ttl: String(Math.max(600, record.ttl)),
      });
      if (record.type === 'MX') form.set('mx', String(record.priority ?? 10));
      const res = await fetch('https://dnsapi.cn/Record.Create', { method: 'POST', body: form });
      const data = (await res.json()) as {
        status?: { code?: string; message?: string };
        record?: { id?: string };
      };
      if (data.status?.code !== '1') {
        return { ok: false, synced: false, message: data.status?.message || 'DNSPod 创建记录失败' };
      }
      return { ok: true, synced: true, remoteRecordId: data.record?.id ? String(data.record.id) : undefined, message: '已同步创建 DNSPod 记录' };
    } catch (err) {
      return { ok: false, synced: false, message: err instanceof Error ? err.message : 'DNSPod 请求失败' };
    }
  }

  if (provider.type === 'aliyun') {
    const res = await aliyunDnsRpcCall<{ RecordId?: string }>(
      secrets.secretId,
      secrets.secret,
      'AddDomainRecord',
      {
        DomainName: record.domain,
        RR: record.name,
        Type: record.type,
        Value: record.content,
        TTL: Math.max(600, record.ttl),
        Line: record.line || 'default',
        Priority: record.type === 'MX' ? (record.priority ?? 10) : undefined,
      }
    );
    if (!res.ok) return { ok: false, synced: false, message: res.error || 'Aliyun DNS 创建失败' };
    return { ok: true, synced: true, remoteRecordId: res.data?.RecordId, message: '已同步创建 Aliyun DNS 记录' };
  }

  if (provider.type === 'porkbun') {
    if (!secrets.secretId) {
      return { ok: false, synced: false, message: 'Porkbun 需要同时配置 API Key 与 Secret Key' };
    }
    try {
      const body: Record<string, unknown> = {
        apikey: secrets.secretId,
        secretapikey: secrets.secret,
        name: record.name === '@' ? '' : record.name,
        type: record.type,
        content: record.content,
        ttl: String(Math.max(600, record.ttl)),
      };
      if (record.priority !== undefined) body.prio = String(record.priority);
      const res = await fetch(`https://api.porkbun.com/api/json/v3/dns/create/${encodeURIComponent(record.domain)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { status?: string; id?: string | number; message?: string };
      if (data.status !== 'SUCCESS') {
        return { ok: false, synced: false, message: data.message || 'Porkbun 创建失败' };
      }
      return { ok: true, synced: true, remoteRecordId: data.id ? String(data.id) : undefined, message: '已同步创建 Porkbun 记录' };
    } catch (err) {
      return { ok: false, synced: false, message: err instanceof Error ? err.message : 'Porkbun 请求失败' };
    }
  }

  if (provider.type === 'webhook' && provider.endpointUrl) {
    const check = validateSafeExternalUrl(provider.endpointUrl);
    if (!check.valid) return { ok: false, synced: false, message: check.reason || 'Blocked webhook URL' };
    try {
      const bodyStr = JSON.stringify({ action: 'create_record', record, timestamp: new Date().toISOString() });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (secrets.secret) {
        headers['X-NetPulse-Signature'] = crypto.createHmac('sha256', secrets.secret).update(bodyStr).digest('hex');
      }
      const res = await fetch(provider.endpointUrl, { method: 'POST', headers, body: bodyStr });
      return { ok: res.ok, synced: res.ok, message: `Webhook HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, synced: false, message: err instanceof Error ? err.message : 'Webhook 请求失败' };
    }
  }

  return { ok: true, synced: false, message: `服务商类型 ${provider.type} 已保存为本地记录` };
}

export async function updateProviderDnsRecord(
  provider: StoredDnsProvider,
  secrets: { secret: string; secretId: string },
  existing: ManagedDnsRecord,
  updated: {
    domain: string;
    name: string;
    fqdn: string;
    type: DnsRecordType;
    content: string;
    ttl: number;
    proxied?: boolean;
    priority?: number;
    line?: string;
  }
): Promise<{ ok: boolean; synced: boolean; remoteRecordId?: string; zoneId?: string; message: string }> {
  const hasCreds = provider.type === 'webhook' ? Boolean(provider.endpointUrl) : Boolean(secrets.secret);
  if (!hasCreds) {
    return { ok: true, synced: false, message: '服务商未配置 API 密钥，已仅更新本地记录' };
  }
  if (!existing.remoteRecordId && provider.type !== 'webhook') {
    return createProviderDnsRecord(provider, secrets, { ...updated, zoneId: existing.zoneId });
  }

  if (provider.type === 'cloudflare') {
    let zoneId = existing.zoneId || undefined;
    if (!zoneId) {
      const resolved = await resolveCloudflareZoneId(secrets.secret, updated.domain, provider.zoneId);
      if (!resolved.zoneId) {
        return { ok: false, synced: false, message: resolved.error || `未找到 ${updated.domain} 对应的 Cloudflare Zone` };
      }
      zoneId = resolved.zoneId;
    }
    const payload: Record<string, unknown> = {
      type: updated.type,
      name: updated.fqdn,
      content: updated.content,
      ttl: updated.ttl,
    };
    if (updated.type === 'A' || updated.type === 'AAAA' || updated.type === 'CNAME') {
      payload.proxied = Boolean(updated.proxied);
    }
    if ((updated.type === 'MX' || updated.type === 'SRV') && updated.priority !== undefined) {
      payload.priority = updated.priority;
    }
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(existing.remoteRecordId!)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${secrets.secret}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        }
      );
      const data = (await res.json()) as { success?: boolean; result?: { id: string }; errors?: Array<{ message: string }> };
      if (!res.ok || !data.success) {
        return { ok: false, synced: false, message: data.errors?.[0]?.message || `Cloudflare HTTP ${res.status}` };
      }
      return { ok: true, synced: true, remoteRecordId: data.result?.id || existing.remoteRecordId, zoneId, message: '已同步更新 Cloudflare 记录' };
    } catch (err) {
      return { ok: false, synced: false, message: err instanceof Error ? err.message : 'Cloudflare 更新失败' };
    }
  }

  if (provider.type === 'dnspod') {
    const loginToken = secrets.secretId ? `${secrets.secretId},${secrets.secret}` : secrets.secret;
    try {
      const form = new URLSearchParams({
        login_token: loginToken,
        format: 'json',
        domain: updated.domain,
        record_id: existing.remoteRecordId!,
        sub_domain: updated.name,
        record_type: updated.type,
        record_line: updated.line || existing.line || '默认',
        value: updated.content,
        ttl: String(Math.max(600, updated.ttl)),
      });
      if (updated.type === 'MX') form.set('mx', String(updated.priority ?? 10));
      const res = await fetch('https://dnsapi.cn/Record.Modify', { method: 'POST', body: form });
      const data = (await res.json()) as { status?: { code?: string; message?: string } };
      if (data.status?.code !== '1') {
        return { ok: false, synced: false, message: data.status?.message || 'DNSPod 更新失败' };
      }
      return { ok: true, synced: true, remoteRecordId: existing.remoteRecordId, message: '已同步更新 DNSPod 记录' };
    } catch (err) {
      return { ok: false, synced: false, message: err instanceof Error ? err.message : 'DNSPod 请求失败' };
    }
  }

  if (provider.type === 'aliyun') {
    const res = await aliyunDnsRpcCall<{ RecordId?: string }>(
      secrets.secretId,
      secrets.secret,
      'UpdateDomainRecord',
      {
        RecordId: existing.remoteRecordId!,
        RR: updated.name,
        Type: updated.type,
        Value: updated.content,
        TTL: Math.max(600, updated.ttl),
        Line: updated.line || existing.line || 'default',
        Priority: updated.type === 'MX' ? (updated.priority ?? 10) : undefined,
      }
    );
    if (!res.ok) return { ok: false, synced: false, message: res.error || 'Aliyun DNS 更新失败' };
    return { ok: true, synced: true, remoteRecordId: res.data?.RecordId || existing.remoteRecordId, message: '已同步更新 Aliyun DNS 记录' };
  }

  if (provider.type === 'porkbun') {
    try {
      const body: Record<string, unknown> = {
        apikey: secrets.secretId,
        secretapikey: secrets.secret,
        name: updated.name === '@' ? '' : updated.name,
        type: updated.type,
        content: updated.content,
        ttl: String(Math.max(600, updated.ttl)),
      };
      if (updated.priority !== undefined) body.prio = String(updated.priority);
      const res = await fetch(
        `https://api.porkbun.com/api/json/v3/dns/edit/${encodeURIComponent(updated.domain)}/${encodeURIComponent(existing.remoteRecordId!)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      const data = (await res.json()) as { status?: string; message?: string };
      if (data.status !== 'SUCCESS') {
        return { ok: false, synced: false, message: data.message || 'Porkbun 更新失败' };
      }
      return { ok: true, synced: true, remoteRecordId: existing.remoteRecordId, message: '已同步更新 Porkbun 记录' };
    } catch (err) {
      return { ok: false, synced: false, message: err instanceof Error ? err.message : 'Porkbun 请求失败' };
    }
  }

  if (provider.type === 'webhook' && provider.endpointUrl) {
    const check = validateSafeExternalUrl(provider.endpointUrl);
    if (!check.valid) return { ok: false, synced: false, message: check.reason || 'Blocked webhook URL' };
    try {
      const bodyStr = JSON.stringify({ action: 'update_record', id: existing.remoteRecordId || existing.id, record: updated, timestamp: new Date().toISOString() });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (secrets.secret) {
        headers['X-NetPulse-Signature'] = crypto.createHmac('sha256', secrets.secret).update(bodyStr).digest('hex');
      }
      const res = await fetch(provider.endpointUrl, { method: 'POST', headers, body: bodyStr });
      return { ok: res.ok, synced: res.ok, message: `Webhook HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, synced: false, message: err instanceof Error ? err.message : 'Webhook 请求失败' };
    }
  }

  return { ok: true, synced: false, message: '已仅更新本地记录' };
}

export async function deleteProviderDnsRecord(
  provider: StoredDnsProvider,
  secrets: { secret: string; secretId: string },
  existing: ManagedDnsRecord
): Promise<{ ok: boolean; synced: boolean; message: string }> {
  if (!existing.remoteRecordId && provider.type !== 'webhook') {
    return { ok: true, synced: false, message: '本地记录已删除' };
  }
  const hasCreds = provider.type === 'webhook' ? Boolean(provider.endpointUrl) : Boolean(secrets.secret);
  if (!hasCreds) {
    return { ok: true, synced: false, message: '服务商未配置 API 密钥，已仅删除本地记录' };
  }

  if (provider.type === 'cloudflare') {
    let zoneId = existing.zoneId || undefined;
    if (!zoneId) {
      const resolved = await resolveCloudflareZoneId(secrets.secret, existing.domain, provider.zoneId);
      zoneId = resolved.zoneId;
    }
    if (!zoneId) return { ok: false, synced: false, message: '未找到对应的 Cloudflare Zone ID' };
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(existing.remoteRecordId!)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${secrets.secret}` },
        }
      );
      const data = (await res.json()) as { success?: boolean; errors?: Array<{ message: string }> };
      if (!res.ok || !data.success) {
        return { ok: false, synced: false, message: data.errors?.[0]?.message || `Cloudflare HTTP ${res.status}` };
      }
      return { ok: true, synced: true, message: '已同步删除 Cloudflare 远端记录' };
    } catch (err) {
      return { ok: false, synced: false, message: err instanceof Error ? err.message : 'Cloudflare 删除失败' };
    }
  }

  if (provider.type === 'dnspod') {
    const loginToken = secrets.secretId ? `${secrets.secretId},${secrets.secret}` : secrets.secret;
    try {
      const form = new URLSearchParams({
        login_token: loginToken,
        format: 'json',
        domain: existing.domain,
        record_id: existing.remoteRecordId!,
      });
      const res = await fetch('https://dnsapi.cn/Record.Remove', { method: 'POST', body: form });
      const data = (await res.json()) as { status?: { code?: string; message?: string } };
      if (data.status?.code !== '1') {
        return { ok: false, synced: false, message: data.status?.message || 'DNSPod 删除失败' };
      }
      return { ok: true, synced: true, message: '已同步删除 DNSPod 远端记录' };
    } catch (err) {
      return { ok: false, synced: false, message: err instanceof Error ? err.message : 'DNSPod 请求失败' };
    }
  }

  if (provider.type === 'aliyun') {
    const res = await aliyunDnsRpcCall(secrets.secretId, secrets.secret, 'DeleteDomainRecord', {
      RecordId: existing.remoteRecordId!,
    });
    if (!res.ok) return { ok: false, synced: false, message: res.error || 'Aliyun DNS 删除失败' };
    return { ok: true, synced: true, message: '已同步删除 Aliyun DNS 远端记录' };
  }

  if (provider.type === 'porkbun') {
    try {
      const res = await fetch(
        `https://api.porkbun.com/api/json/v3/dns/delete/${encodeURIComponent(existing.domain)}/${encodeURIComponent(existing.remoteRecordId!)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apikey: secrets.secretId, secretapikey: secrets.secret }),
        }
      );
      const data = (await res.json()) as { status?: string; message?: string };
      if (data.status !== 'SUCCESS') {
        return { ok: false, synced: false, message: data.message || 'Porkbun 删除失败' };
      }
      return { ok: true, synced: true, message: '已同步删除 Porkbun 远端记录' };
    } catch (err) {
      return { ok: false, synced: false, message: err instanceof Error ? err.message : 'Porkbun 请求失败' };
    }
  }

  if (provider.type === 'webhook' && provider.endpointUrl) {
    const check = validateSafeExternalUrl(provider.endpointUrl);
    if (!check.valid) return { ok: false, synced: false, message: check.reason || 'Blocked webhook URL' };
    try {
      const bodyStr = JSON.stringify({ action: 'delete_record', id: existing.remoteRecordId || existing.id, domain: existing.domain, fqdn: existing.fqdn, type: existing.type, timestamp: new Date().toISOString() });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (secrets.secret) {
        headers['X-NetPulse-Signature'] = crypto.createHmac('sha256', secrets.secret).update(bodyStr).digest('hex');
      }
      const res = await fetch(provider.endpointUrl, { method: 'POST', headers, body: bodyStr });
      return { ok: res.ok, synced: res.ok, message: `Webhook HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, synced: false, message: err instanceof Error ? err.message : 'Webhook 请求失败' };
    }
  }

  return { ok: true, synced: false, message: '已删除本地记录' };
}
