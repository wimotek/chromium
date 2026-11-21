<template>
  <div class="layout">
    <SetupWizard v-if="setupRequired" @completed="onSetupDone" />

    <div v-else-if="authBooting" class="auth-wrap">
      <div class="card auth-card" style="text-align: center; padding: 36px 24px">
        <h2 style="margin: 0 0 8px">Chromium Sync SaaS</h2>
        <div class="muted" style="font-size: 13px">正在验证登录会话与节点环境，请稍候...</div>
      </div>
    </div>

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
          @go-market="selectTab('market')"
        />
        <MarketView
          v-else-if="tab === 'market'"
          :quotas="quotas"
          @notify="showToast"
          @refresh-profile="refreshProfile"
          @go-my-nodes="selectTab('nodes')"
        />
        <SyncPolicyView v-else-if="tab === 'sync'" @notify="showToast" />
        <BillingView
          v-else-if="tab === 'billing'"
          :return-order-no="billingReturnOrderNo"
          @return-order-handled="billingReturnOrderNo = ''"
          @notify="showToast"
          @refresh-profile="refreshProfile"
        />
        <ReferralView v-else-if="tab === 'referrals'" @notify="showToast" />
        <AuditView v-else-if="tab === 'audit'" @notify="showToast" />
        <AdminView v-else-if="tab === 'admin' && user.role === 'admin'" :current-user-id="user.id" @notify="showToast" />
      </main>
    </template>

    <div
      v-if="toastMsg"
      :key="toastKey"
      class="toast"
      :class="`toast-${toastType}`"
      role="status"
      aria-live="polite"
    >
      <span class="toast-icon">{{ toastType === 'error' ? '!' : toastType === 'ok' ? '✓' : 'i' }}</span>
      <span>{{ toastMsg }}</span>
      <button type="button" class="toast-close" aria-label="关闭提示" @click="toastMsg = ''">×</button>
    </div>
  </div>
</template>

<script setup>
import { defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue'
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
const authBooting = ref(true)
const authed = ref(false)
const authStatus = ref({})
const user = ref({})
const plan = ref(null)
const level = ref(null)
const channelFees = ref({ reverse: 2500, public_wss: 1000 })
const quotas = ref({})
const VALID_TABS = new Set(['nodes', 'market', 'sync', 'billing', 'referrals', 'audit', 'admin'])

function resolveInitialNavigation() {
  if (typeof window === 'undefined') {
    return { initialTab: 'nodes', returnOrderNo: '', cleanUrl: false }
  }
  const params = new URLSearchParams(window.location.search || '')
  const reqTab = String(params.get('tab') || '').trim().toLowerCase()
  const outTradeNo = String(params.get('out_trade_no') || '').trim()
  const method = String(params.get('method') || '').trim().toLowerCase()
  const hasAlipayReturn = Boolean(
    outTradeNo || params.get('trade_no') || method.includes('alipay.trade.page.pay.return'),
  )
  let initialTab = VALID_TABS.has(reqTab) ? reqTab : 'nodes'
  if (hasAlipayReturn) {
    initialTab = 'billing'
  }
  return {
    initialTab,
    returnOrderNo: outTradeNo,
    cleanUrl: hasAlipayReturn,
  }
}

const _initNav = resolveInitialNavigation()
const tab = ref(_initNav.initialTab)
const billingReturnOrderNo = ref(_initNav.returnOrderNo)
const mobileMenuOpen = ref(false)
const toastMsg = ref('')
const toastType = ref('ok')
const toastKey = ref(0)
let toastTimer = null

function syncTabToUrl(nextTab) {
  if (typeof window === 'undefined' || !window.history?.replaceState) return
  try {
    const url = new URL(window.location.href)
    if (nextTab === 'nodes') {
      url.searchParams.delete('tab')
    } else {
      url.searchParams.set('tab', nextTab)
    }
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {
    // ignore
  }
}

function selectTab(nextTab) {
  tab.value = nextTab
  mobileMenuOpen.value = false
  syncTabToUrl(nextTab)
}

function inferToastType(text) {
  const s = String(text || '')
  if (/(失败|错误|异常|超时|无权|不能|不可|不存在|未配置|不足|拦截|拒绝|无效|HTTP\s*[45]\d\d|422|500|502|403|404)/i.test(s)) {
    return 'error'
  }
  if (/(已保存|已更新|成功|完成|已复制|已启用|已停用|已创建|已删除|已移除|已取消|已清空|已刷新|已到账|已入账|已生效|已重置|已切换|已加载|已读取|已导出)/.test(s)) {
    return 'ok'
  }
  return 'info'
}

function showToast(payload, explicitType = '') {
  const msg = typeof payload === 'object' && payload !== null ? String(payload.message || '') : String(payload || '')
  if (!msg) return
  toastMsg.value = msg
  toastType.value = explicitType || (typeof payload === 'object' && payload?.type) || inferToastType(msg)
  toastKey.value += 1
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMsg.value = ''
  }, toastType.value === 'error' ? 5200 : 3800)
}

async function refreshProfile(updatedPayload = null) {
  if (updatedPayload && typeof updatedPayload === 'object') {
    if (updatedPayload.skipFetch) {
      if (updatedPayload.user) user.value = { ...user.value, ...updatedPayload.user }
      if (updatedPayload.plan !== undefined) plan.value = updatedPayload.plan
      if (updatedPayload.level !== undefined) level.value = updatedPayload.level
      if (updatedPayload.channel_fees) channelFees.value = updatedPayload.channel_fees
      if (updatedPayload.quotas) quotas.value = updatedPayload.quotas
      return
    }
    user.value = { ...user.value, ...updatedPayload }
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
  authBooting.value = true
  try {
    const hasToken = Boolean(localStorage.getItem('saas_token'))
    const [stResult, profResult] = await Promise.allSettled([
      apiFetch('/api/auth/status'),
      hasToken ? apiFetch('/api/profile') : Promise.resolve(null),
    ])

    if (stResult.status === 'fulfilled' && stResult.value) {
      const st = stResult.value
      authStatus.value = st
      if (st.channel_fees) channelFees.value = st.channel_fees
      setupRequired.value = Boolean(st.setup_required)
      if (setupRequired.value) return
    }

    if (hasToken && profResult.status === 'fulfilled' && profResult.value?.user) {
      const prof = profResult.value
      user.value = prof.user || {}
      plan.value = prof.plan || null
      level.value = prof.level || null
      if (tab.value === 'admin' && user.value.role !== 'admin') {
        tab.value = 'nodes'
      }
      authed.value = true
      if (tab.value !== 'billing') {
        refreshProfile()
      }
    } else {
      authed.value = false
    }
  } catch {
    authed.value = false
  } finally {
    authBooting.value = false
  }
}

function onUnauthorized() {
  authed.value = false
  mobileMenuOpen.value = false
  user.value = {}
}

async function onSetupDone(res) {
  user.value = res.user || {}
  plan.value = res.plan || null
  level.value = res.level || null
  setupRequired.value = false
  authBooting.value = false
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
  authBooting.value = false
  authed.value = true
  await refreshProfile()
}

function logout() {
  localStorage.removeItem('saas_token')
  authed.value = false
  mobileMenuOpen.value = false
  user.value = {}
}

onMounted(() => {
  if (_initNav.cleanUrl && typeof window !== 'undefined' && window.history?.replaceState) {
    try {
      window.history.replaceState({}, '', `${window.location.pathname}?tab=billing`)
    } catch {
      // ignore
    }
  }
  window.addEventListener('saas:unauthorized', onUnauthorized)
  boot()
})

onUnmounted(() => {
  window.removeEventListener('saas:unauthorized', onUnauthorized)
})
</script>
