import { Router } from "express";
import { requireAuth, requireRole } from "../auth";
import { storage } from "../storage";
import {
  insertSystemUpdateSchema,
  insertPoiProfileSchema,
  insertPoiSightingSchema,
  insertNotionWebhookEventSchema,
  insertNotionSyncConfigSchema,
} from "../../shared/schema";
import { emitToAll } from "../socket";

const router = Router();

router.get("/api/system-updates", requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const updates = await storage.getSystemUpdates(limit);
    res.json(updates);
  } catch (err) {
    next(err);
  }
});

router.post("/api/system-updates", requireRole("admin"), async (req, res, next) => {
  try {
    const parsed = insertSystemUpdateSchema.parse(req.body);
    const update = await storage.createSystemUpdate(parsed);

    emitToAll("system:update", {
      id: update.id,
      title: update.title,
      updateType: update.updateType,
    });

    res.status(201).json(update);
  } catch (err) {
    next(err);
  }
});

router.delete("/api/system-updates/:id", requireRole("admin"), async (req, res, next) => {
  try {
    await storage.deleteSystemUpdate(String(req.params.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get("/api/poi/profiles", requireAuth, async (req, res, next) => {
  try {
    const profiles = await storage.getPoiProfiles();
    res.json(profiles);
  } catch (err) {
    next(err);
  }
});

router.post("/api/poi/profiles", requireAuth, async (req, res, next) => {
  try {
    const parsed = insertPoiProfileSchema.parse(req.body);
    const profile = await storage.createPoiProfile(parsed);

    emitToAll("verkada:profile-update", { id: profile.id });

    res.status(201).json(profile);
  } catch (err) {
    next(err);
  }
});

router.patch("/api/poi/profiles/:id", requireAuth, async (req, res, next) => {
  try {
    const profile = await storage.updatePoiProfile(String(req.params.id), req.body);
    if (!profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    emitToAll("verkada:profile-update", { id: profile.id });

    res.json(profile);
  } catch (err) {
    next(err);
  }
});

router.delete("/api/poi/profiles/:id", requireAuth, async (req, res, next) => {
  try {
    await storage.deletePoiProfile(String(req.params.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post("/api/poi/sightings", requireAuth, async (req, res, next) => {
  try {
    const parsed = insertPoiSightingSchema.parse(req.body);
    const sighting = await storage.createPoiSighting(parsed);

    emitToAll("verkada:sighting", { id: sighting.id });

    res.status(201).json(sighting);
  } catch (err) {
    next(err);
  }
});

router.get("/api/poi/sightings/:verkadaPersonId", requireAuth, async (req, res, next) => {
  try {
    const sightings = await storage.getPoiSightings(String(req.params.verkadaPersonId));
    res.json(sightings);
  } catch (err) {
    next(err);
  }
});

router.post("/api/notion/webhook-events", requireAuth, async (req, res, next) => {
  try {
    const parsed = insertNotionWebhookEventSchema.parse(req.body);
    const event = await storage.createNotionWebhookEvent(parsed);

    emitToAll("notion:event", {
      id: event.id,
      eventType: event.eventType,
    });

    res.status(201).json(event);
  } catch (err) {
    next(err);
  }
});

router.get("/api/notion/sync-configs", requireAuth, async (req, res, next) => {
  try {
    const configs = await storage.getNotionSyncConfigs(req.user!.userId);
    res.json(configs);
  } catch (err) {
    next(err);
  }
});

router.post("/api/notion/sync-configs", requireAuth, async (req, res, next) => {
  try {
    const parsed = insertNotionSyncConfigSchema.parse(req.body);
    const config = await storage.createNotionSyncConfig(parsed);

    emitToAll("notion:sync-config", { id: config.id });

    res.status(201).json(config);
  } catch (err) {
    next(err);
  }
});

router.patch("/api/notion/sync-configs/:id", requireAuth, async (req, res, next) => {
  try {
    const config = await storage.updateNotionSyncConfig(String(req.params.id), req.body);
    if (!config) {
      res.status(404).json({ error: "Sync config not found" });
      return;
    }

    emitToAll("notion:sync-config", { id: config.id });

    res.json(config);
  } catch (err) {
    next(err);
  }
});

router.delete("/api/notion/sync-configs/:id", requireAuth, async (req, res, next) => {
  try {
    await storage.deleteNotionSyncConfig(String(req.params.id));

    emitToAll("notion:sync-config", { id: req.params.id });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
