import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { LayoutGrid, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { BoardColumn } from '@/components/board/BoardColumn'
import { BulkActionBar } from '@/components/board/BulkActionBar'
import {
  FilterBar,
  emptyFilters,
  hasActiveFilters,
  type BoardFilters,
} from '@/components/board/FilterBar'
import { TaskCard, type SelectModifiers } from '@/components/board/TaskCard'
import { TaskListView } from '@/components/board/TaskListView'
import { ViewToggle } from '@/components/board/ViewToggle'
import { ConfirmModal } from '@/components/shared/ConfirmModal'
import { SkeletonCard, SkeletonLine } from '@/components/shared/Skeleton'
import { useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { loadBoardView, saveBoardView, type BoardView as BoardViewMode } from '@/lib/board-view'
import {
  getProjectMembers,
  projectHasUnassignedTasks,
} from '@/lib/project-members'
import type { LayoutOutletContext } from '@/components/layout/Layout'
import type {
  Priority,
  Project,
  Task,
  TaskStatus,
  TeamMember,
} from '@/data/types'
import { useTaskPanel } from '@/data/task-panel'
import { CalendarView, type CalendarItem } from '@/components/CalendarView'
import { isOverdue } from '@/lib/date-utils'

const PRIORITY_BY_KEY: Record<string, Priority> = {
  '1': 'critical',
  '2': 'high',
  '3': 'medium',
  '4': 'low',
}

interface BoardViewProps {
  /** When set, the board is locked to a single project: the project
   *  filter dropdown disappears and the filter state's projectId is
   *  pinned to this value. Used by the Project Detail page's Board
   *  tab so the user stays in the project's context. */
  forcedProjectId?: string
}

/**
 * The board's filter bar, controls, columns/list, drag-and-drop,
 * bulk-action bar, and keyboard nav. Extracted from BoardPage so the
 * same component can be embedded inside ProjectDetailPage's Board tab.
 *
 * BoardView does NOT claim its own height — it expects its parent to
 * be a flex column with a constrained height; BoardView fills the
 * remaining space and lets each column scroll internally.
 */
export function BoardView({ forcedProjectId }: BoardViewProps) {
  const { currentUser, isPM } = useAuth()
  const {
    tasks,
    projects,
    teamMembers,
    activities,
    locallyModifiedTaskIds,
    snapshotIndex,
    updateTask,
    bulkUpdateTasks,
    bulkDeleteTasks,
    columnOrder,
    statusLabels,
    isInitialLoading,
  } = useData()
  const [searchParams] = useSearchParams()
  const { openCreateTask } = useOutletContext<LayoutOutletContext>()

  const [view, setViewState] = useState<BoardViewMode>(() => loadBoardView())
  const setView = useCallback((next: BoardViewMode) => {
    setViewState(next)
    saveBoardView(next)
  }, [])

  const [filters, setFilters] = useState<BoardFilters>(() => {
    if (forcedProjectId) {
      return { ...emptyFilters(), projectId: forcedProjectId }
    }
    return emptyFilters()
  })
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [bulkSelection, setBulkSelection] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  )
  const [bulkAnchor, setBulkAnchor] = useState<{
    id: string
    column: TaskStatus
  } | null>(null)
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)

  // Standalone: pre-filter by ?project= from the URL.
  // Embedded: keep the projectId pinned to forcedProjectId — guards
  // against any code path that might desync it.
  const projectParam = searchParams.get('project')
  useEffect(() => {
    if (forcedProjectId) {
      setFilters((f) =>
        f.projectId === forcedProjectId ? f : { ...f, projectId: forcedProjectId },
      )
      return
    }
    if (!projectParam) return
    const exists = projects.some((p) => p.id === projectParam)
    if (!exists) return
    setFilters((f) =>
      f.projectId === projectParam ? f : { ...f, projectId: projectParam },
    )
  }, [forcedProjectId, projectParam, projects])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  )

  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  )
  const memberById = useMemo(
    () => new Map(teamMembers.map((m) => [m.id, m])),
    [teamMembers],
  )

  const filteredTasks = useMemo(
    () => filterTasks(tasks, filters),
    [tasks, filters],
  )

  const atlasOriginalStatusLabelsByTask = useMemo(() => {
    const map = new Map<string, string>()
    for (const task of tasks) {
      const original = snapshotIndex.tasksById.get(task.id)
      if (!original) continue
      if (original.status === task.status) continue
      map.set(task.id, statusLabels[original.status])
    }
    return map
  }, [tasks, snapshotIndex, statusLabels])

  const unresolvedQuestionsByTask = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of activities) {
      if (a.type !== 'comment') continue
      if (a.commentLabel !== 'question') continue
      if (a.resolved === true) continue
      if (a.taskId === null) continue
      map.set(a.taskId, (map.get(a.taskId) ?? 0) + 1)
    }
    return map
  }, [activities])

  const tasksByStatus = useMemo(() => {
    const buckets: Record<TaskStatus, Task[]> = {
      todo: [],
      in_progress: [],
      in_review: [],
      done: [],
    }
    for (const t of filteredTasks) buckets[t.status].push(t)
    for (const s of Object.keys(buckets) as TaskStatus[]) {
      buckets[s].sort(sortTasks)
    }
    return buckets
  }, [filteredTasks])

  useEffect(() => {
    if (!selectedId) return
    const stillVisible = filteredTasks.some((t) => t.id === selectedId)
    if (!stillVisible) setSelectedId(null)
  }, [filteredTasks, selectedId])

  useEffect(() => {
    if (!selectedId) return
    const el = document.querySelector<HTMLElement>(
      `[data-task-id="${selectedId}"]`,
    )
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  const canDragTask = (task: Task): boolean => {
    if (!currentUser) return false
    if (isPM) return true
    return task.assigneeId === currentUser.id
  }

  const activeTask = activeDragId
    ? tasks.find((t) => t.id === activeDragId)
    : undefined

  const handleDragStart = (e: DragStartEvent) => {
    setActiveDragId(String(e.active.id))
  }

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    setActiveDragId(null)
    if (!over) return

    const taskId = String(active.id)
    const overData = over.data.current as { status?: TaskStatus } | undefined
    const targetStatus = overData?.status
    if (!targetStatus) return

    const task = tasks.find((t) => t.id === taskId)
    if (!task) return
    if (task.status === targetStatus) return
    if (!canDragTask(task)) return

    updateTask(taskId, { status: targetStatus }).catch(() => {
      toast.error('Could not move task. Please try again.')
    })
  }

  const moveSelection = (dir: 'left' | 'right' | 'up' | 'down') => {
    const firstCard = (col: TaskStatus): string | null =>
      tasksByStatus[col][0]?.id ?? null

    if (!selectedId) {
      const startCol = columnOrder.find((c) => tasksByStatus[c].length > 0)
      if (startCol) setSelectedId(firstCard(startCol))
      return
    }

    let col: TaskStatus | undefined
    let row = -1
    for (const c of columnOrder) {
      const idx = tasksByStatus[c].findIndex((t) => t.id === selectedId)
      if (idx >= 0) {
        col = c
        row = idx
        break
      }
    }
    if (!col || row < 0) return

    if (dir === 'up' || dir === 'down') {
      const list = tasksByStatus[col]
      const next = dir === 'up' ? row - 1 : row + 1
      if (next < 0 || next >= list.length) return
      const target = list[next]
      if (target) setSelectedId(target.id)
      return
    }

    const colIdx = columnOrder.indexOf(col)
    const step = dir === 'left' ? -1 : 1
    for (let i = colIdx + step; i >= 0 && i < columnOrder.length; i += step) {
      const target = columnOrder[i]
      if (!target) break
      const list = tasksByStatus[target]
      if (list.length === 0) continue
      const clampedRow = Math.min(row, list.length - 1)
      const next = list[clampedRow]
      if (next) setSelectedId(next.id)
      return
    }
  }

  const openSelected = () => {
    if (!selectedId) return
    const el = document.querySelector<HTMLElement>(
      `[data-task-id="${selectedId}"]`,
    )
    el?.click()
  }

  const setPriorityForSelected = (priority: Priority) => {
    if (!selectedId || !isPM) return
    updateTask(selectedId, { priority }).catch(() => {
      toast.error('Could not change priority.')
    })
  }

  // --- Multi-select ------------------------------------------------------
  const clearBulkSelection = useCallback(() => {
    setBulkSelection((prev) => (prev.size === 0 ? prev : new Set()))
    setBulkAnchor(null)
  }, [])

  const findTaskColumn = useCallback(
    (id: string): TaskStatus | null => {
      for (const c of columnOrder) {
        if (tasksByStatus[c].some((t) => t.id === id)) return c
      }
      return null
    },
    [columnOrder, tasksByStatus],
  )

  const handleSelectToggle = useCallback(
    (id: string, mods: SelectModifiers) => {
      if (!isPM) return
      const column = findTaskColumn(id)
      if (!column) return

      if (mods.shift && bulkAnchor && bulkAnchor.column === column) {
        const list = tasksByStatus[column]
        const a = list.findIndex((t) => t.id === bulkAnchor.id)
        const b = list.findIndex((t) => t.id === id)
        if (a < 0 || b < 0) return
        const [lo, hi] = a < b ? [a, b] : [b, a]
        const ids = list.slice(lo, hi + 1).map((t) => t.id)
        setBulkSelection((prev) => {
          const next = new Set(prev)
          ids.forEach((tid) => next.add(tid))
          return next
        })
        setBulkAnchor({ id, column })
        return
      }

      setBulkSelection((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      setBulkAnchor({ id, column })
    },
    [bulkAnchor, findTaskColumn, isPM, tasksByStatus],
  )

  useEffect(() => {
    if (bulkSelection.size === 0) return
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      if (
        t.closest('[data-task-id]') ||
        t.closest('[data-bulk-bar="true"]') ||
        t.closest('[role="dialog"]')
      ) {
        return
      }
      clearBulkSelection()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [bulkSelection.size, clearBulkSelection])

  useEffect(() => {
    if (bulkSelection.size === 0) return
    const visible = new Set(filteredTasks.map((t) => t.id))
    let changed = false
    const next = new Set<string>()
    bulkSelection.forEach((id) => {
      if (visible.has(id)) next.add(id)
      else changed = true
    })
    if (changed) {
      setBulkSelection(next)
      if (bulkAnchor && !visible.has(bulkAnchor.id)) setBulkAnchor(null)
    }
  }, [filteredTasks, bulkSelection, bulkAnchor])

  const selectionActive = bulkSelection.size > 0
  const selectedIds = useMemo(() => Array.from(bulkSelection), [bulkSelection])

  const runBulk = async (
    label: string,
    op: () => Promise<void>,
  ) => {
    try {
      await op()
      const n = selectedIds.length
      toast.success(`Updated ${n} task${n === 1 ? '' : 's'}.`)
      clearBulkSelection()
    } catch {
      toast.error(`Could not ${label}.`)
    }
  }

  const handleBulkSetPriority = (priority: Priority) =>
    runBulk('change priority', () => bulkUpdateTasks(selectedIds, { priority }))
  const handleBulkAssign = (assigneeId: string | null) =>
    runBulk('reassign tasks', () =>
      bulkUpdateTasks(selectedIds, { assigneeId }),
    )
  const handleBulkSetDueDate = (dueDate: string | null) =>
    runBulk('change due date', () => bulkUpdateTasks(selectedIds, { dueDate }))
  const handleBulkMoveTo = (status: TaskStatus) =>
    runBulk('move tasks', () => bulkUpdateTasks(selectedIds, { status }))
  const handleBulkDelete = async () => {
    const n = selectedIds.length
    setBulkConfirmOpen(false)
    try {
      await bulkDeleteTasks(selectedIds)
      toast.success(`Deleted ${n} task${n === 1 ? '' : 's'}.`)
      clearBulkSelection()
    } catch {
      toast.error('Could not delete tasks.')
    }
  }

  useKeyboardShortcuts(
    [
      {
        key: 'Escape',
        handler: () => {
          if (selectionActive) clearBulkSelection()
        },
      },
      { key: 'ArrowLeft', handler: () => moveSelection('left') },
      { key: 'ArrowRight', handler: () => moveSelection('right') },
      { key: 'ArrowUp', handler: () => moveSelection('up') },
      { key: 'ArrowDown', handler: () => moveSelection('down') },
      { key: 'Enter', handler: openSelected },
      {
        key: ['1', '2', '3', '4'],
        handler: (e) => {
          const p = PRIORITY_BY_KEY[e.key]
          if (p) setPriorityForSelected(p)
        },
      },
    ],
    view === 'kanban',
  )

  useEffect(() => {
    if (bulkSelection.size > 0) clearBulkSelection()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  const hasAnyTasks = forcedProjectId
    ? tasks.some((t) => t.projectId === forcedProjectId)
    : tasks.length > 0
  // In embedded mode the project filter is locked and shouldn't count
  // as "active" — otherwise the no-matches helper would offer a Clear
  // button that can't actually clear it.
  const userFiltersActive = hasActiveFilters({
    ...filters,
    projectId: forcedProjectId ? 'all' : filters.projectId,
  })
  const filtersMatchNothing = userFiltersActive && filteredTasks.length === 0

  // Effective project scope for the assignee filter dropdown. Embedded
  // mode pins it; standalone respects the current dropdown selection
  // (null when "All Projects" is selected → full roster shows).
  const scopedProjectId =
    forcedProjectId ?? (filters.projectId === 'all' ? null : filters.projectId)

  // Only people with at least one task in the scoped project. When no
  // project is scoped, fall back to the full alphabetized roster.
  const sortedMembersForFilter = useMemo(() => {
    if (scopedProjectId === null) {
      return [...teamMembers].sort((a, b) => a.name.localeCompare(b.name))
    }
    return getProjectMembers(scopedProjectId, tasks, teamMembers)
  }, [scopedProjectId, tasks, teamMembers])

  // "Unassigned" only makes sense as an option when an unassigned task
  // exists in scope. Globally we always show it (legacy behavior).
  const showUnassignedOption =
    scopedProjectId === null
      ? true
      : projectHasUnassignedTasks(scopedProjectId, tasks)

  // When the project filter changes, reset the assignee selection if
  // it's no longer reachable. Skipped on first render via a ref so we
  // never fire a toast at mount time.
  const prevScopedProjectId = useRef<string | null>(scopedProjectId)
  useEffect(() => {
    const previous = prevScopedProjectId.current
    prevScopedProjectId.current = scopedProjectId
    if (previous === scopedProjectId) return
    if (scopedProjectId === null) return // Switched back to All Projects

    const current = filters.assigneeId
    if (current === 'all') return
    const stillUnassigned =
      current === 'unassigned' && showUnassignedOption
    const stillAvailable =
      current !== 'unassigned' &&
      sortedMembersForFilter.some((m) => m.id === current)
    if (stillUnassigned || stillAvailable) return

    // The selected assignee has no tasks in the new project — reset
    // and let the user know which member they lost.
    const droppedName =
      current === 'unassigned'
        ? 'Unassigned'
        : teamMembers.find((m) => m.id === current)?.name ?? current
    const projectName =
      projects.find((p) => p.id === scopedProjectId)?.name ?? 'this project'
    setFilters((f) => ({ ...f, assigneeId: 'all' }))
    toast(`Filter reset — ${droppedName} has no tasks in ${projectName}.`, {
      duration: 4000,
    })
    // We intentionally only react to project changes. Avoid retrigger
    // on assignee/teamMembers churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedProjectId])

  const newTaskProjectId = forcedProjectId
    ? forcedProjectId
    : filters.projectId !== 'all'
      ? filters.projectId
      : undefined

  const clearUserFilters = () => {
    setFilters({
      ...emptyFilters(),
      projectId: forcedProjectId ?? 'all',
    })
  }

  if (isInitialLoading) {
    return <BoardSkeleton columnOrder={columnOrder} />
  }

  return (
    <>
      <div className="sticky top-0 z-20 shrink-0 bg-[var(--bg-base)]">
        <div className="flex flex-wrap items-center gap-2 md:gap-3">
          <div className="min-w-0 flex-1">
            <FilterBar
              projects={projects}
              members={sortedMembersForFilter}
              filters={filters}
              onChange={setFilters}
              hideProjectFilter={Boolean(forcedProjectId)}
              showUnassignedOption={showUnassignedOption}
            />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ViewToggle value={view} onChange={setView} />
            {isPM && projects.some((p) => !p.archived) && (
              <button
                type="button"
                onClick={() => openCreateTask(newTaskProjectId)}
                title="Create a new task (C)"
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-3 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                New Task
                {/* Shortcut badge — kbd-style chip showing the global
                    "C" binding registered in src/lib/shortcuts.ts. */}
                <kbd
                  aria-hidden="true"
                  className="hidden h-5 items-center justify-center rounded bg-[color-mix(in_srgb,var(--text-inverse)_25%,transparent)] px-1.5 text-[10px] font-semibold leading-none text-[var(--text-inverse)] sm:inline-flex"
                >
                  C
                </kbd>
              </button>
            )}
          </div>
        </div>
      </div>

      {!hasAnyTasks ? (
        <EmptyBoard />
      ) : filtersMatchNothing ? (
        <NoMatches onClear={clearUserFilters} />
      ) : view === 'list' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TaskListView
            tasks={filteredTasks}
            projects={projects}
            members={teamMembers}
          />
        </div>
      ) : view === 'calendar' ? (
        <BoardCalendarView
          tasks={filteredTasks}
          projectById={projectById}
          memberById={memberById}
        />
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveDragId(null)}
        >
          <div className="-mx-4 min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-4 md:mx-0 md:px-0">
            <div className="flex h-full min-w-max gap-3 md:min-w-0 md:gap-4">
              {columnOrder.map((status) => (
                <BoardColumn
                  key={status}
                  status={status}
                  tasks={tasksByStatus[status]}
                  projectById={projectById}
                  memberById={memberById}
                  unresolvedQuestionsByTask={unresolvedQuestionsByTask}
                  locallyModifiedTaskIds={locallyModifiedTaskIds}
                  atlasOriginalStatusLabelsByTask={atlasOriginalStatusLabelsByTask}
                  draggingTaskId={activeDragId}
                  canDragTask={canDragTask}
                  selectedTaskId={selectedId}
                  onSelect={setSelectedId}
                  bulkSelection={bulkSelection}
                  selectionActive={selectionActive}
                  onSelectToggle={handleSelectToggle}
                  // Empty-column CTA — only PMs can create tasks, and
                  // we still require an unarchived project for the
                  // modal to land somewhere valid.
                  onAddTask={
                    isPM && projects.some((p) => !p.archived)
                      ? () => openCreateTask(newTaskProjectId)
                      : undefined
                  }
                />
              ))}
            </div>
          </div>

          <DragOverlay dropAnimation={null}>
            {activeTask ? (
              <TaskCard
                task={activeTask}
                project={projectById.get(activeTask.projectId)}
                assignee={
                  activeTask.assigneeId
                    ? memberById.get(activeTask.assigneeId)
                    : undefined
                }
                draggable={false}
                overlay
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {bulkSelection.size >= 2 && (
        <BulkActionBar
          count={bulkSelection.size}
          members={sortedMembersForFilter}
          statusLabels={statusLabels}
          columnOrder={columnOrder}
          onSetPriority={handleBulkSetPriority}
          onAssign={handleBulkAssign}
          onSetDueDate={handleBulkSetDueDate}
          onMoveTo={handleBulkMoveTo}
          onDelete={() => setBulkConfirmOpen(true)}
          onClear={clearBulkSelection}
        />
      )}

      <ConfirmModal
        open={bulkConfirmOpen}
        title={`Delete ${bulkSelection.size} task${bulkSelection.size === 1 ? '' : 's'}?`}
        message={
          <>
            This will permanently delete the selected task
            {bulkSelection.size === 1 ? '' : 's'}, along with their activity
            and notifications. This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={handleBulkDelete}
        onCancel={() => setBulkConfirmOpen(false)}
      />
    </>
  )
}

export function BoardSkeleton({ columnOrder }: { columnOrder: TaskStatus[] }) {
  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <SkeletonLine width="w-24" height="h-7" />
          <SkeletonLine width="w-64" height="h-3" className="mt-2" />
        </div>
      </div>
      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <div className="flex gap-3 md:gap-4">
          {columnOrder.map((status) => (
            <div
              key={status}
              className="flex w-[280px] shrink-0 flex-col md:min-w-[280px] md:flex-1"
            >
              <SkeletonLine width="w-20" height="h-3" className="mb-3" />
              <div className="flex flex-col gap-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <SkeletonCard key={i}>
                    <SkeletonLine width="w-16" height="h-2" />
                    <SkeletonLine height="h-4" className="mt-2" />
                    <SkeletonLine width="w-5/6" height="h-4" className="mt-1" />
                    <div className="mt-3 flex items-center justify-between">
                      <SkeletonLine width="w-14" height="h-4" />
                      <SkeletonLine width="w-6" height="h-6" className="rounded-full" />
                    </div>
                  </SkeletonCard>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function EmptyBoard() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border-subtle)] px-6 py-12 text-center">
      <LayoutGrid
        className="h-12 w-12 text-[var(--text-muted)]"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <h2 className="mt-4 text-base font-medium text-[var(--text-secondary)]">
        No tasks on the board
      </h2>
      <p className="mt-1 max-w-sm text-sm text-[var(--text-muted)]">
        Create a task in a project to get started.
      </p>
      <Link
        to="/projects"
        className="mt-5 inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-primary)] px-4 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
      >
        Browse projects
      </Link>
    </div>
  )
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border-subtle)] px-6 py-12 text-center">
      <p className="text-sm text-[var(--text-secondary)]">No tasks match your filters.</p>
      <button
        type="button"
        onClick={onClear}
        className="mt-3 text-sm font-medium text-[var(--accent-primary)] underline-offset-2 transition-colors hover:text-[var(--accent-hover)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] rounded"
      >
        Clear filters
      </button>
    </div>
  )
}

// ── Calendar view ───────────────────────────────────────────────────────────

/**
 * Renders the currently-filtered task set as a monthly calendar plus
 * a "No Due Date" sidebar for undated tasks. Clicks on tasks open the
 * detail panel; clicks on empty day cells fire Quick Create (date
 * pre-fill isn't wired yet — Layout's openCreateTask signature would
 * need to accept a date argument first).
 */
function BoardCalendarView({
  tasks,
  projectById,
  memberById,
}: {
  tasks: Task[]
  projectById: Map<string, Project>
  memberById: Map<string, TeamMember>
}) {
  const { openTask } = useTaskPanel()
  const { openCreateTask } = useOutletContext<LayoutOutletContext>()

  const dated = tasks.filter((t) => t.dueDate)
  const undated = tasks.filter((t) => !t.dueDate)

  const items = useMemo<CalendarItem[]>(
    () =>
      dated.map((t) => {
        const project = projectById.get(t.projectId)
        const assignee = t.assigneeId ? memberById.get(t.assigneeId) : undefined
        return {
          id: t.id,
          title: t.title,
          date: t.dueDate as string,
          type: 'task',
          priority: t.priority,
          status: t.status,
          assignee: assignee?.name ?? null,
          projectId: t.projectId,
          projectName: project?.name,
          projectColor: project?.color,
          done: t.status === 'done',
          overdue: t.status !== 'done' && isOverdue(t.dueDate),
        }
      }),
    [dated, projectById, memberById],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto lg:flex-row">
      <div className="min-w-0 flex-1">
        <CalendarView
          items={items}
          onItemClick={(item) => openTask(item.id)}
          onDateClick={() => openCreateTask()}
          headerCaption={`${items.length} task${items.length === 1 ? '' : 's'}`}
        />
      </div>
      {undated.length > 0 && (
        <aside className="w-full shrink-0 lg:w-[220px]">
          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              No due date ({undated.length})
            </p>
            <ul className="flex flex-col gap-1">
              {undated.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => openTask(t.id)}
                    title={t.title}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
                  >
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: `var(--priority-${t.priority})`,
                      }}
                    />
                    <span className="truncate">{t.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      )}
    </div>
  )
}

function filterTasks(tasks: Task[], f: BoardFilters): Task[] {
  const query = f.search.trim().toLowerCase()
  return tasks.filter((t) => {
    if (f.projectId !== 'all' && t.projectId !== f.projectId) return false
    if (f.assigneeId === 'unassigned') {
      if (t.assigneeId !== null) return false
    } else if (f.assigneeId !== 'all') {
      if (t.assigneeId !== f.assigneeId) return false
    }
    if (f.priority !== 'all' && t.priority !== f.priority) return false
    if (query && !t.title.toLowerCase().includes(query)) return false
    return true
  })
}

const PRIORITY_RANK: Record<Task['priority'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

function sortTasks(a: Task, b: Task): number {
  const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  if (p !== 0) return p
  if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
  if (a.dueDate) return -1
  if (b.dueDate) return 1
  return a.createdAt.localeCompare(b.createdAt)
}
