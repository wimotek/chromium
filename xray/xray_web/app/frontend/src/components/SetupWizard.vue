<template>
  <div class="setup-shell">
    <div class="cyber-card setup-card">
      <div class="setup-header">
        <div class="setup-badge">FIRST-RUN BOOTSTRAP WIZARD</div>
        <h2>⚡ Xray Hub 首次运行安装向导</h2>
        <p class="card-desc">
          欢迎使用分布式节点管理中枢。请完成存储引擎、缓存策略、对外入口与管理员凭据初始化配置（配置将持久化至
          <code>/data/hub_config.json</code> 并自动锁定向导接口）。
        </p>
      </div>

      <!-- 步骤指示器 -->
      <div class="step-nav">
        <button
          v-for="s in steps"
          :key="s.id"
          type="button"
          class="step-pill"
          :class="{ active: step === s.id, done: step > s.id }"
          @click="goStep(s.id)"
        >
          <span class="step-num">{{ step > s.id ? '✓' : s.id }}</span>
          <span>{{ s.title }}</span>
        </button>
      </div>

      <!-- ==================== Step 1: 数据库与缓存引擎 ==================== -->
      <div v-if="step === 1" class="step-pane">
        <div class="panel-card">
          <div class="panel-card-header">
            <div class="panel-title-wrap">
              <span class="panel-icon">🗄️</span>
              <div>
                <strong class="panel-title">1. 选择数据库后端 (SQLAlchemy 2.0 统一驱动)</strong>
                <div class="panel-sub">单机轻量推荐使用 SQLite (WAL)；高并发或外置托管数据库推荐使用 MySQL</div>
              </div>
            </div>
          </div>

          <div class="engine-grid">
            <label class="engine-card" :class="{ selected: form.db_type === 'sqlite' }">
              <input type="radio" value="sqlite" v-model="form.db_type" />
              <div class="engine-title">📦 SQLite 3 (WAL 零配置)</div>
              <div class="engine-desc">数据存储于持久化卷单文件，零外部依赖，支持联机热备份 (.db)。</div>
            </label>
            <label class="engine-card" :class="{ selected: form.db_type === 'mysql' }">
              <input type="radio" value="mysql" v-model="form.db_type" />
              <div class="engine-title">🐬 MySQL / MariaDB (InnoDB)</div>
              <div class="engine-desc">适合高并发多节点集群与外置云数据库，支持 utf8mb4 与事务级快照 (.json)。</div>
            </label>
          </div>

          <div v-if="form.db_type === 'sqlite'" class="form-item" style="margin-top: 14px;">
            <label>SQLite 数据库文件路径</label>
            <input v-model="form.db_path" type="text" class="cyber-input full-w font-mono" placeholder="/data/xray_web.db" />
          </div>

          <div v-else class="mysql-fields">
            <div class="form-row-2">
              <div class="form-item">
                <label>MySQL 主机地址</label>
                <input v-model="form.mysql_host" type="text" class="cyber-input full-w font-mono" placeholder="127.0.0.1" />
              </div>
              <div class="form-item">
                <label>端口</label>
                <input v-model.number="form.mysql_port" type="number" class="cyber-input full-w font-mono" placeholder="3306" />
              </div>
            </div>
            <div class="form-row-2">
              <div class="form-item">
                <label>数据库用户名</label>
                <input v-model="form.mysql_user" type="text" class="cyber-input full-w font-mono" placeholder="xray_web" />
              </div>
              <div class="form-item">
                <label>数据库密码</label>
                <input v-model="form.mysql_password" type="password" class="cyber-input full-w font-mono" placeholder="输入 MySQL 密码" />
              </div>
            </div>
            <div class="form-item">
              <label>数据库名称（需预先 CREATE DATABASE utf8mb4）</label>
              <input v-model="form.mysql_database" type="text" class="cyber-input full-w font-mono" placeholder="xray_web" />
            </div>
          </div>

          <div class="test-bar">
            <button type="button" class="btn-cyber-action" :disabled="testingDb" @click="testDbConnection">
              {{ testingDb ? '正在探测数据库...' : '🔌 测试数据库连接' }}
            </button>
            <span v-if="dbTestResult.text" class="test-status" :class="dbTestResult.ok ? 'ok' : 'err'">
              {{ dbTestResult.ok ? '🟢' : '🔴' }} {{ dbTestResult.text }}
            </span>
          </div>
        </div>

        <div class="panel-card" style="margin-top: 16px;">
          <div class="panel-card-header">
            <div class="panel-title-wrap">
              <span class="panel-icon">⚡</span>
              <div>
                <strong class="panel-title">2. 可选 Redis 缓存加速（含 SQL Cache 自动回退）</strong>
                <div class="panel-sub">关闭 Redis 或 Redis 异常时，系统自动无感回退至数据库 kv_cache 共享表</div>
              </div>
            </div>
            <label class="radio-label" style="margin: 0;">
              <input type="checkbox" v-model="form.redis_enabled" />
              <span :style="{ color: form.redis_enabled ? '#38bdf8' : '#94a3b8' }">
                {{ form.redis_enabled ? '已开启 Redis 加速' : '仅使用 SQL Cache' }}
              </span>
            </label>
          </div>

          <div v-if="form.redis_enabled">
            <div class="form-row-2">
              <div class="form-item">
                <label>Redis 主机地址</label>
                <input v-model="form.redis_host" type="text" class="cyber-input full-w font-mono" placeholder="127.0.0.1" />
              </div>
              <div class="form-item">
                <label>端口</label>
                <input v-model.number="form.redis_port" type="number" class="cyber-input full-w font-mono" placeholder="6379" />
              </div>
            </div>
            <div class="form-row-2">
              <div class="form-item">
                <label>Redis 密码（无密码留空）</label>
                <input v-model="form.redis_password" type="password" class="cyber-input full-w font-mono" placeholder="可选" />
              </div>
              <div class="form-item">
                <label>库索引 (DB)</label>
                <input v-model.number="form.redis_db" type="number" min="0" max="15" class="cyber-input full-w font-mono" placeholder="0" />
              </div>
            </div>
            <div class="test-bar">
              <button type="button" class="btn-cyber-action" :disabled="testingRedis" @click="testRedisConnection">
                {{ testingRedis ? '正在 PING...' : '⚡ 测试 Redis 连通性' }}
              </button>
              <span v-if="redisTestResult.text" class="test-status" :class="redisTestResult.ok ? 'ok' : 'err'">
                {{ redisTestResult.ok ? '🟢' : '🔴' }} {{ redisTestResult.text }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- ==================== Step 2: Hub 入口与运行模式 ==================== -->
      <div v-else-if="step === 2" class="step-pane">
        <div class="panel-card">
          <div class="panel-card-header">
            <div class="panel-title-wrap">
              <span class="panel-icon">🌐</span>
              <div>
                <strong class="panel-title">Hub 访问入口与运营模式设置</strong>
                <div class="panel-sub">容器内部监听端口为 {{ detected.web_port || 8443 }}；若经由 -p 3000:8443 映射或反代，建议核对对外入口</div>
              </div>
            </div>
          </div>

          <div class="form-item">
            <label>面板运行模式 (APP_MODE)</label>
            <select v-model="form.app_mode" class="cyber-input full-w">
              <option value="all">全功能模式 (all) — 同时开放管理员与用户注册/订阅端</option>
              <option value="admin">纯管理模式 (admin) — 仅管理员登录入口（不开放用户自注册）</option>
              <option value="user">纯用户模式 (user) — 面向终端用户的自助订阅面板</option>
            </select>
          </div>

          <div class="form-item">
            <label>对外访问完整 URL (PUBLIC_URL，留空则自动根据浏览器访问头识别)</label>
            <div class="code-send-group">
              <input
                v-model="form.public_url"
                type="text"
                class="cyber-input full-w font-mono"
                :placeholder="`留空自动识别（当前探测: ${detected.detected_public_url || 'https://你的域名:8443'}）`"
              />
              <button
                v-if="detected.detected_public_url"
                type="button"
                class="btn-cyber-code"
                @click="form.public_url = detected.detected_public_url"
              >
                填入当前访问地址
              </button>
            </div>
            <span class="input-hint">
              用于生成边缘节点接入命令 (PANEL_URL)、全节点订阅地址 (/api/sub) 及 WSS 反穿客户端域名端口。
            </span>
          </div>

          <div class="form-item">
            <label>显式对外映射端口 (PUBLIC_PORT，留空或 0 表示自动识别)</label>
            <input
              v-model="form.public_port"
              type="number"
              min="0"
              max="65535"
              class="cyber-input full-w font-mono"
              :placeholder="`当前请求端口: ${detected.detected_public_port || 8443}`"
            />
            <span class="input-hint">
              使用 Docker 端口映射（如 <code>-p 3000:8443</code>）且上游未透传 Host 端口时可在此指定 <code>3000</code>。
            </span>
          </div>
        </div>
      </div>

      <!-- ==================== Step 3: 管理员账号与集群安全 ==================== -->
      <div v-else class="step-pane">
        <div class="panel-card">
          <div class="panel-card-header">
            <div class="panel-title-wrap">
              <span class="panel-icon">🔐</span>
              <div>
                <strong class="panel-title">管理员初始凭据与集群零信任准入</strong>
                <div class="panel-sub">请妥善保管管理员密码与集群引导令牌 (Cluster Token)</div>
              </div>
            </div>
          </div>

          <div class="form-row-2">
            <div class="form-item">
              <label>管理员用户名</label>
              <input v-model="form.admin_username" type="text" class="cyber-input full-w" placeholder="admin" />
            </div>
            <div class="form-item">
              <label>管理员通知邮箱</label>
              <input v-model="form.admin_email" type="email" class="cyber-input full-w" placeholder="admin@example.com" />
            </div>
          </div>

          <div class="form-row-2">
            <div class="form-item">
              <label>管理员登录密码（至少 6 位）</label>
              <input v-model="form.admin_password" type="password" class="cyber-input full-w" placeholder="请设置高强度管理员密码" />
            </div>
            <div class="form-item">
              <label>确认管理员密码</label>
              <input v-model="adminPasswordConfirm" type="password" class="cyber-input full-w" placeholder="再次输入管理员密码" />
            </div>
          </div>

          <div class="form-item">
            <label>集群引导令牌 (cluster_token，供新节点首次握手鉴权)</label>
            <div class="code-send-group">
              <input v-model="form.cluster_token" type="text" class="cyber-input full-w font-mono" />
              <button type="button" class="btn-cyber-code" @click="regenerateClusterToken">🎲 重新生成</button>
            </div>
          </div>

          <div class="switch-row">
            <label class="radio-label">
              <input type="checkbox" v-model="form.tofu_enabled" />
              <span>🛡️ 开启 TOFU 首次信任（允许未知新节点通过 Cluster Token 注册）</span>
            </label>
            <label class="radio-label">
              <input type="checkbox" v-model="form.node_auto_approve" />
              <span>⚡ 免审自动准入（新节点握手通过后直接上线，关闭则进入待审批隔离区）</span>
            </label>
          </div>

          <div class="form-item" style="margin-top: 12px;">
            <label>初始前台公告（可选，留空不展示）</label>
            <textarea
              v-model="form.system_notice"
              rows="2"
              class="cyber-input cyber-textarea full-w"
              placeholder="例如：欢迎使用 Xray Reality 节点中心..."
            ></textarea>
          </div>
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div class="wizard-footer">
        <button v-if="step > 1" type="button" class="btn-cyber-action" :disabled="submitting" @click="step--">
          ← 上一步
        </button>
        <div v-else></div>

        <div class="footer-right">
          <button v-if="step < 3" type="button" class="btn-cyber-primary" @click="nextStep">
            下一步 →
          </button>
          <button v-else type="button" class="btn-cyber-success" :disabled="submitting" @click="submitSetup">
            {{ submitting ? '正在初始化数据库与配置...' : '🚀 完成初始化并进入面板' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

const emit = defineEmits(['completed'])

const step = ref(1)
const steps = [
  { id: 1, title: '1. 数据库与缓存' },
  { id: 2, title: '2. 入口与模式' },
  { id: 3, title: '3. 管理员与安全' }
]

const detected = reactive({
  web_port: 8443,
  detected_public_url: '',
  detected_public_port: 8443
})

const form = reactive({
  db_type: 'sqlite',
  db_path: '/data/xray_web.db',
  mysql_host: '127.0.0.1',
  mysql_port: 3306,
  mysql_user: 'xray_web',
  mysql_password: '',
  mysql_database: 'xray_web',
  redis_enabled: false,
  redis_host: '127.0.0.1',
  redis_port: 6379,
  redis_password: '',
  redis_db: 0,
  app_mode: 'all',
  public_url: '',
  public_port: '',
  admin_username: 'admin',
  admin_email: 'admin@system.local',
  admin_password: '',
  cluster_token: '',
  tofu_enabled: true,
  node_auto_approve: true,
  system_notice: ''
})

const adminPasswordConfirm = ref('')
const testingDb = ref(false)
const testingRedis = ref(false)
const submitting = ref(false)
const dbTestResult = reactive({ ok: false, text: '' })
const redisTestResult = reactive({ ok: false, text: '' })

onMounted(async () => {
  try {
    const res = await axios.get('/api/setup/status')
    if (res.data.code === 200) {
      if (!res.data.setup_required) {
        emit('completed')
        return
      }
      const d = res.data.defaults || {}
      form.db_type = d.db_type || 'sqlite'
      form.db_path = d.db_path || '/data/xray_web.db'
      form.mysql_host = d.mysql_host || '127.0.0.1'
      form.mysql_port = Number(d.mysql_port) || 3306
      form.mysql_user = d.mysql_user || 'xray_web'
      form.mysql_database = d.mysql_database || 'xray_web'
      form.redis_enabled = Boolean(d.redis_enabled)
      form.redis_host = d.redis_host || '127.0.0.1'
      form.redis_port = Number(d.redis_port) || 6379
      form.redis_db = Number(d.redis_db) || 0
      form.app_mode = d.app_mode || 'all'
      form.public_url = d.public_url || ''
      form.public_port = d.public_port ? String(d.public_port) : ''
      form.admin_username = d.admin_username || 'admin'
      form.admin_email = d.admin_email || 'admin@system.local'
      form.cluster_token = d.cluster_token || ''
      form.tofu_enabled = d.tofu_enabled !== false
      form.node_auto_approve = d.node_auto_approve !== false

      detected.web_port = d.web_port || 8443
      detected.detected_public_url = d.detected_public_url || ''
      detected.detected_public_port = d.detected_public_port || 8443
    }
  } catch (_) {}
})

const regenerateClusterToken = () => {
  const bytes = new Uint8Array(16)
  window.crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  form.cluster_token = `ctk_${hex}`
}

const testDbConnection = async () => {
  testingDb.value = true
  dbTestResult.text = ''
  try {
    const res = await axios.post('/api/setup/test_db', {
      db_type: form.db_type,
      db_path: form.db_path,
      mysql_host: form.mysql_host,
      mysql_port: form.mysql_port,
      mysql_user: form.mysql_user,
      mysql_password: form.mysql_password,
      mysql_database: form.mysql_database
    })
    dbTestResult.ok = res.data.code === 200
    dbTestResult.text = res.data.msg
    if (dbTestResult.ok) ElMessage.success(res.data.msg)
    else ElMessage.error(res.data.msg)
  } catch (err) {
    dbTestResult.ok = false
    dbTestResult.text = err?.response?.data?.msg || '数据库连接测试请求失败'
    ElMessage.error(dbTestResult.text)
  } finally {
    testingDb.value = false
  }
}

const testRedisConnection = async () => {
  testingRedis.value = true
  redisTestResult.text = ''
  try {
    const res = await axios.post('/api/setup/test_redis', {
      redis_host: form.redis_host,
      redis_port: form.redis_port,
      redis_password: form.redis_password,
      redis_db: form.redis_db
    })
    redisTestResult.ok = res.data.code === 200
    redisTestResult.text = res.data.msg
    if (redisTestResult.ok) ElMessage.success(res.data.msg)
    else ElMessage.error(res.data.msg)
  } catch (err) {
    redisTestResult.ok = false
    redisTestResult.text = err?.response?.data?.msg || 'Redis 连接测试请求失败'
    ElMessage.error(redisTestResult.text)
  } finally {
    testingRedis.value = false
  }
}

const goStep = (targetStep) => {
  if (targetStep <= step.value) {
    step.value = targetStep
  }
}

const nextStep = () => {
  if (step.value === 1 && form.db_type === 'mysql') {
    if (!form.mysql_host.trim() || !form.mysql_user.trim() || !form.mysql_database.trim()) {
      ElMessage.warning('请填写完整的 MySQL 连接信息（主机、用户名、数据库名）')
      return
    }
  }
  step.value += 1
}

const submitSetup = async () => {
  if (form.admin_username.trim().length < 2) {
    return ElMessage.warning('管理员用户名至少 2 位字符')
  }
  if (!form.admin_email.includes('@')) {
    return ElMessage.warning('请输入合法的管理员邮箱')
  }
  if (form.admin_password.length < 6) {
    return ElMessage.warning('管理员密码至少需要 6 位字符')
  }
  if (form.admin_password !== adminPasswordConfirm.value) {
    return ElMessage.warning('两次输入的管理员密码不一致')
  }

  submitting.value = true
  try {
    const res = await axios.post('/api/setup/complete', {
      ...form,
      public_port: Number(form.public_port || 0)
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg || 'Hub 初始化完成！')
      emit('completed', res.data.data || {})
    } else {
      ElMessage.error(res.data.msg || '初始化失败')
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.msg || '初始化提交失败，请检查配置')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.setup-shell {
  max-width: 780px;
  margin: 24px auto;
}

.setup-card {
  padding: 28px;
}

.setup-header {
  margin-bottom: 20px;
}

.setup-header h2 {
  margin: 8px 0 6px 0;
  font-size: 20px;
  color: #f8fafc;
}

.setup-badge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.8px;
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.35);
}

.step-nav {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 20px;
}

.step-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 8px;
  background: #0b1120;
  border: 1px solid #1e293b;
  color: #64748b;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.step-pill.active {
  border-color: #38bdf8;
  color: #f8fafc;
  background: rgba(14, 165, 233, 0.12);
}

.step-pill.done {
  border-color: rgba(16, 185, 129, 0.45);
  color: #34d399;
}

.step-num {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  background: rgba(148, 163, 184, 0.15);
}

.step-pill.active .step-num {
  background: #0284c7;
  color: #ffffff;
}

.step-pill.done .step-num {
  background: rgba(16, 185, 129, 0.25);
  color: #34d399;
}

.engine-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.engine-card {
  display: block;
  padding: 14px;
  border-radius: 8px;
  border: 1px solid #1e293b;
  background: #0f172a;
  cursor: pointer;
  transition: all 0.2s;
}

.engine-card input[type='radio'] {
  display: none;
}

.engine-card.selected {
  border-color: #38bdf8;
  background: rgba(14, 165, 233, 0.12);
  box-shadow: 0 0 14px rgba(56, 189, 248, 0.18);
}

.engine-title {
  font-size: 14px;
  font-weight: 700;
  color: #f8fafc;
  margin-bottom: 4px;
}

.engine-desc {
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.5;
}

.mysql-fields {
  margin-top: 14px;
}

.full-w {
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100% !important;
}

.test-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.test-status {
  font-size: 12px;
  font-weight: 600;
}

.test-status.ok {
  color: #34d399;
}

.test-status.err {
  color: #f87171;
}

.switch-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 8px 0 4px 0;
}

.wizard-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid #1e293b;
}

.footer-right {
  display: flex;
  gap: 10px;
}

@media (max-width: 640px) {
  .step-nav,
  .engine-grid {
    grid-template-columns: 1fr;
  }
}
</style>
