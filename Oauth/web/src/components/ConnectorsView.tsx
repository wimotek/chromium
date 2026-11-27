import React, { useEffect, useRef, useState } from 'react';
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
  Copy,
  ExternalLink,
  Upload,
  Globe,
  BookOpen,
  FileCode2,
  SlidersHorizontal,
  ShieldCheck,
  Loader2,
  KeyRound,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { Locale, SocialConnector } from '../types';
import { TRANSLATIONS, moveConnectorByIndex } from '../lib/i18n';
import {
  CONNECTOR_TEMPLATES,
  buildConnectorConfigJson,
  buildConnectorEnvSnippet,
  getConnectorSetupGuide,
  parseConnectorAutoImport,
  validateAndBuildAuthPreview,
  type ConnectorTemplate,
  type OidcDiscoveryResult,
} from '../lib/connectorAutoConfig';
import { ProviderIcon } from './ProviderIcons';

interface ConnectorsViewProps {
  locale: Locale;
  issuerUrl: string;
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
    extra?: Record<string, string>;
  }) => Promise<void>;
  onDeleteConnector: (id: string) => Promise<void>;
  onReorderConnectors: (orderedIds: string[]) => Promise<void>;
  onDiscoverOidc: (issuerUrl: string) => Promise<OidcDiscoveryResult>;
  onAutoProvisionMicrosoft?: (payload: {
    graphAccessToken: string;
    displayName: string;
    signInAudience: string;
    tenantId?: string;
  }) => Promise<{ appId: string; tenantId: string; callbackUri: string }>;
  onUpdateIssuerUrl?: (nextIssuerUrl: string) => Promise<void>;
}

type EditorTab = 'config' | 'import' | 'guide';

export function ConnectorsView({
  locale,
  issuerUrl,
  connectors,
  onUpdateConnector,
  onAddCustomConnector,
  onDeleteConnector,
  onReorderConnectors,
  onDiscoverOidc,
  onAutoProvisionMicrosoft,
  onUpdateIssuerUrl,
}: ConnectorsViewProps) {
  const t = TRANSLATIONS[locale];
  const isZh = locale === 'zh-CN' || locale === 'zh-TW';
  const [selectedId, setSelectedId] = useState<string>(connectors[0]?.id || '');
  const selected = connectors.find((c) => c.id === selectedId) || connectors[0];

  const [editorTab, setEditorTab] = useState<EditorTab>('config');
  const [draftDisplayName, setDraftDisplayName] = useState(selected?.displayName || '');
  const [draftClientId, setDraftClientId] = useState(selected?.clientId || '');
  const [draftSecret, setDraftSecret] = useState('');
  const [draftExtra, setDraftExtra] = useState<Record<string, string>>(selected?.extra || {});
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [showAuthPreview, setShowAuthPreview] = useState(false);

  const [importText, setImportText] = useState('');
  const [importFeedback, setImportFeedback] = useState<{
    ok: boolean;
    summary: string;
    warnings: string[];
  } | null>(null);
  const [exportFormat, setExportFormat] = useState<'json' | 'env'>('json');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [confirmDeleteConn, setConfirmDeleteConn] = useState<SocialConnector | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{ text: string; isError?: boolean } | null>(null);

  // Microsoft Entra ID Graph API Auto-Registration state
  const [showMsAutoReg, setShowMsAutoReg] = useState(false);
  const [msAppName, setMsAppName] = useState('Wimotek OAuth SSO');
  const [msAudience, setMsAudience] = useState<'AzureADandPersonalMicrosoftAccount' | 'AzureADMyOrg'>(
    'AzureADandPersonalMicrosoftAccount'
  );
  const [msGraphToken, setMsGraphToken] = useState('');
  const [msProvisioning, setMsProvisioning] = useState(false);

  // Public Issuer URL / Reverse-Proxy HTTPS override state
  const [editingIssuer, setEditingIssuer] = useState(false);
  const [draftIssuerUrl, setDraftIssuerUrl] = useState(issuerUrl);
  const [savingIssuer, setSavingIssuer] = useState(false);

  useEffect(() => {
    setDraftIssuerUrl(issuerUrl);
  }, [issuerUrl]);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const [showAddCustom, setShowAddCustom] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('feishu');
  const [customName, setCustomName] = useState('Feishu / Lark');
  const [customIssuer, setCustomIssuer] = useState('https://open.feishu.cn/open-apis/authen/v1');
  const [customClientId, setCustomClientId] = useState('');
  const [customSecret, setCustomSecret] = useState('');
  const [customExtra, setCustomExtra] = useState<Record<string, string>>({
    ...CONNECTOR_TEMPLATES[0].extra,
  });
  const [discoveringCustom, setDiscoveringCustom] = useState(false);
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

  const enabledRankMap = new Map<string, number>();
  let enabledRank = 0;
  for (const conn of connectors) {
    if (conn.enabled) {
      enabledRank += 1;
      enabledRankMap.set(conn.id, enabledRank);
    }
  }

  function copyValue(key: string, value: string) {
    if (!value) return;
    void navigator.clipboard?.writeText(value);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1800);
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
    setImportFeedback(null);
    setShowAuthPreview(false);
  }

  function applyTemplate(tpl: ConnectorTemplate) {
    setSelectedTemplateId(tpl.id);
    setCustomName(isZh ? tpl.nameZh : tpl.name);
    setCustomIssuer(tpl.issuerUrl);
    setCustomExtra({ ...tpl.extra });
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
      setTimeout(() => setSavedNotice(false), 2400);
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '保存连接器失败' : 'Failed to save connector',
        isError: true,
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleMsAutoProvision() {
    if (!onAutoProvisionMicrosoft) return;
    const token = msGraphToken.trim();
    if (!token) {
      setActionNotice({
        text: isZh
          ? '请先粘贴已授权 Application.ReadWrite.All 的 Microsoft Graph Access Token。'
          : 'Please paste a Microsoft Graph Access Token with Application.ReadWrite.All scope.',
        isError: true,
      });
      return;
    }
    setMsProvisioning(true);
    setActionNotice(null);
    try {
      const result = await onAutoProvisionMicrosoft({
        graphAccessToken: token,
        displayName: msAppName.trim() || 'Wimotek OAuth SSO',
        signInAudience: msAudience,
        tenantId: draftExtra.tenant_id || 'common',
      });
      setDraftClientId(result.appId);
      setDraftSecret('');
      setDraftExtra((prev) => ({ ...prev, tenant_id: result.tenantId || prev.tenant_id || 'common' }));
      setMsGraphToken('');
      setShowMsAutoReg(false);
      setActionNotice({
        text: isZh
          ? `已在 Microsoft Entra ID 自动创建应用（Client ID: ${result.appId}），自动配置回调地址 ${result.callbackUri} 并加密保存 Client Secret，Microsoft 登录已自动启用。`
          : `Auto-registered Microsoft Entra ID app (${result.appId}) with callback ${result.callbackUri} and encrypted Client Secret saved.`,
      });
    } catch (err) {
      setActionNotice({
        text:
          err instanceof Error
            ? err.message
            : isZh
              ? 'Microsoft Graph 自动注册失败，请检查 Token 权限（需 Application.ReadWrite.All）及有效期。'
              : 'Microsoft Graph auto-registration failed. Check token scope (Application.ReadWrite.All) and expiration.',
        isError: true,
      });
    } finally {
      setMsProvisioning(false);
    }
  }

  async function handleDiscoverForSelected() {
    if (!selected) return;
    const rawIssuer =
      selected.provider === 'microsoft'
        ? `https://login.microsoftonline.com/${(draftExtra.tenant_id || 'common').trim() || 'common'}/v2.0`
        : (draftExtra.discovery_url || '').trim();

    if (!rawIssuer) {
      setActionNotice({
        text: isZh ? '请先输入 HTTPS Issuer URL 再执行自动发现。' : 'Enter an HTTPS Issuer URL before running Auto-Discover.',
        isError: true,
      });
      return;
    }

    setDiscovering(true);
    setActionNotice(null);
    try {
      const doc = await onDiscoverOidc(rawIssuer);
      setDraftExtra((prev) => ({
        ...prev,
        discovery_url: doc.issuer || rawIssuer,
        authorization_endpoint: doc.authorization_endpoint,
        token_endpoint: doc.token_endpoint,
        userinfo_endpoint: doc.userinfo_endpoint || prev.userinfo_endpoint || '',
        jwks_uri: doc.jwks_uri || prev.jwks_uri || '',
        scope:
          prev.scope ||
          (doc.scopes_supported?.includes('openid')
            ? ['openid', 'profile', 'email'].filter((s) => doc.scopes_supported?.includes(s)).join(' ') || 'openid'
            : 'openid profile email'),
      }));
      setActionNotice({
        text: isZh
          ? `已从 ${doc.issuer} 自动发现 OIDC 端点（Authorization / Token / UserInfo / JWKS），点击「保存连接器」即可生效。`
          : `Auto-discovered OIDC endpoints from ${doc.issuer}. Click Save Connector to apply.`,
      });
    } catch (err) {
      setActionNotice({
        text:
          err instanceof Error
            ? err.message
            : isZh
              ? '自动发现失败，请检查 Issuer URL 是否可公开访问 /.well-known/openid-configuration。'
              : 'OIDC discovery failed. Verify the issuer exposes /.well-known/openid-configuration over HTTPS.',
        isError: true,
      });
    } finally {
      setDiscovering(false);
    }
  }

  async function handleDiscoverForNewCustom() {
    if (!customIssuer.trim()) {
      setActionNotice({
        text: isZh ? '请先填写 Issuer URL。' : 'Please enter an Issuer URL first.',
        isError: true,
      });
      return;
    }
    setDiscoveringCustom(true);
    setActionNotice(null);
    try {
      const doc = await onDiscoverOidc(customIssuer.trim());
      setCustomIssuer(doc.issuer || customIssuer.trim());
      setCustomExtra((prev) => ({
        ...prev,
        authorization_endpoint: doc.authorization_endpoint,
        token_endpoint: doc.token_endpoint,
        userinfo_endpoint: doc.userinfo_endpoint || '',
        jwks_uri: doc.jwks_uri || '',
        scope:
          doc.scopes_supported?.includes('openid')
            ? ['openid', 'profile', 'email'].filter((s) => doc.scopes_supported?.includes(s)).join(' ') || 'openid'
            : prev.scope || 'openid profile email',
      }));
      setActionNotice({
        text: isZh
          ? `自动发现成功：已补齐 ${doc.issuer} 的全部 OIDC 端点。`
          : `Auto-discovered all OIDC endpoints for ${doc.issuer}.`,
      });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '自动发现失败' : 'OIDC discovery failed',
        isError: true,
      });
    } finally {
      setDiscoveringCustom(false);
    }
  }

  function applySmartImport(rawText: string, fileName = '') {
    if (!selected) return;
    const guide = getConnectorSetupGuide(selected.provider, issuerUrl, selected.id, isZh);
    const result = parseConnectorAutoImport(rawText, selected.provider, fileName, guide.callbackInfo.callbackUri);
    setImportFeedback({ ok: result.ok, summary: result.summary, warnings: result.warnings });
    if (!result.ok) return;

    if (result.clientId) setDraftClientId(result.clientId);
    if (result.clientSecret) setDraftSecret(result.clientSecret);
    if (result.displayName && selected.provider === 'custom_oidc') setDraftDisplayName(result.displayName);
    if (result.extra) {
      setDraftExtra((prev) => ({ ...prev, ...result.extra }));
    }
    setActionNotice({
      text: isZh
        ? `智能解析完成：${result.summary} 请核对后点击「保存连接器」。`
        : `${result.summary} Review the filled fields and click Save Connector.`,
    });
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    setImportText(text);
    applySmartImport(text, file.name);
    setEditorTab('config');
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
        extra: customExtra,
      });
      setActionNotice({
        text: isZh
          ? `已添加连接器「${customName.trim()}」，可复制其专属 Callback URI 填入第三方后台。`
          : `Added connector "${customName.trim()}". Copy its dedicated Callback URI into your provider console.`,
      });
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

  const setupGuide = selected ? getConnectorSetupGuide(selected.provider, issuerUrl, selected.id, isZh) : null;
  const validation = selected
    ? validateAndBuildAuthPreview({
        provider: selected.provider,
        connectorId: selected.id,
        clientId: draftClientId,
        hasSecret: selected.hasSecret,
        draftSecret,
        extra: draftExtra,
        issuerUrl,
        isZh,
      })
    : null;

  const exportSnippet = selected
    ? exportFormat === 'json'
      ? buildConnectorConfigJson(
          {
            ...selected,
            displayName: draftDisplayName || selected.displayName,
            clientId: draftClientId,
            extra: draftExtra,
          },
          issuerUrl
        )
      : buildConnectorEnvSnippet(
          {
            ...selected,
            displayName: draftDisplayName || selected.displayName,
            clientId: draftClientId,
            extra: draftExtra,
          },
          issuerUrl
        )
    : '';

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t.connectorsTitle}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 i18n-safe">
            {isZh
              ? '自动生成回调地址、内置 Logto 式分步向导、支持 Google JSON / Apple .p8 智能解析与 OIDC 自动发现。'
              : 'Auto-generated Callback URIs, step-by-step provider guides, Google JSON / Apple .p8 smart import, and one-click OIDC auto-discovery.'}
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
          <Plus className="w-4 h-4 shrink-0" />
          <span>{isZh ? '添加连接器模板' : 'Add Connector Template'}</span>
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={setupGuide?.acceptFileTypes || '.json,.p8,.pem,.env,.txt'}
        onChange={(e) => void handleFileUpload(e)}
        className="hidden"
      />

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
              className="px-3.5 py-2 rounded-lg border border-red-200 dark:border-red-800 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-red-100/50 whitespace-nowrap"
            >
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button
              type="button"
              disabled={deletingId === confirmDeleteConn.id}
              onClick={() => void handleConfirmDelete()}
              className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-medium flex items-center gap-1.5 whitespace-nowrap"
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
          className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                {isZh ? '从预设模板快速创建连接器（支持 OIDC 自动发现）' : 'Add Connector from Template (with OIDC Auto-Discovery)'}
              </h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {isZh
                  ? '选择一个预设模板自动填入授权/令牌端点与默认 Scope，或输入任意标准 OIDC Issuer URL 一键自动发现。'
                  : 'Select a preset template to pre-fill OAuth2/OIDC endpoints and scopes, or enter any standard OIDC Issuer URL to auto-discover.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAddCustom(false)}
              aria-label="Close template selector"
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {CONNECTOR_TEMPLATES.map((tpl) => {
              const active = selectedTemplateId === tpl.id;
              return (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => applyTemplate(tpl)}
                  className={`text-left p-3.5 rounded-lg border transition-colors ${
                    active
                      ? 'border-indigo-500 bg-indigo-50/70 dark:bg-indigo-950/35'
                      : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 bg-slate-50/50 dark:bg-slate-900/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                      {isZh ? tpl.nameZh : tpl.name}
                    </span>
                    <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 shrink-0">
                      {tpl.supportsDiscovery ? 'OIDC' : 'OAuth2'}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2">
                    {isZh ? tpl.taglineZh : tpl.tagline}
                  </p>
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
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
                placeholder="e.g. Feishu / Slack / Okta"
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label htmlFor="custom-conn-issuer" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Discovery / Issuer URL
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="custom-conn-issuer"
                  type="url"
                  value={customIssuer}
                  onChange={(e) => setCustomIssuer(e.target.value)}
                  placeholder="https://gitlab.com"
                  className="flex-1 min-w-0 min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                />
                <button
                  type="button"
                  disabled={discoveringCustom}
                  onClick={() => void handleDiscoverForNewCustom()}
                  className="min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-60"
                >
                  {discoveringCustom ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Globe className="w-3.5 h-3.5" />}
                  <span>{isZh ? '自动发现' : 'Discover'}</span>
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="custom-conn-cid" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Client ID / App ID
              </label>
              <input
                id="custom-conn-cid"
                type="text"
                value={customClientId}
                onChange={(e) => setCustomClientId(e.target.value)}
                placeholder={isZh ? '可先留空，创建后再导入凭据' : 'Optional now — fill or auto-import after creation'}
                className="w-full min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label htmlFor="custom-conn-sec" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Client Secret (AES-256-GCM)
              </label>
              <input
                id="custom-conn-sec"
                type="password"
                value={customSecret}
                onChange={(e) => setCustomSecret(e.target.value)}
                placeholder="••••••••••••"
                className="w-full min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          {customExtra.authorization_endpoint && (
            <div className="text-xs text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-lg px-3.5 py-2.5 space-y-1 font-mono">
              <div className="truncate">authorize: {customExtra.authorization_endpoint}</div>
              {customExtra.token_endpoint && <div className="truncate">token: {customExtra.token_endpoint}</div>}
              {customExtra.scope && <div className="truncate">scope: {customExtra.scope}</div>}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAddCustom(false)}
              className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300"
            >
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={addingCustom}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white whitespace-nowrap"
            >
              {addingCustom ? '...' : isZh ? '创建连接器' : 'Create Connector'}
            </button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-4 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl divide-y divide-slate-100 dark:divide-slate-800 overflow-hidden">
          <div className="px-4 py-3 bg-slate-50/80 dark:bg-slate-900/50 flex items-center justify-between gap-2 text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {isZh ? '拖动调整展示顺序' : 'Drag to reorder'}
            </span>
            <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
              {isZh ? '前 3 置顶 · 其余折叠' : 'Top 3 · rest folded'}
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

        {selected && setupGuide && validation && (
          <div className="lg:col-span-8 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-3 min-w-0">
                <ProviderIcon provider={selected.provider} className="w-5 h-5 shrink-0" />
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-slate-900 dark:text-white truncate">
                    {selected.displayName}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5 flex-wrap">
                    <code className="font-mono">{selected.provider}</code>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1">
                      <Lock className="w-3 h-3" />
                      AES-256-GCM
                    </span>
                    <span aria-hidden="true">·</span>
                    <span
                      className={
                        validation.ready
                          ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                          : 'text-amber-600 dark:text-amber-400 font-medium'
                      }
                    >
                      {validation.ready
                        ? isZh
                          ? '生产凭据已就绪'
                          : 'Ready for live sign-in'
                        : validation.isDemoPlaceholder
                          ? isZh
                            ? '当前为示例占位凭据'
                            : 'Demo placeholder credentials'
                          : isZh
                            ? '待补全必填项'
                            : 'Missing required fields'}
                    </span>
                  </p>
                </div>
              </div>

              <a
                href={setupGuide.consoleUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
              >
                <span>{isZh ? '打开开发者后台' : 'Open Provider Console'}</span>
                <ExternalLink className="w-3.5 h-3.5 shrink-0" />
              </a>
            </div>

            {(() => {
              const cbUri = setupGuide.callbackInfo.callbackUri;
              const isNonLocalHttp = (() => {
                try {
                  const u = new URL(cbUri);
                  const h = u.hostname.toLowerCase();
                  return (
                    u.protocol === 'http:' &&
                    h !== 'localhost' &&
                    h !== '127.0.0.1' &&
                    h !== '::1' &&
                    !h.endsWith('.localhost')
                  );
                } catch {
                  return false;
                }
              })();
              const suggestedHttpsIssuer = issuerUrl.replace(/^http:\/\//i, 'https://').replace(/\/$/, '');

              async function submitIssuerUrl(nextUrl: string) {
                if (!onUpdateIssuerUrl) return;
                setSavingIssuer(true);
                setActionNotice(null);
                try {
                  await onUpdateIssuerUrl(nextUrl.trim());
                  setEditingIssuer(false);
                  setActionNotice({
                    text: isZh
                      ? `公开域名已更新为 ${nextUrl.trim()}，所有连接器 Callback URI 已同步生效。`
                      : `Public Issuer URL updated to ${nextUrl.trim()}. All Callback URIs updated.`,
                  });
                } catch (err) {
                  setActionNotice({
                    text: err instanceof Error ? err.message : 'Failed to update Issuer URL',
                    isError: true,
                  });
                } finally {
                  setSavingIssuer(false);
                }
              }

              return (
                <div className="bg-slate-50/90 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-lg p-3.5 space-y-2.5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        {isZh ? '自动生成的 Callback URI（复制到第三方应用回调白名单）' : 'Auto-Generated Callback URI (paste into provider console)'}
                      </div>
                      <div className="mt-1 text-xs font-mono text-indigo-700 dark:text-indigo-300 break-all">
                        {cbUri}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {onUpdateIssuerUrl && (
                        <button
                          type="button"
                          onClick={() => setEditingIssuer((v) => !v)}
                          className="min-h-[34px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium text-slate-600 dark:text-slate-300 inline-flex items-center gap-1 whitespace-nowrap"
                        >
                          <Globe className="w-3.5 h-3.5" />
                          <span>{isZh ? '修改域名' : 'Edit Domain'}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => copyValue('callback_uri', cbUri)}
                        className="min-h-[34px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap"
                      >
                        {copiedKey === 'callback_uri' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copiedKey === 'callback_uri' ? (isZh ? '已复制' : 'Copied') : isZh ? '复制 URI' : 'Copy URI'}</span>
                      </button>
                    </div>
                  </div>

                  {isNonLocalHttp && (
                    <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/70 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs">
                      <div className="flex items-start gap-2 text-amber-900 dark:text-amber-200">
                        <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                        <div className="space-y-0.5 leading-relaxed">
                          <div className="font-semibold">
                            {isZh
                              ? '检测到回调地址为 HTTP（常见于反向代理到 8080 端口）'
                              : 'HTTP Callback URI detected on public domain (reverse proxy)'}
                          </div>
                          <p className="text-[11px] text-amber-800/90 dark:text-amber-300/90">
                            {isZh
                              ? 'Microsoft Entra ID / Google / Apple 强制非本地域名使用 HTTPS（否则报 AADSTS50011）。请点击右侧按钮一键切换为 HTTPS，并建议在反代中透传 X-Forwarded-Proto: https。'
                              : 'Microsoft Entra ID / Google / Apple require HTTPS for non-localhost domains (otherwise AADSTS50011). Switch Issuer URL to HTTPS below and forward X-Forwarded-Proto: https in your reverse proxy.'}
                          </p>
                        </div>
                      </div>
                      {onUpdateIssuerUrl && (
                        <button
                          type="button"
                          disabled={savingIssuer}
                          onClick={() => void submitIssuerUrl(suggestedHttpsIssuer)}
                          className="min-h-[34px] px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-xs font-medium whitespace-nowrap shrink-0 transition-colors"
                        >
                          {savingIssuer
                            ? isZh
                              ? '切换中...'
                              : 'Switching...'
                            : isZh
                              ? '一键切换为 HTTPS'
                              : 'Switch to HTTPS'}
                        </button>
                      )}
                    </div>
                  )}

                  {editingIssuer && onUpdateIssuerUrl && (
                    <div className="pt-2 border-t border-slate-200/80 dark:border-slate-800 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                      <input
                        type="url"
                        value={draftIssuerUrl}
                        onChange={(e) => setDraftIssuerUrl(e.target.value)}
                        placeholder="https://ca.wimotek.com"
                        className="flex-1 min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#111827] text-xs font-mono text-slate-900 dark:text-slate-100"
                      />
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          disabled={savingIssuer || !draftIssuerUrl.trim()}
                          onClick={() => void submitIssuerUrl(draftIssuerUrl)}
                          className="min-h-[36px] px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-medium"
                        >
                          {savingIssuer ? (isZh ? '保存中...' : 'Saving...') : isZh ? '保存公开域名' : 'Save Issuer URL'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDraftIssuerUrl(issuerUrl);
                            setEditingIssuer(false);
                          }}
                          className="min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300"
                        >
                          {isZh ? '取消' : 'Cancel'}
                        </button>
                      </div>
                    </div>
                  )}

                  {(selected.provider === 'wechat' || selected.provider === 'apple') && (
                    <div className="pt-2 border-t border-slate-200/80 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="text-xs text-slate-600 dark:text-slate-400">
                        <span>{selected.provider === 'wechat' ? (isZh ? '微信授权回调域（纯域名）：' : 'WeChat Callback Domain: ') : isZh ? 'Apple Domains & Subdomains：' : 'Apple Domain: '}</span>
                        <code className="font-mono text-slate-900 dark:text-slate-200">{setupGuide.callbackInfo.callbackDomain}</code>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyValue('callback_domain', setupGuide.callbackInfo.callbackDomain)}
                        className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                      >
                        {copiedKey === 'callback_domain' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copiedKey === 'callback_domain' ? (isZh ? '已复制域名' : 'Copied Domain') : isZh ? '复制域名' : 'Copy Domain'}</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg border border-slate-200/70 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditorTab('config')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md inline-flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                    editorTab === 'config'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span>{isZh ? '参数配置' : 'Configuration'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setEditorTab('import')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md inline-flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                    editorTab === 'import'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <FileCode2 className="w-3.5 h-3.5" />
                  <span>{isZh ? '智能导入 / JSON' : 'Smart Import / JSON'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setEditorTab('guide')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md inline-flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                    editorTab === 'guide'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  <span>{isZh ? '配置向导' : 'Setup Guide'}</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="min-h-[34px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>
                  {selected.provider === 'apple'
                    ? isZh
                      ? '上传 .p8 自动识别'
                      : 'Upload .p8 Key'
                    : selected.provider === 'google'
                      ? isZh
                        ? '导入 Google JSON'
                        : 'Import Google JSON'
                      : isZh
                        ? '上传 JSON / .env'
                        : 'Upload JSON / .env'}
                </span>
              </button>
            </div>

            {editorTab === 'config' && (
              <form onSubmit={handleSave} className="space-y-4">
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
                      <div className="flex items-center gap-2">
                        <input
                          id="conn-discovery-url"
                          type="url"
                          value={draftExtra.discovery_url || ''}
                          onChange={(e) => setDraftExtra((prev) => ({ ...prev, discovery_url: e.target.value }))}
                          placeholder="https://gitlab.com"
                          className="flex-1 min-w-0 min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                        />
                        <button
                          type="button"
                          disabled={discovering}
                          onClick={() => void handleDiscoverForSelected()}
                          className="min-h-[40px] px-3.5 py-2 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/40 hover:bg-indigo-100 dark:hover:bg-indigo-950/70 text-xs font-medium text-indigo-700 dark:text-indigo-300 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-60"
                        >
                          {discovering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Globe className="w-3.5 h-3.5" />}
                          <span>{isZh ? '自动发现 OIDC' : 'Auto-Discover'}</span>
                        </button>
                      </div>
                    </div>

                    {(draftExtra.authorization_endpoint || draftExtra.token_endpoint || draftExtra.jwks_uri) && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3.5 rounded-lg bg-slate-50/80 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-800 text-xs">
                        <div>
                          <label htmlFor="conn-auth-ep" className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                            Authorization Endpoint
                          </label>
                          <input
                            id="conn-auth-ep"
                            type="url"
                            value={draftExtra.authorization_endpoint || ''}
                            onChange={(e) => setDraftExtra((prev) => ({ ...prev, authorization_endpoint: e.target.value }))}
                            className="w-full px-2.5 py-1.5 text-xs font-mono rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                          />
                        </div>
                        <div>
                          <label htmlFor="conn-token-ep" className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                            Token Endpoint
                          </label>
                          <input
                            id="conn-token-ep"
                            type="url"
                            value={draftExtra.token_endpoint || ''}
                            onChange={(e) => setDraftExtra((prev) => ({ ...prev, token_endpoint: e.target.value }))}
                            className="w-full px-2.5 py-1.5 text-xs font-mono rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                          />
                        </div>
                        <div>
                          <label htmlFor="conn-userinfo-ep" className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                            UserInfo Endpoint
                          </label>
                          <input
                            id="conn-userinfo-ep"
                            type="url"
                            value={draftExtra.userinfo_endpoint || ''}
                            onChange={(e) => setDraftExtra((prev) => ({ ...prev, userinfo_endpoint: e.target.value }))}
                            className="w-full px-2.5 py-1.5 text-xs font-mono rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                          />
                        </div>
                        <div>
                          <label htmlFor="conn-jwks-uri" className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                            JWKS URI
                          </label>
                          <input
                            id="conn-jwks-uri"
                            type="url"
                            value={draftExtra.jwks_uri || ''}
                            onChange={(e) => setDraftExtra((prev) => ({ ...prev, jwks_uri: e.target.value }))}
                            className="w-full px-2.5 py-1.5 text-xs font-mono rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                          />
                        </div>
                      </div>
                    )}
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
                      placeholder={selected.hasSecret ? `Stored encrypted (${selected.secretMasked}) — upload or paste new .p8 to rotate` : '-----BEGIN PRIVATE KEY-----'}
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

                {selected.provider === 'microsoft' && (
                  <div className="space-y-4">
                    <div>
                      <label htmlFor="ms-tenant" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                        Entra ID Tenant (common / organizations / tenant-uuid)
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          id="ms-tenant"
                          type="text"
                          value={draftExtra.tenant_id || 'common'}
                          onChange={(e) => setDraftExtra((prev) => ({ ...prev, tenant_id: e.target.value }))}
                          className="flex-1 min-w-0 min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                        />
                        <button
                          type="button"
                          disabled={discovering}
                          onClick={() => void handleDiscoverForSelected()}
                          className="min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-60"
                        >
                          {discovering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Globe className="w-3.5 h-3.5" />}
                          <span>{isZh ? '验证租户 OIDC' : 'Verify Tenant'}</span>
                        </button>
                      </div>
                    </div>

                    {/* One-Click Authorized Auto-Registration via Microsoft Graph API */}
                    {onAutoProvisionMicrosoft && (
                      <div className="rounded-xl border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/40 dark:bg-indigo-950/20 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setShowMsAutoReg((v) => !v)}
                          className="w-full px-4 py-3 flex items-center justify-between gap-2 text-left text-xs font-semibold text-indigo-900 dark:text-indigo-200 hover:bg-indigo-50/70 dark:hover:bg-indigo-950/40 transition-colors"
                        >
                          <span className="inline-flex items-center gap-2">
                            <KeyRound className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                            <span>
                              {isZh
                                ? '一键授权自动注册 Entra ID 并回填 Client ID & Secret (Microsoft Graph)'
                                : 'Auto-Register Entra ID App & Auto-Fill Credentials (Microsoft Graph)'}
                            </span>
                          </span>
                          {showMsAutoReg ? (
                            <ChevronDown className="w-4 h-4 shrink-0" />
                          ) : (
                            <ChevronRight className="w-4 h-4 shrink-0" />
                          )}
                        </button>

                        {showMsAutoReg && (
                          <div className="px-4 pb-4 pt-2 border-t border-indigo-200/70 dark:border-indigo-900/50 space-y-3 text-xs">
                            <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                              {isZh
                                ? '提供临时 Microsoft Graph 授权令牌（含 Application.ReadWrite.All 权限），后端将自动在你的 Entra ID 租户注册应用、配置本服务的 Callback URI、签发 Client Secret 并加密回填（令牌仅用于本次调用，不会落盘保存）。'
                                : 'Provide a short-lived Microsoft Graph token with Application.ReadWrite.All. The backend creates the Entra ID app, sets your Callback URI, generates a Client Secret, and encrypts it automatically (token is never stored).'}
                            </p>

                            <div className="p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-2">
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <span className="text-[11px] font-medium text-slate-700 dark:text-slate-300">
                                  {isZh ? '方式 A：Azure CLI 一行获取令牌' : 'Option A: Get token via Azure CLI'}
                                </span>
                                <a
                                  href="https://developer.microsoft.com/en-us/graph/graph-explorer"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1"
                                >
                                  <span>{isZh ? '方式 B：打开 Graph Explorer 获取' : 'Option B: Graph Explorer'}</span>
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              </div>
                              <div className="flex items-center justify-between gap-2 bg-slate-950 text-slate-200 px-2.5 py-1.5 rounded font-mono text-[11px]">
                                <code className="truncate">
                                  az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv
                                </code>
                                <button
                                  type="button"
                                  onClick={() =>
                                    copyValue(
                                      'az_cli',
                                      'az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv'
                                    )
                                  }
                                  className="text-indigo-400 hover:text-indigo-300 shrink-0 inline-flex items-center gap-1"
                                >
                                  {copiedKey === 'az_cli' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                </button>
                              </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div>
                                <label htmlFor="ms-auto-name" className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
                                  {isZh ? '注册应用名称' : 'Entra ID App Name'}
                                </label>
                                <input
                                  id="ms-auto-name"
                                  type="text"
                                  value={msAppName}
                                  onChange={(e) => setMsAppName(e.target.value)}
                                  className="w-full min-h-[36px] px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                                />
                              </div>
                              <div>
                                <label htmlFor="ms-auto-audience" className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
                                  {isZh ? '允许登录的账号类型' : 'Supported Account Types'}
                                </label>
                                <select
                                  id="ms-auto-audience"
                                  value={msAudience}
                                  onChange={(e) =>
                                    setMsAudience(
                                      e.target.value as 'AzureADandPersonalMicrosoftAccount' | 'AzureADMyOrg'
                                    )
                                  }
                                  className="w-full min-h-[36px] px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                                >
                                  <option value="AzureADandPersonalMicrosoftAccount">
                                    {isZh ? '多租户组织账号 + 个人微软账号 (common)' : 'Any Org + Personal Microsoft (common)'}
                                  </option>
                                  <option value="AzureADMyOrg">
                                    {isZh ? '仅限本企业组织目录 (Single Tenant)' : 'Single Tenant Org Only'}
                                  </option>
                                </select>
                              </div>
                            </div>

                            <div>
                              <label htmlFor="ms-graph-token" className="block text-[11px] font-medium text-slate-700 dark:text-slate-300 mb-1">
                                Microsoft Graph Access Token (Application.ReadWrite.All)
                              </label>
                              <input
                                id="ms-graph-token"
                                type="password"
                                value={msGraphToken}
                                onChange={(e) => setMsGraphToken(e.target.value)}
                                placeholder="eyJ0eXAiOiJKV1QiLCJhbGci..."
                                className="w-full min-h-[36px] px-2.5 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                              />
                            </div>

                            <div className="flex justify-end">
                              <button
                                type="button"
                                disabled={msProvisioning || !msGraphToken.trim()}
                                onClick={() => void handleMsAutoProvision()}
                                className="min-h-[36px] px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
                              >
                                {msProvisioning ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <KeyRound className="w-3.5 h-3.5" />
                                )}
                                <span>
                                  {msProvisioning
                                    ? isZh
                                      ? '正在调用 Microsoft Graph 注册...'
                                      : 'Registering via Microsoft Graph...'
                                    : isZh
                                      ? '立即自动注册并回填 Client ID & Secret'
                                      : 'Auto-Register & Auto-Fill Credentials'}
                                </span>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {selected.provider === 'github' && (
                  <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                    <div className="space-y-0.5">
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {isZh ? '一键带参创建 GitHub OAuth App' : '1-Click Pre-Filled GitHub OAuth App'}
                      </div>
                      <p className="text-slate-500 dark:text-slate-400">
                        {isZh
                          ? '点击按钮将直接打开 GitHub 注册页并自动填好应用名称、主页和本服务的 Callback URI。'
                          : 'Opens GitHub Developer Settings with App Name, Homepage URL, and Callback URI pre-filled.'}
                      </p>
                    </div>
                    <a
                      href={`https://github.com/settings/applications/new?oauth_application[name]=${encodeURIComponent(
                        'Wimotek OAuth SSO'
                      )}&oauth_application[url]=${encodeURIComponent(
                        issuerUrl
                      )}&oauth_application[callback_url]=${encodeURIComponent(setupGuide.callbackInfo.callbackUri)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-h-[36px] px-3.5 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                    >
                      <span>{isZh ? '带参前往 GitHub 创建' : 'Create Pre-Filled on GitHub'}</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
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
                        className="w-full min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
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
                        className="w-full min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
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
                      className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                    >
                      <option value="qr">微信开放平台扫码登录 (qrconnect / snsapi_login)</option>
                      <option value="mp">微信公众号网页授权 (oauth2 / snsapi_userinfo)</option>
                    </select>
                  </div>
                )}

                {showAuthPreview && (
                  <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 space-y-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900 dark:text-white">
                        {isZh ? '配置体检与授权跳转 URL 预览' : 'Configuration Health Check & Authorize URL Preview'}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyValue('auth_url', validation.authUrlPreview)}
                        className="text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1 whitespace-nowrap"
                      >
                        {copiedKey === 'auth_url' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copiedKey === 'auth_url' ? (isZh ? '已复制' : 'Copied') : isZh ? '复制 URL' : 'Copy URL'}</span>
                      </button>
                    </div>

                    {validation.issues.length > 0 && (
                      <ul className="space-y-1 text-amber-700 dark:text-amber-300">
                        {validation.issues.map((issue) => (
                          <li key={issue} className="flex items-start gap-1.5">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <span>{issue}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {validation.issues.length === 0 && validation.isDemoPlaceholder && (
                      <div className="text-amber-700 dark:text-amber-300">
                        {isZh
                          ? '字段格式完整，但当前仍为内置演示占位凭据；替换为真实应用的 Client ID 与 Secret 后即可用于生产登录。'
                          : 'Field structure is valid, but demo placeholder credentials are still active. Replace with real provider credentials for production sign-in.'}
                      </div>
                    )}

                    <div className="p-2.5 rounded-md bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono text-[11px] text-slate-700 dark:text-slate-300 break-all">
                      {validation.authUrlPreview}
                    </div>
                  </div>
                )}

                <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setShowAuthPreview((v) => !v)}
                      className="min-h-[38px] px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>{showAuthPreview ? (isZh ? '收起验证' : 'Hide Check') : isZh ? '验证配置 & 预览 URL' : 'Verify & Preview URL'}</span>
                    </button>

                    {selected.provider === 'custom_oidc' && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowAddCustom(false);
                          setConfirmDeleteConn(selected);
                        }}
                        className="min-h-[38px] px-3 py-2 rounded-lg border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>{isZh ? '删除' : 'Delete'}</span>
                      </button>
                    )}

                    {savedNotice && (
                      <div className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                        <Check className="w-4 h-4" />
                        <span>{isZh ? '已保存并即时生效' : 'Saved & active immediately'}</span>
                      </div>
                    )}
                  </div>

                  <button
                    type="submit"
                    disabled={saving}
                    className="min-h-[40px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition-colors disabled:opacity-60 whitespace-nowrap"
                  >
                    {saving ? '...' : t.saveConnector}
                  </button>
                </div>
              </form>
            )}

            {editorTab === 'import' && (
              <div className="space-y-5">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <label htmlFor="smart-import-area" className="text-xs font-semibold text-slate-900 dark:text-white">
                      {isZh ? '智能自动解析（支持 Google JSON / Apple .p8 / Logto JSON / .env）' : 'Smart Auto-Fill (Google JSON / Apple .p8 / Logto JSON / .env)'}
                    </label>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      <span>{isZh ? '从本地文件导入' : 'Choose Local File'}</span>
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    {setupGuide.uploadHint}
                  </p>
                  <textarea
                    id="smart-import-area"
                    rows={6}
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder={
                      selected.provider === 'google'
                        ? '{"web":{"client_id":"...apps.googleusercontent.com","client_secret":"GOCSPX-...","redirect_uris":["..."]}}'
                        : selected.provider === 'apple'
                          ? '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'
                          : '{\n  "clientId": "...",\n  "clientSecret": "...",\n  "scope": "openid profile email"\n}'
                    }
                    className="w-full px-3 py-2.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                  />

                  {importFeedback && (
                    <div
                      className={`p-3 rounded-lg border text-xs space-y-1.5 ${
                        importFeedback.ok
                          ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/60 text-emerald-800 dark:text-emerald-300'
                          : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/60 text-red-800 dark:text-red-300'
                      }`}
                    >
                      <div className="font-medium">{importFeedback.summary}</div>
                      {importFeedback.warnings.map((w) => (
                        <div key={w} className="text-amber-700 dark:text-amber-300">
                          {w}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setImportText('');
                        setImportFeedback(null);
                      }}
                      className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-300"
                    >
                      {isZh ? '清空' : 'Clear'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        applySmartImport(importText);
                        setEditorTab('config');
                      }}
                      className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium whitespace-nowrap"
                    >
                      {isZh ? '解析并自动填充表单' : 'Parse & Auto-Fill Form'}
                    </button>
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-2.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="text-xs font-semibold text-slate-900 dark:text-white">
                      {isZh ? '导出自动化配置模板（用于 GitOps / Docker 部署）' : 'Export Reproducible Config Template (GitOps / Docker)'}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="inline-flex items-center gap-1 p-0.5 bg-slate-100 dark:bg-slate-900 rounded-md">
                        <button
                          type="button"
                          onClick={() => setExportFormat('json')}
                          className={`px-2 py-1 text-[11px] font-medium rounded ${
                            exportFormat === 'json'
                              ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                              : 'text-slate-500'
                          }`}
                        >
                          JSON
                        </button>
                        <button
                          type="button"
                          onClick={() => setExportFormat('env')}
                          className={`px-2 py-1 text-[11px] font-medium rounded ${
                            exportFormat === 'env'
                              ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                              : 'text-slate-500'
                          }`}
                        >
                          .env
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyValue('export_snippet', exportSnippet)}
                        className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1 whitespace-nowrap"
                      >
                        {copiedKey === 'export_snippet' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copiedKey === 'export_snippet' ? (isZh ? '已复制' : 'Copied') : isZh ? '复制' : 'Copy'}</span>
                      </button>
                    </div>
                  </div>
                  <pre className="p-3.5 rounded-lg bg-slate-950 text-slate-200 text-xs font-mono overflow-x-auto leading-relaxed">
                    {exportSnippet}
                  </pre>
                </div>
              </div>
            )}

            {editorTab === 'guide' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                      {isZh ? `${selected.displayName} 快速接入指南` : `${selected.displayName} Step-by-Step Setup Guide`}
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {isZh ? '默认请求 Scope：' : 'Default Scopes: '}
                      <code className="font-mono text-slate-700 dark:text-slate-300">{setupGuide.defaultScopes}</code>
                    </p>
                  </div>
                  <a
                    href={setupGuide.consoleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1"
                  >
                    <span>{setupGuide.consoleName}</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>

                <ol className="divide-y divide-slate-100 dark:divide-slate-800 border-t border-slate-100 dark:border-slate-800">
                  {setupGuide.steps.map((step, i) => (
                    <li key={step.title} className="py-3.5 space-y-2">
                      <div className="text-xs font-semibold text-slate-900 dark:text-white">
                        {`0${i + 1}. ${step.title}`}
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">{step.detail}</p>
                      {step.copyValue && (
                        <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800">
                          <div className="min-w-0">
                            <span className="text-[11px] text-slate-500 dark:text-slate-400 mr-2">{step.copyLabel}:</span>
                            <code className="text-xs font-mono text-indigo-700 dark:text-indigo-300 break-all">
                              {step.copyValue}
                            </code>
                          </div>
                          <button
                            type="button"
                            onClick={() => copyValue(`step_${i}`, step.copyValue || '')}
                            className="text-xs font-medium text-slate-700 dark:text-slate-200 hover:text-indigo-600 inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                          >
                            {copiedKey === `step_${i}` ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                            <span>{copiedKey === `step_${i}` ? (isZh ? '已复制' : 'Copied') : isZh ? '复制' : 'Copy'}</span>
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>

                <div className="pt-2 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditorTab('import')}
                    className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    {isZh ? '前往智能导入' : 'Go to Smart Import'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditorTab('config')}
                    className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium"
                  >
                    {isZh ? '返回填写凭据' : 'Back to Configuration'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
