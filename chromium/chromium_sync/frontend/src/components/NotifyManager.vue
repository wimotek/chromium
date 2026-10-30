<script setup>
import { ref, reactive, onMounted } from 'vue'

const props = defineProps({
  api: Function,
  showToast: Function
})
const emit = defineEmits(['update-status'])

const notif = reactive({
  email_notify_enabled: true,
  smtp_host: 'smtp.yeah.net',
  smtp_port: '465',
  smtp_ssl: true,
  smtp_sender_name: 'CDP 节点中心',
  smtp_user: '',
  smtp_pass: '',
  smtp_to: '',
  smtp_status: 'untested',
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

const saveSettings = async () => {
  const res = await props.api('/api/notifications/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(notif)
  })
  if (res.ok) {
    props.showToast('通知推送参数已保存', 'success')
    emit('update-status')
  }
}

const testEmail = async () => {
  if (isTestingEmail.value) return
  isTestingEmail.value = true
  try {
    const res = await props.api('/api/notifications/test-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_email: testEmailTarget.value })
    })
    const data = await res.json()
    if (res.ok) {
      notif.smtp_status = 'ready'
      props.showToast(data.message, 'success')
      emit('update-status')
    } else {
      notif.smtp_status = 'error'
      props.showToast(data.detail || '发信失败', 'error')
    }
  } finally {
    isTestingEmail.value = false
  }
}

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
    <!-- 通道一：📧 邮件告警推送配置 (1:1 截图复刻) -->
    <div class="content-full-card">
      <div class="smtp-title-header">
        <div class="smtp-icon-box">📧</div>
        <div>
          <h3 class="smtp-title-text">SMTP 发信服务器参数配置 (邮件推送)</h3>
          <p class="smtp-sub-text">节点异常离线与同步失败时自动投递邮件预警</p>
        </div>
      </div>

      <!-- 动态状态指示灯 (截图同款) -->
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
        <div style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" v-model="notif.email_notify_enabled" id="m_box" class="check-box-blue">
          <label for="m_box" style="font-size:13px; color:#cbd5e1; font-weight:bold; cursor:pointer;">
            启用邮件告警推送通道
          </label>
        </div>

        <div>
          <label class="form-label">SMTP 服务器地址</label>
          <input v-model="notif.smtp_host" placeholder="smtp.yeah.net" class="cdp-input">
        </div>

        <!-- 70% 宽度的组合双列行 -->
        <div class="row-flex-gap-70">
          <div style="flex:1;">
            <label class="form-label">端口</label>
            <input v-model="notif.smtp_port" placeholder="465" class="cdp-input font-cyan-mono" style="width:100% !important;">
          </div>
          <div style="flex:1;">
            <label class="form-label">发件人显示名称</label>
            <input v-model="notif.smtp_sender_name" placeholder="CDP 节点中心" class="cdp-input" style="width:100% !important;">
          </div>
        </div>

        <div>
          <label class="form-label">发信邮箱账号</label>
          <input v-model="notif.smtp_user" placeholder="perrywu@yeah.net" class="cdp-input font-cyan-mono">
        </div>

        <div>
          <label class="form-label">邮箱授权码 / 密码</label>
          <input v-model="notif.smtp_pass" type="password" placeholder="•••••• (留空保持原密码)" class="cdp-input">
        </div>

        <div>
          <label class="form-label">预警接收邮箱 (留空则默认发送给发信账号自己)</label>
          <input v-model="notif.smtp_to" placeholder="admin@domain.com" class="cdp-input font-cyan-mono">
        </div>

        <div style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" v-model="notif.smtp_ssl" id="ssl_box" class="check-box-blue">
          <label for="ssl_box" style="font-size:12px; color:#cbd5e1; cursor:pointer;">启用 SSL 安全加密</label>
        </div>

        <!-- 截图同款：独立测试发信区 (宽度严格 70% 居中约束) -->
        <div class="smtp-test-dashed-area">
          <input v-model="testEmailTarget" placeholder="接收测试邮箱 (test@example.com)" class="cdp-input" style="flex:1; width:auto;">
          <button @click="testEmail" :disabled="isTestingEmail" class="btn-gray-test">
            {{ isTestingEmail ? '正在投递...' : '发信测试' }}
          </button>
        </div>

        <!-- 按钮宽度自适应，绝不占满 100% -->
        <div style="margin-top:4px;">
          <button @click="saveSettings" class="btn-primary-gradient">
            保存发信配置
          </button>
        </div>
      </div>
    </div>

    <!-- 通道二：📱 Server酱微信推送配置 -->
    <div class="content-full-card">
      <div class="smtp-title-header">
        <div class="smtp-icon-box" style="background:#831843; border-color:#db2777;">📱</div>
        <div>
          <h3 class="smtp-title-text">Server酱 (微信公众号推送)</h3>
          <p class="smtp-sub-text">节点异常或同步中断时直推手机微信</p>
        </div>
      </div>

      <div class="form-v-stack" style="margin-top:20px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" v-model="notif.serverchan_enabled" id="s_box" class="check-box-blue">
          <label for="s_box" style="font-size:13px; color:#cbd5e1; font-weight:bold; cursor:pointer;">
            启用微信实时推送通道
          </label>
        </div>

        <div>
          <label class="form-label">Server酱 SendKey</label>
          <input v-model="notif.serverchan_key" placeholder="SCTxxxxxxxxxxxxxxxx" class="cdp-input font-cyan-mono">
          <p style="font-size:11px; color:#64748b; margin-top:6px;">在 sct.ftqq.com 申请的 SendKey。用于手机微信即时接收通知。</p>
        </div>

        <!-- 按钮紧凑自适应 -->
        <div style="display:flex; gap:12px; margin-top:16px;">
          <button @click="testServerChan" :disabled="isTestingServerChan" class="btn-gray-test">
            {{ isTestingServerChan ? '推送中...' : '发送微信测试' }}
          </button>
          <button @click="saveSettings" class="btn-primary-gradient">
            保存微信配置
          </button>
        </div>
      </div>
    </div>
  </div>
</template>