import type { Locale, SocialConnector } from '../types';

export const SUPPORTED_LOCALES: { code: Locale; label: string; nativeLabel: string }[] = [
  { code: 'zh-CN', label: 'Simplified Chinese', nativeLabel: '简体中文' },
  { code: 'zh-TW', label: 'Traditional Chinese', nativeLabel: '繁體中文' },
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語' },
  { code: 'de', label: 'German', nativeLabel: 'Deutsch' },
];

export function detectBrowserLocale(navigatorLang?: string): Locale {
  if (!navigatorLang) return 'zh-CN';
  const norm = navigatorLang.toLowerCase();
  if (norm.startsWith('zh-tw') || norm.startsWith('zh-hk') || norm.startsWith('zh-hant')) return 'zh-TW';
  if (norm.startsWith('zh')) return 'zh-CN';
  if (norm.startsWith('ja')) return 'ja';
  if (norm.startsWith('de')) return 'de';
  return 'en';
}

/**
 * Adaptive social login layout strategy:
 * Shows up to `threshold` prominent connector buttons directly, and collapses overflow
 * into an expandable "More sign-in methods" drawer so the login card stays compact.
 */
export function partitionConnectors(
  connectors: SocialConnector[],
  threshold = 3
): { primary: SocialConnector[]; overflow: SocialConnector[] } {
  const enabled = connectors.filter((c) => c.enabled);
  if (enabled.length <= threshold) {
    return { primary: enabled, overflow: [] };
  }
  return {
    primary: enabled.slice(0, threshold),
    overflow: enabled.slice(threshold),
  };
}

/**
 * Pure deterministic reorder by ID list.
 * Unknown IDs are ignored and any existing items omitted from `orderedIds` are preserved in their relative order at the end.
 */
export function reorderConnectors<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const result: T[] = [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    const found = byId.get(id);
    if (found && !seen.has(id)) {
      result.push(found);
      seen.add(id);
    }
  }
  for (const item of items) {
    if (!seen.has(item.id)) {
      result.push(item);
    }
  }
  return result;
}

export function moveConnectorByIndex<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (items.length <= 1) return [...items];
  const from = Math.max(0, Math.min(items.length - 1, fromIndex));
  const to = Math.max(0, Math.min(items.length - 1, toIndex));
  if (from === to) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export interface TranslationSchema {
  navOverview: string;
  navApplications: string;
  navConnectors: string;
  navUsers: string;
  navSecurity: string;
  navLoginLab: string;
  navSdks: string;
  tabPassword: string;
  tabEmailOtp: string;
  tabPasskey: string;
  tabDeviceFlow: string;
  usersTitle: string;
  usersSubtitle: string;
  securityTitle: string;
  securitySubtitle: string;
  signOut: string;
  setupWizardTitle: string;
  setupWizardSubtitle: string;
  setupStepDb: string;
  setupStepCache: string;
  setupStepSite: string;
  setupStepAdmin: string;
  testConnection: string;
  skipRedis: string;
  completeSetup: string;
  loginTitle: string;
  loginSubtitle: string;
  emailLabel: string;
  passwordLabel: string;
  signInButton: string;
  orContinueWith: string;
  moreSignInMethods: string;
  fewerSignInMethods: string;
  continueWithProvider: string;
  noConnectorsEnabled: string;
  overviewTitle: string;
  overviewSubtitle: string;
  oidcEndpointsTitle: string;
  storageEngineTitle: string;
  cacheEngineTitle: string;
  simulateRedisFailover: string;
  restoreRedis: string;
  appsTitle: string;
  appsSubtitle: string;
  createApp: string;
  appName: string;
  redirectUris: string;
  clientId: string;
  clientSecret: string;
  testOidcFlow: string;
  connectorsTitle: string;
  connectorsSubtitle: string;
  connectorEnabled: string;
  connectorDisabled: string;
  saveConnector: string;
  addCustomOidc: string;
  loginLabTitle: string;
  loginLabSubtitle: string;
  viewportDesktop: string;
  viewportMobile: string;
  rtlPreview: string;
  oidcTraceTitle: string;
  sdksTitle: string;
  sdksSubtitle: string;
  quickStartLines: string;
  fullMinimalSdk: string;
  copyCode: string;
  copied: string;
  tlsCertStatus: string;
}

export const TRANSLATIONS: Record<Locale, TranslationSchema> = {
  'zh-CN': {
    navOverview: '系统概览',
    navApplications: '业务应用',
    navConnectors: '社会化登录',
    navUsers: '身份与用户库',
    navSecurity: '认证与风控策略',
    navLoginLab: '托管登录页调试',
    navSdks: '文档中心',
    tabPassword: '邮箱密码',
    tabEmailOtp: '邮箱免密 OTP',
    tabPasskey: 'Passkey 通行密钥',
    tabDeviceFlow: '跨端设备扫码',
    usersTitle: '轻量级身份库与账号互通',
    usersSubtitle: '仅存储核心账号身份（users）与多渠道绑定关系（user_identities），支持 JIT 即时同步、已验证邮箱平滑绑定老账号及封禁 Webhook 踢人。',
    securityTitle: '现代认证方式与隐形风控',
    securitySubtitle: '统一配置 Argon2id、邮箱 OTP/魔法链接、TOTP 2FA、Passkeys（WebAuthn）、RFC 8628 设备码及 IP 限流/指数退避/Turnstile 人机验证。',
    signOut: '退出登录',
    setupWizardTitle: '首次运行安装向导',
    setupWizardSubtitle: '配置数据库引擎、缓存降级策略与管理员账号，完成后将自动锁定防重复初始化。',
    setupStepDb: '数据库模式',
    setupStepCache: '缓存加速',
    setupStepSite: '站点 Issuer',
    setupStepAdmin: '管理员账号',
    testConnection: '一键测试连接',
    skipRedis: '跳过 Redis（自动使用 SQL Cache）',
    completeSetup: '完成初始化并锁定',
    loginTitle: '统一身份认证登录',
    loginSubtitle: '使用组织账号或社会化身份源安全接入您的业务系统',
    emailLabel: '工作邮箱',
    passwordLabel: '访问密码',
    signInButton: '安全登录',
    orContinueWith: '或使用以下方式登录',
    moreSignInMethods: '更多登录方式',
    fewerSignInMethods: '收起更多方式',
    continueWithProvider: '使用 {provider} 登录',
    noConnectorsEnabled: '当前未启用社会化登录源，请在管理后台配置并即时生效。',
    overviewTitle: 'OIDC 认证中心概览',
    overviewSubtitle: '单二进制轻量网关 · 实时监控标准协议端点、WAL 并发存储与 Redis 自动降级状态。',
    oidcEndpointsTitle: '标准 OIDC / OAuth 2.0 协议端点',
    storageEngineTitle: '双模数据库存储引擎',
    cacheEngineTitle: '高可用缓存引擎',
    simulateRedisFailover: '模拟 Redis 断连降级',
    restoreRedis: '恢复 Redis 连接',
    appsTitle: '业务应用管理',
    appsSubtitle: '创建标准 OIDC 客户端，业务站无需感知上游微软、苹果或微信登录细节。',
    createApp: '新建业务应用',
    appName: '应用名称',
    redirectUris: '回调地址白名单（每行一个）',
    clientId: 'Client ID',
    clientSecret: 'Client Secret',
    testOidcFlow: '测试 PKCE 登录',
    connectorsTitle: '社会化登录连接器',
    connectorsSubtitle: '基于统一 ProviderAdapter 插件架构，启用并保存密钥后即时生效，密钥经 AES-256-GCM 加密存储。',
    connectorEnabled: '已启用',
    connectorDisabled: '未启用',
    saveConnector: '保存配置并生效',
    addCustomOidc: '新增通用 OIDC',
    loginLabTitle: '托管登录页与 OIDC 调试台',
    loginLabSubtitle: '验证多语言排版自适应、多渠道自动折叠与完整 Authorization Code + PKCE (S256) 签发链路。',
    viewportDesktop: '桌面端视图',
    viewportMobile: '移动端视图',
    rtlPreview: 'RTL 镜像测试',
    oidcTraceTitle: '实时 OIDC PKCE 链路与 RS256 令牌解析',
    sdksTitle: 'IdP 接入与文档中心',
    sdksSubtitle: '标准 OIDC / OAuth 2.0 令牌签发指南、五语言极简 SDK、封禁 Webhook 验签与生产部署手册。',
    quickStartLines: '快速接入示例',
    fullMinimalSdk: '完整轻量 SDK 封装源码',
    copyCode: '复制代码',
    copied: '已复制',
    tlsCertStatus: 'TLS 证书加载策略',
  },
  'zh-TW': {
    navOverview: '系統概覽',
    navApplications: '業務應用',
    navConnectors: '社群登入源',
    navUsers: '身分與帳號庫',
    navSecurity: '認證與風控策略',
    navLoginLab: '託管登入頁除錯',
    navSdks: '文件中心',
    tabPassword: '信箱密碼',
    tabEmailOtp: '信箱免密 OTP',
    tabPasskey: 'Passkey 通行金鑰',
    tabDeviceFlow: '跨端裝置掃碼',
    usersTitle: '輕量級身分庫與帳號互通',
    usersSubtitle: '僅存核心帳號身分（users）與多渠道映射（user_identities），支援 JIT 即時同步、已驗證信箱平滑綁定舊帳號與封禁 Webhook 踢人。',
    securityTitle: '現代認證方式與隱形風控',
    securitySubtitle: '管理 Argon2id、信箱 OTP/魔法連結、TOTP 2FA、Passkeys（WebAuthn）、RFC 8628 裝置碼與 IP 限流/指數退避/Turnstile 驗證。',
    signOut: '登出系統',
    setupWizardTitle: '首次啟動安裝精靈',
    setupWizardSubtitle: '設定資料庫引擎、快取降級策略與管理員帳號，完成後自動鎖定避免重複初始化。',
    setupStepDb: '資料庫模式',
    setupStepCache: '快取加速',
    setupStepSite: '站點 Issuer',
    setupStepAdmin: '管理員帳號',
    testConnection: '一鍵測試連線',
    skipRedis: '略過 Redis（自動啟用 SQL Cache）',
    completeSetup: '完成初始化並鎖定',
    loginTitle: '統一身分驗證登入',
    loginSubtitle: '使用組織帳號或社群身分來源安全存取您的業務應用',
    emailLabel: '工作信箱',
    passwordLabel: '存取密碼',
    signInButton: '安全登入',
    orContinueWith: '或透過以下方式繼續',
    moreSignInMethods: '更多登入方式',
    fewerSignInMethods: '收合更多方式',
    continueWithProvider: '使用 {provider} 登入',
    noConnectorsEnabled: '尚未啟用社群登入源，請於管理後台設定即可即時生效。',
    overviewTitle: 'OIDC 認證中心概覽',
    overviewSubtitle: '單一執行檔輕量閘道 · 即時掌握標準協定端點、WAL 並發儲存與 Redis 自動降級狀態。',
    oidcEndpointsTitle: '標準 OIDC / OAuth 2.0 協定端點',
    storageEngineTitle: '雙模資料庫儲存引擎',
    cacheEngineTitle: '高可用快取引擎',
    simulateRedisFailover: '模擬 Redis 斷線降級',
    restoreRedis: '恢復 Redis 連線',
    appsTitle: '業務應用管理',
    appsSubtitle: '建立標準 OIDC 用戶端，業務站無需感知上游微軟、蘋果或微信登入實作細節。',
    createApp: '新增業務應用',
    appName: '應用名稱',
    redirectUris: '回呼網址白名單（每行一個）',
    clientId: 'Client ID',
    clientSecret: 'Client Secret',
    testOidcFlow: '測試 PKCE 登入',
    connectorsTitle: '社群登入連接器',
    connectorsSubtitle: '採用統一 ProviderAdapter 插件介面，儲存金鑰後即時生效並透過 AES-256-GCM 加密儲存。',
    connectorEnabled: '已啟用',
    connectorDisabled: '未啟用',
    saveConnector: '儲存並即時生效',
    addCustomOidc: '新增通用 OIDC',
    loginLabTitle: '託管登入頁與 OIDC 除錯台',
    loginLabSubtitle: '檢驗多國語言排版自適應、多通道自動摺疊與完整 Authorization Code + PKCE (S256) 流程。',
    viewportDesktop: '桌面端檢視',
    viewportMobile: '行動端檢視',
    rtlPreview: 'RTL 鏡像測試',
    oidcTraceTitle: '即時 OIDC PKCE 鏈路與 RS256 權杖解析',
    sdksTitle: 'IdP 串接與文件中心',
    sdksSubtitle: '標準 OIDC / OAuth 2.0 權杖簽發指南、五語言極簡 SDK、封禁 Webhook 驗簽與部署手冊。',
    quickStartLines: '快速串接範例',
    fullMinimalSdk: '完整輕量 SDK 封裝碼',
    copyCode: '複製程式碼',
    copied: '已複製',
    tlsCertStatus: 'TLS 憑證載入策略',
  },
  en: {
    navOverview: 'Overview',
    navApplications: 'Applications',
    navConnectors: 'Social Connectors',
    navUsers: 'Identity Directory',
    navSecurity: 'Auth & Risk Policy',
    navLoginLab: 'Hosted Login Lab',
    navSdks: 'Docs Center',
    tabPassword: 'Password',
    tabEmailOtp: 'Email OTP',
    tabPasskey: 'Passkey',
    tabDeviceFlow: 'Device Flow',
    usersTitle: 'Lightweight Identity Store & Account Linking',
    usersSubtitle: 'Core identity table (users) plus multi-channel mappings (user_identities) with JIT verified-email linking and signed account-ban webhooks.',
    securityTitle: 'Auth Methods & Invisible Risk Control',
    securitySubtitle: 'Configure Argon2id, Email OTP / Magic Link, TOTP 2FA, Passkeys (WebAuthn), RFC 8628 Device Flow, IP rate limiting, and Turnstile / hCaptcha.',
    signOut: 'Sign Out',
    setupWizardTitle: 'First-Run Setup Wizard',
    setupWizardSubtitle: 'Configure database mode, resilient cache failover, Issuer URL, and super-admin credentials.',
    setupStepDb: 'Database',
    setupStepCache: 'Cache Engine',
    setupStepSite: 'Issuer URL',
    setupStepAdmin: 'Super Admin',
    testConnection: 'Test Connection',
    skipRedis: 'Skip Redis (Auto SQL Cache)',
    completeSetup: 'Initialize & Lock System',
    loginTitle: 'Sign in to your account',
    loginSubtitle: 'Authenticate securely via unified OIDC credentials or connected identity providers',
    emailLabel: 'Work Email',
    passwordLabel: 'Password',
    signInButton: 'Sign In',
    orContinueWith: 'Or continue with',
    moreSignInMethods: 'More sign-in methods',
    fewerSignInMethods: 'Show fewer methods',
    continueWithProvider: 'Continue with {provider}',
    noConnectorsEnabled: 'No social connectors enabled yet. Activate providers in the Admin Console.',
    overviewTitle: 'OIDC Gateway Overview',
    overviewSubtitle: 'Lightweight single-binary identity center with WAL concurrency and automatic Redis-to-SQL cache failover.',
    oidcEndpointsTitle: 'Standard OIDC / OAuth 2.0 Endpoints',
    storageEngineTitle: 'Dual-Mode Storage Engine',
    cacheEngineTitle: 'Resilient Cache Engine',
    simulateRedisFailover: 'Simulate Redis Outage',
    restoreRedis: 'Restore Redis',
    appsTitle: 'Business Applications',
    appsSubtitle: 'Register OIDC clients so downstream apps stay decoupled from upstream social identity providers.',
    createApp: 'New Application',
    appName: 'Application Name',
    redirectUris: 'Allowed Redirect URIs (one per line)',
    clientId: 'Client ID',
    clientSecret: 'Client Secret',
    testOidcFlow: 'Run PKCE Flow',
    connectorsTitle: 'Social Login Connectors',
    connectorsSubtitle: 'Extensible ProviderAdapter architecture. Enable and save encrypted secrets with immediate effect.',
    connectorEnabled: 'Enabled',
    connectorDisabled: 'Disabled',
    saveConnector: 'Save & Apply',
    addCustomOidc: 'Add Custom OIDC',
    loginLabTitle: 'Hosted Login & Live OIDC Flow Lab',
    loginLabSubtitle: 'Verify responsive multi-language typography, connector auto-collapse, and real RS256 PKCE token issuance.',
    viewportDesktop: 'Desktop',
    viewportMobile: 'Mobile',
    rtlPreview: 'RTL Preview',
    oidcTraceTitle: 'Live PKCE Authorization Trace & Decoded RS256 ID Token',
    sdksTitle: 'IdP Integration & Docs Center',
    sdksSubtitle: 'OIDC / OAuth 2.0 token issuance guide, 5-language minimal SDKs, signed webhook verification, and deployment docs.',
    quickStartLines: 'Quick Integration',
    fullMinimalSdk: 'Full Minimalist SDK Source',
    copyCode: 'Copy Code',
    copied: 'Copied',
    tlsCertStatus: 'TLS Certificate Resolution',
  },
  ja: {
    navOverview: 'システム概要',
    navApplications: '業務アプリ',
    navConnectors: 'ソーシャル連携',
    navUsers: '軽量 ID 基盤',
    navSecurity: '認証方式とリスク制御',
    navLoginLab: 'ログイン検証',
    navSdks: 'ドキュメント',
    tabPassword: 'パスワード',
    tabEmailOtp: 'メール OTP',
    tabPasskey: 'Passkey',
    tabDeviceFlow: 'デバイス認証',
    usersTitle: '軽量 ID ディレクトリとアカウント統合',
    usersSubtitle: '最小限の users と複数チャネル連携 user_identities で、JIT 同期・検証済メール自動紐付け・BAN Webhook 通知を実現します。',
    securityTitle: '認証方式とリスク制御',
    securitySubtitle: 'Argon2id、メール OTP/マジックリンク、TOTP 2FA、Passkeys、RFC 8628 デバイス認証、IP レート制限と Turnstile を一元管理。',
    signOut: 'サインアウト',
    setupWizardTitle: '初回セットアップウィザード',
    setupWizardSubtitle: 'データベース方式、キャッシュ自動切替、発行者 URL、管理者アカウントを設定して初期化をロックします。',
    setupStepDb: 'データベース',
    setupStepCache: 'キャッシュ',
    setupStepSite: 'Issuer 設定',
    setupStepAdmin: '管理者作成',
    testConnection: '接続テスト',
    skipRedis: 'Redis をスキップ（SQL Cache 自動使用）',
    completeSetup: '初期化を完了してロック',
    loginTitle: '統合認証サインイン',
    loginSubtitle: '組織アカウントまたは外部ソーシャル ID プロバイダーで安全にサインインします',
    emailLabel: 'メールアドレス',
    passwordLabel: 'パスワード',
    signInButton: 'サインイン',
    orContinueWith: 'または他の方法で続行',
    moreSignInMethods: 'その他のログイン方法',
    fewerSignInMethods: '表示を折りたたむ',
    continueWithProvider: '{provider} で続行',
    noConnectorsEnabled: '有効なソーシャル連携がありません。管理コンソールから有効化してください。',
    overviewTitle: 'OIDC ゲートウェイ概要',
    overviewSubtitle: '軽量単一バイナリ設計 · 標準エンドポイント、WAL 排他制御、Redis 自動フォールバック状態を確認できます。',
    oidcEndpointsTitle: '標準 OIDC / OAuth 2.0 エンドポイント',
    storageEngineTitle: 'デュアル DB ストレージ',
    cacheEngineTitle: '耐障害キャッシュエンジン',
    simulateRedisFailover: 'Redis 障害をシミュレート',
    restoreRedis: 'Redis 接続を復旧',
    appsTitle: '業務アプリケーション管理',
    appsSubtitle: 'OIDC クライアントを登録し、上位プロバイダーの差異を意識せずに統合認証を導入できます。',
    createApp: 'アプリを新規作成',
    appName: 'アプリケーション名',
    redirectUris: '許可リダイレクト URI（1行に1件）',
    clientId: 'Client ID',
    clientSecret: 'Client Secret',
    testOidcFlow: 'PKCE 認証テスト',
    connectorsTitle: 'ソーシャルログイン連携',
    connectorsSubtitle: '統一 ProviderAdapter プラグイン設計。シークレットは AES-256-GCM 暗号化で保存され即時反映されます。',
    connectorEnabled: '有効',
    connectorDisabled: '無効',
    saveConnector: '保存して即時反映',
    addCustomOidc: 'カスタム OIDC 追加',
    loginLabTitle: 'ホスト型ログイン画面と PKCE 検証',
    loginLabSubtitle: '多言語レイアウト適応、プロバイダー自動折畳み、RS256 トークン発行フローをリアルタイム確認。',
    viewportDesktop: 'デスクトップ',
    viewportMobile: 'モバイル',
    rtlPreview: 'RTL 切替',
    oidcTraceTitle: 'リアルタイム PKCE フローと RS256 トークン解析',
    sdksTitle: 'IdP 連携・ドキュメントセンター',
    sdksSubtitle: 'OIDC / OAuth 2.0 トークン発行手順、5 言語ミニマル SDK、Webhook 署名検証、本番デプロイ手順を網羅。',
    quickStartLines: 'クイック導入例',
    fullMinimalSdk: 'ミニマル SDK ソースコード',
    copyCode: 'コードをコピー',
    copied: 'コピー完了',
    tlsCertStatus: 'TLS 証明書解決ポリシー',
  },
  de: {
    navOverview: 'Systemübersicht',
    navApplications: 'Anwendungen',
    navConnectors: 'Anmeldeanbieter',
    navUsers: 'Identitätsverzeichnis',
    navSecurity: 'Sicherheit & Risiko',
    navLoginLab: 'Anmeldevorschau',
    navSdks: 'Dokumentation',
    tabPassword: 'Passwort',
    tabEmailOtp: 'E-Mail-OTP',
    tabPasskey: 'Passkey',
    tabDeviceFlow: 'Gerätecode',
    usersTitle: 'Leichtgewichtiges Identitätsverzeichnis',
    usersSubtitle: 'Trennung von Kernkonten (users) und Anbieter-Zuordnungen (user_identities) mit JIT-Verknüpfung über verifizierte E-Mails und Sperr-Webhooks.',
    securityTitle: 'Moderne Authentifizierung & Risikokontrolle',
    securitySubtitle: 'Verwalten Sie Argon2id, E-Mail-OTP/Magic Link, TOTP 2FA, Passkeys (WebAuthn), RFC 8628 Device Flow, IP-Limits und Turnstile/hCaptcha.',
    signOut: 'Abmelden',
    setupWizardTitle: 'Ersteinrichtungsassistent',
    setupWizardSubtitle: 'Datenbankmodus, ausfallsicheren Cache, Issuer-Adresse und Administratorkonto sicher konfigurieren.',
    setupStepDb: 'Datenbankmodus',
    setupStepCache: 'Cache-Speicher',
    setupStepSite: 'Issuer-Adresse',
    setupStepAdmin: 'Administrator',
    testConnection: 'Verbindung testen',
    skipRedis: 'Redis überspringen (SQL-Cache nutzen)',
    completeSetup: 'Initialisieren & sperren',
    loginTitle: 'Zentrale Identitätsanmeldung',
    loginSubtitle: 'Melden Sie sich sicher mit Ihren Anmeldeinformationen oder verknüpften Identitätsanbietern an',
    emailLabel: 'Geschäftliche E-Mail-Adresse',
    passwordLabel: 'Passwort',
    signInButton: 'Sicher anmelden',
    orContinueWith: 'Oder fortfahren mit',
    moreSignInMethods: 'Weitere Anmeldemethoden',
    fewerSignInMethods: 'Weniger Methoden anzeigen',
    continueWithProvider: 'Mit {provider} anmelden',
    noConnectorsEnabled: 'Derzeit sind keine sozialen Authentifizierungsanbieter aktiviert.',
    overviewTitle: 'OIDC-Gateway-Übersicht',
    overviewSubtitle: 'Leichtgewichtige Einzeldatei-Architektur mit WAL-Parallelität und automatischem Redis-zu-SQL-Failover.',
    oidcEndpointsTitle: 'Standardisierte OIDC- / OAuth-2.0-Endpunkte',
    storageEngineTitle: 'Dual-Mode-Datenbankmodul',
    cacheEngineTitle: 'Ausfallsichere Cache-Schicht',
    simulateRedisFailover: 'Redis-Ausfall simulieren',
    restoreRedis: 'Redis wiederherstellen',
    appsTitle: 'Geschäftsanwendungen',
    appsSubtitle: 'Verwalten Sie OIDC-Clients unabhängig von den vorgeschalteten Sozialanbietern.',
    createApp: 'Neue Anwendung',
    appName: 'Anwendungsname',
    redirectUris: 'Erlaubte Weiterleitungs-URIs (eine pro Zeile)',
    clientId: 'Client-ID',
    clientSecret: 'Client-Secret',
    testOidcFlow: 'PKCE-Flow testen',
    connectorsTitle: 'Authentifizierungsanbieter',
    connectorsSubtitle: 'Erweiterbare ProviderAdapter-Schnittstelle mit sofortiger Aktivierung und AES-256-GCM-Verschlüsselung.',
    connectorEnabled: 'Aktiviert',
    connectorDisabled: 'Deaktiviert',
    saveConnector: 'Speichern & aktivieren',
    addCustomOidc: 'Benutzerdef. OIDC',
    loginLabTitle: 'Anmeldeseite & Live-OIDC-Prüflabor',
    loginLabSubtitle: 'Prüfen Sie mehrsprachigen Zeilenumbruch, automatisches Einklappen und echte RS256-PKCE-Tokenausgabe.',
    viewportDesktop: 'Desktop',
    viewportMobile: 'Mobil',
    rtlPreview: 'RTL-Modus',
    oidcTraceTitle: 'Live-PKCE-Ablaufprotokoll & dekodiertes RS256-ID-Token',
    sdksTitle: 'IdP-Integrations- & Doku-Center',
    sdksSubtitle: 'OIDC/OAuth-2.0-Tokenausgabe, 5-Sprachen-SDKs, signierte Webhook-Prüfung und Produktions-Deployment.',
    quickStartLines: 'Schnellintegration',
    fullMinimalSdk: 'Vollständiger Minimal-SDK-Quellcode',
    copyCode: 'Code kopieren',
    copied: 'Kopiert',
    tlsCertStatus: 'TLS-Zertifikatsauflösung',
  },
};
