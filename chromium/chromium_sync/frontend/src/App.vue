<script setup>
import { ref, reactive, computed, onMounted } from 'vue'

const token = ref(localStorage.getItem('token') || '')
// 对应顶部的 4 个大卡片分类
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

// 新增节点数据模型（支持本地免SSH直连）
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
const localCount = computed(() => nodes.value.filter(n => n.is_local === 1).length)
const remoteCount = computed(() => nodes.value.filter(n => !n.is_local).length)
const onlineCount = computed(() => nodes.value.filter(n => n.status === 'connected').length)
const sourceNode = computed(() => nodes.value.find(n => n.is_source === 1))

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
  if (res.ok) alert('通知设置已持久化保存')
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
    alert('管理员配置已更新')
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
  <div class="min-h-screen flex flex-col bg-[#060b17] text-slate-100">
    <!-- 1. 登录面板 (70% 黄金输入比例) -->
    <div v-if="!token" class="flex-1 flex items-center justify-center p-6">
      <div class="xray-main-container p-8 w-full max-w-md bg-[#0b132b] border border-[#172554] shadow-2xl">
        <div class="flex items-center gap-2 mb-6 pb-3 border-b border-[#172554]">
          <span class="text-amber-500 text-lg">⚡</span>
          <span class="font-black tracking-wider text-white text-base font-sans">CDP</span>
          <span class="font-black tracking-wider text-cyan-400 text-base font-sans">CLUSTER</span>
        </div>

        <form @submit.prevent="login" class="flex flex-col items-center space-y-4">
          <div class="w-full flex flex-col items-center">
            <label class="text-xs text-slate-400 mb-1 w-full text-left pl-[15%]">用户名 或 邮箱</label>
            <input v-model="loginForm.account" required placeholder="admin 或 admin@wimotek.com" class="form-input-golden">
          </div>

          <div class="w-full flex flex-col items-center">
            <label class="text-xs text-slate-400 mb-1 w-full text-left pl-[15%]">访问密码</label>
            <input type="password" v-model="loginForm.password" required placeholder="••••••••••••" class="form-input-golden">
          </div>

          <div class="w-full flex flex-col items-center">
            <label class="text-xs text-slate-400 mb-1 w-full text-left pl-[15%]">人机安全验证</label>
            <div class="form-input-golden flex items-center gap-2 p-1.5 border border-[#1e3a8a] bg-[#0f1c3f]">
              <input v-model="loginForm.captcha_answer" required placeholder="答案" class="w-1/2 px-2.5 py-1 bg-[#09122a] border border-[#172554] rounded text-slate-100 text-sm outline-none">
              <div @click="refreshCaptcha" class="w-1/2 flex justify-center cursor-pointer bg-[#09122a] rounded p-0.5 border border-[#172554]" title="点击刷新验证码">
                <div v-html="captchaSvg"></div>
              </div>
            </div>
          </div>

          <button type="submit" class="form-input-golden btn-refresh-gradient justify-center mt-2 py-2.5">
            登 录 面 板
          </button>
        </form>
      </div>
    </div>

    <!-- 2. 主控制台 (截图同款：顶栏 + 4 个顶置大卡片 + 全宽自适应治理列表) -->
    <div v-else class="flex-1 flex flex-col w-full">
      
      <!-- 顶栏 (1:1 截图复刻：⚡ 标题 + 鲜红 SYSTEM ADMIN + 用户名 + 线框退出) -->
      <header class="h-16 px-6 lg:px-10 border-b border-[#111c38] bg-[#060b17] flex items-center justify-between sticky top-0 z-40">
        <div class="flex items-center space-x-2">
          <span class="text-amber-500 text-xl font-bold">⚡</span>
          <span class="font-extrabold tracking-wider text-white text-lg font-sans">CDP</span>
          <span class="font-extrabold tracking-wider text-cyan-400 text-lg font-sans">CLUSTER</span>
        </div>

        <div class="flex items-center gap-3">
          <span class="px-2 py-0.5 rounded text-[11px] font-bold bg-[#dc2626] text-white tracking-wide">
            SYSTEM ADMIN
          </span>
          <span class="text-sm font-semibold text-slate-200">{{ profile.username }}</span>
          <button @click="logout" class="px-2.5 py-0.5 rounded text-xs border border-slate-600 text-slate-300 hover:text-white hover:border-slate-400 transition">
            退出
          </button>
        </div>
      </header>

      <!-- 全屏自适应容器 -->
      <div class="flex-1 p-6 lg:p-8 max-w-[1920px] w-full mx-auto space-y-6">
        
        <!-- ==================== 顶部 4 个大卡片导航栅格 (1:1 截图复刻) ==================== -->
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          
          <!-- 卡片 1: 节点集群治理 (带激活态电光蓝边框与微光晕) -->
          <div 
            @click="activeNav = 'nodes'"
            :class="activeNav === 'nodes' ? 'xray-nav-card-active' : ''"
            class="xray-nav-card flex items-center justify-between"
          >
            <div class="flex items-center gap-3.5">
              <!-- 紫色节点图标 -->
              <div class="w-10 h-10 rounded-lg bg-[#581c87]/30 border border-[#7e22ce]/40 flex items-center justify-center text-xl text-purple-400">
                👥
              </div>
              <div>
                <h3 class="text-sm font-bold text-white tracking-tight">CDP 节点 (Chromium) 集群</h3>
                <p class="text-[11px] text-slate-400 mt-0.5">本地免SSH/远程节点监管、在线状态、配置修改与接入</p>
              </div>
            </div>
            <div class="xray-badge-pill shrink-0 ml-2">
              {{ nodes.length }} 个节点
            </div>
          </div>

          <!-- 卡片 2: Cookie 同步调度中枢 -->
          <div 
            @click="activeNav = 'sync'"
            :class="activeNav === 'sync' ? 'xray-nav-card-active' : ''"
            class="xray-nav-card flex items-center justify-between"
          >
            <div class="flex items-center gap-3.5">
              <!-- 青色地球图标 -->
              <div class="w-10 h-10 rounded-lg bg-[#0e3b5e]/40 border border-[#0284c7]/40 flex items-center justify-center text-xl text-cyan-400">
                🌐
              </div>
              <div>
                <h3 class="text-sm font-bold text-white tracking-tight">全站 Cookie 同步与调度</h3>
                <p class="text-[11px] text-slate-400 mt-0.5">15分钟定时调度、源节点指定、双向智能注入与探针</p>
              </div>
            </div>
            <div class="xray-badge-pill shrink-0 ml-2">
              {{ totalCookies }} 条资产
            </div>
          </div>

          <!-- 卡片 3: 告警通知中心 -->
          <div 
            @click="activeNav = 'notifications'"
            :class="activeNav === 'notifications' ? 'xray-nav-card-active' : ''"
            class="xray-nav-card flex items-center justify-between"
          >
            <div class="flex items-center gap-3.5">
              <!-- 粉红票券图标 -->
              <div class="w-10 h-10 rounded-lg bg-[#831843]/30 border border-[#db2777]/40 flex items-center justify-center text-xl text-pink-400">
                🎫
              </div>
              <div>
                <h3 class="text-sm font-bold text-white tracking-tight">通知预警与发信中心</h3>
                <p class="text-[11px] text-slate-400 mt-0.5">SMTP 发信设置、Server酱微信实时推送、故障秒级告警</p>
              </div>
            </div>
            <div class="xray-badge-pill shrink-0 ml-2">
              {{ notif.serverchan_enabled ? '微信已启' : '邮件待发' }}
            </div>
          </div>

          <!-- 卡片 4: 系统运维与安全设置 -->
          <div 
            @click="activeNav = 'settings'"
            :class="activeNav === 'settings' ? 'xray-nav-card-active' : ''"
            class="xray-nav-card flex items-center justify-between"
          >
            <div class="flex items-center gap-3.5">
              <!-- 齿轮配置图标 -->
              <div class="w-10 h-10 rounded-lg bg-[#312e81]/30 border border-[#4f46e5]/40 flex items-center justify-center text-xl text-indigo-400">
                ⚙️
              </div>
              <div>
                <h3 class="text-sm font-bold text-white tracking-tight">系统运维与凭据管理</h3>
                <p class="text-[11px] text-slate-400 mt-0.5">SSH 密钥金库、管理员邮箱、HTTPS 自签证书与密码重置</p>
              </div>
            </div>
            <div class="xray-badge-pill shrink-0 ml-2">
              配置中心
            </div>
          </div>

        </div>

        <!-- ==================== 主工作区卡片 (1:1 截图表格与操作排版) ==================== -->
        
        <!-- 模块 1: 节点集群接入与治理列表 -->
        <div v-if="activeNav === 'nodes'" class="xray-main-container p-6 w-full">
          <!-- 标题栏与右上角操作按钮 -->
          <div class="flex justify-between items-center mb-5 pb-3 border-b border-[#172554]">
            <div class="flex items-center gap-2">
              <span class="text-purple-400 text-base">👥</span>
              <h2 class="text-sm font-bold text-white tracking-wide">CDP 节点实例治理列表</h2>
            </div>
            <div class="flex items-center gap-3">
              <button @click="showNodeModal = true" class="btn-refresh-gradient">
                + 新增接入节点
              </button>
              <button @click="loadAll" class="btn-refresh-gradient">
                🔄 刷新数据
              </button>
            </div>
          </div>

          <!-- 紧凑治理表格 (1:1 截图复刻字段与胶囊按钮排布) -->
          <div class="overflow-x-auto w-full">
            <table class="w-full text-left text-xs">
              <thead class="text-slate-400 border-b border-[#172554] pb-2">
                <tr>
                  <th class="p-3">节点 / 接入地址</th>
                  <th class="p-3">节点角色</th>
                  <th class="p-3">状态</th>
                  <th class="p-3">节点类型</th>
                  <th class="p-3">本地转发端口</th>
                  <th class="p-3">Cookie 实时存量</th>
                  <th class="p-3">到期/更新时间</th>
                  <th class="p-3 text-right pr-4">治理操作</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[#172554]">
                <tr v-for="node in nodes" :key="node.id" class="hover:bg-[#0e1a3d]/50 transition">
                  <!-- 用户 / 绑定邮箱 风格 -> 节点名 / 地址 -->
                  <td class="p-3">
                    <div class="font-bold text-white text-sm">{{ node.name }}</div>
                    <div class="text-slate-400 text-[11px] font-mono mt-0.5">
                      {{ node.is_local ? '127.0.0.1 (本机回环)' : `${node.ssh_user}@${node.ssh_host}:${node.ssh_port}` }}
                    </div>
                  </td>

                  <!-- 角色 (专属凭证风格蓝按钮) -->
                  <td class="p-3">
                    <span v-if="node.is_source" class="btn-gov-blue">
                      ★ 默认同步源
                    </span>
                    <button v-else @click="setSource(node.id)" class="text-slate-400 hover:text-cyan-400 text-[11px]">
                      设为源
                    </button>
                  </td>

                  <!-- 状态 (截图同款绿色深底胶囊: ● 活跃) -->
                  <td class="p-3">
                    <span v-if="node.status === 'connected'" class="badge-active">
                      ● 活跃
                    </span>
                    <span v-else-if="node.status === 'stopped'" class="badge-standby">
                      ○ 离线
                    </span>
                    <span v-else class="badge-error">
                      ✕ 异常
                    </span>
                  </td>

                  <!-- 套餐特性风格 -> 节点类型 -->
                  <td class="p-3">
                    <span v-if="node.is_local" class="px-2 py-0.5 rounded text-[10px] font-medium bg-[#1e3a8a] text-blue-200">
                      普通固定 (本地)
                    </span>
                    <span v-else class="px-2 py-0.5 rounded text-[10px] font-medium bg-[#312e81] text-indigo-200">
                      SSH 穿透 (远程)
                    </span>
                  </td>

                  <!-- 本地端口 (Monospace) -->
                  <td class="p-3 font-mono text-cyan-400 font-bold">
                    127.0.0.1:{{ node.local_bind_port }}
                  </td>

                  <!-- Cookie 存量 -->
                  <td class="p-3">
                    <div class="inline-flex items-center gap-1.5 bg-[#0f1f42] border border-[#1d4ed8] px-2 py-0.5 rounded">
                      <span class="text-amber-400">🍪</span>
                      <span class="font-bold text-amber-300 font-mono">{{ node.cookie_count || 0 }} 条</span>
                      <button @click="probeNode(node)" class="text-[10px] text-cyan-400 hover:underline ml-1" title="主动触发 CDP 探针更新">
                        刷新
                      </button>
                    </div>
                  </td>

                  <!-- 到期时间风格 -> 最近同步时间 -->
                  <td class="p-3 text-slate-400 text-[11px] font-mono">
                    {{ node.last_sync || '∞ 暂无记录' }}
                  </td>

                  <!-- 治理操作 (1:1 截图复刻：橙色密码、红色重置、紫色配额、灰色封禁、红色删除) -->
                  <td class="p-3 text-right space-x-1.5 pr-2">
                    <!-- 橙色按钮: 启动/穿透 -->
                    <button @click="toggleTunnel(node)" class="btn-gov-orange">
                      🔑 {{ node.is_local ? '测试连通' : (node.status === 'connected' ? '断开隧道' : '启动穿透') }}
                    </button>
                    <!-- 紫色按钮: 探针嗅探 -->
                    <button @click="probeNode(node)" class="btn-gov-purple">
                      ✏️ 探针
                    </button>
                    <!-- 战损红按钮: 删除 -->
                    <button @click="deleteNode(node.id)" class="btn-gov-red">
                      🗑️
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 模块 2: 同步调度中枢 -->
        <div v-if="activeNav === 'sync'" class="xray-main-container p-6 w-full space-y-4">
          <div class="flex justify-between items-center pb-3 border-b border-[#172554]">
            <div class="flex items-center gap-2">
              <span class="text-cyan-400 text-base">🌐</span>
              <h2 class="text-sm font-bold text-white tracking-wide">全站 Cookie 自动同步与分发治理</h2>
            </div>
            <button @click="triggerSync" :disabled="isSyncing" class="btn-refresh-gradient">
              {{ isSyncing ? '同步任务执行中...' : '⚡ 立即触发全网同步' }}
            </button>
          </div>

          <div class="p-4 bg-[#09122a] border border-[#172554] rounded-lg text-xs space-y-2 text-slate-300">
            <p>• 调度周期：系统常驻调度程序每 <span class="text-cyan-400 font-bold">15 分钟</span> 自动从默认源节点抓取最新全量 Cookies 并分发到各个活跃节点。</p>
            <p>• 本地节点加速：本地直连节点跳过 SSH 隧道转发环节，直达端口注入，吞吐耗时降低 90%。</p>
          </div>

          <!-- 同步审计日志列表 -->
          <div class="mt-4">
            <h3 class="text-xs font-bold text-slate-300 mb-2">最近同步追踪事件：</h3>
            <div class="bg-[#060b17] p-3.5 rounded border border-[#172554] font-mono text-xs h-80 overflow-y-auto space-y-2.5">
              <div v-for="l in logs" :key="l.id" class="border-b border-[#111c38] pb-1.5">
                <div class="flex justify-between text-[11px] text-slate-400">
                  <span>[{{ l.timestamp }}]</span>
                  <span :class="l.status==='SUCCESS' ? 'text-emerald-400' : 'text-rose-400'" class="font-bold">[{{ l.status }}]</span>
                </div>
                <pre class="mt-1 text-slate-300 whitespace-pre-wrap">{{ l.details }}</pre>
              </div>
              <div v-if="logs.length === 0" class="text-center text-slate-500 py-12">暂无调度事件</div>
            </div>
          </div>
        </div>

        <!-- 模块 3: 告警通知与发信中心 -->
        <div v-if="activeNav === 'notifications'" class="grid grid-cols-1 lg:grid-cols-2 gap-6 w-full">
          <!-- SMTP 邮件 -->
          <div class="xray-main-container p-6 flex flex-col justify-between">
            <div>
              <div class="flex justify-between items-center mb-4 pb-2 border-b border-[#172554]">
                <h3 class="text-sm font-bold text-white flex items-center gap-2">
                  <span class="text-pink-400">📧</span> SMTP 邮件发信通道
                </h3>
                <button @click="testEmail" class="text-xs text-cyan-400 hover:underline">发送测试邮件</button>
              </div>
              <div class="space-y-3">
                <div>
                  <label class="block text-xs text-slate-400 mb-1">SMTP 发信服务器</label>
                  <input v-model="notif.smtp_host" placeholder="smtp.qq.com" class="dialog-input">
                </div>
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-xs text-slate-400 mb-1">端口</label>
                    <input v-model="notif.smtp_port" placeholder="465" class="dialog-input">
                  </div>
                  <div>
                    <label class="block text-xs text-slate-400 mb-1">加密协议</label>
                    <select v-model="notif.smtp_ssl" class="dialog-input">
                      <option :value="true">SSL / TLS</option>
                      <option :value="false">STARTTLS / 明文</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">发信账号</label>
                  <input v-model="notif.smtp_user" placeholder="user@qq.com" class="dialog-input">
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">发信授权码 / 密码</label>
                  <input v-model="notif.smtp_pass" type="password" placeholder="授权码" class="dialog-input">
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">接收预警邮箱</label>
                  <input v-model="notif.smtp_to" placeholder="admin@domain.com" class="dialog-input">
                </div>
              </div>
            </div>
            <button @click="saveNotif" class="btn-refresh-gradient justify-center mt-5 w-full">保存邮件配置</button>
          </div>

          <!-- Server酱微信推送 -->
          <div class="xray-main-container p-6 flex flex-col justify-between">
            <div>
              <div class="flex justify-between items-center mb-4 pb-2 border-b border-[#172554]">
                <h3 class="text-sm font-bold text-white flex items-center gap-2">
                  <span class="text-pink-400">📱</span> Server酱 (微信推送)
                </h3>
                <button @click="testServerChan" class="text-xs text-cyan-400 hover:underline">发送微信测试</button>
              </div>
              <div class="space-y-4">
                <div class="flex items-center gap-2">
                  <input type="checkbox" v-model="notif.serverchan_enabled" id="s_c_box" class="rounded bg-[#0f1c3f] border-[#1e3a8a] text-cyan-500">
                  <label for="s_c_box" class="text-xs text-slate-200">启用微信实时推送</label>
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">Server酱 SendKey</label>
                  <input v-model="notif.serverchan_key" placeholder="SCTxxxxxxxxxxxxxxxx" class="dialog-input font-mono">
                  <p class="text-[11px] text-slate-400 mt-1.5">在 sct.ftqq.com 申请的 SendKey。同步失败或节点下线时自动推送到微信。</p>
                </div>
              </div>
            </div>
            <button @click="saveNotif" class="btn-refresh-gradient justify-center mt-5 w-full">保存微信配置</button>
          </div>
        </div>

        <!-- 模块 4: 系统运维与安全配置 (包括 SSH 证书管理与管理员修改) -->
        <div v-if="activeNav === 'settings'" class="grid grid-cols-1 lg:grid-cols-2 gap-6 w-full">
          <!-- 管理员安全配置 (严格 70% 黄金输入比例) -->
          <div class="xray-main-container p-6 flex flex-col justify-between">
            <div>
              <h3 class="text-sm font-bold text-white mb-4 pb-2 border-b border-[#172554] flex items-center gap-2">
                <span class="text-indigo-400">👤</span> 管理员账号与登录凭证
              </h3>
              <form @submit.prevent="saveProfile" class="flex flex-col items-center space-y-4 pt-1">
                <div class="w-full flex flex-col items-center">
                  <label class="text-xs text-slate-400 mb-1 w-full text-left pl-[15%]">登录用户名</label>
                  <input v-model="profile.username" required class="form-input-golden">
                </div>
                <div class="w-full flex flex-col items-center">
                  <label class="text-xs text-slate-400 mb-1 w-full text-left pl-[15%]">绑定邮箱 (支持直接登录)</label>
                  <input v-model="profile.email" type="email" required class="form-input-golden">
                </div>
                <div class="w-full flex flex-col items-center">
                  <label class="text-xs text-slate-400 mb-1 w-full text-left pl-[15%]">重置新密码 (留空则不改)</label>
                  <input v-model="profile.new_password" type="password" placeholder="至少 6 位安全字符" minlength="6" class="form-input-golden">
                </div>
                <button type="submit" class="form-input-golden btn-refresh-gradient justify-center mt-2">保存账号设置</button>
              </form>
            </div>
          </div>

          <!-- SSH 密钥金库 -->
          <div class="xray-main-container p-6 flex flex-col justify-between">
            <div>
              <div class="flex justify-between items-center mb-4 pb-2 border-b border-[#172554]">
                <h3 class="text-sm font-bold text-white flex items-center gap-2">
                  <span class="text-indigo-400">🔑</span> SSH 密钥金库
                </h3>
                <span class="text-xs text-slate-400 font-mono">{{ keys.length }} 个凭据</span>
              </div>
              <div class="mb-4">
                <input type="file" @change="uploadKey" class="text-xs text-slate-400 file:mr-3 file:py-1.5 file:px-3 file:rounded file:bg-[#0f1c3f] file:border file:border-[#1e3a8a] file:text-cyan-300 hover:file:bg-[#1e3a8a] cursor-pointer">
              </div>
              <ul class="divide-y divide-[#172554] text-xs">
                <li v-for="k in keys" :key="k.filename" class="py-2.5 flex justify-between items-center">
                  <span class="font-mono text-slate-300">🔑 {{ k.filename }} ({{ k.size }} Bytes)</span>
                  <button @click="deleteKey(k.filename)" class="text-red-400 hover:underline">销毁</button>
                </li>
                <li v-if="keys.length === 0" class="py-6 text-center text-slate-500">暂无证书凭证</li>
              </ul>
            </div>
            <div class="mt-4 pt-3 border-t border-[#172554] text-[11px] text-slate-500 font-mono">
              [STORAGE: /data/keys/ | AUTO PERMISSION: 0600]
            </div>
          </div>
        </div>

      </div>

      <!-- 新增节点 Dialog (支持本地免SSH直连) -->
      <div v-if="showNodeModal" class="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
        <div class="xray-main-container p-6 w-full max-w-lg bg-[#0b132b] border border-[#1e3a8a] shadow-2xl">
          <div class="flex justify-between items-center pb-3 border-b border-[#172554] mb-4">
            <h3 class="text-sm font-bold text-white flex items-center gap-2">
              <span class="text-cyan-400">⚡</span> 接入新 CDP 实例节点
            </h3>
            <button @click="showNodeModal = false" class="text-slate-400 hover:text-white">✕</button>
          </div>

          <form @submit.prevent="createNode" class="space-y-4">
            <!-- 节点类型切换 -->
            <div>
              <label class="block text-xs text-slate-400 mb-2">接入类型</label>
              <div class="grid grid-cols-2 gap-3">
                <label 
                  :class="newNode.is_local ? 'border-cyan-400 bg-[#0f1f42] text-cyan-300' : 'border-[#172554] text-slate-400'"
                  class="flex items-center justify-center gap-2 p-2.5 rounded-lg border cursor-pointer text-xs"
                >
                  <input type="radio" v-model="newNode.is_local" :value="true" class="hidden">
                  <span>💻 本地直连 (免SSH)</span>
                </label>

                <label 
                  :class="!newNode.is_local ? 'border-cyan-400 bg-[#0f1f42] text-cyan-300' : 'border-[#172554] text-slate-400'"
                  class="flex items-center justify-center gap-2 p-2.5 rounded-lg border cursor-pointer text-xs"
                >
                  <input type="radio" v-model="newNode.is_local" :value="false" class="hidden">
                  <span>🌐 远程 SSH 穿透</span>
                </label>
              </div>
            </div>

            <div>
              <label class="block text-xs text-slate-400 mb-1">节点名称</label>
              <input v-model="newNode.name" required placeholder="如: 本机 Chrome 01" class="dialog-input">
            </div>

            <!-- 本地节点输入 -->
            <div v-if="newNode.is_local" class="p-3 bg-[#080f24] rounded-lg border border-[#172554]">
              <label class="block text-xs text-slate-400 mb-1">本地 CDP 调试端口 (默认 9222)</label>
              <input v-model="newNode.local_bind_port" type="number" required placeholder="9222" class="dialog-input font-mono text-cyan-400">
              <p class="text-[11px] text-slate-500 mt-1">
                直接接入本机 Chromium 实例，无需任何 SSH 握手开销。
              </p>
            </div>

            <!-- 远程节点输入 -->
            <div v-else class="space-y-3.5">
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs text-slate-400 mb-1">SSH 主机 / IP</label>
                  <input v-model="newNode.ssh_host" required placeholder="192.168.1.100" class="dialog-input font-mono">
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">SSH 端口</label>
                  <input v-model="newNode.ssh_port" type="number" placeholder="22" class="dialog-input font-mono">
                </div>
              </div>

              <div>
                <label class="block text-xs text-slate-400 mb-1">SSH 用户名</label>
                <input v-model="newNode.ssh_user" required placeholder="root" class="dialog-input font-mono">
              </div>

              <div>
                <label class="block text-xs text-slate-400 mb-1">绑定 SSH 证书 (选填)</label>
                <select v-model="newNode.ssh_key_filename" class="dialog-input font-mono">
                  <option value="">密码认证 (不选择私钥)</option>
                  <option v-for="k in keys" :key="k.filename" :value="k.filename">🔑 {{ k.filename }}</option>
                </select>
              </div>

              <div v-if="!newNode.ssh_key_filename">
                <label class="block text-xs text-slate-400 mb-1">SSH 密码</label>
                <input v-model="newNode.ssh_password" type="password" placeholder="••••••••" class="dialog-input">
              </div>

              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs text-slate-400 mb-1">远程 CDP 端口</label>
                  <input v-model="newNode.remote_cdp_port" type="number" placeholder="9222" class="dialog-input font-mono">
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">本地穿透绑定端口</label>
                  <input v-model="newNode.local_bind_port" type="number" required placeholder="19222" class="dialog-input font-mono text-cyan-400">
                </div>
              </div>
            </div>

            <div class="flex justify-end gap-2.5 pt-3 border-t border-[#172554]">
              <button type="button" @click="showNodeModal = false" class="px-3.5 py-1.5 rounded text-xs bg-[#09122a] border border-[#172554] text-slate-300">取消</button>
              <button type="submit" class="btn-refresh-gradient">保存节点</button>
            </div>
          </form>
        </div>
      </div>

    </div>
  </div>
</template>