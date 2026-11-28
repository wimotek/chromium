import { useState, type KeyboardEvent } from 'react';
import { Activity, Check, Database, Pencil, Play, RefreshCw, X } from 'lucide-react';

export interface ProductionAuditLog {
  id: string;
  actor: string;
  action: string;
  resource: string;
  ip: string;
  region: string;
  status: string;
  detail: string;
  timestamp: string;
}

export interface ProductionBackupFile {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ProductionCronTask {
  key: string;
  name: string;
  cron_expression: string;
  retention_policy: string;
  enabled: boolean;
}

export function AuditBackupPanel({
  auditLogs,
  backups,
  cronTasks,
  auditRetentionDays,
  backupRetentionCount,
  dbDriver,
  onRefresh,
}: {
  auditLogs: ProductionAuditLog[];
  backups: ProductionBackupFile[];
  cronTasks: ProductionCronTask[];
  auditRetentionDays: number;
  backupRetentionCount: number;
  dbDriver: string;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  // Inline in-place editing state for cron tasks
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editRetention, setEditRetention] = useState('');
  const [editCron, setEditCron] = useState('');
  const [editError, setEditError] = useState('');
  const [savingKey, setSavingKey] = useState<string | null>(null);

  async function handleRunBackup() {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/backups/run', { method: 'POST', credentials: 'include' });
      const b = await res.json().catch(() => ({}));
      setMsg(res.ok ? `备份完成：${b.file}` : b.error || '备份失败');
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleRotateAudit() {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/audit/rotate', { method: 'POST', credentials: 'include' });
      setMsg(res.ok ? '已完成滚动归档与过期审计日志清理。' : '归档失败');
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  function startInlineEdit(task: ProductionCronTask) {
    setEditingKey(task.key);
    setEditName(task.name);
    setEditRetention(task.retention_policy);
    setEditCron(task.cron_expression);
    setEditError('');
    setMsg('');
  }

  function cancelInlineEdit() {
    setEditingKey(null);
    setEditError('');
  }

  async function saveInlineEdit(taskKey: string) {
    const expr = editCron.trim();
    const fields = expr.split(/\s+/);
    if (fields.length !== 5 || fields.some((f) => !/^[0-9*/,\-]+$/.test(f))) {
      setEditError('Cron 表达式需为 5 段格式，例如 0 3 * * *');
      return;
    }
    setSavingKey(taskKey);
    setEditError('');
    try {
      const res = await fetch('/api/audit-cron/tasks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          key: taskKey,
          name: editName.trim(),
          retentionPolicy: editRetention.trim(),
          cronExpression: expr,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEditError(data.error || '保存失败');
        return;
      }
      setEditingKey(null);
      setMsg('计划任务配置已原地更新并重载调度器。');
      await onRefresh();
    } finally {
      setSavingKey(null);
    }
  }

  async function toggleTaskEnabled(task: ProductionCronTask) {
    setMsg('');
    const res = await fetch('/api/audit-cron/tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        key: task.key,
        enabled: !task.enabled,
      }),
    });
    if (res.ok) {
      await onRefresh();
    }
  }

  function handleInlineKeyDown(e: KeyboardEvent<HTMLInputElement>, taskKey: string) {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveInlineEdit(taskKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelInlineEdit();
    }
  }

  return (
    <div className="space-y-6 text-xs">
      {/* Scheduled Cron Tasks with In-Place Inline Editing */}
      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Database className="w-4 h-4 text-blue-600" />
              计划任务与数据库备份 ({dbDriver || 'sqlite3'})
            </h2>
            <p className="text-slate-500 mt-0.5">
              备份保留最近 {backupRetentionCount} 份 · 审计保留 {auditRetentionDays} 天 · 点击“编辑”可在原位置直接修改
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleRotateAudit}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <RefreshCw className="w-3.5 h-3.5" /> 清理过期日志
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleRunBackup}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
            >
              <Database className="w-3.5 h-3.5" /> 立即备份数据库
            </button>
          </div>
        </div>

        {msg && <div className="px-5 py-2.5 bg-emerald-50/60 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 border-b border-slate-200 dark:border-slate-800">{msg}</div>}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 text-slate-500">
                <th className="py-2.5 px-5">任务名称与保留策略</th>
                <th className="py-2.5 px-4">调度规则 (Cron)</th>
                <th className="py-2.5 px-4">状态</th>
                <th className="py-2.5 px-5 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {cronTasks.map((task) => {
                const isEditing = editingKey === task.key;
                return (
                  <tr key={task.key} className={isEditing ? 'bg-blue-50/40 dark:bg-blue-950/20' : undefined}>
                    <td className="py-3 px-5 align-top">
                      {isEditing ? (
                        <div className="space-y-1.5 min-w-[220px]">
                          <input
                            type="text"
                            aria-label="编辑任务名称"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => handleInlineKeyDown(e, task.key)}
                            className="w-full px-2.5 py-1.5 rounded-md border border-blue-400 dark:border-blue-600 bg-white dark:bg-slate-950 font-medium"
                          />
                          <input
                            type="text"
                            aria-label="编辑保留策略"
                            value={editRetention}
                            onChange={(e) => setEditRetention(e.target.value)}
                            onKeyDown={(e) => handleInlineKeyDown(e, task.key)}
                            className="w-full px-2.5 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-600 dark:text-slate-300"
                          />
                        </div>
                      ) : (
                        <>
                          <div className="font-medium text-slate-900 dark:text-slate-100">{task.name}</div>
                          <div className="text-slate-500 mt-0.5">{task.retention_policy}</div>
                        </>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono whitespace-nowrap align-top">
                      {isEditing ? (
                        <div className="space-y-1">
                          <input
                            type="text"
                            aria-label="编辑 Cron 表达式"
                            value={editCron}
                            onChange={(e) => {
                              setEditCron(e.target.value);
                              setEditError('');
                            }}
                            onKeyDown={(e) => handleInlineKeyDown(e, task.key)}
                            className="w-36 px-2.5 py-1.5 font-mono rounded-md border border-blue-400 dark:border-blue-600 bg-white dark:bg-slate-950"
                          />
                          {editError && (
                            <div className="text-[11px] font-sans text-red-600 dark:text-red-400 whitespace-normal max-w-[180px]">
                              {editError}
                            </div>
                          )}
                        </div>
                      ) : (
                        task.cron_expression
                      )}
                    </td>
                    <td className="py-3 px-4 align-top">
                      <button
                        type="button"
                        onClick={() => toggleTaskEnabled(task)}
                        className={task.enabled ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-slate-400 font-medium'}
                      >
                        {task.enabled ? '已启用' : '已暂停'}
                      </button>
                    </td>
                    <td className="py-3 px-5 text-right align-top">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        {isEditing ? (
                          <>
                            <button
                              type="button"
                              disabled={savingKey === task.key}
                              onClick={() => saveInlineEdit(task.key)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
                            >
                              <Check className="w-3 h-3" /> {savingKey === task.key ? '保存中...' : '保存'}
                            </button>
                            <button
                              type="button"
                              onClick={cancelInlineEdit}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              <X className="w-3 h-3" /> 取消
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => startInlineEdit(task)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              <Pencil className="w-3 h-3" /> 编辑
                            </button>
                            {(task.key === 'db_backup' || task.key === 'audit_rotate') && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={task.key === 'db_backup' ? handleRunBackup : handleRotateAudit}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                              >
                                <Play className="w-3 h-3" /> 立即运行
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="p-5 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
          <div className="font-semibold text-slate-800 dark:text-slate-200">最近数据库备份快照</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {backups.map((b) => (
              <div key={b.filename} className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 font-mono space-y-1">
                <div className="font-semibold truncate">{b.filename}</div>
                <div className="text-slate-500">
                  {(b.sizeBytes / 1024).toFixed(1)} KB · {b.createdAt.replace('T', ' ').slice(0, 19)}
                </div>
              </div>
            ))}
            {backups.length === 0 && (
              <div className="md:col-span-3 text-slate-400 py-1">暂无本地备份文件，点击“立即备份数据库”可即时创建一致性快照。</div>
            )}
          </div>
        </div>
      </section>

      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] overflow-x-auto">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 font-semibold text-sm flex items-center gap-2">
          <Activity className="w-4 h-4 text-blue-600" />
          安全与操作审计日志（最近 100 条）
        </div>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 text-slate-500">
              <th className="py-2.5 px-4">时间 (UTC)</th>
              <th className="py-2.5 px-3">操作人</th>
              <th className="py-2.5 px-3">动作 / 资源</th>
              <th className="py-2.5 px-3">IP / 地区</th>
              <th className="py-2.5 px-3">状态</th>
              <th className="py-2.5 px-4">详情</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {auditLogs.map((a) => (
              <tr key={a.id}>
                <td className="py-2.5 px-4 font-mono whitespace-nowrap text-slate-500">
                  {a.timestamp.replace('T', ' ').slice(0, 19)}
                </td>
                <td className="py-2.5 px-3 font-mono">{a.actor}</td>
                <td className="py-2.5 px-3 font-mono">
                  <span className="font-semibold">{a.action}</span> · <span className="text-slate-500">{a.resource}</span>
                </td>
                <td className="py-2.5 px-3 font-mono text-slate-500 whitespace-nowrap">
                  {a.ip} ({a.region})
                </td>
                <td className="py-2.5 px-3">
                  <span
                    className={
                      a.status === 'success'
                        ? 'text-emerald-600 font-medium'
                        : a.status === 'blocked'
                        ? 'text-red-600 font-medium'
                        : 'text-amber-600 font-medium'
                    }
                  >
                    {a.status}
                  </span>
                </td>
                <td className="py-2.5 px-4 text-slate-600 dark:text-slate-300 max-w-sm truncate">{a.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
