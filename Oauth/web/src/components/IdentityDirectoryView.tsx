import React, { useMemo, useState } from 'react';
import {
  UserPlus,
  Ban,
  CheckCircle2,
  Webhook,
  Trash2,
  ShieldAlert,
  ShieldCheck,
  Link2,
  Fingerprint,
  KeyRound,
  AlertCircle,
  Pencil,
  Search,
  X,
  Plus,
  Unlink,
  RotateCcw,
} from 'lucide-react';
import type {
  AuthUser,
  IdentityProviderType,
  IdentityUser,
  Locale,
  PasskeyCredential,
  WebhookDeliveryLog,
  WebhookSubscription,
} from '../types';
import { TRANSLATIONS } from '../lib/i18n';

interface IdentityDirectoryViewProps {
  locale: Locale;
  currentUser: AuthUser | null;
  users: IdentityUser[];
  passkeys: PasskeyCredential[];
  webhooks: WebhookSubscription[];
  webhookLogs: WebhookDeliveryLog[];
  jitAutoLinkEnabled: boolean;
  onSimulateJit: (payload: {
    email: string;
    displayName: string;
    provider: IdentityProviderType;
    emailVerified: boolean;
  }) => Promise<{ action: string; user: IdentityUser } | null>;
  onCreateUser: (payload: {
    email: string;
    displayName: string;
    password: string;
    role: 'super_admin' | 'member';
    emailVerified: boolean;
  }) => Promise<void>;
  onUpdateUser: (
    userId: string,
    payload: {
      email: string;
      displayName: string;
      role: 'super_admin' | 'member';
      emailVerified: boolean;
    }
  ) => Promise<void>;
  onResetUserPassword: (userId: string, password: string) => Promise<void>;
  onDeleteUser: (userId: string) => Promise<void>;
  onUnlinkIdentity: (userId: string, identityId: string) => Promise<void>;
  onToggleUserStatus: (userId: string, nextStatus: 'active' | 'banned') => Promise<void>;
  onRegisterPasskey: (payload: { userId?: string; label: string }) => Promise<void>;
  onDeletePasskey: (credentialId: string) => Promise<void>;
  onCreateWebhook: (payload: { name: string; targetUrl: string; signingSecret: string }) => Promise<void>;
  onDeleteWebhook: (id: string) => Promise<void>;
}

export function IdentityDirectoryView({
  locale,
  currentUser,
  users,
  passkeys,
  webhooks,
  webhookLogs,
  jitAutoLinkEnabled,
  onSimulateJit,
  onCreateUser,
  onUpdateUser,
  onResetUserPassword,
  onDeleteUser,
  onUnlinkIdentity,
  onToggleUserStatus,
  onRegisterPasskey,
  onDeletePasskey,
  onCreateWebhook,
  onDeleteWebhook,
}: IdentityDirectoryViewProps) {
  const t = TRANSLATIONS[locale];
  const isZh = locale === 'zh-CN' || locale === 'zh-TW';

  const [searchQuery, setSearchQuery] = useState('');
  const [actionNotice, setActionNotice] = useState<{ text: string; isError?: boolean } | null>(null);

  // Create User panel
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'super_admin' | 'member'>('member');
  const [newVerified, setNewVerified] = useState(true);
  const [creatingUser, setCreatingUser] = useState(false);

  // Edit User panel
  const [editingUser, setEditingUser] = useState<IdentityUser | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState<'super_admin' | 'member'>('member');
  const [editVerified, setEditVerified] = useState(true);
  const [savingUser, setSavingUser] = useState(false);

  // Reset Password panel
  const [passwordTarget, setPasswordTarget] = useState<IdentityUser | null>(null);
  const [resetPwd, setResetPwd] = useState('');
  const [resetPwdConfirm, setResetPwdConfirm] = useState('');
  const [resettingPwd, setResettingPwd] = useState(false);

  // Register Passkey panel
  const [showPasskeyForm, setShowPasskeyForm] = useState(false);
  const [passkeyTargetUserId, setPasskeyTargetUserId] = useState<string>('');
  const [passkeyLabel, setPasskeyLabel] = useState('');
  const [registeringPasskey, setRegisteringPasskey] = useState(false);

  // Inline confirmation banners (iframe-safe, no window.confirm)
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<IdentityUser | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [confirmDeletePasskey, setConfirmDeletePasskey] = useState<PasskeyCredential | null>(null);
  const [deletingPasskeyId, setDeletingPasskeyId] = useState<string | null>(null);
  const [confirmDeleteWebhook, setConfirmDeleteWebhook] = useState<WebhookSubscription | null>(null);
  const [deletingWebhookId, setDeletingWebhookId] = useState<string | null>(null);
  const [togglingUserId, setTogglingUserId] = useState<string | null>(null);

  // JIT simulator state
  const [jitEmail, setJitEmail] = useState('');
  const [jitName, setJitName] = useState('');
  const [jitProvider, setJitProvider] = useState<IdentityProviderType>('microsoft');
  const [jitEmailVerified, setJitEmailVerified] = useState(true);
  const [jitResult, setJitResult] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);

  // Webhook form state
  const [whName, setWhName] = useState('');
  const [whUrl, setWhUrl] = useState('');
  const [whSecret, setWhSecret] = useState('');
  const [whError, setWhError] = useState<string | null>(null);
  const [addingWh, setAddingWh] = useState(false);

  const adminUsers = useMemo(
    () => users.filter((u) => u.role === 'super_admin'),
    [users]
  );
  const activeAdminCount = useMemo(
    () => adminUsers.filter((u) => u.status === 'active').length,
    [adminUsers]
  );
  const primaryAdmin = useMemo(
    () =>
      users.find((u) => currentUser && u.email.toLowerCase() === currentUser.email.toLowerCase()) ||
      adminUsers[0] ||
      null,
    [users, currentUser, adminUsers]
  );

  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        u.displayName.toLowerCase().includes(q) ||
        u.id.toLowerCase().includes(q) ||
        (u.role || 'member').toLowerCase().includes(q)
    );
  }, [users, searchQuery]);

  function openCreateUser() {
    setEditingUser(null);
    setPasswordTarget(null);
    setShowPasskeyForm(false);
    setConfirmDeleteUser(null);
    setShowCreateUser((v) => !v);
  }

  function openEditUser(u: IdentityUser) {
    setShowCreateUser(false);
    setPasswordTarget(null);
    setShowPasskeyForm(false);
    setConfirmDeleteUser(null);
    setEditingUser(u);
    setEditEmail(u.email);
    setEditName(u.displayName);
    setEditRole(u.role || 'member');
    setEditVerified(u.emailVerified);
  }

  function openResetPassword(u: IdentityUser) {
    setShowCreateUser(false);
    setEditingUser(null);
    setShowPasskeyForm(false);
    setConfirmDeleteUser(null);
    setPasswordTarget(u);
    setResetPwd('');
    setResetPwdConfirm('');
  }

  function openRegisterPasskey(targetUser?: IdentityUser | null) {
    setShowCreateUser(false);
    setEditingUser(null);
    setPasswordTarget(null);
    setConfirmDeleteUser(null);
    const chosen = targetUser || primaryAdmin || users[0] || null;
    setPasskeyTargetUserId(chosen?.id || '');
    setPasskeyLabel(
      isZh
        ? `${chosen?.displayName || '管理员'} 通行密钥`
        : `${chosen?.displayName || 'Admin'} Passkey`
    );
    setShowPasskeyForm(true);
  }

  async function handleCreateUserSubmit(e: React.FormEvent) {
    e.preventDefault();
    setActionNotice(null);
    if (!newEmail.trim()) return;
    if (newPassword && newPassword.length < 8) {
      setActionNotice({
        text: isZh ? '密码长度至少 8 位。' : 'Password must be at least 8 characters.',
        isError: true,
      });
      return;
    }
    setCreatingUser(true);
    try {
      await onCreateUser({
        email: newEmail.trim(),
        displayName: newName.trim() || newEmail.trim().split('@')[0],
        password: newPassword,
        role: newRole,
        emailVerified: newVerified,
      });
      setActionNotice({
        text: isZh
          ? `已创建用户「${newEmail.trim()}」（角色：${newRole === 'super_admin' ? '系统管理员' : '普通成员'}）。`
          : `Created user ${newEmail.trim()} (${newRole}).`,
      });
      setNewEmail('');
      setNewName('');
      setNewPassword('');
      setNewRole('member');
      setShowCreateUser(false);
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '创建用户失败' : 'Failed to create user',
        isError: true,
      });
    } finally {
      setCreatingUser(false);
    }
  }

  async function handleUpdateUserSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingUser) return;
    setActionNotice(null);
    setSavingUser(true);
    try {
      await onUpdateUser(editingUser.id, {
        email: editEmail.trim(),
        displayName: editName.trim(),
        role: editRole,
        emailVerified: editVerified,
      });
      setActionNotice({
        text: isZh ? `已更新用户「${editEmail.trim()}」信息。` : `Updated user ${editEmail.trim()}.`,
      });
      setEditingUser(null);
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '更新用户失败' : 'Failed to update user',
        isError: true,
      });
    } finally {
      setSavingUser(false);
    }
  }

  async function handleResetPasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!passwordTarget) return;
    setActionNotice(null);
    if (resetPwd.length < 8) {
      setActionNotice({
        text: isZh ? '新密码长度至少 8 位。' : 'New password must be at least 8 characters.',
        isError: true,
      });
      return;
    }
    if (resetPwd !== resetPwdConfirm) {
      setActionNotice({
        text: isZh ? '两次输入的密码不一致。' : 'Passwords do not match.',
        isError: true,
      });
      return;
    }
    setResettingPwd(true);
    try {
      await onResetUserPassword(passwordTarget.id, resetPwd);
      setActionNotice({
        text: isZh
          ? `已重置「${passwordTarget.email}」的 Argon2id 登录密码。`
          : `Password updated for ${passwordTarget.email}.`,
      });
      setPasswordTarget(null);
      setResetPwd('');
      setResetPwdConfirm('');
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '重置密码失败' : 'Failed to reset password',
        isError: true,
      });
    } finally {
      setResettingPwd(false);
    }
  }

  async function handleRegisterPasskeySubmit(e: React.FormEvent) {
    e.preventDefault();
    setActionNotice(null);
    setRegisteringPasskey(true);
    try {
      await onRegisterPasskey({
        userId: passkeyTargetUserId || undefined,
        label: passkeyLabel.trim() || 'Browser Passkey',
      });
      setActionNotice({
        text: isZh
          ? `Passkey「${passkeyLabel.trim() || 'Browser Passkey'}」已创建并保存到系统数据库，现在可用于登录页验证。`
          : `Passkey "${passkeyLabel.trim() || 'Browser Passkey'}" registered and persisted. You can now use it on the login page.`,
      });
      setShowPasskeyForm(false);
      setPasskeyLabel('');
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '注册 Passkey 失败' : 'Failed to register Passkey',
        isError: true,
      });
    } finally {
      setRegisteringPasskey(false);
    }
  }

  async function handleConfirmDeleteUser() {
    if (!confirmDeleteUser) return;
    const target = confirmDeleteUser;
    setDeletingUserId(target.id);
    setActionNotice(null);
    try {
      await onDeleteUser(target.id);
      setConfirmDeleteUser(null);
      setActionNotice({
        text: isZh ? `已删除用户「${target.email}」及其关联凭据。` : `Deleted user ${target.email}.`,
      });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '删除用户失败' : 'Failed to delete user',
        isError: true,
      });
    } finally {
      setDeletingUserId(null);
    }
  }

  async function handleConfirmDeletePasskey() {
    if (!confirmDeletePasskey) return;
    const target = confirmDeletePasskey;
    setDeletingPasskeyId(target.id);
    setActionNotice(null);
    try {
      await onDeletePasskey(target.id);
      setConfirmDeletePasskey(null);
      setActionNotice({
        text: isZh ? `已吊销 Passkey「${target.label}」。` : `Revoked Passkey "${target.label}".`,
      });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '吊销 Passkey 失败' : 'Failed to revoke Passkey',
        isError: true,
      });
    } finally {
      setDeletingPasskeyId(null);
    }
  }

  async function handleToggleStatus(u: IdentityUser) {
    setTogglingUserId(u.id);
    setActionNotice(null);
    try {
      const next = u.status === 'active' ? 'banned' : 'active';
      await onToggleUserStatus(u.id, next);
      setActionNotice({
        text:
          next === 'banned'
            ? isZh
              ? `已封禁用户「${u.email}」并触发 Webhook 通知。`
              : `Banned ${u.email} and dispatched revocation webhook.`
            : isZh
              ? `已恢复用户「${u.email}」的登录权限。`
              : `Restored access for ${u.email}.`,
      });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '操作失败' : 'Failed to update status',
        isError: true,
      });
    } finally {
      setTogglingUserId(null);
    }
  }

  async function handleUnlink(u: IdentityUser, identityId: string, label: string) {
    setActionNotice(null);
    try {
      await onUnlinkIdentity(u.id, identityId);
      setActionNotice({
        text: isZh ? `已解除「${u.email}」的 ${label} 绑定。` : `Unlinked ${label} from ${u.email}.`,
      });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '解绑失败' : 'Failed to unlink identity',
        isError: true,
      });
    }
  }

  async function handleRunJit(e: React.FormEvent) {
    e.preventDefault();
    setSimulating(true);
    setJitResult(null);
    try {
      const res = await onSimulateJit({
        email: jitEmail.trim(),
        displayName: jitName.trim(),
        provider: jitProvider,
        emailVerified: jitEmailVerified,
      });
      if (res) {
        if (res.action === 'linked_existing_verified_email') {
          setJitResult(
            `Smoothly linked ${jitProvider} onto existing verified account ${res.user.email} (${res.user.id}) — zero duplicate users.`
          );
        } else if (res.action === 'provisioned_new_user') {
          setJitResult(`JIT provisioned new lightweight identity ${res.user.email} (${res.user.id}).`);
        } else {
          setJitResult(`Matched existing identity link on ${res.user.email}.`);
        }
      }
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : 'JIT simulation failed',
        isError: true,
      });
    } finally {
      setSimulating(false);
    }
  }

  async function handleAddWebhook(e: React.FormEvent) {
    e.preventDefault();
    setWhError(null);
    setAddingWh(true);
    try {
      await onCreateWebhook({ name: whName.trim(), targetUrl: whUrl.trim(), signingSecret: whSecret.trim() });
      setWhName('');
      setWhUrl('');
      setWhSecret('');
      setActionNotice({ text: isZh ? 'Webhook 接收端已添加。' : 'Webhook endpoint added.' });
    } catch (err) {
      setWhError(err instanceof Error ? err.message : 'Failed to create webhook');
    } finally {
      setAddingWh(false);
    }
  }

  async function handleConfirmDeleteWebhook() {
    if (!confirmDeleteWebhook) return;
    const target = confirmDeleteWebhook;
    setDeletingWebhookId(target.id);
    setActionNotice(null);
    try {
      await onDeleteWebhook(target.id);
      setConfirmDeleteWebhook(null);
      setActionNotice({
        text: isZh ? `已删除 Webhook「${target.name}」。` : `Deleted webhook "${target.name}".`,
      });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '删除 Webhook 失败' : 'Failed to delete webhook',
        isError: true,
      });
    } finally {
      setDeletingWebhookId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t.usersTitle}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 i18n-safe">
            {t.usersSubtitle}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <button
            type="button"
            onClick={() => openRegisterPasskey(primaryAdmin)}
            className="min-h-[40px] px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-100 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors"
          >
            <Fingerprint className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <span>{isZh ? '注册 Passkey' : 'Register Passkey'}</span>
          </button>
          <button
            type="button"
            onClick={openCreateUser}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>{isZh ? '新建用户' : 'Create User'}</span>
          </button>
        </div>
      </div>

      {/* Action Feedback Notice */}
      {actionNotice && (
        <div
          role={actionNotice.isError ? 'alert' : 'status'}
          className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border text-xs ${
            actionNotice.isError
              ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/60 text-red-800 dark:text-red-300'
              : 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/60 text-emerald-800 dark:text-emerald-300'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            {actionNotice.isError ? (
              <AlertCircle className="w-4 h-4 shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            )}
            <span className="leading-relaxed">{actionNotice.text}</span>
          </div>
          <button
            type="button"
            aria-label="Dismiss notice"
            onClick={() => setActionNotice(null)}
            className="p-1 opacity-70 hover:opacity-100 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* System Administrator Account Card */}
      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                {isZh ? '系统管理员账号（Super Admin）' : 'System Administrator Account'}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {isZh
                  ? '首次初始化向导创建的超级管理员账号持久化在系统 users 表中（role = super_admin），可在此修改密码或绑定 Passkey。'
                  : 'Super administrator accounts created during setup are persisted in the users table (role = super_admin). Manage passwords and WebAuthn Passkeys here.'}
              </p>
            </div>
          </div>
          <div className="text-xs font-mono text-slate-500 dark:text-slate-400 tabular-nums shrink-0">
            {adminUsers.length} {isZh ? '位管理员' : 'admin(s)'} · {passkeys.length} Passkey(s)
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {adminUsers.map((admin) => {
            const isSelf = currentUser?.email.toLowerCase() === admin.email.toLowerCase();
            return (
              <div
                key={admin.id}
                className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F19] flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                      {admin.displayName}
                    </span>
                    {isSelf && (
                      <span className="text-[11px] font-medium text-indigo-600 dark:text-indigo-400">
                        · {isZh ? '当前登录' : 'Current session'}
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-mono text-slate-600 dark:text-slate-300 truncate">
                    {admin.email}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-2 font-mono">
                    <span>{admin.passwordAlgo}</span>
                    <span>·</span>
                    <span className="tabular-nums">Passkeys: {admin.passkeyCount}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => openResetPassword(admin)}
                    className="px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 inline-flex items-center gap-1"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>{isZh ? '修改密码' : 'Password'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openRegisterPasskey(admin)}
                    className="px-2.5 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium inline-flex items-center gap-1"
                  >
                    <Fingerprint className="w-3.5 h-3.5" />
                    <span>{isZh ? '绑定 Passkey' : 'Add Passkey'}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Inline Delete User Confirmation Banner */}
      {confirmDeleteUser && (
        <div
          role="alertdialog"
          aria-label="Confirm delete user"
          className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/60 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <div className="space-y-1 text-xs">
            <div className="font-semibold text-red-900 dark:text-red-200 text-sm flex items-center gap-1.5">
              <Trash2 className="w-4 h-4 shrink-0" />
              <span>
                {isZh
                  ? `确认永久删除用户「${confirmDeleteUser.displayName} (${confirmDeleteUser.email})」？`
                  : `Permanently delete user ${confirmDeleteUser.email}?`}
              </span>
            </div>
            <p className="text-red-800/90 dark:text-red-300/90 leading-relaxed">
              {isZh
                ? '删除后将同步移除该用户的社交绑定记录与所有已保存的 Passkey，此操作不可撤销。'
                : 'This will remove the user account, linked social identities, and all saved Passkeys permanently.'}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setConfirmDeleteUser(null)}
              className="px-3.5 py-2 rounded-lg border border-red-200 dark:border-red-800 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200"
            >
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button
              type="button"
              disabled={deletingUserId === confirmDeleteUser.id}
              onClick={() => void handleConfirmDeleteUser()}
              className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-medium inline-flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>
                {deletingUserId === confirmDeleteUser.id
                  ? isZh
                    ? '删除中...'
                    : 'Deleting...'
                  : isZh
                    ? '确认删除用户'
                    : 'Confirm Delete'}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Inline Delete Passkey Confirmation Banner */}
      {confirmDeletePasskey && (
        <div
          role="alertdialog"
          aria-label="Confirm revoke passkey"
          className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/60 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <div className="space-y-1 text-xs">
            <div className="font-semibold text-red-900 dark:text-red-200 text-sm flex items-center gap-1.5">
              <Fingerprint className="w-4 h-4 shrink-0" />
              <span>
                {isZh
                  ? `确认吊销 Passkey「${confirmDeletePasskey.label}」？`
                  : `Revoke Passkey "${confirmDeletePasskey.label}"?`}
              </span>
            </div>
            <p className="text-red-800/90 dark:text-red-300/90">
              {isZh
                ? `所属账户：${confirmDeletePasskey.userEmail} · 吊销后该设备无法再通过此 Passkey 免密登录。`
                : `Account: ${confirmDeletePasskey.userEmail} — this device will no longer be able to sign in using this Passkey.`}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setConfirmDeletePasskey(null)}
              className="px-3.5 py-2 rounded-lg border border-red-200 dark:border-red-800 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200"
            >
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button
              type="button"
              disabled={deletingPasskeyId === confirmDeletePasskey.id}
              onClick={() => void handleConfirmDeletePasskey()}
              className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-medium inline-flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>
                {deletingPasskeyId === confirmDeletePasskey.id
                  ? isZh
                    ? '吊销中...'
                    : 'Revoking...'
                  : isZh
                    ? '确认吊销'
                    : 'Revoke Passkey'}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Register WebAuthn Passkey Panel */}
      {showPasskeyForm && (
        <form
          onSubmit={handleRegisterPasskeySubmit}
          className="bg-white dark:bg-[#111827] border border-indigo-200 dark:border-indigo-900/70 rounded-xl p-6 space-y-4"
        >
          <div className="flex items-center justify-between gap-3 pb-2 border-b border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <Fingerprint className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                {isZh ? '创建并保存 WebAuthn Passkey 到系统' : 'Create & Save WebAuthn Passkey'}
              </h2>
            </div>
            <button
              type="button"
              aria-label="Close passkey registration"
              onClick={() => setShowPasskeyForm(false)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            {isZh
              ? '点击下方按钮将调用浏览器原生 WebAuthn（TouchID / FaceID / Windows Hello / 安全密钥）生成非对称密钥对，并将公钥持久化保存到系统数据库。需在 HTTPS 或 localhost 安全上下文中运行。'
              : 'This triggers your browser WebAuthn authenticator (TouchID / FaceID / Windows Hello / YubiKey) and saves the public key in the system database. Requires HTTPS or localhost.'}
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="pk-user" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {isZh ? '绑定用户账号' : 'Target User Account'}
              </label>
              <select
                id="pk-user"
                value={passkeyTargetUserId}
                onChange={(e) => setPasskeyTargetUserId(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName} ({u.email}) — {u.role === 'super_admin' ? 'Super Admin' : 'Member'}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="pk-label" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {isZh ? '设备备注名称' : 'Authenticator Label'}
              </label>
              <input
                id="pk-label"
                type="text"
                required
                value={passkeyLabel}
                onChange={(e) => setPasskeyLabel(e.target.value)}
                placeholder="e.g. MacBook TouchID / YubiKey 5C"
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowPasskeyForm(false)}
              className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700"
            >
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={registeringPasskey}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white inline-flex items-center gap-1.5"
            >
              <Fingerprint className="w-3.5 h-3.5" />
              <span>
                {registeringPasskey
                  ? isZh
                    ? '等待设备验证...'
                    : 'Waiting for authenticator...'
                  : isZh
                    ? '调用设备创建并保存 Passkey'
                    : 'Create & Save Passkey'}
              </span>
            </button>
          </div>
        </form>
      )}

      {/* Create User Panel */}
      {showCreateUser && (
        <form
          onSubmit={handleCreateUserSubmit}
          className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4"
        >
          <div className="flex items-center justify-between gap-3 pb-2 border-b border-slate-100 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              {isZh ? '新建系统用户 / 管理员' : 'Create User Account'}
            </h2>
            <button
              type="button"
              aria-label="Close create user"
              onClick={() => setShowCreateUser(false)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="create-user-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {isZh ? '邮箱地址' : 'Email Address'}
              </label>
              <input
                id="create-user-email"
                type="email"
                required
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="alice@company.com"
                className="w-full min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label htmlFor="create-user-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {isZh ? '显示名称' : 'Display Name'}
              </label>
              <input
                id="create-user-name"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Alice Chen"
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label htmlFor="create-user-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {isZh ? '初始密码（Argon2id 哈希，至少 8 位，留空则无本地密码）' : 'Initial Password (min 8 chars, optional)'}
              </label>
              <input
                id="create-user-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label htmlFor="create-user-role" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {isZh ? '账号角色' : 'Account Role'}
              </label>
              <select
                id="create-user-role"
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as 'super_admin' | 'member')}
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value="member">{isZh ? '普通用户（Member — 仅业务应用 OIDC 登录）' : 'Member (OIDC Business Apps)'}</option>
                <option value="super_admin">{isZh ? '系统管理员（Super Admin — 可管理后台）' : 'Super Admin (Console Access)'}</option>
              </select>
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={newVerified}
              onChange={(e) => setNewVerified(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-indigo-600"
            />
            <span>{isZh ? '标记邮箱已验证（email_verified = true）' : 'Mark email as verified (email_verified = true)'}</span>
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setShowCreateUser(false)}
              className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700"
            >
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={creatingUser}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white"
            >
              {creatingUser ? '...' : isZh ? '创建用户' : 'Create User'}
            </button>
          </div>
        </form>
      )}

      {/* Edit User Panel */}
      {editingUser && (
        <form
          onSubmit={handleUpdateUserSubmit}
          className="bg-white dark:bg-[#111827] border border-indigo-200 dark:border-indigo-900/70 rounded-xl p-6 space-y-4"
        >
          <div className="flex items-center justify-between gap-3 pb-2 border-b border-slate-100 dark:border-slate-800">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                {isZh ? `编辑用户：${editingUser.displayName}` : `Edit User: ${editingUser.displayName}`}
              </h2>
              <p className="text-[11px] font-mono text-slate-500 mt-0.5">{editingUser.id}</p>
            </div>
            <button
              type="button"
              aria-label="Close edit user"
              onClick={() => setEditingUser(null)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="edit-user-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {isZh ? '显示名称' : 'Display Name'}
              </label>
              <input
                id="edit-user-name"
                type="text"
                required
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label htmlFor="edit-user-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {isZh ? '邮箱地址' : 'Email Address'}
              </label>
              <input
                id="edit-user-email"
                type="email"
                required
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label htmlFor="edit-user-role" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {isZh ? '账号角色' : 'Role'}
              </label>
              <select
                id="edit-user-role"
                value={editRole}
                onChange={(e) => setEditRole(e.target.value as 'super_admin' | 'member')}
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value="member">Member</option>
                <option value="super_admin">Super Admin</option>
              </select>
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={editVerified}
              onChange={(e) => setEditVerified(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-indigo-600"
            />
            <span>{isZh ? '邮箱已验证（email_verified）' : 'Email verified'}</span>
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setEditingUser(null)}
              className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700"
            >
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={savingUser}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white"
            >
              {savingUser ? '...' : isZh ? '保存修改' : 'Save Changes'}
            </button>
          </div>
        </form>
      )}

      {/* Reset Password Panel */}
      {passwordTarget && (
        <form
          onSubmit={handleResetPasswordSubmit}
          className="bg-white dark:bg-[#111827] border border-amber-200 dark:border-amber-900/70 rounded-xl p-6 space-y-4"
        >
          <div className="flex items-center justify-between gap-3 pb-2 border-b border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                {isZh ? `设置 / 重置登录密码：${passwordTarget.email}` : `Set / Reset Password: ${passwordTarget.email}`}
              </h2>
            </div>
            <button
              type="button"
              aria-label="Close reset password"
              onClick={() => setPasswordTarget(null)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="reset-pwd-1" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {isZh ? '新密码（至少 8 位）' : 'New Password (min 8 chars)'}
              </label>
              <input
                id="reset-pwd-1"
                type="password"
                required
                minLength={8}
                value={resetPwd}
                onChange={(e) => setResetPwd(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label htmlFor="reset-pwd-2" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {isZh ? '确认新密码' : 'Confirm New Password'}
              </label>
              <input
                id="reset-pwd-2"
                type="password"
                required
                minLength={8}
                value={resetPwdConfirm}
                onChange={(e) => setResetPwdConfirm(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setPasswordTarget(null)}
              className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700"
            >
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={resettingPwd}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white"
            >
              {resettingPwd ? '...' : isZh ? '确认更新密码' : 'Update Password'}
            </button>
          </div>
        </form>
      )}

      {/* User Management Directory Table (`users` + `user_identities`) */}
      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              {isZh ? `用户与身份目录（${users.length}）` : `Users & Linked Identities (${users.length})`}
            </h2>
            <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
              tables: users · user_identities · passkey_credentials
            </p>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={isZh ? '搜索邮箱、姓名或角色...' : 'Search email, name, role...'}
              aria-label="Search users"
              className="w-full min-h-[36px] pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-900/40">
                <th className="py-3 px-4">{isZh ? '用户 / 角色' : 'User / Role'}</th>
                <th className="py-3 px-4">{isZh ? '绑定渠道' : 'Linked Channels'}</th>
                <th className="py-3 px-4">{isZh ? '认证因子' : 'Security Factors'}</th>
                <th className="py-3 px-4">{isZh ? '状态' : 'Status'}</th>
                <th className="py-3 px-4 text-right whitespace-nowrap">{isZh ? '管理操作' : 'Actions'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-xs">
              {filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-slate-500 dark:text-slate-400">
                    {isZh ? '没有匹配的用户记录。' : 'No matching users found.'}
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => {
                  const isSelf = currentUser?.email.toLowerCase() === u.email.toLowerCase();
                  const isLastActiveAdmin = u.role === 'super_admin' && u.status === 'active' && activeAdminCount <= 1;
                  const deleteBlocked = isSelf || isLastActiveAdmin;

                  return (
                    <tr key={u.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                      <td className="py-3.5 px-4 align-top">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm text-slate-900 dark:text-white">{u.displayName}</span>
                          <span
                            className={`text-[11px] font-medium ${
                              u.role === 'super_admin'
                                ? 'text-indigo-600 dark:text-indigo-400'
                                : 'text-slate-500 dark:text-slate-400'
                            }`}
                          >
                            {u.role === 'super_admin' ? 'Super Admin' : 'Member'}
                          </span>
                        </div>
                        <div className="font-mono text-slate-600 dark:text-slate-400">{u.email}</div>
                        <div className="mt-0.5 text-[11px] font-mono text-slate-400">
                          {u.id} · {u.emailVerified ? 'email_verified' : 'unverified'}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 align-top">
                        <div className="space-y-1 text-slate-700 dark:text-slate-300">
                          {u.identities.length === 0 ? (
                            <span className="text-slate-400">—</span>
                          ) : (
                            u.identities.map((ident) => (
                              <div key={ident.id} className="flex items-center gap-1.5">
                                <span className="font-medium">{ident.providerLabel}</span>
                                <span className="text-slate-400">·</span>
                                <code className="font-mono text-[11px] text-slate-500 truncate max-w-[140px]">
                                  {ident.providerSub}
                                </code>
                                {u.identities.length > 1 && (
                                  <button
                                    type="button"
                                    title={isZh ? '解除绑定' : 'Unlink identity'}
                                    aria-label={`Unlink ${ident.providerLabel} from ${u.email}`}
                                    onClick={() => void handleUnlink(u, ident.id, ident.providerLabel)}
                                    className="p-0.5 text-slate-400 hover:text-red-600 transition-colors"
                                  >
                                    <Unlink className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                            ))
                          )}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 align-top space-y-1 text-slate-600 dark:text-slate-400">
                        <div className="flex items-center gap-1.5">
                          <KeyRound className="w-3.5 h-3.5 text-slate-400" />
                          <span>{u.passwordAlgo === 'none' ? (isZh ? '未设密码' : 'No password') : u.passwordAlgo}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <ShieldAlert className="w-3.5 h-3.5 text-slate-400" />
                          <span>TOTP: {u.totpEnabled ? 'ON' : 'OFF'}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Fingerprint className="w-3.5 h-3.5 text-slate-400" />
                          <span className="tabular-nums">Passkeys: {u.passkeyCount}</span>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 align-top">
                        <span
                          className={`font-medium ${
                            u.status === 'active'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-red-600 dark:text-red-400'
                          }`}
                        >
                          {u.status === 'active' ? (isZh ? '正常' : 'Active') : isZh ? '已封禁' : 'Banned'}
                        </span>
                      </td>

                      <td className="py-3.5 px-4 align-top text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            title={isZh ? '编辑用户' : 'Edit user'}
                            aria-label={`Edit ${u.email}`}
                            onClick={() => openEditUser(u)}
                            className="p-1.5 rounded-md text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            title={isZh ? '设置/重置密码' : 'Set / Reset password'}
                            aria-label={`Reset password for ${u.email}`}
                            onClick={() => openResetPassword(u)}
                            className="p-1.5 rounded-md text-slate-500 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/40 transition-colors"
                          >
                            <KeyRound className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            title={isZh ? '绑定 Passkey' : 'Register Passkey'}
                            aria-label={`Register Passkey for ${u.email}`}
                            onClick={() => openRegisterPasskey(u)}
                            className="p-1.5 rounded-md text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors"
                          >
                            <Fingerprint className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={togglingUserId === u.id || (u.status === 'active' && isLastActiveAdmin)}
                            title={
                              u.status === 'active'
                                ? isZh
                                  ? '封禁并推送 Webhook'
                                  : 'Ban & Push Webhook'
                                : isZh
                                  ? '恢复访问'
                                  : 'Restore Access'
                            }
                            onClick={() => void handleToggleStatus(u)}
                            className={`px-2 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1 whitespace-nowrap transition-colors disabled:opacity-40 ${
                              u.status === 'active'
                                ? 'border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40'
                                : 'border border-emerald-200 dark:border-emerald-900/60 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40'
                            }`}
                          >
                            {u.status === 'active' ? <Ban className="w-3 h-3" /> : <RotateCcw className="w-3 h-3" />}
                            <span>{u.status === 'active' ? (isZh ? '封禁' : 'Ban') : isZh ? '恢复' : 'Restore'}</span>
                          </button>
                          <button
                            type="button"
                            disabled={deleteBlocked}
                            title={
                              deleteBlocked
                                ? isZh
                                  ? '不能删除当前登录账号或唯一活跃管理员'
                                  : 'Cannot delete current session or last active admin'
                                : isZh
                                  ? '删除用户'
                                  : 'Delete user'
                            }
                            aria-label={`Delete ${u.email}`}
                            onClick={() => {
                              setShowCreateUser(false);
                              setEditingUser(null);
                              setPasswordTarget(null);
                              setConfirmDeleteUser(u);
                            }}
                            className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-30 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Registered WebAuthn Passkeys Table (`passkey_credentials`) */}
      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Fingerprint className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                {isZh ? `已保存的 WebAuthn Passkeys（${passkeys.length}）` : `Saved WebAuthn Passkeys (${passkeys.length})`}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {isZh
                  ? '登录页 Passkey 登录严格校验此处保存的公钥与硬件签名，未注册时不允许免密登录。'
                  : 'Login page Passkey sign-in strictly verifies signatures against public keys saved here.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => openRegisterPasskey(primaryAdmin)}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium inline-flex items-center gap-1.5 self-start sm:self-auto"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{isZh ? '添加 Passkey' : 'Add Passkey'}</span>
          </button>
        </div>

        {passkeys.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400 space-y-3">
            <p>
              {isZh
                ? '系统中暂无已注册的 Passkey。登录页的 Passkey 认证将拒绝所有未注册凭据，直到你在此创建并保存 Passkey。'
                : 'No Passkeys are registered yet. Passkey sign-in on the login page is blocked until a credential is registered here.'}
            </p>
            <button
              type="button"
              onClick={() => openRegisterPasskey(primaryAdmin)}
              className="px-3.5 py-2 rounded-lg border border-indigo-200 dark:border-indigo-900/60 text-indigo-700 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 font-medium inline-flex items-center gap-1.5"
            >
              <Fingerprint className="w-3.5 h-3.5" />
              <span>{isZh ? '为管理员注册第一个 Passkey' : 'Register first Passkey for Admin'}</span>
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-900/40">
                  <th className="py-2.5 px-4">{isZh ? '设备名称' : 'Label'}</th>
                  <th className="py-2.5 px-4">{isZh ? '所属用户' : 'Owner'}</th>
                  <th className="py-2.5 px-4">RP ID / Credential ID</th>
                  <th className="py-2.5 px-4">{isZh ? '算法 / 计数' : 'Alg / SignCount'}</th>
                  <th className="py-2.5 px-4 text-right">{isZh ? '操作' : 'Action'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-xs">
                {passkeys.map((pk) => (
                  <tr key={pk.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                    <td className="py-3 px-4 font-medium text-slate-900 dark:text-white">{pk.label}</td>
                    <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-300">{pk.userEmail}</td>
                    <td className="py-3 px-4 font-mono text-[11px] text-slate-500">
                      <div>{pk.rpId}</div>
                      <div className="truncate max-w-[200px]" title={pk.credentialId}>
                        {pk.credentialId}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-500">
                      {pk.algorithm === -257 ? 'RS256' : 'ES256'} · #{pk.signCount}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => setConfirmDeletePasskey(pk)}
                        className="px-2.5 py-1 rounded-md border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 text-xs font-medium inline-flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>{isZh ? '吊销' : 'Revoke'}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* JIT + Verified-Email Account Linking Simulator */}
      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              JIT Sync &amp; Verified-Email Legacy Account Linking Test
            </h2>
          </div>
          <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
            Auto-link verified email: {jitAutoLinkEnabled ? 'ON' : 'OFF'}
          </span>
        </div>

        <form onSubmit={handleRunJit} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          <div className="md:col-span-4">
            <label htmlFor="jit-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              User Email
            </label>
            <input
              id="jit-email"
              type="email"
              required
              value={jitEmail}
              onChange={(e) => setJitEmail(e.target.value)}
              placeholder="user@example.com"
              className="w-full min-h-[38px] px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
          </div>

          <div className="md:col-span-3">
            <label htmlFor="jit-provider" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Upstream Login Channel
            </label>
            <select
              id="jit-provider"
              value={jitProvider}
              onChange={(e) => setJitProvider(e.target.value as IdentityProviderType)}
              className="w-full min-h-[38px] px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            >
              <option value="microsoft">Microsoft (Entra ID)</option>
              <option value="google">Google</option>
              <option value="wechat">微信 WeChat</option>
              <option value="apple">Apple</option>
              <option value="github">GitHub</option>
            </select>
          </div>

          <div className="md:col-span-2 flex items-center gap-2 min-h-[38px]">
            <input
              id="jit-verified"
              type="checkbox"
              checked={jitEmailVerified}
              onChange={(e) => setJitEmailVerified(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-indigo-600"
            />
            <label htmlFor="jit-verified" className="text-xs text-slate-700 dark:text-slate-300">
              email_verified
            </label>
          </div>

          <div className="md:col-span-3">
            <button
              type="submit"
              disabled={simulating}
              className="w-full min-h-[38px] px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-medium flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>{simulating ? '...' : 'Simulate JIT / Link'}</span>
            </button>
          </div>
        </form>

        {jitResult && (
          <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400 bg-emerald-50/80 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 rounded-lg px-3.5 py-2.5">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{jitResult}</span>
          </div>
        )}
      </section>

      {/* Account Ban / Session Revocation Webhooks */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Webhook className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Account Ban Webhooks (Downstream Session Kick)
            </h2>
          </div>

          {confirmDeleteWebhook && (
            <div
              role="alertdialog"
              aria-label="Confirm delete webhook"
              className="p-3.5 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/60 flex items-center justify-between gap-3 text-xs"
            >
              <span className="text-red-900 dark:text-red-200 font-medium">
                {isZh
                  ? `确认删除 Webhook「${confirmDeleteWebhook.name}」？`
                  : `Delete webhook "${confirmDeleteWebhook.name}"?`}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setConfirmDeleteWebhook(null)}
                  className="px-2.5 py-1 rounded border border-red-200 dark:border-red-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
                >
                  {isZh ? '取消' : 'Cancel'}
                </button>
                <button
                  type="button"
                  disabled={deletingWebhookId === confirmDeleteWebhook.id}
                  onClick={() => void handleConfirmDeleteWebhook()}
                  className="px-2.5 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-medium disabled:opacity-60"
                >
                  {deletingWebhookId === confirmDeleteWebhook.id ? '...' : isZh ? '确认删除' : 'Delete'}
                </button>
              </div>
            </div>
          )}

          <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
            {webhooks.length === 0 ? (
              <div className="py-4 text-slate-500 dark:text-slate-400 text-center">
                {isZh ? '暂未配置 Webhook 接收端。' : 'No webhook endpoints configured yet.'}
              </div>
            ) : (
              webhooks.map((wh) => (
                <div key={wh.id} className="py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 dark:text-white">{wh.name}</div>
                    <div className="font-mono text-slate-500 truncate">{wh.targetUrl}</div>
                    <div className="mt-0.5 text-[11px] font-mono text-slate-400">
                      events: {wh.events.join(', ')} · secret: {wh.secretMasked}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Delete webhook ${wh.name}`}
                    onClick={() => setConfirmDeleteWebhook(wh)}
                    className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>

          <form onSubmit={handleAddWebhook} className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text"
                required
                value={whName}
                onChange={(e) => setWhName(e.target.value)}
                placeholder="Downstream App Name"
                aria-label="Webhook Name"
                className="min-h-[38px] px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <input
                type="password"
                value={whSecret}
                onChange={(e) => setWhSecret(e.target.value)}
                placeholder="HMAC Secret (auto if blank)"
                aria-label="Webhook Signing Secret"
                className="min-h-[38px] px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div className="flex gap-2">
              <input
                type="url"
                required
                value={whUrl}
                onChange={(e) => setWhUrl(e.target.value)}
                placeholder="https://app.company.com/webhooks/oauth"
                aria-label="Webhook Target URL"
                className="flex-1 min-w-0 min-h-[38px] px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <button
                type="submit"
                disabled={addingWh}
                className="px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium whitespace-nowrap disabled:opacity-60"
              >
                {addingWh ? '...' : 'Add Endpoint'}
              </button>
            </div>
            {whError && (
              <div role="alert" className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{whError}</span>
              </div>
            )}
          </form>
        </section>

        {/* Signed Delivery Log */}
        <section className="lg:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Recent Signed Webhook Deliveries
            </h2>
            <span className="text-xs font-mono text-slate-500">X-Wimotek-Signature-256</span>
          </div>

          {webhookLogs.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 py-8 text-center">
              {isZh
                ? '点击上方任意用户的「封禁」按钮即可触发带 HMAC-SHA256 签名的 user.banned 通知。'
                : 'Click Ban on any user above to dispatch a signed user.banned event.'}
            </p>
          ) : (
            <div className="space-y-3 max-h-72 overflow-y-auto">
              {webhookLogs.map((log) => (
                <div
                  key={log.id}
                  className="p-3 rounded-lg bg-slate-50 dark:bg-[#0B0F19] border border-slate-200 dark:border-slate-800 text-xs space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2 font-mono">
                    <span className="font-semibold text-red-600 dark:text-red-400">{log.event}</span>
                    <span className="text-slate-500">{log.userEmail}</span>
                  </div>
                  <div className="font-mono text-[11px] text-slate-500 truncate">POST {log.targetUrl}</div>
                  <div className="font-mono text-[11px] text-indigo-600 dark:text-indigo-400 truncate">
                    {log.signatureHeader}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
