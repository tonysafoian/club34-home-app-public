/**
 * Regression test for the merge semantics of
 * PUT /api/fortigate/device-overrides/:mac (Traffic tab inline editors).
 *
 * The route merges with the stored override: fields absent from the request
 * body keep their stored values, explicit null clears. This is what lets the
 * Traffic tab save a category without pinning the displayed hostname as a
 * custom_name override (and vice versa), and without wiping the owner set
 * from the Devices tab.
 *
 * Run:
 *   npx tsx server/tests/device-override-merge.test.ts
 *
 * Requires the HTTP server on localhost:$PORT and CRON_SECRET (admin bypass).
 * Exits 2 if either prerequisite is missing.
 *
 * Asserts:
 *   - category-only PUT on a fresh MAC creates NO custom name (customName null)
 *   - name PUT afterwards preserves the category
 *   - category-only PUT afterwards preserves the name and owner
 *   - explicit null clears just that field
 *   - full-body PUT (Devices tab shape) still replaces all fields
 *
 * Uses a reserved documentation OUI so the row can never collide with a real
 * device, and deletes the override in a finally block.
 */

const PORT = process.env.PORT || 5000;
const MAC = `00:00:5e:00:53:${(process.pid % 90 + 10).toString().padStart(2, "0")}`;
const BASE = `http://localhost:${PORT}/api/fortigate/device-overrides/${encodeURIComponent(MAC)}`;

interface Result { test: string; passed: boolean; detail: string }
const results: Result[] = [];

function record(test: string, passed: boolean, detail: string) {
  results.push({ test, passed, detail });
}

interface Override {
  customName: string | null;
  customCategory: string | null;
  customSubcategory: string | null;
  originalHostname: string | null;
  owner: string | null;
}

async function put(body: Record<string, unknown>, secret: string): Promise<Override> {
  const res = await fetch(BASE, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-cron-secret": secret },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${JSON.stringify(body)} -> HTTP ${res.status}`);
  const data = (await res.json()) as { override: Override };
  return data.override;
}

async function main() {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("CRON_SECRET not set — cannot exercise the admin route. Skipping.");
    process.exit(2);
  }
  try {
    const health = await fetch(`http://localhost:${PORT}/api/health`);
    if (!health.ok) throw new Error(`health ${health.status}`);
  } catch {
    console.error(`No HTTP server on localhost:${PORT} — skipping.`);
    process.exit(2);
  }

  try {
    // Clean slate for our sentinel MAC.
    await fetch(BASE, { method: "DELETE", headers: { "x-cron-secret": secret } });

    // 1. Category-only save on a device with no override must NOT invent a
    //    custom name (the Traffic tab bug this file guards against).
    let o = await put({ custom_category: "Printers" }, secret);
    record(
      "category-only PUT creates no custom name",
      o.customName === null && o.customCategory === "Printers",
      `customName=${JSON.stringify(o.customName)} customCategory=${JSON.stringify(o.customCategory)}`,
    );

    // 2. A later name-only save keeps the category.
    o = await put({ custom_name: "Merge Test Device", original_hostname: "orig-host" }, secret);
    record(
      "name PUT preserves category",
      o.customName === "Merge Test Device" && o.customCategory === "Printers" && o.originalHostname === "orig-host",
      `customName=${JSON.stringify(o.customName)} customCategory=${JSON.stringify(o.customCategory)}`,
    );

    // 3. Owner set elsewhere (Devices tab) survives a category-only save.
    o = await put({ owner: "Test Owner" }, secret);
    o = await put({ custom_category: "Smart Speakers" }, secret);
    record(
      "category-only PUT preserves name and owner",
      o.customName === "Merge Test Device" && o.owner === "Test Owner" && o.customCategory === "Smart Speakers",
      `customName=${JSON.stringify(o.customName)} owner=${JSON.stringify(o.owner)} customCategory=${JSON.stringify(o.customCategory)}`,
    );

    // 4. Explicit null clears only that field.
    o = await put({ custom_category: null }, secret);
    record(
      "explicit null clears just the category",
      o.customCategory === null && o.customName === "Merge Test Device" && o.owner === "Test Owner",
      `customCategory=${JSON.stringify(o.customCategory)} customName=${JSON.stringify(o.customName)}`,
    );

    // 5. Full-body PUT (Devices tab edit popover shape) still replaces all fields.
    o = await put(
      { custom_name: null, custom_category: "IoT Devices", custom_subcategory: null, owner: null, original_hostname: null },
      secret,
    );
    record(
      "full-body PUT replaces all fields",
      o.customName === null && o.customCategory === "IoT Devices" && o.owner === null,
      `customName=${JSON.stringify(o.customName)} customCategory=${JSON.stringify(o.customCategory)} owner=${JSON.stringify(o.owner)}`,
    );
  } finally {
    await fetch(BASE, { method: "DELETE", headers: { "x-cron-secret": secret } }).catch(() => {});
  }

  let failed = 0;
  for (const r of results) {
    console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.test}  (${r.detail})`);
    if (!r.passed) failed++;
  }
  if (failed > 0) {
    console.error(`${failed}/${results.length} assertions failed`);
    process.exit(1);
  }
  console.log(`All ${results.length} assertions passed`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
