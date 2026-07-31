/**
 * Session persistence in IndexedDB.
 *
 * The service worker keeps the app shell and the terrain payloads; this keeps
 * the part that only exists in memory - which peak you were on, the layer and
 * exaggeration, and every track, photo, and note you imported. Without it a
 * reload (or iOS discarding a backgrounded tab) silently loses a whole trip's
 * worth of work, which is the failure people actually hit in the field.
 *
 * IndexedDB rather than localStorage because photos ride along as data URLs
 * and a single trip can run past localStorage's ~5 MB ceiling.
 */

import type { AreaMeta, BaseLayer, Overlay } from './types'
import type { Units } from './units'

const DB_NAME = 'mtnmkr'
const DB_VERSION = 1
const STORE = 'session'
const KEY = 'current'

export interface SavedSession {
  area: {
    lat: number
    lon: number
    radius_km: number
    size: number
    name: string | null
  } | null
  /**
   * The resolved area metadata, saved so a reload can skip straight to
   * fetching the heightmap.
   *
   * This is what makes an offline reload work at all. Building an area
   * normally starts with POST /api/area to resolve the id, and a POST cannot
   * be served from the Cache API - so without the saved meta an offline
   * reload would fail on the very first request, even with the heightmap
   * sitting in the cache.
   */
  meta: AreaMeta | null
  layer: BaseLayer
  exaggeration: number
  overlays: Overlay[]
  units: Units
  savedAt: string
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
    })
  } finally {
    db.close()
  }
}

export async function loadSession(): Promise<SavedSession | null> {
  try {
    return (await tx('readonly', (s) => s.get(KEY))) ?? null
  } catch {
    // Private browsing and some locked-down iOS configurations refuse
    // IndexedDB outright. Losing persistence is not worth blocking the app.
    return null
  }
}

export async function saveSession(state: Omit<SavedSession, 'savedAt'>): Promise<void> {
  try {
    await tx('readwrite', (s) =>
      s.put({ ...state, savedAt: new Date().toISOString() } satisfies SavedSession, KEY),
    )
  } catch {
    /* quota exceeded or storage denied - keep running in memory */
  }
}

export async function clearSession(): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(KEY))
  } catch {
    /* nothing to do */
  }
}

// ---- storage headroom ------------------------------------------------------

export interface StorageInfo {
  usageBytes: number | null
  quotaBytes: number | null
  persisted: boolean
}

/**
 * Ask the browser to exempt our data from routine eviction.
 *
 * This matters more than it looks on iOS: WebKit clears all script-writable
 * storage - IndexedDB, Cache Storage, and the service worker registration
 * itself - after seven days without a visit. A user who caches a peak at home
 * and drives to the trailhead a week later can arrive to an empty cache and no
 * signal. Home-screen installs get their own counter and are not swept, which
 * is why the UI tells people to add it to their home screen.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

export async function storageInfo(): Promise<StorageInfo> {
  let persisted = false
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? false
  } catch {
    /* not supported */
  }
  try {
    const est = (await navigator.storage?.estimate?.()) ?? {}
    return { usageBytes: est.usage ?? null, quotaBytes: est.quota ?? null, persisted }
  } catch {
    return { usageBytes: null, quotaBytes: null, persisted }
  }
}
