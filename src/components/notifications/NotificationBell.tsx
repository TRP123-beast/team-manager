import { useEffect, useMemo, useRef, useState } from 'react'
import { useTaskPanel } from '@/data/task-panel'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowRight,
  AtSign,
  Bell,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  MessageSquare,
  UserPlus,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import { usePermissions } from '@/hooks/usePermissions'
import { relativeTime } from '@/lib/date-utils'
import {
  isNotifSoundEnabled,
  playNotificationSound,
} from '@/lib/notification-sound'
import { cn } from '@/lib/utils'
import type {
  Notification,
  NotificationType,
  Task,
  TeamMember,
} from '@/data/types'

const ICON_BY_TYPE: Record<NotificationType, LucideIcon> = {
  assigned: UserPlus,
  comment: MessageSquare,
  mention: AtSign,
  status_change: ArrowRight,
  due_tomorrow: Calendar,
  overdue: AlertTriangle,
}

const ICON_COLOR_BY_TYPE: Record<NotificationType, string> = {
  assigned: '--accent-primary',
  comment: '--text-secondary',
  mention: '--accent-primary',
  status_change: '--status-progress',
  due_tomorrow: '--priority-high',
  overdue: '--priority-critical',
}

const GROUP_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const MAX_NOTIFICATIONS = 30

interface NotificationGroup {
  /** Composite key — `${taskId}:${oldestId}` keeps it stable across re-renders. */
  key: string
  taskId: string
  notifications: Notification[]
  /** Highest createdAt timestamp in the group. */
  newest: string
  hasUnread: boolean
}

export function NotificationBell() {
  const { currentUser } = useAuth()
  const { canSeeAllTasks, canSeeTask } = usePermissions()
  const {
    notifications,
    tasks,
    teamMembers,
    markNotificationRead,
    markAllNotificationsRead,
  } = useData()
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const wrapperRef = useRef<HTMLDivElement>(null)
  const { openTask } = useTaskPanel()
  // Tracks the newest notification ID we've seen so we can chime exactly
  // once per new arrival without firing on initial mount.
  const prevNewestId = useRef<string | null>(null)

  // Build a lookup once so the recipient-filter can also drop
  // notifications pointing at tasks the current user has since lost
  // access to (e.g. a mention on a task in a project they were later
  // removed from). Without this, clicking the notification would land
  // on AccessDenied — bad UX.
  const tasksByIdForFilter = useMemo(
    () => new Map(tasks.map((t) => [t.id, t])),
    [tasks],
  )

  const myNotifications = useMemo(() => {
    if (!currentUser) return []
    return notifications
      .filter((n) => {
        if (n.recipientId !== currentUser.id) return false
        if (canSeeAllTasks) return true
        // Filter to tasks the user can still see. Unknown taskIds
        // (tasks deleted or not yet loaded) are hidden — safer to
        // omit than to route the user into a broken state.
        const t = tasksByIdForFilter.get(n.taskId)
        return t ? canSeeTask(t) : false
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_NOTIFICATIONS)
  }, [notifications, currentUser, canSeeAllTasks, canSeeTask, tasksByIdForFilter])

  const unreadCount = useMemo(
    () => myNotifications.filter((n) => !n.read).length,
    [myNotifications],
  )

  const tasksById = useMemo(
    () => new Map(tasks.map((t) => [t.id, t])),
    [tasks],
  )
  const membersById = useMemo(
    () => new Map(teamMembers.map((m) => [m.id, m])),
    [teamMembers],
  )

  // Group same-task notifications within 1 hour of the newest member.
  const groups = useMemo(
    () => groupNotifications(myNotifications),
    [myNotifications],
  )
  const newGroups = useMemo(
    () => groups.filter((g) => g.hasUnread),
    [groups],
  )
  const earlierGroups = useMemo(
    () => groups.filter((g) => !g.hasUnread),
    [groups],
  )

  // Close panel on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const handlePointer = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  // Sound on new arrivals — reads the pref at fire time so the Settings
  // toggle applies immediately to the next arrival.
  useEffect(() => {
    if (!currentUser) return
    const newest = myNotifications[0]
    if (!newest) {
      prevNewestId.current = null
      return
    }
    // First evaluation after mount: just remember the newest ID and don't
    // chime — otherwise every page load would beep.
    if (prevNewestId.current === null) {
      prevNewestId.current = newest.id
      return
    }
    if (newest.id !== prevNewestId.current && !newest.read) {
      if (isNotifSoundEnabled(currentUser.id)) {
        playNotificationSound()
      }
    }
    prevNewestId.current = newest.id
  }, [myNotifications, currentUser])

  if (!currentUser) return null

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleMarkRead = (id: string) => {
    markNotificationRead(id)
  }

  const handleMarkGroupRead = (group: NotificationGroup) => {
    for (const n of group.notifications) {
      if (!n.read) markNotificationRead(n.id)
    }
  }

  const handleGoToTask = (taskId: string, notificationIds: string[]) => {
    for (const id of notificationIds) markNotificationRead(id)
    setOpen(false)
    openTask(taskId)
  }

  const handleAccept = (n: Notification, taskTitle: string | undefined) => {
    markNotificationRead(n.id)
    toast.success(`Accepted "${taskTitle ?? 'task'}".`)
    // A real deployment could also POST a Discord confirmation here — the
    // sendDiscordWebhook helper is already structured for a one-line swap.
  }

  const handleMarkAll = () => {
    markAllNotificationsRead(currentUser.id)
    toast.success('All notifications marked as read.')
  }

  const badgeText = unreadCount > 99 ? '99+' : String(unreadCount)

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={
          unreadCount > 0
            ? `Notifications (${unreadCount} unread)`
            : 'Notifications'
        }
        aria-expanded={open}
        className="relative inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] md:h-9 md:w-9"
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--destructive)] px-1 text-[10px] font-semibold text-white tabular-nums"
            aria-hidden="true"
          >
            {badgeText}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full z-30 mt-2 w-[min(380px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[0_4px_16px_rgba(0,0,0,0.3)]"
        >
          <header className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
            <span className="text-sm font-semibold text-[var(--text-primary)]">
              Notifications
            </span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAll}
                className="rounded text-xs font-medium text-[var(--accent-primary)] transition-colors hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
              >
                Mark all as read
              </button>
            )}
          </header>

          {myNotifications.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="max-h-[440px] overflow-y-auto">
              {newGroups.length > 0 && (
                <SectionDivider
                  label={`${unreadCount} new ${unreadCount === 1 ? 'notification' : 'notifications'}`}
                  tone="new"
                />
              )}
              {newGroups.length > 0 && (
                <ul>
                  {newGroups.map((g) => (
                    <NotificationGroupRow
                      key={g.key}
                      group={g}
                      task={tasksById.get(g.taskId)}
                      membersById={membersById}
                      expanded={expanded.has(g.key)}
                      onToggleExpanded={() => toggleExpanded(g.key)}
                      onMarkRead={handleMarkRead}
                      onMarkGroupRead={() => handleMarkGroupRead(g)}
                      onGoToTask={() =>
                        handleGoToTask(
                          g.taskId,
                          g.notifications.map((n) => n.id),
                        )
                      }
                      onAccept={(n) =>
                        handleAccept(n, tasksById.get(g.taskId)?.title)
                      }
                    />
                  ))}
                </ul>
              )}

              {earlierGroups.length > 0 && newGroups.length > 0 && (
                <SectionDivider label="Earlier" tone="earlier" />
              )}
              {earlierGroups.length > 0 && (
                <ul>
                  {earlierGroups.map((g) => (
                    <NotificationGroupRow
                      key={g.key}
                      group={g}
                      task={tasksById.get(g.taskId)}
                      membersById={membersById}
                      expanded={expanded.has(g.key)}
                      onToggleExpanded={() => toggleExpanded(g.key)}
                      onMarkRead={handleMarkRead}
                      onMarkGroupRead={() => handleMarkGroupRead(g)}
                      onGoToTask={() =>
                        handleGoToTask(
                          g.taskId,
                          g.notifications.map((n) => n.id),
                        )
                      }
                      onAccept={(n) =>
                        handleAccept(n, tasksById.get(g.taskId)?.title)
                      }
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---- Section divider -------------------------------------------------------

function SectionDivider({
  label,
  tone,
}: {
  label: string
  tone: 'new' | 'earlier'
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-1.5',
        tone === 'new'
          ? 'bg-[color-mix(in_srgb,var(--accent-primary)_8%,transparent)]'
          : 'bg-[var(--bg-surface)]',
      )}
    >
      <span
        className={cn(
          'text-[10px] font-semibold uppercase tracking-[0.5px]',
          tone === 'new'
            ? 'text-[var(--accent-primary)]'
            : 'text-[var(--text-muted)]',
        )}
      >
        {label}
      </span>
    </div>
  )
}

// ---- Group row -------------------------------------------------------------

interface NotificationGroupRowProps {
  group: NotificationGroup
  task: Task | undefined
  membersById: Map<string, TeamMember>
  expanded: boolean
  onToggleExpanded: () => void
  onMarkRead: (id: string) => void
  onMarkGroupRead: () => void
  onGoToTask: () => void
  onAccept: (notification: Notification) => void
}

function NotificationGroupRow({
  group,
  task,
  membersById,
  expanded,
  onToggleExpanded,
  onMarkRead,
  onMarkGroupRead,
  onGoToTask,
  onAccept,
}: NotificationGroupRowProps) {
  // Single-notification "groups" render exactly like before — no chevron,
  // no expand. Multi-member groups render a collapsible header + body.
  if (group.notifications.length === 1) {
    const n = group.notifications[0]!
    return (
      <NotificationRow
        notification={n}
        task={task}
        actor={n.actorId ? membersById.get(n.actorId) ?? null : null}
        onMarkRead={() => onMarkRead(n.id)}
        onGoToTask={onGoToTask}
        onAccept={() => onAccept(n)}
      />
    )
  }

  const taskTitle = task?.title ?? '(deleted task)'

  return (
    <li>
      <div
        className={cn(
          'group/notif border-l-2',
          group.hasUnread
            ? 'border-l-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_5%,transparent)]'
            : 'border-l-transparent',
        )}
      >
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-surface)] focus-visible:outline-none focus-visible:bg-[var(--bg-surface)]"
        >
          <span
            className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent-primary)_15%,transparent)] text-[var(--accent-primary)]"
            aria-hidden="true"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                'line-clamp-2 text-sm leading-snug',
                group.hasUnread
                  ? 'text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)]',
              )}
            >
              <span className="font-semibold">{group.notifications.length} updates</span>{' '}
              on &quot;{taskTitle}&quot;
            </p>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              {relativeTime(group.newest)}
            </p>
          </div>
          <GroupActions
            onMarkRead={(e) => {
              e.stopPropagation()
              onMarkGroupRead()
            }}
            onGoToTask={(e) => {
              e.stopPropagation()
              onGoToTask()
            }}
            hasUnread={group.hasUnread}
          />
        </button>

        {expanded && (
          <ul className="border-t border-[var(--border-subtle)]">
            {group.notifications.map((n) => (
              <li key={n.id}>
                <NotificationRow
                  notification={n}
                  task={task}
                  actor={n.actorId ? membersById.get(n.actorId) ?? null : null}
                  onMarkRead={() => onMarkRead(n.id)}
                  onGoToTask={onGoToTask}
                  onAccept={() => onAccept(n)}
                  nested
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}

function GroupActions({
  onMarkRead,
  onGoToTask,
  hasUnread,
}: {
  onMarkRead: (e: React.MouseEvent) => void
  onGoToTask: (e: React.MouseEvent) => void
  hasUnread: boolean
}) {
  return (
    <div className="ml-1 mt-0.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/notif:opacity-100 focus-within:opacity-100">
      {hasUnread && (
        <IconButton
          icon={Eye}
          label="Mark group as read"
          onClick={onMarkRead}
        />
      )}
      <IconButton
        icon={ArrowRight}
        label="Go to task"
        onClick={onGoToTask}
      />
    </div>
  )
}

// ---- Single notification row ----------------------------------------------

interface NotificationRowProps {
  notification: Notification
  task: Task | undefined
  actor: TeamMember | null
  onMarkRead: () => void
  onGoToTask: () => void
  onAccept: () => void
  /** When true, this row is rendered inside an expanded group — sit a bit
   *  flatter so the parent's left border carries the unread accent. */
  nested?: boolean
}

function NotificationRow({
  notification,
  task,
  actor,
  onMarkRead,
  onGoToTask,
  onAccept,
  nested,
}: NotificationRowProps) {
  const Icon = ICON_BY_TYPE[notification.type]
  const iconColorVar = ICON_COLOR_BY_TYPE[notification.type]
  const description = describeNotification(
    notification.type,
    actor?.name,
    task?.title,
  )

  return (
    <div
      className={cn(
        'group/notif relative flex w-full items-start gap-3 px-3 py-2.5 transition-colors hover:bg-[var(--bg-surface)]',
        !nested && 'border-l-2',
        !nested && notification.read
          ? 'border-l-transparent'
          : !nested
            ? 'border-l-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_5%,transparent)]'
            : '',
      )}
    >
      <button
        type="button"
        onClick={onGoToTask}
        className="absolute inset-0 z-0"
        aria-label={description}
      />
      <span
        className="relative z-10 mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{
          backgroundColor: `color-mix(in srgb, var(${iconColorVar}) 15%, transparent)`,
        }}
      >
        <Icon
          className="h-3.5 w-3.5"
          style={{ color: `var(${iconColorVar})` }}
          aria-hidden="true"
        />
      </span>
      <div className="relative z-10 min-w-0 flex-1 pointer-events-none">
        <p
          className={cn(
            'line-clamp-2 text-sm leading-snug',
            notification.read
              ? 'text-[var(--text-secondary)]'
              : 'text-[var(--text-primary)]',
          )}
        >
          {description}
        </p>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          {relativeTime(notification.createdAt)}
        </p>
      </div>

      <div className="relative z-10 ml-1 mt-0.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/notif:opacity-100 focus-within:opacity-100">
        {notification.type === 'assigned' && !notification.read && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onAccept()
            }}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-[var(--accent-primary)] px-2 text-xs font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            <Check className="h-3 w-3" aria-hidden="true" strokeWidth={3} />
            Accept
          </button>
        )}
        {!notification.read && (
          <IconButton
            icon={Eye}
            label="Mark as read"
            onClick={(e) => {
              e.stopPropagation()
              onMarkRead()
            }}
          />
        )}
        <IconButton
          icon={ArrowRight}
          label="Go to task"
          onClick={(e) => {
            e.stopPropagation()
            onGoToTask()
          }}
        />
      </div>

      {!notification.read && (
        <span
          className="relative z-10 mt-2 h-2 w-2 shrink-0 rounded-full bg-[var(--accent-primary)]"
          aria-label="unread"
        />
      )}
    </div>
  )
}

function IconButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon
  label: string
  onClick: (e: React.MouseEvent) => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  )
}

// ---- Empty state -----------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <Bell
        className="h-8 w-8 text-[var(--text-muted)]"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <p className="mt-3 text-sm font-medium text-[var(--text-primary)]">
        All caught up
      </p>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        You&apos;ll see notifications here when something needs your attention.
      </p>
    </div>
  )
}

// ---- Grouping --------------------------------------------------------------

/**
 * Walk notifications in descending createdAt order. For each one, look back
 * at the most recent existing group; if it's the same task and the group's
 * newest timestamp is within 1 hour of this notification, the row joins
 * that group. Otherwise a new group starts.
 *
 * Walking desc order means a notification can only join a group that's
 * already been seen, which is exactly the cluster that contains its newest
 * sibling.
 */
function groupNotifications(notifs: Notification[]): NotificationGroup[] {
  const groups: NotificationGroup[] = []
  for (const n of notifs) {
    const nMs = new Date(n.createdAt).getTime()
    let target: NotificationGroup | null = null
    // Walk groups from most recent backwards; first same-task match is the
    // only candidate (older groups are by definition further away in time).
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i]!
      if (g.taskId !== n.taskId) continue
      const gMs = new Date(g.newest).getTime()
      if (gMs - nMs <= GROUP_WINDOW_MS) {
        target = g
      }
      break
    }
    if (target) {
      target.notifications.push(n)
      if (!n.read) target.hasUnread = true
      // newest stays the same — we're walking desc, so n.createdAt is older.
    } else {
      groups.push({
        key: `${n.taskId}:${n.id}`,
        taskId: n.taskId,
        notifications: [n],
        newest: n.createdAt,
        hasUnread: !n.read,
      })
    }
  }
  return groups
}

function describeNotification(
  type: NotificationType,
  actorName: string | undefined,
  taskTitle: string | undefined,
): string {
  const actor = actorName ?? 'Someone'
  const title = taskTitle ?? '(deleted task)'
  switch (type) {
    case 'assigned':
      return `${actor} assigned you to '${title}'`
    case 'comment':
      return `${actor} commented on '${title}'`
    case 'mention':
      return `${actor} mentioned you in '${title}'`
    case 'status_change':
      return `'${title}' moved to a new column`
    case 'due_tomorrow':
      return `'${title}' is due tomorrow`
    case 'overdue':
      return `'${title}' is overdue`
  }
}
