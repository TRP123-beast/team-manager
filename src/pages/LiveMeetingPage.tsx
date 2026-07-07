/**
 * Live ZoomBot meeting view.
 *
 * Two-column on desktop (transcript + info panel), single-column with a
 * bottom drawer on mobile. The page holds the WebSocket open via
 * `useZoomBotConnection` for as long as it's mounted; navigating away
 * releases the connection (the global meeting-detection hook in Layout
 * still keeps it open if a meeting is active and the banner is showing).
 *
 * Caption rendering notes:
 *   - The provider already merges in-progress utterances in place, so
 *     each entry in `captions` is a distinct block. The grouping spec
 *     ("when the same speaker continues, update in place") happens for
 *     free — React just re-renders the entry whose text grew.
 *   - Auto-scroll only fires when the user is at the bottom. If they've
 *     scrolled up to read earlier content, we set a `paused` flag and
 *     surface a "↓ New messages" pill to jump back.
 *   - Speaker names get a deterministic color from the project palette
 *     (FNV-1a hash, same algorithm the project mapper uses).
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import {
  ArrowDown,
  ChevronDown,
  ChevronUp,
  Loader2,
  Users,
} from 'lucide-react'
import { Breadcrumb } from '@/components/Breadcrumb'
import { toast } from 'sonner'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/data/auth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useZoomBot } from '@/hooks/useZoomBot'
import { useZoomBotConnection } from '@/hooks/useZoomBotConnection'
import { cn } from '@/lib/utils'
import { BotActionButton, StopAllButton } from '@/components/zoombot/BotControls'
import type { LiveCaption, ZoomBot } from '@/services/zoombot-types'
import { fetchTranscripts } from '@/services/transcript-store-api'
import { isTranscriptStoreConfigured } from '@/services/transcript-store-config'

const ALL_ROOMS = '__all__'

/** Same 8-color palette the project mapper uses. */
const SPEAKER_PALETTE = [
  '#3B82F6',
  '#22C55E',
  '#F59E0B',
  '#EF4444',
  '#A855F7',
  '#EC4899',
  '#14B8A6',
  '#F97316',
] as const

export default function LiveMeetingPage() {
  useDocumentTitle('Live Meeting')
  useZoomBotConnection()
  const navigate = useNavigate()
  const {
    isConnected,
    isReconnecting,
    botState,
    activeBots,
    captions,
    captionsByRoom,
    audioStats,
    hasActiveMeeting,
  } = useZoomBot()

  // ── Room tabs ──────────────────────────────────────────────────────
  const rooms = useMemo(() => {
    return Array.from(captionsByRoom.keys()).sort()
  }, [captionsByRoom])
  const [selectedRoom, setSelectedRoom] = useState<string>(ALL_ROOMS)
  // If the selected room disappears (rare — caption pruning), fall back.
  useEffect(() => {
    if (selectedRoom !== ALL_ROOMS && !rooms.includes(selectedRoom)) {
      setSelectedRoom(ALL_ROOMS)
    }
  }, [rooms, selectedRoom])

  const visibleCaptions = useMemo(() => {
    if (selectedRoom === ALL_ROOMS) return captions
    return captionsByRoom.get(selectedRoom) ?? []
  }, [captions, captionsByRoom, selectedRoom])

  // ── Meeting-ended state ────────────────────────────────────────────
  // Detect the false-edge from "meeting active" to "meeting ended" so
  // we can show the closing banner. We DON'T clear captions; the page
  // stays viewable as a frozen transcript until the user navigates.
  const wasActiveRef = useRef(hasActiveMeeting)
  const [ended, setEnded] = useState(false)
  useEffect(() => {
    if (wasActiveRef.current && !hasActiveMeeting && captions.length > 0) {
      setEnded(true)
    }
    if (hasActiveMeeting) setEnded(false)
    wasActiveRef.current = hasActiveMeeting
  }, [hasActiveMeeting, captions.length])

  // 5-second-later toast after the meeting ends.
  useEffect(() => {
    if (!ended) return
    const t = window.setTimeout(() => {
      toast.info(
        'Transcript and summary will be available shortly in the Meetings tab.',
      )
    }, 5000)
    return () => window.clearTimeout(t)
  }, [ended])

  // Poll the Transcript Store every 30 s after the meeting ends
  // until a summary lands. Only surfaces the toast once — the ref
  // guards against fire-again on later ticks and against the polling
  // running past the point where the user has already navigated
  // away.
  const endedAtRef = useRef<number | null>(null)
  const summaryToastFiredRef = useRef<boolean>(false)
  useEffect(() => {
    if (!ended) {
      endedAtRef.current = null
      summaryToastFiredRef.current = false
      return
    }
    if (!isTranscriptStoreConfigured()) return
    if (endedAtRef.current === null) endedAtRef.current = Date.now()

    const poll = async () => {
      if (summaryToastFiredRef.current) return
      try {
        const { items } = await fetchTranscripts(1, 0)
        const latest = items[0]
        if (!latest || !latest.has_summary) return
        const summarisedAt = Date.parse(latest.created_at)
        // Only consider transcripts ingested after this meeting ended.
        if (
          Number.isFinite(summarisedAt) &&
          endedAtRef.current !== null &&
          summarisedAt >= endedAtRef.current
        ) {
          summaryToastFiredRef.current = true
          toast.success('Meeting summary ready.', {
            action: {
              label: 'View',
              onClick: () => navigate('/meetings'),
            },
            duration: 10_000,
          })
        }
      } catch {
        // Silent — a failed poll is fine; the next tick will retry.
      }
    }

    const id = window.setInterval(() => {
      void poll()
    }, 30_000)
    return () => window.clearInterval(id)
  }, [ended, navigate])

  // ── Meeting start time / duration ──────────────────────────────────
  // We pin the start at the first caption's timestamp once it arrives,
  // and tick every second so the duration counter stays live without
  // depending on render cadence.
  const [startedAt, setStartedAt] = useState<number | null>(null)
  useEffect(() => {
    if (startedAt !== null) return
    const first = captions[0]
    if (first) setStartedAt(first.timestamp)
  }, [captions, startedAt])
  useEffect(() => {
    if (!hasActiveMeeting && captions.length === 0) {
      setStartedAt(null)
    }
  }, [hasActiveMeeting, captions.length])

  const [, setTick] = useState(0)
  useEffect(() => {
    if (!hasActiveMeeting) return
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [hasActiveMeeting])

  const sessionShort = botState?.sessionId
    ? botState.sessionId.slice(0, 8)
    : ''

  return (
    <div className="-mx-4 -mt-6 flex min-h-[calc(100vh-3.5rem)] flex-col md:-mx-6 md:-mt-8 lg:-mx-8">
      {/* Page header */}
      <header className="border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3 md:px-6">
        <div className="mb-2">
          <Breadcrumb
            items={[
              { label: 'Meetings', path: '/meetings' },
              { label: 'Live' },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="inline-flex items-center gap-2 text-xl font-semibold text-[var(--text-primary)]">
              <span className="relative inline-flex h-2.5 w-2.5">
                <span
                  aria-hidden="true"
                  className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--priority-critical)] opacity-75"
                />
                <span
                  aria-hidden="true"
                  className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--priority-critical)]"
                />
              </span>
              Live Meeting
            </h1>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {sessionShort && (
              <span
                className="font-mono text-[var(--text-muted)]"
                title={botState?.sessionId ?? ''}
              >
                Session #{sessionShort}
              </span>
            )}
            <ConnectionPill connected={isConnected} reconnecting={isReconnecting} />
          </div>
        </div>
      </header>

      <div className="flex flex-1 flex-col md:flex-row">
        {/* Transcript — left column on desktop, full width on mobile */}
        <section
          aria-label="Live transcript"
          className="flex min-w-0 flex-1 flex-col md:basis-[65%] md:border-r md:border-[var(--border-subtle)]"
        >
          {ended && (
            <MeetingEndedBanner
              capturesCount={captions.length}
              onViewMeetings={() => navigate('/meetings')}
            />
          )}
          {rooms.length > 1 && (
            <RoomTabs
              rooms={rooms}
              selected={selectedRoom}
              onSelect={setSelectedRoom}
              captionsByRoom={captionsByRoom}
            />
          )}
          <TranscriptFeed
            captions={visibleCaptions}
            showRoomBadge={selectedRoom === ALL_ROOMS}
            isActiveMeeting={hasActiveMeeting && !ended}
          />
        </section>

        {/* Info panel — right column on desktop, bottom drawer on mobile */}
        <InfoPanel
          captions={captions}
          rooms={rooms}
          captionsByRoom={captionsByRoom}
          activeBots={activeBots}
          allBots={botState?.bots ?? []}
          audioStats={audioStats}
          startedAt={startedAt}
        />
      </div>
    </div>
  )
}

// ── Connection pill ────────────────────────────────────────────────────

function ConnectionPill({
  connected,
  reconnecting,
}: {
  connected: boolean
  reconnecting: boolean
}) {
  const label = connected
    ? 'Connected'
    : reconnecting
      ? 'Reconnecting'
      : 'Offline'
  const dotClass = connected
    ? 'bg-[var(--status-done)]'
    : reconnecting
      ? 'bg-[var(--priority-medium)]'
      : 'bg-[var(--text-muted)]'
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)]">
      {reconnecting && (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
      )}
      <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', dotClass)} />
      {label}
    </span>
  )
}

// ── Meeting ended banner ───────────────────────────────────────────────

function MeetingEndedBanner({
  capturesCount,
  onViewMeetings,
}: {
  capturesCount: number
  onViewMeetings: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--accent-primary)_8%,var(--bg-surface))] px-4 py-3 md:px-6">
      <div className="min-w-0">
        <p className="text-sm text-[var(--text-primary)]">
          Meeting ended.{' '}
          <span className="text-[var(--text-secondary)]">
            {capturesCount} caption{capturesCount === 1 ? '' : 's'} captured.
          </span>
        </p>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          Transcript and summary will appear in the Meetings tab in a few
          seconds.
        </p>
      </div>
      <button
        type="button"
        onClick={onViewMeetings}
        className="inline-flex h-8 items-center justify-center rounded-md bg-[var(--accent-primary)] px-3 text-xs font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
      >
        View Meetings
      </button>
    </div>
  )
}

// ── Room tabs ──────────────────────────────────────────────────────────

function RoomTabs({
  rooms,
  selected,
  onSelect,
  captionsByRoom,
}: {
  rooms: string[]
  selected: string
  onSelect: (room: string) => void
  captionsByRoom: Map<string, LiveCaption[]>
}) {
  const all = rooms.reduce(
    (sum, r) => sum + (captionsByRoom.get(r)?.length ?? 0),
    0,
  )
  return (
    <div
      role="tablist"
      aria-label="Filter transcript by room"
      className="flex flex-wrap gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 md:px-5"
    >
      <RoomTab
        active={selected === ALL_ROOMS}
        onClick={() => onSelect(ALL_ROOMS)}
        label="All rooms"
        count={all}
      />
      {rooms.map((r) => (
        <RoomTab
          key={r}
          active={selected === r}
          onClick={() => onSelect(r)}
          label={r}
          count={captionsByRoom.get(r)?.length ?? 0}
        />
      ))}
    </div>
  )
}

function RoomTab({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
        active
          ? 'border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)] text-[var(--accent-primary)]'
          : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-default)] hover:text-[var(--text-primary)]',
      )}
    >
      {label}
      <span className="text-[10px] tabular-nums opacity-80">{count}</span>
    </button>
  )
}

// ── Transcript feed ────────────────────────────────────────────────────

function TranscriptFeed({
  captions,
  showRoomBadge,
  isActiveMeeting,
}: {
  captions: LiveCaption[]
  showRoomBadge: boolean
  isActiveMeeting: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState<boolean>(true)
  const [unread, setUnread] = useState<number>(0)
  const prevLenRef = useRef<number>(captions.length)

  // Auto-scroll on captions change (new or extended).
  useEffect(() => {
    if (!autoScroll) return
    const el = containerRef.current
    if (!el) return
    // rAF so the new DOM has measured before we scroll.
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [captions, autoScroll])

  // Track unread additions (only when array length grew AND user is
  // away from the bottom).
  useEffect(() => {
    const grew = captions.length > prevLenRef.current
    const grewBy = captions.length - prevLenRef.current
    prevLenRef.current = captions.length
    if (grew && !autoScroll) {
      setUnread((n) => n + grewBy)
    }
  }, [captions.length, autoScroll])

  // Reset unread when re-enabling auto-scroll (e.g., user clicked the pill).
  useEffect(() => {
    if (autoScroll) setUnread(0)
  }, [autoScroll])

  const handleScroll = () => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    setAutoScroll(atBottom)
  }

  const handleJumpToBottom = () => {
    setAutoScroll(true)
    requestAnimationFrame(() => {
      const el = containerRef.current
      if (!el) return
      el.scrollTop = el.scrollHeight
    })
  }

  if (captions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="text-center">
          <div
            className={cn(
              'mx-auto inline-flex h-3 w-3 rounded-full bg-[var(--accent-primary)]',
              isActiveMeeting && 'animate-pulse',
            )}
            aria-hidden="true"
          />
          <p className="mt-3 text-sm font-medium text-[var(--text-primary)]">
            {isActiveMeeting ? 'Waiting for captions…' : 'No captions yet'}
          </p>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            The transcript will appear here as people speak.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 md:px-6 md:py-4"
      >
        <ol className="flex flex-col gap-3">
          {captions.map((c, i) => (
            <CaptionBlock
              key={`${c.roomName}-${c.speaker}-${i}`}
              caption={c}
              showRoomBadge={showRoomBadge}
            />
          ))}
        </ol>
      </div>
      {!autoScroll && unread > 0 && (
        <button
          type="button"
          onClick={handleJumpToBottom}
          className="absolute bottom-4 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-medium text-[var(--text-inverse)] shadow-[0_2px_8px_rgba(0,0,0,0.25)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        >
          <ArrowDown className="h-3 w-3" aria-hidden="true" />
          {unread} new message{unread === 1 ? '' : 's'}
        </button>
      )}
    </div>
  )
}

function CaptionBlock({
  caption,
  showRoomBadge,
}: {
  caption: LiveCaption
  showRoomBadge: boolean
}) {
  const color = pickSpeakerColor(caption.speaker)
  return (
    <li
      className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 md:p-4"
      style={{
        animation: 'captionSlideIn 150ms ease-out',
        borderLeft: `2px solid ${color}`,
      }}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span
            className="text-sm font-semibold"
            style={{ color }}
            title={caption.speaker}
          >
            {caption.speaker}
          </span>
          {showRoomBadge && (
            <span className="rounded-full bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.5px] text-[var(--text-secondary)]">
              {caption.roomName}
            </span>
          )}
        </div>
        <span
          className="text-[10px] text-[var(--text-muted)] tabular-nums"
          title={new Date(caption.timestamp).toLocaleString()}
        >
          {formatClockTime(caption.timestamp)}
        </span>
      </header>
      <p className="mt-1 text-sm leading-relaxed text-[var(--text-primary)]">
        {caption.text}
      </p>
    </li>
  )
}

// ── Info panel ─────────────────────────────────────────────────────────

function InfoPanel({
  captions,
  rooms,
  captionsByRoom,
  activeBots,
  allBots,
  audioStats,
  startedAt,
}: {
  captions: LiveCaption[]
  rooms: string[]
  captionsByRoom: Map<string, LiveCaption[]>
  activeBots: ZoomBot[]
  allBots: ZoomBot[]
  audioStats: Record<number, number>
  startedAt: number | null
}) {
  const [mobileOpen, setMobileOpen] = useState<boolean>(false)
  const stats = useMemo(() => computeStats(captions), [captions])
  const duration = useDurationLabel(startedAt)

  const panelBody = (
    <div className="flex flex-col gap-4 p-4 md:p-5">
      <SessionInfoCard duration={duration} botCount={activeBots.length} />
      <BotsSection bots={allBots} audioStats={audioStats} />
      {rooms.length > 0 && (
        <RoomsSection rooms={rooms} captionsByRoom={captionsByRoom} />
      )}
      <QuickStatsCard stats={stats} />
    </div>
  )

  return (
    <>
      {/* Desktop: side panel */}
      <aside className="hidden min-w-0 bg-[var(--bg-base)] md:flex md:basis-[35%] md:flex-col md:overflow-y-auto">
        {panelBody}
      </aside>

      {/* Mobile: bottom drawer */}
      <div
        className={cn(
          'fixed inset-x-0 bottom-0 z-30 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[0_-4px_16px_rgba(0,0,0,0.25)] transition-[max-height] duration-200 md:hidden',
          mobileOpen ? 'max-h-[70vh]' : 'max-h-[64px]',
        )}
      >
        <button
          type="button"
          onClick={() => setMobileOpen((o) => !o)}
          className="flex h-16 w-full items-center gap-3 px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          aria-expanded={mobileOpen}
        >
          <Users className="h-4 w-4 text-[var(--text-muted)]" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
              Meeting info
            </p>
            <p className="truncate text-[11px] text-[var(--text-muted)]">
              {activeBots.length} bot{activeBots.length === 1 ? '' : 's'} ·{' '}
              {duration} elapsed
            </p>
          </div>
          {mobileOpen ? (
            <ChevronDown
              className="h-4 w-4 text-[var(--text-secondary)]"
              aria-hidden="true"
            />
          ) : (
            <ChevronUp
              className="h-4 w-4 text-[var(--text-secondary)]"
              aria-hidden="true"
            />
          )}
        </button>
        <div className="max-h-[calc(70vh-64px)] overflow-y-auto">
          {mobileOpen && panelBody}
        </div>
      </div>

      {/* Spacer so the mobile transcript doesn't sit underneath the
          collapsed drawer */}
      <div className="h-16 md:hidden" aria-hidden="true" />
    </>
  )
}

function SessionInfoCard({
  duration,
  botCount,
}: {
  duration: string
  botCount: number
}) {
  return (
    <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
        Session
      </h2>
      <dl className="mt-2 space-y-1 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-[var(--text-secondary)]">Duration</dt>
          <dd className="font-mono tabular-nums text-[var(--text-primary)]">
            {duration}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-[var(--text-secondary)]">Active bots</dt>
          <dd className="font-mono tabular-nums text-[var(--text-primary)]">
            {botCount}
          </dd>
        </div>
      </dl>
    </section>
  )
}

function BotsSection({
  bots,
  audioStats,
}: {
  bots: ZoomBot[]
  audioStats: Record<number, number>
}) {
  const { isPM } = useAuth()
  const activeCount = bots.filter(
    (b) => b.status === 'active' || b.status === 'joining',
  ).length

  if (bots.length === 0) {
    return (
      <section className="rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-3 text-center">
        <p className="text-xs text-[var(--text-muted)]">No bots deployed.</p>
      </section>
    )
  }
  return (
    <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
        Bots
      </h2>
      <ul className="mt-2 space-y-2">
        {bots.map((b) => (
          <BotCard
            key={b.id}
            bot={b}
            audioBytes={audioStats[b.id] ?? 0}
            canControl={isPM}
          />
        ))}
      </ul>
      {isPM && (
        <div className="mt-3 flex justify-end">
          <StopAllButton canControl={isPM} hasActive={activeCount > 0} />
        </div>
      )}
    </section>
  )
}

function BotCard({
  bot,
  audioBytes,
  canControl,
}: {
  bot: ZoomBot
  audioBytes: number
  canControl: boolean
}) {
  const audioActive = audioBytes > 0 && bot.status === 'active'
  return (
    <li className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--text-primary)]">
            {bot.name}
          </p>
          <p className="truncate text-[11px] text-[var(--text-secondary)]">
            → {bot.target}
          </p>
        </div>
        <StatusPill status={bot.status} />
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <AudioActivityVisualizer active={audioActive} />
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[var(--text-secondary)] tabular-nums">
            {formatBytes(bot.dataSize)}
          </span>
          <BotActionButton bot={bot} canControl={canControl} />
        </div>
      </div>
    </li>
  )
}

function StatusPill({ status }: { status: ZoomBot['status'] }) {
  const tone: Record<ZoomBot['status'], string> = {
    configured: 'bg-[var(--bg-elevated)] text-[var(--text-muted)]',
    idle: 'bg-[var(--bg-elevated)] text-[var(--text-muted)]',
    joining: 'bg-[color-mix(in_srgb,var(--accent-primary)_15%,transparent)] text-[var(--accent-primary)]',
    active: 'bg-[color-mix(in_srgb,var(--status-done)_15%,transparent)] text-[var(--status-done)]',
    stopping: 'bg-[color-mix(in_srgb,var(--priority-medium)_15%,transparent)] text-[var(--priority-medium)]',
    stopped: 'bg-[var(--bg-elevated)] text-[var(--text-muted)]',
    error: 'bg-[color-mix(in_srgb,var(--priority-critical)_15%,transparent)] text-[var(--priority-critical)]',
  }
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[10px] font-medium uppercase tracking-[0.5px]',
        tone[status],
      )}
    >
      {status}
    </span>
  )
}

function AudioActivityVisualizer({ active }: { active: boolean }) {
  // 4 bars rendered side-by-side. When `active`, the audio-bar-active
  // class kicks in the bouncing keyframe (defined in index.css) with
  // staggered delays per bar.
  return (
    <div
      className="flex items-end gap-0.5"
      aria-label={active ? 'Audio active' : 'No audio'}
      aria-live="polite"
    >
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          className={cn(
            'inline-block w-1 rounded-sm bg-[var(--accent-primary)] transition-transform duration-150',
            active
              ? `audio-bar-active audio-bar-${n} opacity-100`
              : 'opacity-50 scale-y-[0.3] origin-bottom',
          )}
          style={{ height: '14px' } as CSSProperties}
        />
      ))}
    </div>
  )
}

function RoomsSection({
  rooms,
  captionsByRoom,
}: {
  rooms: string[]
  captionsByRoom: Map<string, LiveCaption[]>
}) {
  return (
    <section>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
        Rooms
      </h2>
      <ul className="mt-2 space-y-1.5">
        {rooms.map((room) => {
          const count = captionsByRoom.get(room)?.length ?? 0
          return (
            <li
              key={room}
              className="flex items-center justify-between rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs"
            >
              <span className="truncate text-[var(--text-primary)]">{room}</span>
              <span className="text-[var(--text-muted)] tabular-nums">
                {count} caption{count === 1 ? '' : 's'}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function QuickStatsCard({
  stats,
}: {
  stats: { speakers: number; total: number; sinceLastLabel: string }
}) {
  return (
    <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
        Quick stats
      </h2>
      <dl className="mt-2 space-y-1 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-[var(--text-secondary)]">Speakers detected</dt>
          <dd className="font-mono tabular-nums text-[var(--text-primary)]">
            {stats.speakers}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-[var(--text-secondary)]">Captions received</dt>
          <dd className="font-mono tabular-nums text-[var(--text-primary)]">
            {stats.total}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-[var(--text-secondary)]">Last caption</dt>
          <dd className="text-[var(--text-primary)]">{stats.sinceLastLabel}</dd>
        </div>
      </dl>
    </section>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────

function pickSpeakerColor(name: string): string {
  if (!name) return SPEAKER_PALETTE[0]
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const idx = Math.abs(h) % SPEAKER_PALETTE.length
  return SPEAKER_PALETTE[idx] ?? SPEAKER_PALETTE[0]
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatClockTime(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Re-renders every second while `startedAt` is set, so the duration
 *  string stays current without the parent owning the tick state. */
function useDurationLabel(startedAt: number | null): string {
  const [, tick] = useState<number>(0)
  useEffect(() => {
    if (startedAt === null) return
    const id = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [startedAt])
  if (startedAt === null) return '0:00'
  return formatDuration(Date.now() - startedAt)
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function computeStats(captions: LiveCaption[]): {
  speakers: number
  total: number
  sinceLastLabel: string
} {
  const speakers = new Set<string>()
  for (const c of captions) speakers.add(c.speaker)
  const last = captions[captions.length - 1]
  const sinceLast = last ? Date.now() - last.timestamp : null
  let label = '—'
  if (sinceLast !== null) {
    if (sinceLast < 5000) label = 'just now'
    else if (sinceLast < 60_000) label = `${Math.floor(sinceLast / 1000)}s ago`
    else if (sinceLast < 3_600_000) label = `${Math.floor(sinceLast / 60_000)}m ago`
    else label = `${Math.floor(sinceLast / 3_600_000)}h ago`
  }
  return { speakers: speakers.size, total: captions.length, sinceLastLabel: label }
}
