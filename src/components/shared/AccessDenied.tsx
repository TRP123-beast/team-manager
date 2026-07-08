/**
 * Reusable "access denied" screen for RBAC-gated pages.
 *
 * Rendered inline inside a page (not a route redirect) so the URL stays
 * accurate and the user can share/bookmark without silent redirects
 * hiding the intent. A single "Back to safety" link points at the
 * safest home route we know for the current user.
 */

import { Lock } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/data/auth'

interface AccessDeniedProps {
  /** One-line explanation shown under the icon. Keep it plain — the
   *  user landed here by clicking a link or pasting a URL, not by
   *  doing something wrong. */
  message?: string
  /** Where the "back" link points. Defaults to a role-appropriate home. */
  backTo?: string
  backLabel?: string
}

export function AccessDenied({
  message = "You don't have access to this page.",
  backTo,
  backLabel,
}: AccessDeniedProps) {
  const { isPM } = useAuth()
  const target = backTo ?? (isPM ? '/dashboard' : '/my-tasks')
  const label = backLabel ?? (isPM ? 'Back to Dashboard' : 'Back to My Tasks')

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-8 text-center">
      <span
        aria-hidden="true"
        className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
      >
        <Lock className="h-5 w-5" />
      </span>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          Access denied
        </h2>
        <p className="text-sm text-[var(--text-secondary)]">{message}</p>
      </div>
      <Link
        to={target}
        className="mt-2 inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-primary)] px-4 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
      >
        {label}
      </Link>
    </div>
  )
}
