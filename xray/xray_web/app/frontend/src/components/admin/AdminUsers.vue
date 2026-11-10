<template>
  <div class="cyber-card tab-content-card">
    <div class="card-header">
      <div style="display: flex; align-items: center; gap: 8px;">
        <h3>👥 接入用户治理列表</h3>
        <span class="badge badge-ready">{{ adminUsers.length }} 位用户</span>
      </div>
      <button class="btn-cyber-refresh" @click="$emit('reload-all')">🔄 刷新数据</button>
    </div>

    <div class="table-container">
      <table class="cyber-table">
        <thead>
          <tr>
            <th>用户 / 绑定邮箱</th>
            <th>状态</th>
            <th>所属用户组</th>
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

            <!-- 所属用户组徽章显示 -->
            <td>
              <span class="badge" :class="u.user_group === 'vip' ? 'badge-vip' : 'badge-group'">
                🏷️ {{ u.user_group || 'default' }}
              </span>
            </td>

            <td>
              <div style="white-space: nowrap;">
                {{ u.used_mb }} / {{ u.traffic_limit_mb === 0 ? '♾️ 不限' : u.traffic_limit_mb + ' MB' }}
              </div>
              <div class="table-progress"><div class="table-glow" :style="{ width: calcProgress(u.used_mb, u.traffic_limit_mb) + '%' }"></div></div>
            </td>
            <td style="white-space: nowrap;">{{ (u.expire_date && u.expire_date.startsWith('2099')) ? '♾️ 永久有效' : u.expire_date }}</td>

            <td>
              <span v-if="u.is_monthly === 1" class="badge badge-monthly">
                🔄 每月{{ u.reset_day }}号重置
              </span>
              <span v-else-if="u.traffic_limit_mb === 0 && u.expire_date && u.expire_date.startsWith('2099')" class="badge badge-ready" style="font-weight: 700;">
                👑 永久无限
              </span>
              <span v-else-if="u.traffic_limit_mb === 0" class="badge badge-ready">
                ♾️ 不限流量
              </span>
              <span v-else class="text-muted" style="font-size: 11px;">
                普通固定
              </span>
            </td>

            <td style="white-space: nowrap;">
              <button class="btn-sm btn-action" @click="openUserCredModal(u)">📱 凭证/二维码</button>
            </td>
            <td>
              <div class="action-btn-row">
                <button class="btn-sm btn-reset" @click="openResetPwdModal(u.username)">🔑 密码</button>
                <button class="btn-sm btn-cyber-danger" @click="handleAdminResetUserUuid(u.username)">🔄 重置UUID</button>
                <button class="btn-sm btn-edit" @click="openEditModal(u)">✏️ 配额/组</button>
                <button v-if="u.status === 1" class="btn-sm btn-demote" :disabled="u.username === currentUser.username" @click="handleStatusToggle(u.username, 0)">🛑 封禁</button>
                <button v-else class="btn-sm btn-unban" @click="handleStatusToggle(u.username, 1)">🟢 解封</button>
                <button class="btn-sm btn-del" :disabled="u.username === currentUser.username" @click="handleDeleteUser(u.username)">🗑️</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 弹窗 1：查看指定用户的专属订阅与单节点直连链接 -->
    <div v-if="showUserCredModal" class="modal-backdrop" @click="showUserCredModal = false">
      <div class="cyber-modal" style="max-width: 580px; text-align: left;" @click.stop>
        <h3>📱 用户 [{{ targetCredUser.username }}] 的节点凭据与订阅</h3>
        
        <div class="node-field" style="margin-top: 15px;">
          <label>通用多节点聚合订阅地址：</label>
          <div class="code-display text-cyan" style="word-break: break-all;">{{ targetCredUser.sub_url }}</div>
          <div class="btn-group" style="margin-top: 8px;">
            <button class="btn-sm btn-action" @click="$emit('copy', targetCredUser.sub_url)">📋 复制订阅地址</button>
            <button class="btn-sm btn-edit" @click="$emit('open-qr', { link: targetCredUser.sub_url, name: targetCredUser.username + ' 订阅' })">📱 订阅二维码</button>
          </div>
        </div>

        <div class="inner-divider">
          <div class="inner-divider-title">🌐 直连线路列表</div>
          <div style="max-height: 240px; overflow-y: auto;">
            <div v-for="nl in targetCredUser.node_links" :key="nl.node_id" style="background: #0b1120; border: 1px solid #1e293b; border-radius: 6px; padding: 10px; margin-bottom: 8px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <b style="font-size: 13px; color: #f1f5f9;">{{ nl.name }}</b>
                <div style="display: flex; gap: 6px;">
                  <button class="btn-sm btn-action" @click="$emit('copy', nl.link)">复制</button>
                  <button class="btn-sm btn-edit" @click="$emit('open-qr', { link: nl.link, name: nl.name })">二维码</button>
                </div>
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

    <!-- 弹窗 2：管理员修改用户配额与所属用户组 -->
    <div v-if="showEditModal" class="modal-backdrop" @click="showEditModal = false">
      <div class="cyber-modal" style="max-width: 480px; text-align: left;" @click.stop>
        <h3>✏️ 调整用户 [{{ editForm.username }}] 属性</h3>

        <!-- 新增：指派所属用户组 -->
        <div class="form-item" style="margin-top: 15px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <label style="margin: 0;">所属用户组 (User Group)</label>
            <div style="display: flex; gap: 6px;">
              <button class="btn-link-action" @click="editForm.user_group = 'default'">设为 default</button>
              <button class="btn-link-action" @click="editForm.user_group = 'vip'">设为 VIP</button>
              <button class="btn-link-action" @click="editForm.user_group = 'pro'">设为 Pro</button>
            </div>
          </div>
          <input
            v-model="editForm.user_group"
            type="text"
            class="cyber-input modal-input"
            placeholder="如: default, vip, pro, internal"
          />
          <span class="input-hint">节点若设置了“按用户组开放”，该组用户将自动获得对相应节点的访问权限</span>
        </div>

        <div class="form-item">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <label style="margin: 0;">总流量限制配额 (MB)</label>
            <button class="btn-link-action" @click="editForm.limit_mb = 0">♾️ 设为不限流量</button>
          </div>
          <input v-model.number="editForm.limit_mb" type="number" class="cyber-input modal-input" />
        </div>

        <div class="form-item">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <label style="margin: 0;">套餐到期时限</label>
            <div style="display: flex; gap: 8px;">
              <button class="btn-link-action" @click="addDaysToExpire(30)">+30天</button>
              <button class="btn-link-action" @click="addDaysToExpire(365)">+1年</button>
              <button class="btn-link-action" @click="editForm.expire_date = '2099-12-31 23:59:59'">♾️ 永久</button>
            </div>
          </div>
          <input
            v-model="editForm.expire_date"
            type="text"
            class="cyber-input modal-input"
            placeholder="支持输入 2026.11.30、2026-11-30 等"
            @blur="autoFormatExpireInput"
          />
          <span class="input-hint">离开焦点时将自动补全对齐为 23:59:59</span>
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
const editForm = reactive({
  username: '',
  limit_mb: 1024,
  expire_date: '',
  is_monthly: false,
  reset_day: 1,
  user_group: 'default'
})

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

const autoFormatExpireInput = () => {
  let s = (editForm.expire_date || '').trim()
  if (!s || s.startsWith('2099')) {
    editForm.expire_date = '2099-12-31 23:59:59'
    return
  }

  s = s.replace(/[./_年月份]/g, '-').replace(/日/g, '').replace(/\s+/g, ' ').trim()
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/)
  if (!m) return

  const year = parseInt(m[1], 10)
  const month = Math.max(1, Math.min(12, parseInt(m[2], 10)))
  const maxDay = new Date(year, month, 0).getDate()
  const day = Math.max(1, Math.min(maxDay, parseInt(m[3], 10)))

  let hh = 23, mm = 59, ss = 59
  if (m[4] !== undefined) {
    hh = Math.max(0, Math.min(23, parseInt(m[4], 10)))
    mm = Math.max(0, Math.min(59, parseInt(m[5] || '0', 10)))
    ss = Math.max(0, Math.min(59, parseInt(m[6] || '0', 10)))
  }

  const pad = (n) => String(n).padStart(2, '0')
  editForm.expire_date = `${year}-${pad(month)}-${pad(day)} ${pad(hh)}:${pad(mm)}:${pad(ss)}`
}

const addDaysToExpire = (days) => {
  let base = new Date()
  if (editForm.expire_date && !editForm.expire_date.startsWith('2099')) {
    const parsed = new Date(editForm.expire_date.replace(/-/g, '/'))
    if (!isNaN(parsed.getTime()) && parsed > base) {
      base = parsed
    }
  }
  base.setDate(base.getDate() + days)
  const pad = (n) => String(n).padStart(2, '0')
  editForm.expire_date = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())} 23:59:59`
}

const handleAdminResetUserUuid = async (targetUser) => {
  if (!confirm(`⚠️ 确定要为用户 [${targetUser}] 重置节点凭证 (UUID) 吗？旧凭证将立刻失效断网！`)) return
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
  editForm.user_group = u.user_group || 'default'
  showEditModal.value = true
}

const submitUserEdit = async () => {
  autoFormatExpireInput()
  try {
    const res = await axios.post('/api/admin/users/edit', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      target_user: editForm.username,
      limit_mb: editForm.limit_mb,
      expire_date: editForm.expire_date,
      is_monthly: editForm.is_monthly,
      reset_day: editForm.reset_day,
      user_group: editForm.user_group
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

<style scoped>
.table-progress {
  height: 6px;
  background: #1e293b;
  border-radius: 3px;
  width: 100px;
  overflow: hidden;
  margin-top: 4px;
}

.table-glow {
  height: 100%;
  background: #38bdf8;
  border-radius: 3px;
  transition: width 0.3s;
}

.badge-group {
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.badge-vip {
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.25), rgba(217, 119, 6, 0.25));
  color: #fbbf24;
  border: 1px solid #f59e0b;
  font-weight: 700;
}
</style>