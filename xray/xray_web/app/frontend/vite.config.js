import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // 核心修复：强制 Vite 使用纯前端构建版，杜绝 Rollup 解析 fs/stream 报错
      'qrcode': 'qrcode/build/qrcode.min.js'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})