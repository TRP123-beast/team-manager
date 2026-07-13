/**
 * Profile photo upload against Supabase Storage.
 *
 * Bucket: `avatars` (must be public — see the setup SQL in the README /
 * settings walkthrough).
 *
 * Flow:
 *   uploadAvatar(userId, File) →
 *     validate size + mime →
 *     compressImage → 200×200 WebP @ 85% quality →
 *     upload to `${userId}-${Date.now()}.webp` →
 *     read public URL →
 *     delete previous file (best-effort) →
 *     write `user_profiles.avatar_url`.
 *
 * removeAvatar(userId) mirrors that: delete the storage file, null the
 * column.
 */

import { supabase } from './supabase'

const MAX_SIZE_BYTES = 2 * 1024 * 1024
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const MAX_DIM = 200
const WEBP_QUALITY = 0.85

function assertClient() {
  if (!supabase) {
    throw new Error('Supabase is not configured.')
  }
  return supabase
}

export interface AvatarValidationError extends Error {
  code: 'too-large' | 'bad-type'
}

function validationError(
  message: string,
  code: AvatarValidationError['code'],
): AvatarValidationError {
  const err = new Error(message) as AvatarValidationError
  err.code = code
  return err
}

/** Compress + resize an image file into a WebP blob at most MAX_DIM on
 *  the long side. Runs entirely in-browser via a canvas. */
export function compressImage(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (width === 0 || height === 0) {
        reject(new Error('Image has zero dimensions.'))
        return
      }
      if (width > height) {
        if (width > MAX_DIM) {
          height = (height * MAX_DIM) / width
          width = MAX_DIM
        }
      } else {
        if (height > MAX_DIM) {
          width = (width * MAX_DIM) / height
          height = MAX_DIM
        }
      }
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(width)
      canvas.height = Math.round(height)
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas 2D context unavailable.'))
        return
      }
      // White background so transparent PNGs don't render black in
      // browsers that treat WebP alpha oddly.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Compression failed.'))
            return
          }
          resolve(blob)
        },
        'image/webp',
        WEBP_QUALITY,
      )
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read the selected image.'))
    }
    img.src = url
  })
}

/** Extract the storage object key from a public Supabase URL. Returns
 *  null when the URL doesn't look like one of ours. */
function keyFromPublicUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const marker = '/avatars/'
    const idx = url.indexOf(marker)
    if (idx === -1) return null
    return url.slice(idx + marker.length)
  } catch {
    return null
  }
}

export async function uploadAvatar(
  userId: string,
  file: File,
): Promise<string> {
  const client = assertClient()

  if (file.size > MAX_SIZE_BYTES) {
    throw validationError('Photo must be under 2 MB.', 'too-large')
  }
  if (!ALLOWED_MIME.includes(file.type)) {
    throw validationError('Use JPG, PNG, WebP, or GIF.', 'bad-type')
  }

  const compressed = await compressImage(file)
  const filename = `${userId}-${Date.now()}.webp`

  const { error: upErr } = await client.storage
    .from('avatars')
    .upload(filename, compressed, {
      contentType: 'image/webp',
      upsert: false,
      cacheControl: '31536000',
    })
  if (upErr) {
    console.error('[Avatar] upload failed', upErr)
    throw new Error(upErr.message || 'Upload failed.')
  }

  const { data: urlData } = client.storage.from('avatars').getPublicUrl(filename)
  const publicUrl = urlData?.publicUrl
  if (!publicUrl) {
    throw new Error('Could not resolve public URL for uploaded avatar.')
  }

  // Best-effort cleanup of the previous file. Runs before the DB update
  // so we don't leak orphans if the update succeeds and something later
  // tries to reconcile.
  try {
    const { data: prev } = await client
      .from('user_profiles')
      .select('avatar_url')
      .eq('id', userId)
      .maybeSingle()
    const oldKey = keyFromPublicUrl(
      (prev as { avatar_url?: string | null } | null)?.avatar_url,
    )
    if (oldKey && oldKey !== filename) {
      await client.storage.from('avatars').remove([oldKey])
    }
  } catch (err) {
    console.warn('[Avatar] previous-file cleanup failed', err)
  }

  const { error: dbErr } = await client
    .from('user_profiles')
    .update({ avatar_url: publicUrl, updated_at: new Date().toISOString() })
    .eq('id', userId)
  if (dbErr) {
    console.error('[Avatar] profile update failed', dbErr)
    throw new Error('Photo uploaded but profile update failed. Try again.')
  }

  return publicUrl
}

export async function removeAvatar(userId: string): Promise<void> {
  const client = assertClient()
  try {
    const { data: prev } = await client
      .from('user_profiles')
      .select('avatar_url')
      .eq('id', userId)
      .maybeSingle()
    const key = keyFromPublicUrl(
      (prev as { avatar_url?: string | null } | null)?.avatar_url,
    )
    if (key) {
      const { error } = await client.storage.from('avatars').remove([key])
      if (error) console.warn('[Avatar] remove object failed', error)
    }
  } catch (err) {
    console.warn('[Avatar] previous-file lookup failed', err)
  }

  const { error: dbErr } = await client
    .from('user_profiles')
    .update({ avatar_url: null, updated_at: new Date().toISOString() })
    .eq('id', userId)
  if (dbErr) {
    console.error('[Avatar] profile null-update failed', dbErr)
    throw new Error('Could not remove photo. Try again.')
  }
}

export function isAllowedAvatarFile(file: File): {
  ok: boolean
  error?: string
} {
  if (!ALLOWED_MIME.includes(file.type)) {
    return { ok: false, error: 'Use JPG, PNG, WebP, or GIF.' }
  }
  if (file.size > MAX_SIZE_BYTES) {
    return { ok: false, error: 'Photo must be under 2 MB.' }
  }
  return { ok: true }
}
