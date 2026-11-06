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

const remoteAccess = reactive({
  direct_port_access_enabled: true
})

// 移除 edge tab，默认定位到 WSS 安全网关与外部 API
const activeGuideTab = ref('gateway') // 'gateway' | 'api'

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
  const [pRes, kRes, cRes, rRes] = await Promise.all([
    props.api('/api/profile'),
    props.api('/api/ssh-keys'),
    props.api('/api/cookie-policy'),
    props.api('/api/remote-access')
  ])
  Object.assign(profile, await pRes.json())
  keys.value = await kRes.json()
  Object.assign(cookiePolicy, await cRes.json())
  Object.assign(remoteAccess, await rRes.json())
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

const saveRemoteAccess = async () => {
  const res = await props.api('/api/remote-access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(remoteAccess)
  })
  if (res.ok) {
    props.showToast('远程连接策略已更新', 'success')
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
    props.showToast(`证书 ${file.filename} 上传完成`, 'success')
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
          <h3 class="card-inner-h3">🌐 外部 Agent 开放 API 与安全控制</h3>
          <span class="badge-recommend">8443 统一鉴权</span>
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
            外部程序（Playwright、Puppeteer、AI Agent 或第三方系统）通过 WSS 反向网关操作 CDP 时的强制校验凭据。
          </p>
        </div>

        <!-- 远程连接公网裸端口开关 -->
        <div style="background:#09122a; border:1px solid #1e3a8a; border-radius:6px; padding:12px; margin-bottom:16px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <span style="font-size:13px; font-weight:bold; color:#ffffff;">公网裸端口直接映射访问 (19200-19250)</span>
              <p style="font-size:11px; color:#64748b; margin-top:3px;">
                开启后允许第三方程序绕过鉴权直接访问宿主机裸端口；关闭时将强制收敛于 8443 安全网关。
              </p>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <input type="checkbox" v-model="remoteAccess.direct_port_access_enabled" id="direct_port_toggle" class="check-box-blue" @change="saveRemoteAccess">
              <label for="direct_port_toggle" style="font-size:12px; color:#38bdf8; font-weight:bold; cursor:pointer;">
                {{ remoteAccess.direct_port_access_enabled ? '已开启' : '已关闭' }}
              </label>
            </div>
          </div>
        </div>

        <!-- 对外调用指南 Tab 切换 (仅保留 2 个核心外部对接方式) -->
        <div>
          <div style="display:flex; gap:8px; margin-bottom:10px; border-bottom:1px solid #172554; padding-bottom:8px;">
            <button 
              type="button" 
              @click="activeGuideTab = 'gateway'" 
              :class="activeGuideTab === 'gateway' ? 'guide-tab-active' : 'guide-tab-normal'"
            >
              🔒 方式一：安全 WSS 鉴权网关 (8443 推荐)
            </button>
            <button 
              type="button" 
              @click="activeGuideTab = 'api'" 
              :class="activeGuideTab === 'api' ? 'guide-tab-active' : 'guide-tab-normal'"
            >
              ⚡ 方式二：第三方自动化 API
            </button>
          </div>

          <!-- 说明 1: WSS 安全网关 -->
          <div v-if="activeGuideTab === 'gateway'" class="guide-content-box">
            <p style="color:#38bdf8; font-weight:bold; margin-bottom:6px;">🌟 核心优势：仅暴露 8443 单端口，全量 TLS 加密，强制 API-Key 鉴权，支持穿透控制 NAT4 内网节点。</p>
            <p style="color:#94a3b8; font-size:11px; margin-bottom:8px;">
              统一连接端点：<code>wss://{{ currentHubHost }}/cdp/{节点ID}/ws?api_key={{ profile.api_key }}</code>
            </p>
            <pre class="code-snippet-box"><code># Python Playwright 示例 (无视目标节点是否在内网/NAT4，秒级操控)
from playwright.async_api import async_playwright

async with async_playwright() as p:
    cdp_url = "wss://{{ currentHubHost }}/cdp/1/ws?api_key={{ profile.api_key }}"
    browser = await p.chromium.connect_over_cdp(cdp_url)
    page = await browser.new_page()
    await page.goto("https://ipinfo.io")
    print("页面标题:", await page.title())
    await browser.close()</code></pre>
          </div>

          <!-- 说明 2: 第三方对接 API -->
          <div v-if="activeGuideTab === 'api'" class="guide-content-box">
            <p style="color:#34d399; font-weight:bold; margin-bottom:6px;">⚡ 第三方程序或 Agent 自动化调度与数据提取接口：</p>
            <pre class="code-snippet-box"><code># 1. 查询全网所有在线节点与双连接地址
curl -H "X-API-Key: {{ profile.api_key }}" {{ currentHubUrl }}/api/v1/nodes

# 2. 一键抓取目标节点全量 Cookies JSON
curl -H "X-API-Key: {{ profile.api_key }}" {{ currentHubUrl }}/api/v1/nodes/1/cookies

# 3. 外部 Webhook 触发全网调度策略同步
curl -X POST -H "X-API-Key: {{ profile.api_key }}" {{ currentHubUrl }}/api/v1/sync</code></pre>
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