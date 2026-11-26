import React, { useEffect, useState } from 'react';
import {
  ShieldCheck,
  Lock,
  Globe,
  KeyRound,
  Zap,
  Archive,
  UserCheck,
  ArrowRight,
  ArrowLeft,
  Check,
  Fingerprint,
  Mail,
  Layers,
  Webhook,
} from 'lucide-react';
import {
  api,
  type AuthResponse,
  type NotifyChannelConfig,
  type NotifyChannelType,
  type OAuthProvider,
  type OAuthProviderInfo,
  type UserProfile,
} from '../lib/api';
import { solvePowChallenge, type PowChallenge } from '../lib/pow';
import { parseAdvanceDays } from '../lib/pki-utils';
import { downloadProjectBundle } from '../lib/download';
import { LOCALE_OPTIONS, type LocaleCode, type LocaleDict } from '../lib/i18n';
import { FloatingToast } from './Toast';

function base64UrlToUint8Array(b64url: string): Uint8Array {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bufferToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface AuthGateProps {
  t: LocaleDict;
  locale: LocaleCode;
  onLocaleChange: (code: LocaleCode) => void;
  onAuthenticated: (
    token: string,
    username: string,
    previewMode: boolean,
    user?: UserProfile
  ) => void;
}

export const AuthGate: React.FC<AuthGateProps> = ({
  t,
  locale,
  onLocaleChange,
  onAuthenticated,
}) => {
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);

  // Login & Step 2 shared credentials
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // First-Run Installation Wizard state (3 steps)
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [orgName, setOrgName] = useState('Wimotek Enterprise');
  const [baseUrl, setBaseUrl] = useState('');
  const [fullName, setFullName] = useState('');
  const [department, setDepartment] = useState('IT Security');
  const [email, setEmail] = useState('');
  const [upn, setUpn] = useState('');
  const [country, setCountry] = useState('US');
  const [province, setProvince] = useState('');
  const [locality, setLocality] = useState('');

  // Wizard Step 3 optional expiry notifications
  const [notifyType, setNotifyType] = useState<NotifyChannelType | ''>('');
  const [notifyName, setNotifyName] = useState('Primary Expiry Alerts');
  const [advanceDaysText, setAdvanceDaysText] = useState('30, 7, 1');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [toEmails, setToEmails] = useState('');
  const [sendKey, setSendKey] = useState('');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');

  const [challenge, setChallenge] = useState<PowChallenge | null>(null);
  const [solving, setSolving] = useState(false);
  const [powNote, setPowNote] = useState('');
  const [error, setError] = useState('');
  const [downloadingBundle, setDownloadingBundle] = useState(false);

  const handleDownloadBundle = async () => {
    if (downloadingBundle) return;
    setDownloadingBundle(true);
    setError('');
    try {
      await downloadProjectBundle('wimotek-pki-suite.zip');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download project bundle');
    } finally {
      setDownloadingBundle(false);
    }
  };

  // Auth mode: separated OAuth SSO vs local login/register with explicit fallback switch
  const [authTab, setAuthTab] = useState<'login' | 'register'>('login');
  const [useLocalFallback, setUseLocalFallback] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('auth') === 'local' || params.get('mode') === 'local';
  });
  const [oauthProviders, setOauthProviders] = useState<OAuthProviderInfo[]>([]);

  // Registration + Email verification state
  const [regUsername, setRegUsername] = useState('');
  const [regFullName, setRegFullName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regEmailCode, setRegEmailCode] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regCodeSentNote, setRegCodeSentNote] = useState('');
  const [sendingRegCode, setSendingRegCode] = useState(false);

  // 2FA (Passkey / Email OTP) challenge state
  const [mfaState, setMfaState] = useState<{
    token: string;
    methods: Array<'passkey' | 'email'>;
    emailMasked?: string;
    previewCode?: string;
  } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaNote, setMfaNote] = useState('');

  const loadChallenge = async () => {
    try {
      const ch = await api.getPowChallenge();
      setChallenge(ch);
    } catch {
      // handled on submit
    }
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const oauthErr = params.get('oauth_error');
      if (oauthErr) {
        setError(oauthErr);
        params.delete('oauth_error');
        const nextQuery = params.toString();
        const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`;
        window.history.replaceState(null, '', nextUrl);
      }
    }

    let active = true;
    (async () => {
      try {
        const st = await api.getAuthStatus();
        if (!active) return;
        setNeedsSetup(st.needs_setup);
        setPreviewMode(Boolean(st.preview_mode));
        if (st.oauth_providers) {
          setOauthProviders(st.oauth_providers);
        }
        if (st.org_name) setOrgName(st.org_name);
        if (st.base_url) setBaseUrl(st.base_url);
        else if (typeof window !== 'undefined') setBaseUrl(window.location.origin);
        if (!st.needs_setup) {
          await loadChallenge();
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Unable to reach CA server');
      } finally {
        if (active) setLoadingStatus(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const handleAuthResponse = (res: AuthResponse, isPreview = previewMode) => {
    if (res.mfa_required && res.mfa_token) {
      setMfaState({
        token: res.mfa_token,
        methods: res.methods || ['email'],
        emailMasked: res.email_masked,
        previewCode: res.preview_email_code,
      });
      setMfaCode(res.preview_email_code || '');
      setMfaNote(res.preview_email_code ? `Preview verification code: ${res.preview_email_code}` : '');
      setError('');
      return;
    }
    if (res.token && res.username) {
      onAuthenticated(res.token, res.username, isPreview, res.user);
    }
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'OAUTH_AUTH_ERROR') {
        setError(data.error || 'OAuth authentication failed');
        return;
      }
      if (data.type === 'OAUTH_AUTH_SUCCESS' && data.mode === 'login') {
        handleAuthResponse(data as AuthResponse);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });

  const handleWizardNext = () => {
    setError('');
    if (wizardStep === 1) {
      if (!orgName.trim()) {
        setError('Organization Name (O) is required.');
        return;
      }
      setWizardStep(2);
      return;
    }
    if (wizardStep === 2) {
      if (!username.trim()) {
        setError('Administrator username is required.');
        return;
      }
      if (password.length < 8) {
        setError(t.auth.passwordTooShort);
        return;
      }
      if (password !== confirmPassword) {
        setError(t.auth.passwordMismatch);
        return;
      }
      setWizardStep(3);
    }
  };

  const handleWizardComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError(t.auth.passwordTooShort);
      setWizardStep(2);
      return;
    }
    if (password !== confirmPassword) {
      setError(t.auth.passwordMismatch);
      setWizardStep(2);
      return;
    }

    let notifyConfig: NotifyChannelConfig | undefined;
    if (notifyType === 'email') {
      notifyConfig = {
        smtp_host: smtpHost.trim(),
        smtp_port: smtpPort,
        smtp_user: smtpUser.trim(),
        smtp_password: smtpPass,
        from_email: fromEmail.trim(),
        to_emails: toEmails.trim(),
        use_tls: true,
      };
    } else if (notifyType === 'serverchan') {
      notifyConfig = { sendkey: sendKey.trim() };
    } else if (notifyType === 'telegram') {
      notifyConfig = { bot_token: botToken.trim(), chat_id: chatId.trim() };
    } else if (notifyType === 'webhook') {
      notifyConfig = { webhook_url: webhookUrl.trim(), webhook_secret: webhookSecret.trim() };
    }

    setSolving(true);
    try {
      const res = await api.setupAdmin({
        username: username.trim() || 'admin',
        password,
        org_name: orgName.trim(),
        base_url: baseUrl.trim(),
        default_lang: locale,
        full_name: fullName.trim() || username.trim(),
        department: department.trim(),
        email: email.trim(),
        upn: upn.trim(),
        country: country.trim().toUpperCase(),
        province: province.trim(),
        locality: locality.trim(),
        notify_type: notifyType,
        notify_name: notifyName.trim(),
        notify_config: notifyConfig,
        advance_days: notifyType ? parseAdvanceDays(advanceDaysText) : undefined,
      });
      handleAuthResponse(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setSolving(false);
    }
  };

  const handleDemoQuickLogin = async (demoUsername?: string) => {
    if (!previewMode) return;
    setError('');
    setSolving(true);
    try {
      const res = await api.demoQuickLogin(demoUsername);
      handleAuthResponse(res, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview login failed');
    } finally {
      setSolving(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!password) {
      setError(t.auth.invalidCredentials);
      return;
    }

    setSolving(true);
    setPowNote(t.auth.solvingPow);
    try {
      const activeChallenge = challenge ?? (await api.getPowChallenge());
      const solved = await solvePowChallenge(activeChallenge.challenge, activeChallenge.difficulty);
      setPowNote(`${t.auth.powReady} (${solved.iterations.toLocaleString()} SHA-256 · ${solved.elapsedMs}ms)`);
      const res = await api.login(
        username.trim() || 'admin',
        password,
        activeChallenge.challenge,
        solved.solution
      );
      handleAuthResponse(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.auth.invalidCredentials);
      await loadChallenge();
    } finally {
      setSolving(false);
    }
  };

  const handleSendRegCode = async () => {
    setError('');
    setRegCodeSentNote('');
    if (!regEmail.trim() || !regEmail.includes('@')) {
      setError('Please enter a valid email address first.');
      return;
    }
    setSendingRegCode(true);
    try {
      const res = await api.sendRegisterEmailCode(regEmail.trim());
      if (res.preview_code) {
        setRegEmailCode(res.preview_code);
        setRegCodeSentNote(`Verification code sent (Preview code: ${res.preview_code})`);
      } else {
        setRegCodeSentNote('A 6-digit verification code has been sent to your email.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send verification code');
    } finally {
      setSendingRegCode(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (regPassword.length < 8) {
      setError(t.auth.passwordTooShort);
      return;
    }
    setSolving(true);
    setPowNote(t.auth.solvingPow);
    try {
      const activeChallenge = challenge ?? (await api.getPowChallenge());
      const solved = await solvePowChallenge(activeChallenge.challenge, activeChallenge.difficulty);
      setPowNote(`${t.auth.powReady} (${solved.iterations.toLocaleString()} SHA-256)`);
      const res = await api.register({
        username: regUsername.trim(),
        full_name: regFullName.trim() || regUsername.trim(),
        email: regEmail.trim(),
        email_code: regEmailCode.trim(),
        password: regPassword,
        challenge: activeChallenge.challenge,
        solution: solved.solution,
      });
      handleAuthResponse(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
      await loadChallenge();
    } finally {
      setSolving(false);
    }
  };

  const handleSocialLogin = async (provider: OAuthProvider) => {
    setError('');
    try {
      const inIframe = typeof window !== 'undefined' && window.self !== window.top;
      if (provider === 'wimotek' && !inIframe) {
        const wMeta = oauthProviders.find((p) => p.provider === 'wimotek');
        if (wMeta?.configured) {
          window.location.href = '/login';
          return;
        }
      }
      const info = await api.getOAuthUrl(provider, 'login');
      if (info.configured && info.url) {
        if (!inIframe) {
          window.location.href = info.url;
          return;
        }
        const popup = window.open(info.url, `oauth_${provider}`, 'width=560,height=680');
        if (!popup) {
          setError('Popup was blocked. Please allow popups for OAuth login.');
        }
        return;
      }
      if (previewMode) {
        const res = await api.demoOAuthSimulate(provider, 'login');
        handleAuthResponse(res, true);
        return;
      }
      setError(`${provider.toUpperCase()} OAuth is not configured on the server yet. See Help -> OAuth & 2FA.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Social login failed');
    }
  };

  const handlePasskeyAuth = async (mfaToken?: string) => {
    setError('');
    setSolving(true);
    try {
      const opts = await api.getPasskeyLoginOptions(mfaToken ? undefined : username.trim(), mfaToken);
      if (!opts.allowCredentials || opts.allowCredentials.length === 0) {
        setError('No Passkeys registered yet. Sign in first and register a Passkey under My Profile.');
        return;
      }

      let credentialId = '';
      let simulated = false;

      if (typeof window !== 'undefined' && window.PublicKeyCredential && navigator.credentials?.get) {
        try {
          const assertion = (await navigator.credentials.get({
            publicKey: {
              challenge: base64UrlToUint8Array(opts.challenge) as BufferSource,
              rpId: window.location.hostname,
              allowCredentials: opts.allowCredentials.map((c) => ({
                id: base64UrlToUint8Array(c.id) as BufferSource,
                type: 'public-key',
              })),
              userVerification: 'preferred',
              timeout: 60000,
            },
          })) as PublicKeyCredential | null;
          if (assertion) {
            credentialId = bufferToBase64Url(assertion.rawId);
          }
        } catch {
          if (previewMode) {
            credentialId = opts.allowCredentials[0].id;
            simulated = true;
          } else {
            throw new Error('Passkey verification was cancelled or blocked in this browser.');
          }
        }
      } else if (previewMode) {
        credentialId = opts.allowCredentials[0].id;
        simulated = true;
      } else {
        throw new Error('WebAuthn Passkeys are not supported in this browser.');
      }

      const res = await api.verifyPasskeyLogin({
        challenge_id: opts.challenge_id,
        credential_id: credentialId,
        mfa_token: mfaToken,
        simulated,
      });
      handleAuthResponse(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Passkey authentication failed');
    } finally {
      setSolving(false);
    }
  };

  const handleVerifyMfaEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaState) return;
    setError('');
    setSolving(true);
    try {
      const res = await api.verifyMfaEmail(mfaState.token, mfaCode.trim());
      handleAuthResponse(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid verification code');
    } finally {
      setSolving(false);
    }
  };

  const handleResendMfaEmail = async () => {
    if (!mfaState) return;
    setError('');
    try {
      const res = await api.sendLoginMfaEmail(mfaState.token);
      if (res.preview_code) {
        setMfaCode(res.preview_code);
        setMfaNote(`New preview code: ${res.preview_code}`);
      } else {
        setMfaNote(`Verification code sent to ${res.email_masked}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend code');
    }
  };

  const wimotekMeta = oauthProviders.find((p) => p.provider === 'wimotek');
  const wimotekConfigured = Boolean(wimotekMeta?.configured);
  const showOAuthPrimary = wimotekConfigured && !useLocalFallback;
  const issuerHost = (() => {
    if (!wimotekMeta?.issuer) return '';
    try {
      return new URL(wimotekMeta.issuer).host;
    } catch {
      return wimotekMeta.issuer;
    }
  })();
  const configuredDirect = oauthProviders.filter((p) => p.provider !== 'wimotek' && p.configured);

  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-12 bg-[#F8FAFC] text-slate-900">
      <FloatingToast error={error} onDismissError={() => setError('')} />

      {/* Classic Dark Slate Left Brand & Architecture Column */}
      <aside className="lg:col-span-5 bg-[#0F172A] text-slate-100 p-7 sm:p-10 lg:p-12 flex flex-col justify-between gap-10 border-b lg:border-b-0 lg:border-e border-slate-800">
        <div className="space-y-10">
          {/* Top Brand Bar + Dark Language Selector */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 min-w-0">
              <img
                src="/favicon.svg"
                alt=""
                aria-hidden="true"
                className="w-7 h-7 rounded-md shrink-0"
              />
              <span className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap">
                {t.app.name}
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <Globe className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
              <label htmlFor="auth-lang" className="sr-only">
                Language
              </label>
              <select
                id="auth-lang"
                value={locale}
                onChange={(e) => onLocaleChange(e.target.value as LocaleCode)}
                className="bg-slate-800 text-slate-100 text-xs font-medium rounded-lg px-2.5 py-1.5 border border-slate-700 hover:border-slate-600 focus:outline-none focus:border-teal-400 cursor-pointer"
              >
                {LOCALE_OPTIONS.map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Editorial Dark Hero */}
          <div className="space-y-4">
            <h1 className="font-display text-3xl lg:text-[34px] font-bold tracking-tight text-white leading-[1.18] text-balance">
              {t.app.tagline}
            </h1>
            <p className="text-sm text-slate-300 leading-relaxed max-w-md">
              {t.app.subtitle}
            </p>
          </div>

          {/* Architectural Capability Grid */}
          <div className="pt-8 border-t border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-white">
                <ShieldCheck className="w-4 h-4 text-teal-400 shrink-0" aria-hidden="true" />
                <span>Two-Tier ECDSA P-256 CA</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Offline-style Root CA signing an operational Intermediate CA with CRL &amp; OCSP.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-white">
                <Layers className="w-4 h-4 text-teal-400 shrink-0" aria-hidden="true" />
                <span>8 Enterprise Templates</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                TLS Server, PDF Signing, Entra ID CBA, Code Signing, S/MIME, Wi-Fi EAP &amp; IoT.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-white">
                <KeyRound className="w-4 h-4 text-teal-400 shrink-0" aria-hidden="true" />
                <span>Vault, ACME v2 &amp; MCP</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Scoped user tokens, ACME EAB proxy, OpenBao/Vault PKI routes, and MCP server.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-white">
                <Webhook className="w-4 h-4 text-teal-400 shrink-0" aria-hidden="true" />
                <span>Expiry Alerts &amp; Webhook</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Automated expiration scans &amp; personal ServerChan-compatible webhook relay.
              </p>
            </div>
          </div>
        </div>

        <div className="pt-6 border-t border-slate-800 text-[11px] font-mono text-slate-400 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span>Go 1.24 · CGO_ENABLED=0</span>
          <span aria-hidden="true">·</span>
          <span>RFC 5280 / 6960 / 8555</span>
          <span aria-hidden="true">·</span>
          <span>SQLite &amp; MySQL</span>
        </div>
      </aside>

      {/* Right Authentication / First-Run Wizard Column */}
      <main className="lg:col-span-7 flex items-center justify-center p-6 sm:p-10 lg:p-12">
        <div
          className={`w-full ${
            needsSetup ? 'max-w-xl' : 'max-w-md'
          } rounded-2xl border border-slate-200 bg-white p-7 sm:p-8 shadow-sm space-y-6`}
        >
          {loadingStatus ? (
            <div className="space-y-4 py-6" aria-busy="true">
              <div className="h-6 w-2/3 bg-slate-100 rounded animate-pulse" />
              <div className="h-4 w-full bg-slate-100 rounded animate-pulse" />
              <div className="h-10 w-full bg-slate-100 rounded animate-pulse" />
              <div className="h-10 w-full bg-slate-100 rounded animate-pulse" />
            </div>
          ) : needsSetup ? (
            <>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-teal-700 text-xs font-semibold">
                  <KeyRound className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>{t.wizard.badge}</span>
                </div>
                <h2 className="font-display text-2xl font-bold text-slate-900 wrap-anywhere">
                  {t.wizard.title}
                </h2>
                <p className="text-sm text-slate-600 leading-relaxed wrap-anywhere">
                  {t.wizard.subtitle}
                </p>
              </div>

              {/* 3-Step Progress Indicator */}
              <ol className="grid grid-cols-3 gap-2 border-y border-slate-100 py-3 text-xs">
                {([
                  [1, t.wizard.step1],
                  [2, t.wizard.step2],
                  [3, t.wizard.step3],
                ] as Array<[1 | 2 | 3, string]>).map(([stepNum, label]) => {
                  const active = wizardStep === stepNum;
                  const done = wizardStep > stepNum;
                  return (
                    <li
                      key={stepNum}
                      className={`flex items-center gap-1.5 font-medium wrap-anywhere ${
                        active ? 'text-teal-700' : done ? 'text-emerald-700' : 'text-slate-400'
                      }`}
                    >
                      {done && <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                      <span>{label}</span>
                    </li>
                  );
                })}
              </ol>

              <form onSubmit={handleWizardComplete} className="space-y-4">
                {wizardStep === 1 && (
                  <div className="space-y-4">
                    <div>
                      <label htmlFor="wiz-org" className="block text-xs font-medium text-slate-700 mb-1.5">
                        {t.wizard.orgName}
                      </label>
                      <input
                        id="wiz-org"
                        type="text"
                        required
                        value={orgName}
                        onChange={(e) => setOrgName(e.target.value)}
                        placeholder={t.wizard.orgNamePlaceholder}
                        className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label htmlFor="wiz-url" className="block text-xs font-medium text-slate-700 mb-1.5">
                        {t.wizard.baseUrl}
                      </label>
                      <input
                        id="wiz-url"
                        type="url"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder="https://ca.company.internal"
                        className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                      />
                      <p className="mt-1 text-xs text-slate-500 wrap-anywhere">{t.wizard.baseUrlHint}</p>
                    </div>
                    <div>
                      <label htmlFor="wiz-lang" className="block text-xs font-medium text-slate-700 mb-1.5">
                        {t.wizard.defaultLang}
                      </label>
                      <select
                        id="wiz-lang"
                        value={locale}
                        onChange={(e) => onLocaleChange(e.target.value as LocaleCode)}
                        className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                      >
                        {LOCALE_OPTIONS.map((opt) => (
                          <option key={opt.code} value={opt.code}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                {wizardStep === 2 && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                      <div>
                        <label htmlFor="setup-user" className="block text-xs font-medium text-slate-700 mb-1.5">
                          {t.auth.username}
                        </label>
                        <input
                          id="setup-user"
                          type="text"
                          required
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          autoComplete="username"
                          className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label htmlFor="setup-fullname" className="block text-xs font-medium text-slate-700 mb-1.5">
                          {t.wizard.fullName}
                        </label>
                        <input
                          id="setup-fullname"
                          type="text"
                          value={fullName}
                          onChange={(e) => setFullName(e.target.value)}
                          placeholder="Alex Morgan"
                          className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label htmlFor="setup-pass" className="block text-xs font-medium text-slate-700 mb-1.5">
                          {t.auth.password}
                        </label>
                        <input
                          id="setup-pass"
                          type="password"
                          required
                          minLength={8}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          autoComplete="new-password"
                          className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label htmlFor="setup-confirm" className="block text-xs font-medium text-slate-700 mb-1.5">
                          {t.auth.confirmPassword}
                        </label>
                        <input
                          id="setup-confirm"
                          type="password"
                          required
                          minLength={8}
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          autoComplete="new-password"
                          className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="pt-2 border-t border-slate-100 space-y-3">
                      <p className="text-xs text-slate-500 wrap-anywhere">{t.wizard.adminProfileHint}</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label htmlFor="setup-email" className="block text-xs font-medium text-slate-700 mb-1">
                            {t.wizard.email}
                          </label>
                          <input
                            id="setup-email"
                            type="email"
                            value={email}
                            onChange={(e) => {
                              setEmail(e.target.value);
                              if (!upn) setUpn(e.target.value);
                            }}
                            placeholder="admin@company.com"
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                          />
                        </div>
                        <div>
                          <label htmlFor="setup-dept" className="block text-xs font-medium text-slate-700 mb-1">
                            {t.wizard.department}
                          </label>
                          <input
                            id="setup-dept"
                            type="text"
                            value={department}
                            onChange={(e) => setDepartment(e.target.value)}
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                          />
                        </div>
                        <div className="sm:col-span-2 grid grid-cols-3 gap-2.5">
                          <div>
                            <label htmlFor="setup-c" className="block text-xs font-medium text-slate-700 mb-1">
                              {t.wizard.country}
                            </label>
                            <input
                              id="setup-c"
                              type="text"
                              maxLength={2}
                              value={country}
                              onChange={(e) => setCountry(e.target.value.toUpperCase())}
                              placeholder="US"
                              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono uppercase text-slate-900 focus:border-teal-600 focus:outline-none"
                            />
                          </div>
                          <div>
                            <label htmlFor="setup-st" className="block text-xs font-medium text-slate-700 mb-1">
                              {t.wizard.province}
                            </label>
                            <input
                              id="setup-st"
                              type="text"
                              value={province}
                              onChange={(e) => setProvince(e.target.value)}
                              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                            />
                          </div>
                          <div>
                            <label htmlFor="setup-l" className="block text-xs font-medium text-slate-700 mb-1">
                              {t.wizard.locality}
                            </label>
                            <input
                              id="setup-l"
                              type="text"
                              value={locality}
                              onChange={(e) => setLocality(e.target.value)}
                              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {wizardStep === 3 && (
                  <div className="space-y-4">
                    <p className="text-xs text-slate-600 leading-relaxed wrap-anywhere">
                      {t.wizard.notifyOptionalHint}
                    </p>
                    <div>
                      <label htmlFor="wiz-notify-type" className="block text-xs font-medium text-slate-700 mb-1.5">
                        {t.wizard.notifyType}
                      </label>
                      <select
                        id="wiz-notify-type"
                        value={notifyType}
                        onChange={(e) => setNotifyType(e.target.value as NotifyChannelType | '')}
                        className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                      >
                        <option value="">{t.wizard.notifySkip}</option>
                        <option value="serverchan">{t.notifications.types.serverchan}</option>
                        <option value="telegram">{t.notifications.types.telegram}</option>
                        <option value="email">{t.notifications.types.email}</option>
                        <option value="webhook">{t.notifications.types.webhook}</option>
                      </select>
                    </div>

                    {notifyType && (
                      <div className="space-y-3 pt-2 border-t border-slate-100">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label htmlFor="wiz-notify-name" className="block text-xs font-medium text-slate-700 mb-1">
                              {t.wizard.notifyName}
                            </label>
                            <input
                              id="wiz-notify-name"
                              type="text"
                              value={notifyName}
                              onChange={(e) => setNotifyName(e.target.value)}
                              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                            />
                          </div>
                          <div>
                            <label htmlFor="wiz-days" className="block text-xs font-medium text-slate-700 mb-1">
                              {t.wizard.advanceDays}
                            </label>
                            <input
                              id="wiz-days"
                              type="text"
                              value={advanceDaysText}
                              onChange={(e) => setAdvanceDaysText(e.target.value)}
                              placeholder="30, 7, 1"
                              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                            />
                          </div>
                        </div>

                        {notifyType === 'serverchan' && (
                          <div>
                            <label htmlFor="wiz-sendkey" className="block text-xs font-medium text-slate-700 mb-1">
                              {t.notifications.fields.sendKey}
                            </label>
                            <input
                              id="wiz-sendkey"
                              type="password"
                              value={sendKey}
                              onChange={(e) => setSendKey(e.target.value)}
                              placeholder="SCT..."
                              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                            />
                          </div>
                        )}

                        {notifyType === 'telegram' && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <label htmlFor="wiz-tg-token" className="block text-xs font-medium text-slate-700 mb-1">
                                {t.notifications.fields.botToken}
                              </label>
                              <input
                                id="wiz-tg-token"
                                type="password"
                                value={botToken}
                                onChange={(e) => setBotToken(e.target.value)}
                                placeholder="123456:ABC-DEF..."
                                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                              />
                            </div>
                            <div>
                              <label htmlFor="wiz-tg-chat" className="block text-xs font-medium text-slate-700 mb-1">
                                {t.notifications.fields.chatId}
                              </label>
                              <input
                                id="wiz-tg-chat"
                                type="text"
                                value={chatId}
                                onChange={(e) => setChatId(e.target.value)}
                                placeholder="-1001234567890"
                                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                              />
                            </div>
                          </div>
                        )}

                        {notifyType === 'email' && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <label htmlFor="wiz-smtp-host" className="block text-xs font-medium text-slate-700 mb-1">
                                {t.notifications.fields.smtpHost}
                              </label>
                              <input
                                id="wiz-smtp-host"
                                type="text"
                                value={smtpHost}
                                onChange={(e) => setSmtpHost(e.target.value)}
                                placeholder="smtp.company.com"
                                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                              />
                            </div>
                            <div>
                              <label htmlFor="wiz-smtp-port" className="block text-xs font-medium text-slate-700 mb-1">
                                {t.notifications.fields.smtpPort}
                              </label>
                              <input
                                id="wiz-smtp-port"
                                type="number"
                                value={smtpPort}
                                onChange={(e) => setSmtpPort(Number(e.target.value))}
                                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                              />
                            </div>
                            <div>
                              <label htmlFor="wiz-smtp-user" className="block text-xs font-medium text-slate-700 mb-1">
                                {t.notifications.fields.smtpUser}
                              </label>
                              <input
                                id="wiz-smtp-user"
                                type="text"
                                value={smtpUser}
                                onChange={(e) => setSmtpUser(e.target.value)}
                                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                              />
                            </div>
                            <div>
                              <label htmlFor="wiz-smtp-pass" className="block text-xs font-medium text-slate-700 mb-1">
                                {t.notifications.fields.smtpPass}
                              </label>
                              <input
                                id="wiz-smtp-pass"
                                type="password"
                                value={smtpPass}
                                onChange={(e) => setSmtpPass(e.target.value)}
                                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                              />
                            </div>
                            <div>
                              <label htmlFor="wiz-from" className="block text-xs font-medium text-slate-700 mb-1">
                                {t.notifications.fields.fromEmail}
                              </label>
                              <input
                                id="wiz-from"
                                type="email"
                                value={fromEmail}
                                onChange={(e) => setFromEmail(e.target.value)}
                                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                              />
                            </div>
                            <div>
                              <label htmlFor="wiz-to" className="block text-xs font-medium text-slate-700 mb-1">
                                {t.notifications.fields.toEmails}
                              </label>
                              <input
                                id="wiz-to"
                                type="text"
                                value={toEmails}
                                onChange={(e) => setToEmails(e.target.value)}
                                placeholder="ops@company.com"
                                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                              />
                            </div>
                          </div>
                        )}

                        {notifyType === 'webhook' && (
                          <div className="space-y-3">
                            <div>
                              <label htmlFor="wiz-wh-url" className="block text-xs font-medium text-slate-700 mb-1">
                                {t.notifications.fields.webhookUrl}
                              </label>
                              <input
                                id="wiz-wh-url"
                                type="url"
                                value={webhookUrl}
                                onChange={(e) => setWebhookUrl(e.target.value)}
                                placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
                                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                              />
                            </div>
                            <div>
                              <label htmlFor="wiz-wh-sec" className="block text-xs font-medium text-slate-700 mb-1">
                                {t.notifications.fields.webhookSecret}
                              </label>
                              <input
                                id="wiz-wh-sec"
                                type="password"
                                value={webhookSecret}
                                onChange={(e) => setWebhookSecret(e.target.value)}
                                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
                  {wizardStep > 1 ? (
                    <button
                      type="button"
                      onClick={() => {
                        setError('');
                        setWizardStep((prev) => (prev === 3 ? 2 : 1));
                      }}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium cursor-pointer"
                    >
                      <ArrowLeft className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>{t.wizard.back}</span>
                    </button>
                  ) : (
                    <span />
                  )}

                  {wizardStep < 3 ? (
                    <button
                      type="button"
                      onClick={handleWizardNext}
                      className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg bg-[#0F766E] hover:bg-[#115E59] text-white text-sm font-medium transition-colors cursor-pointer"
                    >
                      <span>{t.wizard.next}</span>
                      <ArrowRight className="w-4 h-4 shrink-0" aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={solving}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white text-sm font-medium transition-colors cursor-pointer"
                    >
                      <span>{solving ? t.wizard.completing : t.wizard.finish}</span>
                    </button>
                  )}
                </div>
              </form>
            </>
          ) : mfaState ? (
            <div className="space-y-5">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-teal-700 text-xs font-semibold">
                  <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>2FA Verification</span>
                </div>
                <h2 className="font-display text-2xl font-bold text-slate-900">{t.auth.mfaTitle}</h2>
                <p className="text-sm text-slate-600">{t.auth.mfaDesc}</p>
              </div>

              {mfaState.methods.includes('passkey') && (
                <button
                  type="button"
                  disabled={solving}
                  onClick={() => handlePasskeyAuth(mfaState.token)}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-sm font-medium px-4 py-2.5 cursor-pointer"
                >
                  <Fingerprint className="w-4 h-4 text-teal-400" aria-hidden="true" />
                  <span>{t.auth.mfaUsePasskey}</span>
                </button>
              )}

              {mfaState.methods.includes('email') && (
                <form onSubmit={handleVerifyMfaEmail} className="space-y-3 pt-2 border-t border-slate-100">
                  <div className="flex items-center justify-between text-xs text-slate-600">
                    <span className="inline-flex items-center gap-1.5 font-medium text-slate-700">
                      <Mail className="w-3.5 h-3.5 text-teal-700" aria-hidden="true" />
                      <span>{t.auth.mfaUseEmail}</span>
                    </span>
                    {mfaState.emailMasked && <span className="font-mono">{mfaState.emailMasked}</span>}
                  </div>
                  <input
                    type="text"
                    required
                    maxLength={6}
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                    placeholder={t.auth.mfaCodePlaceholder}
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm font-mono tracking-widest text-slate-900 focus:border-teal-600 focus:outline-none"
                  />
                  {mfaNote && <div className="text-xs text-teal-700 font-mono">{mfaNote}</div>}
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={solving}
                      className="flex-1 bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white font-medium text-sm rounded-lg px-4 py-2.5 cursor-pointer"
                    >
                      {t.auth.mfaVerifyButton}
                    </button>
                    <button
                      type="button"
                      onClick={handleResendMfaEmail}
                      className="px-3 py-2.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                    >
                      {t.auth.mfaResendEmail}
                    </button>
                  </div>
                </form>
              )}

              <button
                type="button"
                onClick={() => {
                  setMfaState(null);
                  setError('');
                }}
                className="text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
              >
                ← {t.auth.mfaBack}
              </button>
            </div>
          ) : showOAuthPrimary ? (
            /* Separated OAuth-First View when wimotek/OAuth is enabled */
            <div className="space-y-5">
              <div className="space-y-2">
                <h2 className="font-display text-2xl font-bold text-slate-900 wrap-anywhere">
                  {t.auth.signInTitle}
                </h2>
                <p className="text-sm text-slate-600 leading-relaxed wrap-anywhere">
                  {t.auth.wimotekOAuthSubtitle}
                </p>
              </div>

              <div className="space-y-3">
                <button
                  type="button"
                  disabled={solving}
                  onClick={() => handleSocialLogin('wimotek')}
                  className="w-full inline-flex items-center justify-center gap-2.5 rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white font-semibold text-sm px-4 py-3 transition-colors cursor-pointer"
                >
                  <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>{t.auth.signInWithWimotekOAuth}</span>
                  <ArrowRight className="w-4 h-4 shrink-0" aria-hidden="true" />
                </button>

                {issuerHost && (
                  <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 font-mono px-0.5">
                    <span className="truncate" title={wimotekMeta?.issuer}>
                      IdP: {issuerHost}
                    </span>
                    <span className="shrink-0 text-teal-700 font-sans font-medium">
                      OIDC · PKCE S256
                    </span>
                  </div>
                )}

                <button
                  type="button"
                  disabled={solving}
                  onClick={() => handlePasskeyAuth()}
                  className="w-full inline-flex items-center justify-center gap-2 border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 font-medium text-xs rounded-lg px-4 py-2.5 transition-colors cursor-pointer"
                >
                  <Fingerprint className="w-4 h-4 text-teal-700 shrink-0" aria-hidden="true" />
                  <span>{t.auth.signInWithPasskey}</span>
                </button>

                {configuredDirect.length > 0 && (
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    {configuredDirect.map((p) => (
                      <button
                        key={p.provider}
                        type="button"
                        onClick={() => handleSocialLogin(p.provider)}
                        className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-2.5 py-2 text-xs font-medium text-slate-800 transition-colors cursor-pointer truncate"
                      >
                        <span className="truncate">{p.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="pt-4 border-t border-slate-200 text-center">
                <button
                  type="button"
                  onClick={() => {
                    setUseLocalFallback(true);
                    setError('');
                  }}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-teal-700 transition-colors cursor-pointer"
                >
                  <Lock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>{t.auth.oauthUnavailableSwitchLocal}</span>
                </button>
              </div>
            </div>
          ) : (
            /* Classic Local Sign-In / Register View (default when OAuth is off, or fallback when OAuth is unavailable) */
            <div className="space-y-5">
              <div className="space-y-2">
                {wimotekConfigured && (
                  <button
                    type="button"
                    onClick={() => {
                      setUseLocalFallback(false);
                      setError('');
                    }}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-700 hover:text-teal-800 transition-colors cursor-pointer"
                  >
                    <ArrowLeft className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>{t.auth.backToOAuthLogin}</span>
                  </button>
                )}
                <h2 className="font-display text-2xl font-bold text-slate-900 wrap-anywhere">
                  {t.auth.signInTitle}
                </h2>
                <p className="text-sm text-slate-600 leading-relaxed wrap-anywhere">
                  {wimotekConfigured ? t.auth.localFallbackNotice : t.auth.signInDesc}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => {
                    setAuthTab('login');
                    setError('');
                  }}
                  className={`py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                    authTab === 'login' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {t.auth.signInTab}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthTab('register');
                    setError('');
                  }}
                  className={`py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                    authTab === 'register' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {t.auth.registerTab}
                </button>
              </div>

              {authTab === 'login' ? (
                <form onSubmit={handleLogin} className="space-y-4">
                  <div>
                    <label htmlFor="login-user" className="block text-xs font-medium text-slate-700 mb-1.5">
                      {t.auth.username}
                    </label>
                    <input
                      id="login-user"
                      type="text"
                      required
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="username"
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label htmlFor="login-pass" className="block text-xs font-medium text-slate-700 mb-1.5">
                      {t.auth.password}
                    </label>
                    <input
                      id="login-pass"
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                    />
                  </div>

                  {challenge && (
                    <div className="flex items-center justify-between text-[11px] font-mono text-slate-500">
                      <span>HMAC SHA-256 PoW</span>
                      <span>
                        {challenge.difficulty} {t.auth.powBits}
                      </span>
                    </div>
                  )}

                  {powNote && (
                    <div className="text-xs font-mono text-slate-600 wrap-anywhere">{powNote}</div>
                  )}

                  <button
                    type="submit"
                    disabled={solving}
                    className="w-full bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white font-semibold text-sm rounded-lg px-4 py-2.5 transition-colors cursor-pointer"
                  >
                    {solving ? t.auth.solvingPow : t.auth.signInButton}
                  </button>

                  <button
                    type="button"
                    disabled={solving}
                    onClick={() => handlePasskeyAuth()}
                    className="w-full inline-flex items-center justify-center gap-2 border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 font-medium text-xs rounded-lg px-4 py-2.5 transition-colors cursor-pointer"
                  >
                    <Fingerprint className="w-4 h-4 text-teal-700 shrink-0" aria-hidden="true" />
                    <span>{t.auth.signInWithPasskey}</span>
                  </button>
                </form>
              ) : (
                <form onSubmit={handleRegister} className="space-y-3.5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="reg-user" className="block text-xs font-medium text-slate-700 mb-1">
                        {t.auth.username}
                      </label>
                      <input
                        id="reg-user"
                        type="text"
                        required
                        value={regUsername}
                        onChange={(e) => setRegUsername(e.target.value)}
                        placeholder="jdoe"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label htmlFor="reg-name" className="block text-xs font-medium text-slate-700 mb-1">
                        {t.wizard.fullName}
                      </label>
                      <input
                        id="reg-name"
                        type="text"
                        value={regFullName}
                        onChange={(e) => setRegFullName(e.target.value)}
                        placeholder="Jane Doe"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="reg-email" className="block text-xs font-medium text-slate-700 mb-1">
                      {t.auth.email}
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="reg-email"
                        type="email"
                        required
                        value={regEmail}
                        onChange={(e) => setRegEmail(e.target.value)}
                        placeholder="jane@company.com"
                        className="flex-1 min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                      />
                      <button
                        type="button"
                        disabled={sendingRegCode}
                        onClick={handleSendRegCode}
                        className="px-3 py-2 rounded-lg border border-teal-700 text-teal-700 hover:bg-teal-50 text-xs font-semibold whitespace-nowrap cursor-pointer disabled:opacity-50"
                      >
                        {t.auth.sendEmailCode}
                      </button>
                    </div>
                    {regCodeSentNote && (
                      <div className="mt-1 text-xs font-mono text-teal-700 wrap-anywhere">{regCodeSentNote}</div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="reg-code" className="block text-xs font-medium text-slate-700 mb-1">
                        {t.auth.emailCode}
                      </label>
                      <input
                        id="reg-code"
                        type="text"
                        required
                        maxLength={6}
                        value={regEmailCode}
                        onChange={(e) => setRegEmailCode(e.target.value)}
                        placeholder="123456"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono tracking-widest text-slate-900 focus:border-teal-600 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label htmlFor="reg-pass" className="block text-xs font-medium text-slate-700 mb-1">
                        {t.auth.password}
                      </label>
                      <input
                        id="reg-pass"
                        type="password"
                        required
                        minLength={8}
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={solving}
                    className="w-full bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white font-semibold text-sm rounded-lg px-4 py-2.5 transition-colors cursor-pointer"
                  >
                    {solving ? t.auth.solvingPow : t.auth.registerButton}
                  </button>
                </form>
              )}

              {configuredDirect.length > 0 && (
                <div className="pt-3 border-t border-slate-100 grid grid-cols-3 gap-2">
                  {configuredDirect.map((p) => (
                    <button
                      key={p.provider}
                      type="button"
                      onClick={() => handleSocialLogin(p.provider)}
                      className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white hover:bg-slate-50 px-2.5 py-2 text-xs font-medium text-slate-800 transition-colors cursor-pointer truncate"
                    >
                      <span className="truncate">{p.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Rendered ONLY when hosted inside the live interactive preview harness */}
          {!loadingStatus && previewMode && (
            <div className="pt-5 border-t border-slate-200 space-y-3">
              <div className="text-xs text-slate-500 wrap-anywhere">{t.auth.demoQuickLoginHint}</div>
              <div className="flex flex-col gap-2.5">
                <button
                  type="button"
                  disabled={solving}
                  onClick={() => handleDemoQuickLogin('demo-admin')}
                  className="w-full inline-flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white font-medium text-xs rounded-lg px-4 py-2.5 transition-colors cursor-pointer"
                >
                  <Zap className="w-3.5 h-3.5 text-teal-400 shrink-0" aria-hidden="true" />
                  <span>{t.auth.demoQuickLoginAdmin}</span>
                </button>
                <button
                  type="button"
                  disabled={solving}
                  onClick={() => handleDemoQuickLogin('alice')}
                  className="w-full inline-flex items-center justify-center gap-2 bg-slate-100 hover:bg-slate-200 disabled:opacity-60 text-slate-900 font-medium text-xs rounded-lg px-4 py-2.5 transition-colors cursor-pointer"
                >
                  <UserCheck className="w-3.5 h-3.5 text-teal-700 shrink-0" aria-hidden="true" />
                  <span>{t.auth.demoQuickLoginUser}</span>
                </button>
              </div>
              <button
                type="button"
                disabled={downloadingBundle}
                onClick={handleDownloadBundle}
                className="w-full inline-flex items-center justify-center gap-2 border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-60 text-slate-800 font-medium text-xs rounded-lg px-4 py-2.5 transition-colors cursor-pointer"
              >
                <Archive className="w-3.5 h-3.5 text-slate-600 shrink-0" aria-hidden="true" />
                <span>{downloadingBundle ? '...' : t.auth.downloadBundle}</span>
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
