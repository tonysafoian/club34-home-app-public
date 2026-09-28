import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations, type PgClientLike } from "../run-migrations.js";

interface Recorded {
  sql: string;
  params?: unknown[];
}

interface FakeClientOptions {
  /** Map of table name → exists (returned from to_regclass). */
  existingTables?: Set<string>;
  /** Initial ledger rows. */
  ledger?: Array<{ filename: string; checksum_sha256: string }>;
  /** Map of filename → throw an error on execute. */
  failOn?: Map<string, string>;
}

function fakeClient(opts: FakeClientOptions = {}): {
  client: PgClientLike;
  calls: Recorded[];
  ledger: Map<string, string>;
} {
  const calls: Recorded[] = [];
  const ledger = new Map<string, string>();
  for (const r of opts.ledger ?? []) ledger.set(r.filename, r.checksum_sha256);
  const existingTables = opts.existingTables ?? new Set<string>();
  const failOn = opts.failOn ?? new Map<string, string>();
  let inTransactionFile: string | null = null;

  const client: PgClientLike = {
    async query(sql, params) {
      calls.push({ sql, params });
      const trimmed = sql.trim();

      // CREATE TABLE / SELECT to_regclass / BEGIN / COMMIT / ROLLBACK
      if (/^CREATE TABLE IF NOT EXISTS/i.test(trimmed)) {
        return { rows: [], rowCount: 0 };
      }
      if (/^SELECT to_regclass/i.test(trimmed)) {
        const tableName = String(params?.[0] ?? "");
        const oid = existingTables.has(tableName) ? `oid-of-${tableName}` : null;
        return { rows: [{ oid }], rowCount: 1 };
      }
      if (/^SELECT filename, checksum_sha256 FROM _app_migrations/i.test(trimmed)) {
        const rows = Array.from(ledger.entries()).map(([filename, checksum_sha256]) => ({ filename, checksum_sha256 }));
        return { rows, rowCount: rows.length };
      }
      if (trimmed === "BEGIN") {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed === "COMMIT") {
        inTransactionFile = null;
        return { rows: [], rowCount: 0 };
      }
      if (trimmed === "ROLLBACK") {
        inTransactionFile = null;
        return { rows: [], rowCount: 0 };
      }
      if (/^INSERT INTO _app_migrations/i.test(trimmed)) {
        const filename = String(params?.[0] ?? "");
        const checksum = String(params?.[1] ?? "");
        ledger.set(filename, checksum);
        return { rows: [], rowCount: 1 };
      }
      // Otherwise: this is a migration SQL body. Identify which file
      // by content-prefix tag we embed in test fixtures.
      const m = trimmed.match(/^-- FILE: (\S+)/);
      if (m) {
        const file = m[1];
        inTransactionFile = file;
        if (failOn.has(file)) {
          throw new Error(failOn.get(file)!);
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, calls, ledger };
}

function setupTmpMigrations(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "migrate-test-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, "utf8");
  }
  return dir;
}

describe("runMigrations", () => {
  let dir: string;

  beforeEach(() => {
    dir = setupTmpMigrations({
      "0000_one.sql": "-- FILE: 0000_one.sql\nCREATE TABLE one ();",
      "0001_two.sql": "-- FILE: 0001_two.sql\nCREATE TABLE two ();",
      "0002_three.sql": "-- FILE: 0002_three.sql\nCREATE TABLE three ();",
    });
  });

  it("empty ledger + empty DB → applies all migrations in alphabetical order", async () => {
    const { client, calls, ledger } = fakeClient();
    const lines: string[] = [];
    const result = await runMigrations({ migrationsDir: dir, client, log: (s) => lines.push(s) });

    expect(result.applied).toBe(3);
    expect(result.skipped).toBe(0);
    expect(ledger.size).toBe(3);
    expect(Array.from(ledger.keys())).toEqual(["0000_one.sql", "0001_two.sql", "0002_three.sql"]);

    // Each migration was wrapped in BEGIN / … / COMMIT
    const beginCount = calls.filter((c) => c.sql.trim() === "BEGIN").length;
    const commitCount = calls.filter((c) => c.sql.trim() === "COMMIT").length;
    expect(beginCount).toBe(3);
    expect(commitCount).toBe(3);

    // Final summary line is logged
    expect(lines.some((l) => l.startsWith("[migrate] OK"))).toBe(true);
  });

  it("partial ledger → skips applied files, applies only the new ones", async () => {
    const { client, ledger } = fakeClient({
      ledger: [{ filename: "0000_one.sql", checksum_sha256: "stale-checksum" }],
    });
    const result = await runMigrations({ migrationsDir: dir, client });
    // Two new, one skipped (its checksum recorded is "stale-checksum"
    // which differs from the disk file, so we WARN, not apply).
    expect(result.applied).toBe(2);
    expect(result.skipped).toBe(1);
    expect(ledger.size).toBe(3);
  });

  it("checksum mismatch on already-applied file → warns but does NOT re-apply or fail", async () => {
    const { client } = fakeClient({
      ledger: [{ filename: "0000_one.sql", checksum_sha256: "different-checksum" }],
    });
    const lines: string[] = [];
    const result = await runMigrations({ migrationsDir: dir, client, log: (s) => lines.push(s) });
    expect(result.applied).toBe(2);
    expect(result.skipped).toBe(1);
    expect(lines.some((l) => l.includes("0000_one.sql") && l.includes("checksum drift"))).toBe(true);
  });

  it("smart refusal: pre-existing schema + empty ledger → throws, applies nothing", async () => {
    const { client, ledger } = fakeClient({
      existingTables: new Set(["public.profiles"]),
    });
    const lines: string[] = [];
    await expect(
      runMigrations({ migrationsDir: dir, client, log: (s) => lines.push(s) }),
    ).rejects.toThrow(/bootstrap_drift/);
    expect(ledger.size).toBe(0);
    expect(lines.some((l) => l.includes("REFUSING"))).toBe(true);
    expect(lines.some((l) => l.includes("migrate:seed"))).toBe(true);
  });

  it("smart refusal can be bypassed with skipBootstrapCheck=true", async () => {
    const { client, ledger } = fakeClient({
      existingTables: new Set(["public.profiles"]),
    });
    const result = await runMigrations({
      migrationsDir: dir,
      client,
      skipBootstrapCheck: true,
    });
    expect(result.applied).toBe(3);
    expect(ledger.size).toBe(3);
  });

  it("non-empty ledger → bootstrap check is skipped automatically (no refusal)", async () => {
    const { client, ledger } = fakeClient({
      existingTables: new Set(["public.profiles"]),
      ledger: [{ filename: "old.sql", checksum_sha256: "x" }],
    });
    // old.sql isn't on disk; runner doesn't care. The three on-disk
    // files are all new and get applied.
    const result = await runMigrations({ migrationsDir: dir, client });
    expect(result.applied).toBe(3);
    expect(ledger.size).toBe(4); // 1 pre-existing + 3 newly applied
  });

  it("SQL error during apply → ROLLBACK fires + runner throws + ledger row NOT inserted", async () => {
    const { client, calls, ledger } = fakeClient({
      failOn: new Map([["0001_two.sql", "syntax error at line 1"]]),
    });
    await expect(runMigrations({ migrationsDir: dir, client })).rejects.toThrow(/syntax error/);
    // 0000 succeeded, 0001 failed mid-transaction.
    expect(ledger.has("0000_one.sql")).toBe(true);
    expect(ledger.has("0001_two.sql")).toBe(false);
    // ROLLBACK was issued.
    expect(calls.some((c) => c.sql.trim() === "ROLLBACK")).toBe(true);
  });

  it("re-running after a successful run is a no-op (all skipped)", async () => {
    const sharedLedger = new Map<string, string>();
    const makeClient = (): PgClientLike => {
      const c = fakeClient({ ledger: Array.from(sharedLedger.entries()).map(([f, s]) => ({ filename: f, checksum_sha256: s })) });
      // Mirror back into sharedLedger after each call
      return {
        async query(sql, params) {
          const r = await c.client.query(sql, params);
          for (const [k, v] of c.ledger) sharedLedger.set(k, v);
          return r;
        },
      };
    };

    const first = await runMigrations({ migrationsDir: dir, client: makeClient() });
    expect(first.applied).toBe(3);

    const second = await runMigrations({ migrationsDir: dir, client: makeClient() });
    expect(second.applied).toBe(0);
    expect(second.skipped).toBe(3);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
