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
import type { Task } from '@/data/types'

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

    return {
      memberProjectIds,
      currentUserId,
      canSeeAllProjects: isPM,
      canSeeProject,
      canSeeAllTasks: isPM,
      canSeeTask,
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
  }, [isPM, currentUserId, memberProjectIds])
}
