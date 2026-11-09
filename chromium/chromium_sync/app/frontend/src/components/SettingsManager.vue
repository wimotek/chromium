<script setup>
import { ref, reactive, computed, onMounted } from 'vue'

const props = defineProps({
  api: Function,
  showToast: Function
})
const emit = defineEmits(['logout'])

// 1. 管理员账号模型
const profile = reactive({
  username: '',
  new_password: '',
  api_key: ''
})

// 2. 指南 Tab 状态 (精炼为 3 大纯实战场景)
const activeGuideTab = ref('same_host') // 'same_host' | 'remote_host' | 'api'

// 3. SSH 密钥资产状态 (已移至左列)
const keys = ref([])
const uploadRemark = ref('')

const currentHubHost = computed(() => {
  return window.location.host
})

const currentHubUrl = computed(() => {
  return `${window.location.protocol}//${window.location.host}`
})

const loadData = async () => {
  const [pRes, kRes] = await Promise.all([
    props.api('/api/profile'),
    props.api('/api/ssh-keys')
  ])
  Object.assign(profile, await pRes.json())
  keys.value = await kRes.json()
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
    
    <!-- ==================== 左列：管理员账号 + SSH 密钥存储库 (布局重构) ==================== -->
    <div class="layout-column-item">
      
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

      <!-- 卡片 2: SSH 密钥存储库 (从右侧迁至左侧，形成完美对称) -->
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

    <!-- ==================== 右列：外部 API 准入控制、安全网关指南 (聚焦自动化接入) ==================== -->
    <div class="layout-column-item">

      <!-- 卡片 3: 外部 Agent 开放 API 与安全控制中枢 -->
      <div class="content-full-card">
        <div class="table-header-bar" style="margin-bottom:10px; padding-bottom:8px;">
          <h3 class="card-inner-h3">🌐 外部自动化 / Agent 准入控制与指南</h3>
          <span class="badge-recommend">8443 统一中枢 · IPv4/IPv6 双栈</span>
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
            系统已下线公网未鉴权裸端口映射。所有 SSH 隧道与本地端点锁死在 <code>127.0.0.1</code>；外部远程脚本统一通过 8443 安全网关带 Key 访问，彻底杜绝外网扫描入侵。系统原生兼容 IPv4 与 IPv6。
          </p>
        </div>

        <!-- 对外调用指南 Tab 切换 (场景一、场景二、场景三) -->
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
          </div>

          <!-- 场景 1: 同机自动化接入 (动态节点池 + 随机轮询防风控) -->
          <div v-if="activeGuideTab === 'same_host'" class="guide-content-box">
            <p style="color:#38bdf8; font-weight:bold; margin-bottom:4px;">💻 自动化脚本与 Hub 部署在同一台机器 / 宿主机：</p>
            <div style="font-size:11px; color:#94a3b8; line-height:1.6; margin-bottom:8px;">
              • <b>动态节点池调度</b>：调用本地 API 动态获取全部在线节点，<b>随机/轮询选取节点操控</b>，有效轮换出口特征，防止机器人验证风控；<br>
              • <b>自适应端点</b>：程序自动识别 <code>same_host_automation.recommended_endpoint</code>，直连/SSH 节点走 127.0.0.1 回环裸口，WSS 节点走本地网关，免公网流量、零延迟！
            </div>
            <pre class="code-snippet-box"><code># Python Playwright 同机动态调度示例 (防封号、防机器人验证)
import httpx, asyncio, random
from playwright.async_api import async_playwright

HUB_URL = "https://127.0.0.1:8443"
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
          </div>

          <!-- 场景 2: 异机/远程自动化接入 (全拓扑归一化 + 随机轮询防风控) -->
          <div v-if="activeGuideTab === 'remote_host'" class="guide-content-box">
            <p style="color:#34d399; font-weight:bold; margin-bottom:4px;">🌐 自动化脚本部署在外部服务器 / 本地开发电脑 / CI 容器 (支持 IPv4 / IPv6)：</p>
            <div style="font-size:11px; color:#94a3b8; line-height:1.6; margin-bottom:8px;">
              • <b>全拓扑归一化</b>：异机统一通过 Hub 8443 TLS 鉴权网关穿透（内网穿透 / SSH / 直连 / 公网 WSS 代码完全一致）；<br>
              • <b>多节点轮询防封</b>：随机分发任务到不同在线节点，避免同一 IP 高频触发目标站点人机验证。
            </div>
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
    cdp_url = target["preferred_cdp_url"]  # 8443 TLS 统一网关端点
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
          </div>

          <!-- 场景 3: RESTful 凭据操作 -->
          <div v-if="activeGuideTab === 'api'" class="guide-content-box">
            <p style="color:#cbd5e1; font-weight:bold; margin-bottom:6px;">⚡ 轻量级 RESTful API（无需挂载浏览器内核，直接抓取/写入 Cookie）：</p>
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

.code-snippet-box {
  background: #09122a;
  border: 1px solid #1e3a8a;
  border-radius: 4px;
  padding: 10px;
  font-family: monospace;
  font-size: 11px;
  color: #e2e8f0;
  overflow-x: auto;
  line-height: 1.5;
  margin: 0;
}
</style>