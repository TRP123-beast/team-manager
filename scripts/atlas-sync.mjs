#!/usr/bin/env node
/**
 * Server-side data sync — pulls from every upstream Team Manager
 * depends on and mirrors the results to Supabase so a browser landing
 * cold still has fresh data even if the upstream is unreachable.
 *
 * Intended to run on a cron / systemd timer every 10–15 minutes. The
 * client-side loaders remain the source of truth during a live session;
 * this script only maintains the redundancy layer.
 *
 * Required env:
 *   SUPABASE_URL              e.g. https://xxxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY service_role (NOT anon) — bypasses RLS
 *
 * Optional per-source env (missing → source is skipped, not fatal):
 *   ATLAS_BASE_URL            e.g. https://desktop-x.taila3a424.ts.net:8443/api/public
 *   ATLAS_TOKEN
 *   ZOOMBOT_URL               default https://bots.caimbrian.ai
 *   ZOOMBOT_USERNAME          Basic Auth user — required for transcript sync
 *   ZOOMBOT_PASSWORD          Basic Auth pass — required for transcript sync
 *
 * Transcripts + summaries live on the ZoomBot host at
 * `/api/transcripts` and reuse the ZoomBot Basic Auth credentials.
 * There is no separate transcript-store service.
 *
 * Exit codes:
 *   0  all sources ran (individual failures logged, not fatal)
 *   1  hard-required env missing (Supabase creds) or supabase unreachable
 */

import { createClient } from '@supabase/supabase-js'

// ── Env resolution ────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ATLAS_BASE_URL = process.env.ATLAS_BASE_URL
const ATLAS_TOKEN = process.env.ATLAS_TOKEN
const ZOOMBOT_URL = process.env.ZOOMBOT_URL || 'https://bots.caimbrian.ai'
const ZOOMBOT_USERNAME = process.env.ZOOMBOT_USERNAME
const ZOOMBOT_PASSWORD = process.env.ZOOMBOT_PASSWORD

function zoomBotAuthHeader() {
  if (!ZOOMBOT_USERNAME || !ZOOMBOT_PASSWORD) return null
  const encoded = Buffer.from(
    `${ZOOMBOT_USERNAME}:${ZOOMBOT_PASSWORD}`,
    'utf8',
  ).toString('base64')
  return `Basic ${encoded}`
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    '  FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.',
  )
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ── Small helpers ─────────────────────────────────────────────────
const nowIso = () => new Date().toISOString()
const timeout = (ms) => AbortSignal.timeout(ms)

async function safeJson(res) {
  try {
    return await res.json()
  } catch {
    return null
  }
}

// ── ZoomBot health check ──────────────────────────────────────────
async function checkZoomBot() {
  console.log('▸ ZoomBot health check')
  const auth = zoomBotAuthHeader()
  try {
    const headers = auth ? { Authorization: auth } : {}
    const res = await fetch(`${ZOOMBOT_URL}/api/state`, {
      headers,
      signal: timeout(5000),
    })
    console.log(
      `  ${ZOOMBOT_URL} → HTTP ${res.status}${
        res.status === 401
          ? ' (reachable, auth failed — check ZOOMBOT_USERNAME/PASSWORD)'
          : res.ok
            ? ' ✓'
            : ''
      }`,
    )
  } catch (e) {
    console.warn(`  ZoomBot unreachable: ${e.message}`)
  }
}

// ── Atlas sync ────────────────────────────────────────────────────
// Fetches the project list, then per-project tasks + manifests, and
// mirrors each snapshot into atlas_cache. Silently no-ops when Atlas
// isn't configured.
async function syncAtlas() {
  console.log('▸ Atlas sync')
  if (!ATLAS_BASE_URL || !ATLAS_TOKEN) {
    console.warn('  ATLAS_BASE_URL / ATLAS_TOKEN not set, skipping Atlas sync')
    return
  }

  const headers = {
    Authorization: `Bearer ${ATLAS_TOKEN}`,
    Accept: 'application/json',
  }

  let projects = []
  try {
    const res = await fetch(`${ATLAS_BASE_URL}/projects`, {
      headers,
      signal: timeout(15000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await safeJson(res)
    projects = Array.isArray(body?.data) ? body.data : []
    console.log(`  Projects: ${projects.length}`)
  } catch (e) {
    console.warn(`  Project list failed: ${e.message}`)
    return
  }

  let cachedCount = 0
  for (const project of projects) {
    const slug = project.slug || project.id
    if (!slug) continue

    try {
      const [tasksRes, manifestsRes] = await Promise.allSettled([
        fetch(`${ATLAS_BASE_URL}/projects/${slug}/tasks`, {
          headers,
          signal: timeout(15000),
        }),
        fetch(`${ATLAS_BASE_URL}/projects/${slug}/manifests`, {
          headers,
          signal: timeout(15000),
        }),
      ])

      const tasks =
        tasksRes.status === 'fulfilled' && tasksRes.value.ok
          ? (await safeJson(tasksRes.value))?.data ?? []
          : []
      const manifests =
        manifestsRes.status === 'fulfilled' && manifestsRes.value.ok
          ? (await safeJson(manifestsRes.value))?.data ?? []
          : []

      const { error } = await supabase
        .from('atlas_cache')
        .upsert(
          {
            project_slug: slug,
            tasks,
            manifests,
            fetched_at: nowIso(),
          },
          { onConflict: 'project_slug' },
        )
      if (error) throw error
      cachedCount++
    } catch (e) {
      console.warn(`  Project ${slug}: ${e.message}`)
    }
  }
  console.log(`  Cached ${cachedCount} project snapshots`)
}

// ── Transcript Store sync ─────────────────────────────────────────
async function syncTranscriptStore() {
  console.log('▸ Transcript sync (via ZoomBot host)')

  const auth = zoomBotAuthHeader()
  if (!auth) {
    console.warn(
      '  ZOOMBOT_USERNAME / ZOOMBOT_PASSWORD not set, skipping transcript sync',
    )
    return
  }
  const authHeaders = { Authorization: auth }

  // Fetch recent transcripts
  const response = await fetch(
    `${ZOOMBOT_URL}/api/transcripts?limit=50`,
    {
      headers: authHeaders,
      signal: AbortSignal.timeout(15000),
    },
  )

  const { data: transcripts, meta } = await response.json()
  console.log(
    `  Transcripts: ${meta.total} total, fetching ${transcripts.length} recent`,
  )

  // For each transcript with a summary, save meeting to Supabase
  let savedCount = 0
  for (const item of transcripts.filter((t) => t.has_summary)) {
    try {
      const detailResp = await fetch(
        `${ZOOMBOT_URL}/api/transcripts/${item.id}`,
        { headers: authHeaders },
      )
      const { data: detail } = await detailResp.json()

      if (detail) {
        const meetingDate =
          detail.meeting_date || detail.created_at.split('T')[0]

        await supabase.from('meetings').upsert(
          {
            source_manifest_id: `transcript-${item.id}`,
            project_id: detail.project || 'unassigned',
            title: extractTitleFromTranscript(detail),
            date: meetingDate,
            status: 'completed',
            location: 'Zoom (via ZoomBot)',
            notes: detail.summary || '',
            created_by: 'transcript-sync',
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'source_manifest_id' },
        )

        savedCount++
      }
    } catch (e) {
      console.warn(`  Transcript ${item.id}: ${e.message}`)
    }
  }
  console.log(`  Saved ${savedCount} meetings from transcripts`)
}

function extractTitleFromTranscript(detail) {
  // Try to get title from summary markdown heading
  if (detail.summary) {
    const headingMatch = detail.summary.match(/^#\s+(.+)$/m)
    if (headingMatch) return headingMatch[1]
  }
  // Parse from filename
  const parts = detail.filename.replace('.txt', '').split('_')
  // Remove room prefix and date/time suffix, keep participant names
  return `Meeting — ${detail.meeting_date || 'Unknown date'}`
}

// ── Orchestrator ──────────────────────────────────────────────────
async function sync() {
  const startedAt = Date.now()
  console.log(`\n=== atlas-sync @ ${nowIso()} ===`)

  await checkZoomBot()
  await syncAtlas()
  await syncTranscriptStore()

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`\n✓ Done in ${elapsed}s`)
}

// ── CLI entry ─────────────────────────────────────────────────────
sync().catch((err) => {
  console.error('\n✗ Sync failed:', err)
  process.exit(1)
})
