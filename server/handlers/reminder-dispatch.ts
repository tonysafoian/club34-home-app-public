import type { Request, Response } from "express";
import { getServiceClient } from "../utils/supabase.js";
import { getGoogleServiceToken } from "../utils/google-jwt.js";
import { fetchT } from "../utils/fetch-timeout.js";
import { logAudit, enqueueFailedJob, sendAutomationFailureAlert } from "../utils/janus-tools.js";

const JANUS_EMAIL = "assistant@example.com";

async function logEmail(
  emailType: string,
  subject: string,
  recipients: string[],
  body: string,
  status: string,
  errorMessage?: string,
): Promise<void> {
  try {
    const { query } = await import('../lib/db.js');
    await query(
      `INSERT INTO email_logs (email_type, subject, recipients, html_body, text_body, status, error_message) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [emailType, subject, recipients, body, body, status, errorMessage || null]
    );
  } catch (e) {
    console.error("Failed to log email:", e);
  }
}

async function sendReminderEmail(
  to: string,
  reminderText: string,
  token: string,
): Promise<boolean> {
  const subject = "⏰ Janus Reminder";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #333;">⏰ Reminder from Janus</h2>
      <div style="background: #f5f5f5; border-left: 4px solid #4A90D9; padding: 16px; border-radius: 4px; margin: 16px 0;">
        <p style="font-size: 16px; color: #333; margin: 0;">${reminderText.replace(/\n/g, "<br>")}</p>
      </div>
      <p style="color: #888; font-size: 12px;">— Janus, Club 34 AI Assistant</p>
    </div>`;

  const subjectEncoded = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
  const raw = [
    `From: Janus <${JANUS_EMAIL}>`,
    `To: ${to}`,
    `Subject: ${subjectEncoded}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    html,
  ].join("\r\n");

  const encoded = Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetchT(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: encoded }),
    },
  );
  if (!res.ok) {
    const errText = await res.text();
    console.error("Email send failed:", res.status, errText);
    await logEmail("janus_reminder", subject, [to], reminderText, "error", `Gmail ${res.status}: ${errText}`);
    return false;
  }
  console.log(`Reminder email sent to ${to}`);
  await logEmail("janus_reminder", subject, [to], reminderText, "sent");
  return true;
}

async function sendReminderWhatsApp(
  number: string,
  reminderText: string,
): Promise<boolean> {
  const rawEndpoint = process.env.WATI_API_ENDPOINT;
  let token = process.env.WATI_ACCESS_TOKEN;
  if (!rawEndpoint || !token) {
    console.error("WATI not configured");
    return false;
  }
  token = token.replace(/^Bearer\s+/i, "");
  const serverRoot = rawEndpoint
    .replace(/\/$/, "")
    .replace(/\/api\/ext\/v3\/?$/, "")
    .replace(/\/api\/ext\/?$/, "");
  const normalized = number.replace(/[^\d]/g, "");
  const message = `⏰ *Janus Reminder*\n\n${reminderText}`;
  const res = await fetchT(
    `${serverRoot}/api/ext/v3/conversations/messages/text`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ target: normalized, text: message }),
    },
  );
  if (!res.ok) {
    console.error("WhatsApp reminder failed:", res.status, await res.text());
    return false;
  }
  console.log(`Reminder WhatsApp sent to ${normalized}`);
  return true;
}

export async function handleReminderDispatch(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const sb = getServiceClient();

    const { data: reminders, error } = await sb
      .from("janus_reminders")
      .select("*")
      .lte("due_at", new Date().toISOString())
      .is("fired_at", null);

    if (error) {
      console.error("Failed to fetch reminders:", error);
      res.status(500).json({ error: error.message });
      return;
    }

    if (!reminders || reminders.length === 0) {
      console.log("No due reminders to dispatch.");
      res.json({ dispatched: 0 });
      return;
    }

    console.log(`Found ${reminders.length} due reminder(s).`);
    let dispatched = 0;
    let gmailToken: string | null = null;

    for (const reminder of reminders) {
      let success = false;

      if (reminder.channel === "whatsapp" && reminder.whatsapp_number) {
        success = await sendReminderWhatsApp(
          reminder.whatsapp_number,
          reminder.reminder_text,
        );
      } else {
        try {
          if (!gmailToken) {
            gmailToken = await getGoogleServiceToken(
              [
                "https://mail.google.com/",
                "https://www.googleapis.com/auth/gmail.send",
              ],
              JANUS_EMAIL,
            );
          }
          success = await sendReminderEmail(
            reminder.user_email,
            reminder.reminder_text,
            gmailToken,
          );
        } catch (e) {
          console.error("Gmail token/send error:", e);
          success = false;
        }
      }

      await sb
        .from("janus_reminders")
        .update({ fired_at: new Date().toISOString() })
        .eq("id", reminder.id);

      if (success) dispatched++;
      console.log(
        `Reminder ${reminder.id}: ${success ? "dispatched" : "failed but marked fired"} via ${reminder.channel}`,
      );
    }

    logAudit("janus-reminder-dispatch", {
      category: "automation",
      event_type: "reminder_dispatch",
      severity: dispatched < reminders.length ? "warn" : "info",
      actor_id: "system",
      actor_name: "Cron",
      actor_role: "system",
      channel: "cron",
      summary: `Reminders: ${dispatched}/${reminders.length} dispatched`,
      detail: { dispatched, total: reminders.length },
      status: dispatched > 0 ? "success" : "partial",
    });

    res.json({ dispatched, total: reminders.length });
  } catch (e) {
    console.error("Reminder dispatch error:", e);
    logAudit("janus-reminder-dispatch", {
      category: "automation",
      event_type: "reminder_error",
      severity: "error",
      actor_id: "system",
      channel: "cron",
      summary: `Reminder dispatch error: ${e instanceof Error ? e.message : "unknown"}`,
      status: "error",
    });
    await enqueueFailedJob("janus-reminder-dispatch", e);
    await sendAutomationFailureAlert(
      "janus-reminder-dispatch",
      e instanceof Error ? e.message : "unknown",
    );
    res.status(500).json({
      error: e instanceof Error ? e.message : "unknown",
    });
  }
}
