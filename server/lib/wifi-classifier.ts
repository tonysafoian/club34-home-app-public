/**
 * Advisory "which SSID should this device be on?" classifier.
 *
 * This is intentionally diagnostic-only: it does NOT move devices,
 * change FortiGate policy, or touch any radio. It just compares a
 * device's hostname / device-type / category against the rules agreed
 * with the user and returns an `expected` label plus an `advice` field
 * the admin UI can render as a hint.
 *
 * Rules summary (per user-stated semantics):
 *   - TV / AppleTV / HomePod / Crestron / Verkada / camera / cam / cast
 *     / Roku / Sonos / AV  → expected `34_AV`
 *   - iPhone / MacBook / iPad / laptop / Mac          → expected `34`
 *   - Unknown on trusted `34` → flag for labeling (do not auto-move)
 *
 * Everything else returns `expected: null` ("no opinion").
 */

export type ExpectedSsid = '34' | '34_AV' | '34_Guest' | null;

export interface DeviceLike {
  hostname?: string | null;
  device_type?: string | null;
  os_type?: string | null;
  hardware_vendor?: string | null;
  category?: string | null;
  subcategory?: string | null;
}

const AV_KEYWORDS = [
  'tv', 'appletv', 'apple-tv', 'apple_tv',
  'homepod', 'home-pod',
  'crestron', 'creston',
  'verkada',
  'camera', 'cam-', '-cam', 'webcam', 'doorbell',
  'chromecast', 'cast',
  'roku',
  'sonos',
  ' av ', '-av-', '_av_', 'av_', 'av-',
  'firetv', 'fire-tv', 'fire_tv',
  'shield-tv', 'shieldtv',
  'nestcam', 'nest-cam',
];

const TRUSTED_KEYWORDS = [
  'iphone',
  'macbook', 'mbp', 'mba',
  'ipad',
  'imac',
  'laptop',
  'mac-mini', 'macmini',
  'ipod',
];

function bag(d: DeviceLike): string {
  // Build a single lowercase haystack from every reasonable text field
  // so a keyword can match against hostname OR device-type OR vendor.
  // Pad with surrounding spaces so " av " can match the "av" token
  // without matching e.g. "stavros".
  return ` ${[
    d.hostname,
    d.device_type,
    d.os_type,
    d.hardware_vendor,
    d.category,
    d.subcategory,
  ].filter(Boolean).join(' ').toLowerCase()} `;
}

export interface ExpectedClassification {
  expected: ExpectedSsid;
  reason: string | null;
}

export function expectedSsidFor(d: DeviceLike): ExpectedClassification {
  const hay = bag(d);

  for (const kw of AV_KEYWORDS) {
    if (hay.includes(kw)) {
      return { expected: '34_AV', reason: `matched "${kw.trim()}" — AV/IoT device` };
    }
  }
  for (const kw of TRUSTED_KEYWORDS) {
    if (hay.includes(kw)) {
      return { expected: '34', reason: `matched "${kw.trim()}" — trusted personal device` };
    }
  }
  return { expected: null, reason: null };
}

export interface WrongNetworkAdvice {
  expected: ExpectedSsid;
  observed: string | null;
  /** "ok" — observed matches expected; "wrong" — observed differs;
   *  "unclassified" — no expected rule; "needs-label" — observed is
   *  the trusted 34 network but device is unknown. */
  status: 'ok' | 'wrong' | 'unclassified' | 'needs-label';
  reason: string | null;
}

/**
 * Compare what we expect with what we observe and return advisory
 * status. `observedLabel` is the friendly SSID the device is currently
 * grouped under (e.g. "34", "34_AV", "34_Guest") — typically the result
 * of the Ruckus client→SSID join (with subnet fallback).
 */
export function adviseWrongNetwork(
  d: DeviceLike,
  observedLabel: string | null,
): WrongNetworkAdvice {
  const { expected, reason } = expectedSsidFor(d);
  if (expected === null) {
    // Unknown device on the trusted `34` network is the one case where
    // we want to draw the operator's attention even without a rule.
    if (observedLabel === '34') {
      return { expected: null, observed: observedLabel, status: 'needs-label', reason: 'unknown device on trusted 34 — label it' };
    }
    return { expected: null, observed: observedLabel, status: 'unclassified', reason: null };
  }
  if (observedLabel && observedLabel === expected) {
    return { expected, observed: observedLabel, status: 'ok', reason };
  }
  return { expected, observed: observedLabel, status: 'wrong', reason };
}
