<template>
  <div class="cyber-card tab-content-card">
    <div class="card-header">
      <div style="display: flex; align-items: center; gap: 8px;">
        <h3>🌐 节点集群治理与多端调度</h3>
        <span class="badge badge-ready">{{ adminNodes.length }} 个节点</span>
      </div>
      <button class="btn-cyber-refresh" @click="fetchNodes">🔄 刷新节点</button>
    </div>

    <div class="table-container">
      <table class="cyber-table">
        <thead>
          <tr>
            <th>节点名称 / 连接地址</th>
            <th>服务状态</th>
            <th>开放范围策略</th>
            <th>SNI 伪装域名</th>
            <th>公钥 (PublicKey)</th>
            <th>心跳检测状态</th>
            <th style="width: 250px;">治理操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="node in adminNodes" :key="node.id" :class="{ 'node-disabled-row': node.status === 0 }">
            <td>
              <div style="font-weight: 700; color: #f8fafc;">{{ node.name }}</div>
              <div style="font-size: 11px; color: #38bdf8; font-family: monospace;">{{ node.ip }}:{{ node.port }}</div>
            </td>
            <!-- 运行服务状态 -->
            <td>
              <span class="badge" :class="node.status === 1 ? 'badge-ready' : 'badge-disabled'">
                {{ node.status === 1 ? '🟢 运行中' : '🛑 已停止' }}
              </span>
            </td>
            <!-- 开放范围策略 (默认全体公开 / 定向授权) -->
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

            <!-- 1. 恢复：公钥展示与一键复制功能 -->
            <td>
              <div v-if="node.pbk && node.pbk.length === 43" class="pbk-copy-box">
                <span class="pbk-text" :title="node.pbk">{{ formatPbk(node.pbk) }}</span>
                <button class="btn-sm-icon btn-action" title="一键复制完整公钥" @click="copyPbk(node.pbk)">
                  📋
                </button>
              </div>
              <div v-else>
                <span class="badge badge-used">⚠️ 等待回传</span>
              </div>
            </td>

            <!-- 2. 恢复：实时计算心跳活性状态 -->
            <td>
              <div class="heartbeat-cell">
                <span class="badge" :class="getHeartbeatInfo(node.last_heartbeat).cls">
                  {{ getHeartbeatInfo(node.last_heartbeat).text }}
                </span>
                <div class="last-time-tip">{{ node.last_heartbeat || '无记录' }}</div>
              </div>
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
          <tr v-if="adminNodes.length === 0">
            <td colspan="7" style="text-align: center; color: #64748b; padding: 24px;">
              集群暂无节点，请在远程节点部署并配置 PANEL_URL 自动接入。
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 弹窗 1：⚙️ 节点网络配置 (连接地址支持 IP 或 域名) -->
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
            <input
              v-model="configForm.ip"
              type="text"
              class="cyber-input modal-input"
              placeholder="支持填入 1.2.3.4 或 hk.domain.com"
            />
            <span class="input-hint">填写域名时，客户端订阅将自动以该域名生成连接</span>
          </div>
          <div class="form-item" style="width: 110px;">
            <label>监听端口</label>
            <input v-model.number="configForm.port" type="number" class="cyber-input modal-input" />
          </div>
        </div>

        <div class="form-item">
          <label>伪装目标域名 (dest)</label>
          <input v-model="configForm.dest" type="text" class="cyber-input modal-input" placeholder="www.microsoft.com:443" />
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
          <label>节点通信密钥 (Node Key)</label>
          <input v-model="configForm.node_key" type="text" class="cyber-input modal-input font-mono" />
        </div>

        <div class="btn-group" style="justify-content: flex-end; margin-top: 20px;">
          <button class="btn-cyber-action" @click="showConfigModal = false">取消</button>
          <button class="btn-cyber-primary" @click="submitNodeConfig">保存网络配置</button>
        </div>
      </div>
    </div>

    <!-- 弹窗 2：🔐 节点启停与权限策略 (单选启停，单选开放范围) -->
    <div v-if="showPermModal" class="modal-backdrop" @click="showPermModal = false">
      <div class="cyber-modal" style="max-width: 520px; text-align: left;" @click.stop>
        <h3>🔐 节点启停与权限策略 [{{ permForm.name }}]</h3>

        <!-- A. 启停节点：单选框 -->
        <div class="form-item" style="margin-top: 14px;">
          <label>节点运行状态 (单选启停)</label>
          <div class="radio-group">
            <label class="radio-label">
              <input type="radio" :value="1" v-model.number="permForm.status" /> 🟢 启用节点 (正常开放服务与订阅)
            </label>
            <label class="radio-label">
              <input type="radio" :value="0" v-model.number="permForm.status" /> 🛑 停止节点 (阻断连接且对用户端隐藏)
            </label>
          </div>
          <span class="input-hint">选择停止时，所有普通用户将无法连接，且在网页和订阅中彻底消失</span>
        </div>

        <!-- B. 授权开放范围：单选全部公开或定向限定 -->
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

        <!-- C. 细分定向名单 (仅在选择定向授权时展示) -->
        <div v-if="permForm.allow_all === 0" class="permission-sub-box">
          <div class="form-item">
            <label>允许访问的用户组 (多个用逗号隔开，如: vip, pro)</label>
            <input
              v-model="permForm.allowed_groups"
              type="text"
              class="cyber-input modal-input"
              placeholder="例如: vip, svip"
            />
            <span class="input-hint">用户所属组与此匹配时可见并可用该节点</span>
          </div>

          <div class="form-item" style="margin-top: 8px;">
            <label>允许访问的特定用户 (多个用逗号隔开，填用户名或邮箱)</label>
            <input
              v-model="permForm.allowed_users"
              type="text"
              class="cyber-input modal-input"
              placeholder="例如: alice, bob@qq.com, 460486990@qq.com"
            />
            <span class="input-hint">特定白名单用户名单（不受用户组限制）</span>
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
import { ref, reactive, onMounted } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

const props = defineProps({
  currentUser: { type: Object, required: true },
  adminPassword: { type: String, required: true }
})

const emit = defineEmits(['reload-all'])

const adminNodes = ref([])
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

// 格式化公钥展示 (前6位...后6位)
const formatPbk = (pbk) => {
  if (!pbk || pbk.length < 12) return pbk || ''
  return `${pbk.slice(0, 6)}...${pbk.slice(-6)}`
}

// 复制公钥到剪贴板
const copyPbk = (pbk) => {
  if (!pbk) return
  navigator.clipboard.writeText(pbk).then(() => {
    ElMessage.success('公钥 (PublicKey) 已成功复制到剪贴板！')
  }).catch(() => {
    ElMessage.error('复制失败，请手动长按复制')
  })
}

// 动态心跳状态计算器
const getHeartbeatInfo = (lastHeartbeat) => {
  if (!lastHeartbeat || lastHeartbeat.includes('等待') || lastHeartbeat.includes('下线')) {
    return { text: lastHeartbeat || '未上线', cls: 'badge-disabled' }
  }
  const t = new Date(lastHeartbeat.replace(/-/g, '/')).getTime()
  if (isNaN(t)) return { text: lastHeartbeat, cls: 'badge-disabled' }

  const diffSec = Math.floor((Date.now() - t) / 1000)
  if (diffSec < 0 || diffSec <= 90) {
    return { text: `🟢 在线 (${diffSec <= 10 ? '刚刚' : diffSec + 's前'})`, cls: 'badge-ready' }
  } else if (diffSec <= 300) {
    return { text: `🟡 延迟 (${Math.floor(diffSec / 60)}m前)`, cls: 'badge-restricted' }
  } else {
    return { text: `🔴 离线 (${Math.floor(diffSec / 60)}m前)`, cls: 'badge-disabled' }
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
    const res = await axios.post('/api/admin/nodes/list', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword
    })
    if (res.data.code === 200) {
      adminNodes.value = res.data.data
    }
  } catch (_) {
    ElMessage.error('拉取节点列表失败')
  }
}

onMounted(() => {
  fetchNodes()
})

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
.node-disabled-row {
  opacity: 0.6;
  background: rgba(239, 68, 68, 0.05);
}

.badge-disabled {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.4);
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

.pbk-copy-box {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pbk-text {
  font-family: monospace;
  font-size: 11px;
  color: #38bdf8;
  background: rgba(15, 23, 42, 0.6);
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid rgba(56, 189, 248, 0.2);
}

.btn-sm-icon {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 13px;
  padding: 2px 4px;
  opacity: 0.8;
  transition: opacity 0.2s;
}
.btn-sm-icon:hover {
  opacity: 1;
  transform: scale(1.1);
}

.heartbeat-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.last-time-tip {
  font-size: 10px;
  color: #64748b;
  font-family: monospace;
}

.permission-sub-box {
  background: #090d16;
  border: 1px solid #1e293b;
  border-radius: 6px;
  padding: 12px;
  margin-top: 10px;
}
</style>