import type { Locale, LoginThemeConfig, LoginThemeLayout, LoginThemeRadius, LoginThemeFont, LoginThemeSurface } from '../types';

export const DEFAULT_LOGIN_THEME: LoginThemeConfig = {
  layout: 'centered',
  surfaceMode: 'auto',
  brandTitle: 'wimotek/Oauth',
  brandSubtitle: '',
  heroTitle: 'One unified identity for every workspace.',
  heroSubtitle: 'Sign in once with Passkeys, Social OIDC, or Passwordless Email OTP — secured with RS256 and PKCE S256.',
  logoUrl: '',
  primaryColor: '#4F46E5',
  backgroundColor: '#F8FAFC',
  cardColor: '#FFFFFF',
  textColor: '#0F172A',
  borderRadius: 'rounded',
  fontFamily: 'sans',
  socialLayout: 'stack',
  footerText: 'wimotek/Oauth',
  customCss: '',
};

export interface LoginThemePreset {
  id: string;
  nameEn: string;
  nameZh: string;
  theme: LoginThemeConfig;
}

export const LOGIN_THEME_PRESETS: LoginThemePreset[] = [
  {
    id: 'wimotek_default',
    nameEn: 'Wimotek Crisp',
    nameZh: 'Wimotek 默认极简',
    theme: { ...DEFAULT_LOGIN_THEME },
  },
  {
    id: 'split_saas',
    nameEn: 'Split Brand Showcase',
    nameZh: '左右分栏品牌视觉',
    theme: {
      ...DEFAULT_LOGIN_THEME,
      layout: 'split_left',
      surfaceMode: 'light',
      primaryColor: '#4F46E5',
      backgroundColor: '#F1F5F9',
      cardColor: '#FFFFFF',
      textColor: '#0F172A',
      borderRadius: 'rounded',
      fontFamily: 'sans',
    },
  },
  {
    id: 'midnight_dev',
    nameEn: 'Midnight Developer',
    nameZh: '暗黑开发者风格',
    theme: {
      ...DEFAULT_LOGIN_THEME,
      layout: 'centered',
      surfaceMode: 'dark',
      primaryColor: '#6366F1',
      backgroundColor: '#090D16',
      cardColor: '#111827',
      textColor: '#F8FAFC',
      borderRadius: 'rounded',
      fontFamily: 'mono',
      socialLayout: 'grid',
    },
  },
  {
    id: 'emerald_enterprise',
    nameEn: 'Emerald Enterprise',
    nameZh: '商务翠绿分栏',
    theme: {
      ...DEFAULT_LOGIN_THEME,
      layout: 'split_right',
      surfaceMode: 'light',
      primaryColor: '#059669',
      backgroundColor: '#ECFDF5',
      cardColor: '#FFFFFF',
      textColor: '#064E3B',
      borderRadius: 'sharp',
      fontFamily: 'sans',
      heroTitle: 'Enterprise Access Portal',
      heroSubtitle: 'Zero-trust single sign-on with audited OIDC tokens and instant revocation.',
    },
  },
  {
    id: 'editorial_minimal',
    nameEn: 'Editorial Minimal',
    nameZh: '编辑风极简无框',
    theme: {
      ...DEFAULT_LOGIN_THEME,
      layout: 'minimal',
      surfaceMode: 'light',
      primaryColor: '#18181B',
      backgroundColor: '#FAFAF9',
      cardColor: '#FFFFFF',
      textColor: '#1C1917',
      borderRadius: 'pill',
      fontFamily: 'serif',
    },
  },
];

const VALID_LAYOUTS = new Set<LoginThemeLayout>(['centered', 'split_left', 'split_right', 'minimal']);
const VALID_SURFACES = new Set<LoginThemeSurface>(['auto', 'light', 'dark']);
const VALID_RADII = new Set<LoginThemeRadius>(['sharp', 'rounded', 'pill']);
const VALID_FONTS = new Set<LoginThemeFont>(['sans', 'serif', 'mono']);
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isValidHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value.trim());
}

export function isSafeAssetUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function sanitizeCustomCss(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const stripped = raw
    .replace(/<\/?style[^>]*>/gi, '')
    .replace(/@import\b[^;]*;?/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/vbscript\s*:/gi, '')
    .replace(/behavior\s*:/gi, '')
    .replace(/url\s*\(\s*['"]?\s*(?:javascript|data:text\/html)/gi, 'url(about:blank');
  return stripped.slice(0, 4000).trim();
}

export function normalizeLoginTheme(input?: Partial<LoginThemeConfig> | null): LoginThemeConfig {
  const src = input && typeof input === 'object' ? input : {};
  return {
    layout: VALID_LAYOUTS.has(src.layout as LoginThemeLayout) ? (src.layout as LoginThemeLayout) : DEFAULT_LOGIN_THEME.layout,
    surfaceMode: VALID_SURFACES.has(src.surfaceMode as LoginThemeSurface)
      ? (src.surfaceMode as LoginThemeSurface)
      : DEFAULT_LOGIN_THEME.surfaceMode,
    brandTitle: typeof src.brandTitle === 'string' ? src.brandTitle.trim().slice(0, 80) : DEFAULT_LOGIN_THEME.brandTitle,
    brandSubtitle: typeof src.brandSubtitle === 'string' ? src.brandSubtitle.trim().slice(0, 160) : DEFAULT_LOGIN_THEME.brandSubtitle,
    heroTitle: typeof src.heroTitle === 'string' ? src.heroTitle.trim().slice(0, 120) : DEFAULT_LOGIN_THEME.heroTitle,
    heroSubtitle: typeof src.heroSubtitle === 'string' ? src.heroSubtitle.trim().slice(0, 240) : DEFAULT_LOGIN_THEME.heroSubtitle,
    logoUrl: isSafeAssetUrl(src.logoUrl) ? String(src.logoUrl || '').trim().slice(0, 400) : '',
    primaryColor: isValidHexColor(src.primaryColor) ? src.primaryColor.trim() : DEFAULT_LOGIN_THEME.primaryColor,
    backgroundColor: isValidHexColor(src.backgroundColor) ? src.backgroundColor.trim() : DEFAULT_LOGIN_THEME.backgroundColor,
    cardColor: isValidHexColor(src.cardColor) ? src.cardColor.trim() : DEFAULT_LOGIN_THEME.cardColor,
    textColor: isValidHexColor(src.textColor) ? src.textColor.trim() : DEFAULT_LOGIN_THEME.textColor,
    borderRadius: VALID_RADII.has(src.borderRadius as LoginThemeRadius)
      ? (src.borderRadius as LoginThemeRadius)
      : DEFAULT_LOGIN_THEME.borderRadius,
    fontFamily: VALID_FONTS.has(src.fontFamily as LoginThemeFont)
      ? (src.fontFamily as LoginThemeFont)
      : DEFAULT_LOGIN_THEME.fontFamily,
    socialLayout: src.socialLayout === 'grid' ? 'grid' : 'stack',
    footerText: typeof src.footerText === 'string' ? src.footerText.trim().slice(0, 80) : DEFAULT_LOGIN_THEME.footerText,
    customCss: sanitizeCustomCss(src.customCss),
  };
}

export function getRadiusClasses(radius: LoginThemeRadius): { card: string; control: string } {
  switch (radius) {
    case 'sharp':
      return { card: 'rounded-sm', control: 'rounded-sm' };
    case 'pill':
      return { card: 'rounded-3xl', control: 'rounded-full' };
    case 'rounded':
    default:
      return { card: 'rounded-xl', control: 'rounded-lg' };
  }
}

export function getFontFamilyClass(font: LoginThemeFont): string {
  switch (font) {
    case 'serif':
      return 'font-serif';
    case 'mono':
      return 'font-mono';
    case 'sans':
    default:
      return 'font-sans';
  }
}

export type AiLoginEntryMode = 'direct_redirect' | 'button_trigger';

function isLocalHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return !h || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost');
}

export function isNonLocalHttpUrl(urlStr?: string): boolean {
  const raw = (urlStr || '').trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' && !isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Resolves the effective public Issuer URL for prompts, MCP configs, SDK snippets, and Callback URIs.
 * When accessed over HTTPS behind a reverse proxy that forwards plain HTTP internally (and may omit X-Forwarded-Proto),
 * automatically upgrades matching-host or localhost http:// issuers to the browser's https:// origin.
 */
export function resolveEffectiveIssuerUrl(issuerUrl?: string, browserOrigin?: string): string {
  const fallbackOrigin =
    (browserOrigin !== undefined ? browserOrigin : typeof window !== 'undefined' ? window.location.origin : '')
      .trim()
      .replace(/\/+$/, '');
  const rawIssuer = (issuerUrl || '').trim().replace(/\/+$/, '');

  if (!rawIssuer) {
    return fallbackOrigin || 'http://localhost:8080';
  }

  if (!fallbackOrigin) {
    return rawIssuer;
  }

  try {
    const parsedIssuer = new URL(rawIssuer);
    const parsedBrowser = new URL(fallbackOrigin);
    if (parsedBrowser.protocol === 'https:') {
      if (isLocalHostname(parsedIssuer.hostname) && !isLocalHostname(parsedBrowser.hostname)) {
        return fallbackOrigin;
      }
      if (
        parsedIssuer.protocol === 'http:' &&
        parsedIssuer.hostname.toLowerCase() === parsedBrowser.hostname.toLowerCase()
      ) {
        parsedIssuer.protocol = 'https:';
        if (parsedBrowser.port) {
          parsedIssuer.port = parsedBrowser.port;
        } else if (parsedIssuer.port === '80' || parsedIssuer.port === '8080') {
          parsedIssuer.port = '';
        }
        return parsedIssuer.toString().replace(/\/+$/, '');
      }
    }
  } catch {
    // keep rawIssuer if parsing fails
  }

  return rawIssuer;
}

export function buildAiThemeSyncPrompt(opts: {
  issuerUrl: string;
  clientId: string;
  appName: string;
  currentTheme: LoginThemeConfig;
  locale: Locale;
}): string {
  const issuer = resolveEffectiveIssuerUrl(opts.issuerUrl);
  const isZh = opts.locale === 'zh-CN' || opts.locale === 'zh-TW';

  if (isZh) {
    return `请分析我当前网站项目的视觉设计系统（包括 Tailwind 配置 / CSS 变量 / 主色调 / 背景色 / 圆角 / 字体 / Logo / 排版风格），并自动把 wimotek/Oauth 托管登录页的样式同步成与当前网站完全一致的风格。

### 1. 目标 OAuth 应用信息
- **Issuer 地址**: ${issuer}
- **应用名称**: ${opts.appName}
- **Client ID**: ${opts.clientId}
- **样式配置接口 (PUT)**: \`PUT ${issuer}/api/applications/${opts.clientId}/theme\`
- **公开读取接口 (GET)**: \`GET ${issuer}/api/public/theme?client_id=${opts.clientId}\`
- **MCP Server 端点 (JSON-RPC 2.0)**: \`POST ${issuer}/api/mcp\`（支持 \`list_applications\` / \`get_login_theme\` / \`update_login_theme\` 等工具）
- **认证请求头**: \`Authorization: Bearer $WIMOTEK_ADMIN_TOKEN\`（可在控制台「安全策略 → Admin API Tokens」或本页点击“生成 Admin Token”签发 \`wmk_pat_...\` 令牌）

### 2. 请求体 JSON Schema（所有字段均支持按需修改）
\`\`\`json
{
  "layout": "centered | split_left | split_right | minimal",
  "surfaceMode": "auto | light | dark",
  "brandTitle": "你的网站品牌名",
  "brandSubtitle": "登录副标题（可留空使用默认国际化文案）",
  "heroTitle": "左右分栏模式下侧边品牌区主标题",
  "heroSubtitle": "左右分栏模式下侧边品牌区介绍文案",
  "logoUrl": "https://你的网站域名/logo.svg",
  "primaryColor": "#4F46E5",
  "backgroundColor": "#F8FAFC",
  "cardColor": "#FFFFFF",
  "textColor": "#0F172A",
  "borderRadius": "sharp | rounded | pill",
  "fontFamily": "sans | serif | mono",
  "socialLayout": "stack | grid",
  "footerText": "你的网站版权或品牌名",
  "customCss": "[data-wimotek-login-card] { box-shadow: 0 20px 50px rgba(0,0,0,0.08); }"
}
\`\`\`

### 3. 你需要做的事
1. 扫描我当前项目的 \`tailwind.config.*\`、全局 CSS、Logo 文件和首页排版风格，提取最贴合的配色（HEX）、圆角、字体与排版模式（如后台管理系统优先 \`split_left\`，极简工具优先 \`centered\` 或 \`minimal\`）。
2. 生成一份贴合我网站风格的完整主题 JSON（如有精细微调，可将规则写在 \`customCss\` 中并限定在 \`[data-wimotek-login-root]\` 或 \`[data-wimotek-login-card]\` 选择器下）。
3. 给出可直接执行的 \`curl -X PUT\` 命令（或封装成一个 \`scripts/sync-oauth-theme.sh\` 脚本），调用 \`PUT ${issuer}/api/applications/${opts.clientId}/theme\` 完成样式同步。

### 当前已保存的主题快照
\`\`\`json
${JSON.stringify(opts.currentTheme, null, 2)}
\`\`\``;
  }

  return `Inspect my current website's design system (Tailwind config, CSS variables, brand colors, surfaces, border radius, typography, logo, and layout style), and synchronize our wimotek/Oauth hosted login page to match my website seamlessly.

### 1. Target OAuth Application
- **Issuer URL**: ${issuer}
- **Application**: ${opts.appName}
- **Client ID**: ${opts.clientId}
- **Update Theme API**: \`PUT ${issuer}/api/applications/${opts.clientId}/theme\`
- **Public Read API**: \`GET ${issuer}/api/public/theme?client_id=${opts.clientId}\`
- **MCP Server Endpoint (JSON-RPC 2.0)**: \`POST ${issuer}/api/mcp\` (exposes \`list_applications\`, \`get_login_theme\`, \`update_login_theme\`, etc.)
- **Auth Header**: \`Authorization: Bearer $WIMOTEK_ADMIN_TOKEN\` (mint a \`wmk_pat_...\` token in Console -> Security Policy -> Admin API Tokens or via "Generate / Manage Token" here)

### 2. Theme JSON Schema
\`\`\`json
{
  "layout": "centered | split_left | split_right | minimal",
  "surfaceMode": "auto | light | dark",
  "brandTitle": "Your Brand Name",
  "brandSubtitle": "Optional custom sign-in subtitle",
  "heroTitle": "Split-layout brand headline",
  "heroSubtitle": "Split-layout supporting copy",
  "logoUrl": "https://your-site.com/logo.svg",
  "primaryColor": "#4F46E5",
  "backgroundColor": "#F8FAFC",
  "cardColor": "#FFFFFF",
  "textColor": "#0F172A",
  "borderRadius": "sharp | rounded | pill",
  "fontFamily": "sans | serif | mono",
  "socialLayout": "stack | grid",
  "footerText": "Your Brand",
  "customCss": "[data-wimotek-login-card] { box-shadow: 0 20px 50px rgba(0,0,0,0.08); }"
}
\`\`\`

### 3. Tasks
1. Inspect this repository's CSS/Tailwind tokens, typography, and brand logo.
2. Produce a matching JSON theme payload (optional fine-grained CSS scoped to \`[data-wimotek-login-root]\` or \`[data-wimotek-login-card]\`).
3. Generate a ready-to-run \`curl -X PUT\` command (or \`scripts/sync-oauth-theme.sh\`) targeting \`${issuer}/api/applications/${opts.clientId}/theme\`.`;
}

export function buildAiIntegrationPrompt(opts: {
  issuerUrl: string;
  clientId: string;
  appName: string;
  redirectUri: string;
  locale: Locale;
  loginEntryMode?: AiLoginEntryMode;
}): string {
  const issuer = resolveEffectiveIssuerUrl(opts.issuerUrl);
  const isZh = opts.locale === 'zh-CN' || opts.locale === 'zh-TW';
  const entryMode: AiLoginEntryMode = opts.loginEntryMode || 'direct_redirect';

  if (isZh) {
    const entryRequirement =
      entryMode === 'direct_redirect'
        ? `**【当前指定：方式 A —— 未登录直接自动跳转至登录页（默认）】**
1. **禁止额外生成一个只有单个「点击登录」按钮的中间引导页！**
2. 当未登录用户访问首页（\`/\`）或任意受保护页面时，必须通过服务端认证中间件 / 路由守卫（HTTP \`302\` 重定向或前端 \`window.location.replace('/login')\`）直接发起 OIDC 授权并跳转到 \`${issuer}/oauth/authorize?client_id=${opts.clientId}&...\` 托管登录页。
3. 自动跳转前将用户原本访问的站内相对路径保存到 \`returnTo\`（严格校验以 \`/\` 开头且非 \`//\`，防止开放重定向），\`/callback\` 换票成功后自动跳回原页面。
4. **防止重定向死循环**：用户主动点击退出登录后跳转到静态 \`/logged-out\` 页面（或在 \`/callback\` 校验失败时停留在错误提示页），此时不触发自动跳转，仅展示简洁的「重新登录」链接。`
        : `**【当前指定：方式 B —— 页面按钮触发登录（保留公开访客页）】**
1. 保持站点公开页面（如官网首页、公开文档、商品浏览页）可被未登录访客直接访问，不要在首页强制重定向。
2. 在页面导航栏或登录入口处提供清晰的「登录」按钮，用户点击后跳转至 \`/login\` → \`${issuer}/oauth/authorize?client_id=${opts.clientId}&...\` 完成统一认证。
3. 当未登录用户访问需要权限的私有页面或受保护操作时，再跳转 \`/login\` 并携带站内相对路径 \`returnTo\`，登录成功后自动返回。`;

    return `请为我当前项目集成 **wimotek/Oauth**（标准 OIDC 1.0 + OAuth 2.0 PKCE S256 统一登录认证中心）。

### 1. 认证中心参数（已自动代入）
- **OIDC Issuer**: \`${issuer}\`
- **OIDC Auto-Discovery**: \`${issuer}/.well-known/openid-configuration\`
- **JWKS 公钥地址 (RS256)**: \`${issuer}/.well-known/jwks.json\`
- **授权端点**: \`${issuer}/oauth/authorize\`
- **换票端点**: \`${issuer}/oauth/token\`
- **用户信息端点**: \`${issuer}/oauth/userinfo\`
- **退出端点**: \`${issuer}/oauth/logout\`
- **Client ID**: \`${opts.clientId}\`
- **Client Secret**: 从环境变量 \`OAUTH_SECRET\` 读取（严禁硬编码到代码仓库）
- **Redirect URI**: \`${opts.redirectUri}\`

### 2. 登录入口交互方式（必须严格按当前指定方式实现）
${entryRequirement}

> **两种登录入口方式区别说明（可按业务场景自由选择）**：
> - **方式 A · 直接跳转登录页（默认）**：未登录打开站点即自动 302 / 守卫直达 wimotek/Oauth 托管登录页，无需多点一次按钮；适合后台管理系统、企业内部工具、私有应用与纯 SaaS 工作台。
> - **方式 B · 页面按钮触发登录**：未登录时先展示业务站首页或公开内容，用户点击「登录」按钮后再跳往托管登录页；适合官网、博客、文档站、社区或电商等含公开访客内容的网站。

### 3. 安全与架构要求
1. 必须使用 **Authorization Code + PKCE (\`S256\`)** 流程，并校验随机 \`state\` 防 CSRF。
2. 将 \`state\` 与 \`code_verifier\` 存入 \`HttpOnly\` Cookie 或服务端 Session（5 分钟 TTL），回调换票成功后立即销毁。
3. 跳转到 \`${issuer}/oauth/authorize?client_id=${opts.clientId}&...\` 时，wimotek/Oauth 会根据 \`client_id\` 自动加载我们在后台为 **${opts.appName}** 定制的专属登录页主题与排版。
4. 登录后使用返回的 \`sub\`（用户唯一稳定 ID）与 \`email\`（当 \`email_verified=true\` 时）平滑绑定或自动创建本地用户账号。
5. （可选）如果项目需要即时封禁踢人，新增 \`POST /webhooks/oauth-events\` 接口，用 \`X-Wimotek-Signature-256\`（HMAC-SHA256）验签并在收到 \`user.banned\` 时清除该用户本地会话。

### 4. 交付要求
- 先识别我当前项目使用的语言和框架（Next.js / React / Vue / Go / Python / Java / PHP 等），使用最轻量、零冗余依赖的方式实现 \`/login\`、\`/callback\`、\`/logout\`、认证守卫/入口逻辑与当前用户信息读取。
- 在 \`.env.example\` 中补充 \`OAUTH_ISSUER\`、\`OAUTH_CLIENT_ID\`、\`OAUTH_SECRET\`、\`OAUTH_REDIRECT_URI\`。`;
  }

  const entryRequirementEn =
    entryMode === 'direct_redirect'
      ? `**[Selected Mode A — Direct Auto-Redirect to Login Page (Default)]**
1. **Do NOT build an unnecessary intermediate splash page containing only a single "Sign in" button.**
2. When an unauthenticated visitor hits \`/\` or any protected route, immediately redirect via server middleware / route guard (HTTP \`302\` or \`window.location.replace('/login')\`) directly to \`/login\` -> \`${issuer}/oauth/authorize?client_id=${opts.clientId}&...\`.
3. Preserve the original relative \`returnTo\` path (strictly validated to start with \`/\` and not \`//\` to prevent open redirects) and restore it after \`/callback\` succeeds.
4. **Prevent redirect loops**: after explicit \`/logout\` or on callback error, render a static \`/logged-out\` or error view with a "Sign in again" link instead of auto-redirecting.`
      : `**[Selected Mode B — Button-Triggered Login Entry (Public Guest Pages)]**
1. Keep public pages (landing page, docs, catalog) accessible to unauthenticated guests without forcing an immediate redirect.
2. Place a clear "Sign in" button in the navbar or entry view that navigates to \`/login\` -> \`${issuer}/oauth/authorize?client_id=${opts.clientId}&...\`.
3. Only redirect unauthenticated users when they access protected routes/actions, preserving a safe relative \`returnTo\` path.`;

  return `Integrate **wimotek/Oauth** (standard OIDC 1.0 + OAuth 2.0 with PKCE S256) authentication into my current project.

### 1. OIDC Provider Parameters
- **Issuer**: \`${issuer}\`
- **Discovery**: \`${issuer}/.well-known/openid-configuration\`
- **JWKS (RS256)**: \`${issuer}/.well-known/jwks.json\`
- **Authorize**: \`${issuer}/oauth/authorize\`
- **Token**: \`${issuer}/oauth/token\`
- **UserInfo**: \`${issuer}/oauth/userinfo\`
- **Logout**: \`${issuer}/oauth/logout\`
- **Client ID**: \`${opts.clientId}\`
- **Client Secret**: Read from \`OAUTH_SECRET\` environment variable (never hardcode)
- **Redirect URI**: \`${opts.redirectUri}\`

### 2. Login Entry Flow (Follow Selected Mode Strictly)
${entryRequirementEn}

> **Comparison of the Two Login Entry Modes**:
> - **Mode A · Direct Auto-Redirect (Default)**: Unauthenticated visitors are sent straight to the wimotek/Oauth hosted login page with zero extra click; ideal for admin panels, internal tools, private apps, and login-gated SaaS workspaces.
> - **Mode B · Button-Triggered Entry**: Guests can browse public pages first and click a "Sign in" button when ready; ideal for marketing sites, docs, blogs, communities, and storefronts.

### 3. Security & Delivery Requirements
1. Use **Authorization Code + PKCE (S256)** with random CSRF \`state\` stored in an \`HttpOnly\` cookie/session.
2. Redirecting with \`client_id=${opts.clientId}\` automatically renders the custom hosted login theme configured for **${opts.appName}**.
3. Map authenticated users via \`sub\` (and link legacy accounts via \`email\` when \`email_verified === true\`).
4. Implement \`/login\`, \`/callback\`, \`/logout\`, the auth guard/entry flow above, and update \`.env.example\`.`;
}

const KNOWN_THEME_KEYS: ReadonlyArray<keyof LoginThemeConfig> = [
  'layout',
  'surfaceMode',
  'brandTitle',
  'brandSubtitle',
  'heroTitle',
  'heroSubtitle',
  'logoUrl',
  'primaryColor',
  'backgroundColor',
  'cardColor',
  'textColor',
  'borderRadius',
  'fontFamily',
  'socialLayout',
  'footerText',
  'customCss',
];

export type ThemeJsonImportResult =
  | { ok: true; theme: LoginThemeConfig; matchedKeys: string[] }
  | { ok: false; error: string };

/**
 * Parses a login theme JSON pasted from AI output, a saved `.json` file,
 * a Markdown ```json``` block, an API response (`{ theme: {...} }`),
 * or a `curl -d '{...}'` snippet, and normalizes/sanitizes all fields.
 */
export function parseImportedLoginThemeJson(raw: string, baseTheme?: LoginThemeConfig): ThemeJsonImportResult {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Please paste a theme JSON object or upload a .json file.' };
  }

  const candidates: string[] = [trimmed];

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    candidates.unshift(fenceMatch[1].trim());
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  let parsed: unknown = null;
  let parseSucceeded = false;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      parseSucceeded = true;
      break;
    } catch {
      // try next extraction candidate
    }
  }

  if (!parseSucceeded || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Invalid JSON format. Expected a JSON object containing theme properties.' };
  }

  let obj = parsed as Record<string, unknown>;
  if (obj.theme && typeof obj.theme === 'object' && !Array.isArray(obj.theme)) {
    obj = obj.theme as Record<string, unknown>;
  } else if (obj.loginTheme && typeof obj.loginTheme === 'object' && !Array.isArray(obj.loginTheme)) {
    obj = obj.loginTheme as Record<string, unknown>;
  }

  const matchedKeys = KNOWN_THEME_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(obj, k));
  if (matchedKeys.length === 0) {
    return {
      ok: false,
      error: 'No recognized LoginThemeConfig fields found (e.g. layout, primaryColor, backgroundColor, brandTitle).',
    };
  }

  const merged: Partial<LoginThemeConfig> = { ...(baseTheme || DEFAULT_LOGIN_THEME) };
  for (const key of matchedKeys) {
    const val = obj[key];
    if (typeof val === 'string') {
      (merged as Record<string, unknown>)[key] = val;
    }
  }

  return {
    ok: true,
    theme: normalizeLoginTheme(merged),
    matchedKeys,
  };
}

