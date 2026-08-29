import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      // The real package is types-only, so anything importing it needs a stand-in.
      obsidian: fileURLToPath(new URL('./test/stubs/obsidian.ts', import.meta.url))
    }
  }
})
