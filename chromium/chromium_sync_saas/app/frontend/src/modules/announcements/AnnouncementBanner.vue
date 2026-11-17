<template>
  <div v-if="visibleAnnouncements.length > 0 && !dismissed" class="announcement-ticker">
    <div class="banner" :class="bannerClass(current.level)" style="margin-bottom: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px">
      <div class="row" style="gap: 8px; flex: 1">
        <span class="tag" :class="tagClass(current.level)">{{ current.is_pinned ? '置顶公告' : '系统公告' }}</span>
        <strong>{{ current.title }}</strong>
        <span class="muted" style="color: inherit; opacity: 0.9">— {{ current.content }}</span>
      </div>
      <div class="row" style="gap: 6px; flex-shrink: 0">
        <button v-if="visibleAnnouncements.length > 1" class="btn btn-sm" @click="nextItem">
          下一条 ({{ idx + 1 }}/{{ visibleAnnouncements.length }})
        </button>
        <button class="btn btn-sm" @click="dismissed = true">收起</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { apiFetch } from '../../api'

const visibleAnnouncements = ref([])
const idx = ref(0)
const dismissed = ref(false)

const current = computed(() => visibleAnnouncements.value[idx.value] || {})

function bannerClass(level) {
  if (level === 'danger') return 'banner-danger'
  if (level === 'warn') return 'banner-warn'
  if (level === 'success') return 'banner-success'
  return 'banner-info'
}

function tagClass(level) {
  if (level === 'danger') return 'tag-danger'
  if (level === 'warn') return 'tag-warn'
  if (level === 'success') return 'tag-ok'
  return 'tag-info'
}

function nextItem() {
  if (visibleAnnouncements.value.length <= 1) return
  idx.value = (idx.value + 1) % visibleAnnouncements.value.length
}

async function load() {
  try {
    const res = await apiFetch('/api/announcements')
    visibleAnnouncements.value = res.announcements || []
    idx.value = 0
  } catch {
    visibleAnnouncements.value = []
  }
}

onMounted(load)
</script>
