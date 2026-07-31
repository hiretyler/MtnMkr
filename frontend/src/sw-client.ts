/** Service worker registration and update plumbing.
 *
 * Registration is skipped in dev (the SW would serve stale Vite modules) and
 * on insecure origins, where the API does not exist at all.
 */

let waiting: ServiceWorker | null = null
let onUpdate: (() => void) | null = null

export function onUpdateReady(fn: () => void): void {
  onUpdate = fn
  if (waiting) fn()
}

/** Reload onto the new version. Safe to call only from a user gesture. */
export function applyUpdate(): void {
  if (!waiting) {
    location.reload()
    return
  }
  // The new worker takes over, then controllerchange fires and we reload once.
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
    once: true,
  })
  waiting.postMessage({ type: 'SKIP_WAITING' })
}

export function clearCachedTerrain(): Promise<void> {
  return new Promise((resolve) => {
    const ctrl = navigator.serviceWorker?.controller
    if (!ctrl) return resolve()
    const chan = new MessageChannel()
    const done = (): void => resolve()
    chan.port1.onmessage = done
    navigator.serviceWorker.addEventListener('message', done, { once: true })
    ctrl.postMessage({ type: 'CLEAR_TERRAIN' })
    window.setTimeout(done, 3000)
  })
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return
  if (import.meta.env.DEV) return
  if (!window.isSecureContext) return

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js')
      .then((reg) => {
        if (reg.waiting) {
          waiting = reg.waiting
          onUpdate?.()
        }
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing
          if (!sw) return
          sw.addEventListener('statechange', () => {
            // "installed" with an existing controller means an update is
            // staged behind the running version, not a first install.
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              waiting = sw
              onUpdate?.()
            }
          })
        })
      })
      .catch(() => {
        /* offline-first is a bonus, never a hard requirement */
      })
  })
}
