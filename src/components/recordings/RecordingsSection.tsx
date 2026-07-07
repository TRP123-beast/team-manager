/**
 * Meeting recordings UI mounted under the project Meetings tab.
 *
 * Three responsibilities:
 *   1. Fetch the recordings list from the ZoomBot REST endpoint on
 *      mount (and on a manual refresh) via the context's
 *      `fetchRecordings` action.
 *   2. Group what comes back into per-date sessions, split each
 *      session into audio / video / full-transcript / live-caption
 *      sub-lists, and render a collapsible card per session.
 *   3. Render correct empty / error / loading / unconfigured states so
 *      this section is safe to mount even when ZoomBot is offline.
 *
 * Reused by `MeetingDetailPage` via the `filterDate` prop — same
 * grouping pipeline, scoped to one session.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileAudio,
  FileText,
  FileVideo,
  Loader2,
  Play,
  RefreshCw,
  Settings as SettingsIcon,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useZoomBot } from '@/hooks/useZoomBot'
import {
  getAuthenticatedRecordingUrl,
  getRecordingUrl,
} from '@/services/zoombot-api'
import { isZoomBotConfigured } from '@/services/zoombot-config'
import type { ZoomBot, ZoomRecording } from '@/services/zoombot-types'
import {
  fetchAllTranscripts,
  fetchTranscript,
} from '@/services/transcript-store-api'
import { isTranscriptStoreConfigured } from '@/services/transcript-store-config'
import type {
  TranscriptDetail,
  TranscriptListItem,
} from '@/services/transcript-store-types'
import { AtlasMarkdown } from '@/components/atlas/AtlasMarkdown'
import {
  currentMonthKey,
  formatBytes,
  formatMonthKey,
  formatSessionDate,
  groupRecordingsBySession,
  groupSessionsByMonth,
  shortenFilename,
  type RecordingSession,
} from '@/lib/recordings-grouping'

/** Threshold (total file count) above which we group sessions by month
 *  and collapse months older than the current one by default. */
const MANY_FILES_THRESHOLD = 100

interface RecordingsSectionProps {
  /** When set, filter to the matching date's session only (used on the
   *  meeting detail page). When omitted, show every session. */
  filterDate?: string
  /** Hide the section title — useful when embedding inside another
   *  surface that has its own heading. */
  compact?: boolean
}

export function RecordingsSection({ filterDate, compact = false }: RecordingsSectionProps) {
  const {
    recordings,
    recordingsLoading,
    connectionError,
    fetchRecordings,
    activeBots,
  } = useZoomBot()
  const configured = isZoomBotConfigured()

  // Only fire the initial fetch once per mount. The context caches the
  // list, so re-rendering doesn't re-fetch.
  const requestedRef = useRef<boolean>(false)
  useEffect(() => {
    if (!configured) return
    if (requestedRef.current) return
    requestedRef.current = true
    void fetchRecordings()
  }, [configured, fetchRecordings])

  // Paths that the active bots are currently writing to. Used to label
  // those files as "Recording in progress…" in the UI.
  const inProgressPaths = useMemo(
    () => buildInProgressSet(activeBots),
    [activeBots],
  )

  // ── Transcript Store (separate service now) ────────────────────────
  // Audio / video still stream from ZoomBot; transcripts and summaries
  // come from ingest.caimbrian.ai. The two fetches run in parallel and
  // degrade independently — one service going down doesn't hide the
  // other's content.
  const transcriptConfigured = isTranscriptStoreConfigured()
  const [transcriptIndex, setTranscriptIndex] = useState<
    TranscriptListItem[] | null
  >(null)
  const [transcriptsLoading, setTranscriptsLoading] = useState<boolean>(false)
  const [transcriptsError, setTranscriptsError] = useState<string | null>(null)
  useEffect(() => {
    if (!transcriptConfigured) return
    let cancelled = false
    setTranscriptsLoading(true)
    setTranscriptsError(null)
    fetchAllTranscripts()
      .then((rows) => {
        if (cancelled) return
        setTranscriptIndex(rows)
      })
      .catch((err) => {
        if (cancelled) return
        setTranscriptsError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setTranscriptsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [transcriptConfigured])

  const transcriptsByDate = useMemo(() => {
    const map = new Map<string, TranscriptListItem[]>()
    if (!transcriptIndex) return map
    for (const row of transcriptIndex) {
      const day = pickTranscriptDate(row)
      if (!day) continue
      const list = map.get(day) ?? []
      list.push(row)
      map.set(day, list)
    }
    return map
  }, [transcriptIndex])

  const sessions = useMemo(() => {
    const zoomSessions = groupRecordingsBySession(recordings ?? [])
    const zoomDates = new Set(zoomSessions.map((s) => s.date).filter(Boolean))
    // Synthetic "transcript-only" sessions for dates that have a
    // transcript but no matching ZoomBot recording — keeps the meeting
    // visible in the Recordings panel even when the audio/video capture
    // failed or was intentionally skipped.
    const transcriptOnly: RecordingSession[] = []
    for (const [date, rows] of transcriptsByDate) {
      if (zoomDates.has(date)) continue
      transcriptOnly.push({
        date,
        audio: [],
        video: [],
        fullTranscripts: [],
        liveCaptions: [],
        totalSize: 0,
        counts: { audio: 0, video: 0, transcripts: rows.length },
      })
    }
    const combined = [...zoomSessions, ...transcriptOnly].sort((a, b) => {
      // Newest-first, undated last (matches ZoomBot behaviour).
      const da = a.date || ''
      const db = b.date || ''
      if (!da && !db) return 0
      if (!da) return 1
      if (!db) return -1
      return db.localeCompare(da)
    })
    if (!filterDate) return combined
    return combined.filter((s) => s.date === filterDate)
  }, [recordings, transcriptsByDate, filterDate])

  const totalFiles = useMemo(
    () => (recordings ?? []).filter((r) => r.size > 0).length,
    [recordings],
  )

  const header = compact ? null : (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          Meeting Recordings
        </h2>
        <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
          Audio & video from ZoomBot, transcripts & summaries from the
          Transcript Store.
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          requestedRef.current = true
          void fetchRecordings()
        }}
        disabled={recordingsLoading || !configured}
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-[var(--border-default)] bg-transparent px-3 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {recordingsLoading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        Refresh
      </button>
    </header>
  )

  // ── Empty / unconfigured / error short-circuits ────────────────────
  //
  // Both sources are optional now — audio/video from ZoomBot and
  // transcripts/summaries from the Transcript Store. The section
  // only fully bails when NEITHER is configured; a single-service
  // outage just narrows what's on screen.
  const zoomBotDown =
    connectionError !== null && (recordings === null || recordings.length === 0)
  const bothSourcesDown =
    (!configured || zoomBotDown) &&
    (!transcriptConfigured || (transcriptsError !== null && !transcriptIndex))

  if (!configured && !transcriptConfigured) {
    return (
      <section className="space-y-3">
        {header}
        <UnconfiguredState />
      </section>
    )
  }
  const initialLoadInFlight =
    (configured && recordingsLoading && recordings === null) ||
    (transcriptConfigured && transcriptsLoading && transcriptIndex === null)
  if (initialLoadInFlight && sessions.length === 0) {
    return (
      <section className="space-y-3">
        {header}
        <LoadingState />
      </section>
    )
  }
  if (bothSourcesDown) {
    return (
      <section className="space-y-3">
        {header}
        <ErrorState
          error={
            connectionError ??
            transcriptsError ??
            'Both recording sources are unreachable.'
          }
          onRetry={() => {
            requestedRef.current = true
            void fetchRecordings()
          }}
        />
      </section>
    )
  }
  if (sessions.length === 0) {
    return (
      <section className="space-y-3">
        {header}
        <EmptyState filterDate={filterDate} />
      </section>
    )
  }

  // ── Many-files mode: group by month, collapse older months ──────
  const groupByMonth = totalFiles >= MANY_FILES_THRESHOLD && !filterDate
  if (groupByMonth) {
    const byMonth = groupSessionsByMonth(sessions)
    const months = Array.from(byMonth.keys()).sort((a, b) => b.localeCompare(a))
    const currentMonth = currentMonthKey()
    return (
      <section className="space-y-3">
        {header}
        <p className="text-xs text-[var(--text-muted)]">
          Showing {totalFiles} files across {sessions.length} session
          {sessions.length === 1 ? '' : 's'} — older months are collapsed by
          default.
        </p>
        <div className="space-y-3">
          {months.map((m) => (
            <MonthGroup
              key={m}
              month={m}
              sessions={byMonth.get(m) ?? []}
              defaultOpen={m === currentMonth}
              inProgressPaths={inProgressPaths}
              transcriptsByDate={transcriptsByDate}
            />
          ))}
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-3">
      {header}
      {transcriptsError && configured && recordings && recordings.length > 0 && (
        <p className="rounded-md border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 px-3 py-2 text-xs text-[var(--text-muted)]">
          Transcript store unreachable — showing audio & video only. (
          {transcriptsError})
        </p>
      )}
      {connectionError && transcriptIndex && transcriptIndex.length > 0 && (
        <p className="rounded-md border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 px-3 py-2 text-xs text-[var(--text-muted)]">
          ZoomBot unreachable — showing transcripts only. ({connectionError})
        </p>
      )}
      <div className="space-y-3">
        {sessions.map((s) => (
          <SessionCard
            key={s.date || 'undated'}
            session={s}
            inProgressPaths={inProgressPaths}
            defaultOpen={sessions.length === 1}
            transcripts={s.date ? transcriptsByDate.get(s.date) ?? [] : []}
          />
        ))}
      </div>
    </section>
  )
}

// ── Month group ────────────────────────────────────────────────────────

function MonthGroup({
  month,
  sessions,
  defaultOpen,
  inProgressPaths,
  transcriptsByDate,
}: {
  month: string
  sessions: RecordingSession[]
  defaultOpen: boolean
  inProgressPaths: ReadonlySet<string>
  transcriptsByDate: ReadonlyMap<string, TranscriptListItem[]>
}) {
  const [open, setOpen] = useState<boolean>(defaultOpen)
  const totalFiles = sessions.reduce(
    (sum, s) =>
      sum +
      s.counts.audio +
      s.counts.video +
      s.counts.transcripts,
    0,
  )
  return (
    <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-elevated)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        aria-expanded={open}
      >
        <div>
          <p className="text-sm font-medium text-[var(--text-primary)]">
            {formatMonthKey(month)}
          </p>
          <p className="text-[11px] text-[var(--text-muted)] tabular-nums">
            {sessions.length} session{sessions.length === 1 ? '' : 's'} ·{' '}
            {totalFiles} file{totalFiles === 1 ? '' : 's'}
          </p>
        </div>
        {open ? (
          <ChevronDown className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t border-[var(--border-subtle)] p-3">
          {sessions.map((s) => (
            <SessionCard
              key={s.date || 'undated'}
              session={s}
              inProgressPaths={inProgressPaths}
              defaultOpen={false}
              transcripts={s.date ? transcriptsByDate.get(s.date) ?? [] : []}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// ── Session card ───────────────────────────────────────────────────────

function SessionCard({
  session,
  inProgressPaths,
  defaultOpen,
  transcripts,
}: {
  session: RecordingSession
  inProgressPaths: ReadonlySet<string>
  defaultOpen: boolean
  /** Transcript-store rows matched to this session's date. Separate
   *  source from ZoomBot recordings — one can be empty while the
   *  other has content. */
  transcripts: TranscriptListItem[]
}) {
  const [open, setOpen] = useState<boolean>(defaultOpen)
  const { audio, video, fullTranscripts, liveCaptions, counts, totalSize, date } = session

  return (
    <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-elevated)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            {formatSessionDate(date)}
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)] tabular-nums">
            {counts.audio} audio · {counts.video} video ·{' '}
            {counts.transcripts} transcript
            {counts.transcripts === 1 ? '' : 's'} ·{' '}
            <span className="text-[var(--text-secondary)]">
              {formatBytes(totalSize)}
            </span>
          </p>
        </div>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div className="space-y-4 border-t border-[var(--border-subtle)] p-4">
          <SubSection
            icon={<FileAudio className="h-3.5 w-3.5" aria-hidden="true" />}
            title="Audio Files"
            count={audio.length}
            empty="No audio captured."
          >
            <ul className="space-y-2">
              {audio.map((r) => (
                <AudioFileRow
                  key={r.path}
                  recording={r}
                  inProgress={inProgressPaths.has(r.path)}
                />
              ))}
            </ul>
          </SubSection>

          <SubSection
            icon={<FileVideo className="h-3.5 w-3.5" aria-hidden="true" />}
            title="Video Files"
            count={video.length}
            empty="No screen shares recorded."
          >
            <ul className="space-y-2">
              {video.map((r) => (
                <VideoFileRow
                  key={r.path}
                  recording={r}
                  inProgress={inProgressPaths.has(r.path)}
                />
              ))}
            </ul>
          </SubSection>

          <SubSection
            icon={<FileText className="h-3.5 w-3.5" aria-hidden="true" />}
            title="Transcripts & Summaries"
            count={transcripts.length}
            empty="No transcript ingested for this session yet."
          >
            <ul className="space-y-2">
              {transcripts.map((row) => (
                <TranscriptStoreRow key={row.id} row={row} />
              ))}
            </ul>
          </SubSection>

          {/* ZoomBot's own transcript files were the previous source
              for this section — we deliberately no longer render them
              here. Kept the destructured refs above so a follow-up
              can surface them as a raw "captured on ZoomBot" fallback
              if the store ever loses history. */}
          {(fullTranscripts.length > 0 || liveCaptions.length > 0) && (
            <p className="text-[11px] italic text-[var(--text-muted)]">
              {fullTranscripts.length + liveCaptions.length} legacy
              transcript file{fullTranscripts.length + liveCaptions.length === 1 ? '' : 's'}{' '}
              on ZoomBot — content now served from the Transcript Store above.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function SubSection({
  icon,
  title,
  count,
  empty,
  children,
}: {
  icon: React.ReactNode
  title: string
  count: number
  empty: string
  children: React.ReactNode
}) {
  return (
    <div>
      <h3 className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
        {icon}
        {title}
        <span className="ml-1 text-[10px] tabular-nums text-[var(--text-muted)]">
          ({count})
        </span>
      </h3>
      <div className="mt-2">
        {count === 0 ? (
          <p className="text-xs italic text-[var(--text-muted)]">{empty}</p>
        ) : (
          children
        )}
      </div>
    </div>
  )
}

// ── Audio row ──────────────────────────────────────────────────────────

/**
 * Audio row uses `getAuthenticatedRecordingUrl` — the endpoint is
 * Basic-Auth-protected now, and `<audio src>` on a cross-origin URL
 * doesn't reliably replay cached browser credentials, so we fetch
 * the file as a blob with the Authorization header attached and hand
 * back an object URL for the media element. Eager on mount because
 * audio files are usually small; the object URL is revoked on
 * unmount to release the blob.
 */
function AudioFileRow({
  recording,
  inProgress,
}: {
  recording: ZoomRecording
  inProgress: boolean
}) {
  const downloadUrl = getRecordingUrl(recording.path)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let url: string | null = null
    setError(null)
    getAuthenticatedRecordingUrl(recording.path)
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u)
          return
        }
        url = u
        setPlaybackUrl(u)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [recording.path])

  return (
    <li className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[var(--text-primary)]">
            {shortenFilename(recording.name)}
          </p>
          <p className="text-[11px] text-[var(--text-muted)] tabular-nums">
            {formatBytes(recording.size)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {inProgress && <InProgressBadge />}
          <DownloadButton href={downloadUrl} filename={recording.name} />
        </div>
      </div>
      {playbackUrl ? (
        <audio className="mt-2 h-9 w-full" controls src={playbackUrl} />
      ) : error ? (
        <p className="mt-2 text-[11px] text-[var(--priority-critical)]">
          Audio unavailable: {error}
        </p>
      ) : (
        <p className="mt-2 text-[11px] text-[var(--text-muted)]">
          Loading audio…
        </p>
      )}
    </li>
  )
}

// ── Video row + modal ──────────────────────────────────────────────────

/**
 * Video row lazy-loads the auth URL on Play — video files can be
 * hundreds of MB, so pre-fetching them on mount would tank the page.
 * Fetch triggers when the user clicks Play; the modal shows a
 * loading state until the blob is ready.
 */
function VideoFileRow({
  recording,
  inProgress,
}: {
  recording: ZoomRecording
  inProgress: boolean
}) {
  const [open, setOpen] = useState<boolean>(false)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const downloadUrl = getRecordingUrl(recording.path)

  const handleOpen = async () => {
    setOpen(true)
    if (playbackUrl || loading) return
    setLoading(true)
    setError(null)
    try {
      const url = await getAuthenticatedRecordingUrl(recording.path)
      setPlaybackUrl(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  // Revoke the blob URL when the row unmounts so the browser can
  // reclaim the buffer.
  useEffect(() => {
    return () => {
      if (playbackUrl) URL.revokeObjectURL(playbackUrl)
    }
  }, [playbackUrl])

  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/30 p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-[var(--text-primary)]">
          {shortenFilename(recording.name)}
        </p>
        <p className="text-[11px] text-[var(--text-muted)] tabular-nums">
          {formatBytes(recording.size)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {inProgress && <InProgressBadge />}
        <button
          type="button"
          onClick={() => {
            void handleOpen()
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-3 text-xs font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        >
          <Play className="h-3 w-3" aria-hidden="true" />
          Play
        </button>
        <DownloadButton href={downloadUrl} filename={recording.name} />
      </div>
      {open && (
        <VideoPlayerModal
          url={playbackUrl}
          title={shortenFilename(recording.name)}
          loading={loading}
          error={error}
          onClose={() => setOpen(false)}
        />
      )}
    </li>
  )
}

function VideoPlayerModal({
  url,
  title,
  loading,
  error,
  onClose,
}: {
  /** null while the auth-URL is still being fetched. */
  url: string | null
  title: string
  loading: boolean
  error: string | null
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Video player: ${title}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="truncate text-sm font-medium text-[var(--text-primary)]">
            {title}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {loading && (
          <div className="flex items-center justify-center gap-2 rounded-md bg-black/50 p-8 text-sm text-white">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading video…
          </div>
        )}
        {error && !loading && (
          <p className="rounded-md bg-black/50 p-6 text-center text-sm text-white">
            Could not load video: {error}
          </p>
        )}
        {url && !loading && !error && (
          <video
            className="w-full rounded-md bg-black"
            controls
            autoPlay
            src={url}
          />
        )}
      </div>
    </div>
  )
}

// ── Transcript row (Transcript Store) ──────────────────────────────────
//
// Row for a single transcript-store entry. Lazy-loads the full
// TranscriptDetail on first "View" click so the section listing
// stays cheap. Renders the summary as markdown (via AtlasMarkdown),
// then the raw transcript body underneath.

function TranscriptStoreRow({ row }: { row: TranscriptListItem }) {
  const [open, setOpen] = useState<boolean>(false)
  const [detail, setDetail] = useState<TranscriptDetail | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const ensureDetail = async (): Promise<TranscriptDetail | null> => {
    if (detail !== null) return detail
    setLoading(true)
    setError(null)
    try {
      const d = await fetchTranscript(row.id)
      if (!d) {
        setError('Transcript not found on the store.')
        return null
      }
      setDetail(d)
      return d
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setLoading(false)
    }
  }

  const handleToggle = async () => {
    if (!open) await ensureDetail()
    setOpen((o) => !o)
  }

  const handleCopy = async () => {
    const d = await ensureDetail()
    if (!d) {
      toast.error('Could not load transcript to copy.')
      return
    }
    try {
      await navigator.clipboard.writeText(d.content)
      toast.success('Transcript copied to clipboard.')
    } catch {
      toast.error('Clipboard unavailable.')
    }
  }

  return (
    <li className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[var(--text-primary)]">
            {shortenFilename(row.filename)}
          </p>
          <p className="text-[11px] text-[var(--text-muted)] tabular-nums">
            {new Date(row.created_at).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
            {row.has_summary ? (
              <span className="ml-1.5 inline-flex h-4 items-center rounded-full bg-[color-mix(in_srgb,var(--accent-primary)_15%,transparent)] px-1.5 text-[9px] font-medium uppercase tracking-[0.5px] text-[var(--accent-primary)]">
                Summary
              </span>
            ) : (
              <span className="ml-1.5 inline-flex h-4 items-center rounded-full bg-[var(--bg-elevated)] px-1.5 text-[9px] font-medium uppercase tracking-[0.5px] text-[var(--text-muted)]">
                Pending
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              void handleToggle()
            }}
            disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-default)] bg-transparent px-2.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : null}
            {open ? 'Hide' : 'View'}
          </button>
          <button
            type="button"
            onClick={() => {
              void handleCopy()
            }}
            disabled={loading}
            aria-label="Copy transcript"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-default)] bg-transparent text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-3 space-y-4">
          {error && (
            <p className="rounded-md bg-[color-mix(in_srgb,var(--priority-critical)_8%,transparent)] p-3 text-[13px] text-[var(--priority-critical)]">
              {error}
            </p>
          )}
          {loading && !detail && (
            <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 text-[13px] text-[var(--text-muted)]">
              Loading transcript…
            </p>
          )}
          {detail && (
            <>
              {detail.summary && (
                <section>
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
                    Summary
                  </p>
                  <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
                    <AtlasMarkdown content={detail.summary} />
                  </div>
                </section>
              )}
              {detail.tasks && detail.tasks.length > 0 && (
                <section>
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
                    Extracted Tasks ({detail.tasks.length})
                  </p>
                  <ul className="space-y-1">
                    {detail.tasks.map((t) => (
                      <li
                        key={t.id}
                        className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[13px]"
                      >
                        <p className="text-[var(--text-primary)]">
                          {t.description}
                        </p>
                        {t.assignee && (
                          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                            Assignee: {t.assignee}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <section>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
                  Transcript
                </p>
                <div className="max-h-[400px] overflow-y-auto rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 text-[13px] leading-relaxed text-[var(--text-primary)]">
                  {detail.content.trim().length === 0 ? (
                    <p className="text-[var(--text-muted)]">
                      This transcript is empty — no speech was detected.
                    </p>
                  ) : (
                    <TranscriptBody text={detail.content} />
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * Renders a transcript body with speaker attribution. A line starting
 * with "Name: …" gets the name bolded; everything else passes through
 * as plain text with newlines preserved.
 */
function TranscriptBody({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <div className="whitespace-pre-wrap break-words font-mono text-[12px]">
      {lines.map((line, i) => {
        const m = /^([A-Za-z][A-Za-z0-9 ._'-]{0,40}?):\s+(.*)$/.exec(line)
        if (m) {
          return (
            <div key={i}>
              <span className="font-bold text-[var(--text-primary)]">{m[1]}:</span>{' '}
              <span className="text-[var(--text-secondary)]">{m[2]}</span>
            </div>
          )
        }
        if (line.trim() === '') {
          return <div key={i} className="h-3" aria-hidden="true" />
        }
        return (
          <div key={i} className="text-[var(--text-secondary)]">
            {line}
          </div>
        )
      })}
    </div>
  )
}

// ── Misc bits ──────────────────────────────────────────────────────────

function DownloadButton({ href, filename }: { href: string; filename: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      download={filename}
      aria-label={`Download ${filename}`}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-default)] bg-transparent text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
    >
      <Download className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  )
}

function InProgressBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--priority-critical)_15%,transparent)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.5px] text-[var(--priority-critical)]">
      <span className="relative inline-flex h-1.5 w-1.5">
        <span
          aria-hidden="true"
          className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--priority-critical)] opacity-75"
        />
        <span
          aria-hidden="true"
          className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--priority-critical)]"
        />
      </span>
      Recording in progress
    </span>
  )
}

function LoadingState() {
  return (
    <div className="rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 px-6 py-8 text-center">
      <Loader2 className="mx-auto h-5 w-5 animate-spin text-[var(--text-muted)]" aria-hidden="true" />
      <p className="mt-2 text-sm text-[var(--text-secondary)]">Loading recordings…</p>
    </div>
  )
}

function EmptyState({ filterDate }: { filterDate?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 px-6 py-8 text-center">
      <p className="text-sm text-[var(--text-secondary)]">
        {filterDate
          ? 'No recordings for this date.'
          : 'No recordings found.'}
      </p>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        Recordings appear here after ZoomBot captures a meeting.
      </p>
    </div>
  )
}

function UnconfiguredState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 px-6 py-8 text-center">
      <SettingsIcon className="h-8 w-8 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden="true" />
      <p className="text-sm text-[var(--text-secondary)]">
        Meeting recordings are available when ZoomBot is configured.
      </p>
      <Link
        to="/settings"
        className="text-xs text-[var(--accent-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] rounded"
      >
        Ask your admin to set it up in Settings
      </Link>
    </div>
  )
}

function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-[color-mix(in_srgb,var(--priority-critical)_25%,var(--border-subtle))] bg-[color-mix(in_srgb,var(--priority-critical)_8%,transparent)] px-4 py-4">
      <p className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-primary)]">
        <AlertTriangle className="h-4 w-4 text-[var(--priority-critical)]" aria-hidden="true" />
        Could not load recordings
      </p>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">{error}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 inline-flex h-8 items-center justify-center rounded-md border border-[var(--border-default)] bg-transparent px-3 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
      >
        Retry
      </button>
    </div>
  )
}

// ── Internals ──────────────────────────────────────────────────────────

function buildInProgressSet(activeBots: ZoomBot[]): Set<string> {
  const s = new Set<string>()
  for (const b of activeBots) {
    if (b.recordingFile) s.add(b.recordingFile)
  }
  return s
}

/**
 * Helper exported for callers (the meeting list / detail page) that
 * need to know which dates have recordings — drives the "Recordings
 * available" badge.
 */
export function buildRecordingDateSet(
  recordings: ZoomRecording[] | null,
): Set<string> {
  const out = new Set<string>()
  if (!recordings) return out
  for (const r of recordings) {
    if (r.size === 0) continue
    const d =
      extractDateFromRecording(r.name ?? '') ??
      extractDateFromRecording(r.path ?? '')
    if (d) out.add(d)
  }
  return out
}

function extractDateFromRecording(s: string): string | null {
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (!m) return null
  return `${m[1]}-${m[2]?.padStart(2, '0')}-${m[3]?.padStart(2, '0')}`
}

/**
 * Pick the best YYYY-MM-DD for a transcript-store row. Prefers the
 * server-side `meeting_date` if present, otherwise falls back to
 * parsing the filename, then to the calendar day of `created_at`.
 */
function pickTranscriptDate(row: TranscriptListItem): string | null {
  // The list row doesn't currently expose `meeting_date`, so we key
  // off the filename or the ingest timestamp. When callers hydrate
  // the detail they can re-key by the more accurate `meeting_date`.
  const fromFilename = extractDateFromRecording(row.filename)
  if (fromFilename) return fromFilename
  const fromCreated = row.created_at.split('T')[0]
  return fromCreated || null
}
