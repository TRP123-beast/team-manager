import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2, ShieldCheck } from 'lucide-react'
import { homePathForRole, useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { Avatar } from '@/components/shared/Avatar'
import {
  defaultPasswordFor,
  listLoginableProfiles,
} from '@/services/auth-service'
import { isSupabaseConfigured } from '@/services/supabase'
import type { UserProfile } from '@/data/types'
import { cn } from '@/lib/utils'

interface LocationState {
  from?: string
}

/** localStorage key so we hide the default-password hint after the user
 *  has logged in at least once on this browser. */
function firstLoginKey(userId: string): string {
  return `has_logged_in_before_${userId}`
}

function readHasLoggedInBefore(userId: string): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(firstLoginKey(userId)) === '1'
  } catch {
    return false
  }
}

function markLoggedInBefore(userId: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(firstLoginKey(userId), '1')
  } catch {
    // Ignore.
  }
}

export default function LoginPage() {
  useDocumentTitle('Login')
  const { isAuthenticated, currentUser, login, loginByMember } = useAuth()
  const { dataSource, teamMembers, isInitialLoading } = useData()
  const navigate = useNavigate()
  const location = useLocation()
  const fromState = (location.state as LocationState | null) ?? null

  // Prefer Supabase auth whenever it's configured. Atlas passwordless is
  // kept as a fallback only when Supabase isn't available AND the app is
  // running against Atlas.
  const useSupabaseAuth = isSupabaseConfigured()
  const useAtlasFallback = !useSupabaseAuth && dataSource === 'atlas'

  if (isAuthenticated && currentUser) {
    const target =
      fromState?.from && fromState.from !== '/login'
        ? fromState.from
        : homePathForRole(currentUser.role)
    return <Navigate to={target} replace />
  }

  const goAfterLogin = (role: 'pm' | 'member') => {
    const target =
      fromState?.from && fromState.from !== '/login'
        ? fromState.from
        : homePathForRole(role)
    navigate(target, { replace: true })
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-base)] px-4 py-12">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold leading-tight text-[var(--text-primary)]">
            Team Manager
          </h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            {useSupabaseAuth
              ? 'Sign in to your workspace'
              : 'Sign in to your workspace'}
          </p>
        </div>

        {useSupabaseAuth ? (
          <SupabaseLogin
            onSuccess={(role) => goAfterLogin(role)}
            login={login}
          />
        ) : useAtlasFallback ? (
          <AtlasLogin
            members={teamMembers}
            loadingTeam={isInitialLoading}
            onSelect={(member) => {
              const result = loginByMember(member)
              if (result.ok && result.user) goAfterLogin(result.user.role)
            }}
          />
        ) : (
          <SupabaseUnconfigured />
        )}
      </div>
    </div>
  )
}

// ── Supabase two-step login ─────────────────────────────────────────────

interface SupabaseLoginProps {
  onSuccess: (role: 'pm' | 'member') => void
  login: ReturnType<typeof useAuth>['login']
}

function SupabaseLogin({ onSuccess, login }: SupabaseLoginProps) {
  const [profiles, setProfiles] = useState<UserProfile[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // Bumps every time we want to re-trigger the shake animation on error.
  const [shakeToken, setShakeToken] = useState(0)
  const passwordInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoadingList(true)
      const rows = await listLoginableProfiles()
      if (cancelled) return
      if (rows.length === 0) {
        setListError('No user profiles found. Ask your admin to seed the team.')
      }
      setProfiles(rows)
      setLoadingList(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // When we advance to the password step, focus the field.
  useEffect(() => {
    if (selectedId) {
      // Slight delay so it happens after the slide-in.
      const t = window.setTimeout(() => passwordInputRef.current?.focus(), 260)
      return () => window.clearTimeout(t)
    }
  }, [selectedId])

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selectedId) ?? null,
    [profiles, selectedId],
  )
  const showHint = useMemo(
    () => (selectedProfile ? !readHasLoggedInBefore(selectedProfile.id) : false),
    [selectedProfile],
  )

  const handleSelect = useCallback((id: string) => {
    setError(null)
    setPassword('')
    setSelectedId(id)
  }, [])

  const handleBack = useCallback(() => {
    setError(null)
    setPassword('')
    setSelectedId(null)
  }, [])

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!selectedProfile || submitting) return
    setSubmitting(true)
    setError(null)
    const result = await login(selectedProfile.id, password)
    setSubmitting(false)
    if (!result.ok || !result.user) {
      setError(result.error ?? 'Incorrect password')
      setShakeToken((n) => n + 1)
      // Reselect the text so the user can retype quickly.
      passwordInputRef.current?.select()
      return
    }
    markLoggedInBefore(selectedProfile.id)
    onSuccess(result.user.role)
  }

  const onPassword = 'password' === (selectedId ? 'password' : 'select')

  return (
    <div
      className="relative min-h-[420px] overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]"
    >
      {/* Step 1 — pick a user card */}
      <div
        className={cn(
          'transition-transform duration-[250ms] ease-out',
          onPassword ? '-translate-x-full' : 'translate-x-0',
        )}
        aria-hidden={onPassword}
      >
        <div className="p-6">
          <h2 className="text-base font-medium text-[var(--text-primary)]">
            Welcome to Team Manager
          </h2>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Select your name to continue.
          </p>

          <div className="mt-5">
            {loadingList ? (
              <div className="flex h-40 items-center justify-center text-sm text-[var(--text-secondary)]">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Loading team…
              </div>
            ) : listError ? (
              <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 p-3 text-xs text-[var(--text-secondary)]">
                {listError}
              </p>
            ) : (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {profiles.map((p) => (
                  <li key={p.id}>
                    <UserCard
                      profile={p}
                      onClick={() => handleSelect(p.id)}
                      tabIndex={onPassword ? -1 : 0}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Step 2 — enter password */}
      <div
        className={cn(
          'absolute inset-0 transition-transform duration-[250ms] ease-out',
          onPassword ? 'translate-x-0' : 'translate-x-full',
        )}
        aria-hidden={!onPassword}
      >
        <form
          onSubmit={handleSubmit}
          className="flex h-full flex-col p-6"
          noValidate
        >
          <button
            type="button"
            onClick={handleBack}
            tabIndex={onPassword ? 0 : -1}
            className="inline-flex w-fit items-center gap-1 rounded text-xs font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Back
          </button>

          {selectedProfile && (
            <div className="mt-4 flex items-center gap-3">
              <UserAvatar profile={selectedProfile} size="lg" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                  {selectedProfile.display_name}
                </p>
                <p className="text-xs text-[var(--text-secondary)]">
                  {selectedProfile.role === 'pm' ? 'Project Manager' : 'Team member'}
                </p>
              </div>
            </div>
          )}

          <label
            htmlFor="password"
            className="mt-5 block text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]"
          >
            Password
          </label>
          <input
            key={shakeToken}
            ref={passwordInputRef}
            id="password"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              if (error) setError(null)
            }}
            autoComplete="current-password"
            required
            disabled={submitting}
            aria-invalid={error !== null || undefined}
            aria-describedby={error ? 'login-error' : showHint ? 'login-hint' : undefined}
            tabIndex={onPassword ? 0 : -1}
            className={cn(
              'mt-1 h-10 w-full rounded-md border bg-[var(--bg-input)] px-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]',
              'focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60',
              error
                ? 'border-[var(--destructive)] focus:border-[var(--destructive)] focus:ring-[var(--destructive)]/25'
                : 'border-[var(--border-subtle)] focus:border-[var(--accent-primary)] focus:ring-[var(--accent-focus)]',
            )}
            style={error ? { animation: 'loginShake 400ms ease-in-out' } : undefined}
          />

          {showHint && selectedProfile && !error && (
            <p
              id="login-hint"
              className="mt-2 text-xs text-[var(--text-muted)]"
            >
              Default password:{' '}
              <span className="font-mono text-[var(--text-secondary)]">
                {defaultPasswordFor(selectedProfile.id)}
              </span>
            </p>
          )}

          {error && (
            <p
              id="login-error"
              role="alert"
              className="mt-2 text-xs text-[var(--destructive)]"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || password.length === 0}
            tabIndex={onPassword ? 0 : -1}
            className="mt-5 inline-flex h-10 w-full items-center justify-center rounded-md bg-[var(--accent-primary)] px-4 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Signing in…
              </>
            ) : (
              'Log in'
            )}
          </button>
        </form>
      </div>
    </div>
  )
}

// ── User card + avatar ─────────────────────────────────────────────────

interface UserCardProps {
  profile: UserProfile
  onClick: () => void
  tabIndex?: number
}

function UserCard({ profile, onClick, tabIndex }: UserCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      tabIndex={tabIndex}
      className="group flex w-full flex-col items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/30 p-3 text-center transition-all hover:scale-[1.02] hover:border-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
    >
      <UserAvatar profile={profile} size="lg" />
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-[var(--text-primary)]">
          {profile.display_name}
        </p>
        <p className="text-[10px] uppercase tracking-[0.5px] text-[var(--text-muted)]">
          {profile.role === 'pm' ? 'PM' : 'Member'}
        </p>
      </div>
    </button>
  )
}

interface UserAvatarProps {
  profile: UserProfile
  size: 'md' | 'lg'
}

function UserAvatar({ profile, size }: UserAvatarProps) {
  const dim = size === 'lg' ? 'h-12 w-12 text-base' : 'h-10 w-10 text-sm'
  if (profile.avatar_url) {
    return (
      <img
        src={profile.avatar_url}
        alt={profile.display_name}
        className={cn(
          'shrink-0 rounded-full object-cover',
          size === 'lg' ? 'h-12 w-12' : 'h-10 w-10',
        )}
      />
    )
  }
  const initials =
    profile.avatar_initials?.trim() ||
    profile.display_name
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase()
  const bg = profile.avatar_color?.trim() || '#3B82F6'
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white',
        dim,
      )}
      style={{ backgroundColor: bg }}
    >
      {initials || '?'}
    </span>
  )
}

// ── Supabase unconfigured (rare — Atlas isn't active either) ────────────

function SupabaseUnconfigured() {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6">
      <p className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.5px] text-[var(--destructive)]">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        Not configured
      </p>
      <p className="mt-3 text-sm text-[var(--text-primary)]">
        Auth backend isn't reachable.
      </p>
      <p className="mt-2 text-xs text-[var(--text-secondary)]">
        Set <code className="font-mono">VITE_SUPABASE_URL</code> and{' '}
        <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> in your{' '}
        <code className="font-mono">.env</code>, then reload.
      </p>
    </div>
  )
}

// ── Atlas-mode fallback (passwordless dropdown) ─────────────────────────

interface AtlasLoginProps {
  members: ReturnType<typeof useData>['teamMembers']
  loadingTeam: boolean
  onSelect: (member: AtlasLoginProps['members'][number]) => void
}

function AtlasLogin({ members, loadingTeam, onSelect }: AtlasLoginProps) {
  const [selectedId, setSelectedId] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)

  const sorted = useMemo(
    () =>
      [...members].sort((a, b) => {
        if (a.role !== b.role) return a.role === 'pm' ? -1 : 1
        return a.name.localeCompare(b.name)
      }),
    [members],
  )

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const member = sorted.find((m) => m.id === selectedId)
    if (!member) return
    setSubmitting(true)
    onSelect(member)
  }

  return (
    <>
      <form
        onSubmit={handleSubmit}
        className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6"
      >
        <p className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.5px] text-[var(--accent-primary)]">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Atlas fallback
        </p>
        <h2 className="mt-1 text-base font-medium text-[var(--text-primary)]">
          Select your name
        </h2>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          Supabase auth isn't configured; using the Atlas passwordless flow.
        </p>

        <label
          htmlFor="atlas-login-member"
          className="mt-5 block text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]"
        >
          Team member
        </label>
        {loadingTeam && sorted.length === 0 ? (
          <div className="mt-1 flex h-10 items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-3 text-sm text-[var(--text-secondary)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading team from Atlas…
          </div>
        ) : (
          <select
            id="atlas-login-member"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            required
            disabled={submitting}
            className="mt-1 h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-3 text-sm text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="" disabled>
              {sorted.length === 0
                ? 'No team members yet'
                : 'Choose your name…'}
            </option>
            {sorted.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} {m.role === 'pm' ? '· PM' : ''}
              </option>
            ))}
          </select>
        )}

        {selectedId && (
          <div className="mt-4 flex items-center gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 p-3">
            {(() => {
              const m = sorted.find((x) => x.id === selectedId)
              if (!m) return null
              return (
                <>
                  <Avatar name={m.name} size="md" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                      {m.name}
                    </p>
                    <p className="truncate text-xs text-[var(--text-secondary)]">
                      Signing in as {m.role === 'pm' ? 'PM' : 'team member'}
                    </p>
                  </div>
                </>
              )
            })()}
          </div>
        )}

        <button
          type="submit"
          disabled={!selectedId || submitting || loadingTeam}
          className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-md bg-[var(--accent-primary)] px-4 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              Signing in…
            </>
          ) : (
            'Continue'
          )}
        </button>
      </form>
    </>
  )
}
