import type { Request, Response } from "express";
import { query } from "../lib/db.js";
import { getServiceClient, GOOGLE_CLIENT_ID, logAudit } from "../lib/helpers.js";

const GMAIL_API = "https://www.googleapis.com/gmail/v1/users/me";
const GOACCESS_USER_ID = "goaccess_system";
const GOACCESS_EMAIL = "gate-notifications@example.com";

async function getGoAccessOAuthToken(): Promise<string | null> {
  const serviceClient = getServiceClient();
  const { data: tokenRow, error } = await serviceClient
    .from("google_tokens")
    .select("access_token, refresh_token, token_expires_at")
    .eq("user_id", GOACCESS_USER_ID)
    .single();

  if (error || !tokenRow) {
    console.log("[goaccess-poll] No stored OAuth token for GoAccess account");
    return null;
  }

  const expiresAt = new Date(tokenRow.token_expires_at).getTime();
  if (expiresAt - Date.now() > 60_000) {
    return tokenRow.access_token;
  }

  console.log("[goaccess-poll] Token expired, refreshing...");
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientSecret) {
    console.error("[goaccess-poll] GOOGLE_CLIENT_SECRET not configured");
    return null;
  }

  const refreshResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: clientSecret,
      refresh_token: tokenRow.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const refreshData = await refreshResp.json();
  if (!refreshResp.ok) {
    console.error("[goaccess-poll] Token refresh failed:", refreshData.error_description);
    return null;
  }

  const newExpiresAt = new Date(Date.now() + refreshData.expires_in * 1000).toISOString();
  await serviceClient
    .from("google_tokens")
    .update({
      access_token: refreshData.access_token,
      token_expires_at: newExpiresAt,
    })
    .eq("user_id", GOACCESS_USER_ID);

  return refreshData.access_token;
}

function parseGoAccessEmail(
  subject: string,
  internalDate: string | undefined,
  dateHeader: string | undefined,
): { guestName: string; companyName: string | null; checkedInAt: Date } | null {
  const pattern = /^(.+?)\s*\(([^)]+)\)\s+has been checked in/i;
  const match = subject.match(pattern);

  let companyName: string | null = null;
  let guestName = "";

  if (match) {
    companyName = match[1].trim();
    guestName = match[2].trim();
  } else {
    const simplePattern = /^(.+?)\s+has been checked in/i;
    const simpleMatch = subject.match(simplePattern);
    if (simpleMatch) {
      guestName = simpleMatch[1].trim();
    } else {
      guestName = subject.replace(/has been checked in.*$/i, "").trim() || "Unknown Visitor";
    }
  }

  let checkedInAt: Date;
  if (internalDate) {
    checkedInAt = new Date(parseInt(internalDate));
  } else if (dateHeader) {
    checkedInAt = new Date(dateHeader);
    if (isNaN(checkedInAt.getTime())) checkedInAt = new Date();
  } else {
    checkedInAt = new Date();
  }

  return { guestName, companyName, checkedInAt };
}

export async function pollGoAccessEmails(_req: Request, res: Response): Promise<void> {
  const t0 = Date.now();
  try {
    const token = await getGoAccessOAuthToken();
    if (!token) {
      res.json({ success: false, error: "GoAccess Google account not connected" });
      return;
    }

    await query(
      `CREATE TABLE IF NOT EXISTS goaccess_checkins (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        guest_name TEXT NOT NULL,
        company_name TEXT,
        checked_in_at TIMESTAMPTZ NOT NULL,
        raw_email_subject TEXT,
        gmail_message_id TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`
    );
    await query(
      `CREATE TABLE IF NOT EXISTS goaccess_poll_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        last_poll_at TIMESTAMPTZ,
        last_message_id TEXT
      )`
    );

    const stateResult = await query<{ last_poll_at: string | null }>(
      `SELECT last_poll_at FROM goaccess_poll_state WHERE id = 1`
    );
    const lastPollAt = stateResult.rows[0]?.last_poll_at;

    let searchQuery = "from:no-reply@no-reply.goaccess.app";
    if (lastPollAt) {
      const afterEpoch = Math.floor(new Date(lastPollAt).getTime() / 1000) - 300;
      searchQuery += ` after:${afterEpoch}`;
    }

    const listResp = await fetch(
      `${GMAIL_API}/messages?q=${encodeURIComponent(searchQuery)}&maxResults=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!listResp.ok) {
      const errText = await listResp.text();
      console.error("[goaccess-poll] Gmail list failed:", errText);
      res.json({ success: false, error: "Gmail API error" });
      return;
    }

    const listData = await listResp.json();
    const messages: { id: string }[] = listData.messages || [];

    if (messages.length === 0) {
      console.log("[goaccess-poll] No GoAccess emails found");
      await query(
        `INSERT INTO goaccess_poll_state (id, last_poll_at)
         VALUES (1, NOW())
         ON CONFLICT (id) DO UPDATE SET last_poll_at = NOW()`,
      );
      res.json({ success: true, processed: 0 });
      return;
    }

    let processed = 0;
    let skipped = 0;

    for (const msg of messages) {
      const existingResult = await query(
        `SELECT id FROM goaccess_checkins WHERE gmail_message_id = $1`,
        [msg.id]
      );
      if (existingResult.rows.length > 0) {
        skipped++;
        continue;
      }

      const msgResp = await fetch(
        `${GMAIL_API}/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!msgResp.ok) continue;

      const msgData = await msgResp.json();
      const headers: { name: string; value: string }[] = msgData.payload?.headers || [];
      const subject = headers.find(h => h.name.toLowerCase() === "subject")?.value || "";
      const dateHeader = headers.find(h => h.name.toLowerCase() === "date")?.value;

      const parsed = parseGoAccessEmail(subject, msgData.internalDate, dateHeader);
      if (!parsed) continue;

      try {
        await query(
          `INSERT INTO goaccess_checkins (guest_name, company_name, checked_in_at, raw_email_subject, gmail_message_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (gmail_message_id) DO NOTHING`,
          [parsed.guestName, parsed.companyName, parsed.checkedInAt.toISOString(), subject, msg.id]
        );
        processed++;
      } catch (err) {
        console.error("[goaccess-poll] Insert error:", err);
      }
    }

    await query(
      `INSERT INTO goaccess_poll_state (id, last_poll_at, last_message_id)
       VALUES (1, NOW(), $1)
       ON CONFLICT (id) DO UPDATE SET last_poll_at = NOW(), last_message_id = $1`,
      [messages[0]?.id || null]
    );

    const durationMs = Date.now() - t0;
    console.log(`[goaccess-poll] Done: ${processed} new, ${skipped} skipped (${durationMs}ms)`);

    logAudit("goaccess-poll", {
      category: "automation",
      event_type: "goaccess_poll_complete",
      severity: "info",
      actor_id: "system",
      channel: "cron",
      summary: `GoAccess poll: ${processed} new check-ins, ${skipped} skipped`,
      detail: { processed, skipped, total_messages: messages.length },
      status: "success",
      duration_ms: durationMs,
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    res.json({ success: true, processed, skipped });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[goaccess-poll] Error:", msg);
    res.status(500).json({ success: false, error: msg });
  }
}
