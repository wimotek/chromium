import React, { useEffect, useState } from 'react';
import {
  Download,
  Plus,
  Trash2,
  KeyRound,
  Bot,
  Code2,
  Play,
  Info,
  ExternalLink,
  Globe,
} from 'lucide-react';
import {
  api,
  type ApiTokenRecord,
  type AuditRecord,
  type CRLInfo,
  type OCSPCheckResult,
  type OverviewData,
  type TokenScope,
  type UserProfile,
} from '../lib/api';
import type { LocaleDict } from '../lib/i18n';
import { formatUnixUtc } from '../lib/pki-utils';
import { CodeBlock, CopyButton } from './CopyButton';
import { AcmeEabPanel } from './AcmeEabPanel';

const ALL_SCOPES: Array<{ value: TokenScope; label: string; desc: string }> = [
  { value: 'certs:read', label: 'certs:read', desc: 'List / inspect certificates & expiring inventory' },
  { value: 'certs:issue', label: 'certs:issue', desc: 'Issue, renew, and batch-issue certificates' },
  { value: 'certs:revoke', label: 'certs:revoke', desc: 'Revoke certificates & purge CRL cache' },
  { value: 'webhook:send', label: 'webhook:send', desc: 'Send messages to your personal webhook relay' },
  { value: 'mcp:access', label: 'mcp:access', desc: 'Invoke MCP tools & resources from AI agents' },
];

const MCP_TOOLS_CATALOG: Array<{
  name: string;
  scope: string;
  desc: string;
  sampleArgs: Record<string, unknown>;
}> = [
  {
    name: 'get_ca_overview',
    scope: 'certs:read',
    desc: 'Return Root CA / Issuing CA hierarchy, active/revoked counts, and CRL/OCSP URLs.',
    sampleArgs: {},
  },
  {
    name: 'list_certificates',
    scope: 'certs:read',
    desc: 'List certificates with optional status (active/revoked/expired) and profile filter.',
    sampleArgs: { status: 'active' },
  },
  {
    name: 'list_expiring_certificates',
    scope: 'certs:read',
    desc: 'Find active certificates expiring within the next N days (default 30).',
    sampleArgs: { days: 30 },
  },
  {
    name: 'check_ocsp_status',
    scope: 'certs:read',
    desc: 'Check real-time RFC 6960 OCSP revocation status for a certificate serial.',
    sampleArgs: { serial_hex: '' },
  },
  {
    name: 'issue_certificate',
    scope: 'certs:issue',
    desc: 'Issue an X.509 certificate from any of the 8 enterprise templates.',
    sampleArgs: {
      profile: 'tls_server',
      common_name: 'agent-demo.internal',
      sans: ['agent-demo.internal', '10.20.0.88'],
      validity_days: 90,
    },
  },
  {
    name: 'renew_certificate',
    scope: 'certs:issue',
    desc: 'Renew an existing certificate by serial number with fresh 128-bit serial.',
    sampleArgs: { serial_hex: '', validity_days: 90, revoke_old: false },
  },
  {
    name: 'revoke_certificate',
    scope: 'certs:revoke',
    desc: 'Revoke a certificate with RFC 5280 reason code and update CRL immediately.',
    sampleArgs: { serial_hex: '', reason: 4 },
  },
  {
    name: 'send_webhook_notification',
    scope: 'webhook:send',
    desc: 'Push a Markdown alert to your personal ServerChan webhook relay and forward to all channels.',
    sampleArgs: {
      title: 'MCP Agent Health Check',
      desp: '**Status**: All TLS certificates verified via MCP tool.',
      tags: 'MCP|PKI',
    },
  },
];

export const TrustView: React.FC<{ t: LocaleDict; overview: OverviewData | null }> = ({ t, overview }) => {
  const [crlInfo, setCrlInfo] = useState<CRLInfo | null>(null);
  const [serialInput, setSerialInput] = useState('');
  const [ocspResult, setOcspResult] = useState<OCSPCheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api.getCRLInfo().then(setCrlInfo).catch(() => {});
  }, []);

  const handleOcspCheck = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!serialInput.trim()) return;
    setChecking(true);
    try {
      const res = await api.checkOCSP(serialInput.trim());
      setOcspResult(res);
    } finally {
      setChecking(false);
    }
  };

  const baseUrl = overview?.base_url || window.location.origin;
  const crlDerUrl = `${baseUrl}/ca/crl.der`;
  const crlPemUrl = `${baseUrl}/ca/crl.pem`;
  const ocspUrl = overview?.ocsp_url || `${baseUrl}/ocsp`;

  const winCmd = `curl -fsSL ${baseUrl}/ca/root.crt -o root.crt\ncertutil -addstore -f "ROOT" root.crt`;
  const macCmd = `curl -fsSL ${baseUrl}/ca/root.crt -o root.crt\nsudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain root.crt`;
  const debianCmd = `sudo curl -fsSL ${baseUrl}/ca/root.crt -o /usr/local/share/ca-certificates/wimotek-root.crt\nsudo update-ca-certificates`;
  const rhelCmd = `sudo curl -fsSL ${baseUrl}/ca/root.crt -o /etc/pki/ca-trust/source/anchors/wimotek-root.crt\nsudo update-ca-trust extract`;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="font-display text-xl font-bold text-slate-900 wrap-anywhere">{t.trust.title}</h2>
        <p className="text-sm text-slate-600 wrap-anywhere">{t.trust.subtitle}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* RFC 5280 CRL Card */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <h3 className="font-display text-base font-semibold text-slate-900 wrap-anywhere">
            {t.trust.crlSection}
          </h3>
          <dl className="divide-y divide-slate-100 text-xs">
            <div className="py-2.5 flex justify-between gap-4">
              <dt className="text-slate-500">{t.trust.crlNumber}</dt>
              <dd className="font-mono text-slate-900 tabular-nums">{crlInfo ? `#${crlInfo.crl_number}` : '—'}</dd>
            </div>
            <div className="py-2.5 flex justify-between gap-4">
              <dt className="text-slate-500">{t.trust.thisUpdate}</dt>
              <dd className="font-mono text-slate-900 tabular-nums">{crlInfo ? formatUnixUtc(crlInfo.this_update) : '—'}</dd>
            </div>
            <div className="py-2.5 flex justify-between gap-4">
              <dt className="text-slate-500">{t.trust.nextUpdate}</dt>
              <dd className="font-mono text-slate-900 tabular-nums">{crlInfo ? formatUnixUtc(crlInfo.next_update) : '—'}</dd>
            </div>
            <div className="py-2.5 flex justify-between gap-4">
              <dt className="text-slate-500">{t.trust.revokedCount}</dt>
              <dd className="font-mono font-semibold text-slate-900 tabular-nums">
                {crlInfo ? crlInfo.revoked_count : '—'}
              </dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-3">
              <dt className="text-slate-500 shrink-0">CRL DER URL</dt>
              <dd className="flex items-center gap-1.5 min-w-0">
                <span dir="ltr" className="font-mono text-slate-700 truncate text-[11px]">{crlDerUrl}</span>
                <CopyButton compact value={crlDerUrl} ariaLabel={t.common.copy} copiedLabel={t.common.copied} />
              </dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-3">
              <dt className="text-slate-500 shrink-0">CRL PEM URL</dt>
              <dd className="flex items-center gap-1.5 min-w-0">
                <span dir="ltr" className="font-mono text-slate-700 truncate text-[11px]">{crlPemUrl}</span>
                <CopyButton compact value={crlPemUrl} ariaLabel={t.common.copy} copiedLabel={t.common.copied} />
              </dd>
            </div>
          </dl>

          <div className="flex flex-wrap gap-3 pt-1">
            <a
              href="/ca/crl.der"
              download
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#0F766E] hover:bg-[#115E59] text-white text-xs font-medium whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{t.trust.downloadDer}</span>
            </a>
            <a
              href="/ca/crl.pem"
              download
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-medium whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{t.trust.downloadPem}</span>
            </a>
          </div>
        </div>

        {/* RFC 6960 OCSP Status Verifier */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="space-y-1.5">
            <h3 className="font-display text-base font-semibold text-slate-900 wrap-anywhere">
              {t.trust.ocspSection}
            </h3>
            <div className="flex items-center justify-between gap-2 text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
              <span dir="ltr" className="font-mono text-slate-700 truncate">{ocspUrl}</span>
              <CopyButton compact value={ocspUrl} label={t.common.copy} copiedLabel={t.common.copied} />
            </div>
          </div>
          <form onSubmit={handleOcspCheck} className="space-y-3">
            <label htmlFor="ocsp-serial" className="sr-only">
              {t.trust.ocspPlaceholder}
            </label>
            <input
              id="ocsp-serial"
              type="text"
              value={serialInput}
              onChange={(e) => setSerialInput(e.target.value)}
              placeholder={t.trust.ocspPlaceholder}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-xs font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
            />
            <button
              type="submit"
              disabled={checking}
              className="px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium cursor-pointer whitespace-nowrap"
            >
              {t.trust.ocspCheck}
            </button>
          </form>

          {ocspResult && (
            <div className="border-t border-slate-100 pt-4 space-y-1.5 text-xs">
              <div
                className={`font-semibold ${
                  ocspResult.status === 'good'
                    ? 'text-emerald-700'
                    : ocspResult.status === 'revoked'
                    ? 'text-red-700'
                    : 'text-amber-700'
                }`}
              >
                {ocspResult.status === 'good'
                  ? t.trust.ocspGood
                  : ocspResult.status === 'revoked'
                  ? t.trust.ocspRevoked
                  : t.trust.ocspUnknown}
              </div>
              {ocspResult.common_name && (
                <div className="text-slate-600">CN: {ocspResult.common_name}</div>
              )}
              <div className="flex items-center justify-between gap-2 font-mono text-slate-500 wrap-anywhere">
                <span>
                  Serial: {ocspResult.serial_hex} · Checked {formatUnixUtc(ocspResult.checked_at)}
                </span>
                <CopyButton
                  compact
                  value={ocspResult.serial_hex}
                  ariaLabel={t.common.copy}
                  copiedLabel={t.common.copied}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Zero-Config Endpoint Trust Deployment Commands (with Copy Buttons) */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-display text-base font-semibold text-slate-900 wrap-anywhere">
            {t.trust.installGuides}
          </h3>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500">Root CA URL:</span>
            <code dir="ltr" className="font-mono text-slate-700 bg-slate-100 px-2 py-1 rounded">
              {baseUrl}/ca/root.crt
            </code>
            <CopyButton
              compact
              value={`${baseUrl}/ca/root.crt`}
              label={t.common.copy}
              copiedLabel={t.common.copied}
            />
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <CodeBlock
            title="Windows (GPO / PowerShell Administrator)"
            code={winCmd}
            copyLabel={t.common.copy}
            copiedLabel={t.common.copied}
          />
          <CodeBlock
            title="macOS (System Keychain)"
            code={macCmd}
            copyLabel={t.common.copy}
            copiedLabel={t.common.copied}
          />
          <CodeBlock
            title="Linux (Debian / Ubuntu)"
            code={debianCmd}
            copyLabel={t.common.copy}
            copiedLabel={t.common.copied}
          />
          <CodeBlock
            title="Linux (RHEL / Rocky / Fedora / CentOS)"
            code={rhelCmd}
            copyLabel={t.common.copy}
            copiedLabel={t.common.copied}
          />
        </div>
      </div>
    </div>
  );
};

interface AutomationViewProps {
  t: LocaleDict;
  overview: OverviewData | null;
  currentUser?: UserProfile | null;
}

export const AutomationView: React.FC<AutomationViewProps> = ({ t, overview, currentUser }) => {
  const [subTab, setSubTab] = useState<'acme' | 'tokens' | 'mcp' | 'recipes'>('acme');
  const [tokens, setTokens] = useState<ApiTokenRecord[]>([]);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [scopes, setScopes] = useState<TokenScope[]>([
    'certs:read',
    'certs:issue',
    'webhook:send',
    'mcp:access',
  ]);
  const [maxTtl, setMaxTtl] = useState(365);
  const [expiresDays, setExpiresDays] = useState(90);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  // Live MCP Tool Tester state
  const [selectedTool, setSelectedTool] = useState<string>(MCP_TOOLS_CATALOG[0].name);
  const [toolArgsText, setToolArgsText] = useState<string>('{}');
  const [mcpRunning, setMcpRunning] = useState(false);
  const [mcpOutput, setMcpOutput] = useState<string>('');
  const [mcpError, setMcpError] = useState<string>('');

  const load = () => {
    api
      .listTokens()
      .then((r) => setTokens(r.tokens || []))
      .catch(() => {});
  };

  useEffect(() => {
    load();
  }, []);

  const toggleScope = (scope: TokenScope) => {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError('');
    setCreating(true);
    try {
      const res = await api.createToken({
        name: name.trim(),
        purpose: purpose.trim(),
        scopes: scopes.length > 0 ? scopes : ['certs:read'],
        max_ttl_days: maxTtl,
        expires_in_days: expiresDays,
      });
      setNewToken(res.token);
      setName('');
      setPurpose('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create token');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    setError('');
    try {
      await api.deleteToken(id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke token');
    }
  };

  const handleSelectTool = (toolName: string) => {
    setSelectedTool(toolName);
    const meta = MCP_TOOLS_CATALOG.find((item) => item.name === toolName);
    setToolArgsText(JSON.stringify(meta?.sampleArgs || {}, null, 2));
    setMcpError('');
  };

  const handleRunMcpTool = async () => {
    setMcpError('');
    setMcpRunning(true);
    try {
      let parsedArgs: Record<string, unknown> = {};
      if (toolArgsText.trim()) {
        parsedArgs = JSON.parse(toolArgsText);
      }
      const res = await api.callMcp('tools/call', {
        name: selectedTool,
        arguments: parsedArgs,
      });
      setMcpOutput(JSON.stringify(res, null, 2));
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : 'MCP invocation failed');
    } finally {
      setMcpRunning(false);
    }
  };

  const baseUrl = overview?.base_url || window.location.origin;
  const sampleToken = newToken || 'wca_YOUR_API_TOKEN';
  const isAdmin = currentUser?.role === 'admin';

  const claudeCursorConfig = JSON.stringify(
    {
      mcpServers: {
        'wimotek-ca': {
          url: `${baseUrl}/mcp`,
          headers: {
            Authorization: `Bearer ${sampleToken}`,
          },
        },
      },
    },
    null,
    2
  );

  const vscodeMcpConfig = JSON.stringify(
    {
      servers: {
        'wimotek-ca': {
          type: 'http',
          url: `${baseUrl}/mcp`,
          headers: {
            Authorization: `Bearer ${sampleToken}`,
          },
        },
      },
    },
    null,
    2
  );

  const mcpCurlSnippet = `curl -sX POST ${baseUrl}/mcp \\
  -H "Authorization: Bearer ${sampleToken}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;

  const restFlowSnippet = `# 1. Issue a TLS server certificate
curl -sX POST ${baseUrl}/api/certificates \\
  -H "Authorization: Bearer ${sampleToken}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "profile": "tls_server",
    "common_name": "api.corp.internal",
    "sans": ["api.corp.internal", "10.20.0.15"],
    "validity_days": 90
  }'

# 2. Query certificates expiring within 30 days
curl -s "${baseUrl}/api/certificates/expiring?days=30" \\
  -H "Authorization: Bearer ${sampleToken}"

# 3. One-click renew by serial number (optionally revoking old cert)
curl -sX POST ${baseUrl}/api/certificates/<SERIAL_HEX>/renew \\
  -H "Authorization: Bearer ${sampleToken}" \\
  -H "Content-Type: application/json" \\
  -d '{"validity_days": 90, "revoke_old": false}'`;

  const nginxCronSnippet = `#!/usr/bin/env bash
set -euo pipefail
CA_URL="${baseUrl}"
TOKEN="${sampleToken}"

# Issue fresh certificate & save chain (requires jq)
RESP=$(curl -fsSL -X POST "$CA_URL/api/certificates" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"profile":"tls_server","common_name":"web.internal","sans":["web.internal"],"validity_days":90}')

echo "$RESP" | jq -r '.chain_pem' > /etc/nginx/ssl/web.internal.fullchain.pem
nginx -t && systemctl reload nginx

# Notify your channels via personal webhook relay
curl -fsSL -X POST "$CA_URL/api/webhook/send" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Nginx TLS Renewed","desp":"Successfully rotated web.internal certificate.","tags":"Nginx|PKI"}'`;

  const k8sVaultSnippet = `# Works with OpenBao / HashiCorp Vault PKI API (/v1/pki/*)
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: wimotek-ca-vault-issuer
spec:
  vault:
    server: ${baseUrl}
    path: v1/pki/issue/tls_server
    auth:
      tokenSecretRef:
        name: wimotek-api-token
        key: token

# Or invoke directly with Vault CLI / curl:
curl -sX POST ${baseUrl}/v1/pki/issue/tls_server \\
  -H "X-Vault-Token: ${sampleToken}" \\
  -H "Content-Type: application/json" \\
  -d '{"common_name":"svc.cluster.local","alt_names":"svc.cluster.local,10.96.0.10","ttl_days":90}'`;

  const acmeCaddySnippet = `# Inspect ACME Directory (RFC 8555)
curl -s ${baseUrl}/acme/directory

# Caddyfile example pointing to internal ACME directory
{
  acme_ca ${baseUrl}/acme/directory
  acme_ca_root /etc/ssl/certs/wimotek-root.crt
}
app.internal {
  reverse_proxy 127.0.0.1:8080
}`;

  const batchIssueSnippet = `curl -sX POST ${baseUrl}/api/certificates/batch-issue \\
  -H "Authorization: Bearer ${sampleToken}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "items": [
      {"profile":"tls_server","common_name":"edge-1.internal","sans":["edge-1.internal"],"validity_days":90},
      {"profile":"iot_device","common_name":"sensor-01.factory","validity_days":180}
    ]
  }'`;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="font-display text-xl font-bold text-slate-900 wrap-anywhere">{t.automation.title}</h2>
        <p className="text-sm text-slate-600 wrap-anywhere">{t.automation.subtitle}</p>
      </div>

      {/* Sub-Navigation Tabs */}
      <div className="border-b border-slate-200 flex flex-wrap gap-1" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'acme'}
          onClick={() => setSubTab('acme')}
          className={`inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
            subTab === 'acme'
              ? 'border-[#0F766E] text-[#0F766E]'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          <Globe className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{t.automation.tabAcme}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'tokens'}
          onClick={() => setSubTab('tokens')}
          className={`inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
            subTab === 'tokens'
              ? 'border-[#0F766E] text-[#0F766E]'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{t.automation.tabTokens}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'mcp'}
          onClick={() => setSubTab('mcp')}
          className={`inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
            subTab === 'mcp'
              ? 'border-[#0F766E] text-[#0F766E]'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          <Bot className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{t.automation.tabMcp}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'recipes'}
          onClick={() => setSubTab('recipes')}
          className={`inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
            subTab === 'recipes'
              ? 'border-[#0F766E] text-[#0F766E]'
              : 'border-transparent text-slate-600 hover:text-slate-900'
          }`}
        >
          <Code2 className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{t.automation.tabRecipes}</span>
        </button>
      </div>

      {/* TAB 0: Commercial ACME v2 & EAB (ZeroSSL Mode) */}
      {subTab === 'acme' && (
        <AcmeEabPanel t={t} overview={overview} currentUser={currentUser} />
      )}

      {/* TAB 1: Multi-Purpose User API Tokens */}
      {subTab === 'tokens' && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-base font-semibold text-slate-900">
                {t.automation.provisionersTitle}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Use the same API token across REST (`/api/*`), Vault-compatible (`/v1/pki/*`), Personal Webhook (`/api/webhook/send`), and MCP (`/mcp`).
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <a
                href="/api/openapi.json"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
              >
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                <span>OpenAPI 3.0</span>
              </a>
            </div>
          </div>

          <form onSubmit={handleCreate} className="space-y-4 bg-slate-50/70 border border-slate-200 rounded-xl p-4">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4">
                <label htmlFor="tok-name" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.automation.tokenName}
                </label>
                <input
                  id="tok-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t.automation.tokenNamePlaceholder}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div className="md:col-span-4">
                <label htmlFor="tok-purpose" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.automation.purposeLabel}
                </label>
                <input
                  id="tok-purpose"
                  type="text"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder={t.automation.purposePlaceholder}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div className="md:col-span-2">
                <label htmlFor="tok-exp" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.automation.expiresLabel}
                </label>
                <select
                  id="tok-exp"
                  value={expiresDays}
                  onChange={(e) => setExpiresDays(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                >
                  <option value={0}>{t.automation.neverExpires}</option>
                  <option value={30}>30d</option>
                  <option value={90}>90d</option>
                  <option value={365}>365d</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label htmlFor="tok-ttl" className="block text-xs font-medium text-slate-700 mb-1">
                  Max Cert TTL (d)
                </label>
                <input
                  id="tok-ttl"
                  type="number"
                  min={1}
                  max={1095}
                  value={maxTtl}
                  onChange={(e) => setMaxTtl(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono tabular-nums text-slate-900"
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium text-slate-700">{t.automation.scopesLabel}</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
                {ALL_SCOPES.map((sc) => {
                  const checked = scopes.includes(sc.value);
                  return (
                    <label
                      key={sc.value}
                      className={`flex items-start gap-2 rounded-lg border p-2.5 text-xs cursor-pointer transition-colors ${
                        checked
                          ? 'bg-teal-50/70 border-teal-300 text-slate-900'
                          : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleScope(sc.value)}
                        className="mt-0.5 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                      />
                      <span className="min-w-0">
                        <span className="block font-mono font-semibold text-[11px]">{sc.label}</span>
                        <span className="block text-[10px] text-slate-500 leading-snug mt-0.5">{sc.desc}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {error && (
              <div role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2">
                {error}
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={creating}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white text-xs font-medium cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t.automation.createToken}</span>
              </button>
            </div>
          </form>

          {newToken && (
            <div className="bg-teal-50/70 border border-teal-200 rounded-lg p-4 space-y-2.5 text-xs">
              <div className="font-semibold text-teal-900">{t.automation.tokenCreatedNotice}</div>
              <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-teal-200 rounded-lg px-3 py-2">
                <code dir="ltr" className="font-mono text-slate-900 wrap-anywhere">{newToken}</code>
                <div className="flex items-center gap-2 shrink-0">
                  <CopyButton
                    value={newToken}
                    label={t.common.copy}
                    copiedLabel={t.common.copied}
                  />
                  <CopyButton
                    value={`Authorization: Bearer ${newToken}`}
                    label="Copy Header"
                    copiedLabel={t.common.copied}
                  />
                </div>
              </div>
            </div>
          )}

          {tokens.length === 0 ? (
            <p className="text-xs text-slate-500 pt-2">{t.automation.emptyTokens}</p>
          ) : (
            <div className="overflow-x-auto border-t border-slate-100 pt-2">
              <table className="w-full text-xs text-start">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2.5 pe-3 font-medium text-start">{t.automation.tokenName} &amp; {t.automation.purposeLabel}</th>
                    <th className="py-2.5 pe-3 font-medium text-start">{t.automation.scopesLabel}</th>
                    <th className="py-2.5 pe-3 font-medium text-start">Prefix</th>
                    {isAdmin && <th className="py-2.5 pe-3 font-medium text-start">{t.automation.owner}</th>}
                    <th className="py-2.5 pe-3 font-medium text-start">{t.automation.lastUsed} / {t.automation.expiresLabel}</th>
                    <th className="py-2.5 font-medium text-end">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {tokens.map((tok) => (
                    <tr key={tok.id} className="hover:bg-slate-50/70">
                      <td className="py-3 pe-3">
                        <div className="font-semibold text-slate-900 wrap-anywhere">{tok.name}</div>
                        <div className="text-[11px] text-slate-500 wrap-anywhere mt-0.5">
                          {tok.purpose || '—'}
                        </div>
                      </td>
                      <td className="py-3 pe-3">
                        <div className="flex flex-wrap gap-1">
                          {(tok.scopes || []).map((sc) => (
                            <span
                              key={sc}
                              className="inline-block font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200"
                            >
                              {sc}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-3 pe-3 font-mono text-slate-600 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          <span>{tok.token_prefix}</span>
                          <CopyButton
                            compact
                            value={tok.token_prefix}
                            ariaLabel={t.common.copy}
                            copiedLabel={t.common.copied}
                          />
                        </span>
                      </td>
                      {isAdmin && (
                        <td className="py-3 pe-3 font-medium text-slate-700 whitespace-nowrap">
                          {tok.owner_username || 'admin'}
                        </td>
                      )}
                      <td className="py-3 pe-3 font-mono text-[11px] text-slate-500 whitespace-nowrap tabular-nums">
                        <div>Used: {tok.last_used_at ? formatUnixUtc(tok.last_used_at) : 'Never'}</div>
                        <div>
                          Exp: {tok.expires_at ? formatUnixUtc(tok.expires_at) : t.automation.neverExpires} · TTL ≤ {tok.max_ttl_days}d
                        </div>
                      </td>
                      <td className="py-3 text-end whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => handleDelete(tok.id)}
                          className="inline-flex items-center gap-1 text-red-700 hover:text-red-900 font-medium cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>{t.automation.deleteToken}</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: MCP Server & AI Agents */}
      {subTab === 'mcp' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="space-y-1">
              <h3 className="font-display text-base font-semibold text-slate-900">{t.automation.mcpTitle}</h3>
              <p className="text-xs text-slate-600 wrap-anywhere">{t.automation.mcpDesc}</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-medium text-slate-500">{t.automation.mcpEndpoint} (JSON-RPC 2.0)</div>
                  <div dir="ltr" className="font-mono text-slate-900 truncate mt-0.5">{baseUrl}/mcp</div>
                </div>
                <CopyButton value={`${baseUrl}/mcp`} label={t.common.copy} copiedLabel={t.common.copied} />
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-medium text-slate-500">MCP Discovery Manifest (GET)</div>
                  <div dir="ltr" className="font-mono text-slate-900 truncate mt-0.5">{baseUrl}/mcp/manifest</div>
                </div>
                <CopyButton value={`${baseUrl}/mcp/manifest`} label={t.common.copy} copiedLabel={t.common.copied} />
              </div>
            </div>

            <div className="space-y-2 pt-2">
              <div className="text-xs font-semibold text-slate-800">{t.automation.mcpConfigTitle}</div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <CodeBlock
                  title="Claude Desktop / Cursor (~/.cursor/mcp.json)"
                  code={claudeCursorConfig}
                  copyLabel={t.common.copy}
                  copiedLabel={t.common.copied}
                />
                <CodeBlock
                  title="VS Code (.vscode/mcp.json)"
                  code={vscodeMcpConfig}
                  copyLabel={t.common.copy}
                  copiedLabel={t.common.copied}
                />
              </div>
              <CodeBlock
                title="Test MCP Endpoint via curl (tools/list)"
                code={mcpCurlSnippet}
                copyLabel={t.common.copy}
                copiedLabel={t.common.copied}
              />
            </div>
          </div>

          {/* 8 MCP Tools + Live Tester */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
            <div className="xl:col-span-6 bg-white border border-slate-200 rounded-xl p-6 space-y-3">
              <h4 className="font-display text-sm font-semibold text-slate-900">
                Exposed MCP Tools ({MCP_TOOLS_CATALOG.length}) &amp; Resources (3)
              </h4>
              <div className="divide-y divide-slate-100 text-xs">
                {MCP_TOOLS_CATALOG.map((tool) => (
                  <div key={tool.name} className="py-2.5 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <code className="font-mono font-semibold text-slate-900">{tool.name}</code>
                        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                          {tool.scope}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-600 mt-0.5">{tool.desc}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleSelectTool(tool.name)}
                      className={`px-2 py-1 rounded text-[11px] font-medium shrink-0 cursor-pointer border ${
                        selectedTool === tool.name
                          ? 'bg-teal-50 border-teal-300 text-teal-800'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      Try
                    </button>
                  </div>
                ))}
              </div>
              <div className="pt-2 border-t border-slate-100 text-[11px] text-slate-500">
                Resources: <code className="font-mono text-slate-700">ca://root.crt</code> ·{' '}
                <code className="font-mono text-slate-700">ca://chain.pem</code> ·{' '}
                <code className="font-mono text-slate-700">ca://overview</code>
              </div>
            </div>

            <div className="xl:col-span-6 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h4 className="font-display text-sm font-semibold text-slate-900">
                  {t.automation.mcpTesterTitle}
                </h4>
                <span className="text-[11px] font-mono text-slate-500">POST /mcp</span>
              </div>

              <div className="space-y-3">
                <div>
                  <label htmlFor="mcp-tool-sel" className="block text-xs font-medium text-slate-700 mb-1">
                    Tool Name
                  </label>
                  <select
                    id="mcp-tool-sel"
                    value={selectedTool}
                    onChange={(e) => handleSelectTool(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                  >
                    {MCP_TOOLS_CATALOG.map((tool) => (
                      <option key={tool.name} value={tool.name}>
                        {tool.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="mcp-tool-args" className="block text-xs font-medium text-slate-700 mb-1">
                    Arguments (JSON)
                  </label>
                  <textarea
                    id="mcp-tool-args"
                    rows={5}
                    value={toolArgsText}
                    onChange={(e) => setToolArgsText(e.target.value)}
                    dir="ltr"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                  />
                </div>

                <button
                  type="button"
                  disabled={mcpRunning}
                  onClick={handleRunMcpTool}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white text-xs font-medium cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{mcpRunning ? 'Invoking...' : t.automation.mcpRunTool}</span>
                </button>

                {mcpError && (
                  <div role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {mcpError}
                  </div>
                )}

                {mcpOutput && (
                  <CodeBlock
                    title="JSON-RPC 2.0 Response"
                    code={mcpOutput}
                    copyLabel={t.common.copy}
                    copiedLabel={t.common.copied}
                    maxHeightClass="max-h-80"
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: API Examples & Protocol Explanations */}
      {subTab === 'recipes' && (
        <div className="space-y-6">
          {/* Plain-Language Protocol Explainers */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
              <div className="flex items-start gap-2.5">
                <Info className="w-4 h-4 text-teal-700 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="space-y-1.5 min-w-0">
                  <h3 className="font-display text-sm font-semibold text-slate-900 wrap-anywhere">
                    {t.automation.vaultExplainTitle}
                  </h3>
                  <p className="text-xs text-slate-600 leading-relaxed wrap-anywhere">
                    {t.automation.vaultExplainDesc}
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs">
                <code dir="ltr" className="font-mono text-slate-800 truncate">
                  {baseUrl}/v1/pki/issue/tls_server
                </code>
                <CopyButton
                  compact
                  value={`${baseUrl}/v1/pki/issue/tls_server`}
                  label={t.common.copy}
                  copiedLabel={t.common.copied}
                />
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
              <div className="flex items-start gap-2.5">
                <Info className="w-4 h-4 text-teal-700 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="space-y-1.5 min-w-0">
                  <h3 className="font-display text-sm font-semibold text-slate-900 wrap-anywhere">
                    {t.automation.acmeExplainTitle}
                  </h3>
                  <p className="text-xs text-slate-600 leading-relaxed wrap-anywhere">
                    {t.automation.acmeExplainDesc}
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs">
                <code dir="ltr" className="font-mono text-slate-800 truncate">
                  {baseUrl}/acme/directory
                </code>
                <CopyButton
                  compact
                  value={`${baseUrl}/acme/directory`}
                  label={t.common.copy}
                  copiedLabel={t.common.copied}
                />
              </div>
            </div>
          </div>

          {/* Concrete Automation Recipes */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-display text-base font-semibold text-slate-900">
                {t.automation.restExamplesTitle}
              </h3>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <CopyButton
                  value={`${baseUrl}/api/openapi.json`}
                  label="Copy OpenAPI URL"
                  copiedLabel={t.common.copied}
                />
                <CopyButton
                  value={`${baseUrl}/api/ca/bundle`}
                  label="Copy CA Bundle URL"
                  copiedLabel={t.common.copied}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <CodeBlock
                title="1. REST API: Issue, Query Expiring & One-Click Renew"
                code={restFlowSnippet}
                copyLabel={t.common.copy}
                copiedLabel={t.common.copied}
              />
              <CodeBlock
                title="2. Nginx Auto-Renew Script + Personal Webhook Alert"
                code={nginxCronSnippet}
                copyLabel={t.common.copy}
                copiedLabel={t.common.copied}
              />
              <CodeBlock
                title="3. Kubernetes cert-manager & Vault PKI (/v1/pki/issue)"
                code={k8sVaultSnippet}
                copyLabel={t.common.copy}
                copiedLabel={t.common.copied}
              />
              <CodeBlock
                title="4. Caddy / ACME Directory Integration (/acme/directory)"
                code={acmeCaddySnippet}
                copyLabel={t.common.copy}
                copiedLabel={t.common.copied}
              />
            </div>

            <CodeBlock
              title="5. Batch Issue Multiple Certificates (POST /api/certificates/batch-issue)"
              code={batchIssueSnippet}
              copyLabel={t.common.copy}
              copiedLabel={t.common.copied}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export const AuditView: React.FC<{ t: LocaleDict }> = ({ t }) => {
  const [audits, setAudits] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listAudits()
      .then((res) => setAudits(res.audits))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="font-display text-xl font-bold text-slate-900 wrap-anywhere">{t.audit.title}</h2>
        <p className="text-sm text-slate-600 wrap-anywhere">{t.audit.subtitle}</p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3" aria-busy="true">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-9 bg-slate-100 rounded animate-pulse" />
            ))}
          </div>
        ) : audits.length === 0 ? (
          <div className="p-8 text-sm text-slate-500">{t.audit.empty}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-start">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-slate-500">
                  <th className="py-3 ps-5 pe-3 font-medium text-start">{t.audit.time}</th>
                  <th className="py-3 pe-3 font-medium text-start">{t.audit.actor}</th>
                  <th className="py-3 pe-3 font-medium text-start">{t.audit.action}</th>
                  <th className="py-3 pe-3 font-medium text-start">{t.audit.target}</th>
                  <th className="py-3 pe-5 font-medium text-start">{t.audit.ip}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {audits.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 ps-5 pe-3 font-mono text-slate-500 whitespace-nowrap tabular-nums">
                      {formatUnixUtc(row.created_at)}
                    </td>
                    <td className="py-2.5 pe-3 text-slate-800 font-medium wrap-anywhere">{row.actor}</td>
                    <td className="py-2.5 pe-3 font-mono text-slate-900 whitespace-nowrap">{row.action}</td>
                    <td className="py-2.5 pe-3 font-mono text-slate-600 wrap-anywhere">
                      {row.target_serial ? (
                        <span className="inline-flex items-center gap-1">
                          <span>{row.target_serial}</span>
                          <CopyButton
                            compact
                            value={row.target_serial}
                            ariaLabel={t.common.copy}
                            copiedLabel={t.common.copied}
                          />
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-2.5 pe-5 font-mono text-slate-500 whitespace-nowrap">{row.client_ip}</td>
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
