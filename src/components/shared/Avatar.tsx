import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/** Project-palette colors from the design brief — same set used for project dots. */
const AVATAR_COLORS = [
  '#3B82F6',
  '#22C55E',
  '#F59E0B',
  '#EF4444',
  '#A855F7',
  '#EC4899',
  '#14B8A6',
  '#F97316',
] as const

const SIZE_CLASSES: Record<AvatarSize, string> = {
  xs: 'h-5 w-5 text-[9px]',
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-sm',
  xl: 'h-20 w-20 text-2xl',
}

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

interface AvatarProps {
  name: string
  /** Uploaded photo URL. When present, renders an <img>; falls back to
   *  initials if the image fails to load or the URL is empty. */
  imageUrl?: string | null
  size?: AvatarSize
  className?: string
  /** Accessible label. When omitted, the avatar is treated as decorative. */
  title?: string
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

export function avatarColorFor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!
}

export function Avatar({
  name,
  imageUrl,
  size = 'md',
  className,
  title,
}: AvatarProps) {
  const initials = initialsFor(name)
  const bg = avatarColorFor(name)
  // Track image-load failure so we fall back to initials without a flash.
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [imageUrl])

  const showImage = Boolean(imageUrl) && !failed

  const shellClasses = cn(
    'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-semibold text-[var(--text-inverse)]',
    SIZE_CLASSES[size],
    className,
  )

  return (
    <span
      className={shellClasses}
      style={{ backgroundColor: bg }}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {/* Initials are always rendered underneath as a paint-in placeholder
          so nothing flashes while the image is decoding, and they take
          over instantly on load failure. */}
      <span aria-hidden="true">{initials}</span>
      {showImage && (
        <img
          src={imageUrl!}
          alt=""
          aria-hidden="true"
          onError={() => setFailed(true)}
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </span>
  )
}
