import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  classifyComplexity,
  applyMonotonicUpgrade,
  pickModel,
  type ComplexityDecision,
} from "../complexity-router.js";

describe("classifyComplexity — simple tier", () => {
  it("'turn on the gym lights' → simple", () => {
    const d = classifyComplexity({ userMessage: "turn on the gym lights", toolCallsSoFar: 0 });
    expect(d.tier).toBe("simple");
  });

  it("'lock the front door' → simple", () => {
    expect(
      classifyComplexity({ userMessage: "lock the front door" }).tier,
    ).toBe("simple");
  });

  it("'who's home' (no question mark) → simple", () => {
    expect(classifyComplexity({ userMessage: "who's home" }).tier).toBe("simple");
  });

  it("a 79-char prompt with no triggers → simple", () => {
    const msg = "a".repeat(79); // exactly under the 80 floor
    expect(classifyComplexity({ userMessage: msg }).tier).toBe("simple");
  });
});

describe("classifyComplexity — default tier", () => {
  it("'what's on my calendar today' has a triggering keyword but ends in a question — falls through to default", () => {
    // The "schedule" keyword is not present; question mark prevents simple.
    expect(
      classifyComplexity({ userMessage: "what's on my calendar today?" }).tier,
    ).toBe("default");
  });

  it("a 200-char prompt is too long for simple, not long enough for complex → default", () => {
    const msg = "x".repeat(200);
    expect(classifyComplexity({ userMessage: msg }).tier).toBe("default");
  });

  it("'find me a restaurant in Beverly Hills for tonight' → default (has negative simple keyword 'find me')", () => {
    expect(
      classifyComplexity({
        userMessage: "find me a restaurant in Beverly Hills for tonight",
      }).tier,
    ).toBe("default");
  });
});

describe("classifyComplexity — complex tier", () => {
  it("'research the best HVAC service in Beverly Hills and email me a comparison' → complex", () => {
    const d = classifyComplexity({
      userMessage:
        "research the best HVAC service in Beverly Hills and email me a comparison",
    });
    expect(d.tier).toBe("complex");
    expect(d.reason).toMatch(/complex_keyword/);
  });

  it("a 401-char prompt → complex by length alone", () => {
    const msg = "a".repeat(401);
    const d = classifyComplexity({ userMessage: msg });
    expect(d.tier).toBe("complex");
    expect(d.reason).toMatch(/message_length=401/);
  });

  it("URL + 'summarize' verb → complex", () => {
    const d = classifyComplexity({
      userMessage: "summarize this https://example.com/whitepaper",
    });
    expect(d.tier).toBe("complex");
    expect(d.reason).toBe("url+research_verb");
  });

  it("URL + 'analyze' verb → complex", () => {
    const d = classifyComplexity({
      userMessage: "analyze https://docs.com/spec",
    });
    expect(d.tier).toBe("complex");
  });

  it("4 tool calls so far → complex regardless of message", () => {
    const d = classifyComplexity({
      userMessage: "ok",
      toolCallsSoFar: 4,
    });
    expect(d.tier).toBe("complex");
    expect(d.reason).toBe("tool_calls_so_far=4 ≥ 3");
  });

  it("'deep-dive into our pool maintenance history' → complex", () => {
    const d = classifyComplexity({
      userMessage: "deep-dive into our pool maintenance history",
    });
    expect(d.tier).toBe("complex");
  });
});

describe("classifyComplexity — borderline / negatives", () => {
  it("a 79-char prompt becomes default once it contains a question mark", () => {
    const msg = "what time is it?";
    expect(classifyComplexity({ userMessage: msg }).tier).toBe("default");
  });

  it("a short prompt with prior tool calls in history is NOT simple", () => {
    const d = classifyComplexity({
      userMessage: "ok",
      history: [
        { role: "assistant", tool_calls: [{}, {}] },
        { role: "tool" },
      ],
    });
    expect(d.tier).toBe("default"); // not "simple"
  });

  it("simple-negative keywords like 'plan' or 'draft' route short messages to default not simple", () => {
    expect(classifyComplexity({ userMessage: "draft a note" }).tier).toBe("default");
    expect(classifyComplexity({ userMessage: "plan dinner" }).tier).toBe("complex"); // 'plan' is also a complex_keyword
    expect(classifyComplexity({ userMessage: "schedule the dentist" }).tier).toBe("default");
  });

  it("trims whitespace before length checks", () => {
    expect(
      classifyComplexity({ userMessage: "  turn on the lights  " }).tier,
    ).toBe("simple");
  });

  it("empty / blank input falls through to default (no PII to a tier)", () => {
    expect(classifyComplexity({ userMessage: "" }).tier).toBe("default");
    expect(classifyComplexity({ userMessage: "   " }).tier).toBe("default");
  });
});

describe("applyMonotonicUpgrade", () => {
  function decide(tier: ComplexityDecision["tier"], reason = ""): ComplexityDecision {
    return { tier, reason: reason || tier };
  }

  it("upgrades simple → default", () => {
    expect(applyMonotonicUpgrade(decide("simple"), decide("default", "x")).tier).toBe("default");
  });

  it("upgrades default → complex", () => {
    expect(applyMonotonicUpgrade(decide("default"), decide("complex", "x")).tier).toBe("complex");
  });

  it("never downgrades complex → default", () => {
    const cur = decide("complex", "stuck-high");
    const next = decide("default", "new-call-is-default");
    const out = applyMonotonicUpgrade(cur, next);
    expect(out.tier).toBe("complex");
    expect(out.reason).toBe("stuck-high"); // reason is preserved on no-op
  });

  it("never downgrades default → simple", () => {
    const out = applyMonotonicUpgrade(decide("default", "first"), decide("simple", "later"));
    expect(out.tier).toBe("default");
    expect(out.reason).toBe("first");
  });

  it("no-op when tier rank is equal", () => {
    const out = applyMonotonicUpgrade(decide("default", "A"), decide("default", "B"));
    expect(out.tier).toBe("default");
    expect(out.reason).toBe("A");
  });
});

describe("monotonic upgrade via classifyComplexity sequence", () => {
  it("classify(simple) followed by classify(toolCallsSoFar=4) upgrades to complex", () => {
    let cur = classifyComplexity({ userMessage: "ok", toolCallsSoFar: 0 });
    expect(cur.tier).toBe("simple");
    cur = applyMonotonicUpgrade(
      cur,
      classifyComplexity({ userMessage: "ok", toolCallsSoFar: 4 }),
    );
    expect(cur.tier).toBe("complex");
  });

  it("once complex, stays complex across subsequent rounds even if the next decision is lower", () => {
    let cur = classifyComplexity({
      userMessage: "research the best HVAC vendor",
    });
    expect(cur.tier).toBe("complex");

    // Simulate a follow-up tool round where the model is now chatting
    // about the result. The classifier on its own might pick default; we
    // must keep complex.
    const followUp = classifyComplexity({
      userMessage: "ok",
      toolCallsSoFar: 0,
    });
    cur = applyMonotonicUpgrade(cur, followUp);
    expect(cur.tier).toBe("complex");
  });
});

describe("pickModel", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    delete process.env.JANUS_MODEL_SIMPLE;
    delete process.env.JANUS_MODEL_DEFAULT;
    delete process.env.JANUS_MODEL_COMPLEX;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns the env-configured model when set", () => {
    process.env.JANUS_MODEL_SIMPLE = "test/simple";
    process.env.JANUS_MODEL_DEFAULT = "test/default";
    process.env.JANUS_MODEL_COMPLEX = "test/complex";
    expect(pickModel("simple")).toBe("test/simple");
    expect(pickModel("default")).toBe("test/default");
    expect(pickModel("complex")).toBe("test/complex");
  });

  it("falls back to the documented defaults when env is unset", () => {
    expect(pickModel("simple")).toBe("google/gemini-2.5-flash-lite");
    expect(pickModel("default")).toBe("google/gemini-3-flash-preview");
    expect(pickModel("complex")).toBe("google/gemini-2.5-pro");
  });
});
