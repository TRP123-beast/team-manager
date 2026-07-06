import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  List,
} from 'lucide-react'
import { CalendarView, type CalendarItem } from '@/components/CalendarView'
import { MeetingListRow } from '@/components/meetings/MeetingListRow'
import { SkeletonLine } from '@/components/shared/Skeleton'
import { useData } from '@/data/store'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useScrollRestore } from '@/hooks/useScrollRestore'
import { now } from '@/lib/date-utils'
import { cn } from '@/lib/utils'
import type { Meeting, MeetingStatus } from '@/data/types'

type MeetingsView = 'list' | 'calendar'
const MEETINGS_VIEW_KEY = 'team-manager.meetings-view'

function loadMeetingsView(): MeetingsView {
  if (typeof window === 'undefined') return 'list'
  try {
    return window.localStorage.getItem(MEETINGS_VIEW_KEY) === 'calendar'
      ? 'calendar'
      : 'list'
  } catch {
    return 'list'
  }
}

function saveMeetingsView(view: MeetingsView): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(MEETINGS_VIEW_KEY, view)
  } catch {
    // ignore
  }
}

type StatusFilter = 'all' | MeetingStatus

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'All',
  scheduled: 'Scheduled',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

type DatePreset = 'any' | 'week' | 'month' | 'quarter' | 'year' | 'custom'

const DATE_PRESET_LABEL: Record<DatePreset, string> = {
  any: 'Any time',
  week: 'Last 7 days',
  month: 'Last 30 days',
  quarter: 'Last 90 days',
  year: 'This year',
  custom: 'Custom range',
}

const PAGE_SIZE = 15

/** YYYY-MM-DD for a Date in local time (no UTC drift). */
function toYMD(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Resolve a preset to a concrete [from, to] window in YYYY-MM-DD.
 *  Returns `null` bounds for the open-ended sides ("any time"). */
function resolvePreset(preset: DatePreset): {
  from: string | null
  to: string | null
} {
  if (preset === 'any' || preset === 'custom') {
    return { from: null, to: null }
  }
  const today = now()
  const to = toYMD(today)
  if (preset === 'week') {
    const d = new Date(today)
    d.setDate(d.getDate() - 6)
    return { from: toYMD(d), to }
  }
  if (preset === 'month') {
    const d = new Date(today)
    d.setDate(d.getDate() - 29)
    return { from: toYMD(d), to }
  }
  if (preset === 'quarter') {
    const d = new Date(today)
    d.setDate(d.getDate() - 89)
    return { from: toYMD(d), to }
  }
  // year — Jan 1 of the current year through today
  return { from: `${today.getFullYear()}-01-01`, to }
}

export default function MeetingsPage() {
  useDocumentTitle('Meetings')
  useScrollRestore()
  const {
    meetings,
    projects,
    teamMembers,
    isInitialLoading,
    refreshMeetings,
  } = useData()

  // Pull a fresh 30-day window every time the user lands here. The
  // store's background tick skips manifests and the dedicated meeting
  // timer only covers today, so without this the user could see a
  // snapshot frozen at app boot if they leave the tab open and Atlas
  // processes new meetings later.
  useEffect(() => {
    void refreshMeetings()
  }, [refreshMeetings])

  const [status, setStatus] = useState<StatusFilter>('all')
  const [projectId, setProjectId] = useState<string>('all')
  const [datePreset, setDatePreset] = useState<DatePreset>('any')
  const [customFrom, setCustomFrom] = useState<string>('')
  const [customTo, setCustomTo] = useState<string>('')
  const [page, setPage] = useState<number>(1)
  const [view, setViewState] = useState<MeetingsView>(() => loadMeetingsView())
  const setView = (next: MeetingsView) => {
    setViewState(next)
    saveMeetingsView(next)
  }
  const navigate = useNavigate()

  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  )

  const counts = useMemo(() => {
    const out: Record<StatusFilter, number> = {
      all: meetings.length,
      scheduled: 0,
      completed: 0,
      cancelled: 0,
    }
    for (const m of meetings) out[m.status] += 1
    return out
  }, [meetings])

  // The date window — preset resolves to a concrete window, custom uses
  // whichever endpoint the user filled in.
  const dateWindow = useMemo(() => {
    if (datePreset === 'custom') {
      return {
        from: customFrom || null,
        to: customTo || null,
      }
    }
    return resolvePreset(datePreset)
  }, [datePreset, customFrom, customTo])

  const visible = useMemo(() => {
    const filtered = meetings.filter((m) => {
      if (status !== 'all' && m.status !== status) return false
      if (projectId !== 'all' && m.projectId !== projectId) return false
      if (dateWindow.from && m.date < dateWindow.from) return false
      if (dateWindow.to && m.date > dateWindow.to) return false
      return true
    })
    // Newest first by meeting date; createdAt breaks same-day ties.
    return filtered.sort((a: Meeting, b: Meeting) => {
      const d = b.date.localeCompare(a.date)
      if (d !== 0) return d
      return b.createdAt.localeCompare(a.createdAt)
    })
  }, [meetings, status, projectId, dateWindow])

  // Reset to page 1 whenever the filtered set changes shape — otherwise
  // narrowing the filter could leave the user stranded on an empty page.
  useEffect(() => {
    setPage(1)
  }, [status, projectId, datePreset, customFrom, customTo])

  // Calendar mode consumes the same filtered `visible` set the list
  // mode paginates. Meeting chips carry the project's colour so a
  // multi-project calendar reads at a glance; the chip title stays
  // the meeting's own title (project is in the tooltip / popover).
  const calendarItems = useMemo<CalendarItem[]>(
    () =>
      visible.map((m) => {
        const project = projectById.get(m.projectId)
        return {
          id: m.id,
          title: m.title,
          date: m.date,
          type: 'meeting',
          status: m.status,
          projectId: m.projectId,
          projectName: project?.name,
          projectColor: project?.color,
          done: m.status === 'cancelled',
        }
      }),
    [visible, projectById],
  )

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageStart = (safePage - 1) * PAGE_SIZE
  const pageEnd = Math.min(pageStart + PAGE_SIZE, visible.length)
  const pageItems = visible.slice(pageStart, pageEnd)

  if (isInitialLoading) {
    return (
      <div className="space-y-6">
        <SkeletonLine className="h-8 w-40" />
        <SkeletonLine className="h-9 w-full max-w-md" />
        <div className="space-y-2">
          <SkeletonLine className="h-20 w-full" />
          <SkeletonLine className="h-20 w-full" />
          <SkeletonLine className="h-20 w-full" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--text-primary)]">
            Meetings
          </h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Every discussion across every project — open a row to see its notes,
            decisions, and action items.
          </p>
        </div>
        {meetings.length > 0 && (
          <div
            role="radiogroup"
            aria-label="Meetings view"
            className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-md bg-[var(--bg-elevated)] p-0.5"
          >
            <MeetingsViewButton
              icon={List}
              label="List"
              active={view === 'list'}
              onClick={() => setView('list')}
            />
            <MeetingsViewButton
              icon={CalendarDays}
              label="Calendar"
              active={view === 'calendar'}
              onClick={() => setView('calendar')}
            />
          </div>
        )}
      </header>

      {meetings.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] pb-3">
              <div
                role="tablist"
                aria-label="Filter meetings by status"
                className="flex flex-wrap items-center gap-1"
              >
                {(Object.keys(STATUS_LABEL) as StatusFilter[]).map((key) => {
                  const active = status === key
                  return (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setStatus(key)}
                      // Pill tabs — solid primary fill when active, no
                      // chrome when inactive (just hover bg). Larger
                      // text and pad than the other filter chips so
                      // they read as the page's primary navigation.
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
                        active
                          ? 'bg-[var(--accent-primary)] font-medium text-[var(--text-inverse)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]',
                      )}
                    >
                      {STATUS_LABEL[key]}
                      <span
                        className={cn(
                          'text-[10px] tabular-nums',
                          active ? 'opacity-90' : 'opacity-70',
                        )}
                      >
                        {counts[key]}
                      </span>
                    </button>
                  )
                })}
              </div>

              <div className="ml-auto flex items-center gap-2">
                <label
                  htmlFor="meetings-project-filter"
                  className="text-xs text-[var(--text-secondary)]"
                >
                  Project
                </label>
                <select
                  id="meetings-project-filter"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="h-8 min-w-[160px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-xs text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
                >
                  <option value="all">All projects</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-[var(--text-secondary)]">Date</span>
              <div
                role="tablist"
                aria-label="Filter meetings by date"
                className="flex flex-wrap items-center gap-1"
              >
                {(Object.keys(DATE_PRESET_LABEL) as DatePreset[]).map((key) => {
                  const active = datePreset === key
                  return (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setDatePreset(key)}
                      className={cn(
                        'inline-flex h-7 items-center rounded-full border px-2.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
                        active
                          ? 'border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)] text-[var(--accent-primary)]'
                          : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-default)] hover:text-[var(--text-primary)]',
                      )}
                    >
                      {DATE_PRESET_LABEL[key]}
                    </button>
                  )
                })}
              </div>

              {datePreset === 'custom' && (
                <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                  <label className="flex items-center gap-1">
                    From
                    <input
                      type="date"
                      value={customFrom}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      max={customTo || undefined}
                      className="h-7 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    To
                    <input
                      type="date"
                      value={customTo}
                      onChange={(e) => setCustomTo(e.target.value)}
                      min={customFrom || undefined}
                      className="h-7 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
                    />
                  </label>
                </div>
              )}
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="flex min-h-[200px] flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 px-6 py-10 text-center">
              <CalendarRange
                className="h-8 w-8 text-[var(--text-muted)]"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <p className="mt-3 text-sm text-[var(--text-secondary)]">
                No meetings found
              </p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Try widening the date range or clearing the status filter.
              </p>
            </div>
          ) : view === 'calendar' ? (
            <CalendarView
              items={calendarItems}
              headerCaption={`${visible.length} meeting${visible.length === 1 ? '' : 's'}`}
              onItemClick={(item) =>
                navigate(`/projects/${item.projectId}/meetings/${item.id}`)
              }
            />
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {pageItems.map((m) => {
                  const project = projectById.get(m.projectId)
                  return (
                    <li key={m.id}>
                      <MeetingListRow
                        meeting={m}
                        members={teamMembers}
                        to={`/projects/${m.projectId}/meetings/${m.id}`}
                        projectChip={
                          project
                            ? { name: project.name, color: project.color }
                            : undefined
                        }
                      />
                    </li>
                  )
                })}
              </ul>

              {totalPages > 1 && (
                <nav
                  aria-label="Meetings pagination"
                  className="flex flex-wrap items-center justify-between gap-3 pt-1"
                >
                  <p className="text-xs text-[var(--text-secondary)] tabular-nums">
                    Showing {pageStart + 1}–{pageEnd} of {visible.length}
                  </p>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={safePage === 1}
                      aria-label="Previous page"
                      className="inline-flex h-8 items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                      Prev
                    </button>
                    <span className="px-2 text-xs text-[var(--text-secondary)] tabular-nums">
                      Page {safePage} of {totalPages}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={safePage === totalPages}
                      aria-label="Next page"
                      className="inline-flex h-8 items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Next
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </nav>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 px-6 py-12 text-center">
      <CalendarRange
        className="h-10 w-10 text-[var(--text-muted)]"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <h2 className="mt-3 text-sm font-medium text-[var(--text-secondary)]">
        No meetings yet
      </h2>
      <p className="mt-1 max-w-sm text-xs text-[var(--text-muted)]">
        Open a project to schedule a meeting — discussions, decisions, and
        action items all live under the project they belong to.
      </p>
    </div>
  )
}

// ── View toggle button ──────────────────────────────────────────────────────

function MeetingsViewButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof List
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={`${label} view`}
      title={`${label} view`}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
        active
          ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-sm'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}
