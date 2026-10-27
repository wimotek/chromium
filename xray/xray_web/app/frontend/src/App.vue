<template>
  <div class="dark-theme">
    <!-- 全局顶栏 -->
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
      <!-- 1. 未登录：认证模块 -->
      <AuthView
        v-if="!currentUser.username"
        :systemNotice="systemNotice"
        :isPureAdmin="isPureAdmin"
        @login-success="onLoginSuccess"
      />

      <!-- 2. 普通用户端：用户仪表盘 -->
      <UserDashboard
        v-else-if="currentUser.role === 'user'"
        :currentUser="currentUser"
        @copy="copyText"
        @open-qr="openQrModalFromChild"
        @refresh-user="refreshUserInfo"
        @logout="logout"
      />

      <!-- 3. 管理员端：多选项卡调度 -->
      <div v-else-if="currentUser.role === 'admin'" class="admin-wrapper">
        <div class="card-tabs-nav">
          <button class="tab-card-btn" :class="{ active: activeTab === 'users' }" @click="activeTab = 'users'">
            <span class="tab-icon">👥</span>
            <div class="tab-text">
              <div class="tab-title">全站用户生命周期管理</div>
              <div class="tab-sub">配额/时效治理、重置UUID与密码、凭证二维码</div>
            </div>
            <span class="count-tag">{{ adminUsers.length }} 位用户</span>
          </button>

          <!-- 核心修复：点击立即激活 nodes 选项卡 -->
          <button class="tab-card-btn" :class="{ active: activeTab === 'nodes' }" @click="openNodesTab">
            <span class="tab-icon">🌐</span>
            <div class="tab-text">
              <div class="tab-title">远程节点 (xray_core) 集群</div>
              <div class="tab-sub">多节点公钥监管、在线状态、配置修改与接入</div>
            </div>
            <span class="count-tag">{{ adminNodes.length }} 个节点</span>
          </button>

          <button class="tab-card-btn" :class="{ active: activeTab === 'cards' }" @click="activeTab = 'cards'">
            <span class="tab-icon">🎟️</span>
            <div class="tab-text">
              <div class="tab-title">卡密生成与发卡中心</div>
              <div class="tab-sub">批量制卡、库存导出、范围清理、对接 API</div>
            </div>
            <span class="count-tag">{{ adminCards.length }} 张卡密</span>
          </button>

          <button class="tab-card-btn" :class="{ active: activeTab === 'settings' }" @click="openSettingsTab">
            <span class="tab-icon">⚙️</span>
            <div class="tab-text">
              <div class="tab-title">系统发信与全局运维配置</div>
              <div class="tab-sub">公告设置、SMTP、HTTPS证书、📢用户群发通知</div>
            </div>
            <span class="count-tag">配置中心</span>
          </button>
        </div>

        <component
          :is="currentAdminComponent"
          :adminUsers="adminUsers"
          :adminNodes="adminNodes"
          :adminCards="adminCards"
          :currentUser="currentUser"
          :adminPassword="adminPassword"
          @copy="copyText"
          @open-qr="openQrModalFromChild"
          @reload-all="reloadAllAdminData"
        />
      </div>
    </main>

    <!-- 全局二维码弹窗 -->
    <QrModal
      :visible="showQrModal"
      :title="targetModalUser"
      :link="targetModalLink"
      @close="showQrModal = false"
      @copy="copyText"
    />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, defineAsyncComponent } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

import QrModal from './components/common/QrModal.vue'
import AuthView from './components/AuthView.vue'
import UserDashboard from './components/UserDashboard.vue'

const AdminUsers = defineAsyncComponent(() => import('./components/admin/AdminUsers.vue'))
const AdminNodes = defineAsyncComponent(() => import('./components/admin/AdminNodes.vue'))
const AdminCards = defineAsyncComponent(() => import('./components/admin/AdminCards.vue'))
const AdminSettings = defineAsyncComponent(() => import('./components/admin/AdminSettings.vue'))

const isPureAdmin = ref(false)
const systemNotice = ref('')
const activeTab = ref('users')
const adminPassword = ref('')

const showQrModal = ref(false)
const targetModalUser = ref('')
const targetModalLink = ref('')

const currentUser = reactive({
  username: '', email: '', role: '', uuid: '',
  used_mb: 0, limit_mb: 0, expire_date: '',
  is_monthly: 0, reset_day: 1, sub_url: '', nodes: []
})

const adminCards = ref([])
const adminUsers = ref([])
const adminNodes = ref([])

onMounted(async () => {
  const savedSession = localStorage.getItem('xray_auth_session')
  if (savedSession) {
    try {
      const parsed = JSON.parse(savedSession)
      if (parsed.user && parsed.user.username) {
        Object.assign(currentUser, parsed.user)
        adminPassword.value = parsed.password || ''

        if (currentUser.role === 'user') {
          refreshUserInfo()
        } else if (currentUser.role === 'admin') {
          reloadAllAdminData()
        }
      }
    } catch (_) {
      localStorage.removeItem('xray_auth_session')
    }
  }

  try {
    const res = await axios.get('/api/system/info')
    if (res.data.data.mode === 'admin') isPureAdmin.value = true
    if (res.data.data.system_notice) systemNotice.value = res.data.data.system_notice
  } catch (_) {}
})

const currentAdminComponent = computed(() => {
  if (activeTab.value === 'users') return AdminUsers
  if (activeTab.value === 'nodes') return AdminNodes
  if (activeTab.value === 'cards') return AdminCards
  return AdminSettings
})

const onLoginSuccess = ({ user, password }) => {
  Object.assign(currentUser, user)
  adminPassword.value = password
  localStorage.setItem('xray_auth_session', JSON.stringify({ user, password }))

  if (currentUser.role === 'admin') {
    reloadAllAdminData()
  } else {
    refreshUserInfo()
  }
}

const refreshUserInfo = async () => {
  try {
    const res = await axios.post('/api/user/refresh_info', { username: currentUser.username })
    if (res.data.code === 200) {
      Object.assign(currentUser, res.data.data)
      const session = JSON.parse(localStorage.getItem('xray_auth_session') || '{}')
      if (session.user) {
        Object.assign(session.user, res.data.data)
        localStorage.setItem('xray_auth_session', JSON.stringify(session))
      }
    }
  } catch (_) {}
}

const reloadAllAdminData = async () => {
  await Promise.all([loadAdminData(), fetchNodesData()])
}

const loadAdminData = async () => {
  try {
    const res = await axios.post('/api/admin/data', {
      admin_user: currentUser.username,
      admin_pwd: adminPassword.value
    })
    if (res.data.code === 200) {
      adminCards.value = res.data.cards
      adminUsers.value = res.data.users
    }
  } catch (_) {}
}

const fetchNodesData = async () => {
  try {
    const res = await axios.post('/api/admin/nodes/list', {
      admin_user: currentUser.username,
      admin_pwd: adminPassword.value
    })
    if (res.data.code === 200) {
      adminNodes.value = res.data.data
    }
  } catch (_) {}
}

// 核心修复点：点击时先切 activeTab，再拉取数据
const openNodesTab = async () => {
  activeTab.value = 'nodes'
  await fetchNodesData()
}

const openSettingsTab = () => {
  activeTab.value = 'settings'
}

const openQrModalFromChild = ({ link, name }) => {
  targetModalUser.value = name
  targetModalLink.value = link
  showQrModal.value = true
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
    ElMessage.error('复制失败，请手动选择复制')
  }
  document.body.removeChild(ta)
}

const logout = () => {
  localStorage.removeItem('xray_auth_session')
  location.reload()
}
</script>

<style>
/* 全局暗黑科技风样式体系 */
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
  width: 100%;
  max-width: 98%;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.brand-title { font-size: 18px; font-weight: 800; letter-spacing: 1.5px; }
.highlight { color: #38bdf8; text-shadow: 0 0 10px rgba(56, 189, 248, 0.5); }
.user-status { display: flex; align-items: center; gap: 12px; }

.main-body {
  width: 100%;
  max-width: 98%;
  margin: 20px auto;
  padding: 0 12px;
  box-sizing: border-box;
}
.dashboard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.col-span-2 { grid-column: span 2; }

.cyber-card {
  background: #0f172a;
  border: 1px solid rgba(56, 189, 248, 0.2);
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.card-header h3 { margin: 0; font-size: 16px; color: #f1f5f9; }
.card-desc { font-size: 12px; color: #94a3b8; margin: 4px 0 14px 0; }

.header-nowrap-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: nowrap !important;
  gap: 16px;
}
.header-title-text {
  margin: 0;
  font-size: 16px;
  color: #f1f5f9;
  white-space: nowrap;
}
.btn-header-action {
  width: auto !important;
  white-space: nowrap !important;
  flex-shrink: 0 !important;
  padding: 7px 16px !important;
}

.cyber-input {
  width: 70%;
  min-width: 260px;
  max-width: 500px;
  background: #1e293b;
  border: 1px solid #334155;
  color: #f8fafc;
  padding: 10px 14px;
  border-radius: 6px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.cyber-input:focus { border-color: #38bdf8; box-shadow: 0 0 8px rgba(56, 189, 248, 0.3); }

.cyber-textarea { resize: vertical; min-height: 70px; font-family: inherit; }
.auth-box .cyber-input, .modal-input { width: 100% !important; min-width: 0 !important; max-width: 100% !important; }

/* 核心恢复：制卡表单经典的 4 列横排网格样式 */
.gen-form {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1.2fr;
  gap: 12px;
  align-items: flex-end;
  margin-bottom: 24px;
  background: #0b1120;
  border: 1px solid #1e293b;
  padding: 16px 20px;
  border-radius: 10px;
}
.gen-form .cyber-input {
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100% !important;
}

.btn-cyber-primary {
  background: linear-gradient(135deg, #0284c7, #2563eb);
  color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 700; cursor: pointer;
}
.btn-cyber-success {
  background: #059669; color: white; border: none; padding: 10px 18px; border-radius: 6px; cursor: pointer;
  white-space: nowrap; font-weight: 600;
}
.btn-cyber-action { background: #334155; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.btn-cyber-danger { background: #dc2626; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; white-space: nowrap; padding: 6px 12px; }
.btn-cyber-refresh { background: transparent; border: 1px solid #38bdf8; color: #38bdf8; padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }

.btn-sm { padding: 4px 8px; font-size: 11px; border-radius: 4px; border: none; cursor: pointer; white-space: nowrap; }
.btn-action { background: #0284c7; color: white; }
.btn-reset { background: #d97706; color: white; font-weight: 600; }
.btn-edit { background: #4f46e5; color: white; }
.btn-unban { background: #059669; color: white; font-weight: 600; }
.btn-demote { background: #475569; color: #fff; }
.btn-del { background: #b91c1c; color: white; }
.btn-del:disabled, .btn-demote:disabled { opacity: 0.3; cursor: not-allowed; }

.btn-link-action {
  background: transparent; border: none; color: #38bdf8; font-size: 11px;
  cursor: pointer; text-decoration: underline; padding: 0; white-space: nowrap;
}
.btn-link-action:hover { color: #7dd3fc; }

.table-container { overflow-x: auto; margin-top: 10px; }
.cyber-table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
.cyber-table th, .cyber-table td { padding: 12px 10px; border-bottom: 1px solid #1e293b; }
.cyber-table th { color: #64748b; font-weight: 600; white-space: nowrap; }

.status-cell-nowrap { white-space: nowrap !important; }
.time-sub-text { font-size: 10px; color: #64748b; margin-top: 3px; font-family: monospace; }

.badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; white-space: nowrap; }
.badge-ready { background: rgba(16, 185, 129, 0.2); color: #34d399; }
.badge-used { background: rgba(239, 68, 68, 0.2); color: #f87171; }
.badge-monthly { background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); }
.role-badge { padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.role-badge.admin { background: #dc2626; color: white; }
.role-badge.user { background: #2563eb; color: white; }
.btn-logout { background: transparent; border: 1px solid #475569; color: #94a3b8; padding: 4px 10px; border-radius: 4px; cursor: pointer; white-space: nowrap; }

.action-btn-row { display: flex; gap: 6px; align-items: center; white-space: nowrap; }

.form-item { margin-bottom: 16px; }
.form-item label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
.radio-group { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
.radio-label { font-size: 13px; color: #cbd5e1; cursor: pointer; display: flex; align-items: center; gap: 8px; }
.input-hint { font-size: 11px; color: #94a3b8; margin-top: 6px; line-height: 1.5; display: block; }

.node-field { margin-bottom: 14px; }
.node-field label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
.code-display {
  background: #020617; border: 1px dashed rgba(255, 255, 255, 0.15); padding: 12px; border-radius: 6px;
  font-size: 13px; word-break: break-all; font-family: monospace;
}
.text-green { color: #34d399; font-weight: bold; }
.text-cyan { color: #38bdf8; }
.btn-group { display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }

.modal-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.8); display: flex; justify-content: center; align-items: center; z-index: 1000; }
.cyber-modal { background: #0f172a; border: 1px solid #38bdf8; border-radius: 12px; padding: 24px; max-width: 480px; width: 90%; box-shadow: 0 0 30px rgba(56, 189, 248, 0.25); }
.qr-box { background: white; padding: 12px; border-radius: 8px; display: inline-block; margin: 10px 0; text-align: center; }
.modal-tip { font-size: 12px; color: #94a3b8; margin: 4px 0 10px 0; }

.admin-wrapper { width: 100%; }
.card-tabs-nav { display: flex; gap: 16px; margin-bottom: 20px; }
.tab-card-btn {
  flex: 1; display: flex; align-items: center; gap: 14px; background: #0f172a;
  border: 1px solid #1e293b; border-radius: 12px; padding: 16px 20px; cursor: pointer; text-align: left;
  color: #94a3b8; position: relative; min-width: 0; transition: all 0.2s;
}
.tab-card-btn:hover { background: #131d36; border-color: #38bdf8; transform: translateY(-2px); }
.tab-card-btn.active {
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
  border-color: #38bdf8; box-shadow: 0 0 20px rgba(56, 189, 248, 0.2); color: #f8fafc;
}
.tab-icon { font-size: 24px; flex-shrink: 0; }
.tab-text { flex: 1; min-width: 0; }
.tab-title { font-size: 14px; font-weight: 700; color: #f8fafc; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tab-sub { font-size: 11px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.count-tag {
  margin-left: auto; font-size: 11px; background: rgba(56, 189, 248, 0.1); color: #38bdf8;
  padding: 3px 10px; border-radius: 20px; border: 1px solid rgba(56, 189, 248, 0.3); white-space: nowrap; flex-shrink: 0;
}

.sub-tab-nav { display: flex; gap: 12px; margin-bottom: 20px; border-bottom: 1px solid #1e293b; padding-bottom: 12px; flex-wrap: wrap; }
.sub-tab-btn {
  background: #0b1120; border: 1px solid #1e293b; color: #94a3b8; padding: 8px 18px;
  border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600;
}
.sub-tab-btn.active { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border-color: #38bdf8; }

.settings-2col-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
.column-stack { display: flex; flex-direction: column; gap: 20px; }
.panel-card { background: #0b1120; border: 1px solid #1e293b; border-radius: 10px; padding: 20px; }
.panel-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid #1e293b; padding-bottom: 10px; }
.panel-title-wrap { display: flex; align-items: center; gap: 10px; }
.panel-icon { font-size: 22px; flex-shrink: 0; }
.panel-title { font-size: 14px; color: #f1f5f9; font-weight: 700; }
.panel-sub { font-size: 11px; color: #64748b; margin-top: 2px; }

.inner-divider { border-top: 1px dashed #1e293b; margin-top: 16px; padding-top: 14px; }
.inner-divider-title { font-size: 13px; font-weight: 700; color: #f1f5f9; margin-bottom: 10px; }
.form-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

.auth-center { max-width: 440px; margin: 30px auto; }
.auth-box { padding: 30px; }
.auth-nav-links { display: flex; justify-content: space-between; margin-top: 16px; font-size: 13px; }
.auth-nav-links a { color: #38bdf8; text-decoration: none; }
.auth-nav-links a:hover { text-decoration: underline; }
.auth-nav-links a.text-warning { color: #f59e0b; }

.code-send-group { display: flex; gap: 8px; }
.code-send-group .cyber-input { flex: 1; }
.btn-cyber-code { background: #1e293b; border: 1px solid #38bdf8; color: #38bdf8; border-radius: 6px; padding: 0 14px; white-space: nowrap; cursor: pointer; font-size: 12px; }
.btn-cyber-code:disabled { opacity: 0.5; cursor: not-allowed; }

.captcha-group { display: flex; align-items: center; gap: 10px; }
.captcha-input { width: 140px !important; min-width: 120px !important; font-family: monospace; font-weight: 700; text-align: center; }
.captcha-svg-box { cursor: pointer; display: flex; align-items: center; justify-content: center; background: #0b1120; border: 1px solid #334155; border-radius: 6px; padding: 2px; }

.redeem-box { display: flex; gap: 10px; align-items: stretch; }
.redeem-textarea { flex: 1; height: 68px; min-height: 50px; font-family: monospace; }

.traffic-meter { margin: 15px 0; }
.meter-info { display: flex; justify-content: space-between; margin-bottom: 8px; }
.data-val { font-size: 22px; font-weight: 700; color: #38bdf8; }
.data-unit { font-size: 12px; color: #64748b; margin-left: 4px; }
.progress-track { background: #1e293b; height: 10px; border-radius: 5px; overflow: hidden; margin: 10px 0; }
.progress-glow { background: linear-gradient(90deg, #38bdf8, #818cf8); height: 100%; box-shadow: 0 0 12px #38bdf8; }
.expiry-notice { font-size: 13px; color: #94a3b8; display: flex; align-items: center; gap: 6px; }
.highlight-date { color: #f59e0b; }
.monthly-tag { background: rgba(56, 189, 248, 0.15); color: #38bdf8; font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.4); }

.node-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; margin-top: 15px; }
.node-card { background: #0b1120; border: 1px solid #1e293b; border-radius: 8px; padding: 16px; transition: all 0.2s; }
.node-card:hover { border-color: #38bdf8; box-shadow: 0 0 15px rgba(56, 189, 248, 0.15); }
.node-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.node-title { font-weight: 700; font-size: 14px; color: #f1f5f9; }
.node-detail { font-size: 12px; color: #64748b; font-family: monospace; }
.sni-select-wrap { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 12px; }
.cyber-select { background: #0f172a; border: 1px solid #334155; color: #38bdf8; padding: 3px 6px; border-radius: 4px; font-size: 11px; outline: none; cursor: pointer; max-width: 190px; }
.empty-node-tip { grid-column: 1 / -1; text-align: center; padding: 30px; color: #64748b; font-size: 13px; }

/* 工具栏分区分组布局 */
.export-toolbar {
  background: #0a0f1d;
  border: 1px solid #1e293b;
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.date-filter-group { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.filter-label { color: #94a3b8; font-weight: 600; white-space: nowrap; }
.date-input { width: 140px; padding: 6px 10px; font-size: 12px; }
.export-actions-group, .delete-actions-group { display: flex; gap: 8px; align-items: center; }

@media (max-width: 1024px) {
  .settings-2col-layout { grid-template-columns: 1fr; }
  .dashboard-grid { grid-template-columns: 1fr; }
  .col-span-2 { grid-column: span 1; }
  .gen-form { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 640px) {
  .cyber-input { width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
  .header-nowrap-row { flex-wrap: wrap !important; }
  .form-row-2 { grid-template-columns: 1fr; }
  .card-tabs-nav { flex-direction: column; }
  .gen-form { grid-template-columns: 1fr; }
}
</style>