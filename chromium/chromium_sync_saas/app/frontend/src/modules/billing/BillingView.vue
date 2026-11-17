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
        <div class="muted" style="font-size: 12px">上限 {{ fmtBytes(quotas.max_monthly_traffic_bytes) }}</div>
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
        <div style="border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: #0b1120">
          <div class="kpi-label">累计在线时长</div>
          <div class="kpi-val" style="font-size: 18px">{{ levelProgress.metrics?.online_hours || 0 }} 小时</div>
        </div>
        <div style="border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: #0b1120">
          <div class="kpi-label">累计贡献共享流量</div>
          <div class="kpi-val" style="font-size: 18px">{{ levelProgress.metrics?.contributed_gb || 0 }} GB</div>
        </div>
        <div style="border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: #0b1120">
          <div class="kpi-label">实时节点平均延迟</div>
          <div class="kpi-val" style="font-size: 18px">{{ levelProgress.metrics?.avg_node_latency_ms > 0 ? `${levelProgress.metrics.avg_node_latency_ms} ms` : '离线/未探测' }}</div>
        </div>
        <div style="border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: #0b1120">
          <div class="kpi-label">实时节点平均吞吐</div>
          <div class="kpi-val" style="font-size: 18px">{{ levelProgress.metrics?.avg_node_speed_kbps || 0 }} KB/s</div>
        </div>
      </div>

      <div class="banner banner-info" style="margin-bottom: 12px">
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
          <div style="border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: #0b1120">
            <div class="kpi-label">公网 WSS 直连（自用）</div>
            <div class="kpi-val" style="font-size: 20px; color: #34d399; margin: 6px 0">¥0.00 / GB</div>
            <div class="muted" style="font-size: 12px">节点费 ¥{{ selfUseBilling.public_wss_node_yuan || '0.00' }} · Hub 流量费 ¥{{ selfUseBilling.public_wss_hub_yuan || '0.00' }}（账单零计费）</div>
          </div>
          <div style="border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: #0b1120">
            <div class="kpi-label">WSS 反向穿透（自用仅收 Hub 流量费）</div>
            <div class="kpi-val" style="font-size: 20px; color: #38bdf8; margin: 6px 0">¥{{ selfUseBilling.reverse_hub_gb_yuan || '0.20' }} / GB</div>
            <div class="muted" style="font-size: 12px">节点费 ¥{{ selfUseBilling.reverse_node_yuan || '0.00' }} · 已累计自用反穿 {{ fmtBytes(selfUseBilling.self_reverse_billed_bytes || 0) }} (¥{{ selfUseBilling.self_reverse_billed_yuan || '0.00' }})</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">推广补贴 & 每日签到领奖</div>
        <div class="grid-2">
          <div style="border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: #0b1120">
            <div class="kpi-label">每月固定补贴 ({{ promo.current_ym || '本月' }})</div>
            <div class="kpi-val" style="font-size: 20px; color: #facc15; margin: 6px 0">¥{{ promo.monthly_claim_yuan || '10.00' }}</div>
            <button
              class="btn btn-sm btn-primary"
              style="width: 100%"
              :disabled="!promo.monthly_claim_enabled || promo.monthly_claimed_this_month"
              @click="claimMonthly"
            >
              {{ !promo.monthly_claim_enabled ? '活动暂未开启' : promo.monthly_claimed_this_month ? '本月已领取' : '立即领取本月补贴' }}
            </button>
          </div>
          <div style="border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: #0b1120">
            <div class="kpi-label">每日签到（已连签 {{ promo.checkin_streak || 0 }} 天）</div>
            <div class="kpi-val" style="font-size: 20px; color: #34d399; margin: 6px 0">¥{{ promo.daily_checkin_yuan || '0.50' }} + ¥{{ promo.daily_streak_bonus_yuan || '0.10' }}/天</div>
            <button
              class="btn btn-sm btn-emerald"
              style="width: 100%"
              :disabled="!promo.daily_checkin_enabled || promo.checked_in_today"
              @click="claimDaily"
            >
              {{ !promo.daily_checkin_enabled ? '签到暂未开启' : promo.checked_in_today ? '今日已签到' : '每日签到领奖' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">会员套餐与配额升级</div>
        <div class="grid-3">
          <div
            v-for="p in plans"
            :key="p.id"
            style="border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: #0b1120"
          >
            <div class="row" style="justify-content: space-between">
              <strong>{{ p.name }}</strong>
              <span v-if="p.id === user.plan_id" class="tag tag-ok">当前</span>
            </div>
            <div class="kpi-val" style="font-size: 20px; margin: 8px 0">¥{{ p.monthly_price_yuan }}/月</div>
            <div class="muted" style="font-size: 12px">
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
        <div class="card-title">支付宝 / 微信支付钱包充值</div>
        <div class="banner banner-info">
          支持支付宝与微信支付创建充值订单；如管理员开启了沙盒体验通道，可在下单后点击一键确认测试到账，或扫码付款等待官方回调 / 管理员核账。
        </div>
        <div class="row" style="margin-bottom: 10px; gap: 8px">
          <button
            class="btn btn-sm"
            :class="{ 'btn-primary': payChannel === 'alipay' }"
            :disabled="!paymentChannels.alipay_enabled"
            @click="payChannel = 'alipay'"
          >
            支付宝 {{ paymentChannels.alipay_enabled ? '' : '(已停用)' }}
          </button>
          <button
            class="btn btn-sm"
            :class="{ 'btn-emerald': payChannel === 'wechat' }"
            :disabled="!paymentChannels.wechat_enabled"
            @click="payChannel = 'wechat'"
          >
            微信支付 {{ paymentChannels.wechat_enabled ? '' : '(已停用)' }}
          </button>
        </div>
        <div class="row" style="margin-bottom: 12px">
          <input class="input" type="number" step="10" min="0.01" v-model.number="rechargeYuan" style="max-width: 160px" />
          <button class="btn btn-primary" @click="createRechargeOrder">创建 ¥{{ rechargeYuan }} 充值订单</button>
          <button class="btn btn-sm" @click="rechargeYuan = 50">¥50</button>
          <button class="btn btn-sm" @click="rechargeYuan = 200">¥200</button>
        </div>
        <div v-if="activeOrder" class="banner banner-warn mono" style="margin-bottom: 10px">
          订单号: <strong>{{ activeOrder.order_no }}</strong> · {{ activeOrder.channel === 'alipay' ? '支付宝' : '微信支付' }} · ¥{{ activeOrder.amount_yuan }} · 状态: {{ activeOrder.status }}<br />
          支付链接 / 二维码串: {{ activeOrder.qr_code_text || activeOrder.pay_url }}
          <div class="row" style="margin-top: 8px" v-if="activeOrder.status === 'pending'">
            <button v-if="allowSelfRecharge" class="btn btn-sm btn-emerald" @click="sandboxPay(activeOrder.order_no)">沙盒测试立即入账</button>
          </div>
        </div>
        <div v-if="rechargeOrders.length > 0" class="table-wrap" style="max-height: 180px; overflow-y: auto">
          <table>
            <thead>
              <tr><th>订单号</th><th>渠道</th><th>金额</th><th>状态</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="o in rechargeOrders" :key="o.id">
                <td class="mono">{{ o.order_no }}</td>
                <td>{{ o.channel === 'alipay' ? '支付宝' : '微信' }}</td>
                <td class="mono">¥{{ o.amount_yuan }}</td>
                <td><span class="tag" :class="o.status === 'paid' ? 'tag-ok' : 'tag-warn'">{{ o.status }}</span></td>
                <td>
                  <button v-if="o.status === 'pending' && allowSelfRecharge" class="btn btn-sm btn-emerald" @click="sandboxPay(o.order_no)">沙盒入账</button>
                  <span v-else class="muted">{{ o.paid_at || o.created_at }}</span>
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
              <td class="mono">{{ l.created_at }}</td>
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
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { apiFetch, fmtBytes } from '../../api'

const emit = defineEmits(['notify', 'refresh-profile'])
const user = ref({})
const quotas = ref({})
const levelProgress = ref({})
const selfUseBilling = ref({})
const promo = ref({})
const paymentChannels = ref({ alipay_enabled: true, wechat_enabled: true })
const rechargeOrders = ref([])
const activeOrder = ref(null)
const payChannel = ref('alipay')
const plans = ref([])
const ledger = ref([])
const allowSelfRecharge = ref(true)
const rechargeYuan = ref(50)

async function loadAll() {
  try {
    const [bRes, pRes] = await Promise.all([apiFetch('/api/billing/overview'), apiFetch('/api/plans')])
    user.value = bRes.user || {}
    quotas.value = bRes.quotas || {}
    levelProgress.value = bRes.level_progress || {}
    selfUseBilling.value = bRes.self_use_billing || {}
    promo.value = bRes.promo || {}
    paymentChannels.value = bRes.payment_channels || { alipay_enabled: true, wechat_enabled: true }
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
  try {
    const res = await apiFetch('/api/billing/promo/monthly-claim', { method: 'POST' })
    emit('notify', res.message)
    emit('refresh-profile')
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function claimDaily() {
  try {
    const res = await apiFetch('/api/billing/promo/daily-checkin', { method: 'POST' })
    emit('notify', res.message)
    emit('refresh-profile')
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function createRechargeOrder() {
  try {
    const res = await apiFetch('/api/billing/recharge/create', {
      method: 'POST',
      body: JSON.stringify({ channel: payChannel.value, amount_yuan: rechargeYuan.value }),
    })
    activeOrder.value = res.order || null
    emit('notify', res.message)
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function sandboxPay(orderNo) {
  try {
    const res = await apiFetch(`/api/billing/recharge/${orderNo}/sandbox-pay`, { method: 'POST' })
    activeOrder.value = res.order || null
    emit('notify', res.message)
    emit('refresh-profile')
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
    emit('notify', res.message)
    emit('refresh-profile')
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  }
}

onMounted(loadAll)
</script>
