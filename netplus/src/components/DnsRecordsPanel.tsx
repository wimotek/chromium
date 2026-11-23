import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  CloudDownload,
  Copy,
  Folder,
  Globe,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { apiRequest, formatTimeAgo } from '../lib/api';
import type {
  DnsProvider,
  DnsRecordType,
  LanguageCode,
  ManagedDnsRecord,
} from '../types/models';

interface DnsRecordsPanelProps {
  providers: DnsProvider[];
  records: ManagedDnsRecord[];
  lang: LanguageCode;
  onReload: () => Promise<void>;
  onJumpToProviders: () => void;
  onNotify: (msg: string) => void;
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

export function DnsRecordsPanel({
  providers,
  records,
  lang,
  onReload,
  onJumpToProviders,
  onNotify,
}: DnsRecordsPanelProps) {
  const isZh = lang === 'zh-CN';

  // Filters & search
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [domainFilter, setDomainFilter] = useState<string>('all');
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
  const [pullDomains, setPullDomains] = useState<ProviderDomainItem[]>([]);
  const [pullLoadingDomains, setPullLoadingDomains] = useState(false);
  const [pullDomain, setPullDomain] = useState('');
  const [pullZoneId, setPullZoneId] = useState('');
  const [pullDefaultGroup, setPullDefaultGroup] = useState('');
  const [pullBusy, setPullBusy] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);

  // Add / Edit Record Modal
  const [showRecordModal, setShowRecordModal] = useState(false);
  const [editingRecord, setEditingRecord] = useState<ManagedDnsRecord | null>(null);
  const [formDomains, setFormDomains] = useState<ProviderDomainItem[]>([]);
  const [formLoadingDomains, setFormLoadingDomains] = useState(false);
  const [recordSaving, setRecordSaving] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordForm, setRecordForm] = useState({
    providerId: '',
    domain: '',
    name: '@',
    type: 'A' as DnsRecordType,
    content: '',
    ttl: 300,
    proxied: false,
    priority: 10,
    line: '',
    groupName: isZh ? '默认分组' : 'Default',
    notes: '',
    syncRemote: true,
  });

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

  // Summaries for filter bars
  const groupSummaries = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of records) {
      const g = (r.groupName || '').trim() || (isZh ? '默认分组' : 'Default');
      map.set(g, (map.get(g) ?? 0) + 1);
    }
    return Array.from(map.entries()).map(([name, count]) => ({ name, count }));
  }, [records, isZh]);

  const allGroups = useMemo(() => groupSummaries.map((g) => g.name), [groupSummaries]);

  const allDomains = useMemo(
    () => Array.from(new Set(records.map((r) => r.domain).filter(Boolean))).sort(),
    [records]
  );

  const filteredRecords = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return records.filter((r) => {
      const g = (r.groupName || '').trim() || (isZh ? '默认分组' : 'Default');
      if (groupFilter !== 'all' && g !== groupFilter) return false;
      if (providerFilter !== 'all' && r.providerId !== providerFilter) return false;
      if (domainFilter !== 'all' && r.domain !== domainFilter) return false;
      if (typeFilter !== 'ALL' && r.type !== typeFilter) return false;
      if (!q) return true;
      const prov = providerMap.get(r.providerId);
      return `${r.fqdn} ${r.name} ${r.domain} ${r.type} ${r.content} ${g} ${r.notes || ''} ${prov?.name || ''}`
        .toLowerCase()
        .includes(q);
    });
  }, [records, groupFilter, providerFilter, domainFilter, typeFilter, searchQuery, providerMap, isZh]);

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
    async (
      providerId: string,
      target: 'pull' | 'form',
      forceRefresh = false
    ) => {
      const prov = providerMap.get(providerId);
      if (!prov || !isProviderConfigured(prov)) {
        if (target === 'pull') setPullDomains([]);
        else setFormDomains([]);
        return;
      }
      if (target === 'pull') setPullLoadingDomains(true);
      else setFormLoadingDomains(true);
      try {
        const res = await apiRequest<{
          ok: boolean;
          domains: ProviderDomainItem[];
          error?: string;
        }>(`/api/dns/providers/${encodeURIComponent(providerId)}/domains${forceRefresh ? '?refresh=1' : ''}`);
        const list = res.ok ? res.domains : [];
        if (target === 'pull') {
          setPullDomains(list);
          if (list.length > 0) {
            setPullDomain((prev) => prev || list[0].name);
            setPullZoneId((prev) => prev || list[0].id);
          }
          if (!res.ok && res.error) setPullError(res.error);
        } else {
          setFormDomains(list);
          if (list.length > 0) {
            setRecordForm((prev) => (prev.domain ? prev : { ...prev, domain: list[0].name }));
          }
        }
      } catch (err) {
        if (target === 'pull') {
          setPullDomains([]);
          setPullError(err instanceof Error ? err.message : 'Failed to load domains');
        } else {
          setFormDomains([]);
        }
      } finally {
        if (target === 'pull') setPullLoadingDomains(false);
        else setFormLoadingDomains(false);
      }
    },
    [providerMap]
  );

  // Open Pull Modal
  const openPullModal = () => {
    setPullError(null);
    setPullDomains([]);
    setPullDomain('');
    setPullZoneId('');
    setPullDefaultGroup('');
    const first = pullSupportedProviders[0] ?? configuredProviders[0];
    const pid = first?.id || '';
    setPullProviderId(pid);
    setShowPullModal(true);
    if (pid) {
      void fetchDomainsForProvider(pid, 'pull');
    }
  };

  const handlePullRecords = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pullProviderId || !pullDomain.trim()) {
      setPullError(isZh ? '请选择 DNS 服务商并填写/选择主域名' : 'Select provider and domain');
      return;
    }
    setPullBusy(true);
    setPullError(null);
    try {
      const matched = pullDomains.find((d) => d.name.toLowerCase() === pullDomain.trim().toLowerCase());
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
          domain: pullDomain.trim(),
          zoneId: matched?.id || pullZoneId || undefined,
          defaultGroupName: pullDefaultGroup.trim() || undefined,
        }),
      });
      setShowPullModal(false);
      await onReload();
      onNotify(
        isZh
          ? `已从服务商同步 ${pullDomain.trim()}：共 ${res.total} 条记录（新增 ${res.addedCount}，更新 ${res.updatedCount}，清理失效 ${res.removedCount}）`
          : `Synced ${res.total} DNS records for ${pullDomain.trim()} (+${res.addedCount}, ~${res.updatedCount}, -${res.removedCount})`
      );
    } catch (err) {
      setPullError(err instanceof Error ? err.message : 'Pull DNS records failed');
    } finally {
      setPullBusy(false);
    }
  };

  // Open Create / Edit Record Modal
  const openCreateRecordModal = () => {
    setEditingRecord(null);
    setRecordError(null);
    setFormDomains([]);
    const defaultProv = configuredProviders[0] ?? providers[0];
    const pid = defaultProv?.id || '';
    setRecordForm({
      providerId: pid,
      domain: domainFilter !== 'all' ? domainFilter : '',
      name: '@',
      type: 'A',
      content: '',
      ttl: 300,
      proxied: false,
      priority: 10,
      line: defaultProv?.type === 'dnspod' ? '默认' : '',
      groupName: groupFilter !== 'all' ? groupFilter : isZh ? '默认分组' : 'Default',
      notes: '',
      syncRemote: isProviderConfigured(defaultProv),
    });
    setShowRecordModal(true);
    if (pid) {
      void fetchDomainsForProvider(pid, 'form');
    }
  };

  const openEditRecordModal = (rec: ManagedDnsRecord) => {
    setEditingRecord(rec);
    setRecordError(null);
    setFormDomains([]);
    const prov = providerMap.get(rec.providerId);
    setRecordForm({
      providerId: rec.providerId,
      domain: rec.domain,
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
    setShowRecordModal(true);
  };

  useEffect(() => {
    if (showRecordModal && !editingRecord && recordForm.providerId) {
      void fetchDomainsForProvider(recordForm.providerId, 'form');
    }
  }, [showRecordModal, editingRecord, recordForm.providerId, fetchDomainsForProvider]);

  const handleSaveRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    setRecordSaving(true);
    setRecordError(null);
    try {
      const payload = {
        providerId: recordForm.providerId,
        domain: recordForm.domain.trim(),
        name: recordForm.name.trim() || '@',
        type: recordForm.type,
        content: recordForm.content.trim(),
        ttl: Number(recordForm.ttl) || 300,
        proxied: recordForm.proxied,
        priority:
          recordForm.type === 'MX' || recordForm.type === 'SRV'
            ? Number(recordForm.priority) || 10
            : undefined,
        line: recordForm.line.trim() || undefined,
        groupName: recordForm.groupName.trim() || (isZh ? '默认分组' : 'Default'),
        notes: recordForm.notes.trim() || undefined,
        syncRemote: recordForm.syncRemote,
      };

      if (editingRecord) {
        const res = await apiRequest<{ record: ManagedDnsRecord; message: string }>(
          `/api/dns/records/${editingRecord.id}`,
          { method: 'PUT', body: JSON.stringify(payload) }
        );
        onNotify(`${res.record.fqdn} (${res.record.type})：${res.message}`);
      } else {
        const res = await apiRequest<{ record: ManagedDnsRecord; message: string }>(
          '/api/dns/records',
          { method: 'POST', body: JSON.stringify(payload) }
        );
        onNotify(`${res.record.fqdn} (${res.record.type})：${res.message}`);
      }
      setShowRecordModal(false);
      await onReload();
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : 'Save record failed');
    } finally {
      setRecordSaving(false);
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
          : `Moved ${res.updatedCount} record(s) to group "${res.groupName}"`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Batch group move failed');
    } finally {
      setBatchBusy(false);
    }
  };

  const handleCopyContent = (rec: ManagedDnsRecord) => {
    void navigator.clipboard?.writeText(rec.content);
    setCopiedId(rec.id);
    setTimeout(() => setCopiedId((prev) => (prev === rec.id ? null : prev)), 1500);
  };

  const selectedFormProvider = providerMap.get(recordForm.providerId);

  return (
    <div className="space-y-4">
      {/* Top Action & Filter Card */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3.5">
        {/* Row 1: Group Filter Bar + Action Buttons */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400 mr-1 whitespace-nowrap">
              <Folder className="w-3.5 h-3.5" />
              {isZh ? '分组筛选:' : 'Groups:'}
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
              {isZh ? '全部分组' : 'All'} ({records.length})
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

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={openPullModal}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <CloudDownload className="w-3.5 h-3.5" />
              {isZh ? '从服务商同步读取' : 'Pull from Provider'}
            </button>
            <button
              type="button"
              onClick={openCreateRecordModal}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              {isZh ? '手动添加记录' : 'Add Record'}
            </button>
          </div>
        </div>

        {/* Row 2: Search + Provider / Domain / Type Dropdown Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-2.5 text-xs pt-2 border-t border-slate-100 dark:border-slate-800/80">
          <div className="lg:col-span-5 relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                isZh
                  ? '查找主机记录、域名、记录值、分组、备注...'
                  : 'Search FQDN, domain, value, group, notes...'
              }
              className="w-full pl-8 pr-8 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="lg:col-span-3">
            <select
              aria-label={isZh ? '筛选 DNS 服务商' : 'Filter provider'}
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200"
            >
              <option value="all">{isZh ? '全部 DNS 服务商' : 'All Providers'}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.type})
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-2">
            <select
              aria-label={isZh ? '筛选主域名' : 'Filter domain'}
              value={domainFilter}
              onChange={(e) => setDomainFilter(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 font-mono"
            >
              <option value="all">{isZh ? '全部主域名' : 'All Domains'}</option>
              {allDomains.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-2">
            <select
              aria-label={isZh ? '筛选记录类型' : 'Filter record type'}
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 font-mono"
            >
              <option value="ALL">{isZh ? '全部记录类型' : 'All Types'}</option>
              {RECORD_TYPES.map((rt) => (
                <option key={rt} value={rt}>
                  {rt}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Batch Group Move Toolbar (shown when rows selected) */}
        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/30 text-xs">
            <span className="font-medium text-blue-800 dark:text-blue-200 tabular-nums">
              {isZh ? `已选中 ${selectedIds.size} 条 DNS 记录` : `${selectedIds.size} record(s) selected`}
            </span>
            <div className="flex items-center gap-2">
              <input
                list="dns-record-group-options"
                value={batchGroupTarget}
                onChange={(e) => setBatchGroupTarget(e.target.value)}
                placeholder={isZh ? '输入或选择目标分组...' : 'Target group...'}
                className="px-2.5 py-1 rounded-md border border-blue-200 dark:border-blue-800 bg-white dark:bg-slate-900 text-xs w-40"
              />
              <button
                type="button"
                disabled={batchBusy || !batchGroupTarget.trim()}
                onClick={() => void handleBatchGroupMove()}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-md bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
              >
                {batchBusy && <Loader2 className="w-3 h-3 animate-spin" />}
                {isZh ? '批量归入分组' : 'Move to Group'}
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
              >
                {isZh ? '取消选择' : 'Clear'}
              </button>
            </div>
          </div>
        )}
      </div>

      <datalist id="dns-record-group-options">
        {allGroups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>

      {/* Records Data Grid */}
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
                  {isZh ? '主机记录 / 域名' : 'Host / Domain'}
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
                  {isZh ? '同步状态' : 'Sync'}
                </th>
                <th className="py-3 px-4 font-medium text-right whitespace-nowrap">
                  {isZh ? '操作' : 'Actions'}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70 text-xs">
              {filteredRecords.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 px-4 text-center">
                    <div className="max-w-md mx-auto space-y-3">
                      <Globe className="w-7 h-7 text-slate-300 dark:text-slate-600 mx-auto" />
                      <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                        {records.length === 0
                          ? isZh
                            ? '尚未添加或同步任何域名 DNS 记录'
                            : 'No DNS records yet'
                          : isZh
                            ? '当前筛选条件下没有匹配的 DNS 记录'
                            : 'No DNS records match your current filters'}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {isZh
                          ? '可一键从 Cloudflare、DNSPod、阿里云 DNS 或 Porkbun 拉取线上全部解析记录，或手动添加新记录并按分组归类管理。'
                          : 'Pull live DNS records directly from Cloudflare, DNSPod, Aliyun DNS, or Porkbun, or create a manual record.'}
                      </p>
                      <div className="flex items-center justify-center gap-2 pt-1">
                        {(groupFilter !== 'all' ||
                          providerFilter !== 'all' ||
                          domainFilter !== 'all' ||
                          typeFilter !== 'ALL' ||
                          searchQuery) && (
                          <button
                            type="button"
                            onClick={() => {
                              setGroupFilter('all');
                              setProviderFilter('all');
                              setDomainFilter('all');
                              setTypeFilter('ALL');
                              setSearchQuery('');
                            }}
                            className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium"
                          >
                            {isZh ? '重置筛选' : 'Reset Filters'}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={openPullModal}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
                        >
                          <CloudDownload className="w-3.5 h-3.5" />
                          {isZh ? '从服务商同步读取' : 'Pull from Provider'}
                        </button>
                        <button
                          type="button"
                          onClick={openCreateRecordModal}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          {isZh ? '手动添加记录' : 'Add Record'}
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredRecords.map((rec) => {
                  const prov = providerMap.get(rec.providerId);
                  return (
                    <tr
                      key={rec.id}
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
                      <td className="py-3 px-4 align-middle min-w-[200px]">
                        <div className="font-mono font-semibold text-slate-900 dark:text-white">
                          {rec.fqdn}
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                          {prov ? `${prov.name} (${prov.type})` : rec.providerId}
                          {rec.notes ? ` · ${rec.notes}` : ''}
                        </div>
                      </td>
                      <td className="py-3 px-3 align-middle whitespace-nowrap">
                        <span className={`font-mono font-bold text-xs ${recordTypeTextColor(rec.type)}`}>
                          {rec.type}
                        </span>
                      </td>
                      <td className="py-3 px-4 align-middle max-w-[280px]">
                        <div className="flex items-center gap-1.5 group">
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
                            onClick={() => handleCopyContent(rec)}
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
                                : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {rec.syncState === 'synced'
                            ? isZh
                              ? '远端已同步'
                              : 'Synced'
                            : rec.syncState === 'error'
                              ? isZh
                                ? '同步异常'
                                : 'Error'
                              : isZh
                                ? '本地记录'
                                : 'Local'}
                        </div>
                        {rec.lastSyncedAt && (
                          <div className="text-[10px] font-mono text-slate-400 tabular-nums">
                            {formatTimeAgo(rec.lastSyncedAt)}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 align-middle text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEditRecordModal(rec)}
                            title={isZh ? '修改记录' : 'Edit record'}
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

      {/* ==================== MODAL 1: PULL LIVE RECORDS FROM PROVIDER ==================== */}
      {showPullModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <div>
                <h3 className="font-display text-lg font-semibold">
                  {isZh ? '从 DNS 服务商同步读取记录' : 'Pull Live DNS Records'}
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {isZh
                    ? '支持 Cloudflare、DNSPod、阿里云 DNS、Porkbun 实时读取线上全量记录（重复同步保留本地分组与备注）'
                    : 'Pull live records from Cloudflare, DNSPod, Aliyun DNS, or Porkbun.'}
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
                  <div className="px-3 py-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300">
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
                        void fetchDomainsForProvider(pid, 'pull');
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
                      onClick={() => void fetchDomainsForProvider(pullProviderId, 'pull', true)}
                      title={isZh ? '刷新域名列表' : 'Refresh domains'}
                      className="px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${pullLoadingDomains ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                </div>

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

                <div>
                  <label className="block font-medium mb-1">
                    {isZh ? '新拉取记录的默认分组（可选）' : 'Default Group for New Records (Optional)'}
                  </label>
                  <input
                    list="dns-record-group-options"
                    value={pullDefaultGroup}
                    onChange={(e) => setPullDefaultGroup(e.target.value)}
                    placeholder={pullDomain || (isZh ? '留空则默认使用域名作为分组' : 'Defaults to domain name')}
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
                    {isZh ? '立即同步读取' : 'Pull Records'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* ==================== MODAL 2: ADD / EDIT DNS RECORD ==================== */}
      {showRecordModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-display text-lg font-semibold">
                {editingRecord
                  ? isZh
                    ? `修改 DNS 记录 — ${editingRecord.fqdn}`
                    : `Edit DNS Record — ${editingRecord.fqdn}`
                  : isZh
                    ? '手动添加域名 DNS 记录'
                    : 'Add DNS Record'}
              </h3>
              <button type="button" onClick={() => setShowRecordModal(false)} className="p-1 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveRecord} className="mt-4 space-y-4 text-xs">
              {recordError && (
                <div className="px-3 py-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300">
                  {recordError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block font-medium mb-1">{isZh ? 'DNS 服务商 *' : 'DNS Provider *'}</label>
                  <select
                    required
                    value={recordForm.providerId}
                    onChange={(e) => {
                      const nextPid = e.target.value;
                      const nextProv = providerMap.get(nextPid);
                      setRecordForm((prev) => ({
                        ...prev,
                        providerId: nextPid,
                        line: nextProv?.type === 'dnspod' ? prev.line || '默认' : prev.line,
                        syncRemote: isProviderConfigured(nextProv),
                      }));
                    }}
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
                    {isZh ? '主域名 *' : 'Root Domain *'}
                    {formLoadingDomains && (
                      <span className="ml-1.5 text-[10px] text-blue-600">
                        {isZh ? '加载中...' : 'Loading...'}
                      </span>
                    )}
                  </label>
                  <input
                    required
                    list="dns-form-domain-suggestions"
                    value={recordForm.domain}
                    onChange={(e) => setRecordForm({ ...recordForm, domain: e.target.value })}
                    placeholder="example.com"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                  />
                  <datalist id="dns-form-domain-suggestions">
                    {Array.from(new Set([...formDomains.map((d) => d.name), ...allDomains])).map((d) => (
                      <option key={d} value={d} />
                    ))}
                  </datalist>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                <div>
                  <label className="block font-medium mb-1">{isZh ? '记录类型 *' : 'Record Type *'}</label>
                  <select
                    value={recordForm.type}
                    onChange={(e) => setRecordForm({ ...recordForm, type: e.target.value as DnsRecordType })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono font-semibold"
                  >
                    {RECORD_TYPES.map((rt) => (
                      <option key={rt} value={rt}>
                        {rt}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="block font-medium mb-1">{isZh ? '主机记录（@ 为根域名）*' : 'Host Name *'}</label>
                  <input
                    required
                    value={recordForm.name}
                    onChange={(e) => setRecordForm({ ...recordForm, name: e.target.value })}
                    placeholder="@ / www / api / _acme-challenge"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block font-medium mb-1">{isZh ? '记录值 *' : 'Value / Content *'}</label>
                <input
                  required
                  value={recordForm.content}
                  onChange={(e) => setRecordForm({ ...recordForm, content: e.target.value })}
                  placeholder={contentPlaceholder(recordForm.type, isZh)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3.5">
                <div>
                  <label className="block font-medium mb-1">TTL (s)</label>
                  <input
                    type="number"
                    min={1}
                    max={86400}
                    value={recordForm.ttl}
                    onChange={(e) => setRecordForm({ ...recordForm, ttl: Number(e.target.value) || 300 })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                  />
                </div>

                {(recordForm.type === 'MX' || recordForm.type === 'SRV') && (
                  <div>
                    <label className="block font-medium mb-1">{isZh ? '优先级 (MX/SRV)' : 'Priority'}</label>
                    <input
                      type="number"
                      min={0}
                      max={65535}
                      value={recordForm.priority}
                      onChange={(e) => setRecordForm({ ...recordForm, priority: Number(e.target.value) || 10 })}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                    />
                  </div>
                )}

                {(selectedFormProvider?.type === 'dnspod' || selectedFormProvider?.type === 'aliyun') && (
                  <div>
                    <label className="block font-medium mb-1">{isZh ? '解析线路' : 'Route / Line'}</label>
                    <input
                      value={recordForm.line}
                      onChange={(e) => setRecordForm({ ...recordForm, line: e.target.value })}
                      placeholder={selectedFormProvider.type === 'dnspod' ? '默认' : 'default'}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    />
                  </div>
                )}

                <div>
                  <label className="block font-medium mb-1">{isZh ? '自定义分组 *' : 'Group *'}</label>
                  <input
                    required
                    list="dns-record-group-options"
                    value={recordForm.groupName}
                    onChange={(e) => setRecordForm({ ...recordForm, groupName: e.target.value })}
                    placeholder={isZh ? '如：边缘节点 / 业务入口' : 'e.g. Edge Nodes'}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
              </div>

              <div>
                <label className="block font-medium mb-1">{isZh ? '备注（可选）' : 'Notes (Optional)'}</label>
                <input
                  value={recordForm.notes}
                  onChange={(e) => setRecordForm({ ...recordForm, notes: e.target.value })}
                  placeholder={isZh ? '用途说明或关联业务' : 'Purpose or environment note'}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </div>

              <div className="space-y-2 pt-1">
                {selectedFormProvider?.type === 'cloudflare' &&
                  (recordForm.type === 'A' || recordForm.type === 'AAAA' || recordForm.type === 'CNAME') && (
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={recordForm.proxied}
                        onChange={(e) => setRecordForm({ ...recordForm, proxied: e.target.checked })}
                        className="rounded accent-blue-600"
                      />
                      {isZh ? '开启 Cloudflare CDN 代理 (Proxied)' : 'Enable Cloudflare Proxy'}
                    </label>
                  )}

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={recordForm.syncRemote}
                    onChange={(e) => setRecordForm({ ...recordForm, syncRemote: e.target.checked })}
                    className="rounded accent-blue-600"
                  />
                  {isProviderConfigured(selectedFormProvider)
                    ? isZh
                      ? '同时推送同步到 DNS 服务商远端（实时生效）'
                      : 'Push changes live to DNS provider'
                    : isZh
                      ? '服务商未配置 API 密钥，将仅保存至本地记录库'
                      : 'Provider has no API secret; will save locally'}
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowRecordModal(false)}
                  className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  {isZh ? '取消' : 'Cancel'}
                </button>
                <button
                  type="submit"
                  disabled={recordSaving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
                >
                  {recordSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {isZh ? '保存记录' : 'Save Record'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================== MODAL 3: DELETE RECORD CONFIRM ==================== */}
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
