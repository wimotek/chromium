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
                <span class="data-val">{{ formatLimit(currentUser.limit_mb) }}</span>
                <span class="data-unit">总额</span>
              </div>
            </div>
            <div class="progress-track">
              <div class="progress-glow" :style="{ width: trafficPercent + '%' }"></div>
            </div>
            <div class="expiry-notice">
              <span>套餐有效期：</span>
              <strong class="highlight-date">
                {{ formatExpire(currentUser.expire_date) }}
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

        <!-- 用户通知偏好与安全设置 -->
        <div class="cyber-card col-span-2">
          <div class="card-header">
            <h3>🔔 告警通知偏好与安全中心</h3>
          </div>
          <div class="settings-2col-layout">
            <div class="panel-card">
              <h4>1. 到期与流量微信/邮件通知设置</h4>
              <div class="form-item">
                <label>首选通知通道 (默认邮件)</label>
                <div class="radio-group">
                  <label class="radio-label">
                    <input type="radio" value="email" v-model="notifyForm.notify_type" /> 📧 电子邮箱通知 ({{ currentUser.email || '未绑定邮箱' }})
                  </label>
                  <label class="radio-label">
                    <input type="radio" value="serverchan" v-model="notifyForm.notify_type" /> 📲 Server酱 (微信服务号即时推送)
                  </label>
                </div>
              </div>

              <div class="form-item" v-if="notifyForm.notify_type === 'serverchan'">
                <label>Server酱 SendKey：</label>
                <input v-model="notifyForm.serverchan_key" type="text" class="cyber-input font-mono" placeholder="SCTxxxxxxxxxx" />
                <div class="input-hint">
                  💡 未申请过？前往 <a href="https://sct.ftqq.com/" target="_blank" class="cyber-link">Server酱官网</a> 微信扫码获取 SendKey。
                </div>
              </div>

              <div class="btn-group" style="margin-top: 15px;">
                <button class="btn-cyber-success" @click="saveNotifySettings">保存通知设置</button>
                <button class="btn-cyber-action" @click="testUserNotify">发送测试通知</button>
              </div>
            </div>

            <div class="panel-card">
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
              <button class="btn-cyber-primary" style="margin-top: 5px;" @click="submitChangePassword">确认变更密码</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 3. 管理员控制台：全屏动态自适应 -->
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
              <div class="tab-title">系统发信与全局运维配置</div>
              <div class="tab-sub">节点域名、发信配置、巡检预警与个人通知</div>
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
                    <div style="white-space: nowrap;">{{ u.used_mb }} / {{ formatLimit(u.traffic_limit_mb) }}</div>
                    <div class="table-progress"><div class="table-glow" :style="{ width: calcProgress(u.used_mb, u.traffic_limit_mb) + '%' }"></div></div>
                  </td>
                  <td style="white-space: nowrap;">{{ formatExpire(u.expire_date) }}</td>
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

        <!-- 主选项卡 2: 卡密管理 -->
        <div v-else-if="activeTab === 'cards'" class="cyber-card tab-content-card">
          <div class="sub-tab-nav">
            <button class="sub-tab-btn" :class="{ active: cardSubTab === 'inventory' }" @click="cardSubTab = 'inventory'">
              📦 卡密制卡与库存管理
            </button>
            <button class="sub-tab-btn" :class="{ active: cardSubTab === 'api' }" @click="cardSubTab = 'api'">
              🔌 API自动发卡
            </button>
          </div>

          <!-- 子卡 A: 批量制卡与库存 -->
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
                    <td style="white-space: nowrap;">{{ formatCardQuota(c.traffic_gb, c.days) }}</td>
                    <td>
                      <span class="badge" :class="c.is_used ? 'badge-used' : 'badge-ready'">
                        {{ c.is_used ? '已核销' : '待售出/有效' }}
                      </span>
                    </td>
                    <td class="text-muted" style="white-space: nowrap;">{{ c.created_at || '早期生成' }}</td>
                    <td>{{ c.used_by || '-' }}</td>
                    <td><button class="btn-sm btn-action" @click="copyText(c.code)">一键复制</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 子卡 B: API 自动发卡 -->
          <div v-else-if="cardSubTab === 'api'" class="sub-tab-pane">
            <div class="panel-card">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid #1e293b; padding-bottom: 10px;">
                <h4 style="margin: 0; font-size: 16px; color: #38bdf8;">🔌 API自动发卡</h4>
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

        <!-- 主选项卡 3: 系统与发信设置 (双列平铺 + 黄金比例宽度输入框) -->
        <div v-else-if="activeTab === 'settings'" class="cyber-card tab-content-card">
          <div class="card-header" style="margin-bottom: 22px;">
            <h3>⚙️ 系统发信、节点连接与全局运维中枢</h3>
            <button class="btn-cyber-success" @click="saveAllSettings">💾 保存全部系统设置</button>
          </div>

          <!-- 双列并排平铺网格 -->
          <div class="settings-2col-layout">
            <!-- 栏目 1 (左列): 管理员个人偏好与定时巡检任务 -->
            <div class="column-stack">
              <!-- 左卡片 A: 管理员通知与安全中心 -->
              <div class="panel-card">
                <div class="panel-card-header">
                  <div class="panel-title-wrap">
                    <span class="panel-icon">👤</span>
                    <div>
                      <strong class="panel-title">管理员通知通道与改密</strong>
                      <div class="panel-sub">当前登录管理员: <b>{{ currentUser.username }}</b></div>
                    </div>
                  </div>
                </div>

                <div class="form-item">
                  <label>告警通知通道选择</label>
                  <div class="radio-group">
                    <label class="radio-label">
                      <input type="radio" value="email" v-model="notifyForm.notify_type" />
                      📧 电子邮箱接收 ({{ currentUser.email || '未绑定邮箱' }})
                    </label>
                    <label class="radio-label">
                      <input type="radio" value="serverchan" v-model="notifyForm.notify_type" />
                      📲 Server酱 (微信即时推送)
                    </label>
                  </div>
                </div>

                <div class="form-item" v-if="notifyForm.notify_type === 'serverchan'">
                  <label>Server酱 SendKey：</label>
                  <input v-model="notifyForm.serverchan_key" type="text" class="cyber-input font-mono" placeholder="SCTxxxxxxxxxx" />
                  <div class="input-hint">
                    💡 前往 <a href="https://sct.ftqq.com/" target="_blank" class="cyber-link">Server酱官网</a> 微信扫码获取 SendKey。
                  </div>
                </div>

                <div class="btn-group" style="margin-top: 14px;">
                  <button class="btn-cyber-success" style="padding: 6px 14px; font-size: 12px;" @click="saveNotifySettings">保存通知设置</button>
                  <button class="btn-cyber-action" style="padding: 6px 14px; font-size: 12px;" @click="testUserNotify">发送测试通知</button>
                </div>

                <!-- 管理员改密 -->
                <div class="inner-divider">
                  <div class="inner-divider-title">🔑 修改管理员自身登录密码</div>
                  <div class="form-item" style="margin-bottom: 8px;">
                    <input v-model="pwdForm.old_pwd" type="password" class="cyber-input" placeholder="输入当前原密码" />
                  </div>
                  <div class="form-item" style="margin-bottom: 8px;">
                    <input v-model="pwdForm.new_pwd" type="password" class="cyber-input" placeholder="设置新密码 (至少6位)" />
                  </div>
                  <div class="form-item" style="margin-bottom: 12px;">
                    <input v-model="pwdForm.confirm_pwd" type="password" class="cyber-input" placeholder="再次确认新密码" />
                  </div>
                  <button class="btn-cyber-primary" style="width: auto; padding: 7px 20px; font-size: 12px;" @click="submitChangePassword">确认变更密码</button>
                </div>
              </div>

              <!-- 左卡片 B: 定时自动巡检任务 -->
              <div class="panel-card">
                <div class="panel-card-header">
                  <div class="panel-title-wrap">
                    <span class="panel-icon">⏰</span>
                    <div>
                      <strong class="panel-title">定时巡检与智能预警</strong>
                      <div class="panel-sub">后台自动定时轮询全站用户配额与到期时限</div>
                    </div>
                  </div>
                  <label class="radio-label" style="font-weight: 600; font-size: 13px; margin: 0; white-space: nowrap;">
                    <input type="checkbox" v-model="settingsForm.task_notify_enable" />
                    <span :style="{ color: settingsForm.task_notify_enable ? '#10b981' : '#ef4444' }">
                      {{ settingsForm.task_notify_enable ? '🟢 巡检中' : '🔴 已暂停' }}
                    </span>
                  </label>
                </div>

                <div class="form-item">
                  <label>轮询检测执行周期 (小时)</label>
                  <div class="input-with-addon">
                    <input v-model.number="settingsForm.task_interval_hours" type="number" class="cyber-input" placeholder="12" />
                    <span class="addon-text">小时 / 次</span>
                  </div>
                  <span class="input-hint">建议设为 12 或 24 小时</span>