import React, { useEffect, useState } from 'react';
import {
  UserPlus,
  Trash2,
  Edit3,
  Check,
  ShieldCheck,
  MailCheck,
  Fingerprint,
  Link2,
  Unlink,
  Plus,
} from 'lucide-react';
import {
  api,
  type OAuthProvider,
  type OAuthProviderInfo,
  type UserProfile,
} from '../lib/api';
import type { LocaleDict } from '../lib/i18n';
import { formatUnixUtc, ROLE_DEFAULT_QUOTA, type UserRole } from '../lib/pki-utils';
import { CopyButton } from './CopyButton';

function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface ProfileViewProps {
  t: LocaleDict;
  user: UserProfile | null;
  previewMode?: boolean;
  onUpdated: (u: UserProfile) => void;
}

export const ProfileView: React.FC<ProfileViewProps> = ({
  t,
  user,
  previewMode = false,
  onUpdated,
}) => {
  const [fullName, setFullName] = useState(user?.full_name || '');
  const [upn, setUpn] = useState(user?.upn || '');
  const [organization, setOrganization] = useState(user?.organization || '');
  const [department, setDepartment] = useState(user?.department || '');
  const [country, setCountry] = useState(user?.country || '');
  const [province, setProvince] = useState(user?.province || '');
  const [locality, setLocality] = useState(user?.locality || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Email verification / change state
  const [newEmail, setNewEmail] = useState(user?.email || '');
  const [emailCode, setEmailCode] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [emailVerifying, setEmailVerifying] = useState(false);
  const [emailStatus, setEmailStatus] = useState('');
  const [emailError, setEmailError] = useState('');
  const [previewEmailCode, setPreviewEmailCode] = useState('');

  // Social OAuth binding state
  const [providers, setProviders] = useState<OAuthProviderInfo[]>([]);
  const [socialBusy, setSocialBusy] = useState<string | null>(null);
  const [socialMsg, setSocialMsg] = useState('');
  const [socialErr, setSocialErr] = useState('');

  // 2FA & Passkey state
  const [passkeyName, setPasskeyName] = useState('');
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [mfaMsg, setMfaMsg] = useState('');
  const [mfaErr, setMfaErr] = useState('');

  useEffect(() => {
    if (!user) return;
    setFullName(user.full_name || '');
    setNewEmail(user.email || '');
    setUpn(user.upn || '');
    setOrganization(user.organization || '');
    setDepartment(user.department || '');
    setCountry(user.country || '');
    setProvince(user.province || '');
    setLocality(user.locality || '');
  }, [user]);

  useEffect(() => {
    api
      .getOAuthProviders()
      .then((res) => setProviders(res.providers || []))
      .catch(() => {});
  }, []);

  // Listen for OAuth popup completion (matches server.ts OAUTH_AUTH_SUCCESS / OAUTH_AUTH_ERROR)
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'OAUTH_AUTH_ERROR') {
        setSocialBusy(null);
        setSocialErr(String(data.error || 'OAuth binding failed'));
        return;
      }
      if (data.type === 'OAUTH_AUTH_SUCCESS' && data.mode === 'bind') {
        setSocialBusy(null);
        setSocialErr('');
        setSocialMsg(`Linked ${data.provider === 'wimotek' ? 'wimotek/OAuth' : data.provider || 'SSO'} account successfully.`);
        if (data.user) {
          onUpdated(data.user as UserProfile);
        } else {
          api
            .getProfile()
            .then((res) => onUpdated(res.user))
            .catch(() => {});
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onUpdated]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const res = await api.updateProfile({
        full_name: fullName.trim(),
        upn: upn.trim(),
        organization: organization.trim(),
        department: department.trim(),
        country: country.trim().toUpperCase(),
        province: province.trim(),
        locality: locality.trim(),
      });
      onUpdated(res.user);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  const handleSendEmailCode = async () => {
    const trimmed = newEmail.trim();
    if (!trimmed) return;
    setEmailSending(true);
    setEmailError('');
    setEmailStatus('');
    setPreviewEmailCode('');
    try {
      const res = await api.sendProfileEmailCode(trimmed);
      setEmailStatus(`Verification code sent (${res.delivery}). Valid for ${Math.round(res.expires_in / 60)} min.`);
      if (res.preview_code) {
        setPreviewEmailCode(res.preview_code);
      }
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : 'Failed to send verification code');
    } finally {
      setEmailSending(false);
    }
  };

  const handleVerifyEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.trim() || !emailCode.trim()) return;
    setEmailVerifying(true);
    setEmailError('');
    setEmailStatus('');
    try {
      const res = await api.verifyProfileEmail(newEmail.trim(), emailCode.trim());
      onUpdated(res.user);
      setEmailCode('');
      setPreviewEmailCode('');
      setEmailStatus('Email verified and saved.');
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : 'Invalid verification code');
    } finally {
      setEmailVerifying(false);
    }
  };

  const handleBindSocial = async (provider: OAuthProvider) => {
    setSocialBusy(provider);
    setSocialErr('');
    setSocialMsg('');
    try {
      const info = await api.getOAuthUrl(provider, 'bind');
      if (info.configured && info.url) {
        const popup = window.open(
          info.url,
          `wimotek_oauth_${provider}`,
          'width=540,height=680,menubar=no,toolbar=no,status=no'
        );
        if (!popup) {
          setSocialBusy(null);
          setSocialErr('Popup blocked by browser. Please allow popups for this site.');
        }
        return;
      }
      if (info.preview_mode || previewMode) {
        const sim = await api.demoOAuthSimulate(provider, 'bind');
        if (sim.user) {
          onUpdated(sim.user);
        }
        setSocialMsg(`Preview mode: linked ${provider} account.`);
        setSocialBusy(null);
        return;
      }
      setSocialErr(
        provider === 'wimotek'
          ? 'wimotek/OAuth gateway credentials are not configured yet. Set WIMOTEK_OAUTH_ISSUER, WIMOTEK_OAUTH_CLIENT_ID & WIMOTEK_OAUTH_CLIENT_SECRET.'
          : `OAuth credentials for ${provider} are not configured on this server. Configure OAUTH_${provider.toUpperCase()}_CLIENT_ID & SECRET in environment variables.`
      );
      setSocialBusy(null);
    } catch (err) {
      setSocialErr(err instanceof Error ? err.message : 'Failed to initiate social binding');
      setSocialBusy(null);
    }
  };

  const handleUnbindSocial = async (provider: OAuthProvider) => {
    setSocialBusy(provider);
    setSocialErr('');
    setSocialMsg('');
    try {
      const res = await api.unlinkSocialAccount(provider);
      onUpdated(res.user);
      setSocialMsg(`Unlinked ${provider}.`);
    } catch (err) {
      setSocialErr(err instanceof Error ? err.message : 'Failed to unlink account');
    } finally {
      setSocialBusy(null);
    }
  };

  const handleToggleMfa = async (field: 'mfa_email_enabled' | 'mfa_passkey_enabled', nextVal: boolean) => {
    setMfaErr('');
    setMfaMsg('');
    try {
      const res = await api.updateMfaSettings({ [field]: nextVal });
      onUpdated(res.user);
      setMfaMsg('Two-factor authentication settings updated.');
    } catch (err) {
      setMfaErr(err instanceof Error ? err.message : 'Failed to update 2FA settings');
    }
  };

  const handleAddPasskey = async (e: React.FormEvent) => {
    e.preventDefault();
    const label = passkeyName.trim() || 'My Passkey';
    setPasskeyBusy(true);
    setMfaErr('');
    setMfaMsg('');
    try {
      const opts = await api.getPasskeyRegisterOptions(label);
      let credentialId = '';
      let deviceType = 'platform';
      let simulated = false;

      if (window.PublicKeyCredential && navigator.credentials?.create) {
        try {
          const cred = (await navigator.credentials.create({
            publicKey: {
              challenge: base64UrlToUint8Array(opts.challenge) as BufferSource,
              rp: { name: opts.rp.name, id: opts.rp.id },
              user: {
                id: base64UrlToUint8Array(opts.user.id) as BufferSource,
                name: opts.user.name,
                displayName: opts.user.displayName,
              },
              pubKeyCredParams: [
                { type: 'public-key', alg: -7 },
                { type: 'public-key', alg: -257 },
              ],
              authenticatorSelection: {
                residentKey: 'preferred',
                userVerification: 'preferred',
              },
              timeout: 60000,
              excludeCredentials: (opts.excludeCredentials || []).map((c) => ({
                id: base64UrlToUint8Array(c.id) as BufferSource,
                type: 'public-key' as const,
              })),
            },
          })) as PublicKeyCredential | null;

          if (cred) {
            credentialId = bufferToBase64Url(cred.rawId);
            deviceType = 'webauthn';
          }
        } catch (webauthnErr) {
          if (!previewMode) {
            throw webauthnErr;
          }
          // Sandboxed iframe fallback for preview mode
          simulated = true;
          credentialId = `sim_pk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
          deviceType = 'preview-simulated';
        }
      } else if (previewMode) {
        simulated = true;
        credentialId = `sim_pk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        deviceType = 'preview-simulated';
      } else {
        throw new Error('WebAuthn Passkeys are not supported in this browser context.');
      }

      if (!credentialId) {
        throw new Error('Passkey registration was cancelled.');
      }

      const res = await api.verifyPasskeyRegister({
        challenge_id: opts.challenge_id,
        name: label,
        credential_id: credentialId,
        device_type: deviceType,
        simulated,
      });
      onUpdated(res.user);
      setPasskeyName('');
      setMfaMsg(`Passkey "${res.passkey.name}" added.`);
    } catch (err) {
      setMfaErr(err instanceof Error ? err.message : 'Failed to register passkey');
    } finally {
      setPasskeyBusy(false);
    }
  };

  const handleDeletePasskey = async (id: string) => {
    setMfaErr('');
    setMfaMsg('');
    try {
      const res = await api.deletePasskey(id);
      onUpdated(res.user);
      setMfaMsg('Passkey removed.');
    } catch (err) {
      setMfaErr(err instanceof Error ? err.message : 'Failed to remove passkey');
    }
  };

  if (!user) return null;

  const linkedMap = new Map((user.social_accounts || []).map((s) => [s.provider, s]));
  const passkeys = user.passkeys || [];

  return (
    <div className="max-w-4xl space-y-6">
      {/* Top Tier & Quota Summary */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <div className="text-xs text-slate-500">{t.profile.accountTier}</div>
          <div className="font-display text-lg font-bold text-slate-900 mt-1 flex items-center gap-1.5">
            <span>{user.username}</span>
            <CopyButton compact value={user.username} ariaLabel={t.common.copy} copiedLabel={t.common.copied} />
          </div>
          <div className="text-xs text-slate-500">{t.users.roles[user.role] || user.role}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">{t.profile.quotaUsage}</div>
          <div className="font-mono text-lg font-bold text-teal-700 mt-1 tabular-nums">
            {user.cert_quota < 0
              ? `${user.active_certs ?? 0} / ${t.profile.unlimited}`
              : `${user.active_certs ?? 0} / ${user.cert_quota}`}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Security Status</div>
          <div className="mt-1 space-y-0.5 text-xs">
            <div className={user.email_verified ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'}>
              Email: {user.email_verified ? t.profile.emailVerified : t.profile.emailUnverified}
            </div>
            <div className="text-slate-600">
              2FA:{' '}
              {user.mfa_email_enabled || user.mfa_passkey_enabled
                ? [
                    user.mfa_passkey_enabled ? 'Passkey' : null,
                    user.mfa_email_enabled ? 'Email OTP' : null,
                  ]
                    .filter(Boolean)
                    .join(' + ')
                : 'Off'}
            </div>
          </div>
        </div>
      </div>

      {/* Email Verification & Change Card */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MailCheck className="w-4 h-4 text-teal-700" aria-hidden="true" />
            <h3 className="font-display text-base font-semibold text-slate-900">
              {t.profile.changeVerifyEmail}
            </h3>
          </div>
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded border ${
              user.email_verified
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : 'bg-amber-50 text-amber-800 border-amber-200'
            }`}
          >
            {user.email_verified ? t.profile.emailVerified : t.profile.emailUnverified}
          </span>
        </div>

        <form onSubmit={handleVerifyEmail} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
            <div className="md:col-span-6">
              <label htmlFor="prof-email-verify" className="block text-xs font-medium text-slate-700 mb-1">
                {t.profile.email}
              </label>
              <div className="flex gap-2">
                <input
                  id="prof-email-verify"
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={emailSending || !newEmail.trim()}
                  onClick={handleSendEmailCode}
                  className="px-3.5 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-medium cursor-pointer whitespace-nowrap"
                >
                  {emailSending ? '...' : t.common.sendCode}
                </button>
              </div>
            </div>
            <div className="md:col-span-3">
              <label htmlFor="prof-email-code" className="block text-xs font-medium text-slate-700 mb-1">
                {t.auth.emailCode}
              </label>
              <input
                id="prof-email-code"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={emailCode}
                onChange={(e) => setEmailCode(e.target.value)}
                placeholder="123456"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono tracking-widest text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div className="md:col-span-3">
              <button
                type="submit"
                disabled={emailVerifying || !emailCode.trim()}
                className="w-full px-4 py-2 rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white text-xs font-medium cursor-pointer whitespace-nowrap"
              >
                {emailVerifying ? '...' : t.profile.verifyEmailBtn}
              </button>
            </div>
          </div>

          {previewEmailCode && (
            <div className="flex items-center justify-between gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-2 text-xs text-amber-900">
              <span>
                Preview verification code: <code className="font-mono font-bold text-sm">{previewEmailCode}</code>
              </span>
              <CopyButton compact value={previewEmailCode} label={t.common.copy} copiedLabel={t.common.copied} />
            </div>
          )}
          {emailStatus && <div className="text-xs text-emerald-700">{emailStatus}</div>}
          {emailError && (
            <div role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {emailError}
            </div>
          )}
        </form>
      </div>

      {/* Unified wimotek/OAuth SSO Gateway & Optional Direct IdP Binding */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-teal-700" aria-hidden="true" />
            <h3 className="font-display text-base font-semibold text-slate-900">{t.profile.socialTitle}</h3>
          </div>
          <p className="text-xs text-slate-600">{t.profile.socialDesc}</p>
        </div>

        {/* Primary Unified Gateway: wimotek/OAuth (PKCE S256) */}
        {(() => {
          const wLinked = linkedMap.get('wimotek');
          const wMeta = providers.find((p) => p.provider === 'wimotek');
          const primaryCallback = wMeta?.callback_url || `${window.location.origin}/api/auth/oauth/wimotek/callback`;
          const aliasCallback = (() => {
            try {
              return `${new URL(primaryCallback).origin}/callback`;
            } catch {
              return `${window.location.origin}/callback`;
            }
          })();
          return (
            <div className="border border-teal-200 bg-teal-50/40 rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-sm text-slate-900">
                      {t.profile.wimotekGatewayTitle}
                    </span>
                    <span
                      className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${
                        wLinked
                          ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                          : 'bg-white text-slate-600 border-slate-200'
                      }`}
                    >
                      {wLinked ? t.profile.socialLinked : t.profile.socialNotLinked}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600">{t.profile.wimotekGatewayDesc}</p>
                  {wLinked ? (
                    <div className="text-xs text-slate-700 pt-1 wrap-anywhere">
                      <span className="font-medium">{wLinked.display_name}</span>
                      {wLinked.email && (
                        <span className="font-mono text-[11px] text-slate-500 ms-2">{wLinked.email}</span>
                      )}
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-500 pt-0.5">
                      {wMeta?.configured
                        ? 'PKCE S256 Gateway Ready'
                        : previewMode
                          ? 'Preview SSO simulation ready · Set WIMOTEK_OAUTH_CLIENT_SECRET for live IdP'
                          : 'Configure WIMOTEK_OAUTH_CLIENT_SECRET to activate live IdP'}
                    </div>
                  )}
                </div>

                {wLinked ? (
                  <button
                    type="button"
                    disabled={socialBusy === 'wimotek'}
                    onClick={() => handleUnbindSocial('wimotek')}
                    className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg border border-red-200 bg-white text-red-700 hover:bg-red-50 text-xs font-medium cursor-pointer whitespace-nowrap"
                  >
                    <Unlink className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{t.common.unbind}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={socialBusy === 'wimotek'}
                    onClick={() => handleBindSocial('wimotek')}
                    className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#0F766E] hover:bg-[#115E59] text-white text-xs font-medium cursor-pointer whitespace-nowrap"
                  >
                    <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{socialBusy === 'wimotek' ? '...' : t.common.bind}</span>
                  </button>
                )}
              </div>

              <div className="pt-2.5 border-t border-teal-200/70 space-y-1.5 text-[11px]">
                {wMeta?.issuer && (
                  <div className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded px-2.5 py-1.5">
                    <span className="font-medium text-slate-600 shrink-0 w-24">Issuer</span>
                    <code dir="ltr" className="font-mono text-slate-700 truncate flex-1">{wMeta.issuer}</code>
                    <CopyButton compact value={wMeta.issuer} label={t.common.copy} copiedLabel={t.common.copied} />
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded px-2.5 py-1.5">
                  <span className="font-medium text-slate-600 shrink-0 w-24">Callback</span>
                  <code dir="ltr" className="font-mono text-slate-700 truncate flex-1">{primaryCallback}</code>
                  <CopyButton compact value={primaryCallback} label={t.common.copy} copiedLabel={t.common.copied} />
                </div>
                <div className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded px-2.5 py-1.5">
                  <span className="font-medium text-slate-600 shrink-0 w-24">Short Alias</span>
                  <code dir="ltr" className="font-mono text-slate-700 truncate flex-1">{aliasCallback}</code>
                  <CopyButton compact value={aliasCallback} label={t.common.copy} copiedLabel={t.common.copied} />
                </div>
              </div>
            </div>
          );
        })()}

        {socialMsg && <div className="text-xs text-emerald-700">{socialMsg}</div>}
        {socialErr && (
          <div role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {socialErr}
          </div>
        )}

        {/* Secondary Direct Social OAuth (collapsed by default since wimotek/OAuth unifies IdPs) */}
        <details className="pt-2 border-t border-slate-100 text-xs">
          <summary className="cursor-pointer font-medium text-slate-500 hover:text-slate-800 select-none">
            Optional Direct IdP Connections (Microsoft / GitHub / Google)
          </summary>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
            {(['microsoft', 'github', 'google'] as OAuthProvider[]).map((prov) => {
              const linked = linkedMap.get(prov);
              const meta = providers.find((p) => p.provider === prov);
              const label = meta?.label || prov.charAt(0).toUpperCase() + prov.slice(1);
              return (
                <div
                  key={prov}
                  className="border border-slate-200 rounded-xl p-3.5 flex flex-col justify-between gap-2.5 bg-slate-50/40"
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-xs text-slate-900">{label}</span>
                      <span className={`text-[11px] font-medium ${linked ? 'text-emerald-700' : 'text-slate-400'}`}>
                        {linked ? t.profile.socialLinked : t.profile.socialNotLinked}
                      </span>
                    </div>
                    {linked && (
                      <div className="text-[11px] font-mono text-slate-500 truncate">{linked.email || linked.display_name}</div>
                    )}
                  </div>
                  {linked ? (
                    <button
                      type="button"
                      disabled={socialBusy === prov}
                      onClick={() => handleUnbindSocial(prov)}
                      className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-red-200 text-red-700 hover:bg-red-50 text-xs font-medium cursor-pointer"
                    >
                      <Unlink className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{t.common.unbind}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={socialBusy === prov}
                      onClick={() => handleBindSocial(prov)}
                      className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium cursor-pointer"
                    >
                      <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{socialBusy === prov ? '...' : t.common.bind}</span>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      </div>

      {/* Two-Factor Authentication (Passkeys + Email OTP) */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-teal-700" aria-hidden="true" />
            <h3 className="font-display text-base font-semibold text-slate-900">{t.profile.mfaTitle}</h3>
          </div>
          <p className="text-xs text-slate-600">{t.profile.mfaDesc}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="flex items-start justify-between gap-3 border border-slate-200 rounded-xl p-4 cursor-pointer">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-slate-900">{t.profile.mfaEmailLabel}</div>
              <div className="text-xs text-slate-500">{t.profile.mfaEmailHint}</div>
              {!user.email_verified && (
                <div className="text-[11px] text-amber-700">Verify your email address above before enabling.</div>
              )}
            </div>
            <input
              type="checkbox"
              checked={Boolean(user.mfa_email_enabled)}
              disabled={!user.email_verified}
              onChange={(e) => handleToggleMfa('mfa_email_enabled', e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
            />
          </label>

          <label className="flex items-start justify-between gap-3 border border-slate-200 rounded-xl p-4 cursor-pointer">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-slate-900">{t.profile.mfaPasskeyLabel}</div>
              <div className="text-xs text-slate-500">{t.profile.mfaPasskeyHint}</div>
              {passkeys.length === 0 && (
                <div className="text-[11px] text-amber-700">Add at least one passkey below to enable.</div>
              )}
            </div>
            <input
              type="checkbox"
              checked={Boolean(user.mfa_passkey_enabled)}
              disabled={passkeys.length === 0}
              onChange={(e) => handleToggleMfa('mfa_passkey_enabled', e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
            />
          </label>
        </div>

        {/* Add Passkey Form */}
        <form onSubmit={handleAddPasskey} className="flex flex-wrap items-end gap-3 pt-2 border-t border-slate-100">
          <div className="flex-1 min-w-[200px]">
            <label htmlFor="pk-name" className="block text-xs font-medium text-slate-700 mb-1">
              <Fingerprint className="w-3.5 h-3.5 inline me-1 text-teal-700" aria-hidden="true" />
              {t.profile.addPasskey}
            </label>
            <input
              id="pk-name"
              type="text"
              value={passkeyName}
              onChange={(e) => setPasskeyName(e.target.value)}
              placeholder={t.profile.passkeyNamePlaceholder}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={passkeyBusy}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white text-xs font-medium cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{passkeyBusy ? '...' : t.profile.addPasskey}</span>
          </button>
        </form>

        {mfaMsg && <div className="text-xs text-emerald-700">{mfaMsg}</div>}
        {mfaErr && (
          <div role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {mfaErr}
          </div>
        )}

        {passkeys.length === 0 ? (
          <p className="text-xs text-slate-500">{t.profile.noPasskeys}</p>
        ) : (
          <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
            {passkeys.map((pk) => (
              <div key={pk.id} className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="space-y-0.5 min-w-0">
                  <div className="font-semibold text-slate-900">{pk.name}</div>
                  <div className="text-[11px] font-mono text-slate-500 flex items-center gap-1.5">
                    <span className="truncate max-w-[220px]">{pk.credential_id}</span>
                    <CopyButton compact value={pk.credential_id} ariaLabel={t.common.copy} copiedLabel={t.common.copied} />
                    <span>· {pk.device_type} · {formatUnixUtc(pk.created_at)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleDeletePasskey(pk.id)}
                  className="inline-flex items-center gap-1 text-red-700 hover:text-red-900 font-medium cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t.users.delete}</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* X.509 Identity Profile Form */}
      <form onSubmit={handleSave} className="bg-white border border-slate-200 rounded-xl p-6 lg:p-8 space-y-5">
        <div className="space-y-1">
          <h2 className="font-display text-lg font-bold text-slate-900 wrap-anywhere">{t.profile.title}</h2>
          <p className="text-xs text-slate-600 wrap-anywhere">{t.profile.autofillHint}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="prof-name" className="block text-xs font-medium text-slate-700 mb-1.5">
              {t.profile.fullName}
            </label>
            <input
              id="prof-name"
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="prof-upn" className="block text-xs font-medium text-slate-700 mb-1.5">
              {t.profile.upn}
            </label>
            <input
              id="prof-upn"
              type="email"
              value={upn}
              onChange={(e) => setUpn(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="prof-org" className="block text-xs font-medium text-slate-700 mb-1.5">
              {t.profile.organization}
            </label>
            <input
              id="prof-org"
              type="text"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="prof-dept" className="block text-xs font-medium text-slate-700 mb-1.5">
              {t.profile.department}
            </label>
            <input
              id="prof-dept"
              type="text"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
            />
          </div>
          <div className="sm:col-span-2 grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="prof-c" className="block text-xs font-medium text-slate-700 mb-1.5">
                {t.profile.country}
              </label>
              <input
                id="prof-c"
                type="text"
                maxLength={2}
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono uppercase text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="prof-st" className="block text-xs font-medium text-slate-700 mb-1.5">
                {t.profile.province}
              </label>
              <input
                id="prof-st"
                type="text"
                value={province}
                onChange={(e) => setProvince(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="prof-l" className="block text-xs font-medium text-slate-700 mb-1.5">
                {t.profile.locality}
              </label>
              <input
                id="prof-l"
                type="text"
                value={locality}
                onChange={(e) => setLocality(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {error && (
          <div role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2">
            {error}
          </div>
        )}
        {saved && (
          <div className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
            <Check className="w-4 h-4" aria-hidden="true" />
            <span>{t.profile.saved}</span>
          </div>
        )}

        <div className="flex justify-end pt-2 border-t border-slate-100">
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2.5 rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white text-sm font-medium cursor-pointer"
          >
            {saving ? t.profile.saving : t.profile.saveButton}
          </button>
        </div>
      </form>
    </div>
  );
};

interface UsersManagementViewProps {
  t: LocaleDict;
  currentUsername: string;
}

export const UsersManagementView: React.FC<UsersManagementViewProps> = ({ t, currentUsername }) => {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('standard');
  const [certQuota, setCertQuota] = useState<number>(10);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [upn, setUpn] = useState('');
  const [organization, setOrganization] = useState('Wimotek Enterprise');
  const [department, setDepartment] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const res = await api.listUsers();
      setUsers(res.users || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const openCreate = () => {
    setEditing(null);
    setUsername('');
    setPassword('');
    setRole('standard');
    setCertQuota(ROLE_DEFAULT_QUOTA.standard);
    setFullName('');
    setEmail('');
    setUpn('');
    setOrganization('Wimotek Enterprise');
    setDepartment('');
    setEnabled(true);
    setError('');
    setFormOpen(true);
  };

  const openEdit = (u: UserProfile) => {
    setEditing(u.username);
    setUsername(u.username);
    setPassword('');
    setRole(u.role);
    setCertQuota(u.cert_quota);
    setFullName(u.full_name || '');
    setEmail(u.email || '');
    setUpn(u.upn || '');
    setOrganization(u.organization || '');
    setDepartment(u.department || '');
    setEnabled(u.enabled);
    setError('');
    setFormOpen(true);
  };

  const handleRoleChange = (nextRole: UserRole) => {
    setRole(nextRole);
    setCertQuota(ROLE_DEFAULT_QUOTA[nextRole]);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.saveUser({
        username: username.trim(),
        password: password || undefined,
        role,
        cert_quota: certQuota,
        full_name: fullName.trim(),
        email: email.trim(),
        upn: upn.trim(),
        organization: organization.trim(),
        department: department.trim(),
        enabled,
      });
      setFormOpen(false);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save user');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (target: string) => {
    setError('');
    try {
      await api.deleteUser(target);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="font-display text-xl font-bold text-slate-900 wrap-anywhere">{t.users.title}</h2>
          <p className="text-sm text-slate-600 wrap-anywhere">{t.users.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#0F766E] hover:bg-[#115E59] text-white text-xs font-medium cursor-pointer whitespace-nowrap"
        >
          <UserPlus className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{t.users.addUser}</span>
        </button>
      </div>

      {formOpen && (
        <form onSubmit={handleSave} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h3 className="font-display text-base font-semibold text-slate-900">
            {editing ? `${t.users.editUser}: ${editing}` : t.users.addUser}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="u-name" className="block text-xs font-medium text-slate-700 mb-1">
                {t.users.username}
              </label>
              <input
                id="u-name"
                type="text"
                required
                disabled={Boolean(editing)}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-slate-300 disabled:bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="u-pass" className="block text-xs font-medium text-slate-700 mb-1">
                {t.users.password}
              </label>
              <input
                id="u-pass"
                type="password"
                required={!editing}
                minLength={editing ? undefined : 8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={editing ? t.users.passwordOptional : '••••••••'}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="u-role" className="block text-xs font-medium text-slate-700 mb-1">
                {t.users.role}
              </label>
              <select
                id="u-role"
                value={role}
                onChange={(e) => handleRoleChange(e.target.value as UserRole)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              >
                <option value="admin">{t.users.roles.admin}</option>
                <option value="operator">{t.users.roles.operator}</option>
                <option value="standard">{t.users.roles.standard}</option>
                <option value="basic">{t.users.roles.basic}</option>
              </select>
            </div>
            <div>
              <label htmlFor="u-quota" className="block text-xs font-medium text-slate-700 mb-1">
                {t.users.quota}
              </label>
              <input
                id="u-quota"
                type="number"
                min={-1}
                value={certQuota}
                onChange={(e) => setCertQuota(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="u-full" className="block text-xs font-medium text-slate-700 mb-1">
                {t.profile.fullName}
              </label>
              <input
                id="u-full"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="u-email" className="block text-xs font-medium text-slate-700 mb-1">
                {t.profile.email}
              </label>
              <input
                id="u-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="u-upn" className="block text-xs font-medium text-slate-700 mb-1">
                {t.profile.upn}
              </label>
              <input
                id="u-upn"
                type="email"
                value={upn}
                onChange={(e) => setUpn(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="u-org" className="block text-xs font-medium text-slate-700 mb-1">
                {t.profile.organization}
              </label>
              <input
                id="u-org"
                type="text"
                value={organization}
                onChange={(e) => setOrganization(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="u-dept" className="block text-xs font-medium text-slate-700 mb-1">
                {t.profile.department}
              </label>
              <input
                id="u-dept"
                type="text"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
            />
            <span>{t.users.enabled}</span>
          </label>

          {error && (
            <div role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="px-4 py-2 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              {t.users.cancel}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white text-xs font-medium cursor-pointer"
            >
              {t.users.save}
            </button>
          </div>
        </form>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3" aria-busy="true">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 bg-slate-100 rounded animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-start">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-slate-500">
                  <th className="py-3 ps-5 pe-3 font-medium text-start">{t.users.columns.user}</th>
                  <th className="py-3 pe-3 font-medium text-start">{t.users.columns.role}</th>
                  <th className="py-3 pe-3 font-medium text-start">{t.users.columns.quota}</th>
                  <th className="py-3 pe-3 font-medium text-start">{t.users.columns.profile}</th>
                  <th className="py-3 pe-3 font-medium text-start">{t.users.columns.status}</th>
                  <th className="py-3 pe-5 font-medium text-end">{t.users.columns.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((u) => (
                  <tr key={u.username} className="hover:bg-slate-50/80">
                    <td className="py-3 ps-5 pe-3">
                      <div className="font-semibold text-slate-900">{u.username}</div>
                      <div className="text-[11px] text-slate-500 wrap-anywhere">{u.full_name || '—'}</div>
                    </td>
                    <td className="py-3 pe-3 font-medium text-slate-700 whitespace-nowrap">
                      {t.users.roles[u.role] || u.role}
                    </td>
                    <td className="py-3 pe-3 font-mono tabular-nums text-slate-800 whitespace-nowrap">
                      {u.cert_quota < 0
                        ? `${u.active_certs ?? 0} / ∞`
                        : `${u.active_certs ?? 0} / ${u.cert_quota}`}
                    </td>
                    <td className="py-3 pe-3 text-slate-600 wrap-anywhere">
                      <div>{[u.organization, u.department].filter(Boolean).join(' · ') || '—'}</div>
                      <div className="text-[11px] font-mono text-slate-400 inline-flex items-center gap-1">
                        <span>{u.email || u.upn || ''}</span>
                        {(u.email || u.upn) && (
                          <CopyButton compact value={u.email || u.upn} ariaLabel={t.common.copy} copiedLabel={t.common.copied} />
                        )}
                      </div>
                    </td>
                    <td className={`py-3 pe-3 font-medium whitespace-nowrap ${u.enabled ? 'text-emerald-700' : 'text-red-700'}`}>
                      {u.enabled ? t.users.statusEnabled : t.users.statusDisabled}
                    </td>
                    <td className="py-3 pe-5 text-end whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-3">
                        <button
                          type="button"
                          onClick={() => openEdit(u)}
                          className="inline-flex items-center gap-1 text-teal-700 hover:text-teal-900 font-medium cursor-pointer"
                        >
                          <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>{t.users.editUser}</span>
                        </button>
                        {u.username !== currentUsername && (
                          <button
                            type="button"
                            onClick={() => handleDelete(u.username)}
                            className="inline-flex items-center gap-1 text-red-700 hover:text-red-900 font-medium cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>{t.users.delete}</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
