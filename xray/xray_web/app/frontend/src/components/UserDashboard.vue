<template>
  <div class="dashboard-grid">
    <!-- 1. 流量监控与配额 (数字与进度条完全自动更新) -->
    <div class="cyber-card">
      <div class="card-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          <h3>📊 流量监控与配额</h3>
          <span class="live-pulse" title="已开启自动实时同步"></span>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <span class="auto-sync-text">实时同步中 (30s)</span>
          <span class="tag-status">ONLINE</span>
        </div>
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
          <!-- 动效平滑进度条 -->
          <div class="progress-glow smooth-bar" :style="{ width: trafficPercent + '%' }"></div>
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

    <!-- 3. 专属好友推荐邀请返利中心 -->
    <div class="cyber-card col-span-2">
      <div class="card-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          <h3>🎁 专属好友推荐邀请返利中心</h3>
          <span class="tag-status" style="border-color: #38bdf8; color: #38bdf8; background: rgba(56, 189, 248, 0.1);">双向互利</span>
        </div>
      </div>
      <p class="card-desc">
        将您的专属邀请链接或邀请码分享给好友，好友注册激活立即获赠额外高速流量与天数，您亦可获得丰厚流量与有效期双向累加奖励！
      </p>

      <div class="settings-2col-layout" style="margin-top: 14px;">
        <!-- 统计面板 -->
        <div class="column-stack">
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;">
            <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(56, 189, 248, 0.2); border-radius: 8px; padding: 14px; text-align: center;">
              <div style="font-size: 11px; color: #94a3b8; margin-bottom: 4px;">成功邀请人数</div>
              <div style="font-size: 24px; font-weight: bold; color: #38bdf8;">{{ currentUser.referral_count || 0 }} <span style="font-size: 12px; color: #64748b;">人</span></div>
            </div>
            <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 8px; padding: 14px; text-align: center;">
              <div style="font-size: 11px; color: #94a3b8; margin-bottom: 4px;">累计获赠流量</div>
              <div style="font-size: 24px; font-weight: bold; color: #10b981;">+{{ currentUser.referral_bonus_gb || 0 }} <span style="font-size: 12px; color: #64748b;">GB</span></div>
            </div>
            <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(245, 158, 11, 0.2); border-radius: 8px; padding: 14px; text-align: center;">
              <div style="font-size: 11px; color: #94a3b8; margin-bottom: 4px;">累计延长有效期</div>
              <div style="font-size: 24px; font-weight: bold; color: #f59e0b;">+{{ currentUser.referral_bonus_days || 0 }} <span style="font-size: 12px; color: #64748b;">天</span></div>
            </div>
          </div>
        </div>

        <!-- 邀请码与链接 -->
        <div class="column-stack">
          <div class="form-item" style="margin-bottom: 10px;">
            <label>您的专属推荐邀请码：</label>
            <div style="display: flex; gap: 8px;">
              <input :value="referralCode" readonly type="text" class="cyber-input font-mono" style="font-weight: bold; letter-spacing: 1px; color: #38bdf8; background: rgba(15, 23, 42, 0.7);" />
              <button class="btn-cyber-primary" style="white-space: nowrap; padding: 0 16px;" @click="$emit('copy', referralCode)">📋 复制</button>
            </div>
          </div>
          <div class="form-item" style="margin-bottom: 0;">
            <label>您的专属好友直达推广链接：</label>
            <div style="display: flex; gap: 8px;">
              <input :value="referralLink" readonly type="text" class="cyber-input font-mono" style="font-size: 12px; color: #94a3b8; background: rgba(15, 23, 42, 0.7);" />
              <button class="btn-cyber-success" style="white-space: nowrap; padding: 0 16px;" @click="$emit('copy', referralLink)">🔗 复制链接</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 4. 节点列表与聚合订阅 -->
    <div class="cyber-card col-span-2">
      <div class="card-header header-nowrap-row">
        <h3 class="header-title-text">🌐 全球加速节点列表与通用订阅 (共 {{ currentUser.nodes ? currentUser.nodes.length : 0 }} 个节点)</h3>
        <div style="display: flex; gap: 8px; flex-shrink: 0; align-items: center;">
          <button class="btn-header-action btn-cyber-primary" @click="$emit('copy', currentUser.sub_url)">
            🔗 复制订阅链接
          </button>
          <button class="btn-header-action btn-cyber-danger" @click="handleUserResetUuid">
            🔄 重置凭据 (UUID)
          </button>
          <button class="btn-header-action btn-client-download-main" @click="showClientModal = true">
            💻 客户端下载
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

            <!-- 多 SNI 下拉选择器 -->
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

          <div class="node-card-footer">
            <div class="action-btn-right">
              <button class="btn-sm btn-action" @click="$emit('copy', node.link)">📋 复制</button>
              <button class="btn-sm btn-edit" @click="$emit('open-qr', { link: node.link, name: node.name })">📱 扫码</button>
            </div>
          </div>
        </div>

        <div v-if="!currentUser.nodes || currentUser.nodes.length === 0" class="empty-node-tip">
          暂无在线节点，请等待管理员启动并接入 xray_core 远程节点。
        </div>
      </div>
    </div>

    <!-- 4. 用户安全中心与偏好设置 -->
    <div class="cyber-card col-span-2">
      <div class="card-header">
        <h3>🔔 账号安全中心与通知偏好</h3>
      </div>
      <div class="settings-2col-layout">
        <!-- 左列：通知通道设置 + 更换绑定邮箱 -->
        <div class="column-stack">
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

    <!-- 弹窗：多端专属客户端获取中枢 -->
    <div v-if="showClientModal" class="modal-backdrop" @click="showClientModal = false">
      <div class="cyber-modal" style="max-width: 540px; text-align: left;" @click.stop>
        <h3>💻 专属加速客户端获取中心</h3>
        <p class="modal-tip">为您自动配置好的各平台客户端，解压即可直接加速使用：</p>

        <div class="client-pack-item">
          <div class="client-item-header">
            <span class="client-os-icon">🪟</span>
            <div>
              <b style="font-size: 14px; color: #f8fafc;">Windows 平台 - v2rayN 专属独立版</b>
              <div class="client-item-desc">
                已集成 Xray 内核 + .NET 8 运行环境，预设您的专属订阅，开启自动系统代理与黑名单分流。
              </div>
            </div>
          </div>
          <button class="btn-cyber-download" style="margin-top: 10px; width: 100%; padding: 8px;" @click="downloadWindowsClient">
            ⬇️ 一键下载 Windows 专属客户端 (免安装便携版)
          </button>
        </div>

        <div class="client-pack-item" style="margin-top: 14px;">
          <div class="client-item-header">
            <span class="client-os-icon">🤖</span>
            <div>
              <b style="font-size: 14px; color: #f8fafc;">Android 安卓平台 - v2rayNG</b>
              <div class="client-item-desc">
                手机打开已安装的 v2rayNG 即可秒级导入配置；如未安装，可直接下载官方纯净版 APK。
              </div>
            </div>
          </div>
          <div style="display: flex; gap: 8px; margin-top: 10px;">
            <button class="btn-sm btn-action" style="flex: 1; padding: 8px;" @click="importToV2rayNG">
              🚀 一键唤起 v2rayNG 自动导入
            </button>
            <button class="btn-sm btn-edit" style="flex: 1; padding: 8px;" @click="downloadAndroidApk">
              ⬇️ 下载官方 v2rayNG.apk
            </button>
          </div>
        </div>

        <div class="btn-group" style="justify-content: flex-end; margin-top: 20px;">
          <button class="btn-cyber-action" @click="showClientModal = false">关闭窗口</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

const props = defineProps({
  currentUser: { type: Object, required: true }
})

const emit = defineEmits(['copy', 'open-qr', 'refresh-user', 'logout'])

const loading = ref(false)
const rechargeCode = ref('')
const showClientModal = ref(false)

const notifyForm = reactive({
  notify_type: props.currentUser.notify_type || 'email',
  serverchan_key: props.currentUser.serverchan_key || ''
})

const pwdForm = reactive({ old_pwd: '', new_pwd: '', confirm_pwd: '' })

const emailForm = reactive({
  new_email: '',
  code: '',
  password: ''
})
const emailCountdown = ref(0)
const sendingEmailCode = ref(false)
const loadingChangeEmail = ref(false)

// 响应式计算流量百分比
const trafficPercent = computed(() => {
  if (!props.currentUser.limit_mb) return 100
  return Math.min(100, Math.round((props.currentUser.used_mb / props.currentUser.limit_mb) * 100))
})

const referralCode = computed(() => {
  return props.currentUser.referral_code || (props.currentUser.uuid ? props.currentUser.uuid.slice(0, 8).toUpperCase() : '')
})

const referralLink = computed(() => {
  const origin = window.location.origin
  return `${origin}/?ref=${referralCode.value}`
})

// ==================== 核心增强：前台无感自动轮询机制 ====================
let autoRefreshTimer = null

const performSilentRefresh = () => {
  // 当用户正在当前标签页时，自动静默触发父组件刷新用户信息
  if (document.visibilityState === 'visible') {
    emit('refresh-user')
  }
}

onMounted(() => {
  // 每 30 秒自动静默同步一次最新已用流量与进度条
  autoRefreshTimer = setInterval(performSilentRefresh, 30000)
  document.addEventListener('visibilitychange', performSilentRefresh)
})

onUnmounted(() => {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
  document.removeEventListener('visibilitychange', performSilentRefresh)
})
// ======================================================================

const onUserChangeNodeSni = (node) => {
  if (!node.link || !node.selected_sni) return
  node.link = node.link.replace(/sni=[^&]+/, `sni=${node.selected_sni}`)
  ElMessage.success(`已切换该节点的伪装 SNI 为: ${node.selected_sni}`)
}

const handleUserResetUuid = async () => {
  const tip =
    `⚠️ 确定要重置您的节点连接凭证 (UUID) 吗？\n\n` +
    `【为什么需要重置？】\n` +
    `如果您的节点链接或订阅地址不慎泄露，可通过重置 UUID 让旧凭据彻底失效。\n\n` +
    `【重置后要做什么？】\n` +
    `重置后原有的全部节点链接与订阅将【立即失效断网】！您需要在电脑/手机客户端中重新更新订阅。\n\n` +
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

const downloadWindowsClient = () => {
  if (!props.currentUser.username) return ElMessage.warning('用户未就绪')
  ElMessage.info('正在打包您的专属 v2rayN 客户端包，请稍候...')

  const downloadUrl = `/api/user/download_client?username=${encodeURIComponent(props.currentUser.username)}`
  const a = document.createElement('a')
  a.href = downloadUrl
  a.download = `v2rayN_WithCore_${props.currentUser.username}.zip`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

const importToV2rayNG = () => {
  if (!props.currentUser.sub_url) return ElMessage.warning('未获取到有效订阅')
  emit('copy', props.currentUser.sub_url)
  const schemaUrl = `v2rayng://install-config?url=${encodeURIComponent(props.currentUser.sub_url)}`
  window.location.href = schemaUrl
  ElMessage.success('已复制订阅并尝试唤起 v2rayNG，若未自动弹出可手动在软件中点击从剪贴板导入！')
}

const downloadAndroidApk = () => {
  ElMessage.info('正在准备官方最新版 v2rayNG.apk 安装包...')
  const a = document.createElement('a')
  a.href = '/api/user/download_apk'
  a.download = 'v2rayNG_latest.apk'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

const sendChangeEmailCode = async () => {
  if (!emailForm.new_email || !emailForm.new_email.includes('@')) {
    return ElMessage.warning('请输入合法的新电子邮箱地址')
  }
  if (emailForm.new_email.trim().toLowerCase() === (props.currentUser.email || '').toLowerCase()) {
    return ElMessage.warning('新邮箱不能与当前绑定的旧邮箱相同')
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
      const newEmail = res.data.new_email || emailForm.new_email
      props.currentUser.email = newEmail

      const session = JSON.parse(localStorage.getItem('xray_auth_session') || '{}')
      if (session.user) {
        session.user.email = newEmail
        localStorage.setItem('xray_auth_session', JSON.stringify(session))
      }

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

<style scoped>
/* 丝滑平滑过渡动画：进度条变动时像水流一样慢慢涨起 */
.smooth-bar {
  transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1) !important;
}

/* 呼吸心跳指示灯 */
.live-pulse {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #10b981;
  box-shadow: 0 0 8px #10b981;
  animation: pulse-ring 2s infinite ease-in-out;
}

@keyframes pulse-ring {
  0% { transform: scale(0.95); opacity: 0.8; }
  50% { transform: scale(1.3); opacity: 1; box-shadow: 0 0 12px #10b981; }
  100% { transform: scale(0.95); opacity: 0.8; }
}

.auto-sync-text {
  font-size: 11px;
  color: #64748b;
  font-family: monospace;
}

.btn-client-download-main {
  background: linear-gradient(135deg, #10b981, #059669);
  color: white;
  border: none;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 0 10px rgba(16, 185, 129, 0.3);
}

.node-card-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
.action-btn-right {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.client-pack-item {
  background: #0b1120;
  border: 1px solid #1e293b;
  border-radius: 8px;
  padding: 16px;
}
.client-item-header {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.client-os-icon {
  font-size: 26px;
  line-height: 1;
}
.client-item-desc {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 4px;
  line-height: 1.5;
}
</style>