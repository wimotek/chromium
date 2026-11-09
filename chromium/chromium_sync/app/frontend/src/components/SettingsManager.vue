<script setup>
import { ref, reactive, computed, onMounted } from 'vue'

const props = defineProps({
  api: Function,
  showToast: Function
})
const emit = defineEmits(['logout'])

const profile = reactive({
  username: '',
  new_password: '',
  api_key: ''
})

// 指南 Tab：same_host | remote_host | architecture | api
const activeGuideTab = ref('same_host')

const cookiePolicy = reactive({
  sync_diff_enabled: true,
  sync_include_domains: '',
  sync_exclude_domains: 'doubleclick.net,google-analytics.com'
})

const keys = ref([])
const uploadRemark = ref('')

const currentHubHost = computed(() => {
  return window.location.host
})

const currentHubUrl = computed(() => {
  return `${window.location.protocol}//${window.location.host}`
})

const loadData = async () => {
  const [pRes, kRes, cRes] = await Promise.all([
    props.api('/api/profile'),
    props.api('/api/ssh-keys'),
    props.api('/api/cookie-policy')
  ])
  Object.assign(profile, await pRes.json())
  keys.value = await kRes.json()
  Object.assign(cookiePolicy, await cRes.json())
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

const saveCookiePolicy = async () => {
  const res = await props.api('/api/cookie-policy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cookiePolicy)
  })
  if (res.ok) {
    props.showToast('全局 Cookie 策略已保存生效', 'success')
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
    
    <!-- ==================== 左列：管理员账号 + 全局 Cookie 策略 ==================== -->
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

      <!-- 卡片 2: 全局 Cookie 过滤与差量同步策略 -->
      <div class="content-full-card">
        <h3 class="card-inner-h3" style="margin-bottom:6px;">🛡️ 全局 Cookie 过滤与差量同步策略</h3>
        <p style="font-size:11px; color:#64748b; margin-bottom:14px;">全局通用生效，作用于所有后台定时调度、即时同步及 API 提取流程。</p>
        
        <form @submit.prevent="saveCookiePolicy" class="form-v-stack">
          <div style="background:#09122a; border:1px solid #1e3a8a; border-radius:6px; padding:12px; width:100%; box-sizing:border-box;">
            <div style="display:flex; align-items:center; gap:8px;">
              <input type="checkbox" v-model="cookiePolicy.sync_diff_enabled" id="diff_toggle" class="check-box-blue">
              <label for="diff_toggle" style="font-size:12px; color:#38bdf8; font-weight:bold; cursor:pointer;">
                启用 Cookie 指纹变更差量检测 (Diff / Delta Sync)
              </label>
            </div>
            <p style="font-size:11px; color:#64748b; margin-top:5px; line-height:1.5;">
              仅对值、有效期发生实质变更的凭证执行下发，跳过完全一致项，避免全量频繁刷盘。
            </p>
          </div>

          <div class="form-field-block">
            <label class="form-label">域名白名单 (Include Domains，选填)</label>
            <input v-model="cookiePolicy.sync_include_domains" placeholder="例如: google.com, twitter.com (留空则同步全部)" class="cdp-input cdp-w-normal font-cyan-mono">
            <p class="form-field-hint">仅同步匹配这些域名的 Cookie，多个域名用英文逗号分隔；留空表示不过滤。</p>
          </div>

          <div class="form-field-block">
            <label class="form-label">域名黑名单 (Exclude Domains，选填)</label>
            <input v-model="cookiePolicy.sync_exclude_domains" placeholder="例如: doubleclick.net, google-analytics.com" class="cdp-input cdp-w-normal font-cyan-mono">
            <p class="form-field-hint">全局自动剔除广告、数据统计类垃圾凭据，防止污染目标浏览器。</p>
          </div>

          <div style="margin-top:4px;">
            <button type="submit" class="btn-primary-gradient">保存全局策略</button>
          </div>
        </form>
      </div>

    </div>

    <!-- ==================== 右列：外部 API 准入控制、安全网关指南与密钥库 ==================== -->
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

        <!-- 零信任网络安全收敛通知栏 (替代原有的危险裸端口开关) -->
        <div style="background:#09122a; border:1px solid #10b981; border-radius:6px; padding:10px 14px; margin-bottom:16px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:14px;">🔒</span>
            <span style="font-size:12px; font-weight:bold; color:#34d399;">零信任架构安全收敛生效中</span>
          </div>
          <p style="font-size:11px; color:#94a3b8; margin-top:4px; line-height:1.5;">
            已全网下线公网未鉴权裸端口映射。SSH 隧道与本地端点已强制锁死在 <code>127.0.0.1</code>；外部远程脚本统一通过 8443 安全网关带 Key 访问，彻底杜绝公网扫描入侵。系统完全支持 IPv4 / IPv6 双栈访问。
          </p>
        </div>

        <!-- 对外调用指南 Tab 切换 (4 大核心场景) -->
        <div>
          <div style="display:flex; gap:8px; margin-bottom:10px; border-bottom:1px solid #172554; padding-bottom:8px; flex-wrap:wrap;">
            <button 
              type="button" 
              @click="activeGuideTab = 'same_host'" 
              :class="activeGuideTab === 'same_host' ? 'guide-tab-active' : 'guide-tab-normal'"
            >
              💻 场景一：同机自动化接入
            </button>
            <button 
              type="button" 
              @click="activeGuideTab = 'remote_host'" 
              :class="activeGuideTab === 'remote_host' ? 'guide-tab-active' : 'guide-tab-normal'"
            >
              🌐 场景二：异机/远程自动化
            </button>
            <button 
              type="button" 
              @click="activeGuideTab = 'architecture'" 
              :class="activeGuideTab === 'architecture' ? 'guide-tab-active' : 'guide-tab-normal'"
            >
              📐 架构解析：四拓扑与 IPv6
            </button>
            <button 
              type="button" 
              @click="activeGuideTab = 'api'" 
              :class="activeGuideTab === 'api' ? 'guide-tab-active' : 'guide-tab-normal'"
            >
              ⚡ 场景四：RESTful 凭据操作
            </button>
          </div>

          <!-- 场景 1: 同机自动化接入 -->
          <div v-if="activeGuideTab === 'same_host'" class="guide-content-box">
            <p style="color:#38bdf8; font-weight:bold; margin-bottom:4px;">💻 自动化脚本与 Hub 部署在同一台机器 / 宿主机：</p>
            <div style="font-size:11px; color:#94a3b8; line-height:1.6; margin-bottom:8px;">
              • <b>本地直连 & SSH 穿透节点</b>：直接连接本地回环 <code>http://127.0.0.1:端口</code>（免公网带宽、零网络延迟）；<br>
              • <b>WSS 反穿 & WSS 直连节点</b>：通过本地回环安全网关 <code>wss://127.0.0.1:8443/cdp/{ID}/ws?api_key={{ profile.api_key }}</code>，Hub 内存直接中继转发，毫秒级打通！
            </div>
            <pre class="code-snippet-box"><code># Python Playwright 同机调用示例
import asyncio
from playwright.async_api import async_playwright

API_KEY = "{{ profile.api_key }}"

async def run_local():
    async with async_playwright() as p:
        # 分支 A: 若控制 SSH 或本地直连节点 (例如本地绑定的 19222 端口，走零延迟裸连)
        # browser = await p.chromium.connect_over_cdp("http://127.0.0.1:19222")

        # 分支 B: 若控制 NAT4 反向长连 / WSS 直连节点 (走本地回环 8443 网关)
        cdp_url = f"wss://127.0.0.1:8443/cdp/1/ws?api_key={API_KEY}"
        browser = await p.chromium.connect_over_cdp(cdp_url)

        page = await browser.new_page()
        await page.goto("https://www.baidu.com")
        print("同机执行成功:", await page.title())
        await browser.close()

asyncio.run(run_local())</code></pre>
          </div>

          <!-- 场景 2: 异机/远程自动化接入 -->
          <div v-if="activeGuideTab === 'remote_host'" class="guide-content-box">
            <p style="color:#34d399; font-weight:bold; margin-bottom:4px;">🌐 自动化脚本部署在外部服务器 / 本地开发电脑 / CI 容器 (支持 IPv4 / IPv6)：</p>
            <div style="font-size:11px; color:#94a3b8; line-height:1.6; margin-bottom:8px;">
              • <b>全拓扑归一化标准</b>：异机统一连接 Hub 的 8443 统一网关，无论目标节点处于 NAT4 内网还是 SSH 穿透，<b>调用代码完全一致</b>！<br>
              • <b>动态节点池调度</b>：调用 <code>/api/v1/nodes?online_only=true</code> 实时获取可用节点并按 <code>preferred_cdp_url</code> 直接接管。
            </div>
            <pre class="code-snippet-box"><code>import httpx, asyncio
from playwright.async_api import async_playwright

HUB_URL = "{{ currentHubUrl }}"
API_KEY = "{{ profile.api_key }}"

async def run_remote():
    # 1. 动态获取全网当前处于 connected 的在线节点池 (支持 IPv4 与 IPv6 域名)
    async with httpx.AsyncClient(verify=False) as client:
        res = await client.get(f"{HUB_URL}/api/v1/nodes?online_only=true", headers={"X-API-Key": API_KEY})
        online_nodes = res.json().get("nodes", [])

    if not online_nodes:
        print("当前集群没有在线的可用 Chromium 节点！")
        return

    # 2. 任意选取一个在线节点 (包含 NAT4 反穿 / SSH / 公网 WSS / 直连)
    target = online_nodes[0]
    print(f"分配到在线节点: [{target['name']}] 拓扑模式: {target['topology_desc']}")

    # 3. 异机统一使用 preferred_cdp_url 接管 (8443 TLS 鉴权网关)
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(target["preferred_cdp_url"])
        page = await browser.new_page()
        await page.goto("https://ipinfo.io")
        print("异机执行完成:", await page.title())
        await browser.close()

asyncio.run(run_remote())</code></pre>
          </div>

          <!-- 场景 3: 架构解析：四拓扑与 IPv6 双栈 -->
          <div v-if="activeGuideTab === 'architecture'" class="guide-content-box">
            <p style="color:#a78bfa; font-weight:bold; margin-bottom:6px;">📐 架构解析：零信任安全收敛与 IPv6 规范</p>
            <div style="font-size:11px; color:#cbd5e1; line-height:1.6; margin-bottom:10px;">
              • <b>为什么移除公网裸端口？</b> 原有的 19200-19250 裸端口绕过了 API-Key 校验，易被扫描接管。现在所有异机通信强制走 8443 网关；同机通信走 <code>127.0.0.1</code> 本地回环，彻底杜绝外网扫描。<br>
              • <b>IPv6 规范支持</b>：系统完全遵循 RFC 2732 规范。若 Hub 运行在 IPv6 节点，连接端点自动格式化为 <code>wss://[2408:xxxx::1]:8443/...</code>，避免冒号引起的解析割裂。
            </div>

            <p style="color:#38bdf8; font-weight:bold; margin-bottom:6px;">四种网络拓扑连接支持矩阵：</p>
            <div style="display:flex; flex-direction:column; gap:6px; font-size:11px; color:#cbd5e1;">
              <div style="background:#09122a; padding:6px 10px; border-radius:4px; border-left:3px solid #8b5cf6;">
                <b style="color:#c4b5fd;">1. NAT4 反向长连</b>：同机走 <code>wss://127.0.0.1:8443/...</code>；异机走 <code>wss://hub:8443/...</code>。<b>绝对无裸端口</b>。
              </div>
              <div style="background:#09122a; padding:6px 10px; border-radius:4px; border-left:3px solid #38bdf8;">
                <b style="color:#38bdf8;">2. 公网 WSS 直连</b>：同机走 <code>wss://127.0.0.1:8443/...</code>；异机首选 8443 网关以防扫描。
              </div>
              <div style="background:#09122a; padding:6px 10px; border-radius:4px; border-left:3px solid #4f46e5;">
                <b style="color:#a5b4fc;">3. SSH 端口映射</b>：同机直连 <code>127.0.0.1:19222+</code>；异机统一走 8443 网关中继。
              </div>
              <div style="background:#09122a; padding:6px 10px; border-radius:4px; border-left:3px solid #10b981;">
                <b style="color:#34d399;">4. 本地/局域网直连</b>：同机直连 <code>127.0.0.1:9222</code> 或免密 <code>9223</code>；异机统一走 8443 网关。
              </div>
            </div>
          </div>

          <!-- 场景 4: RESTful 凭据操作 -->
          <div v-if="activeGuideTab === 'api'" class="guide-content-box">
            <p style="color:#cbd5e1; font-weight:bold; margin-bottom:6px;">⚡ 轻量级 RESTful API（无需挂载浏览器内核，直接抓取/写入 Cookie）：</p>
            <pre class="code-snippet-box"><code># 1. 查询全网所有在线节点与连接拓扑 (含同机/异机连接地址，支持 IPv4/IPv6)
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

      <!-- 卡片 4: SSH 密钥存储库 -->
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