import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

function cloudflareCompatPlugin() {
  return {
    name: 'cloudflare-compat-html',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/<script(?![^>]*\bdata-cfasync=)/gi, '<script data-cfasync="false"')
        .replace(/(<(?:script|link)\b[^>]*?)\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?/gi, '$1')
    }
  }
}

export default defineConfig({
  plugins: [vue(), cloudflareCompatPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('element-plus') || id.includes('@element-plus') || id.includes('@vueuse') || id.includes('lodash')) {
            return 'vendor-element'
          }
          if (id.includes('axios')) {
            return 'vendor-axios'
          }
          if (id.includes('/vue/') || id.includes('@vue/')) {
            return 'vendor-vue'
          }
        }
      }
    }
  }
})