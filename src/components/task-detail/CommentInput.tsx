import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { Avatar } from '@/components/shared/Avatar'
import { cn } from '@/lib/utils'
import type { CommentLabel, TeamMember } from '@/data/types'

interface CommentInputProps {
  members: TeamMember[]
  currentUser: TeamMember | null
  /** Optional parent — when set, the input renders compact and disables
   *  the label picker (replies don't get categorized). */
  replyTo?: string | null
  /** Auto-focus when mounted — used by the inline reply form. */
  autoFocus?: boolean
  /** Optional override placeholder. */
  placeholder?: string
  onCancel?: () => void
  onSubmit: (
    text: string,
    options: { mentions: string[]; label: CommentLabel; parentCommentId: string | null },
  ) => Promise<void>
}

interface MentionState {
  open: boolean
  query: string
  /** Start index of the "@..." token currently being typed. */
  tokenStart: number
}

const CLOSED: MentionState = { open: false, query: '', tokenStart: -1 }

interface LabelOption {
  value: CommentLabel
  icon: string
  text: string
  tone: string
}

const LABEL_OPTIONS: LabelOption[] = [
  { value: 'note', icon: '💬', text: 'Note', tone: 'var(--text-secondary)' },
  {
    value: 'question',
    icon: '❓',
    text: 'Question',
    tone: 'var(--priority-medium)',
  },
  {
    value: 'decision',
    icon: '✅',
    text: 'Decision',
    tone: 'var(--status-done)',
  },
  {
    value: 'blocker',
    icon: '🚫',
    text: 'Blocker',
    tone: 'var(--priority-critical)',
  },
  { value: 'idea', icon: '💡', text: 'Idea', tone: 'var(--priority-high)' },
]

export function CommentInput({
  members,
  currentUser,
  replyTo = null,
  autoFocus = false,
  placeholder,
  onCancel,
  onSubmit,
}: CommentInputProps) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [mention, setMention] = useState<MentionState>(CLOSED)
  const [highlight, setHighlight] = useState(0)
  const [focused, setFocused] = useState(false)
  const [label, setLabel] = useState<CommentLabel>('note')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isReply = replyTo !== null

  const filteredMembers = mention.open
    ? members.filter((m) =>
        m.name.toLowerCase().includes(mention.query.toLowerCase()),
      )
    : []

  useEffect(() => {
    setHighlight(0)
  }, [mention.query, mention.open])

  useEffect(() => {
    if (autoFocus) {
      queueMicrotask(() => textareaRef.current?.focus())
    }
  }, [autoFocus])

  const detectMention = (value: string, caret: number) => {
    let i = caret - 1
    while (i >= 0) {
      const ch = value[i]
      if (ch === '@') {
        const before = i > 0 ? value[i - 1] : ' '
        if (!before || /[\s\n([{,;:]/.test(before)) {
          setMention({
            open: true,
            query: value.slice(i + 1, caret),
            tokenStart: i,
          })
          return
        }
        setMention(CLOSED)
        return
      }
      if (ch === ' ' || ch === '\n') break
      i -= 1
    }
    setMention(CLOSED)
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setText(value)
    detectMention(value, e.target.selectionStart ?? value.length)
  }

  const selectMention = (member: TeamMember) => {
    if (mention.tokenStart < 0) return
    const before = text.slice(0, mention.tokenStart)
    const afterQuery = text.slice(mention.tokenStart + 1 + mention.query.length)
    const inserted = `@${member.name.replace(/\s+/g, '')}`
    const next = `${before}${inserted} ${afterQuery.trimStart() === afterQuery ? afterQuery : afterQuery}`
    setText(next)
    setMention(CLOSED)
    queueMicrotask(() => {
      const pos = before.length + inserted.length + 1
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  const resolveMentionIds = (value: string): string[] => {
    const ids = new Set<string>()
    const re = /@([A-Za-z][A-Za-z0-9_-]*)/g
    let match: RegExpExecArray | null
    while ((match = re.exec(value)) !== null) {
      const handle = match[1]?.toLowerCase()
      if (!handle) continue
      const member = members.find(
        (m) => m.name.replace(/\s+/g, '').toLowerCase() === handle,
      )
      if (member) ids.add(member.id)
    }
    return Array.from(ids)
  }

  const submit = async () => {
    const value = text.trim()
    if (!value || busy) return
    const mentions = resolveMentionIds(value)
    setBusy(true)
    try {
      await onSubmit(value, {
        mentions,
        label: isReply ? 'note' : label,
        parentCommentId: replyTo,
      })
      setText('')
      setLabel('note')
      setFocused(false)
    } finally {
      setBusy(false)
    }
  }

  /** Wrap the current selection (or insert a marker) with a delimiter
   *  string. Used by Ctrl+B / Ctrl+E inline formatting. */
  const wrapSelection = (delim: string) => {
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart ?? 0
    const end = el.selectionEnd ?? 0
    const before = text.slice(0, start)
    const middle = text.slice(start, end)
    const after = text.slice(end)
    const next = `${before}${delim}${middle}${delim}${after}`
    setText(next)
    queueMicrotask(() => {
      el.focus()
      // Put the caret inside the delimiters if no selection; after the
      // closing delimiter if there was one.
      const newStart = start + delim.length
      const newEnd = end + delim.length
      el.setSelectionRange(newStart, newEnd)
    })
  }

  /** Insert "- " at the start of the current line when the user types
   *  the second character of "- " — turns "- " into a bullet on next
   *  newline. We just keep it as text; rendering handles the bullet. */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.open && filteredMembers.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => (h + 1) % filteredMembers.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight(
          (h) => (h - 1 + filteredMembers.length) % filteredMembers.length,
        )
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const choice = filteredMembers[highlight]
        if (choice) {
          e.preventDefault()
          selectMention(choice)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(CLOSED)
        return
      }
    }

    // Ctrl/Cmd + B → wrap selection in **bold**
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault()
      wrapSelection('**')
      return
    }
    // Ctrl/Cmd + E → wrap selection in `code`
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
      e.preventDefault()
      wrapSelection('`')
      return
    }
    // Ctrl/Cmd + Enter submits (plain Enter creates a newline now that
    // the textarea expands).
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
      return
    }
    // Auto-bullet: pressing Enter on a line that's just `-` followed by
    // a space continues the bullet on the next line. Simple, predictable.
    if (e.key === 'Enter' && !e.shiftKey) {
      const el = textareaRef.current
      if (!el) return
      const caret = el.selectionStart ?? 0
      const lineStart = text.lastIndexOf('\n', caret - 1) + 1
      const currentLine = text.slice(lineStart, caret)
      if (/^- (?!\s*$).+/.test(currentLine)) {
        e.preventDefault()
        const before = text.slice(0, caret)
        const after = text.slice(caret)
        const insert = '\n- '
        setText(before + insert + after)
        queueMicrotask(() => {
          const pos = caret + insert.length
          el.focus()
          el.setSelectionRange(pos, pos)
        })
        return
      }
      // Pressing Enter on an empty bullet line ends the list.
      if (/^- \s*$/.test(currentLine)) {
        e.preventDefault()
        const before = text.slice(0, lineStart)
        const after = text.slice(caret)
        setText(before + after)
        queueMicrotask(() => {
          el.focus()
          el.setSelectionRange(lineStart, lineStart)
        })
        return
      }
    }
  }

  const expanded = focused || text.length > 0 || isReply
  const submitDisabled = busy || text.trim() === ''
  const selectedLabel = LABEL_OPTIONS.find((l) => l.value === label) ?? LABEL_OPTIONS[0]!

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className={cn(
        'relative flex items-start gap-2',
        isReply && 'pl-10',
      )}
    >
      {currentUser && !isReply && (
        <Avatar name={currentUser.name} imageUrl={currentUser.avatarUrl} size="sm" />
      )}
      <div className="relative min-w-0 flex-1">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            // Delay so a click on the mention list still selects.
            window.setTimeout(() => setMention(CLOSED), 100)
            if (text.length === 0) setFocused(false)
          }}
          rows={expanded ? Math.min(6, Math.max(2, text.split('\n').length)) : 1}
          placeholder={
            placeholder ?? (isReply ? 'Write a reply…' : 'Write a comment… (use @ to mention)')
          }
          className="block w-full resize-none rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-3 py-2 text-sm leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent-primary)] focus:ring-2 focus:ring-[var(--accent-focus)]"
        />

        {mention.open && filteredMembers.length > 0 && (
          <ul
            role="listbox"
            className="absolute left-0 top-full z-20 mt-1 max-h-48 w-full max-w-xs overflow-auto rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[0_4px_16px_rgba(0,0,0,0.3)]"
          >
            {filteredMembers.map((m, i) => (
              <li key={m.id}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    selectMention(m)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                    i === highlight
                      ? 'bg-[var(--bg-surface)] text-[var(--text-primary)]'
                      : 'text-[var(--text-primary)] hover:bg-[var(--bg-surface)]',
                  )}
                >
                  <Avatar name={m.name} imageUrl={m.avatarUrl} size="xs" />
                  <span className="flex-1 truncate">{m.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {expanded && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            {/* Label row — hidden for replies. */}
            {!isReply ? (
              <div role="radiogroup" aria-label="Comment type" className="flex flex-wrap gap-1">
                {LABEL_OPTIONS.map((opt) => {
                  const active = label === opt.value
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setLabel(opt.value)}
                      className={cn(
                        'inline-flex h-7 items-center gap-1 rounded-full border px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
                        active
                          ? 'border-transparent font-medium'
                          : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                      )}
                      style={
                        active
                          ? {
                              backgroundColor: `color-mix(in srgb, ${opt.tone} 18%, transparent)`,
                              color: opt.tone,
                            }
                          : undefined
                      }
                    >
                      <span aria-hidden="true">{opt.icon}</span>
                      {opt.text}
                    </button>
                  )
                })}
              </div>
            ) : (
              <span />
            )}

            <div className="flex shrink-0 items-center gap-1.5">
              {/* Helper hint about the formatting shortcuts — surfaces
                  Ctrl+B / Ctrl+E even on first use without a docs detour. */}
              <span className="hidden text-[10px] text-[var(--text-muted)] sm:inline">
                <kbd className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1">⌘B</kbd>{' '}
                bold ·{' '}
                <kbd className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1">⌘E</kbd>{' '}
                code ·{' '}
                <kbd className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1">⌘↵</kbd>{' '}
                send
              </span>
              {onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  className="inline-flex h-8 items-center rounded px-2 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
                >
                  Cancel
                </button>
              )}
              <button
                type="submit"
                disabled={submitDisabled}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-3 text-xs font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isReply ? (
                  'Reply'
                ) : (
                  <>
                    <Send className="h-3 w-3" aria-hidden="true" />
                    {selectedLabel.value === 'note'
                      ? 'Comment'
                      : `Post ${selectedLabel.text}`}
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </form>
  )
}

export type { CommentLabel }
