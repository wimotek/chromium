import React, { useMemo, useState } from 'react';
import { Search, X, Download, ShieldAlert, RefreshCw } from 'lucide-react';
import { api, type CertificateRecord } from '../lib/api';
import type { LocaleDict } from '../lib/i18n';
import {
  computeCertEffectiveStatus,
  isExpiringWithinDays,
  formatSerialColon,
  formatUnixUtc,
  parseJsonStringArray,
} from '../lib/pki-utils';
import { CopyButton } from './CopyButton';
import { triggerBlobDownload } from '../lib/download';
import { FloatingToast } from './Toast';

interface CertificatesViewProps {
  t: LocaleDict;
  certificates: CertificateRecord[];
  loading: boolean;
  onRefresh: () => void;
  onOpenIssue: () => void;
}

type FilterMode = 'all' | 'active' | 'revoked' | 'expiring';

export const CertificatesView: React.FC<CertificatesViewProps> = ({
  t,
  certificates,
  loading,
  onRefresh,
  onOpenIssue,
}) => {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [selected, setSelected] = useState<CertificateRecord | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<CertificateRecord | null>(null);
  const [revokeReason, setRevokeReason] = useState<number>(1);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState('');
  const [renewingSerial, setRenewingSerial] = useState('');
  const [notice, setNotice] = useState('');

  const nowUnix = Math.floor(Date.now() / 1000);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return certificates.filter((c) => {
      const eff = computeCertEffectiveStatus(c.status, c.not_after, nowUnix);
      if (filter === 'active' && eff !== 'active') return false;
      if (filter === 'revoked' && eff !== 'revoked') return false;
      if (filter === 'expiring' && !isExpiringWithinDays(c.status, c.not_after, nowUnix, 30)) return false;

      if (!q) return true;
      return (
        c.common_name.toLowerCase().includes(q) ||
        c.serial_hex.toLowerCase().includes(q) ||
        c.upn.toLowerCase().includes(q) ||
        c.sans_json.toLowerCase().includes(q) ||
        c.profile.toLowerCase().includes(q)
      );
    });
  }, [certificates, filter, query, nowUnix]);

  const handleConfirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    setRevokeError('');
    try {
      await api.revokeCertificate(revokeTarget.serial_hex, revokeReason);
      setRevokeTarget(null);
      setSelected(null);
      onRefresh();
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : 'Revocation failed');
    } finally {
      setRevoking(false);
    }
  };

  const downloadCertPem = (cert: CertificateRecord) => {
    const blob = new Blob([cert.cert_pem], { type: 'application/x-pem-file' });
    triggerBlobDownload(blob, `${cert.serial_hex.slice(0, 12)}.crt`);
  };

  const handleRenew = async (cert: CertificateRecord) => {
    setRenewingSerial(cert.serial_hex);
    setNotice('');
    try {
      const res = await api.renewCertificate(cert.serial_hex, { revoke_old: false });
      setSelected(res.certificate);
      setNotice(`${t.certs.renewSuccess} (${res.certificate.serial_hex.slice(0, 12)}…)`);
      onRefresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Renewal failed');
    } finally {
      setRenewingSerial('');
    }
  };

  return (
    <div className="space-y-5">
      {/* Toolbar: Search + Segmented Status Filter */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search
            className="w-4 h-4 text-slate-400 absolute top-1/2 -translate-y-1/2 start-3 pointer-events-none"
            aria-hidden="true"
          />
          <label htmlFor="cert-search" className="sr-only">
            {t.certs.searchPlaceholder}
          </label>
          <input
            id="cert-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.certs.searchPlaceholder}
            className="w-full rounded-lg border border-slate-300 bg-white ps-9 pe-3.5 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
          />
        </div>

        <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start">
          {(
            [
              ['all', t.certs.filterAll],
              ['active', t.certs.filterActive],
              ['revoked', t.certs.filterRevoked],
              ['expiring', t.certs.filterExpiring],
            ] as Array<[FilterMode, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                filter === key ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <FloatingToast notice={notice} onDismissNotice={() => setNotice('')} />

      {/* Dense Data Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3" aria-busy="true">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 bg-slate-100 rounded animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <h3 className="font-display text-base font-semibold text-slate-900">{t.certs.emptyTitle}</h3>
            <p className="text-sm text-slate-500 max-w-md mx-auto">{t.certs.emptyDesc}</p>
            <button
              type="button"
              onClick={onOpenIssue}
              className="px-4 py-2 rounded-lg bg-[#0F766E] hover:bg-[#115E59] text-white text-xs font-medium cursor-pointer"
            >
              {t.overview.quickIssue}
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-start">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-slate-500">
                  <th className="py-3 ps-5 pe-3 font-medium text-start">{t.certs.columns.subject}</th>
                  <th className="py-3 pe-3 font-medium text-start">{t.certs.columns.profile}</th>
                  <th className="py-3 pe-3 font-medium text-start">{t.certs.columns.serial}</th>
                  <th className="py-3 pe-3 font-medium text-start">{t.certs.columns.validity}</th>
                  <th className="py-3 pe-3 font-medium text-start">{t.certs.columns.status}</th>
                  <th className="py-3 pe-5 font-medium text-end">{t.certs.columns.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((cert) => {
                  const eff = computeCertEffectiveStatus(cert.status, cert.not_after, nowUnix);
                  const statusColor =
                    eff === 'active'
                      ? 'text-emerald-700'
                      : eff === 'revoked'
                      ? 'text-red-700'
                      : 'text-amber-700';
                  const statusLabel =
                    eff === 'active'
                      ? t.certs.statusActive
                      : eff === 'revoked'
                      ? t.certs.statusRevoked
                      : t.certs.statusExpired;

                  return (
                    <tr key={cert.serial_hex} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-3 ps-5 pe-3 min-w-[200px]">
                        <div className="font-medium text-slate-900 wrap-anywhere">{cert.common_name}</div>
                        <div className="text-[11px] text-slate-500 font-mono wrap-anywhere">
                          {cert.upn || cert.subject_dn}
                        </div>
                      </td>
                      <td className="py-3 pe-3 font-mono text-slate-700 whitespace-nowrap">{cert.profile}</td>
                      <td className="py-3 pe-3 font-mono text-slate-600 tabular-nums whitespace-nowrap">
                        <span dir="ltr" className="inline-flex items-center gap-1">
                          <span>{cert.serial_hex.slice(0, 16)}…</span>
                          <CopyButton value={cert.serial_hex} copiedLabel={t.common.copied} compact />
                        </span>
                      </td>
                      <td className="py-3 pe-3 font-mono text-slate-600 tabular-nums whitespace-nowrap">
                        <span dir="ltr" className="inline-block">
                          {formatUnixUtc(cert.not_after)}
                        </span>
                      </td>
                      <td className={`py-3 pe-3 font-medium whitespace-nowrap ${statusColor}`}>
                        {statusLabel}
                      </td>
                      <td className="py-3 pe-5 text-end whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-3">
                          <button
                            type="button"
                            onClick={() => setSelected(cert)}
                            className="text-teal-700 hover:text-teal-900 font-medium cursor-pointer"
                            aria-label={`${t.certs.inspect} ${cert.common_name}`}
                          >
                            {t.certs.inspect}
                          </button>
                          {eff !== 'revoked' && (
                            <button
                              type="button"
                              disabled={renewingSerial === cert.serial_hex}
                              onClick={() => handleRenew(cert)}
                              className="text-slate-700 hover:text-teal-800 disabled:opacity-50 font-medium cursor-pointer"
                            >
                              {t.certs.renew}
                            </button>
                          )}
                          {eff !== 'revoked' && (
                            <button
                              type="button"
                              onClick={() => {
                                setRevokeTarget(cert);
                                setRevokeReason(1);
                                setRevokeError('');
                              }}
                              className="text-red-700 hover:text-red-900 font-medium cursor-pointer"
                              aria-label={`${t.certs.revoke} ${cert.common_name}`}
                            >
                              {t.certs.revoke}
                            </button>
                          )}
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

      {/* Inspection Slide-Over Drawer */}
      {selected && (
        <div className="fixed inset-0 z-40 bg-slate-900/35 flex justify-end" role="dialog" aria-modal="true" aria-label={t.certs.drawerTitle}>
          <div className="w-full max-w-xl bg-white h-full overflow-y-auto p-6 lg:p-8 space-y-6 border-s border-slate-200">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
              <div className="space-y-1 min-w-0">
                <div className="text-xs font-mono text-slate-500">{selected.profile} · {selected.key_mode}</div>
                <h3 className="font-display text-lg font-bold text-slate-900 wrap-anywhere">
                  {selected.common_name}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label="Close details"
                className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <dl className="divide-y divide-slate-100 text-xs">
              <div className="py-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-slate-500">{t.certs.subjectDn}</dt>
                  <CopyButton value={selected.subject_dn} label={t.common.copy} copiedLabel={t.common.copied} compact />
                </div>
                <dd dir="ltr" className="font-mono text-slate-900 wrap-anywhere text-start">{selected.subject_dn}</dd>
              </div>
              <div className="py-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-slate-500">{t.overview.serial}</dt>
                  <CopyButton value={selected.serial_hex} label={t.common.copy} copiedLabel={t.common.copied} compact />
                </div>
                <dd dir="ltr" className="font-mono text-slate-900 wrap-anywhere text-start">
                  {formatSerialColon(selected.serial_hex)}
                </dd>
              </div>
              <div className="py-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-slate-500">{t.overview.fingerprint}</dt>
                  <CopyButton value={selected.fingerprint_sha256} label={t.common.copy} copiedLabel={t.common.copied} compact />
                </div>
                <dd dir="ltr" className="font-mono text-slate-700 wrap-anywhere text-start">
                  {selected.fingerprint_sha256}
                </dd>
              </div>
              <div className="py-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-slate-500">{t.certs.sanList}</dt>
                  {parseJsonStringArray(selected.sans_json).length > 0 && (
                    <CopyButton
                      value={parseJsonStringArray(selected.sans_json).join(', ')}
                      label={t.common.copy}
                      copiedLabel={t.common.copied}
                      compact
                    />
                  )}
                </div>
                <dd dir="ltr" className="font-mono text-slate-900 wrap-anywhere text-start">
                  {parseJsonStringArray(selected.sans_json).join(' · ') || '—'}
                </dd>
              </div>
              <div className="py-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-slate-500">{t.certs.ekuOids}</dt>
                  {parseJsonStringArray(selected.eku_oids_json).length > 0 && (
                    <CopyButton
                      value={parseJsonStringArray(selected.eku_oids_json).join('\n')}
                      label={t.common.copy}
                      copiedLabel={t.common.copied}
                      compact
                    />
                  )}
                </div>
                <dd dir="ltr" className="space-y-1 font-mono text-slate-800 text-start">
                  {parseJsonStringArray(selected.eku_oids_json).map((oid) => (
                    <div key={oid} className="wrap-anywhere">
                      {oid}
                    </div>
                  ))}
                </dd>
              </div>
              {selected.status === 'revoked' && (
                <div className="py-3 space-y-1">
                  <dt className="text-red-700 font-medium">{t.certs.revocationInfo}</dt>
                  <dd className="font-mono text-red-700">
                    {formatUnixUtc(selected.revoked_at)} · Reason #{selected.revocation_reason}
                  </dd>
                </div>
              )}
            </dl>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-500">X.509 PEM</span>
                <div className="flex items-center gap-2">
                  {selected.status !== 'revoked' && (
                    <button
                      type="button"
                      disabled={renewingSerial === selected.serial_hex}
                      onClick={() => handleRenew(selected)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{t.certs.renew}</span>
                    </button>
                  )}
                  <CopyButton
                    value={selected.cert_pem}
                    label={t.certs.copyPem}
                    copiedLabel={t.common.copied}
                  />
                  <button
                    type="button"
                    onClick={() => downloadCertPem(selected)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-teal-200 bg-teal-50/40 text-xs font-medium text-teal-800 hover:bg-teal-50 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{t.certs.downloadPem}</span>
                  </button>
                </div>
              </div>
              <pre dir="ltr" className="bg-slate-950 text-slate-200 rounded-lg p-3.5 text-[11px] font-mono overflow-x-auto max-h-56 leading-relaxed">
                {selected.cert_pem}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* RFC 5280 Revocation Modal */}
      {revokeTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/45 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t.certs.revokeModalTitle}>
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-red-700 text-sm font-semibold">
                <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{t.certs.revokeModalTitle}</span>
              </div>
              <div className="text-sm font-semibold text-slate-900 wrap-anywhere">{revokeTarget.common_name}</div>
              <div className="text-xs font-mono text-slate-500 wrap-anywhere">{revokeTarget.serial_hex}</div>
              <p className="text-xs text-slate-600 leading-relaxed pt-1 wrap-anywhere">
                {t.certs.revokeModalDesc}
              </p>
            </div>

            <div>
              <label htmlFor="revoke-reason" className="block text-xs font-medium text-slate-700 mb-1.5">
                {t.certs.revokeReason}
              </label>
              <select
                id="revoke-reason"
                value={revokeReason}
                onChange={(e) => setRevokeReason(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              >
                <option value={0}>{t.certs.reasons['0']}</option>
                <option value={1}>{t.certs.reasons['1']}</option>
                <option value={3}>{t.certs.reasons['3']}</option>
                <option value={4}>{t.certs.reasons['4']}</option>
                <option value={5}>{t.certs.reasons['5']}</option>
              </select>
            </div>

            {revokeError && (
              <div role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {revokeError}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setRevokeTarget(null)}
                className="px-4 py-2 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                {t.certs.cancel}
              </button>
              <button
                type="button"
                disabled={revoking}
                onClick={handleConfirmRevoke}
                className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 disabled:opacity-60 text-white text-xs font-medium cursor-pointer"
              >
                {t.certs.confirmRevoke}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
