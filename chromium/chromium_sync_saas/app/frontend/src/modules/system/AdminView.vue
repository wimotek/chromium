<template>
  <div>
    <div class="grid-4">
      <div class="card">
        <div class="kpi-label">平台净收益 (市场差价 + 自用反穿流量)</div>
        <div class="kpi-val" style="color: #34d399">¥{{ metrics.platform_profit_yuan || '0.00' }}</div>
        <div class="muted mono" style="font-size: 11px">
          租约差价 ¥{{ metrics.lease_profit_yuan || '0.00' }} · 自用反穿 ¥{{ metrics.self_reverse_profit_yuan || '0.00' }}
        </div>
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
        <div class="kpi-label">用户 / 共享节点 / 在租 / 邀请</div>
        <div class="kpi-val">
          {{ metrics.total_users || 0 }} / {{ metrics.shared_nodes || 0 }} / {{ metrics.active_leases || 0 }} / {{ metrics.referral_count || 0 }}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">平台商业策略：通道差价 · 注册安全认证 · 推荐邀请返利 · 支付配置</div>
      <div class="grid-4">
        <div class="field">
          <label>WSS 反向穿透基准加价 (bps, 1000=10%)</label>
          <input class="input" type="number" min="0" max="10000" v-model.number="settings.saas_reverse_fee_bps" />
        </div>
        <div class="field">
          <label>公网 WSS 直连基准加价 (bps)</label>
          <input class="input" type="number" min="0" max="10000" v-model.number="settings.saas_public_wss_fee_bps" />
        </div>
        <div class="field">
          <label>自用 WSS 反穿 Hub 流量单价 (元/GB)</label>
          <input class="input" type="number" step="0.05" min="0" v-model.number="settings.saas_self_reverse_hub_gb_yuan" />
        </div>
        <div class="field">
          <label>自动评级 / 降级调度</label>
          <select class="select" v-model="settings.saas_auto_level_enabled">
            <option :value="true">开启 60s 自动升降级</option>
            <option :value="false">暂停自动升降级</option>
          </select>
        </div>

        <div class="field">
          <label>公开注册开关</label>
          <select class="select" v-model="settings.saas_allow_public_register">
            <option :value="true">开放公开注册</option>
            <option :value="false">仅限管理员分配</option>
          </select>
        </div>
        <div class="field">
          <label>新用户注册邮箱验证码认证</label>
          <select class="select" v-model="settings.saas_require_email_verify">
            <option :value="true">强制验证邮箱验证码</option>
            <option :value="false">关闭邮箱验证码校验</option>
          </select>
        </div>
        <div class="field">
          <label>推荐邀请奖励开关</label>
          <select class="select" v-model="settings.saas_referral_enabled">
            <option :value="true">开启邀请返利系统</option>
            <option :value="false">关闭邀请返利</option>
          </select>
        </div>
        <div class="field">
          <label>邀请人 / 被邀请人奖励 (元)</label>
          <div class="row">
            <input class="input" type="number" step="0.5" min="0" style="flex: 1" v-model.number="settings.saas_referral_inviter_bonus_yuan" title="邀请人奖励" />
            <input class="input" type="number" step="0.5" min="0" style="flex: 1" v-model.number="settings.saas_referral_invitee_bonus_yuan" title="新人额外奖励" />
          </div>
        </div>

        <div class="field">
          <label>新用户注册体验赠金 (元)</label>
          <input class="input" type="number" step="0.5" min="0" v-model.number="settings.saas_welcome_bonus_yuan" />
        </div>
        <div class="field">
          <label>每月固定领奖开关 & 金额 (元)</label>
          <div class="row">
            <select class="select" style="width: 90px" v-model="settings.saas_monthly_claim_enabled">
              <option :value="true">开启</option>
              <option :value="false">关闭</option>
            </select>
            <input class="input" type="number" step="1" min="0" v-model.number="settings.saas_monthly_claim_yuan" />
          </div>
        </div>
        <div class="field">
          <label>每日签到开关 & 基础奖励 (元)</label>
          <div class="row">
            <select class="select" style="width: 90px" v-model="settings.saas_daily_checkin_enabled">
              <option :value="true">开启</option>
              <option :value="false">关闭</option>
            </select>
            <input class="input" type="number" step="0.1" min="0" v-model.number="settings.saas_daily_checkin_yuan" />
          </div>
        </div>
        <div class="field">
          <label>每日连签递增奖励 (元/天)</label>
          <input class="input" type="number" step="0.05" min="0" v-model.number="settings.saas_daily_streak_bonus_yuan" />
        </div>

        <div class="field">
          <label>沙盒自助充值通道</label>
          <select class="select" v-model="settings.saas_allow_self_recharge">
            <option :value="true">允许沙盒一键入账</option>
            <option :value="false">关闭（仅扫码/回调/人工确认）</option>
          </select>
        </div>
        <div class="field">
          <label>支付宝收款开关 & AppID</label>
          <div class="row">
            <select class="select" style="width: 90px" v-model="settings.saas_alipay_enabled">
              <option :value="true">开启</option>
              <option :value="false">关闭</option>
            </select>
            <input class="input mono" placeholder="AppID" v-model="settings.saas_alipay_app_id" />
          </div>
        </div>
        <div class="field">
          <label>支付宝收款码链接 / 二维码串</label>
          <input class="input mono" placeholder="https://..." v-model="settings.saas_alipay_qr_url" />
        </div>
        <div class="field">
          <label>微信支付开关 & 商户号 MchID</label>
          <div class="row">
            <select class="select" style="width: 90px" v-model="settings.saas_wechat_enabled">
              <option :value="true">开启</option>
              <option :value="false">关闭</option>
            </select>
            <input class="input mono" placeholder="MchID" v-model="settings.saas_wechat_mch_id" />
          </div>
        </div>
        <div class="field">
          <label>微信支付收款码链接 / 二维码串</label>
          <input class="input mono" placeholder="weixin://..." v-model="settings.saas_wechat_qr_url" />
        </div>
        <div class="field">
          <label>支付回调 HMAC-SHA256 验签密钥</label>
          <input class="input mono" type="password" placeholder="留空不修改" v-model="settings.saas_payment_notify_secret" />
        </div>
      </div>
      <button class="btn btn-primary" @click="saveSettings">保存差价、认证、邀请与支付策略</button>
    </div>

    <NotificationSettingsCard @notify="(msg) => emit('notify', msg)" />

    <AnnouncementManager @notify="(msg) => emit('notify', msg)" />

    <div class="card">
      <div class="card-title">
        <span>用户等级自动升降级门槛 & 分级差价策略（按在线时长 · 节点速度 · 贡献流量）</span>
        <button class="btn btn-sm btn-emerald" @click="evaluateAllLevels">立即执行全网自动评级 / 降级</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>等级</th>
              <th>最低在线(h)</th>
              <th>最低贡献(GB)</th>
              <th>延迟上限(ms,0=不限)</th>
              <th>最低速度(KB/s)</th>
              <th>反穿加价(bps)</th>
              <th>WSS直连(bps)</th>
              <th>买家折扣(bps)</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="lv in levels" :key="lv.id">
              <td>
                <span class="tag" :style="{ color: lv.badge_color, borderColor: lv.badge_color }">{{ lv.name }}</span>
              </td>
              <td><input class="input mono" type="number" min="0" style="width: 72px" v-model.number="lv.min_online_hours" /></td>
              <td><input class="input mono" type="number" min="0" style="width: 72px" v-model.number="lv.min_contributed_gb" /></td>
              <td><input class="input mono" type="number" min="0" style="width: 78px" v-model.number="lv.max_avg_latency_ms" /></td>
              <td><input class="input mono" type="number" min="0" style="width: 78px" v-model.number="lv.min_speed_kbps" /></td>
              <td><input class="input mono" type="number" min="0" max="10000" style="width: 78px" v-model.number="lv.reverse_fee_bps" /></td>
              <td><input class="input mono" type="number" min="0" max="10000" style="width: 78px" v-model.number="lv.public_wss_fee_bps" /></td>
              <td><input class="input mono" type="number" min="0" max="10000" style="width: 78px" v-model.number="lv.buyer_discount_bps" /></td>
              <td><button class="btn btn-sm btn-primary" @click="saveLevel(lv)">保存</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-title">多租户账号治理、邮箱认证状态、邀请关系与余额调账</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>UID / 用户名 / 邮箱验证</th>
              <th>邀请码 / 推荐关系</th>
              <th>等级 / 信用质量指标</th>
              <th>角色 / 套餐 / 状态</th>
              <th>余额</th>
              <th>调账 / 等级锁 / 启停</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <td>
                <strong>#{{ u.id }} {{ u.username }}</strong>
                <span class="tag" :class="u.email_verified ? 'tag-ok' : 'tag-warn'" style="margin-left: 6px">
                  {{ u.email_verified ? '已认证邮箱' : '未验证' }}
                </span>
                <br />
                <span class="muted">{{ u.email || '-' }}</span>
              </td>
              <td class="mono">
                <div>码: {{ u.invite_code || '-' }} (已邀 {{ u.invited_count || 0 }} 人)</div>
                <div class="muted" style="font-size: 11px">推荐人: {{ u.inviter_username || '自主注册' }}</div>
              </td>
              <td>
                <div class="row" style="gap: 6px">
                  <span class="tag" :style="{ color: u.level_badge_color, borderColor: u.level_badge_color }">{{ u.level_name }}</span>
                  <span v-if="u.level_locked" class="tag tag-warn">锁定</span>
                  <span class="mono muted">{{ u.level_score }}分</span>
                </div>
                <div class="muted mono" style="font-size: 11px; margin-top: 4px">
                  {{ (Number(u.total_online_seconds || 0) / 3600).toFixed(1) }}h · {{ (Number(u.contributed_traffic_bytes || 0) / (1024 ** 3)).toFixed(2) }}GB
                </div>
              </td>
              <td>
                <span class="tag tag-info">{{ u.role }}</span> · {{ u.plan_name }}
                <span class="tag" :class="u.status === 'active' ? 'tag-ok' : 'tag-danger'" style="margin-left: 4px">{{ u.status }}</span>
              </td>
              <td class="mono">¥{{ u.balance_yuan }}</td>
              <td>
                <div class="row">
                  <button class="btn btn-sm" @click="adjustBalance(u.id, 100)">+¥100</button>
                  <button class="btn btn-sm" @click="toggleLevelLock(u)">{{ u.level_locked ? '解锁等级' : '锁死等级' }}</button>
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
      <div class="card-title">
        <span>全网推荐邀请奖励流水</span>
        <span class="mono muted" style="font-size: 12px">
          累计邀请 {{ referralSummary.total_referrals || 0 }} 次 · 邀请人返利 ¥{{ referralSummary.total_inviter_bonus_yuan || '0.00' }} · 新人赠金 ¥{{ referralSummary.total_invitee_bonus_yuan || '0.00' }}
        </span>
      </div>
      <div v-if="referralRewards.length === 0" class="muted">暂无邀请奖励记录。</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr><th>ID</th><th>邀请人</th><th>受邀新用户</th><th>邀请人返利</th><th>新人赠金</th><th>状态</th><th>时间</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in referralRewards" :key="r.id">
              <td class="mono">#{{ r.id }}</td>
              <td><strong>{{ r.inviter_username }}</strong> (#{{ r.inviter_id }})</td>
              <td>{{ r.invitee_username }} (#{{ r.invitee_id }})</td>
              <td class="mono" style="color: #34d399">¥{{ r.inviter_bonus_yuan }}</td>
              <td class="mono">¥{{ r.invitee_bonus_yuan }}</td>
              <td><span class="tag tag-ok">{{ r.status }}</span></td>
              <td class="mono muted">{{ r.created_at }}</td>
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
              <th>租约 ID / 节点 / 通道</th>
              <th>买家实付</th>
              <th>卖家实得</th>
              <th>平台差价盈利</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in recentLeases" :key="l.id">
              <td class="mono">
                #{{ l.id }} · Node#{{ l.node_id }} (Seller#{{ l.seller_id }}[{{ l.seller_level_code }}] → Buyer#{{ l.buyer_id }}) · {{ l.channel_type }} ({{ ((l.platform_fee_bps || 0) / 100).toFixed(1) }}%)
              </td>
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

    <div class="card">
      <div class="card-title">全网支付宝 / 微信充值订单管理与人工核账</div>
      <div v-if="recharges.length === 0" class="muted">暂无充值订单。</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>订单号</th>
              <th>租户</th>
              <th>渠道</th>
              <th>金额</th>
              <th>状态 / 外部流水号</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in recharges" :key="o.id">
              <td class="mono">{{ o.order_no }}</td>
              <td>{{ o.username }} (#{{ o.user_id }})</td>
              <td>{{ o.channel === 'alipay' ? '支付宝' : '微信支付' }}</td>
              <td class="mono">¥{{ o.amount_yuan }}</td>
              <td>
                <span class="tag" :class="o.status === 'paid' ? 'tag-ok' : 'tag-warn'">{{ o.status }}</span>
                <span class="muted mono" style="margin-left: 6px; font-size: 11px">{{ o.external_trade_no || '-' }}</span>
              </td>
              <td class="mono">{{ o.paid_at || o.created_at }}</td>
              <td>
                <button v-if="o.status === 'pending'" class="btn btn-sm btn-emerald" @click="confirmRecharge(o.id)">人工确认到账</button>
                <span v-else class="muted">已入账</span>
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
import { apiFetch } from '../../api'
import AnnouncementManager from '../announcements/AnnouncementManager.vue'
import NotificationSettingsCard from '../notifications/NotificationSettingsCard.vue'

const emit = defineEmits(['notify'])
const metrics = ref({})
const users = ref([])
const levels = ref([])
const recentLeases = ref([])
const recharges = ref([])
const referralSummary = ref({})
const referralRewards = ref([])

const settings = reactive({
  saas_reverse_fee_bps: 2500,
  saas_public_wss_fee_bps: 1000,
  saas_self_reverse_hub_gb_yuan: 0.2,
  saas_auto_level_enabled: true,
  saas_allow_public_register: true,
  saas_require_email_verify: true,
  saas_referral_enabled: true,
  saas_referral_inviter_bonus_yuan: 5,
  saas_referral_invitee_bonus_yuan: 3,
  saas_allow_self_recharge: true,
  saas_welcome_bonus_yuan: 10,
  saas_monthly_claim_enabled: true,
  saas_monthly_claim_yuan: 10,
  saas_daily_checkin_enabled: true,
  saas_daily_checkin_yuan: 0.5,
  saas_daily_streak_bonus_yuan: 0.1,
  saas_alipay_enabled: true,
  saas_alipay_app_id: '',
  saas_alipay_qr_url: '',
  saas_wechat_enabled: true,
  saas_wechat_mch_id: '',
  saas_wechat_qr_url: '',
  saas_payment_notify_secret: '',
})

async function load() {
  try {
    const [ov, us, rc, refRes] = await Promise.all([
      apiFetch('/api/admin/overview'),
      apiFetch('/api/admin/users'),
      apiFetch('/api/admin/recharges'),
      apiFetch('/api/admin/referrals'),
    ])
    metrics.value = ov.metrics || {}
    Object.assign(settings, ov.settings || {})
    levels.value = ov.levels || []
    recentLeases.value = ov.recent_leases || []
    users.value = us || []
    recharges.value = rc.orders || []
    referralSummary.value = refRes.summary || {}
    referralRewards.value = refRes.rewards || []
  } catch (e) {
    emit('notify', e.message)
  }
}

async function saveSettings() {
  try {
    const res = await apiFetch('/api/admin/settings', { method: 'POST', body: JSON.stringify(settings) })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function confirmRecharge(orderId) {
  try {
    const res = await apiFetch(`/api/admin/recharges/${orderId}/confirm`, { method: 'POST' })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function saveLevel(lv) {
  try {
    const res = await apiFetch(`/api/admin/levels/${lv.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        min_online_hours: lv.min_online_hours,
        min_contributed_gb: lv.min_contributed_gb,
        max_avg_latency_ms: lv.max_avg_latency_ms,
        min_speed_kbps: lv.min_speed_kbps,
        reverse_fee_bps: lv.reverse_fee_bps,
        public_wss_fee_bps: lv.public_wss_fee_bps,
        buyer_discount_bps: lv.buyer_discount_bps,
      }),
    })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function evaluateAllLevels() {
  try {
    const res = await apiFetch('/api/admin/levels/evaluate', { method: 'POST' })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function toggleLevelLock(u) {
  try {
    const res = await apiFetch(`/api/admin/users/${u.id}`, {
      method: 'PUT',
      body: JSON.stringify({ level_locked: !u.level_locked }),
    })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
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
