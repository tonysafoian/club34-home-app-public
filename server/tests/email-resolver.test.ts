/**
 * Regression test for the inbound email identity resolver.
 *
 * Run: npx tsx server/tests/email-resolver.test.ts
 *
 * Covers the Liz Beck failure mode (admin Tony being misclassified as outsider
 * because resolveEmailToUserId fell through to the hardcoded map default).
 * Also exercises +tag stripping, alias matching, separator-insensitive local
 * part matching, and the outsider fallback.
 */
import { resolveEmailIdentity, resolvePhoneIdentity, invalidateIdentityCache } from "../lib/identityResolver.js";
import { storage } from "../storage.js";

interface Result { test: string; passed: boolean; detail: string }

async function ensureSeed(): Promise<void> {
  const members = await storage.getHouseholdMembers();
  if (!members.find((m) => m.email === "admin@example.com")) {
    throw new Error("household_members table is empty/missing Tony — run server seed first");
  }
}

function eq(a: unknown, b: unknown): boolean { return a === b; }

async function main() {
  await ensureSeed();
  invalidateIdentityCache();
  const results: Result[] = [];

  // 1. Direct admin email
  const tony = await resolveEmailIdentity("admin@example.com");
  results.push({
    test: "admin@example.com → admin",
    passed: eq(tony.role, "admin") && tony.source === "email",
    detail: `role=${tony.role}, source=${tony.source}, name=${tony.displayName}`,
  });

  // 2. Case-insensitivity
  const tonyUpper = await resolveEmailIdentity("Admin@EXAMPLE.com");
  results.push({
    test: "Admin@EXAMPLE.com → admin (case-insensitive, cache hit)",
    passed: eq(tonyUpper.role, "admin"),
    detail: `role=${tonyUpper.role}, source=${tonyUpper.source}`,
  });

  // 3. +tag stripping
  const tonyTagged = await resolveEmailIdentity("admin+inbox@example.com");
  results.push({
    test: "admin+inbox@example.com → admin via +tag strip",
    passed: eq(tonyTagged.role, "admin") && (tonyTagged.source === "plus-tag" || tonyTagged.source === "cache"),
    detail: `role=${tonyTagged.role}, source=${tonyTagged.source}`,
  });

  // 4. Separator-insensitive local-part (jesse-b vs jesse.b)
  const seedJesse = (await storage.getHouseholdMembers()).find((m) => m.email && m.email.toLowerCase().includes("jesse"));
  if (seedJesse?.email) {
    const seededLocal = seedJesse.email.split("@")[0]; // "jesse-b" per seed
    const swappedSep = seededLocal.includes("-") ? seededLocal.replace(/-/g, ".") : seededLocal.replace(/\./g, "-");
    const variantEmail = `${swappedSep}@example.com`;
    const jVariant = await resolveEmailIdentity(variantEmail);
    results.push({
      test: `${variantEmail} → resolves to ${seedJesse.displayName} via local-part`,
      passed: jVariant.role !== "outsider" && jVariant.userId === (seedJesse.supabaseUuid || seedJesse.id),
      detail: `role=${jVariant.role}, source=${jVariant.source}, name=${jVariant.displayName}`,
    });
  } else {
    results.push({ test: "Jesse separator-insensitive match", passed: false, detail: "Jesse not seeded — cannot test" });
  }

  // 5. Outsider fallback (Liz Beck scenario)
  const liz = await resolveEmailIdentity("liz.beck@randomdomain.example");
  results.push({
    test: "external email → outsider",
    passed: eq(liz.role, "outsider") && liz.source === "outsider",
    detail: `role=${liz.role}, source=${liz.source}`,
  });

  // 6. Empty / malformed input
  const empty = await resolveEmailIdentity("");
  results.push({
    test: "empty input → outsider (no crash)",
    passed: empty.role === "outsider",
    detail: `role=${empty.role}`,
  });

  // 7. Cache hit behavior
  const tonyAgain = await resolveEmailIdentity("admin@example.com");
  results.push({
    test: "second lookup served from cache",
    passed: tonyAgain.source === "cache" && tonyAgain.role === "admin",
    detail: `source=${tonyAgain.source}`,
  });

  // 8. Alias-array match (if any seeded member has aliases)
  const aliasMember = (await storage.getHouseholdMembers()).find(
    (m) => Array.isArray(m.aliases) && m.aliases.length > 0,
  );
  if (aliasMember && aliasMember.aliases && aliasMember.aliases[0]) {
    const aliasInput = aliasMember.aliases[0];
    if (aliasInput.includes("@")) {
      const a = await resolveEmailIdentity(aliasInput);
      results.push({
        test: `alias "${aliasInput}" → ${aliasMember.displayName}`,
        passed: a.role !== "outsider" && (a.source === "alias" || a.source === "email" || a.source === "cache"),
        detail: `role=${a.role}, source=${a.source}`,
      });
    } else {
      results.push({
        test: `alias "${aliasInput}" → skipped (not an email-shaped alias)`,
        passed: true,
        detail: "non-email alias",
      });
    }
  } else {
    results.push({ test: "alias-array match", passed: true, detail: "no email aliases seeded — skipped" });
  }

  // 9. Phone resolver — exact match against any seeded household member with a number
  const phoneSeed = (await storage.getHouseholdMembers()).find((m) => !!m.whatsappNumber);
  if (phoneSeed?.whatsappNumber) {
    const seedPhone = phoneSeed.whatsappNumber.replace(/[^\d]/g, "");
    const direct = await resolvePhoneIdentity(seedPhone);
    results.push({
      test: `phone ${seedPhone} → ${phoneSeed.displayName}`,
      passed: direct.role !== "outsider" && direct.userId === (phoneSeed.supabaseUuid || phoneSeed.id),
      detail: `role=${direct.role}, source=${direct.source}, name=${direct.displayName}`,
    });

    // 10. Phone resolver — strip leading 1 / + variants resolve to same identity
    const last10 = seedPhone.slice(-10);
    if (last10.length === 10) {
      const variant = await resolvePhoneIdentity(`+1${last10}`);
      results.push({
        test: `phone variant +1${last10} → same identity (last-10 / variant fallback)`,
        passed: variant.role !== "outsider" && variant.userId === direct.userId,
        detail: `role=${variant.role}, source=${variant.source}`,
      });
    }
  } else {
    results.push({ test: "phone-resolver tests", passed: true, detail: "no member with whatsapp_number seeded — skipped" });
  }

  // 11. Phone resolver — unknown number is outsider
  const stranger = await resolvePhoneIdentity("19998887777");
  results.push({
    test: "unknown phone → outsider",
    passed: stranger.role === "outsider" && stranger.source === "outsider",
    detail: `role=${stranger.role}, source=${stranger.source}`,
  });

  // Print
  let allPassed = true;
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    if (!r.passed) allPassed = false;
    console.log(`[${status}] ${r.test} — ${r.detail}`);
  }
  if (!allPassed) {
    console.error(`\n${results.filter((r) => !r.passed).length} test(s) FAILED.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} tests passed.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
