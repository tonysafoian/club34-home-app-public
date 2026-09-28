import { describe, it, expect, beforeEach, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db.js", () => ({ query: queryMock }));

const { extractUsageFromBody, extractUsageFromStream, recordLlmUsage, STREAM_USAGE_OPTION } = await import("../llm-usage.js");
const { runWithCorrelation } = await import("../correlation.js");

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe("extractUsageFromBody", () => {
  it("returns the usage object when present on a non-streaming body", () => {
    const u = extractUsageFromBody({ usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46, cost: 0.0001 } });
    expect(u).toEqual({ prompt_tokens: 12, completion_tokens: 34, total_tokens: 46, cost: 0.0001 });
  });

  it("returns null when usage is missing", () => {
    expect(extractUsageFromBody({})).toBeNull();
    expect(extractUsageFromBody({ choices: [] })).toBeNull();
    expect(extractUsageFromBody(null)).toBeNull();
    expect(extractUsageFromBody("not an object")).toBeNull();
  });
});

describe("extractUsageFromStream", () => {
  it("returns the usage from the final SSE chunk that carries one", () => {
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.0023 } })}`,
      "data: [DONE]",
    ];
    const u = extractUsageFromStream(lines);
    expect(u).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.0023 });
  });

  it("returns null when the stream never emitted a usage block", () => {
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`,
      "data: [DONE]",
    ];
    expect(extractUsageFromStream(lines)).toBeNull();
  });

  it("returns the latest usage when multiple chunks carry one (final chunk wins)", () => {
    const lines = [
      `data: ${JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
      `data: ${JSON.stringify({ usage: { prompt_tokens: 99, completion_tokens: 99, total_tokens: 198 } })}`,
    ];
    expect(extractUsageFromStream(lines)?.total_tokens).toBe(198);
  });

  it("tolerates malformed JSON chunks without throwing", () => {
    const lines = [
      "data: not json",
      `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}`,
      "data: [DONE]",
    ];
    expect(extractUsageFromStream(lines)?.total_tokens).toBe(8);
  });

  it("ignores non-data SSE lines (comments, blank lines)", () => {
    const lines = [
      ": status:retrying",
      "",
      `data: ${JSON.stringify({ usage: { total_tokens: 42 } })}`,
    ];
    expect(extractUsageFromStream(lines)?.total_tokens).toBe(42);
  });
});

describe("recordLlmUsage", () => {
  it("writes one INSERT into janus_llm_usage with the supplied meta + usage fields", async () => {
    const ok = await recordLlmUsage(
      {
        userId: "tony",
        channel: "chat",
        model: "google/gemini-3-flash-preview",
        tier: "default",
        durationMs: 1234,
        requestType: "chat",
      },
      { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600, cost: 0.0123 },
    );
    expect(ok).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, values] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO janus_llm_usage/);
    // Positional params: user_id, channel, model, tier, prompt, completion, total, cost, correlation, duration, request_type
    expect(values).toEqual([
      "tony", "chat", "google/gemini-3-flash-preview", "default",
      500, 100, 600, 0.0123,
      null, 1234, "chat",
    ]);
  });

  it("stores NULL when cost is missing", async () => {
    await recordLlmUsage(
      { userId: "tony", channel: "chat", model: "m", tier: "default", requestType: "chat" },
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    );
    const [, values] = queryMock.mock.calls[0];
    // cost is the 8th positional param (index 7)
    expect(values[7]).toBeNull();
  });

  it("auto-stamps correlation_id from the ALS context", async () => {
    await runWithCorrelation("trace-xyz", async () => {
      await recordLlmUsage(
        { userId: "tony", channel: "chat", model: "m", requestType: "chat" },
        { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      );
    });
    const [, values] = queryMock.mock.calls[0];
    expect(values[8]).toBe("trace-xyz"); // correlation_id is the 9th positional param
  });

  it("uses an explicit correlationId when the caller passes one", async () => {
    await runWithCorrelation("ambient-trace", async () => {
      await recordLlmUsage(
        { userId: "tony", channel: "chat", model: "m", requestType: "chat", correlationId: "explicit-trace" },
        { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      );
    });
    const [, values] = queryMock.mock.calls[0];
    expect(values[8]).toBe("explicit-trace");
  });

  it("returns false and does not throw when usage is null", async () => {
    const ok = await recordLlmUsage({ model: "m" }, null);
    expect(ok).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns false on a DB failure without throwing", async () => {
    queryMock.mockRejectedValueOnce(new Error("connection refused"));
    const ok = await recordLlmUsage(
      { userId: "tony", channel: "chat", model: "m", requestType: "chat" },
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    );
    expect(ok).toBe(false);
  });
});

describe("STREAM_USAGE_OPTION", () => {
  it("is the OpenRouter stream_options.include_usage = true shape", () => {
    expect(STREAM_USAGE_OPTION).toEqual({ stream_options: { include_usage: true } });
  });
});
