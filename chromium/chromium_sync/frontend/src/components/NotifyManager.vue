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
const isEditMode = ref(false)
const editingNodeId = ref(null)

// Cookie 失效详情抽屉
const showCookieModal = ref(false)
const cookieDetails = ref({ node_name: '', total: 0, valid_count: 0, session_count: 0, expired_count: 0, cookies: [] })
const isLoadingCookies = ref(false)

const nodeForm = reactive({
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

const openCreateModal = () => {
  isEditMode.value = false
  editingNodeId.value = null
  Object.assign(nodeForm, {
    name: '',
    is_local: true,
    ssh_host: '',
    ssh_port: 22,
    ssh_user: 'root',
    ssh_key_filename: '',
    ssh_password: '',
    remote_cdp_port: 9222,
    local_bind_port: 9222 + nodes.value.length
  })
  showNodeModal.value = true
}

const openEditModal = (node) => {
  isEditMode.value = true
  editingNodeId.value = node.id
  Object.assign(nodeForm, {
    name: node.name,
    is_local: Boolean(node.is_local),
    ssh_host: node.ssh_host,
    ssh_port: node.ssh_port,
    ssh_user: node.ssh_user,
    ssh_key_filename: node.ssh_key_filename,
    ssh_password: node.ssh_password,
    remote_cdp_port: node.remote_cdp_port,
    local_bind_port: node.local_bind_port
  })
  showNodeModal.value = true
}

const submitNodeForm = async () => {
  const url = isEditMode.value ? `/api/nodes/${editingNodeId.value}` : '/api/nodes'
  const method = isEditMode.value ? 'PUT' : 'POST'
  const res = await props.api(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nodeForm)
  })
  const data = await res.json()
  showNodeModal.value = false
  props.showToast(data.message, 'success')
  loadNodes()
}

const viewCookieDetails = async (node) => {
  isLoadingCookies.value = true
  showCookieModal.value = true
  try {
    const res = await props.api(`/api/nodes/${node.id}/cookie-details`)
    if (res.ok) {
      cookieDetails.value = await res.json()
    } else {
      const err = await res.json()
      props.showToast(err.detail || '读取 Cookie 详情受阻', 'error')
      showCookieModal.value = false
    }
  } finally {
    isLoadingCookies.value = false
  }
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
    props.showToast(data.detail || '探针未就绪', 'error')
  }
}

const toggleTunnel = async (node) => {
  const res = await props.api(`/api/nodes/${node.id}/toggle-tunnel`, { method: 'POST' })
  const data = await res.json()
  if (res.ok) props.showToast(data.message, 'success')
  else props.showToast(data.detail || '操作异常', 'error')
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
        <button @click="openCreateModal" class="btn-primary-gradient">+ 新增接入节点</button>
        <button @click="loadNodes" class="btn-primary-gradient">🔄 刷新列表</button>
      </div>
    </div>

    <div class="table-responsive">
      <table class="cdp-fluid-table">
        <thead>
          <tr>
            <th style="width: 20%;">节点名称 / 接入目标</th>
            <th style="width: 10%;">连通状态</th>
            <th style="width: 12%;">本地调试端口</th>
            <th style="width: 16%;">实时 Cookie (点击查看失效分析)</th>
            <th style="width: 12%;">接入类型</th>
            <th style="width: 10%;">同步角色</th>
            <th style="width: 20%; text-align: right;">治理操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="node in nodes" :key="node.id">
            <td>
              <div class="cell-main-name">{{ node.name }}</div>
              <div class="cell-sub-desc">
                {{ node.is_local ? '127.0.0.1 (本机回环)' : `${node.ssh_user}@${node.ssh_host}:${node.ssh_port}` }}
              </div>
            </td>

            <td>
              <span v-if="node.status === 'connected'" class="status-active">● 活跃</span>
              <span v-else-if="node.status === 'stopped'" class="status-standby">○ 离线</span>
              <span v-else class="status-error" :title="node.status">✕ 异常</span>
            </td>

            <td class="font-cyan-mono">127.0.0.1:{{ node.local_bind_port }}</td>

            <td>
              <!-- 点击 Cookie 胶囊，查看失效与健康度详情 -->
              <div class="cookie-badge" @click="viewCookieDetails(node)" style="cursor:pointer;" title="点击查看 Cookie 详细过期信息">
                <span>🍪 {{ node.cookie_count || 0 }} 条</span>
                <span style="font-size:10px; color:#38bdf8; text-decoration:underline; margin-left:4px;">详情</span>
              </div>
            </td>

            <td>
              <span v-if="node.is_local" class="tag-plan-blue">普通固定 (本地)</span>
              <span v-else class="tag-plan-indigo">SSH 穿透 (远程)</span>
            </td>

            <td>
              <button v-if="node.is_source" class="btn-qrcode">★ 默认源</button>
              <button v-else @click="setSource(node.id)" class="btn-set-source">设为源</button>
            </td>

            <td style="text-align: right;">
              <div class="btn-group-row">
                <button @click="toggleTunnel(node)" class="btn-micro btn-orange">
                  🔑 {{ node.is_local ? '测试连通' : (node.status === 'connected' ? '断开' : '穿透') }}
                </button>
                <button @click="probeNode(node)" class="btn-micro btn-purple">🔀 探针</button>
                <button @click="openEditModal(node)" class="btn-micro" style="background:#2563eb;">✏️ 修改</button>
                <button @click="deleteNode(node.id)" class="btn-micro btn-trash">🗑️</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 弹窗 1：新增 / 编辑节点 -->
    <div v-if="showNodeModal" class="modal-backdrop">
      <div class="modal-card">
        <div class="modal-title-bar">
          <h3 style="font-size:14px; font-weight:bold; color:#fff;">
            {{ isEditMode ? '修改 CDP 实例配置' : '接入新 CDP 实例节点' }}
          </h3>
          <button @click="showNodeModal = false" style="background:none; border:none; color:#94a3b8; font-size:16px; cursor:pointer;">✕</button>
        </div>

        <form @submit.prevent="submitNodeForm" class="form-v-stack" style="margin-top:14px;">
          <div class="form-field-block">
            <label class="form-label">接入类型</label>
            <div class="row-flex-gap">
              <label :class="['radio-pill-card', nodeForm.is_local ? 'radio-pill-active' : '']">
                <input type="radio" v-model="nodeForm.is_local" :value="true" style="display:none;">
                <span>💻 本地直连 (免SSH)</span>
              </label>
              <label :class="['radio-pill-card', !nodeForm.is_local ? 'radio-pill-active' : '']">
                <input type="radio" v-model="nodeForm.is_local" :value="false" style="display:none;">
                <span>🌐 远程 SSH 穿透</span>
              </label>
            </div>
          </div>

          <div class="form-field-block">
            <label class="form-label">节点名称</label>
            <input v-model="nodeForm.name" required placeholder="如: 本机 Chrome 01" class="cdp-input cdp-w-normal">
          </div>

          <!-- 本地节点专用输入 -->
          <div v-if="nodeForm.is_local" style="background:#09122a; padding:12px; border-radius:6px; border:1px solid #172554;">
            <div class="form-field-block">
              <label class="form-label">本地 CDP 调试端口 (默认 9222)</label>
              <input v-model="nodeForm.local_bind_port" type="number" required placeholder="9222" class="cdp-input cdp-w-port font-cyan-mono">
            </div>
            <p style="font-size:11px; color:#64748b; margin-top:6px;">接入本机 Chromium 调试接口，开机守护引擎将自动进行网关直连探测。</p>
          </div>

          <!-- 远程节点输入 -->
          <div v-else class="form-v-stack">
            <div class="row-flex-gap">
              <div class="form-field-block" style="flex:1;">
                <label class="form-label">SSH 主机 / IP</label>
                <input v-model="nodeForm.ssh_host" required placeholder="192.168.1.100" class="cdp-input font-cyan-mono" style="width:100% !important;">
              </div>
              <div class="form-field-block">
                <label class="form-label">SSH 端口</label>
                <input v-model="nodeForm.ssh_port" type="number" placeholder="22" class="cdp-input cdp-w-port font-cyan-mono">
              </div>
            </div>

            <div class="form-field-block">
              <label class="form-label">SSH 用户名</label>
              <input v-model="nodeForm.ssh_user" required placeholder="root" class="cdp-input cdp-w-normal font-cyan-mono">
            </div>

            <div class="form-field-block">
              <label class="form-label">绑定 SSH 证书 (选填)</label>
              <select v-model="nodeForm.ssh_key_filename" class="cdp-input cdp-w-normal font-cyan-mono">
                <option value="">密码认证 (不选择私钥)</option>
                <option v-for="k in keys" :key="k.filename" :value="k.filename">🔑 {{ k.filename }} {{ k.remark ? `(${k.remark})` : '' }}</option>
              </select>
            </div>

            <div v-if="!nodeForm.ssh_key_filename" class="form-field-block">
              <label class="form-label">SSH 密码</label>
              <input v-model="nodeForm.ssh_password" type="password" placeholder="••••••••" class="cdp-input cdp-w-normal">
            </div>

            <div class="row-flex-gap">
              <div class="form-field-block" style="flex:1;">
                <label class="form-label">远程 CDP 端口</label>
                <input v-model="nodeForm.remote_cdp_port" type="number" placeholder="9222" class="cdp-input font-cyan-mono" style="width:100% !important;">
              </div>
              <div class="form-field-block" style="flex:1;">
                <label class="form-label">本地穿透映射端口</label>
                <input v-model="nodeForm.local_bind_port" type="number" required placeholder="19222" class="cdp-input font-cyan-mono" style="width:100% !important;">
              </div>
            </div>
          </div>

          <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:16px;">
            <button type="button" @click="showNodeModal = false" class="btn-gray-test">取消</button>
            <button type="submit" class="btn-primary-gradient">保存配置</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 弹窗 2：Cookie 失效生命周期透视抽屉 -->
    <div v-if="showCookieModal" class="modal-backdrop">
      <div class="modal-card" style="width: 820px; max-width: 95vw;">
        <div class="modal-title-bar">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:16px;">🍪</span>
            <h3 style="font-size:14px; font-weight:bold; color:#fff;">
              节点 [{{ cookieDetails.node_name }}] Cookie 失效与生命周期透视
            </h3>
          </div>
          <button @click="showCookieModal = false" style="background:none; border:none; color:#94a3b8; font-size:16px; cursor:pointer;">✕</button>
        </div>

        <div style="margin-top:12px;">
          <!-- 统计摘要行 -->
          <div style="display:flex; gap:12px; margin-bottom:14px;">
            <span class="cookie-stat-badge">总数: <b>{{ cookieDetails.total }}</b></span>
            <span class="cookie-stat-badge" style="border-color:#059669; color:#34d399;">有效持久: <b>{{ cookieDetails.valid_count }}</b></span>
            <span class="cookie-stat-badge" style="border-color:#3b82f6; color:#60a5fa;">会话凭据: <b>{{ cookieDetails.session_count }}</b></span>
            <span class="cookie-stat-badge" style="border-color:#dc2626; color:#f87171;">已过期: <b>{{ cookieDetails.expired_count }}</b></span>
          </div>

          <div style="max-height: 440px; overflow-y: auto; border: 1px solid #172554; border-radius: 6px;">
            <table class="cdp-fluid-table" style="font-size:11px;">
              <thead>
                <tr>
                  <th>Cookie 名称</th>
                  <th>域名</th>
                  <th>脱敏值</th>
                  <th>生命周期状态</th>
                  <th>到期描述</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in cookieDetails.cookies" :key="c.name + c.domain">
                  <td class="cell-main-name font-cyan-mono">{{ c.name }}</td>
                  <td class="font-cyan-mono">{{ c.domain }}</td>
                  <td style="color:#94a3b8; font-family:monospace;" :title="c.value_full">{{ c.value_masked }}</td>
                  <td>
                    <span v-if="c.status === 'valid'" class="status-active" style="font-size:10px; padding:1px 6px;">有效</span>
                    <span v-else-if="c.status === 'session'" class="tag-plan-blue" style="font-size:10px; padding:1px 6px;">会话</span>
                    <span v-else class="status-error" style="font-size:10px; padding:1px 6px;">已失效</span>
                  </td>
                  <td style="color:#cbd5e1;">{{ c.expires_desc }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style="display:flex; justify-content:flex-end; margin-top:14px;">
            <button @click="showCookieModal = false" class="btn-primary-gradient">关闭</button>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.cookie-stat-badge {
  background: #09122a;
  border: 1px solid #172554;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 11px;
}
</style>