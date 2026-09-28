import fs from 'fs';
import path from 'path';
import { fetchT } from './fetchWithTimeout.js';
import { guardedFetch } from './ssrfGuard.js';
import { listObjects, deleteObjectKey } from './objectStore.js';

const JANUS_VOICE_ID = 'iLVmqjzCGGvqtMCk6vVQ';
const VOICE_REPLIES_BUCKET = 'voice-replies';
const BROADCAST_SUBDIR = 'broadcasts';
const MAX_BROADCAST_FILES = 5;

/**
 * Delete the oldest MP3 files in `dir` whose names start with `prefix`,
 * keeping only the `keep` most-recent ones (sorted by mtime, not filename).
 * Scoping by prefix means school-morning-* and google-home-* files are managed
 * in separate pools so a new google-home file is never evicted by school-morning
 * cleanup or vice-versa.
 */
async function cleanupOldBroadcasts(
  bucket: string,
  subdir: string,
  filePrefix: string,
  keep: number,
): Promise<void> {
  const dirs = [
    path.join(process.cwd(), 'public', bucket, subdir),
    path.join(process.cwd(), 'dist', 'public', bucket, subdir),
  ];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const matched = entries.filter(
        (e) => e.isFile() && e.name.startsWith(filePrefix) && e.name.endsWith('.mp3'),
      );
      // Sort by mtime descending (newest first) so we keep the freshest files
      const withMtime = await Promise.all(
        matched.map(async (e) => {
          const mtime = await fs.promises
            .stat(path.join(dir, e.name))
            .then((s) => s.mtimeMs)
            .catch(() => 0);
          return { name: e.name, mtime };
        }),
      );
      withMtime.sort((a, b) => b.mtime - a.mtime);
      for (const f of withMtime.slice(keep)) {
        await fs.promises.unlink(path.join(dir, f.name)).catch(() => {});
        console.log(`[castBroadcast] Cleaned up old broadcast file: ${f.name}`);
      }
    } catch {
      // best-effort local cleanup; ignore failures
    }
  }

  // Also evict old objects from durable storage (the source of truth). Filenames
  // embed a millisecond timestamp (`${prefix}-${ts}.mp3`), so sort by that rather
  // than relying on object metadata.
  try {
    const objKeys = await listObjects(VOICE_REPLIES_BUCKET, `${subdir}/`);
    const matched = objKeys
      .map((key) => ({ key, base: key.split('/').pop() ?? '' }))
      .filter((o) => o.base.startsWith(filePrefix) && o.base.endsWith('.mp3'))
      .map((o) => {
        const m = o.base.match(/-(\d+)\.mp3$/);
        return { key: o.key, ts: m ? Number(m[1]) : 0 };
      })
      .sort((a, b) => b.ts - a.ts);
    for (const o of matched.slice(keep)) {
      await deleteObjectKey(o.key);
      console.log(`[castBroadcast] Cleaned up old broadcast object: ${o.key}`);
    }
  } catch {
    // best-effort durable cleanup; ignore failures
  }
}

/**
 * Generate TTS via ElevenLabs and upload the MP3 to local storage-compat with a
 * timestamped filename so the URL ends cleanly in .mp3 (no query string).
 * Google Cast's content-type sniffer breaks when there are query params after
 * the extension; using a unique path per broadcast also lets us set a longer
 * cache TTL without stale-audio risk.
 *
 * Returns the public URL (no query string) or null on failure.
 */
export async function generateAndUploadTTS(
  message: string,
  filePrefix = 'broadcast',
): Promise<string | null> {
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
  let supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';

  if (!elevenLabsKey) {
    console.error('[castBroadcast] ELEVENLABS_API_KEY not set — cannot generate TTS');
    return null;
  }

  const isDeletedSupabase =
    !supabaseUrl;
  if (isDeletedSupabase) {
    supabaseUrl = `http://localhost:${process.env.PORT || 5000}`;
  }

  // Step 1: Call ElevenLabs TTS
  console.log(`[castBroadcast] Calling ElevenLabs TTS (${message.length} chars)`);
  let audioBuffer: ArrayBuffer;
  try {
    const ttsRes = await fetchT(
      `https://api.elevenlabs.io/v1/text-to-speech/${JANUS_VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': elevenLabsKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: message,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
      },
      30_000,
    );
    if (!ttsRes.ok) {
      const errText = await ttsRes.text().catch(() => '');
      console.error(
        `[castBroadcast] ElevenLabs TTS failed: HTTP ${ttsRes.status} — ${errText.slice(0, 300)}`,
      );
      return null;
    }
    audioBuffer = await ttsRes.arrayBuffer();
    console.log(`[castBroadcast] ElevenLabs TTS generated ${audioBuffer.byteLength} bytes`);
  } catch (e) {
    console.error(
      `[castBroadcast] ElevenLabs TTS error: ${e instanceof Error ? e.message : 'unknown'}`,
    );
    return null;
  }

  // Step 2: Upload with a timestamped filename so URL ends in .mp3 (no query string)
  // Google Cast content-type sniffing breaks on query strings after the extension.
  const timestamp = Date.now();
  const filename = `${BROADCAST_SUBDIR}/${filePrefix}-${timestamp}.mp3`;
  const storageUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${VOICE_REPLIES_BUCKET}/${filename}`;

  // The storage-compat write route is authorized via the internal service
  // secret (JWT_SECRET/SESSION_SECRET), mirroring server/middleware/auth.ts.
  const internalKey =
    process.env.JWT_SECRET ||
    process.env.SESSION_SECRET ||
    'club34-dev-secret-change-in-production';

  try {
    const uploadRes = await fetchT(
      storageUrl,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${internalKey}`,
          apikey: internalKey,
          'Content-Type': 'audio/mpeg',
          'x-upsert': 'true',
        },
        body: audioBuffer as unknown as BodyInit,
      },
      20_000,
    );
    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => '');
      console.error(
        `[castBroadcast] Storage upload failed: HTTP ${uploadRes.status} — ${errText.slice(0, 300)}`,
      );
      return null;
    }
    console.log(`[castBroadcast] MP3 uploaded: ${filename} (${audioBuffer.byteLength} bytes)`);
  } catch (e) {
    console.error(
      `[castBroadcast] Storage upload error: ${e instanceof Error ? e.message : 'unknown'}`,
    );
    return null;
  }

  // Cleanup is scoped to this filePrefix so school-morning-* and google-home-*
  // pools never evict each other's freshly generated files.
  cleanupOldBroadcasts(VOICE_REPLIES_BUCKET, BROADCAST_SUBDIR, filePrefix, MAX_BROADCAST_FILES).catch(
    () => {},
  );

  // MUST point at the Express backend, NOT the user-facing PUBLIC_BASE_URL.
  // example.com is Cloudflare Pages (static SPA) and does NOT serve
  // /storage/* — it returns index.html, so Google Cast fetches HTML instead
  // of an MP3 and silently drops the broadcast. Only /api/* is proxied to the
  // backend; /storage/* is served exclusively by this app (storage-compat.ts).
  // Use MEDIA_BASE_URL (the backend origin) and never fall back to
  // PUBLIC_BASE_URL here.
  const baseUrl = process.env.MEDIA_BASE_URL || process.env.APP_URL || 'http://localhost:5000';
  return `${baseUrl.replace(/\/$/, '')}/storage/v1/object/public/${VOICE_REPLIES_BUCKET}/${filename}`;
}

/**
 * Poll HA state ~3s after play_media to verify the speaker loaded the expected
 * content.  Used to distinguish a true Cast success from the silent-drop
 * pattern (Cast accepts play_media → 200 → chirp → drops audio).
 *
 * @param expectedUrl   The exact URL passed to play_media.  When provided, the
 *   verification confirms that media_content_id matches it, so a stale state
 *   from a previous broadcast doesn't count as verified.
 * @param announceMode  Set true when the play_media call used `announce: true`.
 *   Google Cast keeps the device at state='idle' while an announcement plays
 *   "over" it, so requiring state==='playing' can never be satisfied.  In
 *   announce mode the speaker is considered verified when urlMatch===true and
 *   the device is not 'unavailable'.  Genuine failures (urlMatch===false or
 *   state==='unavailable') are still detected and reported correctly.
 */
export async function verifyPlaybackState(
  haUrl: string,
  haToken: string,
  entityId: string,
  expectedUrl?: string,
  announceMode = false,
): Promise<{ verified: boolean; state: string | null; contentId: string | null; urlMatch: boolean | null }> {
  try {
    // guardedFetch: HA URL can be user-configured, so pin connections through
    // the SSRF-guarded DNS lookup (blocks internal/metadata destinations at
    // connect time).
    const res = await guardedFetch(`${haUrl.replace(/\/$/, '')}/api/states/${entityId}`, {
      headers: { Authorization: `Bearer ${haToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { verified: false, state: null, contentId: null, urlMatch: null };
    const data = (await res.json()) as { state?: string; attributes?: { media_content_id?: string } };
    const state: string = data?.state ?? 'unknown';
    const contentId: string | null = data?.attributes?.media_content_id ?? null;
    const isPlaying = state === 'playing';
    const isUnavailable = state === 'unavailable';

    let urlMatch: boolean | null = null;
    if (expectedUrl) {
      urlMatch = contentId !== null && contentId === expectedUrl;
    }

    let verified: boolean;
    if (announceMode) {
      // Announcement mode: Cast keeps state='idle' while audio plays over the
      // device.  Verified = correct content was loaded AND the device is
      // reachable (not 'unavailable').  urlMatch===false or 'unavailable'
      // still count as a genuine failure.
      verified = !isUnavailable && urlMatch === true;
    } else {
      // Normal playback: speaker must be in 'playing' state and (if we have an
      // expected URL) the content must match exactly.  This prevents a stale
      // "playing" from a prior broadcast being misreported as success.
      verified = isPlaying && (urlMatch === null || urlMatch === true);
    }
    return { verified, state, contentId, urlMatch };
  } catch {
    return { verified: false, state: null, contentId: null, urlMatch: null };
  }
}

/**
 * Second-poll heuristic for the Cast "silent-drop" failure pattern.
 *
 * Cast can accept play_media (HTTP 200), briefly set media_content_id to the new
 * URL — so the first ~3.5s poll sees urlMatch===true and reports the speaker as
 * "verified" in announce mode — and then silently drop the audio so nothing is
 * ever heard.  The first poll cannot distinguish this from a genuine success
 * because both look identical at 3.5s.
 *
 * This helper polls a SECOND time ~8s after play_media.  If EVERY speaker still
 * reports urlMatch===true but the device is still 'idle' at 8s (it never even
 * briefly transitioned out of idle), that is the silent-drop signature and we
 * flag it as a risk.
 *
 * This is purely observability: it MUST NOT change the overall success/failure
 * status.  A healthy announce-mode broadcast can legitimately sit at 'idle'
 * (Cast plays the announcement "over" the idle device), so this is a soft
 * warning surfaced in the audit detail, not a failure on its own.
 *
 * @param firstPollDelayMs  How long after play_media the first poll already
 *   happened, so this helper only waits the *remaining* time up to ~8s before
 *   re-polling.
 */
export async function detectSilentDropRisk(
  haUrl: string,
  haToken: string,
  speakers: string[],
  expectedUrl: string,
  firstPollDelayMs = 3_500,
): Promise<{
  silentDropRisk: boolean;
  secondPoll: Record<string, { state: string | null; contentId: string | null; urlMatch: boolean | null }>;
}> {
  const TARGET_DELAY_MS = 8_000;
  const remaining = Math.max(0, TARGET_DELAY_MS - firstPollDelayMs);
  if (remaining > 0) {
    await new Promise((r) => setTimeout(r, remaining));
  }

  const secondPoll: Record<
    string,
    { state: string | null; contentId: string | null; urlMatch: boolean | null }
  > = {};
  for (const speaker of speakers) {
    const v = await verifyPlaybackState(haUrl, haToken, speaker, expectedUrl, true);
    secondPoll[speaker] = { state: v.state, contentId: v.contentId, urlMatch: v.urlMatch };
  }

  const entries = Object.values(secondPoll);
  const silentDropRisk =
    entries.length > 0 && entries.every((v) => v.urlMatch === true && v.state === 'idle');

  return { silentDropRisk, secondPoll };
}
