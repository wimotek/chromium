<script setup>
import { ref, reactive, onMounted } from 'vue'

const props = defineProps({
  api: Function,
  showToast: Function
})

const policies = ref([])
const nodes = ref([])
const groups = ref([])
const logs = ref([])
const isExecuting = ref(false)

// 策略弹窗状态
const showPolicyModal = ref(false)
const isEditPolicy = ref(false)
const editingPolicyId = ref(null)

// 详情弹窗
const showLogModal = ref(false)
const selectedLogDetail = ref('')

// 策略表单模型
const policyForm = reactive({
  name: '',
  enabled: true,
  interval_minutes: 15,
  sync_type: 'smart_merge', // 'smart_merge' | 'group_to_group' | 'node_to_group' | 'node_to_nodes'
  source_type: 'all',       // 'node' | 'group' | 'all'
  source_id: 0,
  source_group: '',
  target_type: 'all',       // 'all' | 'group' | 'nodes'
  target_ids: [],
  target_group: ''
})

const selectedTargetToAdd = ref('')

const loadAllData = async () => {
  const [pRes, nRes, gRes, lRes] = await Promise.all([
    props.api('/api/sync/policies'),
    props.api('/api/nodes'),
    props.api('/api/node-groups'),
    props.api('/api/sync/logs')
  ])
  policies.value = await pRes.json()
  nodes.value = await nRes.json()
  groups.value = await gRes.json()
  logs.value = await lRes.json()
}

const openCreatePolicy = () => {
  isEditPolicy.value = false
  editingPolicyId.value = null
  Object.assign(policyForm, {
    name: '新建调度策略',
    enabled: true,
    interval_minutes: 15,
    sync_type: 'smart_merge',
    source_type: 'all',
    source_id: nodes.value[0]?.id || 0,
    source_group: groups.value[0] || '默认分组',
    target_type: 'all',
    target_ids: [],
    target_group: groups.value[0] || '默认分组'
  })
  showPolicyModal.value = true
}

const openEditPolicy = (p) => {
  isEditPolicy.value = true
  editingPolicyId.value = p.id
  Object.assign(policyForm, {
    name: p.name,
    enabled: Boolean(p.enabled),
    interval_minutes: p.interval_minutes,
    sync_type: p.sync_type,
    source_type: p.source_type,
    source_id: p.source_id,
    source_group: p.source_group || groups.value[0] || '默认分组',
    target_type: p.target_type,
    target_ids: JSON.parse(p.target_ids || '[]'),
    target_group: p.target_group || groups.value[0] || '默认分组'
  })
  showPolicyModal.value = true
}

const onSyncTypeChange = () => {
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

const submitPolicy = async () => {
  const url = isEditPolicy.value ? `/api/sync/policies/${editingPolicyId.value}` : '/api/sync/policies'
  const method = isEditPolicy.value ? 'PUT' : 'POST'
  const res = await props.api(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(policyForm)
  })
  const data = await res.json()
  showPolicyModal.value = false
  props.showToast(data.message, 'success')
  loadAllData()
}

const togglePolicy = async (p) => {
  const res = await props.api(`/api/sync/policies/${p.id}/toggle`, { method: 'POST' })
  const data = await res.json()
  p.enabled = data.enabled
  props.showToast(data.message, 'success')
}

const deletePolicy = async (id) => {
  if (confirm('确认销毁该条调度策略？')) {
    await props.api(`/api/sync/policies/${id}`, { method: 'DELETE' })
    props.showToast('策略已删除', 'success')
    loadAllData()
  }
}

const runPolicy = async (id) => {
  if (isExecuting.value) return
  isExecuting.value = true
  try {
    const res = await props.api(`/api/sync/policies/${id}/run`, { method: 'POST' })
    const data = await res.json()
    props.showToast(data.message, 'success')
    const lRes = await props.api('/api/sync/logs')
    logs.value = await lRes.json()
  } finally {
    isExecuting.value = false
  }
}

const clearAllLogs = async () => {
  if (confirm('确认清空所有历史同步审计流水记录？清空后将无法恢复！')) {
    const res = await props.api('/api/sync/logs', { method: 'DELETE' })
    const data = await res.json()
    if (res.ok) {
      props.showToast(data.message, 'success')
      logs.value = []
    } else {
      props.showToast(data.detail || '清空失败', 'error')
    }
  }
}

const addTargetNode = () => {
  const id = parseInt(selectedTargetToAdd.value)
  if (id && !policyForm.target_ids.includes(id)) {
    policyForm.target_ids.push(id)
  }
  selectedTargetToAdd.value = ''
}

const removeTargetNode = (id) => {
  policyForm.target_ids = policyForm.target_ids.filter(x => x !== id)
}

const viewLogDetail = (detail) => {
  selectedLogDetail.value = detail
  showLogModal.value = true
}

onMounted(() => {
  loadAllData()
})
</script>

<template>
  <div class="sync-manager-container">
    
    <!-- 顶栏 -->
    <div class="sync-top-header">
      <div class="sync-title-box">
        <span class="sync-icon-globe">🌐</span>
        <h2 class="sync-title-text">多策略自动同步调度中枢 (支持组对组 / 节点对组)</h2>
      </div>
      <button @click="openCreatePolicy" class="btn-primary-gradient">
        + 新增调度策略
      </button>
    </div>

    <!-- 策略管理列表 (Cards) -->
    <div class="policies-grid-wrapper">
      <div v-for="p in policies" :key="p.id" class="policy-card-item">
        <div class="policy-card-top">
          <div style="display:flex; align-items:center; gap:10px;">
            <span class="policy-badge-icon">
              {{ p.sync_type === 'smart_merge' ? '🌟' : p.sync_type === 'group_to_group' ? '🏢' : '🎯' }}
            </span>
            <div>
              <h4 class="policy-name-text">{{ p.name }}</h4>
              <span class="policy-time-tag">⏱️ 每 {{ p.interval_minutes }} 分钟自动调度</span>
            </div>
          </div>

          <div style="display:flex; align-items:center; gap:8px;">
            <button @click="togglePolicy(p)" :class="p.enabled ? 'btn-status-on' : 'btn-status-off'">
              {{ p.enabled ? '● 正在运行' : '○ 已停用' }}
            </button>
          </div>
        </div>

        <div class="policy-meta-body">
          <div class="meta-row">
            <span class="meta-label">同步模式:</span>
            <span class="meta-val font-cyan-mono">
              {{ 
                p.sync_type === 'smart_merge' ? '全网最新值智能合并' : 
                p.sync_type === 'group_to_group' ? `组对组分发 [${p.source_group}] ➔ [${p.target_group}]` : 
                p.sync_type === 'node_to_group' ? `节点对组分发 [${nodes.find(n => n.id === p.source_id)?.name || '未指定'}] ➔ [${p.target_group}]` : 
                '节点对多节点分发' 
              }}
            </span>
          </div>

          <div class="meta-row">
            <span class="meta-label">上次执行:</span>
            <span class="meta-val">{{ p.last_run || '等待定时器触发...' }}</span>
          </div>
        </div>

        <!-- 策略操作按钮行 -->
        <div class="policy-card-actions">
          <button @click="runPolicy(p.id)" :disabled="isExecuting" class="btn-micro btn-orange">
            ⚡ 立即执行
          </button>
          <button @click="openEditPolicy(p)" class="btn-micro" style="background:#2563eb;">
            ✏️ 编辑
          </button>
          <button @click="deletePolicy(p.id)" class="btn-micro btn-trash">
            🗑️ 删除
          </button>
        </div>
      </div>

      <div v-if="policies.length === 0" class="empty-policy-box">
        暂无调度策略，请点击上方「+ 新增调度策略」配置组对组或节点间同步。
      </div>
    </div>

    <!-- ==================== 审计列表：高规格结构化数据表格 (严格 20 条与清空) ==================== -->
    <div class="audit-section-wrapper">
      <div class="audit-header-bar">
        <div class="audit-title-box">
          <span style="font-size:16px;">📜</span>
          <h3 class="audit-title-text">同步任务审计追踪流水</h3>
          <span class="badge-retention-note">仅保留最近 20 条 (自动轮转淘汰)</span>
        </div>
        <div style="display:flex; gap:12px; align-items:center;">
          <button @click="loadAllData" class="link-btn-cyan">刷新审计</button>
          <button @click="clearAllLogs" class="link-btn-red" style="font-weight:600;">🗑️ 清空审计流水</button>
        </div>
      </div>

      <div class="audit-table-scroll">
        <table class="audit-data-table">
          <thead>
            <tr>
              <th style="min-width: 160px;">时间戳</th>
              <th style="min-width: 150px;">源端发起</th>
              <th style="min-width: 200px;">分发目标范围</th>
              <th style="min-width: 110px;">Cookie 数量</th>
              <th style="min-width: 100px;">执行耗时</th>
              <th style="min-width: 90px; text-align: center;">状态</th>
              <th style="min-width: 90px; text-align: right; padding-right: 18px;">日志详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in logs" :key="l.id">
              <td class="font-mono text-muted">{{ l.timestamp }}</td>
              <td>
                <span class="badge-smart-source">{{ l.source_node || '---' }}</span>
              </td>
              <td class="target-nodes-col" :title="l.target_nodes">
                {{ l.target_nodes || '---' }}
              </td>
              <td>
                <span class="cookie-stat-badge">🍪 {{ l.cookie_count || 0 }} 条</span>
              </td>
              <td class="font-mono text-duration">⏱️ {{ l.duration || '0.00s' }}</td>
              <td style="text-align: center;">
                <span v-if="l.status==='SUCCESS'" class="status-pill-ok">● 成功</span>
                <span v-else class="status-pill-fail">✕ 失败</span>
              </td>
              <td style="text-align: right; padding-right: 18px;">
                <button @click="viewLogDetail(l.details)" class="btn-view-detail">查看详情</button>
              </td>
            </tr>
            <tr v-if="logs.length === 0">
              <td colspan="7" class="empty-table-cell">暂无调度流水记录</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 弹窗：新建 / 修改策略 (支持组对组与节点对组) -->
    <div v-if="showPolicyModal" class="modal-backdrop">
      <div class="modal-card modal-policy-size">
        <div class="modal-title-bar">
          <h3 class="modal-title-h3">{{ isEditPolicy ? '修改调度策略' : '添加同步调度策略' }}</h3>
          <button @click="showPolicyModal = false" class="modal-close-btn">✕</button>
        </div>

        <form @submit.prevent="submitPolicy" class="form-vertical-flow" style="margin-top:14px;">
          <div class="row-flex-gap">
            <div class="form-block" style="flex:2;">
              <label class="block-label">策略名称</label>
              <input v-model="policyForm.name" required placeholder="如: 爬虫组同步至北美备份" class="sync-input" style="width:100% !important;">
            </div>
            <div class="form-block" style="flex:1;">
              <label class="block-label">调度周期 (分钟)</label>
              <input v-model="policyForm.interval_minutes" type="number" min="1" required class="sync-input font-cyan-mono" style="width:100% !important;">
            </div>
          </div>

          <!-- 同步模式核心单选 -->
          <div class="form-block">
            <label class="block-label">同步传输拓扑模式</label>
            <div class="grid-2col-fluid" style="gap:10px;">
              <label :class="['mode-choice-card', policyForm.sync_type === 'smart_merge' ? 'mode-choice-active' : '']">
                <input type="radio" v-model="policyForm.sync_type" value="smart_merge" @change="onSyncTypeChange" style="display:none;">
                <span class="mode-name-cyan">🌟 全网智能双向合并</span>
                <p class="mode-desc-text">全网所有节点互通取并集，同名凭证比对有效期最新值自动对齐。</p>
              </label>

              <label :class="['mode-choice-card', policyForm.sync_type === 'group_to_group' ? 'mode-choice-active' : '']">
                <input type="radio" v-model="policyForm.sync_type" value="group_to_group" @change="onSyncTypeChange" style="display:none;">
                <span class="mode-name-cyan">🏢 组对组同步 (Group-to-Group)</span>
                <p class="mode-desc-text">汇聚源分组内的最新有效凭据，并发分发给目标分组的所有节点。</p>
              </label>

              <label :class="['mode-choice-card', policyForm.sync_type === 'node_to_group' ? 'mode-choice-active' : '']">
                <input type="radio" v-model="policyForm.sync_type" value="node_to_group" @change="onSyncTypeChange" style="display:none;">
                <span class="mode-name-cyan">🎯 节点对组分发 (Node-to-Group)</span>
                <p class="mode-desc-text">以单个指定主节点为基准，将其凭据批量下发给整个目标分组。</p>
              </label>

              <label :class="['mode-choice-card', policyForm.sync_type === 'node_to_nodes' ? 'mode-choice-active' : '']">
                <input type="radio" v-model="policyForm.sync_type" value="node_to_nodes" @change="onSyncTypeChange" style="display:none;">
                <span class="mode-name-cyan">💻 节点对多节点 (一对多)</span>
                <p class="mode-desc-text">指定单节点作为源，定向同步给勾选的特定节点队列。</p>
              </label>
            </div>
          </div>

          <!-- 根据模式呈现不同的源端与目标端选择器 -->
          <div class="topology-selector-box form-vertical-flow">
            <!-- 场景 1: 组对组 -->
            <div v-if="policyForm.sync_type === 'group_to_group'" class="row-flex-gap">
              <div class="form-block" style="flex:1;">
                <label class="block-label">源分组 (Source Group)</label>
                <select v-model="policyForm.source_group" class="sync-input font-cyan-mono" style="width:100% !important;">
                  <option v-for="g in groups" :key="g" :value="g">📁 {{ g }}</option>
                </select>
              </div>
              <div class="form-block" style="flex:1;">
                <label class="block-label">目标分组 (Target Group)</label>
                <select v-model="policyForm.target_group" class="sync-input font-cyan-mono" style="width:100% !important;">
                  <option v-for="g in groups" :key="g" :value="g">📁 {{ g }}</option>
                </select>
              </div>
            </div>

            <!-- 场景 2: 节点对组 -->
            <div v-if="policyForm.sync_type === 'node_to_group'" class="row-flex-gap">
              <div class="form-block" style="flex:1;">
                <label class="block-label">源节点 (Source Node)</label>
                <select v-model="policyForm.source_id" class="sync-input font-cyan-mono" style="width:100% !important;">
                  <option v-for="n in nodes" :key="n.id" :value="n.id">{{ n.name }} ({{ n.group_name }})</option>
                </select>
              </div>
              <div class="form-block" style="flex:1;">
                <label class="block-label">目标分组 (Target Group)</label>
                <select v-model="policyForm.target_group" class="sync-input font-cyan-mono" style="width:100% !important;">
                  <option v-for="g in groups" :key="g" :value="g">📁 {{ g }}</option>
                </select>
              </div>
            </div>

            <!-- 场景 3: 节点对多节点 -->
            <div v-if="policyForm.sync_type === 'node_to_nodes'" class="form-vertical-flow">
              <div class="form-block">
                <label class="block-label">源节点 (Source Node)</label>
                <select v-model="policyForm.source_id" class="sync-input font-cyan-mono" style="width:100% !important;">
                  <option v-for="n in nodes" :key="n.id" :value="n.id">{{ n.name }} ({{ n.group_name }})</option>
                </select>
              </div>

              <div class="form-block">
                <label class="block-label">添加目标节点</label>
                <div style="display:flex; gap:8px;">
                  <select v-model="selectedTargetToAdd" class="sync-input font-mono" style="flex:1;">
                    <option value="">-- 选择目标节点加入队列 --</option>
                    <option v-for="n in nodes.filter(x => x.id !== policyForm.source_id && !policyForm.target_ids.includes(x.id))" :key="n.id" :value="n.id">
                      + {{ n.name }} ({{ n.group_name }})
                    </option>
                  </select>
                  <button type="button" @click="addTargetNode" class="btn-sub-action">添加</button>
                </div>

                <div class="chips-container-box" style="margin-top:8px;">
                  <span v-for="tid in policyForm.target_ids" :key="tid" class="chip-item-pill">
                    {{ nodes.find(n => n.id === tid)?.name || tid }}
                    <span @click="removeTargetNode(tid)" class="chip-close-icon">✕</span>
                  </span>
                  <span v-if="policyForm.target_ids.length === 0" class="empty-tip-text">尚未添加任何目标节点</span>
                </div>
              </div>
            </div>

            <!-- 场景 4: 全网智能合并提示 -->
            <div v-if="policyForm.sync_type === 'smart_merge'" style="font-size:12px; color:#38bdf8;">
              ✓ 自动作用于全网所有分组内的在线节点，各节点最新产生的登录态将互相对齐同步。
            </div>
          </div>

          <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
            <button type="button" @click="showPolicyModal = false" class="btn-gray-test">取消</button>
            <button type="submit" class="btn-primary-gradient">保存调度策略</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 日志详情弹窗 -->
    <div v-if="showLogModal" class="modal-backdrop">
      <div class="modal-card modal-log-size">
        <div class="modal-title-bar">
          <h3 class="modal-title-h3">同步执行详细堆栈轨迹</h3>
          <button @click="showLogModal = false" class="modal-close-btn">✕</button>
        </div>
        <div style="margin-top:12px;">
          <pre class="console-box-pre">{{ selectedLogDetail }}</pre>
          <div style="display:flex; justify-content:flex-end; margin-top:14px;">
            <button @click="showLogModal = false" class="btn-primary-gradient">关闭</button>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
/* ==================== SyncManager 完整独立自闭环样式体系 ==================== */

.sync-manager-container {
  width: 100%;
  background-color: #0b132b;
  border: 1px solid #172554;
  border-radius: 14px;
  padding: 20px;
  box-sizing: border-box;
}

/* 顶栏 */
.sync-top-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 16px;
  border-bottom: 1px solid #172554;
  margin-bottom: 16px;
}

.sync-title-box {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sync-icon-globe {
  font-size: 18px;
  color: #38bdf8;
}

.sync-title-text {
  font-size: 15px;
  font-weight: bold;
  color: #ffffff;
  margin: 0;
}

/* 多策略管理卡片网格 */
.policies-grid-wrapper {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  margin-bottom: 24px;
  width: 100%;
}
@media (max-width: 1050px) {
  .policies-grid-wrapper { grid-template-columns: 1fr; }
}

.policy-card-item {
  background: #09122a;
  border: 1px solid #172554;
  border-radius: 10px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 12px;
  transition: all 0.2s ease;
}
.policy-card-item:hover {
  border-color: #1e3a8a;
  transform: translateY(-1px);
}

.policy-card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.policy-badge-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: #0f1f42;
  border: 1px solid #1d4ed8;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  flex-shrink: 0;
}

.policy-name-text {
  font-size: 14px;
  font-weight: bold;
  color: #ffffff;
  margin: 0;
}

.policy-time-tag {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 2px;
  display: inline-block;
}

.btn-status-on {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid #059669;
  color: #34d399;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.btn-status-off {
  background: rgba(100, 116, 139, 0.15);
  border: 1px solid #475569;
  color: #94a3b8;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.policy-meta-body {
  background: #060b17;
  border: 1px solid #131e3d;
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-row { display: flex; gap: 8px; }
.meta-label { color: #64748b; font-size: 11px; width: 65px; flex-shrink: 0; }
.meta-val { color: #cbd5e1; font-size: 11px; word-break: break-all; }

.policy-card-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.empty-policy-box {
  grid-column: 1 / -1;
  text-align: center;
  color: #64748b;
  padding: 30px;
  background: #09122a;
  border: 1px dashed #172554;
  border-radius: 8px;
  font-size: 12px;
}

/* 表单与输入 */
.form-vertical-flow {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form-block {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.block-label {
  font-size: 12px;
  color: #94a3b8;
  font-weight: 500;
  line-height: 1.4;
}

.row-flex-gap {
  display: flex;
  gap: 12px;
}
@media (max-width: 640px) {
  .row-flex-gap { flex-direction: column; }
}

.sync-input {
  box-sizing: border-box;
  background-color: #0f1c3f;
  border: 1px solid #1e3a8a;
  color: #ffffff;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  outline: none;
  transition: all 0.2s;
}

.sync-input:focus {
  border-color: #00f0ff;
  box-shadow: 0 0 8px rgba(0, 240, 255, 0.35);
}

.font-mono { font-family: monospace; }
.font-cyan-mono { color: #00f0ff; font-family: monospace; font-weight: bold; }

/* 拓扑模式卡片 */
.grid-2col-fluid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  width: 100%;
}
@media (max-width: 680px) {
  .grid-2col-fluid { grid-template-columns: 1fr; }
}

.mode-choice-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  background: #060b17;
  border: 1px solid #172554;
  border-radius: 6px;
  padding: 10px 14px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.mode-choice-card:hover {
  border-color: #1e3a8a;
}
.mode-choice-active {
  border-color: #00f0ff !important;
  background: #091a38 !important;
}

.mode-name-cyan {
  font-weight: bold;
  color: #38bdf8;
  font-size: 13px;
}

.mode-desc-text {
  font-size: 11px;
  color: #64748b;
  line-height: 1.5;
  margin: 0;
}

.topology-selector-box {
  background: #060b17;
  border: 1px solid #1e3a8a;
  border-radius: 8px;
  padding: 14px;
}

/* 目标添加与胶囊标签 */
.chips-container-box {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  min-height: 28px;
  align-items: center;
}

.chip-item-pill {
  background: #0e3b5e;
  border: 1px solid #0284c7;
  color: #38bdf8;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.chip-close-icon {
  cursor: pointer;
  color: #f87171;
  font-weight: bold;
}
.chip-close-icon:hover { color: #ffffff; }

.empty-tip-text {
  font-size: 11px;
  color: #64748b;
}

/* 按钮体系 */
.btn-primary-gradient {
  background: linear-gradient(135deg, #0284c7, #2563eb);
  color: #ffffff;
  border: none;
  border-radius: 6px;
  padding: 7px 20px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: auto !important;
  height: 34px;
  transition: opacity 0.2s, transform 0.15s;
}
.btn-primary-gradient:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

.btn-sub-action {
  background: #1e293b;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 6px;
  padding: 4px 14px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  height: 33px;
  transition: all 0.2s;
}
.btn-sub-action:hover {
  background: #334155;
  color: #ffffff;
}

.btn-gray-test {
  background: #1e293b;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 6px;
  padding: 7px 16px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  height: 34px;
}
.btn-gray-test:hover { background: #334155; color: #ffffff; }

.link-btn-cyan {
  background: none;
  border: none;
  color: #38bdf8;
  font-size: 11px;
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
}

.link-btn-red {
  background: none;
  border: none;
  color: #f87171;
  font-size: 11px;
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
}

.btn-micro {
  border: none;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: bold;
  color: #ffffff;
  cursor: pointer;
  white-space: nowrap;
}
.btn-orange { background-color: #d97706; }
.btn-trash  { background-color: #991b1b; }

/* 审计列表表格 */
.audit-section-wrapper {
  margin-top: 24px;
}

.audit-header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.audit-title-box {
  display: flex;
  align-items: center;
  gap: 8px;
}

.audit-title-text {
  font-size: 14px;
  font-weight: bold;
  color: #ffffff;
  margin: 0;
}

.badge-retention-note {
  font-size: 11px;
  color: #64748b;
  background: #09122a;
  border: 1px solid #172554;
  padding: 2px 8px;
  border-radius: 4px;
}

.audit-table-scroll {
  width: 100%;
  overflow-x: auto;
  border: 1px solid #172554;
  border-radius: 8px;
  background: #060b17;
}

.audit-data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  white-space: nowrap;
}

.audit-data-table th {
  background-color: #09122a;
  color: #94a3b8;
  font-weight: 600;
  padding: 10px 14px;
  border-bottom: 1px solid #172554;
  text-align: left;
}

.audit-data-table td {
  padding: 12px 14px;
  border-bottom: 1px solid #111c38;
  vertical-align: middle;
}

.text-muted { color: #94a3b8; }

.badge-smart-source {
  background: rgba(14, 165, 233, 0.2);
  border: 1px solid #0284c7;
  color: #38bdf8;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 500;
}

.target-nodes-col {
  color: #cbd5e1;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cookie-stat-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background-color: #0f1f42;
  border: 1px solid #1d4ed8;
  padding: 2px 8px;
  border-radius: 4px;
  color: #fcd34d;
  font-weight: bold;
  font-size: 11px;
}

.text-duration {
  color: #38bdf8;
  font-weight: bold;
}

.status-pill-ok {
  background-color: rgba(6, 78, 59, 0.85);
  border: 1px solid #059669;
  color: #34d399;
  border-radius: 9999px;
  padding: 2px 8px;
  font-size: 11px;
}

.status-pill-fail {
  background-color: rgba(69, 10, 10, 0.8);
  border: 1px solid #dc2626;
  color: #f87171;
  border-radius: 9999px;
  padding: 2px 8px;
  font-size: 11px;
}

.btn-view-detail {
  background: #1e293b;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 4px;
  height: 26px;
  padding: 2px 10px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-view-detail:hover {
  background: #334155;
  color: #ffffff;
}

.empty-table-cell {
  text-align: center;
  color: #64748b;
  padding: 36px;
}

/* 模态弹窗 */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 9999;
}

.modal-card {
  background-color: #0b132b;
  border: 1px solid #1e3a8a;
  border-radius: 12px;
  padding: 20px 24px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.8);
}

.modal-policy-size {
  width: 760px;
  max-width: 95vw;
}

.modal-log-size {
  width: 720px;
  max-width: 95vw;
}

.modal-title-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 12px;
  border-bottom: 1px solid #172554;
}

.modal-title-h3 {
  font-size: 14px;
  font-weight: bold;
  color: #fff;
  margin: 0;
}

.modal-close-btn {
  background: none;
  border: none;
  color: #94a3b8;
  font-size: 16px;
  cursor: pointer;
}
.modal-close-btn:hover { color: #fff; }

.console-box-pre {
  background: #060b17;
  border: 1px solid #172554;
  border-radius: 8px;
  padding: 14px;
  font-family: monospace;
  font-size: 12px;
  height: 380px;
  overflow-y: auto;
  color: #e2e8f0;
  white-space: pre-wrap;
  margin: 0;
}
</style>