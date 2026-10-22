<template>
  <div class="layout-container">
    <el-header class="header">
      <div class="logo">⚡ {{ isPureAdmin ? 'Xray 管理控制台' : 'Xray 用户服务中心' }}</div>
      <div v-if="currentUser.username" class="user-info">
        <el-tag :type="currentUser.role === 'admin' ? 'danger' : 'success'">
          {{ currentUser.role === 'admin' ? '管理员' : '普通用户' }}
        </el-tag>
        <span class="username">{{ currentUser.username }}</span>
        <el-button size="small" type="info" plain @click="logout">退出</el-button>
      </div>
    </el-header>

    <el-main class="main">
      <!-- 1. 登录与注册 -->
      <div v-if="!currentUser.username" class="auth-wrapper">
        <el-card class="auth-card">
          <template #header>
            <h3 style="margin: 0; text-align: center;">
              {{ isPureAdmin ? '管理员登录' : (isRegister ? '注册新账号' : '用户登录') }}
            </h3>
          </template>
          <el-form :model="authForm" label-position="top">
            <el-form-item label="用户名">
              <el-input v-model="authForm.username" placeholder="请输入用户名" />
            </el-form-item>
            <el-form-item label="密码">
              <el-input v-model="authForm.password" type="password" placeholder="请输入密码" show-password />
            </el-form-item>
            <el-button type="primary" :loading="loading" style="width: 100%;" @click="handleAuth">
              {{ isRegister ? '注册' : '登录' }}
            </el-button>
            <div v-if="!isPureAdmin" style="text-align: center; margin-top: 15px;">
              <el-link type="primary" @click="isRegister = !isRegister">
                {{ isRegister ? '已有账号？点此登录' : '没有账号？注册领体验流量' }}
              </el-link>
            </div>
          </el-form>
        </el-card>
      </div>

      <!-- 2. 用户个人专属面板 (默认启动) -->
      <div v-else-if="currentUser.role === 'user'">
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-card shadow="hover">
              <template #header><b>📊 剩余流量与有效期</b></template>
              <div style="text-align: center; padding: 10px 0;">
                <el-progress type="dashboard" :percentage="trafficPercent" :color="progressColors" />
                <p>已用：{{ currentUser.used_mb }} MB / 总额：{{ currentUser.limit_mb }} MB</p>
                <p>到期时间：<el-tag type="warning">{{ currentUser.expire_date }}</el-tag></p>
              </div>
            </el-card>
          </el-col>

          <el-col :xs="24" :sm="12">
            <el-card shadow="hover">
              <template #header><b>🎟️ 卡密充值续费</b></template>
              <p style="font-size: 13px; color: #64748b;">输入购买的卡密，即时自动增加配额并延长到期时间：</p>
              <el-input v-model="rechargeCode" placeholder="例如: KM-XXXXX" style="margin-bottom: 15px;" />
              <el-button type="success" :loading="loading" style="width: 100%;" @click="handleRecharge">
                立即兑换套餐
              </el-button>
            </el-card>
          </el-col>
        </el-row>

        <el-card shadow="hover" style="margin-top: 20px;">
          <template #header><b>🔗 节点订阅与密钥 (VLESS Reality)</b></template>
          <el-form label-position="top">
            <el-form-item label="REALITY Public Key:">
              <el-input v-model="currentUser.public_key" readonly />
            </el-form-item>
            <el-form-item label="您的专属节点链接:">
              <el-input v-model="currentUser.sub_link" type="textarea" :rows="3" readonly />
            </el-form-item>
            <el-button type="primary" @click="copyText(currentUser.sub_link)">一键复制节点</el-button>
          </el-form>
        </el-card>
      </div>

      <!-- 3. 管理员后台 (APP_MODE 为 admin 或 all 时显示) -->
      <div v-else-if="currentUser.role === 'admin'">
        <el-card shadow="hover" style="margin-bottom: 20px;">
          <template #header><b>🛠️ 批量生成卡密</b></template>
          <el-form :inline="true" :model="cardGenForm">
            <el-form-item label="流量 (GB)"><el-input-number v-model="cardGenForm.traffic_gb" :min="1" /></el-form-item>
            <el-form-item label="有效天数"><el-input-number v-model="cardGenForm.days" :min="1" /></el-form-item>
            <el-form-item label="制卡数量"><el-input-number v-model="cardGenForm.count" :min="1" :max="100" /></el-form-item>
            <el-form-item><el-button type="success" :loading="loading" @click="generateCards">立即批量制卡</el-button></el-form-item>
          </el-form>
        </el-card>

        <el-tabs type="border-card">
          <el-tab-pane label="卡密库存 (最新50条)">
            <el-table :data="adminCards" stripe>
              <el-table-column prop="code" label="卡密" width="220" />
              <el-table-column label="套餐"><template #default="{ row }">{{ row.traffic_gb }} GB / {{ row.days }} 天</template></el-table-column>
              <el-table-column label="状态" width="100">
                <template #default="{ row }"><el-tag :type="row.is_used ? 'danger' : 'success'">{{ row.is_used ? '已使用' : '未使用' }}</el-tag></template>
              </el-table-column>
              <el-table-column prop="used_by" label="兑换用户" />
              <el-table-column label="操作" width="120">
                <template #default="{ row }"><el-button size="small" @click="copyText(row.code)">复制卡密</el-button></template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="全站用户监控">
            <el-table :data="adminUsers" stripe>
              <el-table-column prop="username" label="用户名" />
              <el-table-column label="流量使用"><template #default="{ row }">{{ row.used_mb }} / {{ row.traffic_limit_mb }} MB</template></el-table-column>
              <el-table-column prop="expire_date" label="到期时间" />
              <el-table-column prop="role" label="身份" width="100" />
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-main>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

const loading = ref(false)
const isRegister = ref(false)
const isPureAdmin = ref(false)
const rechargeCode = ref('')
const currentUser = reactive({ username: '', role: '', used_mb: 0, limit_mb: 0, expire_date: '', public_key: '', sub_link: '' })
const authForm = reactive({ username: '', password: '' })
const cardGenForm = reactive({ traffic_gb: 50, days: 30, count: 5 })
const adminCards = ref([])
const adminUsers = ref([])

onMounted(async () => {
  try {
    const res = await axios.get('/api/system/info')
    if (res.data.data.mode === 'admin') {
      isPureAdmin.value = true
    }
  } catch (_) {}
})

const trafficPercent = computed(() => currentUser.limit_mb ? Math.min(100, Math.round((currentUser.used_mb / currentUser.limit_mb) * 100)) : 0)
const progressColors = [{ color: '#67c23a', percentage: 60 }, { color: '#e6a23c', percentage: 80 }, { color: '#f56c6c', percentage: 100 }]

// 通用剪贴板降级（完全解决 HTTP 无法复制的 Bug）
const copyText = async (text) => {
  if (!text) return ElMessage.warning('复制内容为空')
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      ElMessage.success('复制成功！')
      return
    } catch (_) {}
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
    ElMessage.success('复制成功！')
  } catch (_) {
    ElMessage.error('自动复制失败，请手动选择复制')
  }
  document.body.removeChild(ta)
}

const handleAuth = async () => {
  if (!authForm.username || !authForm.password) return ElMessage.warning('请输入用户名与密码')
  loading.value = true
  try {
    const res = await axios.post(isRegister.value ? '/api/register' : '/api/login', authForm)
    if (res.data.code === 200) {
      if (isRegister.value) {
        ElMessage.success('注册成功，请登录！')
        isRegister.value = false
      } else {
        ElMessage.success('登录成功')
        Object.assign(currentUser, res.data.data)
        if (currentUser.role === 'admin') loadAdminData()
      }
    } else {
      ElMessage.error(res.data.msg)
    }
  } finally {
    loading.value = false
  }
}

const handleRecharge = async () => {
  if (!rechargeCode.value) return ElMessage.warning('请输入卡密')
  loading.value = true
  try {
    const res = await axios.post('/api/recharge', { username: currentUser.username, card_code: rechargeCode.value })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      rechargeCode.value = ''
      handleAuth()
    } else {
      ElMessage.error(res.data.msg)
    }
  } finally {
    loading.value = false
  }
}

const loadAdminData = async () => {
  const res = await axios.post('/api/admin/data', { admin_user: authForm.username, admin_pwd: authForm.password })
  if (res.data.code === 200) {
    adminCards.value = res.data.cards
    adminUsers.value = res.data.users
  }
}

const generateCards = async () => {
  loading.value = true
  try {
    const res = await axios.post('/api/admin/cards/generate', { admin_user: authForm.username, admin_pwd: authForm.password, ...cardGenForm })
    if (res.data.code === 200) {
      ElMessage.success('卡密批量生成成功')
      loadAdminData()
    } else {
      ElMessage.error(res.data.msg)
    }
  } finally {
    loading.value = false
  }
}

const logout = () => location.reload()
</script>

<style scoped>
.layout-container { min-height: 100vh; }
.header { background: #fff; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e4e7ed; padding: 0 20px; }
.logo { font-size: 18px; font-weight: bold; color: #409eff; }
.user-info { display: flex; align-items: center; gap: 10px; }
.username { font-weight: 500; font-size: 14px; }
.main { max-width: 900px; margin: 20px auto; width: 100%; box-sizing: border-box; }
.auth-wrapper { display: flex; justify-content: center; padding-top: 40px; }
.auth-card { width: 380px; }
</style>