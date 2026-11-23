import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import type { TlsCertificateStatus } from '../../src/types/models.ts';

export interface SelfSignedCertOptions {
  commonName?: string;
  sanDomains?: string[];
  sanIps?: string[];
  days?: number;
}

const VALID_HOST_PATTERN = /^[a-zA-Z0-9._*-]{1,128}$/;

class TlsCertificateManager {
  private httpsServer: https.Server | null = null;
  private boundApp: Express | null = null;
  private lastLoadedAt?: string;
  private reloadTimer: NodeJS.Timeout | null = null;

  getConfiguredDir(): string {
    return path.resolve(process.env.TLS_CERT_DIR?.trim() || '/certs');
  }

  getCustomCertDir(): string {
    const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || './data');
    return path.join(dataDir, 'certs');
  }

  getHttpsPort(): number {
    return Number(process.env.HTTPS_PORT) || 3443;
  }

  private resolveCertPair(dir: string): { certPath?: string; keyPath?: string } {
    if (!fs.existsSync(dir)) return {};

    const certCandidates = [
      process.env.TLS_CERT_FILE?.trim(),
      path.join(dir, 'fullchain.pem'), // Baota / Let's Encrypt / custom default
      path.join(dir, 'cert.pem'),
      path.join(dir, 'server.crt'),
    ].filter(Boolean) as string[];

    const keyCandidates = [
      process.env.TLS_KEY_FILE?.trim(),
      path.join(dir, 'privkey.pem'), // Baota / Let's Encrypt / custom default
      path.join(dir, 'key.pem'),
      path.join(dir, 'server.key'),
    ].filter(Boolean) as string[];

    const certPath = certCandidates.find((p) => fs.existsSync(p));
    const keyPath = keyCandidates.find((p) => fs.existsSync(p));
    return { certPath, keyPath };
  }

  private resolveActiveSource(): {
    source: 'mounted' | 'self_signed' | 'none';
    activeDir: string;
    stagedFromReadOnly: boolean;
    certPath?: string;
    keyPath?: string;
  } {
    const certDir = this.getConfiguredDir();
    const stagedEnv = process.env.TLS_STAGED_DIR?.trim();

    // Priority 1: Staged Baota /certs:ro copy
    if (stagedEnv && fs.existsSync(stagedEnv)) {
      const stagedDir = path.resolve(stagedEnv);
      const pair = this.resolveCertPair(stagedDir);
      if (pair.certPath && pair.keyPath) {
        return {
          source: 'mounted',
          activeDir: stagedDir,
          stagedFromReadOnly: stagedDir !== certDir,
          ...pair,
        };
      }
    }

    // Priority 2: Direct mounted /certs:ro directory
    const mountedPair = this.resolveCertPair(certDir);
    if (mountedPair.certPath && mountedPair.keyPath) {
      return {
        source: 'mounted',
        activeDir: certDir,
        stagedFromReadOnly: false,
        ...mountedPair,
      };
    }

    // Priority 3: Custom / auto-generated self-signed cert in <DATA_DIR>/certs
    const customDir = this.getCustomCertDir();
    const customPair = this.resolveCertPair(customDir);
    if (customPair.certPath && customPair.keyPath) {
      return {
        source: 'self_signed',
        activeDir: customDir,
        stagedFromReadOnly: false,
        ...customPair,
      };
    }

    return {
      source: 'none',
      activeDir: customDir,
      stagedFromReadOnly: false,
    };
  }

  generateSelfSignedCertificate(options?: SelfSignedCertOptions): {
    ok: boolean;
    message: string;
    status: TlsCertificateStatus;
  } {
    const rawCn = (options?.commonName || 'netpulse.local').trim();
    const cn = VALID_HOST_PATTERN.test(rawCn) ? rawCn : 'netpulse.local';
    const days = Math.min(3650, Math.max(30, Number(options?.days) || 825));

    const dnsSet = new Set<string>(['localhost', 'netpulse.local']);
    if (net.isIP(cn) === 0 && VALID_HOST_PATTERN.test(cn)) {
      dnsSet.add(cn);
    }
    const hostName = os.hostname().trim();
    if (VALID_HOST_PATTERN.test(hostName) && net.isIP(hostName) === 0) {
      dnsSet.add(hostName);
    }
    for (const d of options?.sanDomains ?? []) {
      const clean = d.trim();
      if (clean && VALID_HOST_PATTERN.test(clean) && net.isIP(clean) === 0) {
        dnsSet.add(clean);
      }
    }

    const ipSet = new Set<string>(['127.0.0.1', '::1']);
    if (net.isIP(cn) !== 0) {
      ipSet.add(cn);
    }
    for (const ip of options?.sanIps ?? []) {
      const clean = ip.trim();
      if (clean && net.isIP(clean) !== 0) {
        ipSet.add(clean);
      }
    }

    const sanEntries = [
      ...Array.from(dnsSet).map((d) => `DNS:${d}`),
      ...Array.from(ipSet).map((ip) => `IP:${ip}`),
    ];

    const customDir = this.getCustomCertDir();
    fs.mkdirSync(customDir, { recursive: true, mode: 0o700 });

    const certPath = path.join(customDir, 'fullchain.pem');
    const keyPath = path.join(customDir, 'privkey.pem');
    const tmpCert = `${certPath}.tmp`;
    const tmpKey = `${keyPath}.tmp`;

    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:prime256v1',
          '-nodes',
          '-keyout',
          tmpKey,
          '-out',
          tmpCert,
          '-days',
          String(days),
          '-subj',
          `/CN=${cn}/O=NetPulse Console`,
          '-addext',
          `subjectAltName=${sanEntries.join(',')}`,
          '-addext',
          'basicConstraints=critical,CA:FALSE',
          '-addext',
          'keyUsage=critical,digitalSignature,keyEncipherment',
          '-addext',
          'extendedKeyUsage=serverAuth',
        ],
        { stdio: 'pipe', timeout: 15_000 }
      );

      fs.chmodSync(tmpKey, 0o600);
      fs.chmodSync(tmpCert, 0o644);
      fs.renameSync(tmpKey, keyPath);
      fs.renameSync(tmpCert, certPath);

      const resolved = this.resolveActiveSource();
      if (resolved.source === 'mounted') {
        return {
          ok: true,
          message: `Generated custom certificate (${cn}, ${days}d) in ${customDir}. Note: mounted /certs:ro currently takes priority.`,
          status: this.inspectStatus(),
        };
      }

      const reload = this.reloadContext();
      return {
        ok: reload.ok,
        message: `Generated custom self-signed TLS certificate (CN=${cn}, ${days}d) · ${reload.message}`,
        status: this.inspectStatus(),
      };
    } catch (err) {
      for (const f of [tmpKey, tmpCert]) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch {
          // ignore cleanup failure
        }
      }
      return {
        ok: false,
        message: `Failed to generate self-signed certificate: ${err instanceof Error ? err.message : 'OpenSSL error'}`,
        status: this.inspectStatus(),
      };
    }
  }

  getActivePublicCertPem(): string | null {
    const resolved = this.resolveActiveSource();
    if (!resolved.certPath) return null;
    try {
      return fs.readFileSync(resolved.certPath, 'utf8');
    } catch {
      return null;
    }
  }

  inspectStatus(): TlsCertificateStatus {
    const certDir = this.getConfiguredDir();
    const customCertDir = this.getCustomCertDir();
    const resolved = this.resolveActiveSource();

    const base: TlsCertificateStatus = {
      enabled: Boolean(resolved.certPath && resolved.keyPath),
      source: resolved.source,
      httpsListening: Boolean(this.httpsServer?.listening),
      httpsPort: this.getHttpsPort(),
      certDir,
      customCertDir,
      activeDir: resolved.activeDir,
      certPath: resolved.certPath,
      keyPath: resolved.keyPath,
      stagedFromReadOnly: resolved.stagedFromReadOnly,
      readable: false,
      lastLoadedAt: this.lastLoadedAt,
    };

    if (!resolved.certPath || !resolved.keyPath) {
      return base;
    }

    try {
      const certPem = fs.readFileSync(resolved.certPath, 'utf8');
      fs.accessSync(resolved.keyPath, fs.constants.R_OK);
      base.readable = true;

      const x509 = new crypto.X509Certificate(certPem);
      const validToDate = new Date(x509.validTo);
      const daysRemaining = Math.floor((validToDate.getTime() - Date.now()) / 86_400_000);
      const sanList = x509.subjectAltName
        ? x509.subjectAltName
            .split(',')
            .map((s) => s.trim().replace(/^(DNS|IP Address):/, ''))
            .filter(Boolean)
        : [];

      base.subject = x509.subject;
      base.issuer = x509.issuer;
      base.sanList = sanList;
      base.validFrom = new Date(x509.validFrom).toISOString();
      base.validTo = validToDate.toISOString();
      base.daysRemaining = daysRemaining;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EACCES' || e.code === 'EPERM') {
        base.permissionIssue =
          'Certificate or private key is not readable by the current process user. Mount Baota certs to /certs:ro and run via the container entrypoint (which safely stages 0600 keys for uid 1001).';
      } else {
        base.permissionIssue = err instanceof Error ? err.message : 'Unable to parse X.509 certificate';
      }
    }

    return base;
  }

  private bindHttpsServer(certPath: string, keyPath: string, label: string) {
    if (!this.boundApp || this.httpsServer) return;
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);

    this.httpsServer = https.createServer({ cert, key }, this.boundApp);
    const port = this.getHttpsPort();
    this.httpsServer.on('error', (err) => {
      console.warn(`[NetPulse] HTTPS listener error on port ${port}:`, err.message);
    });
    this.httpsServer.listen(port, '0.0.0.0', () => {
      this.lastLoadedAt = new Date().toISOString();
      console.log(`[NetPulse] HTTPS listening on https://0.0.0.0:${port} (${label}: ${certPath})`);
    });

    if (!this.reloadTimer) {
      this.reloadTimer = setInterval(() => {
        this.reloadContext();
      }, 6 * 3_600_000);
      this.reloadTimer.unref();
    }
  }

  startHttpsIfAvailable(app: Express): TlsCertificateStatus {
    this.boundApp = app;
    let status = this.inspectStatus();

    // Auto-generate a self-signed certificate when /certs:ro is not mounted
    if (status.source === 'none' && process.env.TLS_AUTO_SELF_SIGNED !== 'false') {
      const gen = this.generateSelfSignedCertificate({
        commonName: process.env.TLS_SELF_SIGNED_CN?.trim() || 'netpulse.local',
        days: Number(process.env.TLS_SELF_SIGNED_DAYS) || 825,
      });
      if (gen.ok) {
        status = gen.status;
      } else {
        console.warn('[NetPulse] Auto self-signed TLS generation skipped:', gen.message);
      }
    }

    if (!status.enabled || !status.readable || !status.certPath || !status.keyPath) {
      return status;
    }

    try {
      this.bindHttpsServer(
        status.certPath,
        status.keyPath,
        status.source === 'mounted' ? 'mounted /certs:ro' : 'custom self-signed'
      );
    } catch (err) {
      console.warn('[NetPulse] Skipped HTTPS startup:', err instanceof Error ? err.message : err);
    }

    return this.inspectStatus();
  }

  reloadContext(): { ok: boolean; message: string; status: TlsCertificateStatus } {
    const status = this.inspectStatus();
    if (!status.enabled || !status.readable || !status.certPath || !status.keyPath) {
      return {
        ok: false,
        message: status.permissionIssue || 'No readable certificate pair found',
        status,
      };
    }

    if (this.httpsServer) {
      try {
        const cert = fs.readFileSync(status.certPath);
        const key = fs.readFileSync(status.keyPath);
        this.httpsServer.setSecureContext({ cert, key });
        this.lastLoadedAt = new Date().toISOString();
        return {
          ok: true,
          message: `Hot-reloaded TLS context (${status.subject ?? status.certPath})`,
          status: this.inspectStatus(),
        };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : 'Failed to reload TLS context',
          status,
        };
      }
    }

    if (this.boundApp) {
      try {
        this.bindHttpsServer(
          status.certPath,
          status.keyPath,
          status.source === 'mounted' ? 'mounted /certs:ro' : 'custom self-signed'
        );
        return {
          ok: true,
          message: `Started HTTPS listener on port ${this.getHttpsPort()} (${status.subject ?? status.certPath})`,
          status: this.inspectStatus(),
        };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : 'Failed to start HTTPS listener',
          status,
        };
      }
    }

    return {
      ok: true,
      message: 'Certificate pair verified on disk',
      status,
    };
  }

  close() {
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    this.httpsServer?.close();
  }
}

export const tlsManager = new TlsCertificateManager();
