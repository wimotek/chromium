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
        <div class="card-title">钱包在线充值（运营测试通道）</div>
        <div class="banner banner-info">
          购买市场共享节点或升级套餐将从钱包余额实时扣除；出租名下节点赚取的买家租金会在扣减平台差价后实时打入同一钱包余额，可提现或直接抵扣消费。
        </div>
        <div class="row" v-if="allowSelfRecharge">
          <input class="input" type="number" step="10" min="1" v-model.number="rechargeYuan" style="max-width: 180px" />
          <button class="btn btn-emerald" @click="doRecharge">充值 ¥{{ rechargeYuan }}</button>
          <button class="btn" @click="rechargeYuan = 50">+50</button>
          <button class="btn" @click="rechargeYuan = 200">+200</button>
        </div>
        <div v-else class="muted">当前平台已关闭自助充值入口，请联系超级管理员人工调账入款。</div>
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
import { apiFetch, fmtBytes } from '../api'

const emit = defineEmits(['notify', 'refresh-profile'])
const user = ref({})
const quotas = ref({})
const plans = ref([])
const ledger = ref([])
const allowSelfRecharge = ref(true)
const rechargeYuan = ref(50)

async function loadAll() {
  try {
    const [bRes, pRes] = await Promise.all([apiFetch('/api/billing/overview'), apiFetch('/api/plans')])
    user.value = bRes.user || {}
    quotas.value = bRes.quotas || {}
    ledger.value = bRes.ledger || []
    allowSelfRecharge.value = Boolean(bRes.allow_self_recharge)
    plans.value = pRes.plans || []
  } catch (e) {
    emit('notify', e.message)
  }
}

async function doRecharge() {
  try {
    const res = await apiFetch('/api/billing/recharge', {
      method: 'POST',
      body: JSON.stringify({ amount_yuan: rechargeYuan.value }),
    })
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
