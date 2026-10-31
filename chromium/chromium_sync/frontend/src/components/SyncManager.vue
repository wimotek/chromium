<script setup>
import { ref, reactive, computed, onMounted } from 'vue'

const props = defineProps({
  api: Function,
  showToast: Function
})

const logs = ref([])
const nodes = ref([])
const isSyncing = ref(false)

const syncConfig = reactive({
  sync_interval_minutes: 15,
  sync_mode: 'smart_merge', // 默认首选 smart_merge
  sync_source_id: 0,
  sync_target_ids: []
})

// 即时定向同步
const manualSourceId = ref(0)
const manualTargetMode = ref('all') // 'all' (广播全网) | 'custom' (指定特定目标)
const manualTargetIds = ref([])
const selectedTargetToAdd = ref('')

// 候选目标：排除当前选中的源节点
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

  // 核心容错：若无默认源，自适应兜底
  const defaultSrcNode = nodes.value.find(n => n.is_source === 1)
  if (defaultSrcNode) {
    manualSourceId.value = defaultSrcNode.id
    if (syncConfig.sync_source_id === 0) syncConfig.sync_source_id = defaultSrcNode.id
  } else if (nodes.value.length > 0) {
    // 没有默认源节点时，自动选取列表第 1 个作为抓取源，绝不留白
    manualSourceId.value = nodes.value[0].id
  } else {
    manualSourceId.value = 0
  }
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

const triggerSync = async (isManualDirected = false) => {
  if (isSyncing.value) return

  // 容错校验：若执行定向同步，必须有有效的源节点
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

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="content-full-card">
    <div class="table-header-bar">
      <div class="table-title">
        <span class="icon-duo-users" style="color:#38bdf8;">🌐</span>
        <h2>全网 Cookie 自动同步与集群调度治理</h2>
      </div>
      <button @click="triggerSync(false)" :disabled="isSyncing" class="btn-primary-gradient">
        {{ isSyncing ? '同步执行中...' : '⚡ 立即执行同步' }}
      </button>
    </div>

    <!-- 策略配置双列布局 -->
    <div class="grid-2col-fluid" style="margin-bottom:20px;">
      
      <!-- 左列：调度策略配置 (智能合并首选) -->
      <div style="background:#09122a; border:1px solid #172554; border-radius:8px; padding:16px;">
        <h3 class="card-inner-h3" style="margin-bottom:12px;">⚙️ 自动化调度策略</h3>
        <div class="form-v-stack">
          <div class="form-field-block">
            <label class="form-label">定时调度周期 (分钟)</label>
            <div style="display:flex; align-items:center; gap:8px;">
              <input v-model="syncConfig.sync_interval_minutes" type="number" min="1" class="cdp-input cdp-w-port font-cyan-mono">
              <span style="font-size:12px; color:#94a3b8;">分钟 / 次</span>
            </div>
          </div>

          <div class="form-field-block">
            <label class="form-label">同步模式规则 (默认首选智能合并)</label>
            <div class="form-v-stack" style="gap:10px;">
              
              <!-- 选项 1: 智能合并 (无需依赖默认源) -->
              <label :class="['sync-mode-card', syncConfig.sync_mode === 'smart_merge' ? 'sync-mode-active' : '']">
                <input type="radio" v-model="syncConfig.sync_mode" value="smart_merge" style="display:none;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <span style="font-weight:bold; color:#38bdf8;">🌟 智能全局最新值合并 (Smart Merge)</span>
                  <span class="badge-recommend">推荐默认</span>
                </div>
                <p class="sync-mode-desc">
                  自动收集各节点 Cookie 取并集；不同站点互相补齐，同名凭证比对有效期最新值自动对齐，<b>无需依赖任何固定源节点</b>。
                </p>
              </label>

              <!-- 选项 2: 主从定向模式 -->
              <label :class="['sync-mode-card', syncConfig.sync_mode === 'master_worker' ? 'sync-mode-active' : '']">
                <input type="radio" v-model="syncConfig.sync_mode" value="master_worker" style="display:none;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <span style="font-weight:bold; color:#cbd5e1;">📌 指定主节点单向广播 (Master-Worker)</span>
                </div>
                <p class="sync-mode-desc">
                  指定固定的 Master 节点，将其凭证单向覆盖至指定的从属目标节点。
                </p>
              </label>

            </div>
          </div>

          <!-- 主从模式下的参数输入 -->
          <div v-if="syncConfig.sync_mode === 'master_worker'" class="form-v-stack" style="background:#060b17; padding:12px; border-radius:6px; border:1px solid #1e3a8a;">
            <div>
              <label class="form-label">指定固定源节点 (Master)</label>
              <select v-model="syncConfig.sync_source_id" class="cdp-input cdp-w-normal font-cyan-mono">
                <option :value="0">-- 未指定固定源 (请选择) --</option>
                <option v-for="n in nodes" :key="n.id" :value="n.id">
                  {{ n.is_source ? '★ [默认源] ' : '' }}{{ n.name }} ({{ n.is_local ? '本地' : n.ssh_host }})
                </option>
              </select>
            </div>

            <div>
              <label class="form-label">分发目标节点 (勾选)</label>
              <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:6px;">
                <label v-for="n in nodes.filter(x => x.id !== syncConfig.sync_source_id)" :key="n.id" style="display:flex; align-items:center; gap:6px; font-size:12px; color:#cbd5e1; cursor:pointer;">
                  <input type="checkbox" :value="n.id" v-model="syncConfig.sync_target_ids" class="check-box-blue">
                  <span>{{ n.name }}</span>
                </label>
              </div>
            </div>
          </div>

          <div style="margin-top:4px;">
            <button @click="saveSyncPolicy" class="btn-primary-gradient">保存调度策略</button>
          </div>
        </div>
      </div>

      <!-- 右列：即时定向同步执行器 (防空白自适应) -->
      <div style="background:#09122a; border:1px solid #172554; border-radius:8px; padding:16px;">
        <h3 class="card-inner-h3" style="margin-bottom:6px;">🎯 即时定向同步 (按需临时执行)</h3>
        <p style="font-size:11px; color:#64748b; margin-bottom:12px;">临时指定任意源节点，并将凭证批量推送到指定的单个或多个目标节点。</p>
        
        <div class="form-v-stack">
          <!-- 选择源节点：包含占位提示与星标指示 -->
          <div class="form-field-block">
            <label class="form-label">选择抓取凭据的源节点 (Source)</label>
            <select v-model="manualSourceId" class="cdp-input cdp-w-normal font-cyan-mono">
              <option :value="0">-- 请选择抓取源节点 --</option>
              <option v-for="n in nodes" :key="n.id" :value="n.id">
                {{ n.is_source ? '★ [默认源] ' : '' }}{{ n.name }} (当前: {{ n.cookie_count }} 条)
              </option>
            </select>
          </div>

          <div class="form-field-block">
            <label class="form-label">分发目标范围</label>
            <div style="display:flex; gap:10px; margin-bottom:8px;">
              <label :class="['radio-pill-card', manualTargetMode === 'all' ? 'radio-pill-active' : '']" style="padding:6px 12px;">
                <input type="radio" v-model="manualTargetMode" value="all" style="display:none;">
                <span>全网在线广播 (所有目标)</span>
              </label>
              <label :class="['radio-pill-card', manualTargetMode === 'custom' ? 'radio-pill-active' : '']" style="padding:6px 12px;">
                <input type="radio" v-model="manualTargetMode" value="custom" style="display:none;">
                <span>指定特定目标节点 (一对多)</span>
              </label>
            </div>

            <!-- 自定义目标添加控件 -->
            <div v-if="manualTargetMode === 'custom'" style="background:#060b17; border:1px solid #172554; border-radius:6px; padding:10px;">
              <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
                <select v-model="selectedTargetToAdd" class="cdp-input font-cyan-mono" style="width: auto; min-width: 220px;">
                  <option value="">-- 选择加入的目标节点 --</option>
                  <option v-for="n in candidateTargets.filter(x => !manualTargetIds.includes(x.id))" :key="n.id" :value="n.id">
                    + {{ n.name }} ({{ n.is_local ? '本地' : n.ssh_host }})
                  </option>
                </select>
                <button type="button" @click="addTargetToManual" class="btn-gray-test" style="height:32px; padding:4px 12px;">
                  添加目标
                </button>
              </div>

              <div style="display:flex; gap:8px; flex-wrap:wrap; min-height:28px; align-items:center;">
                <span v-for="tid in manualTargetIds" :key="tid" class="target-chip">
                  {{ nodes.find(n => n.id === tid)?.name || tid }}
                  <span @click="removeManualTarget(tid)" class="chip-del-x">✕</span>
                </span>
                <span v-if="manualTargetIds.length === 0" style="font-size:11px; color:#64748b;">
                  * 尚未选择目标，点击上方下拉菜单选择并添加目标节点
                </span>
              </div>
            </div>
            <div v-else style="font-size:11px; color:#38bdf8; padding:4px 0;">
              ✓ 广播模式：将自动下发至除了源节点之外的全部 {{ candidateTargets.length }} 个节点
            </div>
          </div>

          <div style="margin-top:6px;">
            <button @click="triggerSync(true)" :disabled="isSyncing" class="btn-primary-gradient">
              {{ isSyncing ? '同步中...' : '立即下发定向同步任务' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 调度审计追踪日志 -->
    <div style="margin-top:20px;">
      <h3 style="font-size:13px; font-weight:bold; color:#cbd5e1; margin-bottom:8px;">调度审计追踪事件：</h3>
      <div class="console-box">
        <div v-for="l in logs" :key="l.id" class="console-item">
          <div class="console-meta">
            <span>[{{ l.timestamp }}]</span>
            <span :style="{ color: l.status==='SUCCESS' ? '#34d399' : '#f87171', fontWeight: 'bold' }">[{{ l.status }}]</span>
          </div>
          <pre class="console-pre">{{ l.details }}</pre>
        </div>
        <div v-if="logs.length === 0" style="text-align:center; color:#64748b; padding:40px;">暂无调度事件</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sync-mode-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: #060b17;
  border: 1px solid #172554;
  border-radius: 6px;
  padding: 10px 14px;
  cursor: pointer;
  transition: all 0.2s;
}
.sync-mode-card:hover {
  border-color: #1e3a8a;
}
.sync-mode-active {
  border-color: #00f0ff !important;
  background: #091a38 !important;
}

.sync-mode-desc {
  font-size: 11px;
  color: #64748b;
  line-height: 1.5;
  margin: 0;
}

.badge-recommend {
  background: rgba(14, 165, 233, 0.2);
  border: 1px solid #0284c7;
  color: #38bdf8;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
}

.target-chip {
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
.chip-del-x {
  cursor: pointer;
  color: #f87171;
  font-weight: bold;
}
.chip-del-x:hover {
  color: #ffffff;
}
</style>