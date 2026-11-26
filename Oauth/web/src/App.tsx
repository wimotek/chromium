import React, { useCallback, useEffect, useState } from 'react';
import {
  LayoutDashboard,
  AppWindow,
  Share2,
  Users,
  ShieldCheck,
  Fingerprint,
  BookOpen,
  Sun,
  Moon,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import type {
  AuthPolicyConfig,
  AuthUser,
  DbDriver,
  IdentityProviderType,
  IdentityUser,
  Locale,
  LoginThemeConfig,
  OAuthApplication,
  OidcFlowTrace,
  SigningKeyStatus,
  SocialConnector,
  SystemConfig,
  WebhookDeliveryLog,
  WebhookSubscription,
} from './types';
import { SUPPORTED_LOCALES, TRANSLATIONS, detectBrowserLocale, reorderConnectors } from './lib/i18n';
import { DEFAULT_LOGIN_THEME, normalizeLoginTheme } from './lib/loginTheme';
import { BrandMark } from './components/ProviderIcons';
import { SetupWizard } from './components/SetupWizard';
import { HostedLoginCard } from './components/HostedLoginCard';
import { OverviewView } from './components/OverviewView';
import { ApplicationsView } from './components/ApplicationsView';
import { ConnectorsView } from './components/ConnectorsView';
import { IdentityDirectoryView } from './components/IdentityDirectoryView';
import { SecurityPolicyView } from './components/SecurityPolicyView';
import { LoginLabView } from './components/LoginLabView';
import { SdkDocsView } from './components/SdkDocsView';

type ConsoleTab = 'overview' | 'applications' | 'connectors' | 'users' | 'security' | 'login_lab' | 'sdks';

const DEFAULT_AUTH_POLICY: AuthPolicyConfig = {
  enablePasswordArgon2id: true,
  enableEmailOtpMagicLink: true,
  enableTotp2fa: true,
  enablePasskeysWebAuthn: true,
  enableDeviceFlowRfc8628: true,
  jitVerifiedEmailAutoLink: true,
  ipRateLimitPerMin: 60,
  lockoutThreshold: 3,
  captchaProvider: 'turnstile',
  captchaSiteKey: '',
};

export default function App() {
  const [locale, setLocale] = useState<Locale>(() =>
    detectBrowserLocale(typeof navigator !== 'undefined' ? navigator.language : 'zh-CN')
  );
  const [darkMode, setDarkMode] = useState<boolean>(false);

  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  const [activeTab, setActiveTab] = useState<ConsoleTab>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [applications, setApplications] = useState<OAuthApplication[]>([]);
  const [connectors, setConnectors] = useState<SocialConnector[]>([]);
  const [authPolicy, setAuthPolicy] = useState<AuthPolicyConfig>(DEFAULT_AUTH_POLICY);
  const [identityUsers, setIdentityUsers] = useState<IdentityUser[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookSubscription[]>([]);
  const [webhookLogs, setWebhookLogs] = useState<WebhookDeliveryLog[]>([]);
  const [counts, setCounts] = useState({ applications: 0, enabledConnectors: 0, totalConnectors: 0 });
  const [jwksKid, setJwksKid] = useState('');
  const [signingKeyStatus, setSigningKeyStatus] = useState<SigningKeyStatus | null>(null);
  const [cacheStats, setCacheStats] = useState({ mode: 'redis', redisKeys: 0, sqlFallbackKeys: 0 });
  const [selectedLabClientId, setSelectedLabClientId] = useState('wimotek_erp_portal');
  const [portalTheme, setPortalTheme] = useState<LoginThemeConfig>(DEFAULT_LOGIN_THEME);
  const [latestTrace, setLatestTrace] = useState<OidcFlowTrace | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [busyAuthProvider, setBusyAuthProvider] = useState<string | null>(null);

  const t = TRANSLATIONS[locale];

  // Sync Tailwind v4 `.dark` class on <html>
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  const fetchProtectedData = useCallback(async (token: string) => {
    const headers = { Authorization: `Bearer ${token}` };
    const [ovRes, appsRes, connRes, usersRes, policyRes] = await Promise.all([
      fetch('/api/system/overview', { headers }),
      fetch('/api/applications', { headers }),
      fetch('/api/connectors', { headers }),
      fetch('/api/users', { headers }),
      fetch('/api/security/policy', { headers }),
    ]);

    if (ovRes.ok) {
      const ov = await ovRes.json();
      setConfig(ov.config);
      setCounts(ov.counts);
      setJwksKid(ov.jwksKid);
      if (ov.signingKeyStatus) setSigningKeyStatus(ov.signingKeyStatus);
      setCacheStats(ov.cacheStats);
      if (ov.authPolicy) setAuthPolicy(ov.authPolicy);
    }
    if (appsRes.ok) {
      const data = await appsRes.json();
      setApplications(data.applications || []);
      if (data.applications?.[0]?.clientId) {
        setSelectedLabClientId((prev) => prev || data.applications[0].clientId);
      }
    }
    if (connRes.ok) {
      const data = await connRes.json();
      setConnectors(data.connectors || []);
    }
    if (usersRes.ok) {
      const data = await usersRes.json();
      setIdentityUsers(data.users || []);
      setWebhooks(data.webhooks || []);
      setWebhookLogs(data.webhookLogs || []);
    }
    if (policyRes.ok) {
      const data = await policyRes.json();
      if (data.policy) setAuthPolicy(data.policy);
    }
  }, []);

  // Initial boot: inspect setup status from Go backend
  useEffect(() => {
    let mounted = true;
    async function boot() {
      try {
        setBootError(null);
        const res = await fetch('/api/setup/status');
        if (!res.ok) {
          throw new Error(`Setup status returned HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!mounted) return;

        const normalizedConfig: SystemConfig = data.config ?? {
          initialized: Boolean(data.initialized),
          dbDriver: data.db_driver === 'mysql' ? 'mysql' : 'sqlite3',
          dbDsn: data.db_dsn || '/data/wimotek_oauth.db',
          sqliteWalEnabled: true,
          sqliteBusyTimeoutMs: 5000,
          sqliteMaxWriteConns: 1,
          redisEnabled: Boolean(data.redis_enabled),
          redisAddr: data.redis_addr || '',
          redisSimulatedDown: false,
          activeCacheMode: data.redis_enabled ? 'redis' : 'sql_fallback',
          issuerUrl: data.issuer_url || window.location.origin,
          adminEmail: data.admin_email || '',
          tlsSource: data.tls_cert_source || '/data/certs/selfsigned.crt',
        };

        setConfig(normalizedConfig);
        setConnectors(Array.isArray(data.connectors) ? data.connectors : []);
        if (data.authPolicy) setAuthPolicy(data.authPolicy);
        setCacheStats(data.cacheStats || { mode: normalizedConfig.activeCacheMode, redisKeys: 0, sqlFallbackKeys: 0 });

        const params = new URLSearchParams(window.location.search);
        const queryClientId = (params.get('client_id') || '').trim();
        if (queryClientId) {
          setSelectedLabClientId(queryClientId);
        }
        try {
          const themeRes = await fetch(
            `/api/public/theme${queryClientId ? `?client_id=${encodeURIComponent(queryClientId)}` : ''}`
          );
          if (themeRes.ok && mounted) {
            const themeData = await themeRes.json();
            if (themeData.theme) setPortalTheme(normalizeLoginTheme(themeData.theme));
          }
        } catch {
          // keep default login theme if public theme lookup fails
        }
      } catch (err) {
        if (mounted) {
          setBootError(err instanceof Error ? err.message : 'Unable to reach wimotek/Oauth backend API');
        }
      } finally {
        if (mounted) setBootLoading(false);
      }
    }
    boot();
    return () => {
      mounted = false;
    };
  }, []);

  async function handleCompleteSetup(payload: {
    dbDriver: DbDriver;
    dbDsn: string;
    redisEnabled: boolean;
    redisAddr: string;
    issuerUrl: string;
    adminEmail: string;
    adminPassword: string;
  }) {
    const res = await fetch('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Setup failed');
    }
    setConfig(data.config);
    setUser(data.user);
    setSessionToken(data.sessionToken);
    await fetchProtectedData(data.sessionToken);
  }

  async function handlePasswordSignIn(email: string, password: string) {
    setAuthError(null);
    setBusyAuthProvider('local_password');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.message || 'Authentication failed');
        return;
      }
      setUser(data.user);
      setSessionToken(data.sessionToken);
      await fetchProtectedData(data.sessionToken);
    } finally {
      setBusyAuthProvider(null);
    }
  }

  async function handleSocialSignIn(provider: string) {
    setAuthError(`Configure the ${provider} connector credentials in Social Connectors to redirect users to the upstream IdP.`);
  }

  async function handleSimulateCacheFailover(simulatedDown: boolean) {
    if (!sessionToken) return;
    const res = await fetch('/api/system/cache-sim', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ simulatedDown }),
    });
    if (res.ok) {
      const data = await res.json();
      setConfig(data.config);
      setCacheStats(data.cacheStats);
    }
  }

  async function handleRotateSigningKey(mode: 'graceful' | 'emergency', graceMinutes = 120) {
    if (!sessionToken) return null;
    const res = await fetch('/api/security/signing-key/rotate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ mode, graceMinutes }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Key rotation failed');
    }
    if (data.jwksKid) setJwksKid(data.jwksKid);
    if (data.signingKeyStatus) setSigningKeyStatus(data.signingKeyStatus);
    return data as { ok: boolean; mode: 'graceful' | 'emergency'; previousKid: string; jwksKid: string; signingKeyStatus: SigningKeyStatus };
  }

  async function handlePurgeRetiringKeys() {
    if (!sessionToken) return;
    const res = await fetch('/api/security/signing-key/purge-retiring', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.jwksKid) setJwksKid(data.jwksKid);
      if (data.signingKeyStatus) setSigningKeyStatus(data.signingKeyStatus);
    }
  }

  async function handleCreateApp(payload: { name: string; description: string; redirectUris: string }) {
    if (!sessionToken) return;
    const res = await fetch('/api/applications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Failed to create application');
    }
    await fetchProtectedData(sessionToken);
  }

  async function handleDeleteApp(id: string) {
    if (!sessionToken) return;
    await fetch(`/api/applications/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    await fetchProtectedData(sessionToken);
  }

  async function handleSaveAppTheme(clientId: string, theme: LoginThemeConfig) {
    if (!sessionToken) return;
    const res = await fetch(`/api/applications/${encodeURIComponent(clientId)}/theme`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(theme),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Failed to save login theme');
    }
    const savedTheme = normalizeLoginTheme(data.theme || theme);
    setApplications((prev) =>
      prev.map((app) => (app.clientId === clientId || app.id === clientId ? { ...app, loginTheme: savedTheme } : app))
    );
    if (clientId === selectedLabClientId) {
      setPortalTheme(savedTheme);
    }
  }

  async function handleUpdateConnector(
    id: string,
    payload: {
      enabled?: boolean;
      clientId?: string;
      clientSecret?: string;
      extra?: Record<string, string>;
    }
  ) {
    if (!sessionToken) return;
    const res = await fetch(`/api/connectors/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      await fetchProtectedData(sessionToken);
    }
  }

  async function handleAddCustomConnector(payload: {
    displayName: string;
    clientId: string;
    clientSecret: string;
    issuerUrl: string;
  }) {
    if (!sessionToken) return;
    const res = await fetch('/api/connectors', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      await fetchProtectedData(sessionToken);
    }
  }

  async function handleReorderConnectors(orderedIds: string[]) {
    setConnectors((prev) => reorderConnectors(prev, orderedIds));
    if (!sessionToken) return;
    const res = await fetch('/api/connectors/reorder', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ orderedIds }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.connectors) setConnectors(data.connectors);
    }
  }

  async function handleRerunWizard() {
    if (!sessionToken) return;
    await fetch('/api/setup/reset', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    setConfig((prev) => (prev ? { ...prev, initialized: false } : prev));
    setSessionToken(null);
    setUser(null);
  }

  async function handleSimulateJit(payload: {
    email: string;
    displayName: string;
    provider: IdentityProviderType;
    emailVerified: boolean;
  }): Promise<{ action: string; user: IdentityUser } | null> {
    if (!sessionToken) return null;
    const res = await fetch('/api/users/jit-simulate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.users) setIdentityUsers(data.users);
    return { action: data.action, user: data.user };
  }

  async function handleToggleUserStatus(userId: string, nextStatus: 'active' | 'banned') {
    if (!sessionToken) return;
    const res = await fetch(`/api/users/${userId}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ status: nextStatus }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.webhookLogs) setWebhookLogs(data.webhookLogs);
      await fetchProtectedData(sessionToken);
    }
  }

  async function handleCreateWebhook(payload: { name: string; targetUrl: string; signingSecret: string }) {
    if (!sessionToken) return;
    const res = await fetch('/api/webhooks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || 'Failed to create webhook');
    }
    await fetchProtectedData(sessionToken);
  }

  async function handleDeleteWebhook(id: string) {
    if (!sessionToken) return;
    await fetch(`/api/webhooks/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    await fetchProtectedData(sessionToken);
  }

  async function handleSavePolicy(next: AuthPolicyConfig) {
    if (!sessionToken) return;
    const res = await fetch('/api/security/policy', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(next),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.policy) setAuthPolicy(data.policy);
    }
  }

  function handleAuthCompleted(result: { user: AuthUser; sessionToken: string; trace: OidcFlowTrace }) {
    setLatestTrace(result.trace);
    if (!sessionToken) {
      setUser(result.user);
      setSessionToken(result.sessionToken);
      void fetchProtectedData(result.sessionToken);
    } else {
      void fetchProtectedData(sessionToken);
    }
  }

  if (bootLoading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-[#0B0F19] flex items-center justify-center">
        <div className="text-sm text-slate-500 dark:text-slate-400 font-mono">
          Initializing wimotek/Oauth...
        </div>
      </div>
    );
  }

  if (bootError || !config) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-[#0B0F19] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 text-center">
          <div className="font-display text-base font-bold text-slate-900 dark:text-white">
            wimotek/Oauth
          </div>
          <p className="text-xs text-red-600 dark:text-red-400 font-mono">
            {bootError || 'Backend API did not return a valid system configuration.'}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  // Screen 1: First-Run Setup Wizard
  if (!config.initialized) {
    return (
      <SetupWizard
        locale={locale}
        onLocaleChange={setLocale}
        darkMode={darkMode}
        onToggleDark={() => setDarkMode((v) => !v)}
        initialConfig={config}
        onComplete={handleCompleteSetup}
      />
    );
  }

  // Screen 2: Hosted Sign-In Portal (when initialized but signed out)
  if (!sessionToken || !user) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-[#0B0F19] text-slate-900 dark:text-slate-100 flex flex-col">
        <header className="w-full border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] px-6 py-3.5">
          <div className="max-w-5xl mx-auto flex items-center justify-between gap-6">
            <div className="flex items-center gap-2.5 shrink-0">
              <BrandMark className="w-7 h-7" />
              <span className="font-display text-base font-bold tracking-tight whitespace-nowrap">
                wimotek/Oauth
              </span>
            </div>

            <div className="flex items-center gap-3">
              <label className="sr-only" htmlFor="login-locale-select">Language</label>
              <select
                id="login-locale-select"
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
                className="text-xs font-medium px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                {SUPPORTED_LOCALES.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.nativeLabel}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => setDarkMode((v) => !v)}
                aria-label="Toggle color theme"
                className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </header>

        <main className="flex-1 flex items-center justify-center px-4 py-12">
          <HostedLoginCard
            locale={locale}
            connectors={connectors}
            authPolicy={authPolicy}
            theme={portalTheme}
            clientId={selectedLabClientId}
            onPasswordSignIn={handlePasswordSignIn}
            onSocialSignIn={handleSocialSignIn}
            onAuthCompleted={handleAuthCompleted}
            busyProvider={busyAuthProvider}
            errorMessage={authError}
          />
        </main>
      </div>
    );
  }

  // Screen 3: Authenticated Admin Console (Production — 7 Core Modules Only)
  const navItems: { id: ConsoleTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'overview', label: t.navOverview, icon: LayoutDashboard },
    { id: 'applications', label: t.navApplications, icon: AppWindow },
    { id: 'connectors', label: t.navConnectors, icon: Share2 },
    { id: 'users', label: t.navUsers, icon: Users },
    { id: 'security', label: t.navSecurity, icon: ShieldCheck },
    { id: 'login_lab', label: t.navLoginLab, icon: Fingerprint },
    { id: 'sdks', label: t.navSdks, icon: BookOpen },
  ];

  const activeNav = navItems.find((n) => n.id === activeTab) || navItems[0];

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0B0F19] text-slate-900 dark:text-slate-100 flex">
      {/* Desktop Sidebar (256px) */}
      <aside className="hidden lg:flex lg:flex-col w-64 shrink-0 sticky top-0 h-screen border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]">
        <div className="h-14 px-5 flex items-center gap-2.5 border-b border-slate-200 dark:border-slate-800">
          <BrandMark className="w-7 h-7" />
          <span className="font-display text-base font-bold tracking-tight whitespace-nowrap">
            wimotek/Oauth
          </span>
        </div>

        <nav aria-label="Console navigation" className="flex-1 p-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.id === activeTab;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full min-h-[40px] px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2.5 transition-colors text-left ${
                  active
                    ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100/80 dark:hover:bg-slate-800/50 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
          <div className="text-xs min-w-0">
            <div className="font-medium text-slate-900 dark:text-white truncate">{user.name}</div>
            <div className="text-slate-500 dark:text-slate-400 truncate font-mono">{user.email}</div>
          </div>
          <button
            type="button"
            onClick={() => {
              setSessionToken(null);
              setUser(null);
            }}
            className="w-full min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center justify-center gap-1.5 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>{t.signOut}</span>
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div className="fixed inset-0 bg-slate-900/50" onClick={() => setMobileMenuOpen(false)} />
          <div className="relative z-50 w-64 max-w-[80vw] bg-white dark:bg-[#111827] border-r border-slate-200 dark:border-slate-800 flex flex-col">
            <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <BrandMark className="w-6 h-6" />
                <span className="font-display text-sm font-bold">wimotek/Oauth</span>
              </div>
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = item.id === activeTab;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full min-h-[44px] px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2.5 text-left ${
                      active
                        ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300'
                        : 'text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Contextual Top Bar */}
        <header className="h-14 px-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] flex items-center justify-between gap-3 sticky top-0 z-20">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              aria-label="Open navigation menu"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ml-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-xs sm:text-sm min-w-0">
              <span className="text-slate-400 dark:text-slate-500 hidden sm:inline whitespace-nowrap">wimotek/Oauth</span>
              <span className="text-slate-300 dark:text-slate-700 hidden sm:inline">/</span>
              <span className="font-medium text-slate-900 dark:text-white truncate">{activeNav.label}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <label className="sr-only" htmlFor="console-locale-select">Language</label>
            <select
              id="console-locale-select"
              value={locale}
              onChange={(e) => setLocale(e.target.value as Locale)}
              className="text-xs font-medium px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
            >
              {SUPPORTED_LOCALES.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.nativeLabel}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => setDarkMode((v) => !v)}
              aria-label="Toggle color theme"
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </header>

        {/* Viewport Content */}
        <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {activeTab === 'overview' && (
            <OverviewView
              locale={locale}
              config={config}
              counts={counts}
              jwksKid={jwksKid}
              signingKeyStatus={signingKeyStatus}
              cacheStats={cacheStats}
              onSimulateCacheFailover={handleSimulateCacheFailover}
              onRotateSigningKey={handleRotateSigningKey}
              onPurgeRetiringKeys={handlePurgeRetiringKeys}
              onRerunWizard={handleRerunWizard}
            />
          )}

          {activeTab === 'applications' && (
            <ApplicationsView
              locale={locale}
              applications={applications}
              onCreateApp={handleCreateApp}
              onDeleteApp={handleDeleteApp}
              onTestAppFlow={(clientId) => {
                setSelectedLabClientId(clientId);
                setActiveTab('login_lab');
              }}
            />
          )}

          {activeTab === 'connectors' && (
            <ConnectorsView
              locale={locale}
              connectors={connectors}
              onUpdateConnector={handleUpdateConnector}
              onAddCustomConnector={handleAddCustomConnector}
              onReorderConnectors={handleReorderConnectors}
            />
          )}

          {activeTab === 'users' && (
            <IdentityDirectoryView
              locale={locale}
              users={identityUsers}
              webhooks={webhooks}
              webhookLogs={webhookLogs}
              jitAutoLinkEnabled={authPolicy.jitVerifiedEmailAutoLink}
              onSimulateJit={handleSimulateJit}
              onToggleUserStatus={handleToggleUserStatus}
              onCreateWebhook={handleCreateWebhook}
              onDeleteWebhook={handleDeleteWebhook}
            />
          )}

          {activeTab === 'security' && (
            <SecurityPolicyView
              locale={locale}
              policy={authPolicy}
              sessionToken={sessionToken}
              onSavePolicy={handleSavePolicy}
            />
          )}

          {activeTab === 'login_lab' && (
            <LoginLabView
              locale={locale}
              issuerUrl={config.issuerUrl}
              connectors={connectors}
              applications={applications}
              authPolicy={authPolicy}
              selectedClientId={selectedLabClientId}
              onSelectClientId={setSelectedLabClientId}
              onSaveTheme={handleSaveAppTheme}
              onPasswordSignIn={handlePasswordSignIn}
              onSocialSignIn={handleSocialSignIn}
              onAuthCompleted={handleAuthCompleted}
              latestTrace={latestTrace}
            />
          )}

          {activeTab === 'sdks' && (
            <SdkDocsView
              locale={locale}
              issuerUrl={config.issuerUrl}
              applications={applications}
            />
          )}
        </main>
      </div>
    </div>
  );
}
