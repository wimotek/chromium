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

      <!-- 2. 普通用户端仪表盘 (流式全屏) -->
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
                <span class="data-val">{{ currentUser.limit_mb === 0 ? '♾️' : currentUser.limit_mb }}</span>
                <span class="data-unit">{{ currentUser.limit_mb === 0 ? '不限流量' : 'MB (总额)' }}</span>
              </div>
            </div>
            <div class="progress-track">
              <div class="progress-glow" :style="{ width: trafficPercent + '%' }"></div>
            </div>
            <div class="expiry-notice">
              <span>套餐有效期：</span>
              <strong class="highlight-date">
                {{ (currentUser.expire_date && currentUser.expire_date.startsWith('2099')) ? '♾️ 永久有效' : currentUser.expire_date }}
              </strong>
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

        <!-- 节点配置与专属客户端下载 -->
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
            <button class="btn-cyber-download" :disabled="downloadingClient" @click="downloadWindowsClient">
              {{ downloadingClient ? '正在打包客户端...' : '🖥️ 下载 Windows 开箱即用客户端' }}
            </button>
          </div>
        </div>

        <!-- 普通用户通知与改密卡片 -->
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
                    <input type="radio" value="email" v-model="notifyForm.notify_type" /> 📧 电子邮箱通知 ({{ currentUser.email || '尚未绑定' }})
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

      <!-- 3. 管理员控制台：全屏动态自适应 -->
      <div v-else-if="currentUser.role === 'admin'" class="admin-wrapper">
        <!-- 顶部主卡片切换导航 -->
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
              <div class="tab-sub">管理员通知、节点域名、SMTP 与定时预警</div>
            </div>
            <span class="count-tag">配置中心</span>
          </button>
        </div>

        <!-- 主选项卡 1: 用户管理 -->
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
                  <th>流量使用 / 总配额</th>
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
                    <div>{{ u.used_mb }} / {{ u.traffic_limit_mb === 0 ? '♾️ 不限' : u.traffic_limit_mb + ' MB' }}</div>
                    <div class="table-progress"><div class="table-glow" :style="{ width: calcProgress(u.used_mb, u.traffic_limit_mb) + '%' }"></div></div>
                  </td>
                  <td>{{ (u.expire_date && u.expire_date.startsWith('2099')) ? '♾️ 永久有效' : u.expire_date }}</td>
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

        <!-- 主选项卡 2: 卡密管理 (子卡片体系) -->
        <div v-else-if="activeTab === 'cards'" class="cyber-card tab-content-card">
          <div class="sub-tab-nav">
            <button class="sub-tab-btn" :class="{ active: cardSubTab === 'inventory' }" @click="cardSubTab = 'inventory'">
              📦 卡密制卡与库存管理
            </button>
            <button class="sub-tab-btn" :class="{ active: cardSubTab === 'api' }" @click="cardSubTab = 'api'">
              🔌 API自动发卡
            </button>
          </div>

          <!-- 子卡片 A: 批量制卡与库存 -->
          <div v-if="cardSubTab === 'inventory'" class="sub-tab-pane">
            <div class="card-header">
              <h3>🛠️ 批量生成卡密</h3>
            </div>
            <div class="gen-form">
              <div>
                <label>流量配额 (GB, 填0为不限)</label>
                <input v-model.number="cardGenForm.traffic_gb" type="number" class="cyber-input" placeholder="0=不限" />
              </div>
              <div>
                <label>有效时限 (天, 填36500为永久)</label>
                <input v-model.number="cardGenForm.days" type="number" class="cyber-input" placeholder="36500=永久" />
              </div>
              <div>
                <label>批量制卡数 (张)</label>
                <input v-model.number="cardGenForm.count" type="number" class="cyber-input" />
              </div>
              <button class="btn-cyber-success" @click="generateCards">立即批量制卡</button>
            </div>

            <div class="card-header" style="margin-top: 30px;">
              <h3>📦 历史卡密库存与核销流水 (最新200条)</h3>
              <button class="btn-cyber-refresh" @click="loadAdminData">🔄 刷新列表</button>
            </div>

            <!-- 导出工具栏 -->
            <div class="export-toolbar">
              <div class="date-filter-group">
                <span class="filter-label">📅 日期范围:</span>
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

            <div class="table-container">
              <table class="cyber-table">
                <thead>
                  <tr>
                    <th style="width: 40px; text-align: center;">
                      <input type="checkbox" :checked="isAllSelected" @change="toggleSelectAll" title="全选未售卡密" />
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
                    <td>{{ c.traffic_gb === 0 ? '♾️ 不限' : c.traffic_gb + ' GB' }} / {{ c.days >= 3650 ? '永久' : c.days + ' 天' }}</td>
                    <td>
                      <span class="badge" :class="c.is_used ? 'badge-used' : 'badge-ready'">
                        {{ c.is_used ? '已核销' : '待售出/有效' }}
                      </span>
                    </td>
                    <td class="text-muted">{{ c.created_at || '早期生成' }}</td>
                    <td>{{ c.used_by || '-' }}</td>
                    <td><button class="btn-sm btn-action" @click="copyText(c.code)">一键复制</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 子卡片 B: 方案 C API 自动发卡 -->
          <div v-else-if="cardSubTab === 'api'" class="sub-tab-pane">
            <div class="settings-section" style="margin-top: 5px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid #1e293b; padding-bottom: 10px;">
                <h4 style="margin: 0; border: none; padding: 0; font-size: 16px; color: #38bdf8;">🔌 API自动发卡</h4>
                <label class="radio-label" style="font-weight: 600;">
                  <input type="checkbox" v-model="settingsForm.faka_api_enable" @change="saveAllSettings" />
                  <span :style="{ color: settingsForm.faka_api_enable ? '#10b981' : '#ef4444' }">
                    {{ settingsForm.faka_api_enable ? '🟢 接口运行中' : '🔴 接口已停用' }}
                  </span>
                </label>
              </div>

              <p class="card-desc">买家在独角数卡等第三方发卡网付款后，发卡系统可自动请求此 API 现场生成一张卡密交付：</p>

              <div class="form-item">
                <label>API 通信验证 TOKEN (密钥)：</label>
                <div style="display: flex; gap: 8px;">
                  <input v-model="settingsForm.faka_api_token" type="text" class="cyber-input font-mono" placeholder="自定义出卡令牌" />
                  <button class="btn-sm btn-action" style="padding: 0 14px; white-space: nowrap;" @click="generateRandomToken">🎲 随机生成</button>
                  <button class="btn-sm btn-cyber-success" style="padding: 0 14px; white-space: nowrap;" @click="saveAllSettings">保存密钥</button>
                </div>
                <span class="input-hint">第三方发卡系统调用出卡接口时必须携带此 Token 进行身份鉴权</span>
              </div>

              <div class="node-field" style="margin-top: 18px;">
                <label>独角数卡自定义发卡调用 URL (GET / POST)：</label>
                <div class="code-display text-cyan">{{ fakaApiUrlSample }}</div>
              </div>

              <div class="btn-group">
                <button class="btn-cyber-action" @click="copyText(fakaApiUrlSample)">复制 API 完整调用地址</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 主选项卡 3: 系统发信与定时任务设置 (核心优化：引入子卡片，彻底消灭平铺) -->
        <div v-else-if="activeTab === 'settings'" class="cyber-card tab-content-card">
          <!-- 设置板块子卡片切换器 -->
          <div class="sub-tab-nav">
            <button
              class="sub-tab-btn"
              :class="{ active: settingSubTab === 'admin_notify' }"
              @click="settingSubTab = 'admin_notify'">
              🔔 管理员通知与安全
            </button>
            <button
              class="sub-tab-btn"
              :class="{ active: settingSubTab === 'network_smtp' }"
              @click="settingSubTab = 'network_smtp'">
              🌐 节点连接与发信配置 (SMTP)
            </button>
            <button
              class="sub-tab-btn"
              :class="{ active: settingSubTab === 'cron' }"
              @click="settingSubTab = 'cron'">
              ⏰ 定时任务与预警
            </button>
          </div>

          <!-- 子卡片 1: 管理员个人通知偏好与改密 (彻底解决管理员无法配置通知的问题) -->
          <div v-if="settingSubTab === 'admin_notify'" class="sub-tab-pane">
            <div class="card-header">
              <h3>🔔 管理员专属通知通道与安全设置</h3>
            </div>
            <p class="card-desc">配置当前登录的管理员 ({{ currentUser.username }}) 的通知接收通道。当产生告警、充值或异常事件时优先向此通道推送：</p>

            <div class="settings-section" style="margin-top: 10px;">
              <h4>1. 管理员消息告警通道偏好 (Server酱 / 邮件)</h4>
              <div class="form-item">
                <label>选择接收通知通道</label>
                <div class="radio-group">
                  <label class="radio-label">
                    <input type="radio" value="email" v-model="notifyForm.notify_type" />
                    📧 电子邮箱接收 ({{ currentUser.email || '未绑定邮箱' }})
                  </label>
                  <label class="radio-label">
                    <input type="radio" value="serverchan" v-model="notifyForm.notify_type" />
                    📲 Server酱 (微信服务号即时推送)
                  </label>
                </div>
              </div>

              <div class="form-item" v-if="notifyForm.notify_type === 'serverchan'">
                <label>Server酱 SendKey：</label>
                <input v-model="notifyForm.serverchan_key" type="text" class="cyber-input font-mono" placeholder="SCTxxxxxxxxxx" />
                <div class="input-hint">
                  💡 未申请过？点击前往 <a href="https://sct.ftqq.com/" target="_blank" class="cyber-link">Server酱·Turbo版官网 (https://sct.ftqq.com/)</a> 微信扫码一键获取 SendKey。
                </div>
              </div>

              <div class="btn-group" style="margin-top: 15px;">
                <button class="btn-cyber-success" @click="saveNotifySettings">保存管理员通知设置</button>
                <button class="btn-cyber-action" @click="testUserNotify">发送测试通知 (微信/邮件)</button>
              </div>
            </div>

            <div class="settings-section" style="margin-top: 20px;">
              <h4>2. 修改管理员自身登录密码</h4>
              <div class="form-item">
                <label>当前管理员旧密码</label>
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
              <button class="btn-cyber-primary" style="width: auto; padding: 10px 24px;" @click="submitChangePassword">确认变更密码</button>
            </div>
          </div>

          <!-- 子卡片 2: 节点连接地址与发信服务器配置 -->
          <div v-else-if="settingSubTab === 'network_smtp'" class="sub-tab-pane">
            <div class="card-header">
              <h3>🌐 节点连接地址与 SMTP 发信服务器参数</h3>
            </div>

            <div class="settings-section" style="margin-top: 10px;">
              <h4>🌐 节点客户端连接地址配置 (域名或 IP)</h4>
              <div class="form-item">
                <label>自定义节点连接地址 (域名或 IP)</label>
                <input v-model="settingsForm.custom_host" type="text" class="cyber-input" placeholder="留空则自动获取公网 IP" />
                <span class="input-hint">
                  💡 默认为空。可输入解析到本机的专属域名（如 <code>hk.node.com</code>）或中转 IP。<br>
                  <b>清空该输入框并保存时，系统将全自动恢复为自动检测的公网 IP。</b>
                </span>
              </div>
              <button class="btn-cyber-success" style="margin-top: 6px;" @click="saveAllSettings">保存连接地址</button>
            </div>

            <div class="settings-section" style="margin-top: 20px;">
              <h4>📧 SMTP 发信服务器参数配置</h4>
              
              <div class="smtp-status-box" :class="settingsForm.is_smtp_configured ? 'smtp-ready' : 'smtp-empty'">
                <span>{{ settingsForm.is_smtp_configured ? '🟢 SMTP 发信通道：已配置就绪（可正常发送邮件）' : '⚪ SMTP 发信通道：尚未完整配置（无法发送邮件与验证码）' }}</span>
              </div>

              <div class="form-item">
                <label>SMTP 服务器地址</label>
                <input v-model="settingsForm.smtp_host" type="text" class="cyber-input" placeholder="例如: smtp.qq.com / smtp.163.com" />
              </div>
              <div class="form-item">
                <label>端口 (SSL 常用 465, STARTTLS 常用 587)</label>
                <input v-model="settingsForm.smtp_port" type="text" class="cyber-input" placeholder="465" />
              </div>
              <div class="form-item">
                <label>发信邮箱账号 (User)</label>
                <input v-model="settingsForm.smtp_user" type="text" class="cyber-input" placeholder="service@example.com" />
              </div>
              <div class="form-item">
                <label>邮箱授权码 / 密码 (Password)</label>
                <input
                  v-model="settingsForm.smtp_pass"
                  type="password"
                  class="cyber-input"
                  :placeholder="settingsForm.has_smtp_pass ? '●●●●●●●● (已安全保存，留空则保持原密码)' : '请输入第三方客户端授权码'"
                />
                <span class="input-hint">
                  {{ settingsForm.has_smtp_pass ? '✅ 系统已安全保存授权码。若无需更换，请直接留空保存即可。' : '⚠️ 尚未配置授权码，配置后方可发送邮件。' }}
                </span>
              </div>
              <div class="form-item">
                <label>发件人显示名称 (Sender Name)</label>
                <input v-model="settingsForm.smtp_sender" type="text" class="cyber-input" placeholder="Xray 节点中心" />
              </div>
              <div class="form-item">
                <label class="radio-label">
                  <input type="checkbox" v-model="settingsForm.smtp_ssl" /> 启用 SSL 安全加密连接 (推荐开启)
                </label>
              </div>

              <div class="btn-group" style="margin-top: 15px;">
                <button class="btn-cyber-success" @click="saveAllSettings">保存发信服务器参数</button>
              </div>

              <div class="form-item" style="margin-top: 20px; border-top: 1px dashed #1e293b; padding-top: 12px;">
                <label>发信连通性验证 (收件邮箱)</label>
                <div style="display: flex; gap: 8px;">
                  <input v-model="testEmailTo" type="email" class="cyber-input" placeholder="test@example.com" />
                  <button class="btn-cyber-action" :disabled="testingEmail" @click="sendTestEmail">
                    {{ testingEmail ? '发送中...' : '测试发信' }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 子卡片 3: 定时预警与推送任务 -->
          <div v-else-if="settingSubTab === 'cron'" class="sub-tab-pane">
            <div class="card-header">
              <h3>⏰ 定时自动检测与智能推送任务设置</h3>
            </div>

            <div class="settings-section" style="margin-top: 10px;">
              <div class="form-item">
                <label class="radio-label">
                  <input type="checkbox" v-model="settingsForm.task_notify_enable" /> 启用后台定时自动轮询与智能预警
                </label>
              </div>

              <div class="form-item">
                <label>轮询检测执行周期 (小时)</label>
                <input v-model.number="settingsForm.task_interval_hours" type="number" class="cyber-input" placeholder="默认 12 小时执行一次" />
              </div>

              <div class="form-item">
                <label>流量不足告警阈值 (%)</label>
                <input v-model.number="settingsForm.task_traffic_threshold" type="number" class="cyber-input" placeholder="例如已用达 80% 触发" />
                <span class="input-hint">用户已用流量达到该百分比时触发提醒（设为不限流量的用户不会提醒）</span>
              </div>

              <div class="form-item">
                <label>套餐到期告警阈值 (天)</label>
                <input v-model.number="settingsForm.task_expire_days" type="number" class="cyber-input" placeholder="例如到期前 3 天触发" />
                <span class="input-hint">距离到期时间不足设定天数时触发提醒（永久有效用户不会提醒）</span>
              </div>

              <div class="btn-group" style="margin-top: 15px;">
                <button class="btn-cyber-success" @click="saveAllSettings">保存定时任务设置</button>
              </div>

              <div class="form-item" style="margin-top: 20px; border-top: 1px dashed #1e293b; padding-top: 12px;">
                <div style="font-size: 12px; color: #94a3b8; margin-bottom: 8px;">
                  最近自动扫描完成时间：<b class="text-cyan">{{ settingsForm.task_last_run }}</b>
                </div>
                <button class="btn-cyber-primary" :disabled="triggeringTask" style="width: auto; padding: 10px 20px;" @click="triggerManualTask">
                  {{ triggeringTask ? '正在扫描并推送...' : '⚡ 立即执行一次检测推送' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- 弹窗 1：SVG 高清二维码弹窗 -->
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
      <div class="cyber-modal" style="max-width: 440px; text-align: left;" @click.stop>
        <h3>✏️ 调整用户 [{{ editForm.username }}] 属性</h3>
        
        <div class="form-item" style="margin-top: 15px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <label style="margin: 0;">总流量限制配额 (MB)</label>
            <button class="btn-link-action" @click="editForm.limit_mb = 0">♾️ 设为不限流量</button>
          </div>
          <input v-model.number="editForm.limit_mb" type="number" class="cyber-input" />
          <span style="font-size: 11px; color: #64748b;">提示：填 0 表示不限制流量 | 100GB = 102400MB</span>
        </div>

        <div class="form-item">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <label style="margin: 0;">套餐到期时限</label>
            <button class="btn-link-action" @click="editForm.expire_date = '2099-12-31 23:59:59'">♾️ 设为永久有效</button>
          </div>
          <input v-model="editForm.expire_date" type="text" class="cyber-input" />
          <span style="font-size: 11px; color: #64748b;">提示：填 2099-12-31 表示永久有效</span>
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

// 卡密内部子卡片 ('inventory': 批量与库存 | 'api': API自动发卡)
const cardSubTab = ref('inventory')

// 核心新增：系统设置内部子卡片 ('admin_notify': 管理员通知 | 'network_smtp': 节点与发信 | 'cron': 定时任务)
const settingSubTab = ref('admin_notify')

const authMode = ref('login')
const countdown = ref(0)
const sendingCode = ref(false)
const downloadingClient = ref(false)

const showQrModal = ref(false)
const targetModalUser = ref('')
const targetModalLink = ref('')

const showEditModal = ref(false)
const editForm = reactive({ username: '', limit_mb: 1024, expire_date: '' })

const showResetPwdModal = ref(false)
const resetTargetUser = ref('')
const resetNewPassword = ref('')

const currentUser = reactive({ username: '', email: '', role: '', used_mb: 0, limit_mb: 0, expire_date: '', public_key: '', sub_link: '' })
const authForm = reactive({ username: '', email: '', code: '', password: '' })
const forgotForm = reactive({ email: '', code: '', new_password: '' })
const cardGenForm = reactive({ traffic_gb: 50, days: 30, count: 5 })
const notifyForm = reactive({ notify_type: 'email', serverchan_key: '' })
const pwdForm = reactive({ old_pwd: '', new_pwd: '', confirm_pwd: '' })

const selectedCards = ref([])
const exportFilter = reactive({ startDate: '', endDate: '' })

const settingsForm = reactive({
  smtp_host: '',
  smtp_port: '465',
  smtp_user: '',
  smtp_pass: '',
  has_smtp_pass: false,
  is_smtp_configured: false,
  smtp_sender: '',
  smtp_ssl: true,
  task_notify_enable: true,
  task_interval_hours: 12,
  task_traffic_threshold: 80,
  task_expire_days: 3,
  task_last_run: '尚未执行',
  faka_api_enable: true,
  faka_api_token: 'faka_secret_token_8899',
  custom_host: ''
})

const testEmailTo = ref('')
const testingEmail = ref(false)
const triggeringTask = ref(false)

const adminCards = ref([])
const adminUsers = ref([])

onMounted(async () => {
  try {
    const res = await axios.get('/api/system/info')
    if (res.data.data.mode === 'admin') isPureAdmin.value = true
  } catch (_) {}
})

const authCardTitle = computed(() => {
  if (isPureAdmin.value) return '管理员认证'
  if (authMode.value === 'login') return '控制台账号接入'
  if (authMode.value === 'register') return '新用户激活注册'
  return '🔐 找回 / 重置密码'
})

const countdownText = computed(() => {
  if (countdown.value > 0) return countdown.value + 's 后重试'
  if (sendingCode.value) return '发送中...'
  return '获取验证码'
})

const trafficPercent = computed(() => {
  if (!currentUser.limit_mb) return 100
  return Math.min(100, Math.round((currentUser.used_mb / currentUser.limit_mb) * 100))
})

const calcProgress = (used, total) => {
  if (!total) return 100
  return Math.min(100, Math.round((used / total) * 100))
}

const qrCodeImgUrl = computed(() => {
  if (!targetModalLink.value) return ''
  return '/api/qrcode?text=' + encodeURIComponent(targetModalLink.value)
})

const fakaApiUrlSample = computed(() => {
  const host = window.location.origin
  const token = settingsForm.faka_api_token || 'faka_secret_token_8899'
  return `${host}/api/open/faka_generate?gb=100&days=30&token=${token}`
})

const isAllSelected = computed(() => {
  const unusedList = adminCards.value.filter(c => !c.is_used)
  if (unusedList.length === 0) return false
  return unusedList.every(c => selectedCards.value.includes(c.code))
})

const toggleSelectAll = (e) => {
  if (e.target.checked) {
    selectedCards.value = adminCards.value.filter(c => !c.is_used).map(c => c.code)
  } else {
    selectedCards.value = []
  }
}

const generateRandomToken = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let token = 'FAKA_'
  for (let i = 0; i < 20; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  settingsForm.faka_api_token = token
  ElMessage.success('已随机生成新出卡 Token，请记得点击保存')
}

// 统一导出底层
const executeExport = async (payload, successTip) => {
  try {
    const adminUser = currentUser.username || authForm.username
    const res = await axios.post('/api/admin/cards/export_unused', {
      admin_user: adminUser,
      admin_pwd: authForm.password,
      ...payload
    })
    if (res.data.code === 200) {
      if (res.data.count === 0) {
        return ElMessage.warning('筛选条件下暂无可导出的未核销卡密')
      }
      copyText(res.data.text)
      ElMessage.success(`${successTip}（共 ${res.data.count} 张，已符合独角数卡格式）`)
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('导出失败')
  }
}

const exportSelectedCards = () => {
  if (selectedCards.value.length === 0) return ElMessage.warning('请先在表格左侧勾选要导出的卡密')
  executeExport({ selected_codes: selectedCards.value }, '已复制选中的卡密')
}

const exportByDateRange = () => {
  if (!exportFilter.startDate && !exportFilter.endDate) {
    return ElMessage.warning('请先选择开始日期或结束日期')
  }
  executeExport({
    start_date: exportFilter.startDate,
    end_date: exportFilter.endDate
  }, '已导出指定日期范围内的未售卡密')
}

const exportAllUnusedCards = () => {
  executeExport({}, '已复制全部未售卡密')
}

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
    const adminUser = currentUser.username || authForm.username
    const res = await axios.post('/api/admin/users/reset_password', {
      admin_user: adminUser,
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
    const adminUser = currentUser.username || authForm.username
    const res = await axios.post('/api/admin/users/edit', {
      admin_user: adminUser,
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
    const adminUser = currentUser.username || authForm.username
    const res = await axios.post('/api/admin/users/status', {
      admin_user: adminUser,
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
    const adminUser = currentUser.username || authForm.username
    const res = await axios.post('/api/admin/users/delete', {
      admin_user: adminUser,
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

const downloadWindowsClient = () => {
  if (!currentUser.username) return ElMessage.warning('用户未就绪')
  downloadingClient.value = true
  ElMessage.info('系统正在为您实时调取核心并组装专属配置，请稍候...')

  const downloadUrl = `/api/user/download_client?username=${encodeURIComponent(currentUser.username)}`
  const a = document.createElement('a')
  a.href = downloadUrl
  a.download = `Xray_Windows_${currentUser.username}.zip`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)

  setTimeout(() => {
    downloadingClient.value = false
  }, 3000)
}

const openSettingsTab = async () => {
  activeTab.value = 'settings'
  try {
    const adminUser = currentUser.username || authForm.username
    const res = await axios.get(`/api/admin/settings?admin_user=${encodeURIComponent(adminUser)}&admin_pwd=${encodeURIComponent(authForm.password)}`)
    if (res.data.code === 200) {
      const d = res.data.data
      settingsForm.smtp_host = d.smtp_host || ''
      settingsForm.smtp_port = d.smtp_port || '465'
      settingsForm.smtp_user = d.smtp_user || ''
      settingsForm.smtp_pass = ''
      settingsForm.has_smtp_pass = d.has_smtp_pass || false
      settingsForm.is_smtp_configured = d.is_smtp_configured || false
      settingsForm.smtp_sender = d.smtp_sender || ''
      settingsForm.smtp_ssl = d.smtp_ssl === 'true'
      settingsForm.task_notify_enable = d.task_notify_enable === 'true'
      settingsForm.task_interval_hours = Number(d.task_interval_hours) || 12
      settingsForm.task_traffic_threshold = Number(d.task_traffic_threshold) || 80
      settingsForm.task_expire_days = Number(d.task_expire_days) || 3
      settingsForm.task_last_run = d.task_last_run || '尚未执行'
      settingsForm.faka_api_enable = d.faka_api_enable === 'true'
      settingsForm.faka_api_token = d.faka_api_token || 'faka_secret_token_8899'
      settingsForm.custom_host = d.custom_host || ''
    }
  } catch (_) {}
}

const saveAllSettings = async () => {
  try {
    const adminUser = currentUser.username || authForm.username
    const res = await axios.post('/api/admin/settings', {
      admin_user: adminUser,
      admin_pwd: authForm.password,
      ...settingsForm,
      smtp_ssl: settingsForm.smtp_ssl ? 'true' : 'false',
      task_notify_enable: settingsForm.task_notify_enable ? 'true' : 'false',
      faka_api_enable: settingsForm.faka_api_enable ? 'true' : 'false'
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      openSettingsTab()
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
    const adminUser = currentUser.username || authForm.username
    const res = await axios.post('/api/admin/test_email', {
      admin_user: adminUser,
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

const triggerManualTask = async () => {
  triggeringTask.value = true
  try {
    const adminUser = currentUser.username || authForm.username
    const res = await axios.post('/api/admin/tasks/trigger', {
      admin_user: adminUser,
      admin_pwd: authForm.password
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      openSettingsTab()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('触发扫描任务失败')
  } finally {
    triggeringTask.value = false
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

const exportSelectedCards = () => {
  if (selectedCards.value.length === 0) return ElMessage.warning('请先在表格左侧勾选要导出的卡密')
  executeExport({ selected_codes: selectedCards.value }, '已复制选中的卡密')
}

const exportByDateRange = () => {
  if (!exportFilter.startDate && !exportFilter.endDate) {
    return ElMessage.warning('请先选择开始日期或结束日期')
  }
  executeExport({
    start_date: exportFilter.startDate,
    end_date: exportFilter.endDate
  }, '已导出指定日期范围内的未售卡密')
}

const exportAllUnusedCards = () => {
  executeExport({}, '已复制全部未售卡密')
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
  const adminUser = currentUser.username || authForm.username
  const res = await axios.post('/api/admin/data', { admin_user: adminUser, admin_pwd: authForm.password })
  if (res.data.code === 200) {
    adminCards.value = res.data.cards
    adminUsers.value = res.data.users
    selectedCards.value = []
  }
}

const generateCards = async () => {
  loading.value = true
  try {
    const adminUser = currentUser.username || authForm.username
    const res = await axios.post('/api/admin/cards/generate', { admin_user: adminUser, admin_pwd: authForm.password, ...cardGenForm })
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
  width: 100%;
  max-width: 98%;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.brand-title { font-size: 18px; font-weight: 800; letter-spacing: 1.5px; }
.highlight { color: #38bdf8; text-shadow: 0 0 10px rgba(56, 189, 248, 0.5); }
.user-status { display: flex; align-items: center; gap: 12px; }

.main-body {
  width: 100%;
  max-width: 98%;
  margin: 20px auto;
  padding: 0 12px;
  box-sizing: border-box;
}
.dashboard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.col-span-2 { grid-column: span 2; }

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
  padding: 16px 20px;
  cursor: pointer;
  text-align: left;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  color: #94a3b8;
  position: relative;
  min-width: 0;
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
.tab-icon { font-size: 24px; flex-shrink: 0; }
.tab-text { flex: 1; min-width: 0; }
.tab-title { font-size: 14px; font-weight: 700; color: #f8fafc; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tab-sub { font-size: 11px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.count-tag {
  margin-left: auto;
  font-size: 11px;
  background: rgba(56, 189, 248, 0.1);
  color: #38bdf8;
  padding: 3px 10px;
  border-radius: 20px;
  border: 1px solid rgba(56, 189, 248, 0.3);
  white-space: nowrap;
  flex-shrink: 0;
}

/* 子卡片选项卡样式 */
.sub-tab-nav {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
  border-bottom: 1px solid #1e293b;
  padding-bottom: 12px;
  flex-wrap: wrap;
}
.sub-tab-btn {
  background: #0b1120;
  border: 1px solid #1e293b;
  color: #94a3b8;
  padding: 8px 18px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.2s;
}
.sub-tab-btn:hover {
  color: #38bdf8;
  border-color: #38bdf8;
}
.sub-tab-btn.active {
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
  border-color: #38bdf8;
  box-shadow: 0 0 12px rgba(56, 189, 248, 0.25);
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

.smtp-status-box {
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 16px;
}
.smtp-ready {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.4);
  color: #34d399;
}
.smtp-empty {
  background: rgba(148, 163, 184, 0.1);
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: #94a3b8;
}

.export-toolbar {
  background: #0a0f1d;
  border: 1px solid #1e293b;
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.date-filter-group {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.filter-label { color: #94a3b8; font-weight: 600; white-space: nowrap; }
.date-input { width: 130px; padding: 6px 10px; font-size: 12px; }
.export-actions-group { display: flex; gap: 8px; align-items: center; }
.btn-export-select {
  background: #3b82f6;
  color: white;
  font-weight: 600;
}
.btn-export-select:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  background: #475569;
}

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

.btn-cyber-download {
  background: linear-gradient(135deg, #10b981, #059669);
  color: white;
  border: none;
  padding: 10px 18px;
  border-radius: 6px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
  box-shadow: 0 0 10px rgba(16, 185, 129, 0.3);
}
.btn-cyber-download:hover {
  background: linear-gradient(135deg, #059669, #047857);
  box-shadow: 0 0 15px rgba(16, 185, 129, 0.5);
}
.btn-cyber-download:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.node-field { margin-bottom: 14px; }
.node-field label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
.code-display {
  background: #020617; border: 1px dashed rgba(255, 255, 255, 0.15); padding: 12px; border-radius: 6px;
  font-size: 13px; word-break: break-all; font-family: monospace;
}
.text-green { color: #34d399; font-weight: bold; }
.text-cyan { color: #38bdf8; }
.btn-group { display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }

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
.btn-unban { background: #059669; color: white; font-weight: 600; }
.btn-demote { background: #475569; color: #fff; }
.btn-del { background: #b91c1c; color: white; }
.btn-del:disabled, .btn-demote:disabled { opacity: 0.3; cursor: not-allowed; }

.btn-link-action {
  background: transparent;
  border: none;
  color: #38bdf8;
  font-size: 11px;
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
}
.btn-link-action:hover { color: #7dd3fc; }

.auth-box { max-width: 420px; margin: 40px auto; }
.form-item { margin-bottom: 16px; }
.form-item label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
.auth-nav-links { display: flex; justify-content: space-between; margin-top: 16px; font-size: 13px; }
.auth-nav-links a { color: #38bdf8; text-decoration: none; }
.auth-nav-links a.text-warning { color: #f59e0b; }
.auth-nav-links a:hover { text-decoration: underline; }
.gen-form { display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: 10px; align-items: flex-end; }
</style>