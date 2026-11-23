import React, { useState } from 'react';
import { ArrowRight, Play, RefreshCw } from 'lucide-react';
import { translate, type TranslationKeys } from '../i18n/translations';
import { apiRequest, formatBytes, formatTimeAgo } from '../lib/api';
import type { LanguageCode, OverviewSummary } from '../types/models';

interface OverviewViewProps {
  data: OverviewSummary | null;
  lang: LanguageCode;
  onRefresh: () => Promise<void>;
  onNavigate: (tab: string) => void;
}

export function OverviewView({ data, lang, onRefresh, onNavigate }: OverviewViewProps) {
  const t = (key: TranslationKeys) => translate(lang, key);
  const [syncingAll, setSyncingAll] = useState(false);

  const handleQuickSyncAll = async () => {
    setSyncingAll(true);
    try {
      await apiRequest('/api/dns/sync', { method: 'POST', body: JSON.stringify({}) });
      await onRefresh();
    } finally {
      setSyncingAll(false);
    }
  };

  if (!data) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-28 rounded-xl bg-slate-200/70 dark:bg-slate-800/70" />
          ))}
        </div>
        <div className="h-64 rounded-xl bg-slate-200/70 dark:bg-slate-800/70" />
      </div>
    );
  }

  const quotaRatio = Math.min(
    100,
    Math.round((data.auditStats.fileSizeBytes / Math.max(1, data.auditStats.maxSizeBytes)) * 100)
  );

  return (
    <div className="space-y-6">
      {/* Section Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t('overviewTitle')}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {t('overviewSubtitle')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {t('refresh')}
          </button>
          <button
            type="button"
            disabled={syncingAll}
            onClick={() => void handleQuickSyncAll()}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <Play className="w-3.5 h-3.5" />
            {t('quickSyncAll')}
          </button>
        </div>
      </div>

      {/* 4-column KPI strip (clean single-elevation hairline cards) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <button
          type="button"
          onClick={() => onNavigate('dns')}
          className="text-left p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
        >
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 truncate">
            {t('kpiDnsRules')}
          </div>
          <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-slate-900 dark:text-white">
            {data.dnsRules}
          </div>
          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {data.dnsProviders} providers
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('dns')}
          className="text-left p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
        >
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 truncate">
            {t('kpiIpTargets')}
          </div>
          <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-slate-900 dark:text-white">
            {data.totalIpv4Targets} <span className="text-slate-400 text-lg">/</span> {data.totalIpv6Targets}
          </div>
          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            IPv4 A · Multi-IPv6 AAAA
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('oci')}
          className="text-left p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
        >
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 truncate">
            {t('kpiOciSnipers')}
          </div>
          <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-slate-900 dark:text-white">
            {data.ociProfiles} <span className="text-slate-400 text-lg">/</span> {data.runningSnipers}
          </div>
          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {data.totalSniperAttempts} ARM attempts
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('clouds')}
          className="text-left p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
        >
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 truncate">
            {t('navClouds')}
          </div>
          <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-slate-900 dark:text-white">
            {data.cloudHosts} <span className="text-slate-400 text-lg">/</span>{' '}
            <span className={data.monitorsDown > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}>
              {data.monitorsUp}/{data.monitorsTotal}
            </span>
          </div>
          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            Hosts · Monitors Up{data.monitorsDown > 0 ? ` · ${data.monitorsDown} Down` : ''}
          </div>
        </button>
      </div>

      {/* Compact Secondary Status Strip: Cloud Hosts, Cron, Notifications, Baota TLS */}
      <div className="px-5 py-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs">
        <button
          type="button"
          onClick={() => onNavigate('clouds')}
          className="font-mono tabular-nums text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 whitespace-nowrap"
        >
          {t('navClouds')}: <strong className="text-slate-900 dark:text-white">{data.cloudHosts}</strong>
        </button>
        <button
          type="button"
          onClick={() => onNavigate('cron')}
          className="font-mono tabular-nums text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 whitespace-nowrap"
        >
          {t('navCron')}: <strong className="text-slate-900 dark:text-white">{data.activeCronJobs}</strong>
        </button>
        <button
          type="button"
          onClick={() => onNavigate('notifications')}
          className="font-mono tabular-nums text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 whitespace-nowrap"
        >
          {t('navNotify')}: <strong className="text-slate-900 dark:text-white">{data.notificationChannels}</strong>
        </button>
        <button
          type="button"
          onClick={() => onNavigate('security')}
          className="font-mono tabular-nums text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 whitespace-nowrap"
        >
          TLS:{' '}
          <strong
            className={
              data.tlsStatus?.httpsListening
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-slate-500 dark:text-slate-400'
            }
          >
            {data.tlsStatus?.httpsListening
              ? `${data.tlsStatus.source === 'mounted' ? '/certs:ro' : 'Self-Signed'} :${data.tlsStatus.httpsPort}`
              : 'HTTP Only'}
          </strong>
        </button>
      </div>

      {/* Audit Quota + Container Runtime 2-column split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Audit Storage Quota */}
        <div className="lg:col-span-6 p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">
                {t('auditStorageUsage')}
              </h2>
              <span className="font-mono text-xs tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap shrink-0">
                {formatBytes(data.auditStats.fileSizeBytes)} / {formatBytes(data.auditStats.maxSizeBytes)}
              </span>
            </div>

            <div className="w-full h-2.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  quotaRatio > 85 ? 'bg-red-600' : quotaRatio > 65 ? 'bg-amber-500' : 'bg-blue-600'
                }`}
                style={{ width: `${Math.max(2, quotaRatio)}%` }}
              />
            </div>

            <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              {t('auditAutoPruneNote')}
            </p>
          </div>

          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            <div>
              {data.auditStats.totalEntries} entries · {data.auditStats.pruneCount} auto-prunes
            </div>
            <button
              type="button"
              onClick={() => onNavigate('audit')}
              className="inline-flex items-center gap-1 font-sans font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
            >
              {t('viewAllLogs')}
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* System Runtime & TLS */}
        <div className="lg:col-span-6 p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">
                {t('containerRuntime')}
              </h2>
              <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                {data.containerInfo.nodeVersion} · {data.containerInfo.arch}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-slate-500 dark:text-slate-400">Hostname</div>
                <div className="mt-0.5 font-mono text-slate-800 dark:text-slate-200 truncate" title={data.containerInfo.hostname}>
                  {data.containerInfo.hostname}
                </div>
              </div>
              <div>
                <div className="text-slate-500 dark:text-slate-400">Data Volume</div>
                <div className="mt-0.5 font-mono text-slate-800 dark:text-slate-200 truncate" title={data.containerInfo.dataDir}>
                  {data.containerInfo.dataDir}
                </div>
              </div>
              <div>
                <div className="text-slate-500 dark:text-slate-400">HTTPS / TLS</div>
                <div className="mt-0.5 font-mono text-slate-800 dark:text-slate-200 truncate">
                  {data.tlsStatus?.httpsListening
                    ? `:${data.tlsStatus.httpsPort} (${data.tlsStatus.source === 'mounted' ? '/certs:ro' : 'Self-Signed'})`
                    : 'Disabled'}
                </div>
              </div>
              <div>
                <div className="text-slate-500 dark:text-slate-400">Uptime</div>
                <div className="mt-0.5 font-mono tabular-nums text-slate-800 dark:text-slate-200">
                  {Math.floor((data.containerInfo.uptimeSeconds || 0) / 3600)}h{' '}
                  {Math.floor(((data.containerInfo.uptimeSeconds || 0) % 3600) / 60)}m
                </div>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
            <span className="truncate font-mono">
              {data.tlsStatus?.subject || 'TLS / Security Policy'}
            </span>
            <button
              type="button"
              onClick={() => onNavigate('security')}
              className="inline-flex items-center gap-1 font-sans font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
            >
              {t('navSecurity')}
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Recent Audit Activity Table */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">
            {t('recentAuditActivity')}
          </h2>
          <button
            type="button"
            onClick={() => onNavigate('audit')}
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
          >
            {t('viewAllLogs')}
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                <th className="py-2.5 px-6 font-medium whitespace-nowrap">Time</th>
                <th className="py-2.5 px-4 font-medium whitespace-nowrap">Category</th>
                <th className="py-2.5 px-4 font-medium whitespace-nowrap">Action</th>
                <th className="py-2.5 px-4 font-medium whitespace-nowrap">Actor / IP</th>
                <th className="py-2.5 px-6 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70 text-xs">
              {data.recentLogs.map((entry) => (
                <tr key={entry.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="py-3 px-6 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {formatTimeAgo(entry.timestamp)}
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    {entry.category}
                  </td>
                  <td className="py-3 px-4 font-mono font-medium whitespace-nowrap">
                    <span
                      className={
                        entry.severity === 'error'
                          ? 'text-red-600 dark:text-red-400'
                          : entry.severity === 'warning'
                          ? 'text-amber-600 dark:text-amber-400'
                          : entry.severity === 'success'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-slate-800 dark:text-slate-200'
                      }
                    >
                      {entry.action}
                    </span>
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                    {entry.actor} · {entry.ip}
                  </td>
                  <td className="py-3 px-6 text-slate-600 dark:text-slate-300 max-w-md truncate" title={entry.details}>
                    {entry.details}
                  </td>
                </tr>
              ))}
              {data.recentLogs.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400">
                    {t('noData')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
