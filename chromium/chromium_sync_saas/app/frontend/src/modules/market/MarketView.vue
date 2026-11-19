<template>
  <div>
    <div class="card">
      <div class="card-title">
        <span>共享算力市场（分通道差价 · 卖家等级与质量动态定价）</span>
        <div class="row">
          <span class="tag tag-info">
            基准加价: WSS反穿 {{ (channelFees.reverse / 100).toFixed(1) }}% · 公网WSS直连 {{ (channelFees.public_wss / 100).toFixed(1) }}%
          </span>
          <span class="tag tag-ok">
            您共减免 {{ (discountBps / 100).toFixed(1) }}% (套餐 {{ (planDiscountBps / 100).toFixed(1) }}% + 等级 {{ (levelDiscountBps / 100).toFixed(1) }}%)
          </span>
          <button class="btn btn-sm" :disabled="refreshing" @click="loadAll(true)">
            {{ refreshing ? '刷新中...' : '刷新市场' }}
          </button>
        </div>
      </div>

      <!-- 租用方式导览 & 当前在租入口 -->
      <div class="banner banner-info" style="margin-bottom: 14px">
        <div class="row" style="justify-content: space-between; align-items: center; gap: 10px">
          <div style="font-size: 13px; line-height: 1.6">
            <strong>租用方式：</strong>支持下方 <strong>「一键随机按数量租用」</strong>（自动挑选在线空闲节点），也可在市场列表中点击单个节点 <strong>「立即租用」</strong> 手动挑选。<br />
            <strong>查看位置：</strong>已租用的节点可直接在页面下方 <strong>「我的租用订单」</strong> 或顶部 <strong>「我的节点与凭据 → 我的节点 → 我租用的共享节点」</strong> 查看、复制 CDP WS 与退租结算（当前在租 <span class="mono"><strong>{{ activeBuyerLeases.length }}</strong> / {{ quotas.max_active_leases || '-' }}</span>）。
          </div>
          <div class="row" style="flex-shrink: 0">
            <button class="btn btn-sm" @click="scrollToMyLeases">查看下方租用订单 ({{ activeBuyerLeases.length }})</button>
            <button class="btn btn-sm btn-primary" @click="emit('go-my-nodes')">去「我的节点」查看 →</button>
          </div>
        </div>
      </div>

      <!-- 一键随机按数量租用栏 -->
      <div class="subcard" style="margin-bottom: 16px">
        <div class="card-title" style="font-size: 14px; margin-bottom: 10px">
          <span>一键随机按数量租用</span>
          <span class="muted mono" style="font-size: 12px">当前全市场可租在线槽位：{{ rentableNodeCount }} 个节点</span>
        </div>
        <div class="row" style="align-items: flex-end; gap: 10px; flex-wrap: wrap">
          <div class="field" style="margin-bottom: 0; min-width: 190px">
            <label>租用数量 (1 ~ 20 个)</label>
            <div class="row" style="gap: 6px">
              <input class="input mono" type="number" min="1" max="20" style="width: 78px" v-model.number="batchForm.count" />
              <button
                v-for="preset in [1, 2, 3, 5]"
                :key="preset"
                type="button"
                class="btn btn-sm"
                :class="{ 'btn-primary': batchForm.count === preset }"
                @click="batchForm.count = preset"
              >
                {{ preset }}个
              </button>
            </div>
          </div>

          <div class="field" style="margin-bottom: 0; min-width: 140px">
            <label>地区筛选</label>
            <select class="select" v-model="batchForm.region">
              <option value="">全部地区</option>
              <option v-for="r in availableRegions" :key="r" :value="r">{{ r }}</option>
            </select>
          </div>

          <div class="field" style="margin-bottom: 0; min-width: 150px">
            <label>通道筛选</label>
            <select class="select" v-model="batchForm.channel_type">
              <option value="">全部通道</option>
              <option value="reverse">WSS反向穿透</option>
              <option value="public_wss">公网WSS直连</option>
            </select>
          </div>

          <div class="field" style="margin-bottom: 0; width: 150px">
            <label>最高时租预算 (元/h)</label>
            <input class="input mono" type="number" step="0.1" min="0" placeholder="不限" v-model="batchForm.max_buyer_hour_yuan" />
          </div>

          <label class="switch switch-sm" style="padding-bottom: 8px">
            <input type="checkbox" v-model="batchForm.exclude_already_leased" />
            <span class="switch-track"></span>
            <span class="switch-state" :class="{ on: batchForm.exclude_already_leased }">避开我在租节点</span>
          </label>

          <button
            class="btn btn-emerald"
            :disabled="batchLoading || rentableNodeCount === 0"
            @click="rentBatchRandom"
          >
            {{ batchLoading ? '正在随机分配...' : `一键随机租用 ${batchForm.count || 1} 个节点` }}
          </button>
        </div>

        <div v-if="lastBatchResult.length > 0" class="banner banner-success" style="margin-top: 12px; margin-bottom: 0">
          <div class="row" style="justify-content: space-between; margin-bottom: 6px">
            <strong>本次已为您随机分配 {{ lastBatchResult.length }} 个共享节点：</strong>
            <button class="btn btn-sm" @click="copyAllBatchWs">复制全部 CDP WS 地址</button>
          </div>
          <div class="mono" style="font-size: 12px; line-height: 1.7">
            <div v-for="l in lastBatchResult" :key="l.id">
              • 租约 #{{ l.id }} · {{ l.node_name }} ({{ l.isolation_profile_id }}) —
              <a href="#" style="color: var(--primary)" @click.prevent="copy(l.cdp_ws_url)">复制 CDP WS</a>
            </div>
          </div>
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
              <th>通道 / 状态 / 质量评级</th>
              <th>剩余可租槽位</th>
              <th>买家时租 / 流量单价 (已计通道差价)</th>
              <th>操作 (手动单租)</th>
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
                  <span class="tag" :class="qualityTagClass(m.quality_grade)" style="margin-left: 4px">{{ m.quality_grade || 'C' }}级</span>
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
                  :disabled="m.status !== 'connected' || m.available_slots <= 0 || rentingNodeId !== null"
                  @click="rentNode(m.id)"
                >
                  {{ rentingNodeId === m.id ? '租用中...' : '立即租用' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div ref="leasesSectionRef" class="grid-2">
      <div class="card">
        <div class="card-title">
          <span>我的租用订单（作为买家接入 CDP）</span>
          <span class="tag tag-ok">在租 {{ activeBuyerLeases.length }}</span>
        </div>
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
                    <button
                      class="btn btn-sm btn-danger"
                      :disabled="stoppingLeaseId === l.id"
                      @click="stopLease(l.id)"
                    >
                      {{ stoppingLeaseId === l.id ? '结算中...' : '退租结算' }}
                    </button>
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
                  <button
                    v-if="l.status === 'active'"
                    class="btn btn-sm btn-danger"
                    :disabled="stoppingLeaseId === l.id"
                    @click="stopLease(l.id)"
                  >
                    {{ stoppingLeaseId === l.id ? '收回中...' : '强制收回' }}
                  </button>
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
import { computed, onMounted, reactive, ref } from 'vue'
import { apiFetch, fmtBytes, fmtDuration } from '../../api'

defineProps({
  quotas: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['notify', 'refresh-profile', 'go-my-nodes'])

const marketNodes = ref([])
const platformFeeBps = ref(2500)
const channelFees = ref({ reverse: 2500, public_wss: 1000 })
const planDiscountBps = ref(0)
const levelDiscountBps = ref(0)
const discountBps = ref(0)
const buyerLeases = ref([])
const sellerLeases = ref([])
const leasesSectionRef = ref(null)

const batchLoading = ref(false)
const refreshing = ref(false)
const rentingNodeId = ref(null)
const stoppingLeaseId = ref(null)
const lastBatchResult = ref([])
const batchForm = reactive({
  count: 1,
  region: '',
  channel_type: '',
  max_buyer_hour_yuan: '',
  exclude_already_leased: true,
})

const activeBuyerLeases = computed(() => buyerLeases.value.filter((l) => l.status === 'active'))

const rentableNodeCount = computed(
  () => marketNodes.value.filter((m) => !m.is_mine && m.status === 'connected' && Number(m.available_slots || 0) > 0).length,
)

const availableRegions = computed(() => {
  const set = new Set()
  for (const m of marketNodes.value) {
    if (m.region) set.add(m.region)
  }
  return Array.from(set)
})

function channelLabel(ch) {
  if (ch === 'public_wss' || ch === 'wss_direct') return '公网WSS直连'
  return 'WSS反向穿透'
}

function qualityTagClass(grade) {
  if (grade === 'S' || grade === 'A') return 'tag-ok'
  if (grade === 'B') return 'tag-info'
  return 'tag-warn'
}

function scrollToMyLeases() {
  leasesSectionRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function loadAll(showFeedback = false) {
  if (refreshing.value) return
  refreshing.value = true
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
    if (showFeedback) {
      emit('notify', { message: '算力市场与租约列表已刷新', type: 'info' })
    }
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    refreshing.value = false
  }
}

async function rentNode(nodeId) {
  if (rentingNodeId.value !== null) return
  rentingNodeId.value = nodeId
  try {
    const res = await apiFetch(`/api/market/nodes/${nodeId}/lease`, { method: 'POST', body: '{}' })
    emit('notify', { message: res.message || '节点租用成功', type: 'ok' })
    emit('refresh-profile')
    await loadAll(false)
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    rentingNodeId.value = null
  }
}

async function rentBatchRandom() {
  const count = Math.max(1, Math.min(20, Number(batchForm.count || 1)))
  batchForm.count = count
  batchLoading.value = true
  try {
    const payload = {
      count,
      region: batchForm.region,
      channel_type: batchForm.channel_type,
      exclude_already_leased: batchForm.exclude_already_leased,
    }
    if (batchForm.max_buyer_hour_yuan !== '' && batchForm.max_buyer_hour_yuan !== null) {
      const budget = Number(batchForm.max_buyer_hour_yuan)
      if (!Number.isNaN(budget) && budget >= 0) {
        payload.max_buyer_hour_yuan = budget
      }
    }
    const res = await apiFetch('/api/market/lease/batch-random', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    lastBatchResult.value = res.leases || []
    emit('notify', { message: res.message || '批量租用成功', type: 'ok' })
    emit('refresh-profile')
    await loadAll(false)
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    batchLoading.value = false
  }
}

function copyAllBatchWs() {
  const urls = lastBatchResult.value.map((l) => l.cdp_ws_url).filter(Boolean).join('\n')
  if (!urls) return
  navigator.clipboard?.writeText(urls)
  emit('notify', { message: `已复制 ${lastBatchResult.value.length} 条 CDP WebSocket 地址`, type: 'ok' })
}

async function stopLease(leaseId) {
  if (stoppingLeaseId.value !== null) return
  stoppingLeaseId.value = leaseId
  try {
    const res = await apiFetch(`/api/leases/${leaseId}/stop`, { method: 'POST' })
    emit('notify', { message: res.message || '租约已结算', type: 'ok' })
    emit('refresh-profile')
    await loadAll(false)
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    stoppingLeaseId.value = null
  }
}

function copy(val) {
  navigator.clipboard?.writeText(val || '')
  emit('notify', { message: 'CDP WebSocket 地址已复制', type: 'ok' })
}

onMounted(() => loadAll(false))
</script>
