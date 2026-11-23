import crypto from 'node:crypto';
import net from 'node:net';
import type {
  OciCompartmentSummary,
  OciDiscoveredInstance,
  OciDiscoveredResources,
  OciImageSummary,
  OciInstanceAction,
  OciRegionSummary,
  OciSubnetSummary,
  OciVnicSummary,
} from '../../src/types/models.ts';
import type { StoredOciProfile } from '../lib/store.ts';

const OCI_REGION_REGEX = /^[a-z]{2}-[a-z0-9-]+-\d+$/;
const OCI_OCID_REGEX = /^ocid1\.[a-z0-9_-]+\.[a-z0-9_-]*\.[a-z0-9_-]*\.[a-zA-Z0-9._-]+$/;

export function isValidOciRegion(region: string): boolean {
  return OCI_REGION_REGEX.test(region.trim().toLowerCase());
}

export function isValidOcid(ocid: string): boolean {
  return OCI_OCID_REGEX.test(ocid.trim());
}

/**
 * Computes the exact OCI API key fingerprint (MD5 of SPKI DER public key,
 * colon-separated lowercase hex — identical to `openssl rsa -pubout -outform DER | openssl md5 -c`).
 */
export function computeOciFingerprint(
  privateKeyPem: string
): { ok: true; fingerprint: string } | { ok: false; error: string } {
  const trimmed = String(privateKeyPem || '').trim();
  if (!trimmed || !trimmed.includes('BEGIN') || !trimmed.includes('PRIVATE KEY')) {
    return { ok: false, error: 'Invalid PEM private key format (expected BEGIN RSA/PRIVATE KEY)' };
  }
  try {
    const pubKey = crypto.createPublicKey(trimmed);
    const der = pubKey.export({ type: 'spki', format: 'der' });
    const md5Hex = crypto.createHash('md5').update(der).digest('hex');
    const pairs = md5Hex.match(/.{2}/g);
    if (!pairs || pairs.length !== 16) {
      return { ok: false, error: 'Failed to derive 16-byte MD5 fingerprint' };
    }
    return { ok: true, fingerprint: pairs.join(':') };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? `Cannot parse PEM private key: ${err.message}` : 'Invalid PEM private key',
    };
  }
}

export function buildOciSignatureHeaders(params: {
  method: string;
  host: string;
  path: string;
  body?: string;
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  privateKeyPem: string;
}): Record<string, string> {
  const dateHeader = new Date().toUTCString();
  const methodLower = params.method.toLowerCase();
  const headersToSign = ['date', '(request-target)', 'host'];
  const signingLines = [
    `date: ${dateHeader}`,
    `(request-target): ${methodLower} ${params.path}`,
    `host: ${params.host}`,
  ];

  const outHeaders: Record<string, string> = {
    date: dateHeader,
    host: params.host,
    accept: 'application/json',
  };

  if (params.body !== undefined) {
    const bodyBuf = Buffer.from(params.body, 'utf8');
    const sha256 = crypto.createHash('sha256').update(bodyBuf).digest('base64');
    outHeaders['content-type'] = 'application/json';
    outHeaders['content-length'] = String(bodyBuf.length);
    outHeaders['x-content-sha256'] = sha256;
    headersToSign.push('content-length', 'content-type', 'x-content-sha256');
    signingLines.push(
      `content-length: ${bodyBuf.length}`,
      'content-type: application/json',
      `x-content-sha256: ${sha256}`
    );
  }

  const signingString = signingLines.join('\n');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingString, 'utf8');
  const signature = signer.sign(params.privateKeyPem, 'base64');

  const keyId = `${params.tenancyOcid}/${params.userOcid}/${params.fingerprint}`;
  outHeaders.authorization = `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${headersToSign.join(' ')}",signature="${signature}"`;
  return outHeaders;
}

export interface OciAuthCredentials {
  region: string;
  tenancyOcid: string;
  userOcid: string;
  compartmentOcid?: string;
  fingerprint: string;
  privateKeyPem: string;
}

export async function ociApiRequest<T = unknown>(params: {
  creds: OciAuthCredentials;
  service: 'identity' | 'iaas';
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  apiPath: string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const region = params.creds.region.trim().toLowerCase();
  if (!isValidOciRegion(region)) {
    return { ok: false, status: 400, error: `Invalid OCI region: ${params.creds.region}` };
  }

  const host = `${params.service}.${region}.oraclecloud.com`;
  const bodyStr = params.body !== undefined ? JSON.stringify(params.body) : undefined;

  let headers: Record<string, string>;
  try {
    headers = buildOciSignatureHeaders({
      method: params.method,
      host,
      path: params.apiPath,
      body: bodyStr,
      tenancyOcid: params.creds.tenancyOcid.trim(),
      userOcid: params.creds.userOcid.trim(),
      fingerprint: params.creds.fingerprint.trim(),
      privateKeyPem: params.creds.privateKeyPem,
    });
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? `OCI request signing failed: ${err.message}` : 'OCI request signing failed',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 15_000);
  try {
    const res = await fetch(`https://${host}${params.apiPath}`, {
      method: params.method,
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { message: text.slice(0, 300) };
      }
    }

    if (!res.ok) {
      const obj = (parsed ?? {}) as Record<string, unknown>;
      const msg = String(obj.message || obj.code || `OCI HTTP ${res.status}`);
      return { ok: false, status: res.status, error: msg };
    }

    return { ok: true, status: res.status, data: parsed as T };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : 'OCI network request failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function buildCredsFromProfile(
  profile: StoredOciProfile,
  privateKeyPem: string
): { ok: true; creds: OciAuthCredentials } | { ok: false; error: string } {
  const fp = computeOciFingerprint(privateKeyPem);
  if (!fp.ok) {
    return { ok: false, error: fp.error };
  }
  return {
    ok: true,
    creds: {
      region: profile.region,
      tenancyOcid: profile.tenancyOcid,
      userOcid: profile.userOcid,
      compartmentOcid: profile.compartmentOcid || profile.tenancyOcid,
      fingerprint: fp.fingerprint,
      privateKeyPem,
    },
  };
}

/**
 * Auto-discovers subscribed regions, accessible compartments, exact Availability Domains,
 * VCN Subnets, and active instance count from live OCI Identity + Core IAAS APIs.
 */
export async function discoverOciResources(params: {
  region: string;
  tenancyOcid: string;
  userOcid: string;
  privateKeyPem: string;
  compartmentOcid?: string;
}): Promise<{ ok: boolean; resources?: OciDiscoveredResources; error?: string }> {
  const fp = computeOciFingerprint(params.privateKeyPem);
  if (!fp.ok) {
    return { ok: false, error: fp.error };
  }

  const tenancyOcid = params.tenancyOcid.trim();
  const userOcid = params.userOcid.trim();
  const compartmentOcid = (params.compartmentOcid || tenancyOcid).trim();

  if (!isValidOcid(tenancyOcid)) {
    return { ok: false, error: 'Invalid Tenancy OCID format (must start with ocid1.tenancy...)' };
  }
  if (!isValidOcid(userOcid)) {
    return { ok: false, error: 'Invalid User OCID format (must start with ocid1.user...)' };
  }

  const creds: OciAuthCredentials = {
    region: params.region.trim().toLowerCase(),
    tenancyOcid,
    userOcid,
    compartmentOcid,
    fingerprint: fp.fingerprint,
    privateKeyPem: params.privateKeyPem,
  };

  // 1. Verify credentials & fetch Availability Domains (required baseline check)
  const adRes = await ociApiRequest<Array<{ name: string }>>({
    creds,
    service: 'identity',
    method: 'GET',
    apiPath: `/20160918/availabilityDomains?compartmentId=${encodeURIComponent(compartmentOcid)}`,
  });
  if (!adRes.ok) {
    return { ok: false, error: `OCI Identity auth/AD lookup failed (HTTP ${adRes.status}): ${adRes.error}` };
  }

  const availabilityDomains = (adRes.data ?? []).map((a) => a.name).filter(Boolean);

  // 2. Fetch Region Subscriptions, Compartments, Subnets, and Instances in parallel
  const [regRes, compRes, subRes, instRes] = await Promise.all([
    ociApiRequest<Array<{ regionName: string; regionKey: string; status: string; isHomeRegion: boolean }>>({
      creds,
      service: 'identity',
      method: 'GET',
      apiPath: `/20160918/tenancies/${encodeURIComponent(tenancyOcid)}/regionSubscriptions`,
    }),
    ociApiRequest<Array<{ id: string; name: string; description?: string; lifecycleState?: string }>>({
      creds,
      service: 'identity',
      method: 'GET',
      apiPath: `/20160918/compartments?compartmentId=${encodeURIComponent(tenancyOcid)}&compartmentIdInSubtree=true&accessLevel=ACCESSIBLE`,
    }),
    ociApiRequest<
      Array<{
        id: string;
        displayName: string;
        cidrBlock: string;
        ipv6CidrBlock?: string;
        prohibitPublicIpOnVnic?: boolean;
        vcnId: string;
        lifecycleState?: string;
      }>
    >({
      creds,
      service: 'iaas',
      method: 'GET',
      apiPath: `/20160918/subnets?compartmentId=${encodeURIComponent(compartmentOcid)}`,
    }),
    ociApiRequest<Array<{ id: string; lifecycleState?: string }>>({
      creds,
      service: 'iaas',
      method: 'GET',
      apiPath: `/20160918/instances?compartmentId=${encodeURIComponent(compartmentOcid)}`,
    }),
  ]);

  const regions: OciRegionSummary[] = (regRes.data ?? [])
    .filter((r) => r.regionName)
    .map((r) => ({
      regionName: r.regionName,
      regionKey: r.regionKey,
      status: r.status,
      isHomeRegion: Boolean(r.isHomeRegion),
    }));

  const compartments: OciCompartmentSummary[] = [
    { id: tenancyOcid, name: 'Root Tenancy (Default)', description: 'Root compartment' },
    ...(compRes.data ?? [])
      .filter((c) => c.lifecycleState === 'ACTIVE')
      .map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
      })),
  ];

  const subnets: OciSubnetSummary[] = (subRes.data ?? [])
    .filter((s) => s.lifecycleState === 'AVAILABLE' || !s.lifecycleState)
    .map((s) => ({
      id: s.id,
      displayName: s.displayName || s.cidrBlock,
      cidrBlock: s.cidrBlock,
      ipv6CidrBlock: s.ipv6CidrBlock,
      isPublic: !s.prohibitPublicIpOnVnic,
      vcnId: s.vcnId,
    }));

  const activeInstances = (instRes.data ?? []).filter(
    (i) => i.lifecycleState && !['TERMINATED', 'TERMINATING'].includes(i.lifecycleState)
  ).length;

  return {
    ok: true,
    resources: {
      fingerprint: fp.fingerprint,
      homeRegion: regions.find((r) => r.isHomeRegion)?.regionName,
      regions,
      compartments,
      availabilityDomains,
      subnets,
      instanceCount: activeInstances,
    },
  };
}

/**
 * Fetches real region-specific OCI Compute OS images matching the chosen shape (e.g. VM.Standard.A1.Flex).
 */
export async function listOciImages(
  profile: StoredOciProfile,
  privateKeyPem: string,
  shape: string
): Promise<{ ok: boolean; images: OciImageSummary[]; error?: string }> {
  const built = buildCredsFromProfile(profile, privateKeyPem);
  if (!built.ok) return { ok: false, images: [], error: built.error };

  const compId = profile.compartmentOcid || profile.tenancyOcid;
  const query = new URLSearchParams({
    compartmentId: compId,
    shape,
    sortBy: 'TIMECREATED',
    sortOrder: 'DESC',
    limit: '30',
  });

  const res = await ociApiRequest<
    Array<{
      id: string;
      displayName: string;
      operatingSystem: string;
      operatingSystemVersion: string;
      timeCreated?: string;
    }>
  >({
    creds: built.creds,
    service: 'iaas',
    method: 'GET',
    apiPath: `/20160918/images?${query.toString()}`,
  });

  if (!res.ok) {
    return { ok: false, images: [], error: res.error || `OCI HTTP ${res.status}` };
  }

  const images: OciImageSummary[] = (res.data ?? []).map((img) => ({
    id: img.id,
    displayName: img.displayName,
    operatingSystem: img.operatingSystem,
    operatingSystemVersion: img.operatingSystemVersion,
    timeCreated: img.timeCreated,
  }));

  return { ok: true, images };
}

/**
 * Discovers live OCI Instances, attached VNICs, Primary Private IP IDs,
 * Public IPv4 (with publicIpId & lifetime), and all attached IPv6 addresses (with ipv6Id).
 */
export async function discoverOciInstanceVnics(
  profile: StoredOciProfile,
  privateKeyPem: string
): Promise<{ ok: boolean; vnics: OciVnicSummary[]; error?: string }> {
  const built = buildCredsFromProfile(profile, privateKeyPem);
  if (!built.ok) return { ok: false, vnics: [], error: built.error };

  const compId = profile.compartmentOcid || profile.tenancyOcid;

  const [instRes, attachRes] = await Promise.all([
    ociApiRequest<
      Array<{
        id: string;
        displayName: string;
        shape: string;
        lifecycleState: string;
        availabilityDomain: string;
      }>
    >({
      creds: built.creds,
      service: 'iaas',
      method: 'GET',
      apiPath: `/20160918/instances?compartmentId=${encodeURIComponent(compId)}`,
    }),
    ociApiRequest<
      Array<{
        id: string;
        instanceId: string;
        vnicId: string;
        lifecycleState: string;
      }>
    >({
      creds: built.creds,
      service: 'iaas',
      method: 'GET',
      apiPath: `/20160918/vnicAttachments?compartmentId=${encodeURIComponent(compId)}`,
    }),
  ]);

  if (!instRes.ok) {
    return { ok: false, vnics: [], error: instRes.error || `OCI instances lookup failed (${instRes.status})` };
  }
  if (!attachRes.ok) {
    return { ok: false, vnics: [], error: attachRes.error || `OCI VNIC attachments lookup failed (${attachRes.status})` };
  }

  const instMap = new Map(
    (instRes.data ?? [])
      .filter((i) => !['TERMINATED', 'TERMINATING'].includes(i.lifecycleState))
      .map((i) => [i.id, i])
  );

  const attachedVnics = (attachRes.data ?? []).filter(
    (a) => a.lifecycleState === 'ATTACHED' && instMap.has(a.instanceId) && a.vnicId
  );

  const summaries: OciVnicSummary[] = [];
  for (const att of attachedVnics) {
    const inst = instMap.get(att.instanceId)!;
    const vnicInfo = await inspectOciVnicIps(profile, privateKeyPem, att.vnicId);
    if (!vnicInfo.ok || !vnicInfo.vnic) continue;

    summaries.push({
      ...vnicInfo.vnic,
      instanceId: inst.id,
      instanceName: inst.displayName,
      instanceShape: inst.shape,
      instanceState: inst.lifecycleState,
      availabilityDomain: inst.availabilityDomain,
    });
  }

  return { ok: true, vnics: summaries };
}

/**
 * Inspects a single OCI VNIC for its live Public IPv4 (plus publicIpId/privateIpId/lifetime) and all IPv6s.
 */
export async function inspectOciVnicIps(
  profile: StoredOciProfile,
  privateKeyPem: string,
  vnicId: string
): Promise<{
  ok: boolean;
  vnic?: Omit<OciVnicSummary, 'instanceId' | 'instanceName' | 'instanceShape' | 'instanceState' | 'availabilityDomain'>;
  error?: string;
}> {
  const built = buildCredsFromProfile(profile, privateKeyPem);
  if (!built.ok) return { ok: false, error: built.error };
  if (!isValidOcid(vnicId)) return { ok: false, error: 'Invalid OCI VNIC OCID' };

  const [vnicRes, privRes, v6Res] = await Promise.all([
    ociApiRequest<{
      id: string;
      displayName?: string;
      subnetId: string;
      privateIp?: string;
      publicIp?: string;
      isPrimary?: boolean;
    }>({
      creds: built.creds,
      service: 'iaas',
      method: 'GET',
      apiPath: `/20160918/vnics/${encodeURIComponent(vnicId)}`,
    }),
    ociApiRequest<Array<{ id: string; ipAddress: string; isPrimary?: boolean }>>({
      creds: built.creds,
      service: 'iaas',
      method: 'GET',
      apiPath: `/20160918/privateIps?vnicId=${encodeURIComponent(vnicId)}`,
    }),
    ociApiRequest<Array<{ id: string; ipAddress: string; lifecycleState?: string }>>({
      creds: built.creds,
      service: 'iaas',
      method: 'GET',
      apiPath: `/20160918/ipv6s?vnicId=${encodeURIComponent(vnicId)}`,
    }),
  ]);

  if (!vnicRes.ok || !vnicRes.data) {
    return { ok: false, error: vnicRes.error || `Failed to inspect OCI VNIC (${vnicRes.status})` };
  }

  const primaryPriv = (privRes.data ?? []).find((p) => p.isPrimary) ?? (privRes.data ?? [])[0];
  let publicIpId: string | undefined;
  let publicIpLifetime: 'EPHEMERAL' | 'RESERVED' | undefined;
  let publicIpAddress: string | undefined = vnicRes.data.publicIp;

  if (primaryPriv?.id) {
    const pubRes = await ociApiRequest<{ id: string; ipAddress: string; lifetime: 'EPHEMERAL' | 'RESERVED' }>({
      creds: built.creds,
      service: 'iaas',
      method: 'POST',
      apiPath: '/20160918/publicIps/actions/getByPrivateIpId',
      body: { privateIpId: primaryPriv.id },
    });
    if (pubRes.ok && pubRes.data) {
      publicIpId = pubRes.data.id;
      publicIpLifetime = pubRes.data.lifetime;
      publicIpAddress = pubRes.data.ipAddress;
    }
  }

  const ipv6s = (v6Res.data ?? [])
    .filter((v) => !v.lifecycleState || v.lifecycleState === 'AVAILABLE')
    .map((v) => ({
      id: v.id,
      ipAddress: v.ipAddress,
    }));

  return {
    ok: true,
    vnic: {
      vnicId: vnicRes.data.id,
      vnicName: vnicRes.data.displayName || 'Primary VNIC',
      subnetId: vnicRes.data.subnetId,
      isPrimary: Boolean(vnicRes.data.isPrimary),
      privateIp: primaryPriv?.ipAddress || vnicRes.data.privateIp || '',
      primaryPrivateIpId: primaryPriv?.id || '',
      publicIp: publicIpAddress,
      publicIpId,
      publicIpLifetime,
      ipv6s,
    },
  };
}

/**
 * Executes a real OCI Public IPv4 replacement on a VNIC's primary Private IP:
 * 1. Looks up current Public IP attached to `privateIpId`
 * 2. Deletes existing Ephemeral Public IP (or unassigns Reserved Public IP)
 * 3. Creates a fresh Ephemeral Public IP on the same `privateIpId`
 */
export async function ociSwapPublicIpv4(
  profile: StoredOciProfile,
  privateKeyPem: string,
  privateIpId: string
): Promise<{
  ok: boolean;
  oldAddress?: string;
  newAddress?: string;
  publicIpId?: string;
  lifetime?: 'EPHEMERAL' | 'RESERVED';
  error?: string;
}> {
  const built = buildCredsFromProfile(profile, privateKeyPem);
  if (!built.ok) return { ok: false, error: built.error };
  if (!isValidOcid(privateIpId)) return { ok: false, error: 'Invalid OCI Primary Private IP OCID' };

  const compId = profile.compartmentOcid || profile.tenancyOcid;

  // 1. Lookup current public IP on this privateIpId
  const currentRes = await ociApiRequest<{ id: string; ipAddress: string; lifetime: 'EPHEMERAL' | 'RESERVED' }>({
    creds: built.creds,
    service: 'iaas',
    method: 'POST',
    apiPath: '/20160918/publicIps/actions/getByPrivateIpId',
    body: { privateIpId },
  });

  let oldAddress: string | undefined;
  if (currentRes.ok && currentRes.data) {
    oldAddress = currentRes.data.ipAddress;
    if (currentRes.data.lifetime === 'EPHEMERAL') {
      const delRes = await ociApiRequest({
        creds: built.creds,
        service: 'iaas',
        method: 'DELETE',
        apiPath: `/20160918/publicIps/${encodeURIComponent(currentRes.data.id)}`,
      });
      if (!delRes.ok) {
        return { ok: false, error: `Failed to release old OCI Ephemeral Public IP: ${delRes.error}` };
      }
    } else {
      // Unassign reserved public IP without deleting it
      const unassignRes = await ociApiRequest({
        creds: built.creds,
        service: 'iaas',
        method: 'PUT',
        apiPath: `/20160918/publicIps/${encodeURIComponent(currentRes.data.id)}`,
        body: { privateIpId: null },
      });
      if (!unassignRes.ok) {
        return { ok: false, error: `Failed to unassign Reserved Public IP: ${unassignRes.error}` };
      }
    }
    // Brief wait so OCI control plane finishes detachment before creating replacement
    await new Promise((r) => setTimeout(r, 1500));
  }

  // 2. Create fresh Ephemeral Public IP
  const createRes = await ociApiRequest<{ id: string; ipAddress: string; lifetime: 'EPHEMERAL' | 'RESERVED' }>({
    creds: built.creds,
    service: 'iaas',
    method: 'POST',
    apiPath: '/20160918/publicIps',
    body: {
      compartmentId: compId,
      lifetime: 'EPHEMERAL',
      privateIpId,
    },
  });

  if (!createRes.ok || !createRes.data) {
    return {
      ok: false,
      oldAddress,
      error: `Failed to allocate new OCI Ephemeral Public IP: ${createRes.error || `HTTP ${createRes.status}`}`,
    };
  }

  return {
    ok: true,
    oldAddress,
    newAddress: createRes.data.ipAddress,
    publicIpId: createRes.data.id,
    lifetime: createRes.data.lifetime,
  };
}

/**
 * Allocates a new real OCI Ephemeral Public IPv4 on a VNIC's primary Private IP
 * via `POST /20160918/publicIps` (fails cleanly if one is already attached).
 */
export async function ociAllocatePublicIpv4(
  profile: StoredOciProfile,
  privateKeyPem: string,
  privateIpId: string
): Promise<{
  ok: boolean;
  ipAddress?: string;
  publicIpId?: string;
  lifetime?: 'EPHEMERAL' | 'RESERVED';
  error?: string;
}> {
  const built = buildCredsFromProfile(profile, privateKeyPem);
  if (!built.ok) return { ok: false, error: built.error };
  if (!isValidOcid(privateIpId)) return { ok: false, error: 'Invalid OCI Primary Private IP OCID' };

  const compId = profile.compartmentOcid || profile.tenancyOcid;
  const createRes = await ociApiRequest<{ id: string; ipAddress: string; lifetime: 'EPHEMERAL' | 'RESERVED' }>({
    creds: built.creds,
    service: 'iaas',
    method: 'POST',
    apiPath: '/20160918/publicIps',
    body: {
      compartmentId: compId,
      lifetime: 'EPHEMERAL',
      privateIpId,
    },
  });

  if (!createRes.ok || !createRes.data) {
    return {
      ok: false,
      error: createRes.error || `Failed to allocate OCI Ephemeral Public IPv4 (HTTP ${createRes.status})`,
    };
  }

  return {
    ok: true,
    ipAddress: createRes.data.ipAddress,
    publicIpId: createRes.data.id,
    lifetime: createRes.data.lifetime,
  };
}

/**
 * Deletes/unassigns a real OCI Public IPv4 from a VNIC.
 */
export async function ociDeletePublicIpv4(
  profile: StoredOciProfile,
  privateKeyPem: string,
  publicIpId: string,
  lifetime?: 'EPHEMERAL' | 'RESERVED'
): Promise<{ ok: boolean; error?: string }> {
  const built = buildCredsFromProfile(profile, privateKeyPem);
  if (!built.ok) return { ok: false, error: built.error };
  if (!isValidOcid(publicIpId)) return { ok: false, error: 'Invalid OCI Public IP OCID' };

  if (lifetime === 'RESERVED') {
    const res = await ociApiRequest({
      creds: built.creds,
      service: 'iaas',
      method: 'PUT',
      apiPath: `/20160918/publicIps/${encodeURIComponent(publicIpId)}`,
      body: { privateIpId: null },
    });
    return res.ok ? { ok: true } : { ok: false, error: res.error || `HTTP ${res.status}` };
  }

  const res = await ociApiRequest({
    creds: built.creds,
    service: 'iaas',
    method: 'DELETE',
    apiPath: `/20160918/publicIps/${encodeURIComponent(publicIpId)}`,
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error || `HTTP ${res.status}` };
}

/**
 * Allocates a real IPv6 address on an OCI VNIC via `POST /20160918/ipv6s`.
 * Optionally accepts a specific `ipAddress` within the subnet's /64 CIDR, or lets OCI auto-assign.
 */
export async function ociAddIpv6ToVnic(
  profile: StoredOciProfile,
  privateKeyPem: string,
  vnicId: string,
  specificIpAddress?: string
): Promise<{ ok: boolean; ipv6Id?: string; ipAddress?: string; error?: string }> {
  const built = buildCredsFromProfile(profile, privateKeyPem);
  if (!built.ok) return { ok: false, error: built.error };
  if (!isValidOcid(vnicId)) return { ok: false, error: 'Invalid OCI VNIC OCID' };

  const cleanIp = specificIpAddress?.trim();
  if (cleanIp && !net.isIPv6(cleanIp)) {
    return { ok: false, error: 'Specified IPv6 address is invalid' };
  }

  const res = await ociApiRequest<{ id: string; ipAddress: string }>({
    creds: built.creds,
    service: 'iaas',
    method: 'POST',
    apiPath: '/20160918/ipv6s',
    body: {
      vnicId,
      ...(cleanIp ? { ipAddress: cleanIp } : {}),
    },
  });

  if (!res.ok || !res.data) {
    return { ok: false, error: res.error || `Failed to allocate OCI IPv6 (HTTP ${res.status})` };
  }

  return {
    ok: true,
    ipv6Id: res.data.id,
    ipAddress: res.data.ipAddress,
  };
}

/**
 * Deletes a real IPv6 address from an OCI VNIC via `DELETE /20160918/ipv6s/{ipv6Id}`.
 */
export async function ociDeleteIpv6(
  profile: StoredOciProfile,
  privateKeyPem: string,
  ipv6Id: string
): Promise<{ ok: boolean; error?: string }> {
  const built = buildCredsFromProfile(profile, privateKeyPem);
  if (!built.ok) return { ok: false, error: built.error };
  if (!isValidOcid(ipv6Id)) return { ok: false, error: 'Invalid OCI IPv6 OCID' };

  const res = await ociApiRequest({
    creds: built.creds,
    service: 'iaas',
    method: 'DELETE',
    apiPath: `/20160918/ipv6s/${encodeURIComponent(ipv6Id)}`,
  });

  return res.ok ? { ok: true } : { ok: false, error: res.error || `Failed to delete OCI IPv6 (HTTP ${res.status})` };
}

function inferOciArch(shape: string): 'arm64' | 'x86_64' {
  const s = (shape || '').toUpperCase();
  return s.includes('.A1.') || s.includes('.A2.') || s.includes('AMPERE') || s.includes('ARM')
    ? 'arm64'
    : 'x86_64';
}

function formatOciSpecs(shape: string, ocpus?: number, memoryInGBs?: number): string {
  const parts: string[] = [];
  if (shape) parts.push(shape);
  if (typeof ocpus === 'number' && ocpus > 0) parts.push(`${ocpus} OCPU`);
  if (typeof memoryInGBs === 'number' && memoryInGBs > 0) parts.push(`${memoryInGBs} GB`);
  return parts.join(' · ') || shape || 'OCI Compute';
}

export function mapOciStateToHostStatus(
  lifecycleState?: string
): 'online' | 'degraded' | 'offline' | 'provisioning' {
  const state = (lifecycleState || '').toUpperCase();
  if (state === 'RUNNING') return 'online';
  if (state === 'PROVISIONING' || state === 'STARTING' || state === 'CREATING_IMAGE') return 'provisioning';
  if (state === 'STOPPING' || state === 'MOVING') return 'degraded';
  return 'offline';
}

/**
 * Lists all non-terminated Compute instances in the profile's compartment & region,
 * enriched with their primary VNIC Public IPv4 and all attached IPv6 addresses.
 */
export async function listOciInstancesDetailed(
  profile: StoredOciProfile,
  privateKeyPem: string
): Promise<{
  ok: boolean;
  instances: Array<Omit<OciDiscoveredInstance, 'alreadyImported' | 'importedHostId'>>;
  error?: string;
}> {
  const built = buildCredsFromProfile(profile, privateKeyPem);
  if (!built.ok) return { ok: false, instances: [], error: built.error };

  const compId = profile.compartmentOcid || profile.tenancyOcid;

  const [instRes, attachRes] = await Promise.all([
    ociApiRequest<
      Array<{
        id: string;
        displayName: string;
        region?: string;
        shape: string;
        shapeConfig?: { ocpus?: number; memoryInGBs?: number };
        lifecycleState: string;
        availabilityDomain: string;
        timeCreated?: string;
      }>
    >({
      creds: built.creds,
      service: 'iaas',
      method: 'GET',
      apiPath: `/20160918/instances?compartmentId=${encodeURIComponent(compId)}`,
    }),
    ociApiRequest<
      Array<{
        id: string;
        instanceId: string;
        vnicId: string;
        lifecycleState: string;
      }>
    >({
      creds: built.creds,
      service: 'iaas',
      method: 'GET',
      apiPath: `/20160918/vnicAttachments?compartmentId=${encodeURIComponent(compId)}`,
    }),
  ]);

  if (!instRes.ok) {
    return {
      ok: false,
      instances: [],
      error: instRes.error || `OCI instances lookup failed (HTTP ${instRes.status})`,
    };
  }

  const activeInstances = (instRes.data ?? []).filter(
    (i) => !['TERMINATED', 'TERMINATING'].includes((i.lifecycleState || '').toUpperCase())
  );

  const vnicByInstance = new Map<string, string[]>();
  for (const att of attachRes.data ?? []) {
    if (att.lifecycleState !== 'ATTACHED' || !att.vnicId) continue;
    const arr = vnicByInstance.get(att.instanceId) ?? [];
    arr.push(att.vnicId);
    vnicByInstance.set(att.instanceId, arr);
  }

  const results: Array<Omit<OciDiscoveredInstance, 'alreadyImported' | 'importedHostId'>> = [];

  for (const inst of activeInstances) {
    const vnicIds = vnicByInstance.get(inst.id) ?? [];
    let primaryVnic:
      | Omit<OciVnicSummary, 'instanceId' | 'instanceName' | 'instanceShape' | 'instanceState' | 'availabilityDomain'>
      | undefined;

    for (const vid of vnicIds) {
      const inspected = await inspectOciVnicIps(profile, privateKeyPem, vid);
      if (!inspected.ok || !inspected.vnic) continue;
      if (!primaryVnic || inspected.vnic.isPrimary) {
        primaryVnic = inspected.vnic;
        if (inspected.vnic.isPrimary) break;
      }
    }

    const ocpus = inst.shapeConfig?.ocpus;
    const memoryInGBs = inst.shapeConfig?.memoryInGBs;

    results.push({
      instanceId: inst.id,
      displayName: inst.displayName || inst.id.slice(-10),
      region: profile.region,
      availabilityDomain: inst.availabilityDomain || '',
      shape: inst.shape,
      ocpus,
      memoryInGBs,
      architecture: inferOciArch(inst.shape),
      specs: formatOciSpecs(inst.shape, ocpus, memoryInGBs),
      lifecycleState: inst.lifecycleState || 'UNKNOWN',
      vnicId: primaryVnic?.vnicId,
      primaryPrivateIpId: primaryVnic?.primaryPrivateIpId,
      privateIp: primaryVnic?.privateIp,
      publicIp: primaryVnic?.publicIp,
      publicIpId: primaryVnic?.publicIpId,
      publicIpLifetime: primaryVnic?.publicIpLifetime,
      ipv6List: (primaryVnic?.ipv6s ?? []).map((v) => v.ipAddress),
      ipv6Entries: primaryVnic?.ipv6s ?? [],
      timeCreated: inst.timeCreated,
    });
  }

  return { ok: true, instances: results };
}

/**
 * Fetches live status & network info for a single OCI Compute instance.
 */
export async function getOciInstanceDetail(
  profile: StoredOciProfile,
  privateKeyPem: string,
  instanceId: string,
  knownVnicId?: string
): Promise<{
  ok: boolean;
  displayName?: string;
  lifecycleState?: string;
  shape?: string;
  specs?: string;
  availabilityDomain?: string;
  vnicId?: string;
  primaryPrivateIpId?: string;
  publicIp?: string;
  publicIpId?: string;
  publicIpLifetime?: 'EPHEMERAL' | 'RESERVED';
  ipv6List?: string[];
  ipv6Entries?: Array<{ id: string; ipAddress: string }>;
  error?: string;
}> {
  const built = buildCredsFromProfile(profile, privateKeyPem);
  if (!built.ok) return { ok: false, error: built.error };
  if (!isValidOcid(instanceId)) return { ok: false, error: 'Invalid OCI Instance OCID' };

  const instRes = await ociApiRequest<{
    id: string;
    displayName: string;
    shape: string;
    shapeConfig?: { ocpus?: number; memoryInGBs?: number };
    lifecycleState: string;
    availabilityDomain: string;
  }>({
    creds: built.creds,
    service: 'iaas',
    method: 'GET',
    apiPath: `/20160918/instances/${encodeURIComponent(instanceId)}`,
  });

  if (!instRes.ok || !instRes.data) {
    return { ok: false, error: instRes.error || `OCI getInstance failed (HTTP ${instRes.status})` };
  }

  let vnicId = knownVnicId && isValidOcid(knownVnicId) ? knownVnicId : undefined;
  if (!vnicId) {
    const compId = profile.compartmentOcid || profile.tenancyOcid;
    const attRes = await ociApiRequest<Array<{ vnicId: string; lifecycleState: string }>>({
      creds: built.creds,
      service: 'iaas',
      method: 'GET',
      apiPath: `/20160918/vnicAttachments?compartmentId=${encodeURIComponent(compId)}&instanceId=${encodeURIComponent(instanceId)}`,
    });
    const attached = (attRes.data ?? []).find((a) => a.lifecycleState === 'ATTACHED' && a.vnicId);
    vnicId = attached?.vnicId;
  }

  let publicIp: string | undefined;
  let publicIpId: string | undefined;
  let publicIpLifetime: 'EPHEMERAL' | 'RESERVED' | undefined;
  let ipv6List: string[] | undefined;
  let ipv6Entries: Array<{ id: string; ipAddress: string }> | undefined;
  let primaryPrivateIpId: string | undefined;

  if (vnicId) {
    const vnicInfo = await inspectOciVnicIps(profile, privateKeyPem, vnicId);
    if (vnicInfo.ok && vnicInfo.vnic) {
      publicIp = vnicInfo.vnic.publicIp;
      publicIpId = vnicInfo.vnic.publicIpId;
      publicIpLifetime = vnicInfo.vnic.publicIpLifetime;
      ipv6Entries = vnicInfo.vnic.ipv6s;
      ipv6List = vnicInfo.vnic.ipv6s.map((v) => v.ipAddress);
      primaryPrivateIpId = vnicInfo.vnic.primaryPrivateIpId;
    }
  }

  return {
    ok: true,
    displayName: instRes.data.displayName,
    lifecycleState: instRes.data.lifecycleState,
    shape: instRes.data.shape,
    specs: formatOciSpecs(
      instRes.data.shape,
      instRes.data.shapeConfig?.ocpus,
      instRes.data.shapeConfig?.memoryInGBs
    ),
    availabilityDomain: instRes.data.availabilityDomain,
    vnicId,
    primaryPrivateIpId,
    publicIp,
    publicIpId,
    publicIpLifetime,
    ipv6List,
    ipv6Entries,
  };
}

const ALLOWED_OCI_INSTANCE_ACTIONS = new Set<OciInstanceAction>([
  'SOFTRESET',
  'RESET',
  'START',
  'SOFTSTOP',
  'STOP',
]);

/**
 * Executes a real OCI Compute Instance power action via `POST /20160918/instances/{id}?action=...`:
 * - SOFTRESET: graceful OS reboot (ACPI)
 * - RESET: forced hard reboot (immediate power cycle)
 * - START / SOFTSTOP / STOP
 */
export async function ociInstancePowerAction(
  profile: StoredOciProfile,
  privateKeyPem: string,
  instanceId: string,
  action: OciInstanceAction
): Promise<{
  ok: boolean;
  lifecycleState?: string;
  displayName?: string;
  error?: string;
}> {
  if (!ALLOWED_OCI_INSTANCE_ACTIONS.has(action)) {
    return { ok: false, error: `Unsupported OCI instance action: ${action}` };
  }
  const built = buildCredsFromProfile(profile, privateKeyPem);
  if (!built.ok) return { ok: false, error: built.error };
  if (!isValidOcid(instanceId)) return { ok: false, error: 'Invalid OCI Instance OCID' };

  const res = await ociApiRequest<{ id: string; displayName?: string; lifecycleState?: string }>({
    creds: built.creds,
    service: 'iaas',
    method: 'POST',
    apiPath: `/20160918/instances/${encodeURIComponent(instanceId)}?action=${encodeURIComponent(action)}`,
    body: {},
  });

  if (!res.ok) {
    return {
      ok: false,
      error: res.error || `OCI ${action} failed (HTTP ${res.status})`,
    };
  }

  return {
    ok: true,
    lifecycleState: res.data?.lifecycleState || (action === 'STOP' || action === 'SOFTSTOP' ? 'STOPPING' : 'RUNNING'),
    displayName: res.data?.displayName,
  };
}

/**
 * Generates an ephemeral Ed25519 SSH keypair (RFC 4253 / OpenSSH ssh-ed25519 public key + PEM private key)
 * so users creating zero-main.tf OCI ARM sniper tasks can populate ssh_authorized_keys in 1 click.
 */
export function generateEd25519SshKeypair(comment = 'netpulse-oci-arm'): {
  publicKey: string;
  privateKeyPem: string;
  fingerprint: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  // Ed25519 SPKI DER ends with the raw 32-byte public key
  const rawPub = spkiDer.subarray(spkiDer.length - 32);
  const keyType = Buffer.from('ssh-ed25519', 'ascii');
  const lenBuf = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n, 0);
    return b;
  };
  const sshBlob = Buffer.concat([lenBuf(keyType.length), keyType, lenBuf(rawPub.length), rawPub]);
  const safeComment = comment.replace(/[^a-zA-Z0-9._@-]/g, '') || 'netpulse-oci-arm';
  const openSshPub = `ssh-ed25519 ${sshBlob.toString('base64')} ${safeComment}`;
  const fp = `SHA256:${crypto.createHash('sha256').update(sshBlob).digest('base64').replace(/=+$/, '')}`;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  return {
    publicKey: openSshPub,
    privateKeyPem,
    fingerprint: fp,
  };
}

