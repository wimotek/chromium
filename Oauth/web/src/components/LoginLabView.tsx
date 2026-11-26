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
  normalizeLoginTheme,
} from '../lib/loginTheme';
import { HostedLoginCard } from './HostedLoginCard';

type LabRightTab = 'theme' | 'ai_api' | 'trace';

interface LoginLabViewProps {
  locale: Locale;
  issuerUrl: string;
  connectors: SocialConnector[];
  applications: OAuthApplication[];
  authPolicy?: AuthPolicyConfig;
  selectedClientId: string;
  onSelectClientId: (clientId: string) => void;
  onSaveTheme: (clientId: string, theme: LoginThemeConfig) => Promise<void>;
  onPasswordSignIn: (email: string, password: string) => Promise<void>;
  onSocialSignIn: (provider: string) => Promise<void>;
  onAuthCompleted?: (result: { user: any; sessionToken: string; trace: OidcFlowTrace }) => void;
  latestTrace: OidcFlowTrace | null;
}

export function LoginLabView({
  locale,
  issuerUrl,
  connectors,
  applications,
  authPolicy,
  selectedClientId,
  onSelectClientId,
  onSaveTheme,
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
  const cleanIssuer = (issuerUrl || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8080')).replace(/\/$/, '');

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
      }),
    [cleanIssuer, activeClientId, activeAppName, activeRedirectUri, locale]
  );

  const curlSyncCommand = useMemo(
    () =>
      `curl -X PUT "${cleanIssuer}/api/applications/${activeClientId}/theme" \\\n` +
      `  -H "Authorization: Bearer $WIMOTEK_ADMIN_TOKEN" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '${JSON.stringify(draftTheme, null, 2)}'`,
    [cleanIssuer, activeClientId, draftTheme]
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
                  <pre className="p-3 bg-slate-50/70 dark:bg-[#0B0F19] font-mono text-[11px] text-slate-700 dark:text-slate-300 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">
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
    </div>
  );
}
