import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const sharedAlias = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      lib: {
        entry: 'src/main/index.ts'
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      lib: {
        entry: 'src/preload/index.ts'
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { ...sharedAlias, '@renderer': resolve(__dirname, 'src/renderer/src') } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          remote: resolve(__dirname, 'src/renderer/remote.html')
        }
      }
    },
    plugins: [react()]
  }
})
