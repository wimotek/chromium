<template>
  <div>
    <div class="grid-4">
      <div class="card">
        <div class="kpi-label">平台差价净收益 (Profit)</div>
        <div class="kpi-val" style="color: #34d399">¥{{ metrics.platform_profit_yuan || '0.00' }}</div>
      </div>
      <div class="card">
        <div class="kpi-label">平台总交易流水 (GMV)</div>
        <div class="kpi-val">¥{{ metrics.gmv_yuan || '0.00' }}</div>
      </div>
      <div class="card">
        <div class="kpi-label">已结算卖家分成</div>
        <div class="kpi-val">¥{{ metrics.seller_payout_yuan || '0.00' }}</div>
      </div>
      <div class="card">
        <div class="kpi-label">用户 / 共享节点 / 在租</div>
        <div class="kpi-val">{{ metrics.total_users || 0 }} / {{ metrics.shared_nodes || 0 }} / {{ metrics.active_leases || 0 }}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">商业化抽成差价与准入运营配置</div>
      <div class="grid-4">
        <div class="field">
          <label>平台默认加价比例 (bps, 2000=20%)</label>
          <input class="input" type="number" min="0" max="10000" v-model.number="settings.saas_platform_fee_bps" />
        </div>
        <div class="field">
          <label>新用户注册体验赠金 (元)</label>
          <input class="input" type="number" step="0.5" min="0" v-model.number="settings.saas_welcome_bonus_yuan" />
        </div>
        <div class="field">
          <label>公开注册开关</label>
          <select class="select" v-model="settings.saas_allow_public_register">
            <option :value="true">开放公开注册</option>
            <option :value="false">仅限管理员分配</option>
          </select>
        </div>
        <div class="field">
          <label>自助充值通道</label>
          <select class="select" v-model="settings.saas_allow_self_recharge">
            <option :value="true">允许租户自助充值</option>
            <option :value="false">关闭（仅人工调账）</option>
          </select>
        </div>
      </div>
      <button class="btn btn-primary" @click="saveSettings">保存商业化全局配置</button>
    </div>

    <div class="card">
      <div class="card-title">多租户账号治理与余额调账</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>UID / 用户名</th>
              <th>角色 / 套餐</th>
              <th>状态</th>
              <th>节点 / 活跃租约</th>
              <th>余额</th>
              <th>调账 / 启停</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <td><strong>#{{ u.id }} {{ u.username }}</strong><br /><span class="muted">{{ u.email || '-' }}</span></td>
              <td><span class="tag tag-info">{{ u.role }}</span> · {{ u.plan_name }}</td>
              <td><span class="tag" :class="u.status === 'active' ? 'tag-ok' : 'tag-danger'">{{ u.status }}</span></td>
              <td class="mono">{{ u.node_count }} 节点 · {{ u.active_lease_count }} 租约</td>
              <td class="mono">¥{{ u.balance_yuan }}</td>
              <td>
                <div class="row">
                  <button class="btn btn-sm" @click="adjustBalance(u.id, 100)">+¥100</button>
                  <button class="btn btn-sm btn-danger" @click="toggleUserStatus(u)">
                    {{ u.status === 'active' ? '封禁' : '解封' }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-title">全网租赁订单风控监控</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>租约 ID / 节点</th>
              <th>买家实付</th>
              <th>卖家实得</th>
              <th>平台差价盈利</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in recentLeases" :key="l.id">
              <td class="mono">#{{ l.id }} · Node#{{ l.node_id }} (Seller#{{ l.seller_id }} → Buyer#{{ l.buyer_id }})</td>
              <td class="mono">¥{{ l.buyer_spent_yuan }}</td>
              <td class="mono">¥{{ l.seller_earned_yuan }}</td>
              <td class="mono" style="color: #34d399">¥{{ l.platform_profit_yuan }}</td>
              <td><span class="tag" :class="l.status === 'active' ? 'tag-ok' : 'tag-warn'">{{ l.status }}</span></td>
              <td>
                <button v-if="l.status === 'active'" class="btn btn-sm btn-danger" @click="revokeLease(l.id)">风控强断</button>
                <span v-else class="muted">{{ l.end_reason }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { apiFetch } from '../api'

const emit = defineEmits(['notify'])
const metrics = ref({})
const users = ref([])
const recentLeases = ref([])
const settings = reactive({
  saas_platform_fee_bps: 2000,
  saas_allow_public_register: true,
  saas_allow_self_recharge: true,
  saas_welcome_bonus_yuan: 10,
})

async function load() {
  try {
    const [ov, us] = await Promise.all([apiFetch('/api/admin/overview'), apiFetch('/api/admin/users')])
    metrics.value = ov.metrics || {}
    Object.assign(settings, ov.settings || {})
    recentLeases.value = ov.recent_leases || []
    users.value = us || []
  } catch (e) {
    emit('notify', e.message)
  }
}

async function saveSettings() {
  const res = await apiFetch('/api/admin/settings', { method: 'POST', body: JSON.stringify(settings) })
  emit('notify', res.message)
  await load()
}

async function adjustBalance(uid, yuan) {
  const res = await apiFetch(`/api/admin/users/${uid}`, {
    method: 'PUT',
    body: JSON.stringify({ adjust_balance_yuan: yuan, adjust_remark: '管理员台人工授信充值' }),
  })
  emit('notify', res.message)
  await load()
}

async function toggleUserStatus(u) {
  const next = u.status === 'active' ? 'suspended' : 'active'
  const res = await apiFetch(`/api/admin/users/${u.id}`, {
    method: 'PUT',
    body: JSON.stringify({ status: next }),
  })
  emit('notify', res.message)
  await load()
}

async function revokeLease(id) {
  const res = await apiFetch(`/api/admin/leases/${id}/revoke`, { method: 'POST' })
  emit('notify', res.message)
  await load()
}

onMounted(load)
</script>
