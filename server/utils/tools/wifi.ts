/**
 * Janus chat tools for the person↔device mapping system.
 *
 * - wifi_who_is_online — joins live Ruckus clients with the
 *   network_devices inventory and groups by person / role so chat
 *   answers look like "Tony's iPhone on 34 at -54 dBm" not
 *   "11:22:33:44:55:66".
 * - wifi_label_device — admin-only chat label flow. Accepts a MAC plus
 *   any of label / owner_person_id / owner_role / device_type /
 *   expected_ssid / trusted.
 * - wifi_unknown_devices — surfaces the triage list of recently-seen
 *   unlabeled devices so the admin / Janus can assign identities.
 */

import { getClients, type RuckusClient } from "../../lib/ruckus.js";
import {
  labelDevice,
  unknownDevices,
  listDevices,
  inferVendorFromMac,
  type NetworkDeviceRow,
  type LabelDeviceInput,
} from "../../lib/network-devices.js";

interface WhoOnlineArgs {
  filter?: "family" | "staff" | "guest" | "iot" | "unknown";
}

interface LabelArgs {
  mac?: string;
  label?: string | null;
  owner_person_id?: string | null;
  owner_role?: string | null;
  device_type?: string | null;
  expected_ssid?: string | null;
  trusted?: boolean | null;
  notes?: string | null;
}

interface UnknownDevicesArgs {
  window_hours?: number;
}

function formatClientLine(client: RuckusClient, device: NetworkDeviceRow | null): string {
  // Prefer the labeled name; fall back to MAC + best-effort hints.
  const labelOrName =
    device?.label ??
    client.hostname ??
    [device?.device_vendor, device?.device_model].filter(Boolean).join(" ") ??
    client.mac;
  const ssid = client.ssid ? ` · ${client.ssid}` : "";
  const signalText =
    client.signal != null ? ` · ${client.signal} dBm (${client.signal_health})` : "";
  const ip = client.ip ? ` · ${client.ip}` : "";
  return `${labelOrName}${ssid}${signalText}${ip}`;
}

function deriveGroupKey(device: NetworkDeviceRow | null, filter?: WhoOnlineArgs["filter"]): string {
  if (!device) return "Unknown";
  // Apply filter check first — if the device doesn't match the filter,
  // signal that with a special key the caller can drop.
  if (filter) {
    if (filter === "unknown") {
      return device.owner_person_id || device.label ? "__drop__" : "Unknown";
    }
    if (device.owner_role !== filter) return "__drop__";
  }
  if (device.owner_person_id) {
    const role = device.owner_role ?? "family";
    // Title-case the person id ('tony' → 'Tony').
    const name = device.owner_person_id.charAt(0).toUpperCase() + device.owner_person_id.slice(1);
    return `${name} (${role})`;
  }
  if (device.owner_role) {
    const role = device.owner_role.charAt(0).toUpperCase() + device.owner_role.slice(1);
    return role;
  }
  return "Unknown";
}

export async function executeWifiWhoIsOnline(args: WhoOnlineArgs): Promise<string> {
  let clients: RuckusClient[];
  try {
    clients = await getClients();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `TOOL_ERROR: could not fetch Ruckus clients: ${message}`;
  }
  if (clients.length === 0) {
    return "No wireless clients currently online.";
  }

  // Pull the labeled devices in one shot — getClients() returns at most
  // a couple hundred entries on this LAN, so we can scan in memory.
  let inventoryRows: NetworkDeviceRow[] = [];
  try {
    const res = await listDevices({ limit: 500 });
    inventoryRows = res.devices;
  } catch (err) {
    // Inventory lookup is best-effort — if the DB is unavailable we
    // still want to return a usable list, just unlabeled.
    console.warn(`[wifi_who_is_online] inventory lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const byMac = new Map<string, NetworkDeviceRow>();
  for (const row of inventoryRows) byMac.set(row.mac_address.toLowerCase(), row);

  const groups = new Map<string, string[]>();
  let total = 0;
  for (const c of clients) {
    if (!c.mac) continue;
    const device = byMac.get(c.mac.toLowerCase()) ?? null;
    const key = deriveGroupKey(device, args.filter);
    if (key === "__drop__") continue;
    total += 1;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(`- ${formatClientLine(c, device)}`);
  }

  if (total === 0) {
    return args.filter
      ? `No ${args.filter} devices currently online.`
      : "No matching devices online.";
  }

  // Sort groups: known people first (alphabetical), then roles, then Unknown.
  const orderedKeys = Array.from(groups.keys()).sort((a, b) => {
    const ua = a === "Unknown" || a.startsWith("Unknown");
    const ub = b === "Unknown" || b.startsWith("Unknown");
    if (ua !== ub) return ua ? 1 : -1;
    return a.localeCompare(b);
  });

  const sections: string[] = [];
  for (const key of orderedKeys) {
    const lines = groups.get(key)!;
    const heading = key === "Unknown" && lines.length > 1 ? `Unknown (${lines.length} devices):` : `${key}:`;
    sections.push(`${heading}\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

export async function executeWifiLabelDevice(args: LabelArgs, userId: string | undefined): Promise<string> {
  if (!args.mac) return "TOOL_ERROR: mac is required";
  const patch: LabelDeviceInput = {
    label: args.label,
    owner_person_id: args.owner_person_id,
    owner_role: args.owner_role,
    device_type: args.device_type,
    expected_ssid: args.expected_ssid,
    trusted: typeof args.trusted === "boolean" ? args.trusted : undefined,
    notes: args.notes,
  };
  try {
    const updated = await labelDevice(args.mac, patch, userId ?? "janus");
    if (!updated) return `TOOL_ERROR: invalid mac: ${args.mac}`;
    const fields = [
      updated.label ? `label="${updated.label}"` : null,
      updated.owner_person_id ? `owner=${updated.owner_person_id}` : null,
      updated.owner_role ? `role=${updated.owner_role}` : null,
      updated.device_type ? `type=${updated.device_type}` : null,
      updated.expected_ssid ? `expected_ssid=${updated.expected_ssid}` : null,
      updated.trusted ? "trusted" : null,
    ].filter(Boolean).join(" · ");
    return `Updated ${updated.mac_address}${fields ? `: ${fields}` : ""}.`;
  } catch (err) {
    return `TOOL_ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function executeWifiUnknownDevices(args: UnknownDevicesArgs): Promise<string> {
  const windowHours = args.window_hours ?? 24;
  let rows: NetworkDeviceRow[];
  try {
    rows = await unknownDevices(windowHours);
  } catch (err) {
    return `TOOL_ERROR: could not query unknown devices: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (rows.length === 0) {
    return `No unlabeled devices seen in the last ${windowHours} hours.`;
  }
  const lines = rows.slice(0, 50).map((r) => {
    const vendor = r.device_vendor ?? inferVendorFromMac(r.mac_address) ?? "Unknown vendor";
    const hostname = r.hostnames?.[0] ?? "—";
    const ip = r.ip_addresses?.[0] ?? "—";
    const ssid = r.ssids?.[0] ? ` on ${r.ssids[0]}` : "";
    return `- ${r.mac_address} · ${hostname} (${vendor})${ssid} · ${ip}`;
  });
  return `Unlabeled devices seen in last ${windowHours}h (${rows.length}):\n${lines.join("\n")}`;
}
