import React, { useEffect, useState } from 'react';
import { BellRing, Send, Trash2, RefreshCw, Plus, Webhook, RotateCw } from 'lucide-react';
import {
  api,
  type NotifyChannelConfig,
  type NotifyChannelRecord,
  type NotifyChannelType,
  type NotifyLogRecord,
  type OverviewData,
  type PersonalWebhookInfo,
  type ScanSummary,
  type UserProfile,
  type WebhookRelayResult,
} from '../lib/api';
import type { LocaleDict } from '../lib/i18n';
import { formatUnixUtc, parseAdvanceDays, parseJsonNumberArray } from '../lib/pki-utils';
import { CodeBlock, CopyButton } from './CopyButton';

interface NotificationsViewProps {
  t: LocaleDict;
  overview?: OverviewData | null;
  currentUser?: UserProfile | null;
}

export const NotificationsView: React.FC<NotificationsViewProps> = ({
  t,
  overview,
  currentUser,
}) => {
  const [channels, setChannels] = useState<NotifyChannelRecord[]>([]);
  const [logs, setLogs] = useState<NotifyLogRecord[]>([]);
  const [webhookInfo, setWebhookInfo] = useState<PersonalWebhookInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanSummary, setScanSummary] = useState<ScanSummary | null>(null);
  const [error, setError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');

  // Personal Webhook live test state
  const [rotatingKey, setRotatingKey] = useState(false);
  const [whTitle, setWhTitle] = useState('Production Backup Completed');
  const [whDesp, setWhDesp] = useState('**Host**: `db-prod-01`\n\nAll snapshots verified and uploaded.');
  const [whTags, setWhTags] = useState('Ops|PKI');
  const [whSending, setWhSending] = useState(false);
  const [whResult, setWhResult] = useState<WebhookRelayResult | null>(null);

  // New channel form
  const [name, setName] = useState('');
  const [channelType, setChannelType] = useState<NotifyChannelType>('serverchan');
  const [advanceDaysText, setAdvanceDaysText] = useState('30, 7, 1');
  const [enabled, setEnabled] = useState(true);

  // Provider-specific fields
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [toEmails, setToEmails] = useState('');
  const [useTls, setUseTls] = useState(true);
  const [sendKey, setSendKey] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [saving, setSaving] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [chRes, logRes, whRes] = await Promise.all([
        api.listNotifyChannels(),
        api.listNotifyLogs(),
        api.getMyWebhook().catch(() => null),
      ]);
      setChannels(chRes.channels || []);
      setLogs(logRes.logs || []);
      if (whRes?.webhook) {
        setWebhookInfo(whRes.webhook);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notification data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleRotateWebhookKey = async () => {
    setRotatingKey(true);
    setError('');
    setStatusMsg('');
    try {
      const res = await api.rotateMyWebhookKey();
      setWebhookInfo(res.webhook);
      setStatusMsg('Personal webhook key rotated. Update scripts with the new URL.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rotate webhook key');
    } finally {
      setRotatingKey(false);
    }
  };

  const handleSendWebhookTest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!whTitle.trim()) return;
    setWhSending(true);
    setError('');
    setWhResult(null);
    try {
      const res = await api.sendWebhookMessage({
        title: whTitle.trim(),
        desp: whDesp,
        tags: whTags.trim() || undefined,
      });
      setWhResult(res);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Webhook test failed');
    } finally {
      setWhSending(false);
    }
  };

  const handleSaveChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setStatusMsg('');

    let config: NotifyChannelConfig = {};
    if (channelType === 'email') {
      config = {
        smtp_host: smtpHost.trim(),
        smtp_port: smtpPort,
        smtp_user: smtpUser.trim(),
        smtp_password: smtpPass,
        from_email: fromEmail.trim(),
        to_emails: toEmails.trim(),
        use_tls: useTls,
      };
    } else if (channelType === 'serverchan') {
      config = {
        sendkey: sendKey.trim(),
        custom_url: customUrl.trim() || undefined,
      };
    } else if (channelType === 'telegram') {
      config = {
        bot_token: botToken.trim(),
        chat_id: chatId.trim(),
      };
    } else if (channelType === 'webhook') {
      config = {
        webhook_url: webhookUrl.trim(),
        webhook_secret: webhookSecret.trim() || undefined,
      };
    }

    setSaving(true);
    try {
      await api.saveNotifyChannel({
        name: name.trim() || `${t.notifications.types[channelType]} Alert`,
        channel_type: channelType,
        config,
        advance_days: parseAdvanceDays(advanceDaysText),
        enabled,
      });
      setName('');
      setSendKey('');
      setBotToken('');
      setSmtpPass('');
      setWebhookSecret('');
      setStatusMsg('Notification channel saved.');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save channel');
    } finally {
      setSaving(false);
    }
  };

  const handleTestChannel = async (id: string) => {
    setError('');
    setStatusMsg('');
    try {
      const res = await api.testNotifyChannel(id);
      setStatusMsg(`Test dispatch: ${res.log.status}${res.log.message ? ` (${res.log.message})` : ''}`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test failed');
    }
  };

  const handleDeleteChannel = async (id: string) => {
    setError('');
    try {
      await api.deleteNotifyChannel(id);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleScanNow = async () => {
    setScanning(true);
    setError('');
    setStatusMsg('');
    try {
      const res = await api.scanExpiring();
      setScanSummary(res.summary);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Expiry scan failed');
    } finally {
      setScanning(false);
    }
  };

  const baseUrl = overview?.base_url || window.location.origin;
  const scUrl = webhookInfo?.serverchan_url || `${baseUrl}/webhook/${currentUser?.username || 'user'}/wkh_YOUR_KEY.send`;
  const restUrl = webhookInfo?.rest_url || `${baseUrl}/api/webhook/send`;

  const scExamples = `# 1. ServerChan-compatible POST (form-urlencoded — identical to sctapi.ftqq.com)
curl -X POST "${scUrl}" \\
  --data-urlencode "title=Disk Alert on node-01" \\
  --data-urlencode "desp=**Usage**: 92% on /data" \\
  --data-urlencode "tags=Infra|Disk"

# 2. ServerChan-compatible GET (quick one-liner for cron/scripts)
curl -G "${scUrl}" \\
  --data-urlencode "title=Cron Job Finished" \\
  --data-urlencode "desp=All checks green"

# 3. JSON POST using your scoped API Token (scope: webhook:send)
curl -X POST "${restUrl}" \\
  -H "Authorization: Bearer wca_YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"CI Deploy","desp":"Release v2.4 deployed","short":"Deploy OK","tags":"CI|Prod"}'`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="font-display text-xl font-bold text-slate-900 wrap-anywhere">
            {t.notifications.title}
          </h2>
          <p className="text-sm text-slate-600 wrap-anywhere">{t.notifications.subtitle}</p>
        </div>
        <button
          type="button"
          disabled={scanning}
          onClick={handleScanNow}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white text-xs font-medium cursor-pointer whitespace-nowrap"
        >
          <RefreshCw className={`w-4 h-4 shrink-0 ${scanning ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span>{scanning ? t.notifications.scanning : t.notifications.scanNow}</span>
        </button>
      </div>

      {/* Personal ServerChan-Compatible Webhook Relay Card */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Webhook className="w-4 h-4 text-teal-700" aria-hidden="true" />
              <h3 className="font-display text-base font-semibold text-slate-900">
                {t.notifications.personalWebhookTitle}
              </h3>
            </div>
            <p className="text-xs text-slate-600 max-w-3xl wrap-anywhere">
              {t.notifications.personalWebhookDesc}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-mono text-slate-600 bg-slate-100 border border-slate-200 px-2.5 py-1.5 rounded-lg">
              Forward Targets: {webhookInfo?.enabled_channels ?? channels.filter((c) => c.enabled).length}
            </span>
            <button
              type="button"
              disabled={rotatingKey}
              onClick={handleRotateWebhookKey}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-medium cursor-pointer whitespace-nowrap"
            >
              <RotateCw className={`w-3.5 h-3.5 ${rotatingKey ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{t.notifications.rotateKey}</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs">
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[11px] font-medium text-slate-500">{t.notifications.serverChanUrlLabel}</div>
              <div dir="ltr" className="font-mono text-slate-900 truncate mt-0.5">{scUrl}</div>
            </div>
            <CopyButton value={scUrl} label={t.common.copy} copiedLabel={t.common.copied} />
          </div>
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[11px] font-medium text-slate-500">{t.notifications.restUrlLabel}</div>
              <div dir="ltr" className="font-mono text-slate-900 truncate mt-0.5">{restUrl}</div>
            </div>
            <CopyButton value={restUrl} label={t.common.copy} copiedLabel={t.common.copied} />
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 pt-2 border-t border-slate-100">
          {/* Interactive Live Webhook Test Sender */}
          <form onSubmit={handleSendWebhookTest} className="xl:col-span-5 space-y-3">
            <div className="text-xs font-semibold text-slate-900">{t.notifications.testWebhookTitle}</div>
            <div>
              <label htmlFor="wh-title" className="block text-[11px] font-medium text-slate-600 mb-1">
                {t.notifications.webhookTitleLabel}
              </label>
              <input
                id="wh-title"
                type="text"
                required
                value={whTitle}
                onChange={(e) => setWhTitle(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="wh-desp" className="block text-[11px] font-medium text-slate-600 mb-1">
                {t.notifications.webhookDespLabel}
              </label>
              <textarea
                id="wh-desp"
                rows={3}
                value={whDesp}
                onChange={(e) => setWhDesp(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label htmlFor="wh-tags" className="block text-[11px] font-medium text-slate-600 mb-1">
                  {t.notifications.webhookTagsLabel}
                </label>
                <input
                  id="wh-tags"
                  type="text"
                  value={whTags}
                  onChange={(e) => setWhTags(e.target.value)}
                  placeholder="PKI|Prod"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={whSending}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-medium cursor-pointer whitespace-nowrap"
              >
                <Send className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{whSending ? '...' : t.notifications.webhookSendBtn}</span>
              </button>
            </div>
            {whResult && (
              <div className="bg-teal-50/70 border border-teal-200 rounded-lg p-3 text-xs space-y-1">
                <div className="font-semibold text-teal-900">
                  Dispatched to {whResult.data.dispatched} channel(s): {whResult.data.succeeded} succeeded, {whResult.data.failed} failed
                </div>
                <div className="font-mono text-[11px] text-teal-800">pushid: {whResult.data.pushid}</div>
              </div>
            )}
          </form>

          {/* ServerChan Format Reference & Snippets */}
          <div className="xl:col-span-7 space-y-3">
            <div>
              <div className="text-xs font-semibold text-slate-900">{t.notifications.webhookFormatTitle}</div>
              <p className="text-[11px] text-slate-600 mt-0.5">{t.notifications.webhookFormatDesc}</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 text-[11px]">
              <div className="bg-slate-50 border border-slate-200 rounded px-2 py-1.5">
                <div className="font-mono font-semibold text-slate-900">title / text</div>
                <div className="text-slate-500">Required (≤256)</div>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded px-2 py-1.5">
                <div className="font-mono font-semibold text-slate-900">desp / content</div>
                <div className="text-slate-500">Markdown body</div>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded px-2 py-1.5">
                <div className="font-mono font-semibold text-slate-900">short</div>
                <div className="text-slate-500">Card summary</div>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded px-2 py-1.5">
                <div className="font-mono font-semibold text-slate-900">tags</div>
                <div className="text-slate-500">Pipe tags (A|B)</div>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded px-2 py-1.5">
                <div className="font-mono font-semibold text-slate-900">channel</div>
                <div className="text-slate-500">Optional filter</div>
              </div>
            </div>
            <CodeBlock
              title="ServerChan Webhook Usage (cURL / Scripts)"
              code={scExamples}
              copyLabel={t.common.copy}
              copiedLabel={t.common.copied}
            />
          </div>
        </div>
      </div>

      {scanSummary && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-2 sm:grid-cols-5 gap-4 text-xs">
          <div>
            <div className="text-slate-500">{t.notifications.scanResult.checked}</div>
            <div className="font-mono text-lg font-bold text-slate-900 tabular-nums">{scanSummary.checked_certs}</div>
          </div>
          <div>
            <div className="text-slate-500">{t.notifications.scanResult.expiring}</div>
            <div className="font-mono text-lg font-bold text-amber-700 tabular-nums">{scanSummary.expiring_found}</div>
          </div>
          <div>
            <div className="text-slate-500">{t.notifications.scanResult.sent}</div>
            <div className="font-mono text-lg font-bold text-emerald-700 tabular-nums">{scanSummary.alerts_sent}</div>
          </div>
          <div>
            <div className="text-slate-500">{t.notifications.scanResult.skipped}</div>
            <div className="font-mono text-lg font-bold text-slate-600 tabular-nums">{scanSummary.alerts_skipped}</div>
          </div>
          <div>
            <div className="text-slate-500">{t.notifications.scanResult.failed}</div>
            <div className="font-mono text-lg font-bold text-red-700 tabular-nums">{scanSummary.alerts_failed}</div>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3 wrap-anywhere">
          {error}
        </div>
      )}
      {statusMsg && (
        <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 wrap-anywhere">
          {statusMsg}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Add Channel Form */}
        <form
          onSubmit={handleSaveChannel}
          className="xl:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4"
        >
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Plus className="w-4 h-4 text-teal-700" aria-hidden="true" />
            <span>{t.notifications.addChannel}</span>
          </div>

          <div>
            <label htmlFor="nc-name" className="block text-xs font-medium text-slate-700 mb-1">
              {t.notifications.channelName}
            </label>
            <input
              id="nc-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ops ServerChan / SRE Telegram"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="nc-type" className="block text-xs font-medium text-slate-700 mb-1">
              {t.notifications.channelType}
            </label>
            <select
              id="nc-type"
              value={channelType}
              onChange={(e) => setChannelType(e.target.value as NotifyChannelType)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
            >
              <option value="serverchan">{t.notifications.types.serverchan}</option>
              <option value="telegram">{t.notifications.types.telegram}</option>
              <option value="email">{t.notifications.types.email}</option>
              <option value="webhook">{t.notifications.types.webhook}</option>
            </select>
          </div>

          <div>
            <label htmlFor="nc-days" className="block text-xs font-medium text-slate-700 mb-1">
              {t.notifications.advanceDays}
            </label>
            <input
              id="nc-days"
              type="text"
              value={advanceDaysText}
              onChange={(e) => setAdvanceDaysText(e.target.value)}
              placeholder="30, 7, 1"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-slate-500 wrap-anywhere">{t.notifications.advanceDaysHint}</p>
          </div>

          {channelType === 'serverchan' && (
            <div className="space-y-3 pt-2 border-t border-slate-100">
              <div>
                <label htmlFor="nc-sendkey" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.notifications.fields.sendKey}
                </label>
                <input
                  id="nc-sendkey"
                  type="password"
                  required
                  value={sendKey}
                  onChange={(e) => setSendKey(e.target.value)}
                  placeholder="SCT..."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="nc-sc-url" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.notifications.fields.customUrl}
                </label>
                <input
                  id="nc-sc-url"
                  type="url"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="https://sctapi.ftqq.com/SCT....send"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                />
              </div>
            </div>
          )}

          {channelType === 'telegram' && (
            <div className="space-y-3 pt-2 border-t border-slate-100">
              <div>
                <label htmlFor="nc-bot" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.notifications.fields.botToken}
                </label>
                <input
                  id="nc-bot"
                  type="password"
                  required
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  placeholder="123456:ABC-DEF..."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="nc-chat" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.notifications.fields.chatId}
                </label>
                <input
                  id="nc-chat"
                  type="text"
                  required
                  value={chatId}
                  onChange={(e) => setChatId(e.target.value)}
                  placeholder="-1001234567890"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                />
              </div>
            </div>
          )}

          {channelType === 'email' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-100">
              <div>
                <label htmlFor="nc-host" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.notifications.fields.smtpHost}
                </label>
                <input
                  id="nc-host"
                  type="text"
                  required
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  placeholder="smtp.company.com"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="nc-port" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.notifications.fields.smtpPort}
                </label>
                <input
                  id="nc-port"
                  type="number"
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="nc-user" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.notifications.fields.smtpUser}
                </label>
                <input
                  id="nc-user"
                  type="text"
                  value={smtpUser}
                  onChange={(e) => setSmtpUser(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="nc-pass" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.notifications.fields.smtpPass}
                </label>
                <input
                  id="nc-pass"
                  type="password"
                  value={smtpPass}
                  onChange={(e) => setSmtpPass(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="nc-from" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.notifications.fields.fromEmail}
                </label>
                <input
                  id="nc-from"
                  type="email"
                  required
                  value={fromEmail}
                  onChange={(e) => setFromEmail(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="nc-to" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.notifications.fields.toEmails}
                </label>
                <input
                  id="nc-to"
                  type="text"
                  required
                  value={toEmails}
                  onChange={(e) => setToEmails(e.target.value)}
                  placeholder="secops@company.com"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <label className="sm:col-span-2 inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useTls}
                  onChange={(e) => setUseTls(e.target.checked)}
                />
                <span>{t.notifications.fields.useTls}</span>
              </label>
            </div>
          )}

          {channelType === 'webhook' && (
            <div className="space-y-3 pt-2 border-t border-slate-100">
              <div>
                <label htmlFor="nc-wh-url" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.notifications.fields.webhookUrl}
                </label>
                <input
                  id="nc-wh-url"
                  type="url"
                  required
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://hooks.slack.com/services/..."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="nc-wh-sec" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.notifications.fields.webhookSecret}
                </label>
                <input
                  id="nc-wh-sec"
                  type="password"
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none"
                />
              </div>
            </div>
          )}

          <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>{t.notifications.enabled}</span>
          </label>

          <button
            type="submit"
            disabled={saving}
            className="w-full py-2.5 rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white text-sm font-medium cursor-pointer"
          >
            {t.notifications.saveChannel}
          </button>
        </form>

        {/* Channels List + Delivery Logs */}
        <div className="xl:col-span-7 space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <BellRing className="w-4 h-4 text-teal-700" aria-hidden="true" />
              <span>{t.notifications.channelType} ({channels.length})</span>
            </div>

            {loading ? (
              <div className="h-20 bg-slate-100 rounded animate-pulse" />
            ) : channels.length === 0 ? (
              <p className="text-xs text-slate-500 py-4">{t.notifications.emptyChannels}</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {channels.map((ch) => {
                  const days = parseJsonNumberArray(ch.advance_days_json);
                  return (
                    <div key={ch.id} className="py-3.5 flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0">
                        <div className="text-sm font-semibold text-slate-900 wrap-anywhere">
                          {ch.name}{' '}
                          <span className="text-xs font-normal text-slate-500">
                            · {t.notifications.types[ch.channel_type] || ch.channel_type}
                            {ch.owner_username ? ` · @${ch.owner_username}` : ''}
                          </span>
                        </div>
                        <div dir="ltr" className="text-xs font-mono text-slate-500 wrap-anywhere text-start">
                          {ch.config_masked}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {t.notifications.advanceDays}: <span className="font-mono text-slate-700">{days.join(', ')}d</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 text-xs shrink-0">
                        <button
                          type="button"
                          onClick={() => handleTestChannel(ch.id)}
                          className="inline-flex items-center gap-1 text-teal-700 hover:text-teal-900 font-medium cursor-pointer"
                        >
                          <Send className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>{t.notifications.testChannel}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteChannel(ch.id)}
                          className="inline-flex items-center gap-1 text-red-700 hover:text-red-900 font-medium cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>{t.notifications.deleteChannel}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <h3 className="font-display text-sm font-semibold text-slate-900">
              {t.notifications.logsTitle}
            </h3>

            {logs.length === 0 ? (
              <p className="text-xs text-slate-500 py-4">{t.notifications.emptyLogs}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-start">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2 pe-3 font-medium text-start">{t.notifications.logColumns.time}</th>
                      <th className="py-2 pe-3 font-medium text-start">{t.notifications.logColumns.channel}</th>
                      <th className="py-2 pe-3 font-medium text-start">{t.notifications.logColumns.certificate}</th>
                      <th className="py-2 pe-3 font-medium text-start">{t.notifications.logColumns.threshold}</th>
                      <th className="py-2 font-medium text-start">{t.notifications.logColumns.status}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {logs.map((row) => (
                      <tr key={row.id} className="hover:bg-slate-50/70">
                        <td className="py-2.5 pe-3 font-mono text-slate-500 whitespace-nowrap tabular-nums">
                          <span dir="ltr" className="inline-block">{formatUnixUtc(row.sent_at)}</span>
                        </td>
                        <td className="py-2.5 pe-3 text-slate-800 wrap-anywhere">
                          {row.channel_name} ({row.channel_type})
                        </td>
                        <td className="py-2.5 pe-3 font-mono text-slate-700 min-w-[200px] whitespace-nowrap">
                          <span dir="ltr" className="inline-block">{row.cert_cn || row.cert_serial}</span>
                        </td>
                        <td className="py-2.5 pe-3 font-mono text-slate-600 whitespace-nowrap tabular-nums">
                          {row.threshold_days > 0 ? `${row.threshold_days}d` : row.cert_serial?.startsWith('webhook:') ? 'webhook' : 'test'}
                        </td>
                        <td className={`py-2.5 font-medium whitespace-nowrap ${
                          row.status === 'failed' ? 'text-red-700' : 'text-emerald-700'
                        }`}>
                          {row.status}
                          {row.status === 'failed' && row.message ? ` (${row.message})` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
