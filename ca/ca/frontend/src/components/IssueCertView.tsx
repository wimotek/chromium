import React, { useEffect, useState } from 'react';
import { Download, FileCheck2, UserCircle2, AlertTriangle } from 'lucide-react';
import { api, type IssueCertResponse, type UserProfile } from '../lib/api';
import type { LocaleDict } from '../lib/i18n';
import { CopyButton, CodeBlock } from './CopyButton';
import {
  ALL_PROFILES,
  PROFILE_SPECS,
  parseSanInput,
  isValidUpn,
  isValidSanEntry,
  isQuotaExhausted,
  formatSerialColon,
  formatUnixUtc,
  type CertProfile,
} from '../lib/pki-utils';

interface IssueCertViewProps {
  t: LocaleDict;
  currentUser: UserProfile | null;
  onIssued: () => void;
  onOpenProfile: () => void;
}

export const IssueCertView: React.FC<IssueCertViewProps> = ({
  t,
  currentUser,
  onIssued,
  onOpenProfile,
}) => {
  const [profile, setProfile] = useState<CertProfile>('entra_cba');
  const [keyMode, setKeyMode] = useState<'auto' | 'csr'>('auto');
  const [commonName, setCommonName] = useState('');
  const [organization, setOrganization] = useState('Wimotek Enterprise');
  const [department, setDepartment] = useState('');
  const [country, setCountry] = useState('');
  const [province, setProvince] = useState('');
  const [locality, setLocality] = useState('');
  const [email, setEmail] = useState('');
  const [upn, setUpn] = useState('');
  const [sansInput, setSansInput] = useState('');
  const [validityDays, setValidityDays] = useState(365);
  const [pfxPassword, setPfxPassword] = useState('');
  const [csrPem, setCsrPem] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [profileAppliedNote, setProfileAppliedNote] = useState('');
  const [result, setResult] = useState<IssueCertResponse | null>(null);
  const [didInitialPrefill, setDidInitialPrefill] = useState(false);

  const spec = PROFILE_SPECS[profile];
  const activeCerts = currentUser?.active_certs ?? 0;
  const certQuota = currentUser?.cert_quota ?? -1;
  const quotaExhausted = isQuotaExhausted(activeCerts, certQuota);

  const applyUserProfile = (u: UserProfile, targetProfile: CertProfile, showNotice: boolean) => {
    const targetSpec = PROFILE_SPECS[targetProfile];
    if (targetSpec.preferFullNameCn && u.full_name) {
      setCommonName(u.full_name);
    }
    if (u.organization) setOrganization(u.organization);
    if (u.department) setDepartment(u.department);
    if (u.email) setEmail(u.email);
    if (u.upn) setUpn(u.upn);
    if (u.country) setCountry(u.country);
    if (u.province) setProvince(u.province);
    if (u.locality) setLocality(u.locality);
    if (showNotice) {
      setProfileAppliedNote(t.issue.profileApplied);
      setTimeout(() => setProfileAppliedNote(''), 2500);
    }
  };

  useEffect(() => {
    if (currentUser && !didInitialPrefill) {
      applyUserProfile(currentUser, profile, false);
      setDidInitialPrefill(true);
    }
  }, [currentUser, didInitialPrefill, profile]);

  const handleProfileChange = (next: CertProfile) => {
    setProfile(next);
    setValidityDays(PROFILE_SPECS[next].defaultTtlDays);
    setError('');
    if (currentUser) {
      const nextSpec = PROFILE_SPECS[next];
      if (nextSpec.preferFullNameCn && !commonName && currentUser.full_name) {
        setCommonName(currentUser.full_name);
      }
      if (nextSpec.supportsUpn && !upn && currentUser.upn) {
        setUpn(currentUser.upn);
      }
      if (nextSpec.requiresEmail && !email && currentUser.email) {
        setEmail(currentUser.email);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (quotaExhausted) {
      setError(t.issue.quotaExhausted);
      return;
    }
    if (keyMode === 'auto' && !commonName.trim()) {
      setError('Common Name (CN) is required.');
      return;
    }
    if (keyMode === 'csr' && !csrPem.includes('BEGIN CERTIFICATE REQUEST')) {
      setError('Please paste a valid PEM-encoded Certificate Signing Request.');
      return;
    }
    if (spec.requiresUpn && !isValidUpn(upn)) {
      setError('Entra ID CBA requires a valid msUPN (e.g. alice@contoso.com).');
      return;
    }
    if (spec.requiresEmail && !isValidUpn(email)) {
      setError('S/MIME Email profile requires a valid email address.');
      return;
    }

    const parsedSans = spec.supportsSans ? parseSanInput(sansInput) : [];
    if (spec.supportsSans && parsedSans.length > 0) {
      const invalid = parsedSans.find((entry) => !isValidSanEntry(entry));
      if (invalid) {
        setError(`Invalid SAN entry: ${invalid}`);
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await api.issueCertificate({
        profile,
        common_name: commonName.trim(),
        organization: organization.trim(),
        department: department.trim(),
        country: country.trim().toUpperCase(),
        province: province.trim(),
        locality: locality.trim(),
        email: email.trim(),
        upn: spec.supportsUpn ? upn.trim() : undefined,
        sans: parsedSans,
        validity_days: validityDays,
        csr_pem: keyMode === 'csr' ? csrPem.trim() : undefined,
        pfx_password: keyMode === 'auto' ? pfxPassword || 'changeit' : undefined,
      });
      setResult(res);
      onIssued();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to issue certificate');
    } finally {
      setSubmitting(false);
    }
  };

  const downloadBase64Pfx = () => {
    if (!result?.pfx_base64) return;
    const bin = atob(result.pfx_base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/x-pkcs12' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.filename || 'certificate'}.pfx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadChainPem = () => {
    if (!result?.chain_pem) return;
    const blob = new Blob([result.chain_pem], { type: 'application/x-pem-file' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.filename || 'certificate'}-chain.pem`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (result) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-6 lg:p-8 space-y-6 max-w-4xl">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-emerald-700 text-sm font-semibold">
              <FileCheck2 className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{t.issue.resultTitle}</span>
            </div>
            <h2 className="font-display text-2xl font-bold text-slate-900 wrap-anywhere">
              {result.certificate.common_name}
            </h2>
            <p className="text-sm text-slate-600 wrap-anywhere">{t.issue.resultSubtitle}</p>
          </div>

          <button
            type="button"
            onClick={() => {
              setResult(null);
              setSansInput('');
              setPfxPassword('');
              setCsrPem('');
            }}
            className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 whitespace-nowrap cursor-pointer"
          >
            {t.issue.issueAnother}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {result.pfx_base64 && (
            <button
              type="button"
              onClick={downloadBase64Pfx}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#0F766E] hover:bg-[#115E59] text-white text-sm font-medium transition-colors whitespace-nowrap cursor-pointer"
            >
              <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{t.issue.downloadPfx}</span>
            </button>
          )}
          <button
            type="button"
            onClick={downloadChainPem}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-sm font-medium transition-colors whitespace-nowrap cursor-pointer"
          >
            <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{t.issue.downloadChain}</span>
          </button>
          <CopyButton
            value={result.chain_pem}
            label={t.issue.copyPem}
            copiedLabel={t.issue.copied}
            className="px-4 py-2.5 text-sm"
          />
        </div>

        <dl className="divide-y divide-slate-100 text-xs border-t border-slate-100">
          <div className="py-3 grid grid-cols-1 sm:grid-cols-3 gap-1 items-center">
            <dt className="text-slate-500">Serial (128-bit CSPRNG)</dt>
            <dd dir="ltr" className="sm:col-span-2 flex items-start justify-between gap-2 font-mono text-slate-900 wrap-anywhere text-start">
              <span>{formatSerialColon(result.certificate.serial_hex)}</span>
              <CopyButton value={result.certificate.serial_hex} copiedLabel={t.common.copied} compact />
            </dd>
          </div>
          <div className="py-3 grid grid-cols-1 sm:grid-cols-3 gap-1 items-center">
            <dt className="text-slate-500">{t.certs.subjectDn}</dt>
            <dd dir="ltr" className="sm:col-span-2 flex items-start justify-between gap-2 font-mono text-slate-900 wrap-anywhere text-start">
              <span>{result.certificate.subject_dn}</span>
              <CopyButton value={result.certificate.subject_dn} copiedLabel={t.common.copied} compact />
            </dd>
          </div>
          <div className="py-3 grid grid-cols-1 sm:grid-cols-3 gap-1 items-center">
            <dt className="text-slate-500">{t.overview.fingerprint}</dt>
            <dd dir="ltr" className="sm:col-span-2 flex items-start justify-between gap-2 font-mono text-slate-700 wrap-anywhere text-start">
              <span>{result.certificate.fingerprint_sha256}</span>
              <CopyButton value={result.certificate.fingerprint_sha256} copiedLabel={t.common.copied} compact />
            </dd>
          </div>
          <div className="py-3 grid grid-cols-1 sm:grid-cols-3 gap-1">
            <dt className="text-slate-500">{t.overview.validUntil}</dt>
            <dd dir="ltr" className="sm:col-span-2 font-mono text-slate-900 tabular-nums text-start">
              {formatUnixUtc(result.certificate.not_after)}
            </dd>
          </div>
        </dl>

        <CodeBlock
          title="PEM Certificate Chain (Leaf + Issuing + Root)"
          code={result.chain_pem}
          copyLabel={t.issue.copyPem}
          copiedLabel={t.issue.copied}
          maxHeightClass="max-h-56"
        />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      <form
        onSubmit={handleSubmit}
        className="xl:col-span-8 bg-white border border-slate-200 rounded-xl p-6 lg:p-8 space-y-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4">
          <div className="space-y-1">
            <h2 className="font-display text-xl font-bold text-slate-900 wrap-anywhere">{t.issue.title}</h2>
            <p className="text-sm text-slate-600 wrap-anywhere">{t.issue.subtitle}</p>
          </div>

          {currentUser && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => applyUserProfile(currentUser, profile, true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-medium cursor-pointer whitespace-nowrap"
              >
                <UserCircle2 className="w-3.5 h-3.5 text-teal-700 shrink-0" aria-hidden="true" />
                <span>{t.issue.fillFromProfile}</span>
              </button>
              <button
                type="button"
                onClick={onOpenProfile}
                className="text-teal-700 hover:text-teal-900 font-medium px-2 py-1.5 cursor-pointer whitespace-nowrap"
              >
                {t.issue.editProfileLink}
              </button>
            </div>
          )}
        </div>

        {/* Quota Bar */}
        {currentUser && (
          <div className={`rounded-lg border px-4 py-3 text-xs flex flex-wrap items-center justify-between gap-3 ${
            quotaExhausted ? 'bg-red-50 border-red-200 text-red-800' : 'bg-slate-50 border-slate-200 text-slate-700'
          }`}>
            <div className="flex items-center gap-2">
              {quotaExhausted && <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" aria-hidden="true" />}
              <span className="font-medium">{t.issue.quotaStatus}:</span>
              <span className="font-mono font-semibold tabular-nums">
                {certQuota < 0
                  ? `${activeCerts} / ${t.issue.quotaUnlimited}`
                  : `${activeCerts} / ${certQuota}`}
              </span>
            </div>
            <div className="text-slate-500">
              {currentUser.username} · {t.users.roles[currentUser.role] || currentUser.role}
            </div>
          </div>
        )}

        {profileAppliedNote && (
          <div className="text-xs text-emerald-700 font-medium">{profileAppliedNote}</div>
        )}

        {/* Step 1: 8 Enterprise Certificate Templates */}
        <fieldset className="space-y-2.5">
          <legend className="text-xs font-semibold text-slate-700">{t.issue.profileLabel}</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {ALL_PROFILES.map((pid) => {
              const active = profile === pid;
              const copy = t.issue.profiles[pid];
              return (
                <button
                  key={pid}
                  type="button"
                  onClick={() => handleProfileChange(pid)}
                  aria-pressed={active}
                  className={`text-start rounded-lg border p-3 transition-colors cursor-pointer space-y-1 ${
                    active
                      ? 'border-teal-700 bg-teal-50/40 text-slate-900'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold wrap-anywhere">{copy.name}</span>
                    <span dir="ltr" className="text-[11px] font-mono text-slate-400 shrink-0">
                      {pid}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 leading-relaxed wrap-anywhere">{copy.desc}</div>
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* Step 2: Delivery Mode */}
        <div className="space-y-2">
          <div className="text-xs font-semibold text-slate-700">{t.issue.modeLabel}</div>
          <div className="inline-flex flex-wrap gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setKeyMode('auto')}
              className={`px-3.5 py-2 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                keyMode === 'auto' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.issue.modeAuto}
            </button>
            <button
              type="button"
              onClick={() => setKeyMode('csr')}
              className={`px-3.5 py-2 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                keyMode === 'csr' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.issue.modeCsr}
            </button>
          </div>
        </div>

        {/* Step 3: Subject & Template-Specific Fields */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <label htmlFor="issue-cn" className="block text-xs font-medium text-slate-700 mb-1.5 wrap-anywhere">
              {t.issue.commonName}
            </label>
            <input
              id="issue-cn"
              type="text"
              required={keyMode === 'auto'}
              value={commonName}
              onChange={(e) => setCommonName(e.target.value)}
              placeholder={t.issue.commonNamePlaceholder}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
            />
          </div>

          {spec.supportsUpn && (
            <div className="md:col-span-2">
              <label htmlFor="issue-upn" className="block text-xs font-medium text-slate-700 mb-1.5 wrap-anywhere">
                {t.issue.upn} {spec.requiresUpn ? '*' : ''}
              </label>
              <input
                id="issue-upn"
                type="email"
                required={spec.requiresUpn}
                value={upn}
                onChange={(e) => setUpn(e.target.value)}
                placeholder={t.issue.upnPlaceholder}
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
          )}

          {spec.supportsSans && (
            <div className="md:col-span-2">
              <label htmlFor="issue-sans" className="block text-xs font-medium text-slate-700 mb-1.5 wrap-anywhere">
                {t.issue.sans}
              </label>
              <textarea
                id="issue-sans"
                rows={2}
                value={sansInput}
                onChange={(e) => setSansInput(e.target.value)}
                placeholder={t.issue.sansPlaceholder}
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
          )}

          <div>
            <label htmlFor="issue-org" className="block text-xs font-medium text-slate-700 mb-1.5 wrap-anywhere">
              {t.issue.organization}
            </label>
            <input
              id="issue-org"
              type="text"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="issue-dept" className="block text-xs font-medium text-slate-700 mb-1.5 wrap-anywhere">
              {t.issue.department}
            </label>
            <input
              id="issue-dept"
              type="text"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
            />
          </div>

          <div className="md:col-span-2 grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="issue-c" className="block text-xs font-medium text-slate-700 mb-1.5 wrap-anywhere">
                {t.issue.country}
              </label>
              <input
                id="issue-c"
                type="text"
                maxLength={2}
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                placeholder="US"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono uppercase text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="issue-st" className="block text-xs font-medium text-slate-700 mb-1.5 wrap-anywhere">
                {t.issue.province}
              </label>
              <input
                id="issue-st"
                type="text"
                value={province}
                onChange={(e) => setProvince(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="issue-l" className="block text-xs font-medium text-slate-700 mb-1.5 wrap-anywhere">
                {t.issue.locality}
              </label>
              <input
                id="issue-l"
                type="text"
                value={locality}
                onChange={(e) => setLocality(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
          </div>

          {profile !== 'tls_server' && (
            <div>
              <label htmlFor="issue-email" className="block text-xs font-medium text-slate-700 mb-1.5 wrap-anywhere">
                {t.issue.email} {spec.requiresEmail ? '*' : ''}
              </label>
              <input
                id="issue-email"
                type="email"
                required={spec.requiresEmail}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="employee@company.com"
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
          )}

          <div>
            <label htmlFor="issue-days" className="block text-xs font-medium text-slate-700 mb-1.5 wrap-anywhere">
              {t.issue.validityDays}
            </label>
            <input
              id="issue-days"
              type="number"
              min={1}
              max={spec.maxTtlDays}
              value={validityDays}
              onChange={(e) => setValidityDays(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm font-mono tabular-nums text-slate-900 focus:border-teal-600 focus:outline-none"
            />
          </div>

          {keyMode === 'auto' ? (
            <div className="md:col-span-2">
              <label htmlFor="issue-pfx-pass" className="block text-xs font-medium text-slate-700 mb-1.5 wrap-anywhere">
                {t.issue.pfxPassword}
              </label>
              <input
                id="issue-pfx-pass"
                type="password"
                value={pfxPassword}
                onChange={(e) => setPfxPassword(e.target.value)}
                placeholder="Modern2023 AES-256-CBC export password"
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              />
              <p className="mt-1 text-xs text-slate-500 wrap-anywhere">{t.issue.pfxPasswordHint}</p>
            </div>
          ) : (
            <div className="md:col-span-2">
              <label htmlFor="issue-csr" className="block text-xs font-medium text-slate-700 mb-1.5 wrap-anywhere">
                {t.issue.csrPem}
              </label>
              <textarea
                id="issue-csr"
                rows={5}
                required
                value={csrPem}
                onChange={(e) => setCsrPem(e.target.value)}
                placeholder={t.issue.csrPlaceholder}
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-xs font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
          )}
        </div>

        {error && (
          <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5 wrap-anywhere">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end pt-2 border-t border-slate-100">
          <button
            type="submit"
            disabled={submitting || quotaExhausted}
            className="px-5 py-2.5 rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-50 text-white text-sm font-medium transition-colors whitespace-nowrap cursor-pointer"
          >
            {submitting ? t.issue.issuing : t.issue.submitButton}
          </button>
        </div>
      </form>

      {/* Right / End X.509 Profile Extension Inspector */}
      <aside className="xl:col-span-4 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <h3 className="font-display text-sm font-semibold text-slate-900 wrap-anywhere">
          {t.issue.extensionsPreview}
        </h3>

        <div className="space-y-4 text-xs">
          <div className="space-y-1">
            <div className="text-slate-500">Key Algorithm & Serial</div>
            <div className="font-mono text-slate-900 wrap-anywhere">
              ECDSA P-256 · 128-bit CSPRNG Serial
            </div>
          </div>

          <div className="space-y-1 border-t border-slate-100 pt-3">
            <div className="text-slate-500">Key Usage (Critical)</div>
            <ul className="space-y-1 font-mono text-slate-900">
              {spec.keyUsage.map((ku) => (
                <li key={ku} className="wrap-anywhere">
                  {ku}
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-1 border-t border-slate-100 pt-3">
            <div className="text-slate-500">Extended Key Usage / SAN OIDs</div>
            <ul className="space-y-1.5 font-mono text-slate-800">
              {spec.ekuOids.map((oid) => (
                <li key={oid} className="wrap-anywhere leading-relaxed">
                  {oid}
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-1 border-t border-slate-100 pt-3">
            <div className="text-slate-500">Revocation & Authority Info</div>
            <div dir="ltr" className="font-mono text-slate-700 wrap-anywhere text-start">
              HTTP CRL Distribution Point (/ca/crl.der) · OCSP (/ca/ocsp)
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
};
