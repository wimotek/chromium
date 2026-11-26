import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bell,
  BellOff,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FolderOpen,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import { apiRequest, formatTimeAgo } from '../lib/api';
import { toast } from '../lib/toast';
import type {
  LanguageCode,
  MonitorCheckSample,
  MonitorProbeType,
  MonitorTarget,
  NotificationChannel,
} from '../types/models';

type MonitorStatus = MonitorTarget['status'];

interface MonitorsViewProps {
  monitors: MonitorTarget[];
  notificationChannels: NotificationChannel[];
  lang: LanguageCode;
  onReload: () => Promise<void>;
  onNavigateNotifications: () => void;
}

const HEARTBEAT_BARS_DETAIL = 40;
const HEARTBEAT_BARS_TREE = 14;

function statusBadgeStyle(status: MonitorStatus, enabled: boolean): string {
  if (!enabled) {
    return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400';
  }
  switch (status) {
    case 'up':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400';
    case 'degraded':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400';
    case 'down':
      return 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-400';
    default:
      return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400';
  }
}

function uptimePillStyle(uptime: number | null, status: MonitorStatus | 'paused', enabled: boolean): string {
  if (!enabled || status === 'paused') {
    return 'bg-slate-300 text-slate-700 dark:bg-slate-700 dark:text-slate-300';
  }
  if (status === 'down' || (uptime !== null && uptime < 50)) {
    return 'bg-amber-500 text-white';
  }
  if (status === 'degraded' || (uptime !== null && uptime < 99)) {
    return 'bg-amber-500 text-white';
  }
  if (status === 'up' || (uptime !== null && uptime >= 99)) {
    return 'bg-emerald-500 text-white';
  }
  return 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400';
}

function barColor(sample?: MonitorCheckSample): string {
  if (!sample) return 'bg-slate-200 dark:bg-slate-800';
  if (sample.status === 'up') return 'bg-emerald-500 hover:bg-emerald-400';
  if (sample.status === 'degraded') return 'bg-amber-500 hover:bg-amber-400';
  if (sample.status === 'down') return 'bg-red-500 hover:bg-red-400';
  return 'bg-slate-400';
}

function treeBarColor(state: 'up' | 'degraded' | 'down' | 'none'): string {
  if (state === 'up') return 'bg-emerald-500';
  if (state === 'degraded') return 'bg-amber-500';
  if (state === 'down') return 'bg-red-500';
  return 'bg-slate-200 dark:bg-slate-800';
}

function computeUptimePct(history: MonitorCheckSample[]): number | null {
  if (!history || history.length === 0) return null;
  const healthy = history.filter((h) => h.status === 'up' || h.status === 'degraded').length;
  return Math.round((healthy / history.length) * 10000) / 100;
}

function computeAvgLatency(history: MonitorCheckSample[]): number | null {
  const valid = (history || []).filter((h) => h.latencyMs > 0 && h.status !== 'down');
  if (valid.length === 0) return null;
  const sum = valid.reduce((acc, s) => acc + s.latencyMs, 0);
  return Math.round(sum / valid.length);
}

export function MonitorsView({
  monitors,
  notificationChannels,
  lang,
  onReload,
  onNavigateNotifications,
}: MonitorsViewProps) {
  const isZh = lang === 'zh-CN';

  // Live auto-polled monitor list (every 10s)
  const [liveMonitors, setLiveMonitors] = useState<MonitorTarget[]>(monitors);
  useEffect(() => {
    setLiveMonitors(monitors);
  }, [monitors]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const fresh = await apiRequest<MonitorTarget[]>('/api/monitors');
        if (!cancelled && Array.isArray(fresh)) {
          setLiveMonitors(fresh);
        }
      } catch {
        // silent background poll
      }
    };
    const timer = window.setInterval(() => void poll(), 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'up' | 'down' | 'paused'>('all');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [checkingAll, setCheckingAll] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [hoveredSampleIdx, setHoveredSampleIdx] = useState<number | null>(null);

  // Add / Edit Modal
  const [showModal, setShowModal] = useState(false);
  const [editingMonitor, setEditingMonitor] = useState<MonitorTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: '',
    groupName: '',
    type: 'https' as MonitorProbeType,
    target: '',
    port: '443',
    expectedIp: '',
    httpMethod: 'GET' as 'GET' | 'HEAD',
    expectedStatusCodes: '200-399',
    httpKeyword: '',
    ignoreTlsErrors: false,
    checkTlsCert: true,
    tlsCertWarningDays: '14',
    intervalSeconds: '60',
    timeoutMs: '5000',
    failureThreshold: '2',
    enabled: true,
    notifyOnDown: true,
    notifyOnRecover: true,
    notifyChannelIds: [] as string[],
  });

  const isWebType = (t: MonitorProbeType) => t === 'http' || t === 'https';
  const isHttpsMonitor = (m: Pick<MonitorTarget, 'type' | 'target'>) =>
    m.type === 'https' || (m.type === 'http' && m.target.trim().toLowerCase().startsWith('https://'));
  const getMonitorTypeBadge = (m: Pick<MonitorTarget, 'type' | 'target'>) => {
    if (isHttpsMonitor(m)) return 'HTTPS';
    return m.type.toUpperCase();
  };

  const channelMap = useMemo(
    () => new Map(notificationChannels.map((c) => [c.id, c])),
    [notificationChannels]
  );

  const existingGroupNames = useMemo(() => {
    const set = new Set<string>();
    for (const m of liveMonitors) {
      const g = (m.groupName || '').trim();
      if (g) set.add(g);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [liveMonitors]);

  const stats = useMemo(() => {
    let up = 0;
    let degraded = 0;
    let down = 0;
    let paused = 0;
    let latencySum = 0;
    let latencyCount = 0;
    for (const m of liveMonitors) {
      if (!m.enabled) {
        paused += 1;
      } else if (m.status === 'up') {
        up += 1;
      } else if (m.status === 'degraded') {
        degraded += 1;
      } else if (m.status === 'down') {
        down += 1;
      }
      if (typeof m.lastLatencyMs === 'number' && m.lastLatencyMs > 0 && m.status !== 'down') {
        latencySum += m.lastLatencyMs;
        latencyCount += 1;
      }
    }
    return {
      total: liveMonitors.length,
      up,
      degraded,
      down,
      paused,
      avgLatency: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
    };
  }, [liveMonitors]);

  const filteredMonitors = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return liveMonitors.filter((m) => {
      if (statusFilter === 'up' && (!m.enabled || m.status !== 'up')) return false;
      if (statusFilter === 'down' && (!m.enabled || (m.status !== 'down' && m.status !== 'degraded'))) return false;
      if (statusFilter === 'paused' && m.enabled) return false;
      if (!q) return true;
      return `${m.name} ${m.target} ${m.type} ${m.groupName || ''}`.toLowerCase().includes(q);
    });
  }, [liveMonitors, searchQuery, statusFilter]);

  const monitorTree = useMemo(() => {
    const groupMap = new Map<string, MonitorTarget[]>();
    const ungrouped: MonitorTarget[] = [];
    for (const m of filteredMonitors) {
      const g = (m.groupName || '').trim();
      if (!g) {
        ungrouped.push(m);
      } else {
        const list = groupMap.get(g) ?? [];
        list.push(m);
        groupMap.set(g, list);
      }
    }

    const groups = Array.from(groupMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, items]) => {
        const enabledItems = items.filter((i) => i.enabled);
        const uptimes = items
          .map((i) => computeUptimePct(i.history))
          .filter((v): v is number => v !== null);
        const avgUptime =
          uptimes.length > 0
            ? Math.round((uptimes.reduce((s, v) => s + v, 0) / uptimes.length) * 100) / 100
            : null;

        let status: MonitorStatus | 'paused' = 'pending';
        if (enabledItems.length === 0) {
          status = 'paused';
        } else if (enabledItems.some((i) => i.status === 'down')) {
          status = 'down';
        } else if (enabledItems.some((i) => i.status === 'degraded')) {
          status = 'degraded';
        } else if (enabledItems.some((i) => i.status === 'up')) {
          status = 'up';
        }

        // Aggregate last HEARTBEAT_BARS_TREE slots across group monitors
        const bars: Array<'up' | 'degraded' | 'down' | 'none'> = [];
        for (let slot = 0; slot < HEARTBEAT_BARS_TREE; slot++) {
          let sawUp = false;
          let sawDegraded = false;
          let sawDown = false;
          for (const child of items) {
            const hist = (child.history || []).slice(-HEARTBEAT_BARS_TREE);
            const pad = Math.max(0, HEARTBEAT_BARS_TREE - hist.length);
            const sample = slot >= pad ? hist[slot - pad] : undefined;
            if (!sample) continue;
            if (sample.status === 'down') sawDown = true;
            else if (sample.status === 'degraded') sawDegraded = true;
            else if (sample.status === 'up') sawUp = true;
          }
          if (sawDown && !sawUp) bars.push('down');
          else if (sawDown || sawDegraded) bars.push('degraded');
          else if (sawUp) bars.push('up');
          else bars.push('none');
        }

        return {
          name,
          items,
          avgUptime,
          status,
          bars,
          hasActiveChild: items.some((i) => i.id === selectedId),
        };
      });

    return { groups, ungrouped };
  }, [filteredMonitors, selectedId]);

  const toggleGroupExpand = (groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      return next;
    });
  };

  const allGroupsCollapsed =
    monitorTree.groups.length > 0 &&
    monitorTree.groups.every((g) => collapsedGroups.has(g.name));

  const toggleAllGroups = () => {
    if (allGroupsCollapsed) {
      setCollapsedGroups(new Set());
    } else {
      setCollapsedGroups(new Set(monitorTree.groups.map((g) => g.name)));
    }
  };

  const selectedMonitor = useMemo(() => {
    if (selectedId) {
      const found = liveMonitors.find((m) => m.id === selectedId);
      if (found) return found;
    }
    return filteredMonitors[0] ?? liveMonitors[0] ?? null;
  }, [selectedId, liveMonitors, filteredMonitors]);

  const openCreateModal = () => {
    setEditingMonitor(null);
    setForm({
      name: '',
      groupName: isZh ? '核心服务' : 'Core Services',
      type: 'https',
      target: 'https://',
      port: '443',
      expectedIp: '',
      httpMethod: 'GET',
      expectedStatusCodes: '200-399',
      httpKeyword: '',
      ignoreTlsErrors: false,
      checkTlsCert: true,
      tlsCertWarningDays: '14',
      intervalSeconds: '60',
      timeoutMs: '5000',
      failureThreshold: '2',
      enabled: true,
      notifyOnDown: true,
      notifyOnRecover: true,
      notifyChannelIds: [],
    });
    setShowModal(true);
  };

  const openEditModal = (m: MonitorTarget) => {
    setEditingMonitor(m);
    const normalizedType: MonitorProbeType =
      m.type === 'http' && m.target.trim().toLowerCase().startsWith('https://') ? 'https' : m.type;
    setForm({
      name: m.name,
      groupName: m.groupName || '',
      type: normalizedType,
      target: m.target,
      port: String(m.port ?? 443),
      expectedIp: m.expectedIp || '',
      httpMethod: m.httpMethod === 'HEAD' ? 'HEAD' : 'GET',
      expectedStatusCodes: m.expectedStatusCodes || '200-399',
      httpKeyword: m.httpKeyword || '',
      ignoreTlsErrors: Boolean(m.ignoreTlsErrors),
      checkTlsCert: m.checkTlsCert !== false,
      tlsCertWarningDays: String(m.tlsCertWarningDays ?? 14),
      intervalSeconds: String(m.intervalSeconds || 60),
      timeoutMs: String(m.timeoutMs || 5000),
      failureThreshold: String(m.failureThreshold || 2),
      enabled: m.enabled,
      notifyOnDown: m.notifyOnDown !== false,
      notifyOnRecover: m.notifyOnRecover !== false,
      notifyChannelIds: m.notifyChannelIds ?? [],
    });
    setShowModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const webProbe = isWebType(form.type);
      const rawTarget = form.target.trim();
      const normalizedTarget = webProbe
        ? /^https?:\/\//i.test(rawTarget)
          ? rawTarget
          : `${form.type}://${rawTarget}`
        : rawTarget;
      const httpsMode = form.type === 'https' || normalizedTarget.toLowerCase().startsWith('https://');
      const payload = {
        name: form.name.trim(),
        groupName: form.groupName.trim() || undefined,
        type: form.type,
        target: normalizedTarget,
        port: form.type === 'tcp' ? Math.max(1, Math.min(65535, Number(form.port) || 443)) : undefined,
        expectedIp: form.type === 'dns' ? form.expectedIp.trim() || undefined : undefined,
        httpMethod: webProbe ? form.httpMethod : undefined,
        expectedStatusCodes: webProbe ? form.expectedStatusCodes.trim() || '200-399' : undefined,
        httpKeyword: webProbe ? form.httpKeyword.trim() || undefined : undefined,
        ignoreTlsErrors: httpsMode ? form.ignoreTlsErrors : false,
        checkTlsCert: httpsMode ? form.checkTlsCert : false,
        tlsCertWarningDays: httpsMode
          ? Math.max(1, Math.min(365, Number(form.tlsCertWarningDays) || 14))
          : undefined,
        intervalSeconds: Math.max(15, Number(form.intervalSeconds) || 60),
        timeoutMs: Math.max(1000, Math.min(30000, Number(form.timeoutMs) || 5000)),
        failureThreshold: Math.max(1, Math.min(10, Number(form.failureThreshold) || 2)),
        enabled: form.enabled,
        notifyOnDown: form.notifyOnDown,
        notifyOnRecover: form.notifyOnRecover,
        notifyChannelIds: form.notifyChannelIds,
      };
      if (editingMonitor) {
        const updated = await apiRequest<MonitorTarget>(`/api/monitors/${editingMonitor.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        setSelectedId(updated.id);
      } else {
        const created = await apiRequest<MonitorTarget>('/api/monitors', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setSelectedId(created.id);
      }
      setShowModal(false);
      await onReload();
      toast.success(isZh ? '监控项已保存生效' : 'Monitor saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save monitor');
    } finally {
      setSaving(false);
    }
  };

  const handleCheckAll = async () => {
    setCheckingAll(true);
    try {
      await apiRequest('/api/monitors/check-all', { method: 'POST' });
      const fresh = await apiRequest<MonitorTarget[]>('/api/monitors');
      setLiveMonitors(fresh);
      await onReload();
      toast.success(isZh ? '已完成全部启用探针即时探测' : 'Checked all enabled monitors');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Check all failed');
    } finally {
      setCheckingAll(false);
    }
  };

  const handleCheckOne = async (m: MonitorTarget) => {
    setCheckingId(m.id);
    try {
      const res = await apiRequest<MonitorTarget | { monitor?: MonitorTarget; sample?: MonitorCheckSample }>(
        `/api/monitors/${m.id}/check`,
        { method: 'POST' }
      );
      const updatedMon = 'monitor' in res && res.monitor ? res.monitor : 'id' in res ? res : undefined;
      if (updatedMon) {
        setLiveMonitors((prev) => prev.map((x) => (x.id === m.id ? updatedMon : x)));
      }
      await onReload();
      const s =
        'sample' in res && res.sample
          ? res.sample
          : updatedMon?.history?.[updatedMon.history.length - 1];
      toast.show(
        `${m.name}: ${s?.status.toUpperCase() ?? updatedMon?.status.toUpperCase() ?? ''} (${s?.latencyMs ?? updatedMon?.lastLatencyMs ?? 0}ms) ${s?.message ?? updatedMon?.lastMessage ?? ''}`,
        s?.status === 'down' ? 'error' : s?.status === 'degraded' ? 'warning' : 'success'
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Check failed');
    } finally {
      setCheckingId(null);
    }
  };

  const handleTogglePause = async (m: MonitorTarget) => {
    setTogglingId(m.id);
    try {
      const updated = await apiRequest<MonitorTarget>(`/api/monitors/${m.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !m.enabled }),
      });
      setLiveMonitors((prev) => prev.map((x) => (x.id === m.id ? updated : x)));
      await onReload();
      toast.info(
        updated.enabled
          ? isZh
            ? `已恢复监控「${m.name}」`
            : `Resumed "${m.name}"`
          : isZh
          ? `已暂停监控「${m.name}」`
          : `Paused "${m.name}"`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Toggle failed');
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async (m: MonitorTarget) => {
    setDeletingId(m.id);
    try {
      await apiRequest(`/api/monitors/${m.id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      setLiveMonitors((prev) => prev.filter((x) => x.id !== m.id));
      if (selectedId === m.id) setSelectedId(null);
      await onReload();
      toast.success(isZh ? `已删除监控项「${m.name}」` : `Deleted monitor "${m.name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  };

  const renderHeartbeatStrip = (
    history: MonitorCheckSample[],
    slots: number,
    interactive = false
  ) => {
    const slice = (history || []).slice(-slots);
    const padCount = Math.max(0, slots - slice.length);
    const items: Array<MonitorCheckSample | undefined> = [
      ...Array.from({ length: padCount }, () => undefined),
      ...slice,
    ];
    return (
      <div className="flex items-center gap-[3px] w-full">
        {items.map((sample, idx) => (
          <div
            key={idx}
            onMouseEnter={interactive ? () => setHoveredSampleIdx(idx) : undefined}
            onMouseLeave={interactive ? () => setHoveredSampleIdx(null) : undefined}
            title={
              sample
                ? `${new Date(sample.timestamp).toLocaleString()} · ${sample.status.toUpperCase()} · ${sample.latencyMs}ms · ${sample.message}`
                : isZh
                ? '暂无探测数据'
                : 'No data'
            }
            className={`flex-1 rounded-sm transition-all ${
              interactive ? 'h-8 cursor-pointer' : 'h-4'
            } ${barColor(sample)} ${
              interactive && hoveredSampleIdx === idx ? 'ring-2 ring-blue-500 scale-y-110' : ''
            }`}
          />
        ))}
      </div>
    );
  };

  const selectedDetailSlots = useMemo(() => {
    if (!selectedMonitor) return [];
    const slice = (selectedMonitor.history || []).slice(-HEARTBEAT_BARS_DETAIL);
    const padCount = Math.max(0, HEARTBEAT_BARS_DETAIL - slice.length);
    return [...Array.from({ length: padCount }, () => undefined), ...slice];
  }, [selectedMonitor]);

  const hoveredSample =
    hoveredSampleIdx !== null ? selectedDetailSlots[hoveredSampleIdx] : undefined;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2.5">
            <Activity className="w-6 h-6 text-emerald-600 dark:text-emerald-400 shrink-0" />
            {isZh ? '实时监控探针（Uptime 中心）' : 'Live Monitors & Heartbeat'}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {isZh
              ? '持续监测 HTTP(S) 状态码与响应关键词、SSL 证书到期时间、TCP 端口与 DNS 解析，支持独立配置上线/下线通知与每 10 秒心跳实时刷新。'
              : 'Continuous live probes for HTTP(S) status & keyword assertions, SSL certificate expiry, TCP ports, and DNS records — with independent down & recovery alerts.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onNavigateNotifications}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            <Bell className="w-3.5 h-3.5" />
            {isZh ? `通知渠道 (${notificationChannels.filter((c) => c.enabled).length})` : `Alert Channels (${notificationChannels.filter((c) => c.enabled).length})`}
          </button>
          <button
            type="button"
            disabled={checkingAll || liveMonitors.length === 0}
            onClick={() => void handleCheckAll()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${checkingAll ? 'animate-spin' : ''}`} />
            {isZh ? '全部立即探测' : 'Check All Now'}
          </button>
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            {isZh ? '新增监控项' : 'Add Monitor'}
          </button>
        </div>
      </div>

      {/* Top KPI Summary Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="text-xs text-slate-500 dark:text-slate-400">{isZh ? '在线正常 (UP)' : 'Up'}</div>
          <div className="mt-1 font-mono text-2xl font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
            {stats.up}
          </div>
        </div>
        <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="text-xs text-slate-500 dark:text-slate-400">{isZh ? '宕机告警 (DOWN)' : 'Down'}</div>
          <div className="mt-1 font-mono text-2xl font-bold text-red-600 dark:text-red-400 tabular-nums">
            {stats.down}
          </div>
        </div>
        <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="text-xs text-slate-500 dark:text-slate-400">{isZh ? '波动降级' : 'Degraded'}</div>
          <div className="mt-1 font-mono text-2xl font-bold text-amber-600 dark:text-amber-400 tabular-nums">
            {stats.degraded}
          </div>
        </div>
        <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="text-xs text-slate-500 dark:text-slate-400">{isZh ? '已暂停' : 'Paused'}</div>
          <div className="mt-1 font-mono text-2xl font-bold text-slate-500 dark:text-slate-400 tabular-nums">
            {stats.paused}
          </div>
        </div>
        <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 col-span-2 sm:col-span-1">
          <div className="text-xs text-slate-500 dark:text-slate-400">{isZh ? '平均响应延迟' : 'Avg Ping'}</div>
          <div className="mt-1 font-mono text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
            {stats.avgLatency !== null ? `${stats.avgLatency}ms` : '—'}
          </div>
        </div>
      </div>

      {/* Main Split Workspace */}
      {liveMonitors.length === 0 ? (
        <div className="p-12 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-center space-y-3">
          <Activity className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto" />
          <div className="text-base font-semibold text-slate-800 dark:text-slate-200">
            {isZh ? '尚未配置任何实时监控探针' : 'No live monitors yet'}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
            {isZh
              ? '添加网站 HTTP(S)、服务器 TCP 端口或域名 DNS 解析监控，系统将持续探测并记录心跳曲线，在服务下线或恢复上线时自动发送告警通知。'
              : 'Add HTTP(S), TCP port, or DNS probes to track uptime heartbeats and receive instant down/recovery notifications.'}
          </p>
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
          >
            <Plus className="w-3.5 h-3.5" />
            {isZh ? '添加第一个监控项' : 'Create First Monitor'}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* Left Monitor Group Tree */}
          <div className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="p-3 border-b border-slate-200 dark:border-slate-800 space-y-2.5">
              <div className="flex items-center gap-2">
                <div className="relative flex-1 min-w-0">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={isZh ? '搜索监控名称、URL、分组...' : 'Search monitor, target, group...'}
                    className="w-full pl-8 pr-7 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                {monitorTree.groups.length > 0 && (
                  <button
                    type="button"
                    onClick={toggleAllGroups}
                    title={
                      allGroupsCollapsed
                        ? isZh
                          ? '展开全部分组'
                          : 'Expand all groups'
                        : isZh
                          ? '折叠全部分组'
                          : 'Collapse all groups'
                    }
                    className="px-2 py-1.5 text-[11px] font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                  >
                    {allGroupsCollapsed ? (isZh ? '展开' : 'Expand') : isZh ? '折叠' : 'Collapse'}
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1 text-[11px]">
                {(
                  [
                    ['all', isZh ? `全部 (${stats.total})` : `All (${stats.total})`],
                    ['up', isZh ? `在线 (${stats.up})` : `Up (${stats.up})`],
                    ['down', isZh ? `异常 (${stats.down + stats.degraded})` : `Issues (${stats.down + stats.degraded})`],
                    ['paused', isZh ? `暂停 (${stats.paused})` : `Paused (${stats.paused})`],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setStatusFilter(key)}
                    className={`px-2 py-1 rounded-md font-medium transition-colors ${
                      statusFilter === key
                        ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-2 space-y-1 max-h-[680px] overflow-y-auto">
              {/* Grouped Monitor Tree */}
              {monitorTree.groups.map((grp) => {
                const isExpanded = searchQuery.trim().length > 0 || !collapsedGroups.has(grp.name);
                return (
                  <div key={grp.name} className="space-y-1">
                    {/* Parent Group Row */}
                    <button
                      type="button"
                      onClick={() => toggleGroupExpand(grp.name)}
                      className={`w-full text-left px-2.5 py-2.5 rounded-lg transition-colors flex items-center justify-between gap-2 ${
                        grp.hasActiveChild && !isExpanded
                          ? 'bg-emerald-50/90 dark:bg-emerald-950/30 ring-1 ring-emerald-200 dark:ring-emerald-800/60'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`inline-flex items-center justify-center min-w-[52px] px-2 py-0.5 rounded-full font-mono text-[11px] font-bold tabular-nums shrink-0 ${uptimePillStyle(
                            grp.avgUptime,
                            grp.status,
                            grp.status !== 'paused'
                          )}`}
                        >
                          {grp.avgUptime !== null ? `${grp.avgUptime}%` : grp.status === 'paused' ? 'OFF' : '—'}
                        </span>
                        <span className="text-slate-400 shrink-0">
                          {isExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5" />
                          )}
                        </span>
                        <span className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                          {grp.name}
                        </span>
                        <span className="text-[10px] font-mono text-slate-400 tabular-nums shrink-0">
                          ({grp.items.length})
                        </span>
                      </div>

                      {/* Aggregated Mini Heartbeat Bars */}
                      <div className="flex items-center gap-[2.5px] shrink-0">
                        {grp.bars.map((st, idx) => (
                          <span
                            key={idx}
                            className={`w-[4px] h-4 rounded-full ${treeBarColor(st)}`}
                          />
                        ))}
                      </div>
                    </button>

                    {/* Indented Child Monitors */}
                    {isExpanded && (
                      <div className="ml-4 pl-2.5 border-l border-slate-200 dark:border-slate-800 space-y-1">
                        {grp.items.map((m) => {
                          const active = selectedMonitor?.id === m.id;
                          const uptime = computeUptimePct(m.history);
                          const hist = (m.history || []).slice(-HEARTBEAT_BARS_TREE);
                          const pad = Math.max(0, HEARTBEAT_BARS_TREE - hist.length);
                          const miniSlots: Array<MonitorCheckSample | undefined> = [
                            ...Array.from({ length: pad }, () => undefined),
                            ...hist,
                          ];
                          const tlsWarn =
                            isHttpsMonitor(m) &&
                            !m.ignoreTlsErrors &&
                            typeof m.tlsDaysRemaining === 'number' &&
                            m.tlsDaysRemaining <= (m.tlsCertWarningDays ?? 14);
                          const typeBadge = getMonitorTypeBadge(m);
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => {
                                setSelectedId(m.id);
                                setConfirmDeleteId(null);
                                setHoveredSampleIdx(null);
                              }}
                              className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors flex items-center justify-between gap-2 ${
                                active
                                  ? 'bg-emerald-50/90 dark:bg-emerald-950/35 ring-1 ring-emerald-200 dark:ring-emerald-800/70'
                                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/45'
                              }`}
                            >
                              <div className="flex items-start gap-2 min-w-0">
                                <span
                                  className={`inline-flex items-center justify-center min-w-[50px] px-1.5 py-0.5 rounded-full font-mono text-[10px] font-bold tabular-nums shrink-0 mt-0.5 ${uptimePillStyle(
                                    uptime,
                                    m.status,
                                    m.enabled
                                  )}`}
                                >
                                  {!m.enabled ? 'OFF' : uptime !== null ? `${uptime}%` : '—'}
                                </span>
                                <div className="min-w-0">
                                  <div className="text-xs font-medium text-slate-900 dark:text-white truncate">
                                    {m.name}
                                  </div>
                                  <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                                    <span
                                      className={`px-1.5 py-[1px] rounded font-mono text-[10px] font-semibold uppercase ${
                                        typeBadge === 'HTTP'
                                          ? 'bg-sky-600/10 dark:bg-sky-500/20 text-sky-700 dark:text-sky-300'
                                          : 'bg-blue-600/10 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300'
                                      }`}
                                    >
                                      {typeBadge}
                                    </span>
                                    {m.enabled && typeof m.lastLatencyMs === 'number' && (
                                      <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                                        {m.lastLatencyMs}ms
                                      </span>
                                    )}
                                    {tlsWarn && (
                                      <span className="font-mono text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                                        SSL {m.tlsDaysRemaining}d
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-[2.5px] shrink-0">
                                {miniSlots.map((sample, idx) => (
                                  <span
                                    key={idx}
                                    className={`w-[4px] h-3.5 rounded-full ${
                                      !sample
                                        ? 'bg-slate-200 dark:bg-slate-800'
                                        : sample.status === 'up'
                                          ? 'bg-emerald-500'
                                          : sample.status === 'degraded'
                                            ? 'bg-amber-500'
                                            : 'bg-red-500'
                                    }`}
                                  />
                                ))}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Ungrouped Root-Level Monitors */}
              {monitorTree.ungrouped.map((m) => {
                const active = selectedMonitor?.id === m.id;
                const uptime = computeUptimePct(m.history);
                const hist = (m.history || []).slice(-HEARTBEAT_BARS_TREE);
                const pad = Math.max(0, HEARTBEAT_BARS_TREE - hist.length);
                const miniSlots: Array<MonitorCheckSample | undefined> = [
                  ...Array.from({ length: pad }, () => undefined),
                  ...hist,
                ];
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(m.id);
                      setConfirmDeleteId(null);
                      setHoveredSampleIdx(null);
                    }}
                    className={`w-full text-left px-2.5 py-2.5 rounded-lg transition-colors flex items-center justify-between gap-2 ${
                      active
                        ? 'bg-emerald-50/90 dark:bg-emerald-950/35 ring-1 ring-emerald-200 dark:ring-emerald-800/70'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/45'
                    }`}
                  >
                    <div className="flex items-start gap-2 min-w-0">
                      <span
                        className={`inline-flex items-center justify-center min-w-[52px] px-2 py-0.5 rounded-full font-mono text-[11px] font-bold tabular-nums shrink-0 mt-0.5 ${uptimePillStyle(
                          uptime,
                          m.status,
                          m.enabled
                        )}`}
                      >
                        {!m.enabled ? 'OFF' : uptime !== null ? `${uptime}%` : '—'}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                          {m.name}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span
                            className={`px-1.5 py-[1px] rounded font-mono text-[10px] font-semibold uppercase ${
                              getMonitorTypeBadge(m) === 'HTTP'
                                ? 'bg-sky-600/10 dark:bg-sky-500/20 text-sky-700 dark:text-sky-300'
                                : 'bg-blue-600/10 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300'
                            }`}
                          >
                            {getMonitorTypeBadge(m)}
                          </span>
                          {m.enabled && typeof m.lastLatencyMs === 'number' && (
                            <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                              {m.lastLatencyMs}ms
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-[2.5px] shrink-0">
                      {miniSlots.map((sample, idx) => (
                        <span
                          key={idx}
                          className={`w-[4px] h-4 rounded-full ${
                            !sample
                              ? 'bg-slate-200 dark:bg-slate-800'
                              : sample.status === 'up'
                                ? 'bg-emerald-500'
                                : sample.status === 'degraded'
                                  ? 'bg-amber-500'
                                  : 'bg-red-500'
                          }`}
                        />
                      ))}
                    </div>
                  </button>
                );
              })}

              {filteredMonitors.length === 0 && (
                <div className="p-8 text-center text-xs text-slate-400">
                  {isZh ? '没有匹配的监控项' : 'No matching monitors'}
                </div>
              )}
            </div>
          </div>

          {/* Right Detailed Inspector */}
          <div className="lg:col-span-8 space-y-4">
            {selectedMonitor && (
              <>
                <div className="p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-5">
                  {/* Monitor Title + Action Toolbar */}
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white truncate">
                          {selectedMonitor.name}
                        </h2>
                        <span
                          className={`px-2 py-0.5 rounded-md font-mono text-xs font-bold uppercase ${statusBadgeStyle(
                            selectedMonitor.status,
                            selectedMonitor.enabled
                          )}`}
                        >
                          {!selectedMonitor.enabled
                            ? isZh
                              ? '已暂停'
                              : 'PAUSED'
                            : selectedMonitor.status}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-[11px] uppercase text-slate-600 dark:text-slate-300">
                          {getMonitorTypeBadge(selectedMonitor)}
                        </span>
                        {isHttpsMonitor(selectedMonitor) && selectedMonitor.ignoreTlsErrors && (
                          <span className="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 font-mono text-[10px] font-semibold">
                            {isZh ? '忽略 TLS/SSL 错误' : 'Ignore TLS/SSL'}
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-slate-500 dark:text-slate-400">
                        {isWebType(selectedMonitor.type) ? (
                          <a
                            href={
                              /^https?:\/\//i.test(selectedMonitor.target)
                                ? selectedMonitor.target
                                : `${selectedMonitor.type}://${selectedMonitor.target}`
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline break-all"
                          >
                            {selectedMonitor.target}
                            <ExternalLink className="w-3 h-3 shrink-0" />
                          </a>
                        ) : (
                          <span>
                            {selectedMonitor.target}
                            {selectedMonitor.port ? `:${selectedMonitor.port}` : ''}
                            {selectedMonitor.expectedIp ? ` -> ${selectedMonitor.expectedIp}` : ''}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={checkingId === selectedMonitor.id}
                        onClick={() => void handleCheckOne(selectedMonitor)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                      >
                        {checkingId === selectedMonitor.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Zap className="w-3.5 h-3.5" />
                        )}
                        {isZh ? '立即探测' : 'Probe'}
                      </button>
                      <button
                        type="button"
                        disabled={togglingId === selectedMonitor.id}
                        onClick={() => void handleTogglePause(selectedMonitor)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border disabled:opacity-50 ${
                          selectedMonitor.enabled
                            ? 'border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30'
                            : 'border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30'
                        }`}
                      >
                        {selectedMonitor.enabled ? (
                          <>
                            <Pause className="w-3.5 h-3.5" />
                            {isZh ? '暂停' : 'Pause'}
                          </>
                        ) : (
                          <>
                            <Play className="w-3.5 h-3.5" />
                            {isZh ? '恢复' : 'Resume'}
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditModal(selectedMonitor)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        {isZh ? '编辑' : 'Edit'}
                      </button>
                      {confirmDeleteId === selectedMonitor.id ? (
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            disabled={deletingId === selectedMonitor.id}
                            onClick={() => void handleDelete(selectedMonitor)}
                            className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                          >
                            {isZh ? '确认删除' : 'Confirm'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-2 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700"
                          >
                            {isZh ? '取消' : 'Cancel'}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(selectedMonitor.id)}
                          title={isZh ? '删除监控项' : 'Delete monitor'}
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 40-bar Heartbeat Strip */}
                  <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-medium text-slate-700 dark:text-slate-300">
                        {isZh ? `最近 ${HEARTBEAT_BARS_DETAIL} 次心跳记录` : `Last ${HEARTBEAT_BARS_DETAIL} Heartbeats`}
                      </span>
                      <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                        {hoveredSample
                          ? `${new Date(hoveredSample.timestamp).toLocaleString()} · ${hoveredSample.status.toUpperCase()} · ${hoveredSample.latencyMs}ms · ${hoveredSample.message}`
                          : selectedMonitor.lastCheckedAt
                          ? `${isZh ? '最近探测' : 'Last check'}: ${formatTimeAgo(selectedMonitor.lastCheckedAt)} (${selectedMonitor.lastMessage || 'OK'})`
                          : isZh
                          ? '等待首次探测...'
                          : 'Awaiting first probe...'}
                      </span>
                    </div>
                    {renderHeartbeatStrip(selectedMonitor.history, HEARTBEAT_BARS_DETAIL, true)}
                    <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                      <span>{isZh ? '较早' : 'Older'}</span>
                      <span>
                        {isZh
                          ? `每 ${selectedMonitor.intervalSeconds} 秒探测一次 · 连续失败 ${selectedMonitor.failureThreshold} 次触发下线告警`
                          : `Every ${selectedMonitor.intervalSeconds}s · Down alert after ${selectedMonitor.failureThreshold} failure(s)`}
                      </span>
                      <span>{isZh ? '最新' : 'Now'}</span>
                    </div>
                  </div>

                  {/* 4 KPI Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-950/40">
                      <div className="text-slate-500 dark:text-slate-400">{isZh ? '当前延迟' : 'Current Ping'}</div>
                      <div className="mt-1 font-mono text-lg font-bold text-slate-900 dark:text-white tabular-nums">
                        {typeof selectedMonitor.lastLatencyMs === 'number'
                          ? `${selectedMonitor.lastLatencyMs} ms`
                          : '—'}
                      </div>
                    </div>
                    <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-950/40">
                      <div className="text-slate-500 dark:text-slate-400">{isZh ? '平均延迟' : 'Avg Ping'}</div>
                      <div className="mt-1 font-mono text-lg font-bold text-slate-900 dark:text-white tabular-nums">
                        {(() => {
                          const avg = computeAvgLatency(selectedMonitor.history);
                          return avg !== null ? `${avg} ms` : '—';
                        })()}
                      </div>
                    </div>
                    <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-950/40">
                      <div className="text-slate-500 dark:text-slate-400">{isZh ? '可用率' : 'Uptime'}</div>
                      <div className="mt-1 font-mono text-lg font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                        {(() => {
                          const up = computeUptimePct(selectedMonitor.history);
                          return up !== null ? `${up}%` : '—';
                        })()}
                      </div>
                    </div>
                    <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-950/40">
                      <div className="text-slate-500 dark:text-slate-400">{isZh ? '校验规则' : 'Assertions'}</div>
                      <div className="mt-1 font-mono text-xs text-slate-700 dark:text-slate-300 truncate">
                        {isWebType(selectedMonitor.type)
                          ? `${getMonitorTypeBadge(selectedMonitor)} ${selectedMonitor.httpMethod || 'GET'} ${selectedMonitor.expectedStatusCodes || '200-399'}${
                              selectedMonitor.httpKeyword ? ` · "${selectedMonitor.httpKeyword}"` : ''
                            }${isHttpsMonitor(selectedMonitor) && selectedMonitor.ignoreTlsErrors ? ' · Ignore TLS' : ''}`
                          : selectedMonitor.type === 'tcp'
                          ? `TCP :${selectedMonitor.port || 443}`
                          : selectedMonitor.expectedIp
                          ? `DNS == ${selectedMonitor.expectedIp}`
                          : 'DNS A/AAAA'}
                      </div>
                    </div>
                  </div>

                  {/* SSL / TLS Certificate Expiry Strip for HTTPS Monitors */}
                  {isHttpsMonitor(selectedMonitor) &&
                    (selectedMonitor.checkTlsCert !== false || selectedMonitor.ignoreTlsErrors) && (
                      <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/50 flex flex-wrap items-center justify-between gap-3 text-xs">
                        <div className="flex flex-wrap items-center gap-2.5">
                          <ShieldCheck
                            className={`w-4 h-4 shrink-0 ${
                              selectedMonitor.ignoreTlsErrors
                                ? 'text-amber-500'
                                : typeof selectedMonitor.tlsDaysRemaining !== 'number'
                                ? 'text-slate-400'
                                : selectedMonitor.tlsDaysRemaining <= 0
                                ? 'text-red-600 dark:text-red-400'
                                : selectedMonitor.tlsDaysRemaining <= (selectedMonitor.tlsCertWarningDays ?? 14)
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-emerald-600 dark:text-emerald-400'
                            }`}
                          />
                          <span className="font-semibold text-slate-800 dark:text-slate-200">
                            {isZh ? 'SSL/TLS 证书：' : 'SSL/TLS:'}
                          </span>
                          {selectedMonitor.ignoreTlsErrors && (
                            <span className="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 font-mono text-[11px] font-semibold">
                              {isZh ? '已开启忽略 TLS/SSL 错误' : 'Ignore TLS/SSL errors ON'}
                            </span>
                          )}
                          {selectedMonitor.checkTlsCert !== false &&
                            (typeof selectedMonitor.tlsDaysRemaining === 'number' ? (
                              <>
                                <span
                                  className={`font-mono font-bold tabular-nums ${
                                    selectedMonitor.tlsDaysRemaining <= 0
                                      ? 'text-red-600 dark:text-red-400'
                                      : selectedMonitor.tlsDaysRemaining <= (selectedMonitor.tlsCertWarningDays ?? 14)
                                      ? 'text-amber-600 dark:text-amber-400'
                                      : 'text-emerald-600 dark:text-emerald-400'
                                  }`}
                                >
                                  {selectedMonitor.tlsDaysRemaining <= 0
                                    ? isZh
                                      ? `已过期 (${selectedMonitor.tlsDaysRemaining} 天)`
                                      : `Expired (${selectedMonitor.tlsDaysRemaining}d)`
                                    : isZh
                                    ? `剩余 ${selectedMonitor.tlsDaysRemaining} 天`
                                    : `${selectedMonitor.tlsDaysRemaining} days left`}
                                </span>
                                {selectedMonitor.tlsCertExpiry && (
                                  <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                                    ({isZh ? '到期' : 'Expires'}: {selectedMonitor.tlsCertExpiry.slice(0, 10)})
                                  </span>
                                )}
                                {selectedMonitor.tlsCertIssuer && (
                                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                                    · {selectedMonitor.tlsCertIssuer}
                                  </span>
                                )}
                              </>
                            ) : selectedMonitor.tlsCertError ? (
                              <span className="font-mono text-[11px] text-red-600 dark:text-red-400">
                                {selectedMonitor.tlsCertError}
                              </span>
                            ) : (
                              <span className="text-slate-400">
                                {isZh ? '点击「立即探测」获取证书到期时间' : 'Click Probe to inspect certificate'}
                              </span>
                            ))}
                        </div>
                        {selectedMonitor.checkTlsCert !== false && !selectedMonitor.ignoreTlsErrors && (
                          <span className="font-mono text-[11px] text-slate-400">
                            {isZh
                              ? `到期前 ${selectedMonitor.tlsCertWarningDays ?? 14} 天告警`
                              : `Warn <= ${selectedMonitor.tlsCertWarningDays ?? 14}d`}
                          </span>
                        )}
                      </div>
                    )}

                  {/* Notification Policy Summary */}
                  <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/50 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="inline-flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-200">
                        {selectedMonitor.notifyOnDown !== false || selectedMonitor.notifyOnRecover !== false ? (
                          <Bell className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                        ) : (
                          <BellOff className="w-3.5 h-3.5 text-slate-400" />
                        )}
                        {isZh ? '通知策略：' : 'Alerts:'}
                      </span>
                      <span
                        className={`font-medium ${
                          selectedMonitor.notifyOnDown !== false
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-slate-400 line-through'
                        }`}
                      >
                        {isZh ? '下线告警' : 'On Down'}
                      </span>
                      <span className="text-slate-300 dark:text-slate-700">·</span>
                      <span
                        className={`font-medium ${
                          selectedMonitor.notifyOnRecover !== false
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-slate-400 line-through'
                        }`}
                      >
                        {isZh ? '上线恢复通知' : 'On Recovery'}
                      </span>
                      <span className="text-slate-300 dark:text-slate-700">|</span>
                      <span className="text-slate-500 dark:text-slate-400">
                        {selectedMonitor.notifyChannelIds && selectedMonitor.notifyChannelIds.length > 0
                          ? selectedMonitor.notifyChannelIds
                              .map((id) => channelMap.get(id)?.name || id)
                              .join(', ')
                          : isZh
                          ? '全部已启用订阅渠道'
                          : 'All enabled alert channels'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => openEditModal(selectedMonitor)}
                      className="text-blue-600 dark:text-blue-400 font-medium hover:underline whitespace-nowrap"
                    >
                      {isZh ? '调整通知规则' : 'Edit Alerts'}
                    </button>
                  </div>
                </div>

                {/* Recent Heartbeat Events Table */}
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-slate-400" />
                      {isZh ? '近期探测明细日志' : 'Recent Heartbeat Log'}
                    </span>
                    <span className="font-mono text-[11px] text-slate-400">
                      {selectedMonitor.history.length} {isZh ? '条记录' : 'samples'}
                    </span>
                  </div>
                  <div className="overflow-x-auto max-h-72 overflow-y-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                          <th className="py-2.5 px-5 font-medium">{isZh ? '状态' : 'Status'}</th>
                          <th className="py-2.5 px-4 font-medium">{isZh ? '时间' : 'Time'}</th>
                          <th className="py-2.5 px-4 font-medium">{isZh ? '延迟' : 'Ping'}</th>
                          <th className="py-2.5 px-5 font-medium">{isZh ? '返回详情' : 'Message'}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                        {[...(selectedMonitor.history || [])]
                          .reverse()
                          .slice(0, 20)
                          .map((h, i) => (
                            <tr key={`${h.timestamp}-${i}`} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30">
                              <td className="py-2 px-5 whitespace-nowrap">
                                <span className="inline-flex items-center gap-1.5 font-mono font-semibold uppercase">
                                  {h.status === 'up' ? (
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                                  ) : h.status === 'degraded' ? (
                                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                                  ) : (
                                    <XCircle className="w-3.5 h-3.5 text-red-500" />
                                  )}
                                  {h.status}
                                </span>
                              </td>
                              <td className="py-2 px-4 whitespace-nowrap font-mono text-[11px] text-slate-500 dark:text-slate-400">
                                {new Date(h.timestamp).toLocaleString()}
                              </td>
                              <td className="py-2 px-4 whitespace-nowrap font-mono tabular-nums text-slate-700 dark:text-slate-300">
                                {h.latencyMs}ms
                              </td>
                              <td className="py-2 px-5 font-mono text-[11px] text-slate-600 dark:text-slate-400 break-all">
                                {h.message}
                              </td>
                            </tr>
                          ))}
                        {selectedMonitor.history.length === 0 && (
                          <tr>
                            <td colSpan={4} className="py-8 text-center text-slate-400">
                              {isZh ? '尚无探测记录，可点击上方「立即探测」' : 'No checks yet — click Probe to test immediately'}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ==================== CREATE / EDIT MONITOR MODAL ==================== */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                {editingMonitor
                  ? isZh
                    ? `编辑监控项 — ${editingMonitor.name}`
                    : `Edit Monitor — ${editingMonitor.name}`
                  : isZh
                  ? '新增实时监控探针'
                  : 'New Live Monitor'}
              </h3>
              <button type="button" onClick={() => setShowModal(false)} className="p-1 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="mt-4 space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block font-medium mb-1">{isZh ? '监控名称 *' : 'Friendly Name *'}</label>
                  <input
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder={isZh ? '例如：官网首页 / API 网关' : 'e.g. Main Website / API'}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1 flex items-center gap-1.5">
                    <FolderOpen className="w-3.5 h-3.5 text-slate-400" />
                    {isZh ? '所属分组（左侧树形归类）' : 'Group (Left Tree Folder)'}
                  </label>
                  <input
                    list="monitor-group-options"
                    value={form.groupName}
                    onChange={(e) => setForm({ ...form, groupName: e.target.value })}
                    placeholder={isZh ? '选择已有分组或输入新分组名，如：服务器 / Wimotek' : 'Select or type a group name'}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                  <datalist id="monitor-group-options">
                    {existingGroupNames.map((g) => (
                      <option key={g} value={g} />
                    ))}
                  </datalist>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                <div>
                  <label className="block font-medium mb-1">{isZh ? '探针类型 *' : 'Monitor Type *'}</label>
                  <select
                    value={form.type}
                    onChange={(e) => {
                      const nextType = e.target.value as MonitorProbeType;
                      setForm((prev) => {
                        let nextTarget = prev.target;
                        if (nextType === 'http') {
                          if (!prev.target || prev.target === 'https://') {
                            nextTarget = 'http://';
                          } else if (/^https:\/\//i.test(prev.target)) {
                            nextTarget = prev.target.replace(/^https:\/\//i, 'http://');
                          }
                        } else if (nextType === 'https') {
                          if (!prev.target || prev.target === 'http://') {
                            nextTarget = 'https://';
                          } else if (/^http:\/\//i.test(prev.target)) {
                            nextTarget = prev.target.replace(/^http:\/\//i, 'https://');
                          }
                        } else if (prev.target === 'http://' || prev.target === 'https://') {
                          nextTarget = '';
                        }
                        return {
                          ...prev,
                          type: nextType,
                          target: nextTarget,
                        };
                      });
                    }}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                  >
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                    <option value="tcp">TCP Port</option>
                    <option value="dns">DNS Resolve</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="block font-medium mb-1">
                    {form.type === 'http'
                      ? isZh
                        ? 'HTTP 监控 URL *'
                        : 'HTTP Target URL *'
                      : form.type === 'https'
                      ? isZh
                        ? 'HTTPS 监控 URL *'
                        : 'HTTPS Target URL *'
                      : form.type === 'tcp'
                      ? isZh
                        ? '主机 IP 或域名 *'
                        : 'Host / IP *'
                      : isZh
                      ? '解析域名 *'
                      : 'Domain *'}
                  </label>
                  <input
                    required
                    value={form.target}
                    onChange={(e) => setForm({ ...form, target: e.target.value })}
                    placeholder={
                      form.type === 'http'
                        ? 'http://example.com:8080/health'
                        : form.type === 'https'
                        ? 'https://example.com/health'
                        : form.type === 'tcp'
                        ? '138.2.45.109 or db.example.com'
                        : 'api.example.com'
                    }
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                  />
                </div>
              </div>

              {isWebType(form.type) && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                    <div>
                      <label className="block font-medium mb-1">
                        {isZh ? '请求方式' : 'HTTP Method'}
                      </label>
                      <select
                        value={form.httpMethod}
                        onChange={(e) =>
                          setForm({ ...form, httpMethod: e.target.value === 'HEAD' ? 'HEAD' : 'GET' })
                        }
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                      >
                        <option value="GET">GET</option>
                        <option value="HEAD">HEAD</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium mb-1">
                        {isZh ? '允许的状态码范围' : 'Accepted Status Codes'}
                      </label>
                      <input
                        value={form.expectedStatusCodes}
                        onChange={(e) => setForm({ ...form, expectedStatusCodes: e.target.value })}
                        placeholder="200-399"
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                      />
                    </div>
                    <div>
                      <label className="block font-medium mb-1">
                        {isZh ? '响应关键词（可选）' : 'Response Keyword (Optional)'}
                      </label>
                      <input
                        value={form.httpKeyword}
                        onChange={(e) => setForm({ ...form, httpKeyword: e.target.value })}
                        placeholder={isZh ? '留空仅校验状态码' : 'Blank = status only'}
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                      />
                    </div>
                  </div>

                  {(form.type === 'https' || form.target.trim().toLowerCase().startsWith('https://')) && (
                    <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 space-y-3">
                      <div className="space-y-1">
                        <label className="inline-flex items-center gap-2 font-medium text-slate-800 dark:text-slate-100 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={form.ignoreTlsErrors}
                            onChange={(e) => setForm({ ...form, ignoreTlsErrors: e.target.checked })}
                            className="rounded accent-amber-600"
                          />
                          <span>
                            {isZh
                              ? '忽略 HTTPS 网站的 TLS/SSL 证书错误 (Ignore TLS/SSL error for HTTPS websites)'
                              : 'Ignore TLS/SSL error for HTTPS websites'}
                          </span>
                        </label>
                        <p className="pl-6 text-[11px] text-slate-500 dark:text-slate-400">
                          {isZh
                            ? '开启后将忽略自签名证书、过期证书或主机名不匹配等 TLS/SSL 校验错误，仅按 HTTP 状态码与关键词判定站点可用性。'
                            : 'Allows HTTPS websites with self-signed, expired, or hostname-mismatched certificates to pass probes.'}
                        </p>
                      </div>

                      <div className="pt-2.5 border-t border-slate-200/80 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                        <label className="inline-flex items-center gap-2 font-medium text-slate-700 dark:text-slate-200 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={form.checkTlsCert}
                            onChange={(e) => setForm({ ...form, checkTlsCert: e.target.checked })}
                            className="rounded accent-emerald-600"
                          />
                          {isZh ? '监测 HTTPS SSL/TLS 证书到期时间' : 'Monitor HTTPS SSL/TLS Certificate Expiry'}
                        </label>
                        {form.checkTlsCert && (
                          <div className="inline-flex items-center gap-2">
                            <span className="text-slate-500">{isZh ? '提前告警天数：' : 'Warn Days:'}</span>
                            <input
                              type="number"
                              min={1}
                              max={365}
                              value={form.tlsCertWarningDays}
                              onChange={(e) => setForm({ ...form, tlsCertWarningDays: e.target.value })}
                              className="w-20 px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {form.type === 'tcp' && (
                <div>
                  <label className="block font-medium mb-1">{isZh ? 'TCP 端口 *' : 'TCP Port *'}</label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    required
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: e.target.value })}
                    className="w-40 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                  />
                </div>
              )}

              {form.type === 'dns' && (
                <div>
                  <label className="block font-medium mb-1">
                    {isZh ? '期望解析 IP（可选，不一致将标为降级）' : 'Expected IP (Optional)'}
                  </label>
                  <input
                    value={form.expectedIp}
                    onChange={(e) => setForm({ ...form, expectedIp: e.target.value })}
                    placeholder="138.2.45.109"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                  />
                </div>
              )}

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block font-medium mb-1">{isZh ? '心跳间隔 (秒)' : 'Heartbeat (sec)'}</label>
                  <input
                    type="number"
                    min={15}
                    max={3600}
                    value={form.intervalSeconds}
                    onChange={(e) => setForm({ ...form, intervalSeconds: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">{isZh ? '超时 (毫秒)' : 'Timeout (ms)'}</label>
                  <input
                    type="number"
                    min={1000}
                    max={30000}
                    step={500}
                    value={form.timeoutMs}
                    onChange={(e) => setForm({ ...form, timeoutMs: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">{isZh ? '重试确认次数' : 'Retries Before Down'}</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={form.failureThreshold}
                    onChange={(e) => setForm({ ...form, failureThreshold: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono"
                  />
                </div>
              </div>

              {/* Online & Offline Notification Rules */}
              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                    <Bell className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                    {isZh ? '上线 / 下线告警通知设置' : 'Up / Down Notification Rules'}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setShowModal(false);
                      onNavigateNotifications();
                    }}
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {isZh ? '管理通知渠道 →' : 'Manage Channels →'}
                  </button>
                </div>

                <div className="flex flex-wrap gap-5">
                  <label className="inline-flex items-center gap-2 font-medium text-slate-700 dark:text-slate-200">
                    <input
                      type="checkbox"
                      checked={form.notifyOnDown}
                      onChange={(e) => setForm({ ...form, notifyOnDown: e.target.checked })}
                      className="rounded accent-red-600"
                    />
                    {isZh ? '服务下线 / 异常时发送通知' : 'Send alert when service goes DOWN'}
                  </label>
                  <label className="inline-flex items-center gap-2 font-medium text-slate-700 dark:text-slate-200">
                    <input
                      type="checkbox"
                      checked={form.notifyOnRecover}
                      onChange={(e) => setForm({ ...form, notifyOnRecover: e.target.checked })}
                      className="rounded accent-emerald-600"
                    />
                    {isZh ? '服务上线 / 恢复时发送通知' : 'Send alert when service recovers UP'}
                  </label>
                </div>

                {(form.notifyOnDown || form.notifyOnRecover) && (
                  <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 space-y-2">
                    {notificationChannels.length === 0 ? (
                      <div className="text-slate-500">
                        {isZh
                          ? '尚未配置系统通知渠道（Email / Telegram / Bark / Server酱 / Webhook），请前往系统通知中心添加。'
                          : 'No notification channels configured yet. Add one in System Notifications.'}
                      </div>
                    ) : (
                      <>
                        <div className="text-[11px] text-slate-500">
                          {isZh
                            ? '指定接收此监控通知的渠道（不勾选则自动发送到所有已启用且订阅监控事件的渠道）：'
                            : 'Select specific channels (leave all unchecked to broadcast to all enabled monitor channels):'}
                        </div>
                        <div className="flex flex-wrap gap-3">
                          {notificationChannels.map((ch) => (
                            <label key={ch.id} className="inline-flex items-center gap-1.5">
                              <input
                                type="checkbox"
                                checked={form.notifyChannelIds.includes(ch.id)}
                                onChange={(e) =>
                                  setForm((prev) => ({
                                    ...prev,
                                    notifyChannelIds: e.target.checked
                                      ? [...prev.notifyChannelIds, ch.id]
                                      : prev.notifyChannelIds.filter((id) => id !== ch.id),
                                  }))
                                }
                                className="rounded accent-blue-600"
                              />
                              <span>
                                {ch.name} ({ch.type})
                              </span>
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-slate-200 dark:border-slate-800">
                <label className="inline-flex items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                    className="rounded accent-emerald-600"
                  />
                  {isZh ? '保存后立即启用监控' : 'Enable monitor immediately'}
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
                  >
                    {isZh ? '取消' : 'Cancel'}
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {isZh ? '保存监控项' : 'Save Monitor'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
