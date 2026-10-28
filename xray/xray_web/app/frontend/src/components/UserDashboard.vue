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

    <!-- 2. 多卡密批量充值 -->
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

    <!-- 3. 节点列表与通用聚合订阅 -->
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

    <!-- 4. 用户安全中心与偏好设置 (双列对称布局) -->
    <div class="cyber-card col-span-2">
      <div class="card-header">
        <h3>🔔 账号安全中心与通知偏好</h3>
      </div>
      <div class="settings-2col-layout">
        <!-- 左列：通知通道设置 + 更换绑定邮箱 -->
        <div class="column-stack">
          <!-- 面板 1：通知通道设置 -->
          <div class="panel-card">
            <h4>1. 到期与流量预警通道选择</h4>
            <div class="form-item" style="margin-top: 10px;">
              <div class="radio-group">
                <label class="radio-label">
                  <input type="radio" value="email" v-model="notifyForm.notify_type" /> 📧 电子邮箱接收 ({{ currentUser.email || '未绑定' }})
                </label>
                <label class="radio-label">
                  <input type="radio" value="serverchan" v-model="notifyForm.notify_type" /> 📲 Server酱 (微信服务号直推)
                </label>
              </div>
            </div>

            <div class="form-item" v-if="notifyForm.notify_type === 'serverchan'">
              <label>Server酱 SendKey：</label>
              <input v-model="notifyForm.serverchan_key" type="text" class="cyber-input font-mono" placeholder="SCTxxxxxxxxxx" />
            </div>

            <div class="btn-group" style="margin-top: 14px;">
              <button class="btn-cyber-success" style="padding: 6px 14px; font-size: 12px;" @click="saveNotifySettings">保存通知设置</button>
              <button class="btn-cyber-action" style="padding: 6px 14px; font-size: 12px;" @click="testUserNotify">发送测试通知</button>
            </div>
          </div>

          <!-- 面板 2：核心新增 更换绑定电子邮箱 (带新邮箱真实性验证) -->
          <div class="panel-card">
            <h4>2. 更换绑定电子邮箱 (新邮箱验证)</h4>
            <div style="font-size: 12px; color: #94a3b8; margin: 8px 0 12px 0;">
              当前绑定邮箱：<b class="text-cyan">{{ currentUser.email || '尚未绑定' }}</b>
            </div>

            <div class="form-item">
              <label>拟绑定的新电子邮箱</label>
              <div class="code-send-group" style="max-width: 500px;">
                <input v-model="emailForm.new_email" type="email" class="cyber-input" placeholder="输入新的接收邮箱" />
                <button class="btn-cyber-code" :disabled="emailCountdown > 0 || sendingEmailCode" @click="sendChangeEmailCode">
                  {{ emailCountdown > 0 ? `${emailCountdown}s 后重试` : (sendingEmailCode ? '发送中...' : '发送新邮箱验证码') }}
                </button>
              </div>
            </div>

            <div class="form-item">
              <label>新邮箱接收到的 6 位验证码</label>
              <input v-model="emailForm.code" type="text" class="cyber-input" placeholder="输入新邮箱收到的验证码" />
            </div>

            <div class="form-item">
              <label>当前账号登录密码 (身份确认)</label>
              <input v-model="emailForm.password" type="password" class="cyber-input" placeholder="输入当前登录密码确认改绑" />
            </div>

            <button class="btn-cyber-primary" :disabled="loadingChangeEmail" style="width: auto; padding: 7px 22px; font-size: 12px;" @click="submitChangeEmail">
              {{ loadingChangeEmail ? '正在验证改绑...' : '确认更换绑定邮箱' }}
            </button>
          </div>
        </div>

        <!-- 右列：修改账户登录密码 -->
        <div class="column-stack">
          <div class="panel-card">
            <h4>3. 修改账户登录密码</h4>
            <div class="form-item" style="margin-top: 10px;">
              <label>当前原旧密码</label>
              <input v-model="pwdForm.old_pwd" type="password" class="cyber-input" placeholder="输入当前原旧密码" />
            </div>
            <div class="form-item">
              <label>设置新密码 (至少 6 位)</label>
              <input v-model="pwdForm.new_pwd" type="password" class="cyber-input" placeholder="输入新密码" />
            </div>
            <div class="form-item">
              <label>再次确认新密码</label>
              <input v-model="pwdForm.confirm_pwd" type="password" class="cyber-input" placeholder="再次输入新密码" />
            </div>
            <button class="btn-cyber-primary" style="width: auto; padding: 7px 22px; font-size: 12px; margin-top: 6px;" @click="submitChangePassword">
              确认变更登录密码
            </button>
          </div>
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

// 更换绑定邮箱状态
const emailForm = reactive({
  new_email: '',
  code: '',
  password: ''
})
const emailCountdown = ref(0)
const sendingEmailCode = ref(false)
const loadingChangeEmail = ref(false)

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

// 核心功能 1：向拟绑定的新邮箱投递验证码 (验证真实性)
const sendChangeEmailCode = async () => {
  if (!emailForm.new_email || !emailForm.new_email.includes('@')) {
    return ElMessage.warning('请输入合法的新电子邮箱地址')
  }
  if (emailForm.new_email.trim().toLowerCase() === (props.currentUser.email || '').toLowerCase()) {
    return ElMessage.warning('新邮箱不能与当前已绑定的旧邮箱相同')
  }

  sendingEmailCode.value = true
  try {
    const res = await axios.post('/api/user/send_change_email_code', {
      username: props.currentUser.username,
      new_email: emailForm.new_email
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emailCountdown.value = 60
      const timer = setInterval(() => {
        emailCountdown.value--
        if (emailCountdown.value <= 0) clearInterval(timer)
      }, 1000)
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('发送验证码请求失败')
  } finally {
    sendingEmailCode.value = false
  }
}

// 核心功能 2：校验验证码与密码，执行换绑
const submitChangeEmail = async () => {
  if (!emailForm.new_email || !emailForm.code || !emailForm.password) {
    return ElMessage.warning('请填写新邮箱、验证码以及登录密码')
  }

  loadingChangeEmail.value = true
  try {
    const res = await axios.post('/api/user/change_email', {
      username: props.currentUser.username,
      new_email: emailForm.new_email,
      code: emailForm.code,
      password: emailForm.password
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emailForm.new_email = ''
      emailForm.code = ''
      emailForm.password = ''
      emit('refresh-user')
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('修改绑定邮箱失败')
  } finally {
    loadingChangeEmail.value = false
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