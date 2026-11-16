<template>
  <div class="layout">
    <SetupWizard v-if="setupRequired" @completed="onSetupDone" />

    <AuthGate v-else-if="!authed" :status="authStatus" @authenticated="onAuthed" />

    <template v-else>
      <header class="topbar">
        <div class="brand">
          <span>Chromium Sync SaaS</span>
          <span class="brand-sub">{{ user.role === 'admin' ? 'ADMIN 运营版' : '租户工作台' }}</span>
        </div>

        <nav class="nav">
          <button class="nav-btn" :class="{ active: tab === 'nodes' }" @click="tab = 'nodes'">我的节点与凭据</button>
          <button class="nav-btn" :class="{ active: tab === 'market' }" @click="tab = 'market'">共享交易市场</button>
          <button class="nav-btn" :class="{ active: tab === 'sync' }" @click="tab = 'sync'">同步 / 收藏 / 密钥</button>
          <button class="nav-btn" :class="{ active: tab === 'billing' }" @click="tab = 'billing'">套餐与钱包 (¥{{ user.balance_yuan }})</button>
          <button class="nav-btn" :class="{ active: tab === 'audit' }" @click="tab = 'audit'">审计日志</button>
          <button v-if="user.role === 'admin'" class="nav-btn" :class="{ active: tab === 'admin' }" @click="tab = 'admin'">运营管理台</button>
        </nav>

        <div class="row">
          <span class="tag tag-info">{{ user.username }} · {{ plan?.name || 'Starter' }}</span>
          <button class="btn btn-sm" @click="logout">退出登录</button>
        </div>
      </header>

      <main class="main">
        <MyNodesView
          v-if="tab === 'nodes'"
          :user="user"
          :quotas="quotas"
          :platform-fee-bps="authStatus.platform_fee_bps || 2000"
          @notify="showToast"
          @refresh-profile="refreshProfile"
        />
        <MarketView
          v-else-if="tab === 'market'"
          @notify="showToast"
          @refresh-profile="refreshProfile"
        />
        <SyncBookmarksView v-else-if="tab === 'sync'" @notify="showToast" />
        <BillingView v-else-if="tab === 'billing'" @notify="showToast" @refresh-profile="refreshProfile" />
        <AuditView v-else-if="tab === 'audit'" @notify="showToast" />
        <AdminView v-else-if="tab === 'admin' && user.role === 'admin'" @notify="showToast" />
      </main>
    </template>

    <div v-if="toastMsg" class="toast">{{ toastMsg }}</div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { apiFetch } from './api'
import AdminView from './components/AdminView.vue'
import AuditView from './components/AuditView.vue'
import AuthGate from './components/AuthGate.vue'
import BillingView from './components/BillingView.vue'
import MarketView from './components/MarketView.vue'
import MyNodesView from './components/MyNodesView.vue'
import SetupWizard from './components/SetupWizard.vue'
import SyncBookmarksView from './components/SyncBookmarksView.vue'

const setupRequired = ref(false)
const authed = ref(false)
const authStatus = ref({})
const user = ref({})
const plan = ref(null)
const quotas = ref({})
const tab = ref('nodes')
const toastMsg = ref('')
let toastTimer = null

function showToast(msg) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMsg.value = ''
  }, 3600)
}

async function refreshProfile() {
  try {
    const res = await apiFetch('/api/billing/overview')
    user.value = res.user || {}
    plan.value = res.plan || null
    quotas.value = res.quotas || {}
  } catch {
    // ignore
  }
}

async function boot() {
  try {
    const st = await apiFetch('/api/auth/status')
    authStatus.value = st
    setupRequired.value = Boolean(st.setup_required)
    if (setupRequired.value) return
    if (localStorage.getItem('saas_token')) {
      const prof = await apiFetch('/api/billing/overview')
      user.value = prof.user || {}
      plan.value = prof.plan || null
      quotas.value = prof.quotas || {}
      authed.value = true
    }
  } catch {
    authed.value = false
  }
}

async function onSetupDone(res) {
  setupRequired.value = false
  user.value = res.user || {}
  authed.value = true
  await refreshProfile()
}

async function onAuthed(res) {
  user.value = res.user || {}
  plan.value = res.plan || null
  authed.value = true
  await refreshProfile()
}

function logout() {
  localStorage.removeItem('saas_token')
  authed.value = false
  user.value = {}
}

onMounted(boot)
</script>
