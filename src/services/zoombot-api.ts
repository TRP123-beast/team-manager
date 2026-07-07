/**
 * REST client for the ZoomBot service.
 *
 * Every request carries an HTTP Basic auth header built from
 * `getBasicAuthHeader()`. Endpoints:
 *
 *   - fetchBotState()                — GET /api/state
 *   - fetchRecordings(type?)         — GET /api/recordings?type=audio|video
 *                                       (transcripts are no longer served here)
 *   - getRecordingUrl(path)          — plain URL for <audio>/<video>. The
 *                                       browser reuses the Basic Auth
 *                                       credentials it cached from any
 *                                       preceding REST call.
 *   - getAuthenticatedRecordingUrl() — object URL variant for cases
 *                                       where the browser doesn't
 *                                       replay cached credentials (some
 *                                       Range requests, some CORS
 *                                       preflights).
 *   - deployBot / stopBot / stopAllBots / createBot / updateBot /
 *     deleteBot                       — write endpoints, all authed.
 *
 * `fetchTranscriptText` was removed — transcripts moved out of
 * ZoomBot into the store.
 *
 * Every fetch is bounded by a 10s timeout via AbortController. Network
 * failures throw with a human-readable message; the caller decides
 * whether to render an error state or retry.
 */

import { getBasicAuthHeader, getZoomBotConfig } from './zoombot-config'
import type { ZoomBotState, ZoomRecording } from './zoombot-types'

const REQUEST_TIMEOUT_MS = 10_000

export class ZoomBotApiError extends Error {
  readonly status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ZoomBotApiError'
    this.status = status
  }
}

/** Merge the caller's headers with our default set (auth + JSON) so
 *  every request goes out authenticated without repeating the boilerplate. */
function buildHeaders(extra?: HeadersInit): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const auth = getBasicAuthHeader()
  if (auth) headers['Authorization'] = auth
  if (extra) {
    // Merge in whatever the caller passed. Callers rarely need this
    // (all our current endpoints are JSON in / JSON out), but keeping
    // the door open avoids reshaping the signature later.
    Object.assign(headers, extra as Record<string, string>)
  }
  return headers
}

/**
 * Wraps `fetch` with a 10-second timeout, auth headers, and a
 * uniform error shape. Returns the raw Response — callers handle
 * parsing so they can pick `.json()` / `.text()` / `.blob()` as
 * appropriate.
 */
async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      ...init,
      headers: buildHeaders(init.headers),
      signal: controller.signal,
    })
    return res
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ZoomBotApiError(
        `ZoomBot request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${url}`,
      )
    }
    throw new ZoomBotApiError(
      `Could not reach the ZoomBot service. Check VITE_ZOOMBOT_URL and your network. (${
        err instanceof Error ? err.message : String(err)
      })`,
    )
  } finally {
    clearTimeout(timer)
  }
}

/** Live state snapshot: the active session id + every bot's status. */
export async function fetchBotState(): Promise<ZoomBotState> {
  const { baseUrl } = getZoomBotConfig()
  const res = await timedFetch(`${baseUrl}/api/state`)
  if (!res.ok) {
    throw new ZoomBotApiError(
      `Failed to fetch ZoomBot state (HTTP ${res.status}).`,
      res.status,
    )
  }
  try {
    return (await res.json()) as ZoomBotState
  } catch (err) {
    throw new ZoomBotApiError(
      `ZoomBot returned a non-JSON response for /api/state: ${
        err instanceof Error ? err.message : String(err)
      }`,
      res.status,
    )
  }
}

/**
 * Every recording in the cache, server-sorted newest-first.
 *
 * Optional `type` narrows the list to a single media type — the
 * server now only serves `'audio'` and `'video'` (transcripts moved
 * off ZoomBot). Omitting the arg returns whatever the server
 * defaults to; callers that care about a specific type should pass
 * it explicitly.
 */
export async function fetchRecordings(
  type?: 'audio' | 'video',
): Promise<ZoomRecording[]> {
  const { baseUrl } = getZoomBotConfig()
  const url = type
    ? `${baseUrl}/api/recordings?type=${encodeURIComponent(type)}`
    : `${baseUrl}/api/recordings`
  const res = await timedFetch(url)
  if (!res.ok) {
    throw new ZoomBotApiError(
      `Failed to fetch recordings list (HTTP ${res.status}).`,
      res.status,
    )
  }
  let payload: unknown
  try {
    payload = await res.json()
  } catch (err) {
    throw new ZoomBotApiError(
      `ZoomBot returned a non-JSON response for /api/recordings: ${
        err instanceof Error ? err.message : String(err)
      }`,
      res.status,
    )
  }
  // Accept either `[...]` directly or `{ files: [...] }` — the spec
  // says a `files` array, but a future iteration might flatten the
  // envelope.
  if (Array.isArray(payload)) return payload as ZoomRecording[]
  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { files?: unknown }).files)
  ) {
    return (payload as { files: ZoomRecording[] }).files
  }
  throw new ZoomBotApiError(
    'ZoomBot returned an unexpected /api/recordings shape — expected an array or `{ files: [...] }`.',
    res.status,
  )
}

/**
 * Plain URL for streaming a recording's bytes. Suitable to assign
 * directly to `<audio src>` / `<video src>` / `<a href download>`
 * IF the browser has previously made an authenticated request to the
 * same origin and cached the Basic Auth credentials — otherwise the
 * server will 401 the media request.
 *
 * When you can't guarantee cached credentials (fresh session, iframe
 * boundary, a Range request the browser doesn't attach creds to),
 * use `getAuthenticatedRecordingUrl` below to fetch as a blob and
 * hand back an object URL.
 */
export function getRecordingUrl(path: string): string {
  const { baseUrl } = getZoomBotConfig()
  return `${baseUrl}/api/recordings/file?path=${encodeURIComponent(path)}`
}

/**
 * Auth-safe variant of `getRecordingUrl`: fetches the recording
 * bytes with the Basic Auth header attached, then returns an object
 * URL that the browser can play back without needing to re-auth.
 *
 * Callers should `URL.revokeObjectURL(returnedUrl)` when the media
 * element unmounts — otherwise the blob stays pinned in memory.
 */
export async function getAuthenticatedRecordingUrl(
  path: string,
): Promise<string> {
  const url = getRecordingUrl(path)
  const res = await timedFetch(url)
  if (!res.ok) {
    throw new ZoomBotApiError(
      `Failed to fetch recording (HTTP ${res.status}): ${path}`,
      res.status,
    )
  }
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

// ── Write operations ────────────────────────────────────────────────────

/** POST /api/bots/:id/deploy — start (or restart) a configured bot. */
export async function deployBot(botId: number): Promise<void> {
  const { baseUrl } = getZoomBotConfig()
  const res = await timedFetch(`${baseUrl}/api/bots/${botId}/deploy`, {
    method: 'POST',
  })
  if (!res.ok) {
    throw new ZoomBotApiError(
      await formatHttpError(res, `Failed to deploy bot ${botId}`),
      res.status,
    )
  }
}

/** POST /api/bots/:id/stop — stop a running bot. */
export async function stopBot(botId: number): Promise<void> {
  const { baseUrl } = getZoomBotConfig()
  const res = await timedFetch(`${baseUrl}/api/bots/${botId}/stop`, {
    method: 'POST',
  })
  if (!res.ok) {
    throw new ZoomBotApiError(
      await formatHttpError(res, `Failed to stop bot ${botId}`),
      res.status,
    )
  }
}

/** POST /api/stop — stop every bot at once. */
export async function stopAllBots(): Promise<void> {
  const { baseUrl } = getZoomBotConfig()
  const res = await timedFetch(`${baseUrl}/api/stop`, {
    method: 'POST',
  })
  if (!res.ok) {
    throw new ZoomBotApiError(
      await formatHttpError(res, 'Failed to stop all bots'),
      res.status,
    )
  }
}

/** POST /api/bots — create a new bot for the session. */
export async function createBot(name: string, target: string): Promise<void> {
  const { baseUrl } = getZoomBotConfig()
  const res = await timedFetch(`${baseUrl}/api/bots`, {
    method: 'POST',
    body: JSON.stringify({ name, target }),
  })
  if (!res.ok) {
    throw new ZoomBotApiError(
      await formatHttpError(res, `Failed to create bot ${name}`),
      res.status,
    )
  }
}

/** PUT /api/bots/:id — rename or re-target an existing bot. */
export async function updateBot(
  botId: number,
  name: string,
  target: string,
): Promise<void> {
  const { baseUrl } = getZoomBotConfig()
  const res = await timedFetch(`${baseUrl}/api/bots/${botId}`, {
    method: 'PUT',
    body: JSON.stringify({ name, target }),
  })
  if (!res.ok) {
    throw new ZoomBotApiError(
      await formatHttpError(res, `Failed to update bot ${botId}`),
      res.status,
    )
  }
}

/** DELETE /api/bots/:id — remove a bot from the session config. */
export async function deleteBot(botId: number): Promise<void> {
  const { baseUrl } = getZoomBotConfig()
  const res = await timedFetch(`${baseUrl}/api/bots/${botId}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    throw new ZoomBotApiError(
      await formatHttpError(res, `Failed to delete bot ${botId}`),
      res.status,
    )
  }
}

/**
 * Best-effort error message. Pulls a textual body from the response,
 * trims to 200 chars to keep toast copy reasonable.
 */
async function formatHttpError(res: Response, fallback: string): Promise<string> {
  try {
    const text = await res.text()
    if (text) {
      const trimmed = text.trim().slice(0, 200)
      return `${fallback}: HTTP ${res.status} ${trimmed}`
    }
  } catch {
    // ignored
  }
  return `${fallback}: HTTP ${res.status}`
}
