import { useState, type FormEvent } from 'react';
import { Globe, Plus, Send, Star, Trash2 } from 'lucide-react';

export interface ProductionDomain {
  id: string;
  host: string;
  isDefault: boolean;
  rootRedirectEnabled: boolean;
  rootRedirectUrl: string;
  allowedTiers: string[];
  dnsVerified: boolean;
  linkCount: number;
  clicks: number;
  createdAt: string;
}

const TIER_OPTIONS = [
  { id: 'free', label: 'Free' },
  { id: 'pro', label: 'Pro' },
  { id: 'enterprise', label: 'Enterprise' },
  { id: 'unlimited', label: 'Unlimited' },
];

export function DomainsPanel({
  domains,
  seoIndexNowKey,
  isAdmin,
  onRefresh,
}: {
  domains: ProductionDomain[];
  seoIndexNowKey: string;
  isAdmin: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [newHost, setNewHost] = useState('');
  const [newRootEnabled, setNewRootEnabled] = useState(false);
  const [newRootUrl, setNewRootUrl] = useState('https://wimotek.com');
  const [newTiers, setNewTiers] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const [seoMsg, setSeoMsg] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ProductionDomain | null>(null);
  const [migrateTo, setMigrateTo] = useState('');

  async function handleAddDomain(e: FormEvent) {
    e.preventDefault();
    setMsg('');
    const res = await fetch('/api/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        host: newHost.trim(),
        rootRedirectEnabled: newRootEnabled,
        rootRedirectUrl: newRootUrl.trim(),
        allowedTiers: newTiers,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(body.error || '添加域名失败');
      return;
    }
    setNewHost('');
    setNewTiers([]);
    setMsg(`已添加自定义域名 ${body.host}`);
    await onRefresh();
  }

  async function handleSetDefault(id: string) {
    await fetch(`/api/domains/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ isDefault: true }),
    });
    await onRefresh();
  }

  async function handleToggleRoot(d: ProductionDomain) {
    await fetch(`/api/domains/${d.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ rootRedirectEnabled: !d.rootRedirectEnabled }),
    });
    await onRefresh();
  }

  async function handleDeleteDomain(d: ProductionDomain, force = false, migrateHost = '') {
    const qs = migrateHost
      ? `?migrateTo=${encodeURIComponent(migrateHost)}`
      : force
      ? '?force=1'
      : '';
    const res = await fetch(`/api/domains/${d.id}${qs}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(body.error || '删除失败');
      return;
    }
    setDeleteTarget(null);
    setMsg(`已删除域名 ${d.host}`);
    await onRefresh();
  }

  async function handleSeoPing() {
    setSeoMsg('正在推送公开短链至搜索引擎...');
    const res = await fetch('/api/seo/ping', { method: 'POST', credentials: 'include' });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      setSeoMsg(`已提交 ${body.submittedUrls ?? 0} 条允许收录短链至 IndexNow / Google Sitemap / Baidu。`);
    } else {
      setSeoMsg(body.error || '推送失败');
    }
  }

  return (
    <div className="space-y-6 text-xs">
      {isAdmin && (
        <form onSubmit={handleAddDomain} className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Globe className="w-4 h-4 text-blue-600" />
              多域名管理（支持独立根路径 301 转发与用户级别隔离）
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <input
              required
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              placeholder="新增短链域名，如 go.example.com"
              className="md:col-span-4 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent font-mono"
            />
            <input
              value={newRootUrl}
              onChange={(e) => setNewRootUrl(e.target.value)}
              placeholder="根路径 / 301 目标地址 https://..."
              className="md:col-span-4 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent font-mono"
            />
            <label className="md:col-span-2 flex items-center gap-2 px-2">
              <input type="checkbox" checked={newRootEnabled} onChange={(e) => setNewRootEnabled(e.target.checked)} />
              <span>启用根路径 301</span>
            </label>
            <button type="submit" className="md:col-span-2 inline-flex items-center justify-center gap-1 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium">
              <Plus className="w-3.5 h-3.5" />
              添加域名
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-slate-500">开放用户级别（不勾选默认全员可用）：</span>
            {TIER_OPTIONS.map((tier) => (
              <label key={tier.id} className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={newTiers.includes(tier.id)}
                  onChange={(e) =>
                    setNewTiers((prev) =>
                      e.target.checked ? [...prev, tier.id] : prev.filter((x) => x !== tier.id)
                    )
                  }
                />
                <span>{tier.label}</span>
              </label>
            ))}
          </div>
          {msg && <p className="text-blue-600 dark:text-blue-400">{msg}</p>}
        </form>
      )}

      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 text-slate-500">
              <th className="py-3 px-4">短链域名</th>
              <th className="py-3 px-3">根路径 / 转发策略 (HTTP 301)</th>
              <th className="py-3 px-3">开放级别</th>
              <th className="py-3 px-3 text-right">短链数 / 点击</th>
              {isAdmin && <th className="py-3 px-4 text-right">操作</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {domains.map((d) => (
              <tr key={d.id}>
                <td className="py-3 px-4 font-mono font-semibold">
                  <div className="flex items-center gap-2">
                    <span>{d.host}</span>
                    {d.isDefault && (
                      <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-[10px]">
                        默认
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-3 px-3">
                  <div className="flex items-center gap-2">
                    <span className={d.rootRedirectEnabled ? 'text-emerald-600 font-medium' : 'text-slate-400'}>
                      {d.rootRedirectEnabled ? '301 开启' : '展示入口页'}
                    </span>
                    {d.rootRedirectEnabled && <span className="font-mono text-slate-500 truncate max-w-xs">{d.rootRedirectUrl}</span>}
                  </div>
                </td>
                <td className="py-3 px-3 font-mono text-slate-500">
                  {d.allowedTiers.length > 0 ? d.allowedTiers.join(', ') : '全部级别'}
                </td>
                <td className="py-3 px-3 text-right font-mono">
                  {d.linkCount} 条 · {d.clicks} 点击
                </td>
                {isAdmin && (
                  <td className="py-3 px-4 text-right whitespace-nowrap space-x-2">
                    {!d.isDefault && (
                      <button type="button" onClick={() => handleSetDefault(d.id)} title="设为默认域名" className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1">
                        <Star className="w-3 h-3" /> 设默认
                      </button>
                    )}
                    <button type="button" onClick={() => handleToggleRoot(d)} className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800">
                      {d.rootRedirectEnabled ? '关闭根301' : '开启根301'}
                    </button>
                    <button
                      type="button"
                      disabled={d.isDefault}
                      onClick={() => {
                        if (d.linkCount > 0) {
                          setDeleteTarget(d);
                          const fallback = domains.find((x) => x.id !== d.id)?.host || '';
                          setMigrateTo(fallback);
                        } else {
                          handleDeleteDomain(d);
                        }
                      }}
                      className="p-1.5 text-slate-500 hover:text-red-600 disabled:opacity-30"
                      title="删除域名"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* SEO Sitemap & IndexNow Push */}
      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="text-sm font-semibold">SEO 站点地图与搜索引擎推送</div>
          <div className="text-slate-500 font-mono">
            Sitemap: <a href="/sitemap.xml" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">/sitemap.xml</a> · IndexNow Key: {seoIndexNowKey || '(auto)'}
          </div>
          {seoMsg && <div className="text-emerald-600 dark:text-emerald-400">{seoMsg}</div>}
        </div>
        <button type="button" onClick={handleSeoPing} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-medium">
          <Send className="w-3.5 h-3.5" />
          立即推送搜索引擎收录
        </button>
      </section>

      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] p-5 space-y-4">
            <h3 className="text-sm font-semibold">删除域名 {deleteTarget.host}</h3>
            <p className="text-slate-500">该域名下仍有 {deleteTarget.linkCount} 条短链接。请选择迁移目标域名或连同短链一起删除：</p>
            <select
              value={migrateTo}
              onChange={(e) => setMigrateTo(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent font-mono"
            >
              {domains
                .filter((x) => x.id !== deleteTarget.id)
                .map((x) => (
                  <option key={x.id} value={x.host}>
                    迁移至 {x.host}
                  </option>
                ))}
            </select>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteTarget(null)} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700">
                取消
              </button>
              <button type="button" onClick={() => handleDeleteDomain(deleteTarget, true)} className="px-3 py-1.5 rounded-lg bg-red-600 text-white">
                强制一并删除
              </button>
              {migrateTo && (
                <button type="button" onClick={() => handleDeleteDomain(deleteTarget, false, migrateTo)} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white">
                  迁移短链并删除
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
