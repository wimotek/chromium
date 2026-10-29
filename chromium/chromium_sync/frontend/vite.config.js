import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: 'https://localhost:8443',
        changeOrigin: true,
        secure: false // 信任自签名证书，避免前端代理报 UNABLE_TO_VERIFY_LEAF_SIGNATURE
      }
    }
  }
})