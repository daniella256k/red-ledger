import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite externalizes `dependencies` for main and preload by default
// (`build.externalizeDeps`).
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve('electron/main.ts')
      },
      rolldownOptions: {
        external: ['better-sqlite3']
      }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: {
        entry: resolve('electron/preload.ts')
      },
      rolldownOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'preload.js'
        }
      }
    }
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'out/renderer',
      rolldownOptions: {
        input: resolve('index.html')
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve('src')
      }
    }
  }
})
