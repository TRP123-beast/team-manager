import { useEffect, useMemo, useRef, useState } from 'react'
import { useTaskPanel } from '@/data/task-panel'
import {
  ArrowDown,
  ArrowUp,
  Calendar,
  Check,
  UserPlus,
} from 'lucide-react'
import { toast } from 'sonner'
import { Avatar } from '@/components/shared/Avatar'
import { DueDatePicker as SharedDueDatePicker } from '@/components/shared/DueDatePicker'
import { PriorityBadge } from '@/components/shared/PriorityBadge'
import { StatusPill } from '@/components/shared/StatusPill'
import { useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import { DUE_TONE_CLASS, formatRelativeDueDate } from '@/lib/date-utils'
import { cn } from '@/lib/utils'
import {
  PRIORITY_LABELS,
  type Priority,
  type Project,
  type Task,
  type TaskStatus,
  type TeamMember,
} from '@/data/types'

interface TaskListViewProps {
  tasks: Task[]
  projects: Project[]
  members: TeamMember[]
}

type SortKey =
  | 'priority'
  | 'title'
  | 'project'
  | 'status'
  | 'assignee'
  | 'due'
  | 'progress'

type SortDir = 'asc' | 'desc'

interface SortState {
  /** When null, the default multi-key sort (priority → due) is used. */
  key: SortKey | null
  dir: SortDir
}

const PRIORITY_RANK: Record<Priority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

const COMPLETING_FADE_MS = 1_000
const CELL_FLASH_MS = 600

export function TaskListView({ tasks, projects, members }: TaskListViewProps) {
  const { openTask } = useTaskPanel()
  const { currentUser, isPM } = useAuth()
  const { updateTask, columnOrder, statusLabels } = useData()

  const [sort, setSort] = useState<SortState>({ key: null, dir: 'asc' })
  // taskId-set for the brief "just-marked-done" fade animation.
  const [completing, setCompleting] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  // `${taskId}:${field}` keys flash briefly after a successful inline edit.
  const [flashedCells, setFlashedCells] = useState<ReadonlySet<string>>(
    () => new Set(),
  )

  const flashCell = (taskId: string, field: string) => {
    const key = `${taskId}:${field}`
    setFlashedCells((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    window.setTimeout(() => {
      setFlashedCells((prev) => {
        if (!prev.has(key)) return prev
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }, CELL_FLASH_MS)
  }

  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  )
  const memberById = useMemo(
    () => new Map(members.map((m) => [m.id, m])),
    [members],
  )
  const columnIndex = useMemo(() => {
    const m = new Map<TaskStatus, number>()
    columnOrder.forEach((s, i) => m.set(s, i))
    return m
  }, [columnOrder])

  const sortedTasks = useMemo(
    () =>
      sortTasks(tasks, sort, {
        projectById,
        memberById,
        columnIndex,
      }),
    [tasks, sort, projectById, memberById, columnIndex],
  )

  const handleSortClick = (key: SortKey) => {
    setSort((prev) => {
      if (prev.key === key) {
        // Toggle direction on the same column.
        return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      }
      return { key, dir: 'asc' }
    })
  }

  const canEditStatus = (task: Task) => {
    if (!currentUser) return false
    return isPM || task.assigneeId === currentUser.id
  }
  const canEditDueDate = canEditStatus
  const canEditPriority = (_task: Task) => isPM
  const canEditAssignee = (_task: Task) => isPM
  const canMarkDone = canEditStatus

  const safeUpdate = async (
    task: Task,
    field: string,
    patch: Parameters<typeof updateTask>[1],
    label: string,
  ) => {
    try {
      await updateTask(task.id, patch)
      flashCell(task.id, field)
    } catch {
      toast.error(`Could not change ${label}.`)
    }
  }

  const handleCheck = async (task: Task) => {
    if (!canMarkDone(task)) return
    if (task.status === 'done') {
      // Uncheck → move back to To Do for symmetry.
      await safeUpdate(task, 'check', { status: 'todo' }, 'status')
      return
    }
    // Mark as completing for the strikethrough+fade animation window. We
    // hold full opacity for 1s, then drop into the muted "done" styling.
    setCompleting((prev) => {
      const next = new Set(prev)
      next.add(task.id)
      return next
    })
    await safeUpdate(task, 'check', { status: 'done' }, 'status')
    window.setTimeout(() => {
      setCompleting((prev) => {
        if (!prev.has(task.id)) return prev
        const next = new Set(prev)
        next.delete(task.id)
        return next
      })
    }, COMPLETING_FADE_MS)
  }

  if (sortedTasks.length === 0) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border-subtle)] px-6 py-12 text-center">
        <p className="text-sm text-[var(--text-secondary)]">
          No tasks match your filters.
        </p>
      </div>
    )
  }

  return (
    <div className="-mx-4 overflow-x-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] md:mx-0">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--border-subtle)] text-left text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
            <th className="w-10 px-3 py-2" aria-label="Mark done" />
            <SortHeader
              label="Title"
              sortKey="title"
              sort={sort}
              onClick={handleSortClick}
              className="px-2 py-2"
            />
            <SortHeader
              label="Project"
              sortKey="project"
              sort={sort}
              onClick={handleSortClick}
              className="hidden px-2 py-2 md:table-cell"
            />
            <SortHeader
              label="Status"
              sortKey="status"
              sort={sort}
              onClick={handleSortClick}
              className="px-2 py-2"
            />
            <SortHeader
              label="Priority"
              sortKey="priority"
              sort={sort}
              onClick={handleSortClick}
              className="px-2 py-2"
            />
            <SortHeader
              label="Assignee"
              sortKey="assignee"
              sort={sort}
              onClick={handleSortClick}
              className="px-2 py-2"
            />
            <SortHeader
              label="Due"
              sortKey="due"
              sort={sort}
              onClick={handleSortClick}
              className="px-2 py-2"
            />
            <SortHeader
              label="Subtasks"
              sortKey="progress"
              sort={sort}
              onClick={handleSortClick}
              className="hidden px-2 py-2 lg:table-cell"
            />
          </tr>
        </thead>
        <tbody>
          {sortedTasks.map((task) => {
            const project = projectById.get(task.projectId)
            const assignee = task.assigneeId
              ? memberById.get(task.assigneeId)
              : undefined
            const completed = task.subtasks.filter((s) => s.done).length
            const total = task.subtasks.length
            const isCompleting = completing.has(task.id)
            const isDone = task.status === 'done'

            return (
              <tr
                key={task.id}
                onClick={() => openTask(task.id)}
                className={cn(
                  'group h-10 cursor-pointer border-b border-[var(--border-subtle)] transition-opacity duration-700 last:border-b-0 hover:bg-[var(--bg-base)]',
                  // Done rows fade to muted opacity — UNLESS we're still in
                  // the 1s "just-completed" hold window, where we stay solid
                  // so the user sees the strikethrough animation play.
                  isDone && !isCompleting && 'opacity-50',
                )}
              >
                <td className="px-3 py-1" onClick={(e) => e.stopPropagation()}>
                  <CheckboxCell
                    checked={isDone}
                    disabled={!canMarkDone(task)}
                    onChange={() => handleCheck(task)}
                  />
                </td>

                <td className="max-w-[260px] px-2 py-1 md:max-w-[420px]">
                  <span
                    className={cn(
                      'relative inline-block max-w-full truncate align-middle font-medium text-[var(--text-primary)]',
                      isDone && 'text-[var(--text-secondary)]',
                    )}
                    title={task.title}
                  >
                    {task.title}
                    {(isCompleting || isDone) && (
                      <span
                        aria-hidden="true"
                        className={cn(
                          'pointer-events-none absolute left-0 top-1/2 h-px -translate-y-1/2 bg-current',
                          isCompleting
                            ? 'animate-[strikeIn_300ms_ease-out_forwards] w-full'
                            : 'w-full',
                        )}
                      />
                    )}
                  </span>
                </td>

                <td className="hidden px-2 py-1 md:table-cell">
                  {project ? (
                    <span className="inline-flex max-w-[180px] items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: project.color }}
                        aria-hidden="true"
                      />
                      <span className="truncate">{project.name}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-[var(--text-muted)]">—</span>
                  )}
                </td>

                <td
                  className={cn(
                    'px-2 py-1',
                    flashedCells.has(`${task.id}:status`) &&
                      'animate-[cellFlash_0.6s_ease-out]',
                  )}
                  onClick={(e) => e.stopPropagation()}
                >
                  <StatusCell
                    task={task}
                    canEdit={canEditStatus(task)}
                    statusLabels={statusLabels}
                    columnOrder={columnOrder}
                    onChange={(status) =>
                      safeUpdate(task, 'status', { status }, 'status')
                    }
                  />
                </td>

                <td
                  className={cn(
                    'px-2 py-1',
                    flashedCells.has(`${task.id}:priority`) &&
                      'animate-[cellFlash_0.6s_ease-out]',
                  )}
                  onClick={(e) => e.stopPropagation()}
                >
                  <PriorityCell
                    task={task}
                    canEdit={canEditPriority(task)}
                    onChange={(priority) =>
                      safeUpdate(task, 'priority', { priority }, 'priority')
                    }
                  />
                </td>

                <td
                  className={cn(
                    'px-2 py-1',
                    flashedCells.has(`${task.id}:assignee`) &&
                      'animate-[cellFlash_0.6s_ease-out]',
                  )}
                  onClick={(e) => e.stopPropagation()}
                >
                  <AssigneeCell
                    task={task}
                    assignee={assignee}
                    members={members}
                    canEdit={canEditAssignee(task)}
                    onChange={(assigneeId) =>
                      safeUpdate(
                        task,
                        'assignee',
                        { assigneeId },
                        'assignee',
                      )
                    }
                  />
                </td>

                <td
                  className={cn(
                    'px-2 py-1',
                    flashedCells.has(`${task.id}:due`) &&
                      'animate-[cellFlash_0.6s_ease-out]',
                  )}
                  onClick={(e) => e.stopPropagation()}
                >
                  <DueDateCell
                    task={task}
                    canEdit={canEditDueDate(task)}
                    onChange={(dueDate) =>
                      safeUpdate(task, 'due', { dueDate }, 'due date')
                    }
                  />
                </td>

                <td className="hidden px-2 py-1 lg:table-cell">
                  {total > 0 ? (
                    <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)] tabular-nums">
                      <span className="shrink-0">
                        {completed}/{total}
                      </span>
                      <div className="h-1 w-16 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
                        <div
                          className="h-full bg-[var(--accent-primary)] transition-[width] duration-200"
                          style={{
                            width: `${(completed / total) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  ) : (
                    <span className="text-xs text-[var(--text-muted)]">—</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---- Sort ------------------------------------------------------------------

function sortTasks(
  tasks: Task[],
  sort: SortState,
  lookup: {
    projectById: Map<string, Project>
    memberById: Map<string, TeamMember>
    columnIndex: Map<TaskStatus, number>
  },
): Task[] {
  const copy = [...tasks]
  const dir = sort.dir === 'desc' ? -1 : 1

  if (sort.key === null) {
    // Default: priority asc (critical first), then due date asc (soonest, nulls last).
    copy.sort((a, b) => {
      const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      if (p !== 0) return p
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
      if (a.dueDate) return -1
      if (b.dueDate) return 1
      return a.createdAt.localeCompare(b.createdAt)
    })
    return copy
  }

  copy.sort((a, b) => {
    let cmp = 0
    switch (sort.key) {
      case 'title':
        cmp = a.title.localeCompare(b.title)
        break
      case 'project': {
        const an = lookup.projectById.get(a.projectId)?.name ?? ''
        const bn = lookup.projectById.get(b.projectId)?.name ?? ''
        cmp = an.localeCompare(bn)
        break
      }
      case 'status': {
        const ai = lookup.columnIndex.get(a.status) ?? 0
        const bi = lookup.columnIndex.get(b.status) ?? 0
        cmp = ai - bi
        break
      }
      case 'priority':
        cmp = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
        break
      case 'assignee': {
        const an = a.assigneeId
          ? lookup.memberById.get(a.assigneeId)?.name ?? ''
          : ''
        const bn = b.assigneeId
          ? lookup.memberById.get(b.assigneeId)?.name ?? ''
          : ''
        // Unassigned (empty string) sorts last regardless of direction.
        if (!an && bn) return 1
        if (an && !bn) return -1
        cmp = an.localeCompare(bn)
        break
      }
      case 'due': {
        if (a.dueDate && b.dueDate) {
          cmp = a.dueDate.localeCompare(b.dueDate)
        } else if (a.dueDate) {
          return -1
        } else if (b.dueDate) {
          return 1
        }
        break
      }
      case 'progress': {
        const ar = a.subtasks.length === 0 ? -1 : a.subtasks.filter((s) => s.done).length / a.subtasks.length
        const br = b.subtasks.length === 0 ? -1 : b.subtasks.filter((s) => s.done).length / b.subtasks.length
        cmp = ar - br
        break
      }
    }
    if (cmp === 0) return a.createdAt.localeCompare(b.createdAt)
    return cmp * dir
  })
  return copy
}

// ---- Headers ---------------------------------------------------------------

interface SortHeaderProps {
  label: string
  sortKey: SortKey
  sort: SortState
  onClick: (key: SortKey) => void
  className?: string
}

function SortHeader({ label, sortKey, sort, onClick, className }: SortHeaderProps) {
  const active = sort.key === sortKey
  return (
    <th scope="col" className={className}>
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        aria-sort={
          active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
        }
        className={cn(
          'inline-flex items-center gap-1 rounded text-[11px] font-semibold uppercase tracking-[0.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
          active
            ? 'text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
        )}
      >
        {label}
        {active &&
          (sort.dir === 'asc' ? (
            <ArrowUp className="h-3 w-3" aria-hidden="true" />
          ) : (
            <ArrowDown className="h-3 w-3" aria-hidden="true" />
          ))}
      </button>
    </th>
  )
}

// ---- Editable cells --------------------------------------------------------

interface CheckboxCellProps {
  checked: boolean
  disabled: boolean
  onChange: () => void
}

function CheckboxCell({ checked, disabled, onChange }: CheckboxCellProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? 'Mark as not done' : 'Mark as done'}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onChange()
      }}
      className={cn(
        'inline-flex h-4 w-4 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
        checked
          ? 'border-[var(--status-done)] bg-[var(--status-done)] text-[var(--text-inverse)]'
          : 'border-[var(--border-default)] bg-transparent hover:border-[var(--accent-primary)]',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {checked && <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />}
    </button>
  )
}

/**
 * Generic popover wrapper used by every editable cell. Trigger renders the
 * cell's current display; the popover content is supplied by children.
 *
 * A transparent overlay sits between the popover and the rest of the page
 * so a "close on outside click" doesn't also fire the row's row-click
 * (mousedown on the overlay calls stopPropagation before the click can
 * bubble to the row).
 */
function Popover({
  open,
  onOpenChange,
  trigger,
  children,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  trigger: React.ReactNode
  children: (close: () => void) => React.ReactNode
}) {
  const triggerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onOpenChange(false)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onOpenChange])

  return (
    <div ref={triggerRef} className="relative inline-block">
      {trigger}
      {open && (
        <>
          <div
            className="fixed inset-0 z-30"
            onMouseDown={(e) => {
              e.stopPropagation()
              onOpenChange(false)
            }}
            onClick={(e) => e.stopPropagation()}
            aria-hidden="true"
          />
          <div
            role="menu"
            className="absolute left-0 top-full z-40 mt-1 min-w-[180px] overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] py-1 shadow-[0_4px_16px_rgba(0,0,0,0.3)]"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {children(() => onOpenChange(false))}
          </div>
        </>
      )}
    </div>
  )
}

interface StatusCellProps {
  task: Task
  canEdit: boolean
  statusLabels: Record<TaskStatus, string>
  columnOrder: TaskStatus[]
  onChange: (status: TaskStatus) => void
}

function StatusCell({
  task,
  canEdit,
  statusLabels,
  columnOrder,
  onChange,
}: StatusCellProps) {
  const [open, setOpen] = useState(false)
  const pill = <StatusPill status={task.status} />
  if (!canEdit) {
    return pill
  }
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={`Status: ${statusLabels[task.status]} — click to change`}
          className="rounded transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        >
          {pill}
        </button>
      }
    >
      {(close) =>
        columnOrder.map((status) => (
          <button
            key={status}
            type="button"
            role="menuitem"
            onClick={() => {
              onChange(status)
              close()
            }}
            className={cn(
              'flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm transition-colors hover:bg-[var(--bg-surface)]',
              task.status === status
                ? 'text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)]',
            )}
          >
            <span>{statusLabels[status]}</span>
            {task.status === status && (
              <Check className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
            )}
          </button>
        ))
      }
    </Popover>
  )
}

interface PriorityCellProps {
  task: Task
  canEdit: boolean
  onChange: (priority: Priority) => void
}

function PriorityCell({ task, canEdit, onChange }: PriorityCellProps) {
  const [open, setOpen] = useState(false)
  const badge = <PriorityBadge priority={task.priority} />
  if (!canEdit) return badge
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={`Priority: ${PRIORITY_LABELS[task.priority]} — click to change`}
          className="rounded transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        >
          {badge}
        </button>
      }
    >
      {(close) =>
        (Object.keys(PRIORITY_LABELS) as Priority[]).map((p) => (
          <button
            key={p}
            type="button"
            role="menuitem"
            onClick={() => {
              onChange(p)
              close()
            }}
            className={cn(
              'flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm transition-colors hover:bg-[var(--bg-surface)]',
            )}
          >
            <PriorityBadge priority={p} />
            {task.priority === p && (
              <Check className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
            )}
          </button>
        ))
      }
    </Popover>
  )
}

interface AssigneeCellProps {
  task: Task
  assignee: TeamMember | undefined
  members: TeamMember[]
  canEdit: boolean
  onChange: (id: string | null) => void
}

function AssigneeCell({
  task,
  assignee,
  members,
  canEdit,
  onChange,
}: AssigneeCellProps) {
  const [open, setOpen] = useState(false)
  const display = (
    <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
      {assignee ? (
        <>
          <Avatar name={assignee.name} imageUrl={assignee.avatarUrl} size="xs" />
          <span className="hidden truncate sm:inline">{assignee.name}</span>
        </>
      ) : (
        <>
          <span
            aria-hidden="true"
            className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--bg-elevated)] text-[10px] text-[var(--text-muted)]"
          >
            —
          </span>
          <span className="hidden sm:inline">Unassigned</span>
        </>
      )}
    </span>
  )
  if (!canEdit) return display
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={
            assignee
              ? `Assigned to ${assignee.name} — click to change`
              : 'Unassigned — click to assign'
          }
          className="rounded px-1 py-0.5 transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        >
          {display}
        </button>
      }
    >
      {(close) => (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onChange(null)
              close()
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)]"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--bg-surface)] text-[10px] text-[var(--text-muted)]"
            >
              <UserPlus className="h-3 w-3" />
            </span>
            Unassigned
          </button>
          <div className="my-1 h-px bg-[var(--border-subtle)]" aria-hidden="true" />
          {members.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitem"
              onClick={() => {
                onChange(m.id)
                close()
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)]',
              )}
            >
              <Avatar name={m.name} imageUrl={m.avatarUrl} size="xs" />
              <span className="truncate">{m.name}</span>
              {task.assigneeId === m.id && (
                <Check className="ml-auto h-3.5 w-3.5 text-[var(--accent-primary)]" />
              )}
            </button>
          ))}
        </>
      )}
    </Popover>
  )
}

interface DueDateCellProps {
  task: Task
  canEdit: boolean
  onChange: (dueDate: string | null) => void
}

function DueDateCell({ task, canEdit, onChange }: DueDateCellProps) {
  const [open, setOpen] = useState(false)
  const due = formatRelativeDueDate(task.dueDate)
  // Done tasks ignore overdue tone — completed work isn't "overdue".
  const tone =
    task.status === 'done' && due?.tone === 'critical' ? 'secondary' : due?.tone
  const display = (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs',
        due ? (tone ? DUE_TONE_CLASS[tone] : '') : 'text-[var(--text-muted)]',
      )}
    >
      <Calendar className="h-3 w-3" aria-hidden="true" />
      {due ? due.label : canEdit ? '+ due date' : ''}
    </span>
  )
  if (!canEdit) return display
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={
            due
              ? `Due ${due.label} — click to change`
              : 'No due date — click to set'
          }
          className="rounded px-1 py-0.5 transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        >
          {display}
        </button>
      }
    >
      {(close) => (
        <div className="w-60">
          <SharedDueDatePicker
            value={task.dueDate}
            onChange={onChange}
            onClose={close}
          />
        </div>
      )}
    </Popover>
  )
}
