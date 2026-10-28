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
      <div class="card-header">
        <h3>🛠️ 批量生成卡密</h3>
        <!-- 一键快捷预设胶囊按钮组 -->
        <div class="preset-chip-group">
          <span style="font-size: 11px; color: #64748b; margin-right: 4px;">快捷填表:</span>
          <button class="chip-btn" @click="applyPreset('monthly_year')">📅 年卡 (每月50G)</button>
          <button class="chip-btn" @click="applyPreset('monthly_month')">⚡ 月卡 (每月100G)</button>
          <button class="chip-btn" @click="applyPreset('fixed_year')">📦 普通年卡 (固定1000G)</button>
          <button class="chip-btn" @click="applyPreset('unlimited')">👑 永久不限流量</button>
        </div>
      </div>
      
      <!-- 4 列横向网格制卡表单 -->
      <div class="gen-form">
        <div>
          <label>
            {{ cardGenForm.is_monthly ? '每月刷新配额 (GB/月)' : '总流量配额 (GB, 0为不限)' }}
          </label>
          <input v-model.number="cardGenForm.traffic_gb" type="number" class="cyber-input" placeholder="0=不限" />
        </div>
        <div>
          <label>
            {{ cardGenForm.is_monthly ? '总服务时长 (天, 年卡填365)' : '有效时限 (天, 36500为永久)' }}
          </label>
          <input v-model.number="cardGenForm.days" type="number" class="cyber-input" placeholder="36500=永久" />
        </div>
        <div>
          <label>批量制卡数 (张)</label>
          <input v-model.number="cardGenForm.count" type="number" class="cyber-input" />
        </div>
        <div class="gen-action-col">
          <label class="radio-label">
            <input type="checkbox" v-model="cardGenForm.is_monthly" /> 开启每月固定重置套餐
          </label>
          <button class="btn-cyber-success" :disabled="loading" @click="generateCards">立即批量制卡</button>
        </div>
      </div>

      <!-- 实时卡密特性提示条 -->
      <div class="preview-tip-bar" :class="{ 'highlight-monthly': cardGenForm.is_monthly }">
        {{ cardPreviewText }}
      </div>

      <div class="card-header" style="margin-top: 26px;">
        <h3>📦 历史卡密库存与核销流水 (最新200条)</h3>
        <button class="btn-cyber-refresh" @click="$emit('reload-all')">🔄 刷新列表</button>
      </div>

      <!-- 工具栏 -->
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
              <th>套餐配额规格</th>
              <th>套餐属性与时限</th>
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
              
              <!-- 核心优化：使用 isMonthlyCard 兼容判断 -->
              <td>
                <div v-if="isMonthlyCard(c)">
                  <b class="text-green" style="font-size: 14px;">
                    {{ c.traffic_gb === 0 ? '不限流量' : c.traffic_gb + ' GB / 每月' }}
                  </b>
                  <div style="font-size: 10px; color: #34d399; margin-top: 2px;">⚡ 每月自动刷新满格</div>
                </div>
                <div v-else>
                  <b style="font-size: 13px; color: #f1f5f9;">
                    {{ c.traffic_gb === 0 ? '♾️ 不限流量' : c.traffic_gb + ' GB' }}
                  </b>
                  <div style="font-size: 10px; color: #64748b; margin-top: 2px;">一次性固定包</div>
                </div>
              </td>

              <!-- 属性与时限列 -->
              <td>
                <div v-if="isMonthlyCard(c)">
                  <span class="badge badge-monthly" style="font-weight: 700;">
                    🔄 {{ getMonthlyCardBadge(c.days) }}
                  </span>
                  <div style="font-size: 11px; color: #38bdf8; margin-top: 3px; font-family: monospace;">
                    总服务时限: {{ c.days >= 3650 ? '永久' : c.days + ' 天' }}
                  </div>
                </div>
                <div v-else>
                  <span class="badge" style="background: rgba(148, 163, 184, 0.15); color: #94a3b8;">普通固定包</span>
                  <div style="font-size: 11px; color: #64748b; margin-top: 3px; font-family: monospace;">
                    时限: {{ c.days >= 3650 ? '永久' : c.days + ' 天' }}
                  </div>
                </div>
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
const cardGenForm = reactive({ traffic_gb: 50, days: 365, count: 5, is_monthly: true })

const fakaEnable = ref(true)
const fakaToken = ref('faka_secret_token_8899')

// 核心修复函数：兼容布尔、数字和字符类型
const isMonthlyCard = (c) => {
  if (!c) return false
  return (
    c.is_monthly === 1 ||
    c.is_monthly === '1' ||
    c.is_monthly === true ||
    String(c.is_monthly).toLowerCase() === 'true'
  )
}

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

const applyPreset = (type) => {
  if (type === 'monthly_year') {
    cardGenForm.traffic_gb = 50
    cardGenForm.days = 365
    cardGenForm.is_monthly = true
    ElMessage.success('已应用【年卡·每月50G】预设 (享12期刷新)')
  } else if (type === 'monthly_month') {
    cardGenForm.traffic_gb = 100
    cardGenForm.days = 30
    cardGenForm.is_monthly = true
    ElMessage.success('已应用【月卡·每月100G】预设')
  } else if (type === 'fixed_year') {
    cardGenForm.traffic_gb = 1000
    cardGenForm.days = 365
    cardGenForm.is_monthly = false
    ElMessage.info('已应用【普通年卡·一次性1000G】预设')
  } else if (type === 'unlimited') {
    cardGenForm.traffic_gb = 0
    cardGenForm.days = 36500
    cardGenForm.is_monthly = false
    ElMessage.warning('已应用【永久不限流量】预设')
  }
}

const cardPreviewText = computed(() => {
  const t = cardGenForm.traffic_gb === 0 ? '不限流量' : `${cardGenForm.traffic_gb} GB`
  const d = cardGenForm.days >= 3650 ? '永久' : `${cardGenForm.days} 天`
  if (cardGenForm.is_monthly) {
    let cycle = '周期月卡'
    if (cardGenForm.days >= 360 && cardGenForm.days <= 370) cycle = '周期年卡 (享 12 期重置)'
    else if (cardGenForm.days >= 85 && cardGenForm.days <= 95) cycle = '周期季卡 (享 3 期重置)'
    return `💡 当前卡密规格预览：【${cycle}】。用户充值后，每月固定获得 ${t} 流量，服务时效 ${d}。`
  } else {
    return `💡 当前卡密规格预览：【普通固定卡】。用户充值后，一次性获得 ${t} 流量，在 ${d} 内用完即止。`
  }
})

const getMonthlyCardBadge = (days) => {
  if (days >= 360 && days <= 370) return '周期年卡 (12期)'
  if (days >= 85 && days <= 95) return '周期季卡 (3期)'
  if (days >= 28 && days <= 32) return '周期月卡 (1期)'
  return '周期月度卡'
}

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
      ElMessage.success('卡密批量生成成功！规格已同步入库。')
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

<style scoped>
.gen-action-col {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 8px;
}

.preset-chip-group {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.chip-btn {
  background: #0f172a;
  border: 1px solid #334155;
  color: #38bdf8;
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 20px;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}
.chip-btn:hover {
  background: rgba(56, 189, 248, 0.15);
  border-color: #38bdf8;
  box-shadow: 0 0 8px rgba(56, 189, 248, 0.3);
}

.preview-tip-bar {
  font-size: 12px;
  color: #94a3b8;
  background: rgba(15, 23, 42, 0.6);
  border: 1px dashed #334155;
  border-radius: 6px;
  padding: 8px 14px;
  margin-top: -14px;
  margin-bottom: 20px;
  transition: all 0.3s;
}
.preview-tip-bar.highlight-monthly {
  color: #34d399;
  border-color: rgba(16, 185, 129, 0.4);
  background: rgba(16, 185, 129, 0.05);
}
</style>