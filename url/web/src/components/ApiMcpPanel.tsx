import { useState, type FormEvent } from 'react';
import { Check, Copy, Cpu, KeyRound, Play, Trash2 } from 'lucide-react';

export interface ProductionApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  revoked: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export function ApiMcpPanel({
  apiKeys,
  issuerUrl,
  onRefresh,
}: {
  apiKeys: ProductionApiKey[];
  issuerUrl: string;
  onRefresh: () => Promise<void>;
}) {
  const [keyName, setKeyName] = useState('');
  const [createdSecret, setCreatedSecret] = useState('');
  const [copied, setCopied] = useState('');
  const [mcpTool, setMcpTool] = useState<'tools/list' | 'list_urls' | 'create_short_url'>('tools/list');
  const [mcpTarget, setMcpTarget] = useState('https://wimotek.com/docs/mcp');
  const [mcpOutput, setMcpOutput] = useState('');
  const [testing, setTesting] = useState(false);

  const cleanOrigin = (issuerUrl || window.location.origin).replace(/\/+$/, '');
  const mcpConfigJson = JSON.stringify(
    {
      mcpServers: {
        'wimotek-url': {
          url: `${cleanOrigin}/mcp`,
          headers: {
            Authorization: `Bearer ${createdSecret || 'wmk_live_YOUR_API_KEY'}`,
          },
        },
      },
    },
    null,
    2
  );

  async function handleCreateKey(e: FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/apikeys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        name: keyName.trim() || 'MCP / API Key',
        scopes: ['links:read', 'links:write', 'analytics:read', 'mcp:invoke'],
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.secretKey) {
      setCreatedSecret(body.secretKey);
      setKeyName('');
      await onRefresh();
    }
  }

  async function handleRevoke(id: string) {
    await fetch(`/api/apikeys/${id}`, { method: 'DELETE', credentials: 'include' });
    await onRefresh();
  }

  async function handleRunMcpTest() {
    setTesting(true);
    setMcpOutput('');
    try {
      const payload =
        mcpTool === 'tools/list'
          ? { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
          : mcpTool === 'list_urls'
          ? { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_urls', arguments: {} } }
          : {
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: { name: 'create_short_url', arguments: { target_url: mcpTarget, title: 'Created via MCP Test' } },
            };
      const res = await fetch('/api/mcp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      setMcpOutput(JSON.stringify(body, null, 2));
      if (mcpTool === 'create_short_url') await onRefresh();
    } catch {
      setMcpOutput('MCP 调用失败');
    } finally {
      setTesting(false);
    }
  }

  function copyText(tag: string, text: string) {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(tag);
    setTimeout(() => setCopied(''), 1500);
  }

  return (
    <div className="space-y-6 text-xs">
      {/* API Key Creation & List */}
      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] p-5 space-y-4">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-blue-600" />
          REST API 与 MCP 密钥管理
        </h2>
        <form onSubmit={handleCreateKey} className="flex flex-wrap gap-3">
          <input
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="密钥名称，如 Claude Desktop / Cursor MCP"
            className="flex-1 min-w-[220px] px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
          />
          <button type="submit" className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium">
            签发新 API Key
          </button>
        </form>

        {createdSecret && (
          <div className="p-3.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 space-y-2">
            <div className="font-semibold text-emerald-700 dark:text-emerald-300">
              新密钥仅展示一次，请立即复制保存（服务端仅存 SHA-256 哈希）：
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono bg-white dark:bg-slate-900 px-3 py-1.5 rounded border border-emerald-300 dark:border-emerald-800 break-all">
                {createdSecret}
              </code>
              <button
                type="button"
                onClick={() => copyText('secret', createdSecret)}
                className="px-3 py-1.5 rounded bg-emerald-600 text-white inline-flex items-center gap-1"
              >
                {copied === 'secret' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                复制
              </button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                <th className="py-2 pr-3">名称</th>
                <th className="py-2 px-3">前缀</th>
                <th className="py-2 px-3">权限 Scope</th>
                <th className="py-2 px-3">状态</th>
                <th className="py-2 pl-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {apiKeys.map((k) => (
                <tr key={k.id}>
                  <td className="py-2.5 pr-3 font-medium">{k.name}</td>
                  <td className="py-2.5 px-3 font-mono text-slate-500">{k.prefix}***</td>
                  <td className="py-2.5 px-3 font-mono text-[11px] text-slate-500">{k.scopes.join(', ')}</td>
                  <td className="py-2.5 px-3">
                    <span className={k.revoked ? 'text-red-500' : 'text-emerald-600'}>
                      {k.revoked ? '已吊销' : '有效'}
                    </span>
                  </td>
                  <td className="py-2.5 pl-3 text-right">
                    {!k.revoked && (
                      <button
                        type="button"
                        onClick={() => handleRevoke(k.id)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 dark:border-slate-700 hover:text-red-600"
                      >
                        <Trash2 className="w-3 h-3" /> 吊销
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {apiKeys.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-400">
                    尚未签发 API / MCP 密钥，请在上方创建一个以接入 AI Agent 或自动化脚本。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* MCP Server Console & Claude/Cursor Config */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Cpu className="w-4 h-4 text-blue-600" />
              MCP JSON-RPC 2.0 端点配置
            </h3>
            <button
              type="button"
              onClick={() => copyText('mcp', mcpConfigJson)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700"
            >
              {copied === 'mcp' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              复制配置
            </button>
          </div>
          <p className="text-slate-500">
            端点：<code className="font-mono text-blue-600">POST {cleanOrigin}/mcp</code>（需携带 Bearer API Key）
          </p>
          <pre className="p-3.5 rounded-lg bg-slate-950 text-slate-100 font-mono text-[11px] overflow-x-auto">
            {mcpConfigJson}
          </pre>
        </div>

        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] p-5 space-y-3">
          <h3 className="text-sm font-semibold">在线测试 MCP 工具调用</h3>
          <div className="flex flex-wrap gap-2">
            <select
              value={mcpTool}
              onChange={(e) => setMcpTool(e.target.value as 'tools/list' | 'list_urls' | 'create_short_url')}
              className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent font-mono"
            >
              <option value="tools/list">tools/list (列出可用工具)</option>
              <option value="list_urls">tools/call: list_urls</option>
              <option value="create_short_url">tools/call: create_short_url</option>
            </select>
            <button
              type="button"
              disabled={testing}
              onClick={handleRunMcpTest}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
            >
              <Play className="w-3.5 h-3.5" />
              {testing ? '执行中...' : '运行 MCP 测试'}
            </button>
          </div>
          {mcpTool === 'create_short_url' && (
            <input
              value={mcpTarget}
              onChange={(e) => setMcpTarget(e.target.value)}
              placeholder="目标 URL"
              className="w-full px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent font-mono"
            />
          )}
          <pre className="p-3 rounded-lg bg-slate-950 text-emerald-300 font-mono text-[11px] min-h-[150px] max-h-[260px] overflow-auto">
            {mcpOutput || '// 点击“运行 MCP 测试”查看真实 JSON-RPC 2.0 响应'}
          </pre>
        </div>
      </section>
    </div>
  );
}
