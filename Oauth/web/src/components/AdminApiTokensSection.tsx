import React, { useCallback, useEffect, useState } from 'react';
import {
  KeyRound,
  Plus,
  Copy,
  Check,
  Trash2,
  X,
  AlertCircle,
  CheckCircle2,
  Terminal,
  ShieldCheck,
  Cpu,
} from 'lucide-react';
import type { Locale } from '../types';

export interface AdminApiTokenDTO {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  active: boolean;
}

export function buildMcpClientConfigJson(mcpEndpoint: string, tokenOrPlaceholder: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'wimotek-oauth': {
          url: mcpEndpoint,
          headers: {
            Authorization: `Bearer ${tokenOrPlaceholder}`,
          },
        },
      },
    },
    null,
    2
  );
}

interface SharedTokenManagerProps {
  locale: Locale;
  sessionToken: string;
  issuerUrl?: string;
  onTokenCreated?: (plainToken: string) => void;
}

function TokenManagerBody({
  locale,
  sessionToken,
  issuerUrl,
  onTokenCreated,
}: SharedTokenManagerProps) {
  const isZh = locale === 'zh-CN' || locale === 'zh-TW';
  const [tokens, setTokens] = useState<AdminApiTokenDTO[]>([]);
  const [mcpEndpoint, setMcpEndpoint] = useState<string>(() => {
    const base = (issuerUrl || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8080')).replace(/\/$/, '');
    return `${base}/api/mcp`;
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<number>(90);
  const [creating, setCreating] = useState(false);
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const buildHeaders = useCallback(
    (extra: Record<string, string> = {}): Record<string, string> => {
      const h: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest', ...extra };
      if (sessionToken && sessionToken !== 'cookie_session') {
        h.Authorization = `Bearer ${sessionToken}`;
      }
      return h;
    },
    [sessionToken]
  );

  const fetchTokens = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/tokens', {
        credentials: 'include',
        headers: buildHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || (isZh ? '加载 Admin API Token 失败' : 'Failed to load Admin API tokens'));
        return;
      }
      setTokens(Array.isArray(data.tokens) ? data.tokens : []);
      if (typeof data.mcpEndpoint === 'string' && data.mcpEndpoint) {
        setMcpEndpoint(data.mcpEndpoint);
      }
    } catch {
      setError(isZh ? '无法连接后端服务' : 'Network error loading API tokens');
    } finally {
      setLoading(false);
    }
  }, [buildHeaders, isZh]);

  useEffect(() => {
    void fetchTokens();
  }, [fetchTokens]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) {
      setError(isZh ? '请先输入 Token 名称（如 Cursor MCP）' : 'Please enter a token name');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/tokens', {
        method: 'POST',
        credentials: 'include',
        headers: buildHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name: clean,
          expiresInDays,
          scopes: ['admin:api', 'mcp:tools'],
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) {
        setError(data.message || (isZh ? '生成 Token 失败' : 'Failed to create token'));
        return;
      }
      setNewlyCreatedToken(data.token);
      setTokens(Array.isArray(data.tokens) ? data.tokens : []);
      if (typeof data.mcpEndpoint === 'string' && data.mcpEndpoint) {
        setMcpEndpoint(data.mcpEndpoint);
      }
      setName('');
      onTokenCreated?.(data.token);
    } catch {
      setError(isZh ? '生成 Token 时发生网络错误' : 'Network error while creating token');
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    setRevokingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/tokens/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: buildHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || (isZh ? '吊销失败' : 'Failed to revoke token'));
        return;
      }
      setTokens(Array.isArray(data.tokens) ? data.tokens : tokens.filter((t) => t.id !== id));
      setConfirmRevokeId(null);
    } catch {
      setError(isZh ? '吊销时发生网络错误' : 'Network error revoking token');
    } finally {
      setRevokingId(null);
    }
  }

  function copyValue(key: string, text: string) {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
    }
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2000);
  }

  function formatDate(iso?: string) {
    if (!iso) return isZh ? '永不过期' : 'Never';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }

  const mcpSnippet = buildMcpClientConfigJson(mcpEndpoint, newlyCreatedToken || '$WIMOTEK_ADMIN_TOKEN');

  return (
    <div className="space-y-5">
      {/* Create Token Form */}
      <form
        onSubmit={handleCreate}
        className="grid grid-cols-1 sm:grid-cols-12 gap-3 p-4 rounded-xl bg-slate-50 dark:bg-[#0D1321] border border-slate-200 dark:border-slate-800"
      >
        <div className="sm:col-span-6 space-y-1">
          <label className="text-[11px] font-medium text-slate-600 dark:text-slate-300">
            {isZh ? 'Token 名称（用途标识）' : 'Token Name'}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isZh ? '例如：Cursor MCP / AI 样式同步' : 'e.g. Cursor MCP / CI Theme Sync'}
            maxLength={80}
            className="w-full min-h-[38px] px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] text-slate-900 dark:text-slate-100"
          />
        </div>
        <div className="sm:col-span-3 space-y-1">
          <label className="text-[11px] font-medium text-slate-600 dark:text-slate-300">
            {isZh ? '有效期' : 'Expiration'}
          </label>
          <select
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(Number(e.target.value))}
            className="w-full min-h-[38px] px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] text-slate-900 dark:text-slate-100"
          >
            <option value={30}>{isZh ? '30 天' : '30 days'}</option>
            <option value={90}>{isZh ? '90 天（推荐）' : '90 days (Recommended)'}</option>
            <option value={365}>{isZh ? '365 天' : '365 days'}</option>
            <option value={0}>{isZh ? '永不过期' : 'No expiration'}</option>
          </select>
        </div>
        <div className="sm:col-span-3 flex items-end">
          <button
            type="submit"
            disabled={creating}
            className="w-full min-h-[38px] px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-medium flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{creating ? (isZh ? '生成中...' : 'Minting...') : isZh ? '生成 Admin Token' : 'Generate Token'}</span>
          </button>
        </div>
      </form>

      {error && (
        <div className="flex items-center gap-2 text-xs rounded-lg px-3.5 py-2.5 border text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/50">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* One-time reveal banner after creating a token */}
      {newlyCreatedToken && (
        <div className="p-4 rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-950/25 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
              <div className="space-y-0.5">
                <div className="text-xs font-semibold text-emerald-900 dark:text-emerald-200">
                  {isZh
                    ? 'Admin API Token 已生成 — 仅完整显示这一次，请立即复制保存！'
                    : 'Admin API Token Created — Copy it now; it will not be shown again!'}
                </div>
                <p className="text-[11px] text-emerald-800/90 dark:text-emerald-300/80">
                  {isZh
                    ? '服务端仅保存 SHA-256 哈希。可用于环境变量 WIMOTEK_ADMIN_TOKEN、REST 管理 API 及 MCP 客户端。'
                    : 'Only the SHA-256 hash is stored server-side. Use as WIMOTEK_ADMIN_TOKEN for REST Admin APIs and MCP clients.'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setNewlyCreatedToken(null)}
              className="p-1 rounded text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <code className="flex-1 px-3 py-2 rounded-lg bg-slate-950 text-emerald-300 font-mono text-xs break-all select-all">
              {newlyCreatedToken}
            </code>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => copyValue('new_tok', newlyCreatedToken)}
                className="min-h-[36px] px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium flex items-center gap-1.5"
              >
                {copiedKey === 'new_tok' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedKey === 'new_tok' ? (isZh ? '已复制' : 'Copied') : isZh ? '复制 Token' : 'Copy Token'}</span>
              </button>
              <button
                type="button"
                onClick={() => copyValue('export_env', `export WIMOTEK_ADMIN_TOKEN="${newlyCreatedToken}"`)}
                className="min-h-[36px] px-3 py-1.5 rounded-lg border border-emerald-300 dark:border-emerald-700 bg-white dark:bg-[#111827] text-emerald-800 dark:text-emerald-200 text-xs font-medium flex items-center gap-1.5 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>{copiedKey === 'export_env' ? (isZh ? '已复制' : 'Copied') : 'export ...'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Active Tokens Table */}
      <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 bg-slate-50 dark:bg-[#0D1321] border-b border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-800 dark:text-slate-200">
            {isZh ? `已签发的 Admin Tokens (${tokens.length})` : `Active Admin Tokens (${tokens.length})`}
          </span>
          <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
            Header: Authorization: Bearer wmk_pat_...
          </span>
        </div>

        {loading ? (
          <div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
            {isZh ? '加载中...' : 'Loading tokens...'}
          </div>
        ) : tokens.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
            {isZh
              ? '尚未生成 Admin API Token。请在上方输入名称并点击“生成 Admin Token”，即可用于 $WIMOTEK_ADMIN_TOKEN 或 MCP 接入。'
              : 'No Admin API tokens yet. Create one above to authenticate REST scripts ($WIMOTEK_ADMIN_TOKEN) and MCP clients.'}
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {tokens.map((tok) => (
              <div
                key={tok.id}
                className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-slate-900 dark:text-white truncate">{tok.name}</span>
                    <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-[11px] text-slate-700 dark:text-slate-300">
                      {tok.prefix}
                    </code>
                    <span
                      className={`text-[11px] font-medium ${
                        tok.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {tok.active ? (isZh ? '生效中' : 'Active') : isZh ? '已过期' : 'Expired'}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-3 flex-wrap">
                    <span>
                      {isZh ? '创建于' : 'Created'}: {formatDate(tok.createdAt)}
                    </span>
                    <span>
                      {isZh ? '到期' : 'Expires'}: {formatDate(tok.expiresAt)}
                    </span>
                    <span>
                      {isZh ? '最近使用' : 'Last used'}:{' '}
                      {tok.lastUsedAt ? formatDate(tok.lastUsedAt) : isZh ? '尚未使用' : 'Never'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {confirmRevokeId === tok.id ? (
                    <>
                      <button
                        type="button"
                        disabled={revokingId === tok.id}
                        onClick={() => void handleRevoke(tok.id)}
                        className="px-2.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-[11px] font-medium"
                      >
                        {revokingId === tok.id ? (isZh ? '吊销中...' : 'Revoking...') : isZh ? '确认吊销' : 'Confirm Revoke'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRevokeId(null)}
                        className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-[11px]"
                      >
                        {isZh ? '取消' : 'Cancel'}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmRevokeId(tok.id)}
                      className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-red-300 dark:hover:border-red-800 hover:text-red-600 dark:hover:text-red-400 text-slate-600 dark:text-slate-300 text-[11px] font-medium flex items-center gap-1 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{isZh ? '吊销' : 'Revoke'}</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* MCP Server Configuration Card */}
      <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 bg-slate-50 dark:bg-[#0D1321] border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-white">
            <Cpu className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
            <span>{isZh ? 'MCP Server 端点配置 (Cursor / Claude Desktop / Windsurf)' : 'MCP Server Endpoint (Cursor / Claude Desktop / Windsurf)'}</span>
          </div>
          <button
            type="button"
            onClick={() => copyValue('mcp_json', mcpSnippet)}
            className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] font-medium flex items-center gap-1 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            {copiedKey === 'mcp_json' ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
            <span>{copiedKey === 'mcp_json' ? (isZh ? '已复制' : 'Copied') : isZh ? '复制 mcp.json' : 'Copy mcp.json'}</span>
          </button>
        </div>
        <div className="p-3.5 space-y-2.5 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-400">
            <span className="font-mono break-all">
              <strong className="text-indigo-600 dark:text-indigo-400">POST</strong> {mcpEndpoint}
            </span>
            <span className="font-mono text-[10.5px]">
              JSON-RPC 2.0 · Streamable HTTP
            </span>
          </div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400">
            {isZh
              ? '内置 6 个 MCP 工具：list_applications、get_login_theme、update_login_theme、list_connectors、get_auth_policy、list_users。'
              : 'Exposes 6 MCP tools: list_applications, get_login_theme, update_login_theme, list_connectors, get_auth_policy, list_users.'}
          </div>
          <pre className="p-3 rounded-lg bg-slate-950 text-slate-100 font-mono text-[11px] overflow-x-auto leading-relaxed">
            {mcpSnippet}
          </pre>
        </div>
      </div>
    </div>
  );
}

export function AdminApiTokensSection(props: SharedTokenManagerProps) {
  const isZh = props.locale === 'zh-CN' || props.locale === 'zh-TW';
  return (
    <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              {isZh
                ? 'Admin API Tokens ($WIMOTEK_ADMIN_TOKEN) 与 MCP Server'
                : 'Admin API Tokens ($WIMOTEK_ADMIN_TOKEN) & MCP Server'}
            </h2>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {isZh
              ? '签发长期管理令牌，用于 REST API 脚本（如自动同步登录页样式）或接入 Cursor / Claude 等 AI 客户端的 MCP Server。'
              : 'Mint personal admin access tokens for REST API automation (such as hosted login theme sync) and Streamable HTTP MCP clients.'}
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400 font-medium shrink-0">
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>{isZh ? 'SHA-256 哈希存储 · 随时吊销' : 'SHA-256 Hashed · Instant Revoke'}</span>
        </div>
      </div>

      <TokenManagerBody {...props} />
    </section>
  );
}

interface AdminTokenManagerModalProps extends SharedTokenManagerProps {
  open: boolean;
  onClose: () => void;
}

export function AdminTokenManagerModal({
  open,
  onClose,
  ...rest
}: AdminTokenManagerModalProps) {
  const isZh = rest.locale === 'zh-CN' || rest.locale === 'zh-TW';
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              {isZh
                ? '获取 $WIMOTEK_ADMIN_TOKEN & MCP 配置'
                : 'Manage $WIMOTEK_ADMIN_TOKEN & MCP Config'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto">
          <TokenManagerBody {...rest} />
        </div>
      </div>
    </div>
  );
}
