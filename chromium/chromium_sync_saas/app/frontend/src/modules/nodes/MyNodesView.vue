<template>
  <div>
    <!-- 二级子卡切换：将「我的节点」与「接入凭据与 API 指南」分两个子卡显示 -->
    <div class="subnav">
      <button
        class="subnav-btn"
        :class="{ active: activeSubTab === 'nodes' }"
        @click="activeSubTab = 'nodes'"
      >
        我的节点（自有 {{ nodes.length }} / {{ quotas.max_nodes || '-' }} · 已租用 {{ activeBuyerLeases.length }}）
      </button>
      <button
        class="subnav-btn"
        :class="{ active: activeSubTab === 'credentials' }"
        @click="activeSubTab = 'credentials'"
      >
        接入凭据与 API 指南（JOIN_TOKEN · API-Key）
      </button>
    </div>

    <!-- 子卡一：我的节点（自有节点上下架 + 我租用的共享节点） -->
    <template v-if="activeSubTab === 'nodes'">
      <div class="card">
        <div class="card-title">
          <span>自有节点清单 & 共享出租上架</span>
          <div class="row">
            <span v-if="userLevel" class="tag" :style="{ color: userLevel.badge_color, borderColor: userLevel.badge_color }">
              当前 {{ userLevel.name }} · 反穿 {{ ((userLevel.reverse_fee_bps || channelFees.reverse || 2500) / 100).toFixed(1) }}% / WSS直连 {{ ((userLevel.public_wss_fee_bps || channelFees.public_wss || 1000) / 100).toFixed(1) }}%
            </span>
            <button class="btn btn-sm" @click="showPublishGuide = !showPublishGuide">
              {{ showPublishGuide ? '收起上架教程' : '如何接入并上架？' }}
            </button>
            <button class="btn btn-sm" :disabled="refreshing" @click="load(true)">
              {{ refreshing ? '刷新中...' : '刷新状态' }}
            </button>
          </div>
        </div>

        <!-- 节点接入与上架步骤指引（无节点时自动展开，也可随时点击右上角按钮展开） -->
        <div v-if="showPublishGuide || nodes.length === 0" class="subcard" style="margin-bottom: 14px; border-color: rgba(56, 189, 248, 0.35)">
          <div class="card-title" style="font-size: 14px; margin-bottom: 8px">
            <span>节点如何接入并上架到共享市场？（3 步完成）</span>
            <button class="btn btn-sm" @click="activeSubTab = 'credentials'">查看完整凭据与对接示例 →</button>
          </div>
          <div style="font-size: 13px; line-height: 1.75; color: var(--text)">
            <div>
              <strong>第 1 步 · 绑定入网码启动节点端：</strong>因为浏览器算力节点需要真实浏览器实例与隧道保活，无法在网页空填创建。请在 Windows / Docker / Android 节点端填入您的个人 <span class="mono">JOIN_TOKEN</span>（并配置网关 <span class="mono">{{ reverseWssUrl }}</span>）启动：
              <div class="row" style="margin: 6px 0 8px">
                <input class="input mono" :value="user.cluster_join_token" readonly style="flex: 1; min-width: 220px" />
                <button class="btn btn-sm btn-primary" @click="copy(user.cluster_join_token)">复制 JOIN_TOKEN</button>
                <button class="btn btn-sm" @click="copy(reverseWssUrl)">复制反穿 WSS 地址</button>
              </div>
            </div>
            <div>
              <strong>第 2 步 · 自动出现在下方清单：</strong>客户端握手成功后，节点将自动注册到本列表（支持 <span class="mono">WSS 反向穿透</span> 与 <span class="mono">公网 WSS 直连</span>；注：Android 移动节点出于安全锁定不可作为共享算力出租）。
            </div>
            <div>
              <strong>第 3 步 · 一键上架到市场赚取收益：</strong>点击节点右侧的 <span class="tag tag-info">上架到市场</span> 按钮，确认展示名称、地区标签与隔离模式（<strong>时租底价与流量底价均由平台按基准定价 + 您的等级 + 节点质量统一核定，不可手动修改</strong>），勾选「上架至公共算力交易市场」保存后即可在共享市场被他人租用。
            </div>
          </div>
        </div>

        <div class="banner banner-info" style="margin-bottom: 12px">
          <strong>纯 WSS 入网与自用双计费说明：</strong>SaaS 版仅支持 <span class="mono">WSS 反向穿透</span> 与 <span class="mono">公网 WSS 直连</span>。<br />
          • <strong>自用公网 WSS 直连</strong>：节点免费 ¥0 + Hub 流量 ¥0（完全零扣费，仅做信令调度）。<br />
          • <strong>自用 WSS 反向穿透</strong>：节点自身 ¥0，但经过 Hub 中继转发会产生平台流量成本，按每 GB 基准费率扣减余额（余额不足自动阻断）。
        </div>

        <div v-if="nodes.length === 0" class="muted" style="padding: 14px 0">
          暂无已接入的自有节点。请按上方「第 1 步」在节点客户端配置您的 <span class="mono">JOIN_TOKEN</span> 上线，节点上线后点击「上架到市场」即可对外出租。
        </div>

        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID / 名称</th>
                <th>通道 / 状态 / 质量评级</th>
                <th>活跃租约 / 隔离模式</th>
                <th>共享市场定价 (卖家底价 → 买家价)</th>
                <th>累计流量 / 在线</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="n in nodes" :key="n.id">
                <td>
                  <div class="row" style="gap: 6px">
                    <strong>#{{ n.id }} {{ n.name }}</strong>
                    <span v-if="n.is_source === 1" class="tag tag-info">默认源</span>
                  </div>
                  <div class="row" style="gap: 6px; margin-top: 4px">
                    <span class="muted mono">{{ n.group_name }} · {{ n.client_type || 'desktop' }}</span>
                    <span class="tag" :title="`记录 IP: ${n.last_ip || '未记录'}`">地区: {{ n.share_region || 'Global' }}</span>
                  </div>
                </td>
                <td>
                  <div>
                    <span class="tag tag-info">{{ channelLabel(n.channel_type || n.conn_type) }}</span>
                    <span
                      class="tag"
                      :class="n.enabled === 0 ? 'tag-danger' : n.status === 'connected' ? 'tag-ok' : 'tag-warn'"
                      style="margin-left: 4px"
                    >
                      {{ n.enabled === 0 ? '已禁用 (disabled)' : n.status }}
                    </span>
                    <span class="tag" :class="qualityTagClass(n.quality_grade)" style="margin-left: 4px">{{ n.quality_grade || 'C' }}级</span>
                    <span v-if="n.api_enabled === 0" class="tag tag-warn" style="margin-left: 4px">API禁用</span>
                  </div>
                  <div class="muted mono" style="font-size: 11px; margin-top: 4px">
                    延迟 {{ n.avg_latency_ms > 0 ? `${n.avg_latency_ms}ms` : '--' }} · 速率 {{ n.avg_speed_kbps || 0 }}KB/s
                  </div>
                </td>
                <td>
                  <div v-if="n.active_lease_count > 0" class="tag tag-warn">出租中 ({{ n.active_lease_count }}/{{ n.max_concurrent_leases }})</div>
                  <div v-else class="tag">空闲可用</div>
                  <div class="muted" style="font-size: 12px; margin-top: 4px">
                    {{ n.isolation_mode === 'ephemeral_profile' ? '独立临时 Profile' : '独占槽位模式' }}
                  </div>
                </td>
                <td>
                  <div v-if="n.share_enabled">
                    <span class="tag tag-ok">已上架 (加价 {{ ((n.platform_fee_bps || 0) / 100).toFixed(1) }}%)</span>
                    <div class="mono" style="margin-top: 4px">
                      时租: ¥{{ (n.seller_price_per_hour_units / 10000).toFixed(2) }} → <strong>¥{{ (n.buyer_preview_hour_units / 10000).toFixed(2) }}</strong>
                    </div>
                    <div class="mono muted">
                      流量: ¥{{ (n.seller_price_per_gb_units / 10000).toFixed(2) }}/GB → ¥{{ (n.buyer_preview_gb_units / 10000).toFixed(2) }}/GB
                    </div>
                  </div>
                  <div v-else>
                    <span class="muted">未上架（仅个人私有）</span>
                    <div class="muted mono" style="font-size: 11px">
                      平台核定底价 ¥{{ (n.seller_price_per_hour_units / 10000).toFixed(2) }}/h · ¥{{ (n.seller_price_per_gb_units / 10000).toFixed(2) }}/GB
                    </div>
                  </div>
                </td>
                <td class="mono">
                  CDP: {{ fmtBytes((n.cdp_rx_bytes || 0) + (n.cdp_tx_bytes || 0)) }}<br />
                  在线: {{ fmtDuration(n.online_seconds || 0) }} · 已租 {{ fmtDuration(n.total_leased_seconds) }}
                </td>
                <td>
                  <div class="row" style="gap: 6px">
                    <button class="btn btn-sm" @click="openEditModal(n)">修改</button>
                    <button
                      class="btn btn-sm"
                      :class="n.enabled === 0 ? 'btn-emerald' : 'btn-warn'"
                      :disabled="(n.enabled !== 0 && n.active_lease_count > 0) || busyNodeAction === `enabled:${n.id}`"
                      :title="n.enabled !== 0 && n.active_lease_count > 0 ? '节点出租中暂不可禁用' : ''"
                      @click="toggleEnabled(n)"
                    >
                      {{ busyNodeAction === `enabled:${n.id}` ? '处理中...' : n.enabled === 0 ? '启用' : '禁用' }}
                    </button>
                    <button
                      class="btn btn-sm"
                      :disabled="n.client_type === 'android' || busyNodeAction === `api:${n.id}`"
                      :title="n.client_type === 'android' ? 'Android 节点锁定禁用第三方 API' : '切换第三方 CDP API 开放状态'"
                      @click="toggleApi(n)"
                    >
                      {{ busyNodeAction === `api:${n.id}` ? '切换中...' : n.api_enabled === 0 ? 'API开' : 'API禁' }}
                    </button>
                    <button
                      class="btn btn-sm"
                      :disabled="busyNodeAction === `source:${n.id}`"
                      @click="toggleSource(n)"
                    >
                      {{ busyNodeAction === `source:${n.id}` ? '更新中...' : n.is_source === 1 ? '取消源' : '设为源' }}
                    </button>
                    <button
                      class="btn btn-sm"
                      :disabled="n.active_lease_count > 0 || loadingCookieNodeId === n.id"
                      :title="n.active_lease_count > 0 ? '出租期间禁止查看实时 Cookie 明细' : ''"
                      @click="openCookieDetails(n)"
                    >
                      {{ loadingCookieNodeId === n.id ? '读取中...' : 'Cookie' }}
                    </button>
                    <button
                      v-if="n.client_type === 'android' || n.api_enabled === 0"
                      class="btn btn-sm"
                      disabled
                      title="Android 或禁用 CDP API 的节点不支持市场出租"
                    >
                      不可上架
                    </button>
                    <button
                      v-else
                      class="btn btn-sm"
                      :class="n.share_enabled ? 'btn-emerald' : 'btn-primary'"
                      @click="openShareModal(n)"
                    >
                      {{ n.share_enabled ? '定价 / 下架' : '上架到市场' }}
                    </button>
                    <button class="btn btn-sm" :disabled="probingNodeId === n.id" @click="probeNode(n.id)">
                      {{ probingNodeId === n.id ? '探活中...' : '探活' }}
                    </button>
                    <button
                      class="btn btn-sm btn-danger"
                      @click="confirmAction = { type: 'delete_node', nodeId: n.id, title: `确认删除节点 #${n.id} (${n.name})？`, desc: '删除后该节点记录将从工作台移除，需重新注册入网。' }"
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 我租用的共享节点（方便在「我的节点」中集中管理所有在租算力） -->
      <div class="card">
        <div class="card-title">
          <span>我租用的共享节点（来自算力市场）</span>
          <div class="row">
            <span class="tag tag-ok">在租 {{ activeBuyerLeases.length }} / {{ quotas.max_active_leases || '-' }}</span>
            <button class="btn btn-sm" :disabled="refreshing" @click="load(true)">
              {{ refreshing ? '刷新中...' : '刷新' }}
            </button>
            <button class="btn btn-sm btn-primary" @click="emit('go-market')">前往共享市场租用 →</button>
          </div>
        </div>

        <div v-if="buyerLeases.length === 0" class="muted" style="padding: 12px 0">
          暂无从市场租用的节点。可点击右侧「前往共享市场租用 →」，支持手动单租或一键随机按数量租用。
        </div>

        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>租约 / 节点</th>
                <th>卖家 / 通道</th>
                <th>状态 / 已计费</th>
                <th>单价 / 实付</th>
                <th>接入与退租</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in buyerLeases" :key="l.id">
                <td>
                  <div><strong>#{{ l.id }} {{ l.node_name }}</strong></div>
                  <div class="muted mono">{{ l.isolation_profile_id }}</div>
                </td>
                <td>
                  <div>{{ l.seller_username }}</div>
                  <div class="muted mono" style="font-size: 11px">{{ channelLabel(l.channel_type) }}</div>
                </td>
                <td class="mono">
                  <span class="tag" :class="l.status === 'active' ? 'tag-ok' : 'tag-warn'">{{ l.status }}</span>
                  <div>{{ fmtDuration(l.billed_seconds) }} · {{ fmtBytes(l.billed_bytes) }}</div>
                </td>
                <td class="mono">
                  <div>¥{{ l.buyer_hour_yuan }}/h · ¥{{ l.buyer_gb_yuan }}/GB</div>
                  <div class="muted">累计实付 ¥{{ l.buyer_spent_yuan }}</div>
                </td>
                <td>
                  <div class="row" v-if="l.status === 'active'">
                    <button class="btn btn-sm" @click="copy(l.cdp_ws_url)">复制 CDP WS</button>
                    <button
                      class="btn btn-sm btn-danger"
                      :disabled="stoppingLeaseId === l.id"
                      @click="stopBuyerLease(l.id)"
                    >
                      {{ stoppingLeaseId === l.id ? '结算中...' : '退租结算' }}
                    </button>
                  </div>
                  <span v-else class="muted" style="font-size: 12px">{{ l.end_reason || l.ended_at }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- 子卡二：接入凭据与 API 指南 -->
    <template v-else>
      <div class="card">
        <div class="card-title">
          <span>我的节点接入凭据（强身份绑定）</span>
          <span class="tag tag-info">自有节点 {{ nodes.length }} / {{ quotas.max_nodes || '-' }}</span>
        </div>
        <div class="grid-2">
          <div class="subcard">
            <div class="kpi-label">个人集群入网码 (JOIN_TOKEN，用于 Windows / Docker / Android 节点连接)</div>
            <div class="row" style="margin-top: 8px">
              <input class="input mono" :value="user.cluster_join_token" readonly style="flex: 1; min-width: 180px" />
              <button class="btn btn-sm" @click="copy(user.cluster_join_token)">复制</button>
              <button class="btn btn-sm btn-danger" @click="confirmAction = { type: 'rotate_join', title: '确认重置个人集群入网码 (JOIN_TOKEN)？', desc: '重置后，所有已在线或待接入节点的配置需更新为新入网码才能重新握手。' }">重置</button>
            </div>
            <div class="muted mono" style="font-size: 11px; margin-top: 8px">
              WSS 反向穿透入口：{{ reverseWssUrl }}
            </div>
          </div>
          <div class="subcard">
            <div class="kpi-label">个人 CDP 网关密钥 (API-Key，用于第三方接入自有节点及已租用节点 CDP)</div>
            <div class="row" style="margin-top: 8px">
              <input class="input mono" :value="user.api_key" readonly style="flex: 1; min-width: 180px" />
              <button class="btn btn-sm" @click="copy(user.api_key)">复制</button>
              <button class="btn btn-sm btn-danger" @click="confirmAction = { type: 'rotate_api', title: '确认重置个人 CDP 网关密钥 (API-Key)？', desc: '重置后，使用旧密钥的外部自动化脚本与 Playwright 连接将立即失效。' }">重置</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 个人 CDP 网关 API-Key 第三方接入说明 -->
      <div class="card">
        <div class="card-title">
          <div>
            <span>个人 CDP 网关 API-Key 第三方接入与节点调度指南</span>
            <span class="muted mono" style="font-size: 12px; margin-left: 10px">支持随机调度 · 轮询调度 · 自有与租用范围隔离</span>
          </div>
          <div class="row">
            <button
              class="btn btn-sm"
              :class="{ 'btn-primary': apiScope === 'owned' }"
              @click="apiScope = 'owned'"
            >
              场景 A：仅获取自有节点 (scope=owned)
            </button>
            <button
              class="btn btn-sm"
              :class="{ 'btn-emerald': apiScope === 'all' }"
              @click="apiScope = 'all'"
            >
              场景 B：自有 + 租用节点 (scope=all)
            </button>
            <button class="btn btn-sm" @click="showApiDocs = !showApiDocs">
              {{ showApiDocs ? '收起接入文档' : '展开接入文档' }}
            </button>
          </div>
        </div>

        <div v-if="showApiDocs">
          <div class="banner banner-info" style="margin-bottom: 12px">
            <strong>当前示例作用域：</strong>
            <span v-if="apiScope === 'owned'">
              仅拉取您名下<strong>自有节点</strong> (<span class="mono">scope=owned</span>)，返回的节点 <span class="mono">access_role="owner"</span>，适合调用个人浏览器集群及读写自有空闲节点 Cookie。
            </span>
            <span v-else>
              同时拉取您名下<strong>自有节点 + 当前在租节点</strong> (<span class="mono">scope=all</span>)，您也可传 <span class="mono">scope=leased</span> 仅获取租用的市场节点。支持通过 <span class="mono">access_role</span> 区分来源（<span class="mono">owner</span> vs <span class="mono">leased_buyer</span>）。
            </span>
          </div>

          <div class="subnav">
            <button class="subnav-btn" :class="{ active: docTab === 'rest' }" @click="docTab = 'rest'">1. 获取节点列表接口 (REST / JSON)</button>
            <button class="subnav-btn" :class="{ active: docTab === 'random' }" @click="docTab = 'random'">2. 随机使用节点 (Python Playwright)</button>
            <button class="subnav-btn" :class="{ active: docTab === 'round_robin' }" @click="docTab = 'round_robin'">3. 轮询使用节点 (连接池队列)</button>
            <button class="subnav-btn" :class="{ active: docTab === 'matrix' }" @click="docTab = 'matrix'">4. 自有 vs 租用范围对比与鉴权规则</button>
            <button class="subnav-btn" :class="{ active: docTab === 'leased_cookie' }" @click="docTab = 'leased_cookie'">5. 租用节点过登录与防机器人实战</button>
            <button class="subnav-btn" :class="{ active: docTab === 'openclaw' }" @click="docTab = 'openclaw'">6. OpenClaw 直连配置 & Skill 调度</button>
          </div>

          <div v-if="docTab === 'rest'">
            <div class="row" style="justify-content: space-between; margin-bottom: 8px">
              <span class="muted">支持请求头 <span class="mono">Authorization: Bearer &lt;API_KEY&gt;</span> 或 <span class="mono">X-API-Key: &lt;API_KEY&gt;</span>；加上 <span class="mono">online_only=true</span> 自动过滤离线节点。</span>
              <button class="btn btn-sm btn-primary" @click="copy(curlSnippet)">复制 cURL 命令</button>
            </div>
            <pre class="code-block">{{ curlSnippet }}</pre>
            <div class="muted" style="font-size: 12px; margin-top: 8px">
              返回 JSON 包含 <span class="mono">total / owned_count / leased_count / online_count</span> 以及 <span class="mono">nodes[]</span>。每个节点条目均提供：
              <span class="mono">preferred_cdp_url</span>（WSS 网关）、<span class="mono">cdp_http_base</span>（支持 <span class="mono">/json/version</span> 与 <span class="mono">/json/list</span> 探测的 HTTPS 入口）、<span class="mono">connection_views.same_host_automation.gateway_url</span> 以及 <span class="mono">access_role</span>（<span class="mono">owner</span> 或 <span class="mono">leased_buyer</span>）。
            </div>
          </div>

          <div v-else-if="docTab === 'random'">
            <div class="row" style="justify-content: space-between; margin-bottom: 8px">
              <span class="muted">适用于爬虫、数据采集或并发任务：从 <span class="mono">scope={{ apiScope }}</span> 在线节点中随机抽取一个执行，失败自动切换下一个节点。</span>
              <button class="btn btn-sm btn-primary" @click="copy(pythonRandomSnippet)">复制随机调度代码</button>
            </div>
            <pre class="code-block">{{ pythonRandomSnippet }}</pre>
          </div>

          <div v-else-if="docTab === 'round_robin'">
            <div class="row" style="justify-content: space-between; margin-bottom: 8px">
              <span class="muted">适用于均匀分摊负载：通过线程安全的循环迭代器顺序轮询每个节点，并支持定期刷新节点列表。</span>
              <button class="btn btn-sm btn-primary" @click="copy(pythonRoundRobinSnippet)">复制轮询调度代码</button>
            </div>
            <pre class="code-block">{{ pythonRoundRobinSnippet }}</pre>
          </div>

          <div v-else-if="docTab === 'matrix'" class="grid-2">
            <div class="subcard">
              <div class="card-title" style="margin-bottom: 8px">
                <span>仅使用自有节点</span>
                <span class="tag tag-info">scope=owned</span>
              </div>
              <div class="muted" style="font-size: 13px; line-height: 1.7">
                • 请求：<span class="mono">GET /api/v1/nodes?online_only=true&amp;scope=owned</span><br />
                • 节点角色：<span class="mono">access_role === "owner"</span>，<span class="mono">lease_id === null</span><br />
                • 计费规则：公网 WSS 直连节点全免费；WSS 反向穿透仅扣除自用 Hub 流量费<br />
                • Cookie 权限：节点空闲（未出租）时，可调用 <span class="mono">/api/v1/nodes/{id}/cookies</span> 提取与注入
              </div>
            </div>
            <div class="subcard">
              <div class="card-title" style="margin-bottom: 8px">
                <span>自有节点 + 已租用节点混合池</span>
                <span class="tag tag-ok">scope=all / scope=leased</span>
              </div>
              <div class="muted" style="font-size: 13px; line-height: 1.7">
                • 请求：<span class="mono">GET /api/v1/nodes?online_only=true&amp;scope=all</span>（或仅看租用节点传 <span class="mono">scope=leased</span>）<br />
                • 节点角色：租用节点标记为 <span class="mono">access_role === "leased_buyer"</span> 并附带 <span class="mono">lease_id</span><br />
                • 隐私与安全边界：租用节点严格禁止调用 <span class="mono">/cookies</span> 接口，仅开放 Playwright/Puppeteer CDP 协议控制<br />
                • 生命周期：市场租约一经停止或余额耗尽，接口自动将其移出池子并实时切断其 CDP WebSocket 通道
              </div>
            </div>
          </div>

          <div v-else-if="docTab === 'leased_cookie'">
            <div class="banner banner-info" style="margin-bottom: 10px">
              <strong>核心原则：</strong>禁止调用 <span class="mono">/cookies</span> 只是防止读写卖家主浏览器硬盘上的全量 Cookie 库；您的脚本连上租用节点 CDP 后，可使用 Playwright 的 <strong><span class="mono">browser.new_context()</span> 内存隔离上下文</strong>，自带 Cookie 登录并通过真实浏览器指纹+IP 过防机器人，用完 <span class="mono">context.close()</span> 即销毁，不写卖家硬盘也不混入卖家账号。
            </div>
            <div class="row" style="justify-content: space-between; margin-bottom: 8px">
              <span class="muted">从自有节点或本地读取 Cookie → 在租用节点创建独立 <span class="mono">new_context()</span> 注入并过风控 → 导出本次会话新凭证并释放。</span>
              <button class="btn btn-sm btn-primary" @click="copy(pythonLeasedContextSnippet)">复制隔离上下文代码</button>
            </div>
            <pre class="code-block">{{ pythonLeasedContextSnippet }}</pre>
          </div>

          <div v-else>
            <div class="banner banner-info" style="margin-bottom: 10px">
              <strong>OpenClaw 集成方式：</strong>① 固定单节点只需配置 <span class="mono">~/.openclaw/openclaw.json</span> 的 <span class="mono">cdpUrl</span>（网关已原生支持 <span class="mono">/json/version</span>、<span class="mono">/json/list</span> 与 <span class="mono">/ws</span>）；② 动态节点池调度与双模式采集（无 Cookie 匿名采集 / 带 Cookie 隔离采集）请启用仓库 <span class="mono">chromium/openclaw-skill/chromium-cdp-hub</span> Skill。
            </div>
            <div class="row" style="justify-content: space-between; margin-bottom: 8px">
              <span class="muted">已自动填入当前站点地址与您的个人 API-Key，支持 <span class="mono">scope={{ apiScope }}</span>。</span>
              <button class="btn btn-sm btn-primary" @click="copy(openclawSnippet)">复制 OpenClaw 配置与命令</button>
            </div>
            <pre class="code-block">{{ openclawSnippet }}</pre>
          </div>
        </div>
      </div>
    </template>

    <!-- 共享上架弹窗 -->
    <div v-if="shareTarget" class="modal-backdrop" @click.self="shareTarget = null">
      <div class="modal-box">
        <h3 class="card-title">共享节点上架定价 · #{{ shareTarget.id }} {{ shareTarget.name }}</h3>
        <div class="banner banner-warn">
          <strong>多用户隐私与资源保护：</strong><br />
          1. 节点出租期间，Hub 将自动暂停您个人 Cookie 策略对该节点的读取/写入，并锁死 <span class="mono">/cookies</span> 接口。<br />
          2. 默认采用 <strong>独占槽位 (Max=1)</strong>，推荐配合隔离容器使用，避免单节点多开独立 Chromium Profile 撑爆宿主机内存。
        </div>
        <div class="field">
          <label class="switch-row" :class="{ active: shareForm.share_enabled }">
            <span>
              <span class="switch-row-title">上架至公共算力交易市场</span>
              <span class="switch-row-desc">开启后接受其他租户按需租用并按平台核定底价获得分成</span>
            </span>
            <span class="switch">
              <input type="checkbox" v-model="shareForm.share_enabled" />
              <span class="switch-track"></span>
            </span>
          </label>
        </div>
        <div class="grid-2">
          <div class="field"><label>市场展示标题</label><input class="input" v-model="shareForm.share_title" /></div>
          <div class="field">
            <label>地区标签（支持 geoip.dat 自动识别或手动填写，如 US / HK / JP）</label>
            <div class="row" style="gap: 6px; flex-wrap: nowrap">
              <input class="input mono" v-model="shareForm.share_region" style="flex: 1" />
              <button
                type="button"
                class="btn btn-sm"
                :disabled="geoDetectBusy"
                @click="detectNodeRegion(shareTarget.id, 'share')"
              >
                {{ geoDetectBusy ? '识别中...' : 'GeoIP 识别' }}
              </button>
            </div>
          </div>
          <div class="field">
            <div class="label-with-help">
              <span>卖家底价 · 时租 (元/小时)</span>
              <button
                type="button"
                class="help-icon-btn"
                :class="{ active: showPricingHelp }"
                title="点击查看平台统一定价与等级/质量加成详情"
                aria-label="查看卖家底价计算说明"
                @click="showPricingHelp = !showPricingHelp"
              >
                ?
              </button>
            </div>
            <input class="input mono" :value="lockedSellerHourYuan" readonly disabled />
          </div>
          <div class="field">
            <div class="label-with-help">
              <span>卖家底价 · 流量 (元/GB)</span>
              <button
                type="button"
                class="help-icon-btn"
                :class="{ active: showPricingHelp }"
                title="点击查看平台统一定价与等级/质量加成详情"
                aria-label="查看卖家底价计算说明"
                @click="showPricingHelp = !showPricingHelp"
              >
                ?
              </button>
            </div>
            <input class="input mono" :value="lockedSellerGbYuan" readonly disabled />
          </div>
          <div class="field">
            <label>会话隔离策略</label>
            <select class="select" v-model="shareForm.isolation_mode">
              <option value="exclusive_slot">独占单槽位（单次仅限 1 买家，最省内存最稳）</option>
              <option value="ephemeral_profile">多路并发临时 Profile（适合高配容器节点）</option>
            </select>
          </div>
          <div class="field" v-if="shareForm.isolation_mode === 'ephemeral_profile'">
            <label>最大并发租约槽位数 (1~8)</label>
            <input class="input" type="number" min="1" max="8" v-model.number="shareForm.max_concurrent_leases" />
          </div>
        </div>

        <!-- 点击 ? 展开的平台统一定价详情/帮助卡片 -->
        <div v-if="showPricingHelp" class="banner banner-info" style="font-size: 12px; line-height: 1.7">
          <div class="row" style="justify-content: space-between; margin-bottom: 4px">
            <strong>平台统一定价规则说明（时租与流量底价均不可手动修改，由平台统一核定）</strong>
            <button type="button" class="btn btn-sm" @click="showPricingHelp = false">收起</button>
          </div>
          <div>
            • <strong>计算公式：</strong><code>平台基本定价 × (1 + 用户等级加成 + 节点质量评级加成)</code>（结果精确到 0.01 元）。
          </div>
          <div>
            • <strong>当前节点核算明细：</strong>
            等级 [{{ currentPricing.seller_level_name }}] <span class="mono">+{{ ((currentPricing.level_bonus_bps || 0) / 100).toFixed(0) }}%</span>
            + 节点质量 [{{ currentPricing.quality_label }} · 延迟 {{ currentPricing.avg_latency_ms > 0 ? `${currentPricing.avg_latency_ms}ms` : '--' }} / 速率 {{ currentPricing.avg_speed_kbps || 0 }}KB/s] <span class="mono">+{{ ((currentPricing.quality_bonus_bps || 0) / 100).toFixed(0) }}%</span>
            （总加成 <span class="mono">+{{ ((currentPricing.total_bonus_bps || 0) / 100).toFixed(0) }}%</span>）：
            <div class="mono" style="margin-top: 2px">
              - 时租底价：平台基准 ¥{{ currentPricing.base_hour_yuan }}/h → <strong>¥{{ lockedSellerHourYuan }}/h</strong><br />
              - 流量底价：平台基准 ¥{{ currentPricing.base_gb_yuan }}/GB → <strong>¥{{ lockedSellerGbYuan }}/GB</strong>
            </div>
          </div>
          <div>
            • <strong>等级加成标准：</strong>Lv.1 青铜 +0% · Lv.2 白银 +10% · Lv.3 黄金 +20% · Lv.4 钻石 +35%。
          </div>
          <div>
            • <strong>质量评级加成：</strong>S级（延迟≤120ms 且 速率≥300KB/s）+25% · A级（延迟≤250ms 且 速率≥100KB/s，或延迟≤120ms）+15% · B级（延迟≤500ms 或 速率≥40KB/s）+5% · C级 +0%（可先点「探活」更新测速数据）。
          </div>
        </div>

        <div class="banner banner-info mono">
          通道 [{{ channelLabel(shareTarget.channel_type || shareTarget.conn_type) }}] · 等级 [{{ shareTarget.seller_level_name || 'Lv.1' }}] · 质量 [{{ currentPricing.quality_label }}] · 平台加价 {{ (activeShareFeeBps / 100).toFixed(1) }}%<br />
          买家实付基准约 ¥{{ previewBuyerHr }}/h + ¥{{ previewBuyerGb }}/GB（差价归平台运营盈利，您 100% 实得平台核定的时租底价与流量底价）
        </div>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" :disabled="savingShare" @click="shareTarget = null">取消</button>
          <button class="btn btn-primary" :disabled="savingShare" @click="saveShare">
            {{ savingShare ? '正在保存...' : shareForm.share_enabled ? '保存并上架市场' : '保存并下架' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 修改节点配置弹窗 -->
    <div v-if="editTarget" class="modal-backdrop" @click.self="editTarget = null">
      <div class="modal-box">
        <div class="card-title">
          <span>修改节点配置 · #{{ editTarget.id }} {{ editTarget.name }}</span>
          <button class="btn btn-sm" @click="editTarget = null">关闭</button>
        </div>
        <form @submit.prevent="saveEditNode">
          <div class="grid-2">
            <div class="field">
              <label>节点名称</label>
              <input class="input" required v-model="editForm.name" />
            </div>
            <div class="field">
              <label>所属分组</label>
              <input class="input" v-model="editForm.group_name" placeholder="默认分组" />
            </div>
            <div class="field">
              <label>地区标签（GeoIP / 自定义）</label>
              <div class="row" style="gap: 6px; flex-wrap: nowrap">
                <input class="input mono" v-model="editForm.share_region" style="flex: 1" placeholder="如 US / HK / JP / Global" />
                <button
                  type="button"
                  class="btn btn-sm"
                  :disabled="geoDetectBusy"
                  @click="detectNodeRegion(editTarget.id, 'edit')"
                >
                  {{ geoDetectBusy ? '识别中...' : 'GeoIP 识别' }}
                </button>
              </div>
              <div class="muted mono" style="font-size: 11px; margin-top: 4px">
                记录公网/接入 IP：{{ editTarget.last_ip || '暂未记录' }}
              </div>
            </div>
            <div class="field">
              <label>节点接入类型（SaaS 纯 WSS 路由，无需本地绑定端口）</label>
              <input
                class="input mono"
                :value="`${channelLabel(editTarget.channel_type || editTarget.conn_type)} · ${editTarget.client_type || 'desktop'}`"
                readonly
                disabled
              />
            </div>
          </div>

          <div v-if="['public_wss', 'wss_direct'].includes(editTarget.conn_type)" class="grid-2">
            <div class="field">
              <label>公网 WSS 节点端点 (wss_endpoint)</label>
              <input class="input mono" v-model="editForm.wss_endpoint" placeholder="1.2.3.4:9443 或 domain:9443" />
            </div>
            <div class="field">
              <label>节点边端鉴权密钥 (edge_wss_secret)</label>
              <input class="input mono" v-model="editForm.edge_wss_secret" placeholder="留空表示不修改或未设密钥" />
            </div>
          </div>

          <div class="field">
            <label class="switch-row" :class="{ active: editForm.api_enabled }">
              <span>
                <span class="switch-row-title">开放第三方 CDP API 接入</span>
                <span class="switch-row-desc">关闭后仅可作为自有同步节点，不对外提供 /api/v1 及市场出租</span>
              </span>
              <span class="switch">
                <input
                  type="checkbox"
                  v-model="editForm.api_enabled"
                  :disabled="editTarget.client_type === 'android'"
                />
                <span class="switch-track"></span>
              </span>
            </label>
          </div>

          <div class="row" style="justify-content: flex-end">
            <button type="button" class="btn" :disabled="savingEdit" @click="editTarget = null">取消</button>
            <button type="submit" class="btn btn-primary" :disabled="savingEdit">
              {{ savingEdit ? '保存中...' : '保存节点配置' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- Cookie 明细弹窗 -->
    <div v-if="cookieDetailModal" class="modal-backdrop" @click.self="cookieDetailModal = null">
      <div class="modal-box modal-box-lg">
        <div class="card-title">
          <span>节点实时 Cookie 明细 · {{ cookieDetailModal.node_name }}</span>
          <button class="btn btn-sm" @click="cookieDetailModal = null">关闭</button>
        </div>
        <div class="row" style="margin-bottom: 12px">
          <span class="tag tag-info">总计 {{ cookieDetailModal.total }}</span>
          <span class="tag tag-ok">长期有效 {{ cookieDetailModal.valid_count }}</span>
          <span class="tag">会话级 {{ cookieDetailModal.session_count }}</span>
          <span class="tag tag-danger">已失效 {{ cookieDetailModal.expired_count }}</span>
        </div>
        <div v-if="!cookieDetailModal.cookies || cookieDetailModal.cookies.length === 0" class="muted" style="padding: 16px 0">
          当前节点浏览器暂无 Cookie 记录（或节点未连接）。
        </div>
        <div v-else class="table-wrap" style="max-height: 55vh; overflow-y: auto">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>域名 / 路径</th>
                <th>掩码值</th>
                <th>状态</th>
                <th>过期时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(c, idx) in cookieDetailModal.cookies" :key="idx">
                <td class="mono"><strong>{{ c.name }}</strong></td>
                <td class="mono muted">{{ c.domain }}{{ c.path }}</td>
                <td class="mono muted">{{ c.value_masked }}</td>
                <td>
                  <span
                    class="tag"
                    :class="c.status === 'valid' ? 'tag-ok' : c.status === 'expired' ? 'tag-danger' : 'tag-info'"
                  >
                    {{ c.status }}
                  </span>
                </td>
                <td class="mono muted">{{ c.expires_desc }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 二次确认弹窗 -->
    <div v-if="confirmAction" class="modal-backdrop" @click.self="confirmAction = null">
      <div class="modal-box">
        <h3 class="card-title">{{ confirmAction.title }}</h3>
        <p class="muted" style="margin: 0 0 18px">{{ confirmAction.desc }}</p>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" :disabled="executingConfirm" @click="confirmAction = null">取消</button>
          <button class="btn btn-danger" :disabled="executingConfirm" @click="executeConfirmedAction">
            {{ executingConfirm ? '执行中...' : '确认执行' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { apiFetch, fmtBytes, fmtDuration } from '../../api'

const props = defineProps({
  user: { type: Object, required: true },
  quotas: { type: Object, default: () => ({}) },
  platformFeeBps: { type: Number, default: 2500 },
  channelFees: { type: Object, default: () => ({ reverse: 2500, public_wss: 1000 }) },
  userLevel: { type: Object, default: null },
})
const emit = defineEmits(['notify', 'refresh-profile', 'go-market'])

const activeSubTab = ref('nodes')
const showPublishGuide = ref(false)
const nodes = ref([])
const buyerLeases = ref([])
const shareTarget = ref(null)
const editTarget = ref(null)
const cookieDetailModal = ref(null)
const geoDetectBusy = ref(false)
const showPricingHelp = ref(false)
const confirmAction = ref(null)
const refreshing = ref(false)
const savingShare = ref(false)
const savingEdit = ref(false)
const probingNodeId = ref(null)
const busyNodeAction = ref('')
const loadingCookieNodeId = ref(null)
const stoppingLeaseId = ref(null)
const executingConfirm = ref(false)

const showApiDocs = ref(true)
const apiScope = ref('owned')
const docTab = ref('rest')

const activeBuyerLeases = computed(() => buyerLeases.value.filter((l) => l.status === 'active'))

const baseOrigin = computed(() => {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }
  return 'https://your-saas-hub.example.com'
})

const reverseWssUrl = computed(() => {
  const wsProto = baseOrigin.value.startsWith('https://') ? 'wss://' : 'ws://'
  const hostPart = baseOrigin.value.replace(/^https?:\/\//, '')
  return `${wsProto}${hostPart}/api/nodes/reverse-tunnel`
})

const displayApiKey = computed(() => props.user?.api_key || 'YOUR_API_KEY')

const curlSnippet = computed(() => {
  const scopeDesc =
    apiScope.value === 'owned'
      ? '# 仅获取个人自有在线节点 (scope=owned)'
      : '# 同时获取自有节点 + 市场已租用在线节点 (scope=all，也可传 scope=leased 仅取租用节点)'
  return `${scopeDesc}
curl -sS "${baseOrigin.value}/api/v1/nodes?online_only=true&scope=${apiScope.value}" \\
  -H "Authorization: Bearer ${displayApiKey.value}" | python3 -m json.tool`
})

const pythonRandomSnippet = computed(() => {
  const scopeLabel = apiScope.value === 'owned' ? '仅自有节点' : '自有 + 租用节点'
  return `import random
import requests
from playwright.sync_api import sync_playwright

HUB_BASE = "${baseOrigin.value}"
API_KEY = "${displayApiKey.value}"
SCOPE = "${apiScope.value}"  # ${scopeLabel}

def fetch_nodes():
    resp = requests.get(
        f"{HUB_BASE}/api/v1/nodes",
        params={"online_only": "true", "scope": SCOPE},
        headers={"X-API-Key": API_KEY},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json().get("nodes", [])

def run_with_random_node(target_url: str):
    candidates = fetch_nodes()
    if not candidates:
        raise RuntimeError(f"当前 scope={SCOPE} 下暂无可用在线节点")

    # 随机打乱顺序，首个失败时自动切换至下一个备用节点
    random.shuffle(candidates)
    with sync_playwright() as p:
        for node in candidates:
            cdp_ws = node["preferred_cdp_url"]  # 同机部署可改用 connection_views.same_host_automation.gateway_url
            try:
                browser = p.chromium.connect_over_cdp(cdp_ws)
                context = browser.contexts[0] if browser.contexts else browser.new_context()
                page = context.new_page()
                page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
                print(f"[OK] Node#{node['id']} ({node['access_role']}) -> {page.title()}")
                page.close()
                browser.close()
                return
            except Exception as err:
                print(f"[Retry] Node#{node['id']} 不可用: {err}")
    raise RuntimeError("所有候选节点均连接失败")

if __name__ == "__main__":
    run_with_random_node("https://example.com")`
})

const pythonRoundRobinSnippet = computed(() => {
  const scopeLabel = apiScope.value === 'owned' ? '仅自有节点' : '自有 + 租用节点'
  return `import itertools
import threading
import requests
from playwright.sync_api import sync_playwright

HUB_BASE = "${baseOrigin.value}"
API_KEY = "${displayApiKey.value}"
SCOPE = "${apiScope.value}"  # ${scopeLabel}

class RoundRobinNodePool:
    def __init__(self, scope: str = SCOPE):
        self.scope = scope
        self._lock = threading.Lock()
        self._nodes = []
        self._cycle = iter(())
        self.refresh()

    def refresh(self):
        resp = requests.get(
            f"{HUB_BASE}/api/v1/nodes",
            params={"online_only": "true", "scope": self.scope},
            headers={"Authorization": f"Bearer {API_KEY}"},
            timeout=10,
        )
        resp.raise_for_status()
        nodes = resp.json().get("nodes", [])
        if not nodes:
            raise RuntimeError(f"scope={self.scope} 当前无在线节点")
        with self._lock:
            self._nodes = nodes
            self._cycle = itertools.cycle(nodes)
        return len(nodes)

    def next_node(self):
        with self._lock:
            try:
                return next(self._cycle)
            except StopIteration:
                pass
        self.refresh()
        with self._lock:
            return next(self._cycle)

pool = RoundRobinNodePool()

with sync_playwright() as p:
    for i in range(6):
        node = pool.next_node()
        browser = p.chromium.connect_over_cdp(node["preferred_cdp_url"])
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.new_page()
        page.goto("https://example.com", timeout=30000)
        print(f"[第{i+1}轮] 轮询命中 Node#{node['id']} ({node['access_role']})")
        page.close()
        browser.close()`
})

const pythonLeasedContextSnippet = computed(() => {
  return `import requests
from playwright.sync_api import sync_playwright

HUB_BASE = "${baseOrigin.value}"
API_KEY = "${displayApiKey.value}"
HEADERS = {"Authorization": f"Bearer {API_KEY}"}

# 1. 可选：先从自己名下的【自有空闲节点】或本地 auth.json 读取登录态 Cookie
owned = requests.get(f"{HUB_BASE}/api/v1/nodes", params={"online_only": "true", "scope": "owned"}, headers=HEADERS, timeout=10).json().get("nodes", [])
pw_cookies = []
if owned:
    raw = requests.get(f"{HUB_BASE}/api/v1/nodes/{owned[0]['id']}/cookies", headers=HEADERS, timeout=10).json().get("cookies", [])
    pw_cookies = [
        {
            "name": c["name"],
            "value": c["value"],
            "domain": c["domain"],
            "path": c.get("path", "/"),
            "secure": bool(c.get("secure", False)),
            "httpOnly": bool(c.get("httpOnly", False)),
        }
        for c in raw
    ]

# 2. 获取市场【已租用节点】的 CDP 地址 (scope=leased)
leased = requests.get(f"{HUB_BASE}/api/v1/nodes", params={"online_only": "true", "scope": "leased"}, headers=HEADERS, timeout=10).json().get("nodes", [])
if not leased:
    raise RuntimeError("请先在共享交易市场租用至少 1 个在线节点")

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(leased[0]["preferred_cdp_url"])

    # 3. 关键：务必使用 new_context() 在内存中创建隔离无痕上下文，严禁混用卖家默认 contexts[0]
    context = browser.new_context()
    if pw_cookies:
        context.add_cookies(pw_cookies)

    page = context.new_page()
    page.goto("https://example.com", wait_until="domcontentloaded", timeout=30000)

    # 4. 在该会话中完成登录或通过 Cloudflare/滑块验证后，只导出当前隔离上下文产生的新 Cookie
    new_state = context.storage_state()  # {"cookies": [...], "origins": [...]}
    print("本次携带登录并过风控后的有效 Cookie 数:", len(new_state.get("cookies", [])))

    # 5. 任务结束立即关闭 context，凭据随内存释放，不留痕在卖家硬盘
    context.close()
    browser.close()`
})

const openclawSnippet = computed(() => {
  const wsProto = baseOrigin.value.startsWith('https://') ? 'wss://' : 'ws://'
  const hostPart = baseOrigin.value.replace(/^https?:\/\//, '')
  const firstId = nodes.value[0]?.id || 1
  return `# ====== 方式 A：固定单节点直连（仅改 ~/.openclaw/openclaw.json，无需 Skill） ======
{
  "browser": {
    "enabled": true,
    "defaultProfile": "saas-node-${firstId}",
    "remoteCdpTimeoutMs": 5000,
    "remoteCdpHandshakeTimeoutMs": 8000,
    "profiles": {
      "saas-node-${firstId}": {
        // 也可使用 HTTPS 自动探测模式: "${baseOrigin.value}/cdp/${firstId}?api_key=${displayApiKey.value}"
        "cdpUrl": "${wsProto}${hostPart}/cdp/${firstId}/ws?api_key=${displayApiKey.value}",
        "attachOnly": true
      }
    }
  }
}

# ====== 方式 B：启用 OpenClaw Skill (chromium-cdp-hub) 动态选节点 + 双模式采集 ======
export CHROMIUM_HUB_URL="${baseOrigin.value}"
export CHROMIUM_HUB_API_KEY="${displayApiKey.value}"
export CHROMIUM_HUB_SCOPE="${apiScope.value}"

# 1) 动态挑选节点并绑定给 OpenClaw 原生 browser 工具（random 或 round-robin）
python3 ~/.openclaw/skills/chromium-cdp-hub/scripts/hub_pool.py pick --strategy round-robin --scope ${apiScope.value} --bind-profile hub-pool
openclaw browser --browser-profile hub-pool open "https://example.com"

# 2) 无登录 Cookie 匿名采集（干净 new_context，自动防风控切节点）
python3 ~/.openclaw/skills/chromium-cdp-hub/scripts/hub_pool.py crawl --url "https://example.com" --mode anon --scope ${apiScope.value} --strategy random

# 3) 带登录 Cookie 采集（从自有空闲节点/本地读取 Cookie，在隔离上下文注入执行，兼容租用节点）
python3 ~/.openclaw/skills/chromium-cdp-hub/scripts/hub_pool.py crawl --url "https://target.example.com" --mode cookie --cookie-source-node ${firstId} --scope ${apiScope.value} --strategy round-robin`
})

const shareForm = reactive({
  share_enabled: true,
  share_title: '',
  share_region: 'Global',
  share_tags: '',
  isolation_mode: 'exclusive_slot',
  max_concurrent_leases: 1,
})

const editForm = reactive({
  name: '',
  group_name: '默认分组',
  share_region: 'Global',
  wss_endpoint: '',
  edge_wss_secret: '',
  api_enabled: true,
})

function channelLabel(ch) {
  if (ch === 'public_wss' || ch === 'wss_direct') return '公网WSS直连'
  return 'WSS反向穿透'
}

function qualityTagClass(grade) {
  if (grade === 'S' || grade === 'A') return 'tag-ok'
  if (grade === 'B') return 'tag-info'
  return 'tag-warn'
}

const currentPricing = computed(() => {
  const mp = shareTarget.value?.market_pricing || shareTarget.value?.gb_pricing
  if (mp) {
    return {
      base_hour_yuan: mp.base_hour_yuan || '0.50',
      base_gb_yuan: mp.base_gb_yuan || '1.00',
      ...mp,
    }
  }
  const hourUnits = Number(shareTarget.value?.seller_price_per_hour_units ?? 5000)
  const gbUnits = Number(shareTarget.value?.seller_price_per_gb_units ?? 10000)
  return {
    base_hour_yuan: '0.50',
    base_gb_yuan: '1.00',
    seller_level_name: shareTarget.value?.seller_level_name || props.userLevel?.name || 'Lv.1 青铜节点主',
    level_bonus_bps: 0,
    quality_grade: shareTarget.value?.quality_grade || 'C',
    quality_label: shareTarget.value?.quality_label || 'C级 · 基础/待测',
    quality_bonus_bps: 0,
    total_bonus_bps: 0,
    seller_hour_units: hourUnits,
    seller_hour_yuan: (hourUnits / 10000).toFixed(2),
    seller_gb_units: gbUnits,
    seller_gb_yuan: (gbUnits / 10000).toFixed(2),
    avg_latency_ms: Number(shareTarget.value?.avg_latency_ms || 0),
    avg_speed_kbps: Number(shareTarget.value?.avg_speed_kbps || 0),
  }
})

const lockedSellerHourYuan = computed(() => {
  if (currentPricing.value?.seller_hour_yuan !== undefined) {
    return Number(currentPricing.value.seller_hour_yuan).toFixed(2)
  }
  const units = Number(shareTarget.value?.seller_price_per_hour_units ?? 5000)
  return (units / 10000).toFixed(2)
})

const lockedSellerGbYuan = computed(() => {
  if (currentPricing.value?.seller_gb_yuan !== undefined) {
    return Number(currentPricing.value.seller_gb_yuan).toFixed(2)
  }
  const units = Number(shareTarget.value?.seller_price_per_gb_units ?? 10000)
  return (units / 10000).toFixed(2)
})

const activeShareFeeBps = computed(() => {
  if (shareTarget.value && shareTarget.value.platform_fee_bps !== undefined) {
    return Number(shareTarget.value.platform_fee_bps)
  }
  return Number(props.platformFeeBps || 2500)
})

const previewBuyerHr = computed(() => (Number(lockedSellerHourYuan.value || 0) * (1 + activeShareFeeBps.value / 10000)).toFixed(2))
const previewBuyerGb = computed(() => (Number(lockedSellerGbYuan.value || 0) * (1 + activeShareFeeBps.value / 10000)).toFixed(2))

async function load(showFeedback = false) {
  if (refreshing.value) return
  refreshing.value = true
  try {
    const [nodesRes, leasesRes] = await Promise.all([apiFetch('/api/nodes'), apiFetch('/api/leases')])
    nodes.value = nodesRes || []
    buyerLeases.value = leasesRes?.buyer_leases || []
    if (showFeedback) {
      emit('notify', { message: '节点与租约状态已刷新', type: 'info' })
    }
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    refreshing.value = false
  }
}

function copy(val) {
  navigator.clipboard?.writeText(val || '')
  emit('notify', { message: '已复制到剪贴板', type: 'ok' })
}

async function executeConfirmedAction() {
  if (executingConfirm.value) return
  const act = confirmAction.value
  if (!act) return
  executingConfirm.value = true
  try {
    if (act.type === 'rotate_api') {
      await rotate(true, false)
    } else if (act.type === 'rotate_join') {
      await rotate(false, true)
    } else if (act.type === 'delete_node') {
      await deleteNode(act.nodeId)
    }
    confirmAction.value = null
  } finally {
    executingConfirm.value = false
  }
}

async function rotate(rotApi, rotJoin) {
  try {
    await apiFetch('/api/profile/rotate-credentials', {
      method: 'POST',
      body: JSON.stringify({ rotate_api_key: rotApi, rotate_join_token: rotJoin }),
    })
    emit('refresh-profile')
    emit('notify', { message: '凭据已重新签发', type: 'ok' })
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  }
}

function openShareModal(n) {
  shareTarget.value = n
  showPricingHelp.value = false
  shareForm.share_enabled = n.share_enabled ? true : true
  shareForm.share_title = n.share_title || n.name
  shareForm.share_region = n.share_region || 'Global'
  shareForm.share_tags = n.share_tags || ''
  shareForm.isolation_mode = n.isolation_mode || 'exclusive_slot'
  shareForm.max_concurrent_leases = n.max_concurrent_leases || 1
}

async function saveShare() {
  if (savingShare.value || !shareTarget.value) return
  savingShare.value = true
  try {
    const res = await apiFetch(`/api/nodes/${shareTarget.value.id}/share`, {
      method: 'POST',
      body: JSON.stringify(shareForm),
    })
    shareTarget.value = null
    showPricingHelp.value = false
    emit('notify', { message: res.message || '共享状态已保存', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    savingShare.value = false
  }
}

async function stopBuyerLease(leaseId) {
  if (stoppingLeaseId.value !== null) return
  stoppingLeaseId.value = leaseId
  try {
    const res = await apiFetch(`/api/leases/${leaseId}/stop`, { method: 'POST' })
    emit('notify', { message: res.message || '租约已退租结算', type: 'ok' })
    emit('refresh-profile')
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    stoppingLeaseId.value = null
  }
}

async function probeNode(id) {
  if (probingNodeId.value !== null) return
  probingNodeId.value = id
  try {
    const res = await apiFetch(`/api/nodes/${id}/probe`, { method: 'POST' })
    emit('notify', { message: res.message || '节点探活完成', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    probingNodeId.value = null
  }
}

function openEditModal(n) {
  editTarget.value = n
  editForm.name = n.name || ''
  editForm.group_name = n.group_name || '默认分组'
  editForm.share_region = n.share_region || 'Global'
  editForm.wss_endpoint = n.wss_endpoint || n.recommended_endpoint || ''
  editForm.edge_wss_secret = n.edge_wss_secret || ''
  editForm.api_enabled = n.client_type === 'android' ? false : n.api_enabled !== 0
}

async function saveEditNode() {
  if (!editTarget.value || savingEdit.value) return
  savingEdit.value = true
  try {
    const payload = {
      name: editForm.name,
      group_name: editForm.group_name,
      share_region: editForm.share_region,
      api_enabled: editTarget.value.client_type === 'android' ? 0 : editForm.api_enabled ? 1 : 0,
    }
    if (['public_wss', 'wss_direct'].includes(editTarget.value.conn_type)) {
      payload.wss_endpoint = editForm.wss_endpoint
      payload.edge_wss_secret = editForm.edge_wss_secret
    }
    const res = await apiFetch(`/api/nodes/${editTarget.value.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
    editTarget.value = null
    emit('notify', { message: res.message || '节点配置已更新', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    savingEdit.value = false
  }
}

async function detectNodeRegion(nodeId, targetForm) {
  if (geoDetectBusy.value) return
  geoDetectBusy.value = true
  try {
    const res = await apiFetch(`/api/nodes/${nodeId}/detect-region`, { method: 'POST' })
    if (res.share_region) {
      if (targetForm === 'edit') editForm.share_region = res.share_region
      if (targetForm === 'share') shareForm.share_region = res.share_region
    }
    emit('notify', { message: res.message || `已识别地区: ${res.share_region}`, type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    geoDetectBusy.value = false
  }
}

async function toggleEnabled(n) {
  if (busyNodeAction.value) return
  busyNodeAction.value = `enabled:${n.id}`
  try {
    const res = await apiFetch(`/api/nodes/${n.id}/toggle-enabled`, { method: 'POST' })
    emit('notify', { message: res.message || '节点状态已更新', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    busyNodeAction.value = ''
  }
}

async function toggleApi(n) {
  if (busyNodeAction.value) return
  busyNodeAction.value = `api:${n.id}`
  try {
    const res = await apiFetch(`/api/nodes/${n.id}/toggle-api`, { method: 'POST' })
    emit('notify', { message: res.message || 'API 状态已切换', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    busyNodeAction.value = ''
  }
}

async function toggleSource(n) {
  if (busyNodeAction.value) return
  busyNodeAction.value = `source:${n.id}`
  try {
    const res = await apiFetch(`/api/nodes/${n.id}/toggle-source`, { method: 'POST' })
    emit('notify', { message: res.message || '源节点状态已更新', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    busyNodeAction.value = ''
  }
}

async function openCookieDetails(n) {
  if (loadingCookieNodeId.value !== null) return
  loadingCookieNodeId.value = n.id
  try {
    const res = await apiFetch(`/api/nodes/${n.id}/cookie-details`)
    cookieDetailModal.value = res
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    loadingCookieNodeId.value = null
  }
}

async function deleteNode(id) {
  try {
    await apiFetch(`/api/nodes/${id}`, { method: 'DELETE' })
    emit('notify', { message: '节点已移除', type: 'ok' })
    emit('refresh-profile')
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  }
}

onMounted(() => load(false))
</script>
