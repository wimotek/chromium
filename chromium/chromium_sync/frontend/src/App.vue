<script setup>
import { ref, reactive, onMounted } from 'vue'

const token = ref(localStorage.getItem('token') || '')
const captchaSvg = ref('')
const nodes = ref([])
const keys = ref([])
const logs = ref([])
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
    alert(data.detail || '验证失败')
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
  const res = await api('/api/sync/trigger', { method: 'POST' })
  const data = await res.json()
  alert(data.message)
  loadAll()
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
  if (confirm('确认删除该节点配置？')) {
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
  if (confirm(`删除证书 ${name}?`)) {
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
    alert('密码修改成功，请重新登录')
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
  <div class="min-h-screen flex flex-col bg-[#0b0f17]">
    <!-- 1. 登录面板 (集成 SVG 算术验证码与防爆破) -->
    <div v-if="!token" class="flex-1 flex items-center justify-center p-6">
      <div class="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-8 w-full max-w-md">
        <h1 class="text-2xl font-bold tracking-wider text-cyan-400 text-center mb-6">CDP SYNC HUB</h1>
        <form @submit.prevent="login" class="flex flex-col items-center space-y-5">
          <input 
            type="password" 
            v-model="loginForm.password" 
            required 
            placeholder="管理员密码"
            class="adaptive-input px-4 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-cyan-500"
          >
          <div class="adaptive-input flex items-center gap-3">
            <input 
              type="text" 
              v-model="loginForm.captcha_answer" 
              required 
              placeholder="计算结果"
              class="w-1/2 px-4 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-cyan-500"
            >
            <div @click="refreshCaptcha" class="cursor-pointer" title="点击刷新" v-html="captchaSvg"></div>
          </div>
          <button type="submit" class="adaptive-input py-2.5 bg-cyan-600 hover:bg-cyan-500 font-medium rounded-lg text-white transition shadow-lg shadow-cyan-600/30">
            登入控制台
          </button>
        </form>
      </div>
    </div>

    <!-- 2. 控制台主面板 -->
    <div v-else class="flex-1 flex flex-col">
      <header class="h-16 border-b border-slate-800 bg-slate-900/60 backdrop-blur px-8 flex items-center justify-between">
        <span class="font-bold text-lg text-cyan-400">CDP Cookie 同步集群</span>
        <div class="flex items-center gap-4">
          <button @click="triggerSync" class="px-4 py-1.5 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-sm text-white font-medium">⚡ 立即同步</button>
          <button @click="showPwdModal = true" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs">修改密码</button>
          <button @click="logout" class="px-3 py-1.5 bg-red-950/40 hover:bg-red-900/60 text-red-400 rounded-lg text-xs">登出</button>
        </div>
      </header>

      <main class="flex-1 p-8 max-w-7xl mx-auto w-full space-y-8">
        <!-- 节点管理 -->
        <section class="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <div class="flex justify-between items-center mb-6">
            <h2 class="text-lg font-semibold text-slate-100">CDP 映射节点</h2>
            <button @click="showNodeModal = true" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-cyan-400 rounded-lg text-sm border border-cyan-500/30">+ 新建节点</button>
          </div>
          <table class="w-full text-left text-sm text-slate-300">
            <thead class="text-xs uppercase bg-slate-800/50 text-slate-400">
              <tr>
                <th class="p-3">身份</th>
                <th class="p-3">节点名</th>
                <th class="p-3">SSH 连接凭证</th>
                <th class="p-3">本地转发端口</th>
                <th class="p-3">状态</th>
                <th class="p-3">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800">
              <tr v-for="node in nodes" :key="node.id" class="hover:bg-slate-800/30">
                <td class="p-3">
                  <span v-if="node.is_source" class="px-2 py-0.5 text-xs bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 rounded">源 (Source)</span>
                  <button v-else @click="setSource(node.id)" class="text-xs text-slate-500 hover:text-cyan-400">设为源</button>
                </td>
                <td class="p-3 font-medium text-white">{{ node.name }}</td>
                <td class="p-3 font-mono text-xs">
                  <div>{{ node.ssh_user }}@{{ node.ssh_host }}:{{ node.ssh_port }}</div>
                  <!-- 区分证书与密码：清晰标注该节点选择绑定的证书文件名 -->
                  <span v-if="node.ssh_key_filename" class="inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] bg-cyan-950/70 text-cyan-400 border border-cyan-800">
                    🔑 {{ node.ssh_key_filename }}
                  </span>
                  <span v-else class="inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-400">
                    🔒 密码认证
                  </span>
                </td>
                <td class="p-3 font-mono text-cyan-300">127.0.0.1:{{ node.local_bind_port }}</td>
                <td class="p-3">
                  <span :class="{'text-green-400': node.status==='connected', 'text-yellow-400': node.status==='stopped', 'text-red-400': node.status.startsWith('error')}" class="text-xs font-mono">
                    ● {{ node.status }}
                  </span>
                </td>
                <td class="p-3 flex gap-2">
                  <button @click="toggleTunnel(node.id)" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded text-xs">
                    {{ node.status === 'connected' ? '断开' : '启动穿透' }}
                  </button>
                  <button @click="deleteNode(node.id)" class="px-2 py-1 bg-red-950/40 text-red-400 hover:bg-red-900/60 rounded text-xs">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- 证书库与同步日志 -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
          <section class="bg-slate-900 border border-slate-800 rounded-xl p-6">
            <h2 class="text-lg font-semibold text-slate-100 mb-4">SSH 密钥/证书管理</h2>
            <input type="file" @change="uploadKey" class="text-xs text-slate-400 mb-4 file:mr-4 file:py-1.5 file:px-3 file:rounded file:bg-slate-800 file:border-0 file:text-cyan-400 hover:file:bg-slate-700">
            <ul class="divide-y divide-slate-800 text-sm">
              <li v-for="k in keys" :key="k.filename" class="py-2.5 flex justify-between items-center">
                <span class="font-mono text-xs">{{ k.filename }} ({{ k.size }}B)</span>
                <button @click="deleteKey(k.filename)" class="text-red-400 text-xs hover:underline">删除</button>
              </li>
            </ul>
          </section>

          <section class="bg-slate-900 border border-slate-800 rounded-xl p-6">
            <h2 class="text-lg font-semibold text-slate-100 mb-4">任务日志</h2>
            <div class="bg-slate-950 p-4 rounded-lg font-mono text-xs h-48 overflow-y-auto space-y-2 border border-slate-800">
              <div v-for="l in logs" :key="l.id">
                <span class="text-slate-500">[{{ l.timestamp }}]</span>
                <span :class="l.status==='SUCCESS'?'text-green-400':'text-red-400'"> [{{ l.status }}]</span>
                <pre class="mt-0.5 text-slate-400 whitespace-pre-wrap">{{ l.details }}</pre>
              </div>
            </div>
          </section>
        </div>
      </main>

      <!-- 新增节点弹窗 (输入框 70% 宽度自适应约束与证书选择下拉菜单) -->
      <div v-if="showNodeModal" class="fixed inset-0 bg-black/70 flex items-center justify-center p-4">
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-6 w-full max-w-xl">
          <h3 class="text-lg font-bold mb-4 text-center">添加 CDP 节点</h3>
          <form @submit.prevent="createNode" class="flex flex-col items-center space-y-3">
            <input v-model="newNode.name" required placeholder="节点名称" class="adaptive-input p-2.5 bg-slate-800 border border-slate-700 rounded text-sm">
            <input v-model="newNode.ssh_host" required placeholder="SSH Host" class="adaptive-input p-2.5 bg-slate-800 border border-slate-700 rounded text-sm">
            <input v-model="newNode.ssh_port" type="number" placeholder="SSH Port (默认 22)" class="adaptive-input p-2.5 bg-slate-800 border border-slate-700 rounded text-sm">
            <input v-model="newNode.ssh_user" required placeholder="SSH 用户名" class="adaptive-input p-2.5 bg-slate-800 border border-slate-700 rounded text-sm">
            
            <!-- 证书选择下拉框：多台主机可随意复用选同一个证书 -->
            <select v-model="newNode.ssh_key_filename" class="adaptive-input p-2.5 bg-slate-800 border border-slate-700 rounded text-sm">
              <option value="">使用账号密码认证（不使用证书）</option>
              <option v-for="k in keys" :key="k.filename" :value="k.filename">{{ k.filename }}</option>
            </select>

            <input v-if="!newNode.ssh_key_filename" v-model="newNode.ssh_password" type="password" placeholder="SSH 密码" class="adaptive-input p-2.5 bg-slate-800 border border-slate-700 rounded text-sm">
            <input v-model="newNode.remote_cdp_port" type="number" placeholder="远程 CDP 端口 (默认 9222)" class="adaptive-input p-2.5 bg-slate-800 border border-slate-700 rounded text-sm">
            <input v-model="newNode.local_bind_port" type="number" required placeholder="本地隧道绑定端口 (如 19222)" class="adaptive-input p-2.5 bg-slate-800 border border-slate-700 rounded text-sm">
            
            <div class="flex gap-4 pt-3">
              <button type="submit" class="px-5 py-2 bg-cyan-600 rounded text-sm">确认保存</button>
              <button type="button" @click="showNodeModal = false" class="px-4 py-2 bg-slate-800 rounded text-sm">取消</button>
            </div>
          </form>
        </div>
      </div>

      <!-- 修改密码弹窗 -->
      <div v-if="showPwdModal" class="fixed inset-0 bg-black/70 flex items-center justify-center p-4">
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-6 w-full max-w-md">
          <h3 class="text-lg font-bold mb-4 text-center">重置管理员密码</h3>
          <form @submit.prevent="changePassword" class="flex flex-col items-center space-y-4">
            <input v-model="newPassword" type="password" required minlength="6" placeholder="输入新密码 (至少6位)" class="adaptive-input p-2.5 bg-slate-800 border border-slate-700 rounded text-sm">
            <div class="flex gap-4">
              <button type="submit" class="px-5 py-2 bg-cyan-600 rounded text-sm">提交更改</button>
              <button type="button" @click="showPwdModal = false" class="px-4 py-2 bg-slate-800 rounded text-sm">取消</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>
</template>