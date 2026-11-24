import dns from 'node:dns/promises';
import net from 'node:net';
import type { MonitorCheckSample, MonitorTarget } from '../../src/types/models.ts';
import { validateSafeExternalUrl } from '../lib/crypto.ts';
import { store } from '../lib/store.ts';
import { dispatchSystemNotification } from './notifier.ts';

function isBlockedPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase().trim();
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  if (net.isIPv6(h)) {
    if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) {
      return true;
    }
  }
  return false;
}

export function probeTcp(host: string, port: number, timeoutMs: number): Promise<MonitorCheckSample> {
  const started = Date.now();
  return new Promise((resolve) => {
    if (isBlockedPrivateHost(host)) {
      resolve({
        timestamp: new Date().toISOString(),
        status: 'down',
        latencyMs: 0,
        message: 'Private/loopback probe targets are blocked by security policy',
      });
      return;
    }

    const socket = new net.Socket();
    let settled = false;

    const finish = (status: 'up' | 'degraded' | 'down', message: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        timestamp: new Date().toISOString(),
        status,
        latencyMs: Date.now() - started,
        message,
      });
    };

    socket.setTimeout(Math.min(10_000, Math.max(1000, timeoutMs)));
    socket.once('connect', () => {
      const rtt = Date.now() - started;
      finish(rtt > 800 ? 'degraded' : 'up', `TCP :${port} connected in ${rtt}ms`);
    });
    socket.once('timeout', () => finish('down', `TCP :${port} timed out after ${timeoutMs}ms`));
    socket.once('error', (err) => finish('down', `TCP :${port} error: ${err.message}`));
    socket.connect(port, host);
  });
}

function matchesExpectedHttpStatus(status: number, expectedSpec?: string): boolean {
  const spec = (expectedSpec || '').trim();
  if (!spec) return status >= 200 && status < 400;
  for (const rawPart of spec.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const rangeMatch = part.match(/^(\d{3})\s*-\s*(\d{3})$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      if (status >= lo && status <= hi) return true;
    } else if (/^\d{3}$/.test(part) && status === Number(part)) {
      return true;
    }
  }
  return false;
}

async function probeHttp(
  url: string,
  timeoutMs: number,
  options?: { httpKeyword?: string; expectedStatusCodes?: string }
): Promise<MonitorCheckSample> {
  const check = validateSafeExternalUrl(url);
  if (!check.valid) {
    return {
      timestamp: new Date().toISOString(),
      status: 'down',
      latencyMs: 0,
      message: `Blocked URL: ${check.reason}`,
    };
  }

  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(12_000, Math.max(1000, timeoutMs)));
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });
    const keyword = (options?.httpKeyword || '').trim();
    let bodyText = '';
    if (keyword) {
      bodyText = (await res.text()).slice(0, 65536);
    }
    clearTimeout(timer);
    const rtt = Date.now() - started;

    const statusOk = matchesExpectedHttpStatus(res.status, options?.expectedStatusCodes);
    if (!statusOk) {
      return {
        timestamp: new Date().toISOString(),
        status: 'down',
        latencyMs: rtt,
        message: `HTTP ${res.status} unexpected status`,
      };
    }

    if (keyword && !bodyText.includes(keyword)) {
      return {
        timestamp: new Date().toISOString(),
        status: 'down',
        latencyMs: rtt,
        message: `HTTP ${res.status} missing keyword "${keyword}"`,
      };
    }

    return {
      timestamp: new Date().toISOString(),
      status: rtt > 1500 ? 'degraded' : 'up',
      latencyMs: rtt,
      message: keyword ? `HTTP ${res.status} · keyword matched (${rtt}ms)` : `HTTP ${res.status} (${rtt}ms)`,
    };
  } catch (err) {
    return {
      timestamp: new Date().toISOString(),
      status: 'down',
      latencyMs: Date.now() - started,
      message: err instanceof Error ? err.message : 'HTTP probe failed',
    };
  }
}

async function probeDns(fqdn: string, expectedIp?: string): Promise<MonitorCheckSample> {
  const started = Date.now();
  try {
    const wantV6 = expectedIp ? net.isIPv6(expectedIp.trim()) : false;
    const records = wantV6 ? await dns.resolve6(fqdn.trim()) : await dns.resolve4(fqdn.trim());
    const rtt = Date.now() - started;

    if (expectedIp && expectedIp.trim()) {
      const matched = records.some((r) => r.toLowerCase() === expectedIp.trim().toLowerCase());
      if (!matched) {
        return {
          timestamp: new Date().toISOString(),
          status: 'degraded',
          latencyMs: rtt,
          message: `DNS drift: resolved [${records.slice(0, 2).join(', ')}], expected ${expectedIp}`,
        };
      }
    }

    return {
      timestamp: new Date().toISOString(),
      status: 'up',
      latencyMs: rtt,
      message: `Resolved ${records.slice(0, 2).join(', ')} (${rtt}ms)`,
    };
  } catch (err) {
    return {
      timestamp: new Date().toISOString(),
      status: 'down',
      latencyMs: Date.now() - started,
      message: err instanceof Error ? err.message : 'DNS resolution failed',
    };
  }
}

export async function runMonitorCheck(
  monitorId: string,
  actor = 'monitor',
  ip = '127.0.0.1'
): Promise<MonitorTarget | null> {
  const monitor = store.getState().monitors.find((m) => m.id === monitorId);
  if (!monitor) return null;

  const previousStatus = monitor.status;
  let sample: MonitorCheckSample;

  if (monitor.type === 'tcp') {
    sample = await probeTcp(monitor.target, monitor.port || 22, monitor.timeoutMs || 5000);
  } else if (monitor.type === 'http') {
    sample = await probeHttp(monitor.target, monitor.timeoutMs || 6000, {
      httpKeyword: monitor.httpKeyword,
      expectedStatusCodes: monitor.expectedStatusCodes,
    });
  } else {
    sample = await probeDns(monitor.target, monitor.expectedIp);
  }

  monitor.history.push(sample);
  if (monitor.history.length > 40) {
    monitor.history = monitor.history.slice(-40);
  }

  monitor.lastCheckedAt = sample.timestamp;
  monitor.lastLatencyMs = sample.latencyMs;
  monitor.lastMessage = sample.message;

  if (sample.status === 'down') {
    monitor.consecutiveFailures += 1;
    monitor.status = monitor.consecutiveFailures >= Math.max(1, monitor.failureThreshold) ? 'down' : 'degraded';
  } else {
    monitor.consecutiveFailures = 0;
    monitor.status = sample.status;
  }

  const upCount = monitor.history.filter((s) => s.status !== 'down').length;
  monitor.uptimePercent = Math.round((upCount / Math.max(1, monitor.history.length)) * 1000) / 10;
  monitor.updatedAt = sample.timestamp;
  store.save();

  // Trigger unified System Notifications on state transition (supports independent down/recover toggles & channel routing)
  const shouldNotifyDown = monitor.notifyOnDown !== undefined ? Boolean(monitor.notifyOnDown) : Boolean(monitor.notifyOnAlert);
  const shouldNotifyRecover =
    monitor.notifyOnRecover !== undefined ? Boolean(monitor.notifyOnRecover) : Boolean(monitor.notifyOnAlert);
  const channelIds =
    Array.isArray(monitor.notifyChannelIds) && monitor.notifyChannelIds.length > 0
      ? monitor.notifyChannelIds
      : undefined;

  if (previousStatus !== 'down' && monitor.status === 'down') {
    store.appendAudit({
      category: 'monitor',
      severity: 'error',
      action: 'MONITOR_TARGET_DOWN',
      actor,
      ip,
      target: monitor.name,
      details: `${monitor.type.toUpperCase()} ${monitor.target} -> ${sample.message}`,
    });
    if (shouldNotifyDown) {
      await dispatchSystemNotification({
        event: 'monitor_down',
        title: `🔴 服务下线告警: ${monitor.name}`,
        message: `监控名称: ${monitor.name}\n目标地址: ${monitor.target}\n探测类型: ${monitor.type.toUpperCase()}\n异常原因: ${sample.message}\n可用率: ${monitor.uptimePercent}%`,
        channelIds,
        actor,
        ip,
      });
    }
  } else if (previousStatus === 'down' && (monitor.status === 'up' || monitor.status === 'degraded')) {
    store.appendAudit({
      category: 'monitor',
      severity: 'success',
      action: 'MONITOR_TARGET_RECOVERED',
      actor,
      ip,
      target: monitor.name,
      details: `${monitor.type.toUpperCase()} ${monitor.target} recovered (${sample.latencyMs}ms)`,
    });
    if (shouldNotifyRecover) {
      await dispatchSystemNotification({
        event: 'monitor_recover',
        title: `🟢 服务上线恢复: ${monitor.name}`,
        message: `监控名称: ${monitor.name}\n目标地址: ${monitor.target}\n探测类型: ${monitor.type.toUpperCase()}\n当前延迟: ${sample.latencyMs}ms\n可用率: ${monitor.uptimePercent}%`,
        channelIds,
        actor,
        ip,
      });
    }
  }

  return monitor;
}
