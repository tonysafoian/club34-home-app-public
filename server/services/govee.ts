// AV Closet temperature — Govee Cloud API (source of truth)
//
// Home Assistant's Govee integration double-converts the H5103's reading: the
// sensor already reports °F, but HA treats that value as °C and converts it to
// °F again (e.g. 68.36 → 68.36×9/5+32 = 155.05°F). To get the real temperature
// we bypass HA entirely and read the value straight from Govee's Cloud API,
// where `sensorTemperature` is already in Fahrenheit.
//
// Docs: POST https://openapi.api.govee.com/router/api/v1/device/state
//   headers: { 'Govee-API-Key': <key> }
//   body:    { requestId, payload: { sku, device } }
//   response.payload.capabilities[] → { instance, state: { value } }

const GOVEE_STATE_URL = 'https://openapi.api.govee.com/router/api/v1/device/state';

// Device identifiers are not secrets; defaults target the AV Closet H5103 and can
// be overridden via env if the device is ever swapped.
const AV_CLOSET_SKU = process.env.GOVEE_AV_CLOSET_SKU || 'H5103';
const AV_CLOSET_DEVICE = process.env.GOVEE_AV_CLOSET_DEVICE || '1D:83:E4:8F:81:C6:42:66';

const SUCCESS_TTL_MS = 60_000; // cache good readings for 60s
const FAILURE_TTL_MS = 30_000; // back off briefly on errors to avoid hammering

export interface AvClosetReading {
  tempF: number | null;
  humidity: number | null;
  // Device online flag from Govee's `online` capability. `false` means the
  // sensor is offline (e.g. dead battery / lost connectivity). `null` when Govee
  // didn't report it. NOTE: the H5103 does not expose battery level via this API.
  online: boolean | null;
  source: 'govee';
  fetchedAt: string; // ISO timestamp of the underlying fetch
}

interface CacheEntry {
  reading: AvClosetReading | null;
  ts: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<AvClosetReading | null> | null = null;

export function isGoveeConfigured(): boolean {
  return Boolean(process.env.GOVEE_API_KEY);
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

async function fetchReading(): Promise<AvClosetReading | null> {
  const apiKey = process.env.GOVEE_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(GOVEE_STATE_URL, {
      method: 'POST',
      headers: {
        'Govee-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requestId: `janus-${Date.now()}`,
        payload: { sku: AV_CLOSET_SKU, device: AV_CLOSET_DEVICE },
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Govee API ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data: any = await resp.json();
    const caps: any[] = Array.isArray(data?.payload?.capabilities)
      ? data.payload.capabilities
      : [];
    const findVal = (instance: string) =>
      toNumber(caps.find((c: any) => c?.instance === instance)?.state?.value);

    // sensorTemperature is already °F for this device — use as-is, no conversion.
    const tempF = findVal('sensorTemperature');
    const humidity = findVal('sensorHumidity');

    // Online/offline flag — Govee reports the device as offline when the battery
    // dies or it loses connectivity. Used by the monitor to alert on outages.
    const onlineCap = caps.find(
      (c: any) => c?.type === 'devices.capabilities.online' || c?.instance === 'online',
    );
    const online =
      typeof onlineCap?.state?.value === 'boolean' ? (onlineCap.state.value as boolean) : null;

    return { tempF, humidity, online, source: 'govee', fetchedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns the corrected AV Closet reading from Govee, cached for 60s.
 * Returns `null` when Govee is not configured or the request fails (callers must
 * treat that as "unavailable" — never fall back to HA's double-converted value).
 */
export async function getAvClosetReading(force = false): Promise<AvClosetReading | null> {
  const now = Date.now();
  if (!force && cache) {
    const ttl = cache.reading ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
    if (now - cache.ts < ttl) return cache.reading;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const reading = await fetchReading();
      cache = { reading, ts: Date.now() };
      return reading;
    } catch (err: any) {
      console.error('[govee] AV Closet reading failed:', err?.message || err);
      cache = { reading: null, ts: Date.now() };
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
