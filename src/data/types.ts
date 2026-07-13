/**
 * Shared domain types. Field names mirror docs/product-spec.md exactly.
 * Date-time fields are stored as ISO 8601 strings; pure dates (dueDate) as
 * YYYY-MM-DD strings so they round-trip through JSON without timezone drift.
 */

export type Role = 'pm' | 'member'

export type Priority = 'critical' | 'high' | 'medium' | 'low'

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done'

export type ActivityType =
  | 'status_change'
  | 'assignment'
  | 'comment'
  | 'creation'
  | 'subtask_complete'
  | 'subtask_created'
  | 'priority_change'
  | 'due_date_change'
  | 'task_deleted'
  | 'project_created'
  | 'member_added'
  | 'member_removed'

export type NotificationType =
  | 'assigned'
  | 'comment'
  | 'mention'
  | 'status_change'
  | 'due_tomorrow'
  | 'overdue'

export interface TeamMember {
  id: string
  name: string
  email: string
  role: Role
  avatarUrl: string | null
  createdAt: string
}

/** Row shape of Supabase `user_profiles`. Only `auth-service.ts` reads/writes
 *  this directly — the rest of the app consumes the mapped [[TeamMember]]. */
export interface UserProfile {
  id: string
  display_name: string
  email: string
  role: Role
  password_hash: string
  avatar_url: string | null
  avatar_initials: string | null
  avatar_color: string | null
  last_login_at: string | null
  created_at: string
  updated_at: string
}

export interface Project {
  id: string
  name: string
  description: string
  color: string
  memberIds: string[]
  archived: boolean
  createdAt: string
  updatedAt: string
  createdBy: string
}

export interface Subtask {
  id: string
  taskId: string
  title: string
  assigneeId: string | null
  done: boolean
  sortOrder: number
  createdAt: string
  completedAt: string | null
}

export interface Task {
  id: string
  title: string
  description: string
  projectId: string
  assigneeId: string | null
  priority: Priority
  status: TaskStatus
  dueDate: string | null
  tags: string[]
  subtasks: Subtask[]
  createdAt: string
  updatedAt: string
  createdBy: string
  /** Set when this task was converted from a meeting's action item.
   *  Renders a "Created from meeting" back-link banner on the task
   *  detail page. Stays set even if the meeting is later deleted —
   *  the banner falls back to a muted "Source meeting was deleted"
   *  in that case. */
  sourceMeetingId?: string
  sourceActionItemId?: string
}

/** Categories applied to comments — controls visual styling, embed shape
 *  on Discord, and filter / count behavior across the app. */
export type CommentLabel =
  | 'note'
  | 'question'
  | 'decision'
  | 'blocker'
  | 'idea'

export interface Activity {
  id: string
  /** `null` for workspace-scoped activities (project_created, member_*). */
  taskId: string | null
  actorId: string
  type: ActivityType
  /** Free-form body. For comments, the user's text. For other events, a
   *  human-readable summary kept for back-compat with seeded fixtures. */
  content: string
  mentions: string[]
  createdAt: string
  // Optional structured detail — renderers prefer these over parsing `content`.
  /** Old value, where applicable (status / priority / due date label). */
  fromValue?: string
  /** New value, where applicable. */
  toValue?: string
  /** Old assignee — assignment changes. `null` = was unassigned. */
  fromMemberId?: string | null
  /** New assignee — assignment changes. `null` = unassigned. */
  toMemberId?: string | null
  /** Subtask title for subtask_created / subtask_complete events. */
  subtaskTitle?: string
  /** Snapshot of the task title at the moment of deletion (the task itself
   *  is gone, so renderers fall back to this). */
  taskTitle?: string
  /** Project context for creation / project_created. */
  projectId?: string
  /** Member context for member_added / member_removed. */
  memberId?: string

  // ── Comment-specific fields (only meaningful when type === 'comment') ──
  /** Threaded reply target. `null`/undefined = top-level comment. Replies
   *  are limited to 1 level — replying to a reply normalizes to the
   *  reply's `parentCommentId` so the tree stays flat. */
  parentCommentId?: string | null
  /** Categorization label that drives the colored left border + filter +
   *  Discord embed variant. Missing/`'note'` = no visual treatment. */
  commentLabel?: CommentLabel
  /** True when a comment has been pinned to the task. */
  isPinned?: boolean
  /** Who pinned it — used for the "Pinned by X" caption. */
  pinnedBy?: string | null
  /** Only relevant for `commentLabel === 'question'` — flips when the team
   *  marks the question resolved. Unresolved questions surface as a
   *  small "❓ N" badge on board cards. */
  resolved?: boolean
}

export interface Tag {
  id: string
  name: string
  color: string
}

/** A discussion held for a project — notes, decisions, action items. */
export type MeetingStatus = 'scheduled' | 'completed' | 'cancelled'

export interface Decision {
  id: string
  text: string
  /** Member who made the call. `null` when it was a group decision. */
  decidedBy: string | null
  /** Optional short explanation for why the call was made. Surfaced
   *  beneath the decision text. Only populated when the upstream
   *  source carries one (e.g. an Atlas manifest with `rationale`). */
  rationale?: string
}

export interface ActionItem {
  id: string
  text: string
  assigneeId: string | null
  dueDate: string | null
  done: boolean
  /** When this action item has been converted into a full Task, the
   *  resulting task's id is stored here so the UI can link to it. */
  linkedTaskId: string | null
}

/** Question or blocker raised in a meeting — surfaced as its own
 *  section in the meeting detail. Tagged as `conflict` when the
 *  upstream source (Atlas) flagged it as a detected conflict between
 *  participants. */
export type MeetingQuestionKind = 'question' | 'blocker' | 'conflict'

export interface MeetingQuestion {
  id: string
  text: string
  kind: MeetingQuestionKind
}

export interface MeetingLink {
  id: string
  label: string
  url: string
}

export interface Meeting {
  id: string
  title: string
  projectId: string
  /** Date the meeting happened (or is scheduled), YYYY-MM-DD. */
  date: string
  /** Free-form start time like "10:00 AM". `null` when not specified. */
  startTime: string | null
  /** Duration in minutes. `null` when not specified. */
  duration: number | null
  attendeeIds: string[]
  status: MeetingStatus
  /** Free text: "Discord #dev-standup", "Google Meet", "In-person", etc. */
  location: string | null
  /** Pre-meeting agenda. */
  agenda: string | null
  /** Discussion notes — captured during/after the meeting. Plain text;
   *  rendered with `whitespace-pre-wrap` so paragraph breaks survive. */
  notes: string
  decisions: Decision[]
  actionItems: ActionItem[]
  /** Questions, blockers, and detected conflicts raised in the
   *  meeting. Surfaced as a dedicated section between Decisions and
   *  Action Items. Empty array when there are none. */
  questions: MeetingQuestion[]
  links: MeetingLink[]
  createdBy: string
  createdAt: string
  updatedAt: string
  /** Member who last edited notes (drives the "Last edited by …" indicator). */
  lastEditedBy: string | null
  lastEditedAt: string | null
}

/**
 * Saved task template — speeds up repetitive creation (bug reports, feature
 * requests, documentation tasks, etc.). Tags are stored by NAME so a tag
 * rename or ID change doesn't silently orphan templates.
 */
export interface TaskTemplate {
  id: string
  /** Display name in the Settings list and Quick Create dropdown. */
  name: string
  /** Pre-filled task title — may contain `[placeholders]` for the user to replace. */
  title: string
  description: string
  priority: Priority
  /** Subtask titles to create alongside the task. */
  subtaskTitles: string[]
  /** Tag names — resolved to existing IDs at apply time. */
  tagNames: string[]
  createdAt: string
}

export interface Notification {
  id: string
  recipientId: string
  type: NotificationType
  taskId: string
  actorId: string | null
  read: boolean
  createdAt: string
}

/** Display labels for the canonical task statuses (used in pills, columns, dropdowns). */
export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}
