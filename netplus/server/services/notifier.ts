import nodemailer from 'nodemailer';
import type { NotificationEventType } from '../../src/types/models.ts';
import { validateSafeExternalUrl } from '../lib/crypto.ts';
import { store, type StoredNotificationChannel } from '../lib/store.ts';

export interface DispatchNotificationPayload {
  event: NotificationEventType;
  title: string;
  message: string;
  channelIds?: string[]; // Optional override list; empty = all enabled channels subscribed to event
  actor?: string;
  ip?: string;
}

export interface ChannelDispatchResult {
  channelId: string;
  channelName: string;
  type: string;
  ok: boolean;
  message: string;
}

async function sendViaEmail(
  channel: StoredNotificationChannel,
  secret: string,
  title: string,
  message: string
): Promise<{ ok: boolean; message: string }> {
  if (!channel.smtpHost || !channel.emailTo) {
    return { ok: false, message: 'Missing SMTP host or recipient email address' };
  }

  const port = Number(channel.smtpPort) || 465;
  const secure = channel.smtpSecure ?? port === 465;

  const transporter = nodemailer.createTransport({
    host: channel.smtpHost.trim(),
    port,
    secure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    ...(channel.smtpUser
      ? {
          auth: {
            user: channel.smtpUser.trim(),
            pass: secret,
          },
        }
      : {}),
  });

  const info = await transporter.sendMail({
    from: channel.emailFrom?.trim() || channel.smtpUser?.trim() || 'netplus@localhost',
    to: channel.emailTo.trim(),
    subject: `[NetPlus] ${title}`,
    text: message,
  });

  return { ok: true, message: `Email accepted (${info.messageId || 'SMTP OK'})` };
}

function sanitizeTelegramBotToken(raw: string): { token?: string; error?: string } {
  let token = (raw || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^['"`]+|['"`]+$/g, '')
    .trim();

  // Strip full Telegram API URL if pasted accidentally
  const urlMatch = token.match(/api\.telegram\.org\/bot([^/?#\s]+)/i);
  if (urlMatch) {
    token = urlMatch[1];
  }
  // Strip accidental leading "bot" prefix (e.g. "bot123456:AAH...")
  if (/^bot\d+:/i.test(token)) {
    token = token.slice(3);
  }
  token = token.replace(/\s+/g, '');

  if (!token) {
    return { error: '未配置 Telegram Bot Token（请重新编辑渠道并保存 Bot Token）' };
  }
  if (!/^\d{4,20}:[A-Za-z0-9_-]{20,128}$/.test(token)) {
    return {
      error:
        'Telegram Bot Token 格式不正确（应为类似 123456789:AAHxxx... 的完整 Token，请勿包含空格或多余前缀）',
    };
  }
  return { token };
}

function parseTelegramChatIds(raw: string): string[] {
  const cleaned = (raw || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/，|；/g, ',')
    .trim();
  if (!cleaned) return [];

  return cleaned
    .split(/[\s,;]+/)
    .map((part) =>
      part
        .trim()
        // Strip accidental prefixes copied from @userinfobot (e.g. "id:5122262412" / "chat_id=5122262412")
        .replace(/^(?:chat_?id|user_?id|id)\s*[:=：]\s*/i, '')
        .replace(/^['"`]+|['"`]+$/g, '')
        .trim()
    )
    .filter((id) => Boolean(id) && !/^(?:chat_?id|user_?id|id)[:=：]?$/i.test(id));
}

function formatTelegramError(status: number, description?: string): string {
  const desc = (description || '').trim();
  const lower = desc.toLowerCase();
  if (status === 401 || lower.includes('unauthorized')) {
    return `Telegram 鉴权失败 (401 Unauthorized)：Bot Token 无效或已被重置，请在 @BotFather 核对后重新保存`;
  }
  if (lower.includes('chat not found')) {
    return `Telegram 发送失败 (chat not found)：找不到目标 Chat ID。私聊用户 ID 请先向该 Bot 发送一次 /start；群组或频道请先将 Bot 拉入并赋予发言权限`;
  }
  if (lower.includes('bot was blocked')) {
    return `Telegram 发送失败 (bot was blocked)：该 Bot 已被用户停用或拉黑，请在 Telegram 中重新启用并发送 /start`;
  }
  if (lower.includes('group chat was upgraded')) {
    return `Telegram 发送失败：该群组已升级为超级群组，请使用新的 -100 开头的群组 ID`;
  }
  if (status === 404 || lower === 'not found') {
    return `Telegram API 返回 404 Not Found：请检查 Bot Token 格式是否正确（形如 123456789:AAHxxx）`;
  }
  return desc ? `Telegram API 错误 (HTTP ${status}): ${desc}` : `Telegram HTTP ${status}`;
}

async function sendViaTelegram(
  channel: StoredNotificationChannel,
  secret: string,
  title: string,
  message: string
): Promise<{ ok: boolean; message: string }> {
  const tokenCheck = sanitizeTelegramBotToken(secret);
  if (!tokenCheck.token) {
    return { ok: false, message: tokenCheck.error || 'Missing Telegram Bot Token' };
  }

  const chatIds = parseTelegramChatIds(channel.target || '');
  if (chatIds.length === 0) {
    return {
      ok: false,
      message: '请填写 Telegram Chat ID（支持个人用户 ID、群组 ID、频道 ID 或 @频道用户名）',
    };
  }

  // IMPORTANT: Do NOT encodeURIComponent the bot token — Telegram Bot API requires the literal ':' separator!
  const endpoint = `https://api.telegram.org/bot${tokenCheck.token}/sendMessage`;
  const text = `${title}\n\n${message}`;
  const successes: string[] = [];
  const failures: string[] = [];

  for (const chatId of chatIds) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(12_000),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
      };
      if (res.ok && json.ok) {
        successes.push(chatId);
      } else {
        const msg = formatTelegramError(res.status, json.description);
        console.warn(`[NetPlus][Notify][Telegram] Failed for chat_id="${chatId}": ${msg}`);
        failures.push(chatIds.length > 1 ? `[${chatId}] ${msg}` : msg);
      }
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const hint =
        rawMsg.toLowerCase().includes('timeout') || rawMsg.toLowerCase().includes('aborted')
          ? '连接 api.telegram.org 超时，请确认部署服务器网络可直接访问 Telegram API'
          : `连接 api.telegram.org 失败 (${rawMsg})，请确认服务器网络可访问 Telegram API`;
      console.warn(`[NetPlus][Notify][Telegram] Network error for chat_id="${chatId}": ${rawMsg}`);
      failures.push(chatIds.length > 1 ? `[${chatId}] ${hint}` : hint);
    }
  }

  if (failures.length === 0) {
    return {
      ok: true,
      message:
        successes.length > 1
          ? `Telegram 消息已发送至 ${successes.length} 个目标 (${successes.join(', ')})`
          : `Telegram 消息发送成功 (Chat ID: ${successes[0]})`,
    };
  }
  if (successes.length > 0) {
    return {
      ok: false,
      message: `部分成功 (${successes.join(', ')})，失败：${failures.join(' ; ')}`,
    };
  }
  return { ok: false, message: failures.join(' ; ') };
}

async function sendViaServerChan(
  channel: StoredNotificationChannel,
  sendKey: string,
  title: string,
  message: string
): Promise<{ ok: boolean; message: string }> {
  if (!sendKey) {
    return { ok: false, message: 'Missing ServerChan SendKey' };
  }

  let endpoint = `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`;
  // Auto-route Server酱³ SendKey (format: sctp{uid}t...)
  const sc3Match = sendKey.match(/^sctp(\d+)t/i);
  if (channel.serverChanVersion === 'sc3' || sc3Match) {
    if (sc3Match) {
      endpoint = `https://${sc3Match[1]}.push.ft07.com/send/${encodeURIComponent(sendKey)}.send`;
    } else if (channel.target) {
      const check = validateSafeExternalUrl(channel.target);
      if (!check.valid) return { ok: false, message: `Blocked URL: ${check.reason}` };
      endpoint = channel.target.trim();
    }
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: title.slice(0, 32),
      desp: message,
    }),
  });

  const data = (await res.json().catch(() => ({}))) as { code?: number; message?: string; info?: string };
  if (res.ok && (data.code === 0 || data.code === undefined)) {
    return { ok: true, message: 'Server酱 pushed successfully' };
  }
  return {
    ok: false,
    message: data.message || data.info || `ServerChan HTTP ${res.status}`,
  };
}

async function sendViaChannel(
  channel: StoredNotificationChannel,
  title: string,
  message: string
): Promise<{ ok: boolean; message: string }> {
  const secret = store.getNotificationSecret(channel.id);

  try {
    if (channel.type === 'email') {
      return await sendViaEmail(channel, secret, title, message);
    }

    if (channel.type === 'serverchan') {
      return await sendViaServerChan(channel, secret, title, message);
    }

    if (channel.type === 'telegram') {
      return await sendViaTelegram(channel, secret, title, message);
    }

    if (!channel.target?.trim()) {
      return { ok: false, message: 'Missing webhook or push target URL' };
    }

    const urlCheck = validateSafeExternalUrl(channel.target);
    if (!urlCheck.valid) {
      return { ok: false, message: `Blocked target URL: ${urlCheck.reason}` };
    }

    if (channel.type === 'bark') {
      const res = await fetch(channel.target.trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body: message }),
      });
      return res.ok
        ? { ok: true, message: `Bark push delivered (HTTP ${res.status})` }
        : { ok: false, message: `Bark HTTP ${res.status}` };
    }

    if (channel.type === 'discord') {
      const res = await fetch(channel.target.trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `**${title}**\n${message}` }),
      });
      return res.ok
        ? { ok: true, message: `Discord webhook delivered (HTTP ${res.status})` }
        : { ok: false, message: `Discord HTTP ${res.status}` };
    }

    // Generic webhook
    const res = await fetch(channel.target.trim(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({
        source: 'NetPlus',
        title,
        message,
        timestamp: new Date().toISOString(),
      }),
    });
    return res.ok
      ? { ok: true, message: `Webhook delivered (HTTP ${res.status})` }
      : { ok: false, message: `Webhook HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Notification dispatch error',
    };
  }
}

export async function dispatchSystemNotification(
  payload: DispatchNotificationPayload
): Promise<ChannelDispatchResult[]> {
  const channels = store.getState().notificationChannels.filter((ch) => {
    if (!ch.enabled) return false;
    if (payload.channelIds && payload.channelIds.length > 0) {
      return payload.channelIds.includes(ch.id);
    }
    return ch.events.includes(payload.event);
  });

  const results: ChannelDispatchResult[] = [];
  const now = new Date().toISOString();

  for (const ch of channels) {
    const r = await sendViaChannel(ch, payload.title, payload.message);
    ch.lastSentAt = now;
    ch.lastStatus = r.ok ? 'ok' : 'error';
    ch.lastMessage = r.message;
    ch.updatedAt = now;

    results.push({
      channelId: ch.id,
      channelName: ch.name,
      type: ch.type,
      ok: r.ok,
      message: r.message,
    });
  }

  if (results.length > 0) {
    store.save();
    store.appendAudit({
      category: 'notify',
      severity: results.every((r) => r.ok) ? 'success' : 'warning',
      action: 'SYSTEM_NOTIFY_DISPATCH',
      actor: payload.actor || 'system',
      ip: payload.ip || '127.0.0.1',
      target: payload.event,
      details: results.map((r) => `${r.channelName}(${r.type}):${r.ok ? 'OK' : r.message}`).join(' | '),
    });
  }

  return results;
}

export async function testNotificationChannel(
  channelId: string,
  actor: string,
  ip: string
): Promise<ChannelDispatchResult | null> {
  const ch = store.getState().notificationChannels.find((c) => c.id === channelId);
  if (!ch) return null;

  const now = new Date().toISOString();
  const r = await sendViaChannel(
    ch,
    'NetPlus Notification Test',
    `Test alert triggered by ${actor} at ${now}.\nChannel: ${ch.name} (${ch.type})`
  );

  ch.lastSentAt = now;
  ch.lastStatus = r.ok ? 'ok' : 'error';
  ch.lastMessage = r.message;
  ch.updatedAt = now;
  store.save();

  store.appendAudit({
    category: 'notify',
    severity: r.ok ? 'success' : 'error',
    action: 'NOTIFY_CHANNEL_TEST',
    actor,
    ip,
    target: `${ch.name} (${ch.type})`,
    details: r.message,
  });

  return {
    channelId: ch.id,
    channelName: ch.name,
    type: ch.type,
    ok: r.ok,
    message: r.message,
  };
}
