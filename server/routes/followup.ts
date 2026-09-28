import { Router, type Request, type Response } from "express";
import {
  getServiceToken,
  getSaKey,
  fetchT,
  logAudit,
  logEmail,
  sendWhatsApp,
  sendGmailRaw,
  getAlertPhoneNumber,
  getServiceClient,
  TONY_EMAIL,
  JANUS_EMAIL,
  type ServiceAccountKey,
} from "../lib/helpers.js";

const router = Router();

interface FollowUpItem {
  source: string;
  text: string;
  due: string | null;
  urgency: "overdue" | "due_today" | "upcoming";
}

async function fetchOverdueReminders(svc: any): Promise<FollowUpItem[]> {
  const now = new Date().toISOString();
  const { data } = await svc
    .from("janus_reminders")
    .select("reminder_text,due_at")
    .is("fired_at", null)
    .lte("due_at", now)
    .order("due_at", { ascending: true })
    .limit(20);

  return (data || []).map((r: any) => ({
    source: "reminder",
    text: r.reminder_text,
    due: r.due_at,
    urgency: "overdue" as const,
  }));
}

async function fetchDueTodayReminders(svc: any): Promise<FollowUpItem[]> {
  const now = new Date();
  const laDate = now.toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });
  const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
  const laStr = now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  const diffMs = new Date(utcStr).getTime() - new Date(laStr).getTime();
  const diffHours = Math.round(diffMs / 3600000);
  const offsetSign = diffHours >= 0 ? "-" : "+";
  const offset = `${offsetSign}${String(Math.abs(diffHours)).padStart(2, "0")}:00`;
  const endOfDay = `${laDate}T23:59:59${offset}`;

  const { data } = await svc
    .from("janus_reminders")
    .select("reminder_text,due_at")
    .is("fired_at", null)
    .gt("due_at", new Date().toISOString())
    .lte("due_at", endOfDay)
    .order("due_at", { ascending: true })
    .limit(20);

  return (data || []).map((r: any) => ({
    source: "reminder",
    text: r.reminder_text,
    due: r.due_at,
    urgency: "due_today" as const,
  }));
}

async function fetchFollowUpMemories(svc: any): Promise<FollowUpItem[]> {
  const { data } = await svc
    .from("janus_memory")
    .select("key,value,context")
    .or("key.ilike.%follow%,key.ilike.%action%,key.ilike.%todo%")
    .order("updated_at", { ascending: false })
    .limit(10);

  return (data || []).map((m: any) => ({
    source: "memory",
    text: `${m.key}: ${m.value}`,
    due: null,
    urgency: "upcoming" as const,
  }));
}

async function fetchNotionTasks(svc: any): Promise<FollowUpItem[]> {
  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) return [];

  try {
    const { data: configs } = await svc
      .from("notion_sync_config")
      .select("notion_database_id")
      .eq("is_active", true)
      .limit(5);

    if (!configs || configs.length === 0) return [];

    const items: FollowUpItem[] = [];
    for (const config of configs) {
      try {
        const resp = await fetchT(
          `https://api.notion.com/v1/databases/${config.notion_database_id}/query`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${notionKey}`,
              "Notion-Version": "2022-06-28",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              filter: {
                or: [
                  {
                    property: "Status",
                    status: { equals: "In Progress" },
                  },
                  {
                    property: "Status",
                    status: { equals: "Not Started" },
                  },
                ],
              },
              page_size: 10,
            }),
          },
          15_000,
        );
        if (!resp.ok) continue;
        const data = await resp.json();
        for (const page of data.results || []) {
          let title = "Untitled";
          for (const key of Object.keys(page.properties || {})) {
            const prop = page.properties[key];
            if (
              prop?.type === "title" &&
              prop.title?.length > 0
            ) {
              title = prop.title
                .map((t: any) => t.plain_text)
                .join("");
              break;
            }
          }
          items.push({
            source: "notion",
            text: title,
            due: null,
            urgency: "upcoming",
          });
        }
      } catch (_) {}
    }
    return items;
  } catch (_) {
    return [];
  }
}

router.post("/accountability", async (_req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const saKey = getSaKey();
    const svc = getServiceClient();

    const [overdue, dueToday, memories, notionTasks] = await Promise.all([
      fetchOverdueReminders(svc),
      fetchDueTodayReminders(svc),
      fetchFollowUpMemories(svc),
      fetchNotionTasks(svc),
    ]);

    const allItems = [...overdue, ...dueToday, ...memories, ...notionTasks];
    const urgentCount = overdue.length;

    if (urgentCount > 0) {
      for (const item of overdue.slice(0, 3)) {
        await sendWhatsApp(`⚠️ Overdue: ${item.text}`);
      }
      if (urgentCount > 3) {
        await sendWhatsApp(
          `… and ${urgentCount - 3} more overdue items. Check your email.`,
        );
      }
    }

    if (allItems.length >= 3) {
      const dateStr = new Date().toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: "America/Los_Angeles",
      });

      const sections: string[] = [
        `Follow-Up Accountability — ${dateStr}`,
        "",
      ];

      if (overdue.length > 0) {
        sections.push("OVERDUE:");
        for (const item of overdue) {
          sections.push(`  🔴 ${item.text}${item.due ? ` (due ${item.due})` : ""}`);
        }
        sections.push("");
      }

      if (notionTasks.length > 0) {
        sections.push("OPEN NOTION TASKS:");
        for (const item of notionTasks) {
          sections.push(
            `  ⚠️ ${item.text}${item.due ? ` (due ${item.due})` : ""}`,
          );
        }
        sections.push("");
      }

      if (dueToday.length > 0) {
        sections.push("DUE TODAY:");
        for (const item of dueToday) {
          const due = item.due
            ? new Date(item.due).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
                timeZone: "America/Los_Angeles",
              })
            : "";
          sections.push(
            `  📌 ${item.text}${due ? ` (at ${due})` : ""}`,
          );
        }
        sections.push("");
      }

      if (memories.length > 0) {
        sections.push("FOLLOW-UP NOTES (from memory):");
        for (const item of memories) {
          sections.push(`  💡 ${item.text}`);
        }
        sections.push("");
      }

      sections.push("— Janus");

      const subject =
        urgentCount > 0
          ? `⚠️ ${urgentCount} Overdue Follow-Up${urgentCount > 1 ? "s" : ""} — ${dateStr}`
          : `Follow-Up Digest — ${dateStr}`;

      const sent = await sendGmailRaw(
        saKey,
        TONY_EMAIL,
        subject,
        `<pre>${sections.join("\n")}</pre>`,
        sections.join("\n"),
      );
      await logEmail("followup_digest", subject, [TONY_EMAIL], `<pre>${sections.join("\n")}</pre>`, sent ? "sent" : "error", sent ? undefined : "sendGmailRaw returned false", sections.join("\n"));
    }

    logAudit("followup-accountability", {
      category: "automation",
      event_type: "followup_accountability",
      severity: urgentCount > 0 ? "warning" : "info",
      actor_id: "system",
      actor_name: "Janus",
      channel: "cron",
      summary: `Follow-up check: ${urgentCount} overdue, ${dueToday.length} due today, ${allItems.length} total`,
      detail: {
        overdue: overdue.length,
        due_today: dueToday.length,
        memories: memories.length,
        notion_tasks: notionTasks.length,
      },
      status: "success",
      duration_ms: Date.now() - t0,
    });

    return res.json({
      ok: true,
      items: allItems.length,
      urgent: urgentCount,
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    logAudit("followup-accountability", {
      category: "automation",
      event_type: "followup_error",
      severity: "error",
      actor_id: "system",
      channel: "cron",
      summary: `Follow-up error: ${msg.slice(0, 100)}`,
      status: "error",
    });
    return res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
