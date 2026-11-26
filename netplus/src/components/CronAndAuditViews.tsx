import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Download,
  Folder,
  Loader2,
  Lock,
  PauseCircle,
  Pencil,
  Play,
  PlayCircle,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { translate, type TranslationKeys } from '../i18n/translations';
import { apiRequest, formatBytes, formatTimeAgo } from '../lib/api';
import { toast } from '../lib/toast';
import type {
  AuditLogEntry,
  AuditStats,
  CloudHost,
  CronIpSyncPolicy,
  CronJob,
  CronJobType,
  DnsSyncRule,
  IpPolicyAction,
  IpPolicyTargetScope,
  LanguageCode,
} from '../types/models';

interface CronJobsViewProps {
  jobs: CronJob[];
  hosts: CloudHost[];
  dnsRules: DnsSyncRule[];
  lang: LanguageCode;
  onReload: () => Promise<void>;
}

const CRON_PRESETS = [
  { label: 'Every 5m', expr: '*/5 * * * *' },
  { label: 'Every 15m', expr: '*/15 * * * *' },
  { label: 'Hourly', expr: '0 * * * *' },
  { label: 'Every 6h', expr: '0 */6 * * *' },
  { label: 'Daily 03:00', expr: '0 3 * * *' },
  { label: 'Weekly Sun 04:00', expr: '0 4 * * 0' },
];

const DEFAULT_POLICY: CronIpSyncPolicy = {
  scope: 'all',
  targetGroups: [],
  targetHostIds: [],
  action: 'sync_dns_only',
  ipv6Count: 1,
  syncDnsAfter: true,
  notifyOnComplete: true,
};

export function CronJobsView({ jobs, hosts, dnsRules, lang, onReload }: CronJobsViewProps) {
  const t = (key: TranslationKeys) => translate(lang, key);
  const isZh = lang === 'zh-CN';

  const [runningId, setRunningId] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState<{
    name: string;
    type: CronJobType;
    expression: string;
    enabled: boolean;
    ipPolicy: CronIpSyncPolicy;
  }>({
    name: '',
    type: 'oci_ip_dns_policy',
    expression: '0 3 * * *',
    enabled: true,
    ipPolicy: { ...DEFAULT_POLICY },
  });

  const managedHosts = useMemo(
    () => hosts.filter((h) => h.provider === 'oracle' || h.provider === 'aws' || h.provider === 'aliyun' || h.provider === 'gcp'),
    [hosts]
  );
  const dnsRuleMap = useMemo(() => new Map(dnsRules.map((r) => [r.id, r])), [dnsRules]);

  const groupSummaries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of managedHosts) {
      const g = (h.groupName || '').trim() || (isZh ? '默认分组' : 'Default');
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
  }, [managedHosts, isZh]);

  const policyActionOptions: Array<{ value: IpPolicyAction; label: string; hint: string }> = [
    {
      value: 'sync_dns_only',
      label: isZh ? '刷新云端最新 IP 并同步 DNS' : 'Refresh Live Cloud IPs & Sync DNS',
      hint: isZh ? '拉取 OCI / AWS / 阿里云 / GCP 实例最新 IPv4/IPv6 并自动更新绑定域名' : 'Pull live cloud IPs and sync bound domains',
    },
    {
      value: 'swap_ipv4',
      label: isZh ? '定时更换公网 IPv4 再同步 DNS' : 'Rotate Public IPv4 & Sync DNS',
      hint: isZh ? '通过云商 API 释放旧公网 IPv4/EIP 并绑定新 IPv4，完成后自动更新 DNS' : 'Rotate public IPv4 via cloud API and update DNS',
    },
    {
      value: 'add_ipv6',
      label: isZh ? '定时新增 IPv6 地址再同步 DNS' : 'Add New IPv6(s) & Sync DNS',
      hint: isZh ? '为目标实例批量新增 N 个 IPv6，自动推送全部 AAAA 记录' : 'Allocate N new IPv6s on target instances and sync AAAA',
    },
    {
      value: 'swap_all_ipv6',
      label: isZh ? '定时全部更换 IPv6 再同步 DNS' : 'Replace All IPv6s & Sync DNS',
      hint: isZh ? '先新增等量新 IPv6 再删除旧 IPv6，最后更新绑定域名' : 'Replace every existing IPv6 on target instances and sync DNS',
    },
    {
      value: 'delete_excess_ipv6',
      label: isZh ? '定时删除多余 IPv6（保留 N 个）再同步 DNS' : 'Trim Excess IPv6 (Keep N) & Sync DNS',
      hint: isZh ? '删除超出保留数量的多余 IPv6 并同步清理 DNS AAAA 记录' : 'Delete extra IPv6s above target count and update DNS',
    },
    {
      value: 'rotate_dual_stack',
      label: isZh ? '定时双栈轮换（IPv4 + IPv6 全换）再同步 DNS' : 'Dual-Stack Rotate (IPv4 + IPv6) & Sync DNS',
      hint: isZh ? '同时更换公网 IPv4 与全部 IPv6 地址，并自动同步绑定域名' : 'Rotate both IPv4 and IPv6 via cloud API and sync DNS',
    },
  ];

  const policyActionLabel = (action: IpPolicyAction): string =>
    policyActionOptions.find((o) => o.value === action)?.label || action;

  const formatPolicySummary = (policy?: CronIpSyncPolicy): string | null => {
    if (!policy) return null;
    const scopeText =
      policy.scope === 'all'
        ? isZh ? '全部多云实例' : 'All Managed Hosts'
        : policy.scope === 'group'
          ? isZh
            ? `分组 [${policy.targetGroups.join(', ')}]`
            : `Groups [${policy.targetGroups.join(', ')}]`
          : isZh
            ? `指定 ${policy.targetHostIds.length} 台实例`
            : `${policy.targetHostIds.length} selected host(s)`;
    const countSuffix =
      policy.action === 'add_ipv6'
        ? isZh ? ` (+${policy.ipv6Count}个)` : ` (+${policy.ipv6Count})`
        : policy.action === 'delete_excess_ipv6'
          ? isZh ? ` (保留${policy.ipv6Count}个)` : ` (keep ${policy.ipv6Count})`
          : '';
    const dnsSuffix = policy.syncDnsAfter
      ? isZh ? ' → 自动同步绑定域名 DNS' : ' -> Auto DNS Sync'
      : isZh ? '（不同步 DNS）' : ' (no DNS sync)';
    return `${scopeText} · ${policyActionLabel(policy.action)}${countSuffix}${dnsSuffix}`;
  };

  const jobTypeLabel = (type: CronJobType): string => {
    switch (type) {
      case 'oci_ip_dns_policy':
        return isZh ? '多云 IP 增换删与 DNS 同步策略' : 'Multi-Cloud IP Lifecycle & DNS Sync Policy';
      case 'dns_batch_sync':
        return t('jobTypeDns');
      case 'oci_sniper_sweep':
        return t('jobTypeOci');
      case 'cloud_ip_refresh':
        return t('jobTypeCloud');
      case 'monitor_sweep':
        return isZh
          ? 'IP 与服务节点可用性监控巡检'
          : lang === 'ja'
          ? 'IP・サービス監視巡回'
          : lang === 'de'
          ? 'IP- & Dienst-Monitoring-Prüfung'
          : lang === 'es'
          ? 'Barrido de Monitoreo IP/Servicios'
          : 'IP & Service Uptime Monitor Sweep';
      case 'audit_cleanup':
        return t('jobTypeAudit');
    }
  };

  const openCreateModal = () => {
    setEditingJob(null);
    setFormError(null);
    setForm({
      name: '',
      type: 'oci_ip_dns_policy',
      expression: '0 3 * * *',
      enabled: true,
      ipPolicy: { ...DEFAULT_POLICY },
    });
    setShowModal(true);
  };

  const openEditModal = (job: CronJob) => {
    setEditingJob(job);
    setFormError(null);
    setForm({
      name: job.name,
      type: job.type,
      expression: job.expression,
      enabled: job.enabled,
      ipPolicy: job.ipPolicy ? { ...DEFAULT_POLICY, ...job.ipPolicy } : { ...DEFAULT_POLICY },
    });
    setShowModal(true);
  };

  const toggleGroupSelection = (groupName: string) => {
    setForm((prev) => {
      const exists = prev.ipPolicy.targetGroups.includes(groupName);
      const next = exists
        ? prev.ipPolicy.targetGroups.filter((g) => g !== groupName)
        : [...prev.ipPolicy.targetGroups, groupName];
      return { ...prev, ipPolicy: { ...prev.ipPolicy, targetGroups: next } };
    });
  };

  const toggleHostSelection = (hostId: string) => {
    setForm((prev) => {
      const exists = prev.ipPolicy.targetHostIds.includes(hostId);
      const next = exists
        ? prev.ipPolicy.targetHostIds.filter((id) => id !== hostId)
        : [...prev.ipPolicy.targetHostIds, hostId];
      return { ...prev, ipPolicy: { ...prev.ipPolicy, targetHostIds: next } };
    });
  };

  const handleToggle = async (job: CronJob) => {
    setBusyJobId(job.id);
    try {
      const next = !job.enabled;
      await apiRequest(`/api/cron/jobs/${job.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: next }),
      });
      await onReload();
      toast.success(
        isZh
          ? `定时任务「${job.name}」已${next ? '启用' : '停用'}`
          : `Cron job "${job.name}" ${next ? 'enabled' : 'disabled'}`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : isZh ? '状态切换失败' : 'Toggle failed');
    } finally {
      setBusyJobId(null);
    }
  };

  const handleRunNow = async (job: CronJob) => {
    setRunningId(job.id);
    try {
      const res = await apiRequest<{ job?: CronJob }>(`/api/cron/jobs/${job.id}/run`, { method: 'POST' });
      await onReload();
      const status = res.job?.lastStatus;
      const summary = res.job?.lastSummary;
      const msg = summary ? `${job.name}：${summary}` : isZh ? `已执行定时任务「${job.name}」` : `Executed "${job.name}"`;
      if (status === 'failed') {
        toast.error(msg);
      } else if (status === 'partial') {
        toast.warning(msg);
      } else {
        toast.success(msg);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : isZh ? '执行失败' : 'Execution failed');
    } finally {
      setRunningId(null);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        type: form.type,
        expression: form.expression.trim(),
        enabled: form.enabled,
        ipPolicy: form.type === 'oci_ip_dns_policy' ? form.ipPolicy : undefined,
      };
      if (editingJob) {
        await apiRequest(`/api/cron/jobs/${editingJob.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await apiRequest('/api/cron/jobs', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setShowModal(false);
      await onReload();
      toast.success(t('savedSuccessfully'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save scheduled job';
      setFormError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (job: CronJob) => {
    setBusyJobId(job.id);
    try {
      await apiRequest(`/api/cron/jobs/${job.id}`, { method: 'DELETE' });
      await onReload();
      toast.success(isZh ? `已删除定时任务「${job.name}」` : `Deleted cron job "${job.name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : isZh ? '删除失败' : 'Delete failed');
    } finally {
      setBusyJobId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t('cronTitle')}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {isZh
              ? '配置定时 IP 增/换/删与 DNS 自动同步策略（支持全部实例、按分组批量或指定实例），并统一调度 ARM 抢注、监控巡检与审计清理。'
              : t('cronSubtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={openCreateModal}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap shrink-0 self-start sm:self-auto"
        >
          <Plus className="w-3.5 h-3.5" />
          {isZh ? '新建同步策略 / 定时任务' : t('addCronJob')}
        </button>
      </div>

      <div className="rounded-xl border border-blue-200/70 dark:border-blue-900/60 bg-blue-50/50 dark:bg-blue-950/20 px-4 py-3 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
        {isZh
          ? '说明：左侧「实时监控」中的 HTTP(S)/TCP/DNS 探针由后台独立监控守护线程按各自心跳间隔自动触发（无需额外创建 Cron 任务）；此处的「定时任务」用于批量巡检、定时 IP 轮换/DNS 同步及审计清理。系统级巡检与清理任务禁止删除，可通过开关随时禁用或启用。'
          : 'Note: Live Monitors run automatically via a dedicated background probe daemon on each monitor’s own interval. Schedules manages cron-based sweeps, IP/DNS rotation policies, and audit cleanup. System/monitor tasks are delete-protected and can be enabled or disabled anytime.'}
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                <th className="py-3 px-6 font-medium whitespace-nowrap">
                  {isZh ? '任务与同步策略' : 'Task & Policy'}
                </th>
                <th className="py-3 px-4 font-medium whitespace-nowrap">{isZh ? '启用状态' : 'Status'}</th>
                <th className="py-3 px-4 font-medium whitespace-nowrap">{t('cronExpression')}</th>
                <th className="py-3 px-4 font-medium whitespace-nowrap">{t('nextRun')} / {t('lastRun')}</th>
                <th className="py-3 px-4 font-medium whitespace-nowrap">{t('runCount')}</th>
                <th className="py-3 px-6 font-medium text-right whitespace-nowrap">
                  {isZh ? '操作' : 'Actions'}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70 text-xs">
              {jobs.map((job) => {
                const policySummary = job.type === 'oci_ip_dns_policy' ? formatPolicySummary(job.ipPolicy) : null;
                const isProtected =
                  Boolean(job.systemProtected) ||
                  job.type === 'monitor_sweep' ||
                  job.type === 'audit_cleanup';
                return (
                  <tr
                    key={job.id}
                    className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 align-top transition-opacity ${
                      job.enabled ? '' : 'opacity-65'
                    }`}
                  >
                    <td className="py-3.5 px-6 min-w-[260px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-900 dark:text-white">{job.name}</span>
                        {isProtected && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[10px] font-medium text-slate-600 dark:text-slate-300">
                            <Lock className="w-2.5 h-2.5" />
                            {isZh ? '系统保护' : 'System'}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                        {jobTypeLabel(job.type)}
                      </div>
                      {policySummary && (
                        <div className="mt-1.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
                          {policySummary}
                        </div>
                      )}
                      <div
                        className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 max-w-lg truncate min-h-[16px]"
                        title={job.lastSummary || undefined}
                      >
                        {job.lastSummary || '—'}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={job.enabled}
                        disabled={busyJobId === job.id}
                        onClick={() => void handleToggle(job)}
                        title={job.enabled ? (isZh ? '点击禁用该定时任务' : 'Click to disable') : (isZh ? '点击启用该定时任务' : 'Click to enable')}
                        className="inline-flex items-center gap-2 disabled:opacity-50"
                      >
                        <span
                          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
                            job.enabled ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${
                              job.enabled ? 'translate-x-4' : 'translate-x-0.5'
                            }`}
                          />
                        </span>
                        <span
                          className={`text-[11px] font-medium ${
                            job.enabled
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {job.enabled ? (isZh ? '已启用' : 'Enabled') : isZh ? '已禁用' : 'Disabled'}
                        </span>
                      </button>
                    </td>
                    <td className="py-3.5 px-4 font-mono tabular-nums text-slate-800 dark:text-slate-200 whitespace-nowrap">
                      {job.expression}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-[11px] tabular-nums text-slate-600 dark:text-slate-400 whitespace-nowrap">
                      <div>Next: {job.enabled ? formatTimeAgo(job.nextRunAt) : isZh ? '已暂停' : 'Paused'}</div>
                      <div className="mt-0.5">Last: {formatTimeAgo(job.lastRunAt)}</div>
                    </td>
                    <td className="py-3.5 px-4 font-mono tabular-nums text-slate-800 dark:text-slate-200 whitespace-nowrap">
                      {job.runCount}
                    </td>
                    <td className="py-3.5 px-6 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busyJobId === job.id}
                          onClick={() => void handleToggle(job)}
                          className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-md border disabled:opacity-50 ${
                            job.enabled
                              ? 'border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30'
                              : 'border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30'
                          }`}
                        >
                          {job.enabled ? (
                            <>
                              <PauseCircle className="w-3.5 h-3.5" />
                              {isZh ? '禁用' : 'Disable'}
                            </>
                          ) : (
                            <>
                              <PlayCircle className="w-3.5 h-3.5" />
                              {isZh ? '启用' : 'Enable'}
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          disabled={runningId === job.id}
                          onClick={() => void handleRunNow(job)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-md border border-slate-200 dark:border-slate-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-50"
                        >
                          {runningId === job.id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Play className="w-3 h-3" />
                          )}
                          {t('runNow')}
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditModal(job)}
                          aria-label={t('edit')}
                          className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        {isProtected ? (
                          <button
                            type="button"
                            disabled
                            title={
                              isZh
                                ? '系统监控/巡检类任务禁止删除，请使用左侧禁用开关'
                                : 'System/monitor task cannot be deleted; use Disable instead'
                            }
                            aria-label={isZh ? '禁止删除' : 'Delete locked'}
                            className="p-1.5 rounded-md text-slate-300 dark:text-slate-600 cursor-not-allowed"
                          >
                            <Lock className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busyJobId === job.id}
                            onClick={() => void handleDelete(job)}
                            aria-label={t('delete')}
                            className="p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {jobs.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-400">
                    {t('noData')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit Cron Job & IP/DNS Sync Policy Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-display text-lg font-semibold">
                {editingJob
                  ? isZh ? '编辑定时策略任务' : 'Edit Scheduled Job'
                  : isZh ? '新建定时同步策略 / 定时任务' : t('addCronJob')}
              </h3>
              <button type="button" onClick={() => setShowModal(false)} className="p-1 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            {formError && (
              <div className="mt-3 px-3 py-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50/70 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
                {formError}
              </div>
            )}

            <form onSubmit={handleSave} className="mt-4 space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block font-medium mb-1">{isZh ? '任务名称 *' : 'Task Name *'}</label>
                  <input
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder={isZh ? '例如：亚太分组每日更换 IPv4 并同步 DNS' : 'e.g. Daily APAC IPv4 Rotate + DNS'}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">{t('jobType')}</label>
                  <select
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value as CronJobType })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  >
                    <option value="oci_ip_dns_policy">
                      {isZh ? '多云 IP 增换删与 DNS 同步策略 (OCI/AWS/阿里云/GCP)' : 'Multi-Cloud IP Lifecycle & DNS Sync Policy'}
                    </option>
                    <option value="oci_sniper_sweep">{t('jobTypeOci')}</option>
                    <option value="monitor_sweep">{jobTypeLabel('monitor_sweep')}</option>
                    <option value="cloud_ip_refresh">{t('jobTypeCloud')}</option>
                    <option value="dns_batch_sync">{t('jobTypeDns')}</option>
                    <option value="audit_cleanup">{t('jobTypeAudit')}</option>
                  </select>
                </div>
              </div>

              {/* Structured Sync Policy Builder for oci_ip_dns_policy */}
              {form.type === 'oci_ip_dns_policy' && (
                <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 space-y-4">
                  <div>
                    <label className="block font-semibold text-slate-800 dark:text-slate-200 mb-1.5">
                      {isZh ? '1. 作用范围（指定实例或按分组批量）' : '1. Target Scope'}
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {(
                        [
                          { value: 'all', label: isZh ? '全部多云实例' : 'All Managed Hosts' },
                          { value: 'group', label: isZh ? '按实例分组批量' : 'By Host Group' },
                          { value: 'hosts', label: isZh ? '指定单台/多台' : 'Specific Hosts' },
                        ] as Array<{ value: IpPolicyTargetScope; label: string }>
                      ).map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() =>
                            setForm({
                              ...form,
                              ipPolicy: { ...form.ipPolicy, scope: opt.value },
                            })
                          }
                          className={`py-2 px-2.5 rounded-lg border font-medium transition-colors ${
                            form.ipPolicy.scope === opt.value
                              ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>

                    {form.ipPolicy.scope === 'group' && (
                      <div className="mt-2.5 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-1.5">
                        {groupSummaries.length === 0 ? (
                          <div className="text-slate-400">{isZh ? '暂无 OCI 主机分组' : 'No host groups yet'}</div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {groupSummaries.map((g) => {
                              const checked = form.ipPolicy.targetGroups.includes(g.name);
                              return (
                                <label
                                  key={g.name}
                                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border cursor-pointer select-none ${
                                    checked
                                      ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                                      : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleGroupSelection(g.name)}
                                    className="rounded text-blue-600"
                                  />
                                  <Folder className="w-3 h-3" />
                                  <span>{g.name}</span>
                                  <span className="font-mono text-[10px] opacity-75">({g.count})</span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {form.ipPolicy.scope === 'hosts' && (
                      <div className="mt-2.5 max-h-40 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 divide-y divide-slate-100 dark:divide-slate-800">
                        {managedHosts.length === 0 ? (
                          <div className="p-3 text-slate-400">{isZh ? '暂无多云主机实例' : 'No managed cloud hosts yet'}</div>
                        ) : (
                          managedHosts.map((h) => {
                            const checked = form.ipPolicy.targetHostIds.includes(h.id);
                            const rule = h.linkedDnsRuleId ? dnsRuleMap.get(h.linkedDnsRuleId) : undefined;
                            const fqdn = rule
                              ? rule.recordName === '@'
                                ? rule.domain
                                : `${rule.recordName}.${rule.domain}`
                              : null;
                            const pBadge =
                              h.provider === 'oracle'
                                ? 'OCI'
                                : h.provider === 'aws'
                                  ? 'AWS'
                                  : h.provider === 'aliyun'
                                    ? '阿里云'
                                    : 'GCP';
                            return (
                              <label
                                key={h.id}
                                className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleHostSelection(h.id)}
                                    className="rounded text-blue-600 shrink-0"
                                  />
                                  <div className="min-w-0">
                                    <div className="font-medium text-slate-900 dark:text-white truncate">
                                      <span className="mr-1.5 font-mono text-[10px] text-blue-600 dark:text-blue-400">
                                        {pBadge}
                                      </span>
                                      {h.name}
                                      <span className="ml-1.5 text-[10px] font-normal text-slate-500">
                                        [{h.groupName || (isZh ? '默认分组' : 'Default')}] · {h.region}
                                      </span>
                                    </div>
                                    <div className="text-[10px] font-mono text-slate-500 truncate">
                                      {fqdn ? `DNS: ${fqdn}` : isZh ? '未绑定域名' : 'Unbound'} · v4: {h.ipv4 || '—'} · v6: {h.ipv6List.length}
                                    </div>
                                  </div>
                                </div>
                              </label>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-800 dark:text-slate-200 mb-1.5">
                      {isZh ? '2. IP 增 / 换 / 删动作' : '2. IP Action Policy'}
                    </label>
                    <select
                      value={form.ipPolicy.action}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          ipPolicy: { ...form.ipPolicy, action: e.target.value as IpPolicyAction },
                        })
                      }
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    >
                      {policyActionOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                      {policyActionOptions.find((o) => o.value === form.ipPolicy.action)?.hint}
                    </p>
                  </div>

                  {(form.ipPolicy.action === 'add_ipv6' || form.ipPolicy.action === 'delete_excess_ipv6') && (
                    <div>
                      <label className="block font-medium mb-1">
                        {form.ipPolicy.action === 'add_ipv6'
                          ? isZh ? '每次为每台实例新增 IPv6 数量 (1-8)' : 'IPv6 Count to Add per Host (1-8)'
                          : isZh ? '每台实例保留 IPv6 数量，超出部分删除 (1-8)' : 'IPv6 Count to Keep per Host (1-8)'}
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={8}
                        value={form.ipPolicy.ipv6Count}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            ipPolicy: {
                              ...form.ipPolicy,
                              ipv6Count: Math.min(8, Math.max(1, Number(e.target.value) || 1)),
                            },
                          })
                        }
                        className="w-32 px-3 py-1.5 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                      />
                    </div>
                  )}

                  <div className="space-y-2 pt-1">
                    <label className="flex items-center gap-2 select-none text-slate-700 dark:text-slate-200">
                      <input
                        type="checkbox"
                        checked={form.ipPolicy.syncDnsAfter}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            ipPolicy: { ...form.ipPolicy, syncDnsAfter: e.target.checked },
                          })
                        }
                        className="rounded text-blue-600"
                      />
                      {isZh
                        ? 'IP 变更后自动同步推送至每台实例绑定的域名 DNS（A + 全部 AAAA）'
                        : 'Automatically sync updated IPv4 & IPv6 to each host bound domain'}
                    </label>
                    <label className="flex items-center gap-2 select-none text-slate-700 dark:text-slate-200">
                      <input
                        type="checkbox"
                        checked={form.ipPolicy.notifyOnComplete}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            ipPolicy: { ...form.ipPolicy, notifyOnComplete: e.target.checked },
                          })
                        }
                        className="rounded text-blue-600"
                      />
                      {isZh ? '执行完成后发送系统通知（Email / Server酱 / Telegram 等）' : 'Send system notification upon completion'}
                    </label>
                  </div>
                </div>
              )}

              <div>
                <label className="block font-medium mb-1">{t('cronExpression')}</label>
                <input
                  required
                  value={form.expression}
                  onChange={(e) => setForm({ ...form, expression: e.target.value })}
                  className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {CRON_PRESETS.map((p) => (
                    <button
                      key={p.expr}
                      type="button"
                      onClick={() => setForm({ ...form, expression: p.expr })}
                      className="px-2 py-1 text-[11px] font-mono rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 font-medium rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  {t('cancel')}
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {editingJob ? t('save') : t('create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

interface AuditLogsViewProps {
  lang: LanguageCode;
}

export function AuditLogsView({ lang }: AuditLogsViewProps) {
  const t = (key: TranslationKeys) => translate(lang, key);
  const isZh = lang === 'zh-CN';
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [category, setCategory] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [enforcing, setEnforcing] = useState(false);
  const [purging, setPurging] = useState(false);

  const loadLogs = useCallback(async (manual = false) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ category, severity, search, limit: '250' });
      const res = await apiRequest<{ stats: AuditStats; entries: AuditLogEntry[] }>(
        `/api/audit/logs?${qs.toString()}`
      );
      setStats(res.stats);
      setEntries(res.entries);
      if (manual) {
        toast.success(
          isZh ? `已刷新审计日志（当前显示 ${res.entries.length} 条）` : `Refreshed ${res.entries.length} audit log(s)`
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : isZh ? '加载审计日志失败' : 'Failed to load audit logs');
    } finally {
      setLoading(false);
    }
  }, [category, severity, search, isZh]);

  useEffect(() => {
    void loadLogs(false);
  }, [loadLogs]);

  const handleEnforceQuota = async () => {
    setEnforcing(true);
    try {
      const res = await apiRequest<{ pruned?: boolean; removedBytes?: number; currentBytes?: number }>(
        '/api/audit/enforce',
        { method: 'POST' }
      );
      await loadLogs(false);
      toast.success(
        res.pruned
          ? isZh
            ? `已自动清理 ${formatBytes(res.removedBytes ?? 0)}，当前大小 ${formatBytes(res.currentBytes ?? 0)}`
            : `Pruned ${formatBytes(res.removedBytes ?? 0)}; current size ${formatBytes(res.currentBytes ?? 0)}`
          : isZh
          ? `审计日志容量正常，无需清理（当前 ${formatBytes(res.currentBytes ?? stats?.fileSizeBytes ?? 0)}）`
          : 'Audit log is within configured size quota'
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : isZh ? '执行容量检查失败' : 'Quota enforcement failed');
    } finally {
      setEnforcing(false);
    }
  };

  const handlePurge = async () => {
    setPurging(true);
    try {
      await apiRequest('/api/audit/purge', { method: 'POST' });
      await loadLogs(false);
      toast.success(isZh ? '已清空全部审计日志' : 'Purged all audit logs');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : isZh ? '清空日志失败' : 'Purge failed');
    } finally {
      setPurging(false);
    }
  };

  const exportFile = (format: 'json' | 'csv') => {
    let content = '';
    let mime = 'application/json';
    if (format === 'json') {
      content = JSON.stringify(entries, null, 2);
    } else {
      mime = 'text/csv';
      const header = 'timestamp,category,severity,action,actor,ip,target,details\n';
      const rows = entries.map((e) =>
        [e.timestamp, e.category, e.severity, e.action, e.actor, e.ip, e.target ?? '', e.details]
          .map((v) => `"${String(v).replaceAll('"', '""')}"`)
          .join(',')
      );
      content = header + rows.join('\n');
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `netpulse-audit.${format}`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(
      isZh
        ? `已导出 ${entries.length} 条审计日志（${format.toUpperCase()}）`
        : `Exported ${entries.length} audit log(s) as ${format.toUpperCase()}`
    );
  };

  const usagePct = stats
    ? Math.min(100, Math.round((stats.fileSizeBytes / Math.max(1, stats.maxSizeBytes)) * 100))
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t('auditTitle')}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t('auditSubtitle')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={enforcing}
            onClick={() => void handleEnforceQuota()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
          >
            {enforcing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldAlert className="w-3.5 h-3.5" />}
            {t('enforceQuotaNow')}
          </button>
          <button
            type="button"
            onClick={() => exportFile('csv')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            {t('exportCsv')}
          </button>
          <button
            type="button"
            onClick={() => exportFile('json')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            {t('exportJson')}
          </button>
          <button
            type="button"
            disabled={purging}
            onClick={() => void handlePurge()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50 whitespace-nowrap"
          >
            {purging ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            {t('purgeAllLogs')}
          </button>
        </div>
      </div>

      {/* Size Quota Bar (always mounted to prevent filter/table jump on initial load) */}
      <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
          <div>
            <div className="text-slate-500 dark:text-slate-400">{t('auditCurrentSize')}</div>
            <div className="mt-1 font-mono text-base font-semibold tabular-nums">
              {stats ? formatBytes(stats.fileSizeBytes) : '—'}
            </div>
          </div>
          <div>
            <div className="text-slate-500 dark:text-slate-400">{t('auditMaxCap')}</div>
            <div className="mt-1 font-mono text-base font-semibold tabular-nums">
              {stats ? formatBytes(stats.maxSizeBytes) : '—'}
            </div>
          </div>
          <div>
            <div className="text-slate-500 dark:text-slate-400">{t('auditTotalEntries')}</div>
            <div className="mt-1 font-mono text-base font-semibold tabular-nums">
              {stats ? stats.totalEntries : '—'}
            </div>
          </div>
          <div>
            <div className="text-slate-500 dark:text-slate-400">{t('auditPruneHistory')}</div>
            <div className="mt-1 font-mono text-base font-semibold tabular-nums">
              {stats ? stats.pruneCount : '—'}
            </div>
          </div>
        </div>
        <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              usagePct > 85 ? 'bg-red-600' : usagePct > 65 ? 'bg-amber-500' : 'bg-blue-600'
            }`}
            style={{ width: `${stats ? Math.max(2, usagePct) : 2}%` }}
          />
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('search')}
          className="flex-1 min-w-0 px-3.5 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
        >
          <option value="all">{t('filterCategory')}: {t('all')}</option>
          <option value="auth">auth</option>
          <option value="dns">dns</option>
          <option value="oci">oci</option>
          <option value="cloud">cloud</option>
          <option value="ip">ip</option>
          <option value="monitor">monitor</option>
          <option value="notify">notify</option>
          <option value="tls">tls</option>
          <option value="cron">cron</option>
          <option value="security">security</option>
          <option value="audit">audit</option>
        </select>
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
        >
          <option value="all">{t('filterSeverity')}: {t('all')}</option>
          <option value="info">info</option>
          <option value="success">success</option>
          <option value="warning">warning</option>
          <option value="error">error</option>
        </select>
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadLogs(true)}
          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          {t('refresh')}
        </button>
      </div>

      {/* Audit Table */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                <th className="py-3 px-6 font-medium whitespace-nowrap">Timestamp</th>
                <th className="py-3 px-4 font-medium whitespace-nowrap">Category</th>
                <th className="py-3 px-4 font-medium whitespace-nowrap">Action</th>
                <th className="py-3 px-4 font-medium whitespace-nowrap">Actor / IP</th>
                <th className="py-3 px-6 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70 text-xs">
              {entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 align-top">
                  <td className="py-3 px-6 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {formatTimeAgo(entry.timestamp)}
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    {entry.category}
                  </td>
                  <td className="py-3 px-4 font-mono font-medium whitespace-nowrap">
                    <span
                      className={
                        entry.severity === 'error'
                          ? 'text-red-600 dark:text-red-400'
                          : entry.severity === 'warning'
                          ? 'text-amber-600 dark:text-amber-400'
                          : entry.severity === 'success'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-slate-800 dark:text-slate-200'
                      }
                    >
                      {entry.action}
                    </span>
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                    {entry.actor} · {entry.ip}
                  </td>
                  <td className="py-3 px-6 text-slate-700 dark:text-slate-300">
                    {entry.target && (
                      <span className="font-mono text-slate-500 dark:text-slate-400 mr-2">
                        [{entry.target}]
                      </span>
                    )}
                    {entry.details}
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-slate-400">
                    {t('noData')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
