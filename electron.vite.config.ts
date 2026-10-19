import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
      // Fonts stay files: the CSP's font-src 'self' blocks data: URIs.
      assetsInlineLimit: (filePath) => (filePath.endsWith('.woff2') ? false : undefined),
      rolldownOptions: {
        input: resolve('index.html')
      }
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve('src')
      }
    }
  }
})
