import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base 必须为 './'，否则 Electron 用 file:// 加载打包产物时会白屏
export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000
  }
})
