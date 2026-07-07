import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useData } from '@/data/store'
import { isAtlasConfigured } from '@/services/atlas/config'
import {
  getRefreshTelemetry,
  hasRefreshTokenOverride,
} from '@/services/google-sheets-auth'
import { isGoogleSheetsConfigured } from '@/services/google-sheets-config'
import { isTranscriptStoreConfigured } from '@/services/transcript-store-config'
import { cn } from '@/lib/utils'

/**
 * Small live/demo/sync-error pill next to the workspace name. Conveys the
 * data source at a glance and lets the user jump straight to Settings →
 * Atlas API Connection when a sync error needs attention.
 */
export function DataSourceBadge() {
  const navigate = useNavigate()
  const {
    dataSource,
    syncError,
    isRefreshing,
    lastSynced,
    projects,
    tasks,
    sheetsConnected,
    projectDataSources,
  } = useData()

  const atlasActive = dataSource === 'atlas'
  const sheetsActive = sheetsConnected
  const live = atlasActive || sheetsActive || dataSource === 'google-sheets'

  // Sheets-side auth-error and token-rotation are not part of the
  // store's reactive state — read them via a tiny polling effect so the
  // badge picks up changes within ~3s. Cheap; only ticks when mounted.
  const [authTick, setAuthTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setAuthTick((n) => n + 1), 3000)
    return () => window.clearInterval(id)
  }, [])
  const sheetsAuthError = useMemo(() => {
    void authTick
    return getRefreshTelemetry().lastOutcome === 'invalid_grant'
  }, [authTick])
  const sheetsTokenRotated = useMemo(() => {
    void authTick
    return hasRefreshTokenOverride()
  }, [authTick])

  // Priority: sheets-auth error > general sync error > token-rotated >
  // live > mock. Auth error is the most actionable failure mode.
  const tone: 'sheets_auth' | 'error' | 'rotated' | 'live' | 'mock' =
    sheetsAuthError
      ? 'sheets_auth'
      : syncError
        ? 'error'
        : sheetsTokenRotated
          ? 'rotated'
          : live
            ? 'live'
            : 'mock'

  const label =
    tone === 'sheets_auth'
      ? 'Sheets: Auth Error'
      : tone === 'rotated'
        ? 'Sheets: Token Updated'
        : tone === 'error'
          ? 'Sync error'
          : tone === 'live'
            ? 'Live'
            : 'Demo'

  const dotClass = cn(
    'inline-block h-2 w-2 shrink-0 rounded-full',
    (isRefreshing || tone === 'rotated') && 'animate-pulse',
    tone === 'live' && 'bg-[var(--status-done)]',
    tone === 'error' && 'bg-[var(--priority-medium)]',
    tone === 'sheets_auth' && 'bg-[var(--priority-medium)]',
    tone === 'rotated' && 'bg-[#EAB308]',
    tone === 'mock' && 'bg-[var(--text-muted)]',
  )

  // Sheets-sourced task count (for the per-source breakdown in the tip).
  const sheetsTaskCount = useMemo(() => {
    const sheetProjectIds = new Set(
      projectDataSources
        .filter((p) => p.source === 'google-sheets')
        .map((p) => p.projectId),
    )
    if (sheetProjectIds.size === 0) return 0
    return tasks.filter((t) => sheetProjectIds.has(t.projectId)).length
  }, [tasks, projectDataSources])

  const atlasProjectCount = useMemo(() => {
    const atlasProjectIds = new Set(
      projectDataSources
        .filter((p) => p.source === 'atlas')
        .map((p) => p.projectId),
    )
    return atlasProjectIds.size
  }, [projectDataSources])

  // Per-source status glyph — one line per source, showing whether
  // it's configured and (best-effort) whether it looks healthy. We
  // don't yet track per-source fetch failures at the store level, so
  // the "live" verdict for Atlas + Sheets falls back to their
  // existing signals (dataSource / sheetsConnected). The transcript
  // store just reports configured/unconfigured until per-source
  // state lands.
  const sourceStatus = (() => {
    const atlasConfigured = isAtlasConfigured()
    const transcriptConfigured = isTranscriptStoreConfigured()
    const sheetsConfigured = isGoogleSheetsConfigured()
    const atlas = !atlasConfigured
      ? 'off'
      : atlasActive
        ? 'live'
        : 'down'
    const transcripts = !transcriptConfigured ? 'off' : 'configured'
    const sheets = !sheetsConfigured
      ? 'off'
      : sheetsActive
        ? 'live'
        : sheetsAuthError
          ? 'auth-error'
          : 'down'
    const glyph = (s: string) =>
      s === 'live' || s === 'configured'
        ? '✓'
        : s === 'off'
          ? '—'
          : s === 'auth-error'
            ? '⚠'
            : '✗'
    return `Atlas: ${glyph(atlas)} · Transcripts: ${glyph(transcripts)} · Sheets: ${glyph(sheets)}`
  })()

  const tooltip = (() => {
    if (tone === 'sheets_auth') {
      return `Google Sheets authentication failed. An admin needs to re-authorize.\n${sourceStatus}`
    }
    if (tone === 'rotated') {
      return `Google issued a new refresh token. Update .env to persist this change.\n${sourceStatus}`
    }
    if (tone === 'error') {
      return `Sync error: ${syncError ?? 'unknown'} — click to open Settings\n${sourceStatus}`
    }
    if (tone === 'mock') {
      return `Using demo data. Configure Atlas, Transcripts, or Google Sheets in Settings to connect live data.\n${sourceStatus}`
    }
    // Live: combine whichever sources are active into a single line,
    // then append the per-source glyph line for at-a-glance status.
    const parts: string[] = []
    if (atlasActive) {
      parts.push(
        `Atlas: ${atlasProjectCount} project${atlasProjectCount === 1 ? '' : 's'}`,
      )
    }
    if (sheetsActive) {
      parts.push(
        `Sheets: Contracting.com (${sheetsTaskCount} task${sheetsTaskCount === 1 ? '' : 's'})`,
      )
    }
    if (parts.length === 0) {
      parts.push(`${projects.length} project${projects.length === 1 ? '' : 's'}, ${tasks.length} task${tasks.length === 1 ? '' : 's'}`)
    }
    return `${parts.join(' · ')} · Last synced ${relativeAgo(lastSynced)}\n${sourceStatus}`
  })()

  // Anything actionable routes to Settings; the rotated state is also
  // actionable (operator needs to copy the new token).
  const interactive =
    tone === 'error' || tone === 'sheets_auth' || tone === 'rotated'

  return (
    <button
      type="button"
      onClick={interactive ? () => navigate('/settings') : undefined}
      disabled={!interactive}
      title={tooltip}
      aria-label={tooltip}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]',
        interactive &&
          'transition-colors hover:bg-[var(--bg-base)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
        !interactive && 'cursor-default',
      )}
    >
      <span aria-hidden="true" className={dotClass} />
      {label}
    </button>
  )
}

function relativeAgo(when: Date | null): string {
  if (!when) return 'just now'
  const ms = Date.now() - when.getTime()
  if (ms < 30_000) return 'just now'
  if (ms < 60_000) return 'less than a minute ago'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.floor(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}
