<template>
  <div class="cyber-card tab-content-card">
    <!-- ========================================================================= -->
    <!-- 1. 顶栏：集群引导令牌与 TOFU 总开关 + 免审核子开关 (严格还原图二层级) -->
    <!-- ========================================================================= -->
    <div class="cluster-security-banner">
      <!-- 左侧：集群引导令牌 (Cluster Token) -->
      <div class="banner-left">
        <div class="token-title-row">
          <span class="shield-icon">🛡️</span>
          <b style="color: #f8fafc; font-size: 13px;">集群引导令牌 (Cluster Token):</b>
          <span class="cluster-token-code">{{ maskedClusterToken }}</span>
          <button class="btn-xs btn-action" title="一键复制集群通信令牌" @click="copyText(clusterInfo.cluster_token, '集群通信令牌')">
            📋 复制令牌
          </button>
          <button class="btn-xs btn-reset" title="轮换重置令牌 (已在线节点不受影响)" @click="handleRegenerateClusterToken">
            🔄 轮换重置
          </button>
        </div>
        <div class="banner-hint">
          新节点首次握手入网凭证。支持 Ed25519 双向公私钥锁定，私钥本地就地生成永不离机。
        </div>
      </div>

      <!-- 右侧：TOFU 首次信任总开关 + 免审核准入子开关 + 部署指引 -->
      <div class="banner-right">
        <div class="tofu-switches-card">
          <!-- 主开关：TOFU 首次信任接入 -->
          <div class="switch-row main-switch-row">
            <div class="switch-info">
              <span class="lightning-icon">⚡</span>
              <span class="switch-label-text">TOFU 首次信任接入:</span>
              <span class="switch-status-pill" :class="clusterInfo.tofu_enabled ? 'pill-active' : 'pill-disabled'">
                {{ clusterInfo.tofu_enabled ? '🟢 总开关已开启' : '🔴 总开关已关闭' }}
              </span>
            </div>
            <label class="switch-btn-wrap">
              <input type="checkbox" v-model="clusterInfo.tofu_enabled" @change="handleToggleTofuEnabled" />
              <span class="switch-btn-text" :class="{ active: clusterInfo.tofu_enabled }">
                <span class="check-icon">{{ clusterInfo.tofu_enabled ? '✓' : '' }}</span>
                {{ clusterInfo.tofu_enabled ? '启用中' : '已停用' }}
              </span>
            </label>
          </div>

          <!-- 子开关：新节点免审核准入 (依赖主开关) -->
          <div class="switch-row sub-switch-row">
            <div class="switch-info">
              <span class="sub-tree-prefix">└─</span>
              <span class="switch-label-text">新节点免审核准入:</span>
              <span v-if="!clusterInfo.tofu_enabled" class="switch-status-pill pill-warning">
                ⚠️ 需先开启 TOFU
              </span>
              <span v-else class="switch-status-pill" :class="clusterInfo.auto_approve ? 'pill-active' : 'pill-amber'">
                {{ clusterInfo.auto_approve ? '🟢 免审核直连' : '🔒 待审隔离' }}
              </span>
            </div>
            <label class="switch-btn-wrap" :class="{ disabled: !clusterInfo.tofu_enabled }">
              <input
                type="checkbox"
                v-model="clusterInfo.auto_approve"
                :disabled="!clusterInfo.tofu_enabled"
                @change="handleToggleAutoApprove"
              />
              <span class="switch-btn-text" :class="{ active: clusterInfo.auto_approve && clusterInfo.tofu_enabled }">
                <span class="check-icon">{{ clusterInfo.auto_approve && clusterInfo.tofu_enabled ? '✓' : '' }}</span>
                {{ clusterInfo.auto_approve && clusterInfo.tofu_enabled ? '免审上线' : '待审隔离' }}
              </span>
            </label>
          </div>
        </div>

        <button class="btn-cyber-primary btn-deploy-snippet" @click="showDeployModal = true">
          🚀 部署指引
        </button>
      </div>
    </div>

    <!-- ========================================================================= -->
    <!-- 2. 二级选项卡导航 (严格还原图二样式与徽章) -->
    <!-- ========================================================================= -->
    <div class="sub-nav-tabs">
      <button
        class="sub-tab-btn"
        :class="{ active: currentSubTab === 'approved' }"
        @click="currentSubTab = 'approved'"
      >
        🌐 已准入节点集群 ({{ approvedNodes.length }})
      </button>
      <button
        class="sub-tab-btn"
        :class="{ active: currentSubTab === 'pending' }"
        @click="currentSubTab = 'pending'"
      >
        🟡 待审批节点隔离区
        <span v-if="pendingNodes.length > 0" class="sub-count-badge badge-amber">
          {{ pendingNodes.length }}
        </span>
      </button>
      <button
        class="sub-tab-btn"
        :class="{ active: currentSubTab === 'audit' }"
        @click="currentSubTab = 'audit'"
      >
        📜 节点安全审计流水
        <span v-if="auditLogsList.length > 0" class="sub-count-badge badge-slate">
          {{ auditLogsList.length }}
        </span>
      </button>
      <button
        class="sub-tab-btn"
        :class="{ active: currentSubTab === 'deploy' }"
        @click="currentSubTab = 'deploy'"
      >
        💻 Docker 部署脚本与参数
      </button>
    </div>

    <!-- ========================================================================= -->
    <!-- 子卡 1：已准入节点集群列表 -->
    <!-- ========================================================================= -->
    <div v-if="currentSubTab === 'approved'">
      <div class="card-header" style="margin-top: 15px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <h3>🌐 已准入节点集群治理与多端调度</h3>
          <span class="badge badge-ready">{{ approvedNodes.length }} 个节点运行中</span>
        </div>
        <div class="header-right-note">
          已全量绑定 Ed25519 密码学公钥，下发给用户客户端与通用订阅。
        </div>
      </div>

      <div class="table-container">
        <table class="cyber-table">
          <thead>
            <tr>
              <th>节点名称 / 连接地址</th>
              <th>准入状态</th>
              <th>服务状态</th>
              <th>开放范围策略</th>
              <th>SNI 伪装域名</th>
              <th>公钥 (PublicKey)</th>
              <th>心跳检测状态</th>
              <th style="width: 260px;">治理操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="node in approvedNodes" :key="node.id" :class="{ 'node-disabled-row': node.status === 0 }">
              <td>
                <div style="font-weight: 700; color: #f8fafc; display: flex; align-items: center; gap: 6px;">
                  <span>{{ node.name }}</span>
                  <span v-if="node.net_mode === 'reverse_wss'" class="net-mode-pill pill-wss">
                    🔀 WSS反穿
                  </span>
                  <span v-else class="net-mode-pill pill-direct">
                    🌐 公网直连
                  </span>
                </div>
                <div style="font-size: 11px; color: #38bdf8; font-family: monospace;">{{ node.ip }}:{{ node.port }}</div>
              </td>

              <!-- 准入状态 -->
              <td>
                <span class="badge badge-approved" title="节点已通过身份认证并锁定">
                  🛡️ 已准入
                </span>
              </td>

              <!-- 服务运行状态 -->
              <td>
                <span class="badge" :class="node.status === 1 ? 'badge-ready' : 'badge-disabled'">
                  {{ node.status === 1 ? '🟢 运行中' : '🛑 已停止' }}
                </span>
              </td>

              <!-- 开放范围策略 -->
              <td>
                <span v-if="node.status === 0" class="badge badge-disabled">
                  🚫 服务已停
                </span>
                <span v-else-if="node.allow_all === 1" class="badge badge-public">
                  🌐 全体公开
                </span>
                <span v-else class="badge badge-restricted" :title="`组: ${node.allowed_groups || '无'} | 人: ${node.allowed_users || '无'}`">
                  🎯 定向授权 ({{ getScopeSummary(node) }})
                </span>
              </td>

              <td>
                <div style="font-size: 12px; color: #38bdf8;">{{ node.sni }}</div>
                <div v-if="node.server_names && node.server_names.includes(',')" style="font-size: 10px; color: #94a3b8;">
                  多SNI: {{ node.server_names.split(',').length }} 个
                </div>
              </td>

              <!-- 公钥纯文本 + 复制按钮 -->
              <td>
                <div v-if="node.pbk && node.pbk.length === 43" class="pbk-box">
                  <span class="pbk-clean-text" :title="`完整公钥: ${node.pbk}`">{{ formatPbk(node.pbk) }}</span>
                  <button class="btn-copy-icon" title="点击复制完整公钥" @click="copyText(node.pbk, '节点公钥')">
                    📋
                  </button>
                </div>
                <div v-else>
                  <span class="text-muted" style="font-size: 11px;">⚠️ 待回传</span>
                </div>
              </td>

              <!-- 心跳状态 -->
              <td>
                <span
                  class="heartbeat-badge"
                  :class="getHeartbeatInfo(node.last_heartbeat).cls"
                  :title="`最后心跳: ${node.last_heartbeat || '无记录'} (${getHeartbeatInfo(node.last_heartbeat).diff})`"
                >
                  <span class="status-dot"></span>
                  <span>{{ getHeartbeatInfo(node.last_heartbeat).label }}</span>
                </span>
              </td>

              <td>
                <div class="action-btn-row">
                  <button class="btn-sm btn-edit" @click="openConfigModal(node)">⚙️ 配置</button>
                  <button class="btn-sm btn-perm" @click="openPermModal(node)">🔐 权限</button>
                  <button class="btn-sm btn-reset" @click="handleForceResync(node.node_id)" title="清空公钥让节点重新上报">🔄 接纳</button>
                  <button class="btn-sm btn-del" @click="handleRevokeDelete(node.node_id)" title="从集群中删除该节点">🗑️</button>
                </div>
              </td>
            </tr>
            <tr v-if="approvedNodes.length === 0">
              <td colspan="8" style="text-align: center; color: #64748b; padding: 24px;">
                暂无已准入的在线节点，请在上方复制部署命令并在海外服务器或内网主机启动节点。
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========================================================================= -->
    <!-- 子卡 2：待审批节点隔离区 (独立子卡) -->
    <!-- ========================================================================= -->
    <div v-else-if="currentSubTab === 'pending'">
      <div class="quarantine-alert-box">
        <div class="quarantine-alert-top">
          <div class="alert-title-row">
            <span class="text-lg">🟡</span>
            <strong style="color: #fcd34d; font-size: 14px;">零信任待审批隔离区 (Zero-Trust Quarantine Pool)</strong>
            <span class="badge badge-quarantine">{{ pendingNodes.length }} 个节点待审查</span>
          </div>
          <button
            v-if="pendingNodes.length > 0"
            class="btn-cyber-success"
            style="font-size: 11px; padding: 4px 12px;"
            @click="pendingNodes.forEach(n => handleApproveNode(n))"
          >
            ✅ 全部一键批准上线
          </button>
        </div>
        <p class="quarantine-desc">
          当关闭免审核或节点首次接入时强制隔离于此。<strong>隔离期间绝不向下发真实用户订阅</strong>，彻底杜绝探针探测。审查无误后点击“批准上线”即可接入业务。
        </p>
      </div>

      <div class="table-container">
        <table class="cyber-table">
          <thead>
            <tr>
              <th>节点名称 / 上报 IP</th>
              <th>网络模式</th>
              <th>公钥指纹 (Ed25519)</th>
              <th>最后心跳时间</th>
              <th>心跳探测</th>
              <th style="width: 220px;">审查与准入操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="node in pendingNodes" :key="node.id" class="node-quarantine-row">
              <td>
                <div style="font-weight: 700; color: #f8fafc;">{{ node.name }}</div>
                <div style="font-size: 11px; color: #f59e0b; font-family: monospace;">{{ node.ip }}:{{ node.port }}</div>
              </td>
              <td>
                <span v-if="node.net_mode === 'reverse_wss'" class="net-mode-pill pill-wss">
                  🔀 WSS反穿
                </span>
                <span v-else class="net-mode-pill pill-direct">
                  🌐 公网直连
                </span>
              </td>
              <td>
                <div class="pbk-box">
                  <span class="pbk-clean-text">{{ formatPbk(node.pbk) }}</span>
                  <button class="btn-copy-icon" @click="copyText(node.pbk, '节点公钥')">📋</button>
                </div>
              </td>
              <td style="font-size: 12px; color: #94a3b8; font-family: monospace;">
                {{ node.last_heartbeat || '刚刚' }}
              </td>
              <td>
                <span class="heartbeat-badge" :class="getHeartbeatInfo(node.last_heartbeat).cls">
                  <span class="status-dot"></span>
                  <span>{{ getHeartbeatInfo(node.last_heartbeat).label }}</span>
                </span>
              </td>
              <td>
                <div class="action-btn-row">
                  <button class="btn-sm btn-approve" @click="handleApproveNode(node)">
                    ✅ 批准上线
                  </button>
                  <button class="btn-sm btn-del" @click="handleRevokeDelete(node.node_id)">
                    ❌ 拒绝移除
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="pendingNodes.length === 0">
              <td colspan="6" style="text-align: center; color: #64748b; padding: 36px;">
                🎉 隔离区当前为空，所有已知节点均已审核上线。
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========================================================================= -->
    <!-- 子卡 3：节点安全审计流水 (独立子卡) -->
    <!-- ========================================================================= -->
    <div v-else-if="currentSubTab === 'audit'">
      <div class="card-header" style="margin-top: 15px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <h3>📜 节点通信与准入安全审计流水</h3>
          <span class="badge badge-ready">{{ auditLogsList.length }} 条记录</span>
        </div>
        <button class="btn-cyber-refresh" @click="fetchNodes">🔄 刷新流水</button>
      </div>

      <div class="table-container">
        <table class="cyber-table">
          <thead>
            <tr>
              <th style="width: 160px;">时间</th>
              <th style="width: 90px;">级别</th>
              <th style="width: 170px;">事件类型</th>
              <th style="width: 140px;">节点 ID / IP</th>
              <th>审计详情说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in auditLogsList" :key="log.id">
              <td style="font-size: 11px; font-family: monospace; color: #94a3b8;">
                {{ log.created_at }}
              </td>
              <td>
                <span class="badge" :class="log.level === 'warn' || log.level === 'security' ? 'badge-quarantine' : 'badge-ready'">
                  {{ log.level }}
                </span>
              </td>
              <td style="font-size: 11px; font-family: monospace; color: #38bdf8;">
                {{ log.event_type }}
              </td>
              <td style="font-size: 11px; font-family: monospace; color: #cbd5e1;">
                {{ log.node_id || log.ip || '-' }}
              </td>
              <td style="font-size: 12px; color: #e2e8f0;">
                {{ log.message }}
              </td>
            </tr>
            <tr v-if="auditLogsList.length === 0">
              <td colspan="5" style="text-align: center; color: #64748b; padding: 24px;">
                暂无审计流水记录。
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ========================================================================= -->
    <!-- 子卡 4：Docker 部署脚本与参数 -->
    <!-- ========================================================================= -->
    <div v-else-if="currentSubTab === 'deploy'">
      <div class="deploy-tab-box">
        <h4 style="color: #38bdf8; margin-top: 0;">💻 边缘节点 Docker Compose 一键接入脚本</h4>
        <p class="modal-tip">
          在需要接入的海外 VPS 或内网主机上新建 <code>docker-compose.yml</code> 并粘贴如下配置，执行 <code>docker compose up -d</code>：
        </p>
        <div class="code-editor-box">
          <pre class="yaml-code-view">{{ generatedDockerComposeYaml }}</pre>
        </div>
        <div style="margin-top: 14px;">
          <button class="btn-cyber-primary" @click="copyText(generatedDockerComposeYaml, 'Docker Compose 配置')">
            📋 复制完整 YAML 配置
          </button>
        </div>
      </div>
    </div>

    <!-- 弹窗 1：部署指引弹窗 -->
    <div v-if="showDeployModal" class="modal-backdrop" @click="showDeployModal = false">
      <div class="cyber-modal" style="max-width: 620px; text-align: left;" @click.stop>
        <h3>🚀 海外节点一键 Docker Compose 部署配置</h3>
        <p class="modal-tip">
          在海外 VPS 上创建 <code>docker-compose.yml</code> 并粘贴如下内容，执行 <code>docker compose up -d</code> 即可自动建立 TOFU 信任上线：
        </p>
        <div class="code-editor-box">
          <pre class="yaml-code-view">{{ generatedDockerComposeYaml }}</pre>
        </div>
        <div class="btn-group" style="justify-content: space-between; margin-top: 18px;">
          <button class="btn-cyber-primary" @click="copyText(generatedDockerComposeYaml, 'Docker Compose 部署配置')">
            📋 复制完整 YAML 配置
          </button>
          <button class="btn-cyber-action" @click="showDeployModal = false">关闭窗口</button>
        </div>
      </div>
    </div>

    <!-- 弹窗 2：⚙️ 节点网络配置 -->
    <div v-if="showConfigModal" class="modal-backdrop" @click="showConfigModal = false">
      <div class="cyber-modal" style="max-width: 520px; text-align: left;" @click.stop>
        <h3>⚙️ 节点网络配置 [{{ configForm.name }}]</h3>
        <div class="form-item" style="margin-top: 14px;">
          <label>节点对外展示名称</label>
          <input v-model="configForm.name" type="text" class="cyber-input modal-input" />
        </div>
        <div style="display: flex; gap: 10px;">
          <div class="form-item" style="flex: 1;">
            <label>节点连接地址 (支持 IP 或 域名)</label>
            <input v-model="configForm.ip" type="text" class="cyber-input modal-input" />
          </div>
          <div class="form-item" style="width: 110px;">
            <label>监听端口</label>
            <input v-model.number="configForm.port" type="number" class="cyber-input modal-input" />
          </div>
        </div>
        <div class="form-item">
          <label>伪装目标域名 (dest)</label>
          <input v-model="configForm.dest" type="text" class="cyber-input modal-input" />
        </div>
        <div class="form-item">
          <label>多 SNI 域名轮换池 (逗号隔开)</label>
          <input v-model="configForm.server_names" type="text" class="cyber-input modal-input" />
        </div>
        <div class="form-item">
          <label>ShortId 认证标识</label>
          <input v-model="configForm.sid" type="text" class="cyber-input modal-input" />
        </div>
        <div class="form-item">
          <label>专属通信密钥 (Node Key - TOFU 已固化)</label>
          <input v-model="configForm.node_key" type="text" class="cyber-input modal-input font-mono" />
        </div>
        <div class="btn-group" style="justify-content: flex-end; margin-top: 20px;">
          <button class="btn-cyber-action" @click="showConfigModal = false">取消</button>
          <button class="btn-cyber-primary" @click="submitNodeConfig">保存网络配置</button>
        </div>
      </div>
    </div>

    <!-- 弹窗 3：🔐 节点启停与权限策略 -->
    <div v-if="showPermModal" class="modal-backdrop" @click="showPermModal = false">
      <div class="cyber-modal" style="max-width: 520px; text-align: left;" @click.stop>
        <h3>🔐 节点启停与权限策略 [{{ permForm.name }}]</h3>
        <div class="form-item" style="margin-top: 14px;">
          <label>节点运行状态 (单选启停)</label>
          <div class="radio-group">
            <label class="radio-label">
              <input type="radio" :value="1" v-model.number="permForm.status" /> 🟢 启用节点
            </label>
            <label class="radio-label">
              <input type="radio" :value="0" v-model.number="permForm.status" /> 🛑 停止节点
            </label>
          </div>
        </div>
        <div class="form-item" style="border-top: 1px dashed rgba(255,255,255,0.08); padding-top: 12px;">
          <label>授权开放范围 (单选，默认全体公开)</label>
          <div class="radio-group">
            <label class="radio-label">
              <input type="radio" :value="1" v-model.number="permForm.allow_all" /> 🌐 全部用户可用 (公开节点)
            </label>
            <label class="radio-label">
              <input type="radio" :value="0" v-model.number="permForm.allow_all" /> 🎯 定向授权 (指定组或特定用户)
            </label>
          </div>
        </div>
        <div v-if="permForm.allow_all === 0" class="permission-sub-box">
          <div class="form-item">
            <label>允许访问的用户组 (如: vip, pro)</label>
            <input v-model="permForm.allowed_groups" type="text" class="cyber-input modal-input" />
          </div>
          <div class="form-item" style="margin-top: 8px;">
            <label>允许访问的特定用户 (用户名或邮箱)</label>
            <input v-model="permForm.allowed_users" type="text" class="cyber-input modal-input" />
          </div>
        </div>
        <div class="btn-group" style="justify-content: flex-end; margin-top: 20px;">
          <button class="btn-cyber-action" @click="showPermModal = false">取消</button>
          <button class="btn-cyber-success" @click="submitNodePermission">保存权限策略</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

const props = defineProps({
  currentUser: { type: Object, required: true },
  adminPassword: { type: String, required: true }
})

const emit = defineEmits(['reload-all'])

const currentSubTab = ref('approved')
const adminNodes = ref([])
const auditLogsList = ref([])

const clusterInfo = reactive({
  cluster_token: '',
  tofu_enabled: true,
  auto_approve: true,
  panel_url: ''
})

const approvedNodes = computed(() => adminNodes.value.filter(n => n.is_approved === undefined || n.is_approved === 1))
const pendingNodes = computed(() => adminNodes.value.filter(n => n.is_approved === 0))

const showDeployModal = ref(false)
const showConfigModal = ref(false)
const showPermModal = ref(false)

const configForm = reactive({
  node_id: '',
  name: '',
  ip: '',
  port: 443,
  dest: '',
  server_names: '',
  sid: '',
  node_key: ''
})

const permForm = reactive({
  node_id: '',
  name: '',
  status: 1,
  allow_all: 1,
  allowed_groups: '',
  allowed_users: ''
})

const maskedClusterToken = computed(() => {
  const t = clusterInfo.cluster_token || ''
  if (t.length <= 12) return t
  return `${t.slice(0, 8)}...${t.slice(-6)}`
})

const generatedDockerComposeYaml = computed(() => {
  const panelUrl = clusterInfo.panel_url || window.location.origin
  const token = clusterInfo.cluster_token || 'your_cluster_token'
  return `services:
  xray-node:
    image: ghcr.io/wimotek/xray:latest
    container_name: xray-node
    restart: always
    network_mode: host
    environment:
      - PANEL_URL=${panelUrl}
      - CLUSTER_TOKEN=${token}
      - NET_MODE=auto # auto / direct / reverse_wss
      - PORT=443
      - DEST=www.microsoft.com:443
      - SERVER_NAMES=www.microsoft.com,microsoft.com
    volumes:
      - ./data:/data
`
})

const formatPbk = (pbk) => {
  if (!pbk || pbk.length < 14) return pbk || ''
  return `${pbk.slice(0, 7)}...${pbk.slice(-6)}`
}

const copyText = (text, label) => {
  if (!text) return
  navigator.clipboard.writeText(text).then(() => {
    ElMessage.success(`${label}已复制到剪贴板！`)
  }).catch(() => {
    ElMessage.error('复制失败')
  })
}

const getHeartbeatInfo = (lastHeartbeat) => {
  if (!lastHeartbeat || lastHeartbeat.includes('等待') || lastHeartbeat.includes('下线')) {
    return { label: lastHeartbeat || '未上线', diff: '无心跳', cls: 'badge-disabled' }
  }
  const t = new Date(lastHeartbeat.replace(/-/g, '/')).getTime()
  if (isNaN(t)) {
    return { label: '未知', diff: lastHeartbeat, cls: 'badge-disabled' }
  }

  const diffSec = Math.floor((Date.now() - t) / 1000)
  if (diffSec < 0 || diffSec <= 90) {
    const diffText = diffSec <= 10 ? '刚刚' : `${diffSec}秒前`
    return { label: '在线 (活跃)', diff: diffText, cls: 'badge-ready' }
  } else if (diffSec <= 300) {
    const diffText = `${Math.floor(diffSec / 60)}分钟前`
    return { label: '延迟', diff: diffText, cls: 'badge-restricted' }
  } else {
    const diffText = `${Math.floor(diffSec / 60)}分钟前`
    return { label: '离线', diff: diffText, cls: 'badge-disabled' }
  }
}

const getScopeSummary = (node) => {
  const parts = []
  if (node.allowed_groups) parts.push(`${node.allowed_groups.split(',').length}个组`)
  if (node.allowed_users) parts.push(`${node.allowed_users.split(',').length}人`)
  return parts.length ? parts.join('+') : '未指派'
}

const fetchNodes = async () => {
  try {
    const res = await axios.post('/api/admin/data', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword
    })
    if (res.data.code === 200) {
      adminNodes.value = res.data.nodes || []
      auditLogsList.value = res.data.audit_logs || []
      if (res.data.cluster_info) {
        clusterInfo.cluster_token = res.data.cluster_info.cluster_token
        clusterInfo.tofu_enabled = res.data.cluster_info.tofu_enabled !== undefined ? res.data.cluster_info.tofu_enabled : true
        clusterInfo.auto_approve = res.data.cluster_info.auto_approve !== undefined ? res.data.cluster_info.auto_approve : true
        clusterInfo.panel_url = res.data.cluster_info.panel_url
      }
    }
  } catch (_) {
    ElMessage.error('拉取集群数据失败')
  }
}

onMounted(() => {
  fetchNodes()
})

const handleToggleTofuEnabled = async () => {
  try {
    const res = await axios.post('/api/admin/cluster/token', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      tofu_enabled: clusterInfo.tofu_enabled
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('TOFU总开关切换失败')
  }
}

const handleToggleAutoApprove = async () => {
  try {
    const res = await axios.post('/api/admin/cluster/token', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      auto_approve: clusterInfo.auto_approve
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('准入模式切换失败')
  }
}

const handleRegenerateClusterToken = async () => {
  if (!confirm('确定轮换重置集群引导令牌吗？旧令牌将立即失效。')) return
  try {
    const res = await axios.post('/api/admin/cluster/token', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      action: 'regenerate'
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      clusterInfo.cluster_token = res.data.cluster_token
    }
  } catch (_) {
    ElMessage.error('令牌重置失败')
  }
}

const handleApproveNode = async (node) => {
  try {
    const res = await axios.post('/api/admin/nodes/approve', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      node_id: node.node_id
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      fetchNodes()
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('审批激活失败')
  }
}

const openConfigModal = (node) => {
  configForm.node_id = node.node_id
  configForm.name = node.name
  configForm.ip = node.ip || ''
  configForm.port = node.port
  configForm.dest = node.dest || 'www.microsoft.com:443'
  configForm.server_names = node.server_names || node.sni
  configForm.sid = node.sid
  configForm.node_key = node.node_key
  showConfigModal.value = true
}

const submitNodeConfig = async () => {
  try {
    const res = await axios.post('/api/admin/nodes/save_config', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      ...configForm
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      showConfigModal.value = false
      fetchNodes()
      emit('reload-all')
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('保存网络配置失败')
  }
}

const openPermModal = (node) => {
  permForm.node_id = node.node_id
  permForm.name = node.name
  permForm.status = node.status !== undefined ? node.status : 1
  permForm.allow_all = node.allow_all !== undefined ? node.allow_all : 1
  permForm.allowed_groups = node.allowed_groups || ''
  permForm.allowed_users = node.allowed_users || ''
  showPermModal.value = true
}

const submitNodePermission = async () => {
  try {
    const res = await axios.post('/api/admin/nodes/save_permission', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      ...permForm
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      showPermModal.value = false
      fetchNodes()
      emit('reload-all')
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('保存权限策略失败')
  }
}

const handleForceResync = async (nodeId) => {
  if (!confirm(`确定开启对节点 [${nodeId}] 的重新接纳模式吗？`)) return
  try {
    const res = await axios.post('/api/admin/nodes/force_resync', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      node_id: nodeId
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      fetchNodes()
    }
  } catch (_) {
    ElMessage.error('触发重新接纳失败')
  }
}

const handleRevokeDelete = async (nodeId) => {
  if (!confirm(`⚠️ 警告：确定要从集群中吊销并彻底删除该节点吗？`)) return
  try {
    const res = await axios.post('/api/admin/nodes/revoke_delete', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      node_id: nodeId
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      fetchNodes()
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('吊销节点失败')
  }
}
</script>

<style scoped>
/* 顶栏集群安全管理横幅 (严格还原图二) */
.cluster-security-banner {
  background: linear-gradient(145deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.8));
  border: 1px solid rgba(56, 189, 248, 0.25);
  border-radius: 8px;
  padding: 14px 18px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
}

.banner-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.token-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.cluster-token-code {
  font-family: monospace;
  font-size: 12px;
  color: #38bdf8;
  background: rgba(0, 0, 0, 0.4);
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px dashed rgba(56, 189, 248, 0.3);
}

.banner-hint {
  font-size: 11px;
  color: #94a3b8;
}

.banner-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

/* TOFU 双层开关组 (图二右侧看板) */
.tofu-switches-card {
  background: rgba(15, 23, 42, 0.8);
  border: 1px solid rgba(51, 65, 85, 0.8);
  border-radius: 6px;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 320px;
}

.switch-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.sub-switch-row {
  border-top: 1px solid rgba(51, 65, 85, 0.4);
  padding-top: 6px;
}

.switch-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.lightning-icon {
  color: #fbbf24;
}

.sub-tree-prefix {
  color: #64748b;
  font-family: monospace;
}

.switch-label-text {
  color: #e2e8f0;
  font-weight: 600;
}

.switch-status-pill {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.pill-active {
  background: rgba(16, 185, 129, 0.15);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.pill-disabled {
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.pill-amber {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.pill-warning {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
}

.switch-btn-wrap {
  cursor: pointer;
}

.switch-btn-wrap input {
  display: none;
}

.switch-btn-wrap.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.switch-btn-text {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 4px;
  font-size: 11px;
  color: #94a3b8;
  transition: all 0.2s;
  user-select: none;
}

.switch-btn-text.active {
  background: rgba(16, 185, 129, 0.2);
  border-color: #10b981;
  color: #34d399;
  font-weight: 600;
}

.check-icon {
  font-weight: bold;
}

.btn-deploy-snippet {
  padding: 8px 16px;
  font-size: 12px;
  background: #0284c7;
  color: #ffffff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 二级选项卡导航 (图二) */
.sub-nav-tabs {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  border-bottom: 1px solid rgba(51, 65, 85, 0.6);
  padding-bottom: 4px;
}

.sub-tab-btn {
  background: transparent;
  border: 1px solid #334155;
  color: #94a3b8;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all 0.2s;
}

.sub-tab-btn:hover {
  background: rgba(30, 41, 59, 0.6);
  color: #e2e8f0;
}

.sub-tab-btn.active {
  background: #0284c7;
  border-color: #38bdf8;
  color: #ffffff;
  font-weight: 600;
}

.sub-count-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  font-weight: bold;
}

.badge-amber {
  background: #f59e0b;
  color: #0f172a;
}

.badge-slate {
  background: #334155;
  color: #f8fafc;
}

.header-right-note {
  font-size: 12px;
  color: #94a3b8;
}

/* 网络模式徽章 */
.net-mode-pill {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.pill-direct {
  background: rgba(14, 165, 233, 0.15);
  color: #38bdf8;
  border: 1px solid rgba(14, 165, 233, 0.3);
}

.pill-wss {
  background: rgba(168, 85, 247, 0.15);
  color: #c084fc;
  border: 1px solid rgba(168, 85, 247, 0.3);
}

/* 待审隔离区提示框 */
.quarantine-alert-box {
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 8px;
  padding: 14px 18px;
  margin-top: 14px;
}

.quarantine-alert-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.alert-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quarantine-desc {
  font-size: 12px;
  color: #cbd5e1;
  margin: 8px 0 0 0;
  line-height: 1.6;
}

.deploy-tab-box {
  background: #0b1120;
  border: 1px solid #1e293b;
  border-radius: 8px;
  padding: 18px;
  margin-top: 14px;
}

/* 待审隔离区行高亮 */
.node-quarantine-row {
  background: rgba(245, 158, 11, 0.05);
  border-left: 3px solid #f59e0b;
}

.node-disabled-row {
  opacity: 0.6;
}

.badge-quarantine {
  background: rgba(245, 158, 11, 0.2);
  color: #f59e0b;
  border: 1px solid rgba(245, 158, 11, 0.4);
}

.badge-approved {
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.btn-approve {
  background: linear-gradient(135deg, #10b981, #059669);
  color: white;
  border: none;
  font-weight: 700;
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.4);
}

.code-editor-box {
  background: #090d16;
  border: 1px solid #1e293b;
  border-radius: 6px;
  padding: 12px;
  max-height: 280px;
  overflow-y: auto;
}

.yaml-code-view {
  font-family: monospace;
  font-size: 12px;
  color: #38bdf8;
  margin: 0;
  white-space: pre;
}

.badge-disabled {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.badge-public {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.badge-restricted {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.btn-perm {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.4);
}
.btn-perm:hover {
  background: rgba(245, 158, 11, 0.3);
}

.pbk-box {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.pbk-clean-text {
  font-family: monospace;
  font-size: 11px;
  color: #38bdf8;
  background: transparent !important;
  border: none !important;
  padding: 0;
}

.btn-copy-icon {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 13px;
  padding: 0 2px;
  opacity: 0.75;
  transition: opacity 0.2s, transform 0.2s;
}
.btn-copy-icon:hover {
  opacity: 1;
  transform: scale(1.2);
}

.heartbeat-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
  width: fit-content;
  cursor: pointer;
  white-space: nowrap;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}

.permission-sub-box {
  background: #090d16;
  border: 1px solid #1e293b;
  border-radius: 6px;
  padding: 12px;
  margin-top: 10px;
}
</style>