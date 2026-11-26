import React, { useEffect, useState } from 'react';
import {
  Plus,
  Check,
  Lock,
  GripVertical,
  ArrowUp,
  ArrowDown,
  Trash2,
  AlertCircle,
  CheckCircle2,
  X,
} from 'lucide-react';
import type { Locale, SocialConnector } from '../types';
import { TRANSLATIONS, moveConnectorByIndex } from '../lib/i18n';
import { ProviderIcon } from './ProviderIcons';

interface ConnectorsViewProps {
  locale: Locale;
  connectors: SocialConnector[];
  onUpdateConnector: (
    id: string,
    payload: {
      enabled?: boolean;
      displayName?: string;
      clientId?: string;
      clientSecret?: string;
      extra?: Record<string, string>;
    }
  ) => Promise<void>;
  onAddCustomConnector: (payload: {
    displayName: string;
    clientId: string;
    clientSecret: string;
    issuerUrl: string;
  }) => Promise<void>;
  onDeleteConnector: (id: string) => Promise<void>;
  onReorderConnectors: (orderedIds: string[]) => Promise<void>;
}

export function ConnectorsView({
  locale,
  connectors,
  onUpdateConnector,
  onAddCustomConnector,
  onDeleteConnector,
  onReorderConnectors,
}: ConnectorsViewProps) {
  const t = TRANSLATIONS[locale];
  const isZh = locale === 'zh-CN' || locale === 'zh-TW';
  const [selectedId, setSelectedId] = useState<string>(connectors[0]?.id || '');
  const selected = connectors.find((c) => c.id === selectedId) || connectors[0];

  const [draftDisplayName, setDraftDisplayName] = useState(selected?.displayName || '');
  const [draftClientId, setDraftClientId] = useState(selected?.clientId || '');
  const [draftSecret, setDraftSecret] = useState('');
  const [draftExtra, setDraftExtra] = useState<Record<string, string>>(selected?.extra || {});
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const [confirmDeleteConn, setConfirmDeleteConn] = useState<SocialConnector | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{ text: string; isError?: boolean } | null>(null);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const [showAddCustom, setShowAddCustom] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customIssuer, setCustomIssuer] = useState('https://idp.partner.com');
  const [customClientId, setCustomClientId] = useState('');
  const [customSecret, setCustomSecret] = useState('');
  const [addingCustom, setAddingCustom] = useState(false);

  useEffect(() => {
    if (connectors.length === 0) return;
    const match = connectors.find((c) => c.id === selectedId);
    if (!match) {
      const first = connectors[0];
      setSelectedId(first.id);
      setDraftDisplayName(first.displayName);
      setDraftClientId(first.clientId);
      setDraftSecret('');
      setDraftExtra({ ...first.extra });
    }
  }, [connectors, selectedId]);

  // Map enabled connectors to their 1-based display rank on the Hosted Login page
  const enabledRankMap = new Map<string, number>();
  let enabledRank = 0;
  for (const conn of connectors) {
    if (conn.enabled) {
      enabledRank += 1;
      enabledRankMap.set(conn.id, enabledRank);
    }
  }

  function handleMoveByOffset(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= connectors.length) return;
    const next = moveConnectorByIndex(connectors, index, target);
    void onReorderConnectors(next.map((c) => c.id));
  }

  function handleDropOn(targetId: string) {
    if (!draggingId || draggingId === targetId) {
      setDraggingId(null);
      setDragOverId(null);
      return;
    }
    const fromIndex = connectors.findIndex((c) => c.id === draggingId);
    const toIndex = connectors.findIndex((c) => c.id === targetId);
    if (fromIndex !== -1 && toIndex !== -1) {
      const next = moveConnectorByIndex(connectors, fromIndex, toIndex);
      void onReorderConnectors(next.map((c) => c.id));
    }
    setDraggingId(null);
    setDragOverId(null);
  }

  function selectConnector(c: SocialConnector) {
    setSelectedId(c.id);
    setDraftDisplayName(c.displayName);
    setDraftClientId(c.clientId);
    setDraftSecret('');
    setDraftExtra({ ...c.extra });
    setSavedNotice(false);
  }

  async function handleToggle(c: SocialConnector) {
    setActionNotice(null);
    try {
      await onUpdateConnector(c.id, { enabled: !c.enabled });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '切换连接器状态失败' : 'Failed to toggle connector',
        isError: true,
      });
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setSaving(true);
    setActionNotice(null);
    try {
      await onUpdateConnector(selected.id, {
        displayName: selected.provider === 'custom_oidc' ? draftDisplayName.trim() || selected.displayName : undefined,
        clientId: draftClientId,
        clientSecret: draftSecret || undefined,
        extra: draftExtra,
      });
      setDraftSecret('');
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 2000);
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '保存连接器失败' : 'Failed to save connector',
        isError: true,
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateCustom(e: React.FormEvent) {
    e.preventDefault();
    if (!customName.trim()) return;
    setAddingCustom(true);
    setActionNotice(null);
    try {
      await onAddCustomConnector({
        displayName: customName.trim(),
        clientId: customClientId.trim(),
        clientSecret: customSecret.trim(),
        issuerUrl: customIssuer.trim(),
      });
      setActionNotice({
        text: isZh
          ? `已添加自定义 OIDC 连接器「${customName.trim()}」。`
          : `Added custom OIDC connector "${customName.trim()}".`,
      });
      setCustomName('');
      setCustomClientId('');
      setCustomSecret('');
      setShowAddCustom(false);
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '添加自定义连接器失败' : 'Failed to add custom connector',
        isError: true,
      });
    } finally {
      setAddingCustom(false);
    }
  }

  async function handleConfirmDelete() {
    if (!confirmDeleteConn) return;
    const target = confirmDeleteConn;
    setDeletingId(target.id);
    setActionNotice(null);
    try {
      await onDeleteConnector(target.id);
      setConfirmDeleteConn(null);
      setActionNotice({
        text: isZh
          ? `已删除自定义 OIDC 连接器「${target.displayName}」。`
          : `Deleted custom OIDC connector "${target.displayName}".`,
      });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '删除连接器失败' : 'Failed to delete connector',
        isError: true,
      });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t.connectorsTitle}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 i18n-safe">
            {t.connectorsSubtitle}
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setConfirmDeleteConn(null);
            setShowAddCustom((v) => !v);
          }}
          className="min-h-[40px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span>{t.addCustomOidc}</span>
        </button>
      </div>

      {/* Feedback Notice */}
      {actionNotice && (
        <div
          role={actionNotice.isError ? 'alert' : 'status'}
          className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border text-xs ${
            actionNotice.isError
              ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/60 text-red-800 dark:text-red-300'
              : 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/60 text-emerald-800 dark:text-emerald-300'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            {actionNotice.isError ? (
              <AlertCircle className="w-4 h-4 shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            )}
            <span className="leading-relaxed">{actionNotice.text}</span>
          </div>
          <button
            type="button"
            aria-label="Dismiss notice"
            onClick={() => setActionNotice(null)}
            className="p-1 opacity-70 hover:opacity-100 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Inline Delete Custom OIDC Confirmation Banner */}
      {confirmDeleteConn && (
        <div
          role="alertdialog"
          aria-label="Confirm delete custom OIDC connector"
          className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/60 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <div className="space-y-1 text-xs">
            <div className="font-semibold text-red-900 dark:text-red-200 text-sm flex items-center gap-1.5">
              <Trash2 className="w-4 h-4 shrink-0" />
              <span>
                {isZh
                  ? `确认删除自定义 OIDC 连接器「${confirmDeleteConn.displayName}」？`
                  : `Delete custom OIDC connector "${confirmDeleteConn.displayName}"?`}
              </span>
            </div>
            <p className="text-red-800/90 dark:text-red-300/90 leading-relaxed">
              {isZh
                ? '删除后该第三方 OIDC 登录入口将从登录页与数据库中永久移除。'
                : 'This custom OIDC provider will be permanently removed from the hosted login page and database.'}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setConfirmDeleteConn(null)}
              className="px-3.5 py-2 rounded-lg border border-red-200 dark:border-red-800 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-red-100/50"
            >
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button
              type="button"
              disabled={deletingId === confirmDeleteConn.id}
              onClick={() => void handleConfirmDelete()}
              className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-medium flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>
                {deletingId === confirmDeleteConn.id
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

      {showAddCustom && (
        <form
          onSubmit={handleCreateCustom}
          className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4"
        >
          <div className="text-sm font-semibold text-slate-900 dark:text-white">
            {isZh
              ? '添加自定义 OIDC 连接器（通用 OIDC / 飞书 / 钉钉 / Discord）'
              : 'Register Extensible ProviderAdapter (Generic OIDC / Feishu / DingTalk / Discord)'}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="custom-conn-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                {isZh ? '显示名称' : 'Display Name'}
              </label>
              <input
                id="custom-conn-name"
                type="text"
                required
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="e.g. Feishu / Discord"
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label htmlFor="custom-conn-issuer" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Discovery / Issuer URL
              </label>
              <input
                id="custom-conn-issuer"
                type="url"
                value={customIssuer}
                onChange={(e) => setCustomIssuer(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label htmlFor="custom-conn-cid" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Client ID
              </label>
              <input
                id="custom-conn-cid"
                type="text"
                value={customClientId}
                onChange={(e) => setCustomClientId(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label htmlFor="custom-conn-sec" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Client Secret (AES-256-GCM Encrypted)
              </label>
              <input
                id="custom-conn-sec"
                type="password"
                value={customSecret}
                onChange={(e) => setCustomSecret(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAddCustom(false)}
              className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700"
            >
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={addingCustom}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white"
            >
              {addingCustom ? '...' : isZh ? '添加连接器' : 'Add Provider'}
            </button>
          </div>
        </form>
      )}

      {/* Split Workspace: Provider List + Live Editor */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Draggable List */}
        <div className="lg:col-span-5 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl divide-y divide-slate-100 dark:divide-slate-800 overflow-hidden">
          <div className="px-4 py-3 bg-slate-50/80 dark:bg-slate-900/50 flex items-center justify-between gap-2 text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {isZh ? '拖动调整登录页展示顺序' : 'Drag to reorder Hosted Login buttons'}
            </span>
            <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
              {isZh ? '前 3 个置顶 · 其余折叠' : 'Top 3 primary · rest folded'}
            </span>
          </div>

          {connectors.map((c, idx) => {
            const isSelected = selected?.id === c.id;
            const isDragging = draggingId === c.id;
            const isDragOver = dragOverId === c.id && draggingId !== c.id;
            const rank = enabledRankMap.get(c.id);
            const isCustom = c.provider === 'custom_oidc';

            return (
              <div
                key={c.id}
                draggable
                onDragStart={(e) => {
                  setDraggingId(c.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', c.id);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dragOverId !== c.id) setDragOverId(c.id);
                }}
                onDragLeave={() => {
                  if (dragOverId === c.id) setDragOverId(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDropOn(c.id);
                }}
                onDragEnd={() => {
                  setDraggingId(null);
                  setDragOverId(null);
                }}
                className={`px-3 py-3.5 flex items-center justify-between gap-2 transition-colors ${
                  isSelected
                    ? 'bg-indigo-50/60 dark:bg-indigo-950/30'
                    : 'hover:bg-slate-50/70 dark:hover:bg-slate-800/30'
                } ${isDragging ? 'opacity-45' : ''} ${
                  isDragOver ? 'ring-2 ring-inset ring-indigo-500/70 bg-indigo-50/80 dark:bg-indigo-950/40' : ''
                }`}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span
                    className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-grab active:cursor-grabbing shrink-0"
                    title={isZh ? '按住拖动排序' : 'Drag to reorder'}
                    aria-hidden="true"
                  >
                    <GripVertical className="w-4 h-4" />
                  </span>

                  <button
                    type="button"
                    onClick={() => selectConnector(c)}
                    className="flex items-center gap-2.5 text-left min-w-0 flex-1"
                  >
                    <div className="w-9 h-9 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 flex items-center justify-center shrink-0">
                      <ProviderIcon provider={c.provider} className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 dark:text-white truncate">
                        {c.displayName}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                        <span className={c.enabled ? 'text-emerald-600 dark:text-emerald-400 font-medium' : ''}>
                          {c.enabled ? t.connectorEnabled : t.connectorDisabled}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums text-[11px]">
                          {rank
                            ? rank <= 3
                              ? `#${rank} ${isZh ? '主位' : 'Primary'}`
                              : `#${rank} ${isZh ? '折叠' : 'More'}`
                            : isZh
                              ? '隐藏'
                              : 'Hidden'}
                        </span>
                      </div>
                    </div>
                  </button>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {isCustom && (
                    <button
                      type="button"
                      aria-label={`Delete ${c.displayName}`}
                      title={isZh ? '删除自定义 OIDC' : 'Delete custom OIDC'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowAddCustom(false);
                        setConfirmDeleteConn(c);
                      }}
                      className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}

                  <div className="flex flex-col">
                    <button
                      type="button"
                      disabled={idx === 0}
                      aria-label={`Move ${c.displayName} up`}
                      onClick={() => handleMoveByOffset(idx, -1)}
                      className="p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-25 transition-colors"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === connectors.length - 1}
                      aria-label={`Move ${c.displayName} down`}
                      onClick={() => handleMoveByOffset(idx, 1)}
                      className="p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-25 transition-colors"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={c.enabled}
                    aria-label={`Toggle ${c.displayName}`}
                    onClick={() => void handleToggle(c)}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                      c.enabled ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-700'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        c.enabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Right Detail Configuration Form */}
        {selected && (
          <form
            onSubmit={handleSave}
            className="lg:col-span-7 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5"
          >
            <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-3 min-w-0">
                <ProviderIcon provider={selected.provider} className="w-5 h-5 shrink-0" />
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-slate-900 dark:text-white truncate">
                    {selected.displayName}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Adapter: <code className="font-mono">{selected.provider}</code> · Immediate runtime reload
                  </p>
                </div>
              </div>
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center gap-1 shrink-0">
                <Lock className="w-3.5 h-3.5" />
                AES-256-GCM
              </span>
            </div>

            <div className="space-y-4">
              {selected.provider === 'custom_oidc' && (
                <>
                  <div>
                    <label htmlFor="conn-display-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      {isZh ? '显示名称' : 'Display Name'}
                    </label>
                    <input
                      id="conn-display-name"
                      type="text"
                      value={draftDisplayName}
                      onChange={(e) => setDraftDisplayName(e.target.value)}
                      className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label htmlFor="conn-discovery-url" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Discovery / Issuer URL
                    </label>
                    <input
                      id="conn-discovery-url"
                      type="url"
                      value={draftExtra.discovery_url || ''}
                      onChange={(e) => setDraftExtra((prev) => ({ ...prev, discovery_url: e.target.value }))}
                      placeholder="https://idp.partner.com"
                      className="w-full min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </>
              )}

              <div>
                <label htmlFor="conn-client-id" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  {selected.provider === 'wechat' ? 'AppID' : selected.provider === 'apple' ? 'Service ID (client_id)' : 'Client ID'}
                </label>
                <input
                  id="conn-client-id"
                  type="text"
                  value={draftClientId}
                  onChange={(e) => setDraftClientId(e.target.value)}
                  className="w-full min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label htmlFor="conn-client-secret" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  {selected.provider === 'apple' ? '.p8 Private Key PEM (Encrypted at Rest)' : 'Client Secret (Encrypted at Rest)'}
                </label>
                {selected.provider === 'apple' ? (
                  <textarea
                    id="conn-client-secret"
                    rows={3}
                    value={draftSecret}
                    onChange={(e) => setDraftSecret(e.target.value)}
                    placeholder={selected.hasSecret ? `Stored encrypted (${selected.secretMasked}) — paste new .p8 to rotate` : '-----BEGIN PRIVATE KEY-----'}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                  />
                ) : (
                  <input
                    id="conn-client-secret"
                    type="password"
                    value={draftSecret}
                    onChange={(e) => setDraftSecret(e.target.value)}
                    placeholder={selected.hasSecret ? `Encrypted (${selected.secretMasked}) — enter new secret to update` : 'Enter client secret'}
                    className="w-full min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                  />
                )}
              </div>

              {/* Provider-Specific Fields */}
              {selected.provider === 'microsoft' && (
                <div>
                  <label htmlFor="ms-tenant" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Entra ID Tenant (common / organizations / tenant-uuid)
                  </label>
                  <input
                    id="ms-tenant"
                    type="text"
                    value={draftExtra.tenant_id || 'common'}
                    onChange={(e) => setDraftExtra((prev) => ({ ...prev, tenant_id: e.target.value }))}
                    className="w-full min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                </div>
              )}

              {selected.provider === 'apple' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="apple-team" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Apple Team ID
                    </label>
                    <input
                      id="apple-team"
                      type="text"
                      value={draftExtra.team_id || ''}
                      onChange={(e) => setDraftExtra((prev) => ({ ...prev, team_id: e.target.value }))}
                      className="w-full min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                  </div>
                  <div>
                    <label htmlFor="apple-key" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Apple Key ID (response_mode: form_post)
                    </label>
                    <input
                      id="apple-key"
                      type="text"
                      value={draftExtra.key_id || ''}
                      onChange={(e) => setDraftExtra((prev) => ({ ...prev, key_id: e.target.value }))}
                      className="w-full min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                  </div>
                </div>
              )}

              {selected.provider === 'wechat' && (
                <div>
                  <label htmlFor="wechat-mode" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    WeChat Authorization Mode
                  </label>
                  <select
                    id="wechat-mode"
                    value={draftExtra.wechat_mode || 'qr'}
                    onChange={(e) => setDraftExtra((prev) => ({ ...prev, wechat_mode: e.target.value }))}
                    className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  >
                    <option value="qr">微信开放平台扫码登录 (qrconnect / snsapi_login)</option>
                    <option value="mp">微信公众号网页授权 (oauth2 / snsapi_userinfo)</option>
                  </select>
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                {selected.provider === 'custom_oidc' && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddCustom(false);
                      setConfirmDeleteConn(selected);
                    }}
                    className="min-h-[38px] px-3 py-2 rounded-lg border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 text-xs font-medium inline-flex items-center gap-1.5 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{isZh ? '删除此自定义连接器' : 'Delete Custom OIDC'}</span>
                  </button>
                )}

                {savedNotice && (
                  <div className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                    <Check className="w-4 h-4" />
                    <span>{isZh ? '已保存并即时生效' : 'Saved & active immediately on Hosted Login'}</span>
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={saving}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition-colors disabled:opacity-60"
              >
                {saving ? '...' : t.saveConnector}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
