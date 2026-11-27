import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Monitor,
  Smartphone,
  ArrowLeftRight,
  CheckCircle2,
  ShieldCheck,
  Palette,
  Sparkles,
  Activity,
  Save,
  RotateCcw,
  Copy,
  Check,
  Globe,
  KeyRound,
  Cpu,
  Upload,
  Download,
  FileJson,
  X,
  AlertCircle,
} from 'lucide-react';
import type {
  AuthPolicyConfig,
  Locale,
  LoginThemeConfig,
  LoginThemeFont,
  LoginThemeLayout,
  LoginThemeRadius,
  LoginThemeSurface,
  OAuthApplication,
  OidcFlowTrace,
  SocialConnector,
} from '../types';
import { TRANSLATIONS } from '../lib/i18n';
import {
  DEFAULT_LOGIN_THEME,
  LOGIN_THEME_PRESETS,
  buildAiIntegrationPrompt,
  buildAiThemeSyncPrompt,
  getIssuerMismatchInfo,
  isNonLocalHttpUrl,
  normalizeLoginTheme,
  parseImportedLoginThemeJson,
  resolveEffectiveIssuerUrl,
  type AiLoginEntryMode,
} from '../lib/loginTheme';
import { HostedLoginCard } from './HostedLoginCard';
import { AdminTokenManagerModal, buildMcpClientConfigJson } from './AdminApiTokensSection';

type LabRightTab = 'theme' | 'ai_api' | 'trace';

interface LoginLabViewProps {
  locale: Locale;
  issuerUrl: string;
  rawServerIssuerUrl?: string;
  issuerLocked?: boolean;
  sessionToken?: string;
  connectors: SocialConnector[];
  applications: OAuthApplication[];
  authPolicy?: AuthPolicyConfig;
  selectedClientId: string;
  onSelectClientId: (clientId: string) => void;
  onSaveTheme: (clientId: string, theme: LoginThemeConfig) => Promise<void>;
  onUpdateIssuerUrl?: (nextIssuerUrl: string, autoDetect?: boolean) => Promise<void>;
  onPasswordSignIn: (email: string, password: string) => Promise<void>;
  onSocialSignIn: (provider: string) => Promise<void>;
  onAuthCompleted?: (result: { user: any; sessionToken: string; trace: OidcFlowTrace }) => void;
  latestTrace: OidcFlowTrace | null;
}

export function LoginLabView({
  locale,
  issuerUrl,
  rawServerIssuerUrl,
  issuerLocked,
  sessionToken = '',
  connectors,
  applications,
  authPolicy,
  selectedClientId,
  onSelectClientId,
  onSaveTheme,
  onUpdateIssuerUrl,
  onPasswordSignIn,
  onSocialSignIn,
  onAuthCompleted,
  latestTrace,
}: LoginLabViewProps) {
  const t = TRANSLATIONS[locale];
  const isZh = locale === 'zh-CN' || locale === 'zh-TW';
  const canvasUid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const canvasScope = `wm-canvas-${canvasUid}`;

  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [rtl, setRtl] = useState(false);
  const [rightTab, setRightTab] = useState<LabRightTab>('theme');

  const selectedApp = useMemo(
    () => applications.find((a) => a.clientId === selectedClientId) || applications[0],
    [applications, selectedClientId]
  );

  const [draftTheme, setDraftTheme] = useState<LoginThemeConfig>(() =>
    normalizeLoginTheme(selectedApp?.loginTheme || DEFAULT_LOGIN_THEME)
  );
  const [savingTheme, setSavingTheme] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [tokenModalOpen, setTokenModalOpen] = useState(false);
  const [mintedTokenInMem, setMintedTokenInMem] = useState<string | null>(null);
  const [fillMintedToken, setFillMintedToken] = useState(true);
  const [jsonModalOpen, setJsonModalOpen] = useState(false);
  const [jsonInputText, setJsonInputText] = useState('');
  const [jsonImportError, setJsonImportError] = useState<string | null>(null);
  const [importingSave, setImportingSave] = useState(false);
  const [loginEntryMode, setLoginEntryMode] = useState<AiLoginEntryMode>('direct_redirect');
  const [editingIssuer, setEditingIssuer] = useState(false);
  const [draftIssuerUrl, setDraftIssuerUrl] = useState('');
  const [savingIssuer, setSavingIssuer] = useState(false);
  const [issuerNotice, setIssuerNotice] = useState<{ text: string; isError?: boolean } | null>(null);
  const jsonFileInputRef = useRef<HTMLInputElement | null>(null);

  const prevClientIdRef = useRef<string | undefined>(selectedApp?.clientId);
  useEffect(() => {
    setDraftTheme(normalizeLoginTheme(selectedApp?.loginTheme || DEFAULT_LOGIN_THEME));
    if (prevClientIdRef.current !== selectedApp?.clientId) {
      prevClientIdRef.current = selectedApp?.clientId;
      setSaveNotice(null);
      setSaveError(null);
    }
  }, [selectedApp?.clientId, selectedApp?.loginTheme]);

  const activeClientId = selectedApp?.clientId || selectedClientId || 'wimotek_erp_portal';
  const activeAppName = selectedApp?.name || 'wimotek/Oauth';
  const activeRedirectUri = selectedApp?.redirectUris?.[0] || 'https://app.example.com/auth/callback';
  const cleanIssuer = resolveEffectiveIssuerUrl(issuerUrl);
  const issuerMismatch = getIssuerMismatchInfo(rawServerIssuerUrl || issuerUrl);
  const effectiveIsNonLocalHttp = isNonLocalHttpUrl(cleanIssuer);
  const serverNeedsHttpsSync = Boolean(
    !issuerMismatch.hostMismatch &&
      rawServerIssuerUrl &&
      isNonLocalHttpUrl(rawServerIssuerUrl) &&
      cleanIssuer.startsWith('https://')
  );
  const suggestedHttpsIssuer =
    issuerMismatch.recommendedIssuer || cleanIssuer.replace(/^http:\/\//i, 'https://').replace(/\/+$/, '');

  useEffect(() => {
    setDraftIssuerUrl(cleanIssuer);
  }, [cleanIssuer]);

  async function handleSubmitIssuerUrl(nextUrl: string, autoDetect = false) {
    if (!onUpdateIssuerUrl) return;
    const trimmed = nextUrl.trim().replace(/\/+$/, '');
    if (!autoDetect && !trimmed) return;
    setSavingIssuer(true);
    setIssuerNotice(null);
    try {
      await onUpdateIssuerUrl(trimmed, autoDetect);
      setEditingIssuer(false);
      setIssuerNotice({
        text: autoDetect
          ? isZh
            ? '已恢复自动跟随当前反代域名模式，AI 提示词、MCP 与 OIDC Discovery 将自动匹配当前访问地址。'
            : 'Switched back to automatic reverse-proxy domain detection.'
          : isZh
            ? `对外 Issuer 地址已保存为 ${trimmed}，所有 AI 提示词、MCP 与 OIDC Discovery 已同步生效。`
            : `Public Issuer URL saved as ${trimmed}. AI prompts, MCP, and OIDC Discovery are now in sync.`,
      });
    } catch (err) {
      setIssuerNotice({
        text: err instanceof Error ? err.message : 'Failed to update Issuer URL',
        isError: true,
      });
    } finally {
      setSavingIssuer(false);
    }
  }

  const aiThemePrompt = useMemo(
    () =>
      buildAiThemeSyncPrompt({
        issuerUrl: cleanIssuer,
        clientId: activeClientId,
        appName: activeAppName,
        currentTheme: draftTheme,
        locale,
      }),
    [cleanIssuer, activeClientId, activeAppName, draftTheme, locale]
  );

  const aiIntegrationPrompt = useMemo(
    () =>
      buildAiIntegrationPrompt({
        issuerUrl: cleanIssuer,
        clientId: activeClientId,
        appName: activeAppName,
        redirectUri: activeRedirectUri,
        locale,
        loginEntryMode,
      }),
    [cleanIssuer, activeClientId, activeAppName, activeRedirectUri, locale, loginEntryMode]
  );

  const activeTokenDisplay = mintedTokenInMem && fillMintedToken ? mintedTokenInMem : '$WIMOTEK_ADMIN_TOKEN';

  const curlSyncCommand = useMemo(
    () =>
      `curl -X PUT "${cleanIssuer}/api/applications/${activeClientId}/theme" \\\n` +
      `  -H "Authorization: Bearer ${activeTokenDisplay}" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '${JSON.stringify(draftTheme, null, 2)}'`,
    [cleanIssuer, activeClientId, draftTheme, activeTokenDisplay]
  );

  const mcpClientConfig = useMemo(
    () => buildMcpClientConfigJson(`${cleanIssuer}/api/mcp`, activeTokenDisplay),
    [cleanIssuer, activeTokenDisplay]
  );

  const hasCustomCanvasBg =
    draftTheme.surfaceMode !== 'auto' ||
    draftTheme.backgroundColor.toLowerCase() !== DEFAULT_LOGIN_THEME.backgroundColor.toLowerCase();

  const canvasStyleTag = hasCustomCanvasBg
    ? `[data-wimotek-canvas="${canvasScope}"] { background-color: ${draftTheme.backgroundColor}; }`
    : '';

  async function handleSaveThemeClick() {
    setSavingTheme(true);
    setSaveNotice(null);
    setSaveError(null);
    try {
      await onSaveTheme(activeClientId, normalizeLoginTheme(draftTheme));
      setSaveNotice(isZh ? `已保存到 ${activeClientId} 并实时生效` : `Saved theme for ${activeClientId}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save theme');
    } finally {
      setSavingTheme(false);
    }
  }

  function handleResetTheme() {
    setDraftTheme(
      normalizeLoginTheme({
        ...DEFAULT_LOGIN_THEME,
        brandTitle: activeAppName,
        footerText: `${activeAppName} · wimotek/Oauth`,
      })
    );
    setSaveNotice(null);
    setSaveError(null);
  }

  function handleCopy(id: string, text: string) {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
    }
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000);
  }

  function patchTheme<K extends keyof LoginThemeConfig>(key: K, value: LoginThemeConfig[K]) {
    setDraftTheme((prev) => ({ ...prev, [key]: value }));
    setSaveNotice(null);
  }

  const parsedJsonPreview = useMemo(() => {
    if (!jsonInputText.trim()) return null;
    return parseImportedLoginThemeJson(jsonInputText, draftTheme);
  }, [jsonInputText, draftTheme]);

  function openJsonImportModal() {
    setJsonImportError(null);
    setJsonModalOpen(true);
  }

  function handleJsonFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      setJsonInputText(text);
      setJsonImportError(null);
    };
    reader.readAsText(file);
  }

  function handleApplyImportedJson(andSave: boolean) {
    const result = parseImportedLoginThemeJson(jsonInputText, draftTheme);
    if (!result.ok) {
      setJsonImportError(result.error);
      return;
    }
    setDraftTheme(result.theme);
    setJsonImportError(null);
    setSaveError(null);
    setRightTab('theme');

    if (!andSave) {
      setSaveNotice(
        isZh
          ? `已导入 ${result.matchedKeys.length} 个主题字段到实时预览，确认后点击保存即可生效。`
          : `Imported ${result.matchedKeys.length} theme fields into live preview. Click Save to persist.`
      );
      setJsonModalOpen(false);
      return;
    }

    setImportingSave(true);
    void onSaveTheme(activeClientId, result.theme)
      .then(() => {
        setSaveNotice(
          isZh
            ? `已导入 JSON 并保存到 ${activeClientId} 实时生效`
            : `Imported JSON and saved theme for ${activeClientId}`
        );
        setJsonModalOpen(false);
      })
      .catch((err) => {
        setJsonImportError(err instanceof Error ? err.message : 'Failed to save imported theme');
      })
      .finally(() => {
        setImportingSave(false);
      });
  }

  function handleDownloadCurrentThemeJson() {
    const blob = new Blob([JSON.stringify(draftTheme, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wimotek-theme-${activeClientId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const isSplitLayout = draftTheme.layout === 'split_left' || draftTheme.layout === 'split_right';

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {isZh ? '托管登录页样式工坊 & OIDC 实验室' : 'Hosted Login Theme Studio & OIDC Lab'}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 i18n-safe">
            {isZh
              ? '按每个接入网站（client_id）独立定制登录页排版、配色与自定义 CSS，支持复制 AI 提示词自动对齐业务站视觉，并实时验证 OIDC PKCE 链路。'
              : 'Customize per-application (client_id) hosted login layouts, colors, and scoped CSS, copy AI prompts for instant brand matching, and inspect live OIDC PKCE traces.'}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap w-full lg:w-auto min-w-0">
          <label className="sr-only" htmlFor="lab-app-select">Target Application</label>
          <select
            id="lab-app-select"
            value={activeClientId}
            onChange={(e) => onSelectClientId(e.target.value)}
            className="w-full sm:w-auto max-w-full min-w-0 min-h-[38px] px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] text-slate-800 dark:text-slate-200"
          >
            {applications.map((app) => (
              <option key={app.id} value={app.clientId}>
                {app.name} ({app.clientId})
              </option>
            ))}
          </select>

          <div className="inline-flex items-center p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700">
            <button
              type="button"
              onClick={() => setViewport('desktop')}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                viewport === 'desktop'
                  ? 'bg-white dark:bg-[#111827] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              <Monitor className="w-3.5 h-3.5" />
              <span>{t.viewportDesktop}</span>
            </button>
            <button
              type="button"
              onClick={() => setViewport('mobile')}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                viewport === 'mobile'
                  ? 'bg-white dark:bg-[#111827] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span>{t.viewportMobile}</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setRtl((v) => !v)}
            className={`min-h-[38px] px-3 py-1.5 text-xs font-medium rounded-lg border flex items-center gap-1.5 whitespace-nowrap transition-colors ${
              rtl
                ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300'
                : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] text-slate-700 dark:text-slate-300'
            }`}
          >
            <ArrowLeftRight className="w-3.5 h-3.5" />
            <span>{t.rtlPreview}</span>
          </button>

          <button
            type="button"
            onClick={openJsonImportModal}
            className="min-h-[38px] px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 flex items-center gap-1.5 whitespace-nowrap transition-colors"
          >
            <FileJson className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
            <span>{isZh ? '导入 / 导出 JSON' : 'Import / Export JSON'}</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-7 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-[#111827] shadow-xs">
          <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D1321] flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 shrink-0" aria-hidden="true">
              <span className="w-2.5 h-2.5 rounded-full bg-slate-300 dark:bg-slate-700" />
              <span className="w-2.5 h-2.5 rounded-full bg-slate-300 dark:bg-slate-700" />
              <span className="w-2.5 h-2.5 rounded-full bg-slate-300 dark:bg-slate-700" />
            </div>
            <div className="flex-1 min-w-0 px-3 py-1 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center gap-1.5 text-[11px] font-mono text-slate-500 dark:text-slate-400">
              <Globe className="w-3 h-3 shrink-0 text-slate-400" />
              <span className="truncate">
                {cleanIssuer}/oauth/authorize?client_id={activeClientId}
              </span>
            </div>
            <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 shrink-0 hidden sm:inline">
              {draftTheme.layout}
            </span>
          </div>

          {canvasStyleTag && <style>{canvasStyleTag}</style>}
          <div
            data-wimotek-canvas={canvasScope}
            className="bg-slate-100/80 dark:bg-[#0B0F19] p-5 sm:p-8 flex justify-center items-center min-h-[540px] transition-colors"
          >
            <div
              className={`w-full transition-all ${
                viewport === 'mobile'
                  ? 'max-w-[360px]'
                  : isSplitLayout
                    ? 'max-w-[820px]'
                    : 'max-w-[440px]'
              }`}
            >
              <HostedLoginCard
                locale={locale}
                connectors={connectors}
                authPolicy={authPolicy}
                theme={draftTheme}
                clientId={activeClientId}
                rtl={rtl}
                compact={viewport === 'mobile'}
                onPasswordSignIn={onPasswordSignIn}
                onSocialSignIn={onSocialSignIn}
                onAuthCompleted={onAuthCompleted}
              />
            </div>
          </div>
        </div>

        <section className="xl:col-span-5 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div
            role="tablist"
            aria-label="Login Lab tools"
            className="grid grid-cols-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0D1321] p-1.5 gap-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={rightTab === 'theme'}
              onClick={() => setRightTab('theme')}
              className={`px-2.5 py-2 text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors ${
                rightTab === 'theme'
                  ? 'bg-white dark:bg-[#111827] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Palette className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{isZh ? '样式与排版' : 'Theme Studio'}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightTab === 'ai_api'}
              onClick={() => setRightTab('ai_api')}
              className={`px-2.5 py-2 text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors ${
                rightTab === 'ai_api'
                  ? 'bg-white dark:bg-[#111827] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{isZh ? 'AI 提示词 & API' : 'AI & API'}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightTab === 'trace'}
              onClick={() => setRightTab('trace')}
              className={`px-2.5 py-2 text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors ${
                rightTab === 'trace'
                  ? 'bg-white dark:bg-[#111827] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Activity className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{isZh ? 'OIDC 追踪' : 'OIDC Trace'}</span>
              {latestTrace && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />}
            </button>
          </div>

          <div className="p-5 space-y-5">
            {rightTab === 'theme' && (
              <div className="space-y-4 text-xs">
                <div>
                  <div className="font-medium text-slate-700 dark:text-slate-300 mb-2">
                    {isZh ? '一键风格预设' : 'Quick Style Presets'}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                    {LOGIN_THEME_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() =>
                          setDraftTheme({
                            ...preset.theme,
                            brandTitle: draftTheme.brandTitle || activeAppName,
                            footerText: draftTheme.footerText || `${activeAppName} · wimotek/Oauth`,
                          })
                        }
                        className="px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-indigo-500 dark:hover:border-indigo-400 bg-slate-50/70 dark:bg-slate-900/60 text-left text-[11px] font-medium text-slate-800 dark:text-slate-200 transition-colors truncate"
                      >
                        {isZh ? preset.nameZh : preset.nameEn}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="font-medium text-slate-700 dark:text-slate-300 mb-2">
                    {isZh ? '页面排版结构' : 'Layout Structure'}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {(
                      [
                        { id: 'centered', labelZh: '居中卡片', labelEn: 'Centered Card' },
                        { id: 'split_left', labelZh: '左视觉 · 右登录', labelEn: 'Split Left Hero' },
                        { id: 'split_right', labelZh: '左登录 · 右视觉', labelEn: 'Split Right Hero' },
                        { id: 'minimal', labelZh: '极简无框', labelEn: 'Minimal Borderless' },
                      ] as { id: LoginThemeLayout; labelZh: string; labelEn: string }[]
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => patchTheme('layout', opt.id)}
                        className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                          draftTheme.layout === opt.id
                            ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300'
                            : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                        }`}
                      >
                        {isZh ? opt.labelZh : opt.labelEn}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="theme-surface" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      {isZh ? '明暗表面' : 'Surface Mode'}
                    </label>
                    <select
                      id="theme-surface"
                      value={draftTheme.surfaceMode}
                      onChange={(e) => patchTheme('surfaceMode', e.target.value as LoginThemeSurface)}
                      className="w-full min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    >
                      <option value="auto">{isZh ? '跟随系统 (Auto)' : 'Auto'}</option>
                      <option value="light">{isZh ? '浅色 (Light)' : 'Light'}</option>
                      <option value="dark">{isZh ? '深色 (Dark)' : 'Dark'}</option>
                    </select>
                  </div>

                  <div>
                    <label htmlFor="theme-radius" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      {isZh ? '圆角风格' : 'Border Radius'}
                    </label>
                    <select
                      id="theme-radius"
                      value={draftTheme.borderRadius}
                      onChange={(e) => patchTheme('borderRadius', e.target.value as LoginThemeRadius)}
                      className="w-full min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    >
                      <option value="sharp">{isZh ? '硬朗方角 (Sharp)' : 'Sharp'}</option>
                      <option value="rounded">{isZh ? '柔和圆角 (Rounded)' : 'Rounded'}</option>
                      <option value="pill">{isZh ? '胶囊大圆角 (Pill)' : 'Pill'}</option>
                    </select>
                  </div>

                  <div>
                    <label htmlFor="theme-font" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      {isZh ? '字体族' : 'Typography'}
                    </label>
                    <select
                      id="theme-font"
                      value={draftTheme.fontFamily}
                      onChange={(e) => patchTheme('fontFamily', e.target.value as LoginThemeFont)}
                      className="w-full min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    >
                      <option value="sans">{isZh ? '现代无衬线 (Sans)' : 'Sans-Serif'}</option>
                      <option value="serif">{isZh ? '编辑衬线体 (Serif)' : 'Editorial Serif'}</option>
                      <option value="mono">{isZh ? '极客等宽体 (Mono)' : 'Developer Mono'}</option>
                    </select>
                  </div>

                  <div>
                    <label htmlFor="theme-social-layout" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      {isZh ? '社交登录按钮排列' : 'Social Buttons'}
                    </label>
                    <select
                      id="theme-social-layout"
                      value={draftTheme.socialLayout}
                      onChange={(e) => patchTheme('socialLayout', e.target.value === 'grid' ? 'grid' : 'stack')}
                      className="w-full min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    >
                      <option value="stack">{isZh ? '纵向通栏 (Stack)' : 'Full-Width Stack'}</option>
                      <option value="grid">{isZh ? '两列紧凑网格 (Grid)' : 'Compact 2-Column Grid'}</option>
                    </select>
                  </div>
                </div>

                <div>
                  <div className="font-medium text-slate-700 dark:text-slate-300 mb-2">
                    {isZh ? '品牌配色 (HEX)' : 'Brand Palette (HEX)'}
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    {(
                      [
                        { key: 'primaryColor', labelZh: '品牌主色', labelEn: 'Primary' },
                        { key: 'backgroundColor', labelZh: '页面背景', labelEn: 'Page BG' },
                        { key: 'cardColor', labelZh: '卡片底色', labelEn: 'Card BG' },
                        { key: 'textColor', labelZh: '主文字色', labelEn: 'Text' },
                      ] as const
                    ).map((item) => (
                      <div key={item.key} className="space-y-1">
                        <label htmlFor={`color-${item.key}`} className="block text-[11px] text-slate-500 dark:text-slate-400">
                          {isZh ? item.labelZh : item.labelEn}
                        </label>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="color"
                            aria-label={isZh ? item.labelZh : item.labelEn}
                            value={draftTheme[item.key]}
                            onChange={(e) => patchTheme(item.key, e.target.value)}
                            className="w-8 h-8 rounded border border-slate-200 dark:border-slate-700 cursor-pointer bg-transparent p-0.5 shrink-0"
                          />
                          <input
                            id={`color-${item.key}`}
                            type="text"
                            value={draftTheme[item.key]}
                            onChange={(e) => patchTheme(item.key, e.target.value)}
                            className="flex-1 min-w-0 h-8 px-2 font-mono text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="theme-brand-title" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      {isZh ? '品牌主标题' : 'Brand Title'}
                    </label>
                    <input
                      id="theme-brand-title"
                      type="text"
                      value={draftTheme.brandTitle}
                      onChange={(e) => patchTheme('brandTitle', e.target.value)}
                      placeholder={activeAppName}
                      className="w-full min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                  </div>
                  <div>
                    <label htmlFor="theme-logo-url" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      {isZh ? '自定义 Logo URL' : 'Custom Logo URL'}
                    </label>
                    <input
                      id="theme-logo-url"
                      type="text"
                      value={draftTheme.logoUrl}
                      onChange={(e) => patchTheme('logoUrl', e.target.value)}
                      placeholder="https://example.com/logo.svg"
                      className="w-full min-h-[36px] px-2.5 py-1.5 font-mono text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor="theme-brand-subtitle" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      {isZh ? '登录页副标题（留空跟随多语言默认）' : 'Subtitle (blank = locale default)'}
                    </label>
                    <input
                      id="theme-brand-subtitle"
                      type="text"
                      value={draftTheme.brandSubtitle}
                      onChange={(e) => patchTheme('brandSubtitle', e.target.value)}
                      placeholder={t.loginSubtitle}
                      className="w-full min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                  </div>
                  {isSplitLayout && (
                    <>
                      <div className="sm:col-span-2">
                        <label htmlFor="theme-hero-title" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                          {isZh ? '分栏侧边主标语' : 'Split Hero Headline'}
                        </label>
                        <input
                          id="theme-hero-title"
                          type="text"
                          value={draftTheme.heroTitle}
                          onChange={(e) => patchTheme('heroTitle', e.target.value)}
                          className="w-full min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label htmlFor="theme-hero-subtitle" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                          {isZh ? '分栏侧边说明文案' : 'Split Hero Description'}
                        </label>
                        <input
                          id="theme-hero-subtitle"
                          type="text"
                          value={draftTheme.heroSubtitle}
                          onChange={(e) => patchTheme('heroSubtitle', e.target.value)}
                          className="w-full min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                        />
                      </div>
                    </>
                  )}
                  <div className="sm:col-span-2">
                    <label htmlFor="theme-footer" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      {isZh ? '底部版权标识' : 'Footer Label'}
                    </label>
                    <input
                      id="theme-footer"
                      type="text"
                      value={draftTheme.footerText}
                      onChange={(e) => patchTheme('footerText', e.target.value)}
                      className="w-full min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="theme-custom-css" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {isZh ? '自定义 CSS（安全过滤，支持选择器微调）' : 'Scoped Custom CSS (sanitized)'}
                  </label>
                  <textarea
                    id="theme-custom-css"
                    rows={3}
                    value={draftTheme.customCss}
                    onChange={(e) => patchTheme('customCss', e.target.value)}
                    placeholder="[data-wimotek-login-card] { box-shadow: 0 20px 50px rgba(15,23,42,0.12); }"
                    className="w-full px-3 py-2 font-mono text-[11px] rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F19] text-slate-800 dark:text-slate-200"
                  />
                </div>

                {saveNotice && (
                  <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 rounded-lg px-3 py-2">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    <span>{saveNotice}</span>
                  </div>
                )}

                {saveError && (
                  <div className="text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 rounded-lg px-3 py-2">
                    {saveError}
                  </div>
                )}

                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleSaveThemeClick}
                    disabled={savingTheme}
                    className="flex-1 min-h-[38px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-medium flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>
                      {savingTheme
                        ? isZh
                          ? '正在保存...'
                          : 'Saving...'
                        : isZh
                          ? `保存到 ${activeClientId}`
                          : `Save Theme for ${activeClientId}`}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={handleResetTheme}
                    className="min-h-[38px] px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>{isZh ? '重置' : 'Reset'}</span>
                  </button>
                </div>
              </div>
            )}

            {rightTab === 'ai_api' && (
              <div className="space-y-4 text-xs">
                <div className="p-3.5 rounded-lg bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-200/80 dark:border-indigo-900/60 space-y-1.5">
                  <div className="font-semibold text-indigo-900 dark:text-indigo-200">
                    {isZh ? '多网站独立样式适配原理（按 client_id 自动切换）' : 'How Per-Website Adaptation Works'}
                  </div>
                  <p className="text-indigo-800/90 dark:text-indigo-300/90 leading-relaxed">
                    {isZh
                      ? '每个业务网站对应一个独立 OAuth Client。用户从网站 A 跳转到 /oauth/authorize?client_id=site_a 时，wimotek/Oauth 自动渲染网站 A 的专属配色、Logo 与排版；调用方 AI 工具可直接调用下方 Theme API 自动同步样式。'
                      : 'Each calling site gets its own client_id. When users hit /oauth/authorize?client_id=..., wimotek/Oauth loads that app’s saved theme automatically. AI coding agents can sync themes via the REST API below.'}
                  </p>
                </div>

                {/* Public Issuer URL & Reverse Proxy HTTPS Calibration */}
                <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-2.5 bg-slate-50/70 dark:bg-[#0D1321]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        {isZh ? '当前提示词 / MCP / API 使用的对外地址 (Issuer)' : 'Public Issuer URL used in Prompts / MCP / API'}
                        <span className="ml-1.5 text-[10.5px] font-normal">
                          {issuerLocked
                            ? isZh
                              ? '· 手动锁定'
                              : '· Pinned'
                            : isZh
                              ? '· 自动跟随反代域名'
                              : '· Auto-detect'}
                        </span>
                      </div>
                      <div className="font-mono text-[11.5px] font-semibold text-slate-900 dark:text-slate-100 break-all mt-0.5">
                        {cleanIssuer}
                      </div>
                    </div>
                    {onUpdateIssuerUrl && (
                      <button
                        type="button"
                        onClick={() => {
                          setDraftIssuerUrl(cleanIssuer);
                          setEditingIssuer((v) => !v);
                        }}
                        className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-medium text-slate-700 dark:text-slate-200 inline-flex items-center gap-1 shrink-0"
                      >
                        <Globe className="w-3 h-3" />
                        <span>{isZh ? '修改对外域名' : 'Edit Issuer'}</span>
                      </button>
                    )}
                  </div>

                  {issuerMismatch.hostMismatch && onUpdateIssuerUrl && issuerMismatch.recommendedIssuer && (
                    <div className="p-2.5 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/70 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px]">
                      <div className="flex items-start gap-1.5 text-amber-900 dark:text-amber-200 leading-relaxed">
                        <AlertCircle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                        <span>
                          {isZh
                            ? `检测到服务端保存的域名 (${rawServerIssuerUrl || cleanIssuer}) 与当前浏览器访问域名 (${issuerMismatch.browserOrigin}) 不一致，常见于历史 config.json 旧域名或反代未透传 Host。点击右侧一键同步为当前访问地址。`
                            : `Server Issuer (${rawServerIssuerUrl || cleanIssuer}) differs from your current browser origin (${issuerMismatch.browserOrigin}). Click to sync immediately.`}
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={savingIssuer}
                        onClick={() => void handleSubmitIssuerUrl(issuerMismatch.recommendedIssuer)}
                        className="px-2.5 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-medium whitespace-nowrap shrink-0"
                      >
                        {savingIssuer
                          ? isZh
                            ? '同步中...'
                            : 'Syncing...'
                          : isZh
                            ? `同步为 ${issuerMismatch.recommendedIssuer}`
                            : `Sync to ${issuerMismatch.recommendedIssuer}`}
                      </button>
                    </div>
                  )}

                  {serverNeedsHttpsSync && onUpdateIssuerUrl && (
                    <div className="p-2.5 rounded-md bg-emerald-50/80 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/70 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px]">
                      <div className="text-emerald-900 dark:text-emerald-200 leading-relaxed">
                        {isZh
                          ? `检测到通过 HTTPS 反代访问，下方提示词与接口已自动修正为 ${cleanIssuer}。建议同步写入服务端，使 /.well-known/openid-configuration 也返回 HTTPS。`
                          : `HTTPS reverse proxy detected — prompts and endpoints below are auto-upgraded to ${cleanIssuer}. Persist this to the server so OIDC Discovery also returns HTTPS.`}
                      </div>
                      <button
                        type="button"
                        disabled={savingIssuer}
                        onClick={() => void handleSubmitIssuerUrl(cleanIssuer)}
                        className="px-2.5 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-medium whitespace-nowrap shrink-0"
                      >
                        {savingIssuer ? (isZh ? '同步中...' : 'Saving...') : isZh ? '同步写入服务端 HTTPS' : 'Save HTTPS to Server'}
                      </button>
                    </div>
                  )}

                  {!issuerMismatch.hostMismatch && effectiveIsNonLocalHttp && (
                    <div className="p-2.5 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/70 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px]">
                      <div className="flex items-start gap-1.5 text-amber-900 dark:text-amber-200 leading-relaxed">
                        <AlertCircle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                        <span>
                          {isZh
                            ? '当前对外地址为 HTTP（常见于反代转发到内部 HTTP 端口且未透传 X-Forwarded-Proto: https）。点击右侧一键切换为 HTTPS，避免 AI 提示词生成 http:// 地址。'
                            : 'Public Issuer is currently HTTP (typical when a reverse proxy forwards to internal HTTP without X-Forwarded-Proto: https). Switch to HTTPS so AI prompts use https://.'}
                        </span>
                      </div>
                      {onUpdateIssuerUrl && (
                        <button
                          type="button"
                          disabled={savingIssuer}
                          onClick={() => void handleSubmitIssuerUrl(suggestedHttpsIssuer)}
                          className="px-2.5 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-medium whitespace-nowrap shrink-0"
                        >
                          {savingIssuer ? (isZh ? '切换中...' : 'Switching...') : isZh ? '一键切换为 HTTPS' : 'Switch to HTTPS'}
                        </button>
                      )}
                    </div>
                  )}

                  {editingIssuer && onUpdateIssuerUrl && (
                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-1.5 pt-1">
                      <input
                        type="url"
                        value={draftIssuerUrl}
                        onChange={(e) => setDraftIssuerUrl(e.target.value)}
                        placeholder="https://auth.example.com"
                        className="flex-1 min-h-[34px] px-2.5 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono text-[11.5px] text-slate-900 dark:text-slate-100"
                      />
                      <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                        <button
                          type="button"
                          disabled={savingIssuer || !draftIssuerUrl.trim()}
                          onClick={() => void handleSubmitIssuerUrl(draftIssuerUrl)}
                          className="min-h-[34px] px-3 py-1 rounded-md bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-[11px] font-medium"
                        >
                          {savingIssuer ? (isZh ? '保存中...' : 'Saving...') : isZh ? '保存' : 'Save'}
                        </button>
                        <button
                          type="button"
                          disabled={savingIssuer}
                          onClick={() => void handleSubmitIssuerUrl('', true)}
                          className="min-h-[34px] px-2.5 py-1 rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50/70 dark:bg-emerald-950/30 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
                        >
                          {isZh ? '恢复自动检测' : 'Auto-Detect'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingIssuer(false)}
                          className="min-h-[34px] px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-[11px] text-slate-600 dark:text-slate-300"
                        >
                          {isZh ? '取消' : 'Cancel'}
                        </button>
                      </div>
                    </div>
                  )}

                  {issuerNotice && (
                    <div
                      className={`text-[11px] px-2.5 py-1.5 rounded-md border ${
                        issuerNotice.isError
                          ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-400'
                          : 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/60 text-emerald-700 dark:text-emerald-400'
                      }`}
                    >
                      {issuerNotice.text}
                    </div>
                  )}
                </div>

                <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                  <div className="px-3.5 py-2.5 bg-slate-50 dark:bg-[#0D1321] border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 font-semibold text-slate-900 dark:text-white">
                      <KeyRound className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                      <span>
                        {isZh ? '$WIMOTEK_ADMIN_TOKEN & MCP 接入' : '$WIMOTEK_ADMIN_TOKEN & MCP Server'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTokenModalOpen(true)}
                      className="px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-medium flex items-center gap-1 transition-colors"
                    >
                      <KeyRound className="w-3 h-3" />
                      <span>{isZh ? '生成 / 管理 Admin Token' : 'Generate / Manage Token'}</span>
                    </button>
                  </div>
                  <div className="p-3 space-y-2.5">
                    <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
                      {isZh
                        ? '点击右上角“生成 / 管理 Admin Token”签发长期 API 令牌（wmk_pat_...），也可随时在「安全策略 → Admin API Tokens」中管理或吊销。支持直接用于下方 curl 及 MCP 客户端。'
                        : 'Click "Generate / Manage Token" to mint a long-lived personal admin token (wmk_pat_...), or manage/revoke tokens anytime under Security Policy. Works with both REST APIs and the built-in MCP Server.'}
                    </p>
                    {mintedTokenInMem && (
                      <label className="flex items-center gap-2 text-[11px] text-emerald-700 dark:text-emerald-400 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={fillMintedToken}
                          onChange={(e) => setFillMintedToken(e.target.checked)}
                          className="rounded border-slate-300 dark:border-slate-700"
                        />
                        <span>
                          {isZh
                            ? '在下方 MCP / curl 示例中自动填入本次新生成的 Token（仅存于当前页面内存）'
                            : 'Populate newly generated token in MCP / curl snippets below (kept in memory only)'}
                        </span>
                      </label>
                    )}
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="flex items-center gap-1.5 font-mono text-[11px] text-slate-700 dark:text-slate-300 break-all">
                        <Cpu className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                        <span>POST {cleanIssuer}/api/mcp</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopy('mcp_cfg', mcpClientConfig)}
                        className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] font-medium flex items-center gap-1 hover:bg-slate-50 dark:hover:bg-slate-800 shrink-0"
                      >
                        {copiedId === 'mcp_cfg' ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                        <span>{copiedId === 'mcp_cfg' ? (isZh ? '已复制' : 'Copied') : 'Copy mcp.json'}</span>
                      </button>
                    </div>
                    <pre className="p-2.5 rounded-md bg-slate-950 text-slate-100 font-mono text-[10.5px] overflow-x-auto leading-relaxed">
                      {mcpClientConfig}
                    </pre>
                  </div>
                </div>

                <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                  <div className="px-3.5 py-2.5 bg-slate-50 dark:bg-[#0D1321] border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900 dark:text-white">
                      {isZh ? 'Theme REST API（供 AI / CI 自动同步）' : 'Theme REST API (AI / CI Sync)'}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopy('curl', curlSyncCommand)}
                      className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] font-medium flex items-center gap-1 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      {copiedId === 'curl' ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedId === 'curl' ? (isZh ? '已复制' : 'Copied') : 'Copy curl'}</span>
                    </button>
                  </div>
                  <div className="p-3 space-y-2">
                    <div className="font-mono text-[11px] text-slate-600 dark:text-slate-300 space-y-1 break-all">
                      <div>
                        <span className="text-emerald-600 dark:text-emerald-400 font-semibold">GET</span>{' '}
                        {cleanIssuer}/api/public/theme?client_id={activeClientId}
                      </div>
                      <div>
                        <span className="text-indigo-600 dark:text-indigo-400 font-semibold">PUT</span>{' '}
                        {cleanIssuer}/api/applications/{activeClientId}/theme
                      </div>
                    </div>
                    <pre className="p-2.5 rounded-md bg-slate-950 text-slate-100 font-mono text-[10.5px] overflow-x-auto max-h-40 leading-relaxed">
                      {curlSyncCommand}
                    </pre>
                  </div>
                </div>

                <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                  <div className="px-3.5 py-2.5 bg-slate-50 dark:bg-[#0D1321] border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900 dark:text-white">
                      {isZh ? '提示词 1：让 AI 按业务站风格自动改样式' : 'Prompt 1: AI Auto Style & Layout Sync'}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopy('prompt_theme', aiThemePrompt)}
                      className="px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-medium flex items-center gap-1 shrink-0"
                    >
                      {copiedId === 'prompt_theme' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedId === 'prompt_theme' ? (isZh ? '已复制' : 'Copied') : isZh ? '复制提示词' : 'Copy Prompt'}</span>
                    </button>
                  </div>
                  <pre className="p-3 bg-slate-50/70 dark:bg-[#0B0F19] font-mono text-[11px] text-slate-700 dark:text-slate-300 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">
                    {aiThemePrompt}
                  </pre>
                </div>

                <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                  <div className="px-3.5 py-2.5 bg-slate-50 dark:bg-[#0D1321] border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900 dark:text-white">
                      {isZh ? '提示词 2：让 AI 一键集成 OIDC 登录开发' : 'Prompt 2: AI Full OIDC Integration'}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopy('prompt_oidc', aiIntegrationPrompt)}
                      className="px-2.5 py-1 rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-[11px] font-medium flex items-center gap-1 shrink-0"
                    >
                      {copiedId === 'prompt_oidc' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedId === 'prompt_oidc' ? (isZh ? '已复制' : 'Copied') : isZh ? '复制提示词' : 'Copy Prompt'}</span>
                    </button>
                  </div>

                  {/* Login Entry Mode Selector + Comparison Note */}
                  <div className="p-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] space-y-2.5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                        {isZh ? '选择未登录时的入口方式' : 'Unauthenticated Entry Behavior'}
                      </span>
                      <div
                        role="radiogroup"
                        aria-label={isZh ? '登录入口方式' : 'Login entry mode'}
                        className="inline-flex p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 gap-0.5"
                      >
                        <button
                          type="button"
                          role="radio"
                          aria-checked={loginEntryMode === 'direct_redirect'}
                          onClick={() => setLoginEntryMode('direct_redirect')}
                          className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap ${
                            loginEntryMode === 'direct_redirect'
                              ? 'bg-white dark:bg-[#111827] text-indigo-700 dark:text-indigo-300 shadow-xs'
                              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                          }`}
                        >
                          {isZh ? '方式 A：直接跳转登录页（默认）' : 'Mode A: Direct Redirect (Default)'}
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={loginEntryMode === 'button_trigger'}
                          onClick={() => setLoginEntryMode('button_trigger')}
                          className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap ${
                            loginEntryMode === 'button_trigger'
                              ? 'bg-white dark:bg-[#111827] text-indigo-700 dark:text-indigo-300 shadow-xs'
                              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                          }`}
                        >
                          {isZh ? '方式 B：按钮点击后登录' : 'Mode B: Button Trigger'}
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] leading-relaxed">
                      <div
                        className={`p-2.5 rounded-lg border transition-colors ${
                          loginEntryMode === 'direct_redirect'
                            ? 'border-indigo-300 dark:border-indigo-700 bg-indigo-50/60 dark:bg-indigo-950/30 text-slate-800 dark:text-slate-200'
                            : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 text-slate-600 dark:text-slate-400'
                        }`}
                      >
                        <div className="font-semibold text-slate-900 dark:text-white mb-0.5">
                          {isZh ? '方式 A · 直接跳转登录页（默认）' : 'Mode A · Direct Auto-Redirect (Default)'}
                        </div>
                        <p>
                          {isZh
                            ? '打开网站未登录时直接 302 / 守卫跳转至认证中心登录页，不生成多余的「点击登录」中间页。适合后台系统、企业内部工具与纯 SaaS 工作台。'
                            : 'Redirects unauthenticated visitors straight to the hosted login page with zero extra click. Best for admin panels, internal tools, and private SaaS apps.'}
                        </p>
                      </div>
                      <div
                        className={`p-2.5 rounded-lg border transition-colors ${
                          loginEntryMode === 'button_trigger'
                            ? 'border-indigo-300 dark:border-indigo-700 bg-indigo-50/60 dark:bg-indigo-950/30 text-slate-800 dark:text-slate-200'
                            : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 text-slate-600 dark:text-slate-400'
                        }`}
                      >
                        <div className="font-semibold text-slate-900 dark:text-white mb-0.5">
                          {isZh ? '方式 B · 页面按钮点击后登录' : 'Mode B · Button-Triggered Entry'}
                        </div>
                        <p>
                          {isZh
                            ? '保留未登录公开浏览页，用户在导航栏或入口页点击「登录」按钮后再跳往认证中心。适合官网、博客、文档站、社区或电商等含公开内容的网站。'
                            : 'Allows guests to browse public pages first and sign in via a navbar/page button. Best for landing sites, docs, blogs, forums, and storefronts.'}
                        </p>
                      </div>
                    </div>
                  </div>

                  <pre className="p-3 bg-slate-50/70 dark:bg-[#0B0F19] font-mono text-[11px] text-slate-700 dark:text-slate-300 whitespace-pre-wrap max-h-56 overflow-y-auto leading-relaxed">
                    {aiIntegrationPrompt}
                  </pre>
                </div>
              </div>
            )}

            {rightTab === 'trace' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800">
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                    {t.oidcTraceTitle}
                  </h2>
                  {latestTrace && (
                    <span className="text-xs font-mono tabular-nums text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      RS256 Verified · {latestTrace.elapsedMs}ms
                    </span>
                  )}
                </div>

                {!latestTrace ? (
                  <div className="py-12 text-center space-y-2">
                    <ShieldCheck className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-700" />
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      Authenticate using any configured method on the left to inspect the live OIDC Authorization Code + PKCE (S256) trace.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4 text-xs">
                    <dl className="divide-y divide-slate-100 dark:divide-slate-800">
                      <div className="py-2 flex justify-between gap-4">
                        <dt className="text-slate-500 dark:text-slate-400">Upstream Provider</dt>
                        <dd className="font-medium text-slate-900 dark:text-slate-100">{latestTrace.provider}</dd>
                      </div>
                      {latestTrace.authMethod && (
                        <div className="py-2 flex justify-between gap-4">
                          <dt className="text-slate-500 dark:text-slate-400">Auth Method</dt>
                          <dd className="font-mono text-slate-800 dark:text-slate-200">{latestTrace.authMethod}</dd>
                        </div>
                      )}
                      {latestTrace.jitAction && (
                        <div className="py-2 flex justify-between gap-4">
                          <dt className="text-slate-500 dark:text-slate-400">Identity Linking (JIT)</dt>
                          <dd className="font-mono text-emerald-700 dark:text-emerald-400">{latestTrace.jitAction}</dd>
                        </div>
                      )}
                      <div className="py-2 flex justify-between gap-4">
                        <dt className="text-slate-500 dark:text-slate-400">Client ID</dt>
                        <dd className="font-mono text-slate-800 dark:text-slate-200">{latestTrace.clientId}</dd>
                      </div>
                      <div className="py-2 flex justify-between gap-4">
                        <dt className="text-slate-500 dark:text-slate-400">Cache Backend Used</dt>
                        <dd className="font-mono text-indigo-600 dark:text-indigo-400">{latestTrace.cacheBackendUsed}</dd>
                      </div>
                      <div className="py-2 flex justify-between gap-4">
                        <dt className="text-slate-500 dark:text-slate-400">PKCE S256 Challenge</dt>
                        <dd className="font-mono text-slate-700 dark:text-slate-300 truncate max-w-[220px]">
                          {latestTrace.codeChallenge}
                        </dd>
                      </div>
                      <div className="py-2 flex justify-between gap-4">
                        <dt className="text-slate-500 dark:text-slate-400">Authorization Code</dt>
                        <dd className="font-mono text-slate-700 dark:text-slate-300 truncate max-w-[220px]">
                          {latestTrace.authorizationCode}
                        </dd>
                      </div>
                    </dl>

                    <div>
                      <div className="font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                        Decoded ID Token Payload (RS256 Signature Verified: {String(latestTrace.decodedIdToken.signatureVerified)})
                      </div>
                      <pre className="p-3.5 rounded-lg bg-slate-50 dark:bg-[#0B0F19] border border-slate-200 dark:border-slate-800 font-mono text-[11px] text-slate-800 dark:text-slate-200 overflow-x-auto leading-relaxed">
                        {JSON.stringify(latestTrace.decodedIdToken.payload, null, 2)}
                      </pre>
                    </div>

                    <div>
                      <div className="font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                        GET /oauth/userinfo Response
                      </div>
                      <pre className="p-3.5 rounded-lg bg-slate-50 dark:bg-[#0B0F19] border border-slate-200 dark:border-slate-800 font-mono text-[11px] text-slate-800 dark:text-slate-200 overflow-x-auto leading-relaxed">
                        {JSON.stringify(latestTrace.userInfo, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      <AdminTokenManagerModal
        open={tokenModalOpen}
        onClose={() => setTokenModalOpen(false)}
        locale={locale}
        sessionToken={sessionToken}
        issuerUrl={cleanIssuer}
        onTokenCreated={(plain) => {
          setMintedTokenInMem(plain);
          setFillMintedToken(true);
        }}
      />

      {jsonModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs"
          onClick={() => setJsonModalOpen(false)}
        >
          <div
            className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <FileJson className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                    {isZh ? '导入 / 导出登录页主题 JSON' : 'Import / Export Hosted Login Theme JSON'}
                  </h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {isZh
                      ? `目标应用：${activeAppName} (${activeClientId}) · 支持纯 JSON、AI 输出的 Markdown 代码块或 curl 片段`
                      : `Target: ${activeAppName} (${activeClientId}) · Supports plain JSON, AI Markdown blocks, or curl snippets`}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setJsonModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    ref={jsonFileInputRef}
                    type="file"
                    accept=".json,application/json,text/plain"
                    onChange={handleJsonFileSelected}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => jsonFileInputRef.current?.click()}
                    className="min-h-[34px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 font-medium inline-flex items-center gap-1.5"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>{isZh ? '选择 .json 文件' : 'Upload .json File'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setJsonInputText(JSON.stringify(draftTheme, null, 2));
                      setJsonImportError(null);
                    }}
                    className="min-h-[34px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 font-medium"
                  >
                    {isZh ? '载入当前主题 JSON' : 'Load Current Theme'}
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleCopy('export_theme_json', JSON.stringify(draftTheme, null, 2))}
                    className="min-h-[34px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 inline-flex items-center gap-1"
                  >
                    {copiedId === 'export_theme_json' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedId === 'export_theme_json' ? (isZh ? '已复制' : 'Copied') : isZh ? '复制当前 JSON' : 'Copy Current'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadCurrentThemeJson}
                    className="min-h-[34px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 inline-flex items-center gap-1"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>{isZh ? '导出 .json' : 'Export .json'}</span>
                  </button>
                </div>
              </div>

              <textarea
                rows={11}
                value={jsonInputText}
                onChange={(e) => {
                  setJsonInputText(e.target.value);
                  setJsonImportError(null);
                }}
                placeholder={
                  isZh
                    ? '在此粘贴 AI 生成的主题 JSON、```json``` 代码块或 curl -d 命令内容...\n{\n  "layout": "split_left",\n  "primaryColor": "#059669",\n  "brandTitle": "My App"\n}'
                    : 'Paste theme JSON, an AI ```json``` block, or a curl -d snippet here...\n{\n  "layout": "split_left",\n  "primaryColor": "#059669",\n  "brandTitle": "My App"\n}'
                }
                className="w-full p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F19] font-mono text-[11.5px] text-slate-800 dark:text-slate-200 leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              />

              {parsedJsonPreview && parsedJsonPreview.ok && (
                <div className="p-3 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/25 border border-emerald-200 dark:border-emerald-800/70 flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
                  <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span>
                      {isZh
                        ? `解析成功：识别到 ${parsedJsonPreview.matchedKeys.length} 个字段（布局 ${parsedJsonPreview.theme.layout} · 表面 ${parsedJsonPreview.theme.surfaceMode} · 字体 ${parsedJsonPreview.theme.fontFamily}）`
                        : `Valid JSON: ${parsedJsonPreview.matchedKeys.length} fields detected (${parsedJsonPreview.theme.layout} · ${parsedJsonPreview.theme.surfaceMode} · ${parsedJsonPreview.theme.fontFamily})`}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {[
                      parsedJsonPreview.theme.primaryColor,
                      parsedJsonPreview.theme.backgroundColor,
                      parsedJsonPreview.theme.cardColor,
                    ].map((hex, i) => (
                      <span
                        key={`${hex}-${i}`}
                        title={hex}
                        className="w-4 h-4 rounded-full border border-slate-300 dark:border-slate-700 inline-block"
                        style={{ backgroundColor: hex }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {(jsonImportError || (parsedJsonPreview && !parsedJsonPreview.ok)) && (
                <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/60 flex items-start gap-2 text-red-700 dark:text-red-400">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{jsonImportError || (parsedJsonPreview && !parsedJsonPreview.ok ? parsedJsonPreview.error : '')}</span>
                </div>
              )}
            </div>

            <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0D1321] flex flex-wrap items-center justify-end gap-2 text-xs">
              <button
                type="button"
                onClick={() => setJsonModalOpen(false)}
                className="min-h-[36px] px-3.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                disabled={!jsonInputText.trim() || importingSave}
                onClick={() => handleApplyImportedJson(false)}
                className="min-h-[36px] px-3.5 py-1.5 rounded-lg border border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 disabled:opacity-50 font-medium"
              >
                {isZh ? '应用到实时预览' : 'Apply to Preview'}
              </button>
              <button
                type="button"
                disabled={!jsonInputText.trim() || importingSave}
                onClick={() => handleApplyImportedJson(true)}
                className="min-h-[36px] px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-medium inline-flex items-center gap-1.5"
              >
                <Save className="w-3.5 h-3.5" />
                <span>
                  {importingSave
                    ? isZh
                      ? '正在保存...'
                      : 'Saving...'
                    : isZh
                      ? `导入并保存到 ${activeClientId}`
                      : `Import & Save to ${activeClientId}`}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
