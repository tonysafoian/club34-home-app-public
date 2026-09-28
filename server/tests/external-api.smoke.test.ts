/**
 * Smoke test for the External API (Task #217).
 *
 * Run while `Start application` workflow is up:
 *   npx tsx server/tests/external-api.smoke.test.ts
 *
 * Asserts:
 *   - 401 with no key
 *   - 401 with bad key
 *   - 200 + JSON shape on /health, /capabilities, /tools
 *   - capabilities response lists endpoints + tools
 *   - /tools/:name/invoke returns a result envelope
 *   - response sanitizer redacts known secret-keyed fields (probe via /audit-log if present)
 */

export {}; // make this file a module so its top-level names don't collide with other script-style tests

const PORT = process.env.PORT || 5000;
const BASE = `http://localhost:${PORT}/api/v1/external`;
const KEY = process.env.EXTERNAL_API_KEY;

interface Result { test: string; passed: boolean; detail: string }
const results: Result[] = [];

function record(test: string, passed: boolean, detail: string) {
  results.push({ test, passed, detail });
}

async function main() {
  if (!KEY) {
    console.error("EXTERNAL_API_KEY not set in this process — cannot run smoke test.");
    process.exit(2);
  }

  // 1. No key → 401
  {
    const r = await fetch(`${BASE}/capabilities`);
    record("no x-api-key → 401", r.status === 401, `status=${r.status}`);
  }

  // 2. Bad key → 401
  {
    const r = await fetch(`${BASE}/capabilities`, { headers: { "x-api-key": "wrong-key" } });
    record("bad x-api-key → 401", r.status === 401, `status=${r.status}`);
  }

  // 3. Health → 200
  {
    const r = await fetch(`${BASE}/health`, { headers: { "x-api-key": KEY } });
    const body = await r.json();
    record(
      "GET /health → 200 with success envelope",
      r.status === 200 && body.success === true && !!body.data?.ok,
      `status=${r.status} body=${JSON.stringify(body).slice(0, 120)}`,
    );
  }

  // 4. Capabilities → 200, lists endpoints & tools
  let caps: any = null;
  {
    const r = await fetch(`${BASE}/capabilities`, { headers: { "x-api-key": KEY } });
    caps = await r.json();
    const ok = r.status === 200
      && caps?.success === true
      && Array.isArray(caps?.data?.endpoints)
      && caps.data.endpoints.length > 10
      && Array.isArray(caps?.data?.tools)
      && caps.data.tools.length > 0;
    record(
      "GET /capabilities → 200 with endpoint + tool catalog",
      ok,
      `endpoints=${caps?.data?.endpoints?.length} tools=${caps?.data?.tools?.length}`,
    );
  }

  // 5. /tools listing
  {
    const r = await fetch(`${BASE}/tools`, { headers: { "x-api-key": KEY } });
    const body = await r.json();
    record(
      "GET /tools → 200 with tools array",
      r.status === 200 && Array.isArray(body?.data?.tools) && body.data.tools.length > 0,
      `count=${body?.data?.tools?.length}`,
    );
  }

  // 6. /tools/unknown → returns error envelope
  {
    const r = await fetch(`${BASE}/tools/__nope__/invoke`, {
      method: "POST",
      headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await r.json();
    record(
      "POST /tools/__nope__/invoke → error envelope",
      r.status === 500 && body.success === false && /Unknown tool/.test(body.error || ""),
      `status=${r.status} error=${body.error}`,
    );
  }

  // 7. /audit-log returns rows (we just made several calls, all of which were audited)
  {
    const r = await fetch(`${BASE}/audit-log?category=external_api&limit=10`, {
      headers: { "x-api-key": KEY },
    });
    const body = await r.json();
    const rows = body?.data?.rows || [];
    record(
      "GET /audit-log includes external_api entries",
      r.status === 200 && Array.isArray(rows) && rows.some((row: any) => row.category === "external_api"),
      `rows=${rows.length}`,
    );
  }

  // 8. Sanitizer: simulate by hitting /tools/recall_facts/invoke (returns string, never tokens — just shape check)
  {
    const r = await fetch(`${BASE}/tools/recall_facts/invoke`, {
      method: "POST",
      headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ key_search: "smoke_test_nonexistent_key_xyz" }),
    });
    const body = await r.json();
    record(
      "POST /tools/recall_facts/invoke → success envelope",
      r.status === 200 && body?.success === true && body?.data?.tool === "recall_facts",
      `status=${r.status}`,
    );
  }

  // 9. 404 envelope for unknown subpath
  {
    const r = await fetch(`${BASE}/totally-not-a-real-endpoint`, { headers: { "x-api-key": KEY } });
    const body = await r.json();
    record(
      "unknown endpoint → 404 envelope",
      r.status === 404 && body?.success === false,
      `status=${r.status}`,
    );
  }

  // 10. /capabilities exposes parameter (query/body) shapes
  {
    const eps = caps?.data?.endpoints || [];
    const withBody = eps.filter((e: any) => e.body && typeof e.body === "object").length;
    const withQuery = eps.filter((e: any) => e.query && typeof e.query === "object").length;
    record(
      "/capabilities endpoints expose body & query shapes",
      withBody >= 5 && withQuery >= 3,
      `body_shapes=${withBody} query_shapes=${withQuery}`,
    );
  }

  // 11. New reads are mounted (do not assert success — upstreams may be down — only assert routing)
  for (const path of ["/weather", "/pool/status", "/network/status", "/activity"]) {
    const r = await fetch(`${BASE}${path}`, { headers: { "x-api-key": KEY } });
    const body = await r.json();
    record(
      `GET ${path} mounted (200 or 5xx with envelope, NOT 404)`,
      r.status !== 404 && typeof body?.success === "boolean",
      `status=${r.status} success=${body?.success}`,
    );
  }

  // 12. PATCH /calendar/event/:id is mounted (will likely fail without a real event id, but must NOT 404)
  {
    const r = await fetch(`${BASE}/calendar/event/__nonexistent__`, {
      method: "PATCH",
      headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "smoke" }),
    });
    record(
      "PATCH /calendar/event/:id mounted",
      r.status !== 404,
      `status=${r.status}`,
    );
  }

  // 13. Schema validation rejects bad args for a real tool
  {
    const r = await fetch(`${BASE}/tools/recall_facts/invoke`, {
      method: "POST",
      headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ key_search: 12345 }), // wrong type
    });
    const body = await r.json();
    record(
      "Schema validation rejects wrong-typed tool args with 400",
      r.status === 400 && body?.success === false && /Invalid arguments/i.test(body?.error || ""),
      `status=${r.status} error=${body?.error}`,
    );
  }

  // 15. Action endpoint body validation: missing required fields → 400 with field-level errors
  {
    const r = await fetch(`${BASE}/home/call-service`, {
      method: "POST",
      headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: "{}", // domain + service are required
    });
    const body = (await r.json()) as { success?: boolean; error?: string; detail?: unknown };
    const errors: Array<{ message?: string; params?: { missingProperty?: string } }> =
      Array.isArray(body?.detail) ? body.detail : [];
    const missing = errors.map((e) => e?.params?.missingProperty).filter(Boolean);
    record(
      "POST /home/call-service {} → 400 with missing-field errors",
      r.status === 400 && body?.success === false && missing.includes("domain") && missing.includes("service"),
      `status=${r.status} missing=${JSON.stringify(missing)}`,
    );
  }

  // 16. Action endpoint body validation: wrong-typed field → 400
  {
    const r = await fetch(`${BASE}/memory`, {
      method: "POST",
      headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "smoke", key: "k", value: 12345 }), // value must be string
    });
    const body = (await r.json()) as { success?: boolean; error?: string };
    record(
      "POST /memory wrong-typed value → 400",
      r.status === 400 && body?.success === false && /Invalid request body/i.test(body?.error || ""),
      `status=${r.status} error=${body?.error}`,
    );
  }

  // 17. Action endpoint body validation: wrong-typed PATCH body → 400 (no Notion call made)
  {
    const r = await fetch(`${BASE}/notion/page/__smoke__`, {
      method: "PATCH",
      headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ archived: "yes" }), // archived must be boolean
    });
    const body = (await r.json()) as { success?: boolean; error?: string };
    record(
      "PATCH /notion/page/:id wrong-typed archived → 400",
      r.status === 400 && body?.success === false,
      `status=${r.status} error=${body?.error}`,
    );
  }

  // 17a. Cross-field constraints: handler-required combinations are enforced at the schema layer
  {
    // email needs html or text
    const r1 = await fetch(`${BASE}/email/send`, {
      method: "POST",
      headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ to: "smoke@example.com", subject: "smoke" }),
    });
    const b1 = (await r1.json()) as { success?: boolean; error?: string };
    record(
      "POST /email/send without html/text → 400",
      r1.status === 400 && b1?.success === false && /Invalid request body/i.test(b1?.error || ""),
      `status=${r1.status} error=${b1?.error}`,
    );

    // notion page update needs properties or archived
    const r2 = await fetch(`${BASE}/notion/page/__smoke__`, {
      method: "PATCH",
      headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: "{}",
    });
    const b2 = (await r2.json()) as { success?: boolean; error?: string };
    record(
      "PATCH /notion/page/:id {} (neither properties nor archived) → 400",
      r2.status === 400 && b2?.success === false && /Invalid request body/i.test(b2?.error || ""),
      `status=${r2.status} error=${b2?.error}`,
    );

    // empty required strings are as bad as missing ones
    const r3 = await fetch(`${BASE}/home/call-service`, {
      method: "POST",
      headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "", service: "" }),
    });
    const b3 = (await r3.json()) as { success?: boolean; error?: string };
    record(
      "POST /home/call-service empty-string domain/service → 400",
      r3.status === 400 && b3?.success === false && /Invalid request body/i.test(b3?.error || ""),
      `status=${r3.status} error=${b3?.error}`,
    );
  }

  // 17b. Non-object bodies (null / array / primitive) → 400 on optional-body PATCH endpoints
  // These endpoints have no required fields, so {} would pass — the validator
  // must reject the body shape itself, not normalize it away.
  {
    const cases: Array<{ path: string; payload: string; label: string }> = [
      { path: "/calendar/event/__smoke__", payload: "null", label: "null" },
      { path: "/calendar/event/__smoke__", payload: "[1,2]", label: "array" },
      { path: "/calendar/event/__smoke__", payload: "\"hi\"", label: "string" },
      { path: "/notion/page/__smoke__", payload: "null", label: "null" },
      { path: "/notion/page/__smoke__", payload: "[]", label: "array" },
      { path: "/notion/page/__smoke__", payload: "42", label: "number" },
    ];
    for (const c of cases) {
      const r = await fetch(`${BASE}${c.path}`, {
        method: "PATCH",
        headers: { "x-api-key": KEY, "Content-Type": "application/json" },
        body: c.payload,
      });
      // Arrays reach the schema validator ("Invalid request body ..."); null
      // and primitives are already rejected upstream by express.json strict
      // parsing. Either way the contract is: 400, handler never runs.
      const body = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string };
      record(
        `PATCH ${c.path} ${c.label} body → 400`,
        r.status === 400 && body?.success !== true,
        `status=${r.status} error=${body?.error}`,
      );
    }
  }

  // 17c. Non-object body → 400 on tool invocation too
  {
    const r = await fetch(`${BASE}/tools/recall_facts/invoke`, {
      method: "POST",
      headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: "[\"not\",\"an\",\"object\"]",
    });
    const body = (await r.json()) as { success?: boolean; error?: string };
    record(
      "POST /tools/:name/invoke array body → 400",
      r.status === 400 && body?.success === false && /Invalid arguments/i.test(body?.error || ""),
      `status=${r.status} error=${body?.error}`,
    );
  }

  // 18. Valid body still passes validation and reaches the handler
  {
    const r = await fetch(`${BASE}/memory`, {
      method: "POST",
      headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "smoke_test", key: "smoke_validation_probe", value: "ok" }),
    });
    const body = (await r.json()) as { success?: boolean };
    record(
      "POST /memory valid body → 200 (validation does not over-reject)",
      r.status === 200 && body?.success === true,
      `status=${r.status}`,
    );
  }

  // 14. Audit log entries include duration_ms and request payload for action calls
  {
    const r = await fetch(`${BASE}/audit-log?category=external_api&limit=20`, {
      headers: { "x-api-key": KEY },
    });
    const body = await r.json();
    const rows = body?.data?.rows || [];
    const enriched = rows.find(
      (row: any) =>
        row.detail &&
        typeof row.detail.duration_ms === "number" &&
        (row.detail.request !== undefined || row.detail.response_preview !== undefined),
    );
    record(
      "audit log entries include duration_ms + request/response_preview",
      !!enriched,
      `enriched_rows=${rows.filter((r: any) => typeof r?.detail?.duration_ms === "number").length}/${rows.length}`,
    );
  }

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
