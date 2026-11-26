export type Locale = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'de';

export type DbDriver = 'sqlite3' | 'mysql';
export type CacheMode = 'redis' | 'sql_fallback';

export interface SystemConfig {
  initialized: boolean;
  issuerUrl: string;
  dbDriver: DbDriver;
  dbDsn: string;
  sqliteWalEnabled: boolean;
  sqliteBusyTimeoutMs: number;
  sqliteMaxWriteConns: number;
  redisEnabled: boolean;
  redisAddr: string;
  redisSimulatedDown: boolean;
  activeCacheMode: CacheMode;
  tlsSource: string;
  adminEmail: string;
}

export interface RetiringKeyInfo {
  kid: string;
  expiresAt: string;
}

export interface SigningKeyStatus {
  activeKid: string;
  rotatedAt: string;
  jwksKeyCount: number;
  retiringKeys: RetiringKeyInfo[];
}

export type LoginThemeLayout = 'centered' | 'split_left' | 'split_right' | 'minimal';
export type LoginThemeSurface = 'auto' | 'light' | 'dark';
export type LoginThemeRadius = 'sharp' | 'rounded' | 'pill';
export type LoginThemeFont = 'sans' | 'serif' | 'mono';

export interface LoginThemeConfig {
  layout: LoginThemeLayout;
  surfaceMode: LoginThemeSurface;
  brandTitle: string;
  brandSubtitle: string;
  heroTitle: string;
  heroSubtitle: string;
  logoUrl: string;
  primaryColor: string;
  backgroundColor: string;
  cardColor: string;
  textColor: string;
  borderRadius: LoginThemeRadius;
  fontFamily: LoginThemeFont;
  socialLayout: 'stack' | 'grid';
  footerText: string;
  customCss: string;
}

export interface OAuthApplication {
  id: string;
  name: string;
  description: string;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  scopes: string[];
  loginTheme?: LoginThemeConfig;
  createdAt: string;
}

export type SocialProviderId = 'microsoft' | 'apple' | 'google' | 'wechat' | 'github' | 'custom_oidc';
export type IdentityProviderType = SocialProviderId | 'passkey' | 'email_otp' | 'device_flow';

export interface SocialConnector {
  id: string;
  provider: SocialProviderId;
  displayName: string;
  enabled: boolean;
  clientId: string;
  hasSecret: boolean;
  secretMasked: string;
  extra: Record<string, string>;
  updatedAt: string;
}

export interface UserIdentityLink {
  id: string;
  userId: string;
  provider: IdentityProviderType;
  providerLabel: string;
  providerSub: string;
  email: string;
  linkedAt: string;
}

export interface IdentityUser {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  passwordAlgo: 'argon2id' | 'none';
  totpEnabled: boolean;
  passkeyCount: number;
  status: 'active' | 'banned';
  identities: UserIdentityLink[];
  createdAt: string;
  lastLoginAt: string;
}

export type CaptchaProvider = 'none' | 'turnstile' | 'hcaptcha';

export interface AuthPolicyConfig {
  enablePasswordArgon2id: boolean;
  enableEmailOtpMagicLink: boolean;
  enableTotp2fa: boolean;
  enablePasskeysWebAuthn: boolean;
  enableDeviceFlowRfc8628: boolean;
  jitVerifiedEmailAutoLink: boolean;
  ipRateLimitPerMin: number;
  lockoutThreshold: number;
  captchaProvider: CaptchaProvider;
  captchaSiteKey: string;
}

export interface WebhookSubscription {
  id: string;
  name: string;
  targetUrl: string;
  events: string[];
  enabled: boolean;
  hasSecret: boolean;
  secretMasked: string;
  createdAt: string;
}

export interface WebhookDeliveryLog {
  id: string;
  webhookId: string;
  targetUrl: string;
  event: string;
  userEmail: string;
  signatureHeader: string;
  payloadPreview: string;
  status: 'delivered' | 'simulated_sandbox';
  timestamp: string;
}

export interface DeviceAuthSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  status: 'pending' | 'approved' | 'expired';
  approvedEmail?: string;
}

export interface AuthUser {
  sub: string;
  email: string;
  name: string;
  role: 'super_admin' | 'member';
  provider: string;
}

export interface OidcFlowTrace {
  provider: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  authorizationCode: string;
  cacheBackendUsed: CacheMode;
  authMethod?: string;
  jitAction?: 'matched_identity' | 'linked_existing_verified_email' | 'provisioned_new_user';
  tokenResponse: {
    token_type: 'Bearer';
    expires_in: number;
    access_token: string;
    refresh_token: string;
    id_token: string;
    scope: string;
  };
  decodedIdToken: {
    header: Record<string, unknown>;
    payload: Record<string, unknown>;
    signatureVerified: boolean;
  };
  userInfo: Record<string, unknown>;
  elapsedMs: number;
}
