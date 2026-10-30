<script setup>
import { ref, reactive, computed, onMounted } from 'vue'

const token = ref(localStorage.getItem('token') || '')
const currentTab = ref('nodes') // 'nodes' | 'sync' | 'notifications' | 'keys' | 'settings' | 'logs'
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
  is_local: true, // 默认开启本地直连
  ssh_host: '',
  ssh_port: 22,
  ssh_user: 'root',
  ssh_key_filename: '',
  ssh_password: '',
  remote_cdp_port: 9222,
  local_bind_port: 9222
})

// 统计大卡片指标
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
  if (confirm('确认销毁该节点？')) {
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
  if (res.ok) alert('通知设置已持久化')
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
    alert('账号设置已更新')
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
  <div class="min-h-screen flex flex-col bg-[#080c14] text-slate-100">
    <!-- 1. 登录面板 (严格 70% 黄金输入框比例) -->
    <div v-if="!token" class="flex-1 flex items-center justify-center p-6">
      <div class="dash-card p-8 w-full max-w-md bg-[#0f172a] border border-slate-800">
        <div class="flex items-center gap-3 mb-6 pb-3 border-b border-slate-800">
          <div class="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center font-bold text-white text-base">
            C
          </div>
          <div>
            <h1 class="text-base font-bold text-white tracking-wide">CDP CLUSTER HUB</h1>
            <p class="text-xs text-slate-400">Cookie 集群控制面板</p>
          </div>
        </div>

        <form @submit.prevent="login" class="flex flex-col items-center space-y-4">
          <div class="w-full flex flex-col items-center">
            <label class="text-xs text-slate-400 mb-1 w-full text-left pl-[15%]">用户名 或 邮箱</label>
            <input v-model="loginForm.account" required placeholder="admin 或 admin@wimotek.com" class="form-input-golden">
          </div>

          <div class="w-full flex flex-col items-center">
            <label class="text-xs text-slate-400 mb-1 w-full text-left pl-[15%]">登录密码</label>
            <input type="password" v-model="loginForm.password" required placeholder="••••••••••••" class="form-input-golden">
          </div>

          <div class="w-full flex flex-col items-center">
            <label class="text-xs text-slate-400 mb-1 w-full text-left pl-[15%]">人机安全验证</label>
            <div class="form-input-golden flex items-center gap-2 p-1.5 border border-slate-700 bg-slate-800">
              <input v-model="loginForm.captcha_answer" required placeholder="答案" class="w-1/2 px-2.5 py-1 bg-slate-900 border border-slate-700 rounded text-slate-100 text-sm outline-none">
              <div @click="refreshCaptcha" class="w-1/2 flex justify-center cursor-pointer bg-slate-900 rounded p-0.5 border border-slate-800" title="点击刷新验证码">
                <div v-html="captchaSvg"></div>
              </div>
            </div>
          </div>

          <button type="submit" class="form-input-golden btn-primary mt-2">
            登 入
          </button>
        </form>
      </div>
    </div>

    <!-- 2. 主控制台 (顶部导航大卡片 + 全屏自适应工作区) -->
    <div v-else class="flex-1 flex flex-col w-full">
      <!-- 极简通顶导航栏 -->
      <header class="h-16 px-6 lg:px-10 border-b border-slate-800/80 bg-[#0c1222] flex items-center justify-between sticky top-0 z-30">
        <div class="flex items-center space-x-3">
          <div class="w-7 h-7 rounded bg-blue-600 flex items-center justify-center font-bold text-white text-sm">
            CDP
          </div>
          <span class="font-bold text-base tracking-tight text-white">Chromium Cluster Panel</span>
          <span class="text-[11px] px-2 py-0.5 rounded bg-blue-950 text-blue-400 border border-blue-800/50">v3.2</span>
        </div>

        <div class="flex items-center gap-3">
          <button @click="triggerSync" :disabled="isSyncing" class="btn-primary text-xs flex items-center gap-1.5">
            <span>{{ isSyncing ? '同步中...' : '⚡ 立即触发同步' }}</span>
          </button>
          <button @click="logout" class="btn-secondary text-xs">
            退出
          </button>
        </div>
      </header>

      <!-- 全屏自适应容器 -->
      <div class="flex-1 p-6 lg:p-8 max-w-[1920px] w-full mx-auto space-y-6">
        
        <!-- ==================== 顶部导航几个大卡片 (状态大数 + 功能切换) ==================== -->
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <!-- 卡片 1: 节点管理 -->
          <div 
            @click="currentTab = 'nodes'"
            :class="currentTab === 'nodes' ? 'nav-kpi-card-active' : ''"
            class="nav-kpi-card flex flex-col justify-between"
          >
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-400 font-medium">CDP 节点集群</span>
              <span class="text-base">🌐</span>
            </div>
            <div class="my-2">
              <span class="text-2xl font-bold font-mono text-white">{{ nodes.length }}</span>
              <span class="text-xs text-slate-500 ml-1">台</span>
            </div>
            <div class="text-[11px] text-slate-400 truncate">
              本地: <span class="text-blue-400">{{ localCount }}</span> | 远程: <span class="text-emerald-400">{{ remoteCount }}</span>
            </div>
          </div>

          <!-- 卡片 2: Cookie 同步资产池 -->
          <div 
            @click="currentTab = 'sync'"
            :class="currentTab === 'sync' ? 'nav-kpi-card-active' : ''"
            class="nav-kpi-card flex flex-col justify-between"
          >
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-400 font-medium">Cookie 资产池</span>
              <span class="text-base">🍪</span>
            </div>
            <div class="my-2">
              <span class="text-2xl font-bold font-mono text-amber-400">{{ totalCookies }}</span>
              <span class="text-xs text-slate-500 ml-1">条</span>
            </div>
            <div class="text-[11px] text-slate-400 truncate">
              源: <span class="text-amber-300 font-medium">{{ sourceNode ? sourceNode.name : '未指定' }}</span>
            </div>
          </div>

          <!-- 卡片 3: 告警通知设置 -->
          <div 
            @click="currentTab = 'notifications'"
            :class="currentTab === 'notifications' ? 'nav-kpi-card-active' : ''"
            class="nav-kpi-card flex flex-col justify-between"
          >
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-400 font-medium">多通道告警</span>
              <span class="text-base">🔔</span>
            </div>
            <div class="my-2">
              <span class="text-lg font-bold text-slate-100">邮件 / 微信</span>
            </div>
            <div class="text-[11px] text-slate-400 truncate">
              微信: <span :class="notif.serverchan_enabled ? 'text-emerald-400' : 'text-slate-500'">{{ notif.serverchan_enabled ? '已开启' : '未开启' }}</span>
            </div>
          </div>

          <!-- 卡片 4: 凭证管理 -->
          <div 
            @click="currentTab = 'keys'"
            :class="currentTab === 'keys' ? 'nav-kpi-card-active' : ''"
            class="nav-kpi-card flex flex-col justify-between"
          >
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-400 font-medium">SSH 密钥金库</span>
              <span class="text-base">🔑</span>
            </div>
            <div class="my-2">
              <span class="text-2xl font-bold font-mono text-white">{{ keys.length }}</span>
              <span class="text-xs text-slate-500 ml-1">个</span>
            </div>
            <div class="text-[11px] text-slate-400">
              安全权限: <span class="text-emerald-400 font-mono">0600</span>
            </div>
          </div>

          <!-- 卡片 5: 面板安全 -->
          <div 
            @click="currentTab = 'settings'"
            :class="currentTab === 'settings' ? 'nav-kpi-card-active' : ''"
            class="nav-kpi-card flex flex-col justify-between"
          >
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-400 font-medium">面板与账号</span>
              <span class="text-base">👤</span>
            </div>
            <div class="my-2">
              <span class="text-base font-bold text-slate-200 truncate">{{ profile.username }}</span>
            </div>
            <div class="text-[11px] text-slate-400 truncate">
              {{ profile.email }}
            </div>
          </div>

          <!-- 卡片 6: 实时运行日志 -->
          <div 
            @click="currentTab = 'logs'"
            :class="currentTab === 'logs' ? 'nav-kpi-card-active' : ''"
            class="nav-kpi-card flex flex-col justify-between"
          >
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-400 font-medium">系统运行日志</span>
              <span class="text-base">📜</span>
            </div>
            <div class="my-2">
              <span class="text-2xl font-bold font-mono text-white">{{ logs.length }}</span>
              <span class="text-xs text-slate-500 ml-1">条</span>
            </div>
            <div class="text-[11px] text-slate-400">
              调度周期: <span class="text-blue-400">15 分钟</span>
            </div>
          </div>
        </div>

        <!-- ==================== 主功能自适应切换区域 ==================== -->
        
        <!-- 1. 节点列表视图 -->
        <div v-if="currentTab === 'nodes'" class="dash-card p-6 w-full">
          <div class="flex justify-between items-center mb-5 pb-3 border-b border-slate-800">
            <div>
              <h2 class="text-base font-semibold text-white">CDP 集群实例清单</h2>
              <p class="text-xs text-slate-400 mt-0.5">支持本地直连（免 SSH）与远程 SSH 隧道混部调度</p>
            </div>
            <button @click="showNodeModal = true" class="btn-primary text-xs">
              + 添加节点
            </button>
          </div>

          <div class="overflow-x-auto w-full">
            <table class="w-full text-left text-xs">
              <thead class="text-slate-400 bg-slate-900/60 uppercase border-b border-slate-800">
                <tr>
                  <th class="p-3">角色</th>
                  <th class="p-3">节点类型</th>
                  <th class="p-3">节点名</th>
                  <th class="p-3">连接地址 / 本地端口</th>
                  <th class="p-3">实时 Cookie 统计</th>
                  <th class="p-3">连通状态</th>
                  <th class="p-3">最近更新</th>
                  <th class="p-3 text-right">操作</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-800">
                <tr v-for="node in nodes" :key="node.id" class="hover:bg-slate-800/40">
                  <td class="p-3">
                    <span v-if="node.is_source" class="px-2 py-0.5 rounded text-[11px] font-medium bg-blue-900/60 text-blue-300 border border-blue-700">
                      源节点 (SRC)
                    </span>
                    <button v-else @click="setSource(node.id)" class="text-slate-400 hover:text-blue-400">
                      设为源
                    </button>
                  </td>

                  <td class="p-3">
                    <span v-if="node.is_local" class="px-2 py-0.5 rounded text-[11px] tag-local font-medium">
                      💻 本地直连 (免SSH)
                    </span>
                    <span v-else class="px-2 py-0.5 rounded text-[11px] tag-standby font-medium">
                      🌐 远程 SSH
                    </span>
                  </td>

                  <td class="p-3 font-semibold text-white">{{ node.name }}</td>

                  <td class="p-3 font-mono text-slate-300">
                    <div v-if="node.is_local" class="text-emerald-400 font-bold">
                      127.0.0.1:{{ node.local_bind_port }}
                    </div>
                    <div v-else>
                      <div>{{ node.ssh_user }}@{{ node.ssh_host }}:{{ node.ssh_port }}</div>
                      <div class="text-slate-500 text-[11px]">本地端口: 127.0.0.1:{{ node.local_bind_port }}</div>
                    </div>
                  </td>

                  <td class="p-3">
                    <div class="inline-flex items-center gap-1.5 bg-slate-800/80 px-2 py-1 rounded border border-slate-700">
                      <span class="text-amber-400">🍪</span>
                      <span class="font-bold text-amber-300">{{ node.cookie_count || 0 }} 条</span>
                      <button @click="probeNode(node)" class="text-[11px] text-blue-400 hover:underline ml-1" title="实时探针刷新 Cookie 数量">
                        刷新
                      </button>
                    </div>
                  </td>

                  <td class="p-3">
                    <span v-if="node.status === 'connected'" class="px-2.5 py-0.5 rounded-full text-[11px] font-medium tag-online">
                      ● 在线
                    </span>
                    <span v-else-if="node.status === 'stopped'" class="px-2.5 py-0.5 rounded-full text-[11px] font-medium tag-standby">
                      ○ 离线
                    </span>
                    <span v-else class="px-2.5 py-0.5 rounded-full text-[11px] font-medium tag-error">
                      ✕ 异常
                    </span>
                  </td>

                  <td class="p-3 text-slate-400">{{ node.last_sync || '---' }}</td>

                  <td class="p-3 text-right space-x-2">
                    <button @click="toggleTunnel(node)" class="btn-secondary text-[11px]">
                      {{ node.is_local ? '测试连通' : (node.status === 'connected' ? '断开隧道' : '启动穿透') }}
                    </button>
                    <button @click="deleteNode(node.id)" class="px-2 py-1 bg-red-950/40 text-red-400 border border-red-900 rounded hover:bg-red-900/50 text-[11px]">
                      删除
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 2. 同步调度中枢 -->
        <div v-if="currentTab === 'sync'" class="dash-card p-6 w-full space-y-4">
          <h3 class="text-base font-semibold text-white pb-3 border-b border-slate-800">Cookie 调度矩阵策略</h3>
          <div class="text-sm text-slate-300 space-y-2">
            <p>• 定时执行策略：系统由后台 APScheduler 引擎驱动，<span class="text-blue-400 font-mono font-bold">每 15 分钟</span> 全自动完成一次双向/定向 Cookie 分发。</p>
            <p>• 本地节点提速：本地直连节点跳过网络封包与 SSH 加解密耗时，直接通过内存 CDP WebSocket 完成注入。</p>
            <p>• 容灾机制：支持基于 ChromiumSync 自适应识别，若远程节点异常，任务自动隔离并不影响其他健康节点。</p>
          </div>
          <div class="pt-4 border-t border-slate-800">
            <button @click="triggerSync" :disabled="isSyncing" class="btn-primary">
              {{ isSyncing ? '正在同步调度中...' : '立即手动触发一次全网同步' }}
            </button>
          </div>
        </div>

        <!-- 3. 告警通知设置 (双列对称栅格 Vercel 规范) -->
        <div v-if="currentTab === 'notifications'" class="grid grid-cols-1 lg:grid-cols-2 gap-6 w-full">
          <!-- SMTP 邮件 -->
          <div class="dash-card p-6 flex flex-col justify-between">
            <div>
              <div class="flex justify-between items-center mb-4 pb-2 border-b border-slate-800">
                <h3 class="text-sm font-semibold text-white">📧 SMTP 邮件发信通道</h3>
                <button @click="testEmail" class="text-xs text-blue-400 hover:underline">发送测试</button>
              </div>
              <div class="space-y-3.5">
                <div>
                  <label class="block text-xs text-slate-400 mb-1">SMTP 发信主机</label>
                  <input v-model="notif.smtp_host" placeholder="smtp.qq.com / smtp.163.com" class="w-full modal-input">
                </div>
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-xs text-slate-400 mb-1">端口</label>
                    <input v-model="notif.smtp_port" placeholder="465" class="w-full modal-input">
                  </div>
                  <div>
                    <label class="block text-xs text-slate-400 mb-1">加密协议</label>
                    <select v-model="notif.smtp_ssl" class="w-full modal-input">
                      <option :value="true">SSL / TLS</option>
                      <option :value="false">STARTTLS / 明文</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">发信邮箱账号</label>
                  <input v-model="notif.smtp_user" placeholder="user@domain.com" class="w-full modal-input">
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">发信授权码 / 密码</label>
                  <input v-model="notif.smtp_pass" type="password" placeholder="邮箱专用授权码" class="w-full modal-input">
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">告警接收人邮箱</label>
                  <input v-model="notif.smtp_to" placeholder="admin@domain.com" class="w-full modal-input">
                </div>
              </div>
            </div>
            <button @click="saveNotif" class="mt-5 btn-primary w-full text-xs">保存邮件通知设置</button>
          </div>

          <!-- Server酱微信 -->
          <div class="dash-card p-6 flex flex-col justify-between">
            <div>
              <div class="flex justify-between items-center mb-4 pb-2 border-b border-slate-800">
                <h3 class="text-sm font-semibold text-white">📱 Server酱 (微信推送)</h3>
                <button @click="testServerChan" class="text-xs text-blue-400 hover:underline">发送微信测试</button>
              </div>
              <div class="space-y-4">
                <div class="flex items-center gap-2">
                  <input type="checkbox" v-model="notif.serverchan_enabled" id="s_c_box" class="rounded bg-slate-800 border-slate-700 text-blue-600">
                  <label for="s_c_box" class="text-xs text-slate-300">启用微信实时推送</label>
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">Server酱 SendKey</label>
                  <input v-model="notif.serverchan_key" placeholder="SCTxxxxxxxxxxxxxxxx" class="w-full modal-input font-mono">
                  <p class="text-[11px] text-slate-500 mt-1">在 sct.ftqq.com 申请的 SendKey。同步失败或节点异常时直推微信。</p>
                </div>
              </div>
            </div>
            <button @click="saveNotif" class="mt-5 btn-primary w-full text-xs">保存 Server酱 设置</button>
          </div>
        </div>

        <!-- 4. SSH 凭据金库 -->
        <div v-if="currentTab === 'keys'" class="dash-card p-6 w-full space-y-4">
          <div class="flex justify-between items-center pb-2 border-b border-slate-800">
            <h3 class="text-sm font-semibold text-white">SSH 私钥存储库</h3>
            <span class="text-xs text-slate-400">{{ keys.length }} 个密钥文件已持久化于 /data/keys/</span>
          </div>
          <div>
            <input type="file" @change="uploadKey" class="text-xs text-slate-400 file:mr-3 file:py-1.5 file:px-3 file:rounded file:bg-slate-800 file:border file:border-slate-700 file:text-slate-300 hover:file:bg-slate-700 cursor-pointer">
          </div>
          <ul class="divide-y divide-slate-800 text-xs">
            <li v-for="k in keys" :key="k.filename" class="py-2.5 flex justify-between items-center">
              <span class="font-mono text-slate-300">🔑 {{ k.filename }} ({{ k.size }} Bytes)</span>
              <button @click="deleteKey(k.filename)" class="text-red-400 hover:underline">销毁</button>
            </li>
            <li v-if="keys.length === 0" class="py-6 text-center text-slate-500">暂无证书凭证</li>
          </ul>
        </div>

        <!-- 5. 面板与安全设置 (符合 70% 黄金输入宽度规范) -->
        <div v-if="currentTab === 'settings'" class="dash-card p-6 w-full space-y-4">
          <h3 class="text-sm font-semibold text-white pb-2 border-b border-slate-800">管理员账号与登录安全</h3>
          <form @submit.prevent="saveProfile" class="flex flex-col items-center space-y-4 pt-2">
            <div class="w-full flex flex-col items-center">
              <label class="text-xs text-slate-400 mb-1 w-full text-left pl-[15%]">用户名</label>
              <input v-model="profile.username" required class="form-input-golden">
            </div>
            <div class="w-full flex flex-col items-center">
              <label class="text-xs text-slate-400 mb-1 w-full text-left pl-[15%]">绑定邮箱 (支持使用邮箱直接登入)</label>
              <input v-model="profile.email" type="email" required class="form-input-golden">
            </div>
            <div class="w-full flex flex-col items-center">
              <label class="text-xs text-slate-400 mb-1 w-full text-left pl-[15%]">重置新密码 (留空则不修改)</label>
              <input v-model="profile.new_password" type="password" placeholder="至少 6 位安全字符" minlength="6" class="form-input-golden">
            </div>
            <button type="submit" class="form-input-golden btn-primary mt-2">保存账号设置</button>
          </form>
        </div>

        <!-- 6. 运行追踪日志 -->
        <div v-if="currentTab === 'logs'" class="dash-card p-6 w-full space-y-4">
          <div class="flex justify-between items-center pb-2 border-b border-slate-800">
            <h3 class="text-sm font-semibold text-white">实时同步审计日志</h3>
            <span class="text-xs text-slate-400">调度周期: 每 15 分钟</span>
          </div>
          <div class="bg-[#05080f] p-4 rounded-lg border border-slate-800 font-mono text-xs h-[520px] overflow-y-auto space-y-3">
            <div v-for="l in logs" :key="l.id" class="border-b border-slate-800/80 pb-2">
              <div class="flex justify-between text-slate-400">
                <span>[{{ l.timestamp }}]</span>
                <span :class="l.status==='SUCCESS' ? 'text-emerald-400' : 'text-red-400'" class="font-bold">[{{ l.status }}]</span>
              </div>
              <pre class="mt-1 text-slate-300 whitespace-pre-wrap">{{ l.details }}</pre>
            </div>
            <div v-if="logs.length === 0" class="text-center text-slate-600 py-16">暂无历史同步记录</div>
          </div>
        </div>

      </div>

      <!-- 添加节点 Dialog (弹窗内允许 100% 满宽排版) -->
      <div v-if="showNodeModal" class="fixed inset-0 bg-black/75 flex items-center justify-center p-4 z-50">
        <div class="dash-card p-6 w-full max-w-lg bg-[#0f172a] border border-slate-700">
          <div class="flex justify-between items-center pb-3 border-b border-slate-800 mb-4">
            <h3 class="text-sm font-semibold text-white">添加 CDP 节点实例</h3>
            <button @click="showNodeModal = false" class="text-slate-400 hover:text-white">✕</button>
          </div>

          <form @submit.prevent="createNode" class="space-y-4">
            <!-- 本地 / 远程切换 -->
            <div>
              <label class="block text-xs text-slate-400 mb-2">节点接入类型</label>
              <div class="grid grid-cols-2 gap-3">
                <label 
                  :class="newNode.is_local ? 'border-blue-500 bg-blue-950/40 text-blue-300' : 'border-slate-700 text-slate-400'"
                  class="flex items-center justify-center gap-2 p-2.5 rounded-lg border cursor-pointer text-xs"
                >
                  <input type="radio" v-model="newNode.is_local" :value="true" class="hidden">
                  <span>💻 本地直连 (免SSH)</span>
                </label>

                <label 
                  :class="!newNode.is_local ? 'border-blue-500 bg-blue-950/40 text-blue-300' : 'border-slate-700 text-slate-400'"
                  class="flex items-center justify-center gap-2 p-2.5 rounded-lg border cursor-pointer text-xs"
                >
                  <input type="radio" v-model="newNode.is_local" :value="false" class="hidden">
                  <span>🌐 远程 SSH 节点</span>
                </label>
              </div>
            </div>

            <div>
              <label class="block text-xs text-slate-400 mb-1">节点标识名称</label>
              <input v-model="newNode.name" required placeholder="如: 本地 Chrome 01" class="modal-input">
            </div>

            <!-- 本地节点专用输入 -->
            <div v-if="newNode.is_local" class="p-3.5 bg-slate-900 rounded-lg border border-slate-800">
              <label class="block text-xs text-slate-400 mb-1">本地 CDP 调试端口 (默认 9222)</label>
              <input v-model="newNode.local_bind_port" type="number" required placeholder="9222" class="modal-input font-mono text-emerald-400">
              <p class="text-[11px] text-slate-500 mt-1.5">
                直接直连本机 Chromium 的远程调试端口，无需配置 SSH 主机与证书，执行零开销。
              </p>
            </div>

            <!-- 远程节点输入 -->
            <div v-else class="space-y-3.5">
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs text-slate-400 mb-1">SSH 主机 / IP</label>
                  <input v-model="newNode.ssh_host" required placeholder="192.168.1.100" class="modal-input font-mono">
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">SSH 端口</label>
                  <input v-model="newNode.ssh_port" type="number" placeholder="22" class="modal-input font-mono">
                </div>
              </div>

              <div>
                <label class="block text-xs text-slate-400 mb-1">SSH 用户名</label>
                <input v-model="newNode.ssh_user" required placeholder="root" class="modal-input font-mono">
              </div>

              <div>
                <label class="block text-xs text-slate-400 mb-1">绑定 SSH 证书 (选填)</label>
                <select v-model="newNode.ssh_key_filename" class="modal-input font-mono">
                  <option value="">密码认证 (不选择私钥证书)</option>
                  <option v-for="k in keys" :key="k.filename" :value="k.filename">🔑 {{ k.filename }}</option>
                </select>
              </div>

              <div v-if="!newNode.ssh_key_filename">
                <label class="block text-xs text-slate-400 mb-1">SSH 密码</label>
                <input v-model="newNode.ssh_password" type="password" placeholder="••••••••" class="modal-input">
              </div>

              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs text-slate-400 mb-1">远程 CDP 端口</label>
                  <input v-model="newNode.remote_cdp_port" type="number" placeholder="9222" class="modal-input font-mono">
                </div>
                <div>
                  <label class="block text-xs text-slate-400 mb-1">本地穿透绑定端口</label>
                  <input v-model="newNode.local_bind_port" type="number" required placeholder="19222" class="modal-input font-mono text-blue-400">
                </div>
              </div>
            </div>

            <div class="flex justify-end gap-2.5 pt-3 border-t border-slate-800">
              <button type="button" @click="showNodeModal = false" class="btn-secondary">取消</button>
              <button type="submit" class="btn-primary">保存配置</button>
            </div>
          </form>
        </div>
      </div>

    </div>
  </div>
</template>