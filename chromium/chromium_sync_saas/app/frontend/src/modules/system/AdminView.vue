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
          <span>全局支付收银台与回调地址</span>
          <button class="btn btn-sm btn-primary" @click="saveSettings">保存全部支付网关参数</button>
        </div>

        <div class="grid-2" style="margin-bottom: 14px">
          <div class="subcard">
            <div class="field">
              <label>沙盒自助演示支付</label>
              <select class="select" v-model="settings.saas_allow_self_recharge">
                <option :value="true">允许沙盒一键入账（测试模式）</option>
                <option :value="false">关闭沙盒（生产模式：仅官方扫码 / 回调 / 查单确认）</option>
              </select>
            </div>
            <div class="field" style="margin-bottom: 0">
              <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                <label style="margin: 0">通用 JSON Webhook HMAC-SHA256 验签密钥</label>
                <span class="tag" :class="settings.saas_payment_notify_secret_set ? 'tag-ok' : ''">
                  {{ settings.saas_payment_notify_secret_set ? '已配置' : '未设置' }}
                </span>
              </div>
              <input class="input mono" type="password" placeholder="留空保持不变" v-model="settings.saas_payment_notify_secret" />
            </div>
          </div>

          <div class="subcard">
            <div class="kpi-label" style="margin-bottom: 8px">异步通知回调 URL（填至支付宝开放平台 / 微信商户后台）</div>
            <div class="field">
              <label>支付宝官方回调地址 (notify_url)</label>
              <div class="row">
                <input class="input mono" :value="defaultAlipayNotifyUrl" readonly style="flex: 1" />
                <button class="btn btn-sm" @click="copyText(defaultAlipayNotifyUrl)">复制</button>
              </div>
            </div>
            <div class="field" style="margin-bottom: 0">
              <label>微信支付 V3 官方回调地址 (notify_url)</label>
              <div class="row">
                <input class="input mono" :value="defaultWechatNotifyUrl" readonly style="flex: 1" />
                <button class="btn btn-sm" @click="copyText(defaultWechatNotifyUrl)">复制</button>
              </div>
            </div>
          </div>
        </div>

        <div class="grid-2">
          <!-- 支付宝开放平台子卡 -->
          <div class="subcard">
            <div class="card-title" style="font-size: 14px; margin-bottom: 12px">
              <span>支付宝开放平台配置 (RSA2)</span>
              <span class="tag" :class="settings.saas_alipay_enabled ? 'tag-ok' : ''">{{ settings.saas_alipay_enabled ? '已启用' : '已关闭' }}</span>
            </div>
            <div class="grid-2">
              <div class="field">
                <label>通道开关</label>
                <select class="select" v-model="settings.saas_alipay_enabled">
                  <option :value="true">启用支付宝</option>
                  <option :value="false">停用支付宝</option>
                </select>
              </div>
              <div class="field">
                <label>接入下单模式</label>
                <select class="select" v-model="settings.saas_alipay_mode">
                  <option value="precreate">当面付扫码 (precreate)</option>
                  <option value="page_pay">电脑网站跳转收银台 (page.pay)</option>
                  <option value="static_qr">静态收款码 / 沙盒兜底</option>
                </select>
              </div>
            </div>
            <div class="grid-2">
              <div class="field">
                <label>应用 AppID</label>
                <input class="input mono" placeholder="202100..." v-model="settings.saas_alipay_app_id" />
              </div>
              <div class="field">
                <label>网关地址 (沙盒可改 openapi-sandbox)</label>
                <input class="input mono" v-model="settings.saas_alipay_gateway_url" />
              </div>
            </div>
            <div class="grid-2">
              <div class="field">
                <label>自定义异步回调 URL（留空用默认）</label>
                <input class="input mono" :placeholder="defaultAlipayNotifyUrl" v-model="settings.saas_alipay_notify_url" />
              </div>
              <div class="field">
                <label>电脑支付同步回跳 Return URL（可选）</label>
                <input class="input mono" placeholder="https://your-domain.com/" v-model="settings.saas_alipay_return_url" />
              </div>
            </div>
            <div class="field">
              <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                <label style="margin: 0">应用私钥 (RSA2 PKCS8 / PKCS1)</label>
                <span class="tag" :class="settings.saas_alipay_private_key_set ? 'tag-ok' : ''">
                  {{ settings.saas_alipay_private_key_set ? '数据库已加密保存（留空保留）' : '未配置' }}
                </span>
              </div>
              <textarea
                class="textarea mono"
                rows="3"
                placeholder="-----BEGIN PRIVATE KEY----- ...（如已保存且无需更换请留空）"
                v-model="settings.saas_alipay_private_key"
              ></textarea>
            </div>
            <div class="field">
              <label>支付宝公钥（用于校验支付宝返回及异步通知 RSA2 签名）</label>
              <textarea
                class="textarea mono"
                rows="3"
                placeholder="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A..."
                v-model="settings.saas_alipay_public_key"
              ></textarea>
            </div>
            <div class="field" style="margin-bottom: 0">
              <label>静态收款码兜底链接（当模式为静态码时使用）</label>
              <input class="input mono" placeholder="https://qr.alipay.com/..." v-model="settings.saas_alipay_qr_url" />
            </div>
          </div>

          <!-- 微信支付 V3 子卡 -->
          <div class="subcard">
            <div class="card-title" style="font-size: 14px; margin-bottom: 12px">
              <span>微信支付商户平台配置 (API V3)</span>
              <span class="tag" :class="settings.saas_wechat_enabled ? 'tag-ok' : ''">{{ settings.saas_wechat_enabled ? '已启用' : '已关闭' }}</span>
            </div>
            <div class="grid-2">
              <div class="field">
                <label>通道开关</label>
                <select class="select" v-model="settings.saas_wechat_enabled">
                  <option :value="true">启用微信支付</option>
                  <option :value="false">停用微信支付</option>
                </select>
              </div>
              <div class="field">
                <label>接入下单模式</label>
                <select class="select" v-model="settings.saas_wechat_mode">
                  <option value="native_v3">Native V3 扫码下单 (官方推荐)</option>
                  <option value="static_qr">静态收款码 / 沙盒兜底</option>
                </select>
              </div>
            </div>
            <div class="grid-2">
              <div class="field">
                <label>绑定 AppID</label>
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
                <label>自定义异步回调 URL（留空用默认）</label>
                <input class="input mono" :placeholder="defaultWechatNotifyUrl" v-model="settings.saas_wechat_notify_url" />
              </div>
            </div>
            <div class="field">
              <div class="row" style="justify-content: space-between; margin-bottom: 4px">
                <label style="margin: 0">商户 API 私钥 (apiclient_key.pem)</label>
                <span class="tag" :class="settings.saas_wechat_private_key_set ? 'tag-ok' : ''">
                  {{ settings.saas_wechat_private_key_set ? '数据库已加密保存（留空保留）' : '未配置' }}
                </span>
              </div>
              <textarea
                class="textarea mono"
                rows="3"
                placeholder="-----BEGIN PRIVATE KEY----- ...（如已保存且无需更换请留空）"
                v-model="settings.saas_wechat_private_key"
              ></textarea>
            </div>
            <div class="field">
              <label>微信支付平台公钥 / 证书公钥（可选，用于回调验签）</label>
              <textarea
                class="textarea mono"
                rows="3"
                placeholder="-----BEGIN PUBLIC KEY----- 或 -----BEGIN CERTIFICATE-----"
                v-model="settings.saas_wechat_platform_public_key"
              ></textarea>
            </div>
            <div class="field" style="margin-bottom: 0">
              <label>静态收款码兜底链接（当模式为静态码时使用）</label>
              <input class="input mono" placeholder="weixin://..." v-model="settings.saas_wechat_qr_url" />
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>全网支付宝 / 微信充值订单管理、官方主动查单与人工核账</span>
          <button class="btn btn-sm" @click="load">刷新订单列表</button>
        </div>
        <div v-if="recharges.length === 0" class="muted">暂无充值订单。</div>
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
              <tr v-for="o in recharges" :key="o.id">
                <td class="mono">{{ o.order_no }}</td>
                <td>{{ o.username }} (#{{ o.user_id }})</td>
                <td>{{ o.channel === 'alipay' ? '支付宝' : '微信支付' }}</td>
                <td class="mono">¥{{ o.amount_yuan }}</td>
                <td>
                  <span class="tag" :class="o.status === 'paid' ? 'tag-ok' : 'tag-warn'">{{ o.status }}</span>
                  <span class="muted mono" style="margin-left: 6px; font-size: 11px">{{ o.external_trade_no || '-' }}</span>
                </td>
                <td class="mono muted">{{ o.paid_at || o.created_at }}</td>
                <td>
                  <div class="row" v-if="o.status === 'pending'" style="gap: 6px">
                    <button class="btn btn-sm btn-primary" @click="queryRecharge(o.id)">官方查单</button>
                    <button class="btn btn-sm btn-emerald" @click="confirmRecharge(o.id)">人工确认到账</button>
                  </div>
                  <span v-else class="muted">已入账</span>
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

const baseOrigin = computed(() => {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin
  return 'https://your-saas-hub.example.com'
})

const defaultAlipayNotifyUrl = computed(() => `${baseOrigin.value}/api/billing/recharge/notify/alipay`)
const defaultWechatNotifyUrl = computed(() => `${baseOrigin.value}/api/billing/recharge/notify/wechat`)

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
  saas_alipay_app_id: '',
  saas_alipay_private_key: '',
  saas_alipay_private_key_set: false,
  saas_alipay_public_key: '',
  saas_alipay_gateway_url: 'https://openapi.alipay.com/gateway.do',
  saas_alipay_notify_url: '',
  saas_alipay_return_url: '',
  saas_alipay_qr_url: '',
  saas_wechat_enabled: true,
  saas_wechat_mode: 'native_v3',
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

function copyText(text) {
  navigator.clipboard?.writeText(text || '')
  emit('notify', '已复制到剪贴板')
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
