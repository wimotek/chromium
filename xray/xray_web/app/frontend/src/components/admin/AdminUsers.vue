<template>
  <div class="cyber-card tab-content-card">
    <div class="card-header">
      <h3>👥 接入用户治理列表</h3>
      <button class="btn-cyber-refresh" @click="$emit('reload-all')">🔄 刷新数据</button>
    </div>

    <div class="table-container">
      <table class="cyber-table">
        <thead>
          <tr>
            <th>用户 / 绑定邮箱</th>
            <th>状态</th>
            <th>流量使用 / 总配额</th>
            <th>到期时间</th>
            <th>套餐特性</th>
            <th>专属凭证</th>
            <th style="width: 280px;">治理操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in adminUsers" :key="u.username">
            <td>
              <b>{{ u.username }}</b>
              <div style="font-size: 11px; color: #64748b;">{{ u.email }}</div>
            </td>
            <td>
              <span class="badge" :class="u.status === 1 ? 'badge-ready' : 'badge-used'">
                {{ u.status === 1 ? '🟢 活跃' : '🔴 封禁' }}
              </span>
            </td>
            <td>
              <div style="white-space: nowrap;">{{ u.used_mb }} / {{ u.traffic_limit_mb === 0 ? '♾️ 不限' : u.traffic_limit_mb + ' MB' }}</div>
              <div class="table-progress"><div class="table-glow" :style="{ width: calcProgress(u.used_mb, u.traffic_limit_mb) + '%' }"></div></div>
            </td>
            <td style="white-space: nowrap;">{{ (u.expire_date && u.expire_date.startsWith('2099')) ? '♾️ 永久有效' : u.expire_date }}</td>
            <td>
              <span v-if="u.is_monthly === 1" class="badge badge-monthly">每月{{ u.reset_day }}号重置</span>
              <span v-else class="text-muted" style="font-size: 11px;">普通固定</span>
            </td>
            <td style="white-space: nowrap;">
              <button class="btn-sm btn-action" @click="openUserCredModal(u)">📱 凭证/二维码</button>
            </td>
            <td>
              <div class="action-btn-row">
                <button class="btn-sm btn-reset" @click="openResetPwdModal(u.username)">🔑 密码</button>
                <button class="btn-sm btn-cyber-danger" @click="handleAdminResetUserUuid(u.username)">🔄 重置UUID</button>
                <button class="btn-sm btn-edit" @click="openEditModal(u)">✏️ 配额</button>
                <button v-if="u.status === 1" class="btn-sm btn-demote" :disabled="u.username === currentUser.username" @click="handleStatusToggle(u.username, 0)">🛑 封禁</button>
                <button v-else class="btn-sm btn-unban" @click="handleStatusToggle(u.username, 1)">🟢 解封</button>
                <button class="btn-sm btn-del" :disabled="u.username === currentUser.username" @click="handleDeleteUser(u.username)">🗑️</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 弹窗 1：管理员查看指定用户的全节点订阅与各节点直连链接 -->
    <div v-if="showUserCredModal" class="modal-backdrop" @click="showUserCredModal = false">
      <div class="cyber-modal" style="max-width: 580px; text-align: left;" @click.stop>
        <h3>📱 用户 [{{ targetCredUser.username }}] 的节点凭据与订阅</h3>
        
        <div class="node-field" style="margin-top: 15px;">
          <label>通用多节点聚合订阅地址 (全客户端批量导入)：</label>
          <div class="code-display text-cyan" style="word-break: break-all;">{{ targetCredUser.sub_url }}</div>
          <div class="btn-group" style="margin-top: 8px;">
            <button class="btn-sm btn-action" @click="$emit('copy', targetCredUser.sub_url)">📋 复制订阅地址</button>
            <button class="btn-sm btn-edit" @click="$emit('open-qr', { link: targetCredUser.sub_url, name: targetCredUser.username + ' 订阅' })">📱 订阅二维码</button>
          </div>
        </div>

        <div class="inner-divider">
          <div class="inner-divider-title">🌐 各集群节点直连线路清单 (共 {{ targetCredUser.node_links ? targetCredUser.node_links.length : 0 }} 个物理节点)</div>
          <div style="max-height: 240px; overflow-y: auto;">
            <div v-for="nl in targetCredUser.node_links" :key="nl.node_id" style="background: #0b1120; border: 1px solid #1e293b; border-radius: 6px; padding: 10px; margin-bottom: 8px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <b style="font-size: 13px; color: #f1f5f9;">{{ nl.name }}</b>
                <div style="display: flex; gap: 6px;">
                  <button class="btn-sm btn-action" @click="$emit('copy', nl.link)">复制</button>
                  <button class="btn-sm btn-edit" @click="$emit('open-qr', { link: nl.link, name: nl.name })">二维码</button>
                </div>
              </div>

              <div v-if="nl.server_names && nl.server_names.length > 1" class="sni-select-wrap" style="margin-bottom: 6px;">
                <label style="color: #94a3b8; font-size: 11px;">伪装SNI:</label>
                <select v-model="nl.selected_sni" class="cyber-select" @change="onAdminChangeUserNodeSni(nl)">
                  <option v-for="s in nl.server_names" :key="s" :value="s">{{ s }}</option>
                </select>
              </div>

              <div style="font-size: 11px; color: #64748b; font-family: monospace; word-break: break-all;">{{ nl.link }}</div>
            </div>
          </div>
        </div>

        <div class="btn-group" style="justify-content: flex-end; margin-top: 15px;">
          <button class="btn-cyber-action" @click="showUserCredModal = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- 弹窗 2：管理员修改用户配额 -->
    <div v-if="showEditModal" class="modal-backdrop" @click="showEditModal = false">
      <div class="cyber-modal" style="max-width: 440px; text-align: left;" @click.stop>
        <h3>✏️ 调整用户 [{{ editForm.username }}] 属性</h3>
        <div class="form-item" style="margin-top: 15px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <label style="margin: 0;">总流量限制配额 (MB)</label>
            <button class="btn-link-action" @click="editForm.limit_mb = 0">♾️ 设为不限流量</button>
          </div>
          <input v-model.number="editForm.limit_mb" type="number" class="cyber-input modal-input" />
        </div>
        <div class="form-item">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <label style="margin: 0;">套餐到期时限</label>
            <button class="btn-link-action" @click="editForm.expire_date = '2099-12-31 23:59:59'">♾️ 设为永久有效</button>
          </div>
          <input v-model="editForm.expire_date" type="text" class="cyber-input modal-input" />
        </div>
        <div class="form-item">
          <label class="radio-label"><input type="checkbox" v-model="editForm.is_monthly" /> 开启每月固定重置流量套餐</label>
        </div>
        <div class="form-item" v-if="editForm.is_monthly">
          <label>每月重置日期 (1~28 号)</label>
          <input v-model.number="editForm.reset_day" type="number" min="1" max="28" class="cyber-input modal-input" />
        </div>
        <div class="btn-group" style="justify-content: flex-end; margin-top: 20px;">
          <button class="btn-cyber-action" @click="showEditModal = false">取消</button>
          <button class="btn-cyber-success" @click="submitUserEdit">保存修改</button>
        </div>
      </div>
    </div>

    <!-- 弹窗 3：管理员重置用户密码 -->
    <div v-if="showResetPwdModal" class="modal-backdrop" @click="showResetPwdModal = false">
      <div class="cyber-modal" style="max-width: 380px; text-align: left;" @click.stop>
        <h3>🔑 重置用户 [{{ resetTargetUser }}] 密码</h3>
        <div class="form-item" style="margin-top: 15px;">
          <label>新密码</label>
          <input v-model="resetNewPassword" type="text" class="cyber-input modal-input" placeholder="输入新密码" />
        </div>
        <div class="btn-group" style="justify-content: flex-end; margin-top: 20px;">
          <button class="btn-cyber-action" @click="showResetPwdModal = false">取消</button>
          <button class="btn-cyber-primary" @click="submitResetPassword">确认重置</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

const props = defineProps({
  adminUsers: { type: Array, default: () => [] },
  currentUser: { type: Object, required: true },
  adminPassword: { type: String, required: true }
})

const emit = defineEmits(['open-qr', 'copy', 'reload-all'])

const showUserCredModal = ref(false)
const targetCredUser = ref({})

const showEditModal = ref(false)
const editForm = reactive({ username: '', limit_mb: 1024, expire_date: '', is_monthly: false, reset_day: 1 })

const showResetPwdModal = ref(false)
const resetTargetUser = ref('')
const resetNewPassword = ref('')

const calcProgress = (used, total) => {
  if (!total) return 100
  return Math.min(100, Math.round((used / total) * 100))
}

const openUserCredModal = (u) => {
  targetCredUser.value = u
  showUserCredModal.value = true
}

const onAdminChangeUserNodeSni = (nl) => {
  if (!nl.link || !nl.selected_sni) return
  nl.link = nl.link.replace(/sni=[^&]+/, `sni=${nl.selected_sni}`)
  ElMessage.success(`已切换线路伪装 SNI 为: ${nl.selected_sni}`)
}

const handleAdminResetUserUuid = async (targetUser) => {
  const tip =
    `⚠️ 确定要为用户 [${targetUser}] 重置节点凭证 (UUID) 吗？\n\n` +
    `【为什么需要重置？】\n` +
    `解决用户连接凭证泄露、被蹭网或违规盗用问题。\n\n` +
    `【重置后生效后果】\n` +
    `旧凭据将立刻断网失效，系统会自动向该用户发送邮件/微信通知其更新订阅。\n\n` +
    `确认重置？`

  if (!confirm(tip)) return
  try {
    const res = await axios.post('/api/admin/users/reset_uuid', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      target_user: targetUser
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('重置用户凭证失败')
  }
}

const openEditModal = (u) => {
  editForm.username = u.username
  editForm.limit_mb = u.traffic_limit_mb
  editForm.expire_date = u.expire_date
  editForm.is_monthly = u.is_monthly === 1
  editForm.reset_day = u.reset_day || 1
  showEditModal.value = true
}

const submitUserEdit = async () => {
  try {
    const res = await axios.post('/api/admin/users/edit', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      target_user: editForm.username,
      limit_mb: editForm.limit_mb,
      expire_date: editForm.expire_date,
      is_monthly: editForm.is_monthly,
      reset_day: editForm.reset_day
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      showEditModal.value = false
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('修改失败')
  }
}

const openResetPwdModal = (uname) => {
  resetTargetUser.value = uname
  resetNewPassword.value = ''
  showResetPwdModal.value = true
}

const submitResetPassword = async () => {
  if (!resetNewPassword.value) return ElMessage.warning('请输入新密码')
  try {
    const res = await axios.post('/api/admin/users/reset_password', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      target_user: resetTargetUser.value,
      new_password: resetNewPassword.value
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      showResetPwdModal.value = false
    }
  } catch (_) {
    ElMessage.error('重置失败')
  }
}

const handleStatusToggle = async (targetUser, newStatus) => {
  const tip = newStatus === 0 ? '封禁' : '解封'
  if (!confirm(`确定要${tip}用户 [${targetUser}] 吗？`)) return
  try {
    const res = await axios.post('/api/admin/users/status', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      target_user: targetUser,
      status: newStatus
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('操作异常')
  }
}

const handleDeleteUser = async (targetUser) => {
  if (!confirm(`⚠️ 警告：确定要彻底删除用户 [${targetUser}] 吗？数据无法恢复！`)) return
  try {
    const res = await axios.post('/api/admin/users/delete', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      target_user: targetUser
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('删除失败')
  }
}
</script>