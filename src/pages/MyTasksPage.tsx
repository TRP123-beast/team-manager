import { useEffect, useMemo, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import {
  CalendarDays,
  CheckCircle2,
  List,
  ListChecks,
  MessageSquare,
} from 'lucide-react'
import {
  TaskSection,
  type MyTaskEntry,
} from '@/components/my-tasks/TaskSection'
import { CalendarView, type CalendarItem } from '@/components/CalendarView'
import { SkeletonCard, SkeletonLine } from '@/components/shared/Skeleton'
import { useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import { useTaskPanel } from '@/data/task-panel'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useScrollRestore } from '@/hooks/useScrollRestore'
import type { LayoutOutletContext } from '@/components/layout/Layout'
import { isOverdue } from '@/lib/date-utils'
import {
  STATUS_LABELS,
  type Priority,
  type Project,
  type TaskStatus,
} from '@/data/types'
import { cn } from '@/lib/utils'
import {
  activeFilterCount,
  applyFilters,
  compareByDueDate,
  compareByNewest,
  compareByPriority,
  DEFAULT_FILTERS,
  loadFilters,
  saveFilters,
  type MemberFilters,
} from '@/components/team/TeamMemberCard'

/** Status group order on the page — In Progress first (the most
 *  urgent thing the user is actively shipping), then Review, then
 *  To Do, then Done. */
const GROUP_STATUSES: TaskStatus[] = [
  'in_progress',
  'in_review',
  'todo',
  'done',
]

/** Done is collapsed by default — it's history, not the active queue. */
const DEFAULT_COLLAPSED_STATUSES = new Set<TaskStatus>(['done'])

/** Sub-bar of sort options — same triple the Team page filter bar
 *  exposes so the two flows feel consistent. */
const SORT_OPTIONS: Array<{ value: MemberFilters['sort']; label: string }> = [
  { value: 'priority', label: 'Priority' },
  { value: 'dueDate', label: 'Due Date' },
  { value: 'newest', label: 'Newest' },
]

const PRIORITY_OPTIONS: Array<{ value: 'all' | Priority; label: string }> = [
  { value: 'all', label: 'All Priorities' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
]

const DUE_OPTIONS: Array<{ value: MemberFilters['due']; label: string }> = [
  { value: 'all', label: 'All Dates' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due Today' },
  { value: 'week', label: 'Due This Week' },
  { value: 'month', label: 'Due This Month' },
  { value: 'none', label: 'No Due Date' },
]

/** Colour vars for each status group's count badge — matches the
 *  board column dots. */
const STATUS_BADGE_VAR: Record<TaskStatus, string> = {
  todo: '--status-todo',
  in_progress: '--status-progress',
  in_review: '--status-review',
  done: '--status-done',
}

const FILTER_OWNER_KEY_SUFFIX = '__my'

type MyTasksView = 'list' | 'calendar'
const MY_TASKS_VIEW_KEY = 'team-manager.my-tasks-view'

function loadMyTasksView(): MyTasksView {
  if (typeof window === 'undefined') return 'list'
  try {
    return window.localStorage.getItem(MY_TASKS_VIEW_KEY) === 'calendar'
      ? 'calendar'
      : 'list'
  } catch {
    return 'list'
  }
}

function saveMyTasksView(view: MyTasksView): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(MY_TASKS_VIEW_KEY, view)
  } catch {
    // ignore
  }
}

export default function MyTasksPage() {
  useDocumentTitle('My Tasks')
  useScrollRestore()
  const { currentUser } = useAuth()
  const { tasks, projects, isInitialLoading } = useData()

  const projectById = useMemo<Map<string, Project>>(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  )

  // "My tasks" pulls in both (a) tasks the user is the parent assignee of
  // and (b) tasks where the user has a subtask assignment but isn't the
  // parent assignee. The second case carries viaSubtaskOnly=true so the
  // UI can render the "Subtask assigned to you" caption.
  const myTasks = useMemo<MyTaskEntry[]>(() => {
    if (!currentUser) return []
    const out: MyTaskEntry[] = []
    for (const t of tasks) {
      if (t.assigneeId === currentUser.id) {
        out.push({ task: t, viaSubtaskOnly: false })
        continue
      }
      if (t.subtasks.some((s) => s.assigneeId === currentUser.id)) {
        out.push({ task: t, viaSubtaskOnly: true })
      }
    }
    return out
  }, [tasks, currentUser])

  // Filter + sort state — persisted under a per-user key so a PM and
  // a member sharing a browser don't trample each other's pinned
  // filters. The suffix distinguishes "my tasks" state from the
  // similarly-shaped Team page filters.
  const filterKey = currentUser
    ? currentUser.id + FILTER_OWNER_KEY_SUFFIX
    : null
  const [filters, setFilters] = useState<MemberFilters>(() =>
    filterKey ? loadFilters(filterKey) : DEFAULT_FILTERS,
  )
  useEffect(() => {
    if (!filterKey) return
    saveFilters(filterKey, filters)
  }, [filterKey, filters])
  const setFilter = <K extends keyof MemberFilters>(
    key: K,
    value: MemberFilters[K],
  ) => setFilters((prev) => ({ ...prev, [key]: value }))
  const clearFilters = () =>
    setFilters((prev) => ({ ...DEFAULT_FILTERS, sort: prev.sort }))

  // Projects this user has tasks in — only these get a filter option.
  const myProjects = useMemo(() => {
    const ids = new Set<string>()
    for (const entry of myTasks) ids.add(entry.task.projectId)
    const out: Project[] = []
    for (const id of ids) {
      const p = projectById.get(id)
      if (p) out.push(p)
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }, [myTasks, projectById])

  // Apply filters → group by status. Two parallel views the renderer
  // picks between based on sort mode.
  const filteredEntries = useMemo(() => {
    if (filters.sort === 'priority') {
      // Grouped view — filter, then group; each group is sorted by
      // priority below.
      return myTasks.filter((e) => applyFilters([e.task], filters).length > 0)
    }
    // Flat view — single sorted list, no groups.
    const filtered = myTasks.filter(
      (e) => applyFilters([e.task], filters).length > 0,
    )
    const cmp =
      filters.sort === 'dueDate' ? compareByDueDate : compareByNewest
    return [...filtered].sort((a, b) => cmp(a.task, b.task))
  }, [myTasks, filters])

  const groupedByStatus = useMemo(() => {
    const out: Record<TaskStatus, MyTaskEntry[]> = {
      todo: [],
      in_progress: [],
      in_review: [],
      done: [],
    }
    for (const entry of filteredEntries) out[entry.task.status].push(entry)
    // Sort each group by priority — the "By priority" view's secondary
    // axis is overdue-then-due-soonest, handled by compareByPriority.
    for (const status of GROUP_STATUSES) {
      out[status].sort((a, b) => compareByPriority(a.task, b.task))
    }
    return out
  }, [filteredEntries])

  const filterCount = activeFilterCount(filters)
  const anyFilterActive = filterCount > 0

  const [view, setViewState] = useState<MyTasksView>(() => loadMyTasksView())
  const setView = (next: MyTasksView) => {
    setViewState(next)
    saveMyTasksView(next)
  }
  const { openTask } = useTaskPanel()
  const { openCreateTask } = useOutletContext<LayoutOutletContext>()

  // Calendar mode consumes the same filtered set as the list view —
  // mapped to CalendarItem[]. Tasks without a due date are surfaced
  // in the "No due date" sidebar rendered inside the calendar view.
  const calendarItems = useMemo<CalendarItem[]>(() => {
    return filteredEntries
      .filter((e) => e.task.dueDate)
      .map((e) => {
        const t = e.task
        const project = projectById.get(t.projectId)
        return {
          id: t.id,
          title: t.title,
          date: t.dueDate as string,
          type: 'task',
          priority: t.priority,
          status: STATUS_LABELS[t.status],
          projectId: t.projectId,
          projectName: project?.name,
          projectColor: project?.color,
          done: t.status === 'done',
          overdue: t.status !== 'done' && isOverdue(t.dueDate),
        }
      })
  }, [filteredEntries, projectById])
  const undatedEntries = useMemo(
    () => filteredEntries.filter((e) => !e.task.dueDate),
    [filteredEntries],
  )

  if (!currentUser) return null
  if (isInitialLoading) return <MyTasksSkeleton />

  const header = (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">
          My Tasks
        </h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Your assigned tasks across all projects.
        </p>
      </div>
      {/* View toggle — only surfaces when there are tasks to switch
          between. The empty-state under the header stays list-only. */}
      {myTasks.length > 0 && (
        <div
          role="radiogroup"
          aria-label="My Tasks view"
          className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-md bg-[var(--bg-elevated)] p-0.5"
        >
          <ViewButton
            icon={List}
            label="List"
            active={view === 'list'}
            onClick={() => setView('list')}
          />
          <ViewButton
            icon={CalendarDays}
            label="Calendar"
            active={view === 'calendar'}
            onClick={() => setView('calendar')}
          />
        </div>
      )}
    </header>
  )

  // No tasks at all → big empty-state under the header.
  if (myTasks.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyMyTasks />
      </div>
    )
  }

  return (
    <div data-tour="my-tasks-list" className="space-y-4 md:space-y-6">
      {header}

      <FilterToolbar
        filters={filters}
        onChange={setFilter}
        projects={myProjects}
        filterCount={filterCount}
      />

      {anyFilterActive && (
        <p className="px-1 text-[11px] text-[var(--text-secondary)] tabular-nums">
          Showing {filteredEntries.length} of {myTasks.length} tasks
        </p>
      )}

      {filteredEntries.length === 0 ? (
        <NoMatches onClear={clearFilters} />
      ) : view === 'calendar' ? (
        // Calendar mode — dated tasks land on the grid, undated ones
        // surface in a "No due date (N)" sidebar so nothing hides.
        <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
          <div className="min-w-0 flex-1">
            <CalendarView
              items={calendarItems}
              onItemClick={(item) => openTask(item.id)}
              onDateClick={() => openCreateTask()}
              headerCaption={`${calendarItems.length} task${calendarItems.length === 1 ? '' : 's'}`}
            />
          </div>
          {undatedEntries.length > 0 && (
            <aside className="w-full shrink-0 lg:w-[220px]">
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  No due date ({undatedEntries.length})
                </p>
                <ul className="flex flex-col gap-1">
                  {undatedEntries.map(({ task }) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        onClick={() => openTask(task.id)}
                        title={task.title}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
                      >
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{
                            backgroundColor: `var(--priority-${task.priority})`,
                          }}
                        />
                        <span className="truncate">{task.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </aside>
          )}
        </div>
      ) : filters.sort === 'priority' ? (
        // Grouped-by-status view. Each section is collapsible; Done
        // starts collapsed so the active queue dominates the page.
        <div className="space-y-6 md:space-y-8">
          {GROUP_STATUSES.map((status) => {
            const list = groupedByStatus[status]
            if (list.length === 0) return null
            return (
              <TaskSection
                key={status}
                title={STATUS_LABELS[status]}
                tasks={list}
                projectById={projectById}
                collapsible
                defaultCollapsed={DEFAULT_COLLAPSED_STATUSES.has(status)}
                badgeColorVar={STATUS_BADGE_VAR[status]}
                completedStyle={status === 'done'}
              />
            )
          })}
        </div>
      ) : (
        // Flat sort modes — no status grouping. Status pill on each
        // row still communicates the column it would land in.
        <TaskSection
          title="All Tasks"
          tasks={filteredEntries}
          projectById={projectById}
        />
      )}
    </div>
  )
}

// ── View toggle button ──────────────────────────────────────────────────────

function ViewButton({
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

// ── FilterToolbar ───────────────────────────────────────────────────────────

interface FilterToolbarProps {
  filters: MemberFilters
  onChange: <K extends keyof MemberFilters>(
    key: K,
    value: MemberFilters[K],
  ) => void
  projects: Project[]
  filterCount: number
}

function FilterToolbar({
  filters,
  onChange,
  projects,
  filterCount,
}: FilterToolbarProps) {
  const selectClass =
    'h-7 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-xs text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]'

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--bg-elevated)] p-3">
      <span className="text-[11px] uppercase tracking-[0.5px] text-[var(--text-secondary)]">
        Filter
      </span>

      <select
        aria-label="Filter by project"
        value={filters.projectId}
        onChange={(e) => onChange('projectId', e.target.value)}
        className={cn(selectClass, 'min-w-[140px]')}
      >
        <option value="all">All Projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by priority"
        value={filters.priority}
        onChange={(e) =>
          onChange('priority', e.target.value as 'all' | Priority)
        }
        className={cn(selectClass, 'min-w-[130px]')}
      >
        {PRIORITY_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by due date"
        value={filters.due}
        onChange={(e) =>
          onChange('due', e.target.value as MemberFilters['due'])
        }
        className={cn(selectClass, 'min-w-[130px]')}
      >
        {DUE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {filterCount > 0 && (
        <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
          ({filterCount} filter{filterCount === 1 ? '' : 's'})
        </span>
      )}

      <div
        role="tablist"
        aria-label="Sort tasks"
        className="ml-auto flex items-center gap-2 text-xs"
      >
        <span className="text-[11px] uppercase tracking-[0.5px] text-[var(--text-secondary)]">
          Sort
        </span>
        {SORT_OPTIONS.map((o, i) => {
          const active = filters.sort === o.value
          return (
            <span key={o.value} className="flex items-center gap-2">
              {i > 0 && (
                <span className="text-[var(--text-muted)]" aria-hidden="true">
                  ·
                </span>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onChange('sort', o.value)}
                className={cn(
                  'rounded text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
                  active
                    ? 'text-[var(--text-primary)] underline underline-offset-2'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                )}
              >
                {o.label}
              </button>
            </span>
          )
        })}
      </div>
    </div>
  )
}

// ── Empty / no-match states ─────────────────────────────────────────────────

function EmptyMyTasks() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 px-6 py-10 text-center">
      {/* Larger illustration with a slow breathe — signals "alive,
          waiting for work" without being distracting. */}
      <span
        className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-[var(--bg-elevated)]"
        style={{ animation: 'gentlePulse 3s ease-in-out infinite' }}
      >
        <ListChecks
          className="h-8 w-8 text-[var(--accent-primary)]"
          strokeWidth={1.5}
          aria-hidden="true"
        />
      </span>
      <div className="max-w-sm">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">
          You&apos;re all caught up!
        </h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Tasks assigned to you from any project will appear here.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Link
          to="/board"
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-4 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        >
          Browse the board
        </Link>
        {/* Secondary affordance — sends a comment-style ping; not a
            real channel today, but the link signals where to look. */}
        <Link
          to="/team"
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-[var(--border-default)] bg-transparent px-4 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        >
          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
          Ask your PM
        </Link>
      </div>
    </div>
  )
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 px-4 py-8 text-center">
      <CheckCircle2
        className="h-6 w-6 text-[var(--text-muted)]"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <p className="text-sm text-[var(--text-secondary)]">
        No tasks match your filters.
      </p>
      <button
        type="button"
        onClick={onClear}
        className="mt-1 inline-flex items-center text-xs text-[var(--accent-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] focus-visible:rounded"
      >
        Clear filters
      </button>
    </div>
  )
}

// ── Loading skeleton ────────────────────────────────────────────────────────

function MyTasksSkeleton() {
  return (
    <div className="space-y-6 md:space-y-8">
      <SkeletonLine width="w-32" height="h-7" />
      {Array.from({ length: 3 }).map((_, section) => (
        <div key={section}>
          <SkeletonLine width="w-28" height="h-5" className="mb-3" />
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((__, row) => (
              <SkeletonCard key={row}>
                <div className="flex items-start gap-3">
                  <SkeletonLine width="w-5" height="h-5" className="rounded" />
                  <div className="flex-1 space-y-2">
                    <SkeletonLine height="h-4" />
                    <SkeletonLine width="w-32" height="h-3" />
                  </div>
                </div>
              </SkeletonCard>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

