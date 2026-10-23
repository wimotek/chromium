<template>
  <div class="dark-theme">
    <!-- 顶部科技导航 -->
    <header class="cyber-header">
      <div class="header-content">
        <div class="brand">
          <span class="pulse-icon">⚡</span>
          <span class="brand-title">XRAY <span class="highlight">REALITY</span></span>
        </div>
        <div v-if="currentUser.username" class="user-status">
          <span class="role-badge" :class="currentUser.role">{{ currentUser.role === 'admin' ? 'SYSTEM ADMIN' : 'USER CLIENT' }}</span>
          <span class="user-id">{{ currentUser.username }}</span>
          <button class="btn-logout" @click="logout">退出</button>
        </div>
      </div>
    </header>

    <main class="main-body">
      <!-- 1. 登录 / 注册 / 找回密码 模块 -->
      <div v-if="!currentUser.username" class="auth-center">
        <div class="cyber-card auth-box">
          <h2 class="card-title">{{ authCardTitle }}</h2>

          <!-- A. 登录表单 -->
          <template v-if="authMode === 'login'">
            <div class="form-item">
              <label>ACCOUNT / 用户名 或 注册邮箱</label>
              <input v-model="authForm.username" type="text" class="cyber-input" placeholder="输入用户名或邮箱地址" />
            </div>
            <div class="form-item">
              <label>ACCESS KEY / 登录密码</label>
              <input v-model="authForm.password" type="password" class="cyber-input" placeholder="请输入密码" />
            </div>
            <button class="btn-cyber-primary" :disabled="loading" @click="handleAuth">
              {{ loading ? 'AUTHENTICATING...' : '登录系统' }}
            </button>
            <div v-if="!isPureAdmin" class="auth-nav-links">
              <a href="javascript:;" @click="authMode = 'register'">没有账号？邮箱注册</a>
              <a href="javascript:;" class="text-warning" @click="authMode = 'forgot'">忘记密码？</a>
            </div>
          </template>

          <!-- B. 注册表单 -->
          <template v-else-if="authMode === 'register'">
            <div class="form-item">
              <label>USER IDENTIFIER / 设置用户名</label>
              <input v-model="authForm.username" type="text" class="cyber-input" placeholder="字母/数字用户名" />
            </div>
            <div class="form-item">
              <label>EMAIL / 接收激活码邮箱</label>
              <input v-model="authForm.email" type="email" class="cyber-input" placeholder="name@example.com" />
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
              <input v-model="authForm.password" type="password" class="cyber-input" placeholder="至少 6 位密码" />
            </div>
            <button class="btn-cyber-primary" :disabled="loading" @click="handleAuth">
              {{ loading ? 'AUTHENTICATING...' : '验证并激活账号' }}
            </button>
            <div class="auth-nav-links">
              <a href="javascript:;" @click="authMode = 'login'">已有账号？返回登录</a>
            </div>
          </template>

          <!-- C. 忘记密码表单 -->
          <template v-else-if="authMode === 'forgot'">
            <div class="form-item">
              <label>REGISTERED EMAIL / 绑定的注册邮箱</label>
              <input v-model="forgotForm.email" type="email" class="cyber-input" placeholder="输入绑定的邮箱" />
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
              <input v-model="forgotForm.new_password" type="password" class="cyber-input" placeholder="输入新密码 (至少6位)" />
            </div>
            <button class="btn-cyber-primary" :disabled="loading" @click="submitForgotPassword">
              {{ loading ? 'PROCESSING...' : '确认重置密码' }}
            </button>
            <div class="auth-nav-links">
              <a href="javascript:;" @click="authMode = 'login'">想起密码？返回登录</a>
            </div>
          </template>
        </div>
      </div>

      <!-- 2. 普通用户端仪表盘 -->
      <div v-else-if="currentUser.role === 'user'" class="dashboard-grid">
        <div class="cyber-card">
          <div class="card-header">
            <h3>📊 流量监控与配额</h3>
            <span class="tag-status">ONLINE</span>
          </div>
          <div class="traffic-meter">
            <div class="meter-info">
              <div>
                <span class="data-val">{{ currentUser.used_mb }}</span>
                <span class="data-unit">MB (已用)</span>
              </div>
              <div class="text-right">
                <span class="data-val">{{ currentUser.limit_mb }}</span>
                <span class="data-unit">MB (总额)</span>
              </div>
            </div>
            <div class="progress-track">
              <div class="progress-glow" :style="{ width: trafficPercent + '%' }"></div>
            </div>
            <div class="expiry-notice">
              <span>套餐有效期至：</span>
              <strong class="highlight-date">{{ currentUser.expire_date }}</strong>
            </div>
          </div>
        </div>

        <div class="cyber-card">
          <div class="card-header">
            <h3>🎟️ 卡密充值续费</h3>
          </div>
          <p class="card-desc">输入发卡平台兑换码，即时扩展流量与天数：</p>
          <div class="redeem-box">
            <input v-model="rechargeCode" type="text" class="cyber-input" placeholder="KM-XXXX-XXXX" />
            <button class="btn-cyber-success" :disabled="loading" @click="handleRecharge">立即激活</button>
          </div>
        </div>

        <div class="cyber-card col-span-2">
          <div class="card-header">
            <h3>🔗 REALITY 节点订阅凭据</h3>
          </div>
          <div class="node-field">
            <label>REALITY PUBLIC KEY (公钥):</label>
            <div class="code-display text-green">{{ currentUser.public_key || '正在提取公钥...' }}</div>
          </div>
          <div class="node-field">
            <label>VLESS REALITY 订阅配置链接:</label>
            <div class="code-display text-cyan">{{ currentUser.sub_link }}</div>
          </div>
          <div class="btn-group">
            <button class="btn-cyber-primary" @click="copyText(currentUser.sub_link)">📋 一键复制节点</button>
            <button class="btn-cyber-action" @click="openQrModal(currentUser.sub_link, currentUser.username)">📱 弹出二维码扫码</button>
          </div>
        </div>

        <div class="cyber-card col-span-2">
          <div class="card-header">
            <h3>🔔 告警通知偏好与安全中心</h3>
          </div>
          <div class="settings-grid">
            <div class="settings-section">
              <h4>1. 到期与流量微信/邮件通知设置</h4>
              <div class="form-item">
                <label>首选通知通道 (默认邮件)</label>
                <div class="radio-group">
                  <label class="radio-label">
                    <input type="radio" value="email" v-model="notifyForm.notify_type" /> 📧 电子邮箱通知 ({{ currentUser.email }})
                  </label>
                  <label class="radio-label">
                    <input type="radio" value="serverchan" v-model="notifyForm.notify_type" /> 📲 Server酱 (微信服务号即时推送)
                  </label>
                </div>
              </div>

              <div class="form-item" v-if="notifyForm.notify_type === 'serverchan'">
                <label>Server酱 SendKey：</label>
                <input v-model="notifyForm.serverchan_key" type="text" class="cyber-input" placeholder="SCTxxxxxxxxxx" />
                <div class="input-hint">
                  💡 未申请过？点击前往 <a href="https://sct.ftqq.com/" target="_blank" class="cyber-link">Server酱·Turbo版官网 (https://sct.ftqq.com/)</a> 微信扫码一键获取 SendKey。
                </div>
              </div>

              <div class="btn-group">
                <button class="btn-cyber-success" @click="saveNotifySettings">保存通知设置</button>
                <button class="btn-cyber-action" @click="testUserNotify">发送测试通知</button>
              </div>
            </div>

            <div class="settings-section">
              <h4>2. 修改账户登录密码</h4>
              <div class="form-item">
                <label>当前原密码</label>
                <input v-model="pwdForm.old_pwd" type="password" class="cyber-input" placeholder="输入当前原密码" />
              </div>
              <div class="form-item">
                <label>新密码 (至少6位)</label>
                <input v-model="pwdForm.new_pwd" type="password" class="cyber-input" placeholder="输入新密码" />
              </div>
              <div class="form-item">
                <label>确认新密码</label>
                <input v-model="pwdForm.confirm_pwd" type="password" class="cyber-input" placeholder="再次输入新密码" />
              </div>
              <button class="btn-cyber-primary" @click="submitChangePassword">确认变更密码</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 3. 管理员控制台 -->
      <div v-else-if="currentUser.role === 'admin'" class="admin-wrapper">
        <div class="card-tabs-nav">
          <button class="tab-card-btn" :class="{ active: activeTab === 'users' }" @click="activeTab = 'users'">
            <span class="tab-icon">👥</span>
            <div class="tab-text">
              <div class="tab-title">全站用户生命周期管理</div>
              <div class="tab-sub">配额/时效治理、凭证封禁、二维码与密码重置</div>
            </div>
            <span class="count-tag">{{ adminUsers.length }} 位用户</span>
          </button>

          <button class="tab-card-btn" :class="{ active: activeTab === 'cards' }" @click="activeTab = 'cards'">
            <span class="tab-icon">🎟️</span>
            <div class="tab-text">
              <div class="tab-title">卡密生成与发卡中心</div>
              <div class="tab-sub">批量制卡、库存监管、卡密一键导出核销</div>
            </div>
            <span class="count-tag">{{ adminCards.length }} 张卡密</span>
          </button>

          <button class="tab-card-btn" :class="{ active: activeTab === 'settings' }" @click="openSettingsTab">
            <span class="tab-icon">⚙️</span>
            <div class="tab-text">
              <div class="tab-title">系统与发信参数设置</div>
              <div class="tab-sub">SMTP 邮件服务器配置、发信连接测试</div>
            </div>
            <span class="count-tag">配置</span>
          </button>
        </div>

        <!-- 选项卡 1: 用户管理 -->
        <div v-if="activeTab === 'users'" class="cyber-card tab-content-card">
          <div class="card-header">
            <h3>👥 接入用户治理列表</h3>
            <button class="btn-cyber-refresh" @click="loadAdminData">🔄 刷新数据</button>
          </div>
          <div class="table-container">
            <table class="cyber-table">
              <thead>
                <tr>
                  <th>用户 / 绑定邮箱</th>
                  <th>状态</th>
                  <th>流量配额</th>
                  <th>到期时间</th>
                  <th>通知</th>
                  <th>专属凭证</th>
                  <th style="width: 320px;">治理操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="u in adminUsers" :key="u.username">
                  <td>
                    <b>{{ u.username }}</b>
                    <div style="font-size: 11px; color: #64748b;">{{ u.email }}</div>
                  </td>
                  <td>
                    <span class="badge" :class="u.status === 1 ? 'badge-ready' : 'badge-used'">
                      {{ u.status === 1 ? '🟢 活跃' : '🔴 封禁' }}
                    </span>
                  </td>
                  <td>
                    <div>{{ u.used_mb }} / {{ u.traffic_limit_mb }} MB</div>
                    <div class="table-progress"><div class="table-glow" :style="{ width: calcProgress(u.used_mb, u.traffic_limit_mb) + '%' }"></div></div>
                  </td>
                  <td>{{ u.expire_date }}</td>
                  <td><span class="role-badge user">{{ u.notify_type }}</span></td>
                  <td>
                    <button class="btn-sm btn-action" @click="openQrModal(u.sub_link, u.username)">📱 凭证/二维码</button>
                  </td>
                  <td>
                    <div class="action-btn-row">
                      <button class="btn-sm btn-reset" @click="openResetPwdModal(u.username)">🔑 重置密码</button>
                      <button class="btn-sm btn-edit" @click="openEditModal(u)">✏️ 改配额</button>
                      <button v-if="u.status === 1" class="btn-sm btn-demote" :disabled="u.username === currentUser.username" @click="handleStatusToggle(u.username, 0)">🛑 封禁</button>
                      <button v-else class="btn-sm btn-promote" @click="handleStatusToggle(u.username, 1)">🟢 解封</button>
                      <button v-if="u.role === 'user'" class="btn-sm btn-promote" @click="handleRoleChange(u.username, 'admin')">⚡ 提权</button>
                      <button v-else-if="u.username !== currentUser.username" class="btn-sm btn-demote" @click="handleRoleChange(u.username, 'user')">降权</button>
                      <button class="btn-sm btn-del" :disabled="u.username === currentUser.username" @click="handleDeleteUser(u.username)">🗑️</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 选项卡 2: 卡密管理 -->
        <div v-else-if="activeTab === 'cards'" class="cyber-card tab-content-card">
          <div class="card-header">
            <h3>🛠️ 商业发卡制卡面板</h3>
          </div>
          <div class="gen-form">
            <div>
              <label>流量配额 (GB)</label>
              <input v-model.number="cardGenForm.traffic_gb" type="number" class="cyber-input" />
            </div>
            <div>
              <label>有效时限 (天)</label>
              <input v-model.number="cardGenForm.days" type="number" class="cyber-input" />
            </div>
            <div>
              <label>批量制卡数 (张)</label>
              <input v-model.number="cardGenForm.count" type="number" class="cyber-input" />
            </div>
            <button class="btn-cyber-success" @click="generateCards">立即批量制卡</button>
          </div>

          <div class="card-header" style="margin-top: 30px;">
            <h3>📦 历史卡密库存与核销流水 (最新100条)</h3>
            <button class="btn-cyber-refresh" @click="loadAdminData">🔄 刷新卡密</button>
          </div>
          <div class="table-container">
            <table class="cyber-table">
              <thead>
                <tr><th>兑换卡密编号</th><th>套餐配额</th><th>核销状态</th><th>兑换用户</th><th>操作</th></tr>
              </thead>
              <tbody>
                <tr v-for="c in adminCards" :key="c.code">
                  <td class="font-mono text-cyan">{{ c.code }}</td>
                  <td>{{ c.traffic_gb }} GB / {{ c.days }} 天</td>
                  <td>
                    <span class="badge" :class="c.is_used ? 'badge-used' : 'badge-ready'">
                      {{ c.is_used ? '已核销' : '待售出/有效' }}
                    </span>
                  </td>
                  <td>{{ c.used_by || '-' }}</td>
                  <td><button class="btn-sm btn-action" @click="copyText(c.code)">一键复制</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 选项卡 3: 系统与 SMTP 邮件设置 -->
        <div v-else-if="activeTab === 'settings'" class="cyber-card tab-content-card">
          <div class="card-header">
            <h3>⚙️ SMTP 发信服务器参数配置 (用于用户激活与到期提醒)</h3>
          </div>
          <div class="settings-grid">
            <div class="settings-section">
              <div class="form-item">
                <label>SMTP 服务器地址</label>
                <input v-model="smtpForm.smtp_host" type="text" class="cyber-input" placeholder="例如: smtp.qq.com / smtp.163.com" />
              </div>
              <div class="form-item">
                <label>端口 (SSL 常用 465, STARTTLS 常用 587)</label>
                <input v-model="smtpForm.smtp_port" type="text" class="cyber-input" placeholder="465" />
              </div>
              <div class="form-item">
                <label>发信邮箱账号 (User)</label>
                <input v-model="smtpForm.smtp_user" type="text" class="cyber-input" placeholder="service@example.com" />
              </div>
              <div class="form-item">
                <label>邮箱授权码 / 密码 (Password)</label>
                <input v-model="smtpForm.smtp_pass" type="password" class="cyber-input" placeholder="第三方客户端独立授权码" />
              </div>
              <div class="form-item">
                <label>发件人显示名称 (Sender Name)</label>
                <input v-model="smtpForm.smtp_sender" type="text" class="cyber-input" placeholder="Xray 节点中心" />
              </div>
              <div class="form-item">
                <label class="radio-label">
                  <input type="checkbox" v-model="smtpForm.smtp_ssl" /> 启用 SSL 安全加密连接 (推荐 465 端口开启)
                </label>
              </div>
              <button class="btn-cyber-success" @click="saveSmtpSettings">保存邮件服务器参数</button>
            </div>

            <div class="settings-section">
              <h4>📧 发信连通性一键测试</h4>
              <p class="card-desc">输入接收测试邮件的邮箱，验证服务器是否能正常发送：</p>
              <div class="form-item">
                <label>收件人测试邮箱</label>
                <input v-model="testEmailTo" type="email" class="cyber-input" placeholder="test@your-domain.com" />
              </div>
              <button class="btn-cyber-primary" :disabled="testingEmail" @click="sendTestEmail">
                {{ testingEmail ? '正在发信...' : '发送测试邮件' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- 弹窗 1：SVG 高清二维码弹窗 (使用 Computed URL，零行内表达式错误) -->
    <div v-if="showQrModal" class="modal-backdrop" @click="showQrModal = false">
      <div class="cyber-modal" @click.stop>
        <h3>📱 [{{ targetModalUser }}] 节点连接凭证</h3>
        <p class="modal-tip">手机相机或客户端扫码即可导入：</p>
        <div class="qr-box">
          <img :src="qrCodeImgUrl" alt="QR Code" style="width: 220px; height: 220px; display: block;" />
        </div>
        <div class="node-field" style="margin-top: 15px; text-align: left;">
          <div class="code-display text-cyan" style="max-height: 80px; overflow-y: auto;">{{ targetModalLink }}</div>
        </div>
        <div class="btn-group" style="justify-content: center;">
          <button class="btn-cyber-primary" @click="copyText(targetModalLink)">复制链接</button>
          <button class="btn-cyber-action" @click="showQrModal = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- 弹窗 2：管理员修改用户配额 -->
    <div v-if="showEditModal" class="modal-backdrop" @click="showEditModal = false">
      <div class="cyber-modal" style="max-width: 420px; text-align: left;" @click.stop>
        <h3>✏️ 调整用户 [{{ editForm.username }}] 属性</h3>
        <div class="form-item" style="margin-top: 15px;">
          <label>总流量限制配额 (MB)</label>
          <input v-model.number="editForm.limit_mb" type="number" class="cyber-input" />
          <span style="font-size: 11px; color: #64748b;">换算参考：1GB = 1024MB | 100GB = 102400MB</span>
        </div>
        <div class="form-item">
          <label>套餐到期时限 (格式: YYYY-MM-DD HH:MM:SS)</label>
          <input v-model="editForm.expire_date" type="text" class="cyber-input" />
        </div>
        <div class="btn-group" style="justify-content: flex-end; margin-top: 20px;">
          <button class="btn-cyber-action" @click="showEditModal = false">取消</button>
          <button class="btn-cyber-success" @click="submitUserEdit">保存修改</button>
        </div>
      </div>
    </div>

    <!-- 弹窗 3：管理员重置用户密码 -->
    <div v-if="showResetPwdModal" class="modal-backdrop" @click="showResetPwdModal = false">
      <div class="cyber-modal" style="max-width: 380px; text-align: left;" @click.stop>
        <h3>🔑 重置用户 [{{ resetTargetUser }}] 密码</h3>
        <div class="form-item" style="margin-top: 15px;">
          <label>为该用户设置的新密码</label>
          <input v-model="resetNewPassword" type="text" class="cyber-input" placeholder="输入新密码" />
          <span style="font-size: 11px; color: #64748b;">重置后系统会自动向其邮箱/微信推送新密码通知</span>
        </div>
        <div class="btn-group" style="justify-content: flex-end; margin-top: 20px;">
          <button class="btn-cyber-action" @click="showResetPwdModal = false">取消</button>
          <button class="btn-cyber-primary" @click="submitResetPassword">确认重置</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

const loading = ref(false)
const isPureAdmin = ref(false)
const rechargeCode = ref('')
const activeTab = ref('users')

// 认证模式：'login' | 'register' | 'forgot'
const authMode = ref('login')

// 验证码倒计时
const countdown = ref(0)
const sendingCode = ref(false)

// 弹窗状态
const showQrModal = ref(false)
const targetModalUser = ref('')
const targetModalLink = ref('')

const showEditModal = ref(false)
const editForm = reactive({ username: '', limit_mb: 1024, expire_date: '' })

const showResetPwdModal = ref(false)
const resetTargetUser = ref('')
const resetNewPassword = ref('')

// 表单定义
const currentUser = reactive({ username: '', email: '', role: '', used_mb: 0, limit_mb: 0, expire_date: '', public_key: '', sub_link: '' })
const authForm = reactive({ username: '', email: '', code: '', password: '' })
const forgotForm = reactive({ email: '', code: '', new_password: '' })
const cardGenForm = reactive({ traffic_gb: 50, days: 30, count: 5 })
const notifyForm = reactive({ notify_type: 'email', serverchan_key: '' })
const pwdForm = reactive({ old_pwd: '', new_pwd: '', confirm_pwd: '' })

// 管理员 SMTP 设置
const smtpForm = reactive({ smtp_host: '', smtp_port: '465', smtp_user: '', smtp_pass: '', smtp_sender: '', smtp_ssl: true })
const testEmailTo = ref('')
const testingEmail = ref(false)

const adminCards = ref([])
const adminUsers = ref([])

onMounted(async () => {
  try {
    const res = await axios.get('/api/system/info')
    if (res.data.data.mode === 'admin') isPureAdmin.value = true
  } catch (_) {}
})

// 标题计算属性（消除模板内深层三元运算符）
const authCardTitle = computed(() => {
  if (isPureAdmin.value) return '管理员认证'
  if (authMode.value === 'login') return '控制台账号接入'
  if (authMode.value === 'register') return '新用户激活注册'
  return '🔐 找回 / 重置密码'
})

// 倒计时按钮文字计算属性
const countdownText = computed(() => {
  if (countdown.value > 0) return countdown.value + 's 后重试'
  if (sendingCode.value) return '发送中...'
  return '获取验证码'
})

// 流量百分比
const trafficPercent = computed(() => {
  if (!currentUser.limit_mb) return 0
  return Math.min(100, Math.round((currentUser.used_mb / currentUser.limit_mb) * 100))
})

// 表格流量计算安全函数（消除模板内 Math.min）
const calcProgress = (used, total) => {
  if (!total) return 0
  return Math.min(100, Math.round((used / total) * 100))
}

// 二维码计算属性（消除模板内 encodeURIComponent 调用）
const qrCodeImgUrl = computed(() => {
  if (!targetModalLink.value) return ''
  return '/api/qrcode?text=' + encodeURIComponent(targetModalLink.value)
})

const startCountdown = () => {
  countdown.value = 60
  const timer = setInterval(() => {
    countdown.value--
    if (countdown.value <= 0) clearInterval(timer)
  }, 1000)
}

const sendRegisterCode = async () => {
  if (!authForm.email || !authForm.email.includes('@')) {
    return ElMessage.warning('请先输入合法的电子邮箱')
  }
  sendingCode.value = true
  try {
    const res = await axios.post('/api/auth/send_register_code', { email: authForm.email })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      startCountdown()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('验证码发送请求失败，请确保后台已配置发信参数')
  } finally {
    sendingCode.value = false
  }
}

const sendForgotCode = async () => {
  if (!forgotForm.email || !forgotForm.email.includes('@')) {
    return ElMessage.warning('请输入绑定的注册电子邮箱')
  }
  sendingCode.value = true
  try {
    const res = await axios.post('/api/auth/send_reset_code', { email: forgotForm.email })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      startCountdown()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('验证码发送请求失败')
  } finally {
    sendingCode.value = false
  }
}

const submitForgotPassword = async () => {
  if (!forgotForm.email || !forgotForm.code || !forgotForm.new_password) {
    return ElMessage.warning('请完整填写邮箱、重置码与新密码')
  }
  if (forgotForm.new_password.length < 6) {
    return ElMessage.warning('新密码长度不能少于 6 位')
  }
  loading.value = true
  try {
    const res = await axios.post('/api/auth/reset_password', forgotForm)
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      authMode.value = 'login'
      authForm.username = forgotForm.email
      authForm.password = ''
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('重置密码提交失败')
  } finally {
    loading.value = false
  }
}

const openQrModal = (link, uname) => {
  if (!link) return ElMessage.warning('链接无效或公钥未初始化')
  targetModalUser.value = uname
  targetModalLink.value = link
  showQrModal.value = true
}

const openEditModal = (u) => {
  editForm.username = u.username
  editForm.limit_mb = u.traffic_limit_mb
  editForm.expire_date = u.expire_date
  showEditModal.value = true
}

const openResetPwdModal = (uname) => {
  resetTargetUser.value = uname
  resetNewPassword.value = ''
  showResetPwdModal.value = true
}

const submitResetPassword = async () => {
  if (!resetNewPassword.value) return ElMessage.warning('请输入新密码')
  try {
    const res = await axios.post('/api/admin/users/reset_password', {
      admin_user: authForm.username,
      admin_pwd: authForm.password,
      target_user: resetTargetUser.value,
      new_password: resetNewPassword.value
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      showResetPwdModal.value = false
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('重置密码操作失败')
  }
}

const submitUserEdit = async () => {
  try {
    const res = await axios.post('/api/admin/users/edit', {
      admin_user: authForm.username,
      admin_pwd: authForm.password,
      target_user: editForm.username,
      limit_mb: editForm.limit_mb,
      expire_date: editForm.expire_date
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      showEditModal.value = false
      loadAdminData()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('修改失败')
  }
}

const handleStatusToggle = async (targetUser, newStatus) => {
  const tip = newStatus === 0 ? '封禁' : '解封'
  if (!confirm(`确定要${tip}用户 [${targetUser}] 吗？`)) return
  try {
    const res = await axios.post('/api/admin/users/status', {
      admin_user: authForm.username,
      admin_pwd: authForm.password,
      target_user: targetUser,
      status: newStatus
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      loadAdminData()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('网络或权限异常')
  }
}

const handleDeleteUser = async (targetUser) => {
  if (!confirm(`⚠️ 警告：确定要彻底删除用户 [${targetUser}] 吗？数据无法恢复！`)) return
  try {
    const res = await axios.post('/api/admin/users/delete', {
      admin_user: authForm.username,
      admin_pwd: authForm.password,
      target_user: targetUser
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      loadAdminData()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('删除操作失败')
  }
}

const handleRoleChange = async (targetUser, newRole) => {
  const actionText = newRole === 'admin' ? '提升为管理员' : '降级为普通用户'
  if (!confirm(`确定要将 [${targetUser}] ${actionText}吗？`)) return
  try {
    const res = await axios.post('/api/admin/users/role', {
      admin_user: authForm.username,
      admin_pwd: authForm.password,
      target_user: targetUser,
      role: newRole
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      loadAdminData()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('操作失败')
  }
}

const saveNotifySettings = async () => {
  try {
    const res = await axios.post('/api/user/notify_settings', {
      username: currentUser.username,
      notify_type: notifyForm.notify_type,
      serverchan_key: notifyForm.serverchan_key
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('保存设置失败')
  }
}

const testUserNotify = async () => {
  try {
    const res = await axios.post('/api/user/test_notify', { username: currentUser.username })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('测试发送失败')
  }
}

const submitChangePassword = async () => {
  if (!pwdForm.old_pwd || !pwdForm.new_pwd) {
    return ElMessage.warning('请输入当前旧密码和新密码')
  }
  if (pwdForm.new_pwd.length < 6) {
    return ElMessage.warning('新密码长度不能少于 6 位')
  }
  if (pwdForm.new_pwd !== pwdForm.confirm_pwd) {
    return ElMessage.warning('两次输入的新密码不一致')
  }
  try {
    const res = await axios.post('/api/user/change_password', {
      username: currentUser.username,
      old_password: pwdForm.old_pwd,
      new_password: pwdForm.new_pwd
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      pwdForm.old_pwd = ''
      pwdForm.new_pwd = ''
      pwdForm.confirm_pwd = ''
      setTimeout(() => location.reload(), 1500)
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('密码修改失败，请核对旧密码')
  }
}

const openSettingsTab = async () => {
  activeTab.value = 'settings'
  try {
    const res = await axios.get(`/api/admin/settings?admin_user=${authForm.username}&admin_pwd=${authForm.password}`)
    if (res.data.code === 200) {
      const d = res.data.data
      smtpForm.smtp_host = d.smtp_host
      smtpForm.smtp_port = d.smtp_port
      smtpForm.smtp_user = d.smtp_user
      smtpForm.smtp_pass = d.smtp_pass
      smtpForm.smtp_sender = d.smtp_sender
      smtpForm.smtp_ssl = d.smtp_ssl === 'true'
    }
  } catch (_) {}
}

const saveSmtpSettings = async () => {
  try {
    const res = await axios.post('/api/admin/settings', {
      admin_user: authForm.username,
      admin_pwd: authForm.password,
      ...smtpForm,
      smtp_ssl: smtpForm.smtp_ssl ? 'true' : 'false'
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('保存设置失败')
  }
}

const sendTestEmail = async () => {
  if (!testEmailTo.value) return ElMessage.warning('请输入测试收件邮箱')
  testingEmail.value = true
  try {
    const res = await axios.post('/api/admin/test_email', {
      admin_user: authForm.username,
      admin_pwd: authForm.password,
      test_to: testEmailTo.value
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('发信异常，请核对端口与授权码')
  } finally {
    testingEmail.value = false
  }
}

const copyText = async (text) => {
  if (!text) return ElMessage.warning('内容为空')
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      ElMessage.success('已复制到剪贴板！')
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
    ElMessage.success('已复制到剪贴板！')
  } catch (_) {
    ElMessage.error('快捷复制失败，请手动长按复制')
  }
  document.body.removeChild(ta)
}

const handleAuth = async () => {
  if (!authForm.username || !authForm.password) return ElMessage.warning('请填写账号与密码')
  loading.value = true
  const api = authMode.value === 'register' ? '/api/register' : '/api/login'
  try {
    const res = await axios.post(api, authForm)
    if (res.data.code === 200) {
      if (authMode.value === 'register') {
        ElMessage.success(res.data.msg)
        authMode.value = 'login'
      } else {
        ElMessage.success('登录成功')
        Object.assign(currentUser, res.data.data)
        notifyForm.notify_type = res.data.data.notify_type || 'email'
        notifyForm.serverchan_key = res.data.data.serverchan_key || ''
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
.dark-theme {
  min-height: 100vh;
  background-color: #080c14;
  color: #e2e8f0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
}
.cyber-header {
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(13, 19, 33, 0.85);
  backdrop-filter: blur(10px);
  padding: 14px 24px;
}
.header-content {
  max-width: 1100px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.brand-title { font-size: 18px; font-weight: 800; letter-spacing: 1.5px; }
.highlight { color: #38bdf8; text-shadow: 0 0 10px rgba(56, 189, 248, 0.5); }
.user-status { display: flex; align-items: center; gap: 12px; }

.main-body { max-width: 1100px; margin: 30px auto; padding: 0 16px; }
.dashboard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.col-span-2 { grid-column: span 2; }

/* 选项卡导航 */
.admin-wrapper { width: 100%; }
.card-tabs-nav {
  display: flex;
  gap: 16px;
  margin-bottom: 20px;
}
.tab-card-btn {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 14px;
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 12px;
  padding: 18px 20px;
  cursor: pointer;
  text-align: left;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  color: #94a3b8;
  position: relative;
}
.tab-card-btn:hover {
  background: #131d36;
  border-color: #38bdf8;
  transform: translateY(-2px);
}
.tab-card-btn.active {
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
  border-color: #38bdf8;
  box-shadow: 0 0 20px rgba(56, 189, 248, 0.2);
  color: #f8fafc;
}
.tab-icon { font-size: 24px; }
.tab-title { font-size: 14px; font-weight: 700; color: #f8fafc; margin-bottom: 2px; }
.tab-sub { font-size: 11px; color: #64748b; }
.count-tag {
  margin-left: auto;
  font-size: 11px;
  background: rgba(56, 189, 248, 0.1);
  color: #38bdf8;
  padding: 3px 8px;
  border-radius: 20px;
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.cyber-card {
  background: #0f172a;
  border: 1px solid rgba(56, 189, 248, 0.2);
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.tab-content-card { animation: fadeIn 0.3s ease-in-out; }
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.card-header h3 { margin: 0; font-size: 16px; color: #f1f5f9; }

.traffic-meter { margin: 15px 0; }
.meter-info { display: flex; justify-content: space-between; margin-bottom: 8px; }
.data-val { font-size: 22px; font-weight: 700; color: #38bdf8; }
.data-unit { font-size: 12px; color: #64748b; margin-left: 4px; }
.progress-track { background: #1e293b; height: 10px; border-radius: 5px; overflow: hidden; margin: 10px 0; }
.progress-glow { background: linear-gradient(90deg, #38bdf8, #818cf8); height: 100%; box-shadow: 0 0 12px #38bdf8; }
.expiry-notice { font-size: 13px; color: #94a3b8; }
.highlight-date { color: #f59e0b; }

.cyber-input {
  width: 100%;
  background: #1e293b;
  border: 1px solid #334155;
  color: #f8fafc;
  padding: 10px 14px;
  border-radius: 6px;
  outline: none;
  box-sizing: border-box;
}
.cyber-input:focus { border-color: #38bdf8; box-shadow: 0 0 8px rgba(56, 189, 248, 0.3); }

.code-send-group { display: flex; gap: 8px; }
.btn-cyber-code {
  background: #1e293b; border: 1px solid #38bdf8; color: #38bdf8; border-radius: 6px; padding: 0 14px;
  white-space: nowrap; cursor: pointer; font-size: 12px;
}
.btn-cyber-code:disabled { opacity: 0.5; cursor: not-allowed; border-color: #475569; color: #94a3b8; }

.btn-cyber-primary {
  background: linear-gradient(135deg, #0284c7, #2563eb);
  color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 700; cursor: pointer; width: 100%;
}
.redeem-box { display: flex; gap: 10px; align-items: center; }
.redeem-box .cyber-input { flex: 1; min-width: 0; }
.btn-cyber-success {
  background: #059669; color: white; border: none; padding: 10px 18px; border-radius: 6px; cursor: pointer;
  white-space: nowrap; flex-shrink: 0; font-weight: 600;
}
.btn-cyber-action { background: #334155; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.btn-cyber-refresh { background: transparent; border: 1px solid #38bdf8; color: #38bdf8; padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }

.node-field { margin-bottom: 14px; }
.node-field label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
.code-display {
  background: #020617; border: 1px dashed rgba(255, 255, 255, 0.15); padding: 12px; border-radius: 6px;
  font-size: 13px; word-break: break-all; font-family: monospace;
}
.text-green { color: #34d399; font-weight: bold; }
.text-cyan { color: #38bdf8; }
.btn-group { display: flex; gap: 12px; margin-top: 16px; }

.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 10px; }
.settings-section { background: #0a0f1d; border: 1px solid #1e293b; padding: 20px; border-radius: 8px; }
.settings-section h4 { margin-top: 0; margin-bottom: 16px; color: #f1f5f9; font-size: 14px; border-bottom: 1px solid #1e293b; padding-bottom: 8px; }
.radio-group { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
.radio-label { font-size: 13px; color: #cbd5e1; cursor: pointer; display: flex; align-items: center; gap: 8px; }
.input-hint { font-size: 11px; color: #94a3b8; margin-top: 6px; line-height: 1.5; }
.cyber-link { color: #38bdf8; text-decoration: underline; }

.modal-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.8); display: flex; justify-content: center; align-items: center; z-index: 1000; }
.cyber-modal { background: #0f172a; border: 1px solid #38bdf8; border-radius: 12px; padding: 24px; max-width: 360px; box-shadow: 0 0 30px rgba(56, 189, 248, 0.25); }
.qr-box { background: white; padding: 12px; border-radius: 8px; display: inline-block; margin: 10px 0; }
.modal-tip { font-size: 12px; color: #94a3b8; margin: 4px 0 10px 0; }

.table-container { overflow-x: auto; margin-top: 10px; }
.cyber-table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
.cyber-table th, .cyber-table td { padding: 12px 10px; border-bottom: 1px solid #1e293b; }
.cyber-table th { color: #64748b; font-weight: 600; }
.table-progress { background: #1e293b; height: 4px; border-radius: 2px; overflow: hidden; margin-top: 4px; width: 100px; }
.table-glow { background: #38bdf8; height: 100%; }

.badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; }
.badge-ready { background: rgba(16, 185, 129, 0.2); color: #34d399; }
.badge-used { background: rgba(239, 68, 68, 0.2); color: #f87171; }
.role-badge { padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
.role-badge.admin { background: #dc2626; color: white; }
.role-badge.user { background: #2563eb; color: white; }
.btn-logout { background: transparent; border: 1px solid #475569; color: #94a3b8; padding: 4px 10px; border-radius: 4px; cursor: pointer; }

.action-btn-row { display: flex; gap: 6px; align-items: center; }
.btn-sm { padding: 4px 8px; font-size: 11px; border-radius: 4px; border: none; cursor: pointer; white-space: nowrap; }
.btn-action { background: #0284c7; color: white; }
.btn-reset { background: #d97706; color: white; font-weight: 600; }
.btn-edit { background: #4f46e5; color: white; }
.btn-promote { background: #f59e0b; color: #000; font-weight: 700; }
.btn-demote { background: #475569; color: #fff; }
.btn-del { background: #b91c1c; color: white; }
.btn-del:disabled, .btn-demote:disabled { opacity: 0.3; cursor: not-allowed; }

.auth-box { max-width: 420px; margin: 40px auto; }
.form-item { margin-bottom: 16px; }
.form-item label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
.auth-nav-links { display: flex; justify-content: space-between; margin-top: 16px; font-size: 13px; }
.auth-nav-links a { color: #38bdf8; text-decoration: none; }
.auth-nav-links a.text-warning { color: #f59e0b; }
.auth-nav-links a:hover { text-decoration: underline; }
.gen-form { display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: 10px; align-items: flex-end; }
</style>