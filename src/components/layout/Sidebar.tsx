import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Columns3,
  CheckSquare,
  FolderOpen,
  CalendarRange,
  Radio,
  Users,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '@/data/auth'
import { cn } from '@/lib/utils'

interface SidebarProps {
  mobileOpen: boolean
  onMobileClose: () => void
}

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** When true, the nav item also highlights for paths nested under
   *  `to` (e.g. /projects/foo lights up the "Projects" entry). */
  matchNested?: boolean
}

const dashboardItem: NavItem = { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }

const sharedItems: NavItem[] = [
  { to: '/board', label: 'Board', icon: Columns3 },
  { to: '/my-tasks', label: 'My Tasks', icon: CheckSquare },
  { to: '/projects', label: 'Projects', icon: FolderOpen, matchNested: true },
  { to: '/meetings', label: 'Meetings', icon: CalendarRange, matchNested: true },
  { to: '/team', label: 'Team', icon: Users },
]

// Atlas is PM-only — the section is a data-integration surface, not
// something team members act on. Slotted between the shared items and
// Team so the nav order matches the pre-RBAC layout for PMs.
const atlasItem: NavItem = {
  to: '/atlas',
  label: 'Atlas',
  icon: Radio,
  matchNested: true,
}

const settingsItem: NavItem = { to: '/settings', label: 'Settings', icon: Settings }

export function Sidebar({ mobileOpen, onMobileClose }: SidebarProps) {
  const { isPM } = useAuth()
  const primaryItems: NavItem[] = isPM
    ? [
        dashboardItem,
        // Keep Atlas next to Meetings so the info-consumption group
        // stays clustered (Meetings → Atlas → Team).
        ...sharedItems.slice(0, 4),
        atlasItem,
        ...sharedItems.slice(4),
      ]
    : sharedItems
  return (
    <>
      {/* Mobile backdrop */}
      <div
        onClick={onMobileClose}
        className={cn(
          'fixed inset-0 z-30 bg-black/60 transition-opacity md:hidden',
          mobileOpen
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 pointer-events-none',
        )}
        aria-hidden={!mobileOpen}
      />

      <aside
        className={cn(
          'fixed bottom-0 left-0 z-40 flex flex-col',
          'bg-[var(--bg-surface)] border-r border-[var(--border-subtle)]',
          'transition-[transform,width,top] duration-200 ease-out',
          // Mobile (<768): hidden overlay
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          // Tablet (>=768): visible, 64px icons-only
          'md:translate-x-0 md:w-16',
          // Desktop (>=1024): full 240px
          'lg:w-60',
          // Mobile width (when shown as overlay)
          'w-60',
        )}
        style={{ top: 'var(--banner-h, 0px)' }}
        aria-label="Primary navigation"
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-[var(--border-subtle)] px-3 md:justify-center md:px-0 lg:justify-start lg:px-5">
          {/* Logo mark — accent-coloured rounded square with "TM"
              monogram. Always visible (replaces the previous text-only
              "TM" tablet variant). Pairs with the wordmark on
              mobile/desktop. */}
          <span
            aria-hidden="true"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent-primary)] text-[11px] font-bold text-[var(--text-inverse)]"
          >
            TM
          </span>
          <div className="flex min-w-0 flex-col md:hidden lg:flex">
            <span className="truncate text-sm font-bold text-[var(--text-primary)]">
              Team Manager
            </span>
            <span className="truncate text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
              Workspace
            </span>
          </div>
        </div>

        <nav data-tour="sidebar" className="flex-1 overflow-y-auto py-3">
          <ul className="space-y-1 px-2">
            {primaryItems.map((item) => (
              <li key={item.to}>
                <NavItemLink item={item} onNavigate={onMobileClose} />
              </li>
            ))}
          </ul>
        </nav>

        {/* Settings sits in its own footer slot — pulled out of the
            main nav by a top border + margin so it visually reads as
            "everything below this line is meta", not just another
            destination. */}
        <div className="border-t border-[var(--border-subtle)] px-2 pb-2 pt-2 mt-2">
          <NavItemLink item={settingsItem} onNavigate={onMobileClose} />
        </div>
      </aside>
    </>
  )
}

interface NavItemLinkProps {
  item: NavItem
  onNavigate: () => void
}

function NavItemLink({ item, onNavigate }: NavItemLinkProps) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'relative flex items-center gap-3 rounded-md px-3 py-2.5 text-sm',
          // Default text + hover. The hover bg uses a 60%-tinted
          // elevated colour so inactive items get a clear "press me"
          // affordance without competing with the active state.
          'text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--bg-elevated)_60%,transparent)] hover:text-[var(--text-primary)]',
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
          'md:justify-center md:px-2 md:py-2 lg:justify-start lg:px-3 lg:py-2',
          // Active item: solid elevated bg, slightly bolder text, and
          // a 3px-wide accent-coloured bar pinned to the left edge via
          // a ::before pseudo-element. Bar uses inset-y-1 for visual
          // breathing room top/bottom.
          isActive
            ? 'bg-[var(--bg-elevated)] font-semibold text-[var(--text-primary)] before:absolute before:left-0 before:top-1 before:bottom-1 before:w-[3px] before:rounded-r before:bg-[var(--accent-primary)]'
            : 'font-medium',
        )
      }
      end={!item.matchNested}
    >
      <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
      <span className="md:hidden lg:inline">{item.label}</span>
    </NavLink>
  )
}
