<template>
  <div class="cyber-card tab-content-card">
    <!-- 顶部操作条 -->
    <div class="card-header" style="margin-bottom: 16px;">
      <h3>⚙️ 系统发信、定时巡检、HTTPS 证书与全局设置</h3>
      <button class="btn-cyber-success" @click="saveAllSettings">💾 保存全部配置</button>
    </div>

    <!-- 2 个子卡片选项卡导航 -->
    <div class="sub-tab-nav">
      <button
        class="sub-tab-btn"
        :class="{ active: settingsSubTab === 'notify' }"
        @click="settingsSubTab = 'notify'"
      >
        📧 发信服务与通知推送中枢
      </button>
      <button
        class="sub-tab-btn"
        :class="{ active: settingsSubTab === 'system' }"
        @click="settingsSubTab = 'system'"
      >
        🔐 HTTPS 证书与基础运维
      </button>
    </div>

    <!-- ==================== 子卡 1：发信服务与通知推送中枢 (双列布局) ==================== -->
    <div v-if="settingsSubTab === 'notify'" class="sub-tab-pane">
      <div class="settings-2col-layout">
        <!-- 左列：用户群发中枢 + 管理员告警、换绑邮箱与改密 -->
        <div class="column-stack">
          <!-- 面板 A：用户消息群发与定向通知中枢 -->
          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">📢</span>
                <div>
                  <strong class="panel-title">用户通知与消息群发中枢</strong>
                  <div class="panel-sub">按用户个人偏好自动路由投递 (邮件 / 微信服务号)</div>
                </div>
              </div>
            </div>

            <div class="form-item">
              <label>推送范围选择：</label>
              <div class="radio-group" style="flex-direction: row; gap: 20px;">
                <label class="radio-label">
                  <input type="radio" value="all" v-model="notifyPushForm.target" /> 👥 广播给全站有效用户
                </label>
                <label class="radio-label">
                  <input type="radio" value="single" v-model="notifyPushForm.target" /> 👤 定向发送给指定用户
                </label>
              </div>
            </div>

            <div class="form-item" v-if="notifyPushForm.target === 'single'">
              <label>目标接收用户名：</label>
              <input v-model="notifyPushForm.target_user" type="text" class="cyber-input" placeholder="输入要接收通知的用户名" />
            </div>

            <div class="form-item">
              <label>通知标题 (Title)：</label>
              <input v-model="notifyPushForm.title" type="text" class="cyber-input" placeholder="例如: 节点紧急维护通知 / 优惠活动" />
            </div>

            <div class="form-item">
              <label>通知正文内容 (Content)：</label>
              <textarea v-model="notifyPushForm.content" rows="4" class="cyber-input cyber-textarea" placeholder="输入通知详细内容，支持多行换行..."></textarea>
              <span class="input-hint">系统将根据目标用户的设置（绑定邮箱 或 Server酱微信），自动精准路由投递。</span>
            </div>

            <button class="btn-cyber-primary" :disabled="sendingPush" style="width: auto; padding: 9px 24px;" @click="sendUserPushNotification">
              {{ sendingPush ? '正在派发通知任务...' : '🚀 立即投递通知' }}
            </button>
          </div>

          <!-- 面板 B：管理员自身通知通道、换绑邮箱与改密 -->
          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">👤</span>
                <div>
                  <strong class="panel-title">管理员自身通知通道、换绑与改密</strong>
                  <div class="panel-sub">管理员接收系统告警通道与安全认证</div>
                </div>
              </div>
            </div>

            <!-- 1. 告警通道 -->
            <div class="form-item">
              <label>告警通道选择</label>
              <div class="radio-group">
                <label class="radio-label"><input type="radio" value="email" v-model="notifyForm.notify_type" /> 📧 电子邮箱接收</label>
                <label class="radio-label"><input type="radio" value="serverchan" v-model="notifyForm.notify_type" /> 📲 Server酱 (微信推送)</label>
              </div>
            </div>
            <div class="form-item" v-if="notifyForm.notify_type === 'serverchan'">
              <label>Server酱 SendKey：</label>
              <input v-model="notifyForm.serverchan_key" type="text" class="cyber-input font-mono" placeholder="SCTxxxxxxxxxx" />
            </div>
            <div class="btn-group" style="margin-top: 14px;">
              <button class="btn-cyber-success" style="padding: 6px 14px; font-size: 12px;" @click="saveNotifySettings">保存通知偏好</button>
              <button class="btn-cyber-action" style="padding: 6px 14px; font-size: 12px;" @click="testUserNotify">测试通知</button>
            </div>

            <!-- 2. 更换管理员绑定邮箱 (补全明确的文字标签) -->
            <div class="inner-divider">
              <div class="inner-divider-title">📧 更换管理员绑定邮箱 (新邮箱验证)</div>
              <div style="font-size: 12px; color: #94a3b8; margin: 4px 0 10px 0;">
                当前绑定邮箱：<b class="text-cyan">{{ currentUser.email || '尚未绑定' }}</b>
              </div>
              <div class="form-item">
                <label>拟绑定的新电子邮箱</label>
                <div class="code-send-group" style="max-width: 500px;">
                  <input v-model="adminEmailForm.new_email" type="email" class="cyber-input" placeholder="输入管理员新邮箱" />
                  <button class="btn-cyber-code" :disabled="adminEmailCountdown > 0 || sendingAdminEmailCode" @click="sendAdminChangeEmailCode">
                    {{ adminEmailCountdown > 0 ? `${adminEmailCountdown}s 后重试` : (sendingAdminEmailCode ? '发送中...' : '发送验证码') }}
                  </button>
                </div>
              </div>
              <div class="form-item">
                <label>新邮箱 6 位验证码</label>
                <input v-model="adminEmailForm.code" type="text" class="cyber-input" placeholder="输入新邮箱收到的 6 位验证码" />
              </div>
              <div class="form-item">
                <label>管理员当前登录密码 (身份核验)</label>
                <input v-model="adminEmailForm.password" type="password" class="cyber-input" placeholder="输入管理员登录密码确认改绑" />
              </div>
              <button class="btn-cyber-primary" :disabled="loadingChangeAdminEmail" style="width: auto; padding: 7px 20px; font-size: 12px;" @click="submitAdminChangeEmail">
                {{ loadingChangeAdminEmail ? '正在验证改绑...' : '确认更换绑定邮箱' }}
              </button>
            </div>

            <!-- 3. 修改管理员自身登录密码 -->
            <div class="inner-divider">
              <div class="inner-divider-title">🔑 修改管理员自身登录密码</div>
              <div class="form-item">
                <label>当前原旧密码</label>
                <input v-model="pwdForm.old_pwd" type="password" class="cyber-input" placeholder="当前原旧密码" />
              </div>
              <div class="form-item">
                <label>设置新密码 (至少6位)</label>
                <input v-model="pwdForm.new_pwd" type="password" class="cyber-input" placeholder="新密码 (至少6位)" />
              </div>
              <div class="form-item">
                <label>再次确认新密码</label>
                <input v-model="pwdForm.confirm_pwd" type="password" class="cyber-input" placeholder="确认新密码" />
              </div>
              <button class="btn-cyber-primary" style="width: auto; padding: 7px 20px; font-size: 12px;" @click="submitChangePassword">确认变更密码</button>
            </div>
          </div>
        </div>

        <!-- 右列：SMTP 发信配置 + 定时巡检与重置 -->
        <div class="column-stack">
          <!-- 面板 C：SMTP 发信服务器参数配置 -->
          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">📧</span>
                <div>
                  <strong class="panel-title">SMTP 发信服务器参数配置</strong>
                  <div class="panel-sub">用于发送验证码与到期告警邮件</div>
                </div>
              </div>
            </div>
            <div class="smtp-status-box" :class="settingsForm.is_smtp_configured ? 'smtp-ready' : 'smtp-empty'">
              <span>{{ settingsForm.is_smtp_configured ? '🟢 SMTP 状态：就绪 (发信正常)' : '⚪ SMTP 状态：未完整配置' }}</span>
            </div>
            <div class="form-item"><label>SMTP 服务器地址</label><input v-model="settingsForm.smtp_host" type="text" class="cyber-input" placeholder="smtp.qq.com" /></div>
            <div class="form-row-2">
              <div class="form-item"><label>端口</label><input v-model="settingsForm.smtp_port" type="text" class="cyber-input" placeholder="465" /></div>
              <div class="form-item"><label>发件人显示名称</label><input v-model="settingsForm.smtp_sender" type="text" class="cyber-input" placeholder="Xray 节点中心" /></div>
            </div>
            <div class="form-item"><label>发信邮箱账号</label><input v-model="settingsForm.smtp_user" type="text" class="cyber-input" placeholder="service@example.com" /></div>
            <div class="form-item"><label>邮箱授权码 / 密码</label><input v-model="settingsForm.smtp_pass" type="password" class="cyber-input" :placeholder="settingsForm.has_smtp_pass ? '●●●●●● (留空保持原密码)' : '输入授权码'" /></div>
            <div class="form-item"><label class="radio-label"><input type="checkbox" v-model="settingsForm.smtp_ssl" /> 启用 SSL 安全加密</label></div>
            <div class="inner-divider">
              <div style="display: flex; gap: 8px;">
                <input v-model="testEmailTo" type="email" class="cyber-input" placeholder="接收测试邮箱 (test@example.com)" />
                <button class="btn-cyber-action" :disabled="testingEmail" style="padding: 6px 14px; font-size: 12px; white-space: nowrap;" @click="sendTestEmail">{{ testingEmail ? '...' : '发信测试' }}</button>
              </div>
            </div>
          </div>

          <!-- 面板 D：定时巡检与每月流量重置 -->
          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">⏰</span>
                <div>
                  <strong class="panel-title">定时巡检、预警与每月流量重置</strong>
                  <div class="panel-sub">后台自动轮询配额并执行每月重置</div>
                </div>
              </div>
              <label class="radio-label" style="margin: 0;">
                <input type="checkbox" v-model="settingsForm.task_notify_enable" />
                <span :style="{ color: settingsForm.task_notify_enable ? '#10b981' : '#ef4444' }">{{ settingsForm.task_notify_enable ? '🟢 巡检中' : '🔴 暂停' }}</span>
              </label>
            </div>
            <div class="form-item">
              <label>轮询检测周期 (小时)</label>
              <div class="input-with-addon"><input v-model.number="settingsForm.task_interval_hours" type="number" class="cyber-input" /><span class="addon-text">小时 / 次</span></div>
            </div>
            <div class="form-item">
              <label>流量不足告警阈值 (%)</label>
              <div class="input-with-addon"><input v-model.number="settingsForm.task_traffic_threshold" type="number" class="cyber-input" /><span class="addon-text">%</span></div>
            </div>
            <div class="form-item">
              <label>套餐到期告警阈值 (天)</label>
              <div class="input-with-addon"><input v-model.number="settingsForm.task_expire_days" type="number" class="cyber-input" /><span class="addon-text">天</span></div>
            </div>
            <div class="inner-divider">
              <div style="font-size: 12px; color: #94a3b8; margin-bottom: 10px;">最近扫描完成时间：<b class="text-cyan">{{ settingsForm.task_last_run }}</b></div>
              <button class="btn-cyber-primary" :disabled="triggeringTask" style="width: auto; padding: 7px 18px; font-size: 12px;" @click="triggerManualTask">
                {{ triggeringTask ? '扫描中...' : '⚡ 立即执行一次巡检与重置' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== 子卡 2：HTTPS 证书与基础运维 (双列布局) ==================== -->
    <div v-else-if="settingsSubTab === 'system'" class="sub-tab-pane">
      <div class="settings-2col-layout">
        <!-- 左列：系统公告与新注册配额 -->
        <div class="column-stack">
          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">📢</span>
                <div>
                  <strong class="panel-title">系统公告与新用户默认配额</strong>
                  <div class="panel-sub">登录页横幅公告与新用户体验套餐</div>
                </div>
              </div>
            </div>
            <div class="form-item">
              <label>登录页系统公告内容 (留空不显示)：</label>
              <textarea v-model="settingsForm.system_notice" rows="4" class="cyber-input cyber-textarea" placeholder="例如：欢迎加入！全节点已完成升级，高速晚高峰不卡顿..."></textarea>
              <span class="input-hint">保存后，前台用户打开登录卡片顶部将即时看到此公告。</span>
            </div>
            <div class="form-row-2" style="margin-top: 15px;">
              <div class="form-item">
                <label>新注册默认赠送流量 (MB)</label>
                <input v-model.number="settingsForm.reg_traffic_mb" type="number" class="cyber-input" placeholder="1024" />
                <span class="input-hint">填 0 为不赠送</span>
              </div>
              <div class="form-item">
                <label>新注册默认有效天数 (天)</label>
                <input v-model.number="settingsForm.reg_expire_days" type="number" class="cyber-input" placeholder="1" />
                <span class="input-hint">填 36500 为永久</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 右列：HTTPS 安全证书与 ACME 自动签发 -->
        <div class="column-stack">
          <div class="panel-card">
            <div class="panel-card-header">
              <div class="panel-title-wrap">
                <span class="panel-icon">🔐</span>
                <div>
                  <strong class="panel-title">HTTPS 安全证书与 ACME 管理</strong>
                  <div class="panel-sub">管理 fullchain.pem / privkey.pem 与 Let's Encrypt 自动签发</div>
                </div>
              </div>
              <button class="btn-sm btn-action" @click="loadCertInfo">🔄 检查状态</button>
            </div>

            <!-- 证书状态横幅 -->
            <div class="smtp-status-box" :class="certInfo.is_self_signed ? 'smtp-empty' : 'smtp-ready'" style="margin-bottom: 14px;">
              <div v-if="certInfo.is_self_signed">
                ⚠️ <b>当前正在使用自签名证书 (10年期)</b>
                <div style="font-size: 11px; margin-top: 2px;">浏览器首次访问会显示不安全提示；可开启下方 ACME 签发免费受信任证书。</div>
              </div>
              <div v-else-if="certInfo.status === 'valid'">
                🟢 <b>当前证书工作正常 (受信任证书)</b>
                <div style="font-size: 11px; margin-top: 2px;">签发机构: {{ certInfo.issuer }} | 剩余天数: {{ certInfo.days_left }} 天</div>
              </div>
              <div v-else>
                ⚪ 证书状态未知，开机将自动生成自签名证书兜底。
              </div>
            </div>

            <div class="form-item">
              <label class="radio-label" style="font-weight: 600;">
                <input type="checkbox" v-model="settingsForm.acme_enable" @change="saveAllSettings" />
                <span :style="{ color: settingsForm.acme_enable ? '#10b981' : '#94a3b8' }">
                  {{ settingsForm.acme_enable ? '🟢 ACME 自动签发功能：已开启' : '⚪ ACME 自动签发功能：已停用 (默认关闭)' }}
                </span>
              </label>
            </div>

            <div v-if="settingsForm.acme_enable" style="background: rgba(56, 189, 248, 0.05); border: 1px dashed rgba(56, 189, 248, 0.3); border-radius: 8px; padding: 14px; margin-bottom: 14px;">
              <div class="form-item">
                <label>解析到本机的域名 (Domain)：</label>
                <input v-model="settingsForm.acme_domain" type="text" class="cyber-input" placeholder="例如: panel.example.com" />
              </div>
              <div class="form-item">
                <label>Let's Encrypt 登记邮箱 (Email)：</label>
                <input v-model="settingsForm.acme_email" type="email" class="cyber-input" placeholder="admin@example.com" />
              </div>
              <button class="btn-cyber-primary" :disabled="issuingAcme" style="width: auto; padding: 8px 18px; font-size: 12px;" @click="handleApplyAcme">
                {{ issuingAcme ? '正在申请证书，请稍候...' : '⚡ 一键向 Let\'s Encrypt 申请/续签证书' }}
              </button>
            </div>

            <div class="inner-divider">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div class="inner-divider-title" style="margin: 0;">📋 手动粘贴第三方证书 (如宝塔证书)</div>
                <button class="btn-link-action" @click="showCustomCertModal = true">打开粘贴窗口</button>
              </div>
              <div class="input-hint">若已有证书，可直接映射或粘贴保存到 <code>/data/certs/fullchain.pem</code> 与 <code>privkey.pem</code>。</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 弹窗：手动粘贴证书 PEM -->
    <div v-if="showCustomCertModal" class="modal-backdrop" @click="showCustomCertModal = false">
      <div class="cyber-modal" style="max-width: 520px; text-align: left;" @click.stop>
        <h3>📋 手动安装第三方 HTTPS 证书</h3>
        <p class="modal-tip">直接粘贴 PEM 编码的证书与私钥，将保存写入 <code>/data/certs/fullchain.pem</code> 与 <code>privkey.pem</code>：</p>
        <div class="form-item">
          <label>公钥证书链 (fullchain.pem)</label>
          <textarea v-model="customCertPem" rows="6" class="cyber-input cyber-textarea modal-input" placeholder="-----BEGIN CERTIFICATE-----..."></textarea>
        </div>
        <div class="form-item">
          <label>私钥文件 (privkey.pem)</label>
          <textarea v-model="customKeyPem" rows="6" class="cyber-input cyber-textarea modal-input" placeholder="-----BEGIN RSA PRIVATE KEY-----..."></textarea>
        </div>
        <div class="btn-group" style="justify-content: flex-end; margin-top: 20px;">
          <button class="btn-cyber-action" @click="showCustomCertModal = false">取消</button>
          <button class="btn-cyber-success" @click="handleSaveCustomCert">保存并载入证书</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

const props = defineProps({
  currentUser: { type: Object, required: true },
  adminPassword: { type: String, required: true }
})

const emit = defineEmits(['copy', 'reload-all'])

const settingsSubTab = ref('notify')

const settingsForm = reactive({
  smtp_host: '',
  smtp_port: '465',
  smtp_user: '',
  smtp_pass: '',
  has_smtp_pass: false,
  is_smtp_configured: false,
  smtp_sender: '',
  smtp_ssl: true,
  task_notify_enable: true,
  task_interval_hours: 12,
  task_traffic_threshold: 80,
  task_expire_days: 3,
  task_last_run: '尚未执行',
  acme_enable: false,
  acme_domain: '',
  acme_email: '',
  system_notice: '',
  reg_traffic_mb: 1024,
  reg_expire_days: 1
})

const notifyForm = reactive({ notify_type: 'email', serverchan_key: '' })
const pwdForm = reactive({ old_pwd: '', new_pwd: '', confirm_pwd: '' })

// 更换管理员绑定邮箱状态
const adminEmailForm = reactive({
  new_email: '',
  code: '',
  password: ''
})
const adminEmailCountdown = ref(0)
const sendingAdminEmailCode = ref(false)
const loadingChangeAdminEmail = ref(false)

// 消息群发与定向通知表单
const notifyPushForm = reactive({
  target: 'all',
  target_user: '',
  title: '',
  content: ''
})
const sendingPush = ref(false)

const certInfo = ref({ status: 'none', is_self_signed: true, issuer: '', days_left: 0 })
const issuingAcme = ref(false)
const showCustomCertModal = ref(false)
const customCertPem = ref('')
const customKeyPem = ref('')

const testEmailTo = ref('')
const testingEmail = ref(false)
const triggeringTask = ref(false)

onMounted(async () => {
  notifyForm.notify_type = props.currentUser.notify_type || 'email'
  notifyForm.serverchan_key = props.currentUser.serverchan_key || ''

  try {
    const res = await axios.get(`/api/admin/settings?admin_user=${encodeURIComponent(props.currentUser.username)}&admin_pwd=${encodeURIComponent(props.adminPassword)}`)
    if (res.data.code === 200) {
      const d = res.data.data
      settingsForm.smtp_host = d.smtp_host || ''
      settingsForm.smtp_port = d.smtp_port || '465'
      settingsForm.smtp_user = d.smtp_user || ''
      settingsForm.smtp_pass = ''
      settingsForm.has_smtp_pass = d.has_smtp_pass || false
      settingsForm.is_smtp_configured = d.is_smtp_configured || false
      settingsForm.smtp_sender = d.smtp_sender || ''
      settingsForm.smtp_ssl = d.smtp_ssl === 'true'
      settingsForm.task_notify_enable = d.task_notify_enable === 'true'
      settingsForm.task_interval_hours = Number(d.task_interval_hours) || 12
      settingsForm.task_traffic_threshold = Number(d.task_traffic_threshold) || 80
      settingsForm.task_expire_days = Number(d.task_expire_days) || 3
      settingsForm.task_last_run = d.task_last_run || '尚未执行'
      settingsForm.acme_enable = d.acme_enable === 'true'
      settingsForm.acme_domain = d.acme_domain || ''
      settingsForm.acme_email = d.acme_email || ''
      settingsForm.system_notice = d.system_notice || ''
      settingsForm.reg_traffic_mb = Number(d.reg_traffic_mb) || 1024
      settingsForm.reg_expire_days = Number(d.reg_expire_days) || 1
    }
    loadCertInfo()
  } catch (_) {}
})

// 向管理员新邮箱发送验证码
const sendAdminChangeEmailCode = async () => {
  if (!adminEmailForm.new_email || !adminEmailForm.new_email.includes('@')) {
    return ElMessage.warning('请输入合法的新电子邮箱地址')
  }
  if (adminEmailForm.new_email.trim().toLowerCase() === (props.currentUser.email || '').toLowerCase()) {
    return ElMessage.warning('新邮箱不能与当前绑定的旧邮箱相同')
  }

  sendingAdminEmailCode.value = true
  try {
    const res = await axios.post('/api/user/send_change_email_code', {
      username: props.currentUser.username,
      new_email: adminEmailForm.new_email
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      adminEmailCountdown.value = 60
      const timer = setInterval(() => {
        adminEmailCountdown.value--
        if (adminEmailCountdown.value <= 0) clearInterval(timer)
      }, 1000)
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('发送验证码请求失败')
  } finally {
    sendingAdminEmailCode.value = false
  }
}

// 验证码 + 管理员密码双向确认换绑邮箱
const submitAdminChangeEmail = async () => {
  if (!adminEmailForm.new_email || !adminEmailForm.code || !adminEmailForm.password) {
    return ElMessage.warning('请填写新邮箱、验证码以及管理员密码')
  }

  loadingChangeAdminEmail.value = true
  try {
    const res = await axios.post('/api/user/change_email', {
      username: props.currentUser.username,
      new_email: adminEmailForm.new_email,
      code: adminEmailForm.code,
      password: adminEmailForm.password
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      adminEmailForm.new_email = ''
      adminEmailForm.code = ''
      adminEmailForm.password = ''
      emit('reload-all')
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('换绑邮箱失败')
  } finally {
    loadingChangeAdminEmail.value = false
  }
}

// 向全站用户广播或向特定用户推送通知
const sendUserPushNotification = async () => {
  if (!notifyPushForm.title || !notifyPushForm.content) {
    return ElMessage.warning('请输入通知标题与正文内容')
  }
  if (notifyPushForm.target === 'single' && !notifyPushForm.target_user.trim()) {
    return ElMessage.warning('请输入接收通知的目标用户名')
  }

  const confirmMsg = notifyPushForm.target === 'all'
    ? '⚠️ 确定要向全站所有正常活跃的用户群发广播此通知吗？'
    : `确定要向用户 [${notifyPushForm.target_user}] 单独发送此通知吗？`

  if (!confirm(confirmMsg)) return

  sendingPush.value = true
  try {
    const res = await axios.post('/api/admin/notify/send', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      ...notifyPushForm
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      notifyPushForm.title = ''
      notifyPushForm.content = ''
      if (notifyPushForm.target === 'single') {
        notifyPushForm.target_user = ''
      }
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('通知发送请求失败')
  } finally {
    sendingPush.value = false
  }
}

const saveAllSettings = async () => {
  try {
    const res = await axios.post('/api/admin/settings', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      ...settingsForm,
      smtp_ssl: settingsForm.smtp_ssl ? 'true' : 'false',
      task_notify_enable: settingsForm.task_notify_enable ? 'true' : 'false',
      acme_enable: settingsForm.acme_enable ? 'true' : 'false'
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('保存设置失败')
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
      emit('reload-all')
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
      location.reload()
    }
  } catch (_) {
    ElMessage.error('改密失败')
  }
}

const loadCertInfo = async () => {
  try {
    const res = await axios.post('/api/admin/cert/info', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword
    })
    if (res.data.code === 200) {
      certInfo.value = res.data.data
    }
  } catch (_) {}
}

const handleApplyAcme = async () => {
  if (!settingsForm.acme_domain) return ElMessage.warning('请填写解析到本机的域名')
  issuingAcme.value = true
  ElMessage.info('正在请求 Let\'s Encrypt 签发证书，过程约需 15~30 秒...')
  try {
    const res = await axios.post('/api/admin/cert/acme', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      domain: settingsForm.acme_domain,
      email: settingsForm.acme_email
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      loadCertInfo()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('证书申请失败')
  } finally {
    issuingAcme.value = false
  }
}

const handleSaveCustomCert = async () => {
  if (!customCertPem.value || !customKeyPem.value) return ElMessage.warning('请粘贴完整的证书和私钥 PEM 内容')
  try {
    const adminUser = currentUser.username || authForm.username
    const res = await axios.post('/api/admin/cert/custom', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      cert_pem: customCertPem.value,
      key_pem: customKeyPem.value
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      showCustomCertModal.value = false
      loadCertInfo()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('证书保存失败')
  }
}

const sendTestEmail = async () => {
  if (!testEmailTo.value) return ElMessage.warning('请输入测试收件邮箱')
  testingEmail.value = true
  try {
    const res = await axios.post('/api/admin/test_email', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      test_to: testEmailTo.value
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('发信异常')
  } finally {
    testingEmail.value = false
  }
}

const triggerManualTask = async () => {
  triggeringTask.value = true
  try {
    const res = await axios.post('/api/admin/tasks/trigger', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('触发扫描任务失败')
  } finally {
    triggeringTask.value = false
  }
}
</script>

<style scoped>
.input-with-addon {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 70%;
  min-width: 260px;
  max-width: 500px;
}
.input-with-addon .cyber-input {
  flex: 1;
  width: auto !important;
  min-width: 0 !important;
  max-width: 100% !important;
}

@media (max-width: 640px) {
  .input-with-addon {
    width: 100% !important;
    min-width: 0 !important;
    max-width: 100% !important;
  }
}
</style>