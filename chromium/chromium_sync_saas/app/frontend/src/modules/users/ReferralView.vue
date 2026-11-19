<template>
  <div>
    <div class="grid-4">
      <div class="card">
        <div class="kpi-label">我的专属邀请码</div>
        <div class="kpi-val" style="color: #38bdf8">{{ overview.invite_code || '-' }}</div>
      </div>
      <div class="card">
        <div class="kpi-label">成功邀请注册人数</div>
        <div class="kpi-val">{{ overview.invited_count || 0 }} 人</div>
      </div>
      <div class="card">
        <div class="kpi-label">累计邀请奖励收益</div>
        <div class="kpi-val" style="color: #34d399">+¥{{ overview.total_earned_yuan || '0.00' }}</div>
      </div>
      <div class="card">
        <div class="kpi-label">当前激励政策</div>
        <div class="kpi-val" style="font-size: 16px; color: #facc15">
          邀请人 +¥{{ overview.inviter_bonus_yuan || '5.00' }} / 新人 +¥{{ overview.invitee_bonus_yuan || '3.00' }}
        </div>
        <div class="muted" style="font-size: 11px; margin-top: 4px">
          状态：{{ overview.referral_enabled ? '已开启返利' : '活动暂停' }}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <span>分享您的专属邀请链接（好友注册完成邮箱验证后双方即时到账）</span>
        <button class="btn btn-sm" :disabled="refreshing" @click="load(true)">
          {{ refreshing ? '刷新中...' : '刷新收益明细' }}
        </button>
      </div>
      <div class="grid-2">
        <div class="field">
          <label>我的专属邀请码</label>
          <div class="row">
            <input class="input mono" :value="overview.invite_code" readonly style="flex: 1" />
            <button class="btn btn-sm btn-primary" @click="copy(overview.invite_code, '邀请码已复制')">复制邀请码</button>
          </div>
        </div>
        <div class="field">
          <label>专属推广注册链接</label>
          <div class="row">
            <input class="input mono" :value="inviteLink" readonly style="flex: 1" />
            <button class="btn btn-sm btn-emerald" @click="copy(inviteLink, '专属邀请链接已复制')">复制链接</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">我的邀请返利明细记录</div>
      <div v-if="rewards.length === 0" class="muted">暂无邀请记录，将您的专属链接分享给好友或合作伙伴即可赚取钱包余额奖励。</div>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>奖励流水 ID</th>
              <th>受邀新租户</th>
              <th>我的邀请返利</th>
              <th>新人额外获赠</th>
              <th>状态</th>
              <th>发放时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rewards" :key="r.id">
              <td class="mono">#{{ r.id }}</td>
              <td><strong>{{ r.invitee_username }}</strong> (uid={{ r.invitee_id }})</td>
              <td class="mono" style="color: #34d399">+¥{{ r.inviter_bonus_yuan }}</td>
              <td class="mono">¥{{ r.invitee_bonus_yuan }}</td>
              <td><span class="tag tag-ok">{{ r.status }}</span></td>
              <td class="mono muted">{{ r.created_at }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { apiFetch } from '../../api'

const emit = defineEmits(['notify'])
const overview = ref({
  referral_enabled: true,
  invite_code: '',
  inviter_bonus_yuan: '5.00',
  invitee_bonus_yuan: '3.00',
  invited_count: 0,
  total_earned_yuan: '0.00',
})
const rewards = ref([])
const refreshing = ref(false)

const inviteLink = computed(() => {
  if (!overview.value.invite_code) return ''
  return `${window.location.origin}/?ref=${overview.value.invite_code}`
})

async function load(showFeedback = false) {
  if (refreshing.value) return
  refreshing.value = true
  try {
    const res = await apiFetch('/api/referrals/overview')
    overview.value = res
    rewards.value = res.rewards || []
    if (showFeedback) {
      emit('notify', { message: '邀请返利明细已刷新', type: 'info' })
    }
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    refreshing.value = false
  }
}

function copy(val, msg) {
  if (!val) return
  navigator.clipboard?.writeText(val)
  emit('notify', { message: msg, type: 'ok' })
}

onMounted(() => load(false))
</script>
