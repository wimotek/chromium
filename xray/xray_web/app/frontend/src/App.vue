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
      <!-- 1. 登录 / 注册模块 (暗黑毛玻璃卡片) -->
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
        <!-- 流量与有效期状态卡 -->
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

        <!-- 卡密自主充值卡 -->
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

        <!-- 节点配置与密钥 -->
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
            <button class="btn-cyber-action" @click="openQrModal(currentUser.sub_link)">📱 弹出二维码扫码</button>
          </div>
        </div>
      </div>

      <!-- 3. 管理员控制台 (APP_MODE 为 all/admin 时开放) -->
      <div v-else-if="currentUser.role === 'admin'" class="admin-grid">
        <div class="cyber-card col-span-2">
          <div class="card-header"><h3>🛠️ 商业运营制卡中心</h3></div>
          <div class="gen-form">
            <div>
              <label>流量 (GB)</label>
              <input v-model.number="cardGenForm.traffic_gb" type="number" class="cyber-input" />
            </div>
            <div>
              <label>有效天数</label>
              <input v-model.number="cardGenForm.days" type="number" class="cyber-input" />
            </div>
            <div>
              <label>制卡张数</label>
              <input v-model.number="cardGenForm.count" type="number" class="cyber-input" />
            </div>
            <button class="btn-cyber-success btn-gen" @click="generateCards">批量制卡</button>
          </div>
        </div>

        <!-- 卡密库存表格 -->
        <div class="cyber-card col-span-2">
          <div class="card-header"><h3>📦 卡密库存监管 (最新50条)</h3></div>
          <div class="table-container">
            <table class="cyber-table">
              <thead>
                <tr><th>卡密编号</th><th>套餐配额</th><th>状态</th><th>使用用户</th><th>操作</th></tr>
              </thead>
              <tbody>
                <tr v-for="c in adminCards" :key="c.code">
                  <td class="font-mono">{{ c.code }}</td>
                  <td>{{ c.traffic_gb }} GB / {{ c.days }} 天</td>
                  <td><span class="badge" :class="c.is_used ? 'badge-used' : 'badge-ready'">{{ c.is_used ? '已核销' : '有效' }}</span></td>
                  <td>{{ c.used_by || '-' }}</td>
                  <td><button class="btn-sm" @click="copyText(c.code)">复制</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 用户列表 -->
        <div class="cyber-card col-span-2">
          <div class="card-header"><h3>👥 全站接入用户监控</h3></div>
          <div class="table-container">
            <table class="cyber-table">
              <thead>
                <tr><th>用户账号</th><th>流量使用情况</th><th>过期时限</th><th>系统角色</th></tr>
              </thead>
              <tbody>
                <tr v-for="u in adminUsers" :key="u.username">
                  <td><b>{{ u.username }}</b></td>
                  <td>{{ u.used_mb }} MB / {{ u.traffic_limit_mb }} MB</td>
                  <td>{{ u.expire_date }}</td>
                  <td><span class="role-badge" :class="u.role">{{ u.role }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>

    <!-- 二维码暗黑弹窗 Modal -->
    <div v-if="showQrModal" class="modal-backdrop" @click="showQrModal = false">
      <div class="cyber-modal" @click.stop>
        <h3>📱 客户端扫码导入</h3>
        <p class="modal-tip">支持 v2rayN、Sing-box、Clash-Meta 等客户端直接相机扫码导入</p>
        <div class="qr-box">
          <img :src="qrCodeDataUrl" alt="QR Code" />
        </div>
        <button class="btn-cyber-primary" style="margin-top: 15px;" @click="showQrModal = false">关闭窗口</button>
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
const showQrModal = ref(false)
const qrCodeDataUrl = ref('')

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

// 弹出二维码函数
const openQrModal = async (link) => {
  if (!link) return ElMessage.warning('链接无效')
  try {
    qrCodeDataUrl.value = await QRCode.toDataURL(link, { width: 260, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
    showQrModal.value = true
  } catch (err) {
    ElMessage.error('二维码渲染失败')
  }
}

// 兼容非 HTTPS 环境一键复制
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
/* 全局暗黑科技风质感 */
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
  max-width: 1000px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.brand-title {
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 1.5px;
}
.highlight { color: #38bdf8; text-shadow: 0 0 10px rgba(56, 189, 248, 0.5); }
.user-status { display: flex; align-items: center; gap: 12px; }

/* 科技卡片风格 */
.main-body { max-width: 1000px; margin: 30px auto; padding: 0 16px; }
.dashboard-grid, .admin-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
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

/* 仪表与进度 */
.traffic-meter { margin: 15px 0; }
.meter-info { display: flex; justify-content: space-between; margin-bottom: 8px; }
.data-val { font-size: 22px; font-weight: 700; color: #38bdf8; }
.data-unit { font-size: 12px; color: #64748b; margin-left: 4px; }
.progress-track { background: #1e293b; height: 10px; border-radius: 5px; overflow: hidden; margin: 10px 0; }
.progress-glow { background: linear-gradient(90deg, #38bdf8, #818cf8); height: 100%; box-shadow: 0 0 12px #38bdf8; }
.expiry-notice { font-size: 13px; color: #94a3b8; }
.highlight-date { color: #f59e0b; }

/* 控件 */
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
.btn-cyber-success { background: #059669; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; }
.btn-cyber-action { background: #334155; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; }

/* 节点代码展示区 */
.node-field { margin-bottom: 14px; }
.node-field label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
.code-display {
  background: #020617; border: 1px dashed rgba(255, 255, 255, 0.15); padding: 12px; border-radius: 6px;
  font-size: 13px; word-break: break-all; font-family: monospace;
}
.text-green { color: #34d399; font-weight: bold; }
.text-cyan { color: #38bdf8; }
.btn-group { display: flex; gap: 12px; margin-top: 16px; }

/* 弹窗 Modal */
.modal-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.75); display: flex; justify-content: center; align-items: center; z-index: 1000; }
.cyber-modal { background: #0f172a; border: 1px solid #38bdf8; border-radius: 12px; padding: 24px; text-align: center; max-width: 340px; }
.qr-box { background: white; padding: 12px; border-radius: 8px; display: inline-block; margin-top: 10px; }
.modal-tip { font-size: 12px; color: #94a3b8; margin: 6px 0 12px 0; }

/* 表格与徽章 */
.table-container { overflow-x: auto; }
.cyber-table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
.cyber-table th, .cyber-table td { padding: 10px; border-bottom: 1px solid #1e293b; }
.cyber-table th { color: #64748b; font-weight: 600; }
.badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; }
.badge-ready { background: rgba(16, 185, 129, 0.2); color: #34d399; }
.badge-used { background: rgba(239, 68, 68, 0.2); color: #f87171; }
.role-badge { padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
.role-badge.admin { background: #dc2626; color: white; }
.role-badge.user { background: #2563eb; color: white; }
.btn-logout { background: transparent; border: 1px solid #475569; color: #94a3b8; padding: 4px 10px; border-radius: 4px; cursor: pointer; }
.auth-box { max-width: 400px; margin: 50px auto; }
.form-item { margin-bottom: 16px; }
.form-item label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
.auth-toggle { text-align: center; margin-top: 16px; font-size: 13px; }
.auth-toggle a { color: #38bdf8; text-decoration: none; }
.redeem-box { display: flex; gap: 10px; }
.gen-form { display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: 10px; align-items: flex-end; }
</style>