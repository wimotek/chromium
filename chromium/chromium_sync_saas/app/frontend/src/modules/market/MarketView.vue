<template>
  <div>
    <div class="card">
      <div class="card-title">
        <span>共享算力市场（分通道差价 · 卖家等级动态定价）</span>
        <div class="row">
          <span class="tag tag-info">
            基准加价: WSS反穿 {{ (channelFees.reverse / 100).toFixed(1) }}% · 公网WSS直连 {{ (channelFees.public_wss / 100).toFixed(1) }}%
          </span>
          <span class="tag tag-ok">
            您共减免 {{ (discountBps / 100).toFixed(1) }}% (套餐 {{ (planDiscountBps / 100).toFixed(1) }}% + 等级 {{ (levelDiscountBps / 100).toFixed(1) }}%)
          </span>
          <button class="btn btn-sm" @click="loadAll">刷新市场</button>
        </div>
      </div>

      <div v-if="marketNodes.length === 0" class="muted" style="padding: 16px 0">
        当前暂无其他租户上架的共享节点，您可以先在「我的节点」上架自己的节点作为供给方。
      </div>

      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>共享节点名称 / 卖家等级</th>
              <th>通道 / 状态 / 速度质量</th>
              <th>剩余可租槽位</th>
              <th>买家时租 / 流量单价 (已计通道差价)</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in marketNodes" :key="m.id">
              <td>
                <div><strong>#{{ m.id }} {{ m.title }}</strong></div>
                <div class="row" style="margin-top: 4px; gap: 6px">
                  <span class="muted" style="font-size: 12px">{{ m.owner_username }}</span>
                  <span class="tag" :style="{ color: m.seller_level_color, borderColor: m.seller_level_color }">{{ m.seller_level_name }}</span>
                </div>
              </td>
              <td>
                <div>
                  <span class="tag tag-info">{{ channelLabel(m.channel_type || m.conn_type) }}</span>
                  <span class="tag" :class="m.status === 'connected' ? 'tag-ok' : 'tag-warn'" style="margin-left: 4px">{{ m.status }}</span>
                  <span class="tag" style="margin-left: 4px">{{ m.region }}</span>
                </div>
                <div class="muted mono" style="font-size: 11px; margin-top: 4px">
                  延迟 {{ m.avg_latency_ms > 0 ? `${m.avg_latency_ms}ms` : '--' }} · 速率 {{ m.avg_speed_kbps || 0 }}KB/s · {{ m.isolation_mode === 'ephemeral_profile' ? '隔离临时 Profile' : '独占槽位' }}
                </div>
              </td>
              <td class="mono">{{ m.available_slots }} / {{ m.max_concurrent_leases }}</td>
              <td class="mono">
                <div><strong>¥{{ m.buyer_hour_yuan }}</strong> / 小时</div>
                <div class="muted"><strong>¥{{ m.buyer_gb_yuan }}</strong> / GB</div>
                <div class="muted" style="font-size: 11px">
                  通道差价 {{ ((m.channel_base_fee_bps || 0) / 100).toFixed(1) }}% → 实付加价 {{ ((m.effective_fee_bps || 0) / 100).toFixed(1) }}%
                </div>
              </td>
              <td>
                <span v-if="m.is_mine" class="muted">本人名下节点</span>
                <button
                  v-else
                  class="btn btn-sm btn-primary"
                  :disabled="m.status !== 'connected' || m.available_slots <= 0"
                  @click="rentNode(m.id)"
                >
                  立即租用
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">我的租用订单（作为买家接入 CDP）</div>
        <div v-if="buyerLeases.length === 0" class="muted">暂无购买租约。</div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>租约 / 节点</th>
                <th>状态 / 已计费</th>
                <th>买家实付</th>
                <th>接入与控制</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in buyerLeases" :key="l.id">
                <td>
                  <div><strong>#{{ l.id }} {{ l.node_name }}</strong></div>
                  <div class="muted mono">{{ channelLabel(l.channel_type) }} · {{ l.isolation_profile_id }}</div>
                </td>
                <td class="mono">
                  <span class="tag" :class="l.status === 'active' ? 'tag-ok' : 'tag-warn'">{{ l.status }}</span>
                  <div>{{ fmtDuration(l.billed_seconds) }} · {{ fmtBytes(l.billed_bytes) }}</div>
                </td>
                <td class="mono">¥{{ l.buyer_spent_yuan }}</td>
                <td>
                  <div class="row" v-if="l.status === 'active'">
                    <button class="btn btn-sm" @click="copy(l.cdp_ws_url)">复制 CDP WS</button>
                    <button class="btn btn-sm btn-danger" @click="stopLease(l.id)">退租结算</button>
                  </div>
                  <span v-else class="muted" style="font-size: 12px">{{ l.end_reason || l.ended_at }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-title">我的出租收益（作为卖家赚取分成）</div>
        <div v-if="sellerLeases.length === 0" class="muted">名下节点暂无被他人租用的成交记录。</div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>租约 / 买家</th>
                <th>状态 / 用量</th>
                <th>实得分成 (差价费率)</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in sellerLeases" :key="l.id">
                <td>
                  <div><strong>#{{ l.id }} {{ l.node_name }}</strong></div>
                  <div class="muted">买家: {{ l.buyer_username }} · {{ channelLabel(l.channel_type) }}</div>
                </td>
                <td class="mono">
                  <span class="tag" :class="l.status === 'active' ? 'tag-ok' : 'tag-warn'">{{ l.status }}</span>
                  <div>{{ fmtDuration(l.billed_seconds) }} · {{ fmtBytes(l.billed_bytes) }}</div>
                </td>
                <td class="mono" style="color: #34d399">
                  +¥{{ l.seller_earned_yuan }}
                  <div class="muted" style="font-size: 11px">{{ l.seller_level_code }} · +{{ ((l.platform_fee_bps || 0) / 100).toFixed(1) }}%</div>
                </td>
                <td>
                  <button v-if="l.status === 'active'" class="btn btn-sm btn-danger" @click="stopLease(l.id)">强制收回</button>
                  <span v-else class="muted" style="font-size: 12px">{{ l.ended_at }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { apiFetch, fmtBytes, fmtDuration } from '../../api'

const emit = defineEmits(['notify', 'refresh-profile'])

const marketNodes = ref([])
const platformFeeBps = ref(2500)
const channelFees = ref({ reverse: 2500, public_wss: 1000 })
const planDiscountBps = ref(0)
const levelDiscountBps = ref(0)
const discountBps = ref(0)
const buyerLeases = ref([])
const sellerLeases = ref([])

function channelLabel(ch) {
  if (ch === 'public_wss' || ch === 'wss_direct') return '公网WSS直连'
  return 'WSS反向穿透'
}

async function loadAll() {
  try {
    const [mRes, lRes] = await Promise.all([apiFetch('/api/market/nodes'), apiFetch('/api/leases')])
    marketNodes.value = mRes.nodes || []
    platformFeeBps.value = mRes.platform_fee_bps || 2500
    if (mRes.channel_fees) channelFees.value = mRes.channel_fees
    planDiscountBps.value = mRes.plan_discount_bps || 0
    levelDiscountBps.value = mRes.level_discount_bps || 0
    discountBps.value = mRes.your_discount_bps || 0
    buyerLeases.value = lRes.buyer_leases || []
    sellerLeases.value = lRes.seller_leases || []
  } catch (e) {
    emit('notify', e.message)
  }
}

async function rentNode(nodeId) {
  try {
    const res = await apiFetch(`/api/market/nodes/${nodeId}/lease`, { method: 'POST', body: '{}' })
    emit('notify', res.message)
    emit('refresh-profile')
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function stopLease(leaseId) {
  try {
    const res = await apiFetch(`/api/leases/${leaseId}/stop`, { method: 'POST' })
    emit('notify', res.message)
    emit('refresh-profile')
    await loadAll()
  } catch (e) {
    emit('notify', e.message)
  }
}

function copy(val) {
  navigator.clipboard?.writeText(val || '')
  emit('notify', 'CDP WebSocket 地址已复制')
}

onMounted(loadAll)
</script>
