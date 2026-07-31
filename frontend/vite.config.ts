import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Emits dist/sw.js from src/sw-template.js with the real hashed asset names
 * baked in.
 *
 * The service worker has to know the exact filenames Vite produced, and those
 * carry content hashes that only exist after the bundle is generated - hence a
 * plugin rather than a static file in public/. The cache version is a hash of
 * that manifest, so a deploy that changes nothing does not needlessly discard
 * a user's shell cache.
 */
function serviceWorker(): Plugin {
  return {
    name: 'mtnmkr-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((f) => /\.(js|css)$/.test(f))
        // The standalone viewer is 550 kB and only needed when exporting;
        // it is runtime-cached on first use instead of blocking install.
        .filter((f) => f !== 'standalone-viewer.js')
      const manifest = ['index.html', ...assets]
      const version = createHash('sha256').update(manifest.join('\n')).digest('hex').slice(0, 12)

      // replaceAll, not replace: a stray mention of a token in a comment
      // would otherwise consume the substitution and leave the real one intact
      const src = readFileSync(resolve(__dirname, 'src/sw-template.js'), 'utf8')
        .replaceAll('__CACHE_VERSION__', version)
        .replaceAll('__PRECACHE_MANIFEST__', JSON.stringify(manifest, null, 2))
        .replaceAll('__API_BASE__', process.env.VITE_API_BASE ?? '')
        .replaceAll('__PREBAKE_BASE__', process.env.VITE_PREBAKE_BASE ?? '')

      for (const token of [
        '__CACHE_VERSION__',
        '__PRECACHE_MANIFEST__',
        '__API_BASE__',
        '__PREBAKE_BASE__',
      ]) {
        if (src.includes(token)) this.error(`sw-template.js still contains ${token}`)
      }
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src })
    },
  }
}

export default defineConfig({
  // Set MTNMKR_BASE when deploying under a subdirectory, e.g.
  // MTNMKR_BASE=/mtnmkr/ npm run build  ->  https://example.com/mtnmkr/
  base: process.env.MTNMKR_BASE ?? '/',
  plugins: [react(), serviceWorker()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
