import { Fragment, useState } from 'react'
import { useTaskPanel } from '@/data/task-panel'
import {
  ArrowRight,
  Calendar,
  CheckSquare,
  Flag,
  MessageSquare,
  Plus,
  Trash2,
  UserPlus,
  type LucideIcon,
} from 'lucide-react'
import { Avatar } from '@/components/shared/Avatar'
import { formatAbsoluteDateTime, relativeTime } from '@/lib/date-utils'
import { cn } from '@/lib/utils'
import type {
  Activity,
  ActivityType,
  Project,
  Task,
  TeamMember,
} from '@/data/types'

interface ActivityItemProps {
  activity: Activity
  /** Lookup tables — keep them as Maps so render is O(1) per row. */
  taskById: Map<string, Task>
  projectById: Map<string, Project>
  memberById: Map<string, TeamMember>
  /** All members — needed to highlight @mentions in comment bodies. */
  members: TeamMember[]
  /**
   * `feed` (default) renders a compact single-line row for dashboard-style
   * lists. `detail` renders comments as larger left-bordered cards and other
   * events as compact rows — used on the task detail page.
   */
  variant?: 'feed' | 'detail'
}

const ICONS: Record<ActivityType, LucideIcon> = {
  creation: Plus,
  status_change: ArrowRight,
  assignment: UserPlus,
  priority_change: Flag,
  subtask_complete: CheckSquare,
  subtask_created: CheckSquare,
  comment: MessageSquare,
  due_date_change: Calendar,
  task_deleted: Trash2,
  project_created: Plus,
  member_added: UserPlus,
  member_removed: Trash2,
}

const COMMENT_PREVIEW_CHARS = 100

export function ActivityItem({
  activity,
  taskById,
  projectById,
  memberById,
  members,
  variant = 'feed',
}: ActivityItemProps) {
  const { openTask } = useTaskPanel()
  const actor = memberById.get(activity.actorId)
  const actorName = actor?.name ?? 'Someone'
  const task = activity.taskId ? taskById.get(activity.taskId) : undefined
  const phrase = describeActivity(activity, {
    task,
    projectById,
    memberById,
    truncateComment: variant === 'feed',
  })

  // The detail-view comment card is the only place that renders the full
  // body. Other surfaces use the phrase from `describeActivity`.
  if (variant === 'detail' && activity.type === 'comment') {
    return (
      <CommentCard
        activity={activity}
        actorName={actorName}
        actorAvatarUrl={actor?.avatarUrl ?? null}
        members={members}
      />
    )
  }

  const Icon = ICONS[activity.type]
  // Task-detail system rows are extra compact; feed rows have a wider tap area.
  const compact = variant === 'detail'

  const row = (
    <div
      className={cn(
        'flex items-center gap-3',
        compact ? 'px-2 py-1.5' : 'px-3 py-2.5 md:px-4',
      )}
    >
      <Avatar
        name={actorName}
        imageUrl={actor?.avatarUrl}
        size={compact ? 'xs' : 'sm'}
      />
      <Icon
        className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
        aria-hidden="true"
      />
      <p
        className={cn(
          'min-w-0 flex-1 truncate text-sm text-[var(--text-secondary)]',
          compact && 'text-xs',
        )}
      >
        <span className="font-medium text-[var(--text-primary)]">{actorName}</span>{' '}
        {phrase}
      </p>
      <TimeStamp createdAt={activity.createdAt} />
    </div>
  )

  // Feed rows link to the task when one exists. Workspace-scoped activities
  // (project_created, member_*, task_deleted) render as plain rows.
  if (variant === 'feed' && task) {
    return (
      <button
        type="button"
        onClick={() => openTask(task.id)}
        aria-label={`Open ${task.title}`}
        className="block w-full text-left transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
      >
        {row}
      </button>
    )
  }
  if (variant === 'feed' && !task) {
    return <div className="cursor-default opacity-70">{row}</div>
  }
  return row
}

/** Per-item timestamp that toggles between "2 hours ago" and "May 28, 2026 at 2:34 PM". */
function TimeStamp({ createdAt }: { createdAt: string }) {
  const [absolute, setAbsolute] = useState(false)
  const label = absolute ? formatAbsoluteDateTime(createdAt) : relativeTime(createdAt)
  return (
    <button
      type="button"
      onClick={(e) => {
        // Stop the row's Link from navigating.
        e.preventDefault()
        e.stopPropagation()
        setAbsolute((a) => !a)
      }}
      title={absolute ? 'Switch to relative' : 'Switch to absolute'}
      className="shrink-0 rounded text-xs text-[var(--text-muted)] tabular-nums transition-colors hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
    >
      {label}
    </button>
  )
}

function CommentCard({
  activity,
  actorName,
  actorAvatarUrl,
  members,
}: {
  activity: Activity
  actorName: string
  actorAvatarUrl: string | null
  members: TeamMember[]
}) {
  return (
    <div className="ml-1 border-l-2 border-[var(--accent-primary)]/40 pl-3">
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2.5 md:px-4">
        <div className="flex items-start gap-3">
          <Avatar name={actorName} imageUrl={actorAvatarUrl} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">
                {actorName}
              </span>
              <TimeStamp createdAt={activity.createdAt} />
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-[var(--text-primary)]">
              <CommentBody text={activity.content} members={members} />
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function CommentBody({ text, members }: { text: string; members: TeamMember[] }) {
  const handles = new Map<string, TeamMember>()
  for (const m of members) {
    handles.set(m.name.replace(/\s+/g, '').toLowerCase(), m)
  }
  const parts = text.split(/(@[A-Za-z][A-Za-z0-9_-]*)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('@')) {
          const handle = part.slice(1).toLowerCase()
          const member = handles.get(handle)
          if (member) {
            return (
              <span
                key={i}
                className="rounded bg-[color-mix(in_srgb,var(--accent-primary)_15%,transparent)] px-1 font-medium text-[var(--accent-primary)]"
              >
                @{member.name}
              </span>
            )
          }
        }
        return <Fragment key={i}>{part}</Fragment>
      })}
    </>
  )
}

// ---- Phrase composition ----------------------------------------------------

interface PhraseContext {
  task: Task | undefined
  projectById: Map<string, Project>
  memberById: Map<string, TeamMember>
  truncateComment: boolean
}

/**
 * Compose the verb-phrase shown after the actor's name. Prefers structured
 * metadata (`fromValue`, `toMemberId`, etc.) for the rich format; falls back
 * to the seeded `content` string when the activity lacks metadata.
 */
function describeActivity(activity: Activity, ctx: PhraseContext): string {
  const { task, projectById, memberById, truncateComment } = ctx
  const taskTitle = task?.title ?? activity.taskTitle ?? '(deleted task)'
  const projectName =
    task && projectById.get(task.projectId)?.name
      ? ` in ${projectById.get(task.projectId)!.name}`
      : activity.projectId && projectById.get(activity.projectId)?.name
        ? ` in ${projectById.get(activity.projectId)!.name}`
        : ''

  switch (activity.type) {
    case 'creation':
      return `created "${taskTitle}"${projectName}`
    case 'status_change':
      if (activity.fromValue && activity.toValue) {
        return `moved "${taskTitle}" from ${activity.fromValue} to ${activity.toValue}`
      }
      // Legacy fallback for seeded activities.
      return activity.content.replace(/\bthis\b/, `"${taskTitle}"`)
    case 'priority_change':
      if (activity.fromValue && activity.toValue) {
        return `changed priority on "${taskTitle}" from ${capitalize(activity.fromValue)} to ${capitalize(activity.toValue)}`
      }
      return `${activity.content} on "${taskTitle}"`
    case 'assignment': {
      const toName = activity.toMemberId
        ? memberById.get(activity.toMemberId)?.name ?? 'someone'
        : null
      if (toName) return `assigned "${taskTitle}" to ${toName}`
      // Explicit unassignment (toMemberId === null with metadata).
      if (activity.toMemberId === null && activity.fromMemberId !== undefined) {
        return `unassigned "${taskTitle}"`
      }
      // Legacy fallback.
      return activity.content
        .replace(/\bthis task\b/, `"${taskTitle}"`)
        .replace(/\bthis\b/, `"${taskTitle}"`)
    }
    case 'subtask_complete':
      return `completed subtask "${activity.subtaskTitle ?? unwrapSubtaskTitle(activity.content)}" on "${taskTitle}"`
    case 'subtask_created':
      return `added subtask "${activity.subtaskTitle ?? ''}" to "${taskTitle}"`
    case 'comment': {
      const body = activity.content.trim()
      const preview =
        truncateComment && body.length > COMMENT_PREVIEW_CHARS
          ? `${body.slice(0, COMMENT_PREVIEW_CHARS)}…`
          : body
      return `commented on "${taskTitle}": ${preview}`
    }
    case 'due_date_change':
      if (!activity.toValue) return `cleared the due date on "${taskTitle}"`
      if (activity.fromValue) {
        return `changed due date on "${taskTitle}" from ${activity.fromValue} to ${activity.toValue}`
      }
      return `set due date on "${taskTitle}" to ${activity.toValue}`
    case 'task_deleted':
      return `deleted "${activity.taskTitle ?? taskTitle}"${projectName}`
    case 'project_created': {
      const name =
        (activity.projectId && projectById.get(activity.projectId)?.name) ??
        'a project'
      return `created project "${name}"`
    }
    case 'member_added': {
      const name = activity.memberId
        ? memberById.get(activity.memberId)?.name
        : null
      return name ? `added ${name} to the team` : activity.content
    }
    case 'member_removed': {
      const name = activity.memberId
        ? memberById.get(activity.memberId)?.name
        : null
      return name ? `removed ${name} from the team` : activity.content
    }
  }
}

function unwrapSubtaskTitle(content: string): string {
  // Legacy content looks like: completed subtask 'Foo'
  const m = content.match(/'([^']+)'/)
  return m?.[1] ?? ''
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
