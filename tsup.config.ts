import { defineConfig } from 'tsup'

// Hedron bundles the plugin itself; this build only feeds the headless verify script.
export default defineConfig({
  entry: ['src/core.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
})
