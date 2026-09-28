/**
 * _shared/tools/research-admin.ts
 *
 * Research launcher, reminders, activity log, system health,
 * system updates, and project note tool executors.
 *
 * Extracted from janus-chat/index.ts to reduce monolith size.
 */

import { createClient } from "../janus-tools.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createFallbackSvc(): ReturnType<typeof createClient> {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

// ─── Research Worker ──────────────────────────────────────────────────────────

export async function executeLaunchResearch(
  topic: string,
  instructions: string | undefined,
  email_to: string,
  project_id?: string,
  userId?: string,
): Promise<string> {
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    // Fire and forget
    fetch(`${SUPABASE_URL}/functions/v1/janus-research-worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ topic, instructions: instructions || "", email_to, project_id: project_id || undefined, user_id: userId || undefined }),
    }).catch((e) => console.error("Research worker fire-and-forget error:", e));
    const projectNote = project_id ? " The report will also be saved to your project." : "";
    return `🔬 Research launched on "${topic}" — a Google Doc will be created and shared, with a link emailed to ${email_to} in ~10 minutes.${projectNote}`;
  } catch (e) {
    return `TOOL_ERROR: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

// ─── Reminders ────────────────────────────────────────────────────────────────

function reminderWordsOverlap(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3);
  const wordsA = normalize(a);
  const wordsB = new Set(normalize(b));
  if (wordsA.length === 0 || wordsB.size === 0) return false;
  const shared = wordsA.filter(w => wordsB.has(w)).length;
  return shared >= Math.min(3, Math.ceil(wordsA.length * 0.5));
}

export async function checkDuplicateReminder(
  sb: ReturnType<typeof createClient>,
  userId: string,
  message: string,
  due_at: string,
): Promise<string | null> {
  try {
    const dueTime = new Date(due_at).getTime();
    const windowStart = new Date(dueTime - 2 * 60 * 60 * 1000).toISOString();
    const windowEnd = new Date(dueTime + 2 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await sb
      .from("janus_reminders")
      .select("id, reminder_text, due_at")
      .eq("user_id", userId)
      .is("fired_at", null)
      .gte("due_at", windowStart)
      .lte("due_at", windowEnd)
      .limit(20);
    if (!existing || existing.length === 0) return null;
    for (const r of existing) {
      if (reminderWordsOverlap(message, r.reminder_text)) {
        const existingDue = new Date(r.due_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
        return `⏰ A similar reminder is already set for ${existingDue}: "${r.reminder_text}" — skipping duplicate.`;
      }
    }
    return null;
  } catch (e) {
    console.error("Dedup check failed (proceeding anyway):", e);
    return null;
  }
}

export async function executeSetReminder(
  due_at: string,
  message: string,
  channel: string,
  whatsapp_number: string | undefined,
  userId?: string,
  svc?: ReturnType<typeof createClient>,
): Promise<string> {
  try {
    const sb = svc || createFallbackSvc();
    let userEmail = "admin@example.com";
    if (userId) {
      const { data: member } = await sb.from("household_members").select("email").eq("supabase_uuid", userId).single();
      if (member?.email) userEmail = member.email;
    }
    const dupMsg = await checkDuplicateReminder(sb, userId || "system", message, due_at);
    if (dupMsg) return dupMsg;
    const { error } = await sb.from("janus_reminders").insert({
      user_id: userId || "system",
      user_email: userEmail,
      reminder_text: message,
      due_at,
      channel: channel || "email",
      whatsapp_number: channel === "whatsapp" ? whatsapp_number : null,
    });
    if (error) return `TOOL_ERROR: Failed to save reminder: ${error.message}`;
    const dueDate = new Date(due_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    return `✅ Reminder set! I'll send you a ${channel} message on ${dueDate}: "${message}"`;
  } catch (e) {
    return `TOOL_ERROR: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

// ─── Activity Log ─────────────────────────────────────────────────────────────

export async function executeQueryActivityLog(eventType: string | undefined, hours: number | undefined, svc: ReturnType<typeof createClient>): Promise<string> {
  try {
    const h = hours || 24;
    const cutoff = new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
    let query = svc.from("activity_events").select("*").gte("occurred_at", cutoff).order("occurred_at", { ascending: false }).limit(30);
    if (eventType) query = query.eq("event_type", eventType);
    const { data, error } = await query;
    if (error) return `TOOL_ERROR: ${error.message}`;
    if (!data?.length) return `No activity events in the last ${h} hours${eventType ? ` (type: ${eventType})` : ""}.`;
    const lines = data.map((e: { occurred_at: string; event_type?: string; severity?: string; description?: string; zone?: string | null; source?: string }) => {
      const time = new Date(e.occurred_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
      return `- ${time} [${e.event_type}/${e.severity}] ${e.description}${e.zone ? ` (${e.zone})` : ""} — ${e.source}`;
    });
    return `**Activity Log (last ${h}h): ${data.length} events**\n${lines.join("\n")}`;
  } catch (e) {
    return `TOOL_ERROR: Activity log query failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── System Health ────────────────────────────────────────────────────────────

export async function executeQuerySystemHealth(svc: ReturnType<typeof createClient>): Promise<string> {
  try {
    const lines: string[] = [];

    const { data: health } = await svc.from("janus_health_logs").select("*").order("created_at", { ascending: false }).limit(1).single();
    if (health) {
      lines.push(`**Last Health Check:** ${health.overall_status.toUpperCase()} (${health.total_ms}ms, ${new Date(health.created_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })})`);
      const results = health.results as { name?: string; check?: string; status?: string; error?: string }[];
      if (Array.isArray(results)) {
        const failed = results.filter((r) => r.status !== "ok" && r.status !== "pass");
        if (failed.length > 0) {
          lines.push(`  ⚠️ ${failed.length} failing checks:`);
          for (const f of failed) lines.push(`    - ${f.name || f.check}: ${f.status} ${f.error || ""}`);
        } else {
          lines.push(`  ✅ All ${results.length} checks passing`);
        }
      }
    } else { lines.push("No health check data available."); }

    const { data: audit } = await svc.from("system_audit_log").select("*").order("created_at", { ascending: false }).limit(10);
    if (audit && audit.length > 0) {
      lines.push(`\n**Recent Audit Log (${audit.length} entries):**`);
      for (const a of audit) {
        const time = new Date(a.created_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
        lines.push(`- ${time} [${a.severity}] ${a.event_type}: ${a.summary}${a.edge_function ? ` (${a.edge_function})` : ""}`);
      }
    }
    return lines.join("\n");
  } catch (e) {
    return `TOOL_ERROR: System health query failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── System Updates ───────────────────────────────────────────────────────────

export async function executeQuerySystemUpdates(limit: number | undefined, svc: ReturnType<typeof createClient>): Promise<string> {
  try {
    const { data, error } = await svc.from("system_updates").select("*").order("published_at", { ascending: false }).limit(limit || 5);
    if (error) return `TOOL_ERROR: ${error.message}`;
    if (!data?.length) return "No system updates found.";
    const lines = data.map((u: { version?: string; update_type?: string; published_at: string; title?: string; description: string }) => `- **v${u.version}** (${u.update_type}, ${new Date(u.published_at).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })}): ${u.title} — ${u.description.slice(0, 150)}`);
    return `**Recent Updates (${data.length}):**\n${lines.join("\n")}`;
  } catch (e) {
    return `TOOL_ERROR: System updates query failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Project Notes ────────────────────────────────────────────────────────────

export async function executeAddProjectNote(
  projectId: string | undefined,
  title: string,
  content: string,
  artifactType: string | undefined,
  userId: string | undefined,
  svc: ReturnType<typeof createClient>,
): Promise<string> {
  if (!projectId) return "TOOL_ERROR: No project context — this tool can only be used inside a project chat.";
  try {
    if (userId) {
      const { data: project } = await svc.from("janus_projects").select("user_id").eq("id", projectId).single();
      if (!project) return "TOOL_ERROR: Project not found.";
      if (project.user_id !== userId) {
        const { data: share } = await svc.from("janus_project_shares").select("id").eq("project_id", projectId).eq("shared_with_user_id", userId).maybeSingle();
        if (!share) return "TOOL_ERROR: You don't have permission to add notes to this project.";
      }
    }

    const finalTitle = title?.trim() || "Untitled";
    if (content.length > 50_000) return "TOOL_ERROR: Content too long (max 50,000 characters).";

    const { count } = await svc.from("janus_project_artifacts").select("id", { count: "exact", head: true }).eq("project_id", projectId);
    const sortOrder = count || 0;

    let displayName = "Janus";
    if (userId) {
      const { data: profile } = await svc.from("profiles").select("display_name").eq("user_id", userId).single();
      if (profile?.display_name) displayName = profile.display_name;
    }

    const { error } = await svc.from("janus_project_artifacts").insert({
      project_id: projectId,
      artifact_type: artifactType || "text",
      title: finalTitle,
      content,
      sort_order: sortOrder,
      saved_by_user_id: userId || null,
      saved_by_display_name: displayName,
    });
    if (error) return `TOOL_ERROR: Failed to save note: ${error.message}`;

    // Fire-and-forget: sync to Notion if the project has a linked page
    try {
      const { data: project } = await svc.from("janus_projects").select("notion_page_id").eq("id", projectId).single();
      if (project?.notion_page_id) {
        const notionText = `📌 ${finalTitle}\n\n${content.slice(0, 1800)}`;
        const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
        const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        fetch(`${SUPABASE_URL}/functions/v1/notion-proxy`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            apikey: SUPABASE_SERVICE_ROLE_KEY,
          },
          body: JSON.stringify({ action: "add-comment", page_id: project.notion_page_id, query: notionText }),
        }).catch(() => {});
      }
    } catch { /* ignore Notion sync errors */ }

    return `Note saved to project: "${finalTitle}"`;
  } catch (e) {
    return `TOOL_ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function executeGetProjectNotes(
  projectId: string | undefined,
  svc: ReturnType<typeof createClient>,
): Promise<string> {
  if (!projectId) return "TOOL_ERROR: No project context — this tool can only be used inside a project chat.";
  try {
    const { data: artifacts, error } = await svc
      .from("janus_project_artifacts")
      .select("id, title, content, artifact_type, created_at, saved_by_display_name")
      .eq("project_id", projectId)
      .order("sort_order", { ascending: true });
    if (error) return `TOOL_ERROR: ${error.message}`;
    if (!artifacts || artifacts.length === 0) return "No notes or artifacts saved to this project yet.";
    const lines = artifacts.map((a: { title?: string; content: string; artifact_type?: string; created_at: string; saved_by_display_name?: string | null }, i: number) => {
      const date = new Date(a.created_at).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" });
      const by = a.saved_by_display_name ? ` (by ${a.saved_by_display_name})` : "";
      const preview = a.content.length > 200 ? a.content.slice(0, 200) + "…" : a.content;
      return `${i + 1}. **${a.title}** [${a.artifact_type}]${by} — ${date}\n   ${preview}`;
    });
    return `**Project Notes (${artifacts.length}):**\n\n${lines.join("\n\n")}`;
  } catch (e) {
    return `TOOL_ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}
