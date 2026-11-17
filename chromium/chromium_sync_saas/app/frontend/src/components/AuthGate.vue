<template>
  <div class="main" style="max-width: 460px; padding-top: 64px">
    <div class="card">
      <h2 class="card-title">
        <span>Chromium Sync SaaS</span>
        <span class="tag tag-info">多租户云控平台</span>
      </h2>
      <div class="row" style="margin-bottom: 16px">
        <button class="btn" :class="{ 'btn-primary': mode === 'login' }" @click="switchMode('login')">账号登录</button>
        <button
          v-if="status.allow_public_register"
          class="btn"
          :class="{ 'btn-primary': mode === 'register' }"
          @click="switchMode('register')"
        >
          公开注册租户
        </button>
      </div>

      <div v-if="mode === 'register'" class="banner banner-info" style="margin-bottom: 14px">
        注册即获独立租户空间、专属 <span class="mono">JOIN_TOKEN</span> 与 <span class="mono">API_KEY</span>，可挂机分享节点赚取租金或按需租用节点市场算力。
      </div>

      <div class="field">
        <label>用户名</label>
        <input class="input" v-model="form.username" placeholder="3~32 位字母/数字/下划线" />
      </div>
      <div v-if="mode === 'register'" class="field">
        <label>联系邮箱（选填）</label>
        <input class="input" v-model="form.email" placeholder="name@example.com" />
      </div>
      <div class="field">
        <label>密码</label>
        <input class="input" type="password" v-model="form.password" @keyup.enter="submit" />
      </div>

      <div class="field">
        <label>算术验证码</label>
        <div class="row">
          <div v-html="captchaSvg" @click="loadCaptcha" style="cursor: pointer; height: 38px" title="点击刷新验证码"></div>
          <input class="input" style="flex: 1" v-model="form.captcha_answer" placeholder="输入计算结果" @keyup.enter="submit" />
        </div>
      </div>

      <div v-if="err" class="banner banner-danger">{{ err }}</div>
      <button class="btn btn-primary" style="width: 100%; padding: 10px" @click="submit" :disabled="loading">
        {{ loading ? '提交中...' : mode === 'login' ? '立即登录' : '注册并进入控制台' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { apiFetch } from '../api'

const props = defineProps({ status: { type: Object, default: () => ({}) } })
const emit = defineEmits(['authenticated'])

const mode = ref('login')
const loading = ref(false)
const err = ref('')
const captchaSvg = ref('')
const form = reactive({
  username: '',
  email: '',
  password: '',
  captcha_token: '',
  captcha_answer: '',
})

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
  form.captcha_answer = ''
  loadCaptcha()
}

async function submit() {
  loading.value = true
  err.value = ''
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

onMounted(loadCaptcha)
</script>
