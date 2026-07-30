import { defineConfig } from 'vite'

// Builds the offline standalone viewer as a single classic IIFE bundle.
// Output lands in public/ so the main build ships it as a static asset.
export default defineConfig({
  publicDir: false, // outDir IS public/ - avoid self-copy
  build: {
    outDir: 'public',
    emptyOutDir: false, // don't wipe public/
    sourcemap: false,
    lib: {
      entry: 'src/standalone/main.ts',
      name: 'MtnMkrStandalone',
      formats: ['iife'], // guarantees ONE chunk, file:// safe
      fileName: () => 'standalone-viewer.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  // lib mode doesn't substitute it
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
})
