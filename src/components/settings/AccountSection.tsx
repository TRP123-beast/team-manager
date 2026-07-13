import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogOut, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { ProfilePhotoSection } from '@/components/settings/ProfilePhotoSection'
import { useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import { clearOnboardingSeen } from '@/lib/onboarding'

export function AccountSection() {
  const navigate = useNavigate()
  const { currentUser, logout, updateCurrentUser } = useAuth()
  const { updateTeamMember } = useData()

  const [name, setName] = useState(currentUser?.name ?? '')
  const [busy, setBusy] = useState(false)

  if (!currentUser) return null

  const dirty = name.trim() !== currentUser.name && name.trim().length > 0

  const handleSaveName = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await updateTeamMember(currentUser.id, { name: trimmed })
      updateCurrentUser({ name: trimmed })
      toast.success('Name updated.')
    } catch {
      toast.error('Could not update your name.')
    } finally {
      setBusy(false)
    }
  }

  const handleLogout = () => {
    logout()
    toast.success('Logged out.')
    navigate('/login', { replace: true })
  }

  const handleReplayTour = () => {
    clearOnboardingSeen(currentUser.id)
    toast.success('Tour reset — watch the bottom-left.')
  }

  return (
    <section aria-labelledby="account-heading">
      <h2
        id="account-heading"
        className="text-lg font-semibold text-[var(--text-primary)]"
      >
        Account
      </h2>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        Your profile in this workspace.
      </p>

      <div className="mt-5 space-y-5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 md:p-5">
        <ProfilePhotoSection />

        <div className="border-t border-[var(--border-subtle)] pt-5">
          <label
            htmlFor="account-name"
            className="block text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]"
          >
            Name
          </label>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <input
              id="account-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              className="h-9 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-focus)]"
            />
            <button
              type="button"
              onClick={handleSaveName}
              disabled={!dirty || busy}
              className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-primary)] px-4 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>

        <div>
          <label
            htmlFor="account-email"
            className="block text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]"
          >
            Email
          </label>
          <input
            id="account-email"
            type="email"
            value={currentUser.email}
            readOnly
            className="mt-1 h-9 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-3 text-sm text-[var(--text-secondary)] cursor-not-allowed"
          />
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Contact your workspace admin to change your email.
          </p>
        </div>

        <div className="border-t border-[var(--border-subtle)] pt-4">
          <button
            type="button"
            onClick={handleReplayTour}
            className="inline-flex h-8 items-center gap-1.5 rounded text-sm font-medium text-[var(--accent-primary)] transition-colors hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Replay onboarding tour
          </button>
        </div>

        <div className="border-t border-[var(--border-subtle)] pt-4">
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--border-default)] bg-transparent px-4 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Log out
          </button>
        </div>
      </div>
    </section>
  )
}
