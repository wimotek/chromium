<template>
  <div>
    <div class="card">
      <div class="card-title">
        <span>我的节点接入凭据（强身份绑定）</span>
        <span class="tag tag-info">自有节点 {{ nodes.length }} / {{ quotas.max_nodes || '-' }}</span>
      </div>
      <div class="grid-2">
        <div>
          <div class="kpi-label">个人集群入网码 (JOIN_TOKEN，用于 Windows / Docker / Android 节点连接)</div>
          <div class="row" style="margin-top: 6px">
            <input class="input mono" :value="user.cluster_join_token" readonly style="flex: 1" />
            <button class="btn btn-sm" @click="copy(user.cluster_join_token)">复制</button>
            <button class="btn btn-sm btn-danger" @click="rotate(false, true)">重置</button>
          </div>
        </div>
        <div>
          <div class="kpi-label">个人 CDP 网关密钥 (API-Key，用于接入自有节点及已租用节点 CDP)</div>
          <div class="row" style="margin-top: 6px">
            <input class="input mono" :value="user.api_key" readonly style="flex: 1" />
            <button class="btn btn-sm" @click="copy(user.api_key)">复制</button>
            <button class="btn btn-sm btn-danger" @click="rotate(true, false)">重置</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <span>自有节点清单 & 共享出租上架配置</span>
        <div class="row">
          <span v-if="userLevel" class="tag" :style="{ color: userLevel.badge_color, borderColor: userLevel.badge_color }">
            当前 {{ userLevel.name }} · 反穿 {{ ((userLevel.reverse_fee_bps || channelFees.reverse || 2500) / 100).toFixed(1) }}% / WSS直连 {{ ((userLevel.public_wss_fee_bps || channelFees.public_wss || 1000) / 100).toFixed(1) }}%
          </span>
          <button class="btn btn-sm" @click="load">刷新状态</button>
        </div>
      </div>

      <div class="banner banner-info" style="margin-bottom: 12px">
        <strong>纯 WSS 入网与自用双计费说明：</strong>SaaS 版仅支持 <span class="mono">WSS 反向穿透</span> 与 <span class="mono">公网 WSS 直连</span>。<br />
        • <strong>自用公网 WSS 直连</strong>：节点免费 ¥0 + Hub 流量 ¥0（完全零扣费，仅做信令调度）。<br />
        • <strong>自用 WSS 反向穿透</strong>：节点自身 ¥0，但经过 Hub 中继转发会产生平台流量成本，按每 GB 阶梯/基准费率扣减余额（余额不足自动阻断）。
      </div>

      <div v-if="nodes.length === 0" class="muted" style="padding: 18px 0">
        暂无自有节点。请在节点端填入上方 <span class="mono">JOIN_TOKEN</span> 通过 WSS 反向穿透或公网 WSS 直连入网，即可在此管理或上架出租赚取收益。
      </div>

      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID / 名称</th>
              <th>通道 / 状态 / 速度质量</th>
              <th>活跃租约 / 隔离模式</th>
              <th>共享市场定价 (卖家底价 → 买家价)</th>
              <th>累计流量 / 在线</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="n in nodes" :key="n.id">
              <td>
                <div><strong>#{{ n.id }} {{ n.name }}</strong></div>
                <div class="muted mono">{{ n.group_name }} · {{ n.client_type || 'desktop' }}</div>
              </td>
              <td>
                <div>
                  <span class="tag tag-info">{{ channelLabel(n.channel_type || n.conn_type) }}</span>
                  <span class="tag" :class="n.status === 'connected' ? 'tag-ok' : 'tag-warn'" style="margin-left: 4px">{{ n.status }}</span>
                </div>
                <div class="muted mono" style="font-size: 11px; margin-top: 4px">
                  延迟 {{ n.avg_latency_ms > 0 ? `${n.avg_latency_ms}ms` : '--' }} · 速率 {{ n.avg_speed_kbps || 0 }}KB/s
                </div>
              </td>
              <td>
                <div v-if="n.active_lease_count > 0" class="tag tag-warn">出租中 ({{ n.active_lease_count }}/{{ n.max_concurrent_leases }})</div>
                <div v-else class="tag">空闲可用</div>
                <div class="muted" style="font-size: 12px; margin-top: 4px">
                  {{ n.isolation_mode === 'ephemeral_profile' ? '独立临时 Profile' : '独占槽位模式' }}
                </div>
              </td>
              <td>
                <div v-if="n.share_enabled">
                  <span class="tag tag-ok">已上架 (加价 {{ ((n.platform_fee_bps || 0) / 100).toFixed(1) }}%)</span>
                  <div class="mono" style="margin-top: 4px">
                    时租: ¥{{ (n.seller_price_per_hour_units / 10000).toFixed(2) }} → <strong>¥{{ (n.buyer_preview_hour_units / 10000).toFixed(2) }}</strong>
                  </div>
                  <div class="mono muted">
                    流量: ¥{{ (n.seller_price_per_gb_units / 10000).toFixed(2) }}/GB → ¥{{ (n.buyer_preview_gb_units / 10000).toFixed(2) }}/GB
                  </div>
                </div>
                <div v-else>
                  <span class="muted">未上架（仅个人私有）</span>
                  <div class="muted mono" style="font-size: 11px">若上架加价 {{ ((n.platform_fee_bps || 0) / 100).toFixed(1) }}%</div>
                </div>
              </td>
              <td class="mono">
                CDP: {{ fmtBytes((n.cdp_rx_bytes || 0) + (n.cdp_tx_bytes || 0)) }}<br />
                在线: {{ fmtDuration(n.online_seconds || 0) }} · 已租 {{ fmtDuration(n.total_leased_seconds) }}
              </td>
              <td>
                <div class="row">
                  <button class="btn btn-sm btn-emerald" @click="openShareModal(n)">共享定价</button>
                  <button class="btn btn-sm" @click="probeNode(n.id)">探活</button>
                  <button class="btn btn-sm btn-danger" @click="deleteNode(n.id)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="shareTarget" class="modal-backdrop" @click.self="shareTarget = null">
      <div class="modal-box">
        <h3 class="card-title">共享节点上架定价 · #{{ shareTarget.id }} {{ shareTarget.name }}</h3>
        <div class="banner banner-warn">
          <strong>多用户隐私与资源保护：</strong><br />
          1. 节点出租期间，Hub 将自动暂停您个人 Cookie 策略对该节点的读取/写入，并锁死 <span class="mono">/cookies</span> 接口。<br />
          2. 默认采用 <strong>独占槽位 (Max=1)</strong>，推荐配合隔离容器使用，避免单节点多开独立 Chromium Profile 撑爆宿主机内存。
        </div>
        <div class="field">
          <label class="row" style="cursor: pointer">
            <input type="checkbox" v-model="shareForm.share_enabled" />
            <span>上架至公共算力交易市场接受其他租户按需租用</span>
          </label>
        </div>
        <div class="grid-2">
          <div class="field"><label>市场展示标题</label><input class="input" v-model="shareForm.share_title" /></div>
          <div class="field"><label>地区标签</label><input class="input" v-model="shareForm.share_region" /></div>
          <div class="field">
            <label>卖家底价 · 时租 (元/小时)</label>
            <input class="input" type="number" step="0.05" min="0" v-model.number="shareForm.seller_price_per_hour_yuan" />
          </div>
          <div class="field">
            <label>卖家底价 · 流量 (元/GB)</label>
            <input class="input" type="number" step="0.05" min="0" v-model.number="shareForm.seller_price_per_gb_yuan" />
          </div>
          <div class="field">
            <label>会话隔离策略</label>
            <select class="select" v-model="shareForm.isolation_mode">
              <option value="exclusive_slot">独占单槽位（单次仅限 1 买家，最省内存最稳）</option>
              <option value="ephemeral_profile">多路并发临时 Profile（适合高配容器节点）</option>
            </select>
          </div>
          <div class="field" v-if="shareForm.isolation_mode === 'ephemeral_profile'">
            <label>最大并发租约槽位数 (1~8)</label>
            <input class="input" type="number" min="1" max="8" v-model.number="shareForm.max_concurrent_leases" />
          </div>
        </div>
        <div class="banner banner-info mono">
          通道 [{{ channelLabel(shareTarget.channel_type || shareTarget.conn_type) }}] · 等级 [{{ shareTarget.seller_level_name || 'Lv.1' }}] 平台加价 {{ (activeShareFeeBps / 100).toFixed(1) }}%<br />
          买家实付基准约 ¥{{ previewBuyerHr }}/h + ¥{{ previewBuyerGb }}/GB（差价归平台运营盈利，您 100% 实得所设底价；高等级节点主或公网 WSS 直连享更低差价）
        </div>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" @click="shareTarget = null">取消</button>
          <button class="btn btn-primary" @click="saveShare">保存上架设置</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { apiFetch, fmtBytes, fmtDuration } from '../../api'

const props = defineProps({
  user: { type: Object, required: true },
  quotas: { type: Object, default: () => ({}) },
  platformFeeBps: { type: Number, default: 2500 },
  channelFees: { type: Object, default: () => ({ reverse: 2500, public_wss: 1000 }) },
  userLevel: { type: Object, default: null },
})
const emit = defineEmits(['notify', 'refresh-profile'])

const nodes = ref([])
const shareTarget = ref(null)

const shareForm = reactive({
  share_enabled: true,
  share_title: '',
  share_region: 'Global',
  share_tags: '',
  seller_price_per_hour_yuan: 0.5,
  seller_price_per_gb_yuan: 1.0,
  isolation_mode: 'exclusive_slot',
  max_concurrent_leases: 1,
})

function channelLabel(ch) {
  if (ch === 'public_wss' || ch === 'wss_direct') return '公网WSS直连'
  return 'WSS反向穿透'
}

const activeShareFeeBps = computed(() => {
  if (shareTarget.value && shareTarget.value.platform_fee_bps !== undefined) {
    return Number(shareTarget.value.platform_fee_bps)
  }
  return Number(props.platformFeeBps || 2500)
})

const previewBuyerHr = computed(() => (shareForm.seller_price_per_hour_yuan * (1 + activeShareFeeBps.value / 10000)).toFixed(2))
const previewBuyerGb = computed(() => (shareForm.seller_price_per_gb_yuan * (1 + activeShareFeeBps.value / 10000)).toFixed(2))

async function load() {
  try {
    nodes.value = await apiFetch('/api/nodes')
  } catch (e) {
    emit('notify', e.message)
  }
}

function copy(val) {
  navigator.clipboard?.writeText(val || '')
  emit('notify', '已复制到剪贴板')
}

async function rotate(rotApi, rotJoin) {
  try {
    await apiFetch('/api/profile/rotate-credentials', {
      method: 'POST',
      body: JSON.stringify({ rotate_api_key: rotApi, rotate_join_token: rotJoin }),
    })
    emit('refresh-profile')
    emit('notify', '凭据已重新签发')
  } catch (e) {
    emit('notify', e.message)
  }
}

function openShareModal(n) {
  shareTarget.value = n
  shareForm.share_enabled = Boolean(n.share_enabled)
  shareForm.share_title = n.share_title || n.name
  shareForm.share_region = n.share_region || 'Global'
  shareForm.share_tags = n.share_tags || ''
  shareForm.seller_price_per_hour_yuan = Number(((n.seller_price_per_hour_units || 5000) / 10000).toFixed(2))
  shareForm.seller_price_per_gb_yuan = Number(((n.seller_price_per_gb_units || 10000) / 10000).toFixed(2))
  shareForm.isolation_mode = n.isolation_mode || 'exclusive_slot'
  shareForm.max_concurrent_leases = n.max_concurrent_leases || 1
}

async function saveShare() {
  try {
    const res = await apiFetch(`/api/nodes/${shareTarget.value.id}/share`, {
      method: 'POST',
      body: JSON.stringify(shareForm),
    })
    shareTarget.value = null
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function probeNode(id) {
  try {
    const res = await apiFetch(`/api/nodes/${id}/probe`, { method: 'POST' })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function deleteNode(id) {
  try {
    await apiFetch(`/api/nodes/${id}`, { method: 'DELETE' })
    emit('notify', '节点已移除')
    emit('refresh-profile')
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

onMounted(load)
</script>
