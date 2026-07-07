/**
 * WebSocket manager for ZoomBot live events.
 *
 * Design notes:
 *
 *   - The singleton DOES NOT connect on import. Real connection happens
 *     on the first `connect()` call (or `acquire()`); idle apps never
 *     open the socket. This is critical for the spec's "WebSocket
 *     connection should NOT be established on app load" requirement.
 *
 *   - Reconnect uses exponential backoff (1s → 2s → 4s → 8s → 16s, then
 *     capped at 30s) up to 10 attempts. After that we give up and the
 *     caller has to re-establish manually.
 *
 *   - `on(type, cb)` returns an unsubscribe function for clean React
 *     teardown. Listeners survive across reconnects — that's the whole
 *     point of a transparent reconnect.
 *
 *   - `acquire()` / `release()` implement the ref-counted lifecycle the
 *     spec calls out: the last subscriber to release closes the socket
 *     so we don't keep a connection open for components that have
 *     unmounted. `connect()` / `disconnect()` remain available for
 *     callers who want explicit control instead of ref-counting.
 *
 *   - `disconnect()` clears listeners. `release()` leaves them in place
 *     so a future `acquire()` doesn't accidentally drop pending
 *     subscriptions a different consumer set up. Explicit disconnect
 *     is a "tear it all down" operation; release is "I personally don't
 *     need it anymore."
 */

import { getZoomBotConfig } from './zoombot-config'
import type { ZoomWSMessage } from './zoombot-types'

type WSCallback = (data: unknown) => void

const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
const MAX_RECONNECT_ATTEMPTS = 10

class ZoomBotWebSocket {
  private ws: WebSocket | null = null
  private listeners: Map<string, Set<WSCallback>> = new Map()
  private statusListeners: Set<() => void> = new Set()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts: number = 0
  /** Set to true once `disconnect()` runs so a queued reconnect won't
   *  fire. Cleared on the next explicit `connect()`. */
  private intentionallyClosed: boolean = false
  /** Ref count for the acquire/release lifecycle. */
  private refCount: number = 0
  /** True after a credentialed connect fails — the next attempt drops
   *  the `user:pass@` prefix and relies on the browser to replay Basic
   *  Auth credentials cached from prior REST calls. Sticky per socket
   *  lifetime; cleared on a successful open. */
  private authInUrlFailed: boolean = false

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Open the socket if it isn't open. Safe to call repeatedly. */
  connect(): void {
    this.intentionallyClosed = false
    if (typeof window === 'undefined') return
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return

    const { wsUrl, username, password } = getZoomBotConfig()
    if (!wsUrl) return

    // Attempt 1 — embed Basic Auth credentials in the wss:// URL:
    //   wss://user:pass@host/path
    // Not every browser supports credentials in the WS URL (Chromium
    // strips them, Firefox accepts). If the credentialed URL fails on
    // open, `authInUrlFailed` sticks so the next `connect()` falls
    // back to the bare URL and relies on cached Basic Auth from prior
    // REST calls.
    const useCredsInUrl =
      !this.authInUrlFailed && Boolean(username) && Boolean(password)
    const connectUrl = useCredsInUrl
      ? wsUrl.replace(
          /^(wss?:\/\/)/,
          `$1${encodeURIComponent(username)}:${encodeURIComponent(password)}@`,
        )
      : wsUrl

    let ws: WebSocket
    try {
      ws = new WebSocket(connectUrl)
    } catch (err) {
      // Constructor can throw on bad URLs — schedule a backoff retry.
      // If we tried a credentialed URL, drop back to bare on the retry.
      // eslint-disable-next-line no-console
      console.warn('[zoombot-ws] WebSocket constructor failed', err)
      if (useCredsInUrl) this.authInUrlFailed = true
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.addEventListener('open', () => {
      this.reconnectAttempts = 0
      // eslint-disable-next-line no-console
      console.info('[zoombot-ws] connected →', wsUrl)
      this.notifyStatusChange()
    })

    ws.addEventListener('message', (event) => {
      let parsed: ZoomWSMessage | null = null
      try {
        const raw = JSON.parse(event.data) as unknown
        if (
          raw &&
          typeof raw === 'object' &&
          'type' in raw &&
          typeof (raw as { type: unknown }).type === 'string'
        ) {
          parsed = raw as ZoomWSMessage
        }
      } catch {
        // ignored — malformed frames are dropped silently
      }
      if (!parsed) return
      this.dispatch(parsed.type, parsed.data)
    })

    ws.addEventListener('close', () => {
      this.ws = null
      // If this socket was the credentialed attempt and it never
      // reached OPEN (`reconnectAttempts` didn't reset), assume the
      // browser rejected creds in the URL and fall back to bare next
      // time. `reconnectAttempts === 0` means the 'open' handler ran
      // and cleared it; anything else means we failed before open.
      if (useCredsInUrl && this.reconnectAttempts !== 0) {
        this.authInUrlFailed = true
      }
      this.notifyStatusChange()
      if (this.intentionallyClosed) return
      this.scheduleReconnect()
    })

    ws.addEventListener('error', (event) => {
      // eslint-disable-next-line no-console
      console.warn('[zoombot-ws] socket error', event)
      // The browser fires 'close' right after 'error' for terminal
      // failures, so reconnection lives in the close handler.
    })
  }

  /** Close the socket and clear all state — listeners included. */
  disconnect(): void {
    this.intentionallyClosed = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignored
      }
      this.ws = null
    }
    this.listeners.clear()
    this.refCount = 0
    this.reconnectAttempts = 0
  }

  /** Ref-counted lifecycle. Returns a release function the caller MUST
   *  call when the component unmounts — typically via useEffect cleanup. */
  acquire(): () => void {
    this.refCount += 1
    if (this.refCount === 1) {
      this.connect()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.release()
    }
  }

  /** Internal: matches one `acquire()`. Closes the socket when the
   *  count returns to zero — listeners are preserved so the next
   *  acquire can pick up where this one left off. */
  private release(): void {
    this.refCount = Math.max(0, this.refCount - 1)
    if (this.refCount > 0) return
    this.intentionallyClosed = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignored
      }
      this.ws = null
    }
    this.reconnectAttempts = 0
  }

  // ── Subscriptions ──────────────────────────────────────────────────

  /**
   * Register a callback for a single WebSocket message type. Returns
   * an unsubscribe function — call it from your effect cleanup.
   *
   * `type` is loose to allow future server-side additions; cast the
   * data inside your callback to the appropriate `ZoomWSMessage` variant.
   */
  on(type: string, callback: WSCallback): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(callback)
    return () => {
      const s = this.listeners.get(type)
      if (!s) return
      s.delete(callback)
      if (s.size === 0) this.listeners.delete(type)
    }
  }

  /**
   * Subscribe to connection-state changes (open / close / reconnect
   * scheduled). Cheaper than polling `isConnected` from a useEffect on
   * a timer. Returns an unsubscribe function.
   */
  onStatusChange(callback: () => void): () => void {
    this.statusListeners.add(callback)
    return () => {
      this.statusListeners.delete(callback)
    }
  }

  private notifyStatusChange(): void {
    for (const cb of Array.from(this.statusListeners)) {
      try {
        cb()
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[zoombot-ws] status listener threw', err)
      }
    }
  }

  // ── Status ─────────────────────────────────────────────────────────

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  get reconnecting(): boolean {
    return (
      this.reconnectAttempts > 0 &&
      this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS
    )
  }

  // ── Internals ──────────────────────────────────────────────────────

  private dispatch(type: string, data: unknown): void {
    const set = this.listeners.get(type)
    if (!set || set.size === 0) return
    for (const cb of Array.from(set)) {
      try {
        cb(data)
      } catch (err) {
        // A throwing listener shouldn't tear down the rest of the
        // dispatch loop — log and move on.
        // eslint-disable-next-line no-console
        console.error(`[zoombot-ws] listener for "${type}" threw`, err)
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      // eslint-disable-next-line no-console
      console.warn(
        `[zoombot-ws] giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`,
      )
      return
    }
    const exponent = this.reconnectAttempts
    const delay = Math.min(
      INITIAL_BACKOFF_MS * Math.pow(2, exponent),
      MAX_BACKOFF_MS,
    )
    this.reconnectAttempts += 1
    // eslint-disable-next-line no-console
    console.info(
      `[zoombot-ws] reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
    )
    this.notifyStatusChange()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}

/**
 * Process-wide singleton. Components that need live ZoomBot data call
 * `zoomBotWS.acquire()` in a `useEffect`, store the returned release
 * function, and invoke it on cleanup. The first caller opens the
 * socket; the last release closes it.
 */
export const zoomBotWS = new ZoomBotWebSocket()
