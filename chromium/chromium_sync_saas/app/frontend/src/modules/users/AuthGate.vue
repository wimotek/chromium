<template>
  <div class="auth-viewport">
    <div class="auth-shell">
      <section class="auth-brand-card">
        <div>
          <div class="row" style="justify-content: space-between; margin-bottom: 14px">
            <span class="tag tag-info">COMMERCIAL SAAS HUB</span>
            <span class="tag tag-ok">WSS 双通道隔离集群</span>
          </div>
          <h1 style="margin: 0 0 10px; font-size: 26px; font-weight: 700; color: #f8fafc; line-height: 1.3">
            Chromium Sync SaaS<br />多租户分布式浏览器云控平台
          </h1>
          <p class="muted" style="margin: 0 0 18px; font-size: 13.5px">
            面向商业团队与自动化工作流的 Chrome CDP 云端调度基础设施，提供跨网反向穿透、隔离租约算力市场、Cookie 智能同步及全链路财务审计。
          </p>

          <div class="grid-2" style="gap: 10px; margin-bottom: 18px">
            <div style="background: rgba(11, 17, 32, 0.7); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px">
              <div style="font-weight: 600; color: #38bdf8; font-size: 13px">强身份入网隔离</div>
              <div class="muted" style="font-size: 12px; margin-top: 2px">租户专属凭据接入，独占会话与临时 Profile 防串扰</div>
            </div>
            <div style="background: rgba(11, 17, 32, 0.7); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px">
              <div style="font-weight: 600; color: #34d399; font-size: 13px">算力共享与邀请返利</div>
              <div class="muted" style="font-size: 12px; margin-top: 2px">闲置节点挂机分润，推荐好友注册双方得钱包赠金</div>
            </div>
          </div>

          <div v-if="status.referral_enabled" class="banner banner-success" style="margin-bottom: 16px">
            <strong>邀请有礼：</strong>凭好友邀请码注册即额外获赠 <strong>¥{{ status.referral_invitee_bonus_yuan || '3.00' }}</strong> 余额，成功邀请每位新租户再得 <strong>¥{{ status.referral_inviter_bonus_yuan || '5.00' }}</strong> 返利。
          </div>
        </div>

        <div>
          <div class="row" style="justify-content: space-between; margin-bottom: 8px">
            <strong style="font-size: 13px; color: #f8fafc">平台系统公告</strong>
            <span class="muted" style="font-size: 11px">{{ announcements.length }} 条生效公告</span>
          </div>
          <div v-if="announcements.length === 0" class="announcement-item muted" style="font-size: 12px">
            暂无公开公告，欢迎登录进入工作台。
          </div>
          <div v-else class="announcement-list">
            <div v-for="a in announcements" :key="a.id" class="announcement-item">
              <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                <div class="row" style="gap: 6px">
                  <span v-if="a.is_pinned" class="tag tag-warn">置顶</span>
                  <span class="tag" :class="levelTagClass(a.level)">{{ levelLabel(a.level) }}</span>
                  <strong style="font-size: 13px; color: #f8fafc">{{ a.title }}</strong>
                </div>
                <span class="muted mono" style="font-size: 11px">{{ (a.created_at || '').slice(0, 10) }}</span>
              </div>
              <div class="muted" style="font-size: 12px; line-height: 1.5; white-space: pre-wrap">{{ a.content }}</div>
            </div>
          </div>
        </div>
      </section>

      <section class="auth-card">
        <div class="auth-tabs" v-if="status.allow_public_register">
          <button class="auth-tab-btn" :class="{ active: mode === 'login' }" @click="switchMode('login')">账号密码登录</button>
          <button class="auth-tab-btn" :class="{ active: mode === 'register' }" @click="switchMode('register')">注册新租户</button>
        </div>
        <h2 v-else style="margin: 0 0 16px; font-size: 18px; color: #f8fafc">账号密码登录</h2>

        <div v-if="mode === 'register'" class="banner banner-info" style="font-size: 12px">
          注册即分配独立租户空间、专属 <span class="mono">JOIN_TOKEN</span> 与 <span class="mono">API_KEY</span>
          <span v-if="status.require_email_verify">，需完成邮箱验证码安全认证。</span>
        </div>

        <div class="field">
          <label>用户名</label>
          <input class="input" v-model.trim="form.username" placeholder="3~32 位字母/数字/下划线" autocomplete="username" />
        </div>

        <div v-if="mode === 'register'" class="field">
          <label>安全绑定邮箱 <span style="color: #f87171">*</span></label>
          <input class="input" type="email" v-model.trim="form.email" placeholder="name@example.com" autocomplete="email" />
        </div>

        <div class="field">
          <label>登录密码</label>
          <input
            class="input"
            type="password"
            v-model="form.password"
            placeholder="请输入登录密码"
            autocomplete="current-password"
            @keyup.enter="submit"
          />
        </div>

        <div class="field">
          <label>图形验证码（点击图片刷新，不区分大小写）</label>
          <div class="row" style="flex-wrap: nowrap">
            <div class="captcha-box" v-html="captchaSvg" @click="loadCaptcha" title="点击换一张验证码"></div>
            <input
              class="input mono"
              style="flex: 1; text-transform: uppercase; letter-spacing: 2px"
              v-model.trim="form.captcha_answer"
              maxlength="8"
              placeholder="输入 5 位字符"
              @keyup.enter="submit"
            />
          </div>
        </div>

        <div v-if="mode === 'register' && status.require_email_verify" class="field">
          <label>邮箱验证码 <span style="color: #f87171">*</span></label>
          <div class="row" style="flex-wrap: nowrap">
            <input
              class="input mono"
              style="flex: 1; letter-spacing: 2px"
              v-model.trim="form.email_code"
              maxlength="8"
              placeholder="输入 6 位邮箱数字验证码"
              @keyup.enter="submit"
            />
            <button
              class="btn"
              style="white-space: nowrap"
              @click="sendEmailCode"
              :disabled="sendingCode || emailCooldown > 0"
            >
              {{ sendingCode ? '发送中...' : emailCooldown > 0 ? `${emailCooldown}s 后重发` : '发送邮箱验证码' }}
            </button>
          </div>
          <div v-if="emailTip" style="font-size: 12px; color: #34d399; margin-top: 5px">{{ emailTip }}</div>
        </div>

        <div v-if="mode === 'register' && status.referral_enabled" class="field">
          <label>推荐邀请码（选填，填写可获额外注册赠金）</label>
          <input class="input mono" style="text-transform: uppercase" v-model.trim="form.invite_code" placeholder="例如 A8K9P2M4（无则留空）" />
        </div>

        <div v-if="err" class="banner banner-danger">{{ err }}</div>

        <button class="btn btn-primary" style="width: 100%; padding: 11px; font-size: 14px; font-weight: 600" @click="submit" :disabled="loading">
          {{ loading ? '正在提交验证...' : mode === 'login' ? '立即登录' : '验证并注册账号' }}
        </button>
      </section>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { apiFetch } from '../../api'

const props = defineProps({ status: { type: Object, default: () => ({}) } })
const emit = defineEmits(['authenticated'])

const mode = ref('login')
const loading = ref(false)
const sendingCode = ref(false)
const emailCooldown = ref(0)
const emailTip = ref('')
const err = ref('')
const captchaSvg = ref('')
const announcements = ref([])
let cdTimer = null

const form = reactive({
  username: '',
  email: '',
  password: '',
  captcha_token: '',
  captcha_answer: '',
  email_code: '',
  invite_code: '',
})

function levelTagClass(lv) {
  if (lv === 'danger') return 'tag-danger'
  if (lv === 'warn') return 'tag-warn'
  if (lv === 'success') return 'tag-ok'
  return 'tag-info'
}

function levelLabel(lv) {
  if (lv === 'danger') return '紧急'
  if (lv === 'warn') return '维护'
  if (lv === 'success') return '活动'
  return '公告'
}

async function loadPublicAnnouncements() {
  try {
    const res = await apiFetch('/api/announcements/public')
    announcements.value = res.announcements || []
  } catch {
    announcements.value = []
  }
}

async function loadCaptcha() {
  try {
    const res = await apiFetch('/api/captcha')
    form.captcha_token = res.token
    captchaSvg.value = res.svg
  } catch (e) {
    err.value = e.message
  }
}

function switchMode(next) {
  mode.value = next
  err.value = ''
  emailTip.value = ''
  form.captcha_answer = ''
  loadCaptcha()
}

function startCooldown(sec) {
  clearInterval(cdTimer)
  emailCooldown.value = Math.max(1, Number(sec || 60))
  cdTimer = setInterval(() => {
    emailCooldown.value -= 1
    if (emailCooldown.value <= 0) {
      clearInterval(cdTimer)
      emailCooldown.value = 0
    }
  }, 1000)
}

async function sendEmailCode() {
  err.value = ''
  emailTip.value = ''
  if (!form.email || !form.email.includes('@')) {
    err.value = '请先填写正确的邮箱地址'
    return
  }
  if (!form.captcha_answer) {
    err.value = '请先输入上方的图形验证码后再发送邮箱验证码'
    return
  }
  sendingCode.value = true
  try {
    const res = await apiFetch('/api/auth/send-email-code', {
      method: 'POST',
      body: JSON.stringify({
        email: form.email,
        captcha_token: form.captcha_token,
        captcha_answer: form.captcha_answer,
      }),
    })
    emailTip.value = `${res.message}。系统已自动刷新图形验证码，提交注册时请填写新验证码。`
    startCooldown(res.cooldown_seconds || 60)
    form.captcha_answer = ''
    await loadCaptcha()
  } catch (e) {
    err.value = e.message
    form.captcha_answer = ''
    await loadCaptcha()
  } finally {
    sendingCode.value = false
  }
}

async function submit() {
  if (loading.value) return
  err.value = ''
  if (!form.username || !form.password) {
    err.value = '请输入用户名和密码'
    return
  }
  if (!form.captcha_answer) {
    err.value = '请输入图形验证码'
    return
  }
  if (mode.value === 'register') {
    if (!form.email || !form.email.includes('@')) {
      err.value = '注册必须填写有效邮箱地址'
      return
    }
    if (props.status.require_email_verify && !form.email_code) {
      err.value = '请输入邮箱收到的 6 位验证码'
      return
    }
  }

  loading.value = true
  try {
    const endpoint = mode.value === 'login' ? '/api/login' : '/api/register'
    const res = await apiFetch(endpoint, { method: 'POST', body: JSON.stringify(form) })
    localStorage.setItem('saas_token', res.token)
    emit('authenticated', res)
  } catch (e) {
    err.value = e.message
    form.captcha_answer = ''
    await loadCaptcha()
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  const params = new URLSearchParams(window.location.search)
  const refCode = (params.get('ref') || params.get('invite') || '').trim().toUpperCase()
  if (refCode) {
    form.invite_code = refCode
    if (props.status.allow_public_register !== false) {
      mode.value = 'register'
    }
  }
  loadCaptcha()
  loadPublicAnnouncements()
})

onBeforeUnmount(() => {
  clearInterval(cdTimer)
})
</script>
