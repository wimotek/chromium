import { useState, type FormEvent } from 'react';
import { Trash2, UserPlus, Users } from 'lucide-react';

export interface ProductionUser {
  id: string;
  email: string;
  name: string;
  role: 'super_admin' | 'admin' | 'member';
  tier: 'free' | 'pro' | 'enterprise' | 'unlimited';
  status: 'active' | 'disabled';
  authProvider: string;
  linkCount: number;
  lastLoginAt: string | null;
  createdAt: string;
}

export function UsersPanel({
  users,
  allowRegistration,
  currentUserId,
  onRefresh,
}: {
  users: ProductionUser[];
  allowRegistration: boolean;
  currentUserId: string;
  onRefresh: () => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [tier, setTier] = useState<'free' | 'pro' | 'enterprise' | 'unlimited'>('free');
  const [msg, setMsg] = useState('');

  async function handleCreateUser(e: FormEvent) {
    e.preventDefault();
    setMsg('');
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, name, password, role, tier }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(body.error || '创建用户失败');
      return;
    }
    setEmail('');
    setName('');
    setPassword('');
    setMsg(`已创建用户 ${body.email}`);
    await onRefresh();
  }

  async function handleUpdateUser(id: string, patch: Record<string, string>) {
    const res = await fetch(`/api/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setMsg(b.error || '更新失败');
      return;
    }
    await onRefresh();
  }

  async function handleDeleteUser(id: string) {
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE', credentials: 'include' });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setMsg(b.error || '删除失败');
      return;
    }
    await onRefresh();
  }

  async function handleToggleReg(checked: boolean) {
    await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ allowRegistration: checked }),
    });
    await onRefresh();
  }

  return (
    <div className="space-y-6 text-xs">
      <form onSubmit={handleCreateUser} className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Users className="w-4 h-4 text-blue-600" />
            用户管理、角色权限与配额级别
          </h2>
          <label className="inline-flex items-center gap-2 text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={allowRegistration}
              onChange={(e) => handleToggleReg(e.target.checked)}
            />
            <span>允许新用户自助注册</span>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="用户邮箱"
            className="md:col-span-3 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="姓名（可选）"
            className="md:col-span-2 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
          />
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="初始密码（>=8位）"
            className="md:col-span-2 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
            className="md:col-span-2 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
          >
            <option value="member">普通成员 (302)</option>
            <option value="admin">管理员 (301/307)</option>
          </select>
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value as 'free' | 'pro' | 'enterprise' | 'unlimited')}
            className="md:col-span-1 px-2 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
          >
            <option value="free">Free</option>
            <option value="pro">Pro</option>
            <option value="enterprise">Ent</option>
            <option value="unlimited">Unlim</option>
          </select>
          <button type="submit" className="md:col-span-2 inline-flex items-center justify-center gap-1 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium">
            <UserPlus className="w-3.5 h-3.5" />
            新增用户
          </button>
        </div>
        {msg && <p className="text-blue-600 dark:text-blue-400">{msg}</p>}
      </form>

      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-[10px] overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 text-slate-500">
              <th className="py-3 px-4">用户 / 邮箱</th>
              <th className="py-3 px-3">认证来源</th>
              <th className="py-3 px-3">角色</th>
              <th className="py-3 px-3">配额级别</th>
              <th className="py-3 px-3 text-right">已建短链</th>
              <th className="py-3 px-3">状态</th>
              <th className="py-3 px-4 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {users.map((u) => (
              <tr key={u.id}>
                <td className="py-3 px-4">
                  <div className="font-semibold">{u.name}</div>
                  <div className="font-mono text-slate-500">{u.email}</div>
                </td>
                <td className="py-3 px-3 font-mono text-slate-500">{u.authProvider}</td>
                <td className="py-3 px-3">
                  {u.role === 'super_admin' ? (
                    <span className="font-mono font-semibold text-blue-600">super_admin</span>
                  ) : (
                    <select
                      value={u.role}
                      onChange={(e) => handleUpdateUser(u.id, { role: e.target.value })}
                      className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-transparent"
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                  )}
                </td>
                <td className="py-3 px-3">
                  <select
                    value={u.tier}
                    onChange={(e) => handleUpdateUser(u.id, { tier: e.target.value })}
                    className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-transparent font-mono"
                  >
                    <option value="free">free</option>
                    <option value="pro">pro</option>
                    <option value="enterprise">enterprise</option>
                    <option value="unlimited">unlimited</option>
                  </select>
                </td>
                <td className="py-3 px-3 text-right font-mono">{u.linkCount}</td>
                <td className="py-3 px-3">
                  <span className={u.status === 'active' ? 'text-emerald-600 font-medium' : 'text-red-500 font-medium'}>
                    {u.status === 'active' ? '正常' : '已停用'}
                  </span>
                </td>
                <td className="py-3 px-4 text-right whitespace-nowrap space-x-2">
                  {u.role !== 'super_admin' && u.id !== currentUserId && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateUser(u.id, { status: u.status === 'active' ? 'disabled' : 'active' })
                        }
                        className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        {u.status === 'active' ? '停用并踢下线' : '恢复启用'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteUser(u.id)}
                        className="p-1.5 text-slate-500 hover:text-red-600"
                        title="删除用户"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
