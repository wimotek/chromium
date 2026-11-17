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
          <button class="nav-btn" :class="{ active: tab === 'sync' }" @click="tab = 'sync'">Cookie 同步</button>
          <button class="nav-btn" :class="{ active: tab === 'billing' }" @click="tab = 'billing'">套餐与钱包 (¥{{ user.balance_yuan }})</button>
          <button class="nav-btn" :class="{ active: tab === 'audit' }" @click="tab = 'audit'">审计日志</button>
          <button v-if="user.role === 'admin'" class="nav-btn" :class="{ active: tab === 'admin' }" @click="tab = 'admin'">运营管理台</button>
        </nav>

        <div class="row">
          <span v-if="level" class="tag" :style="{ color: level.badge_color, borderColor: level.badge_color }">{{ level.name }}</span>
          <span class="tag tag-info">{{ user.username }} · {{ plan?.name || 'Starter' }}</span>
          <button class="btn btn-sm" @click="logout">退出登录</button>
        </div>
      </header>

      <main class="main">
        <MyNodesView
          v-if="tab === 'nodes'"
          :user="user"
          :quotas="quotas"
          :platform-fee-bps="authStatus.platform_fee_bps || 2500"
          :channel-fees="channelFees"
          :user-level="level"
          @notify="showToast"
          @refresh-profile="refreshProfile"
        />
        <MarketView
          v-else-if="tab === 'market'"
          @notify="showToast"
          @refresh-profile="refreshProfile"
        />
        <SyncPolicyView v-else-if="tab === 'sync'" @notify="showToast" />
        <BillingView v-else-if="tab === 'billing'" @notify="showToast" @refresh-profile="refreshProfile" />
        <AuditView v-else-if="tab === 'audit'" @notify="showToast" />
        <AdminView v-else-if="tab === 'admin' && user.role === 'admin'" @notify="showToast" />
      </main>
    </template>

    <div v-if="toastMsg" class="toast">{{ toastMsg }}</div>
  </div>
</template>

<script setup>
import { defineAsyncComponent, onMounted, ref } from 'vue'
import { apiFetch } from './api'
import AuthGate from './components/AuthGate.vue'
import SetupWizard from './components/SetupWizard.vue'

const MyNodesView = defineAsyncComponent(() => import('./components/MyNodesView.vue'))
const MarketView = defineAsyncComponent(() => import('./components/MarketView.vue'))
const SyncPolicyView = defineAsyncComponent(() => import('./components/SyncPolicyView.vue'))
const BillingView = defineAsyncComponent(() => import('./components/BillingView.vue'))
const AuditView = defineAsyncComponent(() => import('./components/AuditView.vue'))
const AdminView = defineAsyncComponent(() => import('./components/AdminView.vue'))

const setupRequired = ref(false)
const authed = ref(false)
const authStatus = ref({})
const user = ref({})
const plan = ref(null)
const level = ref(null)
const channelFees = ref({ reverse: 2500, public_wss: 1000 })
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
    level.value = res.level || null
    if (res.channel_fees) channelFees.value = res.channel_fees
    quotas.value = res.quotas || {}
  } catch {
    // ignore
  }
}

async function boot() {
  try {
    const st = await apiFetch('/api/auth/status')
    authStatus.value = st
    if (st.channel_fees) channelFees.value = st.channel_fees
    setupRequired.value = Boolean(st.setup_required)
    if (setupRequired.value) return
    if (localStorage.getItem('saas_token')) {
      const prof = await apiFetch('/api/billing/overview')
      user.value = prof.user || {}
      plan.value = prof.plan || null
      level.value = prof.level || null
      if (prof.channel_fees) channelFees.value = prof.channel_fees
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
  level.value = res.level || null
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
