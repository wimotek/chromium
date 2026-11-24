import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  KeyRound,
  Loader2,
  Pencil,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { translate, type TranslationKeys } from '../i18n/translations';
import { apiRequest, formatTimeAgo } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { toast } from '../lib/toast';
import type {
  CloudHost,
  DnsIpv6Target,
  DnsProvider,
  DnsProviderType,
  DnsSyncRule,
  DnsZoneSummary,
  LanguageCode,
  ManagedDnsRecord,
  ManagedDomain,
} from '../types/models';
import { DnsRecordsPanel } from './DnsRecordsPanel';

interface DnsBatchViewProps {
  providers: DnsProvider[];
  rules: DnsSyncRule[];
  records: ManagedDnsRecord[];
  managedDomains: ManagedDomain[];
  hosts: CloudHost[];
  lang: LanguageCode;
  onReload: () => Promise<void>;
}

const PROVIDER_TYPES: Array<{
  value: DnsProviderType;
  label: string;
  needsSecretId: boolean;
  secretIdLabel: string;
  secretLabel: string;
}> = [
  {
    value: 'cloudflare',
    label: 'Cloudflare',
    needsSecretId: false,
    secretIdLabel: '',
    secretLabel: 'API Token (Zone:Read + DNS:Edit)',
  },
  {
    value: 'dnspod',
    label: 'DNSPod (Tencent)',
    needsSecretId: true,
    secretIdLabel: 'Token ID',
    secretLabel: 'Token Secret',
  },
  {
    value: 'aliyun',
    label: 'Aliyun DNS',
    needsSecretId: true,
    secretIdLabel: 'AccessKey ID',
    secretLabel: 'AccessKey Secret',
  },
  {
    value: 'porkbun',
    label: 'Porkbun',
    needsSecretId: true,
    secretIdLabel: 'API Key',
    secretLabel: 'Secret API Key',
  },
  {
    value: 'route53',
    label: 'AWS Route 53',
    needsSecretId: true,
    secretIdLabel: 'Access Key ID',
    secretLabel: 'Secret Access Key',
  },
  {
    value: 'huawei',
    label: 'Huawei Cloud DNS',
    needsSecretId: true,
    secretIdLabel: 'AK (Access Key)',
    secretLabel: 'SK (Secret Key)',
  },
  {
    value: 'namecheap',
    label: 'Namecheap',
    needsSecretId: true,
    secretIdLabel: 'API Username',
    secretLabel: 'API Key',
  },
  {
    value: 'webhook',
    label: 'Custom Webhook',
    needsSecretId: false,
    secretIdLabel: '',
    secretLabel: 'HMAC Secret (Optional)',
  },
];

function isProviderConfigured(p: DnsProvider): boolean {
  if (p.type === 'webhook') return Boolean(p.endpointUrl);
  return p.hasSecret;
}

export function DnsBatchView({ providers, rules, records, managedDomains, hosts, lang, onReload }: DnsBatchViewProps) {
  const t = (key: TranslationKeys) => translate(lang, key);
  const isZh = lang === 'zh-CN';
  const [subTab, setSubTab] = useState<'records' | 'providers' | 'rules'>('records');
  const [selectedRuleIds, setSelectedRuleIds] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncingRuleId, setSyncingRuleId] = useState<string | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);
  const [savingRule, setSavingRule] = useState(false);
  const [detectingIp, setDetectingIp] = useState(false);
  const [detectedIps, setDetectedIps] = useState<{
    ipv4: string | null;
    ipv6: string | null;
    ipv6List: string[];
    ipv6Source?: 'interface_and_egress' | 'egress' | 'interface' | 'cloud_host' | 'none';
    ipv6SourceLabel?: string;
    ipv6Hint?: string;
  } | null>(null);
  const [expandDetectedV6, setExpandDetectedV6] = useState(false);
  const [showDetectedPopover, setShowDetectedPopover] = useState(false);
  const [copiedIpKey, setCopiedIpKey] = useState<string | null>(null);
  const [expandedRuleV6Ids, setExpandedRuleV6Ids] = useState<Set<string>>(new Set());

  // Provider Modal State (simplified: reusable account credentials, no per-domain/ZoneID clutter)
  const [editingProvider, setEditingProvider] = useState<DnsProvider | null>(null);
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [provForm, setProvForm] = useState({
    name: '',
    type: 'cloudflare' as DnsProviderType,
    accountEmail: '',
    endpointUrl: '',
    secretId: '',
    secret: '',
  });

  // Rule Modal State
  const [editingRule, setEditingRule] = useState<DnsSyncRule | null>(null);
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [bulkIpv6Text, setBulkIpv6Text] = useState('');
  const [cfZones, setCfZones] = useState<DnsZoneSummary[]>([]);
  const [loadingZones, setLoadingZones] = useState(false);
  const [zonesError, setZonesError] = useState<string | null>(null);
  const [ruleForm, setRuleForm] = useState({
    name: '',
    providerId: '',
    domain: '',
    resolvedZoneId: '',
    recordName: '@',
    ttl: 120,
    proxied: false,
    line: 'default',
    syncIpv4: true,
    ipv4Address: '',
    ipv4Source: 'manual' as 'manual' | 'auto_public' | 'cloud_host',
    syncIpv6: true,
    ipv6Mode: 'round_robin' as 'round_robin' | 'per_host',
    ipv6Targets: [] as DnsIpv6Target[],
    linkedHostId: '',
    dryRun: false,
    enabled: true,
  });

  const providerMap = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers]);
  const configuredProviders = useMemo(
    () => providers.filter(isProviderConfigured),
    [providers]
  );

  const selectedProvider = providerMap.get(ruleForm.providerId);
  const selectedProviderMeta =
    PROVIDER_TYPES.find((pt) => pt.value === provForm.type) ?? PROVIDER_TYPES[0];

  const showNotice = (msg: string, kind: 'success' | 'error' | 'info' | 'warning' = 'success') => {
    toast.show(msg, kind);
  };

  // Auto-load provider domains whenever a configured provider is chosen in the rule modal (Cloudflare / DNSPod / Aliyun / Porkbun)
  const fetchZonesForProvider = useCallback(
    async (providerId: string, forceRefresh = false) => {
      const prov = providerMap.get(providerId);
      if (
        !prov ||
        !prov.hasSecret ||
        !['cloudflare', 'dnspod', 'aliyun', 'porkbun'].includes(prov.type)
      ) {
        setCfZones([]);
        setZonesError(null);
        return;
      }
      setLoadingZones(true);
      setZonesError(null);
      try {
        const res = await apiRequest<{
          ok: boolean;
          domains?: Array<{ id: string; name: string; status?: string }>;
          error?: string;
        }>(`/api/dns/providers/${encodeURIComponent(providerId)}/domains${forceRefresh ? '?refresh=1' : ''}`);
        if (res.ok && Array.isArray(res.domains)) {
          const zones: DnsZoneSummary[] = res.domains.map((d) => ({
            id: d.id,
            name: d.name,
            status: d.status || 'active',
          }));
          setCfZones(zones);
          setZonesError(null);
          // Auto-select first domain if domain is currently empty
          setRuleForm((prev) => {
            if (prev.providerId !== providerId) return prev;
            if (!prev.domain && zones.length > 0) {
              return {
                ...prev,
                domain: zones[0].name,
                resolvedZoneId: prov.type === 'cloudflare' ? zones[0].id : '',
              };
            }
            const matched = zones.find(
              (z) =>
                prev.domain.toLowerCase() === z.name.toLowerCase() ||
                prev.domain.toLowerCase().endsWith(`.${z.name.toLowerCase()}`)
            );
            return matched && prov.type === 'cloudflare' ? { ...prev, resolvedZoneId: matched.id } : prev;
          });
        } else {
          setCfZones([]);
          setZonesError(res.error || 'Failed to fetch provider domains');
        }
      } catch (err) {
        setCfZones([]);
        setZonesError(err instanceof Error ? err.message : 'Failed to fetch provider domains');
      } finally {
        setLoadingZones(false);
      }
    },
    [providerMap]
  );

  useEffect(() => {
    if (showRuleModal && ruleForm.providerId) {
      void fetchZonesForProvider(ruleForm.providerId, false);
    }
  }, [showRuleModal, ruleForm.providerId, fetchZonesForProvider]);

  const handleToggleSelect = (id: string) => {
    setSelectedRuleIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleBatchSync = async (ids?: string[]) => {
    setSyncing(true);
    setSyncingRuleId(ids && ids.length === 1 ? ids[0] : null);
    try {
      const res = await apiRequest<{ reports: Array<{ ruleName: string; status: string }> }>('/api/dns/sync', {
        method: 'POST',
        body: JSON.stringify(ids && ids.length > 0 ? { ruleIds: ids } : {}),
      });
      await onReload();
      if (res.reports.length === 0) {
        showNotice(isZh ? '暂无可执行的启用 DNS 规则' : 'No enabled DNS rules to sync', 'info');
      } else {
        const failed = res.reports.filter((r) => r.status === 'failed').length;
        showNotice(
          isZh
            ? failed > 0
              ? `已完成 ${res.reports.length} 条 DNS 规则同步（其中 ${failed} 条失败）`
              : `已完成 ${res.reports.length} 条 DNS 规则批量同步`
            : failed > 0
              ? `Processed ${res.reports.length} DNS rule(s) (${failed} failed)`
              : `Processed ${res.reports.length} DNS rule(s)`,
          failed > 0 ? 'warning' : 'success'
        );
      }
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? 'DNS 同步失败' : 'Sync failed', 'error');
    } finally {
      setSyncing(false);
      setSyncingRuleId(null);
    }
  };

  const handleDetectIp = async () => {
    setDetectingIp(true);
    setExpandDetectedV6(false);
    try {
      const res = await apiRequest<{
        ipv4: string | null;
        ipv6: string | null;
        ipv6List?: string[];
        ipv6Source?: 'interface_and_egress' | 'egress' | 'interface' | 'cloud_host' | 'none';
        ipv6SourceLabel?: string;
        ipv6Hint?: string;
      }>('/api/dns/detect-ip');
      const v6List = Array.isArray(res.ipv6List)
        ? res.ipv6List
        : res.ipv6
        ? [res.ipv6]
        : [];
      setDetectedIps({
        ipv4: res.ipv4 ?? null,
        ipv6: res.ipv6 ?? v6List[0] ?? null,
        ipv6List: v6List,
        ipv6Source: res.ipv6Source,
        ipv6SourceLabel: res.ipv6SourceLabel,
        ipv6Hint: res.ipv6Hint,
      });
      setShowDetectedPopover(true);
      showNotice(
        isZh
          ? `探测完成：IPv4 ${res.ipv4 ?? '未探测到'} · IPv6 ${v6List.length > 0 ? `共 ${v6List.length} 个` : '未探测到'}`
          : `Detected IPv4: ${res.ipv4 ?? 'n/a'} · IPv6: ${v6List.length} address(es)`,
        res.ipv4 || v6List.length > 0 ? 'success' : 'warning'
      );
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? '探测公网 IP 失败' : 'Public IP detection failed', 'error');
    } finally {
      setDetectingIp(false);
    }
  };

  const handleCopyDetected = async (key: string, value: string) => {
    const ok = await copyText(value);
    if (ok) {
      setCopiedIpKey(key);
      setTimeout(() => setCopiedIpKey((prev) => (prev === key ? null : prev)), 1800);
      showNotice(isZh ? '已复制到剪贴板' : 'Copied to clipboard', 'success');
    } else {
      showNotice(isZh ? '复制失败，请手动选中复制' : 'Clipboard copy failed', 'error');
    }
  };

  const jumpToProviderSetup = (providerToEdit?: DnsProvider) => {
    setShowRuleModal(false);
    setSubTab('providers');
    if (providerToEdit) {
      openEditProvider(providerToEdit);
    } else {
      openNewProvider();
    }
  };

  const openNewProvider = () => {
    setEditingProvider(null);
    setProvForm({
      name: 'Cloudflare',
      type: 'cloudflare',
      accountEmail: '',
      endpointUrl: '',
      secretId: '',
      secret: '',
    });
    setShowProviderModal(true);
  };

  const openEditProvider = (p: DnsProvider) => {
    setEditingProvider(p);
    setProvForm({
      name: p.name,
      type: p.type,
      accountEmail: p.accountEmail ?? '',
      endpointUrl: p.endpointUrl ?? '',
      secretId: '',
      secret: '',
    });
    setShowProviderModal(true);
  };

  const handleSaveProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProvider(true);
    try {
      if (editingProvider) {
        await apiRequest(`/api/dns/providers/${editingProvider.id}`, {
          method: 'PUT',
          body: JSON.stringify(provForm),
        });
      } else {
        await apiRequest('/api/dns/providers', {
          method: 'POST',
          body: JSON.stringify(provForm),
        });
      }
      setShowProviderModal(false);
      await onReload();
      showNotice(t('savedSuccessfully'), 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Failed to save provider', 'error');
    } finally {
      setSavingProvider(false);
    }
  };

  const handleDeleteProvider = async (id: string) => {
    try {
      await apiRequest(`/api/dns/providers/${id}`, { method: 'DELETE' });
      await onReload();
      showNotice(isZh ? '已删除 DNS 服务商' : 'Deleted DNS provider', 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? '删除失败' : 'Delete failed', 'error');
    }
  };

  const openNewRule = () => {
    const firstReady = configuredProviders[0];
    setEditingRule(null);
    setBulkIpv6Text('');
    setCfZones([]);
    setZonesError(null);
    setRuleForm({
      name: '',
      providerId: firstReady?.id ?? '',
      domain: firstReady?.domain ?? '',
      resolvedZoneId: '',
      recordName: 'edge',
      ttl: 120,
      proxied: false,
      line: firstReady?.type === 'dnspod' ? '默认' : 'default',
      syncIpv4: true,
      ipv4Address: detectedIps?.ipv4 ?? '',
      ipv4Source: 'manual',
      syncIpv6: true,
      ipv6Mode: 'round_robin',
      ipv6Targets:
        detectedIps && detectedIps.ipv6List.length > 0
          ? detectedIps.ipv6List.map((addr, idx) => ({
              id: `tmp-${idx + 1}`,
              recordName: 'edge',
              address: addr,
              enabled: true,
            }))
          : [],
      linkedHostId: '',
      dryRun: !firstReady,
      enabled: true,
    });
    setShowRuleModal(true);
  };

  const openEditRule = (r: DnsSyncRule) => {
    setEditingRule(r);
    setBulkIpv6Text('');
    setCfZones([]);
    setZonesError(null);
    setRuleForm({
      name: r.name,
      providerId: r.providerId,
      domain: r.domain,
      resolvedZoneId: r.resolvedZoneId ?? '',
      recordName: r.recordName,
      ttl: r.ttl,
      proxied: r.proxied,
      line: r.line,
      syncIpv4: r.syncIpv4,
      ipv4Address: r.ipv4Address,
      ipv4Source: r.ipv4Source,
      syncIpv6: r.syncIpv6,
      ipv6Mode: r.ipv6Mode,
      ipv6Targets: r.ipv6Targets.map((item) => ({ ...item })),
      linkedHostId: r.linkedHostId ?? '',
      dryRun: r.dryRun,
      enabled: r.enabled,
    });
    setShowRuleModal(true);
  };

  const handleApplyBulkIpv6 = () => {
    const lines = bulkIpv6Text
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      showNotice(isZh ? '请先在输入框中粘贴至少一个 IPv6 地址' : 'Paste at least one IPv6 address first', 'warning');
      return;
    }

    const appended: DnsIpv6Target[] = lines.map((addr, idx) => ({
      id: `v6-new-${Date.now()}-${idx}`,
      recordName:
        ruleForm.ipv6Mode === 'round_robin'
          ? ruleForm.recordName
          : `v6-${ruleForm.ipv6Targets.length + idx + 1}.${ruleForm.recordName}`,
      address: addr,
      proxied: ruleForm.proxied,
      enabled: true,
    }));

    setRuleForm((prev) => ({
      ...prev,
      ipv6Targets: [...prev.ipv6Targets, ...appended],
    }));
    setBulkIpv6Text('');
    showNotice(
      isZh ? `已批量追加 ${appended.length} 个 IPv6 目标` : `Added ${appended.length} IPv6 target(s)`,
      'success'
    );
  };

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingRule(true);
    try {
      if (editingRule) {
        await apiRequest(`/api/dns/rules/${editingRule.id}`, {
          method: 'PUT',
          body: JSON.stringify(ruleForm),
        });
      } else {
        await apiRequest('/api/dns/rules', {
          method: 'POST',
          body: JSON.stringify(ruleForm),
        });
      }
      setShowRuleModal(false);
      await onReload();
      showNotice(t('savedSuccessfully'), 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Failed to save rule', 'error');
    } finally {
      setSavingRule(false);
    }
  };

  const handleDeleteRule = async (id: string) => {
    try {
      await apiRequest(`/api/dns/rules/${id}`, { method: 'DELETE' });
      setSelectedRuleIds((prev) => prev.filter((x) => x !== id));
      await onReload();
      showNotice(isZh ? '已删除 DNS 同步规则' : 'Deleted DNS sync rule', 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? '删除规则失败' : 'Delete failed', 'error');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t('dnsTitle')}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {t('dnsSubtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <div className="relative">
            <button
              type="button"
              disabled={detectingIp}
              onClick={() => void handleDetectIp()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {detectingIp ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radar className="w-3.5 h-3.5" />}
              {t('detectPublicIp')}
            </button>

            {/* Floating Detected Public IP Popover (never shifts tabs or tables below) */}
            {detectedIps && showDetectedPopover && (
              <>
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setShowDetectedPopover(false)}
                  aria-hidden="true"
                />
                <div className="fixed sm:absolute right-4 sm:right-0 top-20 sm:top-full sm:mt-2 z-40 w-[min(92vw,540px)] max-h-[70vh] overflow-y-auto px-4 py-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl text-xs space-y-2.5">
                  <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-100 dark:border-slate-800">
                    <span className="font-semibold text-slate-900 dark:text-white">
                      {isZh ? '本机公网 IP 探测结果' : 'Detected Public IPs'}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={detectingIp}
                        onClick={() => void handleDetectIp()}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3 h-3 ${detectingIp ? 'animate-spin' : ''}`} />
                        {isZh ? '重新探测' : 'Re-detect'}
                      </button>
                      {detectedIps.ipv6List.length > 1 && (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleCopyDetected('v6-all', detectedIps.ipv6List.join('\n'))}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                          >
                            {copiedIpKey === 'v6-all' ? (
                              <Check className="w-3 h-3 text-emerald-500" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                            {isZh ? '复制全部 IPv6' : 'Copy All IPv6'}
                          </button>
                          {detectedIps.ipv6List.length > 4 && (
                            <button
                              type="button"
                              onClick={() => setExpandDetectedV6((v) => !v)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-[11px] text-blue-600 dark:text-blue-400 hover:bg-slate-50 dark:hover:bg-slate-800"
                            >
                              {expandDetectedV6 ? (
                                <>
                                  <ChevronUp className="w-3 h-3" />
                                  {isZh ? '收起' : 'Collapse'}
                                </>
                              ) : (
                                <>
                                  <ChevronDown className="w-3 h-3" />
                                  {isZh ? `展开 (${detectedIps.ipv6List.length})` : `All (${detectedIps.ipv6List.length})`}
                                </>
                              )}
                            </button>
                          )}
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => setShowDetectedPopover(false)}
                        aria-label={isZh ? '关闭探测结果' : 'Dismiss'}
                        className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="font-mono text-slate-700 dark:text-slate-300 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-sans font-semibold text-slate-500 dark:text-slate-400">IPv4:</span>
                        <span>{detectedIps.ipv4 ?? (isZh ? '未探测到' : 'n/a')}</span>
                        {detectedIps.ipv4 && (
                          <button
                            type="button"
                            onClick={() => void handleCopyDetected('v4', detectedIps.ipv4!)}
                            title={isZh ? '复制 IPv4' : 'Copy IPv4'}
                            className="p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                          >
                            {copiedIpKey === 'v4' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </span>
                      <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
                        |
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-sans font-semibold text-slate-500 dark:text-slate-400">
                          {detectedIps.ipv6List.length > 1
                            ? isZh
                              ? `IPv6 (共 ${detectedIps.ipv6List.length} 个):`
                              : `IPv6 (${detectedIps.ipv6List.length}):`
                            : 'IPv6:'}
                        </span>
                        {detectedIps.ipv6List.length === 0 ? (
                          <span className="text-amber-600 dark:text-amber-400 font-sans">
                            {isZh ? '未探测到' : 'Not detected'}
                          </span>
                        ) : detectedIps.ipv6List.length === 1 ? (
                          <>
                            <span className="break-all">{detectedIps.ipv6List[0]}</span>
                            <button
                              type="button"
                              onClick={() => void handleCopyDetected('v6-0', detectedIps.ipv6List[0])}
                              title={isZh ? '复制 IPv6' : 'Copy IPv6'}
                              className="p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 shrink-0"
                            >
                              {copiedIpKey === 'v6-0' ? (
                                <Check className="w-3.5 h-3.5 text-emerald-500" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </>
                        ) : null}
                        {detectedIps.ipv6Source && detectedIps.ipv6Source !== 'none' && (
                          <span className="font-sans text-[11px] text-slate-400 dark:text-slate-500">
                            (
                            {detectedIps.ipv6Source === 'interface_and_egress'
                              ? isZh
                                ? '本机网卡 + 公网探测'
                                : 'NIC + Egress'
                              : detectedIps.ipv6Source === 'interface'
                              ? isZh
                                ? '本机网卡'
                                : 'Local NIC'
                              : detectedIps.ipv6Source === 'egress'
                              ? isZh
                                ? '公网出口'
                                : 'Egress'
                              : isZh
                              ? `关联云主机 · ${detectedIps.ipv6SourceLabel || ''}`
                              : `Cloud Host · ${detectedIps.ipv6SourceLabel || ''}`}
                            )
                          </span>
                        )}
                      </span>
                    </div>

                    {detectedIps.ipv6List.length > 1 && (
                      <div className="grid grid-cols-1 gap-1.5 pt-2 border-t border-slate-100 dark:border-slate-800/80">
                        {(expandDetectedV6 ? detectedIps.ipv6List : detectedIps.ipv6List.slice(0, 4)).map((addr, idx) => {
                          const copyKey = `v6-${idx}`;
                          return (
                            <div
                              key={addr}
                              className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-slate-50 dark:bg-slate-950/70 border border-slate-200/70 dark:border-slate-800 font-mono text-[11px]"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-slate-400 select-none shrink-0">#{idx + 1}</span>
                                <span className="text-slate-800 dark:text-slate-200 truncate" title={addr}>
                                  {addr}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() => void handleCopyDetected(copyKey, addr)}
                                title={isZh ? '复制此 IPv6' : 'Copy IPv6'}
                                className="p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 shrink-0"
                              >
                                {copiedIpKey === copyKey ? (
                                  <Check className="w-3 h-3 text-emerald-500" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {detectedIps.ipv6List.length === 0 && detectedIps.ipv6Hint && (
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                        {detectedIps.ipv6Hint}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
          {subTab === 'rules' ? (
            <>
              <button
                type="button"
                disabled={syncing}
                onClick={() => void handleBatchSync()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {syncing && !syncingRuleId ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                {t('syncAllEnabled')}
              </button>
              <button
                type="button"
                onClick={openNewRule}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('addRule')}
              </button>
            </>
          ) : subTab === 'providers' ? (
            <button
              type="button"
              onClick={openNewProvider}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('addProvider')}
            </button>
          ) : null}
        </div>
      </div>

      {/* Prompt to configure DNS provider when none have credentials saved */}
      {subTab === 'rules' && configuredProviders.length === 0 && (
        <div className="px-4 py-3.5 rounded-xl border border-amber-200 dark:border-amber-900/70 bg-amber-50/70 dark:bg-amber-950/25 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="text-amber-900 dark:text-amber-200">
            {isZh
              ? '尚未配置已保存密钥的 DNS 服务商。配置一次账号凭据后，添加域名时直接选择即可复用，Cloudflare Zone ID 会自动获取。'
              : 'No configured DNS providers yet. Save your provider credentials once to reuse across all domains (Cloudflare Zone IDs are auto-resolved).'}
          </div>
          <button
            type="button"
            onClick={() => jumpToProviderSetup()}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-amber-600 text-white font-semibold hover:bg-amber-700 whitespace-nowrap shrink-0 self-start sm:self-auto"
          >
            <KeyRound className="w-3.5 h-3.5" />
            {isZh ? '去配置 DNS 服务商' : 'Configure DNS Provider'}
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}



      {/* Segmented Control: Domain DNS Records, DNS Providers, Bound Domain Sync Rules */}
      <div className="inline-flex flex-wrap items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800/80">
        <button
          type="button"
          onClick={() => setSubTab('records')}
          className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap tabular-nums ${
            subTab === 'records'
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          {isZh ? '域名 DNS 记录管理' : 'Domain DNS Records'} ({records.length})
        </button>
        <button
          type="button"
          onClick={() => setSubTab('providers')}
          className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap tabular-nums ${
            subTab === 'providers'
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          {t('dnsTabProviders')} ({configuredProviders.length}/{providers.length})
        </button>
        <button
          type="button"
          onClick={() => setSubTab('rules')}
          className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap tabular-nums ${
            subTab === 'rules'
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          {t('dnsTabRules')} ({rules.length})
        </button>
      </div>

      {/* Domain DNS Records Management Tab */}
      {subTab === 'records' ? (
        <DnsRecordsPanel
          providers={providers}
          records={records}
          managedDomains={managedDomains}
          detectedIps={detectedIps}
          lang={lang}
          onReload={onReload}
          onJumpToProviders={() => setSubTab('providers')}
          onNotify={showNotice}
        />
      ) : subTab === 'rules' ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-4 w-10">
                    <input
                      type="checkbox"
                      aria-label="Select all rules"
                      checked={rules.length > 0 && selectedRuleIds.length === rules.length}
                      onChange={(e) =>
                        setSelectedRuleIds(e.target.checked ? rules.map((r) => r.id) : [])
                      }
                      className="rounded accent-blue-600"
                    />
                  </th>
                  <th className="py-3 px-4 font-medium whitespace-nowrap">Rule / FQDN</th>
                  <th className="py-3 px-4 font-medium whitespace-nowrap">IPv4 (A)</th>
                  <th className="py-3 px-4 font-medium whitespace-nowrap">Multi-IPv6 (AAAA)</th>
                  <th className="py-3 px-4 font-medium whitespace-nowrap">Last Sync</th>
                  <th className="py-3 px-4 font-medium text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70 text-xs">
                {rules.map((rule) => {
                  const prov = providerMap.get(rule.providerId);
                  return (
                    <tr key={rule.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 align-top">
                      <td className="py-3.5 px-4">
                        <input
                          type="checkbox"
                          aria-label={`Select ${rule.name}`}
                          checked={selectedRuleIds.includes(rule.id)}
                          onChange={() => handleToggleSelect(rule.id)}
                          className="rounded accent-blue-600 mt-0.5"
                        />
                      </td>
                      <td className="py-3.5 px-4 min-w-[200px]">
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {rule.name}
                        </div>
                        <div className="mt-0.5 font-mono text-slate-500 dark:text-slate-400">
                          {rule.recordName === '@' ? rule.domain : `${rule.recordName}.${rule.domain}`}
                        </div>
                        <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-x-2">
                          <span>{prov?.name ?? 'Unknown provider'}</span>
                          <span aria-hidden="true">·</span>
                          <span>TTL {rule.ttl}s</span>
                          <span aria-hidden="true">·</span>
                          <span>{rule.dryRun ? 'Dry-run' : 'Live API'}</span>
                          {rule.resolvedZoneId && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono" title={rule.resolvedZoneId}>
                                Zone:{rule.resolvedZoneId.slice(0, 8)}…
                              </span>
                            </>
                          )}
                          {rule.proxied && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-amber-600 dark:text-amber-400">CDN Proxied</span>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 font-mono tabular-nums whitespace-nowrap">
                        {rule.syncIpv4 ? (
                          <div>
                            <div className="text-slate-800 dark:text-slate-200">
                              {rule.ipv4Address || 'Auto'}
                            </div>
                            <div className="text-[11px] text-slate-400">{rule.ipv4Source}</div>
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 font-mono tabular-nums min-w-[240px]">
                        {rule.syncIpv6 && rule.ipv6Targets.length > 0 ? (
                          <div className="space-y-1">
                            <div className="text-[11px] font-sans text-slate-500 dark:text-slate-400">
                              {rule.ipv6Targets.filter((v) => v.enabled).length} active ·{' '}
                              {rule.ipv6Mode === 'round_robin' ? 'Round-Robin' : 'Per-Host'}
                            </div>
                            {(expandedRuleV6Ids.has(rule.id) ? rule.ipv6Targets : rule.ipv6Targets.slice(0, 3)).map((v6) => (
                              <div
                                key={v6.id}
                                className="text-slate-700 dark:text-slate-300 truncate max-w-[280px]"
                                title={v6.address}
                              >
                                {rule.ipv6Mode === 'per_host' ? `${v6.recordName} -> ` : ''}
                                {v6.address}
                              </div>
                            ))}
                            {rule.ipv6Targets.length > 3 && (
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedRuleV6Ids((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(rule.id)) next.delete(rule.id);
                                    else next.add(rule.id);
                                    return next;
                                  })
                                }
                                className="inline-flex items-center gap-0.5 text-[11px] font-sans text-blue-600 dark:text-blue-400 hover:underline"
                              >
                                {expandedRuleV6Ids.has(rule.id)
                                  ? isZh
                                    ? '收起'
                                    : 'Collapse'
                                  : isZh
                                  ? `展开其余 ${rule.ipv6Targets.length - 3} 条 AAAA`
                                  : `+${rule.ipv6Targets.length - 3} more AAAA`}
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 min-w-[160px]">
                        <div
                          className={`font-medium ${
                            rule.lastStatus === 'synced'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : rule.lastStatus === 'failed'
                              ? 'text-red-600 dark:text-red-400'
                              : rule.lastStatus === 'dry_run'
                              ? 'text-blue-600 dark:text-blue-400'
                              : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          {rule.lastStatus ?? 'pending'}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                          {formatTimeAgo(rule.lastSyncedAt)}
                        </div>
                        <div
                          className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 max-w-[220px] truncate min-h-[16px]"
                          title={rule.lastMessage || undefined}
                        >
                          {rule.lastMessage || '—'}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            disabled={syncing}
                            onClick={() => void handleBatchSync([rule.id])}
                            title={t('runNow')}
                            className="p-1.5 rounded-md text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 disabled:opacity-50 transition-colors"
                          >
                            {syncingRuleId === rule.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Play className="w-4 h-4" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditRule(rule)}
                            title={t('edit')}
                            className="p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteRule(rule.id)}
                            title={t('delete')}
                            className="p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {rules.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-slate-400">
                      {t('noData')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {selectedRuleIds.length > 0 && (
            <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 max-w-[94vw] flex items-center gap-3 px-4 py-2.5 rounded-xl border border-blue-200 dark:border-blue-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur shadow-xl text-xs">
              <span className="font-semibold text-blue-700 dark:text-blue-300 tabular-nums whitespace-nowrap">
                {isZh ? `已选中 ${selectedRuleIds.length} 条同步规则` : `${selectedRuleIds.length} rule(s) selected`}
              </span>
              <button
                type="button"
                disabled={syncing}
                onClick={() => void handleBatchSync(selectedRuleIds)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                {t('syncSelected')} ({selectedRuleIds.length})
              </button>
              <button
                type="button"
                onClick={() => setSelectedRuleIds([])}
                className="px-2 py-1 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 whitespace-nowrap"
              >
                {isZh ? '取消选择' : 'Clear'}
              </button>
            </div>
          )}
        </div>
      ) : (
        /* DNS Providers Table (Reusable Account Credentials) */
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-6 font-medium whitespace-nowrap">
                    {isZh ? '服务商账号名称' : 'Provider Account'}
                  </th>
                  <th className="py-3 px-4 font-medium whitespace-nowrap">{t('providerType')}</th>
                  <th className="py-3 px-4 font-medium whitespace-nowrap">
                    {isZh ? '凭据与可用状态' : 'Credential Status'}
                  </th>
                  <th className="py-3 px-6 font-medium text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70 text-xs">
                {providers.map((p) => {
                  const ready = isProviderConfigured(p);
                  return (
                    <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="py-3.5 px-6">
                        <div className="font-semibold text-slate-900 dark:text-white">{p.name}</div>
                        {p.type === 'cloudflare' && ready && (
                          <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                            {isZh ? 'Zone ID 自动获取 · 支持账号下全部域名' : 'Auto Zone ID · Reusable across all domains'}
                          </div>
                        )}
                        {p.type === 'webhook' && p.endpointUrl && (
                          <div className="mt-0.5 font-mono text-[11px] text-slate-400 truncate max-w-[260px]">
                            {p.endpointUrl}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-slate-600 dark:text-slate-300 uppercase whitespace-nowrap">
                        {p.type}
                      </td>
                      <td className="py-3.5 px-4">
                        {ready ? (
                          <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                            {isZh ? '已配置，可在添加域名时直接选择' : 'Ready (selectable in rules)'}
                            {p.secretPreview ? ` · ${p.secretPreview}` : ''}
                          </span>
                        ) : (
                          <span className="text-amber-600 dark:text-amber-400">
                            {isZh
                              ? '未配置密钥（不会出现在域名选择列表）'
                              : 'Not configured (hidden from rule selector)'}
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-6 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          {!ready && (
                            <button
                              type="button"
                              onClick={() => openEditProvider(p)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-md border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 whitespace-nowrap"
                            >
                              <KeyRound className="w-3 h-3" />
                              {isZh ? '配置密钥' : 'Set Key'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => openEditProvider(p)}
                            title={t('edit')}
                            className="p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteProvider(p.id)}
                            title={t('delete')}
                            className="p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {providers.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-10 text-center text-slate-400">
                      {t('noData')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Simplified Provider Modal (Configure Once, Reuse Across All Domains) */}
      {showProviderModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                {editingProvider ? t('edit') : t('addProvider')}
              </h3>
              <button
                type="button"
                onClick={() => setShowProviderModal(false)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveProvider} className="mt-4 space-y-4 text-sm">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {t('providerType')}
                </label>
                <select
                  value={provForm.type}
                  onChange={(e) => {
                    const nextType = e.target.value as DnsProviderType;
                    const meta = PROVIDER_TYPES.find((pt) => pt.value === nextType);
                    const prevMeta = PROVIDER_TYPES.find((pt) => pt.value === provForm.type);
                    const shouldAutoName = !provForm.name || provForm.name === prevMeta?.label;
                    setProvForm({
                      ...provForm,
                      type: nextType,
                      name: shouldAutoName && meta ? meta.label : provForm.name,
                    });
                  }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                >
                  {PROVIDER_TYPES.map((pt) => (
                    <option key={pt.value} value={pt.value}>
                      {pt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {isZh ? '备注名称（用于添加域名时快速选择）' : 'Account Label'}
                </label>
                <input
                  required
                  value={provForm.name}
                  onChange={(e) => setProvForm({ ...provForm, name: e.target.value })}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  placeholder="Cloudflare 主账号"
                />
              </div>

              {provForm.type === 'webhook' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {t('webhookEndpoint')}
                  </label>
                  <input
                    type="url"
                    required
                    value={provForm.endpointUrl}
                    onChange={(e) => setProvForm({ ...provForm, endpointUrl: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    placeholder="https://dns-hook.example.com/update"
                  />
                </div>
              )}

              {selectedProviderMeta.needsSecretId && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {selectedProviderMeta.secretIdLabel}
                  </label>
                  <input
                    value={provForm.secretId}
                    onChange={(e) => setProvForm({ ...provForm, secretId: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    placeholder={editingProvider?.hasSecret ? '留空保持原有 ID' : ''}
                  />
                </div>
              )}

              {provForm.type === 'cloudflare' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {isZh
                      ? 'Cloudflare 账号邮箱（可选，仅使用 Global API Key 时填写）'
                      : 'Cloudflare Account Email (Optional — Global API Key only)'}
                  </label>
                  <input
                    type="email"
                    value={provForm.accountEmail}
                    onChange={(e) => setProvForm({ ...provForm, accountEmail: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    placeholder={
                      isZh
                        ? '使用 API Token 请留空；使用 Global API Key 则填登录邮箱'
                        : 'Leave blank for API Token; required only for Global API Key'
                    }
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {selectedProviderMeta.secretLabel}
                </label>
                <input
                  type="password"
                  required={provForm.type !== 'webhook' && !editingProvider?.hasSecret}
                  value={provForm.secret}
                  onChange={(e) => setProvForm({ ...provForm, secret: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  placeholder={
                    editingProvider?.hasSecret
                      ? isZh
                        ? '留空则保留已加密密钥'
                        : 'Leave empty to keep saved secret'
                      : isZh
                      ? '服务端 AES-256-GCM 加密保存'
                      : 'Encrypted with AES-256-GCM on server'
                  }
                />
              </div>

              <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                {provForm.type === 'cloudflare'
                  ? isZh
                    ? '推荐使用 Cloudflare API Token（权限：Zone:Read + DNS:Edit，上方邮箱留空）；若使用 Global API Key 则需同时填写 Cloudflare 登录邮箱。系统会自动拉取账号下域名列表与 Zone ID。'
                    : 'Recommended: Cloudflare API Token (Zone:Read + DNS:Edit, leave email empty). For Global API Key, also fill in your Cloudflare account email. Domains & Zone IDs are fetched automatically.'
                  : isZh
                  ? '保存一次账号凭据即可供该服务商下所有域名复用，无需重复配置。'
                  : 'Save credentials once and reuse across all domains under this provider.'}
              </p>

              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowProviderModal(false)}
                  className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  {t('cancel')}
                </button>
                <button
                  type="submit"
                  disabled={savingProvider}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingProvider && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {t('save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Rule Modal (Streamlined: Pick Configured Provider -> Auto-Zone Domain -> IPv4 + Multi-IPv6) */}
      {showRuleModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                {editingRule ? t('edit') : t('addRule')}
              </h3>
              <button
                type="button"
                onClick={() => setShowRuleModal(false)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {configuredProviders.length === 0 && !editingRule ? (
              /* No configured providers -> do NOT render an empty selector; guide straight to setup */
              <div className="py-10 text-center space-y-4">
                <div className="mx-auto w-11 h-11 rounded-full bg-amber-100 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center">
                  <KeyRound className="w-5 h-5" />
                </div>
                <div className="space-y-1 max-w-md mx-auto">
                  <h4 className="font-display text-base font-semibold text-slate-900 dark:text-white">
                    {isZh ? '请先配置至少一个 DNS 服务商' : 'Configure a DNS Provider First'}
                  </h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    {isZh
                      ? '未配置密钥的服务商不会显示在选择列表中。先保存一次服务商密钥（如 Cloudflare Token），之后添加任意域名只需直接选择即可，Zone ID 自动获取。'
                      : 'Unconfigured providers are hidden from the selector. Save your provider API token once, then add domains in seconds with automatic Cloudflare Zone ID lookup.'}
                  </p>
                </div>
                <div className="flex items-center justify-center gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowRuleModal(false)}
                    className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700"
                  >
                    {t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => jumpToProviderSetup()}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                  >
                    {isZh ? '立即前往设置服务商' : 'Go to Provider Setup'}
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSaveRule} className="mt-4 space-y-5 text-sm">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                        {t('providerType')}
                      </label>
                      <button
                        type="button"
                        onClick={() => jumpToProviderSetup()}
                        className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                      >
                        + {isZh ? '去设置新服务商' : 'Add Provider'}
                      </button>
                    </div>
                    <select
                      required
                      value={ruleForm.providerId}
                      onChange={(e) => {
                        const p = providerMap.get(e.target.value);
                        setCfZones([]);
                        setZonesError(null);
                        setRuleForm({
                          ...ruleForm,
                          providerId: e.target.value,
                          resolvedZoneId: '',
                          line: p?.type === 'dnspod' ? '默认' : 'default',
                          dryRun: p ? !isProviderConfigured(p) : true,
                        });
                      }}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    >
                      {configuredProviders.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.type})
                        </option>
                      ))}
                      {/* If editing a legacy rule pointing to an unconfigured provider, keep it visible with warning */}
                      {editingRule &&
                        selectedProvider &&
                        !isProviderConfigured(selectedProvider) && (
                          <option value={selectedProvider.id}>
                            {selectedProvider.name} ({selectedProvider.type} —{' '}
                            {isZh ? '未配密钥' : 'no secret'})
                          </option>
                        )}
                    </select>
                    {selectedProvider && !isProviderConfigured(selectedProvider) && (
                      <button
                        type="button"
                        onClick={() => jumpToProviderSetup(selectedProvider)}
                        className="mt-1 text-[11px] text-amber-600 dark:text-amber-400 hover:underline"
                      >
                        {isZh ? '该服务商尚未配置密钥，点击前往填写 →' : 'Configure API key for this provider →'}
                      </button>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                        {t('domain')}
                      </label>
                      {selectedProvider &&
                        selectedProvider.hasSecret &&
                        ['cloudflare', 'dnspod', 'aliyun', 'porkbun'].includes(selectedProvider.type) && (
                          <button
                            type="button"
                            disabled={loadingZones}
                            onClick={() => void fetchZonesForProvider(selectedProvider.id, true)}
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                          >
                            <RefreshCw className={`w-3 h-3 ${loadingZones ? 'animate-spin' : ''}`} />
                            {isZh ? '刷新域名列表' : 'Refresh Domains'}
                          </button>
                        )}
                    </div>

                    {cfZones.length > 0 ? (
                      <select
                        required
                        value={ruleForm.domain}
                        onChange={(e) => {
                          const z = cfZones.find((item) => item.name === e.target.value);
                          setRuleForm({
                            ...ruleForm,
                            domain: e.target.value,
                            resolvedZoneId: selectedProvider?.type === 'cloudflare' ? z?.id ?? '' : '',
                          });
                        }}
                        className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                      >
                        {!cfZones.some((z) => z.name === ruleForm.domain) && ruleForm.domain && (
                          <option value={ruleForm.domain}>{ruleForm.domain}</option>
                        )}
                        {cfZones.map((z) => (
                          <option key={z.id} value={z.name}>
                            {z.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        required
                        value={ruleForm.domain}
                        onChange={(e) =>
                          setRuleForm({ ...ruleForm, domain: e.target.value, resolvedZoneId: '' })
                        }
                        placeholder="example.com"
                        className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                      />
                    )}

                    {(loadingZones || zonesError || (selectedProvider?.type === 'cloudflare' && ruleForm.resolvedZoneId)) && (
                      <div className="mt-1 text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                        {loadingZones
                          ? isZh
                            ? '正在自动拉取该服务商下的域名列表...'
                            : 'Fetching domains from provider...'
                          : ruleForm.resolvedZoneId
                          ? `Zone ID (auto): ${ruleForm.resolvedZoneId}`
                          : zonesError
                          ? `${zonesError} (${isZh ? '仍可手动输入域名' : 'you can still type domain'})`
                          : ''}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      {t('recordName')}
                    </label>
                    <input
                      required
                      value={ruleForm.recordName}
                      onChange={(e) => setRuleForm({ ...ruleForm, recordName: e.target.value })}
                      className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                      placeholder="@ or edge"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      {isZh ? '规则备注名（可选，留空自动按域名生成）' : 'Rule Name (Optional)'}
                    </label>
                    <input
                      value={ruleForm.name}
                      onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })}
                      placeholder={
                        ruleForm.domain
                          ? ruleForm.recordName === '@'
                            ? ruleForm.domain
                            : `${ruleForm.recordName}.${ruleForm.domain}`
                          : 'edge.example.com'
                      }
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      {t('ttlSeconds')}
                    </label>
                    <input
                      type="number"
                      min={60}
                      value={ruleForm.ttl}
                      onChange={(e) => setRuleForm({ ...ruleForm, ttl: Number(e.target.value) })}
                      className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    />
                  </div>

                  {selectedProvider?.type !== 'cloudflare' && (
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        {t('dnsLine')}
                      </label>
                      <input
                        value={ruleForm.line}
                        onChange={(e) => setRuleForm({ ...ruleForm, line: e.target.value })}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                      />
                    </div>
                  )}
                </div>

                {/* IPv4 Section */}
                <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
                  <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-white">
                    <input
                      type="checkbox"
                      checked={ruleForm.syncIpv4}
                      onChange={(e) => setRuleForm({ ...ruleForm, syncIpv4: e.target.checked })}
                      className="rounded accent-blue-600"
                    />
                    {t('ipv4Config')}
                  </label>

                  {ruleForm.syncIpv4 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <select
                        value={ruleForm.ipv4Source}
                        onChange={(e) =>
                          setRuleForm({
                            ...ruleForm,
                            ipv4Source: e.target.value as 'manual' | 'auto_public' | 'cloud_host',
                          })
                        }
                        className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                      >
                        <option value="manual">{t('ipv4SourceManual')}</option>
                        <option value="auto_public">{t('ipv4SourceAuto')}</option>
                        <option value="cloud_host">{t('ipv4SourceHost')}</option>
                      </select>

                      {ruleForm.ipv4Source === 'cloud_host' ? (
                        <select
                          value={ruleForm.linkedHostId}
                          onChange={(e) => {
                            const h = hosts.find((x) => x.id === e.target.value);
                            setRuleForm({
                              ...ruleForm,
                              linkedHostId: e.target.value,
                              ipv4Address: h?.ipv4 ?? ruleForm.ipv4Address,
                            });
                          }}
                          className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                        >
                          <option value="">-- {t('linkedHost')} --</option>
                          {hosts.map((h) => (
                            <option key={h.id} value={h.id}>
                              {h.name} ({h.ipv4})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={ruleForm.ipv4Address}
                          onChange={(e) => setRuleForm({ ...ruleForm, ipv4Address: e.target.value })}
                          placeholder="203.0.113.10"
                          className="px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                        />
                      )}
                    </div>
                  )}
                </div>

                {/* Multi-IPv6 Section */}
                <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-white">
                      <input
                        type="checkbox"
                        checked={ruleForm.syncIpv6}
                        onChange={(e) => setRuleForm({ ...ruleForm, syncIpv6: e.target.checked })}
                        className="rounded accent-blue-600"
                      />
                      {t('ipv6Config')}
                    </label>
                    {ruleForm.syncIpv6 && (
                      <button
                        type="button"
                        onClick={() =>
                          setRuleForm((prev) => ({
                            ...prev,
                            ipv6Targets: [
                              ...prev.ipv6Targets,
                              {
                                id: `v6-row-${Date.now()}`,
                                recordName:
                                  prev.ipv6Mode === 'round_robin'
                                    ? prev.recordName
                                    : `v6-${prev.ipv6Targets.length + 1}.${prev.recordName}`,
                                address: '',
                                enabled: true,
                              },
                            ],
                          }))
                        }
                        className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        + {t('addIpv6Row')}
                      </button>
                    )}
                  </div>

                  {ruleForm.syncIpv6 && (
                    <>
                      <select
                        value={ruleForm.ipv6Mode}
                        onChange={(e) =>
                          setRuleForm({
                            ...ruleForm,
                            ipv6Mode: e.target.value as 'round_robin' | 'per_host',
                          })
                        }
                        className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                      >
                        <option value="round_robin">{t('ipv6ModeRoundRobin')}</option>
                        <option value="per_host">{t('ipv6ModePerHost')}</option>
                      </select>

                      <div className="space-y-2">
                        {ruleForm.ipv6Targets.map((item, idx) => (
                          <div key={item.id} className="flex items-center gap-2">
                            {ruleForm.ipv6Mode === 'per_host' && (
                              <input
                                value={item.recordName}
                                onChange={(e) => {
                                  const next = [...ruleForm.ipv6Targets];
                                  next[idx] = { ...item, recordName: e.target.value };
                                  setRuleForm({ ...ruleForm, ipv6Targets: next });
                                }}
                                placeholder="v6-1"
                                className="w-32 px-2.5 py-1.5 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                              />
                            )}
                            <input
                              value={item.address}
                              onChange={(e) => {
                                const next = [...ruleForm.ipv6Targets];
                                next[idx] = { ...item, address: e.target.value };
                                setRuleForm({ ...ruleForm, ipv6Targets: next });
                              }}
                              placeholder="2603:c020:4009:a100::10"
                              className="flex-1 min-w-0 px-2.5 py-1.5 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setRuleForm({
                                  ...ruleForm,
                                  ipv6Targets: ruleForm.ipv6Targets.filter((_, i) => i !== idx),
                                })
                              }
                              className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 rounded"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>

                      {/* Bulk multi-line IPv6 paste helper */}
                      <div className="space-y-1.5">
                        <textarea
                          rows={2}
                          value={bulkIpv6Text}
                          onChange={(e) => setBulkIpv6Text(e.target.value)}
                          placeholder={t('bulkPasteIpv6')}
                          className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                        />
                        <button
                          type="button"
                          onClick={handleApplyBulkIpv6}
                          className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          {t('applyBulkIpv6')}
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {/* Flags */}
                <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap gap-5 text-xs">
                  {selectedProvider?.type === 'cloudflare' && (
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={ruleForm.proxied}
                        onChange={(e) => setRuleForm({ ...ruleForm, proxied: e.target.checked })}
                        className="rounded accent-blue-600"
                      />
                      {t('proxiedCloudflare')}
                    </label>
                  )}
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={ruleForm.dryRun}
                      onChange={(e) => setRuleForm({ ...ruleForm, dryRun: e.target.checked })}
                      className="rounded accent-blue-600"
                    />
                    {t('dryRunMode')}
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={ruleForm.enabled}
                      onChange={(e) => setRuleForm({ ...ruleForm, enabled: e.target.checked })}
                      className="rounded accent-blue-600"
                    />
                    {t('enabled')}
                  </label>
                </div>

                <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowRuleModal(false)}
                    className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700"
                  >
                    {t('cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={savingRule}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {savingRule && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {t('save')}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
