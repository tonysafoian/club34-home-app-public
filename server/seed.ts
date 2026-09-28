import fs from "fs";
import path from "path";
import { storage } from "./storage";
import { query } from "./lib/db";
import { syncJanusSkills } from "./utils/janus-skills";

function loadSoulMd(): string {
  try {
    return fs.readFileSync(path.resolve(process.cwd(), "supabase/functions/_shared/SOUL.md"), "utf8");
  } catch {
    return "You are Janus, the AI assistant for your smart home.";
  }
}

export async function seedDatabase(): Promise<void> {
  const existingConfig = await storage.getSystemConfig("app_version");
  if (!existingConfig) {
    console.log("[SEED] Seeding system_configs...");
    await storage.upsertSystemConfig({
      key: "app_version",
      value: "1.0.0",
      description: "Current application version",
    });
    await storage.upsertSystemConfig({
      key: "alert_phone_number",
      value: "",
      description: "Phone number for system alerts (WhatsApp)",
    });
    await storage.upsertSystemConfig({
      key: "maintenance_mode",
      value: "false",
      description: "Whether the app is in maintenance mode",
    });
  }

  await applyInlineMigrations();
  await migrateOldPromptSlugs();
  await seedSystemPrompts();
  await seedHouseholdMembers();
  await seedFamilyAutomations();
  await seedHouseholdPhoneNumbers();
  await seedInvitedEmails();
  await syncJanusSkills();

  console.log("[SEED] Database seeding complete.");
}

// ── Inline Migrations ────────────────────────────────────────────────────────
// Tables that don't yet exist in the Drizzle journal are created here using
// CREATE TABLE IF NOT EXISTS so they are applied automatically on server start.

async function applyInlineMigrations(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS thermostat_logs (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
        entity_id text NOT NULL,
        friendly_name text,
        current_temperature numeric(6, 2),
        target_temperature numeric(6, 2),
        hvac_mode text,
        hvac_action text,
        logged_at timestamp with time zone DEFAULT now() NOT NULL
      )
    `);
    // Indexes (IF NOT EXISTS is idempotent)
    await query(`CREATE INDEX IF NOT EXISTS thermostat_logs_entity_id_idx ON thermostat_logs (entity_id)`);
    await query(`CREATE INDEX IF NOT EXISTS thermostat_logs_logged_at_idx ON thermostat_logs (logged_at DESC)`);
    console.log("[SEED] Inline migration: thermostat_logs table ensured.");
  } catch (err: any) {
    console.error("[SEED] Inline migration failed:", err.message);
  }

  // Add amazon_url column to grocery_staples if missing (added in task #323)
  try {
    await query(`ALTER TABLE grocery_staples ADD COLUMN IF NOT EXISTS amazon_url TEXT`);
  } catch (err: any) {
    console.error("[SEED] Inline migration grocery_staples.amazon_url failed:", err.message);
  }

  // Add image_url column to shopping_cart_items if missing (added in task #336)
  try {
    await query(`ALTER TABLE shopping_cart_items ADD COLUMN IF NOT EXISTS image_url TEXT`);
  } catch (err: any) {
    console.error("[SEED] Inline migration shopping_cart_items.image_url failed:", err.message);
  }

  // Add owner column to device_overrides (authoritative override store for Admin Network)
  try {
    await query(`ALTER TABLE device_overrides ADD COLUMN IF NOT EXISTS owner TEXT`);
    console.log("[SEED] Inline migration: device_overrides.owner ensured.");
  } catch (err: any) {
    console.error("[SEED] Inline migration device_overrides.owner failed:", err.message);
  }

  // Add trusted/is_random/first_seen/last_seen/notes to device_overrides
  try {
    await query(`ALTER TABLE device_overrides ADD COLUMN IF NOT EXISTS trusted BOOLEAN NOT NULL DEFAULT FALSE`);
    await query(`ALTER TABLE device_overrides ADD COLUMN IF NOT EXISTS is_random BOOLEAN NOT NULL DEFAULT FALSE`);
    await query(`ALTER TABLE device_overrides ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ`);
    await query(`ALTER TABLE device_overrides ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ`);
    await query(`ALTER TABLE device_overrides ADD COLUMN IF NOT EXISTS notes TEXT`);
    console.log("[SEED] Inline migration: device_overrides extended fields ensured.");
  } catch (err: any) {
    console.error("[SEED] Inline migration device_overrides extended fields failed:", err.message);
  }

  // Canonical device categories table
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS device_categories (
        id serial PRIMARY KEY,
        name text NOT NULL UNIQUE,
        sort_order integer NOT NULL DEFAULT 0,
        description text
      )
    `);
    console.log("[SEED] Inline migration: device_categories table ensured.");
  } catch (err: any) {
    console.error("[SEED] Inline migration device_categories failed:", err.message);
  }

  // Vendor → category rule table (used alongside the in-code TYPE_RULES for
  // future DB-backed overrides and external tool queries)
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS vendor_category_rules (
        id serial PRIMARY KEY,
        match_keyword text NOT NULL,
        category text NOT NULL,
        subcategory text,
        vendor_label text,
        priority integer NOT NULL DEFAULT 100,
        notes text
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS vendor_category_rules_keyword_idx ON vendor_category_rules (match_keyword)`);
    console.log("[SEED] Inline migration: vendor_category_rules table ensured.");
  } catch (err: any) {
    console.error("[SEED] Inline migration vendor_category_rules failed:", err.message);
  }

  await seedDeviceCategories();
  await seedVendorCategoryRules();
}


// ── Device Category & Vendor Rule Seed ───────────────────────────────────────

const CANONICAL_CATEGORIES = [
  { name: 'Network Infrastructure',    sortOrder: 1,  description: 'Switches, routers, firewalls, access points' },
  { name: 'Security Cameras',          sortOrder: 2,  description: 'IP cameras, NVRs, doorbells' },
  { name: 'Smart TVs & Streaming',     sortOrder: 3,  description: 'Smart TVs, streaming sticks, media boxes' },
  { name: 'Smart Speakers',            sortOrder: 4,  description: 'Voice-assistant speakers and sound bars' },
  { name: 'AV Systems',                sortOrder: 5,  description: 'Whole-home AV controllers, amplifiers, racks' },
  { name: 'Thermostats',               sortOrder: 6,  description: 'Smart thermostats and HVAC controllers' },
  { name: 'Lighting & Switches',       sortOrder: 7,  description: 'Smart lighting, dimmers, switches' },
  { name: 'Printers',                  sortOrder: 8,  description: 'Printers and multi-function devices' },
  { name: 'Gaming Consoles',           sortOrder: 9,  description: 'Xbox, PlayStation, Nintendo' },
  { name: 'Virtual Machines',          sortOrder: 10, description: 'VMware, VirtualBox, Parallels VMs' },
  { name: 'Cars',                      sortOrder: 11, description: 'Connected vehicles' },
  { name: 'Computers & Laptops',       sortOrder: 12, description: 'Desktops, laptops, servers' },
  { name: 'Mobile Phones & Tablets',   sortOrder: 13, description: 'Smartphones and tablets' },
  { name: 'IoT Devices',               sortOrder: 14, description: 'Smart home sensors, Tuya, ESP32 and similar chips' },
  { name: 'Smart Gate Devices',        sortOrder: 15, description: 'Gate intercoms, access panels, LiftMaster, 2N' },
  { name: 'Electricity Monitoring',    sortOrder: 16, description: 'Energy monitors (Emporia, etc.)' },
  { name: 'People / Personal Devices', sortOrder: 17, description: 'Randomized-MAC personal devices (phones, laptops)' },
  { name: 'Unknown / Uncategorized',   sortOrder: 18, description: 'Devices that could not be classified automatically' },
];

async function seedDeviceCategories(): Promise<void> {
  try {
    const { rows } = await query(`SELECT COUNT(*) AS n FROM device_categories`);
    const count = parseInt((rows[0] as { n: string }).n, 10);
    if (count >= CANONICAL_CATEGORIES.length) return; // already seeded
    for (const cat of CANONICAL_CATEGORIES) {
      await query(
        `INSERT INTO device_categories (name, sort_order, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET sort_order = EXCLUDED.sort_order, description = EXCLUDED.description`,
        [cat.name, cat.sortOrder, cat.description],
      );
    }
    console.log(`[SEED] Device categories seeded (${CANONICAL_CATEGORIES.length} rows).`);
  } catch (err: any) {
    console.error("[SEED] seedDeviceCategories failed:", err.message);
  }
}

// Vendor keywords → category mapping.  These mirror the in-code TYPE_RULES /
// OUI_MAP so that external tools can query the DB without running the classifier.
const VENDOR_RULES: Array<{ matchKeyword: string; category: string; subcategory?: string; vendorLabel?: string; priority: number; notes?: string }> = [
  { matchKeyword: 'verkada',      category: 'Security Cameras',       subcategory: 'Security Cameras',       vendorLabel: 'Verkada',       priority: 10 },
  { matchKeyword: 'axis',         category: 'Security Cameras',       subcategory: 'Security Cameras',       vendorLabel: 'Axis',          priority: 10 },
  { matchKeyword: 'ruckus',       category: 'Network Infrastructure', subcategory: 'Access Points',          vendorLabel: 'Ruckus',        priority: 10 },
  { matchKeyword: 'aruba',        category: 'Network Infrastructure', subcategory: 'Access Points',          vendorLabel: 'Aruba',         priority: 10 },
  { matchKeyword: 'ubiquiti',     category: 'Network Infrastructure', subcategory: 'Access Points',          vendorLabel: 'Ubiquiti',      priority: 10 },
  { matchKeyword: 'fortinet',     category: 'Network Infrastructure', subcategory: 'Firewalls',              vendorLabel: 'Fortinet',      priority: 10 },
  { matchKeyword: 'cisco',        category: 'Network Infrastructure', subcategory: 'Switches',               vendorLabel: 'Cisco',         priority: 10 },
  { matchKeyword: 'netgear',      category: 'Network Infrastructure', subcategory: 'Switches',               vendorLabel: 'Netgear',       priority: 10 },
  { matchKeyword: 'commscope',    category: 'Network Infrastructure', subcategory: 'Switches',               vendorLabel: 'CommScope',     priority: 10 },
  { matchKeyword: 'crestron',     category: 'AV Systems',             subcategory: 'AV Systems',             vendorLabel: 'Crestron',      priority: 20 },
  { matchKeyword: 'sonance',      category: 'AV Systems',             subcategory: 'AV Systems',             vendorLabel: 'Sonance',       priority: 20 },
  { matchKeyword: 'snapav',       category: 'AV Systems',             subcategory: 'AV Systems',             vendorLabel: 'SnapAV',        priority: 20 },
  { matchKeyword: 'control4',     category: 'AV Systems',             subcategory: 'AV Systems',             vendorLabel: 'Control4',      priority: 20 },
  { matchKeyword: 'sonos',        category: 'Smart Speakers',         subcategory: 'Smart Speakers',         vendorLabel: 'Sonos',         priority: 20 },
  { matchKeyword: 'ecobee',       category: 'Thermostats',            subcategory: 'Thermostats',            vendorLabel: 'Ecobee',        priority: 20 },
  { matchKeyword: 'lutron',       category: 'Lighting & Switches',    subcategory: 'Lighting & Switches',    vendorLabel: 'Lutron',        priority: 20 },
  { matchKeyword: 'philips hue',  category: 'Lighting & Switches',    subcategory: 'Lighting & Switches',    vendorLabel: 'Philips Hue',   priority: 20 },
  { matchKeyword: 'chamberlain',  category: 'Smart Gate Devices',     subcategory: 'Smart Gate Devices',     vendorLabel: 'Chamberlain',   priority: 20 },
  { matchKeyword: 'liftmaster',   category: 'Smart Gate Devices',     subcategory: 'Smart Gate Devices',     vendorLabel: 'LiftMaster',    priority: 20 },
  { matchKeyword: '2n',           category: 'Smart Gate Devices',     subcategory: 'Smart Gate Devices',     vendorLabel: '2N',            priority: 20 },
  { matchKeyword: 'emporia',      category: 'Electricity Monitoring', subcategory: 'Electricity Monitoring', vendorLabel: 'Emporia',       priority: 20 },
  { matchKeyword: 'tuya',         category: 'IoT Devices',            subcategory: 'IoT Devices',            vendorLabel: 'Tuya',          priority: 20 },
  { matchKeyword: 'tesla',        category: 'Cars',                   subcategory: 'Cars',                   vendorLabel: 'Tesla',         priority: 20 },
  { matchKeyword: 'vmware',       category: 'Virtual Machines',       subcategory: 'VMware',                 vendorLabel: 'VMware',        priority: 20 },
  { matchKeyword: 'roku',         category: 'Smart TVs & Streaming',  subcategory: 'Smart TVs & Streaming',  vendorLabel: 'Roku',          priority: 30 },
  { matchKeyword: 'chromecast',   category: 'Smart TVs & Streaming',  subcategory: 'Smart TVs & Streaming',  vendorLabel: 'Google',        priority: 30 },
  { matchKeyword: 'apple',        category: 'Computers & Laptops',    subcategory: 'Computers & Laptops',    vendorLabel: 'Apple',         priority: 50, notes: 'Generic Apple; specific rules in-code take precedence' },
  { matchKeyword: 'samsung',      category: 'Smart TVs & Streaming',  subcategory: 'Smart TVs & Streaming',  vendorLabel: 'Samsung',       priority: 50, notes: 'Generic Samsung; specific rules in-code take precedence' },
  { matchKeyword: 'amazon',       category: 'Smart Speakers',         subcategory: 'Smart Speakers',         vendorLabel: 'Amazon',        priority: 50, notes: 'Generic Amazon; specific rules in-code take precedence' },
];

async function seedVendorCategoryRules(): Promise<void> {
  try {
    let updated = 0;
    let inserted = 0;
    for (const rule of VENDOR_RULES) {
      const upd = await query(
        `UPDATE vendor_category_rules
         SET category=$2, subcategory=$3, vendor_label=$4, priority=$5, notes=$6
         WHERE match_keyword=$1`,
        [rule.matchKeyword, rule.category, rule.subcategory ?? null, rule.vendorLabel ?? null, rule.priority, rule.notes ?? null],
      );
      if ((upd.rowCount ?? 0) === 0) {
        await query(
          `INSERT INTO vendor_category_rules (match_keyword, category, subcategory, vendor_label, priority, notes)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [rule.matchKeyword, rule.category, rule.subcategory ?? null, rule.vendorLabel ?? null, rule.priority, rule.notes ?? null],
        );
        inserted++;
      } else {
        updated++;
      }
    }
    console.log(`[SEED] Vendor category rules: ${inserted} inserted, ${updated} updated.`);
  } catch (err: any) {
    console.error("[SEED] seedVendorCategoryRules failed:", err.message);
  }
}

const LEGACY_PLACEHOLDER_CONTENT: Record<string, string> = {
  "janus-system": "You are Janus, the AI chief-of-staff for the smart household.",
  "janus-whatsapp": "You are Janus, responding via WhatsApp. Keep responses concise and actionable.",
  "janus-email": "You are Janus, responding via email. Use proper formatting and structure.",
};

async function migrateOldPromptSlugs(): Promise<void> {
  const migrations = [
    { oldSlug: "janus-system", newSlug: "janus-core" },
    { oldSlug: "janus-whatsapp", newSlug: "janus-whatsapp-addendum" },
    { oldSlug: "janus-email", newSlug: "janus-email-addendum" },
  ];

  for (const { oldSlug, newSlug } of migrations) {
    const { rows: oldRows } = await query<{ id: string; content: string | null }>(
      `SELECT id, content FROM system_prompts WHERE slug = $1`,
      [oldSlug]
    );
    if (oldRows.length === 0) continue;

    const { rows: newRows } = await query<{ id: string; content: string | null }>(
      `SELECT id, content FROM system_prompts WHERE slug = $1`,
      [newSlug]
    );

    const oldContent = (oldRows[0].content ?? "").trim();
    const legacyContent = (LEGACY_PLACEHOLDER_CONTENT[oldSlug] ?? "").trim();
    const oldIsPlaceholder = oldContent === legacyContent;

    if (newRows.length === 0) {
      await query(
        `UPDATE system_prompts SET slug = $1, updated_at = NOW() WHERE slug = $2`,
        [newSlug, oldSlug]
      );
      const note = oldIsPlaceholder ? "placeholder content — seedSystemPrompts will upgrade" : "custom content preserved";
      console.log(`[SEED] Migrated prompt slug "${oldSlug}" → "${newSlug}" (${note}).`);
    } else {
      const newContent = (newRows[0].content ?? "").trim();
      const newIsPlaceholder = newContent === "" || newContent === legacyContent;

      if (!oldIsPlaceholder && newIsPlaceholder) {
        await query(
          `UPDATE system_prompts SET content = $1, updated_at = NOW() WHERE slug = $2`,
          [oldRows[0].content, newSlug]
        );
        console.log(`[SEED] "${newSlug}" had placeholder content — promoted custom content from "${oldSlug}".`);
      } else if (!oldIsPlaceholder && !newIsPlaceholder) {
        console.log(`[SEED] Both "${oldSlug}" and "${newSlug}" have custom content — keeping "${newSlug}" as authoritative.`);
      } else {
        console.log(`[SEED] "${oldSlug}" is a placeholder; "${newSlug}" already exists — no content change needed.`);
      }
      await query(`DELETE FROM system_prompts WHERE slug = $1`, [oldSlug]);
      console.log(`[SEED] Removed legacy slug "${oldSlug}" from DB.`);
    }
  }
}

async function seedSystemPrompts(): Promise<void> {
  const soulMd = loadSoulMd();

  const chatAddendum = `## Chat Channel — Behavior Addendum

### Markdown Formatting
- Full markdown is supported in the chat interface. Use it intentionally.
- **Headers** (##, ###): Use for multi-section responses (e.g., briefings, reports, project summaries).
- **Bold**: Highlight key facts, names, or decisions — not for decoration.
- **Bullet lists**: Use for 3+ items. Never use bullets for a single item — just write the sentence.
- **Tables**: Use for structured data (schedules, comparisons, inventories). Keep columns tight.
- **Code blocks**: For technical content, entity IDs, or exact strings to copy-paste.
- **Inline links**: Always use markdown links \`[text](url)\` — never bare URLs.

### App Navigation Links
When referencing Janus app sections, use exact routes as markdown links. Examples:
- [Dashboard](/) — today's overview, calendar, tasks
- [Security](/security) — Verkada feeds, POI, access logs
- [Tesla](/teslas) — vehicle status, battery, location
- [Home Systems](/home-systems) — pool, generator, garage, sauna, HA
- [Family](/family) — travel, entertainment, calendar
- [Automations](/automations) — weather emails, health checks, monitors
- [Activity](/activity) — household event log
- [Projects](/projects) — research workspaces
- [Common Tasks](/common-tasks) — shopping cart, ordering
- [Weather](/weather) — conditions, forecast, air quality
- [Settings](/settings) — credentials, integrations
- [Admin](/admin) — users, Notion, logs

### When to Answer Directly vs. "Check the App"
- **Answer directly** when you have the data in the live briefing or can retrieve it via a tool call in <5 seconds.
- **Suggest checking the app** when: the user wants to browse/explore (not query), the data involves a visual feed (Verkada cameras), or the user asks to "see" something interactive.
- Never say "check the app" as a deflection when you have the answer. Use it only when the app genuinely provides a better experience.

### Data Tables and Dashboards
- When presenting structured data (inventory, task lists, schedules), default to a markdown table.
- Cap tables at 10 rows inline. For larger datasets, summarize the top rows and offer to export or link to the relevant app section.
- Lead with the most relevant rows (e.g., overdue tasks first, soonest events first).

### Multi-Tool Step Feedback
- For operations with 3+ sequential steps, give a brief status update before starting: "Let me check the calendar, find a slot, and create the event."
- After each major step in a long operation, you may note progress — but keep it to one line per step.
- On completion, one clean summary sentence. No step-by-step recap unless asked.`;

  const whatsappAddendum = `## WhatsApp Channel — Behavior Addendum

### Plain Text Only
- No markdown formatting of any kind. No asterisks, no headers, no bullet dashes rendered as markdown.
- Use line breaks (actual newlines) to separate sections when needed — but keep them minimal.
- Emoji are permitted sparingly. Use only when natural and contextually appropriate — not as decoration.

### Message Length
- Default: 1–3 sentences max. If the user asks for detail, go up to a short paragraph (5–7 sentences).
- If a response would require more than that: "I'll email you the details instead — want me to?"
- Never send a wall of text over WhatsApp. It reads as noise.

### Group Chats vs. Direct Messages
- In a group chat: be concise and task-focused. Don't address individuals unless directed.
- In a DM with a family member (admin or member role): trust the conversation context. If the user references something just discussed — a place they asked about, a recommendation you just gave, a topic you were exploring together — act on it immediately using that context. Do NOT ask "which one did you mean?" when the answer is clear from recent messages.
- In a DM: slightly warmer tone is fine, but still brief.
- Never expose one member's private info in a group chat. If a question involves sensitive household data, respond privately or via email.

### Offer to Email Instead
- Trigger phrases: "explain", "full list", "breakdown", "all the details", "full report", "everything".
- Response: "That's a longer one — want me to send you the details by email?"
- Always ask, never assume. Some users prefer WhatsApp even for longer content.

### Image & Voice Message Handling
- **Images with a task**: Do the task. Mention what you saw in one sentence max if relevant.
- **Images without a task**: Describe in 1 sentence. Ask what they need.
- **Voice messages**: Briefly acknowledge (under 10 words), then respond to the request.
- **Forwarded documents/screenshots**: Read and extract the relevant information. Summarize what you found, then act.

### WhatsApp Template Awareness
- If the 24-hour session window has closed, WATI will auto-send via an approved template. You do NOT need to warn users about this. Just send.
- Never say "I can't message you right now" — always attempt the send. If it fails, report the error.

### Emoji Policy
- One emoji per message maximum. Usually at the end, not mid-sentence.
- Preferred contexts: confirming good news, acknowledging a casual request, signing off a task.
- Never use emoji in serious, urgent, or sensitive messages.`;

  const emailAddendum = `## Email Channel — Behavior Addendum

### Formatting
- Plain text only. No markdown. No asterisks, pound signs, or dashes used as formatting.
- Separate paragraphs with a single blank line.
- For lists, use simple numbered or lettered format: "1. ...", "2. ..." or "a. ...", "b. ..."
- Keep line length natural — write like a professional email, not a document.

### Sign-Off
- Always end with: "— Janus"
- No last name. No "Best regards", no "Sincerely", no "Thanks" unless it's a natural part of the body.
- One blank line before the sign-off.

### Reply-All Threading Rule
- When replying to a group email or a thread with multiple recipients: always Reply All.
- Never drop recipients from a thread unless explicitly instructed by Tony or Lana.
- If a reply would expose sensitive info to the group, flag it: "This thread includes [names] — should I reply all or just to [recipient]?"

### Tone Selection
- **Formal**: External parties, vendors, contractors, unknown recipients, and anyone Tony hasn't personally introduced.
- **Semi-formal**: Staff members (Sandra, Jesse, Esmerelda, Rina) on routine operational matters.
- **Direct**: Household family members.
- When in doubt, default to semi-formal. It's always appropriate and never off-putting.

### Handling Forwarded Documents and Attachments
- When an email is forwarded with attachments: read and extract key information (dates, amounts, names, action items).
- Summarize what you found before acting. "This looks like a vendor invoice from [Company] for $[amount] due [date]. Want me to log it or respond?"
- Never ignore an attachment. If you can't read it, say so: "I see an attachment but couldn't parse it — can you confirm what it contains?"

### Triage Priority
- **Urgent / respond now**: Security alerts, time-sensitive logistics, anything from Tony or Lana marked urgent.
- **Today**: Calendar invites, vendor coordination, staff requests.
- **This week**: Research tasks, non-urgent follow-ups.
- **No action needed**: Newsletters, receipts, automated notifications (archive after reading).
- When in doubt, surface it to Tony with a one-line summary: what it is, who sent it, what they want.

### Brevity Rules (Non-Negotiable)
- 1–2 short paragraphs max in the email body. Never pad a reply.
- Lead with the action or answer. Context follows if needed.
- After completing an action: one sentence confirmation. Done.
- If something failed: one sentence describing what failed. Offer to retry.`;

  const prompts = [
    {
      slug: "janus-core",
      label: "Janus Core Prompt (SOUL)",
      content: soulMd,
      description: "Primary identity and operating guidelines for Janus — loaded by all channels. Edit here to update Janus behavior without a redeploy.",
    },
    {
      slug: "janus-chat-addendum",
      label: "Janus Chat Addendum",
      content: chatAddendum,
      description: "Channel-specific behavior for the Janus web chat interface. Appended after the core prompt.",
    },
    {
      slug: "janus-whatsapp-addendum",
      label: "Janus WhatsApp Addendum",
      content: whatsappAddendum,
      description: "Channel-specific behavior for WhatsApp. Appended after the core prompt.",
    },
    {
      slug: "janus-email-addendum",
      label: "Janus Email Addendum",
      content: emailAddendum,
      description: "Channel-specific behavior for email. Appended after the core prompt.",
    },
  ];

  const legacyContentsForNewSlugs: Record<string, string[]> = {
    "janus-core": [LEGACY_PLACEHOLDER_CONTENT["janus-system"], "You are Janus, the AI assistant for your smart home."],
    "janus-chat-addendum": [""],
    "janus-whatsapp-addendum": [LEGACY_PLACEHOLDER_CONTENT["janus-whatsapp"], ""],
    "janus-email-addendum": [LEGACY_PLACEHOLDER_CONTENT["janus-email"], ""],
  };

  for (const prompt of prompts) {
    const { rows: existing } = await query<{ id: string; content: string | null }>(
      `SELECT id, content FROM system_prompts WHERE slug = $1`,
      [prompt.slug]
    );

    if (existing.length === 0) {
      await storage.upsertSystemPrompt(prompt);
      console.log(`[SEED] Seeded system prompt: "${prompt.slug}".`);
    } else {
      const currentContent = (existing[0].content ?? "").trim();
      const knownPlaceholders = (legacyContentsForNewSlugs[prompt.slug] ?? []).map((s) => s.trim());
      const isPlaceholder = knownPlaceholders.some((p) => currentContent === p);

      if (isPlaceholder) {
        await query(
          `UPDATE system_prompts SET label = $1, description = $2, content = $3, updated_at = NOW() WHERE slug = $4`,
          [prompt.label, prompt.description, prompt.content, prompt.slug]
        );
        console.log(`[SEED] Upgraded system prompt: "${prompt.slug}" (placeholder content replaced with enriched defaults).`);
      } else {
        await query(
          `UPDATE system_prompts SET label = $1, description = $2, updated_at = NOW() WHERE slug = $3`,
          [prompt.label, prompt.description, prompt.slug]
        );
        console.log(`[SEED] Verified system prompt: "${prompt.slug}" (custom content preserved).`);
      }
    }
  }
}

async function seedHouseholdMembers(): Promise<void> {
  const members = [
    { id: "00000000-0000-4000-a000-000000000001", displayName: "Admin User", email: process.env.ADMIN_EMAIL || "admin@example.com", role: "admin", whatsappNumber: "15550100", aliases: null as string[] | null },
    { id: "00000000-0000-4000-a000-000000000002", displayName: "Family Member", email: "member@example.com", role: "member", whatsappNumber: "15550101", aliases: null as string[] | null },
    { id: "00000000-0000-4000-a000-000000000003", displayName: "Household Staff", email: "staff@example.com", role: "worker", whatsappNumber: "15550102", aliases: ["Staff"] as string[] | null },
  ];

  let upserted = 0;
  for (const m of members) {
    const result = await query(
      `INSERT INTO household_members (id, display_name, email, role, is_active, whatsapp_number, aliases, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, $5, $6, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         email = EXCLUDED.email,
         role = EXCLUDED.role,
         is_active = EXCLUDED.is_active,
         whatsapp_number = COALESCE(NULLIF(household_members.whatsapp_number, ''), EXCLUDED.whatsapp_number),
         aliases = COALESCE(EXCLUDED.aliases, household_members.aliases),
         updated_at = NOW()`,
      [m.id, m.displayName, m.email, m.role, m.whatsappNumber, m.aliases]
    );
    if (result.rowCount && result.rowCount > 0) upserted++;
  }

  if (upserted > 0) {
    console.log(`[SEED] Household members seeded (${upserted} members upserted).`);
  }

  const { rows } = await query<{ cnt: number }>(
    `SELECT count(*)::int AS cnt FROM household_members WHERE id IN ($1,$2,$3,$4,$5,$6,$7,$8)`,
    members.map(m => m.id)
  );
  const count = rows[0]?.cnt ?? 0;
  if (count < members.length) {
    console.warn(`[SEED] WARNING: Expected ${members.length} household members but found ${count} by deterministic ID.`);
  } else {
    console.log(`[SEED] Verified ${count} household members present.`);
  }
}

async function seedHouseholdPhoneNumbers(): Promise<void> {
  const familyPhones = [
    { name: "Admin User", phone: "15550100", email: process.env.ADMIN_EMAIL || "admin@example.com", role: "admin" },
    { name: "Family Member", phone: "15550101", email: "member@example.com", role: "member" },
  ];

  for (const m of familyPhones) {
    await query(
      `UPDATE household_members SET whatsapp_number = $1
       WHERE email = $2 AND (whatsapp_number IS NULL OR whatsapp_number = '')`,
      [m.phone, m.email]
    );
  }

  await query(
    `UPDATE profiles SET phone_number = $1
     WHERE user_id = $2 AND (phone_number IS NULL OR phone_number = '')`,
    ["15550100", "google_sample_admin_uid"]
  );
}

async function seedInvitedEmails(): Promise<void> {
  const authorizedEmails = [
    process.env.ADMIN_EMAIL || "admin@example.com",
    "member@example.com",
    "staff@example.com",
  ];

  for (const email of authorizedEmails) {
    await query(
      `INSERT INTO invited_emails (email, invited_by)
       SELECT $1, 'system'
       WHERE NOT EXISTS (SELECT 1 FROM invited_emails WHERE email = $1)`,
      [email]
    );
  }

  const { rows } = await query(
    `SELECT count(*)::int AS cnt FROM invited_emails WHERE email = ANY($1)`,
    [authorizedEmails]
  );
  console.log(`[SEED] Invited emails: ${rows[0]?.cnt ?? 0}/${authorizedEmails.length} authorized emails present.`);
}

async function seedFamilyAutomations(): Promise<void> {
  // One-time cleanup: remove historical "not configured" error rows that
  // accumulated in the audit log before credential-gated scheduled jobs were
  // fixed to skip gracefully instead of throwing. Runs unconditionally on every
  // startup; is a safe no-op once the backlog is gone.
  try {
    const { rowCount: deletedPoiErrors } = await query(
      `DELETE FROM system_audit_log
       WHERE edge_function = 'verkada-poi-sync'
         AND status = 'error'
         AND summary ILIKE '%not configured%'`
    );
    const { rowCount: deletedCronErrors } = await query(
      `DELETE FROM system_audit_log
       WHERE edge_function = 'cron-trigger'
         AND status = 'error'
         AND summary ILIKE '%verkada/poi-sync%'
         AND summary ILIKE '%not configured%'`
    );
    const total = (deletedPoiErrors ?? 0) + (deletedCronErrors ?? 0);
    if (total > 0) {
      console.log(`[SEED] Cleaned up ${total} stale "not configured" audit-log noise row(s).`);
    }
  } catch (e) {
    console.warn('[SEED] Could not clean up stale audit-log rows:', e);
  }

  const { rows } = await query<{ cnt: number }>("SELECT count(*)::int AS cnt FROM family_automations");
  if (rows[0]?.cnt > 0) {
    // Table already seeded — only upsert new automations that may have been added
    const newAutomations: Array<{ name: string; type: string; schedule: string; desc: string; config?: Record<string, unknown> }> = [
      { name: 'Gym Timer & Temperature', type: 'gym-thermostat', schedule: '*/15 * * * *', desc: 'AC on 6 AM–3 PM daily at 68°F cool / 64°F heat. Alerts if temp out of range.' },
      { name: 'Theater Timer & Temperature', type: 'theater-thermostat', schedule: '*/15 * * * *', desc: 'Heat 68°F / Cool 72°F (dual auto) from 10 AM–11 PM daily. Off otherwise. Alerts if temp out of range.' },
      { name: 'Spa Mode 12 Hour Alert', type: 'spa-mode-alert', schedule: '*/30 * * * *', desc: 'Alerts Jesse, Sandra & Tony when pool has been left on SPA mode for more than 12 hours' },
      { name: 'AV Closet Temperature Monitor', type: 'av-closet-temp-monitor', schedule: '*/10 * * * *', desc: 'Checks AV Closet temp every 10 min. Emails Tony, Sandra & Jesse over 90°F; WhatsApps Tony over 100°F.' },
      { name: 'Fountains Off at 9 PM', type: 'energy-fountains-off', schedule: '0 21 * * *', desc: 'Turns off all fountain lights at 9:00 PM PT every night' },
      { name: 'Closet Light Timer', type: 'energy-closet-timer', schedule: '*/5 * * * *', desc: 'Turns off any closet light left on for more than 30 minutes' },
      // Guest bathroom light timer configuration;
      // the list is admin-editable from the Automations page.
      { name: 'Bathroom Light Timer', type: 'energy-bathroom-timer', schedule: '*/5 * * * *', desc: 'Turns off bathroom lights after 15 minutes — Primary Bath gets 1 hour', config: { excluded_terms: ['guest'] } },
      { name: 'Door Locks & Battery Monitor', type: 'ha-locks', schedule: '0 */4 * * *', desc: 'Monitors Yale & Crestron door locks for low battery, offline status, and jammed locks via Home Assistant' },
    ];
    for (const a of newAutomations) {
      const { rows: existing } = await query(`SELECT id FROM family_automations WHERE name = $1 LIMIT 1`, [a.name]);
      if (existing.length === 0) {
        await query(
          `INSERT INTO family_automations (name, automation_type, schedule, is_active, description, config)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [a.name, a.type, a.schedule, true, a.desc, JSON.stringify(a.config ?? {})]
        );
        console.log(`[SEED] Inserted new automation: "${a.name}"`);
      }
    }
    return;
  }

  console.log("[SEED] Seeding family_automations...");
  const automations: Array<{ name: string; type: string; schedule: string; desc: string; config?: Record<string, unknown> }> = [
    { name: 'Getting Girls to School on Time', type: 'school-broadcast', schedule: '50 6 * * 1-5', desc: 'HW calendar sync + 6:50am & 7:30am wake-up broadcasts' },
    { name: 'Morning Brief Email', type: 'morning-email', schedule: '0 7 * * *', desc: 'Weather, news, markets & calendar digest' },
    { name: 'Morning Sauna', type: 'morning-sauna', schedule: 'MWF 8:30–9:00 AM · Tu/Th 8:50–9:20 AM PT', desc: 'Runs the sauna at 190°F for 30 minutes on weekday mornings using Home Assistant power and temperature helpers' },
    { name: 'Tesla Battery Monitor', type: 'tesla-battery', schedule: '*/30 * * * *', desc: 'Alerts staff when range ≤ 100 mi & vehicle is at home' },
    { name: 'Pool Heater Rain Guard', type: 'pool-rain-guard', schedule: '*/30 * * * *', desc: 'Turns off heaters when rain is expected, restores to 87°F when clear' },
    { name: 'Package Arrival Monitor', type: 'package-arrival', schedule: '*/5 * * * *', desc: 'WhatsApp Tony, email Sandra & Jesse, archive notification from inbox' },
    { name: 'Printer Health Monitor', type: 'printer-health', schedule: '*/30 * * * *', desc: 'Monitors HP printers and Bambu Lab 3D printers' },
    { name: 'Internet Health Monitor', type: 'internet-health', schedule: '*/15 * * * *', desc: 'Monitors Spectrum internet via HA Speedtest' },
    { name: 'HA Server Health Monitor', type: 'ha-server-health', schedule: '*/5 * * * *', desc: 'Emails Tony when CPU or RAM stay critically high for 15+ minutes' },
    { name: 'Verkada POI Sync', type: 'verkada-poi-sync', schedule: '*/5 * * * *', desc: 'Syncs Person of Interest detections from Verkada API' },
    { name: 'Calendar Nav to Tesla', type: 'calendar-nav-tesla', schedule: '*/5 * * * *', desc: 'Sends meeting locations to BeastX navigation 15 min before events' },
    { name: 'Pool Temp Monitor', type: 'pool-temp-monitor', schedule: '*/30 * * * *', desc: 'Alerts Jesse, Sandra & Tony when pool drops below 82°F' },
    { name: 'Spa Mode 12 Hour Alert', type: 'spa-mode-alert', schedule: '*/30 * * * *', desc: 'Alerts Jesse, Sandra & Tony when pool has been left on SPA mode for more than 12 hours' },
    { name: 'HA Update Checker', type: 'ha-update-checker', schedule: '0 */6 * * *', desc: 'Checks for available HA updates and emails Tony when found; deduplicates within 24h' },
    { name: 'Gym Timer & Temperature', type: 'gym-thermostat', schedule: '*/15 * * * *', desc: 'AC on 6 AM–3 PM daily at 68°F cool / 64°F heat. Alerts if temp out of range.' },
    { name: 'Theater Timer & Temperature', type: 'theater-thermostat', schedule: '*/15 * * * *', desc: 'Heat 68°F / Cool 72°F (dual auto) from 10 AM–11 PM daily. Off otherwise. Alerts if temp out of range.' },
    { name: 'AV Closet Temperature Monitor', type: 'av-closet-temp-monitor', schedule: '*/10 * * * *', desc: 'Checks AV Closet temp every 10 min. Emails Tony, Sandra & Jesse over 90°F; WhatsApps Tony over 100°F.' },
    { name: 'Fountains Off at 9 PM', type: 'energy-fountains-off', schedule: '0 21 * * *', desc: 'Turns off all fountain lights at 9:00 PM PT every night' },
    { name: 'Closet Light Timer', type: 'energy-closet-timer', schedule: '*/5 * * * *', desc: 'Turns off any closet light left on for more than 30 minutes' },
    // Guest bathroom light timer configuration;
    // the list is admin-editable from the Automations page.
    { name: 'Bathroom Light Timer', type: 'energy-bathroom-timer', schedule: '*/5 * * * *', desc: 'Turns off bathroom lights after 15 minutes — Primary Bath gets 1 hour', config: { excluded_terms: ['guest'] } },
    { name: 'Door Locks & Battery Monitor', type: 'ha-locks', schedule: '0 */4 * * *', desc: 'Monitors Yale & Crestron door locks for low battery, offline status, and jammed locks via Home Assistant' },
  ];

  for (const a of automations) {
    await query(
      `INSERT INTO family_automations (name, automation_type, schedule, is_active, description, config)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [a.name, a.type, a.schedule, true, a.desc, JSON.stringify(a.config ?? {})]
    );
  }
}

