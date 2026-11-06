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
const clusterJoinToken = ref('')
const activeTab = ref('nodes') // 'nodes' | 'audit'
const deployTab = ref('docker') // 'docker' | 'compose'
const showDeployGuide = ref(false)

const auditLogs = ref([])

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

const loadBaseData = async () => {
  const [nRes, kRes, gRes, rRes] = await Promise.all([
    props.api('/api/nodes'),
    props.api('/api/ssh-keys'),
    props.api('/api/node-groups'),
    props.api('/api/remote-access')
  ])
  nodes.value = await nRes.json()
  keys.value = await kRes.json()
  groups.value = await gRes.json()
  const rData = await rRes.json()
  clusterJoinToken.value = rData.cluster_join_token || ''
  emit('update-nodes')
}

const loadAuditLogs = async () => {
  const res = await props.api('/api/nodes/audit-logs')
  if (res.ok) {
    auditLogs.value = await res.json()
  }
}

const pendingNodes = computed(() => nodes.value.filter(n => n.approval_status === 0))
const filteredNodes = computed(() => {
  if (!selectedFilterGroup.value) return nodes.value
  return nodes.value.filter(n => n.group_name === selectedFilterGroup.value)
})

const copyText = async (text, desc) => {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    props.showToast(`${desc} 已复制到剪切板`, 'success')
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    props.showToast(`${desc} 已复制`, 'success')
  }
}

const resetJoinToken = async () => {
  if (confirm('确认重置集群入网通行码？旧通行码将立即失效。')) {
    const res = await props.api('/api/nodes/reset-join-token', { method: 'POST' })
    const data = await res.json()
    clusterJoinToken.value = data.join_token
    props.showToast('通行码已重置', 'success')
  }
}

const approveNode = async (node) => {
  const res = await props.api(`/api/nodes/${node.id}/approve`, { method: 'POST' })
  const data = await res.json()
  props.showToast(data.message, 'success')
  loadBaseData()
}

const rejectNode = async (node) => {
  if (confirm(`确认拒绝并清除待审节点 [${node.name}]？`)) {
    const res = await props.api(`/api/nodes/${node.id}/reject`, { method: 'POST' })
    const data = await res.json()
    props.showToast(data.message, 'success')
    loadBaseData()
  }
}

const approveAllPending = async () => {
  for (const n of pendingNodes.value) {
    await props.api(`/api/nodes/${n.id}/approve`, { method: 'POST' })
  }
  props.showToast(`已信任 ${pendingNodes.value.length} 个节点`, 'success')
  loadBaseData()
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
  loadBaseData()
}

const toggleNodeEnabled = async (node) => {
  const res = await props.api(`/api/nodes/${node.id}/toggle-enabled`, { method: 'POST' })
  const data = await res.json()
  props.showToast(data.message, 'success')
  loadBaseData()
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
  loadBaseData()
}

const toggleSource = async (id) => {
  const res = await props.api(`/api/nodes/${id}/toggle-source`, { method: 'POST' })
  const data = await res.json()
  props.showToast(data.message, 'success')
  loadBaseData()
}

const deleteNode = async (id) => {
  if (confirm('确认销毁该节点的接入配置？')) {
    await props.api(`/api/nodes/${id}`, { method: 'DELETE' })
    props.showToast('节点已移除', 'success')
    loadBaseData()
  }
}

const currentHubUrl = computed(() => {
  return `${window.location.protocol}//${window.location.host}`
})

onMounted(() => {
  loadBaseData()
  loadAuditLogs()
})
</script>

<template>
  <div class="content-full-card">

    <!-- ==================== 1. 入网凭证与一键部署横幅 (整合在本页) ==================== -->
    <div class="token-deploy-banner">
      <div class="token-banner-top">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:16px;">🔑</span>
          <span style="font-size:13px; font-weight:bold; color:#fff;">边缘节点入网通行码 (Join Token)</span>
          <span class="badge-mini-cyan">免审直连凭据</span>
        </div>
        <div style="display:flex; gap:8px;">
          <button @click="copyText(clusterJoinToken, 'Join Token')" class="btn-micro" style="background:#0284c7;">📋 复制 Token</button>
          <button @click="resetJoinToken" class="btn-micro" style="background:#7f1d1d;">重置通行码</button>
          <button @click="showDeployGuide = !showDeployGuide" class="btn-micro" style="background:#334155;">
            {{ showDeployGuide ? '收起部署命令 ▲' : '节点运行命令 ▼' }}
          </button>
        </div>
      </div>

      <div class="token-display-box" @click="copyText(clusterJoinToken, 'Join Token')" title="点击复制整行">
        <span class="token-text font-cyan-mono">{{ clusterJoinToken || '正在生成...' }}</span>
        <span style="opacity:0.6;">📋</span>
      </div>

      <!-- 部署代码展示抽屉 -->
      <div v-if="showDeployGuide" class="deploy-guide-panel">
        <div style="display:flex; gap:10px; margin-bottom:8px; border-bottom:1px solid #1e3a8a; padding-bottom:6px;">
          <button @click="deployTab = 'docker'" :class="['tab-guide-btn', deployTab === 'docker' ? 'tab-guide-active' : '']">Docker CLI (标准命令)</button>
          <button @click="deployTab = 'compose'" :class="['tab-guide-btn', deployTab === 'compose' ? 'tab-guide-active' : '']">Docker Compose 配置</button>
        </div>

        <div v-if="deployTab === 'docker'">
          <pre class="code-pre"><code>docker run -d \
  --name chromium-novnc \
  -p 6080:6080 \
  -p 9222:9222 \
  -e HUB_URL={{ currentHubUrl }} \
  -e JOIN_TOKEN={{ clusterJoinToken }} \
  -e NODE_NAME=甲骨文云节点-01 \
  -v ./data:/data \
  wimotek/chromium:novnc</code></pre>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
            <span style="font-size:11px; color:#64748b;">* 若宿主机映射了其他端口（例如 -p 1922:9222），追加参数：<code>-e DIRECT_PORT=1922</code> 即可自动直连。</span>
            <button @click="copyText(`docker run -d --name chromium-novnc -p 6080:6080 -p 9222:9222 -e HUB_URL=${currentHubUrl} -e JOIN_TOKEN=${clusterJoinToken} -v ./data:/data wimotek/chromium:novnc`, 'Docker 启动命令')" class="link-probe">一键复制 CLI</button>
          </div>
        </div>

        <div v-else>
          <pre class="code-pre"><code>version: '3.8'
services:
  chromium-node:
    image: wimotek/chromium:novnc
    restart: unless-stopped
    ports:
      - "6080:6080"
      - "9222:9222"
    environment:
      - HUB_URL={{ currentHubUrl }}
      - JOIN_TOKEN={{ clusterJoinToken }}
      # - DIRECT_PORT=1922   # 映射宿主机自定义端口时按需填写
    volumes:
      - ./data:/data</code></pre>
        </div>
      </div>
    </div>

    <!-- ==================== 2. TOFU 待审批边缘节点提示条 ==================== -->
    <div v-if="pendingNodes.length > 0" class="tofu-alert-banner">
      <div class="tofu-banner-left">
        <span class="tofu-bell-icon">🔔</span>
        <div>
          <h4 class="tofu-title-text">TOFU 隔离区正在拦截 {{ pendingNodes.length }} 个未审批边缘节点</h4>
          <p class="tofu-sub-text">节点当前仅在独立信道中交换心跳（无业务转发）。经管理员核验公钥指纹后方可转为受信任状态。</p>
        </div>
      </div>
      <div class="tofu-banner-actions">
        <button @click="approveAllPending" class="btn-micro" style="background:#059669;">
          ⚡ 一键信任全部 ({{ pendingNodes.length }})
        </button>
      </div>
    </div>

    <!-- ==================== 3. 标签切换导航 (节点列表 vs 准入审计流水) ==================== -->
    <div class="table-header-bar">
      <div style="display:flex; gap:16px; align-items:center;">
        <button @click="activeTab = 'nodes'" :class="['nav-pill-btn', activeTab === 'nodes' ? 'nav-pill-active' : '']">
          👥 CDP 节点实例列表 ({{ nodes.length }})
        </button>
        <button @click="activeTab = 'audit'; loadAuditLogs()" :class="['nav-pill-btn', activeTab === 'audit' ? 'nav-pill-active' : '']">
          📜 零信任准入审计日志
        </button>
      </div>

      <div v-if="activeTab === 'nodes'" style="display:flex; gap:10px; align-items:center;">
        <select v-model="selectedFilterGroup" class="sync-input font-mono" style="width:auto; height:32px; font-size:12px;">
          <option value="">📂 全部分组 ({{ nodes.length }})</option>
          <option v-for="g in groups" :key="g" :value="g">📁 {{ g }}</option>
        </select>
        <button @click="openCreateModal" class="btn-primary-gradient">+ 新增接入节点</button>
        <button @click="loadBaseData" class="btn-primary-gradient">🔄 刷新</button>
      </div>

      <div v-else>
        <button @click="loadAuditLogs" class="btn-primary-gradient">🔄 刷新审计流水</button>
      </div>
    </div>

    <!-- ==================== 视图 1：节点列表 ==================== -->
    <div v-if="activeTab === 'nodes'" class="table-responsive">
      <table class="cdp-fluid-table">
        <thead>
          <tr>
            <th style="width: 12%;">所属分组</th>
            <th style="width: 20%;">节点标识 (Node UUID)</th>
            <th style="width: 10%;">准入状态</th>
            <th style="width: 14%;">端点 / 映射端口</th>
            <th style="width: 10%;">Cookie 存量</th>
            <th style="width: 12%;">网络拓扑</th>
            <th style="width: 8%;">角色</th>
            <th style="width: 14%; text-align: right;">操作</th>
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
              </div>
              <div class="cell-sub-desc">
                <span v-if="node.conn_type === 'reverse'">指纹: {{ node.fingerprint ? node.fingerprint.slice(0, 16) + '...' : (node.node_uuid || 'NAT4-Client') }}</span>
                <span v-else-if="node.is_local">直连: {{ node.direct_host || '127.0.0.1' }}</span>
                <span v-else>{{ node.ssh_user }}@{{ node.ssh_host }}:{{ node.ssh_port }}</span>
              </div>
            </td>

            <td>
              <span v-if="node.approval_status === 0" class="badge-status-pending">⏳ 待审批 (PENDING)</span>
              <span v-else-if="node.enabled === 0" class="status-standby">○ 已禁用</span>
              <span v-else-if="node.status === 'connected'" class="badge-status-trusted">● 已信任 (TRUSTED)</span>
              <span v-else class="status-standby">○ 离线</span>
            </td>

            <td class="font-cyan-mono">
              <span v-if="node.conn_type === 'reverse'">Reverse-WSS</span>
              <span v-else>{{ node.is_local ? (node.direct_host || '127.0.0.1') : '127.0.0.1' }}:{{ node.local_bind_port }}</span>
            </td>

            <td>
              <div class="cookie-badge" @click="viewCookieDetails(node)" style="cursor:pointer;" title="查看详情">
                <span>🍪 {{ node.cookie_count || 0 }} 条</span>
              </div>
            </td>

            <td>
              <span v-if="node.conn_type === 'reverse'" class="tag-topo-reverse">nat4_reverse</span>
              <span v-else class="tag-topo-direct">direct</span>
            </td>

            <td>
              <button v-if="node.is_source" @click="toggleSource(node.id)" class="btn-qrcode" style="background:#0284c7;">★ 默认源</button>
              <button v-else @click="toggleSource(node.id)" class="btn-set-source">设为源</button>
            </td>

            <td style="text-align: right;">
              <div class="btn-group-row">
                <template v-if="node.approval_status === 0">
                  <button @click="approveNode(node)" class="btn-micro" style="background:#059669;">✅ 批准</button>
                  <button @click="rejectNode(node)" class="btn-micro btn-trash">❌ 拒绝</button>
                </template>
                <template v-else>
                  <button @click="toggleNodeEnabled(node)" class="btn-micro" style="background:#334155;">{{ node.enabled === 0 ? '▶️' : '⏸️' }}</button>
                  <button @click="probeNode(node)" class="btn-micro btn-purple">探针</button>
                  <button @click="openEditModal(node)" class="btn-micro" style="background:#2563eb;">✏️</button>
                  <button @click="deleteNode(node.id)" class="btn-micro btn-trash">🗑️</button>
                </template>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ==================== 视图 2：零信任准入审计日志 (7列高规格) ==================== -->
    <div v-else class="table-responsive">
      <table class="cdp-fluid-table audit-decision-table">
        <thead>
          <tr>
            <th style="width: 14%;">时间戳 (UTC)</th>
            <th style="width: 12%;">事件类型</th>
            <th style="width: 18%;">节点 (Node UUID)</th>
            <th style="width: 14%;">来源 IP</th>
            <th style="width: 10%; text-align: center;">判定决策</th>
            <th style="width: 22%;">裁决原因 (Reason)</th>
            <th style="width: 10%;">网络模式</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(log, idx) in auditLogs" :key="idx">
            <td class="font-mono text-muted">{{ log.ts ? log.ts.replace('T', ' ').slice(0, 19) : '---' }}</td>
            <td class="font-mono" style="color:#cbd5e1;">{{ log.event || 'access_decision' }}</td>
            <td class="font-cyan-mono" :title="log.node_uuid">{{ log.node_uuid || '---' }}</td>
            <td class="font-mono">
              {{ log.source_ip || '---' }}
              <span v-if="log.is_loopback" class="badge-loopback">回环</span>
            </td>
            <td style="text-align: center;">
              <span v-if="log.decision === 'allow_token' || log.decision === 'allow_local'" class="badge-decision-allow">
                {{ log.decision }}
              </span>
              <span v-else-if="log.decision === 'pending_tofu'" class="badge-decision-pending">
                pending_tofu
              </span>
              <span v-else-if="log.decision === 'deny'" class="badge-decision-deny">
                deny
              </span>
              <span v-else style="color:#64748b;">-</span>
            </td>
            <td class="font-mono text-reason" :title="log.reason">{{ log.reason || '-' }}</td>
            <td>
              <span class="font-mono" :style="{ color: log.network_profile === 'nat4_reverse' ? '#a78bfa' : '#38bdf8' }">
                {{ log.network_profile || '-' }}
              </span>
            </td>
          </tr>
          <tr v-if="auditLogs.length === 0">
            <td colspan="7" style="text-align:center; color:#64748b; padding:32px;">暂无准入审计日志</td>
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
          <button @click="showNodeModal = false" class="modal-close-btn">✕</button>
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
              <input v-model="nodeForm.name" required placeholder="如: 节点 01" class="cdp-input font-cyan-mono" style="width:100% !important;">
            </div>
            <div class="form-field-block" style="flex:1;">
              <label class="form-label">所属集群分组</label>
              <input v-model="nodeForm.group_name" required list="group-suggestions" class="cdp-input font-cyan-mono" style="width:100% !important;">
              <datalist id="group-suggestions">
                <option v-for="g in groups" :key="g" :value="g"></option>
              </datalist>
            </div>
          </div>

          <div v-if="nodeForm.is_local" style="background:#09122a; padding:12px; border-radius:6px; border:1px solid #172554;">
            <div class="row-flex-gap">
              <div class="form-field-block" style="flex:1;">
                <label class="form-label">直连 IP / 域名</label>
                <input v-model="nodeForm.direct_host" required placeholder="127.0.0.1 或 192.168.x.x" class="cdp-input font-cyan-mono" style="width:100% !important;">
              </div>
              <div class="form-field-block">
                <label class="form-label">CDP 端口 (默认 9222)</label>
                <input v-model="nodeForm.local_bind_port" type="number" required class="cdp-input cdp-w-port font-cyan-mono">
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

    <!-- 弹窗：Cookie 详情 -->
    <div v-if="showCookieModal" class="modal-backdrop">
      <div class="modal-card cookie-modal-wide">
        <div class="modal-title-bar">
          <h3 style="font-size:14px; font-weight:bold; color:#fff;">节点 [{{ cookieDetails.node_name }}] Cookie 生命周期</h3>
          <button @click="showCookieModal = false" class="modal-close-btn">✕</button>
        </div>
        <div style="margin-top:12px;">
          <div class="cookie-stat-row">
            <span class="cookie-stat-badge">总数: <b>{{ cookieDetails.total }}</b></span>
            <span class="cookie-stat-badge" style="border-color:#059669; color:#34d399;">持久有效: <b>{{ cookieDetails.valid_count }}</b></span>
            <span class="cookie-stat-badge" style="border-color:#3b82f6; color:#60a5fa;">会话凭据: <b>{{ cookieDetails.session_count }}</b></span>
          </div>
          <div class="cookie-table-container">
            <table class="cookie-full-table">
              <thead>
                <tr><th>名称</th><th>域名</th><th>脱敏值</th><th>状态</th><th>有效期</th></tr>
              </thead>
              <tbody>
                <tr v-for="c in cookieDetails.cookies" :key="c.name + c.domain">
                  <td class="font-cyan-mono">{{ c.name }}</td>
                  <td class="font-cyan-mono">{{ c.domain }}</td>
                  <td style="color:#94a3b8; font-family:monospace;">{{ c.value_masked }}</td>
                  <td>{{ c.status }}</td>
                  <td style="color:#cbd5e1; font-family:monospace;">{{ c.expires_desc }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
/* 部署与通行码横幅 */
.token-deploy-banner {
  background: #09122a;
  border: 1px solid #1e3a8a;
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 16px;
}
.token-banner-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.token-display-box {
  background: #060b17;
  border: 1px solid #172554;
  border-radius: 4px;
  padding: 6px 10px;
  margin-top: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
}
.token-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
  font-size: 12px;
}
.badge-mini-cyan {
  background: rgba(14, 165, 233, 0.2);
  border: 1px solid #0284c7;
  color: #38bdf8;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
}

/* 快速部署面板 */
.deploy-guide-panel {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed #1e3a8a;
}
.tab-guide-btn {
  background: none;
  border: none;
  color: #94a3b8;
  font-size: 12px;
  cursor: pointer;
  padding: 3px 8px;
}
.tab-guide-active {
  color: #38bdf8;
  font-weight: bold;
  border-bottom: 2px solid #0284c7;
}
.code-pre {
  background: #060b17;
  border: 1px solid #172554;
  border-radius: 6px;
  padding: 10px;
  font-family: monospace;
  font-size: 11px;
  color: #e2e8f0;
  margin: 0;
  overflow-x: auto;
}

/* 导航药丸切换 */
.nav-pill-btn {
  background: transparent;
  border: 1px solid #334155;
  color: #94a3b8;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.nav-pill-active {
  background: #1e3a8a;
  border-color: #3b82f6;
  color: #ffffff;
  font-weight: bold;
}

/* 状态徽章 */
.badge-status-trusted {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid #059669;
  color: #34d399;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
}
.badge-status-pending {
  background: rgba(217, 119, 6, 0.15);
  border: 1px solid #d97706;
  color: #fbbf24;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
}
.tag-topo-reverse {
  background: rgba(139, 92, 246, 0.2);
  border: 1px solid #8b5cf6;
  color: #c4b5fd;
  border-radius: 4px;
  padding: 2px 6px;
  font-family: monospace;
  font-size: 11px;
}
.tag-topo-direct {
  background: rgba(2, 132, 199, 0.15);
  border: 1px solid #0284c7;
  color: #38bdf8;
  border-radius: 4px;
  padding: 2px 6px;
  font-family: monospace;
  font-size: 11px;
}

/* 准入审计表格专属颜色 */
.badge-decision-allow {
  background: rgba(16, 185, 129, 0.2);
  border: 1px solid #059669;
  color: #34d399;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
}
.badge-decision-pending {
  background: rgba(217, 119, 6, 0.2);
  border: 1px solid #d97706;
  color: #fbbf24;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
}
.badge-decision-deny {
  background: rgba(220, 38, 38, 0.2);
  border: 1px solid #dc2626;
  color: #f87171;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
}
.badge-loopback {
  background: #1e293b;
  border: 1px solid #475569;
  color: #94a3b8;
  font-size: 10px;
  padding: 0 4px;
  border-radius: 3px;
  margin-left: 4px;
}
.text-reason {
  color: #cbd5e1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}

/* 待审核横幅 */
.tofu-alert-banner {
  background: rgba(217, 119, 6, 0.12);
  border: 1px solid #d97706;
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.tofu-banner-left { display: flex; align-items: center; gap: 10px; }
.tofu-bell-icon { font-size: 18px; }
.tofu-title-text { font-size: 13px; font-weight: bold; color: #fbbf24; margin: 0; }
.tofu-sub-text { font-size: 11px; color: #cbd5e1; margin: 2px 0 0 0; }
</style>