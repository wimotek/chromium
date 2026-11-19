<script setup>
import { ref, reactive, computed, defineAsyncComponent, onMounted } from 'vue'
const NodeManager = defineAsyncComponent(() => import('./components/NodeManager.vue'))
const SyncManager = defineAsyncComponent(() => import('./components/SyncManager.vue'))
const NotifyManager = defineAsyncComponent(() => import('./components/NotifyManager.vue'))
const SettingsManager = defineAsyncComponent(() => import('./components/SettingsManager.vue'))
const SetupWizard = defineAsyncComponent(() => import('./components/SetupWizard.vue'))

const token = ref(localStorage.getItem('token') || '')
const setupChecked = ref(false)
const setupRequired = ref(false)
const setupDefaults = ref({})
const runtimeBadge = reactive({
  db_type: 'sqlite',
  cache_backend: 'sqlite_cache',
  cache_state: 'sqlite_cache',
  cache_degraded: false
})

const activeNav = ref('nodes')
const captchaSvg = ref('')
const loggingIn = ref(false)
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

// 纯用户名 + 密码登录
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

const readJsonSafe = async (res) => {
  const raw = await res.text()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { detail: raw.slice(0, 200) }
  }
}

const refreshCaptcha = async () => {
  try {
    const res = await fetch('/api/captcha')
    const data = await readJsonSafe(res)
    if (res.ok && data.svg) {
      captchaSvg.value = data.svg
      loginForm.captcha_token = data.token
      loginForm.captcha_answer = ''
    } else {
      showToast(data.detail || '获取验证码失败', 'error')
    }
  } catch (e) {
    showToast(`获取验证码异常: ${e}`, 'error')
  }
}

const login = async () => {
  if (loggingIn.value) return
  loggingIn.value = true
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginForm)
    })
    const data = await readJsonSafe(res)
    if (res.ok && data.token) {
      token.value = data.token
      localStorage.setItem('token', data.token)
      loadBaseInfo()
    } else {
      showToast(data.detail || `登录失败 (HTTP ${res.status})`, 'error')
      refreshCaptcha()
    }
  } catch (e) {
    showToast(`登录请求异常: ${e}`, 'error')
  } finally {
    loggingIn.value = false
  }
}

const logout = () => {
  token.value = ''
  localStorage.removeItem('token')
  refreshCaptcha()
}

const loadBaseInfo = async () => {
  const [nRes, pRes, sRes, rtRes] = await Promise.all([
    api('/api/nodes'),
    api('/api/profile'),
    api('/api/notifications/settings'),
    api('/api/system/runtime-info')
  ])
  if (nRes.ok) nodes.value = await nRes.json()
  if (pRes.ok) Object.assign(profile, await pRes.json())
  if (sRes.ok) {
    const sData = await sRes.json()
    notifStatus.value.smtp_status = sData.smtp_status
    notifStatus.value.serverchan_enabled = sData.serverchan_enabled
  }
  if (rtRes.ok) {
    const rtData = await rtRes.json()
    runtimeBadge.db_type = rtData.db?.db_type || 'sqlite'
    runtimeBadge.cache_backend = rtData.cache?.active_backend || 'sqlite_cache'
    runtimeBadge.cache_state = rtData.cache?.engine_state || (rtData.cache?.active_backend === 'redis' ? 'redis' : (rtData.cache?.redis_configured ? 'degraded' : 'sqlite_cache'))
    runtimeBadge.cache_degraded = Boolean(rtData.cache?.degraded || runtimeBadge.cache_state === 'degraded')
  }
}

const checkSetupAndBoot = async () => {
  try {
    const res = await fetch('/api/setup/status')
    if (res.ok) {
      const data = await res.json()
      setupRequired.value = Boolean(data.setup_required)
      setupDefaults.value = data.defaults || {}
      runtimeBadge.db_type = data.db_type || 'sqlite'
      runtimeBadge.cache_backend = data.cache_backend || 'sqlite_cache'
      runtimeBadge.cache_state = data.cache_state || data.cache_backend || 'sqlite_cache'
      runtimeBadge.cache_degraded = Boolean(data.cache_degraded || runtimeBadge.cache_state === 'degraded')
    }
  } catch (e) {
    // 静默回退
  } finally {
    setupChecked.value = true
  }

  if (!setupRequired.value) {
    if (!token.value) refreshCaptcha()
    else loadBaseInfo()
  }
}

const onSetupCompleted = (data) => {
  setupRequired.value = false
  runtimeBadge.db_type = data.db_type || 'sqlite'
  runtimeBadge.cache_backend = data.cache_backend || 'sqlite_cache'
  runtimeBadge.cache_state = data.cache_state || data.cache_backend || 'sqlite_cache'
  runtimeBadge.cache_degraded = Boolean(data.cache_degraded || runtimeBadge.cache_state === 'degraded')
  if (data.token) {
    token.value = data.token
    localStorage.setItem('token', data.token)
    loadBaseInfo()
  } else {
    refreshCaptcha()
  }
}

onMounted(() => {
  checkSetupAndBoot()
})
</script>

<template>
  <div class="cdp-app-viewport">
    <!-- 全局操作 Toast 提示 -->
    <div v-if="toastMsg" class="global-toast-bar" :class="toastType === 'error' ? 'toast-err' : 'toast-ok'">
      {{ toastType === 'error' ? '❌' : '✅' }} {{ toastMsg }}
    </div>

    <!-- 0. 初始化检测中 -->
    <div v-if="!setupChecked" class="login-screen-center">
      <div style="color:#38bdf8; font-size:13px; font-family:monospace;">⚡ 正在连接 CDP Hub 控制中枢...</div>
    </div>

    <!-- 0.5 首次安装向导 -->
    <SetupWizard
      v-else-if="setupRequired"
      :defaults="setupDefaults"
      :showToast="showToast"
      @completed="onSetupCompleted"
    />

    <!-- 1. 登录界面 (屏幕正中央垂直水平居中) -->
    <div v-else-if="!token" class="login-screen-center">
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
              <input v-model="loginForm.captcha_answer" required placeholder="输入右侧字符(不区分大小写)" class="cdp-input" style="flex:1; min-width:0;">
              <div @click="refreshCaptcha" class="captcha-box" title="点击刷新验证码">
                <div v-html="captchaSvg"></div>
              </div>
            </div>
          </div>

          <button type="submit" :disabled="loggingIn" class="btn-primary-gradient" style="width:100% !important; height:40px; margin-top:8px;">
            {{ loggingIn ? '正在验证登录...' : '登 录 控 制 台' }}
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
          <button
            type="button"
            @click="activeNav = 'settings'"
            title="点击查看缓存引擎状态与热切换配置"
            :style="{
              fontSize: '11px',
              color: runtimeBadge.cache_degraded ? '#fbbf24' : (runtimeBadge.cache_state === 'redis' ? '#34d399' : '#38bdf8'),
              background: runtimeBadge.cache_degraded ? 'rgba(217, 119, 6, 0.16)' : '#09122a',
              border: runtimeBadge.cache_degraded ? '1px solid #d97706' : (runtimeBadge.cache_state === 'redis' ? '1px solid #059669' : '1px solid #172554'),
              padding: '3px 9px',
              borderRadius: '4px',
              fontFamily: 'monospace',
              cursor: 'pointer'
            }"
          >
            ORM:{{ runtimeBadge.db_type.toUpperCase() }} ·
            {{
              runtimeBadge.cache_degraded
                ? '⚠️ 缓存降级 (SQL Cache)'
                : (runtimeBadge.cache_state === 'redis' ? '⚡ Redis' : '💾 SQL Cache')
            }}
          </button>
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
            <div class="pill-badge">{{ notifStatus.smtp_status === 'ready' ? '邮件就绪' : (notifStatus.serverchan_enabled ? '微信已启' : '未就绪') }}</div>
          </div>

          <div @click="activeNav = 'settings'" :class="['kpi-card', activeNav === 'settings' ? 'kpi-card-active' : '']">
            <div class="kpi-left">
              <div class="icon-avatar avatar-indigo">⚙️</div>
              <div class="kpi-info">
                <div class="kpi-title">系统安全与外部 API</div>
                <div class="kpi-desc">Agent 对外接口 Key、存储缓存监控与管理员设置</div>
              </div>
            </div>
            <div class="pill-badge">配置中心</div>
          </div>
        </div>

        <!-- 挂载各拆分子组件 -->
        <NodeManager v-if="activeNav === 'nodes'" :api="api" :showToast="showToast" @update-nodes="loadBaseInfo" />
        <SyncManager v-if="activeNav === 'sync'" :api="api" :showToast="showToast" />
        <NotifyManager v-if="activeNav === 'notifications'" :api="api" :showToast="showToast" @update-status="loadBaseInfo" />
        <SettingsManager v-if="activeNav === 'settings'" :api="api" :showToast="showToast" @logout="logout" @runtime-updated="loadBaseInfo" />
      </main>
    </div>
  </div>
</template>