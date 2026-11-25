import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  Rocket,
  Layers,
  Code2,
  Bot,
  Webhook,
  ShieldCheck,
  ArrowRight,
} from 'lucide-react';
import { api, type OAuthProviderInfo, type OverviewData, type UserProfile } from '../lib/api';
import type { LocaleDict } from '../lib/i18n';
import { ALL_PROFILES, PROFILE_SPECS } from '../lib/pki-utils';
import { CodeBlock, CopyButton } from './CopyButton';
import type { TabKey } from '../App';

interface HelpViewProps {
  t: LocaleDict;
  overview: OverviewData | null;
  currentUser: UserProfile | null;
  onNavigate?: (tab: TabKey) => void;
}

type HelpTab = 'quickStart' | 'templates' | 'api' | 'mcp' | 'webhook' | 'oauth';

export const HelpView: React.FC<HelpViewProps> = ({
  t,
  overview,
  currentUser,
  onNavigate,
}) => {
  const [tab, setTab] = useState<HelpTab>('quickStart');
  const [providers, setProviders] = useState<OAuthProviderInfo[]>([]);

  useEffect(() => {
    api
      .getOAuthProviders()
      .then((res) => setProviders(res.providers || []))
      .catch(() => {});
  }, []);

  const baseUrl = overview?.base_url || window.location.origin;
  const username = currentUser?.username || 'admin';

  const tabs: Array<{ key: HelpTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { key: 'quickStart', label: t.help.quickStartTab, icon: Rocket },
    { key: 'templates', label: t.help.templatesTab, icon: Layers },
    { key: 'api', label: t.help.apiTab, icon: Code2 },
    { key: 'mcp', label: t.help.mcpTab, icon: Bot },
    { key: 'webhook', label: t.help.webhookTab, icon: Webhook },
    { key: 'oauth', label: t.help.oauthTab, icon: ShieldCheck },
  ];

  const quickTrustCmd = `# Download & trust Root CA (Debian / Ubuntu)
sudo curl -fsSL ${baseUrl}/ca/root.crt -o /usr/local/share/ca-certificates/wimotek-root.crt
sudo update-ca-certificates`;

  const apiQuickSnippet = `# Issue a certificate via REST API
curl -sX POST ${baseUrl}/api/certificates \\
  -H "Authorization: Bearer wca_YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"profile":"tls_server","common_name":"app.internal","sans":["app.internal"],"validity_days":90}'

# List certificates expiring in 30 days
curl -s "${baseUrl}/api/certificates/expiring?days=30" \\
  -H "Authorization: Bearer wca_YOUR_TOKEN"

# Fetch Root + Issuing CA bundle
curl -s ${baseUrl}/api/ca/bundle`;

  const mcpAgentJson = JSON.stringify(
    {
      mcpServers: {
        'wimotek-ca': {
          url: `${baseUrl}/mcp`,
          headers: {
            Authorization: 'Bearer wca_YOUR_TOKEN',
          },
        },
      },
    },
    null,
    2
  );

  const serverChanCurl = `# ServerChan Turbo / ServerChan³ compatible format
curl -X POST "${baseUrl}/webhook/${username}/wkh_YOUR_PERSONAL_KEY.send" \\
  --data-urlencode "title=Cert Auto-Renewed" \\
  --data-urlencode "desp=### Details\n- Host: api.internal\n- Valid: 90 days" \\
  --data-urlencode "tags=PKI|Prod"`;

  const pythonWebhook = `import requests

# Drop-in replacement for ServerChan (sctapi.ftqq.com)
resp = requests.post(
    "${baseUrl}/webhook/${username}/wkh_YOUR_PERSONAL_KEY.send",
    json={
        "title": "Database Backup OK",
        "desp": "**Cluster**: prod-eu-1\\n\\nSnapshot uploaded in 14s.",
        "short": "Backup succeeded",
        "tags": "DB|Ops",
    },
    timeout=10,
)
print(resp.json())`;

  const oauthEnvBlock = `# Primary Unified SSO / IdP Gateway: wimotek/OAuth (PKCE S256)
# Example only — you can also edit these directly in Admin UI -> My Profile
WIMOTEK_OAUTH_ISSUER=https://oauth.example.com
WIMOTEK_OAUTH_CLIENT_ID=your_oauth_client_id
WIMOTEK_OAUTH_CLIENT_SECRET=your_oauth_client_secret
WIMOTEK_OAUTH_SCOPES="openid profile email"

# Optional Direct IdPs (only needed if bypassing wimotek/OAuth)
# OAUTH_MICROSOFT_CLIENT_ID=...
# OAUTH_GITHUB_CLIENT_ID=...
# OAUTH_GOOGLE_CLIENT_ID=...`;

  const wimotekGoSnippet = `// Built-in offline PKCE S256 client (compatible with github.com/wimotek/oauth/sdk/go)
oauthClient := &wimotekoauth.Client{
    Issuer:       os.Getenv("WIMOTEK_OAUTH_ISSUER"),
    ClientID:     os.Getenv("WIMOTEK_OAUTH_CLIENT_ID"),
    ClientSecret: os.Getenv("WIMOTEK_OAUTH_CLIENT_SECRET"),
    RedirectURI:  baseURL + "/api/auth/oauth/wimotek/callback",
}
loginURL, state, verifier := oauthClient.BuildLoginURL()
// Callback verifies CSRF state + PKCE code_verifier & returns res.User["name"], res.User["email"]`;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-teal-700" aria-hidden="true" />
          <h2 className="font-display text-xl font-bold text-slate-900 wrap-anywhere">{t.help.title}</h2>
        </div>
        <p className="text-sm text-slate-600 wrap-anywhere">{t.help.subtitle}</p>
      </div>

      {/* Tab Bar */}
      <div className="border-b border-slate-200 flex flex-wrap gap-1" role="tablist">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
              tab === key
                ? 'border-[#0F766E] text-[#0F766E]'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Icon className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* 1. Quick Start */}
      {tab === 'quickStart' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              {
                step: '01',
                title: 'Distribute & Trust Root CA',
                desc: 'Install the ECDSA P-256 Root CA onto Windows, macOS, or Linux endpoints so all issued TLS, PDF, and Entra CBA certificates validate cleanly.',
                action: 'Open Trust & CRL',
                target: 'trust' as TabKey,
              },
              {
                step: '02',
                title: 'Issue Your First Certificate',
                desc: 'Pick from 8 enterprise templates (TLS Server, PDF Signing, Entra ID CBA, Code Signing, S/MIME, 802.1X Wi-Fi, mTLS, IoT) with automatic Modern2023 .pfx export.',
                action: 'Open Issue Certificate',
                target: 'issue' as TabKey,
              },
              {
                step: '03',
                title: 'Set Up Alerts & Personal Webhook Relay',
                desc: 'Add Email, ServerChan, Telegram, or Slack/Feishu/DingTalk channels. Any alert posted to your personal ServerChan-compatible webhook forwards to all enabled channels.',
                action: 'Open Alerts & Webhook',
                target: 'notifications' as TabKey,
              },
              {
                step: '04',
                title: 'Create Scoped API Tokens & Connect AI Agents',
                desc: 'Generate named API tokens with purpose notes and granular scopes for CI/CD scripts, Kubernetes cert-manager, or MCP-compatible AI agents.',
                action: 'Open API, Tokens & MCP',
                target: 'automation' as TabKey,
              },
            ].map((item) => (
              <div key={item.step} className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4">
                <div className="space-y-1.5">
                  <div className="font-mono text-xs font-bold text-teal-700">STEP {item.step}</div>
                  <h3 className="font-display text-sm font-semibold text-slate-900">{item.title}</h3>
                  <p className="text-xs text-slate-600 leading-relaxed">{item.desc}</p>
                </div>
                {onNavigate && (
                  <div>
                    <button
                      type="button"
                      onClick={() => onNavigate(item.target)}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-700 hover:text-teal-900 cursor-pointer"
                    >
                      <span>{item.action}</span>
                      <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <CodeBlock
            title="Quick Endpoint Trust Command"
            code={quickTrustCmd}
            copyLabel={t.common.copy}
            copiedLabel={t.common.copied}
          />
        </div>
      )}

      {/* 2. 8 Templates Reference */}
      {tab === 'templates' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-start">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-slate-500">
                  <th className="py-3 ps-5 pe-3 font-medium text-start">Template ID</th>
                  <th className="py-3 pe-3 font-medium text-start">Name &amp; Use Case</th>
                  <th className="py-3 pe-3 font-medium text-start">Key Usage</th>
                  <th className="py-3 pe-3 font-medium text-start">EKU OIDs</th>
                  <th className="py-3 pe-5 font-medium text-start">Default TTL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ALL_PROFILES.map((prof) => {
                  const spec = PROFILE_SPECS[prof];
                  const meta = t.issue.profiles[prof];
                  return (
                    <tr key={prof} className="hover:bg-slate-50/70">
                      <td className="py-3 ps-5 pe-3 font-mono font-semibold text-slate-900 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          <span>{prof}</span>
                          <CopyButton compact value={prof} ariaLabel={t.common.copy} copiedLabel={t.common.copied} />
                        </span>
                      </td>
                      <td className="py-3 pe-3">
                        <div className="font-semibold text-slate-900">{meta?.name || prof}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">{meta?.desc}</div>
                      </td>
                      <td className="py-3 pe-3 text-slate-700">{spec.keyUsage.join(', ')}</td>
                      <td className="py-3 pe-3 font-mono text-[11px] text-slate-600">
                        <div className="space-y-0.5">
                          {spec.ekuOids.map((oid) => (
                            <div key={oid} className="inline-flex items-center gap-1 me-2">
                              <span>{oid}</span>
                              <CopyButton compact value={oid} ariaLabel={t.common.copy} copiedLabel={t.common.copied} />
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="py-3 pe-5 font-mono text-slate-800 whitespace-nowrap tabular-nums">
                        {spec.defaultTtlDays}d
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. API & DevOps */}
      {tab === 'api' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
              <div className="font-semibold text-slate-900">Native REST API (`/api/*`)</div>
              <p className="text-slate-600 leading-relaxed">
                Full JSON API for issuing, renewing, batch-issuing, revoking, querying expiring certs, and sending webhook notifications. Authenticated with `Authorization: Bearer wca_...`.
              </p>
              <div className="pt-1 flex items-center justify-between gap-2">
                <code className="font-mono text-teal-700">/api/openapi.json</code>
                <CopyButton compact value={`${baseUrl}/api/openapi.json`} label={t.common.copy} copiedLabel={t.common.copied} />
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
              <div className="font-semibold text-slate-900">Vault / OpenBao Routes (`/v1/pki/*`)</div>
              <p className="text-slate-600 leading-relaxed">
                Drop-in compatibility layer for Kubernetes `cert-manager`, Terraform, and Vault CLI. Pass your API token as `X-Vault-Token` to `/v1/pki/issue/{'{profile}'}` and `/v1/pki/revoke`.
              </p>
              <div className="pt-1 flex items-center justify-between gap-2">
                <code className="font-mono text-teal-700">/v1/pki/issue/tls_server</code>
                <CopyButton compact value={`${baseUrl}/v1/pki/issue/tls_server`} label={t.common.copy} copiedLabel={t.common.copied} />
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
              <div className="font-semibold text-slate-900">ACME Directory (`/acme/directory`)</div>
              <p className="text-slate-600 leading-relaxed">
                RFC 8555 discovery document used by Caddy, Traefik, and ACME clients to locate nonce, account, and order endpoints automatically.
              </p>
              <div className="pt-1 flex items-center justify-between gap-2">
                <code className="font-mono text-teal-700">/acme/directory</code>
                <CopyButton compact value={`${baseUrl}/acme/directory`} label={t.common.copy} copiedLabel={t.common.copied} />
              </div>
            </div>
          </div>

          <CodeBlock
            title="REST API Quick Reference"
            code={apiQuickSnippet}
            copyLabel={t.common.copy}
            copiedLabel={t.common.copied}
          />
        </div>
      )}

      {/* 4. MCP & AI Agents */}
      {tab === 'mcp' && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1 max-w-2xl">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Connect AI Agents via Model Context Protocol (MCP)
              </h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                This CA runs a built-in JSON-RPC 2.0 MCP HTTP server at <code className="font-mono">/mcp</code>. Create an API token with <code className="font-mono">mcp:access</code> (plus whichever cert/webhook scopes you allow the agent to perform), then paste the config below into Claude Desktop, Cursor, or VS Code.
              </p>
            </div>
            {onNavigate && (
              <button
                type="button"
                onClick={() => onNavigate('automation')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#0F766E] hover:bg-[#115E59] text-white text-xs font-medium cursor-pointer"
              >
                <span>Open Live MCP Tester</span>
                <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </div>

          <CodeBlock
            title="MCP Client Configuration (Claude Desktop / Cursor)"
            code={mcpAgentJson}
            copyLabel={t.common.copy}
            copiedLabel={t.common.copied}
          />

          <div className="text-xs text-slate-600 space-y-1">
            <div className="font-semibold text-slate-900">Available Tools (8):</div>
            <p className="font-mono text-[11px] leading-relaxed">
              get_ca_overview · list_certificates · list_expiring_certificates · check_ocsp_status · issue_certificate · renew_certificate · revoke_certificate · send_webhook_notification
            </p>
          </div>
        </div>
      )}

      {/* 5. Personal Webhook Relay (ServerChan Format) */}
      {tab === 'webhook' && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="space-y-1">
            <h3 className="font-display text-base font-semibold text-slate-900">
              ServerChan (Server酱) Webhook Relay Manual
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Every user receives a private webhook endpoint modeled after ServerChan Turbo / ServerChan³. Whenever any script, monitoring probe (Uptime Kuma, Prometheus, Zabbix, GitHub Actions), or cron job sends a message to your webhook URL, this server automatically forwards it to all of your enabled notification channels (Email, ServerChan, Telegram, Slack/Feishu/DingTalk).
            </p>
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-xs text-start">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                  <th className="py-2.5 ps-4 pe-3 font-medium text-start">Field</th>
                  <th className="py-2.5 pe-3 font-medium text-start">Aliases</th>
                  <th className="py-2.5 pe-3 font-medium text-start">Required</th>
                  <th className="py-2.5 pe-4 font-medium text-start">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr>
                  <td className="py-2.5 ps-4 pe-3 font-mono font-semibold text-slate-900">title</td>
                  <td className="py-2.5 pe-3 font-mono text-slate-600">text</td>
                  <td className="py-2.5 pe-3 text-emerald-700 font-medium">Yes</td>
                  <td className="py-2.5 pe-4 text-slate-600">Message subject / alert headline (max 256 chars).</td>
                </tr>
                <tr>
                  <td className="py-2.5 ps-4 pe-3 font-mono font-semibold text-slate-900">desp</td>
                  <td className="py-2.5 pe-3 font-mono text-slate-600">content, body, message</td>
                  <td className="py-2.5 pe-3 text-slate-500">Optional</td>
                  <td className="py-2.5 pe-4 text-slate-600">Detailed message body (Markdown supported, up to 32 KB).</td>
                </tr>
                <tr>
                  <td className="py-2.5 ps-4 pe-3 font-mono font-semibold text-slate-900">short</td>
                  <td className="py-2.5 pe-3 font-mono text-slate-600">—</td>
                  <td className="py-2.5 pe-3 text-slate-500">Optional</td>
                  <td className="py-2.5 pe-4 text-slate-600">Compact card preview line (ServerChan³ compatible).</td>
                </tr>
                <tr>
                  <td className="py-2.5 ps-4 pe-3 font-mono font-semibold text-slate-900">tags</td>
                  <td className="py-2.5 pe-3 font-mono text-slate-600">—</td>
                  <td className="py-2.5 pe-3 text-slate-500">Optional</td>
                  <td className="py-2.5 pe-4 text-slate-600">Pipe-separated labels such as <code className="font-mono">PKI|Prod|Alert</code>.</td>
                </tr>
                <tr>
                  <td className="py-2.5 ps-4 pe-3 font-mono font-semibold text-slate-900">channel</td>
                  <td className="py-2.5 pe-3 font-mono text-slate-600">—</td>
                  <td className="py-2.5 pe-3 text-slate-500">Optional</td>
                  <td className="py-2.5 pe-4 text-slate-600">Filter forwarding to specific channel type (e.g. <code className="font-mono">telegram</code> or <code className="font-mono">email</code>).</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <CodeBlock
              title="cURL (ServerChan Format)"
              code={serverChanCurl}
              copyLabel={t.common.copy}
              copiedLabel={t.common.copied}
            />
            <CodeBlock
              title="Python (requests)"
              code={pythonWebhook}
              copyLabel={t.common.copy}
              copiedLabel={t.common.copied}
            />
          </div>
        </div>
      )}

      {/* 6. Unified wimotek/OAuth Gateway & 2FA */}
      {tab === 'oauth' && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="space-y-1">
            <h3 className="font-display text-base font-semibold text-slate-900">
              wimotek/OAuth Unified SSO Gateway (PKCE S256 + IdP), Email Verification &amp; 2FA
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Authentication is unified through your <code className="font-mono">wimotek/oauth</code> OAuth 2.0 + OIDC PKCE (S256) gateway, which centrally federates Microsoft, GitHub, Google, and enterprise IdPs. Local password accounts with email verification, Passkeys (WebAuthn), and Email OTP 2FA remain available under My Profile.
            </p>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-semibold text-slate-800">
              wimotek/OAuth Callback URLs (Register in Gateway Client Config)
            </div>
            <div className="space-y-1.5">
              {(providers.length > 0
                ? providers
                : [
                    {
                      provider: 'wimotek' as const,
                      label: 'wimotek/OAuth (Primary)',
                      configured: false,
                      callback_url: `${baseUrl}/api/auth/oauth/wimotek/callback`,
                    },
                  ]
              ).map((p) => (
                <div
                  key={p.provider}
                  className="flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs"
                >
                  <span className="font-semibold text-slate-800 w-44 shrink-0 truncate">{p.label}</span>
                  <code dir="ltr" className="font-mono text-slate-700 truncate flex-1">{p.callback_url}</code>
                  <CopyButton compact value={p.callback_url} label={t.common.copy} copiedLabel={t.common.copied} />
                </div>
              ))}
              {(() => {
                const wimotekMeta = providers.find((p) => p.provider === 'wimotek');
                const aliasUrl = (() => {
                  try {
                    return `${new URL(wimotekMeta?.callback_url || baseUrl).origin}/callback`;
                  } catch {
                    return `${baseUrl}/callback`;
                  }
                })();
                return (
                  <div className="flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs">
                    <span className="font-semibold text-slate-800 w-44 shrink-0 truncate">wimotek/OAuth Alias</span>
                    <code dir="ltr" className="font-mono text-slate-700 truncate flex-1">{aliasUrl}</code>
                    <CopyButton compact value={aliasUrl} label={t.common.copy} copiedLabel={t.common.copied} />
                  </div>
                );
              })()}
            </div>
          </div>

          <CodeBlock
            title="Required Environment Variables (.env)"
            code={oauthEnvBlock}
            copyLabel={t.common.copy}
            copiedLabel={t.common.copied}
          />

          <CodeBlock
            title="Go Backend PKCE S256 Integration (wimotek/oauth SDK)"
            code={wimotekGoSnippet}
            copyLabel={t.common.copy}
            copiedLabel={t.common.copied}
          />
        </div>
      )}
    </div>
  );
};
