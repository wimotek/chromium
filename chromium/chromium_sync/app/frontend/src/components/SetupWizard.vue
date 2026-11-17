<script setup>
import { ref, reactive } from 'vue'

const props = defineProps({
  defaults: {
    type: Object,
    default: () => ({})
  },
  showToast: Function
})

const emit = defineEmits(['completed'])

const step = ref(1)
const testingDb = ref(false)
const testingRedis = ref(false)
const submitting = ref(false)

const dbTestResult = ref(null)
const redisTestResult = ref(null)

const form = reactive({
  db_type: props.defaults?.db_type || 'sqlite',
  mysql_host: props.defaults?.mysql_host || '127.0.0.1',
  mysql_port: props.defaults?.mysql_port || 3306,
  mysql_user: props.defaults?.mysql_user || 'root',
  mysql_password: '',
  mysql_database: props.defaults?.mysql_database || 'chromium_sync',
  use_redis: false,
  redis_url: '',
  admin_username: 'admin',
  admin_password: '',
  confirm_password: '',
  hub_public_host: '',
  hub_external_port: '',
  tofu_enabled: props.defaults?.tofu_enabled !== false,
  tofu_auto_approve: Boolean(props.defaults?.tofu_auto_approve)
})

const readJsonSafe = async (res) => {
  const raw = await res.text()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { detail: raw.slice(0, 200) }
  }
}

const testDbConnection = async () => {
  testingDb.value = true
  dbTestResult.value = null
  try {
    const res = await fetch('/api/setup/test-db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        db_type: form.db_type,
        mysql_host: form.mysql_host,
        mysql_port: Number(form.mysql_port) || 3306,
        mysql_user: form.mysql_user,
        mysql_password: form.mysql_password,
        mysql_database: form.mysql_database
      })
    })
    const data = await readJsonSafe(res)
    if (res.ok) {
      dbTestResult.value = { ok: true, msg: data.message }
    } else {
      dbTestResult.value = { ok: false, msg: data.detail || `数据库连接失败 (HTTP ${res.status})` }
    }
  } catch (e) {
    dbTestResult.value = { ok: false, msg: String(e) }
  } finally {
    testingDb.value = false
  }
}

const testRedisConnection = async () => {
  if (!form.redis_url.trim()) {
    redisTestResult.value = { ok: false, msg: '请输入 Redis 连接 URL，如 redis://127.0.0.1:6379/0' }
    return
  }
  testingRedis.value = true
  redisTestResult.value = null
  try {
    const res = await fetch('/api/setup/test-redis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redis_url: form.redis_url.trim() })
    })
    const data = await readJsonSafe(res)
    if (res.ok) {
      redisTestResult.value = { ok: true, msg: data.message }
    } else {
      redisTestResult.value = { ok: false, msg: data.detail || `Redis 连接失败 (HTTP ${res.status})，保存后仍会自动回退至 SQLite Cache` }
    }
  } catch (e) {
    redisTestResult.value = { ok: false, msg: String(e) }
  } finally {
    testingRedis.value = false
  }
}

const nextStep = async () => {
  if (step.value === 1) {
    if (form.db_type === 'mysql' && (!form.mysql_host.trim() || !form.mysql_database.trim() || !form.mysql_user.trim())) {
      props.showToast('请完整填写 MySQL 主机、库名与用户名', 'error')
      return
    }
    if (!dbTestResult.value?.ok) {
      await testDbConnection()
      if (!dbTestResult.value?.ok) {
        props.showToast(dbTestResult.value?.msg || '请先确保数据库连通', 'error')
        return
      }
    }
  }
  if (step.value === 3) {
    if (!form.admin_username.trim() || form.admin_username.trim().length < 2) {
      props.showToast('管理员用户名至少 2 位字符', 'error')
      return
    }
    if (!form.admin_password || form.admin_password.length < 6) {
      props.showToast('管理员密码至少 6 位字符', 'error')
      return
    }
    if (form.admin_password !== form.confirm_password) {
      props.showToast('两次输入的密码不一致', 'error')
      return
    }
  }
  if (step.value < 4) step.value += 1
}

const submitSetup = async () => {
  submitting.value = true
  try {
    const payload = {
      db_type: form.db_type,
      mysql_host: form.mysql_host.trim(),
      mysql_port: Number(form.mysql_port) || 3306,
      mysql_user: form.mysql_user.trim(),
      mysql_password: form.mysql_password,
      mysql_database: form.mysql_database.trim(),
      redis_url: form.use_redis ? form.redis_url.trim() : '',
      admin_username: form.admin_username.trim(),
      admin_password: form.admin_password,
      hub_public_host: form.hub_public_host.trim(),
      hub_external_port: form.hub_external_port ? Number(form.hub_external_port) : null,
      tofu_enabled: form.tofu_enabled,
      tofu_auto_approve: form.tofu_auto_approve
    }
    const res = await fetch('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const data = await readJsonSafe(res)
    if (!res.ok) {
      props.showToast(data.detail || `初始化失败 (HTTP ${res.status})`, 'error')
      return
    }
    props.showToast(`安装向导完成！数据库: ${(data.db_type || form.db_type).toUpperCase()} | 缓存: ${data.cache_backend || 'sqlite_cache'}`, 'success')
    emit('completed', data)
  } catch (e) {
    props.showToast(`请求异常: ${e}`, 'error')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="login-screen-center">
    <div class="wizard-card-navy">
      <div class="wizard-header">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="bolt-symbol">⚡</span>
          <span class="brand-white">CDP</span>
          <span class="brand-cyan">CLUSTER // 首次安装向导</span>
        </div>
        <span class="wizard-step-tag">步骤 {{ step }} / 4</span>
      </div>

      <!-- 步骤指示条 -->
      <div class="wizard-stepper">
        <div :class="['step-item', step === 1 ? 'step-active' : (step > 1 ? 'step-done' : '')]">1. 存储引擎 (ORM)</div>
        <div :class="['step-item', step === 2 ? 'step-active' : (step > 2 ? 'step-done' : '')]">2. 缓存策略</div>
        <div :class="['step-item', step === 3 ? 'step-active' : (step > 3 ? 'step-done' : '')]">3. 管理员与域</div>
        <div :class="['step-item', step === 4 ? 'step-active' : '']">4. 安全与确认</div>
      </div>

      <!-- STEP 1: 数据库引擎选择 -->
      <div v-if="step === 1" class="wizard-body">
        <h3 class="wizard-title">选择持久化数据库引擎 (SQLAlchemy ORM)</h3>
        <p class="wizard-sub">系统全面通过 ORM 管理节点元数据、同步策略与分时流量计量，支持 SQLite 单机持久化或外置 MySQL 集群。</p>

        <div class="row-flex-gap" style="margin-bottom:14px;">
          <label :class="['radio-pill-card', form.db_type === 'sqlite' ? 'radio-pill-active' : '']" @click="form.db_type = 'sqlite'; dbTestResult = null">
            <div style="font-weight:bold; font-size:13px;">💾 SQLite WAL (内置推荐)</div>
            <div style="font-size:11px; color:#94a3b8; margin-top:4px;">零外部依赖，数据保存在 /data/app.db</div>
          </label>
          <label :class="['radio-pill-card', form.db_type === 'mysql' ? 'radio-pill-active' : '']" @click="form.db_type = 'mysql'; dbTestResult = null">
            <div style="font-weight:bold; font-size:13px;">🗄️ MySQL / MariaDB</div>
            <div style="font-size:11px; color:#94a3b8; margin-top:4px;">高并发生产外置库 (PyMySQL utf8mb4)</div>
          </label>
        </div>

        <div v-if="form.db_type === 'mysql'" class="wizard-subpanel">
          <div class="row-flex-gap">
            <div class="form-field-block" style="flex:2;">
              <label class="form-label">MySQL 主机 / IP</label>
              <input v-model="form.mysql_host" placeholder="127.0.0.1" class="cdp-input font-cyan-mono" style="width:100%;">
            </div>
            <div class="form-field-block" style="flex:1;">
              <label class="form-label">端口</label>
              <input v-model="form.mysql_port" type="number" placeholder="3306" class="cdp-input font-cyan-mono" style="width:100%;">
            </div>
          </div>
          <div class="row-flex-gap">
            <div class="form-field-block" style="flex:1;">
              <label class="form-label">用户名</label>
              <input v-model="form.mysql_user" placeholder="root" class="cdp-input font-cyan-mono" style="width:100%;">
            </div>
            <div class="form-field-block" style="flex:1;">
              <label class="form-label">数据库密码</label>
              <input v-model="form.mysql_password" type="password" placeholder="••••••••" class="cdp-input" style="width:100%;">
            </div>
          </div>
          <div class="form-field-block">
            <label class="form-label">数据库名称 (需预先 CREATE DATABASE)</label>
            <input v-model="form.mysql_database" placeholder="chromium_sync" class="cdp-input font-cyan-mono" style="width:100%;">
          </div>
        </div>

        <div class="wizard-test-bar">
          <button type="button" @click="testDbConnection" :disabled="testingDb" class="btn-gray-test">
            {{ testingDb ? '正在探测...' : '🔌 测试数据库连通性' }}
          </button>
          <span v-if="dbTestResult" :style="{ color: dbTestResult.ok ? '#34d399' : '#f87171', fontSize: '12px' }">
            {{ dbTestResult.ok ? '✅ ' : '❌ ' }}{{ dbTestResult.msg }}
          </span>
        </div>
      </div>

      <!-- STEP 2: 缓存引擎 (Redis + SQLite Cache 自动回退) -->
      <div v-if="step === 2" class="wizard-body">
        <h3 class="wizard-title">高速缓存与流量计数缓冲 (Redis + SQLite Cache 自动回退)</h3>
        <p class="wizard-sub">高频流量统计（每帧 CDP 字节与节点网卡增量）、验证码与全局配置均先写入缓存层并周期性批量落盘；当 Redis 未配置或断线时，自动 1.5s 熔断并无缝切换至本地 SQLite WAL Cache。</p>

        <div class="row-flex-gap" style="margin-bottom:14px;">
          <label :class="['radio-pill-card', !form.use_redis ? 'radio-pill-active' : '']" @click="form.use_redis = false; redisTestResult = null">
            <div style="font-weight:bold; font-size:13px;">💾 内置 SQLite WAL Cache</div>
            <div style="font-size:11px; color:#94a3b8; margin-top:4px;">默认单机模式，持久化至 /data/cache.db</div>
          </label>
          <label :class="['radio-pill-card', form.use_redis ? 'radio-pill-active' : '']" @click="form.use_redis = true">
            <div style="font-weight:bold; font-size:13px;">⚡ 启用 Redis 高速缓存</div>
            <div style="font-size:11px; color:#94a3b8; margin-top:4px;">内存级原子计数，断连自动回退 SQLite Cache</div>
          </label>
        </div>

        <div v-if="form.use_redis" class="wizard-subpanel">
          <div class="form-field-block">
            <label class="form-label">Redis 连接 URL (支持密码与 DB 索引)</label>
            <input v-model="form.redis_url" placeholder="redis://:password@127.0.0.1:6379/0" class="cdp-input font-cyan-mono" style="width:100%;">
          </div>
          <div class="wizard-test-bar">
            <button type="button" @click="testRedisConnection" :disabled="testingRedis" class="btn-gray-test">
              {{ testingRedis ? '正在 Ping...' : '⚡ 测试 Redis 连通性' }}
            </button>
            <span v-if="redisTestResult" :style="{ color: redisTestResult.ok ? '#34d399' : '#fbbf24', fontSize: '12px' }">
              {{ redisTestResult.ok ? '✅ ' : '⚠️ ' }}{{ redisTestResult.msg }}
            </span>
          </div>
        </div>
      </div>

      <!-- STEP 3: 管理员凭据与访问域 -->
      <div v-if="step === 3" class="wizard-body">
        <h3 class="wizard-title">初始化超级管理员凭据与 Hub 外部域名</h3>
        <p class="wizard-sub">设置管理员后台登录账户；若容器运行在反代或端口映射之后，可选填外部访问域名/映射端口以便生成精准的边缘节点命令。</p>

        <div class="form-v-stack">
          <div class="form-field-block">
            <label class="form-label">管理员用户名</label>
            <input v-model="form.admin_username" placeholder="admin" class="cdp-input font-cyan-mono" style="width:100%;">
          </div>
          <div class="row-flex-gap">
            <div class="form-field-block" style="flex:1;">
              <label class="form-label">管理员密码 (至少 6 位)</label>
              <input v-model="form.admin_password" type="password" placeholder="输入安全密码" class="cdp-input" style="width:100%;">
            </div>
            <div class="form-field-block" style="flex:1;">
              <label class="form-label">确认密码</label>
              <input v-model="form.confirm_password" type="password" placeholder="再次输入密码" class="cdp-input" style="width:100%;">
            </div>
          </div>

          <div class="wizard-subpanel">
            <div class="row-flex-gap">
              <div class="form-field-block" style="flex:2;">
                <label class="form-label">Hub 对外公网域名 / IP (选填，留空自动识别)</label>
                <input v-model="form.hub_public_host" placeholder="例如: hub.example.com" class="cdp-input font-cyan-mono" style="width:100%;">
              </div>
              <div class="form-field-block" style="flex:1;">
                <label class="form-label">外部映射端口 (选填)</label>
                <input v-model="form.hub_external_port" type="number" :placeholder="String(defaults?.hub_port || 8443)" class="cdp-input font-cyan-mono" style="width:100%;">
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- STEP 4: 安全策略与确认 -->
      <div v-if="step === 4" class="wizard-body">
        <h3 class="wizard-title">零信任 TOFU 准入策略与配置核对</h3>
        <p class="wizard-sub">确认以下初始化参数后，系统将自动创建表结构、激活流量计量服务并签发管理员会话。</p>

        <div class="wizard-subpanel" style="margin-bottom:14px;">
          <label style="display:flex; align-items:center; gap:8px; font-size:12px; color:#e2e8f0; margin-bottom:10px; cursor:pointer;">
            <input type="checkbox" v-model="form.tofu_enabled" class="check-box-blue">
            <span>启用 TOFU 首次信任待审隔离队列（未携带 Join Token 的边缘节点进入隔离等待管理员批准）</span>
          </label>
          <label style="display:flex; align-items:center; gap:8px; font-size:12px; color:#e2e8f0; cursor:pointer;">
            <input type="checkbox" v-model="form.tofu_auto_approve" :disabled="!form.tofu_enabled" class="check-box-blue">
            <span>开启 TOFU 自动免审放行（仅建议可信内网测试时开启）</span>
          </label>
        </div>

        <div class="wizard-summary-box font-mono">
          <div>• ORM 存储引擎: <b style="color:#00f0ff;">{{ form.db_type.toUpperCase() }}</b> <span v-if="form.db_type === 'mysql'">({{ form.mysql_user }}@{{ form.mysql_host }}:{{ form.mysql_port }}/{{ form.mysql_database }})</span></div>
          <div>• 缓存调度引擎: <b style="color:#34d399;">{{ form.use_redis && form.redis_url ? 'Redis (断线自动回退 SQLite Cache)' : 'SQLite WAL Cache' }}</b></div>
          <div>• 超级管理员: <b style="color:#fff;">{{ form.admin_username }}</b></div>
          <div>• 对外访问重写: <b style="color:#cbd5e1;">{{ form.hub_public_host || '自动跟随 Host 请求头' }} : {{ form.hub_external_port || '自动端口' }}</b></div>
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div class="wizard-footer">
        <button v-if="step > 1" type="button" @click="step -= 1" class="btn-gray-test">◀ 上一步</button>
        <div style="flex:1;"></div>
        <button v-if="step < 4" type="button" @click="nextStep" class="btn-primary-gradient">下一步 ▶</button>
        <button v-else type="button" @click="submitSetup" :disabled="submitting" class="btn-primary-gradient" style="background:linear-gradient(135deg,#059669,#0284c7);">
          {{ submitting ? '正在初始化引擎...' : '🚀 完成安装并进入控制台' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wizard-card-navy {
  width: 680px;
  max-width: 96vw;
  background-color: #0b132b;
  border: 1px solid #1e3a8a;
  border-radius: 14px;
  padding: 26px 30px;
  box-shadow: 0 25px 60px rgba(0, 0, 0, 0.78);
}
.wizard-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 14px;
  border-bottom: 1px solid #172554;
}
.wizard-step-tag {
  background: #0f1f42;
  border: 1px solid #1d4ed8;
  color: #38bdf8;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 6px;
  font-weight: bold;
}
.wizard-stepper {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin: 16px 0 20px;
}
.step-item {
  background: #09122a;
  border: 1px solid #172554;
  color: #64748b;
  font-size: 11px;
  text-align: center;
  padding: 6px 4px;
  border-radius: 6px;
}
.step-active {
  border-color: #00f0ff;
  color: #00f0ff;
  font-weight: bold;
  background: #0f1f42;
}
.step-done {
  border-color: #059669;
  color: #34d399;
}
.wizard-body {
  min-height: 230px;
}
.wizard-title {
  font-size: 15px;
  font-weight: bold;
  color: #fff;
  margin-bottom: 6px;
}
.wizard-sub {
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.5;
  margin-bottom: 16px;
}
.wizard-subpanel {
  background: #09122a;
  border: 1px solid #172554;
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wizard-test-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.wizard-summary-box {
  background: #060b17;
  border: 1px solid #172554;
  border-radius: 8px;
  padding: 14px;
  font-size: 12px;
  color: #cbd5e1;
  line-height: 1.9;
}
.wizard-footer {
  display: flex;
  align-items: center;
  padding-top: 16px;
  margin-top: 18px;
  border-top: 1px solid #172554;
}
</style>
