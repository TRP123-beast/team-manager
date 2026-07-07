/**
 * Read-only HTTP client for the Atlas Control Center public API.
 *
 * All callers go through `atlasFetch` (or the typed wrappers below) so:
 *  - The Bearer token is attached uniformly.
 *  - Network/CORS errors and API error envelopes are normalised into a
 *    single `AtlasApiError` for the UI to render.
 *  - Configuration is resolved from env vars + localStorage override on
 *    every call, so re-saving Settings is reflected immediately without a
 *    reload.
 */

import { getAtlasConfig } from './config'
import type {
  AtlasEnvelope,
  AtlasFeedItem,
  AtlasManifestResponse,
  AtlasProject,
  AtlasSummary,
  AtlasSummaryRef,
  AtlasTask,
  AtlasTaskState,
} from './types'

export class AtlasApiError extends Error {
  readonly status: number
  readonly code: AtlasErrorCode
  readonly detail?: string

  constructor(args: {
    code: AtlasErrorCode
    status: number
    message: string
    detail?: string
  }) {
    super(args.message)
    this.name = 'AtlasApiError'
    this.code = args.code
    this.status = args.status
    if (args.detail !== undefined) this.detail = args.detail
  }
}

export type AtlasErrorCode =
  | 'not_configured'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'network'
  | 'parse'
  | 'http'

interface FetchOptions {
  signal?: AbortSignal
}

async function atlasFetch<T>(
  path: string,
  query?: Record<string, string | number | undefined | null>,
  opts: FetchOptions = {},
): Promise<T> {
  const { baseUrl, token } = getAtlasConfig()
  if (!baseUrl || !token) {
    throw new AtlasApiError({
      code: 'not_configured',
      status: 0,
      message:
        'Atlas integration is not configured — set VITE_ATLAS_BASE_URL and VITE_ATLAS_TOKEN, or paste them in Settings.',
    })
  }

  const url = new URL(`${baseUrl}${path}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      url.searchParams.set(k, String(v))
    }
  }

  let res: Response
  try {
    const init: RequestInit = {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    }
    if (opts.signal) init.signal = opts.signal
    res = await fetch(url.toString(), init)
  } catch (err) {
    // fetch only throws on network/CORS/abort — everything HTTP-y is in `res`.
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new AtlasApiError({
      code: 'network',
      status: 0,
      message:
        'Could not reach Atlas — check the base URL, that the server is running, and that CORS allows this origin.',
      detail: err instanceof Error ? err.message : String(err),
    })
  }

  let body: unknown = null
  const text = await res.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      throw new AtlasApiError({
        code: 'parse',
        status: res.status,
        message: `Atlas returned a non-JSON response (HTTP ${res.status}).`,
        detail: text.slice(0, 200),
      })
    }
  }

  const envelope = body as AtlasEnvelope<T> | null

  if (!res.ok || !envelope || envelope.success === false) {
    const code = mapStatusToCode(res.status)
    const detail = envelope?.error ?? undefined
    const init: ConstructorParameters<typeof AtlasApiError>[0] = {
      code,
      status: res.status,
      message: humanMessage(code, detail),
    }
    if (detail !== undefined) init.detail = detail
    throw new AtlasApiError(init)
  }

  if (envelope.data === null) {
    throw new AtlasApiError({
      code: 'not_found',
      status: res.status,
      message: 'Atlas returned no data for this request.',
    })
  }

  return envelope.data
}

function mapStatusToCode(status: number): AtlasErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 400) return 'bad_request'
  return 'http'
}

function humanMessage(code: AtlasErrorCode, detail?: string): string {
  switch (code) {
    case 'unauthorized':
      return 'Atlas rejected the token — open Settings and paste a fresh one.'
    case 'forbidden':
      return "Token doesn't have permission for this endpoint."
    case 'not_found':
      return detail ?? 'Atlas could not find that resource.'
    case 'bad_request':
      return detail ?? 'Atlas rejected the request (bad parameters).'
    case 'parse':
      return 'Atlas returned an unexpected response shape.'
    case 'network':
      return 'Network error reaching Atlas.'
    default:
      return detail ?? 'Atlas request failed.'
  }
}

// ── Typed endpoint wrappers ──────────────────────────────────────────────

export function fetchAtlasProjects(opts?: FetchOptions): Promise<AtlasProject[]> {
  return atlasFetch<AtlasProject[]>('/projects', undefined, opts)
}

// Default is generous — the Atlas page renders the feed grouped by day
// and users expect to scroll back weeks. Callers that want a tight
// widget can still pass a small limit explicitly.
export function fetchAtlasFeed(
  limit = 500,
  opts?: FetchOptions,
): Promise<AtlasFeedItem[]> {
  return atlasFetch<AtlasFeedItem[]>('/feed', { limit }, opts)
}

export interface SummaryListQuery {
  project?: string
  date?: string
  limit?: number
}

export function fetchAtlasSummaries(
  query: SummaryListQuery = {},
  opts?: FetchOptions,
): Promise<AtlasSummaryRef[]> {
  return atlasFetch<AtlasSummaryRef[]>('/summaries', { ...query }, opts)
}

export function fetchAtlasSummary(
  project: string,
  date: string,
  opts?: FetchOptions,
): Promise<AtlasSummary> {
  return atlasFetch<AtlasSummary>(
    `/summaries/${encodeURIComponent(project)}/${encodeURIComponent(date)}`,
    undefined,
    opts,
  )
}

export interface TaskListQuery {
  project?: string
  status?: AtlasTaskState
  assignee?: string
}

export function fetchAtlasTasks(
  query: TaskListQuery = {},
  opts?: FetchOptions,
): Promise<AtlasTask[]> {
  return atlasFetch<AtlasTask[]>('/tasks', { ...query }, opts)
}

export function fetchAtlasTask(
  project: string,
  id: string,
  opts?: FetchOptions,
): Promise<AtlasTask> {
  return atlasFetch<AtlasTask>(
    `/tasks/${encodeURIComponent(project)}/${encodeURIComponent(id)}`,
    undefined,
    opts,
  )
}

export function fetchAtlasManifest(
  project: string,
  date: string,
  opts?: FetchOptions,
): Promise<AtlasManifestResponse> {
  return atlasFetch<AtlasManifestResponse>(
    `/manifests/${encodeURIComponent(project)}/${encodeURIComponent(date)}`,
    undefined,
    opts,
  )
}
