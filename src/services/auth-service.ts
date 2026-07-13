/**
 * Password auth backed by Supabase.
 *
 * Tables:
 *   - user_profiles   — one row per team member, `password_hash` is bcrypt
 *   - user_sessions   — active tokens, cleaned up on logout/expiry
 *
 * Password contract:
 *   - Default is `${user.id}@auth` (id column IS the firstname slug —
 *     "brian", "chris", "briankosir", …). A user's first successful
 *     login with that string replaces the SETUP_REQUIRED sentinel with
 *     a bcrypt hash so subsequent logins go through `bcrypt.compare`.
 *   - `seedDefaultPasswords()` runs at app boot and pre-computes hashes
 *     for every SETUP_REQUIRED row so the login fallback is rarely
 *     needed in practice.
 */

import bcrypt from 'bcryptjs'
import { supabase } from './supabase'
import type { Role, TeamMember, UserProfile } from '@/data/types'

const SETUP_REQUIRED = 'SETUP_REQUIRED'
const BCRYPT_ROUNDS = 10
/** 7 days, as milliseconds. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

function generateToken(): string {
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

/** Convert a Supabase user_profiles row to the app-wide TeamMember shape. */
export function profileToMember(row: UserProfile): TeamMember {
  return {
    id: row.id,
    name: row.display_name,
    email: row.email,
    role: (row.role as Role) ?? 'member',
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
  }
}

/** Default password derived from the user id — matches the "firstname@auth"
 *  pattern because the `id` column is the firstname slug. */
export function defaultPasswordFor(userId: string): string {
  return `${userId}@auth`
}

export interface LoginOutcome {
  ok: boolean
  member?: TeamMember
  token?: string
  error?: string
}

/** Verify credentials against user_profiles; issue a session token on success.
 *  Behavior when `password_hash === 'SETUP_REQUIRED'`: hash whatever the user
 *  typed and store it, then proceed as a successful login. */
export async function loginUser(
  userId: string,
  password: string,
): Promise<LoginOutcome> {
  if (!supabase) {
    return { ok: false, error: 'Auth backend is not configured.' }
  }
  try {
    const { data: row, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle()

    if (error) {
      console.error('[Auth] Failed to load profile', error)
      return { ok: false, error: 'Login failed. Please try again.' }
    }
    if (!row) {
      return { ok: false, error: 'User not found.' }
    }
    const profile = row as UserProfile

    if (profile.password_hash === SETUP_REQUIRED) {
      // First-touch fallback: the seed hasn't run yet (or was rolled
      // back). Whatever the user typed becomes their password.
      const newHash = await hashPassword(password)
      const { error: upErr } = await supabase
        .from('user_profiles')
        .update({ password_hash: newHash, updated_at: new Date().toISOString() })
        .eq('id', profile.id)
      if (upErr) {
        console.error('[Auth] Failed to seed password on first login', upErr)
        return { ok: false, error: 'Login failed. Please try again.' }
      }
    } else {
      const ok = await bcrypt.compare(password, profile.password_hash)
      if (!ok) {
        return { ok: false, error: 'Incorrect password.' }
      }
    }

    const token = generateToken()
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
    const nowIso = new Date().toISOString()

    const { error: sessErr } = await supabase.from('user_sessions').insert({
      user_id: profile.id,
      token,
      expires_at: expiresAt,
    })
    if (sessErr) {
      console.error('[Auth] Failed to create session', sessErr)
      return { ok: false, error: 'Login failed. Please try again.' }
    }

    // Best-effort — don't block login if this update fails.
    void supabase
      .from('user_profiles')
      .update({ last_login_at: nowIso })
      .eq('id', profile.id)
      .then(({ error: llErr }) => {
        if (llErr) console.warn('[Auth] last_login_at update failed', llErr)
      })

    return { ok: true, member: profileToMember(profile), token }
  } catch (err) {
    console.error('[Auth] Login error', err)
    return { ok: false, error: 'Login failed. Please try again.' }
  }
}

/** Look up a session by token and return the associated user, or null when
 *  the token is unknown or expired. Also touches `last_used_at`. */
export async function validateSession(token: string): Promise<TeamMember | null> {
  if (!supabase || !token) return null
  try {
    const nowIso = new Date().toISOString()
    const { data, error } = await supabase
      .from('user_sessions')
      .select('token, expires_at, user_profiles(*)')
      .eq('token', token)
      .gt('expires_at', nowIso)
      .maybeSingle()

    if (error || !data) return null

    // Supabase's inferred type for the nested relation is `any` unless we
    // narrow it — the row is either a single object or an array depending
    // on the FK cardinality of the schema. We wrote the FK 1:1 so we
    // expect an object.
    const rawProfile = (data as { user_profiles: UserProfile | UserProfile[] | null })
      .user_profiles
    const profile = Array.isArray(rawProfile) ? rawProfile[0] : rawProfile
    if (!profile) return null

    void supabase
      .from('user_sessions')
      .update({ last_used_at: nowIso })
      .eq('token', token)
      .then(({ error: touchErr }) => {
        if (touchErr) console.warn('[Auth] last_used_at update failed', touchErr)
      })

    return profileToMember(profile)
  } catch (err) {
    console.warn('[Auth] validateSession error', err)
    return null
  }
}

export async function logoutUser(token: string | null): Promise<void> {
  if (supabase && token) {
    try {
      const { error } = await supabase
        .from('user_sessions')
        .delete()
        .eq('token', token)
      if (error) console.warn('[Auth] Session delete failed', error)
    } catch (err) {
      console.warn('[Auth] Logout error', err)
    }
  }
}

export interface ChangePasswordOutcome {
  ok: boolean
  error?: string
}

/** Verify current password, replace the hash, and revoke every OTHER session
 *  for this user (the current session stays alive). */
export async function changeUserPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  currentToken: string | null,
): Promise<ChangePasswordOutcome> {
  if (!supabase) return { ok: false, error: 'Auth backend is not configured.' }
  if (newPassword.length < 8) {
    return { ok: false, error: 'New password must be at least 8 characters.' }
  }
  try {
    const { data: row, error } = await supabase
      .from('user_profiles')
      .select('password_hash')
      .eq('id', userId)
      .maybeSingle()
    if (error || !row) {
      return { ok: false, error: 'Could not verify your current password.' }
    }
    const hash = (row as { password_hash: string }).password_hash

    // Users mid-first-setup shouldn't be able to bypass "current pw"
    // checks — treat SETUP_REQUIRED as a hard block here. In practice
    // they'd never see the change-password form (they'd hit login first).
    if (hash === SETUP_REQUIRED) {
      return { ok: false, error: 'Please log in with your default password first.' }
    }
    const ok = await bcrypt.compare(currentPassword, hash)
    if (!ok) {
      return { ok: false, error: 'Current password is incorrect.' }
    }

    const newHash = await hashPassword(newPassword)
    const { error: upErr } = await supabase
      .from('user_profiles')
      .update({ password_hash: newHash, updated_at: new Date().toISOString() })
      .eq('id', userId)
    if (upErr) {
      console.error('[Auth] Failed to store new password', upErr)
      return { ok: false, error: 'Could not update password. Try again.' }
    }

    // Revoke every session EXCEPT the one making this request.
    const sessionsQuery = supabase
      .from('user_sessions')
      .delete()
      .eq('user_id', userId)
    const sessionsFinal = currentToken
      ? sessionsQuery.neq('token', currentToken)
      : sessionsQuery
    const { error: revErr } = await sessionsFinal
    if (revErr) console.warn('[Auth] Other-session revoke failed', revErr)

    return { ok: true }
  } catch (err) {
    console.error('[Auth] changeUserPassword error', err)
    return { ok: false, error: 'Could not update password. Try again.' }
  }
}

/** Load every user profile — used by the login page to render the picker. */
export async function listLoginableUsers(): Promise<TeamMember[]> {
  if (!supabase) return []
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .order('role', { ascending: true }) // 'member' < 'pm' alphabetically; we'll sort more precisely below
      .order('display_name', { ascending: true })
    if (error) {
      console.warn('[Auth] Could not load user list', error)
      return []
    }
    const rows = (data ?? []) as UserProfile[]
    return rows
      .map(profileToMember)
      .sort((a, b) => {
        if (a.role !== b.role) return a.role === 'pm' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  } catch (err) {
    console.warn('[Auth] listLoginableUsers error', err)
    return []
  }
}

/** Also expose the row shape for surfaces that need avatar_initials /
 *  avatar_color (login card grid). Keeps profileToMember lossless-enough
 *  for the rest of the app while still letting the login page style
 *  cards from the raw row. */
export async function listLoginableProfiles(): Promise<UserProfile[]> {
  if (!supabase) return []
  try {
    const { data, error } = await supabase.from('user_profiles').select('*')
    if (error) {
      console.warn('[Auth] Could not load profile list', error)
      return []
    }
    return ((data ?? []) as UserProfile[]).sort((a, b) => {
      if (a.role !== b.role) return a.role === 'pm' ? -1 : 1
      return a.display_name.localeCompare(b.display_name)
    })
  } catch (err) {
    console.warn('[Auth] listLoginableProfiles error', err)
    return []
  }
}

/** Replace every SETUP_REQUIRED hash with bcrypt(`${id}@auth`). Safe to call
 *  every app boot — no-op after the first run. Fire-and-forget. */
export async function seedDefaultPasswords(): Promise<void> {
  if (!supabase) return
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('id, password_hash')
      .eq('password_hash', SETUP_REQUIRED)
    if (error) {
      console.warn('[Auth] Seed lookup failed', error)
      return
    }
    const rows = (data ?? []) as Array<{ id: string; password_hash: string }>
    if (rows.length === 0) return
    for (const row of rows) {
      const newHash = await hashPassword(defaultPasswordFor(row.id))
      const { error: upErr } = await supabase
        .from('user_profiles')
        .update({
          password_hash: newHash,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .eq('password_hash', SETUP_REQUIRED) // race-safe: don't clobber a mid-flight first-login
      if (upErr) {
        console.warn(`[Auth] Seed failed for ${row.id}`, upErr)
      }
    }
    console.info(`[Auth] Default passwords seeded for ${rows.length} user(s)`)
  } catch (err) {
    console.warn('[Auth] seedDefaultPasswords error', err)
  }
}
