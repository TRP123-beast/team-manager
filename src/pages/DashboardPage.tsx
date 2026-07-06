import { useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Calendar,
  CheckCircle,
  FolderOpen,
  LayoutGrid,
} from 'lucide-react'
import { CollapsibleSection } from '@/components/dashboard/CollapsibleSection'
import { ProjectsGlance } from '@/components/dashboard/ProjectsGlance'
import { RecentMeetings } from '@/components/dashboard/RecentMeetings'
import { SummaryCard } from '@/components/dashboard/SummaryCard'
import { SkeletonCard, SkeletonLine } from '@/components/shared/Skeleton'
import { useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import type { Task } from '@/data/types'
import {
  endOfWeek,
  isInThisWeek,
  isOverdue,
  startOfWeek,
} from '@/lib/date-utils'

/** sessionStorage key that gates the one-time Google Sheets setup toast
 *  on Dashboard load. Cleared when the user opens a new browser tab. */
const SHEETS_SETUP_TOAST_KEY = 'team-manager.sheets-setup-toast-shown'

export default function DashboardPage() {
  useDocumentTitle('Dashboard')
  const { currentUser } = useAuth()
  const {
    tasks,
    projects,
    meetings,
    isInitialLoading,
    syncError,
    refreshFromAtlas,
    dataSource,
    sheetsConnected,
  } = useData()

  // One-time "your sheets config is incomplete" or "sheets fetch failed"
  // toast on first dashboard load this session. sessionStorage gate so a
  // reload doesn't re-notify until the user opens a new tab.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.sessionStorage.getItem(SHEETS_SETUP_TOAST_KEY)) return

    const env: Record<string, string | undefined> = import.meta.env as never
    const sheetsVars: Array<[string, string]> = [
      ['VITE_GOOGLE_SHEETS_CLIENT_ID', env.VITE_GOOGLE_SHEETS_CLIENT_ID ?? ''],
      ['VITE_GOOGLE_SHEETS_CLIENT_SECRET', env.VITE_GOOGLE_SHEETS_CLIENT_SECRET ?? ''],
      ['VITE_GOOGLE_SHEETS_REFRESH_TOKEN', env.VITE_GOOGLE_SHEETS_REFRESH_TOKEN ?? ''],
      ['VITE_GOOGLE_SHEETS_SPREADSHEET_ID', env.VITE_GOOGLE_SHEETS_SPREADSHEET_ID ?? ''],
    ]
    const set = sheetsVars.filter(([, v]) => v && v.trim())
    const missing = sheetsVars
      .filter(([, v]) => !v || !v.trim())
      .map(([k]) => k)

    // Partial configuration → user set some env vars but not all.
    if (set.length > 0 && missing.length > 0) {
      toast.warning(
        `Google Sheets integration is partially configured. Missing: ${missing.join(', ')}. Add them to your .env file and restart.`,
        { duration: 8000 },
      )
      window.sessionStorage.setItem(SHEETS_SETUP_TOAST_KEY, '1')
      return
    }
    // Fully configured but never produced a successful fetch — wait for
    // the initial load to settle before flagging. `isInitialLoading`
    // covers Atlas; we also want sheets to have had its first shot.
    if (set.length === sheetsVars.length && !isInitialLoading && !sheetsConnected) {
      toast.error(
        `Google Sheets connected but fetch failed: ${syncError ?? 'check Settings for details'}.`,
        { duration: 8000 },
      )
      window.sessionStorage.setItem(SHEETS_SETUP_TOAST_KEY, '1')
    }
  }, [isInitialLoading, sheetsConnected, syncError])

  const summary = useMemo(() => computeSummary(tasks), [tasks])

  if (isInitialLoading) {
    return <DashboardSkeleton />
  }

  if (projects.length === 0) {
    return <EmptyDashboard />
  }

  return (
    // Uniform 24 px (space-y-6) between sections. With Needs Attention,
    // This Week, and Activity all removed, the dashboard is now a
    // short scan: Summary → Projects → Meetings.
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Dashboard</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          {currentUser ? `Welcome back, ${currentUser.name.split(' ')[0]}.` : 'Welcome back.'}{' '}
          Here&apos;s what&apos;s happening across your team.
        </p>
      </header>

      {dataSource === 'atlas' && syncError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[color-mix(in_srgb,var(--priority-medium)_25%,var(--border-subtle))] bg-[color-mix(in_srgb,var(--priority-medium)_8%,transparent)] px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--text-primary)]">
              Failed to load data from Atlas
            </p>
            <p className="mt-0.5 truncate text-xs text-[var(--text-secondary)]">
              {syncError} — showing cached data.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void refreshFromAtlas()
            }}
            className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--border-default)] bg-transparent px-3 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            Retry
          </button>
        </div>
      )}

      <CollapsibleSection id="summary" title="Summary">
        <div
          data-tour="summary"
          className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-4"
        >
          <SummaryCard
            icon={LayoutGrid}
            label="Open Tasks"
            value={summary.open}
            accent="blue"
          />
          <SummaryCard
            icon={AlertTriangle}
            label="Overdue"
            value={summary.overdue}
            accent="red"
            highlightWhenPositive
            pulseWhenPositive
          />
          <SummaryCard
            icon={Calendar}
            label="Due This Week"
            value={summary.dueThisWeek}
            accent="amber"
          />
          <SummaryCard
            icon={CheckCircle}
            label="Completed This Week"
            value={summary.completedThisWeek}
            accent="green"
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        id="projects-glance"
        title="Projects at a Glance"
        subtitle="Health across every active project — click a card to filter the board."
      >
        <ProjectsGlance projects={projects} tasks={tasks} />
      </CollapsibleSection>

      <CollapsibleSection
        id="recent-meetings"
        title="Recent Meetings"
        subtitle="The last three across every project."
        controls={
          <Link
            to="/projects"
            className="text-xs font-medium text-[var(--accent-primary)] hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            View all
          </Link>
        }
      >
        <RecentMeetings meetings={meetings} projects={projects} />
      </CollapsibleSection>
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <SkeletonLine width="w-40" height="h-7" />
        <SkeletonLine width="w-72" height="h-3" className="mt-2" />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} className="md:p-5">
            <SkeletonLine width="w-6" height="h-6" />
            <SkeletonLine width="w-12" height="h-7" className="mt-3" />
            <SkeletonLine width="w-24" height="h-3" className="mt-3" />
          </SkeletonCard>
        ))}
      </div>
      <div className="space-y-2">
        <SkeletonLine width="w-32" height="h-5" />
        <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <div className="flex gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonCard key={i} className="w-[200px] shrink-0">
                <SkeletonLine width="w-28" height="h-4" />
                <SkeletonLine width="w-14" height="h-14" className="mx-auto mt-3 rounded-full" />
                <SkeletonLine width="w-20" height="h-3" className="mx-auto mt-3" />
              </SkeletonCard>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function EmptyDashboard() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <FolderOpen
        className="h-12 w-12 text-[var(--text-muted)]"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <h2 className="mt-4 text-base font-medium text-[var(--text-secondary)]">
        No projects yet
      </h2>
      <p className="mt-1 max-w-sm text-sm text-[var(--text-muted)]">
        Create your first project to get started organizing work.
      </p>
      <Link
        to="/projects"
        className="mt-5 inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-primary)] px-4 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)]"
      >
        Create your first project
      </Link>
    </div>
  )
}

interface Summary {
  open: number
  overdue: number
  dueThisWeek: number
  completedThisWeek: number
}

function computeSummary(tasks: Task[]): Summary {
  const weekStart = startOfWeek().getTime()
  const weekEnd = endOfWeek().getTime()
  let open = 0
  let overdue = 0
  let dueThisWeek = 0
  let completedThisWeek = 0
  for (const t of tasks) {
    if (t.status !== 'done') {
      open += 1
      if (isOverdue(t.dueDate)) overdue += 1
    }
    if (isInThisWeek(t.dueDate)) dueThisWeek += 1
    if (t.status === 'done') {
      const updated = new Date(t.updatedAt).getTime()
      if (updated >= weekStart && updated <= weekEnd) {
        completedThisWeek += 1
      }
    }
  }
  return { open, overdue, dueThisWeek, completedThisWeek }
}
