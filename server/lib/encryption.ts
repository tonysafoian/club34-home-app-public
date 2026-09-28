import { webcrypto } from 'crypto';

const subtle = webcrypto.subtle;

/**
 * Derive a deterministic 32-byte AES-GCM key from the shared key material.
 *
 * The key source is `ENCRYPTION_KEY` (preferred) with a `SESSION_SECRET` fallback
 * for backwards compatibility. Both the Express server and any Supabase edge
 * function that handles Home Assistant tokens MUST derive the key the same way:
 * SHA-256 the key source to always produce exactly 32 bytes, then import it as an
 * AES-GCM key. This guarantees a token encrypted by one path can be decrypted by
 * the other as long as they share the same `ENCRYPTION_KEY` secret. Hashing also
 * removes the foot-gun of key material shorter than 32 bytes (AES-GCM requires a
 * 16/24/32-byte key).
 */
async function getEncryptionKey(): Promise<webcrypto.CryptoKey> {
  const keySource = process.env.ENCRYPTION_KEY || process.env.SESSION_SECRET || '';
  if (!keySource) {
    throw new Error(
      'ENCRYPTION_KEY (or SESSION_SECRET fallback) is not set; cannot encrypt/decrypt tokens',
    );
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(keySource));
  return subtle.importKey('raw', new Uint8Array(digest), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptToken(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded));
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, iv.length);
  return Buffer.from(combined).toString('base64');
}

export async function decryptToken(encrypted: string): Promise<string> {
  const key = await getEncryptionKey();
  const combined = new Uint8Array(Buffer.from(encrypted, 'base64'));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}
