import type { SocialConnector, SocialProviderId } from '../types';

export interface OidcDiscoveryResult {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  end_session_endpoint?: string;
  scopes_supported?: string[];
}

export interface ConnectorTemplate {
  id: string;
  name: string;
  nameZh: string;
  tagline: string;
  taglineZh: string;
  issuerUrl: string;
  supportsDiscovery: boolean;
  defaultScope: string;
  consoleUrl: string;
  extra: Record<string, string>;
}

export const CONNECTOR_TEMPLATES: ConnectorTemplate[] = [
  {
    id: 'feishu',
    name: 'Feishu / Lark',
    nameZh: '飞书 Feishu / Lark',
    tagline: 'Enterprise workspace SSO via Open Platform OAuth2 / OIDC',
    taglineZh: '飞书开放平台企业应用 OAuth2 / OIDC 快捷登录',
    issuerUrl: 'https://open.feishu.cn/open-apis/authen/v1',
    supportsDiscovery: false,
    defaultScope: 'contact:user.email:readonly',
    consoleUrl: 'https://open.feishu.cn/app',
    extra: {
      template_id: 'feishu',
      authorization_endpoint: 'https://open.feishu.cn/open-apis/authen/v1/authorize',
      token_endpoint: 'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token',
      userinfo_endpoint: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
      scope: 'contact:user.email:readonly',
    },
  },
  {
    id: 'dingtalk',
    name: 'DingTalk',
    nameZh: '钉钉 DingTalk',
    tagline: 'Alibaba DingTalk Open Platform OAuth2 login',
    taglineZh: '钉钉开放平台扫码 / 账号 OAuth2 统一登录',
    issuerUrl: 'https://login.dingtalk.com/oauth2',
    supportsDiscovery: false,
    defaultScope: 'openid corpid',
    consoleUrl: 'https://open-dev.dingtalk.com/',
    extra: {
      template_id: 'dingtalk',
      authorization_endpoint: 'https://login.dingtalk.com/oauth2/auth',
      token_endpoint: 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
      userinfo_endpoint: 'https://api.dingtalk.com/v1.0/contact/users/me',
      scope: 'openid',
    },
  },
  {
    id: 'discord',
    name: 'Discord',
    nameZh: 'Discord',
    tagline: 'Community & developer OAuth2 with identify + email scope',
    taglineZh: '社区与开发者平台 OAuth2 登录（identify + email）',
    issuerUrl: 'https://discord.com/api/oauth2',
    supportsDiscovery: false,
    defaultScope: 'identify email',
    consoleUrl: 'https://discord.com/developers/applications',
    extra: {
      template_id: 'discord',
      authorization_endpoint: 'https://discord.com/oauth2/authorize',
      token_endpoint: 'https://discord.com/api/oauth2/token',
      userinfo_endpoint: 'https://discord.com/api/users/@me',
      scope: 'identify email',
    },
  },
  {
    id: 'slack',
    name: 'Slack (OIDC)',
    nameZh: 'Slack (标准 OIDC)',
    tagline: 'Sign in with Slack using standard OpenID Connect discovery',
    taglineZh: '支持标准 OIDC 自动发现（.well-known）一键填充端点',
    issuerUrl: 'https://slack.com',
    supportsDiscovery: true,
    defaultScope: 'openid profile email',
    consoleUrl: 'https://api.slack.com/apps',
    extra: {
      template_id: 'slack',
      authorization_endpoint: 'https://slack.com/openid/connect/authorize',
      token_endpoint: 'https://slack.com/api/openid.connect.token',
      userinfo_endpoint: 'https://slack.com/api/openid.connect.userInfo',
      scope: 'openid profile email',
    },
  },
  {
    id: 'gitlab',
    name: 'GitLab (OIDC)',
    nameZh: 'GitLab (标准 OIDC)',
    tagline: 'GitLab.com or self-hosted GitLab with auto-discovery',
    taglineZh: '支持 GitLab.com 或自建实例，自动发现 OIDC 端点',
    issuerUrl: 'https://gitlab.com',
    supportsDiscovery: true,
    defaultScope: 'openid profile email',
    consoleUrl: 'https://gitlab.com/-/user_settings/applications',
    extra: {
      template_id: 'gitlab',
      authorization_endpoint: 'https://gitlab.com/oauth/authorize',
      token_endpoint: 'https://gitlab.com/oauth/token',
      userinfo_endpoint: 'https://gitlab.com/oauth/userinfo',
      jwks_uri: 'https://gitlab.com/oauth/discovery/keys',
      scope: 'openid profile email',
    },
  },
  {
    id: 'generic_oidc',
    name: 'Standard OIDC (Okta / Keycloak / Auth0)',
    nameZh: '标准 OIDC（Okta / Keycloak / Auth0 / 自建）',
    tagline: 'Enter Issuer URL and click Auto-Discover to populate all endpoints',
    taglineZh: '仅需填入 Issuer URL，点击「自动发现」即可补齐全部端点与 JWKS',
    issuerUrl: 'https://idp.partner.com',
    supportsDiscovery: true,
    defaultScope: 'openid profile email',
    consoleUrl: 'https://openid.net/specs/openid-connect-discovery-1_0.html',
    extra: {
      template_id: 'generic_oidc',
      scope: 'openid profile email',
    },
  },
];

export interface CallbackInfo {
  callbackUri: string;
  callbackDomain: string;
  origin: string;
}

export function getConnectorCallbackInfo(
  issuerUrl: string,
  provider: SocialProviderId,
  connectorId: string
): CallbackInfo {
  const cleanIssuer = (issuerUrl || 'https://auth.example.com').trim().replace(/\/+$/, '');
  const slug = provider === 'custom_oidc' ? connectorId : provider;
  const callbackUri = `${cleanIssuer}/oauth/callback/${encodeURIComponent(slug)}`;
  let callbackDomain = 'auth.example.com';
  let origin = cleanIssuer;
  try {
    const parsed = new URL(cleanIssuer);
    callbackDomain = parsed.host;
    origin = parsed.origin;
  } catch {
    // keep fallback
  }
  return { callbackUri, callbackDomain, origin };
}

export interface SetupGuideStep {
  title: string;
  detail: string;
  copyLabel?: string;
  copyValue?: string;
}

export interface ConnectorSetupGuide {
  consoleName: string;
  consoleUrl: string;
  defaultScopes: string;
  acceptFileTypes: string;
  uploadHint: string;
  steps: SetupGuideStep[];
  callbackInfo: CallbackInfo;
}

export function getConnectorSetupGuide(
  provider: SocialProviderId,
  issuerUrl: string,
  connectorId: string,
  isZh: boolean
): ConnectorSetupGuide {
  const callbackInfo = getConnectorCallbackInfo(issuerUrl, provider, connectorId);

  switch (provider) {
    case 'google':
      return {
        consoleName: isZh ? 'Google Cloud Console · 凭据' : 'Google Cloud Console · Credentials',
        consoleUrl: 'https://console.cloud.google.com/apis/credentials',
        defaultScopes: 'openid profile email',
        acceptFileTypes: '.json,.env,.txt',
        uploadHint: isZh
          ? '支持直接上传 Google Cloud 下载的 client_secret_*.json 文件，自动填充 Client ID 与 Secret 并校验回调地址。'
          : 'Drop or upload the client_secret_*.json file downloaded from Google Cloud to auto-fill Client ID & Secret and verify the callback URI.',
        callbackInfo,
        steps: isZh
          ? [
              {
                title: '创建 Web 应用 OAuth 2.0 客户端 ID',
                detail: '在 Google Cloud Console 中进入「API 和服务 → 凭据 → 创建凭据 → OAuth 客户端 ID」，应用类型选择「Web 应用」。',
              },
              {
                title: '填入已授权的 JavaScript 来源与重定向 URI',
                detail: '将下方系统自动生成的回调地址完整复制到「已获授权的重定向 URI」列表中。',
                copyLabel: 'Callback URI',
                copyValue: callbackInfo.callbackUri,
              },
              {
                title: '下载 JSON 凭据并一键导入',
                detail: '点击创建后选择「下载 JSON」，直接拖入右侧「智能导入」即可自动填写所有字段并加密存储。',
              },
            ]
          : [
              {
                title: 'Create an OAuth 2.0 Web Client ID',
                detail: 'In Google Cloud Console, open APIs & Services -> Credentials -> Create Credentials -> OAuth client ID (Web application).',
              },
              {
                title: 'Register Authorized Redirect URI',
                detail: 'Paste this auto-generated callback URI into "Authorized redirect URIs".',
                copyLabel: 'Callback URI',
                copyValue: callbackInfo.callbackUri,
              },
              {
                title: 'Download JSON & Auto-Import',
                detail: 'Click "Download JSON" and upload it in Smart Auto-Import to populate Client ID, Secret, and validate redirect_uris automatically.',
              },
            ],
      };

    case 'github':
      return {
        consoleName: isZh ? 'GitHub Developer Settings · OAuth Apps' : 'GitHub Developer Settings · OAuth Apps',
        consoleUrl: 'https://github.com/settings/developers',
        defaultScopes: 'read:user user:email',
        acceptFileTypes: '.json,.env,.txt',
        uploadHint: isZh
          ? '支持粘贴 JSON 或 .env（GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET）一键填充。'
          : 'Paste JSON or .env lines (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET) to auto-fill.',
        callbackInfo,
        steps: isZh
          ? [
              {
                title: '新建 GitHub OAuth App',
                detail: '打开 GitHub Settings → Developer settings → OAuth Apps → New OAuth App，Homepage URL 填写你的服务域名。',
                copyLabel: 'Homepage URL',
                copyValue: callbackInfo.origin,
              },
              {
                title: '配置 Authorization callback URL',
                detail: '将下方回调地址粘贴到 Authorization callback URL。',
                copyLabel: 'Callback URI',
                copyValue: callbackInfo.callbackUri,
              },
              {
                title: '生成 Client Secret 并保存',
                detail: '点击「Generate a new client secret」，将 Client ID 与 Secret 填入右侧表单保存即生效。',
              },
            ]
          : [
              {
                title: 'Create a GitHub OAuth App',
                detail: 'Go to GitHub Settings -> Developer settings -> OAuth Apps -> New OAuth App and set Homepage URL.',
                copyLabel: 'Homepage URL',
                copyValue: callbackInfo.origin,
              },
              {
                title: 'Set Authorization Callback URL',
                detail: 'Paste this auto-generated callback URI into Authorization callback URL.',
                copyLabel: 'Callback URI',
                copyValue: callbackInfo.callbackUri,
              },
              {
                title: 'Generate Client Secret & Save',
                detail: 'Click "Generate a new client secret", enter Client ID and Secret, then save to activate immediately.',
              },
            ],
      };

    case 'microsoft':
      return {
        consoleName: isZh ? 'Microsoft Entra Admin Center · 应用注册' : 'Microsoft Entra Admin Center · App Registrations',
        consoleUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
        defaultScopes: 'openid profile email User.Read',
        acceptFileTypes: '.json,.env,.txt',
        uploadHint: isZh
          ? '支持粘贴 Azure 应用 JSON 或 OIDC Discovery URL（自动提取 Tenant ID），也可粘贴 .env。'
          : 'Paste Azure App JSON, an Entra OIDC Discovery URL (auto-extracts Tenant ID), or .env lines.',
        callbackInfo,
        steps: isZh
          ? [
              {
                title: '在 Microsoft Entra ID 中注册 Web 应用',
                detail: '选择受支持的账户类型（多租户与个人账户填 common；仅组织内部填对应 Tenant UUID）。',
              },
              {
                title: '添加 Web 平台重定向 URI',
                detail: '在「身份验证 → 添加平台 → Web」中填入下方回调地址。',
                copyLabel: 'Redirect URI',
                copyValue: callbackInfo.callbackUri,
              },
              {
                title: '创建客户端密码（Certificates & secrets）',
                detail: '新建 Client Secret 后复制「值（Value）」（注意不是 Secret ID），填入右侧并保存。',
              },
            ]
          : [
              {
                title: 'Register an App in Microsoft Entra ID',
                detail: 'Choose account type ("common" for multi-tenant + personal, "organizations" for work accounts, or your Tenant UUID).',
              },
              {
                title: 'Configure Web Redirect URI',
                detail: 'Under Authentication -> Add platform -> Web, register this callback URI.',
                copyLabel: 'Redirect URI',
                copyValue: callbackInfo.callbackUri,
              },
              {
                title: 'Create a Client Secret',
                detail: 'Under Certificates & secrets, create a new client secret and copy its Value (not Secret ID).',
              },
            ],
      };

    case 'apple':
      return {
        consoleName: isZh ? 'Apple Developer · Identifiers & Keys' : 'Apple Developer · Identifiers & Keys',
        consoleUrl: 'https://developer.apple.com/account/resources/identifiers/list/serviceId',
        defaultScopes: 'name email',
        acceptFileTypes: '.p8,.pem,.json,.env,.txt',
        uploadHint: isZh
          ? '直接上传 Apple 下载的 AuthKey_XXXXXXXXXX.p8 文件：系统会自动从文件名提取 10 位 Key ID 并填入私钥 PEM！'
          : 'Upload Apple AuthKey_XXXXXXXXXX.p8 directly: Key ID is auto-extracted from the filename and the ECDSA P-256 PEM is populated automatically.',
        callbackInfo,
        steps: isZh
          ? [
              {
                title: '创建 Services ID 并启用 Sign in with Apple',
                detail: '在 Identifiers 中创建 Services ID（作为 Client ID），勾选 Sign in with Apple 并点击 Configure。',
              },
              {
                title: '配置 Domains 与 Return URLs（form_post）',
                detail: 'Domains 填纯域名，Return URLs 填下方完整 HTTPS 回调地址（Apple 强制使用 form_post 回调）。',
                copyLabel: 'Return URL',
                copyValue: callbackInfo.callbackUri,
              },
              {
                title: '下载 .p8 私钥并一键拖拽导入',
                detail: '在 Keys 中创建勾选 Sign in with Apple 的 Key，下载 AuthKey_<KeyID>.p8 后在右侧直接上传即可自动识别 Key ID 与 PEM。',
              },
            ]
          : [
              {
                title: 'Create a Services ID & Enable Sign in with Apple',
                detail: 'Register a Services ID (your Client ID), enable Sign in with Apple, and open Configure.',
              },
              {
                title: 'Add Domain and Return URL (form_post)',
                detail: `Add domain "${callbackInfo.callbackDomain}" and register this HTTPS Return URL.`,
                copyLabel: 'Return URL',
                copyValue: callbackInfo.callbackUri,
              },
              {
                title: 'Download .p8 Key & Auto-Import',
                detail: 'Create a Key with Sign in with Apple enabled, download AuthKey_<KeyID>.p8, and upload it in Smart Auto-Import to auto-fill Key ID and PEM.',
              },
            ],
      };

    case 'wechat':
      return {
        consoleName: isZh ? '微信开放平台 / 微信公众平台' : 'WeChat Open Platform / Official Account',
        consoleUrl: 'https://open.weixin.qq.com/',
        defaultScopes: 'snsapi_login (QR) / snsapi_userinfo (MP)',
        acceptFileTypes: '.json,.env,.txt',
        uploadHint: isZh
          ? '支持粘贴 JSON 或 .env（WECHAT_APP_ID / WECHAT_APP_SECRET）自动填入。'
          : 'Paste JSON or .env lines (WECHAT_APP_ID / WECHAT_APP_SECRET) to auto-fill.',
        callbackInfo,
        steps: isZh
          ? [
              {
                title: '选择微信接入模式',
                detail: 'PC 网页扫码登录选择「微信开放平台 (qrconnect)」；微信内置浏览器静默/授权登录选择「微信公众号 (oauth2)」。',
              },
              {
                title: '配置授权回调域（仅填域名，不含 https:// 和路径）',
                detail: '微信要求仅填写纯主机域名，将下方自动提取的域名填入「授权回调域」。',
                copyLabel: '授权回调域 (Domain)',
                copyValue: callbackInfo.callbackDomain,
              },
              {
                title: '填写 AppID 与 AppSecret',
                detail: '将微信审核通过后的 AppID（wx 开头）与 AppSecret 填入右侧并保存。',
              },
            ]
          : [
              {
                title: 'Select WeChat Authorization Mode',
                detail: 'Use Open Platform QR Login (qrconnect) for desktop web, or Official Account OAuth (mp) for WeChat in-app browser.',
              },
              {
                title: 'Configure Authorization Callback Domain (host only)',
                detail: 'WeChat expects a bare domain without scheme or path. Paste the domain below into WeChat Console.',
                copyLabel: 'Callback Domain',
                copyValue: callbackInfo.callbackDomain,
              },
              {
                title: 'Enter AppID & AppSecret',
                detail: 'Paste your approved WeChat AppID (starts with "wx") and AppSecret, then save.',
              },
            ],
      };

    case 'custom_oidc':
    default:
      return {
        consoleName: isZh ? '标准 OIDC / 第三方身份源控制台' : 'Identity Provider Developer Console',
        consoleUrl: 'https://openid.net/specs/openid-connect-discovery-1_0.html',
        defaultScopes: 'openid profile email',
        acceptFileTypes: '.json,.env,.txt',
        uploadHint: isZh
          ? '填入 Issuer URL 后点击「自动发现 OIDC」，系统会自动抓取 /.well-known/openid-configuration 补全授权/令牌/用户信息/JWKS 端点。'
          : 'Enter the Issuer URL and click "Auto-Discover OIDC" to fetch /.well-known/openid-configuration and populate all endpoints automatically.',
        callbackInfo,
        steps: isZh
          ? [
              {
                title: '在第三方 IdP 中注册 OAuth2 / OIDC 应用',
                detail: '在飞书、钉钉、Discord、GitLab、Keycloak、Okta 或 Auth0 中创建 Web 应用。',
              },
              {
                title: '配置回调地址（Redirect URI）',
                detail: '将系统为此连接器生成的专属回调地址粘贴到第三方控制台的白名单中。',
                copyLabel: 'Callback URI',
                copyValue: callbackInfo.callbackUri,
              },
              {
                title: '点击「自动发现 OIDC」补齐端点',
                detail: '粘贴 Issuer URL 后点击自动发现即可自动填充 authorization / token / userinfo / jwks_uri，无需手动复制端点。',
              },
            ]
          : [
              {
                title: 'Create an OIDC / OAuth2 App in Your Provider',
                detail: 'Register a Web application in Feishu, DingTalk, Discord, Slack, GitLab, Okta, Keycloak, or Auth0.',
              },
              {
                title: 'Register Dedicated Callback URI',
                detail: 'Add this connector-specific callback URI to your IdP allowed redirect URIs.',
                copyLabel: 'Callback URI',
                copyValue: callbackInfo.callbackUri,
              },
              {
                title: 'Run One-Click OIDC Auto-Discovery',
                detail: 'Enter the Issuer URL and click Auto-Discover to fetch authorization, token, userinfo, and JWKS endpoints automatically.',
              },
            ],
      };
  }
}

export interface AutoImportResult {
  ok: boolean;
  summary: string;
  warnings: string[];
  clientId?: string;
  clientSecret?: string;
  displayName?: string;
  extra?: Record<string, string>;
  detectedRedirectUris?: string[];
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }
  return undefined;
}

export function parseConnectorAutoImport(
  rawText: string,
  provider: SocialProviderId,
  fileName = '',
  expectedCallbackUri = ''
): AutoImportResult {
  const trimmed = (rawText || '').trim();
  if (!trimmed) {
    return { ok: false, summary: 'Input is empty.', warnings: [] };
  }

  const warnings: string[] = [];
  const extra: Record<string, string> = {};

  if (trimmed.includes('-----BEGIN PRIVATE KEY-----') || trimmed.includes('-----BEGIN EC PRIVATE KEY-----')) {
    const keyIdMatch = fileName.match(/AuthKey_([A-Za-z0-9]{10})\.p8$/i);
    if (keyIdMatch) {
      extra.key_id = keyIdMatch[1].toUpperCase();
    }
    if (provider !== 'apple') {
      warnings.push('Detected PEM private key (typically used for Apple Sign-In).');
    }
    return {
      ok: true,
      summary: keyIdMatch
        ? `Parsed Apple .p8 private key and extracted Key ID (${extra.key_id}) from filename.`
        : 'Parsed PEM private key.',
      warnings,
      clientSecret: trimmed,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    };
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const root =
        (parsed.web && typeof parsed.web === 'object' ? (parsed.web as Record<string, unknown>) : null) ||
        (parsed.installed && typeof parsed.installed === 'object'
          ? (parsed.installed as Record<string, unknown>)
          : null) ||
        (parsed.config && typeof parsed.config === 'object' ? (parsed.config as Record<string, unknown>) : null) ||
        parsed;

      const clientId = firstString(root, [
        'client_id',
        'clientId',
        'app_id',
        'appId',
        'appid',
        'service_id',
        'serviceId',
      ]);
      const clientSecret = firstString(root, [
        'client_secret',
        'clientSecret',
        'app_secret',
        'appSecret',
        'private_key',
        'privateKey',
        'p8',
      ]);
      const displayName = firstString(root, ['displayName', 'display_name', 'name']);

      const tenantId = firstString(root, ['tenant_id', 'tenantId', 'tenant']);
      if (tenantId) extra.tenant_id = tenantId;

      const teamId = firstString(root, ['team_id', 'teamId']);
      if (teamId) extra.team_id = teamId;

      const keyId = firstString(root, ['key_id', 'keyId']);
      if (keyId) extra.key_id = keyId;

      const wechatMode = firstString(root, ['wechat_mode', 'wechatMode']);
      if (wechatMode === 'qr' || wechatMode === 'mp') extra.wechat_mode = wechatMode;

      const scope = firstString(root, ['scope', 'scopes']);
      if (scope) extra.scope = scope;

      const discoveryUrl = firstString(root, ['issuer', 'issuerUrl', 'issuer_url', 'discovery_url', 'discoveryUrl']);
      if (discoveryUrl) {
        extra.discovery_url = discoveryUrl.replace(/\/\.well-known\/openid-configuration$/i, '');
        const msMatch = discoveryUrl.match(/login\.microsoftonline\.com\/([^/]+)/i);
        if (msMatch && !extra.tenant_id) {
          extra.tenant_id = msMatch[1];
        }
      }

      const authEp = firstString(root, ['authorization_endpoint', 'authorizationEndpoint']);
      if (authEp) extra.authorization_endpoint = authEp;
      const tokenEp = firstString(root, ['token_endpoint', 'tokenEndpoint']);
      if (tokenEp) extra.token_endpoint = tokenEp;
      const userinfoEp = firstString(root, ['userinfo_endpoint', 'userinfoEndpoint']);
      if (userinfoEp) extra.userinfo_endpoint = userinfoEp;
      const jwksUri = firstString(root, ['jwks_uri', 'jwksUri']);
      if (jwksUri) extra.jwks_uri = jwksUri;

      const detectedRedirectUris = Array.isArray(root.redirect_uris)
        ? root.redirect_uris.filter((u): u is string => typeof u === 'string')
        : undefined;

      if (detectedRedirectUris && expectedCallbackUri && !detectedRedirectUris.includes(expectedCallbackUri)) {
        warnings.push(
          `Callback URI "${expectedCallbackUri}" is not listed in the imported JSON redirect_uris (${detectedRedirectUris.join(', ')}). Remember to add it in the provider console.`
        );
      }

      if (!clientId && !clientSecret && Object.keys(extra).length === 0) {
        return {
          ok: false,
          summary: 'JSON parsed, but no recognizable OAuth/OIDC fields (clientId, clientSecret, issuer, etc.) were found.',
          warnings,
        };
      }

      const foundFields: string[] = [];
      if (clientId) foundFields.push('Client ID');
      if (clientSecret) foundFields.push('Client Secret');
      if (extra.tenant_id) foundFields.push(`Tenant (${extra.tenant_id})`);
      if (extra.team_id) foundFields.push('Team ID');
      if (extra.key_id) foundFields.push('Key ID');
      if (extra.discovery_url) foundFields.push('Issuer URL');
      if (extra.authorization_endpoint) foundFields.push('OIDC Endpoints');

      return {
        ok: true,
        summary: `Auto-populated: ${foundFields.join(', ')}.`,
        warnings,
        clientId,
        clientSecret,
        displayName,
        extra: Object.keys(extra).length > 0 ? extra : undefined,
        detectedRedirectUris,
      };
    } catch {
      return {
        ok: false,
        summary: 'Invalid JSON syntax. Please paste valid JSON, .env key=value lines, or an Apple .p8 file.',
        warnings: [],
      };
    }
  }

  if (/^https:\/\/\S+$/i.test(trimmed)) {
    const cleanIssuer = trimmed.replace(/\/\.well-known\/openid-configuration\/?$/i, '').replace(/\/+$/, '');
    const msMatch = cleanIssuer.match(/login\.microsoftonline\.com\/([^/]+)/i);
    if (provider === 'microsoft' && msMatch) {
      return {
        ok: true,
        summary: `Extracted Microsoft Entra Tenant ID: ${msMatch[1]}.`,
        warnings: [],
        extra: { tenant_id: msMatch[1] },
      };
    }
    return {
      ok: true,
      summary: `Extracted Discovery / Issuer URL: ${cleanIssuer}.`,
      warnings: [],
      extra: { discovery_url: cleanIssuer },
    };
  }

  const envMap: Record<string, string> = {};
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line
      .slice(0, eqIdx)
      .trim()
      .replace(/^export\s+/i, '')
      .toUpperCase();
    let val = line.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && val) {
      envMap[key] = val;
    }
  }

  if (Object.keys(envMap).length > 0) {
    const pickEnv = (suffixes: string[]): string | undefined => {
      const prefix = provider.toUpperCase();
      for (const s of suffixes) {
        if (envMap[`${prefix}_${s}`]) return envMap[`${prefix}_${s}`];
      }
      for (const s of suffixes) {
        if (envMap[s]) return envMap[s];
      }
      for (const [k, v] of Object.entries(envMap)) {
        if (suffixes.some((s) => k.endsWith(`_${s}`))) return v;
      }
      return undefined;
    };

    const clientId = pickEnv(['CLIENT_ID', 'APP_ID', 'APPID', 'SERVICE_ID']);
    const clientSecret = pickEnv(['CLIENT_SECRET', 'APP_SECRET', 'PRIVATE_KEY']);
    const tenantId = pickEnv(['TENANT_ID', 'TENANT']);
    const teamId = pickEnv(['TEAM_ID']);
    const keyId = pickEnv(['KEY_ID']);
    const discoveryUrl = pickEnv(['ISSUER_URL', 'ISSUER', 'DISCOVERY_URL']);
    const scope = pickEnv(['SCOPE', 'SCOPES']);
    const wechatMode = pickEnv(['WECHAT_MODE', 'MODE']);

    if (tenantId) extra.tenant_id = tenantId;
    if (teamId) extra.team_id = teamId;
    if (keyId) extra.key_id = keyId;
    if (discoveryUrl) extra.discovery_url = discoveryUrl.replace(/\/\.well-known\/openid-configuration$/i, '');
    if (scope) extra.scope = scope;
    if (wechatMode === 'qr' || wechatMode === 'mp') extra.wechat_mode = wechatMode;

    if (clientId || clientSecret || Object.keys(extra).length > 0) {
      const found: string[] = [];
      if (clientId) found.push('Client ID');
      if (clientSecret) found.push('Client Secret');
      if (extra.tenant_id) found.push(`Tenant (${extra.tenant_id})`);
      if (extra.team_id) found.push('Team ID');
      if (extra.key_id) found.push('Key ID');
      if (extra.discovery_url) found.push('Issuer URL');
      return {
        ok: true,
        summary: `Parsed .env config: ${found.join(', ')}.`,
        warnings,
        clientId,
        clientSecret,
        extra: Object.keys(extra).length > 0 ? extra : undefined,
      };
    }
  }

  return {
    ok: false,
    summary: 'Unrecognized format. Supported: Google client_secret_*.json, Apple AuthKey_*.p8, Logto JSON, OIDC Issuer URL, or .env KEY=VALUE.',
    warnings: [],
  };
}

export interface ConnectorValidationResult {
  ready: boolean;
  isDemoPlaceholder: boolean;
  issues: string[];
  authUrlPreview: string;
  callbackUri: string;
}

export function validateAndBuildAuthPreview(params: {
  provider: SocialProviderId;
  connectorId: string;
  clientId: string;
  hasSecret: boolean;
  draftSecret: string;
  extra: Record<string, string>;
  issuerUrl: string;
  isZh: boolean;
}): ConnectorValidationResult {
  const { provider, connectorId, clientId, hasSecret, draftSecret, extra, issuerUrl, isZh } = params;
  const { callbackUri } = getConnectorCallbackInfo(issuerUrl, provider, connectorId);
  const issues: string[] = [];
  const trimmedCid = (clientId || '').trim();
  const hasAnySecret = Boolean((draftSecret || '').trim() || hasSecret);

  const demoHints = ['placeholder', 'demo', 'ms-entra-tenant-app-id', '918273645-wimotek', 'wx8f4a9c2b1d3e5f6a', 'Ov23liWimotekDemo01', 'dev.wimotek.oauth.service'];
  const isDemoPlaceholder = demoHints.some((h) => trimmedCid.toLowerCase().includes(h.toLowerCase()));

  if (!trimmedCid) {
    issues.push(isZh ? '缺少 Client ID / AppID。' : 'Client ID / AppID is required.');
  }
  if (!hasAnySecret) {
    issues.push(isZh ? '缺少 Client Secret（或 Apple .p8 私钥）。' : 'Client Secret (or Apple .p8 private key) is required.');
  }

  let authUrlPreview = '';
  const sampleState = 'wimotek_verify_state';

  if (provider === 'google') {
    if (trimmedCid && !trimmedCid.endsWith('.apps.googleusercontent.com')) {
      issues.push(
        isZh
          ? 'Google Client ID 通常以 .apps.googleusercontent.com 结尾，请确认填写无误。'
          : 'Google Client IDs typically end with .apps.googleusercontent.com.'
      );
    }
    const q = new URLSearchParams({
      client_id: trimmedCid || '<CLIENT_ID>',
      redirect_uri: callbackUri,
      response_type: 'code',
      scope: extra.scope || 'openid profile email',
      state: sampleState,
    });
    authUrlPreview = `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
  } else if (provider === 'github') {
    const q = new URLSearchParams({
      client_id: trimmedCid || '<CLIENT_ID>',
      redirect_uri: callbackUri,
      scope: extra.scope || 'read:user user:email',
      state: sampleState,
    });
    authUrlPreview = `https://github.com/login/oauth/authorize?${q.toString()}`;
  } else if (provider === 'microsoft') {
    const tenant = (extra.tenant_id || 'common').trim() || 'common';
    const q = new URLSearchParams({
      client_id: trimmedCid || '<CLIENT_ID>',
      response_type: 'code',
      redirect_uri: callbackUri,
      scope: extra.scope || 'openid profile email User.Read',
      state: sampleState,
    });
    authUrlPreview = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${q.toString()}`;
  } else if (provider === 'apple') {
    if (!extra.team_id?.trim()) {
      issues.push(isZh ? '缺少 Apple Team ID（10 位字母数字）。' : 'Apple Team ID (10-char alphanumeric) is required.');
    }
    if (!extra.key_id?.trim()) {
      issues.push(isZh ? '缺少 Apple Key ID（上传 .p8 文件可自动识别）。' : 'Apple Key ID is required (upload .p8 file to auto-extract).');
    }
    if (draftSecret.trim() && !draftSecret.includes('BEGIN PRIVATE KEY') && !draftSecret.includes('BEGIN EC PRIVATE KEY')) {
      issues.push(isZh ? 'Apple .p8 私钥格式不正确，应以 -----BEGIN PRIVATE KEY----- 开头。' : 'Apple .p8 key must be a valid PEM starting with -----BEGIN PRIVATE KEY-----.');
    }
    const q = new URLSearchParams({
      client_id: trimmedCid || '<SERVICE_ID>',
      redirect_uri: callbackUri,
      response_type: 'code id_token',
      response_mode: 'form_post',
      scope: 'name email',
      state: sampleState,
    });
    authUrlPreview = `https://appleid.apple.com/auth/authorize?${q.toString()}`;
  } else if (provider === 'wechat') {
    if (trimmedCid && !trimmedCid.startsWith('wx')) {
      issues.push(isZh ? '微信 AppID 通常以 wx 开头。' : 'WeChat AppID typically starts with "wx".');
    }
    const mode = extra.wechat_mode === 'mp' ? 'mp' : 'qr';
    const q = new URLSearchParams({
      appid: trimmedCid || '<APP_ID>',
      redirect_uri: callbackUri,
      response_type: 'code',
      scope: mode === 'mp' ? 'snsapi_userinfo' : 'snsapi_login',
      state: sampleState,
    });
    authUrlPreview =
      mode === 'mp'
        ? `https://open.weixin.qq.com/connect/oauth2/authorize?${q.toString()}#wechat_redirect`
        : `https://open.weixin.qq.com/connect/qrconnect?${q.toString()}#wechat_redirect`;
  } else {
    const authEp = (extra.authorization_endpoint || '').trim();
    const discovery = (extra.discovery_url || '').trim();
    if (!discovery && !authEp) {
      issues.push(
        isZh
          ? '请填写 Discovery / Issuer URL 并点击「自动发现 OIDC」，或填写 Authorization Endpoint。'
          : 'Provide a Discovery / Issuer URL and click Auto-Discover OIDC, or fill in Authorization Endpoint.'
      );
    }
    const baseAuth = authEp || `${discovery.replace(/\/+$/, '')}/authorize`;
    const q = new URLSearchParams({
      client_id: trimmedCid || '<CLIENT_ID>',
      redirect_uri: callbackUri,
      response_type: 'code',
      scope: extra.scope || 'openid profile email',
      state: sampleState,
    });
    authUrlPreview = `${baseAuth}?${q.toString()}`;
  }

  return {
    ready: issues.length === 0 && !isDemoPlaceholder,
    isDemoPlaceholder,
    issues,
    authUrlPreview,
    callbackUri,
  };
}

export function buildConnectorConfigJson(connector: SocialConnector, issuerUrl: string): string {
  const { callbackUri } = getConnectorCallbackInfo(issuerUrl, connector.provider, connector.id);
  const payload: Record<string, unknown> = {
    provider: connector.provider,
    displayName: connector.displayName,
    enabled: connector.enabled,
    callbackUri,
    clientId: connector.clientId,
    clientSecret: '<SET_YOUR_SECRET_HERE>',
    ...connector.extra,
  };
  return JSON.stringify(payload, null, 2);
}

export function buildConnectorEnvSnippet(connector: SocialConnector, issuerUrl: string): string {
  const { callbackUri } = getConnectorCallbackInfo(issuerUrl, connector.provider, connector.id);
  const prefix = connector.provider.toUpperCase();
  const lines = [
    `# ${connector.displayName} — Callback URI: ${callbackUri}`,
    `${prefix}_CLIENT_ID=${connector.clientId || ''}`,
    `${prefix}_CLIENT_SECRET=<SET_YOUR_SECRET_HERE>`,
  ];
  if (connector.extra.tenant_id) lines.push(`${prefix}_TENANT_ID=${connector.extra.tenant_id}`);
  if (connector.extra.team_id) lines.push(`${prefix}_TEAM_ID=${connector.extra.team_id}`);
  if (connector.extra.key_id) lines.push(`${prefix}_KEY_ID=${connector.extra.key_id}`);
  if (connector.extra.wechat_mode) lines.push(`${prefix}_WECHAT_MODE=${connector.extra.wechat_mode}`);
  if (connector.extra.discovery_url) lines.push(`${prefix}_ISSUER_URL=${connector.extra.discovery_url}`);
  if (connector.extra.scope) lines.push(`${prefix}_SCOPE="${connector.extra.scope}"`);
  return lines.join('\n');
}
