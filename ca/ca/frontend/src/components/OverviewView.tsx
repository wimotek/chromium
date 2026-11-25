import React from 'react';
import { Download, ArrowUpRight, Shield, Layers } from 'lucide-react';
import type { AuditRecord, CacheStatus, OverviewData } from '../lib/api';
import type { LocaleDict } from '../lib/i18n';
import { formatSerialColon, formatUnixUtc } from '../lib/pki-utils';
import { CopyButton } from './CopyButton';

import type { TabKey } from '../App';

interface OverviewViewProps {
  t: LocaleDict;
  overview: OverviewData | null;
  cache: CacheStatus | null;
  recentAudits: AuditRecord[];
  loading: boolean;
  onNavigate: (tab: TabKey) => void;
}

export const OverviewView: React.FC<OverviewViewProps> = ({
  t,
  overview,
  cache,
  recentAudits,
  loading,
  onNavigate,
}) => {
  if (loading || !overview) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-60 bg-white border border-slate-200 rounded-xl animate-pulse" />
          <div className="h-60 bg-white border border-slate-200 rounded-xl animate-pulse" />
        </div>
      </div>
    );
  }

  const cacheLabel =
    cache?.mode === 'redis_primary'
      ? 'Redis Primary'
      : cache?.mode === 'circuit_open_sql_fallback'
      ? 'Circuit Open · SQL Fallback'
      : 'SQL cache_kv';

  return (
    <div className="space-y-8">
      {/* 4-column KPI summary strip */}
      <section aria-label="PKI Summary Metrics" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1">
          <div className="text-xs font-medium text-slate-500 wrap-anywhere">{t.overview.metrics.activeCerts}</div>
          <div className="font-display text-3xl font-bold text-slate-900 tabular-nums">{overview.active_count}</div>
          <div className="text-xs text-emerald-700 font-medium">ECDSA P-256 · RFC 5280</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1">
          <div className="text-xs font-medium text-slate-500 wrap-anywhere">{t.overview.metrics.revokedCerts}</div>
          <div className="font-display text-3xl font-bold text-slate-900 tabular-nums">{overview.revoked_count}</div>
          <div className="text-xs text-slate-500">CRL v2 · OCSP Sync</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1">
          <div className="text-xs font-medium text-slate-500 wrap-anywhere">{t.overview.metrics.expiringSoon}</div>
          <div className="font-display text-3xl font-bold text-slate-900 tabular-nums">{overview.expiring_30d}</div>
          <div className={`text-xs font-medium ${overview.expiring_30d > 0 ? 'text-amber-700' : 'text-slate-500'}`}>
            {overview.expiring_30d > 0 ? 'Renewal recommended' : 'All renewals healthy'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1">
          <div className="text-xs font-medium text-slate-500 wrap-anywhere">{t.overview.metrics.cacheBackend}</div>
          <div className="font-display text-lg font-semibold text-slate-900 pt-1 wrap-anywhere">{cacheLabel}</div>
          <div className="text-xs text-slate-500 wrap-anywhere">
            {overview.db_driver.toUpperCase()} WAL · Double-Delete Ready
          </div>
        </div>
      </section>

      {/* Two-Tier CA Hierarchy Cards */}
      <section aria-labelledby="hierarchy-heading" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 id="hierarchy-heading" className="font-display text-lg font-semibold text-slate-900 wrap-anywhere">
            {t.overview.title}
          </h2>
          <div className="flex flex-wrap items-center gap-3 text-xs font-medium">
            <a
              href="/ca/root.crt"
              download
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>{t.overview.downloadRoot}</span>
            </a>
            <a
              href="/ca/chain.pem"
              download
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>{t.overview.downloadChain}</span>
            </a>
            <a
              href="/ca/crl.der"
              download
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>{t.overview.downloadCrl}</span>
            </a>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Root CA */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1 min-w-0">
                <div className="text-xs font-medium text-teal-700 flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>Tier 1 · PathLen 1</span>
                </div>
                <h3 className="font-display text-base font-semibold text-slate-900 wrap-anywhere">
                  {t.overview.rootCa}
                </h3>
              </div>
              <a
                href="/ca/root.crt"
                download
                className="text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap shrink-0"
              >
                .crt
              </a>
            </div>

            <dl className="divide-y divide-slate-100 text-xs">
              <div className="py-2.5 grid grid-cols-1 sm:grid-cols-3 gap-1 items-center">
                <dt className="text-slate-500">DN</dt>
                <dd className="sm:col-span-2 flex items-start justify-between gap-2 font-mono text-slate-900 wrap-anywhere">
                  <span>{overview.root_ca.subject_dn}</span>
                  <CopyButton value={overview.root_ca.subject_dn} copiedLabel={t.common.copied} compact />
                </dd>
              </div>
              <div className="py-2.5 grid grid-cols-1 sm:grid-cols-3 gap-1">
                <dt className="text-slate-500">{t.overview.algorithm}</dt>
                <dd className="sm:col-span-2 font-mono text-slate-900">{overview.root_ca.algorithm}</dd>
              </div>
              <div className="py-2.5 grid grid-cols-1 sm:grid-cols-3 gap-1 items-center">
                <dt className="text-slate-500">{t.overview.serial}</dt>
                <dd dir="ltr" className="sm:col-span-2 flex items-start justify-between gap-2 font-mono text-[11px] text-slate-800 wrap-anywhere text-start">
                  <span>{formatSerialColon(overview.root_ca.serial_hex)}</span>
                  <CopyButton value={overview.root_ca.serial_hex} copiedLabel={t.common.copied} compact />
                </dd>
              </div>
              <div className="py-2.5 grid grid-cols-1 sm:grid-cols-3 gap-1 items-center">
                <dt className="text-slate-500">{t.overview.fingerprint}</dt>
                <dd dir="ltr" className="sm:col-span-2 flex items-start justify-between gap-2 font-mono text-[11px] leading-relaxed text-slate-600 wrap-anywhere text-start">
                  <span>{overview.root_ca.fingerprint_sha256}</span>
                  <CopyButton value={overview.root_ca.fingerprint_sha256} copiedLabel={t.common.copied} compact />
                </dd>
              </div>
              <div className="py-2.5 grid grid-cols-1 sm:grid-cols-3 gap-1">
                <dt className="text-slate-500">{t.overview.validUntil}</dt>
                <dd dir="ltr" className="sm:col-span-2 font-mono text-slate-900 tabular-nums text-start">
                  {formatUnixUtc(overview.root_ca.not_after)}
                </dd>
              </div>
            </dl>
          </div>

          {/* Issuing CA */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1 min-w-0">
                <div className="text-xs font-medium text-slate-600 flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>Tier 2 · PathLen 0 · Active Signer</span>
                </div>
                <h3 className="font-display text-base font-semibold text-slate-900 wrap-anywhere">
                  {t.overview.issuingCa}
                </h3>
              </div>
              <a
                href="/ca/issuing.crt"
                download
                className="text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap shrink-0"
              >
                .crt
              </a>
            </div>

            <dl className="divide-y divide-slate-100 text-xs">
              <div className="py-2.5 grid grid-cols-1 sm:grid-cols-3 gap-1 items-center">
                <dt className="text-slate-500">DN</dt>
                <dd dir="ltr" className="sm:col-span-2 flex items-start justify-between gap-2 font-mono text-slate-900 wrap-anywhere text-start">
                  <span>{overview.issuing_ca.subject_dn}</span>
                  <CopyButton value={overview.issuing_ca.subject_dn} copiedLabel={t.common.copied} compact />
                </dd>
              </div>
              <div className="py-2.5 grid grid-cols-1 sm:grid-cols-3 gap-1">
                <dt className="text-slate-500">{t.overview.algorithm}</dt>
                <dd dir="ltr" className="sm:col-span-2 font-mono text-slate-900 text-start">{overview.issuing_ca.algorithm}</dd>
              </div>
              <div className="py-2.5 grid grid-cols-1 sm:grid-cols-3 gap-1 items-center">
                <dt className="text-slate-500">{t.overview.serial}</dt>
                <dd dir="ltr" className="sm:col-span-2 flex items-start justify-between gap-2 font-mono text-[11px] text-slate-800 wrap-anywhere text-start">
                  <span>{formatSerialColon(overview.issuing_ca.serial_hex)}</span>
                  <CopyButton value={overview.issuing_ca.serial_hex} copiedLabel={t.common.copied} compact />
                </dd>
              </div>
              <div className="py-2.5 grid grid-cols-1 sm:grid-cols-3 gap-1 items-center">
                <dt className="text-slate-500">{t.overview.fingerprint}</dt>
                <dd dir="ltr" className="sm:col-span-2 flex items-start justify-between gap-2 font-mono text-[11px] leading-relaxed text-slate-600 wrap-anywhere text-start">
                  <span>{overview.issuing_ca.fingerprint_sha256}</span>
                  <CopyButton value={overview.issuing_ca.fingerprint_sha256} copiedLabel={t.common.copied} compact />
                </dd>
              </div>
              <div className="py-2.5 grid grid-cols-1 sm:grid-cols-3 gap-1">
                <dt className="text-slate-500">{t.overview.validUntil}</dt>
                <dd dir="ltr" className="sm:col-span-2 font-mono text-slate-900 tabular-nums text-start">
                  {formatUnixUtc(overview.issuing_ca.not_after)}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      {/* Runtime Architecture + Recent Activity */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h3 className="font-display text-base font-semibold text-slate-900 wrap-anywhere">
            {t.overview.storageHeading}
          </h3>
          <dl className="divide-y divide-slate-100 text-xs">
            <div className="py-3 space-y-1">
              <dt className="text-slate-500">{t.overview.envMode}</dt>
              <dd dir="ltr" className="font-mono text-slate-900 wrap-anywhere text-start">
                Go 1.24 (CGO_ENABLED=0) · Non-Root UID 10001
              </dd>
            </div>
            <div className="py-3 space-y-1">
              <dt className="text-slate-500">{t.overview.dataDir}</dt>
              <dd dir="ltr" className="font-mono text-slate-900 wrap-anywhere text-start">
                {overview.data_dir || '/data'} ({overview.db_driver === 'mysql' ? 'MySQL 1213/1205 retry' : 'SQLite WriteDB=1 WAL / ReadDB'})
              </dd>
            </div>
            <div className="py-3 space-y-1">
              <dt className="text-slate-500">{t.overview.tlsMode}</dt>
              <dd dir="ltr" className="font-mono text-slate-900 wrap-anywhere text-start">
                {overview.tls_mode === 'mounted_ro'
                  ? `Mounted RO (${overview.certs_dir || '/certs'}:ro · hot-reload)`
                  : `Auto Self-Signed ECDSA P-256 (${overview.data_dir || '/data'}/tls)`}
              </dd>
            </div>
            <div className="py-3 space-y-1">
              <dt className="text-slate-500">{t.overview.cacheEngine}</dt>
              <dd dir="ltr" className="font-mono text-slate-900 wrap-anywhere text-start">
                {cacheLabel} · 15s Circuit Breaker · 10s Probe
              </dd>
            </div>
            <div className="py-3 space-y-1">
              <dt className="text-slate-500">{t.overview.crlEndpoint}</dt>
              <dd dir="ltr" className="flex items-center justify-between gap-2 font-mono text-teal-700 wrap-anywhere text-start">
                <span>{overview.crl_url}</span>
                <CopyButton value={overview.crl_url} copiedLabel={t.common.copied} compact />
              </dd>
            </div>
            <div className="py-3 space-y-1">
              <dt className="text-slate-500">{t.overview.ocspEndpoint}</dt>
              <dd dir="ltr" className="flex items-center justify-between gap-2 font-mono text-teal-700 wrap-anywhere text-start">
                <span>{overview.ocsp_url}</span>
                <CopyButton value={overview.ocsp_url} copiedLabel={t.common.copied} compact />
              </dd>
            </div>
          </dl>
        </div>

        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <h3 className="font-display text-base font-semibold text-slate-900 wrap-anywhere">
              {t.overview.recentActivity}
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('audit')}
              className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap cursor-pointer"
            >
              <span>{t.overview.viewAllAudit}</span>
              <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>

          {recentAudits.length === 0 ? (
            <p className="text-sm text-slate-500 py-6">{t.audit.empty}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-start">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pe-3 font-medium text-start">{t.audit.time}</th>
                    <th className="py-2 pe-3 font-medium text-start">{t.audit.action}</th>
                    <th className="py-2 pe-3 font-medium text-start">{t.audit.actor}</th>
                    <th className="py-2 font-medium text-start">{t.audit.target}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {recentAudits.map((row) => (
                    <tr key={row.id} className="hover:bg-slate-50/70">
                      <td className="py-2.5 pe-3 font-mono text-slate-500 whitespace-nowrap tabular-nums">
                        <span dir="ltr" className="inline-block">{formatUnixUtc(row.created_at)}</span>
                      </td>
                      <td className="py-2.5 pe-3 font-mono font-medium text-slate-900 whitespace-nowrap">
                        <span dir="ltr" className="inline-block">{row.action}</span>
                      </td>
                      <td className="py-2.5 pe-3 text-slate-700 wrap-anywhere">{row.actor}</td>
                      <td className="py-2.5 font-mono text-slate-600 wrap-anywhere">
                        {row.target_serial ? (
                          <span dir="ltr" className="inline-flex items-center gap-1">
                            <span>{row.target_serial.slice(0, 16)}…</span>
                            <CopyButton value={row.target_serial} copiedLabel={t.common.copied} compact />
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
