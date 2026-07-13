import { useEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, GripVertical, UserPlus, X } from 'lucide-react'
import { Avatar } from '@/components/shared/Avatar'
import { cn } from '@/lib/utils'
import type { Subtask, TeamMember } from '@/data/types'

interface SubtaskRowProps {
  subtask: Subtask
  members: TeamMember[]
  canToggle: boolean
  canEdit: boolean
  canDelete: boolean
  canChangeAssignee: boolean
  canReorder: boolean
  /** When true, this row mounts straight into edit mode with the input focused. */
  autoFocusEdit?: boolean
  onToggle: () => void
  onUpdateTitle: (next: string) => void
  onChangeAssignee: (next: string | null) => void
  onDelete: () => void
  /** Called when the user presses Tab inside the inline-edit input. The
   *  parent commits the edit and creates a fresh placeholder row below. */
  onTabCreate?: () => void
}

export function SubtaskRow({
  subtask,
  members,
  canToggle,
  canEdit,
  canDelete,
  canChangeAssignee,
  canReorder,
  autoFocusEdit,
  onToggle,
  onUpdateTitle,
  onChangeAssignee,
  onDelete,
  onTabCreate,
}: SubtaskRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: subtask.id, disabled: !canReorder })

  const [editing, setEditing] = useState(autoFocusEdit ?? false)
  const [draft, setDraft] = useState(subtask.title)
  const inputRef = useRef<HTMLInputElement>(null)
  // Tracks whether the most recent commit was triggered by Tab so onBlur
  // (which also runs as focus moves) doesn't double-fire the create.
  const tabCreatedRef = useRef(false)

  useEffect(() => {
    if (!editing) setDraft(subtask.title)
  }, [subtask.title, editing])

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  // When the parent flags this row as freshly created via Tab, enter edit
  // mode on mount and focus the empty input.
  useEffect(() => {
    if (autoFocusEdit) {
      setEditing(true)
      queueMicrotask(() => inputRef.current?.focus())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const commit = () => {
    if (tabCreatedRef.current) {
      tabCreatedRef.current = false
      return
    }
    const next = draft.trim()
    if (next && next !== subtask.title) {
      onUpdateTitle(next)
    } else {
      setDraft(subtask.title)
    }
    setEditing(false)
  }

  const handleTab = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    tabCreatedRef.current = true
    const next = draft.trim()
    if (next && next !== subtask.title) {
      onUpdateTitle(next)
    }
    setEditing(false)
    onTabCreate?.()
  }

  const assignee: TeamMember | null = subtask.assigneeId
    ? members.find((m) => m.id === subtask.assigneeId) ?? null
    : null

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
      className={cn(
        'group/row flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-2 transition-colors hover:border-[var(--border-default)]',
      )}
    >
      <button
        type="button"
        {...(canReorder ? attributes : {})}
        {...(canReorder ? listeners : {})}
        aria-label={canReorder ? 'Reorder subtask' : undefined}
        tabIndex={canReorder ? 0 : -1}
        disabled={!canReorder}
        className={cn(
          'shrink-0 rounded p-0.5 text-[var(--text-muted)] transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
          canReorder
            ? 'cursor-grab opacity-0 hover:text-[var(--text-secondary)] active:cursor-grabbing group-hover/row:opacity-100 focus-visible:opacity-100'
            : 'invisible',
        )}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <button
        type="button"
        onClick={onToggle}
        disabled={!canToggle}
        aria-pressed={subtask.done}
        aria-label={subtask.done ? 'Mark not done' : 'Mark done'}
        className={cn(
          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
          subtask.done
            ? 'border-[var(--status-done)] bg-[var(--status-done)] text-[var(--text-inverse)]'
            : 'border-[var(--border-default)] bg-transparent hover:border-[var(--status-done)]',
          !canToggle && 'cursor-not-allowed opacity-60',
        )}
      >
        {subtask.done && <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />}
      </button>

      <AssigneePicker
        assignee={assignee}
        members={members}
        canEdit={canChangeAssignee}
        onChange={onChangeAssignee}
      />

      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            placeholder="Subtask title"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                setDraft(subtask.title)
                setEditing(false)
              } else if (e.key === 'Tab' && !e.shiftKey && onTabCreate) {
                handleTab(e)
              }
            }}
            className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1.5 py-0.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-focus)]"
          />
        ) : (
          <span
            role={canEdit ? 'button' : undefined}
            tabIndex={canEdit ? 0 : undefined}
            onClick={() => canEdit && setEditing(true)}
            onKeyDown={(e) => {
              if (canEdit && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                setEditing(true)
              }
            }}
            className={cn(
              'block truncate text-sm',
              subtask.done
                ? 'text-[var(--text-muted)] line-through'
                : 'text-[var(--text-primary)]',
              canEdit && 'cursor-text rounded px-1 -mx-1 hover:bg-[var(--bg-elevated)]',
            )}
          >
            {subtask.title || (
              <span className="italic text-[var(--text-muted)]">
                Untitled subtask
              </span>
            )}
          </span>
        )}
      </div>

      {canDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete subtask ${subtask.title || '(untitled)'}`}
          className="shrink-0 rounded p-1 text-[var(--text-muted)] opacity-0 transition-all hover:bg-[color-mix(in_srgb,var(--destructive)_15%,transparent)] hover:text-[var(--destructive)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] group-hover/row:opacity-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  )
}

interface AssigneePickerProps {
  assignee: TeamMember | null
  members: TeamMember[]
  canEdit: boolean
  onChange: (id: string | null) => void
}

/**
 * 20px avatar button — click opens a popover with Unassigned + each member.
 * Replaces the previous native <select> so the row stays compact and the
 * picker matches the rest of the app's popover style.
 */
function AssigneePicker({
  assignee,
  members,
  canEdit,
  onChange,
}: AssigneePickerProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const trigger = assignee ? (
    <Avatar
      name={assignee.name}
      imageUrl={assignee.avatarUrl}
      size="xs"
      title={assignee.name}
    />
  ) : (
    <span
      aria-hidden="true"
      className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-[var(--border-default)] text-[var(--text-muted)]"
    >
      <UserPlus className="h-3 w-3" />
    </span>
  )

  if (!canEdit) {
    return <span className="shrink-0">{trigger}</span>
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          assignee
            ? `Assigned to ${assignee.name} — click to change`
            : 'Unassigned — click to assign'
        }
        className="inline-flex h-5 w-5 items-center justify-center rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
      >
        {trigger}
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="Assignee"
          className="absolute left-0 top-full z-20 mt-1 max-h-56 w-56 overflow-y-auto rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] py-1 shadow-[0_4px_16px_rgba(0,0,0,0.3)]"
        >
          <li>
            <button
              type="button"
              role="option"
              aria-selected={assignee === null}
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)]"
            >
              <span
                aria-hidden="true"
                className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--bg-surface)] text-[10px] text-[var(--text-muted)]"
              >
                —
              </span>
              Unassigned
            </button>
          </li>
          {members.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                role="option"
                aria-selected={assignee?.id === m.id}
                onClick={() => {
                  onChange(m.id)
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)]"
              >
                <Avatar name={m.name} imageUrl={m.avatarUrl} size="xs" />
                <span className="truncate">{m.name}</span>
                {assignee?.id === m.id && (
                  <Check className="ml-auto h-3.5 w-3.5 text-[var(--accent-primary)]" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
