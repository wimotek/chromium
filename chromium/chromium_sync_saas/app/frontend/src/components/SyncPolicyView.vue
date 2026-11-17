<template>
  <div>
    <div class="banner banner-info">
      <strong>多租户与共享节点隔离保障：</strong>您的 Cookie 同步策略仅作用于【您名下自有】在线节点；任何正在市场出租中的节点都会自动从 Cookie 同步周期中豁免隔离，既防个人隐私外泄也防污染买家会话。
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">
          <span>我的 Cookie 同步策略</span>
          <button class="btn btn-sm btn-primary" @click="createPolicy">+ 新建默认合并策略</button>
        </div>
        <div v-if="policies.length === 0" class="muted">暂无同步策略，点击右上角创建。</div>
        <div v-for="p in policies" :key="p.id" style="border-bottom: 1px solid var(--border); padding: 10px 0">
          <div class="row" style="justify-content: space-between">
            <div>
              <strong>{{ p.name }}</strong>
              <span class="tag" style="margin-left: 6px">{{ p.sync_type }}</span>
              <span class="tag" :class="p.enabled ? 'tag-ok' : 'tag-warn'" style="margin-left: 6px">{{ p.enabled ? '启用' : '暂停' }}</span>
            </div>
            <div class="row">
              <button class="btn btn-sm btn-emerald" @click="runPolicy(p.id)">立即同步</button>
              <button class="btn btn-sm" @click="togglePolicy(p.id)">启停</button>
            </div>
          </div>
          <div class="muted" style="font-size: 12px; margin-top: 4px">
            周期: {{ p.interval_minutes }} 分钟 · 最近运行: {{ p.last_run || '尚未运行' }}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">最近同步执行流水（仅本租户可见）</div>
        <div v-if="logs.length === 0" class="muted">暂无同步记录。</div>
        <div v-else style="max-height: 320px; overflow-y: auto">
          <div v-for="l in logs" :key="l.id" style="border-bottom: 1px solid var(--border); padding: 8px 0">
            <div class="row" style="justify-content: space-between">
              <span class="mono">{{ l.timestamp }}</span>
              <span class="tag" :class="l.status === 'SUCCESS' ? 'tag-ok' : l.status === 'FAILED' ? 'tag-danger' : 'tag-warn'">{{ l.status }}</span>
            </div>
            <div class="muted" style="font-size: 12px; white-space: pre-wrap; margin-top: 4px">{{ l.details }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { apiFetch } from '../api'

const emit = defineEmits(['notify'])
const policies = ref([])
const logs = ref([])

async function loadAll() {
  try {
    const [p, l] = await Promise.all([
      apiFetch('/api/sync/policies'),
      apiFetch('/api/sync/logs'),
    ])
    policies.value = p
    logs.value = l
  } catch (e) {
    emit('notify', e.message)
  }
}

async function createPolicy() {
  const name = prompt('请输入同步策略名称：', '办公节点智能双向同步')
  if (!name) return
  try {
    await apiFetch('/api/sync/policies', {
      method: 'POST',
      body: JSON.stringify({ name, interval_minutes: 15, sync_type: 'smart_merge' }),
    })
    emit('notify', '策略已创建')
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function runPolicy(id) {
  try {
    const res = await apiFetch(`/api/sync/policies/${id}/run`, { method: 'POST' })
    emit('notify', res.message)
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function togglePolicy(id) {
  try {
    await apiFetch(`/api/sync/policies/${id}/toggle`, { method: 'POST' })
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  }
}

onMounted(loadAll)
</script>
