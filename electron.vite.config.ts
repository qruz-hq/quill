import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          hub: resolve(__dirname, 'src/renderer/hub.html'),
          flowbar: resolve(__dirname, 'src/renderer/flowbar.html'),
          scratchpad: resolve(__dirname, 'src/renderer/scratchpad.html')
        }
      }
    }
  }
})
