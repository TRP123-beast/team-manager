import { AlertTriangle, Check, CloudOff, RotateCw, User } from 'lucide-react'
import { useTaskPanel } from '@/data/task-panel'
import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { Avatar } from '@/components/shared/Avatar'
import { PriorityBadge } from '@/components/shared/PriorityBadge'
import { cn } from '@/lib/utils'
import { DUE_TONE_CLASS, formatRelativeDueDate } from '@/lib/date-utils'
import type { Project, Task, TeamMember } from '@/data/types'

export interface SelectModifiers {
  ctrl: boolean
  shift: boolean
}

interface TaskCardProps {
  task: Task
  project: Project | undefined
  assignee: TeamMember | undefined
  draggable: boolean
  /** True when this card is the one currently being dragged (so the source slot can be visually muted). */
  isDragging?: boolean
  /** When true, render as an "overlay" preview (used inside DragOverlay) — no draggable handle. */
  overlay?: boolean
  /** Renders the keyboard-navigation highlight ring. */
  selected?: boolean
  /** Called on click so the page can sync mouse and keyboard selection. */
  onSelect?: (taskId: string) => void
  /** True when this card is part of the multi-select set (renders the checkbox + blue border). */
  bulkSelected?: boolean
  /** True when any card on the board is multi-selected; disables drag site-wide. */
  selectionActive?: boolean
  /** Modifier-click handler. Called only when ctrl/cmd/shift is held. */
  onSelectToggle?: (taskId: string, mods: SelectModifiers) => void
  /** Number of unresolved Question comments on this task — drives the
   *  small "❓ N" badge next to the subtask progress. */
  unresolvedQuestions?: number
  /** True when this task has been edited locally in Atlas mode (and
   *  therefore won't match the API snapshot on the next refresh). Renders
   *  a small CloudOff badge so the user knows the change isn't synced. */
  isLocallyModified?: boolean
  /** Display label of the status Atlas still has for this task — set only
   *  when the local status differs from Atlas. Drives the RotateCw badge
   *  (overrides the CloudOff fallback) and its "Atlas still shows: X"
   *  tooltip. */
  atlasOriginalStatusLabel?: string | null
}

export function TaskCard({
  task,
  project,
  assignee,
  draggable,
  isDragging = false,
  overlay = false,
  selected = false,
  onSelect,
  bulkSelected = false,
  selectionActive = false,
  onSelectToggle,
  unresolvedQuestions = 0,
  isLocallyModified = false,
  atlasOriginalStatusLabel = null,
}: TaskCardProps) {
  const { openTask } = useTaskPanel()
  // Drag is disabled site-wide while multi-select is active so a stray
  // pointer-down on a card doesn't grab it instead of toggling selection.
  const dragDisabled = !draggable || overlay || selectionActive
  const draggableState = useDraggable({
    id: task.id,
    disabled: dragDisabled,
    data: { taskId: task.id, fromStatus: task.status },
  })

  const completed = task.subtasks.filter((s) => s.done).length
  const total = task.subtasks.length
  const due = formatRelativeDueDate(task.dueDate)
  // Done tasks never read as "overdue" even if their due date is past —
  // the work is finished, the urgency is irrelevant.
  const overdue = task.status !== 'done' && (due?.overdue ?? false)

  const handleClick = (e: React.MouseEvent) => {
    if (overlay) return
    // Modifier-click toggles multi-select; never navigates.
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      onSelectToggle?.(task.id, {
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
      })
      return
    }
    // Don't navigate while dragging or right after a drag pointer-up.
    if (draggableState.isDragging) {
      e.preventDefault()
      return
    }
    onSelect?.(task.id)
    openTask(task.id)
  }

  const style: React.CSSProperties = overlay
    ? {}
    : {
        transform: CSS.Translate.toString(draggableState.transform),
        cursor: dragDisabled
          ? 'pointer'
          : draggableState.isDragging
            ? 'grabbing'
            : 'grab',
        opacity: isDragging ? 0.4 : 1,
      }

  return (
    <article
      ref={overlay ? undefined : draggableState.setNodeRef}
      style={style}
      data-task-id={overlay ? undefined : task.id}
      {...(overlay ? {} : draggableState.attributes)}
      {...(overlay ? {} : draggableState.listeners)}
      onClick={overlay ? undefined : handleClick}
      onKeyDown={
        overlay
          ? undefined
          : (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                // Don't trigger nav from the drag activation keys; only on Enter without modifier-drag.
                if (e.key === 'Enter') {
                  e.preventDefault()
                  openTask(task.id)
                }
              }
            }
      }
      tabIndex={overlay ? -1 : 0}
      role={overlay ? undefined : 'button'}
      aria-label={`Open task ${task.title}`}
      aria-selected={selected || bulkSelected || undefined}
      className={cn(
        'group relative cursor-pointer select-none rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-left transition-all duration-150',
        // Lift effect on hover: drop-shadow grows, border picks up a hint
        // of accent colour, and the card nudges up 1px to feel grabbable.
        'hover:-translate-y-px hover:border-[color-mix(in_srgb,var(--accent-primary)_30%,var(--border-default))] hover:shadow-[0_8px_16px_rgba(0,0,0,0.25)]',
        'focus-visible:border-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
        // Subtle 2px red left border when overdue. Beats the regular border
        // so it stays visible even when the card is also selected / focused.
        overdue && 'border-l-2 border-l-[var(--priority-critical)]',
        selected && 'border-[var(--accent-primary)] ring-2 ring-[var(--accent-focus)]',
        bulkSelected &&
          'border-[var(--accent-primary)] ring-2 ring-[var(--accent-primary)]',
        overlay && 'rotate-2 opacity-90 shadow-[0_8px_24px_rgba(0,0,0,0.3)] cursor-grabbing',
      )}
    >
      {bulkSelected && !overlay && (
        <span
          aria-hidden="true"
          className="absolute -left-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent-primary)] text-[var(--text-inverse)] shadow-[0_1px_4px_rgba(0,0,0,0.35)]"
        >
          <Check className="h-3 w-3" strokeWidth={3} />
        </span>
      )}
      {isLocallyModified && !overlay && (
        <span
          className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--bg-elevated)] text-[var(--priority-medium)] shadow-[0_1px_4px_rgba(0,0,0,0.25)] ring-1 ring-[var(--border-subtle)]"
          title={
            atlasOriginalStatusLabel
              ? `Status changed locally. Atlas still shows: ${atlasOriginalStatusLabel}`
              : 'Local change — Atlas is read-only, so this edit only lives in this browser'
          }
          aria-label={
            atlasOriginalStatusLabel
              ? `Status changed locally; Atlas still shows ${atlasOriginalStatusLabel}`
              : 'Local change, not synced to Atlas'
          }
        >
          {atlasOriginalStatusLabel ? (
            <RotateCw className="h-3 w-3" aria-hidden="true" />
          ) : (
            <CloudOff className="h-3 w-3" aria-hidden="true" />
          )}
        </span>
      )}
      <div className="mb-2 flex items-center gap-2">
        {project ? (
          <>
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: project.color }}
              aria-hidden="true"
            />
            <span className="truncate text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
              {project.name}
            </span>
          </>
        ) : (
          // Tasks that never resolved to a project show "No project" in
          // the muted tone — distinct from a real project label, but
          // still occupies the same row so the visual rhythm holds.
          <span className="truncate text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
            No project
          </span>
        )}
      </div>

      <h3
        className="line-clamp-2 text-sm font-medium leading-snug text-[var(--text-primary)]"
        title={task.title}
      >
        {task.title}
      </h3>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <PriorityBadge priority={task.priority} />
        {due && (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium',
              overdue
                ? 'bg-[color-mix(in_srgb,var(--priority-critical)_15%,transparent)] text-[var(--priority-critical)]'
                : DUE_TONE_CLASS[due.tone],
            )}
          >
            {overdue && (
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            )}
            {due.label}
          </span>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-[var(--text-secondary)] tabular-nums">
          {total > 0 && (
            <>
              <span className="shrink-0">
                {completed}/{total}
              </span>
              <div
                className="h-1 w-20 overflow-hidden rounded-full bg-[var(--bg-elevated)]"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={completed}
              >
                <div
                  className="h-full bg-[var(--accent-primary)] transition-[width] duration-200"
                  style={{ width: total === 0 ? '0%' : `${(completed / total) * 100}%` }}
                />
              </div>
            </>
          )}
          {unresolvedQuestions > 0 && (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 text-[var(--priority-medium)]"
              title={`${unresolvedQuestions} unresolved ${unresolvedQuestions === 1 ? 'question' : 'questions'}`}
            >
              <span aria-hidden="true">❓</span>
              {unresolvedQuestions}
            </span>
          )}
        </div>

        {assignee ? (
          <Avatar
            name={assignee.name}
            imageUrl={assignee.avatarUrl}
            size="sm"
            title={assignee.name}
          />
        ) : (
          // Ghost avatar — same circular footprint as the real Avatar so
          // the card baseline doesn't shift, with a dashed border and a
          // muted user glyph signalling "no one yet".
          <span
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--border-default)] text-[var(--text-muted)]"
            aria-label="Unassigned"
            title="Unassigned"
          >
            <User className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
          </span>
        )}
      </div>
    </article>
  )
}

