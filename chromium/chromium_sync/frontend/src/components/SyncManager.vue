<script setup>
import { ref, onMounted } from 'vue'

const props = defineProps({
  api: Function,
  showToast: Function
})

const logs = ref([])
const isSyncing = ref(false)

const loadLogs = async () => {
  const res = await props.api('/api/sync/logs')
  if (res.ok) logs.value = await res.json()
}

const triggerSync = async () => {
  if (isSyncing.value) return
  isSyncing.value = true
  try {
    const res = await props.api('/api/sync/trigger', { method: 'POST' })
    const data = await res.json()
    props.showToast(data.message, 'success')
    loadLogs()
  } finally {
    isSyncing.value = false
  }
}

onMounted(() => {
  loadLogs()
})
</script>

<template>
  <div class="content-full-card">
    <div class="table-header-bar">
      <div class="table-title">
        <span class="icon-duo-users" style="color:#38bdf8;">🌐</span>
        <h2>全网 Cookie 自动同步与集群调度治理</h2>
      </div>
      <button @click="triggerSync" :disabled="isSyncing" class="btn-primary-gradient">
        {{ isSyncing ? '同步调度中...' : '⚡ 立即触发同步' }}
      </button>
    </div>

    <div class="info-banner-blue">
      <p>• 定时执行策略：后台常驻引擎每 <span style="color:#00f0ff; font-weight:bold;">15 分钟</span> 自动从默认源节点抓取最新全量 Cookies 并极速注入所有活跃目标节点。</p>
      <p>• 本地加速机制：本地直连节点跳过 SSH 隧道，直接通过 CDP WebSocket 内存注入，耗时近乎零开销。</p>
    </div>

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