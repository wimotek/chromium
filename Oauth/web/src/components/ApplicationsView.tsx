import React, { useState } from 'react';
import {
  Plus,
  Copy,
  Check,
  Eye,
  EyeOff,
  Trash2,
  X,
  Pencil,
  KeyRound,
  AlertTriangle,
  CheckCircle2,
  Lock,
  Unlock,
} from 'lucide-react';
import type { Locale, OAuthApplication } from '../types';
import { TRANSLATIONS } from '../lib/i18n';

interface ApplicationsViewProps {
  locale: Locale;
  applications: OAuthApplication[];
  onCreateApp: (payload: { name: string; description: string; redirectUris: string }) => Promise<void>;
  onUpdateApp: (
    id: string,
    payload: { name: string; description: string; redirectUris: string; scopes?: string[] }
  ) => Promise<void>;
  onToggleLock: (id: string, locked: boolean) => Promise<void>;
  onResetSecret: (id: string) => Promise<string | null>;
  onDeleteApp: (id: string) => Promise<void>;
  onTestAppFlow?: (clientId: string) => void;
}

export function ApplicationsView({
  locale,
  applications,
  onCreateApp,
  onUpdateApp,
  onToggleLock,
  onResetSecret,
  onDeleteApp,
}: ApplicationsViewProps) {
  const t = TRANSLATIONS[locale];
  const isZh = locale === 'zh-CN' || locale === 'zh-TW';
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [redirectUris, setRedirectUris] = useState('https://app.example.com/auth/callback');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingApp, setEditingApp] = useState<OAuthApplication | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editRedirectUris, setEditRedirectUris] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [lockingId, setLockingId] = useState<string | null>(null);
  const [confirmResetApp, setConfirmResetApp] = useState<OAuthApplication | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [confirmDeleteApp, setConfirmDeleteApp] = useState<OAuthApplication | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{ text: string; secret?: string; isError?: boolean } | null>(null);

  const [revealedIds, setRevealedIds] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      // ignore clipboard errors
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await onCreateApp({ name, description, redirectUris });
      setName('');
      setDescription('');
      setRedirectUris('https://app.example.com/auth/callback');
      setShowCreate(false);
      setActionNotice({
        text: isZh ? '新 OIDC 客户端应用已创建。' : 'New OIDC client application created.',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create application');
    } finally {
      setCreating(false);
    }
  }

  function startEdit(app: OAuthApplication) {
    if (app.locked) {
      setActionNotice({
        text: isZh ? '该应用已锁定，请先解锁后再修改。' : 'This application is locked. Unlock it before editing.',
        isError: true,
      });
      return;
    }
    setEditingApp(app);
    setEditName(app.name);
    setEditDescription(app.description || '');
    setEditRedirectUris(app.redirectUris.join('\n'));
    setEditError(null);
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingApp) return;
    setSavingEdit(true);
    setEditError(null);
    try {
      await onUpdateApp(editingApp.id, {
        name: editName,
        description: editDescription,
        redirectUris: editRedirectUris,
        scopes: editingApp.scopes,
      });
      setActionNotice({
        text: isZh ? `已更新应用「${editName.trim()}」。` : `Updated application "${editName.trim()}".`,
      });
      setEditingApp(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update application');
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleToggleLock(app: OAuthApplication) {
    const nextLocked = !app.locked;
    setLockingId(app.id);
    setActionNotice(null);
    try {
      await onToggleLock(app.id, nextLocked);
      setActionNotice({
        text: nextLocked
          ? isZh
            ? `已锁定应用「${app.name}」，防误删、防修改配置及密钥。`
            : `Locked "${app.name}". Editing, secret reset, and deletion are now blocked.`
          : isZh
            ? `已解锁应用「${app.name}」，现在可以编辑或删除。`
            : `Unlocked "${app.name}".`,
      });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : 'Failed to toggle lock',
        isError: true,
      });
    } finally {
      setLockingId(null);
    }
  }

  async function handleConfirmResetSecret() {
    if (!confirmResetApp) return;
    const target = confirmResetApp;
    setResettingId(target.id);
    setActionNotice(null);
    try {
      const newSecret = await onResetSecret(target.id);
      setRevealedIds((prev) => ({ ...prev, [target.id]: true }));
      setConfirmResetApp(null);
      setActionNotice({
        text: isZh
          ? `已为「${target.name}」重置新的 Client Secret，旧密钥立即失效。请立即更新下游业务服务配置：`
          : `Client Secret rotated for "${target.name}". The previous secret is immediately invalid. Update your downstream service:`,
        secret: newSecret || undefined,
      });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : 'Failed to reset client secret',
        isError: true,
      });
      setConfirmResetApp(null);
    } finally {
      setResettingId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!confirmDeleteApp) return;
    const target = confirmDeleteApp;
    setDeletingId(target.id);
    setActionNotice(null);
    try {
      await onDeleteApp(target.id);
      setConfirmDeleteApp(null);
      setActionNotice({
        text: isZh
          ? `已删除应用「${target.name}」（${target.clientId}）。`
          : `Deleted application "${target.name}" (${target.clientId}).`,
      });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : 'Failed to delete application',
        isError: true,
      });
      setConfirmDeleteApp(null);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t.appsTitle}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {t.appsSubtitle}
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setError(null);
            setShowCreate(true);
          }}
          className="min-h-[40px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span>{t.createApp}</span>
        </button>
      </div>

      {actionNotice && (
        <div
          role={actionNotice.isError ? 'alert' : 'status'}
          className={`rounded-xl px-4 py-3 border text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
            actionNotice.isError
              ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-300'
              : 'bg-emerald-50 dark:bg-emerald-950/25 border-emerald-200 dark:border-emerald-900/50 text-emerald-800 dark:text-emerald-300'
          }`}
        >
          <div className="flex items-start gap-2 min-w-0">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="space-y-1 min-w-0">
              <div>{actionNotice.text}</div>
              {actionNotice.secret && (
                <div className="flex items-center gap-2 pt-0.5">
                  <code className="font-mono font-semibold bg-white/80 dark:bg-slate-900/80 px-2 py-0.5 rounded border border-emerald-200 dark:border-emerald-800 text-slate-900 dark:text-white break-all">
                    {actionNotice.secret}
                  </code>
                  <button
                    type="button"
                    onClick={() => copy('notice_secret', actionNotice.secret!)}
                    className="px-2 py-0.5 rounded border border-emerald-300 dark:border-emerald-800 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/40 font-medium inline-flex items-center gap-1 whitespace-nowrap"
                  >
                    {copiedKey === 'notice_secret' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedKey === 'notice_secret' ? (isZh ? '已复制' : 'Copied') : isZh ? '复制新密钥' : 'Copy'}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setActionNotice(null)}
            aria-label="Dismiss notice"
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white self-start sm:self-center shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-900/40">
                <th className="py-3 px-4">{isZh ? '应用名称' : 'Application'}</th>
                <th className="py-3 px-4">{isZh ? '客户端凭证' : 'Credentials'}</th>
                <th className="py-3 px-4">{isZh ? '回调白名单' : 'Redirect URIs'}</th>
                <th className="py-3 px-4 text-right whitespace-nowrap">{isZh ? '操作' : 'Actions'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-xs">
              {applications.map((app) => {
                const revealed = Boolean(revealedIds[app.id]);
                const maskedSecret = `${app.clientSecret.slice(0, 8)}••••••••••••`;
                const isLocked = Boolean(app.locked);

                return (
                  <tr key={app.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30 transition-colors">
                    <td className="py-3.5 px-4 align-top max-w-[260px]">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-semibold text-sm text-slate-900 dark:text-white">{app.name}</span>
                        {isLocked && (
                          <span
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-400"
                            title={isZh ? '应用已锁定，防删防改' : 'Locked against edits and deletion'}
                          >
                            <Lock className="w-3 h-3" />
                            <span>{isZh ? '已锁定' : 'Locked'}</span>
                          </span>
                        )}
                      </div>
                      {app.description && (
                        <div className="mt-0.5 text-slate-500 dark:text-slate-400">{app.description}</div>
                      )}
                      <div className="mt-1 text-[11px] text-slate-400 font-mono">
                        {app.scopes.join(' · ')}
                      </div>
                    </td>

                    <td className="py-3.5 px-4 align-top space-y-1.5 font-mono">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-slate-400 w-10 shrink-0">ID:</span>
                        <code className="text-slate-800 dark:text-slate-200 truncate max-w-[200px]" title={app.clientId}>
                          {app.clientId}
                        </code>
                        <button
                          type="button"
                          onClick={() => copy(`id_${app.id}`, app.clientId)}
                          aria-label="Copy Client ID"
                          title={isZh ? '复制 Client ID' : 'Copy Client ID'}
                          className="p-1 text-slate-400 hover:text-slate-800 dark:hover:text-white shrink-0"
                        >
                          {copiedKey === `id_${app.id}` ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-slate-400 w-10 shrink-0">Secret:</span>
                        <code className="text-slate-600 dark:text-slate-400 truncate max-w-[175px]" title={revealed ? app.clientSecret : undefined}>
                          {revealed ? app.clientSecret : maskedSecret}
                        </code>
                        <button
                          type="button"
                          onClick={() => setRevealedIds((prev) => ({ ...prev, [app.id]: !prev[app.id] }))}
                          aria-label="Toggle Client Secret visibility"
                          title={revealed ? (isZh ? '隐藏密钥' : 'Hide secret') : isZh ? '显示密钥' : 'Reveal secret'}
                          className="p-1 text-slate-400 hover:text-slate-800 dark:hover:text-white shrink-0"
                        >
                          {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => copy(`sec_${app.id}`, app.clientSecret)}
                          aria-label="Copy Client Secret"
                          title={isZh ? '复制 Client Secret' : 'Copy Client Secret'}
                          className="p-1 text-slate-400 hover:text-slate-800 dark:hover:text-white shrink-0"
                        >
                          {copiedKey === `sec_${app.id}` ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </td>

                    <td className="py-3.5 px-4 align-top max-w-[260px]">
                      <div className="space-y-1 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                        {app.redirectUris.map((uri) => (
                          <div key={uri} className="truncate" title={uri}>
                            {uri}
                          </div>
                        ))}
                      </div>
                    </td>

                    <td className="py-3.5 px-4 align-top text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1">
                        <button
                          type="button"
                          disabled={lockingId === app.id}
                          onClick={() => void handleToggleLock(app)}
                          aria-label={isLocked ? `Unlock ${app.name}` : `Lock ${app.name}`}
                          title={
                            isLocked
                              ? isZh
                                ? '点击解锁应用'
                                : 'Unlock application'
                              : isZh
                                ? '锁定应用（防删防改）'
                                : 'Lock application (prevent edits & deletion)'
                          }
                          className={`p-1.5 rounded-md transition-colors disabled:opacity-50 ${
                            isLocked
                              ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 hover:bg-amber-100 dark:hover:bg-amber-900/50'
                              : 'text-slate-500 dark:text-slate-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/40'
                          }`}
                        >
                          {isLocked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          type="button"
                          disabled={isLocked}
                          onClick={() => startEdit(app)}
                          aria-label={`Edit ${app.name}`}
                          title={
                            isLocked
                              ? isZh
                                ? '已锁定：解锁后可编辑'
                                : 'Locked: unlock to edit'
                              : isZh
                                ? '编辑应用（弹窗）'
                                : 'Edit application'
                          }
                          className="p-1.5 rounded-md text-slate-500 dark:text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={isLocked}
                          onClick={() => setConfirmResetApp(app)}
                          aria-label={`Reset secret for ${app.name}`}
                          title={
                            isLocked
                              ? isZh
                                ? '已锁定：解锁后可重置密钥'
                                : 'Locked: unlock to rotate secret'
                              : isZh
                                ? '重置 Client Secret'
                                : 'Reset Client Secret'
                          }
                          className="p-1.5 rounded-md text-slate-500 dark:text-slate-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <KeyRound className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={isLocked}
                          onClick={() => setConfirmDeleteApp(app)}
                          aria-label={`Delete ${app.name}`}
                          title={
                            isLocked
                              ? isZh
                                ? '已锁定：解锁后可删除'
                                : 'Locked: unlock to delete'
                              : isZh
                                ? '删除应用'
                                : 'Delete application'
                          }
                          className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {applications.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
                    {isZh ? '暂未注册 OAuth 应用客户端。' : 'No OAuth client applications registered yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-label={t.createApp}
        >
          <form
            onSubmit={handleSubmit}
            className="w-full max-w-lg bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden"
          >
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">{t.createApp}</h2>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                aria-label="Close create dialog"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="app-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t.appName}
                  </label>
                  <input
                    id="app-name"
                    type="text"
                    required
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Wimotek Billing Portal"
                    className="w-full min-h-[40px] px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                  />
                </div>
                <div>
                  <label htmlFor="app-desc" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {isZh ? '应用描述' : 'Description'}
                  </label>
                  <input
                    id="app-desc"
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Internal SSO client"
                    className="w-full min-h-[40px] px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="app-uris" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.redirectUris}
                </label>
                <textarea
                  id="app-uris"
                  rows={3}
                  required
                  value={redirectUris}
                  onChange={(e) => setRedirectUris(e.target.value)}
                  className="w-full px-3.5 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                />
              </div>

              {error && (
                <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}
            </div>

            <div className="px-5 py-3.5 bg-slate-50/70 dark:bg-[#0B0F19] border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="min-h-[38px] px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800"
              >
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={creating}
                className="min-h-[38px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium disabled:opacity-60"
              >
                {creating ? '...' : isZh ? '保存' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      {editingApp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-label={isZh ? '编辑应用' : 'Edit Application'}
        >
          <form
            onSubmit={handleSaveEdit}
            className="w-full max-w-lg bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden"
          >
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                  {isZh ? `编辑应用：${editingApp.name}` : `Edit Application: ${editingApp.name}`}
                </h2>
                <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                  client_id: {editingApp.clientId}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingApp(null)}
                aria-label="Close edit dialog"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="edit-app-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t.appName}
                  </label>
                  <input
                    id="edit-app-name"
                    type="text"
                    required
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full min-h-[40px] px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                  />
                </div>
                <div>
                  <label htmlFor="edit-app-desc" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {isZh ? '应用描述' : 'Description'}
                  </label>
                  <input
                    id="edit-app-desc"
                    type="text"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    className="w-full min-h-[40px] px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="edit-app-uris" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.redirectUris}
                </label>
                <textarea
                  id="edit-app-uris"
                  rows={4}
                  required
                  value={editRedirectUris}
                  onChange={(e) => setEditRedirectUris(e.target.value)}
                  className="w-full px-3.5 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                />
              </div>

              {editError && (
                <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded-lg px-3 py-2">
                  {editError}
                </div>
              )}
            </div>

            <div className="px-5 py-3.5 bg-slate-50/70 dark:bg-[#0B0F19] border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingApp(null)}
                className="min-h-[38px] px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800"
              >
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={savingEdit}
                className="min-h-[38px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium disabled:opacity-60"
              >
                {savingEdit ? '...' : isZh ? '保存修改' : 'Save Changes'}
              </button>
            </div>
          </form>
        </div>
      )}

      {confirmResetApp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-[2px]"
          role="alertdialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <h3 className="text-sm font-semibold">
                {isZh ? `确认重置「${confirmResetApp.name}」的密钥？` : `Reset Client Secret for "${confirmResetApp.name}"?`}
              </h3>
            </div>
            <div className="p-5 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              {isZh
                ? '旧的 Client Secret 将立刻失效，所有使用旧密钥换取 Token 的业务系统将失败，直到更新为新密钥。'
                : 'The previous secret stops working immediately. Downstream services must be updated with the new secret.'}
            </div>
            <div className="px-5 py-3.5 bg-slate-50/70 dark:bg-[#0B0F19] border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmResetApp(null)}
                className="min-h-[36px] px-3.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                disabled={resettingId === confirmResetApp.id}
                onClick={() => void handleConfirmResetSecret()}
                className="min-h-[36px] px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-60"
              >
                {resettingId === confirmResetApp.id ? '...' : isZh ? '确认重置密钥' : 'Confirm Reset'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteApp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-[2px]"
          role="alertdialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 text-red-700 dark:text-red-400">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <h3 className="text-sm font-semibold">
                {isZh ? `确认删除应用「${confirmDeleteApp.name}」？` : `Delete application "${confirmDeleteApp.name}"?`}
              </h3>
            </div>
            <div className="p-5 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              {isZh
                ? `删除后，客户端 ${confirmDeleteApp.clientId} 将无法发起新的 OIDC 登录授权或换取 Token。此操作不可撤销。`
                : `Client ${confirmDeleteApp.clientId} will immediately lose OIDC authorization and token exchange access. This cannot be undone.`}
            </div>
            <div className="px-5 py-3.5 bg-slate-50/70 dark:bg-[#0B0F19] border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteApp(null)}
                className="min-h-[36px] px-3.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                disabled={deletingId === confirmDeleteApp.id}
                onClick={() => void handleConfirmDelete()}
                className="min-h-[36px] px-4 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-medium disabled:opacity-60"
              >
                {deletingId === confirmDeleteApp.id ? '...' : isZh ? '确认删除' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
