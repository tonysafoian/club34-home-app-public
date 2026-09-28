import { Router, type Request, type Response } from "express";
import { executePerplexitySearch } from "../services/perplexity.js";
import { checkRateLimit } from "../lib/rate-limiter.js";
import { requireAuth } from "../auth.js";

const router = Router();

router.post("/search", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId || "anonymous";
    const { allowed, retryAfterMs } = checkRateLimit(userId, "perplexity", {
      maxRequests: 30,
      windowMs: 60_000,
    });
    if (!allowed) {
      return res.status(429).json({
        error: "Rate limit exceeded for Perplexity search",
        retryAfterMs,
      });
    }

    const { query, deep } = req.body;
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing required field: query" });
    }

    const result = await executePerplexitySearch(query, !!deep);
    try {
      const parsed = JSON.parse(result);
      if (parsed.error) {
        return res.status(502).json(parsed);
      }
      return res.json(parsed);
    } catch {
      if (result.startsWith("Error") || result.startsWith("Perplexity API")) {
        return res.status(502).json({ error: result });
      }
      return res.json({ answer: result, citations: [], model: "unknown" });
    }
  } catch (e) {
    console.error("Perplexity search route error:", e);
    return res.status(500).json({
      error: e instanceof Error ? e.message : "Unknown error",
    });
  }
});

export default router;
