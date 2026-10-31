<script setup>
import { ref, reactive, onMounted } from 'vue'

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
const keys = ref([])
const uploadRemark = ref('')

const loadData = async () => {
  const [pRes, kRes] = await Promise.all([
    props.api('/api/profile'),
    props.api('/api/ssh-keys')
  ])
  Object.assign(profile, await pRes.json())
  keys.value = await kRes.json()
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
  await props.api('/api/ssh-keys', { method: 'POST', body: fd })
  props.showToast(`证书 ${file.filename} 上传完成`, 'success')
  uploadRemark.value = ''
  loadData()
}

const updateRemark = async (k) => {
  const newRemark = prompt('请输入新备注：', k.remark)
  if (newRemark !== null) {
    await props.api(`/api/ssh-keys/${k.filename}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remark: newRemark })
    })
    props.showToast('备注已更新', 'success')
    loadData()
  }
}

const deleteKey = async (name) => {
  if (confirm(`确认销毁密钥 [${name}]？`)) {
    await props.api(`/api/ssh-keys/${name}`, { method: 'DELETE' })
    props.showToast('证书已销毁', 'success')
    loadData()
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="grid-2col-fluid">
    <!-- 管理员账号与 Agent API Key -->
    <div class="content-full-card">
      <h3 class="card-inner-h3" style="margin-bottom:16px;">👤 管理员账号与外部接入 API</h3>
      
      <div style="background:#09122a; border:1px solid #172554; border-radius:8px; padding:12px; margin-bottom:16px; width:70%; min-width:260px; max-width:520px;">
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
        <div>
          <button type="submit" class="btn-primary-gradient">保存账号修改</button>
        </div>
      </form>
    </div>

    <!-- SSH 密钥存储库 (支持备注与添加时间) -->
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