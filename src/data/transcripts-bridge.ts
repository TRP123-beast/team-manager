/**
 * Transcript Store ↔ Team Manager bridge.
 *
 * Analogous to `atlas-bridge.ts` / `sheets-bridge.ts` — pulls
 * transcripts from `ingest.caimbrian.ai`, maps them to domain
 * `Meeting` + `Task` objects, and provides a helper for merging
 * transcripts against Atlas meetings (dedup by date + project).
 *
 * The loader deliberately fans out one detail-fetch per recent
 * transcript in parallel with `Promise.allSettled` so a single broken
 * row doesn't take the whole load down. `errors` is returned to the
 * caller in the same shape `AtlasSnapshot` uses.
 */

import {
  fetchAllTranscripts,
  fetchTranscript,
} from '@/services/transcript-store-api'
import {
  mapTranscriptToMeeting,
  mapTranscriptTaskToTask,
} from '@/services/transcript-mapper'
import type { Meeting, Task } from './types'
import type { TranscriptListItem } from '@/services/transcript-store-types'

/** Window (days) of transcripts we hydrate detail for. Anything older
 *  than this stays in the list index but doesn't get pulled as a full
 *  meeting — keeps the initial load fast while still surfacing the
 *  active window (roughly last month of meetings). */
const RECENT_WINDOW_DAYS = 30

/** Fan-out cap on per-transcript detail fetches. Keeps concurrent
 *  connections bounded when the list index is dense. */
const DETAIL_CONCURRENCY = 12

export interface TranscriptSnapshot {
  meetings: Meeting[]
  /** Tasks extracted from each transcript's `tasks[]` — mapped once
   *  so callers can dedup against Atlas / Sheets tasks without
   *  running the mapper again. */
  tasks: Task[]
  /** Raw list index (all rows, not just recent). Useful for a future
   *  "browse older transcripts" UI without a re-fetch. */
  index: TranscriptListItem[]
  loadedAt: string
  errors: Array<{ source: string; message: string }>
}

/**
 * Fetch every transcript's list row, then hydrate the last
 * `RECENT_WINDOW_DAYS` days worth of full transcripts, then map them
 * to `Meeting` + `Task` shapes.
 *
 * Skips transcripts that haven't been summarised yet — they'd render
 * as meetings with empty notes / no decisions / no action items,
 * which is misleading. The next refresh will pick them up once the
 * summariser catches up.
 */
export async function loadFromTranscriptStore(): Promise<TranscriptSnapshot> {
  const errors: TranscriptSnapshot['errors'] = []
  const now = new Date().toISOString()

  let index: TranscriptListItem[] = []
  try {
    index = await fetchAllTranscripts()
  } catch (err) {
    errors.push({
      source: 'transcript-store:index',
      message: err instanceof Error ? err.message : String(err),
    })
    return { meetings: [], tasks: [], index: [], loadedAt: now, errors }
  }

  // Filter to the recent, summarised window.
  const cutoff = Date.now() - RECENT_WINDOW_DAYS * 86_400_000
  const recent = index.filter((row) => {
    if (!row.has_summary) return false
    const created = Date.parse(row.created_at)
    return Number.isFinite(created) && created >= cutoff
  })

  // Fan-out detail fetches in bounded batches so we don't hammer the
  // upstream with hundreds of concurrent requests.
  const meetings: Meeting[] = []
  const tasks: Task[] = []
  for (let i = 0; i < recent.length; i += DETAIL_CONCURRENCY) {
    const slice = recent.slice(i, i + DETAIL_CONCURRENCY)
    // Attach the source row to each promise so the settled result
    // carries enough context for a per-row error message. Wrapping
    // rejections into `{ ok: false }` sidesteps the discriminated-
    // union headache of PromiseSettledResult.
    const results = await Promise.all(
      slice.map(async (row) => {
        try {
          const detail = await fetchTranscript(row.id)
          return { row, ok: true as const, detail }
        } catch (err) {
          return { row, ok: false as const, err }
        }
      }),
    )
    for (const r of results) {
      if (!r.ok) {
        errors.push({
          source: `transcript-store:detail:${r.row.id}`,
          message: r.err instanceof Error ? r.err.message : String(r.err),
        })
        continue
      }
      const detail = r.detail
      if (!detail) {
        // 404 — transcript disappeared between the list fetch and
        // detail. Silently skip.
        continue
      }
      try {
        const meeting = mapTranscriptToMeeting(detail)
        meetings.push(meeting)
        if (detail.tasks) {
          for (const t of detail.tasks) {
            tasks.push(
              mapTranscriptTaskToTask(
                t,
                meeting.projectId,
                meeting.date,
              ),
            )
          }
        }
      } catch (err) {
        errors.push({
          source: `transcript-store:map:${r.row.id}`,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  return { meetings, tasks, index, loadedAt: now, errors }
}

// ── Merge with Atlas meetings ───────────────────────────────────────────────

/**
 * Merge a transcript meeting into an Atlas meeting when they refer
 * to the same event (same `date` + same `projectId`).
 *
 * Priority rules:
 *   - Atlas is the primary source of truth — its id, title,
 *     attendees, and structured extractions win.
 *   - Notes are ENRICHED, not replaced: if Atlas notes are short (or
 *     empty), we append the transcript's summary body so the reader
 *     gets the full picture. If Atlas notes are already substantial
 *     (>200 chars), we leave them alone — a longer Atlas summary is
 *     usually the curated one.
 *   - Decisions are UNION'd — we add any transcript decision whose
 *     text isn't already substantially represented in an Atlas
 *     decision.
 *   - Action items favour Atlas (more structured); transcript
 *     action items whose text doesn't overlap any Atlas item get
 *     appended.
 *
 * Pure — returns a new Meeting; the inputs are unchanged.
 */
export function mergeAtlasWithTranscript(
  atlas: Meeting,
  transcript: Meeting,
): Meeting {
  const enrichedNotes =
    atlas.notes.length > 200
      ? atlas.notes
      : atlas.notes
        ? `${atlas.notes}\n\n---\n\n${transcript.notes}`.trim()
        : transcript.notes

  // Union decisions by normalised text — dedupe near-duplicates
  // without doing a full semantic match. Same trick used by the
  // deduplication module elsewhere.
  const atlasDecisionKeys = new Set(
    atlas.decisions.map((d) => normalise(d.text)),
  )
  const extraDecisions = transcript.decisions.filter(
    (d) => !atlasDecisionKeys.has(normalise(d.text)),
  )

  const atlasActionKeys = new Set(
    atlas.actionItems.map((a) => normalise(a.text)),
  )
  const extraActions = transcript.actionItems.filter(
    (a) => !atlasActionKeys.has(normalise(a.text)),
  )

  // Add the "Full Transcript" link if Atlas doesn't already have one.
  const hasTranscriptLink = atlas.links.some((l) =>
    l.url.startsWith('transcript://'),
  )
  const extraLinks = hasTranscriptLink
    ? []
    : transcript.links.filter((l) => l.url.startsWith('transcript://'))

  return {
    ...atlas,
    notes: enrichedNotes,
    decisions: [...atlas.decisions, ...extraDecisions],
    actionItems: [...atlas.actionItems, ...extraActions],
    links: [...atlas.links, ...extraLinks],
    // Preserve Atlas's `updatedAt` unless the transcript is
    // demonstrably newer (summariser ran after Atlas's ingest).
    updatedAt:
      transcript.updatedAt > atlas.updatedAt
        ? transcript.updatedAt
        : atlas.updatedAt,
  }
}

/**
 * Given the Atlas meeting list and the transcript-derived meeting
 * list, return the merged set:
 *
 *   - Atlas meetings that have a matching transcript → merged via
 *     `mergeAtlasWithTranscript`, keyed by Atlas's id.
 *   - Atlas meetings with no transcript → unchanged.
 *   - Transcript meetings with no Atlas match → passed through as
 *     standalone meetings.
 *
 * Matching key is `${date}|${projectId}`. Multiple transcripts on the
 * same day for the same project all merge into the first Atlas match;
 * standalone transcripts on that day still surface separately if no
 * Atlas meeting exists.
 */
export function mergeAtlasAndTranscriptMeetings(
  atlasMeetings: Meeting[],
  transcriptMeetings: Meeting[],
): Meeting[] {
  if (transcriptMeetings.length === 0) return atlasMeetings
  const transcriptByKey = new Map<string, Meeting>()
  for (const t of transcriptMeetings) {
    transcriptByKey.set(`${t.date}|${t.projectId}`, t)
  }

  const merged: Meeting[] = []
  const consumedTranscripts = new Set<string>()
  for (const a of atlasMeetings) {
    const key = `${a.date}|${a.projectId}`
    const t = transcriptByKey.get(key)
    if (t) {
      merged.push(mergeAtlasWithTranscript(a, t))
      consumedTranscripts.add(t.id)
    } else {
      merged.push(a)
    }
  }
  for (const t of transcriptMeetings) {
    if (!consumedTranscripts.has(t.id)) merged.push(t)
  }
  return merged
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
