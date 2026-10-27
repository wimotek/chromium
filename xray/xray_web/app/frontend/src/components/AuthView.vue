<template>
  <div class="auth-center">
    <!-- 登录页系统公告展示栏 -->
    <div v-if="systemNotice" class="cyber-notice-card">
      <div class="notice-header"><span class="notice-icon">📢</span><strong>系统公告 NOTICE</strong></div>
      <div class="notice-body">{{ systemNotice }}</div>
    </div>

    <div class="cyber-card auth-box">
      <h2 class="card-title">{{ authCardTitle }}</h2>

      <!-- A. 登录 -->
      <template v-if="authMode === 'login'">
        <div class="form-item">
          <label>ACCOUNT / 用户名 或 注册邮箱</label>
          <input v-model="authForm.username" type="text" class="cyber-input modal-input" placeholder="输入用户名或邮箱地址" />
        </div>
        <div class="form-item">
          <label>ACCESS KEY / 登录密码</label>
          <input v-model="authForm.password" type="password" class="cyber-input modal-input" placeholder="请输入密码" />
        </div>
        <div class="form-item">
          <label>CAPTCHA / 算术验证 (点击图片可刷新)</label>
          <div class="captcha-group">
            <input v-model="loginCaptchaAns" type="text" class="cyber-input captcha-input" placeholder="计算结果" @keyup.enter="handleAuth" />
            <div class="captcha-svg-box" @click="refreshCaptcha('login')" v-html="loginCaptcha.svg" title="点击刷新验证码"></div>
          </div>
        </div>
        <button class="btn-cyber-primary" :disabled="loading" @click="handleAuth">
          {{ loading ? 'AUTHENTICATING...' : '登录系统' }}
        </button>
        <div v-if="!isPureAdmin" class="auth-nav-links">
          <a href="javascript:;" @click="switchAuthMode('register')">没有账号？邮箱注册</a>
          <a href="javascript:;" class="text-warning" @click="switchAuthMode('forgot')">忘记密码？</a>
        </div>
      </template>

      <!-- B. 注册 -->
      <template v-else-if="authMode === 'register'">
        <div class="form-item">
          <label>USER IDENTIFIER / 设置用户名</label>
          <input v-model="authForm.username" type="text" class="cyber-input modal-input" placeholder="字母/数字用户名" />
        </div>
        <div class="form-item">
          <label>EMAIL / 接收激活码邮箱</label>
          <input v-model="authForm.email" type="email" class="cyber-input modal-input" placeholder="name@example.com" />
        </div>
        <div class="form-item">
          <label>CAPTCHA / 算术验证 (防刷发信)</label>
          <div class="captcha-group">
            <input v-model="registerCaptchaAns" type="text" class="cyber-input captcha-input" placeholder="计算结果" />
            <div class="captcha-svg-box" @click="refreshCaptcha('register')" v-html="registerCaptcha.svg" title="点击刷新验证码"></div>
          </div>
        </div>
        <div class="form-item">
          <label>VERIFY CODE / 邮箱激活码</label>
          <div class="code-send-group">
            <input v-model="authForm.code" type="text" class="cyber-input" placeholder="6 位验证码" />
            <button class="btn-cyber-code" :disabled="countdown > 0 || sendingCode" @click="sendRegisterCode">
              {{ countdownText }}
            </button>
          </div>
        </div>
        <div class="form-item">
          <label>ACCESS KEY / 设置新登录密码</label>
          <input v-model="authForm.password" type="password" class="cyber-input modal-input" placeholder="至少 6 位密码" />
        </div>
        <button class="btn-cyber-primary" :disabled="loading" @click="handleAuth">
          {{ loading ? 'AUTHENTICATING...' : '验证并激活账号' }}
        </button>
        <div class="auth-nav-links">
          <a href="javascript:;" @click="switchAuthMode('login')">已有账号？返回登录</a>
        </div>
      </template>

      <!-- C. 找回密码 -->
      <template v-else-if="authMode === 'forgot'">
        <div class="form-item">
          <label>REGISTERED EMAIL / 绑定的注册邮箱</label>
          <input v-model="forgotForm.email" type="email" class="cyber-input modal-input" placeholder="输入绑定的邮箱" />
        </div>
        <div class="form-item">
          <label>CAPTCHA / 算术验证</label>
          <div class="captcha-group">
            <input v-model="forgotCaptchaAns" type="text" class="cyber-input captcha-input" placeholder="计算结果" />
            <div class="captcha-svg-box" @click="refreshCaptcha('forgot')" v-html="forgotCaptcha.svg" title="点击刷新验证码"></div>
          </div>
        </div>
        <div class="form-item">
          <label>RESET CODE / 邮箱重置码</label>
          <div class="code-send-group">
            <input v-model="forgotForm.code" type="text" class="cyber-input" placeholder="6 位重置码" />
            <button class="btn-cyber-code" :disabled="countdown > 0 || sendingCode" @click="sendForgotCode">
              {{ countdownText }}
            </button>
          </div>
        </div>
        <div class="form-item">
          <label>NEW PASSWORD / 设置新密码</label>
          <input v-model="forgotForm.new_password" type="password" class="cyber-input modal-input" placeholder="输入新密码 (至少6位)" />
        </div>
        <button class="btn-cyber-primary" :disabled="loading" @click="submitForgotPassword">
          {{ loading ? 'PROCESSING...' : '确认重置密码' }}
        </button>
        <div class="auth-nav-links">
          <a href="javascript:;" @click="switchAuthMode('login')">想起密码？返回登录</a>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

defineProps({
  systemNotice: { type: String, default: '' },
  isPureAdmin: { type: Boolean, default: false }
})

const emit = defineEmits(['login-success'])

const loading = ref(false)
const authMode = ref('login')
const countdown = ref(0)
const sendingCode = ref(false)

const loginCaptcha = reactive({ id: '', svg: '' })
const loginCaptchaAns = ref('')
const registerCaptcha = reactive({ id: '', svg: '' })
const registerCaptchaAns = ref('')
const forgotCaptcha = reactive({ id: '', svg: '' })
const forgotCaptchaAns = ref('')

const authForm = reactive({ username: '', email: '', code: '', password: '' })
const forgotForm = reactive({ email: '', code: '', new_password: '' })

onMounted(() => {
  refreshCaptcha('login')
})

const refreshCaptcha = async (type) => {
  try {
    const res = await axios.get('/api/auth/captcha')
    if (res.data.code === 200) {
      if (type === 'login') {
        loginCaptcha.id = res.data.data.captcha_id
        loginCaptcha.svg = res.data.data.svg
        loginCaptchaAns.value = ''
      } else if (type === 'register') {
        registerCaptcha.id = res.data.data.captcha_id
        registerCaptcha.svg = res.data.data.svg
        registerCaptchaAns.value = ''
      } else if (type === 'forgot') {
        forgotCaptcha.id = res.data.data.captcha_id
        forgotCaptcha.svg = res.data.data.svg
        forgotCaptchaAns.value = ''
      }
    }
  } catch (_) {}
}

const switchAuthMode = (mode) => {
  authMode.value = mode
  refreshCaptcha(mode)
}

const authCardTitle = computed(() => {
  if (authMode.value === 'login') return '控制台账号接入'
  if (authMode.value === 'register') return '新用户激活注册'
  return '🔐 找回 / 重置密码'
})

const countdownText = computed(() => {
  if (countdown.value > 0) return countdown.value + 's 后重试'
  if (sendingCode.value) return '发送中...'
  return '获取验证码'
})

const startCountdown = () => {
  countdown.value = 60
  const timer = setInterval(() => {
    countdown.value--
    if (countdown.value <= 0) clearInterval(timer)
  }, 1000)
}

const sendRegisterCode = async () => {
  if (!authForm.email || !authForm.email.includes('@')) return ElMessage.warning('请输入合法电子邮箱')
  if (!registerCaptchaAns.value) return ElMessage.warning('请先输入算术验证码计算结果')

  sendingCode.value = true
  try {
    const res = await axios.post('/api/auth/send_register_code', {
      email: authForm.email,
      captcha_id: registerCaptcha.id,
      captcha_ans: registerCaptchaAns.value
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      startCountdown()
    } else {
      ElMessage.error(res.data.msg)
      refreshCaptcha('register')
    }
  } catch (_) {
    ElMessage.error('验证码发送失败')
    refreshCaptcha('register')
  } finally {
    sendingCode.value = false
  }
}

const sendForgotCode = async () => {
  if (!forgotForm.email || !forgotForm.email.includes('@')) return ElMessage.warning('请输入绑定的注册邮箱')
  if (!forgotCaptchaAns.value) return ElMessage.warning('请先输入算术验证码计算结果')

  sendingCode.value = true
  try {
    const res = await axios.post('/api/auth/send_reset_code', {
      email: forgotForm.email,
      captcha_id: forgotCaptcha.id,
      captcha_ans: forgotCaptchaAns.value
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      startCountdown()
    } else {
      ElMessage.error(res.data.msg)
      refreshCaptcha('forgot')
    }
  } catch (_) {
    ElMessage.error('请求失败')
    refreshCaptcha('forgot')
  } finally {
    sendingCode.value = false
  }
}

const submitForgotPassword = async () => {
  if (!forgotForm.email || !forgotForm.code || !forgotForm.new_password) return ElMessage.warning('请填写完整重置信息')
  if (forgotForm.new_password.length < 6) return ElMessage.warning('新密码长度不能少于 6 位')

  loading.value = true
  try {
    const res = await axios.post('/api/auth/reset_password', forgotForm)
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      switchAuthMode('login')
      authForm.username = forgotForm.email
      authForm.password = ''
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('重置失败')
  } finally {
    loading.value = false
  }
}

const handleAuth = async () => {
  if (!authForm.username || !authForm.password) return ElMessage.warning('请填写账号与密码')
  if (authMode.value === 'login' && !loginCaptchaAns.value) return ElMessage.warning('请输入算术验证码计算结果')

  loading.value = true
  const api = authMode.value === 'register' ? '/api/register' : '/api/login'
  try {
    const res = await axios.post(api, {
      ...authForm,
      captcha_id: loginCaptcha.id,
      captcha_ans: loginCaptchaAns.value
    })
    if (res.data.code === 200) {
      if (authMode.value === 'register') {
        ElMessage.success(res.data.msg)
        switchAuthMode('login')
      } else {
        ElMessage.success('登录成功')
        emit('login-success', { user: res.data.data, password: authForm.password })
      }
    } else {
      ElMessage.error(res.data.msg)
      if (authMode.value === 'login') refreshCaptcha('login')
    }
  } catch (_) {
    if (authMode.value === 'login') refreshCaptcha('login')
  } finally {
    loading.value = false
  }
}
</script>