import type { CronIpSyncPolicy, CronJob } from '../../src/types/models.ts';
import { computeNextCronRun, matchesCronDate, parseCronExpression } from '../lib/cron.ts';
import { getHostLinkedRuleIds, store, type StoredCloudHost } from '../lib/store.ts';
import { executeDnsSyncRule } from './dnsSync.ts';
import { runMonitorCheck } from './monitor.ts';
import { dispatchSystemNotification } from './notifier.ts';
import {
  cloudHostAddIpv6,
  cloudHostDeleteIpv6,
  cloudHostSwapIpv4,
  getCloudHostDetail,
  mapCloudStateToHostStatus,
} from './multiCloudClient.ts';
import {
  getOciInstanceDetail,
  isValidOcid,
  mapOciStateToHostStatus,
  ociAddIpv6ToVnic,
  ociDeleteIpv6,
  ociSwapPublicIpv4,
} from './ociClient.ts';
import { runOciSniperAttempt } from './ociSniper.ts';

const MANAGED_CLOUD_PROVIDERS = new Set(['oracle', 'aws', 'aliyun', 'gcp']);

async function syncHostIpsToBoundRuleAndMonitors(
  host: StoredCloudHost,
  syncDnsAfter: boolean,
  actor: string,
  ip: string
): Promise<{ dnsSynced: boolean; dnsError?: string }> {
  const state = store.getState();

  const nextTarget = host.ipv4 || host.ipv6List[0];
  if (nextTarget) {
    for (const mon of state.monitors) {
      if (mon.linkedHostId === host.id && mon.type === 'tcp') {
        mon.target = nextTarget;
        mon.updatedAt = new Date().toISOString();
      }
    }
  }

  const ruleIds = getHostLinkedRuleIds(host);
  if (ruleIds.length === 0) {
    store.save();
    return { dnsSynced: false };
  }

  const matchedRules = ruleIds
    .map((id) => state.dnsRules.find((r) => r.id === id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r));

  if (matchedRules.length === 0) {
    store.save();
    return { dnsSynced: false };
  }

  const nowIso = new Date().toISOString();
  for (const rule of matchedRules) {
    rule.ipv4Address = host.ipv4 || '';
    rule.linkedHostId = host.id;
    rule.ipv6Targets = host.ipv6List.map((addr, idx) => {
      const ociEntry = host.ociIpv6Entries?.find((e) => e.ipAddress.toLowerCase() === addr.toLowerCase());
      return {
        id: `v6-${host.id}-${idx + 1}`,
        recordName: rule.ipv6Mode === 'round_robin' ? rule.recordName : `v6-${idx + 1}.${rule.recordName}`,
        address: addr,
        proxied: rule.proxied,
        enabled: true,
        ociIpv6Id: ociEntry?.id,
        lastStatus: 'pending',
      };
    });
    if (host.provider === 'oracle' && host.ociProfileId) {
      rule.ociProfileId = host.ociProfileId;
      rule.ociInstanceId = host.instanceId;
      rule.ociInstanceName = host.name;
      rule.ociVnicId = host.ociVnicId;
      rule.ociPrimaryPrivateIpId = host.ociPrimaryPrivateIpId;
      rule.ociPublicIpId = host.ociPublicIpId;
      rule.ociPublicIpLifetime = host.ociPublicIpLifetime;
    }
    rule.updatedAt = nowIso;
  }
  store.save();

  if (!syncDnsAfter) {
    return { dnsSynced: false };
  }

  let syncedCount = 0;
  const errors: string[] = [];
  for (const rule of matchedRules) {
    const rep = await executeDnsSyncRule(rule.id, actor, ip);
    if (!rep || rep.status === 'failed') {
      const failedMsg = rep?.results.find((r) => !r.ok)?.message;
      errors.push(`${rule.recordName}.${rule.domain}: ${failedMsg || 'DNS sync failed'}`);
    } else {
      syncedCount += 1;
    }
  }
  if (errors.length > 0) {
    return { dnsSynced: syncedCount > 0, dnsError: errors.join('; ') };
  }
  return { dnsSynced: syncedCount > 0 };
}

async function executeOciIpDnsPolicy(
  job: CronJob,
  actor: string,
  ip: string
): Promise<{ status: 'success' | 'partial' | 'failed'; summary: string }> {
  const state = store.getState();
  const policy: CronIpSyncPolicy = job.ipPolicy ?? {
    scope: 'all',
    targetGroups: [],
    targetHostIds: job.targetIds ?? [],
    action: 'sync_dns_only',
    ipv6Count: 1,
    syncDnsAfter: true,
    notifyOnComplete: false,
  };

  // Resolve target multi-cloud hosts (OCI / AWS / Aliyun / GCP) according to scope
  const matchedHosts = state.cloudHosts.filter((h) => {
    if (!MANAGED_CLOUD_PROVIDERS.has(h.provider)) return false;
    if (policy.scope === 'group') {
      const grp = (h.groupName || '默认分组').trim();
      return policy.targetGroups.includes(grp);
    }
    if (policy.scope === 'hosts') {
      return policy.targetHostIds.includes(h.id);
    }
    return true;
  });

  if (matchedHosts.length === 0) {
    return { status: 'success', summary: '未匹配到符合策略范围的云主机实例' };
  }

  let okCount = 0;
  let failCount = 0;
  let dnsSyncedCount = 0;
  const detailsLog: string[] = [];
  const countParam = Math.min(8, Math.max(1, Number(policy.ipv6Count) || 1));

  for (const host of matchedHosts) {
    let hostFailed = false;
    const ops: string[] = [];

    if (host.provider === 'oracle') {
      const profile = host.ociProfileId
        ? state.ociProfiles.find((p) => p.id === host.ociProfileId)
        : undefined;
      const pem = profile ? store.getOciPrivateKey(profile.id) : '';

      if (!profile || !pem || !host.instanceId || !isValidOcid(host.instanceId)) {
        failCount += 1;
        detailsLog.push(`${host.name}: 跳过（未关联有效 OCI 私钥/实例 OCID）`);
        continue;
      }

      const detail = await getOciInstanceDetail(profile, pem, host.instanceId, host.ociVnicId);
      if (!detail.ok) {
        failCount += 1;
        detailsLog.push(`${host.name}: 拉取 OCI 实例失败 (${detail.error})`);
        continue;
      }

      if (detail.lifecycleState) {
        host.ociLifecycleState = detail.lifecycleState;
        host.status = mapOciStateToHostStatus(detail.lifecycleState);
      }
      if (detail.specs) host.specs = detail.specs;
      if (detail.vnicId) host.ociVnicId = detail.vnicId;
      if (detail.primaryPrivateIpId) host.ociPrimaryPrivateIpId = detail.primaryPrivateIpId;
      if (detail.publicIp !== undefined) host.ipv4 = detail.publicIp || '';
      host.ociPublicIpId = detail.publicIpId;
      host.ociPublicIpLifetime = detail.publicIpLifetime;
      if (detail.ipv6List) host.ipv6List = detail.ipv6List;
      if (detail.ipv6Entries) host.ociIpv6Entries = detail.ipv6Entries;
      host.lastCheckedAt = new Date().toISOString();

      if (policy.action === 'swap_ipv4' || policy.action === 'rotate_dual_stack') {
        if (!host.ociPrimaryPrivateIpId) {
          hostFailed = true;
          ops.push('缺少主私有 IP OCID');
        } else {
          const swapped = await ociSwapPublicIpv4(profile, pem, host.ociPrimaryPrivateIpId);
          if (swapped.ok && swapped.newAddress) {
            host.ipv4 = swapped.newAddress;
            host.ociPublicIpId = swapped.publicIpId;
            host.ociPublicIpLifetime = swapped.lifetime;
            ops.push(`IPv4→${swapped.newAddress}`);
          } else {
            hostFailed = true;
            ops.push(`IPv4更换失败:${swapped.error}`);
          }
        }
      }

      if (policy.action === 'add_ipv6') {
        if (!host.ociVnicId) {
          hostFailed = true;
          ops.push('缺少 VNIC OCID');
        } else {
          let addedNum = 0;
          for (let i = 0; i < countParam; i++) {
            const added = await ociAddIpv6ToVnic(profile, pem, host.ociVnicId);
            if (added.ok && added.ipAddress) {
              addedNum += 1;
              if (!host.ipv6List.includes(added.ipAddress)) host.ipv6List.push(added.ipAddress);
              host.ociIpv6Entries = [
                ...(host.ociIpv6Entries ?? []).filter((e) => e.ipAddress !== added.ipAddress),
                { id: added.ipv6Id || '', ipAddress: added.ipAddress },
              ];
            } else {
              hostFailed = true;
              ops.push(`新增IPv6失败:${added.error}`);
              break;
            }
          }
          if (addedNum > 0) ops.push(`+${addedNum} IPv6`);
        }
      }

      if (policy.action === 'swap_all_ipv6' || policy.action === 'rotate_dual_stack') {
        if (!host.ociVnicId) {
          hostFailed = true;
          ops.push('缺少 VNIC OCID');
        } else {
          const currentEntries = [...(host.ociIpv6Entries ?? [])];
          if (currentEntries.length === 0) {
            const added = await ociAddIpv6ToVnic(profile, pem, host.ociVnicId);
            if (added.ok && added.ipAddress) {
              host.ipv6List = [added.ipAddress];
              host.ociIpv6Entries = [{ id: added.ipv6Id || '', ipAddress: added.ipAddress }];
              ops.push('新分配1个IPv6');
            } else {
              hostFailed = true;
              ops.push(`IPv6分配失败:${added.error}`);
            }
          } else {
            let swappedV6 = 0;
            for (const oldEntry of currentEntries) {
              const added = await ociAddIpv6ToVnic(profile, pem, host.ociVnicId);
              if (!added.ok || !added.ipAddress) {
                hostFailed = true;
                ops.push(`IPv6分配失败:${added.error}`);
                break;
              }
              const del = await ociDeleteIpv6(profile, pem, oldEntry.id);
              if (!del.ok) {
                hostFailed = true;
                ops.push(`旧IPv6删除失败:${del.error}`);
                break;
              }
              host.ipv6List = host.ipv6List
                .filter((a) => a.toLowerCase() !== oldEntry.ipAddress.toLowerCase())
                .concat(added.ipAddress);
              host.ociIpv6Entries = (host.ociIpv6Entries ?? [])
                .filter((e) => e.id !== oldEntry.id)
                .concat({ id: added.ipv6Id || '', ipAddress: added.ipAddress });
              swappedV6 += 1;
            }
            if (swappedV6 > 0) ops.push(`更换${swappedV6}个IPv6`);
          }
        }
      }

      if (policy.action === 'delete_excess_ipv6') {
        const currentEntries = [...(host.ociIpv6Entries ?? [])];
        if (currentEntries.length > countParam) {
          const toDelete = currentEntries.slice(0, currentEntries.length - countParam);
          let deletedNum = 0;
          for (const entry of toDelete) {
            const del = await ociDeleteIpv6(profile, pem, entry.id);
            if (del.ok) {
              deletedNum += 1;
              host.ipv6List = host.ipv6List.filter((a) => a.toLowerCase() !== entry.ipAddress.toLowerCase());
              host.ociIpv6Entries = (host.ociIpv6Entries ?? []).filter((e) => e.id !== entry.id);
            } else {
              hostFailed = true;
              ops.push(`删除IPv6失败:${del.error}`);
              break;
            }
          }
          if (deletedNum > 0) ops.push(`清理${deletedNum}个多余IPv6(保留${countParam})`);
        } else {
          ops.push(`当前${currentEntries.length}个IPv6无需清理`);
        }
      }
    } else {
      // AWS EC2 / Aliyun ECS / GCP Compute Engine
      const account = host.cloudAccountId
        ? state.cloudAccounts.find((a) => a.id === host.cloudAccountId)
        : undefined;
      const secrets = account ? store.getCloudAccountSecrets(account.id) : { accessKeyId: '', secretKey: '', serviceAccountJson: '' };
      const hasCreds = account
        ? account.provider === 'gcp'
          ? Boolean(secrets.serviceAccountJson)
          : Boolean(secrets.accessKeyId && secrets.secretKey)
        : false;

      if (!account || !hasCreds) {
        failCount += 1;
        detailsLog.push(`${host.name}: 跳过（未关联有效 ${host.provider.toUpperCase()} 云账号凭据）`);
        continue;
      }

      const detail = await getCloudHostDetail(account, secrets, host);
      if (!detail.ok) {
        failCount += 1;
        detailsLog.push(`${host.name}: 拉取 ${account.provider.toUpperCase()} 实例失败 (${detail.error})`);
        continue;
      }

      if (detail.lifecycleState) {
        host.ociLifecycleState = detail.lifecycleState;
        host.status = mapCloudStateToHostStatus(detail.lifecycleState);
      }
      if (detail.specs) host.specs = detail.specs;
      if (detail.zone) host.cloudZone = detail.zone;
      if (detail.networkInterfaceId) host.cloudNetworkInterfaceId = detail.networkInterfaceId;
      if (detail.publicIp !== undefined) host.ipv4 = detail.publicIp || '';
      host.cloudEipAllocationId = detail.eipAllocationId;
      host.cloudAllocationAssociationId = detail.eipAssociationId;
      if (detail.ipv6List) host.ipv6List = detail.ipv6List;
      host.lastCheckedAt = new Date().toISOString();

      if (policy.action === 'swap_ipv4' || policy.action === 'rotate_dual_stack') {
        const swapped = await cloudHostSwapIpv4(account, secrets, host);
        if (swapped.ok && swapped.newAddress) {
          host.ipv4 = swapped.newAddress;
          host.cloudEipAllocationId = swapped.allocationId;
          host.cloudAllocationAssociationId = swapped.associationId;
          ops.push(`IPv4→${swapped.newAddress}`);
        } else {
          hostFailed = true;
          ops.push(`IPv4更换失败:${swapped.error}`);
        }
      }

      if (policy.action === 'add_ipv6') {
        let addedNum = 0;
        const loops = account.provider === 'gcp' ? 1 : countParam;
        for (let i = 0; i < loops; i++) {
          const added = await cloudHostAddIpv6(account, secrets, host);
          if (added.ok && added.ipAddress) {
            addedNum += 1;
            if (!host.ipv6List.includes(added.ipAddress)) host.ipv6List.push(added.ipAddress);
          } else {
            hostFailed = true;
            ops.push(`新增IPv6失败:${added.error}`);
            break;
          }
        }
        if (addedNum > 0) ops.push(`+${addedNum} IPv6`);
      }

      if (policy.action === 'swap_all_ipv6' || policy.action === 'rotate_dual_stack') {
        const currentV6 = [...host.ipv6List];
        if (currentV6.length === 0) {
          const added = await cloudHostAddIpv6(account, secrets, host);
          if (added.ok && added.ipAddress) {
            host.ipv6List = [added.ipAddress];
            ops.push('新分配1个IPv6');
          } else {
            hostFailed = true;
            ops.push(`IPv6分配失败:${added.error}`);
          }
        } else if (account.provider === 'gcp') {
          const del = await cloudHostDeleteIpv6(account, secrets, host, currentV6[0]);
          const added = del.ok ? await cloudHostAddIpv6(account, secrets, host) : { ok: false, error: del.error };
          if (added.ok && added.ipAddress) {
            host.ipv6List = [added.ipAddress];
            ops.push(`更换IPv6→${added.ipAddress}`);
          } else {
            hostFailed = true;
            ops.push(`GCP IPv6更换失败:${added.error}`);
          }
        } else {
          let swappedV6 = 0;
          for (const oldAddr of currentV6) {
            const added = await cloudHostAddIpv6(account, secrets, host);
            if (!added.ok || !added.ipAddress) {
              hostFailed = true;
              ops.push(`IPv6分配失败:${added.error}`);
              break;
            }
            const del = await cloudHostDeleteIpv6(account, secrets, host, oldAddr);
            if (!del.ok) {
              hostFailed = true;
              ops.push(`旧IPv6删除失败:${del.error}`);
              break;
            }
            host.ipv6List = host.ipv6List
              .filter((a) => a.toLowerCase() !== oldAddr.toLowerCase())
              .concat(added.ipAddress);
            swappedV6 += 1;
          }
          if (swappedV6 > 0) ops.push(`更换${swappedV6}个IPv6`);
        }
      }

      if (policy.action === 'delete_excess_ipv6') {
        const currentV6 = [...host.ipv6List];
        if (currentV6.length > countParam) {
          const toDelete = currentV6.slice(0, currentV6.length - countParam);
          let deletedNum = 0;
          for (const addr of toDelete) {
            const del = await cloudHostDeleteIpv6(account, secrets, host, addr);
            if (del.ok) {
              deletedNum += 1;
              host.ipv6List = host.ipv6List.filter((a) => a.toLowerCase() !== addr.toLowerCase());
            } else {
              hostFailed = true;
              ops.push(`删除IPv6失败:${del.error}`);
              break;
            }
          }
          if (deletedNum > 0) ops.push(`清理${deletedNum}个多余IPv6(保留${countParam})`);
        } else {
          ops.push(`当前${currentV6.length}个IPv6无需清理`);
        }
      }
    }

    host.updatedAt = new Date().toISOString();
    store.save();

    // Cascade updated IPs to bound domain DNS & monitors
    const syncRes = await syncHostIpsToBoundRuleAndMonitors(host, policy.syncDnsAfter !== false, actor, ip);
    if (syncRes.dnsSynced) {
      dnsSyncedCount += 1;
      ops.push('DNS已同步');
    } else if (syncRes.dnsError) {
      hostFailed = true;
      ops.push(`DNS同步失败:${syncRes.dnsError}`);
    }

    if (hostFailed) {
      failCount += 1;
    } else {
      okCount += 1;
    }
    detailsLog.push(`${host.name}(${ops.join(', ') || '已刷新'})`);
  }

  const status: 'success' | 'partial' | 'failed' =
    failCount === 0 ? 'success' : okCount > 0 ? 'partial' : 'failed';
  const summary = `策略[${policy.action}] 处理 ${matchedHosts.length} 台云主机：成功 ${okCount}，失败 ${failCount}，同步 DNS ${dnsSyncedCount} 台 · ${detailsLog.slice(0, 3).join('；')}`;

  if (policy.notifyOnComplete || failCount > 0) {
    await dispatchSystemNotification({
      event: failCount > 0 ? 'dns_sync_fail' : 'ip_changed',
      title: `定时策略完成: ${job.name}`,
      message: summary,
      actor,
      ip,
    });
  }

  return { status, summary };
}

export async function runCronJobNow(jobId: string, actor = 'scheduler', ip = '127.0.0.1'): Promise<CronJob | null> {
  const state = store.getState();
  const job = state.cronJobs.find((j) => j.id === jobId);
  if (!job) return null;

  const now = new Date();
  job.lastRunAt = now.toISOString();
  job.lastStatus = 'running';
  job.runCount += 1;
  store.save();

  try {
    if (job.type === 'oci_ip_dns_policy') {
      const result = await executeOciIpDnsPolicy(job, actor, ip);
      job.lastStatus = result.status;
      job.lastSummary = result.summary;
    } else if (job.type === 'dns_batch_sync') {
      const targetRules = state.dnsRules.filter(
        (r) => r.enabled && (job.targetIds.length === 0 || job.targetIds.includes(r.id))
      );
      let okCount = 0;
      for (const rule of targetRules) {
        const rep = await executeDnsSyncRule(rule.id, actor, ip);
        if (rep && rep.status !== 'failed') okCount += 1;
      }
      job.lastStatus = okCount === targetRules.length ? 'success' : okCount > 0 ? 'partial' : 'failed';
      job.lastSummary = `Synced ${okCount}/${targetRules.length} bound DNS domain(s)`;
      if (okCount < targetRules.length) {
        await dispatchSystemNotification({
          event: 'dns_sync_fail',
          title: 'DNS Sync Warning',
          message: `Scheduled job "${job.name}" completed with ${okCount}/${targetRules.length} successful rules.`,
          actor,
          ip,
        });
      }
    } else if (job.type === 'oci_sniper_sweep') {
      const runningTasks = state.ociSniperTasks.filter(
        (t) =>
          t.status === 'running' &&
          (job.targetIds.length === 0 || job.targetIds.includes(t.id)) &&
          (!t.nextAttemptAt || new Date(t.nextAttemptAt).getTime() <= Date.now())
      );
      for (const task of runningTasks) {
        await runOciSniperAttempt(task.id, actor, ip);
      }
      job.lastStatus = 'success';
      job.lastSummary =
        runningTasks.length > 0
          ? `Executed ${runningTasks.length} due OCI ARM sniper attempt(s)`
          : 'No OCI ARM sniper tasks currently running/due';
    } else if (job.type === 'monitor_sweep') {
      const targetMonitors = state.monitors.filter(
        (m) => m.enabled && (job.targetIds.length === 0 || job.targetIds.includes(m.id))
      );
      let upCount = 0;
      for (const mon of targetMonitors) {
        const updated = await runMonitorCheck(mon.id, actor, ip);
        if (updated && updated.status !== 'down') upCount += 1;
      }
      job.lastStatus = upCount === targetMonitors.length ? 'success' : upCount > 0 ? 'partial' : 'failed';
      job.lastSummary = `Checked ${targetMonitors.length} monitor(s): ${upCount} healthy, ${targetMonitors.length - upCount} down`;
    } else if (job.type === 'cloud_ip_refresh') {
      const result = await executeOciIpDnsPolicy(
        {
          ...job,
          ipPolicy: {
            scope: job.targetIds.length > 0 ? 'hosts' : 'all',
            targetGroups: [],
            targetHostIds: job.targetIds,
            action: 'sync_dns_only',
            syncDnsAfter: true,
            notifyOnComplete: false,
          },
        },
        actor,
        ip
      );
      job.lastStatus = result.status;
      job.lastSummary = result.summary;
    } else if (job.type === 'audit_cleanup') {
      const res = store.enforceAuditSizeLimit();
      job.lastStatus = 'success';
      job.lastSummary = res.pruned
        ? `Pruned ${res.removedBytes} B; current audit file ${res.currentBytes} B`
        : `Audit log within cap (${res.currentBytes} B / ${state.security.maxAuditSizeBytes} B)`;
      if (res.pruned) {
        await dispatchSystemNotification({
          event: 'audit_prune',
          title: 'Audit Log Auto-Pruned',
          message: job.lastSummary,
          actor,
          ip,
        });
      }
    }

    job.nextRunAt = computeNextCronRun(job.expression, now);
    job.updatedAt = new Date().toISOString();
    store.save();

    store.appendAudit({
      category: 'cron',
      severity: job.lastStatus === 'failed' ? 'error' : 'info',
      action: 'CRON_EXECUTION',
      actor,
      ip,
      target: job.name,
      details: `${job.lastSummary ?? 'Completed'} (expr: ${job.expression})`,
    });
  } catch (err) {
    job.lastStatus = 'failed';
    job.lastSummary = err instanceof Error ? err.message : 'Cron execution failed';
    job.nextRunAt = computeNextCronRun(job.expression, now);
    job.updatedAt = new Date().toISOString();
    store.save();
  }

  return job;
}

class SchedulerEngine {
  private lastTickMinute = '';
  private timer: NodeJS.Timeout | null = null;
  private sniperTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private runningSnipers = new Set<string>();
  private runningMonitors = new Set<string>();

  start() {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.tick();
      }, 15_000);
      this.timer.unref();
    }
    if (!this.sniperTimer) {
      this.sniperTimer = setInterval(() => {
        void this.tickSnipers();
      }, 3_000);
      this.sniperTimer.unref();
    }
    if (!this.monitorTimer) {
      this.monitorTimer = setInterval(() => {
        void this.tickMonitors();
      }, 5_000);
      this.monitorTimer.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.sniperTimer) {
      clearInterval(this.sniperTimer);
      this.sniperTimer = null;
    }
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  private async tickSnipers() {
    const nowMs = Date.now();
    const state = store.getState();
    const dueTasks = state.ociSniperTasks.filter((t) => {
      if (t.status !== 'running') return false;
      if (this.runningSnipers.has(t.id)) return false;
      if (!t.nextAttemptAt) return true;
      const nextMs = new Date(t.nextAttemptAt).getTime();
      return !Number.isFinite(nextMs) || nextMs <= nowMs;
    });

    for (const task of dueTasks) {
      this.runningSnipers.add(task.id);
      void runOciSniperAttempt(task.id, 'sniper-daemon', '127.0.0.1')
        .catch(() => {})
        .finally(() => {
          this.runningSnipers.delete(task.id);
        });
    }
  }

  private async tickMonitors() {
    const nowMs = Date.now();
    const state = store.getState();
    const dueMonitors = state.monitors.filter((m) => {
      if (!m.enabled) return false;
      if (this.runningMonitors.has(m.id)) return false;
      const intervalMs = Math.max(15, Number(m.intervalSeconds) || 60) * 1000;
      if (!m.lastCheckedAt) return true;
      const lastMs = new Date(m.lastCheckedAt).getTime();
      return !Number.isFinite(lastMs) || nowMs - lastMs >= intervalMs;
    });

    for (const mon of dueMonitors) {
      this.runningMonitors.add(mon.id);
      void runMonitorCheck(mon.id, 'monitor-daemon', '127.0.0.1')
        .catch(() => {})
        .finally(() => {
          this.runningMonitors.delete(mon.id);
        });
    }
  }

  private async tick() {
    const now = new Date();
    const minuteKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;
    if (minuteKey === this.lastTickMinute) return;
    this.lastTickMinute = minuteKey;

    const state = store.getState();
    for (const job of state.cronJobs) {
      if (!job.enabled) continue;
      const parsed = parseCronExpression(job.expression);
      if (parsed && matchesCronDate(parsed, now)) {
        await runCronJobNow(job.id, 'scheduler', '127.0.0.1');
      }
    }
  }
}

export const schedulerEngine = new SchedulerEngine();
