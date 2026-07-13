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
import { toast } from 'sonner'
import {
  changeUserPassword,
  loginUser,
  logoutUser,
  seedDefaultPasswords,
  validateSession,
} from '@/services/auth-service'
import { isSupabaseConfigured } from '@/services/supabase'
import { mockTeamMembers } from './mock-data'
import type { TeamMember } from './types'

/** LocalStorage keys.
 *   USER  — full mapped TeamMember, used for instant render on cold load
 *   TOKEN — session token validated against Supabase in the background
 *   LEGACY_ID_KEY / STORAGE_KEY — pre-Supabase keys, read once on boot for
 *     backwards compatibility so an in-flight session doesn't kick users
 *     back to /login after the upgrade */
const USER_KEY = 'auth_user'
const TOKEN_KEY = 'auth_token'
const STORAGE_KEY = 'team-manager.auth.user'
const LEGACY_ID_KEY = 'team-manager.auth.userId'

export interface LoginResult {
  ok: boolean
  user: TeamMember | null
  error: string | null
}

export interface ChangePasswordResult {
  ok: boolean
  error: string | null
}

export interface AuthStore {
  currentUser: TeamMember | null
  isAuthenticated: boolean
  isPM: boolean
  /** True while we're validating a persisted token against Supabase for the
   *  first time this session. Consumers can use it to show a loader, but
   *  most surfaces just render optimistically from the cached user. */
  isLoading: boolean
  /** Session token, if we currently have one. Exposed so ChangePassword can
   *  skip revoking the caller's own session. */
  sessionToken: string | null
  /** Supabase-backed password login. `userId` is the row id
   *  ("brian", "clive", …). */
  login: (userId: string, password: string) => Promise<LoginResult>
  /** Atlas-mode passwordless login retained as a dev-only fallback for
   *  when Supabase isn't reachable. */
  loginByMember: (member: TeamMember) => LoginResult
  logout: () => Promise<void>
  updateCurrentUser: (patch: Partial<TeamMember>) => void
  changePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<ChangePasswordResult>
}

const AuthContext = createContext<AuthStore | null>(null)

function readCachedUser(): TeamMember | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(USER_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as TeamMember
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
        return parsed
      }
    }
    // Legacy fallbacks — read once, migrate to USER_KEY on next persist tick.
    const legacyRaw = window.localStorage.getItem(STORAGE_KEY)
    if (legacyRaw) {
      const parsed = JSON.parse(legacyRaw) as TeamMember
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
        return parsed
      }
    }
    const legacyId = window.localStorage.getItem(LEGACY_ID_KEY)
    if (legacyId) {
      return mockTeamMembers.find((m) => m.id === legacyId) ?? null
    }
    return null
  } catch {
    return null
  }
}

function readCachedToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

function persistSession(user: TeamMember | null, token: string | null) {
  if (typeof window === 'undefined') return
  try {
    if (user) {
      window.localStorage.setItem(USER_KEY, JSON.stringify(user))
    } else {
      window.localStorage.removeItem(USER_KEY)
    }
    if (token) {
      window.localStorage.setItem(TOKEN_KEY, token)
    } else {
      window.localStorage.removeItem(TOKEN_KEY)
    }
    // Drop the legacy keys once we've written to the new ones.
    window.localStorage.removeItem(STORAGE_KEY)
    window.localStorage.removeItem(LEGACY_ID_KEY)
  } catch {
    // Ignore storage errors (private mode / quota).
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<TeamMember | null>(() =>
    readCachedUser(),
  )
  const [sessionToken, setSessionToken] = useState<string | null>(() =>
    readCachedToken(),
  )
  const [isLoading, setIsLoading] = useState<boolean>(
    () => isSupabaseConfigured() && readCachedToken() !== null,
  )
  // Track whether we've already run the boot validation — StrictMode
  // fires the effect twice in dev; the toast on session-expiry should
  // only appear once.
  const validatedRef = useRef(false)

  // ── Boot: validate persisted token against Supabase in the background.
  useEffect(() => {
    if (validatedRef.current) return
    validatedRef.current = true

    if (!isSupabaseConfigured()) {
      setIsLoading(false)
      return
    }

    // Non-blocking seeding of default passwords for any users still on
    // SETUP_REQUIRED. Runs once per app load; no-op after the first run.
    void seedDefaultPasswords()

    const token = readCachedToken()
    if (!token) {
      setIsLoading(false)
      return
    }
    let cancelled = false
    void (async () => {
      const user = await validateSession(token)
      if (cancelled) return
      if (user) {
        setCurrentUser(user)
        setSessionToken(token)
        persistSession(user, token)
      } else {
        // Only complain if the user WAS optimistically authed from
        // localStorage — a fresh browser with a stale token shouldn't
        // toast on the login page.
        const hadOptimisticUser = readCachedUser() !== null
        setCurrentUser(null)
        setSessionToken(null)
        persistSession(null, null)
        if (hadOptimisticUser) {
          toast.error('Your session expired. Please log in again.')
        }
      }
      setIsLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback<AuthStore['login']>(async (userId, password) => {
    const trimmedId = userId.trim().toLowerCase()
    if (!trimmedId) {
      return { ok: false, user: null, error: 'Please select a user.' }
    }
    const outcome = await loginUser(trimmedId, password)
    if (!outcome.ok || !outcome.member || !outcome.token) {
      return {
        ok: false,
        user: null,
        error: outcome.error ?? 'Login failed.',
      }
    }
    setCurrentUser(outcome.member)
    setSessionToken(outcome.token)
    persistSession(outcome.member, outcome.token)
    return { ok: true, user: outcome.member, error: null }
  }, [])

  const loginByMember = useCallback<AuthStore['loginByMember']>((member) => {
    if (!member || typeof member.id !== 'string') {
      return { ok: false, user: null, error: 'No team member selected.' }
    }
    // Atlas fallback has no session token — persist just the user.
    setCurrentUser(member)
    setSessionToken(null)
    persistSession(member, null)
    return { ok: true, user: member, error: null }
  }, [])

  const logout = useCallback<AuthStore['logout']>(async () => {
    const token = sessionToken ?? readCachedToken()
    setCurrentUser(null)
    setSessionToken(null)
    persistSession(null, null)
    await logoutUser(token)
  }, [sessionToken])

  const updateCurrentUser = useCallback<AuthStore['updateCurrentUser']>((patch) => {
    setCurrentUser((prev) => {
      if (!prev) return prev
      const next = { ...prev, ...patch }
      // Re-persist so the cached copy stays in sync with edits made
      // via Settings.
      persistSession(next, sessionToken ?? readCachedToken())
      return next
    })
  }, [sessionToken])

  const changePassword = useCallback<AuthStore['changePassword']>(
    async (currentPassword, newPassword) => {
      if (!currentUser) {
        return { ok: false, error: 'You must be logged in.' }
      }
      const outcome = await changeUserPassword(
        currentUser.id,
        currentPassword,
        newPassword,
        sessionToken,
      )
      return { ok: outcome.ok, error: outcome.error ?? null }
    },
    [currentUser, sessionToken],
  )

  const value = useMemo<AuthStore>(
    () => ({
      currentUser,
      isAuthenticated: currentUser !== null,
      isPM: currentUser?.role === 'pm',
      isLoading,
      sessionToken,
      login,
      loginByMember,
      logout,
      updateCurrentUser,
      changePassword,
    }),
    [
      currentUser,
      isLoading,
      sessionToken,
      login,
      loginByMember,
      logout,
      updateCurrentUser,
      changePassword,
    ],
  )

  return createElement(AuthContext.Provider, { value }, children)
}

export function useAuth(): AuthStore {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used inside an <AuthProvider>')
  }
  return ctx
}

/** Route to redirect to after login based on role. */
export function homePathForRole(role: TeamMember['role']): string {
  return role === 'pm' ? '/dashboard' : '/my-tasks'
}
