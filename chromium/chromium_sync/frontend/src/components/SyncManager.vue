<script setup>
import { ref, reactive, computed, onMounted } from 'vue'

const props = defineProps({
  api: Function,
  showToast: Function
})

const logs = ref([])
const nodes = ref([])
const isSyncing = ref(false)

// 审计日志详情弹窗
const showLogModal = ref(false)
const selectedLogDetail = ref('')

// 同步策略配置 (首选智能合并 smart_merge)
const syncConfig = reactive({
  sync_interval_minutes: 15,
  sync_mode: 'smart_merge',
  sync_source_id: 0,
  sync_target_ids: []
})

// 主从模式下：待添加的目标节点 ID
const selectedScheduleTargetToAdd = ref('')

// 即时定向同步状态
const manualSourceId = ref(0)
const manualTargetMode = ref('all') // 'all' | 'custom'
const manualTargetIds = ref([])
const selectedTargetToAdd = ref('')

// 主从候选目标：排除主节点自己
const scheduleCandidateTargets = computed(() => {
  return nodes.value.filter(n => n.id !== syncConfig.sync_source_id)
})

// 即时同步候选目标：排除源节点自己
const candidateTargets = computed(() => {
  return nodes.value.filter(n => n.id !== manualSourceId.value)
})

const loadData = async () => {
  const [sRes, lRes, nRes] = await Promise.all([
    props.api('/api/sync/settings'),
    props.api('/api/sync/logs'),
    props.api('/api/nodes')
  ])
  Object.assign(syncConfig, await sRes.json())
  logs.value = await lRes.json()
  nodes.value = await nRes.json()

  const defaultSrc = nodes.value.find(n => n.is_source === 1)
  if (defaultSrc) {
    manualSourceId.value = defaultSrc.id
    if (syncConfig.sync_source_id === 0) syncConfig.sync_source_id = defaultSrc.id
  } else if (nodes.value.length > 0) {
    manualSourceId.value = nodes.value[0].id
  }
}

// ---------------- 主从模式目标选择交互 ----------------
const addScheduleTarget = () => {
  const id = parseInt(selectedScheduleTargetToAdd.value)
  if (id && !syncConfig.sync_target_ids.includes(id)) {
    syncConfig.sync_target_ids.push(id)
  }
  selectedScheduleTargetToAdd.value = ''
}

const removeScheduleTarget = (id) => {
  syncConfig.sync_target_ids = syncConfig.sync_target_ids.filter(x => x !== id)
}

const selectAllScheduleTargets = () => {
  syncConfig.sync_target_ids = scheduleCandidateTargets.value.map(n => n.id)
  props.showToast(`已全选当前 ${syncConfig.sync_target_ids.length} 个候选目标`, 'success')
}

const clearAllScheduleTargets = () => {
  syncConfig.sync_target_ids = []
}

// ---------------- 即时定向目标选择交互 ----------------
const addTargetToManual = () => {
  const id = parseInt(selectedTargetToAdd.value)
  if (id && !manualTargetIds.value.includes(id)) {
    manualTargetIds.value.push(id)
  }
  selectedTargetToAdd.value = ''
}

const removeManualTarget = (id) => {
  manualTargetIds.value = manualTargetIds.value.filter(x => x !== id)
}

const selectAllManualTargets = () => {
  manualTargetIds.value = candidateTargets.value.map(n => n.id)
}

const clearAllManualTargets = () => {
  manualTargetIds.value = []
}

const saveSyncPolicy = async () => {
  const res = await props.api('/api/sync/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(syncConfig)
  })
  if (res.ok) {
    props.showToast('同步策略与定时周期已生效', 'success')
  }
}

const triggerSync = async (isManualDirected = false) => {
  if (isSyncing.value) return

  if (isManualDirected) {
    if (!manualSourceId.value || manualSourceId.value === 0) {
      props.showToast('请先选择一个抓取凭证的源节点！', 'error')
      return
    }
  }

  isSyncing.value = true
  try {
    const payload = {}
    if (isManualDirected) {
      payload.source_id = manualSourceId.value
      if (manualTargetMode.value === 'custom' && manualTargetIds.value.length > 0) {
        payload.target_ids = manualTargetIds.value
      }
    }

    const res = await props.api('/api/sync/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const data = await res.json()
    props.showToast(data.message, 'success')

    const lRes = await props.api('/api/sync/logs')
    logs.value = await lRes.json()
  } finally {
    isSyncing.value = false
  }
}

const viewLogDetail = (detail) => {
  selectedLogDetail.value = detail
  showLogModal.value = true
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="sync-manager-container">
    <!-- 顶栏标题与立即同步按钮 -->
    <div class="sync-top-header">
      <div class="sync-title-box">
        <span class="sync-icon-globe">🌐</span>
        <h2 class="sync-title-text">全网 Cookie 自动同步与集群调度治理</h2>
      </div>
      <button @click="triggerSync(false)" :disabled="isSyncing" class="btn-sync-action">
        {{ isSyncing ? '同步执行中...' : '⚡ 立即执行同步' }}
      </button>
    </div>

    <!-- 策略配置双列栅格 -->
    <div class="sync-cards-grid">
      
      <!-- 左列：调度策略配置 -->
      <div class="sync-config-card">
        <h3 class="card-title-h3">⚙️ 自动化调度策略</h3>
        
        <div class="form-vertical-flow">
          <!-- 定时周期 -->
          <div class="form-block">
            <label class="block-label">定时调度周期 (分钟)</label>
            <div class="input-inline-wrap">
              <input v-model="syncConfig.sync_interval_minutes" type="number" min="1" class="sync-input input-port font-mono">
              <span class="unit-text">分钟 / 次</span>
            </div>
          </div>

          <!-- 模式选择 -->
          <div class="form-block">
            <label class="block-label">同步模式规则 (默认首选智能合并)</label>
            <div class="mode-cards-stack">
              
              <!-- 模式 1: 智能合并 (置前并默认) -->
              <label :class="['mode-choice-card', syncConfig.sync_mode === 'smart_merge' ? 'mode-choice-active' : '']">
                <input type="radio" v-model="syncConfig.sync_mode" value="smart_merge" style="display:none;">
                <div class="mode-header-line">
                  <span class="mode-name-cyan">🌟 智能全局最新值合并 (Smart Merge)</span>
                  <span class="tag-recommend">推荐默认</span>
                </div>
                <p class="mode-desc-text">
                  自动收集各节点 Cookie 取并集；不同站点互相补齐，同名凭证比对有效期最新值自动对齐，<b>无需依赖任何固定源节点</b>。
                </p>
              </label>

              <!-- 模式 2: 主从定向模式 -->
              <label :class="['mode-choice-card', syncConfig.sync_mode === 'master_worker' ? 'mode-choice-active' : '']">
                <input type="radio" v-model="syncConfig.sync_mode" value="master_worker" style="display:none;">
                <div class="mode-header-line">
                  <span class="mode-name-gray">📌 指定主节点单向广播 (Master-Worker)</span>
                </div>
                <p class="mode-desc-text">
                  指定固定的 Master 节点，将其凭证单向覆盖至指定的从属目标节点队列。
                </p>
              </label>

            </div>
          </div>

          <!-- 主从模式下的目标节点选择 (支持下拉添加与 ALL 一键全选) -->
          <div v-if="syncConfig.sync_mode === 'master_worker'" class="master-worker-panel">
            <div class="form-block">
              <label class="block-label">指定固定源节点 (Master)</label>
              <select v-model="syncConfig.sync_source_id" class="sync-input input-normal font-mono">
                <option :value="0">-- 未指定固定源 (请选择) --</option>
                <option v-for="n in nodes" :key="n.id" :value="n.id">
                  {{ n.is_source ? '★ [默认源] ' : '' }}{{ n.name }} ({{ n.is_local ? '本地' : n.ssh_host }})
                </option>
              </select>
            </div>

            <div class="form-block">
              <div class="panel-header-sub">
                <label class="block-label" style="margin:0;">加入目标节点队列 (一对多)</label>
                <div class="actions-links-wrap">
                  <button type="button" @click="selectAllScheduleTargets" class="link-btn-cyan">⚡ ALL 一次全选所有</button>
                  <button type="button" @click="clearAllScheduleTargets" class="link-btn-red">清空</button>
                </div>
              </div>

              <!-- 下拉选择与添加 -->
              <div class="select-add-row">
                <select v-model="selectedScheduleTargetToAdd" class="sync-input font-mono" style="width: auto; min-width: 220px;">
                  <option value="">-- 选择加入的分发目标节点 --</option>
                  <option v-for="n in scheduleCandidateTargets.filter(x => !syncConfig.sync_target_ids.includes(x.id))" :key="n.id" :value="n.id">
                    + {{ n.name }} ({{ n.is_local ? '本地' : n.ssh_host }})
                  </option>
                </select>
                <button type="button" @click="addScheduleTarget" class="btn-sub-action">
                  添加目标
                </button>
              </div>

              <!-- 已选目标胶囊列表 -->
              <div class="chips-container-box">
                <span v-for="tid in syncConfig.sync_target_ids" :key="tid" class="chip-item-pill">
                  {{ nodes.find(n => n.id === tid)?.name || tid }}
                  <span @click="removeScheduleTarget(tid)" class="chip-close-icon">✕</span>
                </span>
                <span v-if="syncConfig.sync_target_ids.length === 0" class="empty-tip-text">
                  * 尚未添加目标节点，点击“ALL 一次全选”或从下拉菜单添加目标
                </span>
              </div>
            </div>
          </div>

          <div style="margin-top:6px;">
            <button @click="saveSyncPolicy" class="btn-sync-action">保存调度策略</button>
          </div>
        </div>
      </div>

      <!-- 右列：即时定向同步执行器 -->
      <div class="sync-config-card">
        <h3 class="card-title-h3">🎯 即时定向同步 (按需临时执行)</h3>
        <p class="card-subtitle-desc">临时指定任意源节点，并将凭据批量推送到指定的单个或多个目标节点。</p>
        
        <div class="form-vertical-flow">
          <!-- 临时抓取源 -->
          <div class="form-block">
            <label class="block-label">选择抓取凭据的源节点 (Source)</label>
            <select v-model="manualSourceId" class="sync-input input-normal font-mono">
              <option :value="0">-- 请选择抓取源节点 --</option>
              <option v-for="n in nodes" :key="n.id" :value="n.id">
                {{ n.is_source ? '★ [默认源] ' : '' }}{{ n.name }} (当前: {{ n.cookie_count }} 条)
              </option>
            </select>
          </div>

          <!-- 范围选择 -->
          <div class="form-block">
            <label class="block-label">分发目标范围</label>
            <div class="mode-radios-flex">
              <label :class="['radio-pill-box', manualTargetMode === 'all' ? 'radio-pill-selected' : '']">
                <input type="radio" v-model="manualTargetMode" value="all" style="display:none;">
                <span>全网在线广播 (所有目标)</span>
              </label>
              <label :class="['radio-pill-box', manualTargetMode === 'custom' ? 'radio-pill-selected' : '']">
                <input type="radio" v-model="manualTargetMode" value="custom" style="display:none;">
                <span>指定特定目标节点 (一对多)</span>
              </label>
            </div>

            <!-- 即时同步：自定义目标添加控件 -->
            <div v-if="manualTargetMode === 'custom'" class="directed-custom-box">
              <div class="custom-actions-bar">
                <div style="display:flex; gap:8px; align-items:center;">
                  <select v-model="selectedTargetToAdd" class="sync-input font-mono" style="width: auto; min-width: 200px;">
                    <option value="">-- 选择加入的目标节点 --</option>
                    <option v-for="n in candidateTargets.filter(x => !manualTargetIds.includes(x.id))" :key="n.id" :value="n.id">
                      + {{ n.name }} ({{ n.is_local ? '本地' : n.ssh_host }})
                    </option>
                  </select>
                  <button type="button" @click="addTargetToManual" class="btn-sub-action">
                    添加目标
                  </button>
                </div>
                <div style="display:flex; gap:10px;">
                  <button type="button" @click="selectAllManualTargets" class="link-btn-cyan">⚡ 全选</button>
                  <button type="button" @click="clearAllManualTargets" class="link-btn-red">清空</button>
                </div>
              </div>

              <div class="chips-container-box">
                <span v-for="tid in manualTargetIds" :key="tid" class="chip-item-pill">
                  {{ nodes.find(n => n.id === tid)?.name || tid }}
                  <span @click="removeManualTarget(tid)" class="chip-close-icon">✕</span>
                </span>
                <span v-if="manualTargetIds.length === 0" class="empty-tip-text">
                  * 尚未选择目标，点击上方下拉菜单选择并添加目标节点
                </span>
              </div>
            </div>
            <div v-else class="broadcast-notice-text">
              ✓ 广播模式：将自动下发至除了源节点之外的全部 {{ candidateTargets.length }} 个节点
            </div>
          </div>

          <div style="margin-top:6px;">
            <button @click="triggerSync(true)" :disabled="isSyncing" class="btn-sync-action">
              {{ isSyncing ? '同步中...' : '立即下发定向同步任务' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 审计列表：高规格结构化数据表格 ==================== -->
    <div class="audit-section-wrapper">
      <div class="audit-header-bar">
        <div class="audit-title-box">
          <span style="font-size:16px;">📜</span>
          <h3 class="audit-title-text">同步任务审计追踪流水</h3>
        </div>
        <button @click="loadData" class="link-btn-cyan">刷新审计</button>
      </div>

      <div class="audit-table-scroll">
        <table class="audit-data-table">
          <thead>
            <tr>
              <th style="min-width: 160px;">时间戳</th>
              <th style="min-width: 140px;">源节点</th>
              <th style="min-width: 180px;">分发目标</th>
              <th style="min-width: 110px;">Cookie 数量</th>
              <th style="min-width: 100px;">执行耗时</th>
              <th style="min-width: 90px; text-align: center;">状态</th>
              <th style="min-width: 90px; text-align: right; padding-right: 18px;">日志详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in logs" :key="l.id">
              <!-- 时间戳 -->
              <td class="font-mono text-muted">{{ l.timestamp }}</td>

              <!-- 源节点 -->
              <td>
                <span v-if="l.source_node && l.source_node.includes('智能')" class="badge-smart-source">
                  {{ l.source_node }}
                </span>
                <span v-else class="source-node-normal">
                  {{ l.source_node || '---' }}
                </span>
              </td>

              <!-- 分发目标 -->
              <td class="target-nodes-col" :title="l.target_nodes">
                {{ l.target_nodes || '---' }}
              </td>

              <!-- Cookie 数量 -->
              <td>
                <span class="cookie-stat-badge">
                  🍪 {{ l.cookie_count || 0 }} 条
                </span>
              </td>

              <!-- 执行耗时 -->
              <td class="font-mono text-duration">
                ⏱️ {{ l.duration || '0.00s' }}
              </td>

              <!-- 状态 -->
              <td style="text-align: center;">
                <span v-if="l.status==='SUCCESS'" class="status-pill-ok">● 成功</span>
                <span v-else class="status-pill-fail">✕ 失败</span>
              </td>

              <!-- 查看详情按钮 -->
              <td style="text-align: right; padding-right: 18px;">
                <button @click="viewLogDetail(l.details)" class="btn-view-detail">
                  查看详情
                </button>
              </td>
            </tr>
            <tr v-if="logs.length === 0">
              <td colspan="7" class="empty-table-cell">暂无同步任务审计流水</td>
            </tr>
          </tbody>
        </table>
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
            <button @click="showLogModal = false" class="btn-sync-action">关闭</button>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
/* ==================== SyncManager 专属自闭环样式体系 ==================== */

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

/* 双列栅格 */
.sync-cards-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 20px;
  width: 100%;
}
@media (max-width: 1050px) {
  .sync-cards-grid { grid-template-columns: 1fr; }
}

.sync-config-card {
  background: #09122a;
  border: 1px solid #172554;
  border-radius: 8px;
  padding: 16px;
}

.card-title-h3 {
  font-size: 14px;
  font-weight: bold;
  color: #ffffff;
  margin: 0 0 12px 0;
}

.card-subtitle-desc {
  font-size: 11px;
  color: #64748b;
  margin: 0 0 12px 0;
  line-height: 1.4;
}

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

.input-inline-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.unit-text {
  font-size: 12px;
  color: #94a3b8;
}

/* 输入框样式 */
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

.input-port { width: 120px !important; min-width: 90px !important; }
.input-normal { width: 100%; max-width: 420px; min-width: 220px; }

.font-mono { font-family: monospace; }
.font-cyan-mono { color: #00f0ff; font-family: monospace; font-weight: bold; }

/* 模式卡片 (智能合并 vs 主从) */
.mode-cards-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
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

.mode-header-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.mode-name-cyan {
  font-weight: bold;
  color: #38bdf8;
  font-size: 13px;
}

.mode-name-gray {
  font-weight: bold;
  color: #cbd5e1;
  font-size: 13px;
}

.mode-desc-text {
  font-size: 11px;
  color: #64748b;
  line-height: 1.5;
  margin: 0;
}

.tag-recommend {
  background: rgba(14, 165, 233, 0.2);
  border: 1px solid #0284c7;
  color: #38bdf8;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
}

/* 主从面板 */
.master-worker-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: #060b17;
  padding: 14px;
  border-radius: 6px;
  border: 1px solid #1e3a8a;
}

.panel-header-sub {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.actions-links-wrap {
  display: flex;
  gap: 10px;
}

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

.select-add-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
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

/* 胶囊容器与芯片 */
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
.chip-close-icon:hover {
  color: #ffffff;
}

.empty-tip-text {
  font-size: 11px;
  color: #64748b;
}

/* 即时同步单选药丸卡片 */
.mode-radios-flex {
  display: flex;
  gap: 10px;
  margin-bottom: 8px;
}

.radio-pill-box {
  flex: 1;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid #172554;
  text-align: center;
  cursor: pointer;
  font-size: 12px;
  color: #94a3b8;
  transition: all 0.2s;
}

.radio-pill-selected {
  border-color: #00f0ff !important;
  background: #0f1f42 !important;
  color: #38bdf8 !important;
}

.directed-custom-box {
  background: #060b17;
  border: 1px solid #172554;
  border-radius: 6px;
  padding: 10px;
}

.custom-actions-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.broadcast-notice-text {
  font-size: 11px;
  color: #38bdf8;
  padding: 4px 0;
}

/* 按钮通用渐变样式 */
.btn-sync-action {
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
.btn-sync-action:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

/* 审计列表 */
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

.source-node-normal {
  font-weight: bold;
  color: #ffffff;
  font-size: 12px;
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