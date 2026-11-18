<template>
  <div>
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

    <div class="card">
      <div class="card-title">
        <span>自有节点清单 & 共享出租上架配置</span>
        <div class="row">
          <span v-if="userLevel" class="tag" :style="{ color: userLevel.badge_color, borderColor: userLevel.badge_color }">
            当前 {{ userLevel.name }} · 反穿 {{ ((userLevel.reverse_fee_bps || channelFees.reverse || 2500) / 100).toFixed(1) }}% / WSS直连 {{ ((userLevel.public_wss_fee_bps || channelFees.public_wss || 1000) / 100).toFixed(1) }}%
          </span>
          <button class="btn btn-sm" @click="load">刷新状态</button>
        </div>
      </div>

      <div class="banner banner-info" style="margin-bottom: 12px">
        <strong>纯 WSS 入网与自用双计费说明：</strong>SaaS 版仅支持 <span class="mono">WSS 反向穿透</span> 与 <span class="mono">公网 WSS 直连</span>。<br />
        • <strong>自用公网 WSS 直连</strong>：节点免费 ¥0 + Hub 流量 ¥0（完全零扣费，仅做信令调度）。<br />
        • <strong>自用 WSS 反向穿透</strong>：节点自身 ¥0，但经过 Hub 中继转发会产生平台流量成本，按每 GB 阶梯/基准费率扣减余额（余额不足自动阻断）。
      </div>

      <div v-if="nodes.length === 0" class="muted" style="padding: 18px 0">
        暂无自有节点。请在节点端填入上方 <span class="mono">JOIN_TOKEN</span> 通过 WSS 反向穿透或公网 WSS 直连入网，即可在此管理或上架出租赚取收益。
      </div>

      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID / 名称</th>
              <th>通道 / 状态 / 速度质量</th>
              <th>活跃租约 / 隔离模式</th>
              <th>共享市场定价 (卖家底价 → 买家价)</th>
              <th>累计流量 / 在线</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="n in nodes" :key="n.id">
              <td>
                <div><strong>#{{ n.id }} {{ n.name }}</strong></div>
                <div class="muted mono">{{ n.group_name }} · {{ n.client_type || 'desktop' }}</div>
              </td>
              <td>
                <div>
                  <span class="tag tag-info">{{ channelLabel(n.channel_type || n.conn_type) }}</span>
                  <span class="tag" :class="n.status === 'connected' ? 'tag-ok' : 'tag-warn'" style="margin-left: 4px">{{ n.status }}</span>
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
                  <div class="muted mono" style="font-size: 11px">若上架加价 {{ ((n.platform_fee_bps || 0) / 100).toFixed(1) }}%</div>
                </div>
              </td>
              <td class="mono">
                CDP: {{ fmtBytes((n.cdp_rx_bytes || 0) + (n.cdp_tx_bytes || 0)) }}<br />
                在线: {{ fmtDuration(n.online_seconds || 0) }} · 已租 {{ fmtDuration(n.total_leased_seconds) }}
              </td>
              <td>
                <div class="row">
                  <button class="btn btn-sm btn-emerald" @click="openShareModal(n)">共享定价</button>
                  <button class="btn btn-sm" @click="probeNode(n.id)">探活</button>
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
          <label class="row" style="cursor: pointer">
            <input type="checkbox" v-model="shareForm.share_enabled" />
            <span>上架至公共算力交易市场接受其他租户按需租用</span>
          </label>
        </div>
        <div class="grid-2">
          <div class="field"><label>市场展示标题</label><input class="input" v-model="shareForm.share_title" /></div>
          <div class="field"><label>地区标签</label><input class="input" v-model="shareForm.share_region" /></div>
          <div class="field">
            <label>卖家底价 · 时租 (元/小时)</label>
            <input class="input" type="number" step="0.05" min="0" v-model.number="shareForm.seller_price_per_hour_yuan" />
          </div>
          <div class="field">
            <label>卖家底价 · 流量 (元/GB)</label>
            <input class="input" type="number" step="0.05" min="0" v-model.number="shareForm.seller_price_per_gb_yuan" />
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
        <div class="banner banner-info mono">
          通道 [{{ channelLabel(shareTarget.channel_type || shareTarget.conn_type) }}] · 等级 [{{ shareTarget.seller_level_name || 'Lv.1' }}] 平台加价 {{ (activeShareFeeBps / 100).toFixed(1) }}%<br />
          买家实付基准约 ¥{{ previewBuyerHr }}/h + ¥{{ previewBuyerGb }}/GB（差价归平台运营盈利，您 100% 实得所设底价；高等级节点主或公网 WSS 直连享更低差价）
        </div>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" @click="shareTarget = null">取消</button>
          <button class="btn btn-primary" @click="saveShare">保存上架设置</button>
        </div>
      </div>
    </div>

    <!-- 二次确认弹窗 -->
    <div v-if="confirmAction" class="modal-backdrop" @click.self="confirmAction = null">
      <div class="modal-box">
        <h3 class="card-title">{{ confirmAction.title }}</h3>
        <p class="muted" style="margin: 0 0 18px">{{ confirmAction.desc }}</p>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" @click="confirmAction = null">取消</button>
          <button class="btn btn-danger" @click="executeConfirmedAction">确认执行</button>
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
const emit = defineEmits(['notify', 'refresh-profile'])

const nodes = ref([])
const shareTarget = ref(null)
const confirmAction = ref(null)

const showApiDocs = ref(true)
const apiScope = ref('owned')
const docTab = ref('rest')

const baseOrigin = computed(() => {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }
  return 'https://your-saas-hub.example.com'
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
  seller_price_per_hour_yuan: 0.5,
  seller_price_per_gb_yuan: 1.0,
  isolation_mode: 'exclusive_slot',
  max_concurrent_leases: 1,
})

function channelLabel(ch) {
  if (ch === 'public_wss' || ch === 'wss_direct') return '公网WSS直连'
  return 'WSS反向穿透'
}

const activeShareFeeBps = computed(() => {
  if (shareTarget.value && shareTarget.value.platform_fee_bps !== undefined) {
    return Number(shareTarget.value.platform_fee_bps)
  }
  return Number(props.platformFeeBps || 2500)
})

const previewBuyerHr = computed(() => (shareForm.seller_price_per_hour_yuan * (1 + activeShareFeeBps.value / 10000)).toFixed(2))
const previewBuyerGb = computed(() => (shareForm.seller_price_per_gb_yuan * (1 + activeShareFeeBps.value / 10000)).toFixed(2))

async function load() {
  try {
    nodes.value = await apiFetch('/api/nodes')
  } catch (e) {
    emit('notify', e.message)
  }
}

function copy(val) {
  navigator.clipboard?.writeText(val || '')
  emit('notify', '已复制到剪贴板')
}

async function executeConfirmedAction() {
  const act = confirmAction.value
  confirmAction.value = null
  if (!act) return
  if (act.type === 'rotate_api') {
    await rotate(true, false)
  } else if (act.type === 'rotate_join') {
    await rotate(false, true)
  } else if (act.type === 'delete_node') {
    await deleteNode(act.nodeId)
  }
}

async function rotate(rotApi, rotJoin) {
  try {
    await apiFetch('/api/profile/rotate-credentials', {
      method: 'POST',
      body: JSON.stringify({ rotate_api_key: rotApi, rotate_join_token: rotJoin }),
    })
    emit('refresh-profile')
    emit('notify', '凭据已重新签发')
  } catch (e) {
    emit('notify', e.message)
  }
}

function openShareModal(n) {
  shareTarget.value = n
  shareForm.share_enabled = Boolean(n.share_enabled)
  shareForm.share_title = n.share_title || n.name
  shareForm.share_region = n.share_region || 'Global'
  shareForm.share_tags = n.share_tags || ''
  shareForm.seller_price_per_hour_yuan = Number(((n.seller_price_per_hour_units || 5000) / 10000).toFixed(2))
  shareForm.seller_price_per_gb_yuan = Number(((n.seller_price_per_gb_units || 10000) / 10000).toFixed(2))
  shareForm.isolation_mode = n.isolation_mode || 'exclusive_slot'
  shareForm.max_concurrent_leases = n.max_concurrent_leases || 1
}

async function saveShare() {
  try {
    const res = await apiFetch(`/api/nodes/${shareTarget.value.id}/share`, {
      method: 'POST',
      body: JSON.stringify(shareForm),
    })
    shareTarget.value = null
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function probeNode(id) {
  try {
    const res = await apiFetch(`/api/nodes/${id}/probe`, { method: 'POST' })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function deleteNode(id) {
  try {
    await apiFetch(`/api/nodes/${id}`, { method: 'DELETE' })
    emit('notify', '节点已移除')
    emit('refresh-profile')
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

onMounted(load)
</script>
