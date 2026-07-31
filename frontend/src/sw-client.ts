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

const APPLIED_FLAG = 'mtnmkr-update-applied'

/** Reload onto the new version. Safe to call only from a user gesture. */
export function applyUpdate(): void {
  // Survives the reload so the next load knows not to re-announce an update
  // it already applied. Without it the banner latches again: the outgoing
  // worker can still read as "waiting" for a moment on the fresh page.
  try {
    sessionStorage.setItem(APPLIED_FLAG, '1')
  } catch {
    /* private mode - worst case the banner shows once more */
  }
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

  let justApplied = false
  try {
    justApplied = sessionStorage.getItem(APPLIED_FLAG) === '1'
    if (justApplied) sessionStorage.removeItem(APPLIED_FLAG)
  } catch {
    /* private mode */
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js')
      .then((reg) => {
        if (reg.waiting && !justApplied) {
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
