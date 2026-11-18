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

        <nav class="nav desktop-nav">
          <button class="nav-btn" :class="{ active: tab === 'nodes' }" @click="selectTab('nodes')">我的节点与凭据</button>
          <button class="nav-btn" :class="{ active: tab === 'market' }" @click="selectTab('market')">共享交易市场</button>
          <button class="nav-btn" :class="{ active: tab === 'sync' }" @click="selectTab('sync')">Cookie 同步</button>
          <button class="nav-btn" :class="{ active: tab === 'billing' }" @click="selectTab('billing')">
            套餐与钱包 (<span class="mono">¥{{ user.balance_yuan || '0.00' }}</span>)
          </button>
          <button class="nav-btn" :class="{ active: tab === 'referrals' }" @click="selectTab('referrals')">推广邀请</button>
          <button class="nav-btn" :class="{ active: tab === 'audit' }" @click="selectTab('audit')">审计日志</button>
          <button v-if="user.role === 'admin'" class="nav-btn" :class="{ active: tab === 'admin' }" @click="selectTab('admin')">运营管理台</button>
        </nav>

        <div class="topbar-right">
          <div class="row topbar-user-meta" style="gap: 8px">
            <span v-if="level" class="tag" :style="{ color: level.badge_color, borderColor: level.badge_color }">{{ level.name }}</span>
            <span class="tag tag-info">{{ user.username }} · {{ plan?.name || 'Starter' }}</span>
          </div>
          <button
            class="btn btn-sm mobile-menu-btn"
            :aria-expanded="mobileMenuOpen"
            title="窄屏 / 移动端页面切换菜单"
            @click="mobileMenuOpen = !mobileMenuOpen"
          >
            {{ mobileMenuOpen ? '收起菜单' : '导航菜单' }}
          </button>
          <button class="btn btn-sm" @click="logout">退出</button>
        </div>
      </header>

      <div v-if="mobileMenuOpen" class="mobile-nav-drawer">
        <div class="row" style="padding: 4px 2px 8px; border-bottom: 1px solid var(--border); margin-bottom: 4px">
          <span v-if="level" class="tag" :style="{ color: level.badge_color, borderColor: level.badge_color }">{{ level.name }}</span>
          <span class="tag tag-info">{{ user.username }} · {{ plan?.name || 'Starter' }}</span>
        </div>
        <button class="nav-btn" :class="{ active: tab === 'nodes' }" @click="selectTab('nodes')">我的节点与凭据</button>
        <button class="nav-btn" :class="{ active: tab === 'market' }" @click="selectTab('market')">共享交易市场</button>
        <button class="nav-btn" :class="{ active: tab === 'sync' }" @click="selectTab('sync')">Cookie 同步</button>
        <button class="nav-btn" :class="{ active: tab === 'billing' }" @click="selectTab('billing')">
          套餐与钱包 (¥{{ user.balance_yuan || '0.00' }})
        </button>
        <button class="nav-btn" :class="{ active: tab === 'referrals' }" @click="selectTab('referrals')">推广邀请</button>
        <button class="nav-btn" :class="{ active: tab === 'audit' }" @click="selectTab('audit')">审计日志</button>
        <button v-if="user.role === 'admin'" class="nav-btn" :class="{ active: tab === 'admin' }" @click="selectTab('admin')">运营管理台</button>
      </div>

      <AnnouncementBanner />

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
        <ReferralView v-else-if="tab === 'referrals'" @notify="showToast" />
        <AuditView v-else-if="tab === 'audit'" @notify="showToast" />
        <AdminView v-else-if="tab === 'admin' && user.role === 'admin'" :current-user-id="user.id" @notify="showToast" />
      </main>
    </template>

    <div v-if="toastMsg" class="toast">{{ toastMsg }}</div>
  </div>
</template>

<script setup>
import { defineAsyncComponent, onMounted, ref } from 'vue'
import { apiFetch } from './api'
import AnnouncementBanner from './modules/announcements/AnnouncementBanner.vue'
import AuthGate from './modules/users/AuthGate.vue'
import SetupWizard from './modules/system/SetupWizard.vue'

const MyNodesView = defineAsyncComponent(() => import('./modules/nodes/MyNodesView.vue'))
const MarketView = defineAsyncComponent(() => import('./modules/market/MarketView.vue'))
const SyncPolicyView = defineAsyncComponent(() => import('./modules/sync/SyncPolicyView.vue'))
const BillingView = defineAsyncComponent(() => import('./modules/billing/BillingView.vue'))
const ReferralView = defineAsyncComponent(() => import('./modules/users/ReferralView.vue'))
const AuditView = defineAsyncComponent(() => import('./modules/audit/AuditView.vue'))
const AdminView = defineAsyncComponent(() => import('./modules/system/AdminView.vue'))

const setupRequired = ref(false)
const authed = ref(false)
const authStatus = ref({})
const user = ref({})
const plan = ref(null)
const level = ref(null)
const channelFees = ref({ reverse: 2500, public_wss: 1000 })
const quotas = ref({})
const tab = ref('nodes')
const mobileMenuOpen = ref(false)
const toastMsg = ref('')
let toastTimer = null

function selectTab(nextTab) {
  tab.value = nextTab
  mobileMenuOpen.value = false
}

function showToast(msg) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMsg.value = ''
  }, 3600)
}

async function refreshProfile(updatedUser = null) {
  if (updatedUser && typeof updatedUser === 'object') {
    user.value = { ...user.value, ...updatedUser }
  }
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
  user.value = res.user || {}
  plan.value = res.plan || null
  level.value = res.level || null
  setupRequired.value = false
  authed.value = true
  try {
    const st = await apiFetch('/api/auth/status')
    authStatus.value = st
    if (st.channel_fees) channelFees.value = st.channel_fees
  } catch {
    // ignore
  }
  await refreshProfile()
  showToast('SaaS 平台初始化完成，欢迎进入控制台')
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
  mobileMenuOpen.value = false
  user.value = {}
}

onMounted(boot)
</script>
