/**
 * Person↔device mapping store.
 *
 * Wraps the network_devices table (migrations/0016) with three layers of
 * functionality:
 *
 *   1. upsertObservedDevice() — called by FortiGate + Ruckus ingestion
 *      hooks. Best-effort, non-blocking. Updates last_seen and accumulates
 *      observed hostnames / IPs / SSIDs without exploding into duplicates.
 *   2. label / trust / list / unknownDevices — admin CRUD surface.
 *   3. inferVendorFromMac() — pure function. Tiny static OUI map covering
 *      the ~30 vendors that account for almost every device on the LAN.
 *
 * Everything here uses the raw `query()` helper from lib/db.ts so a
 * temporary DB outage or a missing table surfaces as a thrown error
 * the caller can swallow (ingestion is fire-and-forget; admin endpoints
 * surface the error as 500).
 */

import { query } from "./db.js";

// --- Types ---------------------------------------------------------------

export interface NetworkDeviceRow {
  mac_address: string;
  label: string | null;
  owner_person_id: string | null;
  owner_role: string | null;
  device_type: string | null;
  device_vendor: string | null;
  device_model: string | null;
  hostnames: string[] | null;
  ip_addresses: string[] | null;
  ssids: string[] | null;
  expected_ssid: string | null;
  trusted: boolean;
  notes: string | null;
  first_seen: string;
  last_seen: string;
  last_labeled_by: string | null;
  last_labeled_at: string | null;
}

export interface ObservedDeviceInput {
  mac: string;
  ip?: string | null;
  hostname?: string | null;
  ssid?: string | null;
  vendor_oui_hint?: string | null;
}

export interface ListDevicesFilters {
  owner_role?: string;
  trusted?: boolean;
  device_type?: string;
  unlabeled_only?: boolean;
  limit?: number;
  offset?: number;
}

export interface LabelDeviceInput {
  label?: string | null;
  owner_person_id?: string | null;
  owner_role?: string | null;
  device_type?: string | null;
  expected_ssid?: string | null;
  notes?: string | null;
  trusted?: boolean | null;
  device_vendor?: string | null;
  device_model?: string | null;
}

// --- OUI lookup ----------------------------------------------------------
//
// Static map of the most common 24-bit OUI prefixes seen on Tony's LAN.
// Real-world: each vendor owns hundreds of OUIs, so this is a tiny
// subset — but it covers the gear actually on the network. Unknown
// MAC → null and we leave vendor inference to a future improvement.

const OUI_VENDORS: Record<string, string> = {
  // Apple — represents a huge chunk of household devices (phones, Macs,
  // iPads, AppleTV, HomePod). Apple owns hundreds of prefixes; these
  // are the common ones.
  "00:1c:b3": "Apple",
  "00:1e:c2": "Apple",
  "00:23:32": "Apple",
  "00:25:00": "Apple",
  "00:26:08": "Apple",
  "3c:22:fb": "Apple",
  "4c:b1:cd": "Apple",
  "a8:51:5b": "Apple",
  "f0:18:98": "Apple",
  // Amazon — Echo, Fire TV, Kindle.
  "00:9b:08": "Amazon",
  "44:65:0d": "Amazon",
  "fc:65:de": "Amazon",
  // Google — Nest, Chromecast, Pixel.
  "00:1a:11": "Google",
  "f4:f5:e8": "Google",
  "f4:f5:d8": "Google",
  // Samsung — phones, TVs, appliances.
  "00:12:fb": "Samsung",
  "00:24:54": "Samsung",
  "78:bd:bc": "Samsung",
  // Microsoft — Surface, Xbox.
  "00:15:5d": "Microsoft",
  "7c:1e:52": "Microsoft",
  // Govee — smart lighting.
  "a4:c1:38": "Govee",
  "d4:a6:51": "Govee",
  // Hue / Philips / Signify.
  "00:17:88": "Philips Hue",
  "ec:b5:fa": "Philips Hue",
  // Ecobee.
  "44:61:32": "Ecobee",
  // Sonos.
  "00:0e:58": "Sonos",
  "78:28:ca": "Sonos",
  // HP — printers, laptops.
  "00:1b:78": "HP",
  "70:5a:0f": "HP",
  // Brother — printers.
  "f4:28:9d": "Brother",
  // Roku.
  "ac:3a:7a": "Roku",
  // Nest / Google Wifi.
  "18:b4:30": "Nest",
  // Ring.
  "b0:09:da": "Ring",
  // LG — TVs, appliances.
  "00:1c:62": "LG",
  // Dell.
  "00:14:22": "Dell",
  // Lenovo.
  "00:21:cc": "Lenovo",
  // Intel.
  "00:1b:21": "Intel",
};

/**
 * Pure: return the canonical vendor name for the first 24 bits of a
 * MAC address, or null if unknown. Case-insensitive; accepts both
 * colon and dash separators.
 */
export function inferVendorFromMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const normalized = mac.toLowerCase().replace(/-/g, ":");
  // Need at least the first 3 octets (8 chars: aa:bb:cc).
  if (normalized.length < 8) return null;
  const prefix = normalized.slice(0, 8);
  return OUI_VENDORS[prefix] ?? null;
}

// --- Helpers -------------------------------------------------------------

export function normalizeMac(mac: string): string {
  return mac.toLowerCase().replace(/-/g, ":").trim();
}

function dedupeAppend(existing: string[] | null | undefined, value: string | null | undefined): string[] | null {
  if (!value) return existing ?? null;
  const trimmed = value.trim();
  if (!trimmed) return existing ?? null;
  const base = Array.isArray(existing) ? existing : [];
  if (base.includes(trimmed)) return base;
  // Cap accumulated lists at 20 entries so a device that keeps DHCP-
  // bouncing through new IPs doesn't bloat the row indefinitely.
  return [trimmed, ...base].slice(0, 20);
}

function rowToDevice(row: Record<string, unknown>): NetworkDeviceRow {
  return {
    mac_address: String(row.mac_address ?? ""),
    label: row.label == null ? null : String(row.label),
    owner_person_id: row.owner_person_id == null ? null : String(row.owner_person_id),
    owner_role: row.owner_role == null ? null : String(row.owner_role),
    device_type: row.device_type == null ? null : String(row.device_type),
    device_vendor: row.device_vendor == null ? null : String(row.device_vendor),
    device_model: row.device_model == null ? null : String(row.device_model),
    hostnames: Array.isArray(row.hostnames) ? (row.hostnames as string[]) : null,
    ip_addresses: Array.isArray(row.ip_addresses) ? (row.ip_addresses as string[]) : null,
    ssids: Array.isArray(row.ssids) ? (row.ssids as string[]) : null,
    expected_ssid: row.expected_ssid == null ? null : String(row.expected_ssid),
    trusted: row.trusted === true,
    notes: row.notes == null ? null : String(row.notes),
    first_seen: row.first_seen instanceof Date ? row.first_seen.toISOString() : String(row.first_seen ?? ""),
    last_seen: row.last_seen instanceof Date ? row.last_seen.toISOString() : String(row.last_seen ?? ""),
    last_labeled_by: row.last_labeled_by == null ? null : String(row.last_labeled_by),
    last_labeled_at: row.last_labeled_at instanceof Date ? row.last_labeled_at.toISOString() : row.last_labeled_at == null ? null : String(row.last_labeled_at),
  };
}

// --- Ingest --------------------------------------------------------------

/**
 * Insert or update a row for an observed device. last_seen is bumped
 * to now(); hostnames/IPs/SSIDs accumulate (deduped, capped at 20).
 * device_vendor is filled from the OUI map on first observation only
 * — admin labeling can overwrite it later.
 */
export async function upsertObservedDevice(input: ObservedDeviceInput): Promise<void> {
  const mac = normalizeMac(input.mac);
  if (!mac) return;
  const vendor = inferVendorFromMac(mac);

  // We do the dedupe-and-append in SQL with COALESCE + jsonb_build_array,
  // but the simplest, most robust path is read-modify-write in two
  // statements. Ingestion is non-blocking so the extra round-trip is
  // acceptable; the alternative (CTE with jsonb ops) duplicates the
  // dedupe logic in two languages.
  const existing = await query(
    `SELECT hostnames, ip_addresses, ssids FROM network_devices WHERE mac_address = $1`,
    [mac],
  );
  const cur = existing.rows[0] ?? {};
  const nextHostnames = dedupeAppend(Array.isArray(cur.hostnames) ? (cur.hostnames as string[]) : null, input.hostname);
  const nextIps = dedupeAppend(Array.isArray(cur.ip_addresses) ? (cur.ip_addresses as string[]) : null, input.ip);
  const nextSsids = dedupeAppend(Array.isArray(cur.ssids) ? (cur.ssids as string[]) : null, input.ssid);

  await query(
    `INSERT INTO network_devices (
       mac_address, device_vendor, hostnames, ip_addresses, ssids,
       first_seen, last_seen
     ) VALUES (
       $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, now(), now()
     )
     ON CONFLICT (mac_address) DO UPDATE SET
       hostnames    = EXCLUDED.hostnames,
       ip_addresses = EXCLUDED.ip_addresses,
       ssids        = EXCLUDED.ssids,
       device_vendor = COALESCE(network_devices.device_vendor, EXCLUDED.device_vendor),
       last_seen    = now()`,
    [
      mac,
      vendor,
      nextHostnames === null ? null : JSON.stringify(nextHostnames),
      nextIps === null ? null : JSON.stringify(nextIps),
      nextSsids === null ? null : JSON.stringify(nextSsids),
    ],
  );
}

/**
 * Fire-and-forget wrapper around upsertObservedDevice. Use this in
 * data-fetch hooks so a slow DB or missing table never blocks (or
 * breaks) the user-facing FortiGate / Ruckus response.
 */
export function recordObservedDevice(input: ObservedDeviceInput): void {
  upsertObservedDevice(input).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    // One warn per failure is enough — these are best-effort and noisy.
    console.warn(`[network-devices] upsert failed for ${input.mac}: ${message}`);
  });
}

// --- Read ----------------------------------------------------------------

export async function getDevice(mac: string): Promise<NetworkDeviceRow | null> {
  const normalized = normalizeMac(mac);
  if (!normalized) return null;
  const res = await query(`SELECT * FROM network_devices WHERE mac_address = $1`, [normalized]);
  if (res.rows.length === 0) return null;
  return rowToDevice(res.rows[0] as Record<string, unknown>);
}

export interface DeviceByIp {
  mac: string;
  label: string | null;
  hostname: string | null;
}

/**
 * Resolve a batch of IPs to their network_devices identity in a single
 * query. Returns a Map keyed by the exact IP string passed in. For each
 * IP we surface the admin-assigned label (most authoritative friendly
 * name), the most-recently observed hostname, and the MAC. When more
 * than one device has historically held the same IP (DHCP reuse), the
 * most-recently-seen device wins.
 *
 * Used to enrich FortiGate top-talker rows with friendly device names
 * without standing up a new endpoint. Best-effort: callers should treat
 * a thrown error (table missing, DB blip) as "no enrichment".
 */
export async function getDevicesByIps(ips: string[]): Promise<Map<string, DeviceByIp>> {
  const out = new Map<string, DeviceByIp>();
  const unique = Array.from(new Set(ips.filter((ip): ip is string => typeof ip === "string" && ip.trim().length > 0)));
  if (unique.length === 0) return out;

  const res = await query(
    `SELECT mac_address, label, hostnames, ip_addresses, last_seen
       FROM network_devices
      WHERE ip_addresses ?| $1::text[]
      ORDER BY last_seen DESC`,
    [unique],
  );

  for (const raw of res.rows as Record<string, unknown>[]) {
    const ipArr = Array.isArray(raw.ip_addresses) ? (raw.ip_addresses as string[]) : [];
    const hostnames = Array.isArray(raw.hostnames) ? (raw.hostnames as string[]) : [];
    const entry: DeviceByIp = {
      mac: String(raw.mac_address ?? ""),
      label: raw.label == null ? null : String(raw.label),
      hostname: hostnames.length > 0 ? String(hostnames[0]) : null,
    };
    for (const ip of ipArr) {
      // Most-recent device wins (rows are ordered last_seen DESC).
      if (unique.includes(ip) && !out.has(ip)) out.set(ip, entry);
    }
  }
  return out;
}

export interface ListDevicesResult {
  devices: NetworkDeviceRow[];
  total: number;
}

export async function listDevices(filters: ListDevicesFilters = {}): Promise<ListDevicesResult> {
  const wheres: string[] = [];
  const params: unknown[] = [];
  if (filters.owner_role) {
    params.push(filters.owner_role);
    wheres.push(`owner_role = $${params.length}`);
  }
  if (typeof filters.trusted === "boolean") {
    params.push(filters.trusted);
    wheres.push(`trusted = $${params.length}`);
  }
  if (filters.device_type) {
    params.push(filters.device_type);
    wheres.push(`device_type = $${params.length}`);
  }
  if (filters.unlabeled_only) {
    wheres.push(`label IS NULL AND owner_person_id IS NULL AND trusted = false`);
  }
  const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(500, filters.limit ?? 200));
  const offset = Math.max(0, filters.offset ?? 0);

  const totalRes = await query(`SELECT COUNT(*)::int AS c FROM network_devices ${where}`, params);
  const total = Number((totalRes.rows[0] as Record<string, unknown> | undefined)?.c ?? 0);

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const res = await query(
    `SELECT * FROM network_devices ${where}
     ORDER BY last_seen DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return {
    devices: res.rows.map((r: unknown) => rowToDevice(r as Record<string, unknown>)),
    total,
  };
}

/**
 * Devices observed within the last `window_hours` that have no label,
 * no owner_person_id, and are not trusted. The triage list the admin /
 * Janus walks to assign identities.
 */
export async function unknownDevices(window_hours = 24): Promise<NetworkDeviceRow[]> {
  const hours = Math.max(1, Math.min(24 * 30, Math.floor(window_hours)));
  const res = await query(
    `SELECT * FROM network_devices
     WHERE label IS NULL AND owner_person_id IS NULL AND trusted = false
       AND last_seen >= now() - ($1 || ' hours')::interval
     ORDER BY last_seen DESC
     LIMIT 200`,
    [String(hours)],
  );
  return res.rows.map((r: unknown) => rowToDevice(r as Record<string, unknown>));
}

// --- Write ---------------------------------------------------------------

/**
 * Label / update a device. Any field passed as undefined is left alone;
 * passing null clears the field. `labeled_by` is stamped onto
 * last_labeled_by + last_labeled_at and is required.
 */
export async function labelDevice(
  mac: string,
  patch: LabelDeviceInput,
  labeled_by: string,
): Promise<NetworkDeviceRow | null> {
  const normalized = normalizeMac(mac);
  if (!normalized) return null;

  // Insert if missing so admin can label a device that hasn't been
  // observed yet (e.g. typing in a new MAC).
  await query(
    `INSERT INTO network_devices (mac_address, first_seen, last_seen)
     VALUES ($1, now(), now())
     ON CONFLICT (mac_address) DO NOTHING`,
    [normalized],
  );

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.label !== undefined) set("label", patch.label);
  if (patch.owner_person_id !== undefined) set("owner_person_id", patch.owner_person_id);
  if (patch.owner_role !== undefined) set("owner_role", patch.owner_role);
  if (patch.device_type !== undefined) set("device_type", patch.device_type);
  if (patch.expected_ssid !== undefined) set("expected_ssid", patch.expected_ssid);
  if (patch.notes !== undefined) set("notes", patch.notes);
  if (patch.trusted !== undefined && patch.trusted !== null) set("trusted", patch.trusted);
  if (patch.device_vendor !== undefined) set("device_vendor", patch.device_vendor);
  if (patch.device_model !== undefined) set("device_model", patch.device_model);

  // Always bump labeled_by / labeled_at on a label call.
  params.push(labeled_by);
  sets.push(`last_labeled_by = $${params.length}`);
  sets.push(`last_labeled_at = now()`);

  params.push(normalized);
  await query(
    `UPDATE network_devices SET ${sets.join(", ")} WHERE mac_address = $${params.length}`,
    params,
  );

  return getDevice(normalized);
}

export async function markTrusted(
  mac: string,
  trusted: boolean,
  labeled_by: string,
): Promise<NetworkDeviceRow | null> {
  return labelDevice(mac, { trusted }, labeled_by);
}

export async function deleteDevice(mac: string): Promise<boolean> {
  const normalized = normalizeMac(mac);
  if (!normalized) return false;
  const res = await query(`DELETE FROM network_devices WHERE mac_address = $1`, [normalized]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Derive a MAC address from a Home Assistant device_tracker entity_id.
 * FortiGate's HA integration names MAC-based trackers like
 * `device_tracker.00_e6_3a_29_d5_a0` (six hex octets joined by `_`).
 * Named trackers (`device_tracker.alarm`, `device_tracker.flologic70e76b`)
 * are NOT MAC-based and return null.
 */
export function macFromDeviceTrackerId(entityId: string): string | null {
  const slug = entityId.replace(/^device_tracker\./, '');
  // Six groups of two hex chars separated by underscores.
  if (/^[0-9a-f]{2}(_[0-9a-f]{2}){5}$/i.test(slug)) {
    return normalizeMac(slug.replace(/_/g, ':'));
  }
  return null;
}

interface DeviceTrackerLike {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

export interface BackfillResult {
  scanned: number;
  mac_based: number;
  upserted: number;
  named_skipped: number;
}

/**
 * Backfill the network_devices inventory from Home Assistant
 * `device_tracker.*` entities. FortiGate publishes one tracker per DHCP
 * lease keyed by MAC, so this seeds the inventory with MAC + a friendly
 * hostname (from friendly_name) even before Ruckus/FortiGate REST data
 * flows. Richer fields (IP, SSID, signal) backfill later via
 * recordObservedDevice from the FortiGate/Ruckus device calls.
 *
 * Idempotent: upsertObservedDevice de-dupes on MAC. Named (non-MAC)
 * trackers and HA helper trackers are skipped.
 */
export async function backfillFromDeviceTrackers(
  trackers: DeviceTrackerLike[],
): Promise<BackfillResult> {
  let macBased = 0;
  let upserted = 0;
  let namedSkipped = 0;

  for (const t of trackers) {
    const mac = macFromDeviceTrackerId(t.entity_id);
    if (!mac) {
      namedSkipped++;
      continue;
    }
    macBased++;
    const friendly = typeof t.attributes?.['friendly_name'] === 'string'
      ? (t.attributes['friendly_name'] as string)
      : null;
    // Only pass a hostname if it's human-meaningful (not just the MAC slug).
    const hostname = friendly && !/^[0-9a-f_]{12,}$/i.test(friendly) ? friendly : null;
    try {
      await upsertObservedDevice({ mac, hostname: hostname ?? undefined });
      upserted++;
    } catch {
      // Ingestion is best-effort; skip individual failures.
    }
  }

  return {
    scanned: trackers.length,
    mac_based: macBased,
    upserted,
    named_skipped: namedSkipped,
  };
}
