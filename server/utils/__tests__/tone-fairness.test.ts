/**
 * Tone-fairness coverage.
 *
 * SOUL.md prescribes a different conversational tone per family member
 * and per role (admin / member / staff / outsider). Nothing today
 * verifies that the rendered system prompt actually carries those
 * anchors. If a future SOUL edit accidentally deletes "Direct,
 * concise, data-first" from Tony's paragraph, the only signal is "the
 * model started replying differently" — which is exactly the bug we
 * want to catch.
 *
 * Strategy: assert on the rendered system prompt (the input to the
 * LLM), not the LLM output. Tone fairness is a *prompt construction*
 * contract; whether the model honors it on any given turn is a
 * separate concern (and would make CI flaky to test live).
 *
 * The rendered prompt is the same for every recognized user — what
 * varies is the role-addendum appended to it. So we check:
 *   1. The core SOUL prompt always contains every tone anchor
 *      ("Direct" for Tony, "Warm" for Lana, "age-appropriate" for the
 *      kids, "task-oriented" / "low-context" for staff, "Professional,
 *      polished" for outsiders).
 *   2. The role-addendum for each role names the right role and ships
 *      the right restrictions.
 *   3. The dedicated outsider quick-reply prompt is brief, firm, and
 *      carries no household PII.
 *
 * A separate snapshot test hashes each anchor's containment to catch
 * silent deletions in a single point-in-time view.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { renderSystemPrompt } from "../prompt-render.js";
import {
  getRoleSystemPromptAddendum,
  OUTSIDER_QUICK_REPLY_PROMPT,
} from "../../handlers/chat.js";

const SOUL_PATH = path.resolve(process.cwd(), "supabase/functions/_shared/SOUL.md");
const SOUL = fs.readFileSync(SOUL_PATH, "utf8");

// Simulate what the runtime does — substitute the placeholder with a
// representative directory string. The test doesn't need real Notion
// UUIDs; it just needs a string that resembles what household_members
// would produce so we can verify *absence* of PII in the outsider
// path.
const SAMPLE_DIRECTORY = `| Tony | admin@example.com | UUID-1 | UUID-A |
| Lana | member@example.com | UUID-2 | UUID-B |
| Isla | member2@example.com | UUID-3 | UUID-C |
| Emme | member3@example.com | UUID-4 | UUID-D |
| Enzo | member@example.com | UUID-5 | UUID-E |
| Sandra | staff@example.com | UUID-6 | UUID-F |`;

const CORE_PROMPT = renderSystemPrompt(SOUL, { householdDirectory: SAMPLE_DIRECTORY });

function fullPromptFor(role: "admin" | "member" | "outsider"): string {
  return CORE_PROMPT + getRoleSystemPromptAddendum(role);
}

function lower(s: string): string {
  return s.toLowerCase();
}

describe("Tone-by-person anchors in the rendered core prompt", () => {
  // The "Tone by Person" section is the single point of truth in SOUL.
  // These assertions catch SOUL edits that drop a line from that
  // section. Wording matches what the file currently says.

  it("contains Tony's tone directive: Direct + data-first", () => {
    const p = lower(CORE_PROMPT);
    expect(p).toContain("tony:");
    expect(p).toContain("direct");
    expect(p).toContain("data-first");
  });

  it("contains Lana's tone directive: Warm + efficient", () => {
    const p = lower(CORE_PROMPT);
    expect(p).toContain("lana:");
    expect(p).toContain("warm");
    expect(p).toMatch(/efficient/);
  });

  it("contains Isla & Emme's tone directive: age-appropriate", () => {
    const p = lower(CORE_PROMPT);
    expect(p).toContain("isla");
    expect(p).toContain("emme");
    expect(p).toContain("age-appropriate");
  });

  it("contains Enzo's tone directive: warm, playful, simple", () => {
    const p = lower(CORE_PROMPT);
    expect(p).toContain("enzo");
    expect(p).toMatch(/playful/);
    expect(p).toMatch(/simple/);
  });

  it("contains staff tone directive: task-oriented + low-context", () => {
    const p = lower(CORE_PROMPT);
    expect(p).toContain("staff");
    expect(p).toContain("task-oriented");
    expect(p).toContain("low-context");
  });

  it("contains outsiders/guests tone directive: Professional, polished, brief", () => {
    const p = lower(CORE_PROMPT);
    expect(p).toContain("outsiders");
    expect(p).toMatch(/professional/);
    expect(p).toMatch(/polished/);
    expect(p).toMatch(/brief/);
  });
});

describe("Role-addendum carries the right restrictions per role", () => {
  it("admin (Tony) addendum names ADMIN and grants full access", () => {
    const p = fullPromptFor("admin");
    expect(p).toContain("ADMIN (Tony)");
    expect(p).toContain("full access");
    expect(p).toContain("No restrictions");
  });

  it("member addendum names MEMBER and lists the cannot-do operations", () => {
    const p = fullPromptFor("member");
    expect(p).toContain("MEMBER");
    expect(p).toContain("CANNOT send emails");
    expect(p).toContain("CANNOT batch-update Notion pages");
  });

  it("outsider addendum names OUTSIDER and forbids PII / control / system access", () => {
    const p = fullPromptFor("outsider");
    expect(p).toContain("OUTSIDER");
    expect(p).toContain("Do NOT reveal");
    expect(p).toContain("Do NOT execute");
    expect(p).toContain("Do NOT access");
  });

  it("admin and member addenda are different (no copy-paste regression)", () => {
    expect(getRoleSystemPromptAddendum("admin")).not.toBe(getRoleSystemPromptAddendum("member"));
  });

  it("any unrecognized role still gets the safe member-level restrictions", () => {
    // The default branch in getRoleSystemPromptAddendum returns the
    // member addendum. If that ever flips to a less-restrictive
    // default, this test fails.
    expect(getRoleSystemPromptAddendum("nonsense-role")).toBe(getRoleSystemPromptAddendum("member"));
  });
});

describe("Outsider quick-reply prompt is firm and PII-free", () => {
  // The outsider quick-reply prompt is a completely separate string
  // used when an unrecognized sender hits chat. It's the surface most
  // exposed to people we don't know, so the contract is:
  //   - polished + brief
  //   - explicit "no personal info"
  //   - zero family / staff names beyond Tony/Lana (which are merely
  //     mentioned as "the family", not by first name in the prompt)
  //   - zero phone-shaped digit sequences

  it("explicitly forbids personal information", () => {
    expect(OUTSIDER_QUICK_REPLY_PROMPT).toMatch(/Do NOT reveal/);
    expect(OUTSIDER_QUICK_REPLY_PROMPT).toMatch(/personal information/i);
  });

  it("caps responses to 1-2 sentences", () => {
    expect(OUTSIDER_QUICK_REPLY_PROMPT).toMatch(/1-2 sentences/);
  });

  it("explicitly denies tool / calendar / data access", () => {
    expect(OUTSIDER_QUICK_REPLY_PROMPT).toMatch(/NO access to any household tools, calendars, or data/i);
  });

  it("contains no phone-shaped digit sequence", () => {
    const phoneRe = /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
    expect(OUTSIDER_QUICK_REPLY_PROMPT).not.toMatch(phoneRe);
  });

  it("contains no household first names beyond a generic 'the family' reference", () => {
    // Isla / Emme / Enzo / Sandra / Jesse / Rina / Esmerelda must not
    // appear in the outsider prompt — the contract is "represent the
    // household well but reveal nothing." Tony and Lana are fine to
    // exclude from the check since they could legitimately appear in
    // a generic phrasing; we explicitly verify they're NOT in the
    // current prompt as a stronger guarantee.
    const lowerPrompt = OUTSIDER_QUICK_REPLY_PROMPT.toLowerCase();
    for (const name of ["isla", "emme", "enzo", "sandra", "jesse", "rina", "esmerelda", "tony", "lana"]) {
      expect(lowerPrompt, `outsider prompt leaks "${name}"`).not.toContain(name);
    }
  });
});

describe("Snapshot regression — SOUL tone anchors", () => {
  // Single-hash snapshot of each anchor's presence in the rendered
  // core prompt. If any anchor disappears (deletion or rewording),
  // its boolean flips and this fingerprint changes. Avoids leaking
  // the full PII-bearing prompt into the snapshot file.

  // Tolerant of markdown bold (`**Tony:**`) and minor punctuation
  // drift. The point is "this concept still appears in Tony's line",
  // not "this exact regex matches a specific layout."
  const ANCHORS: Array<[string, RegExp]> = [
    ["tony_direct_data", /tony[*:\s]+direct[^.]*data-first/i],
    ["lana_warm_efficient", /lana[*:\s]+warm[^.]*efficient/i],
    ["kids_age_appropriate", /\bage-appropriate\b/i],
    ["enzo_playful_simple", /enzo[*:\s]+warm[^.]*playful[^.]*simple/i],
    ["staff_task_low_context", /\btask-oriented[^.]*low-context/i],
    ["outsiders_polished_brief", /outsiders[^.\n]*professional[^.]*polished[^.]*brief/i],
  ];

  it("every tone anchor matches the current SOUL — fingerprint is stable", () => {
    const presence: Record<string, boolean> = {};
    for (const [name, re] of ANCHORS) {
      presence[name] = re.test(CORE_PROMPT);
    }
    const allTrue = Object.values(presence).every(Boolean);
    expect(allTrue, `missing anchors: ${Object.entries(presence).filter(([, v]) => !v).map(([k]) => k).join(", ")}`).toBe(true);

    // Stable fingerprint over the anchor flags only — does NOT include
    // the prompt body, so no PII leaks into the test artifact.
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(presence))
      .digest("hex");
    // All anchors present → constant fingerprint, independent of
    // prompt phrasing changes elsewhere. If a future SOUL edit drops
    // an anchor, the corresponding flag flips and the fingerprint
    // changes (and the prior assertion also fails with a useful
    // message naming which anchor).
    const ALL_PRESENT_FINGERPRINT = createHash("sha256")
      .update(JSON.stringify(Object.fromEntries(ANCHORS.map(([n]) => [n, true]))))
      .digest("hex");
    expect(fingerprint).toBe(ALL_PRESENT_FINGERPRINT);
  });
});

// Optional live LLM smoke test. Off by default — runs only when
// JANUS_FAIRNESS_LIVE=1 is set and OPENROUTER_API_KEY is configured.
// Verifies the coarse contract "Tony's reply is shorter than Lana's
// on average" given identical input, by hitting the real model twice.
// Not run in CI; available for manual eval.
const LIVE = process.env.JANUS_FAIRNESS_LIVE === "1" && !!process.env.OPENROUTER_API_KEY;

describe.skipIf(!LIVE)("live LLM tone smoke (manual eval only)", () => {
  it("Tony's reply is shorter than Lana's on the same prompt", async () => {
    const prompt = "Tell me about today";
    const tonySystem = CORE_PROMPT + getRoleSystemPromptAddendum("admin");
    const lanaSystem = CORE_PROMPT + getRoleSystemPromptAddendum("member");

    async function ask(systemPrompt: string): Promise<string> {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.JANUS_MODEL_DEFAULT || "google/gemini-2.5-flash-lite",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          stream: false,
        }),
      });
      const data = await res.json();
      return data?.choices?.[0]?.message?.content ?? "";
    }

    const [tonyReply, lanaReply] = await Promise.all([ask(tonySystem), ask(lanaSystem)]);
    expect(tonyReply.length).toBeGreaterThan(0);
    expect(lanaReply.length).toBeGreaterThan(0);
    expect(tonyReply.length, `Tony reply (${tonyReply.length} chars) vs Lana (${lanaReply.length} chars)`).toBeLessThan(lanaReply.length);
  }, 60_000);
});
