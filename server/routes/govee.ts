import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../auth.js';
import { getAvClosetReading, isGoveeConfigured } from '../services/govee.js';

const router = Router();

// Corrected AV Closet temperature, read directly from the Govee Cloud API to
// bypass Home Assistant's double-conversion bug. Returns tempF/humidity or a
// null reading (with a reason) when Govee is unavailable — callers should show
// an offline/placeholder state rather than a stale value.
router.get('/av-closet', requireAuth, async (_req: Request, res: Response) => {
  try {
    const reading = await getAvClosetReading();
    if (reading) {
      res.json(reading);
      return;
    }
    res.json({
      tempF: null,
      humidity: null,
      online: null,
      source: 'govee',
      configured: isGoveeConfigured(),
      error: isGoveeConfigured()
        ? 'Govee API unavailable'
        : 'GOVEE_API_KEY not configured',
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Govee request failed';
    res.status(502).json({ error: message });
  }
});

export default router;
