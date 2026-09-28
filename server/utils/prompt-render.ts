/**
 * Shared system-prompt renderer.
 *
 * The Janus SOUL prompt (`supabase/functions/_shared/SOUL.md`, mirrored to
 * the `system_prompts` table with slug `janus-core`) carries a few
 * placeholders that must be expanded at request time so we never ship
 * static PII to the LLM. The chat handler used to do this substitution
 * inline; the WhatsApp and email-poll handlers did not, so the static
 * household phone numbers in SOUL.md were leaking to those channels on
 * every call.
 *
 * Centralize the substitution here so all three handlers behave
 * identically.
 *
 * Supported placeholders:
 *   {{HOUSEHOLD_DIRECTORY}} — live markdown table of household_members
 *                             (names, emails, WhatsApp numbers, UUIDs).
 *
 * Unknown placeholders are left untouched so an out-of-date prompt is
 * obvious in logs / model output rather than silently swallowed.
 */

import { loadHouseholdMembers } from "./janus-tools.js";
import type { SupabaseClient } from "./supabase.js";

export interface PromptSubstitutions {
  /**
   * Replacement for `{{HOUSEHOLD_DIRECTORY}}`. Empty string means "leave
   * the placeholder in place" — the caller did not load the directory
   * (e.g., DB unreachable). Use `loadHouseholdDirectory()` to populate.
   */
  householdDirectory?: string;
}

export const HOUSEHOLD_DIRECTORY_PLACEHOLDER = "{{HOUSEHOLD_DIRECTORY}}";

/**
 * Apply known placeholder substitutions to a system prompt. Pure function —
 * no I/O. Pass the loaded household directory string (or other future
 * substitutions) in via `subs`.
 *
 * Empty / undefined substitutions are skipped: the placeholder stays in
 * the output so the omission is visible rather than silently masked.
 */
export function renderSystemPrompt(
  soulText: string,
  subs: PromptSubstitutions = {},
): string {
  let out = soulText;
  if (subs.householdDirectory && subs.householdDirectory.length > 0) {
    out = out.split(HOUSEHOLD_DIRECTORY_PLACEHOLDER).join(subs.householdDirectory);
  }
  return out;
}

/**
 * Convenience: load the household directory table and return it as a
 * single string ready to feed into `renderSystemPrompt`. Returns empty
 * string on any failure so the caller can fall through to "placeholder
 * stays in place" behavior.
 */
export async function loadHouseholdDirectory(svc?: SupabaseClient): Promise<string> {
  try {
    const result = await loadHouseholdMembers(svc);
    return result.directoryTable || "";
  } catch (e) {
    console.warn(
      `[prompt-render] loadHouseholdDirectory failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return "";
  }
}
