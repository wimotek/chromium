<template>
  <div class="cyber-card tab-content-card">
    <div class="sub-tab-nav">
      <button class="sub-tab-btn" :class="{ active: cardSubTab === 'inventory' }" @click="cardSubTab = 'inventory'">
        📦 卡密制卡与库存管理
      </button>
      <button class="sub-tab-btn" :class="{ active: cardSubTab === 'api' }" @click="cardSubTab = 'api'">
        🔌 API自动发卡
      </button>
    </div>

    <!-- 子卡 A: 批量制卡与库存 -->
    <div v-if="cardSubTab === 'inventory'" class="sub-tab-pane">
      <div class="card-header"><h3>🛠️ 批量生成卡密</h3></div>
      <div class="gen-form">
        <div>
          <label>流量配额 (GB, 0为不限)</label>
          <input v-model.number="cardGenForm.traffic_gb" type="number" class="cyber-input modal-input" placeholder="0=不限" />
        </div>
        <div>
          <label>有效时限 (天, 36500为永久)</label>
          <input v-model.number="cardGenForm.days" type="number" class="cyber-input modal-input" placeholder="36500=永久" />
        </div>
        <div>
          <label>批量制卡数 (张)</label>
          <input v-model.number="cardGenForm.count" type="number" class="cyber-input modal-input" />
        </div>
        <div style="display: flex; flex-direction: column; justify-content: flex-end;">
          <label class="radio-label" style="margin-bottom: 8px;">
            <input type="checkbox" v-model="cardGenForm.is_monthly" /> 设为每月固定重置卡
          </label>
          <button class="btn-cyber-success" :disabled="loading" @click="generateCards">立即批量制卡</button>
        </div>
      </div>

      <div class="card-header" style="margin-top: 30px;">
        <h3>📦 历史卡密库存与核销流水 (最新200条)</h3>
        <button class="btn-cyber-refresh" @click="$emit('reload-all')">🔄 刷新列表</button>
      </div>

      <!-- 工具栏：默认最近30天、多维度导出与3项删除 -->
      <div class="export-toolbar">
        <div class="date-filter-group">
          <span class="filter-label">📅 筛选日期 (默认近1月):</span>
          <input v-model="exportFilter.startDate" type="date" class="cyber-input date-input" />
          <span style="color: #64748b;">至</span>
          <input v-model="exportFilter.endDate" type="date" class="cyber-input date-input" />
          <button class="btn-sm btn-action" @click="exportByDateRange">按范围导出</button>
        </div>

        <div class="export-actions-group">
          <button class="btn-sm btn-export-select" :disabled="selectedCards.length === 0" @click="exportSelectedCards">
            ☑️ 导出已选 ({{ selectedCards.length }})
          </button>
          <button class="btn-sm btn-cyber-success" @click="exportAllUnusedCards">
            📋 导出全部未售
          </button>
        </div>

        <div class="delete-actions-group">
          <button class="btn-sm btn-cyber-danger" @click="handleDeleteCardsByDate">
            🗑️ 清理范围未售
          </button>
          <button class="btn-sm btn-del" :disabled="selectedCards.length === 0" @click="handleDeleteSelectedCards">
            🗑️ 删除已勾选 ({{ selectedCards.length }})
          </button>
          <button class="btn-sm btn-reset" @click="handleDeleteInvalidCards">
            🧹 清空已核销无效卡
          </button>
        </div>
      </div>

      <div class="table-container">
        <table class="cyber-table">
          <thead>
            <tr>
              <th style="width: 40px; text-align: center;"><input type="checkbox" :checked="isAllSelected" @change="toggleSelectAll" title="全选" /></th>
              <th>卡密编号</th>
              <th>套餐配额</th>
              <th>套餐属性</th>
              <th>核销状态</th>
              <th>生成时间</th>
              <th>使用时间</th>
              <th>兑换用户</th>
              <th>单张操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in adminCards" :key="c.code">
              <td style="text-align: center;"><input type="checkbox" :value="c.code" v-model="selectedCards" /></td>
              <td class="font-mono text-cyan">{{ c.code }}</td>
              <td style="white-space: nowrap;">{{ c.traffic_gb === 0 ? '♾️ 不限' : c.traffic_gb + ' GB' }} / {{ c.days >= 3650 ? '永久' : c.days + ' 天' }}</td>
              <td>
                <span v-if="c.is_monthly === 1" class="badge badge-monthly">每月重置</span>
                <span v-else class="text-muted" style="font-size: 11px;">普通固定</span>
              </td>
              <td><span class="badge" :class="c.is_used ? 'badge-used' : 'badge-ready'">{{ c.is_used ? '已核销' : '待售/有效' }}</span></td>
              <td class="text-muted" style="white-space: nowrap;">{{ c.created_at || '早期' }}</td>
              <td style="white-space: nowrap; font-size: 11px; color: #38bdf8;">{{ c.used_at || '-' }}</td>
              <td>{{ c.used_by || '-' }}</td>
              <td><button class="btn-sm btn-action" @click="$emit('copy', c.code)">复制</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 子卡 B: API 自动发卡 -->
    <div v-else-if="cardSubTab === 'api'" class="sub-tab-pane">
      <div class="panel-card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid #1e293b; padding-bottom: 10px;">
          <h4 style="margin: 0; font-size: 16px; color: #38bdf8;">🔌 API自动发卡</h4>
          <label class="radio-label" style="font-weight: 600;">
            <input type="checkbox" v-model="fakaEnable" @change="saveFakaSettings" />
            <span :style="{ color: fakaEnable ? '#10b981' : '#ef4444' }">
              {{ fakaEnable ? '🟢 接口运行中' : '🔴 接口已停用' }}
            </span>
          </label>
        </div>

        <div class="form-item">
          <label>API 通信验证 TOKEN (密钥)：</label>
          <div style="display: flex; gap: 8px;">
            <input v-model="fakaToken" type="text" class="cyber-input font-mono" placeholder="自定义出卡令牌" />
            <button class="btn-sm btn-action" @click="generateRandomToken">🎲 随机</button>
            <button class="btn-sm btn-cyber-success" @click="saveFakaSettings">保存</button>
          </div>
        </div>

        <div class="node-field" style="margin-top: 18px;">
          <label>独角数卡发卡调用 URL (GET / POST)：</label>
          <div class="code-display text-cyan">{{ fakaApiUrlSample }}</div>
        </div>

        <button class="btn-cyber-action" style="margin-top: 10px;" @click="$emit('copy', fakaApiUrlSample)">复制 API 完整调用地址</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import axios from 'axios'
import { ElMessage } from 'element-plus'

const props = defineProps({
  adminCards: { type: Array, default: () => [] },
  currentUser: { type: Object, required: true },
  adminPassword: { type: String, required: true }
})

const emit = defineEmits(['copy', 'reload-all'])

const loading = ref(false)
const cardSubTab = ref('inventory')
const cardGenForm = reactive({ traffic_gb: 50, days: 30, count: 5, is_monthly: false })

const fakaEnable = ref(true)
const fakaToken = ref('faka_secret_token_8899')

// 默认近 30 天日期范围
const getDefaultDateRange = () => {
  const now = new Date()
  const end = now.toISOString().split('T')[0]
  const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const start = past.toISOString().split('T')[0]
  return { start, end }
}
const initRange = getDefaultDateRange()

const selectedCards = ref([])
const exportFilter = reactive({ startDate: initRange.start, endDate: initRange.end })

onMounted(async () => {
  try {
    const res = await axios.get(`/api/admin/settings?admin_user=${encodeURIComponent(props.currentUser.username)}&admin_pwd=${encodeURIComponent(props.adminPassword)}`)
    if (res.data.code === 200) {
      fakaEnable.value = res.data.data.faka_api_enable === 'true'
      fakaToken.value = res.data.data.faka_api_token || 'faka_secret_token_8899'
    }
  } catch (_) {}
})

const fakaApiUrlSample = computed(() => {
  const host = window.location.origin
  return `${host}/api/open/faka_generate?gb=100&days=30&is_monthly=1&token=${fakaToken.value}`
})

const isAllSelected = computed(() => {
  const unusedList = props.adminCards.filter(c => !c.is_used)
  if (unusedList.length === 0) return false
  return unusedList.every(c => selectedCards.value.includes(c.code))
})

const toggleSelectAll = (e) => {
  if (e.target.checked) {
    selectedCards.value = props.adminCards.filter(c => !c.is_used).map(c => c.code)
  } else {
    selectedCards.value = []
  }
}

const generateRandomToken = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let token = 'FAKA_'
  for (let i = 0; i < 20; i++) token += chars.charAt(Math.floor(Math.random() * chars.length))
  fakaToken.value = token
  ElMessage.success('已随机生成新出卡 Token')
}

const saveFakaSettings = async () => {
  try {
    const res = await axios.post('/api/admin/settings', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      faka_api_enable: fakaEnable.value ? 'true' : 'false',
      faka_api_token: fakaToken.value
    })
    if (res.data.code === 200) {
      ElMessage.success('发卡 API 配置已保存')
    }
  } catch (_) {
    ElMessage.error('保存失败')
  }
}

const generateCards = async () => {
  loading.value = true
  try {
    const res = await axios.post('/api/admin/cards/generate', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      ...cardGenForm
    })
    if (res.data.code === 200) {
      ElMessage.success('卡密批量生成成功')
      emit('reload-all')
    }
  } finally {
    loading.value = false
  }
}

const executeExport = async (payload, successTip) => {
  try {
    const res = await axios.post('/api/admin/cards/export_unused', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      ...payload
    })
    if (res.data.code === 200) {
      if (res.data.count === 0) return ElMessage.warning('暂无可导出的未核销卡密')
      emit('copy', res.data.text)
      ElMessage.success(`${successTip}（共 ${res.data.count} 张）`)
    }
  } catch (_) {
    ElMessage.error('导出失败')
  }
}

const exportSelectedCards = () => {
  if (selectedCards.value.length === 0) return ElMessage.warning('请先勾选要导出的卡密')
  executeExport({ selected_codes: selectedCards.value }, '已复制选中的卡密')
}

const exportByDateRange = () => {
  if (!exportFilter.startDate && !exportFilter.endDate) return ElMessage.warning('请先选择日期范围')
  executeExport({ start_date: exportFilter.startDate, end_date: exportFilter.endDate }, '已导出指定日期范围内的未售卡密')
}

const exportAllUnusedCards = () => executeExport({}, '已复制全部未售卡密')

const handleDeleteSelectedCards = async () => {
  if (selectedCards.value.length === 0) return ElMessage.warning('请先在表格左侧勾选要删除的卡密')
  if (!confirm(`⚠️ 确定要彻底删除已勾选的 ${selectedCards.value.length} 张卡密吗？`)) return
  try {
    const res = await axios.post('/api/admin/cards/delete', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      mode: 'selected',
      selected_codes: selectedCards.value
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      selectedCards.value = []
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('删除勾选卡密失败')
  }
}

const handleDeleteCardsByDate = async () => {
  if (!exportFilter.startDate && !exportFilter.endDate) return ElMessage.warning('请选择需要删除的日期范围')
  if (!confirm(`⚠️ 警告：确定要删除 ${exportFilter.startDate} 至 ${exportFilter.endDate} 范围内所有未使用的卡密吗？已使用卡密将自动保留。`)) return
  try {
    const res = await axios.post('/api/admin/cards/delete', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      mode: 'date',
      start_date: exportFilter.startDate,
      end_date: exportFilter.endDate
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('按日期范围删除失败')
  }
}

const handleDeleteInvalidCards = async () => {
  if (!confirm('⚠️ 警告：确定要清理所有已被使用核销的卡密吗？这将彻底清空已核销卡密的历史流水。')) return
  try {
    const res = await axios.post('/api/admin/cards/delete', {
      admin_user: props.currentUser.username,
      admin_pwd: props.adminPassword,
      mode: 'invalid'
    })
    if (res.data.code === 200) {
      ElMessage.success(res.data.msg)
      emit('reload-all')
    }
  } catch (_) {
    ElMessage.error('清空已核销卡密失败')
  }
}
</script>