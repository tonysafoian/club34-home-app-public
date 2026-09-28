/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import {
  correlationMiddleware,
  getCurrentCorrelationId,
  generateCorrelationId,
  runWithCorrelation,
  withCorrelation,
  getCorrelationId,
  CORRELATION_HEADER,
} from "../correlation.js";

function makeReq(headers: Record<string, string> = {}): any {
  return { headers, correlationId: undefined };
}

function makeRes(): any {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  };
}

describe("getCurrentCorrelationId / runWithCorrelation", () => {
  it("returns '' outside any context", () => {
    expect(getCurrentCorrelationId()).toBe("");
  });

  it("returns the id inside a runWithCorrelation block", async () => {
    await runWithCorrelation("abc-123", async () => {
      expect(getCurrentCorrelationId()).toBe("abc-123");
    });
  });

  it("nested calls inherit the outer id", async () => {
    await runWithCorrelation("outer", async () => {
      expect(getCurrentCorrelationId()).toBe("outer");
      // simulate any async deep helper
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      expect(getCurrentCorrelationId()).toBe("outer");
    });
  });

  it("sibling contexts do not leak into one another", async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithCorrelation("ctx-a", async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push("a=" + getCurrentCorrelationId());
      }),
      runWithCorrelation("ctx-b", async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push("b=" + getCurrentCorrelationId());
      }),
    ]);
    expect(seen.sort()).toEqual(["a=ctx-a", "b=ctx-b"]);
    // After both contexts exit we're back to ""
    expect(getCurrentCorrelationId()).toBe("");
  });

  it("withCorrelation returns the auto-generated id alongside the result", async () => {
    let observedInside = "";
    const { id, result } = await withCorrelation(async () => {
      observedInside = getCurrentCorrelationId();
      return 42;
    });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(20);
    expect(observedInside).toBe(id);
    expect(result).toBe(42);
  });
});

describe("generateCorrelationId", () => {
  it("returns a non-empty unique string each call", () => {
    const a = generateCorrelationId();
    const b = generateCorrelationId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });
});

describe("correlationMiddleware", () => {
  it("reuses the inbound X-Correlation-Id header when present", () => {
    const req = makeReq({ [CORRELATION_HEADER]: "supplied-by-caller" });
    const res = makeRes();
    const next = vi.fn(() => {
      expect(getCurrentCorrelationId()).toBe("supplied-by-caller");
    });
    correlationMiddleware(req, res, next as any);
    expect(req.correlationId).toBe("supplied-by-caller");
    expect(res.headers["X-Correlation-Id"]).toBe("supplied-by-caller");
    expect(next).toHaveBeenCalled();
  });

  it("generates a fresh id when no header is supplied and stamps it on req + res + ALS", () => {
    const req = makeReq({});
    const res = makeRes();
    let observed = "";
    const next = vi.fn(() => {
      observed = getCurrentCorrelationId();
    });
    correlationMiddleware(req, res, next as any);
    expect(req.correlationId).toBeTruthy();
    expect(res.headers["X-Correlation-Id"]).toBe(req.correlationId);
    expect(observed).toBe(req.correlationId);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("normalizes an array-shaped header value to the first entry", () => {
    const req = makeReq();
    req.headers[CORRELATION_HEADER] = ["first", "second"];
    const res = makeRes();
    correlationMiddleware(req, res, (() => {
      expect(getCurrentCorrelationId()).toBe("first");
    }) as any);
  });
});

describe("getCorrelationId (legacy req-based overload)", () => {
  it("prefers req.correlationId set by middleware", () => {
    const req: any = { headers: {}, correlationId: "from-middleware" };
    expect(getCorrelationId(req)).toBe("from-middleware");
  });

  it("falls back to the header when req.correlationId is unset", () => {
    const req: any = { headers: { [CORRELATION_HEADER]: "from-header" } };
    expect(getCorrelationId(req)).toBe("from-header");
  });

  it("generates one when neither is present", () => {
    const id = getCorrelationId({ headers: {} } as any);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(20);
  });
});
