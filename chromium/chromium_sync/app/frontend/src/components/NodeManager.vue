<script setup>
import { ref, reactive, computed, onMounted } from 'vue'

const props = defineProps({
  api: Function,
  showToast: Function
})
const emit = defineEmits(['update-nodes'])

const nodes = ref([])
const keys = ref([])
const groups = ref([])
const selectedFilterGroup = ref('')

const showNodeModal = ref(false)
const isEditMode = ref(false)
const editingNodeId = ref(null)

const showCookieModal = ref(false)
const cookieDetails = ref({ node_name: '', total: 0, valid_count: 0, session_count: 0, expired_count: 0, cookies: [] })

const nodeForm = reactive({
  name: '',
  group_name: '默认分组',
  is_local: true,
  direct_host: '127.0.0.1',
  ssh_host: '',
  ssh_port: 22,
  ssh_user: 'root',
  ssh_key_filename: '',
  ssh_password: '',
  remote_cdp_port: 9222,
  local_bind_port: 9222
})

const loadNodes = async () => {
  const [nRes, kRes, gRes] = await Promise.all([
    props.api('/api/nodes'),
    props.api('/api/ssh-keys'),
    props.api('/api/node-groups')
  ])
  nodes.value = await nRes.json()
  keys.value = await kRes.json()
  groups.value = await gRes.json()
  emit('update-nodes')
}

// 提取 TOFU 待审批认领节点队列
const pendingNodes = computed(() => {
  return nodes.value.filter(n => n.approval_status === 0)
})

const filteredNodes = computed(() => {
  if (!selectedFilterGroup.value) return nodes.value
  return nodes.value.filter(n => n.group_name === selectedFilterGroup.value)
})

// TOFU 认领批准
const approveNode = async (node) => {
  const res = await props.api(`/api/nodes/${node.id}/approve`, { method: 'POST' })
  const data = await res.json()
  props.showToast(data.message, 'success')
  loadNodes()
}

// TOFU 拒绝清除
const rejectNode = async (node) => {
  if (confirm(`确认拒绝并清除该待审节点 [${node.name}]？`)) {
    const res = await props.api(`/api/nodes/${node.id}/reject`, { method: 'POST' })
    const data = await res.json()
    props.showToast(data.message, 'success')
    loadNodes()
  }
}

// 一键全部认领
const approveAllPending = async () => {
  for (const n of pendingNodes.value) {
    await props.api(`/api/nodes/${n.id}/approve`, { method: 'POST' })
  }
  props.showToast(`已成功认领信任 ${pendingNodes.value.length} 个节点`, 'success')
  loadNodes()
}

const openCreateModal = () => {
  isEditMode.value = false
  editingNodeId.value = null
  Object.assign(nodeForm, {
    name: '',
    group_name: selectedFilterGroup.value || '默认分组',
    is_local: true,
    direct_host: '127.0.0.1',
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
    group_name: node.group_name || '默认分组',
    is_local: Boolean(node.is_local),
    direct_host: node.direct_host || '127.0.0.1',
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

const toggleNodeEnabled = async (node) => {
  const res = await props.api(`/api/nodes/${node.id}/toggle-enabled`, { method: 'POST' })
  const data = await res.json()
  props.showToast(data.message, 'success')
  loadNodes()
}

const viewCookieDetails = async (node) => {
  showCookieModal.value = true
  const res = await props.api(`/api/nodes/${node.id}/cookie-details`)
  if (res.ok) {
    cookieDetails.value = await res.json()
  } else {
    props.showToast('读取 Cookie 详情异常', 'error')
    showCookieModal.value = false
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
  loadNodes()
}

const toggleSource = async (id) => {
  const res = await props.api(`/api/nodes/${id}/toggle-source`, { method: 'POST' })
  const data = await res.json()
  props.showToast(data.message, 'success')
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
    
    <!-- ==================== TOFU 待认领待审批边缘节点提示条 ==================== -->
    <div v-if="pendingNodes.length > 0" class="tofu-alert-banner">
      <div class="tofu-banner-left">
        <span class="tofu-bell-icon">🔔</span>
        <div>
          <h4 class="tofu-title-text">
            检测到 {{ pendingNodes.length }} 个待认领边缘节点 (TOFU 模式首次接入)
          </h4>
          <p class="tofu-sub-text">来自 NAT4 内网容器主动接入，请核验指纹后认领信任，未认领前不参与业务调度与探活。</p>
        </div>
      </div>
      <div class="tofu-banner-actions">
        <button @click="approveAllPending" class="btn-micro" style="background:#059669;">
          ⚡ 一键信任全部 ({{ pendingNodes.length }})
        </button>
      </div>
    </div>

    <!-- 顶部标题与操作 -->
    <div class="table-header-bar">
      <div class="table-title">
        <span class="icon-duo-users">👥</span>
        <h2>CDP 节点实例治理列表</h2>
      </div>

      <div style="display:flex; gap:10px; align-items:center;">
        <select v-model="selectedFilterGroup" class="sync-input font-mono" style="width:auto; height:32px; font-size:12px;">
          <option value="">📂 全部分组 ({{ nodes.length }})</option>
          <option v-for="g in groups" :key="g" :value="g">📁 {{ g }}</option>
        </select>

        <button @click="openCreateModal" class="btn-primary-gradient">+ 新增接入节点</button>
        <button @click="loadNodes" class="btn-primary-gradient">🔄 刷新列表</button>
      </div>
    </div>

    <div class="table-responsive">
      <table class="cdp-fluid-table">
        <thead>
          <tr>
            <th style="width: 12%;">所属分组</th>
            <th style="width: 18%;">节点名称 / 接入目标</th>
            <th style="width: 10%;">运行状态</th>
            <th style="width: 14%;">调试端点</th>
            <th style="width: 12%;">实时 Cookie</th>
            <th style="width: 12%;">接入通道类型</th>
            <th style="width: 8%;">同步角色</th>
            <th style="width: 14%; text-align: right;">治理操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="node in filteredNodes" :key="node.id" :class="[node.enabled === 0 ? 'row-node-disabled' : '', node.approval_status === 0 ? 'row-node-pending' : '']">
            <td>
              <span class="tag-group-pill">📁 {{ node.group_name || '默认分组' }}</span>
            </td>

            <td>
              <div class="cell-main-name">
                {{ node.name }}
                <span v-if="node.approval_status === 0" style="font-size:10px; color:#fbbf24; margin-left:4px;">[待审核]</span>
                <span v-else-if="node.enabled === 0" style="font-size:10px; color:#f87171; margin-left:4px;">[已禁用]</span>
              </div>
              <div class="cell-sub-desc">
                <span v-if="node.conn_type === 'reverse'">指纹: {{ node.node_uuid ? node.node_uuid.slice(0, 8) + '...' : 'NAT4-Client' }}</span>
                <span v-else-if="node.is_local">直连: {{ node.direct_host || '127.0.0.1' }}</span>
                <span v-else>{{ node.ssh_user }}@{{ node.ssh_host }}:{{ node.ssh_port }}</span>
              </div>
            </td>

            <!-- 状态 -->
            <td>
              <span v-if="node.approval_status === 0" class="status-standby" style="background:rgba(217, 119, 6, 0.2); border-color:#d97706; color:#fbbf24;">⏳ 待认领</span>
              <span v-else-if="node.enabled === 0" class="status-standby" style="background:rgba(100, 116, 139, 0.2); border-color:#475569; color:#94a3b8;">○ 已禁用</span>
              <span v-else-if="node.status === 'connected'" class="status-active">● 活跃</span>
              <span v-else-if="node.status === 'stopped'" class="status-standby">○ 离线</span>
              <span v-else class="status-error" :title="node.status">✕ 异常</span>
            </td>

            <td class="font-cyan-mono">
              <span v-if="node.conn_type === 'reverse'">Reverse-WSS</span>
              <span v-else>{{ node.is_local ? (node.direct_host || '127.0.0.1') : '127.0.0.1' }}:{{ node.local_bind_port }}</span>
            </td>

            <td>
              <div class="cookie-badge" @click="viewCookieDetails(node)" style="cursor:pointer;" title="查看详情">
                <span>🍪 {{ node.cookie_count || 0 }} 条</span>
                <span style="font-size:10px; color:#38bdf8; text-decoration:underline; margin-left:4px;">详情</span>
              </div>
            </td>

            <!-- 接入类型 (直连/SSH/NAT4反向) -->
            <td>
              <span v-if="node.conn_type === 'reverse'" class="tag-plan-indigo" style="background:#3730a3; border-color:#6366f1;">🌐 反向穿透(NAT4)</span>
              <span v-else-if="node.is_local" class="tag-plan-blue">免SSH直连</span>
              <span v-else class="tag-plan-indigo">SSH穿透</span>
            </td>

            <td>
              <button 
                v-if="node.is_source" 
                @click="toggleSource(node.id)" 
                class="btn-qrcode" 
                style="background: #0284c7; cursor: pointer;"
                title="已是默认源，点击取消"
              >
                ★ 默认源
              </button>
              <button 
                v-else 
                @click="toggleSource(node.id)" 
                class="btn-set-source"
                title="设为全网源"
              >
                设为源
              </button>
            </td>

            <!-- 操作列 -->
            <td style="text-align: right;">
              <div class="btn-group-row">
                <!-- 若处于待审批状态：直接展现认领与拒绝 -->
                <template v-if="node.approval_status === 0">
                  <button @click="approveNode(node)" class="btn-micro" style="background:#059669;" title="信任并批准该节点加入集群">
                    ✅ 认领
                  </button>
                  <button @click="rejectNode(node)" class="btn-micro btn-trash" title="拒绝并清除">
                    ❌ 拒绝
                  </button>
                </template>

                <!-- 已批准节点的常规治理 -->
                <template v-else>
                  <button 
                    @click="toggleNodeEnabled(node)" 
                    :class="['btn-micro', node.enabled === 0 ? 'btn-resume-node' : 'btn-pause-node']"
                    :title="node.enabled === 0 ? '点击恢复启用此节点' : '点击禁用此节点'"
                  >
                    {{ node.enabled === 0 ? '▶️' : '⏸️' }}
                  </button>

                  <button @click="toggleTunnel(node)" :disabled="node.enabled === 0 || node.conn_type === 'reverse'" class="btn-micro btn-orange">
                    🔑 {{ node.conn_type === 'reverse' ? '长连' : (node.status === 'connected' ? '断开' : '穿透') }}
                  </button>

                  <button @click="probeNode(node)" :disabled="node.enabled === 0" class="btn-micro btn-purple">🔀 探针</button>
                  <button @click="openEditModal(node)" class="btn-micro" style="background:#2563eb;">✏️</button>
                  <button @click="deleteNode(node.id)" class="btn-micro btn-trash">🗑️</button>
                </template>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 弹窗：新增 / 编辑节点 -->
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
                <span>💻 本地/局域网直连 (免SSH)</span>
              </label>
              <label :class="['radio-pill-card', !nodeForm.is_local ? 'radio-pill-active' : '']">
                <input type="radio" v-model="nodeForm.is_local" :value="false" style="display:none;">
                <span>🌐 远程 SSH 穿透</span>
              </label>
            </div>
          </div>

          <div class="row-flex-gap">
            <div class="form-field-block" style="flex:1;">
              <label class="form-label">节点名称</label>
              <input v-model="nodeForm.name" required placeholder="如: 宿主机 Chrome 01" class="cdp-input font-cyan-mono" style="width:100% !important;">
            </div>

            <div class="form-field-block" style="flex:1;">
              <label class="form-label">所属集群分组</label>
              <input v-model="nodeForm.group_name" required list="group-suggestions" placeholder="如: 默认分组 / 爬虫A组" class="cdp-input font-cyan-mono" style="width:100% !important;">
              <datalist id="group-suggestions">
                <option v-for="g in groups" :key="g" :value="g"></option>
              </datalist>
            </div>
          </div>

          <!-- 本地直连输入 -->
          <div v-if="nodeForm.is_local" style="background:#09122a; padding:12px; border-radius:6px; border:1px solid #172554;">
            <div class="row-flex-gap">
              <div class="form-field-block" style="flex:1;">
                <label class="form-label">直连 IP / 域名 (默认 127.0.0.1)</label>
                <input v-model="nodeForm.direct_host" required placeholder="127.0.0.1 或 cdp.lan" class="cdp-input font-cyan-mono" style="width:100% !important;">
              </div>
              <div class="form-field-block">
                <label class="form-label">CDP 调试端口 (默认 9222)</label>
                <input v-model="nodeForm.local_bind_port" type="number" required placeholder="9222" class="cdp-input cdp-w-port font-cyan-mono">
              </div>
            </div>
          </div>

          <!-- 远程 SSH 节点输入 -->
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

    <!-- 弹窗：Cookie 深度透视 (96vw) -->
    <div v-if="showCookieModal" class="modal-backdrop">
      <div class="modal-card cookie-modal-wide">
        <div class="modal-title-bar">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:16px;">🍪</span>
            <h3 style="font-size:14px; font-weight:bold; color:#fff;">
              节点 [{{ cookieDetails.node_name }}] Cookie 生命周期与有效性分析
            </h3>
          </div>
          <button @click="showCookieModal = false" class="modal-close-btn">✕</button>
        </div>

        <div style="margin-top:12px;">
          <div class="cookie-stat-row">
            <span class="cookie-stat-badge">总数: <b style="color:#f8fafc;">{{ cookieDetails.total }}</b></span>
            <span class="cookie-stat-badge" style="border-color:#059669; color:#34d399;">有效持久: <b>{{ cookieDetails.valid_count }}</b></span>
            <span class="cookie-stat-badge" style="border-color:#3b82f6; color:#60a5fa;">会话凭据: <b>{{ cookieDetails.session_count }}</b></span>
            <span class="cookie-stat-badge" style="border-color:#dc2626; color:#f87171;">已过期: <b>{{ cookieDetails.expired_count }}</b></span>
          </div>

          <div class="cookie-table-container">
            <table class="cookie-full-table">
              <thead>
                <tr>
                  <th style="min-width: 180px;">Cookie 名称</th>
                  <th style="min-width: 140px;">域名</th>
                  <th style="min-width: 120px;">脱敏值</th>
                  <th style="min-width: 110px; text-align: center;">生命周期状态</th>
                  <th style="min-width: 250px;">到期时间 / 有效期描述</th>
                  <th style="min-width: 80px; text-align: center;">安全属性</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in cookieDetails.cookies" :key="c.name + c.domain">
                  <td class="font-cyan-mono" style="font-weight:bold;">{{ c.name }}</td>
                  <td class="font-cyan-mono">{{ c.domain }}</td>
                  <td style="color:#94a3b8; font-family:monospace;" :title="c.value_full">{{ c.value_masked }}</td>
                  <td style="text-align: center;">
                    <span v-if="c.status === 'valid'" class="badge-status-valid">● 有效</span>
                    <span v-else-if="c.status === 'session'" class="badge-status-session">○ 会话</span>
                    <span v-else class="badge-status-expired">✕ 已失效</span>
                  </td>
                  <td style="color:#cbd5e1; font-family:monospace;">{{ c.expires_desc }}</td>
                  <td style="text-align: center;">
                    <span v-if="c.httpOnly" class="tag-flag" title="HttpOnly">H</span>
                    <span v-if="c.secure" class="tag-flag" title="Secure">S</span>
                    <span v-if="!c.httpOnly && !c.secure" style="color: #64748b;">-</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px;">
            <span style="font-size:11px; color:#64748b;">* 会话凭证随浏览器关闭自动失效；有效持久凭证显示距离过期的剩余天数</span>
            <button @click="showCookieModal = false" class="btn-primary-gradient">关闭</button>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
/* 待审核节点专属横幅 */
.tofu-alert-banner {
  background: rgba(217, 119, 6, 0.12);
  border: 1px solid #d97706;
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.tofu-banner-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tofu-bell-icon { font-size: 20px; }
.tofu-title-text {
  font-size: 13px;
  font-weight: bold;
  color: #fbbf24;
  margin: 0;
}
.tofu-sub-text {
  font-size: 11px;
  color: #cbd5e1;
  margin: 2px 0 0 0;
}

.tag-group-pill {
  background: #0f1f42;
  border: 1px solid #1d4ed8;
  color: #60a5fa;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}

.row-node-disabled {
  opacity: 0.55;
  filter: grayscale(0.8);
}
.row-node-pending {
  background: rgba(217, 119, 6, 0.05);
}

.btn-pause-node {
  background-color: #334155;
  color: #cbd5e1;
}
.btn-pause-node:hover { background-color: #475569; color: #fff; }

.btn-resume-node {
  background-color: #065f46;
  color: #34d399;
  border: 1px solid #059669;
}
.btn-resume-node:hover { background-color: #047857; color: #fff; }
</style>