import { Fragment, useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Eye,
  EyeOff,
  Pin,
  PinOff,
  Reply,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Avatar } from '@/components/shared/Avatar'
import { ConfirmModal } from '@/components/shared/ConfirmModal'
import { CommentInput } from '@/components/task-detail/CommentInput'
import { useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import { relativeTime } from '@/lib/date-utils'
import { cn } from '@/lib/utils'
import type {
  Activity,
  CommentLabel,
  Task,
  TeamMember,
} from '@/data/types'

interface CommentsTabProps {
  task: Task
  activities: Activity[]
  members: TeamMember[]
}

type FilterKey = 'all' | 'question' | 'decision' | 'blocker' | 'idea'

const FILTERS: Array<{ key: FilterKey; label: string; emoji: string }> = [
  { key: 'all', label: 'All', emoji: '💬' },
  { key: 'question', label: 'Questions', emoji: '❓' },
  { key: 'decision', label: 'Decisions', emoji: '✅' },
  { key: 'blocker', label: 'Blockers', emoji: '🚫' },
  { key: 'idea', label: 'Ideas', emoji: '💡' },
]

const LABEL_META: Record<
  CommentLabel,
  { icon: string; label: string; tone: string }
> = {
  note: { icon: '', label: '', tone: '' },
  question: {
    icon: '❓',
    label: 'Question',
    tone: 'var(--priority-medium)',
  },
  decision: {
    icon: '✅',
    label: 'Decision',
    tone: 'var(--status-done)',
  },
  blocker: {
    icon: '🚫',
    label: 'Blocker',
    tone: 'var(--priority-critical)',
  },
  idea: { icon: '💡', label: 'Idea', tone: 'var(--priority-high)' },
}

const PAGE_SIZE = 20
const REPLIES_COLLAPSED_VISIBLE = 2

export function CommentsTab({ task, activities, members }: CommentsTabProps) {
  const { currentUser, isPM } = useAuth()
  const {
    addComment,
    pinComment,
    unpinComment,
    setQuestionResolved,
    deleteCommentWithReplies,
  } = useData()
  const [filter, setFilter] = useState<FilterKey>('all')
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [expandedReplies, setExpandedReplies] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [confirmDelete, setConfirmDelete] = useState<Activity | null>(null)

  const memberById = useMemo(
    () => new Map(members.map((m) => [m.id, m])),
    [members],
  )

  const comments = useMemo(
    () => activities.filter((a) => a.type === 'comment'),
    [activities],
  )

  const topLevel = useMemo(() => {
    const all = comments
      .filter((c) => !c.parentCommentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    if (filter === 'all') return all
    return all.filter((c) => c.commentLabel === filter)
  }, [comments, filter])

  // Pinned section pulls from the FULL comment list (independent of filter)
  // so important context is always visible at the top.
  const pinned = useMemo(
    () =>
      comments
        .filter((c) => c.isPinned)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [comments],
  )

  const repliesByParent = useMemo(() => {
    const map = new Map<string, Activity[]>()
    for (const c of comments) {
      if (!c.parentCommentId) continue
      const list = map.get(c.parentCommentId) ?? []
      list.push(c)
      map.set(c.parentCommentId, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    }
    return map
  }, [comments])

  // Paginate: show the newest `visibleCount` top-level comments at the
  // bottom (timeline order); "Load earlier" reveals the older ones.
  const startIdx = Math.max(0, topLevel.length - visibleCount)
  const visibleTop = topLevel.slice(startIdx)
  const hasMore = startIdx > 0

  const handleSubmit = async (
    text: string,
    options: {
      mentions: string[]
      label: CommentLabel
      parentCommentId: string | null
    },
  ) => {
    try {
      await addComment(task.id, text, options)
      setReplyingTo(null)
    } catch {
      toast.error('Could not post comment.')
    }
  }

  const togglePin = async (comment: Activity) => {
    try {
      if (comment.isPinned) {
        await unpinComment(comment.id)
      } else {
        await pinComment(comment.id)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not pin.'
      if (message.includes('Pin limit')) {
        toast.error('Unpin a comment to pin another.')
      } else {
        toast.error(message)
      }
    }
  }

  const toggleResolved = async (comment: Activity) => {
    try {
      await setQuestionResolved(comment.id, !comment.resolved)
    } catch {
      toast.error('Could not update the question.')
    }
  }

  const handleDelete = async () => {
    if (!confirmDelete) return
    const id = confirmDelete.id
    setConfirmDelete(null)
    try {
      await deleteCommentWithReplies(id)
    } catch {
      toast.error('Could not delete the comment.')
    }
  }

  const toggleReplies = (id: string) => {
    setExpandedReplies((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const canModify = (comment: Activity) =>
    isPM || comment.actorId === currentUser?.id

  // ---- Empty + filter-no-match states ------------------------------------
  if (comments.length === 0) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 px-4 py-8 text-center">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            No comments yet. Start the conversation.
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Use 💬 for notes, ❓ for questions, ✅ for decisions.
          </p>
        </div>
        <CommentInput
          members={members}
          currentUser={currentUser}
          onSubmit={handleSubmit}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Filter row */}
      <div role="tablist" aria-label="Comment filter" className="flex flex-wrap gap-1">
        {FILTERS.map((f) => {
          const count =
            f.key === 'all'
              ? topLevel.length
              : comments.filter(
                  (c) =>
                    !c.parentCommentId && c.commentLabel === f.key,
                ).length
          if (f.key !== 'all' && count === 0) return null
          const active = filter === f.key
          return (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(f.key)}
              className={cn(
                'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
                active
                  ? 'border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_15%,transparent)] text-[var(--accent-primary)]'
                  : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              <span aria-hidden="true">{f.emoji}</span>
              {f.label}
              <span className="ml-0.5 text-[10px] tabular-nums text-[var(--text-muted)]">
                ({count})
              </span>
            </button>
          )
        })}
      </div>

      {/* Pinned section — always renders the full pinned list, ignoring
          the current filter. */}
      {pinned.length > 0 && (
        <section aria-label="Pinned comments" className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--text-muted)]">
            📌 Pinned ({pinned.length}/5)
          </p>
          <ol className="flex flex-col gap-2">
            {pinned.map((c) => (
              <li key={`pinned-${c.id}`}>
                <CommentCard
                  comment={c}
                  members={members}
                  memberById={memberById}
                  comments={comments}
                  variant="pinned"
                  canModify={canModify(c)}
                  onTogglePin={() => togglePin(c)}
                  onToggleResolved={() => toggleResolved(c)}
                  onDelete={() => setConfirmDelete(c)}
                  onReply={() => setReplyingTo(c.parentCommentId ?? c.id)}
                />
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Empty-result-for-filter — only show when there's data overall. */}
      {visibleTop.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 px-4 py-6 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            {filter === 'question'
              ? 'No questions on this task.'
              : `No ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} on this task.`}
          </p>
        </div>
      ) : (
        <>
          {hasMore && (
            <button
              type="button"
              onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
              className="mx-auto block rounded text-xs font-medium text-[var(--accent-primary)] transition-colors hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
            >
              Load earlier comments
            </button>
          )}
          <ol className="flex flex-col gap-3">
            {visibleTop.map((c) => {
              const replies = repliesByParent.get(c.id) ?? []
              const expanded = expandedReplies.has(c.id)
              const visibleReplies =
                expanded || replies.length <= REPLIES_COLLAPSED_VISIBLE
                  ? replies
                  : replies.slice(0, REPLIES_COLLAPSED_VISIBLE)
              const hiddenReplies = replies.length - visibleReplies.length
              return (
                <li key={c.id}>
                  <CommentCard
                    comment={c}
                    members={members}
                    memberById={memberById}
                    comments={comments}
                    variant="thread"
                    canModify={canModify(c)}
                    onTogglePin={() => togglePin(c)}
                    onToggleResolved={() => toggleResolved(c)}
                    onDelete={() => setConfirmDelete(c)}
                    onReply={() => setReplyingTo(c.id)}
                  />

                  {(replies.length > 0 || replyingTo === c.id) && (
                    <div className="ml-5 mt-2 space-y-2 border-l-2 border-[var(--border-subtle)] pl-3">
                      {visibleReplies.map((r) => (
                        <CommentCard
                          key={r.id}
                          comment={r}
                          members={members}
                          memberById={memberById}
                          comments={comments}
                          variant="reply"
                          canModify={canModify(r)}
                          onTogglePin={() => togglePin(r)}
                          onToggleResolved={() => toggleResolved(r)}
                          onDelete={() => setConfirmDelete(r)}
                          onReply={() => setReplyingTo(c.id)}
                        />
                      ))}

                      {hiddenReplies > 0 && !expanded && (
                        <button
                          type="button"
                          onClick={() => toggleReplies(c.id)}
                          className="inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--accent-primary)] hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
                        >
                          <ChevronDown className="h-3 w-3" aria-hidden="true" />
                          Show {hiddenReplies} more{' '}
                          {hiddenReplies === 1 ? 'reply' : 'replies'}
                        </button>
                      )}
                      {expanded && replies.length > REPLIES_COLLAPSED_VISIBLE && (
                        <button
                          type="button"
                          onClick={() => toggleReplies(c.id)}
                          className="inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
                        >
                          <ChevronRight className="h-3 w-3" aria-hidden="true" />
                          Collapse replies
                        </button>
                      )}

                      {replyingTo === c.id && (
                        <CommentInput
                          members={members}
                          currentUser={currentUser}
                          replyTo={c.id}
                          autoFocus
                          placeholder={`Reply to ${memberById.get(c.actorId)?.name ?? 'this comment'}…`}
                          onCancel={() => setReplyingTo(null)}
                          onSubmit={handleSubmit}
                        />
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        </>
      )}

      {/* Top-level new comment input — anchors the bottom of the feed. */}
      <CommentInput
        members={members}
        currentUser={currentUser}
        onSubmit={handleSubmit}
      />

      <ConfirmModal
        open={confirmDelete !== null}
        title={
          confirmDelete && (repliesByParent.get(confirmDelete.id)?.length ?? 0) > 0
            ? `Delete comment and ${repliesByParent.get(confirmDelete.id)!.length} replies?`
            : 'Delete comment?'
        }
        message={
          confirmDelete && (repliesByParent.get(confirmDelete.id)?.length ?? 0) > 0 ? (
            <>
              This comment has{' '}
              <strong className="text-[var(--text-primary)]">
                {repliesByParent.get(confirmDelete.id)!.length} replies
              </strong>
              . Delete all?
            </>
          ) : (
            'This cannot be undone.'
          )
        }
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

interface CommentCardProps {
  comment: Activity
  members: TeamMember[]
  memberById: Map<string, TeamMember>
  /** Full comment list — used to look up the parent for pinned replies. */
  comments: Activity[]
  variant: 'thread' | 'reply' | 'pinned'
  canModify: boolean
  onTogglePin: () => void
  onToggleResolved: () => void
  onDelete: () => void
  onReply: () => void
}

function CommentCard({
  comment,
  members,
  memberById,
  comments,
  variant,
  canModify,
  onTogglePin,
  onToggleResolved,
  onDelete,
  onReply,
}: CommentCardProps) {
  const author = memberById.get(comment.actorId)
  const authorName = author?.name ?? 'Someone'
  const pinnedBy = comment.pinnedBy ? memberById.get(comment.pinnedBy) : null
  const label = comment.commentLabel ?? 'note'
  const meta = label !== 'note' ? LABEL_META[label] : null
  const isPinnedSlot = variant === 'pinned'
  const isReply = variant === 'reply'

  const isQuestion = label === 'question'
  const resolved = isQuestion && comment.resolved === true

  const parentForPinnedReply =
    isPinnedSlot && comment.parentCommentId
      ? comments.find((c) => c.id === comment.parentCommentId)
      : null

  return (
    <article
      className={cn(
        'group/comment relative rounded-lg border bg-[var(--bg-surface)] transition-colors',
        // Label-colored left border for non-note comments. Inline-styled
        // via CSS var below so the actual color isn't hardcoded.
        meta ? 'border-[var(--border-subtle)] border-l-[3px]' : 'border-[var(--border-subtle)]',
        // Pinned cards in the Pinned section get a subtle blue wash.
        isPinnedSlot &&
          'bg-[color-mix(in_srgb,var(--accent-primary)_5%,var(--bg-surface))]',
        // Resolved questions dim slightly.
        resolved && 'opacity-70',
      )}
      style={meta ? { borderLeftColor: meta.tone } : undefined}
    >
      <div className="flex items-start gap-3 px-3 py-2.5 md:px-4">
        <Avatar name={authorName} imageUrl={author?.avatarUrl} size="sm" />
        <div className="min-w-0 flex-1">
          <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-[var(--text-primary)]">
              {authorName}
            </span>
            {meta && (
              <span
                className="inline-flex h-5 items-center rounded-full px-1.5 text-[10px] font-semibold"
                style={{
                  backgroundColor: `color-mix(in srgb, ${meta.tone} 15%, transparent)`,
                  color: meta.tone,
                }}
              >
                <span className="mr-0.5" aria-hidden="true">
                  {meta.icon}
                </span>
                {meta.label}
              </span>
            )}
            {resolved && (
              <span className="inline-flex h-5 items-center gap-0.5 rounded-full bg-[color-mix(in_srgb,var(--status-done)_15%,transparent)] px-1.5 text-[10px] font-semibold text-[var(--status-done)]">
                <Check className="h-3 w-3" aria-hidden="true" strokeWidth={3} />
                Resolved
              </span>
            )}
            {/* Pinned-in-feed badge — the second appearance of a pinned
                comment in its chronological slot. */}
            {!isPinnedSlot && comment.isPinned && (
              <span
                className="text-[10px] text-[var(--text-muted)]"
                title="Pinned"
              >
                📌 Pinned
              </span>
            )}
            <span className="text-xs text-[var(--text-muted)]">
              {relativeTime(comment.createdAt)}
            </span>
          </header>

          {/* In the Pinned section, a reply shows the parent it
              answered so the user has context. */}
          {parentForPinnedReply && (
            <p className="mt-1 inline-flex items-start gap-1 text-[11px] text-[var(--text-muted)]">
              <CornerDownRight
                className="mt-0.5 h-3 w-3 shrink-0"
                aria-hidden="true"
              />
              In reply to:{' '}
              <span className="italic">
                {parentForPinnedReply.content.slice(0, 80)}
                {parentForPinnedReply.content.length > 80 ? '…' : ''}
              </span>
            </p>
          )}

          <div className="mt-1 text-sm leading-relaxed text-[var(--text-primary)]">
            <CommentBody text={comment.content} members={members} />
          </div>

          {isPinnedSlot && pinnedBy && (
            <p className="mt-2 text-[11px] text-[var(--text-muted)]">
              Pinned by{' '}
              <span className="text-[var(--text-secondary)]">{pinnedBy.name}</span>
            </p>
          )}

          {/* Action row — hover-revealed in the thread; always visible
              in the pinned slot. */}
          <div
            className={cn(
              'mt-2 flex items-center gap-2',
              !isPinnedSlot &&
                'opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100',
            )}
          >
            {!isReply && (
              <ActionButton onClick={onReply}>
                <Reply className="h-3 w-3" aria-hidden="true" />
                Reply
              </ActionButton>
            )}
            {isQuestion && (
              <ActionButton onClick={onToggleResolved}>
                {resolved ? (
                  <>
                    <EyeOff className="h-3 w-3" aria-hidden="true" />
                    Unresolve
                  </>
                ) : (
                  <>
                    <Eye className="h-3 w-3" aria-hidden="true" />
                    Resolved?
                  </>
                )}
              </ActionButton>
            )}
            {canModify && (
              <ActionButton onClick={onTogglePin}>
                {comment.isPinned ? (
                  <>
                    <PinOff className="h-3 w-3" aria-hidden="true" />
                    Unpin
                  </>
                ) : (
                  <>
                    <Pin className="h-3 w-3" aria-hidden="true" />
                    Pin
                  </>
                )}
              </ActionButton>
            )}
            {canModify && (
              <ActionButton onClick={onDelete} destructive>
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Delete
              </ActionButton>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}

function ActionButton({
  onClick,
  destructive,
  children,
}: {
  onClick: () => void
  destructive?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
        destructive
          ? 'text-[var(--text-muted)] hover:bg-[color-mix(in_srgb,var(--destructive)_15%,transparent)] hover:text-[var(--destructive)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]',
      )}
    >
      {children}
    </button>
  )
}

// ---- Body renderer ---------------------------------------------------------

/** Plain-text + tiny markdown: `**bold**`, `` `code` ``, lines starting
 *  with `- ` render as bulleted. @mentions get highlighted. No HTML
 *  parsing, no `dangerouslySetInnerHTML` — every token is rendered as
 *  text content inside React elements. */
function CommentBody({ text, members }: { text: string; members: TeamMember[] }) {
  const handles = useMemo(() => {
    const m = new Map<string, TeamMember>()
    for (const member of members) {
      m.set(member.name.replace(/\s+/g, '').toLowerCase(), member)
    }
    return m
  }, [members])

  // Split by line first so we can pick up bullets.
  const lines = text.split('\n')

  return (
    <div className="whitespace-pre-wrap break-words">
      {lines.map((line, idx) => {
        const bullet = /^- (.*)$/.exec(line)
        if (bullet) {
          return (
            <div key={idx} className="flex gap-2">
              <span aria-hidden="true" className="text-[var(--text-muted)]">
                •
              </span>
              <span>{renderInline(bullet[1] ?? '', handles, members)}</span>
            </div>
          )
        }
        return (
          <Fragment key={idx}>
            {renderInline(line, handles, members)}
            {idx < lines.length - 1 ? '\n' : null}
          </Fragment>
        )
      })}
    </div>
  )
}

/** Render a single line with `**bold**`, `` `code` ``, and @mentions. */
function renderInline(
  line: string,
  handles: Map<string, TeamMember>,
  members: TeamMember[],
): React.ReactNode {
  // Tokenize: keep delimiters so we can wrap them. Order matters — match
  // bold first, then code, then mentions, then plain text.
  const tokens: React.ReactNode[] = []
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|@[A-Za-z][A-Za-z0-9_-]*)/g
  let cursor = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = regex.exec(line)) !== null) {
    if (match.index > cursor) {
      tokens.push(line.slice(cursor, match.index))
    }
    const matched = match[0]
    if (matched.startsWith('**')) {
      tokens.push(
        <strong key={key++} className="font-semibold text-[var(--text-primary)]">
          {matched.slice(2, -2)}
        </strong>,
      )
    } else if (matched.startsWith('`')) {
      tokens.push(
        <code
          key={key++}
          className="rounded bg-[var(--bg-elevated)] px-1 py-0.5 text-[12.5px] font-mono"
        >
          {matched.slice(1, -1)}
        </code>,
      )
    } else if (matched.startsWith('@')) {
      const handle = matched.slice(1).toLowerCase()
      const member = handles.get(handle)
      if (member) {
        tokens.push(
          <span
            key={key++}
            className="rounded bg-[color-mix(in_srgb,var(--accent-primary)_15%,transparent)] px-1 font-medium text-[var(--accent-primary)]"
          >
            @{member.name}
          </span>,
        )
      } else {
        // @mention of a member who no longer exists — gray it out so the
        // reader knows it doesn't notify anyone.
        tokens.push(
          <span key={key++} className="text-[var(--text-muted)]">
            {matched}
          </span>,
        )
      }
    }
    cursor = match.index + matched.length
  }
  if (cursor < line.length) {
    tokens.push(line.slice(cursor))
  }
  // Suppress the unused-`members` lint when the line has no special tokens.
  void members
  return tokens.length === 0 ? line : tokens
}
