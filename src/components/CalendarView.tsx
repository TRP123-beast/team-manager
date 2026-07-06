import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Priority } from '@/data/types'

/**
 * Shared monthly calendar. Renders a 6-row × 7-col grid (Mon-start),
 * with a header carrying prev/next navigation and a Today jump. Each
 * cell shows up to 3 item chips; excess opens a centred popover with
 * the full list.
 *
 * The component is timezone-safe: it operates on `YYYY-MM-DD` strings
 * for indexing / comparison and uses local-time Date getters (never
 * `toISOString()`, which would UTC-shift dates near midnight in
 * negative-offset timezones).
 */

export interface CalendarItem {
  id: string
  title: string
  /** `YYYY-MM-DD`. Compared as a plain string, never parsed to a
   *  Date object, so time-of-day / timezone shenanigans can't move
   *  the item off its calendar day. */
  date: string
  type: 'task' | 'meeting'
  priority?: Priority
  status?: string
  assignee?: string | null
  projectId?: string
  projectName?: string
  projectColor?: string
  /** True when the item is a completed task — chip renders strikethrough
   *  and dimmed. */
  done?: boolean
  /** True when the item is overdue and open — chip picks up an extra
   *  red accent. */
  overdue?: boolean
  metadata?: Record<string, unknown>
}

interface CalendarViewProps {
  items: CalendarItem[]
  onItemClick?: (item: CalendarItem) => void
  /** Called when the user clicks an empty area of a day cell. Passes
   *  the day's `YYYY-MM-DD` — callers use this to open Quick Create
   *  with a pre-filled due date. */
  onDateClick?: (date: string) => void
  /** Fired after prev/next/today nav so parents can prefetch data or
   *  update URLs. */
  onMonthChange?: (year: number, month: number) => void
  highlightToday?: boolean
  showNavigation?: boolean
  /** Optional caption shown to the right of the "Today" button — e.g.
   *  a count of items visible in the current view. Kept generic so
   *  each caller can label the calendar's contents. */
  headerCaption?: ReactNode
}

const PRIORITY_COLOR_VAR: Record<Priority, string> = {
  critical: '--priority-critical',
  high: '--priority-high',
  medium: '--priority-medium',
  low: '--priority-low',
}

/** Cap on chips rendered per cell before the "+N more" affordance
 *  takes over. Trims noise on dense days without losing access to
 *  the full list (the popover shows everything). */
const CHIPS_PER_CELL = 3

// ── Date helpers (all local-time, all string-safe) ──────────────────────────

function toYYYYMMDD(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function addMonths(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1)
}

/**
 * Build a 42-cell grid (6 rows × 7 cols, Mon-start) covering the
 * visible month plus leading/trailing days from the neighbours to
 * fill the first/last row. Every returned date carries its
 * calendar day as a local-time value.
 */
function buildMonthGrid(monthAnchor: Date): Date[] {
  const first = startOfMonth(monthAnchor)
  const dow = first.getDay() // 0 = Sun
  const backfill = dow === 0 ? 6 : dow - 1 // Mon-start
  const start = new Date(first)
  start.setDate(start.getDate() - backfill)

  const grid: Date[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    grid.push(d)
  }
  return grid
}

// ── Component ───────────────────────────────────────────────────────────────

export function CalendarView({
  items,
  onItemClick,
  onDateClick,
  onMonthChange,
  highlightToday = true,
  showNavigation = true,
  headerCaption,
}: CalendarViewProps) {
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(new Date()))
  const [popoverDate, setPopoverDate] = useState<string | null>(null)

  const gridDates = useMemo(() => buildMonthGrid(viewMonth), [viewMonth])

  // Bucket items by ISO date for O(1) lookup during cell rendering.
  // Same-date items keep their input order — callers pre-sort when
  // ordering matters.
  const itemsByDate = useMemo(() => {
    const map = new Map<string, CalendarItem[]>()
    for (const item of items) {
      const bucket = map.get(item.date) ?? []
      bucket.push(item)
      map.set(item.date, bucket)
    }
    return map
  }, [items])

  const todayIso = useMemo(() => toYYYYMMDD(new Date()), [])
  const monthLabel = viewMonth.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })

  const nowMonth = new Date()
  const isCurrentMonth =
    viewMonth.getFullYear() === nowMonth.getFullYear() &&
    viewMonth.getMonth() === nowMonth.getMonth()

  const goPrev = useCallback(() => {
    setViewMonth((m) => {
      const next = addMonths(m, -1)
      onMonthChange?.(next.getFullYear(), next.getMonth())
      return next
    })
  }, [onMonthChange])
  const goNext = useCallback(() => {
    setViewMonth((m) => {
      const next = addMonths(m, 1)
      onMonthChange?.(next.getFullYear(), next.getMonth())
      return next
    })
  }, [onMonthChange])
  const goToday = useCallback(() => {
    const target = startOfMonth(new Date())
    setViewMonth(target)
    onMonthChange?.(target.getFullYear(), target.getMonth())
  }, [onMonthChange])

  // Left/right arrows page the month when the calendar has focus.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (popoverDate) return // popover handles its own keys
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrev()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNext()
      } else if (e.key === 't' || e.key === 'T') {
        goToday()
      }
    },
    [goPrev, goNext, goToday, popoverDate],
  )

  return (
    <div
      role="region"
      aria-label={`Calendar — ${monthLabel}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
    >
      {showNavigation && (
        <CalendarHeader
          monthLabel={monthLabel}
          onPrev={goPrev}
          onNext={goNext}
          onToday={goToday}
          showTodayButton={!isCurrentMonth}
          caption={headerCaption}
        />
      )}

      <DayOfWeekRow />

      <div className="grid grid-cols-7 border-t border-[var(--border-subtle)]">
        {gridDates.map((date, i) => {
          const iso = toYYYYMMDD(date)
          const dayItems = itemsByDate.get(iso) ?? []
          const inMonth = date.getMonth() === viewMonth.getMonth()
          const isToday = iso === todayIso && highlightToday
          return (
            <DayCell
              key={`${iso}-${i}`}
              date={date}
              iso={iso}
              items={dayItems}
              inMonth={inMonth}
              isToday={isToday}
              onItemClick={onItemClick}
              onDateClick={onDateClick}
              onShowMore={() => setPopoverDate(iso)}
            />
          )
        })}
      </div>

      {popoverDate && (
        <OverflowPopover
          date={popoverDate}
          items={itemsByDate.get(popoverDate) ?? []}
          onClose={() => setPopoverDate(null)}
          onItemClick={(item) => {
            setPopoverDate(null)
            onItemClick?.(item)
          }}
        />
      )}
    </div>
  )
}

// ── Header ──────────────────────────────────────────────────────────────────

function CalendarHeader({
  monthLabel,
  onPrev,
  onNext,
  onToday,
  showTodayButton,
  caption,
}: {
  monthLabel: string
  onPrev: () => void
  onNext: () => void
  onToday: () => void
  showTodayButton: boolean
  caption?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onPrev}
          aria-label="Previous month"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onNext}
          aria-label="Next month"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <h3 className="text-[18px] font-semibold text-[var(--text-primary)]">
        {monthLabel}
      </h3>
      <div className="flex items-center gap-2">
        {caption && (
          <span className="text-xs text-[var(--text-muted)] tabular-nums">
            {caption}
          </span>
        )}
        {showTodayButton && (
          <button
            type="button"
            onClick={onToday}
            className="inline-flex h-8 items-center rounded-md border border-[var(--border-default)] bg-transparent px-3 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            Today
          </button>
        )}
      </div>
    </div>
  )
}

// ── Day-of-week row ─────────────────────────────────────────────────────────

const DAY_LABELS: Array<{ label: string; weekend: boolean }> = [
  { label: 'Mon', weekend: false },
  { label: 'Tue', weekend: false },
  { label: 'Wed', weekend: false },
  { label: 'Thu', weekend: false },
  { label: 'Fri', weekend: false },
  { label: 'Sat', weekend: true },
  { label: 'Sun', weekend: true },
]

function DayOfWeekRow() {
  return (
    <div className="grid grid-cols-7 border-t border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40">
      {DAY_LABELS.map(({ label, weekend }) => (
        <div
          key={label}
          className={cn(
            'px-2 py-1.5 text-center text-[11px] font-semibold uppercase tracking-wide',
            weekend
              ? 'text-[var(--text-muted)]'
              : 'text-[var(--text-secondary)]',
          )}
        >
          {label}
        </div>
      ))}
    </div>
  )
}

// ── Day cell ────────────────────────────────────────────────────────────────

interface DayCellProps {
  date: Date
  iso: string
  items: CalendarItem[]
  inMonth: boolean
  isToday: boolean
  onItemClick?: (item: CalendarItem) => void
  onDateClick?: (date: string) => void
  onShowMore: () => void
}

function DayCell({
  date,
  iso,
  items,
  inMonth,
  isToday,
  onItemClick,
  onDateClick,
  onShowMore,
}: DayCellProps) {
  const visible = items.slice(0, CHIPS_PER_CELL)
  const overflow = Math.max(0, items.length - visible.length)

  // Only fire the "empty cell" click when the target is the cell
  // itself (not a chip or button inside it). Prevents chip clicks
  // from double-firing onDateClick.
  const handleCellClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    onDateClick?.(iso)
  }

  return (
    <div
      onClick={handleCellClick}
      className={cn(
        'group flex min-h-[100px] flex-col gap-0.5 border-b border-r border-[var(--border-subtle)] p-1 transition-colors md:min-h-[110px]',
        // Compact heights on smaller screens keep the grid usable on
        // narrow viewports without hiding structure.
        'max-md:min-h-[70px]',
        !inMonth && 'bg-[var(--bg-base)]/40',
        onDateClick && 'cursor-pointer hover:bg-[var(--bg-elevated)]/50',
      )}
    >
      {/* Date number — today gets a filled accent circle. Overflow
          days from adjacent months render in the muted colour. */}
      <div className="flex items-center justify-start pointer-events-none">
        <span
          className={cn(
            'inline-flex h-6 w-6 items-center justify-center rounded-full text-sm tabular-nums',
            isToday
              ? 'bg-[var(--accent-primary)] font-semibold text-[var(--text-inverse)]'
              : inMonth
                ? 'text-[var(--text-primary)]'
                : 'text-[var(--text-muted)]',
          )}
        >
          {date.getDate()}
        </span>
      </div>

      {visible.map((item) => (
        <CalendarChip key={item.id} item={item} onClick={onItemClick} />
      ))}
      {overflow > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onShowMore()
          }}
          className="rounded px-1 py-0.5 text-left text-[11px] font-medium text-[var(--accent-primary)] hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        >
          +{overflow} more
        </button>
      )}
    </div>
  )
}

// ── Item chip ───────────────────────────────────────────────────────────────

function CalendarChip({
  item,
  onClick,
}: {
  item: CalendarItem
  onClick?: (item: CalendarItem) => void
}) {
  const isTask = item.type === 'task'
  // Task chips inherit their priority colour; meeting chips use the
  // accent-primary hue. `overdue` outranks the priority tint so the
  // urgency reads.
  const borderVar = item.overdue
    ? '--priority-critical'
    : isTask
      ? item.priority
        ? PRIORITY_COLOR_VAR[item.priority]
        : '--text-muted'
      : '--accent-primary'

  const tooltip = [
    item.title,
    item.projectName ? `— ${item.projectName}` : null,
    item.assignee ? `· ${item.assignee}` : null,
    item.status ? `· ${item.status}` : null,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick?.(item)
      }}
      title={tooltip}
      style={{ borderLeftColor: `var(${borderVar})` }}
      className={cn(
        'group flex w-full items-center gap-1 rounded border-l-[3px] bg-[var(--bg-elevated)]/60 px-1.5 py-0.5 text-left text-[11px] leading-tight transition-colors',
        'hover:bg-[var(--bg-elevated)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
        item.done && 'opacity-50 line-through',
      )}
    >
      {!isTask && (
        <CalendarDays
          className="h-2.5 w-2.5 shrink-0 text-[var(--accent-primary)]"
          aria-hidden="true"
        />
      )}
      <span className="truncate text-[var(--text-primary)]">{item.title}</span>
    </button>
  )
}

// ── Overflow popover ────────────────────────────────────────────────────────

function OverflowPopover({
  date,
  items,
  onClose,
  onItemClick,
}: {
  date: string
  items: CalendarItem[]
  onClose: () => void
  onItemClick: (item: CalendarItem) => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const [year, month, day] = date.split('-').map(Number)
  const displayDate = new Date(
    year ?? 1970,
    (month ?? 1) - 1,
    day ?? 1,
  ).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-30 bg-black/30"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Items on ${displayDate}`}
        style={{ animation: 'modalIn 150ms ease-out' }}
        className="fixed left-1/2 top-1/2 z-40 w-full max-w-md -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
      >
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            {displayDate}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="max-h-[300px] overflow-y-auto p-2">
          {items.map((item) => (
            <li key={item.id}>
              <PopoverItem item={item} onClick={() => onItemClick(item)} />
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

function PopoverItem({
  item,
  onClick,
}: {
  item: CalendarItem
  onClick: () => void
}) {
  const isTask = item.type === 'task'
  const borderVar = item.overdue
    ? '--priority-critical'
    : isTask
      ? item.priority
        ? PRIORITY_COLOR_VAR[item.priority]
        : '--text-muted'
      : '--accent-primary'

  return (
    <button
      type="button"
      onClick={onClick}
      style={{ borderLeftColor: `var(${borderVar})` }}
      className={cn(
        'flex w-full items-start gap-2 rounded-md border-l-[3px] bg-[var(--bg-surface)] px-3 py-2 text-left transition-colors hover:bg-[var(--bg-elevated)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
        item.done && 'opacity-50',
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <p
          className={cn(
            'text-sm text-[var(--text-primary)]',
            item.done && 'line-through',
          )}
        >
          {item.title}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
          {item.projectName && (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  backgroundColor: item.projectColor ?? 'var(--text-muted)',
                }}
              />
              {item.projectName}
            </span>
          )}
          {item.priority && (
            <span className="uppercase tracking-wide">{item.priority}</span>
          )}
          {item.assignee && <span>· {item.assignee}</span>}
          {item.status && <span>· {item.status}</span>}
          {item.overdue && (
            <span className="rounded-full bg-[color-mix(in_srgb,var(--priority-critical)_15%,transparent)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--priority-critical)]">
              Overdue
            </span>
          )}
        </div>
      </div>
      {!isTask && (
        <CalendarDays
          className="h-3.5 w-3.5 shrink-0 text-[var(--accent-primary)]"
          aria-hidden="true"
        />
      )}
    </button>
  )
}
