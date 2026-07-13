import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { KeyRound, LogOut, Settings as SettingsIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Avatar } from '@/components/shared/Avatar'
import { useAuth } from '@/data/auth'
import type { TeamMember } from '@/data/types'
import { cn } from '@/lib/utils'

export function UserMenu() {
  const { currentUser, logout } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      const target = e.target as Node
      if (
        menuRef.current?.contains(target) ||
        buttonRef.current?.contains(target)
      ) {
        return
      }
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!currentUser) return null

  async function handleLogout() {
    setBusy(true)
    setOpen(false)
    try {
      await logout()
      toast.success('Logged out.')
    } finally {
      setBusy(false)
      navigate('/login', { replace: true })
    }
  }

  function handleSettings() {
    setOpen(false)
    navigate('/settings')
  }

  function handleChangePassword() {
    setOpen(false)
    // #password anchors to the ChangePasswordSection heading — the
    // SettingsPage scrolls it into view on mount.
    navigate('/settings#password')
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${currentUser.name}`}
        className={cn(
          'ml-1 inline-flex h-11 w-11 items-center justify-center rounded-full focus-visible:outline-none md:ml-2 md:h-8 md:w-8',
          'ring-offset-2 ring-offset-[var(--bg-surface)] transition-shadow',
          open && 'ring-2 ring-[var(--accent-primary)]',
        )}
      >
        <Avatar
          name={currentUser.name}
          imageUrl={currentUser.avatarUrl}
          size="md"
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Account menu"
          className="absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[0_4px_16px_rgba(0,0,0,0.3)]"
        >
          <UserHeader user={currentUser} />
          <div className="h-px bg-[var(--border-subtle)]" />
          <MenuItem icon={SettingsIcon} label="Settings" onSelect={handleSettings} />
          <MenuItem
            icon={KeyRound}
            label="Change password"
            onSelect={handleChangePassword}
          />
          <div className="h-px bg-[var(--border-subtle)]" />
          <MenuItem
            icon={LogOut}
            label={busy ? 'Logging out…' : 'Log out'}
            onSelect={handleLogout}
            destructive
            disabled={busy}
          />
        </div>
      )}
    </div>
  )
}

function UserHeader({ user }: { user: TeamMember }) {
  return (
    <div className="flex items-center gap-3 px-3 py-3">
      <Avatar name={user.name} imageUrl={user.avatarUrl} size="md" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--text-primary)]">
          {user.name}
        </p>
        <p className="truncate text-xs text-[var(--text-secondary)]">
          {user.email}
        </p>
      </div>
      <span
        className={cn(
          'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.5px]',
          user.role === 'pm'
            ? 'bg-[var(--accent-primary)]/15 text-[var(--accent-primary)]'
            : 'bg-[var(--bg-surface)] text-[var(--text-secondary)]',
        )}
      >
        {user.role === 'pm' ? 'PM' : 'Member'}
      </span>
    </div>
  )
}

interface MenuItemProps {
  icon: typeof SettingsIcon
  label: string
  onSelect: () => void
  destructive?: boolean
  disabled?: boolean
}

function MenuItem({
  icon: Icon,
  label,
  onSelect,
  destructive = false,
  disabled = false,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors',
        'text-[var(--text-primary)] hover:bg-[var(--bg-surface)]',
        destructive && 'text-[var(--destructive)] hover:bg-[var(--destructive)]/10',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {label}
    </button>
  )
}
