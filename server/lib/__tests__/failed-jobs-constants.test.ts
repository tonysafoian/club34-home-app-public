import { describe, it, expect } from "vitest";
import { FAILED_JOBS_MAX_ATTEMPTS, FAILED_JOBS_BACKOFF_MINUTES } from "../failed-jobs-constants.js";
import { failedJobs } from "../../../shared/schema.js";

/**
 * Regression guard for the failed_jobs.max_attempts mismatch.
 *
 * Before migration 0011 the schema column defaulted to 3 while the
 * retry worker hardcoded MAX_ATTEMPTS=5, so any row created via the
 * column's default was prematurely dead. The constant and the Drizzle
 * column default must stay in lockstep — if you change one without the
 * other this test fails on the next CI run.
 */
describe("failed_jobs constants alignment", () => {
  it("FAILED_JOBS_MAX_ATTEMPTS equals the Drizzle schema column default", () => {
    // `default` on a Drizzle column lives on the column builder; expose it
    // for the assertion. The shape is stable across drizzle-orm versions
    // we currently use (^0.45). If this access pattern ever breaks, the
    // assertion is still meaningful as long as it runs.
    const col = failedJobs.maxAttempts as unknown as { default: number };
    expect(col.default).toBe(FAILED_JOBS_MAX_ATTEMPTS);
  });

  it("FAILED_JOBS_BACKOFF_MINUTES has one entry per attempt up to the cap", () => {
    expect(FAILED_JOBS_BACKOFF_MINUTES.length).toBe(FAILED_JOBS_MAX_ATTEMPTS);
    // Strictly non-decreasing — otherwise the worker's exponential
    // backoff intent is broken.
    for (let i = 1; i < FAILED_JOBS_BACKOFF_MINUTES.length; i++) {
      expect(FAILED_JOBS_BACKOFF_MINUTES[i]).toBeGreaterThanOrEqual(
        FAILED_JOBS_BACKOFF_MINUTES[i - 1],
      );
    }
  });

  it("the constant value itself is 5 — guard against silent regression", () => {
    // Hard-coded sanity check so any future "let's bump retries to 3"
    // PR has to update this test deliberately.
    expect(FAILED_JOBS_MAX_ATTEMPTS).toBe(5);
  });
});
