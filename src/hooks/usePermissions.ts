/**
 * Role-based access control for the app.
 *
 * The rules:
 *   - PM sees and can do everything.
 *   - Member sees a project only if they have at least one task assigned
 *     in it. Within a visible project they can read every task (for
 *     context — "who's doing what") but can only EDIT their own tasks.
 *     Comments are open on any task in a visible project.
 *
 * The set of "member project ids" is derived from `tasks` — a task
 * assigned to the current user pulls its project into the visible set.
 * Reassigning the last task in a project silently revokes access on
 * next data refresh, which is exactly what we want.
 *
 * Every predicate is stable across renders when its inputs don't
 * change, so the returned object is safe to pass into memo dependency
 * arrays.
 */

import { useMemo } from 'react'
import { useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import type { Meeting, Task } from '@/data/types'

export interface Permissions {
  /** Non-null iff the current user is a Member — the set of project ids
   *  they can see. PM callers can inspect this as `null` to shortcut
   *  filter passes. */
  memberProjectIds: ReadonlySet<string> | null
  /** The current user's id, or `null` when logged out. Exposed so
   *  callers can filter without also having to import useAuth. */
  currentUserId: string | null

  // ── What the current user can SEE ──────────────────────────────────
  canSeeAllProjects: boolean
  canSeeProject: (projectId: string) => boolean
  canSeeAllTasks: boolean
  canSeeTask: (task: Task) => boolean
  /** Meetings are gated by attendance, not project membership. PM
   *  sees everything. Members see a meeting iff they're on its
   *  attendee list (matched by id, name substring, or lowercase alias)
   *  OR they have an action item assigned. Meetings without an
   *  attendee list stay hidden from members — encourages proper
   *  attendee tracking. */
  canSeeMeeting: (meeting: Meeting) => boolean

  // ── What the current user can DO ───────────────────────────────────
  canEditTask: (task: Task) => boolean
  canCommentOnTask: (task: Task) => boolean
  canCreateTask: (projectId: string) => boolean
  canManageProject: boolean
  canManageTeam: boolean
  canChangeAssignee: (task: Task) => boolean
  canChangePriority: (task: Task) => boolean
}

export function usePermissions(): Permissions {
  const { currentUser, isPM } = useAuth()
  const { tasks } = useData()
  const currentUserId = currentUser?.id ?? null
  const currentUserName = currentUser?.name ?? null

  // The set of project ids the current member can access. PM gets
  // `null` so downstream can shortcut with a truthy check.
  const memberProjectIds = useMemo<ReadonlySet<string> | null>(() => {
    if (isPM) return null
    if (!currentUserId) return new Set()
    const ids = new Set<string>()
    for (const t of tasks) {
      if (t.assigneeId === currentUserId) ids.add(t.projectId)
    }
    return ids
  }, [isPM, currentUserId, tasks])

  return useMemo<Permissions>(() => {
    const canSeeProject = (projectId: string): boolean =>
      isPM || memberProjectIds?.has(projectId) === true
    const canSeeTask = (task: Task): boolean =>
      isPM ||
      task.assigneeId === currentUserId ||
      memberProjectIds?.has(task.projectId) === true
    const canEditTask = (task: Task): boolean =>
      isPM || task.assigneeId === currentUserId
    const canCommentOnTask = (task: Task): boolean =>
      isPM || memberProjectIds?.has(task.projectId) === true
    const canCreateTask = (projectId: string): boolean =>
      isPM || memberProjectIds?.has(projectId) === true
    const canChangePriority = (task: Task): boolean =>
      isPM || task.assigneeId === currentUserId

    // Membership in a meeting's attendee list. Meetings ingested from
    // ZoomBot / transcripts often carry attendees as free-form names
    // (parsed from filenames), so we accept an id match, a full-name
    // match, or a substring match either way.
    const canSeeMeeting = (meeting: Meeting): boolean => {
      if (isPM) return true
      if (!currentUserId) return false
      const attendees = meeting.attendeeIds ?? []
      // No attendee list at all → hide from Members; there's no way
      // to verify they attended, and this nudges the ingest side to
      // populate the list going forward.
      if (attendees.length === 0) return false
      const uid = currentUserId.toLowerCase()
      const uname = currentUserName?.toLowerCase() ?? ''
      const inAttendees = attendees.some((a) => {
        const lower = a.toLowerCase()
        if (lower === uid) return true
        if (uname && lower === uname) return true
        if (uname && (lower.includes(uname) || uname.includes(lower))) return true
        if (lower.includes(uid) || uid.includes(lower)) return true
        return false
      })
      if (inAttendees) return true
      // Action-item fallback: even if the attendee list missed them,
      // an item explicitly assigned to them means they were part of
      // the meeting.
      return (meeting.actionItems ?? []).some(
        (item) => item.assigneeId?.toLowerCase() === uid,
      )
    }

    return {
      memberProjectIds,
      currentUserId,
      canSeeAllProjects: isPM,
      canSeeProject,
      canSeeAllTasks: isPM,
      canSeeTask,
      canSeeMeeting,
      canEditTask,
      canCommentOnTask,
      canCreateTask,
      canManageProject: isPM,
      canManageTeam: isPM,
      // Only PMs can reassign — even a member editing their own task
      // can't hand it off. That's a management action.
      canChangeAssignee: () => isPM,
      canChangePriority,
    }
  }, [isPM, currentUserId, currentUserName, memberProjectIds])
}
