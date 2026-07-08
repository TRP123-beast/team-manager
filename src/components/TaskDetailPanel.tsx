import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Expand, FileQuestion, Lock, X } from 'lucide-react'
import { toast } from 'sonner'
import { ActivityCommentFeed } from '@/components/task-detail/ActivityCommentFeed'
import { AtlasMarkdown } from '@/components/atlas/AtlasMarkdown'
import { DescriptionEditor } from '@/components/task-detail/DescriptionEditor'
import { MeetingSourceBanner } from '@/components/task-detail/MeetingSourceBanner'
import { SubtaskSection } from '@/components/task-detail/SubtaskSection'
import { TagsSection } from '@/components/task-detail/TagsSection'
import { TaskHeader } from '@/components/task-detail/TaskHeader'
import { ConfirmModal } from '@/components/shared/ConfirmModal'
import { useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import { useTaskPanel } from '@/data/task-panel'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useIsReadOnly } from '@/hooks/useIsReadOnly'
import { cn } from '@/lib/utils'
import type { Priority, Subtask, TaskStatus } from '@/data/types'

const ANIMATION_MS = 220

/**
 * Slide-over task detail. Mounted once at the Layout level and driven
 * by `useTaskPanel()`. The DOM presence and the slide animation are
 * decoupled: `renderTaskId` controls mount/unmount; `visible` toggles
 * the CSS transform that animates in / out.
 *
 * Opening a different task while one is already open swaps the panel
 * content in place — no close-then-open animation — by leaving
 * `visible` at true and rotating `renderTaskId`.
 */
export function TaskDetailPanel() {
  const { openTaskId, closeTask } = useTaskPanel()
  const [renderTaskId, setRenderTaskId] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Mirror openTaskId → renderTaskId so the content swaps in-place when
  // the user picks a different task while the panel is already open.
  useEffect(() => {
    if (openTaskId !== null) setRenderTaskId(openTaskId)
  }, [openTaskId])

  // Drive the slide-in/out animation off the same signal.
  useEffect(() => {
    if (openTaskId !== null && renderTaskId !== null) {
      const r = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(r)
    }
    if (openTaskId === null && renderTaskId !== null) {
      setVisible(false)
      const t = window.setTimeout(() => setRenderTaskId(null), ANIMATION_MS)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [openTaskId, renderTaskId])

  useFocusTrap(containerRef, renderTaskId !== null && visible)

  if (renderTaskId === null) return null

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label="Task details"
    >
      <button
        type="button"
        aria-label="Close task details"
        onClick={closeTask}
        className={cn(
          'flex-1 cursor-default bg-black/40 transition-opacity duration-200 ease-out',
          visible ? 'opacity-100' : 'opacity-0',
        )}
      />
      <aside
        ref={containerRef}
        className={cn(
          'flex w-full flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[-4px_0_24px_rgba(0,0,0,0.3)]',
          'transition-transform ease-out',
          visible ? 'translate-x-0' : 'translate-x-full',
          'md:w-[520px]',
        )}
        style={{ transitionDuration: `${ANIMATION_MS}ms` }}
      >
        <PanelBody taskId={renderTaskId} onClose={closeTask} />
      </aside>
    </div>
  )
}

interface PanelBodyProps {
  taskId: string
  onClose: () => void
}

function PanelBody({ taskId, onClose }: PanelBodyProps) {
  const { currentUser, isPM } = useAuth()
  const {
    tasks,
    projects,
    teamMembers,
    tags,
    activities,
    sheetsRawRowsByTaskId,
    projectDataSources,
    updateTask,
    deleteTask,
    createSubtask,
    toggleSubtask,
    updateSubtask,
    deleteSubtask: removeSubtask,
    reorderSubtasks,
  } = useData()

  const task = tasks.find((t) => t.id === taskId)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const project = task ? projects.find((p) => p.id === task.projectId) : undefined
  const creator = task ? teamMembers.find((m) => m.id === task.createdBy) : undefined
  const taskActivities = useMemo(
    () => (task ? activities.filter((a) => a.taskId === task.id) : []),
    [activities, task],
  )

  const isAtlasManaged = useIsReadOnly('task', task?.id ?? '')

  if (!task) {
    return (
      <>
        <PanelChrome title="Task not found" taskId={taskId} onClose={onClose} />
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <FileQuestion
            className="h-10 w-10 text-[var(--text-muted)]"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <h2 className="mt-3 text-sm font-medium text-[var(--text-secondary)]">
            This task no longer exists.
          </h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            It may have been deleted or moved.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="mt-4 inline-flex h-9 items-center rounded-md bg-[var(--accent-primary)] px-4 text-sm font-medium text-[var(--text-inverse)] hover:bg-[var(--accent-hover)]"
          >
            Close
          </button>
        </div>
      </>
    )
  }

  const assignedToMe = currentUser?.id === task.assigneeId
  const canPMEdit = isPM
  const canMemberEdit = !isPM && assignedToMe
  const canEditTask = canPMEdit || canMemberEdit
  const sheetsRawRow = sheetsRawRowsByTaskId.get(task.id)
  const isSheetsManaged =
    sheetsRawRow !== undefined ||
    projectDataSources.some(
      (s) => s.projectId === task.projectId && s.source === 'google-sheets',
    )
  const isReadOnlySource = isAtlasManaged || isSheetsManaged
  const canEditTitle = canEditTask && !isReadOnlySource
  const canChangeAssignee = canPMEdit && !isReadOnlySource
  // Members can change priority on their OWN tasks — per RBAC spec,
  // priority is a self-managed field, not a management-only one.
  const canChangePriority = canEditTask && !isReadOnlySource
  const canChangeDueDate = canEditTask && !isReadOnlySource
  const canDeleteTask = canPMEdit && !isReadOnlySource

  // View-only banner: a Member has permission to SEE this task
  // (it's in one of their projects) but not to edit it, because it's
  // assigned to someone else. Communicates the "why" so disabled
  // controls don't read as broken.
  const assignee = task.assigneeId
    ? teamMembers.find((m) => m.id === task.assigneeId)
    : null
  const showViewOnlyBanner =
    !isPM && !assignedToMe && !isReadOnlySource

  const safeUpdate = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch {
      toast.error(`Could not save ${label}.`)
    }
  }

  const handleDelete = async () => {
    setConfirmOpen(false)
    try {
      await deleteTask(task.id)
      toast.success('Task deleted.')
      onClose()
    } catch {
      toast.error('Could not delete the task.')
    }
  }

  return (
    <>
      <PanelChrome
        title={task.title}
        taskId={task.id}
        onClose={onClose}
      />

      <div className="sticky top-[44px] z-10 -mt-px border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3">
        <TaskHeader
          task={task}
          project={project}
          members={teamMembers}
          creator={creator}
          canEditTitle={canEditTitle}
          canChangeStatus={canEditTask}
          canChangePriority={canChangePriority}
          canChangeAssignee={canChangeAssignee}
          canChangeDueDate={canChangeDueDate}
          canDelete={canDeleteTask}
          onUpdateTitle={(title) =>
            void safeUpdate('title', () => updateTask(task.id, { title }))
          }
          onChangeStatus={(status: TaskStatus) =>
            void safeUpdate('status', () => updateTask(task.id, { status }))
          }
          onChangePriority={(priority: Priority) =>
            void safeUpdate('priority', () => updateTask(task.id, { priority }))
          }
          onChangeAssignee={(assigneeId) =>
            void safeUpdate('assignee', () => updateTask(task.id, { assigneeId }))
          }
          onChangeDueDate={(dueDate) =>
            void safeUpdate('due date', () => updateTask(task.id, { dueDate }))
          }
          onDelete={() => setConfirmOpen(true)}
        />
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {showViewOnlyBanner && (
          <div
            className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 px-3 py-2 text-xs text-[var(--text-secondary)]"
            role="status"
          >
            <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              View only —{' '}
              {assignee
                ? <>assigned to <span className="font-medium text-[var(--text-primary)]">{assignee.name}</span></>
                : <>this task isn't assigned to you</>}
              . You can still add comments below.
            </span>
          </div>
        )}
        {task.sourceMeetingId && (
          <MeetingSourceBanner sourceMeetingId={task.sourceMeetingId} />
        )}

        {isReadOnlySource ? (
          <section
            aria-labelledby={`panel-desc-${task.id}`}
            className="space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/30 p-3"
          >
            <h2
              id={`panel-desc-${task.id}`}
              className="text-xs font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]"
            >
              Description
            </h2>
            {task.description ? (
              <AtlasMarkdown content={task.description} />
            ) : (
              <p className="text-sm text-[var(--text-muted)]">
                {isSheetsManaged
                  ? 'No description in spreadsheet.'
                  : 'No description available from Atlas.'}
              </p>
            )}
          </section>
        ) : (
          <DescriptionEditor
            value={task.description}
            canEdit={canEditTask}
            onSave={async (description) => {
              await updateTask(task.id, { description })
            }}
          />
        )}

        <SubtaskSection
          task={task}
          members={teamMembers}
          canAdd={canEditTask}
          canReorder={canEditTask}
          canToggle={(s: Subtask) =>
            canPMEdit || s.assigneeId === currentUser?.id || canMemberEdit
          }
          canEditTitle={() => canEditTask}
          canChangeAssignee={() => canPMEdit}
          canDelete={(s: Subtask) =>
            canPMEdit || s.assigneeId === currentUser?.id
          }
          onCreate={async (title) => {
            try {
              return await createSubtask(task.id, title)
            } catch {
              toast.error('Could not save subtask.')
              return null
            }
          }}
          onToggle={(subtaskId) =>
            safeUpdate('subtask', () => toggleSubtask(task.id, subtaskId))
          }
          onUpdateTitle={(subtaskId, title) =>
            safeUpdate('subtask', () =>
              updateSubtask(task.id, subtaskId, { title }),
            )
          }
          onChangeAssignee={(subtaskId, assigneeId) =>
            safeUpdate('subtask', () =>
              updateSubtask(task.id, subtaskId, { assigneeId }),
            )
          }
          onDelete={(subtaskId) =>
            safeUpdate('subtask', () => removeSubtask(task.id, subtaskId))
          }
          onReorder={(orderedIds) =>
            safeUpdate('subtask order', () =>
              reorderSubtasks(task.id, orderedIds),
            )
          }
          onMoveParentToDone={
            canEditTask
              ? () =>
                  void safeUpdate('status', () =>
                    updateTask(task.id, { status: 'done' }),
                  )
              : undefined
          }
        />

        <TagsSection
          selectedIds={task.tags}
          allTags={tags}
          canEdit={canPMEdit}
          onChange={(nextTags) =>
            void safeUpdate('tags', () => updateTask(task.id, { tags: nextTags }))
          }
        />

        <section aria-labelledby={`panel-activity-${task.id}`}>
          <h2
            id={`panel-activity-${task.id}`}
            className="mb-2 text-sm font-semibold text-[var(--text-primary)]"
          >
            Activity
          </h2>
          <ActivityCommentFeed
            task={task}
            activities={taskActivities}
            members={teamMembers}
          />
        </section>
      </div>

      <ConfirmModal
        open={confirmOpen}
        title="Delete task?"
        message={
          <>
            Delete{' '}
            <strong className="text-[var(--text-primary)]">{`'${task.title}'`}</strong>?
            This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  )
}

interface PanelChromeProps {
  title: string
  taskId: string
  onClose: () => void
}

function PanelChrome({ title, taskId, onClose }: PanelChromeProps) {
  return (
    <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close panel"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
      <h2
        className="min-w-0 flex-1 truncate text-[18px] font-semibold text-[var(--text-primary)]"
        title={title}
      >
        {title}
      </h2>
      <Link
        to={`/tasks/${encodeURIComponent(taskId)}`}
        aria-label="Open full page"
        title="Open full page"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
      >
        <Expand className="h-4 w-4" aria-hidden="true" />
      </Link>
    </header>
  )
}
