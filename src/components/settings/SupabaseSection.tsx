/**
 * Settings → Supabase.
 *
 * Surfaces the cache health signals a PM might want at a glance —
 * whether Supabase is configured, how many projects have cache
 * rows, and how old the newest snapshot is. Two actions live here:
 *
 *   - Clear Cache — deletes every atlas_cache row. Next background
 *     load re-populates. PM-only, guarded by a confirm modal.
 *   - Force Re-sync — kicks off refreshFromAtlas + refreshFromSheets
 *     + refreshMeetings so the cache picks up fresh data immediately.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  CheckCircle2,
  Database,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import {
  clearAtlasCache,
  getAtlasCacheStats,
} from '@/services/supabase-api'
import { isSupabaseConfigured } from '@/services/supabase'
import { cn } from '@/lib/utils'

interface CacheStats {
  count: number
  latestFetchedAt: string | null
}

export function SupabaseSection() {
  const { isPM } = useAuth()
  const { refreshFromAtlas, refreshFromSheets, refreshMeetings } = useData()
  const configured = isSupabaseConfigured()

  const [stats, setStats] = useState<CacheStats | null>(null)
  const [statsLoading, setStatsLoading] = useState<boolean>(false)
  const [clearing, setClearing] = useState<boolean>(false)
  const [resyncing, setResyncing] = useState<boolean>(false)

  const loadStats = useCallback(async () => {
    if (!configured) return
    setStatsLoading(true)
    try {
      const s = await getAtlasCacheStats()
      setStats(s)
    } finally {
      setStatsLoading(false)
    }
  }, [configured])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  const handleClear = async () => {
    if (
      !window.confirm(
        'Clear every atlas_cache row? Live data stays intact and the next background load will re-populate.',
      )
    )
      return
    setClearing(true)
    try {
      await clearAtlasCache()
      toast.success('Supabase cache cleared.')
      await loadStats()
    } catch (err) {
      toast.error(
        `Cache clear failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setClearing(false)
    }
  }

  const handleResync = async () => {
    setResyncing(true)
    try {
      // Fan-out — each helper no-ops when its source isn't configured,
      // so it's safe to fire all three even in a partial setup.
      await Promise.allSettled([
        refreshFromAtlas(),
        refreshFromSheets(),
        refreshMeetings(),
      ])
      // Re-read stats so the "latest fetched" line reflects the just-
      // completed writes.
      await loadStats()
      toast.success('Re-sync complete.')
    } catch (err) {
      toast.error(
        `Re-sync failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setResyncing(false)
    }
  }

  const cacheAge = stats?.latestFetchedAt
    ? relativeAgo(new Date(stats.latestFetchedAt))
    : null

  return (
    <section aria-labelledby="supabase-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id="supabase-heading"
          className="inline-flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]"
        >
          <Database className="h-4 w-4" aria-hidden="true" />
          Supabase — Data Persistence
        </h2>
        <StatusBadge configured={configured} />
      </div>

      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        Shared-team persistence layer. Local edits (status changes,
        comments, subtasks, meeting notes) sync here, and every source
        loader mirrors its latest snapshot to the{' '}
        <code className="font-mono">atlas_cache</code> table for
        offline fallback.
      </p>

      {!configured ? (
        <div className="mt-5 rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 px-4 py-5 text-sm text-[var(--text-secondary)]">
          Supabase isn't configured. Set{' '}
          <code className="font-mono">VITE_SUPABASE_URL</code> and{' '}
          <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> in your
          .env, then restart the dev server.
        </div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
            <StatCard
              label="Cached projects"
              value={
                statsLoading ? (
                  <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading…
                  </span>
                ) : stats === null ? (
                  <span className="text-[var(--text-muted)]">—</span>
                ) : (
                  <span className="font-mono tabular-nums text-[var(--text-primary)]">
                    {stats.count}
                  </span>
                )
              }
            />
            <StatCard
              label="Cache age"
              value={
                statsLoading ? (
                  <span className="text-[var(--text-muted)]">—</span>
                ) : cacheAge ? (
                  <span className="text-[var(--text-primary)]">
                    {cacheAge}
                  </span>
                ) : (
                  <span className="text-[var(--text-muted)]">
                    No cache written yet
                  </span>
                )
              }
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void handleResync()
              }}
              disabled={resyncing}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-4 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {resyncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Force Re-sync
            </button>
            {isPM && (
              <button
                type="button"
                onClick={() => {
                  void handleClear()
                }}
                disabled={clearing}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-[var(--border-default)] bg-transparent px-3 text-sm font-medium text-[var(--destructive)] transition-colors hover:bg-[color-mix(in_srgb,var(--destructive)_15%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {clearing ? (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Clear Cache
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function StatCard({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-elevated)_30%,transparent)] p-4">
      <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold text-[var(--text-primary)] tabular-nums">
        {value}
      </p>
    </div>
  )
}

function StatusBadge({ configured }: { configured: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block h-2 w-2 rounded-full',
          configured ? 'bg-[var(--status-done)]' : 'bg-[var(--text-muted)]',
        )}
      />
      {configured ? (
        <>
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          Connected
        </>
      ) : (
        'Not Configured'
      )}
    </span>
  )
}

function relativeAgo(when: Date): string {
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
