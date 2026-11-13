<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  api: Function,
  showToast: Function
})
const emit = defineEmits(['update-nodes'])

// 基础数据状态
const nodes = ref([])
const keys = ref([])
const groups = ref([])
const selectedFilterGroup = ref('')
const clusterJoinToken = ref('')

// 视图与抽屉状态
const activeTab = ref('nodes') // 'nodes' | 'pending' | 'audit'
const deployTab = ref('docker') // 'docker' | 'compose'
const showDeployGuide = ref(false)

// TOFU 准入策略开关模型
const tofuSettings = reactive({
  tofu_enabled: true,
  tofu_auto_approve: false,
  tofu_timeout_notify_minutes: 10
})

// 准入审计日志与搜索过滤状态
const auditLogs = ref([])
const auditSearchText = ref('')
const auditDecisionFilter = ref('')

// 弹窗状态
const showNodeModal = ref(false)
const isEditMode = ref(false)
const editingNodeId = ref(null)

const showCookieModal = ref(false)
const cookieDetails = ref({ node_name: '', total: 0, valid_count: 0, session_count: 0, expired_count: 0, cookies: [] })

// 节点表单模型 (分类严格隔离)
const nodeForm = reactive({
  name: '',
  group_name: '默认分组',
  conn_type: 'direct',
  is_local: true,
  node_uuid: '',
  fingerprint: '',
  direct_host: '127.0.0.1',
  ssh_host: '',
  ssh_port: 22,
  ssh_user: 'root',
  ssh_key_filename: '',
  ssh_password: '',
  remote_cdp_port: 9222,
  local_bind_port: 9222
})

const currentHubUrl = computed(() => {
  return `${window.location.protocol}//${window.location.host}`
})

// 加载基础数据 (全量拉取)
const loadBaseData = async () => {
  const [nRes, kRes, gRes, rRes, tRes] = await Promise.all([
    props.api('/api/nodes'),
    props.api('/api/ssh-keys'),
    props.api('/api/node-groups'),
    props.api('/api/remote-access'),
    props.api('/api/nodes/tofu-settings')
  ])
  nodes.value = await nRes.json()
  keys.value = await kRes.json()
  groups.value = await gRes.json()
  const rData = await rRes.json()
  clusterJoinToken.value = rData.cluster_join_token || ''
  if (tRes.ok) {
    Object.assign(tofuSettings, await tRes.json())
  }
  emit('update-nodes')
}

// 生产级 3 秒实时状态探活轮询
let pollTimer = null
let isPolling = false

const pollNodeStatus = async () => {
  if (document.hidden || isPolling) return
  isPolling = true
  try {
    const res = await props.api('/api/nodes')
    if (res.ok) {
      nodes.value = await res.json()
      emit('update-nodes')
    }
    if (activeTab.value === 'audit') {
      const aRes = await props.api('/api/nodes/audit-logs')
      if (aRes.ok) {
        auditLogs.value = await aRes.json()
      }
    }
  } catch (e) {
    // 轮询异常静默
  } finally {
    isPolling = false
  }
}

// 保存 TOFU 开关策略设置
const updateTofuSettings = async () => {
  const res = await props.api('/api/nodes/tofu-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tofuSettings)
  })
  if (res.ok) {
    props.showToast('TOFU 准入策略已实时生效', 'success')
  } else {
    props.showToast('更新策略失败', 'error')
  }
}

// 加载审计流水
const loadAuditLogs = async () => {
  const res = await props.api('/api/nodes/audit-logs')
  if (res.ok) {
    auditLogs.value = await res.json()
  }
}

// 已信任正式节点队列
const trustedNodes = computed(() => nodes.value.filter(n => n.approval_status === 1))

// 待认领 TOFU 队列
const pendingNodes = computed(() => nodes.value.filter(n => n.approval_status === 0))

// 正式节点分组过滤
const filteredNodes = computed(() => {
  if (!selectedFilterGroup.value) return trustedNodes.value
  return trustedNodes.value.filter(n => n.group_name === selectedFilterGroup.value)
})

// 准入审计智能过滤计算属性
const filteredAuditLogs = computed(() => {
  let list = auditLogs.value
  if (auditDecisionFilter.value) {
    list = list.filter(l => l.decision === auditDecisionFilter.value)
  }
  if (auditSearchText.value.trim()) {
    const q = auditSearchText.value.trim().toLowerCase()
    list = list.filter(l => {
      return (l.node_uuid && l.node_uuid.toLowerCase().includes(q)) ||
             (l.source_ip && l.source_ip.toLowerCase().includes(q)) ||
             (l.reason && l.reason.toLowerCase().includes(q)) ||
             (l.event && l.event.toLowerCase().includes(q))
    })
  }
  return list
})

// 复制通用方法
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

// 重置入网通行码
const resetJoinToken = async () => {
  if (confirm('确认重置集群入网通行码？旧通行码将立即失效，但已通过审批的节点不受影响。')) {
    const res = await props.api('/api/nodes/reset-join-token', { method: 'POST' })
    const data = await res.json()
    clusterJoinToken.value = data.join_token
    props.showToast('通行码已重置为最新紧凑凭证', 'success')
  }
}

// 审批认领通过
const approveNode = async (node) => {
  const res = await props.api(`/api/nodes/${node.id}/approve`, { method: 'POST' })
  const data = await res.json()
  props.showToast(data.message, 'success')
  loadBaseData()
}

// 拒绝待审节点
const rejectNode = async (node) => {
  if (confirm(`确认拒绝并清除待审节点 [${node.name}]？`)) {
    const res = await props.api(`/api/nodes/${node.id}/reject`, { method: 'POST' })
    const data = await res.json()
    props.showToast(data.message, 'success')
    loadBaseData()
  }
}

// 一键信任全部待审批节点
const approveAllPending = async () => {
  for (const n of pendingNodes.value) {
    await props.api(`/api/nodes/${n.id}/approve`, { method: 'POST' })
  }
  props.showToast(`已成功信任 ${pendingNodes.value.length} 个节点`, 'success')
  loadBaseData()
}

// 一键拒绝全部待审批节点
const rejectAllPending = async () => {
  if (confirm(`确认一键拒绝并清空全部 ${pendingNodes.value.length} 个待审批节点？`)) {
    for (const n of pendingNodes.value) {
      await props.api(`/api/nodes/${n.id}/reject`, { method: 'POST' })
    }
    props.showToast('已全部拒绝清理', 'success')
    loadBaseData()
  }
}

// 弹窗表单操作
const openCreateModal = () => {
  isEditMode.value = false
  editingNodeId.value = null
  Object.assign(nodeForm, {
    name: '',
    group_name: selectedFilterGroup.value || '默认分组',
    conn_type: 'direct',
    is_local: true,
    node_uuid: '',
    fingerprint: '',
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
    conn_type: node.conn_type || (node.is_local ? 'direct' : 'ssh'),
    is_local: Boolean(node.is_local),
    node_uuid: node.node_uuid || '',
    fingerprint: node.fingerprint || '',
    direct_host: node.direct_host || '127.0.0.1',
    ssh_host: node.ssh_host || '',
    ssh_port: node.ssh_port || 22,
    ssh_user: node.ssh_user || 'root',
    ssh_key_filename: node.ssh_key_filename || '',
    ssh_password: node.ssh_password || '',
    remote_cdp_port: node.remote_cdp_port || 9222,
    local_bind_port: node.local_bind_port || 9222
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
  props.showToast('正在探测目标 CDP 存量...', 'info')
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

onMounted(() => {
  loadBaseData()
  loadAuditLogs()
  pollTimer = setInterval(pollNodeStatus, 3000)
})

onUnmounted(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>

<template>
  <div class="content-full-card">

    <!-- ==================== 1. 入网凭证与 TOFU 准入控制横幅 ==================== -->
    <div class="token-deploy-banner">
      <div class="token-bar-flex">
        
        <!-- 左侧：通行码紧凑展示 -->
        <div class="token-left-wrap">
          <div class="token-title-group">
            <span class="token-key-icon">🔑</span>
            <span class="token-title-text">入网通行码 (Join Token)</span>
          </div>

          <div class="token-compact-chip" @click="copyText(clusterJoinToken, 'Join Token')" title="点击复制通行码">
            <span class="token-chip-val font-cyan-mono">{{ clusterJoinToken || '正在生成...' }}</span>
            <span class="token-copy-tag">复制</span>
          </div>
          <button @click="resetJoinToken" class="btn-micro btn-ghost-red" title="重置入网通行码">
            🔄 重置
          </button>
        </div>

        <!-- 中间：TOFU 准入控制开关集群 -->
        <div class="tofu-controls-cluster">
          <label class="switch-inline-label" title="开启后允许未配置 Token 的新设备上报进入待审队列">
            <input type="checkbox" v-model="tofuSettings.tofu_enabled" @change="updateTofuSettings" class="check-box-blue">
            <span :style="{ color: tofuSettings.tofu_enabled ? '#38bdf8' : '#64748b' }">允许 TOFU 待审接入</span>
          </label>

          <label 
            class="switch-inline-label" 
            :style="{ opacity: tofuSettings.tofu_enabled ? 1 : 0.4, cursor: tofuSettings.tofu_enabled ? 'pointer' : 'not-allowed' }"
            title="开启后，所有通过 TOFU 上报的无 Token 节点将直接全自动审批放行"
          >
            <input 
              type="checkbox" 
              v-model="tofuSettings.tofu_auto_approve" 
              :disabled="!tofuSettings.tofu_enabled"
              @change="updateTofuSettings" 
              class="check-box-blue"
            >
            <span :style="{ color: tofuSettings.tofu_auto_approve && tofuSettings.tofu_enabled ? '#34d399' : '#64748b' }">自动免审放行</span>
          </label>
        </div>

        <!-- 右侧：部署命令抽屉开关 -->
        <div class="token-right-wrap">
          <button @click="showDeployGuide = !showDeployGuide" class="btn-micro btn-guide-toggle">
            {{ showDeployGuide ? '收起命令 ▲' : '🚀 节点运行命令 ▼' }}
          </button>
        </div>
      </div>

      <!-- 部署代码折叠抽屉 -->
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
  -v ./data:/data \
  wimotek/chromium:novnc</code></pre>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px;">
            <span style="font-size:11px; color:#64748b;">* 若宿主机映射其他端口可追加 <code>-e DIRECT_PORT=3030</code>；非 root 容器需确保宿主机目录 <code>chown -R 1000:1000 ./data</code>。</span>
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
      # - DIRECT_PORT=3030
    volumes:
      - ./data:/data</code></pre>
        </div>
      </div>
    </div>

    <!-- ==================== 2. 三大板块 Tab 导航 ==================== -->
    <div class="table-header-bar">
      <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
        <button @click="activeTab = 'nodes'" :class="['nav-pill-btn', activeTab === 'nodes' ? 'nav-pill-active' : '']">
          👥 已受信任节点 ({{ trustedNodes.length }})
        </button>

        <button @click="activeTab = 'pending'" :class="['nav-pill-btn', activeTab === 'pending' ? 'nav-pill-active' : '']" style="position:relative;">
          ⏳ 待审批隔离区
          <span v-if="pendingNodes.length > 0" class="badge-pending-counter">{{ pendingNodes.length }}</span>
        </button>

        <button @click="activeTab = 'audit'; loadAuditLogs()" :class="['nav-pill-btn', activeTab === 'audit' ? 'nav-pill-active' : '']">
          📜 零信任准入审计日志
        </button>
      </div>

      <!-- Tab 1 右侧操作 -->
      <div v-if="activeTab === 'nodes'" style="display:flex; gap:10px; align-items:center;">
        <select v-model="selectedFilterGroup" class="sync-input font-mono" style="width:auto; height:32px; font-size:12px;">
          <option value="">📂 全部分组 ({{ trustedNodes.length }})</option>
          <option v-for="g in groups" :key="g" :value="g">📁 {{ g }}</option>
        </select>
        <button @click="openCreateModal" class="btn-primary-gradient">+ 新增接入节点</button>
        <button @click="loadBaseData" class="btn-primary-gradient">🔄 刷新</button>
      </div>

      <!-- Tab 2 右侧操作 -->
      <div v-else-if="activeTab === 'pending'" style="display:flex; gap:8px; align-items:center;">
        <button @click="approveAllPending" :disabled="pendingNodes.length === 0" class="btn-micro" style="background:#059669; padding:6px 12px; height:32px;">
          ⚡ 一键信任全部 ({{ pendingNodes.length }})
        </button>
        <button @click="rejectAllPending" :disabled="pendingNodes.length === 0" class="btn-micro btn-trash" style="padding:6px 12px; height:32px;">
          ❌ 批量拒绝清理
        </button>
        <button @click="loadBaseData" class="btn-primary-gradient">🔄 刷新</button>
      </div>

      <!-- Tab 3 右侧操作：【彻底根除大白底，注入暗黑极客主题】 -->
      <div v-else style="display:flex; gap:8px; align-items:center;">
        <select v-model="auditDecisionFilter" class="audit-filter-select font-mono">
          <option value="">⚖️ 全部判定决策</option>
          <option value="allow_token">🟢 allow_token (凭证信任)</option>
          <option value="allow_local">🟢 allow_local (本地信任)</option>
          <option value="allow_session">🟢 allow_session (会话信任)</option>
          <option value="pending_tofu">🟡 pending_tofu (待审批)</option>
          <option value="deny">🔴 deny (拦截拒绝)</option>
        </select>
        <input 
          v-model="auditSearchText" 
          placeholder="🔍 搜索 UUID / IP / 裁决原因..." 
          class="audit-search-input font-mono"
        >
      </div>
    </div>

    <!-- ==================== 视图 1：已受信任节点正式列表 ==================== -->
    <div v-if="activeTab === 'nodes'" class="table-responsive">
      <table class="cdp-fluid-table">
        <thead>
          <tr>
            <th style="width: 12%;">所属分组</th>
            <th style="width: 20%;">节点标识 (Node UUID)</th>
            <th style="width: 10%;">准入状态</th>
            <th style="width: 16%;">端点 / 映射端口</th>
            <th style="width: 10%;">Cookie 存量</th>
            <th style="width: 12%;">网络拓扑</th>
            <th style="width: 8%;">角色</th>
            <th style="width: 12%; text-align: right;">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="node in filteredNodes" :key="node.id" :class="[node.enabled === 0 ? 'row-node-disabled' : '']">
            <td>
              <span class="tag-group-pill">📁 {{ node.group_name || '默认分组' }}</span>
            </td>

            <td>
              <div class="cell-main-name">
                {{ node.name }}
                <span v-if="node.enabled === 0" style="font-size:10px; color:#f87171; margin-left:4px;">[已禁用]</span>
              </div>
              <div class="cell-sub-desc">
                <span v-if="node.conn_type === 'reverse'">指纹: {{ node.fingerprint ? node.fingerprint.slice(0, 16) + '...' : (node.node_uuid || 'Client') }}</span>
                <span v-else-if="node.is_local">直连: {{ node.direct_host || '127.0.0.1' }}</span>
                <span v-else>{{ node.ssh_user }}@{{ node.ssh_host }}:{{ node.ssh_port }}</span>
              </div>
            </td>

            <td>
              <span v-if="node.enabled === 0" class="status-standby">○ 已禁用</span>
              <span v-else-if="node.status === 'connected'" class="badge-status-trusted">● 已信任</span>
              <span v-else class="status-standby">○ 离线</span>
            </td>

            <td class="font-cyan-mono">
              <span v-if="node.conn_type === 'reverse'">Reverse-WSS (:{{ node.local_bind_port }})</span>
              <span v-else-if="node.recommended_endpoint">{{ node.recommended_endpoint }}</span>
              <span v-else>{{ node.is_local ? (node.direct_host || '127.0.0.1') : '127.0.0.1' }}:{{ node.local_bind_port }}</span>
            </td>

            <td>
              <div class="cookie-badge" @click="viewCookieDetails(node)" style="cursor:pointer;" title="查看 Cookie 明细">
                <span>🍪 {{ node.cookie_count || 0 }} 条</span>
              </div>
            </td>

            <td>
              <span v-if="node.conn_type === 'reverse'" class="tag-topo-reverse">
                {{ node.network_mode === 'reverse_tunnel' ? 'NAT4 反向隧道' : 'WSS 反向长连' }}
              </span>
              <span v-else-if="node.conn_type === 'ssh'" class="tag-topo-ssh">SSH 穿透</span>
              <span v-else class="tag-topo-direct">
                {{ node.network_mode || '本地直连' }}
              </span>
            </td>

            <td>
              <button v-if="node.is_source" @click="toggleSource(node.id)" class="btn-qrcode" style="background:#0284c7;">★ 默认源</button>
              <button v-else @click="toggleSource(node.id)" class="btn-set-source">设为源</button>
            </td>

            <td style="text-align: right;">
              <div class="btn-group-row">
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
                <button @click="probeNode(node)" :disabled="node.enabled === 0" class="btn-micro btn-purple">探针</button>
                <button @click="openEditModal(node)" class="btn-micro" style="background:#2563eb;">✏️</button>
                <button @click="deleteNode(node.id)" class="btn-micro btn-trash">🗑️</button>
              </div>
            </td>
          </tr>
          <tr v-if="filteredNodes.length === 0">
            <td colspan="8" style="text-align:center; color:#64748b; padding:32px;">暂无已信任的正式节点</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ==================== 视图 2：独立待审批隔离区子卡 ==================== -->
    <div v-else-if="activeTab === 'pending'" class="table-responsive">
      <div v-if="pendingNodes.length > 0" class="pending-workbench-header">
        <span style="font-size:12px; color:#fbbf24;">
          ⚠️ 隔离区当前共有 <b>{{ pendingNodes.length }}</b> 个设备等待审核。这些节点在独立信道中仅交换心跳，业务已完全阻断，经核验后方可接入。
        </span>
      </div>

      <table class="cdp-fluid-table">
        <thead>
          <tr>
            <th style="width: 22%;">待审节点标识 (UUID / Name)</th>
            <th style="width: 15%;">准入判定状态</th>
            <th style="width: 14%;">申报直连端口</th>
            <th style="width: 24%;">公钥证书指纹 (Fingerprint)</th>
            <th style="width: 11%;">接入信道</th>
            <th style="width: 14%; text-align: right;">审批操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="node in pendingNodes" :key="node.id" class="row-node-pending">
            <td>
              <div class="cell-main-name" style="color:#fbbf24;">{{ node.name }}</div>
              <div class="cell-sub-desc">UUID: {{ node.node_uuid }}</div>
            </td>

            <td>
              <span class="badge-status-pending">⏳ 待人工审批</span>
            </td>

            <td class="font-cyan-mono">
              :{{ node.local_bind_port }}
            </td>

            <td class="font-cyan-mono" style="font-size:11px;" :title="node.fingerprint">
              {{ node.fingerprint || '未上报指纹' }}
            </td>

            <td>
              <span class="tag-topo-reverse">WSS 隔离通道</span>
            </td>

            <td style="text-align: right;">
              <div class="btn-group-row">
                <button @click="approveNode(node)" class="btn-micro" style="background:#059669; padding:4px 10px;">
                  ✅ 批准入网
                </button>
                <button @click="rejectNode(node)" class="btn-micro btn-trash" style="padding:4px 10px;">
                  ❌ 拒绝清理
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="pendingNodes.length === 0">
            <td colspan="6" style="text-align:center; color:#34d399; padding:48px;">
              🎉 待审批隔离区已清空，当前暂无挂起的新接入设备！
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ==================== 视图 3：零信任准入审计流水 ==================== -->
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
          <tr v-for="(log, idx) in filteredAuditLogs" :key="idx">
            <td class="font-mono text-muted">{{ log.ts ? log.ts.replace('T', ' ').slice(0, 19) : '---' }}</td>
            <td class="font-mono" style="color:#cbd5e1;">{{ log.event || 'access_decision' }}</td>
            <td class="font-cyan-mono" :title="log.node_uuid">{{ log.node_uuid || '---' }}</td>
            <td class="font-mono">
              {{ log.source_ip || '---' }}
              <span v-if="log.is_loopback" class="badge-loopback">回环</span>
            </td>
            <td style="text-align: center;">
              <span v-if="log.decision === 'allow_token' || log.decision === 'allow_local' || log.decision === 'allow_session'" class="badge-decision-allow">
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
          <tr v-if="filteredAuditLogs.length === 0">
            <td colspan="7" style="text-align:center; color:#64748b; padding:32px;">暂无匹配的准入审计记录</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 弹窗：按类别隔离编辑 -->
    <div v-if="showNodeModal" class="modal-backdrop">
      <div class="modal-card">
        <div class="modal-title-bar">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:16px;">⚙️</span>
            <h3 style="font-size:14px; font-weight:bold; color:#fff;">
              {{ isEditMode ? '修改 CDP 实例配置' : '接入新 CDP 实例节点' }}
            </h3>
          </div>
          <button @click="showNodeModal = false" class="modal-close-btn">✕</button>
        </div>

        <form @submit.prevent="submitNodeForm" class="form-v-stack" style="margin-top:14px;">
          
          <div v-if="isEditMode && nodeForm.conn_type === 'reverse'" class="reverse-node-locked-box">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <span class="locked-badge-purple">🌐 接入类别：WSS 反向长连接</span>
              <span class="locked-tag-lock">🔒 边缘 Agent 托管信道 (不可切换)</span>
            </div>
            <p style="font-size:11px; color:#cbd5e1; margin:0; line-height:1.5;">
              该节点通过出站 WSS 建立长连接，通信由加密反向隧道承载，无需配置直连 IP。
            </p>
          </div>

          <div v-else class="form-field-block">
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

          <div v-if="isEditMode && nodeForm.conn_type === 'reverse'" class="form-v-stack">
            <div class="row-flex-gap">
              <div class="form-field-block" style="flex:1;">
                <label class="form-label">通信通道 <span style="color:#64748b;">[反向隧道托管]</span></label>
                <input value="reverse-nat4 (WSS长连接信道)" disabled class="cdp-input cdp-disabled font-cyan-mono" style="width:100% !important;">
              </div>
              <div class="form-field-block" style="flex:1;">
                <label class="form-label">申报/映射 CDP 端口 (如 3030)</label>
                <input v-model="nodeForm.local_bind_port" type="number" required class="cdp-input font-cyan-mono" style="width:100% !important;">
              </div>
            </div>

            <div class="row-flex-gap">
              <div class="form-field-block" style="flex:1;">
                <label class="form-label">节点唯一标识 (UUID) <span style="color:#64748b;">[只读]</span></label>
                <input v-model="nodeForm.node_uuid" disabled class="cdp-input cdp-disabled font-cyan-mono" style="width:100% !important;">
              </div>
              <div class="form-field-block" style="flex:1;">
                <label class="form-label">公钥证书指纹 (Fingerprint) <span style="color:#64748b;">[防篡改]</span></label>
                <input v-model="nodeForm.fingerprint" disabled class="cdp-input cdp-disabled font-cyan-mono" style="width:100% !important; font-size:11px;">
              </div>
            </div>
          </div>

          <div v-else-if="nodeForm.is_local" style="background:#09122a; padding:12px; border-radius:6px; border:1px solid #172554;">
            <div class="row-flex-gap">
              <div class="form-field-block" style="flex:1;">
                <label class="form-label">直连 IP / 局域网域名</label>
                <input v-model="nodeForm.direct_host" required placeholder="127.0.0.1 或 192.168.x.x" class="cdp-input font-cyan-mono" style="width:100% !important;">
              </div>
              <div class="form-field-block">
                <label class="form-label">CDP 调试端口 (默认 9222)</label>
                <input v-model="nodeForm.local_bind_port" type="number" required class="cdp-input cdp-w-port font-cyan-mono">
              </div>
            </div>
          </div>

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
            <button type="submit" class="btn-primary-gradient">保存修改</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 弹窗：Cookie 详情 -->
    <div v-if="showCookieModal" class="modal-backdrop">
      <div class="modal-card cookie-modal-wide">
        <div class="modal-title-bar">
          <h3 style="font-size:14px; font-weight:bold; color:#fff;">节点 [{{ cookieDetails.node_name }}] Cookie 生命周期与有效性分析</h3>
          <button @click="showCookieModal = false" class="modal-close-btn">✕</button>
        </div>
        <div style="margin-top:12px;">
          <div class="cookie-stat-row">
            <span class="cookie-stat-badge">总数: <b>{{ cookieDetails.total }}</b></span>
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
/* ==================== 准入审计过滤专属深色控件 (彻底根除大白底) ==================== */
.audit-filter-select,
.audit-search-input {
  box-sizing: border-box !important;
  background-color: #060b17 !important;
  border: 1px solid #172554 !important;
  color: #e2e8f0 !important;
  border-radius: 6px !important;
  outline: none !important;
  font-family: monospace !important;
  font-size: 12px !important;
  height: 32px !important;
  transition: all 0.2s ease !important;
}

.audit-filter-select {
  width: auto !important;
  padding: 2px 10px !important;
  cursor: pointer !important;
}

.audit-search-input {
  width: 250px !important;
  padding: 2px 10px !important;
}

.audit-filter-select:focus,
.audit-search-input:focus {
  border-color: #00f0ff !important;
  box-shadow: 0 0 8px rgba(0, 240, 255, 0.35) !important;
  background-color: #081126 !important;
}

.audit-filter-select option {
  background-color: #0b132b !important;
  color: #e2e8f0 !important;
  padding: 4px 8px !important;
}

/* 紧凑型通行码与策略横幅 */
.token-deploy-banner {
  background: #09122a;
  border: 1px solid #1e3a8a;
  border-radius: 8px;
  padding: 8px 14px;
  margin-bottom: 16px;
  box-sizing: border-box;
}

.token-bar-flex {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.token-left-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}

.token-title-group {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.token-key-icon { font-size: 15px; }
.token-title-text { font-size: 13px; font-weight: bold; color: #f8fafc; }

.token-compact-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: #060b17;
  border: 1px solid #172554;
  border-radius: 6px;
  padding: 4px 8px 4px 10px;
  cursor: pointer;
  transition: all 0.2s ease;
  max-width: 440px;
}
.token-compact-chip:hover {
  border-color: #00f0ff;
  background: #0b1739;
}

.token-chip-val {
  font-size: 12px;
  color: #00f0ff;
  letter-spacing: 0.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.token-copy-tag {
  font-size: 11px;
  color: #38bdf8;
  background: #0f274a;
  border: 1px solid #0284c7;
  border-radius: 4px;
  padding: 1px 6px;
  white-space: nowrap;
}
.token-compact-chip:hover .token-copy-tag {
  background: #0284c7;
  color: #ffffff;
}

/* 中间：TOFU 准入开关组件 */
.tofu-controls-cluster {
  display: flex;
  align-items: center;
  gap: 14px;
  background: #060b17;
  border: 1px solid #172554;
  padding: 4px 12px;
  border-radius: 6px;
}
.switch-inline-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  user-select: none;
  cursor: pointer;
}
.check-box-blue {
  width: 14px;
  height: 14px;
  accent-color: #0284c7;
  cursor: pointer;
}

.token-right-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.btn-ghost-red {
  background: rgba(185, 28, 28, 0.15);
  border: 1px solid #dc2626;
  color: #f87171;
}
.btn-ghost-red:hover { background: #dc2626; color: #ffffff; }

.btn-guide-toggle {
  background: #1e293b;
  border: 1px solid #334155;
  color: #38bdf8;
  font-weight: 600;
}
.btn-guide-toggle:hover { background: #0284c7; border-color: #0284c7; color: #ffffff; }

.deploy-guide-panel {
  margin-top: 10px;
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.nav-pill-active {
  background: #1e3a8a;
  border-color: #3b82f6;
  color: #ffffff;
  font-weight: bold;
}
.badge-pending-counter {
  background: #d97706;
  color: #ffffff;
  font-size: 10px;
  font-weight: bold;
  padding: 1px 6px;
  border-radius: 9999px;
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0% { transform: scale(1); }
  50% { transform: scale(1.15); }
  100% { transform: scale(1); }
}

/* 待审工作台头部 */
.pending-workbench-header {
  background: rgba(217, 119, 6, 0.1);
  border: 1px solid #d97706;
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 12px;
}

/* 状态徽章 */
.badge-status-trusted {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid #059669;
  color: #34d399;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
}
.badge-status-pending {
  background: rgba(217, 119, 6, 0.15);
  border: 1px solid #d97706;
  color: #fbbf24;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
}

/* 拓扑标签体系 */
.tag-topo-reverse {
  background: rgba(139, 92, 246, 0.2);
  border: 1px solid #8b5cf6;
  color: #c4b5fd;
  border-radius: 4px;
  padding: 2px 8px;
  font-family: monospace;
  font-size: 11px;
  font-weight: 500;
}
.tag-topo-direct {
  background: rgba(2, 132, 199, 0.15);
  border: 1px solid #0284c7;
  color: #38bdf8;
  border-radius: 4px;
  padding: 2px 8px;
  font-family: monospace;
  font-size: 11px;
}
.tag-topo-ssh {
  background: rgba(49, 46, 129, 0.4);
  border: 1px solid #4f46e5;
  color: #a5b4fc;
  border-radius: 4px;
  padding: 2px 8px;
  font-family: monospace;
  font-size: 11px;
}

/* 锁定与只读容器 */
.reverse-node-locked-box {
  background: #0f172a;
  border: 1px solid #3b82f6;
  border-radius: 6px;
  padding: 10px 14px;
  margin-bottom: 8px;
}
.locked-badge-purple {
  color: #a78bfa;
  font-size: 12px;
  font-weight: bold;
}
.locked-tag-lock {
  font-size: 11px;
  color: #94a3b8;
  background: #1e293b;
  padding: 2px 6px;
  border-radius: 4px;
}
.cdp-disabled {
  background-color: #090f1d !important;
  color: #64748b !important;
  border-color: #1e293b !important;
  cursor: not-allowed !important;
}

/* 准入审计表格 */
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

/* 原版继承样式 */
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
  background-color: #334155 !important;
  color: #cbd5e1 !important;
}
.btn-pause-node:hover {
  background-color: #475569 !important;
  color: #fff !important;
}
.btn-resume-node {
  background-color: #065f46 !important;
  color: #34d399 !important;
  border: 1px solid #059669 !important;
}
.btn-resume-node:hover {
  background-color: #047857 !important;
  color: #fff !important;
}
</style>