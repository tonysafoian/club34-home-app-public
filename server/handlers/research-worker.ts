import type { Request, Response } from "express";
import { getGoogleServiceToken } from "../utils/google-jwt.js";
import { logAudit } from "../utils/janus-tools.js";
import { fetchT } from "../utils/fetch-timeout.js";
import type { ProfileDisplayNameRow } from "../../shared/dbRows.js";

const JANUS_EMAIL = "assistant@example.com";
const REPORT_URL_REGEX = /https?:\/\/[^\s)\]>"']+/g;
const REPORT_MD_LINK_REGEX = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

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
      [emailType, subject, JSON.stringify(recipients), body, body, status, errorMessage || null]
    );
  } catch (e) {
    console.error("Failed to log email:", e);
  }
}

async function createGoogleDoc(
  title: string,
  markdownContent: string,
  token: string,
): Promise<{ docId: string; docUrl: string }> {
  const createRes = await fetch(
    "https://docs.googleapis.com/v1/documents",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
    },
  );
  if (!createRes.ok)
    throw new Error(`Doc create failed: ${await createRes.text()}`);
  const doc = await createRes.json();
  const docId = doc.documentId;
  const docUrl = `https://docs.google.com/document/d/${docId}`;

  const updateRes = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [
          { insertText: { location: { index: 1 }, text: markdownContent } },
        ],
      }),
    },
  );
  if (!updateRes.ok)
    console.error("Doc batchUpdate warning:", await updateRes.text());

  return { docId, docUrl };
}

async function shareDocWithUser(
  docId: string,
  email: string,
  token: string,
): Promise<void> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${docId}/permissions?sendNotificationEmail=false`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "user",
          role: "reader",
          emailAddress: email,
        }),
      },
    );
    if (!res.ok)
      console.error(`Share with ${email} failed: ${await res.text()}`);
  } catch (e) {
    console.error(`Share error for ${email}:`, e);
  }
}

async function sendRawEmail(
  to: string,
  subjectEncoded: string,
  html: string,
  subjectPlain: string,
  token: string,
): Promise<void> {
  const raw = [
    `From: Janus Research <${JANUS_EMAIL}>`,
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
  const res = await fetch(
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
    await logEmail(
      "janus_research",
      subjectPlain,
      [to],
      html,
      "error",
      `Gmail ${res.status}: ${errText}`,
    );
    throw new Error(`Email send failed: ${res.status} ${errText}`);
  }
  await logEmail("janus_research", subjectPlain, [to], html, "sent");
  console.log(`Research report emailed to ${to}`);
}

async function sendResearchEmail(
  to: string,
  topic: string,
  docUrl: string,
  token: string,
): Promise<void> {
  const subject = `📊 Janus Research Report: ${topic}`;
  const subjectEncoded = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; color: #333;">
      <div style="background: linear-gradient(135deg, #1a1a2e, #16213e); padding: 24px; border-radius: 8px; margin-bottom: 24px;">
        <h1 style="color: #fff; margin: 0; font-size: 22px;">📊 Research Report</h1>
        <p style="color: #aaa; margin: 8px 0 0; font-size: 14px;">${topic}</p>
      </div>
      <p style="font-size: 16px; line-height: 1.6;">Your research report is ready. Click below to view the full document:</p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${docUrl}" style="display: inline-block; background: #1a73e8; color: #fff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-size: 16px; font-weight: bold;">Open Research Report</a>
      </div>
      <p style="color: #666; font-size: 13px;">Or copy this link: <a href="${docUrl}" style="color: #1a73e8;">${docUrl}</a></p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
      <p style="color: #888; font-size: 12px;">Research conducted by Janus using Gemini 2.5 Pro + Perplexity AI deep search + Firecrawl.</p>
    </div>`;
  await sendRawEmail(to, subjectEncoded, html, subject, token);
}

async function sendResearchEmailInline(
  to: string,
  topic: string,
  report: string,
  token: string,
): Promise<void> {
  const subject = `📊 Janus Research Report: ${topic}`;
  const subjectEncoded = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
  const reportHtml = report
    .replace(/^### (.+)$/gm, '<h3 style="color:#1a1a2e;margin:16px 0 8px;">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="color:#1a1a2e;margin:20px 0 10px;">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="color:#1a1a2e;margin:24px 0 12px;">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^- (.+)$/gm, '<li style="margin:4px 0;">$1</li>')
    .replace(/\n\n/g, '</p><p style="margin:10px 0;line-height:1.6;">')
    .replace(/\n/g, "<br>");
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; color: #333;">
      <div style="background: linear-gradient(135deg, #1a1a2e, #16213e); padding: 24px; border-radius: 8px; margin-bottom: 24px;">
        <h1 style="color: #fff; margin: 0; font-size: 22px;">📊 Research Report</h1>
        <p style="color: #aaa; margin: 8px 0 0; font-size: 14px;">${topic}</p>
      </div>
      <div style="font-size: 14px; line-height: 1.6;">
        <p style="margin:10px 0;line-height:1.6;">${reportHtml}</p>
      </div>
      <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
      <p style="color: #f60; font-size: 12px;">⚠️ Google Doc creation was unavailable — report delivered inline.</p>
      <p style="color: #888; font-size: 12px;">Research conducted by Janus using Gemini 2.5 Pro + Perplexity AI deep search + Firecrawl.</p>
    </div>`;
  await sendRawEmail(to, subjectEncoded, html, subject, token);
}

function stripUnsourcedUrls(
  text: string,
  sourceUrls: Set<string>,
): { text: string; strippedCount: number } {
  let strippedCount = 0;

  function isSourced(url: string): boolean {
    const clean = url.replace(/\/+$/, "").replace(/#.*$/, "").split("?")[0];
    for (const src of sourceUrls) {
      const cleanSrc = src.replace(/\/+$/, "").replace(/#.*$/, "").split("?")[0];
      if (
        clean === cleanSrc ||
        clean.startsWith(cleanSrc) ||
        cleanSrc.startsWith(clean)
      )
        return true;
    }
    return false;
  }

  let cleaned = text.replace(
    REPORT_MD_LINK_REGEX,
    (_match, linkText, linkUrl) => {
      const url = linkUrl.replace(/[.,;:!?)]+$/, "");
      if (isSourced(url)) return _match;
      strippedCount++;
      return `**${linkText}**`;
    },
  );

  cleaned = cleaned.replace(REPORT_URL_REGEX, (url) => {
    const cleanUrl = url.replace(/[.,;:!?)]+$/, "");
    if (isSourced(cleanUrl)) return url;
    strippedCount++;
    return "";
  });

  return { text: cleaned, strippedCount };
}

async function perplexitySubQuerySearch(
  query: string,
): Promise<{ answer: string; citations: string[] }> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return { answer: "", citations: [] };
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [
          { role: "system", content: "You are a thorough research assistant. Provide comprehensive, factual answers with specific data, statistics, and examples. Always cite your sources." },
          { role: "user", content: query },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`[Research] Perplexity error ${res.status}`);
      return { answer: "", citations: [] };
    }
    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content || "";
    const citations: string[] = data.citations || [];
    return { answer, citations };
  } catch (e) {
    console.error("[Research] Perplexity sub-query error:", e);
    return { answer: "", citations: [] };
  }
}

async function firecrawlSearch(
  query: string,
): Promise<
  { title: string; url: string; description: string; content?: string }[]
> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, limit: 5 }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("Firecrawl error:", data);
      return [];
    }
    return (data.data || []).map(
      (r: { title?: string; url?: string; description?: string; markdown?: string }) => ({
        title: r.title || "Untitled",
        url: r.url || "",
        description: r.description || "",
        content: r.markdown ? r.markdown.slice(0, 3000) : "",
      }),
    );
  } catch (e) {
    console.error("Firecrawl search error:", e);
    return [];
  }
}

async function callAI(
  systemPrompt: string,
  userContent: string,
  maxTokens = 8000,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");
  const res = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AI Gateway error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "No response generated.";
}

async function resolveProjectTeamEmails(
  projectId: string,
): Promise<string[]> {
  const { query } = await import('../lib/db.js');
  const emails: string[] = [];

  try {
    const { rows: projects } = await query(`SELECT user_id FROM janus_projects WHERE id = $1`, [projectId]);
    const ownerUserId = projects?.[0]?.user_id;

    const { rows: shares } = await query<{ shared_with_user_id: string }>(
      `SELECT shared_with_user_id FROM janus_project_shares WHERE project_id = $1`,
      [projectId],
    );
    const userIds = [
      ownerUserId,
      ...(shares || []).map((share) => share.shared_with_user_id),
    ].filter(Boolean);

    for (const uid of userIds) {
      const { rows: hm } = await query<{ email: string }>(`SELECT email FROM household_members WHERE supabase_uuid = $1`, [uid]);
      if (hm?.[0]?.email) emails.push(hm[0].email);
    }
  } catch (e) {
    console.error("Failed to resolve project team emails:", e);
  }

  return [...new Set(emails)];
}

async function saveProjectArtifact(
  projectId: string,
  topic: string,
  docUrl: string,
  summary: string,
  userId?: string,
): Promise<void> {
  const { query } = await import('../lib/db.js');

  let displayName: string | null = null;
  if (userId) {
    try {
      const { rows } = await query<ProfileDisplayNameRow>(`SELECT display_name FROM profiles WHERE user_id = $1`, [userId]);
      displayName = rows?.[0]?.display_name || null;
    } catch {
      /* skip */
    }
  }

  const content = `📊 **[View Research Report](${docUrl})**\n\n${summary.slice(0, 500)}`;
  try {
    await query(
      `INSERT INTO janus_project_artifacts (project_id, artifact_type, title, content, sort_order, saved_by_user_id, saved_by_display_name) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, "text", `Research: ${topic}`, content, 0, userId || null, displayName || "Janus Research"]
    );
    console.log(`[Research] Saved artifact to project ${projectId}`);
  } catch (e) {
    console.error(`[Research] Artifact save exception:`, e);
    await logEmail(
      "janus_research_artifact_error",
      `Artifact save exception: ${topic}`,
      [projectId],
      String(e),
      "error",
      String(e),
    );
  }
}

async function runResearch(
  topic: string,
  instructions: string,
  emailTo: string,
  projectId?: string,
  userId?: string,
): Promise<void> {
  console.log(`[Research] Starting research on: ${topic}`);

  const planningPrompt = `You are a research planning assistant. Given a research topic and any special instructions, generate 6-8 specific, targeted web search queries that will collectively cover the topic comprehensively.

Return ONLY a JSON array of strings, each being one search query. No explanation, no markdown, just the JSON array.

Topic: ${topic}
Instructions: ${instructions || "Provide a comprehensive, well-sourced research report."}`;

  let searchQueries: string[] = [];
  try {
    const planResponse = await callAI(
      "You are a research planning AI. Return only valid JSON arrays.",
      planningPrompt,
      1000,
    );
    const cleaned = planResponse
      .trim()
      .replace(/^```json?\n?/, "")
      .replace(/\n?```$/, "");
    searchQueries = JSON.parse(cleaned);
    console.log(
      `[Research] Generated ${searchQueries.length} search queries`,
    );
  } catch (e) {
    console.error("[Research] Planning failed, using fallback queries:", e);
    searchQueries = [
      `${topic} overview 2025`,
      `${topic} latest news`,
      `${topic} analysis`,
      `${topic} data statistics`,
    ];
  }

  console.log("[Research] Executing Perplexity deep search + Firecrawl in parallel...");
  const [perplexityResults, firecrawlResults] = await Promise.all([
    Promise.all(searchQueries.slice(0, 8).map((q) => perplexitySubQuerySearch(q))),
    Promise.all(searchQueries.slice(0, 8).map((q) => firecrawlSearch(q))),
  ]);

  const perplexitySyntheses = perplexityResults
    .map((r, i) => ({
      query: searchQueries[i],
      answer: r.answer,
      citations: r.citations,
    }))
    .filter((r) => r.answer.length > 50);
  const allPerplexityCitations = perplexityResults.flatMap((r) => r.citations);
  console.log(`[Research] Perplexity returned ${perplexitySyntheses.length} synthesized answers with ${allPerplexityCitations.length} citations`);

  const allFindings = firecrawlResults.flat();
  const uniqueFindings = allFindings.filter(
    (item, idx, arr) => arr.findIndex((x) => x.url === item.url) === idx,
  );
  console.log(
    `[Research] Firecrawl collected ${uniqueFindings.length} unique sources`,
  );

  const perplexityBlock = perplexitySyntheses.length > 0
    ? `\n\nPERPLEXITY AI PRE-SYNTHESIZED RESEARCH (use these as primary research material):\n${perplexitySyntheses.map((p, i) => `\n--- PERPLEXITY SYNTHESIS ${i + 1} ---\nQuery: ${p.query}\n${p.answer}\nCitations: ${p.citations.join(", ")}`).join("\n")}`
    : "";

  const synthesisContent = `
Research Topic: ${topic}
Special Instructions: ${instructions || "Provide a comprehensive, well-sourced research report."}
${perplexityBlock}

Additional Web Sources Found via Firecrawl:
${uniqueFindings
  .map(
    (r, i) => `
SOURCE ${i + 1}: ${r.title}
URL: ${r.url}
Summary: ${r.description}
${r.content ? `Content:\n${r.content}` : ""}`,
  )
  .join("\n---\n")}

Search Queries Used: ${searchQueries.join(", ")}
`;

  const synthesisSystemPrompt = `You are an expert research analyst for the household administrator — a private estate in Beverly Hills. You have just completed a web research task.

Synthesize the provided research materials into a comprehensive, well-structured report. Use markdown formatting with headers, bullet points, and clear sections. Be thorough, precise, and factual — only state what the sources support.

## CRITICAL URL RULE — HIGHEST PRIORITY
You MUST ONLY use URLs that appear EXACTLY in the source data below. NEVER modify, guess, reconstruct, or fabricate any URL. If a source does not have a working URL, omit the link entirely — just reference the source by name. Copy-paste URLs character-for-character from the SOURCE entries. A broken link is far worse than no link.

Here are the ONLY valid URLs you may reference:
${[...uniqueFindings.filter((r) => r.url).map((r) => r.url), ...allPerplexityCitations].filter(Boolean).map((url) => `• ${url}`).join("\n")}

Structure your report with:
1. Executive Summary (2-3 sentences)
2. Key Findings (bullet points with the most important discoveries)
3. Detailed Analysis (organized by relevant subtopics)
4. Implications & Recommendations (specific to Tony's context where applicable)
5. Sources (list ONLY the exact URLs from above that you referenced)

Be direct and actionable. Tony is a busy executive — respect his time with clear takeaways.`;

  console.log("[Research] Synthesizing...");
  const rawReport = await callAI(synthesisSystemPrompt, synthesisContent, 6000);
  console.log(`[Research] Report generated (${rawReport.length} chars)`);

  const sourceUrlSet = new Set(
    [...uniqueFindings.map((r) => r.url), ...allPerplexityCitations].filter(Boolean) as string[],
  );
  const { text: report, strippedCount } = stripUnsourcedUrls(
    rawReport,
    sourceUrlSet,
  );
  if (strippedCount > 0) {
    console.log(
      `[Research] Stripped ${strippedCount} unsourced/hallucinated URL(s) from report`,
    );
  }

  const token = await getGoogleServiceToken(
    [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive",
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/gmail.send",
    ],
    JANUS_EMAIL,
  );

  let docUrl: string | null = null;

  try {
    const docTitle = `Janus Research: ${topic}`;
    const result = await createGoogleDoc(docTitle, report, token);
    docUrl = result.docUrl;
    console.log(`[Research] Google Doc created: ${docUrl}`);

    await shareDocWithUser(result.docId, emailTo, token);

    if (projectId) {
      const teamEmails = await resolveProjectTeamEmails(projectId);
      for (const email of teamEmails) {
        if (email !== emailTo) {
          await shareDocWithUser(result.docId, email, token);
        }
      }
    }

    await sendResearchEmail(emailTo, topic, docUrl, token);
  } catch (docError) {
    console.error(
      "[Research] Google Doc creation failed, falling back to inline email:",
      docError,
    );
    await logEmail(
      "janus_research_doc_fallback",
      `Doc creation failed: ${topic}`,
      [emailTo],
      String(docError),
      "error",
      String(docError),
    );
    await sendResearchEmailInline(emailTo, topic, report, token);
    console.log("[Research] Fallback inline email sent successfully");
  }

  if (projectId) {
    const summary = report.split("\n").slice(0, 5).join("\n");
    const artifactUrl = docUrl || "Delivered via email (inline)";
    await saveProjectArtifact(projectId, topic, artifactUrl, summary, userId);
  }

  console.log("[Research] Complete!");
}

export async function handleResearchWorker(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body;
    const { topic, instructions, email_to, project_id, user_id } = body;

    if (!topic || !email_to) {
      res
        .status(400)
        .json({ error: "Missing required fields: topic, email_to" });
      return;
    }

    logAudit("janus-research-worker", {
      category: "research",
      event_type: "research_started",
      severity: "info",
      actor_id: user_id || "system", actor_name: user_id ? "UNKNOWN" : "system",
      channel: "web",
      summary: `Research started: "${topic}"`,
      detail: { topic, email_to, project_id },
      status: "success",
    });

    const researchPromise = runResearch(
      topic,
      instructions || "",
      email_to,
      project_id,
      user_id,
    )
      .then(() => {
        logAudit("janus-research-worker", {
          category: "research",
          event_type: "research_complete",
          severity: "info",
          actor_id: user_id || "system", actor_name: user_id ? "UNKNOWN" : "system",
          channel: "web",
          summary: `Research complete: "${topic}"`,
          detail: { topic, email_to },
          status: "success",
        });
      })
      .catch(async (e) => {
        console.error("[Research] Pipeline error:", e);
        await logEmail(
          "janus_research_pipeline_error",
          `Research failed: ${topic}`,
          [email_to],
          String(e),
          "error",
          e instanceof Error ? e.message : String(e),
        );
        logAudit("janus-research-worker", {
          category: "research",
          event_type: "research_error",
          severity: "error",
          actor_id: user_id || "system", actor_name: user_id ? "UNKNOWN" : "system",
          channel: "web",
          summary: `Research failed: "${topic}"`,
          detail: { topic, error: String(e) },
          status: "error",
        });
      });

    researchPromise.catch(() => {});

    res.status(202).json({
      success: true,
      message: `Research on "${topic}" started. A Google Doc will be created and shared, with a link emailed to ${email_to}.`,
    });
  } catch (e) {
    console.error("Research worker error:", e);
    res.status(500).json({
      error: e instanceof Error ? e.message : "unknown",
    });
  }
}
