<script setup>
import { ref, reactive, computed, onMounted } from 'vue'

const token = ref(localStorage.getItem('token') || '')
const captchaSvg = ref('')
const nodes = ref([])
const keys = ref([])
const logs = ref([])
const isSyncing = ref(false)
const showNodeModal = ref(false)
const showPwdModal = ref(false)
const newPassword = ref('')

const loginForm = reactive({
  password: '',
  captcha_token: '',
  captcha_answer: ''
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

// 统计面板指标计算
const totalCookies = computed(() => {
  return nodes.value.reduce((acc, cur) => acc + (cur.cookie_count || 0), 0)
})
const connectedTunnels = computed(() => {
  return nodes.value.filter(n => n.status === 'connected').length
})
const sourceNode = computed(() => {
  return nodes.value.find(n => n.is_source === 1)
})

const api = async (url, options = {}) => {
  options.headers = options.headers || {}
  if (token.value) {
    options.headers['Authorization'] = `Bearer ${token.value}`
  }
  const res = await fetch(url, options)
  if (res.status === 401) logout()
  return res
}

const refreshCaptcha = async () => {
  try {
    const res = await fetch('/api/captcha')
    const data = await res.json()
    captchaSvg.value = data.svg
    loginForm.captcha_token = data.token
  } catch (e) {
    console.error('获取验证码失败', e)
  }
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
    alert(data.detail || '认证失败，请核对信息')
    refreshCaptcha()
  }
}

const logout = () => {
  token.value = ''
  localStorage.removeItem('token')
  refreshCaptcha()
}

const loadAll = async () => {
  const [n, k, l] = await Promise.all([
    api('/api/nodes'),
    api('/api/ssh-keys'),
    api('/api/sync/logs')
  ])
  nodes.value = await n.json()
  keys.value = await k.json()
  logs.value = await l.json()
}

const triggerSync = async () => {
  if (isSyncing.value) return
  isSyncing.value = true
  try {
    const res = await api('/api/sync/trigger', { method: 'POST' })
    const data = await res.json()
    alert(data.message)
    await loadAll()
  } finally {
    isSyncing.value = false
  }
}

const toggleTunnel = async (id) => {
  await api(`/api/nodes/${id}/toggle-tunnel`, { method: 'POST' })
  loadAll()
}

const setSource = async (id) => {
  await api(`/api/nodes/${id}/set-source`, { method: 'POST' })
  loadAll()
}

const deleteNode = async (id) => {
  if (confirm('确认销毁该节点隧道与同步配置？')) {
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
  // 重置表单
  newNode.name = ''
  newNode.ssh_host = ''
  newNode.local_bind_port += 1
  loadAll()
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
  if (confirm(`确认销毁证书 [${name}]？`)) {
    await api(`/api/ssh-keys/${name}`, { method: 'DELETE' })
    loadAll()
  }
}

const changePassword = async () => {
  const res = await api('/api/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_password: newPassword.value })
  })
  if (res.ok) {
    alert('密码更新完毕，请重新鉴权')
    logout()
  }
}

onMounted(() => {
  if (!token.value) {
    refreshCaptcha()
  } else {
    loadAll()
  }
})
</script>

<template>
  <div class="min-h-screen flex flex-col selection:bg-cyan-500 selection:text-black">
    <!-- 1. 登录面板 (严格黄金比例输入框) -->
    <div v-if="!token" class="flex-1 flex items-center justify-center p-6">
      <div class="hud-card p-8 w-full max-w-lg border border-cyan-500/30 backdrop-blur-md">
        <div class="flex items-center justify-center gap-3 mb-2">
          <div class="w-3 h-3 bg-cyan-400 rounded-full animate-pulse shadow-[0_0_12px_#38bdf8]"></div>
          <h1 class="text-2xl font-black tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500 font-mono">
            OBSIDIAN // SYNC-HUD
          </h1>
        </div>
        <p class="text-slate-400 text-xs text-center font-mono tracking-wider mb-8">[CDP CLUSTER TUNNEL & COOKIE MATRIX]</p>

        <form @submit.prevent="login" class="flex flex-col items-center space-y-6">
          <div class="w-full flex flex-col items-center">
            <span class="text-xs text-slate-400 mb-1.5 self-start sm:pl-[15%] font-mono tracking-wider">ROOT ACCESS KEY // 密码</span>
            <input 
              type="password" 
              v-model="loginForm.password" 
              required 
              placeholder="••••••••••••"
              class="hud-input-ergonomic px-4 py-2.5 rounded-lg text-sm"
            >
          </div>

          <div class="w-full flex flex-col items-center">
            <span class="text-xs text-slate-400 mb-1.5 self-start sm:pl-[15%] font-mono tracking-wider">BOT CHALLENGE // 算术验证</span>
            <div class="hud-input-ergonomic flex items-center gap-2 p-1.5 rounded-lg border border-slate-700 bg-slate-800">
              <input 
                type="text" 
                v-model="loginForm.captcha_answer" 
                required 
                placeholder="计算答案"
                class="w-1/2 px-3 py-1.5 bg-slate-900 border border-slate-700 rounded text-slate-100 text-sm focus:border-cyan-400 outline-none font-mono"
              >
              <div @click="refreshCaptcha" class="w-1/2 flex justify-center cursor-pointer overflow-hidden rounded" title="点击刷新挑战">
                <div v-html="captchaSvg"></div>
              </div>
            </div>
          </div>

          <button type="submit" class="hud-input-ergonomic py-2.5 hud-btn-primary rounded-lg font-mono text-sm tracking-widest font-bold">
            INITIALIZE SESSION
          </button>
        </form>
      </div>
    </div>

    <!-- 2. HUD 赛博朋克控制台主界面 -->
    <div v-else class="flex-1 flex flex-col">
      <!-- 磨砂半透明毛玻璃顶栏 -->
      <header class="h-16 px-8 border-b border-cyan-500/20 sticky top-0 z-40 flex items-center justify-between"
              style="background: rgba(13, 19, 33, 0.85); backdrop-filter: blur(10px);">
        <div class="flex items-center space-x-4">
          <span class="relative flex h-3 w-3">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
            <span class="relative inline-flex rounded-full h-3 w-3 bg-cyan-500"></span>
          </span>
          <span class="font-mono font-bold text-lg text-cyan-400 tracking-wider">CHROMIUM.CDP // SYNC-MATRIX</span>
          <span class="hidden md:inline-block px-2 py-0.5 text-[11px] font-mono bg-cyan-950/60 text-cyan-300 border border-cyan-500/30 rounded">SYS.VER.2.4</span>
        </div>

        <div class="flex items-center gap-4">
          <button 
            @click="triggerSync" 
            :disabled="isSyncing"
            class="hud-btn-primary px-4 py-1.5 rounded-lg text-xs font-mono font-bold tracking-wider flex items-center gap-2"
          >
            <span v-if="isSyncing" class="animate-spin text-base">⟳</span>
            <span v-else>⚡</span>
            <span>{{ isSyncing ? 'SYNCING MATRIX...' : 'TRIGGER SYNC' }}</span>
          </button>
          <button @click="showPwdModal = true" class="hud-btn-action px-3 py-1.5 bg-slate-800 border border-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-mono">
            PASSKEY
          </button>
          <button @click="logout" class="hud-btn-action px-3 py-1.5 bg-red-950/40 border border-red-500/30 text-red-400 hover:bg-red-900/60 rounded-lg text-xs font-mono">
            DISCONNECT
          </button>
        </div>
      </header>

      <!-- 控制台主体 -->
      <main class="flex-1 p-6 md:p-8 max-w-7xl mx-auto w-full space-y-6">
        
        <!-- 核心指标 HUD 矩阵概览 -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div class="hud-card p-4 flex flex-col justify-between">
            <span class="text-[11px] font-mono text-slate-400 tracking-widest">[TOTAL NODES]</span>
            <div class="mt-2 flex items-baseline justify-between">
              <span class="text-2xl font-mono font-bold text-cyan-400">{{ nodes.length }}</span>
              <span class="text-xs text-slate-500 font-mono">NODES</span>
            </div>
          </div>

          <div class="hud-card p-4 flex flex-col justify-between">
            <span class="text-[11px] font-mono text-slate-400 tracking-widest">[ACTIVE TUNNELS]</span>
            <div class="mt-2 flex items-baseline justify-between">
              <span class="text-2xl font-mono font-bold text-emerald-400">{{ connectedTunnels }}</span>
              <span class="text-xs text-emerald-500 font-mono">ONLINE</span>
            </div>
          </div>

          <div class="hud-card p-4 flex flex-col justify-between">
            <span class="text-[11px] font-mono text-slate-400 tracking-widest">[COOKIES IN POOL]</span>
            <div class="mt-2 flex items-baseline justify-between">
              <span class="text-2xl font-mono font-bold text-amber-400">{{ totalCookies }}</span>
              <span class="text-xs text-amber-500 font-mono">SYNCED</span>
            </div>
          </div>

          <div class="hud-card p-4 flex flex-col justify-between">
            <span class="text-[11px] font-mono text-slate-400 tracking-widest">[SOURCE NODE]</span>
            <div class="mt-2 flex items-baseline justify-between truncate">
              <span class="text-sm font-mono font-bold text-cyan-300 truncate">{{ sourceNode ? sourceNode.name : 'UNSET' }}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-500/30">SRC</span>
            </div>
          </div>
        </div>

        <!-- 节点列表控制面板 -->
        <section class="hud-card p-6">
          <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 pb-4 border-b border-slate-800">
            <div>
              <h2 class="text-base font-bold text-slate-100 tracking-wide font-mono flex items-center gap-2">
                <span class="text-cyan-400">❖</span> CDP CLUSTER NODES // 节点状态矩阵
              </h2>
              <p class="text-xs text-slate-500 mt-1">管理各远程 Chrome 实例穿透映射与 Cookie 双向分发</p>
            </div>
            <button 
              @click="showNodeModal = true" 
              class="hud-btn-action px-3.5 py-1.5 bg-cyan-950/60 hover:bg-cyan-900/60 text-cyan-400 border border-cyan-500/40 rounded-lg text-xs font-mono font-bold tracking-wider flex items-center gap-1.5"
            >
              <span>+</span> <span>DEPLOY NODE</span>
            </button>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="text-xs font-mono uppercase bg-[#080c14]/60 text-slate-500 border-b border-[#1e293b]">
                <tr>
                  <th class="p-3.5">角色</th>
                  <th class="p-3.5">节点标识</th>
                  <th class="p-3.5">SSH 凭证与目标</th>
                  <th class="p-3.5">本地 CDP 映射端口</th>
                  <th class="p-3.5">Cookie 统计</th>
                  <th class="p-3.5">隧道状态</th>
                  <th class="p-3.5">最近同步</th>
                  <th class="p-3.5 text-right">操作指令</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[#1e293b] font-mono text-xs">
                <tr v-for="node in nodes" :key="node.id" class="hover:bg-slate-800/25 transition">
                  <!-- 角色 -->
                  <td class="p-3.5">
                    <span v-if="node.is_source" class="inline-flex items-center px-2 py-0.5 rounded text-[10px] bg-cyan-500/20 text-cyan-300 border border-cyan-400/40 shadow-[0_0_8px_rgba(56,189,248,0.2)]">
                      ★ 源节点 (SRC)
                    </span>
                    <button v-else @click="setSource(node.id)" class="text-slate-500 hover:text-cyan-400 transition text-[11px]">
                      设为源
                    </button>
                  </td>

                  <!-- 节点名称 -->
                  <td class="p-3.5 font-sans font-bold text-slate-100">
                    {{ node.name }}
                  </td>

                  <!-- SSH 连接 -->
                  <td class="p-3.5 text-slate-300">
                    <div>{{ node.ssh_user }}@{{ node.ssh_host }}:{{ node.ssh_port }}</div>
                    <span v-if="node.ssh_key_filename" class="inline-block mt-1 px-1.5 py-0.2 rounded text-[10px] bg-cyan-950 text-cyan-400 border border-cyan-800/60">
                      🔑 {{ node.ssh_key_filename }}
                    </span>
                    <span v-else class="inline-block mt-1 px-1.5 py-0.2 rounded text-[10px] bg-slate-800 text-slate-400 border border-slate-700">
                      🔒 密码凭证
                    </span>
                  </td>

                  <!-- 本地端口 -->
                  <td class="p-3.5 text-cyan-400 font-bold">
                    127.0.0.1:{{ node.local_bind_port }}
                  </td>

                  <!-- Cookie 统计 (核心新增数据展示) -->
                  <td class="p-3.5">
                    <div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#0b1120] border border-[#1e293b]">
                      <span class="text-amber-400">🍪</span>
                      <span class="text-amber-300 font-bold">{{ node.cookie_count || 0 }}</span>
                      <span class="text-[10px] text-slate-500">条</span>
                    </div>
                  </td>

                  <!-- 状态胶囊徽章 -->
                  <td class="p-3.5">
                    <span v-if="node.status === 'connected'" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium"
                          style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); color: #34d399;">
                      <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                      <span>在线 (ONLINE)</span>
                    </span>
                    <span v-else-if="node.status === 'stopped'" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium"
                          style="background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.3); color: #fbbf24;">
                      <span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                      <span>已断开 (STANDBY)</span>
                    </span>
                    <span v-else class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium"
                          style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171;">
                      <span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>
                      <span>异常 (FAULT)</span>
                    </span>
                  </td>

                  <!-- 最近同步 -->
                  <td class="p-3.5 text-slate-400 text-[11px]">
                    {{ node.last_sync || '---' }}
                  </td>

                  <!-- 操作按钮 -->
                  <td class="p-3.5 text-right space-x-2">
                    <button 
                      @click="toggleTunnel(node.id)" 
                      class="hud-btn-action px-2.5 py-1 rounded text-[11px] font-medium border"
                      :class="node.status === 'connected' ? 'bg-amber-950/40 border-amber-600/40 text-amber-300' : 'bg-cyan-950/40 border-cyan-600/40 text-cyan-300'"
                    >
                      {{ node.status === 'connected' ? '断开隧道' : '启动穿透' }}
                    </button>
                    <button 
                      @click="deleteNode(node.id)" 
                      class="hud-btn-action px-2 py-1 rounded text-[11px] font-medium bg-red-950/30 border border-red-800/40 text-red-400 hover:bg-red-900/50"
                    >
                      销毁
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- 2-Column 对称卡片栅格：SSH 证书库 + 实时任务日志 -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          
          <!-- SSH 证书库 -->
          <section class="hud-card p-6 flex flex-col justify-between">
            <div>
              <div class="flex items-center justify-between mb-4 pb-2 border-b border-slate-800">
                <h3 class="text-sm font-bold font-mono tracking-wider text-slate-200 flex items-center gap-2">
                  <span class="text-cyan-400">❖</span> KEY VAULT // SSH 密钥库
                </h3>
                <span class="text-xs text-slate-500 font-mono">{{ keys.length }} KEYS STORED</span>
              </div>
              <div class="mb-4">
                <input 
                  type="file" 
                  @change="uploadKey" 
                  class="text-xs text-slate-400 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-cyan-500/30 file:bg-cyan-950/40 file:text-cyan-300 hover:file:bg-cyan-900/60 cursor-pointer"
                >
              </div>
              <ul class="divide-y divide-[#1e293b] font-mono text-xs max-h-56 overflow-y-auto">
                <li v-for="k in keys" :key="k.filename" class="py-2.5 flex justify-between items-center hover:bg-slate-800/20 px-2 rounded">
                  <div class="flex items-center gap-2">
                    <span class="text-cyan-400">🔑</span>
                    <span class="text-slate-300 font-bold">{{ k.filename }}</span>
                    <span class="text-[10px] text-slate-500">({{ k.size }} Bytes)</span>
                  </div>
                  <button @click="deleteKey(k.filename)" class="text-red-400 hover:text-red-300 text-xs">销毁</button>
                </li>
                <li v-if="keys.length === 0" class="py-6 text-center text-slate-500">
                  暂无私钥证书，支持上传 .pem / id_rsa
                </li>
              </ul>
            </div>
            <div class="mt-4 pt-3 border-t border-slate-800 text-[11px] text-slate-500 font-mono">
              [STORAGE PATH: /data/keys/ | STRICT PERMISSION: 0600]
            </div>
          </section>

          <!-- 实时同步日志 -->
          <section class="hud-card p-6 flex flex-col justify-between">
            <div>
              <div class="flex items-center justify-between mb-4 pb-2 border-b border-slate-800">
                <h3 class="text-sm font-bold font-mono tracking-wider text-slate-200 flex items-center gap-2">
                  <span class="text-cyan-400">❖</span> TELEMETRY LOGS // 同步追踪日志
                </h3>
                <span class="text-xs text-slate-500 font-mono">CRON: 15 MINS</span>
              </div>
              <div class="hud-card-sub p-3 font-mono text-xs h-60 overflow-y-auto space-y-3">
                <div v-for="l in logs" :key="l.id" class="border-b border-slate-800/60 pb-2">
                  <div class="flex items-center justify-between text-[11px]">
                    <span class="text-cyan-400/80">[{{ l.timestamp }}]</span>
                    <span 
                      class="px-1.5 py-0.2 rounded text-[10px] font-bold"
                      :class="l.status==='SUCCESS' ? 'text-emerald-400 bg-emerald-950/40 border border-emerald-500/30' : 'text-red-400 bg-red-950/40 border border-red-500/30'"
                    >
                      {{ l.status }}
                    </span>
                  </div>
                  <pre class="mt-1 text-slate-400 text-[11px] whitespace-pre-wrap leading-relaxed">{{ l.details }}</pre>
                </div>
                <div v-if="logs.length === 0" class="text-slate-600 text-center py-10 font-mono">
                  [WAITING FOR FIRST DISPATCH EVENT...]
                </div>
              </div>
            </div>
            <div class="mt-4 pt-3 border-t border-slate-800 text-[11px] text-slate-500 font-mono">
              [ENGINE: CHROMIUM_SYNC_MODULE / AUTO-FAILOVER: ENABLED]
            </div>
          </section>

        </div>
      </main>

      <!-- 弹窗 1：创建节点 (模态框内允许 100% 满宽输入) -->
      <div v-if="showNodeModal" class="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
        <div class="hud-card p-6 w-full max-w-xl border-cyan-500/40 shadow-[0_0_30px_rgba(56,189,248,0.2)]">
          <div class="flex items-center justify-between pb-3 border-b border-slate-800 mb-5">
            <h3 class="text-base font-bold font-mono text-cyan-400 tracking-wider">DEPLOY NEW CDP NODE // 配置节点</h3>
            <button @click="showNodeModal = false" class="text-slate-400 hover:text-white font-mono">✕</button>
          </div>
          
          <form @submit.prevent="createNode" class="space-y-4">
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-xs font-mono text-slate-400 mb-1">NODE ALIAS // 节点名</label>
                <input v-model="newNode.name" required placeholder="例如: 欧洲节点-01" class="hud-dialog-input p-2.5 rounded text-sm">
              </div>
              <div>
                <label class="block text-xs font-mono text-slate-400 mb-1">SSH HOST / IP</label>
                <input v-model="newNode.ssh_host" required placeholder="192.168.1.100" class="hud-dialog-input p-2.5 rounded text-sm font-mono">
              </div>
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-xs font-mono text-slate-400 mb-1">SSH PORT (默认 22)</label>
                <input v-model="newNode.ssh_port" type="number" placeholder="22" class="hud-dialog-input p-2.5 rounded text-sm font-mono">
              </div>
              <div>
                <label class="block text-xs font-mono text-slate-400 mb-1">SSH USER</label>
                <input v-model="newNode.ssh_user" required placeholder="root" class="hud-dialog-input p-2.5 rounded text-sm font-mono">
              </div>
            </div>

            <div>
              <label class="block text-xs font-mono text-slate-400 mb-1">AUTH CERTIFICATE // 绑定证书 (选填)</label>
              <select v-model="newNode.ssh_key_filename" class="hud-dialog-input p-2.5 rounded text-sm font-mono">
                <option value="">使用账号密码登录（不选择证书）</option>
                <option v-for="k in keys" :key="k.filename" :value="k.filename">🔑 {{ k.filename }}</option>
              </select>
            </div>

            <div v-if="!newNode.ssh_key_filename">
              <label class="block text-xs font-mono text-slate-400 mb-1">SSH PASSWORD</label>
              <input v-model="newNode.ssh_password" type="password" placeholder="••••••••" class="hud-dialog-input p-2.5 rounded text-sm">
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-xs font-mono text-slate-400 mb-1">REMOTE CDP PORT</label>
                <input v-model="newNode.remote_cdp_port" type="number" placeholder="9222" class="hud-dialog-input p-2.5 rounded text-sm font-mono">
              </div>
              <div>
                <label class="block text-xs font-mono text-slate-400 mb-1">LOCAL FORWARD PORT</label>
                <input v-model="newNode.local_bind_port" type="number" required placeholder="19222" class="hud-dialog-input p-2.5 rounded text-sm font-mono text-cyan-400">
              </div>
            </div>

            <div class="flex justify-end gap-3 pt-4 border-t border-slate-800">
              <button type="button" @click="showNodeModal = false" class="px-4 py-2 bg-slate-800 text-slate-300 rounded text-xs font-mono">CANCEL</button>
              <button type="submit" class="hud-btn-primary px-5 py-2 rounded text-xs font-mono font-bold tracking-wider">DEPLOY NODE</button>
            </div>
          </form>
        </div>
      </div>

      <!-- 弹窗 2：修改密码 -->
      <div v-if="showPwdModal" class="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
        <div class="hud-card p-6 w-full max-w-md border-cyan-500/40">
          <div class="flex items-center justify-between pb-3 border-b border-slate-800 mb-5">
            <h3 class="text-base font-bold font-mono text-cyan-400 tracking-wider">UPDATE PASSKEY // 密码重置</h3>
            <button @click="showPwdModal = false" class="text-slate-400 hover:text-white font-mono">✕</button>
          </div>
          <form @submit.prevent="changePassword" class="space-y-4">
            <div>
              <label class="block text-xs font-mono text-slate-400 mb-1">NEW ACCESS KEY</label>
              <input v-model="newPassword" type="password" required minlength="6" placeholder="至少 6 位安全字符串" class="hud-dialog-input p-2.5 rounded text-sm">
            </div>
            <div class="flex justify-end gap-3 pt-2">
              <button type="button" @click="showPwdModal = false" class="px-4 py-2 bg-slate-800 text-slate-300 rounded text-xs font-mono">CANCEL</button>
              <button type="submit" class="hud-btn-primary px-5 py-2 rounded text-xs font-mono font-bold">COMMIT CHANGE</button>
            </div>
          </form>
        </div>
      </div>

    </div>
  </div>
</template>