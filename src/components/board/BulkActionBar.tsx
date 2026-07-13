import { useEffect, useRef, useState } from 'react'
import {
  AlertOctagon,
  Calendar,
  ChevronsDown,
  ChevronsUp,
  Equal,
  LayoutGrid,
  Trash2,
  UserPlus,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Avatar } from '@/components/shared/Avatar'
import { DueDatePicker } from '@/components/shared/DueDatePicker'
import { cn } from '@/lib/utils'
import {
  PRIORITY_LABELS,
  type Priority,
  type TaskStatus,
  type TeamMember,
} from '@/data/types'

interface BulkActionBarProps {
  count: number
  members: TeamMember[]
  statusLabels: Record<TaskStatus, string>
  columnOrder: TaskStatus[]
  onSetPriority: (priority: Priority) => void
  onAssign: (assigneeId: string | null) => void
  onSetDueDate: (dueDate: string | null) => void
  onMoveTo: (status: TaskStatus) => void
  onDelete: () => void
  onClear: () => void
}

const PRIORITY_ICONS: Record<Priority, LucideIcon> = {
  critical: AlertOctagon,
  high: ChevronsUp,
  medium: Equal,
  low: ChevronsDown,
}

const PRIORITY_COLOR_VAR: Record<Priority, string> = {
  critical: '--priority-critical',
  high: '--priority-high',
  medium: '--priority-medium',
  low: '--priority-low',
}

const PRIORITY_ORDER: Priority[] = ['critical', 'high', 'medium', 'low']

const ACTION_BUTTON_CLASS =
  'inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-base)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]'

export function BulkActionBar({
  count,
  members,
  statusLabels,
  columnOrder,
  onSetPriority,
  onAssign,
  onSetDueDate,
  onMoveTo,
  onDelete,
  onClear,
}: BulkActionBarProps) {
  // Mount → animate in. Tailwind only ships a static class set, so we toggle
  // a CSS-variable-driven transform state once after mount.
  const [shown, setShown] = useState(false)
  useEffect(() => {
    // Two-rAFs: first frame paints with translateY(100%), second triggers the transition.
    const handle = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setShown(true))
    })
    return () => window.cancelAnimationFrame(handle)
  }, [])

  return (
    <div
      data-bulk-bar="true"
      role="toolbar"
      aria-label={`Bulk actions for ${count} selected tasks`}
      className={cn(
        'pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 transition-transform duration-200 ease-out',
        shown ? 'translate-y-0' : 'translate-y-[120%]',
      )}
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-2 overflow-x-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 shadow-[0_4px_16px_rgba(0,0,0,0.3)]">
        <span className="shrink-0 px-1 text-sm font-medium text-[var(--text-primary)] tabular-nums">
          {count} {count === 1 ? 'task' : 'tasks'} selected
        </span>

        <div className="h-5 w-px shrink-0 bg-[var(--border-subtle)]" aria-hidden="true" />

        <PriorityMenu onPick={onSetPriority} />
        <AssigneeMenu members={members} onPick={onAssign} />
        <DueDateMenu onPick={onSetDueDate} />
        <StatusMenu
          statusLabels={statusLabels}
          columnOrder={columnOrder}
          onPick={onMoveTo}
        />

        <button
          type="button"
          onClick={onDelete}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[color-mix(in_srgb,var(--destructive)_40%,transparent)] bg-transparent px-3 text-xs font-medium text-[var(--destructive)] transition-colors hover:bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          Delete
        </button>

        <div className="h-5 w-px shrink-0 bg-[var(--border-subtle)]" aria-hidden="true" />

        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          title="Clear selection (Esc)"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

// ---------- Menus -----------------------------------------------------------

/**
 * Small click-to-open menu shared by every action button. Closes on outside
 * click and on Esc; the parent BulkActionBar still owns the bigger Esc-to-
 * clear-selection behavior, so we use stopPropagation on Esc here.
 */
function ActionMenu({
  label,
  icon: Icon,
  children,
}: {
  label: string
  icon: LucideIcon
  children: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={ACTION_BUTTON_CLASS}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full right-0 mb-2 min-w-[180px] overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] py-1 shadow-[0_4px_16px_rgba(0,0,0,0.3)]"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function MenuRow({
  children,
  onClick,
  destructive,
}: {
  children: React.ReactNode
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)]',
        destructive && 'text-[var(--destructive)]',
      )}
    >
      {children}
    </button>
  )
}

function PriorityMenu({
  onPick,
}: {
  onPick: (priority: Priority) => void
}) {
  return (
    <ActionMenu label="Set Priority" icon={AlertOctagon}>
      {(close) =>
        PRIORITY_ORDER.map((p) => {
          const Icon = PRIORITY_ICONS[p]
          return (
            <MenuRow
              key={p}
              onClick={() => {
                onPick(p)
                close()
              }}
            >
              <Icon
                className="h-4 w-4"
                style={{ color: `var(${PRIORITY_COLOR_VAR[p]})` }}
                aria-hidden="true"
              />
              {PRIORITY_LABELS[p]}
            </MenuRow>
          )
        })
      }
    </ActionMenu>
  )
}

function AssigneeMenu({
  members,
  onPick,
}: {
  members: TeamMember[]
  onPick: (id: string | null) => void
}) {
  return (
    <ActionMenu label="Assign to" icon={UserPlus}>
      {(close) => (
        <>
          <MenuRow
            onClick={() => {
              onPick(null)
              close()
            }}
          >
            <span
              aria-hidden="true"
              className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--bg-surface)] text-[10px] text-[var(--text-muted)]"
            >
              —
            </span>
            Unassigned
          </MenuRow>
          <div
            className="my-1 h-px bg-[var(--border-subtle)]"
            aria-hidden="true"
          />
          {members.map((m) => (
            <MenuRow
              key={m.id}
              onClick={() => {
                onPick(m.id)
                close()
              }}
            >
              <Avatar name={m.name} imageUrl={m.avatarUrl} size="xs" />
              <span className="truncate">{m.name}</span>
            </MenuRow>
          ))}
        </>
      )}
    </ActionMenu>
  )
}

function StatusMenu({
  statusLabels,
  columnOrder,
  onPick,
}: {
  statusLabels: Record<TaskStatus, string>
  columnOrder: TaskStatus[]
  onPick: (status: TaskStatus) => void
}) {
  return (
    <ActionMenu label="Move to" icon={LayoutGrid}>
      {(close) =>
        columnOrder.map((status) => (
          <MenuRow
            key={status}
            onClick={() => {
              onPick(status)
              close()
            }}
          >
            <span className="text-sm">{statusLabels[status]}</span>
          </MenuRow>
        ))
      }
    </ActionMenu>
  )
}

function DueDateMenu({
  onPick,
}: {
  onPick: (dueDate: string | null) => void
}) {
  return (
    <ActionMenu label="Set Due Date" icon={Calendar}>
      {(close) => (
        <div className="w-60">
          <DueDatePicker
            value={null}
            onChange={onPick}
            onClose={close}
          />
        </div>
      )}
    </ActionMenu>
  )
}
