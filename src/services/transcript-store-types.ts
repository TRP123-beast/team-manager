/**
 * Shape declarations for the Transcript Store API
 * (`https://ingest.caimbrian.ai`).
 *
 * Kept separate from the api module so the types can be imported into
 * store / hook layers without pulling in the fetch code (and its
 * network side effects during test / SSR).
 */

/**
 * Row shape from `GET /transcripts?limit=…&offset=…`. Lightweight —
 * doesn't include the full transcript body or the derived summary;
 * fetch the detail endpoint for those.
 */
export interface TranscriptListItem {
  id: number
  filename: string
  /** ISO timestamp of when the transcript was ingested. */
  created_at: string
  /** Whether the ingest pipeline has produced a summary for this
   *  transcript yet. False on freshly-uploaded rows before the
   *  summariser runs. */
  has_summary: boolean
  /** Project slug the transcript was tagged with at ingest time,
   *  or `null` if the pipeline couldn't route it to a project. */
  project: string | null
}

/**
 * Full transcript payload from `GET /transcripts/{id}`. Contains the
 * raw content plus any summariser-derived artifacts.
 */
export interface TranscriptDetail {
  id: number
  filename: string
  /** Full transcript text, e.g. `[10:00] Brian P: hello team\n[10:01] …`. */
  content: string
  created_at: string
  /** Markdown summary with YAML frontmatter — `null` until the
   *  summariser has run against this transcript. */
  summary: string | null
  /** Extracted action items, or `null` when extraction hasn't run.
   *  Each item's `id` is stable within the transcript so callers can
   *  dedupe across refreshes. */
  tasks: Array<{
    id: string
    description: string
    assignee: string
  }> | null
  project: string | null
  /** `YYYY-MM-DD` of the meeting that produced this transcript, or
   *  `null` if the pipeline couldn't infer a date. */
  meeting_date: string | null
  /** ISO timestamp of when the summariser last ran, or `null` if it
   *  hasn't run yet. */
  summarized_at: string | null
}

/**
 * Response envelope every endpoint returns.
 *
 *   - `success` — top-level status flag; check this before reading
 *     `data`.
 *   - `data` — the payload, typed per endpoint (item, item list, …).
 *     Null on any non-success response.
 *   - `error` — human-readable error string when `success` is false;
 *     null otherwise.
 *   - `meta` — pagination info (present on list endpoints).
 */
export interface TranscriptStoreResponse<T> {
  success: boolean
  data: T | null
  error: string | null
  meta?: {
    total: number
    limit: number
    offset: number
  }
}
