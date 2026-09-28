#!/usr/bin/env node
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './_env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv();

const args = process.argv.slice(2);
let url;
let statePath;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--state') {
    statePath = args[++i];
  } else if (a.startsWith('--state=')) {
    statePath = a.slice('--state='.length);
  } else if (!url) {
    url = a;
  }
}
url ??= process.env.APP_URL;
if (!url) {
  console.error('Usage: npm run open -- <url> [--state <path>]   (or set APP_URL in tools/browse/.env)');
  process.exit(1);
}

const shotsDir = resolve(__dirname, '..', 'screenshots');
if (!existsSync(shotsDir)) mkdirSync(shotsDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const safeName = url.replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
const shotPath = resolve(shotsDir, `${stamp}__${safeName}.png`);

const resolvedState = statePath ? resolve(process.cwd(), statePath) : undefined;
if (resolvedState && !existsSync(resolvedState)) {
  console.error(`--state file not found: ${resolvedState}`);
  process.exit(1);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  ignoreHTTPSErrors: true,
  serviceWorkers: 'block',
  ...(resolvedState ? { storageState: resolvedState } : {}),
});
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
const status = response?.status() ?? 0;
const title = await page.title();
await page.screenshot({ path: shotPath, fullPage: true });

await browser.close();

console.log(JSON.stringify(
  { url, status, title, screenshot: shotPath, state: resolvedState ?? null, consoleErrors },
  null,
  2,
));
