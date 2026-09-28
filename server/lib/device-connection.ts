/**
 * Shared per-device connection-method resolution.
 *
 * Both the `/api/fortigate/devices` endpoint and the Ruckus snapshot cron
 * must extract device fields, classify, and resolve the connection method
 * the EXACT same way — otherwise the value the cron persists to the cache
 * would differ from what the endpoint computes on a cache miss, leaving the
 * UI flickering between two answers. Centralising the logic here guarantees
 * they stay in lockstep.
 */

import { classifyDevice, type DeviceClassification } from '../deviceClassifier.js';
import { resolveSubnetLabel } from './wifi-map.js';
import {
  resolveConnectionMethod,
  type ConnectionMethod,
  type ConnectionResolverContext,
} from './connection-resolver.js';
import { normalizeMac } from './network-devices.js';

export interface ExtractedDeviceFields {
  hw_vendor: string | null;
  dev_type: string | null;
  os_type: string | null;
  hostname: string | null;
  mac: string | null;
  ip: string | null;
}

/**
 * Pull the canonical IPv4 address out of a FortiGate device record,
 * handling the several shapes FortiOS uses (scalar, array-of-strings,
 * array-of-objects, legacy `ipaddr`/`ip`).
 */
export function extractIpAddress(d: Record<string, unknown>): string | null {
  if (typeof d['ipv4_address'] === 'string' && d['ipv4_address']) return d['ipv4_address'];
  if (Array.isArray(d['ipv4_addresses']) && d['ipv4_addresses'].length > 0) {
    const first = d['ipv4_addresses'][0];
    if (typeof first === 'string' && first) return first;
    if (first !== null && typeof first === 'object') {
      const addr = (first as Record<string, unknown>)['ip'] ?? (first as Record<string, unknown>)['ipv4_address'] ?? (first as Record<string, unknown>)['address'];
      if (typeof addr === 'string' && addr) return addr;
    }
  }
  if (typeof d['ipaddr'] === 'string' && d['ipaddr']) return d['ipaddr'];
  if (typeof d['ip'] === 'string' && d['ip']) return d['ip'];
  return null;
}

/**
 * Normalise a raw FortiGate device record into the handful of fields the
 * classifier + connection resolver need. Mirrors the field-aliasing the
 * devices endpoint has always done (vendor/hardware_vendor, dev_type/
 * device_type, os/os_type, hostname/name).
 */
export function extractDeviceFields(d: Record<string, unknown>): ExtractedDeviceFields {
  const hw_vendor = typeof d['vendor'] === 'string' ? d['vendor'] : (typeof d['hardware_vendor'] === 'string' ? d['hardware_vendor'] : null);
  const dev_type = typeof d['dev_type'] === 'string' ? d['dev_type'] : (typeof d['device_type'] === 'string' ? d['device_type'] : null);
  const os_type = typeof d['os'] === 'string' ? d['os'] : (typeof d['os_type'] === 'string' ? d['os_type'] : null);
  const hostname = typeof d['hostname'] === 'string' ? d['hostname'] : (typeof d['name'] === 'string' ? d['name'] : null);
  const mac = typeof d['mac'] === 'string' ? d['mac'] : null;
  const ip = extractIpAddress(d);
  return { hw_vendor, dev_type, os_type, hostname, mac, ip };
}

export interface OverrideLike {
  customCategory?: string | null;
  customSubcategory?: string | null;
}

export interface ResolvedDeviceConnection {
  fields: ExtractedDeviceFields;
  normalizedMac: string | null;
  classification: DeviceClassification;
  connection: ConnectionMethod;
}

/**
 * Classify a raw FortiGate device and resolve its physical connection
 * method through the 4-tier ladder. The override (if any) supplies the
 * admin-pinned category/subcategory used by the Tier-3 heuristics.
 */
export function resolveDeviceConnection(
  d: Record<string, unknown>,
  override: OverrideLike | null | undefined,
  ctx: ConnectionResolverContext,
): ResolvedDeviceConnection {
  const fields = extractDeviceFields(d);
  const classification = classifyDevice(fields.hw_vendor, fields.dev_type, fields.os_type, fields.hostname, fields.mac);
  const normalizedMac = fields.mac ? normalizeMac(fields.mac) : null;
  const subnetLabel = resolveSubnetLabel(fields.ip);
  const deviceLike = {
    hostname: fields.hostname,
    device_type: fields.dev_type,
    os_type: fields.os_type,
    hardware_vendor: fields.hw_vendor,
    category: override?.customCategory ?? classification.category,
    subcategory: override?.customSubcategory ?? classification.subcategory,
  };
  const connection = resolveConnectionMethod(normalizedMac, deviceLike, subnetLabel, ctx);
  return { fields, normalizedMac, classification, connection };
}
