/**
 * Settings → Transcripts.
 *
 * Transcripts and post-meeting summaries live on the ZoomBot host at
 * `/api/transcripts` and share ZoomBot's HTTP Basic Auth. There's no
 * separate URL or token to configure here — the section is a
 * read-only status/stats card that piggybacks on whatever's set in
 * the ZoomBot section above.
 *
 * Renders:
 *   - Connection status pill (probed via `fetchTranscripts(1, 0)`).
 *   - Test Connection button (re-probes on demand).
 *   - Stats block: total transcripts, with-summary count from a 25-row
 *     sample, latest ingest timestamp.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  FileText,
  Loader2,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  fetchTranscripts,
  TranscriptStoreApiError,
} from '@/services/transcript-store-api'
import { isTranscriptStoreConfigured } from '@/services/transcript-store-config'
import type { TranscriptListItem } from '@/services/transcript-store-types'
import { cn } from '@/lib/utils'

type ConnectionStatus =
  | 'connected'
  | 'unreachable'
  | 'auth-error'
  | 'unknown'
  | 'unconfigured'

export function TranscriptStoreSection() {
  const [testing, setTesting] = useState<boolean>(false)
  const [status, setStatus] = useState<ConnectionStatus>(
    isTranscriptStoreConfigured() ? 'unknown' : 'unconfigured',
  )
  const [statsLoading, setStatsLoading] = useState<boolean>(false)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [firstPage, setFirstPage] = useState<TranscriptListItem[] | null>(null)

  const loadStats = async () => {
    if (!isTranscriptStoreConfigured()) return
    setStatsLoading(true)
    setStatsError(null)
    try {
      // 25 rows is enough to compute "with-summary" and "latest"
      // without paging the whole list on every Settings visit.
      const { items, total } = await fetchTranscripts(25, 0)
      setFirstPage(items)
      setTotal(total)
      setStatus('connected')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatsError(message)
      if (err instanceof TranscriptStoreApiError && err.status === 401) {
        setStatus('auth-error')
      } else {
        setStatus('unreachable')
      }
    } finally {
      setStatsLoading(false)
    }
  }

  useEffect(() => {
    void loadStats()
    // Intentionally run once on mount — a manual refresh (button
    // below) re-runs the fetch when the operator wants the latest
    // counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stats = useMemo(() => {
    if (!firstPage) return null
    let withSummary = 0
    let latestMs = -Infinity
    let latestIso: string | null = null
    for (const row of firstPage) {
      if (row.has_summary) withSummary += 1
      const ms = Date.parse(row.created_at)
      if (Number.isFinite(ms) && ms > latestMs) {
        latestMs = ms
        latestIso = row.created_at
      }
    }
    return { withSummary, latest: latestIso }
  }, [firstPage])

  const handleTest = async () => {
    setTesting(true)
    try {
      const { total } = await fetchTranscripts(1, 0)
      setTotal(total)
      toast.success(
        `Connected! ${total} transcript${total === 1 ? '' : 's'} available.`,
      )
      setStatus('connected')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof TranscriptStoreApiError && err.status === 401) {
        toast.error(
          'Authentication failed. Check the ZoomBot username/password.',
        )
        setStatus('auth-error')
      } else {
        toast.error(`Connection failed: ${message}`)
        setStatus('unreachable')
      }
    } finally {
      setTesting(false)
    }
  }

  return (
    <section aria-labelledby="transcript-store-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id="transcript-store-heading"
          className="inline-flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]"
        >
          <FileText className="h-4 w-4" aria-hidden="true" />
          Transcripts &amp; Summaries
        </h2>
        <StatusBadge status={status} />
      </div>

      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        Served by the ZoomBot host at{' '}
        <code className="font-mono">/api/transcripts</code> and share
        the same HTTP Basic Auth. Configure the URL and credentials in
        the ZoomBot section above — this section reports what's
        available and lets you re-probe on demand.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleTest}
          disabled={testing || !isTranscriptStoreConfigured()}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-[var(--border-default)] bg-transparent px-4 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {testing && (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          )}
          Test Connection
        </button>
      </div>

      <div className="mt-4 space-y-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
            Transcripts
          </h3>
          <button
            type="button"
            onClick={() => {
              void loadStats()
            }}
            disabled={statsLoading || !isTranscriptStoreConfigured()}
            className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-[var(--border-default)] bg-transparent px-2.5 text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {statsLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
            )}
            Refresh
          </button>
        </div>
        {statsError ? (
          <p className="text-[13px] text-[var(--priority-critical)]">
            {statsError}
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm md:grid-cols-3">
            <StatRow
              label="Total transcripts"
              value={
                total === null ? (
                  <span className="text-[var(--text-muted)]">—</span>
                ) : (
                  <span className="font-mono tabular-nums text-[var(--text-primary)]">
                    {total}
                  </span>
                )
              }
            />
            <StatRow
              label="With summaries"
              value={
                stats === null ? (
                  <span className="text-[var(--text-muted)]">—</span>
                ) : (
                  <span className="font-mono tabular-nums text-[var(--text-primary)]">
                    {stats.withSummary}
                    <span className="ml-1 text-[11px] text-[var(--text-muted)]">
                      (of {firstPage?.length ?? 0} sampled)
                    </span>
                  </span>
                )
              }
            />
            <StatRow
              label="Latest ingest"
              value={
                stats?.latest ? (
                  <span className="text-[var(--text-primary)]">
                    {new Date(stats.latest).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                ) : (
                  <span className="text-[var(--text-muted)]">—</span>
                )
              }
            />
          </dl>
        )}
      </div>
    </section>
  )
}

function StatRow({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2">
      <dt className="min-w-0 text-[11px] uppercase tracking-[0.5px] text-[var(--text-muted)]">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-right">{value}</dd>
    </div>
  )
}

function StatusBadge({ status }: { status: ConnectionStatus }) {
  const label =
    status === 'connected'
      ? 'Connected'
      : status === 'auth-error'
        ? 'Auth Error'
        : status === 'unreachable'
          ? 'Unreachable'
          : status === 'unconfigured'
            ? 'Not Configured'
            : 'Unknown'
  const dotColor = cn(
    'inline-block h-2 w-2 shrink-0 rounded-full',
    status === 'connected' && 'bg-[var(--status-done)]',
    status === 'unreachable' && 'bg-[var(--priority-critical)]',
    status === 'auth-error' && 'bg-[var(--priority-medium)]',
    status === 'unknown' && 'bg-[var(--text-muted)]',
    status === 'unconfigured' && 'bg-[var(--text-muted)]',
  )
  const Icon =
    status === 'connected'
      ? CheckCircle2
      : status === 'unreachable' || status === 'auth-error'
        ? XCircle
        : null
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]">
      <span aria-hidden="true" className={dotColor} />
      {Icon && <Icon className="h-3 w-3" aria-hidden="true" />}
      {label}
    </span>
  )
}
