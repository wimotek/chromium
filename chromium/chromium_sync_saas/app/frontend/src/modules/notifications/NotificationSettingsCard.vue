<template>
  <div class="card">
    <div class="card-title">
      <span>模块化通知渠道插件中心（默认 SMTP 邮件 · Server酱 · 自定义 Webhook）</span>
      <button class="btn btn-sm" :disabled="loading" @click="load(true)">
        {{ loading ? '刷新中...' : '刷新渠道插件' }}
      </button>
    </div>

    <div class="banner banner-info">
      通知中心采用插件化注册架构，管理员可按需启停多种通知渠道（同时为新用户邮箱验证提供 SMTP 发信通道），后续扩展钉钉、飞书、Telegram 等渠道只需新增插件即可自动呈现配置表单。
    </div>

    <div class="row" style="margin-bottom: 14px; gap: 10px">
      <button
        v-for="ch in channels"
        :key="ch.channel_id"
        class="btn btn-sm"
        :class="{ 'btn-primary': activeId === ch.channel_id }"
        @click="activeId = ch.channel_id"
      >
        <span>{{ ch.display_name }}</span>
        <span class="tag" :class="ch.enabled ? 'tag-ok' : 'tag-warn'" style="margin-left: 6px">
          {{ ch.enabled ? '已启用' : '未启用' }}
        </span>
      </button>
    </div>

    <div v-if="activeChannel && drafts[activeChannel.channel_id]" style="border: 1px solid var(--border); border-radius: 8px; padding: 16px; background: #0b1120">
      <div class="row" style="justify-content: space-between; margin-bottom: 12px">
        <div>
          <strong style="font-size: 15px; color: #f8fafc">{{ activeChannel.display_name }}</strong>
          <div class="muted" style="font-size: 12px">{{ activeChannel.description }}</div>
        </div>
        <div class="row" style="gap: 12px">
          <label class="switch">
            <input type="checkbox" v-model="drafts[activeChannel.channel_id].enabled" />
            <span class="switch-track"></span>
            <span class="switch-state" :class="{ on: drafts[activeChannel.channel_id].enabled }">
              {{ drafts[activeChannel.channel_id].enabled ? '已启用渠道' : '未启用渠道' }}
            </span>
          </label>
          <button
            class="btn btn-sm"
            :class="activeChannel.enabled ? 'btn-warn' : 'btn-emerald'"
            :disabled="savingChannel === activeChannel.channel_id"
            @click="quickToggleChannel(activeChannel)"
          >
            {{
              savingChannel === activeChannel.channel_id
                ? '切换中...'
                : activeChannel.enabled
                  ? '一键停用'
                  : '一键启用'
            }}
          </button>
        </div>
      </div>

      <div class="grid-3">
        <div v-for="f in activeChannel.fields" :key="f.key" class="field">
          <div class="row" style="justify-content: space-between; margin-bottom: 5px">
            <label style="margin: 0">{{ f.label }}</label>
            <span
              v-if="f.type === 'password' && drafts[activeChannel.channel_id][`${f.key}_configured`]"
              class="tag tag-ok"
            >
              已保存密钥
            </span>
          </div>
          <label
            v-if="f.type === 'boolean'"
            class="switch-row"
            :class="{ active: Boolean(drafts[activeChannel.channel_id][f.key]) }"
          >
            <span class="switch-row-title" style="font-size: 12.5px">
              {{ drafts[activeChannel.channel_id][f.key] ? '已开启' : '已关闭' }}
            </span>
            <span class="switch switch-sm">
              <input type="checkbox" v-model="drafts[activeChannel.channel_id][f.key]" />
              <span class="switch-track"></span>
            </span>
          </label>
          <input
            v-else-if="f.type === 'number'"
            class="input mono"
            type="number"
            v-model.number="drafts[activeChannel.channel_id][f.key]"
            :placeholder="f.placeholder || ''"
          />
          <input
            v-else-if="f.type === 'password'"
            class="input mono"
            type="password"
            v-model="drafts[activeChannel.channel_id][f.key]"
            :placeholder="f.placeholder || ''"
          />
          <input
            v-else
            class="input"
            v-model="drafts[activeChannel.channel_id][f.key]"
            :placeholder="f.placeholder || ''"
          />
        </div>
      </div>

      <div class="row" style="justify-content: space-between; margin-top: 8px">
        <div class="row" v-if="activeChannel.channel_id === 'email'">
          <input
            class="input"
            style="width: 220px"
            v-model="testTargetEmail"
            placeholder="测试收件箱（默认配置收件人）"
          />
          <button
            class="btn btn-sm"
            :disabled="testingChannel === activeChannel.channel_id"
            @click="testChannel(activeChannel.channel_id)"
          >
            {{ testingChannel === activeChannel.channel_id ? '发送中...' : '发送测试邮件' }}
          </button>
        </div>
        <div v-else>
          <button
            v-if="activeChannel.supports_test"
            class="btn btn-sm"
            :disabled="testingChannel === activeChannel.channel_id"
            @click="testChannel(activeChannel.channel_id)"
          >
            {{ testingChannel === activeChannel.channel_id ? '推送中...' : '发送渠道测试推送' }}
          </button>
        </div>
        <div class="row" style="gap: 8px">
          <span
            v-if="saveFeedback[activeChannel.channel_id]"
            class="save-status"
            :class="saveFeedback[activeChannel.channel_id].ok ? 'save-status-ok' : 'save-status-error'"
          >
            {{ saveFeedback[activeChannel.channel_id].ok ? '✓' : '✕' }} {{ saveFeedback[activeChannel.channel_id].text }}
          </span>
          <button
            class="btn btn-primary"
            :disabled="savingChannel === activeChannel.channel_id"
            @click="saveChannel(activeChannel.channel_id)"
          >
            {{
              savingChannel === activeChannel.channel_id
                ? '正在保存...'
                : `保存 [${activeChannel.display_name}] 配置`
            }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { apiFetch } from '../../api'

const emit = defineEmits(['notify'])
const channels = ref([])
const activeId = ref('email')
const drafts = reactive({})
const testTargetEmail = ref('')

const loading = ref(false)
const savingChannel = ref('')
const testingChannel = ref('')
const saveFeedback = reactive({})

const activeChannel = computed(() => channels.value.find((c) => c.channel_id === activeId.value) || channels.value[0] || null)

function nowTimeStr() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function load(showFeedback = false) {
  if (loading.value) return
  loading.value = true
  try {
    const res = await apiFetch('/api/notifications/channels')
    channels.value = res.channels || []
    for (const ch of channels.value) {
      drafts[ch.channel_id] = { ...(ch.config || {}), enabled: Boolean(ch.enabled) }
    }
    if (channels.value.length > 0 && !channels.value.find((c) => c.channel_id === activeId.value)) {
      activeId.value = channels.value[0].channel_id
    }
    if (showFeedback) {
      emit('notify', { message: '通知渠道插件列表已刷新', type: 'info' })
    }
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    loading.value = false
  }
}

async function saveChannel(channelId) {
  if (savingChannel.value) return
  savingChannel.value = channelId
  try {
    const res = await apiFetch(`/api/notifications/channels/${channelId}`, {
      method: 'POST',
      body: JSON.stringify(drafts[channelId] || {}),
    })
    saveFeedback[channelId] = { ok: true, text: `已保存 ${nowTimeStr()}` }
    emit('notify', { message: res.message || '通知渠道配置已保存', type: 'ok' })
    await load(false)
  } catch (e) {
    saveFeedback[channelId] = { ok: false, text: '保存失败' }
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    savingChannel.value = ''
  }
}

async function quickToggleChannel(ch) {
  const cid = ch.channel_id
  if (!drafts[cid] || savingChannel.value) return
  drafts[cid].enabled = !ch.enabled
  await saveChannel(cid)
}

async function testChannel(channelId) {
  if (testingChannel.value) return
  testingChannel.value = channelId
  try {
    const payload = channelId === 'email' && testTargetEmail.value ? { target: testTargetEmail.value } : {}
    const res = await apiFetch(`/api/notifications/channels/${channelId}/test`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    emit('notify', { message: res.message || '测试推送已发送', type: 'ok' })
    await load(false)
  } catch (e) {
    emit('notify', { message: e.message, type: 'error' })
  } finally {
    testingChannel.value = ''
  }
}

onMounted(() => load(false))
</script>
