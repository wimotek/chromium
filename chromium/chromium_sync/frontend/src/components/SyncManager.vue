<script setup>
import { ref, reactive, computed, onMounted } from 'vue'

const props = defineProps({
  api: Function,
  showToast: Function
})

const logs = ref([])
const nodes = ref([])
const isSyncing = ref(false)

// 同步策略配置
const syncConfig = reactive({
  sync_interval_minutes: 15,
  sync_mode: 'auto_all', // 'auto_all' | 'custom_targets'
  sync_source_id: 0,
  sync_target_ids: []
})

// 即时定向同步
const manualSourceId = ref(0)
const manualTargetMode = ref('all') // 'all' (广播全网) | 'custom' (指定特定目标)
const manualTargetIds = ref([])
const selectedTargetToAdd = ref('')

// 可选候选目标节点（排除当前选中的源节点）
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

  if (syncConfig.sync_source_id === 0 && nodes.value.length > 0) {
    const src = nodes.value.find(n => n.is_source === 1) || nodes.value[0]
    syncConfig.sync_source_id = src.id
    manualSourceId.value = src.id
  } else {
    manualSourceId.value = syncConfig.sync_source_id
  }
}

const saveSyncPolicy = async () => {
  const res = await props.api('/api/sync/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(syncConfig)
  })
  if (res.ok) {
    props.showToast('同步策略与周期配置已生效', 'success')
  }
}

// 添加目标节点到勾选队列
const addTargetToManual = () => {
  const id = parseInt(selectedTargetToAdd.value)
  if (id && !manualTargetIds.value.includes(id)) {
    manualTargetIds.value.push(id)
  }
  selectedTargetToAdd.value = ''
}

// 从勾选队列移除节点
const removeManualTarget = (id) => {
  manualTargetIds.value = manualTargetIds.value.filter(x => x !== id)
}

// 触发即时同步 (支持一对多)
const triggerCustomSync = async () => {
  if (isSyncing.value) return
  isSyncing.value = true
  try {
    const payload = {}
    if (manualSourceId.value > 0) payload.source_id = manualSourceId.value
    
    // 如果选择自定义模式且指定了目标节点
    if (manualTargetMode.value === 'custom' && manualTargetIds.value.length > 0) {
      payload.target_ids = manualTargetIds.value
    }

    const res = await props.api('/api/sync/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const data = await res.json()
    props.showToast(data.message, 'success')

    // 刷新日志
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
      <button @click="triggerCustomSync" :disabled="isSyncing" class="btn-primary-gradient">
        {{ isSyncing ? '同步执行中...' : '⚡ 立即执行同步' }}
      </button>
    </div>

    <!-- 策略配置双列栅格 -->
    <div class="grid-2col-fluid" style="margin-bottom:20px;">
      
      <!-- 左列: 定时调度自动化策略 -->
      <div style="background:#09122a; border:1px solid #172554; border-radius:8px; padding:16px;">
        <h3 class="card-inner-h3" style="margin-bottom:12px;">⚙️ 自动化定时分发规则</h3>
        <div class="form-v-stack">
          <div class="form-field-block">
            <label class="form-label">定时调度周期 (分钟)</label>
            <div style="display:flex; align-items:center; gap:8px;">
              <input v-model="syncConfig.sync_interval_minutes" type="number" min="1" class="cdp-input cdp-w-port font-cyan-mono">
              <span style="font-size:12px; color:#94a3b8;">分钟/次</span>
            </div>
          </div>

          <div class="form-field-block">
            <label class="form-label">自动同步分发模式</label>
            <div class="row-flex-gap">
              <label :class="['radio-pill-card', syncConfig.sync_mode === 'auto_all' ? 'radio-pill-active' : '']">
                <input type="radio" v-model="syncConfig.sync_mode" value="auto_all" style="display:none;">
                <span>全网自动同步 (默认源 -> 所有在线节点)</span>
              </label>
              <label :class="['radio-pill-card', syncConfig.sync_mode === 'custom_targets' ? 'radio-pill-active' : '']">
                <input type="radio" v-model="syncConfig.sync_mode" value="custom_targets" style="display:none;">
                <span>固定源节点一对多同步</span>
              </label>
            </div>
          </div>

          <!-- 指定源与多目标配置 -->
          <div v-if="syncConfig.sync_mode === 'custom_targets'" class="form-v-stack" style="background:#060b17; padding:12px; border-radius:6px; border:1px solid #1e3a8a;">
            <div>
              <label class="form-label">固定源节点</label>
              <select v-model="syncConfig.sync_source_id" class="cdp-input cdp-w-normal font-cyan-mono">
                <option v-for="n in nodes" :key="n.id" :value="n.id">{{ n.name }} ({{ n.is_local ? '本地' : n.ssh_host }})</option>
              </select>
            </div>

            <div>
              <label class="form-label">勾选同步目标节点 (一对多)</label>
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

      <!-- 右列: 即时定向同步执行器 (输入控件完全可见、可控) -->
      <div style="background:#09122a; border:1px solid #172554; border-radius:8px; padding:16px;">
        <h3 class="card-inner-h3" style="margin-bottom:6px;">🎯 即时定向同步 (按需一对多执行)</h3>
        <p style="font-size:11px; color:#64748b; margin-bottom:12px;">抓取指定源节点凭证，并在本轮下发给指定的单个或多个目标节点。</p>
        
        <div class="form-v-stack">
          <!-- 选择源节点 -->
          <div class="form-field-block">
            <label class="form-label">选择抓取凭据的源节点 (Source)</label>
            <select v-model="manualSourceId" class="cdp-input cdp-w-normal font-cyan-mono">
              <option v-for="n in nodes" :key="n.id" :value="n.id">{{ n.name }} (当前: {{ n.cookie_count }} 条)</option>
            </select>
          </div>

          <!-- 选择目标模式 -->
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

            <!-- 自定义目标节点选择器：输入框 + 下拉选择 + 标签删除 -->
            <div v-if="manualTargetMode === 'custom'" style="background:#060b17; border:1px solid #172554; border-radius:6px; padding:10px;">
              <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
                <select v-model="selectedTargetToAdd" class="cdp-input font-cyan-mono" style="width: auto; min-width: 220px;">
                  <option value="">-- 选择要加入的目标节点 --</option>
                  <option v-for="n in candidateTargets.filter(x => !manualTargetIds.includes(x.id))" :key="n.id" :value="n.id">
                    + {{ n.name }} ({{ n.is_local ? '本地' : n.ssh_host }})
                  </option>
                </select>
                <button type="button" @click="addTargetToManual" class="btn-gray-test" style="height:32px; padding:4px 12px;">
                  添加目标
                </button>
              </div>

              <!-- 已选节点标签展示 -->
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
            <button @click="triggerCustomSync" :disabled="isSyncing" class="btn-primary-gradient">
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