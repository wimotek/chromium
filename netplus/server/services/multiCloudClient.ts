import crypto from 'node:crypto';
import net from 'node:net';
import type {
  CloudDiscoveredInstance,
  ExternalCloudProvider,
  OciInstanceAction,
} from '../../src/types/models.ts';
import type { StoredCloudAccount, StoredCloudHost } from '../lib/store.ts';

// Strict format validators to prevent SSRF / host / path injection
export const AWS_REGION_REGEX = /^[a-z]{2}(-[a-z]+)+-\d$/;
export const ALIYUN_REGION_REGEX = /^[a-z]{2,3}-[a-z0-9-]+$/;
export const GCP_REGION_REGEX = /^[a-z]+-[a-z]+\d+$/;
export const GCP_ZONE_REGEX = /^[a-z]+-[a-z]+\d+-[a-z]$/;
export const GCP_PROJECT_REGEX = /^[a-z][a-z0-9-]{4,30}$/;
export const CLOUD_INSTANCE_ID_REGEX = /^[a-zA-Z0-9._-]{2,128}$/;

export interface CloudAccountSecrets {
  accessKeyId: string;
  secretKey: string;
  serviceAccountJson: string;
}

export interface GcpServiceAccountParsed {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

export interface CloudInstanceDetailResult {
  ok: boolean;
  lifecycleState?: string;
  specs?: string;
  zone?: string;
  networkInterfaceId?: string;
  publicIp?: string;
  eipAllocationId?: string;
  eipAssociationId?: string;
  ipv6List?: string[];
  error?: string;
}

export function validateCloudRegion(provider: ExternalCloudProvider, region: string): boolean {
  const clean = region.trim().toLowerCase();
  if (!clean) return false;
  if (provider === 'aws') return AWS_REGION_REGEX.test(clean);
  if (provider === 'aliyun') return ALIYUN_REGION_REGEX.test(clean) && clean.length <= 32;
  if (provider === 'gcp') {
    return clean === 'all' || GCP_REGION_REGEX.test(clean) || GCP_ZONE_REGEX.test(clean);
  }
  return false;
}

export function mapCloudStateToHostStatus(
  state?: string
): 'online' | 'degraded' | 'offline' | 'provisioning' {
  const upper = String(state || '').toUpperCase();
  if (upper === 'RUNNING' || upper === 'ONLINE') return 'online';
  if (
    upper === 'PENDING' ||
    upper === 'PROVISIONING' ||
    upper === 'STAGING' ||
    upper === 'STARTING' ||
    upper === 'REBOOTING' ||
    upper === 'STOPPING' ||
    upper === 'SHUTTING-DOWN' ||
    upper === 'RESETTING'
  ) {
    return 'provisioning';
  }
  if (upper === 'STOPPED' || upper === 'TERMINATED' || upper === 'OFFLINE') {
    return 'offline';
  }
  return 'degraded';
}

export function parseGcpServiceAccountJson(
  rawJson: string
): { ok: true; data: GcpServiceAccountParsed } | { ok: false; error: string } {
  const trimmed = rawJson.trim();
  if (!trimmed) {
    return { ok: false, error: '请粘贴或上传 GCP Service Account JSON 密钥文件' };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'GCP JSON 格式无效，请确认粘贴了完整的服务账号 JSON' };
  }

  const projectId = String(parsed.project_id || '').trim();
  const clientEmail = String(parsed.client_email || '').trim();
  const privateKey = String(parsed.private_key || '').trim();
  const tokenUri = String(parsed.token_uri || 'https://oauth2.googleapis.com/token').trim();

  if (!projectId || !GCP_PROJECT_REGEX.test(projectId)) {
    return { ok: false, error: 'JSON 中缺少有效的 project_id 字段' };
  }
  if (!clientEmail || !clientEmail.includes('@')) {
    return { ok: false, error: 'JSON 中缺少有效的 client_email 字段' };
  }
  if (!privateKey || !privateKey.includes('PRIVATE KEY')) {
    return { ok: false, error: 'JSON 中缺少有效的 PEM private_key 字段' };
  }
  // Verify the private key is cryptographically valid for RS256 signing
  try {
    crypto.createPrivateKey(privateKey);
  } catch {
    return { ok: false, error: 'JSON 中的 private_key 无法解析为有效 RSA 私钥' };
  }
  if (tokenUri !== 'https://oauth2.googleapis.com/token') {
    return { ok: false, error: '仅允许标准 Google OAuth2 token_uri (https://oauth2.googleapis.com/token)' };
  }

  return {
    ok: true,
    data: { projectId, clientEmail, privateKey, tokenUri },
  };
}

// ============================================================================
// 1. AWS EC2 Client (SigV4 HMAC-SHA256 over Query API)
// ============================================================================

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function awsPercentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function awsEc2Request(
  region: string,
  accessKeyId: string,
  secretKey: string,
  params: Record<string, string>
): Promise<{ ok: boolean; status: number; xml: string; error?: string }> {
  const cleanRegion = region.trim().toLowerCase();
  if (!AWS_REGION_REGEX.test(cleanRegion)) {
    return { ok: false, status: 400, xml: '', error: `Invalid AWS region: ${region}` };
  }
  if (!accessKeyId || !secretKey) {
    return { ok: false, status: 400, xml: '', error: 'AWS Access Key ID / Secret Access Key 未配置' };
  }

  const host = `ec2.${cleanRegion}.amazonaws.com`;
  const allParams: Record<string, string> = {
    Version: '2016-11-15',
    ...params,
  };
  const body = Object.keys(allParams)
    .sort()
    .map((k) => `${awsPercentEncode(k)}=${awsPercentEncode(allParams[k])}`)
    .join('&');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const service = 'ec2';
  const payloadHash = sha256Hex(body);
  const contentType = 'application/x-www-form-urlencoded; charset=utf-8';

  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-date';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const credentialScope = `${dateStamp}/${cleanRegion}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmacSha256('AWS4' + secretKey, dateStamp);
  const kRegion = hmacSha256(kDate, cleanRegion);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  try {
    const resp = await fetch(`https://${host}/`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'X-Amz-Date': amzDate,
        Authorization: authorization,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const xml = await resp.text();
    if (!resp.ok) {
      const msg = extractXmlTag(xml, 'Message') || extractXmlTag(xml, 'Code') || `AWS HTTP ${resp.status}`;
      return { ok: false, status: resp.status, xml, error: msg };
    }
    return { ok: true, status: resp.status, xml };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      xml: '',
      error: err instanceof Error ? err.message : 'AWS EC2 API request failed',
    };
  }
}

function extractXmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1].trim()) : '';
}

function extractXmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const openToken = `<${tag}>`;
  const closeToken = `</${tag}>`;
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf(openToken, cursor);
    if (start === -1) break;
    let depth = 1;
    let scan = start + openToken.length;
    while (depth > 0 && scan < xml.length) {
      const nextOpen = xml.indexOf(openToken, scan);
      const nextClose = xml.indexOf(closeToken, scan);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        scan = nextOpen + openToken.length;
      } else {
        depth -= 1;
        if (depth === 0) {
          out.push(xml.slice(start + openToken.length, nextClose));
          cursor = nextClose + closeToken.length;
          break;
        }
        scan = nextClose + closeToken.length;
      }
    }
    if (depth !== 0) break;
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseAwsInstancesXml(xml: string, region: string): CloudDiscoveredInstance[] {
  const instancesSetBlocks = extractXmlBlocks(xml, 'instancesSet');
  const results: CloudDiscoveredInstance[] = [];

  for (const setBlock of instancesSetBlocks) {
    const itemBlocks = extractXmlBlocks(setBlock, 'item');
    for (const block of itemBlocks) {
      const instanceId = extractXmlTag(block, 'instanceId');
      if (!instanceId || !instanceId.startsWith('i-')) continue;

      const stateBlock = extractXmlTag(block, 'instanceState');
      const stateName = extractXmlTag(stateBlock, 'name').toUpperCase() || 'UNKNOWN';
      if (stateName === 'TERMINATED') continue;

      const instanceType = extractXmlTag(block, 'instanceType') || 'ec2';
      const archRaw = extractXmlTag(block, 'architecture').toLowerCase();
      const architecture: 'arm64' | 'x86_64' = archRaw.includes('arm') ? 'arm64' : 'x86_64';
      const placementBlock = extractXmlTag(block, 'placement');
      const zone = extractXmlTag(placementBlock, 'availabilityZone') || undefined;
      const privateIp = extractXmlTag(block, 'privateIpAddress') || undefined;
      const publicIp = extractXmlTag(block, 'ipAddress') || undefined;

      // Extract Name tag
      let displayName = instanceId;
      const tagSet = extractXmlTag(block, 'tagSet');
      if (tagSet) {
        for (const tagItem of extractXmlBlocks(tagSet, 'item')) {
          if (extractXmlTag(tagItem, 'key') === 'Name') {
            const val = extractXmlTag(tagItem, 'value');
            if (val) displayName = val;
          }
        }
      }

      // Primary Network Interface & IPv6 addresses
      let networkInterfaceId: string | undefined;
      const ipv6Set = new Set<string>();
      const eniSet = extractXmlTag(block, 'networkInterfaceSet');
      if (eniSet) {
        const enis = extractXmlBlocks(eniSet, 'item');
        if (enis[0]) {
          networkInterfaceId = extractXmlTag(enis[0], 'networkInterfaceId') || undefined;
        }
        for (const eni of enis) {
          const v6Block = extractXmlTag(eni, 'ipv6AddressesSet');
          if (v6Block) {
            for (const v6Item of extractXmlBlocks(v6Block, 'item')) {
              const addr = extractXmlTag(v6Item, 'ipv6Address');
              if (addr && net.isIPv6(addr)) ipv6Set.add(addr);
            }
          }
        }
      }

      results.push({
        provider: 'aws',
        instanceId,
        displayName,
        region,
        zone,
        shape: instanceType,
        architecture,
        specs: `${instanceType} (${architecture})`,
        lifecycleState: stateName,
        networkInterfaceId,
        privateIp,
        publicIp,
        ipv6List: Array.from(ipv6Set),
        alreadyImported: false,
      });
    }
  }
  return results;
}

async function awsLookupEipForInstance(
  region: string,
  secrets: CloudAccountSecrets,
  instanceId: string
): Promise<{ allocationId?: string; associationId?: string; publicIp?: string }> {
  const res = await awsEc2Request(region, secrets.accessKeyId, secrets.secretKey, {
    Action: 'DescribeAddresses',
    'Filter.1.Name': 'instance-id',
    'Filter.1.Value.1': instanceId,
  });
  if (!res.ok) return {};
  const addrSet = extractXmlTag(res.xml, 'addressesSet');
  const first = extractXmlBlocks(addrSet, 'item')[0];
  if (!first) return {};
  return {
    allocationId: extractXmlTag(first, 'allocationId') || undefined,
    associationId: extractXmlTag(first, 'associationId') || undefined,
    publicIp: extractXmlTag(first, 'publicIp') || undefined,
  };
}

async function listAwsInstances(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets
): Promise<{ ok: boolean; instances: CloudDiscoveredInstance[]; error?: string }> {
  const res = await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
    Action: 'DescribeInstances',
  });
  if (!res.ok) return { ok: false, instances: [], error: res.error };
  const instances = parseAwsInstancesXml(res.xml, account.region);

  // Also enrich with EIP allocation IDs when available
  const addrRes = await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
    Action: 'DescribeAddresses',
  });
  if (addrRes.ok) {
    const addrSet = extractXmlTag(addrRes.xml, 'addressesSet');
    const eipByInstance = new Map<string, { allocationId: string; associationId: string; publicIp: string }>();
    for (const item of extractXmlBlocks(addrSet, 'item')) {
      const instId = extractXmlTag(item, 'instanceId');
      const allocationId = extractXmlTag(item, 'allocationId');
      const associationId = extractXmlTag(item, 'associationId');
      const publicIp = extractXmlTag(item, 'publicIp');
      if (instId && allocationId) {
        eipByInstance.set(instId, { allocationId, associationId, publicIp });
      }
    }
    for (const inst of instances) {
      const eip = eipByInstance.get(inst.instanceId);
      if (eip) {
        inst.eipAllocationId = eip.allocationId;
        inst.eipAssociationId = eip.associationId;
        if (eip.publicIp) inst.publicIp = eip.publicIp;
      }
    }
  }

  return { ok: true, instances };
}

async function getAwsInstanceDetail(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  instanceId: string
): Promise<CloudInstanceDetailResult> {
  const res = await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
    Action: 'DescribeInstances',
    'InstanceId.1': instanceId,
  });
  if (!res.ok) return { ok: false, error: res.error };
  const list = parseAwsInstancesXml(res.xml, account.region);
  const inst = list[0];
  if (!inst) return { ok: false, error: `AWS EC2 实例 ${instanceId} 不存在或已终止` };
  const eip = await awsLookupEipForInstance(account.region, secrets, instanceId);
  return {
    ok: true,
    lifecycleState: inst.lifecycleState,
    specs: inst.specs,
    zone: inst.zone,
    networkInterfaceId: inst.networkInterfaceId,
    publicIp: eip.publicIp || inst.publicIp || '',
    eipAllocationId: eip.allocationId,
    eipAssociationId: eip.associationId,
    ipv6List: inst.ipv6List,
  };
}

async function awsPowerAction(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  instanceId: string,
  action: OciInstanceAction
): Promise<{ ok: boolean; lifecycleState?: string; error?: string }> {
  if (action === 'SOFTRESET') {
    const res = await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
      Action: 'RebootInstances',
      'InstanceId.1': instanceId,
    });
    return res.ok ? { ok: true, lifecycleState: 'REBOOTING' } : { ok: false, error: res.error };
  }
  if (action === 'RESET') {
    // Hard reboot: force stop then start (or RebootInstances if stop not needed)
    const stopRes = await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
      Action: 'StopInstances',
      'InstanceId.1': instanceId,
      Force: 'true',
    });
    if (!stopRes.ok) return { ok: false, error: stopRes.error };
    const startRes = await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
      Action: 'StartInstances',
      'InstanceId.1': instanceId,
    });
    if (!startRes.ok) {
      return {
        ok: true,
        lifecycleState: 'STOPPING',
        error: undefined,
      };
    }
    return { ok: true, lifecycleState: 'PENDING' };
  }
  if (action === 'START') {
    const res = await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
      Action: 'StartInstances',
      'InstanceId.1': instanceId,
    });
    return res.ok ? { ok: true, lifecycleState: 'PENDING' } : { ok: false, error: res.error };
  }
  const res = await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
    Action: 'StopInstances',
    'InstanceId.1': instanceId,
    ...(action === 'STOP' ? { Force: 'true' } : {}),
  });
  return res.ok ? { ok: true, lifecycleState: 'STOPPING' } : { ok: false, error: res.error };
}

async function awsAllocateAndBindIpv4(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  instanceId: string,
  oldAllocationId?: string,
  oldAssociationId?: string
): Promise<{
  ok: boolean;
  newAddress?: string;
  allocationId?: string;
  associationId?: string;
  error?: string;
}> {
  // 1. Allocate new VPC Elastic IP
  const alloc = await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
    Action: 'AllocateAddress',
    Domain: 'vpc',
  });
  if (!alloc.ok) return { ok: false, error: alloc.error || 'AWS AllocateAddress failed' };
  const newAddress = extractXmlTag(alloc.xml, 'publicIp');
  const allocationId = extractXmlTag(alloc.xml, 'allocationId');
  if (!newAddress || !allocationId) {
    return { ok: false, error: 'AWS 返回的 Elastic IP 数据无效' };
  }

  // 2. Associate new EIP to the EC2 instance (AllowReassociation=true replaces current EIP)
  const assoc = await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
    Action: 'AssociateAddress',
    InstanceId: instanceId,
    AllocationId: allocationId,
    AllowReassociation: 'true',
  });
  if (!assoc.ok) {
    // Roll back unattached EIP to avoid idle EIP billing
    await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
      Action: 'ReleaseAddress',
      AllocationId: allocationId,
    });
    return { ok: false, error: assoc.error || 'AWS AssociateAddress failed' };
  }
  const associationId = extractXmlTag(assoc.xml, 'associationId') || undefined;

  // 3. Release previous EIP if one existed so no orphaned EIP charges accumulate
  if (oldAllocationId && oldAllocationId !== allocationId) {
    if (oldAssociationId) {
      await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
        Action: 'DisassociateAddress',
        AssociationId: oldAssociationId,
      });
    }
    await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
      Action: 'ReleaseAddress',
      AllocationId: oldAllocationId,
    });
  }

  return { ok: true, newAddress, allocationId, associationId };
}

async function awsDeletePublicIpv4(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  instanceId: string,
  allocationId?: string,
  associationId?: string
): Promise<{ ok: boolean; error?: string }> {
  let allocId = allocationId;
  let assocId = associationId;
  if (!allocId || !assocId) {
    const eip = await awsLookupEipForInstance(account.region, secrets, instanceId);
    allocId = allocId || eip.allocationId;
    assocId = assocId || eip.associationId;
  }
  if (!allocId) {
    return {
      ok: false,
      error: '该 EC2 实例当前使用的是自动分配公网 IP（非 Elastic IP），AWS 不支持直接删除，请点击「更换 IPv4」改绑新 Elastic IP。',
    };
  }
  if (assocId) {
    const dis = await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
      Action: 'DisassociateAddress',
      AssociationId: assocId,
    });
    if (!dis.ok) return { ok: false, error: dis.error };
  }
  const rel = await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
    Action: 'ReleaseAddress',
    AllocationId: allocId,
  });
  return rel.ok ? { ok: true } : { ok: false, error: rel.error };
}

async function awsAddIpv6(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  networkInterfaceId: string,
  requestedAddress?: string
): Promise<{ ok: boolean; ipAddress?: string; error?: string }> {
  const params: Record<string, string> = {
    Action: 'AssignIpv6Addresses',
    NetworkInterfaceId: networkInterfaceId,
  };
  if (requestedAddress && net.isIPv6(requestedAddress)) {
    params['Ipv6Addresses.1'] = requestedAddress;
  } else {
    params.Ipv6AddressCount = '1';
  }
  const res = await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, params);
  if (!res.ok) return { ok: false, error: res.error };
  const setBlock = extractXmlTag(res.xml, 'assignedIpv6Addresses');
  const ip = extractXmlTag(setBlock, 'item') || requestedAddress;
  if (!ip) return { ok: false, error: 'AWS 未返回分配的 IPv6 地址（请确认 VPC/子网已开启 IPv6 CIDR）' };
  return { ok: true, ipAddress: ip };
}

async function awsDeleteIpv6(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  networkInterfaceId: string,
  address: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await awsEc2Request(account.region, secrets.accessKeyId, secrets.secretKey, {
    Action: 'UnassignIpv6Addresses',
    NetworkInterfaceId: networkInterfaceId,
    'Ipv6Addresses.1': address,
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

// ============================================================================
// 2. Aliyun ECS / VPC Client (RPC HMAC-SHA1 JSON API)
// ============================================================================

function aliyunPercentEncode(val: string): string {
  return encodeURIComponent(val)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

async function aliyunRpcRequest<T = Record<string, unknown>>(
  service: 'ecs' | 'vpc',
  region: string,
  accessKeyId: string,
  accessKeySecret: string,
  action: string,
  extraParams: Record<string, string> = {}
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const cleanRegion = region.trim().toLowerCase();
  if (!ALIYUN_REGION_REGEX.test(cleanRegion)) {
    return { ok: false, error: `Invalid Aliyun region: ${region}` };
  }
  if (!accessKeyId || !accessKeySecret) {
    return { ok: false, error: '阿里云 AccessKey ID / Secret 未配置' };
  }

  const version = service === 'vpc' ? '2016-04-28' : '2014-05-26';
  const host = service === 'vpc' ? `vpc.${cleanRegion}.aliyuncs.com` : `ecs.${cleanRegion}.aliyuncs.com`;

  const params: Record<string, string> = {
    Format: 'JSON',
    Version: version,
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomBytes(12).toString('hex'),
    Action: action,
    RegionId: cleanRegion,
    ...extraParams,
  };

  const canonicalizedQuery = Object.keys(params)
    .sort()
    .map((k) => `${aliyunPercentEncode(k)}=${aliyunPercentEncode(params[k])}`)
    .join('&');

  const stringToSign = `POST&${aliyunPercentEncode('/')}&${aliyunPercentEncode(canonicalizedQuery)}`;
  const signature = crypto
    .createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign, 'utf8')
    .digest('base64');

  const formBody = `${canonicalizedQuery}&Signature=${aliyunPercentEncode(signature)}`;

  try {
    const resp = await fetch(`https://${host}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await resp.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, error: `Aliyun HTTP ${resp.status}: ${text.slice(0, 160)}` };
    }
    if (!resp.ok || json.Code) {
      const msg = String(json.Message || json.Code || `Aliyun HTTP ${resp.status}`);
      return { ok: false, error: msg };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Aliyun ECS API request failed' };
  }
}

interface AliyunInstanceRaw {
  InstanceId: string;
  InstanceName?: string;
  HostName?: string;
  RegionId?: string;
  ZoneId?: string;
  InstanceType?: string;
  Cpu?: number;
  Memory?: number;
  Status?: string;
  PublicIpAddress?: { IpAddress?: string[] };
  EipAddress?: { IpAddress?: string; AllocationId?: string };
  VpcAttributes?: { PrivateIpAddress?: { IpAddress?: string[] } };
  NetworkInterfaces?: {
    NetworkInterface?: Array<{
      NetworkInterfaceId?: string;
      Type?: string;
      PrimaryIpAddress?: string;
      Ipv6Sets?: { Ipv6Set?: Array<{ Ipv6Address?: string }> };
    }>;
  };
}

function mapAliyunInstance(raw: AliyunInstanceRaw, fallbackRegion: string): CloudDiscoveredInstance {
  const enis = raw.NetworkInterfaces?.NetworkInterface ?? [];
  const primaryEni = enis.find((n) => n.Type === 'Primary') ?? enis[0];
  const ipv6List: string[] = [];
  for (const eni of enis) {
    for (const v6 of eni.Ipv6Sets?.Ipv6Set ?? []) {
      if (v6.Ipv6Address && net.isIPv6(v6.Ipv6Address) && !ipv6List.includes(v6.Ipv6Address)) {
        ipv6List.push(v6.Ipv6Address);
      }
    }
  }
  const publicIp = raw.EipAddress?.IpAddress || raw.PublicIpAddress?.IpAddress?.[0] || undefined;
  const memGb = raw.Memory ? Math.round((raw.Memory / 1024) * 10) / 10 : undefined;
  const specs = [raw.InstanceType, raw.Cpu && memGb ? `${raw.Cpu}C / ${memGb}G` : ''].filter(Boolean).join(' · ');
  const shape = raw.InstanceType || 'ecs';
  const architecture: 'arm64' | 'x86_64' = /g8m|c8m|r8m|g6r|c6r|yitian|arm/i.test(shape) ? 'arm64' : 'x86_64';

  return {
    provider: 'aliyun',
    instanceId: raw.InstanceId,
    displayName: raw.InstanceName || raw.HostName || raw.InstanceId,
    region: raw.RegionId || fallbackRegion,
    zone: raw.ZoneId,
    shape,
    architecture,
    specs: specs || shape,
    lifecycleState: String(raw.Status || 'UNKNOWN').toUpperCase(),
    networkInterfaceId: primaryEni?.NetworkInterfaceId,
    privateIp: primaryEni?.PrimaryIpAddress || raw.VpcAttributes?.PrivateIpAddress?.IpAddress?.[0],
    publicIp,
    eipAllocationId: raw.EipAddress?.AllocationId || undefined,
    ipv6List,
    alreadyImported: false,
  };
}

async function listAliyunInstances(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets
): Promise<{ ok: boolean; instances: CloudDiscoveredInstance[]; error?: string }> {
  const res = await aliyunRpcRequest<{ Instances?: { Instance?: AliyunInstanceRaw[] } }>(
    'ecs',
    account.region,
    secrets.accessKeyId,
    secrets.secretKey,
    'DescribeInstances',
    { PageSize: '100' }
  );
  if (!res.ok) return { ok: false, instances: [], error: res.error };
  const list = res.data?.Instances?.Instance ?? [];
  return {
    ok: true,
    instances: list.map((raw) => mapAliyunInstance(raw, account.region)),
  };
}

async function getAliyunInstanceDetail(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  instanceId: string
): Promise<CloudInstanceDetailResult> {
  const res = await aliyunRpcRequest<{ Instances?: { Instance?: AliyunInstanceRaw[] } }>(
    'ecs',
    account.region,
    secrets.accessKeyId,
    secrets.secretKey,
    'DescribeInstances',
    { InstanceIds: JSON.stringify([instanceId]) }
  );
  if (!res.ok) return { ok: false, error: res.error };
  const raw = res.data?.Instances?.Instance?.[0];
  if (!raw) return { ok: false, error: `阿里云 ECS 实例 ${instanceId} 不存在` };
  const mapped = mapAliyunInstance(raw, account.region);
  return {
    ok: true,
    lifecycleState: mapped.lifecycleState,
    specs: mapped.specs,
    zone: mapped.zone,
    networkInterfaceId: mapped.networkInterfaceId,
    publicIp: mapped.publicIp || '',
    eipAllocationId: mapped.eipAllocationId,
    ipv6List: mapped.ipv6List,
  };
}

async function aliyunPowerAction(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  instanceId: string,
  action: OciInstanceAction
): Promise<{ ok: boolean; lifecycleState?: string; error?: string }> {
  if (action === 'SOFTRESET' || action === 'RESET') {
    const res = await aliyunRpcRequest(
      'ecs',
      account.region,
      secrets.accessKeyId,
      secrets.secretKey,
      'RebootInstance',
      { InstanceId: instanceId, ForceStop: action === 'RESET' ? 'true' : 'false' }
    );
    return res.ok ? { ok: true, lifecycleState: 'REBOOTING' } : { ok: false, error: res.error };
  }
  if (action === 'START') {
    const res = await aliyunRpcRequest(
      'ecs',
      account.region,
      secrets.accessKeyId,
      secrets.secretKey,
      'StartInstance',
      { InstanceId: instanceId }
    );
    return res.ok ? { ok: true, lifecycleState: 'STARTING' } : { ok: false, error: res.error };
  }
  const res = await aliyunRpcRequest(
    'ecs',
    account.region,
    secrets.accessKeyId,
    secrets.secretKey,
    'StopInstance',
    { InstanceId: instanceId, ForceStop: action === 'STOP' ? 'true' : 'false' }
  );
  return res.ok ? { ok: true, lifecycleState: 'STOPPING' } : { ok: false, error: res.error };
}

async function aliyunAllocateAndBindIpv4(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  instanceId: string,
  oldAllocationId?: string
): Promise<{ ok: boolean; newAddress?: string; allocationId?: string; error?: string }> {
  // If old EIP is attached, unassociate first so ECS can bind a new EIP
  if (oldAllocationId) {
    const unassoc = await aliyunRpcRequest(
      'vpc',
      account.region,
      secrets.accessKeyId,
      secrets.secretKey,
      'UnassociateEipAddress',
      { AllocationId: oldAllocationId, InstanceId: instanceId, InstanceType: 'EcsInstance' }
    );
    if (!unassoc.ok) return { ok: false, error: `解绑旧阿里云 EIP 失败：${unassoc.error}` };
  }

  const alloc = await aliyunRpcRequest<{ AllocationId?: string; EipAddress?: string }>(
    'vpc',
    account.region,
    secrets.accessKeyId,
    secrets.secretKey,
    'AllocateEipAddress',
    { InternetChargeType: 'PayByTraffic', Bandwidth: '5' }
  );
  if (!alloc.ok || !alloc.data?.AllocationId || !alloc.data?.EipAddress) {
    return { ok: false, error: alloc.error || '阿里云申请 EIP 失败' };
  }

  const assoc = await aliyunRpcRequest(
    'vpc',
    account.region,
    secrets.accessKeyId,
    secrets.secretKey,
    'AssociateEipAddress',
    { AllocationId: alloc.data.AllocationId, InstanceId: instanceId, InstanceType: 'EcsInstance' }
  );
  if (!assoc.ok) {
    await aliyunRpcRequest('vpc', account.region, secrets.accessKeyId, secrets.secretKey, 'ReleaseEipAddress', {
      AllocationId: alloc.data.AllocationId,
    });
    return { ok: false, error: assoc.error || '阿里云绑定 EIP 到 ECS 失败' };
  }

  if (oldAllocationId) {
    await aliyunRpcRequest('vpc', account.region, secrets.accessKeyId, secrets.secretKey, 'ReleaseEipAddress', {
      AllocationId: oldAllocationId,
    });
  }

  return { ok: true, newAddress: alloc.data.EipAddress, allocationId: alloc.data.AllocationId };
}

async function aliyunDeletePublicIpv4(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  instanceId: string,
  allocationId?: string
): Promise<{ ok: boolean; error?: string }> {
  if (!allocationId) {
    return {
      ok: false,
      error: '该阿里云 ECS 实例绑定的是固定公网 IP（非弹性公网 EIP），请先转为 EIP 后再执行删除/更换。',
    };
  }
  const unassoc = await aliyunRpcRequest(
    'vpc',
    account.region,
    secrets.accessKeyId,
    secrets.secretKey,
    'UnassociateEipAddress',
    { AllocationId: allocationId, InstanceId: instanceId, InstanceType: 'EcsInstance' }
  );
  if (!unassoc.ok) return { ok: false, error: unassoc.error };

  const rel = await aliyunRpcRequest(
    'vpc',
    account.region,
    secrets.accessKeyId,
    secrets.secretKey,
    'ReleaseEipAddress',
    { AllocationId: allocationId }
  );
  return rel.ok ? { ok: true } : { ok: false, error: rel.error };
}

async function aliyunAddIpv6(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  networkInterfaceId: string,
  requestedAddress?: string
): Promise<{ ok: boolean; ipAddress?: string; error?: string }> {
  const params: Record<string, string> = {
    NetworkInterfaceId: networkInterfaceId,
  };
  if (requestedAddress && net.isIPv6(requestedAddress)) {
    params['Ipv6Address.1'] = requestedAddress;
  } else {
    params.Ipv6AddressCount = '1';
  }
  const res = await aliyunRpcRequest<{ Ipv6Sets?: { Ipv6Address?: string[] } }>(
    'ecs',
    account.region,
    secrets.accessKeyId,
    secrets.secretKey,
    'AssignIpv6Addresses',
    params
  );
  if (!res.ok) return { ok: false, error: res.error };
  const ip = res.data?.Ipv6Sets?.Ipv6Address?.[0] || requestedAddress;
  if (!ip) return { ok: false, error: '阿里云未返回新增的 IPv6 地址（请确认 VPC/交换机已开启 IPv6）' };
  return { ok: true, ipAddress: ip };
}

async function aliyunDeleteIpv6(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  networkInterfaceId: string,
  address: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await aliyunRpcRequest(
    'ecs',
    account.region,
    secrets.accessKeyId,
    secrets.secretKey,
    'UnassignIpv6Addresses',
    { NetworkInterfaceId: networkInterfaceId, 'Ipv6Address.1': address }
  );
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

// ============================================================================
// 3. Google Cloud (GCP Compute Engine) Client (RS256 JWT -> OAuth2 Bearer)
// ============================================================================

const gcpTokenCache = new Map<string, { token: string; expiresAt: number }>();

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function getGcpAccessToken(sa: GcpServiceAccountParsed): Promise<{ ok: boolean; token?: string; error?: string }> {
  const cacheKey = `${sa.projectId}:${sa.clientEmail}`;
  const cached = gcpTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return { ok: true, token: cached.token };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64UrlEncode(
    JSON.stringify({
      iss: sa.clientEmail,
      scope: 'https://www.googleapis.com/auth/compute',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    })
  );
  const signingInput = `${header}.${claim}`;

  let sig: string;
  try {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    sig = base64UrlEncode(signer.sign(sa.privateKey));
  } catch (err) {
    return { ok: false, error: `GCP JWT 签名失败: ${err instanceof Error ? err.message : 'invalid key'}` };
  }

  const assertion = `${signingInput}.${sig}`;
  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
      signal: AbortSignal.timeout(12_000),
    });
    const data = (await resp.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!resp.ok || !data.access_token) {
      return { ok: false, error: data.error_description || data.error || `GCP OAuth HTTP ${resp.status}` };
    }
    gcpTokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(300, (data.expires_in ?? 3600) - 120) * 1000,
    });
    return { ok: true, token: data.access_token };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'GCP OAuth token request failed' };
  }
}

async function gcpComputeRequest<T = Record<string, unknown>>(
  sa: GcpServiceAccountParsed,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const auth = await getGcpAccessToken(sa);
  if (!auth.ok || !auth.token) return { ok: false, error: auth.error };
  const url = `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(sa.projectId)}${path}`;
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await resp.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return { ok: false, error: `GCP HTTP ${resp.status}` };
    }
    if (!resp.ok) {
      const errObj = json.error as { message?: string } | undefined;
      return { ok: false, error: errObj?.message || `GCP Compute HTTP ${resp.status}` };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'GCP Compute API request failed' };
  }
}

interface GcpInstanceRaw {
  id?: string;
  name: string;
  zone?: string;
  machineType?: string;
  status?: string;
  networkInterfaces?: Array<{
    name?: string;
    networkIP?: string;
    ipv6Address?: string;
    stackType?: string;
    fingerprint?: string;
    accessConfigs?: Array<{ name?: string; natIP?: string; type?: string }>;
    ipv6AccessConfigs?: Array<{ name?: string; externalIpv6?: string; type?: string }>;
  }>;
}

function mapGcpInstance(raw: GcpInstanceRaw, fallbackRegion: string): CloudDiscoveredInstance {
  const zoneFull = raw.zone || '';
  const zone = zoneFull.split('/').pop() || undefined;
  const region = zone ? zone.replace(/-[a-z]$/, '') : fallbackRegion;
  const machineType = (raw.machineType || '').split('/').pop() || 'compute';
  const nic = raw.networkInterfaces?.[0];
  const publicIp = nic?.accessConfigs?.[0]?.natIP || undefined;
  const ipv6List: string[] = [];
  if (nic?.ipv6Address && net.isIPv6(nic.ipv6Address)) ipv6List.push(nic.ipv6Address);
  for (const ac of nic?.ipv6AccessConfigs ?? []) {
    if (ac.externalIpv6 && net.isIPv6(ac.externalIpv6) && !ipv6List.includes(ac.externalIpv6)) {
      ipv6List.push(ac.externalIpv6);
    }
  }
  const architecture: 'arm64' | 'x86_64' = /^t2a|^c4a/i.test(machineType) ? 'arm64' : 'x86_64';

  return {
    provider: 'gcp',
    instanceId: raw.name, // GCP Compute API addresses instances by name + zone
    displayName: raw.name,
    region,
    zone,
    shape: machineType,
    architecture,
    specs: `${machineType} (${architecture})`,
    lifecycleState: String(raw.status || 'UNKNOWN').toUpperCase(),
    networkInterfaceId: nic?.name || 'nic0',
    privateIp: nic?.networkIP,
    publicIp,
    ipv6List,
    alreadyImported: false,
  };
}

async function listGcpInstances(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets
): Promise<{ ok: boolean; instances: CloudDiscoveredInstance[]; error?: string }> {
  const parsed = parseGcpServiceAccountJson(secrets.serviceAccountJson);
  if (!parsed.ok) return { ok: false, instances: [], error: parsed.error };

  const targetZone = account.zone?.trim().toLowerCase();
  if (targetZone && GCP_ZONE_REGEX.test(targetZone)) {
    const res = await gcpComputeRequest<{ items?: GcpInstanceRaw[] }>(
      parsed.data,
      'GET',
      `/zones/${encodeURIComponent(targetZone)}/instances`
    );
    if (!res.ok) return { ok: false, instances: [], error: res.error };
    return {
      ok: true,
      instances: (res.data?.items ?? []).map((item) => mapGcpInstance(item, account.region)),
    };
  }

  const res = await gcpComputeRequest<{ items?: Record<string, { instances?: GcpInstanceRaw[] }> }>(
    parsed.data,
    'GET',
    '/aggregated/instances'
  );
  if (!res.ok) return { ok: false, instances: [], error: res.error };
  const filterRegion = account.region && account.region !== 'all' ? account.region.toLowerCase() : '';
  const all: CloudDiscoveredInstance[] = [];
  for (const zoneEntry of Object.values(res.data?.items ?? {})) {
    for (const raw of zoneEntry.instances ?? []) {
      const mapped = mapGcpInstance(raw, account.region);
      if (filterRegion && mapped.region.toLowerCase() !== filterRegion && mapped.zone?.toLowerCase() !== filterRegion) {
        continue;
      }
      all.push(mapped);
    }
  }
  return { ok: true, instances: all };
}

async function getGcpInstanceDetail(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  instanceName: string,
  zone?: string
): Promise<CloudInstanceDetailResult & { raw?: GcpInstanceRaw }> {
  const parsed = parseGcpServiceAccountJson(secrets.serviceAccountJson);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const cleanZone = (zone || account.zone || '').trim().toLowerCase();
  if (!GCP_ZONE_REGEX.test(cleanZone)) {
    return { ok: false, error: 'GCP 实例缺少有效的 Zone（例如 asia-east1-b），请先重新同步实例清单' };
  }
  const res = await gcpComputeRequest<GcpInstanceRaw>(
    parsed.data,
    'GET',
    `/zones/${encodeURIComponent(cleanZone)}/instances/${encodeURIComponent(instanceName)}`
  );
  if (!res.ok || !res.data) return { ok: false, error: res.error };
  const mapped = mapGcpInstance(res.data, account.region);
  return {
    ok: true,
    lifecycleState: mapped.lifecycleState,
    specs: mapped.specs,
    zone: mapped.zone,
    networkInterfaceId: mapped.networkInterfaceId,
    publicIp: mapped.publicIp || '',
    ipv6List: mapped.ipv6List,
    raw: res.data,
  };
}

async function gcpPowerAction(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  instanceName: string,
  zone: string | undefined,
  action: OciInstanceAction
): Promise<{ ok: boolean; lifecycleState?: string; error?: string }> {
  const parsed = parseGcpServiceAccountJson(secrets.serviceAccountJson);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const cleanZone = (zone || account.zone || '').trim().toLowerCase();
  if (!GCP_ZONE_REGEX.test(cleanZone)) {
    return { ok: false, error: 'GCP 实例缺少有效 Zone' };
  }
  const op = action === 'START' ? 'start' : action === 'STOP' || action === 'SOFTSTOP' ? 'stop' : 'reset';
  const res = await gcpComputeRequest(
    parsed.data,
    'POST',
    `/zones/${encodeURIComponent(cleanZone)}/instances/${encodeURIComponent(instanceName)}/${op}`
  );
  const nextState = op === 'start' ? 'STAGING' : op === 'stop' ? 'STOPPING' : 'RESETTING';
  return res.ok ? { ok: true, lifecycleState: nextState } : { ok: false, error: res.error };
}

async function gcpWaitZoneOp(
  sa: GcpServiceAccountParsed,
  zone: string,
  opName?: string
): Promise<void> {
  if (!opName) return;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    const check = await gcpComputeRequest<{ status?: string }>(
      sa,
      'GET',
      `/zones/${encodeURIComponent(zone)}/operations/${encodeURIComponent(opName)}`
    );
    if (!check.ok || check.data?.status === 'DONE') return;
  }
}

async function gcpAllocateOrSwapIpv4(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  instanceName: string,
  zone: string | undefined,
  replaceExisting: boolean
): Promise<{ ok: boolean; newAddress?: string; error?: string }> {
  const parsed = parseGcpServiceAccountJson(secrets.serviceAccountJson);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const detail = await getGcpInstanceDetail(account, secrets, instanceName, zone);
  if (!detail.ok || !detail.raw || !detail.zone) return { ok: false, error: detail.error || '无法读取 GCP 实例' };

  const nic = detail.raw.networkInterfaces?.[0];
  const nicName = nic?.name || 'nic0';
  const existingAccess = nic?.accessConfigs?.[0];

  if (existingAccess && !replaceExisting) {
    return { ok: false, error: `该 GCP 实例已有公网 IPv4 (${existingAccess.natIP || ''})，请点击更换 IPv4` };
  }
  if (existingAccess && replaceExisting) {
    const delOp = await gcpComputeRequest<{ name?: string }>(
      parsed.data,
      'POST',
      `/zones/${encodeURIComponent(detail.zone)}/instances/${encodeURIComponent(instanceName)}/deleteAccessConfig?accessConfig=${encodeURIComponent(existingAccess.name || 'External NAT')}&networkInterface=${encodeURIComponent(nicName)}`
    );
    if (!delOp.ok) return { ok: false, error: `删除旧 GCP AccessConfig 失败：${delOp.error}` };
    await gcpWaitZoneOp(parsed.data, detail.zone, delOp.data?.name);
  }

  const addOp = await gcpComputeRequest<{ name?: string }>(
    parsed.data,
    'POST',
    `/zones/${encodeURIComponent(detail.zone)}/instances/${encodeURIComponent(instanceName)}/addAccessConfig?networkInterface=${encodeURIComponent(nicName)}`,
    {
      kind: 'compute#accessConfig',
      type: 'ONE_TO_ONE_NAT',
      name: 'External NAT',
      networkTier: 'PREMIUM',
    }
  );
  if (!addOp.ok) return { ok: false, error: `GCP 申请新公网 IPv4 失败：${addOp.error}` };
  await gcpWaitZoneOp(parsed.data, detail.zone, addOp.data?.name);

  const refreshed = await getGcpInstanceDetail(account, secrets, instanceName, detail.zone);
  if (!refreshed.ok || !refreshed.publicIp) {
    return { ok: false, error: 'GCP 已下发分配请求，但尚未读取到新 IPv4，请稍后点击检测刷新' };
  }
  return { ok: true, newAddress: refreshed.publicIp };
}

async function gcpDeletePublicIpv4(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  instanceName: string,
  zone: string | undefined
): Promise<{ ok: boolean; error?: string }> {
  const parsed = parseGcpServiceAccountJson(secrets.serviceAccountJson);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const detail = await getGcpInstanceDetail(account, secrets, instanceName, zone);
  if (!detail.ok || !detail.raw || !detail.zone) return { ok: false, error: detail.error || '无法读取 GCP 实例' };

  const nic = detail.raw.networkInterfaces?.[0];
  const nicName = nic?.name || 'nic0';
  const existingAccess = nic?.accessConfigs?.[0];
  if (!existingAccess) return { ok: false, error: '该 GCP 实例当前没有绑定公网 IPv4 AccessConfig' };

  const delOp = await gcpComputeRequest<{ name?: string }>(
    parsed.data,
    'POST',
    `/zones/${encodeURIComponent(detail.zone)}/instances/${encodeURIComponent(instanceName)}/deleteAccessConfig?accessConfig=${encodeURIComponent(existingAccess.name || 'External NAT')}&networkInterface=${encodeURIComponent(nicName)}`
  );
  if (!delOp.ok) return { ok: false, error: delOp.error };
  await gcpWaitZoneOp(parsed.data, detail.zone, delOp.data?.name);
  return { ok: true };
}

async function gcpToggleIpv6(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  instanceName: string,
  zone: string | undefined,
  enable: boolean
): Promise<{ ok: boolean; ipv6List?: string[]; error?: string }> {
  const parsed = parseGcpServiceAccountJson(secrets.serviceAccountJson);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const detail = await getGcpInstanceDetail(account, secrets, instanceName, zone);
  if (!detail.ok || !detail.raw || !detail.zone) return { ok: false, error: detail.error || '无法读取 GCP 实例' };

  const nic = detail.raw.networkInterfaces?.[0];
  const nicName = nic?.name || 'nic0';
  const payload = enable
    ? {
        fingerprint: nic?.fingerprint,
        stackType: 'IPV4_IPV6',
        ipv6AccessConfigs: [
          {
            type: 'DIRECT_IPV6',
            name: 'External IPv6',
            networkTier: 'PREMIUM',
          },
        ],
      }
    : {
        fingerprint: nic?.fingerprint,
        stackType: 'IPV4_ONLY',
        ipv6AccessConfigs: [],
      };

  const op = await gcpComputeRequest<{ name?: string }>(
    parsed.data,
    'PATCH',
    `/zones/${encodeURIComponent(detail.zone)}/instances/${encodeURIComponent(instanceName)}/updateNetworkInterface?networkInterface=${encodeURIComponent(nicName)}`,
    payload
  );
  if (!op.ok) return { ok: false, error: op.error };
  await gcpWaitZoneOp(parsed.data, detail.zone, op.data?.name);

  const refreshed = await getGcpInstanceDetail(account, secrets, instanceName, detail.zone);
  return { ok: true, ipv6List: refreshed.ipv6List ?? [] };
}

// ============================================================================
// 4. Unified Multi-Cloud Dispatcher (AWS / Aliyun / GCP)
// ============================================================================

export async function listCloudAccountInstances(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets
): Promise<{ ok: boolean; instances: CloudDiscoveredInstance[]; error?: string }> {
  if (account.provider === 'aws') return listAwsInstances(account, secrets);
  if (account.provider === 'aliyun') return listAliyunInstances(account, secrets);
  return listGcpInstances(account, secrets);
}

export async function testCloudAccount(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets
): Promise<{ ok: boolean; instanceCount: number; error?: string }> {
  const res = await listCloudAccountInstances(account, secrets);
  if (!res.ok) return { ok: false, instanceCount: 0, error: res.error };
  return { ok: true, instanceCount: res.instances.length };
}

export async function getCloudHostDetail(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  host: StoredCloudHost
): Promise<CloudInstanceDetailResult> {
  if (account.provider === 'aws') return getAwsInstanceDetail(account, secrets, host.instanceId);
  if (account.provider === 'aliyun') return getAliyunInstanceDetail(account, secrets, host.instanceId);
  return getGcpInstanceDetail(account, secrets, host.instanceId, host.cloudZone);
}

export async function cloudHostPowerAction(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  host: StoredCloudHost,
  action: OciInstanceAction
): Promise<{ ok: boolean; lifecycleState?: string; error?: string }> {
  if (account.provider === 'aws') return awsPowerAction(account, secrets, host.instanceId, action);
  if (account.provider === 'aliyun') return aliyunPowerAction(account, secrets, host.instanceId, action);
  return gcpPowerAction(account, secrets, host.instanceId, host.cloudZone, action);
}

export async function cloudHostAddIpv4(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  host: StoredCloudHost
): Promise<{
  ok: boolean;
  newAddress?: string;
  allocationId?: string;
  associationId?: string;
  error?: string;
}> {
  if (account.provider === 'aws') {
    return awsAllocateAndBindIpv4(account, secrets, host.instanceId);
  }
  if (account.provider === 'aliyun') {
    return aliyunAllocateAndBindIpv4(account, secrets, host.instanceId);
  }
  return gcpAllocateOrSwapIpv4(account, secrets, host.instanceId, host.cloudZone, false);
}

export async function cloudHostSwapIpv4(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  host: StoredCloudHost
): Promise<{
  ok: boolean;
  oldAddress?: string;
  newAddress?: string;
  allocationId?: string;
  associationId?: string;
  error?: string;
}> {
  const oldAddress = host.ipv4 || undefined;
  if (account.provider === 'aws') {
    let allocId = host.cloudEipAllocationId;
    let assocId = host.cloudAllocationAssociationId;
    if (!allocId) {
      const eip = await awsLookupEipForInstance(account.region, secrets, host.instanceId);
      allocId = eip.allocationId;
      assocId = eip.associationId;
    }
    const res = await awsAllocateAndBindIpv4(account, secrets, host.instanceId, allocId, assocId);
    return { ...res, oldAddress };
  }
  if (account.provider === 'aliyun') {
    let allocId = host.cloudEipAllocationId;
    if (!allocId) {
      const detail = await getAliyunInstanceDetail(account, secrets, host.instanceId);
      allocId = detail.eipAllocationId;
    }
    const res = await aliyunAllocateAndBindIpv4(account, secrets, host.instanceId, allocId);
    return { ...res, oldAddress };
  }
  const res = await gcpAllocateOrSwapIpv4(account, secrets, host.instanceId, host.cloudZone, true);
  return { ...res, oldAddress };
}

export async function cloudHostDeleteIpv4(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  host: StoredCloudHost
): Promise<{ ok: boolean; error?: string }> {
  if (account.provider === 'aws') {
    return awsDeletePublicIpv4(
      account,
      secrets,
      host.instanceId,
      host.cloudEipAllocationId,
      host.cloudAllocationAssociationId
    );
  }
  if (account.provider === 'aliyun') {
    return aliyunDeletePublicIpv4(account, secrets, host.instanceId, host.cloudEipAllocationId);
  }
  return gcpDeletePublicIpv4(account, secrets, host.instanceId, host.cloudZone);
}

export async function cloudHostAddIpv6(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  host: StoredCloudHost,
  requestedAddress?: string
): Promise<{ ok: boolean; ipAddress?: string; error?: string }> {
  if (account.provider === 'gcp') {
    const res = await gcpToggleIpv6(account, secrets, host.instanceId, host.cloudZone, true);
    if (!res.ok) return { ok: false, error: res.error };
    const ip = res.ipv6List?.[0];
    if (!ip) return { ok: false, error: 'GCP 已切换双栈，但尚未分配外部 IPv6（请确认子网已开启 IPv6）' };
    return { ok: true, ipAddress: ip };
  }

  let nicId = host.cloudNetworkInterfaceId;
  if (!nicId) {
    const detail = await getCloudHostDetail(account, secrets, host);
    nicId = detail.networkInterfaceId;
  }
  if (!nicId) {
    return { ok: false, error: '未获取到主网卡 ID (ENI)，请先点击检测刷新状态' };
  }
  if (account.provider === 'aws') {
    return awsAddIpv6(account, secrets, nicId, requestedAddress);
  }
  return aliyunAddIpv6(account, secrets, nicId, requestedAddress);
}

export async function cloudHostDeleteIpv6(
  account: StoredCloudAccount,
  secrets: CloudAccountSecrets,
  host: StoredCloudHost,
  address: string
): Promise<{ ok: boolean; error?: string }> {
  if (account.provider === 'gcp') {
    const res = await gcpToggleIpv6(account, secrets, host.instanceId, host.cloudZone, false);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  let nicId = host.cloudNetworkInterfaceId;
  if (!nicId) {
    const detail = await getCloudHostDetail(account, secrets, host);
    nicId = detail.networkInterfaceId;
  }
  if (!nicId) {
    return { ok: false, error: '未获取到主网卡 ID (ENI)，请先点击检测刷新状态' };
  }
  if (account.provider === 'aws') {
    return awsDeleteIpv6(account, secrets, nicId, address);
  }
  return aliyunDeleteIpv6(account, secrets, nicId, address);
}
