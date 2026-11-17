<template>
  <div class="card">
    <div class="card-title">
      <span>模块化通知渠道插件中心（默认 SMTP 邮件 · Server酱 · 自定义 Webhook）</span>
      <button class="btn btn-sm" @click="load">刷新渠道插件</button>
    </div>

    <div class="banner banner-info">
      通知中心采用插件化注册架构，管理员可按需启停多种通知渠道（同时为新用户邮箱验证提供 SMTP 发信通道），后续扩展钉钉、飞书、Telegram 等渠道只需新增插件即可自动呈现配置表单。
    </div>

    <div class="row" style="margin-bottom: 14px">
      <button
        v-for="ch in channels"
        :key="ch.id"
        class="btn btn-sm"
        :class="{ 'btn-primary': activeId === ch.id }"
        @click="activeId = ch.id"
      >
        {{ ch.name }}
        <span class="tag" :class="ch.enabled ? 'tag-ok' : 'tag-warn'" style="margin-left: 6px">
          {{ ch.enabled ? '已启用' : '未启用' }}
        </span>
      </button>
    </div>

    <div v-if="activeChannel" style="border: 1px solid var(--border); border-radius: 8px; padding: 16px; background: #0b1120">
      <div class="row" style="justify-content: space-between; margin-bottom: 12px">
        <div>
          <strong style="font-size: 15px; color: #f8fafc">{{ activeChannel.name }}</strong>
          <div class="muted" style="font-size: 12px">{{ activeChannel.description }}</div>
        </div>
        <label class="row" style="cursor: pointer; gap: 6px">
          <input type="checkbox" v-model="drafts[activeChannel.id].enabled" />
          <span>启用该通知渠道</span>
        </label>
      </div>

      <div class="grid-3">
        <div v-for="f in activeChannel.fields" :key="f.key" class="field">
          <label>{{ f.label }}</label>
          <select v-if="f.type === 'boolean'" class="select" v-model="drafts[activeChannel.id][f.key]">
            <option :value="true">开启</option>
            <option :value="false">关闭</option>
          </select>
          <input
            v-else-if="f.type === 'number'"
            class="input mono"
            type="number"
            v-model.number="drafts[activeChannel.id][f.key]"
            :placeholder="f.placeholder || ''"
          />
          <input
            v-else-if="f.type === 'password'"
            class="input mono"
            type="password"
            v-model="drafts[activeChannel.id][f.key]"
            :placeholder="f.placeholder || ''"
          />
          <input
            v-else
            class="input"
            v-model="drafts[activeChannel.id][f.key]"
            :placeholder="f.placeholder || ''"
          />
        </div>
      </div>

      <div class="row" style="justify-content: space-between; margin-top: 8px">
        <div class="row" v-if="activeChannel.id === 'email'">
          <input
            class="input"
            style="width: 220px"
            v-model="testTargetEmail"
            placeholder="测试收件箱（默认配置收件人）"
          />
          <button class="btn btn-sm" @click="testChannel(activeChannel.id)">发送测试邮件</button>
        </div>
        <div v-else>
          <button v-if="activeChannel.supports_test" class="btn btn-sm" @click="testChannel(activeChannel.id)">
            发送渠道测试推送
          </button>
        </div>
        <button class="btn btn-primary" @click="saveChannel(activeChannel.id)">保存 [{{ activeChannel.name }}] 配置</button>
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

const activeChannel = computed(() => channels.value.find((c) => c.id === activeId.value) || channels.value[0] || null)

async function load() {
  try {
    const res = await apiFetch('/api/notifications/channels')
    channels.value = res.channels || []
    for (const ch of channels.value) {
      drafts[ch.id] = { ...(ch.config || {}), enabled: Boolean(ch.enabled) }
    }
    if (channels.value.length > 0 && !channels.value.find((c) => c.id === activeId.value)) {
      activeId.value = channels.value[0].id
    }
  } catch (e) {
    emit('notify', e.message)
  }
}

async function saveChannel(channelId) {
  try {
    const res = await apiFetch(`/api/notifications/channels/${channelId}`, {
      method: 'POST',
      body: JSON.stringify(drafts[channelId] || {}),
    })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

async function testChannel(channelId) {
  try {
    const payload = channelId === 'email' && testTargetEmail.value ? { target: testTargetEmail.value } : {}
    const res = await apiFetch(`/api/notifications/channels/${channelId}/test`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    emit('notify', res.message)
    await load()
  } catch (e) {
    emit('notify', e.message)
  }
}

onMounted(load)
</script>
