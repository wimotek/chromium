<template>
  <div v-if="visible" class="modal-backdrop" @click="$emit('close')">
    <div class="cyber-modal" @click.stop>
      <h3>📱 [{{ title }}] 节点连接凭证</h3>
      <p class="modal-tip">手机相机或客户端扫码即可导入：</p>
      <div class="qr-box">
        <img :src="qrCodeImgUrl" alt="QR Code" style="width: 220px; height: 220px; display: block;" />
      </div>
      <div class="node-field" style="margin-top: 15px; text-align: left;">
        <div class="code-display text-cyan" style="max-height: 80px; overflow-y: auto;">{{ link }}</div>
      </div>
      <div class="btn-group" style="justify-content: center;">
        <button class="btn-cyber-primary" style="width: auto; padding: 8px 18px;" @click="$emit('copy', link)">复制链接</button>
        <button class="btn-cyber-action" @click="$emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  title: { type: String, default: '' },
  link: { type: String, default: '' }
})

defineEmits(['close', 'copy'])

const qrCodeImgUrl = computed(() => {
  if (!props.link) return ''
  return '/api/qrcode?text=' + encodeURIComponent(props.link)
})
</script>