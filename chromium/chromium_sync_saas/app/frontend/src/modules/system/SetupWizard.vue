<template>
  <div class="setup-viewport">
    <div class="setup-shell">
      <div class="card">
        <h2 class="card-title">
          <span>Chromium Sync SaaS · 平台首次初始化向导</span>
          <span class="tag tag-info">商业多租户初始化</span>
        </h2>
        <div class="banner banner-info">
          欢迎部署商业多租户 SaaS 运营中心。请配置数据库引擎、缓存加速、平台超级管理员账号以及 SMTP 邮件发信服务器（用于注册邮箱安全认证与系统告警通知）。
        </div>

        <div class="grid-2">
          <div class="field">
            <label>数据库引擎</label>
            <select class="select" v-model="form.db_type">
              <option value="sqlite">SQLite WAL (单机高并发推荐)</option>
              <option value="mysql">MySQL 8.0+ (外置生产集群)</option>
            </select>
          </div>
          <div class="field">
            <label>平台默认市场加价抽成 (bps, 2000 = 20%)</label>
            <input class="input mono" type="number" v-model.number="form.saas_platform_fee_bps" min="0" max="10000" />
          </div>
        </div>

        <div v-if="form.db_type === 'mysql'" class="grid-3">
          <div class="field"><label>MySQL 主机</label><input class="input" v-model="form.mysql_host" /></div>
          <div class="field"><label>MySQL 端口</label><input class="input" type="number" v-model.number="form.mysql_port" /></div>
          <div class="field"><label>数据库名</label><input class="input" v-model="form.mysql_database" /></div>
          <div class="field"><label>MySQL 用户名</label><input class="input" v-model="form.mysql_user" /></div>
          <div class="field"><label>MySQL 密码</label><input class="input" type="password" v-model="form.mysql_password" /></div>
        </div>

        <div class="row" style="margin-bottom: 14px">
          <button class="btn btn-sm" @click="testDb" :disabled="testingDb">
            {{ testingDb ? '探测中...' : '测试数据库连通性' }}
          </button>
          <span v-if="dbMsg" :style="{ color: dbOk ? '#34d399' : '#f87171', fontSize: '12px' }">{{ dbMsg }}</span>
        </div>

        <div class="field">
          <label>Redis 缓存连接串（可选，留空自动使用 SQLite Cache）</label>
          <div class="row">
            <input class="input" style="flex: 1" v-model="form.redis_url" placeholder="redis://127.0.0.1:6379/0" />
            <button class="btn btn-sm" v-if="form.redis_url" @click="testRedis" :disabled="testingRedis">测试 Redis</button>
          </div>
          <div v-if="redisMsg" style="font-size: 12px; margin-top: 4px" :style="{ color: redisOk ? '#34d399' : '#f87171' }">{{ redisMsg }}</div>
        </div>

        <hr style="border: 0; border-top: 1px solid var(--border); margin: 16px 0" />

        <h3 style="margin: 0 0 10px; font-size: 14px; color: #f8fafc">超级管理员账号设置</h3>
        <div class="grid-3">
          <div class="field">
            <label>管理员用户名</label>
            <input class="input" v-model="form.admin_username" placeholder="至少 2 个字符" />
          </div>
          <div class="field">
            <label>管理员邮箱（选填）</label>
            <input class="input" v-model="form.admin_email" placeholder="admin@example.com" />
          </div>
          <div class="field">
            <label>管理员登录密码（至少 6 位）</label>
            <input class="input" type="password" v-model="form.admin_password" placeholder="至少 6 位安全密码" />
          </div>
        </div>

        <hr style="border: 0; border-top: 1px solid var(--border); margin: 16px 0" />

        <h3 style="margin: 0 0 10px; font-size: 14px; color: #f8fafc">
          SMTP 邮件服务器配置
          <span class="muted" style="font-weight: 400; font-size: 12px">（用于新用户注册邮箱验证码与系统告警通知，可在后台「通知中心」随时调整）</span>
        </h3>
        <div class="grid-3">
          <div class="field">
            <label>SMTP 服务器地址</label>
            <input class="input" v-model="form.smtp_host" placeholder="smtp.yeah.net / smtp.qq.com" />
          </div>
          <div class="field">
            <label>SMTP 端口</label>
            <input class="input mono" type="number" v-model.number="form.smtp_port" />
          </div>
          <div class="field">
            <label>安全传输协议</label>
            <select class="select" v-model="form.smtp_ssl">
              <option :value="true">SSL / TLS (推荐 465)</option>
              <option :value="false">STARTTLS / 明文 (587/25)</option>
            </select>
          </div>
          <div class="field">
            <label>发信邮箱账号</label>
            <input class="input" v-model="form.smtp_user" placeholder="noreply@example.com" />
          </div>
          <div class="field">
            <label>SMTP 密码 / 授权码</label>
            <input class="input" type="password" v-model="form.smtp_pass" placeholder="邮箱授权码或密码" />
          </div>
          <div class="field">
            <label>发件人展示名称</label>
            <input class="input" v-model="form.smtp_sender_name" placeholder="Wimotek SaaS Hub" />
          </div>
        </div>
        <div class="row" style="margin-bottom: 14px">
          <input class="input" style="max-width: 240px" v-model="testSmtpTo" placeholder="测试收件邮箱（默认发信账号）" />
          <button class="btn btn-sm" @click="testSmtp" :disabled="testingSmtp">
            {{ testingSmtp ? '正在发信...' : '测试 SMTP 发信' }}
          </button>
          <span v-if="smtpMsg" :style="{ color: smtpOk ? '#34d399' : '#f87171', fontSize: '12px' }">{{ smtpMsg }}</span>
        </div>

        <hr style="border: 0; border-top: 1px solid var(--border); margin: 16px 0" />

        <div class="row" style="justify-content: space-between; gap: 16px">
          <div class="row" style="gap: 18px">
            <label class="row" style="cursor: pointer; gap: 6px">
              <input type="checkbox" v-model="form.saas_allow_public_register" />
              <span>开放首页公开注册</span>
            </label>
            <label class="row" style="cursor: pointer; gap: 6px">
              <input type="checkbox" v-model="form.saas_require_email_verify" />
              <span>注册强制邮箱验证码认证</span>
            </label>
          </div>
          <button class="btn btn-primary" @click="submit" :disabled="submitting">
            {{ submitting ? '正在初始化并登录...' : '完成初始化并进入控制台' }}
          </button>
        </div>
        <div v-if="err" class="banner banner-danger" style="margin-top: 12px">{{ err }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { apiFetch } from '../../api'

const emit = defineEmits(['completed'])
const form = reactive({
  db_type: 'sqlite',
  mysql_host: '127.0.0.1',
  mysql_port: 3306,
  mysql_user: 'root',
  mysql_password: '',
  mysql_database: 'chromium_sync_saas',
  redis_url: '',
  admin_username: 'admin',
  admin_email: '',
  admin_password: '',
  saas_platform_fee_bps: 2000,
  saas_allow_public_register: true,
  saas_require_email_verify: true,
  smtp_host: 'smtp.yeah.net',
  smtp_port: 465,
  smtp_ssl: true,
  smtp_sender_name: 'Wimotek SaaS Hub',
  smtp_user: '',
  smtp_pass: '',
  email_notify_enabled: false,
  email_notify_to: '',
})

const testSmtpTo = ref('')
const dbMsg = ref('')
const dbOk = ref(false)
const redisMsg = ref('')
const redisOk = ref(false)
const smtpMsg = ref('')
const smtpOk = ref(false)
const err = ref('')
const testingDb = ref(false)
const testingRedis = ref(false)
const testingSmtp = ref(false)
const submitting = ref(false)

onMounted(async () => {
  try {
    const st = await apiFetch('/api/setup/status')
    const d = st.defaults || {}
    if (d.db_type) form.db_type = d.db_type
    if (d.mysql_host) form.mysql_host = d.mysql_host
    if (d.mysql_port) form.mysql_port = d.mysql_port
    if (d.mysql_user) form.mysql_user = d.mysql_user
    if (d.mysql_database) form.mysql_database = d.mysql_database
    if (d.saas_platform_fee_bps !== undefined) form.saas_platform_fee_bps = d.saas_platform_fee_bps
    if (d.saas_allow_public_register !== undefined) form.saas_allow_public_register = Boolean(d.saas_allow_public_register)
    if (d.saas_require_email_verify !== undefined) form.saas_require_email_verify = Boolean(d.saas_require_email_verify)
    if (d.smtp_host) form.smtp_host = d.smtp_host
    if (d.smtp_port) form.smtp_port = d.smtp_port
  } catch {
    // ignore
  }
})

async function testDb() {
  testingDb.value = true
  dbMsg.value = ''
  try {
    const res = await apiFetch('/api/setup/test-db', { method: 'POST', body: JSON.stringify(form) })
    dbOk.value = true
    dbMsg.value = res.message || '连接成功'
  } catch (e) {
    dbOk.value = false
    dbMsg.value = e.message
  } finally {
    testingDb.value = false
  }
}

async function testRedis() {
  testingRedis.value = true
  redisMsg.value = ''
  try {
    const res = await apiFetch('/api/setup/test-redis', { method: 'POST', body: JSON.stringify({ redis_url: form.redis_url }) })
    redisOk.value = true
    redisMsg.value = res.message || 'Redis 连接成功'
  } catch (e) {
    redisOk.value = false
    redisMsg.value = e.message
  } finally {
    testingRedis.value = false
  }
}

async function testSmtp() {
  testingSmtp.value = true
  smtpMsg.value = ''
  try {
    const res = await apiFetch('/api/setup/test-smtp', {
      method: 'POST',
      body: JSON.stringify({
        smtp_host: form.smtp_host,
        smtp_port: form.smtp_port,
        smtp_ssl: form.smtp_ssl,
        smtp_sender_name: form.smtp_sender_name,
        smtp_user: form.smtp_user,
        smtp_pass: form.smtp_pass,
        test_to: testSmtpTo.value || form.admin_email || form.smtp_user,
      }),
    })
    smtpOk.value = true
    smtpMsg.value = res.message || 'SMTP 测试邮件发送成功'
  } catch (e) {
    smtpOk.value = false
    smtpMsg.value = e.message
  } finally {
    testingSmtp.value = false
  }
}

async function submit() {
  if (submitting.value) return
  submitting.value = true
  err.value = ''
  try {
    const res = await apiFetch('/api/setup/complete', { method: 'POST', body: JSON.stringify(form) })
    if (res.token) {
      localStorage.setItem('saas_token', res.token)
    }
    emit('completed', res)
  } catch (e) {
    err.value = e.message
  } finally {
    submitting.value = false
  }
}
</script>
