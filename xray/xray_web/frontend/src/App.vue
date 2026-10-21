<template>
  <div class="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
    <!-- 登录视图 -->
    <div v-if="!token" class="flex-1 flex items-center justify-center p-4">
      <div class="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
        <div class="text-center mb-8">
          <div class="inline-flex w-14 h-14 rounded-2xl bg-gradient-to-tr from-emerald-500 to-cyan-500 items-center justify-center text-3xl shadow-lg shadow-emerald-500/20 mb-3">⚡</div>
          <h1 class="text-xl font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">Xray REALITY 控制台</h1>
          <p class="text-xs text-slate-400 mt-1">现代化多用户管理后台</p>
        </div>
        <form @submit.prevent="handleLogin" class="space-y-4">
          <div>
            <label class="block text-xs font-medium text-slate-300 mb-1.5">管理员密码</label>
            <input v-model="password" type="password" required placeholder="请输入管理密码" 
                   class="w-full px-4 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </div>
          <div v-if="loginError" class="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-xs text-center">
            {{ loginError }}
          </div>
          <button type="submit" :disabled="loading" 
                  class="w-full py-2.5 bg-emerald-500 hover:bg-emerald-600 font-semibold rounded-xl text-sm text-white shadow-lg shadow-emerald-500/20 transition disabled:opacity-50">
            {{ loading ? '验证中...' : '进入控制台' }}
          </button>
        </form>
      </div>
    </div>

    <!-- 主控台视图 -->
    <div v-else class="flex-1 flex flex-col">
      <header class="border-b border-slate-800 bg-slate-900/50 backdrop-blur sticky top-0 z-30">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div class="flex items-center space-x-3">
            <span class="text-2xl">⚡</span>
            <span class="font-bold text-lg bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">Xray Pro Panel</span>
            <span class="px-2 py-0.5 text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full font-mono">{{ status.version || 'v25.x' }}</span>
          </div>
          <div class="flex items-center space-x-3">
            <button @click="fetchData" class="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition">🔄 刷新</button>
            <button @click="handleLogout" class="px-3 py-1.5 text-xs bg-slate-800 hover:bg-red-500/20 hover:text-red-400 border border-slate-700 rounded-lg transition">退出</button>
          </div>
        </div>
      </header>

      <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full space-y-6 flex-1">
        <!-- 概览指标卡片 -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div class="text-xs text-slate-400 font-medium">服务端 IP : 端口</div>
            <div class="mt-2 text-lg font-bold font-mono text-emerald-400">{{ status.ip }}:{{ status.port }}</div>
            <div class="mt-1 text-xs text-slate-500 flex items-center">
              <span class="w-2 h-2 rounded-full bg-emerald-500 mr-1.5 animate-pulse"></span> 核心运行正常
            </div>
          </div>
          <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div class="text-xs text-slate-400 font-medium">伪装域名 (SNI)</div>
            <div class="mt-2 text-sm font-bold font-mono text-cyan-300 truncate">{{ status.sni }}</div>
            <div class="mt-1 text-xs text-slate-500">流控: xtls-rprx-vision</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div class="text-xs text-slate-400 font-medium">活动用户数</div>
            <div class="mt-2 text-2xl font-black text-white">{{ users.length }}</div>
            <div class="mt-1 text-xs text-slate-500">REALITY 多端独立 UUID</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div class="text-xs text-slate-400 font-medium">ShortId</div>
            <div class="mt-2 text-sm font-mono text-purple-300 truncate">{{ status.shortId }}</div>
            <div class="mt-1 text-xs text-slate-500">uTLS: Chrome 伪装</div>
          </div>
        </div>

        <!-- 公钥卡片 -->
        <div class="bg-slate-900/60 border border-slate-800 rounded-xl p-4 text-xs font-mono flex flex-wrap justify-between items-center gap-2">
          <span class="text-slate-400">REALITY Public Key: <strong class="text-slate-200 select-all">{{ status.publicKey }}</strong></span>
          <button @click="copyText(status.publicKey)" class="text-emerald-400 hover:underline">复制公钥</button>
        </div>

        <!-- 用户管理列表 -->
        <div class="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
          <div class="p-5 border-b border-slate-800 flex justify-between items-center">
            <div>
              <h2 class="text-base font-bold text-white">用户配置列表</h2>
              <p class="text-xs text-slate-400">管理每个连接凭据独立的 VLESS 导入配置</p>
            </div>
            <button @click="showAddModal = true" class="px-3.5 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold rounded-xl shadow-lg shadow-emerald-500/20 transition">
              + 添加用户
            </button>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="bg-slate-950/60 text-slate-400 text-xs uppercase border-b border-slate-800">
                <tr>
                  <th class="py-3 px-6">备注名</th>
                  <th class="py-3 px-6">UUID</th>
                  <th class="py-3 px-6">流控</th>
                  <th class="py-3 px-6 text-right">操作</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-800">
                <tr v-for="user in users" :key="user.id" class="hover:bg-slate-800/40 transition">
                  <td class="py-3.5 px-6 font-medium text-white flex items-center space-x-2">
                    <span class="w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center font-bold text-xs">
                      {{ (user.email || 'U')[0].toUpperCase() }}
                    </span>
                    <span>{{ user.email || '未命名' }}</span>
                  </td>
                  <td class="py-3.5 px-6 font-mono text-xs text-slate-300">{{ user.id }}</td>
                  <td class="py-3.5 px-6">
                    <span class="px-2 py-0.5 text-xs font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded">
                      {{ user.flow || 'xtls-rprx-vision' }}
                    </span>
                  </td>
                  <td class="py-3.5 px-6 text-right space-x-2">
                    <button @click="copyVless(user)" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 rounded-lg border border-slate-700 transition">复制链接</button>
                    <button @click="openQr(user)" class="px-2.5 py-1 bg-cyan-500/10 hover:bg-cyan-500/20 text-xs text-cyan-300 rounded-lg border border-cyan-500/30 transition">二维码</button>
                    <button @click="deleteUser(user.id)" class="px-2.5 py-1 bg-red-500/10 hover:bg-red-500/20 text-xs text-red-400 rounded-lg border border-red-500/30 transition">删除</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </main>

      <!-- 添加用户 Modal -->
      <div v-if="showAddModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
        <div class="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 space-y-4 shadow-2xl">
          <h3 class="text-base font-bold text-white">添加新用户</h3>
          <div class="space-y-3">
            <div>
              <label class="block text-xs text-slate-300 mb-1">用户备注</label>
              <input v-model="newUser.email" type="text" placeholder="如: iPhone, PC, Friend" 
                     class="w-full px-3.5 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div>
              <label class="block text-xs text-slate-300 mb-1">自定义 UUID (留空自动生成)</label>
              <input v-model="newUser.id" type="text" placeholder="留空自动分配高强度 UUID" 
                     class="w-full px-3.5 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
          </div>
          <div class="flex justify-end space-x-2 pt-2">
            <button @click="showAddModal = false" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs">取消</button>
            <button @click="addUser" class="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-xs font-semibold">确认添加</button>
          </div>
        </div>
      </div>

      <!-- 二维码 Modal -->
      <div v-if="qrModal.show" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
        <div class="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-sm p-6 text-center space-y-4 shadow-2xl">
          <h3 class="text-base font-bold text-white">{{ qrModal.title }} 客户端导入</h3>
          <div class="p-3 bg-white rounded-xl inline-block shadow-inner">
            <img :src="qrModal.imgUrl" class="w-52 h-52 mx-auto" />
          </div>
          <p class="text-xs text-slate-400">支持 Shadowrocket、v2rayNG、Sing-box 扫码导入</p>
          <button @click="qrModal.show = false" class="w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-medium">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import QRCode from 'qrcode'
import axios from 'axios'

const token = ref(localStorage.getItem('xray_token') || '')
const password = ref('')
const loading = ref(false)
const loginError = ref('')
const status = ref({})
const users = ref([])
const showAddModal = ref(false)
const newUser = ref({ email: '', id: '' })
const qrModal = ref({ show: false, title: '', imgUrl: '' })

const api = axios.create({ baseURL: '/api' })
api.interceptors.request.use(config => {
  if (token.value) config.headers.Authorization = token.value
  return config
})
api.interceptors.response.use(res => res, err => {
  if (err.response?.status === 401) handleLogout()
  return Promise.reject(err)
})

async function handleLogin() {
  loading.value = true
  loginError.value = ''
  try {
    const res = await api.post('/login', { password: password.value })
    token.value = res.data.token
    localStorage.setItem('xray_token', token.value)
    await fetchData()
  } catch (e) {
    loginError.value = '密码错误'
  } finally {
    loading.value = false
  }
}

function handleLogout() {
  token.value = ''
  localStorage.removeItem('xray_token')
}

async function fetchData() {
  try {
    const res = await api.get('/status')
    status.value = res.data.meta
    users.value = res.data.users
  } catch (e) {}
}

function getVlessUrl(user) {
  const m = status.value
  return `vless://${user.id}@${m.ip}:${m.port}?security=reality&encryption=none&pbk=${m.publicKey}&headerType=none&fp=chrome&type=tcp&flow=xtls-rprx-vision&sni=${m.sni}&sid=${m.shortId}#${encodeURIComponent(user.email || 'Xray')}`
}

function copyVless(user) {
  navigator.clipboard.writeText(getVlessUrl(user))
  alert('VLESS 链接已复制！')
}

function copyText(txt) {
  navigator.clipboard.writeText(txt)
  alert('已复制！')
}

async function openQr(user) {
  const url = getVlessUrl(user)
  qrModal.value = {
    show: true,
    title: user.email || '节点',
    imgUrl: await QRCode.toDataURL(url, { width: 280, margin: 1 })
  }
}

async function addUser() {
  await api.post('/users/add', newUser.value)
  newUser.value = { email: '', id: '' }
  showAddModal.value = false
  await fetchData()
}

async function deleteUser(id) {
  if (!confirm('确认删除？')) return
  await api.post('/users/delete', { id })
  await fetchData()
}

onMounted(() => {
  if (token.value) fetchData()
})
</script>