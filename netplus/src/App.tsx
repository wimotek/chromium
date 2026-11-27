/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Bell,
  Clock,
  Cpu,
  FileText,
  Globe,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Network,
  Server,
  Shield,
  Sun,
  X,
} from 'lucide-react';
import { AuthGate } from './components/AuthGate';
import { CloudHostsView } from './components/CloudHostsView';
import { AuditLogsView, CronJobsView } from './components/CronAndAuditViews';
import { DnsBatchView } from './components/DnsBatchView';
import { MonitorsView } from './components/MonitorsView';
import { NotificationsView } from './components/NotificationsView';
import { OciManagerView } from './components/OciManagerView';
import { OverviewView } from './components/OverviewView';
import { SecurityContainerView } from './components/SecurityContainerView';
import { ToastViewport } from './components/ToastViewport';
import { LANGUAGE_OPTIONS, translate, type TranslationKeys } from './i18n/translations';
import { apiRequest, setAuthToken, setOnUnauthorized } from './lib/api';
import type {
  AuthStatusResponse,
  CloudAccount,
  CloudHost,
  CronJob,
  DnsProvider,
  DnsSyncRule,
  LanguageCode,
  ManagedDnsRecord,
  ManagedDomain,
  MonitorTarget,
  NotificationChannel,
  OciProfile,
  OciSniperTask,
  OverviewSummary,
} from './types/models';

type NavTab =
  | 'overview'
  | 'dns'
  | 'monitors'
  | 'oci'
  | 'clouds'
  | 'notifications'
  | 'cron'
  | 'audit'
  | 'security';

function detectInitialLang(): LanguageCode {
  const nav = (navigator.language || 'zh-CN').toLowerCase();
  if (nav.startsWith('zh')) return 'zh-CN';
  if (nav.startsWith('ja')) return 'ja';
  if (nav.startsWith('de')) return 'de';
  if (nav.startsWith('es')) return 'es';
  return 'en';
}

export default function App() {
  const [lang, setLang] = useState<LanguageCode>(detectInitialLang);
  const [dark, setDark] = useState<boolean>(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  );
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [cloudSubTab, setCloudSubTab] = useState<'hosts' | 'accounts' | 'monitors'>('hosts');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navigateToCloudAccounts = useCallback(() => {
    setCloudSubTab('accounts');
    setActiveTab('clouds');
  }, []);

  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [currentUser, setCurrentUser] = useState<string | null>(null);

  const [overview, setOverview] = useState<OverviewSummary | null>(null);
  const [dnsProviders, setDnsProviders] = useState<DnsProvider[]>([]);
  const [dnsRules, setDnsRules] = useState<DnsSyncRule[]>([]);
  const [dnsRecords, setDnsRecords] = useState<ManagedDnsRecord[]>([]);
  const [managedDomains, setManagedDomains] = useState<ManagedDomain[]>([]);
  const [ociProfiles, setOciProfiles] = useState<OciProfile[]>([]);
  const [ociSnipers, setOciSnipers] = useState<OciSniperTask[]>([]);
  const [cloudAccounts, setCloudAccounts] = useState<CloudAccount[]>([]);
  const [cloudHosts, setCloudHosts] = useState<CloudHost[]>([]);
  const [monitors, setMonitors] = useState<MonitorTarget[]>([]);
  const [notificationChannels, setNotificationChannels] = useState<NotificationChannel[]>([]);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);

  const t = useCallback((key: TranslationKeys) => translate(lang, key), [lang]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const checkAuthStatus = useCallback(async () => {
    try {
      const status = await apiRequest<AuthStatusResponse>('/api/auth/status');
      setAuthStatus(status);
      if (status.authenticated && status.username) {
        setCurrentUser(status.username);
      } else {
        setCurrentUser(null);
      }
    } catch {
      setAuthStatus({
        envManagedAdmin: false,
        authenticated: false,
        security: {
          captchaDifficulty: 'high',
          powDifficulty: 3,
          requireSliderVerify: true,
          minFormDwellMs: 800,
        },
      });
    }
  }, []);

  useEffect(() => {
    setOnUnauthorized(() => {
      setCurrentUser(null);
      void checkAuthStatus();
    });
    void checkAuthStatus();
  }, [checkAuthStatus]);

  const loadWorkspaceData = useCallback(async () => {
    if (!currentUser) return;
    const [ov, provs, rules, recs, doms, profs, snipers, accounts, hosts, mons, chans, jobs] = await Promise.all([
      apiRequest<OverviewSummary>('/api/overview'),
      apiRequest<DnsProvider[]>('/api/dns/providers'),
      apiRequest<DnsSyncRule[]>('/api/dns/rules'),
      apiRequest<ManagedDnsRecord[]>('/api/dns/records'),
      apiRequest<ManagedDomain[]>('/api/dns/domains').catch(() => [] as ManagedDomain[]),
      apiRequest<OciProfile[]>('/api/oci/profiles'),
      apiRequest<OciSniperTask[]>('/api/oci/sniper'),
      apiRequest<CloudAccount[]>('/api/clouds/accounts'),
      apiRequest<CloudHost[]>('/api/clouds/hosts'),
      apiRequest<MonitorTarget[]>('/api/monitors'),
      apiRequest<NotificationChannel[]>('/api/notifications/channels'),
      apiRequest<CronJob[]>('/api/cron/jobs'),
    ]);
    setOverview(ov);
    setDnsProviders(provs);
    setDnsRules(rules);
    setDnsRecords(recs);
    setManagedDomains(doms);
    setOciProfiles(profs);
    setOciSnipers(snipers);
    setCloudAccounts(accounts);
    setCloudHosts(hosts);
    setMonitors(mons);
    setNotificationChannels(chans);
    setCronJobs(jobs);
  }, [currentUser]);

  useEffect(() => {
    if (currentUser) {
      void loadWorkspaceData();
    }
  }, [currentUser, loadWorkspaceData]);

  const handleLogout = async () => {
    let oidcLogoutUrl: string | undefined;
    try {
      const res = await apiRequest<{ ok: boolean; oidcLogoutUrl?: string }>('/api/auth/logout', {
        method: 'POST',
      });
      oidcLogoutUrl = res?.oidcLogoutUrl;
    } catch {
      // ignore
    }
    setAuthToken(null);
    setCurrentUser(null);
    setOverview(null);

    let inIframe = false;
    try {
      inIframe = window.self !== window.top;
    } catch {
      inIframe = true;
    }

    if (oidcLogoutUrl && !inIframe) {
      window.location.assign(oidcLogoutUrl);
      return;
    }

    if (authStatus?.wimotekOAuth?.enabled) {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('logged_out', '1');
        window.history.replaceState({}, '', url.toString());
      } catch {
        // ignore history error
      }
    }
    await checkAuthStatus();
  };

  if (!authStatus) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-slate-500 text-sm">
        {t('loading')}
      </div>
    );
  }

  if (!currentUser) {
    return (
      <>
        <ToastViewport />
        <AuthGate
          status={authStatus}
          lang={lang}
          onChangeLang={setLang}
          dark={dark}
          onToggleDark={() => setDark((d) => !d)}
          onAuthenticated={(user) => {
            setCurrentUser(user);
            setAuthStatus((prev) =>
              prev ? { ...prev, authenticated: true, username: user } : prev
            );
          }}
        />
      </>
    );
  }

  const navItems: Array<{ id: NavTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'overview', label: t('navOverview'), icon: LayoutDashboard },
    { id: 'clouds', label: t('navClouds'), icon: Server },
    { id: 'dns', label: t('navDns'), icon: Network },
    { id: 'monitors', label: t('navMonitors'), icon: Activity },
    { id: 'oci', label: t('navOci'), icon: Cpu },
    { id: 'notifications', label: t('navNotify'), icon: Bell },
    { id: 'cron', label: t('navCron'), icon: Clock },
    { id: 'audit', label: t('navAudit'), icon: FileText },
    { id: 'security', label: t('navSecurity'), icon: Shield },
  ];

  const activeNavItem = navItems.find((n) => n.id === activeTab) ?? navItems[0];

  const renderSidebarContent = () => (
    <div className="flex flex-col h-full">
      <div className="h-14 px-5 flex items-center justify-between border-b border-slate-200 dark:border-slate-800 shrink-0">
        <span className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap">
          {t('brandName')}
        </span>
        <button
          type="button"
          onClick={() => setMobileMenuOpen(false)}
          className="lg:hidden p-1.5 rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          aria-label={t('close')}
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="Primary navigation">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = item.id === activeTab;
          return (
            <button
              key={item.id}
              type="button"
              title={item.label}
              onClick={() => {
                setActiveTab(item.id);
                setMobileMenuOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left min-w-0 ${
                active
                  ? 'bg-blue-600/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/70 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Sidebar Footer: Multilingual & Dual-Theme Controls */}
      <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-3 shrink-0">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
          <select
            aria-label={t('language')}
            value={lang}
            onChange={(e) => setLang(e.target.value as LanguageCode)}
            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-600"
          >
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.code} value={opt.code} className="bg-white dark:bg-slate-900">
                {opt.native}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setDark((d) => !d)}
            title={dark ? t('themeLight') : t('themeDark')}
            aria-label={dark ? t('themeLight') : t('themeDark')}
            className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
          >
            {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400 pt-1">
          <span className="font-mono truncate" title={currentUser}>
            {currentUser}
          </span>
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:text-red-600 dark:hover:text-red-400 transition-colors whitespace-nowrap shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
            {t('signOut')}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <ToastViewport />
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 sticky top-0 h-screen">
        {renderSidebarContent()}
      </aside>

      {/* Mobile Drawer Overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/50"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-10 w-72 max-w-[85vw] bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 h-full">
            {renderSidebarContent()}
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Clean Contextual Top Bar */}
        <header className="h-14 px-4 sm:px-6 lg:px-8 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open menu"
              className="lg:hidden p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-400 dark:text-slate-500 hidden sm:inline whitespace-nowrap">
                {t('brandName')}
              </span>
              <span className="text-slate-300 dark:text-slate-700 hidden sm:inline" aria-hidden="true">
                /
              </span>
              <span className="font-semibold text-slate-900 dark:text-white truncate">
                {activeNavItem.label}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <span className="hidden sm:inline font-mono text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
              {currentUser}
            </span>
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              {t('signOut')}
            </button>
          </div>
        </header>

        {/* Viewport Workspace */}
        <main className="flex-1 w-full max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          {activeTab === 'overview' && (
            <OverviewView
              data={overview}
              lang={lang}
              onRefresh={loadWorkspaceData}
              onNavigate={(tab) => setActiveTab(tab as NavTab)}
            />
          )}
          {activeTab === 'dns' && (
            <DnsBatchView
              providers={dnsProviders}
              rules={dnsRules}
              records={dnsRecords}
              managedDomains={managedDomains}
              hosts={cloudHosts}
              lang={lang}
              onReload={loadWorkspaceData}
            />
          )}
          {activeTab === 'monitors' && (
            <MonitorsView
              monitors={monitors}
              notificationChannels={notificationChannels}
              lang={lang}
              onReload={loadWorkspaceData}
              onNavigateNotifications={() => setActiveTab('notifications')}
            />
          )}
          {activeTab === 'oci' && (
            <OciManagerView
              profiles={ociProfiles}
              tasks={ociSnipers}
              dnsRules={dnsRules}
              notificationChannels={notificationChannels}
              lang={lang}
              onReload={loadWorkspaceData}
              onNavigateNotifications={() => setActiveTab('notifications')}
              onNavigateCloudAccounts={navigateToCloudAccounts}
            />
          )}
          {activeTab === 'clouds' && (
            <CloudHostsView
              hosts={cloudHosts}
              cloudAccounts={cloudAccounts}
              dnsRules={dnsRules}
              dnsRecords={dnsRecords}
              dnsProviders={dnsProviders}
              ociProfiles={ociProfiles}
              monitors={monitors}
              lang={lang}
              activeSubTab={cloudSubTab}
              onSubTabChange={setCloudSubTab}
              onReload={loadWorkspaceData}
              onNavigateOci={() => setActiveTab('oci')}
              onNavigateDns={() => setActiveTab('dns')}
              onNavigateMonitors={() => setActiveTab('monitors')}
            />
          )}
          {activeTab === 'notifications' && (
            <NotificationsView
              channels={notificationChannels}
              lang={lang}
              onReload={loadWorkspaceData}
            />
          )}
          {activeTab === 'cron' && (
            <CronJobsView
              jobs={cronJobs}
              hosts={cloudHosts}
              dnsRules={dnsRules}
              lang={lang}
              onReload={loadWorkspaceData}
            />
          )}
          {activeTab === 'audit' && <AuditLogsView lang={lang} />}
          {activeTab === 'security' && (
            <SecurityContainerView
              lang={lang}
              currentUsername={currentUser}
              onUsernameChanged={(nextUser) => {
                setCurrentUser(nextUser);
                setAuthStatus((prev) => (prev ? { ...prev, username: nextUser } : prev));
              }}
              onRefreshOverview={loadWorkspaceData}
            />
          )}
        </main>
      </div>
    </div>
  );
}
