/**
 * _shared/tools/home-automation.ts
 *
 * Home Assistant, Tesla, Verkada, and Generator tool executors.
 * Extracted from janus-chat/index.ts to reduce monolith size.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { refreshTeslaToken, TESLA_API_BASE } from "../janus-tools.ts";

type SupabaseClient = ReturnType<typeof createClient>;

// --- Home Assistant proxy (direct API calls) ---
export async function callHAProxy(action: string, extra: Record<string, unknown> = {}): Promise<string> {
  const HA_URL = Deno.env.get("HA_URL");
  const HA_TOKEN = Deno.env.get("HA_TOKEN");
  if (!HA_URL || !HA_TOKEN) return "Home Assistant is not configured.";
  const haUrl = `${HA_URL.replace(/\/$/, "")}`;
  try {
    if (action === "get-states") {
      const domain = extra.domain as string | undefined;
      const res = await fetch(`${haUrl}/api/states`, {
        headers: { Authorization: `Bearer ${HA_TOKEN}`, "Content-Type": "application/json" },
      });
      type HAEntity = {
        entity_id: string;
        state: string;
        attributes?: {
          friendly_name?: string;
          unit_of_measurement?: string;
          temperature?: number;
          current_temperature?: number;
          brightness?: number;
          hvac_mode?: string;
          current_position?: number;
        };
      };
      const data = await res.json();
      const entities: HAEntity[] = Array.isArray(data) ? data : [];
      const filtered = domain ? entities.filter((e) => e.entity_id.startsWith(`${domain}.`)) : entities;
      return JSON.stringify(filtered.slice(0, 100).map((e) => ({
        entity_id: e.entity_id,
        state: e.state,
        name: e.attributes?.friendly_name,
        unit: e.attributes?.unit_of_measurement,
        temperature: e.attributes?.temperature,
        current_temperature: e.attributes?.current_temperature,
        brightness: e.attributes?.brightness ? Math.round((e.attributes.brightness / 255) * 100) + "%" : undefined,
        hvac_mode: e.attributes?.hvac_mode,
        position: e.attributes?.current_position,
      })));
    }
    if (action === "get-state") {
      const res = await fetch(`${haUrl}/api/states/${extra.entity_id}`, {
        headers: { Authorization: `Bearer ${HA_TOKEN}`, "Content-Type": "application/json" },
      });
      const data = await res.json();
      return JSON.stringify(data);
    }
    if (action === "call-service") {
      const res = await fetch(`${haUrl}/api/services/${extra.domain}/${extra.service}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${HA_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(extra.service_data || {}),
      });
      const text = await res.text();
      return res.ok ? `Service ${extra.domain}.${extra.service} executed successfully.` : `Error: ${text.slice(0, 200)}`;
    }
    if (action === "get-logbook") {
      const hours = (extra.hours as number) || 12;
      const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      let path = `/api/logbook/${start}`;
      if (extra.entity_id) path += `?entity=${extra.entity_id}`;
      const res = await fetch(`${haUrl}${path}`, {
        headers: { Authorization: `Bearer ${HA_TOKEN}`, "Content-Type": "application/json" },
      });
      const data = await res.json();
      const entries = Array.isArray(data) ? data.slice(0, 30) : [];
      return JSON.stringify(entries.map((e: { name?: string; message?: string; when?: string; entity_id?: string }) => ({ name: e.name, message: e.message, when: e.when, entity_id: e.entity_id })));
    }
    return "Unknown HA action.";
  } catch (e) {
    return `Home Assistant error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

export async function executeHAGetStates(domain?: string): Promise<string> {
  return callHAProxy("get-states", domain ? { domain } : {});
}

export async function executeHAGetState(entity_id: string): Promise<string> {
  return callHAProxy("get-state", { entity_id });
}

export async function executeHACallService(domain: string, service: string, service_data?: Record<string, unknown>): Promise<string> {
  return callHAProxy("call-service", { domain, service, service_data: service_data || {} });
}

export async function executeHAGetLogbook(hours?: number, entity_id?: string): Promise<string> {
  return callHAProxy("get-logbook", { hours: hours || 12, entity_id });
}

// --- Tesla ---
export async function executeCheckTeslaStatus(svc: SupabaseClient): Promise<string> {
  try {
    const { data: tokenRow } = await svc.from("tesla_tokens").select("*").order("token_expires_at", { ascending: false }).limit(1).single();
    if (!tokenRow) return "Tesla not connected — no token found.";

    const accessToken = await refreshTeslaToken(svc, tokenRow);

    const vRes = await fetch(`${TESLA_API_BASE}/api/1/vehicles`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const vData = await vRes.json();
    if (!vData.response || vData.response.length === 0) return "No Tesla vehicles found.";

    const lines: string[] = [];
    for (const v of vData.response) {
      let line = `**${v.display_name || v.vin}** — ${v.state}`;
      if (v.state === "online") {
        try {
          const dRes = await fetch(`${TESLA_API_BASE}/api/1/vehicles/${v.id}/vehicle_data?endpoints=${encodeURIComponent("charge_state;climate_state;drive_state;location_data;vehicle_state")}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          let dData = await dRes.json();
          if (dRes.status === 403) {
            const retry = await fetch(`${TESLA_API_BASE}/api/1/vehicles/${v.id}/vehicle_data?endpoints=${encodeURIComponent("charge_state;climate_state;drive_state;vehicle_state")}`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            dData = await retry.json();
          }
          const r = dData.response;
          if (r) {
            const cs = r.charge_state;
            const cl = r.climate_state;
            const vs = r.vehicle_state;
            const ds = r.drive_state;
            if (cs) line += `, ${cs.battery_level}%, ${Math.round(cs.battery_range)} mi, ${cs.charging_state}`;
            if (vs) line += `, ${vs.locked ? "Locked" : "Unlocked"}`;
            if (cl) {
              if (cl.inside_temp != null) line += `, Interior ${Math.round(cl.inside_temp * 9/5 + 32)}°F`;
              if (cl.outside_temp != null) line += `, Exterior ${Math.round(cl.outside_temp * 9/5 + 32)}°F`;
            }
            if (ds?.latitude && ds?.longitude) line += `, Location: ${ds.latitude.toFixed(4)},${ds.longitude.toFixed(4)}`;
          }
        } catch (e) { line += ` (data fetch error: ${e})`; }
      }
      lines.push(line);
    }

    const { data: alerts } = await svc.from("tesla_battery_alerts").select("vehicle_name, last_range_miles, last_alerted_at, alert_active").order("updated_at", { ascending: false }).limit(5);
    if (alerts && alerts.length > 0) {
      lines.push("\n**Recent Battery Alerts:**");
      for (const a of alerts) {
        lines.push(`- ${a.vehicle_name || "Unknown"}: ${a.last_range_miles} mi, alert ${a.alert_active ? "ACTIVE" : "cleared"}${a.last_alerted_at ? `, last alerted ${a.last_alerted_at}` : ""}`);
      }
    }

    return lines.join("\n");
  } catch (e) {
    return `TOOL_ERROR: Tesla status check failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// --- Verkada Security ---
export async function executeCheckVerkadaSecurity(svc: SupabaseClient): Promise<string> {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lines: string[] = [];

    try {
      const camRes = await fetch(`${url}/functions/v1/verkada-proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${svcKey}`, apikey: svcKey },
        body: JSON.stringify({ action: "list-cameras" }),
      });
      type VerkadaCamera = { status?: string; cloud_enabled?: boolean };
      const camData = await camRes.json();
      const cameras: VerkadaCamera[] = camData.cameras || camData.camera_groups?.flatMap((g: { cameras?: VerkadaCamera[] }) => g.cameras) || [];
      const online = cameras.filter((c) => c.status === "online" || c.cloud_enabled).length;
      lines.push(`**Cameras:** ${cameras.length} total, ${online} online, ${cameras.length - online} offline`);
    } catch (e) { lines.push(`Cameras: error fetching — ${e}`); }

    try {
      const now = Math.floor(Date.now() / 1000);
      const start = now - 86400;
      const accRes = await fetch(`${url}/functions/v1/verkada-proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${svcKey}`, apikey: svcKey },
        body: JSON.stringify({ action: "access-events", start_time: String(start), end_time: String(now), page_size: 20 }),
      });
      const accData = await accRes.json();
      const events = accData.access_events || [];
      if (events.length > 0) {
        lines.push(`\n**Recent Access Events (${events.length}):**`);
        for (const e of events.slice(0, 10)) {
          const time = e.timestamp ? new Date(e.timestamp * 1000).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }) : "?";
          lines.push(`- ${time}: ${e.actor_name || "Unknown"} — ${e.event_type || "access"} at ${e.door_name || "unknown door"}`);
        }
      } else { lines.push("\nNo access events in the last 24 hours."); }
    } catch (e) { lines.push(`Access events: error — ${e}`); }

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: sightings } = await svc.from("poi_sightings").select("label, camera_name, seen_at").gte("seen_at", cutoff).order("seen_at", { ascending: false }).limit(20);
    if (sightings && sightings.length > 0) {
      lines.push(`\n**POI Sightings (last 24h): ${sightings.length}**`);
      for (const s of sightings.slice(0, 10)) {
        const time = new Date(s.seen_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
        lines.push(`- ${time}: ${s.label || "Unknown person"} at ${s.camera_name || "unknown camera"}`);
      }
    } else { lines.push("\nNo POI sightings in the last 24 hours."); }

    return lines.join("\n");
  } catch (e) {
    return `TOOL_ERROR: Verkada security check failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// --- Generac Generator ---
export async function executeCheckGeneratorStatus(): Promise<string> {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const res = await fetch(`${url}/functions/v1/generac-proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${svcKey}`, apikey: svcKey },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) return `TOOL_ERROR: Generator proxy returned ${res.status}: ${data.error || "unknown"}`;
    const generators = data.generators || [];
    if (generators.length === 0) return "No generators found.";
    const lines: string[] = [];
    for (const g of generators) {
      lines.push(`**${g.name}** — ${g.statusText}, ${g.isConnected ? "Connected" : "Disconnected"}`);
      if (g.batteryVoltage != null) lines.push(`  Battery: ${g.batteryVoltage}V`);
      if (g.runHours != null) lines.push(`  Run Hours: ${g.runHours}`);
      if (g.lastSeen) lines.push(`  Last Seen: ${g.lastSeen}`);
      if (g.address) lines.push(`  Location: ${g.address}`);
    }
    return lines.join("\n");
  } catch (e) {
    return `TOOL_ERROR: Generator status check failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}
