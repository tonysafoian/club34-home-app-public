import { getServiceClient } from "../janus-tools.js";
import type { SupabaseClient } from "../supabase.js";
import { query } from "../../lib/db.js";

export async function executeLaunchResearch(
  topic: string,
  instructions: string | undefined,
  email_to: string,
  project_id?: string,
  userId?: string,
): Promise<string> {
  try {
    const baseUrl = `http://localhost:${process.env.PORT || 5000}`;
    fetch(`${baseUrl}/api/research/worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, instructions: instructions || "", email_to, project_id: project_id || undefined, user_id: userId || undefined }),
    }).catch((e) => console.error("Research worker fire-and-forget error:", e));
    const projectNote = project_id ? " The report will also be saved to your project." : "";
    return `🔬 Research launched on "${topic}" — a Google Doc will be created and shared, with a link emailed to ${email_to} in ~10 minutes.${projectNote}`;
  } catch (e) {
    return `TOOL_ERROR: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

function reminderWordsOverlap(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3);
  const wordsA = normalize(a);
  const wordsB = new Set(normalize(b));
  if (wordsA.length === 0 || wordsB.size === 0) return false;
  const shared = wordsA.filter(w => wordsB.has(w)).length;
  return shared >= Math.min(3, Math.ceil(wordsA.length * 0.5));
}

export async function checkDuplicateReminder(
  sb: SupabaseClient,
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
  svc?: SupabaseClient,
): Promise<string> {
  try {
    const sb = svc || getServiceClient();
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

interface AppActivityOptions {
  hours?: number;
  category?: string;
  severity?: string;
  status?: string;
  actor?: string;
  source?: string;
  search?: string;
  summary?: boolean;
  limit?: number;
}

function describeActivityFilters(o: AppActivityOptions): string {
  const parts: string[] = [];
  if (o.category) parts.push(`category=${o.category}`);
  if (o.severity) parts.push(`severity=${o.severity}`);
  if (o.status) parts.push(`status=${o.status}`);
  if (o.actor) parts.push(`actor~${o.actor}`);
  if (o.source) parts.push(`source~${o.source}`);
  if (o.search) parts.push(`search~"${o.search}"`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

// Unified reader over the central system_audit_log — the app's activity "nervous
// system". Almost everything that happens anywhere in Club 34 is recorded here.
// Supports filtering by time / area (category) / person (actor) / severity /
// status / source / keyword, plus a summary mode that returns counts-by-area so
// high-volume categories (e.g. automation) can be answered without dumping
// thousands of rows.
async function fetchAppActivity(o: AppActivityOptions): Promise<string> {
  try {
    const hours = Math.min(Math.max(o.hours ?? 24, 1), 720);
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const where: string[] = ["created_at >= $1"];
    const params: unknown[] = [cutoff];
    let p = 2;
    if (o.category) { where.push(`category = $${p++}`); params.push(o.category); }
    if (o.severity) { where.push(`severity = $${p++}`); params.push(o.severity); }
    if (o.status) { where.push(`status = $${p++}`); params.push(o.status); }
    if (o.actor) { where.push(`actor_name ILIKE $${p++}`); params.push(`%${o.actor}%`); }
    if (o.source) { where.push(`edge_function ILIKE $${p++}`); params.push(`%${o.source}%`); }
    if (o.search) {
      where.push(`(summary ILIKE $${p} OR event_type ILIKE $${p} OR edge_function ILIKE $${p} OR actor_name ILIKE $${p})`);
      params.push(`%${o.search}%`);
      p++;
    }
    const whereSql = where.join(" AND ");
    const filterDesc = describeActivityFilters(o);

    if (o.summary) {
      const { rows } = await query(
        `SELECT category,
                count(*)::int AS n,
                count(*) FILTER (WHERE severity IN ('warn', 'warning'))::int AS warns,
                count(*) FILTER (WHERE severity IN ('error', 'critical') OR status IN ('error', 'failed'))::int AS errors,
                max(created_at) AS latest
         FROM system_audit_log
         WHERE ${whereSql}
         GROUP BY category
         ORDER BY n DESC`,
        params,
      );
      if (!rows.length) return `No app activity in the last ${hours}h${filterDesc}.`;
      const total = rows.reduce((s: number, r: any) => s + Number(r.n), 0);
      const lines = rows.map((r: any) => {
        const t = new Date(r.latest).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        const flags = [Number(r.errors) > 0 ? `${r.errors} err` : null, Number(r.warns) > 0 ? `${r.warns} warn` : null].filter(Boolean).join(", ");
        return `- **${r.category || "uncategorized"}**: ${r.n} events${flags ? ` (${flags})` : ""} — last ${t}`;
      });
      return `**App Activity Summary (last ${hours}h${filterDesc}) — ${total} events across ${rows.length} area(s)**\n${lines.join("\n")}\n\n_Drill into an area with category=<name> (add severity=warn|error|critical to cut routine noise, actor=<name>, or search=<keyword>), or set summary=false to list individual events._`;
    }

    const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
    const { rows } = await query(
      `SELECT created_at, category, event_type, severity, summary, actor_name, status, edge_function
       FROM system_audit_log
       WHERE ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${p}`,
      [...params, limit],
    );
    if (!rows.length) return `No app activity found in the last ${hours}h${filterDesc}.`;
    const lines = rows.map((e: any) => {
      const t = new Date(e.created_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const actor = e.actor_name ? ` by ${e.actor_name}` : "";
      const st = e.status && e.status !== "success" && e.status !== "logged" ? ` [${e.status}]` : "";
      const cat = e.category ? `${e.category}/` : "";
      return `- ${t} [${e.severity}] ${cat}${e.event_type}${st}${actor}: ${e.summary}`;
    });
    const more = rows.length === limit ? `\n_(showing latest ${limit} — narrow with filters or use summary=true for an overview)_` : "";
    return `**App Activity (last ${hours}h${filterDesc}, ${rows.length} event(s))**\n${lines.join("\n")}${more}`;
  } catch (e) {
    return `TOOL_ERROR: App activity query failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// Quick recent-activity feed. Repointed from the (empty/legacy) activity_events
// table to the live system_audit_log so it returns real data on every channel.
// For filtered or aggregated questions, prefer the richer search_system_events.
// svc is kept for signature/back-compat; the read now goes straight to Postgres.
export async function executeQueryActivityLog(eventType: string | undefined, hours: number | undefined, _svc?: SupabaseClient): Promise<string> {
  return fetchAppActivity({ search: eventType, hours });
}

export async function executeQuerySystemHealth(svc: SupabaseClient): Promise<string> {
  try {
    const lines: string[] = [];

    const { data: health } = await svc.from("janus_health_logs").select("*").order("created_at", { ascending: false }).limit(1).single();
    if (health) {
      lines.push(`**Last Health Check:** ${health.overall_status.toUpperCase()} (${health.total_ms}ms, ${new Date(health.created_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })})`);
      const results = health.results as any[];
      if (Array.isArray(results)) {
        const failed = results.filter((r: any) => r.status !== "ok" && r.status !== "pass");
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

export async function executeQuerySystemUpdates(limit: number | undefined, svc: SupabaseClient): Promise<string> {
  try {
    const { data, error } = await svc.from("system_updates").select("*").order("published_at", { ascending: false }).limit(limit || 5);
    if (error) return `TOOL_ERROR: ${error.message}`;
    if (!data?.length) return "No system updates found.";
    const lines = data.map((u: any) => `- **v${u.version}** (${u.update_type}, ${new Date(u.published_at).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })}): ${u.title} — ${u.description.slice(0, 150)}`);
    return `**Recent Updates (${data.length}):**\n${lines.join("\n")}`;
  } catch (e) {
    return `TOOL_ERROR: System updates query failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// Thin wrapper over fetchAppActivity. Positional params 1-5 are kept for
// back-compat (existing callers + standalone test); the richer filters
// (actor / status / source / summary) are appended after svc.
export async function executeSearchSystemEvents(
  hours: number | undefined,
  category: string | undefined,
  severity: string | undefined,
  search: string | undefined,
  _svc?: SupabaseClient,
  actor?: string,
  status?: string,
  source?: string,
  summary?: boolean,
): Promise<string> {
  return fetchAppActivity({ hours, category, severity, search, actor, status, source, summary });
}

export async function executeGetNetworkHistory(hours: number | undefined): Promise<string> {
  try {
    const h = Math.min(hours || 6, 48);
    const cutoff = new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
    const { rows } = await query(
      `SELECT captured_at, cpu_usage, memory_usage, active_sessions, wan_status, threat_count
       FROM network_health_snapshots
       WHERE captured_at >= $1
       ORDER BY captured_at DESC
       LIMIT 50`,
      [cutoff],
    );
    if (!rows.length) return `No network health snapshots in the last ${h}h.`;
    const lines = rows.map((r: any) => {
      const t = new Date(r.captured_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const wan = r.wan_status ? ` WAN:${r.wan_status}` : "";
      const threats = r.threat_count > 0 ? ` threats:${r.threat_count}` : "";
      return `- ${t} CPU:${r.cpu_usage ?? "?"}% MEM:${r.memory_usage ?? "?"}% sessions:${r.active_sessions ?? "?"}${wan}${threats}`;
    });
    const latestWan = rows[0]?.wan_status;
    const avgCpu = rows.reduce((s: number, r: any) => s + (Number(r.cpu_usage) || 0), 0) / rows.length;
    const avgMem = rows.reduce((s: number, r: any) => s + (Number(r.memory_usage) || 0), 0) / rows.length;
    return `**Network Health (last ${h}h, ${rows.length} snapshots)**\nCurrent WAN: ${latestWan || "unknown"} | Avg CPU: ${avgCpu.toFixed(1)}% | Avg MEM: ${avgMem.toFixed(1)}%\n\n${lines.join("\n")}`;
  } catch (e) {
    return `TOOL_ERROR: Network history query failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function executeAddProjectNote(
  projectId: string | undefined,
  title: string,
  content: string,
  artifactType: string | undefined,
  userId: string | undefined,
  svc: SupabaseClient,
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

    try {
      const { data: project } = await svc.from("janus_projects").select("notion_page_id").eq("id", projectId).single();
      if (project?.notion_page_id) {
        const notionText = `📌 ${finalTitle}\n\n${content.slice(0, 1800)}`;
        const baseUrl = `http://localhost:${process.env.PORT || 5000}`;
        fetch(`${baseUrl}/api/notion/proxy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
  svc: SupabaseClient,
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
    const lines = artifacts.map((a: any, i: number) => {
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
