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
  HelpCircle,
  Copy,
  Check,
  ChevronRight,
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

type FactorTab = 'passkeys' | 'password' | 'totp';
type RoleFilter = 'all' | 'super_admin' | 'member';

interface TotpEnrollmentDraft {
  secret: string;
  otpauthUri: string;
  currentCode: string;
  recoveryCodes: string[];
}

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
  onClearUserPassword: (userId: string) => Promise<void>;
  onEnrollUserTotp: (userId: string) => Promise<TotpEnrollmentDraft>;
  onVerifyUserTotp: (userId: string, code: string) => Promise<void>;
  onDisableUserTotp: (userId: string) => Promise<void>;
  onDeleteUser: (userId: string) => Promise<void>;
  onUnlinkIdentity: (userId: string, identityId: string) => Promise<void>;
  onToggleUserStatus: (userId: string, nextStatus: 'active' | 'banned') => Promise<void>;
  onRegisterPasskey: (payload: { userId?: string; label: string }) => Promise<void>;
  onDeletePasskey: (credentialId: string) => Promise<void>;
  onCreateWebhook: (payload: { name: string; targetUrl: string; signingSecret: string }) => Promise<void>;
  onDeleteWebhook: (id: string) => Promise<void>;
}

const WEBHOOK_PAYLOAD_EXAMPLE = `{
  "event": "user.banned",
  "userId": "usr_a1b2c3d4",
  "email": "alice@company.com",
  "timestamp": "2026-11-26T08:30:00Z"
}`;

const WEBHOOK_NODE_EXAMPLE = `import crypto from 'node:crypto';
import express from 'express';

const app = express();
const SECRET = process.env.OAUTH_WEBHOOK_SECRET; // 与此处填写的 HMAC Secret 一致

app.post('/webhooks/oauth', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.header('X-Wimotek-Signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(req.body).digest('hex');

  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(401).send('Invalid signature');
  }

  const event = JSON.parse(req.body.toString('utf8'));
  if (event.event === 'user.banned') {
    // 在此清理你业务系统里该用户的本地登录态（如 Redis Session / Cookie）
    console.log('Kick user session:', event.userId, event.email);
  }
  res.status(200).json({ received: true });
});`;

const WEBHOOK_GO_EXAMPLE = `func handleOAuthWebhook(w http.ResponseWriter, r *http.Request) {
    body, _ := io.ReadAll(r.Body)
    sig := r.Header.Get("X-Wimotek-Signature-256")

    mac := hmac.New(sha256.New, []byte(os.Getenv("OAUTH_WEBHOOK_SECRET")))
    mac.Write(body)
    expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
    if !hmac.Equal([]byte(sig), []byte(expected)) {
        http.Error(w, "invalid signature", http.StatusUnauthorized)
        return
    }

    var evt struct {
        Event  string \`json:"event"\`
        UserID string \`json:"userId"\`
        Email  string \`json:"email"\`
    }
    _ = json.Unmarshal(body, &evt)
    if evt.Event == "user.banned" {
        // 清理该用户在本业务系统的 Session，实现立即强制下线
        revokeLocalSession(evt.UserID)
    }
    w.WriteHeader(http.StatusOK)
}`;

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
  onClearUserPassword,
  onEnrollUserTotp,
  onVerifyUserTotp,
  onDisableUserTotp,
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
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [actionNotice, setActionNotice] = useState<{ text: string; isError?: boolean } | null>(null);
  const [showFactorsHelp, setShowFactorsHelp] = useState(false);

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

  // Unified per-user Security Factors Manager panel (Passkeys / Password / TOTP)
  const [factorUserId, setFactorUserId] = useState<string | null>(null);
  const [factorTab, setFactorTab] = useState<FactorTab>('passkeys');

  // Passkey state inside factor manager
  const [passkeyLabel, setPasskeyLabel] = useState('');
  const [registeringPasskey, setRegisteringPasskey] = useState(false);
  const [confirmDeletePasskey, setConfirmDeletePasskey] = useState<PasskeyCredential | null>(null);
  const [deletingPasskeyId, setDeletingPasskeyId] = useState<string | null>(null);

  // Password state inside factor manager
  const [resetPwd, setResetPwd] = useState('');
  const [resetPwdConfirm, setResetPwdConfirm] = useState('');
  const [savingPwd, setSavingPwd] = useState(false);
  const [confirmClearPwd, setConfirmClearPwd] = useState(false);

  // TOTP state inside factor manager
  const [totpDraft, setTotpDraft] = useState<TotpEnrollmentDraft | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpBusy, setTotpBusy] = useState(false);
  const [confirmDisableTotp, setConfirmDisableTotp] = useState(false);

  // Inline confirmation banners (iframe-safe, no window.confirm)
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<IdentityUser | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
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

  // Webhook form & interactive beginner guide state
  const [showWebhookGuide, setShowWebhookGuide] = useState(false);
  const [webhookLang, setWebhookLang] = useState<'node' | 'go'>('node');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
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

  const factorUser = useMemo(
    () => (factorUserId ? users.find((u) => u.id === factorUserId) || null : null),
    [users, factorUserId]
  );

  const factorUserPasskeys = useMemo(
    () => (factorUser ? passkeys.filter((pk) => pk.userId === factorUser.id) : []),
    [passkeys, factorUser]
  );

  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter === 'super_admin' && u.role !== 'super_admin') return false;
      if (roleFilter === 'member' && u.role === 'super_admin') return false;
      if (!q) return true;
      return (
        u.email.toLowerCase().includes(q) ||
        u.displayName.toLowerCase().includes(q) ||
        u.id.toLowerCase().includes(q) ||
        (u.role || 'member').toLowerCase().includes(q)
      );
    });
  }, [users, searchQuery, roleFilter]);

  function copySnippet(key: string, text: string) {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1800);
  }

  function openCreateUser() {
    setEditingUser(null);
    setFactorUserId(null);
    setConfirmDeleteUser(null);
    setShowCreateUser((v) => !v);
  }

  function openEditUser(u: IdentityUser) {
    setShowCreateUser(false);
    setFactorUserId(null);
    setConfirmDeleteUser(null);
    setEditingUser(u);
    setEditEmail(u.email);
    setEditName(u.displayName);
    setEditRole(u.role || 'member');
    setEditVerified(u.emailVerified);
  }

  function openFactorManager(u: IdentityUser, tab: FactorTab) {
    setShowCreateUser(false);
    setEditingUser(null);
    setConfirmDeleteUser(null);
    setConfirmDeletePasskey(null);
    setConfirmClearPwd(false);
    setConfirmDisableTotp(false);
    setTotpDraft(null);
    setTotpCode('');
    setResetPwd('');
    setResetPwdConfirm('');
    setPasskeyLabel(isZh ? `${u.displayName} 设备通行密钥` : `${u.displayName} Passkey`);
    setFactorUserId(u.id);
    setFactorTab(tab);
  }

  async function handleCreateUserSubmit(e: React.FormEvent) {
    e.preventDefault();
    setActionNotice(null);
    if (!newEmail.trim()) return;
    if (newRole === 'super_admin' && newPassword.length < 8) {
      setActionNotice({
        text: isZh
          ? '系统管理员账号必须设置至少 8 位密码。'
          : 'Super Admin accounts require a password of at least 8 characters.',
        isError: true,
      });
      return;
    }
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
    if (!factorUser) return;
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
    setSavingPwd(true);
    try {
      await onResetUserPassword(factorUser.id, resetPwd);
      setActionNotice({
        text: isZh
          ? `已更新「${factorUser.email}」的 Argon2id 登录密码。`
          : `Password updated for ${factorUser.email}.`,
      });
      setResetPwd('');
      setResetPwdConfirm('');
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '更新密码失败' : 'Failed to update password',
        isError: true,
      });
    } finally {
      setSavingPwd(false);
    }
  }

  async function handleConfirmClearPassword() {
    if (!factorUser) return;
    setSavingPwd(true);
    setActionNotice(null);
    try {
      await onClearUserPassword(factorUser.id);
      setConfirmClearPwd(false);
      setActionNotice({
        text: isZh
          ? `已清除「${factorUser.email}」的本地密码（该用户将只能通过 Passkey、邮箱验证码或第三方账号登录）。`
          : `Cleared local password for ${factorUser.email}.`,
      });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '清除密码失败' : 'Failed to clear password',
        isError: true,
      });
    } finally {
      setSavingPwd(false);
    }
  }

  async function handleStartTotpEnroll() {
    if (!factorUser) return;
    setTotpBusy(true);
    setActionNotice(null);
    try {
      const data = await onEnrollUserTotp(factorUser.id);
      setTotpDraft(data);
      setTotpCode('');
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '生成 TOTP 密钥失败' : 'Failed to generate TOTP secret',
        isError: true,
      });
    } finally {
      setTotpBusy(false);
    }
  }

  async function handleVerifyTotpSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!factorUser) return;
    setTotpBusy(true);
    setActionNotice(null);
    try {
      await onVerifyUserTotp(factorUser.id, totpCode.trim());
      setTotpDraft(null);
      setTotpCode('');
      setActionNotice({
        text: isZh
          ? `已为「${factorUser.email}」开启 TOTP 动态口令（2FA）。`
          : `Enabled TOTP 2FA for ${factorUser.email}.`,
      });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '验证码校验失败' : 'TOTP verification failed',
        isError: true,
      });
    } finally {
      setTotpBusy(false);
    }
  }

  async function handleConfirmDisableTotp() {
    if (!factorUser) return;
    setTotpBusy(true);
    setActionNotice(null);
    try {
      await onDisableUserTotp(factorUser.id);
      setConfirmDisableTotp(false);
      setTotpDraft(null);
      setActionNotice({
        text: isZh
          ? `已禁用并重置「${factorUser.email}」的 TOTP 动态口令。`
          : `Disabled TOTP 2FA for ${factorUser.email}.`,
      });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '禁用 TOTP 失败' : 'Failed to disable TOTP',
        isError: true,
      });
    } finally {
      setTotpBusy(false);
    }
  }

  async function handleRegisterPasskeySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!factorUser) return;
    setActionNotice(null);
    setRegisteringPasskey(true);
    try {
      const label = passkeyLabel.trim() || `${factorUser.displayName} Passkey`;
      await onRegisterPasskey({
        userId: factorUser.id,
        label,
      });
      setActionNotice({
        text: isZh
          ? `Passkey「${label}」已绑定到 ${factorUser.email} 并持久化保存，现在可用于登录页验证。`
          : `Passkey "${label}" registered for ${factorUser.email}.`,
      });
      setPasskeyLabel(isZh ? `${factorUser.displayName} 新设备通行密钥` : `${factorUser.displayName} Passkey`);
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '注册 Passkey 失败' : 'Failed to register Passkey',
        isError: true,
      });
    } finally {
      setRegisteringPasskey(false);
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
        text: isZh ? `已删除 Passkey「${target.label}」。` : `Deleted Passkey "${target.label}".`,
      });
    } catch (err) {
      setActionNotice({
        text: err instanceof Error ? err.message : isZh ? '删除 Passkey 失败' : 'Failed to delete Passkey',
        isError: true,
      });
    } finally {
      setDeletingPasskeyId(null);
    }
  }

  async function handleConfirmDeleteUser() {
    if (!confirmDeleteUser) return;
    const target = confirmDeleteUser;
    setDeletingUserId(target.id);
    setActionNotice(null);
    try {
      await onDeleteUser(target.id);
      if (factorUserId === target.id) setFactorUserId(null);
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

        <button
          type="button"
          onClick={openCreateUser}
          className="min-h-[40px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          <span>{isZh ? '新建用户' : 'Create User'}</span>
        </button>
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
                {isZh
                  ? newRole === 'super_admin'
                    ? '初始密码（管理员必填，至少 8 位）'
                    : '初始密码（至少 8 位，留空则无本地密码）'
                  : newRole === 'super_admin'
                    ? 'Initial Password (required for admin, min 8 chars)'
                    : 'Initial Password (min 8 chars, optional)'}
              </label>
              <input
                id="create-user-password"
                type="password"
                required={newRole === 'super_admin'}
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

      {/* Unified Per-User Security Factors Manager (opened by clicking Password / TOTP / Passkeys(N) in user row) */}
      {factorUser && (
        <section className="bg-white dark:bg-[#111827] border border-indigo-200 dark:border-indigo-900/70 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 bg-slate-50/70 dark:bg-slate-900/40">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                  {isZh
                    ? `认证因子管理：${factorUser.displayName} (${factorUser.email})`
                    : `Security Factors: ${factorUser.displayName} (${factorUser.email})`}
                </h2>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {isZh
                  ? '集中管理该用户的 Passkey 通行密钥、本地密码与 TOTP 动态口令（添加、重置或禁用）。'
                  : 'Add, reset, or disable Passkeys, local password, and TOTP 2FA for this account.'}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close security factor manager"
              onClick={() => setFactorUserId(null)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Factor Tabs */}
          <div className="px-5 pt-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-4 text-xs">
            <button
              type="button"
              onClick={() => setFactorTab('passkeys')}
              className={`pb-2.5 border-b-2 font-medium inline-flex items-center gap-1.5 transition-colors ${
                factorTab === 'passkeys'
                  ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <Fingerprint className="w-3.5 h-3.5" />
              <span>Passkeys ({factorUserPasskeys.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setFactorTab('password')}
              className={`pb-2.5 border-b-2 font-medium inline-flex items-center gap-1.5 transition-colors ${
                factorTab === 'password'
                  ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>{isZh ? '本地密码 (Argon2id)' : 'Password (Argon2id)'}</span>
            </button>
            <button
              type="button"
              onClick={() => setFactorTab('totp')}
              className={`pb-2.5 border-b-2 font-medium inline-flex items-center gap-1.5 transition-colors ${
                factorTab === 'totp'
                  ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>TOTP 2FA ({factorUser.totpEnabled ? 'ON' : 'OFF'})</span>
            </button>
          </div>

          <div className="p-5">
            {/* TAB 1: Passkeys for this user */}
            {factorTab === 'passkeys' && (
              <div className="space-y-4">
                {confirmDeletePasskey && (
                  <div
                    role="alertdialog"
                    aria-label="Confirm delete passkey"
                    className="p-3.5 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                  >
                    <span className="text-red-900 dark:text-red-200 font-medium">
                      {isZh
                        ? `确认删除 Passkey「${confirmDeletePasskey.label}」？删除后该设备将无法再使用此密钥免密登录。`
                        : `Delete Passkey "${confirmDeletePasskey.label}"? This device will no longer be able to sign in with it.`}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setConfirmDeletePasskey(null)}
                        className="px-3 py-1.5 rounded-md border border-red-200 dark:border-red-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
                      >
                        {isZh ? '取消' : 'Cancel'}
                      </button>
                      <button
                        type="button"
                        disabled={deletingPasskeyId === confirmDeletePasskey.id}
                        onClick={() => void handleConfirmDeletePasskey()}
                        className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white font-medium disabled:opacity-60"
                      >
                        {deletingPasskeyId === confirmDeletePasskey.id
                          ? '...'
                          : isZh
                            ? '确认删除'
                            : 'Delete'}
                      </button>
                    </div>
                  </div>
                )}

                {factorUserPasskeys.length === 0 ? (
                  <div className="p-4 rounded-lg border border-dashed border-slate-200 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400">
                    {isZh
                      ? '该用户暂未绑定 Passkey。未绑定前，登录页的 Passkey 登录会拒绝访问。可在下方使用当前浏览器的 TouchID / FaceID / Windows Hello / YubiKey 立即绑定。'
                      : 'No Passkeys registered for this account yet. Register a device Passkey below (requires HTTPS or localhost).'}
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                    {factorUserPasskeys.map((pk) => (
                      <div key={pk.id} className="px-4 py-3 flex items-center justify-between gap-3 text-xs bg-slate-50/40 dark:bg-[#0B0F19]">
                        <div className="min-w-0 space-y-0.5">
                          <div className="font-medium text-slate-900 dark:text-white">{pk.label}</div>
                          <div className="font-mono text-[11px] text-slate-500 truncate">
                            RP: {pk.rpId} · {pk.algorithm === -257 ? 'RS256' : 'ES256'} · SignCount #{pk.signCount}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setConfirmDeletePasskey(pk)}
                          className="px-2.5 py-1.5 rounded-md border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 text-xs font-medium inline-flex items-center gap-1 shrink-0"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>{isZh ? '删除' : 'Delete'}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <form onSubmit={handleRegisterPasskeySubmit} className="flex flex-col sm:flex-row gap-2.5 pt-1">
                  <input
                    type="text"
                    required
                    value={passkeyLabel}
                    onChange={(e) => setPasskeyLabel(e.target.value)}
                    placeholder={isZh ? '设备备注名（如 MacBook TouchID / YubiKey）' : 'Authenticator label (e.g. MacBook TouchID)'}
                    aria-label="Passkey label"
                    className="flex-1 min-h-[38px] px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                  <button
                    type="submit"
                    disabled={registeringPasskey}
                    className="min-h-[38px] px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
                  >
                    <Fingerprint className="w-3.5 h-3.5" />
                    <span>
                      {registeringPasskey
                        ? isZh
                          ? '等待设备验证...'
                          : 'Waiting for device...'
                        : isZh
                          ? '添加并绑定新 Passkey'
                          : 'Register New Passkey'}
                    </span>
                  </button>
                </form>
              </div>
            )}

            {/* TAB 2: Local Password (Set / Reset / Disable) */}
            {factorTab === 'password' && (
              <div className="space-y-4">
                <form onSubmit={handleResetPasswordSubmit} className="space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="factor-pwd-1" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        {isZh ? '设置 / 重置新密码（至少 8 位）' : 'Set / Reset Password (min 8 chars)'}
                      </label>
                      <input
                        id="factor-pwd-1"
                        type="password"
                        required
                        minLength={8}
                        value={resetPwd}
                        onChange={(e) => setResetPwd(e.target.value)}
                        className="w-full min-h-[38px] px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                      />
                    </div>
                    <div>
                      <label htmlFor="factor-pwd-2" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        {isZh ? '确认新密码' : 'Confirm Password'}
                      </label>
                      <input
                        id="factor-pwd-2"
                        type="password"
                        required
                        minLength={8}
                        value={resetPwdConfirm}
                        onChange={(e) => setResetPwdConfirm(e.target.value)}
                        className="w-full min-h-[38px] px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    {factorUser.passwordAlgo !== 'none' ? (
                      !confirmClearPwd ? (
                        <button
                          type="button"
                          onClick={() => setConfirmClearPwd(true)}
                          className="px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 text-xs font-medium"
                        >
                          {isZh ? '禁用 / 清除本地密码' : 'Clear / Disable Local Password'}
                        </button>
                      ) : (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-red-700 dark:text-red-400 font-medium">
                            {isZh ? '确认清除本地密码？' : 'Confirm clearing password?'}
                          </span>
                          <button
                            type="button"
                            onClick={() => setConfirmClearPwd(false)}
                            className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700"
                          >
                            {isZh ? '取消' : 'Cancel'}
                          </button>
                          <button
                            type="button"
                            disabled={savingPwd}
                            onClick={() => void handleConfirmClearPassword()}
                            className="px-2.5 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-medium disabled:opacity-60"
                          >
                            {isZh ? '确认清除' : 'Confirm'}
                          </button>
                        </div>
                      )
                    ) : (
                      <span className="text-xs text-slate-500">
                        {isZh ? '当前未设置本地密码（纯免密 / 第三方登录账号）' : 'No local password set (passwordless / social only).'}
                      </span>
                    )}

                    <button
                      type="submit"
                      disabled={savingPwd}
                      className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-medium"
                    >
                      {savingPwd ? '...' : isZh ? '保存密码' : 'Save Password'}
                    </button>
                  </div>
                </form>
              </div>
            )}

            {/* TAB 3: TOTP 2FA (Enroll / Verify / Disable) */}
            {factorTab === 'totp' && (
              <div className="space-y-4 text-xs">
                {factorUser.totpEnabled ? (
                  <div className="p-4 rounded-lg bg-emerald-50/70 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="font-semibold text-emerald-900 dark:text-emerald-300 flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>{isZh ? 'TOTP 动态口令（2FA）已开启' : 'TOTP 2FA is Active'}</span>
                      </div>
                      <p className="text-emerald-800/80 dark:text-emerald-300/80">
                        {isZh
                          ? '如果用户遗失手机验证器，可在此一键禁用/重置其 TOTP 绑定。'
                          : 'Disable or reset TOTP if the user lost access to their authenticator app.'}
                      </p>
                    </div>

                    {!confirmDisableTotp ? (
                      <button
                        type="button"
                        onClick={() => setConfirmDisableTotp(true)}
                        className="px-3.5 py-2 rounded-lg border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-900 text-red-700 dark:text-red-400 hover:bg-red-50 font-medium shrink-0"
                      >
                        {isZh ? '禁用 / 重置 TOTP' : 'Disable TOTP'}
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => setConfirmDisableTotp(false)}
                          className="px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                        >
                          {isZh ? '取消' : 'Cancel'}
                        </button>
                        <button
                          type="button"
                          disabled={totpBusy}
                          onClick={() => void handleConfirmDisableTotp()}
                          className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white font-medium disabled:opacity-60"
                        >
                          {totpBusy ? '...' : isZh ? '确认禁用' : 'Confirm Disable'}
                        </button>
                      </div>
                    )}
                  </div>
                ) : !totpDraft ? (
                  <div className="p-4 rounded-lg border border-dashed border-slate-200 dark:border-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="text-slate-600 dark:text-slate-400 leading-relaxed">
                      {isZh
                        ? '该用户尚未开启 TOTP 动态口令（支持 Google Authenticator / Microsoft Authenticator / 1Password）。'
                        : 'TOTP 2FA is currently OFF for this user. Generate a secret to enroll an authenticator app.'}
                    </div>
                    <button
                      type="button"
                      disabled={totpBusy}
                      onClick={() => void handleStartTotpEnroll()}
                      className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-medium shrink-0"
                    >
                      {totpBusy ? '...' : isZh ? '生成 TOTP 密钥并绑定' : 'Generate TOTP Secret'}
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleVerifyTotpSubmit} className="space-y-3 p-4 rounded-lg border border-indigo-200 dark:border-indigo-900/60 bg-slate-50/60 dark:bg-[#0B0F19]">
                    <div className="font-semibold text-slate-900 dark:text-white">
                      {isZh ? '步骤 1：将密钥添加到手机验证器（Google / Microsoft Authenticator）' : 'Step 1: Add Secret to Authenticator App'}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 font-mono text-[11px]">
                      <div className="p-2.5 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                        <div className="text-slate-400 mb-1">Base32 Secret</div>
                        <div className="flex items-center justify-between gap-2">
                          <code className="break-all text-slate-900 dark:text-slate-100">{totpDraft.secret}</code>
                          <button
                            type="button"
                            onClick={() => copySnippet('totp_secret', totpDraft.secret)}
                            className="p-1 text-slate-400 hover:text-indigo-600 shrink-0"
                            title="Copy secret"
                          >
                            {copiedKey === 'totp_secret' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                      <div className="p-2.5 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                        <div className="text-slate-400 mb-1">otpauth:// URI</div>
                        <div className="flex items-center justify-between gap-2">
                          <code className="truncate text-slate-900 dark:text-slate-100">{totpDraft.otpauthUri}</code>
                          <button
                            type="button"
                            onClick={() => copySnippet('totp_uri', totpDraft.otpauthUri)}
                            className="p-1 text-slate-400 hover:text-indigo-600 shrink-0"
                            title="Copy URI"
                          >
                            {copiedKey === 'totp_uri' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-end gap-2.5 pt-1">
                      <div className="flex-1">
                        <label htmlFor="totp-verify-code" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          {isZh ? '步骤 2：输入验证器生成的 6 位动态验证码完成开启' : 'Step 2: Enter 6-digit code to activate'}
                        </label>
                        <input
                          id="totp-verify-code"
                          type="text"
                          inputMode="numeric"
                          required
                          maxLength={6}
                          value={totpCode}
                          onChange={(e) => setTotpCode(e.target.value)}
                          placeholder="123456"
                          className="w-full min-h-[38px] px-3 py-1.5 text-sm font-mono tracking-widest rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setTotpDraft(null)}
                        className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700"
                      >
                        {isZh ? '取消' : 'Cancel'}
                      </button>
                      <button
                        type="submit"
                        disabled={totpBusy}
                        className="min-h-[38px] px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-medium whitespace-nowrap"
                      >
                        {totpBusy ? '...' : isZh ? '验证并开启 TOTP' : 'Verify & Enable'}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Security Factors Inline Explanation Popover (toggled via ? icon on column header) */}
      {showFactorsHelp && (
        <div className="bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 rounded-xl p-4 text-xs space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
              <HelpCircle className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>{isZh ? '什么是 Security Factors（认证因子）？需要管理吗？' : 'What are Security Factors & how to manage them?'}</span>
            </div>
            <button
              type="button"
              onClick={() => setShowFactorsHelp(false)}
              className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
            {isZh
              ? '「认证因子」指的是该账号支持哪些方式验证身份。普通用户如果仅用第三方（如微信/Google）登录，无需手动配置；管理员或需要高安全性的账号可按需启用。直接点击下方用户行里的任意一项即可添加、修改、删除或禁用：'
              : 'Security Factors are the credentials a user can sign in with. Click any factor directly inside a user row to add, reset, revoke, or disable it:'}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 text-slate-700 dark:text-slate-300">
            <div className="p-2.5 rounded-lg bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800">
              <div className="font-semibold flex items-center gap-1.5 text-slate-900 dark:text-white">
                <KeyRound className="w-3.5 h-3.5 text-indigo-500" />
                <span>{isZh ? '本地密码 (argon2id)' : 'Password (argon2id)'}</span>
              </div>
              <p className="mt-1 text-slate-500 dark:text-slate-400">
                {isZh ? '点击可设置/重置登录密码，或清除本地密码（转为纯免密/社交登录）。' : 'Click to set/reset password, or clear local password.'}
              </p>
            </div>
            <div className="p-2.5 rounded-lg bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800">
              <div className="font-semibold flex items-center gap-1.5 text-slate-900 dark:text-white">
                <ShieldAlert className="w-3.5 h-3.5 text-indigo-500" />
                <span>{isZh ? 'TOTP 动态口令 (2FA)' : 'TOTP 2FA'}</span>
              </div>
              <p className="mt-1 text-slate-500 dark:text-slate-400">
                {isZh ? '手机 6 位动态验证码（Google/微软验证器）。点击可生成密钥开启，或一键禁用重置。' : '6-digit authenticator app code. Click to enroll or disable.'}
              </p>
            </div>
            <div className="p-2.5 rounded-lg bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800">
              <div className="font-semibold flex items-center gap-1.5 text-slate-900 dark:text-white">
                <Fingerprint className="w-3.5 h-3.5 text-indigo-500" />
                <span>{isZh ? 'Passkeys (N) 通行密钥' : 'Passkeys (N)'}</span>
              </div>
              <p className="mt-1 text-slate-500 dark:text-slate-400">
                {isZh ? '设备指纹/面容/安全密钥（WebAuthn）。点击即可查看该用户已保存设备、添加新密钥或删除吊销。' : 'TouchID/FaceID/YubiKey credentials. Click to list, add, or delete.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Unified User Management Directory Table (`users` + `user_identities` + `passkey_credentials`) */}
      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                {isZh ? `用户与身份目录（${users.length}）` : `Users & Linked Identities (${users.length})`}
              </h2>
              <span className="text-xs text-slate-400">·</span>
              <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                {isZh ? `系统管理员 ${adminUsers.length} 位` : `${adminUsers.length} Super Admin(s)`} · {passkeys.length} Passkey(s)
              </span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {isZh
                ? '点击每行「认证因子」中的密码、TOTP 或 Passkeys (N) 即可直接添加、重置、删除或禁用。'
                : 'Click Password, TOTP, or Passkeys (N) in any user row to manage, add, revoke, or disable factors.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 text-xs bg-slate-50 dark:bg-slate-900">
              {(
                [
                  { id: 'all', label: isZh ? '全部' : 'All' },
                  { id: 'super_admin', label: isZh ? '管理员' : 'Admins' },
                  { id: 'member', label: isZh ? '成员' : 'Members' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setRoleFilter(tab.id)}
                  className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                    roleFilter === tab.id
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="relative w-full sm:w-56">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={isZh ? '搜索邮箱、姓名...' : 'Search email, name...'}
                aria-label="Search users"
                className="w-full min-h-[34px] pl-8 pr-3 py-1 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-900/40">
                <th className="py-3 px-4">{isZh ? '用户 / 角色' : 'User / Role'}</th>
                <th className="py-3 px-4">{isZh ? '绑定渠道' : 'Linked Channels'}</th>
                <th className="py-3 px-4">
                  <button
                    type="button"
                    onClick={() => setShowFactorsHelp((v) => !v)}
                    className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 font-medium"
                    title={isZh ? '查看认证因子说明与管理方法' : 'What are Security Factors?'}
                  >
                    <span>{isZh ? '认证因子 (Security Factors)' : 'Security Factors'}</span>
                    <HelpCircle className="w-3.5 h-3.5 text-indigo-500" />
                  </button>
                </th>
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
                  const isSelected = factorUserId === u.id;

                  return (
                    <tr
                      key={u.id}
                      className={`hover:bg-slate-50/60 dark:hover:bg-slate-800/30 ${
                        isSelected ? 'bg-indigo-50/30 dark:bg-indigo-950/20' : ''
                      }`}
                    >
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
                          {isSelf && (
                            <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                              · {isZh ? '当前' : 'You'}
                            </span>
                          )}
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

                      {/* Clickable Security Factors cell — unified entry point for Password, TOTP, and Passkeys */}
                      <td className="py-3 px-4 align-top">
                        <div className="flex flex-col items-start gap-1">
                          <button
                            type="button"
                            onClick={() => openFactorManager(u, 'password')}
                            className="group inline-flex items-center gap-1.5 px-2 py-0.5 -ml-2 rounded-md text-slate-600 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors"
                            title={isZh ? '点击设置、重置或清除密码' : 'Manage password'}
                          >
                            <KeyRound className="w-3.5 h-3.5 text-slate-400 group-hover:text-indigo-500" />
                            <span>{u.passwordAlgo === 'none' ? (isZh ? '密码：未设置' : 'Password: None') : `Password: ${u.passwordAlgo}`}</span>
                            <ChevronRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </button>

                          <button
                            type="button"
                            onClick={() => openFactorManager(u, 'totp')}
                            className="group inline-flex items-center gap-1.5 px-2 py-0.5 -ml-2 rounded-md text-slate-600 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors"
                            title={isZh ? '点击开启或禁用 TOTP 2FA' : 'Manage TOTP 2FA'}
                          >
                            <ShieldAlert className={`w-3.5 h-3.5 ${u.totpEnabled ? 'text-emerald-500' : 'text-slate-400 group-hover:text-indigo-500'}`} />
                            <span>
                              TOTP:{' '}
                              <strong className={u.totpEnabled ? 'text-emerald-600 dark:text-emerald-400' : 'font-normal'}>
                                {u.totpEnabled ? 'ON' : 'OFF'}
                              </strong>
                            </span>
                            <ChevronRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </button>

                          <button
                            type="button"
                            onClick={() => openFactorManager(u, 'passkeys')}
                            className="group inline-flex items-center gap-1.5 px-2 py-0.5 -ml-2 rounded-md text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 font-medium transition-colors"
                            title={isZh ? '点击管理、添加或删除该用户的 Passkey' : 'Manage or revoke Passkeys for this user'}
                          >
                            <Fingerprint className="w-3.5 h-3.5 text-indigo-500" />
                            <span className="tabular-nums underline decoration-indigo-300 dark:decoration-indigo-700 underline-offset-2">
                              Passkeys ({u.passkeyCount})
                            </span>
                            <ChevronRight className="w-3 h-3 opacity-60 group-hover:opacity-100 transition-opacity" />
                          </button>
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
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            title={isZh ? '编辑用户资料与角色' : 'Edit user'}
                            aria-label={`Edit ${u.email}`}
                            onClick={() => openEditUser(u)}
                            className="p-1.5 rounded-md text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors"
                          >
                            <Pencil className="w-3.5 h-3.5" />
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
                              setFactorUserId(null);
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

      {/* Account Ban / Session Revocation Webhooks + Beginner Interactive Guide */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Webhook className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                Account Ban Webhooks (Downstream Session Kick)
              </h2>
            </div>
            <button
              type="button"
              onClick={() => setShowWebhookGuide((v) => !v)}
              aria-expanded={showWebhookGuide}
              className={`px-2.5 py-1 rounded-lg border text-xs font-medium inline-flex items-center gap-1 shrink-0 transition-colors ${
                showWebhookGuide
                  ? 'border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
              title={isZh ? '点击查看小白使用说明与代码示例' : 'Click to view beginner guide and code examples'}
            >
              <HelpCircle className="w-3.5 h-3.5 text-indigo-500" />
              <span>{isZh ? '使用说明与示例' : 'How to use'}</span>
            </button>
          </div>

          {/* Interactive Beginner Guide Drawer */}
          {showWebhookGuide && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#0B0F19] border border-indigo-200/80 dark:border-indigo-900/60 space-y-3.5 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1">
                  <div className="font-semibold text-slate-900 dark:text-white">
                    {isZh ? '一句话看懂：这个功能是干嘛的？' : 'What does this do? (Plain English)'}
                  </div>
                  <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                    {isZh
                      ? '当员工离职或账号异常、你在上方用户列表点击「封禁」时，认证中心会立刻往你的业务系统（如 ERP、CRM、商城后台）发一条加密 HTTP POST 通知，让业务系统马上把该用户踢下线。如果业务系统不需要实时踢人，可以不配。'
                      : 'When you click Ban on a user above, wimotek/Oauth immediately sends a signed HTTP POST request to your business app so it can kick the user out of their active local session right away. Optional if you do not need instant logout.'}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Close webhook guide"
                  onClick={() => setShowWebhookGuide(false)}
                  className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                <div className="p-2.5 rounded-lg bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800">
                  <div className="font-semibold text-indigo-600 dark:text-indigo-400">1. {isZh ? '业务端建接口' : 'Add POST Route'}</div>
                  <p className="mt-0.5 text-slate-500 dark:text-slate-400">
                    {isZh ? '在你的业务系统提供一个外网/内网可达的 POST URL。' : 'Expose a POST endpoint like /webhooks/oauth in your app.'}
                  </p>
                </div>
                <div className="p-2.5 rounded-lg bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800">
                  <div className="font-semibold text-indigo-600 dark:text-indigo-400">2. {isZh ? '下方填写地址与密钥' : 'Register URL & Secret'}</div>
                  <p className="mt-0.5 text-slate-500 dark:text-slate-400">
                    {isZh ? '填好 URL 与自定义 HMAC Secret（留空会自动生成）。' : 'Save your URL and HMAC signing secret below.'}
                  </p>
                </div>
                <div className="p-2.5 rounded-lg bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800">
                  <div className="font-semibold text-indigo-600 dark:text-indigo-400">3. {isZh ? '点击「封禁」即触发' : 'Click Ban to Trigger'}</div>
                  <p className="mt-0.5 text-slate-500 dark:text-slate-400">
                    {isZh ? '封禁用户后立即推送，右侧日志区可实时核对签名。' : 'Banning a user pushes the event and logs the signature on the right.'}
                  </p>
                </div>
              </div>

              {/* Example Payload */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-800 dark:text-slate-200">
                    {isZh ? '推送报文示例（Header 带 X-Wimotek-Signature-256）' : 'Example POST Payload (Header: X-Wimotek-Signature-256)'}
                  </span>
                  <button
                    type="button"
                    onClick={() => copySnippet('wh_payload', WEBHOOK_PAYLOAD_EXAMPLE)}
                    className="inline-flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline"
                  >
                    {copiedKey === 'wh_payload' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedKey === 'wh_payload' ? (isZh ? '已复制' : 'Copied') : isZh ? '复制' : 'Copy'}</span>
                  </button>
                </div>
                <pre className="p-2.5 rounded-lg bg-slate-900 text-slate-100 font-mono text-[11px] overflow-x-auto leading-relaxed">
                  {WEBHOOK_PAYLOAD_EXAMPLE}
                </pre>
              </div>

              {/* Example Receiver Code */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      {isZh ? '业务后端验签示例：' : 'Receiver Verification Example:'}
                    </span>
                    <div className="inline-flex rounded border border-slate-300 dark:border-slate-700 overflow-hidden text-[11px]">
                      <button
                        type="button"
                        onClick={() => setWebhookLang('node')}
                        className={`px-2 py-0.5 ${
                          webhookLang === 'node'
                            ? 'bg-indigo-600 text-white'
                            : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        Node.js
                      </button>
                      <button
                        type="button"
                        onClick={() => setWebhookLang('go')}
                        className={`px-2 py-0.5 ${
                          webhookLang === 'go'
                            ? 'bg-indigo-600 text-white'
                            : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        Go
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      copySnippet('wh_code', webhookLang === 'node' ? WEBHOOK_NODE_EXAMPLE : WEBHOOK_GO_EXAMPLE)
                    }
                    className="inline-flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline"
                  >
                    {copiedKey === 'wh_code' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedKey === 'wh_code' ? (isZh ? '已复制' : 'Copied') : isZh ? '复制代码' : 'Copy'}</span>
                  </button>
                </div>
                <pre className="p-2.5 rounded-lg bg-slate-900 text-slate-100 font-mono text-[11px] overflow-x-auto leading-relaxed max-h-56">
                  {webhookLang === 'node' ? WEBHOOK_NODE_EXAMPLE : WEBHOOK_GO_EXAMPLE}
                </pre>
              </div>
            </div>
          )}

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
                {isZh ? '暂未配置 Webhook 接收端（可选，不配置不影响正常 OIDC 登录）。' : 'No webhook endpoints configured yet (optional).'}
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
                placeholder={isZh ? '业务应用名称（如 ERP 后台）' : 'Downstream App Name'}
                aria-label="Webhook Name"
                className="min-h-[38px] px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <input
                type="password"
                value={whSecret}
                onChange={(e) => setWhSecret(e.target.value)}
                placeholder={isZh ? 'HMAC 签名密钥（留空自动生成）' : 'HMAC Secret (auto if blank)'}
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
                {addingWh ? '...' : isZh ? '添加接收端' : 'Add Endpoint'}
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
