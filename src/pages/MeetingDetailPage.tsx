import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRightCircle,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Link2,
  MapPin,
  Plus,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Avatar } from '@/components/shared/Avatar'
import { Breadcrumb } from '@/components/Breadcrumb'
import { ConfirmModal } from '@/components/shared/ConfirmModal'
import { DueDatePicker } from '@/components/shared/DueDatePicker'
import { RecordingsSection } from '@/components/recordings/RecordingsSection'
import { AccessDenied } from '@/components/shared/AccessDenied'
import { useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import { usePermissions } from '@/hooks/usePermissions'
import { useTaskPanel } from '@/data/task-panel'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { formatAbsoluteDateTime, formatMeetingDate, relativeTime } from '@/lib/date-utils'
import { cn } from '@/lib/utils'
import {
  type ActionItem,
  type Decision,
  type Meeting,
  type MeetingLink,
  type MeetingQuestion,
  type MeetingStatus,
  type Project,
  type TeamMember,
} from '@/data/types'

const STATUS_LABEL: Record<MeetingStatus, string> = {
  scheduled: 'Scheduled',
  completed: 'Completed',
  cancelled: 'Cancelled',
}
const STATUS_COLOR_VAR: Record<MeetingStatus, string> = {
  scheduled: '--accent-primary',
  completed: '--status-done',
  cancelled: '--text-muted',
}

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

/** Reject deadline strings that aren't an actual date — Atlas sometimes
 *  emits the literal word "unknown" / "tbd" / "n/a" / "due" for
 *  unscheduled items. The bridge normalises these to null at ingest,
 *  but legacy meetings in localStorage may still carry them; treat
 *  them as empty here so the row shows the neutral "Due" placeholder
 *  instead of the raw sentinel. */
function displayDueDate(value: string | null): string | null {
  if (!value) return null
  const lc = value.trim().toLowerCase()
  if (
    !lc ||
    lc === 'unknown' ||
    lc === 'tbd' ||
    lc === 'n/a' ||
    lc === 'none' ||
    lc === 'null' ||
    lc === 'due'
  ) {
    return null
  }
  return value
}

export default function MeetingDetailPage() {
  const { projectId, meetingId } = useParams<{
    projectId: string
    meetingId: string
  }>()
  const navigate = useNavigate()
  const { openTask } = useTaskPanel()
  const { currentUser, isPM } = useAuth()
  const { canSeeMeeting } = usePermissions()
  const {
    meetings,
    projects,
    teamMembers,
    tasks,
    updateMeeting,
    deleteMeeting,
    convertActionItemToTask,
  } = useData()

  const meeting = useMemo(
    () => meetings.find((m) => m.id === meetingId),
    [meetings, meetingId],
  )
  const project = useMemo(
    () => projects.find((p) => p.id === meeting?.projectId),
    [projects, meeting?.projectId],
  )

  useDocumentTitle(meeting?.title ?? 'Meeting not found')

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [agendaOpen, setAgendaOpen] = useState(false)

  useEffect(() => {
    if (!meeting) return
    // Scheduled meetings default to "agenda expanded" because that's the
    // primary content before the meeting happens; completed meetings
    // collapse it so the focus is the notes.
    setAgendaOpen(meeting.status === 'scheduled')
  }, [meeting?.status, meeting?.id])

  if (!projectId || !meetingId) return <Navigate to="/projects" replace />
  // RBAC gate — attendance-based. A Member visiting a meeting URL
  // they didn't attend gets a targeted message; no content leaks
  // (notes / decisions / action items / transcript stay unmounted).
  if (meeting && !canSeeMeeting(meeting)) {
    return (
      <AccessDenied
        message="You weren't part of this meeting."
        backTo="/meetings"
        backLabel="Back to Meetings"
      />
    )
  }
  if (!meeting || !project) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <h2 className="text-base font-medium text-[var(--text-secondary)]">
          Meeting not found
        </h2>
        <Link
          to={`/projects/${projectId}`}
          className="mt-5 inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-primary)] px-4 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)]"
        >
          Back to project
        </Link>
      </div>
    )
  }

  const memberOnProject = currentUser
    ? project.memberIds.includes(currentUser.id)
    : false
  // PM edits everything. Project members can edit notes / action items /
  // decisions / links (the collaborative content). Title / status /
  // attendees / delete are PM-only.
  const canEditContent = isPM || memberOnProject
  const canEditChrome = isPM
  const cancelled = meeting.status === 'cancelled'

  const safeUpdate = async (label: string, patch: Parameters<typeof updateMeeting>[1]) => {
    try {
      await updateMeeting(meeting.id, patch)
    } catch {
      toast.error(`Could not save ${label}.`)
    }
  }

  const handleDelete = async () => {
    setConfirmDeleteOpen(false)
    try {
      await deleteMeeting(meeting.id)
      toast.success('Meeting deleted.')
      navigate(`/projects/${projectId}`)
    } catch {
      toast.error('Could not delete the meeting.')
    }
  }

  const handleConvert = async (item: ActionItem) => {
    try {
      const task = await convertActionItemToTask(meeting.id, item.id)
      toast.success('Converted to task.', {
        action: {
          label: 'Open',
          onClick: () => openTask(task.id),
        },
      })
    } catch {
      toast.error('Could not convert action item.')
    }
  }

  return (
    <div className="space-y-6">
      <Breadcrumb
        items={[
          { label: 'Projects', path: '/projects' },
          { label: project.name, path: `/projects/${project.id}` },
          { label: 'Meetings', path: `/projects/${project.id}?tab=meetings` },
          { label: meeting.title },
        ]}
      />

      <MeetingHeader
        meeting={meeting}
        project={project}
        members={teamMembers}
        canEditTitle={canEditChrome}
        canChangeStatus={canEditChrome}
        canChangeAttendees={canEditChrome}
        canDelete={canEditChrome}
        onUpdateTitle={(title) => void safeUpdate('title', { title })}
        onChangeStatus={(status) => void safeUpdate('status', { status })}
        onChangeAttendees={(attendeeIds) =>
          void safeUpdate('attendees', { attendeeIds })
        }
        onChangeLocation={(location) => void safeUpdate('location', { location })}
        onDelete={() => setConfirmDeleteOpen(true)}
      />

      <AgendaSection
        agenda={meeting.agenda}
        open={agendaOpen}
        setOpen={setAgendaOpen}
        canEdit={canEditContent && !cancelled}
        onChange={(agenda) => void safeUpdate('agenda', { agenda })}
      />

      <NotesSection
        meeting={meeting}
        members={teamMembers}
        canEdit={canEditContent && !cancelled}
        onChange={(notes) => void safeUpdate('notes', { notes })}
      />

      <DecisionsSection
        decisions={meeting.decisions}
        members={teamMembers}
        canEdit={canEditContent && !cancelled}
        onChange={(decisions) => void safeUpdate('decisions', { decisions })}
      />

      <QuestionsSection
        questions={meeting.questions}
        canEdit={canEditContent && !cancelled}
        onChange={(questions) => void safeUpdate('questions', { questions })}
      />

      <ActionItemsSection
        actionItems={meeting.actionItems}
        members={teamMembers}
        tasks={tasks}
        project={project ?? null}
        projectIdFallback={meeting.projectId}
        canEdit={canEditContent && !cancelled}
        canConvert={canEditContent && !cancelled}
        onChange={(actionItems) =>
          void safeUpdate('action items', { actionItems })
        }
        onConvert={handleConvert}
        onOpenTask={(taskId) => openTask(taskId)}
      />

      <LinksSection
        links={meeting.links}
        canEdit={canEditContent && !cancelled}
        onChange={(links) => void safeUpdate('links', { links })}
      />

      <section aria-labelledby="meeting-recordings-heading">
        <h2
          id="meeting-recordings-heading"
          className="text-lg font-semibold text-[var(--text-primary)]"
        >
          Recordings
        </h2>
        <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
          ZoomBot audio, video, and transcripts captured on {meeting.date}.
        </p>
        <div className="mt-3">
          <RecordingsSection filterDate={meeting.date} compact />
        </div>
      </section>

      <ConfirmModal
        open={confirmDeleteOpen}
        title="Delete meeting?"
        message={
          <>
            Delete{' '}
            <strong className="text-[var(--text-primary)]">
              &lsquo;{meeting.title}&rsquo;
            </strong>
            ? Tasks created from this meeting&apos;s action items stay alive,
            but their back-link will show &quot;Source meeting was deleted&quot;.
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  )
}

// ---- Header ----------------------------------------------------------------

function MeetingHeader({
  meeting,
  members,
  canEditTitle,
  canChangeStatus,
  canChangeAttendees,
  canDelete,
  onUpdateTitle,
  onChangeStatus,
  onChangeAttendees,
  onChangeLocation,
  onDelete,
}: {
  meeting: Meeting
  project: { name: string; color: string }
  members: TeamMember[]
  canEditTitle: boolean
  canChangeStatus: boolean
  canChangeAttendees: boolean
  canDelete: boolean
  onUpdateTitle: (next: string) => void
  onChangeStatus: (next: MeetingStatus) => void
  onChangeAttendees: (next: string[]) => void
  onChangeLocation: (next: string | null) => void
  onDelete: () => void
}) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(meeting.title)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editingTitle) setTitleDraft(meeting.title)
  }, [meeting.title, editingTitle])
  useEffect(() => {
    if (editingTitle) titleRef.current?.select()
  }, [editingTitle])

  const commitTitle = () => {
    const next = titleDraft.trim()
    if (next && next !== meeting.title) onUpdateTitle(next)
    setEditingTitle(false)
  }

  const [editingLocation, setEditingLocation] = useState(false)
  const [locationDraft, setLocationDraft] = useState(meeting.location ?? '')
  useEffect(() => {
    if (!editingLocation) setLocationDraft(meeting.location ?? '')
  }, [meeting.location, editingLocation])

  const commitLocation = () => {
    const trimmed = locationDraft.trim()
    onChangeLocation(trimmed === '' ? null : trimmed)
    setEditingLocation(false)
  }

  const attendees = meeting.attendeeIds
    .map((id) => members.find((m) => m.id === id))
    .filter((m): m is TeamMember => Boolean(m))
  const cancelled = meeting.status === 'cancelled'

  const isUrlLike = meeting.location?.startsWith('http')

  return (
    <header className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        {editingTitle ? (
          <input
            ref={titleRef}
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitTitle()
              } else if (e.key === 'Escape') {
                setTitleDraft(meeting.title)
                setEditingTitle(false)
              }
            }}
            maxLength={200}
            className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-1 text-2xl font-semibold text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-focus)]"
          />
        ) : (
          <h1
            className={cn(
              'min-w-0 break-words text-2xl font-semibold text-[var(--text-primary)]',
              canEditTitle &&
                'cursor-text rounded px-1 -mx-1 hover:bg-[var(--bg-elevated)]',
              cancelled && 'line-through opacity-70',
            )}
            onClick={() => canEditTitle && setEditingTitle(true)}
            role={canEditTitle ? 'button' : undefined}
            tabIndex={canEditTitle ? 0 : -1}
            onKeyDown={(e) => {
              if (canEditTitle && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                setEditingTitle(true)
              }
            }}
          >
            {meeting.title}
          </h1>
        )}

        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            aria-label="Delete meeting"
            className="shrink-0 rounded-md p-2 text-[var(--text-secondary)] transition-colors hover:bg-[color-mix(in_srgb,var(--destructive)_15%,transparent)] hover:text-[var(--destructive)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <dl className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
        <div className="flex flex-col gap-1">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
            When
          </dt>
          <dd className="flex items-center gap-1.5 text-[var(--text-primary)]">
            <Calendar
              className="h-3.5 w-3.5 text-[var(--text-secondary)]"
              aria-hidden="true"
            />
            {formatMeetingDate(meeting.date)}
            {meeting.startTime && (
              <span className="text-[var(--text-secondary)]">· {meeting.startTime}</span>
            )}
            {meeting.duration !== null && (
              <span className="text-[var(--text-secondary)]">· {meeting.duration} min</span>
            )}
          </dd>
        </div>

        <div className="flex flex-col gap-1">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
            Status
          </dt>
          <dd>
            <select
              value={meeting.status}
              disabled={!canChangeStatus}
              onChange={(e) => onChangeStatus(e.target.value as MeetingStatus)}
              aria-label="Status"
              className="h-7 rounded border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-60"
              style={{
                borderLeftColor: `var(${STATUS_COLOR_VAR[meeting.status]})`,
                borderLeftWidth: '3px',
              }}
            >
              <option value="scheduled">{STATUS_LABEL.scheduled}</option>
              <option value="completed">{STATUS_LABEL.completed}</option>
              <option value="cancelled">{STATUS_LABEL.cancelled}</option>
            </select>
          </dd>
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
            Where
          </dt>
          <dd className="flex items-center gap-1.5">
            <MapPin
              className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]"
              aria-hidden="true"
            />
            {editingLocation ? (
              <input
                autoFocus
                type="text"
                value={locationDraft}
                onChange={(e) => setLocationDraft(e.target.value)}
                onBlur={commitLocation}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitLocation()
                  } else if (e.key === 'Escape') {
                    setLocationDraft(meeting.location ?? '')
                    setEditingLocation(false)
                  }
                }}
                placeholder="Google Meet · Discord channel · In-person"
                className="h-7 min-w-[200px] rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
              />
            ) : isUrlLike ? (
              <a
                href={meeting.location ?? '#'}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-xs text-[var(--accent-primary)] underline-offset-2 hover:underline"
              >
                {meeting.location}
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            ) : (
              <button
                type="button"
                onClick={() => canChangeAttendees && setEditingLocation(true)}
                disabled={!canChangeAttendees}
                className={cn(
                  'rounded text-xs text-[var(--text-primary)] disabled:cursor-not-allowed',
                  canChangeAttendees && 'hover:text-[var(--accent-primary)]',
                )}
              >
                {meeting.location ?? <span className="italic text-[var(--text-muted)]">Add location</span>}
              </button>
            )}
          </dd>
        </div>
      </dl>

      <AttendeesRow
        attendees={attendees}
        members={members}
        canEdit={canChangeAttendees}
        onChange={onChangeAttendees}
      />
    </header>
  )
}

function AttendeesRow({
  attendees,
  members,
  canEdit,
  onChange,
}: {
  attendees: TeamMember[]
  members: TeamMember[]
  canEdit: boolean
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const toggle = (id: string) => {
    const ids = attendees.map((a) => a.id)
    onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]">
        Attendees
      </p>
      <div ref={ref} className="relative flex flex-wrap items-center gap-1.5">
        {attendees.length === 0 && (
          <p className="text-xs text-[var(--text-muted)]">
            No attendees recorded.{canEdit ? ' Add team members who were present.' : ''}
          </p>
        )}
        {attendees.map((m) => (
          <span
            key={m.id}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] py-0.5 pl-0.5 pr-2 text-xs text-[var(--text-primary)]"
          >
            <Avatar name={m.name} size="xs" />
            <span className="truncate">{m.name}</span>
          </span>
        ))}
        {canEdit && (
          <>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-[var(--border-default)] px-2 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
              aria-haspopup="listbox"
              aria-expanded={open}
            >
              <UserPlus className="h-3 w-3" aria-hidden="true" />
              Add attendee
            </button>
            {open && (
              <ul
                role="listbox"
                className="absolute left-0 top-full z-20 mt-1 max-h-56 w-56 overflow-y-auto rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] py-1 shadow-[0_4px_16px_rgba(0,0,0,0.3)]"
              >
                {members.map((m) => {
                  const selected = attendees.some((a) => a.id === m.id)
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => toggle(m.id)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)]"
                      >
                        <Avatar name={m.name} size="xs" />
                        <span className="truncate">{m.name}</span>
                        {selected && (
                          <Check className="ml-auto h-3.5 w-3.5 text-[var(--accent-primary)]" />
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ---- Agenda ----------------------------------------------------------------

function AgendaSection({
  agenda,
  open,
  setOpen,
  canEdit,
  onChange,
}: {
  agenda: string | null
  open: boolean
  setOpen: (o: boolean) => void
  canEdit: boolean
  onChange: (next: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(agenda ?? '')
  useEffect(() => {
    if (!editing) setDraft(agenda ?? '')
  }, [agenda, editing])
  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed !== (agenda ?? '')) {
      onChange(trimmed === '' ? null : trimmed)
    }
    setEditing(false)
  }
  return (
    <section aria-labelledby="agenda-heading">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded text-left text-lg font-semibold text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        aria-expanded={open}
        aria-controls="agenda-body"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-[var(--text-secondary)]" />
        ) : (
          <ChevronRight className="h-4 w-4 text-[var(--text-secondary)]" />
        )}
        <span id="agenda-heading">Agenda</span>
      </button>
      {open && (
        <div id="agenda-body" className="mt-2">
          {editing ? (
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setDraft(agenda ?? '')
                  setEditing(false)
                }
              }}
              rows={4}
              className="w-full resize-y rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] p-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-focus)]"
            />
          ) : agenda ? (
            <p
              className={cn(
                'whitespace-pre-wrap rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 text-sm text-[var(--text-primary)]',
                canEdit && 'cursor-text hover:border-[var(--border-default)]',
              )}
              onClick={() => canEdit && setEditing(true)}
            >
              {agenda}
            </p>
          ) : (
            <p
              className={cn(
                'rounded-md border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-3 text-sm italic text-[var(--text-muted)]',
                canEdit && 'cursor-text hover:border-[var(--border-default)]',
              )}
              onClick={() => canEdit && setEditing(true)}
            >
              {canEdit ? 'Add the agenda…' : 'No agenda recorded.'}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// ---- Notes -----------------------------------------------------------------

function NotesSection({
  meeting,
  members,
  canEdit,
  onChange,
}: {
  meeting: Meeting
  members: TeamMember[]
  canEdit: boolean
  onChange: (next: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(meeting.notes)
  useEffect(() => {
    if (!editing) setDraft(meeting.notes)
  }, [meeting.notes, editing])

  const commit = () => {
    if (draft !== meeting.notes) onChange(draft)
    setEditing(false)
  }

  const lastEditor =
    meeting.lastEditedBy
      ? members.find((m) => m.id === meeting.lastEditedBy)
      : null

  const empty = !meeting.notes.trim()
  const scheduled = meeting.status === 'scheduled'

  return (
    <section aria-labelledby="notes-heading" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="notes-heading"
          className="text-lg font-semibold text-[var(--text-primary)]"
        >
          Discussion notes
        </h2>
        {lastEditor && meeting.lastEditedAt && (
          <p
            className="text-xs text-[var(--text-muted)]"
            title={formatAbsoluteDateTime(meeting.lastEditedAt)}
          >
            Last edited by{' '}
            <span className="text-[var(--text-secondary)]">{lastEditor.name}</span>
            {' · '}
            {relativeTime(meeting.lastEditedAt)}
          </p>
        )}
      </div>

      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setDraft(meeting.notes)
              setEditing(false)
            }
          }}
          rows={Math.max(8, draft.split('\n').length + 1)}
          placeholder="What was discussed? Capture context, nuance, reasoning…"
          className="w-full resize-y rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] p-4 text-[15px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-focus)]"
        />
      ) : empty ? (
        <p
          className={cn(
            'rounded-md border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-4 text-sm italic text-[var(--text-muted)]',
            canEdit && 'cursor-text hover:border-[var(--border-default)]',
          )}
          onClick={() => canEdit && setEditing(true)}
        >
          {scheduled
            ? "Meeting hasn't happened yet. Notes will be captured here."
            : canEdit
              ? 'Capture what was discussed…'
              : 'No notes recorded.'}
        </p>
      ) : (
        <p
          className={cn(
            'whitespace-pre-wrap break-words rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 text-[15px] leading-relaxed text-[var(--text-primary)]',
            canEdit && 'cursor-text hover:border-[var(--border-default)]',
          )}
          onClick={() => canEdit && setEditing(true)}
        >
          {meeting.notes}
        </p>
      )}
    </section>
  )
}

// ---- Decisions -------------------------------------------------------------

function DecisionsSection({
  decisions,
  members,
  canEdit,
  onChange,
}: {
  decisions: Decision[]
  members: TeamMember[]
  canEdit: boolean
  onChange: (next: Decision[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const handleAdd = () => {
    const text = draft.trim()
    if (!text) return
    onChange([...decisions, { id: newId('dec'), text, decidedBy: null }])
    setDraft('')
    setAdding(false)
  }

  const handleRemove = (id: string) => {
    onChange(decisions.filter((d) => d.id !== id))
  }

  const handleDecidedBy = (id: string, decidedBy: string | null) => {
    onChange(decisions.map((d) => (d.id === id ? { ...d, decidedBy } : d)))
  }

  return (
    <section aria-labelledby="decisions-heading" className="space-y-2">
      <h2
        id="decisions-heading"
        className="text-lg font-semibold text-[var(--text-primary)]"
      >
        Decisions
      </h2>
      {decisions.length === 0 && !adding ? (
        <p className="rounded-md border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-3 text-sm italic text-[var(--text-muted)]">
          No decisions recorded.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {decisions.map((d) => {
            const decider = d.decidedBy
              ? members.find((m) => m.id === d.decidedBy)
              : null
            return (
              <li
                key={d.id}
                className="group/decision flex items-start gap-3 rounded-md border border-[var(--border-subtle)] border-l-[3px] border-l-[var(--status-done)] bg-[var(--bg-surface)] p-3"
              >
                <div className="min-w-0 flex-1">
                  {d.text ? (
                    <p className="whitespace-pre-wrap break-words text-sm leading-snug text-[var(--text-primary)]">
                      {d.text}
                    </p>
                  ) : (
                    <p className="text-sm italic text-[var(--text-muted)]">
                      (no decision text)
                    </p>
                  )}
                  {d.rationale && (
                    <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-snug text-[var(--text-secondary)]">
                      <span className="font-medium">Rationale:</span> {d.rationale}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                    Decided by{' '}
                    <select
                      value={d.decidedBy ?? ''}
                      disabled={!canEdit}
                      onChange={(e) =>
                        handleDecidedBy(d.id, e.target.value === '' ? null : e.target.value)
                      }
                      className="h-6 rounded border border-[var(--border-subtle)] bg-[var(--bg-input)] px-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <option value="">(group)</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                    {decider && <Avatar name={decider.name} size="xs" />}
                  </div>
                </div>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => handleRemove(d.id)}
                    aria-label="Remove decision"
                    className="rounded p-1 text-[var(--text-muted)] opacity-0 transition-all hover:bg-[color-mix(in_srgb,var(--destructive)_15%,transparent)] hover:text-[var(--destructive)] group-hover/decision:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {canEdit && (
        adding ? (
          <div className="flex flex-col gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] p-3">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              placeholder="What was decided?"
              className="w-full resize-y rounded border border-[var(--border-subtle)] bg-[var(--bg-input)] p-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-focus)]"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraft('')
                  setAdding(false)
                }}
                className="inline-flex h-7 items-center rounded px-2 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAdd}
                disabled={!draft.trim()}
                className="inline-flex h-7 items-center rounded bg-[var(--accent-primary)] px-2.5 text-xs font-medium text-[var(--text-inverse)] hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add decision
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded text-xs font-medium text-[var(--accent-primary)] hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add decision
          </button>
        )
      )}
    </section>
  )
}

// ---- Questions & Blockers --------------------------------------------------

const QUESTION_KIND_LABEL: Record<MeetingQuestion['kind'], string> = {
  question: 'Question',
  blocker: 'Blocker',
  conflict: 'Conflict',
}

function QuestionsSection({
  questions,
  canEdit,
  onChange,
}: {
  questions: MeetingQuestion[]
  canEdit: boolean
  onChange: (next: MeetingQuestion[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  // Hide the entire section when there's nothing AND the user can't
  // add anything — keeps the page clean for read-only viewers. Even
  // for editors, when there's nothing extracted we collapse the
  // section to just the "+ Add" affordance below; the dashed empty
  // card was noise on every meeting that didn't surface a blocker.
  if (questions.length === 0 && !canEdit) return null

  const handleAdd = () => {
    const text = draft.trim()
    if (!text) return
    onChange([
      ...questions,
      { id: newId('q'), text, kind: 'question' },
    ])
    setDraft('')
    setAdding(false)
  }

  const handleRemove = (id: string) => {
    onChange(questions.filter((q) => q.id !== id))
  }

  return (
    <section aria-labelledby="questions-heading" className="space-y-2">
      {/* Hide the heading too when the section is empty and we're
          not in the middle of adding — keeps the page clean while
          still letting editors add via the "+ Add" button below. */}
      {(questions.length > 0 || adding) && (
        <h2
          id="questions-heading"
          className="text-lg font-semibold text-[var(--text-primary)]"
        >
          Questions &amp; Blockers
        </h2>
      )}

      {questions.length > 0 && (
        <ul className="flex flex-col gap-2">
          {questions.map((q) => (
            <li
              key={q.id}
              className="group/q flex items-start gap-3 rounded-md border border-[var(--border-subtle)] border-l-[3px] border-l-[var(--priority-high)] bg-[var(--bg-surface)] p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap break-words text-sm leading-snug text-[var(--text-primary)]">
                  {q.text}
                </p>
                <p className="mt-1.5 text-[11px] uppercase tracking-[0.5px] text-[var(--text-muted)]">
                  {QUESTION_KIND_LABEL[q.kind]}
                </p>
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => handleRemove(q.id)}
                  aria-label="Remove item"
                  className="rounded p-1 text-[var(--text-muted)] opacity-0 transition-all hover:bg-[color-mix(in_srgb,var(--destructive)_15%,transparent)] hover:text-[var(--destructive)] group-hover/q:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        adding ? (
          <div className="flex flex-col gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] p-3">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              placeholder="What's open?"
              className="w-full resize-y rounded border border-[var(--border-subtle)] bg-[var(--bg-input)] p-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-focus)]"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraft('')
                  setAdding(false)
                }}
                className="inline-flex h-7 items-center rounded px-2 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAdd}
                disabled={!draft.trim()}
                className="inline-flex h-7 items-center rounded bg-[var(--accent-primary)] px-2.5 text-xs font-medium text-[var(--text-inverse)] hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded text-xs font-medium text-[var(--accent-primary)] hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add question or blocker
          </button>
        )
      )}
    </section>
  )
}

// ---- Action items ----------------------------------------------------------

function ActionItemsSection({
  actionItems,
  members,
  tasks,
  project,
  projectIdFallback,
  canEdit,
  canConvert,
  onChange,
  onConvert,
  onOpenTask,
}: {
  actionItems: ActionItem[]
  members: TeamMember[]
  tasks: Array<{ id: string }>
  /** The meeting's project, resolved by the parent page. `null` only
   *  in the edge case where the projectId doesn't match any project in
   *  the store (e.g. stale localStorage or a deleted project). */
  project: Project | null
  /** Raw projectId from the meeting, used to label the action item
   *  row when `project` couldn't be resolved. */
  projectIdFallback: string
  canEdit: boolean
  canConvert: boolean
  onChange: (next: ActionItem[]) => void
  onConvert: (item: ActionItem) => void
  onOpenTask: (taskId: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const taskIds = useMemo(() => new Set(tasks.map((t) => t.id)), [tasks])

  const patch = (id: string, updates: Partial<ActionItem>) => {
    onChange(actionItems.map((a) => (a.id === id ? { ...a, ...updates } : a)))
  }

  const handleAdd = () => {
    const text = draft.trim()
    if (!text) return
    onChange([
      ...actionItems,
      {
        id: newId('ai'),
        text,
        assigneeId: null,
        dueDate: null,
        done: false,
        linkedTaskId: null,
      },
    ])
    setDraft('')
    setAdding(false)
  }

  const handleRemove = (id: string) => {
    onChange(actionItems.filter((a) => a.id !== id))
  }

  return (
    <section aria-labelledby="action-items-heading" className="space-y-2">
      <h2
        id="action-items-heading"
        className="text-lg font-semibold text-[var(--text-primary)]"
      >
        Action items
      </h2>
      {actionItems.length === 0 && !adding ? (
        <p className="rounded-md border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-3 text-sm italic text-[var(--text-muted)]">
          No action items from this meeting.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {actionItems.map((a) => (
            <ActionItemRow
              key={a.id}
              item={a}
              members={members}
              project={project}
              projectIdFallback={projectIdFallback}
              canEdit={canEdit}
              canConvert={canConvert && a.linkedTaskId === null}
              taskExists={a.linkedTaskId ? taskIds.has(a.linkedTaskId) : false}
              onToggle={() => patch(a.id, { done: !a.done })}
              onChangeText={(text) => patch(a.id, { text })}
              onChangeAssignee={(assigneeId) => patch(a.id, { assigneeId })}
              onChangeDueDate={(dueDate) => patch(a.id, { dueDate })}
              onConvert={() => onConvert(a)}
              onRemove={() => handleRemove(a.id)}
              onOpenTask={onOpenTask}
            />
          ))}
        </ul>
      )}

      {canEdit && (
        adding ? (
          <div className="flex items-center gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] p-2">
            <input
              autoFocus
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAdd()
                } else if (e.key === 'Escape') {
                  setDraft('')
                  setAdding(false)
                }
              }}
              placeholder="What needs to be done?"
              className="h-8 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-focus)]"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!draft.trim()}
              className="inline-flex h-8 shrink-0 items-center rounded bg-[var(--accent-primary)] px-2.5 text-xs font-medium text-[var(--text-inverse)] hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft('')
                setAdding(false)
              }}
              aria-label="Cancel"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded text-xs font-medium text-[var(--accent-primary)] hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add action item
          </button>
        )
      )}
    </section>
  )
}

function ActionItemRow({
  item,
  members,
  project,
  projectIdFallback,
  canEdit,
  canConvert,
  taskExists,
  onToggle,
  onChangeText,
  onChangeAssignee,
  onChangeDueDate,
  onConvert,
  onRemove,
  onOpenTask,
}: {
  item: ActionItem
  members: TeamMember[]
  project: Project | null
  projectIdFallback: string
  canEdit: boolean
  canConvert: boolean
  taskExists: boolean
  onToggle: () => void
  onChangeText: (text: string) => void
  onChangeAssignee: (id: string | null) => void
  onChangeDueDate: (date: string | null) => void
  onConvert: () => void
  onRemove: () => void
  onOpenTask: (taskId: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text)
  useEffect(() => {
    if (!editing) setDraft(item.text)
  }, [item.text, editing])
  const commit = () => {
    const next = draft.trim()
    if (next && next !== item.text) onChangeText(next)
    setEditing(false)
  }
  const [dateOpen, setDateOpen] = useState(false)
  const dateRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!dateOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!dateRef.current?.contains(e.target as Node)) setDateOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [dateOpen])

  // Log once per render-of-a-bad-row when the meeting's projectId
  // doesn't resolve. Either the project was deleted out from under
  // the meeting or the bridge stashed an orphan id we don't have a
  // matching entry for.
  useEffect(() => {
    if (project) return
    // eslint-disable-next-line no-console
    console.warn(
      `Could not resolve project name for action item ${item.id} (projectId="${projectIdFallback}")`,
    )
  }, [project, item.id, projectIdFallback])

  return (
    <li
      className={cn(
        'group/ai grid items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-2',
        // Mobile: checkbox + text only (project/assignee/date stack
        // under the text or hide). Desktop: fixed-width columns so a
        // long action item text wraps in its own cell instead of
        // pushing the project/assignee/date columns around.
        'grid-cols-[20px_1fr] md:grid-cols-[20px_1fr_140px_120px_110px]',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={!canEdit}
        aria-pressed={item.done}
        aria-label={item.done ? 'Mark not done' : 'Mark done'}
        className={cn(
          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
          item.done
            ? 'border-[var(--status-done)] bg-[var(--status-done)] text-[var(--text-inverse)]'
            : 'border-[var(--border-default)] bg-transparent hover:border-[var(--status-done)]',
          !canEdit && 'cursor-not-allowed opacity-60',
        )}
      >
        {item.done && <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />}
      </button>

      <div className="min-w-0">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                setDraft(item.text)
                setEditing(false)
              }
            }}
            className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1.5 py-0.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
          />
        ) : (
          <div
            role={canEdit ? 'button' : undefined}
            tabIndex={canEdit ? 0 : -1}
            onClick={() => canEdit && setEditing(true)}
            onKeyDown={(e) => {
              if (canEdit && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                setEditing(true)
              }
            }}
            className={cn(
              'flex items-start gap-1.5 break-words text-sm',
              item.done
                ? 'text-[var(--text-muted)] line-through'
                : 'text-[var(--text-primary)]',
              canEdit && !editing && 'cursor-text rounded px-1 -mx-1 hover:bg-[var(--bg-elevated)]',
            )}
          >
            <span className="min-w-0 break-words">{item.text}</span>
            {item.linkedTaskId && taskExists && (
              <Link2
                className="mt-0.5 h-3 w-3 shrink-0 text-[var(--accent-primary)]"
                aria-label="Linked to task"
              />
            )}
          </div>
        )}
      </div>

      {project ? (
        <Link
          to={`/projects/${project.id}`}
          onClick={(e) => e.stopPropagation()}
          className="hidden w-[120px] shrink-0 items-center gap-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--accent-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] focus-visible:rounded md:inline-flex"
          title={project.name}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: project.color }}
          />
          <span className="truncate">{project.name}</span>
        </Link>
      ) : (
        // Unresolved project — render the orphan id as plain text; no
        // route to link to.
        <span
          className="hidden w-[120px] shrink-0 items-center gap-1.5 text-xs text-[var(--text-secondary)] md:inline-flex"
          title={`Unresolved project (${projectIdFallback})`}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: 'var(--text-muted)' }}
          />
          <span className="truncate">{projectIdFallback}</span>
        </span>
      )}

      <select
        value={item.assigneeId ?? ''}
        disabled={!canEdit}
        onChange={(e) =>
          onChangeAssignee(e.target.value === '' ? null : e.target.value)
        }
        aria-label="Assignee"
        className="h-7 max-w-[120px] shrink-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-input)] px-1.5 text-xs text-[var(--text-secondary)] outline-none focus:border-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value="">—</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>

      <div ref={dateRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => canEdit && setDateOpen((o) => !o)}
          disabled={!canEdit}
          className="inline-flex h-7 items-center gap-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-input)] px-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Calendar className="h-3 w-3" aria-hidden="true" />
          {displayDueDate(item.dueDate) ?? 'Due'}
        </button>
        {dateOpen && (
          <div className="absolute right-0 top-full z-20 mt-1 w-60 rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[0_4px_16px_rgba(0,0,0,0.3)]">
            <DueDatePicker
              value={item.dueDate}
              onChange={onChangeDueDate}
              onClose={() => setDateOpen(false)}
            />
          </div>
        )}
      </div>

      {item.linkedTaskId && taskExists ? (
        <button
          type="button"
          onClick={() => onOpenTask(item.linkedTaskId!)}
          aria-label="Open linked task"
          title="Open linked task"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2 text-xs font-medium text-[var(--accent-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        >
          View task
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </button>
      ) : (
        canConvert && (
          <button
            type="button"
            onClick={onConvert}
            aria-label="Convert to task"
            title="Convert to task"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] opacity-0 transition-all hover:bg-[var(--bg-elevated)] hover:text-[var(--accent-primary)] group-hover/ai:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            <ArrowRightCircle className="h-3.5 w-3.5" />
          </button>
        )
      )}

      {item.linkedTaskId && !taskExists && (
        <span
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded px-1 text-xs text-[var(--text-muted)]"
          title="The linked task was deleted"
        >
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          Task deleted
        </span>
      )}

      {canEdit && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove action item"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--text-muted)] opacity-0 transition-all hover:bg-[color-mix(in_srgb,var(--destructive)_15%,transparent)] hover:text-[var(--destructive)] group-hover/ai:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  )
}

// ---- Links -----------------------------------------------------------------

function LinksSection({
  links,
  canEdit,
  onChange,
}: {
  links: MeetingLink[]
  canEdit: boolean
  onChange: (next: MeetingLink[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')
  const [urlDraft, setUrlDraft] = useState('')

  const handleAdd = () => {
    const label = labelDraft.trim()
    const url = urlDraft.trim()
    if (!label || !url) return
    onChange([...links, { id: newId('lnk'), label, url }])
    setLabelDraft('')
    setUrlDraft('')
    setAdding(false)
  }

  const handleRemove = (id: string) => {
    onChange(links.filter((l) => l.id !== id))
  }

  return (
    <section aria-labelledby="links-heading" className="space-y-2">
      <h2
        id="links-heading"
        className="text-lg font-semibold text-[var(--text-primary)]"
      >
        Links
      </h2>
      {links.length === 0 && !adding ? (
        <p className="rounded-md border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-3 text-sm italic text-[var(--text-muted)]">
          No reference links.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {links.map((l) => (
            <li
              key={l.id}
              className="group/lnk flex items-center gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2"
            >
              <a
                href={l.url}
                target="_blank"
                rel="noreferrer noopener"
                className="min-w-0 flex-1 text-sm text-[var(--accent-primary)] underline-offset-2 hover:underline"
              >
                <span className="font-medium">{l.label}</span>
                <span className="ml-2 truncate text-xs text-[var(--text-muted)]">
                  {l.url}
                </span>
              </a>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => handleRemove(l.id)}
                  aria-label="Remove link"
                  className="rounded p-1 text-[var(--text-muted)] opacity-0 transition-all hover:bg-[color-mix(in_srgb,var(--destructive)_15%,transparent)] hover:text-[var(--destructive)] group-hover/lnk:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        adding ? (
          <div className="flex flex-col gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] p-3 sm:flex-row">
            <input
              autoFocus
              type="text"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              placeholder="Label"
              className="h-8 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] sm:w-1/3"
            />
            <input
              type="url"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://…"
              className="h-8 w-full flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
            />
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={handleAdd}
                disabled={!labelDraft.trim() || !urlDraft.trim()}
                className="inline-flex h-8 items-center rounded bg-[var(--accent-primary)] px-2.5 text-xs font-medium text-[var(--text-inverse)] hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  setLabelDraft('')
                  setUrlDraft('')
                  setAdding(false)
                }}
                aria-label="Cancel"
                className="inline-flex h-8 w-8 items-center justify-center rounded text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded text-xs font-medium text-[var(--accent-primary)] hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add link
          </button>
        )
      )}
    </section>
  )
}
