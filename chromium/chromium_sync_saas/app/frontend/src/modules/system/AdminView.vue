<template>
  <div>
    <!-- 核心运营指标概览 -->
    <div class="grid-4">
      <div class="card">
        <div class="kpi-label">平台净收益 (市场差价 + 自用反穿流量)</div>
        <div class="kpi-val" style="color: #34d399">¥{{ metrics.platform_profit_yuan || '0.00' }}</div>
        <div class="muted mono" style="font-size: 11px; margin-top: 4px">
          租约差价 ¥{{ metrics.lease_profit_yuan || '0.00' }} · 自用反穿 ¥{{ metrics.self_reverse_profit_yuan || '0.00' }}
        </div>
      </div>
      <div class="card">
        <div class="kpi-label">平台总交易流水 (GMV)</div>
        <div class="kpi-val">¥{{ metrics.gmv_yuan || '0.00' }}</div>
      </div>
      <div class="card">
        <div class="kpi-label">已结算卖家分成</div>
        <div class="kpi-val">¥{{ metrics.seller_payout_yuan || '0.00' }}</div>
      </div>
      <div class="card">
        <div class="kpi-label">用户 / 共享节点 / 在租 / 邀请</div>
        <div class="kpi-val">
          {{ metrics.total_users || 0 }} / {{ metrics.shared_nodes || 0 }} / {{ metrics.active_leases || 0 }} / {{ metrics.referral_count || 0 }}
        </div>
      </div>
    </div>

    <!-- 运营管理台分模块导航（按内容分子卡排版） -->
    <div class="subnav">
      <button class="subnav-btn" :class="{ active: activeSection === 'users' }" @click="activeSection = 'users'">
        用户管理 ({{ users.length }})
      </button>
      <button class="subnav-btn" :class="{ active: activeSection === 'rates' }" @click="activeSection = 'rates'">
        定价费率 · 等级与套餐
      </button>
      <button class="subnav-btn" :class="{ active: activeSection === 'growth' }" @click="activeSection = 'growth'">
        注册风控 · 邀请与补贴
      </button>
      <button class="subnav-btn" :class="{ active: activeSection === 'payments' }" @click="activeSection = 'payments'">
        支付网关 (支付宝/微信) & 充值订单
      </button>
      <button class="subnav-btn" :class="{ active: activeSection === 'notifications' }" @click="activeSection = 'notifications'">
        通知渠道 & 系统公告
      </button>
      <button class="subnav-btn" :class="{ active: activeSection === 'governance' }" @click="activeSection = 'governance'">
        租赁风控与引擎
        <span v-if="cacheState === 'degraded'" class="tag tag-danger" style="margin-left: 6px; padding: 1px 6px">缓存降级</span>
      </button>
    </div>

    <!-- 分区 0：独立用户管理模块 -->
    <template v-if="activeSection === 'users'">
      <div class="card">
        <div class="card-title">
          <span>用户管理 · 新增 / 资料认证 / 密码重置 / 调账 / 封禁与删除</span>
          <div class="row">
            <button class="btn btn-sm" :disabled="refreshing" @click="load(true)">{{ refreshing ? '刷新中...' : '刷新列表' }}</button>
            <button class="btn btn-sm btn-primary" @click="openCreateUserModal">+ 新增用户账号</button>
          </div>
        </div>

        <div class="row" style="margin-bottom: 14px">
          <input
            v-model="userSearch"
            class="input mono"
            placeholder="搜索 UID / 用户名 / 邮箱 / 邀请码..."
            style="flex: 1; min-width: 220px"
          />
          <select v-model="userRoleFilter" class="select" style="width: auto; min-width: 120px">
            <option value="">全部角色</option>
            <option value="user">普通租户 (user)</option>
            <option value="admin">管理员 (admin)</option>
          </select>
          <select v-model="userStatusFilter" class="select" style="width: auto; min-width: 120px">
            <option value="">全部状态</option>
            <option value="active">正常 (active)</option>
            <option value="suspended">已封禁 (suspended)</option>
          </select>
          <select v-model="userVerifiedFilter" class="select" style="width: auto; min-width: 130px">
            <option value="">全部邮箱状态</option>
            <option value="verified">已认证邮箱</option>
            <option value="unverified">未验证邮箱</option>
          </select>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>UID / 用户名 / 邮箱</th>
                <th>邀请码 / 推荐关系</th>
                <th>等级 / 信用与贡献</th>
                <th>角色 / 套餐 / 状态</th>
                <th>钱包余额</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in filteredUsers" :key="u.id">
                <td>
                  <strong>#{{ u.id }} {{ u.username }}</strong>
                  <span class="tag" :class="u.email_verified ? 'tag-ok' : 'tag-warn'" style="margin-left: 6px">
                    {{ u.email_verified ? '已认证' : '未验证' }}
                  </span>
                  <div class="muted" style="font-size: 12px; margin-top: 2px">{{ u.email || '未绑定邮箱' }}</div>
                </td>
                <td class="mono">
                  <div>码: {{ u.invite_code || '-' }} (已邀 {{ u.invited_count || 0 }} 人)</div>
                  <div class="muted" style="font-size: 11px">推荐人: {{ u.inviter_username || '自主注册' }}</div>
                </td>
                <td>
                  <div class="row" style="gap: 6px">
                    <span class="tag" :style="{ color: u.level_badge_color, borderColor: u.level_badge_color }">{{ u.level_name }}</span>
                    <span v-if="u.level_locked" class="tag tag-warn">锁定</span>
                    <span class="mono muted">{{ u.level_score }}分</span>
                  </div>
                  <div class="muted mono" style="font-size: 11px; margin-top: 4px">
                    节点 {{ u.node_count || 0 }} · 租约 {{ u.active_lease_count || 0 }} · {{ (Number(u.total_online_seconds || 0) / 3600).toFixed(1) }}h · {{ (Number(u.contributed_traffic_bytes || 0) / (1024 ** 3)).toFixed(2) }}GB
                  </div>
                </td>
                <td>
                  <span class="tag tag-info">{{ u.role }}</span> · {{ u.plan_name }}
                  <span class="tag" :class="u.status === 'active' ? 'tag-ok' : 'tag-danger'" style="margin-left: 4px">{{ u.status }}</span>
                </td>
                <td class="mono">¥{{ u.balance_yuan }}</td>
                <td>
                  <div class="row" style="gap: 6px">
                    <button class="btn btn-sm btn-primary" @click="openEditUserModal(u)">编辑 / 调账</button>
                    <button
                      class="btn btn-sm"
                      :class="u.status === 'active' ? 'btn-warn' : 'btn-emerald'"
                      :disabled="Number(u.id) === Number(currentUserId) || busyUserId === u.id"
                      @click="toggleUserStatus(u)"
                    >
                      {{ busyUserId === u.id ? '处理中...' : u.status === 'active' ? '封禁' : '解封' }}
                    </button>
                    <button
                      class="btn btn-sm btn-danger"
                      :disabled="Number(u.id) === Number(currentUserId) || busyUserId === u.id"
                      @click="confirmDeleteUserTarget = u"
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="filteredUsers.length === 0">
                <td colspan="6" class="muted" style="text-align: center; padding: 24px">暂无匹配的用户账号</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- 分区 1：定价费率 · 等级与套餐 -->
    <template v-if="activeSection === 'rates'">
      <div class="card">
        <div class="card-title">
          <span>通道差价与自用流量定价策略</span>
          <div class="row" style="gap: 8px">
            <span
              v-if="settingsSaveFeedback.section === 'rates' && settingsSaveFeedback.text"
              class="save-status"
              :class="settingsSaveFeedback.ok ? 'save-status-ok' : 'save-status-error'"
            >
              {{ settingsSaveFeedback.text }}
            </span>
            <button class="btn btn-sm btn-primary" :disabled="savingSettings" @click="saveSettings('rates')">
              {{ savingSettings ? '保存中...' : '保存差价与评级策略' }}
            </button>
          </div>
        </div>
        <div class="grid-3">
          <div class="subcard">
            <div class="field" style="margin-bottom: 0">
              <label>WSS 反向穿透基准加价 (bps, 1000=10%)</label>
              <input class="input mono" type="number" min="0" max="10000" v-model.number="settings.saas_reverse_fee_bps" />
            </div>
          </div>
          <div class="subcard">
            <div class="field" style="margin-bottom: 0">
              <label>公网 WSS 直连基准加价 (bps)</label>
              <input class="input mono" type="number" min="0" max="10000" v-model.number="settings.saas_public_wss_fee_bps" />
            </div>
          </div>
          <div class="subcard">
            <div class="field" style="margin-bottom: 0">
              <label>自用 WSS 反穿 Hub 流量单价 (元/GB)</label>
              <input class="input mono" type="number" step="0.05" min="0" v-model.number="settings.saas_self_reverse_hub_gb_yuan" />
            </div>
          </div>
        </div>
        <div class="grid-3" style="margin-top: 12px">
          <div class="subcard">
            <div class="field" style="margin-bottom: 0">
              <label>共享市场平台时租基准底价 (元/小时 · 卖家不可改)</label>
              <input class="input mono" type="number" step="0.05" min="0" v-model.number="settings.saas_market_base_hour_yuan" />
            </div>
          </div>
          <div class="subcard">
            <div class="field" style="margin-bottom: 0">
              <label>共享市场平台流量基准底价 (元/GB · 卖家不可改)</label>
              <input class="input mono" type="number" step="0.05" min="0" v-model.number="settings.saas_market_base_gb_yuan" />
            </div>
          </div>
          <div class="subcard">
            <label class="switch-row" :class="{ active: settings.saas_auto_level_enabled }" style="height: 100%">
              <span>
                <span class="switch-row-title">自动评级 / 降级调度</span>
                <span class="switch-row-desc">{{ settings.saas_auto_level_enabled ? '已开启 60s 自动升降级考核' : '已暂停自动升降级' }}</span>
              </span>
              <span class="switch">
                <input type="checkbox" v-model="settings.saas_auto_level_enabled" />
                <span class="switch-track"></span>
              </span>
            </label>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>用户等级自动升降级门槛 & 分级差价策略</span>
          <button class="btn btn-sm btn-emerald" :disabled="evaluatingLevels" @click="evaluateAllLevels">
            {{ evaluatingLevels ? '全网评级中...' : '立即执行全网自动评级 / 降级' }}
          </button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>等级</th>
                <th>最低在线(h)</th>
                <th>最低贡献(GB)</th>
                <th>延迟上限(ms,0=不限)</th>
                <th>最低速度(KB/s)</th>
                <th>反穿加价(bps)</th>
                <th>WSS直连(bps)</th>
                <th>买家折扣(bps)</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="lv in levels" :key="lv.id">
                <td><span class="tag" :style="{ color: lv.badge_color, borderColor: lv.badge_color }">{{ lv.name }}</span></td>
                <td><input class="input mono" type="number" min="0" style="width: 72px" v-model.number="lv.min_online_hours" /></td>
                <td><input class="input mono" type="number" min="0" style="width: 72px" v-model.number="lv.min_contributed_gb" /></td>
                <td><input class="input mono" type="number" min="0" style="width: 78px" v-model.number="lv.max_avg_latency_ms" /></td>
                <td><input class="input mono" type="number" min="0" style="width: 78px" v-model.number="lv.min_speed_kbps" /></td>
                <td><input class="input mono" type="number" min="0" max="10000" style="width: 78px" v-model.number="lv.reverse_fee_bps" /></td>
                <td><input class="input mono" type="number" min="0" max="10000" style="width: 78px" v-model.number="lv.public_wss_fee_bps" /></td>
                <td><input class="input mono" type="number" min="0" max="10000" style="width: 78px" v-model.number="lv.buyer_discount_bps" /></td>
                <td>
                  <button
                    class="btn btn-sm"
                    :class="savedLevelId === lv.id ? 'btn-emerald' : 'btn-primary'"
                    :disabled="savingLevelId === lv.id"
                    @click="saveLevel(lv)"
                  >
                    {{ savingLevelId === lv.id ? '保存中...' : savedLevelId === lv.id ? '✓ 已保存' : '保存' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-title">会员套餐与配额管理</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>编码 / 套餐名称</th>
                <th>月费 (元)</th>
                <th>自有节点上限</th>
                <th>并发租约上限</th>
                <th>月流量上限 (GB)</th>
                <th>手续费减免 (bps)</th>
                <th>允许出租共享</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in plans" :key="p.id">
                <td>
                  <span class="tag tag-info" style="margin-right: 6px">{{ p.code }}</span>
                  <input class="input" style="width: 140px; display: inline-block" v-model="p.name" />
                </td>
                <td><input class="input mono" type="number" step="1" min="0" style="width: 90px" v-model.number="p.edit_price_yuan" /></td>
                <td><input class="input mono" type="number" min="1" style="width: 80px" v-model.number="p.max_nodes" /></td>
                <td><input class="input mono" type="number" min="1" style="width: 80px" v-model.number="p.max_active_leases" /></td>
                <td><input class="input mono" type="number" min="1" style="width: 96px" v-model.number="p.edit_traffic_gb" /></td>
                <td><input class="input mono" type="number" min="0" max="10000" style="width: 88px" v-model.number="p.platform_fee_discount_bps" /></td>
                <td>
                  <label class="switch switch-sm">
                    <input type="checkbox" v-model="p.edit_can_share" />
                    <span class="switch-track"></span>
                    <span class="switch-state" :class="{ on: p.edit_can_share }">{{ p.edit_can_share ? '允许' : '禁止' }}</span>
                  </label>
                </td>
                <td>
                  <button
                    class="btn btn-sm"
                    :class="savedPlanId === p.id ? 'btn-emerald' : 'btn-primary'"
                    :disabled="savingPlanId === p.id"
                    @click="savePlan(p)"
                  >
                    {{ savingPlanId === p.id ? '保存中...' : savedPlanId === p.id ? '✓ 已保存' : '保存' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- 分区 2：注册风控 · 邀请与补贴 -->
    <template v-else-if="activeSection === 'growth'">
      <div class="card">
        <div class="card-title">
          <span>注册安全风控 · 推荐邀请返利 · 月补与签到配置</span>
          <div class="row" style="gap: 8px">
            <span
              v-if="settingsSaveFeedback.section === 'growth' && settingsSaveFeedback.text"
              class="save-status"
              :class="settingsSaveFeedback.ok ? 'save-status-ok' : 'save-status-error'"
            >
              {{ settingsSaveFeedback.text }}
            </span>
            <button class="btn btn-sm btn-primary" :disabled="savingSettings" @click="saveSettings('growth')">
              {{ savingSettings ? '保存中...' : '保存成长与补贴配置' }}
            </button>
          </div>
        </div>

        <div class="grid-3">
          <div class="subcard">
            <div class="card-title" style="font-size: 14px; margin-bottom: 10px">注册风控与体验金</div>
            <div class="field">
              <label class="switch-row" :class="{ active: settings.saas_allow_public_register }">
                <span>
                  <span class="switch-row-title">公开注册开关</span>
                  <span class="switch-row-desc">{{ settings.saas_allow_public_register ? '开放首页公开注册' : '关闭公开注册（仅限管理员建号）' }}</span>
                </span>
                <span class="switch">
                  <input type="checkbox" v-model="settings.saas_allow_public_register" />
                  <span class="switch-track"></span>
                </span>
              </label>
            </div>
            <div class="field">
              <label class="switch-row" :class="{ active: settings.saas_require_email_verify }">
                <span>
                  <span class="switch-row-title">注册邮箱验证码认证</span>
                  <span class="switch-row-desc">{{ settings.saas_require_email_verify ? '强制验证 6 位邮箱验证码' : '关闭邮箱验证码校验' }}</span>
                </span>
                <span class="switch">
                  <input type="checkbox" v-model="settings.saas_require_email_verify" />
                  <span class="switch-track"></span>
                </span>
              </label>
            </div>
            <div class="field" style="margin-bottom: 0">
              <label>新用户注册体验赠金 (元)</label>
              <input class="input mono" type="number" step="0.5" min="0" v-model.number="settings.saas_welcome_bonus_yuan" />
            </div>
          </div>

          <div class="subcard">
            <div class="card-title" style="font-size: 14px; margin-bottom: 10px">推荐邀请返利策略</div>
            <div class="field">
              <label class="switch-row" :class="{ active: settings.saas_referral_enabled }">
                <span>
                  <span class="switch-row-title">推荐邀请奖励开关</span>
                  <span class="switch-row-desc">{{ settings.saas_referral_enabled ? '已开启推荐邀请双方赠金' : '已关闭邀请返利活动' }}</span>
                </span>
                <span class="switch">
                  <input type="checkbox" v-model="settings.saas_referral_enabled" />
                  <span class="switch-track"></span>
                </span>
              </label>
            </div>
            <div class="field">
              <label>邀请人返利金额 (元)</label>
              <input class="input mono" type="number" step="0.5" min="0" v-model.number="settings.saas_referral_inviter_bonus_yuan" />
            </div>
            <div class="field" style="margin-bottom: 0">
              <label>受邀新人额外赠金 (元)</label>
              <input class="input mono" type="number" step="0.5" min="0" v-model.number="settings.saas_referral_invitee_bonus_yuan" />
            </div>
          </div>

          <div class="subcard">
            <div class="card-title" style="font-size: 14px; margin-bottom: 10px">每月补贴与每日签到领奖</div>
            <div class="field">
              <label>每月固定补贴开关 & 金额 (元)</label>
              <div class="row">
                <label class="switch">
                  <input type="checkbox" v-model="settings.saas_monthly_claim_enabled" />
                  <span class="switch-track"></span>
                  <span class="switch-state" :class="{ on: settings.saas_monthly_claim_enabled }">{{ settings.saas_monthly_claim_enabled ? '已开启' : '已关闭' }}</span>
                </label>
                <input class="input mono" type="number" step="1" min="0" style="flex: 1" v-model.number="settings.saas_monthly_claim_yuan" />
              </div>
            </div>
            <div class="field">
              <label>每日签到开关 & 基础奖励 (元)</label>
              <div class="row">
                <label class="switch">
                  <input type="checkbox" v-model="settings.saas_daily_checkin_enabled" />
                  <span class="switch-track"></span>
                  <span class="switch-state" :class="{ on: settings.saas_daily_checkin_enabled }">{{ settings.saas_daily_checkin_enabled ? '已开启' : '已关闭' }}</span>
                </label>
                <input class="input mono" type="number" step="0.1" min="0" style="flex: 1" v-model.number="settings.saas_daily_checkin_yuan" />
              </div>
            </div>
            <div class="field" style="margin-bottom: 0">
              <label>连续签到每天递增奖励 (元/天)</label>
              <input class="input mono" type="number" step="0.05" min="0" v-model.number="settings.saas_daily_streak_bonus_yuan" />
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>全网推荐邀请奖励流水</span>
          <span class="mono muted" style="font-size: 12px">
            累计邀请 {{ referralSummary.total_referrals || 0 }} 次 · 邀请人返利 ¥{{ referralSummary.total_inviter_bonus_yuan || '0.00' }} · 新人赠金 ¥{{ referralSummary.total_invitee_bonus_yuan || '0.00' }}
          </span>
        </div>
        <div v-if="referralRewards.length === 0" class="muted">暂无邀请奖励记录。</div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr><th>ID</th><th>邀请人</th><th>受邀新用户</th><th>邀请人返利</th><th>新人赠金</th><th>状态</th><th>时间</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in referralRewards" :key="r.id">
                <td class="mono">#{{ r.id }}</td>
                <td><strong>{{ r.inviter_username }}</strong> (#{{ r.inviter_id }})</td>
                <td>{{ r.invitee_username }} (#{{ r.invitee_id }})</td>
                <td class="mono" style="color: #34d399">¥{{ r.inviter_bonus_yuan }}</td>
                <td class="mono">¥{{ r.invitee_bonus_yuan }}</td>
                <td><span class="tag tag-ok">{{ r.status }}</span></td>
                <td class="mono muted">{{ r.created_at }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- 分区 3：支付网关 (支付宝/微信) & 充值订单 -->
    <template v-else-if="activeSection === 'payments'">
      <div class="card">
        <div class="card-title">
          <span>全局支付收银台与风控参数</span>
          <div class="row" style="gap: 8px">
            <span
              v-if="settingsSaveFeedback.section === 'payments' && settingsSaveFeedback.text"
              class="save-status"
              :class="settingsSaveFeedback.ok ? 'save-status-ok' : 'save-status-error'"
            >
              {{ settingsSaveFeedback.text }}
            </span>
            <button class="btn btn-sm btn-primary" :disabled="savingSettings" @click="saveSettings('payments')">
              {{ savingSettings ? '保存中...' : '保存全部支付网关参数' }}
            </button>
          </div>
        </div>

        <div class="grid-2" style="margin-bottom: 14px">
          <div class="subcard">
            <label class="switch-row" :class="{ active: settings.saas_allow_self_recharge }">
              <span>
                <span class="switch-row-title">沙盒模拟演练开关</span>
                <span class="switch-row-desc">
                  {{
                    settings.saas_allow_self_recharge
                      ? '已开启：未配置官方密钥或收款码时允许纯模拟演示（数据不落盘，不改真实余额）'
                      : '已关闭（生产模式）：仅允许已配置的官方网关或人工收款码下单'
                  }}
                </span>
              </span>
              <span class="switch">
                <input type="checkbox" v-model="settings.saas_allow_self_recharge" />
                <span class="switch-track"></span>
                <span class="switch-state" :class="{ on: settings.saas_allow_self_recharge }">
                  {{ settings.saas_allow_self_recharge ? '开启' : '关闭' }}
                </span>
              </span>
            </label>
          </div>

          <div class="subcard">
            <div class="field" style="margin-bottom: 0">
              <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                <label style="margin: 0">通用 JSON Webhook HMAC-SHA256 验签密钥（仅第三方聚合/测试用，直连官方留空）</label>
                <span class="tag" :class="settings.saas_payment_notify_secret_set ? 'tag-ok' : ''">
                  {{ settings.saas_payment_notify_secret_set ? '已配置' : '未设置' }}
                </span>
              </div>
              <input class="input mono" type="password" placeholder="留空保持不变" v-model="settings.saas_payment_notify_secret" />
            </div>
          </div>
        </div>

        <div class="subcard" style="margin-bottom: 14px">
          <div class="row" style="justify-content: space-between; margin-bottom: 10px">
            <strong style="font-size: 13px; color: var(--text-strong)">前台可用支付方式开关（唯一开关入口 · 关闭项在前台自动隐藏）</strong>
            <span class="muted" style="font-size: 12px">开启几项，租户端「在线钱包充值收银台」就显示几项；全部关闭则自动隐藏线上充值入口</span>
          </div>
          <div class="grid-3">
            <label class="switch-row" :class="{ active: settings.saas_alipay_f2f_enabled }">
              <span>
                <span class="switch-row-title">支付宝当面付</span>
                <span class="switch-row-desc">官方 `precreate` 网页动态出码 · 自动到账</span>
              </span>
              <span class="switch">
                <input type="checkbox" v-model="settings.saas_alipay_f2f_enabled" />
                <span class="switch-track"></span>
              </span>
            </label>
            <label class="switch-row" :class="{ active: settings.saas_alipay_page_enabled }">
              <span>
                <span class="switch-row-title">支付宝电脑网站支付</span>
                <span class="switch-row-desc">官方 `page.pay` 跳转网页收银台</span>
              </span>
              <span class="switch">
                <input type="checkbox" v-model="settings.saas_alipay_page_enabled" />
                <span class="switch-track"></span>
              </span>
            </label>
            <label class="switch-row" :class="{ active: settings.saas_alipay_static_enabled }">
              <span>
                <span class="switch-row-title">支付宝扫码转账（人工核账）</span>
                <span class="switch-row-desc">展示固定收款码 · 人工确认入账</span>
              </span>
              <span class="switch">
                <input type="checkbox" v-model="settings.saas_alipay_static_enabled" />
                <span class="switch-track"></span>
              </span>
            </label>
            <label class="switch-row" :class="{ active: settings.saas_wechat_native_enabled }">
              <span>
                <span class="switch-row-title">微信支付 Native V3</span>
                <span class="switch-row-desc">官方直连 V3 动态扫码 · 自动到账</span>
              </span>
              <span class="switch">
                <input type="checkbox" v-model="settings.saas_wechat_native_enabled" />
                <span class="switch-track"></span>
              </span>
            </label>
            <label class="switch-row" :class="{ active: settings.saas_wechat_static_enabled }">
              <span>
                <span class="switch-row-title">微信扫码转账（人工核账）</span>
                <span class="switch-row-desc">展示固定收款码 · 人工确认入账</span>
              </span>
              <span class="switch">
                <input type="checkbox" v-model="settings.saas_wechat_static_enabled" />
                <span class="switch-track"></span>
              </span>
            </label>
          </div>
        </div>

        <div class="grid-2">
          <!-- 支付宝开放平台子卡 -->
          <div class="subcard">
            <div class="card-title" style="font-size: 14px; margin-bottom: 10px">
              <span>支付宝开放平台配置 (当面付 / 电脑网站 / 人工收款码)</span>
              <span class="tag" :class="enabledAlipayMethodCount > 0 ? 'tag-ok' : 'tag-warn'">
                {{ enabledAlipayMethodCount > 0 ? `已开放 ${enabledAlipayMethodCount}/3 项` : '未开放' }}
              </span>
            </div>
            <div class="banner banner-info" style="font-size: 12px; margin-bottom: 12px">
              <strong>开放平台对接提示：</strong>支付宝开放平台里的「授权回调地址」「应用网关」「接口内容加密方式 (AES)」均<strong>留空/未设置</strong>即可；支付所需的 <code>notify_url</code> 会在每次下单时由本系统自动携带。加签方式如在开放平台选了<strong>「密钥/普通公钥」</strong>请选公钥模式，选了<strong>「证书」</strong>请切换为公钥证书模式并读取 3 个 <code>.crt</code> 证书文件。
            </div>
            <div class="grid-2">
              <div class="field">
                <label>默认下单模式（三选一）</label>
                <select class="select" v-model="settings.saas_alipay_mode">
                  <option value="precreate">当面付扫码 (precreate · 客户扫网页动态码)</option>
                  <option value="page_pay">电脑网站跳转收银台 (page.pay)</option>
                  <option value="static_qr">人工收款码转账（扫码付款 · 人工核账）</option>
                </select>
              </div>
              <div class="field">
                <label>开放平台接口加签方式（二选一）</label>
                <select class="select" v-model="settings.saas_alipay_sign_mode">
                  <option value="public_key">普通公钥加签 (RSA2 公钥)</option>
                  <option value="cert">公钥证书加签 (3 个 .crt 证书)</option>
                </select>
              </div>
            </div>
            <div class="grid-2">
              <div class="field">
                <label>应用 AppID</label>
                <input class="input mono" placeholder="202100..." v-model="settings.saas_alipay_app_id" />
              </div>
              <div class="field">
                <label>网关地址 (官方沙盒可改 openapi-sandbox)</label>
                <input class="input mono" v-model="settings.saas_alipay_gateway_url" />
              </div>
            </div>
            <div class="grid-2">
              <div class="field">
                <div class="label-with-help">
                  <span>异步回调 URL（一般留空自动使用当前域名默认地址）</span>
                  <button
                    type="button"
                    class="help-icon-btn"
                    :class="{ active: activePaymentHelp === 'alipay_notify' }"
                    title="点击查看说明"
                    aria-label="查看支付宝异步回调 URL 说明"
                    @click="togglePaymentHelp('alipay_notify')"
                  >
                    ?
                  </button>
                </div>
                <input class="input mono" :placeholder="defaultAlipayNotifyUrl" v-model="settings.saas_alipay_notify_url" />
              </div>
              <div class="field">
                <div class="label-with-help">
                  <span>电脑支付同步回跳 Return URL（可选）</span>
                  <button
                    type="button"
                    class="help-icon-btn"
                    :class="{ active: activePaymentHelp === 'alipay_return' }"
                    title="点击查看说明"
                    aria-label="查看电脑支付同步回跳 Return URL 说明"
                    @click="togglePaymentHelp('alipay_return')"
                  >
                    ?
                  </button>
                </div>
                <input class="input mono" :placeholder="defaultReturnUrl" v-model="settings.saas_alipay_return_url" />
              </div>
            </div>
            <div v-if="activePaymentHelp === 'alipay_notify'" class="banner banner-info" style="font-size: 12px">
              <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                <strong>异步回调 URL (notify_url) 说明：什么时候需要改？</strong>
                <button type="button" class="btn btn-sm" @click="activePaymentHelp = ''">收起</button>
              </div>
              <div>• <strong>怎么工作：</strong>用户付款成功后，支付宝官方服务器向该地址推送签名的入账通知，每次下单由本系统自动随参数上传，<strong>无需填到支付宝开放平台后台</strong>。</div>
              <div>• <strong>什么时候留空（推荐）：</strong>默认留空即可，系统会自动识别当前访问域名拼接 <code>{{ defaultAlipayNotifyUrl }}</code>。</div>
              <div>• <strong>什么时候需要改：</strong>仅当后台管理访问域名与公网真实回调入口不一致（如多级反代、CDN 转发或指定独立回调域名）时，才需手动填写完整 <code>https://...</code> 地址。</div>
            </div>
            <div v-if="activePaymentHelp === 'alipay_return'" class="banner banner-info" style="font-size: 12px">
              <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                <strong>电脑支付同步回跳 Return URL 说明：什么时候需要改？</strong>
                <button type="button" class="btn btn-sm" @click="activePaymentHelp = ''">收起</button>
              </div>
              <div>• <strong>作用：</strong>仅在启用 <strong>「支付宝电脑网站支付 (page.pay)」</strong> 时生效。用户在支付宝网页收银台付款完成后，浏览器会自动跳回该地址（不负责入账，实际入账仍靠异步回调/查单）。</div>
              <div>• <strong>什么时候留空（推荐）：</strong>日常使用直接留空即可，留空会自动跳回当前站点首页 <code>{{ defaultReturnUrl }}</code>；若只使用「当面付扫码」或「人工收款码」，此项完全不会用到。</div>
              <div>• <strong>什么时候需要改：</strong>① 希望用户电脑端付完款后跳到指定的自定义落地页/公告页；② 前面挂了多层反代或子路径，导致系统自动识别的首页域名与用户真实访问域名不一致时，手动填入完整 <code>https://...</code> 即可。</div>
            </div>
            <div class="field">
              <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                <label style="margin: 0">应用私钥 (RSA2 PKCS8 / PKCS1)</label>
                <div class="row" style="gap: 6px">
                  <label class="btn btn-sm" style="cursor: pointer; margin: 0">
                    读取私钥文件
                    <input type="file" accept=".pem,.txt,.key" style="display: none" @change="(e) => loadTextFile(e, 'saas_alipay_private_key')" />
                  </label>
                  <span class="tag" :class="settings.saas_alipay_private_key_set ? 'tag-ok' : ''">
                    {{ settings.saas_alipay_private_key_set ? '数据库已加密保存（留空保留）' : '未配置' }}
                  </span>
                </div>
              </div>
              <textarea
                class="textarea mono"
                rows="3"
                placeholder="-----BEGIN PRIVATE KEY----- ...（如已保存且无需更换请留空）"
                v-model="settings.saas_alipay_private_key"
              ></textarea>
            </div>

            <div v-if="settings.saas_alipay_sign_mode !== 'cert'" class="field">
              <label>支付宝公钥（选择「公钥/密钥」加签时，粘贴开放平台给出的支付宝公钥字符串）</label>
              <textarea
                class="textarea mono"
                rows="3"
                placeholder="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A..."
                v-model="settings.saas_alipay_public_key"
              ></textarea>
            </div>

            <template v-else>
              <div class="field">
                <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                  <label style="margin: 0">1) 应用公钥证书 (appCertPublicKey_*.crt)</label>
                  <label class="btn btn-sm" style="cursor: pointer; margin: 0">
                    选择 .crt 文件
                    <input type="file" accept=".crt,.pem" style="display: none" @change="(e) => loadTextFile(e, 'saas_alipay_app_cert')" />
                  </label>
                </div>
                <textarea
                  class="textarea mono"
                  rows="2"
                  placeholder="-----BEGIN CERTIFICATE----- ...（用于自动计算 app_cert_sn）"
                  v-model="settings.saas_alipay_app_cert"
                ></textarea>
              </div>
              <div class="field">
                <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                  <label style="margin: 0">2) 支付宝公钥证书 (alipayCertPublicKey_RSA2.crt)</label>
                  <label class="btn btn-sm" style="cursor: pointer; margin: 0">
                    选择 .crt 文件
                    <input type="file" accept=".crt,.pem" style="display: none" @change="(e) => loadTextFile(e, 'saas_alipay_cert_public_key')" />
                  </label>
                </div>
                <textarea
                  class="textarea mono"
                  rows="2"
                  placeholder="-----BEGIN CERTIFICATE----- ...（用于校验支付宝网关响应与异步通知签名）"
                  v-model="settings.saas_alipay_cert_public_key"
                ></textarea>
              </div>
              <div class="field">
                <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                  <label style="margin: 0">3) 支付宝根证书 (alipayRootCert.crt)</label>
                  <label class="btn btn-sm" style="cursor: pointer; margin: 0">
                    选择 .crt 文件
                    <input type="file" accept=".crt,.pem" style="display: none" @change="(e) => loadTextFile(e, 'saas_alipay_root_cert')" />
                  </label>
                </div>
                <textarea
                  class="textarea mono"
                  rows="2"
                  placeholder="-----BEGIN CERTIFICATE----- ...（含多个根证书块，用于自动计算 alipay_root_cert_sn）"
                  v-model="settings.saas_alipay_root_cert"
                ></textarea>
              </div>
            </template>

            <div class="field" style="margin-bottom: 0">
              <div class="label-with-help">
                <span>静态收款码兜底链接（当模式为静态码时使用）</span>
                <button
                  type="button"
                  class="help-icon-btn"
                  :class="{ active: activePaymentHelp === 'alipay_static_qr' }"
                  title="点击查看说明"
                  aria-label="查看支付宝静态收款码获取方法"
                  @click="togglePaymentHelp('alipay_static_qr')"
                >
                  ?
                </button>
              </div>
              <input
                class="input mono"
                placeholder="https://qr.alipay.com/... 或图片直链（不使用静态码请留空）"
                v-model="settings.saas_alipay_qr_url"
              />
            </div>
            <div v-if="activePaymentHelp === 'alipay_static_qr'" class="banner banner-info" style="font-size: 12px; margin-top: 10px; margin-bottom: 0">
              <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                <strong>支付宝静态收款码兜底链接：需要填吗？怎么获取？</strong>
                <button type="button" class="btn btn-sm" @click="activePaymentHelp = ''">收起</button>
              </div>
              <div>• <strong>是否必填：</strong>如果只用官方 <strong>当面付 (precreate)</strong> 或 <strong>电脑网站支付 (page.pay)</strong>，<strong>留空即可</strong>；仅当开启「支付宝扫码转账（人工核账）」时才需要填写。</div>
              <div>• <strong>获取文本链接（推荐，自动生成矢量二维码）：</strong>在手机支付宝保存您的个人收款码图片，使用二维码识别/解码工具扫一下该图片，会得到一串类似 <code>https://qr.alipay.com/fkx...</code> 的文本。填在这里后，前台会自动渲染为高清黑白矢量二维码，与原图扫码效果完全一致。</div>
              <div>• <strong>或填图片直链：</strong>也可以填写您已托管在图床上的图片直链（以 <code>.png/.jpg/.webp</code> 结尾），前台将直接显示该图片；切勿填写普通网页 URL。</div>
            </div>
          </div>

          <!-- 微信支付 V3 子卡 -->
          <div class="subcard">
            <div class="card-title" style="font-size: 14px; margin-bottom: 10px">
              <span>微信支付商户平台配置 (API V3 / 人工收款码)</span>
              <span class="tag" :class="enabledWechatMethodCount > 0 ? 'tag-ok' : 'tag-warn'">
                {{ enabledWechatMethodCount > 0 ? `已开放 ${enabledWechatMethodCount}/2 项` : '未开放' }}
              </span>
            </div>
            <div class="banner banner-info" style="font-size: 12px; margin-bottom: 12px">
              <strong>微信商户平台所需 6 项核心信息：</strong>① 绑定的公众号/小程序/开放平台 <strong>AppID</strong>；② <strong>商户号 MchID</strong>；③ <strong>APIv3 密钥（32位）</strong>；④ <strong>商户 API 证书序列号</strong>；⑤ <strong>商户 API 私钥 (`apiclient_key.pem`)</strong>；⑥ <strong>微信支付公钥或平台证书</strong>（强烈建议填写，用于校验微信回调签名防伪造）。
            </div>
            <div class="field">
              <label>默认下单模式（二选一）</label>
              <select class="select" v-model="settings.saas_wechat_mode">
                <option value="native_v3">Native V3 扫码下单 (官方推荐)</option>
                <option value="static_qr">人工收款码转账（扫码付款 · 人工核账）</option>
              </select>
            </div>
            <div class="grid-2">
              <div class="field">
                <label>绑定 AppID（公众号/开放平台/小程序）</label>
                <input class="input mono" placeholder="wx..." v-model="settings.saas_wechat_app_id" />
              </div>
              <div class="field">
                <label>直连商户号 MchID</label>
                <input class="input mono" placeholder="160000..." v-model="settings.saas_wechat_mch_id" />
              </div>
            </div>
            <div class="grid-2">
              <div class="field">
                <label>商户 API 证书序列号 (Serial No)</label>
                <input class="input mono" placeholder="6E..." v-model="settings.saas_wechat_serial_no" />
              </div>
              <div class="field">
                <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                  <label style="margin: 0">APIv3 密钥 (32位)</label>
                  <span class="tag" :class="settings.saas_wechat_api_v3_key_set ? 'tag-ok' : ''">
                    {{ settings.saas_wechat_api_v3_key_set ? '已保存' : '未配置' }}
                  </span>
                </div>
                <input class="input mono" type="password" placeholder="32字符密钥（留空保留）" v-model="settings.saas_wechat_api_v3_key" />
              </div>
            </div>
            <div class="grid-2">
              <div class="field">
                <label>API V3 网关地址</label>
                <input class="input mono" v-model="settings.saas_wechat_gateway_url" />
              </div>
              <div class="field">
                <div class="label-with-help">
                  <span>异步回调 URL（一般留空自动使用当前域名默认地址）</span>
                  <button
                    type="button"
                    class="help-icon-btn"
                    :class="{ active: activePaymentHelp === 'wechat_notify' }"
                    title="点击查看说明"
                    aria-label="查看微信异步回调 URL 说明"
                    @click="togglePaymentHelp('wechat_notify')"
                  >
                    ?
                  </button>
                </div>
                <input class="input mono" :placeholder="defaultWechatNotifyUrl" v-model="settings.saas_wechat_notify_url" />
              </div>
            </div>
            <div v-if="activePaymentHelp === 'wechat_notify'" class="banner banner-info" style="font-size: 12px">
              <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                <strong>微信 V3 异步回调 URL (notify_url) 说明：什么时候需要改？</strong>
                <button type="button" class="btn btn-sm" @click="activePaymentHelp = ''">收起</button>
              </div>
              <div>• <strong>怎么工作：</strong>调用微信 Native V3 下单时由系统自动随请求传给微信（需公网 HTTPS 可达），付款后微信服务器向该地址推送加密回调自动入账。</div>
              <div>• <strong>什么时候留空（推荐）：</strong>正常直接留空即可，系统会自动拼接 <code>{{ defaultWechatNotifyUrl }}</code>。</div>
              <div>• <strong>什么时候需要改：</strong>仅当后台域名与公网 HTTPS 回调域名不同（如内网访问后台但公网用反代域名收回调）时，手动填写公网完整 <code>https://...</code> 地址。</div>
            </div>
            <div class="field">
              <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                <label style="margin: 0">商户 API 私钥 (apiclient_key.pem)</label>
                <div class="row" style="gap: 6px">
                  <label class="btn btn-sm" style="cursor: pointer; margin: 0">
                    读取 .pem 文件
                    <input type="file" accept=".pem,.key,.txt" style="display: none" @change="(e) => loadTextFile(e, 'saas_wechat_private_key')" />
                  </label>
                  <span class="tag" :class="settings.saas_wechat_private_key_set ? 'tag-ok' : ''">
                    {{ settings.saas_wechat_private_key_set ? '数据库已加密保存（留空保留）' : '未配置' }}
                  </span>
                </div>
              </div>
              <textarea
                class="textarea mono"
                rows="3"
                placeholder="-----BEGIN PRIVATE KEY----- ...（如已保存且无需更换请留空）"
                v-model="settings.saas_wechat_private_key"
              ></textarea>
            </div>
            <div class="field">
              <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                <label style="margin: 0">微信支付公钥 / 平台证书公钥（用于回调验签）</label>
                <label class="btn btn-sm" style="cursor: pointer; margin: 0">
                  读取公钥/证书文件
                  <input type="file" accept=".pem,.crt,.txt" style="display: none" @change="(e) => loadTextFile(e, 'saas_wechat_platform_public_key')" />
                </label>
              </div>
              <textarea
                class="textarea mono"
                rows="3"
                placeholder="-----BEGIN PUBLIC KEY----- 或 -----BEGIN CERTIFICATE-----"
                v-model="settings.saas_wechat_platform_public_key"
              ></textarea>
            </div>
            <div class="field" style="margin-bottom: 0">
              <div class="label-with-help">
                <span>静态收款码兜底链接（当模式为静态码时使用）</span>
                <button
                  type="button"
                  class="help-icon-btn"
                  :class="{ active: activePaymentHelp === 'wechat_static_qr' }"
                  title="点击查看说明"
                  aria-label="查看微信静态收款码获取方法"
                  @click="togglePaymentHelp('wechat_static_qr')"
                >
                  ?
                </button>
              </div>
              <input
                class="input mono"
                placeholder="wxp://... 或图片直链（不使用静态码请留空）"
                v-model="settings.saas_wechat_qr_url"
              />
            </div>
            <div v-if="activePaymentHelp === 'wechat_static_qr'" class="banner banner-info" style="font-size: 12px; margin-top: 10px; margin-bottom: 0">
              <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                <strong>微信静态收款码兜底链接：需要填吗？怎么获取？</strong>
                <button type="button" class="btn btn-sm" @click="activePaymentHelp = ''">收起</button>
              </div>
              <div>• <strong>是否必填：</strong>如果只用官方 <strong>Native V3 扫码下单</strong>，<strong>留空即可</strong>；仅当开启「微信扫码转账（人工核账）」时才需要填写。</div>
              <div>• <strong>获取文本链接（推荐，自动生成矢量二维码）：</strong>在手机微信保存您的个人收款码图片，用二维码识别/解码工具读取其中的文本内容，会得到一串类似 <code>wxp://f2f0...</code> 的协议串。填在这里后，前台会自动渲染为高清黑白矢量二维码，与原图扫码效果完全一致。</div>
              <div>• <strong>或填图片直链：</strong>也可填写公开可访问的收款码图片直链（以 <code>.png/.jpg/.webp</code> 结尾）；切勿填写普通网页 URL。</div>
            </div>
          </div>
        </div>

        <div class="row" style="justify-content: flex-end; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border)">
          <span
            v-if="settingsSaveFeedback.section === 'payments' && settingsSaveFeedback.text"
            class="save-status"
            :class="settingsSaveFeedback.ok ? 'save-status-ok' : 'save-status-error'"
          >
            {{ settingsSaveFeedback.text }}
          </span>
          <button class="btn btn-primary" :disabled="savingSettings" @click="saveSettings('payments')">
            {{ savingSettings ? '正在保存支付网关参数...' : '保存全部支付网关参数' }}
          </button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>全网支付宝 / 微信充值订单管理、官方主动查单与人工核账</span>
          <div class="row" style="gap: 8px">
            <select v-model="rechargeStatusFilter" class="select" style="width: auto; min-width: 130px; padding: 6px 10px">
              <option value="">全部状态 ({{ recharges.length }})</option>
              <option value="pending">待支付</option>
              <option value="paid">已支付入账</option>
              <option value="cancelled">已取消</option>
              <option value="refunded">已冲正退款</option>
            </select>
            <button class="btn btn-sm" :disabled="refreshing" @click="load(true)">{{ refreshing ? '刷新中...' : '刷新订单列表' }}</button>
          </div>
        </div>
        <div v-if="filteredRecharges.length === 0" class="muted">暂无匹配的充值订单。</div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>订单号</th>
                <th>租户</th>
                <th>渠道</th>
                <th>金额</th>
                <th>状态 / 外部流水号</th>
                <th>时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in filteredRecharges" :key="o.id">
                <td class="mono">
                  <div>{{ o.order_no }}</div>
                  <div v-if="o.remark" class="muted" style="font-size: 11px">{{ o.remark }}</div>
                </td>
                <td>{{ o.username }} (#{{ o.user_id }})</td>
                <td>{{ o.channel === 'alipay' ? '支付宝' : '微信支付' }}</td>
                <td class="mono">¥{{ o.amount_yuan }}</td>
                <td>
                  <span class="tag" :class="rechargeStatusMeta(o.status).cls">{{ rechargeStatusMeta(o.status).label }}</span>
                  <span class="muted mono" style="margin-left: 6px; font-size: 11px">{{ o.external_trade_no || '-' }}</span>
                </td>
                <td class="mono muted">{{ o.paid_at || o.created_at }}</td>
                <td>
                  <div class="row" v-if="o.status === 'pending'" style="gap: 6px">
                    <button class="btn btn-sm btn-primary" :disabled="busyRechargeId === o.id" @click="queryRecharge(o.id)">
                      {{ busyRechargeId === o.id && busyRechargeType === 'query' ? '查单中...' : '官方查单' }}
                    </button>
                    <button class="btn btn-sm btn-emerald" :disabled="busyRechargeId === o.id" @click="confirmRecharge(o.id)">
                      {{ busyRechargeId === o.id && busyRechargeType === 'confirm' ? '确认中...' : '人工确认到账' }}
                    </button>
                    <button class="btn btn-sm btn-warn" :disabled="busyRechargeId === o.id" @click="pendingRechargeAction = { type: 'cancel', order: o }">
                      取消/关闭
                    </button>
                  </div>
                  <div class="row" v-else-if="o.status === 'paid'" style="gap: 6px">
                    <span class="muted" style="font-size: 12px">已入账</span>
                    <button class="btn btn-sm btn-danger" :disabled="busyRechargeId === o.id" @click="pendingRechargeAction = { type: 'refund', order: o }">
                      冲正退款
                    </button>
                  </div>
                  <div class="row" v-else-if="o.status === 'cancelled'" style="gap: 6px">
                    <button class="btn btn-sm" :disabled="busyRechargeId === o.id" @click="queryRecharge(o.id)">
                      {{ busyRechargeId === o.id && busyRechargeType === 'query' ? '查单中...' : '官方查单' }}
                    </button>
                    <button class="btn btn-sm btn-danger" :disabled="busyRechargeId === o.id" @click="pendingRechargeAction = { type: 'delete', order: o }">
                      删除记录
                    </button>
                  </div>
                  <span v-else class="muted">已冲正退款</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- 分区 4：通知渠道 & 系统公告 -->
    <template v-else-if="activeSection === 'notifications'">
      <div class="grid-2">
        <NotificationSettingsCard @notify="(msg) => emit('notify', msg)" />
        <AnnouncementManager @notify="(msg) => emit('notify', msg)" />
      </div>
    </template>

    <!-- 分区 5：租赁风控与引擎 -->
    <template v-else-if="activeSection === 'governance'">
      <div class="card">
        <div class="card-title">全网租赁订单风控监控</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>租约 ID / 节点 / 通道</th>
                <th>买家实付</th>
                <th>卖家实得</th>
                <th>平台差价盈利</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in recentLeases" :key="l.id">
                <td class="mono">
                  #{{ l.id }} · Node#{{ l.node_id }} (Seller#{{ l.seller_id }}[{{ l.seller_level_code }}] → Buyer#{{ l.buyer_id }}) · {{ l.channel_type }} ({{ ((l.platform_fee_bps || 0) / 100).toFixed(1) }}%)
                </td>
                <td class="mono">¥{{ l.buyer_spent_yuan }}</td>
                <td class="mono">¥{{ l.seller_earned_yuan }}</td>
                <td class="mono" style="color: #34d399">¥{{ l.platform_profit_yuan }}</td>
                <td><span class="tag" :class="l.status === 'active' ? 'tag-ok' : 'tag-warn'">{{ l.status }}</span></td>
                <td>
                  <button
                    v-if="l.status === 'active'"
                    class="btn btn-sm btn-danger"
                    :disabled="revokingLeaseId === l.id"
                    @click="revokeLease(l.id)"
                  >
                    {{ revokingLeaseId === l.id ? '强断中...' : '风控强断' }}
                  </button>
                  <span v-else class="muted">{{ l.end_reason }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card" v-if="runtimeInfo.db || runtimeInfo.cache || runtimeInfo.geoip">
        <div class="card-title">
          <span>基础设施运行引擎状态 (数据库 / 缓存引擎 / 防爆破防刷 / GeoIP 地区库)</span>
          <button class="btn btn-sm" :disabled="refreshingCache" @click="refreshCacheStatus(true)">
            {{ refreshingCache ? '探测中...' : '刷新缓存状态' }}
          </button>
        </div>

        <!-- 缓存引擎全状态监控 + 在线 Redis PING + 一键热切换保存 -->
        <div class="subcard" style="margin-bottom: 14px">
          <div class="card-title" style="font-size: 14px; margin-bottom: 12px">
            <div class="row" style="gap: 8px">
              <span>缓存引擎状态监控 · 在线 Redis PING 与热切换</span>
              <span class="tag" :class="cacheBadgeMeta.cls">{{ cacheBadgeMeta.label }}</span>
            </div>
            <span class="muted mono" style="font-size: 11px">配置来源：{{ cacheConfigSourceLabel }}</span>
          </div>

          <div class="grid-3" style="margin-bottom: 12px">
            <div class="subcard" style="padding: 10px 12px">
              <div class="kpi-label">当前激活后端</div>
              <div
                class="mono"
                style="margin-top: 5px; font-weight: 700; font-size: 13px"
                :style="{ color: cacheState === 'redis' ? '#34d399' : cacheState === 'degraded' ? '#f87171' : '#38bdf8' }"
              >
                {{
                  cacheState === 'redis'
                    ? `Redis v${runtimeInfo.cache?.redis_info?.version || '?'}`
                    : cacheState === 'degraded'
                      ? 'SQLite WAL Cache (降级兜底)'
                      : 'SQLite WAL Cache (内置)'
                }}
              </div>
              <div class="muted mono" style="font-size: 11px; margin-top: 4px; word-break: break-all">
                <template v-if="runtimeInfo.cache?.redis_configured">
                  目标: {{ runtimeInfo.cache?.redis_url_masked }} · 前缀: {{ runtimeInfo.cache?.key_prefix || 'csync_saas:' }}
                </template>
                <template v-else>
                  文件: {{ runtimeInfo.cache?.sqlite_cache?.db_path || '/data/cache.db' }} · 前缀: {{ runtimeInfo.cache?.key_prefix || 'csync_saas:' }}
                </template>
              </div>
            </div>

            <div class="subcard" style="padding: 10px 12px">
              <div class="kpi-label">实时连通与存储指标</div>
              <div class="mono" style="margin-top: 5px; font-weight: 600; font-size: 13px; color: var(--text-strong)">
                <template v-if="cacheState === 'redis'">
                  PING {{ runtimeInfo.cache?.redis_info?.ping_ms ?? '-' }} ms · 内存 {{ runtimeInfo.cache?.redis_info?.used_memory_human || '-' }}
                </template>
                <template v-else>
                  KV {{ runtimeInfo.cache?.sqlite_cache?.entries ?? 0 }} 条 · 缓冲哈希 {{ runtimeInfo.cache?.sqlite_cache?.buffered_hashes ?? 0 }}
                </template>
              </div>
              <div class="muted mono" style="font-size: 11px; margin-top: 4px">
                <template v-if="cacheState === 'redis'">
                  客户端连接数 {{ runtimeInfo.cache?.redis_info?.connected_clients ?? '-' }} · 命名空间 {{ runtimeInfo.cache?.key_prefix || 'csync_saas:' }}
                </template>
                <template v-else>
                  WAL 并发安全 · 自动 TTL 清理 · 原子流量计数
                </template>
              </div>
            </div>

            <div class="subcard" style="padding: 10px 12px">
              <div class="kpi-label">缓存命中率与容灾回退</div>
              <div class="mono" style="margin-top: 5px; font-weight: 600; font-size: 13px; color: var(--text-strong)">
                {{ cacheHitRate }}% <span class="muted" style="font-size: 11px">({{ cacheHits }} 命中 / {{ cacheMisses }} 未命中)</span>
              </div>
              <div class="muted mono" style="font-size: 11px; margin-top: 4px">
                累计回退次数: {{ cacheFallbacks }} · 探活冷却: {{ runtimeInfo.cache?.probe_cooldown_sec || 30 }}s
              </div>
            </div>
          </div>

          <div v-if="cacheState === 'degraded'" class="banner banner-warn" style="margin-bottom: 12px; font-size: 12px">
            <div class="row" style="justify-content: space-between; align-items: center">
              <div style="flex: 1; min-width: 240px">
                <strong>Redis 降级告警（已无缝切换至 SQLite WAL Cache 兜底，不影响业务读写）：</strong>
                <span class="mono">{{ runtimeInfo.cache?.last_error || 'Redis 连接异常' }}</span>
                <div class="muted mono" style="font-size: 11px; margin-top: 3px; color: #fde68a">
                  命名空间: {{ runtimeInfo.cache?.key_prefix || 'csync_saas:' }} · 系统每 {{ runtimeInfo.cache?.probe_cooldown_sec || 30 }}s 自动探活恢复
                  <span v-if="(runtimeInfo.cache?.next_probe_in_sec || 0) > 0">（下次自动探测约 {{ runtimeInfo.cache?.next_probe_in_sec }}s 后）</span>
                </div>
              </div>
              <button class="btn btn-sm btn-warn" :disabled="reconnectingRedis" @click="reconnectRedisNow">
                {{ reconnectingRedis ? '重连探测中...' : '立即重连 Redis' }}
              </button>
            </div>
          </div>

          <div class="row" style="justify-content: space-between; margin-bottom: 10px">
            <span style="font-size: 12px; color: var(--muted)">选择目标缓存引擎并一键热切换保存（写入 bootstrap.json，免重启生效）</span>
            <div class="row" style="gap: 6px">
              <button
                type="button"
                class="btn btn-sm"
                :class="cacheTargetMode === 'sqlite_cache' ? 'btn-primary' : ''"
                @click="cacheTargetMode = 'sqlite_cache'"
              >
                SQLite WAL Cache (内置)
              </button>
              <button
                type="button"
                class="btn btn-sm"
                :class="cacheTargetMode === 'redis' ? 'btn-primary' : ''"
                @click="cacheTargetMode = 'redis'"
              >
                Redis 高速缓存
              </button>
            </div>
          </div>

          <template v-if="cacheTargetMode === 'redis'">
            <div class="row" style="justify-content: space-between; margin-bottom: 10px">
              <div class="row" style="gap: 6px">
                <button
                  type="button"
                  class="btn btn-sm"
                  :class="redisInputMode === 'params' ? 'btn-primary' : ''"
                  @click="redisInputMode = 'params'"
                >
                  分项参数表单（推荐 · 密码免转义）
                </button>
                <button
                  type="button"
                  class="btn btn-sm"
                  :class="redisInputMode === 'url' ? 'btn-primary' : ''"
                  @click="redisInputMode = 'url'"
                >
                  粘贴完整 URL
                </button>
              </div>
              <span v-if="runtimeInfo.cache?.redis_url_masked" class="muted mono" style="font-size: 11px">
                当前已保存：{{ runtimeInfo.cache.redis_url_masked }}
              </span>
            </div>

            <div v-if="redisInputMode === 'params'" style="margin-bottom: 10px">
              <div class="grid-3" style="margin-bottom: 8px">
                <div class="field" style="margin-bottom: 0">
                  <label>Redis 主机 (Host)</label>
                  <input class="input mono" placeholder="127.0.0.1 或 redis.prod" v-model="redisForm.host" />
                </div>
                <div class="field" style="margin-bottom: 0">
                  <label>端口 (Port)</label>
                  <input class="input mono" type="number" min="1" max="65535" placeholder="6379" v-model.number="redisForm.port" />
                </div>
                <div class="field" style="margin-bottom: 0">
                  <label>DB 库号 (0-255)</label>
                  <input class="input mono" type="number" min="0" max="255" placeholder="0" v-model.number="redisForm.db" />
                </div>
              </div>
              <div class="grid-3" style="margin-bottom: 8px">
                <div class="field" style="margin-bottom: 0">
                  <label>统一键命名空间前缀（防冲突）</label>
                  <input
                    class="input mono"
                    placeholder="csync_saas:"
                    v-model="redisForm.key_prefix"
                    title="生产环境建议为每套环境设置唯一前缀，如 prod:csync_saas:"
                  />
                </div>
                <div class="field" style="margin-bottom: 0">
                  <label>用户名 (ACL 选填)</label>
                  <input class="input mono" placeholder="留空使用默认用户" v-model="redisForm.username" />
                </div>
                <div class="field" style="margin-bottom: 0">
                  <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                    <label style="margin: 0">认证密码（支持 @ # ! ? / 特殊字符）</label>
                    <div class="row" style="gap: 8px">
                      <label
                        v-if="runtimeInfo.cache?.redis_params?.has_password"
                        style="margin: 0; font-size: 11px; color: #f59e0b; cursor: pointer; display: inline-flex; align-items: center; gap: 3px"
                      >
                        <input type="checkbox" v-model="redisForm.clear_password" /> 清空密码
                      </label>
                      <button
                        type="button"
                        style="background: none; border: none; color: #38bdf8; cursor: pointer; font-size: 11px; padding: 0"
                        @click="showRedisPassword = !showRedisPassword"
                      >
                        {{ showRedisPassword ? '隐藏' : '显示' }}
                      </button>
                    </div>
                  </div>
                  <input
                    class="input mono"
                    :type="showRedisPassword ? 'text' : 'password'"
                    :disabled="redisForm.clear_password"
                    :placeholder="
                      runtimeInfo.cache?.redis_params?.has_password
                        ? '已保存密码（留空保持不变）'
                        : '无密码可留空；原生支持含 @ # ! 等特殊字符'
                    "
                    autocomplete="new-password"
                    v-model="redisForm.password"
                  />
                </div>
              </div>
              <div class="row" style="justify-content: space-between; gap: 10px">
                <label style="font-size: 12px; color: var(--text); cursor: pointer; display: inline-flex; align-items: center; gap: 6px">
                  <input type="checkbox" v-model="redisForm.tls" />
                  启用 TLS 加密连接 (<code class="mono">rediss://</code>)
                </label>
                <span class="muted mono" style="font-size: 11px">
                  生效键示例：{{ (redisForm.key_prefix || 'csync_saas:').replace(/:+$/, '') }}:setting:*
                </span>
              </div>
            </div>

            <div v-else class="grid-2" style="margin-bottom: 10px">
              <div class="field" style="margin-bottom: 0">
                <label>完整连接 URL（后端自动处理密码中的 @ # 等特殊字符）</label>
                <input
                  class="input mono"
                  :placeholder="
                    runtimeInfo.cache?.redis_url_masked
                      ? `当前已保存: ${runtimeInfo.cache.redis_url_masked}（留空可测试/沿用当前连接）`
                      : 'redis://:password@127.0.0.1:6379/0（支持 rediss:// TLS）'
                  "
                  v-model="redisUrlInput"
                />
              </div>
              <div class="field" style="margin-bottom: 0">
                <label>统一键命名空间前缀（生产防冲突）</label>
                <input class="input mono" placeholder="csync_saas:" v-model="redisForm.key_prefix" />
              </div>
            </div>

            <div class="row" style="gap: 8px">
              <button class="btn btn-sm" :disabled="testingRedis" @click="testRedisPing">
                {{ testingRedis ? 'PING 中...' : '在线测试 Redis PING' }}
              </button>
              <button class="btn btn-sm btn-primary" :disabled="reloadingRedis" @click="reloadRedis(false)">
                {{ reloadingRedis ? '热切换保存中...' : '一键热切换保存' }}
              </button>
              <button
                v-if="runtimeInfo.cache?.redis_configured"
                class="btn btn-sm"
                :disabled="reloadingRedis"
                @click="reloadRedis(true)"
              >
                切回 SQL Cache
              </button>
            </div>
            <div class="muted" style="font-size: 11px; margin-top: 6px">
              分项密码直接透传至 Redis 驱动（不经 URL 拼接解析），含 <code class="mono">@ # ! ? / %</code> 等任意特殊字符均不会解析失败；所有缓存与限流/流量键统一挂载在指定命名空间前缀下。
            </div>
          </template>
          <template v-else>
            <div class="row" style="justify-content: space-between; gap: 10px">
              <span class="muted" style="font-size: 12px">
                内置 SQLite WAL Cache 将缓存条目与高频计费/流量哈希缓冲保存在 <code class="mono">{{ runtimeInfo.cache?.sqlite_cache?.db_path || '/data/cache.db' }}</code>，无需外部 Redis 服务。
              </span>
              <button
                class="btn btn-sm btn-primary"
                :disabled="reloadingRedis || (!runtimeInfo.cache?.redis_configured && cacheState === 'sqlite_cache')"
                @click="reloadRedis(true)"
              >
                {{
                  reloadingRedis
                    ? '热切换保存中...'
                    : !runtimeInfo.cache?.redis_configured && cacheState === 'sqlite_cache'
                      ? '✓ 当前已是 SQL Cache'
                      : '一键热切换保存为 SQL Cache'
                }}
              </button>
            </div>
          </template>

          <div
            v-if="redisPingResult"
            class="banner mono"
            :class="redisPingResult.ok ? 'banner-success' : 'banner-danger'"
            style="margin-top: 10px; margin-bottom: 0; font-size: 12px"
          >
            <div class="row" style="justify-content: space-between">
              <span>{{ redisPingResult.ok ? '✓' : '✕' }} {{ redisPingResult.message }}</span>
              <span style="opacity: 0.75; font-size: 11px">{{ redisPingResult.testedAt }}</span>
            </div>
          </div>
        </div>

        <div class="grid-3">
          <div class="subcard">
            <div class="kpi-label">关系数据库引擎 (SQLAlchemy ORM)</div>
            <div class="mono" style="margin-top: 6px; font-weight: 600">
              {{ (runtimeInfo.db?.db_type || runtimeInfo.db?.dialect || 'sqlite').toUpperCase() }} · {{ runtimeInfo.db?.status || 'active' }}
            </div>
            <div class="muted mono" style="font-size: 11px; margin-top: 4px; word-break: break-all">
              {{ runtimeInfo.db?.target || '/data/app.db' }}
            </div>
          </div>
          <div class="subcard">
            <div class="kpi-label">防暴力破解 & 限流状态</div>
            <div class="mono muted" style="margin-top: 6px; font-size: 12px">
              活跃黑名单 IP: {{ runtimeInfo.antispam?.blocked_ips ?? 0 }} · 验证码桶: {{ runtimeInfo.antispam?.active_buckets ?? 0 }}
            </div>
          </div>
          <div class="subcard">
            <div class="row" style="justify-content: space-between">
              <div class="kpi-label">GeoIP 地区库 (geoip.dat)</div>
              <span class="tag" :class="runtimeInfo.geoip?.loaded ? 'tag-ok' : 'tag-warn'">
                {{ runtimeInfo.geoip?.loaded ? '已加载' : '未加载' }}
              </span>
            </div>
            <div class="mono muted" style="margin-top: 6px; font-size: 12px">
              <template v-if="runtimeInfo.geoip?.loaded">
                国家/地区 {{ runtimeInfo.geoip?.country_count || 0 }} · IPv4 {{ runtimeInfo.geoip?.ipv4_cidr_count || 0 }} · IPv6 {{ runtimeInfo.geoip?.ipv6_cidr_count || 0 }} ({{ runtimeInfo.geoip?.path }})
              </template>
              <template v-else>
                尚未检测到 geoip.dat（可点击下方在线下载到 /data/geoip.dat 或手动挂载）
              </template>
            </div>
            <div class="row" style="margin-top: 8px">
              <input
                class="input mono"
                style="flex: 1"
                v-model="geoipUrlInput"
                placeholder="镜像 URL（留空使用默认 Loyalsoldier geoip.dat）"
              />
              <button class="btn btn-sm btn-primary" :disabled="geoipUpdating" @click="updateGeoip">
                {{ geoipUpdating ? '下载更新中...' : '在线下载/更新' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 弹窗：后台新增用户 -->
    <div v-if="showCreateUserModal" class="modal-backdrop" @click.self="showCreateUserModal = false">
      <div class="modal-box">
        <div class="card-title">
          <span>新增平台账号（租户 / 子管理员）</span>
          <button class="btn btn-sm" @click="showCreateUserModal = false">关闭</button>
        </div>
        <form @submit.prevent="submitCreateUser">
          <div class="grid-2">
            <div class="field">
              <label>用户名（3~32 位字母/数字/下划线）</label>
              <input class="input mono" required v-model="createUserForm.username" />
            </div>
            <div class="field">
              <label>登录密码（至少 6 位）</label>
              <input class="input mono" type="password" required minlength="6" v-model="createUserForm.password" />
            </div>
            <div class="field">
              <label>绑定邮箱（选填）</label>
              <input class="input mono" type="email" placeholder="user@example.com" v-model="createUserForm.email" />
            </div>
            <div class="field">
              <label>初始角色</label>
              <select class="select" v-model="createUserForm.role">
                <option value="user">普通租户 (user)</option>
                <option value="admin">运营管理员 (admin)</option>
              </select>
            </div>
            <div class="field">
              <label>初始会员套餐</label>
              <select class="select" v-model.number="createUserForm.plan_id">
                <option v-for="p in plans" :key="p.id" :value="p.id">{{ p.name }} (¥{{ p.monthly_price_yuan }}/月)</option>
              </select>
            </div>
            <div class="field">
              <label>初始授信余额 (元)</label>
              <input class="input mono" type="number" step="0.5" min="0" v-model.number="createUserForm.initial_balance_yuan" />
            </div>
          </div>
          <div class="field">
            <label class="switch-row" :class="{ active: createUserForm.email_verified }">
              <span>
                <span class="switch-row-title">直接标记为已通过邮箱认证</span>
                <span class="switch-row-desc">{{ createUserForm.email_verified ? '创建后免收验证码，直接处于已认证状态' : '创建后需完成邮箱验证' }}</span>
              </span>
              <span class="switch">
                <input type="checkbox" v-model="createUserForm.email_verified" />
                <span class="switch-track"></span>
              </span>
            </label>
          </div>
          <div class="row" style="justify-content: flex-end">
            <button type="button" class="btn" :disabled="submittingUser" @click="showCreateUserModal = false">取消</button>
            <button type="submit" class="btn btn-primary" :disabled="submittingUser">
              {{ submittingUser ? '创建中...' : '确认创建账号' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 弹窗：编辑用户 · 调账 · 重置密码 -->
    <div v-if="editingUser" class="modal-backdrop" @click.self="editingUser = null">
      <div class="modal-box modal-box-lg">
        <div class="card-title">
          <span>编辑用户 · #{{ editingUser.id }} {{ editingUser.username }} (当前余额 ¥{{ editingUser.balance_yuan }})</span>
          <button class="btn btn-sm" @click="editingUser = null">关闭</button>
        </div>
        <form @submit.prevent="submitEditUser">
          <div class="grid-2">
            <div class="field">
              <label>账号角色</label>
              <select class="select" v-model="editUserForm.role" :disabled="Number(editingUser.id) === Number(currentUserId)">
                <option value="user">普通租户 (user)</option>
                <option value="admin">运营管理员 (admin)</option>
              </select>
            </div>
            <div class="field">
              <label>账号状态</label>
              <select class="select" v-model="editUserForm.status" :disabled="Number(editingUser.id) === Number(currentUserId)">
                <option value="active">正常启用 (active)</option>
                <option value="suspended">封禁停用 (suspended)</option>
              </select>
            </div>
            <div class="field">
              <label>绑定邮箱</label>
              <input class="input mono" type="email" placeholder="留空表示解绑邮箱" v-model="editUserForm.email" />
            </div>
            <div class="field">
              <label>邮箱认证状态</label>
              <label class="switch-row" :class="{ active: editUserForm.email_verified }" style="padding: 7px 12px">
                <span class="switch-row-title" style="font-size: 12px">{{ editUserForm.email_verified ? '已认证邮箱' : '未验证邮箱' }}</span>
                <span class="switch switch-sm">
                  <input type="checkbox" v-model="editUserForm.email_verified" />
                  <span class="switch-track"></span>
                </span>
              </label>
            </div>
            <div class="field">
              <label>会员套餐</label>
              <select class="select" v-model.number="editUserForm.plan_id">
                <option v-for="p in plans" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </div>
            <div class="field">
              <label>节点主等级</label>
              <select class="select" v-model.number="editUserForm.level_id">
                <option v-for="lv in levels" :key="lv.id" :value="lv.id">{{ lv.name }}</option>
              </select>
            </div>
          </div>

          <div class="field">
            <label class="switch-row" :class="{ active: editUserForm.level_locked }">
              <span>
                <span class="switch-row-title">锁定该用户的节点主等级</span>
                <span class="switch-row-desc">{{ editUserForm.level_locked ? '已锁定：不随 60s 自动升降级变动' : '未锁定：随节点在线与贡献自动升降级' }}</span>
              </span>
              <span class="switch">
                <input type="checkbox" v-model="editUserForm.level_locked" />
                <span class="switch-track"></span>
              </span>
            </label>
          </div>

          <div class="subcard" style="margin-bottom: 14px">
            <div class="grid-3">
              <div class="field" style="margin-bottom: 0">
                <label>余额人工调账 (元，正数加款 / 负数扣减)</label>
                <input class="input mono" type="number" step="0.01" v-model.number="editUserForm.adjust_balance_yuan" />
              </div>
              <div class="field" style="margin-bottom: 0">
                <label>调账流水摘要</label>
                <input class="input" placeholder="如：线下转账补发 / 违规扣罚" v-model="editUserForm.adjust_remark" />
              </div>
              <div class="field" style="margin-bottom: 0">
                <label>管理员强制重置密码（留空不改）</label>
                <input class="input mono" type="password" placeholder="至少 6 位新密码" v-model="editUserForm.new_password" />
              </div>
            </div>
          </div>

          <div class="row" style="justify-content: flex-end">
            <button type="button" class="btn" :disabled="submittingUser" @click="editingUser = null">取消</button>
            <button type="submit" class="btn btn-primary" :disabled="submittingUser">
              {{ submittingUser ? '保存中...' : '保存用户变更' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 弹窗：删除用户确认 -->
    <div v-if="confirmDeleteUserTarget" class="modal-backdrop" @click.self="confirmDeleteUserTarget = null">
      <div class="modal-box">
        <h3 class="card-title">确认删除账号 #{{ confirmDeleteUserTarget.id }}「{{ confirmDeleteUserTarget.username }}」？</h3>
        <p class="muted" style="margin: 0 0 18px">
          将清理该用户的同步策略、流水及账号数据；若名下仍有活跃租约或在线绑定节点，系统会自动安全拦截删除请求。
        </p>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" @click="confirmDeleteUserTarget = null">取消</button>
          <button class="btn btn-danger" @click="deleteUser(confirmDeleteUserTarget.id)">确认删除账号</button>
        </div>
      </div>
    </div>
    <!-- 弹窗：充值订单操作确认（取消/冲正退款/删除） -->
    <div v-if="pendingRechargeAction" class="modal-backdrop" @click.self="pendingRechargeAction = null">
      <div class="modal-box">
        <h3 class="card-title">
          <span v-if="pendingRechargeAction.type === 'cancel'">确认取消/关闭未支付订单 {{ pendingRechargeAction.order.order_no }}？</span>
          <span v-else-if="pendingRechargeAction.type === 'refund'">确认对已入账订单 {{ pendingRechargeAction.order.order_no }} 执行冲正退款？</span>
          <span v-else>确认删除已取消订单记录 {{ pendingRechargeAction.order.order_no }}？</span>
        </h3>
        <p class="muted" style="margin: 0 0 18px">
          <template v-if="pendingRechargeAction.type === 'cancel'">
            关闭后订单状态将变更为「已取消 (cancelled)」。若用户实际已在支付宝/微信扫码支付，后续仍可通过「官方查单」或异步回调自动补单入账。
          </template>
          <template v-else-if="pendingRechargeAction.type === 'refund'">
            将从租户「{{ pendingRechargeAction.order.username }}」余额中扣回 ¥{{ pendingRechargeAction.order.amount_yuan }} 并生成冲正流水（仅在租户余额充足时允许执行，平台内不做第三方原路打款）。
          </template>
          <template v-else>
            仅清理该笔已取消的无效订单记录，不影响已入账与已退款财务流水。
          </template>
        </p>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" @click="pendingRechargeAction = null">返回</button>
          <button
            class="btn"
            :class="pendingRechargeAction.type === 'cancel' ? 'btn-warn' : 'btn-danger'"
            @click="executeRechargeAction"
          >
            {{ pendingRechargeAction.type === 'cancel' ? '确认关闭订单' : pendingRechargeAction.type === 'refund' ? '确认冲正扣回' : '确认删除' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { apiFetch } from '../../api'
import AnnouncementManager from '../announcements/AnnouncementManager.vue'
import NotificationSettingsCard from '../notifications/NotificationSettingsCard.vue'

const props = defineProps({
  currentUserId: { type: Number, default: 0 },
})
const emit = defineEmits(['notify'])
const activeSection = ref('users')

const metrics = ref({})
const users = ref([])
const levels = ref([])
const plans = ref([])
const recentLeases = ref([])
const recharges = ref([])
const rechargeStatusFilter = ref('')
const pendingRechargeAction = ref(null)
const referralSummary = ref({})
const referralRewards = ref([])
const runtimeInfo = ref({})
const cacheTargetMode = ref('sqlite_cache')
const redisInputMode = ref('params') // 'params' | 'url'
const redisUrlInput = ref('')
const showRedisPassword = ref(false)
const redisForm = reactive({
  host: '',
  port: 6379,
  db: 0,
  username: '',
  password: '',
  tls: false,
  clear_password: false,
  key_prefix: 'csync_saas:',
})
const refreshingCache = ref(false)
const testingRedis = ref(false)
const reconnectingRedis = ref(false)
const redisPingResult = ref(null)
const geoipUrlInput = ref('')
const geoipUpdating = ref(false)
const refreshing = ref(false)
const savingSettings = ref(false)
const settingsSaveFeedback = reactive({ section: '', ok: true, text: '' })
const savingLevelId = ref(null)
const savedLevelId = ref(null)
const evaluatingLevels = ref(false)
const savingPlanId = ref(null)
const savedPlanId = ref(null)
const submittingUser = ref(false)
const busyUserId = ref(null)
const busyRechargeId = ref(null)
const busyRechargeType = ref('')
const revokingLeaseId = ref(null)
const reloadingRedis = ref(false)
let saveFeedbackTimer = null

const userSearch = ref('')
const userRoleFilter = ref('')
const userStatusFilter = ref('')
const userVerifiedFilter = ref('')

const showCreateUserModal = ref(false)
const createUserForm = reactive({
  username: '',
  email: '',
  password: '',
  role: 'user',
  plan_id: 1,
  level_id: 1,
  email_verified: true,
  initial_balance_yuan: 0,
})

const editingUser = ref(null)
const editUserForm = reactive({
  role: 'user',
  status: 'active',
  email: '',
  email_verified: true,
  plan_id: 1,
  level_id: 1,
  level_locked: false,
  adjust_balance_yuan: 0,
  adjust_remark: '',
  new_password: '',
})

const confirmDeleteUserTarget = ref(null)

const filteredUsers = computed(() => {
  let list = users.value
  if (userRoleFilter.value) {
    list = list.filter((u) => u.role === userRoleFilter.value)
  }
  if (userStatusFilter.value) {
    list = list.filter((u) => u.status === userStatusFilter.value)
  }
  if (userVerifiedFilter.value === 'verified') {
    list = list.filter((u) => Boolean(u.email_verified))
  } else if (userVerifiedFilter.value === 'unverified') {
    list = list.filter((u) => !u.email_verified)
  }
  const q = userSearch.value.trim().toLowerCase()
  if (q) {
    list = list.filter(
      (u) =>
        String(u.id).includes(q) ||
        (u.username && u.username.toLowerCase().includes(q)) ||
        (u.email && u.email.toLowerCase().includes(q)) ||
        (u.invite_code && u.invite_code.toLowerCase().includes(q)),
    )
  }
  return list
})

const filteredRecharges = computed(() => {
  if (!rechargeStatusFilter.value) return recharges.value
  return recharges.value.filter((o) => o.status === rechargeStatusFilter.value)
})

function rechargeStatusMeta(status) {
  switch (status) {
    case 'paid':
      return { label: '已入账', cls: 'tag-ok' }
    case 'cancelled':
      return { label: '已取消', cls: 'tag-danger' }
    case 'refunded':
      return { label: '已退款', cls: 'tag-info' }
    default:
      return { label: '待支付', cls: 'tag-warn' }
  }
}

const baseOrigin = computed(() => {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin
  return 'https://your-saas-hub.example.com'
})

const defaultAlipayNotifyUrl = computed(() => `${baseOrigin.value}/api/billing/recharge/notify/alipay`)
const defaultWechatNotifyUrl = computed(() => `${baseOrigin.value}/api/billing/recharge/notify/wechat`)
const defaultReturnUrl = computed(() => `${baseOrigin.value}/`)

const activePaymentHelp = ref('')
function togglePaymentHelp(key) {
  activePaymentHelp.value = activePaymentHelp.value === key ? '' : key
}

const settings = reactive({
  saas_reverse_fee_bps: 2500,
  saas_public_wss_fee_bps: 1000,
  saas_market_base_hour_yuan: 0.5,
  saas_market_base_gb_yuan: 1.0,
  saas_self_reverse_hub_gb_yuan: 0.2,
  saas_auto_level_enabled: true,
  saas_allow_public_register: true,
  saas_require_email_verify: true,
  saas_referral_enabled: true,
  saas_referral_inviter_bonus_yuan: 5,
  saas_referral_invitee_bonus_yuan: 3,
  saas_allow_self_recharge: true,
  saas_welcome_bonus_yuan: 10,
  saas_monthly_claim_enabled: true,
  saas_monthly_claim_yuan: 10,
  saas_daily_checkin_enabled: true,
  saas_daily_checkin_yuan: 0.5,
  saas_daily_streak_bonus_yuan: 0.1,
  saas_alipay_enabled: true,
  saas_alipay_mode: 'precreate',
  saas_alipay_sign_mode: 'public_key',
  saas_alipay_f2f_enabled: true,
  saas_alipay_page_enabled: true,
  saas_alipay_static_enabled: false,
  saas_alipay_app_id: '',
  saas_alipay_private_key: '',
  saas_alipay_private_key_set: false,
  saas_alipay_public_key: '',
  saas_alipay_app_cert: '',
  saas_alipay_cert_public_key: '',
  saas_alipay_root_cert: '',
  saas_alipay_gateway_url: 'https://openapi.alipay.com/gateway.do',
  saas_alipay_notify_url: '',
  saas_alipay_return_url: '',
  saas_alipay_qr_url: '',
  saas_wechat_enabled: true,
  saas_wechat_mode: 'native_v3',
  saas_wechat_native_enabled: true,
  saas_wechat_static_enabled: false,
  saas_wechat_app_id: '',
  saas_wechat_mch_id: '',
  saas_wechat_serial_no: '',
  saas_wechat_private_key: '',
  saas_wechat_private_key_set: false,
  saas_wechat_api_v3_key: '',
  saas_wechat_api_v3_key_set: false,
  saas_wechat_platform_public_key: '',
  saas_wechat_gateway_url: 'https://api.mch.weixin.qq.com',
  saas_wechat_notify_url: '',
  saas_wechat_qr_url: '',
  saas_payment_notify_secret: '',
  saas_payment_notify_secret_set: false,
})

const enabledAlipayMethodCount = computed(
  () =>
    (settings.saas_alipay_f2f_enabled ? 1 : 0) +
    (settings.saas_alipay_page_enabled ? 1 : 0) +
    (settings.saas_alipay_static_enabled ? 1 : 0),
)

const enabledWechatMethodCount = computed(
  () => (settings.saas_wechat_native_enabled ? 1 : 0) + (settings.saas_wechat_static_enabled ? 1 : 0),
)

function nowTimeStr() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

function setSaveFeedback(section, ok, text) {
  settingsSaveFeedback.section = section
  settingsSaveFeedback.ok = ok
  settingsSaveFeedback.text = text
  clearTimeout(saveFeedbackTimer)
  saveFeedbackTimer = setTimeout(() => {
    settingsSaveFeedback.text = ''
  }, ok ? 6000 : 8000)
}

function loadTextFile(event, targetKey) {
  const file = event?.target?.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    settings[targetKey] = String(reader.result || '').trim()
    emit('notify', `已读取文件 ${file.name}，请点击「保存全部支付网关参数」生效`)
  }
  reader.readAsText(file)
  event.target.value = ''
}

async function load(showFeedback = false) {
  if (showFeedback) refreshing.value = true
  try {
    const [ov, us, rc, refRes] = await Promise.all([
      apiFetch('/api/admin/overview'),
      apiFetch('/api/admin/users'),
      apiFetch('/api/admin/recharges'),
      apiFetch('/api/admin/referrals'),
    ])
    metrics.value = ov.metrics || {}
    Object.assign(settings, ov.settings || {})
    // Always keep write-only secret inputs empty after load
    settings.saas_alipay_private_key = ''
    settings.saas_wechat_private_key = ''
    settings.saas_wechat_api_v3_key = ''
    settings.saas_payment_notify_secret = ''

    levels.value = ov.levels || []
    plans.value = (ov.plans || []).map((p) => ({
      ...p,
      edit_price_yuan: Number(((p.monthly_price_units || 0) / 10000).toFixed(2)),
      edit_traffic_gb: Math.max(1, Math.round((p.max_monthly_traffic_bytes || 0) / 1024 ** 3)),
      edit_can_share: Boolean(p.can_share_nodes),
    }))
    runtimeInfo.value = ov.runtime || {}
    syncRedisFormFromCache(runtimeInfo.value?.cache)
    recentLeases.value = ov.recent_leases || []
    users.value = us || []
    recharges.value = rc.orders || []
    referralSummary.value = refRes.summary || {}
    referralRewards.value = refRes.rewards || []
    if (showFeedback) {
      emit('notify', { message: '管理台数据已刷新', type: 'ok' })
    }
  } catch (e) {
    emit('notify', { message: e.message || '加载管理台数据失败', type: 'error' })
  } finally {
    if (showFeedback) refreshing.value = false
  }
}

const NUMERIC_SETTING_KEYS = [
  'saas_platform_fee_bps',
  'saas_reverse_fee_bps',
  'saas_public_wss_fee_bps',
  'saas_market_base_hour_yuan',
  'saas_market_base_gb_yuan',
  'saas_self_reverse_hub_gb_yuan',
  'saas_referral_inviter_bonus_yuan',
  'saas_referral_invitee_bonus_yuan',
  'saas_welcome_bonus_yuan',
  'saas_monthly_claim_yuan',
  'saas_daily_checkin_yuan',
  'saas_daily_streak_bonus_yuan',
]

async function saveSettings(section = activeSection.value) {
  if (savingSettings.value) return
  savingSettings.value = true
  try {
    const payload = { ...settings }
    payload.saas_alipay_enabled = enabledAlipayMethodCount.value > 0
    payload.saas_wechat_enabled = enabledWechatMethodCount.value > 0

    for (const k of NUMERIC_SETTING_KEYS) {
      const val = payload[k]
      if (val === '' || val === null || val === undefined || Number.isNaN(Number(val))) {
        delete payload[k]
      } else {
        payload[k] = Number(val)
      }
    }

    if (!payload.saas_alipay_private_key) delete payload.saas_alipay_private_key
    if (!payload.saas_wechat_private_key) delete payload.saas_wechat_private_key
    if (!payload.saas_wechat_api_v3_key) delete payload.saas_wechat_api_v3_key
    if (!payload.saas_payment_notify_secret) delete payload.saas_payment_notify_secret
    delete payload.saas_alipay_private_key_set
    delete payload.saas_wechat_private_key_set
    delete payload.saas_wechat_api_v3_key_set
    delete payload.saas_payment_notify_secret_set

    const res = await apiFetch('/api/admin/settings', { method: 'POST', body: JSON.stringify(payload) })
    const msg = res?.message || '设置已保存生效'
    setSaveFeedback(section, true, `✓ 已保存 ${nowTimeStr()}`)
    emit('notify', { message: msg, type: 'ok' })
    await load(false)
  } catch (e) {
    const errMsg = e?.message || '保存设置失败'
    setSaveFeedback(section, false, `✕ 保存失败`)
    emit('notify', { message: `保存失败：${errMsg}`, type: 'error' })
  } finally {
    savingSettings.value = false
  }
}

async function savePlan(p) {
  if (savingPlanId.value !== null) return
  savingPlanId.value = p.id
  try {
    const res = await apiFetch(`/api/admin/plans/${p.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: p.name,
        monthly_price_yuan: Number(p.edit_price_yuan || 0),
        max_nodes: Number(p.max_nodes || 1),
        max_active_leases: Number(p.max_active_leases || 1),
        max_monthly_traffic_gb: Number(p.edit_traffic_gb || 1),
        platform_fee_discount_bps: Number(p.platform_fee_discount_bps || 0),
        can_share_nodes: Boolean(p.edit_can_share),
      }),
    })
    savedPlanId.value = p.id
    setTimeout(() => {
      if (savedPlanId.value === p.id) savedPlanId.value = null
    }, 2400)
    emit('notify', { message: res?.message || '套餐配置已保存', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message || '保存套餐失败', type: 'error' })
  } finally {
    savingPlanId.value = null
  }
}

async function queryRecharge(orderId) {
  if (busyRechargeId.value !== null) return
  busyRechargeId.value = orderId
  busyRechargeType.value = 'query'
  try {
    const res = await apiFetch(`/api/admin/recharges/${orderId}/query`, { method: 'POST' })
    emit('notify', res.message || '查单已完成')
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message || '查单失败', type: 'error' })
  } finally {
    busyRechargeId.value = null
    busyRechargeType.value = ''
  }
}

async function confirmRecharge(orderId) {
  if (busyRechargeId.value !== null) return
  busyRechargeId.value = orderId
  busyRechargeType.value = 'confirm'
  try {
    const res = await apiFetch(`/api/admin/recharges/${orderId}/confirm`, { method: 'POST' })
    emit('notify', { message: res.message || '已确认到账', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message || '确认到账失败', type: 'error' })
  } finally {
    busyRechargeId.value = null
    busyRechargeType.value = ''
  }
}

async function executeRechargeAction() {
  const act = pendingRechargeAction.value
  if (!act?.order || busyRechargeId.value !== null) return
  pendingRechargeAction.value = null
  busyRechargeId.value = act.order.id
  busyRechargeType.value = act.type
  try {
    let res
    if (act.type === 'cancel') {
      res = await apiFetch(`/api/admin/recharges/${act.order.id}/cancel`, { method: 'POST' })
    } else if (act.type === 'refund') {
      res = await apiFetch(`/api/admin/recharges/${act.order.id}/refund`, { method: 'POST' })
    } else {
      res = await apiFetch(`/api/admin/recharges/${act.order.id}`, { method: 'DELETE' })
    }
    emit('notify', { message: res.message || '操作已完成', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message || '订单操作失败', type: 'error' })
  } finally {
    busyRechargeId.value = null
    busyRechargeType.value = ''
  }
}

async function saveLevel(lv) {
  if (savingLevelId.value !== null) return
  savingLevelId.value = lv.id
  try {
    const res = await apiFetch(`/api/admin/levels/${lv.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        min_online_hours: Number(lv.min_online_hours || 0),
        min_contributed_gb: Number(lv.min_contributed_gb || 0),
        max_avg_latency_ms: Number(lv.max_avg_latency_ms || 0),
        min_speed_kbps: Number(lv.min_speed_kbps || 0),
        reverse_fee_bps: Number(lv.reverse_fee_bps || 0),
        public_wss_fee_bps: Number(lv.public_wss_fee_bps || 0),
        buyer_discount_bps: Number(lv.buyer_discount_bps || 0),
      }),
    })
    savedLevelId.value = lv.id
    setTimeout(() => {
      if (savedLevelId.value === lv.id) savedLevelId.value = null
    }, 2400)
    emit('notify', { message: res?.message || '等级策略已保存', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message || '保存等级失败', type: 'error' })
  } finally {
    savingLevelId.value = null
  }
}

async function evaluateAllLevels() {
  if (evaluatingLevels.value) return
  evaluatingLevels.value = true
  try {
    const res = await apiFetch('/api/admin/levels/evaluate', { method: 'POST' })
    emit('notify', { message: res.message || '全网自动评级已完成', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message || '执行评级失败', type: 'error' })
  } finally {
    evaluatingLevels.value = false
  }
}

function openCreateUserModal() {
  Object.assign(createUserForm, {
    username: '',
    email: '',
    password: '',
    role: 'user',
    plan_id: plans.value[0]?.id || 1,
    level_id: levels.value[0]?.id || 1,
    email_verified: true,
    initial_balance_yuan: 0,
  })
  showCreateUserModal.value = true
}

async function submitCreateUser() {
  if (submittingUser.value) return
  submittingUser.value = true
  try {
    const res = await apiFetch('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(createUserForm),
    })
    showCreateUserModal.value = false
    emit('notify', { message: res.message || '账号创建成功', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message || '创建账号失败', type: 'error' })
  } finally {
    submittingUser.value = false
  }
}

function openEditUserModal(u) {
  editingUser.value = u
  Object.assign(editUserForm, {
    role: u.role || 'user',
    status: u.status || 'active',
    email: u.email || '',
    email_verified: Boolean(u.email_verified),
    plan_id: Number(u.plan_id || 1),
    level_id: Number(u.level_id || 1),
    level_locked: Boolean(u.level_locked),
    adjust_balance_yuan: 0,
    adjust_remark: '',
    new_password: '',
  })
}

async function submitEditUser() {
  if (!editingUser.value || submittingUser.value) return
  submittingUser.value = true
  try {
    const payload = {
      role: editUserForm.role,
      status: editUserForm.status,
      email: editUserForm.email,
      email_verified: editUserForm.email_verified,
      plan_id: editUserForm.plan_id,
      level_id: editUserForm.level_id,
      level_locked: editUserForm.level_locked,
    }
    if (editUserForm.adjust_balance_yuan && Math.abs(editUserForm.adjust_balance_yuan) > 0) {
      payload.adjust_balance_yuan = editUserForm.adjust_balance_yuan
      payload.adjust_remark = editUserForm.adjust_remark || '管理员后台调账'
    }
    if (editUserForm.new_password && editUserForm.new_password.trim()) {
      payload.new_password = editUserForm.new_password.trim()
    }
    const res = await apiFetch(`/api/admin/users/${editingUser.value.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
    editingUser.value = null
    emit('notify', { message: res.message || '账号变更已保存', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message || '保存用户变更失败', type: 'error' })
  } finally {
    submittingUser.value = false
  }
}

async function toggleUserStatus(u) {
  if (busyUserId.value !== null) return
  busyUserId.value = u.id
  try {
    const next = u.status === 'active' ? 'suspended' : 'active'
    const res = await apiFetch(`/api/admin/users/${u.id}`, {
      method: 'PUT',
      body: JSON.stringify({ status: next }),
    })
    emit('notify', { message: res.message || '账号状态已更新', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message || '更新账号状态失败', type: 'error' })
  } finally {
    busyUserId.value = null
  }
}

async function deleteUser(uid) {
  confirmDeleteUserTarget.value = null
  if (busyUserId.value !== null) return
  busyUserId.value = uid
  try {
    const res = await apiFetch(`/api/admin/users/${uid}`, { method: 'DELETE' })
    emit('notify', { message: res.message || '账号已移除', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message || '删除账号失败', type: 'error' })
  } finally {
    busyUserId.value = null
  }
}

async function revokeLease(id) {
  if (revokingLeaseId.value !== null) return
  revokingLeaseId.value = id
  try {
    const res = await apiFetch(`/api/admin/leases/${id}/revoke`, { method: 'POST' })
    emit('notify', { message: res.message || '租约已强断结算', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message || '强断租约失败', type: 'error' })
  } finally {
    revokingLeaseId.value = null
  }
}

const cacheState = computed(() => {
  const c = runtimeInfo.value?.cache || {}
  if (c.engine_state) return c.engine_state
  if (c.active_backend === 'redis') return 'redis'
  return c.redis_configured ? 'degraded' : 'sqlite_cache'
})

const cacheBadgeMeta = computed(() => {
  if (cacheState.value === 'redis') return { label: 'Redis 运行中', cls: 'tag-ok' }
  if (cacheState.value === 'degraded') return { label: 'Redis 已降级 · SQL Cache 兜底', cls: 'tag-danger' }
  return { label: 'SQLite WAL Cache', cls: 'tag-info' }
})

const cacheHits = computed(() => Number(runtimeInfo.value?.cache?.hits ?? runtimeInfo.value?.cache?.stats?.hits ?? 0))
const cacheMisses = computed(() => Number(runtimeInfo.value?.cache?.misses ?? runtimeInfo.value?.cache?.stats?.misses ?? 0))
const cacheFallbacks = computed(() => Number(runtimeInfo.value?.cache?.fallback_count ?? runtimeInfo.value?.cache?.stats?.fallbacks ?? 0))
const cacheHitRate = computed(() => {
  const r = runtimeInfo.value?.cache?.hit_rate
  if (r !== undefined && r !== null) return Number(r).toFixed(1)
  const total = cacheHits.value + cacheMisses.value
  return total > 0 ? ((cacheHits.value / total) * 100).toFixed(1) : '0.0'
})

const cacheConfigSourceLabel = computed(() => {
  const src = runtimeInfo.value?.cache?.config_source
  if (src === 'bootstrap') return '后台持久化 (bootstrap.json)'
  if (src === 'env') return '环境变量 (REDIS_URL)'
  return '默认内置'
})

async function refreshCacheStatus(showNotice = true) {
  if (refreshingCache.value) return
  refreshingCache.value = true
  try {
    const status = await apiFetch('/api/system/cache/status')
    runtimeInfo.value = { ...runtimeInfo.value, cache: status }
    if (showNotice) {
      emit('notify', { message: `已刷新缓存状态：${status.engine_label || cacheState.value}`, type: 'ok' })
    }
  } catch (e) {
    emit('notify', { message: e.message || '刷新缓存状态失败', type: 'error' })
  } finally {
    refreshingCache.value = false
  }
}

function syncRedisFormFromCache(cacheObj) {
  if (!cacheObj || typeof cacheObj !== 'object') return
  cacheTargetMode.value = cacheObj.redis_configured ? 'redis' : 'sqlite_cache'
  const p = cacheObj.redis_params || {}
  redisForm.host = p.host || ''
  redisForm.port = Number(p.port || 6379)
  redisForm.db = Number(p.db || 0)
  redisForm.username = p.username || ''
  redisForm.tls = Boolean(p.tls)
  redisForm.password = ''
  redisForm.clear_password = false
  redisForm.key_prefix = cacheObj.key_prefix || p.key_prefix || cacheObj.default_key_prefix || 'csync_saas:'
}

function buildRedisPayload(forReload = false) {
  const prefix = (redisForm.key_prefix || '').trim() || runtimeInfo.value?.cache?.default_key_prefix || 'csync_saas:'
  if (redisInputMode.value === 'url') {
    const rawUrl = redisUrlInput.value.trim()
    const useCurrent = !rawUrl && Boolean(runtimeInfo.value?.cache?.redis_configured)
    return {
      ready: Boolean(rawUrl || useCurrent),
      missingMsg: '请先输入 Redis 连接串，或切换至「分项参数表单」',
      payload: {
        ...(forReload ? { mode: 'redis' } : {}),
        redis_url: rawUrl,
        key_prefix: prefix,
        use_current: useCurrent,
      },
    }
  }
  const host = (redisForm.host || '').trim()
  const useCurrent = !host && Boolean(runtimeInfo.value?.cache?.redis_configured)
  return {
    ready: Boolean(host || useCurrent),
    missingMsg: '请先输入 Redis 服务器主机地址（如 127.0.0.1）',
    payload: {
      ...(forReload ? { mode: 'redis' } : {}),
      redis_host: host,
      redis_port: Number(redisForm.port || 6379),
      redis_db: Number(redisForm.db || 0),
      redis_username: (redisForm.username || '').trim(),
      redis_password: redisForm.clear_password ? '' : redisForm.password,
      redis_tls: Boolean(redisForm.tls),
      keep_password: !redisForm.clear_password,
      clear_password: Boolean(redisForm.clear_password),
      key_prefix: prefix,
      use_current: useCurrent,
    },
  }
}

async function testRedisPing() {
  if (testingRedis.value) return
  const req = buildRedisPayload(false)
  if (!req.ready) {
    redisPingResult.value = {
      ok: false,
      message: req.missingMsg,
      testedAt: nowTimeStr(),
    }
    return
  }
  testingRedis.value = true
  redisPingResult.value = null
  try {
    const res = await apiFetch('/api/system/cache/test', {
      method: 'POST',
      body: JSON.stringify(req.payload),
    })
    const testedAt = nowTimeStr()
    if (res.ok) {
      redisPingResult.value = {
        ok: true,
        message: res.message || `PONG · Redis 连接成功 (${res.latency_ms ?? '?'}ms)`,
        testedAt,
      }
      emit('notify', { message: redisPingResult.value.message, type: 'ok' })
    } else {
      redisPingResult.value = {
        ok: false,
        message: res.detail || res.message || 'Redis PING 失败',
        testedAt,
      }
      emit('notify', { message: redisPingResult.value.message, type: 'error' })
    }
  } catch (e) {
    redisPingResult.value = {
      ok: false,
      message: e.message || 'Redis PING 失败',
      testedAt: nowTimeStr(),
    }
    emit('notify', { message: redisPingResult.value.message, type: 'error' })
  } finally {
    testingRedis.value = false
  }
}

async function reloadRedis(forceSqlite = false) {
  if (reloadingRedis.value) return
  const targetMode = forceSqlite ? 'sqlite_cache' : cacheTargetMode.value
  let bodyPayload

  if (targetMode === 'sqlite_cache') {
    bodyPayload = {
      mode: 'sqlite_cache',
      redis_url: '',
      key_prefix: (redisForm.key_prefix || '').trim() || runtimeInfo.value?.cache?.default_key_prefix || 'csync_saas:',
    }
  } else {
    const req = buildRedisPayload(true)
    if (!req.ready) {
      emit('notify', { message: req.missingMsg, type: 'error' })
      return
    }
    bodyPayload = req.payload
  }

  reloadingRedis.value = true
  try {
    const res = await apiFetch('/api/system/cache/reload', {
      method: 'POST',
      body: JSON.stringify(bodyPayload),
    })
    if (res.cache) {
      runtimeInfo.value = { ...runtimeInfo.value, cache: res.cache }
      syncRedisFormFromCache(res.cache)
    }
    if (targetMode === 'sqlite_cache' || res.ok) {
      redisUrlInput.value = ''
      redisForm.password = ''
      redisForm.clear_password = false
    }
    emit('notify', {
      message: res.message || '缓存后端已热切换并保存',
      type: res.ok === false || res.degraded ? 'error' : 'ok',
    })
  } catch (e) {
    emit('notify', { message: e.message || '热切换缓存失败', type: 'error' })
  } finally {
    reloadingRedis.value = false
  }
}

async function reconnectRedisNow() {
  if (reconnectingRedis.value) return
  reconnectingRedis.value = true
  try {
    const res = await apiFetch('/api/system/cache/reload', {
      method: 'POST',
      body: JSON.stringify({ reconnect_only: true }),
    })
    if (res.cache) {
      runtimeInfo.value = { ...runtimeInfo.value, cache: res.cache }
      syncRedisFormFromCache(res.cache)
    }
    emit('notify', {
      message: res.message || res.detail || '已完成重连探测',
      type: res.ok ? 'ok' : 'error',
    })
  } catch (e) {
    emit('notify', { message: e.message || '重连探测失败', type: 'error' })
  } finally {
    reconnectingRedis.value = false
  }
}

async function updateGeoip() {
  if (geoipUpdating.value) return
  geoipUpdating.value = true
  try {
    const res = await apiFetch('/api/admin/geoip/update', {
      method: 'POST',
      body: JSON.stringify({ url: geoipUrlInput.value.trim() }),
    })
    emit('notify', { message: res.message || 'geoip.dat 已更新加载', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message || 'GeoIP 更新失败', type: 'error' })
  } finally {
    geoipUpdating.value = false
  }
}

onMounted(() => load(false))
</script>
