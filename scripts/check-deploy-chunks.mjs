#!/usr/bin/env node
// check-deploy-chunks.mjs — post-deploy smoke test for broken chunk references.
//
// Why this exists:
//   Even with no-store headers and NetworkOnly navigation, a deploy that drops
//   or fails to upload a hashed JS/CSS chunk leaves the live index.html pointing
//   at a 404. The first user to hit that route gets a white screen. This script
//   fetches the freshly-deployed index.html, extracts every hashed asset it
//   references (entry <script type="module">, <link rel="modulepreload">, and
//   <link rel="stylesheet">), and asserts each one returns HTTP 200. If any
//   chunk is missing it exits non-zero so the deploy pipeline fails loudly and
//   the broken release can be rolled back before users notice.
//
// Usage:
//   node scripts/check-deploy-chunks.mjs                       # checks https://example.com
//   node scripts/check-deploy-chunks.mjs https://example.com    # explicit base URL
//   BASE_URL=https://example.com node scripts/check-deploy-chunks.mjs
//
// Env knobs:
//   BASE_URL         base origin to probe (default https://example.com)
//   INDEX_RETRIES    times to retry the initial index.html fetch (default 6)
//   INDEX_RETRY_MS   delay between index fetch retries in ms (default 5000)
//   REQUEST_TIMEOUT  per-request timeout in ms (default 10000)
//
// Exit codes:
//   0  — index.html fetched and every referenced chunk returned 200
//   1  — at least one chunk is missing / non-200
//   2  — could not fetch index.html, or no chunks found to verify

const BASE_URL = (process.argv[2] || process.env.BASE_URL || "https://example.com").replace(/\/+$/, "");
const INDEX_RETRIES = Number(process.env.INDEX_RETRIES || 6);
const INDEX_RETRY_MS = Number(process.env.INDEX_RETRY_MS || 5000);
const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT || 10000);

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Pull every hashed asset reference out of the index.html. We match the entry
// module script, modulepreload hints, and the stylesheet link — these are the
// resources whose hash changes every build and that vanish on the next deploy.
function extractAssetUrls(html) {
  const urls = new Set();

  const scriptRe = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const altScriptRe = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*\btype=["']module["'][^>]*>/gi;
  const modulePreloadRe = /<link\b[^>]*\brel=["']modulepreload["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  const stylesheetRe = /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi;

  for (const re of [scriptRe, altScriptRe, modulePreloadRe, stylesheetRe]) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      // Only verify local, bundled assets — skip external CDN/font URLs.
      if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//")) continue;
      urls.add(href);
    }
  }

  return [...urls];
}

async function fetchIndex() {
  const indexUrl = `${BASE_URL}/index.html`;
  let lastErr = "";
  for (let attempt = 1; attempt <= INDEX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(indexUrl, { headers: NO_CACHE_HEADERS });
      if (res.ok) {
        return await res.text();
      }
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err?.message || String(err);
    }
    if (attempt < INDEX_RETRIES) {
      console.log(`  index.html not ready (${lastErr}); retry ${attempt}/${INDEX_RETRIES - 1} in ${INDEX_RETRY_MS}ms…`);
      await sleep(INDEX_RETRY_MS);
    }
  }
  console.error(`\n❌  Could not fetch ${indexUrl} after ${INDEX_RETRIES} attempts (last: ${lastErr})`);
  process.exit(2);
}

async function checkChunk(href) {
  const url = `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
  try {
    let res = await fetchWithTimeout(url, { method: "HEAD", headers: NO_CACHE_HEADERS });
    // Some CDNs don't support HEAD for static assets — fall back to GET.
    if (res.status === 405 || res.status === 501) {
      res = await fetchWithTimeout(url, { method: "GET", headers: NO_CACHE_HEADERS });
    }
    return { href, url, status: res.status, ok: res.ok };
  } catch (err) {
    return { href, url, status: 0, ok: false, error: err?.message || String(err) };
  }
}

async function main() {
  console.log(`\nPost-deploy chunk check — ${new Date().toISOString()}`);
  console.log(`Base URL: ${BASE_URL}\n`);

  const html = await fetchIndex();
  const assets = extractAssetUrls(html);

  if (assets.length === 0) {
    console.error("❌  No hashed asset references found in index.html — refusing to pass a vacuous check.");
    process.exit(2);
  }

  console.log(`Found ${assets.length} asset reference(s) in index.html. Verifying…\n`);

  const results = await Promise.all(assets.map(checkChunk));

  const failures = [];
  for (const r of results) {
    if (r.ok) {
      console.log(`  ✅  HTTP ${r.status}  ${r.href}`);
    } else {
      const detail = r.error ? `${r.error}` : `HTTP ${r.status}`;
      console.log(`  ❌  ${detail}  ${r.href}`);
      failures.push(r);
    }
  }

  console.log("\n───────────────────────────────────────────────");
  console.log(`Checked: ${results.length}   Passed: ${results.length - failures.length}   Failed: ${failures.length}`);

  if (failures.length > 0) {
    console.error("\n❌  Broken chunk reference(s) detected in the live deploy:");
    for (const f of failures) {
      console.error(`  - ${f.url} → ${f.error ? f.error : `HTTP ${f.status}`}`);
    }
    console.error("\nThe deployed index.html points at assets that are not served.");
    console.error("Roll back this deploy or re-run the frontend build/upload.\n");
    process.exit(1);
  }

  console.log("\n✅  All referenced chunks are live. Deploy looks healthy.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n❌  Unexpected error: ${err?.stack || err}`);
  process.exit(2);
});
