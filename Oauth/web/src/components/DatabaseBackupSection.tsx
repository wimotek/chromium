import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Download,
  HardDrive,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import type { BackupRecord, BackupSettings, Locale } from '../types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function DatabaseBackupSection({ locale }: { locale: Locale }) {
  const isZh = locale === 'zh-CN' || locale === 'zh-TW';
  const [settings, setSettings] = useState<BackupSettings>({
    enabled: true,
    retentionDays: 7,
    intervalHours: 24,
  });
  const [retentionInput, setRetentionInput] = useState<string>('7');
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [backupDir, setBackupDir] = useState<string>('/data/backups');
  const [loading, setLoading] = useState<boolean>(true);
  const [savingSettings, setSavingSettings] = useState<boolean>(false);
  const [runningNow, setRunningNow] = useState<boolean>(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function loadBackups() {
    setLoading(true);
    try {
      const res = await fetch('/api/system/backups');
      if (!res.ok) return;
      const data = await res.json();
      if (data.settings) {
        setSettings(data.settings);
        setRetentionInput(String(data.settings.retentionDays ?? 7));
      }
      if (Array.isArray(data.backups)) setBackups(data.backups);
      if (data.backupDir) setBackupDir(String(data.backupDir));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadBackups();
  }, []);

  async function handleSaveSettings(nextEnabled?: boolean, overrideDays?: number) {
    const parsedDays = overrideDays ?? Math.floor(Number(retentionInput));
    if (!Number.isFinite(parsedDays) || parsedDays < 1 || parsedDays > 365) {
      setNotice({
        kind: 'error',
        text: isZh ? '备份保留天数须在 1 到 365 天之间。' : 'Retention days must be between 1 and 365.',
      });
      return;
    }
    setSavingSettings(true);
    setNotice(null);
    try {
      const res = await fetch('/api/system/backups/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: nextEnabled ?? settings.enabled,
          retentionDays: parsedDays,
          intervalHours: settings.intervalHours,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ kind: 'error', text: data.message || 'Failed to update backup settings.' });
        return;
      }
      setSettings(data.settings);
      setRetentionInput(String(data.settings.retentionDays));
      if (Array.isArray(data.backups)) setBackups(data.backups);
      setNotice({
        kind: 'ok',
        text: isZh
          ? `备份策略已保存：自动备份${data.settings.enabled ? '已开启' : '已暂停'}，保留最近 ${data.settings.retentionDays} 天。`
          : `Backup policy saved: auto-backup ${data.settings.enabled ? 'ON' : 'OFF'}, retaining last ${data.settings.retentionDays} day(s).`,
      });
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleBackupNow() {
    setRunningNow(true);
    setNotice(null);
    try {
      const res = await fetch('/api/system/backups/now', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ kind: 'error', text: data.message || 'Backup failed.' });
        return;
      }
      if (Array.isArray(data.backups)) setBackups(data.backups);
      setNotice({
        kind: 'ok',
        text: isZh
          ? `已立即创建备份快照 ${data.backup?.filename || ''}。`
          : `Backup snapshot created: ${data.backup?.filename || ''}`,
      });
    } finally {
      setRunningNow(false);
    }
  }

  async function handleDeleteBackup(id: string) {
    setDeletingId(id);
    setNotice(null);
    try {
      const res = await fetch(`/api/system/backups/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ kind: 'error', text: data.message || 'Delete failed.' });
        return;
      }
      if (Array.isArray(data.backups)) setBackups(data.backups);
      setConfirmDeleteId(null);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <HardDrive className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
            {isZh ? '数据库备份与保留策略' : 'Database Backup & Retention Policy'}
          </h2>
        </div>
        <div className="flex items-center gap-2.5 text-xs font-mono text-slate-500 dark:text-slate-400">
          <span>{backupDir}</span>
          <span>·</span>
          <span className="tabular-nums">
            {isZh ? `保留最近 ${settings.retentionDays} 天` : `Keep last ${settings.retentionDays}d`}
          </span>
        </div>
      </div>

      <div className="p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-100 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => void handleSaveSettings(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-indigo-600"
              />
              <span className="font-medium text-slate-800 dark:text-slate-200">
                {isZh ? '每日定时自动备份' : 'Daily Automatic Backup'}
              </span>
            </label>

            <div className="flex items-center gap-2">
              <label htmlFor="backup-retention-days" className="text-slate-600 dark:text-slate-400 whitespace-nowrap">
                {isZh ? '保留天数：' : 'Retention days:'}
              </label>
              <input
                id="backup-retention-days"
                type="number"
                min={1}
                max={365}
                value={retentionInput}
                onChange={(e) => setRetentionInput(e.target.value)}
                className="w-20 min-h-[34px] px-2.5 py-1 font-mono text-xs tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
              />
              <div className="inline-flex items-center gap-1">
                {[7, 14, 30].map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      setRetentionInput(String(d));
                      void handleSaveSettings(undefined, d);
                    }}
                    className={`px-2 py-1 rounded-md text-[11px] font-mono border transition-colors ${
                      settings.retentionDays === d
                        ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    {d}{isZh ? '天' : 'd'}
                  </button>
                ))}
              </div>
              <button
                type="button"
                disabled={savingSettings}
                onClick={() => void handleSaveSettings()}
                className="min-h-[34px] px-3 py-1 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-800 dark:text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-60"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{isZh ? '保存策略' : 'Save Policy'}</span>
              </button>
            </div>
          </div>

          <button
            type="button"
            disabled={runningNow}
            onClick={() => void handleBackupNow()}
            className="min-h-[36px] px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${runningNow ? 'animate-spin' : ''}`} />
            <span>{runningNow ? (isZh ? '正在备份...' : 'Backing up...') : isZh ? '立即备份快照' : 'Backup Now'}</span>
          </button>
        </div>

        {notice && (
          <div
            role="status"
            className={`flex items-center gap-2 text-xs rounded-lg px-3.5 py-2.5 border ${
              notice.kind === 'error'
                ? 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/50'
                : 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/50'
            }`}
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{notice.text}</span>
          </div>
        )}

        <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 text-slate-500 dark:text-slate-400 font-medium">
                <th className="py-2.5 px-4">{isZh ? '快照文件名' : 'Backup File'}</th>
                <th className="py-2.5 px-4">{isZh ? '类型' : 'Trigger'}</th>
                <th className="py-2.5 px-4">{isZh ? '大小' : 'Size'}</th>
                <th className="py-2.5 px-4">{isZh ? '创建时间 / 过期自动清理' : 'Created / Auto-Expires'}</th>
                <th className="py-2.5 px-4 text-right whitespace-nowrap">{isZh ? '操作' : 'Actions'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {loading ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-400">
                    {isZh ? '正在读取备份列表...' : 'Loading backups...'}
                  </td>
                </tr>
              ) : backups.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-500 dark:text-slate-400">
                    {isZh ? '暂无备份文件，点击右上角「立即备份快照」生成。' : 'No backup snapshots yet. Click "Backup Now" to create one.'}
                  </td>
                </tr>
              ) : (
                backups.map((b) => (
                  <tr key={b.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                    <td className="py-2.5 px-4 font-mono text-slate-800 dark:text-slate-200">
                      {b.filename}
                    </td>
                    <td className="py-2.5 px-4 text-slate-600 dark:text-slate-400">
                      {b.trigger === 'scheduled'
                        ? isZh
                          ? '自动计划'
                          : 'Scheduled'
                        : isZh
                          ? '手动备份'
                          : 'Manual'}{' '}
                      · <span className="font-mono">{b.driver}</span>
                    </td>
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {formatBytes(b.sizeBytes)}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                      <div>{new Date(b.createdAt).toLocaleString()}</div>
                      <div className="text-slate-400">
                        {isZh ? '过期清理：' : 'Expires: '}
                        {new Date(b.expiresAt).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-right whitespace-nowrap">
                      {confirmDeleteId === b.id ? (
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300"
                          >
                            {isZh ? '取消' : 'Cancel'}
                          </button>
                          <button
                            type="button"
                            disabled={deletingId === b.id}
                            onClick={() => void handleDeleteBackup(b.id)}
                            className="px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-medium disabled:opacity-60"
                          >
                            {isZh ? '确认删除' : 'Delete'}
                          </button>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1.5">
                          <a
                            href={`/api/system/backups/${encodeURIComponent(b.id)}/download`}
                            download={b.filename}
                            className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1 font-medium"
                          >
                            <Download className="w-3 h-3" />
                            <span>{isZh ? '下载' : 'Download'}</span>
                          </a>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(b.id)}
                            title={isZh ? '删除备份' : 'Delete backup'}
                            aria-label={`Delete ${b.filename}`}
                            className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
