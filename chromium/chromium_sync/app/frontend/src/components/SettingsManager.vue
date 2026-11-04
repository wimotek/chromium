<script setup>
import { ref, reactive, onMounted } from 'vue'

const props = defineProps({
  api: Function,
  showToast: Function
})
const emit = defineEmits(['logout'])

// 1. 管理员账号与 API Key
const profile = reactive({
  username: '',
  new_password: '',
  api_key: ''
})

// 2. 远程连接开关与使用说明
const remoteAccess = reactive({
  direct_port_access_enabled: true
})
const activeGuideTab = ref('gateway') // 'gateway' | 'direct' | 'api'

// 3. 全局 Cookie 策略
const cookiePolicy = reactive({
  sync_diff_enabled: true,
  sync_include_domains: '',
  sync_exclude_domains: 'doubleclick.net,google-analytics.com'
})

// 4. SSH 密钥金库
const keys = ref([])
const uploadRemark = ref('')

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

// 核心功能：一键复制 API Key 到剪贴板
const copyApiKey = async () => {
  if (!profile.api_key) return
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(profile.api_key)
    } else {
      const ta = document.createElement('textarea')
      ta.value = profile.api_key
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    props.showToast('API Key 已复制到剪切板', 'success')
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
    
    <!-- 左列：管理员账号 + 全局 Cookie 策略 -->
    <div style="display:flex; flex-direction:column; gap:20px;">
      
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
          <div style="background:#09122a; border:1px solid #1e3a8a; border-radius:6px; padding:12px; width:100%; max-width:440px;">
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
            <input v-model="cookiePolicy.sync_include_domains" placeholder="例如: google.com, twitter.com, github.com (留空则同步全部)" class="cdp-input cdp-w-normal font-cyan-mono">
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

    <!-- 右列：远程连接控制中枢 (含 API Key 一键复制)、使用说明与密钥金库 -->
    <div style="display:flex; flex-direction:column; gap:20px;">

      <!-- 卡片 3: 远程 CDP 连接与外部 Agent 接入中枢 -->
      <div class="content-full-card">
        <div class="table-header-bar" style="margin-bottom:10px; padding-bottom:8px;">
          <h3 class="card-inner-h3">🌐 远程 CDP 连接与外部 Agent 接入中枢</h3>
          <span class="badge-recommend">支持双模式</span>
        </div>

        <!-- API Key 展示与一键复制区 -->
        <div style="background:#09122a; border:1px solid #172554; border-radius:8px; padding:12px; margin-bottom:14px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:12px; color:#38bdf8; font-weight:bold;">外部 Agent / 第三方程序调用 Key</span>
            
            <div style="display:flex; gap:10px; align-items:center;">
              <!-- 核心优化：一键复制独立按钮 -->
              <button type="button" @click="copyApiKey" class="btn-copy-tag" title="一键复制 API Key">
                📋 复制 Key
              </button>
              <button @click="regenApiKey" class="link-probe" style="font-size:11px;">重新生成</button>
            </div>
          </div>

          <!-- 可点击高亮复制框 -->
          <div class="api-key-interactive-box" @click="copyApiKey" title="点击整行亦可直接复制">
            <span class="font-cyan-mono" style="word-break:break-all; font-size:12px;">{{ profile.api_key || '正在获取...' }}</span>
            <span class="copy-hint-icon">📋</span>
          </div>
        </div>

        <!-- 远程连接开关 -->
        <div style="background:#09122a; border:1px solid #1e3a8a; border-radius:6px; padding:12px; margin-bottom:16px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <span style="font-size:13px; font-weight:bold; color:#ffffff;">公网端口直接映射访问 (19200-19250)</span>
              <p style="font-size:11px; color:#64748b; margin-top:3px;">
                开启后允许第三方程序通过公网直接访问裸端口；关闭时将仅允许安全 WSS 鉴权网关。
              </p>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <input type="checkbox" v-model="remoteAccess.direct_port_access_enabled" id="direct_port_toggle" class="check-box-blue" @change="saveRemoteAccess">
              <label for="direct_port_toggle" style="font-size:12px; color:#38bdf8; font-weight:bold; cursor:pointer;">
                {{ remoteAccess.direct_port_access_enabled ? '已开启直连' : '已关闭直连' }}
              </label>
            </div>
          </div>
        </div>

        <!-- 使用说明 Tab 切换 -->
        <div>
          <div style="display:flex; gap:8px; margin-bottom:10px; border-bottom:1px solid #172554; padding-bottom:8px;">
            <button 
              type="button" 
              @click="activeGuideTab = 'gateway'" 
              :class="activeGuideTab === 'gateway' ? 'guide-tab-active' : 'guide-tab-normal'"
            >
              方式一：API-Key 安全网关 (推荐)
            </button>
            <button 
              type="button" 
              @click="activeGuideTab = 'direct'" 
              :class="activeGuideTab === 'direct' ? 'guide-tab-active' : 'guide-tab-normal'"
            >
              方式二：公网端口直接映射
            </button>
            <button 
              type="button" 
              @click="activeGuideTab = 'api'" 
              :class="activeGuideTab === 'api' ? 'guide-tab-active' : 'guide-tab-normal'"
            >
              第三方程序节点列表 API
            </button>
          </div>

          <!-- 说明 1: WSS 安全网关 -->
          <div v-if="activeGuideTab === 'gateway'" class="guide-content-box">
            <p style="color:#38bdf8; font-weight:bold; margin-bottom:6px;">🌟 优势：仅需 8443 端口，TLS 全量加密，强制校验 API-Key，彻底防扫描。</p>
            <p style="color:#94a3b8; font-size:11px; margin-bottom:8px;">连接地址：<code>wss://&lt;你的域名&gt;:8443/cdp/{节点ID}/ws?api_key={{ profile.api_key }}</code></p>
            <pre class="code-snippet-box"><code># Python Playwright 示例
from playwright.async_api import async_playwright

async with async_playwright() as p:
    cdp_url = "wss://&lt;域名&gt;:8443/cdp/1/ws?api_key={{ profile.api_key }}"
    browser = await p.chromium.connect_over_cdp(cdp_url)
    page = await browser.new_page()
    await page.goto("https://ipinfo.io")
    print(await page.title())</code></pre>
          </div>

          <!-- 说明 2: 公网裸端口 -->
          <div v-if="activeGuideTab === 'direct'" class="guide-content-box">
            <p style="color:#fbbf24; font-weight:bold; margin-bottom:6px;">⚠️ 传统模式：需在云防火墙开放 19200-19250 端口，无鉴权机制。</p>
            <p style="color:#94a3b8; font-size:11px; margin-bottom:8px;">连接地址：<code>http://&lt;你的域名或IP&gt;:{本地穿透端口}</code> (如 19222)</p>
            <pre class="code-snippet-box"><code># Python Playwright 示例
from playwright.async_api import async_playwright

async with async_playwright() as p:
    browser = await p.chromium.connect_over_cdp("http://&lt;IP&gt;:19222")
    page = await browser.new_page()
    await page.goto("https://ipinfo.io")</code></pre>
          </div>

          <!-- 说明 3: 第三方对接 API -->
          <div v-if="activeGuideTab === 'api'" class="guide-content-box">
            <p style="color:#34d399; font-weight:bold; margin-bottom:6px;">⚡ 第三方程序或 Agent 一键获取全部节点的两种接入方式：</p>
            <pre class="code-snippet-box"><code># 1. 查询全部节点 (返回包含两种方式的完整地址)
curl -H "X-API-Key: {{ profile.api_key }}" https://&lt;域名&gt;:8443/api/v1/nodes

# 2. 一键抓取目标节点全量 Cookies
curl -H "X-API-Key: {{ profile.api_key }}" https://&lt;域名&gt;:8443/api/v1/nodes/1/cookies

# 3. 外部 Webhook 触发全网同步
curl -X POST -H "X-API-Key: {{ profile.api_key }}" https://&lt;域名&gt;:8443/api/v1/sync</code></pre>
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
                <td style="text-align:right; space-x:2;">
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
/* 一键复制专属按钮样式 */
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

/* 交互式 Key 容器 */
.api-key-interactive-box {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #060b17;
  border: 1px solid #172554;
  padding: 8px 10px;
  border-radius: 4px;
  margin-top: 8px;
  cursor: pointer;
  transition: all 0.2s;
}
.api-key-interactive-box:hover {
  border-color: #00f0ff;
  background: #08112b;
}

.copy-hint-icon {
  font-size: 12px;
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