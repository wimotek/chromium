import React, { useState } from 'react';
import {
  Plus,
  Copy,
  Check,
  Eye,
  EyeOff,
  Trash2,
  Play,
  AlertCircle,
  Pencil,
  RefreshCw,
  CheckCircle2,
  X,
} from 'lucide-react';
import type { Locale, OAuthApplication } from '../types';
import { TRANSLATIONS } from '../lib/i18n';

interface ApplicationsViewProps {
  locale: Locale;
  applications: OAuthApplication[];
  onCreateApp: (payload: { name: string; description: string; redirectUris: string }) => Promise<void>;
  onUpdateApp: (id: string, payload: { name: string; description: string; redirectUris: string }) => Promise<void>;
  onResetSecret: (id: string) => Promise<string | null>;
  onDeleteApp: (id: string) => Promise<void>;
  onTestAppFlow: (clientId: string) => void;
}

export function ApplicationsView({
  locale,
  applications,
  onCreateApp,
  onUpdateApp,
  onResetSecret,
  onDeleteApp,
  onTestAppFlow,
}: ApplicationsViewProps) {
  const t = TRANSLATIONS[locale];
  const isZh = locale === 'zh-CN' || locale === 'zh-TW';

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [redirectUris, setRedirectUris] = useState('http://localhost:4000/callback\nhttps://app.company.com/auth/callback');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingApp, setEditingApp] = useState<OAuthApplication | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editRedirectUris, setEditRedirectUris] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [confirmResetApp, setConfirmResetApp] = useState<OAuthApplication | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [confirmDeleteApp, setConfirmDeleteApp] = useState<OAuthApplication | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{ text: string; secret?: string; isError?: boolean } | null>(null);

  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError(isZh ? '应用名称不能为空。' : 'Application name is required.');
      return;
    }
    setCreating(true);
    try {
      await onCreateApp({ name: name.trim(), description: description.trim(), redirectUris });
      setName('');
      setDescription('');
      setShowCreate(false);
      setActionNotice({ text: isZh ? '新应用已创建。' : 'Application registered.' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create application');
    } finally {
      setCreating(false);
    }
  }

  function startEdit(app: OAuthApplication) {
    setShowCreate(false);
    setConfirmResetApp(null);
    setConfirmDeleteApp(null);
    setEditError(null);
    setEditingApp(app);
    setEditName(app.name);
    setEditDescription(app.description || '');
    setEditRedirectUris(app.redirectUris.join('\n'));
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingApp) return;
    setEditError(null);
    if (!editName.trim()) {
      setEditError(isZh ? '应用名称不能为空。' : 'Application name is required.');
      return;
    }
    setSavingEdit(true);
    try {
      await onUpdateApp(editingApp.id, {
        name: editName.trim(),
        description: editDescription.trim(),
        redirectUris: editRedirectUris,
      });
      setActionNotice({
        text: isZh
          ? `已保存「${editName.trim()}」的配置变更。`
          : `Updated configuration for ${editName.trim()}.`,
      });
      setEditingApp(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update application');
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleConfirmResetSecret() {
    if (!confirmResetApp) return;
    const target = confirmResetApp;
    setResettingId(target.id);
    setActionNotice(null);
    try {
      const nextSecret = await onResetSecret(target.id);
      if (nextSecret) {
        setRevealedSecrets((prev) => ({ ...prev, [target.id]: true }));
        setActionNotice({
          text: isZh
            ? `已重置「${target.name}」的 Client Secret，旧密钥已立即失效，请同步更新业务端环境变量 OAUTH_SECRET。`
            : `Client Secret rotated for ${target.name}. The previous secret is immediately invalid — update OAUTH_SECRET in your app.`,
          secret: nextSecret,
        });
      }
      setConfirmResetApp(null);
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '重置密钥失败' : 'Failed to reset secret',
        isError: true,
      });
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
        text: isZh ? `已删除应用「${target.name}」。` : `Deleted application ${target.name}.`,
      });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '删除应用失败' : 'Failed to delete application',
        isError: true,
      });
    } finally {
      setDeletingId(null);
    }
  }

  async function handleCopy(key: string, val: string) {
    try {
      await navigator.clipboard.writeText(val);
      setCopiedId(key);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // ignore clipboard errors
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t.appsTitle}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 i18n-safe">
            {t.appsSubtitle}
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setEditingApp(null);
            setConfirmResetApp(null);
            setConfirmDeleteApp(null);
            setShowCreate((v) => !v);
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
          className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 rounded-xl border text-xs ${
            actionNotice.isError
              ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/60 text-red-800 dark:text-red-300'
              : 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/60 text-emerald-800 dark:text-emerald-300'
          }`}
        >
          <div className="flex items-start gap-2 min-w-0">
            {actionNotice.isError ? (
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            ) : (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            )}
            <div className="space-y-1 min-w-0">
              <p className="leading-relaxed">{actionNotice.text}</p>
              {actionNotice.secret && (
                <div className="inline-flex items-center gap-2 font-mono bg-white/80 dark:bg-slate-900/80 px-2.5 py-1 rounded border border-emerald-200 dark:border-emerald-800 text-slate-900 dark:text-slate-100">
                  <span>{actionNotice.secret}</span>
                  <button
                    type="button"
                    onClick={() => handleCopy('notice_secret', actionNotice.secret!)}
                    className="text-emerald-700 dark:text-emerald-400 hover:opacity-80 inline-flex items-center gap-1"
                  >
                    {copiedId === 'notice_secret' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedId === 'notice_secret' ? (isZh ? '已复制' : 'Copied') : isZh ? '复制新密钥' : 'Copy'}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss notice"
            onClick={() => setActionNotice(null)}
            className="p-1 opacity-70 hover:opacity-100 self-end sm:self-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {confirmDeleteApp && (
        <div
          role="alertdialog"
          aria-label="Confirm delete application"
          className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/60 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <div className="space-y-1 text-xs">
            <div className="font-semibold text-red-900 dark:text-red-200 text-sm flex items-center gap-1.5">
              <Trash2 className="w-4 h-4 shrink-0" />
              <span>
                {isZh
                  ? `确认删除业务应用「${confirmDeleteApp.name}」？`
                  : `Delete application ${confirmDeleteApp.name}?`}
              </span>
            </div>
            <p className="text-red-800/90 dark:text-red-300/90 leading-relaxed">
              {isZh
                ? `删除后 Client ID (${confirmDeleteApp.clientId}) 将立即从系统中移除，使用该应用的登录回调将失效。`
                : `Client ID (${confirmDeleteApp.clientId}) will be permanently removed and OAuth callbacks for this app will fail.`}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setConfirmDeleteApp(null)}
              className="px-3.5 py-2 rounded-lg border border-red-200 dark:border-red-800 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-red-100/50"
            >
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button
              type="button"
              disabled={deletingId === confirmDeleteApp.id}
              onClick={() => void handleConfirmDelete()}
              className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-medium flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>
                {deletingId === confirmDeleteApp.id
                  ? isZh
                    ? '删除中...'
                    : 'Deleting...'
                  : isZh
                    ? '确认删除'
                    : 'Confirm Delete'}
              </span>
            </button>
          </div>
        </div>
      )}

      {confirmResetApp && (
        <div
          role="alertdialog"
          aria-label="Confirm reset client secret"
          className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <div className="space-y-1 text-xs">
            <div className="font-semibold text-amber-900 dark:text-amber-200 text-sm flex items-center gap-1.5">
              <RefreshCw className="w-4 h-4 shrink-0" />
              <span>
                {isZh
                  ? `确认重置「${confirmResetApp.name}」的 Client Secret？`
                  : `Rotate Client Secret for ${confirmResetApp.name}?`}
              </span>
            </div>
            <p className="text-amber-800/90 dark:text-amber-300/90 leading-relaxed">
              {isZh
                ? `重置后旧的 Client Secret 将立即失效，正在使用旧密钥换票（/oauth/token）的业务服务会报错，直到你同步更新该应用的 OAUTH_SECRET（Client ID: ${confirmResetApp.clientId} 保持不变）。`
                : `The existing secret will be revoked immediately. Token exchanges for ${confirmResetApp.clientId} will fail until your app updates OAUTH_SECRET.`}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setConfirmResetApp(null)}
              className="px-3.5 py-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-amber-100/50"
            >
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button
              type="button"
              disabled={resettingId === confirmResetApp.id}
              onClick={() => void handleConfirmResetSecret()}
              className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white text-xs font-medium flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>
                {resettingId === confirmResetApp.id
                  ? isZh
                    ? '重置中...'
                    : 'Resetting...'
                  : isZh
                    ? '确认重置密钥'
                    : 'Confirm Reset Secret'}
              </span>
            </button>
          </div>
        </div>
      )}

      {editingApp && (
        <form
          onSubmit={handleSaveEdit}
          className="bg-white dark:bg-[#111827] border border-indigo-200 dark:border-indigo-900/70 rounded-xl p-6 space-y-4 shadow-xs"
        >
          <div className="flex items-center justify-between gap-3 pb-2 border-b border-slate-100 dark:border-slate-800">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                {isZh ? `编辑应用：${editingApp.name}` : `Edit Application: ${editingApp.name}`}
              </h2>
              <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                Client ID: {editingApp.clientId}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close edit form"
              onClick={() => setEditingApp(null)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="edit-app-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t.appName}
              </label>
              <input
                id="edit-app-name"
                type="text"
                required
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label htmlFor="edit-app-desc" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {isZh ? '应用说明' : 'Description'}
              </label>
              <input
                id="edit-app-desc"
                type="text"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div>
            <label htmlFor="edit-app-uris" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {t.redirectUris}
            </label>
            <textarea
              id="edit-app-uris"
              rows={3}
              required
              value={editRedirectUris}
              onChange={(e) => setEditRedirectUris(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          </div>

          {editError && (
            <div role="alert" className="flex items-center gap-2 text-xs text-red-700 dark:text-red-400">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{editError}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={() => setEditingApp(null)}
              className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={savingEdit}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-60"
            >
              {savingEdit ? '...' : isZh ? '保存修改' : 'Save Changes'}
            </button>
          </div>
        </form>
      )}

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="new-app-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t.appName}
              </label>
              <input
                id="new-app-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. CRM Web Console"
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label htmlFor="new-app-desc" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {isZh ? '应用说明' : 'Description'}
              </label>
              <input
                id="new-app-desc"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description for team members"
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div>
            <label htmlFor="new-app-uris" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {t.redirectUris}
            </label>
            <textarea
              id="new-app-uris"
              rows={3}
              required
              value={redirectUris}
              onChange={(e) => setRedirectUris(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          </div>

          {error && (
            <div role="alert" className="flex items-center gap-2 text-xs text-red-700 dark:text-red-400">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-60"
            >
              {creating ? '...' : t.createApp}
            </button>
          </div>
        </form>
      )}

      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {applications.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm text-slate-500 dark:text-slate-400">No applications registered yet.</p>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="mt-4 px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-medium"
            >
              {t.createApp}
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-900/40">
                  <th className="py-3 px-3.5">{t.appName}</th>
                  <th className="py-3 px-3.5">{t.clientId}</th>
                  <th className="py-3 px-3.5">{t.clientSecret}</th>
                  <th className="py-3 px-3.5">Redirect URIs</th>
                  <th className="py-3 px-3.5 text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-xs">
                {applications.map((app) => {
                  const revealed = Boolean(revealedSecrets[app.id]);
                  return (
                    <tr
                      key={app.id}
                      className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30 transition-colors"
                    >
                      <td className="py-3.5 px-3.5 align-top">
                        <div className="font-medium text-slate-900 dark:text-white text-sm">{app.name}</div>
                        {app.description && (
                          <div className="mt-0.5 text-slate-500 dark:text-slate-400 max-w-[180px]">
                            {app.description}
                          </div>
                        )}
                      </td>

                      <td className="py-3.5 px-3.5 align-top">
                        <div className="flex items-center gap-1 font-mono text-slate-700 dark:text-slate-300">
                          <span className="truncate max-w-[130px]" title={app.clientId}>
                            {app.clientId}
                          </span>
                          <button
                            type="button"
                            aria-label={`Copy Client ID for ${app.name}`}
                            onClick={() => handleCopy(`cid_${app.id}`, app.clientId)}
                            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white shrink-0"
                          >
                            {copiedId === `cid_${app.id}` ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>

                      <td className="py-3.5 px-3.5 align-top">
                        <div className="flex items-center gap-0.5 font-mono text-slate-700 dark:text-slate-300">
                          <span
                            className="truncate max-w-[125px]"
                            title={revealed ? app.clientSecret : undefined}
                          >
                            {revealed ? app.clientSecret : `${app.clientSecret.slice(0, 7)}••••••••`}
                          </span>
                          <button
                            type="button"
                            aria-label={`Toggle secret visibility for ${app.name}`}
                            title={isZh ? '显示/隐藏密钥' : 'Show/Hide Secret'}
                            onClick={() =>
                              setRevealedSecrets((prev) => ({ ...prev, [app.id]: !prev[app.id] }))
                            }
                            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white shrink-0"
                          >
                            {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            type="button"
                            aria-label={`Copy Client Secret for ${app.name}`}
                            title={isZh ? '复制密钥' : 'Copy Secret'}
                            onClick={() => handleCopy(`sec_${app.id}`, app.clientSecret)}
                            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white shrink-0"
                          >
                            {copiedId === `sec_${app.id}` ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            type="button"
                            aria-label={`Reset Client Secret for ${app.name}`}
                            title={isZh ? '重置 Client Secret' : 'Reset Client Secret'}
                            onClick={() => {
                              setEditingApp(null);
                              setShowCreate(false);
                              setConfirmResetApp(app);
                            }}
                            className="p-1 text-slate-400 hover:text-amber-600 dark:hover:text-amber-400 transition-colors shrink-0"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>

                      <td className="py-3.5 px-3.5 align-top">
                        <div className="space-y-1 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                          {app.redirectUris.map((uri) => (
                            <div key={uri} className="truncate max-w-[155px]" title={uri}>
                              {uri}
                            </div>
                          ))}
                        </div>
                      </td>

                      <td className="py-3.5 px-3.5 align-top text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => onTestAppFlow(app.clientId)}
                            className="px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 font-medium inline-flex items-center gap-1 whitespace-nowrap"
                          >
                            <Play className="w-3 h-3" />
                            <span>{t.testOidcFlow}</span>
                          </button>
                          <button
                            type="button"
                            aria-label={`Edit ${app.name}`}
                            title={isZh ? '编辑应用' : 'Edit Application'}
                            onClick={() => startEdit(app)}
                            className="p-1.5 rounded-md text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${app.name}`}
                            title={isZh ? '删除应用' : 'Delete Application'}
                            onClick={() => {
                              setEditingApp(null);
                              setShowCreate(false);
                              setConfirmResetApp(null);
                              setConfirmDeleteApp(app);
                            }}
                            className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
