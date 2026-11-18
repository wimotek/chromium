<template>
  <div>
    <div class="grid-4">
      <div class="card">
        <div class="kpi-label">钱包可用余额</div>
        <div class="kpi-val" style="color: #38bdf8">¥{{ user.balance_yuan || '0.00' }}</div>
      </div>
      <div class="card">
        <div class="kpi-label">节点出租累计收益</div>
        <div class="kpi-val" style="color: #34d399">+¥{{ user.total_earned_yuan || '0.00' }}</div>
      </div>
      <div class="card">
        <div class="kpi-label">累计市场消费 / 套餐</div>
        <div class="kpi-val">¥{{ user.total_spent_yuan || '0.00' }}</div>
      </div>
      <div class="card">
        <div class="kpi-label">本月流量配额消耗</div>
        <div class="kpi-val">{{ fmtBytes(quotas.monthly_traffic_bytes) }}</div>
        <div class="muted mono" style="font-size: 12px">上限 {{ fmtBytes(quotas.max_monthly_traffic_bytes) }}</div>
      </div>
    </div>

    <div class="card" v-if="levelProgress.current_level">
      <div class="card-title">
        <span>我的节点主等级与自动升降级考核</span>
        <div class="row">
          <span class="tag" :style="{ color: levelProgress.current_level.badge_color, borderColor: levelProgress.current_level.badge_color }">
            {{ levelProgress.current_level.name }}
          </span>
          <span class="tag tag-info">综合信用分 {{ levelProgress.metrics?.level_score || 0 }} / 1000</span>
          <span v-if="levelProgress.metrics?.level_locked" class="tag tag-warn">管理员已锁定等级</span>
        </div>
      </div>

      <div class="grid-4" style="margin-bottom: 12px">
        <div class="subcard">
          <div class="kpi-label">累计在线时长</div>
          <div class="kpi-val" style="font-size: 18px">{{ levelProgress.metrics?.online_hours || 0 }} 小时</div>
        </div>
        <div class="subcard">
          <div class="kpi-label">累计贡献共享流量</div>
          <div class="kpi-val" style="font-size: 18px">{{ levelProgress.metrics?.contributed_gb || 0 }} GB</div>
        </div>
        <div class="subcard">
          <div class="kpi-label">实时节点平均延迟</div>
          <div class="kpi-val" style="font-size: 18px">
            {{ levelProgress.metrics?.avg_node_latency_ms > 0 ? `${levelProgress.metrics.avg_node_latency_ms} ms` : '离线/未探测' }}
          </div>
        </div>
        <div class="subcard">
          <div class="kpi-label">实时节点平均吞吐</div>
          <div class="kpi-val" style="font-size: 18px">{{ levelProgress.metrics?.avg_node_speed_kbps || 0 }} KB/s</div>
        </div>
      </div>

      <div class="banner banner-info" style="margin-bottom: 0">
        当前等级分通道差价：<strong>WSS反穿 {{ (levelProgress.current_level.reverse_fee_bps / 100).toFixed(1) }}%</strong> ·
        <strong>公网WSS直连 {{ (levelProgress.current_level.public_wss_fee_bps / 100).toFixed(1) }}%</strong> ·
        买家租用额外减免 <strong>{{ (levelProgress.current_level.buyer_discount_bps / 100).toFixed(1) }}%</strong>
        <span v-if="levelProgress.next_level">
          ｜ 下一等级 <strong>{{ levelProgress.next_level.name }}</strong> 门槛：在线 ≥{{ levelProgress.next_level.min_online_hours }}h · 流量 ≥{{ levelProgress.next_level.min_contributed_gb }}GB · 延迟 ≤{{ levelProgress.next_level.max_avg_latency_ms || '不限' }}ms · 速率 ≥{{ levelProgress.next_level.min_speed_kbps }}KB/s
        </span>
        <div v-if="levelProgress.metrics?.last_level_change_reason" class="mono" style="margin-top: 6px">
          最近升降级记录：{{ levelProgress.metrics.last_level_change_reason }}
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">自有节点双模式自用计费明细</div>
        <div class="grid-2">
          <div class="subcard">
            <div class="kpi-label">公网 WSS 直连（自用）</div>
            <div class="kpi-val" style="font-size: 20px; color: #34d399; margin: 6px 0">¥0.00 / GB</div>
            <div class="muted" style="font-size: 12px">
              节点费 ¥{{ selfUseBilling.public_wss_node_yuan || '0.00' }} · Hub 流量费 ¥{{ selfUseBilling.public_wss_hub_yuan || '0.00' }}（账单零计费）
            </div>
          </div>
          <div class="subcard">
            <div class="kpi-label">WSS 反向穿透（自用仅收 Hub 流量费）</div>
            <div class="kpi-val" style="font-size: 20px; color: #38bdf8; margin: 6px 0">¥{{ selfUseBilling.reverse_hub_gb_yuan || '0.20' }} / GB</div>
            <div class="muted" style="font-size: 12px">
              节点费 ¥{{ selfUseBilling.reverse_node_yuan || '0.00' }} · 已累计自用反穿 {{ fmtBytes(selfUseBilling.self_reverse_billed_bytes || 0) }} (¥{{ selfUseBilling.self_reverse_billed_yuan || '0.00' }})
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">推广补贴 & 每日签到领奖</div>
        <div class="grid-2">
          <div class="subcard">
            <div class="kpi-label">每月固定补贴 ({{ promo.current_ym || '本月' }})</div>
            <div class="kpi-val" style="font-size: 20px; color: #facc15; margin: 6px 0">¥{{ promo.monthly_claim_yuan || '10.00' }}</div>
            <button
              class="btn btn-sm btn-primary"
              style="width: 100%"
              :disabled="claimingMonthly || !promo.monthly_claim_enabled || promo.monthly_claimed_this_month"
              @click="claimMonthly"
            >
              {{
                claimingMonthly
                  ? '领取中...'
                  : !promo.monthly_claim_enabled
                    ? '活动暂未开启'
                    : promo.monthly_claimed_this_month
                      ? '本月已领取'
                      : '立即领取本月补贴'
              }}
            </button>
          </div>
          <div class="subcard">
            <div class="kpi-label">每日签到（已连签 {{ promo.checkin_streak || 0 }} 天）</div>
            <div class="kpi-val" style="font-size: 20px; color: #34d399; margin: 6px 0">
              ¥{{ promo.daily_checkin_yuan || '0.50' }} + ¥{{ promo.daily_streak_bonus_yuan || '0.10' }}/天
            </div>
            <button
              class="btn btn-sm btn-emerald"
              style="width: 100%"
              :disabled="claimingDaily || !promo.daily_checkin_enabled || promo.checked_in_today"
              @click="claimDaily"
            >
              {{
                claimingDaily
                  ? '签到中...'
                  : !promo.daily_checkin_enabled
                    ? '签到暂未开启'
                    : promo.checked_in_today
                      ? '今日已签到'
                      : '每日签到领奖'
              }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">会员套餐与配额升级</div>
        <div class="grid-3">
          <div v-for="p in plans" :key="p.id" class="subcard">
            <div class="row" style="justify-content: space-between">
              <strong>{{ p.name }}</strong>
              <span v-if="p.id === user.plan_id" class="tag tag-ok">当前</span>
            </div>
            <div class="kpi-val" style="font-size: 20px; margin: 8px 0">¥{{ p.monthly_price_yuan }}/月</div>
            <div class="muted" style="font-size: 12px; line-height: 1.65">
              • 节点上限: {{ p.max_nodes }} 个<br />
              • 并发租用: {{ p.max_active_leases }} 路<br />
              • 月流量: {{ fmtBytes(p.max_monthly_traffic_bytes) }}<br />
              • 市场抽成减免: {{ (p.platform_fee_discount_bps / 100).toFixed(1) }}%
            </div>
            <button
              class="btn btn-sm btn-primary"
              style="width: 100%; margin-top: 10px"
              :disabled="p.id === user.plan_id"
              @click="subscribe(p.id)"
            >
              {{ p.id === user.plan_id ? '已生效' : '立即切换 / 升级' }}
            </button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>支付宝 / 微信支付官方收银台充值</span>
          <span class="tag tag-info">{{ paymentChannels.alipay_configured || paymentChannels.wechat_configured ? '官方网关已就绪' : '静态码 / 沙盒模式' }}</span>
        </div>
        <div class="banner banner-info">
          下单后系统自动调用官方支付网关生成真实付款二维码或支付宝电脑收银台链接；扫码或跳转支付成功后，异步回调与 3 秒自动查单将实时入账您的钱包余额。
        </div>

        <div class="row" style="margin-bottom: 12px; gap: 8px">
          <button
            class="btn btn-sm"
            :class="{ 'btn-primary': payChannel === 'alipay' }"
            :disabled="!paymentChannels.alipay_enabled"
            @click="payChannel = 'alipay'"
          >
            支付宝 · {{ alipayChannelBadge }}
          </button>
          <button
            class="btn btn-sm"
            :class="{ 'btn-emerald': payChannel === 'wechat' }"
            :disabled="!paymentChannels.wechat_enabled"
            @click="payChannel = 'wechat'"
          >
            微信支付 · {{ wechatChannelBadge }}
          </button>
        </div>

        <div class="row" style="margin-bottom: 14px">
          <input class="input mono" type="number" step="10" min="0.01" v-model.number="rechargeYuan" style="max-width: 140px" />
          <button class="btn btn-sm" @click="rechargeYuan = 10">¥10</button>
          <button class="btn btn-sm" @click="rechargeYuan = 50">¥50</button>
          <button class="btn btn-sm" @click="rechargeYuan = 100">¥100</button>
          <button class="btn btn-sm" @click="rechargeYuan = 500">¥500</button>
          <button class="btn btn-primary" :disabled="creatingOrder" @click="createRechargeOrder">
            {{ creatingOrder ? '正在下单...' : `立即充值 ¥${rechargeYuan}` }}
          </button>
        </div>

        <div v-if="rechargeOrders.length > 0" class="table-wrap" style="max-height: 240px; overflow-y: auto">
          <table>
            <thead>
              <tr><th>订单号</th><th>渠道</th><th>金额</th><th>状态</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="o in rechargeOrders" :key="o.id">
                <td class="mono">{{ o.order_no }}</td>
                <td>{{ o.channel === 'alipay' ? '支付宝' : '微信支付' }}</td>
                <td class="mono">¥{{ o.amount_yuan }}</td>
                <td><span class="tag" :class="o.status === 'paid' ? 'tag-ok' : 'tag-warn'">{{ o.status === 'paid' ? '已支付' : '待支付' }}</span></td>
                <td>
                  <div class="row" style="gap: 6px">
                    <button v-if="o.status === 'pending'" class="btn btn-sm btn-primary" @click="openCashierModal(o)">去付款 / 核验</button>
                    <span v-else class="muted mono" style="font-size: 11px">{{ o.paid_at || o.created_at }}</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">财务双分录账单流水</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>流水类型</th>
              <th>变动金额</th>
              <th>变动后余额</th>
              <th>平台差价贡献</th>
              <th>摘要</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in ledger" :key="l.id">
              <td class="mono muted">{{ l.created_at }}</td>
              <td><span class="tag tag-info">{{ l.tx_type }}</span></td>
              <td class="mono" :style="{ color: l.amount_units >= 0 ? '#34d399' : '#f87171' }">
                {{ l.amount_units >= 0 ? '+' : '' }}¥{{ l.amount_yuan }}
              </td>
              <td class="mono">¥{{ l.balance_after_yuan }}</td>
              <td class="mono muted">¥{{ l.platform_spread_yuan }}</td>
              <td>{{ l.remark }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 收银台扫码 / 跳转付款弹窗 -->
    <div v-if="cashierOrder" class="modal-backdrop" @click.self="closeCashierModal">
      <div class="modal-box">
        <div class="card-title">
          <span>{{ cashierOrder.channel === 'alipay' ? '支付宝收银台' : '微信支付收银台' }}</span>
          <button class="btn btn-sm" @click="closeCashierModal">关闭</button>
        </div>

        <div class="subcard" style="margin-bottom: 14px">
          <div class="row" style="justify-content: space-between; margin-bottom: 8px">
            <span class="muted">订单号：<span class="mono">{{ cashierOrder.order_no }}</span></span>
            <span class="tag" :class="cashierOrder.status === 'paid' ? 'tag-ok' : 'tag-warn'">
              {{ cashierOrder.status === 'paid' ? '支付成功已入账' : '等待付款中（每3秒自动核验）' }}
            </span>
          </div>
          <div class="kpi-val" style="font-size: 28px; color: var(--primary)">¥{{ cashierOrder.amount_yuan }}</div>
          <div v-if="cashierOrder.remark" class="muted mono" style="font-size: 11px; margin-top: 4px">{{ cashierOrder.remark }}</div>
        </div>

        <div v-if="cashierOrder.status === 'paid'" class="banner banner-success">
          款项已核验到账！当前可用余额：<strong class="mono">¥{{ user.balance_yuan || '0.00' }}</strong>
        </div>

        <template v-else>
          <div v-if="cashierQrSvg" style="text-align: center; margin: 14px 0">
            <div class="qr-frame" v-html="cashierQrSvg"></div>
            <div class="muted" style="font-size: 12px; margin-top: 8px">
              请打开手机{{ cashierOrder.channel === 'alipay' ? '支付宝' : '微信' }}扫一扫完成付款
            </div>
          </div>

          <div v-if="isHttpPayUrl" class="row" style="justify-content: center; margin: 12px 0">
            <a
              :href="cashierOrder.pay_url"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-primary"
            >
              前往{{ cashierOrder.channel === 'alipay' ? '支付宝' : '微信' }}官方收银台付款
            </a>
          </div>

          <div v-if="!cashierQrSvg && !isHttpPayUrl" class="banner banner-warn">
            {{ cashierOrder.pay_url || cashierOrder.qr_code_text || '管理员尚未配置官方商户密钥，请联系管理员或使用沙盒测试入账。' }}
          </div>

          <div v-if="cashierOrder.qr_code_text || isHttpPayUrl" class="field">
            <label>原始支付链接 / 二维码数据串</label>
            <div class="row">
              <input class="input mono" :value="cashierOrder.qr_code_text || cashierOrder.pay_url" readonly style="flex: 1" />
              <button class="btn btn-sm" @click="copyText(cashierOrder.qr_code_text || cashierOrder.pay_url)">复制</button>
            </div>
          </div>

          <div class="row" style="justify-content: flex-end; margin-top: 14px">
            <button v-if="allowSelfRecharge" class="btn btn-emerald" @click="sandboxPay(cashierOrder.order_no)">
              沙盒测试立即入账
            </button>
            <button class="btn btn-primary" :disabled="checkingOrder" @click="checkOrderStatusNow(cashierOrder.order_no)">
              {{ checkingOrder ? '核验中...' : '我已完成支付 · 立即核验' }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { apiFetch, fmtBytes } from '../../api'
import { renderQrSvg } from '../../utils/qrcode'

const emit = defineEmits(['notify', 'refresh-profile'])
const user = ref({})
const quotas = ref({})
const levelProgress = ref({})
const selfUseBilling = ref({})
const promo = ref({})
const paymentChannels = ref({
  alipay_enabled: true,
  alipay_mode: 'precreate',
  alipay_configured: false,
  wechat_enabled: true,
  wechat_mode: 'native_v3',
  wechat_configured: false,
})
const rechargeOrders = ref([])
const cashierOrder = ref(null)
const payChannel = ref('alipay')
const plans = ref([])
const ledger = ref([])
const allowSelfRecharge = ref(true)
const rechargeYuan = ref(50)

const claimingMonthly = ref(false)
const claimingDaily = ref(false)
const creatingOrder = ref(false)
const checkingOrder = ref(false)
let pollTimer = null

const alipayChannelBadge = computed(() => {
  if (!paymentChannels.value.alipay_enabled) return '已停用'
  if (paymentChannels.value.alipay_configured) {
    return paymentChannels.value.alipay_mode === 'page_pay' ? '电脑收银台' : '官方当面付'
  }
  return '静态码/沙盒'
})

const wechatChannelBadge = computed(() => {
  if (!paymentChannels.value.wechat_enabled) return '已停用'
  if (paymentChannels.value.wechat_configured && paymentChannels.value.wechat_mode === 'native_v3') {
    return '官方 V3 扫码'
  }
  return '静态码/沙盒'
})

const cashierQrSvg = computed(() => {
  const txt = cashierOrder.value?.qr_code_text || ''
  if (!txt || txt.startsWith('sandbox://') || txt.startsWith('unconfigured://')) return ''
  try {
    return renderQrSvg(txt, { size: 204 })
  } catch {
    return ''
  }
})

const isHttpPayUrl = computed(() => {
  const u = cashierOrder.value?.pay_url || ''
  return /^https?:\/\//i.test(u)
})

function stopOrderPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function startOrderPolling(orderNo) {
  stopOrderPolling()
  pollTimer = setInterval(async () => {
    if (!cashierOrder.value || cashierOrder.value.order_no !== orderNo || cashierOrder.value.status === 'paid') {
      stopOrderPolling()
      return
    }
    try {
      const res = await apiFetch(`/api/billing/recharge/orders/${orderNo}`)
      if (res.order) {
        cashierOrder.value = res.order
        if (res.order.status === 'paid') {
          stopOrderPolling()
          if (res.user) user.value = { ...user.value, ...res.user }
          emit('notify', `订单 ${orderNo} 支付成功，已入账 ¥${res.order.amount_yuan}`)
          emit('refresh-profile', res.user || null)
          await loadAll()
        }
      }
    } catch {
      // keep polling quietly while modal is open
    }
  }, 3000)
}

function openCashierModal(order) {
  cashierOrder.value = { ...order }
  if (order.status === 'pending') {
    startOrderPolling(order.order_no)
  }
}

function closeCashierModal() {
  stopOrderPolling()
  cashierOrder.value = null
}

function copyText(text) {
  navigator.clipboard?.writeText(text || '')
  emit('notify', '已复制到剪贴板')
}

async function loadAll() {
  try {
    const [bRes, pRes] = await Promise.all([apiFetch('/api/billing/overview'), apiFetch('/api/plans')])
    user.value = bRes.user || {}
    quotas.value = bRes.quotas || {}
    levelProgress.value = bRes.level_progress || {}
    selfUseBilling.value = bRes.self_use_billing || {}
    promo.value = bRes.promo || {}
    paymentChannels.value = bRes.payment_channels || paymentChannels.value
    rechargeOrders.value = bRes.recharge_orders || []
    if (!paymentChannels.value.alipay_enabled && paymentChannels.value.wechat_enabled) {
      payChannel.value = 'wechat'
    }
    ledger.value = bRes.ledger || []
    allowSelfRecharge.value = Boolean(bRes.allow_self_recharge)
    plans.value = pRes.plans || []
  } catch (e) {
    emit('notify', e.message)
  }
}

async function claimMonthly() {
  if (claimingMonthly.value) return
  claimingMonthly.value = true
  try {
    const res = await apiFetch('/api/billing/promo/monthly-claim', { method: 'POST' })
    promo.value = {
      ...promo.value,
      ...(res.promo || {}),
      monthly_claimed_this_month: true,
    }
    if (res.user) user.value = { ...user.value, ...res.user }
    emit('notify', res.message)
    emit('refresh-profile', res.user || null)
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  } finally {
    claimingMonthly.value = false
  }
}

async function claimDaily() {
  if (claimingDaily.value) return
  claimingDaily.value = true
  try {
    const res = await apiFetch('/api/billing/promo/daily-checkin', { method: 'POST' })
    promo.value = {
      ...promo.value,
      ...(res.promo || {}),
      checked_in_today: true,
      checkin_streak: res.checkin_streak ?? res.promo?.checkin_streak ?? promo.value.checkin_streak,
    }
    if (res.user) user.value = { ...user.value, ...res.user }
    emit('notify', res.message)
    emit('refresh-profile', res.user || null)
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  } finally {
    claimingDaily.value = false
  }
}

async function createRechargeOrder() {
  if (creatingOrder.value) return
  creatingOrder.value = true
  try {
    const res = await apiFetch('/api/billing/recharge/create', {
      method: 'POST',
      body: JSON.stringify({ channel: payChannel.value, amount_yuan: rechargeYuan.value }),
    })
    emit('notify', res.message)
    await loadAll()
    if (res.order) {
      openCashierModal(res.order)
    }
  } catch (e) {
    emit('notify', e.message)
  } finally {
    creatingOrder.value = false
  }
}

async function checkOrderStatusNow(orderNo) {
  if (checkingOrder.value) return
  checkingOrder.value = true
  try {
    const res = await apiFetch(`/api/billing/recharge/orders/${orderNo}`)
    if (res.order) cashierOrder.value = res.order
    if (res.order?.status === 'paid') {
      stopOrderPolling()
      if (res.user) user.value = { ...user.value, ...res.user }
      emit('notify', `核验成功：订单 ${orderNo} 已到账 ¥${res.order.amount_yuan}`)
      emit('refresh-profile', res.user || null)
      await loadAll()
    } else {
      emit('notify', '暂未检测到付款到账，请完成扫码/支付后稍等片刻')
    }
  } catch (e) {
    emit('notify', e.message)
  } finally {
    checkingOrder.value = false
  }
}

async function sandboxPay(orderNo) {
  try {
    const res = await apiFetch(`/api/billing/recharge/${orderNo}/sandbox-pay`, { method: 'POST' })
    if (res.order) cashierOrder.value = res.order
    stopOrderPolling()
    if (res.user) user.value = { ...user.value, ...res.user }
    emit('notify', res.message)
    emit('refresh-profile', res.user || null)
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function subscribe(planId) {
  try {
    const res = await apiFetch('/api/plans/subscribe', {
      method: 'POST',
      body: JSON.stringify({ plan_id: planId }),
    })
    if (res.user) user.value = { ...user.value, ...res.user }
    emit('notify', res.message)
    emit('refresh-profile', res.user || null)
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  }
}

onMounted(loadAll)
onBeforeUnmount(stopOrderPolling)
</script>
