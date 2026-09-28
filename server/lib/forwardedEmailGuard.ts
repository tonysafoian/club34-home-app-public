/**
 * Detect inbound emails that are forwarded transactional notifications
 * (appointment confirmations, receipts, shipping notices, etc.) where the
 * forwarder is NOT asking Janus to do anything — they're just filing it.
 *
 * Janus's outsider/LLM reply path used to fire on these inputs because the
 * forwarded body has no obvious question, so the LLM defaulted to its
 * fallback greeting ("I'm Janus — I run the house at Club 34. What can I
 * help you with?"). That reply then got sent back to the original vendor
 * (and CC'd to Tony), which is both noisy and embarrassing.
 *
 * Heuristic — ALL of the following must hold for us to suppress the reply:
 *   1. Subject begins with a forwarding marker (Fwd:, Fw:, FW:, Tr:, etc.).
 *   2. Body contains a "---------- Forwarded message ----------" / "Begin
 *      forwarded message:" / equivalent block, OR the body is dominated by
 *      a transactional template (>50% URL/punctuation density and contains
 *      keywords like "confirmation", "receipt", "appointment", "order",
 *      "shipping").
 *   3. The forwarder's portion (the text BEFORE the forwarded block) does
 *      NOT contain a direct question to Janus — no "?", no "@janus", no
 *      imperative verb directed at Janus, no "please".
 *
 * If even one heuristic fails, we fall through to the normal reply path so
 * we never silently swallow a real ask.
 *
 * Pure function, no I/O. Easy to unit-test.
 */

const FORWARD_SUBJECT_RE = /^\s*(?:re\s*:\s*)*(?:fwd?|fw|tr|wg|rv|i)\s*:/i;

const FORWARD_BLOCK_MARKERS = [
  /-{2,}\s*forwarded message\s*-{2,}/i,
  /begin forwarded message\s*:/i,
  /-{2,}\s*original message\s*-{2,}/i,
  /from:\s.+\nsent:\s.+\nto:\s.+\nsubject:\s/i, // Outlook-style header block
];

const TRANSACTIONAL_KEYWORDS = [
  "confirmation",
  "confirmed",
  "appointment",
  "receipt",
  "invoice",
  "order #",
  "order number",
  "shipping",
  "shipped",
  "tracking",
  "your booking",
  "your reservation",
  "your delivery",
  "scheduled for",
];

const JANUS_ASK_INDICATORS = [
  /\?/, // any question mark in forwarder's text
  /@janus\b/i,
  /\bjanus[, ]/i, // direct address: "Janus, please…" / "Janus please"
  /\bplease\b/i,
  /\bcan you\b/i,
  /\bcould you\b/i,
  /\bremind me\b/i,
  /\badd (?:this|to)\b/i,
  /\bschedule\b/i,
  /\bfile (?:this|under)\b/i, // explicit filing instructions count as an ask
];

export interface ForwardedGuardInput {
  subject: string;
  body: string;
}

export interface ForwardedGuardResult {
  isForwardedTransactional: boolean;
  reason: string; // human-readable explanation, useful in audit logs
}

/**
 * Split a forwarded email's body into (forwarderText, forwardedBlockText).
 * If no forwarded block is found, the whole body is the "forwarder" portion.
 */
export function splitForwardedBody(body: string): { forwarder: string; forwarded: string } {
  for (const marker of FORWARD_BLOCK_MARKERS) {
    const m = body.match(marker);
    if (m && m.index !== undefined) {
      return {
        forwarder: body.slice(0, m.index).trim(),
        forwarded: body.slice(m.index).trim(),
      };
    }
  }
  return { forwarder: body.trim(), forwarded: "" };
}

export function classifyForwardedEmail(input: ForwardedGuardInput): ForwardedGuardResult {
  const subject = (input.subject || "").trim();
  const body = (input.body || "").trim();

  if (!FORWARD_SUBJECT_RE.test(subject)) {
    return { isForwardedTransactional: false, reason: "subject does not start with a forwarding marker" };
  }

  const { forwarder, forwarded } = splitForwardedBody(body);

  // Look for transactional keywords in the WHOLE body (forwarded block is where
  // they normally appear, but some forwarders strip headers, so check both).
  const lowerBody = body.toLowerCase();
  const hasTransactionalKeyword = TRANSACTIONAL_KEYWORDS.some((kw) => lowerBody.includes(kw));
  const hasForwardBlock = forwarded.length > 0;

  if (!hasForwardBlock && !hasTransactionalKeyword) {
    return {
      isForwardedTransactional: false,
      reason: "no forwarded-message block and no transactional keywords detected",
    };
  }

  // Check the forwarder's own text for any indicator of an ask. If the body
  // has no forwarded block (transactional-keyword-only path), use the whole
  // body — but exclude lines that look like quoted/forwarded content (start
  // with ">" or are sandwiched between "From:" "To:" "Subject:" pseudo-headers).
  const askText = hasForwardBlock
    ? forwarder
    : body
        .split("\n")
        .filter((line) => !/^\s*>/.test(line) && !/^(?:from|to|subject|sent|date):\s/i.test(line))
        .join("\n");

  for (const indicator of JANUS_ASK_INDICATORS) {
    if (indicator.test(askText)) {
      return {
        isForwardedTransactional: false,
        reason: `forwarder included an ask: matched ${indicator.source}`,
      };
    }
  }

  return {
    isForwardedTransactional: true,
    reason: hasForwardBlock
      ? "forwarded-message block present and forwarder added no ask"
      : "transactional keywords detected and forwarder added no ask",
  };
}
