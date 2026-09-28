/**
 * Janus Skills framework.
 *
 * Modular SKILL.md files under skills/janus/<slug>/SKILL.md are the SOURCE OF
 * TRUTH. At boot they are one-way synced (file -> DB) into the janus_skills
 * table: when a file's content hash differs from the DB row, the file wins. The
 * server never writes the repo files back.
 *
 * Runtime reads the lightweight index + full bodies from the DB, cached for 5
 * minutes (same pattern as loadPrompt). Janus sees skills two ways:
 *   1. An always-on, role/channel-filtered "Skills Index" (slug + description)
 *      injected into the system prompt by each handler.
 *   2. A load_skill(slug) tool that returns the full skill body on demand.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { query } from "../lib/db.js";
import { logAudit } from "./janus-tools.js";

export type SkillChannel = "chat" | "whatsapp" | "email";

interface ParsedSkill {
  slug: string;
  name: string;
  description: string;
  channels: string[];
  roles: string[];
  body: string;
  hash: string;
}

const SKILLS_DIR = path.resolve(process.cwd(), "skills", "janus");
const DEFAULT_CHANNELS = ["chat", "whatsapp", "email"];
const DEFAULT_ROLES = ["admin", "member"];

// ---- frontmatter parsing (no yaml dependency) -----------------------------

function parseInlineList(value: string): string[] {
  const m = value.match(/^\[(.*)\]$/);
  const inner = m ? m[1] : value;
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function parseSkillFile(slug: string, raw: string): ParsedSkill | null {
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!fm) {
    console.error(`[janus-skills] ${slug}: missing frontmatter, skipping`);
    return null;
  }
  const [, frontmatter, rawBody] = fm;
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key) fields[key] = line.slice(idx + 1).trim();
  }
  const name = stripQuotes(fields.name || slug);
  const description = stripQuotes(fields.description || "");
  const channels = fields.channels ? parseInlineList(fields.channels) : [...DEFAULT_CHANNELS];
  const roles = fields.roles ? parseInlineList(fields.roles) : [...DEFAULT_ROLES];
  const body = rawBody.trim();
  const hash = createHash("sha256")
    .update(JSON.stringify({ name, description, channels, roles, body }))
    .digest("hex");
  return { slug, name, description, channels, roles, body, hash };
}

export function loadSkillFiles(): ParsedSkill[] {
  if (!existsSync(SKILLS_DIR)) {
    console.warn(`[janus-skills] skills dir not found: ${SKILLS_DIR}`);
    return [];
  }
  const out: ParsedSkill[] = [];
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      const parsed = parseSkillFile(entry.name, readFileSync(file, "utf8"));
      if (parsed) out.push(parsed);
    } catch (e) {
      console.error(`[janus-skills] failed to read ${file}:`, e);
    }
  }
  return out;
}

// ---- one-way file -> DB sync (boot) ---------------------------------------

export async function syncJanusSkills(): Promise<{ synced: number; total: number }> {
  const files = loadSkillFiles();
  let synced = 0;
  for (const s of files) {
    try {
      const existing = await query(`SELECT hash FROM janus_skills WHERE slug = $1`, [s.slug]);
      if (existing.rows[0]?.hash === s.hash) continue; // up to date
      await query(
        `INSERT INTO janus_skills (slug, name, description, channels, roles, body, hash, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           channels = EXCLUDED.channels,
           roles = EXCLUDED.roles,
           body = EXCLUDED.body,
           hash = EXCLUDED.hash,
           updated_at = NOW()`,
        [s.slug, s.name, s.description, s.channels, s.roles, s.body, s.hash],
      );
      synced++;
    } catch (e) {
      console.error(`[janus-skills] sync failed for "${s.slug}":`, e);
    }
  }
  // Repo is the source of truth: drop DB rows whose file no longer exists. Guard
  // on a non-empty file list so a transient read failure can't wipe the table.
  if (files.length > 0) {
    try {
      await query(`DELETE FROM janus_skills WHERE slug <> ALL($1::text[])`, [files.map((f) => f.slug)]);
    } catch (e) {
      console.error("[janus-skills] prune failed:", e);
    }
  }
  invalidateSkillsCache();
  if (synced > 0) console.log(`[janus-skills] synced ${synced}/${files.length} skill(s) to DB`);
  return { synced, total: files.length };
}

// ---- runtime reads (cached) -----------------------------------------------

interface SkillRow {
  slug: string;
  name: string;
  description: string;
  channels: string[];
  roles: string[];
  body: string;
}

let skillsCache: { rows: SkillRow[]; fetchedAt: number } | null = null;
const SKILLS_CACHE_TTL = 5 * 60_000;

export function invalidateSkillsCache(): void {
  skillsCache = null;
}

async function getAllSkills(): Promise<SkillRow[]> {
  if (skillsCache && Date.now() - skillsCache.fetchedAt < SKILLS_CACHE_TTL) return skillsCache.rows;
  try {
    const { rows } = await query<SkillRow>(
      `SELECT slug, name, description, channels, roles, body FROM janus_skills ORDER BY slug`,
    );
    skillsCache = { rows, fetchedAt: Date.now() };
    return skillsCache.rows;
  } catch (e) {
    console.error("[janus-skills] getAllSkills failed:", e);
    return skillsCache?.rows ?? [];
  }
}

function isVisible(skill: SkillRow, role: string, channel: SkillChannel): boolean {
  const roleOk = !skill.roles?.length || skill.roles.includes(role);
  const channelOk = !skill.channels?.length || skill.channels.includes(channel);
  return roleOk && channelOk;
}

/**
 * Always-on, role/channel-filtered index injected into the system prompt.
 * Returns "" when no skills are visible (so nothing is added to the prompt).
 */
export async function getSkillsIndexBlock(role: string, channel: SkillChannel): Promise<string> {
  const skills = (await getAllSkills()).filter((s) => isVisible(s, role, channel));
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.slug}: ${s.description}`);
  return (
    `\n\n── JANUS SKILLS (load before acting) ──\n` +
    `You have detailed skill modules for specific areas. When a request touches one ` +
    `of these areas, call load_skill(slug) FIRST to load its full instructions, then ` +
    `act on them. Available skills:\n` +
    lines.join("\n") +
    `\nOnly these slugs are valid. If the area you need isn't listed, proceed without a skill.`
  );
}

/**
 * load_skill dispatch. Validates the slug, gates by role/channel, audits the
 * load, and returns the full body (or a plain-text error the model can relay).
 */
export async function executeLoadSkill(
  slug: string,
  role: string,
  channel: SkillChannel,
  userId?: string,
): Promise<string> {
  const wanted = (slug || "").trim().toLowerCase();
  const skills = await getAllSkills();
  const visibleSlugs = skills.filter((s) => isVisible(s, role, channel)).map((s) => s.slug);
  const skill = skills.find((s) => s.slug === wanted);
  if (!skill) {
    return `No skill named "${slug}". Valid skills: ${visibleSlugs.join(", ") || "(none)"}.`;
  }
  if (!isVisible(skill, role, channel)) {
    return `The "${skill.slug}" skill isn't available on this channel or to your role.`;
  }
  logAudit("janus-skills", {
    category: "janus",
    event_type: "skill_loaded",
    severity: "info",
    actor_id: userId,
    actor_role: role,
    channel,
    summary: `Loaded skill: ${skill.slug}`,
    detail: { slug: skill.slug, name: skill.name },
    status: "success",
  }).catch(() => {});
  return `# Skill: ${skill.name}\n\n${skill.body}`;
}

export const LOAD_SKILL_TOOL = {
  type: "function" as const,
  function: {
    name: "load_skill",
    description:
      "Load a Janus skill module — a detailed playbook for a specific area (e.g. controlling home devices, working with Notion tasks, investigating app activity). Call this FIRST, before acting, whenever a request touches a listed skill area. Returns the full instructions for that skill. Only use slugs shown in the JANUS SKILLS index.",
    parameters: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "The skill slug to load, exactly as listed in the JANUS SKILLS index (e.g. 'home-automation').",
        },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
};
