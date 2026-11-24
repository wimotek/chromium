import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CloudDownload,
  CloudUpload,
  Copy,
  Folder,
  Globe,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { apiRequest, formatTimeAgo } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { toast } from '../lib/toast';
import type {
  DnsProvider,
  DnsRecordType,
  LanguageCode,
  ManagedDnsRecord,
  ManagedDomain,
} from '../types/models';

interface DnsRecordsPanelProps {
  providers: DnsProvider[];
  records: ManagedDnsRecord[];
  managedDomains?: ManagedDomain[];
  detectedIps?: {
    ipv4: string | null;
    ipv6: string | null;
    ipv6List: string[];
  } | null;
  lang: LanguageCode;
  onReload: () => Promise<void>;
  onJumpToProviders: () => void;
  onNotify: (msg: string, kind?: 'success' | 'error' | 'info' | 'warning') => void;
}

const RECORD_TYPES: DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA', 'PTR'];

function isProviderConfigured(p?: DnsProvider): boolean {
  if (!p) return false;
  return p.type === 'webhook' ? Boolean(p.endpointUrl) : p.hasSecret;
}

function recordTypeTextColor(type: DnsRecordType): string {
  switch (type) {
    case 'A':
      return 'text-blue-700 dark:text-blue-400';
    case 'AAAA':
      return 'text-indigo-700 dark:text-indigo-400';
    case 'CNAME':
      return 'text-emerald-700 dark:text-emerald-400';
    case 'MX':
    case 'SRV':
      return 'text-amber-700 dark:text-amber-400';
    case 'TXT':
    case 'CAA':
      return 'text-slate-700 dark:text-slate-300';
    default:
      return 'text-slate-600 dark:text-slate-400';
  }
}

function contentPlaceholder(type: DnsRecordType, isZh: boolean): string {
  switch (type) {
    case 'A':
      return '138.2.45.109';
    case 'AAAA':
      return '2603:c020:4009:a100::10';
    case 'CNAME':
      return 'target.example.com';
    case 'MX':
      return 'mail.example.com';
    case 'TXT':
      return 'v=spf1 include:_spf.example.com ~all';
    case 'NS':
      return 'ns1.example.com';
    case 'SRV':
      return '0 5 5060 sip.example.com';
    case 'CAA':
      return '0 issue "letsencrypt.org"';
    case 'PTR':
      return 'host.example.com';
    default:
      return isZh ? '填写记录值' : 'Record value';
  }
}

interface ProviderDomainItem {
  id: string;
  name: string;
  status?: string;
}

interface DomainOverviewRow {
  key: string;
  providerId: string;
  domain: string;
  zoneId?: string;
  managedDomain?: ManagedDomain;
  recordCount: number;
  typeCounts: Array<{ type: DnsRecordType; count: number }>;
  groups: string[];
  lastSyncedAt?: string;
  remoteSyncedCount: number;
}

interface InlineRecordDraft {
  name: string;
  type: DnsRecordType;
  content: string;
  ttl: number;
  proxied: boolean;
  priority: number;
  line: string;
  groupName: string;
  notes: string;
  syncRemote: boolean;
}

export function DnsRecordsPanel({
  providers,
  records,
  managedDomains = [],
  detectedIps,
  lang,
  onReload,
  onJumpToProviders,
  onNotify,
}: DnsRecordsPanelProps) {
  const isZh = lang === 'zh-CN';

  // Two-level navigation: null => Domain List view; string (`${providerId}::${domain}`) => Domain Records view
  const [selectedDomainKey, setSelectedDomainKey] = useState<string | null>(null);

  // Level 1 (Domain List) filters
  const [domainSearch, setDomainSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [syncingDomainKey, setSyncingDomainKey] = useState<string | null>(null);

  // Level 2 (Inside Selected Domain) filters
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Selection for batch group move
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchGroupTarget, setBatchGroupTarget] = useState<string>('');
  const [batchBusy, setBatchBusy] = useState(false);

  // Copy feedback
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Pull from Provider Modal
  const [showPullModal, setShowPullModal] = useState(false);
  const [pullProviderId, setPullProviderId] = useState('');
  const [pullMode, setPullMode] = useState<'all' | 'single'>('all');
  const [pullDomains, setPullDomains] = useState<ProviderDomainItem[]>([]);
  const [pullLoadingDomains, setPullLoadingDomains] = useState(false);
  const [pullDomain, setPullDomain] = useState('');
  const [pullZoneId, setPullZoneId] = useState('');
  const [pullDefaultGroup, setPullDefaultGroup] = useState('');
  const [pullBusy, setPullBusy] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);

  // Level 1: Add Domain Modal
  const [showAddDomainModal, setShowAddDomainModal] = useState(false);
  const [addDomainProviderId, setAddDomainProviderId] = useState('');
  const [addDomainInput, setAddDomainInput] = useState('');
  const [addDomainBusy, setAddDomainBusy] = useState(false);
  const [addDomainError, setAddDomainError] = useState<string | null>(null);

  // NS Delegation Guide & Verification Modal
  const [nsGuideDomain, setNsGuideDomain] = useState<ManagedDomain | null>(null);
  const [nsCheckBusyId, setNsCheckBusyId] = useState<string | null>(null);

  // Level 2: Inline Row Editing + Inline Quick-Add + Single-Record Push
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [inlineEditDraft, setInlineEditDraft] = useState<InlineRecordDraft | null>(null);
  const [inlineEditBusy, setInlineEditBusy] = useState(false);

  const [showInlineAdd, setShowInlineAdd] = useState(false);
  const [inlineAddDraft, setInlineAddDraft] = useState<InlineRecordDraft>({
    name: '@',
    type: 'A',
    content: '',
    ttl: 300,
    proxied: false,
    priority: 10,
    line: '',
    groupName: isZh ? '默认分组' : 'Default',
    notes: '',
    syncRemote: true,
  });
  const [inlineAddBusy, setInlineAddBusy] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [pushingRecordId, setPushingRecordId] = useState<string | null>(null);

  // Delete confirm modal
  const [deleteTarget, setDeleteTarget] = useState<ManagedDnsRecord | null>(null);
  const [deleteRemoteChecked, setDeleteRemoteChecked] = useState(true);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const providerMap = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers]);
  const configuredProviders = useMemo(() => providers.filter((p) => isProviderConfigured(p)), [providers]);
  const pullSupportedProviders = useMemo(
    () => configuredProviders.filter((p) => ['cloudflare', 'dnspod', 'aliyun', 'porkbun'].includes(p.type)),
    [configuredProviders]
  );

  // Aggregate managedDomains + records into Level 1 Domain List rows
  const domainRows = useMemo<DomainOverviewRow[]>(() => {
    const map = new Map<
      string,
      {
        providerId: string;
        domain: string;
        zoneId?: string;
        managedDomain?: ManagedDomain;
        records: ManagedDnsRecord[];
      }
    >();

    for (const md of managedDomains) {
      const domain = (md.domain || '').toLowerCase();
      if (!domain) continue;
      const key = `${md.providerId}::${domain}`;
      map.set(key, {
        providerId: md.providerId,
        domain,
        zoneId: md.zoneId,
        managedDomain: md,
        records: [],
      });
    }

    for (const r of records) {
      const domain = (r.domain || '').toLowerCase();
      if (!domain) continue;
      const key = `${r.providerId}::${domain}`;
      const existing = map.get(key);
      if (existing) {
        existing.records.push(r);
        if (!existing.zoneId && r.zoneId) existing.zoneId = r.zoneId;
      } else {
        map.set(key, { providerId: r.providerId, domain, zoneId: r.zoneId, records: [r] });
      }
    }

    const out: DomainOverviewRow[] = [];
    for (const [key, bucket] of map.entries()) {
      const typeMap = new Map<DnsRecordType, number>();
      const groupSet = new Set<string>();
      let lastSyncedAt: string | undefined;
      let remoteSyncedCount = 0;

      for (const r of bucket.records) {
        typeMap.set(r.type, (typeMap.get(r.type) ?? 0) + 1);
        const g = (r.groupName || '').trim() || (isZh ? '默认分组' : 'Default');
        groupSet.add(g);
        if (r.syncState === 'synced') remoteSyncedCount += 1;
        if (r.lastSyncedAt && (!lastSyncedAt || r.lastSyncedAt > lastSyncedAt)) {
          lastSyncedAt = r.lastSyncedAt;
        }
      }

      const typeCounts = Array.from(typeMap.entries())
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count);

      out.push({
        key,
        providerId: bucket.providerId,
        domain: bucket.domain,
        zoneId: bucket.zoneId,
        managedDomain: bucket.managedDomain,
        recordCount: bucket.records.length,
        typeCounts,
        groups: Array.from(groupSet),
        lastSyncedAt,
        remoteSyncedCount,
      });
    }

    return out.sort((a, b) => a.domain.localeCompare(b.domain));
  }, [managedDomains, records, isZh]);

  const filteredDomainRows = useMemo(() => {
    const q = domainSearch.trim().toLowerCase();
    return domainRows.filter((row) => {
      if (providerFilter !== 'all' && row.providerId !== providerFilter) return false;
      if (!q) return true;
      const prov = providerMap.get(row.providerId);
      return `${row.domain} ${prov?.name || ''} ${prov?.type || ''} ${row.groups.join(' ')}`
        .toLowerCase()
        .includes(q);
    });
  }, [domainRows, providerFilter, domainSearch, providerMap]);

  const activeDomainRow = useMemo(
    () => (selectedDomainKey ? domainRows.find((d) => d.key === selectedDomainKey) ?? null : null),
    [domainRows, selectedDomainKey]
  );

  // Keep nsGuideDomain in sync with latest reloaded managedDomains
  useEffect(() => {
    if (!nsGuideDomain) return;
    const latest = managedDomains.find((d) => d.id === nsGuideDomain.id);
    if (latest) {
      setNsGuideDomain(latest);
    }
  }, [managedDomains, nsGuideDomain?.id]);

  // If the currently open domain disappears completely, return to domain list cleanly
  useEffect(() => {
    if (selectedDomainKey && !activeDomainRow) {
      setSelectedDomainKey(null);
    }
  }, [selectedDomainKey, activeDomainRow]);

  // Reset Level 2 filters & inline editors whenever entering a different domain
  const enterDomain = (key: string) => {
    setSelectedDomainKey(key);
    setGroupFilter('all');
    setTypeFilter('ALL');
    setSearchQuery('');
    setSelectedIds(new Set());
    setEditingRowId(null);
    setInlineEditDraft(null);
    setShowInlineAdd(false);
    setInlineError(null);
  };

  // Records inside currently selected domain (Level 2)
  const domainScopedRecords = useMemo(() => {
    if (!activeDomainRow) return [];
    return records.filter(
      (r) =>
        r.providerId === activeDomainRow.providerId &&
        r.domain.toLowerCase() === activeDomainRow.domain
    );
  }, [records, activeDomainRow]);

  const groupSummaries = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of domainScopedRecords) {
      const g = (r.groupName || '').trim() || (isZh ? '默认分组' : 'Default');
      map.set(g, (map.get(g) ?? 0) + 1);
    }
    return Array.from(map.entries()).map(([name, count]) => ({ name, count }));
  }, [domainScopedRecords, isZh]);

  const allGroups = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) {
      const g = (r.groupName || '').trim();
      if (g) set.add(g);
    }
    return Array.from(set);
  }, [records]);

  const filteredRecords = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return domainScopedRecords.filter((r) => {
      const g = (r.groupName || '').trim() || (isZh ? '默认分组' : 'Default');
      if (groupFilter !== 'all' && g !== groupFilter) return false;
      if (typeFilter !== 'ALL' && r.type !== typeFilter) return false;
      if (!q) return true;
      return `${r.fqdn} ${r.name} ${r.type} ${r.content} ${g} ${r.notes || ''}`
        .toLowerCase()
        .includes(q);
    });
  }, [domainScopedRecords, groupFilter, typeFilter, searchQuery, isZh]);

  const allVisibleSelected =
    filteredRecords.length > 0 && filteredRecords.every((r) => selectedIds.has(r.id));

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredRecords.map((r) => r.id)));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const fetchDomainsForProvider = useCallback(
    async (providerId: string, forceRefresh = false) => {
      const prov = providerMap.get(providerId);
      if (!prov || !isProviderConfigured(prov)) {
        setPullDomains([]);
        return;
      }
      setPullLoadingDomains(true);
      try {
        const res = await apiRequest<{
          ok: boolean;
          domains: ProviderDomainItem[];
          error?: string;
        }>(`/api/dns/providers/${encodeURIComponent(providerId)}/domains${forceRefresh ? '?refresh=1' : ''}`);
        const list = res.ok ? res.domains : [];
        setPullDomains(list);
        if (list.length > 0) {
          setPullDomain((prev) => prev || list[0].name);
          setPullZoneId((prev) => prev || list[0].id);
          setPullError(null);
        }
        if (!res.ok && res.error) setPullError(res.error);
      } catch (err) {
        setPullDomains([]);
        setPullError(err instanceof Error ? err.message : 'Failed to load domains');
      } finally {
        setPullLoadingDomains(false);
      }
    },
    [providerMap]
  );

  // Quick one-click Pull for a specific domain row or currently open domain
  const handleQuickPullDomain = async (row: DomainOverviewRow) => {
    const prov = providerMap.get(row.providerId);
    if (!prov || !isProviderConfigured(prov)) {
      onNotify(
        isZh ? '该服务商未配置 API 密钥，无法拉取远端记录' : 'Provider has no API secret configured',
        'warning'
      );
      return;
    }
    setSyncingDomainKey(row.key);
    try {
      const res = await apiRequest<{
        ok: boolean;
        total: number;
        addedCount: number;
        updatedCount: number;
        removedCount: number;
      }>('/api/dns/records/pull', {
        method: 'POST',
        body: JSON.stringify({
          providerId: row.providerId,
          domain: row.domain,
          zoneId: row.zoneId,
        }),
      });
      await onReload();
      onNotify(
        isZh
          ? `已从远端拉取 ${row.domain}：共 ${res.total} 条解析（新增 ${res.addedCount}，更新 ${res.updatedCount}，清理 ${res.removedCount}）`
          : `Pulled ${res.total} records for ${row.domain} (+${res.addedCount}, ~${res.updatedCount}, -${res.removedCount})`,
        'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Pull domain failed', 'error');
    } finally {
      setSyncingDomainKey(null);
    }
  };

  // Open Pull Modal
  const openPullModal = () => {
    setPullError(null);
    setPullDomains([]);
    setPullDomain(activeDomainRow?.domain || '');
    setPullZoneId(activeDomainRow?.zoneId || '');
    setPullDefaultGroup('');
    setPullMode(activeDomainRow ? 'single' : 'all');
    const first =
      (activeDomainRow ? providerMap.get(activeDomainRow.providerId) : undefined) ??
      pullSupportedProviders[0] ??
      configuredProviders[0];
    const pid = first?.id || '';
    setPullProviderId(pid);
    setShowPullModal(true);
    if (pid) {
      void fetchDomainsForProvider(pid);
    }
  };

  const handlePullRecords = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pullProviderId) {
      setPullError(isZh ? '请选择 DNS 服务商' : 'Select a DNS provider');
      return;
    }

    if (pullMode === 'all') {
      setPullBusy(true);
      setPullError(null);
      try {
        const res = await apiRequest<{
          ok: boolean;
          domainCount: number;
          totalRecords: number;
          addedCount: number;
          updatedCount: number;
          removedCount: number;
          errors: Array<{ domain: string; error: string }>;
        }>('/api/dns/records/pull-all', {
          method: 'POST',
          body: JSON.stringify({
            providerId: pullProviderId,
            defaultGroupName: pullDefaultGroup.trim() || undefined,
          }),
        });
        setShowPullModal(false);
        setSelectedDomainKey(null);
        await onReload();
        const errSuffix =
          res.errors.length > 0
            ? isZh
              ? `（${res.errors.length} 个域名失败）`
              : ` (${res.errors.length} failed)`
            : '';
        onNotify(
          isZh
            ? `已从远端拉取 ${res.domainCount} 个域名，共 ${res.totalRecords} 条记录（新增 ${res.addedCount}，更新 ${res.updatedCount}，清理 ${res.removedCount}）${errSuffix}`
            : `Pulled ${res.totalRecords} records across ${res.domainCount} domain(s)${errSuffix}`
        );
      } catch (err) {
        setPullError(err instanceof Error ? err.message : 'Pull all domains failed');
      } finally {
        setPullBusy(false);
      }
      return;
    }

    if (!pullDomain.trim()) {
      setPullError(isZh ? '请填写或选择主域名' : 'Select or enter a domain');
      return;
    }
    setPullBusy(true);
    setPullError(null);
    try {
      const cleanDom = pullDomain.trim().toLowerCase().replace(/\.$/, '');
      const matched = pullDomains.find((d) => d.name.toLowerCase() === cleanDom);
      const res = await apiRequest<{
        ok: boolean;
        total: number;
        addedCount: number;
        updatedCount: number;
        removedCount: number;
      }>('/api/dns/records/pull', {
        method: 'POST',
        body: JSON.stringify({
          providerId: pullProviderId,
          domain: cleanDom,
          zoneId: matched?.id || pullZoneId || undefined,
          defaultGroupName: pullDefaultGroup.trim() || undefined,
        }),
      });
      setShowPullModal(false);
      await onReload();
      onNotify(
        isZh
          ? `已拉取 ${cleanDom}：共 ${res.total} 条记录（新增 ${res.addedCount}，更新 ${res.updatedCount}，清理 ${res.removedCount}）`
          : `Pulled ${res.total} DNS records for ${cleanDom} (+${res.addedCount}, ~${res.updatedCount}, -${res.removedCount})`
      );
    } catch (err) {
      setPullError(err instanceof Error ? err.message : 'Pull DNS records failed');
    } finally {
      setPullBusy(false);
    }
  };

  // ==================== LEVEL 1: ADD DOMAIN + NS DELEGATION ====================
  const openAddDomainModal = () => {
    setAddDomainError(null);
    setAddDomainInput('');
    const first = pullSupportedProviders[0] ?? configuredProviders[0] ?? providers[0];
    setAddDomainProviderId(first?.id || '');
    setShowAddDomainModal(true);
  };

  const handleAddDomainSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addDomainProviderId) {
      setAddDomainError(isZh ? '请先选择 DNS 服务商' : 'Select a DNS provider');
      return;
    }
    const clean = addDomainInput.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
    if (!clean || !clean.includes('.')) {
      setAddDomainError(isZh ? '请输入有效的主域名，例如 example.com' : 'Enter a valid root domain like example.com');
      return;
    }
    setAddDomainBusy(true);
    setAddDomainError(null);
    try {
      const res = await apiRequest<{
        domain: ManagedDomain;
        nameServers?: string[];
        nsNote?: string;
        message?: string;
      }>('/api/dns/domains', {
        method: 'POST',
        body: JSON.stringify({
          providerId: addDomainProviderId,
          domain: clean,
        }),
      });
      setShowAddDomainModal(false);
      await onReload();
      onNotify(
        res.message ||
          (isZh ? `已添加域名 ${res.domain.domain}` : `Added domain ${res.domain.domain}`),
        'success'
      );
      // Immediately show NS setup guide modal so user knows the exact NS servers to configure at their registrar
      setNsGuideDomain(res.domain);
    } catch (err) {
      setAddDomainError(err instanceof Error ? err.message : 'Failed to add domain');
    } finally {
      setAddDomainBusy(false);
    }
  };

  const handleCheckDomainNs = async (domainObj: ManagedDomain) => {
    setNsCheckBusyId(domainObj.id);
    try {
      const res = await apiRequest<{
        domain: ManagedDomain;
        check?: {
          verified: boolean;
          liveNs: string[];
          message?: string;
        };
      }>(`/api/dns/domains/${encodeURIComponent(domainObj.id)}/check-ns`, {
        method: 'POST',
      });
      setNsGuideDomain(res.domain);
      await onReload();
      const verified = Boolean(res.check?.verified ?? res.domain.nsVerified);
      const msg =
        res.check?.message ||
        (verified
          ? isZh
            ? `${res.domain.domain} NS 已生效`
            : `NS verified for ${res.domain.domain}`
          : isZh
            ? `${res.domain.domain} 尚未检测到预期 NS，请确认已在注册商处修改并等待生效`
            : `NS not yet matching for ${res.domain.domain}`);
      onNotify(msg, verified ? 'success' : 'warning');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'NS check failed', 'error');
    } finally {
      setNsCheckBusyId(null);
    }
  };

  // ==================== LEVEL 2: INLINE ADD & INLINE EDIT & SINGLE PUSH ====================
  const activeProvider = activeDomainRow ? providerMap.get(activeDomainRow.providerId) : undefined;
  const activeProviderConfigured = isProviderConfigured(activeProvider);

  const openInlineAddRow = () => {
    if (!activeDomainRow) return;
    setEditingRowId(null);
    setInlineEditDraft(null);
    setInlineError(null);
    setInlineAddDraft({
      name: '@',
      type: 'A',
      content: '',
      ttl: 300,
      proxied: false,
      priority: 10,
      line: activeProvider?.type === 'dnspod' ? '默认' : '',
      groupName:
        groupFilter !== 'all'
          ? groupFilter
          : activeDomainRow.domain || (isZh ? '默认分组' : 'Default'),
      notes: '',
      syncRemote: activeProviderConfigured,
    });
    setShowInlineAdd(true);
  };

  const handleSaveInlineAdd = async () => {
    if (!activeDomainRow) return;
    if (!inlineAddDraft.content.trim()) {
      setInlineError(isZh ? '请填写记录值 (Value)' : 'Please enter a record value');
      return;
    }
    setInlineAddBusy(true);
    setInlineError(null);
    try {
      const res = await apiRequest<{ record: ManagedDnsRecord; message: string }>('/api/dns/records', {
        method: 'POST',
        body: JSON.stringify({
          providerId: activeDomainRow.providerId,
          domain: activeDomainRow.domain,
          name: inlineAddDraft.name.trim() || '@',
          type: inlineAddDraft.type,
          content: inlineAddDraft.content.trim(),
          ttl: Number(inlineAddDraft.ttl) || 300,
          proxied: inlineAddDraft.proxied,
          priority:
            inlineAddDraft.type === 'MX' || inlineAddDraft.type === 'SRV'
              ? Number(inlineAddDraft.priority) || 10
              : undefined,
          line: inlineAddDraft.line.trim() || undefined,
          groupName: inlineAddDraft.groupName.trim() || (isZh ? '默认分组' : 'Default'),
          notes: inlineAddDraft.notes.trim() || undefined,
          syncRemote: inlineAddDraft.syncRemote,
        }),
      });
      setShowInlineAdd(false);
      await onReload();
      onNotify(`${res.record.fqdn} (${res.record.type})：${res.message}`, 'success');
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : 'Create record failed');
    } finally {
      setInlineAddBusy(false);
    }
  };

  const startInlineEdit = (rec: ManagedDnsRecord) => {
    const prov = providerMap.get(rec.providerId);
    setShowInlineAdd(false);
    setInlineError(null);
    setEditingRowId(rec.id);
    setInlineEditDraft({
      name: rec.name,
      type: rec.type,
      content: rec.content,
      ttl: rec.ttl,
      proxied: Boolean(rec.proxied),
      priority: rec.priority ?? 10,
      line: rec.line || '',
      groupName: rec.groupName || (isZh ? '默认分组' : 'Default'),
      notes: rec.notes || '',
      syncRemote: isProviderConfigured(prov),
    });
  };

  const cancelInlineEdit = () => {
    setEditingRowId(null);
    setInlineEditDraft(null);
    setInlineError(null);
  };

  const handleSaveInlineEdit = async (rec: ManagedDnsRecord) => {
    if (!inlineEditDraft) return;
    if (!inlineEditDraft.content.trim()) {
      setInlineError(isZh ? '记录值不能为空' : 'Record value cannot be empty');
      return;
    }
    setInlineEditBusy(true);
    setInlineError(null);
    try {
      const res = await apiRequest<{ record: ManagedDnsRecord; message: string }>(
        `/api/dns/records/${encodeURIComponent(rec.id)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            providerId: rec.providerId,
            domain: rec.domain,
            name: inlineEditDraft.name.trim() || '@',
            type: inlineEditDraft.type,
            content: inlineEditDraft.content.trim(),
            ttl: Number(inlineEditDraft.ttl) || 300,
            proxied: inlineEditDraft.proxied,
            priority:
              inlineEditDraft.type === 'MX' || inlineEditDraft.type === 'SRV'
                ? Number(inlineEditDraft.priority) || 10
                : undefined,
            line: inlineEditDraft.line.trim() || undefined,
            groupName: inlineEditDraft.groupName.trim() || (isZh ? '默认分组' : 'Default'),
            notes: inlineEditDraft.notes.trim() || undefined,
            syncRemote: inlineEditDraft.syncRemote,
          }),
        }
      );
      setEditingRowId(null);
      setInlineEditDraft(null);
      await onReload();
      onNotify(`${res.record.fqdn} (${res.record.type})：${res.message}`, 'success');
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : 'Save & push failed');
    } finally {
      setInlineEditBusy(false);
    }
  };

  const handlePushSingleRecord = async (rec: ManagedDnsRecord) => {
    setPushingRecordId(rec.id);
    setInlineError(null);
    try {
      const res = await apiRequest<{ ok: boolean; record: ManagedDnsRecord; message: string }>(
        `/api/dns/records/${encodeURIComponent(rec.id)}/push`,
        { method: 'POST' }
      );
      await onReload();
      onNotify(`${res.record.fqdn} (${res.record.type})：${res.message}`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Push record failed';
      setInlineError(msg);
      onNotify(msg, 'error');
    } finally {
      setPushingRecordId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const res = await apiRequest<{ ok: boolean; message: string }>(
        `/api/dns/records/${deleteTarget.id}?deleteRemote=${deleteRemoteChecked ? 'true' : 'false'}`,
        { method: 'DELETE' }
      );
      setDeleteTarget(null);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(deleteTarget.id);
        return next;
      });
      await onReload();
      onNotify(`${deleteTarget.fqdn}：${res.message}`);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleBatchGroupMove = async () => {
    const targetGroup = batchGroupTarget.trim();
    if (!targetGroup || selectedIds.size === 0) return;
    setBatchBusy(true);
    try {
      const res = await apiRequest<{ ok: boolean; updatedCount: number; groupName: string }>(
        '/api/dns/records/batch-group',
        {
          method: 'POST',
          body: JSON.stringify({
            ids: Array.from(selectedIds),
            groupName: targetGroup,
          }),
        }
      );
      setSelectedIds(new Set());
      setBatchGroupTarget('');
      await onReload();
      onNotify(
        isZh
          ? `已将 ${res.updatedCount} 条 DNS 记录移动到分组「${res.groupName}」`
          : `Moved ${res.updatedCount} record(s) to group "${res.groupName}"`,
        'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Batch group move failed', 'error');
    } finally {
      setBatchBusy(false);
    }
  };

  const handleCopyValue = async (id: string, value: string, label?: string) => {
    const ok = await copyText(value);
    if (ok) {
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1500);
      toast.success(isZh ? `已复制${label ? ` ${label}` : ''}：${value}` : `Copied: ${value}`);
    } else {
      toast.error(isZh ? '复制失败，请手动选中复制' : 'Clipboard copy failed');
    }
  };

  return (
    <div className="space-y-4">
      <datalist id="dns-record-group-options">
        {allGroups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>

      {/* ===================================================================== */}
      {/* LEVEL 1: DOMAIN LIST VIEW                                             */}
      {/* ===================================================================== */}
      {!activeDomainRow ? (
        <>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2.5 text-xs">
                <div className="relative min-w-[220px] sm:w-72">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={domainSearch}
                    onChange={(e) => setDomainSearch(e.target.value)}
                    placeholder={isZh ? '搜索域名、服务商或分组...' : 'Search domain, provider, or group...'}
                    className="w-full pl-8 pr-7 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  {domainSearch && (
                    <button
                      type="button"
                      onClick={() => setDomainSearch('')}
                      aria-label="Clear domain search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <select
                  aria-label={isZh ? '按服务商筛选域名' : 'Filter provider'}
                  value={providerFilter}
                  onChange={(e) => setProviderFilter(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200"
                >
                  <option value="all">{isZh ? '全部 DNS 服务商' : 'All Providers'}</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.type})
                    </option>
                  ))}
                </select>

                <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                  {isZh
                    ? `共 ${filteredDomainRows.length} 个域名 · ${records.length} 条记录`
                    : `${filteredDomainRows.length} domain(s) · ${records.length} record(s)`}
                </span>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={openPullModal}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  <CloudDownload className="w-3.5 h-3.5" />
                  {isZh ? '从远端拉取 (Pull)' : 'Pull from Provider'}
                </button>
                <button
                  type="button"
                  onClick={openAddDomainModal}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {isZh ? '添加域名' : 'Add Domain'}
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-5 font-medium whitespace-nowrap">
                      {isZh ? '域名' : 'Domain'}
                    </th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">
                      {isZh ? '所属服务商' : 'Provider'}
                    </th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">
                      {isZh ? '解析记录分布' : 'Record Breakdown'}
                    </th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">
                      {isZh ? 'NS 托管状态' : 'NS Delegation'}
                    </th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">
                      {isZh ? '最近拉取 (Pull)' : 'Last Pulled'}
                    </th>
                    <th className="py-3 px-5 font-medium text-right whitespace-nowrap">
                      {isZh ? '操作' : 'Actions'}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70 text-xs">
                  {filteredDomainRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-14 px-4 text-center">
                        <div className="max-w-md mx-auto space-y-3">
                          <Globe className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto" />
                          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                            {domainRows.length === 0
                              ? isZh
                                ? '尚未拉取或添加任何域名'
                                : 'No domains yet'
                              : isZh
                                ? '没有匹配的域名'
                                : 'No domains match your filter'}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                            {providers.length === 0
                              ? isZh
                                ? '请先在「DNS 服务商」中添加 Cloudflare、DNSPod、阿里云或 Porkbun 账号凭据，即可一键拉取全部域名或添加新域名。'
                                : 'Add your Cloudflare, DNSPod, Aliyun, or Porkbun credentials under DNS Providers first.'
                              : isZh
                                ? '点击「从远端拉取 (Pull)」导入服务商下已有域名，或点击「添加域名」向服务商创建新域名并获取指定 NS 服务器指引。'
                                : 'Click "Pull from Provider" to import existing domains, or click "Add Domain" to onboard a new domain with NS instructions.'}
                          </p>
                          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                            {providers.length === 0 ? (
                              <button
                                type="button"
                                onClick={onJumpToProviders}
                                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700"
                              >
                                <KeyRound className="w-3.5 h-3.5" />
                                {isZh ? '去配置 DNS 服务商' : 'Configure DNS Provider'}
                                <ArrowRight className="w-3.5 h-3.5" />
                              </button>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={openPullModal}
                                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700"
                                >
                                  <CloudDownload className="w-3.5 h-3.5" />
                                  {isZh ? '从远端拉取 (Pull)' : 'Pull from Provider'}
                                </button>
                                <button
                                  type="button"
                                  onClick={openAddDomainModal}
                                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                  {isZh ? '添加域名' : 'Add Domain'}
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredDomainRows.map((row) => {
                      const prov = providerMap.get(row.providerId);
                      const isSyncing = syncingDomainKey === row.key;
                      const md = row.managedDomain;
                      const hasNsGuide = Boolean(md && md.nameServers && md.nameServers.length > 0);
                      return (
                        <tr
                          key={row.key}
                          onClick={() => enterDomain(row.key)}
                          className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors cursor-pointer group"
                        >
                          <td className="py-3.5 px-5 align-middle">
                            <div className="flex items-center gap-2.5">
                              <Globe className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
                              <div className="min-w-0">
                                <div className="font-mono text-sm font-semibold text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                                  {row.domain}
                                </div>
                                {row.zoneId && (
                                  <div className="text-[10px] font-mono text-slate-400 truncate max-w-[200px]">
                                    Zone: {row.zoneId}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="py-3.5 px-4 align-middle whitespace-nowrap">
                            <div className="font-medium text-slate-800 dark:text-slate-200">
                              {prov?.name || row.providerId}
                            </div>
                            <div className="text-[11px] font-mono text-slate-400 uppercase">
                              {prov?.type || 'unknown'}
                            </div>
                          </td>
                          <td className="py-3.5 px-4 align-middle">
                            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono tabular-nums">
                              <span className="font-semibold text-slate-900 dark:text-white">
                                {row.recordCount} {isZh ? '条' : 'rec'}
                              </span>
                              {row.typeCounts.length > 0 && (
                                <>
                                  <span className="text-slate-300 dark:text-slate-700">|</span>
                                  {row.typeCounts.slice(0, 5).map((tc) => (
                                    <span key={tc.type} className={`text-[11px] font-semibold ${recordTypeTextColor(tc.type)}`}>
                                      {tc.type}: {tc.count}
                                    </span>
                                  ))}
                                  {row.typeCounts.length > 5 && (
                                    <span className="text-[11px] text-slate-400">
                                      +{row.typeCounts.length - 5}
                                    </span>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                          <td
                            className="py-3.5 px-4 align-middle whitespace-nowrap"
                            onClick={(e) => {
                              if (hasNsGuide && md) {
                                e.stopPropagation();
                                setNsGuideDomain(md);
                              }
                            }}
                          >
                            {hasNsGuide && md ? (
                              md.nsVerified ? (
                                <button
                                  type="button"
                                  onClick={() => setNsGuideDomain(md)}
                                  className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 hover:underline"
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  {isZh ? 'NS 已生效' : 'NS Verified'}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setNsGuideDomain(md)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-[11px] font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/60"
                                >
                                  <AlertCircle className="w-3.5 h-3.5" />
                                  {isZh ? '待修改 NS · 查看指引' : 'Set NS · Guide'}
                                </button>
                              )
                            ) : (
                              <span className="text-[11px] text-slate-400">
                                {isZh ? '已托管' : 'Active'}
                              </span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 align-middle whitespace-nowrap font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                            {row.lastSyncedAt ? formatTimeAgo(row.lastSyncedAt) : isZh ? '未拉取' : 'Not pulled'}
                          </td>
                          <td
                            className="py-3.5 px-5 align-middle text-right whitespace-nowrap"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="inline-flex items-center gap-1.5">
                              {prov && isProviderConfigured(prov) && (
                                <button
                                  type="button"
                                  disabled={isSyncing}
                                  onClick={() => void handleQuickPullDomain(row)}
                                  title={
                                    isZh
                                      ? 'Pull：从远端 DNS 服务商拉取最新解析记录到本地视图'
                                      : 'Pull latest records from remote DNS provider'
                                  }
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                                >
                                  <CloudDownload className={`w-3.5 h-3.5 ${isSyncing ? 'animate-pulse' : ''}`} />
                                  <span className="hidden sm:inline">{isZh ? '拉取 (Pull)' : 'Pull'}</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => enterDomain(row.key)}
                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-blue-600 text-white font-medium hover:bg-blue-700"
                              >
                                {isZh ? '管理解析' : 'Records'}
                                <ChevronRight className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        /* ===================================================================== */
        /* LEVEL 2: SELECTED DOMAIN RECORDS VIEW (INLINE EDIT + IMMEDIATE PUSH)  */
        /* ===================================================================== */
        <>
          {/* Domain Breadcrumb & Quick Actions */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3.5">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3 min-w-0">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedDomainKey(null);
                    setSelectedIds(new Set());
                    setEditingRowId(null);
                    setShowInlineAdd(false);
                  }}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  {isZh ? '返回域名列表' : 'All Domains'}
                </button>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-mono text-base font-bold text-slate-900 dark:text-white truncate">
                      {activeDomainRow.domain}
                    </h2>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      · {activeProvider?.name || activeDomainRow.providerId}
                    </span>
                    <span className="font-mono text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      · {domainScopedRecords.length} {isZh ? '条记录' : 'records'}
                    </span>
                    {activeDomainRow.managedDomain &&
                      activeDomainRow.managedDomain.nameServers.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setNsGuideDomain(activeDomainRow.managedDomain!)}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border ${
                            activeDomainRow.managedDomain.nsVerified
                              ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                              : 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300'
                          }`}
                        >
                          {activeDomainRow.managedDomain.nsVerified ? (
                            <CheckCircle2 className="w-3 h-3" />
                          ) : (
                            <AlertCircle className="w-3 h-3" />
                          )}
                          {activeDomainRow.managedDomain.nsVerified
                            ? isZh
                              ? 'NS 已生效'
                              : 'NS Verified'
                            : isZh
                              ? '查看 NS 修改指引'
                              : 'NS Setup Guide'}
                        </button>
                      )}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {isZh
                      ? '拉取 (Pull) = 从 DNS 服务商读取最新解析到本地 · 行内编辑保存 / 推送 (Push) = 立即单条推送修改到 DNS 服务器生效。'
                      : 'Pull = read latest records from remote DNS · Inline Save / Push = immediately push single-record updates to remote DNS.'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {activeProvider && activeProviderConfigured && (
                  <button
                    type="button"
                    disabled={syncingDomainKey === activeDomainRow.key}
                    onClick={() => void handleQuickPullDomain(activeDomainRow)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <CloudDownload
                      className={`w-3.5 h-3.5 ${
                        syncingDomainKey === activeDomainRow.key ? 'animate-pulse' : ''
                      }`}
                    />
                    {isZh ? '拉取远端 (Pull)' : 'Pull Remote'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={openInlineAddRow}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {isZh ? '添加解析记录' : 'Add Record'}
                </button>
              </div>
            </div>

            {/* Inline NS Banner when domain has pending NS delegation */}
            {activeDomainRow.managedDomain &&
              !activeDomainRow.managedDomain.nsVerified &&
              activeDomainRow.managedDomain.nameServers.length > 0 && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-900/70 bg-amber-50/70 dark:bg-amber-950/20 px-3.5 py-2.5 flex flex-col md:flex-row md:items-center justify-between gap-2 text-xs">
                  <div className="space-y-1">
                    <div className="font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      {isZh
                        ? '请先在域名注册商处将 NS 服务器修改为以下地址，解析才会全球生效：'
                        : 'Update your domain registrar Nameservers (NS) to activate live DNS:'}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-amber-900 dark:text-amber-200">
                      {activeDomainRow.managedDomain.nameServers.map((ns) => (
                        <button
                          key={ns}
                          type="button"
                          onClick={() => void handleCopyValue(`banner-${ns}`, ns, 'NS')}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/80 dark:bg-slate-900/80 border border-amber-300/70 dark:border-amber-800 hover:border-blue-500"
                        >
                          {ns}
                          {copiedId === `banner-${ns}` ? (
                            <Check className="w-3 h-3 text-emerald-600" />
                          ) : (
                            <Copy className="w-3 h-3 text-slate-400" />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={nsCheckBusyId === activeDomainRow.managedDomain.id}
                      onClick={() => void handleCheckDomainNs(activeDomainRow.managedDomain!)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-50 whitespace-nowrap"
                    >
                      {nsCheckBusyId === activeDomainRow.managedDomain.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <ShieldCheck className="w-3.5 h-3.5" />
                      )}
                      {isZh ? '验证 NS 生效' : 'Verify NS'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setNsGuideDomain(activeDomainRow.managedDomain!)}
                      className="px-2.5 py-1.5 rounded-md border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-200 hover:bg-amber-100/60 dark:hover:bg-amber-950/40 whitespace-nowrap"
                    >
                      {isZh ? '详细指引' : 'Guide'}
                    </button>
                  </div>
                </div>
              )}

            {/* Scoped Group Filter + Search + Record Type Filter */}
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pt-3 border-t border-slate-100 dark:border-slate-800/80 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400 mr-1 whitespace-nowrap">
                  <Folder className="w-3.5 h-3.5" />
                  {isZh ? '分组:' : 'Group:'}
                </span>
                <button
                  type="button"
                  onClick={() => setGroupFilter('all')}
                  className={`px-2.5 py-1 rounded-md border text-xs font-medium transition-colors whitespace-nowrap tabular-nums ${
                    groupFilter === 'all'
                      ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  {isZh ? '全部' : 'All'} ({domainScopedRecords.length})
                </button>
                {groupSummaries.map((g) => (
                  <button
                    key={g.name}
                    type="button"
                    onClick={() => setGroupFilter(g.name)}
                    className={`px-2.5 py-1 rounded-md border text-xs font-medium transition-colors whitespace-nowrap tabular-nums ${
                      groupFilter === g.name
                        ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    {g.name} ({g.count})
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <div className="relative w-full sm:w-64">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={isZh ? '筛选主机记录、记录值、备注...' : 'Filter host, value, notes...'}
                    className="w-full pl-8 pr-7 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <select
                  aria-label={isZh ? '筛选记录类型' : 'Filter record type'}
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 font-mono"
                >
                  <option value="ALL">{isZh ? '全部类型' : 'All Types'}</option>
                  {RECORD_TYPES.map((rt) => (
                    <option key={rt} value={rt}>
                      {rt}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {inlineError && (
            <div className="px-4 py-2.5 rounded-xl border border-red-200 dark:border-red-900 bg-red-50/80 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300 flex items-center justify-between gap-2">
              <span>{inlineError}</span>
              <button type="button" onClick={() => setInlineError(null)} className="p-0.5 hover:opacity-70">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Floating Batch Group Move Dock */}
          {selectedIds.size > 0 && (
            <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 max-w-[94vw] flex flex-wrap items-center gap-3 px-4 py-2.5 rounded-xl border border-blue-200 dark:border-blue-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur shadow-xl text-xs">
              <span className="font-semibold text-blue-700 dark:text-blue-300 tabular-nums whitespace-nowrap">
                {isZh ? `已选中 ${selectedIds.size} 条记录` : `${selectedIds.size} record(s) selected`}
              </span>
              <div className="flex items-center gap-2">
                <input
                  list="dns-record-group-options"
                  value={batchGroupTarget}
                  onChange={(e) => setBatchGroupTarget(e.target.value)}
                  placeholder={isZh ? '输入或选择目标分组...' : 'Target group...'}
                  className="px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs w-40"
                />
                <button
                  type="button"
                  disabled={batchBusy || !batchGroupTarget.trim()}
                  onClick={() => void handleBatchGroupMove()}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                >
                  {batchBusy && <Loader2 className="w-3 h-3 animate-spin" />}
                  {isZh ? '批量归入分组' : 'Move to Group'}
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="px-2 py-1 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 whitespace-nowrap"
                >
                  {isZh ? '取消选择' : 'Clear'}
                </button>
              </div>
            </div>
          )}

          {/* Records Table for Selected Domain (Inline Add + Inline Row Edit) */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-4 w-10">
                      <input
                        type="checkbox"
                        aria-label="Select all records"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAllVisible}
                        className="rounded accent-blue-600"
                      />
                    </th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">
                      {isZh ? '主机记录 / 备注' : 'Host / Notes'}
                    </th>
                    <th className="py-3 px-3 font-medium whitespace-nowrap">
                      {isZh ? '类型' : 'Type'}
                    </th>
                    <th className="py-3 px-4 font-medium whitespace-nowrap">
                      {isZh ? '记录值' : 'Value / Target'}
                    </th>
                    <th className="py-3 px-3 font-medium whitespace-nowrap">
                      {isZh ? 'TTL / 属性' : 'TTL / Routing'}
                    </th>
                    <th className="py-3 px-3 font-medium whitespace-nowrap">
                      {isZh ? '分组' : 'Group'}
                    </th>
                    <th className="py-3 px-3 font-medium whitespace-nowrap">
                      {isZh ? '远端状态' : 'Remote'}
                    </th>
                    <th className="py-3 px-4 font-medium text-right whitespace-nowrap">
                      {isZh ? '操作' : 'Actions'}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70 text-xs">
                  {/* INLINE QUICK-ADD ROW */}
                  {showInlineAdd && (
                    <tr className="bg-blue-50/55 dark:bg-blue-950/25">
                      <td className="py-3 px-4 align-top">
                        <Plus className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-1.5" />
                      </td>
                      <td className="py-2.5 px-3 align-top min-w-[165px]">
                        <div className="space-y-1.5">
                          <input
                            autoFocus
                            value={inlineAddDraft.name}
                            onChange={(e) => setInlineAddDraft({ ...inlineAddDraft, name: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void handleSaveInlineAdd();
                              if (e.key === 'Escape') setShowInlineAdd(false);
                            }}
                            placeholder="@ / www / api"
                            className="w-full px-2.5 py-1.5 rounded-md border border-blue-300 dark:border-blue-700 bg-white dark:bg-slate-950 font-mono text-xs"
                          />
                          <input
                            value={inlineAddDraft.notes}
                            onChange={(e) => setInlineAddDraft({ ...inlineAddDraft, notes: e.target.value })}
                            placeholder={isZh ? '备注（可选）' : 'Notes (optional)'}
                            className="w-full px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-[11px]"
                          />
                        </div>
                      </td>
                      <td className="py-2.5 px-2 align-top">
                        <select
                          value={inlineAddDraft.type}
                          onChange={(e) =>
                            setInlineAddDraft({ ...inlineAddDraft, type: e.target.value as DnsRecordType })
                          }
                          className="px-2 py-1.5 rounded-md border border-blue-300 dark:border-blue-700 bg-white dark:bg-slate-950 font-mono font-semibold text-xs"
                        >
                          {RECORD_TYPES.map((rt) => (
                            <option key={rt} value={rt}>
                              {rt}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2.5 px-3 align-top min-w-[230px]">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            {(inlineAddDraft.type === 'MX' || inlineAddDraft.type === 'SRV') && (
                              <input
                                type="number"
                                min={0}
                                max={65535}
                                value={inlineAddDraft.priority}
                                onChange={(e) =>
                                  setInlineAddDraft({
                                    ...inlineAddDraft,
                                    priority: Number(e.target.value) || 10,
                                  })
                                }
                                title={isZh ? '优先级' : 'Priority'}
                                className="w-16 px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono text-xs"
                              />
                            )}
                            <input
                              value={inlineAddDraft.content}
                              onChange={(e) => setInlineAddDraft({ ...inlineAddDraft, content: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void handleSaveInlineAdd();
                                if (e.key === 'Escape') setShowInlineAdd(false);
                              }}
                              placeholder={contentPlaceholder(inlineAddDraft.type, isZh)}
                              className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md border border-blue-300 dark:border-blue-700 bg-white dark:bg-slate-950 font-mono text-xs"
                            />
                          </div>
                          {inlineAddDraft.type === 'A' && detectedIps?.ipv4 && (
                            <button
                              type="button"
                              onClick={() =>
                                setInlineAddDraft((prev) => ({ ...prev, content: detectedIps.ipv4! }))
                              }
                              className="text-[10px] font-mono text-blue-600 dark:text-blue-400 hover:underline"
                            >
                              {isZh ? `填入本机 IPv4: ${detectedIps.ipv4}` : `Use IPv4: ${detectedIps.ipv4}`}
                            </button>
                          )}
                          {inlineAddDraft.type === 'AAAA' && detectedIps?.ipv6 && (
                            <button
                              type="button"
                              onClick={() =>
                                setInlineAddDraft((prev) => ({ ...prev, content: detectedIps.ipv6! }))
                              }
                              className="text-[10px] font-mono text-blue-600 dark:text-blue-400 hover:underline"
                            >
                              {isZh ? `填入本机 IPv6: ${detectedIps.ipv6}` : `Use IPv6: ${detectedIps.ipv6}`}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-2 align-top min-w-[145px]">
                        <div className="space-y-1.5">
                          <input
                            type="number"
                            min={1}
                            max={86400}
                            value={inlineAddDraft.ttl}
                            onChange={(e) =>
                              setInlineAddDraft({ ...inlineAddDraft, ttl: Number(e.target.value) || 300 })
                            }
                            className="w-24 px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono text-xs"
                          />
                          {activeProvider?.type === 'cloudflare' &&
                            ['A', 'AAAA', 'CNAME'].includes(inlineAddDraft.type) && (
                              <label className="flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                                <input
                                  type="checkbox"
                                  checked={inlineAddDraft.proxied}
                                  onChange={(e) =>
                                    setInlineAddDraft({ ...inlineAddDraft, proxied: e.target.checked })
                                  }
                                  className="rounded accent-amber-500"
                                />
                                Proxied
                              </label>
                            )}
                          {(activeProvider?.type === 'dnspod' || activeProvider?.type === 'aliyun') && (
                            <input
                              value={inlineAddDraft.line}
                              onChange={(e) => setInlineAddDraft({ ...inlineAddDraft, line: e.target.value })}
                              placeholder={activeProvider.type === 'dnspod' ? '线路: 默认' : '线路: default'}
                              className="w-28 px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-[11px]"
                            />
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-2 align-top min-w-[110px]">
                        <input
                          list="dns-record-group-options"
                          value={inlineAddDraft.groupName}
                          onChange={(e) => setInlineAddDraft({ ...inlineAddDraft, groupName: e.target.value })}
                          className="w-28 px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs"
                        />
                      </td>
                      <td className="py-2.5 px-2 align-top whitespace-nowrap">
                        <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-blue-700 dark:text-blue-300 mt-1.5">
                          <input
                            type="checkbox"
                            disabled={!activeProviderConfigured}
                            checked={activeProviderConfigured && inlineAddDraft.syncRemote}
                            onChange={(e) =>
                              setInlineAddDraft({ ...inlineAddDraft, syncRemote: e.target.checked })
                            }
                            className="rounded accent-blue-600"
                          />
                          {activeProviderConfigured
                            ? isZh
                              ? '立即推送'
                              : 'Push Live'
                            : isZh
                              ? '仅本地'
                              : 'Local'}
                        </label>
                      </td>
                      <td className="py-2.5 px-4 align-top text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            disabled={inlineAddBusy}
                            onClick={() => void handleSaveInlineAdd()}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
                          >
                            {inlineAddBusy ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Save className="w-3.5 h-3.5" />
                            )}
                            {isZh ? '保存并推送' : 'Save'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowInlineAdd(false)}
                            className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                            title={isZh ? '取消' : 'Cancel'}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}

                  {filteredRecords.length === 0 && !showInlineAdd ? (
                    <tr>
                      <td colSpan={8} className="py-12 px-4 text-center text-slate-500 dark:text-slate-400">
                        <div className="space-y-2.5">
                          <p>
                            {domainScopedRecords.length === 0
                              ? isZh
                                ? '该域名下暂无解析记录，可直接点击「添加解析记录」行内新增并立即推送到远端。'
                                : 'No records yet for this domain. Click "Add Record" to add one inline.'
                              : isZh
                                ? '当前筛选条件下暂无解析记录'
                                : 'No records match your current filters'}
                          </p>
                          {domainScopedRecords.length === 0 && (
                            <button
                              type="button"
                              onClick={openInlineAddRow}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              {isZh ? '立即添加第一条解析' : 'Add First Record'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredRecords.map((rec) => {
                      const prov = providerMap.get(rec.providerId);
                      const provConfigured = isProviderConfigured(prov);
                      const isEditing = editingRowId === rec.id && inlineEditDraft !== null;
                      const isPushing = pushingRecordId === rec.id;

                      if (isEditing && inlineEditDraft) {
                        return (
                          <tr key={rec.id} className="bg-amber-50/45 dark:bg-amber-950/20">
                            <td className="py-3 px-4 align-top">
                              <Pencil className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 mt-1.5" />
                            </td>
                            <td className="py-2.5 px-3 align-top min-w-[165px]">
                              <div className="space-y-1.5">
                                <input
                                  autoFocus
                                  value={inlineEditDraft.name}
                                  onChange={(e) =>
                                    setInlineEditDraft({ ...inlineEditDraft, name: e.target.value })
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') void handleSaveInlineEdit(rec);
                                    if (e.key === 'Escape') cancelInlineEdit();
                                  }}
                                  className="w-full px-2.5 py-1.5 rounded-md border border-amber-400 dark:border-amber-700 bg-white dark:bg-slate-950 font-mono text-xs"
                                />
                                <input
                                  value={inlineEditDraft.notes}
                                  onChange={(e) =>
                                    setInlineEditDraft({ ...inlineEditDraft, notes: e.target.value })
                                  }
                                  placeholder={isZh ? '备注（可选）' : 'Notes'}
                                  className="w-full px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-[11px]"
                                />
                              </div>
                            </td>
                            <td className="py-2.5 px-2 align-top">
                              <select
                                value={inlineEditDraft.type}
                                onChange={(e) =>
                                  setInlineEditDraft({
                                    ...inlineEditDraft,
                                    type: e.target.value as DnsRecordType,
                                  })
                                }
                                className="px-2 py-1.5 rounded-md border border-amber-400 dark:border-amber-700 bg-white dark:bg-slate-950 font-mono font-semibold text-xs"
                              >
                                {RECORD_TYPES.map((rt) => (
                                  <option key={rt} value={rt}>
                                    {rt}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="py-2.5 px-3 align-top min-w-[230px]">
                              <div className="space-y-1.5">
                                <div className="flex items-center gap-1.5">
                                  {(inlineEditDraft.type === 'MX' || inlineEditDraft.type === 'SRV') && (
                                    <input
                                      type="number"
                                      min={0}
                                      max={65535}
                                      value={inlineEditDraft.priority}
                                      onChange={(e) =>
                                        setInlineEditDraft({
                                          ...inlineEditDraft,
                                          priority: Number(e.target.value) || 10,
                                        })
                                      }
                                      className="w-16 px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono text-xs"
                                    />
                                  )}
                                  <input
                                    value={inlineEditDraft.content}
                                    onChange={(e) =>
                                      setInlineEditDraft({ ...inlineEditDraft, content: e.target.value })
                                    }
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') void handleSaveInlineEdit(rec);
                                      if (e.key === 'Escape') cancelInlineEdit();
                                    }}
                                    className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md border border-amber-400 dark:border-amber-700 bg-white dark:bg-slate-950 font-mono text-xs"
                                  />
                                </div>
                                {inlineEditDraft.type === 'A' && detectedIps?.ipv4 && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setInlineEditDraft((prev) =>
                                        prev ? { ...prev, content: detectedIps.ipv4! } : prev
                                      )
                                    }
                                    className="text-[10px] font-mono text-blue-600 dark:text-blue-400 hover:underline"
                                  >
                                    {isZh ? `填入本机 IPv4: ${detectedIps.ipv4}` : `Use IPv4: ${detectedIps.ipv4}`}
                                  </button>
                                )}
                              </div>
                            </td>
                            <td className="py-2.5 px-2 align-top min-w-[145px]">
                              <div className="space-y-1.5">
                                <input
                                  type="number"
                                  min={1}
                                  max={86400}
                                  value={inlineEditDraft.ttl}
                                  onChange={(e) =>
                                    setInlineEditDraft({
                                      ...inlineEditDraft,
                                      ttl: Number(e.target.value) || 300,
                                    })
                                  }
                                  className="w-24 px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono text-xs"
                                />
                                {prov?.type === 'cloudflare' &&
                                  ['A', 'AAAA', 'CNAME'].includes(inlineEditDraft.type) && (
                                    <label className="flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                                      <input
                                        type="checkbox"
                                        checked={inlineEditDraft.proxied}
                                        onChange={(e) =>
                                          setInlineEditDraft({
                                            ...inlineEditDraft,
                                            proxied: e.target.checked,
                                          })
                                        }
                                        className="rounded accent-amber-500"
                                      />
                                      Proxied
                                    </label>
                                  )}
                                {(prov?.type === 'dnspod' || prov?.type === 'aliyun') && (
                                  <input
                                    value={inlineEditDraft.line}
                                    onChange={(e) =>
                                      setInlineEditDraft({ ...inlineEditDraft, line: e.target.value })
                                    }
                                    placeholder={prov.type === 'dnspod' ? '默认' : 'default'}
                                    className="w-28 px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-[11px]"
                                  />
                                )}
                              </div>
                            </td>
                            <td className="py-2.5 px-2 align-top min-w-[110px]">
                              <input
                                list="dns-record-group-options"
                                value={inlineEditDraft.groupName}
                                onChange={(e) =>
                                  setInlineEditDraft({ ...inlineEditDraft, groupName: e.target.value })
                                }
                                className="w-28 px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs"
                              />
                            </td>
                            <td className="py-2.5 px-2 align-top whitespace-nowrap">
                              <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 mt-1.5">
                                <input
                                  type="checkbox"
                                  disabled={!provConfigured}
                                  checked={provConfigured && inlineEditDraft.syncRemote}
                                  onChange={(e) =>
                                    setInlineEditDraft({ ...inlineEditDraft, syncRemote: e.target.checked })
                                  }
                                  className="rounded accent-emerald-600"
                                />
                                {provConfigured
                                  ? isZh
                                    ? '保存即推送'
                                    : 'Push Live'
                                  : isZh
                                    ? '仅本地'
                                    : 'Local'}
                              </label>
                            </td>
                            <td className="py-2.5 px-4 align-top text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={inlineEditBusy}
                                  onClick={() => void handleSaveInlineEdit(rec)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-50"
                                >
                                  {inlineEditBusy ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Save className="w-3.5 h-3.5" />
                                  )}
                                  {isZh ? '保存并推送' : 'Save & Push'}
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelInlineEdit}
                                  className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                                  title={isZh ? '取消编辑' : 'Cancel'}
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      }

                      return (
                        <tr
                          key={rec.id}
                          onDoubleClick={() => startInlineEdit(rec)}
                          className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors"
                        >
                          <td className="py-3 px-4 align-middle">
                            <input
                              type="checkbox"
                              aria-label={`Select ${rec.fqdn}`}
                              checked={selectedIds.has(rec.id)}
                              onChange={() => toggleSelectOne(rec.id)}
                              className="rounded accent-blue-600"
                            />
                          </td>
                          <td className="py-3 px-4 align-middle min-w-[180px]">
                            <div className="font-mono font-semibold text-slate-900 dark:text-white">
                              {rec.name}
                            </div>
                            <div className="mt-0.5 text-[11px] font-mono text-slate-500 dark:text-slate-400">
                              {rec.fqdn}
                              {rec.notes ? ` · ${rec.notes}` : ''}
                            </div>
                          </td>
                          <td className="py-3 px-3 align-middle whitespace-nowrap">
                            <span className={`font-mono font-bold text-xs ${recordTypeTextColor(rec.type)}`}>
                              {rec.type}
                            </span>
                          </td>
                          <td className="py-3 px-4 align-middle max-w-[300px]">
                            <div className="flex items-center gap-1.5">
                              <span
                                className="font-mono text-slate-800 dark:text-slate-200 truncate tabular-nums"
                                title={rec.content}
                              >
                                {rec.priority !== undefined && (rec.type === 'MX' || rec.type === 'SRV')
                                  ? `[${rec.priority}] ${rec.content}`
                                  : rec.content}
                              </span>
                              <button
                                type="button"
                                onClick={() => void handleCopyValue(rec.id, rec.content)}
                                title={isZh ? '复制记录值' : 'Copy value'}
                                className="p-1 rounded text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 shrink-0"
                              >
                                {copiedId === rec.id ? (
                                  <Check className="w-3 h-3 text-emerald-600" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                              </button>
                            </div>
                          </td>
                          <td className="py-3 px-3 align-middle whitespace-nowrap font-mono text-[11px] text-slate-600 dark:text-slate-300 tabular-nums">
                            <span>{rec.ttl === 1 ? 'Auto' : `${rec.ttl}s`}</span>
                            {rec.proxied !== undefined && prov?.type === 'cloudflare' && (
                              <span className={rec.proxied ? ' text-amber-600 dark:text-amber-400' : ' text-slate-400'}>
                                {' · '}
                                {rec.proxied ? 'Proxied' : 'DNS Only'}
                              </span>
                            )}
                            {rec.line && <span className="text-slate-400"> · {rec.line}</span>}
                          </td>
                          <td className="py-3 px-3 align-middle whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => setGroupFilter(rec.groupName || (isZh ? '默认分组' : 'Default'))}
                              className="inline-flex items-center gap-1 text-[11px] text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400"
                            >
                              <Folder className="w-3 h-3 text-slate-400" />
                              {rec.groupName || (isZh ? '默认分组' : 'Default')}
                            </button>
                          </td>
                          <td className="py-3 px-3 align-middle whitespace-nowrap">
                            <div
                              className={`text-[11px] font-medium ${
                                rec.syncState === 'synced'
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : rec.syncState === 'error'
                                    ? 'text-red-600 dark:text-red-400'
                                    : 'text-amber-600 dark:text-amber-400'
                              }`}
                            >
                              {rec.syncState === 'synced'
                                ? isZh
                                  ? '远端一致'
                                  : 'Synced'
                                : rec.syncState === 'error'
                                  ? isZh
                                    ? '推送失败'
                                    : 'Push Error'
                                  : isZh
                                    ? '待推送'
                                    : 'Local Only'}
                            </div>
                            <div className="text-[10px] font-mono text-slate-400 tabular-nums min-h-[14px]">
                              {rec.lastSyncedAt ? formatTimeAgo(rec.lastSyncedAt) : '—'}
                            </div>
                          </td>
                          <td className="py-3 px-4 align-middle text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1">
                              {provConfigured && (
                                <button
                                  type="button"
                                  disabled={isPushing}
                                  onClick={() => void handlePushSingleRecord(rec)}
                                  title={
                                    isZh
                                      ? 'Push：立即将此单条记录推送到远端 DNS 服务器'
                                      : 'Push this record immediately to remote DNS server'
                                  }
                                  className={`p-1.5 rounded-md border transition-colors disabled:opacity-50 ${
                                    rec.syncState !== 'synced'
                                      ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 hover:bg-amber-100'
                                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-emerald-600'
                                  }`}
                                >
                                  {isPushing ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <CloudUpload className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => startInlineEdit(rec)}
                                title={isZh ? '行内直接编辑（保存后立即推送）' : 'Edit inline (pushes on save)'}
                                className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-blue-600 dark:hover:text-blue-400"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setDeleteTarget(rec);
                                  setDeleteRemoteChecked(Boolean(rec.remoteRecordId));
                                  setDeleteError(null);
                                }}
                                title={isZh ? '删除记录' : 'Delete record'}
                                className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-600 dark:hover:text-red-400"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ==================== MODAL 1: PULL LIVE RECORDS FROM PROVIDER ==================== */}
      {showPullModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <div>
                <h3 className="font-display text-lg font-semibold">
                  {isZh ? '从 DNS 服务商拉取域名与解析 (Pull)' : 'Pull Live DNS Domains & Records'}
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {isZh
                    ? 'Pull 仅读取远端 DNS 服务商的最新配置并同步到本地视图，不会覆盖远端服务器。修改推送请使用行内「保存并推送」或单条 Push。'
                    : 'Pull reads live zones/records from your DNS provider into NetPlus without overwriting remote records.'}
                </p>
              </div>
              <button type="button" onClick={() => setShowPullModal(false)} className="p-1 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            {pullSupportedProviders.length === 0 ? (
              <div className="py-8 text-center space-y-3 text-xs">
                <p className="text-slate-600 dark:text-slate-300">
                  {isZh
                    ? '尚未配置已保存 API 密钥的 Cloudflare / DNSPod / 阿里云 DNS / Porkbun 服务商，请先配置凭据后再拉取。'
                    : 'Configure credentials for Cloudflare, DNSPod, Aliyun DNS, or Porkbun first.'}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setShowPullModal(false);
                    onJumpToProviders();
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  {isZh ? '去配置 DNS 服务商密钥' : 'Configure DNS Providers'}
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <form onSubmit={handlePullRecords} className="mt-4 space-y-4 text-xs">
                {pullError && (
                  <div className="px-3 py-2.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300 leading-relaxed">
                    {pullError}
                  </div>
                )}

                <div>
                  <label className="block font-medium mb-1">{isZh ? '选择 DNS 服务商 *' : 'DNS Provider *'}</label>
                  <div className="flex gap-2">
                    <select
                      required
                      value={pullProviderId}
                      onChange={(e) => {
                        const pid = e.target.value;
                        setPullProviderId(pid);
                        setPullDomain('');
                        setPullZoneId('');
                        setPullError(null);
                        void fetchDomainsForProvider(pid);
                      }}
                      className="flex-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    >
                      {pullSupportedProviders.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.type})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={pullLoadingDomains}
                      onClick={() => void fetchDomainsForProvider(pullProviderId, true)}
                      title={isZh ? '刷新域名列表' : 'Refresh domains'}
                      className="px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${pullLoadingDomains ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setPullMode('all')}
                    className={`px-3 py-2 rounded-lg border text-left transition-colors ${
                      pullMode === 'all'
                        ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    <div>{isZh ? '拉取全部域名' : 'Pull All Domains'}</div>
                    <div className="text-[10px] opacity-80 font-mono mt-0.5">
                      {pullLoadingDomains
                        ? isZh
                          ? '检测中...'
                          : 'Detecting...'
                        : pullDomains.length > 0
                        ? isZh
                          ? `检测到 ${pullDomains.length} 个域名`
                          : `${pullDomains.length} domain(s) found`
                        : isZh
                        ? '一键导入账号下所有域名'
                        : 'Import all zones'}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPullMode('single')}
                    className={`px-3 py-2 rounded-lg border text-left transition-colors ${
                      pullMode === 'single'
                        ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    <div>{isZh ? '仅拉取单个域名' : 'Single Domain'}</div>
                    <div className="text-[10px] opacity-80 mt-0.5">
                      {isZh ? '指定一个主域名拉取' : 'Pull one specific zone'}
                    </div>
                  </button>
                </div>

                {pullMode === 'single' && (
                  <div>
                    <label className="block font-medium mb-1">
                      {isZh ? '主域名 *' : 'Domain *'}
                      {pullLoadingDomains && (
                        <span className="ml-2 text-[10px] text-blue-600">
                          {isZh ? '正在读取账号下域名列表...' : 'Loading domains...'}
                        </span>
                      )}
                    </label>
                    {pullDomains.length > 0 ? (
                      <select
                        required
                        value={pullDomain}
                        onChange={(e) => {
                          const val = e.target.value;
                          setPullDomain(val);
                          const found = pullDomains.find((d) => d.name === val);
                          setPullZoneId(found?.id || '');
                        }}
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                      >
                        {pullDomains.map((d) => (
                          <option key={d.id} value={d.name}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        required
                        value={pullDomain}
                        onChange={(e) => setPullDomain(e.target.value)}
                        placeholder="example.com"
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                      />
                    )}
                  </div>
                )}

                <div>
                  <label className="block font-medium mb-1">
                    {isZh ? '新拉取记录的默认分组（可选）' : 'Default Group for New Records (Optional)'}
                  </label>
                  <input
                    list="dns-record-group-options"
                    value={pullDefaultGroup}
                    onChange={(e) => setPullDefaultGroup(e.target.value)}
                    placeholder={isZh ? '留空则默认按各自域名自动分组' : 'Defaults to each domain name'}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => setShowPullModal(false)}
                    className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
                  >
                    {isZh ? '取消' : 'Cancel'}
                  </button>
                  <button
                    type="submit"
                    disabled={pullBusy}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
                  >
                    {pullBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudDownload className="w-3.5 h-3.5" />}
                    {pullMode === 'all'
                      ? isZh
                        ? '拉取全部域名'
                        : 'Pull All Domains'
                      : isZh
                      ? '立即拉取 (Pull)'
                      : 'Pull Records'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* ==================== MODAL 2: ADD DOMAIN TO DNS PROVIDER ==================== */}
      {showAddDomainModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <div>
                <h3 className="font-display text-lg font-semibold">
                  {isZh ? '添加域名到 DNS 服务商' : 'Add Domain to DNS Provider'}
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {isZh
                    ? '系统将调用服务商 API 创建域名托管区，并自动获取该服务商分配的专属 NS 服务器地址通知您修改。'
                    : 'Creates the zone on your DNS provider via API and returns the assigned Nameservers (NS) to set at your registrar.'}
                </p>
              </div>
              <button type="button" onClick={() => setShowAddDomainModal(false)} className="p-1 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            {providers.length === 0 ? (
              <div className="py-8 text-center space-y-3 text-xs">
                <p className="text-slate-600 dark:text-slate-300">
                  {isZh
                    ? '请先配置至少一个 DNS 服务商账号凭据。'
                    : 'Please configure at least one DNS provider first.'}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddDomainModal(false);
                    onJumpToProviders();
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  {isZh ? '去配置 DNS 服务商' : 'Configure DNS Providers'}
                </button>
              </div>
            ) : (
              <form onSubmit={handleAddDomainSubmit} className="mt-4 space-y-4 text-xs">
                {addDomainError && (
                  <div className="px-3 py-2.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300">
                    {addDomainError}
                  </div>
                )}

                <div>
                  <label className="block font-medium mb-1">
                    {isZh ? '目标 DNS 服务商 *' : 'Target DNS Provider *'}
                  </label>
                  <select
                    required
                    value={addDomainProviderId}
                    onChange={(e) => setAddDomainProviderId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.type}){isProviderConfigured(p) ? '' : isZh ? ' [未配密钥]' : ' [Local]'}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-medium mb-1">
                    {isZh ? '主域名（根域名）*' : 'Root Domain *'}
                  </label>
                  <input
                    required
                    autoFocus
                    value={addDomainInput}
                    onChange={(e) => setAddDomainInput(e.target.value)}
                    placeholder="example.com"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                  />
                  <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                    {isZh
                      ? '支持自动获取：Cloudflare（API 返回该 Zone 专属双 NS）、DNSPod（套餐对应 NS）、阿里云 DNS（DnsServers）、Porkbun（默认 NS）。创建完成后将立即弹出 NS 修改指引并支持一键验证生效。'
                      : 'Automatically fetches provider NS servers for Cloudflare, DNSPod, Aliyun DNS, and Porkbun, with one-click live NS verification.'}
                  </p>
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => setShowAddDomainModal(false)}
                    className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
                  >
                    {isZh ? '取消' : 'Cancel'}
                  </button>
                  <button
                    type="submit"
                    disabled={addDomainBusy}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
                  >
                    {addDomainBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                    {isZh ? '创建域名并获取 NS' : 'Add Domain & Fetch NS'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* ==================== MODAL 3: NS DELEGATION GUIDE & VERIFICATION ==================== */}
      {nsGuideDomain && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4 text-xs">
            <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white">
                    {isZh ? '域名 NS 服务器配置指引' : 'Nameserver (NS) Delegation Guide'}
                  </h3>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium ${
                      nsGuideDomain.nsVerified
                        ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                        : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'
                    }`}
                  >
                    {nsGuideDomain.nsVerified ? (
                      <CheckCircle2 className="w-3 h-3" />
                    ) : (
                      <AlertCircle className="w-3 h-3" />
                    )}
                    {nsGuideDomain.nsVerified
                      ? isZh
                        ? 'NS 已生效'
                        : 'Verified'
                      : isZh
                        ? '待修改 / 等待生效'
                        : 'Pending NS Update'}
                  </span>
                </div>
                <p className="font-mono text-sm font-bold text-blue-600 dark:text-blue-400 mt-1">
                  {nsGuideDomain.domain}
                </p>
              </div>
              <button type="button" onClick={() => setNsGuideDomain(null)} className="p-1 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  {isZh
                    ? '请前往域名注册商（如阿里云/腾讯云/GoDaddy/Namecheap/Porkbun）将 DNS 服务器修改为：'
                    : 'Set the following Nameservers at your domain registrar:'}
                </span>
                {nsGuideDomain.nameServers.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      void handleCopyValue(
                        'copy-all-ns',
                        nsGuideDomain.nameServers.join('\n'),
                        isZh ? '全部 NS' : 'All NS'
                      )
                    }
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline shrink-0"
                  >
                    <Copy className="w-3 h-3" />
                    {isZh ? '复制全部' : 'Copy All'}
                  </button>
                )}
              </div>

              {nsGuideDomain.nameServers.length > 0 ? (
                <div className="space-y-1.5">
                  {nsGuideDomain.nameServers.map((ns, idx) => (
                    <div
                      key={ns}
                      className="flex items-center justify-between px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 font-mono"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-400">NS #{idx + 1}</span>
                        <span className="font-semibold text-slate-900 dark:text-white">{ns}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleCopyValue(`ns-modal-${ns}`, ns, 'NS')}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] text-slate-600 dark:text-slate-300 hover:border-blue-500"
                      >
                        {copiedId === `ns-modal-${ns}` ? (
                          <>
                            <Check className="w-3 h-3 text-emerald-600" />
                            {isZh ? '已复制' : 'Copied'}
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            {isZh ? '复制' : 'Copy'}
                          </>
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-500">
                  {isZh
                    ? '该服务商未返回明确 NS 列表，请在服务商控制台查看域名指定 NS。'
                    : 'No nameservers returned by this provider. Check your provider console.'}
                </div>
              )}

              {nsGuideDomain.nsNote && (
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed bg-slate-50 dark:bg-slate-950/60 p-3 rounded-lg border border-slate-200/70 dark:border-slate-800">
                  {nsGuideDomain.nsNote}
                </p>
              )}

              {nsGuideDomain.currentLiveNs && nsGuideDomain.currentLiveNs.length > 0 && (
                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 space-y-1">
                  <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    {isZh ? '当前公网实际解析到的 NS 服务器：' : 'Currently live resolved NS:'}
                  </div>
                  <div className="font-mono text-[11px] text-slate-800 dark:text-slate-200">
                    {nsGuideDomain.currentLiveNs.join(' · ')}
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                disabled={nsCheckBusyId === nsGuideDomain.id}
                onClick={() => void handleCheckDomainNs(nsGuideDomain)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
              >
                {nsCheckBusyId === nsGuideDomain.id ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5" />
                )}
                {isZh ? '立即验证 NS 是否生效' : 'Verify Live NS Now'}
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const key = `${nsGuideDomain.providerId}::${nsGuideDomain.domain.toLowerCase()}`;
                    setNsGuideDomain(null);
                    enterDomain(key);
                  }}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  {isZh ? '进入解析管理' : 'Manage Records'}
                </button>
                <button
                  type="button"
                  onClick={() => setNsGuideDomain(null)}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500"
                >
                  {isZh ? '关闭' : 'Close'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== MODAL 4: DELETE RECORD CONFIRM ==================== */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-red-600 dark:text-red-400">
                {isZh ? '确认删除 DNS 记录' : 'Confirm Delete DNS Record'}
              </h3>
              <button type="button" onClick={() => setDeleteTarget(null)} className="p-1 text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono space-y-1">
              <div className="font-semibold text-slate-900 dark:text-white">
                {deleteTarget.fqdn} · {deleteTarget.type}
              </div>
              <div className="text-slate-600 dark:text-slate-300 break-all">{deleteTarget.content}</div>
            </div>
            {deleteTarget.remoteRecordId && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={deleteRemoteChecked}
                  onChange={(e) => setDeleteRemoteChecked(e.target.checked)}
                  className="rounded accent-red-600"
                />
                {isZh
                  ? '同时调用 DNS 服务商 API 删除远端解析记录'
                  : 'Also delete remote record on DNS provider'}
              </label>
            )}
            {deleteError && (
              <div className="px-3 py-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300">
                {deleteError}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
              >
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                disabled={deleteBusy}
                onClick={() => void handleConfirmDelete()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-700 disabled:opacity-50"
              >
                {deleteBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {isZh ? '确认删除' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
