#!/usr/bin/env node
/**
 * Club34 — auto-versioning + changelog generator
 *
 * Reads commits since the last semver tag, classifies them by conventional
 * commit prefix, computes the next version, and:
 *   1. Writes CHANGELOG.md (full history, grouped by version)
 *   2. Writes public/changelog.json (machine-readable, served via API)
 *   3. Bumps package.json version
 *   4. Tags HEAD with the new version
 *
 * Conventional commit rules:
 *   - "BREAKING CHANGE" in body OR "type!:" → MAJOR
 *   - "feat:" / "feat(scope):"             → MINOR
 *   - "fix:" / "perf:" / "refactor:"       → PATCH
 *   - "chore:" / "docs:" / "style:" / "test:" / "ci:" / "build:" → NO BUMP (still listed)
 *   - "Published your App" + anything not matching a prefix → SKIPPED ENTIRELY
 *
 * Usage:
 *   node scripts/changelog/generate-changelog.mjs           # dry-run, prints plan
 *   node scripts/changelog/generate-changelog.mjs --write   # actually writes files + tags
 *   node scripts/changelog/generate-changelog.mjs --init    # treat all history as v0.1.0 seed
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const CHANGELOG_PATH = path.join(REPO_ROOT, 'CHANGELOG.md');
const JSON_PATH = path.join(REPO_ROOT, 'public/changelog.json');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');

const args = new Set(process.argv.slice(2));
const WRITE = args.has('--write');
const INIT = args.has('--init');

function sh(cmd) {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function latestSemverTag() {
  try {
    const tags = sh('git tag --list "v*.*.*" --sort=-v:refname').split('\n').filter(Boolean);
    return tags[0] ?? null;
  } catch {
    return null;
  }
}

// Conventional commit type → bump level
// Returns { type, scope, breaking, subject } or null if not a conventional commit
function parseConventionalCommit(message) {
  const firstLine = message.split('\n')[0];
  // Skip auto-publish commits entirely
  if (/^Published your App/i.test(firstLine)) return null;
  // Skip squash-merge PR boilerplate that's purely a number
  if (/^Merge pull request #\d+/i.test(firstLine)) return null;

  const re = /^(feat|fix|perf|refactor|chore|docs|style|test|ci|build|revert)(\(([^)]+)\))?(!)?:\s+(.+)$/;
  const m = firstLine.match(re);
  if (!m) return null;

  const [, type, , scope, bang, subject] = m;
  const hasBreaking = !!bang || /BREAKING CHANGE/i.test(message);
  return { type, scope: scope ?? null, breaking: hasBreaking, subject: subject.trim() };
}

function bumpLevelFor(type, breaking) {
  if (breaking) return 'major';
  if (type === 'feat') return 'minor';
  if (['fix', 'perf', 'refactor', 'revert'].includes(type)) return 'patch';
  return 'none';
}

function applyBump(current, level) {
  let [maj, min, pat] = current.split('.').map(Number);
  if (level === 'major') { maj++; min = 0; pat = 0; }
  else if (level === 'minor') { min++; pat = 0; }
  else if (level === 'patch') { pat++; }
  return `${maj}.${min}.${pat}`;
}

function collectCommits(fromRef, toRef) {
  // We want subject + body + sha + date for each commit. Use a delimiter
  // unlikely to appear in normal commit messages.
  const DELIM = '<<<COMMIT-END>>>';
  const FIELD = '<<<FIELD>>>';
  const range = fromRef ? `${fromRef}..${toRef}` : toRef;
  const out = sh(
    `git log ${range} --pretty=format:'%H${FIELD}%aI${FIELD}%s${FIELD}%b${DELIM}' --no-merges`,
  );
  if (!out) return [];
  return out
    .split(DELIM)
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      const [sha, date, subject, body] = entry.split(FIELD);
      return { sha, date, subject, body: body ?? '', message: `${subject}\n\n${body ?? ''}` };
    });
}

function loadExistingJson() {
  if (!existsSync(JSON_PATH)) return { versions: [] };
  try {
    return JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  } catch {
    return { versions: [] };
  }
}

function classifyCommits(commits) {
  // Returns array of { type, scope, breaking, subject, sha, date }
  const entries = [];
  for (const c of commits) {
    const parsed = parseConventionalCommit(c.message);
    if (!parsed) continue;
    entries.push({ ...parsed, sha: c.sha, shortSha: c.sha.slice(0, 7), date: c.date });
  }
  return entries;
}

function highestBumpLevel(entries) {
  let result = 'none';
  for (const e of entries) {
    const level = bumpLevelFor(e.type, e.breaking);
    if (level === 'major') return 'major';
    if (level === 'minor' && result === 'none') result = 'minor';
    if (level === 'minor' && result === 'patch') result = 'minor';
    if (level === 'patch' && result === 'none') result = 'patch';
  }
  return result;
}

// ─── MAIN ──────────────────────────────────────────────────────────

const headSha = sh('git rev-parse HEAD');
const shortHead = headSha.slice(0, 7);
const headDate = sh('git log -1 --pretty=format:%aI');

const existingJson = loadExistingJson();
const lastTag = latestSemverTag();
const currentVersion = lastTag ? lastTag.replace(/^v/, '') : '0.0.0';

let commits;
let baseVersion;
if (INIT || !lastTag) {
  // Initial run: take ALL history, set base to 0.0.0, bump to derived
  commits = collectCommits(null, 'HEAD');
  baseVersion = '0.0.0';
  console.log(`[changelog] INIT mode — processing all ${commits.length} commits`);
} else {
  commits = collectCommits(lastTag, 'HEAD');
  baseVersion = currentVersion;
  console.log(`[changelog] Last tag: ${lastTag} — ${commits.length} commits since`);
}

const entries = classifyCommits(commits);
console.log(`[changelog] ${entries.length} conventional commits found (${commits.length - entries.length} skipped/noise)`);

const bumpLevel = highestBumpLevel(entries);
console.log(`[changelog] Bump level: ${bumpLevel}`);

if (bumpLevel === 'none' && !INIT) {
  console.log('[changelog] No releasable changes since last tag. Nothing to do.');
  process.exit(0);
}

// On INIT with no qualifying commits, seed at 0.1.0 anyway
const newVersion =
  INIT && bumpLevel === 'none'
    ? '0.1.0'
    : applyBump(baseVersion, bumpLevel === 'none' ? 'patch' : bumpLevel);

console.log(`[changelog] ${baseVersion} → ${newVersion}`);

// Group entries by section (for readable changelog)
const SECTION_ORDER = [
  ['Breaking Changes', e => e.breaking],
  ['Features', e => e.type === 'feat' && !e.breaking],
  ['Fixes', e => e.type === 'fix' && !e.breaking],
  ['Performance', e => e.type === 'perf' && !e.breaking],
  ['Refactor', e => e.type === 'refactor' && !e.breaking],
  ['Reverts', e => e.type === 'revert'],
  ['Chores & Docs', e => ['chore', 'docs', 'style', 'test', 'ci', 'build'].includes(e.type)],
];

function groupEntries(entries) {
  const groups = [];
  const used = new Set();
  for (const [title, predicate] of SECTION_ORDER) {
    const matched = entries.filter(e => !used.has(e.sha) && predicate(e));
    matched.forEach(e => used.add(e.sha));
    if (matched.length) groups.push({ title, items: matched });
  }
  return groups;
}

const groups = groupEntries(entries);

// Build the new version entry
const newVersionEntry = {
  version: newVersion,
  date: headDate.slice(0, 10),
  commit: shortHead,
  groups: groups.map(g => ({
    title: g.title,
    items: g.items.map(e => ({
      subject: e.subject,
      scope: e.scope,
      sha: e.shortSha,
      breaking: e.breaking,
    })),
  })),
};

// ─── WRITE FILES ──────────────────────────────────────────────

const newJson = {
  current: newVersion,
  generatedAt: new Date().toISOString(),
  versions: [newVersionEntry, ...(existingJson.versions ?? [])],
};

function renderMarkdown(json) {
  const lines = [];
  lines.push('# Changelog');
  lines.push('');
  lines.push('All notable changes to Club34. Auto-generated from conventional commits.');
  lines.push('');
  for (const v of json.versions) {
    lines.push(`## v${v.version} — ${v.date}`);
    lines.push('');
    lines.push(`Commit: \`${v.commit}\``);
    lines.push('');
    for (const g of v.groups) {
      lines.push(`### ${g.title}`);
      lines.push('');
      for (const item of g.items) {
        const scope = item.scope ? `**${item.scope}**: ` : '';
        const breaking = item.breaking ? '🚨 ' : '';
        lines.push(`- ${breaking}${scope}${item.subject} (\`${item.sha}\`)`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

if (WRITE) {
  // 1. CHANGELOG.md
  writeFileSync(CHANGELOG_PATH, renderMarkdown(newJson));

  // 2. public/changelog.json
  mkdirSync(path.dirname(JSON_PATH), { recursive: true });
  writeFileSync(JSON_PATH, JSON.stringify(newJson, null, 2));

  // 3. Bump package.json
  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = newVersion;
  writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + '\n');

  console.log(`[changelog] Wrote CHANGELOG.md, public/changelog.json, package.json (v${newVersion})`);
  // The GitHub Action handles the tag + commit + push
} else {
  console.log('[changelog] DRY RUN — would write:');
  console.log(`  - CHANGELOG.md`);
  console.log(`  - public/changelog.json (${newJson.versions.length} versions)`);
  console.log(`  - package.json version → ${newVersion}`);
  console.log('');
  console.log('--- Preview of new entry ---');
  console.log(renderMarkdown({ versions: [newVersionEntry] }));
}
