<script setup>
import { ref, reactive, computed, onMounted } from 'vue'

const token = ref(localStorage.getItem('token') || '')
const activeNav = ref('nodes') // 'nodes' | 'sync' | 'notifications' | 'settings'
const captchaSvg = ref('')

const nodes = ref([])
const keys = ref([])
const logs = ref([])
const isSyncing = ref(false)
const showNodeModal = ref(false)

const loginForm = reactive({
  account: '',
  password: '',
  captcha_token: '',
  captcha_answer: ''
})

const profile = reactive({
  username: '',
  email: '',
  new_password: ''
})

const notif = reactive({
  smtp_host: '',
  smtp_port: '465',
  smtp_ssl: true,
  smtp_user: '',
  smtp_pass: '',
  smtp_to: '',
  serverchan_key: '',
  serverchan_enabled: false
})

const newNode = reactive({
  name: '',
  is_local: true,
  ssh_host: '',
  ssh_port: 22,
  ssh_user: 'root',
  ssh_key_filename: '',
  ssh_password: '',
  remote_cdp_port: 9222,
  local_bind_port: 9222
})

const totalCookies = computed(() => nodes.value.reduce((acc, n) => acc + (n.cookie_count || 0), 0))

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
    loadAll()
  } else {
    alert(data.detail || '用户名、邮箱或密码错误')
    refreshCaptcha()
  }
}

const logout = () => {
  token.value = ''
  localStorage.removeItem('token')
  refreshCaptcha()
}

const loadAll = async () => {
  const [nRes, kRes, lRes, pRes, sRes] = await Promise.all([
    api('/api/nodes'),
    api('/api/ssh-keys'),
    api('/api/sync/logs'),
    api('/api/profile'),
    api('/api/notifications/settings')
  ])
  nodes.value = await nRes.json()
  keys.value = await kRes.json()
  logs.value = await lRes.json()
  Object.assign(profile, await pRes.json())
  Object.assign(notif, await sRes.json())
}

const probeNode = async (node) => {
  const res = await api(`/api/nodes/${node.id}/probe`, { method: 'POST' })
  const data = await res.json()
  node.cookie_count = data.cookie_count
}

const triggerSync = async () => {
  if (isSyncing.value) return
  isSyncing.value = true
  try {
    const res = await api('/api/sync/trigger', { method: 'POST' })
    const data = await res.json()
    alert(data.message)
    loadAll()
  } finally {
    isSyncing.value = false
  }
}

const toggleTunnel = async (node) => {
  await api(`/api/nodes/${node.id}/toggle-tunnel`, { method: 'POST' })
  loadAll()
}

const setSource = async (id) => {
  await api(`/api/nodes/${id}/set-source`, { method: 'POST' })
  loadAll()
}

const deleteNode = async (id) => {
  if (confirm('确认销毁该节点治理配置？')) {
    await api(`/api/nodes/${id}`, { method: 'DELETE' })
    loadAll()
  }
}

const createNode = async () => {
  await api('/api/nodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newNode)
  })
  showNodeModal.value = false
  newNode.name = ''
  newNode.ssh_host = ''
  newNode.local_bind_port += 1
  loadAll()
}

const saveNotif = async () => {
  const res = await api('/api/notifications/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(notif)
  })
  if (res.ok) alert('通知设置已保存')
}

const testEmail = async () => {
  const res = await api('/api/notifications/test-email', { method: 'POST' })
  const data = await res.json()
  alert(data.message || data.detail)
}

const testServerChan = async () => {
  const res = await api('/api/notifications/test-serverchan', { method: 'POST' })
  const data = await res.json()
  alert(data.message || data.detail)
}

const saveProfile = async () => {
  const res = await api('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile)
  })
  if (res.ok) {
    alert('管理员配置已保存')
    if (profile.new_password) logout()
  }
}

const uploadKey = async (e) => {
  const file = e.target.files[0]
  if (!file) return
  const fd = new FormData()
  fd.append('file', file)
  await api('/api/ssh-keys', { method: 'POST', body: fd })
  loadAll()
}

const deleteKey = async (name) => {
  if (confirm(`确认销毁密钥 [${name}]？`)) {
    await api(`/api/ssh-keys/${name}`, { method: 'DELETE' })
    loadAll()
  }
}

onMounted(() => {
  if (!token.value) refreshCaptcha()
  else loadAll()
})
</script>

<template>
  <div class="xray-viewport">
    
    <!-- 1. 登录界面 (原生 Flex 垂直水平死锁绝对居中) -->
    <div v-if="!token" class="login-wrapper-center">
      <div class="login-card-navy">
        <div class="login-brand-line">
          <span class="bolt-symbol">⚡</span>
          <span class="brand-xray">XRAY</span>
          <span class="brand-reality">REALITY</span>
        </div>

        <form @submit.prevent="login" class="login-form-stack">
          <div class="form-row">
            <label class="form-label">用户账号 / 绑定邮箱</label>
            <input v-model="loginForm.account" required placeholder="admin 或 admin@wimotek.com" class="xray-input">
          </div>

          <div class="form-row">
            <label class="form-label">访问密码</label>
            <input type="password" v-model="loginForm.password" required placeholder="••••••••••••" class="xray-input">
          </div>

          <div class="form-row">
            <label class="form-label">人机验证</label>
            <div class="captcha-row">
              <input v-model="loginForm.captcha_answer" required placeholder="计算答案" class="xray-input" style="flex:1;">
              <div @click="refreshCaptcha" class="captcha-box" title="点击刷新验证码">
                <div v-html="captchaSvg"></div>
              </div>
            </div>
          </div>

          <button type="submit" class="btn-primary-gradient" style="width:100%; padding:10px; margin-top:8px;">
            登 录 面 板
          </button>
        </form>
      </div>
    </div>

    <!-- 2. 后台控制台 (1:1 截图布局) -->
    <div v-else class="dashboard-layout">
      <!-- 顶栏 (截图同款) -->
      <header class="header-bar">
        <div class="header-left">
          <span class="bolt-symbol">⚡</span>
          <span class="brand-xray">XRAY</span>
          <span class="brand-reality">REALITY</span>
        </div>

        <div class="header-right">
          <span class="badge-admin">SYSTEM ADMIN</span>
          <span class="username-label">{{ profile.username || 'richard' }}</span>
          <button @click="logout" class="btn-logout">退出</button>
        </div>
      </header>

      <!-- 主视图容器 -->
      <main class="main-container">
        
        <!-- 4 个顶置横排大卡片 (纯原生 CSS Grid 强制 4 列，决不占满全屏堆叠！) -->
        <div class="cards-grid-4">
          
          <!-- 卡片 1 (第一张带电光蓝发光圈) -->
          <div 
            @click="activeNav = 'nodes'"
            :class="['kpi-card', activeNav === 'nodes' ? 'kpi-card-active' : '']"
          >
            <div class="kpi-left">
              <div class="icon-avatar avatar-purple">👥</div>
              <div class="kpi-info">
                <div class="kpi-title">全站用户生命周期管理</div>
                <div class="kpi-desc">配额/时效治理、重置UUID与密码、凭证二维码</div>
              </div>
            </div>
            <div class="pill-badge">{{ nodes.length }} 位用户</div>
          </div>

          <!-- 卡片 2 -->
          <div 
            @click="activeNav = 'sync'"
            :class="['kpi-card', activeNav === 'sync' ? 'kpi-card-active' : '']"
          >
            <div class="kpi-left">
              <div class="icon-avatar avatar-cyan">🌐</div>
              <div class="kpi-info">
                <div class="kpi-title">远程节点 (xray_core) 集群</div>
                <div class="kpi-desc">多节点公钥监管、在线状态、配置修改与接入</div>
              </div>
            </div>
            <div class="pill-badge">{{ totalCookies }} 条资产</div>
          </div>

          <!-- 卡片 3 -->
          <div 
            @click="activeNav = 'notifications'"
            :class="['kpi-card', activeNav === 'notifications' ? 'kpi-card-active' : '']"
          >
            <div class="kpi-left">
              <div class="icon-avatar avatar-pink">🎫</div>
              <div class="kpi-info">
                <div class="kpi-title">卡密生成与发卡中心</div>
                <div class="kpi-desc">批量制卡、库存导出、范围清理、对接 API</div>
              </div>
            </div>
            <div class="pill-badge">{{ notif.serverchan_enabled ? '微信已启' : '邮件通知' }}</div>
          </div>

          <!-- 卡片 4 -->
          <div 
            @click="activeNav = 'settings'"
            :class="['kpi-card', activeNav === 'settings' ? 'kpi-card-active' : '']"
          >
            <div class="kpi-left">
              <div class="icon-avatar avatar-indigo">⚙️</div>
              <div class="kpi-info">
                <div class="kpi-title">系统发信与全局运维配置</div>
                <div class="kpi-desc">公告设置、SMTP、HTTPS证书、📢 用户群发通知</div>
              </div>
            </div>
            <div class="pill-badge">配置中心</div>
          </div>

        </div>

        <!-- 主内容卡片 (1:1 截图排布) -->
        
        <!-- 页面 1: 接入用户治理列表 (节点列表) -->
        <div v-if="activeNav === 'nodes'" class="content-card">
          <div class="table-header-bar">
            <div class="table-title">
              <span class="icon-duo-users">👥</span>
              <h2>接入用户治理列表</h2>
            </div>
            <div style="display:flex; gap:10px;">
              <button @click="showNodeModal = true" class="btn-primary-gradient">+ 新增接入节点</button>
              <button @click="loadAll" class="btn-primary-gradient">🔄 刷新数据</button>
            </div>
          </div>

          <!-- 表格 (1:1 截图字段与胶囊小按钮) -->
          <div class="table-responsive">
            <table class="xray-table">
              <thead>
                <tr>
                  <th style="width: 20%;">用户 / 绑定邮箱</th>
                  <th style="width: 10%;">状态</th>
                  <th style="width: 14%;">流量使用 / 总配额</th>
                  <th style="width: 12%;">到期时间</th>
                  <th style="width: 12%;">套餐特性</th>
                  <th style="width: 12%;">专属凭证</th>
                  <th style="width: 20%; text-align: right;">治理操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="node in nodes" :key="node.id">
                  <td>
                    <div class="cell-main-name">{{ node.name }}</div>
                    <div class="cell-sub-desc">
                      {{ node.is_local ? '127.0.0.1 (本机回环)' : `${node.ssh_user}@${node.ssh_host}:${node.ssh_port}` }}
                    </div>
                  </td>

                  <!-- 截图同款绿色胶囊徽章: ● 活跃 -->
                  <td>
                    <span v-if="node.status === 'connected'" class="status-active">● 活跃</span>
                    <span v-else-if="node.status === 'stopped'" class="status-standby">○ 离线</span>
                    <span v-else class="status-error">✕ 异常</span>
                  </td>

                  <td class="font-cyan-mono">127.0.0.1:{{ node.local_bind_port }}</td>

                  <td>
                    <div class="cookie-badge">
                      <span>🍪 {{ node.cookie_count || 0 }} 条</span>
                      <button @click="probeNode(node)" class="link-probe">刷新</button>
                    </div>
                  </td>

                  <!-- 截图同款普通固定蓝标签 -->
                  <td>
                    <span v-if="node.is_local" class="tag-plan-blue">普通固定 (本地)</span>
                    <span v-else class="tag-plan-indigo">SSH 穿透 (远程)</span>
                  </td>

                  <!-- 截图同款专属凭证二维码蓝按钮 -->
                  <td>
                    <button v-if="node.is_source" class="btn-qrcode">🪪 凭证/默认源</button>
                    <button v-else @click="setSource(node.id)" class="btn-set-source">设为源</button>
                  </td>

                  <!-- 截图同款横排微型彩色治理按钮组 -->
                  <td style="text-align: right;">
                    <div class="btn-group-row">
                      <button @click="toggleTunnel(node)" class="btn-micro btn-orange">
                        🔑 {{ node.is_local ? '测试' : (node.status === 'connected' ? '断开' : '穿透') }}
                      </button>
                      <button @click="probeNode(node)" class="btn-micro btn-red">🔀 探针</button>
                      <button @click="setSource(node.id)" class="btn-micro btn-purple">✏️ 配额</button>
                      <button @click="deleteNode(node.id)" class="btn-micro btn-trash">🗑️</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 页面 2: Cookie 同步中心 -->
        <div v-if="activeNav === 'sync'" class="content-card">
          <div class="table-header-bar">
            <div class="table-title">
              <span class="icon-duo-users" style="color:#38bdf8;">🌐</span>
              <h2>Cookie 集群全自动同步与调度治理</h2>
            </div>
            <button @click="triggerSync" :disabled="isSyncing" class="btn-primary-gradient">
              {{ isSyncing ? '同步中...' : '⚡ 立即触发同步' }}
            </button>
          </div>
          <div class="info-banner-blue">
            <p>• 定时调度：后台常驻引擎每 <span style="color:#00f0ff; font-weight:bold;">15 分钟</span> 自动从默认源节点抓取最新全量 Cookies 并分发到所有活跃节点。</p>
            <p>• 本地加速：本地直连节点跳过 SSH 隧道，直接通过 CDP WebSocket 极速注入。</p>
          </div>
          <div style="margin-top:20px;">
            <h3 style="font-size:13px; font-weight:bold; color:#cbd5e1; margin-bottom:8px;">最近调度审计事件：</h3>
            <div class="console-box">
              <div v-for="l in logs" :key="l.id" class="console-item">
                <div class="console-meta">
                  <span>[{{ l.timestamp }}]</span>
                  <span :style="{ color: l.status==='SUCCESS' ? '#34d399' : '#f87171', fontWeight: 'bold' }">[{{ l.status }}]</span>
                </div>
                <pre class="console-pre">{{ l.details }}</pre>
              </div>
              <div v-if="logs.length === 0" style="text-align:center; color:#64748b; padding:40px;">暂无调度事件</div>
            </div>
          </div>
        </div>

        <!-- 页面 3: 告警预警与发信 (双列对称) -->
        <div v-if="activeNav === 'notifications'" class="grid-2col">
          <!-- SMTP -->
          <div class="content-card">
            <div class="table-header-bar">
              <h3 class="card-inner-h3">📧 SMTP 邮件发信通道</h3>
              <button @click="testEmail" class="link-probe" style="font-size:12px;">发送测试邮件</button>
            </div>
            <div class="form-v-stack">
              <div>
                <label class="form-label">SMTP 发信服务器</label>
                <input v-model="notif.smtp_host" placeholder="smtp.qq.com" class="xray-input">
              </div>
              <div class="row-flex-gap">
                <div style="flex:1;">
                  <label class="form-label">端口</label>
                  <input v-model="notif.smtp_port" placeholder="465" class="xray-input">
                </div>
                <div style="flex:1;">
                  <label class="form-label">加密协议</label>
                  <select v-model="notif.smtp_ssl" class="xray-input">
                    <option :value="true">SSL / TLS</option>
                    <option :value="false">STARTTLS / 明文</option>
                  </select>
                </div>
              </div>
              <div>
                <label class="form-label">发信账号</label>
                <input v-model="notif.smtp_user" placeholder="user@domain.com" class="xray-input">
              </div>
              <div>
                <label class="form-label">发信授权码 / 密码</label>
                <input v-model="notif.smtp_pass" type="password" placeholder="授权码" class="xray-input">
              </div>
              <div>
                <label class="form-label">接收预警邮箱</label>
                <input v-model="notif.smtp_to" placeholder="admin@domain.com" class="xray-input">
              </div>
              <button @click="saveNotif" class="btn-primary-gradient" style="width:100%; padding:10px;">保存邮件配置</button>
            </div>
          </div>

          <!-- Server酱 -->
          <div class="content-card">
            <div class="table-header-bar">
              <h3 class="card-inner-h3">📱 Server酱 (微信推送)</h3>
              <button @click="testServerChan" class="link-probe" style="font-size:12px;">发送微信测试</button>
            </div>
            <div class="form-v-stack">
              <div style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" v-model="notif.serverchan_enabled" id="s_c_box">
                <label for="s_c_box" style="font-size:13px; color:#cbd5e1;">启用微信实时推送</label>
              </div>
              <div>
                <label class="form-label">Server酱 SendKey</label>
                <input v-model="notif.serverchan_key" placeholder="SCTxxxxxxxxxxxxxxxx" class="xray-input" style="font-family:monospace;">
                <p style="font-size:11px; color:#64748b; margin-top:6px;">在 sct.ftqq.com 申请的 SendKey。同步失败或节点下线时自动推送到微信。</p>
              </div>
              <button @click="saveNotif" class="btn-primary-gradient" style="width:100%; padding:10px; margin-top:30px;">保存微信配置</button>
            </div>
          </div>
        </div>

        <!-- 页面 4: 全局运维配置与账号安全 -->
        <div v-if="activeNav === 'settings'" class="grid-2col">
          <div class="content-card">
            <h3 class="card-inner-h3" style="margin-bottom:16px;">👤 管理员账号与登录凭证</h3>
            <form @submit.prevent="saveProfile" class="form-v-stack">
              <div>
                <label class="form-label">登录用户名</label>
                <input v-model="profile.username" required class="xray-input">
              </div>
              <div>
                <label class="form-label">绑定邮箱 (支持直接登录)</label>
                <input v-model="profile.email" type="email" required class="xray-input">
              </div>
              <div>
                <label class="form-label">重置新密码 (留空则不改)</label>
                <input v-model="profile.new_password" type="password" placeholder="至少 6 位安全字符" minlength="6" class="xray-input">
              </div>
              <button type="submit" class="btn-primary-gradient" style="width:100%; padding:10px; margin-top:10px;">保存账号修改</button>
            </form>
          </div>

          <div class="content-card">
            <div class="table-header-bar">
              <h3 class="card-inner-h3">🔑 SSH 密钥存储库</h3>
              <span style="font-size:12px; color:#64748b;">{{ keys.length }} 个凭据</span>
            </div>
            <div style="margin-bottom: 12px;">
              <input type="file" @change="uploadKey" style="font-size:12px; color:#94a3b8;">
            </div>
            <ul class="keys-list">
              <li v-for="k in keys" :key="k.filename" class="key-row">
                <span style="font-family:monospace;">🔑 {{ k.filename }} ({{ k.size }} Bytes)</span>
                <button @click="deleteKey(k.filename)" class="link-probe" style="color:#f87171;">销毁</button>
              </li>
              <li v-if="keys.length === 0" style="text-align:center; color:#64748b; padding:20px;">暂无私钥证书</li>
            </ul>
          </div>
        </div>

      </main>

      <!-- 新增节点 Dialog 弹窗 -->
      <div v-if="showNodeModal" class="modal-backdrop">
        <div class="modal-card">
          <div class="modal-title-bar">
            <h3 style="font-size:14px; font-weight:bold; color:#fff;">接入新 CDP 实例节点</h3>
            <button @click="showNodeModal = false" style="background:none; border:none; color:#94a3b8; font-size:16px; cursor:pointer;">✕</button>
          </div>

          <form @submit.prevent="createNode" class="form-v-stack" style="margin-top:14px;">
            <div>
              <label class="form-label">接入类型</label>
              <div class="row-flex-gap">
                <label :class="['radio-pill-card', newNode.is_local ? 'radio-pill-active' : '']">
                  <input type="radio" v-model="newNode.is_local" :value="true" style="display:none;">
                  <span>💻 本地直连 (免SSH)</span>
                </label>
                <label :class="['radio-pill-card', !newNode.is_local ? 'radio-pill-active' : '']">
                  <input type="radio" v-model="newNode.is_local" :value="false" style="display:none;">
                  <span>🌐 远程 SSH 穿透</span>
                </label>
              </div>
            </div>

            <div>
              <label class="form-label">节点名称</label>
              <input v-model="newNode.name" required placeholder="如: 本机 Chrome 01" class="xray-input">
            </div>

            <div v-if="newNode.is_local" style="background:#09122a; padding:12px; border-radius:6px; border:1px solid #172554;">
              <label class="form-label">本地 CDP 调试端口 (默认 9222)</label>
              <input v-model="newNode.local_bind_port" type="number" required placeholder="9222" class="xray-input font-cyan-mono">
              <p style="font-size:11px; color:#64748b; margin-top:6px;">直接接入本机 Chromium 实例，无需任何 SSH 握手开销。</p>
            </div>

            <div v-else class="form-v-stack">
              <div class="row-flex-gap">
                <div style="flex:1;">
                  <label class="form-label">SSH 主机 / IP</label>
                  <input v-model="newNode.ssh_host" required placeholder="192.168.1.100" class="xray-input" style="font-family:monospace;">
                </div>
                <div style="flex:1;">
                  <label class="form-label">SSH 端口</label>
                  <input v-model="newNode.ssh_port" type="number" placeholder="22" class="xray-input" style="font-family:monospace;">
                </div>
              </div>

              <div>
                <label class="form-label">SSH 用户名</label>
                <input v-model="newNode.ssh_user" required placeholder="root" class="xray-input" style="font-family:monospace;">
              </div>

              <div>
                <label class="form-label">绑定 SSH 证书 (选填)</label>
                <select v-model="newNode.ssh_key_filename" class="xray-input" style="font-family:monospace;">
                  <option value="">密码认证 (不选择私钥)</option>
                  <option v-for="k in keys" :key="k.filename" :value="k.filename">🔑 {{ k.filename }}</option>
                </select>
              </div>

              <div v-if="!newNode.ssh_key_filename">
                <label class="form-label">SSH 密码</label>
                <input v-model="newNode.ssh_password" type="password" placeholder="••••••••" class="xray-input">
              </div>

              <div class="row-flex-gap">
                <div style="flex:1;">
                  <label class="form-label">远程 CDP 端口</label>
                  <input v-model="newNode.remote_cdp_port" type="number" placeholder="9222" class="xray-input" style="font-family:monospace;">
                </div>
                <div style="flex:1;">
                  <label class="form-label">本地穿透绑定端口</label>
                  <input v-model="newNode.local_bind_port" type="number" required placeholder="19222" class="xray-input font-cyan-mono">
                </div>
              </div>
            </div>

            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:16px;">
              <button type="button" @click="showNodeModal = false" class="btn-set-source" style="padding:6px 14px;">取消</button>
              <button type="submit" class="btn-primary-gradient">保存节点</button>
            </div>
          </form>
        </div>
      </div>

    </div>
  </div>
</template>

<style scoped>
/* ==================== 1:1 像素级复现截图的纯正原生 CSS ==================== */

.xray-viewport {
  min-height: 100vh;
  width: 100%;
  background-color: #060b17;
  color: #f8fafc;
}

/* 1. 登录界面：绝对垂直水平死锁居中 */
.login-wrapper-center {
  min-height: 100vh;
  width: 100vw;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  background-color: #060b17;
  padding: 20px;
}

.login-card-navy {
  width: 420px;
  max-width: 95vw;
  background-color: #0b132b;
  border: 1px solid #172554;
  border-radius: 14px;
  padding: 32px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
}

.login-brand-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 16px;
  margin-bottom: 24px;
  border-bottom: 1px solid #172554;
}

.bolt-symbol { color: #f59e0b; font-size: 19px; font-weight: bold; }
.brand-xray  { font-weight: 800; font-size: 16px; color: #ffffff; letter-spacing: 1px; }
.brand-reality { font-weight: 800; font-size: 16px; color: #00f0ff; letter-spacing: 1px; }

.login-form-stack { display: flex; flex-direction: column; gap: 16px; }
.form-row { display: flex; flex-direction: column; gap: 6px; }
.form-label { font-size: 12px; color: #94a3b8; }

.xray-input {
  width: 100%;
  background-color: #0f1c3f;
  border: 1px solid #1e3a8a;
  color: #ffffff;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  outline: none;
  transition: all 0.2s;
}
.xray-input:focus {
  border-color: #00f0ff;
  box-shadow: 0 0 8px rgba(0, 240, 255, 0.35);
}

.captcha-row { display: flex; gap: 10px; align-items: center; }
.captcha-box {
  width: 120px;
  height: 38px;
  background: #09122a;
  border: 1px solid #172554;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  overflow: hidden;
  flex-shrink: 0;
}

.btn-primary-gradient {
  background: linear-gradient(135deg, #0284c7, #2563eb);
  color: #ffffff;
  border: none;
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: bold;
  cursor: pointer;
  transition: opacity 0.2s, transform 0.15s;
}
.btn-primary-gradient:hover { opacity: 0.9; transform: translateY(-1px); }

/* 2. 顶栏 (截图同款) */
.dashboard-layout {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.header-bar {
  height: 60px;
  padding: 0 32px;
  background-color: #060b17;
  border-bottom: 1px solid #111c38;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-left { display: flex; align-items: center; gap: 8px; }
.header-right { display: flex; align-items: center; gap: 12px; }

.badge-admin {
  background-color: #dc2626;
  color: #ffffff;
  font-size: 11px;
  font-weight: bold;
  padding: 2px 8px;
  border-radius: 4px;
  letter-spacing: 0.5px;
}

.username-label { font-size: 13px; font-weight: 600; color: #ffffff; }

.btn-logout {
  background: transparent;
  border: 1px solid #4b5563;
  color: #d1d5db;
  padding: 2px 10px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}
.btn-logout:hover { border-color: #9ca3af; color: #ffffff; }

/* 3. 主工作区与顶置 4 个大卡片 (强制 4 列横排平铺) */
.main-container {
  width: 100%;
  max-width: 1560px;
  margin: 0 auto;
  padding: 20px 32px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.cards-grid-4 {
  display: grid !important;
  grid-template-columns: repeat(4, 1fr) !important;
  gap: 16px !important;
  width: 100%;
}

@media (max-width: 1150px) {
  .cards-grid-4 { grid-template-columns: repeat(2, 1fr) !important; }
}
@media (max-width: 680px) {
  .cards-grid-4 { grid-template-columns: 1fr !important; }
}

.kpi-card {
  background-color: #0b132b;
  border: 1px solid #172554;
  border-radius: 12px;
  padding: 16px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  transition: all 0.2s ease;
}

.kpi-card:hover {
  background-color: #0d1736;
  border-color: #1e3a8a;
  transform: translateY(-2px);
}

.kpi-card-active {
  border-color: #00f0ff !important;
  box-shadow: 0 0 14px rgba(0, 240, 255, 0.35) !important;
}

.kpi-left { display: flex; align-items: center; gap: 14px; }
.icon-avatar {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
}

.avatar-purple { background: rgba(88, 28, 135, 0.4); border: 1px solid #7e22ce; }
.avatar-cyan   { background: rgba(14, 59, 94, 0.4); border: 1px solid #0284c7; }
.avatar-pink   { background: rgba(131, 24, 67, 0.4); border: 1px solid #db2777; }
.avatar-indigo { background: rgba(49, 46, 129, 0.4); border: 1px solid #4f46e5; }

.kpi-info { display: flex; flex-direction: column; gap: 3px; }
.kpi-title { font-size: 13px; font-weight: bold; color: #ffffff; }
.kpi-desc  { font-size: 11px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }

.pill-badge {
  background-color: #0f1f42;
  border: 1px solid #1d4ed8;
  color: #38bdf8;
  border-radius: 9999px;
  padding: 3px 12px;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

/* 4. 主内容大容器与治理列表 (1:1 截图结构) */
.content-card {
  background-color: #0b132b;
  border: 1px solid #172554;
  border-radius: 14px;
  padding: 20px;
}

.table-header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 16px;
  border-bottom: 1px solid #172554;
  margin-bottom: 16px;
}

.table-title { display: flex; align-items: center; gap: 8px; }
.icon-duo-users { font-size: 18px; color: #a855f7; }
.table-title h2 { font-size: 15px; font-weight: bold; color: #ffffff; }

.table-responsive { width: 100%; overflow-x: auto; }
.xray-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.xray-table th {
  color: #64748b;
  font-weight: 500;
  padding: 12px 14px;
  border-bottom: 1px solid #172554;
  text-align: left;
}

.xray-table td {
  padding: 14px;
  border-bottom: 1px solid #131e3d;
  vertical-align: middle;
}

.cell-main-name { font-weight: bold; color: #ffffff; font-size: 13px; }
.cell-sub-desc  { font-size: 11px; color: #64748b; font-family: monospace; margin-top: 3px; }

/* 截图同款绿色胶囊: ● 活跃 */
.status-active {
  background-color: rgba(6, 78, 59, 0.85);
  border: 1px solid #059669;
  color: #34d399;
  border-radius: 9999px;
  padding: 2px 10px;
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.status-standby {
  background-color: rgba(69, 26, 3, 0.8);
  border: 1px solid #d97706;
  color: #fbbf24;
  border-radius: 9999px;
  padding: 2px 10px;
  font-size: 11px;
}
.status-error {
  background-color: rgba(69, 10, 10, 0.8);
  border: 1px solid #dc2626;
  color: #f87171;
  border-radius: 9999px;
  padding: 2px 10px;
  font-size: 11px;
}

.font-cyan-mono { color: #00f0ff; font-family: monospace; font-weight: bold; }

.cookie-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background-color: #0f1f42;
  border: 1px solid #1d4ed8;
  padding: 2px 8px;
  border-radius: 4px;
  color: #fcd34d;
  font-weight: bold;
}
.link-probe { background: none; border: none; color: #38bdf8; cursor: pointer; text-decoration: underline; font-size: 10px; margin-left: 4px; }

/* 截图同款普通固定蓝胶囊 */
.tag-plan-blue { background-color: #1e40af; color: #93c5fd; border-radius: 4px; padding: 2px 8px; font-size: 11px; }
.tag-plan-indigo { background-color: #312e81; color: #c7d2fe; border-radius: 4px; padding: 2px 8px; font-size: 11px; }

/* 截图同款专属凭证二维码蓝按钮 */
.btn-qrcode {
  background-color: #0284c7;
  color: #ffffff;
  border: none;
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: bold;
}
.btn-set-source {
  background-color: #1e293b;
  color: #94a3b8;
  border: 1px solid #334155;
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
}

/* 截图同款横排微型彩色治理按钮组 */
.btn-group-row { display: flex; gap: 6px; justify-content: flex-end; }
.btn-micro { border: none; border-radius: 4px; padding: 4px 8px; font-size: 11px; font-weight: bold; color: #ffffff; cursor: pointer; }
.btn-orange { background-color: #d97706; }
.btn-purple { background-color: #7c3aed; }
.btn-red    { background-color: #dc2626; }
.btn-trash  { background-color: #991b1b; }

/* 双列对称 */
.grid-2col {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 20px;
}
@media (max-width: 900px) {
  .grid-2col { grid-template-columns: 1fr; }
}

.card-inner-h3 { font-size: 14px; font-weight: bold; color: #fff; }
.row-flex-gap { display: flex; gap: 12px; }

.info-banner-blue {
  background: #09122a;
  border: 1px solid #172554;
  border-radius: 8px;
  padding: 14px;
  font-size: 12px;
  color: #cbd5e1;
  line-height: 1.8;
}

.console-box {
  background: #060b17;
  border: 1px solid #172554;
  border-radius: 8px;
  padding: 14px;
  font-family: monospace;
  font-size: 12px;
  height: 320px;
  overflow-y: auto;
}
.console-item { border-bottom: 1px solid #111c38; padding-bottom: 8px; margin-bottom: 8px; }
.console-meta { display: flex; justify-content: space-between; font-size: 11px; color: #64748b; }
.console-pre  { margin-top: 4px; color: #e2e8f0; white-space: pre-wrap; }

.keys-list { list-style: none; padding: 0; margin: 0; }
.key-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #172554; font-size: 12px; }

/* 弹窗遮罩与卡片 */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 9999;
}
.modal-card {
  width: 520px;
  max-width: 95vw;
  background-color: #0b132b;
  border: 1px solid #1e3a8a;
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.8);
}
.modal-title-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 12px;
  border-bottom: 1px solid #172554;
}

.radio-pill-card {
  flex: 1;
  padding: 10px;
  border-radius: 6px;
  border: 1px solid #172554;
  text-align: center;
  cursor: pointer;
  font-size: 12px;
  color: #94a3b8;
}
.radio-pill-active {
  border-color: #00f0ff !important;
  background: #0f1f42 !important;
  color: #38bdf8 !important;
}
</style>