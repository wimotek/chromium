<script setup>
import { ref, reactive, computed, onMounted } from 'vue'

const token = ref(localStorage.getItem('token') || '')
const currentMenu = ref('nodes') // 'nodes' | 'sync' | 'notifications' | 'keys' | 'settings' | 'logs'
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

// 新增节点数据模型（包含本地直连字段）
const newNode = reactive({
  name: '',
  is_local: true, // 默认推荐本地直连
  ssh_host: '',
  ssh_port: 22,
  ssh_user: 'root',
  ssh_key_filename: '',
  ssh_password: '',
  remote_cdp_port: 9222,
  local_bind_port: 9222 // 本地默认 9222
})

const totalCookies = computed(() => nodes.value.reduce((acc, n) => acc + (n.cookie_count || 0), 0))
const localNodeCount = computed(() => nodes.value.filter(n => n.is_local === 1).length)
const remoteNodeCount = computed(() => nodes.value.filter(n => !n.is_local).length)
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
  if (confirm('确认删除此节点？')) {
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
  if (res.ok) alert('通知配置已保存')
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
  <div class="min-h-screen bg-[#000000] text-gray-200">
    <!-- 1. 登录面板 (标准 X-UI 居中深色对话框) -->
    <div v-if="!token" class="min-h-screen flex items-center justify-center p-4 bg-[#0a0a0a]">
      <div class="w-full max-w-sm ant-card p-6 bg-[#141414] border border-[#303030]">
        <div class="flex items-center gap-3 mb-6 pb-4 border-b border-[#303030]">
          <div class="w-8 h-8 rounded bg-[#1677ff] flex items-center justify-center font-bold text-white text-base">
            X
          </div>
          <div>
            <h1 class="text-base font-semibold text-white">X-CDP 管理面板</h1>
            <p class="text-xs text-gray-500">Chromium Cookie 集群调度系统</p>
          </div>
        </div>

        <form @submit.prevent="login" class="space-y-4">
          <div>
            <label class="block text-xs text-gray-400 mb-1.5">账号 (用户名 或 邮箱)</label>
            <input v-model="loginForm.account" required placeholder="admin / admin@wimotek.com" class="w-full ant-input">
          </div>

          <div>
            <label class="block text-xs text-gray-400 mb-1.5">登录密码</label>
            <input type="password" v-model="loginForm.password" required placeholder="••••••••••••" class="w-full ant-input">
          </div>

          <div>
            <label class="block text-xs text-gray-400 mb-1.5">人机验证</label>
            <div class="flex items-center gap-2">
              <input v-model="loginForm.captcha_answer" required placeholder="答案" class="w-1/2 ant-input">
              <div @click="refreshCaptcha" class="w-1/2 cursor-pointer flex justify-center bg-[#1f1f1f] rounded border border-[#303030] p-0.5" title="点击刷新验证码">
                <div v-html="captchaSvg"></div>
              </div>
            </div>
          </div>

          <button type="submit" class="w-full ant-btn-primary mt-2">
            登 录
          </button>
        </form>
      </div>
    </div>

    <!-- 2. 主控制台 (左侧导航 + 右侧主内容) -->
    <div v-else class="flex min-h-screen">
      <!-- 左侧专业导航侧边栏 -->
      <aside class="w-56 bg-[#141414] border-r border-[#303030] flex flex-col justify-between shrink-0">
        <div>
          <!-- Logo 标头 -->
          <div class="h-16 flex items-center px-5 gap-3 border-b border-[#303030]">
            <div class="w-7 h-7 rounded bg-[#1677ff] flex items-center justify-center font-bold text-white text-sm">
              X
            </div>
            <span class="font-bold text-sm tracking-wide text-white">CDP-UI 面板</span>
          </div>

          <!-- 导航菜单 -->
          <nav class="p-2 space-y-1 text-sm font-normal">
            <button 
              @click="currentMenu = 'nodes'"
              :class="currentMenu === 'nodes' ? 'bg-[#1677ff]/15 text-[#1677ff] font-medium' : 'text-gray-400 hover:text-white hover:bg-[#1f1f1f]'"
              class="w-full flex items-center gap-3 px-3 py-2.5 rounded-md transition"
            >
              <span>🌐</span> <span>节点列表</span>
            </button>

            <button 
              @click="currentMenu = 'sync'"
              :class="currentMenu === 'sync' ? 'bg-[#1677ff]/15 text-[#1677ff] font-medium' : 'text-gray-400 hover:text-white hover:bg-[#1f1f1f]'"
              class="w-full flex items-center gap-3 px-3 py-2.5 rounded-md transition"
            >
              <span>⚡</span> <span>同步调度</span>
            </button>

            <button 
              @click="currentMenu = 'notifications'"
              :class="currentMenu === 'notifications' ? 'bg-[#1677ff]/15 text-[#1677ff] font-medium' : 'text-gray-400 hover:text-white hover:bg-[#1f1f1f]'"
              class="w-full flex items-center gap-3 px-3 py-2.5 rounded-md transition"
            >
              <span>🔔</span> <span>告警通知</span>
            </button>

            <button 
              @click="currentMenu = 'keys'"
              :class="currentMenu === 'keys' ? 'bg-[#1677ff]/15 text-[#1677ff] font-medium' : 'text-gray-400 hover:text-white hover:bg-[#1f1f1f]'"
              class="w-full flex items-center gap-3 px-3 py-2.5 rounded-md transition"
            >
              <span>🔑</span> <span>证书凭证</span>
            </button>

            <button 
              @click="currentMenu = 'settings'"
              :class="currentMenu === 'settings' ? 'bg-[#1677ff]/15 text-[#1677ff] font-medium' : 'text-gray-400 hover:text-white hover:bg-[#1f1f1f]'"
              class="w-full flex items-center gap-3 px-3 py-2.5 rounded-md transition"
            >
              <span>⚙️</span> <span>面板设置</span>
            </button>

            <button 
              @click="currentMenu = 'logs'"
              :class="currentMenu === 'logs' ? 'bg-[#1677ff]/15 text-[#1677ff] font-medium' : 'text-gray-400 hover:text-white hover:bg-[#1f1f1f]'"
              class="w-full flex items-center gap-3 px-3 py-2.5 rounded-md transition"
            >
              <span>📜</span> <span>运行日志</span>
            </button>
          </nav>
        </div>

        <!-- 底部面板状态信息 -->
        <div class="p-4 border-t border-[#303030] text-xs text-gray-500">
          <div>运行模式: <span class="text-green-500">双栈正常</span></div>
          <div class="mt-1">X-CDP v3.1.0</div>
        </div>
      </aside>

      <!-- 右侧主内容区 -->
      <div class="flex-1 flex flex-col bg-[#000000]">
        <!-- 顶栏面包屑与快速操作 -->
        <header class="h-16 border-b border-[#303030] bg-[#141414] px-6 flex items-center justify-between">
          <div class="text-sm text-gray-400 flex items-center gap-2">
            <span>面板主页</span>
            <span>/</span>
            <span class="text-white font-medium">
              {{ currentMenu === 'nodes' ? '节点管理与状态' : currentMenu === 'sync' ? 'Cookie 同步控制' : currentMenu === 'notifications' ? '告警与通知设置' : currentMenu === 'keys' ? 'SSH 凭据管理' : currentMenu === 'settings' ? '面板与账号安全' : '运行日志' }}
            </span>
          </div>

          <div class="flex items-center gap-3">
            <button @click="triggerSync" :disabled="isSyncing" class="ant-btn-primary flex items-center gap-1.5 text-xs">
              <span>{{ isSyncing ? '同步任务执行中...' : '⚡ 立即触发同步' }}</span>
            </button>
            <button @click="logout" class="ant-btn-default text-xs">
              退出
            </button>
          </div>
        </header>

        <!-- 主内容容器 -->
        <main class="flex-1 p-6 space-y-6 overflow-y-auto">
          
          <!-- 1. 节点管理 (包含状态概览栅格与表格) -->
          <div v-if="currentMenu === 'nodes'" class="space-y-6">
            <!-- 统计栅格 (仿 X-UI 统计栏) -->
            <div class="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <div class="ant-card p-4">
                <div class="text-xs text-gray-400">总节点数</div>
                <div class="text-2xl font-bold mt-1 text-white">{{ nodes.length }}</div>
              </div>
              <div class="ant-card p-4">
                <div class="text-xs text-gray-400">本地直连节点</div>
                <div class="text-2xl font-bold mt-1 text-[#1677ff]">{{ localNodeCount }}</div>
              </div>
              <div class="ant-card p-4">
                <div class="text-xs text-gray-400">远程穿透节点</div>
                <div class="text-2xl font-bold mt-1 text-green-500">{{ remoteNodeCount }} ({{ onlineCount }} 活跃)</div>
              </div>
              <div class="ant-card p-4">
                <div class="text-xs text-gray-400">Cookie 池总量</div>
                <div class="text-2xl font-bold mt-1 text-amber-400">{{ totalCookies }}</div>
              </div>
            </div>

            <!-- 节点表格 -->
            <div class="ant-card p-5">
              <div class="flex justify-between items-center mb-4">
                <h2 class="text-sm font-semibold text-white">CDP 节点列表</h2>
                <button @click="showNodeModal = true" class="ant-btn-primary text-xs">
                  + 添加节点
                </button>
              </div>

              <div class="overflow-x-auto">
                <table class="w-full text-left text-xs">
                  <thead class="text-gray-400 bg-[#1f1f1f] border-b border-[#303030]">
                    <tr>
                      <th class="p-3">角色</th>
                      <th class="p-3">节点类型</th>
                      <th class="p-3">节点名称</th>
                      <th class="p-3">连接地址 / 端口</th>
                      <th class="p-3">实时 Cookie</th>
                      <th class="p-3">状态</th>
                      <th class="p-3">最近更新</th>
                      <th class="p-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-[#303030]">
                    <tr v-for="node in nodes" :key="node.id" class="hover:bg-[#1f1f1f]/50">
                      <!-- 角色 (源/目标) -->
                      <td class="p-3">
                        <span v-if="node.is_source" class="ant-tag ant-tag-blue font-medium">
                          源节点 (SRC)
                        </span>
                        <button v-else @click="setSource(node.id)" class="text-gray-400 hover:text-[#1677ff]">
                          设为源
                        </button>
                      </td>

                      <!-- 节点类型标签 (本地直连 / 远程穿透) -->
                      <td class="p-3">
                        <span v-if="node.is_local" class="ant-tag ant-tag-green">
                          本地直连 (免SSH)
                        </span>
                        <span v-else class="ant-tag ant-tag-gold">
                          远程 SSH 映射
                        </span>
                      </td>

                      <!-- 节点名 -->
                      <td class="p-3 font-medium text-white">{{ node.name }}</td>

                      <!-- 连接配置 -->
                      <td class="p-3 font-mono text-gray-300">
                        <div v-if="node.is_local" class="text-green-400">
                          127.0.0.1:{{ node.local_bind_port }}
                        </div>
                        <div v-else>
                          <div>{{ node.ssh_user }}@{{ node.ssh_host }}:{{ node.ssh_port }}</div>
                          <div class="text-gray-500 text-[11px]">本地端口: 127.0.0.1:{{ node.local_bind_port }}</div>
                        </div>
                      </td>

                      <!-- Cookie 统计与主动探测 -->
                      <td class="p-3">
                        <span class="font-bold text-amber-400 font-mono">{{ node.cookie_count || 0 }} 条</span>
                        <button @click="probeNode(node)" class="text-[11px] text-[#1677ff] hover:underline ml-2" title="探针探测此端口的 Cookie">
                          刷新
                        </button>
                      </td>

                      <!-- 状态 -->
                      <td class="p-3">
                        <span v-if="node.status === 'connected'" class="ant-tag ant-tag-green">
                          ● 在线
                        </span>
                        <span v-else-if="node.status === 'stopped'" class="ant-tag ant-tag-gold">
                          ○ 离线
                        </span>
                        <span v-else class="ant-tag ant-tag-red">
                          ✕ 异常
                        </span>
                      </td>

                      <!-- 最近同步时间 -->
                      <td class="p-3 text-gray-400">{{ node.last_sync || '---' }}</td>

                      <!-- 操作按钮 -->
                      <td class="p-3 text-right space-x-2">
                        <button 
                          @click="toggleTunnel(node)" 
                          class="ant-btn-default"
                        >
                          {{ node.is_local ? '测试连通' : (node.status === 'connected' ? '断开隧道' : '建立穿透') }}
                        </button>
                        <button @click="deleteNode(node.id)" class="px-2 py-1 bg-red-900/20 text-red-400 border border-red-900/50 rounded hover:bg-red-900/40">
                          删除
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <!-- 2. 同步调度面板 -->
          <div v-if="currentMenu === 'sync'" class="ant-card p-6 space-y-4">
            <h3 class="text-sm font-semibold text-white pb-3 border-b border-[#303030]">同步策略与状态</h3>
            <div class="text-sm text-gray-400 space-y-2">
              <p>• 定时调度周期：<span class="text-white font-mono">每 15 分钟</span> 自动触发一次</p>
              <p>• 同步模式：增量同步与全量 Cookie 注入双核自适应</p>
              <p>• 本地节点支持：本地节点提取与注入均以纳秒级零网络延迟完成</p>
            </div>
            <button @click="triggerSync" :disabled="isSyncing" class="ant-btn-primary">
              {{ isSyncing ? '正在同步...' : '立即手动同步一次' }}
            </button>
          </div>

          <!-- 3. 告警通知设置 (Email + Server酱) -->
          <div v-if="currentMenu === 'notifications'" class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="ant-card p-6 space-y-4">
              <div class="flex justify-between items-center pb-2 border-b border-[#303030]">
                <h3 class="text-sm font-semibold text-white">SMTP 邮件发信设置</h3>
                <button @click="testEmail" class="text-xs text-[#1677ff] hover:underline">发送测试</button>
              </div>
              <div class="space-y-3">
                <div>
                  <label class="block text-xs text-gray-400 mb-1">SMTP 主机</label>
                  <input v-model="notif.smtp_host" placeholder="smtp.qq.com" class="w-full ant-input">
                </div>
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-xs text-gray-400 mb-1">端口</label>
                    <input v-model="notif.smtp_port" placeholder="465" class="w-full ant-input">
                  </div>
                  <div>
                    <label class="block text-xs text-gray-400 mb-1">加密协议</label>
                    <select v-model="notif.smtp_ssl" class="w-full ant-input">
                      <option :value="true">SSL / TLS</option>
                      <option :value="false">STARTTLS / 明文</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">发信账号</label>
                  <input v-model="notif.smtp_user" placeholder="user@qq.com" class="w-full ant-input">
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">发信密码 / 授权码</label>
                  <input v-model="notif.smtp_pass" type="password" placeholder="授权码" class="w-full ant-input">
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">接收告警邮箱</label>
                  <input v-model="notif.smtp_to" placeholder="admin@domain.com" class="w-full ant-input">
                </div>
              </div>
              <button @click="saveNotif" class="ant-btn-primary w-full mt-2">保存邮件设置</button>
            </div>

            <div class="ant-card p-6 space-y-4">
              <div class="flex justify-between items-center pb-2 border-b border-[#303030]">
                <h3 class="text-sm font-semibold text-white">Server酱 (微信服务号通知)</h3>
                <button @click="testServerChan" class="text-xs text-[#1677ff] hover:underline">发送微信测试</button>
              </div>
              <div class="space-y-3">
                <div class="flex items-center gap-2">
                  <input type="checkbox" v-model="notif.serverchan_enabled" id="s_c_box" class="rounded bg-[#141414] border-gray-600 text-[#1677ff]">
                  <label for="s_c_box" class="text-xs text-gray-300">启用微信实时推送</label>
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">SendKey</label>
                  <input v-model="notif.serverchan_key" placeholder="SCTxxxxxxxxxxxxxxxx" class="w-full ant-input font-mono">
                  <p class="text-xs text-gray-500 mt-1">在 sct.ftqq.com 申请的 SendKey，发生异常时推送微信。</p>
                </div>
              </div>
              <button @click="saveNotif" class="ant-btn-primary w-full mt-2">保存 Server酱 配置</button>
            </div>
          </div>

          <!-- 4. 证书凭证管理 -->
          <div v-if="currentMenu === 'keys'" class="ant-card p-6 space-y-4">
            <div class="flex justify-between items-center pb-2 border-b border-[#303030]">
              <h3 class="text-sm font-semibold text-white">SSH 密钥存储库</h3>
              <span class="text-xs text-gray-500">{{ keys.length }} 个密钥</span>
            </div>
            <div>
              <input type="file" @change="uploadKey" class="text-xs text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-[#424242] file:bg-[#1f1f1f] file:text-gray-300">
            </div>
            <ul class="divide-y divide-[#303030] text-xs">
              <li v-for="k in keys" :key="k.filename" class="py-2.5 flex justify-between items-center">
                <span class="font-mono text-gray-300">🔑 {{ k.filename }} ({{ k.size }} Bytes)</span>
                <button @click="deleteKey(k.filename)" class="text-red-400 hover:underline">删除</button>
              </li>
              <li v-if="keys.length === 0" class="py-6 text-center text-gray-500">暂无证书凭证</li>
            </ul>
          </div>

          <!-- 5. 面板与安全设置 -->
          <div v-if="currentMenu === 'settings'" class="ant-card p-6 max-w-lg space-y-4">
            <h3 class="text-sm font-semibold text-white pb-2 border-b border-[#303030]">面板账号设置</h3>
            <form @submit.prevent="saveProfile" class="space-y-3.5">
              <div>
                <label class="block text-xs text-gray-400 mb-1">登录用户名</label>
                <input v-model="profile.username" required class="w-full ant-input">
              </div>
              <div>
                <label class="block text-xs text-gray-400 mb-1">管理员邮箱 (支持使用邮箱直接登入)</label>
                <input v-model="profile.email" type="email" required class="w-full ant-input">
              </div>
              <div>
                <label class="block text-xs text-gray-400 mb-1">重置密码 (留空则不修改)</label>
                <input v-model="profile.new_password" type="password" placeholder="至少 6 位安全字符" minlength="6" class="w-full ant-input">
              </div>
              <button type="submit" class="ant-btn-primary w-full mt-2">保存配置</button>
            </form>
          </div>

          <!-- 6. 运行日志 -->
          <div v-if="currentMenu === 'logs'" class="ant-card p-6 space-y-4">
            <h3 class="text-sm font-semibold text-white pb-2 border-b border-[#303030]">最近任务记录</h3>
            <div class="bg-[#0a0a0a] p-4 rounded border border-[#303030] font-mono text-xs h-96 overflow-y-auto space-y-3">
              <div v-for="l in logs" :key="l.id" class="border-b border-[#222222] pb-2">
                <div class="flex justify-between text-gray-400">
                  <span>[{{ l.timestamp }}]</span>
                  <span :class="l.status==='SUCCESS' ? 'text-green-500' : 'text-red-500'" class="font-bold">[{{ l.status }}]</span>
                </div>
                <pre class="mt-1 text-gray-300 whitespace-pre-wrap">{{ l.details }}</pre>
              </div>
              <div v-if="logs.length === 0" class="text-center text-gray-600 py-12">暂无任务日志</div>
            </div>
          </div>

        </main>
      </div>

      <!-- 添加节点 Modal (支持本地/远程模式切换) -->
      <div v-if="showNodeModal" class="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
        <div class="w-full max-w-lg ant-card p-6 bg-[#141414] border border-[#303030]">
          <div class="flex justify-between items-center pb-3 border-b border-[#303030] mb-4">
            <h3 class="text-sm font-semibold text-white">添加 CDP 实例节点</h3>
            <button @click="showNodeModal = false" class="text-gray-400 hover:text-white">✕</button>
          </div>

          <form @submit.prevent="createNode" class="space-y-4">
            <!-- 节点类型切换单选 -->
            <div>
              <label class="block text-xs text-gray-400 mb-2">节点接入类型</label>
              <div class="grid grid-cols-2 gap-3">
                <label 
                  :class="newNode.is_local ? 'border-[#1677ff] bg-[#1677ff]/10 text-white' : 'border-[#424242] text-gray-400'"
                  class="flex items-center justify-center gap-2 p-2.5 rounded border cursor-pointer text-xs"
                >
                  <input type="radio" v-model="newNode.is_local" :value="true" class="hidden">
                  <span>💻 本地直连节点 (免SSH)</span>
                </label>

                <label 
                  :class="!newNode.is_local ? 'border-[#1677ff] bg-[#1677ff]/10 text-white' : 'border-[#424242] text-gray-400'"
                  class="flex items-center justify-center gap-2 p-2.5 rounded border cursor-pointer text-xs"
                >
                  <input type="radio" v-model="newNode.is_local" :value="false" class="hidden">
                  <span>🌐 远程 SSH 节点</span>
                </label>
              </div>
            </div>

            <div>
              <label class="block text-xs text-gray-400 mb-1">节点标识名称</label>
              <input v-model="newNode.name" required placeholder="如: 本机 Chrome 01" class="w-full ant-input">
            </div>

            <!-- 本地节点专用输入：仅需本地 CDP 端口 -->
            <div v-if="newNode.is_local" class="p-3 bg-[#1f1f1f] rounded border border-[#303030]">
              <label class="block text-xs text-gray-400 mb-1">本地 CDP 调试端口 (默认 9222)</label>
              <input v-model="newNode.local_bind_port" type="number" required placeholder="9222" class="w-full ant-input font-mono text-green-400">
              <p class="text-[11px] text-gray-500 mt-1.5">
                直接连接宿主机/容器本地的 Chromium CDP 调试服务，无需配置任何 SSH 密钥或密码。
              </p>
            </div>

            <!-- 远程节点专属输入：完整 SSH 与端口映射 -->
            <div v-else class="space-y-3.5">
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs text-gray-400 mb-1">SSH 主机 / IP</label>
                  <input v-model="newNode.ssh_host" required placeholder="192.168.1.100" class="w-full ant-input font-mono">
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">SSH 端口</label>
                  <input v-model="newNode.ssh_port" type="number" placeholder="22" class="w-full ant-input font-mono">
                </div>
              </div>

              <div>
                <label class="block text-xs text-gray-400 mb-1">SSH 用户名</label>
                <input v-model="newNode.ssh_user" required placeholder="root" class="w-full ant-input font-mono">
              </div>

              <div>
                <label class="block text-xs text-gray-400 mb-1">绑定 SSH 证书 (选填)</label>
                <select v-model="newNode.ssh_key_filename" class="w-full ant-input font-mono">
                  <option value="">密码认证 (不使用私钥证书)</option>
                  <option v-for="k in keys" :key="k.filename" :value="k.filename">🔑 {{ k.filename }}</option>
                </select>
              </div>

              <div v-if="!newNode.ssh_key_filename">
                <label class="block text-xs text-gray-400 mb-1">SSH 密码</label>
                <input v-model="newNode.ssh_password" type="password" placeholder="••••••••" class="w-full ant-input">
              </div>

              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs text-gray-400 mb-1">远程 CDP 端口</label>
                  <input v-model="newNode.remote_cdp_port" type="number" placeholder="9222" class="w-full ant-input font-mono">
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">本地穿透绑定端口</label>
                  <input v-model="newNode.local_bind_port" type="number" required placeholder="19222" class="w-full ant-input font-mono text-[#1677ff]">
                </div>
              </div>
            </div>

            <div class="flex justify-end gap-2.5 pt-3 border-t border-[#303030]">
              <button type="button" @click="showNodeModal = false" class="ant-btn-default">取消</button>
              <button type="submit" class="ant-btn-primary">保存配置</button>
            </div>
          </form>
        </div>
      </div>

    </div>
  </div>
</template>