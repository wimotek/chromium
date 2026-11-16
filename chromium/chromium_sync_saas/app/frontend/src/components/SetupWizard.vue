<template>
  <div class="main" style="max-width: 720px; padding-top: 48px">
    <div class="card">
      <h2 class="card-title">SaaS 多租户运营中心 · 首次初始化向导 <span class="tag tag-ok">零 TOFU 强鉴权</span></h2>
      <div class="banner banner-info">
        公网多租户 SaaS 版本已彻底移除未鉴权 TOFU 自动入网机制。请完成数据库、缓存及超级管理员账号配置。
      </div>

      <div class="grid-2">
        <div class="field">
          <label>数据库引擎</label>
          <select class="select" v-model="form.db_type">
            <option value="sqlite">SQLite WAL (内置单机推荐)</option>
            <option value="mysql">MySQL 8.0+ (外置高并发集群)</option>
          </select>
        </div>
        <div class="field">
          <label>平台默认市场加价抽成 (bps, 2000 = 20%)</label>
          <input class="input" type="number" v-model.number="form.saas_platform_fee_bps" min="0" max="10000" />
        </div>
      </div>

      <div v-if="form.db_type === 'mysql'" class="grid-2">
        <div class="field"><label>MySQL 主机</label><input class="input" v-model="form.mysql_host" /></div>
        <div class="field"><label>MySQL 端口</label><input class="input" type="number" v-model.number="form.mysql_port" /></div>
        <div class="field"><label>MySQL 用户名</label><input class="input" v-model="form.mysql_user" /></div>
        <div class="field"><label>MySQL 密码</label><input class="input" type="password" v-model="form.mysql_password" /></div>
        <div class="field"><label>数据库名</label><input class="input" v-model="form.mysql_database" /></div>
      </div>

      <div class="row" style="margin-bottom: 14px">
        <button class="btn" @click="testDb" :disabled="testing">测试数据库连通性</button>
        <span v-if="dbMsg" class="muted">{{ dbMsg }}</span>
      </div>

      <div class="field">
        <label>Redis 缓存连接串（可选，留空自动使用 SQLite Cache 回退）</label>
        <input class="input" v-model="form.redis_url" placeholder="redis://127.0.0.1:6379/0" />
      </div>

      <div class="grid-2">
        <div class="field"><label>超级管理员账号</label><input class="input" v-model="form.admin_username" /></div>
        <div class="field"><label>超级管理员密码（至少 6 位）</label><input class="input" type="password" v-model="form.admin_password" /></div>
      </div>

      <div class="row" style="justify-content: space-between; margin-top: 12px">
        <label class="row" style="cursor: pointer">
          <input type="checkbox" v-model="form.saas_allow_public_register" />
          <span>开放首页公开用户注册</span>
        </label>
        <button class="btn btn-primary" @click="submit" :disabled="submitting">完成初始化并进入控制台</button>
      </div>
      <div v-if="err" class="banner banner-danger" style="margin-top: 12px">{{ err }}</div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { apiFetch } from '../api'

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
  admin_password: '',
  saas_platform_fee_bps: 2000,
  saas_allow_public_register: true,
})
const dbMsg = ref('')
const err = ref('')
const testing = ref(false)
const submitting = ref(false)

async function testDb() {
  testing.value = true
  dbMsg.value = ''
  try {
    const res = await apiFetch('/api/setup/test-db', { method: 'POST', body: JSON.stringify(form) })
    dbMsg.value = res.message || '连接成功'
  } catch (e) {
    dbMsg.value = e.message
  } finally {
    testing.value = false
  }
}

async function submit() {
  submitting.value = true
  err.value = ''
  try {
    const res = await apiFetch('/api/setup/complete', { method: 'POST', body: JSON.stringify(form) })
    localStorage.setItem('saas_token', res.token)
    emit('completed', res)
  } catch (e) {
    err.value = e.message
  } finally {
    submitting.value = false
  }
}
</script>
