/**
 * Convert Transcript Store payloads (`TranscriptDetail`) into the
 * domain shapes Team Manager already speaks — `Meeting` and `Task`.
 * Pure functions — no fetches, no side effects — so they're safe to
 * call from a store loader or a unit test.
 *
 * Every generated id is deterministic (`dec-transcript-<n>-<i>`,
 * `act-transcript-<n>-<i>`, `link-transcript-<n>-<i>`) so repeated
 * mappings of the same transcript produce the same output. Callers
 * that need to persist to Supabase's `meetings` table can strip the
 * `transcript-` prefix from `meeting.id` and route the manifest
 * identifier through `source_manifest_id` — same pattern the Atlas
 * mapper uses.
 */

import { KNOWN_MEMBERS } from './atlas-mapper'
import type { TranscriptDetail } from './transcript-store-types'
import type {
  ActionItem,
  Decision,
  Meeting,
  MeetingLink,
  Task,
} from '@/data/types'

const SYSTEM_ACTOR = 'transcript-store'

// ── Public API ──────────────────────────────────────────────────────────────

export function mapTranscriptToMeeting(transcript: TranscriptDetail): Meeting {
  const parsed = parseFilename(transcript.filename)
  const date = pickMeetingDate(transcript, parsed.filenameDate)

  return {
    id: `transcript-${transcript.id}`,
    projectId: transcript.project ?? 'unassigned',
    title: buildTitle(transcript, parsed.participants, date),
    date,
    startTime: parsed.startTime,
    duration: null,
    attendeeIds: mapParticipantsToMemberIds(parsed.participants),
    status: 'completed',
    location: 'Zoom (via ZoomBot)',
    agenda: null,
    notes: transcript.summary ?? '',
    decisions: extractDecisions(transcript.summary, transcript.id),
    actionItems: (transcript.tasks ?? []).map((t, i) =>
      mapTranscriptTaskToActionItem(t, transcript.id, i),
    ),
    questions: [],
    links: buildLinks(transcript),
    createdBy: SYSTEM_ACTOR,
    createdAt: transcript.created_at,
    updatedAt: transcript.summarized_at ?? transcript.created_at,
    lastEditedBy: null,
    lastEditedAt: null,
  }
}

export function mapTranscriptTaskToTask(
  task: NonNullable<TranscriptDetail['tasks']>[number],
  projectId: string,
  meetingDate: string,
): Task {
  return {
    id: `transcript-task-${task.id}`,
    title: task.description,
    description: '',
    projectId,
    assigneeId: resolveAssignee(task.assignee),
    priority: 'medium',
    status: 'todo',
    dueDate: null,
    tags: [],
    subtasks: [],
    createdAt: meetingDate || new Date().toISOString(),
    updatedAt: meetingDate || new Date().toISOString(),
    createdBy: SYSTEM_ACTOR,
  }
}

// ── Filename parsing ────────────────────────────────────────────────────────

interface ParsedFilename {
  /** Participant display names (title-cased) in the order they appear
   *  in the filename. */
  participants: string[]
  /** `YYYY-MM-DD` if present in the filename, else `null`. */
  filenameDate: string | null
  /** `HH:MM` start time if the filename ends with an `HH-MM-SS` block,
   *  else `null`. */
  startTime: string | null
}

/**
 * Parse a filename like `Room_1_Brian_P_2026-07-06_10-04-11.txt` into
 * its participant list, date, and start-time components.
 *
 *   - "Room" + a number at the start is treated as a room prefix and
 *     dropped.
 *   - A single-letter segment after a name (e.g. `Brian_P`) is
 *     treated as an initial and joined to the previous participant.
 *   - The first `YYYY-MM-DD` block is the meeting date.
 *   - `HH-MM-SS` immediately after the date is the start time —
 *     converted to `HH:MM` for the domain (which doesn't carry
 *     seconds).
 */
export function parseFilename(filename: string): ParsedFilename {
  const noExt = filename.replace(/\.[^.]+$/, '')
  const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(noExt)
  const filenameDate = dateMatch?.[1] ?? null

  // Everything before the date is participant tokens (possibly
  // prefixed with `Room_N`); everything after may include a time.
  const beforeDate = dateMatch ? noExt.slice(0, dateMatch.index) : noExt
  const afterDate = dateMatch
    ? noExt.slice(dateMatch.index + dateMatch[0].length)
    : ''

  const rawTokens = beforeDate.split('_').filter((t) => t.length > 0)
  let start = 0
  if (
    rawTokens[0]?.toLowerCase() === 'room' &&
    rawTokens[1] &&
    /^\d+$/.test(rawTokens[1])
  ) {
    start = 2
  }

  const participants: string[] = []
  for (let i = start; i < rawTokens.length; i++) {
    const tok = rawTokens[i]
    if (!tok) continue
    if (tok.length === 1 && participants.length > 0) {
      // Single letter following a name — treat as an initial.
      const last = participants[participants.length - 1]
      participants[participants.length - 1] = `${last} ${tok.toUpperCase()}`
    } else {
      participants.push(titleCase(tok))
    }
  }

  // Time comes right after the date as `_HH-MM-SS`.
  const timeMatch = /_(\d{2})-(\d{2})-\d{2}/.exec(afterDate)
  const startTime = timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : null

  return { participants, filenameDate, startTime }
}

function titleCase(word: string): string {
  if (!word) return word
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

// ── Title / date resolution ─────────────────────────────────────────────────

function pickMeetingDate(
  transcript: TranscriptDetail,
  filenameDate: string | null,
): string {
  if (transcript.meeting_date) return transcript.meeting_date
  if (filenameDate) return filenameDate
  // created_at is an ISO timestamp — split off the calendar day.
  const day = transcript.created_at.split('T')[0]
  return day ?? transcript.created_at
}

function buildTitle(
  transcript: TranscriptDetail,
  participants: string[],
  date: string,
): string {
  const fromSummary = extractTitleFromSummary(transcript.summary)
  if (fromSummary) return fromSummary
  const humanDate = formatHumanDate(date)
  if (participants.length > 0) {
    return `Meeting — ${participants.join(', ')} — ${humanDate}`
  }
  return `Meeting — ${humanDate}`
}

/**
 * Extract the first `# Heading` from the summary markdown. Skips the
 * boilerplate "Daily Summary YYYY-MM-DD" heading Atlas-adjacent
 * pipelines sometimes produce.
 */
function extractTitleFromSummary(summary: string | null): string | null {
  if (!summary) return null
  const match = /^#\s+(.+)$/m.exec(summary)
  if (!match || !match[1]) return null
  const raw = match[1].trim()
  if (!raw) return null
  if (/^daily\s+summary/i.test(raw)) return null
  // Strip trailing "— Daily Summary YYYY-MM-DD" suffix if present.
  return raw
    .replace(/\s*[—–-]\s*Daily Summary\s+\d{4}-\d{2}-\d{2}\s*$/i, '')
    .trim()
}

function formatHumanDate(dateStr: string): string {
  // Local-time parse (avoid UTC shift) — matches the pattern used in
  // date-utils. Falls back to the raw string if parsing fails.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr
  const parts = dateStr.split('-').map(Number)
  const y = parts[0] ?? 1970
  const m = parts[1] ?? 1
  const d = parts[2] ?? 1
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// ── Attendee resolution ────────────────────────────────────────────────────

/**
 * Match each participant against `KNOWN_MEMBERS` by lowercased first
 * token — that's the key format the atlas mapper uses. Unmatched
 * names drop out silently (the meeting still renders; attendee
 * avatars just skip them).
 */
export function mapParticipantsToMemberIds(participants: string[]): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const p of participants) {
    const slug = p.split(' ')[0]?.toLowerCase()
    if (!slug) continue
    if (!KNOWN_MEMBERS[slug]) continue
    if (seen.has(slug)) continue
    seen.add(slug)
    ids.push(slug)
  }
  return ids
}

function resolveAssignee(raw: string | null | undefined): string | null {
  if (!raw) return null
  const slug = raw.trim().toLowerCase().split(/\s+/)[0]
  if (!slug) return null
  return KNOWN_MEMBERS[slug] ? slug : null
}

// ── Decision extraction from summary markdown ───────────────────────────────

/**
 * Scan the summary markdown for a `## Decisions` (or `## Decisions
 * Made`) heading and pull every bullet underneath as a Decision.
 *
 * Bullets shaped like `Brian decided: <text>` route the name into
 * `decidedBy` and drop the "decided:" preamble from `text`. Otherwise
 * `decidedBy` stays null.
 */
export function extractDecisions(
  summary: string | null,
  transcriptId: number,
): Decision[] {
  if (!summary) return []
  const decisions: Decision[] = []
  let inSection = false

  for (const line of summary.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      inSection = /^decisions?(\s+(made|reached))?$/i.test(
        heading[1]?.trim() ?? '',
      )
      continue
    }
    if (!inSection) continue

    const bullet = /^[\s]*[-*]\s+(.+?)\s*$/.exec(line)
    if (!bullet || !bullet[1]) continue

    const text = bullet[1]
    let decidedBy: string | null = null
    let clean = text

    // "Brian decided: X" or "Brian: X" or "Brian — X"
    const named = /^([A-Za-z][A-Za-z\-.]*)\s+(?:decided|noted|agreed)(?:\s+that)?:\s+(.+)$/i.exec(
      text,
    )
    if (named && named[1] && named[2]) {
      const slug = named[1].toLowerCase()
      if (KNOWN_MEMBERS[slug]) {
        decidedBy = slug
        clean = named[2]
      }
    }

    decisions.push({
      id: `dec-transcript-${transcriptId}-${decisions.length}`,
      text: clean,
      decidedBy,
    })
  }

  return decisions
}

// ── Action items + links ────────────────────────────────────────────────────

function mapTranscriptTaskToActionItem(
  task: NonNullable<TranscriptDetail['tasks']>[number],
  transcriptId: number,
  index: number,
): ActionItem {
  return {
    id: task.id || `act-transcript-${transcriptId}-${index}`,
    text: task.description,
    assigneeId: resolveAssignee(task.assignee),
    dueDate: null,
    done: false,
    linkedTaskId: null,
  }
}

function buildLinks(transcript: TranscriptDetail): MeetingLink[] {
  // Internal reference — the UI knows how to open a `transcript://` URL
  // (fetch by id) even though it's not a real navigable URL. Keeps
  // the Meeting shape faithful to the domain without inventing a new
  // field just for transcripts.
  return [
    {
      id: `link-transcript-${transcript.id}-0`,
      label: 'Full Transcript',
      url: `transcript://${transcript.id}`,
    },
  ]
}
