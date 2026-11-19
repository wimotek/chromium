<template>
  <div class="card">
    <div class="card-title">
      <span>平台系统公告发布与管理</span>
      <button class="btn btn-sm btn-primary" @click="openNew">+ 发布新公告</button>
    </div>

    <div v-if="announcements.length === 0" class="muted">暂无公告。</div>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID / 级别</th>
            <th>公告标题 & 内容摘要</th>
            <th>置顶 / 登录页展示 / 状态</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in announcements" :key="a.id">
            <td>
              <span class="mono">#{{ a.id }}</span>
              <span class="tag" :class="levelClass(a.level)" style="margin-left: 6px">{{ a.level }}</span>
            </td>
            <td style="max-width: 420px">
              <strong>{{ a.title }}</strong>
              <div class="muted" style="font-size: 12px; margin-top: 2px">{{ a.content }}</div>
            </td>
            <td>
              <span v-if="a.is_pinned" class="tag tag-warn">置顶</span>
              <span v-if="a.show_on_auth" class="tag tag-info" style="margin-left: 4px">登录页可见</span>
              <span class="tag" :class="a.is_active ? 'tag-ok' : 'tag-danger'" style="margin-left: 4px">
                {{ a.is_active ? '生效中' : '已下线' }}
              </span>
            </td>
            <td class="mono muted">{{ a.updated_at }}</td>
            <td>
              <div class="row">
                <button class="btn btn-sm" @click="openEdit(a)">编辑</button>
                <button
                  class="btn btn-sm btn-danger"
                  :disabled="deletingId === a.id"
                  @click="removeItem(a.id)"
                >
                  {{ deletingId === a.id ? '删除中...' : '删除' }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="modalOpen" class="modal-backdrop" @click.self="modalOpen = false">
      <div class="modal-box">
        <h3 class="card-title">{{ editingId ? `编辑系统公告 #${editingId}` : '发布新系统公告' }}</h3>
        <div class="field">
          <label>公告标题</label>
          <input class="input" v-model.trim="form.title" placeholder="例如：全网节点费率下调通知 / 节点维护公告" />
        </div>
        <div class="grid-2">
          <div class="field">
            <label>公告级别</label>
            <select class="select" v-model="form.level">
              <option value="info">普通通知 (info)</option>
              <option value="success">优惠活动 (success)</option>
              <option value="warn">系统维护 (warn)</option>
              <option value="danger">重要告警 (danger)</option>
            </select>
          </div>
          <div class="field">
            <label>展示开关</label>
            <div class="row" style="padding-top: 6px; gap: 14px">
              <label class="switch switch-sm">
                <input type="checkbox" v-model="form.is_pinned" />
                <span class="switch-track"></span>
                <span class="switch-state" :class="{ on: form.is_pinned }">置顶</span>
              </label>
              <label class="switch switch-sm">
                <input type="checkbox" v-model="form.show_on_auth" />
                <span class="switch-track"></span>
                <span class="switch-state" :class="{ on: form.show_on_auth }">登录页展示</span>
              </label>
              <label class="switch switch-sm">
                <input type="checkbox" v-model="form.is_active" />
                <span class="switch-track"></span>
                <span class="switch-state" :class="{ on: form.is_active }">立即启用</span>
              </label>
            </div>
          </div>
        </div>
        <div class="field">
          <label>公告正文</label>
          <textarea class="textarea" rows="4" v-model.trim="form.content" placeholder="请输入系统公告详细内容..."></textarea>
        </div>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" :disabled="saving" @click="modalOpen = false">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">
            {{ saving ? '提交中...' : editingId ? '保存修改' : '确认发布' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { apiFetch } from '../../api'

const emit = defineEmits(['notify'])
const announcements = ref([])
const modalOpen = ref(false)
const editingId = ref(null)
const saving = ref(false)
const deletingId = ref(null)

const form = reactive({
  title: '',
  content: '',
  level: 'info',
  is_pinned: false,
  is_active: true,
  show_on_auth: true,
})

function levelClass(lv) {
  if (lv === 'danger') return 'tag-danger'
  if (lv === 'warn') return 'tag-warn'
  if (lv === 'success') return 'tag-ok'
  return 'tag-info'
}

async function load() {
  try {
    const res = await apiFetch('/api/admin/announcements')
    announcements.value = res.announcements || []
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  }
}

function openNew() {
  editingId.value = null
  Object.assign(form, { title: '', content: '', level: 'info', is_pinned: false, is_active: true, show_on_auth: true })
  modalOpen.value = true
}

function openEdit(a) {
  editingId.value = a.id
  Object.assign(form, {
    title: a.title,
    content: a.content,
    level: a.level || 'info',
    is_pinned: Boolean(a.is_pinned),
    is_active: Boolean(a.is_active),
    show_on_auth: Boolean(a.show_on_auth),
  })
  modalOpen.value = true
}

async function save() {
  if (saving.value) return
  saving.value = true
  try {
    const url = editingId.value ? `/api/admin/announcements/${editingId.value}` : '/api/admin/announcements'
    const method = editingId.value ? 'PUT' : 'POST'
    const res = await apiFetch(url, { method, body: JSON.stringify(form) })
    emit('notify', { message: res.message || '公告已保存', type: 'ok' })
    modalOpen.value = false
    await load()
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    saving.value = false
  }
}

async function removeItem(id) {
  if (deletingId.value !== null) return
  deletingId.value = id
  try {
    const res = await apiFetch(`/api/admin/announcements/${id}`, { method: 'DELETE' })
    emit('notify', { message: res.message || '公告已删除', type: 'ok' })
    await load()
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    deletingId.value = null
  }
}

onMounted(load)
</script>
