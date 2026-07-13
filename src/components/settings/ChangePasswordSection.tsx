import { useState, type FormEvent } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/data/auth'
import { cn } from '@/lib/utils'

const MIN_LENGTH = 8

export function ChangePasswordSection() {
  const { currentUser, changePassword } = useAuth()

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!currentUser) return null

  const nextTooShort = next.length > 0 && next.length < MIN_LENGTH
  const mismatch = confirm.length > 0 && next !== confirm
  const canSubmit =
    !submitting &&
    current.length > 0 &&
    next.length >= MIN_LENGTH &&
    confirm.length > 0 &&
    next === confirm

  const clearInputs = () => {
    setCurrent('')
    setNext('')
    setConfirm('')
  }

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    if (!canSubmit) return
    setSubmitting(true)
    const result = await changePassword(current, next)
    setSubmitting(false)
    if (!result.ok) {
      setError(result.error ?? 'Could not update password.')
      return
    }
    clearInputs()
    toast.success('Password updated successfully.')
  }

  return (
    <section aria-labelledby="password-heading">
      <h2
        id="password-heading"
        className="text-lg font-semibold text-[var(--text-primary)]"
      >
        Password
      </h2>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        Change your workspace password. Other signed-in devices will be logged
        out.
      </p>

      <form
        onSubmit={handleSubmit}
        className="mt-5 space-y-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 md:p-5"
        noValidate
      >
        <PasswordField
          id="pw-current"
          label="Current password"
          value={current}
          onChange={(v) => {
            setCurrent(v)
            if (error) setError(null)
          }}
          autoComplete="current-password"
          disabled={submitting}
        />
        <PasswordField
          id="pw-new"
          label="New password"
          value={next}
          onChange={(v) => {
            setNext(v)
            if (error) setError(null)
          }}
          autoComplete="new-password"
          disabled={submitting}
          invalid={nextTooShort}
          helper={
            nextTooShort
              ? `Must be at least ${MIN_LENGTH} characters.`
              : `At least ${MIN_LENGTH} characters.`
          }
        />
        <PasswordField
          id="pw-confirm"
          label="Confirm new password"
          value={confirm}
          onChange={(v) => {
            setConfirm(v)
            if (error) setError(null)
          }}
          autoComplete="new-password"
          disabled={submitting}
          invalid={mismatch}
          helper={mismatch ? "New passwords don't match." : undefined}
        />

        {error && (
          <p role="alert" className="text-xs text-[var(--destructive)]">
            {error}
          </p>
        )}

        <div>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-4 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Updating…
              </>
            ) : (
              <>
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                Update password
              </>
            )}
          </button>
        </div>
      </form>
    </section>
  )
}

interface PasswordFieldProps {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  autoComplete: 'current-password' | 'new-password'
  disabled?: boolean
  invalid?: boolean
  helper?: string
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  disabled,
  invalid = false,
  helper,
}: PasswordFieldProps) {
  const helperId = helper ? `${id}-help` : undefined
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-[11px] font-semibold uppercase tracking-[0.5px] text-[var(--text-secondary)]"
      >
        {label}
      </label>
      <input
        id={id}
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={helperId}
        className={cn(
          'mt-1 h-9 w-full rounded-md border bg-[var(--bg-input)] px-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]',
          'focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60',
          invalid
            ? 'border-[var(--destructive)] focus:border-[var(--destructive)] focus:ring-[var(--destructive)]/25'
            : 'border-[var(--border-subtle)] focus:border-[var(--accent-primary)] focus:ring-[var(--accent-focus)]',
        )}
      />
      {helper && (
        <p
          id={helperId}
          className={cn(
            'mt-1 text-xs',
            invalid ? 'text-[var(--destructive)]' : 'text-[var(--text-muted)]',
          )}
        >
          {helper}
        </p>
      )}
    </div>
  )
}
