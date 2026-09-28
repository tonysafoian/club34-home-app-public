import { Client } from '@replit/object-storage';

/**
 * Durable object storage backing for the /storage compat layer.
 *
 * Why this exists: the app is deployed on Replit autoscale, where each
 * instance has its own ephemeral local filesystem. Broadcast/voice MP3s were
 * written to local disk on the instance that generated them, but a later GET
 * (e.g. a Google Cast device fetching the audio) can be routed to a DIFFERENT
 * instance that never had the file -> 404 -> silent drop. Replit Object
 * Storage is shared across all instances, so any instance can serve any file.
 *
 * Keys are namespaced as `${bucket}/${filePath}` to mirror the legacy
 * Supabase-style bucket layout (e.g. `voice-replies/broadcasts/x.mp3`).
 */

let _client: Client | null = null;

function getClient(): Client {
  if (!_client) _client = new Client();
  return _client;
}

function objectKey(bucket: string, filePath: string): string {
  return `${bucket}/${filePath.replace(/^\/+/, '')}`;
}

export async function putObject(
  bucket: string,
  filePath: string,
  body: Buffer,
): Promise<void> {
  const key = objectKey(bucket, filePath);
  const res = await getClient().uploadFromBytes(key, body, { compress: false });
  if (!res.ok) {
    throw new Error(`object-store upload failed for ${key}: ${res.error?.message ?? 'unknown'}`);
  }
}

export async function getObject(
  bucket: string,
  filePath: string,
): Promise<Buffer | null> {
  const key = objectKey(bucket, filePath);
  const res = await getClient().downloadAsBytes(key);
  if (!res.ok) return null;
  const value = res.value;
  if (value[0].length === 0) return null;
  return Buffer.isBuffer(value[0]) ? value[0] : Buffer.from(value[0]);
}

/**
 * Delete an object. Missing keys are tolerated (no-op); any other failure is
 * surfaced so callers don't report a successful delete when the durable
 * source-of-truth copy actually remains.
 */
export async function deleteObject(bucket: string, filePath: string): Promise<void> {
  const key = objectKey(bucket, filePath);
  const res = await getClient().delete(key, { ignoreNotFound: true });
  if (!res.ok) {
    throw new Error(`object-store delete failed for ${key}: ${res.error?.message ?? 'unknown'}`);
  }
}

/**
 * List object keys under `${bucket}/${prefix}`. Returns the full keys
 * (bucket-prefixed) so callers can pass them straight back to delete helpers.
 */
export async function listObjects(bucket: string, prefix = ''): Promise<string[]> {
  const fullPrefix = objectKey(bucket, prefix);
  const res = await getClient().list({ prefix: fullPrefix });
  if (!res.ok || !res.value) return [];
  return res.value.map((o) => o.name);
}

/**
 * Delete a key already in `${bucket}/...` form (as returned by listObjects).
 * Best-effort: used by retention cleanup, where a transient failure is fine
 * because the next sweep retries. Failures are logged, not thrown.
 */
export async function deleteObjectKey(key: string): Promise<void> {
  try {
    const res = await getClient().delete(key, { ignoreNotFound: true });
    if (!res.ok) {
      console.warn(`[objectStore] cleanup delete failed for ${key}: ${res.error?.message ?? 'unknown'}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[objectStore] cleanup delete threw for ${key}: ${message}`);
  }
}
