<template>
  <div class="auth-wrapper" :class="{ 'has-notice': hasNoticeContent }">
    <!-- 沉浸式登录大容器 (无公告时居中单一卡片；有公告时并排双列) -->
    <div class="auth-unified-card">
      <!-- 左侧：系统公告栏 (当且仅当存在真实内容时才渲染) -->
      <div v-if="hasNoticeContent" class="notice-side-panel">
        <div class="notice-top-tag">
          <span class="pulse-dot"></span>
          <span>SYSTEM BROADCAST</span>
        </div>
        <h3 class="notice-side-title">📢 全局服务运行通告</h3>
        <div class="notice-side-content">{{ cleanSystemNotice }}</div>
        <div class="notice-bottom-hint">
          ⚡ 节点由自动化集群全天候巡检，若遇连接波动请关注此栏。
        </div>
      </div>

      <!-- 右侧：核心认证表单 -->
      <div class="form-side-panel">
        <h2 class="card-title">{{ authCardTitle }}</h2>

        <!-- A. 登录模式 -->
        <template v-if="authMode === 'login'">
          <div class="form-item">
            <label>ACCOUNT / 用户名 或 注册邮箱</label>
            <input v-model="authForm.username" type="text" class="cyber-input modal-input" placeholder="输入用户名或注册邮箱" />
          </div>
          <div class="form-item">
            <label>ACCESS KEY / 登录密码</label>
            <input v-model="authForm.password" type="password" class="cyber-input modal-input" placeholder="请输入密码" />
          </div>
          <div class="form-item">
            <label>CAPTCHA / 算术验证 (点击图片刷新)</label>
            <div class="captcha-group">
              <input v-model="loginCaptchaAns" type="text" class="cyber-input captcha-input" placeholder="计算结果" @keyup.enter="handleAuth" />
              <div class="captcha-svg-box" @click="refreshCaptcha('login')" v-html="loginCaptcha.svg" title="点击刷新验证码"></div>
            </div>
          </div>
          <button class="btn-cyber-primary" :disabled="loading" style="width: 100%; margin-top: 6px;" @click="handleAuth">
            {{ loading ? 'AUTHENTICATING...' : '登录系统' }}
          </button>
          <div v-if="!isPureAdmin" class="auth-nav-links">
            <a href="javascript:;" @click="switchAuthMode('register')">没有账号？邮箱注册</a>
            <a href="javascript:;" class="text-warning" @click="switchAuthMode('forgot')">忘记密码？</a>
          </div>
        </template>

        <!-- B. 注册模式 -->
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
            <label>CAPTCHA / 算术防刷验证</label>
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
          <button class="btn-cyber-primary" :disabled="loading" style="width: 100%; margin-top: 6px;" @click="handleAuth">
            {{ loading ? 'AUTHENTICATING...' : '验证并激活账号' }}
          </button>
          <div class="auth-nav-links">
            <a href="javascript:;" @click="switchAuthMode('login')">已有账号？返回登录</a>
          </div>
        </template>

        <!-- C. 找回密码模式 -->
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
          <button class="btn-cyber-primary" :disabled="loading" style="width: 100%; margin-top: 6px;" @click="submitForgotPassword">
            {{ loading ? 'PROCESSING...' : '确认重置密码' }}
          </button>
          <div class="auth-nav-links">
            <a href="javascript:;" @click="switchAuthMode('login')">想起密码？返回登录</a>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

const props = defineProps({
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

// 核心判断：只有存在非空白有效字符时，才视作有公告，绝不空置渲染
const cleanSystemNotice = computed(() => (props.systemNotice || '').trim())
const hasNoticeContent = computed(() => Boolean(cleanSystemNotice.value))

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

<style scoped>
/* 全局居中自适应容器 */
.auth-wrapper {
  min-height: calc(100vh - 120px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  box-sizing: border-box;
}

/* 一体化双列 / 居中拟态卡片 */
.auth-unified-card {
  display: flex;
  background: #0f172a;
  border: 1px solid rgba(56, 189, 248, 0.25);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
  width: 100%;
  max-width: 440px;
  transition: max-width 0.3s ease;
}

/* 当包含公告时，自动横向舒展为现代双列布局 (最大宽度 820px) */
.auth-wrapper.has-notice .auth-unified-card {
  max-width: 820px;
}

/* 左侧：通告面板 */
.notice-side-panel {
  flex: 1.1;
  background: linear-gradient(145deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.85));
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  padding: 36px 32px;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

.notice-top-tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #38bdf8;
  background: rgba(56, 189, 248, 0.12);
  padding: 4px 10px;
  border-radius: 20px;
  border: 1px solid rgba(56, 189, 248, 0.3);
  align-self: flex-start;
  margin-bottom: 16px;
}

.pulse-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #38bdf8;
  box-shadow: 0 0 8px #38bdf8;
}

.notice-side-title {
  margin: 0 0 14px 0;
  font-size: 18px;
  color: #f8fafc;
  font-weight: 700;
}

.notice-side-content {
  flex: 1;
  font-size: 13px;
  line-height: 1.8;
  color: #cbd5e1;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-y: auto;
  max-height: 320px;
  padding-right: 8px;
}

.notice-side-content::-webkit-scrollbar {
  width: 4px;
}
.notice-side-content::-webkit-scrollbar-thumb {
  background: #334155;
  border-radius: 2px;
}

.notice-bottom-hint {
  font-size: 11px;
  color: #64748b;
  margin-top: 20px;
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
  padding-top: 14px;
}

/* 右侧：表单面板 */
.form-side-panel {
  flex: 1;
  padding: 36px 32px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: #0f172a;
}

.card-title {
  margin: 0 0 24px 0;
  font-size: 18px;
  font-weight: 700;
  color: #f1f5f9;
  text-align: center;
}

/* 响应式适配：移动端自然向下堆叠 */
@media (max-width: 768px) {
  .auth-unified-card {
    flex-direction: column;
    max-width: 440px !important;
  }
  .notice-side-panel {
    border-right: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    padding: 24px;
  }
  .notice-side-content {
    max-height: 140px;
  }
  .form-side-panel {
    padding: 24px;
  }
}
</style>