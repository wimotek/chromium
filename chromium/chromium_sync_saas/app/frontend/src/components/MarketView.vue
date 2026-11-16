<template>
  <div>
    <div class="card">
      <div class="card-title">
        <span>共享算力市场（按量计费 · 卖家收益 + 平台差价模式）</span>
        <div class="row">
          <span class="tag tag-info">平台基础加价 {{ (platformFeeBps / 100).toFixed(1) }}% · 您套餐减免 {{ (discountBps / 100).toFixed(1) }}%</span>
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
              <th>共享节点名称 / 提供方</th>
              <th>状态 / 地区 / 隔离模式</th>
              <th>剩余可租槽位</th>
              <th>买家时租 / 流量单价</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in marketNodes" :key="m.id">
              <td>
                <div><strong>#{{ m.id }} {{ m.title }}</strong></div>
                <div class="muted" style="font-size: 12px">供给方: {{ m.owner_username }} · {{ m.conn_type }}</div>
              </td>
              <td>
                <span class="tag" :class="m.status === 'connected' ? 'tag-ok' : 'tag-warn'">{{ m.status }}</span>
                <span class="tag" style="margin-left: 6px">{{ m.region }}</span>
                <div class="muted" style="font-size: 12px; margin-top: 4px">
                  {{ m.isolation_mode === 'ephemeral_profile' ? '隔离临时 Profile' : '独占槽位' }}
                </div>
              </td>
              <td class="mono">{{ m.available_slots }} / {{ m.max_concurrent_leases }}</td>
              <td class="mono">
                <div><strong>¥{{ m.buyer_hour_yuan }}</strong> / 小时</div>
                <div class="muted"><strong>¥{{ m.buyer_gb_yuan }}</strong> / GB</div>
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
                  <div class="muted mono">{{ l.isolation_profile_id }}</div>
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
                <th>实得分成 (已扣差价)</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in sellerLeases" :key="l.id">
                <td>
                  <div><strong>#{{ l.id }} {{ l.node_name }}</strong></div>
                  <div class="muted">买家: {{ l.buyer_username }}</div>
                </td>
                <td class="mono">
                  <span class="tag" :class="l.status === 'active' ? 'tag-ok' : 'tag-warn'">{{ l.status }}</span>
                  <div>{{ fmtDuration(l.billed_seconds) }} · {{ fmtBytes(l.billed_bytes) }}</div>
                </td>
                <td class="mono" style="color: #34d399">+¥{{ l.seller_earned_yuan }}</td>
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
import { apiFetch, fmtBytes, fmtDuration } from '../api'

const emit = defineEmits(['notify', 'refresh-profile'])

const marketNodes = ref([])
const platformFeeBps = ref(2000)
const discountBps = ref(0)
const buyerLeases = ref([])
const sellerLeases = ref([])

async function loadAll() {
  try {
    const [mRes, lRes] = await Promise.all([apiFetch('/api/market/nodes'), apiFetch('/api/leases')])
    marketNodes.value = mRes.nodes || []
    platformFeeBps.value = mRes.platform_fee_bps || 2000
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
