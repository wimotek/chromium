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
        <!-- 登录页系统公告展示栏 -->
        <div v-if="systemNotice" class="cyber-notice-card">
          <div class="notice-header">
            <span class="notice-icon">📢</span>
            <strong>系统公告 NOTICE</strong>
          </div>
          <div class="notice-body">{{ systemNotice }}</div>
        </div>

        <div class="cyber-card auth-box">
          <h2 class="card-title">{{ authCardTitle }}</h2>

          <!-- A. 登录 -->
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

          <!-- B. 注册 -->
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

          <!-- C. 找回密码 -->
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

      <!-- 2. 普通用户端：多节点集群中心 -->
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
              <span v-if="currentUser.is_monthly === 1" class="monthly-tag">🔄 每月 {{ currentUser.reset_day }} 号重置</span>
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

        <!-- 多节点选择与通用订阅 -->
        <div class="cyber-card col-span-2">
          <div class="card-header">
            <h3>🌐 全球加速节点列表与通用订阅 (共 {{ currentUser.nodes ? currentUser.nodes.length : 0 }} 个节点)</h3>
            <button class="btn-cyber-primary" style="font-size: 12px; padding: 6px 14px; width: auto;" @click="copyText(currentUser.sub_url)">
              🔗 一键复制全节点通用订阅链接
            </button>
          </div>

          <p class="card-desc">
            支持直接将订阅链接导入 <b>v2rayN / Clash-Meta / Sing-box / Shadowrocket</b>，客户端内可批量更新并自动延迟测速：
          </p>

          <div class="node-grid">
            <div v-for="node in currentUser.nodes" :key="node.id" class="node-card">
              <div class="node-header">
                <span class="node-title">{{ node.name }}</span>
                <span class="badge badge-ready">🟢 在线加速</span>
              </div>
              <div class="node-detail">
                <span>地址: {{ node.ip }}:{{ node.port }}</span>
              </div>
              <div class="btn-group" style="margin-top: 12px; gap: 6px;">
                <button class="btn-sm btn-action" @click="copyText(node.link)">📋 复制节点</button>
                <button class="btn-sm btn-edit" @click="openQrModal(node.link, node.name)">📱 扫码</button>
                <button class="btn-sm btn-cyber-download" @click="downloadWindowsClient(node.id, node.name)">🖥️ 下载客户端</button>
              </div>
            </div>

            <div v-if="!currentUser.nodes || currentUser.nodes.length === 0" class="empty-node-tip">
              暂无在线节点，请等待管理员启动接入远程海外节点。
            </div>
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
                    <input type="radio" value="email" v-model="notifyForm.notify_type" /> 📧 电子邮箱通知 ({{ currentUser.email || '未绑定' }})
                  </label>
                  <label class="radio-label">
                    <input type="radio" value="serverchan" v-model="notifyForm.notify_type" /> 📲 Server酱 (微信推送)
                  </label>
                </div>
              </div>

              <div class="form-item" v-if="notifyForm.notify_type === 'serverchan'">
                <label>Server酱 SendKey：</label>
                <input v-model="notifyForm.serverchan_key" type="text" class="cyber-input font-mono" placeholder="SCTxxxxxxxxxx" />
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

          <button class="tab-card-btn" :class="{ active: activeTab === 'nodes' }" @click="openNodesTab">
            <span class="tab-icon">🌐</span>
            <div class="tab-text">
              <div class="tab-title">远程节点 (xray_core) 集群</div>
              <div class="tab-sub">自动生成密钥、公钥回传、一键重置与别名维护</div>
            </div>
            <span class="count-tag">{{ adminNodes.length }} 个节点</span>
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
              <div class="tab-sub">公告设置、SMTP 配置、巡检预警与个人通知</div>
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
                  <th>套餐特性</th>
                  <th>通知通道</th>
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
                    <div style="white-space: nowrap;">{{ u.used_mb }} / {{ u.traffic_limit_mb === 0 ? '♾️ 不限' : u.traffic_limit_mb + ' MB' }}</div>
                    <div class="table-progress"><div class="table-glow" :style="{ width: calcProgress(u.used_mb, u.traffic_limit_mb) + '%' }"></div></div>
                  </td>
                  <td style="white-space: nowrap;">{{ (u.expire_date && u.expire_date.startsWith('2099')) ? '♾️ 永久有效' : u.expire_date }}</td>
                  <td>
                    <span v-if="u.is_monthly === 1" class="badge badge-monthly">每月{{ u.reset_day }}号重置</span>
                    <span v-else class="text-muted" style="font-size: 11px;">普通固定</span>
                  </td>
                  <td><span class="role-badge user">{{ u.notify_type }}</span></td>
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

        <!-- 主选项卡 2: 远程节点集群管理 -->
        <div v-else-if="activeTab === 'nodes'" class="cyber-card tab-content-card">
          <div class="card-header">
            <h3>🌐 已接入的远程 xray_core 节点集群</h3>
            <button class="btn-cyber-refresh" @click="openNodesTab">🔄 刷新节点</button>
          </div>

          <div class="table-container">
            <table class="cyber-table">
              <thead>
                <tr>
                  <th>节点名称</th>
                  <th>通信密钥 (Node Key)</th>
                  <th>IP / 端口</th>
                  <th>REALITY 公钥 (自动回传)</th>
                  <th>ShortId</th>
                  <th>心跳在线状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="n in adminNodes" :key="n.id">
                  <td>
                    <input v-model="n.name" class="cyber-input" style="width: 150px; padding: 4px 8px;" />
                  </td>
                  <td>
                    <span class="font-mono" style="font-size: 11px; color: #f59e0b;">{{ n.node_key }}</span>
                    <div v-if="n.pending_key" style="font-size: 10px; color: #38bdf8;">(重置待生效: {{ n.pending_key.substring(0, 8) }}...)</div>
                  </td>
                  <td style="white-space: nowrap;">{{ n.ip }}:{{ n.port }}</td>
                  <td class="font-mono text-green" style="font-size: 11px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" :title="n.pbk">{{ n.pbk }}</td>
                  <td class="font-mono text-cyan">{{ n.sid }}</td>
                  <td style="white-space: nowrap;">
                    <span class="badge badge-ready">🟢 在线 ({{ n.last_heartbeat }})</span>
                  </td>
                  <td>
                    <div class="action-btn-row">
                      <button class="btn-sm btn-action" @click="saveNodeName(n)">保存名称</button>
                      <button class="btn-sm btn-reset" @click="resetNodeKey(n)">🔑 重置密钥</button>
                      <button class="btn-sm btn-del" @click="deleteNode(n.node_id)">移除</button>
                    </div>
                  </td>
                </tr>
                <tr v-if="adminNodes.length === 0">
                  <td colspan="7" style="text-align: center; color: #64748b; padding: 25px;">
                    暂无远程节点接入，只需在任意海外 VPS 运行下方单变量命令拉起即可！
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="panel-card" style="margin-top: 25px;">
            <h4 style="margin: 0 0 10px 0; color: #38bdf8;">🖥️ 海外 VPS 极简单变量接入指令 (NODE_KEY 无需填写)</h4>
            <p class="card-desc">在任意香港、日本或美国 VPS 执行即可，节点启动时<b>自动生成专属密钥与公钥</b>并回传登记到本面板：</p>
            <div class="node-field">
              <div class="code-display text-cyan">
                docker run -d --name xray-node --network host --restart always -e PANEL_URL="http://{{ publicMasterHost }}:3000" -v $(pwd)/data:/data wimotek/xray:core
              </div>
            </div>
            <button class="btn-sm btn-action" @click="copyText(`docker run -d --name xray-node --network host --restart always -e PANEL_URL='http://${publicMasterHost}:3000' -v $(pwd)/data:/data wimotek/xray:core`)">
              📋 复制极简单变量运行命令
            </button>
          </div>
        </div>

        <!-- 主选项卡 3: 卡密管理 -->
        <div v-else-if="activeTab === 'cards'" class="cyber-card tab-content-card">
          <div class="sub-tab-nav">
            <button class="sub-tab-btn" :class="{ active: cardSubTab === 'inventory' }" @click="cardSubTab = 'inventory'">
              📦 卡密制卡与库存管理
            </button>
            <button class="sub-tab-btn" :class="{ active: cardSubTab === 'api' }" @click="cardSubTab = 'api'">
              🔌 API自动发卡
            </button>
          </div>

          <div v-if="cardSubTab === 'inventory'" class="sub-tab-pane">
            <div class="card-header"><h3>🛠️ 批量生成卡密</h3></div>
            <div class="gen-form">
              <div>
                <label>流量配额 (GB, 0为不限)</label>
                <input v-model.number="cardGenForm.traffic_gb" type="number" class="cyber-input" placeholder="0=不限" />
              </div>
              <div>
                <label>有效时限 (天, 36500为永久)</label>
                <input v-model.number="cardGenForm.days" type="number" class="cyber-input" placeholder="36500=永久" />
              </div>
              <div>
                <label>批量制卡数 (张)</label>
                <input v-model.number="cardGenForm.count" type="number" class="cyber-input" />
              </div>
              <div style="display: flex; flex-direction: column; justify-content: flex-end;">
                <label class="radio-label" style="margin-bottom: 8px;">
                  <input type="checkbox" v-model="cardGenForm.is_monthly" /> 设为每月固定重置卡
                </label>
                <button class="btn-cyber-success" @click="generateCards">立即批量制卡</button>
              </div>
            </div>

            <div class="card-header" style="margin-top: 30px;">
              <h3>📦 历史卡密库存与核销流水 (最新200条)</h3>
              <button class="btn-cyber-refresh" @click="loadAdminData">🔄 刷新列表</button>
            </div>

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
                    <th style="width: 40px; text-align: center;"><input type="checkbox" :checked="isAllSelected" @change="toggleSelectAll" title="全选未售卡密" /></th>
                    <th>卡密编号</th>
                    <th>套餐配额</th>
                    <th>套餐属性</th>
                    <th>核销状态</th>
                    <th>生成日期</th>
                    <th>兑换用户</th>
                    <th>单张操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="c in adminCards" :key="c.code">
                    <td style="text-align: center;"><input type="checkbox" :value="c.code" v-model="selectedCards" /></td>
                    <td class="font-mono text-cyan">{{ c.code }}</td>
                    <td style="white-space: nowrap;">{{ c.traffic_gb === 0 ? '♾️ 不限' : c.traffic_gb + ' GB' }} / {{ c.days >= 3650 ? '永久' : c.days + ' 天' }}</td>
                    <td>
                      <span v-if="c.is_monthly === 1" class="badge badge-monthly">每月重置</span>
                      <span v-else class="text-muted" style="font-size: 11px;">普通固定</span>
                    </td>
                    <td><span class="badge" :class="c.is_used ? 'badge-used' : 'badge-ready'">{{ c.is_used ? '已核销' : '待售/有效' }}</span></td>
                    <td class="text-muted" style="white-space: nowrap;">{{ c.created_at || '早期' }}</td>
                    <td>{{ c.used_by || '-' }}</td>
                    <td><button class="btn-sm btn-action" @click="copyText(c.code)">复制</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

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

              <div class="form-item">
                <label>API 通信验证 TOKEN (密钥)：</label>
                <div style="display: flex; gap: 8px;">
                  <input v-model="settingsForm.faka_api_token" type="text" class="cyber-input font-mono" placeholder="自定义出卡令牌" />
                  <button class="btn-sm btn-action" @click="generateRandomToken">🎲 随机</button>
                  <button class="btn-sm btn-cyber-success" @click="saveAllSettings">保存</button>
                </div>
              </div>

              <div class="node-field" style="margin-top: 18px;">
                <label>独角数卡发卡调用 URL (GET / POST)：</label>
                <div class="code-display text-cyan">{{ fakaApiUrlSample }}</div>
              </div>

              <button class="btn-cyber-action" style="margin-top: 10px;" @click="copyText(fakaApiUrlSample)">复制 API 完整调用地址</button>
            </div>
          </div>
        </div>

        <!-- 主选项卡 4: 系统设置 -->
        <div v-else-if="activeTab === 'settings'" class="cyber-card tab-content-card">
          <div class="card-header" style="margin-bottom: 22px;">
            <h3>⚙️ 系统发信、定时巡检与全局设置</h3>
            <button class="btn-cyber-success" @click="saveAllSettings">💾 保存系统设置</button>
          </div>

          <div class="settings-2col-layout">
            <div class="column-stack">
              <div class="panel-card">
                <div class="panel-card-header">
                  <div class="panel-title-wrap"><span class="panel-icon">📢</span><strong class="panel-title">系统公告与新用户默认配额</strong></div>
                </div>
                <div class="form-item">
                  <label>登录页系统公告内容 (留空不显示)：</label>
                  <textarea v-model="settingsForm.system_notice" rows="3" class="cyber-input cyber-textarea" placeholder="例如：全节点已完成维护，极速晚高峰..."></textarea>
                </div>
                <div class="form-row-2" style="margin-top: 15px;">
                  <div class="form-item">
                    <label>新注册默认流量 (MB)</label>
                    <input v-model.number="settingsForm.reg_traffic_mb" type="number" class="cyber-input" placeholder="1024" />
                  </div>
                  <div class="form-item">
                    <label>新注册有效天数 (天)</label>
                    <input v-model.number="settingsForm.reg_expire_days" type="number" class="cyber-input" placeholder="1" />
                  </div>
                </div>
              </div>

              <div class="panel-card">
                <div class="panel-card-header">
                  <div class="panel-title-wrap"><span class="panel-icon">👤</span><strong class="panel-title">管理员通知通道与改密</strong></div>
                </div>
                <div class="form-item">
                  <label>告警通道选择</label>
                  <div class="radio-group">
                    <label class="radio-label"><input type="radio" value="email" v-model="notifyForm.notify_type" /> 📧 电子邮箱接收</label>
                    <label class="radio-label"><input type="radio" value="serverchan" v-model="notifyForm.notify_type" /> 📲 Server酱 (微信推送)</label>
                  </div>
                </div>
                <div class="form-item" v-if="notifyForm.notify_type === 'serverchan'">
                  <label>Server酱 SendKey：</label>
                  <input v-model="notifyForm.serverchan_key" type="text" class="cyber-input font-mono" placeholder="SCTxxxxxxxxxx" />
                </div>
                <div class="btn-group" style="margin-top: 14px;">
                  <button class="btn-cyber-success" style="padding: 6px 14px; font-size: 12px;" @click="saveNotifySettings">保存通知偏好</button>
                  <button class="btn-cyber-action" style="padding: 6px 14px; font-size: 12px;" @click="testUserNotify">测试通知</button>
                </div>
                <div class="inner-divider">
                  <div class="inner-divider-title">🔑 修改管理员自身登录密码</div>
                  <div class="form-item" style="margin-bottom: 8px;"><input v-model="pwdForm.old_pwd" type="password" class="cyber-input" placeholder="当前原密码" /></div>
                  <div class="form-item" style="margin-bottom: 8px;"><input v-model="pwdForm.new_pwd" type="password" class="cyber-input" placeholder="新密码" /></div>
                  <div class="form-item" style="margin-bottom: 12px;"><input v-model="pwdForm.confirm_pwd" type="password" class="cyber-input" placeholder="再次确认新密码" /></div>
                  <button class="btn-cyber-primary" style="width: auto; padding: 7px 20px; font-size: 12px;" @click="submitChangePassword">确认变更密码</button>
                </div>
              </div>
            </div>

            <div class="column-stack">
              <div class="panel-card">
                <div class="panel-card-header">
                  <div class="panel-title-wrap"><span class="panel-icon">⏰</span><strong class="panel-title">定时巡检与每月流量重置</strong></div>
                  <label class="radio-label" style="margin: 0;">
                    <input type="checkbox" v-model="settingsForm.task_notify_enable" />
                    <span :style="{ color: settingsForm.task_notify_enable ? '#10b981' : '#ef4444' }">{{ settingsForm.task_notify_enable ? '🟢 运行中' : '🔴 暂停' }}</span>
                  </label>
                </div>
                <div class="form-item">
                  <label>检测周期 (小时)</label>
                  <div class="input-with-addon"><input v-model.number="settingsForm.task_interval_hours" type="number" class="cyber-input" /><span class="addon-text">小时 / 次</span></div>
                </div>
                <div class="form-item">
                  <label>流量不足告警阈值 (%)</label>
                  <div class="input-with-addon"><input v-model.number="settingsForm.task_traffic_threshold" type="number" class="cyber-input" /><span class="addon-text">%</span></div>
                </div>
                <div class="form-item">
                  <label>套餐到期告警阈值 (天)</label>
                  <div class="input-with-addon"><input v-model.number="settingsForm.task_expire_days" type="number" class="cyber-input" /><span class="addon-text">天</span></div>
                </div>
                <div class="inner-divider">
                  <div style="font-size: 12px; color: #94a3b8; margin-bottom: 10px;">最近扫描时间：<b class="text-cyan">{{ settingsForm.task_last_run }}</b></div>
                  <button class="btn-cyber-primary" :disabled="triggeringTask" style="width: auto; padding: 7px 18px; font-size: 12px;" @click="triggerManualTask">
                    {{ triggeringTask ? '扫描中...' : '⚡ 立即执行一次巡检' }}
                  </button>
                </div>
              </div>

              <div class="panel-card">
                <div class="panel-card-header">
                  <div class="panel-title-wrap"><span class="panel-icon">📧</span><strong class="panel-title">SMTP 发信服务器参数配置</strong></div>
                </div>
                <div class="smtp-status-box" :class="settingsForm.is_smtp_configured ? 'smtp-ready' : 'smtp-empty'">
                  <span>{{ settingsForm.is_smtp_configured ? '🟢 SMTP 状态：就绪' : '⚪ SMTP 状态：未配置' }}</span>
                </div>
                <div class="form-item"><label>SMTP 服务器</label><input v-model="settingsForm.smtp_host" type="text" class="cyber-input" placeholder="smtp.qq.com" /></div>
                <div class="form-row-2">
                  <div class="form-item"><label>端口</label><input v-model="settingsForm.smtp_port" type="text" class="cyber-input" placeholder="465" /></div>
                  <div class="form-item"><label>发件人</label><input v-model="settingsForm.smtp_sender" type="text" class="cyber-input" placeholder="Xray 节点中心" /></div>
                </div>
                <div class="form-item"><label>发信账号</label><input v-model="settingsForm.smtp_user" type="text" class="cyber-input" placeholder="service@example.com" /></div>
                <div class="form-item"><label>授权码 / 密码</label><input v-model="settingsForm.smtp_pass" type="password" class="cyber-input" :placeholder="settingsForm.has_smtp_pass ? '●●●●●● (留空保持原密码)' : '输入授权码'" /></div>
                <div class="form-item"><label class="radio-label"><input type="checkbox" v-model="settingsForm.smtp_ssl" /> 启用 SSL 加密</label></div>
                <div class="inner-divider">
                  <div style="display: flex; gap: 8px;">
                    <input v-model="testEmailTo" type="email" class="cyber-input" placeholder="test@example.com" />
                    <button class="btn-cyber-action" :disabled="testingEmail" style="padding: 6px 14px; font-size: 12px; white-space: nowrap;" @click="sendTestEmail">{{ testingEmail ? '...' : '发信测试' }}</button>
                  </div>
                </div>
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
          <input v-model.number="editForm.limit_mb" type="number" class="cyber-input modal-input" />
        </div>
        <div class="form-item">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <label style="margin: 0;">套餐到期时限</label>
            <button class="btn-link-action" @click="editForm.expire_date = '2099-12-31 23:59:59'">♾️ 设为永久有效</button>
          </div>
          <input v-model="editForm.expire_date" type="text" class="cyber-input modal-input" />
        </div>
        <div class="form-item">
          <label class="radio-label"><input type="checkbox" v-model="editForm.is_monthly" /> 开启每月固定重置流量套餐</label>
        </div>
        <div class="form-item" v-if="editForm.is_monthly">
          <label>每月重置日期 (1~28 号)</label>
          <input v-model.number="editForm.reset_day" type="number" min="1" max="28" class="cyber-input modal-input" />
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
          <label>新密码</label>
          <input v-model="resetNewPassword" type="text" class="cyber-input modal-input" placeholder="输入新密码" />
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
const cardSubTab = ref('inventory')

const authMode = ref('login')
const countdown = ref(0)
const sendingCode = ref(false)
const downloadingClient = ref(false)
const systemNotice = ref('')

const showQrModal = ref(false)
const targetModalUser = ref('')
const targetModalLink = ref('')

const showEditModal = ref(false)
const editForm = reactive({ username: '', limit_mb: 1024, expire_date: '', is_monthly: false, reset_day: 1 })

const showResetPwdModal = ref(false)
const resetTargetUser = ref('')
const resetNewPassword = ref('')

const currentUser = reactive({ username: '', email: '', role: '', used_mb: 0, limit_mb: 0, expire_date: '', is_monthly: 0, reset_day: 1, sub_url: '', nodes: [] })
const authForm = reactive({ username: '', email: '', code: '', password: '' })
const forgotForm = reactive({ email: '', code: '', new_password: '' })
const cardGenForm = reactive({ traffic_gb: 50, days: 30, count: 5, is_monthly: false })
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
  system_notice: '',
  reg_traffic_mb: 1024,
  reg_expire_days: 1
})

const testEmailTo = ref('')
const testingEmail = ref(false)
const triggeringTask = ref(false)

const adminCards = ref([])
const adminUsers = ref([])
const adminNodes = ref([])

onMounted(async () => {
  const savedSession = localStorage.getItem('xray_auth_session')
  if (savedSession) {
    try {
      const parsed = JSON.parse(savedSession)
      if (parsed.user && parsed.user.username) {
        Object.assign(currentUser, parsed.user)
        authForm.username = parsed.user.username
        authForm.password = parsed.password || ''
        notifyForm.notify_type = parsed.user.notify_type || 'email'
        notifyForm.serverchan_key = parsed.user.serverchan_key || ''
        if (currentUser.role === 'admin') {
          loadAdminData()
          openNodesTab()
        }
      }
    } catch (_) {
      localStorage.removeItem('xray_auth_session')
    }
  }

  try {
    const res = await axios.get('/api/system/info')
    if (res.data.data.mode === 'admin') isPureAdmin.value = true
    if (res.data.data.system_notice) systemNotice.value = res.data.data.system_notice
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
  return `${host}/api/open/faka_generate?gb=100&days=30&is_monthly=1&token=${token}`
})

const publicMasterHost = computed(() => window.location.hostname)

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
  for (let i = 0; i < 20; i++) token += chars.charAt(Math.floor(Math.random() * chars.length))
  settingsForm.faka_api_token = token
  ElMessage.success('已随机生成新出卡 Token')
}

// 导出底层
const executeExport = async (payload, successTip) => {
  try {
    const adminUser = currentUser.username || authForm.username
    const res = await axios.post('/api/admin/cards/export_unused', {
      admin_user: adminUser,
      admin_pwd: authForm.password,
      ...payload
    })
    if (res.data.code === 200) {
      if (res.data.count === 0) return ElMessage.warning('暂无可导出的未核销卡密')
      copyText(res.data.text)
      ElMessage.success(`${successTip}（共 ${res.data.count} 张）`)
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('导出失败')
  }
}

// 唯一保留：勾选导出
const exportSelectedCards = () => {
  if (selectedCards.value.length === 0) return ElMessage.warning('请先在表格左侧勾选要导出的卡密')
  executeExport({ selected_codes: selectedCards.value }, '已复制选中的卡密')
}

// 唯一保留：日期范围导出
const exportByDateRange = () => {
  if (!exportFilter.startDate && !exportFilter.endDate) return ElMessage.warning('请先选择日期范围')
  executeExport({ start_date: exportFilter.startDate, end_date: exportFilter.endDate }, '已导出指定日期范围内的未售卡密')
}

// 唯一保留：全部未售导出
const exportAllUnusedCards = () => executeExport({}, '已复制全部未售卡密')

const startCountdown = () => {
  countdown.value = 60
  const timer = setInterval(() => {
    countdown.value--
    if (countdown.value <= 0) clearInterval(timer)
  }, 1000)
}

const sendRegisterCode = async () => {
  if (!authForm.email || !authForm.email.includes('@')) return ElMessage.warning('请输入合法电子邮箱')
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
    ElMessage.error('验证码发送失败')
  } finally {
    sendingCode.value = false
  }
}

const sendForgotCode = async () => {
  if (!forgotForm.email || !forgotForm.email.includes('@')) return ElMessage.warning('请输入绑定的注册邮箱')
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
    ElMessage.error('请求失败')
  } finally {
    sendingCode.value = false
  }
}

const submitForgotPassword = async () => {
  if (!forgotForm.email || !forgotForm.code || !forgotForm.new_password) return ElMessage.warning('请填写完整重置信息')
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
    ElMessage.error('重置失败')
  } finally {
    loading.value = false
  }
}

const openQrModal = (link, uname) => {
  if (!link) return ElMessage.warning('节点连接无效')
  targetModalUser.value = uname
  targetModalLink.value = link
  showQrModal.value = true
}

const openEditModal = (u) => {
  editForm.username = u.username
  editForm.limit_mb = u.traffic_limit_mb
  editForm.expire_date = u.expire_date
  editForm.is_monthly = u.is_monthly === 1
  editForm.reset_day = u.reset_day || 1
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
    ElMessage.error('重置失败')
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
      expire_date: editForm.expire_date,
      is_monthly: editForm.is_monthly,
      reset_day: editForm.reset_day
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
    ElMessage.error('操作异常')
  }
}

const handleDeleteUser = async (targetUser) => {
  if (!confirm(`⚠️ 警告：确定要彻底删除用户 [${targetUser}] 吗？`)) return
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
    ElMessage.error('删除失败')
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
      const session = JSON.parse(localStorage.getItem('xray_auth_session') || '{}')
      if (session.user) {
        session.user.notify_type = notifyForm.notify_type
        session.user.serverchan_key = notifyForm.serverchan_key
        localStorage.setItem('xray_auth_session', JSON.stringify(session))
      }
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('保存失败')
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
  if (!pwdForm.old_pwd || !pwdForm.new_pwd) return ElMessage.warning('请输入密码')
  if (pwdForm.new_pwd !== pwdForm.confirm_pwd) return ElMessage.warning('两次密码不一致')
  try {
    const res = await axios.post('/api/user/change_password', {
      username: currentUser.username,
      old_password: pwdForm.old_pwd,
      new_password: pwdForm.new_pwd
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      localStorage.removeItem('xray_auth_session')
      setTimeout(() => location.reload(), 1500)
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('改密失败')
  }
}

const downloadWindowsClient = (nodeId = '', nodeName = '') => {
  if (!currentUser.username) return ElMessage.warning('用户未就绪')
  ElMessage.info(`正在为您打包 ${nodeName || '默认节点'} 的 Windows 开箱即用客户端...`)

  const downloadUrl = `/api/user/download_client?username=${encodeURIComponent(currentUser.username)}&node_id=${nodeId}`
  const a = document.createElement('a')
  a.href = downloadUrl
  a.download = `Xray_Windows_${currentUser.username}.zip`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

const openNodesTab = async () => {
  activeTab.value = 'nodes'
  try {
    const adminUser = currentUser.username || authForm.username
    const res = await axios.post('/api/admin/nodes/list', {
      admin_user: adminUser,
      admin_pwd: authForm.password
    })
    if (res.data.code === 200) {
      adminNodes.value = res.data.data
    }
  } catch (_) {}
}

const saveNodeName = async (node) => {
  try {
    const adminUser = currentUser.username || authForm.username
    const res = await axios.post('/api/admin/nodes/edit', {
      admin_user: adminUser,
      admin_pwd: authForm.password,
      node_id: node.node_id,
      name: node.name,
      status: node.status
    })
    if (res.data.code === 200) {
      ElMessage.success('节点别名保存成功')
      openNodesTab()
    }
  } catch (_) {
    ElMessage.error('保存失败')
  }
}

const resetNodeKey = async (node) => {
  if (!confirm(`确定要重置节点 [${node.name}] 的通信密钥 (Node Key) 吗？\n重置后节点将在 60 秒内通过心跳自动同步新密钥。`)) return
  try {
    const adminUser = currentUser.username || authForm.username
    const res = await axios.post('/api/admin/nodes/reset_key', {
      admin_user: adminUser,
      admin_pwd: authForm.password,
      node_id: node.node_id
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      openNodesTab()
    } else {
      ElMessage.error(res.data.msg)
    }
  } catch (_) {
    ElMessage.error('重置密钥失败')
  }
}

const deleteNode = async (nodeId) => {
  if (!confirm('确定要从集群中移除该节点吗？')) return
  try {
    const adminUser = currentUser.username || authForm.username
    const res = await axios.post('/api/admin/nodes/delete', {
      admin_user: adminUser,
      admin_pwd: authForm.password,
      node_id: nodeId
    })
    if (res.data.code === 200) {
      ElMessage.success('节点已成功移除')
      openNodesTab()
    }
  } catch (_) {
    ElMessage.error('移除失败')
  }
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
      settingsForm.system_notice = d.system_notice || ''
      settingsForm.reg_traffic_mb = Number(d.reg_traffic_mb) || 1024
      settingsForm.reg_expire_days = Number(d.reg_expire_days) || 1
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
      systemNotice.value = settingsForm.system_notice
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
    ElMessage.error('发信异常')
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
    ElMessage.error('复制失败，请手动选择复制')
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

        localStorage.setItem('xray_auth_session', JSON.stringify({
          user: res.data.data,
          password: authForm.password
        }))

        if (currentUser.role === 'admin') {
          loadAdminData()
          openNodesTab()
        }
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

const logout = () => {
  localStorage.removeItem('xray_auth_session')
  location.reload()
}
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

/* 节点卡片流式网格 */
.node-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  margin-top: 15px;
}
.node-card {
  background: #0b1120;
  border: 1px solid #1e293b;
  border-radius: 8px;
  padding: 16px;
  transition: all 0.2s;
}
.node-card:hover {
  border-color: #38bdf8;
  box-shadow: 0 0 15px rgba(56, 189, 248, 0.15);
}
.node-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.node-title {
  font-weight: 700;
  font-size: 14px;
  color: #f1f5f9;
}
.node-detail {
  font-size: 12px;
  color: #64748b;
  font-family: monospace;
}
.empty-node-tip {
  grid-column: 1 / -1;
  text-align: center;
  padding: 30px;
  color: #64748b;
  font-size: 13px;
}

.cyber-notice-card {
  max-width: 420px;
  margin: 0 auto 16px auto;
  background: rgba(56, 189, 248, 0.08);
  border: 1px solid rgba(56, 189, 248, 0.3);
  border-radius: 8px;
  padding: 12px 16px;
  box-shadow: 0 0 15px rgba(56, 189, 248, 0.15);
}
.notice-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #38bdf8;
  margin-bottom: 6px;
}
.notice-body {
  font-size: 12px;
  color: #cbd5e1;
  line-height: 1.6;
  white-space: pre-wrap;
}

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

.settings-2col-layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  align-items: start;
}
.column-stack {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
@media (max-width: 1024px) {
  .settings-2col-layout {
    grid-template-columns: 1fr;
    gap: 16px;
  }
}

.panel-card {
  background: #0b1120;
  border: 1px solid #1e293b;
  border-radius: 10px;
  padding: 20px;
}
.panel-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  border-bottom: 1px solid #1e293b;
  padding-bottom: 10px;
}
.panel-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}
.panel-icon { font-size: 22px; flex-shrink: 0; }
.panel-title { font-size: 14px; color: #f1f5f9; font-weight: 700; }
.panel-sub { font-size: 11px; color: #64748b; margin-top: 2px; }

.inner-divider {
  border-top: 1px dashed #1e293b;
  margin-top: 16px;
  padding-top: 14px;
}
.inner-divider-title {
  font-size: 13px;
  font-weight: 700;
  color: #f1f5f9;
  margin-bottom: 10px;
}
.input-with-addon {
  display: flex;
  align-items: center;
  gap: 10px;
}
.addon-text {
  color: #94a3b8;
  font-size: 13px;
  white-space: nowrap;
}
.form-row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  max-width: 520px;
}

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
.date-input { width: 140px; padding: 6px 10px; font-size: 12px; }
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
.expiry-notice { font-size: 13px; color: #94a3b8; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.highlight-date { color: #f59e0b; }

.monthly-tag {
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid rgba(56, 189, 248, 0.4);
}

.cyber-input {
  width: 70%;
  min-width: 260px;
  max-width: 500px;
  background: #1e293b;
  border: 1px solid #334155;
  color: #f8fafc;
  padding: 10px 14px;
  border-radius: 6px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.cyber-input:focus { border-color: #38bdf8; box-shadow: 0 0 8px rgba(56, 189, 248, 0.3); }

.cyber-textarea {
  resize: vertical;
  min-height: 70px;
  font-family: inherit;
}

.auth-box .cyber-input,
.modal-input {
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100% !important;
}

.code-send-group {
  display: flex;
  gap: 8px;
  max-width: 500px;
}
.code-send-group .cyber-input {
  flex: 1;
  width: auto;
  min-width: 140px;
}
.btn-cyber-code {
  background: #1e293b; border: 1px solid #38bdf8; color: #38bdf8; border-radius: 6px; padding: 0 14px;
  white-space: nowrap; cursor: pointer; font-size: 12px;
}
.btn-cyber-code:disabled { opacity: 0.5; cursor: not-allowed; border-color: #475569; color: #94a3b8; }

.btn-cyber-primary {
  background: linear-gradient(135deg, #0284c7, #2563eb);
  color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 700; cursor: pointer; width: 100%;
}
.redeem-box {
  display: flex;
  gap: 10px;
  align-items: center;
  max-width: 500px;
}
.redeem-box .cyber-input {
  flex: 1;
  width: auto;
  min-width: 180px;
}
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
  padding: 6px 14px;
  border-radius: 4px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
  font-size: 11px;
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

.radio-group { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
.radio-label { font-size: 13px; color: #cbd5e1; cursor: pointer; display: flex; align-items: center; gap: 8px; }
.input-hint { font-size: 11px; color: #94a3b8; margin-top: 6px; line-height: 1.5; display: block; }
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
.badge-monthly { background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); }
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

.auth-box { max-width: 420px; margin: 0 auto 40px auto; }
.form-item { margin-bottom: 16px; }
.form-item label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
.auth-nav-links { display: flex; justify-content: space-between; margin-top: 16px; font-size: 13px; }
.auth-nav-links a { color: #38bdf8; text-decoration: none; }
.auth-nav-links a.text-warning { color: #f59e0b; }
.auth-nav-links a:hover { text-decoration: underline; }
.gen-form { display: grid; grid-template-columns: 1fr 1fr 1fr 1.2fr; gap: 10px; align-items: flex-end; }

@media (max-width: 640px) {
  .cyber-input {
    width: 100% !important;
    min-width: 0 !important;
    max-width: 100% !important;
  }
  .form-row-2 { grid-template-columns: 1fr; }
  .gen-form { grid-template-columns: 1fr; }
  .node-grid { grid-template-columns: 1fr; }
}
</style>