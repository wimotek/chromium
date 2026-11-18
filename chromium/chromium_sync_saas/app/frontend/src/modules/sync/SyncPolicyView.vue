<template>
  <div>
    <div class="banner banner-info">
      <strong>多租户与共享节点隔离保障（自有 vs 租用节点规则）：</strong>
      在共享市场租用的他人节点禁止读写卖家整机 Cookie 库（避免双方账号互泄），因此您的自动化 Cookie 同步仅在【自有且空闲】节点池内生效；当业务使用租用节点遇到登录或防机器人校验时，请在 Playwright 中通过 <span class="mono">browser.new_context()</span> 内存隔离上下文携带自身 Cookie 并利用真实节点指纹完成验证（详见「我的节点 → 接入指南 第 5 项」）。
    </div>

    <!-- 同步调度中枢 -->
    <div class="card">
      <div class="card-title">
        <span>多策略 Cookie 自动同步调度中枢（组对组 / 节点对组 / 一对多 / 全网双向合并）</span>
        <div class="row">
          <button class="btn btn-sm" @click="loadAll">刷新状态</button>
          <button class="btn btn-sm" style="border-color: var(--primary); color: var(--primary)" @click="openCookiePolicyModal">
            全局过滤与清理策略
          </button>
          <button class="btn btn-sm btn-primary" @click="openCreatePolicy">+ 新增调度策略</button>
        </div>
      </div>

      <div v-if="policies.length === 0" class="subcard muted" style="text-align: center; padding: 32px">
        暂无调度策略，点击右上角「+ 新增调度策略」配置 Cookie 同步策略。
      </div>

      <div v-else class="grid-3">
        <div v-for="p in policies" :key="p.id" class="subcard" style="display: flex; flex-direction: column; justify-content: space-between; gap: 12px">
          <div class="row" style="justify-content: space-between; align-items: flex-start">
            <div style="min-width: 0; flex: 1">
              <div style="font-weight: 600; color: var(--text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap" :title="p.name">
                {{ p.name }}
              </div>
              <div class="muted mono" style="font-size: 11px; margin-top: 2px">每 {{ p.interval_minutes }} 分钟自动调度</div>
            </div>
            <span class="tag" :class="p.enabled ? 'tag-ok' : ''">{{ p.enabled ? '运行中' : '已停用' }}</span>
          </div>

          <div style="border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); padding: 10px 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px">
            <div class="row" style="justify-content: space-between">
              <span class="muted">拓扑模式</span>
              <span class="tag tag-info" :title="formatRouteText(p)">{{ formatRouteText(p) }}</span>
            </div>
            <div class="row" style="justify-content: space-between">
              <span class="muted">上次执行</span>
              <span class="mono muted">{{ p.last_run || '尚未执行' }}</span>
            </div>
          </div>

          <div class="row" style="justify-content: space-between">
            <button
              class="btn btn-sm btn-danger"
              :disabled="runningPolicyId === p.id"
              @click="confirmDeletePolicyTarget = p"
            >
              删除
            </button>
            <div class="row" style="gap: 6px">
              <button
                class="btn btn-sm"
                :class="p.enabled ? '' : 'btn-emerald'"
                :disabled="runningPolicyId === p.id"
                @click="togglePolicy(p)"
              >
                {{ p.enabled ? '停用' : '启用' }}
              </button>
              <button class="btn btn-sm" :disabled="runningPolicyId === p.id" @click="openEditPolicy(p)">编辑</button>
              <button class="btn btn-sm btn-primary" :disabled="runningPolicyId !== null" @click="runPolicy(p.id)">
                {{ runningPolicyId === p.id ? '执行中...' : '立即执行' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 同步任务审计追踪流水 -->
    <div class="card">
      <div class="card-title">
        <span>同步任务执行流水（仅本租户自有空闲节点）</span>
        <div class="row">
          <select v-model="logStatusFilter" class="select mono" style="width: auto; padding: 6px 10px; font-size: 12px">
            <option value="">全部状态</option>
            <option value="SUCCESS">SUCCESS 成功</option>
            <option value="NO_CHANGE">NO_CHANGE 一致跳过</option>
            <option value="SKIPPED">SKIPPED 已跳过</option>
            <option value="FAILED">FAILED 失败</option>
          </select>
          <input
            v-model="logSearchText"
            class="input mono"
            placeholder="搜索源节点 / 目标范围 / 详情..."
            style="width: 220px; padding: 6px 10px; font-size: 12px"
          />
          <button v-if="logs.length > 0" class="btn btn-sm btn-danger" @click="confirmClearLogs = true">清空流水</button>
        </div>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>源端发起</th>
              <th>分发目标范围</th>
              <th>Cookie 数</th>
              <th>执行耗时</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in filteredLogs" :key="l.id">
              <td class="mono muted">{{ l.timestamp }}</td>
              <td><span class="tag tag-info">{{ l.source_node || '---' }}</span></td>
              <td style="max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" :title="l.target_nodes">
                {{ l.target_nodes || '---' }}
              </td>
              <td class="mono">{{ l.cookie_count || 0 }} 条</td>
              <td class="mono muted">{{ l.duration || '0.00s' }}</td>
              <td>
                <span class="tag" :class="l.status === 'SUCCESS' ? 'tag-ok' : l.status === 'FAILED' ? 'tag-danger' : 'tag-warn'">
                  {{ l.status }}
                </span>
              </td>
              <td>
                <button class="btn btn-sm" @click="selectedLogDetail = l.details || '无详细信息'">查看详情</button>
              </td>
            </tr>
            <tr v-if="filteredLogs.length === 0">
              <td colspan="7" class="muted" style="text-align: center; padding: 24px">暂无匹配的同步执行流水记录</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 弹窗 1：全局 Cookie 过滤、清理与差量同步策略 -->
    <div v-if="showCookiePolicyModal" class="modal-backdrop" @click.self="showCookiePolicyModal = false">
      <div class="modal-box modal-box-lg">
        <div class="card-title">
          <span>全局 Cookie 过滤、删除清理与差量同步策略（本租户生效）</span>
          <button class="btn btn-sm" @click="showCookiePolicyModal = false">关闭</button>
        </div>

        <form @submit.prevent="saveCookiePolicy">
          <div class="subcard" style="margin-bottom: 14px">
            <label class="row" style="cursor: pointer; font-weight: 600; color: var(--primary)">
              <input type="checkbox" v-model="cookiePolicy.sync_diff_enabled" />
              <span>启用 Cookie 指纹变更差量检测 (Diff / Delta Sync)</span>
            </label>
            <div class="muted" style="font-size: 12px; margin-top: 6px">
              仅对值或有效期发生实质变更的凭证执行下发，跳过完全一致项，减少全量读写与流量消耗。
            </div>
          </div>

          <div class="field">
            <div class="row" style="justify-content: space-between; margin-bottom: 4px">
              <label style="margin: 0">域名白名单 (Include Domains，黑名单有内容时自动禁用)</label>
              <span v-if="isBlacklistActive" class="tag tag-warn">黑名单生效中 · 白名单已锁定</span>
            </div>
            <input
              v-model="cookiePolicy.sync_include_domains"
              :disabled="isBlacklistActive"
              class="input mono"
              placeholder="例如: google.com, x.com（需先清空下方黑名单才生效）"
            />
          </div>

          <div class="field">
            <label>域名黑名单 (Exclude Domains，填有内容时自动禁用上方白名单)</label>
            <input
              v-model="cookiePolicy.sync_exclude_domains"
              class="input mono"
              placeholder="例如: doubleclick.net, google-analytics.com（留空即可改用白名单）"
            />
          </div>

          <div class="subcard" style="margin-bottom: 14px; border-color: rgba(192, 132, 252, 0.35)">
            <div class="row" style="justify-content: space-between; margin-bottom: 10px">
              <label class="row" style="cursor: pointer; font-weight: 600; color: #e879f9">
                <input type="checkbox" v-model="cookiePolicy.sync_cleanup_enabled" />
                <span>启用同步时全局 Cookie 删除清理策略（按域名 / 日期 / 关键词）</span>
              </label>
              <span class="muted" style="font-size: 11px">同步前先剔除再向自有空闲节点清理</span>
            </div>

            <div class="row" style="margin-bottom: 10px; gap: 18px">
              <label class="row" style="cursor: pointer; font-size: 13px">
                <input type="checkbox" v-model="cookiePolicy.sync_cleanup_expired" />
                <span>清理已过期 Cookie</span>
              </label>
              <label class="row" style="cursor: pointer; font-size: 13px">
                <input type="checkbox" v-model="cookiePolicy.sync_cleanup_session_only" />
                <span>清理会话级 Cookie（无有效期）</span>
              </label>
            </div>

            <div class="field">
              <label>按域名删除 (Cleanup Domains，逗号或换行分隔，支持 *.domain.com / *ads*)</label>
              <input v-model="cookiePolicy.sync_cleanup_domains" class="input mono" placeholder="例如: doubleclick.net, *.tracking.com" />
            </div>

            <div class="grid-2">
              <div class="field">
                <label>按关键词删除 (Keywords，逗号分隔，支持 *utm*)</label>
                <input v-model="cookiePolicy.sync_cleanup_keywords" class="input mono" placeholder="例如: _ga, _gid, utm_, track" />
              </div>
              <div class="field">
                <label>关键词匹配范围</label>
                <select v-model="cookiePolicy.sync_cleanup_keyword_scope" class="select">
                  <option value="name">仅 Cookie 名称</option>
                  <option value="name_domain">Cookie 名称 + 域名</option>
                  <option value="all">名称 + 域名 + 值</option>
                </select>
              </div>
              <div class="field">
                <label>按日期删除（到期时间早于此日期）</label>
                <input type="date" v-model="cookiePolicy.sync_cleanup_expires_before" class="input mono" />
              </div>
              <div class="field">
                <label>清理 N 天内即将过期 (0=关闭)</label>
                <input type="number" min="0" v-model.number="cookiePolicy.sync_cleanup_expiring_within_days" class="input mono" />
              </div>
            </div>

            <div class="row" style="justify-content: space-between; margin-top: 6px">
              <div class="row">
                <button type="button" class="btn btn-sm" :disabled="cleanupBusy" @click="runGlobalCleanup(true)">
                  {{ cleanupBusy ? '计算中...' : '试算待清理数' }}
                </button>
                <button
                  v-if="!confirmPurge"
                  type="button"
                  class="btn btn-sm btn-danger"
                  :disabled="cleanupBusy"
                  @click="confirmPurge = true"
                >
                  立即全网清理
                </button>
                <template v-else>
                  <button type="button" class="btn btn-sm btn-danger" :disabled="cleanupBusy" @click="confirmPurge = false; runGlobalCleanup(false)">
                    确认实删清理
                  </button>
                  <button type="button" class="btn btn-sm" @click="confirmPurge = false">取消</button>
                </template>
              </div>
              <span v-if="cleanupSummary" class="mono" style="font-size: 12px; color: #f0abfc">
                {{ cleanupSummary.dry_run ? '试算' : '实删' }}：在线 {{ cleanupSummary.node_count }} 节点 · 命中 {{ cleanupSummary.matched_total }} 条
                <template v-if="!cleanupSummary.dry_run"> · 已删 {{ cleanupSummary.purged_total }} 条</template>
              </span>
            </div>

            <div v-if="cleanupSummary && Object.keys(cleanupSummary.reasons || {}).length > 0" class="banner banner-info mono" style="margin-top: 10px; margin-bottom: 0">
              命中明细：
              <span v-for="(cnt, key) in cleanupSummary.reasons" :key="key" style="margin-right: 12px">
                {{ reasonLabelMap[key] || key }}: <strong>{{ cnt }}</strong>
              </span>
            </div>
          </div>

          <div class="row" style="justify-content: flex-end">
            <button type="button" class="btn" @click="showCookiePolicyModal = false">取消</button>
            <button type="submit" class="btn btn-primary">保存全局策略</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 弹窗 2：新建 / 编辑调度策略 -->
    <div v-if="showPolicyModal" class="modal-backdrop" @click.self="showPolicyModal = false">
      <div class="modal-box modal-box-lg">
        <div class="card-title">
          <span>{{ isEditPolicy ? '编辑同步调度策略' : '新增 Cookie 同步调度策略' }}</span>
          <button class="btn btn-sm" @click="showPolicyModal = false">关闭</button>
        </div>

        <form @submit.prevent="submitPolicy">
          <div class="grid-2">
            <div class="field">
              <label>策略名称</label>
              <input v-model="policyForm.name" required class="input" placeholder="如：采集组同步至北美备份" />
            </div>
            <div class="field">
              <label>调度周期（分钟）</label>
              <input v-model.number="policyForm.interval_minutes" type="number" min="1" required class="input mono" />
            </div>
          </div>

          <div class="field">
            <label class="row" style="cursor: pointer">
              <input type="checkbox" v-model="policyForm.enabled" />
              <span>保存后立即启用该定时调度策略</span>
            </label>
          </div>

          <div class="field">
            <label>同步传输拓扑模式</label>
            <div class="grid-2" style="gap: 10px">
              <label
                v-for="m in topologyModes"
                :key="m.value"
                class="subcard"
                :style="{
                  cursor: 'pointer',
                  borderColor: policyForm.sync_type === m.value ? 'var(--primary)' : 'var(--border)',
                  background: policyForm.sync_type === m.value ? 'rgba(56, 189, 248, 0.08)' : 'var(--surface-subtle)',
                }"
              >
                <input type="radio" v-model="policyForm.sync_type" :value="m.value" @change="onSyncTypeChange" style="display: none" />
                <div style="font-weight: 600; color: var(--primary); margin-bottom: 4px">{{ m.title }}</div>
                <div class="muted" style="font-size: 12px">{{ m.desc }}</div>
              </label>
            </div>
          </div>

          <div class="subcard" style="margin-bottom: 16px">
            <div v-if="policyForm.sync_type === 'smart_merge'" class="muted" style="font-size: 13px; color: var(--primary)">
              将自动遍历您名下所有分组内的自有在线空闲节点，对同名凭证比对有效期并双向对齐同步（出租中节点自动跳过）。
            </div>

            <div v-else-if="policyForm.sync_type === 'group_to_group'" class="grid-2">
              <div class="field" style="margin-bottom: 0">
                <label>源分组 (Source Group)</label>
                <select v-model="policyForm.source_group" class="select mono">
                  <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
                </select>
              </div>
              <div class="field" style="margin-bottom: 0">
                <label>目标分组 (Target Group)</label>
                <select v-model="policyForm.target_group" class="select mono">
                  <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
                </select>
              </div>
            </div>

            <div v-else-if="policyForm.sync_type === 'node_to_group'" class="grid-2">
              <div class="field" style="margin-bottom: 0">
                <label>源节点 (Source Node)</label>
                <select v-model.number="policyForm.source_id" class="select mono">
                  <option v-for="n in ownedNodes" :key="n.id" :value="n.id">
                    #{{ n.id }} {{ n.name }} ({{ n.group_name }}){{ n.active_lease_count > 0 ? ' [出租中豁免]' : '' }}
                  </option>
                </select>
              </div>
              <div class="field" style="margin-bottom: 0">
                <label>目标分组 (Target Group)</label>
                <select v-model="policyForm.target_group" class="select mono">
                  <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
                </select>
              </div>
            </div>

            <div v-else-if="policyForm.sync_type === 'node_to_nodes'">
              <div class="field">
                <label>源节点 (Source Node)</label>
                <select v-model.number="policyForm.source_id" class="select mono">
                  <option v-for="n in ownedNodes" :key="n.id" :value="n.id">
                    #{{ n.id }} {{ n.name }} ({{ n.group_name }}){{ n.active_lease_count > 0 ? ' [出租中豁免]' : '' }}
                  </option>
                </select>
              </div>
              <div class="field" style="margin-bottom: 0">
                <label>目标节点队列</label>
                <div class="row">
                  <select v-model="selectedTargetToAdd" class="select mono" style="flex: 1">
                    <option value="">-- 选择自有目标节点加入队列 --</option>
                    <option
                      v-for="n in ownedNodes.filter((x) => x.id !== policyForm.source_id && !policyForm.target_ids.includes(x.id))"
                      :key="n.id"
                      :value="n.id"
                    >
                      + #{{ n.id }} {{ n.name }} ({{ n.group_name }})
                    </option>
                  </select>
                  <button type="button" class="btn btn-sm btn-primary" @click="addTargetNode">添加节点</button>
                </div>
                <div class="row" style="margin-top: 10px; gap: 8px">
                  <span v-for="tid in policyForm.target_ids" :key="tid" class="tag tag-info" style="gap: 6px; padding: 4px 10px">
                    #{{ tid }} {{ ownedNodes.find((n) => n.id === tid)?.name || tid }}
                    <button
                      type="button"
                      style="background: none; border: none; color: #f87171; cursor: pointer; padding: 0; font-weight: 700"
                      @click="removeTargetNode(tid)"
                    >
                      ✕
                    </button>
                  </span>
                  <span v-if="policyForm.target_ids.length === 0" class="muted" style="font-size: 12px">尚未添加任何目标节点</span>
                </div>
              </div>
            </div>
          </div>

          <div class="row" style="justify-content: flex-end">
            <button type="button" class="btn" @click="showPolicyModal = false">取消</button>
            <button type="submit" class="btn btn-primary">保存调度策略</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 弹窗 3：日志详细堆栈弹窗 -->
    <div v-if="selectedLogDetail !== null" class="modal-backdrop" @click.self="selectedLogDetail = null">
      <div class="modal-box modal-box-lg">
        <div class="card-title">
          <span>同步执行详细日志</span>
          <button class="btn btn-sm" @click="selectedLogDetail = null">关闭</button>
        </div>
        <pre class="code-block" style="white-space: pre-wrap">{{ selectedLogDetail }}</pre>
      </div>
    </div>

    <!-- 弹窗 4：删除策略确认 -->
    <div v-if="confirmDeletePolicyTarget" class="modal-backdrop" @click.self="confirmDeletePolicyTarget = null">
      <div class="modal-box">
        <h3 class="card-title">确认删除调度策略「{{ confirmDeletePolicyTarget.name }}」？</h3>
        <p class="muted" style="margin: 0 0 18px">删除后定时调度器将立即下线该策略，历史执行流水仍会保留供审计。</p>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" @click="confirmDeletePolicyTarget = null">取消</button>
          <button class="btn btn-danger" @click="deletePolicy(confirmDeletePolicyTarget.id)">确认删除</button>
        </div>
      </div>
    </div>

    <!-- 弹窗 5：清空流水确认 -->
    <div v-if="confirmClearLogs" class="modal-backdrop" @click.self="confirmClearLogs = false">
      <div class="modal-box">
        <h3 class="card-title">确认清空全部同步执行流水？</h3>
        <p class="muted" style="margin: 0 0 18px">仅清除当前租户名下的 Cookie 同步历史流水，不影响策略配置及平台安全审计。</p>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" @click="confirmClearLogs = false">取消</button>
          <button class="btn btn-danger" @click="clearAllLogs">确认清空</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { apiFetch } from '../../api'

const emit = defineEmits(['notify'])

const policies = ref([])
const ownedNodes = ref([])
const groups = ref(['默认分组'])
const logs = ref([])

const runningPolicyId = ref(null)
const showPolicyModal = ref(false)
const isEditPolicy = ref(false)
const editingPolicyId = ref(null)

const showCookiePolicyModal = ref(false)
const cleanupBusy = ref(false)
const cleanupSummary = ref(null)
const confirmPurge = ref(false)

const selectedLogDetail = ref(null)
const confirmDeletePolicyTarget = ref(null)
const confirmClearLogs = ref(false)

const logSearchText = ref('')
const logStatusFilter = ref('')
const selectedTargetToAdd = ref('')
let refreshTimer = null

const topologyModes = [
  { value: 'smart_merge', title: '全网智能双向合并', desc: '全部自有在线空闲节点互通取并集，按最新有效期自动对齐。' },
  { value: 'group_to_group', title: '组对组同步 (Group-to-Group)', desc: '汇聚源分组内最新有效凭据，批量下发到目标分组节点。' },
  { value: 'node_to_group', title: '节点对组分发 (Node-to-Group)', desc: '以单个主节点为基准，批量覆盖分发到整个目标分组。' },
  { value: 'node_to_nodes', title: '节点对多节点 (一对多)', desc: '指定单节点作为源，定向同步给勾选的特定节点列表。' },
]

const reasonLabelMap = {
  expired: '已过期',
  blacklist_domain: '命中黑名单',
  cleanup_domain: '命中删除域名',
  keyword: '命中关键词',
  expires_before: '早于截止日期',
  expiring_soon: '即将过期',
  session_only: '会话级Cookie',
}

const cookiePolicy = reactive({
  sync_diff_enabled: true,
  sync_include_domains: '',
  sync_exclude_domains: 'doubleclick.net,google-analytics.com',
  sync_cleanup_enabled: false,
  sync_cleanup_expired: true,
  sync_cleanup_domains: '',
  sync_cleanup_keywords: '',
  sync_cleanup_keyword_scope: 'name_domain',
  sync_cleanup_expires_before: '',
  sync_cleanup_expiring_within_days: 0,
  sync_cleanup_session_only: false,
})

const isBlacklistActive = computed(() => Boolean(cookiePolicy.sync_exclude_domains && cookiePolicy.sync_exclude_domains.trim().length > 0))

const policyForm = reactive({
  name: '',
  enabled: true,
  interval_minutes: 15,
  sync_type: 'smart_merge',
  source_type: 'all',
  source_id: 0,
  source_group: '默认分组',
  target_type: 'all',
  target_ids: [],
  target_group: '默认分组',
})

const filteredLogs = computed(() => {
  let list = logs.value
  if (logStatusFilter.value) {
    list = list.filter((l) => l.status === logStatusFilter.value)
  }
  const q = logSearchText.value.trim().toLowerCase()
  if (q) {
    list = list.filter(
      (l) =>
        (l.source_node && l.source_node.toLowerCase().includes(q)) ||
        (l.target_nodes && l.target_nodes.toLowerCase().includes(q)) ||
        (l.details && l.details.toLowerCase().includes(q)),
    )
  }
  return list
})

function safeParseIds(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw
    return Array.isArray(parsed) ? parsed.map(Number) : []
  } catch {
    return []
  }
}

function formatRouteText(p) {
  if (p.sync_type === 'smart_merge') return '全网最新值智能双向合并'
  if (p.sync_type === 'group_to_group') return `[${p.source_group || '默认分组'}] → [${p.target_group || '默认分组'}]`
  if (p.sync_type === 'node_to_group') {
    const srcName = ownedNodes.value.find((n) => n.id === p.source_id)?.name || `节点#${p.source_id}`
    return `[${srcName}] → [${p.target_group || '默认分组'}]`
  }
  const count = safeParseIds(p.target_ids).length
  const srcName = ownedNodes.value.find((n) => n.id === p.source_id)?.name || `节点#${p.source_id}`
  return `[${srcName}] → ${count} 个指定目标`
}

async function loadAll() {
  try {
    const [p, n, g, l, c] = await Promise.all([
      apiFetch('/api/sync/policies'),
      apiFetch('/api/nodes'),
      apiFetch('/api/node-groups'),
      apiFetch('/api/sync/logs'),
      apiFetch('/api/cookie-policy'),
    ])
    policies.value = Array.isArray(p) ? p : []
    ownedNodes.value = Array.isArray(n) ? n : []
    groups.value = Array.isArray(g) && g.length > 0 ? g : ['默认分组']
    logs.value = Array.isArray(l) ? l : []
    if (c && typeof c === 'object') Object.assign(cookiePolicy, c)
  } catch (e) {
    emit('notify', e.message)
  }
}

function openCreatePolicy() {
  isEditPolicy.value = false
  editingPolicyId.value = null
  Object.assign(policyForm, {
    name: '办公节点智能双向同步',
    enabled: true,
    interval_minutes: 15,
    sync_type: 'smart_merge',
    source_type: 'all',
    source_id: ownedNodes.value[0]?.id || 0,
    source_group: groups.value[0] || '默认分组',
    target_type: 'all',
    target_ids: [],
    target_group: groups.value[0] || '默认分组',
  })
  showPolicyModal.value = true
}

function openEditPolicy(p) {
  isEditPolicy.value = true
  editingPolicyId.value = p.id
  Object.assign(policyForm, {
    name: p.name,
    enabled: Boolean(p.enabled),
    interval_minutes: Number(p.interval_minutes || 15),
    sync_type: p.sync_type || 'smart_merge',
    source_type: p.source_type || 'all',
    source_id: Number(p.source_id || ownedNodes.value[0]?.id || 0),
    source_group: p.source_group || groups.value[0] || '默认分组',
    target_type: p.target_type || 'all',
    target_ids: safeParseIds(p.target_ids),
    target_group: p.target_group || groups.value[0] || '默认分组',
  })
  showPolicyModal.value = true
}

function onSyncTypeChange() {
  if (policyForm.sync_type === 'smart_merge') {
    policyForm.source_type = 'all'
    policyForm.target_type = 'all'
  } else if (policyForm.sync_type === 'group_to_group') {
    policyForm.source_type = 'group'
    policyForm.target_type = 'group'
  } else if (policyForm.sync_type === 'node_to_group') {
    policyForm.source_type = 'node'
    policyForm.target_type = 'group'
  } else if (policyForm.sync_type === 'node_to_nodes') {
    policyForm.source_type = 'node'
    policyForm.target_type = 'nodes'
  }
}

function addTargetNode() {
  const id = parseInt(selectedTargetToAdd.value, 10)
  if (id && !policyForm.target_ids.includes(id)) {
    policyForm.target_ids.push(id)
  }
  selectedTargetToAdd.value = ''
}

function removeTargetNode(id) {
  policyForm.target_ids = policyForm.target_ids.filter((x) => x !== id)
}

async function submitPolicy() {
  try {
    const url = isEditPolicy.value ? `/api/sync/policies/${editingPolicyId.value}` : '/api/sync/policies'
    const method = isEditPolicy.value ? 'PUT' : 'POST'
    const res = await apiFetch(url, {
      method,
      body: JSON.stringify(policyForm),
    })
    showPolicyModal.value = false
    emit('notify', res.message || '同步策略已保存')
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function togglePolicy(p) {
  try {
    const res = await apiFetch(`/api/sync/policies/${p.id}/toggle`, { method: 'POST' })
    p.enabled = res.enabled
    emit('notify', res.message || '策略状态已更新')
  } catch (e) {
    emit('notify', e.message)
  }
}

async function deletePolicy(id) {
  confirmDeletePolicyTarget.value = null
  try {
    const res = await apiFetch(`/api/sync/policies/${id}`, { method: 'DELETE' })
    emit('notify', res.message || '策略已删除')
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function runPolicy(id) {
  if (runningPolicyId.value !== null) return
  runningPolicyId.value = id
  try {
    const res = await apiFetch(`/api/sync/policies/${id}/run`, { method: 'POST' })
    emit('notify', res.message || '策略同步已完成')
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  } finally {
    runningPolicyId.value = null
  }
}

function openCookiePolicyModal() {
  cleanupSummary.value = null
  confirmPurge.value = false
  showCookiePolicyModal.value = true
}

async function saveCookiePolicy() {
  try {
    const res = await apiFetch('/api/cookie-policy', {
      method: 'POST',
      body: JSON.stringify(cookiePolicy),
    })
    emit('notify', res.message || '全局过滤与清理策略已保存')
    showCookiePolicyModal.value = false
  } catch (e) {
    emit('notify', e.message)
  }
}

async function runGlobalCleanup(dryRun) {
  cleanupBusy.value = true
  try {
    const data = await apiFetch('/api/cookie-policy/cleanup-now', {
      method: 'POST',
      body: JSON.stringify({ dry_run: dryRun, ...cookiePolicy }),
    })
    cleanupSummary.value = data
    if (dryRun) {
      emit('notify', `试算完成：覆盖 ${data.node_count} 个在线节点，命中 ${data.matched_total} 条`)
    } else {
      emit('notify', `全网清理完成：实删 ${data.purged_total} 条 Cookie`)
      await loadAll()
    }
  } catch (e) {
    emit('notify', e.message)
  } finally {
    cleanupBusy.value = false
  }
}

async function clearAllLogs() {
  confirmClearLogs.value = false
  try {
    const res = await apiFetch('/api/sync/logs', { method: 'DELETE' })
    emit('notify', res.message || '流水已清空')
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  }
}

onMounted(() => {
  loadAll()
  refreshTimer = setInterval(loadAll, 20000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>
