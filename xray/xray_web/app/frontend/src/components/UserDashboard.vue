<template>
  <div class="dashboard-grid">
    <!-- 1. 流量监控与配额 -->
    <div class="cyber-card">
      <div class="card-header">
        <h3>📊 流量监控与配额</h3>
        <span class="tag-status">ONLINE</span>
      </div>
      <div class="traffic-meter">
        <div class="meter-info">
          <div>
            <span class="data-val">{{ currentUser.used_mb }}</span>
            <span class="data-unit">MB (已用)</span>
          </div>
          <div class="text-right">
            <span class="data-val">{{ currentUser.limit_mb === 0 ? '♾️' : currentUser.limit_mb }}</span>
            <span class="data-unit">{{ currentUser.limit_mb === 0 ? '不限流量' : 'MB (总额)' }}</span>
          </div>
        </div>
        <div class="progress-track">
          <div class="progress-glow" :style="{ width: trafficPercent + '%' }"></div>
        </div>
        <div class="expiry-notice">
          <span>套餐有效期：</span>
          <strong class="highlight-date">
            {{ (currentUser.expire_date && currentUser.expire_date.startsWith('2099')) ? '♾️ 永久有效' : currentUser.expire_date }}
          </strong>
          <span v-if="currentUser.is_monthly === 1" class="monthly-tag">🔄 每月 {{ currentUser.reset_day }} 号重置</span>
        </div>
      </div>
    </div>

    <!-- 2. 多卡密一键批量充值卡片 -->
    <div class="cyber-card">
      <div class="card-header">
        <h3>🎟️ 卡密充值续费 (支持多卡批量充值)</h3>
      </div>
      <p class="card-desc">支持单张或多张卡密（每行一张或空格分隔），一键自动批量累加核销：</p>
      <div class="redeem-box">
        <textarea v-model="rechargeCode" class="cyber-input cyber-textarea redeem-textarea" placeholder="KM-XXXX-XXXX&#10;KM-YYYY-YYYY (支持同时粘贴多张卡密)"></textarea>
        <button class="btn-cyber-success" :disabled="loading" style="height: auto; align-self: stretch;" @click="handleRecharge">
          {{ loading ? '核销中...' : '立即批量充值' }}
        </button>
      </div>
    </div>

    <!-- 3. 节点列表与通用聚合订阅 (1节点1卡片，支持多 SNI 下拉切换联动与用户自主重置 UUID) -->
    <div class="cyber-card col-span-2">
      <div class="card-header header-nowrap-row">
        <h3 class="header-title-text">🌐 全球加速节点列表与通用订阅 (共 {{ currentUser.nodes ? currentUser.nodes.length : 0 }} 个节点)</h3>
        <div style="display: flex; gap: 8px; flex-shrink: 0;">
          <button class="btn-header-action btn-cyber-primary" @click="$emit('copy', currentUser.sub_url)">
            🔗 一键复制全节点订阅链接
          </button>
          <button class="btn-header-action btn-cyber-danger" @click="handleUserResetUuid">
            🔄 重置凭据 (UUID)
          </button>
        </div>
      </div>

      <p class="card-desc">
        每个物理节点精炼输出 1 条线路。系统默认随机挑选伪装 SNI 分散审查，您亦可在下方下拉自选：
      </p>

      <div class="node-grid">
        <div v-for="node in currentUser.nodes" :key="node.id" class="node-card">
          <div class="node-header">
            <span class="node-title">{{ node.name }}</span>
            <span class="badge badge-ready">🟢 在线加速</span>
          </div>
          <div class="node-detail">
            <div>地址: {{ node.ip }}:{{ node.port }}</div>

            <!-- 多 SNI 候选列表下拉选择器 -->
            <div v-if="node.server_names && node.server_names.length > 1" class="sni-select-wrap">
              <label style="color: #94a3b8;">伪装SNI:</label>
              <select v-model="node.selected_sni" class="cyber-select" @change="onUserChangeNodeSni(node)">
                <option v-for="s in node.server_names" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>
            <div v-else style="font-size: 11px; color: #64748b; margin-top: 4px;">
              伪装SNI: {{ node.selected_sni || (node.server_names ? node.server_names[0] : '默认') }}
            </div>
          </div>

          <div class="btn-group" style="margin-top: 12px; gap: 6px;">
            <button class="btn-sm btn-action" @click="$emit('copy', node.link)">📋 复制</button>
            <button class="btn-sm btn-edit" @click="$emit('open-qr', { link: node.link, name: node.name })">📱 扫码</button>
            <button class="btn-sm btn-cyber-download" @click="downloadWindowsClient(node.id, node.name, node.selected_sni)">🖥️ 下载客户端</button>
          </div>
        </div>

        <div v-if="!currentUser.nodes || currentUser.nodes.length === 0" class="empty-node-tip">
          暂无在线节点，请等待管理员启动并接入 xray_core 远程节点。
        </div>
      </div>
    </div>

    <!-- 4. 用户通知偏好与安全设置 -->
    <div class="cyber-card col-span-2">
      <div class="card-header">
        <h3>🔔 告警通知偏好与安全中心</h3>
      </div>
      <div class="settings-2col-layout">
        <div class="panel-card">
          <h4>1. 到期与流量微信/邮件通知设置</h4>
          <div class="form-item">
            <label>首选通知通道 (默认邮件)</label>
            <div class="radio-group">
              <label class="radio-label">
                <input type="radio" value="email" v-model="notifyForm.notify_type" /> 📧 电子邮箱通知 ({{ currentUser.email || '未绑定' }})
              </label>
              <label class="radio-label">
                <input type="radio" value="serverchan" v-model="notifyForm.notify_type" /> 📲 Server酱 (微信推送)
              </label>
            </div>
          </div>

          <div class="form-item" v-if="notifyForm.notify_type === 'serverchan'">
            <label>Server酱 SendKey：</label>
            <input v-model="notifyForm.serverchan_key" type="text" class="cyber-input font-mono" placeholder="SCTxxxxxxxxxx" />
          </div>

          <div class="btn-group" style="margin-top: 15px;">
            <button class="btn-cyber-success" @click="saveNotifySettings">保存通知设置</button>
            <button class="btn-cyber-action" @click="testUserNotify">发送测试通知</button>
          </div>
        </div>

        <div class="panel-card">
          <h4>2. 修改账户登录密码</h4>
          <div class="form-item">
            <label>当前原密码</label>
            <input v-model="pwdForm.old_pwd" type="password" class="cyber-input" placeholder="输入当前原密码" />
          </div>
          <div class="form-item">
            <label>新密码 (至少6位)</label>
            <input v-model="pwdForm.new_pwd" type="password" class="cyber-input" placeholder="输入新密码" />
          </div>
          <div class="form-item">
            <label>确认新密码</label>
            <input v-model="pwdForm.confirm_pwd" type="password" class="cyber-input" placeholder="再次输入新密码" />
          </div>
          <button class="btn-cyber-primary" style="margin-top: 5px;" @click="submitChangePassword">确认变更密码</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

const props = defineProps({
  currentUser: { type: Object, required: true }
})

const emit = defineEmits(['copy', 'open-qr', 'refresh-user', 'logout'])

const loading = ref(false)
const rechargeCode = ref('')

const notifyForm = reactive({
  notify_type: props.currentUser.notify_type || 'email',
  serverchan_key: props.currentUser.serverchan_key || ''
})

const pwdForm = reactive({ old_pwd: '', new_pwd: '', confirm_pwd: '' })

const trafficPercent = computed(() => {
  if (!props.currentUser.limit_mb) return 100
  return Math.min(100, Math.round((props.currentUser.used_mb / props.currentUser.limit_mb) * 100))
})

const onUserChangeNodeSni = (node) => {
  if (!node.link || !node.selected_sni) return
  node.link = node.link.replace(/sni=[^&]+/, `sni=${node.selected_sni}`)
  ElMessage.success(`已切换该节点的伪装 SNI 为: ${node.selected_sni}`)
}

const handleUserResetUuid = async () => {
  const tip =
    `⚠️ 确定要重置您的节点连接凭证 (UUID) 吗？\n\n` +
    `【为什么需要重置？】\n` +
    `如果您的节点链接或订阅地址不慎泄露、分享给他人或怀疑被盗刷，可通过重置 UUID 让旧凭证彻底失效。\n\n` +
    `【重置后要做什么？】\n` +
    `重置后原有的全部节点链接与订阅将【立即失效断网】！您需要在电脑/手机客户端中重新复制最新订阅地址并【更新订阅】。\n\n` +
    `确认重置吗？`

  if (!confirm(tip)) return
  try {
    const res = await axios.post('/api/user/reset_uuid', { username: props.currentUser.username })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emit('refresh-user')
    }
  } catch (_) {
    ElMessage.error('重置凭证失败')
  }
}

const downloadWindowsClient = (nodeId = '', nodeName = '', sni = '') => {
  if (!props.currentUser.username) return ElMessage.warning('用户未就绪')
  ElMessage.info(`正在为您打包 ${nodeName || '默认节点'} 的客户端...`)

  let downloadUrl = `/api/user/download_client?username=${encodeURIComponent(props.currentUser.username)}&node_id=${nodeId}`
  if (sni) {
    downloadUrl += `&sni=${encodeURIComponent(sni)}`
  }
  const a = document.createElement('a')
  a.href = downloadUrl
  a.download = `Xray_Windows_${props.currentUser.username}.zip`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

const handleRecharge = async () => {
  if (!rechargeCode.value || !rechargeCode.value.trim()) return ElMessage.warning('请输入至少一张卡密')
  loading.value = true
  try {
    const res = await axios.post('/api/recharge', {
      username: props.currentUser.username,
      card_code: rechargeCode.value
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      rechargeCode.value = ''
      emit('refresh-user')
    } else {
      ElMessage.error(res.data.msg)
    }
  } finally {
    loading.value = false
  }
}

const saveNotifySettings = async () => {
  try {
    const res = await axios.post('/api/user/notify_settings', {
      username: props.currentUser.username,
      notify_type: notifyForm.notify_type,
      serverchan_key: notifyForm.serverchan_key
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emit('refresh-user')
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('保存失败')
  }
}

const testUserNotify = async () => {
  try {
    const res = await axios.post('/api/user/test_notify', { username: props.currentUser.username })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('测试发送失败')
  }
}

const submitChangePassword = async () => {
  if (!pwdForm.old_pwd || !pwdForm.new_pwd) return ElMessage.warning('请输入密码')
  if (pwdForm.new_pwd !== pwdForm.confirm_pwd) return ElMessage.warning('两次密码不一致')
  try {
    const res = await axios.post('/api/user/change_password', {
      username: props.currentUser.username,
      old_password: pwdForm.old_pwd,
      new_password: pwdForm.new_pwd
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emit('logout')
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('改密失败')
  }
}
</script>