<template>
  <div class="dark-theme">
    <!-- 顶部科技导航 -->
    <header class="cyber-header">
      <div class="header-content">
        <div class="brand">
          <span class="pulse-icon">⚡</span>
          <span class="brand-title">XRAY <span class="highlight">REALITY</span></span>
        </div>
        <div v-if="currentUser.username" class="user-status">
          <span class="role-badge" :class="currentUser.role">{{ currentUser.role === 'admin' ? 'SYSTEM ADMIN' : 'USER CLIENT' }}</span>
          <span class="user-id">{{ currentUser.username }}</span>
          <button class="btn-logout" @click="logout">退出</button>
        </div>
      </div>
    </header>

    <main class="main-body">
      <!-- 1. 登录 / 注册模块 -->
      <div v-if="!currentUser.username" class="auth-center">
        <div class="cyber-card auth-box">
          <h2 class="card-title">{{ isPureAdmin ? '管理员认证' : (isRegister ? '新用户接入' : '节点控制台登录') }}</h2>
          <div class="form-item">
            <label>IDENTIFIER / 账号</label>
            <input v-model="authForm.username" type="text" class="cyber-input" placeholder="请输入用户名" />
          </div>
          <div class="form-item">
            <label>ACCESS KEY / 密码</label>
            <input v-model="authForm.password" type="password" class="cyber-input" placeholder="请输入密码" />
          </div>
          <button class="btn-cyber-primary" :disabled="loading" @click="handleAuth">
            {{ loading ? 'AUTHENTICATING...' : (isRegister ? '立即开通体验' : '进入控制台') }}
          </button>
          <div v-if="!isPureAdmin" class="auth-toggle">
            <a href="javascript:;" @click="isRegister = !isRegister">
              {{ isRegister ? '已有凭据？返回登录' : '没有凭证？注册领体验套餐' }}
            </a>
          </div>
        </div>
      </div>

      <!-- 2. 普通用户端：高档暗黑仪表盘 -->
      <div v-else-if="currentUser.role === 'user'" class="dashboard-grid">
        <div class="cyber-card">
          <div class="card-header">
            <h3>📊 流量监控与配额</h3>
            <span class="tag-status">ONLINE</span>
          </div>
          <div class="traffic-meter">
            <div class="meter-info">
              <div>
                <span class="data-val">{{ currentUser.used_mb }}</span>
                <span class="data-unit">MB (已用)</span>
              </div>
              <div class="text-right">
                <span class="data-val">{{ currentUser.limit_mb }}</span>
                <span class="data-unit">MB (总额)</span>
              </div>
            </div>
            <div class="progress-track">
              <div class="progress-glow" :style="{ width: trafficPercent + '%' }"></div>
            </div>
            <div class="expiry-notice">
              <span>套餐有效期至：</span>
              <strong class="highlight-date">{{ currentUser.expire_date }}</strong>
            </div>
          </div>
        </div>

        <div class="cyber-card">
          <div class="card-header">
            <h3>🎟️ 卡密充值续费</h3>
          </div>
          <p class="card-desc">输入发卡平台获取的兑换码，即时自动扩展流量与天数：</p>
          <div class="redeem-box">
            <input v-model="rechargeCode" type="text" class="cyber-input" placeholder="KM-XXXX-XXXX" />
            <button class="btn-cyber-success" :disabled="loading" @click="handleRecharge">立即激活</button>
          </div>
        </div>

        <div class="cyber-card col-span-2">
          <div class="card-header">
            <h3>🔗 REALITY 节点订阅凭据</h3>
          </div>
          <div class="node-field">
            <label>REALITY PUBLIC KEY (公钥):</label>
            <div class="code-display text-green">{{ currentUser.public_key || '正在提取公钥...' }}</div>
          </div>
          <div class="node-field">
            <label>VLESS REALITY 订阅配置链接:</label>
            <div class="code-display text-cyan">{{ currentUser.sub_link }}</div>
          </div>
          <div class="btn-group">
            <button class="btn-cyber-primary" @click="copyText(currentUser.sub_link)">📋 一键复制节点</button>
            <button class="btn-cyber-action" @click="openQrModal(currentUser.sub_link, currentUser.username)">📱 弹出二维码扫码</button>
          </div>
        </div>
      </div>

      <!-- 3. 管理员控制台：重叠式卡片切换布局 (拒绝混乱平铺) -->
      <div v-else-if="currentUser.role === 'admin'" class="admin-wrapper">
        <!-- 顶部卡片切换按钮组 -->
        <div class="card-tabs-nav">
          <button
            class="tab-card-btn"
            :class="{ active: activeTab === 'users' }"
            @click="activeTab = 'users'">
            <span class="tab-icon">👥</span>
            <div class="tab-text">
              <div class="tab-title">全站用户生命周期管理</div>
              <div class="tab-sub">配额/时效治理、凭证封禁、二维码与节点下发</div>
            </div>
            <span class="count-tag">{{ adminUsers.length }} 位用户</span>
          </button>

          <button
            class="tab-card-btn"
            :class="{ active: activeTab === 'cards' }"
            @click="activeTab = 'cards'">
            <span class="tab-icon">🎟️</span>
            <div class="tab-text">
              <div class="tab-title">卡密生成与发卡中心</div>
              <div class="tab-sub">批量制卡、库存监管、卡密一键导出核销</div>
            </div>
            <span class="count-tag">{{ adminCards.length }} 张卡密</span>
          </button>
        </div>

        <!-- 视图 A：全站用户管理卡片 -->
        <div v-if="activeTab === 'users'" class="cyber-card tab-content-card">
          <div class="card-header">
            <h3>👥 接入用户治理列表</h3>
            <button class="btn-cyber-refresh" @click="loadAdminData">🔄 刷新数据</button>
          </div>
          <div class="table-container">
            <table class="cyber-table">
              <thead>
                <tr>
                  <th>用户账号</th>
                  <th>账号状态</th>
                  <th>流量使用 / 总配额</th>
                  <th>到期时间</th>
                  <th>系统角色</th>
                  <th>专属凭证</th>
                  <th style="width: 280px;">治理操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="u in adminUsers" :key="u.username">
                  <td><b>{{ u.username }}</b></td>
                  <td>
                    <span class="badge" :class="u.status === 1 ? 'badge-ready' : 'badge-used'">
                      {{ u.status === 1 ? '🟢 正常活跃' : '🔴 已被封禁' }}
                    </span>
                  </td>
                  <td>
                    <div>{{ u.used_mb }} / {{ u.traffic_limit_mb }} MB</div>
                    <div class="table-progress"><div class="table-glow" :style="{ width: Math.min(100, (u.used_mb / u.traffic_limit_mb) * 100) + '%' }"></div></div>
                  </td>
                  <td>{{ u.expire_date }}</td>
                  <td><span class="role-badge" :class="u.role">{{ u.role }}</span></td>
                  <td>
                    <button class="btn-sm btn-action" @click="openQrModal(u.sub_link, u.username)">📱 链接/二维码</button>
                  </td>
                  <td>
                    <div class="action-btn-row">
                      <button class="btn-sm btn-edit" @click="openEditModal(u)">✏️ 改配额</button>
                      
                      <!-- 封禁 / 解封 -->
                      <button
                        v-if="u.status === 1"
                        class="btn-sm btn-demote"
                        :disabled="u.username === currentUser.username"
                        @click="handleStatusToggle(u.username, 0)">
                        🛑 封禁
                      </button>
                      <button
                        v-else
                        class="btn-sm btn-promote"
                        @click="handleStatusToggle(u.username, 1)">
                        🟢 解封
                      </button>

                      <!-- 提权 / 降权 -->
                      <button
                        v-if="u.role === 'user'"
                        class="btn-sm btn-promote"
                        @click="handleRoleChange(u.username, 'admin')">
                        ⚡ 提权
                      </button>
                      <button
                        v-else-if="u.username !== currentUser.username"
                        class="btn-sm btn-demote"
                        @click="handleRoleChange(u.username, 'user')">
                        降权
                      </button>

                      <!-- 删除 -->
                      <button
                        class="btn-sm btn-del"
                        :disabled="u.username === currentUser.username"
                        @click="handleDeleteUser(u.username)">
                        🗑️
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 视图 B：卡密与发卡中心卡片 -->
        <div v-else-if="activeTab === 'cards'" class="cyber-card tab-content-card">
          <div class="card-header">
            <h3>🛠️ 商业发卡制卡面板</h3>
          </div>
          <div class="gen-form">
            <div>
              <label>流量配额 (GB)</label>
              <input v-model.number="cardGenForm.traffic_gb" type="number" class="cyber-input" />
            </div>
            <div>
              <label>有效时限 (天)</label>
              <input v-model.number="cardGenForm.days" type="number" class="cyber-input" />
            </div>
            <div>
              <label>批量制卡数 (张)</label>
              <input v-model.number="cardGenForm.count" type="number" class="cyber-input" />
            </div>
            <button class="btn-cyber-success" @click="generateCards">立即批量制卡</button>
          </div>

          <div class="card-header" style="margin-top: 30px;">
            <h3>📦 历史卡密库存与核销流水 (最新100条)</h3>
            <button class="btn-cyber-refresh" @click="loadAdminData">🔄 刷新卡密</button>
          </div>
          <div class="table-container">
            <table class="cyber-table">
              <thead>
                <tr><th>兑换卡密编号</th><th>套餐配额</th><th>核销状态</th><th>兑换用户</th><th>操作</th></tr>
              </thead>
              <tbody>
                <tr v-for="c in adminCards" :key="c.code">
                  <td class="font-mono text-cyan">{{ c.code }}</td>
                  <td>{{ c.traffic_gb }} GB / {{ c.days }} 天</td>
                  <td>
                    <span class="badge" :class="c.is_used ? 'badge-used' : 'badge-ready'">
                      {{ c.is_used ? '已核销' : '待售出/有效' }}
                    </span>
                  </td>
                  <td>{{ c.used_by || '-' }}</td>
                  <td><button class="btn-sm btn-action" @click="copyText(c.code)">一键复制</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>

    <!-- 弹窗 1：二维码与节点分享 Modal (用户端/管理端通用) -->
    <div v-if="showQrModal" class="modal-backdrop" @click="showQrModal = false">
      <div class="cyber-modal" @click.stop>
        <h3>📱 [{{ targetModalUser }}] 节点连接凭证</h3>
        <p class="modal-tip">手机客户端相机直接扫码，或复制链接导入：</p>
        <div class="qr-box">
          <img :src="qrCodeDataUrl" alt="QR Code" />
        </div>
        <div class="node-field" style="margin-top: 15px; text-align: left;">
          <div class="code-display text-cyan" style="max-height: 80px; overflow-y: auto;">{{ targetModalLink }}</div>
        </div>
        <div class="btn-group" style="justify-content: center;">
          <button class="btn-cyber-primary" @click="copyText(targetModalLink)">复制链接</button>
          <button class="btn-cyber-action" @click="showQrModal = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- 弹窗 2：管理员修改用户配额与到期时间 Modal -->
    <div v-if="showEditModal" class="modal-backdrop" @click="showEditModal = false">
      <div class="cyber-modal" style="max-width: 420px; text-align: left;" @click.stop>
        <h3>✏️ 调整用户 [{{ editForm.username }}] 属性</h3>
        <div class="form-item" style="margin-top: 15px;">
          <label>总流量限制配额 (MB)</label>
          <input v-model.number="editForm.limit_mb" type="number" class="cyber-input" />
          <span style="font-size: 11px; color: #64748b;">换算参考：1GB = 1024MB | 100GB = 102400MB</span>
        </div>
        <div class="form-item">
          <label>套餐到期时限 (格式: YYYY-MM-DD HH:MM:SS)</label>
          <input v-model="editForm.expire_date" type="text" class="cyber-input" />
        </div>
        <div class="btn-group" style="justify-content: flex-end; margin-top: 20px;">
          <button class="btn-cyber-action" @click="showEditModal = false">取消</button>
          <button class="btn-cyber-success" @click="submitUserEdit">保存修改</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import axios from 'axios'
import QRCode from 'qrcode'
import { ElMessage } from 'element-plus'

const loading = ref(false)
const isRegister = ref(false)
const isPureAdmin = ref(false)
const rechargeCode = ref('')
const activeTab = ref('users') // 'users' | 'cards' 控制卡片重叠切换

// 弹窗状态控制
const showQrModal = ref(false)
const qrCodeDataUrl = ref('')
const targetModalUser = ref('')
const targetModalLink = ref('')

const showEditModal = ref(false)
const editForm = reactive({ username: '', limit_mb: 1024, expire_date: '' })

const currentUser = reactive({ username: '', role: '', used_mb: 0, limit_mb: 0, expire_date: '', public_key: '', sub_link: '' })
const authForm = reactive({ username: '', password: '' })
const cardGenForm = reactive({ traffic_gb: 50, days: 30, count: 5 })
const adminCards = ref([])
const adminUsers = ref([])

onMounted(async () => {
  try {
    const res = await axios.get('/api/system/info')
    if (res.data.data.mode === 'admin') isPureAdmin.value = true
  } catch (_) {}
})

const trafficPercent = computed(() => currentUser.limit_mb ? Math.min(100, Math.round((currentUser.used_mb / currentUser.limit_mb) * 100)) : 0)

// 弹出对应用户的专属二维码弹窗
const openQrModal = async (link, uname) => {
  if (!link) return ElMessage.warning('链接无效或公钥未初始化')
  try {
    targetModalUser.value = uname
    targetModalLink.value = link
    qrCodeDataUrl.value = await QRCode.toDataURL(link, { width: 240, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
    showQrModal.value = true
  } catch (err) {
    ElMessage.error('二维码渲染失败')
  }
}

// 弹出用户属性调整弹窗
const openEditModal = (u) => {
  editForm.username = u.username
  editForm.limit_mb = u.traffic_limit_mb
  editForm.expire_date = u.expire_date
  showEditModal.value = true
}

const submitUserEdit = async () => {
  try {
    const res = await axios.post('/api/admin/users/edit', {
      admin_user: authForm.username,
      admin_pwd: authForm.password,
      target_user: editForm.username,
      limit_mb: editForm.limit_mb,
      expire_date: editForm.expire_date
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      showEditModal.value = false
      loadAdminData()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('修改失败')
  }
}

// 封禁 / 解封操作
const handleStatusToggle = async (targetUser, newStatus) => {
  const tip = newStatus === 0 ? '封禁' : '解封'
  if (!confirm(`确定要${tip}用户 [${targetUser}] 吗？`)) return
  try {
    const res = await axios.post('/api/admin/users/status', {
      admin_user: authForm.username,
      admin_pwd: authForm.password,
      target_user: targetUser,
      status: newStatus
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      loadAdminData()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('网络或权限异常')
  }
}

// 删除用户
const handleDeleteUser = async (targetUser) => {
  if (!confirm(`⚠️ 警告：确定要彻底删除用户 [${targetUser}] 吗？数据无法恢复！`)) return
  try {
    const res = await axios.post('/api/admin/users/delete', {
      admin_user: authForm.username,
      admin_pwd: authForm.password,
      target_user: targetUser
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      loadAdminData()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('删除操作失败')
  }
}

// 提权 / 降权
const handleRoleChange = async (targetUser, newRole) => {
  const actionText = newRole === 'admin' ? '提升为管理员' : '降级为普通用户'
  if (!confirm(`确定要将 [${targetUser}] ${actionText}吗？`)) return
  try {
    const res = await axios.post('/api/admin/users/role', {
      admin_user: authForm.username,
      admin_pwd: authForm.password,
      target_user: targetUser,
      role: newRole
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      loadAdminData()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('操作失败')
  }
}

const copyText = async (text) => {
  if (!text) return ElMessage.warning('内容为空')
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      ElMessage.success('已复制到剪贴板！')
      return
    } catch (_) {}
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
    ElMessage.success('已复制到剪贴板！')
  } catch (_) {
    ElMessage.error('快捷复制失败，请手动长按复制')
  }
  document.body.removeChild(ta)
}

const handleAuth = async () => {
  if (!authForm.username || !authForm.password) return ElMessage.warning('请输入用户名与密码')
  loading.value = true
  try {
    const res = await axios.post(isRegister.value ? '/api/register' : '/api/login', authForm)
    if (res.data.code === 200) {
      if (isRegister.value) {
        ElMessage.success('注册成功，请登录！')
        isRegister.value = false
      } else {
        ElMessage.success('登录成功')
        Object.assign(currentUser, res.data.data)
        if (currentUser.role === 'admin') loadAdminData()
      }
    } else {
      ElMessage.error(res.data.msg)
    }
  } finally {
    loading.value = false
  }
}

const handleRecharge = async () => {
  if (!rechargeCode.value) return ElMessage.warning('请输入卡密')
  loading.value = true
  try {
    const res = await axios.post('/api/recharge', { username: currentUser.username, card_code: rechargeCode.value })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      rechargeCode.value = ''
      handleAuth()
    } else {
      ElMessage.error(res.data.msg)
    }
  } finally {
    loading.value = false
  }
}

const loadAdminData = async () => {
  const res = await axios.post('/api/admin/data', { admin_user: authForm.username, admin_pwd: authForm.password })
  if (res.data.code === 200) {
    adminCards.value = res.data.cards
    adminUsers.value = res.data.users
  }
}

const generateCards = async () => {
  loading.value = true
  try {
    const res = await axios.post('/api/admin/cards/generate', { admin_user: authForm.username, admin_pwd: authForm.password, ...cardGenForm })
    if (res.data.code === 200) {
      ElMessage.success('卡密批量生成成功')
      loadAdminData()
    } else {
      ElMessage.error(res.data.msg)
    }
  } finally {
    loading.value = false
  }
}

const logout = () => location.reload()
</script>

<style scoped>
.dark-theme {
  min-height: 100vh;
  background-color: #080c14;
  color: #e2e8f0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
}
.cyber-header {
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(13, 19, 33, 0.85);
  backdrop-filter: blur(10px);
  padding: 14px 24px;
}
.header-content {
  max-width: 1100px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.brand-title { font-size: 18px; font-weight: 800; letter-spacing: 1.5px; }
.highlight { color: #38bdf8; text-shadow: 0 0 10px rgba(56, 189, 248, 0.5); }
.user-status { display: flex; align-items: center; gap: 12px; }

.main-body { max-width: 1100px; margin: 30px auto; padding: 0 16px; }
.dashboard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.col-span-2 { grid-column: span 2; }

/* 核心优化：重叠卡片式标签切换导航 */
.admin-wrapper { width: 100%; }
.card-tabs-nav {
  display: flex;
  gap: 16px;
  margin-bottom: 20px;
}
.tab-card-btn {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 14px;
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 12px;
  padding: 18px 24px;
  cursor: pointer;
  text-align: left;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  color: #94a3b8;
  position: relative;
}
.tab-card-btn:hover {
  background: #131d36;
  border-color: #38bdf8;
  transform: translateY(-2px);
}
.tab-card-btn.active {
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
  border-color: #38bdf8;
  box-shadow: 0 0 20px rgba(56, 189, 248, 0.2);
  color: #f8fafc;
}
.tab-icon { font-size: 26px; }
.tab-title { font-size: 15px; font-weight: 700; color: #f8fafc; margin-bottom: 2px; }
.tab-sub { font-size: 12px; color: #64748b; }
.count-tag {
  margin-left: auto;
  font-size: 12px;
  background: rgba(56, 189, 248, 0.1);
  color: #38bdf8;
  padding: 4px 10px;
  border-radius: 20px;
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.cyber-card {
  background: #0f172a;
  border: 1px solid rgba(56, 189, 248, 0.2);
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.tab-content-card {
  animation: fadeIn 0.3s ease-in-out;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.card-header h3 { margin: 0; font-size: 16px; color: #f1f5f9; }

.traffic-meter { margin: 15px 0; }
.meter-info { display: flex; justify-content: space-between; margin-bottom: 8px; }
.data-val { font-size: 22px; font-weight: 700; color: #38bdf8; }
.data-unit { font-size: 12px; color: #64748b; margin-left: 4px; }
.progress-track { background: #1e293b; height: 10px; border-radius: 5px; overflow: hidden; margin: 10px 0; }
.progress-glow { background: linear-gradient(90deg, #38bdf8, #818cf8); height: 100%; box-shadow: 0 0 12px #38bdf8; }
.expiry-notice { font-size: 13px; color: #94a3b8; }
.highlight-date { color: #f59e0b; }

.cyber-input {
  width: 100%;
  background: #1e293b;
  border: 1px solid #334155;
  color: #f8fafc;
  padding: 10px 14px;
  border-radius: 6px;
  outline: none;
  box-sizing: border-box;
}
.cyber-input:focus { border-color: #38bdf8; box-shadow: 0 0 8px rgba(56, 189, 248, 0.3); }

.btn-cyber-primary {
  background: linear-gradient(135deg, #0284c7, #2563eb);
  color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 700; cursor: pointer;
}
/* 解决“立即激活”换行被挤扁的问题 */
.redeem-box {
  display: flex;
  gap: 10px;
  align-items: center;
}
.redeem-box .cyber-input {
  flex: 1;
  min-width: 0;
}
.btn-cyber-success {
  background: #059669;
  color: white;
  border: none;
  padding: 10px 18px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  font-weight: 600;
}

.btn-cyber-action { background: #334155; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; }
.btn-cyber-refresh { background: transparent; border: 1px solid #38bdf8; color: #38bdf8; padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }

.node-field { margin-bottom: 14px; }
.node-field label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
.code-display {
  background: #020617; border: 1px dashed rgba(255, 255, 255, 0.15); padding: 12px; border-radius: 6px;
  font-size: 13px; word-break: break-all; font-family: monospace;
}
.text-green { color: #34d399; font-weight: bold; }
.text-cyan { color: #38bdf8; }
.btn-group { display: flex; gap: 12px; margin-top: 16px; }

/* 弹窗通用 */
.modal-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.8); display: flex; justify-content: center; align-items: center; z-index: 1000; }
.cyber-modal { background: #0f172a; border: 1px solid #38bdf8; border-radius: 12px; padding: 24px; max-width: 360px; box-shadow: 0 0 30