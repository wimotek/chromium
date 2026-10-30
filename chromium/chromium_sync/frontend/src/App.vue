<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import NodeManager from './components/NodeManager.vue'
import SyncManager from './components/SyncManager.vue'
import NotifyManager from './components/NotifyManager.vue'
import SettingsManager from './components/SettingsManager.vue'

const token = ref(localStorage.getItem('token') || '')
const activeNav = ref('nodes')
const captchaSvg = ref('')
const toastMsg = ref('')
const toastType = ref('success')

const showToast = (msg, type = 'success') => {
  toastMsg.value = msg
  toastType.value = type
  setTimeout(() => { toastMsg.value = '' }, 3500)
}

const nodes = ref([])
const totalCookies = computed(() => nodes.value.reduce((acc, n) => acc + (n.cookie_count || 0), 0))
const notifStatus = ref({ smtp_status: 'untested', serverchan_enabled: false })
const profile = reactive({ username: '' })

const loginForm = reactive({
  username: '',
  password: '',
  captcha_token: '',
  captcha_answer: ''
})

const api = async (url, options = {}) => {
  options.headers = options.headers || {}
  if (token.value) options.headers['Authorization'] = `Bearer ${token.value}`
  const res = await fetch(url, options)
  if (res.status === 401) logout()
  return res
}

const refreshCaptcha = async () => {
  const res = await fetch('/api/captcha')
  const data = await res.json()
  captchaSvg.value = data.svg
  loginForm.captcha_token = data.token
}

const login = async () => {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(loginForm)
  })
  const data = await res.json()
  if (res.ok) {
    token.value = data.token
    localStorage.setItem('token', data.token)
    loadBaseInfo()
  } else {
    showToast(data.detail || '用户名或密码错误', 'error')
    refreshCaptcha()
  }
}

const logout = () => {
  token.value = ''
  localStorage.removeItem('token')
  refreshCaptcha()
}

const loadBaseInfo = async () => {
  const [nRes, pRes, sRes] = await Promise.all([
    api('/api/nodes'),
    api('/api/profile'),
    api('/api/notifications/settings')
  ])
  nodes.value = await nRes.json()
  Object.assign(profile, await pRes.json())
  const sData = await sRes.json()
  notifStatus.value.smtp_status = sData.smtp_status
  notifStatus.value.serverchan_enabled = sData.serverchan_enabled
}

onMounted(() => {
  if (!token.value) refreshCaptcha()
  else loadBaseInfo()
})
</script>

<template>
  <div class="cdp-app-viewport">
    
    <!-- 全局操作 Toast 提示 -->
    <div v-if="toastMsg" class="global-toast-bar" :class="toastType === 'error' ? 'toast-err' : 'toast-ok'">
      {{ toastType === 'error' ? '❌' : '✅' }} {{ toastMsg }}
    </div>

    <!-- 1. 登录界面 (屏幕正中央垂直水平居中) -->
    <div v-if="!token" class="login-screen-center">
      <div class="login-card-navy">
        <div class="login-brand-line">
          <span class="bolt-symbol">⚡</span>
          <span class="brand-white">CDP</span>
          <span class="brand-cyan">CLUSTER</span>
        </div>

        <form @submit.prevent="login" class="login-form-stack">
          <div class="form-row">
            <label class="form-label">管理员用户名</label>
            <input v-model="loginForm.username" required placeholder="admin" class="cdp-input">
          </div>

          <div class="form-row">
            <label class="form-label">登录密码</label>
            <input type="password" v-model="loginForm.password" required placeholder="••••••••••••" class="cdp-input">
          </div>

          <div class="form-row">
            <label class="form-label">人机验证</label>
            <div class="captcha-row">
              <input v-model="loginForm.captcha_answer" required placeholder="计算答案" class="cdp-input" style="flex:1;">
              <div @click="refreshCaptcha" class="captcha-box" title="点击刷新验证码">
                <div v-html="captchaSvg"></div>
              </div>
            </div>
          </div>

          <button type="submit" class="btn-primary-gradient" style="width:100%; padding:10px; margin-top:8px;">
            登 录 控 制 台
          </button>
        </form>
      </div>
    </div>

    <!-- 2. 后台控制台 (全屏 100% 流式自适应 + 4 个顶置横排大卡片) -->
    <div v-else class="dashboard-fluid-layout">
      <!-- 顶栏 -->
      <header class="header-full-bar">
        <div class="header-left">
          <span class="bolt-symbol">⚡</span>
          <span class="brand-white">CDP</span>
          <span class="brand-cyan">CLUSTER // SYNC MATRIX</span>
        </div>

        <div class="header-right">
          <span class="badge-admin">SYSTEM ADMIN</span>
          <span class="username-label">{{ profile.username || 'admin' }}</span>
          <button @click="logout" class="btn-logout">退出</button>
        </div>
      </header>

      <!-- 全屏流式主容器 -->
      <main class="main-fluid-canvas">
        
        <!-- 4 个顶置横排大卡片导航 -->
        <div class="top-cards-row-4">
          <div @click="activeNav = 'nodes'" :class="['kpi-card', activeNav === 'nodes' ? 'kpi-card-active' : '']">
            <div class="kpi-left">
              <div class="icon-avatar avatar-purple">👥</div>
              <div class="kpi-info">
                <div class="kpi-title">CDP 节点集群调度</div>
                <div class="kpi-desc">本地直连/远程穿透监管、探针状态检测与接入</div>
              </div>
            </div>
            <div class="pill-badge">{{ nodes.length }} 个节点</div>
          </div>

          <div @click="activeNav = 'sync'" :class="['kpi-card', activeNav === 'sync' ? 'kpi-card-active' : '']">
            <div class="kpi-left">
              <div class="icon-avatar avatar-cyan">🌐</div>
              <div class="kpi-info">
                <div class="kpi-title">全网 Cookie 同步中枢</div>
                <div class="kpi-desc">15分钟定时调度、源节点指定、双向智能注入与分发</div>
              </div>
            </div>
            <div class="pill-badge">{{ totalCookies }} 条存量</div>
          </div>

          <div @click="activeNav = 'notifications'" :class="['kpi-card', activeNav === 'notifications' ? 'kpi-card-active' : '']">
            <div class="kpi-left">
              <div class="icon-avatar avatar-pink">🔔</div>
              <div class="kpi-info">
                <div class="kpi-title">通知预警与发信中心</div>
                <div class="kpi-desc">SMTP 邮件发信、Server酱微信实时推送、故障秒级告警</div>
              </div>
            </div>
            <div class="pill-badge">{{ notifStatus.smtp_status === 'ready' ? '邮件正常' : (notifStatus.serverchan_enabled ? '微信已启' : '未就绪') }}</div>
          </div>

          <div @click="activeNav = 'settings'" :class="['kpi-card', activeNav === 'settings' ? 'kpi-card-active' : '']">
            <div class="kpi-left">
              <div class="icon-avatar avatar-indigo">⚙️</div>
              <div class="kpi-info">
                <div class="kpi-title">系统安全与外部 API</div>
                <div class="kpi-desc">Agent 对外接口 Key、SSH 密钥金库与管理员密码设置</div>
              </div>
            </div>
            <div class="pill-badge">配置就绪</div>
          </div>
        </div>

        <!-- 挂载各拆分子组件 -->
        <NodeManager v-if="activeNav === 'nodes'" :api="api" :showToast="showToast" @update-nodes="loadBaseInfo" />
        <SyncManager v-if="activeNav === 'sync'" :api="api" :showToast="showToast" />
        <NotifyManager v-if="activeNav === 'notifications'" :api="api" :showToast="showToast" @update-status="loadBaseInfo" />
        <SettingsManager v-if="activeNav === 'settings'" :api="api" :showToast="showToast" @logout="logout" />

      </main>
    </div>
  </div>
</template>