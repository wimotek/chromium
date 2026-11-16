<template>
  <div>
    <div class="banner banner-info">
      <strong>多租户与共享节点隔离保障：</strong>您的同步策略、云端收藏夹与 SSH 密钥仅作用于【您名下自有】节点；任何正在市场出租中的节点都会自动从 Cookie 同步/清理周期中豁免隔离，既防个人隐私外泄也防污染买家会话。
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">
          <span>我的同步策略</span>
          <button class="btn btn-sm btn-primary" @click="createPolicy">+ 新建默认合并策略</button>
        </div>
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
        <div v-else style="max-height: 260px; overflow-y: auto">
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

    <div class="grid-2">
      <div class="card">
        <div class="card-title">
          <span>我的云端联动收藏夹（同步至自有在线节点）</span>
          <div class="row">
            <button class="btn btn-sm" @click="importDefaults">导入常用站点</button>
            <button class="btn btn-sm btn-primary" @click="pushAllBookmarks">全量下发</button>
          </div>
        </div>
        <div class="row" style="margin-bottom: 10px">
          <input class="input" style="flex: 1" v-model="bmForm.title" placeholder="标题" />
          <input class="input" style="flex: 2" v-model="bmForm.url" placeholder="https://example.com" />
          <button class="btn btn-sm btn-primary" @click="addBookmark">添加</button>
        </div>
        <div v-for="b in bookmarks" :key="b.id" class="row" style="justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border)">
          <div>
            <strong>{{ b.title }}</strong> <span class="muted mono">{{ b.url }}</span>
          </div>
          <button class="btn btn-sm btn-danger" @click="delBookmark(b.id)">删除</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">我的租户隔离 SSH 私钥库</div>
        <div class="row" style="margin-bottom: 12px">
          <input type="file" ref="fileInput" style="flex: 1" />
          <input class="input" style="width: 140px" v-model="keyRemark" placeholder="备注名称" />
          <button class="btn btn-sm btn-primary" @click="uploadKey">上传私钥</button>
        </div>
        <div v-if="keys.length === 0" class="muted">暂无上传的 SSH 私钥。</div>
        <div v-for="k in keys" :key="k.id" class="row" style="justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border)">
          <div>
            <strong>{{ k.name }}</strong> <span class="muted mono">{{ k.fingerprint }}</span>
          </div>
          <button class="btn btn-sm btn-danger" @click="delKey(k.id)">销毁</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { apiFetch } from '../api'

const emit = defineEmits(['notify'])
const policies = ref([])
const logs = ref([])
const bookmarks = ref([])
const keys = ref([])
const fileInput = ref(null)
const keyRemark = ref('')
const bmForm = reactive({ title: '', url: '', folder: '常用站点' })

async function loadAll() {
  try {
    const [p, l, b, k] = await Promise.all([
      apiFetch('/api/sync/policies'),
      apiFetch('/api/sync/logs'),
      apiFetch('/api/bookmarks'),
      apiFetch('/api/ssh-keys'),
    ])
    policies.value = p
    logs.value = l
    bookmarks.value = b.bookmarks || []
    keys.value = k
  } catch (e) {
    emit('notify', e.message)
  }
}

async function createPolicy() {
  const name = prompt('请输入同步策略名称：', '办公节点智能双向同步')
  if (!name) return
  await apiFetch('/api/sync/policies', {
    method: 'POST',
    body: JSON.stringify({ name, interval_minutes: 15, sync_type: 'smart_merge' }),
  })
  emit('notify', '策略已创建')
  await loadAll()
}

async function runPolicy(id) {
  const res = await apiFetch(`/api/sync/policies/${id}/run`, { method: 'POST' })
  emit('notify', res.message)
  await loadAll()
}

async function togglePolicy(id) {
  await apiFetch(`/api/sync/policies/${id}/toggle`, { method: 'POST' })
  await loadAll()
}

async function addBookmark() {
  if (!bmForm.url) return
  const res = await apiFetch('/api/bookmarks', { method: 'POST', body: JSON.stringify(bmForm) })
  bmForm.title = ''
  bmForm.url = ''
  emit('notify', res.message)
  await loadAll()
}

async function delBookmark(id) {
  await apiFetch(`/api/bookmarks/${id}`, { method: 'DELETE' })
  await loadAll()
}

async function importDefaults() {
  const res = await apiFetch('/api/bookmarks/import-defaults', { method: 'POST' })
  emit('notify', res.message)
  await loadAll()
}

async function pushAllBookmarks() {
  const res = await apiFetch('/api/bookmarks/push-all', { method: 'POST' })
  emit('notify', res.message)
}

async function uploadKey() {
  const f = fileInput.value?.files?.[0]
  if (!f) return emit('notify', '请先选择私钥文件')
  const fd = new FormData()
  fd.append('file', f)
  fd.append('remark', keyRemark.value)
  const res = await apiFetch('/api/ssh-keys', { method: 'POST', body: fd })
  keyRemark.value = ''
  emit('notify', res.message)
  await loadAll()
}

async function delKey(id) {
  await apiFetch(`/api/ssh-keys/${id}`, { method: 'DELETE' })
  emit('notify', '密钥已销毁')
  await loadAll()
}

onMounted(loadAll)
</script>
