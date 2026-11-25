import React, { useState } from 'react';
import {
  Copy,
  Check,
  Code2,
  BookOpen,
  ShieldCheck,
  Webhook,
  Server,
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  FileCode2,
} from 'lucide-react';
import type { Locale, OAuthApplication } from '../types';
import { TRANSLATIONS } from '../lib/i18n';
import { EMBEDDED_SDKS, SDK_ORDER, type SdkLang } from '../lib/sdkSources';

type DocsSection = 'idp_guide' | 'sdks' | 'webhooks_jit' | 'deployment';

function buildQuickStart(lang: SdkLang, issuer: string, clientId: string, redirectUri: string): string {
  switch (lang) {
    case 'python':
      return `import os
from wimotek_oauth import WimotekOAuthClient  # Save wimotek_oauth.py below into your project

auth = WimotekOAuthClient(
    issuer="${issuer}",
    client_id="${clientId}",
    client_secret=os.environ["OAUTH_SECRET"],
    redirect_uri="${redirectUri}",
)

# 1. Redirect user to login_url & store state + verifier in session
login_url, state, verifier = auth.build_login_url()

# 2. In your /callback route, verify PKCE & fetch user claims
result = auth.handle_callback(code, recv_state, state, verifier)
print(result["user"]["email"])`;
    case 'nodejs':
      return `// Save wimotek-oauth.ts below into your project
import { WimotekOAuthClient } from './wimotek-oauth';

const oauth = new WimotekOAuthClient({
  issuer: '${issuer}',
  clientId: '${clientId}',
  clientSecret: process.env.OAUTH_SECRET!,
  redirectUri: '${redirectUri}',
});

// 1. Redirect user to url & persist state + verifier in HttpOnly session
const { url, state, verifier } = oauth.createAuthSession();

// 2. Inside /callback, exchange authorization code with PKCE verifier
const { user, tokens } = await oauth.handleCallback({
  code,
  state: recvState,
  expectedState: state,
  verifier,
});`;
    case 'go':
      return `package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	// 方式 A：通过 go get 自动下载（推荐）
	wimotekoauth "github.com/wimotek/oauth/sdk/go"
	// 方式 B：离线单文件拷贝到 pkg/wimotekoauth/client.go 时改用下面这行：
	// wimotekoauth "my-go-app/pkg/wimotekoauth"
)

var oauthClient = &wimotekoauth.Client{
	Issuer:       "${issuer}",
	ClientID:     "${clientId}",
	ClientSecret: os.Getenv("OAUTH_SECRET"),
	RedirectURI:  "${redirectUri}",
}

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, \`<h1>My Go App</h1><a href="/login">Sign in with wimotek/Oauth</a>\`)
	})

	// 1. 生成 PKCE (S256) 登录地址，将 state & verifier 存入 HttpOnly Cookie 后跳转
	http.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		loginURL, state, verifier := oauthClient.BuildLoginURL()
		http.SetCookie(w, &http.Cookie{Name: "oauth_state", Value: state, Path: "/", HttpOnly: true, MaxAge: 300})
		http.SetCookie(w, &http.Cookie{Name: "oauth_verifier", Value: verifier, Path: "/", HttpOnly: true, MaxAge: 300})
		http.Redirect(w, r, loginURL, http.StatusFound)
	})

	// 2. 回调校验 CSRF state + PKCE 并换取用户信息
	http.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		stateCookie, err1 := r.Cookie("oauth_state")
		verifierCookie, err2 := r.Cookie("oauth_verifier")
		if err1 != nil || err2 != nil {
			http.Error(w, "Missing session cookies, please visit /login again", http.StatusBadRequest)
			return
		}
		res, err := oauthClient.HandleCallback(
			r.Context(),
			r.URL.Query().Get("code"),
			r.URL.Query().Get("state"),
			stateCookie.Value,
			verifierCookie.Value,
		)
		if err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "oauth_state", Value: "", Path: "/", MaxAge: -1})
		http.SetCookie(w, &http.Cookie{Name: "oauth_verifier", Value: "", Path: "/", MaxAge: -1})
		fmt.Fprintf(w, "Signed in as %v (%v)\\n", res.User["name"], res.User["email"])
	})

	log.Println("Listening on http://localhost:4000")
	log.Fatal(http.ListenAndServe(":4000", nil))
}`;
    case 'java':
      return `// Place WimotekOAuthClient.java below under com/wimotek/oauth/
import com.wimotek.oauth.WimotekOAuthClient;

var oauth = new WimotekOAuthClient(
    "${issuer}",
    "${clientId}",
    System.getenv("OAUTH_SECRET"),
    "${redirectUri}"
);

// 1. Redirect browser to session.authUrl() & store state/codeVerifier in HttpSession
var session = oauth.createAuthSession();

// 2. In /callback controller, exchange code + PKCE verifier for userinfo JSON
String userJson = oauth.exchangeCodeForUserInfo(code, recvState, session.state(), session.codeVerifier());`;
    case 'php':
      return `<?php
// Save WimotekOAuthClient.php below into your project
require_once __DIR__ . '/WimotekOAuthClient.php';

$oauth = new WimotekOAuthClient(
    '${issuer}',
    '${clientId}',
    getenv('OAUTH_SECRET'),
    '${redirectUri}'
);

// 1. Redirect user to $session['url'] & persist state/verifier in $_SESSION
$session = $oauth->createAuthSession();

// 2. In /callback, exchange authorization code with PKCE verifier
$result = $oauth->handleCallback($_GET['code'], $_GET['state'], $_SESSION['state'], $_SESSION['verifier']);`;
  }
}

interface SdkDocsViewProps {
  locale: Locale;
  issuerUrl: string;
  applications: OAuthApplication[];
}

export function SdkDocsView({ locale, issuerUrl, applications }: SdkDocsViewProps) {
  const t = TRANSLATIONS[locale];
  const isZh = locale === 'zh-CN' || locale === 'zh-TW';
  const [section, setSection] = useState<DocsSection>('idp_guide');
  const [lang, setLang] = useState<SdkLang>('python');
  const [selectedAppId, setSelectedAppId] = useState(applications[0]?.id || '');
  const [sdkSourceExpanded, setSdkSourceExpanded] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const selectedApp = applications.find((a) => a.id === selectedAppId) || applications[0];
  const currentSdk = EMBEDDED_SDKS[lang];
  const cleanIssuer = issuerUrl.replace(/\/$/, '');
  const activeClientId = selectedApp?.clientId || 'wimotek_erp_portal';
  const activeRedirectUri = selectedApp?.redirectUris[0] || 'http://localhost:4000/callback';

  const quickSnippet = buildQuickStart(lang, cleanIssuer, activeClientId, activeRedirectUri);

  const tokenExchangeCurl = `# 1. Fetch OIDC Discovery & JWKS public keys
curl -s ${cleanIssuer}/.well-known/openid-configuration | jq .

# 2. Exchange Authorization Code + PKCE verifier for RS256 id_token & access_token
curl -X POST ${cleanIssuer}/oauth/token \\
  -H "Content-Type: application/json" \\
  -d '{
    "grant_type": "authorization_code",
    "code": "<AUTHORIZATION_CODE>",
    "redirect_uri": "${activeRedirectUri}",
    "client_id": "${activeClientId}",
    "client_secret": "<CLIENT_SECRET>",
    "code_verifier": "<PKCE_VERIFIER>"
  }'

# 3. Query authenticated profile claims
curl -H "Authorization: Bearer <ACCESS_TOKEN>" ${cleanIssuer}/oauth/userinfo`;

  const deviceFlowCurl = `# RFC 8628 Device Authorization Grant (CLI / TV / Desktop QR Login)
curl -X POST ${cleanIssuer}/oauth/device_authorization \\
  -H "Content-Type: application/json" \\
  -d '{"client_id":"${activeClientId}","scope":"openid profile email"}'`;

  const webhookVerifyNode = `import crypto from 'node:crypto';

export function verifyWimotekWebhook(rawBody: string, headerSig: string, secret: string): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (headerSig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(headerSig), Buffer.from(expected));
}

// Express handler: revoke local session immediately when receiving user.banned
app.post('/webhooks/oauth-events', express.text({ type: 'application/json' }), (req, res) => {
  const sig = req.header('X-Wimotek-Signature-256') || '';
  if (!verifyWimotekWebhook(req.body, sig, process.env.WIMOTEK_WEBHOOK_SECRET!)) {
    return res.status(401).send('Invalid signature');
  }
  const event = JSON.parse(req.body);
  if (event.event === 'user.banned') {
    revokeUserSessionsByEmail(event.data.email);
  }
  res.json({ ok: true });
});`;

  const dockerComposeSnippet = `services:
  wimotek-oauth:
    image: wimotek/oauth:latest
    # image: ghcr.io/wimotek/oauth:latest  # 可选：改用 GHCR 镜像源
    container_name: wimotek-Oauth
    restart: unless-stopped
    ports:
      - "8080:8080"   # HTTP
      - "8443:8443"   # HTTPS（挂载 /certs 时使用自定义证书，否则自动生成于 /data/certs）
    volumes:
      - ./data:/data          # 读写卷：SQLite3 WAL、config.json、RS256 密钥及自动生成的 master.key
      # - ./certs:/certs:ro   # [可选] 只读挂载自定义 TLS 证书（tls.crt/tls.key）
    environment:
      - TZ=Asia/Shanghai
      # [可选] AES-256-GCM 静态加密主密钥（加密第三方 OAuth Secret、Apple .p8、TOTP、Webhook 密钥）
      # 不填则首次启动自动生成 32 字节随机密钥并持久化到 /data/keys/master.key（权限 0600）
      # 仅多节点集群共享外部 MySQL 时建议显式统一配置
      # - WIMOTEK_MASTER_KEY=replace-with-strong-32-byte-secret
      #
      # [可选] 容器内监听端口与目录覆盖（默认值 :8080 / :8443 / /data / /certs）
      # - WIMOTEK_HTTP_ADDR=:8080
      # - WIMOTEK_HTTPS_ADDR=:8443
      # - WIMOTEK_DATA_DIR=/data
      # - WIMOTEK_CERTS_DIR=/certs`;

  const sampleIdTokenClaims = `{
  "iss": "${cleanIssuer}",
  "sub": "usr_alice_ops",
  "aud": "${activeClientId}",
  "email": "alice.chen@acme-corp.com",
  "email_verified": true,
  "name": "Alice Chen",
  "provider": "Microsoft (Entra ID)",
  "amr": ["social_microsoft"],
  "iat": 1795569436,
  "exp": 1795573036
}`;

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // ignore clipboard errors
    }
  }

  const sectionTabs: { id: DocsSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'idp_guide', label: isZh ? 'OIDC IdP 接入指南' : 'OIDC IdP Guide', icon: BookOpen },
    { id: 'sdks', label: isZh ? '五语言极简 SDK' : '5-Language SDKs', icon: Code2 },
    { id: 'webhooks_jit', label: isZh ? 'JIT 合并与封禁 Webhook' : 'JIT & Ban Webhooks', icon: Webhook },
    { id: 'deployment', label: isZh ? '生产部署与安全' : 'Deployment & Security', icon: Server },
  ];

  const oidcEndpoints = [
    { method: 'GET', path: '/.well-known/openid-configuration', desc: isZh ? 'OIDC 自动发现文档（绝大多数系统只需填此地址）' : 'OIDC Discovery metadata (auto-configures GitLab, Grafana, NextAuth, etc.)' },
    { method: 'GET', path: '/.well-known/jwks.json', desc: isZh ? 'RS256 公钥集（用于离线校验 id_token / access_token 签名）' : 'Public RS256 JSON Web Key Set for offline JWT verification' },
    { method: 'GET', path: '/oauth/authorize', desc: isZh ? '授权码端点（强制 PKCE S256）' : 'Authorization Code endpoint (enforces PKCE S256)' },
    { method: 'POST', path: '/oauth/token', desc: isZh ? '签发 id_token / access_token / refresh_token' : 'Token exchange, Refresh Token & RFC 8628 Device Code exchange' },
    { method: 'POST', path: '/oauth/device_authorization', desc: isZh ? 'RFC 8628 跨端设备码签发（CLI / TV / 扫码确认）' : 'RFC 8628 Device Authorization Grant for CLI / TV / cross-device QR' },
    { method: 'GET', path: '/oauth/userinfo', desc: isZh ? '凭 Bearer Access Token 获取标准用户声明' : 'Returns verified user claims via Bearer access token' },
    { method: 'GET', path: '/oauth/logout', desc: isZh ? '统一退出并跳转回业务站' : 'End session and redirect to post_logout_redirect_uri' },
  ];

  return (
    <div className="space-y-6">
      {/* Header + Target App Selector */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t.sdksTitle}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 i18n-safe">
            {t.sdksSubtitle}
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap w-full lg:w-auto min-w-0">
          <label className="sr-only" htmlFor="sdk-app-select">Inject Application Credentials</label>
          <select
            id="sdk-app-select"
            value={selectedApp?.id || ''}
            onChange={(e) => setSelectedAppId(e.target.value)}
            className="w-full sm:w-auto max-w-full min-w-0 min-h-[38px] px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] text-slate-800 dark:text-slate-200"
          >
            {applications.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.clientId})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Docs Center Section Tabs */}
      <div
        role="tablist"
        aria-label="Documentation sections"
        className="inline-flex items-center p-1 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 flex-wrap gap-1"
      >
        {sectionTabs.map((tab) => {
          const Icon = tab.icon;
          const active = section === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => setSection(tab.id)}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                active
                  ? 'bg-white dark:bg-[#111827] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* SECTION 1: IdP Protocol & Token Issuance Guide */}
      {section === 'idp_guide' && (
        <div className="space-y-6">
          {/* OIDC IdP Overview Strip */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-[#111827] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  OpenID Connect 1.0 / OAuth 2.0 Identity Provider
                </h2>
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {isZh ? 'RS256 令牌签发已就绪' : 'RS256 Token Issuance Ready'}
                </span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                {isZh
                  ? '对外作为标准 IdP 签发 RS256 非对称签名 JWT（id_token / access_token），原生兼容 GitLab、Grafana、Harbor、Nextcloud、ArgoCD、Spring Security、NextAuth 及所有标准 OIDC 客户端。'
                  : 'Issues RS256-signed id_token and access_token JWTs with Auto-Discovery, JWKS, PKCE S256, Refresh Tokens, and RFC 8628 Device Flow for web, mobile, SaaS, and CLI clients.'}
              </p>
            </div>
          </div>

          {/* Live OIDC Endpoint Reference Table */}
          <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  {isZh ? '标准 IdP 端点清单（已代入当前 Issuer）' : 'Live IdP Endpoint Reference'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => copy('discovery_url', `${cleanIssuer}/.well-known/openid-configuration`)}
                className="px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap"
              >
                {copiedId === 'discovery_url' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedId === 'discovery_url' ? t.copied : isZh ? '复制 Discovery 地址' : 'Copy Discovery URL'}</span>
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 text-slate-500 dark:text-slate-400">
                    <th className="py-2.5 px-5 font-medium">Method</th>
                    <th className="py-2.5 px-5 font-medium">Endpoint URL</th>
                    <th className="py-2.5 px-5 font-medium">{isZh ? '说明' : 'Purpose'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {oidcEndpoints.map((ep) => (
                    <tr key={ep.path} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                      <td className="py-2.5 px-5 font-mono font-semibold text-indigo-600 dark:text-indigo-400">{ep.method}</td>
                      <td className="py-2.5 px-5 font-mono text-slate-800 dark:text-slate-200 whitespace-nowrap">
                        {cleanIssuer}{ep.path}
                      </td>
                      <td className="py-2.5 px-5 text-slate-600 dark:text-slate-400">{ep.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Curl + Decoded ID Token Claims Split */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <section className="lg:col-span-7 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  {isZh ? '标准 OIDC 授权码 + PKCE 换票示例' : 'OIDC Authorization Code + PKCE Flow (cURL)'}
                </h2>
                <button
                  type="button"
                  onClick={() => copy('curl_oidc', tokenExchangeCurl)}
                  className="px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5"
                >
                  {copiedId === 'curl_oidc' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedId === 'curl_oidc' ? t.copied : t.copyCode}</span>
                </button>
              </div>
              <pre className="p-5 text-xs font-mono text-slate-800 dark:text-slate-200 bg-slate-50/70 dark:bg-[#0B0F19] overflow-x-auto leading-relaxed">
                {tokenExchangeCurl}
              </pre>
            </section>

            <section className="lg:col-span-5 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  {isZh ? '签发的 RS256 id_token 声明示例' : 'Issued RS256 id_token Claims'}
                </h2>
              </div>
              <pre className="p-5 text-xs font-mono text-slate-800 dark:text-slate-200 bg-slate-50/70 dark:bg-[#0B0F19] overflow-x-auto leading-relaxed">
                {sampleIdTokenClaims}
              </pre>
              <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] text-xs text-slate-500 dark:text-slate-400">
                <div className="font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {isZh ? 'RFC 8628 设备码请求（CLI / 跨端扫码）' : 'RFC 8628 Device Authorization Grant'}
                </div>
                <pre className="p-2.5 rounded bg-slate-50 dark:bg-[#0B0F19] font-mono text-[11px] overflow-x-auto">
                  {deviceFlowCurl}
                </pre>
              </div>
            </section>
          </div>
        </div>
      )}

      {/* SECTION 2: 5-Language Minimal SDKs */}
      {section === 'sdks' && (
        <div className="space-y-6">
          <div role="tablist" aria-label="SDK Languages" className="inline-flex items-center p-1 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 flex-wrap gap-1">
            {SDK_ORDER.map((id) => {
              const item = EMBEDDED_SDKS[id];
              return (
                <button
                  key={item.id}
                  role="tab"
                  type="button"
                  aria-selected={lang === item.id}
                  onClick={() => {
                    setLang(item.id);
                    setSdkSourceExpanded(false);
                  }}
                  className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    lang === item.id
                      ? 'bg-white dark:bg-[#111827] text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          {lang === 'go' && (
            <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                    {isZh ? 'Go 新手快速上手：用 Go Module 自动下载（3 步跑通）' : 'Go Beginner Quickstart: Auto-Download via Go Modules (3 Steps)'}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    {isZh
                      ? '完整图文排查指南见仓库 Oauth/docs/GO_SDK_GUIDE.md · 无需引入任何第三方 Web 框架'
                      : 'Full beginner guide & troubleshooting in Oauth/docs/GO_SDK_GUIDE.md · Standard library only'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    copy(
                      'go_mod_cmds',
                      `mkdir my-go-app && cd my-go-app\ngo mod init my-go-app\n# 国内网络建议先配置一次 Go 模块代理加速：\ngo env -w GOPROXY=https://goproxy.cn,direct\n# 自动下载零依赖 Go SDK 模块：\ngo get github.com/wimotek/oauth/sdk/go@latest\n# 设置 Client Secret 并运行下方的 main.go：\nexport OAUTH_SECRET="your_client_secret"\ngo run main.go`
                    )
                  }
                  className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  {copiedId === 'go_mod_cmds' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedId === 'go_mod_cmds' ? t.copied : isZh ? '复制命令' : 'Copy Commands'}</span>
                </button>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-slate-800 text-xs">
                <div className="p-5 space-y-2.5">
                  <div className="font-semibold text-slate-900 dark:text-white">
                    {isZh ? '方式 A：go get 自动下载（推荐）' : 'Method A: Auto-Download with go get (Recommended)'}
                  </div>
                  <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                    {isZh
                      ? 'Go 就像前端的 npm：先执行 go mod init 初始化项目，再用 go get 拉取独立零依赖子模块 github.com/wimotek/oauth/sdk/go，接着把下方 main.go 复制运行即可。'
                      : 'Initialize go.mod, run go get to pull the standalone zero-dependency SDK submodule, then save and run the complete main.go below.'}
                  </p>
                  <pre className="p-3.5 rounded-lg bg-slate-50 dark:bg-[#0B0F19] border border-slate-200 dark:border-slate-800 font-mono text-[11px] text-slate-800 dark:text-slate-200 overflow-x-auto leading-relaxed">{`mkdir my-go-app && cd my-go-app
go mod init my-go-app
# 国内网络可选加速代理：
go env -w GOPROXY=https://goproxy.cn,direct
# 自动下载独立 SDK 模块（零第三方依赖）：
go get github.com/wimotek/oauth/sdk/go@latest
# 运行下方完整 main.go：
export OAUTH_SECRET="<CLIENT_SECRET>"
go run main.go`}</pre>
                </div>

                <div className="p-5 space-y-2.5">
                  <div className="font-semibold text-slate-900 dark:text-white">
                    {isZh ? '方式 B：内网 / 离线零依赖单文件拷贝' : 'Method B: Offline / Air-Gapped Single-File Copy'}
                  </div>
                  <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                    {isZh
                      ? '如果尚未推送 Git 仓库或处于内网隔离环境，展开最下方 93 行 client.go 源码，直接保存为项目里的 pkg/wimotekoauth/client.go，把 import 路径改为 "my-go-app/pkg/wimotekoauth" 即可离线运行。'
                      : 'For private/offline environments or before publishing to Git, expand the 93-line client.go below, save it as pkg/wimotekoauth/client.go, and import "my-go-app/pkg/wimotekoauth".'}
                  </p>
                  <pre className="p-3.5 rounded-lg bg-slate-50 dark:bg-[#0B0F19] border border-slate-200 dark:border-slate-800 font-mono text-[11px] text-slate-800 dark:text-slate-200 overflow-x-auto leading-relaxed">{`my-go-app/
├── go.mod                      # module my-go-app
├── main.go                     # 下方可直接运行的完整示例
└── pkg/
    └── wimotekoauth/
        └── client.go           # 展开下方 SDK 源码复制至此`}</pre>
                </div>
              </div>
            </section>
          )}

          <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Code2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  {lang === 'go'
                    ? isZh
                      ? '完整可直接运行的 main.go 示例（含标准库 Cookie 会话）'
                      : 'Complete Runnable main.go Example (Stdlib Cookie Session)'
                    : `${t.quickStartLines} (${currentSdk.label})`}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => copy('quick', quickSnippet)}
                className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap"
              >
                {copiedId === 'quick' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedId === 'quick' ? t.copied : t.copyCode}</span>
              </button>
            </div>
            <div className="px-5 py-2.5 border-b border-slate-100 dark:border-slate-800/80 bg-indigo-50/40 dark:bg-indigo-950/20 text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
              {isZh ? currentSdk.packageHintZh : currentSdk.packageHintEn}
            </div>
            <pre className="p-5 text-xs font-mono text-slate-800 dark:text-slate-200 bg-slate-50/70 dark:bg-[#0B0F19] overflow-x-auto leading-relaxed">
              {quickSnippet}
            </pre>
          </section>

          {/* Collapsible Minimalist SDK Source (Markdown-style disclosure, collapsed by default) */}
          <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between gap-3 pr-5 hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors">
              <button
                type="button"
                aria-expanded={sdkSourceExpanded}
                onClick={() => setSdkSourceExpanded((v) => !v)}
                className="flex-1 px-5 py-3.5 text-left flex items-center gap-3 min-w-0"
              >
                {sdkSourceExpanded ? (
                  <ChevronDown className="w-4 h-4 shrink-0 text-indigo-600 dark:text-indigo-400" />
                ) : (
                  <ChevronRight className="w-4 h-4 shrink-0 text-slate-500 dark:text-slate-400" />
                )}
                <FileCode2 className="w-4 h-4 shrink-0 text-slate-500 dark:text-slate-400" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                      {t.fullMinimalSdk}
                    </h2>
                    <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                      ({currentSdk.lineCount} {isZh ? '行 · 零第三方依赖' : 'lines · zero deps'})
                    </span>
                  </div>
                  <p className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate mt-0.5">
                    {currentSdk.path} ·{' '}
                    <span className="font-sans text-indigo-600 dark:text-indigo-400">
                      {sdkSourceExpanded
                        ? isZh
                          ? '点击收起源码'
                          : 'Click to collapse source'
                        : isZh
                          ? '点击展开完整源码'
                          : 'Click to expand full source'}
                    </span>
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => copy('sdk', currentSdk.source)}
                className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                {copiedId === 'sdk' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedId === 'sdk' ? t.copied : t.copyCode}</span>
              </button>
            </div>

            {sdkSourceExpanded && (
              <pre className="p-5 border-t border-slate-200 dark:border-slate-800 text-xs font-mono text-slate-800 dark:text-slate-200 bg-slate-50/70 dark:bg-[#0B0F19] overflow-x-auto max-h-[520px] leading-relaxed">
                {currentSdk.source}
              </pre>
            )}
          </section>
        </div>
      )}

      {/* SECTION 3: Webhooks & JIT Linking */}
      {section === 'webhooks_jit' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-[#111827] divide-y md:divide-y-0 md:divide-x divide-slate-200 dark:divide-slate-800 text-xs">
            <div className="p-5 space-y-1.5">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                {isZh ? 'JIT 即时同步 + 已验证邮箱平滑绑定' : 'JIT Provisioning & Verified-Email Linking'}
              </h2>
              <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                {isZh
                  ? '业务系统无需推翻原有用户表。用户首次通过 wimotek/Oauth 登录时，若 OIDC id_token 返回 email_verified=true，业务站按邮箱匹配本地老账号并写入 sub 绑定；无匹配则即时建档。'
                  : 'Legacy business databases do not need a rewrite. When an OIDC id_token arrives with email_verified=true, match by email to bind onto the legacy user record, or create the user just-in-time.'}
              </p>
            </div>
            <div className="p-5 space-y-1.5">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                {isZh ? '账号封禁 Webhook（即时踢人）' : 'Account Ban Webhook (Downstream Kick)'}
              </h2>
              <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                {isZh
                  ? '在“身份与用户库”封禁员工账号时，网关会向所有已登记的业务站 Webhook 推送 user.banned 事件，并附带 X-Wimotek-Signature-256（HMAC-SHA256）请求头防伪造。'
                  : 'Banning a user immediately pushes a signed user.banned event to registered business webhooks with X-Wimotek-Signature-256 (HMAC-SHA256) so downstream apps revoke active sessions.'}
              </p>
            </div>
          </div>

          <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                {isZh ? '下游业务站验签与踢人示例（Node.js / Express）' : 'Downstream Webhook Verification (Node.js / Express)'}
              </h2>
              <button
                type="button"
                onClick={() => copy('wh_code', webhookVerifyNode)}
                className="px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5"
              >
                {copiedId === 'wh_code' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedId === 'wh_code' ? t.copied : t.copyCode}</span>
              </button>
            </div>
            <pre className="p-5 text-xs font-mono text-slate-800 dark:text-slate-200 bg-slate-50/70 dark:bg-[#0B0F19] overflow-x-auto leading-relaxed">
              {webhookVerifyNode}
            </pre>
          </section>
        </div>
      )}

      {/* SECTION 4: Deployment & Security */}
      {section === 'deployment' && (
        <div className="space-y-6">
          <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  {isZh ? 'Docker Compose 生产部署示例（含 # 可选变量说明）' : 'Docker Compose Production Template (with # Optional Variables)'}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Oauth/docker-compose.yml · {isZh ? '先执行 mkdir -p ./data && chown -R 1000:1000 ./data' : 'Run mkdir -p ./data && chown -R 1000:1000 ./data first'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => copy('docker_compose', dockerComposeSnippet)}
                className="px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap"
              >
                {copiedId === 'docker_compose' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedId === 'docker_compose' ? t.copied : t.copyCode}</span>
              </button>
            </div>
            <pre className="p-5 text-xs font-mono text-slate-800 dark:text-slate-200 bg-slate-50/70 dark:bg-[#0B0F19] overflow-x-auto leading-relaxed">
              {dockerComposeSnippet}
            </pre>
          </section>

          <div className="grid grid-cols-1 md:grid-cols-3 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-[#111827] divide-y md:divide-y-0 md:divide-x divide-slate-200 dark:divide-slate-800 text-xs">
            <div className="p-5 space-y-1">
              <div className="font-mono font-semibold text-slate-900 dark:text-white">WIMOTEK_MASTER_KEY</div>
              <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                {isZh
                  ? '用于 AES-256-GCM 静态加密第三方 Secret、Apple .p8、TOTP 与 Webhook 密钥。不设置会自动生成并持久化至 /data/keys/master.key（0600），仅多节点共享 MySQL 时需手动统一。'
                  : 'Derives the AES-256-GCM key for stored OAuth secrets, Apple .p8, TOTP & webhooks. Auto-generated at /data/keys/master.key (0600) if unset; set explicitly for multi-node MySQL clusters.'}
              </p>
            </div>
            <div className="p-5 space-y-1">
              <div className="font-mono font-semibold text-slate-900 dark:text-white">/data (RW) &amp; /certs (:ro)</div>
              <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                {isZh
                  ? '优先读取只读挂载 /certs 中的自定义证书；无证书时自动在 /data/certs 生成持久化自签名证书，绝不向 /certs 写入。'
                  : 'Loads custom TLS certs from read-only /certs first; falls back to generating persistent self-signed certs inside /data/certs.'}
              </p>
            </div>
            <div className="p-5 space-y-1">
              <div className="font-mono font-semibold text-slate-900 dark:text-white">SQLite3 WAL &amp; Redis Fallback</div>
              <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                {isZh
                  ? '默认零配置 SQLite3（WAL + busy_timeout=5000）支持切换 MySQL 8；未配 Redis 或断连时自动降级至 SQL 缓存表。'
                  : 'Zero-config SQLite3 WAL (or MySQL 8) with automatic Redis-to-SQL cache failover for PKCE, OTP, and rate limiting.'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
