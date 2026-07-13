import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Loader2, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Avatar } from '@/components/shared/Avatar'
import { useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import {
  isAllowedAvatarFile,
  removeAvatar,
  uploadAvatar,
} from '@/services/avatar-service'
import { cn } from '@/lib/utils'

/** Profile photo controls. Sits at the top of the Account card. */
export function ProfilePhotoSection() {
  const { currentUser, updateCurrentUser } = useAuth()
  const { updateTeamMember } = useData()

  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Revoke object URLs when the preview closes.
  useEffect(() => {
    if (pendingUrl) return
    return () => {
      // no-op when no active URL
    }
  }, [pendingUrl])

  useEffect(() => {
    return () => {
      if (pendingUrl) URL.revokeObjectURL(pendingUrl)
    }
  }, [pendingUrl])

  if (!currentUser) return null

  const handleFile = useCallback((file: File) => {
    setError(null)
    const check = isAllowedAvatarFile(file)
    if (!check.ok) {
      setError(check.error ?? 'Invalid file.')
      return
    }
    if (pendingUrl) URL.revokeObjectURL(pendingUrl)
    setPendingFile(file)
    setPendingUrl(URL.createObjectURL(file))
  }, [pendingUrl])

  const openFilePicker = () => fileInputRef.current?.click()

  const cancelPreview = () => {
    if (pendingUrl) URL.revokeObjectURL(pendingUrl)
    setPendingFile(null)
    setPendingUrl(null)
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const doUpload = async () => {
    if (!pendingFile || uploading) return
    setUploading(true)
    setError(null)
    try {
      const url = await uploadAvatar(currentUser.id, pendingFile)
      // Bust any lingering <img> cache with a query hash so nothing else
      // in the app renders the old file.
      const cacheBusted = `${url}?v=${Date.now()}`
      updateCurrentUser({ avatarUrl: cacheBusted })
      // Best-effort: also mirror it into the team members store so the
      // user's photo lights up in places that render OTHER members.
      try {
        await updateTeamMember(currentUser.id, { avatarUrl: cacheBusted })
      } catch {
        // Not fatal — currentUser mutation is the source of truth here.
      }
      toast.success('Profile photo updated.')
      cancelPreview()
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Upload failed. Try again.'
      setError(message)
    } finally {
      setUploading(false)
    }
  }

  const doRemove = async () => {
    if (removing) return
    setRemoving(true)
    setError(null)
    try {
      await removeAvatar(currentUser.id)
      updateCurrentUser({ avatarUrl: null })
      try {
        await updateTeamMember(currentUser.id, { avatarUrl: null })
      } catch {
        // Not fatal.
      }
      toast.success('Profile photo removed.')
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not remove photo.'
      setError(message)
    } finally {
      setRemoving(false)
      setConfirmRemove(false)
    }
  }

  // ── Drag-and-drop on the avatar ─────────────────────────────────────
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      setDragActive(true)
    }
  }
  const onDragLeave = () => setDragActive(false)
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  const hasPhoto = Boolean(currentUser.avatarUrl)

  return (
    <div>
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={openFilePicker}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          aria-label="Change profile photo"
          className={cn(
            'relative shrink-0 rounded-full outline-none transition-shadow',
            'focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]',
            dragActive &&
              'ring-4 ring-[var(--accent-primary)] ring-offset-2 ring-offset-[var(--bg-surface)]',
          )}
        >
          <Avatar
            name={currentUser.name}
            imageUrl={currentUser.avatarUrl}
            size="xl"
          />
          <span
            className={cn(
              'pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-[10px] font-medium uppercase tracking-[0.5px] text-white opacity-0 transition-opacity',
              dragActive ? 'opacity-100' : 'group-hover:opacity-100',
            )}
          >
            {dragActive ? 'Drop to upload' : ''}
          </span>
        </button>

        <div className="min-w-0 flex-1">
          <p className="text-base font-medium text-[var(--text-primary)]">
            {currentUser.name}
          </p>
          <p className="text-xs uppercase tracking-[0.5px] text-[var(--text-secondary)]">
            {currentUser.role === 'pm' ? 'Project Manager' : 'Team member'}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={openFilePicker}
              disabled={uploading}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-3 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Camera className="h-3.5 w-3.5" aria-hidden="true" />
              Upload photo
            </button>
            {hasPhoto && !confirmRemove && (
              <button
                type="button"
                onClick={() => setConfirmRemove(true)}
                disabled={removing || uploading}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-default)] bg-transparent px-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Remove
              </button>
            )}
          </div>

          {hasPhoto && confirmRemove && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 p-2 text-xs text-[var(--text-secondary)]">
              <span>Remove your profile photo?</span>
              <button
                type="button"
                onClick={doRemove}
                disabled={removing}
                className="inline-flex h-7 items-center gap-1 rounded-md bg-[var(--destructive)] px-2.5 text-xs font-medium text-white transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--destructive)]/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {removing ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    Removing…
                  </>
                ) : (
                  'Yes, remove'
                )}
              </button>
              <button
                type="button"
                onClick={() => setConfirmRemove(false)}
                disabled={removing}
                className="inline-flex h-7 items-center rounded-md border border-[var(--border-default)] px-2.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)]"
              >
                Cancel
              </button>
            </div>
          )}

          <p className="mt-2 text-xs text-[var(--text-muted)]">
            JPG, PNG, WebP or GIF · under 2 MB · drop onto the avatar to upload
          </p>
          {error && !pendingUrl && (
            <p role="alert" className="mt-1 text-xs text-[var(--destructive)]">
              {error}
            </p>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
          // Allow re-picking the same file after cancel.
          if (fileInputRef.current) fileInputRef.current.value = ''
        }}
      />

      {pendingUrl && pendingFile && (
        <PreviewModal
          fileName={pendingFile.name}
          imageUrl={pendingUrl}
          uploading={uploading}
          error={error}
          onCancel={cancelPreview}
          onConfirm={doUpload}
        />
      )}
    </div>
  )
}

interface PreviewModalProps {
  fileName: string
  imageUrl: string
  uploading: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

function PreviewModal({
  fileName,
  imageUrl,
  uploading,
  error,
  onCancel,
  onConfirm,
}: PreviewModalProps) {
  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !uploading) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel, uploading])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-heading"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 px-4 py-6"
      style={{ animation: 'fadeIn 150ms ease-out' }}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-5 shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
        style={{ animation: 'modalIn 180ms ease-out' }}
      >
        <div className="flex items-start justify-between gap-3">
          <h3
            id="preview-heading"
            className="text-base font-semibold text-[var(--text-primary)]"
          >
            Preview
          </h3>
          <button
            type="button"
            onClick={onCancel}
            disabled={uploading}
            className="rounded-md p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Close preview"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-4 flex justify-center">
          <img
            src={imageUrl}
            alt={`Preview of ${fileName}`}
            className="h-32 w-32 rounded-full border-4 border-[var(--bg-elevated)] object-cover shadow-md"
          />
        </div>

        <p className="mt-3 truncate text-center text-xs text-[var(--text-muted)]">
          {fileName}
        </p>

        {error && (
          <p role="alert" className="mt-3 text-center text-xs text-[var(--destructive)]">
            {error}
          </p>
        )}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={uploading}
            className="inline-flex h-9 flex-1 items-center justify-center rounded-md border border-[var(--border-default)] bg-transparent px-4 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={uploading}
            className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-4 text-sm font-medium text-[var(--text-inverse)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-focus)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Uploading…
              </>
            ) : (
              <>
                <Upload className="h-4 w-4" aria-hidden="true" />
                Upload
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
