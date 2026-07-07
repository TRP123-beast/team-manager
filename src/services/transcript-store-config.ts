/**
 * Transcript endpoint resolution.
 *
 * Transcripts and post-meeting summaries are served by the same host
 * as ZoomBot's audio/video — `bots.caimbrian.ai/api/transcripts` —
 * behind the same HTTP Basic Auth. This module used to point at a
 * separate `ingest.caimbrian.ai` service with a Bearer token; that
 * turned out to be a misunderstanding of the deployment.
 *
 * Rather than delete the file (call sites already import from it), we
 * keep it as a thin adapter over the ZoomBot config so there's a
 * single source of truth for URL + credentials. `getTranscriptStoreConfig()`
 * still returns a `{ baseUrl }` and `isTranscriptStoreConfigured()` still
 * exists — they just read from ZoomBot state internally.
 *
 * If the transcript endpoint is ever split out to its own host, expand
 * this to read separate env vars again.
 */

import {
  getZoomBotConfig,
  isZoomBotConfigured,
} from './zoombot-config'

export interface TranscriptStoreConfig {
  /** ZoomBot host — transcripts live under `/api/transcripts` here. */
  baseUrl: string
}

export function getTranscriptStoreConfig(): TranscriptStoreConfig {
  return { baseUrl: getZoomBotConfig().baseUrl }
}

/**
 * Kept as a no-op for backwards compatibility with the earlier UI
 * that let PMs paste a token here. All configuration now flows through
 * the ZoomBot section — Settings → ZoomBot.
 */
export function setTranscriptStoreConfig(
  _url: string | null,
  _token: string | null,
): void {
  // No-op — see module docblock.
}

/**
 * True iff ZoomBot is configured (URL + Basic Auth credentials). The
 * transcript endpoint shares that gate.
 */
export function isTranscriptStoreConfigured(): boolean {
  return isZoomBotConfigured()
}
