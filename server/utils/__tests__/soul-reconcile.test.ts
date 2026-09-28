import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { reconcileSoulSource } from "../soul-reconcile.js";

type QueryFn = (sql: string, params?: unknown[]) => Promise<{
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}>;
type AuditFn = (edgeFunction: string, entry: Record<string, unknown>) => Promise<void>;
type QueryMock = ReturnType<typeof vi.fn> & QueryFn;
type AuditMock = ReturnType<typeof vi.fn> & AuditFn;

async function writeTempSoul(content: string, mtime?: Date): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "soul-reconcile-"));
  const file = path.join(dir, "SOUL.md");
  await fsp.writeFile(file, content, "utf8");
  if (mtime) await fsp.utimes(file, mtime, mtime);
  return file;
}

describe("reconcileSoulSource", () => {
  let queryMock: QueryMock;
  let auditMock: AuditMock;

  beforeEach(() => {
    queryMock = vi.fn() as QueryMock;
    auditMock = vi.fn().mockResolvedValue(undefined) as AuditMock;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs in-sync and writes nothing when file and DB content match", async () => {
    const text = "shared SOUL content";
    const file = await writeTempSoul(text);
    queryMock.mockResolvedValueOnce({
      rows: [{ content: text, updated_at: "2026-05-01T00:00:00Z" }],
      rowCount: 1,
    });

    const result = await reconcileSoulSource({ soulFilePath: file, query: queryMock, logAudit: auditMock });
    expect(result.status).toBe("in_sync");
    expect(result.fileHash).toBe(result.dbHash);
    // Only the SELECT — no UPDATE / INSERT.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("writes the DB row from the file when the file is newer", async () => {
    const fileText = "file v2";
    const dbText = "db v1 (stale)";
    const recent = new Date("2026-05-10T00:00:00Z");
    const stale = "2026-05-01T00:00:00Z";
    const file = await writeTempSoul(fileText, recent);
    queryMock
      .mockResolvedValueOnce({ rows: [{ content: dbText, updated_at: stale }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await reconcileSoulSource({ soulFilePath: file, query: queryMock, logAudit: auditMock });
    expect(result.status).toBe("file_won");
    expect(queryMock).toHaveBeenCalledTimes(2);
    const updateCall = queryMock.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE system_prompts/i);
    expect(updateCall[1][0]).toBe(fileText);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1].detail.winner).toBe("file");
  });

  it("logs a warning and writes audit when the DB is newer than the file", async () => {
    const fileText = "file v1 (stale)";
    const dbText = "db v2";
    const stale = new Date("2026-05-01T00:00:00Z");
    const recent = "2026-05-10T00:00:00Z";
    const file = await writeTempSoul(fileText, stale);
    queryMock.mockResolvedValueOnce({
      rows: [{ content: dbText, updated_at: recent }],
      rowCount: 1,
    });

    const result = await reconcileSoulSource({ soulFilePath: file, query: queryMock, logAudit: auditMock });
    expect(result.status).toBe("db_won");
    // SELECT only — no UPDATE, since we refuse to write the repo file.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1].detail.winner).toBe("db");
    expect(auditMock.mock.calls[0][1].detail.action).toBe("manual_sync_required");
  });

  it("seeds the DB row when no system_prompts entry exists yet", async () => {
    const fileText = "fresh SOUL";
    const file = await writeTempSoul(fileText);
    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT — empty
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT

    const result = await reconcileSoulSource({ soulFilePath: file, query: queryMock, logAudit: auditMock });
    expect(result.status).toBe("file_won");
    expect(queryMock.mock.calls[1][0]).toMatch(/INSERT INTO system_prompts/i);
    expect(queryMock.mock.calls[1][1][2]).toBe(fileText);
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it("returns skipped (and does not throw) when the SOUL file is missing", async () => {
    const result = await reconcileSoulSource({
      soulFilePath: "/nonexistent/path/SOUL.md",
      query: queryMock,
      logAudit: auditMock,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/unreadable/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns skipped when the DB query throws", async () => {
    const file = await writeTempSoul("anything");
    queryMock.mockRejectedValueOnce(new Error("connection refused"));
    const result = await reconcileSoulSource({ soulFilePath: file, query: queryMock, logAudit: auditMock });
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/system_prompts query failed/);
  });
});
