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
            <th>节点名称 / 物理地址</th>
            <th>服务状态</th>
            <th>开放范围策略</th>
            <th>SNI 伪装域名</th>
            <th>公钥 (PublicKey)</th>
            <th>心跳检测时间</th>
            <th style="width: 280px;">治理操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="node in adminNodes" :key="node.id" :class="{ 'node-disabled-row': node.status === 0 }">
            <td>
              <div style="font-weight: 700; color: #f8fafc;">{{ node.name }}</div>
              <div style="font-size: 11px; color: #64748b; font-family: monospace;">{{ node.ip }}:{{ node.port }}</div>
            </td>
            <!-- 服务状态：启用 vs 禁用 -->
            <td>
              <span class="badge" :class="node.status === 1 ? 'badge-ready' : 'badge-disabled'">
                {{ node.status === 1 ? '🟢 启用服务' : '🛑 已禁用' }}
              </span>
            </td>
            <!-- 开放范围策略：公开 vs 定向 -->
            <td>
              <span v-if="node.status === 0" class="badge badge-disabled">
                🚫 全局阻断
              </span>
              <span v-else-if="node.allow_all === 1" class="badge badge-public">
                🌐 全体公开
              </span>
              <span v-else class="badge badge-restricted" :title="`组: ${node.allowed_groups || '无'} | 人: ${node.allowed_users || '无'}`">
                🎯 定向限定 ({{ getScopeSummary(node) }})
              </span>
            </td>
            <td>
              <div style="font-size: 12px; color: #38bdf8;">{{ node.sni }}</div>
              <div v-if="node.server_names && node.server_names.includes(',')" style="font-size: 10px; color: #94a3b8;">
                多SNI: {{ node.server_names.split(',').length }} 个
              </div>
            </td>
            <td>
              <span v-if="node.pbk && node.pbk.length === 43" class="badge badge-ready" title="公钥正常就绪">
                43位有效
              </span>
              <span v-else class="badge badge-used" title="尚未正确回传或格式异常">
                ⚠️ 异常
              </span>
            </td>
            <td>
              <div style="font-size: 11px; color: #94a3b8;">{{ node.last_heartbeat }}</div>
            </td>
            <td>
              <div class="action-btn-row">
                <!-- 快捷启用/禁用开关 -->
                <button
                  class="btn-sm"
                  :class="node.status === 1 ? 'btn-toggle-disable' : 'btn-toggle-enable'"
                  @click="handleToggleStatus(node)"
                >
                  {{ node.status === 1 ? '🛑 禁用' : '🟢 启用' }}
                </button>
                <button class="btn-sm btn-edit" @click="openEditModal(node)">✏️ 配置/权限</button>
                <button class="btn-sm btn-reset" @click="handleForceResync(node.node_id)" title="清空公钥让节点重新上报">🔄 重新接纳</button>
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

    <!-- 弹窗：编辑节点配置与开放范围控制 -->
    <div v-if="showEditModal" class="modal-backdrop" @click="showEditModal = false">
      <div class="cyber-modal" style="max-width: 580px; text-align: left;" @click.stop>
        <h3>✏️ 节点参数与定向权限策略 [{{ editNodeForm.name }}]</h3>

        <!-- A. 基础服务开关 -->
        <div class="form-item" style="margin-top: 14px;">
          <label>节点启用状态</label>
          <div class="radio-group">
            <label class="radio-label">
              <input type="radio" :value="1" v-model.number="editNodeForm.status" /> 🟢 正常启用 (允许客户端接入)
            </label>
            <label class="radio-label">
              <input type="radio" :value="0" v-model.number="editNodeForm.status" /> 🛑 停用禁用 (用户端不可见且切断连接)
            </label>
          </div>
        </div>

        <!-- B. 权限开放范围策略 -->
        <div class="form-item" style="border-top: 1px dashed rgba(255,255,255,0.08); padding-top: 12px;">
          <label>节点使用权限开放范围</label>
          <div class="radio-group">
            <label class="radio-label">
              <input type="radio" :value="1" v-model.number="editNodeForm.allow_all" /> 🌐 全部用户可用 (公开节点)
            </label>
            <label class="radio-label">
              <input type="radio" :value="0" v-model.number="editNodeForm.allow_all" /> 🎯 定向授权 (仅对指定用户组或特定用户开放)
            </label>
          </div>
        </div>

        <!-- C. 细粒度权限指定 -->
        <div v-if="editNodeForm.allow_all === 0" class="permission-sub-box">
          <div class="form-item">
            <label>允许访问的用户组 (多个用逗号隔开，如: vip, pro, internal)</label>
            <input
              v-model="editNodeForm.allowed_groups"
              type="text"
              class="cyber-input modal-input"
              placeholder="例如: vip, svip"
            />
            <span class="input-hint">用户所属组与此匹配时可见并可用该节点（未填则不按组匹配）</span>
          </div>

          <div class="form-item" style="margin-top: 8px;">
            <label>允许访问的特定用户 (多个用逗号隔开，支持填用户名或邮箱)</label>
            <input
              v-model="editNodeForm.allowed_users"
              type="text"
              class="cyber-input modal-input"
              placeholder="例如: alice, bob@qq.com, 460486990@qq.com"
            />
            <span class="input-hint">特定白名单用户名单（未填则不按个人匹配）</span>
          </div>
        </div>

        <!-- D. 网络与连接参数 -->
        <div class="form-item" style="border-top: 1px dashed rgba(255,255,255,0.08); padding-top: 12px;">
          <label>节点对外展示名称</label>
          <input v-model="editNodeForm.name" type="text" class="cyber-input modal-input" />
        </div>

        <div style="display: flex; gap: 10px;">
          <div class="form-item" style="flex: 1;">
            <label>节点 IP 地址</label>
            <input v-model="editNodeForm.ip" type="text" class="cyber-input modal-input" />
          </div>
          <div class="form-item" style="width: 110px;">
            <label>监听端口</label>
            <input v-model.number="editNodeForm.port" type="number" class="cyber-input modal-input" />
          </div>
        </div>

        <div class="form-item">
          <label>伪装目标域名 (dest)</label>
          <input v-model="editNodeForm.dest" type="text" class="cyber-input modal-input" placeholder="www.microsoft.com:443" />
        </div>

        <div class="form-item">
          <label>多 SNI 域名轮换池 (英文逗号隔开)</label>
          <input v-model="editNodeForm.server_names" type="text" class="cyber-input modal-input" />
        </div>

        <div class="form-item">
          <label>ShortId 认证标识</label>
          <input v-model="editNodeForm.sid" type="text" class="cyber-input modal-input" />
        </div>

        <div class="form-item">
          <label>节点通信密钥 (Node Key)</label>
          <input v-model="editNodeForm.node_key" type="text" class="cyber-input modal-input font-mono" />
        </div>

        <div class="btn-group" style="justify-content: flex-end; margin-top: 20px;">
          <button class="btn-cyber-action" @click="showEditModal = false">取消</button>
          <button class="btn-cyber-success" @click="submitNodeEdit">保存配置与权限</button>
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
const showEditModal = ref(false)

const editNodeForm = reactive({
  node_id: '',
  name: '',
  ip: '',
  port: 443,
  dest: '',
  sni: '',
  server_names: '',
  sid: '',
  node_key: '',
  status: 1,
  allow_all: 1,
  allowed_groups: '',
  allowed_users: ''
})

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

// 快捷单节点启用 / 禁用切换
const handleToggleStatus = async (node) => {
  const targetStatus = node.status === 1 ? 0 : 1
  const actionText = targetStatus === 1 ? '启用' : '禁用'
  const confirmTip = targetStatus === 0
    ? `⚠️ 确定要禁用节点 [${node.name}] 吗？\n\n禁用后所有普通用户将无法连接，且在网页和订阅中彻底消失！`
    : `确定要恢复启用节点 [${node.name}] 吗？`

  if (!confirm(confirmTip)) return

  try {
    const res = await axios.post('/api/admin/nodes/toggle_status', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      node_id: node.node_id,
      status: targetStatus
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      node.status = targetStatus
      emit('reload-all')
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error(`${actionText}节点失败`)
  }
}

const openEditModal = (node) => {
  editNodeForm.node_id = node.node_id
  editNodeForm.name = node.name
  editNodeForm.ip = node.ip
  editNodeForm.port = node.port
  editNodeForm.dest = node.dest || 'www.microsoft.com:443'
  editNodeForm.sni = node.sni || 'www.microsoft.com'
  editNodeForm.server_names = node.server_names || node.sni
  editNodeForm.sid = node.sid
  editNodeForm.node_key = node.node_key
  editNodeForm.status = node.status !== undefined ? node.status : 1
  editNodeForm.allow_all = node.allow_all !== undefined ? node.allow_all : 1
  editNodeForm.allowed_groups = node.allowed_groups || ''
  editNodeForm.allowed_users = node.allowed_users || ''
  showEditModal.value = true
}

const submitNodeEdit = async () => {
  try {
    const res = await axios.post('/api/admin/nodes/save_config', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      ...editNodeForm
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      showEditModal.value = false
      fetchNodes()
      emit('reload-all')
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('保存节点配置失败')
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

.btn-toggle-disable {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.4);
}
.btn-toggle-disable:hover {
  background: rgba(239, 68, 68, 0.4);
}

.btn-toggle-enable {
  background: rgba(16, 185, 129, 0.2);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.4);
}
.btn-toggle-enable:hover {
  background: rgba(16, 185, 129, 0.4);
}

.permission-sub-box {
  background: #090d16;
  border: 1px solid #1e293b;
  border-radius: 6px;
  padding: 12px;
  margin-top: 10px;
}
</style>