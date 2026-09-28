/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  canRequest,
  recordSuccess,
  recordFailure,
  getCircuitState,
  configureCircuit,
  execute,
  isTransientError,
  getCircuitSnapshot,
  onStateTransition,
  CircuitOpenError,
  __resetForTests,
} from "../circuit-breaker.js";

beforeEach(() => {
  __resetForTests();
});

describe("low-level API", () => {
  it("starts closed and trips open after failureThreshold consecutive failures", () => {
    configureCircuit("svc-a", { failureThreshold: 3, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 });
    expect(getCircuitState("svc-a")).toBe("closed");
    recordFailure("svc-a");
    recordFailure("svc-a");
    expect(getCircuitState("svc-a")).toBe("closed");
    recordFailure("svc-a");
    expect(getCircuitState("svc-a")).toBe("open");
  });

  it("denies requests while open until resetTimeoutMs elapses", () => {
    configureCircuit("svc-b", { failureThreshold: 1, resetTimeoutMs: 10_000, halfOpenMaxAttempts: 1 });
    recordFailure("svc-b");
    expect(getCircuitState("svc-b")).toBe("open");
    expect(canRequest("svc-b").allowed).toBe(false);

    // Simulate time travel via vi fake timers.
    vi.useFakeTimers();
    vi.advanceTimersByTime(15_000);
    const r = canRequest("svc-b");
    expect(r.allowed).toBe(true);
    expect(r.state).toBe("half-open");
    vi.useRealTimers();
  });

  it("recovers to closed on success after failures", () => {
    configureCircuit("svc-c", { failureThreshold: 2, resetTimeoutMs: 1_000, halfOpenMaxAttempts: 1 });
    recordFailure("svc-c");
    recordSuccess("svc-c");
    expect(getCircuitState("svc-c")).toBe("closed");
  });

  it("re-opens immediately when a half-open probe fails", () => {
    configureCircuit("svc-d", { failureThreshold: 1, resetTimeoutMs: 5_000, halfOpenMaxAttempts: 2 });
    recordFailure("svc-d");
    vi.useFakeTimers();
    vi.advanceTimersByTime(6_000);
    expect(canRequest("svc-d").state).toBe("half-open");
    recordFailure("svc-d");
    expect(getCircuitState("svc-d")).toBe("open");
    vi.useRealTimers();
  });
});

describe("isTransientError", () => {
  it("returns false for 4xx errors", () => {
    expect(isTransientError({ status: 400 })).toBe(false);
    expect(isTransientError({ status: 401 })).toBe(false);
    expect(isTransientError({ status: 429 })).toBe(false);
    expect(isTransientError({ status: 499 })).toBe(false);
  });

  it("returns true for 5xx errors", () => {
    expect(isTransientError({ status: 500 })).toBe(true);
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ status: 504 })).toBe(true);
  });

  it("returns true for AbortError (timeout)", () => {
    const e = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isTransientError(e)).toBe(true);
  });

  it("returns true for common network error codes", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED"]) {
      expect(isTransientError({ code })).toBe(true);
    }
  });

  it("treats bare Errors as transient (fetch failed, etc.)", () => {
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
  });
});

describe("execute()", () => {
  it("returns the result on success and records success", async () => {
    configureCircuit("e1", { failureThreshold: 3, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 });
    const result = await execute("e1", async () => 42);
    expect(result).toBe(42);
    expect(getCircuitState("e1")).toBe("closed");
  });

  it("throws CircuitOpenError when the breaker is open and never invokes fn", async () => {
    configureCircuit("e2", { failureThreshold: 1, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 });
    recordFailure("e2");
    expect(getCircuitState("e2")).toBe("open");

    const fn = vi.fn();
    await expect(execute("e2", fn as any)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("counts a returned Response with status >= 500 as failure", async () => {
    configureCircuit("e3", { failureThreshold: 2, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 });
    await execute("e3", async () => ({ ok: false, status: 500 } as any));
    await execute("e3", async () => ({ ok: false, status: 503 } as any));
    expect(getCircuitState("e3")).toBe("open");
  });

  it("does NOT count a returned Response with status 4xx as failure", async () => {
    configureCircuit("e4", { failureThreshold: 2, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 });
    await execute("e4", async () => ({ ok: false, status: 401 } as any));
    await execute("e4", async () => ({ ok: false, status: 404 } as any));
    await execute("e4", async () => ({ ok: false, status: 429 } as any));
    expect(getCircuitState("e4")).toBe("closed");
  });

  it("does NOT count a thrown 4xx error as failure (re-throws without tripping)", async () => {
    configureCircuit("e5", { failureThreshold: 2, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 });
    await expect(execute("e5", async () => { throw { status: 401, message: "auth" }; })).rejects.toEqual({ status: 401, message: "auth" });
    await expect(execute("e5", async () => { throw { status: 403, message: "forbidden" }; })).rejects.toEqual({ status: 403, message: "forbidden" });
    expect(getCircuitState("e5")).toBe("closed");
  });

  it("DOES count a thrown 5xx / network error as failure", async () => {
    configureCircuit("e6", { failureThreshold: 2, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 });
    await expect(execute("e6", async () => { throw { status: 503 }; })).rejects.toBeTruthy();
    await expect(execute("e6", async () => { throw new Error("fetch failed"); })).rejects.toBeTruthy();
    expect(getCircuitState("e6")).toBe("open");
  });
});

describe("onStateTransition", () => {
  it("fires on closed → open and on open → half-open", () => {
    configureCircuit("t1", { failureThreshold: 1, resetTimeoutMs: 5_000, halfOpenMaxAttempts: 1 });
    const events: Array<{ from: string; to: string; reason: string }> = [];
    onStateTransition((t) => events.push({ from: t.from, to: t.to, reason: t.reason }));

    recordFailure("t1");
    expect(events.map((e) => `${e.from}→${e.to}`)).toEqual(["closed→open"]);

    vi.useFakeTimers();
    vi.advanceTimersByTime(6_000);
    canRequest("t1");
    expect(events.map((e) => `${e.from}→${e.to}`)).toEqual(["closed→open", "open→half-open"]);
    vi.useRealTimers();
  });

  it("does NOT fire on repeated blocked calls while open", () => {
    configureCircuit("t2", { failureThreshold: 1, resetTimeoutMs: 60_000, halfOpenMaxAttempts: 1 });
    const events: any[] = [];
    onStateTransition((t) => events.push(t));
    recordFailure("t2");
    canRequest("t2");
    canRequest("t2");
    canRequest("t2");
    // One transition row, not four.
    expect(events.length).toBe(1);
  });
});

describe("getCircuitSnapshot", () => {
  it("returns shape with name, state, failures, config, and timestamps", () => {
    configureCircuit("snap-1", { failureThreshold: 4, resetTimeoutMs: 12_345, halfOpenMaxAttempts: 2 });
    recordSuccess("snap-1");
    const snap = getCircuitSnapshot("snap-1");
    expect(snap.name).toBe("snap-1");
    expect(snap.state).toBe("closed");
    expect(snap.config.failureThreshold).toBe(4);
    expect(snap.lastSuccess).toBeGreaterThan(0);
  });

  it("listing returns every registered breaker", () => {
    configureCircuit("a", { failureThreshold: 1, resetTimeoutMs: 1, halfOpenMaxAttempts: 1 });
    configureCircuit("b", { failureThreshold: 1, resetTimeoutMs: 1, halfOpenMaxAttempts: 1 });
    recordSuccess("a");
    recordSuccess("b");
    const all = getCircuitSnapshot();
    const names = all.map((s) => s.name).sort();
    expect(names).toEqual(["a", "b"]);
  });
});
