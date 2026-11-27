import React, { useCallback, useEffect, useState } from 'react';
import {
  ShieldCheck,
  LayoutDashboard,
  FilePlus2,
  ListChecks,
  Shield,
  Terminal,
  ScrollText,
  LogOut,
  Globe,
  Menu,
  X,
  Archive,
  Users,
  UserCircle2,
  BellRing,
  BookOpen,
  CloudCog,
  KeyRound,
} from 'lucide-react';
import {
  api,
  type AuditRecord,
  type CacheStatus,
  type CertificateRecord,
  type OverviewData,
  type UserProfile,
} from './lib/api';
import { isRtlLocale, LOCALE_OPTIONS, LOCALES, type LocaleCode } from './lib/i18n';
import { downloadProjectBundle } from './lib/download';
import { AuthGate } from './components/AuthGate';
import { OverviewView } from './components/OverviewView';
import { IssueCertView } from './components/IssueCertView';
import { CertificatesView } from './components/CertificatesView';
import { AuditView, AutomationView, TrustView } from './components/TrustAndAutomationViews';
import { ProfileView, UsersManagementView } from './components/UsersAndProfileView';
import { NotificationsView } from './components/NotificationsView';
import { HelpView } from './components/HelpView';
import { ManagedSSLView } from './components/ManagedSSLView';
import { OAuthSettingsView } from './components/OAuthSettingsView';

export type TabKey =
  | 'overview'
  | 'issue'
  | 'certificates'
  | 'managed'
  | 'trust'
  | 'notifications'
  | 'users'
  | 'oauth'
  | 'profile'
  | 'automation'
  | 'help'
  | 'audit';

const VALID_TABS: readonly TabKey[] = [
  'overview',
  'issue',
  'certificates',
  'managed',
  'trust',
  'notifications',
  'users',
  'oauth',
  'profile',
  'automation',
  'help',
  'audit',
];

function readTabFromHash(): TabKey {
  if (typeof window === 'undefined') return 'overview';
  const raw = window.location.hash.replace(/^#/, '').trim() as TabKey;
  return VALID_TABS.includes(raw) ? raw : 'overview';
}

export default function App() {
  const [locale, setLocale] = useState<LocaleCode>('en');
  const [token, setToken] = useState<string | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [justSignedOut, setJustSignedOut] = useState(false);
  const [username, setUsername] = useState<string>('admin');
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [activeTab, setActiveTabState] = useState<TabKey>(() => readTabFromHash());
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const setActiveTab = useCallback((next: TabKey) => {
    setActiveTabState(next);
    if (typeof window !== 'undefined') {
      const targetHash = `#${next}`;
      if (window.location.hash !== targetHash) {
        window.history.replaceState(null, '', targetHash);
      }
    }
  }, []);

  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null);
  const [recentAudits, setRecentAudits] = useState<AuditRecord[]>([]);
  const [certificates, setCertificates] = useState<CertificateRecord[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [downloadingBundle, setDownloadingBundle] = useState(false);

  const handleDownloadBundle = async () => {
    if (downloadingBundle) return;
    setDownloadingBundle(true);
    try {
      await downloadProjectBundle('wimotek-pki-suite.zip');
    } catch (err) {
      console.error('Failed to download project bundle:', err);
    } finally {
      setDownloadingBundle(false);
    }
  };

  const t = LOCALES[locale];

  // Sync HTML lang and dir (LTR / RTL for Arabic) whenever locale changes
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = isRtlLocale(locale) ? 'rtl' : 'ltr';
  }, [locale]);

  // Restore authenticated session from HttpOnly cookie on initial load / page refresh
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await api.getSession();
        if (!active) return;
        if (res.authenticated && res.token && res.username) {
          api.setToken(res.token);
          setToken(res.token);
          setUsername(res.username);
          setPreviewMode(Boolean(res.preview_mode));
          if (res.user) {
            setCurrentUser(res.user);
          }
        }
      } catch {
        // Not authenticated or server unreachable; show AuthGate
      } finally {
        if (active) setCheckingSession(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Sync active tab when user navigates browser hash
  useEffect(() => {
    const onHashChange = () => setActiveTabState(readTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const refreshData = useCallback(async () => {
    if (!api.getToken()) return;
    setLoadingData(true);
    try {
      const [ovRes, certRes] = await Promise.all([api.getOverview(), api.listCertificates()]);
      setOverview(ovRes.overview);
      setCacheStatus(ovRes.cache);
      setRecentAudits(ovRes.recent_audits || []);
      if (ovRes.current_user) {
        setCurrentUser(ovRes.current_user);
      }
      setCertificates(certRes.certificates || []);
    } catch (err) {
      if ((err as Error & { status?: number })?.status === 401) {
        api.setToken(null);
        setToken(null);
      }
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    if (token) {
      refreshData();
    }
  }, [token, refreshData]);

  const handleAuthenticated = (
    newToken: string,
    user: string,
    isPreview: boolean,
    profile?: UserProfile
  ) => {
    api.setToken(newToken);
    setToken(newToken);
    setJustSignedOut(false);
    setUsername(user);
    setPreviewMode(isPreview);
    if (profile) {
      setCurrentUser(profile);
    }
    const desired = readTabFromHash();
    setActiveTab(desired);
  };

  const handleSignOut = () => {
    api.logout().catch(() => {});
    api.setToken(null);
    setToken(null);
    setJustSignedOut(true);
    setCurrentUser(null);
    setOverview(null);
    setCertificates([]);
  };

  if (checkingSession) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
        <div className="flex items-center gap-3 text-slate-600 text-sm font-medium">
          <ShieldCheck className="w-5 h-5 text-teal-700 animate-pulse" aria-hidden="true" />
          <span>{t.app.name}</span>
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <AuthGate
        t={t}
        locale={locale}
        justSignedOut={justSignedOut}
        onLocaleChange={setLocale}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  const isAdmin = !currentUser || currentUser.role === 'admin';

  const navItems: Array<{ key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { key: 'overview', label: t.nav.overview, icon: LayoutDashboard },
    { key: 'issue', label: t.nav.issue, icon: FilePlus2 },
    { key: 'certificates', label: t.nav.certificates, icon: ListChecks },
    { key: 'managed', label: t.nav.managed, icon: CloudCog },
    { key: 'trust', label: t.nav.trust, icon: Shield },
    { key: 'notifications', label: t.nav.notifications, icon: BellRing },
    { key: 'automation', label: t.nav.automation, icon: Terminal },
    ...(isAdmin
      ? [{ key: 'users' as TabKey, label: t.nav.users, icon: Users }]
      : []),
    { key: 'oauth', label: t.nav.oauth, icon: KeyRound },
    { key: 'profile', label: t.nav.profile, icon: UserCircle2 },
    { key: 'help', label: t.nav.help, icon: BookOpen },
    { key: 'audit', label: t.nav.audit, icon: ScrollText },
  ];

  const activeNavLabel = navItems.find((n) => n.key === activeTab)?.label || t.nav.overview;
  const quotaText = currentUser
    ? currentUser.cert_quota < 0
      ? `${currentUser.active_certs ?? 0}/∞`
      : `${currentUser.active_certs ?? 0}/${currentUser.cert_quota}`
    : '';

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex">
      {/* Desktop Sidebar (260px) */}
      <aside className="hidden lg:flex lg:w-[260px] lg:shrink-0 lg:sticky lg:top-0 lg:h-screen flex-col bg-[#0F172A] text-slate-200 border-e border-slate-800">
        <div className="h-16 px-6 flex items-center gap-2.5 border-b border-slate-800">
          <ShieldCheck className="w-5 h-5 text-teal-400 shrink-0" aria-hidden="true" />
          <span className="font-display text-base font-bold tracking-tight text-white whitespace-nowrap">
            {t.app.name}
          </span>
        </div>

        <nav aria-label="Primary Navigation" className="flex-1 p-4 space-y-1 overflow-y-auto">
          {navItems.map(({ key, label, icon: Icon }) => {
            const active = activeTab === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setActiveTab(key)}
                aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer text-start ${
                  active
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-teal-400' : 'text-slate-400'}`} />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800 space-y-2.5 text-xs">
          <div className="px-3 space-y-0.5">
            <div className="text-slate-200 font-medium truncate">
              {username} · {(currentUser?.role || 'admin').toUpperCase()}
            </div>
            <div className="text-slate-400 truncate font-mono text-[11px]">
              {quotaText ? `Quota ${quotaText} · ` : ''}
              {overview?.db_driver?.toUpperCase() || 'SQLITE'}
            </div>
          </div>
          {previewMode && (
            <>
              <a
                href="/cli"
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-teal-900/50 text-teal-200 hover:bg-teal-900/80 hover:text-white transition-colors"
              >
                <Terminal className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate">wimotek-cli Web UI</span>
              </a>
              <button
                type="button"
                disabled={downloadingBundle}
                onClick={handleDownloadBundle}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-slate-800/80 text-teal-300 hover:bg-slate-800 hover:text-teal-200 disabled:opacity-60 transition-colors cursor-pointer text-start"
              >
                <Archive className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{downloadingBundle ? '...' : t.auth.downloadBundle}</span>
              </button>
            </>
          )}
          <button
            type="button"
            onClick={handleSignOut}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-slate-300 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
          >
            <LogOut className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{t.nav.signOut}</span>
          </button>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex bg-slate-900/50">
          <div className="w-72 max-w-[85vw] bg-[#0F172A] text-slate-200 flex flex-col h-full">
            <div className="h-14 px-5 flex items-center justify-between border-b border-slate-800">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-teal-400" aria-hidden="true" />
                <span className="font-display font-bold text-white">{t.app.name}</span>
              </div>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close navigation"
                className="p-2 text-slate-300 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
              {navItems.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setActiveTab(key);
                    setMobileNavOpen(false);
                  }}
                  className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium text-start ${
                    activeTab === key ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800/60'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </nav>
            <div className="p-4 border-t border-slate-800 space-y-2">
              {previewMode && (
                <>
                  <a
                    href="/cli"
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-teal-900/50 text-xs text-teal-200 hover:bg-teal-900/80"
                  >
                    <Terminal className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">wimotek-cli Web UI</span>
                  </a>
                  <button
                    type="button"
                    disabled={downloadingBundle}
                    onClick={handleDownloadBundle}
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-slate-800/80 text-xs text-teal-300 hover:bg-slate-800 disabled:opacity-60 cursor-pointer text-start"
                  >
                    <Archive className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{downloadingBundle ? '...' : t.auth.downloadBundle}</span>
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-300 hover:text-white"
              >
                <LogOut className="w-4 h-4" />
                <span>{t.nav.signOut}</span>
              </button>
            </div>
          </div>
          <div className="flex-1" onClick={() => setMobileNavOpen(false)} />
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Clean Contextual Top Header */}
        <header className="h-16 bg-white border-b border-slate-200 px-5 lg:px-8 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation"
              className="lg:hidden p-2 -ms-2 rounded-lg text-slate-600 hover:bg-slate-100"
            >
              <Menu className="w-5 h-5" />
            </button>
            <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-400 hidden sm:inline whitespace-nowrap">{t.app.name}</span>
              <span className="text-slate-300 hidden sm:inline" aria-hidden="true">/</span>
              <span className="font-display font-semibold text-slate-900 truncate">{activeNavLabel}</span>
            </nav>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-1.5">
              <Globe className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
              <label htmlFor="header-lang" className="sr-only">
                Language
              </label>
              <select
                id="header-lang"
                value={locale}
                onChange={(e) => setLocale(e.target.value as LocaleCode)}
                className="bg-white text-slate-700 text-xs font-medium rounded-lg px-2.5 py-1.5 border border-slate-300 focus:border-teal-600 focus:outline-none"
              >
                {LOCALE_OPTIONS.map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {activeTab !== 'issue' && (
              <button
                type="button"
                onClick={() => setActiveTab('issue')}
                className="px-4 py-2 rounded-lg bg-[#0F766E] hover:bg-[#115E59] text-white text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {t.overview.quickIssue}
              </button>
            )}
          </div>
        </header>

        {/* Main Viewport */}
        <main className="flex-1 p-5 lg:p-8 max-w-[1360px] w-full mx-auto">
          {activeTab === 'overview' && (
            <OverviewView
              t={t}
              overview={overview}
              cache={cacheStatus}
              recentAudits={recentAudits}
              loading={loadingData}
              onNavigate={setActiveTab}
            />
          )}
          {activeTab === 'issue' && (
            <IssueCertView
              t={t}
              currentUser={currentUser}
              onIssued={refreshData}
              onOpenProfile={() => setActiveTab('profile')}
            />
          )}
          {activeTab === 'certificates' && (
            <CertificatesView
              t={t}
              certificates={certificates}
              loading={loadingData}
              onRefresh={refreshData}
              onOpenIssue={() => setActiveTab('issue')}
            />
          )}
          {activeTab === 'managed' && (
            <ManagedSSLView t={t} currentUser={currentUser} />
          )}
          {activeTab === 'trust' && <TrustView t={t} overview={overview} />}
          {activeTab === 'notifications' && (
            <NotificationsView t={t} overview={overview} currentUser={currentUser} />
          )}
          {activeTab === 'users' && isAdmin && (
            <UsersManagementView t={t} currentUsername={username} />
          )}
          {activeTab === 'oauth' && (
            <OAuthSettingsView
              t={t}
              user={currentUser}
              isAdmin={isAdmin}
              previewMode={previewMode}
              onUpdated={(updated) => setCurrentUser(updated)}
            />
          )}
          {activeTab === 'profile' && (
            <ProfileView
              t={t}
              user={currentUser}
              previewMode={previewMode}
              onUpdated={(updated) => setCurrentUser(updated)}
            />
          )}
          {activeTab === 'automation' && (
            <AutomationView t={t} overview={overview} currentUser={currentUser} />
          )}
          {activeTab === 'help' && (
            <HelpView
              t={t}
              overview={overview}
              currentUser={currentUser}
              onNavigate={setActiveTab}
            />
          )}
          {activeTab === 'audit' && <AuditView t={t} />}
        </main>
      </div>
    </div>
  );
}
