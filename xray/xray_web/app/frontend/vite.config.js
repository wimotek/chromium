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
    emptyOutDir: true
  }
})