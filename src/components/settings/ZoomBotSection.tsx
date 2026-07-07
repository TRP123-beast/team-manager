/**
 * Settings → ZoomBot / Meeting Recordings.
 *
 * Surfaces every operational signal a PM might want to check at a
 * glance: URL config, REST + WebSocket reachability, current session +
 * bots, recordings stats, and a running count of WebSocket messages
 * since the page mounted.
 *
 * Read-only mounting — this section does NOT call useZoomBotConnection.
 * It observes whatever state the rest of the app produces (the meeting-
 * detection hook in Layout, or any other live consumer). If no live
 * meeting is in progress and the user hasn't opened the live meeting
 * page, the WebSocket stays closed; the section's WS rows will reflect
 * that honestly.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Headphones,
  Loader2,
  RefreshCw,
  Save,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { Eye, EyeOff } from 'lucide-react'
import { useZoomBot } from '@/hooks/useZoomBot'
import { fetchBotState } from '@/services/zoombot-api'
import {
  getZoomBotConfig,
  isZoomBotConfigured,
  setZoomBotBaseUrl,
  setZoomBotCredentials,
} from '@/services/zoombot-config'
import { zoomBotWS } from '@/services/zoombot-websocket'
import { formatBytes } from '@/lib/recordings-grouping'
import type { ZoomBot } from '@/services/zoombot-types'
import { useAuth } from '@/data/auth'
import { ManageBotsSection } from './ManageBotsSection'
import { cn } from '@/lib/utils'

const ALL_WS_TYPES = [
  'state',
  'botStatus',
  'caption',
  'audioStats',
  'deployed',
  'botError',
  'allStopped',
  'botsUpdated',
] as const

type ConnectionStatus = 'connected' | 'unreachable' | 'unknown' | 'unconfigured'

export function ZoomBotSection() {
  const { isPM } = useAuth()
  const {
    botState,
    activeBots,
    hasActiveMeeting,
    recordings,
    recordingsLoading,
    fetchRecordings,
    isConnected: wsConnected,
    isReconnecting: wsReconnecting,
  } = useZoomBot()

  // ── URL + credentials config + connection-test state ───────────────
  const config = useMemo(() => getZoomBotConfig(), [])
  const [urlDraft, setUrlDraft] = useState<string>(config.baseUrl)
  const [savedUrl, setSavedUrl] = useState<string>(config.baseUrl)
  const [usernameDraft, setUsernameDraft] = useState<string>(config.username)
  const [passwordDraft, setPasswordDraft] = useState<string>(config.password)
  const [savedUsername, setSavedUsername] = useState<string>(config.username)
  const [savedPassword, setSavedPassword] = useState<string>(config.password)
  const [revealPassword, setRevealPassword] = useState<boolean>(false)
  const [testing, setTesting] = useState<boolean>(false)
  const [status, setStatus] = useState<ConnectionStatus>(
    isZoomBotConfigured() ? 'unknown' : 'unconfigured',
  )

  // Trigger an initial recordings fetch if nothing has loaded yet —
  // gives the stats card real numbers as soon as Settings opens.
  const requestedRecordingsRef = useRef<boolean>(false)
  useEffect(() => {
    if (!isZoomBotConfigured()) return
    if (recordings !== null) return
    if (requestedRecordingsRef.current) return
    requestedRecordingsRef.current = true
    void fetchRecordings()
  }, [recordings, fetchRecordings])

  // ── WebSocket message counter ──────────────────────────────────────
  // The singleton supports per-type listeners; we register one for each
  // known type and aggregate the count. Doesn't require modifying the
  // singleton — and any future server-side message type would simply be
  // missed by this counter, which is acceptable for a stats display.
  const [wsMessageCount, setWsMessageCount] = useState<number>(0)
  useEffect(() => {
    const unsubs: Array<() => void> = []
    for (const t of ALL_WS_TYPES) {
      unsubs.push(
        zoomBotWS.on(t, () => {
          setWsMessageCount((n) => n + 1)
        }),
      )
    }
    return () => {
      for (const u of unsubs) u()
    }
  }, [])

  // ── Recordings stats ───────────────────────────────────────────────
  const recordingsStats = useMemo(() => {
    if (!recordings) return null
    const live = recordings.filter((r) => r.size > 0)
    if (live.length === 0) return { count: 0, totalSize: 0, latestDate: null }
    let total = 0
    let latestMs = -Infinity
    let latestModified: string | null = null
    for (const r of live) {
      total += r.size
      const ms = Date.parse(r.modified ?? '')
      if (!Number.isNaN(ms) && ms > latestMs) {
        latestMs = ms
        latestModified = r.modified
      }
    }
    return { count: live.length, totalSize: total, latestDate: latestModified }
  }, [recordings])

  // ── Actions ────────────────────────────────────────────────────────
  const handleTest = async () => {
    setTesting(true)
    try {
      const state = await fetchBotState()
      const sessionShort = state.sessionId
        ? state.sessionId.slice(0, 8)
        : '(none)'
      toast.success(
        `Connected! Session: ${sessionShort}, ${state.bots.length} bot${state.bots.length === 1 ? '' : 's'} configured.`,
      )
      setStatus('connected')
    } catch (err) {
      // Surface 401 specifically — most common failure now that the
      // endpoint requires Basic Auth.
      const message = err instanceof Error ? err.message : String(err)
      const is401 = /\b401\b/.test(message)
      toast.error(
        is401
          ? 'Authentication failed. Check the username and password.'
          : `Connection failed: ${message}`,
      )
      setStatus('unreachable')
    } finally {
      setTesting(false)
    }
  }

  const handleSave = () => {
    const trimmedUrl = urlDraft.trim()
    const trimmedUsername = usernameDraft.trim()
    const trimmedPassword = passwordDraft.trim()

    // URL: empty clears the override; anything else stores it.
    if (!trimmedUrl) {
      setZoomBotBaseUrl(null)
    } else {
      setZoomBotBaseUrl(trimmedUrl)
    }
    // Credentials: same clear-vs-set semantics, applied together.
    setZoomBotCredentials(
      trimmedUsername || null,
      trimmedPassword || null,
    )
    const resolved = getZoomBotConfig()
    setSavedUrl(resolved.baseUrl)
    setSavedUsername(resolved.username)
    setSavedPassword(resolved.password)
    setStatus(isZoomBotConfigured() ? 'unknown' : 'unconfigured')
    toast.success('ZoomBot config saved.')
    // The existing WebSocket (if any) won't pick up the new URL /
    // credentials until its next reconnect. Tear it down so the
    // meeting-detection poller reopens with the fresh values.
    try {
      zoomBotWS.disconnect()
    } catch {
      // ignored
    }
  }

  const handleRefreshRecordings = () => {
    requestedRecordingsRef.current = true
    void fetchRecordings()
  }

  // Status badge tone is derived from a small priority chain so a
  // successful test outranks "unconfigured" (which only fires when we
  // genuinely don't have all three of URL / username / password —
  // including the hardcoded URL fallback in zoombot-config.ts).
  const dirty =
    urlDraft.trim() !== savedUrl ||
    usernameDraft.trim() !== savedUsername ||
    passwordDraft.trim() !== savedPassword

  return (
    <section aria-labelledby="zoombot-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id="zoombot-heading"
          className="inline-flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]"
        >
          <Headphones className="h-4 w-4" aria-hidden="true" />
          ZoomBot — Live Meetings & Recordings
        </h2>
        <StatusBadge status={status} />
      </div>

      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        Audio, video, live captions, and transcripts/summaries all come
        from <code className="font-mono">bots.caimbrian.ai</code> and
        share one set of HTTP Basic Auth credentials. The Transcripts
        section below reports what's available on{' '}
        <code className="font-mono">/api/transcripts</code>.
      </p>

      {/* ── Connection config ─────────────────────────────────────── */}
      <div className="mt-5 space-y-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 md:p-5">
        <div>
          <label
            htmlFor="zoombot-url"
            className="block text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]"
          >
            API URL
          </label>
          <input
            id="zoombot-url"
            type="text"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="https://bots.caimbrian.ai"
            spellCheck={false}
            autoComplete="off"
            className="mt-1 h-9 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-focus)]"
          />
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            Defaults to <code className="font-mono">VITE_ZOOMBOT_URL</code> /
            the hardcoded fallback. Saving stores a per-browser override.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label
              htmlFor="zoombot-username"
              className="block text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]"
            >
              Username
            </label>
            <input
              id="zoombot-username"
              type="text"
              value={usernameDraft}
              onChange={(e) => setUsernameDraft(e.target.value)}
              placeholder="Basic Auth username"
              spellCheck={false}
              autoComplete="username"
              className="mt-1 h-9 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-focus)]"
            />
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
              Falls back to{' '}
              <code className="font-mono">VITE_ZOOMBOT_USERNAME</code>.
            </p>
          </div>

          <div>
            <label
              htmlFor="zoombot-password"
              className="block text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]"
            >
              Password
            </label>
            <div className="relative mt-1">
              <input
                id="zoombot-password"
                type={revealPassword ? 'text' : 'password'}
                value={passwordDraft}
                onChange={(e) => setPasswordDraft(e.target.value)}
                placeholder="Basic Auth password"
                spellCheck={false}
                autoComplete="current-password"
                className="h-9 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] pl-3 pr-10 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-focus)]"
              />
              <button
                type="button"
                onClick={() => setRevealPassword((r) => !r)}
                aria-label={revealPassword ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 inline-flex w-9 items-center justify-center rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
              >
                {revealPassword ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
              Falls back to{' '}
              <code className="font-mono">VITE_ZOOMBOT_PASSWORD</code>. Basic
              Auth secrets in localStorage are readable by any JS on the page
              — env vars are preferred for production.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-4 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            Save
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-[var(--border-default)] bg-transparent px-4 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {testing && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            )}
            Test Connection
          </button>
        </div>
      </div>

      {/* ── Live session state ──────────────────────────────────── */}
      <div className="mt-4 space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 md:p-5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
          Current session
        </h3>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm md:grid-cols-2">
          <Row
            label="Session ID"
            value={
              botState?.sessionId ? (
                <code className="font-mono text-[12px] text-[var(--text-primary)]">
                  {botState.sessionId.slice(0, 16)}
                  {botState.sessionId.length > 16 ? '…' : ''}
                </code>
              ) : (
                <span className="text-[var(--text-muted)]">—</span>
              )
            }
          />
          <Row
            label="Active meeting"
            value={
              hasActiveMeeting ? (
                <span className="inline-flex items-center gap-1 text-[var(--status-done)]">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Yes — {activeBots.length} bot
                  {activeBots.length === 1 ? '' : 's'}
                </span>
              ) : (
                <span className="text-[var(--text-muted)]">No</span>
              )
            }
          />
        </dl>
        <BotsList bots={botState?.bots ?? []} />
      </div>

      {/* ── Recordings stats ────────────────────────────────────── */}
      <div className="mt-4 space-y-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
            Recordings
          </h3>
          <button
            type="button"
            onClick={handleRefreshRecordings}
            disabled={recordingsLoading}
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-[var(--border-default)] bg-transparent px-2.5 text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {recordingsLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
            )}
            Refresh recordings
          </button>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm md:grid-cols-3">
          <Row
            label="Total recordings"
            value={
              recordingsStats === null ? (
                <span className="text-[var(--text-muted)]">—</span>
              ) : (
                <span className="font-mono tabular-nums text-[var(--text-primary)]">
                  {recordingsStats.count} file
                  {recordingsStats.count === 1 ? '' : 's'}
                </span>
              )
            }
          />
          <Row
            label="Total size"
            value={
              recordingsStats === null ? (
                <span className="text-[var(--text-muted)]">—</span>
              ) : (
                <span className="font-mono tabular-nums text-[var(--text-primary)]">
                  {formatBytes(recordingsStats.totalSize)}
                </span>
              )
            }
          />
          <Row
            label="Latest recording"
            value={
              recordingsStats?.latestDate ? (
                <span className="text-[var(--text-primary)]">
                  {formatLatestDate(recordingsStats.latestDate)}
                </span>
              ) : (
                <span className="text-[var(--text-muted)]">—</span>
              )
            }
          />
        </dl>
      </div>

      {/* ── WebSocket status ────────────────────────────────────── */}
      <div className="mt-4 space-y-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 md:p-5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
          WebSocket
        </h3>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm md:grid-cols-2">
          <Row
            label="Connection"
            value={
              <WsStatusLabel connected={wsConnected} reconnecting={wsReconnecting} />
            }
          />
          <Row
            label="Messages received"
            value={
              <span className="font-mono tabular-nums text-[var(--text-primary)]">
                {wsMessageCount}
              </span>
            }
          />
        </dl>
        <p className="text-[11px] text-[var(--text-muted)]">
          The socket only opens when a live meeting is detected or you open
          the Live Meeting page. Messages count resets on full page reload.
        </p>
      </div>

      {/* ── Manage bots (PM-only write surface) ──────────────────── */}
      {isPM && <ManageBotsSection />}

      {/* ── Info copy ────────────────────────────────────────────── */}
      <div className="mt-4 rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-4">
        <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
          ZoomBot captures audio, video, screen shares, and live
          transcriptions from Zoom meetings. Recordings appear in the
          Meetings tab of each project. Live transcription is available
          during active meetings via the banner at the top of the app.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">
          The API is currently open access — all team members can view
          recordings and live transcriptions. Authentication will be added
          in a future update.
        </p>
      </div>
    </section>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ConnectionStatus }) {
  const tone = status === 'connected'
    ? 'bg-[var(--status-done)]'
    : status === 'unreachable'
      ? 'bg-[var(--priority-critical)]'
      : 'bg-[var(--text-muted)]'
  const label =
    status === 'connected'
      ? 'Connected'
      : status === 'unreachable'
        ? 'Unreachable'
        : status === 'unconfigured'
          ? 'Not configured'
          : 'Unknown'
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)]">
      <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', tone)} />
      {label}
    </span>
  )
}

function WsStatusLabel({
  connected,
  reconnecting,
}: {
  connected: boolean
  reconnecting: boolean
}) {
  if (connected) {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--status-done)]">
        <Wifi className="h-3.5 w-3.5" aria-hidden="true" />
        Connected
      </span>
    )
  }
  if (reconnecting) {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--priority-medium)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Reconnecting
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[var(--text-muted)]">
      <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
      Disconnected
    </span>
  )
}

function BotsList({ bots }: { bots: ZoomBot[] }) {
  if (bots.length === 0) {
    return (
      <p className="text-xs italic text-[var(--text-muted)]">No bots deployed.</p>
    )
  }
  return (
    <ul className="space-y-1.5">
      {bots.map((b) => (
        <li
          key={b.id}
          className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/30 px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-[var(--text-primary)]">
              {b.name}
            </p>
            <p className="truncate text-[11px] text-[var(--text-muted)]">
              → {b.target}
            </p>
          </div>
          <BotStatusPill status={b.status} />
        </li>
      ))}
    </ul>
  )
}

function BotStatusPill({ status }: { status: ZoomBot['status'] }) {
  const tone: Record<ZoomBot['status'], string> = {
    configured: 'bg-[var(--bg-elevated)] text-[var(--text-muted)]',
    idle: 'bg-[var(--bg-elevated)] text-[var(--text-muted)]',
    joining:
      'bg-[color-mix(in_srgb,var(--accent-primary)_15%,transparent)] text-[var(--accent-primary)]',
    active:
      'bg-[color-mix(in_srgb,var(--status-done)_15%,transparent)] text-[var(--status-done)]',
    stopping:
      'bg-[color-mix(in_srgb,var(--priority-medium)_15%,transparent)] text-[var(--priority-medium)]',
    stopped: 'bg-[var(--bg-elevated)] text-[var(--text-muted)]',
    error:
      'bg-[color-mix(in_srgb,var(--priority-critical)_15%,transparent)] text-[var(--priority-critical)]',
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

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[var(--text-secondary)]">{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatLatestDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Suppress unused-import lint hits when we don't end up using AlertTriangle
// and XCircle (they're imported for status-card variants we may add later).
void AlertTriangle
void XCircle
