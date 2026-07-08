import { useEffect, useMemo, useState } from 'react'
import {
  Link,
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import {
  CalendarDays,
  Columns3,
  FileText,
  List,
  Plus,
  Settings,
} from 'lucide-react'
import { CalendarView, type CalendarItem } from '@/components/CalendarView'
import type { Meeting, TeamMember } from '@/data/types'
import { toast } from 'sonner'
import { BoardView } from '@/components/board/BoardView'
import { Breadcrumb } from '@/components/Breadcrumb'
import { MeetingList } from '@/components/meetings/MeetingList'
import {
  MeetingFormModal,
  type MeetingFormValues,
} from '@/components/meetings/MeetingFormModal'
import { RecordingsSection } from '@/components/recordings/RecordingsSection'
import { buildRecordingDateSet } from '@/components/recordings/RecordingsSection'
import {
  ProjectFormModal,
  type ProjectFormValues,
} from '@/components/projects/ProjectFormModal'
import { ConfirmModal } from '@/components/shared/ConfirmModal'
import { AvatarStack } from '@/components/shared/AvatarStack'
import { useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import { usePermissions } from '@/hooks/usePermissions'
import { AccessDenied } from '@/components/shared/AccessDenied'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useZoomBot } from '@/hooks/useZoomBot'
import { isOverdue } from '@/lib/date-utils'
import { cn } from '@/lib/utils'

type Tab = 'board' | 'meetings'

function parseTab(raw: string | null): Tab {
  return raw === 'meetings' ? 'meetings' : 'board'
}

type Confirm = { kind: 'archive' | 'delete' } | null

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { isPM } = useAuth()
  const { canSeeProject, canSeeMeeting } = usePermissions()
  const {
    projects,
    tasks,
    meetings,
    teamMembers,
    createMeeting,
    updateProject,
    deleteProject,
    dataSource,
    snapshotIndex,
    projectDataSources,
    refreshMeetings,
  } = useData()
  const { recordings } = useZoomBot()

  const [searchParams, setSearchParams] = useSearchParams()
  const tab: Tab = parseTab(searchParams.get('tab'))

  // When the user opens the meetings tab, pull a fresh 30-day window
  // so they see Atlas's latest state — not whatever was loaded at app
  // boot. Cheap fire-and-forget; the merge preserves any local edits.
  useEffect(() => {
    if (tab !== 'meetings') return
    void refreshMeetings()
  }, [tab, refreshMeetings])
  const setTab = (next: Tab) => {
    const sp = new URLSearchParams(searchParams)
    if (next === 'board') sp.delete('tab')
    else sp.set('tab', next)
    setSearchParams(sp, { replace: true })
  }

  const recordingDateSet = useMemo(
    () => buildRecordingDateSet(recordings),
    [recordings],
  )
  const [newMeetingOpen, setNewMeetingOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [confirm, setConfirm] = useState<Confirm>(null)

  const project = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId],
  )

  useDocumentTitle(project?.name ?? 'Project not found')

  const projectTasks = useMemo(
    () => (projectId ? tasks.filter((t) => t.projectId === projectId) : []),
    [tasks, projectId],
  )
  // Project's meetings — filter by attendance for Members so the
  // count and the meetings tab both reflect what they can actually
  // see. PM: no filter.
  const projectMeetings = useMemo(
    () =>
      projectId
        ? meetings.filter(
            (m) => m.projectId === projectId && (isPM || canSeeMeeting(m)),
          )
        : [],
    [meetings, projectId, isPM, canSeeMeeting],
  )
  const stats = useMemo(() => {
    let open = 0
    let overdue = 0
    let done = 0
    for (const t of projectTasks) {
      if (t.status === 'done') done += 1
      else {
        open += 1
        if (isOverdue(t.dueDate)) overdue += 1
      }
    }
    const total = open + done
    const pct = total === 0 ? 0 : Math.round((done / total) * 100)
    return { open, overdue, done, total, pct }
  }, [projectTasks])

  const memberNames = useMemo(
    () =>
      project
        ? project.memberIds
            .map((id) => teamMembers.find((m) => m.id === id)?.name)
            .filter((n): n is string => Boolean(n))
        : [],
    [project, teamMembers],
  )

  if (!projectId) return <Navigate to="/projects" replace />
  // RBAC gate: a Member landing on a project they have no tasks in.
  // We render an inline AccessDenied instead of redirecting so the URL
  // is preserved and sharing/bookmarking is transparent.
  if (project && !canSeeProject(project.id)) {
    return (
      <AccessDenied
        message="You don't have access to this project. Ask your PM if this is a mistake."
        backTo="/projects"
        backLabel="Back to Projects"
      />
    )
  }
  if (!project) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <h2 className="text-base font-medium text-[var(--text-secondary)]">
          Project not found
        </h2>
        <Link
          to="/projects"
          className="mt-5 inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-primary)] px-4 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)]"
        >
          Back to projects
        </Link>
      </div>
    )
  }

  const isAtlasManaged =
    dataSource === 'atlas' && snapshotIndex.projectsById.has(project.id)
  const isSheetsManaged = projectDataSources.some(
    (s) => s.projectId === project.id && s.source === 'google-sheets',
  )
  const canEditSettings = isPM && !isAtlasManaged

  const handleCreateMeeting = async (values: MeetingFormValues) => {
    await createMeeting({ ...values, projectId })
    setNewMeetingOpen(false)
    toast.success('Meeting created.')
  }

  const handleSaveSettings = async (values: ProjectFormValues) => {
    await updateProject(project.id, values)
    setSettingsOpen(false)
    toast.success('Project updated.')
  }

  const handleArchive = async () => {
    setConfirm(null)
    await updateProject(project.id, { archived: !project.archived })
    setSettingsOpen(false)
    toast.success(project.archived ? 'Project unarchived.' : 'Project archived.')
  }

  const handleDelete = async () => {
    setConfirm(null)
    await deleteProject(project.id)
    setSettingsOpen(false)
    toast.success('Project deleted.')
  }

  // Same viewport height claim as BoardPage — only the Board tab needs
  // it, but applying it unconditionally keeps the layout stable when
  // switching tabs.
  const containerClass = cn(
    'flex h-[calc(100vh-104px)] flex-col gap-4 md:h-[calc(100vh-120px)] md:gap-5',
  )

  return (
    <div className={containerClass}>
      <div className="shrink-0 space-y-4">
        <Breadcrumb
          items={[
            { label: 'Projects', path: '/projects' },
            { label: project.name },
          ]}
        />

        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: project.color }}
              />
              <h1 className="truncate text-2xl font-semibold text-[var(--text-primary)]">
                {project.name}
              </h1>
              {project.archived && (
                <span className="rounded-full bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.5px] text-[var(--text-secondary)]">
                  Archived
                </span>
              )}
            </div>
            {project.description && (
              <p className="mt-1 line-clamp-2 max-w-prose text-sm text-[var(--text-secondary)]">
                {project.description}
              </p>
            )}

            <ProjectStatsRow
              open={stats.open}
              overdue={stats.overdue}
              done={stats.done}
              pct={stats.pct}
            />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <AvatarStack names={memberNames} max={5} size="md" />
            {canEditSettings && (
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                aria-label={`${project.name} settings`}
                className="-m-1 inline-flex h-9 w-9 items-center justify-center rounded-md p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
                title="Project settings"
              >
                <Settings className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
            {tab === 'meetings' && isPM && (
              <button
                type="button"
                onClick={() => setNewMeetingOpen(true)}
                disabled={dataSource === 'atlas'}
                title={
                  dataSource === 'atlas'
                    ? 'Meetings are extracted from Atlas manifests'
                    : undefined
                }
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-3 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[var(--accent-primary)]"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                New Meeting
              </button>
            )}
          </div>
        </header>

        <div role="tablist" className="-mb-px flex gap-1 border-b border-[var(--border-subtle)]">
          <TabButton
            active={tab === 'board'}
            onClick={() => setTab('board')}
            icon={Columns3}
          >
            Board
          </TabButton>
          <TabButton
            active={tab === 'meetings'}
            onClick={() => setTab('meetings')}
            icon={FileText}
            count={projectMeetings.length}
          >
            Meetings
          </TabButton>
        </div>
      </div>

      {tab === 'board' ? (
        <BoardView forcedProjectId={projectId} />
      ) : (
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto">
          <MeetingsSection
            meetings={projectMeetings}
            members={teamMembers}
            projectId={projectId ?? ''}
            recordingDates={recordingDateSet}
          />
          <RecordingsSection />
        </div>
      )}

      <MeetingFormModal
        open={newMeetingOpen}
        members={teamMembers}
        projectName={project.name}
        onClose={() => setNewMeetingOpen(false)}
        onSubmit={handleCreateMeeting}
      />

      <ProjectFormModal
        open={settingsOpen}
        mode="edit"
        initial={project}
        members={teamMembers}
        onClose={() => setSettingsOpen(false)}
        onSubmit={handleSaveSettings}
        onArchive={
          isSheetsManaged ? undefined : () => setConfirm({ kind: 'archive' })
        }
        onUnarchive={
          project.archived
            ? () => void handleArchive()
            : undefined
        }
        onDelete={
          isSheetsManaged ? undefined : () => setConfirm({ kind: 'delete' })
        }
      />

      <ConfirmModal
        open={confirm?.kind === 'archive'}
        title={project.archived ? 'Unarchive project?' : 'Archive project?'}
        message={
          <>
            {project.archived ? 'Unarchive' : 'Archive'}{' '}
            <strong className="text-[var(--text-primary)]">{project.name}</strong>
            {project.archived
              ? '? It will return to the active list.'
              : '? It will be hidden from the main view.'}
          </>
        }
        confirmLabel={project.archived ? 'Unarchive' : 'Archive'}
        onConfirm={handleArchive}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmModal
        open={confirm?.kind === 'delete'}
        title="Delete project?"
        message={
          <>
            Delete <strong className="text-[var(--text-primary)]">{project.name}</strong>{' '}
            and all its tasks? This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}

function ProjectStatsRow({
  open,
  overdue,
  done,
  pct,
}: {
  open: number
  overdue: number
  done: number
  pct: number
}) {
  return (
    <div className="mt-3 flex max-w-md flex-wrap items-center gap-x-3 gap-y-2 text-xs tabular-nums text-[var(--text-secondary)]">
      <span>{open} open</span>
      {overdue > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <span className="text-[var(--priority-critical)]">{overdue} overdue</span>
        </>
      )}
      <span aria-hidden="true">·</span>
      <span>{done} done</span>
      <div
        className="ml-2 h-1.5 min-w-[80px] flex-1 overflow-hidden rounded-full bg-[var(--bg-elevated)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={`${pct}% complete`}
      >
        <div
          className="h-full bg-[var(--status-done)] transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

interface TabButtonProps {
  active: boolean
  onClick: () => void
  icon: typeof Columns3
  count?: number
  children: React.ReactNode
}

function TabButton({ active, onClick, icon: Icon, count, children }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        '-mb-px inline-flex items-center gap-1.5 rounded-t border-b-2 px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
        active
          ? 'border-[var(--accent-primary)] font-medium text-[var(--text-primary)]'
          : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {children}
      {count !== undefined && count > 0 && (
        <span className="text-xs text-[var(--text-muted)] tabular-nums">
          ({count})
        </span>
      )}
    </button>
  )
}

// ── Meetings section (list ↔ calendar toggle) ───────────────────────────────

type MeetingsViewMode = 'list' | 'calendar'

const MEETINGS_VIEW_KEY = 'team-manager.project-meetings-view'

function loadMeetingsView(): MeetingsViewMode {
  if (typeof window === 'undefined') return 'list'
  try {
    const raw = window.localStorage.getItem(MEETINGS_VIEW_KEY)
    return raw === 'calendar' ? 'calendar' : 'list'
  } catch {
    return 'list'
  }
}

function saveMeetingsView(view: MeetingsViewMode): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(MEETINGS_VIEW_KEY, view)
  } catch {
    // ignore
  }
}

function MeetingsSection({
  meetings,
  members,
  projectId,
  recordingDates,
}: {
  meetings: Meeting[]
  members: TeamMember[]
  projectId: string
  recordingDates: ReadonlySet<string>
}) {
  const navigate = useNavigate()
  const [view, setViewState] = useState<MeetingsViewMode>(() =>
    loadMeetingsView(),
  )
  const setView = (next: MeetingsViewMode) => {
    setViewState(next)
    saveMeetingsView(next)
  }

  const items = useMemo<CalendarItem[]>(
    () =>
      meetings.map((m) => {
        const attendees = m.attendeeIds
          .map((id) => members.find((mm) => mm.id === id)?.name)
          .filter((n): n is string => Boolean(n))
        return {
          id: m.id,
          title: m.title,
          date: m.date,
          type: 'meeting',
          assignee: attendees.length > 0 ? attendees.join(', ') : null,
          status: m.status,
        }
      }),
    [meetings, members],
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <div
          role="radiogroup"
          aria-label="Meetings view"
          className="inline-flex h-8 items-center gap-0.5 rounded-md bg-[var(--bg-elevated)] p-0.5"
        >
          <ViewToggleButton
            icon={List}
            label="List"
            active={view === 'list'}
            onClick={() => setView('list')}
          />
          <ViewToggleButton
            icon={CalendarDays}
            label="Calendar"
            active={view === 'calendar'}
            onClick={() => setView('calendar')}
          />
        </div>
      </div>

      {view === 'calendar' ? (
        <CalendarView
          items={items}
          headerCaption={`${meetings.length} meeting${meetings.length === 1 ? '' : 's'}`}
          onItemClick={(item) => navigate(`/projects/${projectId}/meetings/${item.id}`)}
        />
      ) : (
        <MeetingList
          meetings={meetings}
          members={members}
          hrefForMeeting={(m) => `/projects/${projectId}/meetings/${m.id}`}
          recordingDates={recordingDates}
        />
      )}
    </div>
  )
}

function ViewToggleButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof List
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={`${label} view`}
      title={`${label} view`}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
        active
          ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-sm'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}
