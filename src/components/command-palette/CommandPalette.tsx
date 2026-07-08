import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CheckSquare,
  FileText,
  FolderOpen,
  FolderPlus,
  LayoutDashboard,
  LayoutGrid,
  ListChecks,
  ListTodo,
  LogOut,
  Plus,
  Search,
  Settings as SettingsIcon,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { StatusPill } from '@/components/shared/StatusPill'
import { useAuth } from '@/data/auth'
import { usePermissions } from '@/hooks/usePermissions'
import { useTaskPanel } from '@/data/task-panel'
import { useData } from '@/data/store'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { formatMeetingDate } from '@/lib/date-utils'
import { SHORTCUTS, type ShortcutKey } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'
import type { Project, Task, TeamMember } from '@/data/types'

const MAX_PER_GROUP = 5
const DEBOUNCE_MS = 300

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  /** Opens the Create Task modal at the global level (so it works from any page). */
  onCreateTask: () => void
}

type ActionId =
  | 'create-task'
  | 'create-project'
  | 'go-dashboard'
  | 'go-board'
  | 'go-my-tasks'
  | 'go-projects'
  | 'go-team'
  | 'go-settings'
  | 'logout'

interface ActionDef {
  id: ActionId
  label: string
  icon: LucideIcon
  /** Shown under the label as additional context. */
  hint?: string
  shortcut?: ShortcutKey
  /** PM-only actions are filtered out for member-role users. */
  pmOnly?: boolean
}

const ACTIONS: ActionDef[] = [
  {
    id: 'create-task',
    label: 'Create task',
    icon: Plus,
    hint: 'Open the new task dialog',
    shortcut: 'createTask',
    pmOnly: true,
  },
  {
    id: 'create-project',
    label: 'Create project',
    icon: FolderPlus,
    hint: 'Open the new project dialog',
    pmOnly: true,
  },
  {
    id: 'go-dashboard',
    label: 'Go to dashboard',
    icon: LayoutDashboard,
    shortcut: 'goDashboard',
    pmOnly: true,
  },
  { id: 'go-board', label: 'Go to board', icon: LayoutGrid, shortcut: 'goBoard' },
  { id: 'go-my-tasks', label: 'Go to my tasks', icon: ListTodo, shortcut: 'goMyTasks' },
  { id: 'go-projects', label: 'Go to projects', icon: FolderOpen, shortcut: 'goProjects' },
  { id: 'go-team', label: 'Go to team', icon: Users, shortcut: 'goTeam' },
  { id: 'go-settings', label: 'Go to settings', icon: SettingsIcon },
  { id: 'logout', label: 'Log out', icon: LogOut },
]

interface ActionHit {
  kind: 'action'
  action: ActionDef
}

interface TaskHit {
  kind: 'task'
  task: Task
  project: Project | undefined
  assignee: TeamMember | undefined
}

interface ProjectHit {
  kind: 'project'
  project: Project
  taskCount: number
}

interface MeetingHit {
  kind: 'meeting'
  meeting: import('@/data/types').Meeting
  project: Project | undefined
}

type Hit = ActionHit | TaskHit | ProjectHit | MeetingHit

export function CommandPalette({ open, onClose, onCreateTask }: CommandPaletteProps) {
  const navigate = useNavigate()
  const { openTask } = useTaskPanel()
  const { isPM, logout } = useAuth()
  const { canSeeAllProjects, canSeeProject, canSeeTask } = usePermissions()
  const {
    tasks: allTasks,
    projects: allProjects,
    teamMembers,
    meetings: allMeetings,
  } = useData()

  // RBAC: results are filtered so a Member can't discover work they
  // don't have access to via search. PM sees everything (no filter).
  const tasks = useMemo(
    () => (canSeeAllProjects ? allTasks : allTasks.filter((t) => canSeeTask(t))),
    [allTasks, canSeeAllProjects, canSeeTask],
  )
  const projects = useMemo(
    () =>
      canSeeAllProjects
        ? allProjects
        : allProjects.filter((p) => canSeeProject(p.id)),
    [allProjects, canSeeAllProjects, canSeeProject],
  )
  const meetings = useMemo(
    () =>
      canSeeAllProjects
        ? allMeetings
        : allMeetings.filter((m) => canSeeProject(m.projectId)),
    [allMeetings, canSeeAllProjects, canSeeProject],
  )

  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)

  useEffect(() => {
    if (open) {
      setInput('')
      setQuery('')
      setHighlight(0)
      queueMicrotask(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handle = window.setTimeout(() => setQuery(input.trim()), DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [input, open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  const visibleActions = useMemo(
    () => ACTIONS.filter((a) => !a.pmOnly || isPM),
    [isPM],
  )

  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  )
  const memberById = useMemo(
    () => new Map(teamMembers.map((m) => [m.id, m])),
    [teamMembers],
  )
  const tasksByProject = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of tasks) {
      map.set(t.projectId, (map.get(t.projectId) ?? 0) + 1)
    }
    return map
  }, [tasks])

  const { actionHits, taskHits, projectHits, meetingHits, hits } = useMemo(() => {
    const q = query.toLowerCase()
    const actionHits: ActionHit[] = (
      q
        ? visibleActions.filter((a) => a.label.toLowerCase().includes(q))
        : visibleActions
    )
      .slice(0, MAX_PER_GROUP)
      .map((a) => ({ kind: 'action' as const, action: a }))

    const taskHits: TaskHit[] = !q
      ? []
      : tasks
          .filter(
            (t) =>
              t.title.toLowerCase().includes(q) ||
              t.description.toLowerCase().includes(q),
          )
          .slice(0, MAX_PER_GROUP)
          .map((t) => ({
            kind: 'task' as const,
            task: t,
            project: projectById.get(t.projectId),
            assignee: t.assigneeId ? memberById.get(t.assigneeId) : undefined,
          }))

    const projectHits: ProjectHit[] = !q
      ? []
      : projects
          .filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              p.description.toLowerCase().includes(q),
          )
          .slice(0, MAX_PER_GROUP)
          .map((p) => ({
            kind: 'project' as const,
            project: p,
            taskCount: tasksByProject.get(p.id) ?? 0,
          }))

    // Meeting matches: title is the strong signal; also peek at notes so
    // a search for a topic mentioned in discussion surfaces the meeting.
    const meetingHits: MeetingHit[] = !q
      ? []
      : meetings
          .filter(
            (m) =>
              m.title.toLowerCase().includes(q) ||
              m.notes.toLowerCase().includes(q),
          )
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, MAX_PER_GROUP)
          .map((m) => ({
            kind: 'meeting' as const,
            meeting: m,
            project: projectById.get(m.projectId),
          }))

    return {
      actionHits,
      taskHits,
      projectHits,
      meetingHits,
      hits: [...actionHits, ...taskHits, ...projectHits, ...meetingHits] as Hit[],
    }
  }, [query, visibleActions, tasks, projects, meetings, projectById, memberById, tasksByProject])

  useEffect(() => {
    setHighlight(0)
  }, [hits.length])

  const runAction = (action: ActionDef) => {
    onClose()
    switch (action.id) {
      case 'create-task':
        onCreateTask()
        return
      case 'create-project':
        navigate('/projects?new=1')
        return
      case 'go-dashboard':
        navigate('/dashboard')
        return
      case 'go-board':
        navigate('/board')
        return
      case 'go-my-tasks':
        navigate('/my-tasks')
        return
      case 'go-projects':
        navigate('/projects')
        return
      case 'go-team':
        navigate('/team')
        return
      case 'go-settings':
        navigate('/settings')
        return
      case 'logout':
        logout()
        navigate('/login')
        return
    }
  }

  const selectHit = (hit: Hit) => {
    if (hit.kind === 'task') {
      openTask(hit.task.id)
      onClose()
    } else if (hit.kind === 'project') {
      navigate(`/projects/${hit.project.id}`)
      onClose()
    } else if (hit.kind === 'meeting') {
      navigate(`/projects/${hit.meeting.projectId}/meetings/${hit.meeting.id}`)
      onClose()
    } else {
      runAction(hit.action)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (hits.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => (h + 1) % hits.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => (h - 1 + hits.length) % hits.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = hits[highlight]
      if (hit) selectHit(hit)
    }
  }

  if (!open) return null

  const offset = {
    action: 0,
    task: actionHits.length,
    project: actionHits.length + taskHits.length,
    meeting:
      actionHits.length + taskHits.length + projectHits.length,
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-4 md:pt-[10vh]"
      onKeyDown={handleKeyDown}
    >
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        className="relative w-full max-w-[480px] animate-[modalIn_200ms_ease-out] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[0_4px_16px_rgba(0,0,0,0.3)]"
      >
        <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
          <Search
            className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search or jump to…"
            aria-label="Search workspace and run commands"
            className="h-8 flex-1 bg-transparent text-[15px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
          <Kbd>Esc</Kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {actionHits.length === 0 &&
          taskHits.length === 0 &&
          projectHits.length === 0 &&
          meetingHits.length === 0 ? (
            <NoResults query={query} />
          ) : (
            <>
              {actionHits.length > 0 && (
                <Group title="Actions">
                  {actionHits.map((hit, i) => (
                    <ActionRow
                      key={hit.action.id}
                      hit={hit}
                      active={highlight === offset.action + i}
                      onHover={() => setHighlight(offset.action + i)}
                      onClick={() => selectHit(hit)}
                    />
                  ))}
                </Group>
              )}

              {taskHits.length > 0 && (
                <Group title="Tasks">
                  {taskHits.map((hit, i) => (
                    <TaskRow
                      key={hit.task.id}
                      hit={hit}
                      active={highlight === offset.task + i}
                      onHover={() => setHighlight(offset.task + i)}
                      onClick={() => selectHit(hit)}
                    />
                  ))}
                </Group>
              )}

              {projectHits.length > 0 && (
                <Group title="Projects">
                  {projectHits.map((hit, i) => (
                    <ProjectRow
                      key={hit.project.id}
                      hit={hit}
                      active={highlight === offset.project + i}
                      onHover={() => setHighlight(offset.project + i)}
                      onClick={() => selectHit(hit)}
                    />
                  ))}
                </Group>
              )}

              {meetingHits.length > 0 && (
                <Group title="Meetings">
                  {meetingHits.map((hit, i) => (
                    <MeetingRow
                      key={hit.meeting.id}
                      hit={hit}
                      active={highlight === offset.meeting + i}
                      onHover={() => setHighlight(offset.meeting + i)}
                      onClick={() => selectHit(hit)}
                    />
                  ))}
                </Group>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.5px] text-[var(--text-muted)]">
      {children}
    </kbd>
  )
}

function ShortcutHint({ shortcut }: { shortcut: ShortcutKey | undefined }) {
  if (!shortcut) return null
  const { keys } = SHORTCUTS[shortcut]
  return (
    <span
      className="hidden items-center gap-1 sm:inline-flex"
      aria-label={`Shortcut: ${keys.join(' ')}`}
    >
      {keys.map((k, i) => (
        <Kbd key={`${k}-${i}`}>{k}</Kbd>
      ))}
    </span>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="py-1">
      <p className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--text-muted)]">
        {title}
      </p>
      <ul>{children}</ul>
    </div>
  )
}

function ActionRow({
  hit,
  active,
  onHover,
  onClick,
}: {
  hit: ActionHit
  active: boolean
  onHover: () => void
  onClick: () => void
}) {
  const Icon = hit.action.icon
  return (
    <li>
      <button
        type="button"
        onMouseEnter={onHover}
        onClick={onClick}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors',
          active ? 'bg-[var(--bg-surface)]' : 'hover:bg-[var(--bg-surface)]',
        )}
      >
        <Icon
          className="h-4 w-4 shrink-0 text-[var(--text-secondary)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-[var(--text-primary)]">
            {hit.action.label}
          </p>
          {hit.action.hint && (
            <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
              {hit.action.hint}
            </p>
          )}
        </div>
        <ShortcutHint shortcut={hit.action.shortcut} />
      </button>
    </li>
  )
}

function TaskRow({
  hit,
  active,
  onHover,
  onClick,
}: {
  hit: TaskHit
  active: boolean
  onHover: () => void
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onMouseEnter={onHover}
        onClick={onClick}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors',
          active ? 'bg-[var(--bg-surface)]' : 'hover:bg-[var(--bg-surface)]',
        )}
      >
        <ListChecks
          className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-[var(--text-primary)]">
            {hit.task.title}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
            {hit.project && (
              <>
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: hit.project.color }}
                  aria-hidden="true"
                />
                <span className="truncate">{hit.project.name}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span className="truncate">
              {hit.assignee ? hit.assignee.name : 'Unassigned'}
            </span>
          </p>
        </div>
        <StatusPill status={hit.task.status} />
      </button>
    </li>
  )
}

function ProjectRow({
  hit,
  active,
  onHover,
  onClick,
}: {
  hit: ProjectHit
  active: boolean
  onHover: () => void
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onMouseEnter={onHover}
        onClick={onClick}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors',
          active ? 'bg-[var(--bg-surface)]' : 'hover:bg-[var(--bg-surface)]',
        )}
      >
        <span
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded"
          style={{
            backgroundColor: `color-mix(in srgb, ${hit.project.color} 20%, transparent)`,
          }}
        >
          <CheckSquare
            className="h-3.5 w-3.5"
            style={{ color: hit.project.color }}
            aria-hidden="true"
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-[var(--text-primary)]">
            {hit.project.name}
          </p>
          {hit.project.description && (
            <p className="mt-0.5 truncate text-xs text-[var(--text-secondary)]">
              {hit.project.description}
            </p>
          )}
        </div>
        <span className="shrink-0 text-xs text-[var(--text-muted)] tabular-nums">
          {hit.taskCount} {hit.taskCount === 1 ? 'task' : 'tasks'}
        </span>
      </button>
    </li>
  )
}

function MeetingRow({
  hit,
  active,
  onHover,
  onClick,
}: {
  hit: MeetingHit
  active: boolean
  onHover: () => void
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onMouseEnter={onHover}
        onClick={onClick}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors',
          active ? 'bg-[var(--bg-surface)]' : 'hover:bg-[var(--bg-surface)]',
        )}
      >
        <FileText
          className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-[var(--text-primary)]">
            {hit.meeting.title}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
            {hit.project && (
              <>
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: hit.project.color }}
                  aria-hidden="true"
                />
                <span className="truncate">{hit.project.name}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span className="truncate">{formatMeetingDate(hit.meeting.date)}</span>
          </p>
        </div>
      </button>
    </li>
  )
}

function NoResults({ query }: { query: string }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm text-[var(--text-secondary)]">
        No results for &lsquo;
        <span className="text-[var(--text-primary)]">{query}</span>&rsquo;.
      </p>
    </div>
  )
}
