import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Bell,
  Check,
  Code2,
  Copy,
  Download,
  KeyRound,
  Loader2,
  Lock,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { translate, type TranslationKeys } from '../i18n/translations';
import { apiRequest, formatTimeAgo } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { toast } from '../lib/toast';
import type {
  DnsSyncRule,
  LanguageCode,
  NotificationChannel,
  OciImageSummary,
  OciProfile,
  OciSniperTask,
} from '../types/models';

interface OciManagerViewProps {
  profiles: OciProfile[];
  tasks: OciSniperTask[];
  dnsRules: DnsSyncRule[];
  notificationChannels: NotificationChannel[];
  lang: LanguageCode;
  onReload: () => Promise<void>;
  onNavigateNotifications?: () => void;
  onNavigateCloudAccounts?: () => void;
}

const FALLBACK_OS_PRESETS = [
  'Ubuntu 24.04 Minimal aarch64',
  'Ubuntu 22.04 Minimal aarch64',
  'Debian 12 Bookworm aarch64',
  'Oracle Linux 9 aarch64',
];

interface AutoResolvedSniperSummary {
  region?: string;
  compartmentOcid?: string;
  subnetOcid?: string;
  subnetName?: string;
  availabilityDomains?: string[];
  images?: OciImageSummary[];
  recommendedImage?: {
    id: string;
    displayName: string;
    operatingSystem: string;
    operatingSystemVersion: string;
  };
}

interface GeneratedSshKeyInfo {
  publicKey: string;
  privateKeyPem: string;
  fingerprint: string;
}

export function OciManagerView({
  profiles,
  tasks,
  dnsRules,
  notificationChannels,
  lang,
  onReload,
  onNavigateNotifications,
  onNavigateCloudAccounts,
}: OciManagerViewProps) {
  const t = (key: TranslationKeys) => translate(lang, key);
  const isZh = lang === 'zh-CN';
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'toggle' | 'test' | 'delete' | null>(null);
  const [savingTask, setSavingTask] = useState(false);

  // Script export modal (supports both Bash & Python — zero main.tf)
  const [scriptModal, setScriptModal] = useState<{
    taskId: string;
    format: 'bash' | 'python';
    filename: string;
    script: string;
  } | null>(null);
  const [loadingScript, setLoadingScript] = useState(false);
  const [loadingScriptTaskId, setLoadingScriptTaskId] = useState<string | null>(null);
  const [copiedScript, setCopiedScript] = useState(false);

  // Sniper modal + zero-main.tf auto-resolve + SSH keygen state
  const [showSniperModal, setShowSniperModal] = useState(false);
  const [editingTask, setEditingTask] = useState<OciSniperTask | null>(null);
  const [sniperImages, setSniperImages] = useState<OciImageSummary[]>([]);
  const [loadingImages, setLoadingImages] = useState(false);
  const [imageFetchError, setImageFetchError] = useState<string | null>(null);
  const [autoResolving, setAutoResolving] = useState(false);
  const [autoResolveError, setAutoResolveError] = useState<string | null>(null);
  const [resolvedSummary, setResolvedSummary] = useState<AutoResolvedSniperSummary | null>(null);
  const [generatingSshKey, setGeneratingSshKey] = useState(false);
  const [generatedSshKey, setGeneratedSshKey] = useState<GeneratedSshKeyInfo | null>(null);

  const [taskForm, setTaskForm] = useState({
    name: '',
    profileId: '',
    displayName: 'oci-arm-node-01',
    shape: 'VM.Standard.A1.Flex' as 'VM.Standard.A1.Flex' | 'VM.Standard.E2.1.Micro',
    ocpus: '4',
    memoryInGBs: '24',
    bootVolumeSizeInGBs: '100',
    osPreset: FALLBACK_OS_PRESETS[0],
    imageOcid: '',
    sshPublicKey: '',
    availabilityDomains: [] as string[],
    assignPublicIp: true,
    assignIpv6: true,
    intervalSeconds: '45',
    jitterPercent: '20',
    retryOnOutOfCapacity: true,
    backoffOn429Seconds: '180',
    maxAttempts: '0',
    autoStopOnSuccess: true,
    autoBindDnsRuleId: '',
    useSystemNotifications: true,
    notifyChannelIds: [] as string[],
  });

  const cleanDigitsInput = (raw: string): string => {
    const digits = raw.replace(/[^\d]/g, '');
    if (digits.length > 1) return digits.replace(/^0+(?=\d)/, '');
    return digits;
  };

  const clampNumericField = (raw: string, min: number, max: number | undefined, fallback: number): number => {
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    const boundedMin = Math.max(min, parsed);
    return max !== undefined ? Math.min(max, boundedMin) : boundedMin;
  };

  const profileMap = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const readyProfilesCount = useMemo(() => profiles.filter((p) => p.hasPrivateKey).length, [profiles]);
  const selectedSniperProfile = profileMap.get(taskForm.profileId);

  const showNotice = (msg: string, kind: 'success' | 'error' | 'info' | 'warning' = 'info') => {
    toast.show(msg, kind);
  };

  // Auto-fetch live OCI OS Images for Sniper Task when profile + shape change
  const loadSniperImages = async (profileId: string, shape: string) => {
    const prof = profileMap.get(profileId);
    if (!prof || !prof.hasPrivateKey) {
      setSniperImages([]);
      setImageFetchError(null);
      return;
    }
    setLoadingImages(true);
    setImageFetchError(null);
    try {
      const res = await apiRequest<{ images: OciImageSummary[] }>(
        `/api/oci/profiles/${profileId}/images?shape=${encodeURIComponent(shape)}`
      );
      setSniperImages(res.images);
      if (res.images.length > 0) {
        setTaskForm((prev) => {
          const alreadyValid = res.images.some((i) => i.id === prev.imageOcid);
          if (alreadyValid) return prev;
          const preferred =
            res.images.find((i) => /ubuntu.*24\.04/i.test(i.displayName)) ||
            res.images.find((i) => /ubuntu.*22\.04/i.test(i.displayName)) ||
            res.images[0];
          return {
            ...prev,
            osPreset: preferred.displayName,
            imageOcid: preferred.id,
          };
        });
      }
    } catch (err) {
      setSniperImages([]);
      setImageFetchError(err instanceof Error ? err.message : 'Failed to fetch OCI images');
    } finally {
      setLoadingImages(false);
    }
  };

  useEffect(() => {
    if (showSniperModal && taskForm.profileId) {
      void loadSniperImages(taskForm.profileId, taskForm.shape);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSniperModal, taskForm.profileId, taskForm.shape]);

  // Zero-main.tf 1-click auto-resolve: Compartment + Public Subnet + ADs + Shape-compatible Official Image
  const handleAutoResolveAll = async () => {
    if (!taskForm.profileId) return;
    setAutoResolving(true);
    setAutoResolveError(null);
    try {
      const res = await apiRequest<{ ok: boolean; error?: string } & AutoResolvedSniperSummary>(
        '/api/oci/sniper/auto-resolve',
        {
          method: 'POST',
          body: JSON.stringify({
            profileId: taskForm.profileId,
            shape: taskForm.shape,
            osHint: taskForm.osPreset,
            assignIpv6: taskForm.assignIpv6,
          }),
        }
      );
      setResolvedSummary(res);
      if (res.images && res.images.length > 0) {
        setSniperImages(res.images);
      }
      setTaskForm((prev) => ({
        ...prev,
        availabilityDomains:
          res.availabilityDomains && res.availabilityDomains.length > 0
            ? res.availabilityDomains
            : prev.availabilityDomains,
        imageOcid: res.recommendedImage?.id || prev.imageOcid,
        osPreset: res.recommendedImage?.displayName || prev.osPreset,
      }));
      await onReload();
      showNotice(
        isZh
          ? `免 main.tf 参数自动拉取成功：已自动匹配 ${res.availabilityDomains?.length ?? 0} 个可用域、公网子网与最新官方系统镜像`
          : `Auto-resolved ${res.availabilityDomains?.length ?? 0} AD(s), public subnet, and latest official OS image`,
        'success'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Auto-resolve failed';
      setAutoResolveError(msg);
      showNotice(msg, 'error');
    } finally {
      setAutoResolving(false);
    }
  };

  // Ephemeral Ed25519 SSH Keypair Generator (never stored on server)
  const handleGenerateSshKey = async () => {
    setGeneratingSshKey(true);
    try {
      const res = await apiRequest<{ ok: boolean } & GeneratedSshKeyInfo>('/api/oci/sniper/generate-ssh-key', {
        method: 'POST',
        body: JSON.stringify({ comment: taskForm.displayName || 'netpulse-oci-arm' }),
      });
      setGeneratedSshKey({
        publicKey: res.publicKey,
        privateKeyPem: res.privateKeyPem,
        fingerprint: res.fingerprint,
      });
      setTaskForm((prev) => ({ ...prev, sshPublicKey: res.publicKey }));
      showNotice(isZh ? '已生成 Ed25519 SSH 密钥对并填入公钥' : 'Generated Ed25519 SSH keypair', 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? '生成 SSH 密钥失败' : 'SSH key generation failed', 'error');
    } finally {
      setGeneratingSshKey(false);
    }
  };

  const handleDownloadGeneratedPrivateKey = () => {
    if (!generatedSshKey) return;
    const filename = `${(taskForm.displayName || 'oci-arm').replace(/[^a-zA-Z0-9_-]/g, '-')}-ed25519.pem`;
    const blob = new Blob([generatedSshKey.privateKeyPem], { type: 'application/x-pem-file' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    showNotice(isZh ? `已下载私钥文件 ${filename}` : `Downloaded ${filename}`, 'success');
  };

  const openNewSniper = () => {
    const firstProf = profiles.find((p) => p.hasPrivateKey) ?? profiles[0];
    setEditingTask(null);
    setResolvedSummary(null);
    setAutoResolveError(null);
    setGeneratedSshKey(null);
    setTaskForm({
      name: '',
      profileId: firstProf?.id ?? '',
      displayName: 'oci-arm-node-01',
      shape: 'VM.Standard.A1.Flex',
      ocpus: '4',
      memoryInGBs: '24',
      bootVolumeSizeInGBs: '100',
      osPreset: FALLBACK_OS_PRESETS[0],
      imageOcid: '',
      sshPublicKey: '',
      availabilityDomains: firstProf?.availabilityDomains ?? [],
      assignPublicIp: true,
      assignIpv6: true,
      intervalSeconds: '45',
      jitterPercent: '20',
      retryOnOutOfCapacity: true,
      backoffOn429Seconds: '180',
      maxAttempts: '0',
      autoStopOnSuccess: true,
      autoBindDnsRuleId: '',
      useSystemNotifications: true,
      notifyChannelIds: [],
    });
    setShowSniperModal(true);
  };

  const openEditSniper = (task: OciSniperTask) => {
    const matchedProf = profileMap.get(task.profileId);
    const fallbackProf = matchedProf ?? profiles.find((p) => p.hasPrivateKey) ?? profiles[0];
    setEditingTask(task);
    setResolvedSummary(null);
    setAutoResolveError(null);
    setGeneratedSshKey(null);
    setTaskForm({
      name: task.name,
      profileId: fallbackProf?.id ?? '',
      displayName: task.displayName,
      shape: task.shape,
      ocpus: String(task.ocpus),
      memoryInGBs: String(task.memoryInGBs),
      bootVolumeSizeInGBs: String(task.bootVolumeSizeInGBs),
      osPreset: task.osPreset,
      imageOcid: task.imageOcid,
      sshPublicKey: task.sshPublicKey,
      availabilityDomains:
        matchedProf && task.availabilityDomains?.length
          ? task.availabilityDomains
          : fallbackProf?.availabilityDomains ?? task.availabilityDomains ?? [],
      assignPublicIp: task.assignPublicIp,
      assignIpv6: task.assignIpv6,
      intervalSeconds: String(task.intervalSeconds),
      jitterPercent: String(task.jitterPercent),
      retryOnOutOfCapacity: task.retryOnOutOfCapacity,
      backoffOn429Seconds: String(task.backoffOn429Seconds),
      maxAttempts: String(task.maxAttempts),
      autoStopOnSuccess: task.autoStopOnSuccess,
      autoBindDnsRuleId: task.autoBindDnsRuleId ?? '',
      useSystemNotifications: task.useSystemNotifications !== false,
      notifyChannelIds: task.notifyChannelIds ?? [],
    });
    setShowSniperModal(true);
  };

  const handleSaveSniper = async (e: React.FormEvent) => {
    e.preventDefault();
    const effectiveProfile =
      profileMap.get(taskForm.profileId) ?? profiles.find((p) => p.hasPrivateKey) ?? profiles[0];
    if (!effectiveProfile) {
      showNotice(
        isZh
          ? '暂无可用的 OCI 凭据，请先在「多云主机管理 → 云账号凭据」添加 OCI 账号。'
          : 'No OCI profile available. Please add an OCI credential first.',
        'error'
      );
      return;
    }
    const payload = {
      ...taskForm,
      profileId: effectiveProfile.id,
      ocpus: clampNumericField(taskForm.ocpus, 1, 4, 4),
      memoryInGBs: clampNumericField(taskForm.memoryInGBs, 1, 24, 24),
      bootVolumeSizeInGBs: clampNumericField(taskForm.bootVolumeSizeInGBs, 50, 200, 100),
      intervalSeconds: clampNumericField(taskForm.intervalSeconds, 15, undefined, 45),
      jitterPercent: clampNumericField(taskForm.jitterPercent, 0, 50, 20),
      backoffOn429Seconds: clampNumericField(taskForm.backoffOn429Seconds, 30, undefined, 180),
      maxAttempts: clampNumericField(taskForm.maxAttempts, 0, undefined, 0),
      availabilityDomains:
        taskForm.availabilityDomains.length > 0
          ? taskForm.availabilityDomains
          : effectiveProfile.availabilityDomains ?? ['AD-1'],
    };
    setSavingTask(true);
    try {
      if (editingTask) {
        await apiRequest(`/api/oci/sniper/${editingTask.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await apiRequest('/api/oci/sniper', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setShowSniperModal(false);
      await onReload();
      showNotice(t('savedSuccessfully'), 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? '保存失败，请重试' : 'Failed to save sniper task', 'error');
    } finally {
      setSavingTask(false);
    }
  };

  const handleToggleSniper = async (task: OciSniperTask) => {
    setBusyId(task.id);
    setBusyAction('toggle');
    try {
      const nextStatus = task.status === 'running' ? 'paused' : 'running';
      await apiRequest(`/api/oci/sniper/${task.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: nextStatus }),
      });
      await onReload();
      showNotice(
        isZh
          ? `抢注任务「${task.name}」已${nextStatus === 'running' ? '启动' : '暂停'}`
          : `Sniper "${task.name}" ${nextStatus === 'running' ? 'started' : 'paused'}`,
        'success'
      );
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? '切换任务状态失败' : 'Failed to toggle sniper task', 'error');
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  const handleRunOnce = async (task: OciSniperTask) => {
    setBusyId(task.id);
    setBusyAction('test');
    try {
      const res = await apiRequest<{ result: { outcome?: string; message: string } }>(
        `/api/oci/sniper/${task.id}/run-once`,
        { method: 'POST' }
      );
      await onReload();
      const outcome = res.result.outcome;
      showNotice(
        res.result.message,
        outcome === 'succeeded' ? 'success' : outcome === 'error' ? 'error' : 'info'
      );
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? '测试执行失败' : 'Sniper test failed', 'error');
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  const fetchScriptForTask = async (taskId: string, format: 'bash' | 'python') => {
    setLoadingScript(true);
    setLoadingScriptTaskId(taskId);
    try {
      const res = await apiRequest<{ filename: string; script: string }>(
        `/api/oci/sniper/${taskId}/script?format=${format}`
      );
      setScriptModal({ taskId, format, filename: res.filename, script: res.script });
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? '导出脚本失败' : 'Failed to export script', 'error');
    } finally {
      setLoadingScript(false);
      setLoadingScriptTaskId(null);
    }
  };

  const handleDownloadScript = () => {
    if (!scriptModal) return;
    const mime = scriptModal.format === 'python' ? 'text/x-python' : 'text/x-shellscript';
    const blob = new Blob([scriptModal.script], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = scriptModal.filename;
    a.click();
    URL.revokeObjectURL(url);
    showNotice(isZh ? `已下载脚本 ${scriptModal.filename}` : `Downloaded ${scriptModal.filename}`, 'success');
  };

  const handleDeleteSniper = async (task: OciSniperTask) => {
    setBusyId(task.id);
    setBusyAction('delete');
    try {
      await apiRequest(`/api/oci/sniper/${task.id}`, { method: 'DELETE' });
      await onReload();
      showNotice(isZh ? `已删除抢注任务「${task.name}」` : `Deleted sniper "${task.name}"`, 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : isZh ? '删除任务失败' : 'Delete failed', 'error');
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  const adChoices = useMemo(() => {
    const set = new Set<string>();
    for (const ad of resolvedSummary?.availabilityDomains ?? []) set.add(ad);
    for (const ad of selectedSniperProfile?.availabilityDomains ?? []) set.add(ad);
    for (const ad of taskForm.availabilityDomains) set.add(ad);
    if (set.size === 0) set.add('AD-1');
    return Array.from(set);
  }, [resolvedSummary, selectedSniperProfile, taskForm.availabilityDomains]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t('ociTitle')}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t('ociSubtitle')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0 self-start lg:self-auto">
          {onNavigateCloudAccounts && (
            <button
              type="button"
              onClick={onNavigateCloudAccounts}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              <KeyRound className="w-3.5 h-3.5" />
              {isZh
                ? `云凭证管理 · OCI (${readyProfilesCount}/${profiles.length})`
                : `Cloud Credentials · OCI (${readyProfilesCount}/${profiles.length})`}
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={openNewSniper}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('addSniperTask')}
          </button>
        </div>
      </div>

      {/* Zero-main.tf & Unified Credentials Info Strip */}
      <div className="px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
        <div className="flex items-start gap-2.5 text-slate-600 dark:text-slate-300">
          <Sparkles className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
          <div className="leading-relaxed">
            {isZh
              ? '全流程免 main.tf：只需在「多云主机管理 → 云账号凭据」中配置 OCI 私钥，本引擎与导出的独立 Python/Bash 脚本均会通过 OCI API 自动获取 Compartment、可用域 AD、公网子网与最新官方系统镜像 OCID。'
              : 'Zero main.tf required: once your OCI API key is saved under Cloud Hosts → Cloud Credentials, both the built-in sniper engine and exported Python/Bash scripts auto-discover Compartment, Availability Domains, Public Subnet, and shape-matching official OS images.'}
          </div>
        </div>
        {readyProfilesCount === 0 && onNavigateCloudAccounts && (
          <button
            type="button"
            onClick={onNavigateCloudAccounts}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-600 text-white font-semibold hover:bg-amber-700 whitespace-nowrap shrink-0 self-start sm:self-center"
          >
            {isZh ? '去添加 OCI 凭据' : 'Add OCI Key'}
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* ARM Sniper Tasks List */}
      <div className="space-y-4">
        {tasks.map((task) => {
          const prof = profileMap.get(task.profileId);
          const isRunning = task.status === 'running';
          const autoDiscoverPending = !task.imageOcid || !prof?.subnetOcid;
          return (
            <div
              key={task.id}
              className="p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-4"
            >
              <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white">
                      {task.name}
                    </h3>
                    <span
                      className={`text-xs font-mono font-semibold ${
                        isRunning
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : task.status === 'succeeded'
                          ? 'text-blue-600 dark:text-blue-400'
                          : task.status === 'failed'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {task.status.toUpperCase()}
                    </span>
                    <span className="text-[11px] font-mono text-blue-600 dark:text-blue-400">
                      {isZh
                        ? autoDiscoverPending
                          ? '免 main.tf · 运行时自动补全子网/镜像'
                          : '免 main.tf · 参数就绪'
                        : autoDiscoverPending
                        ? 'Zero main.tf · Auto-resolve on run'
                        : 'Zero main.tf · Ready'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-mono flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span className={prof ? '' : 'text-red-600 dark:text-red-400 font-semibold'}>
                      {prof
                        ? `${prof.name} (${prof.region})`
                        : isZh
                        ? '关联 OCI 凭据已失效（请点编辑重新绑定）'
                        : 'Missing OCI profile (click Edit to rebind)'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{task.shape}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {task.ocpus} OCPU / {task.memoryInGBs} GB / {task.bootVolumeSizeInGBs} GB Boot
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>ADs: {task.availabilityDomains.join(', ') || 'Auto'}</span>
                  </div>
                </div>

                {/* Action Controls */}
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={busyId === task.id}
                    onClick={() => void handleToggleSniper(task)}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 ${
                      isRunning
                        ? 'bg-amber-600 text-white hover:bg-amber-700'
                        : 'bg-emerald-600 text-white hover:bg-emerald-700'
                    }`}
                  >
                    {busyId === task.id && busyAction === 'toggle' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : isRunning ? (
                      <Pause className="w-3.5 h-3.5" />
                    ) : (
                      <Play className="w-3.5 h-3.5" />
                    )}
                    {isRunning ? t('pauseSniper') : t('startSniper')}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === task.id}
                    onClick={() => void handleRunOnce(task)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    {busyId === task.id && busyAction === 'test' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Zap className="w-3.5 h-3.5" />
                    )}
                    {t('testOnce')}
                  </button>
                  <button
                    type="button"
                    disabled={loadingScriptTaskId === task.id}
                    onClick={() => void fetchScriptForTask(task.id, 'python')}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    {loadingScriptTaskId === task.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Code2 className="w-3.5 h-3.5" />
                    )}
                    {t('exportScript')}
                  </button>
                  <button
                    type="button"
                    onClick={() => openEditSniper(task)}
                    title={t('edit')}
                    className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={busyId === task.id}
                    onClick={() => void handleDeleteSniper(task)}
                    title={t('delete')}
                    className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                  >
                    {busyId === task.id && busyAction === 'delete' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>

              {/* Parameter summary row */}
              <div className="pt-4 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                <div>
                  <div className="text-slate-500 dark:text-slate-400">{t('attempts')}</div>
                  <div className="mt-0.5 font-mono font-semibold tabular-nums text-slate-900 dark:text-white">
                    {task.attempts} {task.maxAttempts > 0 ? `/ ${task.maxAttempts}` : '(∞)'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 dark:text-slate-400">{t('pollingIntervalSec')}</div>
                  <div className="mt-0.5 font-mono tabular-nums text-slate-800 dark:text-slate-200">
                    {task.intervalSeconds}s ±{task.jitterPercent}% · 429:{task.backoffOn429Seconds}s
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 dark:text-slate-400">{t('osPreset')}</div>
                  <div className="mt-0.5 text-slate-800 dark:text-slate-200 truncate" title={task.osPreset}>
                    {task.osPreset}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 dark:text-slate-400">{t('lastRun')}</div>
                  <div className="mt-0.5 font-mono tabular-nums text-slate-800 dark:text-slate-200">
                    {formatTimeAgo(task.lastAttemptAt)}
                  </div>
                </div>
              </div>

              <div
                className="pt-3 border-t border-slate-200/70 dark:border-slate-800/70 text-xs font-mono text-slate-600 dark:text-slate-400 truncate min-h-[29px]"
                title={task.lastMessage || undefined}
              >
                <span className="font-sans font-medium text-slate-500 mr-2">{t('lastResponse')}:</span>
                <span className={task.lastMessage ? '' : 'font-sans text-slate-400 dark:text-slate-500'}>
                  {task.lastMessage || (isZh ? '尚无执行记录' : 'No attempts yet')}
                </span>
              </div>
            </div>
          );
        })}
        {tasks.length === 0 && (
          <div className="p-10 text-center rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-sm text-slate-400">
            {t('noData')}
          </div>
        )}
      </div>

      {/* ARM Sniper Parameter Modal — 100% Zero-main.tf Auto-Resolve + 1-Click Ed25519 SSH Keygen */}
      {showSniperModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
              <div>
                <h3 className="font-display text-lg font-semibold">
                  {editingTask ? t('edit') : t('addSniperTask')}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {isZh
                    ? '免 main.tf：选择已配置的 OCI 凭据后，点击一键自动获取即可自动填充子网、可用域与镜像 OCID（留空也会在执行时自动补全）。'
                    : 'Zero main.tf: select an OCI credential and click Auto-Resolve to populate Subnet, ADs, and official OS Image OCID automatically.'}
                </p>
              </div>
              <button type="button" onClick={() => setShowSniperModal(false)} className="p-1 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveSniper} className="mt-4 space-y-4 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {isZh ? '任务名称' : 'Task Name'}
                  </label>
                  <input
                    required
                    value={taskForm.name}
                    onChange={(e) => setTaskForm({ ...taskForm, name: e.target.value })}
                    placeholder={isZh ? '东京 ARM 4C24G 抢注' : 'Tokyo ARM 4C24G Sniper'}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium">{t('ociTabProfiles')}</label>
                    {onNavigateCloudAccounts && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowSniperModal(false);
                          onNavigateCloudAccounts();
                        }}
                        className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        {isZh ? '去云凭证管理 →' : 'Manage OCI Keys →'}
                      </button>
                    )}
                  </div>
                  <select
                    required
                    value={taskForm.profileId}
                    onChange={(e) => {
                      const p = profileMap.get(e.target.value);
                      setResolvedSummary(null);
                      setAutoResolveError(null);
                      setTaskForm({
                        ...taskForm,
                        profileId: e.target.value,
                        availabilityDomains: p?.availabilityDomains ?? [],
                      });
                    }}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  >
                    {profiles.length === 0 && (
                      <option value="">
                        {isZh ? '请先在云凭证管理中添加 OCI 账号' : 'Add an OCI credential first'}
                      </option>
                    )}
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.region}){p.hasPrivateKey ? '' : isZh ? ' [未配私钥]' : ' [No PEM]'}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {isZh ? '实例显示名' : 'Instance Display Name'}
                  </label>
                  <input
                    required
                    value={taskForm.displayName}
                    onChange={(e) => setTaskForm({ ...taskForm, displayName: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('shape')}</label>
                  <select
                    value={taskForm.shape}
                    onChange={(e) =>
                      setTaskForm({
                        ...taskForm,
                        shape: e.target.value as 'VM.Standard.A1.Flex' | 'VM.Standard.E2.1.Micro',
                      })
                    }
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  >
                    <option value="VM.Standard.A1.Flex">VM.Standard.A1.Flex (ARM Ampere)</option>
                    <option value="VM.Standard.E2.1.Micro">VM.Standard.E2.1.Micro (AMD x86)</option>
                  </select>
                </div>
              </div>

              {/* Zero-main.tf 1-Click Auto-Resolve Bar */}
              <div className="p-3.5 rounded-lg border border-blue-200/80 dark:border-blue-900/70 bg-blue-50/50 dark:bg-blue-950/25 space-y-2.5 text-xs">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                  <div className="text-slate-700 dark:text-slate-200">
                    <div className="font-semibold flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                      {isZh ? '免 main.tf · OCI API 自动获取全部抢注参数' : 'Zero main.tf · Auto-Discover All OCI Parameters'}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                      {isZh
                        ? '自动查询并回填 Compartment OCID、可用域 AD、优先 IPv6 公网子网与当前规格匹配的官方系统镜像。'
                        : 'Automatically fetches Compartment, real Availability Domains, IPv6-ready public subnet, and matching official OS images.'}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={autoResolving || !selectedSniperProfile?.hasPrivateKey}
                    onClick={() => void handleAutoResolveAll()}
                    className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-45 whitespace-nowrap shrink-0"
                  >
                    {autoResolving ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                    {autoResolving
                      ? isZh
                        ? '正在拉取 OCI...'
                        : 'Resolving...'
                      : isZh
                      ? '一键自动获取全部参数'
                      : 'Auto-Resolve All Params'}
                  </button>
                </div>

                {!selectedSniperProfile?.hasPrivateKey && (
                  <div className="text-[11px] text-amber-700 dark:text-amber-400">
                    {isZh
                      ? '当前选中的 OCI 凭据尚未上传 PEM 私钥，请先前往「多云主机管理 → 云账号凭据」上传后即可自动获取。'
                      : 'Selected OCI credential has no PEM private key yet. Upload it in Cloud Credentials first.'}
                  </div>
                )}

                {autoResolveError && (
                  <div className="text-[11px] text-red-600 dark:text-red-400">{autoResolveError}</div>
                )}

                {resolvedSummary && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t border-blue-200/70 dark:border-blue-900/60 font-mono text-[11px] text-emerald-800 dark:text-emerald-300">
                    <div className="truncate" title={resolvedSummary.compartmentOcid}>
                      Compartment: {resolvedSummary.compartmentOcid || '—'}
                    </div>
                    <div className="truncate" title={resolvedSummary.subnetOcid}>
                      Subnet: {resolvedSummary.subnetName ? `${resolvedSummary.subnetName} · ` : ''}
                      {resolvedSummary.subnetOcid || '—'}
                    </div>
                    <div className="truncate">
                      ADs ({resolvedSummary.availabilityDomains?.length ?? 0}):{' '}
                      {resolvedSummary.availabilityDomains?.join(', ') || '—'}
                    </div>
                    <div className="truncate" title={resolvedSummary.recommendedImage?.id}>
                      Image: {resolvedSummary.recommendedImage?.displayName || '—'}
                    </div>
                  </div>
                )}
              </div>

              {/* Hardware Numbers */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">{t('ocpus')} (1-4)</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={taskForm.ocpus}
                    onChange={(e) => setTaskForm({ ...taskForm, ocpus: cleanDigitsInput(e.target.value) })}
                    onBlur={() =>
                      setTaskForm((prev) => ({
                        ...prev,
                        ocpus: String(clampNumericField(prev.ocpus, 1, 4, 4)),
                      }))
                    }
                    placeholder="1-4"
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('memoryGb')} (1-24)</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={taskForm.memoryInGBs}
                    onChange={(e) => setTaskForm({ ...taskForm, memoryInGBs: cleanDigitsInput(e.target.value) })}
                    onBlur={() =>
                      setTaskForm((prev) => ({
                        ...prev,
                        memoryInGBs: String(clampNumericField(prev.memoryInGBs, 1, 24, 24)),
                      }))
                    }
                    placeholder="1-24"
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('bootVolumeGb')}</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={taskForm.bootVolumeSizeInGBs}
                    onChange={(e) =>
                      setTaskForm({ ...taskForm, bootVolumeSizeInGBs: cleanDigitsInput(e.target.value) })
                    }
                    onBlur={() =>
                      setTaskForm((prev) => ({
                        ...prev,
                        bootVolumeSizeInGBs: String(clampNumericField(prev.bootVolumeSizeInGBs, 50, 200, 100)),
                      }))
                    }
                    placeholder="50-200"
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
              </div>

              {/* Auto-fetched OS Images + Locked Image OCID */}
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-medium">
                    {t('osPreset')}
                    {sniperImages.length > 0 && (
                      <span className="ml-2 text-[11px] text-emerald-600 dark:text-emerald-400">
                        {isZh ? `已从 OCI 自动获取 ${sniperImages.length} 个官方镜像` : `${sniperImages.length} live OCI images loaded`}
                      </span>
                    )}
                  </label>
                  {selectedSniperProfile?.hasPrivateKey && (
                    <button
                      type="button"
                      disabled={loadingImages}
                      onClick={() => void loadSniperImages(taskForm.profileId, taskForm.shape)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      <RefreshCw className={`w-3 h-3 ${loadingImages ? 'animate-spin' : ''}`} />
                      {isZh ? '刷新区域镜像' : 'Refresh Images'}
                    </button>
                  )}
                </div>

                {sniperImages.length > 0 ? (
                  <select
                    value={taskForm.imageOcid}
                    onChange={(e) => {
                      const img = sniperImages.find((i) => i.id === e.target.value);
                      setTaskForm({
                        ...taskForm,
                        imageOcid: e.target.value,
                        osPreset: img?.displayName ?? taskForm.osPreset,
                      });
                    }}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  >
                    {sniperImages.map((img) => (
                      <option key={img.id} value={img.id}>
                        {img.displayName} ({img.operatingSystem} {img.operatingSystemVersion})
                      </option>
                    ))}
                  </select>
                ) : (
                  <select
                    value={taskForm.osPreset}
                    onChange={(e) => setTaskForm({ ...taskForm, osPreset: e.target.value })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  >
                    {FALLBACK_OS_PRESETS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                )}

                {imageFetchError && (
                  <div className="text-xs text-amber-600 dark:text-amber-400">{imageFetchError}</div>
                )}

                <div>
                  <label className="flex items-center justify-between text-xs font-medium mb-1">
                    <span>{t('imageOcid')}</span>
                    <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                      <Lock className="w-3 h-3" />
                      {sniperImages.length > 0
                        ? isZh
                          ? '自动匹配 · 禁改'
                          : 'Auto-matched · Read-only'
                        : isZh
                        ? '留空时执行自动按预设拉取'
                        : 'Optional — auto-resolved at runtime'}
                    </span>
                  </label>
                  <input
                    readOnly={sniperImages.length > 0}
                    disabled={sniperImages.length > 0}
                    value={taskForm.imageOcid}
                    onChange={(e) => setTaskForm({ ...taskForm, imageOcid: e.target.value })}
                    placeholder={
                      isZh
                        ? '留空即可，自动按所选系统镜像从 OCI 拉取最新 OCID'
                        : 'Leave blank to auto-fetch latest official Image OCID'
                    }
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 disabled:bg-slate-100 disabled:dark:bg-slate-800/70 disabled:cursor-not-allowed"
                  />
                </div>
              </div>

              {/* Availability Domains — checkboxes derived strictly from Profile/Auto-Resolved ADs */}
              <div>
                <div className="flex items-center justify-between text-xs font-medium mb-1.5">
                  <span>{t('availabilityDomains')}</span>
                  <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                    <Lock className="w-3 h-3" />
                    {isZh ? '由 OCI API 自动获取（勾选轮询范围）' : 'Auto-fetched via OCI API'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs font-mono">
                  {adChoices.map((ad) => (
                    <label key={ad} className="inline-flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={taskForm.availabilityDomains.includes(ad)}
                        onChange={(e) =>
                          setTaskForm((prev) => ({
                            ...prev,
                            availabilityDomains: e.target.checked
                              ? [...prev.availabilityDomains, ad]
                              : prev.availabilityDomains.filter((x) => x !== ad),
                          }))
                        }
                        className="rounded accent-blue-600"
                      />
                      <span>{ad}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* SSH Public Key + 1-Click Ephemeral Ed25519 Keypair Generator */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-medium">{t('sshPublicKey')}</label>
                  <button
                    type="button"
                    disabled={generatingSshKey}
                    onClick={() => void handleGenerateSshKey()}
                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
                  >
                    {generatingSshKey ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <KeyRound className="w-3 h-3" />
                    )}
                    {isZh ? '一键生成 Ed25519 SSH 密钥' : 'Generate Ed25519 SSH Key'}
                  </button>
                </div>
                <input
                  value={taskForm.sshPublicKey}
                  onChange={(e) => setTaskForm({ ...taskForm, sshPublicKey: e.target.value })}
                  placeholder="ssh-ed25519 AAAA..."
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
                {generatedSshKey && (
                  <div className="p-3 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/25 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-emerald-800 dark:text-emerald-300">
                        {isZh
                          ? '已生成临时 Ed25519 密钥对（服务端不保存私钥，请立即下载）'
                          : 'Ephemeral Ed25519 keypair generated (private key is not stored on server)'}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-emerald-700/80 dark:text-emerald-400/80 truncate">
                        {generatedSshKey.fingerprint}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleDownloadGeneratedPrivateKey}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-semibold hover:bg-emerald-700 whitespace-nowrap shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {isZh ? '下载私钥 (.pem)' : 'Download Private Key'}
                    </button>
                  </div>
                )}
              </div>

              {/* Rate-limit, Jitter & Backoff Controls */}
              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">{t('pollingIntervalSec')}</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={taskForm.intervalSeconds}
                    onChange={(e) => setTaskForm({ ...taskForm, intervalSeconds: cleanDigitsInput(e.target.value) })}
                    onBlur={() =>
                      setTaskForm((prev) => ({
                        ...prev,
                        intervalSeconds: String(clampNumericField(prev.intervalSeconds, 15, undefined, 45)),
                      }))
                    }
                    placeholder="≥ 15"
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('jitterPercent')}</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={taskForm.jitterPercent}
                    onChange={(e) => setTaskForm({ ...taskForm, jitterPercent: cleanDigitsInput(e.target.value) })}
                    onBlur={() =>
                      setTaskForm((prev) => ({
                        ...prev,
                        jitterPercent: String(clampNumericField(prev.jitterPercent, 0, 50, 20)),
                      }))
                    }
                    placeholder="0-50"
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('backoff429Sec')}</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={taskForm.backoffOn429Seconds}
                    onChange={(e) =>
                      setTaskForm({ ...taskForm, backoffOn429Seconds: cleanDigitsInput(e.target.value) })
                    }
                    onBlur={() =>
                      setTaskForm((prev) => ({
                        ...prev,
                        backoffOn429Seconds: String(clampNumericField(prev.backoffOn429Seconds, 30, undefined, 180)),
                      }))
                    }
                    placeholder="≥ 30"
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('maxAttempts')}</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={taskForm.maxAttempts}
                    onChange={(e) => setTaskForm({ ...taskForm, maxAttempts: cleanDigitsInput(e.target.value) })}
                    onBlur={() =>
                      setTaskForm((prev) => ({
                        ...prev,
                        maxAttempts: String(clampNumericField(prev.maxAttempts, 0, undefined, 0)),
                      }))
                    }
                    placeholder="0 = ∞"
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
              </div>

              {/* DNS Binding & Unified System Notifications */}
              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3.5">
                <div>
                  <label className="block text-xs font-medium mb-1">{t('autoBindDnsRule')}</label>
                  <select
                    value={taskForm.autoBindDnsRuleId}
                    onChange={(e) => setTaskForm({ ...taskForm, autoBindDnsRuleId: e.target.value })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  >
                    <option value="">-- None --</option>
                    {dnsRules.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} ({r.recordName}.{r.domain})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="inline-flex items-center gap-2 text-xs font-medium">
                      <input
                        type="checkbox"
                        checked={taskForm.useSystemNotifications}
                        onChange={(e) =>
                          setTaskForm({ ...taskForm, useSystemNotifications: e.target.checked })
                        }
                        className="rounded accent-blue-600"
                      />
                      <Bell className="w-3.5 h-3.5 text-slate-400" />
                      {isZh
                        ? '统一调用系统通知中心（Email / Server酱 / Telegram / Bark / Webhook）'
                        : 'Dispatch via System Notifications (Email / ServerChan / Telegram / Bark / Webhook)'}
                    </label>
                    {onNavigateNotifications && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowSniperModal(false);
                          onNavigateNotifications();
                        }}
                        className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                      >
                        {t('navNotify')} →
                      </button>
                    )}
                  </div>

                  {taskForm.useSystemNotifications && (
                    <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 space-y-1.5 text-xs">
                      {notificationChannels.length === 0 ? (
                        <div className="text-slate-500">
                          {isZh ? '尚未配置通知渠道，请前往通知中心添加。' : 'No notification channels configured yet.'}
                        </div>
                      ) : (
                        <>
                          <div className="text-[11px] text-slate-500">
                            {isZh
                              ? '不勾选则自动发送到所有已启用且订阅 OCI 事件的系统渠道：'
                              : 'Leave unchecked to broadcast to all enabled system channels subscribed to OCI events:'}
                          </div>
                          <div className="flex flex-wrap gap-3 pt-1">
                            {notificationChannels.map((ch) => (
                              <label key={ch.id} className="inline-flex items-center gap-1.5">
                                <input
                                  type="checkbox"
                                  checked={taskForm.notifyChannelIds.includes(ch.id)}
                                  onChange={(e) =>
                                    setTaskForm((prev) => ({
                                      ...prev,
                                      notifyChannelIds: e.target.checked
                                        ? [...prev.notifyChannelIds, ch.id]
                                        : prev.notifyChannelIds.filter((x) => x !== ch.id),
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

                <div className="flex flex-wrap gap-5 text-xs">
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={taskForm.assignPublicIp}
                      onChange={(e) => setTaskForm({ ...taskForm, assignPublicIp: e.target.checked })}
                      className="rounded accent-blue-600"
                    />
                    Public IPv4
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={taskForm.assignIpv6}
                      onChange={(e) => setTaskForm({ ...taskForm, assignIpv6: e.target.checked })}
                      className="rounded accent-blue-600"
                    />
                    IPv6
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={taskForm.autoStopOnSuccess}
                      onChange={(e) => setTaskForm({ ...taskForm, autoStopOnSuccess: e.target.checked })}
                      className="rounded accent-blue-600"
                    />
                    {t('autoStopOnSuccess')}
                  </label>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowSniperModal(false)}
                  className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  {t('cancel')}
                </button>
                <button
                  type="submit"
                  disabled={savingTask}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingTask && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {t('save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Export Standalone Zero-main.tf Bash / Python Script Modal */}
      {scriptModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <div className="w-full max-w-3xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 max-h-[88vh] flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
              <div>
                <div className="font-mono text-sm font-semibold text-slate-900 dark:text-white">
                  {scriptModal.filename}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  {t('scriptModalDesc')}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="inline-flex items-center gap-1 p-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-xs">
                  <button
                    type="button"
                    disabled={loadingScript}
                    onClick={() => void fetchScriptForTask(scriptModal.taskId, 'python')}
                    className={`px-2.5 py-1 rounded font-medium ${
                      scriptModal.format === 'python'
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white'
                        : 'text-slate-500'
                    }`}
                  >
                    Python (oci SDK)
                  </button>
                  <button
                    type="button"
                    disabled={loadingScript}
                    onClick={() => void fetchScriptForTask(scriptModal.taskId, 'bash')}
                    className={`px-2.5 py-1 rounded font-medium ${
                      scriptModal.format === 'bash'
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white'
                        : 'text-slate-500'
                    }`}
                  >
                    Bash (oci-cli)
                  </button>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await copyText(scriptModal.script);
                    if (ok) {
                      setCopiedScript(true);
                      setTimeout(() => setCopiedScript(false), 1800);
                      showNotice(isZh ? '脚本已复制到剪贴板' : 'Script copied to clipboard', 'success');
                    } else {
                      showNotice(isZh ? '复制失败，请手动选中复制' : 'Clipboard copy failed', 'error');
                    }
                  }}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  {copiedScript ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedScript ? t('copied') : t('copy')}
                </button>
                <button
                  type="button"
                  onClick={handleDownloadScript}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                >
                  <Download className="w-3.5 h-3.5" />
                  {t('download')}
                </button>
                <button type="button" onClick={() => setScriptModal(null)} className="p-1 text-slate-400">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 rounded-lg bg-slate-950 text-slate-100 font-mono text-xs leading-relaxed">
              {scriptModal.script}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
