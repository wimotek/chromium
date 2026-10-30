<script setup>
import { ref, reactive, computed, onMounted } from 'vue'

const token = ref(localStorage.getItem('token') || '')
const currentTab = ref('nodes') // 'nodes' | 'notifications' | 'keys' | 'profile' | 'logs'
const captchaSvg = ref('')

const nodes = ref([])
const keys = ref([])
const logs = ref([])
const isSyncing = ref(false)
const showNodeModal = ref(false)

const loginForm = reactive({
  account: '', // 邮箱或用户名
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
  ssh_host: '',
  ssh_port: 22,
  ssh_user: 'root',
  ssh_key_filename: '',
  ssh_password: '',
  remote_cdp_port: 9222,
  local_bind_port: 19222
})

const totalCookies = computed(() => nodes.value.reduce((acc, n) => acc + (n.cookie_count || 0), 0))
const onlineCount = computed(() => nodes.value.filter(n => n.status === 'connected').length)

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
    alert(data.detail || '认证失败')
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

// 主动探测节点最新 Cookie
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
  if (confirm('确认删除此节点配置？')) {
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
  if (res.ok) alert('通知配置已更新')
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
    alert('账号信息已更新')
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
  <div class="min-h-screen flex flex-col bg-[#0b0f19] text-slate-100">
    <!-- 登录视图 (支持用户名或邮箱) -->
    <div v-if="!token" class="flex-1 flex items-center justify-center p-6">
      <div class="kuma-card p-8 w-full max-w-md bg-[#111827] border border-gray-800 rounded-xl shadow-2xl">
        <div class="flex items-center gap-3 mb-6">
          <div class="w-3.5 h-3.5 bg-blue-500 rounded-full"></div>
          <h1 class="text-xl font-bold tracking-tight text-white font-sans">CDP 集群控制台</h1>
        </div>

        <form @submit.prevent="login" class="space-y-4">
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1.5">邮箱地址 或 用户名</label>
            <input 
              v-model="loginForm.account" 
              required 
              placeholder="admin 或 admin@wimotek.com"
              class="w-full kuma-input"
            >
          </div>

          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1.5">登录密码</label>
            <input 
              type="password" 
              v-model="loginForm.password" 
              required 
              placeholder="••••••••••••"
              class="w-full kuma-input"
            >
          </div>

          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1.5">人机验证</label>
            <div class="flex items-center gap-2">
              <input 
                v-model="loginForm.captcha_answer" 
                required 
                placeholder="计算答案"
                class="w-1/2 kuma-input"
              >
              <div @click="refreshCaptcha" class="w-1/2 flex justify-center cursor-pointer bg-gray-800 rounded-lg p-1 border border-gray-700" title="点击刷新验证码">
                <div v-html="captchaSvg"></div>
              </div>
            </div>
          </div>

          <button type="submit" class="w-full py-2.5 kuma-btn-primary mt-2">
            登 录
          </button>
        </form>
      </div>
    </div>

    <!-- 登录后主控制台 (卡片分类 Tab 导航) -->
    <div v-else class="flex-1 flex flex-col">
      <!-- 顶部导航 -->
      <header class="h-16 px-6 border-b border-gray-800 bg-[#111827]/90 sticky top-0 z-30 flex items-center justify-between">
        <div class="flex items-center space-x-3">
          <div class="w-3 h-3 bg-emerald-500 rounded-full animate-pulse"></div>
          <span class="font-bold text-base tracking-tight text-white">Chromium CDP Hub</span>
          <span class="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700">v2.5</span>
        </div>

        <!-- 顶部操作 -->
        <div class="flex items-center gap-3">
          <button @click="triggerSync" :disabled="isSyncing" class="px-3.5 py-1.5 kuma-btn-primary text-xs flex items-center gap-1.5">
            <span>{{ isSyncing ? '同步中...' : '⚡ 立即触发同步' }}</span>
          </button>
          <button @click="logout" class="px-3 py-1.5 kuma-btn-secondary text-xs">
            退出登录
          </button>
        </div>
      </header>

      <!-- 次级卡片分类导航栏 (Tabs) -->
      <div class="px-6 border-b border-gray-800 bg-[#0d1322]">
        <div class="max-w-7xl mx-auto flex space-x-1 sm:space-x-4">
          <button 
            @click="currentTab = 'nodes'"
            :class="currentTab === 'nodes' ? 'border-blue-500 text-blue-400 font-medium' : 'border-transparent text-gray-400 hover:text-gray-200'"
            class="py-3 px-3 border-b-2 text-sm flex items-center gap-2"
          >
            <span>🌐</span> <span>节点列表与监控</span>
            <span class="text-xs px-1.5 py-0.2 rounded-full bg-gray-800 text-gray-300">{{ nodes.length }}</span>
          </button>

          <button 
            @click="currentTab = 'notifications'"
            :class="currentTab === 'notifications' ? 'border-blue-500 text-blue-400 font-medium' : 'border-transparent text-gray-400 hover:text-gray-200'"
            class="py-3 px-3 border-b-2 text-sm flex items-center gap-2"
          >
            <span>🔔</span> <span>告警与通知设置</span>
          </button>

          <button 
            @click="currentTab = 'keys'"
            :class="currentTab === 'keys' ? 'border-blue-500 text-blue-400 font-medium' : 'border-transparent text-gray-400 hover:text-gray-200'"
            class="py-3 px-3 border-b-2 text-sm flex items-center gap-2"
          >
            <span>🔑</span> <span>SSH 证书库</span>
          </button>

          <button 
            @click="currentTab = 'profile'"
            :class="currentTab === 'profile' ? 'border-blue-500 text-blue-400 font-medium' : 'border-transparent text-gray-400 hover:text-gray-200'"
            class="py-3 px-3 border-b-2 text-sm flex items-center gap-2"
          >
            <span>👤</span> <span>安全与个人资料</span>
          </button>

          <button 
            @click="currentTab = 'logs'"
            :class="currentTab === 'logs' ? 'border-blue-500 text-blue-400 font-medium' : 'border-transparent text-gray-400 hover:text-gray-200'"
            class="py-3 px-3 border-b-2 text-sm flex items-center gap-2"
          >
            <span>📜</span> <span>同步日志</span>
          </button>
        </div>
      </div>

      <!-- 控制台主体视图 -->
      <main class="flex-1 p-6 max-w-7xl mx-auto w-full space-y-6">
        
        <!-- Tab 1: 节点列表与监控 -->
        <div v-if="currentTab === 'nodes'" class="space-y-6">
          <!-- 统计概览小卡片 -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div class="kuma-card p-4">
              <span class="text-xs text-gray-400 font-medium">总节点数</span>
              <div class="text-2xl font-bold mt-1 text-white">{{ nodes.length }}</div>
            </div>
            <div class="kuma-card p-4">
              <span class="text-xs text-gray-400 font-medium">在线穿透隧道</span>
              <div class="text-2xl font-bold mt-1 text-emerald-400">{{ onlineCount }}</div>
            </div>
            <div class="kuma-card p-4">
              <span class="text-xs text-gray-400 font-medium">已同步 Cookie 总数</span>
              <div class="text-2xl font-bold mt-1 text-amber-400">{{ totalCookies }}</div>
            </div>
          </div>

          <!-- 节点主卡片 -->
          <div class="kuma-card p-6">
            <div class="flex justify-between items-center mb-5 pb-3 border-b border-gray-800">
              <h2 class="text-base font-semibold text-white">CDP 映射实例</h2>
              <button @click="showNodeModal = true" class="px-3.5 py-1.5 kuma-btn-primary text-xs">
                + 新增 CDP 节点
              </button>
            </div>

            <div class="overflow-x-auto">
              <table class="w-full text-left text-sm">
                <thead class="text-xs text-gray-400 bg-gray-900/50 uppercase border-b border-gray-800">
                  <tr>
                    <th class="p-3">类型</th>
                    <th class="p-3">节点名</th>
                    <th class="p-3">SSH 连接凭证</th>
                    <th class="p-3">本地转发端口</th>
                    <th class="p-3">Cookie 实时统计</th>
                    <th class="p-3">隧道状态</th>
                    <th class="p-3">最近同步时间</th>
                    <th class="p-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-800 text-xs">
                  <tr v-for="node in nodes" :key="node.id" class="hover:bg-gray-800/30">
                    <td class="p-3">
                      <span v-if="node.is_source" class="px-2 py-0.5 rounded text-[11px] font-medium bg-blue-900/60 text-blue-300 border border-blue-700">
                        源节点 (Source)
                      </span>
                      <button v-else @click="setSource(node.id)" class="text-gray-400 hover:text-blue-400">
                        设为源
                      </button>
                    </td>

                    <td class="p-3 font-semibold text-white">{{ node.name }}</td>

                    <td class="p-3 text-gray-300 font-mono">
                      <div>{{ node.ssh_user }}@{{ node.ssh_host }}:{{ node.ssh_port }}</div>
                      <span v-if="node.ssh_key_filename" class="text-[10px] text-gray-400">🔑 {{ node.ssh_key_filename }}</span>
                      <span v-else class="text-[10px] text-gray-500">🔒 密码认证</span>
                    </td>

                    <td class="p-3 font-mono text-blue-400 font-semibold">127.0.0.1:{{ node.local_bind_port }}</td>

                    <!-- Cookie 实时统计展示与主动探查 -->
                    <td class="p-3">
                      <div class="inline-flex items-center gap-1.5 bg-gray-800/80 px-2 py-1 rounded border border-gray-700">
                        <span class="text-amber-400">🍪</span>
                        <span class="font-bold text-amber-300">{{ node.cookie_count || 0 }}</span>
                        <button @click="probeNode(node)" class="text-[10px] text-blue-400 hover:underline ml-1" title="通过 CDP 接口主动探测最新 Cookie 数">
                          刷新
                        </button>
                      </div>
                    </td>

                    <td class="p-3">
                      <span v-if="node.status === 'connected'" class="px-2 py-0.5 rounded-full badge-online text-[11px] font-medium">
                        ● 在线
                      </span>
                      <span v-else-if="node.status === 'stopped'" class="px-2 py-0.5 rounded-full badge-standby text-[11px] font-medium">
                        ○ 离线
                      </span>
                      <span v-else class="px-2 py-0.5 rounded-full badge-danger text-[11px] font-medium">
                        ✕ 异常
                      </span>
                    </td>

                    <td class="p-3 text-gray-400">{{ node.last_sync || '暂无同步' }}</td>

                    <td class="p-3 text-right space-x-2">
                      <button @click="toggleTunnel(node)" class="px-2.5 py-1 kuma-btn-secondary text-[11px]">
                        {{ node.status === 'connected' ? '断开隧道' : '启动连接' }}
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
        </div>

        <!-- Tab 2: 告警与通知设置 (Email + Server酱) -->
        <div v-if="currentTab === 'notifications'" class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <!-- 邮件通知配置卡片 -->
          <div class="kuma-card p-6 flex flex-col justify-between">
            <div>
              <div class="flex justify-between items-center mb-4 pb-2 border-b border-gray-800">
                <h3 class="text-sm font-semibold text-white">📧 邮件发信设置 (SMTP)</h3>
                <button @click="testEmail" class="text-xs text-blue-400 hover:underline">发送测试邮件</button>
              </div>
              <div class="space-y-3">
                <div>
                  <label class="block text-xs text-gray-400 mb-1">SMTP 主机</label>
                  <input v-model="notif.smtp_host" placeholder="smtp.qq.com / smtp.163.com" class="w-full kuma-input">
                </div>
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-xs text-gray-400 mb-1">SMTP 端口</label>
                    <input v-model="notif.smtp_port" placeholder="465" class="w-full kuma-input">
                  </div>
                  <div>
                    <label class="block text-xs text-gray-400 mb-1">加密方式</label>
                    <select v-model="notif.smtp_ssl" class="w-full kuma-input">
                      <option :value="true">SSL / TLS (默认)</option>
                      <option :value="false">STARTTLS / 明文</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">发信邮箱账号</label>
                  <input v-model="notif.smtp_user" placeholder="user@domain.com" class="w-full kuma-input">
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">发信授权码 / 密码</label>
                  <input v-model="notif.smtp_pass" type="password" placeholder="邮箱授权码" class="w-full kuma-input">
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">接收预警邮箱 (留空默认为管理员邮箱)</label>
                  <input v-model="notif.smtp_to" placeholder="receiver@domain.com" class="w-full kuma-input">
                </div>
              </div>
            </div>
            <button @click="saveNotif" class="mt-5 py-2 kuma-btn-primary w-full text-xs">保存邮件通知设置</button>
          </div>

          <!-- Server酱微信推送配置卡片 -->
          <div class="kuma-card p-6 flex flex-col justify-between">
            <div>
              <div class="flex justify-between items-center mb-4 pb-2 border-b border-gray-800">
                <h3 class="text-sm font-semibold text-white">📱 Server酱 (微信服务号推送)</h3>
                <button @click="testServerChan" class="text-xs text-blue-400 hover:underline">发送微信测试</button>
              </div>
              <div class="space-y-4">
                <div class="flex items-center gap-2">
                  <input type="checkbox" v-model="notif.serverchan_enabled" id="s_enable" class="rounded bg-gray-800 border-gray-700 text-blue-600">
                  <label for="s_enable" class="text-xs text-gray-300">启用 Server酱 微信实时推送</label>
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Server酱 SendKey</label>
                  <input v-model="notif.serverchan_key" placeholder="SCTxxxxxxxxxxxxxxxx" class="w-full kuma-input font-mono">
                  <p class="text-[11px] text-gray-500 mt-1">从 sct.ftqq.com 获取的 SendKey，同步失败或离线时将第一时间推送到微信。</p>
                </div>
              </div>
            </div>
            <button @click="saveNotif" class="mt-5 py-2 kuma-btn-primary w-full text-xs">保存 Server酱 配置</button>
          </div>
        </div>

        <!-- Tab 3: SSH 证书管理 -->
        <div v-if="currentTab === 'keys'" class="kuma-card p-6">
          <div class="flex justify-between items-center mb-4 pb-2 border-b border-gray-800">
            <h3 class="text-sm font-semibold text-white">SSH 私钥与凭证库</h3>
            <span class="text-xs text-gray-400">{{ keys.length }} 个密钥文件已持久化</span>
          </div>
          <div class="mb-4">
            <input type="file" @change="uploadKey" class="text-xs text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded file:bg-gray-800 file:border file:border-gray-700 file:text-gray-300 hover:file:bg-gray-700 cursor-pointer">
          </div>
          <ul class="divide-y divide-gray-800 text-xs">
            <li v-for="k in keys" :key="k.filename" class="py-2.5 flex justify-between items-center">
              <span class="font-mono text-gray-200 font-medium">🔑 {{ k.filename }} ({{ k.size }} Bytes)</span>
              <button @click="deleteKey(k.filename)" class="text-red-400 hover:underline">删除</button>
            </li>
            <li v-if="keys.length === 0" class="py-4 text-center text-gray-500">暂无上传的私钥凭据</li>
          </ul>
        </div>

        <!-- Tab 4: 个人资料与安全设置 (支持修改用户名与邮箱) -->
        <div v-if="currentTab === 'profile'" class="kuma-card p-6 max-w-xl mx-auto">
          <h3 class="text-sm font-semibold text-white mb-4 pb-2 border-b border-gray-800">管理员账号与登录安全</h3>
          <form @submit.prevent="saveProfile" class="space-y-4">
            <div>
              <label class="block text-xs text-gray-400 mb-1">登录用户名</label>
              <input v-model="profile.username" required class="w-full kuma-input">
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">绑定邮箱 (支持使用邮箱直接登录)</label>
              <input v-model="profile.email" type="email" required class="w-full kuma-input">
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">修改新密码 (不修改请留空)</label>
              <input v-model="profile.new_password" type="password" placeholder="若留空则保持原密码不变" minlength="6" class="w-full kuma-input">
            </div>
            <button type="submit" class="py-2.5 kuma-btn-primary w-full text-xs">保存个人资料</button>
          </form>
        </div>

        <!-- Tab 5: 同步日志 -->
        <div v-if="currentTab === 'logs'" class="kuma-card p-6">
          <div class="flex justify-between items-center mb-4 pb-2 border-b border-gray-800">
            <h3 class="text-sm font-semibold text-white">同步任务执行追踪</h3>
            <span class="text-xs text-gray-400">调度周期: 每 15 分钟</span>
          </div>
          <div class="bg-gray-950 p-3 rounded-lg font-mono text-xs h-96 overflow-y-auto space-y-3 border border-gray-800">
            <div v-for="l in logs" :key="l.id" class="border-b border-gray-800/80 pb-2">
              <div class="flex justify-between text-gray-400">
                <span>[{{ l.timestamp }}]</span>
                <span :class="l.status==='SUCCESS' ? 'text-emerald-400' : 'text-red-400'" class="font-bold">[{{ l.status }}]</span>
              </div>
              <pre class="mt-1 text-gray-300 whitespace-pre-wrap">{{ l.details }}</pre>
            </div>
            <div v-if="logs.length === 0" class="text-center text-gray-600 py-12">暂无历史同步记录</div>
          </div>
        </div>

      </main>

      <!-- 新增节点 Dialog -->
      <div v-if="showNodeModal" class="fixed inset-0 bg-black/75 flex items-center justify-center p-4 z-50">
        <div class="kuma-card p-6 w-full max-w-lg bg-[#111827] border border-gray-700">
          <div class="flex justify-between items-center pb-3 border-b border-gray-800 mb-4">
            <h3 class="text-base font-semibold text-white">部署新 CDP 节点</h3>
            <button @click="showNodeModal = false" class="text-gray-400 hover:text-white">✕</button>
          </div>
          <form @submit.prevent="createNode" class="space-y-3.5">
            <div>
              <label class="block text-xs text-gray-400 mb-1">节点名称</label>
              <input v-model="newNode.name" required placeholder="例如: 欧洲节点-01" class="w-full kuma-input">
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs text-gray-400 mb-1">SSH Host</label>
                <input v-model="newNode.ssh_host" required placeholder="192.168.1.100" class="w-full kuma-input font-mono">
              </div>
              <div>
                <label class="block text-xs text-gray-400 mb-1">SSH Port</label>
                <input v-model="newNode.ssh_port" type="number" placeholder="22" class="w-full kuma-input font-mono">
              </div>
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">SSH 用户名</label>
              <input v-model="newNode.ssh_user" required placeholder="root" class="w-full kuma-input font-mono">
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">选择 SSH 证书 (选填)</label>
              <select v-model="newNode.ssh_key_filename" class="w-full kuma-input font-mono">
                <option value="">使用账号密码登录 (无私钥证书)</option>
                <option v-for="k in keys" :key="k.filename" :value="k.filename">🔑 {{ k.filename }}</option>
              </select>
            </div>
            <div v-if="!newNode.ssh_key_filename">
              <label class="block text-xs text-gray-400 mb-1">SSH 密码</label>
              <input v-model="newNode.ssh_password" type="password" placeholder="••••••••" class="w-full kuma-input">
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs text-gray-400 mb-1">远程 CDP 端口</label>
                <input v-model="newNode.remote_cdp_port" type="number" placeholder="9222" class="w-full kuma-input font-mono">
              </div>
              <div>
                <label class="block text-xs text-gray-400 mb-1">本地隧道绑定端口</label>
                <input v-model="newNode.local_bind_port" type="number" required placeholder="19222" class="w-full kuma-input font-mono text-blue-400">
              </div>
            </div>
            <div class="flex justify-end gap-3 pt-3 border-t border-gray-800">
              <button type="button" @click="showNodeModal = false" class="px-4 py-2 kuma-btn-secondary text-xs">取消</button>
              <button type="submit" class="px-5 py-2 kuma-btn-primary text-xs">保存并部署</button>
            </div>
          </form>
        </div>
      </div>

    </div>
  </div>
</template>