import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  DEFAULT_DISCORD_SETTINGS,
  buildActionItemConvertedEmbed,
  buildBulkUpdateEmbed,
  buildCommentPostedEmbed,
  buildMeetingCompletedEmbed,
  buildSheetsChangesDetectedEmbed,
  buildSheetsInitialSyncEmbed,
  buildSheetsSyncFailedEmbed,
  buildTaskAssignedEmbed,
  buildTaskCompletedEmbed,
  buildTaskCreatedEmbed,
  buildTaskStatusChangedEmbed,
  buildTestEmbed,
  sendDiscordWebhook,
  type DiscordEvent,
  type DiscordSettings,
  type SheetsTaskChange,
} from '@/services/discord'
import { useAuth } from './auth'
import {
  applyOverlayList,
  emptyOverlay,
  fetchMeetingsForRange,
  fetchTodaysMeetings,
  loadFromAtlas,
  loadOverlay,
  mergeDiffIntoOverlay,
  saveOverlay,
  type AtlasSnapshot,
  type LocalOverlay,
} from './atlas-bridge'
import {
  applyBootstrapToOverlay,
  bootstrapFromSupabase,
  meetingToRows,
  syncOverlayDiff,
} from './supabase-sync'
import {
  loadFromTranscriptStore,
  mergeAtlasAndTranscriptMeetings,
} from './transcripts-bridge'
import { isTranscriptStoreConfigured } from '@/services/transcript-store-config'
import { isSupabaseConfigured } from '@/services/supabase'
import {
  deleteActivity as deleteActivityApi,
  deleteComment as deleteCommentApi,
  deleteOldActivities,
  deleteStaleAtlasCache,
  recordDedupDecision,
  setSetting,
  upsertAtlasCache,
  upsertMeeting,
} from '@/services/supabase-api'
import { findBestMatch } from '@/services/deduplication'
import {
  combineSourceSnapshots,
  loadFromSheets,
  SHEETS_PROJECT_ID,
} from './sheets-bridge'
import {
  ATLAS_CONFIG_CHANGED_EVENT,
  isAtlasConfigured,
} from '@/services/atlas/config'
import {
  getPollIntervalMinutes,
  isGoogleSheetsConfigured,
} from '@/services/google-sheets-config'
import type {
  SheetsRawRow,
  TabDiagnostics,
} from '@/services/sheets-mapper'
import {
  mockActivities,
  mockMeetings,
  mockNotifications,
  mockProjects,
  mockTags,
  mockTasks,
  mockTeamMembers,
} from './mock-data'
import {
  STATUS_LABELS,
  type ActionItem,
  type Activity,
  type ActivityType,
  type CommentLabel,
  type Decision,
  type Meeting,
  type MeetingLink,
  type MeetingQuestion,
  type MeetingStatus,
  type Notification,
  type NotificationType,
  type Priority,
  type Project,
  type Role,
  type Subtask,
  type Tag,
  type Task,
  type TaskStatus,
  type TaskTemplate,
  type TeamMember,
} from './types'

const MUTATION_DELAY_MS = 800
/** A single failed fetch (transient network blip, brief Atlas
 *  hiccup) shouldn't flag the whole app red. We hide the
 *  "Sync error" indicator until this many refreshes have failed
 *  in a row. Any successful load resets the counter. */
const SYNC_ERROR_THRESHOLD = 3

/** localStorage key holding the millisecond timestamp of the last
 *  successful Supabase cleanup pass. Used to throttle cleanup to
 *  once per calendar day per browser. */
const CACHE_CLEANUP_STORAGE_KEY = 'team-manager.last-cache-cleanup'
/** Interval between cleanup passes — daily. */
const CACHE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Retain atlas_cache rows fetched within the last 90 days; anything
 *  older gets purged (usually left over from a renamed project slug
 *  or a retired data source). Matches the activities TTL so both
 *  redundancy layers share a horizon. */
const CACHE_ATLAS_TTL_MS = 90 * 24 * 60 * 60 * 1000
/** Retain activities from the last 90 days; older rows aren't
 *  surfaced by the UI, so they're dead weight in the table. */
const CACHE_ACTIVITIES_TTL_MS = 90 * 24 * 60 * 60 * 1000
const ATLAS_REFRESH_INTERVAL_MS = 60_000
const SHEETS_REFRESH_INTERVAL_FALLBACK_MS = 15 * 60 * 1000
/** Cadence for the today-only meeting refresh. Catches meetings that
 *  finish during the workday — the 60s Atlas refresh skips manifests
 *  (they're too heavy to refetch every minute), so we run a focused
 *  today-only pass on a slower tick. 5 min hits the sweet spot
 *  between "meeting finishes and the user notices it" and Atlas load. */
const MEETINGS_REFRESH_INTERVAL_MS = 5 * 60 * 1000

interface PrevSheetTask {
  title: string
  status: TaskStatus
  priority: Priority
  assigneeId: string | null
}

/**
 * Diff the previous sheets snapshot against the current task list and
 * emit a SheetsTaskChange[] suitable for Discord. Three categories:
 *   - removed: previously-present task ids that don't appear in the new
 *     fetch (row deleted from the sheet, or filter changed)
 *   - added: new ids that weren't there last time
 *   - updated: same id, but at least one of status / priority / assignee
 *     changed. Title change alone doesn't count as a content change —
 *     people rewrite titles all the time and it'd be noisy. The change
 *     embed uses the NEW title as the label regardless.
 *
 * Status / priority values are humanised via the live statusLabels map
 * so the Discord embed reads "To Do → In Progress", not "todo →
 * in_progress".
 */
function diffSheetsTasks(
  prev: ReadonlyMap<string, PrevSheetTask>,
  nextTasks: Task[],
  statusLabels: Record<TaskStatus, string>,
): SheetsTaskChange[] {
  const changes: SheetsTaskChange[] = []
  const nextById = new Map(nextTasks.map((t) => [t.id, t]))

  for (const [id, p] of prev) {
    const n = nextById.get(id)
    if (!n) {
      changes.push({ kind: 'removed', title: p.title || id })
      continue
    }
    if (p.status !== n.status) {
      changes.push({
        kind: 'updated',
        title: n.title || id,
        field: 'status',
        oldValue: statusLabels[p.status] ?? p.status,
        newValue: statusLabels[n.status] ?? n.status,
      })
    }
    if (p.priority !== n.priority) {
      changes.push({
        kind: 'updated',
        title: n.title || id,
        field: 'priority',
        oldValue: p.priority,
        newValue: n.priority,
      })
    }
    if (p.assigneeId !== n.assigneeId) {
      changes.push({
        kind: 'updated',
        title: n.title || id,
        field: 'assignee',
        oldValue: p.assigneeId,
        newValue: n.assigneeId,
      })
    }
  }
  for (const n of nextTasks) {
    if (!prev.has(n.id)) {
      changes.push({ kind: 'added', title: n.title || n.id })
    }
  }
  return changes
}

/**
 * Brief artificial gate at provider mount so pages can render skeleton
 * loaders against a real signal. The mock data is otherwise synchronous,
 * which would make every page render instantly with no opportunity to
 * show a loading state.
 */
const INITIAL_LOAD_DELAY_MS = 500

const WORKSPACE_NAME_KEY = 'team-manager.workspace-name'
const STATUS_LABEL_OVERRIDES_KEY = 'team-manager.status-label-overrides'
const COLUMN_ORDER_KEY = 'team-manager.column-order'
const NOTIF_PREFS_PREFIX = 'team-manager.notif-prefs.'
const DISCORD_SETTINGS_KEY = 'team-manager.discord-settings'
const TASK_TEMPLATES_KEY = 'team-manager.task-templates'
/** Cached team-members list from the last Atlas load. Seeds the login
 *  dropdown on subsequent visits so the user sees their name
 *  immediately instead of a "Loading team from Atlas…" spinner. */
const TEAM_MEMBERS_CACHE_KEY = 'team-manager.cached-team-members'

const DEFAULT_WORKSPACE_NAME = 'Team Manager'
const DEFAULT_COLUMN_ORDER: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done']

/**
 * Seeded templates shipped on first load. Once the user edits or deletes any,
 * the localStorage record takes over and these no longer reappear on refresh.
 * Deterministic IDs so the seeds don't drift across sessions.
 */
const DEFAULT_TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: 'tmpl-bug',
    name: 'Bug Report',
    title: 'Bug: [description]',
    description: '',
    priority: 'high',
    subtaskTitles: [
      'Reproduce the bug',
      'Identify root cause',
      'Implement fix',
      'Write regression test',
      'Verify fix in staging',
    ],
    tagNames: ['bug'],
    createdAt: '2026-05-01T00:00:00.000Z',
  },
  {
    id: 'tmpl-feature',
    name: 'Feature Request',
    title: '[Feature name]',
    description: '',
    priority: 'medium',
    subtaskTitles: [
      'Define requirements',
      'Design solution',
      'Implement',
      'Write tests',
      'Code review',
      'Deploy',
    ],
    tagNames: ['feature'],
    createdAt: '2026-05-01T00:00:00.000Z',
  },
  {
    id: 'tmpl-doc',
    name: 'Documentation',
    title: 'Document: [topic]',
    description: '',
    priority: 'low',
    subtaskTitles: ['Draft content', 'Peer review', 'Publish'],
    tagNames: ['documentation'],
    createdAt: '2026-05-01T00:00:00.000Z',
  },
]

/** Map a NotificationType to the pref key shown in Settings. */
const NOTIF_TYPE_PREF_KEY: Record<NotificationType, string> = {
  assigned: 'assigned',
  comment: 'comment',
  mention: 'mention',
  status_change: 'status_change',
  due_tomorrow: 'due_tomorrow',
  overdue: 'overdue',
}

function loadJSON<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function saveJSON(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // private mode / quota — ignore
  }
}

/** True when the recipient has the given notification type enabled (default: true). */
function notifTypeEnabled(recipientId: string, type: NotificationType): boolean {
  if (typeof window === 'undefined') return true
  try {
    const raw = window.localStorage.getItem(NOTIF_PREFS_PREFIX + recipientId)
    if (!raw) return true
    const parsed = JSON.parse(raw) as Record<string, boolean>
    const value = parsed[NOTIF_TYPE_PREF_KEY[type]]
    return value !== false
  } catch {
    return true
  }
}

/**
 * Generate a bare RFC-4122 v4 UUID.
 *
 * The `prefix` argument used to be embedded in the returned id
 * ("task-abc…", "act-abc…") for debugging convenience, but the
 * Supabase `id` columns for local_tasks/subtasks/comments/activities
 * are `uuid` type and reject anything that isn't a canonical UUID.
 * We keep the parameter so every existing call site still compiles
 * without churn — it's now just a hint for human readers and gets
 * dropped at the boundary.
 */
function uid(_prefix: string): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID()
  }
  // Paranoid fallback for environments without `crypto.randomUUID`
  // (none we ship to in practice — modern browsers + Node 14.17+ all
  // have it). Produces a valid v4-shaped uuid using Math.random.
  const hex = '0123456789abcdef'
  let out = ''
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-'
    } else if (i === 14) {
      out += '4'
    } else if (i === 19) {
      out += hex[(Math.random() * 4) | 8] // 8, 9, a, or b
    } else {
      out += hex[(Math.random() * 16) | 0]
    }
  }
  return out
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function memberName(members: TeamMember[], id: string | null | undefined): string {
  if (!id) return 'Unassigned'
  return members.find((m) => m.id === id)?.name ?? 'Unknown'
}

/**
 * Split an Atlas snapshot into per-project rows and upsert each into
 * Supabase's `atlas_cache`. Each row carries the tasks + meetings
 * that belong to that project so a future boot without Atlas
 * connectivity can rebuild the visible state from cache. The
 * `activity` column is left empty for now — activities are their own
 * table and don't need to be duplicated here.
 */
function cacheAtlasByProject(snapshot: AtlasSnapshot): void {
  const tasksByProject = new Map<string, Task[]>()
  for (const t of snapshot.tasks) {
    const list = tasksByProject.get(t.projectId) ?? []
    list.push(t)
    tasksByProject.set(t.projectId, list)
  }
  const meetingsByProject = new Map<string, Meeting[]>()
  for (const m of snapshot.meetings) {
    const list = meetingsByProject.get(m.projectId) ?? []
    list.push(m)
    meetingsByProject.set(m.projectId, list)
  }
  for (const p of snapshot.projects) {
    void upsertAtlasCache({
      project_slug: p.id,
      tasks: tasksByProject.get(p.id) ?? [],
      manifests: meetingsByProject.get(p.id) ?? [],
      activity: [],
    })
  }
}

/**
 * Mirror the Sheets snapshot into `atlas_cache` under a reserved
 * slug — Sheets currently owns just `contracting-com`, so a single
 * row is enough. Follow-up: if additional Sheets-backed projects
 * appear, drop the fixed slug and route through `cacheAtlasByProject`.
 */
function cacheSheetsSnapshot(snapshot: AtlasSnapshot): void {
  void upsertAtlasCache({
    project_slug: 'google-sheets-contracting',
    tasks: snapshot.tasks,
    manifests: snapshot.meetings,
    activity: [],
  })
}

export interface CreateTaskInput {
  title: string
  projectId: string
  description?: string
  assigneeId?: string | null
  priority?: Priority
  status?: TaskStatus
  dueDate?: string | null
  tags?: string[]
  /** Subtask titles to materialize alongside the task — used by templates. */
  subtasks?: string[]
}

export interface UpdateTaskInput {
  title?: string
  description?: string
  assigneeId?: string | null
  priority?: Priority
  status?: TaskStatus
  dueDate?: string | null
  tags?: string[]
}

export interface AddCommentOptions {
  mentions?: string[]
  label?: CommentLabel
  /** When set, the new comment is a reply. Replies are normalized to one
   *  level deep — replying to an existing reply uses the reply's
   *  `parentCommentId` instead. */
  parentCommentId?: string | null
}

const PIN_LIMIT = 5

export interface CreateProjectInput {
  name: string
  description?: string
  color: string
  memberIds?: string[]
}

export interface CreateMeetingInput {
  title: string
  projectId: string
  date: string
  startTime?: string | null
  duration?: number | null
  attendeeIds?: string[]
  status?: MeetingStatus
  location?: string | null
  agenda?: string | null
  notes?: string
}

/** Patch shape for `updateMeeting`. Sub-collections (decisions / action
 *  items / links) use replace-the-array semantics — callers compose the
 *  next list and pass it whole. */
export interface UpdateMeetingInput {
  title?: string
  date?: string
  startTime?: string | null
  duration?: number | null
  attendeeIds?: string[]
  status?: MeetingStatus
  location?: string | null
  agenda?: string | null
  notes?: string
  decisions?: Decision[]
  actionItems?: ActionItem[]
  questions?: MeetingQuestion[]
  links?: MeetingLink[]
}

export interface UpdateProjectInput {
  name?: string
  description?: string
  color?: string
  memberIds?: string[]
  archived?: boolean
}

export interface DataStore {
  // State
  teamMembers: TeamMember[]
  projects: Project[]
  tasks: Task[]
  tags: Tag[]
  activities: Activity[]
  notifications: Notification[]
  /** True while at least one mutation is in flight. */
  mutating: boolean
  /** True for ~500 ms after the provider mounts — gives pages something to
   *  show a skeleton against. Real backend will replace this with the
   *  network loading state. */
  isInitialLoading: boolean
  // ── Atlas hybrid mode ────────────────────────────────────────────────
  /** Source of the visible data: 'mock' when the in-memory fixtures are
   *  authoritative, 'atlas' when the API is configured and reachable. */
  dataSource: 'mock' | 'atlas' | 'google-sheets'
  /** ISO timestamp of the last successful Atlas snapshot, or null. */
  lastSynced: Date | null
  /** Human-readable error string from the most recent Atlas load, or null
   *  if the last load fully succeeded. Per-source failures during a partial
   *  load are joined with `;`. */
  syncError: string | null
  /** True while a background refresh is in flight (initial load uses
   *  `isInitialLoading` instead). */
  isRefreshing: boolean
  /** Force-refresh the Atlas snapshot. No-op in mock mode. The manual
   *  refresh re-pulls manifests too (the 60s background tick skips them
   *  for cost). */
  refreshFromAtlas: () => Promise<void>
  /** Pull a fresh 30-day meetings window from Atlas and merge into the
   *  store, preserving any local overlay edits. Cheaper than
   *  `refreshFromAtlas` because it skips projects/tasks/feed — used by
   *  the Meetings page on mount so a user navigating there always sees
   *  the latest manifests without waiting for the next background tick. */
  refreshMeetings: () => Promise<void>
  /** Task ids the user has touched locally — used by the board to render a
   *  "local change" indicator. Computed by diffing live tasks against the
   *  last raw Atlas snapshot; empty in mock mode. */
  locallyModifiedTaskIds: ReadonlySet<string>
  /** True iff Google Sheets is configured AND the most recent fetch
   *  produced data. Atlas tracks its own connection via `dataSource`. */
  sheetsConnected: boolean
  /** Per-tab column-mapping diagnostics from the last successful sheets
   *  fetch. Null in mock mode or before the first load completes. */
  sheetsDiagnostics: TabDiagnostics[] | null
  /** Per-project source-of-truth map. Pages don't usually need this —
   *  they read the projects/tasks directly — but Settings renders it
   *  and the badge tooltip can use it. */
  projectDataSources: ProjectDataSource[]
  /** Manually re-pull from Google Sheets. No-op when Sheets isn't
   *  configured. */
  refreshFromSheets: () => Promise<void>
  /** Raw Google Sheets row that produced each task — used by the
   *  TaskDetail "Raw Sheet Data" debug section. Empty in mock /
   *  Atlas-only mode. */
  sheetsRawRowsByTaskId: ReadonlyMap<string, SheetsRawRow>
  /** Lookup maps of the entities the last raw Atlas snapshot contained.
   *  Pages use these to ask "did this id originate from the API?" and to
   *  show what the API still says (e.g. the board's "Atlas still shows: X"
   *  tooltip on a locally-moved card). Empty maps in mock mode. */
  snapshotIndex: {
    tasksById: ReadonlyMap<string, Task>
    projectsById: ReadonlyMap<string, Project>
    meetingsById: ReadonlyMap<string, Meeting>
  }
  /** Workspace settings — persisted to localStorage so changes outlive a reload. */
  workspaceName: string
  /** Display labels for each canonical status, merged from defaults + user overrides. */
  statusLabels: Record<TaskStatus, string>
  /** Display order of the board columns. */
  columnOrder: TaskStatus[]

  // Workspace settings
  setWorkspaceName: (name: string) => void
  setStatusLabel: (status: TaskStatus, label: string) => void
  setColumnOrder: (order: TaskStatus[]) => void

  // Discord integration (PM-managed)
  discordSettings: DiscordSettings
  setDiscordSettings: (next: DiscordSettings) => void
  /** Sends a sample embed to the configured webhook and resolves with the result. */
  testDiscordWebhook: () => Promise<{ ok: boolean; error?: string }>

  // Task templates (PM-managed)
  templates: TaskTemplate[]
  createTemplate: (
    input: Omit<TaskTemplate, 'id' | 'createdAt'>,
  ) => TaskTemplate
  updateTemplate: (
    id: string,
    patch: Partial<Omit<TaskTemplate, 'id' | 'createdAt'>>,
  ) => void
  deleteTemplate: (id: string) => void

  // Meetings — discussions tied to a project
  meetings: Meeting[]
  createMeeting: (input: CreateMeetingInput) => Promise<Meeting>
  updateMeeting: (id: string, patch: UpdateMeetingInput) => Promise<Meeting>
  deleteMeeting: (id: string) => Promise<void>
  /**
   * Turn an action item into a full Task. Copies text, assignee, due date,
   * inherits the meeting's project. Sets `linkedTaskId` on the action item
   * AND `sourceMeetingId` / `sourceActionItemId` on the task for the back-
   * link banner. Pushes a `creation` activity describing the conversion
   * and (if enabled) fires the action-item-converted Discord embed.
   */
  convertActionItemToTask: (
    meetingId: string,
    actionItemId: string,
  ) => Promise<Task>

  // Task CRUD
  createTask: (input: CreateTaskInput) => Promise<Task>
  updateTask: (id: string, patch: UpdateTaskInput) => Promise<Task>
  deleteTask: (id: string) => Promise<void>
  /**
   * Apply the same patch to every task in `ids`. Activity/notification side
   * effects fire per task (matching single-update); Discord emits ONE summary
   * message scoped to the patch's primary field (status / assignee).
   */
  bulkUpdateTasks: (ids: string[], patch: UpdateTaskInput) => Promise<void>
  bulkDeleteTasks: (ids: string[]) => Promise<void>

  // Project CRUD
  createProject: (input: CreateProjectInput) => Promise<Project>
  updateProject: (id: string, patch: UpdateProjectInput) => Promise<Project>
  deleteProject: (id: string) => Promise<void>

  // Subtasks
  createSubtask: (
    taskId: string,
    title: string,
    assigneeId?: string | null,
  ) => Promise<Subtask>
  toggleSubtask: (taskId: string, subtaskId: string) => Promise<void>
  updateSubtask: (
    taskId: string,
    subtaskId: string,
    patch: { title?: string; assigneeId?: string | null },
  ) => Promise<void>
  deleteSubtask: (taskId: string, subtaskId: string) => Promise<void>
  reorderSubtasks: (taskId: string, orderedIds: string[]) => Promise<void>

  // Comments + raw activity
  addComment: (
    taskId: string,
    content: string,
    options?: AddCommentOptions,
  ) => Promise<Activity>
  addActivity: (
    taskId: string,
    type: ActivityType,
    content: string,
    mentions?: string[],
  ) => Activity
  /** Pin a comment to the task. Throws if the task already has 5 pinned. */
  pinComment: (commentId: string) => Promise<void>
  unpinComment: (commentId: string) => Promise<void>
  /** Toggle a question comment's `resolved` flag. */
  setQuestionResolved: (
    commentId: string,
    resolved: boolean,
  ) => Promise<void>
  /** Delete a comment and (if it has any) all its replies. */
  deleteCommentWithReplies: (commentId: string) => Promise<void>

  // Team members
  inviteTeamMember: (input: { name: string; email: string; role: Role }) => Promise<TeamMember>
  removeTeamMember: (id: string) => Promise<void>
  updateTeamMember: (
    id: string,
    patch: { name?: string; avatarUrl?: string | null },
  ) => Promise<void>

  // Tags
  createTag: (input: { name: string; color: string }) => Promise<Tag>
  updateTag: (id: string, patch: { name?: string; color?: string }) => Promise<void>
  deleteTag: (id: string) => Promise<void>

  // Notifications
  markNotificationRead: (id: string) => void
  markAllNotificationsRead: (recipientId?: string) => void
}

export type DataSourceType = 'mock' | 'atlas' | 'google-sheets'

export interface ProjectDataSource {
  projectId: string
  source: DataSourceType
  lastFetched: Date | null
  error: string | null
}

const DataContext = createContext<DataStore | null>(null)

export function DataProvider({ children }: { children: ReactNode }) {
  const { currentUser, logout } = useAuth()
  const navigate = useNavigate()
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>(() => {
    // Seed from the previous Atlas load's cached list when configured —
    // means the login dropdown is populated on the first paint of a
    // repeat visit instead of after the ~5s Atlas round-trip.
    if (isAtlasConfigured()) {
      const cached = loadJSON<TeamMember[] | null>(TEAM_MEMBERS_CACHE_KEY, null)
      if (cached && cached.length > 0) return cached
    }
    return mockTeamMembers
  })
  const [tags, setTags] = useState<Tag[]>(mockTags)
  const [projects, setProjects] = useState<Project[]>(mockProjects)
  const [tasks, setTasks] = useState<Task[]>(mockTasks)
  const [activities, setActivities] = useState<Activity[]>(mockActivities)
  const [notifications, setNotifications] = useState<Notification[]>(mockNotifications)
  const [meetings, setMeetings] = useState<Meeting[]>(mockMeetings)
  const [inflight, setInflight] = useState(0)
  const [isInitialLoading, setIsInitialLoading] = useState(true)

  // ── Atlas hybrid mode state ──────────────────────────────────────────
  // `dataSource` flips to 'atlas' on first successful load; mutations stay
  // local either way but, in 'atlas' mode, are diffed against the last raw
  // API snapshot and persisted to the localStorage overlay so they survive
  // the 60s refresh.
  const [dataSource, setDataSource] = useState<'mock' | 'atlas' | 'google-sheets'>(
    // Pre-seed to 'atlas' when configured so LoginPage renders the
    // passwordless Atlas variant on the first paint instead of flashing
    // the mock form. `runAtlasLoad` confirms or corrects this once the
    // load actually starts.
    () => (isAtlasConfigured() ? 'atlas' : 'mock'),
  )
  const [lastSynced, setLastSynced] = useState<Date | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  // Consecutive-failure counter: a single bad request shouldn't flag
  // the whole app as "Sync error" — the next background refresh
  // usually fixes it. Only surface the error after the threshold,
  // and reset on any clean load.
  const consecutiveSyncFailuresRef = useRef(0)
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false)
  const [snapshotIndex, setSnapshotIndex] = useState<{
    tasksById: ReadonlyMap<string, Task>
    projectsById: ReadonlyMap<string, Project>
    meetingsById: ReadonlyMap<string, Meeting>
  }>(() => ({
    tasksById: new Map(),
    projectsById: new Map(),
    meetingsById: new Map(),
  }))
  const [sheetsConnected, setSheetsConnected] = useState<boolean>(false)
  const [sheetsDiagnostics, setSheetsDiagnostics] = useState<
    TabDiagnostics[] | null
  >(null)
  const [projectDataSources, setProjectDataSources] = useState<
    ProjectDataSource[]
  >([])
  const [sheetsRawRowsByTaskId, setSheetsRawRowsByTaskId] = useState<
    ReadonlyMap<string, SheetsRawRow>
  >(() => new Map())
  /** Tracks whether the first Sheets snapshot has emitted its initial-
   *  sync activity yet. Prevents the 15-min refresh from spamming the
   *  activity feed. */
  const sheetsInitialSyncedRef = useRef<boolean>(false)
  /** Slim per-task snapshot from the previous successful sheets fetch.
   *  Used by the Discord change-detection emitter to diff status /
   *  priority / assignee against the new fetch. Title is kept so the
   *  embed can label changes by the original task title even after a
   *  row is removed. */
  const prevSheetsTasksRef = useRef<Map<string, PrevSheetTask> | null>(null)
  /** Time of the last successful Sheets fetch — surfaced in the
   *  failure embed's "Last successful sync" field. */
  const lastSheetsSyncRef = useRef<Date | null>(null)
  /** Forward reference to emitDiscord (declared later in this file).
   *  The Sheets loader populates this before emitDiscord exists, so we
   *  guard every call site against the null case. */
  const emitDiscordRef = useRef<
    | ((
        event: DiscordEvent,
        builder: () => import('@/services/discord').DiscordEmbed,
      ) => void)
    | null
  >(null)

  // Raw per-source snapshots — refs because the refresh loop reads the
  // latest values without needing to be a dependency of a useCallback.
  // The MERGED snapshot (atlas+sheets combined) is what we diff against
  // for the overlay; storing both raws lets either source refresh
  // independently and still produce a correct merge.
  const atlasRawRef = useRef<AtlasSnapshot | null>(null)
  const sheetsRawRef = useRef<AtlasSnapshot | null>(null)
  /** Raw API snapshot from the most recent successful load. The OVERLAY is
   *  derived by diffing live state against this — any entity whose
   *  reference no longer matches the snapshot's was touched locally. */
  const snapshotRef = useRef<AtlasSnapshot | null>(null)
  /** Local overlay, persisted to localStorage on every save. */
  const overlayRef = useRef<LocalOverlay>(emptyOverlay())
  /** Last overlay successfully shipped to Supabase. The state-watching
   *  sync effect diffs the live overlay against this to know what's
   *  new since the last write. Updated optimistically — failures are
   *  swallowed in the sync layer with a retry + toast. */
  const lastSyncedOverlayRef = useRef<LocalOverlay>(emptyOverlay())
  /** Guards the one-shot bootstrap effect so we don't re-pull Supabase
   *  data on every state change. */
  const supabaseBootstrappedRef = useRef<boolean>(false)

  useEffect(() => {
    // Read the persisted overlay once on mount so reloads keep local changes.
    overlayRef.current = loadOverlay()
    lastSyncedOverlayRef.current = overlayRef.current
  }, [])

  useEffect(() => {
    // Mock-mode initial-loading skeleton. In Atlas mode the loader below
    // owns this flag instead.
    if (isAtlasConfigured()) return
    const handle = window.setTimeout(
      () => setIsInitialLoading(false),
      INITIAL_LOAD_DELAY_MS,
    )
    return () => window.clearTimeout(handle)
  }, [])

  // Persisted workspace settings.
  const [workspaceName, setWorkspaceNameState] = useState<string>(() =>
    loadJSON<string>(WORKSPACE_NAME_KEY, DEFAULT_WORKSPACE_NAME),
  )
  const [statusLabelOverrides, setStatusLabelOverrides] = useState<
    Partial<Record<TaskStatus, string>>
  >(() => loadJSON(STATUS_LABEL_OVERRIDES_KEY, {}))
  const [columnOrder, setColumnOrderState] = useState<TaskStatus[]>(() => {
    const saved = loadJSON<TaskStatus[]>(COLUMN_ORDER_KEY, DEFAULT_COLUMN_ORDER)
    // Sanity check: ensure all canonical statuses are present and no extras.
    const allPresent = DEFAULT_COLUMN_ORDER.every((s) => saved.includes(s))
    return allPresent && saved.length === DEFAULT_COLUMN_ORDER.length
      ? saved
      : DEFAULT_COLUMN_ORDER
  })

  const statusLabels = useMemo<Record<TaskStatus, string>>(
    () => ({
      todo: statusLabelOverrides.todo ?? STATUS_LABELS.todo,
      in_progress: statusLabelOverrides.in_progress ?? STATUS_LABELS.in_progress,
      in_review: statusLabelOverrides.in_review ?? STATUS_LABELS.in_review,
      done: statusLabelOverrides.done ?? STATUS_LABELS.done,
    }),
    [statusLabelOverrides],
  )

  // app_settings keys — one row per setting, JSONB value. The local
  // store stays canonical (localStorage seeds the lazy initializers
  // above) and Supabase is the shared-team mirror — every setter
  // writes both. Reads aren't currently wired to prefer Supabase; the
  // bootstrap `settings` map is fetched but not folded into state yet.
  const mirrorSetting = (key: string, value: unknown) => {
    if (!isSupabaseConfigured()) return
    void setSetting(key, value)
  }

  const setWorkspaceName = useCallback<DataStore['setWorkspaceName']>((name) => {
    setWorkspaceNameState(name)
    saveJSON(WORKSPACE_NAME_KEY, name)
    mirrorSetting('workspace_name', name)
  }, [])

  const setStatusLabel = useCallback<DataStore['setStatusLabel']>(
    (status, label) => {
      setStatusLabelOverrides((prev) => {
        const next = { ...prev, [status]: label }
        saveJSON(STATUS_LABEL_OVERRIDES_KEY, next)
        mirrorSetting('status_label_overrides', next)
        return next
      })
    },
    [],
  )

  const setColumnOrder = useCallback<DataStore['setColumnOrder']>((order) => {
    setColumnOrderState(order)
    saveJSON(COLUMN_ORDER_KEY, order)
    mirrorSetting('column_order', order)
  }, [])

  // Discord settings — persisted to localStorage. The webhook URL is sensitive
  // (contains a secret token); in production you'd keep it server-side.
  const [discordSettings, setDiscordSettingsState] = useState<DiscordSettings>(
    () => {
      const saved = loadJSON<Partial<DiscordSettings>>(DISCORD_SETTINGS_KEY, {})
      return {
        ...DEFAULT_DISCORD_SETTINGS,
        ...saved,
        events: { ...DEFAULT_DISCORD_SETTINGS.events, ...(saved.events ?? {}) },
      }
    },
  )

  const setDiscordSettings = useCallback<DataStore['setDiscordSettings']>(
    (next) => {
      setDiscordSettingsState(next)
      saveJSON(DISCORD_SETTINGS_KEY, next)
      mirrorSetting('discord_settings', next)
    },
    [],
  )

  // Task templates — seeded on first load. Once the user has touched them
  // (edit or delete), the localStorage record takes over and the seed array
  // is no longer consulted, so deletions stay deleted across refreshes.
  const [templates, setTemplatesState] = useState<TaskTemplate[]>(() =>
    loadJSON<TaskTemplate[]>(TASK_TEMPLATES_KEY, DEFAULT_TASK_TEMPLATES),
  )

  const persistTemplates = useCallback((next: TaskTemplate[]) => {
    setTemplatesState(next)
    saveJSON(TASK_TEMPLATES_KEY, next)
    mirrorSetting('task_templates', next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const createTemplate = useCallback<DataStore['createTemplate']>(
    (input) => {
      const template: TaskTemplate = {
        id: uid('tmpl'),
        createdAt: new Date().toISOString(),
        ...input,
      }
      persistTemplates([...templates, template])
      return template
    },
    [templates, persistTemplates],
  )

  const updateTemplate = useCallback<DataStore['updateTemplate']>(
    (id, patch) => {
      persistTemplates(
        templates.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      )
    },
    [templates, persistTemplates],
  )

  const deleteTemplate = useCallback<DataStore['deleteTemplate']>(
    (id) => {
      persistTemplates(templates.filter((t) => t.id !== id))
    },
    [templates, persistTemplates],
  )

  const actorId = currentUser?.id ?? 'system'

  /** Subset of Activity fields callers can pass to enrich a feed entry. */
  type ActivityMetadata = Partial<
    Pick<
      Activity,
      | 'fromValue'
      | 'toValue'
      | 'fromMemberId'
      | 'toMemberId'
      | 'subtaskTitle'
      | 'taskTitle'
      | 'projectId'
      | 'memberId'
      | 'parentCommentId'
      | 'commentLabel'
      | 'isPinned'
      | 'pinnedBy'
      | 'resolved'
    >
  >

  /** Push a synthetic Activity entry (used both by external callers and by mutations). */
  const pushActivity = useCallback(
    (
      taskId: string | null,
      type: ActivityType,
      content: string,
      mentions: string[] = [],
      metadata: ActivityMetadata = {},
    ): Activity => {
      const entry: Activity = {
        id: uid('act'),
        taskId,
        actorId,
        type,
        content,
        mentions,
        createdAt: new Date().toISOString(),
        ...metadata,
      }
      setActivities((prev) => [...prev, entry])
      return entry
    },
    [actorId],
  )

  /** Push a synthetic Notification (does not deduplicate). */
  const pushNotification = useCallback(
    (input: {
      recipientId: string
      type: NotificationType
      taskId: string
      actor?: string | null
    }) => {
      // Don't notify yourself about your own action.
      if (input.recipientId === actorId) return
      // Respect the recipient's notification preferences (set on the Settings page).
      if (!notifTypeEnabled(input.recipientId, input.type)) return
      const entry: Notification = {
        id: uid('notif'),
        recipientId: input.recipientId,
        type: input.type,
        taskId: input.taskId,
        actorId: input.actor ?? actorId,
        read: false,
        createdAt: new Date().toISOString(),
      }
      setNotifications((prev) => [entry, ...prev])
    },
    [actorId],
  )

  async function withMutation<T>(fn: () => T | Promise<T>): Promise<T> {
    setInflight((n) => n + 1)
    try {
      await delay(MUTATION_DELAY_MS)
      return await fn()
    } finally {
      setInflight((n) => Math.max(0, n - 1))
    }
  }

  // ---- Discord emit ------------------------------------------------------
  //
  // Mutation callbacks (createTask / updateTask / addComment) are wrapped in
  // useCallback for stable identity. To avoid forcing them to depend on every
  // slice of state the embed builders need (projects, members, workspaceName,
  // discordSettings…), we mirror those into refs and read from the refs at
  // emit time. `emitDiscord` itself is therefore stable (empty deps) and
  // doesn't churn its parent callbacks.
  const tasksRef = useRef(tasks)
  const projectsRef = useRef(projects)
  const teamMembersRef = useRef(teamMembers)
  const statusLabelsRef = useRef(statusLabels)
  const workspaceNameRef = useRef(workspaceName)
  const discordSettingsRef = useRef(discordSettings)
  const activitiesRef = useRef(activities)

  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])
  useEffect(() => {
    projectsRef.current = projects
  }, [projects])
  useEffect(() => {
    teamMembersRef.current = teamMembers
  }, [teamMembers])
  useEffect(() => {
    statusLabelsRef.current = statusLabels
  }, [statusLabels])
  useEffect(() => {
    workspaceNameRef.current = workspaceName
  }, [workspaceName])
  useEffect(() => {
    discordSettingsRef.current = discordSettings
  }, [discordSettings])
  useEffect(() => {
    activitiesRef.current = activities
  }, [activities])

  // Atlas refresh reads live state via refs so it can run inside an
  // interval without churning callback dependencies. Meetings already have
  // their own ref further down (line ~1500); we mirror it here as well so
  // the refresh loop doesn't need to know about file layout.
  const atlasMeetingsRef = useRef(meetings)
  useEffect(() => {
    atlasMeetingsRef.current = meetings
  }, [meetings])
  const currentUserRef = useRef(currentUser)
  useEffect(() => {
    currentUserRef.current = currentUser
  }, [currentUser])

  // Persist the team-members list whenever a live source updates it.
  // The next app start reads this from the lazy initializer above so
  // the login dropdown appears immediately. Skip in mock mode to
  // avoid polluting the cache with seed fixtures.
  useEffect(() => {
    if (dataSource === 'mock') return
    if (teamMembers.length === 0) return
    saveJSON(TEAM_MEMBERS_CACHE_KEY, teamMembers)
  }, [teamMembers, dataSource])

  // ── Hybrid loader (Atlas + Google Sheets) ─────────────────────────────
  // The store keeps the two raw snapshots in refs and recombines them
  // every time either source finishes a load. The MERGED result is what
  // we diff against for the overlay and push to live state — that way
  // a sheets refresh doesn't blow away local edits to Atlas tasks and
  // vice versa.

  /**
   * Pure application step: take the current raw snapshots from refs,
   * merge them, capture any local changes vs. the prior merged snapshot,
   * update the overlay, set live state. Called by both atlas and sheets
   * loaders after they mutate their raw ref.
   */
  const applyCombinedSnapshot = useCallback(
    (opts: { meetingsMode: 'fresh' | 'preserve-prior' }) => {
      const merged = combineSourceSnapshots(
        atlasRawRef.current,
        sheetsRawRef.current,
      )
      // `meetingsMode === 'preserve-prior'` covers the 60s Atlas refresh
      // which skips manifests (and therefore meetings) — keep whatever
      // was in the previous merged snapshot rather than dropping all
      // meetings.
      const prevSnap = snapshotRef.current
      const effective: AtlasSnapshot =
        opts.meetingsMode === 'preserve-prior' && prevSnap
          ? { ...merged, meetings: prevSnap.meetings }
          : merged

      // Diff live state vs. prior merged snapshot → overlay update.
      const overlay = overlayRef.current
      let nextOverlay = overlay
      if (prevSnap) {
        nextOverlay = mergeDiffIntoOverlay(
          overlay,
          tasksRef.current,
          activitiesRef.current,
          projectsRef.current,
          atlasMeetingsRef.current,
          prevSnap,
        )
        overlayRef.current = nextOverlay
        saveOverlay(nextOverlay)
      }
      snapshotRef.current = effective

      // Project source map — used by Settings + the badge tooltip.
      const projectSources: ProjectDataSource[] = []
      const sheetsProjects = new Set(
        (sheetsRawRef.current?.projects ?? []).map((p) => p.id),
      )
      const atlasProjects = new Set(
        (atlasRawRef.current?.projects ?? []).map((p) => p.id),
      )
      const loadedAt = new Date(effective.loadedAt)
      for (const p of effective.projects) {
        const source: DataSourceType = sheetsProjects.has(p.id)
          ? 'google-sheets'
          : atlasProjects.has(p.id)
            ? 'atlas'
            : 'mock'
        projectSources.push({
          projectId: p.id,
          source,
          lastFetched: loadedAt,
          error: null,
        })
      }
      setProjectDataSources(projectSources)

      // Push merged snapshot + overlay into live state.
      setTasks(
        applyOverlayList(effective.tasks, nextOverlay.tasks, nextOverlay.taskTombstones),
      )
      setActivities(
        applyOverlayList(
          effective.activities,
          nextOverlay.activities,
          nextOverlay.activityTombstones,
        ),
      )
      setProjects(
        applyOverlayList(
          effective.projects,
          nextOverlay.projects,
          nextOverlay.projectTombstones,
        ),
      )
      setMeetings(
        applyOverlayList(
          effective.meetings,
          nextOverlay.meetings,
          nextOverlay.meetingTombstones,
        ),
      )
      setTeamMembers(effective.teamMembers)
      setSnapshotIndex({
        tasksById: new Map(effective.tasks.map((t) => [t.id, t])),
        projectsById: new Map(effective.projects.map((p) => [p.id, p])),
        meetingsById: new Map(effective.meetings.map((m) => [m.id, m])),
      })
      setLastSynced(new Date(effective.loadedAt))
      // Partial-load errors count as a failure for threshold purposes
      // but don't immediately flag the UI — the next background tick
      // typically clears them. Clean loads reset the counter.
      if (effective.errors.length > 0) {
        consecutiveSyncFailuresRef.current += 1
        if (consecutiveSyncFailuresRef.current >= SYNC_ERROR_THRESHOLD) {
          setSyncError(
            effective.errors
              .map((e) => `${e.source}: ${e.message}`)
              .join('; '),
          )
        }
      } else {
        consecutiveSyncFailuresRef.current = 0
        setSyncError(null)
      }

      // Redundancy layer: mirror the freshly-loaded per-project Atlas
      // snapshot into Supabase's atlas_cache. Each project gets one
      // row keyed by its slug so a later boot with a down Atlas can
      // fall back to the cached JSON. Fire-and-forget — the helper
      // logs on failure and never throws.
      if (isSupabaseConfigured() && atlasRawRef.current) {
        cacheAtlasByProject(atlasRawRef.current)
      }
      if (isSupabaseConfigured() && sheetsRawRef.current) {
        cacheSheetsSnapshot(sheetsRawRef.current)
      }
    },
    [],
  )

  /**
   * Purge stale Supabase rows: atlas_cache entries older than
   * `CACHE_ATLAS_TTL_MS` (usually left over from renamed slugs or
   * decommissioned sources) and activities older than
   * `CACHE_ACTIVITIES_TTL_MS` (past the UI's retention window).
   *
   * Throttled to once per calendar day via a localStorage timestamp
   * so a fast reload loop can't hammer Supabase with delete queries.
   * Runs after the initial data load so a fresh browser still gets a
   * populated cache to fall back on before the purge fires.
   */
  const runStaleCacheCleanup = useCallback(async () => {
    if (!isSupabaseConfigured()) return
    if (typeof window === 'undefined') return
    let lastRun = 0
    try {
      const raw = window.localStorage.getItem(CACHE_CLEANUP_STORAGE_KEY)
      if (raw) lastRun = Number(raw) || 0
    } catch {
      // storage unavailable — treat as never-run
    }
    if (Date.now() - lastRun < CACHE_CLEANUP_INTERVAL_MS) return

    const atlasCutoff = new Date(Date.now() - CACHE_ATLAS_TTL_MS).toISOString()
    const activityCutoff = new Date(
      Date.now() - CACHE_ACTIVITIES_TTL_MS,
    ).toISOString()

    try {
      await Promise.all([
        deleteStaleAtlasCache(atlasCutoff),
        deleteOldActivities(activityCutoff),
      ])
      window.localStorage.setItem(
        CACHE_CLEANUP_STORAGE_KEY,
        String(Date.now()),
      )
      // eslint-disable-next-line no-console
      console.info(
        `[cleanup] Purged atlas_cache < ${atlasCutoff} and activities < ${activityCutoff}`,
      )
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[cleanup] Failed to purge stale cache', err)
    }
  }, [])

  // `runAtlasLoad` is the single source of truth for "go fetch from Atlas
  // and merge into the store." Mount, the 60s interval, manual refresh,
  // and Settings save all funnel through it.
  //
  // `mode === 'refresh'` defaults to skipping manifests (the 60s tick
  // can't afford the fan-out). Pass `includeMeetings: true` explicitly
  // for a manual refresh that should also re-pull manifests.
  const runAtlasLoad = useCallback(
    async (
      mode: 'initial' | 'refresh',
      runOpts: { includeMeetings?: boolean } = {},
    ) => {
      const atlasOn = isAtlasConfigured()
      const sheetsOn = isGoogleSheetsConfigured()
      if (!atlasOn && !sheetsOn) {
        // No live source configured anywhere — mock mode.
        setDataSource('mock')
        setLastSynced(null)
        setSyncError(null)
        setSnapshotIndex({
          tasksById: new Map(),
          projectsById: new Map(),
          meetingsById: new Map(),
        })
        setProjectDataSources([])
        atlasRawRef.current = null
        return
      }
      if (!atlasOn) {
        // Sheets configured but Atlas isn't — surface that state but
        // don't actually fetch atlas (loadFromAtlas would throw on
        // not-configured anyway). Sheets' own loader handles its half.
        if (sheetsRawRef.current) {
          setDataSource('google-sheets')
        } else {
          setDataSource('mock')
        }
        return
      }
      setDataSource('atlas')
      if (mode === 'initial') setIsInitialLoading(true)
      setIsRefreshing(true)
      try {
        // Manifests rarely change between background refreshes — the
        // 60s tick skips them to keep the per-tick fan-out small.
        // The initial load and manual refresh both opt into meetings
        // so users never have to wait for the slow 5-min meetings
        // timer to catch up.
        const includeMeetings =
          runOpts.includeMeetings ?? mode === 'initial'
        const snapshot = await loadFromAtlas({
          includeMeetings,
          // When Sheets is active, it owns contracting-com — suppress
          // Atlas's copy so the two sources don't collide on the same id.
          excludeProjectIds: sheetsOn ? [SHEETS_PROJECT_ID] : [],
        })
        atlasRawRef.current = snapshot
        applyCombinedSnapshot({
          meetingsMode: includeMeetings ? 'fresh' : 'preserve-prior',
        })
      } catch (err) {
        // Same throttling rule as the partial-error path — a single
        // network blip shouldn't paint the bar red.
        consecutiveSyncFailuresRef.current += 1
        if (consecutiveSyncFailuresRef.current >= SYNC_ERROR_THRESHOLD) {
          setSyncError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (mode === 'initial') setIsInitialLoading(false)
        setIsRefreshing(false)
      }
    },
    [],
  )

  // Initial Atlas load + react to Settings → Atlas API saves (which fire
  // ATLAS_CONFIG_CHANGED_EVENT). In mock mode this is a no-op apart from
  // setting dataSource correctly.
  //
  // Two-phase boot: fast pass (projects + tasks + feed) lights up the
  // UI in ~1s, then a background meetings pass merges in the 30-day
  // manifest window without blocking. The login dropdown only needs
  // the team-members slice, which `extractTeamMembers` derives from
  // tasks alone — meetings just add stragglers who attended but never
  // received a task.
  useEffect(() => {
    void (async () => {
      await runAtlasLoad('initial', { includeMeetings: false })
      // Background passes — each no-ops when its source isn't
      // configured, so safe to fire unconditionally.
      void refreshMeetings()
      void runTranscriptLoad()
      // Once the initial load has landed a usable cache in Supabase,
      // it's safe to prune anything stale. Throttled to once per
      // day per browser.
      void runStaleCacheCleanup()
    })()
    const handler = () => {
      void (async () => {
        await runAtlasLoad('initial', { includeMeetings: false })
        void refreshMeetings()
        void runTranscriptLoad()
      })()
    }
    window.addEventListener(ATLAS_CONFIG_CHANGED_EVENT, handler)
    return () => window.removeEventListener(ATLAS_CONFIG_CHANGED_EVENT, handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runAtlasLoad])

  // 60-second auto-refresh. Only runs in Atlas mode; tears down when
  // mode flips back to mock (config cleared).
  useEffect(() => {
    if (dataSource !== 'atlas') return
    const id = window.setInterval(() => {
      void runAtlasLoad('refresh')
    }, ATLAS_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [dataSource, runAtlasLoad])

  // 10-minute today-only meeting refresh. The 60s loop skips
  // manifests (too heavy to refetch every minute against a full
  // 30-day window); this lighter tick probes only today's date per
  // project so meetings that finish mid-workday show up without a
  // page reload. New ones get appended to live state and surface
  // through the standard write-through (so Supabase persists them
  // too); existing ones are skipped to avoid clobbering local edits.
  useEffect(() => {
    if (dataSource !== 'atlas') return
    const tick = async () => {
      const sheetsOn = isGoogleSheetsConfigured()
      const excludeProjectIds = sheetsOn ? [SHEETS_PROJECT_ID] : []
      const fresh = await fetchTodaysMeetings({ excludeProjectIds })
      if (fresh.length === 0) return
      const knownIds = new Set(atlasMeetingsRef.current.map((m) => m.id))
      const additions = fresh.filter((m) => !knownIds.has(m.id))
      if (additions.length === 0) return
      setMeetings((prev) => [...prev, ...additions])
      toast.success(
        additions.length === 1
          ? 'New meeting data available'
          : `${additions.length} new meetings available`,
        {
          action: {
            label: 'View',
            onClick: () => navigate('/meetings'),
          },
          duration: 8_000,
        },
      )
    }
    const id = window.setInterval(() => {
      void tick()
    }, MEETINGS_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [dataSource, navigate])

  const refreshFromAtlas = useCallback(async () => {
    // Manual refresh — opt into the manifest fetch even though the
    // background tick skips it. The user just asked to see fresh data.
    await runAtlasLoad('refresh', { includeMeetings: true })
  }, [runAtlasLoad])

  /**
   * Re-fetch the 30-day meeting window across every project and merge
   * the result into the store. Cheaper than `refreshFromAtlas` because
   * it doesn't touch projects/tasks/feed. Preserves any local overlay
   * edits — fresh Atlas copies replace stale snapshot entries by id,
   * but a user's edited meeting keeps its override.
   *
   * Called by:
   *   - `MeetingsPage` on mount, so navigating there always lands on
   *     the latest Atlas state instead of whatever was loaded at app
   *     boot.
   *   - `ProjectDetailPage` when the meetings tab activates, same
   *     reason.
   */
  const refreshMeetings = useCallback<DataStore['refreshMeetings']>(
    async () => {
      if (!isAtlasConfigured()) return
      const snap = snapshotRef.current
      if (!snap) return
      const sheetsOn = isGoogleSheetsConfigured()
      const excludeProjectIds = sheetsOn ? [SHEETS_PROJECT_ID] : []
      let fresh: Meeting[]
      try {
        fresh = await fetchMeetingsForRange(30, { excludeProjectIds })
      } catch {
        // Network/Atlas hiccup — silent, the 5-min timer will retry.
        return
      }
      if (fresh.length === 0) return

      // Merge fresh into the source snapshot: replace by id, append new.
      // Meetings outside the 30-day window stay (we never fetched them
      // here, so we have no fresh value to compare).
      const freshById = new Map(fresh.map((m) => [m.id, m]))
      const seen = new Set<string>()
      const mergedMeetings: Meeting[] = []
      for (const m of snap.meetings) {
        const f = freshById.get(m.id)
        mergedMeetings.push(f ?? m)
        seen.add(m.id)
      }
      for (const f of fresh) {
        if (seen.has(f.id)) continue
        mergedMeetings.push(f)
      }

      snapshotRef.current = { ...snap, meetings: mergedMeetings }
      setSnapshotIndex((prev) => ({
        ...prev,
        meetingsById: new Map(mergedMeetings.map((m) => [m.id, m])),
      }))

      // Re-apply overlay over the freshened snapshot. Locally-edited
      // meetings keep their override; everything else picks up Atlas's
      // latest version.
      const overlay = overlayRef.current
      setMeetings(
        applyOverlayList(
          mergedMeetings,
          overlay.meetings,
          overlay.meetingTombstones,
        ),
      )

      // Persist new / changed Atlas meetings to Supabase. Atlas meetings
      // never go through the overlay choke-point (they're snapshot
      // entries, not user edits), so without this they'd be recomputed
      // from Atlas on every boot. Fire-and-forget; `upsertMeeting`
      // swallows errors. The unique constraint on `source_manifest_id`
      // keeps repeat upserts idempotent.
      if (isSupabaseConfigured()) {
        const prevById = new Map(snap.meetings.map((m) => [m.id, m]))
        const changedOrNew = fresh.filter((m) => prevById.get(m.id) !== m)
        if (changedOrNew.length > 0) {
          const actor = currentUserRef.current?.id ?? 'system'
          for (const meeting of changedOrNew) {
            const { row, decisions, actionItems, links } = meetingToRows(
              meeting,
              actor,
            )
            void upsertMeeting(row, {
              decisions,
              action_items: actionItems,
              links,
            })
          }
        }
      }
    },
    [],
  )

  /**
   * Background pull from the Transcript Store. Runs after the initial
   * Atlas load finishes so we can dedup-merge each transcript into
   * the matching Atlas meeting (same date + project). No-op when the
   * store isn't configured — the app still runs on Atlas + Sheets
   * alone.
   *
   * Also stashes the result in Supabase `atlas_cache` under the
   * reserved slug `transcripts` so the next boot can fall back to
   * the cache if the transcript-store endpoint is unreachable.
   */
  const runTranscriptLoad = useCallback(async () => {
    if (!isTranscriptStoreConfigured()) return
    const result = await loadFromTranscriptStore()
    if (result.errors.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[transcripts] ${result.errors.length} error(s) during load`,
        result.errors,
      )
    }
    if (result.meetings.length === 0) return

    // Merge transcript meetings into the current snapshot's meeting
    // list — Atlas meetings win on shared (date, project) keys, but
    // gain the transcript's summary, extra decisions, and extra
    // action items. Transcripts with no Atlas counterpart land as
    // standalone meetings.
    const snap = snapshotRef.current
    if (snap) {
      const merged = mergeAtlasAndTranscriptMeetings(
        snap.meetings,
        result.meetings,
      )
      snapshotRef.current = { ...snap, meetings: merged }
      setSnapshotIndex((prev) => ({
        ...prev,
        meetingsById: new Map(merged.map((m) => [m.id, m])),
      }))
      const overlay = overlayRef.current
      setMeetings(
        applyOverlayList(
          merged,
          overlay.meetings,
          overlay.meetingTombstones,
        ),
      )
    } else {
      // No source snapshot yet — surface the transcript meetings on
      // their own so the UI has something to render.
      setMeetings((prev) => {
        const known = new Set(prev.map((m) => m.id))
        const additions = result.meetings.filter((m) => !known.has(m.id))
        return additions.length > 0 ? [...prev, ...additions] : prev
      })
    }

    // Redundancy write to Supabase — future boots can hydrate from
    // here if the transcript store goes down. Fire-and-forget; the
    // helper swallows errors.
    if (isSupabaseConfigured()) {
      void upsertAtlasCache({
        project_slug: 'transcripts',
        tasks: result.tasks,
        manifests: result.meetings.map((m) => ({
          id: m.id,
          date: m.date,
          projectId: m.projectId,
          notes: m.notes,
        })),
        activity: result.index,
      })
    }
  }, [])

  // ── Supabase bootstrap (one-shot) ─────────────────────────────────────
  // Pull every Supabase table once the source snapshot is in place,
  // fold the rows into the in-memory overlay, and re-apply so the
  // shared-team edits land in live state. Gated on `lastSynced`
  // because we need a snapshot to attach overrides + subtasks against.
  // In mock mode (no source configured) we currently skip — the mock
  // fixtures aren't a join key Supabase can address against.
  useEffect(() => {
    if (supabaseBootstrappedRef.current) return
    if (!isSupabaseConfigured()) return
    if (lastSynced === null) return
    supabaseBootstrappedRef.current = true
    void (async () => {
      const bootstrap = await bootstrapFromSupabase(currentUser?.id ?? null)
      const merged = applyBootstrapToOverlay(overlayRef.current, bootstrap, {
        snapshotTasks: snapshotIndex.tasksById,
      })
      overlayRef.current = merged
      lastSyncedOverlayRef.current = merged
      saveOverlay(merged)
      // Push the augmented overlay into live state. `preserve-prior`
      // keeps the just-loaded meetings rather than re-fetching Atlas.
      applyCombinedSnapshot({ meetingsMode: 'preserve-prior' })
    })()
  }, [
    lastSynced,
    currentUser?.id,
    snapshotIndex.tasksById,
    applyCombinedSnapshot,
  ])

  // ── Supabase write-through ────────────────────────────────────────────
  // Whenever live state changes, recompute the overlay diff vs the
  // current snapshot, save to localStorage, and dispatch per-table
  // Supabase writes for whatever changed since the last sync.
  // Optimistic: state is already updated by the time we run.
  useEffect(() => {
    if (!isSupabaseConfigured()) return
    if (!supabaseBootstrappedRef.current) return
    const snap = snapshotRef.current
    if (!snap) return
    const nextOverlay = mergeDiffIntoOverlay(
      overlayRef.current,
      tasks,
      activities,
      projects,
      meetings,
      snap,
    )
    const prev = lastSyncedOverlayRef.current
    overlayRef.current = nextOverlay
    saveOverlay(nextOverlay)
    lastSyncedOverlayRef.current = nextOverlay
    void syncOverlayDiff(prev, nextOverlay, {
      snapshotTasks: snapshotIndex.tasksById,
      snapshotMeetings: snapshotIndex.meetingsById,
      actorId: currentUser?.id ?? 'system',
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, activities, projects, meetings])

  // ── Sheets loader ─────────────────────────────────────────────────────
  // Sheets has the same shape as Atlas but its own cadence (15 min vs 60s),
  // its own diagnostics, and its own success flag. It always shares the
  // overlay + snapshot-merge plumbing with Atlas via applyCombinedSnapshot.
  const runSheetsLoad = useCallback(async () => {
    if (!isGoogleSheetsConfigured()) {
      sheetsRawRef.current = null
      setSheetsConnected(false)
      setSheetsDiagnostics(null)
      return
    }
    setIsRefreshing(true)
    try {
      const { snapshot, diagnostics, rawRowsByTaskId } = await loadFromSheets()
      sheetsRawRef.current = snapshot
      setSheetsConnected(true)
      setSheetsDiagnostics(diagnostics)
      setSheetsRawRowsByTaskId(rawRowsByTaskId)
      if (!isAtlasConfigured()) {
        setDataSource('google-sheets')
      }
      applyCombinedSnapshot({ meetingsMode: 'preserve-prior' })

      const isFirstLoad = !sheetsInitialSyncedRef.current
      lastSheetsSyncRef.current = new Date(snapshot.loadedAt)

      if (isFirstLoad && snapshot.tasks.length > 0) {
        // One-time initial-sync activity for the in-app feed.
        sheetsInitialSyncedRef.current = true
        const entry: Activity = {
          id: `sheets-sync-${snapshot.loadedAt}`,
          taskId: null,
          actorId: 'sheets-import',
          type: 'creation',
          content: `Synced ${snapshot.tasks.length} task${snapshot.tasks.length === 1 ? '' : 's'} from Google Sheets for Contracting.com`,
          mentions: [],
          createdAt: snapshot.loadedAt,
          projectId: SHEETS_PROJECT_ID,
        }
        setActivities((prev) => [entry, ...prev])

        // Initial Discord post — fires regardless of how many fetches
        // happen in this session, but only after the FIRST successful
        // one. Gated by `sheets_initial_sync` toggle in Discord settings.
        emitDiscordRef.current?.('sheets_initial_sync', () =>
          buildSheetsInitialSyncEmbed({
            projectLabel: 'Contracting.com',
            tabs: diagnostics.map((d) => ({
              name: d.tabName,
              mappedTasks: d.mappedTasks,
            })),
            teamMemberNames: snapshot.teamMembers.map((m) => m.name),
          }),
        )
      } else if (!isFirstLoad && prevSheetsTasksRef.current) {
        // Refresh: diff against the previous snapshot and post only if
        // something actually changed.
        const changes = diffSheetsTasks(
          prevSheetsTasksRef.current,
          snapshot.tasks,
          statusLabelsRef.current,
        )
        if (changes.length > 0) {
          emitDiscordRef.current?.('sheets_changes_detected', () =>
            buildSheetsChangesDetectedEmbed({
              projectLabel: 'Contracting.com',
              changes,
            }),
          )
        }
      }

      // Roll the diff snapshot forward for the next refresh.
      prevSheetsTasksRef.current = new Map(
        snapshot.tasks.map((t) => [
          t.id,
          {
            title: t.title,
            status: t.status,
            priority: t.priority,
            assigneeId: t.assigneeId,
          },
        ]),
      )
    } catch (err) {
      sheetsRawRef.current = null
      setSheetsConnected(false)
      setSheetsDiagnostics(null)
      setSheetsRawRowsByTaskId(new Map())
      const message = err instanceof Error ? err.message : String(err)
      consecutiveSyncFailuresRef.current += 1
      if (consecutiveSyncFailuresRef.current >= SYNC_ERROR_THRESHOLD) {
        setSyncError(message)
      }
      // Failure embed — gated by sheets_sync_failed toggle. Useful when
      // the auth token has expired or the spreadsheet is temporarily
      // 5xx-ing; saves the user from finding out hours later.
      emitDiscordRef.current?.('sheets_sync_failed', () =>
        buildSheetsSyncFailedEmbed({
          projectLabel: 'Contracting.com',
          errorMessage: message,
          lastSuccessfulSync: lastSheetsSyncRef.current,
        }),
      )
    } finally {
      setIsRefreshing(false)
    }
  }, [applyCombinedSnapshot])

  // Initial Sheets load + 15-min refresh interval. Independent of the
  // Atlas effects so the two sources can be configured independently.
  useEffect(() => {
    void runSheetsLoad()
  }, [runSheetsLoad])

  useEffect(() => {
    if (!isGoogleSheetsConfigured()) return
    const intervalMs =
      getPollIntervalMinutes() * 60 * 1000 || SHEETS_REFRESH_INTERVAL_FALLBACK_MS
    const id = window.setInterval(() => {
      void runSheetsLoad()
    }, intervalMs)
    return () => window.clearInterval(id)
  }, [runSheetsLoad])

  const refreshFromSheets = useCallback(async () => {
    await runSheetsLoad()
  }, [runSheetsLoad])

  // Derive the locally-modified task id set every time tasks change in
  // a live-data mode. Reference equality against the last MERGED snapshot
  // is the same signal the overlay diff uses — keeps the indicator in
  // sync with what would be persisted on the next refresh.
  const locallyModifiedTaskIds = useMemo<ReadonlySet<string>>(() => {
    if (dataSource === 'mock') return new Set<string>()
    const snap = snapshotRef.current
    if (!snap) return new Set<string>()
    const snapById = new Map(snap.tasks.map((t) => [t.id, t]))
    const out = new Set<string>()
    for (const t of tasks) {
      if (snapById.get(t.id) !== t) out.add(t.id)
    }
    return out
  }, [tasks, dataSource])

  // When a live source kicks in, the team list flips from mock to the
  // union of API-derived members. A previously-logged-in mock user
  // (e.g. `pm-1`) will no longer match anyone in the new team, leaving
  // the UI showing a ghost user. Log them out so they re-pick from the
  // Atlas / Sheets dropdown.
  useEffect(() => {
    if (dataSource === 'mock') return
    if (!currentUser) return
    // Only enforce after the team list is populated — otherwise we'd log
    // out during the brief gap while the snapshot is still loading.
    if (teamMembers.length === 0) return
    if (!teamMembers.some((m) => m.id === currentUser.id)) {
      logout()
    }
  }, [dataSource, teamMembers, currentUser, logout])

  const emitDiscord = useCallback(
    (
      event: DiscordEvent,
      builder: () => import('@/services/discord').DiscordEmbed,
    ) => {
      const settings = discordSettingsRef.current
      if (!settings.webhookUrl) return
      if (!settings.events[event]) return
      const embed = builder()
      void sendDiscordWebhook(settings.webhookUrl, { embeds: [embed] })
    },
    [],
  )

  // The Sheets loader (declared earlier in the file for hook-ordering
  // reasons) needs emitDiscord to send sync events. We route through a
  // ref so the loader doesn't have to depend on emitDiscord's identity
  // and so file order stays flexible.
  emitDiscordRef.current = emitDiscord

  const testDiscordWebhook = useCallback<DataStore['testDiscordWebhook']>(
    async () => {
      const settings = discordSettingsRef.current
      if (!settings.webhookUrl) {
        return { ok: false, error: 'Add a webhook URL before testing.' }
      }
      const result = await sendDiscordWebhook(settings.webhookUrl, {
        embeds: [buildTestEmbed(workspaceNameRef.current)],
      })
      return result.ok
        ? { ok: true }
        : { ok: false, error: result.error ?? 'Unknown error.' }
    },
    [],
  )

  const createTask = useCallback<DataStore['createTask']>(
    (input) =>
      withMutation(() => {
        const now = new Date().toISOString()
        const taskId = uid('task')
        // Subtasks from a template / batch creation materialize on the same
        // task in a single setTasks call so the 800 ms mutation delay fires
        // once. They deliberately do NOT emit individual subtask_created
        // activity entries — the parent creation activity covers them.
        const initialSubtasks: Subtask[] = (input.subtasks ?? [])
          .map((title) => title.trim())
          .filter((title) => title.length > 0)
          .map((title, idx) => ({
            id: uid('sub'),
            taskId,
            title,
            assigneeId: null,
            done: false,
            sortOrder: idx,
            createdAt: now,
            completedAt: null,
          }))
        const task: Task = {
          id: taskId,
          title: input.title,
          description: input.description ?? '',
          projectId: input.projectId,
          assigneeId: input.assigneeId ?? null,
          priority: input.priority ?? 'medium',
          status: input.status ?? 'todo',
          dueDate: input.dueDate ?? null,
          tags: input.tags ?? [],
          subtasks: initialSubtasks,
          createdAt: now,
          updatedAt: now,
          createdBy: actorId,
        }
        setTasks((prev) => [...prev, task])
        pushActivity(task.id, 'creation', 'created this task', [], {
          projectId: task.projectId,
          taskTitle: task.title,
        })
        if (task.assigneeId) {
          pushActivity(
            task.id,
            'assignment',
            `assigned this to ${memberName(teamMembers, task.assigneeId)}`,
            [],
            { fromMemberId: null, toMemberId: task.assigneeId },
          )
          pushNotification({
            recipientId: task.assigneeId,
            type: 'assigned',
            taskId: task.id,
          })
        }
        emitDiscord('task_created', () =>
          buildTaskCreatedEmbed({
            task,
            project: projectsRef.current.find((p) => p.id === task.projectId),
            members: teamMembersRef.current,
          }),
        )
        return task
      }),
    [actorId, pushActivity, pushNotification, teamMembers, emitDiscord],
  )

  const updateTask = useCallback<DataStore['updateTask']>(
    (id, patch) =>
      withMutation(() => {
        // Capture the prior task once, outside the setter, so side effects
        // (activity / notification / Discord) run exactly once even when
        // React StrictMode invokes the updater twice in development.
        const prev = tasksRef.current.find((t) => t.id === id)
        if (!prev) {
          throw new Error(`Task ${id} not found`)
        }
        const next: Task = {
          ...prev,
          ...patch,
          updatedAt: new Date().toISOString(),
        }
        setTasks((cur) => cur.map((t) => (t.id === id ? next : t)))

        const actorName = memberName(teamMembersRef.current, actorId)

        if (patch.status !== undefined && patch.status !== prev.status) {
          pushActivity(
            id,
            'status_change',
            `moved this from ${statusLabels[prev.status]} to ${statusLabels[patch.status]}`,
            [],
            {
              fromValue: statusLabels[prev.status],
              toValue: statusLabels[patch.status],
            },
          )
          if (prev.assigneeId && prev.assigneeId !== actorId) {
            pushNotification({
              recipientId: prev.assigneeId,
              type: 'status_change',
              taskId: id,
            })
          }
          emitDiscord('task_status_changed', () =>
            buildTaskStatusChangedEmbed({
              task: next,
              fromStatus: prev.status,
              toStatus: patch.status!,
              actorName,
              statusLabels: statusLabelsRef.current,
            }),
          )
          if (patch.status === 'done' && prev.status !== 'done') {
            emitDiscord('task_completed', () =>
              buildTaskCompletedEmbed({
                task: next,
                project: projectsRef.current.find(
                  (p) => p.id === next.projectId,
                ),
                actorName,
              }),
            )
          }
        }
        if (
          patch.assigneeId !== undefined &&
          patch.assigneeId !== prev.assigneeId
        ) {
          pushActivity(
            id,
            'assignment',
            patch.assigneeId
              ? `assigned this to ${memberName(teamMembers, patch.assigneeId)}`
              : 'unassigned this task',
            [],
            {
              fromMemberId: prev.assigneeId,
              toMemberId: patch.assigneeId,
            },
          )
          if (patch.assigneeId) {
            pushNotification({
              recipientId: patch.assigneeId,
              type: 'assigned',
              taskId: id,
            })
            emitDiscord('task_assigned', () =>
              buildTaskAssignedEmbed({
                task: next,
                assigneeName: memberName(
                  teamMembersRef.current,
                  patch.assigneeId,
                ),
              }),
            )
          }
        }
        if (patch.priority !== undefined && patch.priority !== prev.priority) {
          pushActivity(
            id,
            'priority_change',
            `set priority from ${prev.priority} to ${patch.priority}`,
            [],
            {
              fromValue: prev.priority,
              toValue: patch.priority,
            },
          )
        }
        if (
          patch.dueDate !== undefined &&
          patch.dueDate !== prev.dueDate
        ) {
          pushActivity(
            id,
            'due_date_change',
            patch.dueDate
              ? `set due date to ${patch.dueDate}`
              : 'cleared the due date',
            [],
            {
              fromValue: prev.dueDate ?? undefined,
              toValue: patch.dueDate ?? undefined,
            },
          )
        }
        return next
      }),
    [
      actorId,
      pushActivity,
      pushNotification,
      teamMembers,
      statusLabels,
      emitDiscord,
    ],
  )

  const deleteTask = useCallback<DataStore['deleteTask']>(
    (id) =>
      withMutation(() => {
        // Snapshot the title BEFORE removal so the activity entry — which
        // survives in the feed — still has something to display.
        const snapshot = tasksRef.current.find((t) => t.id === id)
        setTasks((prev) => prev.filter((t) => t.id !== id))
        // Keep this task's existing activities; just append the deletion
        // marker. The dashboard feed will show "Alex deleted 'Foo'" alongside
        // any prior history.
        setNotifications((prev) => prev.filter((n) => n.taskId !== id))
        if (snapshot) {
          pushActivity(
            null,
            'task_deleted',
            `deleted task "${snapshot.title}"`,
            [],
            { taskTitle: snapshot.title, projectId: snapshot.projectId },
          )
        }
      }),
    [pushActivity],
  )

  const bulkUpdateTasks = useCallback<DataStore['bulkUpdateTasks']>(
    (ids, patch) =>
      withMutation(() => {
        if (ids.length === 0) return
        const idSet = new Set(ids)
        // Snapshot the previous tasks once so per-task side effects (activity /
        // notification / decision-making for Discord) see consistent state.
        const prevTasks = tasksRef.current.filter((t) => idSet.has(t.id))
        const updatedAt = new Date().toISOString()

        setTasks((cur) =>
          cur.map((t) =>
            idSet.has(t.id) ? { ...t, ...patch, updatedAt } : t,
          ),
        )

        const actorName = memberName(teamMembersRef.current, actorId)

        // Per-task activity + notifications (same as single updateTask).
        for (const prev of prevTasks) {
          if (patch.status !== undefined && patch.status !== prev.status) {
            pushActivity(
              prev.id,
              'status_change',
              `moved this from ${statusLabels[prev.status]} to ${statusLabels[patch.status]}`,
              [],
              {
                fromValue: statusLabels[prev.status],
                toValue: statusLabels[patch.status],
              },
            )
            if (prev.assigneeId && prev.assigneeId !== actorId) {
              pushNotification({
                recipientId: prev.assigneeId,
                type: 'status_change',
                taskId: prev.id,
              })
            }
          }
          if (
            patch.assigneeId !== undefined &&
            patch.assigneeId !== prev.assigneeId
          ) {
            pushActivity(
              prev.id,
              'assignment',
              patch.assigneeId
                ? `assigned this to ${memberName(teamMembers, patch.assigneeId)}`
                : 'unassigned this task',
              [],
              {
                fromMemberId: prev.assigneeId,
                toMemberId: patch.assigneeId,
              },
            )
            if (patch.assigneeId) {
              pushNotification({
                recipientId: patch.assigneeId,
                type: 'assigned',
                taskId: prev.id,
              })
            }
          }
          if (patch.priority !== undefined && patch.priority !== prev.priority) {
            pushActivity(
              prev.id,
              'priority_change',
              `set priority from ${prev.priority} to ${patch.priority}`,
              [],
              { fromValue: prev.priority, toValue: patch.priority },
            )
          }
          if (
            patch.dueDate !== undefined &&
            patch.dueDate !== prev.dueDate
          ) {
            pushActivity(
              prev.id,
              'due_date_change',
              patch.dueDate
                ? `set due date to ${patch.dueDate}`
                : 'cleared the due date',
              [],
              {
                fromValue: prev.dueDate ?? undefined,
                toValue: patch.dueDate ?? undefined,
              },
            )
          }
        }

        // ONE Discord summary, gated by the most-specific event toggle.
        const affectedCount = prevTasks.length
        if (
          patch.status === 'done' &&
          prevTasks.some((t) => t.status !== 'done')
        ) {
          emitDiscord('task_completed', () =>
            buildBulkUpdateEmbed({
              action: 'completed',
              count: affectedCount,
              actorName,
            }),
          )
        } else if (patch.status !== undefined) {
          emitDiscord('task_status_changed', () =>
            buildBulkUpdateEmbed({
              action: 'status',
              count: affectedCount,
              actorName,
              toStatusLabel: statusLabelsRef.current[patch.status!],
            }),
          )
        } else if (patch.assigneeId !== undefined && patch.assigneeId !== null) {
          emitDiscord('task_assigned', () =>
            buildBulkUpdateEmbed({
              action: 'assignee',
              count: affectedCount,
              actorName,
              assigneeName: memberName(
                teamMembersRef.current,
                patch.assigneeId,
              ),
            }),
          )
        }
        // priority, dueDate, unassign — no Discord summary (matches single-update behavior).
      }),
    [
      actorId,
      pushActivity,
      pushNotification,
      teamMembers,
      statusLabels,
      emitDiscord,
    ],
  )

  const bulkDeleteTasks = useCallback<DataStore['bulkDeleteTasks']>(
    (ids) =>
      withMutation(() => {
        if (ids.length === 0) return
        const idSet = new Set(ids)
        setTasks((prev) => prev.filter((t) => !idSet.has(t.id)))
        setActivities((prev) =>
          prev.filter((a) => a.taskId === null || !idSet.has(a.taskId)),
        )
        setNotifications((prev) => prev.filter((n) => !idSet.has(n.taskId)))
      }),
    [],
  )

  const createProject = useCallback<DataStore['createProject']>(
    (input) =>
      withMutation(() => {
        const now = new Date().toISOString()
        const project: Project = {
          id: uid('proj'),
          name: input.name,
          description: input.description ?? '',
          color: input.color,
          memberIds: input.memberIds ?? [actorId],
          archived: false,
          createdAt: now,
          updatedAt: now,
          createdBy: actorId,
        }
        setProjects((prev) => [...prev, project])
        pushActivity(
          null,
          'project_created',
          `created project "${project.name}"`,
          [],
          { projectId: project.id },
        )
        return project
      }),
    [actorId, pushActivity],
  )

  const updateProject = useCallback<DataStore['updateProject']>(
    (id, patch) =>
      withMutation(() => {
        let updated: Project | null = null
        setProjects((prev) =>
          prev.map((p) => {
            if (p.id !== id) return p
            const next: Project = {
              ...p,
              ...patch,
              updatedAt: new Date().toISOString(),
            }
            updated = next
            return next
          }),
        )
        if (!updated) throw new Error(`Project ${id} not found`)
        return updated
      }),
    [],
  )

  const deleteProject = useCallback<DataStore['deleteProject']>(
    (id) =>
      withMutation(() => {
        setProjects((prev) => prev.filter((p) => p.id !== id))
        // Cascade: drop tasks (and their activities/notifications) belonging to this project.
        setTasks((prev) => {
          const removedTaskIds = new Set(
            prev.filter((t) => t.projectId === id).map((t) => t.id),
          )
          setActivities((acts) =>
            acts.filter(
              (a) => a.taskId === null || !removedTaskIds.has(a.taskId),
            ),
          )
          setNotifications((notifs) =>
            notifs.filter((n) => !removedTaskIds.has(n.taskId)),
          )
          return prev.filter((t) => t.projectId !== id)
        })
      }),
    [],
  )

  const createSubtask = useCallback<DataStore['createSubtask']>(
    (taskId, title, assigneeId = null) =>
      withMutation(() => {
        let created: Subtask | null = null
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== taskId) return t
            const subtask: Subtask = {
              id: uid('sub'),
              taskId,
              title,
              assigneeId: assigneeId ?? null,
              done: false,
              sortOrder: t.subtasks.length,
              createdAt: new Date().toISOString(),
              completedAt: null,
            }
            created = subtask
            return {
              ...t,
              subtasks: [...t.subtasks, subtask],
              updatedAt: new Date().toISOString(),
            }
          }),
        )
        if (!created) throw new Error(`Task ${taskId} not found`)
        // Skip the activity entry for empty-title placeholders — those come
        // from the Tab-to-create rapid entry flow on the task detail page,
        // and emitting "added subtask \"\"" each time pollutes the feed.
        if (title.trim().length > 0) {
          pushActivity(
            taskId,
            'subtask_created',
            `added subtask "${title}"`,
            [],
            { subtaskTitle: title },
          )
        }
        return created
      }),
    [pushActivity],
  )

  const toggleSubtask = useCallback<DataStore['toggleSubtask']>(
    (taskId, subtaskId) =>
      withMutation(() => {
        let completedTitle: string | null = null
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== taskId) return t
            return {
              ...t,
              subtasks: t.subtasks.map((s) => {
                if (s.id !== subtaskId) return s
                const willBeDone = !s.done
                if (willBeDone) completedTitle = s.title
                return {
                  ...s,
                  done: willBeDone,
                  completedAt: willBeDone ? new Date().toISOString() : null,
                }
              }),
              updatedAt: new Date().toISOString(),
            }
          }),
        )
        if (completedTitle) {
          pushActivity(
            taskId,
            'subtask_complete',
            `completed subtask '${completedTitle}'`,
            [],
            { subtaskTitle: completedTitle },
          )
        }
      }),
    [pushActivity],
  )

  const updateSubtask = useCallback<DataStore['updateSubtask']>(
    (taskId, subtaskId, patch) =>
      withMutation(() => {
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== taskId) return t
            return {
              ...t,
              subtasks: t.subtasks.map((s) =>
                s.id === subtaskId ? { ...s, ...patch } : s,
              ),
              updatedAt: new Date().toISOString(),
            }
          }),
        )
      }),
    [],
  )

  const deleteSubtask = useCallback<DataStore['deleteSubtask']>(
    (taskId, subtaskId) =>
      withMutation(() => {
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== taskId) return t
            return {
              ...t,
              subtasks: t.subtasks
                .filter((s) => s.id !== subtaskId)
                .map((s, idx) => ({ ...s, sortOrder: idx })),
              updatedAt: new Date().toISOString(),
            }
          }),
        )
      }),
    [],
  )

  const reorderSubtasks = useCallback<DataStore['reorderSubtasks']>(
    (taskId, orderedIds) =>
      withMutation(() => {
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== taskId) return t
            const byId = new Map(t.subtasks.map((s) => [s.id, s]))
            const reordered = orderedIds
              .map((id, idx) => {
                const s = byId.get(id)
                return s ? { ...s, sortOrder: idx } : null
              })
              .filter((s): s is Subtask => s !== null)
            // Tail any IDs not present in the orderedIds list (defensive).
            for (const s of t.subtasks) {
              if (!orderedIds.includes(s.id)) {
                reordered.push({ ...s, sortOrder: reordered.length })
              }
            }
            return {
              ...t,
              subtasks: reordered,
              updatedAt: new Date().toISOString(),
            }
          }),
        )
      }),
    [],
  )

  const addComment = useCallback<DataStore['addComment']>(
    (taskId, content, options = {}) =>
      withMutation(() => {
        const mentions = options.mentions ?? []
        const label = options.label ?? 'note'

        // Normalize threading to 1 level deep — replying to a reply uses
        // the reply's parent so the tree never goes deeper.
        let parentCommentId: string | null = options.parentCommentId ?? null
        if (parentCommentId) {
          const parent = activitiesRef.current.find(
            (a) => a.id === parentCommentId,
          )
          if (parent?.parentCommentId) {
            parentCommentId = parent.parentCommentId
          }
        }

        const activity = pushActivity(taskId, 'comment', content, mentions, {
          commentLabel: label,
          parentCommentId,
          // Questions start unresolved; other labels don't carry the flag.
          ...(label === 'question' ? { resolved: false } : {}),
        })

        const task = tasksRef.current.find((t) => t.id === taskId)
        if (task?.assigneeId && task.assigneeId !== actorId) {
          pushNotification({
            recipientId: task.assigneeId,
            type: 'comment',
            taskId,
          })
        }
        mentions.forEach((mentionedId) => {
          if (mentionedId !== actorId) {
            pushNotification({
              recipientId: mentionedId,
              type: 'mention',
              taskId,
            })
          }
        })
        if (task) {
          emitDiscord('comment_posted', () =>
            buildCommentPostedEmbed({
              task,
              authorName: memberName(teamMembersRef.current, actorId),
              comment: content,
              label,
            }),
          )
        }
        return activity
      }),
    [actorId, pushActivity, pushNotification, emitDiscord],
  )

  const pinComment = useCallback<DataStore['pinComment']>(
    (commentId) =>
      withMutation(() => {
        const target = activitiesRef.current.find((a) => a.id === commentId)
        if (!target || target.type !== 'comment') {
          throw new Error(`Comment ${commentId} not found`)
        }
        if (target.isPinned) return
        const pinnedForTask = activitiesRef.current.filter(
          (a) =>
            a.type === 'comment' &&
            a.taskId === target.taskId &&
            a.isPinned,
        ).length
        if (pinnedForTask >= PIN_LIMIT) {
          throw new Error(`Pin limit (${PIN_LIMIT}) reached`)
        }
        setActivities((prev) =>
          prev.map((a) =>
            a.id === commentId ? { ...a, isPinned: true, pinnedBy: actorId } : a,
          ),
        )
      }),
    [actorId],
  )

  const unpinComment = useCallback<DataStore['unpinComment']>(
    (commentId) =>
      withMutation(() => {
        setActivities((prev) =>
          prev.map((a) =>
            a.id === commentId ? { ...a, isPinned: false, pinnedBy: null } : a,
          ),
        )
      }),
    [],
  )

  const setQuestionResolved = useCallback<DataStore['setQuestionResolved']>(
    (commentId, resolved) =>
      withMutation(() => {
        setActivities((prev) =>
          prev.map((a) =>
            a.id === commentId && a.type === 'comment' && a.commentLabel === 'question'
              ? { ...a, resolved }
              : a,
          ),
        )
      }),
    [],
  )

  const deleteCommentWithReplies = useCallback<
    DataStore['deleteCommentWithReplies']
  >(
    (commentId) =>
      withMutation(() => {
        const target = activitiesRef.current.find((a) => a.id === commentId)
        if (!target) return
        // Collect IDs to remove: the comment itself + every reply to it.
        const removeIds = new Set([commentId])
        for (const a of activitiesRef.current) {
          if (a.parentCommentId === commentId) removeIds.add(a.id)
        }
        setActivities((prev) => prev.filter((a) => !removeIds.has(a.id)))
        // Direct Supabase delete — the overlay choke-point only handles
        // updates/creates (mergeDiffIntoOverlay preserves removed
        // overrides), so deleting a locally-created comment never makes
        // it through the diff. Fire-and-forget; the helpers swallow
        // errors and log to the console.
        if (isSupabaseConfigured()) {
          for (const id of removeIds) {
            void deleteCommentApi(id)
            void deleteActivityApi(id)
          }
        }
      }),
    [],
  )

  const inviteTeamMember = useCallback<DataStore['inviteTeamMember']>(
    (input) =>
      withMutation(() => {
        const member: TeamMember = {
          id: uid('member'),
          name: input.name,
          email: input.email,
          role: input.role,
          avatarUrl: null,
          createdAt: new Date().toISOString(),
        }
        setTeamMembers((prev) => [...prev, member])
        pushActivity(
          null,
          'member_added',
          `added ${member.name} to the team`,
          [],
          { memberId: member.id },
        )
        return member
      }),
    [pushActivity],
  )

  const removeTeamMember = useCallback<DataStore['removeTeamMember']>(
    (id) =>
      withMutation(() => {
        const snapshot = teamMembersRef.current.find((m) => m.id === id)
        setTeamMembers((prev) => prev.filter((m) => m.id !== id))
        if (snapshot) {
          pushActivity(
            null,
            'member_removed',
            `removed ${snapshot.name} from the team`,
            [],
            { memberId: snapshot.id },
          )
        }
        // Cascade: unassign tasks + subtasks; drop their notifications.
        setTasks((prev) =>
          prev.map((t) => ({
            ...t,
            assigneeId: t.assigneeId === id ? null : t.assigneeId,
            subtasks: t.subtasks.map((s) => ({
              ...s,
              assigneeId: s.assigneeId === id ? null : s.assigneeId,
            })),
          })),
        )
        setNotifications((prev) => prev.filter((n) => n.recipientId !== id))
        // Strip from project member lists.
        setProjects((prev) =>
          prev.map((p) =>
            p.memberIds.includes(id)
              ? { ...p, memberIds: p.memberIds.filter((mid) => mid !== id) }
              : p,
          ),
        )
      }),
    [pushActivity],
  )

  const updateTeamMember = useCallback<DataStore['updateTeamMember']>(
    (id, patch) =>
      withMutation(() => {
        setTeamMembers((prev) =>
          prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
        )
      }),
    [],
  )

  const createTag = useCallback<DataStore['createTag']>(
    (input) =>
      withMutation(() => {
        const tag: Tag = {
          id: uid('tag'),
          name: input.name,
          color: input.color,
        }
        setTags((prev) => [...prev, tag])
        return tag
      }),
    [],
  )

  const updateTag = useCallback<DataStore['updateTag']>(
    (id, patch) =>
      withMutation(() => {
        setTags((prev) =>
          prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        )
      }),
    [],
  )

  const deleteTag = useCallback<DataStore['deleteTag']>(
    (id) =>
      withMutation(() => {
        setTags((prev) => prev.filter((t) => t.id !== id))
        // Cascade: strip the tag ID from every task that references it.
        setTasks((prev) =>
          prev.map((t) =>
            t.tags.includes(id)
              ? { ...t, tags: t.tags.filter((tid) => tid !== id) }
              : t,
          ),
        )
      }),
    [],
  )

  const markNotificationRead = useCallback<DataStore['markNotificationRead']>(
    (id) => {
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
      )
    },
    [],
  )

  // ---- Meetings ----------------------------------------------------------
  const meetingsRef = useRef(meetings)
  useEffect(() => {
    meetingsRef.current = meetings
  }, [meetings])

  const createMeeting = useCallback<DataStore['createMeeting']>(
    (input) =>
      withMutation(() => {
        const now = new Date().toISOString()
        const meeting: Meeting = {
          id: uid('meet'),
          title: input.title,
          projectId: input.projectId,
          date: input.date,
          startTime: input.startTime ?? null,
          duration: input.duration ?? null,
          attendeeIds: input.attendeeIds ?? [],
          status: input.status ?? 'scheduled',
          location: input.location ?? null,
          agenda: input.agenda ?? null,
          notes: input.notes ?? '',
          decisions: [],
          actionItems: [],
          questions: [],
          links: [],
          createdBy: actorId,
          createdAt: now,
          updatedAt: now,
          lastEditedBy: null,
          lastEditedAt: null,
        }
        setMeetings((prev) => [...prev, meeting])
        return meeting
      }),
    [actorId],
  )

  const updateMeeting = useCallback<DataStore['updateMeeting']>(
    (id, patch) =>
      withMutation(() => {
        const prev = meetingsRef.current.find((m) => m.id === id)
        if (!prev) throw new Error(`Meeting ${id} not found`)
        const now = new Date().toISOString()
        // Notes-edit also bumps `lastEditedBy/At` for the "Last edited by"
        // indicator. Other field changes don't — they're metadata, not
        // discussion content.
        const notesChanged =
          patch.notes !== undefined && patch.notes !== prev.notes
        const next: Meeting = {
          ...prev,
          ...patch,
          updatedAt: now,
          ...(notesChanged
            ? { lastEditedBy: actorId, lastEditedAt: now }
            : {}),
        }
        setMeetings((cur) => cur.map((m) => (m.id === id ? next : m)))

        // Discord: fire the completed-summary embed when status flips
        // INTO `completed`. Gated by the existing task_status_changed
        // toggle so meetings ride the same notification stream.
        if (
          patch.status === 'completed' &&
          prev.status !== 'completed'
        ) {
          emitDiscord('task_status_changed', () =>
            buildMeetingCompletedEmbed({
              meeting: next,
              project: projectsRef.current.find(
                (p) => p.id === next.projectId,
              ),
              attendeeNames: next.attendeeIds
                .map((mid) => teamMembersRef.current.find((m) => m.id === mid)?.name)
                .filter((n): n is string => Boolean(n)),
            }),
          )
        }
        return next
      }),
    [actorId, emitDiscord],
  )

  const deleteMeeting = useCallback<DataStore['deleteMeeting']>(
    (id) =>
      withMutation(() => {
        setMeetings((prev) => prev.filter((m) => m.id !== id))
        // Tasks that referenced this meeting via sourceMeetingId stay
        // alive — they're independent now. The task-detail banner falls
        // back to "Source meeting was deleted" when the lookup misses.
      }),
    [],
  )

  const convertActionItemToTask = useCallback<
    DataStore['convertActionItemToTask']
  >(
    async (meetingId, actionItemId) => {
      const meeting = meetingsRef.current.find((m) => m.id === meetingId)
      if (!meeting) throw new Error(`Meeting ${meetingId} not found`)
      const item = meeting.actionItems.find((a) => a.id === actionItemId)
      if (!item) throw new Error(`Action item ${actionItemId} not found`)
      if (item.linkedTaskId) {
        // Already linked — return the existing task.
        const existing = tasksRef.current.find((t) => t.id === item.linkedTaskId)
        if (existing) return existing
      }

      // Dedup pass: before spawning a new task, see if a similar one
      // already exists in this project. Catches the common loop where
      // a recurring topic gets re-extracted from each new meeting's
      // manifest. Threshold 0.7 — a little stricter than the global
      // detector because we'd rather risk a duplicate than wrongly
      // collapse two distinct items at a user-visible decision point.
      const match = findBestMatch(
        item.text,
        meeting.projectId,
        tasksRef.current,
        0.7,
      )
      if (match) {
        // Link the action item to the existing task instead of
        // spawning a duplicate. Fire the dedup log for PM review.
        setMeetings((prev) =>
          prev.map((m) =>
            m.id === meetingId
              ? {
                  ...m,
                  actionItems: m.actionItems.map((a) =>
                    a.id === actionItemId
                      ? { ...a, linkedTaskId: match.task.id }
                      : a,
                  ),
                  updatedAt: new Date().toISOString(),
                }
              : m,
          ),
        )
        toast.info(
          `Similar task already exists: "${match.task.title}". Linked instead of creating a duplicate.`,
          { duration: 6_000 },
        )
        if (isSupabaseConfigured()) {
          void recordDedupDecision({
            primary_task_id: match.task.id,
            duplicate_task_id: actionItemId,
            similarity: match.similarity,
            primary_source: 'task',
            duplicate_source: 'meeting-action-item',
            action: 'linked',
            reviewed_by: currentUserRef.current?.id ?? null,
          })
        }
        return match.task
      }

      // createTask runs withMutation, so the artificial 800ms delay fires
      // once for the whole conversion. After it resolves, we patch the
      // task's source fields, link the action item, and emit the Discord
      // embed + activity.
      const task = await createTask({
        title: item.text,
        projectId: meeting.projectId,
        assigneeId: item.assigneeId,
        dueDate: item.dueDate,
      })

      // Patch source fields on the freshly-created task. createTask doesn't
      // know about these (they're meeting-specific).
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id
            ? {
                ...t,
                sourceMeetingId: meetingId,
                sourceActionItemId: actionItemId,
              }
            : t,
        ),
      )

      // Mark the action item as linked.
      setMeetings((prev) =>
        prev.map((m) =>
          m.id === meetingId
            ? {
                ...m,
                actionItems: m.actionItems.map((a) =>
                  a.id === actionItemId ? { ...a, linkedTaskId: task.id } : a,
                ),
                updatedAt: new Date().toISOString(),
              }
            : m,
        ),
      )

      // Activity: "[Actor] created task '[Title]' from meeting '[Meeting]'"
      pushActivity(
        task.id,
        'creation',
        `created from meeting "${meeting.title}"`,
        [],
        { taskTitle: task.title },
      )

      // Discord — gated by task_created toggle (it IS a new task, after all).
      emitDiscord('task_created', () =>
        buildActionItemConvertedEmbed({
          actionItemText: item.text,
          meetingTitle: meeting.title,
          assigneeName: item.assigneeId
            ? memberName(teamMembersRef.current, item.assigneeId)
            : 'Unassigned',
          dueDate: item.dueDate,
        }),
      )

      return { ...task, sourceMeetingId: meetingId, sourceActionItemId: actionItemId }
    },
    [createTask, emitDiscord, pushActivity],
  )

  const markAllNotificationsRead = useCallback<
    DataStore['markAllNotificationsRead']
  >((recipientId) => {
    setNotifications((prev) =>
      prev.map((n) =>
        !recipientId || n.recipientId === recipientId ? { ...n, read: true } : n,
      ),
    )
  }, [])

  const value = useMemo<DataStore>(
    () => ({
      teamMembers,
      projects,
      tasks,
      tags,
      activities,
      notifications,
      mutating: inflight > 0,
      isInitialLoading,
      dataSource,
      lastSynced,
      syncError,
      isRefreshing,
      refreshFromAtlas,
      refreshMeetings,
      locallyModifiedTaskIds,
      snapshotIndex,
      sheetsConnected,
      sheetsDiagnostics,
      projectDataSources,
      refreshFromSheets,
      sheetsRawRowsByTaskId,
      workspaceName,
      statusLabels,
      columnOrder,
      setWorkspaceName,
      setStatusLabel,
      setColumnOrder,
      discordSettings,
      setDiscordSettings,
      testDiscordWebhook,
      templates,
      createTemplate,
      updateTemplate,
      deleteTemplate,
      meetings,
      createMeeting,
      updateMeeting,
      deleteMeeting,
      convertActionItemToTask,
      createTask,
      updateTask,
      deleteTask,
      bulkUpdateTasks,
      bulkDeleteTasks,
      createProject,
      updateProject,
      deleteProject,
      createSubtask,
      toggleSubtask,
      updateSubtask,
      deleteSubtask,
      reorderSubtasks,
      addComment,
      pinComment,
      unpinComment,
      setQuestionResolved,
      deleteCommentWithReplies,
      addActivity: pushActivity,
      inviteTeamMember,
      removeTeamMember,
      updateTeamMember,
      createTag,
      updateTag,
      deleteTag,
      markNotificationRead,
      markAllNotificationsRead,
    }),
    [
      teamMembers,
      projects,
      tasks,
      tags,
      activities,
      notifications,
      inflight,
      isInitialLoading,
      dataSource,
      lastSynced,
      syncError,
      isRefreshing,
      refreshFromAtlas,
      refreshMeetings,
      locallyModifiedTaskIds,
      snapshotIndex,
      sheetsConnected,
      sheetsDiagnostics,
      projectDataSources,
      refreshFromSheets,
      sheetsRawRowsByTaskId,
      workspaceName,
      statusLabels,
      columnOrder,
      setWorkspaceName,
      setStatusLabel,
      setColumnOrder,
      discordSettings,
      setDiscordSettings,
      testDiscordWebhook,
      templates,
      createTemplate,
      updateTemplate,
      deleteTemplate,
      meetings,
      createMeeting,
      updateMeeting,
      deleteMeeting,
      convertActionItemToTask,
      createTask,
      updateTask,
      deleteTask,
      bulkUpdateTasks,
      bulkDeleteTasks,
      createProject,
      updateProject,
      deleteProject,
      createSubtask,
      toggleSubtask,
      updateSubtask,
      deleteSubtask,
      reorderSubtasks,
      addComment,
      pushActivity,
      inviteTeamMember,
      removeTeamMember,
      updateTeamMember,
      createTag,
      updateTag,
      deleteTag,
      markNotificationRead,
      markAllNotificationsRead,
    ],
  )

  return createElement(DataContext.Provider, { value }, children)
}

export function useData(): DataStore {
  const ctx = useContext(DataContext)
  if (!ctx) {
    throw new Error('useData must be used inside a <DataProvider>')
  }
  return ctx
}
