<script setup>
import { ref, reactive, onMounted } from 'vue'

const props = defineProps({
  api: Function,
  showToast: Function
})
const emit = defineEmits(['update-status'])

// 配置数据
const notif = reactive({
  // 左侧：SMTP 服务器基础参数
  smtp_host: 'smtp.yeah.net',
  smtp_port: '465',
  smtp_ssl: true,
  smtp_sender_name: 'CDP 节点中心',
  smtp_user: '',
  smtp_pass: '',
  smtp_status: 'untested',

  // 右侧通道 1：邮件推送开关与接收邮箱
  email_notify_enabled: false,
  email_notify_to: '',

  // 右侧通道 2：Server酱微信推送开关与 SendKey
  serverchan_enabled: false,
  serverchan_key: ''
})

const testEmailTarget = ref('')
const isTestingEmail = ref(false)
const isTestingServerChan = ref(false)

const loadSettings = async () => {
  const res = await props.api('/api/notifications/settings')
  if (res.ok) {
    const data = await res.json()
    Object.assign(notif, data)
  }
}

// 保存左侧 SMTP
const saveSmtpServer = async () => {
  const res = await props.api('/api/notifications/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      smtp_host: notif.smtp_host,
      smtp_port: notif.smtp_port,
      smtp_ssl: notif.smtp_ssl,
      smtp_sender_name: notif.smtp_sender_name,
      smtp_user: notif.smtp_user,
      smtp_pass: notif.smtp_pass
    })
  })
  if (res.ok) {
    props.showToast('SMTP 发信服务器参数已保存', 'success')
    emit('update-status')
  }
}

// 保存右侧 邮件推送设置
const saveEmailChannel = async () => {
  const res = await props.api('/api/notifications/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email_notify_enabled: notif.email_notify_enabled,
      email_notify_to: notif.email_notify_to
    })
  })
  if (res.ok) {
    props.showToast('邮件告警通道已更新', 'success')
    emit('update-status')
  }
}

// 保存右侧 Server酱设置
const saveServerChanChannel = async () => {
  const res = await props.api('/api/notifications/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serverchan_enabled: notif.serverchan_enabled,
      serverchan_key: notif.serverchan_key
    })
  })
  if (res.ok) {
    props.showToast('Server酱微信通道已更新', 'success')
    emit('update-status')
  }
}

// 测试邮件外发
const testEmail = async () => {
  if (isTestingEmail.value) return
  isTestingEmail.value = true
  try {
    const res = await props.api('/api/notifications/test-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_email: testEmailTarget.value || notif.email_notify_to })
    })
    const data = await res.json()
    if (res.ok) {
      notif.smtp_status = 'ready'
      props.showToast(data.message, 'success')
      emit('update-status')
    } else {
      notif.smtp_status = 'error'
      props.showToast(data.detail || '发信受阻', 'error')
    }
  } finally {
    isTestingEmail.value = false
  }
}

// 测试 Server酱推送
const testServerChan = async () => {
  if (isTestingServerChan.value) return
  isTestingServerChan.value = true
  try {
    const res = await props.api('/api/notifications/test-serverchan', { method: 'POST' })
    const data = await res.json()
    if (res.ok) props.showToast(data.message, 'success')
    else props.showToast(data.detail || '推送失败', 'error')
  } finally {
    isTestingServerChan.value = false
  }
}

onMounted(() => {
  loadSettings()
})
</script>

<template>
  <div class="grid-2col-fluid">
    
    <!-- ==================== 左侧：仅 SMTP 服务器配置 (内容宽度自适应) ==================== -->
    <div class="content-full-card">
      <div class="smtp-title-header">
        <div class="smtp-icon-box">📧</div>
        <div>
          <h3 class="smtp-title-text">SMTP 发信服务器参数配置</h3>
          <p class="smtp-sub-text">基础外发引擎，为系统所有邮件通道提供发信支撑</p>
        </div>
      </div>

      <!-- 动态状态指示灯 -->
      <div class="smtp-status-indicator">
        <span v-if="notif.smtp_status === 'ready'" class="dot-green">●</span>
        <span v-else-if="notif.smtp_status === 'error'" class="dot-red">✕</span>
        <span v-else class="dot-gray">○</span>

        <span class="status-txt">
          SMTP 状态:
          <span v-if="notif.smtp_status === 'ready'" style="color:#34d399; font-weight:bold;">就绪 (发信正常)</span>
          <span v-else-if="notif.smtp_status === 'error'" style="color:#f87171; font-weight:bold;">异常 (发信受阻)</span>
          <span v-else style="color:#94a3b8;">待测试</span>
        </span>
      </div>

      <div class="form-v-stack" style="margin-top:16px;">
        <div class="form-field-block">
          <label class="form-label">SMTP 服务器地址</label>
          <input v-model="notif.smtp_host" placeholder="smtp.yeah.net" class="cdp-input cdp-w-normal">
        </div>

        <!-- 组合行：端口紧凑自适应 (120px) + 发件人显示名称 (240px) -->
        <div class="row-flex-gap">
          <div class="form-field-block">
            <label class="form-label">端口</label>
            <input v-model="notif.smtp_port" placeholder="465" class="cdp-input cdp-w-port font-cyan-mono">
          </div>
          <div class="form-field-block">
            <label class="form-label">发件人显示名称</label>
            <input v-model="notif.smtp_sender_name" placeholder="CDP 节点中心" class="cdp-input cdp-w-medium">
          </div>
        </div>

        <div class="form-field-block">
          <label class="form-label">发信邮箱账号</label>
          <input v-model="notif.smtp_user" placeholder="perrywu@yeah.net" class="cdp-input cdp-w-normal font-cyan-mono">
        </div>

        <div class="form-field-block">
          <label class="form-label">邮箱授权码 / 密码</label>
          <input v-model="notif.smtp_pass" type="password" placeholder="•••••• (留空保持原密码)" class="cdp-input cdp-w-normal">
        </div>

        <div style="display:flex; align-items:center; gap:8px; margin-top:2px;">
          <input type="checkbox" v-model="notif.smtp_ssl" id="ssl_box" class="check-box-blue">
          <label for="ssl_box" style="font-size:12px; color:#cbd5e1; cursor:pointer;">启用 SSL 安全加密</label>
        </div>

        <!-- 独立测试发信区 -->
        <div class="smtp-test-dashed-area">
          <input v-model="testEmailTarget" placeholder="接收测试邮箱 (test@example.com)" class="cdp-input cdp-w-normal">
          <button @click="testEmail" :disabled="isTestingEmail" class="btn-gray-test">
            {{ isTestingEmail ? '正在投递...' : '发信测试' }}
          </button>
        </div>

        <div style="margin-top:6px;">
          <button @click="saveSmtpServer" class="btn-primary-gradient">
            保存 SMTP 参数
          </button>
        </div>
      </div>
    </div>

    <!-- ==================== 右侧：推送通知列表 (开启时才展示相关配置) ==================== -->
    <div class="content-full-card">
      <div class="smtp-title-header">
        <div class="smtp-icon-box" style="background:#0e3b5e; border-color:#0284c7;">🔔</div>
        <div>
          <h3 class="smtp-title-text">告警推送通知列表 (2项可选)</h3>
          <p class="smtp-sub-text">当集群节点离线、探针故障或 Cookie 同步异常时触发通知</p>
        </div>
      </div>

      <div class="notify-channels-container">
        
        <!-- 通道 1: 📧 邮件告警推送 (开启时才展示设置) -->
        <div class="channel-card-item">
          <div class="channel-card-header">
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:18px;">📧</span>
              <div>
                <span class="channel-title">邮件告警推送通道 (Email)</span>
                <span v-if="notif.email_notify_enabled" class="badge-channel-on">● 已启用</span>
                <span v-else class="badge-channel-off">○ 未启用</span>
              </div>
            </div>
            
            <div style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" v-model="notif.email_notify_enabled" id="email_toggle" class="check-box-blue" @change="saveEmailChannel">
              <label for="email_toggle" style="font-size:12px; color:#cbd5e1; cursor:pointer;">开启推送</label>
            </div>
          </div>

          <!-- 仅在开启推送时才显示出对应相关设置 -->
          <div v-if="notif.email_notify_enabled" class="channel-expand-content">
            <div class="form-field-block">
              <label class="form-label">接收预警邮箱</label>
              <input v-model="notif.email_notify_to" placeholder="admin@domain.com (留空默认发至发信邮箱)" class="cdp-input cdp-w-normal font-cyan-mono">
              <p class="form-field-hint">故障发生时系统将通过左侧 SMTP 发信引擎投递预警邮件到此地址。</p>
            </div>

            <div class="channel-action-row">
              <button @click="saveEmailChannel" class="btn-primary-gradient">
                保存邮件推送设置
              </button>
              <button @click="testEmail" :disabled="isTestingEmail" class="btn-gray-test">
                {{ isTestingEmail ? '测试中...' : '发送测试邮件' }}
              </button>
            </div>
          </div>
        </div>

        <!-- 通道 2: 📱 Server酱微信实时推送 (开启时才展示设置) -->
        <div class="channel-card-item">
          <div class="channel-card-header">
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:18px;">📱</span>
              <div>
                <span class="channel-title">Server酱微信服务号推送 (WeChat)</span>
                <span v-if="notif.serverchan_enabled" class="badge-channel-on">● 已启用</span>
                <span v-else class="badge-channel-off">○ 未启用</span>
              </div>
            </div>

            <div style="display:flex; align-items:center; gap:6px;">
              <input type="checkbox" v-model="notif.serverchan_enabled" id="serverchan_toggle" class="check-box-blue" @change="saveServerChanChannel">
              <label for="serverchan_toggle" style="font-size:12px; color:#cbd5e1; cursor:pointer;">开启推送</label>
            </div>
          </div>

          <!-- 仅在开启推送时才显示出对应相关设置 -->
          <div v-if="notif.serverchan_enabled" class="channel-expand-content">
            <div class="form-field-block">
              <label class="form-label">Server酱 SendKey</label>
              <input v-model="notif.serverchan_key" placeholder="SCTxxxxxxxxxxxxxxxx" class="cdp-input cdp-w-key font-cyan-mono">
              <p class="form-field-hint">在 sct.ftqq.com 申请的 SendKey。用于微信公众号实时弹窗预警。</p>
            </div>

            <div class="channel-action-row">
              <button @click="saveServerChanChannel" class="btn-primary-gradient">
                保存微信推送设置
              </button>
              <button @click="testServerChan" :disabled="isTestingServerChan" class="btn-gray-test">
                {{ isTestingServerChan ? '推送中...' : '发送微信测试' }}
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>

  </div>
</template>

<style scoped>
/* 针对该模块的专属微调 */
.channel-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 4px;
}
</style>