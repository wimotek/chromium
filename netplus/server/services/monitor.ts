import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
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

const safeExternalLookup: net.LookupFunction = (hostname, opts, cb) => {
  const optionsObj = typeof opts === 'number' ? { family: opts } : opts || {};
  dns
    .lookup(hostname, { ...optionsObj, all: true })
    .then((results) => {
      const blocked = results.find((r) => isBlockedPrivateHost(r.address));
      if (blocked) {
        cb(new Error('Resolved private/loopback address is blocked by security policy'), '', 4);
        return;
      }
      if ((optionsObj as { all?: boolean }).all) {
        (cb as unknown as (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void)(
          null,
          results
        );
      } else {
        const first = results[0];
        if (!first) {
          cb(new Error(`No DNS records found for ${hostname}`), '', 4);
          return;
        }
        cb(null, first.address, first.family);
      }
    })
    .catch((err) => {
      cb(err instanceof Error ? err : new Error('DNS lookup failed'), '', 4);
    });
};

interface SingleHttpFetchResult {
  status: number;
  location?: string;
  bodyText: string;
  finalProtocol: 'http:' | 'https:';
}

function executeSingleHttpRequest(
  parsed: URL,
  method: 'GET' | 'HEAD',
  readBody: boolean,
  remainingMs: number,
  ignoreTlsErrors: boolean
): Promise<SingleHttpFetchResult> {
  return new Promise((resolve, reject) => {
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const numericPort = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;
    const isDefaultPort = (isHttps && numericPort === 443) || (!isHttps && numericPort === 80);
    const hostHeader = isDefaultPort ? parsed.hostname : `${parsed.hostname}:${numericPort}`;
    const reqOptions: https.RequestOptions = {
      protocol: parsed.protocol,
      hostname,
      port: Number.isFinite(numericPort) && numericPort > 0 && numericPort <= 65535 ? numericPort : isHttps ? 443 : 80,
      path: `${parsed.pathname || '/'}${parsed.search || ''}`,
      method,
      agent: false,
      timeout: Math.max(500, remainingMs),
      lookup: safeExternalLookup,
      headers: {
        Host: hostHeader,
        'User-Agent': 'Mozilla/5.0 (compatible; NetPulse-Monitor/1.0)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Connection: 'close',
      },
    };
    if (isHttps) {
      reqOptions.rejectUnauthorized = !ignoreTlsErrors;
      if (!net.isIP(hostname)) {
        reqOptions.servername = hostname;
      }
    }

    let settled = false;
    const done = (err: Error | null, result?: SingleHttpFetchResult) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(result!);
    };

    const req = transport.request(reqOptions, (res) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
      const isRedirect = Boolean(location && [301, 302, 303, 307, 308].includes(status));

      if (!readBody || isRedirect || method === 'HEAD') {
        done(null, {
          status,
          location,
          bodyText: '',
          finalProtocol: isHttps ? 'https:' : 'http:',
        });
        res.resume();
        req.destroy();
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const MAX_BODY_BYTES = 65_536;

      res.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (totalBytes < MAX_BODY_BYTES) {
          const remaining = MAX_BODY_BYTES - totalBytes;
          chunks.push(buf.length > remaining ? buf.subarray(0, remaining) : buf);
          totalBytes += buf.length;
        }
        if (totalBytes >= MAX_BODY_BYTES) {
          done(null, {
            status,
            location,
            bodyText: Buffer.concat(chunks).toString('utf8'),
            finalProtocol: isHttps ? 'https:' : 'http:',
          });
          res.destroy();
        }
      });

      res.once('end', () => {
        done(null, {
          status,
          location,
          bodyText: Buffer.concat(chunks).toString('utf8'),
          finalProtocol: isHttps ? 'https:' : 'http:',
        });
      });

      res.once('error', (err) => {
        done(err);
      });
    });

    req.once('timeout', () => {
      req.destroy(new Error(`Request timed out after ${Math.round(remainingMs)}ms`));
    });
    req.once('error', (err) => {
      done(err);
    });
    req.end();
  });
}

async function probeHttp(
  url: string,
  timeoutMs: number,
  options?: {
    httpKeyword?: string;
    expectedStatusCodes?: string;
    ignoreTlsErrors?: boolean;
    httpMethod?: 'GET' | 'HEAD';
  }
): Promise<MonitorCheckSample> {
  const initialCheck = validateSafeExternalUrl(url);
  if (!initialCheck.valid || !initialCheck.parsed) {
    return {
      timestamp: new Date().toISOString(),
      status: 'down',
      latencyMs: 0,
      message: `Blocked URL: ${initialCheck.reason || 'Invalid URL'}`,
    };
  }

  const started = Date.now();
  const maxTimeout = Math.min(30_000, Math.max(1000, timeoutMs));
  const keyword = (options?.httpKeyword || '').trim();
  const requestedMethod: 'GET' | 'HEAD' = options?.httpMethod === 'HEAD' && !keyword ? 'HEAD' : 'GET';
  const ignoreTlsErrors = Boolean(options?.ignoreTlsErrors);
  const MAX_REDIRECTS = 5;

  const runProbeWithMethod = async (
    method: 'GET' | 'HEAD'
  ): Promise<{ res: SingleHttpFetchResult; blockedMsg?: string }> => {
    let currentParsed = initialCheck.parsed!;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const elapsed = Date.now() - started;
      const remaining = maxTimeout - elapsed;
      if (remaining <= 100) {
        throw new Error(`Request timed out after ${maxTimeout}ms`);
      }

      const hopResult = await executeSingleHttpRequest(
        currentParsed,
        method,
        Boolean(keyword),
        remaining,
        ignoreTlsErrors
      );

      if (hopResult.location && [301, 302, 303, 307, 308].includes(hopResult.status)) {
        if (hop === MAX_REDIRECTS) {
          throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
        }
        const nextUrl = new URL(hopResult.location, currentParsed).toString();
        const redirectCheck = validateSafeExternalUrl(nextUrl);
        if (!redirectCheck.valid || !redirectCheck.parsed) {
          return {
            res: hopResult,
            blockedMsg: `Blocked redirect target: ${redirectCheck.reason || 'Unsafe URL'}`,
          };
        }
        currentParsed = redirectCheck.parsed;
        continue;
      }

      return { res: hopResult };
    }
    throw new Error('HTTP probe did not receive a response');
  };

  try {
    let usedFallbackGet = false;
    let outcome = await runProbeWithMethod(requestedMethod);
    if (outcome.blockedMsg) {
      return {
        timestamp: new Date().toISOString(),
        status: 'down',
        latencyMs: Date.now() - started,
        message: outcome.blockedMsg,
      };
    }

    let res = outcome.res;

    // Many web panels / APIs do not implement HEAD and respond 405 or 501; fall back to GET automatically
    if (
      requestedMethod === 'HEAD' &&
      (res.status === 405 || res.status === 501) &&
      !matchesExpectedHttpStatus(res.status, options?.expectedStatusCodes)
    ) {
      const remaining = maxTimeout - (Date.now() - started);
      if (remaining > 500) {
        const retry = await runProbeWithMethod('GET');
        if (!retry.blockedMsg) {
          res = retry.res;
          usedFallbackGet = true;
        }
      }
    }

    const rtt = Date.now() - started;
    const protoLabel = res.finalProtocol === 'https:' ? 'HTTPS' : 'HTTP';
    const tlsTag = res.finalProtocol === 'https:' && ignoreTlsErrors ? ' · TLS ignored' : '';
    const methodTag = usedFallbackGet ? ' · HEAD→GET' : '';
    const expectedLabel = (options?.expectedStatusCodes || '').trim() || '200-399';

    const statusOk = matchesExpectedHttpStatus(res.status, options?.expectedStatusCodes);
    if (!statusOk) {
      return {
        timestamp: new Date().toISOString(),
        status: 'down',
        latencyMs: rtt,
        message: `${protoLabel} ${res.status} (expected ${expectedLabel})${methodTag}${tlsTag}`,
      };
    }

    if (keyword && !res.bodyText.includes(keyword)) {
      return {
        timestamp: new Date().toISOString(),
        status: 'down',
        latencyMs: rtt,
        message: `${protoLabel} ${res.status} missing keyword "${keyword}"${tlsTag}`,
      };
    }

    return {
      timestamp: new Date().toISOString(),
      status: rtt > 1500 ? 'degraded' : 'up',
      latencyMs: rtt,
      message: keyword
        ? `${protoLabel} ${res.status} · keyword matched (${rtt}ms)${tlsTag}`
        : `${protoLabel} ${res.status} (${rtt}ms)${methodTag}${tlsTag}`,
    };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'HTTP probe failed';
    const isTlsErr =
      !ignoreTlsErrors &&
      /self[- ]signed|unable to verify|cert|tls|altnames|hostname\/ip does not match|expired/i.test(rawMsg);
    return {
      timestamp: new Date().toISOString(),
      status: 'down',
      latencyMs: Date.now() - started,
      message: isTlsErr
        ? `${rawMsg} (可开启「忽略 TLS/SSL 证书错误」后重试)`
        : rawMsg,
    };
  }
}

interface TlsCertProbeResult {
  ok: boolean;
  expiryIso?: string;
  daysRemaining?: number;
  issuer?: string;
  subject?: string;
  error?: string;
}

function probeTlsCertificate(urlStr: string, timeoutMs: number): Promise<TlsCertProbeResult> {
  return new Promise((resolve) => {
    const check = validateSafeExternalUrl(urlStr);
    if (!check.valid) {
      resolve({ ok: false, error: check.reason || 'Blocked URL' });
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      resolve({ ok: false, error: 'Invalid HTTPS URL' });
      return;
    }
    if (parsed.protocol !== 'https:') {
      resolve({ ok: false, error: 'Not HTTPS' });
      return;
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (isBlockedPrivateHost(hostname)) {
      resolve({ ok: false, error: 'Private/loopback targets are blocked' });
      return;
    }
    const port = parsed.port ? Number(parsed.port) : 443;
    let settled = false;
    const finish = (result: TlsCertProbeResult, sock?: tls.TLSSocket) => {
      if (settled) return;
      settled = true;
      if (sock) sock.destroy();
      resolve(result);
    };

    const socket = tls.connect({
      host: hostname,
      port: Number.isFinite(port) && port > 0 && port <= 65535 ? port : 443,
      servername: net.isIP(hostname) ? undefined : hostname,
      rejectUnauthorized: false,
      timeout: Math.min(6000, Math.max(1500, timeoutMs)),
    });

    socket.once('secureConnect', () => {
      try {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) {
          finish({ ok: false, error: 'No peer certificate presented' }, socket);
          return;
        }
        const expiryMs = Date.parse(cert.valid_to);
        if (!Number.isFinite(expiryMs)) {
          finish({ ok: false, error: `Unparseable certificate date: ${cert.valid_to}` }, socket);
          return;
        }
        const daysRemaining = Math.floor((expiryMs - Date.now()) / 86_400_000);
        const issuerObj = cert.issuer as Record<string, string | string[]> | undefined;
        const subjectObj = cert.subject as Record<string, string | string[]> | undefined;
        const pickField = (obj: Record<string, string | string[]> | undefined, keys: string[]) => {
          if (!obj) return undefined;
          for (const k of keys) {
            const v = obj[k];
            if (typeof v === 'string' && v.trim()) return v.trim();
            if (Array.isArray(v) && v[0]) return String(v[0]).trim();
          }
          return undefined;
        };
        finish(
          {
            ok: true,
            expiryIso: new Date(expiryMs).toISOString(),
            daysRemaining,
            issuer: pickField(issuerObj, ['O', 'CN']),
            subject: pickField(subjectObj, ['CN', 'O']),
          },
          socket
        );
      } catch (err) {
        finish({ ok: false, error: err instanceof Error ? err.message : 'TLS inspection failed' }, socket);
      }
    });
    socket.once('timeout', () => finish({ ok: false, error: 'TLS handshake timeout' }, socket));
    socket.once('error', (err) => finish({ ok: false, error: err.message }, socket));
  });
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

  let tlsWarningTriggered = false;
  let tlsAlertSummary = '';

  if (monitor.type === 'tcp') {
    sample = await probeTcp(monitor.target, monitor.port || 22, monitor.timeoutMs || 5000);
  } else if (monitor.type === 'http' || monitor.type === 'https') {
    const trimmedTarget = monitor.target.trim();
    const probeUrl = /^https?:\/\//i.test(trimmedTarget)
      ? trimmedTarget
      : `${monitor.type}://${trimmedTarget}`;
    const isHttps = monitor.type === 'https' || probeUrl.toLowerCase().startsWith('https://');
    const ignoreTlsErrors = isHttps && Boolean(monitor.ignoreTlsErrors);

    sample = await probeHttp(probeUrl, monitor.timeoutMs || 6000, {
      httpKeyword: monitor.httpKeyword,
      expectedStatusCodes: monitor.expectedStatusCodes,
      ignoreTlsErrors,
      httpMethod: monitor.httpMethod,
    });

    if (isHttps && monitor.checkTlsCert !== false) {
      const tlsInfo = await probeTlsCertificate(probeUrl, monitor.timeoutMs || 6000);
      monitor.tlsCertCheckedAt = new Date().toISOString();
      if (tlsInfo.ok && typeof tlsInfo.daysRemaining === 'number') {
        monitor.tlsCertExpiry = tlsInfo.expiryIso;
        monitor.tlsDaysRemaining = tlsInfo.daysRemaining;
        monitor.tlsCertIssuer = tlsInfo.issuer;
        monitor.tlsCertSubject = tlsInfo.subject;
        monitor.tlsCertError = undefined;
        // When Ignore TLS/SSL errors is enabled, keep cert metadata for visibility but do not mark probe down/degraded
        if (!ignoreTlsErrors) {
          const warnDays = Math.max(1, Number(monitor.tlsCertWarningDays) || 14);
          if (tlsInfo.daysRemaining <= 0) {
            sample = {
              ...sample,
              status: 'down',
              message: `${sample.message} · SSL证书已过期 (${tlsInfo.daysRemaining}天)`,
            };
            tlsWarningTriggered = true;
            tlsAlertSummary = `SSL 证书已过期（到期日: ${tlsInfo.expiryIso?.slice(0, 10)}）`;
          } else if (tlsInfo.daysRemaining <= warnDays) {
            sample = {
              ...sample,
              status: sample.status === 'down' ? 'down' : 'degraded',
              message: `${sample.message} · SSL证书剩余 ${tlsInfo.daysRemaining} 天`,
            };
            tlsWarningTriggered = true;
            tlsAlertSummary = `SSL 证书仅剩 ${tlsInfo.daysRemaining} 天到期（到期日: ${tlsInfo.expiryIso?.slice(0, 10)}，阈值 ${warnDays} 天）`;
          }
        }
      } else if (tlsInfo.error) {
        monitor.tlsCertError = tlsInfo.error;
      }
    }
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

  // Send TLS certificate expiration alert at most once every 24 hours
  if (tlsWarningTriggered && shouldNotifyDown) {
    const lastAlertMs = monitor.lastTlsAlertAt ? Date.parse(monitor.lastTlsAlertAt) : 0;
    if (!Number.isFinite(lastAlertMs) || Date.now() - lastAlertMs >= 86_400_000) {
      monitor.lastTlsAlertAt = new Date().toISOString();
      store.save();
      await dispatchSystemNotification({
        event: 'monitor_down',
        title: `⚠️ SSL 证书即将到期: ${monitor.name}`,
        message: `监控名称: ${monitor.name}\n目标地址: ${monitor.target}\n证书状态: ${tlsAlertSummary}\n签发机构: ${monitor.tlsCertIssuer || 'Unknown'}`,
        channelIds,
        actor,
        ip,
      });
    }
  }

  return monitor;
}
