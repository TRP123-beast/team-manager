/**
 * ZoomBot endpoint + credential resolution.
 *
 * The service moved from `n8n.dsliked.work.gd` (open) to
 * `bots.caimbrian.ai` (HTTP Basic Auth). Every REST call and the
 * WebSocket now need `Authorization: Basic <base64(user:pass)>` —
 * `getBasicAuthHeader()` is the single builder those call sites use.
 *
 * Lookup order (highest precedence wins):
 *   1. localStorage[zoombot_base_url] — runtime override, set from
 *      Settings without touching .env.
 *   2. VITE_ZOOMBOT_URL — build-time default from .env.
 *   3. Hardcoded fallback `https://bots.caimbrian.ai`.
 *
 * `wsUrl` is derived from `baseUrl` so the two never drift — swap
 * `https://` → `wss://` (and `http://` → `ws://`). Custom schemes pass
 * through unchanged.
 */

const STORAGE_KEY = 'zoombot_base_url'
const USERNAME_STORAGE_KEY = 'zoombot_username'
const PASSWORD_STORAGE_KEY = 'zoombot_password'
const HARDCODED_FALLBACK = 'https://bots.caimbrian.ai'

export interface ZoomBotConfig {
  baseUrl: string
  wsUrl: string
  username: string
  password: string
}

function readLocalStorageOverride(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(STORAGE_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

function readEnv(name: string): string {
  const raw = import.meta.env[name]
  return typeof raw === 'string' ? raw.trim() : ''
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function toWebSocketUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) {
    return 'wss://' + httpUrl.slice('https://'.length)
  }
  if (httpUrl.startsWith('http://')) {
    return 'ws://' + httpUrl.slice('http://'.length)
  }
  return httpUrl
}

function readLocalStorageOverrideByKey(key: string): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(key)?.trim() ?? ''
  } catch {
    return ''
  }
}

export function getZoomBotConfig(): ZoomBotConfig {
  const baseUrl = stripTrailingSlash(
    readLocalStorageOverride() ||
      readEnv('VITE_ZOOMBOT_URL') ||
      HARDCODED_FALLBACK,
  )
  // Credentials follow the same override → env fallback order as the
  // URL. Empty string means unconfigured; callers gate on
  // `isZoomBotConfigured()` before making auth'd requests.
  const username =
    readLocalStorageOverrideByKey(USERNAME_STORAGE_KEY) ||
    readEnv('VITE_ZOOMBOT_USERNAME')
  const password =
    readLocalStorageOverrideByKey(PASSWORD_STORAGE_KEY) ||
    readEnv('VITE_ZOOMBOT_PASSWORD')
  return {
    baseUrl,
    wsUrl: toWebSocketUrl(baseUrl),
    username,
    password,
  }
}

/**
 * Persist runtime overrides for username / password. Pass `null` or
 * an empty string for either to clear that override — the resolver
 * falls back to the env value as usual. Basic Auth secrets in
 * localStorage are a mild security tradeoff (they're readable by
 * any JS on the page); the env-var path is preferred for production.
 */
export function setZoomBotCredentials(
  username: string | null,
  password: string | null,
): void {
  if (typeof window === 'undefined') return
  try {
    if (!username || !username.trim()) {
      window.localStorage.removeItem(USERNAME_STORAGE_KEY)
    } else {
      window.localStorage.setItem(USERNAME_STORAGE_KEY, username.trim())
    }
    if (!password || !password.trim()) {
      window.localStorage.removeItem(PASSWORD_STORAGE_KEY)
    } else {
      window.localStorage.setItem(PASSWORD_STORAGE_KEY, password.trim())
    }
  } catch {
    // storage failure — silent
  }
}

/** Persist a runtime override of the base URL. Empty/null clears it. */
export function setZoomBotBaseUrl(url: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (!url || !url.trim()) {
      window.localStorage.removeItem(STORAGE_KEY)
    } else {
      window.localStorage.setItem(STORAGE_KEY, url.trim())
    }
  } catch {
    // Quota / private-mode storage failure — silently degrade.
  }
}

/**
 * Build the `Authorization` header value for every authenticated
 * ZoomBot call. Returns an empty string when credentials aren't
 * configured — callers should gate on `isZoomBotConfigured()` before
 * making requests, so this is a defensive fallback rather than a
 * primary path.
 */
export function getBasicAuthHeader(): string {
  const { username, password } = getZoomBotConfig()
  if (!username || !password) return ''
  // `btoa` handles ASCII cleanly. Usernames/passwords with non-ASCII
  // characters would need a UTF-8-aware encoder — flag if that ever
  // becomes a real requirement.
  return 'Basic ' + btoa(`${username}:${password}`)
}

/**
 * True iff we have every piece needed to talk to the service: a base
 * URL AND a username AND a password. The URL alone isn't enough
 * anymore since the endpoint now rejects unauthenticated requests.
 */
export function isZoomBotConfigured(): boolean {
  const { baseUrl, username, password } = getZoomBotConfig()
  return Boolean(baseUrl && username && password)
}
