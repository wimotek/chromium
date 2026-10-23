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

        <!-- 节点配置与密钥 -->
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

        <!-- 用户通知偏好与安全设置 -->
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

      <!-- 3. 管理员控制台：卡片切换布局 -->
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
              <div class="tab-sub">批量制卡、库存导出、对接发卡系统 API</div>
            </div>
            <span class="count-tag">{{ adminCards.length }} 张卡密</span>
          </button>

          <button class="tab-card-btn" :class="{ active: activeTab === 'settings' }" @click="openSettingsTab">
            <span class="tab-icon">⚙️</span>
            <div class="tab-text">
              <div class="tab-title">系统发信与定时任务设置</div>
              <div class="tab-sub">SMTP 配置、定时流量到期提醒与发卡令牌</div>
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
                  <th>通知通道</th>
                  <th>专属凭证</th>
                  <th style="width: 250px;">治理操作</th>
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
                      <button v-else class="btn-sm btn-unban" @click="handleStatusToggle(u.username, 1)">🟢 解封</button>
                      <button class="btn-sm btn-del" :disabled="u.username === currentUser.username" @click="handleDeleteUser(u.username)">🗑️</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 选项卡 2: 卡密管理 (高级多选、日期范围导出、API 开关/Token) -->
        <div v-else-if="activeTab === 'cards'" class="cyber-card tab-content-card">
          <!-- 1. 批量制卡区域 -->
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

          <!-- 2. 卡密高级筛选与导出控制器 (方案 B 增强) -->
          <div class="card-header" style="margin-top: 30px;">
            <h3>📦 历史卡密库存与核销流水 (最新200条)</h3>
            <button class="btn-cyber-refresh" @click="loadAdminData">🔄 刷新列表</button>
          </div>

          <!-- 导出工具栏：日期筛选与多模式导出 -->
          <div class="export-toolbar">
            <div class="date-filter-group">
              <span class="filter-label">📅 日期范围筛选:</span>
              <input v-model="exportFilter.startDate" type="date" class="cyber-input date-input" />
              <span style="color: #64748b;">至</span>
              <input v-model="exportFilter.endDate" type="date" class="cyber-input date-input" />
              <button class="btn-sm btn-action" @click="exportByDateRange">按日期范围导出</button>
            </div>

            <div class="export-actions-group">
              <button class="btn-sm btn-export-select" :disabled="selectedCards.length === 0" @click="exportSelectedCards">
                ☑️ 导出勾选卡密 (已选 {{ selectedCards.length }} 张)
              </button>
              <button class="btn-sm btn-cyber-success" @click="exportAllUnusedCards">
                📋 导出全部未售卡密
              </button>
            </div>
          </div>

          <!-- 卡密数据表格 (带复选框、生成日期) -->
          <div class="table-container">
            <table class="cyber-table">
              <thead>
                <tr>
                  <th style="width: 40px; text-align: center;">
                    <input type="checkbox" :checked="isAllSelected" @change="toggleSelectAll" title="全选当前页未售卡密" />
                  </th>
                  <th>兑换卡密编号</th>
                  <th>套餐配额</th>
                  <th>核销状态</th>
                  <th>生成日期</th>
                  <th>兑换用户</th>
                  <th>单张操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in adminCards" :key="c.code">
                  <td style="text-align: center;">
                    <input type="checkbox" :value="c.code" v-model="selectedCards" />
                  </td>
                  <td class="font-mono text-cyan">{{ c.code }}</td>
                  <td>{{ c.traffic_gb }} GB / {{ c.days }} 天</td>
                  <td>
                    <span class="badge" :class="c.is_used ? 'badge-used' : 'badge-ready'">
                      {{ c.is_used ? '已核销' : '待售出/有效' }}
                    </span>
                  </td>
                  <td class="text-muted">{{ c.created_at || '早期生成' }}</td>
                  <td>{{ c.u