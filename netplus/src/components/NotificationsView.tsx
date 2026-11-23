import React, { useState } from 'react';
import { Bell, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import { apiRequest, formatTimeAgo } from '../lib/api';
import type {
  LanguageCode,
  NotificationChannel,
  NotificationChannelType,
  NotificationEventType,
} from '../types/models';

interface NotificationsViewProps {
  channels: NotificationChannel[];
  lang: LanguageCode;
  onReload: () => Promise<void>;
}

const CHANNEL_TYPES: Array<{ value: NotificationChannelType; label: string }> = [
  { value: 'email', label: 'Email (SMTP)' },
  { value: 'serverchan', label: 'Server酱 (Turbo / Server酱³)' },
  { value: 'telegram', label: 'Telegram Bot' },
  { value: 'bark', label: 'Bark Push' },
  { value: 'discord', label: 'Discord Webhook' },
  { value: 'webhook', label: 'Custom Webhook' },
];

const ALL_EVENTS: Array<{ id: NotificationEventType; zh: string; en: string }> = [
  { id: 'oci_sniper_success', zh: 'OCI ARM 抢注成功', en: 'OCI ARM Sniper Succeeded' },
  { id: 'oci_sniper_error', zh: 'OCI 抢注鉴权/配置异常', en: 'OCI Sniper Auth/Config Error' },
  { id: 'monitor_down', zh: '节点/IP 监控离线告警', en: 'Monitor Target Down' },
  { id: 'monitor_recover', zh: '节点/IP 监控恢复', en: 'Monitor Target Recovered' },
  { id: 'ip_changed', zh: 'IP 更换变更通知', en: 'IP Swapped / Changed' },
  { id: 'dns_sync_fail', zh: 'DNS 批量同步失败', en: 'DNS Batch Sync Failure' },
  { id: 'audit_prune', zh: '审计日志超限自动清理', en: 'Audit Log Auto-Pruned' },
  { id: 'security_lockout', zh: '防刷安全锁定告警', en: 'Security Login Lockout' },
];

export function NotificationsView({ channels, lang, onReload }: NotificationsViewProps) {
  const isZh = lang === 'zh-CN';
  const [testingId, setTestingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<NotificationChannel | null>(null);

  const [form, setForm] = useState({
    name: '',
    type: 'email' as NotificationChannelType,
    enabled: true,
    events: ['oci_sniper_success', 'monitor_down', 'monitor_recover', 'ip_changed'] as NotificationEventType[],
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    smtpSecure: true,
    smtpUser: '',
    emailFrom: '',
    emailTo: '',
    serverChanVersion: 'turbo' as 'turbo' | 'sc3',
    target: '',
    secret: '',
  });

  const showBanner = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4500);
  };

  const openNew = () => {
    setEditing(null);
    setForm({
      name: '',
      type: 'serverchan',
      enabled: true,
      events: ['oci_sniper_success', 'monitor_down', 'monitor_recover', 'ip_changed'],
      smtpHost: 'smtp.qq.com',
      smtpPort: 465,
      smtpSecure: true,
      smtpUser: '',
      emailFrom: '',
      emailTo: '',
      serverChanVersion: 'turbo',
      target: '',
      secret: '',
    });
    setShowModal(true);
  };

  const openEdit = (ch: NotificationChannel) => {
    setEditing(ch);
    setForm({
      name: ch.name,
      type: ch.type,
      enabled: ch.enabled,
      events: [...ch.events],
      smtpHost: ch.smtpHost ?? 'smtp.qq.com',
      smtpPort: ch.smtpPort ?? 465,
      smtpSecure: ch.smtpSecure ?? true,
      smtpUser: ch.smtpUser ?? '',
      emailFrom: ch.emailFrom ?? '',
      emailTo: ch.emailTo ?? '',
      serverChanVersion: ch.serverChanVersion ?? 'turbo',
      target: ch.target ?? '',
      secret: '',
    });
    setShowModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editing) {
        await apiRequest(`/api/notifications/channels/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify(form),
        });
      } else {
        await apiRequest('/api/notifications/channels', {
          method: 'POST',
          body: JSON.stringify(form),
        });
      }
      setShowModal(false);
      await onReload();
      showBanner(isZh ? '系统通知渠道已保存' : 'System notification channel saved');
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const handleToggle = async (ch: NotificationChannel) => {
    await apiRequest(`/api/notifications/channels/${ch.id}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: !ch.enabled }),
    });
    await onReload();
  };

  const handleTest = async (ch: NotificationChannel) => {
    setTestingId(ch.id);
    try {
      const res = await apiRequest<{ ok: boolean; message: string }>(
        `/api/notifications/channels/${ch.id}/test`,
        { method: 'POST' }
      );
      await onReload();
      showBanner(`${ch.name}: ${res.ok ? 'OK' : 'Error'} — ${res.message}`);
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    await apiRequest(`/api/notifications/channels/${id}`, { method: 'DELETE' });
    await onReload();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {isZh ? '系统统一通知中心' : 'System Notifications Center'}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {isZh
              ? '统一配置 Email (SMTP)、Server酱 (Turbo / Server酱³)、Telegram、Bark、Discord 与 Webhook；OCI ARM 抢注、节点监控、IP 更换与安全告警全部统一调用此处渠道。'
              : 'Configure Email (SMTP), ServerChan (Turbo / SC3), Telegram, Bark, Discord, and Webhooks once—shared across OCI ARM Sniper, Uptime Monitoring, IP Swap, DNS failures, and Security lockouts.'}
          </p>
        </div>

        <button
          type="button"
          onClick={openNew}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap shrink-0 self-start lg:self-auto"
        >
          <Plus className="w-3.5 h-3.5" />
          {isZh ? '添加通知渠道' : 'Add Notification Channel'}
        </button>
      </div>

      {toast && (
        <div className="px-4 py-3 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/70 dark:bg-blue-950/30 text-xs text-blue-700 dark:text-blue-300">
          {toast}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {channels.map((ch) => (
          <div
            key={ch.id}
            className="p-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col justify-between gap-4"
          >
            <div className="space-y-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Bell className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
                    <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white truncate">
                      {ch.name}
                    </h3>
                  </div>
                  <div className="mt-1 text-xs font-mono text-slate-500 dark:text-slate-400">
                    {ch.type.toUpperCase()}
                    {ch.type === 'email' && ch.smtpHost ? ` · ${ch.smtpHost}:${ch.smtpPort ?? 465} -> ${ch.emailTo ?? ''}` : ''}
                    {ch.type === 'serverchan' ? ` · ${ch.serverChanVersion === 'sc3' ? 'Server酱³' : 'Turbo'}` : ''}
                    {ch.target ? ` · ${ch.target}` : ''}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleToggle(ch)}
                  className={`text-xs font-medium whitespace-nowrap shrink-0 ${
                    ch.enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'
                  }`}
                >
                  {ch.enabled ? (isZh ? '已启用' : 'Enabled') : (isZh ? '已停用' : 'Disabled')}
                </button>
              </div>

              <div className="text-xs text-slate-600 dark:text-slate-400">
                <span className="font-medium text-slate-500 mr-1.5">
                  {isZh ? '订阅事件：' : 'Events:'}
                </span>
                {ch.events
                  .map((ev) => {
                    const meta = ALL_EVENTS.find((e) => e.id === ev);
                    return isZh ? meta?.zh ?? ev : meta?.en ?? ev;
                  })
                  .join(' · ')}
              </div>

              <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                {ch.hasSecret
                  ? `${isZh ? '密钥已加密存储' : 'Secret encrypted'} (${ch.secretPreview})`
                  : isZh
                  ? '尚未配置密钥 / SendKey / 授权码'
                  : 'No secret / SendKey configured yet'}
              </div>

              {ch.lastMessage && (
                <div
                  className={`text-[11px] font-mono ${
                    ch.lastStatus === 'ok'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-amber-600 dark:text-amber-400'
                  }`}
                >
                  {formatTimeAgo(ch.lastSentAt)} · {ch.lastMessage}
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={testingId === ch.id}
                onClick={() => void handleTest(ch)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 whitespace-nowrap"
              >
                <Send className="w-3.5 h-3.5" />
                {isZh ? '发送测试' : 'Send Test'}
              </button>
              <button
                type="button"
                onClick={() => openEdit(ch)}
                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(ch.id)}
                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Add/Edit Channel Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-display text-lg font-semibold">
                {editing ? (isZh ? '编辑通知渠道' : 'Edit Channel') : isZh ? '新增通知渠道' : 'Add Channel'}
              </h3>
              <button type="button" onClick={() => setShowModal(false)} className="p-1 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="mt-4 space-y-4 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {isZh ? '渠道名称' : 'Channel Name'}
                  </label>
                  <input
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {isZh ? '通知类型' : 'Channel Type'}
                  </label>
                  <select
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value as NotificationChannelType })}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  >
                    {CHANNEL_TYPES.map((ct) => (
                      <option key={ct.value} value={ct.value}>
                        {ct.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {form.type === 'email' && (
                <div className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-medium mb-1">SMTP Host</label>
                      <input
                        required
                        value={form.smtpHost}
                        onChange={(e) => setForm({ ...form, smtpHost: e.target.value })}
                        placeholder="smtp.qq.com / smtp.gmail.com"
                        className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">SMTP Port</label>
                      <input
                        type="number"
                        value={form.smtpPort}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            smtpPort: Number(e.target.value),
                            smtpSecure: Number(e.target.value) === 465,
                          })
                        }
                        className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium mb-1">SMTP User</label>
                      <input
                        value={form.smtpUser}
                        onChange={(e) => setForm({ ...form, smtpUser: e.target.value })}
                        className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        {isZh ? 'SMTP 密码 / 邮箱授权码' : 'SMTP Password / App Password'}
                      </label>
                      <input
                        type="password"
                        value={form.secret}
                        onChange={(e) => setForm({ ...form, secret: e.target.value })}
                        placeholder={editing?.hasSecret ? 'Leave empty to keep stored password' : ''}
                        className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">From</label>
                      <input
                        value={form.emailFrom}
                        onChange={(e) => setForm({ ...form, emailFrom: e.target.value })}
                        placeholder="NetPulse <ops@example.com>"
                        className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        {isZh ? '收件人邮箱 (多个逗号分隔)' : 'Recipient Email(s)'}
                      </label>
                      <input
                        required
                        value={form.emailTo}
                        onChange={(e) => setForm({ ...form, emailTo: e.target.value })}
                        placeholder="admin@example.com"
                        className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                      />
                    </div>
                  </div>
                  <label className="inline-flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={form.smtpSecure}
                      onChange={(e) => setForm({ ...form, smtpSecure: e.target.checked })}
                      className="rounded accent-blue-600"
                    />
                    Implicit SSL/TLS (port 465)
                  </label>
                </div>
              )}

              {form.type === 'serverchan' && (
                <div className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
                  <div>
                    <label className="block text-xs font-medium mb-1">
                      {isZh ? 'Server酱 版本' : 'ServerChan Version'}
                    </label>
                    <select
                      value={form.serverChanVersion}
                      onChange={(e) =>
                        setForm({ ...form, serverChanVersion: e.target.value as 'turbo' | 'sc3' })
                      }
                      className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    >
                      <option value="turbo">Server酱 Turbo (SCT...)</option>
                      <option value="sc3">Server酱³ (sctp...t...)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">SendKey</label>
                    <input
                      type="password"
                      value={form.secret}
                      onChange={(e) => setForm({ ...form, secret: e.target.value })}
                      placeholder={
                        editing?.hasSecret
                          ? 'Leave empty to keep encrypted SendKey'
                          : 'SCTxxxxx or sctp1234t...'
                      }
                      className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    />
                  </div>
                </div>
              )}

              {['telegram', 'bark', 'discord', 'webhook'].includes(form.type) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
                  <div>
                    <label className="block text-xs font-medium mb-1">
                      {form.type === 'telegram' ? 'Telegram Chat ID' : 'Webhook / Push URL'}
                    </label>
                    <input
                      required
                      value={form.target}
                      onChange={(e) => setForm({ ...form, target: e.target.value })}
                      placeholder={form.type === 'telegram' ? '-100123456789' : 'https://...'}
                      className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">
                      {form.type === 'telegram' ? 'Telegram Bot Token' : 'Auth Bearer Secret (Optional)'}
                    </label>
                    <input
                      type="password"
                      value={form.secret}
                      onChange={(e) => setForm({ ...form, secret: e.target.value })}
                      placeholder={editing?.hasSecret ? 'Leave empty to keep stored secret' : ''}
                      className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    />
                  </div>
                </div>
              )}

              {/* Event Subscriptions */}
              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  {isZh ? '触发通知的系统事件' : 'Subscribed System Events'}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  {ALL_EVENTS.map((ev) => (
                    <label key={ev.id} className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form.events.includes(ev.id)}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            events: e.target.checked
                              ? [...prev.events, ev.id]
                              : prev.events.filter((x) => x !== ev.id),
                          }))
                        }
                        className="rounded accent-blue-600"
                      />
                      <span>{isZh ? ev.zh : ev.en}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                <label className="inline-flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                    className="rounded accent-blue-600"
                  />
                  {isZh ? '立即启用该渠道' : 'Enable channel'}
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700"
                  >
                    {isZh ? '取消' : 'Cancel'}
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                  >
                    {isZh ? '保存' : 'Save'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
