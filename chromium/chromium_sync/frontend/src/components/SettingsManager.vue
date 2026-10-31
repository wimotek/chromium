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

// 2. 全局 Cookie 过滤与差量策略 (全局通用设置)
const cookiePolicy = reactive({
  sync_diff_enabled: true,
  sync_include_domains: '',
  sync_exclude_domains: 'doubleclick.net,google-analytics.com'
})

// 3. 密钥库
const keys = ref([])
const uploadRemark = ref('')

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
    props.showToast('全局 Cookie 过滤与差量策略已保存生效', 'success')
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
    
    <!-- 左列：管理员账号 + 全局 Cookie 过滤与差量策略 -->
    <div style="display:flex; flex-direction:column; gap:20px;">
      
      <!-- 卡片 1: 管理员账号与 Agent API Key -->
      <div class="content-full-card">
        <h3 class="card-inner-h3" style="margin-bottom:16px;">👤 管理员账号与外部接入 API</h3>
        
        <div style="background:#09122a; border:1px solid #172554; border-radius:8px; padding:12px; margin-bottom:16px; width:100%; max-width:440px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:12px; color:#38bdf8; font-weight:bold;">外部 Agent / 爬虫调用 Key</span>
            <button @click="regenApiKey" class="link-probe" style="font-size:11px;">重新生成</button>
          </div>
          <div style="font-family:monospace; font-size:12px; color:#f8fafc; margin-top:6px; word-break:break-all; background:#060b17; padding:6px; border-radius:4px;">
            {{ profile.api_key }}
          </div>
          <div style="font-size:11px; color:#64748b; margin-top:6px;">
            调用示例：<code>curl -H "X-API-Key: {{ profile.api_key }}" https://&lt;IP&gt;:8443/api/v1/nodes</code>
          </div>
        </div>

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

      <!-- 卡片 2: 🛡️ 全局 Cookie 过滤与差量同步策略 (全站通用设置) -->
      <div class="content-full-card">
        <h3 class="card-inner-h3" style="margin-bottom:6px;">🛡️ 全局 Cookie 过滤与差量同步策略</h3>
        <p style="font-size:11px; color:#64748b; margin-bottom:14px;">全局通用生效，作用于所有后台自动化调度、即时同步及外部 API 抓取流程。</p>
        
        <form @submit.prevent="saveCookiePolicy" class="form-v-stack">
          <!-- 差量同步检测开关 -->
          <div style="background:#09122a; border:1px solid #1e3a8a; border-radius:6px; padding:12px; width:100%; max-width:440px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <input type="checkbox" v-model="cookiePolicy.sync_diff_enabled" id="diff_toggle" class="check-box-blue">
              <label for="diff_toggle" style="font-size:12px; color:#38bdf8; font-weight:bold; cursor:pointer;">
                启用 Cookie 指纹变更差量检测 (Diff / Delta Sync)
              </label>
            </div>
            <p style="font-size:11px; color:#64748b; margin-top:5px; line-height:1.5;">
              仅对值、有效期发生实质变更的凭证执行下发，跳过完全一致项，避免全量频繁刷盘，大幅降低浏览器存储 IO 损耗。
            </p>
          </div>

          <!-- 域名白名单 -->
          <div class="form-field-block">
            <label class="form-label">域名白名单 (Include Domains，选填)</label>
            <input v-model="cookiePolicy.sync_include_domains" placeholder="例如: google.com, twitter.com, github.com (留空则同步全部)" class="cdp-input cdp-w-normal font-cyan-mono">
            <p class="form-field-hint">仅同步匹配这些域名的 Cookie，多个域名用英文逗号分隔；留空表示不过滤。</p>
          </div>

          <!-- 域名黑名单 -->
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

    <!-- 右列：SSH 密钥存储库 -->
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
</template>