/**
 * REST client for the transcripts endpoint on the ZoomBot host —
 * `${zoombot-base-url}/api/transcripts`. Shares the ZoomBot Basic Auth
 * credentials (no separate token).
 *
 * Three read helpers:
 *
 *   - fetchTranscripts(limit?, offset?)  — one page of the list.
 *   - fetchTranscript(id)                — one full transcript.
 *   - fetchAllTranscripts()              — paginates until exhausted
 *                                          (capped at 10,000 rows /
 *                                          50 pages to keep runaway
 *                                          servers from stalling us).
 *
 * Every call goes out with `Authorization: Basic <base64(user:pass)>`
 * and a 15s abort budget. `fetchTranscript` returns `null` for a 404
 * (missing transcript is a legitimate "not there" state, not an error
 * the caller should throw over); every other error surfaces as a
 * `TranscriptStoreApiError` with `status` + `message` so callers can
 * branch on 401 (auth issue) vs the rest.
 */

import { getBasicAuthHeader } from './zoombot-config'
import {
  getTranscriptStoreConfig,
  isTranscriptStoreConfigured,
} from './transcript-store-config'
import type {
  TranscriptDetail,
  TranscriptListItem,
  TranscriptStoreResponse,
} from './transcript-store-types'

const REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_PAGE_SIZE = 50
const ALL_PAGE_SIZE = 200
// Ceiling on `fetchAllTranscripts` so a misbehaving server can't stall
// a page load indefinitely. 50 pages × 200 rows = 10,000 transcripts —
// well above the ~141 current count with plenty of headroom for growth.
const ALL_MAX_PAGES = 50

export class TranscriptStoreApiError extends Error {
  readonly status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'TranscriptStoreApiError'
    this.status = status
  }
}

/** Merge auth + content-type into the request headers. Auth reuses
 *  ZoomBot's Basic Auth so a single set of credentials covers audio,
 *  video, WebSocket, and transcripts. */
function buildHeaders(): HeadersInit {
  const auth = getBasicAuthHeader()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (auth) headers['Authorization'] = auth
  return headers
}

/**
 * Wraps `fetch` with a 15s timeout, auth headers, and uniform error
 * normalisation. Returns the raw Response so callers can pick their
 * parsing strategy (all our current endpoints are JSON, but keeping
 * the door open avoids reshaping later).
 */
async function timedFetch(url: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, {
      headers: buildHeaders(),
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new TranscriptStoreApiError(
        `Transcript store request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${url}`,
      )
    }
    throw new TranscriptStoreApiError(
      `Could not reach the transcript endpoint. Check VITE_ZOOMBOT_URL and your network. (${
        err instanceof Error ? err.message : String(err)
      })`,
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Turn a non-OK Response into the right TranscriptStoreApiError. 401
 * gets a targeted message so the caller can surface "check your
 * token" copy; everything else carries the server's own error string
 * when the envelope provides one.
 */
async function throwForStatus(
  res: Response,
  scope: string,
): Promise<never> {
  if (res.status === 401) {
    throw new TranscriptStoreApiError(
      'Transcript endpoint rejected the credentials. Check the ZoomBot username/password.',
      401,
    )
  }
  // Try to pull the envelope's `error` field for a human message.
  let detail = ''
  try {
    const payload = (await res.json()) as {
      error?: string | null
    }
    if (payload.error) detail = ` ${payload.error}`
  } catch {
    // non-JSON body — fall through to plain HTTP status
  }
  throw new TranscriptStoreApiError(
    `${scope} failed (HTTP ${res.status}).${detail}`,
    res.status,
  )
}

/** Parse the response body as an envelope and return `data`. Throws
 *  a store error if the envelope's `success` flag is false or the
 *  shape doesn't match. */
async function readEnvelope<T>(
  res: Response,
  scope: string,
): Promise<TranscriptStoreResponse<T>> {
  let payload: unknown
  try {
    payload = await res.json()
  } catch (err) {
    throw new TranscriptStoreApiError(
      `Transcript store returned a non-JSON response for ${scope}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      res.status,
    )
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('success' in payload)
  ) {
    throw new TranscriptStoreApiError(
      `Transcript store returned an unexpected response shape for ${scope}.`,
      res.status,
    )
  }
  const envelope = payload as TranscriptStoreResponse<T>
  if (!envelope.success) {
    throw new TranscriptStoreApiError(
      envelope.error ?? `${scope} returned success=false.`,
      res.status,
    )
  }
  return envelope
}

// ── Reads ────────────────────────────────────────────────────────────

/**
 * One page of the transcript list. Returns the row array and the
 * server-reported `total` so callers can decide whether they need
 * additional pages.
 */
export async function fetchTranscripts(
  limit: number = DEFAULT_PAGE_SIZE,
  offset: number = 0,
): Promise<{ items: TranscriptListItem[]; total: number }> {
  if (!isTranscriptStoreConfigured()) {
    throw new TranscriptStoreApiError(
      'Transcript endpoint is not configured — set the ZoomBot URL + Basic Auth credentials.',
    )
  }
  const { baseUrl } = getTranscriptStoreConfig()
  const url = `${baseUrl}/api/transcripts?limit=${encodeURIComponent(
    limit,
  )}&offset=${encodeURIComponent(offset)}`
  const res = await timedFetch(url)
  if (!res.ok) await throwForStatus(res, 'fetchTranscripts')
  const envelope = await readEnvelope<TranscriptListItem[]>(
    res,
    'fetchTranscripts',
  )
  return {
    items: envelope.data ?? [],
    total: envelope.meta?.total ?? envelope.data?.length ?? 0,
  }
}

/**
 * A single transcript with body, summary, tasks, etc. Returns `null`
 * for a 404 so callers can distinguish "not found" from "network /
 * auth failure" without a try/catch dance.
 */
export async function fetchTranscript(
  id: number,
): Promise<TranscriptDetail | null> {
  if (!isTranscriptStoreConfigured()) {
    throw new TranscriptStoreApiError(
      'Transcript endpoint is not configured — set the ZoomBot URL + Basic Auth credentials.',
    )
  }
  const { baseUrl } = getTranscriptStoreConfig()
  const url = `${baseUrl}/api/transcripts/${encodeURIComponent(id)}`
  const res = await timedFetch(url)
  if (res.status === 404) return null
  if (!res.ok) await throwForStatus(res, `fetchTranscript(${id})`)
  const envelope = await readEnvelope<TranscriptDetail>(
    res,
    `fetchTranscript(${id})`,
  )
  return envelope.data
}

/**
 * Paginate through every transcript. Uses a larger page size (200)
 * than the single-page helper so we hit fewer round-trips, and caps
 * at 50 pages / 10,000 rows to keep a misbehaving server from
 * stalling a page load. Callers that need more can call
 * `fetchTranscripts` directly and drive pagination themselves.
 */
export async function fetchAllTranscripts(): Promise<TranscriptListItem[]> {
  const all: TranscriptListItem[] = []
  let offset = 0
  for (let page = 0; page < ALL_MAX_PAGES; page++) {
    const { items, total } = await fetchTranscripts(ALL_PAGE_SIZE, offset)
    all.push(...items)
    offset += items.length
    if (items.length === 0) break
    if (offset >= total) break
  }
  return all
}
