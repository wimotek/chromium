import { store, type StoredOciProfile, type StoredOciSniperTask } from '../lib/store.ts';
import { executeDnsSyncRule } from './dnsSync.ts';
import { dispatchSystemNotification } from './notifier.ts';
import {
  buildOciSignatureHeaders,
  computeOciFingerprint,
  discoverOciResources,
  isValidOcid,
  listOciImages,
} from './ociClient.ts';

function computeNextAttemptIso(intervalSeconds: number, jitterPercent: number, overrideSeconds?: number): string {
  const baseSec = overrideSeconds ?? Math.max(15, intervalSeconds);
  const jitterFactor = 1 + ((Math.random() * 2 - 1) * Math.min(50, Math.max(0, jitterPercent))) / 100;
  const delayMs = Math.max(10_000, Math.round(baseSec * jitterFactor * 1000));
  return new Date(Date.now() + delayMs).toISOString();
}

function isPlaceholderAdList(ads: string[]): boolean {
  if (!ads || ads.length === 0) return true;
  return ads.every((a) => !a.includes(':') && /^AD-\d+$/i.test(a.trim()));
}

/**
 * Zero-main.tf automatic OCI parameter resolver:
 * Automatically queries live OCI Identity, VirtualNetwork, and Compute Image APIs to populate
 * Compartment OCID, Availability Domains, best Public Subnet (preferring IPv6 if requested),
 * and the latest official OS Image OCID compatible with the selected shape.
 */
export async function autoResolveSniperParams(
  profile: StoredOciProfile,
  privateKeyPem: string,
  shape: 'VM.Standard.A1.Flex' | 'VM.Standard.E2.1.Micro',
  options?: { osHint?: string; assignIpv6?: boolean }
): Promise<{
  ok: boolean;
  error?: string;
  region?: string;
  compartmentOcid?: string;
  subnetOcid?: string;
  subnetName?: string;
  subnets?: Array<{ id: string; displayName: string; cidrBlock: string; ipv6CidrBlock?: string; isPublic: boolean }>;
  availabilityDomains?: string[];
  images?: Array<{
    id: string;
    displayName: string;
    operatingSystem: string;
    operatingSystemVersion: string;
    timeCreated?: string;
  }>;
  recommendedImage?: {
    id: string;
    displayName: string;
    operatingSystem: string;
    operatingSystemVersion: string;
  };
}> {
  const compId = profile.compartmentOcid || profile.tenancyOcid;
  const discovered = await discoverOciResources({
    region: profile.region,
    tenancyOcid: profile.tenancyOcid,
    userOcid: profile.userOcid,
    compartmentOcid: compId,
    privateKeyPem,
  });

  if (!discovered.ok || !discovered.resources) {
    return {
      ok: false,
      error: discovered.error || '无法连接 OCI API 自动获取参数，请检查云账号凭据与网络连通性',
    };
  }

  const res = discovered.resources;
  const resolvedCompartment = profile.compartmentOcid || res.compartments[0]?.id || profile.tenancyOcid;
  const resolvedAds = res.availabilityDomains;

  // Prefer public subnet (and IPv6-capable public subnet when assignIpv6 is true)
  const wantIpv6 = options?.assignIpv6 !== false;
  const bestSubnet =
    res.subnets.find((s) => s.id === profile.subnetOcid) ||
    (wantIpv6 ? res.subnets.find((s) => s.isPublic && Boolean(s.ipv6CidrBlock)) : undefined) ||
    res.subnets.find((s) => s.isPublic) ||
    res.subnets[0];

  const imgRes = await listOciImages(
    { ...profile, compartmentOcid: resolvedCompartment },
    privateKeyPem,
    shape
  );
  const images = imgRes.ok ? imgRes.images : [];
  const osHint = (options?.osHint || '').toLowerCase();

  let recommendedImage = images[0];
  if (images.length > 0) {
    if (osHint.includes('debian')) {
      recommendedImage = images.find((i) => /debian/i.test(i.displayName)) || images[0];
    } else if (osHint.includes('oracle')) {
      recommendedImage = images.find((i) => /oracle.*linux/i.test(i.displayName)) || images[0];
    } else if (osHint.includes('22.04')) {
      recommendedImage = images.find((i) => /ubuntu.*22\.04/i.test(i.displayName)) || images[0];
    } else {
      recommendedImage =
        images.find((i) => /ubuntu.*24\.04/i.test(i.displayName)) ||
        images.find((i) => /ubuntu.*22\.04/i.test(i.displayName)) ||
        images[0];
    }
  }

  // Persist discovered profile parameters so future runs & scripts stay ready
  let dirty = false;
  if (!profile.compartmentOcid && resolvedCompartment) {
    profile.compartmentOcid = resolvedCompartment;
    dirty = true;
  }
  if (resolvedAds.length > 0) {
    profile.availabilityDomains = resolvedAds;
    dirty = true;
  }
  if (!profile.subnetOcid && bestSubnet?.id) {
    profile.subnetOcid = bestSubnet.id;
    dirty = true;
  }
  if (res.homeRegion && !profile.homeRegion) {
    profile.homeRegion = res.homeRegion;
    dirty = true;
  }
  if (dirty) {
    profile.status = 'active';
    profile.lastCheckedAt = new Date().toISOString();
    profile.updatedAt = profile.lastCheckedAt;
    store.save();
  }

  return {
    ok: true,
    region: profile.region,
    compartmentOcid: resolvedCompartment,
    subnetOcid: bestSubnet?.id || profile.subnetOcid || '',
    subnetName: bestSubnet?.displayName,
    subnets: res.subnets.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      cidrBlock: s.cidrBlock,
      ipv6CidrBlock: s.ipv6CidrBlock,
      isPublic: s.isPublic,
    })),
    availabilityDomains: resolvedAds,
    images,
    recommendedImage,
  };
}

export async function runOciSniperAttempt(
  taskId: string,
  actor: string,
  ip: string
): Promise<{ ok: boolean; code: number; message: string }> {
  const state = store.getState();
  const task = state.ociSniperTasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, code: 404, message: 'Sniper task not found' };

  const profile = state.ociProfiles.find((p) => p.id === task.profileId);
  if (!profile) {
    task.status = 'failed';
    task.lastMessage = 'Linked OCI regional profile not found';
    store.save();
    return { ok: false, code: 404, message: task.lastMessage };
  }

  const now = new Date().toISOString();
  const privateKeyPem = store.getOciPrivateKey(profile.id);

  if (!privateKeyPem || !privateKeyPem.includes('BEGIN')) {
    const adList = task.availabilityDomains.length > 0 ? task.availabilityDomains : profile.availabilityDomains;
    const adTarget = adList[task.attempts % Math.max(1, adList.length)] || 'AD-1';
    task.attempts += 1;
    task.lastAttemptAt = now;
    task.lastResponseCode = 412;
    task.lastMessage = `Preflight check passed for ${profile.region}/${adTarget} (${task.shape} ${task.ocpus}C/${task.memoryInGBs}G). Upload OCI PEM Private Key in 云账号凭据 ("${profile.name}") to send live LaunchInstance API requests (免 main.tf 自动解析).`;
    task.nextAttemptAt = task.status === 'running' ? computeNextAttemptIso(task.intervalSeconds, task.jitterPercent) : undefined;
    task.updatedAt = now;
    store.save();

    store.appendAudit({
      category: 'oci',
      severity: 'info',
      action: 'OCI_SNIPER_PREFLIGHT',
      actor,
      ip,
      target: `${task.name} (${profile.region})`,
      details: task.lastMessage,
    });
    return { ok: false, code: 412, message: task.lastMessage };
  }

  // Zero-main.tf runtime auto-discovery: if Subnet, real ADs, or Image OCID are missing, fetch live from OCI API!
  const needsAutoResolve =
    !isValidOcid(profile.subnetOcid) ||
    !isValidOcid(task.imageOcid) ||
    (isPlaceholderAdList(task.availabilityDomains) && isPlaceholderAdList(profile.availabilityDomains));

  if (needsAutoResolve) {
    const resolved = await autoResolveSniperParams(profile, privateKeyPem, task.shape, {
      osHint: task.osPreset,
      assignIpv6: task.assignIpv6,
    });
    if (!resolved.ok) {
      task.attempts += 1;
      task.lastAttemptAt = now;
      task.lastResponseCode = 424;
      task.lastMessage = `免 main.tf 自动解析参数失败：${resolved.error}`;
      task.nextAttemptAt = task.status === 'running' ? computeNextAttemptIso(task.intervalSeconds, task.jitterPercent) : undefined;
      task.updatedAt = now;
      store.save();
      return { ok: false, code: 424, message: task.lastMessage };
    }
    if (resolved.availabilityDomains?.length && isPlaceholderAdList(task.availabilityDomains)) {
      task.availabilityDomains = resolved.availabilityDomains;
    }
    if (!isValidOcid(task.imageOcid) && resolved.recommendedImage?.id) {
      task.imageOcid = resolved.recommendedImage.id;
      task.osPreset = resolved.recommendedImage.displayName;
    }
    store.save();
  }

  if (!isValidOcid(profile.subnetOcid)) {
    task.lastMessage = `区域 ${profile.region} 未找到可用子网 (Subnet OCID)，请先在 Oracle 控制台创建 VCN/公网子网后重试。`;
    task.updatedAt = now;
    store.save();
    return { ok: false, code: 400, message: task.lastMessage };
  }
  if (!isValidOcid(task.imageOcid)) {
    task.lastMessage = `区域 ${profile.region} 未能自动匹配到 ${task.shape} 可用的官方镜像 OCID。`;
    task.updatedAt = now;
    store.save();
    return { ok: false, code: 400, message: task.lastMessage };
  }

  const adList = task.availabilityDomains.length > 0 ? task.availabilityDomains : profile.availabilityDomains;
  const adTarget = adList[task.attempts % Math.max(1, adList.length)] || 'AD-1';
  task.attempts += 1;
  task.lastAttemptAt = now;

  const regionPattern = /^[a-z]{2}-[a-z0-9-]+-\d+$/;
  if (!regionPattern.test(profile.region)) {
    return { ok: false, code: 400, message: 'Invalid OCI region identifier' };
  }

  const derivedFp = computeOciFingerprint(privateKeyPem);
  const activeFingerprint = derivedFp.ok ? derivedFp.fingerprint : profile.fingerprint;

  const host = `iaas.${profile.region}.oraclecloud.com`;
  const apiPath = '/20160918/instances/';
  const launchPayload = {
    compartmentId: profile.compartmentOcid || profile.tenancyOcid,
    availabilityDomain: adTarget,
    displayName: task.displayName,
    shape: task.shape,
    ...(task.shape === 'VM.Standard.A1.Flex'
      ? {
          shapeConfig: {
            ocpus: task.ocpus,
            memoryInGBs: task.memoryInGBs,
          },
        }
      : {}),
    createVnicDetails: {
      subnetId: profile.subnetOcid,
      assignPublicIp: task.assignPublicIp,
      assignIpv6Ip: task.assignIpv6,
    },
    sourceDetails: {
      sourceType: 'image',
      imageId: task.imageOcid,
      bootVolumeSizeInGBs: task.bootVolumeSizeInGBs,
    },
    metadata: task.sshPublicKey
      ? { ssh_authorized_keys: task.sshPublicKey }
      : {},
  };

  const bodyStr = JSON.stringify(launchPayload);

  try {
    const signedHeaders = buildOciSignatureHeaders({
      method: 'POST',
      host,
      path: apiPath,
      body: bodyStr,
      tenancyOcid: profile.tenancyOcid,
      userOcid: profile.userOcid,
      fingerprint: activeFingerprint,
      privateKeyPem,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(`https://${host}${apiPath}`, {
      method: 'POST',
      headers: signedHeaders,
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { message: text.slice(0, 220) };
    }

    task.lastResponseCode = res.status;

    if (res.ok) {
      const instanceId = String(parsed.id ?? '');
      task.createdInstanceId = instanceId;
      task.lastMessage = `Allocated ${task.shape} in ${profile.region}/${adTarget} (${instanceId})`;
      if (task.autoStopOnSuccess) {
        task.status = 'succeeded';
        task.nextAttemptAt = undefined;
      }
      profile.instanceCount += 1;
      profile.status = 'active';
      profile.lastCheckedAt = now;
      task.updatedAt = now;
      store.save();

      store.appendAudit({
        category: 'oci',
        severity: 'success',
        action: 'OCI_ARM_ALLOCATED',
        actor,
        ip,
        target: `${task.name} (${profile.region})`,
        details: task.lastMessage,
      });

      if (task.useSystemNotifications) {
        await dispatchSystemNotification({
          event: 'oci_sniper_success',
          title: `OCI ARM Allocated: ${task.displayName}`,
          message: `Task: ${task.name}\nRegion: ${profile.region}/${adTarget}\nShape: ${task.shape} (${task.ocpus}C/${task.memoryInGBs}G)\nInstance OCID: ${instanceId}`,
          channelIds: task.notifyChannelIds.length > 0 ? task.notifyChannelIds : undefined,
          actor,
          ip,
        });
      }

      if (task.autoBindDnsRuleId) {
        await executeDnsSyncRule(task.autoBindDnsRuleId, 'oci-sniper', ip);
      }

      return { ok: true, code: res.status, message: task.lastMessage };
    }

    const ociErrMsg = String(parsed.message || parsed.code || `HTTP ${res.status}`);
    task.lastMessage = `[${adTarget}] HTTP ${res.status}: ${ociErrMsg}`;

    if (res.status === 429) {
      task.nextAttemptAt = computeNextAttemptIso(task.intervalSeconds, task.jitterPercent, task.backoffOn429Seconds);
    } else if (res.status === 500 && ociErrMsg.toLowerCase().includes('capacity') && task.retryOnOutOfCapacity) {
      task.nextAttemptAt = computeNextAttemptIso(task.intervalSeconds, task.jitterPercent);
    } else if (res.status === 401 || res.status === 404) {
      task.status = 'failed';
      task.nextAttemptAt = undefined;
      profile.status = 'error';
      if (task.useSystemNotifications) {
        await dispatchSystemNotification({
          event: 'oci_sniper_error',
          title: `OCI ARM Sniper Auth/Config Error: ${task.name}`,
          message: `Region: ${profile.region}/${adTarget}\nHTTP ${res.status}: ${ociErrMsg}`,
          channelIds: task.notifyChannelIds.length > 0 ? task.notifyChannelIds : undefined,
          actor,
          ip,
        });
      }
    } else {
      task.nextAttemptAt = computeNextAttemptIso(task.intervalSeconds, task.jitterPercent);
    }

    if (task.maxAttempts > 0 && task.attempts >= task.maxAttempts && task.status === 'running') {
      task.status = 'paused';
      task.nextAttemptAt = undefined;
    }

    task.updatedAt = now;
    store.save();

    store.appendAudit({
      category: 'oci',
      severity: res.status === 500 ? 'info' : 'warning',
      action: 'OCI_SNIPER_ATTEMPT',
      actor,
      ip,
      target: `${task.name} (${profile.region}/${adTarget})`,
      details: task.lastMessage,
    });

    return { ok: false, code: res.status, message: task.lastMessage };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'OCI request failed';
    task.lastResponseCode = 0;
    task.lastMessage = `Request error: ${msg}`;
    task.nextAttemptAt = task.status === 'running' ? computeNextAttemptIso(task.intervalSeconds, task.jitterPercent) : undefined;
    task.updatedAt = now;
    store.save();

    store.appendAudit({
      category: 'oci',
      severity: 'error',
      action: 'OCI_SNIPER_ERROR',
      actor,
      ip,
      target: `${task.name} (${profile.region})`,
      details: task.lastMessage,
    });
    return { ok: false, code: 0, message: task.lastMessage };
  }
}

function escapeShellVal(v: string): string {
  return v.replace(/[\\"$`]/g, '\\$&');
}

export function generateStandaloneOciScript(
  profile: StoredOciProfile,
  task: StoredOciSniperTask,
  format: 'bash' | 'python' = 'bash'
): { filename: string; script: string } {
  const ads = task.availabilityDomains.length ? task.availabilityDomains : profile.availabilityDomains;
  const realAds = isPlaceholderAdList(ads) ? [] : ads;

  if (format === 'python') {
    const script = `#!/usr/bin/env python3
"""
NetPulse Generated OCI ARM Instance Sniper (Python oci SDK · 免 main.tf 自动拉取参数)
Profile: ${profile.name} (${profile.region})
Task: ${task.name}
Install: pip install oci requests
"""
import os
import random
import time
import oci
import requests

REGION = ${JSON.stringify(profile.region)}
COMPARTMENT_ID = ${JSON.stringify(profile.compartmentOcid || '')}
SUBNET_ID = ${JSON.stringify(profile.subnetOcid || '')}
IMAGE_ID = ${JSON.stringify(task.imageOcid || '')}
OS_HINT = ${JSON.stringify(task.osPreset || 'Ubuntu 24.04')}
DISPLAY_NAME = ${JSON.stringify(task.displayName)}
SHAPE = ${JSON.stringify(task.shape)}
OCPUS = ${task.ocpus}
MEMORY_GB = ${task.memoryInGBs}
BOOT_GB = ${task.bootVolumeSizeInGBs}
SSH_PUBLIC_KEY = ${JSON.stringify(task.sshPublicKey || '')}
AVAILABILITY_DOMAINS = ${JSON.stringify(realAds)}
INTERVAL_SEC = ${task.intervalSeconds}
JITTER_PCT = ${task.jitterPercent}
BACKOFF_429 = ${task.backoffOn429Seconds}
MAX_ATTEMPTS = ${task.maxAttempts}

SERVERCHAN_KEY = os.getenv("SERVERCHAN_SENDKEY", "")

def notify(title: str, body: str) -> None:
    if SERVERCHAN_KEY:
        requests.post(
            f"https://sctapi.ftqq.com/{SERVERCHAN_KEY}.send",
            json={"title": title[:32], "desp": body},
            timeout=10,
        )

def auto_discover_without_maintf(config: dict):
    """Zero main.tf: automatically query ADs, Public Subnet, and latest matching OS Image from OCI API."""
    identity = oci.identity.IdentityClient(config)
    vnet = oci.core.VirtualNetworkClient(config)
    compute = oci.core.ComputeClient(config)

    comp_id = COMPARTMENT_ID or config["tenancy"]
    ads = list(AVAILABILITY_DOMAINS)
    if not ads:
        ads = [ad.name for ad in identity.list_availability_domains(comp_id).data]
        print(f"[Auto-Discover] Availability Domains: {ads}")

    subnet_id = SUBNET_ID
    if not subnet_id:
        subnets = vnet.list_subnets(comp_id).data
        public_subnets = [s for s in subnets if not s.prohibit_public_ip_on_vnic]
        chosen = (public_subnets or subnets)[0] if subnets else None
        if not chosen:
            raise RuntimeError("No Subnet found in compartment; create a VCN/Subnet in OCI Console first.")
        subnet_id = chosen.id
        print(f"[Auto-Discover] Public Subnet: {chosen.display_name} ({subnet_id})")

    image_id = IMAGE_ID
    if not image_id:
        images = compute.list_images(comp_id, shape=SHAPE, sort_by="TIMECREATED", sort_order="DESC").data
        preferred = next((img for img in images if "ubuntu" in img.display_name.lower() and "24.04" in img.display_name.lower()), None)
        if not preferred and images:
            preferred = images[0]
        if not preferred:
            raise RuntimeError(f"No official OCI image found for shape {SHAPE}")
        image_id = preferred.id
        print(f"[Auto-Discover] OS Image: {preferred.display_name} ({image_id})")

    return comp_id, ads, subnet_id, image_id

def main() -> None:
    config = oci.config.from_file("~/.oci/config", "DEFAULT")
    config["region"] = REGION
    comp_id, ads, subnet_id, image_id = auto_discover_without_maintf(config)
    compute = oci.core.ComputeClient(config)
    attempt = 0

    while True:
        attempt += 1
        ad = ads[(attempt - 1) % len(ads)]
        print(f"[Attempt #{attempt}] Launching {SHAPE} ({OCPUS}C/{MEMORY_GB}G) in {REGION}/{ad} ...")
        try:
            details = oci.core.models.LaunchInstanceDetails(
                compartment_id=comp_id,
                availability_domain=ad,
                display_name=DISPLAY_NAME,
                shape=SHAPE,
                shape_config=oci.core.models.LaunchInstanceShapeConfigDetails(
                    ocpus=OCPUS, memory_in_gbs=MEMORY_GB
                ) if SHAPE == "VM.Standard.A1.Flex" else None,
                create_vnic_details=oci.core.models.CreateVnicDetails(
                    subnet_id=subnet_id,
                    assign_public_ip=${task.assignPublicIp ? 'True' : 'False'},
                    assign_ipv6_ip=${task.assignIpv6 ? 'True' : 'False'},
                ),
                source_details=oci.core.models.InstanceSourceViaImageDetails(
                    source_type="image",
                    image_id=image_id,
                    boot_volume_size_in_gbs=BOOT_GB,
                ),
                metadata={"ssh_authorized_keys": SSH_PUBLIC_KEY} if SSH_PUBLIC_KEY else {},
            )
            resp = compute.launch_instance(details)
            inst_id = resp.data.id
            print(f"[SUCCESS] Allocated instance: {inst_id}")
            notify("OCI ARM Allocated", f"Instance {DISPLAY_NAME} ({inst_id}) created in {REGION}/{ad}")
            break
        except oci.exceptions.ServiceError as err:
            print(f"[RETRY] HTTP {err.status}: {err.message}")
            if err.status == 429:
                time.sleep(BACKOFF_429)
            else:
                jitter = INTERVAL_SEC * (JITTER_PCT / 100.0)
                time.sleep(max(15, INTERVAL_SEC + random.uniform(-jitter, jitter)))

        if MAX_ATTEMPTS > 0 and attempt >= MAX_ATTEMPTS:
            print(f"[STOP] Reached MAX_ATTEMPTS ({MAX_ATTEMPTS})")
            break

if __name__ == "__main__":
    main()
`;
    return { filename: `oci-arm-sniper-${profile.region}.py`, script };
  }

  const adsJoined = realAds.map((a) => `"${escapeShellVal(a)}"`).join(' ');
  const script = `#!/usr/bin/env bash
# NetPulse Generated OCI ARM Instance Sniper Script (Bash + oci-cli · 免 main.tf 自动拉取参数)
# Profile: ${escapeShellVal(profile.name)} (${escapeShellVal(profile.region)})
# Task: ${escapeShellVal(task.name)}
# Zero main.tf required: if SUBNET_ID, IMAGE_ID, or ADS are empty, this script auto-discovers them via oci-cli!

set -euo pipefail

REGION="${escapeShellVal(profile.region)}"
COMPARTMENT_ID="${escapeShellVal(profile.compartmentOcid || profile.tenancyOcid)}"
SUBNET_ID="${escapeShellVal(profile.subnetOcid || '')}"
IMAGE_ID="${escapeShellVal(task.imageOcid || '')}"
DISPLAY_NAME="${escapeShellVal(task.displayName)}"
SHAPE="${escapeShellVal(task.shape)}"
OCPUS="${task.ocpus}"
MEMORY_GB="${task.memoryInGBs}"
BOOT_GB="${task.bootVolumeSizeInGBs}"
INTERVAL="${task.intervalSeconds}"
BACKOFF_429="${task.backoffOn429Seconds}"
MAX_ATTEMPTS="${task.maxAttempts}"
ADS=(${adsJoined})

# Zero-main.tf Auto-Discovery via oci-cli
if [ \${#ADS[@]} -eq 0 ]; then
  mapfile -t ADS < <(oci iam availability-domain list --region "\${REGION}" --compartment-id "\${COMPARTMENT_ID}" --query 'data[].name' --raw-output | tr -d '[]",' | xargs -n1)
  echo "[Auto-Discover] ADs: \${ADS[*]}"
fi

if [ -z "\${SUBNET_ID}" ]; then
  SUBNET_ID=\$(oci network subnet list --region "\${REGION}" --compartment-id "\${COMPARTMENT_ID}" --query 'data[?"prohibit-public-ip-on-vnic"==\`false\`].id | [0]' --raw-output)
  echo "[Auto-Discover] Public Subnet: \${SUBNET_ID}"
fi

if [ -z "\${IMAGE_ID}" ]; then
  IMAGE_ID=\$(oci compute image list --region "\${REGION}" --compartment-id "\${COMPARTMENT_ID}" --shape "\${SHAPE}" --operating-system "Canonical Ubuntu" --sort-by TIMECREATED --sort-order DESC --limit 1 --query 'data[0].id' --raw-output)
  echo "[Auto-Discover] Latest OS Image: \${IMAGE_ID}"
fi

ATTEMPT=0
echo "[NetPulse] Starting zero-main.tf OCI ARM sniper for \${DISPLAY_NAME} (\${SHAPE} \${OCPUS}C/\${MEMORY_GB}G) in \${REGION}..."

while true; do
  ATTEMPT=$((ATTEMPT + 1))
  AD_INDEX=$(( (ATTEMPT - 1) % \${#ADS[@]} ))
  TARGET_AD="\${ADS[\$AD_INDEX]}"
  echo "[\$(date -u +%FT%TZ)] Attempt #\${ATTEMPT} -> \${TARGET_AD}"

  if OUTPUT=\$(oci compute instance launch \\
    --region "\${REGION}" \\
    --compartment-id "\${COMPARTMENT_ID}" \\
    --availability-domain "\${TARGET_AD}" \\
    --display-name "\${DISPLAY_NAME}" \\
    --shape "\${SHAPE}" \\
    --shape-config "{\\"ocpus\\":\${OCPUS},\\"memoryInGBs\\":\${MEMORY_GB}}" \\
    --subnet-id "\${SUBNET_ID}" \\
    --assign-public-ip ${task.assignPublicIp ? 'true' : 'false'} \\
    --image-id "\${IMAGE_ID}" \\
    --boot-volume-size-in-gbs "\${BOOT_GB}" \\
    --ssh-authorized-keys-file ~/.ssh/id_ed25519.pub 2>&1); then
    echo "[SUCCESS] Instance allocated!"
    echo "\${OUTPUT}"
    exit 0
  else
    echo "[RETRY] \${OUTPUT}" | head -n 3
    if echo "\${OUTPUT}" | grep -qi "TooManyRequests\\|429"; then
      sleep "\${BACKOFF_429}"
    else
      JITTER=$(( RANDOM % (${Math.max(1, Math.round((task.intervalSeconds * task.jitterPercent) / 100))}) ))
      sleep $(( INTERVAL + JITTER ))
    fi
  fi

  if [ "\${MAX_ATTEMPTS}" -gt 0 ] && [ "\${ATTEMPT}" -ge "\${MAX_ATTEMPTS}" ]; then
    echo "[STOP] Reached max attempts (\${MAX_ATTEMPTS})"
    exit 1
  fi
done
`;
  return { filename: `oci-arm-sniper-${profile.region}.sh`, script };
}
