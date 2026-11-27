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
  Mail,
  QrCode,
  Globe,
  SlidersHorizontal,
  Lock,
} from 'lucide-react';
import type {
  AuthPolicyConfig,
  AuthUser,
  IdentityProviderType,
  IdentityUser,
  Locale,
  PasskeyCredential,
  SocialConnector,
  UserAuthMethods,
  WebhookDeliveryLog,
  WebhookSubscription,
} from '../types';
import { TRANSLATIONS } from '../lib/i18n';
import { TotpEnrollModal, type TotpEnrollDraft } from './QrCodeSvg';

type FactorTab = 'methods' | 'passkeys' | 'password' | 'totp';
type RoleFilter = 'all' | 'super_admin' | 'member';

interface TotpEnrollResponse {
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
  authPolicy: AuthPolicyConfig;
  connectors: SocialConnector[];
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
  onUpdateUserFactors: (userId: string, allowedMethods: UserAuthMethods) => Promise<void>;
  onResetUserPassword: (userId: string, password: string) => Promise<void>;
  onClearUserPassword: (userId: string) => Promise<void>;
  onEnrollUserTotp: (userId: string) => Promise<TotpEnrollResponse>;
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

const DEFAULT_USER_METHODS: UserAuthMethods = {
  password: true,
  passkey: true,
  emailOtp: true,
  totp: true,
  deviceFlow: true,
  social: true,
};

function resolveEffectiveMethods(
  user: IdentityUser,
  policy: AuthPolicyConfig,
  hasEnabledSocial: boolean
): UserAuthMethods {
  const base = user.allowedMethods || DEFAULT_USER_METHODS;
  return {
    password: policy.enablePasswordArgon2id && base.password,
    passkey: policy.enablePasskeysWebAuthn && base.passkey,
    emailOtp: policy.enableEmailOtpMagicLink && base.emailOtp,
    totp: policy.enableTotp2fa && base.totp,
    deviceFlow: policy.enableDeviceFlowRfc8628 && base.deviceFlow,
    social: hasEnabledSocial && base.social,
  };
}

function countEnabledPrimaryMethods(m: UserAuthMethods): number {
  return (
    (m.password ? 1 : 0) +
    (m.passkey ? 1 : 0) +
    (m.emailOtp ? 1 : 0) +
    (m.deviceFlow ? 1 : 0) +
    (m.social ? 1 : 0)
  );
}

export function IdentityDirectoryView({
  locale,
  currentUser,
  users,
  passkeys,
  webhooks,
  webhookLogs,
  jitAutoLinkEnabled,
  authPolicy,
  connectors,
  onSimulateJit,
  onCreateUser,
  onUpdateUser,
  onUpdateUserFactors,
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

  // Create User Modal
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'super_admin' | 'member'>('member');
  const [newVerified, setNewVerified] = useState(true);
  const [creatingUser, setCreatingUser] = useState(false);

  // Edit User Modal
  const [editingUser, setEditingUser] = useState<IdentityUser | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState<'super_admin' | 'member'>('member');
  const [editVerified, setEditVerified] = useState(true);
  const [savingUser, setSavingUser] = useState(false);

  // Unified per-user Security Factors Modal
  const [factorUserId, setFactorUserId] = useState<string | null>(null);
  const [factorTab, setFactorTab] = useState<FactorTab>('methods');
  const [draftMethods, setDraftMethods] = useState<UserAuthMethods>(DEFAULT_USER_METHODS);
  const [factorInlineWarning, setFactorInlineWarning] = useState<string | null>(null);
  const [savingMethods, setSavingMethods] = useState(false);

  // Passkey state inside factor modal
  const [passkeyLabel, setPasskeyLabel] = useState('');
  const [registeringPasskey, setRegisteringPasskey] = useState(false);
  const [confirmDeletePasskey, setConfirmDeletePasskey] = useState<PasskeyCredential | null>(null);
  const [deletingPasskeyId, setDeletingPasskeyId] = useState<string | null>(null);

  // Password state inside factor modal
  const [resetPwd, setResetPwd] = useState('');
  const [resetPwdConfirm, setResetPwdConfirm] = useState('');
  const [savingPwd, setSavingPwd] = useState(false);
  const [confirmClearPwd, setConfirmClearPwd] = useState(false);

  // TOTP QR popup modal state
  const [totpModalDraft, setTotpModalDraft] = useState<TotpEnrollDraft | null>(null);
  const [totpModalOpen, setTotpModalOpen] = useState(false);
  const [totpModalError, setTotpModalError] = useState<string | null>(null);
  const [totpVerifiedCodes, setTotpVerifiedCodes] = useState<string[] | null>(null);
  const [totpBusy, setTotpBusy] = useState(false);
  const [confirmDisableTotp, setConfirmDisableTotp] = useState(false);

  // Delete User Modal & Webhook confirm
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

  // Webhook form & beginner guide state
  const [showWebhookGuide, setShowWebhookGuide] = useState(false);
  const [webhookLang, setWebhookLang] = useState<'node' | 'go'>('node');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [whName, setWhName] = useState('');
  const [whUrl, setWhUrl] = useState('');
  const [whSecret, setWhSecret] = useState('');
  const [whError, setWhError] = useState<string | null>(null);
  const [addingWh, setAddingWh] = useState(false);

  const enabledConnectors = useMemo(() => connectors.filter((c) => c.enabled), [connectors]);
  const hasEnabledSocial = enabledConnectors.length > 0;

  const adminUsers = useMemo(() => users.filter((u) => u.role === 'super_admin'), [users]);
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
    setShowCreateUser(true);
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

  function openFactorManager(u: IdentityUser, tab: FactorTab = 'methods') {
    setShowCreateUser(false);
    setEditingUser(null);
    setConfirmDeleteUser(null);
    setConfirmDeletePasskey(null);
    setConfirmClearPwd(false);
    setConfirmDisableTotp(false);
    setFactorInlineWarning(null);
    setResetPwd('');
    setResetPwdConfirm('');
    setPasskeyLabel(isZh ? `${u.displayName} 设备通行密钥` : `${u.displayName} Passkey`);
    setDraftMethods(resolveEffectiveMethods(u, authPolicy, hasEnabledSocial));
    setFactorUserId(u.id);
    setFactorTab(tab);
  }

  function toggleDraftMethod(key: keyof UserAuthMethods, globalAllowed: boolean) {
    setFactorInlineWarning(null);
    if (!globalAllowed) {
      setFactorInlineWarning(
        isZh
          ? '管理员已在「安全策略」中全局禁用该方式，用户无权重新启用。'
          : 'This authentication method is disabled globally by the administrator in Security Policy.'
      );
      return;
    }
    const next: UserAuthMethods = { ...draftMethods, [key]: !draftMethods[key] };
    if (key !== 'totp' && !next[key] && countEnabledPrimaryMethods(next) < 1) {
      setFactorInlineWarning(
        isZh
          ? '至少需要保留 1 种主登录方式（例如仅保留 Passkeys），无法全部禁用以免账号锁死。'
          : 'At least one primary sign-in method must remain enabled to prevent account lockout.'
      );
      return;
    }
    setDraftMethods(next);
  }

  async function handleSaveUserFactors() {
    if (!factorUser) return;
    setFactorInlineWarning(null);
    if (countEnabledPrimaryMethods(draftMethods) < 1) {
      setFactorInlineWarning(
        isZh
          ? '至少需要保留 1 种主登录方式。'
          : 'At least one primary sign-in method must remain enabled.'
      );
      return;
    }
    setSavingMethods(true);
    try {
      await onUpdateUserFactors(factorUser.id, draftMethods);
      setActionNotice({
        text: isZh
          ? `已保存「${factorUser.email}」的个性化认证方式策略。`
          : `Saved personalized authentication methods for ${factorUser.email}.`,
      });
    } catch (err) {
      setFactorInlineWarning(
        err instanceof Error ? err.message : isZh ? '保存认证策略失败' : 'Failed to save authentication methods'
      );
    } finally {
      setSavingMethods(false);
    }
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
      setFactorInlineWarning(isZh ? '新密码长度至少 8 位。' : 'New password must be at least 8 characters.');
      return;
    }
    if (resetPwd !== resetPwdConfirm) {
      setFactorInlineWarning(isZh ? '两次输入的密码不一致。' : 'Passwords do not match.');
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
      setFactorInlineWarning(
        err instanceof Error ? err.message : isZh ? '更新密码失败' : 'Failed to update password'
      );
    } finally {
      setSavingPwd(false);
    }
  }

  async function handleConfirmClearPassword() {
    if (!factorUser) return;
    setSavingPwd(true);
    setFactorInlineWarning(null);
    try {
      await onClearUserPassword(factorUser.id);
      setConfirmClearPwd(false);
      setActionNotice({
        text: isZh
          ? `已清除「${factorUser.email}」的本地密码（该用户将通过 Passkey、邮箱验证码或第三方账号登录）。`
          : `Cleared local password for ${factorUser.email}.`,
      });
    } catch (err) {
      setFactorInlineWarning(
        err instanceof Error ? err.message : isZh ? '清除密码失败' : 'Failed to clear password'
      );
    } finally {
      setSavingPwd(false);
    }
  }

  async function handleStartTotpEnrollPopup() {
    if (!factorUser) return;
    if (!authPolicy.enableTotp2fa) {
      setFactorInlineWarning(
        isZh
          ? '管理员已在全局安全策略中禁用 TOTP 2FA，当前无法绑定。'
          : 'TOTP 2FA is disabled globally by the administrator.'
      );
      return;
    }
    setTotpBusy(true);
    setTotpModalError(null);
    setTotpVerifiedCodes(null);
    try {
      const data = await onEnrollUserTotp(factorUser.id);
      setTotpModalDraft({
        email: factorUser.email,
        secret: data.secret,
        otpauthUri: data.otpauthUri,
        recoveryCodes: data.recoveryCodes || [],
      });
      setTotpModalOpen(true);
    } catch (err) {
      setFactorInlineWarning(
        err instanceof Error ? err.message : isZh ? '生成 TOTP 二维码失败' : 'Failed to generate TOTP QR code'
      );
    } finally {
      setTotpBusy(false);
    }
  }

  async function handleVerifyTotpCode(code: string) {
    if (!factorUser || !totpModalDraft) return;
    setTotpBusy(true);
    setTotpModalError(null);
    try {
      await onVerifyUserTotp(factorUser.id, code);
      setTotpVerifiedCodes(totpModalDraft.recoveryCodes);
      setDraftMethods((prev) => ({ ...prev, totp: true }));
      setActionNotice({
        text: isZh
          ? `已为「${factorUser.email}」开启 TOTP 动态口令（2FA）。`
          : `Enabled TOTP 2FA for ${factorUser.email}.`,
      });
    } catch (err) {
      setTotpModalError(
        err instanceof Error ? err.message : isZh ? '6 位动态验证码不正确，请检查手机时间后重试。' : 'Invalid 6-digit TOTP code.'
      );
    } finally {
      setTotpBusy(false);
    }
  }

  async function handleConfirmDisableTotp() {
    if (!factorUser) return;
    setTotpBusy(true);
    setFactorInlineWarning(null);
    try {
      await onDisableUserTotp(factorUser.id);
      setConfirmDisableTotp(false);
      setActionNotice({
        text: isZh
          ? `已禁用并重置「${factorUser.email}」的 TOTP 动态口令。`
          : `Disabled TOTP 2FA for ${factorUser.email}.`,
      });
    } catch (err) {
      setFactorInlineWarning(
        err instanceof Error ? err.message : isZh ? '禁用 TOTP 失败' : 'Failed to disable TOTP'
      );
    } finally {
      setTotpBusy(false);
    }
  }

  async function handleRegisterPasskeySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!factorUser) return;
    setFactorInlineWarning(null);
    setRegisteringPasskey(true);
    try {
      const label = passkeyLabel.trim() || `${factorUser.displayName} Passkey`;
      await onRegisterPasskey({
        userId: factorUser.id,
        label,
      });
      setActionNotice({
        text: isZh
          ? `Passkey「${label}」已绑定到 ${factorUser.email} 并持久化保存。`
          : `Passkey "${label}" registered for ${factorUser.email}.`,
      });
      setPasskeyLabel(isZh ? `${factorUser.displayName} 新设备通行密钥` : `${factorUser.displayName} Passkey`);
    } catch (err) {
      setFactorInlineWarning(
        err instanceof Error ? err.message : isZh ? '注册 Passkey 失败' : 'Failed to register Passkey'
      );
    } finally {
      setRegisteringPasskey(false);
    }
  }

  async function handleConfirmDeletePasskey() {
    if (!confirmDeletePasskey) return;
    const target = confirmDeletePasskey;
    setDeletingPasskeyId(target.id);
    setFactorInlineWarning(null);
    try {
      await onDeletePasskey(target.id);
      setConfirmDeletePasskey(null);
      setActionNotice({
        text: isZh ? `已删除 Passkey「${target.label}」。` : `Deleted Passkey "${target.label}".`,
      });
    } catch (err) {
      setFactorInlineWarning(
        err instanceof Error ? err.message : isZh ? '删除 Passkey 失败' : 'Failed to delete Passkey'
      );
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

  const factorSwitchItems: {
    key: keyof UserAuthMethods;
    title: string;
    subtitle: string;
    globalAllowed: boolean;
    isMfaOnly?: boolean;
    icon: React.ComponentType<{ className?: string }>;
    actionLabel?: string;
    onQuickAction?: () => void;
  }[] = [
    {
      key: 'password',
      title: isZh ? '邮箱 + 密码 (Argon2id)' : 'Email + Password (Argon2id)',
      subtitle: isZh
        ? '经典账号密码登录；可单独关闭，仅保留 Passkey 等无密码方式。'
        : 'Standard password sign-in. Can be turned OFF if another primary method stays enabled.',
      globalAllowed: authPolicy.enablePasswordArgon2id,
      icon: KeyRound,
      actionLabel: isZh ? '设置/清除密码' : 'Manage Password',
      onQuickAction: () => setFactorTab('password'),
    },
    {
      key: 'passkey',
      title: isZh ? `Passkeys 通行密钥 (WebAuthn · 已绑 ${factorUserPasskeys.length})` : `Passkeys (WebAuthn · ${factorUserPasskeys.length} bound)`,
      subtitle: isZh
        ? 'TouchID / FaceID / Windows Hello / YubiKey 硬件级免密认证。'
        : 'Hardware-backed TouchID / FaceID / Windows Hello / YubiKey passwordless sign-in.',
      globalAllowed: authPolicy.enablePasskeysWebAuthn,
      icon: Fingerprint,
      actionLabel: isZh ? '管理设备密钥' : 'Manage Devices',
      onQuickAction: () => setFactorTab('passkeys'),
    },
    {
      key: 'emailOtp',
      title: isZh ? '邮箱验证码 / 魔法链接 (Email OTP)' : 'Email OTP / Magic Link',
      subtitle: isZh
        ? '向已验证邮箱发送 6 位一次性验证码，支持免密登录。'
        : 'One-time 6-digit code sent to verified email for passwordless sign-in.',
      globalAllowed: authPolicy.enableEmailOtpMagicLink,
      icon: Mail,
    },
    {
      key: 'totp',
      title: isZh
        ? `TOTP 动态口令 2FA (${factorUser?.totpEnabled ? '已绑定' : '未绑定'})`
        : `TOTP 2FA Authenticator (${factorUser?.totpEnabled ? 'Bound' : 'Not Bound'})`,
      subtitle: isZh
        ? '二步验证因子（Google / Microsoft Authenticator），需配合主登录方式使用。'
        : 'Second-factor MFA code via Authenticator app (does not count as a standalone primary sign-in).',
      globalAllowed: authPolicy.enableTotp2fa,
      isMfaOnly: true,
      icon: ShieldAlert,
      actionLabel: factorUser?.totpEnabled ? (isZh ? '管理 / 禁用' : 'Manage') : isZh ? '扫码绑定 QR' : 'Scan QR',
      onQuickAction: () => {
        if (factorUser?.totpEnabled) {
          setFactorTab('totp');
        } else {
          void handleStartTotpEnrollPopup();
        }
      },
    },
    {
      key: 'deviceFlow',
      title: isZh ? '跨设备扫码授权 (RFC 8628 Device Flow)' : 'Device Flow (RFC 8628 Cross-Device QR)',
      subtitle: isZh
        ? '适用于 CLI 命令行、智能终端与大屏设备的扫码授权登录。'
        : 'Cross-device QR code authorization for CLI, TVs, and headless terminals.',
      globalAllowed: authPolicy.enableDeviceFlowRfc8628,
      icon: QrCode,
    },
    {
      key: 'social',
      title: isZh
        ? `第三方社交登录 (${enabledConnectors.length} 个已启用)`
        : `Social Login Connectors (${enabledConnectors.length} enabled)`,
      subtitle:
        enabledConnectors.length > 0
          ? enabledConnectors.map((c) => c.displayName).join(' · ')
          : isZh
            ? '管理员暂未在「社交连接器」中启用任何第三方 IdP。'
            : 'No social connectors are currently enabled by the administrator.',
      globalAllowed: hasEnabledSocial,
      icon: Globe,
    },
  ];

  const primaryEnabledCount = countEnabledPrimaryMethods(draftMethods);

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

      {/* Security Factors Inline Explanation Popover */}
      {showFactorsHelp && (
        <div className="bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 rounded-xl p-4 text-xs space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
              <HelpCircle className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>{isZh ? '全局策略上限与个人认证因子说明' : 'Admin Policy Ceiling & Per-User Security Factors'}</span>
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
              ? '每位用户可独立选择允许的登录方式（如关闭密码、仅保留 Passkeys），系统强制至少保留 1 种主登录方式防止锁死。同时受「安全策略」全局上限约束：若管理员在全局禁用了某项认证（例如 TOTP），用户侧自动锁定关闭且无权重新开启。'
              : 'Each user can choose their own subset of enabled authentication methods (e.g., disable Password and keep only Passkeys), with at least 1 primary method enforced. Any method disabled globally by the administrator in Security Policy is locked OFF and cannot be re-enabled per user.'}
          </p>
        </div>
      )}

      {/* Unified User Management Directory Table */}
      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                {isZh ? `用户与身份目录（${users.length}）` : `Users & Linked Identities (${users.length})`}
              </h2>
              <span className="text-xs text-slate-400">·</span>
              <span className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                {isZh ? `系统管理员 ${adminUsers.length} 位` : `${adminUsers.length} Super Admin(s)`} · {passkeys.length} Passkey(s)
              </span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {isZh
                ? '点击每行的「编辑」或「管理认证方式」将以弹窗打开，不影响表格排版。'
                : 'Edit user profiles and Security Factors in centered dialogs without shifting table layout.'}
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
                    title={isZh ? '查看认证因子与全局策略上限说明' : 'About Security Factors & Admin Ceiling'}
                  >
                    <span>{isZh ? '认证因子 (全部方式)' : 'Security Factors'}</span>
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
                  const eff = resolveEffectiveMethods(u, authPolicy, hasEnabledSocial);
                  const activePrimaryCount = countEnabledPrimaryMethods(eff);

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

                      <td className="py-3 px-4 align-top">
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300 tabular-nums">
                            <span className={eff.password ? 'text-slate-900 dark:text-slate-100' : 'text-slate-400 line-through'}>
                              {isZh ? '密码' : 'Pwd'}
                            </span>
                            <span className={eff.passkey ? 'text-indigo-600 dark:text-indigo-400 font-medium' : 'text-slate-400 line-through'}>
                              Passkeys({u.passkeyCount})
                            </span>
                            <span className={eff.emailOtp ? 'text-slate-800 dark:text-slate-200' : 'text-slate-400 line-through'}>
                              OTP
                            </span>
                            <span className={eff.deviceFlow ? 'text-slate-800 dark:text-slate-200' : 'text-slate-400 line-through'}>
                              QR
                            </span>
                            <span className={eff.social ? 'text-slate-800 dark:text-slate-200' : 'text-slate-400 line-through'}>
                              {isZh ? '社交' : 'Social'}
                            </span>
                            <span className="text-slate-300 dark:text-slate-700">|</span>
                            <span
                              className={
                                !authPolicy.enableTotp2fa
                                  ? 'text-slate-400'
                                  : u.totpEnabled && eff.totp
                                    ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                                    : 'text-slate-500'
                              }
                            >
                              TOTP:{!authPolicy.enableTotp2fa ? (isZh ? '全局禁' : 'Locked') : u.totpEnabled ? 'ON' : 'OFF'}
                            </span>
                          </div>

                          <button
                            type="button"
                            onClick={() => openFactorManager(u, 'methods')}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap"
                          >
                            <SlidersHorizontal className="w-3.5 h-3.5" />
                            <span>
                              {isZh
                                ? `管理全部认证方式 (${activePrimaryCount} 种主登录)`
                                : `Manage Factors (${activePrimaryCount} primary)`}
                            </span>
                            <ChevronRight className="w-3 h-3" />
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
                            title={isZh ? '弹窗编辑用户资料与角色' : 'Edit user'}
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

      {/* ==================== MODAL 1: Create User ==================== */}
      {showCreateUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-label="Create User"
        >
          <form
            onSubmit={handleCreateUserSubmit}
            className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800">
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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                      : '初始密码（至少 8 位，可留空）'
                    : newRole === 'super_admin'
                      ? 'Initial Password (min 8 chars)'
                      : 'Initial Password (optional)'}
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
                  <option value="member">{isZh ? '普通用户 (Member)' : 'Member'}</option>
                  <option value="super_admin">{isZh ? '系统管理员 (Super Admin)' : 'Super Admin'}</option>
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

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
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
        </div>
      )}

      {/* ==================== MODAL 2: Edit User ==================== */}
      {editingUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-label="Edit User"
        >
          <form
            onSubmit={handleUpdateUserSubmit}
            className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white truncate">
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

            <div className="space-y-4">
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

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
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
        </div>
      )}

      {/* ==================== MODAL 3: Delete User Confirmation ==================== */}
      {confirmDeleteUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-[2px]"
          role="alertdialog"
          aria-modal="true"
          aria-label="Confirm delete user"
        >
          <div className="w-full max-w-md bg-white dark:bg-[#111827] border border-red-200 dark:border-red-900/60 rounded-xl shadow-2xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <Trash2 className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                  {isZh
                    ? `确认永久删除用户「${confirmDeleteUser.displayName}」？`
                    : `Permanently delete ${confirmDeleteUser.email}?`}
                </h3>
                <p className="text-xs font-mono text-slate-500">{confirmDeleteUser.email}</p>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed pt-1">
                  {isZh
                    ? '删除后将同步移除该用户的社交绑定记录与所有已保存的 Passkey，此操作不可撤销。'
                    : 'This will remove the user account, linked social identities, and all saved Passkeys permanently.'}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setConfirmDeleteUser(null)}
                className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200"
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
        </div>
      )}

      {/* ==================== MODAL 4: Unified Security Factors Manager ==================== */}
      {factorUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-label="User Security Factors"
        >
          <div className="w-full max-w-2xl max-h-[88vh] flex flex-col bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 bg-slate-50/70 dark:bg-slate-900/40 shrink-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                    {isZh
                      ? `认证因子管理：${factorUser.displayName}`
                      : `Security Factors: ${factorUser.displayName}`}
                  </h2>
                </div>
                <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                  {factorUser.email}
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

            {/* Tabs */}
            <div className="px-5 pt-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-4 text-xs overflow-x-auto shrink-0">
              <button
                type="button"
                onClick={() => {
                  setFactorTab('methods');
                  setFactorInlineWarning(null);
                }}
                className={`pb-2.5 border-b-2 font-medium inline-flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                  factorTab === 'methods'
                    ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>{isZh ? '全部认证方式开关' : 'All Auth Methods'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setFactorTab('passkeys');
                  setFactorInlineWarning(null);
                }}
                className={`pb-2.5 border-b-2 font-medium inline-flex items-center gap-1.5 whitespace-nowrap transition-colors ${
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
                onClick={() => {
                  setFactorTab('password');
                  setFactorInlineWarning(null);
                }}
                className={`pb-2.5 border-b-2 font-medium inline-flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                  factorTab === 'password'
                    ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span>{isZh ? '本地密码' : 'Password'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setFactorTab('totp');
                  setFactorInlineWarning(null);
                }}
                className={`pb-2.5 border-b-2 font-medium inline-flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                  factorTab === 'totp'
                    ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>TOTP 2FA ({factorUser.totpEnabled ? 'ON' : 'OFF'})</span>
              </button>
            </div>

            {/* Scrollable Body */}
            <div className="p-5 overflow-y-auto space-y-4">
              {factorInlineWarning && (
                <div
                  role="alert"
                  className="flex items-start gap-2 px-3.5 py-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60 text-xs text-amber-800 dark:text-amber-300"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{factorInlineWarning}</span>
                </div>
              )}

              {/* TAB 1: All Auth Methods Switchboard */}
              {factorTab === 'methods' && (
                <div className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span>
                      {isZh
                        ? '勾选允许该账号使用的登录方式（可禁用密码仅留 Passkey）；至少保留 1 种主登录方式。'
                        : 'Select allowed sign-in methods for this account (at least 1 primary method must stay ON).'}
                    </span>
                    <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300 shrink-0">
                      {isZh ? `已启主方式：${primaryEnabledCount}` : `Primary ON: ${primaryEnabledCount}`}
                    </span>
                  </div>

                  <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                    {factorSwitchItems.map((item) => {
                      const Icon = item.icon;
                      const isOn = item.globalAllowed && draftMethods[item.key];
                      const isLastPrimary =
                        !item.isMfaOnly && isOn && primaryEnabledCount <= 1;

                      return (
                        <div
                          key={item.key}
                          className={`px-4 py-3.5 flex items-center justify-between gap-3 ${
                            item.globalAllowed
                              ? 'bg-white dark:bg-[#111827]'
                              : 'bg-slate-50/80 dark:bg-slate-900/50 opacity-75'
                          }`}
                        >
                          <div className="flex items-start gap-3 min-w-0">
                            <div className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex items-center justify-center shrink-0 mt-0.5">
                              <Icon className="w-4 h-4 text-slate-600 dark:text-slate-300" />
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-semibold text-slate-900 dark:text-white">
                                  {item.title}
                                </span>
                                {item.isMfaOnly && (
                                  <span className="text-[11px] font-mono text-slate-400">2FA / MFA</span>
                                )}
                                {!item.globalAllowed && (
                                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                                    <Lock className="w-3 h-3" />
                                    {isZh ? '管理员已全局禁用' : 'Disabled by Admin Policy'}
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                                {item.subtitle}
                              </p>
                              {item.globalAllowed && item.actionLabel && item.onQuickAction && (
                                <button
                                  type="button"
                                  onClick={item.onQuickAction}
                                  className="mt-1.5 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1"
                                >
                                  <span>{item.actionLabel}</span>
                                  <ChevronRight className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          </div>

                          <button
                            type="button"
                            role="switch"
                            aria-checked={isOn}
                            aria-label={`Toggle ${item.title}`}
                            disabled={!item.globalAllowed}
                            title={
                              !item.globalAllowed
                                ? isZh
                                  ? '管理员已在全局禁用，无权开启'
                                  : 'Disabled globally by administrator'
                                : isLastPrimary
                                  ? isZh
                                    ? '至少保留 1 种主登录方式'
                                    : 'At least 1 primary sign-in method required'
                                  : undefined
                            }
                            onClick={() => toggleDraftMethod(item.key, item.globalAllowed)}
                            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                              isOn ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-700'
                            }`}
                          >
                            <span
                              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                isOn ? 'translate-x-6' : 'translate-x-1'
                              }`}
                            />
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setFactorUserId(null)}
                      className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200"
                    >
                      {isZh ? '关闭' : 'Close'}
                    </button>
                    <button
                      type="button"
                      disabled={savingMethods}
                      onClick={() => void handleSaveUserFactors()}
                      className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-medium whitespace-nowrap"
                    >
                      {savingMethods ? '...' : isZh ? '保存认证方式策略' : 'Save Auth Methods'}
                    </button>
                  </div>
                </div>
              )}

              {/* TAB 2: Passkeys */}
              {factorTab === 'passkeys' && (
                <div className="space-y-4">
                  {!authPolicy.enablePasskeysWebAuthn && (
                    <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
                      <Lock className="w-4 h-4 shrink-0" />
                      <span>
                        {isZh
                          ? '管理员已在全局安全策略中禁用 Passkeys，无法添加新密钥。'
                          : 'Passkeys are disabled globally in Security Policy.'}
                      </span>
                    </div>
                  )}

                  {confirmDeletePasskey && (
                    <div
                      role="alertdialog"
                      aria-label="Confirm delete passkey"
                      className="p-3.5 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                    >
                      <span className="text-red-900 dark:text-red-200 font-medium">
                        {isZh
                          ? `确认删除 Passkey「${confirmDeletePasskey.label}」？`
                          : `Delete Passkey "${confirmDeletePasskey.label}"?`}
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
                          {deletingPasskeyId === confirmDeletePasskey.id ? '...' : isZh ? '确认删除' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  )}

                  {factorUserPasskeys.length === 0 ? (
                    <div className="p-4 rounded-lg border border-dashed border-slate-200 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400">
                      {isZh
                        ? '该用户暂未绑定 Passkey。可在下方使用当前浏览器的 TouchID / FaceID / Windows Hello / YubiKey 立即绑定。'
                        : 'No Passkeys registered for this account yet. Register one below (requires HTTPS or localhost).'}
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
                      disabled={!authPolicy.enablePasskeysWebAuthn}
                      value={passkeyLabel}
                      onChange={(e) => setPasskeyLabel(e.target.value)}
                      placeholder={isZh ? '设备备注名（如 MacBook TouchID / YubiKey）' : 'Authenticator label'}
                      aria-label="Passkey label"
                      className="flex-1 min-h-[38px] px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-50"
                    />
                    <button
                      type="submit"
                      disabled={registeringPasskey || !authPolicy.enablePasskeysWebAuthn}
                      className="min-h-[38px] px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
                    >
                      <Fingerprint className="w-3.5 h-3.5" />
                      <span>
                        {registeringPasskey
                          ? isZh
                            ? '等待设备验证...'
                            : 'Waiting...'
                          : isZh
                            ? '添加并绑定新 Passkey'
                            : 'Register New Passkey'}
                      </span>
                    </button>
                  </form>
                </div>
              )}

              {/* TAB 3: Local Password */}
              {factorTab === 'password' && (
                <div className="space-y-4">
                  {!authPolicy.enablePasswordArgon2id && (
                    <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
                      <Lock className="w-4 h-4 shrink-0" />
                      <span>
                        {isZh
                          ? '管理员已在全局安全策略中禁用密码登录。'
                          : 'Password sign-in is disabled globally in Security Policy.'}
                      </span>
                    </div>
                  )}

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
                          disabled={!authPolicy.enablePasswordArgon2id}
                          value={resetPwd}
                          onChange={(e) => setResetPwd(e.target.value)}
                          className="w-full min-h-[38px] px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-50"
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
                          disabled={!authPolicy.enablePasswordArgon2id}
                          value={resetPwdConfirm}
                          onChange={(e) => setResetPwdConfirm(e.target.value)}
                          className="w-full min-h-[38px] px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-50"
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
                            {isZh ? '清除本地密码' : 'Clear Local Password'}
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
                          {isZh ? '当前未设置本地密码（纯免密 / 第三方登录账号）' : 'No local password set.'}
                        </span>
                      )}

                      <button
                        type="submit"
                        disabled={savingPwd || !authPolicy.enablePasswordArgon2id}
                        className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-medium"
                      >
                        {savingPwd ? '...' : isZh ? '保存密码' : 'Save Password'}
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {/* TAB 4: TOTP 2FA (QR Code Popup Modal flow) */}
              {factorTab === 'totp' && (
                <div className="space-y-4 text-xs">
                  {!authPolicy.enableTotp2fa ? (
                    <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60 text-amber-800 dark:text-amber-300 flex items-center gap-2">
                      <Lock className="w-4 h-4 shrink-0" />
                      <span>
                        {isZh
                          ? '管理员已在「安全策略」中全局禁用了 TOTP 2FA，用户无权启用或绑定验证器。'
                          : 'TOTP 2FA is disabled globally in Security Policy. Users cannot enable or enroll authenticators.'}
                      </span>
                    </div>
                  ) : factorUser.totpEnabled ? (
                    <div className="p-4 rounded-lg bg-emerald-50/70 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="space-y-1">
                        <div className="font-semibold text-emerald-900 dark:text-emerald-300 flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4" />
                          <span>{isZh ? 'TOTP 动态口令（2FA）已开启' : 'TOTP 2FA is Active'}</span>
                        </div>
                        <p className="text-emerald-800/80 dark:text-emerald-300/80">
                          {isZh
                            ? '如果用户遗失手机验证器，可在此一键禁用并重置其 TOTP 绑定。'
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
                  ) : (
                    <div className="p-5 rounded-lg border border-dashed border-slate-200 dark:border-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {isZh ? '使用身份验证器 App 扫码绑定' : 'Bind via Authenticator App QR Code'}
                        </div>
                        <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                          {isZh
                            ? '点击右侧按钮将弹出标准二维码窗口，用 Google / Microsoft Authenticator 或 1Password 扫描并输入 6 位数字确认即可完成绑定。'
                            : 'Click the button to open a scannable QR code popup. Scan with your authenticator app and enter the 6-digit code to finish.'}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={totpBusy}
                        onClick={() => void handleStartTotpEnrollPopup()}
                        className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                      >
                        <QrCode className="w-4 h-4" />
                        <span>{totpBusy ? '...' : isZh ? '扫码绑定 TOTP' : 'Scan QR to Add TOTP'}</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ==================== MODAL 5: Real Scannable QR Code TOTP Popup ==================== */}
      <TotpEnrollModal
        open={totpModalOpen}
        locale={locale}
        draft={totpModalDraft}
        busy={totpBusy}
        error={totpModalError}
        verifiedRecoveryCodes={totpVerifiedCodes}
        onClose={() => {
          setTotpModalOpen(false);
          setTotpModalDraft(null);
          setTotpModalError(null);
          setTotpVerifiedCodes(null);
        }}
        onVerify={handleVerifyTotpCode}
      />
    </div>
  );
}
