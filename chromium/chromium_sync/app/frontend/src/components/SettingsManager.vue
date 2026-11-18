<script setup>
import { ref, reactive, computed, onMounted } from 'vue'

const props = defineProps({
  api: Function,
  showToast: Function
})
const emit = defineEmits(['logout', 'runtime-updated'])

// 1. 管理员账号模型
const profile = reactive({
  username: '',
  new_password: '',
  api_key: ''
})

// 1.5 存储引擎 (ORM) 与缓存运行时监控状态
const runtimeInfo = reactive({
  db: { db_type: 'sqlite', target: '' },
  cache: {
    active_backend: 'sqlite_cache',
    redis_configured: false,
    redis_connected: false,
    redis_url_masked: '',
    last_error: null,
    stats: { hits: 0, misses: 0, fallbacks: 0, sqlite_fallbacks: 0 },
    sqlite_cache: { entries: 0, buffered_hashes: 0, db_path: '' }
  }
})
const redisInput = ref('')
const testingRedis = ref(false)
const reloadingCache = ref(false)
const redisTestMsg = ref('')

// 2. 指南 Tab 状态 (4 大实战场景)
const activeGuideTab = ref('same_host') // 'same_host' | 'remote_host' | 'api' | 'openclaw'

// 3. 代码折叠状态 (默认对齐场景三高度折叠)
const isCodeExpanded = ref(false)

// 4. SSH 密钥资产状态 (左列)
const keys = ref([])
const uploadRemark = ref('')

const currentHubHost = computed(() => {
  return window.location.host
})

const currentHubUrl = computed(() => {
  return `${window.location.protocol}//${window.location.host}`
})

const currentHubPort = computed(() => {
  if (window.location.port) return window.location.port
  return window.location.protocol === 'https:' ? '443' : '80'
})

const loadData = async () => {
  const [pRes, kRes, cRes, rtRes] = await Promise.all([
    props.api('/api/profile'),
    props.api('/api/ssh-keys'),
    props.api('/api/cookie-policy'),
    props.api('/api/system/runtime-info')
  ])
  Object.assign(profile, await pRes.json())
  keys.value = await kRes.json()
  if (rtRes.ok) {
    const rt = await rtRes.json()
    Object.assign(runtimeInfo.db, rt.db || {})
    Object.assign(runtimeInfo.cache, rt.cache || {})
    if (!redisInput.value && rt.cache?.redis_url_masked) {
      redisInput.value = ''
    }
  }
}

const testRedisConn = async () => {
  if (!redisInput.value.trim()) {
    redisTestMsg.value = '留空时将使用内置 SQLite WAL Cache，无需外接 Redis'
    return
  }
  testingRedis.value = true
  redisTestMsg.value = ''
  try {
    const res = await props.api('/api/setup/test-redis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redis_url: redisInput.value.trim() })
    })
    const data = await res.json()
    if (res.ok) {
      redisTestMsg.value = data.detail || 'Redis 连接成功'
      props.showToast(redisTestMsg.value, 'success')
    } else {
      redisTestMsg.value = data.detail || 'Redis 连接失败，将自动回退 SQLite Cache'
      props.showToast(redisTestMsg.value, 'error')
    }
  } finally {
    testingRedis.value = false
  }
}

const reloadCacheEngine = async (clearToSqlite = false) => {
  reloadingCache.value = true
  try {
    const targetUrl = clearToSqlite ? '' : redisInput.value.trim()
    const res = await props.api('/api/system/cache/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redis_url: targetUrl })
    })
    const data = await res.json()
    if (res.ok) {
      props.showToast(data.message || '缓存引擎已切换', 'success')
      if (clearToSqlite) redisInput.value = ''
      await loadData()
      emit('runtime-updated')
    } else {
      props.showToast(data.detail || '切换缓存失败', 'error')
    }
  } finally {
    reloadingCache.value = false
  }
}

const copyText = async (text, desc) => {
  if (!text) return
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    props.showToast(`${desc} 已复制到剪切板`, 'success')
  } catch (err) {
    props.showToast('复制失败，请手动选择复制', 'error')
  }
}

// ==================== 彻底杜绝模板属性引号冲突的脚本复制函数 ====================
const copySameHostScript = () => {
  const code = `import httpx, asyncio, random
from playwright.async_api import async_playwright

HUB_URL = "https://127.0.0.1:${currentHubPort.value}"
API_KEY = "${profile.api_key}"

async def run_same_host():
    # 1. 动态拉取当前所有健康在线的节点池
    async with httpx.AsyncClient(verify=False) as client:
        res = await client.get(
            f"{HUB_URL}/api/v1/nodes?online_only=true",
            headers={"X-API-Key": API_KEY}
        )
        online_nodes = res.json().get("nodes", [])

    if not online_nodes:
        print("当前集群暂无可用在线节点！")
        return

    # 2. 随机/轮询挑选一个节点 (分散指纹与出口特征，规避反爬检测)
    target = random.choice(online_nodes)
    endpoint = target["connection_views"]["same_host_automation"]["recommended_endpoint"]
    print(f"同机命中节点: [{target['name']}] (拓扑: {target['topology_desc']}) -> {endpoint}")

    # 3. 极速接管 CDP 自动化操控
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(endpoint)
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = await context.new_page()
        await page.goto("https://ipinfo.io")
        print("执行完成，页面标题:", await page.title())
        await browser.close()

asyncio.run(run_same_host())`
  copyText(code, '同机自动化脚本')
}

const copyRemoteHostScript = () => {
  const code = `import httpx, asyncio, random
from playwright.async_api import async_playwright

HUB_URL = "${currentHubUrl.value}"
API_KEY = "${profile.api_key}"

async def run_remote():
    # 1. 动态拉取全网在线节点池 (支持域名或 IPv6 地址)
    async with httpx.AsyncClient(verify=False) as client:
        res = await client.get(
            f"{HUB_URL}/api/v1/nodes?online_only=true",
            headers={"X-API-Key": API_KEY}
        )
        online_nodes = res.json().get("nodes", [])

    if not online_nodes:
        print("当前集群暂无可用在线节点！")
        return

    # 2. 随机/轮询选取目标节点 (多节点负载均衡，杜绝单 IP 触发反爬)
    target = random.choice(online_nodes)
    cdp_url = target["preferred_cdp_url"]  # TLS 统一网关端点
    print(f"异机分配节点: [{target['name']}] (拓扑: {target['topology_desc']})")

    # 3. 穿透接管 (无论节点在 NAT4 家宽内网还是公网云机)
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(cdp_url)
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = await context.new_page()
        await page.goto("https://ipinfo.io")
        print("异机执行完成:", await page.title())
        await browser.close()

asyncio.run(run_remote())`
  copyText(code, '异机自动化脚本')
}

const copyApiCurlScript = () => {
  const code = `# 1. 查询全网在线节点与连接视图 (含同机/异机端点，支持 IPv4/IPv6)
curl -k -H "X-API-Key: ${profile.api_key}" "${currentHubUrl.value}/api/v1/nodes?online_only=true"

# 2. 导出指定节点的全部 CookieJar (JSON 格式)
curl -k -H "X-API-Key: ${profile.api_key}" "${currentHubUrl.value}/api/v1/nodes/1/cookies"

# 3. 向指定节点注入 CookieJar (跨平台凭据投喂)
curl -k -X POST -H "X-API-Key: ${profile.api_key}" -H "Content-Type: application/json" \\
  -d '{"cookies": [{"name": "session_id", "value": "xyz123", "domain": ".example.com", "path": "/"}]}' \\
  "${currentHubUrl.value}/api/v1/nodes/1/cookies"

# 4. Webhook 触发全网调度策略即时同步
curl -k -X POST -H "X-API-Key: ${profile.api_key}" "${currentHubUrl.value}/api/v1/sync"`
  copyText(code, 'CURL 示例命令')
}

const copyOpenclawScript = () => {
  const wsProto = window.location.protocol === 'https:' ? 'wss://' : 'ws://'
  const code = `# 1. 直接改 ~/.openclaw/openclaw.json（单节点固定连接，同时支持 wss:// 与 https:// 探测）
{
  "browser": {
    "enabled": true,
    "defaultProfile": "chromium-hub-node1",
    "remoteCdpTimeoutMs": 5000,
    "remoteCdpHandshakeTimeoutMs": 8000,
    "profiles": {
      "chromium-hub-node1": {
        "cdpUrl": "${wsProto}${currentHubHost.value}/cdp/1/ws?api_key=${profile.api_key}",
        // 或 HTTPS 发现模式（支持 /json/version 与 /json/list）:
        // "cdpUrl": "${currentHubUrl.value}/cdp/1?api_key=${profile.api_key}",
        "attachOnly": true
      }
    }
  }
}

# 2. 使用 OpenClaw Skill (chromium-cdp-hub) 动态选节点 & 双模式采集
export CHROMIUM_HUB_URL="${currentHubUrl.value}"
export CHROMIUM_HUB_API_KEY="${profile.api_key}"

# 无 Cookie 匿名采集（轮询节点）
python3 ~/.openclaw/skills/chromium-cdp-hub/scripts/hub_pool.py crawl --url "https://example.com" --mode anon --strategy round-robin

# 带 Cookie 登录采集（从节点 1 提取 Cookie 后注入执行）
python3 ~/.openclaw/skills/chromium-cdp-hub/scripts/hub_pool.py crawl --url "https://target.example.com" --mode cookie --cookie-source-node 1 --strategy random`
  copyText(code, 'OpenClaw 配置与 Skill 命令')
}

const saveProfile = async () => {
  const res = await props.api('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile)
  })
  if (res.ok) {
    props.showToast('管理员账号配置已更新', 'success')
    if (profile.new_password) emit('logout')
  }
}

const regenApiKey = async () => {
  if (confirm('确定重新生成外部 Agent API Key？旧密钥将立即失效！')) {
    await props.api('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerate_key: true })
    })
    props.showToast('API Key 已刷新', 'success')
    loadData()
  }
}

const uploadKey = async (e) => {
  const file = e.target.files[0]
  if (!file) return
  const fd = new FormData()
  fd.append('file', file)
  fd.append('remark', uploadRemark.value)
  const res = await props.api('/api/ssh-keys', { method: 'POST', body: fd })
  if (res.ok) {
    props.showToast(`证书 ${file.name} 上传完成`, 'success')
    uploadRemark.value = ''
    await loadData()
  }
}

const updateRemark = async (k) => {
  const newRemark = prompt('请输入新备注信息：', k.remark || '')
  if (newRemark !== null) {
    const encodedFilename = encodeURIComponent(k.filename)
    const res = await props.api(`/api/ssh-keys/${encodedFilename}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remark: newRemark.trim() })
    })
    if (res.ok) {
      props.showToast('备注已更新', 'success')
      await loadData()
    } else {
      props.showToast('备注更新失败', 'error')
    }
  }
}

const deleteKey = async (name) => {
  if (confirm(`确认销毁密钥 [${name}]？`)) {
    const encodedFilename = encodeURIComponent(name)
    const res = await props.api(`/api/ssh-keys/${encodedFilename}`, { method: 'DELETE' })
    if (res.ok) {
      props.showToast('证书已销毁', 'success')
      await loadData()
    }
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="grid-2col-fluid">
    
    <!-- ==================== 左列：存储缓存监控 + 管理员账号 + SSH 密钥存储库 ==================== -->
    <div class="layout-column-item">

      <!-- 卡片 0: ORM 存储引擎与 Redis / SQLite Cache 熔断状态 -->
      <div class="content-full-card">
        <div class="table-header-bar" style="margin-bottom:12px; padding-bottom:8px;">
          <h3 class="card-inner-h3">🗄️ 存储引擎 (ORM) 与缓存运行监控</h3>
          <span :class="runtimeInfo.cache.active_backend === 'redis' ? 'runtime-pill-redis' : 'runtime-pill-sqlite'">
            {{ runtimeInfo.cache.active_backend === 'redis' ? '⚡ Redis 已激活' : '💾 SQLite Cache 运行中' }}
          </span>
        </div>

        <div class="runtime-metrics-grid">
          <div class="runtime-box">
            <div class="runtime-k">主数据库 (SQLAlchemy ORM)</div>
            <div class="runtime-v font-cyan-mono">
              {{ (runtimeInfo.db.db_type || 'sqlite').toUpperCase() }}
            </div>
            <div class="runtime-sub font-mono" :title="runtimeInfo.db.target">
              {{ runtimeInfo.db.target || '/data/app.db' }}
            </div>
          </div>

          <div class="runtime-box">
            <div class="runtime-k">缓存命中 / 回退次数</div>
            <div class="runtime-v font-mono" style="color:#e2e8f0;">
              {{ runtimeInfo.cache.stats?.hits || 0 }} <span style="font-size:11px; color:#64748b;">hits</span>
              · {{ runtimeInfo.cache.stats?.misses || 0 }} <span style="font-size:11px; color:#64748b;">miss</span>
            </div>
            <div class="runtime-sub font-mono">
              回退次数: {{ runtimeInfo.cache.stats?.fallbacks || runtimeInfo.cache.stats?.sqlite_fallbacks || 0 }}
              · 缓冲键: {{ runtimeInfo.cache.sqlite_cache?.buffered_hashes || 0 }}
            </div>
          </div>
        </div>

        <div v-if="runtimeInfo.cache.last_error" class="runtime-warn-box font-mono">
          ⚠️ 最近 Redis 异常（已自动回退 SQLite Cache 兜底，每 30s 自动探活重连）: {{ runtimeInfo.cache.last_error }}
        </div>

        <div style="margin-top:12px;">
          <label class="form-label">热更新 Redis URL (如 redis://127.0.0.1:6379/0，留空则切回 SQLite WAL Cache)</label>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:4px;">
            <input
              v-model="redisInput"
              :placeholder="runtimeInfo.cache.redis_url_masked || 'redis://:password@host:6379/0'"
              class="cdp-input font-mono"
              style="flex:1; min-width:200px;"
            >
            <button type="button" @click="testRedisConn" :disabled="testingRedis" class="btn-gray-test">
              {{ testingRedis ? '测试中...' : '连通性测试' }}
            </button>
            <button type="button" @click="reloadCacheEngine(false)" :disabled="reloadingCache" class="btn-primary-gradient">
              {{ reloadingCache ? '切换中...' : '应用热切换' }}
            </button>
            <button
              v-if="runtimeInfo.cache.redis_configured"
              type="button"
              @click="reloadCacheEngine(true)"
              :disabled="reloadingCache"
              class="btn-gray-test"
              title="清空 Redis 配置并切回本地 SQLite Cache"
            >
              切回 SQLite
            </button>
          </div>
          <p v-if="redisTestMsg" style="font-size:11px; color:#38bdf8; margin-top:6px;">{{ redisTestMsg }}</p>
        </div>
      </div>

      <!-- 卡片 1: 管理员账号 -->
      <div class="content-full-card">
        <h3 class="card-inner-h3" style="margin-bottom:16px;">👤 管理员账号设置</h3>
        <form @submit.prevent="saveProfile" class="form-v-stack">
          <div class="form-field-block">
            <label class="form-label">管理员登录账号</label>
            <input v-model="profile.username" required class="cdp-input cdp-w-normal">
          </div>
          <div class="form-field-block">
            <label class="form-label">重置访问密码 (留空则不修改)</label>
            <input v-model="profile.new_password" type="password" placeholder="至少 6 位安全字符" minlength="6" class="cdp-input cdp-w-normal">
          </div>
          <div style="margin-top:4px;">
            <button type="submit" class="btn-primary-gradient">保存账号修改</button>
          </div>
        </form>
      </div>

      <!-- 卡片 2: SSH 密钥存储库 (左列对称布局) -->
      <div class="content-full-card">
        <div class="table-header-bar">
          <h3 class="card-inner-h3">🔑 SSH 密钥存储库</h3>
          <span style="font-size:12px; color:#64748b;">{{ keys.length }} 个凭据</span>
        </div>

        <div style="display:flex; gap:10px; margin-bottom:14px; align-items:center; flex-wrap:wrap;">
          <input v-model="uploadRemark" placeholder="上传前填写备注 (选填)" class="cdp-input cdp-w-medium" style="height:32px;">
          <input type="file" @change="uploadKey" style="font-size:12px; color:#94a3b8;">
        </div>

        <div class="table-responsive">
          <table class="cdp-fluid-table" style="font-size:11px;">
            <thead>
              <tr>
                <th>密钥文件名</th>
                <th>备注</th>
                <th>添加时间</th>
                <th>大小</th>
                <th style="text-align:right;">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="k in keys" :key="k.filename">
                <td class="font-cyan-mono">🔑 {{ k.filename }}</td>
                <td style="color:#cbd5e1;">{{ k.remark || '---' }}</td>
                <td style="color:#64748b;">{{ k.created_at }}</td>
                <td style="color:#64748b;">{{ k.size }} B</td>
                <td style="text-align:right;">
                  <button @click="updateRemark(k)" class="link-probe" style="margin-right:8px;">编辑备注</button>
                  <button @click="deleteKey(k.filename)" class="link-probe" style="color:#f87171;">销毁</button>
                </td>
              </tr>
              <tr v-if="keys.length === 0">
                <td colspan="5" style="text-align:center; color:#64748b; padding:20px;">暂无私钥证书</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

    </div>

    <!-- ==================== 右列：外部 API 准入控制、安全网关指南 ==================== -->
    <div class="layout-column-item">

      <!-- 卡片 3: 外部 Agent 开放 API 与安全控制中枢 -->
      <div class="content-full-card">
        <div class="table-header-bar" style="margin-bottom:10px; padding-bottom:8px;">
          <h3 class="card-inner-h3">🌐 外部自动化 / Agent 准入控制与指南</h3>
          <span class="badge-recommend">{{ currentHubPort }} 统一中枢 · IPv4/IPv6 双栈</span>
        </div>

        <!-- 凭据: 外部 Agent API Key -->
        <div class="credential-box-card">
          <div class="credential-header-flex">
            <span style="font-size:12px; color:#38bdf8; font-weight:bold;">外部 Agent / 爬虫调用 Key (X-API-Key)</span>
            <div style="display:flex; gap:8px; align-items:center;">
              <button type="button" @click="copyText(profile.api_key, 'API Key')" class="btn-copy-tag">
                📋 复制 Key
              </button>
              <button @click="regenApiKey" class="link-probe" style="font-size:11px;">重新生成</button>
            </div>
          </div>

          <div class="api-key-interactive-box" @click="copyText(profile.api_key, 'API Key')" title="点击整行复制">
            <span class="font-cyan-mono token-truncate-text">{{ profile.api_key || '正在获取...' }}</span>
            <span class="copy-hint-icon">📋</span>
          </div>
          <p style="font-size:11px; color:#64748b; margin-top:5px;">
            外部程序（Playwright、Puppeteer、AI Agent）接管 CDP 或调用 HTTP 接口的全局唯一鉴权凭据。
          </p>
        </div>

        <!-- 零信任网络安全收敛通知栏 -->
        <div style="background:#09122a; border:1px solid #10b981; border-radius:6px; padding:10px 14px; margin-bottom:16px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:14px;">🔒</span>
            <span style="font-size:12px; font-weight:bold; color:#34d399;">零信任架构安全收敛生效中</span>
          </div>
          <p style="font-size:11px; color:#94a3b8; margin-top:4px; line-height:1.5;">
            已下线未鉴权公网裸端口映射。所有 SSH 隧道与本地端点锁死在 <code>127.0.0.1</code>；外部远程脚本统一通过 {{ currentHubPort }} 安全网关带 Key 访问，彻底杜绝外网扫描。系统完全支持 IPv4 / IPv6 双栈。
          </p>
        </div>

        <!-- 对外调用指南 Tab 切换 (3 大核心场景) -->
        <div>
          <div style="display:flex; gap:8px; margin-bottom:10px; border-bottom:1px solid #172554; padding-bottom:8px; flex-wrap:wrap;">
            <button 
              type="button" 
              @click="activeGuideTab = 'same_host'" 
              :class="activeGuideTab === 'same_host' ? 'guide-tab-active' : 'guide-tab-normal'"
            >
              💻 场景一：同机自动化接入 (动态池轮询)
            </button>
            <button 
              type="button" 
              @click="activeGuideTab = 'remote_host'" 
              :class="activeGuideTab === 'remote_host' ? 'guide-tab-active' : 'guide-tab-normal'"
            >
              🌐 场景二：异机/远程自动化 (全拓扑通杀)
            </button>
            <button 
              type="button" 
              @click="activeGuideTab = 'api'" 
              :class="activeGuideTab === 'api' ? 'guide-tab-active' : 'guide-tab-normal'"
            >
              ⚡ 场景三：RESTful 凭据操作
            </button>
            <button 
              type="button" 
              @click="activeGuideTab = 'openclaw'" 
              :class="activeGuideTab === 'openclaw' ? 'guide-tab-active' : 'guide-tab-normal'"
            >
              🤖 场景四：OpenClaw 直连与 Skill
            </button>
          </div>

          <!-- 场景 1: 同机自动化接入 -->
          <div v-if="activeGuideTab === 'same_host'" class="guide-content-box">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="color:#38bdf8; font-weight:bold;">💻 自动化脚本与 Hub 部署在同一台机器 / 宿主机：</span>
              <!-- 修复：调用独立方法，杜绝 HTML 引号截断 -->
              <button 
                type="button" 
                @click="copySameHostScript"
                class="btn-copy-tag"
                style="padding: 2px 6px; font-size: 10px;"
              >
                📋 复制代码
              </button>
            </div>
            <p style="font-size:11px; color:#94a3b8; line-height:1.5; margin:0 0 8px 0;">
              动态拉取全部在线节点，随机/轮询挑选控制，有效轮换出口特征，防止反爬人机验证。
            </p>

            <div class="code-viewport-container" :class="{ 'code-expanded': isCodeExpanded }">
              <pre class="code-snippet-box"><code># Python Playwright 同机动态调度示例 (防封号、防机器人验证)
import httpx, asyncio, random
from playwright.async_api import async_playwright

HUB_URL = "https://127.0.0.1:{{ currentHubPort }}"
API_KEY = "{{ profile.api_key }}"

async def run_same_host():
    # 1. 动态拉取当前所有健康在线的节点池
    async with httpx.AsyncClient(verify=False) as client:
        res = await client.get(
            f"{HUB_URL}/api/v1/nodes?online_only=true",
            headers={"X-API-Key": API_KEY}
        )
        online_nodes = res.json().get("nodes", [])

    if not online_nodes:
        print("当前集群暂无可用在线节点！")
        return

    # 2. 随机/轮询挑选一个节点 (分散指纹与出口特征，规避反爬检测)
    target = random.choice(online_nodes)
    endpoint = target["connection_views"]["same_host_automation"]["recommended_endpoint"]
    print(f"同机命中节点: [{target['name']}] (拓扑: {target['topology_desc']}) -> {endpoint}")

    # 3. 极速接管 CDP 自动化操控
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(endpoint)
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = await context.new_page()
        await page.goto("https://ipinfo.io")
        print("执行完成，页面标题:", await page.title())
        await browser.close()

asyncio.run(run_same_host())</code></pre>
              <div v-if="!isCodeExpanded" class="code-fade-overlay"></div>
            </div>

            <div class="code-fold-action-bar">
              <button type="button" @click="isCodeExpanded = !isCodeExpanded" class="btn-fold-toggle">
                {{ isCodeExpanded ? '▲ 收起代码' : '▼ 展开查看完整调度脚本' }}
              </button>
            </div>
          </div>

          <!-- 场景 2: 异机/远程自动化接入 -->
          <div v-if="activeGuideTab === 'remote_host'" class="guide-content-box">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="color:#34d399; font-weight:bold;">🌐 脚本部署在外部服务器 / 本地开发机 / CI 容器：</span>
              <!-- 修复：调用独立方法，杜绝 HTML 引号截断 -->
              <button 
                type="button" 
                @click="copyRemoteHostScript"
                class="btn-copy-tag"
                style="padding: 2px 6px; font-size: 10px;"
              >
                📋 复制代码
              </button>
            </div>
            <p style="font-size:11px; color:#94a3b8; line-height:1.5; margin:0 0 8px 0;">
              异机统一通过 Hub {{ currentHubPort }} TLS 鉴权网关穿透（全拓扑通杀），随机调度防止单一 IP 被风控封锁。
            </p>

            <div class="code-viewport-container" :class="{ 'code-expanded': isCodeExpanded }">
              <pre class="code-snippet-box"><code># Python Playwright 异机远程调用示例
import httpx, asyncio, random
from playwright.async_api import async_playwright

HUB_URL = "{{ currentHubUrl }}"
API_KEY = "{{ profile.api_key }}"

async def run_remote():
    # 1. 动态拉取全网在线节点池 (支持域名或 IPv6 地址)
    async with httpx.AsyncClient(verify=False) as client:
        res = await client.get(
            f"{HUB_URL}/api/v1/nodes?online_only=true",
            headers={"X-API-Key": API_KEY}
        )
        online_nodes = res.json().get("nodes", [])

    if not online_nodes:
        print("当前集群暂无可用在线节点！")
        return

    # 2. 随机/轮询选取目标节点 (多节点负载均衡，杜绝单 IP 触发反爬)
    target = random.choice(online_nodes)
    cdp_url = target["preferred_cdp_url"]  # TLS 统一网关端点
    print(f"异机分配节点: [{target['name']}] (拓扑: {target['topology_desc']})")

    # 3. 穿透接管 (无论节点在 NAT4 家宽内网还是公网云机)
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(cdp_url)
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = await context.new_page()
        await page.goto("https://ipinfo.io")
        print("异机执行完成:", await page.title())
        await browser.close()

asyncio.run(run_remote())</code></pre>
              <div v-if="!isCodeExpanded" class="code-fade-overlay"></div>
            </div>

            <div class="code-fold-action-bar">
              <button type="button" @click="isCodeExpanded = !isCodeExpanded" class="btn-fold-toggle">
                {{ isCodeExpanded ? '▲ 收起代码' : '▼ 展开查看完整调度脚本' }}
              </button>
            </div>
          </div>

          <!-- 场景 3: RESTful 凭据操作 -->
          <div v-if="activeGuideTab === 'api'" class="guide-content-box">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="color:#cbd5e1; font-weight:bold;">⚡ 轻量级 RESTful API 操作：</span>
              <!-- 修复：调用独立方法，杜绝 HTML 引号截断 -->
              <button 
                type="button" 
                @click="copyApiCurlScript"
                class="btn-copy-tag"
                style="padding: 2px 6px; font-size: 10px;"
              >
                📋 复制 API
              </button>
            </div>
            <p style="font-size:11px; color:#94a3b8; line-height:1.5; margin:0 0 8px 0;">
              无需挂载或启动本地浏览器内核，直接通过 HTTP 请求提取、注入 Cookie 或触发全网调度。
            </p>
            <div class="code-viewport-container code-natural-height">
              <pre class="code-snippet-box"><code># 1. 查询全网在线节点与连接视图 (含同机/异机端点，支持 IPv4/IPv6)
curl -k -H "X-API-Key: {{ profile.api_key }}" "{{ currentHubUrl }}/api/v1/nodes?online_only=true"

# 2. 导出指定节点的全部 CookieJar (JSON 格式)
curl -k -H "X-API-Key: {{ profile.api_key }}" "{{ currentHubUrl }}/api/v1/nodes/1/cookies"

# 3. 向指定节点注入 CookieJar (跨平台凭据投喂)
curl -k -X POST -H "X-API-Key: {{ profile.api_key }}" -H "Content-Type: application/json" \
  -d '{"cookies": [{"name": "session_id", "value": "xyz123", "domain": ".example.com", "path": "/"}]}' \
  "{{ currentHubUrl }}/api/v1/nodes/1/cookies"

# 4. Webhook 触发全网调度策略即时同步
curl -k -X POST -H "X-API-Key: {{ profile.api_key }}" "{{ currentHubUrl }}/api/v1/sync"</code></pre>
            </div>
          </div>

          <!-- 场景 4: OpenClaw 直连与 Skill 动态调度 -->
          <div v-if="activeGuideTab === 'openclaw'" class="guide-content-box">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="color:#a78bfa; font-weight:bold;">🤖 OpenClaw 远程浏览器直连 (/json/version + /json/list + /ws) & Skill：</span>
              <button 
                type="button" 
                @click="copyOpenclawScript"
                class="btn-copy-tag"
                style="padding: 2px 6px; font-size: 10px;"
              >
                📋 复制 OpenClaw 配置
              </button>
            </div>
            <p style="font-size:11px; color:#94a3b8; line-height:1.5; margin:0 0 8px 0;">
              单节点固定使用可直接写入 <code>openclaw.json</code> 的 <code>cdpUrl</code>；多节点随机/轮询与带 Cookie 任务请导入仓库 <code>chromium/openclaw-skill/chromium-cdp-hub</code> Skill。
            </p>
            <div class="code-viewport-container code-natural-height">
              <pre class="code-snippet-box"><code># 1) openclaw.json 直连示例 (支持 wss:// 或 https:// 自动探测 /json/version + /json/list)
"cdpUrl": "{{ currentHubUrl }}/cdp/1?api_key={{ profile.api_key }}"

# 2) OpenClaw Skill 无 Cookie 匿名采集 / 带 Cookie 采集命令
python3 ~/.openclaw/skills/chromium-cdp-hub/scripts/hub_pool.py crawl --url "https://example.com" --mode anon --strategy round-robin
python3 ~/.openclaw/skills/chromium-cdp-hub/scripts/hub_pool.py crawl --url "https://target.example.com" --mode cookie --cookie-source-node 1 --strategy random</code></pre>
            </div>
          </div>
        </div>
      </div>

    </div>

  </div>
</template>

<style scoped>
.layout-column-item {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0 !important;
  width: 100%;
}

.credential-box-card {
  background: #09122a;
  border: 1px solid #172554;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 14px;
  box-sizing: border-box;
}

.credential-header-flex {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.badge-recommend {
  background: rgba(14, 165, 233, 0.2);
  border: 1px solid #0284c7;
  color: #38bdf8;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
}

.btn-copy-tag {
  background: #1e293b;
  border: 1px solid #3b82f6;
  color: #38bdf8;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s ease;
}
.btn-copy-tag:hover {
  background: #0284c7;
  color: #ffffff;
}

.api-key-interactive-box {
  display: flex !important;
  justify-content: space-between !important;
  align-items: center !important;
  background: #060b17;
  border: 1px solid #172554;
  padding: 8px 12px;
  border-radius: 6px;
  margin-top: 8px;
  cursor: pointer;
  transition: all 0.2s;
  width: 100% !important;
  box-sizing: border-box !important;
  min-width: 0 !important;
}
.api-key-interactive-box:hover {
  border-color: #00f0ff;
  background: #08112b;
}

.token-truncate-text {
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
  flex: 1 !important;
  min-width: 0 !important;
  font-size: 12px !important;
  letter-spacing: 0.5px;
}

.copy-hint-icon {
  margin-left: 8px;
  flex-shrink: 0;
  font-size: 13px;
  opacity: 0.7;
}
.api-key-interactive-box:hover .copy-hint-icon {
  opacity: 1;
}

.guide-tab-normal {
  background: none;
  border: none;
  color: #94a3b8;
  font-size: 12px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.2s;
}
.guide-tab-normal:hover {
  color: #ffffff;
  background: #172554;
}

.guide-tab-active {
  background: #1e3a8a;
  border: 1px solid #3b82f6;
  color: #38bdf8;
  font-size: 12px;
  font-weight: bold;
  padding: 4px 10px;
  border-radius: 4px;
}

.guide-content-box {
  background: #060b17;
  border: 1px solid #172554;
  border-radius: 6px;
  padding: 12px;
  font-size: 12px;
}

/* ==================== 代码折叠与高度对齐容器 ==================== */
.code-viewport-container {
  position: relative;
  max-height: 195px; /* 与场景三基准高度严格对齐 */
  overflow: hidden;
  border-radius: 6px;
  border: 1px solid #1e3a8a;
  transition: max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-sizing: border-box;
}

.code-viewport-container.code-expanded {
  max-height: 600px;
  overflow-y: auto;
}

.code-viewport-container.code-natural-height {
  max-height: none;
  overflow: visible;
}

.code-snippet-box {
  background: #09122a;
  border: none;
  border-radius: 0;
  padding: 10px 12px;
  font-family: monospace;
  font-size: 11px;
  color: #e2e8f0;
  line-height: 1.5;
  margin: 0;
  overflow-x: auto;
}

/* 渐变遮罩虚化 */
.code-fade-overlay {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 65px;
  background: linear-gradient(to bottom, rgba(9, 18, 42, 0), #09122a 90%);
  pointer-events: none;
}

/* 折叠/展开控制栏 */
.code-fold-action-bar {
  display: flex;
  justify-content: center;
  align-items: center;
  padding-top: 6px;
}

.btn-fold-toggle {
  background: #0f1c3f;
  border: 1px solid #1e3a8a;
  color: #38bdf8;
  font-size: 11px;
  font-weight: 500;
  padding: 3px 12px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-fold-toggle:hover {
  background: #172554;
  border-color: #00f0ff;
  color: #ffffff;
}

.runtime-pill-redis {
  background: rgba(16, 185, 129, 0.16);
  border: 1px solid #059669;
  color: #34d399;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
}
.runtime-pill-sqlite {
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid #d97706;
  color: #fbbf24;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
}
.runtime-metrics-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.runtime-box {
  background: #060b17;
  border: 1px solid #172554;
  border-radius: 6px;
  padding: 10px 12px;
  min-width: 0;
}
.runtime-k {
  font-size: 11px;
  color: #94a3b8;
  margin-bottom: 4px;
}
.runtime-v {
  font-size: 14px;
  font-weight: 700;
}
.runtime-sub {
  font-size: 11px;
  color: #64748b;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.runtime-warn-box {
  margin-top: 10px;
  background: rgba(217, 119, 6, 0.12);
  border: 1px solid #d97706;
  color: #fbbf24;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11px;
  word-break: break-all;
}
</style>