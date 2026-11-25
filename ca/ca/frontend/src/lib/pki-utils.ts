export type CertProfile =
  | 'pdf_signing'
  | 'entra_cba'
  | 'tls_server'
  | 'tls_client'
  | 'code_signing'
  | 'smime_email'
  | 'wifi_eap'
  | 'iot_device';

export type UserRole = 'admin' | 'operator' | 'standard' | 'basic';

export const ROLE_DEFAULT_QUOTA: Record<UserRole, number> = {
  admin: -1,
  operator: 50,
  standard: 10,
  basic: 3,
};

export interface ProfileSpec {
  id: CertProfile;
  defaultTtlDays: number;
  maxTtlDays: number;
  keyUsage: string[];
  ekuOids: string[];
  requiresUpn: boolean;
  supportsUpn: boolean;
  requiresSans: boolean;
  supportsSans: boolean;
  requiresEmail: boolean;
  requiresHttpCrl: boolean;
  preferFullNameCn: boolean;
}

export const ALL_PROFILES: CertProfile[] = [
  'entra_cba',
  'pdf_signing',
  'tls_server',
  'tls_client',
  'code_signing',
  'smime_email',
  'wifi_eap',
  'iot_device',
];

export const PROFILE_SPECS: Record<CertProfile, ProfileSpec> = {
  pdf_signing: {
    id: 'pdf_signing',
    defaultTtlDays: 1095,
    maxTtlDays: 3650,
    keyUsage: ['digitalSignature', 'contentCommitment (nonRepudiation)'],
    ekuOids: [
      '1.2.840.113583.1.1.5 (Adobe Authentic Documents Trust)',
      '1.3.6.1.5.5.7.3.36 (RFC 9336 Document Signing)',
      '1.3.6.1.4.1.311.10.3.12 (Microsoft Document Signing)',
    ],
    requiresUpn: false,
    supportsUpn: false,
    requiresSans: false,
    supportsSans: false,
    requiresEmail: false,
    requiresHttpCrl: true,
    preferFullNameCn: true,
  },
  entra_cba: {
    id: 'entra_cba',
    defaultTtlDays: 365,
    maxTtlDays: 1095,
    keyUsage: ['digitalSignature'],
    ekuOids: [
      '1.3.6.1.5.5.7.3.2 (TLS Web Client Authentication)',
      '1.3.6.1.4.1.311.20.2.2 (Microsoft Smart Card Logon)',
      'SAN OtherName 1.3.6.1.4.1.311.20.2.3 (msUPN)',
    ],
    requiresUpn: true,
    supportsUpn: true,
    requiresSans: false,
    supportsSans: false,
    requiresEmail: false,
    requiresHttpCrl: true,
    preferFullNameCn: true,
  },
  tls_server: {
    id: 'tls_server',
    defaultTtlDays: 365,
    maxTtlDays: 825,
    keyUsage: ['digitalSignature', 'keyEncipherment'],
    ekuOids: [
      '1.3.6.1.5.5.7.3.1 (TLS Web Server Authentication)',
      '1.3.6.1.5.5.7.3.2 (TLS Web Client Authentication)',
    ],
    requiresUpn: false,
    supportsUpn: false,
    requiresSans: true,
    supportsSans: true,
    requiresEmail: false,
    requiresHttpCrl: true,
    preferFullNameCn: false,
  },
  tls_client: {
    id: 'tls_client',
    defaultTtlDays: 365,
    maxTtlDays: 1095,
    keyUsage: ['digitalSignature'],
    ekuOids: ['1.3.6.1.5.5.7.3.2 (TLS Web Client Authentication)'],
    requiresUpn: false,
    supportsUpn: false,
    requiresSans: false,
    supportsSans: true,
    requiresEmail: false,
    requiresHttpCrl: true,
    preferFullNameCn: true,
  },
  code_signing: {
    id: 'code_signing',
    defaultTtlDays: 730,
    maxTtlDays: 1825,
    keyUsage: ['digitalSignature'],
    ekuOids: ['1.3.6.1.5.5.7.3.3 (Code Signing)'],
    requiresUpn: false,
    supportsUpn: false,
    requiresSans: false,
    supportsSans: false,
    requiresEmail: false,
    requiresHttpCrl: true,
    preferFullNameCn: true,
  },
  smime_email: {
    id: 'smime_email',
    defaultTtlDays: 730,
    maxTtlDays: 1825,
    keyUsage: ['digitalSignature', 'keyEncipherment'],
    ekuOids: ['1.3.6.1.5.5.7.3.4 (S/MIME Email Protection)'],
    requiresUpn: false,
    supportsUpn: false,
    requiresSans: false,
    supportsSans: false,
    requiresEmail: true,
    requiresHttpCrl: true,
    preferFullNameCn: true,
  },
  wifi_eap: {
    id: 'wifi_eap',
    defaultTtlDays: 365,
    maxTtlDays: 1095,
    keyUsage: ['digitalSignature'],
    ekuOids: ['1.3.6.1.5.5.7.3.2 (802.1X / RADIUS EAP-TLS ClientAuth)'],
    requiresUpn: false,
    supportsUpn: true,
    requiresSans: false,
    supportsSans: true,
    requiresEmail: false,
    requiresHttpCrl: true,
    preferFullNameCn: true,
  },
  iot_device: {
    id: 'iot_device',
    defaultTtlDays: 365,
    maxTtlDays: 1825,
    keyUsage: ['digitalSignature'],
    ekuOids: [
      '1.3.6.1.5.5.7.3.2 (TLS Web Client Authentication)',
      '1.3.6.1.5.5.7.3.1 (TLS Web Server Authentication)',
    ],
    requiresUpn: false,
    supportsUpn: false,
    requiresSans: false,
    supportsSans: true,
    requiresEmail: false,
    requiresHttpCrl: true,
    preferFullNameCn: false,
  },
};

export function parseSanInput(raw: string): string[] {
  const parts = raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set(parts));
}

export function isValidUpn(upn: string): boolean {
  const trimmed = upn.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

export function isValidSanEntry(entry: string): boolean {
  const v = entry.trim();
  if (!v || v.length > 253) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) {
    return v.split('.').every((oct) => Number(oct) >= 0 && Number(oct) <= 255);
  }
  if (v.includes(':') && /^[0-9a-fA-F:]+$/.test(v)) {
    return true;
  }
  return /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(v);
}

export function parseAdvanceDays(raw: string): number[] {
  const nums = raw
    .split(/[\s,;]+/)
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 365);
  const uniq = Array.from(new Set(nums)).sort((a, b) => b - a);
  return uniq.length > 0 ? uniq : [30, 7, 1];
}

export function computeQuotaRemaining(active: number, quota: number): number | null {
  if (quota < 0) return null; // unlimited
  return Math.max(0, quota - Math.max(0, active));
}

export function isQuotaExhausted(active: number, quota: number): boolean {
  if (quota < 0) return false;
  return active >= quota;
}

export function formatUnixUtc(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}

export function formatSerialColon(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return clean.match(/.{1,2}/g)?.join(':') ?? clean;
}

export function computeCertEffectiveStatus(
  status: string,
  notAfter: number,
  nowUnix: number
): 'active' | 'revoked' | 'expired' {
  if (status === 'revoked') return 'revoked';
  if (notAfter <= nowUnix) return 'expired';
  return 'active';
}

export function isExpiringWithinDays(
  status: string,
  notAfter: number,
  nowUnix: number,
  days = 30
): boolean {
  if (status === 'revoked') return false;
  return notAfter > nowUnix && notAfter <= nowUnix + days * 86400;
}

export function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function parseJsonNumberArray(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}
