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
      </button>
    </div>

    <!-- 分区 0：独立用户管理模块 -->
    <template v-if="activeSection === 'users'">
      <div class="card">
        <div class="card-title">
          <span>用户管理 · 新增 / 资料认证 / 密码重置 / 调账 / 封禁与删除</span>
          <div class="row">
            <button class="btn btn-sm" @click="load">刷新列表</button>
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
                      :disabled="Number(u.id) === Number(currentUserId)"
                      @click="toggleUserStatus(u)"
                    >
                      {{ u.status === 'active' ? '封禁' : '解封' }}
                    </button>
                    <button
                      class="btn btn-sm btn-danger"
                      :disabled="Number(u.id) === Number(currentUserId)"
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
          <button class="btn btn-sm btn-primary" @click="saveSettings">保存差价与评级策略</button>
        </div>
        <div class="grid-4">
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
          <div class="subcard">
            <div class="field" style="margin-bottom: 0">
              <label>自动评级 / 降级调度</label>
              <select class="select" v-model="settings.saas_auto_level_enabled">
                <option :value="true">开启 60s 自动升降级</option>
                <option :value="false">暂停自动升降级</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>用户等级自动升降级门槛 & 分级差价策略</span>
          <button class="btn btn-sm btn-emerald" @click="evaluateAllLevels">立即执行全网自动评级 / 降级</button>
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
                <td><button class="btn btn-sm btn-primary" @click="saveLevel(lv)">保存</button></td>
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
                  <select class="select" style="width: 86px" v-model="p.edit_can_share">
                    <option :value="true">允许</option>
                    <option :value="false">禁止</option>
                  </select>
                </td>
                <td><button class="btn btn-sm btn-primary" @click="savePlan(p)">保存</button></td>
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
          <button class="btn btn-sm btn-primary" @click="saveSettings">保存成长与补贴配置</button>
        </div>

        <div class="grid-3">
          <div class="subcard">
            <div class="card-title" style="font-size: 14px; margin-bottom: 10px">注册风控与体验金</div>
            <div class="field">
              <label>公开注册开关</label>
              <select class="select" v-model="settings.saas_allow_public_register">
                <option :value="true">开放公开注册</option>
                <option :value="false">仅限管理员分配</option>
              </select>
            </div>
            <div class="field">
              <label>新用户注册邮箱验证码认证</label>
              <select class="select" v-model="settings.saas_require_email_verify">
                <option :value="true">强制验证邮箱验证码</option>
                <option :value="false">关闭邮箱验证码校验</option>
              </select>
            </div>
            <div class="field" style="margin-bottom: 0">
              <label>新用户注册体验赠金 (元)</label>
              <input class="input mono" type="number" step="0.5" min="0" v-model.number="settings.saas_welcome_bonus_yuan" />
            </div>
          </div>

          <div class="subcard">
            <div class="card-title" style="font-size: 14px; margin-bottom: 10px">推荐邀请返利策略</div>
            <div class="field">
              <label>推荐邀请奖励开关</label>
              <select class="select" v-model="settings.saas_referral_enabled">
                <option :value="true">开启邀请返利系统</option>
                <option :value="false">关闭邀请返利</option>
              </select>
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
                <select class="select" style="width: 90px" v-model="settings.saas_monthly_claim_enabled">
                  <option :value="true">开启</option>
                  <option :value="false">关闭</option>
                </select>
                <input class="input mono" type="number" step="1" min="0" style="flex: 1" v-model.number="settings.saas_monthly_claim_yuan" />
              </div>
            </div>
            <div class="field">
              <label>每日签到开关 & 基础奖励 (元)</label>
              <div class="row">
                <select class="select" style="width: 90px" v-model="settings.saas_daily_checkin_enabled">
                  <option :value="true">开启</option>
                  <option :value="false">关闭</option>
                </select>
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
          <button class="btn btn-sm btn-primary" @click="saveSettings">保存全部支付网关参数</button>
        </div>

        <div class="grid-2" style="margin-bottom: 14px">
          <div class="subcard">
            <div class="field" style="margin-bottom: 0">
              <label>沙盒模拟演练开关（仅在未配置官方密钥与收款码时作为演示通道 · 数据不落盘）</label>
              <select class="select" v-model="settings.saas_allow_self_recharge">
                <option :value="true">开启沙盒演练（纯模拟流程，不写入数据库与真实余额）</option>
                <option :value="false">关闭沙盒（生产模式：仅允许已配置的官方网关或人工收款码）</option>
              </select>
            </div>
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
            <strong style="font-size: 13px; color: var(--text-strong)">前台可用支付方式开关（支持手动多选开放或逐项关闭，未勾选项前台自动隐藏）</strong>
            <span class="muted" style="font-size: 12px">勾选几项，租户端「在线钱包充值收银台」就显示几项；修改后请点击右上角「保存全部支付网关参数」</span>
          </div>
          <div class="grid-3">
            <label class="row" style="cursor: pointer; justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px">
              <span>
                <strong style="display: block; font-size: 13px">支付宝当面付</strong>
                <span class="muted" style="font-size: 11px">官方 `precreate` 网页动态出码 · 自动到账</span>
              </span>
              <input type="checkbox" v-model="settings.saas_alipay_f2f_enabled" />
            </label>
            <label class="row" style="cursor: pointer; justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px">
              <span>
                <strong style="display: block; font-size: 13px">支付宝电脑网站支付</strong>
                <span class="muted" style="font-size: 11px">官方 `page.pay` 跳转网页收银台</span>
              </span>
              <input type="checkbox" v-model="settings.saas_alipay_page_enabled" />
            </label>
            <label class="row" style="cursor: pointer; justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px">
              <span>
                <strong style="display: block; font-size: 13px">支付宝扫码转账（人工核账）</strong>
                <span class="muted" style="font-size: 11px">展示固定收款码 · 人工确认入账</span>
              </span>
              <input type="checkbox" v-model="settings.saas_alipay_static_enabled" />
            </label>
            <label class="row" style="cursor: pointer; justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px">
              <span>
                <strong style="display: block; font-size: 13px">微信支付 Native V3</strong>
                <span class="muted" style="font-size: 11px">官方直连 V3 动态扫码 · 自动到账</span>
              </span>
              <input type="checkbox" v-model="settings.saas_wechat_native_enabled" />
            </label>
            <label class="row" style="cursor: pointer; justify-content: space-between; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px">
              <span>
                <strong style="display: block; font-size: 13px">微信扫码转账（人工核账）</strong>
                <span class="muted" style="font-size: 11px">展示固定收款码 · 人工确认入账</span>
              </span>
              <input type="checkbox" v-model="settings.saas_wechat_static_enabled" />
            </label>
          </div>
        </div>

        <div class="grid-2">
          <!-- 支付宝开放平台子卡 -->
          <div class="subcard">
            <div class="card-title" style="font-size: 14px; margin-bottom: 10px">
              <span>支付宝开放平台配置 (当面付 / 电脑网站 / 人工收款码)</span>
              <span class="tag" :class="settings.saas_alipay_enabled ? 'tag-ok' : ''">{{ settings.saas_alipay_enabled ? '总开关已启用' : '总开关已关闭' }}</span>
            </div>
            <div class="banner banner-info" style="font-size: 12px; margin-bottom: 12px">
              <strong>开放平台对接提示：</strong>支付宝开放平台里的「授权回调地址」「应用网关」「接口内容加密方式 (AES)」均<strong>留空/未设置</strong>即可；支付所需的 <code>notify_url</code> 会在每次下单时由本系统自动携带。加签方式如在开放平台选了<strong>「密钥/普通公钥」</strong>请选公钥模式，选了<strong>「证书」</strong>请切换为公钥证书模式并读取 3 个 <code>.crt</code> 证书文件。
            </div>
            <div class="grid-3">
              <div class="field">
                <label>支付宝总开关（关闭则隐藏全部支付宝方式）</label>
                <select class="select" v-model="settings.saas_alipay_enabled">
                  <option :value="true">启用支付宝通道</option>
                  <option :value="false">关闭全部支付宝</option>
                </select>
              </div>
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
              <span class="tag" :class="settings.saas_wechat_enabled ? 'tag-ok' : ''">{{ settings.saas_wechat_enabled ? '已启用' : '已关闭' }}</span>
            </div>
            <div class="banner banner-info" style="font-size: 12px; margin-bottom: 12px">
              <strong>微信商户平台所需 6 项核心信息：</strong>① 绑定的公众号/小程序/开放平台 <strong>AppID</strong>；② <strong>商户号 MchID</strong>；③ <strong>APIv3 密钥（32位）</strong>；④ <strong>商户 API 证书序列号</strong>；⑤ <strong>商户 API 私钥 (`apiclient_key.pem`)</strong>；⑥ <strong>微信支付公钥或平台证书</strong>（强烈建议填写，用于校验微信回调签名防伪造）。
            </div>
            <div class="grid-2">
              <div class="field">
                <label>微信总开关（关闭则隐藏全部微信方式）</label>
                <select class="select" v-model="settings.saas_wechat_enabled">
                  <option :value="true">启用微信支付</option>
                  <option :value="false">停用微信支付</option>
                </select>
              </div>
              <div class="field">
                <label>默认下单模式（二选一）</label>
                <select class="select" v-model="settings.saas_wechat_mode">
                  <option value="native_v3">Native V3 扫码下单 (官方推荐)</option>
                  <option value="static_qr">人工收款码转账（扫码付款 · 人工核账）</option>
                </select>
              </div>
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
            <button class="btn btn-sm" @click="load">刷新订单列表</button>
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
                    <button class="btn btn-sm btn-primary" @click="queryRecharge(o.id)">官方查单</button>
                    <button class="btn btn-sm btn-emerald" @click="confirmRecharge(o.id)">人工确认到账</button>
                    <button class="btn btn-sm btn-warn" @click="pendingRechargeAction = { type: 'cancel', order: o }">取消/关闭</button>
                  </div>
                  <div class="row" v-else-if="o.status === 'paid'" style="gap: 6px">
                    <span class="muted" style="font-size: 12px">已入账</span>
                    <button class="btn btn-sm btn-danger" @click="pendingRechargeAction = { type: 'refund', order: o }">冲正退款</button>
                  </div>
                  <div class="row" v-else-if="o.status === 'cancelled'" style="gap: 6px">
                    <button class="btn btn-sm" @click="queryRecharge(o.id)">官方查单</button>
                    <button class="btn btn-sm btn-danger" @click="pendingRechargeAction = { type: 'delete', order: o }">删除记录</button>
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
                  <button v-if="l.status === 'active'" class="btn btn-sm btn-danger" @click="revokeLease(l.id)">风控强断</button>
                  <span v-else class="muted">{{ l.end_reason }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card" v-if="runtimeInfo.db || runtimeInfo.cache">
        <div class="card-title">基础设施运行引擎状态 (数据库 / Redis 缓存 / 防爆破防刷)</div>
        <div class="grid-3">
          <div class="subcard">
            <div class="kpi-label">关系数据库引擎</div>
            <div class="mono" style="margin-top: 6px; font-weight: 600">{{ runtimeInfo.db?.dialect || 'sqlite' }} · {{ runtimeInfo.db?.status || 'active' }}</div>
          </div>
          <div class="subcard">
            <div class="kpi-label">缓存后端 ({{ runtimeInfo.cache?.backend || 'memory' }})</div>
            <div class="row" style="margin-top: 6px">
              <input class="input mono" style="flex: 1" placeholder="redis://host:6379/0（留空用内存）" v-model="redisUrlInput" />
              <button class="btn btn-sm btn-primary" @click="reloadRedis">热切换</button>
            </div>
          </div>
          <div class="subcard">
            <div class="kpi-label">防暴力破解 & 限流状态</div>
            <div class="mono muted" style="margin-top: 6px; font-size: 12px">
              活跃黑名单 IP: {{ runtimeInfo.antispam?.blocked_ips ?? 0 }} · 验证码桶: {{ runtimeInfo.antispam?.active_buckets ?? 0 }}
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
            <label class="row" style="cursor: pointer">
              <input type="checkbox" v-model="createUserForm.email_verified" />
              <span>直接标记为已通过邮箱认证</span>
            </label>
          </div>
          <div class="row" style="justify-content: flex-end">
            <button type="button" class="btn" @click="showCreateUserModal = false">取消</button>
            <button type="submit" class="btn btn-primary">确认创建账号</button>
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
              <select class="select" v-model="editUserForm.email_verified">
                <option :value="true">已认证邮箱</option>
                <option :value="false">未验证邮箱</option>
              </select>
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
            <label class="row" style="cursor: pointer">
              <input type="checkbox" v-model="editUserForm.level_locked" />
              <span>锁定该用户的节点主等级（不随自动升降级变动）</span>
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
            <button type="button" class="btn" @click="editingUser = null">取消</button>
            <button type="submit" class="btn btn-primary">保存用户变更</button>
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
const redisUrlInput = ref('')

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

async function load() {
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
    recentLeases.value = ov.recent_leases || []
    users.value = us || []
    recharges.value = rc.orders || []
    referralSummary.value = refRes.summary || {}
    referralRewards.value = refRes.rewards || []
  } catch (e) {
    emit('notify', e.message)
  }
}

async function saveSettings() {
  try {
    const payload = { ...settings }
    if (!payload.saas_alipay_private_key) delete payload.saas_alipay_private_key
    if (!payload.saas_wechat_private_key) delete payload.saas_wechat_private_key
    if (!payload.saas_wechat_api_v3_key) delete payload.saas_wechat_api_v3_key
    if (!payload.saas_payment_notify_secret) delete payload.saas_payment_notify_secret
    delete payload.saas_alipay_private_key_set
    delete payload.saas_wechat_private_key_set
    delete payload.saas_wechat_api_v3_key_set
    delete payload.saas_payment_notify_secret_set

    const res = await apiFetch('/api/admin/settings', { method: 'POST', body: JSON.stringify(payload) })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function savePlan(p) {
  try {
    const res = await apiFetch(`/api/admin/plans/${p.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: p.name,
        monthly_price_yuan: p.edit_price_yuan,
        max_nodes: p.max_nodes,
        max_active_leases: p.max_active_leases,
        max_monthly_traffic_gb: p.edit_traffic_gb,
        platform_fee_discount_bps: p.platform_fee_discount_bps,
        can_share_nodes: p.edit_can_share,
      }),
    })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function queryRecharge(orderId) {
  try {
    const res = await apiFetch(`/api/admin/recharges/${orderId}/query`, { method: 'POST' })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function confirmRecharge(orderId) {
  try {
    const res = await apiFetch(`/api/admin/recharges/${orderId}/confirm`, { method: 'POST' })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function executeRechargeAction() {
  const act = pendingRechargeAction.value
  if (!act?.order) return
  pendingRechargeAction.value = null
  try {
    let res
    if (act.type === 'cancel') {
      res = await apiFetch(`/api/admin/recharges/${act.order.id}/cancel`, { method: 'POST' })
    } else if (act.type === 'refund') {
      res = await apiFetch(`/api/admin/recharges/${act.order.id}/refund`, { method: 'POST' })
    } else {
      res = await apiFetch(`/api/admin/recharges/${act.order.id}`, { method: 'DELETE' })
    }
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function saveLevel(lv) {
  try {
    const res = await apiFetch(`/api/admin/levels/${lv.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        min_online_hours: lv.min_online_hours,
        min_contributed_gb: lv.min_contributed_gb,
        max_avg_latency_ms: lv.max_avg_latency_ms,
        min_speed_kbps: lv.min_speed_kbps,
        reverse_fee_bps: lv.reverse_fee_bps,
        public_wss_fee_bps: lv.public_wss_fee_bps,
        buyer_discount_bps: lv.buyer_discount_bps,
      }),
    })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function evaluateAllLevels() {
  try {
    const res = await apiFetch('/api/admin/levels/evaluate', { method: 'POST' })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
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
  try {
    const res = await apiFetch('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(createUserForm),
    })
    showCreateUserModal.value = false
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
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
  if (!editingUser.value) return
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
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function toggleUserStatus(u) {
  try {
    const next = u.status === 'active' ? 'suspended' : 'active'
    const res = await apiFetch(`/api/admin/users/${u.id}`, {
      method: 'PUT',
      body: JSON.stringify({ status: next }),
    })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function deleteUser(uid) {
  confirmDeleteUserTarget.value = null
  try {
    const res = await apiFetch(`/api/admin/users/${uid}`, { method: 'DELETE' })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function revokeLease(id) {
  try {
    const res = await apiFetch(`/api/admin/leases/${id}/revoke`, { method: 'POST' })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function reloadRedis() {
  try {
    const res = await apiFetch('/api/system/cache/reload', {
      method: 'POST',
      body: JSON.stringify({ redis_url: redisUrlInput.value }),
    })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

onMounted(load)
</script>
