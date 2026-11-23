import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AuditLogEntry,
  AuditStats,
  CloudAccount,
  CloudHost,
  CronJob,
  DnsProvider,
  DnsSyncRule,
  ManagedDnsRecord,
  ManagedIpRecord,
  MonitorTarget,
  NotificationChannel,
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

export interface PersistedState {
  admin?: AdminRecord;
  security: SecurityConfig;
  dnsProviders: StoredDnsProvider[];
  dnsRules: DnsSyncRule[];
  dnsRecords: ManagedDnsRecord[];
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
  const cfId = 'prov-cf-primary';
  const dpId = 'prov-dp-cn';
  const ociTokyoId = 'oci-ap-tokyo-1';
  const ociAshburnId = 'oci-us-ashburn-1';
  const ociFrankfurtId = 'oci-eu-frankfurt-1';
  const ruleEdgeId = 'rule-edge-dualstack';
  const ruleCnId = 'rule-dnspod-v6pool';

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
    dnsProviders: [
      {
        id: cfId,
        name: 'Cloudflare Global Edge',
        type: 'cloudflare',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: dpId,
        name: 'DNSPod Mainland China',
        type: 'dnspod',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'prov-aliyun-dns',
        name: 'Aliyun DNS Enterprise',
        type: 'aliyun',
        createdAt: now,
        updatedAt: now,
      },
    ],
    dnsRules: [
      {
        id: ruleEdgeId,
        name: 'Tokyo ARM Edge Dual-Stack Pool',
        providerId: cfId,
        domain: 'example.net',
        recordName: 'jp-edge',
        ttl: 120,
        proxied: false,
        line: 'default',
        syncIpv4: true,
        ipv4Address: '138.2.45.109',
        ipv4Source: 'cloud_host',
        syncIpv6: true,
        ipv6Mode: 'round_robin',
        ipv6Targets: [
          {
            id: 'v6-1',
            recordName: 'jp-edge',
            address: '2603:c020:4009:a100::10',
            proxied: false,
            enabled: true,
            lastStatus: 'pending',
          },
          {
            id: 'v6-2',
            recordName: 'jp-edge',
            address: '2603:c020:4009:a100::11',
            proxied: false,
            enabled: true,
            lastStatus: 'pending',
          },
          {
            id: 'v6-3',
            recordName: 'jp-edge',
            address: '2603:c020:4009:a100::12',
            proxied: false,
            enabled: true,
            lastStatus: 'pending',
          },
        ],
        linkedHostId: 'host-oci-tokyo-arm',
        dryRun: true,
        enabled: true,
        lastStatus: 'pending',
        lastMessage: 'Dry-run template ready; configure API token to push live updates',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: ruleCnId,
        name: 'DNSPod Multi-IPv6 Subnet Split',
        providerId: dpId,
        domain: 'corp-edge.cn',
        recordName: 'gateway',
        ttl: 600,
        proxied: false,
        line: '默认',
        syncIpv4: true,
        ipv4Address: '119.29.88.42',
        ipv4Source: 'manual',
        syncIpv6: true,
        ipv6Mode: 'per_host',
        ipv6Targets: [
          {
            id: 'v6-cn-1',
            recordName: 'v6-a.gateway',
            address: '2402:4e00:1013:e500::201',
            enabled: true,
            lastStatus: 'pending',
          },
          {
            id: 'v6-cn-2',
            recordName: 'v6-b.gateway',
            address: '2402:4e00:1013:e500::202',
            enabled: true,
            lastStatus: 'pending',
          },
        ],
        dryRun: true,
        enabled: true,
        lastStatus: 'pending',
        lastMessage: 'Dry-run template ready',
        createdAt: now,
        updatedAt: now,
      },
    ],
    dnsRecords: [
      {
        id: 'rec-cf-edge-a',
        providerId: cfId,
        domain: 'example.net',
        name: 'jp-edge',
        fqdn: 'jp-edge.example.net',
        type: 'A',
        content: '138.2.45.109',
        ttl: 120,
        proxied: false,
        groupName: '边缘节点',
        notes: 'OCI Tokyo ARM 主节点 IPv4',
        source: 'manual',
        syncState: 'local_only',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'rec-cf-edge-aaaa',
        providerId: cfId,
        domain: 'example.net',
        name: 'jp-edge',
        fqdn: 'jp-edge.example.net',
        type: 'AAAA',
        content: '2603:c020:4009:a100::10',
        ttl: 120,
        proxied: false,
        groupName: '边缘节点',
        notes: 'OCI Tokyo ARM IPv6 入口',
        source: 'manual',
        syncState: 'local_only',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'rec-cf-app-cname',
        providerId: cfId,
        domain: 'example.net',
        name: 'app',
        fqdn: 'app.example.net',
        type: 'CNAME',
        content: 'jp-edge.example.net',
        ttl: 300,
        proxied: true,
        groupName: '业务入口',
        notes: '主站 CDN 加速别名',
        source: 'manual',
        syncState: 'local_only',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'rec-cf-root-mx',
        providerId: cfId,
        domain: 'example.net',
        name: '@',
        fqdn: 'example.net',
        type: 'MX',
        content: 'mail.example.net',
        ttl: 600,
        priority: 10,
        groupName: '安全验证',
        notes: '企业邮局收信记录',
        source: 'manual',
        syncState: 'local_only',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'rec-cf-spf-txt',
        providerId: cfId,
        domain: 'example.net',
        name: '@',
        fqdn: 'example.net',
        type: 'TXT',
        content: 'v=spf1 include:_spf.example.net ~all',
        ttl: 600,
        groupName: '安全验证',
        notes: 'SPF 发信校验',
        source: 'manual',
        syncState: 'local_only',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'rec-dp-cn-a',
        providerId: dpId,
        domain: 'cn-ops.example.com',
        name: 'api',
        fqdn: 'api.cn-ops.example.com',
        type: 'A',
        content: '129.146.88.24',
        ttl: 600,
        line: '默认',
        groupName: '业务入口',
        notes: '国内线路 API 网关',
        source: 'manual',
        syncState: 'local_only',
        createdAt: now,
        updatedAt: now,
      },
    ],
    ociProfiles: [
      {
        id: ociTokyoId,
        name: 'OCI Japan East (Tokyo)',
        region: 'ap-tokyo-1',
        tenancyOcid: 'ocid1.tenancy.oc1..aaaaaaaademotokyo0001',
        userOcid: 'ocid1.user.oc1..aaaaaaaademouser0001',
        compartmentOcid: 'ocid1.tenancy.oc1..aaaaaaaademotokyo0001',
        fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
        subnetOcid: 'ocid1.subnet.oc1.ap-tokyo-1.aaaaaaaademosubnet01',
        availabilityDomains: ['AD-1'],
        instanceCount: 2,
        status: 'unverified',
        notes: 'Primary APAC Always-Free ARM region',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: ociAshburnId,
        name: 'OCI US East (Ashburn)',
        region: 'us-ashburn-1',
        tenancyOcid: 'ocid1.tenancy.oc1..aaaaaaaademoashburn02',
        userOcid: 'ocid1.user.oc1..aaaaaaaademouser0002',
        compartmentOcid: 'ocid1.tenancy.oc1..aaaaaaaademoashburn02',
        fingerprint: '11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00',
        subnetOcid: 'ocid1.subnet.oc1.iad.aaaaaaaademosubnet02',
        availabilityDomains: ['AD-1', 'AD-2', 'AD-3'],
        instanceCount: 1,
        status: 'unverified',
        notes: '3-AD US East region for high-availability ARM allocation',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: ociFrankfurtId,
        name: 'OCI Germany Central (Frankfurt)',
        region: 'eu-frankfurt-1',
        tenancyOcid: 'ocid1.tenancy.oc1..aaaaaaaademofrankfurt3',
        userOcid: 'ocid1.user.oc1..aaaaaaaademouser0003',
        compartmentOcid: 'ocid1.tenancy.oc1..aaaaaaaademofrankfurt3',
        fingerprint: '22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11',
        subnetOcid: 'ocid1.subnet.oc1.eu-frankfurt-1.aaaaaaaademosubnet03',
        availabilityDomains: ['AD-1', 'AD-2', 'AD-3'],
        instanceCount: 1,
        status: 'unverified',
        notes: 'EU GDPR node with /56 IPv6 VCN',
        createdAt: now,
        updatedAt: now,
      },
    ],
    ociSniperTasks: [
      {
        id: 'sniper-tokyo-arm-4c24g',
        name: 'Tokyo Ampere A1.Flex 4C/24G Sniper',
        profileId: ociTokyoId,
        displayName: 'oci-tokyo-arm-edge-01',
        shape: 'VM.Standard.A1.Flex',
        ocpus: 4,
        memoryInGBs: 24,
        bootVolumeSizeInGBs: 100,
        imageOcid: 'ocid1.image.oc1.ap-tokyo-1.aaaaaaaademoubuntu2404arm',
        osPreset: 'Ubuntu 24.04 Minimal aarch64',
        sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoKeyReplaceWithYourOwnKey ops@netpulse',
        availabilityDomains: ['AD-1'],
        assignPublicIp: true,
        assignIpv6: true,
        intervalSeconds: 45,
        jitterPercent: 20,
        retryOnOutOfCapacity: true,
        backoffOn429Seconds: 180,
        maxAttempts: 0,
        autoStopOnSuccess: true,
        autoBindDnsRuleId: ruleEdgeId,
        useSystemNotifications: true,
        notifyChannelIds: [],
        status: 'paused',
        attempts: 0,
        lastMessage: 'Upload OCI API private key in profile to start live allocation attempts',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'sniper-ashburn-arm-2c12g',
        name: 'Ashburn Multi-AD A1.Flex 2C/12G',
        profileId: ociAshburnId,
        displayName: 'oci-iad-arm-relay-02',
        shape: 'VM.Standard.A1.Flex',
        ocpus: 2,
        memoryInGBs: 12,
        bootVolumeSizeInGBs: 50,
        imageOcid: 'ocid1.image.oc1.iad.aaaaaaaademodebian12arm',
        osPreset: 'Debian 12 aarch64',
        sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoKeyReplaceWithYourOwnKey ops@netpulse',
        availabilityDomains: ['AD-1', 'AD-2', 'AD-3'],
        assignPublicIp: true,
        assignIpv6: true,
        intervalSeconds: 60,
        jitterPercent: 25,
        retryOnOutOfCapacity: true,
        backoffOn429Seconds: 240,
        maxAttempts: 500,
        autoStopOnSuccess: true,
        useSystemNotifications: true,
        notifyChannelIds: [],
        status: 'paused',
        attempts: 0,
        lastMessage: 'Paused — ready to configure and start',
        createdAt: now,
        updatedAt: now,
      },
    ],
    cloudAccounts: [],
    cloudHosts: [
      {
        id: 'host-oci-tokyo-arm',
        name: 'oci-tokyo-arm-01',
        groupName: '亚太节点',
        provider: 'oracle',
        region: 'ap-tokyo-1',
        ociProfileId: ociTokyoId,
        ociLifecycleState: 'RUNNING',
        availabilityDomain: 'AD-1',
        instanceId: 'ocid1.instance.oc1.ap-tokyo-1.anxhiljr4demo01',
        architecture: 'arm64',
        specs: 'VM.Standard.A1.Flex · 4 OCPU · 24 GB',
        ipv4: '138.2.45.109',
        ipv6List: [
          '2603:c020:4009:a100::10',
          '2603:c020:4009:a100::11',
          '2603:c020:4009:a100::12',
        ],
        sshPort: 22,
        sshUser: 'ubuntu',
        linkedDnsRuleId: ruleEdgeId,
        linkedDnsRuleIds: [ruleEdgeId],
        status: 'online',
        lastCheckedAt: now,
        notes: 'OCI Tokyo Always-Free ARM node with /64 IPv6 pool',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'host-oci-ashburn-arm',
        name: 'oci-ashburn-arm-01',
        groupName: '美东节点',
        provider: 'oracle',
        region: 'us-ashburn-1',
        ociProfileId: ociAshburnId,
        ociLifecycleState: 'RUNNING',
        availabilityDomain: 'AD-1',
        instanceId: 'ocid1.instance.oc1.iad.anxhiljr4demo02',
        architecture: 'arm64',
        specs: 'VM.Standard.A1.Flex · 2 OCPU · 12 GB',
        ipv4: '129.146.88.24',
        ipv6List: ['2603:c020:c001:4400::10'],
        sshPort: 22,
        sshUser: 'ubuntu',
        status: 'online',
        lastCheckedAt: now,
        notes: 'OCI US East ARM node',
        createdAt: now,
        updatedAt: now,
      },
    ],
    managedIps: [
      {
        id: 'ip-oci-v4-1',
        address: '138.2.45.109',
        version: 'ipv4',
        label: 'Tokyo OCI Primary IPv4',
        hostId: 'host-oci-tokyo-arm',
        hostName: 'oci-tokyo-arm-01',
        provider: 'oracle',
        region: 'ap-tokyo-1',
        linkedDnsRuleIds: [ruleEdgeId],
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'ip-oci-v6-1',
        address: '2603:c020:4009:a100::10',
        version: 'ipv6',
        label: 'Tokyo OCI IPv6 Pool #1',
        hostId: 'host-oci-tokyo-arm',
        hostName: 'oci-tokyo-arm-01',
        provider: 'oracle',
        region: 'ap-tokyo-1',
        linkedDnsRuleIds: [ruleEdgeId],
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'ip-oci-v6-2',
        address: '2603:c020:4009:a100::11',
        version: 'ipv6',
        label: 'Tokyo OCI IPv6 Pool #2',
        hostId: 'host-oci-tokyo-arm',
        hostName: 'oci-tokyo-arm-01',
        provider: 'oracle',
        region: 'ap-tokyo-1',
        linkedDnsRuleIds: [ruleEdgeId],
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'ip-hetzner-v4-1',
        address: '49.13.112.74',
        version: 'ipv4',
        label: 'Hetzner EU ARM Ingress',
        hostId: 'host-hetzner-fsn1',
        hostName: 'hetzner-fsn1-cax21',
        provider: 'hetzner',
        region: 'fsn1',
        linkedDnsRuleIds: [],
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ],
    monitors: [
      {
        id: 'mon-cf-https',
        name: 'Cloudflare Edge HTTPS Probe',
        type: 'http',
        target: 'https://1.1.1.1/cdn-cgi/trace',
        intervalSeconds: 60,
        timeoutMs: 5000,
        failureThreshold: 2,
        enabled: true,
        notifyOnAlert: true,
        status: 'pending',
        consecutiveFailures: 0,
        uptimePercent: 100,
        history: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'mon-dns-resolve',
        name: 'Public DNS Resolution Check',
        type: 'dns',
        target: 'cloudflare.com',
        intervalSeconds: 120,
        timeoutMs: 4000,
        failureThreshold: 2,
        enabled: true,
        notifyOnAlert: true,
        status: 'pending',
        consecutiveFailures: 0,
        uptimePercent: 100,
        history: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'mon-tcp-443',
        name: 'OCI / Edge TCP 443 Reachability',
        type: 'tcp',
        target: '1.1.1.1',
        port: 443,
        intervalSeconds: 60,
        timeoutMs: 4000,
        failureThreshold: 3,
        enabled: true,
        notifyOnAlert: true,
        status: 'pending',
        consecutiveFailures: 0,
        uptimePercent: 100,
        history: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    notificationChannels: [
      {
        id: 'notif-email-primary',
        name: 'SMTP Ops Email',
        type: 'email',
        enabled: false,
        events: ['oci_sniper_success', 'monitor_down', 'monitor_recover', 'ip_changed', 'dns_sync_fail'],
        smtpHost: 'smtp.qq.com',
        smtpPort: 465,
        smtpSecure: true,
        smtpUser: 'ops@example.com',
        emailFrom: 'NetPulse Ops <ops@example.com>',
        emailTo: 'admin@example.com',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'notif-serverchan-cn',
        name: 'Server酱 WeChat Alert',
        type: 'serverchan',
        enabled: false,
        events: ['oci_sniper_success', 'monitor_down', 'monitor_recover', 'ip_changed'],
        serverChanVersion: 'turbo',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'notif-telegram-bot',
        name: 'Telegram Ops Bot',
        type: 'telegram',
        enabled: false,
        events: ['oci_sniper_success', 'oci_sniper_error', 'monitor_down', 'monitor_recover'],
        target: '',
        createdAt: now,
        updatedAt: now,
      },
    ],
    cronJobs: [
      {
        id: 'cron-oci-ip-sync-15m',
        name: 'OCI 实例 IP 自动巡检并同步绑定域名 DNS',
        type: 'oci_ip_dns_policy',
        expression: '*/15 * * * *',
        targetIds: [],
        ipPolicy: {
          scope: 'all',
          targetGroups: [],
          targetHostIds: [],
          action: 'sync_dns_only',
          ipv6Count: 1,
          syncDnsAfter: true,
          notifyOnComplete: false,
        },
        enabled: true,
        nextRunAt: computeNextCronRun('*/15 * * * *'),
        lastStatus: 'success',
        lastSummary: '自动拉取各区域 OCI 实例最新 IPv4/IPv6 并更新对应绑定域名',
        runCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'cron-oci-sniper-1m',
        name: 'OCI ARM Sniper Tick Check (Every 1m)',
        type: 'oci_sniper_sweep',
        expression: '* * * * *',
        targetIds: [],
        enabled: true,
        nextRunAt: computeNextCronRun('* * * * *'),
        lastStatus: 'success',
        lastSummary: 'Monitors running OCI ARM sniper tasks',
        runCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'cron-monitor-2m',
        name: 'Endpoint & IP Uptime Monitor Sweep (Every 2m)',
        type: 'monitor_sweep',
        expression: '*/2 * * * *',
        targetIds: [],
        enabled: true,
        nextRunAt: computeNextCronRun('*/2 * * * *'),
        lastStatus: 'success',
        lastSummary: 'Runs TCP, HTTP, and DNS probes and alerts via System Notifications',
        runCount: 0,
        createdAt: now,
        updatedAt: now,
      },
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

class DataStore {
  private dataDir: string;
  private stateFile: string;
  private auditFile: string;
  private state: PersistedState;

  constructor() {
    this.dataDir = getDataDir();
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.stateFile = resolveConfinedPath(this.dataDir, 'state.json');
    this.auditFile = resolveConfinedPath(this.dataDir, 'audit.ndjson');
    this.state = this.loadState();
    if (!fs.existsSync(this.auditFile)) {
      fs.writeFileSync(this.auditFile, '', 'utf8');
      this.appendAudit({
        category: 'audit',
        severity: 'info',
        action: 'SYSTEM_INIT',
        actor: 'system',
        ip: '127.0.0.1',
        details: 'Initialized NetPulse container data store and size-capped audit log',
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
          useSystemNotifications: t.useSystemNotifications !== false,
          notifyChannelIds: Array.isArray(t.notifyChannelIds) ? t.notifyChannelIds : [],
        }));
        const legacyNonManagedSeedIds = new Set(['host-hetzner-fsn1', 'host-aws-lightsail-sg', 'host-vultr-nrt']);
        const managedProviders = new Set(['oracle', 'aws', 'aliyun', 'gcp']);
        const cleanedHosts = (parsed.cloudHosts ?? defaults.cloudHosts)
          .filter((h) => managedProviders.has(h.provider) && !legacyNonManagedSeedIds.has(h.id))
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
          dnsRecords: Array.isArray(parsed.dnsRecords) ? parsed.dnsRecords : defaults.dnsRecords,
          cloudAccounts: Array.isArray(parsed.cloudAccounts) ? parsed.cloudAccounts : [],
          cloudHosts: cleanedHosts,
          ociSniperTasks: mergedSnipers,
          managedIps: parsed.managedIps ?? defaults.managedIps,
          monitors: parsed.monitors ?? defaults.monitors,
          notificationChannels: parsed.notificationChannels ?? defaults.notificationChannels,
          security: { ...defaults.security, ...(parsed.security ?? {}) },
          auditMeta: { ...defaults.auditMeta, ...(parsed.auditMeta ?? {}) },
        };
      } catch {
        // Fallback to clean state if corrupted
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

  // ---- Admin Auth ----
  isEnvAdminConfigured(): boolean {
    return Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.trim().length > 0);
  }

  requiresBootstrap(): boolean {
    if (this.isEnvAdminConfigured()) return false;
    return !this.state.admin;
  }

  bootstrapAdmin(username: string, password: string): boolean {
    if (!this.requiresBootstrap()) return false;
    const now = new Date().toISOString();
    this.state.admin = {
      username: username.trim(),
      passwordHash: hashPassword(password),
      createdAt: now,
      updatedAt: now,
    };
    this.save();
    return true;
  }

  verifyAdminCredentials(username: string, password: string): { ok: boolean; canonicalUsername: string } {
    const envPass = process.env.ADMIN_PASSWORD?.trim();
    if (envPass) {
      const envUser = process.env.ADMIN_USERNAME?.trim() || 'admin';
      const userOk = safeEqualStrings(username.trim(), envUser);
      const passOk = safeEqualStrings(password, envPass);
      return { ok: userOk && passOk, canonicalUsername: envUser };
    }

    if (!this.state.admin) {
      return { ok: false, canonicalUsername: '' };
    }
    const userOk = safeEqualStrings(username.trim(), this.state.admin.username);
    const passOk = verifyPassword(password, this.state.admin.passwordHash);
    return { ok: userOk && passOk, canonicalUsername: this.state.admin.username };
  }

  updateAdminPassword(newPassword: string): boolean {
    if (this.isEnvAdminConfigured() || !this.state.admin) return false;
    this.state.admin.passwordHash = hashPassword(newPassword);
    this.state.admin.updatedAt = new Date().toISOString();
    this.save();
    return true;
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
