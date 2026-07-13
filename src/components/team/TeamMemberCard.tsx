import { useMemo } from 'react'
import { AlertTriangle, CheckCircle2, ChevronRight, ListTodo } from 'lucide-react'
import { Avatar } from '@/components/shared/Avatar'
import { cn } from '@/lib/utils'
import {
  isInThisWeek,
  isOverdue,
  now,
  parseLocalDate,
  startOfDay,
  startOfWeek,
} from '@/lib/date-utils'
import {
  STATUS_LABELS,
  type Priority,
  type Task,
  type TaskStatus,
  type TeamMember,
} from '@/data/types'

// ── Shared helpers ──────────────────────────────────────────────────────────
//
// TeamMemberCard owns the collapsed-header preview AND the expanded
// inline detail. MyTasksPage also imports the filter/sort vocabulary
// from here, so the exports below are part of a small shared
// vocabulary across the app.

/** Ranking used everywhere we sort tasks by urgency — lower = more
 *  urgent. */
export const PRIORITY_RANK: Record<Priority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

export const ACTIVE_STATUSES: TaskStatus[] = [
  'todo',
  'in_progress',
  'in_review',
]

/** Order of status groups when sort === 'priority' — In Progress / In
 *  Review surface first (most urgent), then To Do, then Done. */
export const GROUPED_STATUSES: TaskStatus[] = [
  'in_progress',
  'in_review',
  'todo',
  'done',
]

export const DEFAULT_COLLAPSED: ReadonlySet<TaskStatus> = new Set(['done'])

export const WORKLOAD_COLOR_VAR: Record<TaskStatus, string> = {
  todo: '--status-todo',
  in_progress: '--status-progress',
  in_review: '--status-review',
  done: '--status-done',
}

export const WORKLOAD_STATUSES: TaskStatus[] = [
  'todo',
  'in_progress',
  'in_review',
  'done',
]

// ── Filters & sort state ────────────────────────────────────────────────────

export type DueFilter =
  | 'all'
  | 'overdue'
  | 'today'
  | 'week'
  | 'month'
  | 'none'

export type SortMode = 'priority' | 'dueDate' | 'newest'

export interface MemberFilters {
  projectId: string
  priority: 'all' | Priority
  due: DueFilter
  sort: SortMode
}

export const DEFAULT_FILTERS: MemberFilters = {
  projectId: 'all',
  priority: 'all',
  due: 'all',
  sort: 'priority',
}

function filtersStorageKey(memberId: string): string {
  return `team_filters_${memberId}`
}

export function loadFilters(memberId: string): MemberFilters {
  if (typeof window === 'undefined') return DEFAULT_FILTERS
  try {
    const raw = window.sessionStorage.getItem(filtersStorageKey(memberId))
    if (!raw) return DEFAULT_FILTERS
    return { ...DEFAULT_FILTERS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_FILTERS
  }
}

export function saveFilters(memberId: string, filters: MemberFilters): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(
      filtersStorageKey(memberId),
      JSON.stringify(filters),
    )
  } catch {
    // private-mode / quota — silently degrade
  }
}

function isDueToday(dueDate: string | null): boolean {
  if (!dueDate) return false
  return (
    startOfDay(parseLocalDate(dueDate)).getTime() ===
    startOfDay(now()).getTime()
  )
}

function isInThisMonth(dueDate: string | null): boolean {
  if (!dueDate) return false
  const d = parseLocalDate(dueDate)
  const ref = now()
  return (
    d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth()
  )
}

function matchesDueFilter(t: Task, due: DueFilter): boolean {
  switch (due) {
    case 'all':
      return true
    case 'overdue':
      return isOverdue(t.dueDate)
    case 'today':
      return isDueToday(t.dueDate)
    case 'week':
      return isInThisWeek(t.dueDate)
    case 'month':
      return isInThisMonth(t.dueDate)
    case 'none':
      return t.dueDate === null
  }
}

export function applyFilters(tasks: Task[], filters: MemberFilters): Task[] {
  return tasks.filter((t) => {
    if (filters.projectId !== 'all' && t.projectId !== filters.projectId)
      return false
    if (filters.priority !== 'all' && t.priority !== filters.priority)
      return false
    if (!matchesDueFilter(t, filters.due)) return false
    return true
  })
}

export function compareByPriority(a: Task, b: Task): number {
  const r = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  if (r !== 0) return r
  if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
  if (a.dueDate) return -1
  if (b.dueDate) return 1
  return 0
}

export function compareByDueDate(a: Task, b: Task): number {
  if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
  if (a.dueDate) return -1
  if (b.dueDate) return 1
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
}

export function compareByNewest(a: Task, b: Task): number {
  return b.createdAt.localeCompare(a.createdAt)
}

export function activeFilterCount(f: MemberFilters): number {
  let n = 0
  if (f.projectId !== 'all') n += 1
  if (f.priority !== 'all') n += 1
  if (f.due !== 'all') n += 1
  return n
}

// ── Stats + velocity ────────────────────────────────────────────────────────

export interface MemberStats {
  active: number
  completedThisWeek: number
}

export function computeStats(tasks: Task[]): MemberStats {
  let active = 0
  let completedThisWeek = 0
  const weekStart = startOfWeek().getTime()
  const today = now().getTime()
  for (const t of tasks) {
    if (ACTIVE_STATUSES.includes(t.status)) active += 1
    if (t.status === 'done') {
      const u = new Date(t.updatedAt).getTime()
      if (u >= weekStart && u <= today) completedThisWeek += 1
    }
  }
  return { active, completedThisWeek }
}

export function groupByStatus(tasks: Task[]): Record<TaskStatus, Task[]> {
  const empty: Record<TaskStatus, Task[]> = {
    todo: [],
    in_progress: [],
    in_review: [],
    done: [],
  }
  for (const t of tasks) {
    empty[t.status].push(t)
  }
  return empty
}

export interface WeekBucket {
  label: string
  count: number
}

export function computeVelocity(tasks: Task[]): WeekBucket[] {
  const today = now()
  const startThisWeek = startOfWeek(today)
  const buckets: WeekBucket[] = []
  for (let i = 3; i >= 0; i--) {
    const start = new Date(startThisWeek)
    start.setDate(start.getDate() - i * 7)
    const end = new Date(start)
    end.setDate(end.getDate() + 7)
    end.setMilliseconds(-1)
    const label = start.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })
    let count = 0
    for (const t of tasks) {
      if (t.status !== 'done') continue
      const u = new Date(t.updatedAt).getTime()
      if (u >= start.getTime() && u <= end.getTime()) count += 1
    }
    buckets.push({ label, count })
  }
  return buckets
}

// ── MiniWorkloadBar ─────────────────────────────────────────────────────────

export function MiniWorkloadBar({
  tasks,
  className,
}: {
  tasks: Task[]
  className?: string
}) {
  const total = tasks.length
  const trackClass =
    'flex h-1 w-full overflow-hidden rounded-full bg-[var(--bg-elevated)]'

  if (total === 0) {
    return (
      <div
        className={cn(trackClass, className)}
        role="img"
        aria-label="No tasks assigned"
      />
    )
  }

  const counts = WORKLOAD_STATUSES.map((status) => ({
    status,
    count: tasks.filter((t) => t.status === status).length,
  }))
  const label = counts
    .filter((c) => c.count > 0)
    .map((c) => `${STATUS_LABELS[c.status]}: ${c.count}`)
    .join(', ')

  return (
    <div
      className={cn(trackClass, className)}
      role="img"
      aria-label={`Workload — ${label}`}
    >
      {counts.map(({ status, count }) => {
        if (count === 0) return null
        return (
          <div
            key={status}
            className="h-full transition-[width] duration-200"
            style={{
              width: `${(count / total) * 100}%`,
              backgroundColor: `var(${WORKLOAD_COLOR_VAR[status]})`,
            }}
            title={`${STATUS_LABELS[status]}: ${count}`}
          />
        )
      })}
    </div>
  )
}

// ── TeamMemberCard ──────────────────────────────────────────────────────────
//
// Pure summary card — fixed 120px tall, no task preview inside.
// Clicking the card opens the full-width expanded section BELOW the
// card's row (rendered by TeamPage at the grid level). The card
// itself stays at 120px in both collapsed and "active" states; only
// the chevron rotates/translates to acknowledge the click.

interface TeamMemberCardProps {
  member: TeamMember
  tasks: Task[]
  /** True when this card's expanded section is currently showing.
   *  Drives the chevron orientation only — the card height is the
   *  same either way. */
  expanded: boolean
  onToggle: () => void
}

const CARD_HEIGHT_PX = 120

export function TeamMemberCard({
  member,
  tasks,
  expanded,
  onToggle,
}: TeamMemberCardProps) {
  const stats = useMemo(() => computeStats(tasks), [tasks])
  const overdueCount = useMemo(() => {
    let n = 0
    for (const t of tasks) {
      if (t.status !== 'done' && isOverdue(t.dueDate)) n += 1
    }
    return n
  }, [tasks])
  const isPM = member.role === 'pm'

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${member.name}'s details`}
      style={{
        height: CARD_HEIGHT_PX,
        minHeight: CARD_HEIGHT_PX,
        maxHeight: CARD_HEIGHT_PX,
      }}
      className={cn(
        // Pure summary card. Fixed height keeps every cell in the
        // 2-col grid uniform regardless of how many tasks a member
        // owns. overflow-hidden makes the height limit absolute —
        // even an unusually long name can't push it taller.
        'group flex w-full items-stretch gap-3 overflow-hidden rounded-lg border bg-[var(--bg-surface)] px-5 pb-3 pt-4 text-left transition-[border-color,box-shadow,transform] duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
        expanded
          ? 'border-[var(--accent-primary)] shadow-[0_2px_8px_rgba(0,0,0,0.2)]'
          : 'border-[var(--border-subtle)] hover:cursor-pointer hover:border-[var(--border-default)] hover:shadow-[0_2px_8px_rgba(0,0,0,0.2)]',
      )}
    >
      {/* Avatar — top-aligned with the name row. */}
      <div className="flex shrink-0 items-start">
        <Avatar name={member.name} imageUrl={member.avatarUrl} size="lg" />
      </div>

      {/* Middle column distributes top stack (name/email/stats) vs the
          workload bar pinned to the bottom via justify-between. */}
      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-[var(--text-primary)]">
              {member.name}
            </h3>
            <span
              className={cn(
                'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
                isPM
                  ? 'bg-[color-mix(in_srgb,var(--accent-primary)_20%,transparent)] text-[var(--accent-primary)]'
                  : 'bg-[color-mix(in_srgb,var(--text-secondary)_20%,transparent)] text-[var(--text-secondary)]',
              )}
            >
              {isPM ? 'PM' : 'Member'}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[12px] text-[var(--text-secondary)]">
            {member.email}
          </p>
          {/* Stats line — active / overdue (red, conditional) / this
              week. Overdue surfaces in --priority-critical only when
              > 0 so it stays a real urgency cue. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums">
            <span className="inline-flex items-center gap-1 text-[var(--text-muted)]">
              <ListTodo className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="font-semibold text-[var(--text-primary)]">
                {stats.active}
              </span>{' '}
              active
            </span>
            {overdueCount > 0 && (
              <>
                <span aria-hidden="true" className="text-[var(--text-muted)]">
                  ·
                </span>
                <span className="inline-flex items-center gap-1 text-[var(--priority-critical)]">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="font-semibold">{overdueCount}</span> overdue
                </span>
              </>
            )}
            <span aria-hidden="true" className="text-[var(--text-muted)]">
              ·
            </span>
            <span className="inline-flex items-center gap-1 text-[var(--text-muted)]">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="font-semibold text-[var(--text-primary)]">
                {stats.completedThisWeek}
              </span>{' '}
              this week
            </span>
          </div>
        </div>

        <MiniWorkloadBar tasks={tasks} />
      </div>

      {/* Chevron — vertically centred. Slides 2 px right on hover to
          telegraph that the entire card is clickable. */}
      <div className="flex shrink-0 items-center">
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'h-4 w-4 text-[var(--text-muted)] transition-transform duration-150',
            expanded
              ? 'rotate-90 text-[var(--accent-primary)]'
              : 'group-hover:translate-x-0.5',
          )}
        />
      </div>
    </button>
  )
}
