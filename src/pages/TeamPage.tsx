import { useMemo, useState } from 'react'
import { Download, Search, UserPlus, Users } from 'lucide-react'
import { toast } from 'sonner'
import {
  buildTeamReportCSV,
  downloadCSV,
  filenameDateStamp,
} from '@/lib/csv-export'
import { Fragment } from 'react'
import { ConfirmModal } from '@/components/shared/ConfirmModal'
import { InviteMemberModal } from '@/components/team/InviteMemberModal'
import { TeamMemberCard } from '@/components/team/TeamMemberCard'
import { TeamMemberExpanded } from '@/components/team/TeamMemberExpanded'
import { useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import { usePermissions } from '@/hooks/usePermissions'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useScrollRestore } from '@/hooks/useScrollRestore'
import { isOverdue } from '@/lib/date-utils'
import { cn } from '@/lib/utils'
import type { Role, Task, TeamMember } from '@/data/types'

const ACTIVE_STATUSES = ['todo', 'in_progress', 'in_review'] as const

type MemberFilterChip = 'all' | 'has-tasks' | 'overdue'

const FILTER_CHIPS: Array<{ value: MemberFilterChip; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'has-tasks', label: 'Has tasks' },
  { value: 'overdue', label: 'Overdue' },
]

export default function TeamPage() {
  useDocumentTitle('Team')
  useScrollRestore()
  const { currentUser, isPM } = useAuth()
  const { canSeeProject } = usePermissions()
  const {
    teamMembers,
    tasks,
    projects,
    inviteTeamMember,
    removeTeamMember,
    dataSource,
  } = useData()

  // Map for the per-task project chip rendered inside team task cards.
  const projectsById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  )

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<TeamMember | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [chipFilter, setChipFilter] = useState<MemberFilterChip>('all')

  const tasksByMember = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const t of tasks) {
      if (!t.assigneeId) continue
      const list = map.get(t.assigneeId) ?? []
      list.push(t)
      map.set(t.assigneeId, list)
    }
    return map
  }, [tasks])

  const sortedMembers = useMemo(() => {
    return [...teamMembers].sort((a, b) => {
      // PMs first, then alphabetical.
      if (a.role !== b.role) return a.role === 'pm' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [teamMembers])

  // Workspace-wide aggregates for the stat row. Restricted to assigned
  // tasks — unassigned work isn't surfaced on the Team page, so it
  // shouldn't pad the totals. Overdue excludes done tasks; finished
  // work that happens to have a past due date isn't an open problem.
  const aggregate = useMemo(() => {
    let activeTotal = 0
    let overdueTotal = 0
    for (const t of tasks) {
      if (!t.assigneeId) continue
      if (
        ACTIVE_STATUSES.includes(t.status as (typeof ACTIVE_STATUSES)[number])
      ) {
        activeTotal += 1
      }
      if (t.status !== 'done' && isOverdue(t.dueDate)) overdueTotal += 1
    }
    return { activeTotal, overdueTotal }
  }, [tasks])

  // Members who currently own at least one overdue (and not-done)
  // task. Cached as a Set so the "Overdue" filter chip can match in O(1).
  const membersWithOverdue = useMemo(() => {
    const set = new Set<string>()
    for (const t of tasks) {
      if (!t.assigneeId) continue
      if (t.status !== 'done' && isOverdue(t.dueDate)) set.add(t.assigneeId)
    }
    return set
  }, [tasks])

  const visibleMembers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return sortedMembers.filter((m) => {
      if (q && !m.name.toLowerCase().includes(q)) return false
      if (chipFilter === 'has-tasks') {
        if ((tasksByMember.get(m.id) ?? []).length === 0) return false
      }
      if (chipFilter === 'overdue' && !membersWithOverdue.has(m.id)) {
        return false
      }
      return true
    })
  }, [sortedMembers, tasksByMember, membersWithOverdue, searchQuery, chipFilter])

  const filterIsActive = searchQuery.trim().length > 0 || chipFilter !== 'all'

  const handleInvite = async (input: { name: string; email: string; role: Role }) => {
    await inviteTeamMember(input)
    setInviteOpen(false)
    toast.success(`Invite sent to ${input.email}.`)
  }

  const activeCountFor = (id: string) =>
    (tasksByMember.get(id) ?? []).filter((t) =>
      ACTIVE_STATUSES.includes(t.status as (typeof ACTIVE_STATUSES)[number]),
    ).length

  const handleRemoveConfirm = async () => {
    if (!confirmRemove) return
    const name = confirmRemove.name
    await removeTeamMember(confirmRemove.id)
    setConfirmRemove(null)
    setExpandedId(null)
    toast.success(`${name} removed.`)
  }

  if (!currentUser) return null

  const showSoloHint = isPM && teamMembers.length === 1

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3 pt-6 pb-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-[var(--text-primary)]">
              Team
            </h1>
            {dataSource === 'atlas' && (
              <span
                className="inline-flex items-center rounded-full bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-muted)]"
                title="Team roster managed in Atlas"
              >
                Atlas roster
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-6 text-sm text-[var(--text-muted)] tabular-nums">
            <span>
              <span className="font-semibold text-[var(--text-primary)]">
                {teamMembers.length}
              </span>{' '}
              {teamMembers.length === 1 ? 'member' : 'members'}
            </span>
            <span>
              <span className="font-semibold text-[var(--text-primary)]">
                {aggregate.activeTotal}
              </span>{' '}
              total active {aggregate.activeTotal === 1 ? 'task' : 'tasks'}
            </span>
            <span
              className={cn(
                aggregate.overdueTotal > 0 && 'text-[var(--destructive)]',
              )}
            >
              <span
                className={cn(
                  'font-semibold',
                  aggregate.overdueTotal > 0
                    ? 'text-[var(--destructive)]'
                    : 'text-[var(--text-primary)]',
                )}
              >
                {aggregate.overdueTotal}
              </span>{' '}
              overdue
            </span>
          </div>
        </div>
        {isPM && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const csv = buildTeamReportCSV({ members: teamMembers, tasks })
                const filename = `team-manager-team-${filenameDateStamp()}.csv`
                downloadCSV(filename, csv)
                toast.success(`Exported ${filename}`)
              }}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--border-default)] bg-transparent px-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Export team report
            </button>
            <button
              type="button"
              onClick={() => setInviteOpen(true)}
              disabled={dataSource === 'atlas'}
              title={
                dataSource === 'atlas'
                  ? 'Team members are managed in Atlas'
                  : undefined
              }
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-4 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[var(--accent-primary)]"
            >
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              Invite Member
            </button>
          </div>
        )}
      </header>

      {/* Search + filter chips. Sits between the stats header and the
          card grid; filters are AND-combined (search ⋀ chip). */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search members..."
            aria-label="Search members"
            className="h-9 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] pl-8 pr-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          />
        </div>
        <div
          role="tablist"
          aria-label="Filter members"
          className="flex flex-wrap items-center gap-1"
        >
          {FILTER_CHIPS.map((chip) => {
            const active = chipFilter === chip.value
            return (
              <button
                key={chip.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setChipFilter(chip.value)}
                className={cn(
                  'inline-flex h-8 items-center rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
                  active
                    ? 'border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)] text-[var(--accent-primary)]'
                    : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-default)] hover:text-[var(--text-primary)]',
                )}
              >
                {chip.label}
              </button>
            )
          })}
        </div>
      </div>

      {showSoloHint && (
        <div className="flex items-center gap-3 rounded-lg border border-dashed border-[var(--border-default)] bg-[var(--bg-surface)]/40 px-4 py-3">
          <Users
            className="h-5 w-5 shrink-0 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <p className="text-sm text-[var(--text-secondary)]">
            Invite your team to get started.
          </p>
        </div>
      )}

      {visibleMembers.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 px-4 py-8 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            {filterIsActive
              ? 'No members match your search.'
              : 'No team members yet.'}
          </p>
          {filterIsActive && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('')
                setChipFilter('all')
              }}
              className="mt-2 inline-flex items-center text-xs text-[var(--accent-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] focus-visible:rounded"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        // 2-column grid (1-column on mobile). `grid-flow-row-dense`
        // lets adjacent cards backfill empty cells when the expanded
        // section (a col-span-2 sibling) lands on its own row — the
        // expanded section appears BELOW the row of the clicked card,
        // and the rest of the cards continue in order without holes.
        <div className="grid grid-flow-row-dense grid-cols-1 items-stretch gap-4 md:grid-cols-2">
          {visibleMembers.map((m) => {
            const isExpanded = expandedId === m.id
            const canRemove =
              isPM && m.id !== currentUser.id && dataSource !== 'atlas'
            return (
              <Fragment key={m.id}>
                <TeamMemberCard
                  member={m}
                  tasks={tasksByMember.get(m.id) ?? []}
                  expanded={isExpanded}
                  onToggle={() =>
                    setExpandedId((prev) => (prev === m.id ? null : m.id))
                  }
                />
                {isExpanded && (
                  <div className="md:col-span-2">
                    <TeamMemberExpanded
                      member={m}
                      // RBAC: when a Member expands someone else's card,
                      // narrow the visible task list to projects they
                      // share. Own card and PM viewers see everything.
                      tasks={(() => {
                        const memberTasks = tasksByMember.get(m.id) ?? []
                        if (isPM || m.id === currentUser.id) return memberTasks
                        return memberTasks.filter((t) => canSeeProject(t.projectId))
                      })()}
                      projectsById={projectsById}
                      canRemove={canRemove}
                      onRemove={() => setConfirmRemove(m)}
                    />
                  </div>
                )}
              </Fragment>
            )
          })}
        </div>
      )}

      <InviteMemberModal
        open={inviteOpen}
        existingEmails={teamMembers.map((m) => m.email)}
        onClose={() => setInviteOpen(false)}
        onSubmit={handleInvite}
      />

      <ConfirmModal
        open={confirmRemove !== null}
        title="Remove member?"
        message={
          confirmRemove ? (
            <>
              Remove{' '}
              <strong className="text-[var(--text-primary)]">{confirmRemove.name}</strong>?{' '}
              {(() => {
                const count = activeCountFor(confirmRemove.id)
                if (count === 0) return 'They have no active tasks.'
                return (
                  <>
                    Their <strong className="text-[var(--text-primary)]">{count}</strong> active{' '}
                    {count === 1 ? 'task' : 'tasks'} will become unassigned.
                  </>
                )
              })()}
            </>
          ) : null
        }
        confirmLabel="Remove"
        destructive
        onConfirm={handleRemoveConfirm}
        onCancel={() => setConfirmRemove(null)}
      />
    </div>
  )
}
