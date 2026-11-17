<template>
  <div class="card">
    <div class="card-title">
      <span>不可篡改严苛审计流水（视图范围：{{ scope === 'global' ? '全局全租户' : '当前个人租户' }}）</span>
      <div class="row">
        <select class="select" style="width: 150px" v-model="statusFilter" @change="load">
          <option value="">全部结果</option>
          <option value="ok">成功 (ok)</option>
          <option value="deny">风控拦截 (deny)</option>
          <option value="error">异常 (error)</option>
        </select>
        <input class="input" style="width: 180px" v-model="actionFilter" placeholder="按 action 过滤" @keyup.enter="load" />
        <button class="btn btn-sm" @click="load">筛选</button>
        <button class="btn btn-sm btn-primary" @click="exportJsonl">导出 JSONL</button>
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID / 时间</th>
            <th>操作者</th>
            <th>动作 (action)</th>
            <th>目标</th>
            <th>来源 IP</th>
            <th>状态</th>
            <th>明细</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in logs" :key="r.id">
            <td class="mono">#{{ r.id }}<br />{{ r.created_at }}</td>
            <td class="mono">{{ r.actor_username }} (uid={{ r.actor_id ?? '-' }})</td>
            <td class="mono"><strong>{{ r.action }}</strong></td>
            <td class="mono">{{ r.target_type }}:{{ r.target_id }}</td>
            <td class="mono">{{ r.ip }}</td>
            <td>
              <span class="tag" :class="r.status === 'ok' ? 'tag-ok' : r.status === 'deny' ? 'tag-danger' : 'tag-warn'">
                {{ r.status }}
              </span>
            </td>
            <td class="mono muted" style="max-width: 340px; word-break: break-all">{{ r.detail_json }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { apiFetch } from '../api'

const emit = defineEmits(['notify'])
const logs = ref([])
const scope = ref('tenant')
const statusFilter = ref('')
const actionFilter = ref('')

async function load() {
  try {
    const qs = new URLSearchParams()
    if (statusFilter.value) qs.set('status', statusFilter.value)
    if (actionFilter.value.trim()) qs.set('action', actionFilter.value.trim())
    const res = await apiFetch(`/api/audit/logs?${qs.toString()}`)
    logs.value = res.logs || []
    scope.value = res.scope || 'tenant'
  } catch (e) {
    emit('notify', e.message)
  }
}

async function exportJsonl() {
  const token = localStorage.getItem('saas_token') || ''
  const res = await fetch('/api/audit/export', { headers: { Authorization: `Bearer ${token}` } })
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'saas-audit-logs.jsonl'
  a.click()
  URL.revokeObjectURL(url)
}

onMounted(load)
</script>
