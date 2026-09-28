#!/usr/bin/env node
// Run this LOCALLY on your laptop, not in the Claude container.
// Opens a real browser window. You log in by hand. Press Enter in the
// terminal when you're done. Playwright writes the storageState JSON.
//
// Usage:
//   npm run capture -- https://example.com --out club34.json
//   npm run capture -- https://9gyhj...nabu.casa --out ha.json

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
let url;
let out;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') {
    out = args[++i];
  } else if (a.startsWith('--out=')) {
    out = a.slice('--out='.length);
  } else if (!url) {
    url = a;
  }
}

if (!url) {
  console.error('Usage: npm run capture -- <url> [--out <path>]');
  process.exit(1);
}

const stateDir = resolve(__dirname, '..', '.state');
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

const defaultName = url
  .replace(/^https?:\/\//, '')
  .replace(/[^a-z0-9]+/gi, '_')
  .slice(0, 60) + '.json';
const outPath = resolve(out ? resolve(process.cwd(), out) : resolve(stateDir, defaultName));

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  ignoreHTTPSErrors: true,
  serviceWorkers: 'block',
});
const page = await context.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

console.log('');
console.log('=== Sign in in the browser window that just opened. ===');
console.log('When you can see the logged-in app, come back here and press Enter.');
console.log('');

await new Promise((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Press Enter when signed in... ', () => {
    rl.close();
    res();
  });
});

await context.storageState({ path: outPath });
await browser.close();

console.log('');
console.log('Saved storageState to:', outPath);
console.log('Upload that file to Claude and we\'ll wire it in.');
