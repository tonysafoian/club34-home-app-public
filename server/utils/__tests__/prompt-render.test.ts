/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { renderSystemPrompt, HOUSEHOLD_DIRECTORY_PLACEHOLDER } from "../prompt-render.js";

const PHONE_RE = /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

describe("renderSystemPrompt", () => {
  it("replaces {{HOUSEHOLD_DIRECTORY}} when a directory is supplied", () => {
    const soul = `Header

${HOUSEHOLD_DIRECTORY_PLACEHOLDER}

Footer`;
    const directory = "| Tony | admin@example.com | UUID-1 |\n| Lana | member@example.com | UUID-2 |";

    const out = renderSystemPrompt(soul, { householdDirectory: directory });
    expect(out).toContain("Tony");
    expect(out).toContain("Lana");
    expect(out).not.toContain(HOUSEHOLD_DIRECTORY_PLACEHOLDER);
  });

  it("leaves {{HOUSEHOLD_DIRECTORY}} in place when no directory is supplied", () => {
    const soul = `Header\n${HOUSEHOLD_DIRECTORY_PLACEHOLDER}\nFooter`;
    expect(renderSystemPrompt(soul, {})).toContain(HOUSEHOLD_DIRECTORY_PLACEHOLDER);
    expect(renderSystemPrompt(soul, { householdDirectory: "" })).toContain(HOUSEHOLD_DIRECTORY_PLACEHOLDER);
  });

  it("does not introduce PII when the input has none", () => {
    const soul = `You are Janus.\n\n${HOUSEHOLD_DIRECTORY_PLACEHOLDER}\n\nBe brief.`;
    const directory = "| Tony | admin@example.com | UUID-1 |";
    const out = renderSystemPrompt(soul, { householdDirectory: directory });
    // The only digits in the output should come from the directory we
    // explicitly supplied — no phone-shaped sequence smuggled in.
    expect(out).not.toMatch(PHONE_RE);
  });

  it("ignores unknown placeholders", () => {
    const soul = `Hello {{UNKNOWN_PLACEHOLDER}} ${HOUSEHOLD_DIRECTORY_PLACEHOLDER}`;
    const out = renderSystemPrompt(soul, { householdDirectory: "DIR" });
    expect(out).toBe("Hello {{UNKNOWN_PLACEHOLDER}} DIR");
  });

  it("replaces every occurrence of the placeholder", () => {
    const soul = `${HOUSEHOLD_DIRECTORY_PLACEHOLDER}\n---\n${HOUSEHOLD_DIRECTORY_PLACEHOLDER}`;
    const out = renderSystemPrompt(soul, { householdDirectory: "DIR" });
    expect(out).toBe("DIR\n---\nDIR");
  });

  it("returns the input unchanged when there are no placeholders", () => {
    const soul = "Plain prompt, no placeholders.";
    expect(renderSystemPrompt(soul, { householdDirectory: "DIR" })).toBe(soul);
  });
});

describe("SOUL.md PII snapshot", () => {
  it("does not contain any hard-coded phone-shaped strings", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const soulPath = path.resolve(process.cwd(), "supabase/functions/_shared/SOUL.md");
    const content = await fs.readFile(soulPath, "utf8");
    const match = content.match(PHONE_RE);
    expect(match, `Found PII-shaped phone number in SOUL.md: ${match?.[0]}`).toBeNull();
  });

  it("contains the {{HOUSEHOLD_DIRECTORY}} placeholder so live data can be injected", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const soulPath = path.resolve(process.cwd(), "supabase/functions/_shared/SOUL.md");
    const content = await fs.readFile(soulPath, "utf8");
    expect(content).toContain(HOUSEHOLD_DIRECTORY_PLACEHOLDER);
  });
});

// Silence the imported module's loadHouseholdMembers (which talks to a real
// SupabaseClient) so the loadHouseholdDirectory tests don't accidentally
// require DB credentials.
vi.mock("../janus-tools.js", () => ({
  loadHouseholdMembers: vi.fn(),
}));

describe("loadHouseholdDirectory", () => {
  it("returns the directoryTable from loadHouseholdMembers on success", async () => {
    const { loadHouseholdDirectory } = await import("../prompt-render.js");
    const { loadHouseholdMembers } = await import("../janus-tools.js");
    (loadHouseholdMembers as any).mockResolvedValueOnce({
      notionPeopleLookup: {},
      directoryTable: "DIRECTORY",
    });
    expect(await loadHouseholdDirectory()).toBe("DIRECTORY");
  });

  it("returns '' when loadHouseholdMembers throws", async () => {
    const { loadHouseholdDirectory } = await import("../prompt-render.js");
    const { loadHouseholdMembers } = await import("../janus-tools.js");
    (loadHouseholdMembers as any).mockRejectedValueOnce(new Error("boom"));
    expect(await loadHouseholdDirectory()).toBe("");
  });

  it("returns '' when directoryTable is empty", async () => {
    const { loadHouseholdDirectory } = await import("../prompt-render.js");
    const { loadHouseholdMembers } = await import("../janus-tools.js");
    (loadHouseholdMembers as any).mockResolvedValueOnce({
      notionPeopleLookup: {},
      directoryTable: "",
    });
    expect(await loadHouseholdDirectory()).toBe("");
  });
});
