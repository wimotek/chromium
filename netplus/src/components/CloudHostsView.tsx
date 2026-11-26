import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  Check,
  ChevronDown,
  CloudDownload,
  Folder,
  Globe,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  Pencil,
  Play,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { translate, type TranslationKeys } from '../i18n/translations';
import { apiRequest, formatTimeAgo } from '../lib/api';
import { toast } from '../lib/toast';
import type {
  CloudAccount,
  CloudDiscoveredInstance,
  CloudHost,
  DnsProvider,
  DnsSyncRule,
  DnsZoneSummary,
  ExternalCloudProvider,
  LanguageCode,
  ManagedCloudProvider,
  ManagedDnsRecord,
  MonitorProbeType,
  MonitorTarget,
  OciDiscoveredInstance,
  OciDiscoveredResources,
  OciInstanceAction,
  OciProfile,
} from '../types/models';

interface CloudHostsViewProps {
  hosts: CloudHost[];
  cloudAccounts: CloudAccount[];
  dnsRules: DnsSyncRule[];
  dnsRecords: ManagedDnsRecord[];
  dnsProviders: DnsProvider[];
  ociProfiles: OciProfile[];
  monitors: MonitorTarget[];
  lang: LanguageCode;
  activeSubTab?: 'hosts' | 'accounts' | 'monitors';
  onSubTabChange?: (tab: 'hosts' | 'accounts' | 'monitors') => void;
  onReload: () => Promise<void>;
  onNavigateOci: () => void;
  onNavigateDns: () => void;
  onNavigateMonitors?: () => void;
}

const MANAGED_PROVIDERS: ManagedCloudProvider[] = ['oracle', 'aws', 'aliyun', 'gcp'];

const DEFAULT_OCI_REGIONS = [
  'ap-tokyo-1',
  'ap-osaka-1',
  'ap-seoul-1',
  'ap-chuncheon-1',
  'ap-singapore-1',
  'us-ashburn-1',
  'us-phoenix-1',
  'us-sanjose-1',
  'eu-frankfurt-1',
  'eu-amsterdam-1',
  'uk-london-1',
  'ca-toronto-1',
  'ap-sydney-1',
];

function parseOciConfigText(raw: string): {
  tenancyOcid?: string;
  userOcid?: string;
  region?: string;
} {
  const out: { tenancyOcid?: string; userOcid?: string; region?: string } = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([a-zA-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'tenancy') out.tenancyOcid = val;
    if (key === 'user') out.userOcid = val;
    if (key === 'region') out.region = val.toLowerCase();
  }
  return out;
}

function getPowerActionMeta(action: OciInstanceAction, isZh: boolean) {
  switch (action) {
    case 'START':
      return {
        label: isZh ? '远程开机 (Start)' : 'Power On (Start)',
        short: isZh ? '开机' : 'Start',
        confirmTitle: isZh ? '确认远程开机' : 'Confirm Power On',
        tone: 'emerald' as const,
        desc: isZh
          ? '调用云商 API 启动已关机实例。'
          : 'Sends a start command via the cloud provider API.',
      };
    case 'SOFTRESET':
      return {
        label: isZh ? '正常重启 (Soft Reboot)' : 'Soft Reboot (ACPI)',
        short: isZh ? '重启' : 'Reboot',
        confirmTitle: isZh ? '确认正常重启实例' : 'Confirm Soft Reboot',
        tone: 'amber' as const,
        desc: isZh
          ? '向操作系统发送 ACPI 重启信号，安全同步磁盘后重启。'
          : 'Sends a graceful ACPI reboot signal to the guest OS.',
      };
    case 'RESET':
      return {
        label: isZh ? '强制重启 (Hard Reset)' : 'Force Reboot (Hard Reset)',
        short: isZh ? '强启' : 'Force Reboot',
        confirmTitle: isZh ? '确认强制断电重启' : 'Confirm Force Reboot',
        tone: 'red' as const,
        desc: isZh
          ? '立即断电并硬重置实例，等效于物理机按复位键，可能导致未落盘数据丢失。'
          : 'Immediately power-cycles the instance. Unflushed data may be lost.',
      };
    case 'SOFTSTOP':
      return {
        label: isZh ? '远程关机 (ACPI Shutdown)' : 'Shutdown (Graceful Stop)',
        short: isZh ? '关机' : 'Shutdown',
        confirmTitle: isZh ? '确认远程正常关机' : 'Confirm Remote Shutdown',
        tone: 'amber' as const,
        desc: isZh
          ? '发送 ACPI 正常关机指令（OCI SOFTSTOP / AWS Stop / 阿里云 StopInstance / GCP Stop），实例将安全关闭。'
          : 'Sends a graceful ACPI shutdown via the cloud API.',
      };
    case 'STOP':
      return {
        label: isZh ? '强制关机 (Force Power Off)' : 'Force Shutdown (Power Off)',
        short: isZh ? '强关' : 'Force Off',
        confirmTitle: isZh ? '确认强制断电关机' : 'Confirm Force Shutdown',
        tone: 'red' as const,
        desc: isZh
          ? '立即切断实例电源（OCI STOP / AWS Force Stop / 阿里云 ForceStop / GCP Stop），等效于拔掉电源。'
          : 'Immediately cuts power to the instance via cloud API (Force Stop).',
      };
  }
}

const AWS_REGION_PRESETS = [
  'ap-northeast-1',
  'ap-southeast-1',
  'us-east-1',
  'us-west-2',
  'eu-central-1',
  'ap-east-1',
];

const ALIYUN_REGION_PRESETS = [
  'cn-hongkong',
  'ap-southeast-1',
  'cn-shanghai',
  'cn-beijing',
  'cn-hangzhou',
  'ap-northeast-1',
  'us-west-1',
];

const GCP_REGION_PRESETS = [
  'all',
  'asia-east1',
  'asia-northeast1',
  'asia-southeast1',
  'us-west1',
  'us-central1',
  'europe-west3',
];

function isDnsProviderConfigured(p?: DnsProvider): boolean {
  if (!p) return false;
  return p.type === 'webhook' ? Boolean(p.endpointUrl) : p.hasSecret;
}

function providerShortLabel(provider: string, isZh: boolean): string {
  switch (provider) {
    case 'oracle':
      return 'OCI';
    case 'aws':
      return 'AWS';
    case 'aliyun':
      return isZh ? '阿里云' : 'Aliyun';
    case 'gcp':
      return 'GCP';
    default:
      return provider.toUpperCase();
  }
}

function providerFullLabel(provider: ManagedCloudProvider, isZh: boolean): string {
  switch (provider) {
    case 'oracle':
      return 'Oracle OCI';
    case 'aws':
      return 'AWS EC2';
    case 'aliyun':
      return isZh ? '阿里云 ECS' : 'Aliyun ECS';
    case 'gcp':
      return 'Google Cloud';
  }
}

interface UnifiedImportItem {
  provider: ManagedCloudProvider;
  instanceId: string;
  displayName: string;
  region: string;
  zone?: string;
  specs: string;
  architecture: 'arm64' | 'x86_64';
  lifecycleState: string;
  publicIp?: string;
  ipv6List: string[];
  alreadyImported: boolean;
  raw: OciDiscoveredInstance | CloudDiscoveredInstance;
}

export function CloudHostsView({
  hosts,
  cloudAccounts,
  dnsRules,
  dnsRecords,
  dnsProviders,
  ociProfiles,
  monitors,
  lang,
  activeSubTab,
  onSubTabChange,
  onReload,
  onNavigateOci,
  onNavigateDns,
  onNavigateMonitors,
}: CloudHostsViewProps) {
  const t = (key: TranslationKeys) => translate(lang, key);
  const isZh = lang === 'zh-CN';

  const [internalSubTab, setInternalSubTab] = useState<'hosts' | 'accounts' | 'monitors'>(
    activeSubTab ?? 'hosts'
  );
  useEffect(() => {
    if (activeSubTab) setInternalSubTab(activeSubTab);
  }, [activeSubTab]);
  const subTab = activeSubTab ?? internalSubTab;
  const setSubTab = (tab: 'hosts' | 'accounts' | 'monitors') => {
    setInternalSubTab(tab);
    onSubTabChange?.(tab);
  };

  const [providerFilter, setProviderFilter] = useState<'all' | ManagedCloudProvider>('all');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [regionFilter, setRegionFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Action busy states
  const [syncingAll, setSyncingAll] = useState(false);
  const [pushingId, setPushingId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [monitoringId, setMonitoringId] = useState<string | null>(null);
  const [deletingHostId, setDeletingHostId] = useState<string | null>(null);
  const [deletingMonId, setDeletingMonId] = useState<string | null>(null);
  const [powerBusyKey, setPowerBusyKey] = useState<string | null>(null);
  const [ipBusyKey, setIpBusyKey] = useState<string | null>(null);
  const [confirmPower, setConfirmPower] = useState<{ host: CloudHost; action: OciInstanceAction } | null>(null);
  const [powerMenu, setPowerMenu] = useState<{ host: CloudHost; top: number; right: number } | null>(null);

  useEffect(() => {
    if (!powerMenu) return;
    const close = () => setPowerMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [powerMenu]);

  // Unified Oracle OCI Regional Profile CRUD Modal State
  const [showOciProfileModal, setShowOciProfileModal] = useState(false);
  const [editingOciProfile, setEditingOciProfile] = useState<OciProfile | null>(null);
  const [ociProfForm, setOciProfForm] = useState({
    name: '',
    region: 'ap-tokyo-1',
    homeRegion: '',
    tenancyOcid: '',
    userOcid: '',
    compartmentOcid: '',
    fingerprint: '',
    subnetOcid: '',
    availabilityDomains: [] as string[],
    privateKeyPem: '',
    notes: '',
  });
  const [showOciConfigPaste, setShowOciConfigPaste] = useState(false);
  const [ociConfigSnippet, setOciConfigSnippet] = useState('');
  const [computingOciFp, setComputingOciFp] = useState(false);
  const [ociFpError, setOciFpError] = useState<string | null>(null);
  const [discoveringOci, setDiscoveringOci] = useState(false);
  const [discoverOciError, setDiscoverOciError] = useState<string | null>(null);
  const [discoveredOci, setDiscoveredOci] = useState<OciDiscoveredResources | null>(null);
  const [ociSaveError, setOciSaveError] = useState<string | null>(null);
  const ociPemFileInputRef = useRef<HTMLInputElement | null>(null);

  // Unified Cloud Import Modal State (supports OCI Profiles + AWS / Aliyun / GCP Accounts)
  const [showImportModal, setShowImportModal] = useState(false);
  // sourceKey format: "oci:<profileId>" | "cloud:<accountId>"
  const [selectedSourceKey, setSelectedSourceKey] = useState('');
  const [importGroupName, setImportGroupName] = useState('');
  const [discoveredItems, setDiscoveredItems] = useState<UnifiedImportItem[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [selectedInstanceIds, setSelectedInstanceIds] = useState<Set<string>>(new Set());
  const [autoMonitorOnImport, setAutoMonitorOnImport] = useState(true);
  const [importingBusy, setImportingBusy] = useState(false);

  // Cloud Account CRUD Modal State (AWS EC2 / Aliyun ECS / GCP Compute Engine)
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<CloudAccount | null>(null);
  const [accountSaving, setAccountSaving] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [testingAccountId, setTestingAccountId] = useState<string | null>(null);
  const [gcpParsedInfo, setGcpParsedInfo] = useState<{ projectId: string; clientEmail: string } | null>(null);
  const [accountForm, setAccountForm] = useState({
    provider: 'aws' as ExternalCloudProvider,
    name: '',
    region: 'ap-northeast-1',
    zone: '',
    accessKeyId: '',
    secretKey: '',
    serviceAccountJson: '',
    notes: '',
  });

  // Bind Domain Modal State
  const [bindModalHost, setBindModalHost] = useState<CloudHost | null>(null);
  const [bindMode, setBindMode] = useState<'create' | 'existing'>('create');
  const [bindExistingKey, setBindExistingKey] = useState(''); // 'rec:<id>' or 'rule:<id>'
  const [bindExistingSearch, setBindExistingSearch] = useState('');
  const [bindSyncNow, setBindSyncNow] = useState(true);
  const [bindCfZones, setBindCfZones] = useState<DnsZoneSummary[]>([]);
  const [bindLoadingZones, setBindLoadingZones] = useState(false);
  const [bindZonesError, setBindZonesError] = useState<string | null>(null);
  const [bindCreateForm, setBindCreateForm] = useState({
    providerId: '',
    domain: '',
    recordName: '@',
    ttl: 120,
    proxied: false,
    ipv6Mode: 'round_robin' as 'round_robin' | 'per_host',
  });
  const [bindBusy, setBindBusy] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);

  // Add IP Modal State
  const [addIpModalHost, setAddIpModalHost] = useState<CloudHost | null>(null);
  const [addIpVersion, setAddIpVersion] = useState<'ipv4' | 'ipv6'>('ipv6');
  const [addIpAddress, setAddIpAddress] = useState('');
  const [addIpPrefixInfo, setAddIpPrefixInfo] = useState<{
    loading: boolean;
    cidr?: string;
    prefix?: string;
    cidrs: string[];
  }>({ loading: false, cidrs: [] });
  const [addIpBusy, setAddIpBusy] = useState(false);
  const [addIpError, setAddIpError] = useState<string | null>(null);

  // Delete IP Confirm Modal State
  const [deleteIpTarget, setDeleteIpTarget] = useState<{
    host: CloudHost;
    version: 'ipv4' | 'ipv6';
    address: string;
    ociResourceId?: string;
  } | null>(null);

  // Edit Host Metadata Modal State
  const [editingHost, setEditingHost] = useState<CloudHost | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    name: '',
    groupName: '',
    sshUser: 'ubuntu',
    sshPort: 22,
    notes: '',
  });

  // Monitor Tab State
  const [checkingAllMon, setCheckingAllMon] = useState(false);
  const [checkingMonId, setCheckingMonId] = useState<string | null>(null);
  const [showMonitorModal, setShowMonitorModal] = useState(false);
  const [monitorForm, setMonitorForm] = useState({
    name: '',
    type: 'tcp' as MonitorProbeType,
    target: '',
    port: 22,
    expectedIp: '',
    ignoreTlsErrors: false,
    intervalSeconds: 60,
    linkedHostId: '',
    notifyOnAlert: true,
  });

  // Managed hosts: Oracle OCI, AWS EC2, Aliyun ECS, GCP Compute Engine
  const managedHosts = useMemo(
    () => hosts.filter((h) => MANAGED_PROVIDERS.includes(h.provider as ManagedCloudProvider)),
    [hosts]
  );

  const readyOciProfiles = useMemo(
    () => ociProfiles.filter((p) => p.hasPrivateKey),
    [ociProfiles]
  );

  const readyCloudAccounts = useMemo(
    () => cloudAccounts.filter((a) => a.hasCredentials),
    [cloudAccounts]
  );

  const totalReadySources = readyOciProfiles.length + readyCloudAccounts.length;

  const importSources = useMemo(() => {
    const list: Array<{
      key: string;
      kind: 'oci' | 'cloud';
      id: string;
      provider: ManagedCloudProvider;
      label: string;
      defaultGroup: string;
      region: string;
    }> = [];
    for (const p of readyOciProfiles) {
      list.push({
        key: `oci:${p.id}`,
        kind: 'oci',
        id: p.id,
        provider: 'oracle',
        label: `[OCI] ${p.name} (${p.region})`,
        defaultGroup: p.name,
        region: p.region,
      });
    }
    for (const a of readyCloudAccounts) {
      const tag = providerShortLabel(a.provider, isZh);
      list.push({
        key: `cloud:${a.id}`,
        kind: 'cloud',
        id: a.id,
        provider: a.provider,
        label: `[${tag}] ${a.name} (${a.projectId ? `${a.projectId} / ` : ''}${a.region})`,
        defaultGroup: a.name,
        region: a.region,
      });
    }
    return list;
  }, [readyOciProfiles, readyCloudAccounts, isZh]);

  const dnsProviderMap = useMemo(() => new Map(dnsProviders.map((p) => [p.id, p])), [dnsProviders]);
  const configuredDnsProviders = useMemo(
    () => dnsProviders.filter((p) => isDnsProviderConfigured(p)),
    [dnsProviders]
  );
  const configuredDnsRules = useMemo(
    () => dnsRules.filter((r) => isDnsProviderConfigured(dnsProviderMap.get(r.providerId))),
    [dnsRules, dnsProviderMap]
  );
  const ociProfileMap = useMemo(() => new Map(ociProfiles.map((p) => [p.id, p])), [ociProfiles]);
  const cloudAccountMap = useMemo(() => new Map(cloudAccounts.map((a) => [a.id, a])), [cloudAccounts]);
  const dnsRuleMap = useMemo(() => new Map(dnsRules.map((r) => [r.id, r])), [dnsRules]);

  const monitorByHostId = useMemo(() => {
    const m = new Map<string, MonitorTarget>();
    for (const target of monitors) {
      if (target.linkedHostId && !m.has(target.linkedHostId)) {
        m.set(target.linkedHostId, target);
      }
    }
    return m;
  }, [monitors]);

  const importedKeySet = useMemo(
    () => new Set(managedHosts.map((h) => `${h.provider}:${h.instanceId?.trim() || ''}`)),
    [managedHosts]
  );

  const providerCounts = useMemo(() => {
    const map: Record<ManagedCloudProvider, number> = { oracle: 0, aws: 0, aliyun: 0, gcp: 0 };
    for (const h of managedHosts) {
      if (h.provider in map) {
        map[h.provider as ManagedCloudProvider] += 1;
      }
    }
    return map;
  }, [managedHosts]);

  const groupSummaries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of managedHosts) {
      if (providerFilter !== 'all' && h.provider !== providerFilter) continue;
      const g = (h.groupName || '').trim() || (isZh ? '默认分组' : 'Default');
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
  }, [managedHosts, providerFilter, isZh]);

  const allRegions = useMemo(
    () => Array.from(new Set(managedHosts.map((h) => h.region).filter(Boolean))).sort(),
    [managedHosts]
  );

  const getHostBoundRuleIds = useCallback((host: CloudHost): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    if (Array.isArray(host.linkedDnsRuleIds)) {
      for (const id of host.linkedDnsRuleIds) {
        if (id && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
    }
    if (host.linkedDnsRuleId && !seen.has(host.linkedDnsRuleId)) {
      seen.add(host.linkedDnsRuleId);
      out.push(host.linkedDnsRuleId);
    }
    return out;
  }, []);

  const getHostBoundRules = useCallback(
    (host: CloudHost): DnsSyncRule[] =>
      getHostBoundRuleIds(host)
        .map((id) => dnsRuleMap.get(id))
        .filter((r): r is DnsSyncRule => Boolean(r)),
    [getHostBoundRuleIds, dnsRuleMap]
  );

  const filteredHosts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return managedHosts.filter((h) => {
      if (providerFilter !== 'all' && h.provider !== providerFilter) return false;
      const hostGroup = (h.groupName || '').trim() || (isZh ? '默认分组' : 'Default');
      if (groupFilter !== 'all' && hostGroup !== groupFilter) return false;
      if (regionFilter !== 'all' && h.region !== regionFilter) return false;
      if (!q) return true;
      const boundRules = getHostBoundRules(h);
      const fqdns = boundRules.map((r) => `${r.recordName}.${r.domain}`).join(' ');
      const provNames = boundRules.map((r) => dnsProviderMap.get(r.providerId)?.name || '').join(' ');
      return `${h.name} ${h.provider} ${hostGroup} ${h.region} ${h.cloudZone || ''} ${h.ipv4} ${h.ipv6List.join(' ')} ${h.specs} ${h.instanceId} ${fqdns} ${provNames}`
        .toLowerCase()
        .includes(q);
    });
  }, [managedHosts, providerFilter, groupFilter, regionFilter, searchQuery, getHostBoundRules, dnsProviderMap, isZh]);

  const showNotice = (text: string, kind: 'info' | 'error' | 'success' = 'success') => {
    toast.show(text, kind);
  };

  const canControlHost = (host: CloudHost): boolean => {
    if (host.provider === 'oracle') {
      if (!host.ociProfileId || !host.instanceId) return false;
      return Boolean(ociProfileMap.get(host.ociProfileId)?.hasPrivateKey);
    }
    if (host.provider === 'aws' || host.provider === 'aliyun' || host.provider === 'gcp') {
      if (!host.cloudAccountId || !host.instanceId) return false;
      return Boolean(cloudAccountMap.get(host.cloudAccountId)?.hasCredentials);
    }
    return false;
  };

  const formatRuleFqdn = (rule: DnsSyncRule) =>
    rule.recordName && rule.recordName !== '@' ? `${rule.recordName}.${rule.domain}` : rule.domain;

  // ---- One-Click Multi-Cloud Sync (OCI + AWS + Aliyun + GCP) ----
  const handleSyncAllClouds = async () => {
    if (totalReadySources === 0) {
      showNotice(
        isZh
          ? '尚未配置任何可用云凭据（OCI 私钥或 AWS / 阿里云 / GCP 账号），请先添加云账号凭据。'
          : 'No cloud credentials configured yet. Add an OCI profile or AWS/Aliyun/GCP account first.',
        'error'
      );
      setSubTab('accounts');
      return;
    }
    setSyncingAll(true);
    try {
      const res = await apiRequest<{
        ok: boolean;
        profilesScanned: number;
        importedCount: number;
        updatedCount: number;
        errors: string[];
      }>('/api/clouds/hosts/sync-all', {
        method: 'POST',
        body: JSON.stringify({ autoMonitor: true }),
      });
      await onReload();
      if (res.errors.length > 0) {
        showNotice(
          isZh
            ? `已扫描 ${res.profilesScanned} 个云账号/区域：新增 ${res.importedCount} 台，刷新 ${res.updatedCount} 台；部分异常：${res.errors.join('；')}`
            : `Scanned ${res.profilesScanned} source(s): +${res.importedCount}, refreshed ${res.updatedCount}. Errors: ${res.errors.join('; ')}`,
          'error'
        );
      } else {
        showNotice(
          isZh
            ? `全云同步完成（扫描 ${res.profilesScanned} 个云账号/区域）：新增 ${res.importedCount} 台实例，刷新 ${res.updatedCount} 台实例 IP 与状态`
            : `Synced ${res.profilesScanned} cloud source(s): imported ${res.importedCount}, refreshed ${res.updatedCount}`
        );
      }
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Sync all clouds failed', 'error');
    } finally {
      setSyncingAll(false);
    }
  };

  // ---- Unified Cloud Instance Discovery & Import (OCI + AWS + Aliyun + GCP) ----
  const fetchInstancesForSource = async (sourceKey: string) => {
    const source = importSources.find((s) => s.key === sourceKey);
    if (!source) return;
    setImportLoading(true);
    setImportError(null);
    setDiscoveredItems([]);
    setSelectedInstanceIds(new Set());
    try {
      let unified: UnifiedImportItem[] = [];
      if (source.kind === 'oci') {
        const res = await apiRequest<{ ok: boolean; instances: OciDiscoveredInstance[] }>(
          `/api/oci/profiles/${encodeURIComponent(source.id)}/instances`
        );
        unified = (res.instances ?? []).map((inst) => ({
          provider: 'oracle',
          instanceId: inst.instanceId,
          displayName: inst.displayName,
          region: inst.region,
          zone: inst.availabilityDomain,
          specs: inst.specs,
          architecture: inst.architecture,
          lifecycleState: inst.lifecycleState,
          publicIp: inst.publicIp,
          ipv6List: inst.ipv6List ?? [],
          alreadyImported: inst.alreadyImported || importedKeySet.has(`oracle:${inst.instanceId}`),
          raw: inst,
        }));
      } else {
        const res = await apiRequest<{ ok: boolean; instances: CloudDiscoveredInstance[] }>(
          `/api/clouds/accounts/${encodeURIComponent(source.id)}/instances`
        );
        unified = (res.instances ?? []).map((inst) => ({
          provider: inst.provider,
          instanceId: inst.instanceId,
          displayName: inst.displayName,
          region: inst.region,
          zone: inst.zone,
          specs: inst.specs,
          architecture: inst.architecture,
          lifecycleState: inst.lifecycleState,
          publicIp: inst.publicIp,
          ipv6List: inst.ipv6List ?? [],
          alreadyImported: inst.alreadyImported || importedKeySet.has(`${inst.provider}:${inst.instanceId}`),
          raw: inst,
        }));
      }
      setDiscoveredItems(unified);
      const selectable = unified.filter((i) => !i.alreadyImported).map((i) => i.instanceId);
      setSelectedInstanceIds(new Set(selectable));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to fetch cloud instances');
    } finally {
      setImportLoading(false);
    }
  };

  const openUnifiedImportModal = (preferredSourceKey?: string) => {
    setShowImportModal(true);
    setImportError(null);
    const chosen =
      (preferredSourceKey && importSources.find((s) => s.key === preferredSourceKey)) ||
      (selectedSourceKey && importSources.find((s) => s.key === selectedSourceKey)) ||
      importSources[0];
    const key = chosen?.key || '';
    setSelectedSourceKey(key);
    setImportGroupName(chosen?.defaultGroup || '');
    if (key) {
      void fetchInstancesForSource(key);
    } else {
      setDiscoveredItems([]);
    }
  };

  useEffect(() => {
    if (showImportModal && discoveredItems.length > 0) {
      setDiscoveredItems((prev) =>
        prev.map((item) => ({
          ...item,
          alreadyImported: item.alreadyImported || importedKeySet.has(`${item.provider}:${item.instanceId}`),
        }))
      );
    }
  }, [importedKeySet, showImportModal]);

  const unimportedItems = useMemo(
    () => discoveredItems.filter((i) => !i.alreadyImported && !importedKeySet.has(`${i.provider}:${i.instanceId}`)),
    [discoveredItems, importedKeySet]
  );

  const toggleSelectInstance = (id: string) => {
    setSelectedInstanceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const importInstancesBatch = async (targets: UnifiedImportItem[]) => {
    const source = importSources.find((s) => s.key === selectedSourceKey);
    const validTargets = targets.filter(
      (i) => !i.alreadyImported && !importedKeySet.has(`${i.provider}:${i.instanceId}`)
    );
    if (!source || validTargets.length === 0) return;

    setImportingBusy(true);
    setImportError(null);
    try {
      const endpoint = source.kind === 'oci' ? '/api/clouds/hosts/import-oci' : '/api/clouds/hosts/import-cloud';
      const bodyPayload =
        source.kind === 'oci'
          ? {
              profileId: source.id,
              groupName: importGroupName.trim() || undefined,
              instances: validTargets.map((i) => i.raw),
              autoMonitor: autoMonitorOnImport,
            }
          : {
              accountId: source.id,
              groupName: importGroupName.trim() || undefined,
              instances: validTargets.map((i) => i.raw),
              autoMonitor: autoMonitorOnImport,
            };

      const res = await apiRequest<{
        ok: boolean;
        added: CloudHost[];
        skippedCount: number;
        monitorsCreated: number;
      }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(bodyPayload),
      });
      await onReload();
      const addedSet = new Set(res.added.map((h) => h.instanceId));
      setDiscoveredItems((prev) =>
        prev.map((item) => (addedSet.has(item.instanceId) ? { ...item, alreadyImported: true } : item))
      );
      setSelectedInstanceIds((prev) => {
        const next = new Set(prev);
        for (const id of addedSet) next.delete(id);
        return next;
      });
      showNotice(
        isZh
          ? `已导入 ${res.added.length} 台 ${providerShortLabel(source.provider, true)} 实例到分组「${importGroupName.trim() || source.defaultGroup}」${res.monitorsCreated ? `（已开启 ${res.monitorsCreated} 项监控）` : ''}${res.skippedCount ? `，跳过 ${res.skippedCount} 台重复` : ''}`
          : `Imported ${res.added.length} ${source.provider.toUpperCase()} instance(s)`
      );
      setShowImportModal(false);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImportingBusy(false);
    }
  };

  // ---- Cloud Accounts CRUD (AWS EC2 / Aliyun ECS / GCP Compute Engine) ----
  const openCreateAccountModal = (provider: ExternalCloudProvider = 'aws') => {
    setEditingAccount(null);
    setAccountError(null);
    setGcpParsedInfo(null);
    setAccountForm({
      provider,
      name: '',
      region: provider === 'aws' ? 'ap-northeast-1' : provider === 'aliyun' ? 'cn-hongkong' : 'all',
      zone: '',
      accessKeyId: '',
      secretKey: '',
      serviceAccountJson: '',
      notes: '',
    });
    setShowAccountModal(true);
  };

  const openEditAccountModal = (acc: CloudAccount) => {
    setEditingAccount(acc);
    setAccountError(null);
    setGcpParsedInfo(
      acc.provider === 'gcp' && acc.projectId && acc.clientEmail
        ? { projectId: acc.projectId, clientEmail: acc.clientEmail }
        : null
    );
    setAccountForm({
      provider: acc.provider,
      name: acc.name,
      region: acc.region,
      zone: acc.zone || '',
      accessKeyId: '',
      secretKey: '',
      serviceAccountJson: '',
      notes: acc.notes || '',
    });
    setShowAccountModal(true);
  };

  const parseGcpJsonPreview = async (rawJson: string) => {
    if (!rawJson.trim()) {
      setGcpParsedInfo(null);
      return;
    }
    try {
      const res = await apiRequest<{ ok: boolean; projectId: string; clientEmail: string }>(
        '/api/clouds/accounts/parse-gcp-json',
        { method: 'POST', body: JSON.stringify({ serviceAccountJson: rawJson }) }
      );
      setGcpParsedInfo({ projectId: res.projectId, clientEmail: res.clientEmail });
      setAccountError(null);
      setAccountForm((prev) => ({
        ...prev,
        name: prev.name || `GCP ${res.projectId}`,
      }));
    } catch (err) {
      setGcpParsedInfo(null);
      setAccountError(err instanceof Error ? err.message : 'Invalid GCP Service Account JSON');
    }
  };

  const handleUploadGcpJsonFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      setAccountForm((prev) => ({ ...prev, serviceAccountJson: text }));
      void parseGcpJsonPreview(text);
    };
    reader.readAsText(file);
  };

  const handleSaveCloudAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setAccountSaving(true);
    setAccountError(null);
    try {
      const payload = {
        provider: accountForm.provider,
        name: accountForm.name.trim(),
        region: accountForm.region.trim().toLowerCase(),
        zone: accountForm.zone.trim().toLowerCase() || undefined,
        accessKeyId: accountForm.accessKeyId.trim() || undefined,
        secretKey: accountForm.secretKey.trim() || undefined,
        serviceAccountJson: accountForm.serviceAccountJson.trim() || undefined,
        notes: accountForm.notes.trim() || undefined,
      };
      if (editingAccount) {
        await apiRequest(`/api/clouds/accounts/${editingAccount.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await apiRequest('/api/clouds/accounts', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setShowAccountModal(false);
      await onReload();
      showNotice(
        isZh
          ? `已保存 ${providerFullLabel(accountForm.provider, true)} API 账号凭据`
          : `Saved ${providerFullLabel(accountForm.provider, false)} account`
      );
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : 'Save cloud account failed');
    } finally {
      setAccountSaving(false);
    }
  };

  const handleTestCloudAccount = async (acc: CloudAccount) => {
    setTestingAccountId(acc.id);
    try {
      const res = await apiRequest<{ ok: boolean; instanceCount: number }>(
        `/api/clouds/accounts/${acc.id}/test`,
        { method: 'POST' }
      );
      await onReload();
      showNotice(
        isZh
          ? `${acc.name} 连通性验证成功：发现 ${res.instanceCount} 台实例`
          : `${acc.name} verified: ${res.instanceCount} instance(s) found`
      );
    } catch (err) {
      await onReload();
      showNotice(err instanceof Error ? err.message : 'Connection test failed', 'error');
    } finally {
      setTestingAccountId(null);
    }
  };

  const handleDeleteCloudAccount = async (acc: CloudAccount) => {
    try {
      await apiRequest(`/api/clouds/accounts/${acc.id}`, { method: 'DELETE' });
      await onReload();
      showNotice(isZh ? `已删除云账号 ${acc.name}` : `Deleted cloud account ${acc.name}`, 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? '删除云账号失败' : 'Delete cloud account failed', 'error');
    }
  };

  // ---- Unified Oracle OCI Regional Profile CRUD ----
  const isOciIdentityLocked = false;

  const availableOciRegionList = useMemo(() => {
    if (discoveredOci?.regions?.length) {
      return discoveredOci.regions.map((r) => ({
        value: r.regionName,
        label: r.isHomeRegion ? `${r.regionName} (Home Region)` : r.regionName,
      }));
    }
    const set = new Set(DEFAULT_OCI_REGIONS);
    if (ociProfForm.region) set.add(ociProfForm.region);
    return Array.from(set).map((r) => ({ value: r, label: r }));
  }, [discoveredOci, ociProfForm.region]);

  const computeOciFingerprintFromPem = async (pem: string) => {
    const trimmed = pem.trim();
    if (!trimmed) {
      setOciFpError(null);
      if (!editingOciProfile?.hasPrivateKey) {
        setOciProfForm((prev) => ({ ...prev, fingerprint: '' }));
      }
      return;
    }
    if (!trimmed.includes('BEGIN') || !trimmed.includes('END')) {
      return;
    }
    setComputingOciFp(true);
    setOciFpError(null);
    try {
      const res = await apiRequest<{ fingerprint: string }>('/api/oci/compute-fingerprint', {
        method: 'POST',
        body: JSON.stringify({ privateKeyPem: trimmed }),
      });
      setOciProfForm((prev) => ({ ...prev, fingerprint: res.fingerprint }));
    } catch (err) {
      setOciFpError(err instanceof Error ? err.message : 'Invalid PEM private key');
      setOciProfForm((prev) => ({ ...prev, fingerprint: '' }));
    } finally {
      setComputingOciFp(false);
    }
  };

  const handleOciPemChange = (value: string) => {
    setOciProfForm((prev) => ({ ...prev, privateKeyPem: value }));
    void computeOciFingerprintFromPem(value);
  };

  const handleOciPemFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      handleOciPemChange(text);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleApplyOciConfigSnippet = () => {
    const parsed = parseOciConfigText(ociConfigSnippet);
    if (!parsed.tenancyOcid && !parsed.userOcid && !parsed.region) {
      toast.warning(isZh ? '未识别到有效的 tenancy / user / region 字段' : 'No valid tenancy / user / region found in snippet');
      return;
    }
    setOciProfForm((prev) => ({
      ...prev,
      tenancyOcid: parsed.tenancyOcid || prev.tenancyOcid,
      userOcid: parsed.userOcid || prev.userOcid,
      region: parsed.region || prev.region,
      compartmentOcid: prev.compartmentOcid || parsed.tenancyOcid || '',
      name: prev.name || (parsed.region ? `OCI ${parsed.region}` : prev.name),
    }));
    setShowOciConfigPaste(false);
    setOciConfigSnippet('');
    toast.success(isZh ? '已自动填充 OCI 配置文件字段' : 'Populated fields from OCI config snippet');
  };

  const handleAutoDiscoverOciProfile = async () => {
    setDiscoveringOci(true);
    setDiscoverOciError(null);
    try {
      const res = await apiRequest<OciDiscoveredResources>('/api/oci/profiles/discover', {
        method: 'POST',
        body: JSON.stringify({
          profileId: editingOciProfile?.id,
          region: ociProfForm.region,
          tenancyOcid: ociProfForm.tenancyOcid,
          userOcid: ociProfForm.userOcid,
          compartmentOcid: ociProfForm.compartmentOcid || ociProfForm.tenancyOcid,
          privateKeyPem: ociProfForm.privateKeyPem || undefined,
        }),
      });
      setDiscoveredOci(res);
      setOciProfForm((prev) => ({
        ...prev,
        fingerprint: res.fingerprint,
        homeRegion: res.homeRegion || prev.homeRegion,
        compartmentOcid: prev.compartmentOcid || res.compartments[0]?.id || prev.tenancyOcid,
        availabilityDomains: res.availabilityDomains,
        subnetOcid: prev.subnetOcid || res.subnets.find((s) => s.isPublic)?.id || res.subnets[0]?.id || '',
      }));
    } catch (err) {
      setDiscoverOciError(err instanceof Error ? err.message : 'OCI API discovery failed');
    } finally {
      setDiscoveringOci(false);
    }
  };

  const openNewOciProfile = () => {
    setEditingOciProfile(null);
    setDiscoveredOci(null);
    setDiscoverOciError(null);
    setOciFpError(null);
    setOciSaveError(null);
    setShowOciConfigPaste(false);
    setOciProfForm({
      name: '',
      region: 'ap-tokyo-1',
      homeRegion: '',
      tenancyOcid: '',
      userOcid: '',
      compartmentOcid: '',
      fingerprint: '',
      subnetOcid: '',
      availabilityDomains: [],
      privateKeyPem: '',
      notes: '',
    });
    setShowOciProfileModal(true);
  };

  const openEditOciProfile = (p: OciProfile) => {
    setEditingOciProfile(p);
    setDiscoveredOci(null);
    setDiscoverOciError(null);
    setOciFpError(null);
    setOciSaveError(null);
    setShowOciConfigPaste(false);
    setOciProfForm({
      name: p.name,
      region: p.region,
      homeRegion: p.homeRegion ?? '',
      tenancyOcid: p.tenancyOcid,
      userOcid: p.userOcid,
      compartmentOcid: p.compartmentOcid,
      fingerprint: p.fingerprint,
      subnetOcid: p.subnetOcid,
      availabilityDomains: p.availabilityDomains ?? [],
      privateKeyPem: '',
      notes: p.notes ?? '',
    });
    setShowOciProfileModal(true);
  };

  const handleSaveOciProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setOciSaveError(null);
    const payload = {
      name: ociProfForm.name.trim() || `OCI ${ociProfForm.region}`,
      region: ociProfForm.region,
      homeRegion: ociProfForm.homeRegion || undefined,
      tenancyOcid: ociProfForm.tenancyOcid.trim(),
      userOcid: ociProfForm.userOcid.trim(),
      compartmentOcid: ociProfForm.compartmentOcid.trim() || ociProfForm.tenancyOcid.trim(),
      subnetOcid: ociProfForm.subnetOcid.trim(),
      availabilityDomains: ociProfForm.availabilityDomains,
      privateKeyPem: ociProfForm.privateKeyPem.trim() || undefined,
      notes: ociProfForm.notes.trim(),
    };
    try {
      if (editingOciProfile) {
        await apiRequest(`/api/oci/profiles/${editingOciProfile.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await apiRequest('/api/oci/profiles', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setShowOciProfileModal(false);
      await onReload();
      showNotice(isZh ? '已保存 Oracle OCI 凭据配置' : 'Saved Oracle OCI credential');
    } catch (err) {
      setOciSaveError(err instanceof Error ? err.message : 'Save OCI profile failed');
    }
  };

  const handleDeleteOciProfile = async (p: OciProfile) => {
    try {
      await apiRequest(`/api/oci/profiles/${p.id}`, { method: 'DELETE' });
      await onReload();
      showNotice(isZh ? `已删除 OCI 凭据 ${p.name}` : `Deleted OCI profile ${p.name}`, 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? '删除 OCI 凭据失败' : 'Delete OCI profile failed', 'error');
    }
  };

  // ---- Bind Domain Modal ----
  const fetchZonesForBindProvider = useCallback(
    async (providerId: string, forceRefresh = false) => {
      const prov = dnsProviderMap.get(providerId);
      if (
        !prov ||
        !prov.hasSecret ||
        !['cloudflare', 'dnspod', 'aliyun', 'porkbun'].includes(prov.type)
      ) {
        setBindCfZones([]);
        setBindZonesError(null);
        return;
      }
      setBindLoadingZones(true);
      setBindZonesError(null);
      try {
        const res = await apiRequest<{
          ok: boolean;
          domains?: Array<{ id: string; name: string; status?: string }>;
          error?: string;
        }>(`/api/dns/providers/${encodeURIComponent(providerId)}/domains${forceRefresh ? '?refresh=1' : ''}`);
        const domains = res.ok && Array.isArray(res.domains) ? res.domains : [];
        const zones: DnsZoneSummary[] = domains.map((d) => ({
          id: d.id,
          name: d.name,
          status: d.status || 'active',
        }));
        setBindCfZones(zones);
        if (!res.ok && res.error) {
          setBindZonesError(res.error);
        }
        if (zones.length > 0) {
          setBindCreateForm((prev) =>
            prev.providerId === providerId && !prev.domain ? { ...prev, domain: zones[0].name } : prev
          );
        }
      } catch (err) {
        setBindCfZones([]);
        setBindZonesError(err instanceof Error ? err.message : 'Failed to load domains');
      } finally {
        setBindLoadingZones(false);
      }
    },
    [dnsProviderMap]
  );

  useEffect(() => {
    if (bindModalHost && bindMode === 'create' && bindCreateForm.providerId) {
      void fetchZonesForBindProvider(bindCreateForm.providerId);
    }
  }, [bindModalHost, bindMode, bindCreateForm.providerId, fetchZonesForBindProvider]);

  const openBindDomainModal = (host: CloudHost) => {
    setBindModalHost(host);
    setBindError(null);
    setBindCfZones([]);
    setBindZonesError(null);
    setBindExistingKey('');
    setBindExistingSearch('');
    setBindSyncNow(true);
    setBindMode(configuredDnsProviders.length > 0 ? 'create' : 'existing');
    setBindCreateForm({
      providerId: configuredDnsProviders[0]?.id || '',
      domain: '',
      recordName: host.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24) || '@',
      ttl: 120,
      proxied: false,
      ipv6Mode: 'round_robin',
    });
  };

  const handleSubmitBindDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bindModalHost) return;
    setBindBusy(true);
    setBindError(null);
    try {
      let updatedHost: CloudHost | undefined;
      if (bindMode === 'existing') {
        if (!bindExistingKey) {
          setBindError(isZh ? '请在列表中选择一个未绑定的域名' : 'Please select an unbound domain');
          setBindBusy(false);
          return;
        }
        const payload = bindExistingKey.startsWith('rec:')
          ? { recordId: bindExistingKey.slice(4), syncNow: bindSyncNow }
          : { ruleId: bindExistingKey.slice(5), syncNow: bindSyncNow };
        const res = await apiRequest<{ host: CloudHost }>(`/api/clouds/hosts/${bindModalHost.id}/bind-domain`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        updatedHost = res.host;
      } else {
        if (!bindCreateForm.providerId) {
          setBindError(isZh ? '请先选择一个已配置凭据的 DNS 服务商' : 'Please select a configured DNS provider');
          setBindBusy(false);
          return;
        }
        const res = await apiRequest<{ host: CloudHost }>(`/api/clouds/hosts/${bindModalHost.id}/bind-domain`, {
          method: 'POST',
          body: JSON.stringify({
            createRule: bindCreateForm,
            syncNow: bindSyncNow,
          }),
        });
        updatedHost = res.host;
      }
      await onReload();
      if (updatedHost) {
        setBindModalHost(updatedHost);
      }
      setBindExistingKey('');
      setBindCreateForm((prev) => ({ ...prev, recordName: '' }));
      showNotice(
        isZh
          ? `已为 ${bindModalHost.name} 新增绑定域名${bindSyncNow ? '并触发立即同步' : ''}`
          : `Added bound domain for ${bindModalHost.name}`
      );
    } catch (err) {
      setBindError(err instanceof Error ? err.message : 'Bind domain failed');
    } finally {
      setBindBusy(false);
    }
  };

  const handleUnbindDomain = async (host: CloudHost, specificRuleId?: string) => {
    setBindBusy(true);
    setBindError(null);
    try {
      const res = await apiRequest<{ host: CloudHost }>(`/api/clouds/hosts/${host.id}/bind-domain`, {
        method: 'POST',
        body: JSON.stringify(
          specificRuleId ? { unbind: true, ruleId: specificRuleId } : { unbind: true }
        ),
      });
      await onReload();
      if (bindModalHost?.id === host.id) {
        setBindModalHost(res.host);
      }
      showNotice(
        isZh
          ? specificRuleId
            ? `已解除 ${host.name} 上的该域名绑定`
            : `已解除 ${host.name} 的全部域名绑定`
          : `Unbound domain from ${host.name}`
      );
    } catch (err) {
      setBindError(err instanceof Error ? err.message : 'Unbind failed');
      showNotice(err instanceof Error ? err.message : 'Unbind failed', 'error');
    } finally {
      setBindBusy(false);
    }
  };

  // ---- Host IP Lifecycle (Add / Swap / Delete IPv4 & IPv6 via OCI / AWS / Aliyun / GCP API) ----
  const deriveLocalIpv6Prefix = (ipv6List: string[]): string => {
    const sample = (ipv6List[0] || '').trim().split('/')[0].toLowerCase();
    if (!sample || !sample.includes(':')) return '';
    const halves = sample.split('::');
    if (halves.length > 2) return '';
    const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
    const missing = 8 - (left.length + right.length);
    if (halves.length === 1 && left.length !== 8) return '';
    if (missing < 0) return '';
    const full = [...left, ...Array(missing).fill('0'), ...right];
    if (full.length !== 8) return '';
    const prefix4 = full.slice(0, 4).map((g) => g.replace(/^0+/, '') || '0');
    return `${prefix4.join(':')}::`;
  };

  const loadHostIpv6Prefix = async (host: CloudHost, shouldPrefill: boolean) => {
    const localPrefix = deriveLocalIpv6Prefix(host.ipv6List || []);
    setAddIpPrefixInfo({
      loading: true,
      cidr: localPrefix ? `${localPrefix}/64` : undefined,
      prefix: localPrefix || undefined,
      cidrs: localPrefix ? [`${localPrefix}/64`] : [],
    });
    if (shouldPrefill && localPrefix) {
      setAddIpAddress(localPrefix);
    }
    try {
      const res = await apiRequest<{
        ok: boolean;
        cidr?: string;
        cidrs?: string[];
        prefix?: string;
      }>(`/api/clouds/hosts/${host.id}/ipv6-prefix`);
      const nextPrefix = res.prefix || localPrefix || undefined;
      const nextCidr = res.cidr || (nextPrefix ? `${nextPrefix}/64` : undefined);
      setAddIpPrefixInfo({
        loading: false,
        cidr: nextCidr,
        prefix: nextPrefix,
        cidrs: res.cidrs && res.cidrs.length > 0 ? res.cidrs : nextCidr ? [nextCidr] : [],
      });
      if (shouldPrefill && nextPrefix) {
        setAddIpAddress((prev) => (!prev || prev === localPrefix ? nextPrefix : prev));
      }
    } catch {
      setAddIpPrefixInfo((prev) => ({ ...prev, loading: false }));
    }
  };

  const openAddIpModal = (host: CloudHost) => {
    const initialVer: 'ipv4' | 'ipv6' = !host.ipv4 ? 'ipv4' : 'ipv6';
    setAddIpModalHost(host);
    setAddIpError(null);
    setAddIpAddress('');
    setAddIpVersion(initialVer);
    if (host.provider !== 'gcp') {
      void loadHostIpv6Prefix(host, initialVer === 'ipv6');
    } else {
      setAddIpPrefixInfo({ loading: false, cidrs: [] });
    }
  };

  const handleSubmitAddIp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addIpModalHost) return;
    setAddIpBusy(true);
    setAddIpError(null);
    try {
      let cleanAddr = addIpAddress.trim();
      // If user left only the prefilled bare subnet prefix (e.g. "2603:c020:4009:a100::"), let the cloud auto-assign
      if (addIpVersion === 'ipv6' && cleanAddr) {
        const barePrefix = addIpPrefixInfo.prefix?.toLowerCase();
        if (
          (barePrefix && (cleanAddr.toLowerCase() === barePrefix || `${cleanAddr.toLowerCase()}:` === barePrefix)) ||
          cleanAddr.endsWith('::')
        ) {
          cleanAddr = '';
        }
      }
      const res = await apiRequest<{ ok: boolean; version: string; address: string }>(
        `/api/clouds/hosts/${addIpModalHost.id}/ips/add`,
        {
          method: 'POST',
          body: JSON.stringify({
            version: addIpVersion,
            address: addIpVersion === 'ipv6' ? cleanAddr || undefined : undefined,
          }),
        }
      );
      setAddIpModalHost(null);
      await onReload();
      showNotice(
        isZh
          ? `已为 ${addIpModalHost.name} 新增 ${res.version.toUpperCase()}：${res.address}（已同步绑定域名）`
          : `Added ${res.version.toUpperCase()} ${res.address} to ${addIpModalHost.name}`
      );
    } catch (err) {
      setAddIpError(err instanceof Error ? err.message : 'Failed to add IP');
    } finally {
      setAddIpBusy(false);
    }
  };

  const handleSwapIp = async (
    host: CloudHost,
    version: 'ipv4' | 'ipv6',
    address: string,
    ociResourceId?: string
  ) => {
    const key = `${host.id}:swap:${address}`;
    setIpBusyKey(key);
    try {
      const res = await apiRequest<{ ok: boolean; oldAddress?: string; newAddress?: string }>(
        `/api/clouds/hosts/${host.id}/ips/swap`,
        {
          method: 'POST',
          body: JSON.stringify({ version, address, ociResourceId }),
        }
      );
      await onReload();
      const pTag = providerShortLabel(host.provider, isZh);
      showNotice(
        isZh
          ? `${pTag} 更换 ${version.toUpperCase()} 成功：${res.oldAddress || address} → ${res.newAddress}（已同步绑定域名）`
          : `Swapped ${pTag} ${version.toUpperCase()}: ${res.oldAddress || address} -> ${res.newAddress}`
      );
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Swap IP failed', 'error');
    } finally {
      setIpBusyKey(null);
    }
  };

  const handleConfirmDeleteIp = async () => {
    if (!deleteIpTarget) return;
    const { host, version, address, ociResourceId } = deleteIpTarget;
    const key = `${host.id}:del:${address}`;
    setIpBusyKey(key);
    setDeleteIpTarget(null);
    try {
      await apiRequest(`/api/clouds/hosts/${host.id}/ips/delete`, {
        method: 'POST',
        body: JSON.stringify({ version, address, ociResourceId }),
      });
      await onReload();
      const pTag = providerShortLabel(host.provider, isZh);
      showNotice(
        isZh
          ? `已通过 ${pTag} 删除 ${host.name} 的 ${version.toUpperCase()}：${address}`
          : `Deleted ${version.toUpperCase()} ${address} from ${host.name}`
      );
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Delete IP failed', 'error');
    } finally {
      setIpBusyKey(null);
    }
  };

  // ---- Edit Host Metadata ----
  const openEdit = (h: CloudHost) => {
    setEditingHost(h);
    setEditError(null);
    setEditForm({
      name: h.name,
      groupName: h.groupName || (isZh ? '默认分组' : 'Default'),
      sshUser: h.sshUser || 'ubuntu',
      sshPort: h.sshPort || 22,
      notes: h.notes || '',
    });
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingHost) return;
    setEditError(null);
    try {
      await apiRequest(`/api/clouds/hosts/${editingHost.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          groupName: editForm.groupName.trim() || (isZh ? '默认分组' : 'Default'),
          sshUser: editForm.sshUser.trim() || 'ubuntu',
          sshPort: Number(editForm.sshPort) || 22,
          notes: editForm.notes.trim(),
        }),
      });
      setEditingHost(null);
      await onReload();
      showNotice(t('savedSuccessfully'));
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Save failed');
    }
  };

  // ---- Monitoring & Live Status Refresh ----
  const handleRefreshHost = async (host: CloudHost) => {
    setRefreshingId(host.id);
    try {
      const res = await apiRequest<{
        ok: boolean;
        host: CloudHost;
        ociRefreshed: boolean;
        ociError?: string;
        probe?: { status: string; latencyMs: number; message: string } | null;
      }>(`/api/clouds/hosts/${host.id}/refresh-status`, { method: 'POST' });
      await onReload();
      if (res.ociError) {
        showNotice(
          isZh
            ? `${host.name}：云端状态获取异常（${res.ociError}）`
            : `${host.name}: Cloud refresh failed (${res.ociError})`,
          'error'
        );
      } else {
        const latency = res.probe ? ` · ${res.probe.latencyMs}ms` : '';
        const stateText = res.host.ociLifecycleState || res.host.status.toUpperCase();
        showNotice(`${host.name}: ${stateText}${latency}`);
      }
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Status check failed', 'error');
    } finally {
      setRefreshingId(null);
    }
  };

  const handleEnableMonitor = async (host: CloudHost) => {
    setMonitoringId(host.id);
    try {
      const res = await apiRequest<{ ok: boolean; monitor: MonitorTarget }>(
        `/api/clouds/hosts/${host.id}/monitor`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      await onReload();
      showNotice(
        isZh
          ? `已开启并探测 ${host.name}（${res.monitor.status.toUpperCase()}${res.monitor.lastLatencyMs !== undefined ? ` · ${res.monitor.lastLatencyMs}ms` : ''}）`
          : `Monitoring active for ${host.name} (${res.monitor.status.toUpperCase()})`
      );
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Failed to enable monitor', 'error');
    } finally {
      setMonitoringId(null);
    }
  };

  const executePowerAction = async (host: CloudHost, action: OciInstanceAction) => {
    const busyKey = `${host.id}:${action}`;
    setPowerBusyKey(busyKey);
    setConfirmPower(null);
    try {
      const res = await apiRequest<{
        ok: boolean;
        action: OciInstanceAction;
        lifecycleState?: string;
      }>(`/api/clouds/hosts/${host.id}/power`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      await onReload();
      const meta = getPowerActionMeta(action, isZh);
      const pTag = providerShortLabel(host.provider, isZh);
      showNotice(
        isZh
          ? `已向 ${pTag} 下发 ${meta.label} 指令：${host.name}（当前状态：${res.lifecycleState || '处理中'}）`
          : `Sent ${pTag} ${meta.label} to ${host.name} (${res.lifecycleState || 'PENDING'})`
      );
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Power action failed', 'error');
    } finally {
      setPowerBusyKey(null);
    }
  };

  // Manual Single-Host (All Bound Domains or One Specific Bound Domain) DNS Sync (ALWAYS preserved)
  const handlePushDns = async (host: CloudHost, specificRuleId?: string) => {
    const boundRules = getHostBoundRules(host);
    if (boundRules.length === 0) {
      openBindDomainModal(host);
      return;
    }
    const busyKey = specificRuleId ? `${host.id}:${specificRuleId}` : host.id;
    setPushingId(busyKey);
    try {
      const res = await apiRequest<{
        host: CloudHost;
        report?: { status: string; message?: string; fqdn?: string };
        syncedCount?: number;
        totalCount?: number;
      }>(`/api/clouds/hosts/${host.id}/push-dns`, {
        method: 'POST',
        body: JSON.stringify(specificRuleId ? { ruleId: specificRuleId } : {}),
      });
      await onReload();
      if (specificRuleId) {
        const targetRule = dnsRuleMap.get(specificRuleId);
        const fqdn = targetRule ? formatRuleFqdn(targetRule) : '';
        showNotice(
          isZh
            ? `已手动同步 ${host.name} 的 IPv4 与 ${host.ipv6List.length} 个 IPv6 到 ${fqdn || '绑定域名'}（${res.report?.status?.toUpperCase() || 'OK'}）`
            : `Synced ${host.name} to ${fqdn || 'DNS'}`
        );
      } else {
        const total = res.totalCount ?? boundRules.length;
        const ok = res.syncedCount ?? total;
        showNotice(
          isZh
            ? `已同步 ${host.name} 的 IP 到 ${ok}/${total} 个绑定域名`
            : `Synced ${host.name} to ${ok}/${total} bound domain(s)`
        );
      }
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Push DNS failed', 'error');
    } finally {
      setPushingId(null);
    }
  };

  const handleDeleteHost = async (host: CloudHost) => {
    setDeletingHostId(host.id);
    try {
      await apiRequest(`/api/clouds/hosts/${host.id}`, { method: 'DELETE' });
      await onReload();
      showNotice(isZh ? `已删除云主机实例 ${host.name}` : `Deleted host ${host.name}`, 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? '删除实例失败' : 'Delete host failed', 'error');
    } finally {
      setDeletingHostId(null);
    }
  };

  // ---- Monitor Tab Actions ----
  const handleCheckAllMonitors = async () => {
    setCheckingAllMon(true);
    try {
      await apiRequest('/api/monitors/check-all', { method: 'POST' });
      await onReload();
      showNotice(isZh ? '已完成全部监控探针检测' : 'Completed all monitor probes', 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? '批量探测失败' : 'Probe all failed', 'error');
    } finally {
      setCheckingAllMon(false);
    }
  };

  const handleCheckOneMonitor = async (m: MonitorTarget) => {
    setCheckingMonId(m.id);
    try {
      const res = await apiRequest<{ monitor?: MonitorTarget }>(`/api/monitors/${m.id}/check`, {
        method: 'POST',
      });
      await onReload();
      const updated = res.monitor;
      if (updated) {
        const latency = updated.lastLatencyMs !== undefined ? ` · ${updated.lastLatencyMs}ms` : '';
        const detail = updated.lastMessage ? ` — ${updated.lastMessage}` : '';
        showNotice(
          `${updated.name}: ${updated.status.toUpperCase()}${latency}${detail}`,
          updated.status === 'down' ? 'error' : 'success'
        );
      } else {
        showNotice(isZh ? `已完成 ${m.name} 探测` : `Probed ${m.name}`, 'success');
      }
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? '探测失败' : 'Probe failed', 'error');
    } finally {
      setCheckingMonId(null);
    }
  };

  const handleCreateMonitor = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const isHttps =
        monitorForm.type === 'https' ||
        (monitorForm.type === 'http' && monitorForm.target.trim().toLowerCase().startsWith('https://'));
      await apiRequest('/api/monitors', {
        method: 'POST',
        body: JSON.stringify({
          ...monitorForm,
          port: monitorForm.type === 'tcp' ? Number(monitorForm.port) || 22 : undefined,
          expectedIp: monitorForm.type === 'dns' ? monitorForm.expectedIp.trim() || undefined : undefined,
          ignoreTlsErrors: isHttps ? Boolean(monitorForm.ignoreTlsErrors) : false,
          linkedHostId: monitorForm.linkedHostId || undefined,
        }),
      });
      setShowMonitorModal(false);
      await onReload();
      showNotice(t('savedSuccessfully'), 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Failed to create monitor', 'error');
    }
  };

  const handleDeleteMonitor = async (m: MonitorTarget) => {
    setDeletingMonId(m.id);
    try {
      await apiRequest(`/api/monitors/${m.id}`, { method: 'DELETE' });
      await onReload();
      showNotice(isZh ? `已删除监控探针 ${m.name}` : `Deleted monitor ${m.name}`, 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? '删除监控失败' : 'Delete monitor failed', 'error');
    } finally {
      setDeletingMonId(null);
    }
  };

  const renderStatusIndicator = (host: CloudHost, linkedMon?: MonitorTarget) => {
    const state = (host.ociLifecycleState || host.status || '').toUpperCase();
    const isUp = state === 'RUNNING' || state === 'ONLINE';
    const isWarn =
      state === 'DEGRADED' ||
      state === 'STARTING' ||
      state === 'PROVISIONING' ||
      state === 'PENDING' ||
      state === 'STAGING' ||
      state === 'REBOOTING' ||
      state === 'RESETTING' ||
      state === 'STOPPING';
    const dotClass = isUp ? 'bg-emerald-500' : isWarn ? 'bg-amber-500' : 'bg-red-500';
    const textClass = isUp
      ? 'text-emerald-700 dark:text-emerald-400'
      : isWarn
        ? 'text-amber-700 dark:text-amber-400'
        : 'text-red-700 dark:text-red-400';

    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
          <span className={textClass}>{state || 'UNKNOWN'}</span>
          {host.lastLatencyMs !== undefined && (
            <span className="text-slate-500 dark:text-slate-400 font-normal tabular-nums">
              · {host.lastLatencyMs}ms
            </span>
          )}
        </div>
        {linkedMon ? (
          <button
            type="button"
            onClick={() => (onNavigateMonitors ? onNavigateMonitors() : setSubTab('monitors'))}
            className="inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:underline font-mono tabular-nums"
          >
            <Activity className="w-3 h-3 shrink-0" />
            {isZh ? `已监控 · ${linkedMon.uptimePercent}%` : `Monitored · ${linkedMon.uptimePercent}%`}
          </button>
        ) : (
          <button
            type="button"
            disabled={monitoringId === host.id || (!host.ipv4 && host.ipv6List.length === 0)}
            onClick={() => void handleEnableMonitor(host)}
            className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-40"
          >
            {monitoringId === host.id ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Activity className="w-3 h-3" />
            )}
            {isZh ? '开启监控' : 'Enable Monitor'}
          </button>
        )}
      </div>
    );
  };

  const selectedBindProvider = dnsProviderMap.get(bindCreateForm.providerId);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t('cloudsTitle')}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t('cloudsSubtitle')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0 self-start lg:self-auto">
          {subTab === 'hosts' && (
            <>
              <button
                type="button"
                disabled={syncingAll || totalReadySources === 0}
                onClick={() => void handleSyncAllClouds()}
                title={
                  isZh
                    ? '自动扫描所有已配置的 OCI / AWS / 阿里云 / GCP 账号，新增缺失实例并刷新最新 IP 与状态'
                    : 'Discover new instances and refresh IPs across all configured OCI, AWS, Aliyun, and GCP accounts'
                }
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-45 transition-colors whitespace-nowrap"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncingAll ? 'animate-spin' : ''}`} />
                {isZh ? `同步全云实例 (${totalReadySources})` : `Sync All Clouds (${totalReadySources})`}
              </button>
              <button
                type="button"
                onClick={() => openUnifiedImportModal()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors whitespace-nowrap"
              >
                <CloudDownload className="w-3.5 h-3.5" />
                {isZh ? '从云端导入实例' : 'Import from Cloud'}
              </button>
            </>
          )}
          {subTab === 'accounts' && (
            <>
              <button
                type="button"
                onClick={openNewOciProfile}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                {isZh ? '添加 Oracle OCI 凭据' : 'Add Oracle OCI'}
              </button>
              <button
                type="button"
                onClick={() => openCreateAccountModal('aws')}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                {isZh ? '添加 AWS / 阿里云 / GCP 凭据' : 'Add AWS / Aliyun / GCP'}
              </button>
            </>
          )}
          {subTab === 'monitors' && (
            <>
              <button
                type="button"
                disabled={checkingAllMon}
                onClick={() => void handleCheckAllMonitors()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${checkingAllMon ? 'animate-spin' : ''}`} />
                {isZh ? '立即探测全部' : 'Probe All'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMonitorForm({
                    name: '',
                    type: 'tcp',
                    target: '',
                    port: 22,
                    expectedIp: '',
                    ignoreTlsErrors: false,
                    intervalSeconds: 60,
                    linkedHostId: '',
                    notifyOnAlert: true,
                  });
                  setShowMonitorModal(true);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                {isZh ? '新增监控探针' : 'Add Monitor'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Sub-tab Switcher (Multi-Cloud Hosts | Cloud API Accounts | Live Monitors) */}
      <div className="flex items-center gap-6 border-b border-slate-200 dark:border-slate-800 text-xs font-medium overflow-x-auto">
        <button
          type="button"
          onClick={() => setSubTab('hosts')}
          className={`pb-2.5 border-b-2 transition-colors whitespace-nowrap ${
            subTab === 'hosts'
              ? 'border-blue-600 text-blue-600 dark:text-blue-400 font-semibold'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          {isZh ? `多云实例与分组 (${managedHosts.length})` : `Cloud Instances (${managedHosts.length})`}
        </button>
        <button
          type="button"
          onClick={() => setSubTab('accounts')}
          className={`pb-2.5 border-b-2 transition-colors whitespace-nowrap ${
            subTab === 'accounts'
              ? 'border-blue-600 text-blue-600 dark:text-blue-400 font-semibold'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          {isZh
            ? `云账号凭据 · AWS / 阿里云 / GCP / OCI (${cloudAccounts.length + ociProfiles.length})`
            : `Cloud API Accounts (${cloudAccounts.length + ociProfiles.length})`}
        </button>
        <button
          type="button"
          onClick={() => (onNavigateMonitors ? onNavigateMonitors() : setSubTab('monitors'))}
          className={`pb-2.5 border-b-2 transition-colors whitespace-nowrap ${
            !onNavigateMonitors && subTab === 'monitors'
              ? 'border-blue-600 text-blue-600 dark:text-blue-400 font-semibold'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          {isZh ? `实时监控探针 (${monitors.length}) ↗` : `Live Monitors (${monitors.length}) ↗`}
        </button>
      </div>

      {/* ==================== TAB 1: MULTI-CLOUD INSTANCES ==================== */}
      {subTab === 'hosts' && (
        <>
          {/* Provider Filter + Group Filter + Region + Search */}
          <div className="space-y-3">
            {/* Cloud Provider Segmented Filter */}
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <button
                type="button"
                onClick={() => {
                  setProviderFilter('all');
                  setGroupFilter('all');
                }}
                className={`px-3 py-1.5 rounded-lg border transition-colors ${
                  providerFilter === 'all'
                    ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-semibold'
                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                {isZh ? '全部云商' : 'All Clouds'}
                <span className="ml-1 font-mono text-[11px] opacity-80">({managedHosts.length})</span>
              </button>
              {MANAGED_PROVIDERS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setProviderFilter(p);
                    setGroupFilter('all');
                  }}
                  className={`px-3 py-1.5 rounded-lg border transition-colors ${
                    providerFilter === p
                      ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-semibold'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  {providerFullLabel(p, isZh)}
                  <span className="ml-1 font-mono text-[11px] opacity-80">({providerCounts[p]})</span>
                </button>
              ))}
            </div>

            {/* Group Filter Strip */}
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <button
                type="button"
                onClick={() => setGroupFilter('all')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition-colors ${
                  groupFilter === 'all'
                    ? 'border-blue-600 bg-blue-600 text-white font-semibold'
                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                {isZh ? '全部分组' : 'All Groups'}
              </button>
              {groupSummaries.map((g) => (
                <button
                  key={g.name}
                  type="button"
                  onClick={() => setGroupFilter(g.name)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition-colors ${
                    groupFilter === g.name
                      ? 'border-blue-600 bg-blue-600 text-white font-semibold'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  <Folder className="w-3 h-3 shrink-0" />
                  <span>{g.name}</span>
                  <span className="font-mono text-[11px] opacity-80">({g.count})</span>
                </button>
              ))}
            </div>

            {/* Search + Region */}
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={
                  isZh
                    ? '搜索实例名、云商 (OCI/AWS/阿里云/GCP)、分组、区域、绑定域名、DNS 服务商或 IPv4/IPv6...'
                    : t('search')
                }
                className="flex-1 min-w-0 px-3.5 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
              />
              <select
                value={regionFilter}
                onChange={(e) => setRegionFilter(e.target.value)}
                className="px-3.5 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
              >
                <option value="all">{isZh ? '全部区域' : 'All Regions'}</option>
                {allRegions.map((reg) => (
                  <option key={reg} value={reg}>
                    {reg}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Host Inventory Table */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-5 font-medium whitespace-nowrap">
                      {isZh ? '云商 / 实例 / 分组 / 绑定域名' : 'Cloud / Instance / Group / Domain'}
                    </th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">
                      {isZh ? 'IP 列表（IPv4 / IPv6）' : 'IP Addresses (IPv4 / IPv6)'}
                    </th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">
                      {isZh ? '状态与监控' : 'Status & Monitor'}
                    </th>
                    <th className="py-3 px-5 font-medium text-right whitespace-nowrap">
                      {isZh ? 'DNS 同步与电源操控' : 'DNS Sync & Power'}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70 text-xs">
                  {filteredHosts.map((h) => {
                    const linkedMon = monitorByHostId.get(h.id);
                    const boundRules = getHostBoundRules(h);
                    const apiReady = canControlHost(h);
                    const hostGroup = (h.groupName || '').trim() || (isZh ? '默认分组' : 'Default');
                    const pLabel = providerShortLabel(h.provider, isZh);

                    return (
                      <tr key={h.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30 align-top">
                        {/* Column 1: Cloud + Instance + Group + Multiple Bound Domains */}
                        <td className="py-3.5 px-5 min-w-[280px]">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                              {pLabel}
                            </span>
                            <span className="font-semibold text-slate-900 dark:text-white">{h.name}</span>
                            <button
                              type="button"
                              onClick={() => openEdit(h)}
                              title={isZh ? '点击修改分组' : 'Change group'}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400"
                            >
                              <Folder className="w-2.5 h-2.5" />
                              {hostGroup}
                            </button>
                          </div>
                          <div className="mt-0.5 text-[11px] font-mono text-slate-500 dark:text-slate-400">
                            {h.region}
                            {h.cloudZone ? ` (${h.cloudZone})` : ''} · {h.architecture}
                          </div>
                          {h.specs && (
                            <div className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-300">{h.specs}</div>
                          )}

                          {/* Multi-Domain Bindings & DNS Providers */}
                          <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800/80 space-y-1.5">
                            {boundRules.length > 0 ? (
                              <>
                                <div className="space-y-1">
                                  {boundRules.map((rule) => {
                                    const prov = dnsProviderMap.get(rule.providerId);
                                    const provOk = isDnsProviderConfigured(prov);
                                    const singleBusy = pushingId === `${h.id}:${rule.id}`;
                                    return (
                                      <div
                                        key={rule.id}
                                        className="flex items-center justify-between gap-2 text-[11px] group"
                                      >
                                        <div className="min-w-0 flex items-center gap-1.5">
                                          <Globe className="w-3 h-3 text-blue-600 dark:text-blue-400 shrink-0" />
                                          <span
                                            className="font-mono font-medium text-blue-700 dark:text-blue-300 truncate"
                                            title={formatRuleFqdn(rule)}
                                          >
                                            {formatRuleFqdn(rule)}
                                          </span>
                                          {prov ? (
                                            provOk ? (
                                              <span className="text-[10px] text-slate-400 dark:text-slate-500 truncate">
                                                · {prov.name}
                                              </span>
                                            ) : (
                                              <button
                                                type="button"
                                                onClick={onNavigateDns}
                                                title={
                                                  isZh
                                                    ? `DNS 服务商「${prov.name}」未配置密钥，点此前往配置`
                                                    : `Configure ${prov.name} API key`
                                                }
                                                className="text-amber-600 dark:text-amber-400 hover:underline inline-flex items-center gap-0.5 text-[10px] shrink-0"
                                              >
                                                <AlertTriangle className="w-2.5 h-2.5" />
                                                {isZh ? '未配密钥' : 'No key'}
                                              </button>
                                            )
                                          ) : (
                                            <span className="text-[10px] text-red-500 shrink-0">
                                              {isZh ? '服务商缺失' : 'Missing'}
                                            </span>
                                          )}
                                        </div>
                                        <div className="flex items-center gap-0.5 shrink-0">
                                          <button
                                            type="button"
                                            disabled={singleBusy || pushingId === h.id}
                                            onClick={() => void handlePushDns(h, rule.id)}
                                            title={isZh ? `单独同步 ${formatRuleFqdn(rule)}` : `Sync ${formatRuleFqdn(rule)}`}
                                            className="p-1 rounded text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-40"
                                          >
                                            {singleBusy ? (
                                              <Loader2 className="w-3 h-3 animate-spin" />
                                            ) : (
                                              <Send className="w-3 h-3" />
                                            )}
                                          </button>
                                          <button
                                            type="button"
                                            disabled={bindBusy}
                                            onClick={() => void handleUnbindDomain(h, rule.id)}
                                            title={isZh ? `解绑 ${formatRuleFqdn(rule)}` : `Unbind ${formatRuleFqdn(rule)}`}
                                            className="p-1 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-40"
                                          >
                                            <X className="w-3 h-3" />
                                          </button>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => openBindDomainModal(h)}
                                  className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400"
                                >
                                  <Plus className="w-3 h-3" />
                                  {isZh
                                    ? `添加 / 管理绑定域名 (${boundRules.length})`
                                    : `Add / Manage Domains (${boundRules.length})`}
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => openBindDomainModal(h)}
                                className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400"
                              >
                                <Link2 className="w-3 h-3" />
                                {isZh ? '绑定域名与 DNS 服务商' : 'Bind Domain & DNS Provider'}
                              </button>
                            )}
                          </div>
                        </td>

                        {/* Column 2: IPv4 / IPv6 List with Swap, Delete & Add Icons */}
                        <td className="py-3.5 px-4 min-w-[270px]">
                          <div className="space-y-1.5 font-mono text-[11px]">
                            {h.ipv4 ? (
                              <div className="flex items-center justify-between gap-2 group">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span className="text-[10px] font-semibold text-slate-400 w-5 shrink-0">v4</span>
                                  <span className="text-slate-900 dark:text-slate-100 tabular-nums truncate">
                                    {h.ipv4}
                                  </span>
                                </div>
                                <div className="flex items-center gap-0.5 shrink-0">
                                  {apiReady && (
                                    <button
                                      type="button"
                                      disabled={ipBusyKey !== null}
                                      onClick={() => void handleSwapIp(h, 'ipv4', h.ipv4, h.ociPublicIpId)}
                                      title={isZh ? `通过 ${pLabel} API 更换公网 IPv4` : `Swap Public IPv4 via ${pLabel}`}
                                      className="p-1 rounded text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-40"
                                    >
                                      {ipBusyKey === `${h.id}:swap:${h.ipv4}` ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                      ) : (
                                        <ArrowLeftRight className="w-3 h-3" />
                                      )}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    disabled={ipBusyKey !== null || !apiReady}
                                    onClick={() =>
                                      setDeleteIpTarget({
                                        host: h,
                                        version: 'ipv4',
                                        address: h.ipv4,
                                        ociResourceId: h.ociPublicIpId,
                                      })
                                    }
                                    title={isZh ? `通过 ${pLabel} API 删除公网 IPv4` : 'Delete IPv4'}
                                    className="p-1 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-40"
                                  >
                                    {ipBusyKey === `${h.id}:del:${h.ipv4}` ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <Trash2 className="w-3 h-3" />
                                    )}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="text-slate-400">
                                <span className="text-[10px] mr-1.5">v4</span>
                                {isZh ? '无公网 IPv4' : 'No IPv4'}
                              </div>
                            )}

                            {h.ipv6List.map((v6) => {
                              const ociEntry = h.ociIpv6Entries?.find(
                                (e) => e.ipAddress.toLowerCase() === v6.toLowerCase()
                              );
                              return (
                                <div key={v6} className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <span className="text-[10px] font-semibold text-blue-500 w-5 shrink-0">v6</span>
                                    <span
                                      className="text-slate-700 dark:text-slate-300 tabular-nums truncate max-w-[210px]"
                                      title={v6}
                                    >
                                      {v6}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-0.5 shrink-0">
                                    {apiReady && (
                                      <button
                                        type="button"
                                        disabled={ipBusyKey !== null}
                                        onClick={() => void handleSwapIp(h, 'ipv6', v6, ociEntry?.id)}
                                        title={isZh ? `通过 ${pLabel} API 更换此 IPv6` : `Swap IPv6 via ${pLabel}`}
                                        className="p-1 rounded text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-40"
                                      >
                                        {ipBusyKey === `${h.id}:swap:${v6}` ? (
                                          <Loader2 className="w-3 h-3 animate-spin" />
                                        ) : (
                                          <ArrowLeftRight className="w-3 h-3" />
                                        )}
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      disabled={ipBusyKey !== null || !apiReady}
                                      onClick={() =>
                                        setDeleteIpTarget({
                                          host: h,
                                          version: 'ipv6',
                                          address: v6,
                                          ociResourceId: ociEntry?.id,
                                        })
                                      }
                                      title={isZh ? `通过 ${pLabel} API 删除此 IPv6` : 'Delete IPv6'}
                                      className="p-1 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-40"
                                    >
                                      {ipBusyKey === `${h.id}:del:${v6}` ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                      ) : (
                                        <Trash2 className="w-3 h-3" />
                                      )}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}

                            <div className="pt-1">
                              <button
                                type="button"
                                disabled={!apiReady}
                                onClick={() => openAddIpModal(h)}
                                className="inline-flex items-center gap-1 text-[11px] font-sans font-medium text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-40"
                              >
                                <Plus className="w-3 h-3" />
                                {isZh ? '新增 IP (IPv4 / IPv6)' : 'Add IP (IPv4 / IPv6)'}
                              </button>
                            </div>
                          </div>
                        </td>

                        {/* Column 3: Status + Monitoring */}
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          {renderStatusIndicator(h, linkedMon)}
                          <div className="mt-1 text-[10px] font-mono text-slate-400 tabular-nums min-h-[14px]">
                            {h.lastCheckedAt ? formatTimeAgo(h.lastCheckedAt) : '—'}
                          </div>
                        </td>

                        {/* Column 4: Per-Host Manual DNS Sync + Probe + Power + Edit/Delete */}
                        <td className="py-3.5 px-5 text-right whitespace-nowrap">
                          <div className="inline-flex flex-wrap justify-end items-center gap-1.5">
                            {/* Dedicated Per-Host DNS Sync Button — NEVER REMOVE */}
                            <button
                              type="button"
                              disabled={pushingId === h.id}
                              onClick={() => void handlePushDns(h)}
                              title={
                                boundRules.length > 0
                                  ? isZh
                                    ? `手动立即将该实例 IPv4/IPv6 同步到全部 ${boundRules.length} 个绑定域名`
                                    : `Sync this host's IPs to all ${boundRules.length} bound domain(s)`
                                  : isZh
                                    ? '先绑定域名与 DNS 服务商，即可一键同步 DNS'
                                    : 'Bind a domain first to sync DNS'
                              }
                              className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold rounded-md border disabled:opacity-50 whitespace-nowrap shrink-0 ${
                                boundRules.length > 0
                                  ? 'border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50'
                                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                              }`}
                            >
                              {pushingId === h.id ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Send className="w-3 h-3" />
                              )}
                              {isZh
                                ? boundRules.length > 1
                                  ? `同步 DNS (${boundRules.length})`
                                  : '同步 DNS'
                                : boundRules.length > 1
                                  ? `Sync DNS (${boundRules.length})`
                                  : 'Sync DNS'}
                            </button>

                            <button
                              type="button"
                              disabled={refreshingId === h.id}
                              onClick={() => void handleRefreshHost(h)}
                              title={isZh ? '刷新云端最新 IP/状态并执行 TCP 探测' : 'Refresh cloud state & probe'}
                              className="inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                            >
                              <RefreshCw className={`w-3 h-3 ${refreshingId === h.id ? 'animate-spin' : ''}`} />
                              {isZh ? '检测' : 'Check'}
                            </button>

                            {/* Always-Visible 5-Action Remote Power Control Menu (Start / Reboot / Force Reboot / Shutdown / Force Shutdown) */}
                            <button
                              type="button"
                              disabled={powerBusyKey?.startsWith(`${h.id}:`) ?? false}
                              onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                const menuHeight = 250;
                                const openUp = window.innerHeight - rect.bottom < menuHeight;
                                setPowerMenu((prev) =>
                                  prev?.host.id === h.id
                                    ? null
                                    : {
                                        host: h,
                                        top: openUp ? Math.max(12, rect.top - menuHeight) : rect.bottom + 6,
                                        right: Math.max(12, window.innerWidth - rect.right),
                                      }
                                );
                              }}
                              title={
                                isZh
                                  ? '远程电源操控：开机 / 正常重启 / 强制重启 / 远程关机 / 强制关机'
                                  : 'Power controls: Start / Reboot / Force Reboot / Shutdown / Force Off'
                              }
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                            >
                              {powerBusyKey?.startsWith(`${h.id}:`) ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Power className="w-3 h-3 text-amber-600 dark:text-amber-400" />
                              )}
                              {isZh ? '电源' : 'Power'}
                              <ChevronDown className="w-3 h-3 opacity-70" />
                            </button>

                            <button
                              type="button"
                              onClick={() => openEdit(h)}
                              aria-label={t('edit')}
                              title={isZh ? '编辑名称、分组与 SSH 配置' : 'Edit name, group & SSH'}
                              className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={deletingHostId === h.id}
                              onClick={() => void handleDeleteHost(h)}
                              aria-label={t('delete')}
                              title={t('delete')}
                              className="p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                            >
                              {deletingHostId === h.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredHosts.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-12 text-center text-slate-400">
                        <div className="space-y-2.5">
                          <div>
                            {managedHosts.length === 0
                              ? isZh
                                ? '暂无多云实例，请先配置云账号凭据并从云端导入实例（支持 OCI / AWS / 阿里云 / GCP）。'
                                : 'No cloud hosts imported yet.'
                              : t('noData')}
                          </div>
                          {managedHosts.length === 0 && (
                            <div className="flex justify-center gap-2">
                              <button
                                type="button"
                                onClick={() => setSubTab('accounts')}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                              >
                                <KeyRound className="w-3.5 h-3.5" />
                                {isZh ? '配置 AWS / 阿里云 / GCP 凭据' : 'Configure Cloud Accounts'}
                              </button>
                              <button
                                type="button"
                                onClick={() => openUnifiedImportModal()}
                                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                              >
                                <CloudDownload className="w-3.5 h-3.5" />
                                {isZh ? '从云端导入实例' : 'Import from Cloud'}
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ==================== TAB 2: CLOUD API ACCOUNTS (AWS / ALIYUN / GCP + OCI OVERVIEW) ==================== */}
      {subTab === 'accounts' && (
        <div className="space-y-6">
          {/* AWS / Aliyun / GCP API Accounts Table */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  {isZh ? 'AWS EC2 / 阿里云 ECS / Google Cloud (GCP) API 凭据' : 'AWS EC2 / Aliyun ECS / GCP Compute Accounts'}
                </h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {isZh
                    ? '凭据在服务端加密存储，支持实时拉取实例清单、IPv4/IPv6 增换删、重启/强制重启及定时同步策略。'
                    : 'Credentials are encrypted on the server for live instance discovery, IPv4/IPv6 rotation, reboot control, and scheduled DNS policies.'}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                {(['aws', 'aliyun', 'gcp'] as ExternalCloudProvider[]).map((prov) => (
                  <button
                    key={prov}
                    type="button"
                    onClick={() => openCreateAccountModal(prov)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <Plus className="w-3 h-3" />
                    {providerFullLabel(prov, isZh)}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-5 font-medium">{isZh ? '云服务商与名称' : 'Cloud & Account Name'}</th>
                    <th className="py-3 px-4 font-medium">{isZh ? '区域 / 项目' : 'Region / Project'}</th>
                    <th className="py-3 px-4 font-medium">{isZh ? 'API 凭据摘要' : 'Credentials'}</th>
                    <th className="py-3 px-4 font-medium">{isZh ? '状态与实例数' : 'Status & Instances'}</th>
                    <th className="py-3 px-5 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70 text-xs">
                  {cloudAccounts.map((acc) => {
                    const statusColor =
                      acc.status === 'active'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : acc.status === 'error'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-amber-600 dark:text-amber-400';
                    return (
                      <tr key={acc.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="py-3.5 px-5">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                              {providerShortLabel(acc.provider, isZh)}
                            </span>
                            <span className="font-semibold text-slate-900 dark:text-white">{acc.name}</span>
                          </div>
                          {acc.notes && <div className="mt-0.5 text-[11px] text-slate-500">{acc.notes}</div>}
                        </td>
                        <td className="py-3.5 px-4 font-mono text-[11px] text-slate-700 dark:text-slate-300">
                          <div>
                            {acc.region}
                            {acc.zone ? ` / ${acc.zone}` : ''}
                          </div>
                          {acc.projectId && (
                            <div className="text-[10px] text-slate-500">project: {acc.projectId}</div>
                          )}
                        </td>
                        <td className="py-3.5 px-4 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                          {acc.provider === 'gcp'
                            ? acc.clientEmail || 'Service Account JSON'
                            : acc.accessKeyIdPreview || '••••'}
                        </td>
                        <td className="py-3.5 px-4 font-mono text-[11px] tabular-nums">
                          <div className={`font-semibold ${statusColor}`}>
                            {acc.status.toUpperCase()} · {acc.instanceCount} {isZh ? '台' : 'VM'}
                          </div>
                          <div className="text-[10px] text-slate-400 min-h-[14px]">
                            {acc.lastCheckedAt ? formatTimeAgo(acc.lastCheckedAt) : '—'}
                          </div>
                        </td>
                        <td className="py-3.5 px-5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={testingAccountId === acc.id}
                              onClick={() => void handleTestCloudAccount(acc)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                            >
                              {testingAccountId === acc.id ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Play className="w-3 h-3" />
                              )}
                              {isZh ? '验证' : 'Test'}
                            </button>
                            <button
                              type="button"
                              onClick={() => openUnifiedImportModal(`cloud:${acc.id}`)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50"
                            >
                              <CloudDownload className="w-3 h-3" />
                              {isZh ? '拉取实例' : 'Import'}
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditAccountModal(acc)}
                              className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteCloudAccount(acc)}
                              className="p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {cloudAccounts.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-10 text-center text-slate-400">
                        {isZh
                          ? '尚未添加 AWS EC2、阿里云 ECS 或 GCP 服务账号凭据；点击上方对应云商按钮即可添加。'
                          : 'No AWS, Aliyun, or GCP accounts configured yet.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Unified Oracle OCI Regional Credentials Table */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  {isZh
                    ? `Oracle OCI 多区域凭据 (${ociProfiles.length})`
                    : `Oracle OCI Regional Credentials (${ociProfiles.length})`}
                </h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {isZh
                    ? '统一归口维护 OCI 私钥（自动计算指纹与探测区域/子网/AD），同时服务于多云实例操控与免 main.tf ARM 抢注。'
                    : 'Unified OCI API credentials with auto-computed MD5 fingerprints and live resource discovery — powers both instance control and zero-main.tf ARM sniper.'}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={onNavigateOci}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                >
                  {isZh ? '前往 ARM 抢注' : 'ARM Sniper'}
                  <ArrowRight className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={openNewOciProfile}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap"
                >
                  <Plus className="w-3 h-3" />
                  {isZh ? '添加 OCI 凭据' : 'Add OCI Profile'}
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-5 font-medium whitespace-nowrap">
                      {isZh ? '凭据名称与区域' : 'Profile & Region'}
                    </th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">
                      {isZh ? '指纹（自动计算）' : 'Fingerprint (Auto)'}
                    </th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">
                      {isZh ? '可用域 ADs / 子网' : 'ADs / Subnet'}
                    </th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">API Key (PEM)</th>
                    <th className="py-3 px-5 font-medium text-right whitespace-nowrap">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70 text-xs">
                  {ociProfiles.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 align-top">
                      <td className="py-3.5 px-5">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                            OCI
                          </span>
                          <span className="font-semibold text-slate-900 dark:text-white">{p.name}</span>
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-blue-600 dark:text-blue-400">
                          {p.region}
                          {p.homeRegion && p.homeRegion === p.region ? ' (Home)' : ''}
                          {' · '}
                          <span className="text-slate-500">{p.instanceCount} VM</span>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 font-mono text-[11px] text-slate-600 dark:text-slate-300 max-w-[200px] break-all">
                        {p.fingerprint || '—'}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-[11px] text-slate-700 dark:text-slate-300 max-w-[240px]">
                        <div className="truncate" title={p.availabilityDomains.join(', ')}>
                          AD: {p.availabilityDomains.length > 0 ? p.availabilityDomains.join(', ') : '—'}
                        </div>
                        <div className="text-[10px] text-slate-400 truncate mt-0.5" title={p.subnetOcid}>
                          Subnet: {p.subnetOcid || (isZh ? '待自动获取' : 'Auto-discover')}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {p.hasPrivateKey ? (
                          <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                            {t('pemUploaded')}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openEditOciProfile(p)}
                            className="text-amber-600 dark:text-amber-400 hover:underline font-medium"
                          >
                            {isZh ? '上传 PEM 私钥' : 'Upload PEM key'}
                          </button>
                        )}
                      </td>
                      <td className="py-3.5 px-5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          {p.hasPrivateKey && (
                            <button
                              type="button"
                              onClick={() => openUnifiedImportModal(`oci:${p.id}`)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50"
                            >
                              <CloudDownload className="w-3 h-3" />
                              {isZh ? '拉取实例' : 'Import'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => openEditOciProfile(p)}
                            title={t('edit')}
                            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteOciProfile(p)}
                            title={t('delete')}
                            className="p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {ociProfiles.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-10 text-center text-slate-400">
                        {isZh
                          ? '尚未添加 Oracle OCI 凭据，点击右上角「添加 OCI 凭据」即可配置。'
                          : 'No Oracle OCI credentials configured yet.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ==================== TAB 3: INTEGRATED MONITORS ==================== */}
      {subTab === 'monitors' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-5 font-medium">{isZh ? '监控名称 / 探针目标' : 'Monitor / Target'}</th>
                  <th className="py-3 px-4 font-medium">{isZh ? '协议类型' : 'Type'}</th>
                  <th className="py-3 px-4 font-medium">{isZh ? '状态与延迟' : 'Status & Latency'}</th>
                  <th className="py-3 px-4 font-medium">{isZh ? '在线率' : 'Uptime'}</th>
                  <th className="py-3 px-5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70 text-xs">
                {monitors.map((m) => {
                  const isUp = m.status === 'up';
                  const isDown = m.status === 'down';
                  return (
                    <tr key={m.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="py-3 px-5">
                        <div className="font-semibold text-slate-900 dark:text-white">{m.name}</div>
                        <div className="font-mono text-[11px] text-slate-500">
                          {m.target}
                          {m.port ? `:${m.port}` : ''}
                        </div>
                        <div
                          className="text-[11px] text-slate-400 mt-0.5 truncate max-w-md min-h-[16px]"
                          title={m.lastMessage || undefined}
                        >
                          {m.lastMessage || '—'}
                        </div>
                      </td>
                      <td className="py-3 px-4 font-mono uppercase text-slate-600 dark:text-slate-300">{m.type}</td>
                      <td className="py-3 px-4 font-mono tabular-nums">
                        <span
                          className={`inline-flex items-center gap-1.5 font-semibold ${
                            isUp
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : isDown
                                ? 'text-red-600 dark:text-red-400'
                                : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              isUp ? 'bg-emerald-500' : isDown ? 'bg-red-500' : 'bg-amber-500'
                            }`}
                          />
                          {m.status.toUpperCase()}
                        </span>
                        {m.lastLatencyMs !== undefined && (
                          <span className="ml-2 text-slate-500">{m.lastLatencyMs}ms</span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-700 dark:text-slate-300">
                        {m.uptimePercent}%
                      </td>
                      <td className="py-3 px-5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={checkingMonId === m.id}
                            onClick={() => void handleCheckOneMonitor(m)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-md border border-slate-200 dark:border-slate-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-50"
                          >
                            {checkingMonId === m.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Play className="w-3 h-3" />
                            )}
                            {isZh ? '探测' : 'Probe'}
                          </button>
                          <button
                            type="button"
                            disabled={deletingMonId === m.id}
                            onClick={() => void handleDeleteMonitor(m)}
                            title={t('delete')}
                            className="p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                          >
                            {deletingMonId === m.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {monitors.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-slate-400">
                      {isZh
                        ? '暂无监控探针，可在「多云实例」中点击“开启监控”或右上角新增探针'
                        : 'No monitor targets configured yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ==================== MODAL 1: ADD / EDIT CLOUD ACCOUNT (AWS / ALIYUN / GCP) ==================== */}
      {showAccountModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-display text-lg font-semibold">
                {editingAccount
                  ? isZh
                    ? `编辑 ${providerFullLabel(editingAccount.provider, true)} 凭据`
                    : `Edit ${providerFullLabel(editingAccount.provider, false)} Account`
                  : isZh
                    ? '添加多云 API 凭据 (AWS / 阿里云 / GCP)'
                    : 'Add Cloud API Account'}
              </h3>
              <button type="button" onClick={() => setShowAccountModal(false)} className="p-1 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveCloudAccount} className="mt-4 space-y-4 text-xs">
              {accountError && (
                <div className="px-3 py-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300">
                  {accountError}
                </div>
              )}

              {/* Provider Selector */}
              <div>
                <label className="block font-medium mb-1.5">{isZh ? '云服务商' : 'Cloud Provider'}</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['aws', 'aliyun', 'gcp'] as ExternalCloudProvider[]).map((prov) => (
                    <button
                      key={prov}
                      type="button"
                      disabled={Boolean(editingAccount)}
                      onClick={() => {
                        setAccountError(null);
                        setGcpParsedInfo(null);
                        setAccountForm((prev) => ({
                          ...prev,
                          provider: prov,
                          region: prov === 'aws' ? 'ap-northeast-1' : prov === 'aliyun' ? 'cn-hongkong' : 'all',
                          zone: '',
                        }));
                      }}
                      className={`py-2 px-2.5 rounded-lg border font-medium transition-colors disabled:opacity-60 ${
                        accountForm.provider === prov
                          ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                          : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {providerFullLabel(prov, isZh)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block font-medium mb-1">{isZh ? '账号名称 / 默认分组 *' : 'Account Name *'}</label>
                  <input
                    required
                    value={accountForm.name}
                    onChange={(e) => setAccountForm({ ...accountForm, name: e.target.value })}
                    placeholder={
                      accountForm.provider === 'aws'
                        ? 'AWS Tokyo Production'
                        : accountForm.provider === 'aliyun'
                          ? '阿里云香港主账号'
                          : 'GCP Asia Project'
                    }
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">
                    {accountForm.provider === 'gcp'
                      ? isZh ? '区域过滤（all 表示全区扫描）' : 'Region Filter (or "all")'
                      : isZh ? '目标区域 (Region) *' : 'Region *'}
                  </label>
                  <input
                    required
                    list="cloud-region-presets"
                    value={accountForm.region}
                    onChange={(e) => setAccountForm({ ...accountForm, region: e.target.value })}
                    placeholder={
                      accountForm.provider === 'aws'
                        ? 'ap-northeast-1'
                        : accountForm.provider === 'aliyun'
                          ? 'cn-hongkong'
                          : 'all'
                    }
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                  />
                  <datalist id="cloud-region-presets">
                    {(accountForm.provider === 'aws'
                      ? AWS_REGION_PRESETS
                      : accountForm.provider === 'aliyun'
                        ? ALIYUN_REGION_PRESETS
                        : GCP_REGION_PRESETS
                    ).map((reg) => (
                      <option key={reg} value={reg} />
                    ))}
                  </datalist>
                </div>
              </div>

              {accountForm.provider === 'gcp' ? (
                <>
                  <div>
                    <label className="block font-medium mb-1">
                      {isZh ? '可选指定 Zone（留空则自动扫描全部可用区）' : 'Optional Zone (blank = all zones)'}
                    </label>
                    <input
                      value={accountForm.zone}
                      onChange={(e) => setAccountForm({ ...accountForm, zone: e.target.value })}
                      placeholder="asia-east1-b"
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="font-medium">
                        {isZh
                          ? `Service Account JSON 密钥${editingAccount ? '（留空保持不变）' : ' *'}`
                          : `Service Account JSON${editingAccount ? ' (leave blank to keep)' : ' *'}`}
                      </label>
                      <label className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 cursor-pointer hover:underline">
                        <Upload className="w-3 h-3" />
                        {isZh ? '上传 .json 文件' : 'Upload .json'}
                        <input type="file" accept=".json,application/json" onChange={handleUploadGcpJsonFile} className="hidden" />
                      </label>
                    </div>
                    <textarea
                      rows={5}
                      required={!editingAccount}
                      value={accountForm.serviceAccountJson}
                      onChange={(e) => setAccountForm({ ...accountForm, serviceAccountJson: e.target.value })}
                      onBlur={(e) => void parseGcpJsonPreview(e.target.value)}
                      placeholder='{"type": "service_account", "project_id": "...", "private_key": "-----BEGIN PRIVATE KEY-----...", "client_email": "..."}'
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono text-[11px]"
                    />
                  </div>

                  {/* Auto-extracted read-only GCP identity fields */}
                  {gcpParsedInfo && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20">
                      <div>
                        <label className="block text-[10px] font-medium text-emerald-700 dark:text-emerald-400 mb-0.5">
                          {isZh ? '自动解析 Project ID（只读）' : 'Auto-parsed Project ID'}
                        </label>
                        <input
                          readOnly
                          value={gcpParsedInfo.projectId}
                          className="w-full px-2.5 py-1.5 rounded border border-emerald-200/80 dark:border-emerald-800 bg-white/80 dark:bg-slate-900 font-mono text-[11px] text-slate-700 dark:text-slate-200"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-medium text-emerald-700 dark:text-emerald-400 mb-0.5">
                          {isZh ? '自动解析 Service Account（只读）' : 'Auto-parsed Client Email'}
                        </label>
                        <input
                          readOnly
                          value={gcpParsedInfo.clientEmail}
                          className="w-full px-2.5 py-1.5 rounded border border-emerald-200/80 dark:border-emerald-800 bg-white/80 dark:bg-slate-900 font-mono text-[11px] text-slate-700 dark:text-slate-200"
                        />
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <label className="block font-medium mb-1">
                      {isZh
                        ? `AccessKey ID${editingAccount ? '（留空保持不变）' : ' *'}`
                        : `Access Key ID${editingAccount ? ' (optional)' : ' *'}`}
                    </label>
                    <input
                      required={!editingAccount}
                      value={accountForm.accessKeyId}
                      onChange={(e) => setAccountForm({ ...accountForm, accessKeyId: e.target.value })}
                      placeholder={editingAccount?.accessKeyIdPreview || (accountForm.provider === 'aws' ? 'AKIA...' : 'LTAI...')}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">
                      {isZh
                        ? `AccessKey Secret${editingAccount ? '（留空保持不变）' : ' *'}`
                        : `Secret Access Key${editingAccount ? ' (optional)' : ' *'}`}
                    </label>
                    <input
                      type="password"
                      required={!editingAccount}
                      value={accountForm.secretKey}
                      onChange={(e) => setAccountForm({ ...accountForm, secretKey: e.target.value })}
                      placeholder={editingAccount ? '••••••••' : ''}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block font-medium mb-1">{isZh ? '备注（可选）' : 'Notes (optional)'}</label>
                <input
                  value={accountForm.notes}
                  onChange={(e) => setAccountForm({ ...accountForm, notes: e.target.value })}
                  placeholder={isZh ? '例如：仅赋予 EC2/ECS/Compute 最小权限的 RAM/IAM 密钥' : 'Minimal IAM/RAM compute permissions'}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAccountModal(false)}
                  className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  {t('cancel')}
                </button>
                <button
                  type="submit"
                  disabled={accountSaving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
                >
                  {accountSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {t('save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================== MODAL 2: UNIFIED CLOUD INSTANCE IMPORT (OCI + AWS + ALIYUN + GCP) ==================== */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
          <div className="w-full max-w-3xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
              <div>
                <h3 className="font-display text-lg font-semibold">
                  {isZh ? '从云端自动获取实例清单（OCI / AWS / 阿里云 / GCP）' : 'Import Instances from Cloud'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {isZh
                    ? '选择已配置的云账号或区域凭据，自动拉取公网 IPv4 / IPv6 并支持勾选或一键添加全部，已导入实例自动去重。'
                    : 'Fetch live instances with IPv4/IPv6 from any configured OCI profile or AWS/Aliyun/GCP account with automatic deduplication.'}
                </p>
              </div>
              <button type="button" onClick={() => setShowImportModal(false)} className="p-1 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            {importSources.length === 0 ? (
              <div className="py-12 text-center space-y-3 text-xs">
                <p className="text-slate-600 dark:text-slate-300">
                  {isZh
                    ? '暂无已配置 API 凭据的云账号（OCI 私钥或 AWS / 阿里云 / GCP）。请先添加云账号凭据后再导入实例。'
                    : 'No cloud credentials configured yet.'}
                </p>
                <div className="flex justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowImportModal(false);
                      setSubTab('accounts');
                      openCreateAccountModal('aws');
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {isZh ? '添加 AWS / 阿里云 / GCP 凭据' : 'Add AWS / Aliyun / GCP'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowImportModal(false);
                      setSubTab('accounts');
                      openNewOciProfile();
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {isZh ? '添加 Oracle OCI 凭据' : 'Add Oracle OCI'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="mt-4 grid grid-cols-1 sm:grid-cols-12 gap-3 items-end shrink-0 text-xs">
                  <div className="sm:col-span-6">
                    <label className="block font-medium mb-1">{isZh ? '选择云账号 / 区域凭据' : 'Cloud Account / Region'}</label>
                    <select
                      value={selectedSourceKey}
                      onChange={(e) => {
                        const nextKey = e.target.value;
                        setSelectedSourceKey(nextKey);
                        const s = importSources.find((x) => x.key === nextKey);
                        setImportGroupName(s?.defaultGroup || '');
                        void fetchInstancesForSource(nextKey);
                      }}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                    >
                      {importSources.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-4">
                    <label className="block font-medium mb-1">{isZh ? '导入至分组' : 'Target Group'}</label>
                    <input
                      value={importGroupName}
                      onChange={(e) => setImportGroupName(e.target.value)}
                      placeholder={isZh ? '例如：东京生产 / AWS 亚太' : 'e.g. APAC Edge'}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <button
                      type="button"
                      disabled={importLoading}
                      onClick={() => void fetchInstancesForSource(selectedSourceKey)}
                      className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${importLoading ? 'animate-spin' : ''}`} />
                      {isZh ? '刷新' : 'Refresh'}
                    </button>
                  </div>
                </div>

                <label className="mt-3 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 shrink-0">
                  <input
                    type="checkbox"
                    checked={autoMonitorOnImport}
                    onChange={(e) => setAutoMonitorOnImport(e.target.checked)}
                    className="rounded text-blue-600"
                  />
                  {isZh ? '导入时自动开启 TCP :22 在线监控' : 'Automatically enable TCP :22 monitoring on import'}
                </label>

                {importError && (
                  <div className="mt-3 px-3.5 py-2.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50/70 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300 shrink-0">
                    {importError}
                  </div>
                )}

                <div className="mt-4 flex-1 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                  {importLoading ? (
                    <div className="py-12 flex items-center justify-center gap-2 text-slate-500">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {isZh ? '正在实时拉取云端实例与公网 IP 清单...' : 'Fetching live cloud instances...'}
                    </div>
                  ) : discoveredItems.length === 0 ? (
                    <div className="py-10 text-center text-slate-400">
                      {isZh ? '该账号/区域下未发现运行中或已停止的实例' : 'No instances found in this account/region'}
                    </div>
                  ) : (
                    discoveredItems.map((inst) => {
                      const imported = inst.alreadyImported || importedKeySet.has(`${inst.provider}:${inst.instanceId}`);
                      const checked = selectedInstanceIds.has(inst.instanceId);
                      return (
                        <label
                          key={inst.instanceId}
                          className={`flex items-start justify-between gap-3 px-4 py-3 ${
                            imported ? 'bg-slate-50/80 dark:bg-slate-900/50 opacity-65' : 'hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer'
                          }`}
                        >
                          <div className="flex items-start gap-3 min-w-0">
                            <input
                              type="checkbox"
                              disabled={imported}
                              checked={!imported && checked}
                              onChange={() => toggleSelectInstance(inst.instanceId)}
                              className="mt-0.5 rounded text-blue-600"
                            />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-slate-900 dark:text-white">{inst.displayName}</span>
                                <span className="font-mono text-[10px] text-slate-500">{inst.lifecycleState}</span>
                                {imported && (
                                  <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                    <Check className="w-3 h-3" />
                                    {isZh ? '已添加' : 'Imported'}
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 font-mono text-[11px] text-slate-500 truncate">
                                {inst.specs} · {inst.region}
                                {inst.zone ? ` (${inst.zone})` : ''} · {inst.instanceId}
                              </div>
                              <div className="mt-1 font-mono text-[11px] text-slate-700 dark:text-slate-300">
                                v4: {inst.publicIp || '—'} · v6: {inst.ipv6List.length > 0 ? inst.ipv6List.join(', ') : '—'}
                              </div>
                            </div>
                          </div>
                        </label>
                      );
                    })
                  )}
                </div>

                <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 shrink-0 text-xs">
                  <span className="text-slate-500 font-mono tabular-nums">
                    {isZh
                      ? `共 ${discoveredItems.length} 台 · 可导入 ${unimportedItems.length} 台 · 已选 ${selectedInstanceIds.size} 台`
                      : `Total ${discoveredItems.length} · Available ${unimportedItems.length} · Selected ${selectedInstanceIds.size}`}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={importingBusy || unimportedItems.length === 0}
                      onClick={() => void importInstancesBatch(unimportedItems)}
                      className="px-3.5 py-2 rounded-lg border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 font-semibold hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-45"
                    >
                      {isZh ? `一键添加全部 (${unimportedItems.length})` : `Import All (${unimportedItems.length})`}
                    </button>
                    <button
                      type="button"
                      disabled={importingBusy || selectedInstanceIds.size === 0}
                      onClick={() =>
                        void importInstancesBatch(unimportedItems.filter((i) => selectedInstanceIds.has(i.instanceId)))
                      }
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-45"
                    >
                      {importingBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      {isZh ? `导入所选 (${selectedInstanceIds.size})` : `Import Selected (${selectedInstanceIds.size})`}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ==================== MODAL 3: MULTI-DOMAIN BINDING MANAGER ==================== */}
      {bindModalHost && (() => {
        const currentModalHost = managedHosts.find((x) => x.id === bindModalHost.id) ?? bindModalHost;
        const modalBoundRules = getHostBoundRules(currentModalHost);

        // Enforce 1-to-1 domain uniqueness: map every bound FQDN across ALL hosts to its owner host
        const boundFqdnOwnerMap = new Map<string, CloudHost>();
        for (const h of managedHosts) {
          for (const r of getHostBoundRules(h)) {
            boundFqdnOwnerMap.set(formatRuleFqdn(r).toLowerCase(), h);
          }
        }

        // Build unified "Existing Domains" list from pulled DNS Management records + configured DNS rules
        interface ExistingBindCandidate {
          key: string;
          fqdn: string;
          providerName: string;
          providerType: string;
          recordType?: string;
          content?: string;
          source: 'record' | 'rule';
          boundHost?: CloudHost;
        }
        const candidateByFqdn = new Map<string, ExistingBindCandidate>();
        // 1. Prefer pulled A / AAAA records from DNS Management (or CNAME/etc. if no A/AAAA)
        const sortedRecs = [...dnsRecords].sort((a, b) => {
          const rank = (t: string) => (t === 'A' ? 0 : t === 'AAAA' ? 1 : t === 'CNAME' ? 2 : 3);
          return rank(a.type) - rank(b.type);
        });
        for (const rec of sortedRecs) {
          const prov = dnsProviderMap.get(rec.providerId);
          if (!prov || !isDnsProviderConfigured(prov)) continue;
          const fqdn = (rec.fqdn || (rec.name === '@' ? rec.domain : `${rec.name}.${rec.domain}`)).toLowerCase();
          if (!fqdn || candidateByFqdn.has(fqdn)) continue;
          candidateByFqdn.set(fqdn, {
            key: `rec:${rec.id}`,
            fqdn,
            providerName: prov.name,
            providerType: prov.type,
            recordType: rec.type,
            content: rec.content,
            source: 'record',
            boundHost: boundFqdnOwnerMap.get(fqdn),
          });
        }
        // 2. Also include any configured DNS rules whose FQDN isn't already represented
        for (const rule of configuredDnsRules) {
          const prov = dnsProviderMap.get(rule.providerId);
          const fqdn = formatRuleFqdn(rule).toLowerCase();
          if (!fqdn || candidateByFqdn.has(fqdn)) continue;
          candidateByFqdn.set(fqdn, {
            key: `rule:${rule.id}`,
            fqdn,
            providerName: prov?.name || rule.providerId,
            providerType: prov?.type || 'dns',
            source: 'rule',
            boundHost: boundFqdnOwnerMap.get(fqdn),
          });
        }

        const allExistingCandidates = Array.from(candidateByFqdn.values()).sort((a, b) => {
          // Show unbound (available) domains first, then bound domains clearly separated below
          const aBound = a.boundHost ? 1 : 0;
          const bBound = b.boundHost ? 1 : 0;
          if (aBound !== bBound) return aBound - bBound;
          return a.fqdn.localeCompare(b.fqdn);
        });
        const availableExistingCount = allExistingCandidates.filter((c) => !c.boundHost).length;
        const filteredExistingCandidates = allExistingCandidates.filter((c) => {
          const q = bindExistingSearch.trim().toLowerCase();
          if (!q) return true;
          return `${c.fqdn} ${c.providerName} ${c.providerType} ${c.content || ''} ${c.boundHost?.name || ''}`
            .toLowerCase()
            .includes(q);
        });

        // Live conflict check for "Create New" tab
        const createTargetFqdn = bindCreateForm.domain.trim()
          ? (() => {
              const rn = (bindCreateForm.recordName.trim() || '@').toLowerCase();
              const dom = bindCreateForm.domain.trim().toLowerCase().replace(/\.$/, '');
              return rn === '@' ? dom : `${rn}.${dom}`;
            })()
          : '';
        const createConflictHost = createTargetFqdn ? boundFqdnOwnerMap.get(createTargetFqdn) : undefined;

        return (
          <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
            <div className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
                <div>
                  <h3 className="font-display text-lg font-semibold">
                    {isZh
                      ? `多域名绑定管理 — ${currentModalHost.name}`
                      : `Manage Bound Domains — ${currentModalHost.name}`}
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-0.5 font-mono tabular-nums">
                    v4: {currentModalHost.ipv4 || '—'} · v6: {currentModalHost.ipv6List.length} ·{' '}
                    {isZh ? `已绑定 ${modalBoundRules.length} 个域名（单域名仅可绑定一台实例）` : `${modalBoundRules.length} bound (1 domain = 1 host)`}
                  </p>
                </div>
                <button type="button" onClick={() => setBindModalHost(null)} className="p-1 text-slate-400">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Currently Bound Domains List */}
              <div className="mt-4 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-800 dark:text-slate-200">
                    {isZh ? `当前已绑定域名 (${modalBoundRules.length})` : `Currently Bound Domains (${modalBoundRules.length})`}
                  </span>
                  {modalBoundRules.length > 1 && (
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={pushingId === currentModalHost.id}
                        onClick={() => void handlePushDns(currentModalHost)}
                        className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                      >
                        {isZh ? '一键推送全部' : 'Push All'}
                      </button>
                      <button
                        type="button"
                        disabled={bindBusy}
                        onClick={() => void handleUnbindDomain(currentModalHost)}
                        className="text-red-600 dark:text-red-400 hover:underline font-medium"
                      >
                        {isZh ? '解绑全部' : 'Unbind All'}
                      </button>
                    </div>
                  )}
                </div>

                {modalBoundRules.length === 0 ? (
                  <div className="px-3 py-3 rounded-lg border border-dashed border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                    {isZh
                      ? '该实例尚未绑定任何域名，请在下方添加第一个或多个绑定域名。'
                      : 'No domains bound yet. Add one or more below.'}
                  </div>
                ) : (
                  <div className="divide-y divide-slate-200/80 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800">
                    {modalBoundRules.map((rule) => {
                      const prov = dnsProviderMap.get(rule.providerId);
                      const singleBusy = pushingId === `${currentModalHost.id}:${rule.id}`;
                      return (
                        <div key={rule.id} className="px-3 py-2.5 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <Globe className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                              <span className="font-mono font-semibold text-slate-900 dark:text-white truncate">
                                {formatRuleFqdn(rule)}
                              </span>
                            </div>
                            <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                              {prov ? `${prov.name} (${prov.type})` : rule.providerId} · TTL {rule.ttl}s
                              {rule.lastStatus ? ` · ${rule.lastStatus.toUpperCase()}` : ''}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              disabled={singleBusy}
                              onClick={() => void handlePushDns(currentModalHost, rule.id)}
                              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 whitespace-nowrap"
                            >
                              {singleBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                              {isZh ? '推送' : 'Push'}
                            </button>
                            <button
                              type="button"
                              disabled={bindBusy}
                              onClick={() => void handleUnbindDomain(currentModalHost, rule.id)}
                              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-slate-200 dark:border-slate-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 whitespace-nowrap"
                            >
                              {isZh ? '解绑' : 'Unbind'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Add Another Domain Form */}
              <div className="mt-5 pt-4 border-t border-slate-200 dark:border-slate-800">
                <h4 className="text-xs font-semibold text-slate-800 dark:text-slate-200 mb-3">
                  {isZh ? '新增绑定域名（可多次添加，实例 IP 变动自动同步全部域名）' : 'Add Bound Domain'}
                </h4>

                {configuredDnsProviders.length === 0 && allExistingCandidates.length === 0 ? (
                  <div className="py-6 text-center space-y-3 text-xs">
                    <p className="text-slate-600 dark:text-slate-300">
                      {isZh
                        ? '尚未配置任何带 API 密钥的 DNS 服务商（Cloudflare / DNSPod / 阿里云 DNS 等），绑定域名时必须指定已配置的 DNS 服务商。'
                        : 'No configured DNS providers available. Configure one first.'}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setBindModalHost(null);
                        onNavigateDns();
                      }}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700"
                    >
                      {isZh ? '前往「DNS 服务商」配置' : 'Configure DNS Providers'}
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleSubmitBindDomain} className="space-y-4 text-xs">
                    {bindError && (
                      <div className="px-3 py-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300">
                        {bindError}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setBindMode('create')}
                        className={`flex-1 py-2 rounded-lg border font-medium whitespace-nowrap ${
                          bindMode === 'create'
                            ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                            : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {isZh ? '新建绑定域名（选 DNS 服务商）' : 'Create New Domain Binding'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setBindMode('existing')}
                        className={`flex-1 py-2 rounded-lg border font-medium whitespace-nowrap ${
                          bindMode === 'existing'
                            ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                            : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {isZh
                          ? `从已拉取 DNS 选择 (${availableExistingCount} 可选)`
                          : `Attach Pulled DNS (${availableExistingCount} avail)`}
                      </button>
                    </div>

                    {bindMode === 'create' ? (
                      <div className="space-y-3.5">
                        <div>
                          <label className="block font-medium mb-1">{isZh ? 'DNS 服务商（必选）*' : 'DNS Provider *'}</label>
                          <div className="flex gap-2">
                            <select
                              required
                              value={bindCreateForm.providerId}
                              onChange={(e) => {
                                setBindCfZones([]);
                                setBindZonesError(null);
                                setBindCreateForm({ ...bindCreateForm, providerId: e.target.value, domain: '' });
                              }}
                              className="flex-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                            >
                              {configuredDnsProviders.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name} ({p.type})
                                </option>
                              ))}
                            </select>
                            {selectedBindProvider &&
                              ['cloudflare', 'dnspod', 'aliyun', 'porkbun'].includes(selectedBindProvider.type) && (
                                <button
                                  type="button"
                                  disabled={bindLoadingZones}
                                  onClick={() => void fetchZonesForBindProvider(selectedBindProvider.id, true)}
                                  title={isZh ? '刷新该服务商下的域名列表' : 'Refresh domains from provider'}
                                  className="px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                                >
                                  <RefreshCw className={`w-3.5 h-3.5 ${bindLoadingZones ? 'animate-spin' : ''}`} />
                                </button>
                              )}
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block font-medium mb-1">
                              {isZh ? '主域名 *' : 'Domain *'}
                              {bindLoadingZones && (
                                <span className="ml-1.5 text-[10px] text-blue-600">
                                  {isZh ? '正在拉取域名列表...' : 'Loading domains...'}
                                </span>
                              )}
                            </label>
                            {bindCfZones.length > 0 ? (
                              <select
                                required
                                value={bindCreateForm.domain}
                                onChange={(e) => setBindCreateForm({ ...bindCreateForm, domain: e.target.value })}
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                              >
                                {!bindCfZones.some((z) => z.name === bindCreateForm.domain) && bindCreateForm.domain && (
                                  <option value={bindCreateForm.domain}>{bindCreateForm.domain}</option>
                                )}
                                {bindCfZones.map((z) => (
                                  <option key={z.id} value={z.name}>
                                    {z.name}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                required
                                value={bindCreateForm.domain}
                                onChange={(e) => setBindCreateForm({ ...bindCreateForm, domain: e.target.value })}
                                placeholder="example.com"
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                              />
                            )}
                            {bindZonesError && (
                              <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                                {bindZonesError}
                              </div>
                            )}
                          </div>
                          <div>
                            <label className="block font-medium mb-1">{isZh ? '主机记录 (子域名)' : 'Record Name'}</label>
                            <input
                              required
                              value={bindCreateForm.recordName}
                              onChange={(e) => setBindCreateForm({ ...bindCreateForm, recordName: e.target.value })}
                              placeholder="@ / jp / node1"
                              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                            />
                          </div>
                        </div>

                        {createConflictHost && (
                          <div className="px-3 py-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/70 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300">
                            {createConflictHost.id === currentModalHost.id
                              ? isZh
                                ? `域名 ${createTargetFqdn} 已绑定在当前实例上。`
                                : `${createTargetFqdn} is already bound to this host.`
                              : isZh
                              ? `域名 ${createTargetFqdn} 已被实例「${createConflictHost.name}」占用（一个域名只能绑定一台云主机）。请换用其他子域名或先解绑原实例。`
                              : `${createTargetFqdn} is already bound to "${createConflictHost.name}" (one domain can only bind to one host).`}
                          </div>
                        )}

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block font-medium mb-1">TTL (s)</label>
                            <input
                              type="number"
                              min={60}
                              value={bindCreateForm.ttl}
                              onChange={(e) => setBindCreateForm({ ...bindCreateForm, ttl: Number(e.target.value) || 120 })}
                              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                            />
                          </div>
                          <div>
                            <label className="block font-medium mb-1">{isZh ? '多 IPv6 解析模式' : 'IPv6 Mode'}</label>
                            <select
                              value={bindCreateForm.ipv6Mode}
                              onChange={(e) =>
                                setBindCreateForm({
                                  ...bindCreateForm,
                                  ipv6Mode: e.target.value === 'per_host' ? 'per_host' : 'round_robin',
                                })
                              }
                              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                            >
                              <option value="round_robin">{isZh ? '同域名多 AAAA 轮询' : 'Round-Robin AAAA'}</option>
                              <option value="per_host">{isZh ? '独立子域名 (v6-1, v6-2)' : 'Per-Host Subdomains'}</option>
                            </select>
                          </div>
                        </div>

                        {selectedBindProvider?.type === 'cloudflare' && (
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={bindCreateForm.proxied}
                              onChange={(e) => setBindCreateForm({ ...bindCreateForm, proxied: e.target.checked })}
                              className="rounded text-blue-600"
                            />
                            {isZh ? '开启 Cloudflare CDN 小黄云代理 (Proxied)' : 'Enable Cloudflare Proxy'}
                          </label>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <label className="font-medium text-slate-700 dark:text-slate-300">
                            {isZh
                              ? '从「域名 DNS 管理」已拉取域名中选择（单域名仅可绑定一台主机）'
                              : 'Select from pulled DNS Management domains (1 domain = 1 host)'}
                          </label>
                          <span className="text-[11px] font-mono text-slate-400">
                            {availableExistingCount}/{allExistingCandidates.length}
                          </span>
                        </div>

                        {allExistingCandidates.length === 0 ? (
                          <div className="p-4 rounded-lg border border-dashed border-slate-200 dark:border-slate-800 text-center space-y-2 text-slate-500">
                            <p>
                              {isZh
                                ? '尚未在「域名 DNS 管理」中拉取任何域名记录。请先前往域名 DNS 管理拉取，或切换到「新建绑定域名」。'
                                : 'No pulled DNS records found yet. Pull domains under Domain DNS first, or create a new binding.'}
                            </p>
                            <button
                              type="button"
                              onClick={() => {
                                setBindModalHost(null);
                                onNavigateDns();
                              }}
                              className="text-blue-600 dark:text-blue-400 font-medium hover:underline"
                            >
                              {isZh ? '前往域名 DNS 管理拉取 →' : 'Go to Domain DNS →'}
                            </button>
                          </div>
                        ) : (
                          <>
                            <input
                              type="text"
                              value={bindExistingSearch}
                              onChange={(e) => setBindExistingSearch(e.target.value)}
                              placeholder={isZh ? '筛选域名、服务商、当前 IP...' : 'Filter domain, provider, IP...'}
                              className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                            />
                            <div className="max-h-56 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800">
                              {filteredExistingCandidates.map((item) => {
                                const isBound = Boolean(item.boundHost);
                                const isSelected = bindExistingKey === item.key;
                                return (
                                  <button
                                    key={item.key}
                                    type="button"
                                    disabled={isBound}
                                    onClick={() => setBindExistingKey(item.key)}
                                    className={`w-full text-left px-3 py-2.5 flex items-center justify-between gap-2 transition-colors ${
                                      isBound
                                        ? 'bg-slate-50/70 dark:bg-slate-950/40 opacity-55 cursor-not-allowed'
                                        : isSelected
                                        ? 'bg-blue-50 dark:bg-blue-950/40 ring-1 ring-inset ring-blue-500'
                                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                                    }`}
                                  >
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className="font-mono font-semibold text-slate-900 dark:text-white truncate">
                                          {item.fqdn}
                                        </span>
                                        {item.recordType && (
                                          <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-[10px] text-slate-600 dark:text-slate-300">
                                            {item.recordType}
                                          </span>
                                        )}
                                      </div>
                                      <div className="mt-0.5 text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                                        {item.providerName} ({item.providerType})
                                        {item.content ? ` · ${item.content}` : ''}
                                      </div>
                                    </div>
                                    <div className="shrink-0 text-[11px] font-medium">
                                      {item.boundHost ? (
                                        <span className="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                                          {item.boundHost.id === currentModalHost.id
                                            ? isZh
                                              ? '已绑本机'
                                              : 'Bound here'
                                            : isZh
                                            ? `已绑: ${item.boundHost.name}`
                                            : `Bound: ${item.boundHost.name}`}
                                        </span>
                                      ) : isSelected ? (
                                        <span className="text-blue-600 dark:text-blue-400 font-semibold">
                                          {isZh ? '已选中' : 'Selected'}
                                        </span>
                                      ) : (
                                        <span className="text-emerald-600 dark:text-emerald-400">
                                          {isZh ? '可绑定' : 'Available'}
                                        </span>
                                      )}
                                    </div>
                                  </button>
                                );
                              })}
                              {filteredExistingCandidates.length === 0 && (
                                <div className="p-4 text-center text-slate-400">
                                  {isZh ? '没有匹配的域名' : 'No matching domains'}
                                </div>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    <label className="flex items-center gap-2 pt-1">
                      <input
                        type="checkbox"
                        checked={bindSyncNow}
                        onChange={(e) => setBindSyncNow(e.target.checked)}
                        className="rounded text-blue-600"
                      />
                      {isZh
                        ? '添加绑定后立即将当前 IPv4 与全部 IPv6 推送同步到该域名'
                        : 'Immediately push IPv4 & IPv6 to this domain after binding'}
                    </label>

                    <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                      <button
                        type="button"
                        onClick={() => setBindModalHost(null)}
                        className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
                      >
                        {t('close')}
                      </button>
                      <button
                        type="submit"
                        disabled={
                          bindBusy ||
                          (bindMode === 'existing' && !bindExistingKey) ||
                          (bindMode === 'create' && Boolean(createConflictHost))
                        }
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
                      >
                        {bindBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        <Plus className="w-3.5 h-3.5" />
                        {isZh ? '添加到绑定列表' : 'Add Bound Domain'}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ==================== MODAL 4: ADD IP (IPv4 / IPv6 via Cloud API) ==================== */}
      {addIpModalHost && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-display text-base font-semibold">
                {isZh
                  ? `通过 ${providerShortLabel(addIpModalHost.provider, true)} API 新增 IP — ${addIpModalHost.name}`
                  : `Allocate IP — ${addIpModalHost.name}`}
              </h3>
              <button type="button" onClick={() => setAddIpModalHost(null)} className="p-1 text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmitAddIp} className="mt-4 space-y-4 text-xs">
              {addIpError && (
                <div className="px-3 py-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300">
                  {addIpError}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setAddIpVersion('ipv4')}
                  className={`py-2 rounded-lg border font-medium ${
                    addIpVersion === 'ipv4'
                      ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {isZh ? '申请公网 IPv4' : 'Allocate IPv4'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAddIpVersion('ipv6');
                    if (!addIpAddress && addIpPrefixInfo.prefix) {
                      setAddIpAddress(addIpPrefixInfo.prefix);
                    }
                  }}
                  className={`py-2 rounded-lg border font-medium ${
                    addIpVersion === 'ipv6'
                      ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {isZh ? '新增公网 IPv6' : 'Allocate IPv6'}
                </button>
              </div>

              {addIpVersion === 'ipv6' && addIpModalHost.provider !== 'gcp' && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="block font-medium">
                      {isZh
                        ? '指定 IPv6 地址（已默认填入子网前缀，直接续写后缀或留空自动分配）'
                        : 'Specific IPv6 (subnet prefix prefilled; append suffix or leave blank for auto)'}
                    </label>
                    {addIpPrefixInfo.loading && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-blue-600 dark:text-blue-400 shrink-0">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {isZh ? '读取子网前缀...' : 'Fetching prefix...'}
                      </span>
                    )}
                  </div>
                  <input
                    value={addIpAddress}
                    onChange={(e) => setAddIpAddress(e.target.value)}
                    placeholder={addIpPrefixInfo.prefix ? `${addIpPrefixInfo.prefix}10` : '2603:...'}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <span className="font-mono text-slate-500 dark:text-slate-400">
                      {addIpPrefixInfo.cidr
                        ? `${isZh ? '子网允许网段' : 'Subnet CIDR'}: ${addIpPrefixInfo.cidr}`
                        : isZh
                        ? '未检测到已有 IPv6 前缀，留空将由云端自动分配'
                        : 'No IPv6 prefix detected; leave blank for auto-assign'}
                    </span>
                    <div className="inline-flex items-center gap-2 shrink-0">
                      {addIpPrefixInfo.prefix && (
                        <button
                          type="button"
                          onClick={() => setAddIpAddress(addIpPrefixInfo.prefix!)}
                          className="text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          {isZh ? '填入前缀' : 'Fill Prefix'}
                        </button>
                      )}
                      {addIpAddress && (
                        <button
                          type="button"
                          onClick={() => setAddIpAddress('')}
                          className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:underline"
                        >
                          {isZh ? '清空改为自动分配' : 'Clear (Auto)'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <p className="text-[11px] text-slate-500 leading-relaxed">
                {addIpVersion === 'ipv4'
                  ? isZh
                    ? '将直接调用云商 API 为实例申请并绑定公网 IPv4（EIP / Ephemeral IP），成功后自动同步至绑定域名。'
                    : 'Allocates and associates a public IPv4 via the cloud provider API and cascades to the bound DNS rule.'
                  : isZh
                    ? '将直接调用云商 API 为实例主网卡分配新的公网 IPv6，成功后自动推送 AAAA 记录至绑定域名。'
                    : 'Assigns a new IPv6 address via the cloud provider API and cascades AAAA records to the bound DNS rule.'}
              </p>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setAddIpModalHost(null)}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  {t('cancel')}
                </button>
                <button
                  type="submit"
                  disabled={addIpBusy}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
                >
                  {addIpBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {isZh ? '立即分配' : 'Allocate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================== MODAL 5: DELETE IP CONFIRM ==================== */}
      {deleteIpTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-xs space-y-4">
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400 font-semibold text-sm">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {isZh ? '确认通过云端 API 删除 IP' : 'Confirm Cloud IP Deletion'}
            </div>
            <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
              {isZh
                ? `确认要从 ${deleteIpTarget.host.name} (${providerShortLabel(deleteIpTarget.host.provider, true)}) 删除 ${deleteIpTarget.version.toUpperCase()} 地址 `
                : `Delete ${deleteIpTarget.version.toUpperCase()} `}
              <span className="font-mono font-semibold text-slate-900 dark:text-white">{deleteIpTarget.address}</span>
              {isZh ? ' 吗？删除后将自动更新绑定域名与监控目标。' : '? Bound DNS and monitors will be updated automatically.'}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteIpTarget(null)}
                className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDeleteIp()}
                className="px-4 py-2 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-700"
              >
                {isZh ? '确认删除' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== FLOATING POWER MENU POPOVER (ALL 5 ACTIONS) ==================== */}
      {powerMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setPowerMenu(null)}
            aria-hidden="true"
          />
          <div
            style={{ top: powerMenu.top, right: powerMenu.right }}
            className="fixed z-50 w-56 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg py-1.5 text-xs"
          >
            <div className="px-3 py-1.5 border-b border-slate-100 dark:border-slate-800">
              <div className="font-semibold text-slate-900 dark:text-white truncate">{powerMenu.host.name}</div>
              <div className="text-[10px] font-mono text-slate-500">
                {providerShortLabel(powerMenu.host.provider, isZh)} · {powerMenu.host.region}
              </div>
            </div>
            {(
              [
                { action: 'START' as const, Icon: Play, cls: 'text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40' },
                { action: 'SOFTRESET' as const, Icon: RotateCcw, cls: 'text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40' },
                { action: 'RESET' as const, Icon: Power, cls: 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40' },
                { action: 'SOFTSTOP' as const, Icon: PowerOff, cls: 'text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40' },
                { action: 'STOP' as const, Icon: PowerOff, cls: 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 font-semibold' },
              ]
            ).map(({ action, Icon, cls }) => {
              const meta = getPowerActionMeta(action, isZh);
              return (
                <button
                  key={action}
                  type="button"
                  onClick={() => {
                    const targetHost = powerMenu.host;
                    setPowerMenu(null);
                    setConfirmPower({ host: targetHost, action });
                  }}
                  className={`w-full px-3 py-2 flex items-center gap-2 text-left transition-colors ${cls}`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{meta.label}</span>
                </button>
              );
            })}
            {!canControlHost(powerMenu.host) && (
              <div className="mt-1 px-3 py-1.5 border-t border-slate-100 dark:border-slate-800 text-[10px] text-amber-600 dark:text-amber-400">
                {isZh ? '需先上传云 API 凭据后实控执行' : 'Upload cloud API credentials to execute'}
              </div>
            )}
          </div>
        </>
      )}

      {/* ==================== MODAL 6: POWER ACTION CONFIRM (START / REBOOT / FORCE REBOOT / SHUTDOWN / FORCE SHUTDOWN) ==================== */}
      {confirmPower && (() => {
        const meta = getPowerActionMeta(confirmPower.action, isZh);
        const hostReady = canControlHost(confirmPower.host);
        const titleColor =
          meta.tone === 'emerald'
            ? 'text-emerald-600 dark:text-emerald-400'
            : meta.tone === 'red'
              ? 'text-red-600 dark:text-red-400'
              : 'text-amber-600 dark:text-amber-400';
        const btnColor =
          meta.tone === 'emerald'
            ? 'bg-emerald-600 hover:bg-emerald-700'
            : meta.tone === 'red'
              ? 'bg-red-600 hover:bg-red-700'
              : 'bg-amber-600 hover:bg-amber-700';
        return (
          <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-xs space-y-4">
              <div className={`flex items-center gap-2 font-semibold text-sm ${titleColor}`}>
                {confirmPower.action === 'SOFTSTOP' || confirmPower.action === 'STOP' ? (
                  <PowerOff className="w-4 h-4 shrink-0" />
                ) : (
                  <Power className="w-4 h-4 shrink-0" />
                )}
                {meta.confirmTitle}
              </div>

              <div className="space-y-2 text-slate-600 dark:text-slate-300 leading-relaxed">
                <p>
                  {isZh
                    ? `目标实例：${confirmPower.host.name}（${providerShortLabel(confirmPower.host.provider, true)} · ${confirmPower.host.region}）`
                    : `Target: ${confirmPower.host.name} (${providerShortLabel(confirmPower.host.provider, false)} · ${confirmPower.host.region})`}
                </p>
                <p className="text-slate-500 dark:text-slate-400">{meta.desc}</p>
                {confirmPower.host.provider === 'gcp' && (confirmPower.action === 'SOFTSTOP' || confirmPower.action === 'STOP') && (
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {isZh
                      ? '说明：GCP Compute Engine 的 /stop 接口会先触发 ACPI 关机，超时后由云平台自动强制断电。'
                      : 'Note: GCP Compute Engine /stop initiates graceful ACPI shutdown and falls back to forced power-off automatically.'}
                  </p>
                )}
              </div>

              {!hostReady && (
                <div className="p-3 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/70 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 space-y-2">
                  <div>
                    {isZh
                      ? '该实例所属云账号尚未上传有效 API 密钥/PEM 私钥（当前为模拟预置数据），无法向真实云端下发电源指令。'
                      : 'This host does not have live API credentials uploaded yet. Configure credentials first to execute real power commands.'}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const targetHost = confirmPower.host;
                      setConfirmPower(null);
                      setSubTab('accounts');
                      if (targetHost.provider === 'oracle') {
                        const prof = targetHost.ociProfileId ? ociProfileMap.get(targetHost.ociProfileId) : undefined;
                        if (prof) openEditOciProfile(prof);
                        else openNewOciProfile();
                      }
                    }}
                    className="inline-flex items-center gap-1 font-semibold text-blue-700 dark:text-blue-400 hover:underline"
                  >
                    {isZh ? '立即前往「云账号凭据」上传密钥 →' : 'Go to Cloud Credentials →'}
                  </button>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmPower(null)}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  disabled={!hostReady}
                  onClick={() => void executePowerAction(confirmPower.host, confirmPower.action)}
                  className={`px-4 py-2 rounded-lg text-white font-semibold disabled:opacity-45 ${btnColor}`}
                >
                  {isZh ? `确认${meta.short}` : `Confirm ${meta.short}`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ==================== MODAL 9: UNIFIED ORACLE OCI CREDENTIAL MODAL ==================== */}
      {showOciProfileModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
              <div>
                <h3 className="font-display text-lg font-semibold">
                  {editingOciProfile
                    ? isZh
                      ? `编辑 Oracle OCI 凭据 — ${editingOciProfile.name}`
                      : `Edit OCI Profile — ${editingOciProfile.name}`
                    : isZh
                      ? '添加 Oracle OCI 凭据'
                      : 'Add Oracle OCI Credential'}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {isZh
                    ? '上传/粘贴私钥后自动计算指纹（禁止手动修改）；支持一键连接 OCI 自动拉取区域、隔间、可用域 AD 与子网，免 main.tf。'
                    : 'Fingerprint is auto-calculated from PEM private key (read-only). Use Auto-Fetch to pull regions, compartments, ADs, and subnets.'}
                </p>
              </div>
              <button type="button" onClick={() => setShowOciProfileModal(false)} className="p-1 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveOciProfile} className="mt-4 space-y-4 text-sm">
              {!isOciIdentityLocked && (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setShowOciConfigPaste((v) => !v)}
                    className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {isZh
                      ? showOciConfigPaste
                        ? '收起 ~/.oci/config 快速解析'
                        : '粘贴 Oracle 控制台 ~/.oci/config 自动提取 Tenancy / User / Region →'
                      : showOciConfigPaste
                        ? 'Hide ~/.oci/config parser'
                        : 'Paste ~/.oci/config snippet to auto-fill Tenancy / User / Region →'}
                  </button>
                  {showOciConfigPaste && (
                    <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 space-y-2">
                      <textarea
                        rows={4}
                        value={ociConfigSnippet}
                        onChange={(e) => setOciConfigSnippet(e.target.value)}
                        placeholder={`[DEFAULT]\nuser=ocid1.user.oc1..aaaa...\ntenancy=ocid1.tenancy.oc1..aaaa...\nregion=ap-tokyo-1`}
                        className="w-full px-2.5 py-2 text-xs font-mono rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                      />
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={handleApplyOciConfigSnippet}
                          className="px-3 py-1.5 text-xs font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700"
                        >
                          {isZh ? '提取并填入' : 'Extract & Fill'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {ociSaveError && (
                <div className="p-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50/70 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
                  {ociSaveError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {isZh ? '凭据名称' : 'Profile Name'}
                  </label>
                  <input
                    required
                    value={ociProfForm.name}
                    onChange={(e) => setOciProfForm({ ...ociProfForm, name: e.target.value })}
                    placeholder="OCI Tokyo Primary"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('ociRegion')}</label>
                  <select
                    value={ociProfForm.region}
                    onChange={(e) => setOciProfForm({ ...ociProfForm, region: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  >
                    {availableOciRegionList.map((reg) => (
                      <option key={reg.value} value={reg.value}>
                        {reg.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="flex items-center justify-between text-xs font-medium mb-1">
                    <span>{t('tenancyOcid')}</span>
                    {isOciIdentityLocked && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                        <Lock className="w-3 h-3" />
                        {isZh ? '已验证禁改' : 'Locked'}
                      </span>
                    )}
                  </label>
                  <input
                    required
                    readOnly={isOciIdentityLocked}
                    disabled={isOciIdentityLocked}
                    value={ociProfForm.tenancyOcid}
                    onChange={(e) => setOciProfForm({ ...ociProfForm, tenancyOcid: e.target.value })}
                    placeholder="ocid1.tenancy.oc1..aaaa..."
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 disabled:opacity-65 disabled:cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="flex items-center justify-between text-xs font-medium mb-1">
                    <span>{t('userOcid')}</span>
                    {isOciIdentityLocked && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                        <Lock className="w-3 h-3" />
                        {isZh ? '已验证禁改' : 'Locked'}
                      </span>
                    )}
                  </label>
                  <input
                    required
                    readOnly={isOciIdentityLocked}
                    disabled={isOciIdentityLocked}
                    value={ociProfForm.userOcid}
                    onChange={(e) => setOciProfForm({ ...ociProfForm, userOcid: e.target.value })}
                    placeholder="ocid1.user.oc1..aaaa..."
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 disabled:opacity-65 disabled:cursor-not-allowed"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className="text-xs font-medium">{t('privateKeyPem')}</label>
                  <div>
                    <input
                      ref={ociPemFileInputRef}
                      type="file"
                      accept=".pem,.key,.txt"
                      onChange={handleOciPemFileUpload}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => ociPemFileInputRef.current?.click()}
                      className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      {isZh ? '选择 .pem 私钥文件' : 'Upload .pem file'}
                    </button>
                  </div>
                </div>
                <textarea
                  rows={4}
                  value={ociProfForm.privateKeyPem}
                  onChange={(e) => handleOciPemChange(e.target.value)}
                  placeholder={
                    editingOciProfile?.hasPrivateKey
                      ? isZh
                        ? '留空保持已加密保存的私钥；粘贴或上传新私钥将自动重算指纹'
                        : 'Leave blank to keep encrypted PEM; pasting/uploading a new key auto-recalculates fingerprint'
                      : '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----'
                  }
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
                {ociFpError && <div className="mt-1 text-xs text-red-600 dark:text-red-400">{ociFpError}</div>}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3.5 items-end">
                <div className="sm:col-span-8">
                  <label className="flex items-center justify-between text-xs font-medium mb-1">
                    <span>{t('fingerprint')}</span>
                    <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                      <Lock className="w-3 h-3" />
                      {computingOciFp
                        ? isZh
                          ? '正在计算...'
                          : 'Computing...'
                        : isZh
                          ? '私钥自动计算 · 禁止修改'
                          : 'Auto-computed · Read-only'}
                    </span>
                  </label>
                  <input
                    readOnly
                    disabled
                    value={ociProfForm.fingerprint}
                    placeholder={
                      isZh
                        ? '上传或粘贴 PEM 私钥后自动生成 MD5 指纹'
                        : 'Auto-derived MD5 fingerprint after PEM key is provided'
                    }
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/70 text-slate-700 dark:text-slate-200 cursor-not-allowed"
                  />
                </div>
                <div className="sm:col-span-4">
                  <button
                    type="button"
                    disabled={
                      discoveringOci ||
                      !ociProfForm.tenancyOcid.trim() ||
                      !ociProfForm.userOcid.trim() ||
                      (!ociProfForm.privateKeyPem.trim() && !editingOciProfile?.hasPrivateKey)
                    }
                    onClick={() => void handleAutoDiscoverOciProfile()}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:opacity-90 disabled:opacity-45 whitespace-nowrap"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${discoveringOci ? 'animate-spin' : ''}`} />
                    {discoveringOci
                      ? isZh
                        ? '正在拉取 OCI...'
                        : 'Discovering...'
                      : isZh
                        ? '自动获取 OCI 参数'
                        : 'Auto-Fetch OCI'}
                  </button>
                </div>
              </div>

              {discoverOciError && (
                <div className="p-3 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/70 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-300">
                  {discoverOciError}
                </div>
              )}

              {discoveredOci && (
                <div className="p-3 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/30 text-xs text-emerald-800 dark:text-emerald-300">
                  {isZh
                    ? `已自动验证并拉取：${discoveredOci.regions.length} 个订阅区域 · ${discoveredOci.compartments.length} 个隔间 · ${discoveredOci.availabilityDomains.length} 个可用域 · ${discoveredOci.subnets.length} 个子网 · ${discoveredOci.instanceCount} 台实例`
                    : `Auto-discovered: ${discoveredOci.regions.length} region(s) · ${discoveredOci.compartments.length} compartment(s) · ${discoveredOci.availabilityDomains.length} AD(s) · ${discoveredOci.subnets.length} subnet(s) · ${discoveredOci.instanceCount} instance(s)`}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {t('compartmentOcid')}
                    <span className="ml-1.5 text-[11px] text-slate-400">
                      {isZh ? '(默认根租户)' : '(defaults to Tenancy)'}
                    </span>
                  </label>
                  {discoveredOci?.compartments?.length ? (
                    <select
                      value={ociProfForm.compartmentOcid}
                      onChange={(e) => setOciProfForm({ ...ociProfForm, compartmentOcid: e.target.value })}
                      className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    >
                      {discoveredOci.compartments.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={ociProfForm.compartmentOcid}
                      onChange={(e) => setOciProfForm({ ...ociProfForm, compartmentOcid: e.target.value })}
                      placeholder={isZh ? '留空自动使用 Tenancy OCID' : 'Leave blank to use Tenancy OCID'}
                      className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    />
                  )}
                </div>

                <div>
                  <label className="flex items-center justify-between text-xs font-medium mb-1">
                    <span>{t('availabilityDomains')}</span>
                    <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                      <Lock className="w-3 h-3" />
                      {isZh ? 'OCI 自动获取 · 禁改' : 'Auto-fetched · Read-only'}
                    </span>
                  </label>
                  <input
                    readOnly
                    disabled
                    value={ociProfForm.availabilityDomains.join(', ')}
                    placeholder={
                      isZh
                        ? '点击「自动获取 OCI 参数」拉取真实 AD 名称'
                        : 'Click Auto-Fetch OCI to load exact AD names'
                    }
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/70 text-slate-700 dark:text-slate-200 cursor-not-allowed"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">
                  {t('subnetOcid')}
                  {discoveredOci?.subnets?.length ? (
                    <span className="ml-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                      {isZh ? `已拉取 ${discoveredOci.subnets.length} 个子网` : `${discoveredOci.subnets.length} discovered`}
                    </span>
                  ) : null}
                </label>
                {discoveredOci?.subnets?.length ? (
                  <select
                    value={ociProfForm.subnetOcid}
                    onChange={(e) => setOciProfForm({ ...ociProfForm, subnetOcid: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  >
                    <option value="">-- Select Subnet --</option>
                    {discoveredOci.subnets.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.displayName} ({s.cidrBlock}
                        {s.ipv6CidrBlock ? ' · IPv6' : ''}
                        {s.isPublic ? ' · Public' : ' · Private'})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={ociProfForm.subnetOcid}
                    onChange={(e) => setOciProfForm({ ...ociProfForm, subnetOcid: e.target.value })}
                    placeholder={
                      isZh
                        ? '留空由抢注任务自动探测公网子网，或点击上方「自动获取 OCI 参数」选择'
                        : 'Leave blank for auto-discovery or use Auto-Fetch OCI above'
                    }
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                )}
              </div>

              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowOciProfileModal(false)}
                  className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  {t('cancel')}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                >
                  {t('save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================== MODAL 7: EDIT HOST METADATA (NAME, GROUP, SSH, NOTES) ==================== */}
      {editingHost && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-display text-base font-semibold">
                {isZh ? '编辑云主机分组与备注' : 'Edit Cloud Host'}
              </h3>
              <button type="button" onClick={() => setEditingHost(null)} className="p-1 text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="mt-4 space-y-3.5 text-xs">
              {editError && (
                <div className="px-3 py-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300">
                  {editError}
                </div>
              )}

              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200/70 dark:border-slate-800 font-mono text-[11px] text-slate-500">
                <div>
                  {providerFullLabel(editingHost.provider as ManagedCloudProvider, isZh)} · {editingHost.region}
                  {editingHost.cloudZone ? ` (${editingHost.cloudZone})` : ''}
                </div>
                <div className="truncate mt-0.5">ID: {editingHost.instanceId}</div>
              </div>

              <div>
                <label className="block font-medium mb-1">{isZh ? '实例显示名称' : 'Display Name'}</label>
                <input
                  required
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </div>

              <div>
                <label className="block font-medium mb-1">{isZh ? '所属分组（用于批量筛选与定时策略）' : 'Host Group'}</label>
                <input
                  required
                  list="existing-host-groups"
                  value={editForm.groupName}
                  onChange={(e) => setEditForm({ ...editForm, groupName: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
                <datalist id="existing-host-groups">
                  {groupSummaries.map((g) => (
                    <option key={g.name} value={g.name} />
                  ))}
                </datalist>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium mb-1">SSH User</label>
                  <input
                    value={editForm.sshUser}
                    onChange={(e) => setEditForm({ ...editForm, sshUser: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">SSH Port</label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={editForm.sshPort}
                    onChange={(e) => setEditForm({ ...editForm, sshPort: Number(e.target.value) || 22 })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block font-medium mb-1">{isZh ? '备注' : 'Notes'}</label>
                <input
                  value={editForm.notes}
                  onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingHost(null)}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  {t('cancel')}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700"
                >
                  {t('save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================== MODAL 8: ADD MONITOR ==================== */}
      {showMonitorModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-display text-base font-semibold">
                {isZh ? '新增实时监控探针' : 'Add Live Monitor'}
              </h3>
              <button type="button" onClick={() => setShowMonitorModal(false)} className="p-1 text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateMonitor} className="mt-4 space-y-3.5 text-xs">
              <div>
                <label className="block font-medium mb-1">{isZh ? '探针名称 *' : 'Name *'}</label>
                <input
                  required
                  value={monitorForm.name}
                  onChange={(e) => setMonitorForm({ ...monitorForm, name: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium mb-1">{isZh ? '协议类型' : 'Probe Type'}</label>
                  <select
                    value={monitorForm.type}
                    onChange={(e) => setMonitorForm({ ...monitorForm, type: e.target.value as MonitorProbeType })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  >
                    <option value="tcp">TCP</option>
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                    <option value="dns">DNS</option>
                  </select>
                </div>
                {monitorForm.type === 'tcp' && (
                  <div>
                    <label className="block font-medium mb-1">Port</label>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={monitorForm.port}
                      onChange={(e) => setMonitorForm({ ...monitorForm, port: Number(e.target.value) || 22 })}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                    />
                  </div>
                )}
              </div>
              <div>
                <label className="block font-medium mb-1">{isZh ? '监控目标 (IP / URL / 域名) *' : 'Target *'}</label>
                <input
                  required
                  value={monitorForm.target}
                  onChange={(e) => setMonitorForm({ ...monitorForm, target: e.target.value })}
                  placeholder={
                    monitorForm.type === 'http'
                      ? 'http://example.com'
                      : monitorForm.type === 'https'
                      ? 'https://example.com'
                      : '1.2.3.4'
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                />
              </div>
              {(monitorForm.type === 'https' ||
                (monitorForm.type === 'http' && monitorForm.target.trim().toLowerCase().startsWith('https://'))) && (
                <label className="inline-flex items-center gap-2 font-medium text-slate-700 dark:text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={monitorForm.ignoreTlsErrors}
                    onChange={(e) => setMonitorForm({ ...monitorForm, ignoreTlsErrors: e.target.checked })}
                    className="rounded accent-amber-600"
                  />
                  <span>
                    {isZh
                      ? '忽略 HTTPS 网站的 TLS/SSL 证书错误 (Ignore TLS/SSL error for HTTPS websites)'
                      : 'Ignore TLS/SSL error for HTTPS websites'}
                  </span>
                </label>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowMonitorModal(false)}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  {t('cancel')}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700"
                >
                  {t('save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
