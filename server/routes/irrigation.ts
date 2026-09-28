import { Router } from 'express';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { storage } from '../storage';
import { refreshZoneNames, ZONE_FLOW_CONFIG } from '../lib/irrigationFlow.js';

const router = Router();

function requireAdmin(req: AuthenticatedRequest, res: Response, next: () => void): void {
  if (req.userRole !== 'admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

// Stable zone svgId shape shared with the frontend: 'clock-<n>-valve-<n>'.
const SVG_ID_RE = /^clock-\d+-valve-\d+$/;
// Friendly names are short labels — guard against accidental essays.
const MAX_ZONE_NAME_LEN = 80;

// SVG viewBox bounds the label badges live in (900 x 706). Positions outside
// this range are almost certainly a client bug; clamp + reject NaN.
const VIEW_W = 900;
const VIEW_H = 706;

/** Read all saved zone-label position overrides (any authenticated user). */
router.get('/api/irrigation/label-positions', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const positions = await storage.getValveLabelPositions();
    res.json({ positions });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to fetch label positions', details: message });
  }
});

/** Upsert a single zone's label position (admin only). */
router.put('/api/irrigation/label-positions/:svgId', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const svgId = String(req.params.svgId);
    const { x, y } = req.body as { x?: unknown; y?: unknown };

    if (!svgId) {
      res.status(400).json({ error: 'svgId is required' });
      return;
    }

    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      res.status(400).json({ error: 'x and y must be finite numbers' });
      return;
    }

    const clampedX = Math.round(Math.min(Math.max(nx, 0), VIEW_W));
    const clampedY = Math.round(Math.min(Math.max(ny, 0), VIEW_H));

    const position = await storage.upsertValveLabelPosition({ svgId, x: clampedX, y: clampedY });
    res.json({ position });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to save label position', details: message });
  }
});

/** Reset a zone's label position back to the LABEL_CENTERS default (admin only). */
router.delete('/api/irrigation/label-positions/:svgId', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const svgId = String(req.params.svgId);
    if (!svgId) {
      res.status(400).json({ error: 'svgId is required' });
      return;
    }
    await storage.deleteValveLabelPosition(svgId);
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to reset label position', details: message });
  }
});

/* ─────────────────────────────────────────
   Zone name overrides — single source of truth for friendly zone names.
   Keyed by svgId; a missing row falls back to the hardcoded default in
   src/lib/irrigation/controllers.ts (frontend) and irrigationFlow.ts (server).
───────────────────────────────────────── */

/** Read all saved zone-name overrides (any authenticated user). */
router.get('/api/irrigation/zone-names', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const names = await storage.getIrrigationZoneNames();
    res.json({ names });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to fetch zone names', details: message });
  }
});

/** Upsert a single zone's friendly name (admin only). */
router.put('/api/irrigation/zone-names/:svgId', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const svgId = String(req.params.svgId);
    const { name } = req.body as { name?: unknown };

    if (!svgId || !SVG_ID_RE.test(svgId)) {
      res.status(400).json({ error: 'Invalid svgId' });
      return;
    }
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const trimmed = name.trim();
    if (trimmed.length > MAX_ZONE_NAME_LEN) {
      res.status(400).json({ error: `name must be ${MAX_ZONE_NAME_LEN} characters or fewer` });
      return;
    }

    const zoneName = await storage.upsertIrrigationZoneName({ svgId, name: trimmed });
    await refreshZoneNames(() => storage.getIrrigationZoneNames());
    res.json({ zoneName });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to save zone name', details: message });
  }
});

/** Reset a zone's name back to the hardcoded default (admin only). */
router.delete('/api/irrigation/zone-names/:svgId', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const svgId = String(req.params.svgId);
    if (!svgId) {
      res.status(400).json({ error: 'svgId is required' });
      return;
    }
    await storage.deleteIrrigationZoneName(svgId);
    await refreshZoneNames(() => storage.getIrrigationZoneNames());
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to reset zone name', details: message });
  }
});

/* ─────────────────────────────────────────
   Zone flow config — per-zone GPM used to estimate gallons from runtime.
   Values come from server/lib/irrigationFlow.ts (type-based defaults until
   field-calibrated). Read-only: the frontend uses this to compute
   gallons = GPM × runtime minutes for finished watering runs.
───────────────────────────────────────── */

/** Read the per-zone flow (GPM) config (any authenticated user). */
router.get('/api/irrigation/zone-flows', requireAuth, (_req: AuthenticatedRequest, res: Response) => {
  res.json({
    flows: ZONE_FLOW_CONFIG.map(z => ({
      svgId: z.svgId,
      entityId: z.entityId,
      gpm: z.gpm,
      headType: z.headType,
      isDefault: z.isDefault,
    })),
  });
});

export default router;
