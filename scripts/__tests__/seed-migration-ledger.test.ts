import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedMigrationLedger } from "../seed-migration-ledger.js";
import type { PgClientLike } from "../run-migrations.js";

function fakeClient(initialLedger: Set<string> = new Set()): {
  client: PgClientLike;
  ledger: Set<string>;
  checksums: Map<string, string>;
} {
  const ledger = new Set<string>(initialLedger);
  const checksums = new Map<string, string>();
  const client: PgClientLike = {
    async query(sql, params) {
      const trimmed = sql.trim();
      if (/^CREATE TABLE IF NOT EXISTS/i.test(trimmed)) return { rows: [], rowCount: 0 };
      if (/^INSERT INTO _app_migrations/i.test(trimmed)) {
        const filename = String(params?.[0] ?? "");
        const checksum = String(params?.[1] ?? "");
        if (ledger.has(filename)) {
          // ON CONFLICT DO NOTHING — rowCount is 0
          return { rows: [], rowCount: 0 };
        }
        ledger.add(filename);
        checksums.set(filename, checksum);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, ledger, checksums };
}

function setupTmpMigrations(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "seed-test-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, "utf8");
  }
  return dir;
}

describe("seedMigrationLedger", () => {
  let dir: string;

  beforeEach(() => {
    dir = setupTmpMigrations({
      "0000_a.sql": "create table a ();",
      "0001_b.sql": "create table b ();",
      "0002_c.sql": "create table c ();",
    });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("inserts every migration file into the ledger on a clean run", async () => {
    const { client, ledger, checksums } = fakeClient();
    const result = await seedMigrationLedger({ migrationsDir: dir, client });
    expect(result.total).toBe(3);
    expect(result.inserted).toBe(3);
    expect(result.skipped).toBe(0);
    expect(Array.from(ledger).sort()).toEqual(["0000_a.sql", "0001_b.sql", "0002_c.sql"]);
    // Checksums are 64-hex-char SHA-256.
    for (const cs of checksums.values()) {
      expect(cs).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("is idempotent: re-running inserts 0 rows", async () => {
    const { client } = fakeClient(new Set(["0000_a.sql", "0001_b.sql", "0002_c.sql"]));
    const result = await seedMigrationLedger({ migrationsDir: dir, client });
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(3);
  });

  it("partial pre-existing ledger: only inserts the missing files", async () => {
    const { client, ledger } = fakeClient(new Set(["0000_a.sql"]));
    const result = await seedMigrationLedger({ migrationsDir: dir, client });
    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(1);
    expect(ledger.size).toBe(3);
  });

  it("logs each filename + checksum prefix", async () => {
    const { client } = fakeClient();
    const lines: string[] = [];
    await seedMigrationLedger({ migrationsDir: dir, client, log: (s) => lines.push(s) });
    expect(lines.filter((l) => l.startsWith("[migrate:seed] inserted")).length).toBe(3);
    expect(lines.some((l) => l.includes("0000_a.sql"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[migrate:seed] OK"))).toBe(true);
  });

  it("ignores non-.sql files in the migrations directory", async () => {
    writeFileSync(join(dir, "_journal.json"), '{"entries":[]}', "utf8");
    writeFileSync(join(dir, "schema.ts"), "// not a migration", "utf8");
    const { client, ledger } = fakeClient();
    const result = await seedMigrationLedger({ migrationsDir: dir, client });
    expect(result.total).toBe(3); // only .sql files counted
    expect(ledger.size).toBe(3);
    expect(ledger.has("_journal.json")).toBe(false);
    expect(ledger.has("schema.ts")).toBe(false);
  });
});
