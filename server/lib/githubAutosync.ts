import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { promisify } from 'util';
import { logAudit } from './auditLog.js';

const execFileAsync = promisify(execFile);

/**
 * GitHub autosync — dev-workspace-only background pusher.
 *
 * WHY: scripts/push-to-github.sh historically ran only from post-merge.sh
 * (i.e. after Project Task merges). Changes made directly in the workspace
 * (agent chat edits, checkpoints) never reached GitHub — and since the
 * production frontend (example.com) builds from GitHub via Cloudflare Pages,
 * those changes silently never shipped until the next task merge.
 *
 * WHAT: every CHECK_INTERVAL_MS, compare HEAD to the origin/main tracking
 * ref (read-only, no fetch). If they differ, run the existing fail-closed
 * sync script (scripts/push-to-github.sh) which refreshes the token,
 * fetches, fast-forwards/merges as appropriate, and pushes. On failure
 * (e.g. real divergence with conflicts) we back off for FAILURE_BACKOFF_MS
 * unless new commits land, so the script's WhatsApp alert fires once per
 * stuck state instead of every tick.
 *
 * SAFETY:
 * - Never runs in deployments (REPLIT_DEPLOYMENT* guards here AND inside
 *   the script itself) — pushing belongs to the dev workspace only.
 * - Read-only git commands use --no-optional-locks to avoid fighting
 *   Replit's checkpoint system for lock files.
 * - Serialized via an in-flight flag; the script itself handles push races
 *   with retries and fails closed on merge conflicts (no force-push ever).
 * - Opt out by setting GITHUB_AUTOSYNC=0.
 */

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 30 * 1000;
// After a failure: wait at least FAILURE_MIN_RETRY_MS before ANY retry (even
// if new commits land — otherwise checkpoint churn during a stuck divergence
// would re-fire the script's WhatsApp alert every tick), and FAILURE_BACKOFF_MS
// before retrying the SAME stuck HEAD.
const FAILURE_MIN_RETRY_MS = 15 * 60 * 1000;
const FAILURE_BACKOFF_MS = 60 * 60 * 1000;
const SCRIPT_TIMEOUT_MS = 3 * 60 * 1000;

let inFlight = false;
let lastFailHead: string | null = null;
let lastFailAt = 0;

/**
 * Main-workspace pin (task #677) — TypeScript twin of
 * scripts/lib/workspace-guard.sh, reading the SAME pin file.
 *
 * Task-agent subrepls are full clones of this workspace (same workflows, same
 * `origin` remote with an embedded GitHub token). Without this guard, a task
 * environment that boots the app for validation would auto-push its task
 * branch's in-progress commits to origin/main — in parallel with the
 * platform's own merge of that task into the real workspace. That double-merge
 * path corrupted origin/main twice (duplicated routes/INSERTs from bad
 * auto-merges). Subrepls get REPL_ID="<parent-uuid>:<slug>", so they can never
 * match the pinned bare UUID. Missing pin file or REPL_ID fails safe (no push).
 */
const MAIN_WORKSPACE_PIN_FILE = 'scripts/lib/main-workspace-repl-id';

function mainWorkspaceGuardFailure(): string | null {
  let pin = '';
  try {
    pin = readFileSync(MAIN_WORKSPACE_PIN_FILE, 'utf8').trim();
  } catch {
    return `pin file missing or unreadable (${MAIN_WORKSPACE_PIN_FILE})`;
  }
  if (!pin) return `pin file empty (${MAIN_WORKSPACE_PIN_FILE})`;
  const replId = (process.env.REPL_ID ?? '').trim();
  if (!replId) return 'REPL_ID is unset';
  if (replId !== pin) {
    return replId.includes(':')
      ? `REPL_ID '${replId}' has a ':<slug>' suffix — this is a task subrepl`
      : `REPL_ID '${replId}' does not match pinned main workspace '${pin}'`;
  }
  return null;
}

async function gitReadOnly(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['--no-optional-locks', ...args],
      { timeout: 10_000 },
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const head = await gitReadOnly(['rev-parse', 'HEAD']);
    if (!head) return; // git unavailable — silently skip this tick

    const remote = await gitReadOnly(['rev-parse', 'origin/main']);
    if (head === remote) return; // nothing new since last known remote state

    const sinceFail = Date.now() - lastFailAt;
    if (lastFailAt > 0 && sinceFail < FAILURE_MIN_RETRY_MS) {
      return; // recent failure — hold off regardless of new commits
    }
    if (lastFailHead === head && sinceFail < FAILURE_BACKOFF_MS) {
      return; // same stuck HEAD already alerted — wait for backoff expiry
    }

    const aheadCount =
      (await gitReadOnly(['rev-list', '--count', 'origin/main..HEAD'])) ?? '?';

    console.log(
      `[github-autosync] HEAD ${head.slice(0, 8)} differs from origin/main ` +
      `(${aheadCount} commit(s) ahead) — running sync script...`,
    );

    try {
      const { stdout, stderr } = await execFileAsync(
        'bash',
        ['scripts/push-to-github.sh'],
        { timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
      const out = `${stdout}\n${stderr}`.trim();
      const tail = out.split('\n').filter(Boolean).slice(-2).join(' | ');
      console.log(`[github-autosync] ✅ ${tail}`);
      lastFailHead = null;
      await logAudit('github-autosync', {
        category: 'system',
        event_type: 'github_autosync_push',
        severity: 'info',
        actor_id: 'system',
        actor_name: 'GitHub Autosync',
        channel: 'autosync',
        summary: `Auto-pushed ${aheadCount} commit(s) to GitHub (HEAD ${head.slice(0, 8)})`,
        status: 'success',
        detail: { head, commits_ahead: aheadCount },
      });
    } catch (err) {
      lastFailHead = head;
      lastFailAt = Date.now();
      const e = err as { stdout?: string; stderr?: string; code?: number };
      const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim();
      const tail = out.split('\n').filter(Boolean).slice(-5).join('\n');
      console.error(
        `[github-autosync] ❌ Sync failed (exit ${e.code ?? '?'}) at HEAD ` +
        `${head.slice(0, 8)}. Backing off 60 min unless new commits land.\n${tail}`,
      );
      await logAudit('github-autosync', {
        category: 'system',
        event_type: 'github_autosync_failed',
        severity: 'warning',
        actor_id: 'system',
        actor_name: 'GitHub Autosync',
        channel: 'autosync',
        summary: `GitHub auto-push failed at HEAD ${head.slice(0, 8)} — retrying when new commits land or after 60 min`,
        status: 'failed',
        detail: {
          head,
          exit_code: e.code ?? null,
          output_tail: tail.slice(0, 2000),
        },
      });
    }
  } finally {
    inFlight = false;
  }
}

export function startGithubAutosync(): void {
  const isDeployment = !!(
    process.env.REPLIT_DEPLOYMENT ||
    process.env.REPLIT_DEPLOYMENT_ID ||
    process.env.REPL_DEPLOYMENT_ID
  );
  if (isDeployment || process.env.NODE_ENV === 'production') {
    return; // pushing belongs to the dev workspace only
  }
  if (process.env.GITHUB_AUTOSYNC === '0') {
    console.log('[github-autosync] Disabled via GITHUB_AUTOSYNC=0');
    return;
  }
  const guardFailure = mainWorkspaceGuardFailure();
  if (guardFailure) {
    console.log(
      `[github-autosync] Disabled: ${guardFailure}. Only the main workspace ` +
      'pushes to GitHub — task subrepls never push (prevents parallel ' +
      'task-merge corruption of origin/main; task #677).',
    );
    return;
  }
  setTimeout(() => { void tick(); }, FIRST_CHECK_DELAY_MS);
  setInterval(() => { void tick(); }, CHECK_INTERVAL_MS);
  console.log(
    '[github-autosync] Enabled (dev workspace) — checking for unpushed ' +
    'commits every 5 min; first check in 30s.',
  );
}
