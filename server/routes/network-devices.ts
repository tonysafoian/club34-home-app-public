import { Router } from "express";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import {
  getDevice,
  listDevices,
  labelDevice,
  unknownDevices,
  deleteDevice,
  inferVendorFromMac,
  type ListDevicesFilters,
  type LabelDeviceInput,
} from "../lib/network-devices.js";

const router = Router();

function requireAdmin(req: AuthenticatedRequest, res: Response, next: () => void): void {
  if (req.userRole !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

function handleError(res: Response, err: unknown, label: string): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[network-devices] ${label} failed:`, message);
  res.status(500).json({ error: message });
}

function parseBool(v: unknown): boolean | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.toLowerCase();
  if (t === "true" || t === "1") return true;
  if (t === "false" || t === "0") return false;
  return undefined;
}

// Special-cased BEFORE /:mac so the literal path doesn't get
// interpreted as a MAC by the param matcher.
router.get(
  "/api/network-devices/unknowns",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const windowHours = parseInt(String(req.query["window_hours"] ?? "24"), 10) || 24;
      const devices = await unknownDevices(windowHours);
      // Sprinkle inferred vendor onto the response — useful when the
      // row's device_vendor column hasn't backfilled yet and the admin
      // is staring at the triage list.
      const enriched = devices.map((d) => ({
        ...d,
        vendor_hint: d.device_vendor ?? inferVendorFromMac(d.mac_address) ?? null,
      }));
      res.json({ devices: enriched, count: enriched.length, window_hours: windowHours });
    } catch (err) {
      handleError(res, err, "unknowns");
    }
  },
);

router.get(
  "/api/network-devices",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const filters: ListDevicesFilters = {
        owner_role: typeof req.query["owner_role"] === "string" ? (req.query["owner_role"] as string) : undefined,
        trusted: parseBool(req.query["trusted"]),
        device_type: typeof req.query["device_type"] === "string" ? (req.query["device_type"] as string) : undefined,
        unlabeled_only: parseBool(req.query["unlabeled_only"]) === true,
        limit: parseInt(String(req.query["limit"] ?? ""), 10) || undefined,
        offset: parseInt(String(req.query["offset"] ?? ""), 10) || undefined,
      };
      const result = await listDevices(filters);
      res.json({ devices: result.devices, count: result.devices.length, total: result.total });
    } catch (err) {
      handleError(res, err, "list");
    }
  },
);

router.get(
  "/api/network-devices/:mac",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const device = await getDevice(String(req.params.mac));
      if (!device) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(device);
    } catch (err) {
      handleError(res, err, "get");
    }
  },
);

router.put(
  "/api/network-devices/:mac",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: LabelDeviceInput = {
        label: body.label === undefined ? undefined : body.label === null ? null : String(body.label),
        owner_person_id: body.owner_person_id === undefined ? undefined : body.owner_person_id === null ? null : String(body.owner_person_id),
        owner_role: body.owner_role === undefined ? undefined : body.owner_role === null ? null : String(body.owner_role),
        device_type: body.device_type === undefined ? undefined : body.device_type === null ? null : String(body.device_type),
        expected_ssid: body.expected_ssid === undefined ? undefined : body.expected_ssid === null ? null : String(body.expected_ssid),
        notes: body.notes === undefined ? undefined : body.notes === null ? null : String(body.notes),
        trusted: typeof body.trusted === "boolean" ? body.trusted : undefined,
        device_vendor: body.device_vendor === undefined ? undefined : body.device_vendor === null ? null : String(body.device_vendor),
        device_model: body.device_model === undefined ? undefined : body.device_model === null ? null : String(body.device_model),
      };
      const labeledBy = req.userId ?? "admin";
      const updated = await labelDevice(String(req.params.mac), patch, labeledBy);
      if (!updated) {
        res.status(400).json({ error: "invalid mac" });
        return;
      }
      res.json(updated);
    } catch (err) {
      handleError(res, err, "label");
    }
  },
);

router.delete(
  "/api/network-devices/:mac",
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const removed = await deleteDevice(String(req.params.mac));
      res.json({ ok: removed });
    } catch (err) {
      handleError(res, err, "delete");
    }
  },
);

export default router;
