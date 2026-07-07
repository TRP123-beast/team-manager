/**
 * Settings → unified data-sources overview.
 *
 * One-line-per-source table replacing the earlier per-endpoint Atlas
 * table at the top of the Settings page. Each row reports:
 *
 *   - Source name
 *   - Status glyph (live / cached / down / unconfigured)
 *   - What data it feeds (short human phrase)
 *   - Pages / features that depend on it
 *
 * Status is computed from the same signals the DataSourceBadge uses:
 * store dataSource, sheetsConnected, isTranscriptStoreConfigured,
 * isSupabaseConfigured, plus a live probe for each service we can
 * reach cheaply. Rows still render when the corresponding source is
 * unconfigured — the user sees the whole set at a glance and knows
 * what's missing.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Database,
  FileText,
  FolderKanban,
  Headphones,
  Loader2,
  RefreshCw,
  Table2,
  XCircle,
} from 'lucide-react'
import { useData } from '@/data/store'
import { fetchBotState } from '@/services/zoombot-api'
import { isZoomBotConfigured } from '@/services/zoombot-config'
import { fetchTranscripts } from '@/services/transcript-store-api'
import { isTranscriptStoreConfigured } from '@/services/transcript-store-config'
import { isAtlasConfigured } from '@/services/atlas/config'
import { isGoogleSheetsConfigured } from '@/services/google-sheets-config'
import { isSupabaseConfigured } from '@/services/supabase'
import { cn } from '@/lib/utils'

type SourceKey =
  | 'zoombot'
  | 'transcript-store'
  | 'atlas'
  | 'google-sheets'
  | 'supabase'

type ProbeState =
  | 'live'
  | 'down'
  | 'unconfigured'
  | 'unknown'
  | 'checking'

interface SourceRow {
  key: SourceKey
  label: string
  icon: typeof Database
  data: string
  pages: string
  state: ProbeState
  detail?: string
}

export function SourcesOverviewTable() {
  const {
    dataSource,
    sheetsConnected,
    projects,
    tasks,
    projectDataSources,
  } = useData()

  // Per-source probe state — we run a quick health check for
  // ZoomBot + Transcript Store on mount / refresh so the table
  // reflects reality rather than just "is the token set".
  const [zoomBotState, setZoomBotState] = useState<ProbeState>('checking')
  const [zoomBotDetail, setZoomBotDetail] = useState<string>('')
  const [transcriptState, setTranscriptState] = useState<ProbeState>('checking')
  const [transcriptDetail, setTranscriptDetail] = useState<string>('')
  const [refreshing, setRefreshing] = useState<boolean>(false)

  const runProbes = useCallback(async () => {
    setRefreshing(true)

    // ── ZoomBot ────────────────────────────────────────────────
    if (!isZoomBotConfigured()) {
      setZoomBotState('unconfigured')
      setZoomBotDetail('')
    } else {
      setZoomBotState('checking')
      try {
        const state = await fetchBotState()
        setZoomBotState('live')
        setZoomBotDetail(
          `${state.bots.length} bot${state.bots.length === 1 ? '' : 's'} configured`,
        )
      } catch (err) {
        setZoomBotState('down')
        setZoomBotDetail(err instanceof Error ? err.message : String(err))
      }
    }

    // ── Transcript Store ───────────────────────────────────────
    if (!isTranscriptStoreConfigured()) {
      setTranscriptState('unconfigured')
      setTranscriptDetail('')
    } else {
      setTranscriptState('checking')
      try {
        const { total } = await fetchTranscripts(1, 0)
        setTranscriptState('live')
        setTranscriptDetail(
          `${total} transcript${total === 1 ? '' : 's'}`,
        )
      } catch (err) {
        setTranscriptState('down')
        setTranscriptDetail(err instanceof Error ? err.message : String(err))
      }
    }

    setRefreshing(false)
  }, [])

  useEffect(() => {
    void runProbes()
  }, [runProbes])

  // Atlas + Sheets state is derived from what the store already knows
  // (no extra probe — the loaders keep this in sync).
  const atlasProjectCount = projectDataSources.filter(
    (p) => p.source === 'atlas',
  ).length
  const atlasState: ProbeState = !isAtlasConfigured()
    ? 'unconfigured'
    : dataSource === 'atlas'
      ? 'live'
      : 'down'
  const sheetsTaskCount = (() => {
    const sheetProjectIds = new Set(
      projectDataSources
        .filter((p) => p.source === 'google-sheets')
        .map((p) => p.projectId),
    )
    return tasks.filter((t) => sheetProjectIds.has(t.projectId)).length
  })()
  const sheetsState: ProbeState = !isGoogleSheetsConfigured()
    ? 'unconfigured'
    : sheetsConnected
      ? 'live'
      : 'down'
  const supabaseState: ProbeState = !isSupabaseConfigured()
    ? 'unconfigured'
    : 'live'

  const rows: SourceRow[] = [
    {
      key: 'zoombot',
      label: 'ZoomBot',
      icon: Headphones,
      data: zoomBotState === 'live' ? zoomBotDetail : 'Audio, video, live captions',
      pages: 'Live Meeting, Recordings',
      state: zoomBotState,
      ...(zoomBotState === 'down' ? { detail: zoomBotDetail } : {}),
    },
    {
      key: 'transcript-store',
      label: 'Transcripts (ZoomBot /api/transcripts)',
      icon: FileText,
      data:
        transcriptState === 'live'
          ? transcriptDetail
          : 'Transcripts, summaries',
      pages: 'Meetings, Meeting Detail',
      state: transcriptState,
      ...(transcriptState === 'down' ? { detail: transcriptDetail } : {}),
    },
    {
      key: 'atlas',
      label: 'Atlas',
      icon: FolderKanban,
      data:
        atlasState === 'live'
          ? `${atlasProjectCount} project${atlasProjectCount === 1 ? '' : 's'}, ${projects.length} total`
          : 'Projects, tasks, activity feed',
      pages: 'Board, My Tasks, Dashboard, Team',
      state: atlasState,
    },
    {
      key: 'google-sheets',
      label: 'Google Sheets',
      icon: Table2,
      data:
        sheetsState === 'live'
          ? `${sheetsTaskCount} task${sheetsTaskCount === 1 ? '' : 's'} — Contracting.com`
          : 'Contracting.com tasks',
      pages: 'Board, My Tasks, Team',
      state: sheetsState,
    },
    {
      key: 'supabase',
      label: 'Supabase',
      icon: Database,
      data:
        supabaseState === 'live'
          ? 'Cache + local edits'
          : 'Persistence layer (unconfigured)',
      pages: 'All pages (persistence)',
      state: supabaseState,
    },
  ]

  return (
    <section aria-labelledby="sources-overview-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2
            id="sources-overview-heading"
            className="text-lg font-semibold text-[var(--text-primary)]"
          >
            Data Sources
          </h2>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Every service the app talks to and which pages depend on it.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void runProbes()
          }}
          disabled={refreshing}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-[var(--border-default)] bg-transparent px-3 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Refresh
        </button>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--border-subtle)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--bg-elevated)]/40 text-left text-[11px] uppercase tracking-[0.5px] text-[var(--text-secondary)]">
            <tr>
              <th className="px-3 py-2 font-semibold">Source</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Data</th>
              <th className="px-3 py-2 font-semibold">Pages Affected</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <SourceRow key={row.key} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function SourceRow({ row }: { row: SourceRow }) {
  const Icon = row.icon
  return (
    <tr className="border-t border-[var(--border-subtle)] first:border-t-0">
      <td className="px-3 py-2.5">
        <span className="inline-flex items-center gap-2 text-[var(--text-primary)]">
          <Icon className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
          {row.label}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <StatusPill state={row.state} title={row.detail} />
      </td>
      <td className="px-3 py-2.5 text-[var(--text-secondary)]">{row.data}</td>
      <td className="px-3 py-2.5 text-[var(--text-muted)]">{row.pages}</td>
    </tr>
  )
}

function StatusPill({ state, title }: { state: ProbeState; title?: string }) {
  const { label, dot, Icon, color } = (() => {
    switch (state) {
      case 'live':
        return {
          label: 'Connected',
          dot: 'bg-[var(--status-done)]',
          Icon: CheckCircle2,
          color: 'text-[var(--status-done)]',
        }
      case 'down':
        return {
          label: 'Down',
          dot: 'bg-[var(--priority-critical)]',
          Icon: XCircle,
          color: 'text-[var(--priority-critical)]',
        }
      case 'checking':
        return {
          label: 'Checking…',
          dot: 'bg-[var(--accent-primary)] animate-pulse',
          Icon: Loader2,
          color: 'text-[var(--accent-primary)]',
        }
      case 'unconfigured':
        return {
          label: 'Not configured',
          dot: 'bg-[var(--text-muted)]',
          Icon: CircleSlash,
          color: 'text-[var(--text-muted)]',
        }
      default:
        return {
          label: 'Unknown',
          dot: 'bg-[var(--text-muted)]',
          Icon: AlertTriangle,
          color: 'text-[var(--text-muted)]',
        }
    }
  })()
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] font-medium',
        color,
      )}
    >
      <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', dot)} />
      <Icon
        className={cn(
          'h-3 w-3',
          state === 'checking' && 'animate-spin',
        )}
        aria-hidden="true"
      />
      {label}
    </span>
  )
}
