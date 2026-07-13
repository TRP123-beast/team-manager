import { useEffect, useRef, useState } from 'react'
import { Calendar, Trash2 } from 'lucide-react'
import { Avatar } from '@/components/shared/Avatar'
import { DueDatePicker } from '@/components/shared/DueDatePicker'
import { cn } from '@/lib/utils'
import {
  DUE_TONE_CLASS,
  formatRelativeDueDate,
  relativeTime,
} from '@/lib/date-utils'
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  type Priority,
  type Project,
  type Task,
  type TaskStatus,
  type TeamMember,
} from '@/data/types'
import { useData } from '@/data/store'

interface TaskHeaderProps {
  task: Task
  project: Project | undefined
  members: TeamMember[]
  creator: TeamMember | undefined
  canEditTitle: boolean
  canChangeStatus: boolean
  canChangeAssignee: boolean
  canChangePriority: boolean
  canChangeDueDate: boolean
  canDelete: boolean
  onUpdateTitle: (next: string) => void
  onChangeStatus: (next: TaskStatus) => void
  onChangePriority: (next: Priority) => void
  onChangeAssignee: (next: string | null) => void
  onChangeDueDate: (next: string | null) => void
  onDelete: () => void
}

const SELECT_CLASS =
  'h-9 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-3 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-60'

export function TaskHeader({
  task,
  project,
  members,
  creator,
  canEditTitle,
  canChangeStatus,
  canChangeAssignee,
  canChangePriority,
  canChangeDueDate,
  canDelete,
  onUpdateTitle,
  onChangeStatus,
  onChangePriority,
  onChangeAssignee,
  onChangeDueDate,
  onDelete,
}: TaskHeaderProps) {
  const { statusLabels } = useData()
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(task.title)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editingTitle) setTitleDraft(task.title)
  }, [task.title, editingTitle])

  useEffect(() => {
    if (editingTitle) titleRef.current?.select()
  }, [editingTitle])

  const commitTitle = () => {
    const next = titleDraft.trim()
    if (next && next !== task.title) {
      onUpdateTitle(next)
    } else {
      setTitleDraft(task.title)
    }
    setEditingTitle(false)
  }

  return (
    <header className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        {editingTitle ? (
          <input
            ref={titleRef}
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitTitle()
              } else if (e.key === 'Escape') {
                setTitleDraft(task.title)
                setEditingTitle(false)
              }
            }}
            className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-1 text-2xl font-semibold text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-focus)]"
          />
        ) : (
          <h1
            className={cn(
              'min-w-0 break-words text-2xl font-semibold text-[var(--text-primary)]',
              canEditTitle && 'cursor-text rounded px-1 -mx-1 hover:bg-[var(--bg-elevated)]',
            )}
            title={task.title}
            onClick={() => canEditTitle && setEditingTitle(true)}
            tabIndex={canEditTitle ? 0 : -1}
            onKeyDown={(e) => {
              if (canEditTitle && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                setEditingTitle(true)
              }
            }}
            role={canEditTitle ? 'button' : undefined}
            aria-label={canEditTitle ? 'Edit task title' : undefined}
          >
            {task.title}
          </h1>
        )}

        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            aria-label="Delete task"
            className="shrink-0 rounded-md p-2 text-[var(--text-secondary)] transition-colors hover:bg-[color-mix(in_srgb,var(--destructive)_15%,transparent)] hover:text-[var(--destructive)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      {project && (
        <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: project.color }}
            aria-hidden="true"
          />
          {project.name}
        </div>
      )}

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Status">
          <select
            id="task-status-select"
            aria-label="Status"
            value={task.status}
            disabled={!canChangeStatus}
            onChange={(e) => onChangeStatus(e.target.value as TaskStatus)}
            className={SELECT_CLASS}
            style={statusSelectStyle(task.status)}
          >
            {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((s) => (
              <option key={s} value={s}>
                {statusLabels[s]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Priority">
          <select
            id="task-priority-select"
            aria-label="Priority"
            value={task.priority}
            disabled={!canChangePriority}
            onChange={(e) => onChangePriority(e.target.value as Priority)}
            className={SELECT_CLASS}
            style={prioritySelectStyle(task.priority)}
          >
            {(Object.keys(PRIORITY_LABELS) as Priority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Assignee">
          <div className="flex items-center gap-2">
            {task.assigneeId && (() => {
              const a = members.find((m) => m.id === task.assigneeId)
              return (
                <Avatar
                  name={a?.name ?? 'Unknown'}
                  imageUrl={a?.avatarUrl}
                  size="sm"
                />
              )
            })()}
            <select
              id="task-assignee-select"
              aria-label="Assignee"
              value={task.assigneeId ?? ''}
              disabled={!canChangeAssignee}
              onChange={(e) => onChangeAssignee(e.target.value === '' ? null : e.target.value)}
              className={cn(SELECT_CLASS, 'flex-1')}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        </Field>

        <Field label="Due date">
          <DueDateField
            value={task.dueDate}
            disabled={!canChangeDueDate}
            done={task.status === 'done'}
            onChange={onChangeDueDate}
          />
        </Field>
      </dl>

      <p className="text-xs text-[var(--text-muted)]">
        Created {formatCreated(task.createdAt)}
        {creator && (
          <>
            {' '}
            by <span className="text-[var(--text-secondary)]">{creator.name}</span>
          </>
        )}
        {' · Updated '}
        {relativeTime(task.updatedAt)}
      </p>
    </header>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  )
}

/**
 * Click-to-open popover wrapping the shared DueDatePicker. Keeps the
 * `task-due-date` element id so the `D` keyboard shortcut on the task
 * detail page still focuses (and reveals) this control.
 */
function DueDateField({
  value,
  disabled,
  done,
  onChange,
}: {
  value: string | null
  disabled: boolean
  done: boolean
  onChange: (next: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const due = formatRelativeDueDate(value)
  const tone = done && due?.tone === 'critical' ? 'secondary' : due?.tone
  const overdue = !done && (due?.overdue ?? false)

  return (
    <div ref={containerRef} className="relative">
      <button
        id="task-due-date"
        type="button"
        aria-label={due ? `Due ${due.label} — click to change` : 'Set due date'}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-9 w-full items-center justify-between gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-3 text-sm outline-none transition-colors focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-60',
          overdue && 'border-l-[3px] border-l-[var(--priority-critical)]',
        )}
      >
        <span className="inline-flex items-center gap-2">
          <Calendar
            className="h-3.5 w-3.5 text-[var(--text-secondary)]"
            aria-hidden="true"
          />
          <span
            className={cn(
              due
                ? tone
                  ? DUE_TONE_CLASS[tone]
                  : 'text-[var(--text-primary)]'
                : 'text-[var(--text-muted)]',
            )}
          >
            {due ? due.label : 'Set due date'}
          </span>
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Due date"
          className="absolute left-0 top-full z-20 mt-1 w-64 rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[0_4px_16px_rgba(0,0,0,0.3)]"
        >
          <DueDatePicker
            value={value}
            onChange={onChange}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  )
}

function formatCreated(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

const STATUS_COLOR_VAR: Record<TaskStatus, string> = {
  todo: '--status-todo',
  in_progress: '--status-progress',
  in_review: '--status-review',
  done: '--status-done',
}

function statusSelectStyle(status: TaskStatus): React.CSSProperties {
  return {
    borderLeftColor: `var(${STATUS_COLOR_VAR[status]})`,
    borderLeftWidth: '3px',
  }
}

const PRIORITY_COLOR_VAR: Record<Priority, string> = {
  critical: '--priority-critical',
  high: '--priority-high',
  medium: '--priority-medium',
  low: '--priority-low',
}

function prioritySelectStyle(priority: Priority): React.CSSProperties {
  return {
    borderLeftColor: `var(${PRIORITY_COLOR_VAR[priority]})`,
    borderLeftWidth: '3px',
  }
}
