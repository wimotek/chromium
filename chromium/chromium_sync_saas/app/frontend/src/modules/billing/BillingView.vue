<template>
  <div>
    <div class="grid-4">
      <div class="card">
        <div class="kpi-label">钱包可用余额</div>
        <div class="kpi-val" style="color: #38bdf8">¥{{ user.balance_yuan || '0.00' }}</div>
      </div>
      <div class="card">
        <div class="kpi-label">节点出租累计收益</div>
        <div class="kpi-val" style="color: #34d399">+¥{{ user.total_earned_yuan || '0.00' }}</div>
      </div>
      <div class="card">
        <div class="kpi-label">累计市场消费 / 套餐</div>
        <div class="kpi-val">¥{{ user.total_spent_yuan || '0.00' }}</div>
      </div>
      <div class="card">
        <div class="kpi-label">本月流量配额消耗</div>
        <div class="kpi-val">{{ fmtBytes(quotas.monthly_traffic_bytes) }}</div>
        <div class="muted mono" style="font-size: 12px">上限 {{ fmtBytes(quotas.max_monthly_traffic_bytes) }}</div>
      </div>
    </div>

    <div class="card" v-if="levelProgress.current_level">
      <div class="card-title">
        <span>我的节点主等级与自动升降级考核</span>
        <div class="row">
          <span class="tag" :style="{ color: levelProgress.current_level.badge_color, borderColor: levelProgress.current_level.badge_color }">
            {{ levelProgress.current_level.name }}
          </span>
          <span class="tag tag-info">综合信用分 {{ levelProgress.metrics?.level_score || 0 }} / 1000</span>
          <span v-if="levelProgress.metrics?.level_locked" class="tag tag-warn">管理员已锁定等级</span>
        </div>
      </div>

      <div class="grid-4" style="margin-bottom: 12px">
        <div class="subcard">
          <div class="kpi-label">累计在线时长</div>
          <div class="kpi-val" style="font-size: 18px">{{ levelProgress.metrics?.online_hours || 0 }} 小时</div>
        </div>
        <div class="subcard">
          <div class="kpi-label">累计贡献共享流量</div>
          <div class="kpi-val" style="font-size: 18px">{{ levelProgress.metrics?.contributed_gb || 0 }} GB</div>
        </div>
        <div class="subcard">
          <div class="kpi-label">实时节点平均延迟</div>
          <div class="kpi-val" style="font-size: 18px">
            {{ levelProgress.metrics?.avg_node_latency_ms > 0 ? `${levelProgress.metrics.avg_node_latency_ms} ms` : '离线/未探测' }}
          </div>
        </div>
        <div class="subcard">
          <div class="kpi-label">实时节点平均吞吐</div>
          <div class="kpi-val" style="font-size: 18px">{{ levelProgress.metrics?.avg_node_speed_kbps || 0 }} KB/s</div>
        </div>
      </div>

      <div class="banner banner-info" style="margin-bottom: 0">
        当前等级分通道差价：<strong>WSS反穿 {{ (levelProgress.current_level.reverse_fee_bps / 100).toFixed(1) }}%</strong> ·
        <strong>公网WSS直连 {{ (levelProgress.current_level.public_wss_fee_bps / 100).toFixed(1) }}%</strong> ·
        买家租用额外减免 <strong>{{ (levelProgress.current_level.buyer_discount_bps / 100).toFixed(1) }}%</strong>
        <span v-if="levelProgress.next_level">
          ｜ 下一等级 <strong>{{ levelProgress.next_level.name }}</strong> 门槛：在线 ≥{{ levelProgress.next_level.min_online_hours }}h · 流量 ≥{{ levelProgress.next_level.min_contributed_gb }}GB · 延迟 ≤{{ levelProgress.next_level.max_avg_latency_ms || '不限' }}ms · 速率 ≥{{ levelProgress.next_level.min_speed_kbps }}KB/s
        </span>
        <div v-if="levelProgress.metrics?.last_level_change_reason" class="mono" style="margin-top: 6px">
          最近升降级记录：{{ levelProgress.metrics.last_level_change_reason }}
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">自有节点双模式自用计费明细</div>
        <div class="grid-2">
          <div class="subcard">
            <div class="kpi-label">公网 WSS 直连（自用）</div>
            <div class="kpi-val" style="font-size: 20px; color: #34d399; margin: 6px 0">¥0.00 / GB</div>
            <div class="muted" style="font-size: 12px">
              节点费 ¥{{ selfUseBilling.public_wss_node_yuan || '0.00' }} · Hub 流量费 ¥{{ selfUseBilling.public_wss_hub_yuan || '0.00' }}（账单零计费）
            </div>
          </div>
          <div class="subcard">
            <div class="kpi-label">WSS 反向穿透（自用仅收 Hub 流量费）</div>
            <div class="kpi-val" style="font-size: 20px; color: #38bdf8; margin: 6px 0">¥{{ selfUseBilling.reverse_hub_gb_yuan || '0.20' }} / GB</div>
            <div class="muted" style="font-size: 12px">
              节点费 ¥{{ selfUseBilling.reverse_node_yuan || '0.00' }} · 已累计自用反穿 {{ fmtBytes(selfUseBilling.self_reverse_billed_bytes || 0) }} (¥{{ selfUseBilling.self_reverse_billed_yuan || '0.00' }})
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">推广补贴 & 每日签到领奖</div>
        <div class="grid-2">
          <div class="subcard">
            <div class="kpi-label">每月固定补贴 ({{ promo.current_ym || '本月' }})</div>
            <div class="kpi-val" style="font-size: 20px; color: #facc15; margin: 6px 0">¥{{ promo.monthly_claim_yuan || '10.00' }}</div>
            <button
              class="btn btn-sm btn-primary"
              style="width: 100%"
              :disabled="claimingMonthly || !promo.monthly_claim_enabled || promo.monthly_claimed_this_month"
              @click="claimMonthly"
            >
              {{
                claimingMonthly
                  ? '领取中...'
                  : !promo.monthly_claim_enabled
                    ? '活动暂未开启'
                    : promo.monthly_claimed_this_month
                      ? '本月已领取'
                      : '立即领取本月补贴'
              }}
            </button>
          </div>
          <div class="subcard">
            <div class="kpi-label">每日签到（已连签 {{ promo.checkin_streak || 0 }} 天）</div>
            <div class="kpi-val" style="font-size: 20px; color: #34d399; margin: 6px 0">
              ¥{{ promo.daily_checkin_yuan || '0.50' }} + ¥{{ promo.daily_streak_bonus_yuan || '0.10' }}/天
            </div>
            <button
              class="btn btn-sm btn-emerald"
              style="width: 100%"
              :disabled="claimingDaily || !promo.daily_checkin_enabled || promo.checked_in_today"
              @click="claimDaily"
            >
              {{
                claimingDaily
                  ? '签到中...'
                  : !promo.daily_checkin_enabled
                    ? '签到暂未开启'
                    : promo.checked_in_today
                      ? '今日已签到'
                      : '每日签到领奖'
              }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-title">
          <span>会员套餐与配额升级</span>
          <span v-if="isHighestPlan" class="tag tag-ok">已达最高等级套餐</span>
        </div>
        <div class="grid-3">
          <div
            v-for="p in plans"
            :key="p.id"
            class="subcard"
            :style="
              planRelation(p) === 'current'
                ? 'border-color: rgba(16, 185, 129, 0.45); background: rgba(16, 185, 129, 0.05)'
                : planRelation(p) === 'lower'
                  ? 'opacity: 0.72'
                  : ''
            "
          >
            <div class="row" style="justify-content: space-between">
              <strong>{{ p.name }}</strong>
              <span v-if="planRelation(p) === 'current'" class="tag tag-ok">当前</span>
              <span v-else-if="planRelation(p) === 'lower'" class="tag">已包含</span>
              <span v-else class="tag tag-info">可升级</span>
            </div>
            <div class="kpi-val" style="font-size: 20px; margin: 8px 0">¥{{ p.monthly_price_yuan }}/月</div>
            <div
              v-if="planRelation(p) === 'upgrade' && isDiffPricing(p)"
              class="mono"
              style="font-size: 11px; color: #38bdf8; margin: -4px 0 8px"
            >
              补差价升级仅需 ¥{{ upgradePriceYuan(p) }}
            </div>
            <div class="muted" style="font-size: 12px; line-height: 1.65">
              • 节点上限: {{ p.max_nodes }} 个<br />
              • 并发租用: {{ p.max_active_leases }} 路<br />
              • 月流量: {{ fmtBytes(p.max_monthly_traffic_bytes) }}<br />
              • 市场抽成减免: {{ (p.platform_fee_discount_bps / 100).toFixed(1) }}%
            </div>
            <button
              class="btn btn-sm"
              :class="planRelation(p) === 'upgrade' ? 'btn-primary' : ''"
              style="width: 100%; margin-top: 10px"
              :disabled="planRelation(p) !== 'upgrade' || subscribingPlanId !== null"
              @click="openUpgradeConfirm(p)"
            >
              {{
                planRelation(p) === 'current'
                  ? '当前已生效'
                  : planRelation(p) === 'lower'
                    ? '已享更高套餐'
                    : subscribingPlanId === p.id
                      ? '升级中...'
                      : isDiffPricing(p)
                        ? `补差价升级 ¥${upgradePriceYuan(p)}`
                        : `立即升级 ¥${upgradePriceYuan(p)}`
              }}
            </button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>在线钱包充值收银台</span>
          <span class="tag" :class="headerChannelBadge.cls">
            {{ headerChannelBadge.label }}
          </span>
        </div>
        <div v-if="!channelsLoaded && loadingBilling" class="banner banner-info" style="margin-bottom: 12px">
          正在加载可用线上支付渠道与收银台配置，请稍候...
        </div>
        <div v-else-if="!channelsLoaded && billingLoadError" class="banner banner-warn" style="margin-bottom: 12px">
          <div class="row" style="justify-content: space-between; align-items: center; gap: 8px">
            <span>加载支付渠道失败：{{ billingLoadError }}</span>
            <button type="button" class="btn btn-sm" :disabled="loadingBilling" @click="loadAll()">重新加载</button>
          </div>
        </div>
        <div v-else-if="enabledPaymentMethods.length === 0" class="banner banner-warn" style="margin-bottom: 12px">
          管理员当前已关闭全部线上支付渠道，前台已自动隐藏充值入口。如需充值，请联系平台管理员人工入账。
        </div>
        <template v-else>
          <div class="banner banner-info">
            {{ activePayMethod?.description || '下单后自动生成收款二维码或跳转官方收银台；支付成功后异步回调与 3 秒自动查单将实时入账您的钱包余额。' }}
          </div>

          <div class="row" style="margin-bottom: 12px; gap: 8px">
            <button
              v-for="m in enabledPaymentMethods"
              :key="m.id"
              class="btn btn-sm"
              :class="selectedPayMethod === m.id ? (m.channel === 'wechat' ? 'btn-emerald' : 'btn-primary') : ''"
              @click="selectedPayMethod = m.id"
            >
              <span>{{ m.name }}</span>
              <span class="tag" :class="m.configured ? 'tag-ok' : 'tag-info'" style="margin-left: 6px">
                {{ m.badge }}
              </span>
            </button>
          </div>

          <div class="row" style="margin-bottom: 14px">
            <input class="input mono" type="number" step="10" min="0.01" v-model.number="rechargeYuan" style="max-width: 140px" />
            <button class="btn btn-sm" @click="rechargeYuan = 10">¥10</button>
            <button class="btn btn-sm" @click="rechargeYuan = 50">¥50</button>
            <button class="btn btn-sm" @click="rechargeYuan = 100">¥100</button>
            <button class="btn btn-sm" @click="rechargeYuan = 500">¥500</button>
            <button class="btn btn-primary" :disabled="creatingOrder || !activePayMethod" @click="createRechargeOrder">
              {{ creatingOrder ? '正在下单...' : `立即充值 ¥${rechargeYuan}` }}
            </button>
          </div>
        </template>

        <div v-if="rechargeOrders.length > 0" class="table-wrap" style="max-height: 240px; overflow-y: auto">
          <table>
            <thead>
              <tr><th>订单号</th><th>渠道</th><th>金额</th><th>状态</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="o in rechargeOrders" :key="o.id">
                <td class="mono">{{ o.order_no }}</td>
                <td>{{ o.channel === 'alipay' ? '支付宝' : '微信支付' }}</td>
                <td class="mono">¥{{ o.amount_yuan }}</td>
                <td><span class="tag" :class="orderStatusMeta(o.status).cls">{{ orderStatusMeta(o.status).label }}</span></td>
                <td>
                  <div class="row" style="gap: 6px">
                    <template v-if="o.status === 'pending'">
                      <button class="btn btn-sm btn-primary" @click="openCashierModal(o)">去付款 / 核验</button>
                      <button
                        class="btn btn-sm"
                        :disabled="cancellingOrderNo === o.order_no"
                        @click="cancelRechargeOrder(o.order_no)"
                      >
                        {{ cancellingOrderNo === o.order_no ? '取消中...' : '取消订单' }}
                      </button>
                    </template>
                    <span v-else class="muted mono" style="font-size: 11px">{{ o.paid_at || o.created_at }}</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">财务双分录账单流水</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>流水类型</th>
              <th>变动金额</th>
              <th>变动后余额</th>
              <th>平台差价贡献</th>
              <th>摘要</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in ledger" :key="l.id">
              <td class="mono muted">{{ l.created_at }}</td>
              <td><span class="tag tag-info">{{ l.tx_type }}</span></td>
              <td class="mono" :style="{ color: l.amount_units >= 0 ? '#34d399' : '#f87171' }">
                {{ l.amount_units >= 0 ? '+' : '' }}¥{{ l.amount_yuan }}
              </td>
              <td class="mono">¥{{ l.balance_after_yuan }}</td>
              <td class="mono muted">¥{{ l.platform_spread_yuan }}</td>
              <td>{{ l.remark }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 收银台扫码 / 跳转付款弹窗 -->
    <div v-if="cashierOrder" class="modal-backdrop" @click.self="closeCashierModal">
      <div class="modal-box">
        <div class="card-title">
          <span>{{ cashierOrder.channel === 'alipay' ? '支付宝收银台' : '微信支付收银台' }}</span>
          <button class="btn btn-sm" @click="closeCashierModal">关闭</button>
        </div>

        <div class="subcard" style="margin-bottom: 14px">
          <div class="row" style="justify-content: space-between; margin-bottom: 8px">
            <span class="muted">订单号：<span class="mono">{{ cashierOrder.order_no }}</span></span>
            <span class="tag" :class="cashierOrder.simulated ? 'tag-warn' : orderStatusMeta(cashierOrder.status).cls">
              {{
                cashierOrder.simulated
                  ? (cashierOrder.status === 'paid' ? '模拟支付完成（未落盘）' : '沙盒模拟订单（不落盘）')
                  : cashierOrder.status === 'pending'
                    ? (isStaticQrOrder ? '待扫码转账 · 人工核账' : '等待付款中（每3秒自动核验）')
                    : orderStatusMeta(cashierOrder.status).label
              }}
            </span>
          </div>
          <div class="kpi-val" style="font-size: 28px; color: var(--primary)">¥{{ cashierOrder.amount_yuan }}</div>
          <div v-if="cashierOrder.remark" class="muted mono" style="font-size: 11px; margin-top: 4px">{{ cashierOrder.remark }}</div>
        </div>

        <div v-if="cashierOrder.simulated && cashierOrder.status === 'paid'" class="banner banner-info">
          沙盒模拟演练通过！注意：本次为纯模拟操作，<strong>数据库订单记录、账单流水与真实钱包余额均未改动</strong>。
        </div>
        <div v-else-if="cashierOrder.status === 'paid'" class="banner banner-success">
          款项已核验到账！当前可用余额：<strong class="mono">¥{{ user.balance_yuan || '0.00' }}</strong>
        </div>
        <div v-else-if="cashierOrder.status === 'cancelled'" class="banner banner-warn">
          该充值订单已取消/关闭。如需充值请关闭本窗口后重新下单。
        </div>
        <div v-else-if="cashierOrder.status === 'refunded'" class="banner banner-info">
          该订单已完成冲正退款处理。
        </div>

        <template v-else>
          <div v-if="cashierOrder.simulated" class="banner banner-warn">
            管理员当前开启了沙盒模拟演练，且所选渠道尚未配置官方密钥或收款码。下方「模拟支付」<strong>不会写入数据库，也不会变动您的真实余额</strong>。
          </div>

          <div v-if="isPagePayOrder && isHttpPayUrl" class="subcard" style="text-align: center; margin: 14px 0; padding: 18px 16px">
            <div style="font-size: 14px; font-weight: 600; color: var(--text-strong); margin-bottom: 6px">
              支付宝电脑网站收银台已就绪
            </div>
            <div class="muted" style="font-size: 12px; margin-bottom: 14px">
              点击下方按钮将在新标签页打开支付宝官方网页收银台完成付款，支付完成后本窗口将每 3 秒自动核验并入账。
            </div>
            <a
              :href="cashierOrder.pay_url"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-primary"
            >
              立即前往支付宝官方收银台付款
            </a>
          </div>

          <div v-else-if="isQrImageUrl" style="text-align: center; margin: 14px 0">
            <div class="qr-frame" style="display: inline-block; padding: 10px; background: #fff; border-radius: 10px">
              <img :src="cashierOrder.qr_code_text" alt="收款二维码" style="width: 204px; height: 204px; object-fit: contain; display: block" />
            </div>
            <div class="muted" style="font-size: 12px; margin-top: 8px">
              请打开手机{{ cashierOrder.channel === 'alipay' ? '支付宝' : '微信' }}扫一扫完成转账，付款后等待管理员核账确认入账
            </div>
          </div>

          <div v-else-if="cashierQrSvg" style="text-align: center; margin: 14px 0">
            <div class="qr-frame" v-html="cashierQrSvg"></div>
            <div class="muted" style="font-size: 12px; margin-top: 8px">
              {{
                isStaticQrOrder
                  ? `请打开手机${cashierOrder.channel === 'alipay' ? '支付宝' : '微信'}扫一扫完成转账，付款后等待管理员核账确认入账`
                  : `请打开手机${cashierOrder.channel === 'alipay' ? '支付宝' : '微信'}扫一扫完成付款`
              }}
            </div>
          </div>

          <div v-if="isHttpPayUrl && !isStaticQrOrder && !isPagePayOrder" class="row" style="justify-content: center; margin: 12px 0">
            <a
              :href="cashierOrder.pay_url"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-primary"
            >
              前往{{ cashierOrder.channel === 'alipay' ? '支付宝' : '微信' }}官方收银台付款
            </a>
          </div>

          <div v-if="!isPagePayOrder && !isQrImageUrl && !cashierQrSvg && (!isHttpPayUrl || isStaticQrOrder)" class="banner banner-warn">
            {{ cashierOrder.pay_url || cashierOrder.qr_code_text || '管理员尚未配置收款参数，请联系管理员处理。' }}
          </div>

          <div v-if="(cashierOrder.qr_code_text || isHttpPayUrl) && !isQrImageUrl" class="field">
            <label>原始支付链接 / 二维码数据串</label>
            <div class="row">
              <input class="input mono" :value="cashierOrder.qr_code_text || cashierOrder.pay_url" readonly style="flex: 1" />
              <button class="btn btn-sm" @click="copyText(cashierOrder.qr_code_text || cashierOrder.pay_url)">复制</button>
            </div>
          </div>

          <div class="row" style="justify-content: flex-end; margin-top: 14px">
            <button
              v-if="!cashierOrder.simulated"
              class="btn"
              :disabled="cancellingOrderNo === cashierOrder.order_no"
              @click="cancelRechargeOrder(cashierOrder.order_no)"
            >
              {{ cancellingOrderNo === cashierOrder.order_no ? '取消中...' : '取消订单' }}
            </button>
            <button
              v-if="cashierOrder.simulated"
              class="btn btn-emerald"
              :disabled="sandboxPaying"
              @click="sandboxPay(cashierOrder)"
            >
              {{ sandboxPaying ? '模拟支付中...' : '模拟支付成功（不落盘）' }}
            </button>
            <button v-else class="btn btn-primary" :disabled="checkingOrder" @click="checkOrderStatusNow(cashierOrder.order_no)">
              {{ checkingOrder ? '核验中...' : (isStaticQrOrder ? '刷新入账状态' : '我已完成支付 · 立即核验') }}
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- 套餐升级确认弹窗 -->
    <div v-if="upgradeTargetPlan" class="modal-backdrop" @click.self="closeUpgradeConfirm">
      <div class="modal-box">
        <div class="card-title">
          <span>确认升级会员套餐</span>
          <button class="btn btn-sm" @click="closeUpgradeConfirm">关闭</button>
        </div>

        <div class="subcard" style="margin-bottom: 14px">
          <div class="row" style="justify-content: space-between; margin-bottom: 8px">
            <span class="muted">升级方案</span>
            <strong>{{ currentPlanObj?.name || '当前套餐' }} → {{ upgradeTargetPlan.name }}</strong>
          </div>
          <div class="row" style="justify-content: space-between; margin-bottom: 6px">
            <span class="muted">目标套餐原价</span>
            <span class="mono">¥{{ upgradeTargetPlan.monthly_price_yuan }}/月</span>
          </div>
          <div v-if="isDiffPricing(upgradeTargetPlan)" class="row" style="justify-content: space-between; margin-bottom: 6px">
            <span class="muted">当前套餐已抵扣</span>
            <span class="mono" style="color: #34d399">-¥{{ currentPlanObj?.monthly_price_yuan || 0 }}</span>
          </div>
          <div class="row" style="justify-content: space-between; margin-bottom: 6px">
            <span class="muted">本次实付扣款</span>
            <strong class="mono" style="font-size: 18px; color: var(--primary)">¥{{ upgradePriceYuan(upgradeTargetPlan) }}</strong>
          </div>
          <div class="row" style="justify-content: space-between">
            <span class="muted">当前钱包可用余额</span>
            <span
              class="mono"
              :style="{ color: Number(user.balance_units || 0) >= upgradePriceUnits(upgradeTargetPlan) ? '#34d399' : '#f87171' }"
            >
              ¥{{ user.balance_yuan || '0.00' }}
            </span>
          </div>
        </div>

        <div
          v-if="Number(user.balance_units || 0) < upgradePriceUnits(upgradeTargetPlan)"
          class="banner banner-danger"
        >
          当前余额不足，还差
          <strong class="mono">¥{{ formatUnitsYuan(upgradePriceUnits(upgradeTargetPlan) - Number(user.balance_units || 0)) }}</strong>，请先在右侧收银台完成充值后再升级。
        </div>
        <div v-else class="banner banner-info">
          升级后新配额（{{ upgradeTargetPlan.max_nodes }} 节点 / {{ upgradeTargetPlan.max_active_leases }} 路并发 / {{ fmtBytes(upgradeTargetPlan.max_monthly_traffic_bytes) }} 月流量）将立即生效。套餐仅支持向更高级别升级，不可自助降级。
        </div>

        <div class="row" style="justify-content: flex-end; margin-top: 14px">
          <button class="btn" @click="closeUpgradeConfirm">取消</button>
          <button
            class="btn btn-primary"
            :disabled="subscribingPlanId !== null || Number(user.balance_units || 0) < upgradePriceUnits(upgradeTargetPlan)"
            @click="confirmSubscribeUpgrade"
          >
            {{ subscribingPlanId === upgradeTargetPlan.id ? '升级中...' : `确认扣款 ¥${upgradePriceYuan(upgradeTargetPlan)} 并升级` }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { apiFetch, fmtBytes } from '../../api'
import { renderQrSvg } from '../../utils/qrcode'

const props = defineProps({
  returnOrderNo: { type: String, default: '' },
})
const emit = defineEmits(['notify', 'refresh-profile', 'return-order-handled'])
const user = ref({})
const quotas = ref({})
const levelProgress = ref({})
const selfUseBilling = ref({})
const promo = ref({})
const paymentChannels = ref({
  alipay_enabled: true,
  alipay_mode: 'precreate',
  alipay_configured: false,
  wechat_enabled: true,
  wechat_mode: 'native_v3',
  wechat_configured: false,
  methods: [],
})
const loadingBilling = ref(true)
const channelsLoaded = ref(false)
const billingLoadError = ref('')
const rechargeOrders = ref([])
const cashierOrder = ref(null)
const selectedPayMethod = ref('alipay_f2f')
const plans = ref([])
const ledger = ref([])
const allowSelfRecharge = ref(true)
const rechargeYuan = ref(50)

const claimingMonthly = ref(false)
const claimingDaily = ref(false)
const creatingOrder = ref(false)
const checkingOrder = ref(false)
const subscribingPlanId = ref(null)
const upgradeTargetPlan = ref(null)
const sandboxPaying = ref(false)
const cancellingOrderNo = ref('')
let pollTimer = null

const currentPlanObj = computed(() => {
  return plans.value.find((p) => Number(p.id) === Number(user.value.plan_id)) || null
})

function comparePlanTier(a, b) {
  const keys = [
    'monthly_price_units',
    'max_nodes',
    'max_active_leases',
    'max_monthly_traffic_bytes',
    'platform_fee_discount_bps',
    'id',
  ]
  for (const k of keys) {
    const diff = Number(a?.[k] || 0) - Number(b?.[k] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

function planRelation(plan) {
  if (!plan) return 'lower'
  if (plan.relation) return plan.relation
  const cur = currentPlanObj.value
  if (!cur) return 'upgrade'
  if (Number(plan.id) === Number(cur.id)) return 'current'
  return comparePlanTier(plan, cur) > 0 ? 'upgrade' : 'lower'
}

function upgradePriceUnits(plan) {
  if (!plan) return 0
  if (plan.upgrade_price_units !== undefined && plan.upgrade_price_units !== null) {
    return Math.max(0, Number(plan.upgrade_price_units || 0))
  }
  const targetUnits = Math.max(0, Number(plan.monthly_price_units || 0))
  const curUnits = Math.max(0, Number(currentPlanObj.value?.monthly_price_units || 0))
  return Math.max(0, targetUnits - curUnits)
}

function formatUnitsYuan(units) {
  const val = Math.max(0, Number(units || 0))
  const yuan = val / 10000
  return val % 100 !== 0 ? yuan.toFixed(4) : yuan.toFixed(2)
}

function upgradePriceYuan(plan) {
  if (plan?.upgrade_price_yuan !== undefined && plan?.upgrade_price_yuan !== null) {
    return String(plan.upgrade_price_yuan)
  }
  return formatUnitsYuan(upgradePriceUnits(plan))
}

function isDiffPricing(plan) {
  if (plan?.is_diff_pricing !== undefined) return Boolean(plan.is_diff_pricing)
  const curUnits = Number(currentPlanObj.value?.monthly_price_units || 0)
  return curUnits > 0 && upgradePriceUnits(plan) < Number(plan?.monthly_price_units || 0)
}

const isHighestPlan = computed(() => {
  if (!currentPlanObj.value || plans.value.length === 0) return false
  return plans.value.every((p) => planRelation(p) !== 'upgrade')
})

const enabledPaymentMethods = computed(() => {
  const list = paymentChannels.value.methods || []
  return list.filter((m) => Boolean(m.enabled))
})

const activePayMethod = computed(() => {
  return enabledPaymentMethods.value.find((m) => m.id === selectedPayMethod.value) || enabledPaymentMethods.value[0] || null
})

const headerChannelBadge = computed(() => {
  if (!channelsLoaded.value) {
    return billingLoadError.value
      ? { label: '渠道加载失败', cls: 'tag-warn' }
      : { label: '加载支付渠道中...', cls: 'tag-info' }
  }
  const list = enabledPaymentMethods.value
  if (list.length === 0) return { label: '线上充值已关闭', cls: 'tag-warn' }
  if (paymentChannels.value.alipay_configured || paymentChannels.value.wechat_configured) {
    return { label: '官方网关已就绪', cls: 'tag-ok' }
  }
  if (list.some((m) => Boolean(m.configured))) {
    return { label: '人工收款通道已就绪', cls: 'tag-info' }
  }
  if (allowSelfRecharge.value) {
    return { label: '演练模式（模拟不落盘）', cls: 'tag-warn' }
  }
  return { label: '待管理员配置收款', cls: 'tag-warn' }
})

const isStaticQrOrder = computed(() => {
  const rmk = cashierOrder.value?.remark || ''
  return rmk.includes('static_qr')
})

const isPagePayOrder = computed(() => {
  const o = cashierOrder.value
  if (!o) return false
  const rmk = String(o.remark || '').toLowerCase()
  const url = String(o.pay_url || '').toLowerCase()
  return rmk.includes('page_pay') || url.includes('alipay.trade.page.pay')
})

const isQrImageUrl = computed(() => {
  const txt = (cashierOrder.value?.qr_code_text || '').trim()
  if (!txt) return false
  return /^data:image\//i.test(txt) || /\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(txt)
})

const cashierQrSvg = computed(() => {
  if (isPagePayOrder.value) return ''
  const txt = cashierOrder.value?.qr_code_text || ''
  if (!txt || isQrImageUrl.value || txt.startsWith('sandbox://') || txt.startsWith('unconfigured://')) return ''
  try {
    return renderQrSvg(txt, { size: 204 })
  } catch {
    return ''
  }
})

const isHttpPayUrl = computed(() => {
  const u = cashierOrder.value?.pay_url || ''
  return /^https?:\/\//i.test(u)
})

function orderStatusMeta(status) {
  switch (status) {
    case 'paid':
      return { label: '已支付', cls: 'tag-ok' }
    case 'cancelled':
      return { label: '已取消', cls: 'tag-danger' }
    case 'refunded':
      return { label: '已退款', cls: 'tag-info' }
    default:
      return { label: '待支付', cls: 'tag-warn' }
  }
}

function stopOrderPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function startOrderPolling(orderNo) {
  stopOrderPolling()
  pollTimer = setInterval(async () => {
    if (!cashierOrder.value || cashierOrder.value.order_no !== orderNo || cashierOrder.value.status !== 'pending') {
      stopOrderPolling()
      return
    }
    try {
      const res = await apiFetch(`/api/billing/recharge/orders/${orderNo}`)
      if (res.order) {
        cashierOrder.value = res.order
        if (res.order.status === 'paid') {
          stopOrderPolling()
          if (res.user) user.value = { ...user.value, ...res.user }
          emit('notify', `订单 ${orderNo} 支付成功，已入账 ¥${res.order.amount_yuan}`)
          emit('refresh-profile', res.user || null)
          await loadAll()
        } else if (res.order.status !== 'pending') {
          stopOrderPolling()
          await loadAll()
        }
      }
    } catch {
      // keep polling quietly while modal is open
    }
  }, 3000)
}

function openCashierModal(order) {
  cashierOrder.value = { ...order }
  if (order.status === 'pending' && !order.simulated) {
    startOrderPolling(order.order_no)
  }
}

function closeCashierModal() {
  stopOrderPolling()
  cashierOrder.value = null
}

function copyText(text) {
  navigator.clipboard?.writeText(text || '')
  emit('notify', '已复制到剪贴板')
}

async function loadAll(options = {}) {
  const silent = Boolean(options?.silent)
  if (!silent) {
    loadingBilling.value = true
    billingLoadError.value = ''
  }
  try {
    const overviewReq = apiFetch('/api/billing/overview', { timeoutMs: 25000 })
      .then((bRes) => {
        user.value = bRes.user || {}
        quotas.value = bRes.quotas || {}
        levelProgress.value = bRes.level_progress || {}
        selfUseBilling.value = bRes.self_use_billing || {}
        promo.value = bRes.promo || {}
        paymentChannels.value = bRes.payment_channels || paymentChannels.value
        channelsLoaded.value = true
        billingLoadError.value = ''
        rechargeOrders.value = bRes.recharge_orders || []
        const enabledList = (paymentChannels.value.methods || []).filter((m) => Boolean(m.enabled))
        if (!enabledList.find((m) => m.id === selectedPayMethod.value)) {
          selectedPayMethod.value = enabledList[0]?.id || ''
        }
        ledger.value = bRes.ledger || []
        allowSelfRecharge.value = Boolean(bRes.allow_self_recharge)
        emit('refresh-profile', {
          user: bRes.user || null,
          plan: bRes.plan || null,
          level: bRes.level || null,
          channel_fees: bRes.channel_fees || null,
          quotas: bRes.quotas || null,
          skipFetch: true,
        })
      })
      .catch((e) => {
        if (!channelsLoaded.value) {
          billingLoadError.value = e?.message || '加载财务数据失败'
        }
        if (!silent) {
          emit('notify', { message: e?.message || '加载财务数据失败', type: 'error' })
        }
      })

    const plansReq = apiFetch('/api/plans', { timeoutMs: 25000 })
      .then((pRes) => {
        plans.value = pRes.plans || []
      })
      .catch((e) => {
        if (!silent && plans.value.length === 0) {
          emit('notify', { message: e?.message || '加载套餐列表失败', type: 'error' })
        }
      })

    await Promise.allSettled([overviewReq, plansReq])
  } finally {
    if (!silent) {
      loadingBilling.value = false
    }
  }
}

async function claimMonthly() {
  if (claimingMonthly.value) return
  claimingMonthly.value = true
  try {
    const res = await apiFetch('/api/billing/promo/monthly-claim', { method: 'POST' })
    promo.value = {
      ...promo.value,
      ...(res.promo || {}),
      monthly_claimed_this_month: true,
    }
    if (res.user) user.value = { ...user.value, ...res.user }
    emit('notify', res.message)
    emit('refresh-profile', res.user || null)
    await loadAll({ silent: true })
  } catch (e) {
    emit('notify', e.message)
  } finally {
    claimingMonthly.value = false
  }
}

async function claimDaily() {
  if (claimingDaily.value) return
  claimingDaily.value = true
  try {
    const res = await apiFetch('/api/billing/promo/daily-checkin', { method: 'POST' })
    promo.value = {
      ...promo.value,
      ...(res.promo || {}),
      checked_in_today: true,
      checkin_streak: res.checkin_streak ?? res.promo?.checkin_streak ?? promo.value.checkin_streak,
    }
    if (res.user) user.value = { ...user.value, ...res.user }
    emit('notify', res.message)
    emit('refresh-profile', res.user || null)
    await loadAll({ silent: true })
  } catch (e) {
    emit('notify', e.message)
  } finally {
    claimingDaily.value = false
  }
}

async function createRechargeOrder() {
  if (creatingOrder.value || !activePayMethod.value) return
  creatingOrder.value = true
  try {
    const res = await apiFetch('/api/billing/recharge/create', {
      method: 'POST',
      timeoutMs: 30000,
      body: JSON.stringify({
        channel: activePayMethod.value.channel,
        pay_method: activePayMethod.value.id,
        amount_yuan: rechargeYuan.value,
      }),
    })
    emit('notify', { message: res.message || '充值订单已创建', type: 'ok' })
    if (res.order) {
      const orderObj = { ...res.order, simulated: Boolean(res.simulated || res.order.simulated) }
      if (!orderObj.simulated && !rechargeOrders.value.some((x) => x.order_no === orderObj.order_no)) {
        rechargeOrders.value = [orderObj, ...rechargeOrders.value].slice(0, 30)
      }
      openCashierModal(orderObj)
    }
    if (!res.simulated) {
      // 后台静默刷新余额与历史订单列表，不阻塞收银台弹窗，也不在付款期间弹出无关报错
      loadAll({ silent: true }).catch(() => {})
    }
  } catch (e) {
    emit('notify', { message: e.message || '下单失败，请稍后重试', type: 'error' })
  } finally {
    creatingOrder.value = false
  }
}

async function checkOrderStatusNow(orderNo) {
  if (checkingOrder.value) return
  checkingOrder.value = true
  try {
    const res = await apiFetch(`/api/billing/recharge/orders/${orderNo}`)
    if (res.order) cashierOrder.value = res.order
    if (res.order?.status === 'paid') {
      stopOrderPolling()
      if (res.user) user.value = { ...user.value, ...res.user }
      emit('notify', `核验成功：订单 ${orderNo} 已到账 ¥${res.order.amount_yuan}`)
      emit('refresh-profile', res.user || null)
      await loadAll()
    } else {
      emit('notify', '暂未检测到付款到账，请完成扫码/支付后稍等片刻')
    }
  } catch (e) {
    emit('notify', e.message)
  } finally {
    checkingOrder.value = false
  }
}

async function sandboxPay(order) {
  if (sandboxPaying.value) return
  sandboxPaying.value = true
  try {
    const q = new URLSearchParams({
      channel: order.channel || 'alipay',
      amount_yuan: String(order.amount_yuan || rechargeYuan.value || 50),
    })
    const res = await apiFetch(`/api/billing/recharge/${order.order_no}/sandbox-pay?${q.toString()}`, { method: 'POST' })
    if (res.order) cashierOrder.value = { ...res.order, simulated: true }
    stopOrderPolling()
    emit('notify', { message: res.message || '模拟支付成功', type: 'ok' })
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    sandboxPaying.value = false
  }
}

async function cancelRechargeOrder(orderNo) {
  if (cancellingOrderNo.value) return
  cancellingOrderNo.value = orderNo
  try {
    const res = await apiFetch(`/api/billing/recharge/orders/${orderNo}/cancel`, { method: 'POST' })
    stopOrderPolling()
    if (cashierOrder.value && cashierOrder.value.order_no === orderNo && res.order) {
      cashierOrder.value = res.order
    }
    emit('notify', { message: res.message || '充值订单已取消', type: 'ok' })
    await loadAll()
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    cancellingOrderNo.value = ''
  }
}

function openUpgradeConfirm(plan) {
  if (!plan || planRelation(plan) !== 'upgrade' || subscribingPlanId.value !== null) return
  upgradeTargetPlan.value = plan
}

function closeUpgradeConfirm() {
  if (subscribingPlanId.value !== null) return
  upgradeTargetPlan.value = null
}

async function confirmSubscribeUpgrade() {
  if (!upgradeTargetPlan.value) return
  const targetId = upgradeTargetPlan.value.id
  await subscribe(targetId)
}

async function subscribe(planId) {
  if (subscribingPlanId.value !== null) return
  subscribingPlanId.value = planId
  try {
    const res = await apiFetch('/api/plans/subscribe', {
      method: 'POST',
      body: JSON.stringify({ plan_id: planId }),
    })
    if (res.user) user.value = { ...user.value, ...res.user }
    upgradeTargetPlan.value = null
    emit('notify', { message: res.message || '套餐升级成功', type: 'ok' })
    emit('refresh-profile', res.user || null)
    await loadAll()
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    subscribingPlanId.value = null
  }
}

async function handleReturnedOrder(orderNo) {
  const no = String(orderNo || '').trim()
  if (!no) return
  emit('return-order-handled')
  try {
    const res = await apiFetch(`/api/billing/recharge/orders/${encodeURIComponent(no)}`, { timeoutMs: 20000 })
    if (res?.order?.status === 'paid') {
      if (res.user) user.value = { ...user.value, ...res.user }
      emit('notify', { message: `支付成功！订单 ${no} 已入账 ¥${res.order.amount_yuan}`, type: 'ok' })
      emit('refresh-profile', res.user || null)
      await loadAll({ silent: true })
    } else if (res?.order) {
      openCashierModal(res.order)
      emit('notify', { message: `已返回钱包页面，正在核验订单 ${no} 付款结果...`, type: 'info' })
    }
  } catch {
    // 即使查单暂时失败也保持停留在钱包页面并正常展示订单列表
  }
}

watch(
  () => props.returnOrderNo,
  (val) => {
    if (val) handleReturnedOrder(val)
  },
)

onMounted(async () => {
  await loadAll()
  if (props.returnOrderNo) {
    handleReturnedOrder(props.returnOrderNo)
  }
})
onBeforeUnmount(stopOrderPolling)
</script>
