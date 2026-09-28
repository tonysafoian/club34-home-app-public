/**
 * MIME header utilities for inbound and outbound email.
 *
 * Inbound: Gmail returns raw header values from the underlying MIME message.
 * Those values can contain RFC 2047 "encoded-words" (e.g. `=?UTF-8?Q?...?=`
 * or `=?UTF-8?B?...?=`) which must be decoded before we use them for routing,
 * logging, or for building reply subjects. Failing to decode produces the
 * classic mojibake (e.g. `ConfirmationÃ,Â Ã,Â` — the bytes 0xC2 0xA0 of a
 * UTF-8-encoded NBSP rendered as Latin-1).
 *
 * Outbound: any header value containing non-ASCII MUST be re-encoded per
 * RFC 2047 before it goes on the wire. Otherwise we leak UTF-8 bytes into
 * headers and the receiving MTA / mail client mis-decodes them.
 *
 * This module deliberately implements only the slice of RFC 2047 we need:
 *   - Decode Q-encoding and B-encoding for UTF-8 (the vast majority of real
 *     mail; non-UTF-8 charsets are best-effort via Buffer fallback).
 *   - Encode non-ASCII outbound header values as a single UTF-8 B-encoded
 *     word. We don't fold long words; modern MTAs accept long encoded-words
 *     and our subjects are short.
 *
 * Pure functions, no I/O, fully unit-testable.
 */

const ENCODED_WORD_RE = /=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g;

/**
 * Decode an RFC 2047 encoded header value. Idempotent on already-decoded
 * input. Leaves unrecognized fragments untouched.
 */
export function decodeMimeHeader(value: string): string {
  if (!value) return "";
  // RFC 2047 §6.2: whitespace between two adjacent encoded-words is ignored.
  // Collapse it first so "=?utf-8?B?...?= =?utf-8?B?...?=" decodes cleanly.
  const collapsed = value.replace(
    /(=\?[^?]+\?[QqBb]\?[^?]*\?=)\s+(?==\?[^?]+\?[QqBb]\?[^?]*\?=)/g,
    "$1",
  );

  return collapsed.replace(
    ENCODED_WORD_RE,
    (_match, charsetRaw: string, encoding: string, payload: string) => {
      const charset = (charsetRaw || "utf-8").toLowerCase();
      const enc = encoding.toUpperCase();
      try {
        let bytes: Buffer;
        if (enc === "B") {
          bytes = Buffer.from(payload, "base64");
        } else {
          // Q-encoding: underscores are spaces; =XX are hex bytes.
          const hexified = payload.replace(/_/g, " ");
          const out: number[] = [];
          for (let i = 0; i < hexified.length; i++) {
            const c = hexified[i];
            if (c === "=" && i + 2 < hexified.length) {
              const hex = hexified.slice(i + 1, i + 3);
              if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
                out.push(parseInt(hex, 16));
                i += 2;
                continue;
              }
            }
            out.push(c.charCodeAt(0));
          }
          bytes = Buffer.from(out);
        }
        // Node supports utf-8, latin1, ascii, utf16le natively. Anything else
        // we best-effort as latin1 (which is bytes-as-codepoints) and let the
        // caller cope — better than throwing.
        const supported = new Set(["utf-8", "utf8", "latin1", "iso-8859-1", "ascii", "us-ascii"]);
        const decodeAs = supported.has(charset)
          ? charset === "iso-8859-1" ? "latin1" : (charset === "us-ascii" ? "ascii" : charset as BufferEncoding)
          : "utf-8";
        return bytes.toString(decodeAs as BufferEncoding);
      } catch {
        // Decoder failure: return the original encoded-word verbatim rather
        // than silently dropping data.
        return _match;
      }
    },
  );
}

/**
 * True if a string is pure 7-bit ASCII (i.e. safe to put directly in a header
 * value without any RFC 2047 wrapping).
 */
function isPureAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7e || s.charCodeAt(i) < 0x20) {
      // Allow tab; everything else outside printable-ASCII needs encoding.
      if (s.charCodeAt(i) !== 0x09) return false;
    }
  }
  return true;
}

/**
 * Encode an outbound header value as an RFC 2047 UTF-8 B-encoded word when
 * it contains non-ASCII. Pure-ASCII strings pass through untouched.
 *
 * We use B-encoding (base64) because subjects often have many non-ASCII
 * characters at once (emoji, accented names) where Q-encoding would be
 * wasteful and harder to read in logs.
 */
export function encodeMimeHeader(value: string): string {
  if (!value) return "";
  if (isPureAscii(value)) return value;
  const b64 = Buffer.from(value, "utf-8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}
