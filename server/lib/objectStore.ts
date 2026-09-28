import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Portable, durable object storage backing for the /storage compatibility layer.
 *
 * Self-contained local filesystem implementation with zero proprietary vendor lock-in.
 * Can be backed by any local directory, Docker volume mount, or networked filesystem.
 * Configurable via process.env.STORAGE_DIR (defaults to `./data/storage`).
 *
 * Keys are namespaced as `${bucket}/${filePath}` to preserve compatibility with
 * Supabase/S3-style bucket layouts (e.g. `voice-replies/broadcasts/school-morning.mp3`).
 */

const BASE_STORAGE_DIR = path.resolve(
  process.env.STORAGE_DIR || path.join(process.cwd(), 'data', 'storage'),
);

function sanitizeKey(bucket: string, filePath: string): string {
  const cleanBucket = bucket.replace(/[^a-zA-Z0-9._-]/g, '');
  const cleanPath = filePath.replace(/^\/+/, '').replace(/\.\./g, '');
  return path.join(cleanBucket, cleanPath);
}

function resolveSecurePath(key: string): string {
  const resolved = path.resolve(BASE_STORAGE_DIR, key);
  if (!resolved.startsWith(BASE_STORAGE_DIR)) {
    throw new Error(`Path traversal violation: key "${key}" escapes storage root`);
  }
  return resolved;
}

export async function putObject(
  bucket: string,
  filePath: string,
  body: Buffer,
): Promise<void> {
  const key = sanitizeKey(bucket, filePath);
  const targetPath = resolveSecurePath(key);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, body);
}

export async function getObject(
  bucket: string,
  filePath: string,
): Promise<Buffer | null> {
  const key = sanitizeKey(bucket, filePath);
  const targetPath = resolveSecurePath(key);
  try {
    if (!existsSync(targetPath)) return null;
    const data = await fs.readFile(targetPath);
    return data.length > 0 ? data : null;
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Delete an object. Missing keys are tolerated (no-op).
 */
export async function deleteObject(bucket: string, filePath: string): Promise<void> {
  const key = sanitizeKey(bucket, filePath);
  const targetPath = resolveSecurePath(key);
  try {
    await fs.unlink(targetPath);
  } catch (err: any) {
    if (err.code === 'ENOENT') return; // File already deleted or does not exist
    throw err;
  }
}

/**
 * List object keys under `${bucket}/${prefix}`. Returns the full keys
 * (bucket-prefixed) so callers can pass them straight back to delete helpers.
 */
export async function listObjects(bucket: string, prefix = ''): Promise<string[]> {
  const cleanBucket = bucket.replace(/[^a-zA-Z0-9._-]/g, '');
  const bucketDir = path.resolve(BASE_STORAGE_DIR, cleanBucket);
  if (!existsSync(bucketDir)) return [];

  const results: string[] = [];
  const fullPrefix = `${cleanBucket}/${prefix.replace(/^\/+/, '')}`;

  async function walk(currentDir: string, currentPrefix: string) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryKey = `${currentPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(currentDir, entry.name), entryKey);
      } else if (entry.isFile()) {
        if (!fullPrefix || entryKey.startsWith(fullPrefix)) {
          results.push(entryKey);
        }
      }
    }
  }

  await walk(bucketDir, cleanBucket);
  return results;
}

/**
 * Delete a key already in `${bucket}/...` form (as returned by listObjects).
 * Best-effort: used by retention cleanup.
 */
export async function deleteObjectKey(key: string): Promise<void> {
  try {
    const targetPath = resolveSecurePath(key);
    await fs.unlink(targetPath);
  } catch (err: any) {
    if (err.code === 'ENOENT') return;
    console.warn(`[objectStore] cleanup delete failed for ${key}: ${err?.message ?? 'unknown'}`);
  }
}
