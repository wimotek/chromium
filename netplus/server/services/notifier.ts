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
    from: channel.emailFrom?.trim() || channel.smtpUser?.trim() || 'netpulse@localhost',
    to: channel.emailTo.trim(),
    subject: `[NetPulse] ${title}`,
    text: message,
  });

  return { ok: true, message: `Email accepted (${info.messageId || 'SMTP OK'})` };
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
      if (!secret || !channel.target?.trim()) {
        return { ok: false, message: 'Missing Telegram Bot Token or Chat ID' };
      }
      const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(secret)}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: channel.target.trim(),
          text: `${title}\n\n${message}`,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
      return res.ok && json.ok
        ? { ok: true, message: 'Telegram message delivered' }
        : { ok: false, message: json.description || `Telegram HTTP ${res.status}` };
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
        source: 'NetPulse',
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
    'NetPulse Notification Test',
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
