import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Activity,
  BarChart2,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  FileCode2,
  Globe,
  Globe2,
  Link2,
  Lock,
  LogOut,
  Plug,
  Save,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Unlock,
  Unplug,
  Users,
  X,
} from 'lucide-react';
import {
  AntiBotCaptcha,
  EMPTY_ANTIBOT_SOLUTION,
  type AntiBotChallengePayload,
  type AntiBotSolution,
} from './components/AntiBotCaptcha';
import { DomainsPanel, type ProductionDomain } from './components/DomainsPanel';
import { UsersPanel, type ProductionUser } from './components/UsersPanel';
import { ApiMcpPanel, type ProductionApiKey } from './components/ApiMcpPanel';
import {
  AuditBackupPanel,
  type ProductionAuditLog,
  type ProductionBackupFile,
  type ProductionCronTask,
} from './components/AuditBackupPanel';

interface SetupStatus {
  initialized: boolean;
  locked: boolean;
  oauth_active: boolean;
  oauth_auto_redirect: boolean;
  oauth_issuer_url: string;
  oauth_client_id: string;
  admin_path: string;
  antibot_mode: 'builtin' | 'turnstile' | 'off';
  turnstile_site_key: string;
}

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'super_admin' | 'admin' | 'member';
  tier: string;
  status: string;
  auth_provider: string;
}

interface ShortLinkItem {
  id: string;
  slug: string;
  domain: string;
  targetUrl: string;
  title: string;
  seoDescription: string;
  seoIndexable: boolean;
  redirectCode: 301 | 302 | 307;
  cacheTtlSeconds: number;
  clicks: number;
  uniqueClicks: number;
  enabled: boolean;
  isSystemProtected: boolean;
  createdAt: string;
}

interface ReferrerSite {
  host: string;
  channel: string;
  clicks: number;
  uniqueVisitors: number;
  share: number;
}

interface ClickLog {
  id: string;
  slug?: string;
  domain?: string;
  referrerHost: string;
  referrerUrl: string;
  channel: string;
  countryCode: string;
  region: string;
  device: string;
  redirectCode?: number;
  timestamp: string;
}

interface InterstitialConfig {
  preset: 'safety_gate' | 'branded_countdown' | 'minimal_fast' | 'promo_wechat';
  countdown_seconds: number;
  brand_name: string;
  headline: string;
  subtitle: string;
  cta_text: string;
  safety_tip: string;
  primary_color: string;
  show_target_url: boolean;
  show_security_badge: boolean;
  show_wechat_tip: boolean;
  use_custom_html: boolean;
  custom_html: string;
}

interface SettingsState {
  issuerUrl: string;
  adminPath: string;
  rootRedirectEnabled: boolean;
  rootRedirectUrl: string;
  oauthEnabled: boolean;
  oauthConfigured: boolean;
  oauthSecretHint?: string;
  oauthWebhookSecretConfigured?: boolean;
  oauthAutoRedirect: boolean;
  oauthIssuerUrl: string;
  oauthClientId: string;
  oauthRedirectUri: string;
  antiBotMode: 'builtin' | 'turnstile' | 'off';
  turnstileSiteKey: string;
  loginRateLimitMax: number;
  loginRateLimitWindowMin: number;
  redirectRateLimitPerMin: number;
  blockedRequestsCount: number;
  allowRegistration?: boolean;
  seoIndexNowKey?: string;
}

type Tab = 'links' | 'analytics' | 'domains' | 'interstitial' | 'users' | 'api_mcp' | 'audit_cron' | 'settings';

const PRESETS: { id: InterstitialConfig['preset']; label: string; desc: string; defaults: Partial<InterstitialConfig> }[] = [
  {
    id: 'safety_gate',
    label: '安全外链确认页（知乎/GitHub）',
    desc: '提示离开本站并展示目标域名与 HTTPS 安全标识',
    defaults: {
      countdown_seconds: 3,
      headline: '您即将离开当前站点，前往外部链接',
      subtitle: '请确认目标网站域名可信，谨防钓鱼与账号风险。',
      cta_text: '继续前往目标网站',
      safety_tip: '安全提示：目标链接已通过协议校验，请勿在陌生页面输入敏感密码。',
      primary_color: '#2563EB',
      show_target_url: true,
      show_security_badge: true,
      show_wechat_tip: false,
    },
  },
  {
    id: 'branded_countdown',
    label: '品牌倒计时过渡页',
    desc: '品牌标题 + 动态进度条倒计时自动跳转',
    defaults: {
      countdown_seconds: 4,
      headline: '正在为您安全跳转至目标页面',
      subtitle: '精选链接高速直达，马上呈现完整内容。',
      cta_text: '立即前往',
      safety_tip: '由 wimotek/url 提供企业级短链安全加速服务。',
      primary_color: '#2563EB',
      show_target_url: true,
      show_security_badge: true,
      show_wechat_tip: false,
    },
  },
  {
    id: 'minimal_fast',
    label: '极简高速跳转页（Linear 风格）',
    desc: '清爽无冗余，1-2 秒自动直达目标页面',
    defaults: {
      countdown_seconds: 2,
      headline: '正在跳转…',
      subtitle: '如果浏览器未自动跳转，请点击下方按钮。',
      cta_text: '手动跳转',
      safety_tip: '',
      primary_color: '#0F172A',
      show_target_url: true,
      show_security_badge: false,
      show_wechat_tip: false,
    },
  },
  {
    id: 'promo_wechat',
    label: '微信防拦截 / 公告引导页',
    desc: '展示微信右上角在默认浏览器打开引导与活动公告',
    defaults: {
      countdown_seconds: 5,
      headline: '专属内容已准备就绪',
      subtitle: '如在微信内无法直接打开，请点击右上角选择“在默认浏览器中打开”。',
      cta_text: '立即打开链接',
      safety_tip: '公告：点击下方按钮即可直达官方页面。',
      primary_color: '#059669',
      show_target_url: true,
      show_security_badge: true,
      show_wechat_tip: true,
    },
  },
];

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildPreviewHtml(cfg: InterstitialConfig): string {
  const color = /^#[0-9a-fA-F]{6}$/.test(cfg.primary_color) ? cfg.primary_color : '#2563EB';
  const targetUrl = 'https://wimotek.com/docs/short-links';
  const targetHost = 'wimotek.com';
  const base =
    cfg.use_custom_html && cfg.custom_html.trim()
      ? cfg.custom_html
      : `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a}.wx{width:100%;max-width:440px;margin-bottom:12px;padding:10px 14px;border-radius:10px;background:#0f172a;color:#fff;font-size:12px}.card{width:100%;max-width:440px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;box-shadow:0 12px 30px rgba(15,23,42,.06)}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;font-size:13px;font-weight:700}.badge{font-size:11px;color:#047857;background:#ecfdf5;border:1px solid #a7f3d0;padding:2px 8px;border-radius:6px}h1{margin:0 0 8px;font-size:18px}p{margin:0 0 16px;font-size:13px;color:#475569;line-height:1.6}.dest{padding:11px 12px;border-radius:8px;background:#f8fafc;border:1px solid #e2e8f0;font-family:monospace;font-size:12px;margin-bottom:14px;word-break:break-all}.tip{padding:10px 12px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:12px;margin-bottom:16px}.btn{display:block;width:100%;box-sizing:border-box;text-align:center;padding:10px 16px;border-radius:8px;background:{{PRIMARY_COLOR}};color:#fff;text-decoration:none;font-size:13px;font-weight:600}</style></head><body>{{WECHAT_TIP_BLOCK}}<div class="card"><div class="top"><span>{{BRAND_NAME}}</span>{{SECURITY_BADGE}}</div><h1>{{HEADLINE}}</h1><p>{{SUBTITLE}}</p>{{TARGET_URL_BLOCK}}{{SAFETY_TIP_BLOCK}}<a class="btn" href="{{TARGET_URL}}">{{CTA_TEXT}} ({{COUNTDOWN}}s)</a></div></body></html>`;

  return base
    .replaceAll('{{BRAND_NAME}}', escapeHtml(cfg.brand_name))
    .replaceAll('{{TITLE}}', escapeHtml('目标页面示例'))
    .replaceAll('{{HEADLINE}}', escapeHtml(cfg.headline))
    .replaceAll('{{SUBTITLE}}', escapeHtml(cfg.subtitle))
    .replaceAll('{{CTA_TEXT}}', escapeHtml(cfg.cta_text))
    .replaceAll('{{SAFETY_TIP}}', escapeHtml(cfg.safety_tip))
    .replaceAll('{{TARGET_URL}}', escapeHtml(targetUrl))
    .replaceAll('{{TARGET_HOST}}', escapeHtml(targetHost))
    .replaceAll('{{SHORT_URL}}', escapeHtml('https://u.wimotek.com/demo'))
    .replaceAll('{{COUNTDOWN}}', String(cfg.countdown_seconds))
    .replaceAll('{{PRIMARY_COLOR}}', color)
    .replaceAll('{{SECURITY_BADGE}}', cfg.show_security_badge ? '<span class="badge">HTTPS 安全校验通过</span>' : '')
    .replaceAll('{{TARGET_URL_BLOCK}}', cfg.show_target_url ? `<div class="dest"><strong>${targetHost}</strong><br/>${targetUrl}</div>` : '')
    .replaceAll('{{SAFETY_TIP_BLOCK}}', cfg.safety_tip ? `<div class="tip">${escapeHtml(cfg.safety_tip)}</div>` : '')
    .replaceAll('{{WECHAT_TIP_BLOCK}}', cfg.show_wechat_tip ? '<div class="wx">如在微信内无法直接打开，请点击右上角选择“在默认浏览器中打开” ↗</div>' : '')
    .replaceAll('{{COUNTDOWN_SCRIPT}}', '');
}

/**
 * Pure Production Frontend Entry (Zero Simulation / Demo Code).
 * Connects directly to the embedded Go backend APIs.
 */
export default function App() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('links');
  const [loggedOut, setLoggedOut] = useState(() => window.location.pathname === '/logged-out');

  // Setup wizard states
  const [driver, setDriver] = useState<'sqlite3' | 'mysql'>('sqlite3');
  const [dsn, setDsn] = useState('/data/wimotek_url.db');
  const [redisEnabled, setRedisEnabled] = useState(false);
  const [redisAddr, setRedisAddr] = useState('127.0.0.1:6379');
  const [issuerUrl, setIssuerUrl] = useState(window.location.origin);
  const [adminPath, setAdminPath] = useState('/admin');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [feedback, setFeedback] = useState('');

  // Login + 4-Layer High-Strength Anti-AI CAPTCHA states
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [challenge, setChallenge] = useState<AntiBotChallengePayload | null>(null);
  const [captchaSolution, setCaptchaSolution] = useState<AntiBotSolution>(EMPTY_ANTIBOT_SOLUTION);
  const [honeypot, setHoneypot] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');

  // Workspace states
  const [links, setLinks] = useState<ShortLinkItem[]>([]);
  const [domains, setDomains] = useState<ProductionDomain[]>([]);
  const [usersList, setUsersList] = useState<ProductionUser[]>([]);
  const [apiKeys, setApiKeys] = useState<ProductionApiKey[]>([]);
  const [auditData, setAuditData] = useState<{
    auditLogs: ProductionAuditLog[];
    backups: ProductionBackupFile[];
    cronTasks: ProductionCronTask[];
    auditRetentionDays: number;
    backupRetentionCount: number;
    dbDriver: string;
  }>({
    auditLogs: [],
    backups: [],
    cronTasks: [],
    auditRetentionDays: 30,
    backupRetentionCount: 7,
    dbDriver: 'sqlite3',
  });
  const [newTarget, setNewTarget] = useState('');
  const [newDomain, setNewDomain] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newCode, setNewCode] = useState<301 | 302 | 307>(302);
  const [newTtl, setNewTtl] = useState(300);
  const [linkMsg, setLinkMsg] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchCode, setBatchCode] = useState<301 | 302 | 307>(301);
  const [batchTtl, setBatchTtl] = useState(300);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Per-link stats modal
  const [statsModal, setStatsModal] = useState<{
    link: ShortLinkItem;
    totalClicks: number;
    uniqueVisitors: number;
    referrerSites: ReferrerSite[];
    recentClicks: ClickLog[];
  } | null>(null);

  // Analytics state
  const [analytics, setAnalytics] = useState<{
    totalClicks: number;
    uniqueVisitors: number;
    activeLinks: number;
    geoBreakdown: { countryCode: string; region: string; clicks: number }[];
    referrerSites: ReferrerSite[];
    recentClicks: ClickLog[];
  } | null>(null);

  // 307 Interstitial editor state
  const [interstitial, setInterstitial] = useState<InterstitialConfig | null>(null);
  const [interstitialMsg, setInterstitialMsg] = useState('');

  // Settings state
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [showClientSecret, setShowClientSecret] = useState(false);
  const [oauthWebhookSecret, setOauthWebhookSecret] = useState('');
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);
  const [showOAuthAdvanced, setShowOAuthAdvanced] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState('');
  const [oauthConnecting, setOauthConnecting] = useState(false);
  const [oauthConnectError, setOauthConnectError] = useState('');
  const [oauthConnectMsg, setOauthConnectMsg] = useState('');

  const isLocalFallback = new URLSearchParams(window.location.search).get('local') === '1';
  const isAdmin = user?.role === 'super_admin' || user?.role === 'admin';

  const loadChallenge = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/challenge');
      if (!res.ok) return;
      const d = await res.json();
      setChallenge({
        antiBotMode: d.antiBotMode || 'builtin',
        turnstileSiteKey: d.turnstileSiteKey || '',
        challengeToken: d.challengeToken || '',
        captchaSvgDataUri: d.captchaSvgDataUri || '',
        powSalt: d.powSalt || '',
        powDifficulty: typeof d.powDifficulty === 'number' ? d.powDifficulty : 16,
        requireSlider: Boolean(d.requireSlider),
        sliderTarget: typeof d.sliderTarget === 'number' ? d.sliderTarget : 60,
        expiresInSec: typeof d.expiresInSec === 'number' ? d.expiresInSec : 120,
        remainingAttempts: typeof d.remainingAttempts === 'number' ? d.remainingAttempts : 5,
        loginRateLimitMax: typeof d.loginRateLimitMax === 'number' ? d.loginRateLimitMax : 5,
      });
      setCaptchaSolution(EMPTY_ANTIBOT_SOLUTION);
    } catch {
      // ignore
    }
  }, []);

  const loadWorkspace = useCallback(async () => {
    const requests = [
      fetch('/api/links', { credentials: 'include' }),
      fetch('/api/analytics', { credentials: 'include' }),
      fetch('/api/interstitial', { credentials: 'include' }),
      fetch('/api/settings', { credentials: 'include' }),
      fetch('/api/domains', { credentials: 'include' }),
      fetch('/api/apikeys', { credentials: 'include' }),
      isAdmin ? fetch('/api/users', { credentials: 'include' }) : Promise.resolve(null),
      isAdmin ? fetch('/api/audit-cron', { credentials: 'include' }) : Promise.resolve(null),
    ];
    const [lRes, aRes, iRes, sRes, dRes, kRes, uRes, acRes] = await Promise.all(requests);
    if (lRes && lRes.ok) {
      const d = await lRes.json();
      setLinks(d.links || []);
    }
    if (aRes && aRes.ok) {
      setAnalytics(await aRes.json());
    }
    if (iRes && iRes.ok) {
      const d = await iRes.json();
      if (d.interstitial) setInterstitial(d.interstitial);
    }
    if (sRes && sRes.ok) {
      setSettings(await sRes.json());
    }
    if (dRes && dRes.ok) {
      const d = await dRes.json();
      const list: ProductionDomain[] = d.domains || [];
      setDomains(list);
      setNewDomain((prev) => prev || list.find((item) => item.isDefault)?.host || list[0]?.host || '');
    }
    if (kRes && kRes.ok) {
      const d = await kRes.json();
      setApiKeys(d.apiKeys || []);
    }
    if (uRes && uRes.ok) {
      const d = await uRes.json();
      setUsersList(d.users || []);
    }
    if (acRes && acRes.ok) {
      const d = await acRes.json();
      setAuditData({
        auditLogs: d.auditLogs || [],
        backups: d.backups || [],
        cronTasks: d.cronTasks || [],
        auditRetentionDays: d.auditRetentionDays ?? 30,
        backupRetentionCount: d.backupRetentionCount ?? 7,
        dbDriver: d.dbDriver || 'sqlite3',
      });
    }
  }, [isAdmin]);

  useEffect(() => {
    Promise.all([
      fetch('/api/setup/status').then((r) => r.json()).catch(() => null),
      fetch('/api/auth/me', { credentials: 'include' }).then((r) => r.json()).catch(() => null),
    ]).then(([st, me]) => {
      if (st) setStatus(st);
      if (me?.authenticated && me.user) {
        setUser(me.user);
      }
      setAuthChecked(true);
    });
  }, []);

  useEffect(() => {
    if (user) {
      loadWorkspace();
    } else if (status?.initialized && authChecked && !loggedOut) {
      // Mode A: ONLY auto-redirect when OAuth is genuinely configured & enabled!
      if (status.oauth_active && status.oauth_auto_redirect && !isLocalFallback) {
        const ret = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.replace(`/login?returnTo=${ret}`);
        return;
      }
      loadChallenge();
    }
  }, [user, status, authChecked, loggedOut, isLocalFallback, loadChallenge, loadWorkspace]);

  const previewHtml = useMemo(() => (interstitial ? buildPreviewHtml(interstitial) : ''), [interstitial]);

  async function handleTestDb() {
    setFeedback('正在测试数据库连接...');
    const res = await fetch('/api/setup/test-db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driver, dsn }),
    });
    const body = await res.json();
    setFeedback(body.ok ? '数据库连接成功！' : `连接失败: ${body.error}`);
  }

  async function handleCompleteSetup(e: FormEvent) {
    e.preventDefault();
    setFeedback('正在初始化系统...');
    const res = await fetch('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        database: { driver, dsn },
        redis: { enabled: redisEnabled, addr: redisAddr, db: 0 },
        issuer_url: issuerUrl,
        admin_path: adminPath,
        admin_email: adminEmail,
        admin_password: adminPassword,
      }),
    });
    const body = await res.json();
    if (res.ok && body.ok) {
      window.location.replace(body.admin_path || '/admin');
    } else {
      setFeedback(body.error || '初始化失败');
    }
  }

  async function handleLocalLogin(e: FormEvent) {
    e.preventDefault();
    if (status?.antibot_mode !== 'off') {
      if (!captchaSolution.powReady) {
        setLoginError('SHA-256 算力校验尚未完成，请稍候 1 秒后再试。');
        return;
      }
      if (captchaSolution.captchaCode.trim().length < 6) {
        setLoginError('请输入图形验证码中的 6 位字符。');
        return;
      }
      if (challenge?.requireSlider && !captchaSolution.sliderAligned) {
        setLoginError('请拖动滑块对齐至蓝色目标槽位。');
        return;
      }
    }
    setLoginBusy(true);
    setLoginError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: loginEmail,
          password: loginPassword,
          challengeToken: challenge?.challengeToken || '',
          captchaCode: captchaSolution.captchaCode.trim().toUpperCase(),
          powNonce: captchaSolution.powNonce,
          sliderPosition: captchaSolution.sliderPosition,
          sliderDurationMs: captchaSolution.sliderDurationMs,
          sliderTrail: captchaSolution.sliderTrail,
          website: honeypot,
          trustDeviceDays: 14,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoginError(body.error || `登录失败 (HTTP ${res.status})`);
        await loadChallenge();
        return;
      }
      if (body.user) {
        setLoggedOut(false);
        setUser(body.user);
      }
    } catch {
      setLoginError('无法连接认证服务，请检查网络。');
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleLogout() {
    await fetch('/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    setUser(null);
    setLoggedOut(true);
    window.history.replaceState({}, '', '/logged-out');
  }

  async function handleCreateLink(e: FormEvent) {
    e.preventDefault();
    setLinkMsg('');
    const res = await fetch('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        targetUrl: newTarget,
        domain: newDomain,
        slug: newSlug.trim(),
        title: newTitle.trim(),
        redirectCode: isAdmin ? newCode : 302,
        cacheTtlSeconds: isAdmin && newCode === 301 ? newTtl : 0,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setLinkMsg(body.error || '创建失败');
      return;
    }
    setNewTarget('');
    setNewSlug('');
    setNewTitle('');
    setLinkMsg(`已创建短链 /${body.slug} (HTTP ${body.redirectCode})`);
    await loadWorkspace();
  }

  async function handleBatchRedirect() {
    if (!isAdmin || selectedIds.length === 0) return;
    const res = await fetch('/api/links/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        ids: selectedIds,
        action: 'set_redirect',
        redirectCode: batchCode,
        cacheTtlSeconds: batchCode === 301 ? batchTtl : 0,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      setLinkMsg(`已批量更新 ${body.affected} 条短链为 HTTP ${batchCode}${batchCode === 301 ? ` (TTL ${batchTtl}s)` : ''}`);
      setSelectedIds([]);
      await loadWorkspace();
    } else {
      setLinkMsg(body.error || '批量操作失败');
    }
  }

  async function handleToggleLockLink(link: ShortLinkItem) {
    const res = await fetch(`/api/links/${link.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ isSystemProtected: !link.isSystemProtected }),
    });
    if (res.ok) {
      await loadWorkspace();
    }
  }

  async function handleDeleteLink(id: string) {
    const res = await fetch(`/api/links/${id}`, { method: 'DELETE', credentials: 'include' });
    if (res.ok) {
      await loadWorkspace();
    } else {
      const b = await res.json().catch(() => ({}));
      setLinkMsg(b.error || '删除失败');
    }
  }

  async function openStats(link: ShortLinkItem) {
    const res = await fetch(`/api/links/${link.id}/stats`, { credentials: 'include' });
    if (res.ok) {
      const d = await res.json();
      setStatsModal({
        link,
        totalClicks: d.totalClicks || 0,
        uniqueVisitors: d.uniqueVisitors || 0,
        referrerSites: d.referrerSites || [],
        recentClicks: d.recentClicks || [],
      });
    }
  }

  async function handleSaveInterstitial(e: FormEvent) {
    e.preventDefault();
    if (!interstitial || !isAdmin) return;
    setInterstitialMsg('');
    const res = await fetch('/api/interstitial', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(interstitial),
    });
    if (res.ok) {
      setInterstitialMsg('307 本地中间页模板已保存并生效。');
    } else {
      const b = await res.json().catch(() => ({}));
      setInterstitialMsg(b.error || '保存失败');
    }
  }

  async function handleConnectOAuth() {
    if (!settings || !isAdmin) return;
    setOauthConnecting(true);
    setOauthConnectError('');
    setOauthConnectMsg('');
    try {
      const payload: Record<string, unknown> = {
        oauthIssuerUrl: settings.oauthIssuerUrl,
        oauthClientId: settings.oauthClientId,
        oauthRedirectUri: settings.oauthRedirectUri,
        oauthAutoRedirect: settings.oauthAutoRedirect,
      };
      if (oauthClientSecret.trim()) {
        payload.oauthClientSecret = oauthClientSecret.trim();
      }
      if (oauthWebhookSecret.trim()) {
        payload.oauthWebhookSecret = oauthWebhookSecret.trim();
      }
      const res = await fetch('/api/oauth/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setOauthConnectError(b.error || '连接 OAuth 失败');
        return;
      }
      setOauthClientSecret('');
      setOauthWebhookSecret('');
      setOauthConnectMsg(b.message || '已连接并启用 wimotek/Oauth。');
      await loadWorkspace();
    } finally {
      setOauthConnecting(false);
    }
  }

  async function handleDisconnectOAuth() {
    if (!isAdmin) return;
    setOauthConnecting(true);
    setOauthConnectError('');
    setOauthConnectMsg('');
    try {
      const res = await fetch('/api/oauth/disconnect', {
        method: 'POST',
        credentials: 'include',
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setOauthConnectError(b.error || '断开连接失败');
        return;
      }
      setOauthConnectMsg(b.message || '已断开 wimotek/Oauth 连接。');
      await loadWorkspace();
    } finally {
      setOauthConnecting(false);
    }
  }

  async function handleSaveSettings(e: FormEvent) {
    e.preventDefault();
    if (!settings || !isAdmin) return;
    setSettingsMsg('');
    const { oauthEnabled: _ignoreOAuthEnabled, ...restSettings } = settings;
    const payload: Record<string, unknown> = { ...restSettings };
    if (oauthClientSecret.trim()) {
      payload.oauthClientSecret = oauthClientSecret.trim();
    }
    if (oauthWebhookSecret.trim()) {
      payload.oauthWebhookSecret = oauthWebhookSecret.trim();
    }
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      setOauthClientSecret('');
      setOauthWebhookSecret('');
      setSettingsMsg('系统配置已保存（注意：OAuth 登录仅在点击「连接 OAuth」成功后启用）。');
      await loadWorkspace();
    } else {
      const b = await res.json().catch(() => ({}));
      setSettingsMsg(b.error || '保存失败');
    }
  }

  if (!status || !authChecked) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-slate-500">Loading wimotek/url...</div>;
  }

  // 1. Setup Wizard (First-Run)
  if (!status.initialized) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-slate-50 dark:bg-slate-950">
        <form onSubmit={handleCompleteSetup} className="w-full max-w-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[10px] p-6 space-y-5">
          <div className="flex items-center gap-3">
            <img src="/logo.svg" alt="wimotek/url" className="w-9 h-9" />
            <div>
              <h1 className="text-lg font-semibold">wimotek/url 初始化安装向导</h1>
              <p className="text-xs text-slate-500">配置数据库、缓存、管理入口与超级管理员（首次登录默认使用本地登录，避免 OAuth 未配置导致循环跳转）。</p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 text-sm">
            <label className="block space-y-1">
              <span className="font-medium">数据库引擎</span>
              <select
                value={driver}
                onChange={(e) => {
                  const val = e.target.value as 'sqlite3' | 'mysql';
                  setDriver(val);
                  setDsn(val === 'sqlite3' ? '/data/wimotek_url.db' : 'user:pass@tcp(127.0.0.1:3306)/wimotek_url');
                }}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
              >
                <option value="sqlite3">SQLite3 (WAL + 并发写锁)</option>
                <option value="mysql">MySQL 8.0+</option>
              </select>
            </label>

            <label className="block space-y-1">
              <span className="font-medium">数据库 DSN</span>
              <input value={dsn} onChange={(e) => setDsn(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent font-mono text-xs" />
            </label>

            <button type="button" onClick={handleTestDb} className="justify-self-start px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800">
              测试数据库连接
            </button>

            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={redisEnabled} onChange={(e) => setRedisEnabled(e.target.checked)} />
              <span>启用 Redis 缓存（不勾选将自动使用内置 SQL 缓存）</span>
            </label>
            {redisEnabled && (
              <input value={redisAddr} onChange={(e) => setRedisAddr(e.target.value)} placeholder="127.0.0.1:6379" className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent font-mono text-xs" />
            )}

            <label className="block space-y-1">
              <span className="font-medium">站点外部访问地址 (Issuer URL)</span>
              <input value={issuerUrl} onChange={(e) => setIssuerUrl(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
            </label>

            <label className="block space-y-1">
              <span className="font-medium">受保护的管理入口路径</span>
              <input value={adminPath} onChange={(e) => setAdminPath(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent font-mono text-xs" />
            </label>

            <label className="block space-y-1">
              <span className="font-medium">超级管理员邮箱</span>
              <input type="email" required value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
            </label>

            <label className="block space-y-1">
              <span className="font-medium">超级管理员密码（至少 8 位）</span>
              <input type="password" required minLength={8} value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
            </label>
          </div>

          {feedback && <p className="text-xs text-blue-600 dark:text-blue-400">{feedback}</p>}

          <button type="submit" className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium">
            初始化并锁定安装向导
          </button>
        </form>
      </main>
    );
  }

  // 2. Static /logged-out page (prevents OAuth redirect loop after logout)
  if (!user && loggedOut) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-slate-50 dark:bg-slate-950">
        <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[10px] p-8 text-center space-y-4">
          <img src="/logo.svg" alt="wimotek/url" className="w-10 h-10 mx-auto" />
          <h1 className="text-lg font-semibold">您已安全退出登录</h1>
          <p className="text-xs text-slate-500 leading-relaxed">
            本地会话已清除。为防止重定向死循环，系统不会自动跳转，如需继续管理请点击下方重新登录。
          </p>
          <div className="flex gap-2 justify-center pt-2">
            {status.oauth_active ? (
              <a href="/login" className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium">
                重新登录 (wimotek/Oauth)
              </a>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setLoggedOut(false);
                  window.history.replaceState({}, '', '/');
                }}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium"
              >
                重新登录
              </button>
            )}
          </div>
        </div>
      </main>
    );
  }

  // 3. Mode A auto-redirect state (only when OAuth IS active & configured)
  if (!user && status.oauth_active && status.oauth_auto_redirect && !isLocalFallback) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-sm text-slate-500">
        <div>正在安全跳转至 wimotek/Oauth 统一认证中心...</div>
        <a href="/?local=1" className="text-xs text-blue-600 hover:underline">
          切换本地应急登录
        </a>
      </div>
    );
  }

  // 4. Local Sign-In Form with Visible Anti-Bot Challenge + Rate Limit Status
  if (!user) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-slate-50 dark:bg-slate-950">
        <form
          onSubmit={handleLocalLogin}
          className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[10px] p-6 space-y-4"
        >
          <div className="flex items-center gap-3">
            <img src="/logo.svg" alt="wimotek/url" className="w-9 h-9" />
            <div>
              <h1 className="text-lg font-semibold">wimotek/url</h1>
              <p className="text-xs text-slate-500">
                {status.oauth_active ? '本地应急登录 / wimotek/Oauth' : '管理员本地登录（可在后台配置 wimotek/Oauth）'}
              </p>
            </div>
          </div>

          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={(e) => setHoneypot(e.target.value)}
            className="hidden"
            aria-hidden="true"
          />

          <label className="block space-y-1 text-xs">
            <span className="font-medium">邮箱地址</span>
            <input
              type="email"
              required
              value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
            />
          </label>

          <label className="block space-y-1 text-xs">
            <span className="font-medium">密码</span>
            <input
              type="password"
              required
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
            />
          </label>

          {/* 4-Layer High-Strength Anti-AI CAPTCHA & Rate-Limit Protection */}
          <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-200">
                <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
                高强度防AI四重验证
              </span>
              <span className="font-mono text-[11px] text-slate-500">
                剩余尝试 {challenge?.remainingAttempts ?? 5}/{challenge?.loginRateLimitMax ?? 5}
              </span>
            </div>
            {status.antibot_mode !== 'off' && challenge && (
              <AntiBotCaptcha
                challenge={challenge}
                solution={captchaSolution}
                onChange={setCaptchaSolution}
                onRefresh={loadChallenge}
              />
            )}
          </div>

          {loginError && (
            <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
              {loginError}
            </div>
          )}

          <button
            type="submit"
            disabled={loginBusy}
            className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-medium"
          >
            {loginBusy ? '验证登录中...' : '登录后台'}
          </button>

          {status.oauth_active && (
            <a
              href="/login"
              className="block w-full text-center py-2 px-4 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              使用 wimotek/Oauth 统一认证登录
            </a>
          )}
        </form>
      </main>
    );
  }

  // 5. Authenticated Production Dashboard
  return (
    <div className="min-h-screen bg-[#F8FAFC] dark:bg-[#090D16] text-slate-900 dark:text-slate-100 flex flex-col">
      <header className="h-14 px-4 sm:px-6 bg-white dark:bg-[#111827] border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <img src="/logo.svg" alt="wimotek/url" className="w-7 h-7 shrink-0" />
          <span className="font-semibold text-sm shrink-0">wimotek/url</span>
          <nav className="flex items-center gap-1 ml-2 text-xs overflow-x-auto no-scrollbar">
            {[
              { id: 'links' as Tab, label: '短链管理', icon: Link2, adminOnly: false },
              { id: 'analytics' as Tab, label: '统计与来源', icon: Globe2, adminOnly: false },
              { id: 'domains' as Tab, label: '多域名与 SEO', icon: Globe, adminOnly: false },
              { id: 'interstitial' as Tab, label: '307 中间页', icon: FileCode2, adminOnly: false },
              { id: 'users' as Tab, label: '用户管理', icon: Users, adminOnly: true },
              { id: 'api_mcp' as Tab, label: 'API 与 MCP', icon: Cpu, adminOnly: false },
              { id: 'audit_cron' as Tab, label: '审计与备份', icon: Activity, adminOnly: true },
              { id: 'settings' as Tab, label: '系统 / OAuth', icon: Settings, adminOnly: false },
            ]
              .filter((item) => !item.adminOnly || isAdmin)
              .map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveTab(item.id)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-medium whitespace-nowrap ${
                      activeTab === item.id
                        ? 'bg-blue-600/10 text-blue-700 dark:text-blue-300'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {item.label}
                  </button>
                );
              })}
          </nav>
        </div>

        <div className="flex items-center gap-3 text-xs">
          <span className="hidden sm:inline text-slate-500 font-mono">
            {user.email} ({user.role})
          </span>
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:text-red-600"
          >
            <LogOut className="w-3.5 h-3.5" />
            退出
          </button>
        </div>
      </header>

      <main className="flex-1 p-4 sm:p-6 max-w-6xl w-full mx-auto space-y-6">
        {/* Links Management */}
        {activeTab === 'links' && (
          <>
            <form onSubmit={handleCreateLink} className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] p-5 space-y-3 text-xs">
              <div className="font-semibold text-sm">创建短链接</div>
              <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                <input
                  type="url"
                  required
                  value={newTarget}
                  onChange={(e) => setNewTarget(e.target.value)}
                  placeholder="目标长链接 https://..."
                  className="md:col-span-4 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent text-sm"
                />
                <select
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  aria-label="选择短链域名"
                  className="md:col-span-2 px-2.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent font-mono"
                >
                  {domains.map((d) => (
                    <option key={d.id} value={d.host}>
                      {d.host}
                    </option>
                  ))}
                  {domains.length === 0 && <option value={window.location.host}>{window.location.host}</option>}
                </select>
                <input
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value)}
                  placeholder="自定义后缀（留空自动）"
                  className="md:col-span-2 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent font-mono"
                />
                <input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="标题（可选）"
                  className="md:col-span-2 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
                />
                <button type="submit" className="md:col-span-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium">
                  生成短链
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                {isAdmin ? (
                  <>
                    <select
                      value={newCode}
                      onChange={(e) => setNewCode(Number(e.target.value) as 301 | 302 | 307)}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
                    >
                      <option value={302}>HTTP 302 (实时回源统计)</option>
                      <option value={301}>HTTP 301 + Cache TTL (定时回源)</option>
                      <option value={307}>HTTP 307 (本地中间页跳转)</option>
                    </select>
                    {newCode === 301 && (
                      <select
                        value={newTtl}
                        onChange={(e) => setNewTtl(Number(e.target.value))}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent font-mono"
                      >
                        <option value={60}>回源 TTL 60s</option>
                        <option value={300}>回源 TTL 300s (默认)</option>
                        <option value={1800}>回源 TTL 1800s</option>
                        <option value={3600}>回源 TTL 3600s</option>
                        <option value={86400}>回源 TTL 86400s</option>
                      </select>
                    )}
                  </>
                ) : (
                  <span className="text-slate-500">当前为普通用户：短链固定 HTTP 302（仅管理员可修改为 301 缓存回源或 307 中间页）</span>
                )}
              </div>
              {linkMsg && <p className="text-blue-600 dark:text-blue-400">{linkMsg}</p>}
            </form>

            {isAdmin && selectedIds.length > 0 && (
              <div className="p-3.5 rounded-[10px] bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 flex flex-wrap items-center gap-3 text-xs">
                <span className="font-semibold">已选 {selectedIds.length} 条</span>
                <select value={batchCode} onChange={(e) => setBatchCode(Number(e.target.value) as 301 | 302 | 307)} className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">
                  <option value={301}>批量改为 301 (定时回源 TTL)</option>
                  <option value={302}>批量改为 302</option>
                  <option value={307}>批量改为 307 (本地中间页)</option>
                </select>
                {batchCode === 301 && (
                  <select value={batchTtl} onChange={(e) => setBatchTtl(Number(e.target.value))} className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono">
                    <option value={60}>TTL 60s</option>
                    <option value={300}>TTL 300s</option>
                    <option value={1800}>TTL 1800s</option>
                    <option value={3600}>TTL 3600s</option>
                    <option value={86400}>TTL 86400s</option>
                  </select>
                )}
                <button type="button" onClick={handleBatchRedirect} className="px-3 py-1 rounded bg-blue-600 text-white font-medium">
                  批量应用跳转策略
                </button>
              </div>
            )}

            <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 text-slate-500">
                    <th className="py-3 px-4 w-8"></th>
                    <th className="py-3 px-3">短链接</th>
                    <th className="py-3 px-3">目标地址与跳转策略</th>
                    <th className="py-3 px-3 text-right">点击 / UV</th>
                    <th className="py-3 px-4 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {links.map((l) => (
                    <tr key={l.id}>
                      <td className="py-3 px-4">
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(l.id)}
                          onChange={() =>
                            setSelectedIds((prev) => (prev.includes(l.id) ? prev.filter((x) => x !== l.id) : [...prev, l.id]))
                          }
                        />
                      </td>
                      <td className="py-3 px-3 font-mono font-semibold text-blue-600 dark:text-blue-400 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <a href={`/${l.slug}`} target="_blank" rel="noopener noreferrer" className="hover:underline">
                            {l.domain}/{l.slug}
                          </a>
                          {l.isSystemProtected && (
                            <span title="已锁定防删除" className="inline-flex items-center text-amber-600 dark:text-amber-400">
                              <Lock className="w-3 h-3" />
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard?.writeText(`https://${l.domain}/${l.slug}`).catch(() => {});
                              setCopiedId(l.id);
                              setTimeout(() => setCopiedId(null), 1500);
                            }}
                            className="text-slate-400 hover:text-slate-700"
                          >
                            {copiedId === l.id ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                      <td className="py-3 px-3 max-w-md">
                        <div className="font-mono truncate">{l.targetUrl}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          HTTP {l.redirectCode}
                          {l.redirectCode === 301 ? ` · TTL ${l.cacheTtlSeconds || 300}s` : l.redirectCode === 307 ? ' · 本地中间页' : ' · 实时回源'}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono whitespace-nowrap">
                        <button type="button" onClick={() => openStats(l)} className="text-right hover:text-blue-600">
                          <div className="font-semibold">{l.clicks}</div>
                          <div className="text-[11px] text-slate-400">{l.uniqueClicks} UV</div>
                        </button>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <button type="button" onClick={() => openStats(l)} title="来源网站统计" className="p-1.5 text-slate-500 hover:text-blue-600">
                          <BarChart2 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleLockLink(l)}
                          title={l.isSystemProtected ? '已锁定防删除，点击解锁' : '点击锁定防删除'}
                          aria-label={l.isSystemProtected ? `解锁 ${l.slug}` : `锁定 ${l.slug}`}
                          className={`p-1.5 rounded-md ${
                            l.isSystemProtected
                              ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40'
                              : 'text-slate-400 hover:text-amber-600'
                          }`}
                        >
                          {l.isSystemProtected ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
                        </button>
                        <button
                          type="button"
                          disabled={l.isSystemProtected}
                          onClick={() => handleDeleteLink(l.id)}
                          title={l.isSystemProtected ? '已锁定防删除，请先解锁' : '删除短链'}
                          className="p-1.5 text-slate-500 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}

        {/* Analytics & Referring Websites */}
        {activeTab === 'analytics' && analytics && (
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] p-4">
                <div className="text-xs text-slate-500">总点击量</div>
                <div className="text-2xl font-semibold font-mono mt-1">{analytics.totalClicks}</div>
              </div>
              <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] p-4">
                <div className="text-xs text-slate-500">独立访客 (UV)</div>
                <div className="text-2xl font-semibold font-mono mt-1">{analytics.uniqueVisitors}</div>
              </div>
              <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] p-4">
                <div className="text-xs text-slate-500">有效短链</div>
                <div className="text-2xl font-semibold font-mono mt-1">{analytics.activeLinks}</div>
              </div>
            </div>

            <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] p-5 space-y-3 text-xs">
              <h2 className="text-sm font-semibold">来源网站统计 (Referring Websites)</h2>
              {analytics.referrerSites.length === 0 ? (
                <p className="text-slate-500">暂无来源网站点击数据。</p>
              ) : (
                <div className="space-y-2.5">
                  {analytics.referrerSites.map((s) => (
                    <div key={s.host} className="space-y-1">
                      <div className="flex justify-between">
                        <span className="font-mono font-semibold">{s.host} <span className="font-sans font-normal text-slate-400">· {s.channel}</span></span>
                        <span className="font-mono">{s.clicks} ({s.uniqueVisitors} UV · {s.share}%)</span>
                      </div>
                      <div className="h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-600" style={{ width: `${Math.max(3, s.share)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] overflow-x-auto text-xs">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 font-semibold text-sm">最近访问来源明细</div>
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 text-slate-500">
                    <th className="py-2.5 px-4">时间</th>
                    <th className="py-2.5 px-3">短链</th>
                    <th className="py-2.5 px-3">来源网站 / URL</th>
                    <th className="py-2.5 px-3">GeoIP</th>
                    <th className="py-2.5 px-4 text-right">终端</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {analytics.recentClicks.map((c) => (
                    <tr key={c.id}>
                      <td className="py-2.5 px-4 font-mono text-slate-500 whitespace-nowrap">{c.timestamp.replace('T', ' ').slice(0, 19)}</td>
                      <td className="py-2.5 px-3 font-mono text-blue-600">/{c.slug}</td>
                      <td className="py-2.5 px-3">
                        <div className="font-mono font-medium">{c.referrerHost}</div>
                        {c.referrerUrl && <div className="text-[11px] font-mono text-slate-400 truncate max-w-xs">{c.referrerUrl}</div>}
                      </td>
                      <td className="py-2.5 px-3">{c.countryCode} · {c.region}</td>
                      <td className="py-2.5 px-4 text-right">{c.device}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        )}

        {/* Multi-Domain Management & SEO */}
        {activeTab === 'domains' && (
          <DomainsPanel
            domains={domains}
            seoIndexNowKey={settings?.seoIndexNowKey || ''}
            isAdmin={isAdmin}
            onRefresh={loadWorkspace}
          />
        )}

        {/* Users, RBAC & Quota Tiers */}
        {activeTab === 'users' && isAdmin && (
          <UsersPanel
            users={usersList}
            allowRegistration={Boolean(settings?.allowRegistration)}
            currentUserId={user.id}
            onRefresh={loadWorkspace}
          />
        )}

        {/* REST API Keys & MCP Server */}
        {activeTab === 'api_mcp' && (
          <ApiMcpPanel
            apiKeys={apiKeys}
            issuerUrl={settings?.issuerUrl || window.location.origin}
            onRefresh={loadWorkspace}
          />
        )}

        {/* Audit Logs & Scheduled Database Backups */}
        {activeTab === 'audit_cron' && isAdmin && (
          <AuditBackupPanel
            auditLogs={auditData.auditLogs}
            backups={auditData.backups}
            cronTasks={auditData.cronTasks}
            auditRetentionDays={auditData.auditRetentionDays}
            backupRetentionCount={auditData.backupRetentionCount}
            dbDriver={auditData.dbDriver}
            onRefresh={loadWorkspace}
          />
        )}

        {/* 307 Local Interstitial Online Template Editor */}
        {activeTab === 'interstitial' && interstitial && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={!isAdmin}
                  onClick={() => setInterstitial((prev) => (prev ? { ...prev, preset: p.id, ...p.defaults } : prev))}
                  className={`text-left p-3.5 rounded-[10px] border bg-white dark:bg-[#111827] space-y-1 ${
                    interstitial.preset === p.id ? 'border-blue-600' : 'border-slate-200 dark:border-slate-800'
                  }`}
                >
                  <div className="font-semibold">{p.label}</div>
                  <div className="text-[11px] text-slate-500">{p.desc}</div>
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <form onSubmit={handleSaveInterstitial} className="lg:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] p-5 space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">307 中间页模板配置</span>
                  {isAdmin && (
                    <button type="submit" className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 text-white font-medium">
                      <Save className="w-3.5 h-3.5" />
                      保存模板
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <label className="space-y-1">
                    <span>倒计时(秒)</span>
                    <input type="number" min={0} max={15} disabled={!isAdmin} value={interstitial.countdown_seconds} onChange={(e) => setInterstitial({ ...interstitial, countdown_seconds: Number(e.target.value) })} className="w-full px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent font-mono" />
                  </label>
                  <label className="space-y-1">
                    <span>品牌名称</span>
                    <input disabled={!isAdmin} value={interstitial.brand_name} onChange={(e) => setInterstitial({ ...interstitial, brand_name: e.target.value })} className="w-full px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
                  </label>
                  <label className="space-y-1">
                    <span>主色调</span>
                    <input disabled={!isAdmin} value={interstitial.primary_color} onChange={(e) => setInterstitial({ ...interstitial, primary_color: e.target.value })} className="w-full px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent font-mono" />
                  </label>
                </div>
                <label className="block space-y-1">
                  <span>主标题</span>
                  <input disabled={!isAdmin} value={interstitial.headline} onChange={(e) => setInterstitial({ ...interstitial, headline: e.target.value })} className="w-full px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
                </label>
                <label className="block space-y-1">
                  <span>副标题</span>
                  <input disabled={!isAdmin} value={interstitial.subtitle} onChange={(e) => setInterstitial({ ...interstitial, subtitle: e.target.value })} className="w-full px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
                </label>
                <label className="block space-y-1">
                  <span>安全提示 / 公告</span>
                  <input disabled={!isAdmin} value={interstitial.safety_tip} onChange={(e) => setInterstitial({ ...interstitial, safety_tip: e.target.value })} className="w-full px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent" />
                </label>
                <label className="inline-flex items-center gap-2 pt-1">
                  <input type="checkbox" disabled={!isAdmin} checked={interstitial.use_custom_html} onChange={(e) => setInterstitial({ ...interstitial, use_custom_html: e.target.checked })} />
                  <Code2 className="w-3.5 h-3.5 text-blue-600" />
                  <span>启用自定义 HTML 模板源码</span>
                </label>
                {interstitial.use_custom_html && (
                  <textarea
                    rows={10}
                    disabled={!isAdmin}
                    value={interstitial.custom_html}
                    onChange={(e) => setInterstitial({ ...interstitial, custom_html: e.target.value })}
                    placeholder="支持 {{BRAND_NAME}}, {{HEADLINE}}, {{SUBTITLE}}, {{TARGET_URL}}, {{TARGET_HOST}}, {{CTA_TEXT}}, {{COUNTDOWN}}"
                    className="w-full p-3 font-mono text-[11px] rounded-lg bg-slate-950 text-slate-100 border border-slate-700"
                  />
                )}
                {interstitialMsg && <p className="text-emerald-600">{interstitialMsg}</p>}
              </form>

              <section className="lg:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold flex items-center gap-2">
                  <Eye className="w-4 h-4 text-blue-600" />
                  实时沙箱预览
                </div>
                <iframe title="307 Preview" sandbox="allow-scripts" srcDoc={previewHtml} className="w-full h-[460px] bg-white" />
              </section>
            </div>
          </div>
        )}

        {/* Settings: Root 301, wimotek/Oauth PKCE, Anti-Bot & Rate Limits */}
        {activeTab === 'settings' && settings && (
          <form onSubmit={handleSaveSettings} className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] p-5 space-y-5 text-xs">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h2 className="text-sm font-semibold">根路径 301 · wimotek/Oauth (PKCE S256) · 防机器人与限流</h2>
                <p className="text-slate-500 mt-0.5">
                  OAuth 状态:{' '}
                  <strong className={settings.oauthEnabled ? 'text-emerald-600' : 'text-amber-600'}>
                    {settings.oauthEnabled
                      ? `已连接并启用 (${settings.oauthSecretHint || '••••'})`
                      : '未连接 · 未启用'}
                  </strong>{' '}
                  · 已拦截异常请求: {settings.blockedRequestsCount}
                </p>
              </div>
              {isAdmin && (
                <button type="submit" className="px-4 py-2 rounded-lg bg-blue-600 text-white font-medium">
                  保存配置
                </button>
              )}
            </div>

            {/* Dedicated OAuth Connect / Disconnect Status Bar */}
            <div
              className={`p-3.5 rounded-lg border flex flex-wrap items-center justify-between gap-3 ${
                settings.oauthEnabled
                  ? 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/60 dark:bg-emerald-950/20'
                  : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50'
              }`}
            >
              <div className="space-y-0.5 min-w-0">
                <div className="font-semibold flex items-center gap-2">
                  <span className={`inline-block w-2 h-2 rounded-full ${settings.oauthEnabled ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                  {settings.oauthEnabled ? 'wimotek/Oauth 已连接 · 启用状态' : 'wimotek/Oauth 未连接 · 未启用'}
                </div>
                <p className="text-slate-500">
                  {settings.oauthEnabled
                    ? `当前已连接 ${settings.oauthIssuerUrl} (Client ID: ${settings.oauthClientId})。`
                    : '填写 Issuer URL、Client ID 与 Client Secret 后，点击右侧「连接 OAuth」校验通过才会启用。'}
                </p>
                {oauthConnectError && <p className="text-red-600 font-medium">{oauthConnectError}</p>}
                {oauthConnectMsg && <p className="text-emerald-600 font-medium">{oauthConnectMsg}</p>}
              </div>
              {isAdmin && (
                <div className="flex items-center gap-2 shrink-0">
                  {settings.oauthEnabled ? (
                    <>
                      <button
                        type="button"
                        disabled={oauthConnecting}
                        onClick={handleConnectOAuth}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-medium"
                      >
                        <Plug className="w-3.5 h-3.5" />
                        {oauthConnecting ? '校验中...' : '重新连接'}
                      </button>
                      <button
                        type="button"
                        disabled={oauthConnecting}
                        onClick={handleDisconnectOAuth}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-300 dark:border-red-900/70 bg-white dark:bg-slate-900 text-red-600 font-medium"
                      >
                        <Unplug className="w-3.5 h-3.5" />
                        断开连接
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={oauthConnecting}
                      onClick={handleConnectOAuth}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
                    >
                      <Plug className="w-3.5 h-3.5" />
                      {oauthConnecting ? '正在连接...' : '连接 OAuth'}
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="flex items-start gap-2.5 p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                <input type="checkbox" disabled={!isAdmin} checked={settings.rootRedirectEnabled} onChange={(e) => setSettings({ ...settings, rootRedirectEnabled: e.target.checked })} />
                <span>
                  <strong>根路径 `/` 固定 HTTP 301 永久跳转</strong>
                  <span className="block text-slate-500 mt-0.5">开启后访问 `/` 固定返回 HTTP 301 至目标官网（管理后台请通过 {settings.adminPath} 进入）。</span>
                </span>
              </label>

              <label className="space-y-1">
                <span>根路径 `/` 301 跳转目标 URL</span>
                <input disabled={!isAdmin} value={settings.rootRedirectUrl} onChange={(e) => setSettings({ ...settings, rootRedirectUrl: e.target.value })} className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
              </label>

              <label className="space-y-1">
                <span>自定义管理后台入口路径</span>
                <input disabled={!isAdmin} value={settings.adminPath} onChange={(e) => setSettings({ ...settings, adminPath: e.target.value })} placeholder="/admin" className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
              </label>

              <label className="flex items-start gap-2.5 p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                <input type="checkbox" disabled={!isAdmin} checked={settings.oauthAutoRedirect} onChange={(e) => setSettings({ ...settings, oauthAutoRedirect: e.target.checked })} />
                <span>
                  <strong>方式 A：已连接 OAuth 时未登录直跳托管登录页</strong>
                  <span className="block text-slate-500 mt-0.5">退出后停留 /logged-out 防循环；应急本地登录请访问 /?local=1。</span>
                </span>
              </label>

              <label className="space-y-1">
                <span>OIDC Issuer URL</span>
                <input disabled={!isAdmin} value={settings.oauthIssuerUrl} onChange={(e) => setSettings({ ...settings, oauthIssuerUrl: e.target.value })} className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
              </label>
              <label className="space-y-1">
                <span>OIDC Client ID</span>
                <input disabled={!isAdmin} value={settings.oauthClientId} onChange={(e) => setSettings({ ...settings, oauthClientId: e.target.value })} className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
              </label>

              <div className="space-y-1">
                <label htmlFor="prod-oauth-secret" className="block">OAuth Client Secret（留空保持已配置密钥不变）</label>
                <div className="relative">
                  <input
                    id="prod-oauth-secret"
                    type={showClientSecret ? 'text' : 'password'}
                    autoComplete="new-password"
                    disabled={!isAdmin}
                    value={oauthClientSecret}
                    onChange={(e) => setOauthClientSecret(e.target.value)}
                    placeholder={settings.oauthConfigured ? `已配置 (${settings.oauthSecretHint || '••••'})，输入新密钥可覆盖` : '输入 OAuth Client Secret'}
                    className="w-full px-3 py-2 pr-9 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
                  />
                  <button
                    type="button"
                    onClick={() => setShowClientSecret((v) => !v)}
                    aria-label={showClientSecret ? '隐藏 Client Secret' : '显示 Client Secret'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                  >
                    {showClientSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <label className="space-y-1">
                <span>防机器人校验模式</span>
                <select disabled={!isAdmin} value={settings.antiBotMode} onChange={(e) => setSettings({ ...settings, antiBotMode: e.target.value as SettingsState['antiBotMode'] })} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent">
                  <option value="builtin">内置防AI验证（矢量扭曲图形 + SHA-256 算力 + 失败触发滑块 + IP绑定）</option>
                  <option value="turnstile">Cloudflare Turnstile</option>
                  <option value="off">仅 IP 限流</option>
                </select>
              </label>
            </div>

            {/* Collapsible Advanced OAuth Section (Hidden by Default) */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
              <button
                type="button"
                onClick={() => setShowOAuthAdvanced((v) => !v)}
                aria-expanded={showOAuthAdvanced}
                className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900/50 hover:bg-slate-100 dark:hover:bg-slate-800/60 flex items-center justify-between gap-2 text-left"
              >
                <span className="inline-flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-200">
                  {showOAuthAdvanced ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
                  <SlidersHorizontal className="w-3.5 h-3.5 text-blue-600" />
                  高级配置 (Advanced · Redirect URI / Discovery / Webhook)
                </span>
                <span className="text-[11px] text-slate-500">反代或检测域名不一致时展开修改</span>
              </button>

              {showOAuthAdvanced && (
                <div className="p-4 space-y-4 border-t border-slate-200 dark:border-slate-800">
                  <p className="text-[11px] text-slate-500">
                    仅当站点部署在反向代理后或自动检测的回调域名与认证中心登记不一致时，才需要手动覆盖 Redirect URI 或查看 OIDC 端点。
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <label className="space-y-1">
                      <span>OAuth Redirect URI (Callback 覆写)</span>
                      <input disabled={!isAdmin} value={settings.oauthRedirectUri} onChange={(e) => setSettings({ ...settings, oauthRedirectUri: e.target.value })} className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
                    </label>
                    <div className="space-y-1">
                      <label htmlFor="prod-webhook-secret" className="block">Webhook Signing Secret（可选）</label>
                      <div className="relative">
                        <input
                          id="prod-webhook-secret"
                          type={showWebhookSecret ? 'text' : 'password'}
                          autoComplete="new-password"
                          disabled={!isAdmin}
                          value={oauthWebhookSecret}
                          onChange={(e) => setOauthWebhookSecret(e.target.value)}
                          placeholder={settings.oauthWebhookSecretConfigured ? '已配置 Webhook Secret，留空保持不变' : '留空默认复用 Client Secret'}
                          className="w-full px-3 py-2 pr-9 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
                        />
                        <button
                          type="button"
                          onClick={() => setShowWebhookSecret((v) => !v)}
                          aria-label={showWebhookSecret ? '隐藏 Webhook Secret' : '显示 Webhook Secret'}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                        >
                          {showWebhookSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 grid grid-cols-1 md:grid-cols-2 gap-1.5 text-[11px] font-mono text-slate-600 dark:text-slate-300">
                    <div>Discovery: {settings.oauthIssuerUrl.replace(/\/+$/, '')}/.well-known/openid-configuration</div>
                    <div>JWKS (RS256): {settings.oauthIssuerUrl.replace(/\/+$/, '')}/.well-known/jwks.json</div>
                    <div>Authorize: {settings.oauthIssuerUrl.replace(/\/+$/, '')}/oauth/authorize</div>
                    <div>Token: {settings.oauthIssuerUrl.replace(/\/+$/, '')}/oauth/token</div>
                    <div>Userinfo: {settings.oauthIssuerUrl.replace(/\/+$/, '')}/oauth/userinfo</div>
                    <div>Webhook: POST /webhooks/oauth-events</div>
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <label className="space-y-1">
                <span>登录最大失败次数</span>
                <input type="number" min={3} max={50} disabled={!isAdmin} value={settings.loginRateLimitMax} onChange={(e) => setSettings({ ...settings, loginRateLimitMax: Number(e.target.value) })} className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
              </label>
              <label className="space-y-1">
                <span>登录封禁窗口 (分)</span>
                <input type="number" min={1} max={120} disabled={!isAdmin} value={settings.loginRateLimitWindowMin} onChange={(e) => setSettings({ ...settings, loginRateLimitWindowMin: Number(e.target.value) })} className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
              </label>
              <label className="space-y-1">
                <span>短链防刷限流 (次/分/IP)</span>
                <input type="number" min={10} max={10000} disabled={!isAdmin} value={settings.redirectRateLimitPerMin} onChange={(e) => setSettings({ ...settings, redirectRateLimitPerMin: Number(e.target.value) })} className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
              </label>
            </div>

            {settingsMsg && <p className="text-emerald-600">{settingsMsg}</p>}
          </form>
        )}
      </main>

      {/* Per-Link Referrer Websites Modal */}
      {statsModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] p-6 space-y-4 max-h-[85vh] overflow-y-auto text-xs">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">单条短链统计与来源网站</h3>
                <div className="font-mono text-blue-600">{statsModal.link.domain}/{statsModal.link.slug}</div>
              </div>
              <button type="button" onClick={() => setStatsModal(null)} className="p-1 text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900">总点击: <strong className="font-mono">{statsModal.totalClicks}</strong></div>
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900">独立访客: <strong className="font-mono">{statsModal.uniqueVisitors}</strong></div>
            </div>
            <div className="space-y-2">
              <div className="font-semibold">来源网站 Top 统计</div>
              {statsModal.referrerSites.length === 0 ? (
                <p className="text-slate-500">暂无来源网站记录。</p>
              ) : (
                statsModal.referrerSites.map((s) => (
                  <div key={s.host} className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800">
                    <span className="font-mono">{s.host} ({s.channel})</span>
                    <span className="font-mono">{s.clicks} ({s.share}%)</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
