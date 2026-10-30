<script setup>
import { ref, reactive, onMounted } from 'vue'

const props = defineProps({
  api: Function,
  showToast: Function
})
const emit = defineEmits(['update-nodes'])

const nodes = ref([])
const keys = ref([])
const showNodeModal = ref(false)

const newNode = reactive({
  name: '',
  is_local: true,
  ssh_host: '',
  ssh_port: 22,
  ssh_user: 'root',
  ssh_key_filename: '',
  ssh_password: '',
  remote_cdp_port: 9222,
  local_bind_port: 9222
})

const loadNodes = async () => {
  const [nRes, kRes] = await Promise.all([
    props.api('/api/nodes'),
    props.api('/api/ssh-keys')
  ])
  nodes.value = await nRes.json()
  keys.value = await kRes.json()
  emit('update-nodes')
}

const probeNode = async (node) => {
  const res = await props.api(`/api/nodes/${node.id}/probe`, { method: 'POST' })
  const data = await res.json()
  if (res.ok) {
    node.cookie_count = data.cookie_count
    node.status = 'connected'
    props.showToast(data.message, 'success')
  } else {
    node.status = 'error: refused'
    props.showToast(data.detail || '探针未响应', 'error')
  }
}

const toggleTunnel = async (node) => {
  const res = await props.api(`/api/nodes/${node.id}/toggle-tunnel`, { method: 'POST' })
  const data = await res.json()
  if (res.ok) {
    props.showToast(data.message, 'success')
  } else {
    props.showToast(data.detail || '连接异常', 'error')
  }
  loadNodes()
}

const setSource = async (id) => {
  await props.api(`/api/nodes/${id}/set-source`, { method: 'POST' })
  props.showToast('已设为全网同步源节点', 'success')
  loadNodes()
}

const deleteNode = async (id) => {
  if (confirm('确认销毁该 CDP 节点的接入配置？')) {
    await props.api(`/api/nodes/${id}`, { method: 'DELETE' })
    props.showToast('节点已移除', 'success')
    loadNodes()
  }
}

const createNode = async () => {
  const res = await props.api('/api/nodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newNode)
  })
  const data = await res.json()
  showNodeModal.value = false
  props.showToast(data.message, 'success')
  newNode.name = ''
  newNode.ssh_host = ''
  newNode.local_bind_port += 1
  loadNodes()
}

onMounted(() => {
  loadNodes()
})
</script>

<template>
  <div class="content-full-card">
    <div class="table-header-bar">
      <div class="table-title">
        <span class="icon-duo-users">👥</span>
        <h2>CDP 节点实例治理列表</h2>
      </div>
      <div style="display:flex; gap:10px;">
        <button @click="showNodeModal = true" class="btn-primary-gradient">+ 新增接入节点</button>
        <button @click="loadNodes" class="btn-primary-gradient">🔄 刷新数据</button>
      </div>
    </div>

    <div class="table-responsive">
      <table class="cdp-fluid-table">
        <thead>
          <tr>
            <th style="width: 22%;">节点名称 / 接入目标</th>
            <th style="width: 10%;">连通状态</th>
            <th style="width: 14%;">本地调试 / 映射端口</th>
            <th style="width: 14%;">Cookie 实时存量</th>
            <th style="width: 12%;">接入类型</th>
            <th style="width: 12%;">同步角色</th>
            <th style="width: 16%; text-align: right;">治理操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="node in nodes" :key="node.id">
            <td>
              <div class="cell-main-name">{{ node.name }}</div>
              <div class="cell-sub-desc">
                {{ node.is_local ? '127.0.0.1 (本机调试端口)' : `${node.ssh_user}@${node.ssh_host}:${node.ssh_port}` }}
              </div>
            </td>

            <td>
              <span v-if="node.status === 'connected'" class="status-active">● 活跃</span>
              <span v-else-if="node.status === 'stopped'" class="status-standby">○ 离线</span>
              <span v-else class="status-error" :title="node.status">✕ 异常</span>
            </td>

            <td class="font-cyan-mono">127.0.0.1:{{ node.local_bind_port }}</td>

            <td>
              <div class="cookie-badge">
                <span>🍪 {{ node.cookie_count || 0 }} 条</span>
                <button @click="probeNode(node)" class="link-probe">刷新</button>
              </div>
            </td>

            <td>
              <span v-if="node.is_local" class="tag-plan-blue">普通固定 (本地)</span>
              <span v-else class="tag-plan-indigo">SSH 穿透 (远程)</span>
            </td>

            <td>
              <button v-if="node.is_source" class="btn-qrcode">★ 默认源节点</button>
              <button v-else @click="setSource(node.id)" class="btn-set-source">设为源</button>
            </td>

            <td style="text-align: right;">
              <div class="btn-group-row">
                <button @click="toggleTunnel(node)" class="btn-micro btn-orange">
                  🔑 {{ node.is_local ? '测试连通' : (node.status === 'connected' ? '断开' : '穿透') }}
                </button>
                <button @click="probeNode(node)" class="btn-micro btn-purple">🔀 探针</button>
                <button @click="deleteNode(node.id)" class="btn-micro btn-trash">🗑️</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 弹窗：新增节点 -->
    <div v-if="showNodeModal" class="modal-backdrop">
      <div class="modal-card">
        <div class="modal-title-bar">
          <h3 style="font-size:14px; font-weight:bold; color:#fff;">接入新 CDP 实例节点</h3>
          <button @click="showNodeModal = false" style="background:none; border:none; color:#94a3b8; font-size:16px; cursor:pointer;">✕</button>
        </div>

        <form @submit.prevent="createNode" class="form-v-stack" style="margin-top:14px;">
          <div>
            <label class="form-label">接入类型</label>
            <div class="row-flex-gap">
              <label :class="['radio-pill-card', newNode.is_local ? 'radio-pill-active' : '']">
                <input type="radio" v-model="newNode.is_local" :value="true" style="display:none;">
                <span>💻 本地直连 (免SSH)</span>
              </label>
              <label :class="['radio-pill-card', !newNode.is_local ? 'radio-pill-active' : '']">
                <input type="radio" v-model="newNode.is_local" :value="false" style="display:none;">
                <span>🌐 远程 SSH 穿透</span>
              </label>
            </div>
          </div>

          <div>
            <label class="form-label">节点名称</label>
            <input v-model="newNode.name" required placeholder="如: 本机 Chrome 01" class="cdp-input">
          </div>

          <div v-if="newNode.is_local" style="background:#09122a; padding:12px; border-radius:6px; border:1px solid #172554;">
            <label class="form-label">本地 CDP 调试端口 (默认 9222)</label>
            <input v-model="newNode.local_bind_port" type="number" required placeholder="9222" class="cdp-input font-cyan-mono">
            <p style="font-size:11px; color:#64748b; margin-top:6px;">直接接入宿主机/本机 Chromium 调试端口，系统自动寻找宿主网关，无需配置 SSH。</p>
          </div>

          <div v-else class="form-v-stack">
            <div class="row-flex-gap">
              <div style="flex:1;">
                <label class="form-label">SSH 主机 / IP</label>
                <input v-model="newNode.ssh_host" required placeholder="192.168.1.100" class="cdp-input" style="font-family:monospace;">
              </div>
              <div style="flex:1;">
                <label class="form-label">SSH 端口</label>
                <input v-model="newNode.ssh_port" type="number" placeholder="22" class="cdp-input font-cyan-mono">
              </div>
            </div>

            <div>
              <label class="form-label">SSH 用户名</label>
              <input v-model="newNode.ssh_user" required placeholder="root" class="cdp-input" style="font-family:monospace;">
            </div>

            <div>
              <label class="form-label">绑定 SSH 证书 (选填)</label>
              <select v-model="newNode.ssh_key_filename" class="cdp-input" style="font-family:monospace;">
                <option value="">密码认证 (不选择私钥)</option>
                <option v-for="k in keys" :key="k.filename" :value="k.filename">🔑 {{ k.filename }}</option>
              </select>
            </div>

            <div v-if="!newNode.ssh_key_filename">
              <label class="form-label">SSH 密码</label>
              <input v-model="newNode.ssh_password" type="password" placeholder="••••••••" class="cdp-input">
            </div>

            <div class="row-flex-gap">
              <div style="flex:1;">
                <label class="form-label">远程 CDP 端口</label>
                <input v-model="newNode.remote_cdp_port" type="number" placeholder="9222" class="cdp-input font-cyan-mono">
              </div>
              <div style="flex:1;">
                <label class="form-label">本地穿透绑定端口</label>
                <input v-model="newNode.local_bind_port" type="number" required placeholder="19222" class="cdp-input font-cyan-mono">
              </div>
            </div>
          </div>

          <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:16px;">
            <button type="button" @click="showNodeModal = false" class="btn-set-source" style="padding:6px 14px;">取消</button>
            <button type="submit" class="btn-primary-gradient">保存节点</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>