-- Seed system_updates entries for the May 30, 2026 Network + reliability work.
-- Idempotent: skips rows that already exist by title+version.

INSERT INTO system_updates (title, description, version, update_type, access_hint, published_at)
SELECT * FROM (VALUES
  (
    'Live WiFi Network Monitoring',
    '- The Wireless section now shows live data from the Ruckus controller: 18 access points and ~78 connected devices
- See which access point each device is on, signal strength, and which network (34, 34 AV, 34 Guest) it joined
- Access Points, Clients, and SSIDs are now grouped under a single Wireless entry in the Network section',
    'v3.11.0',
    'feature',
    'Admin → Network → Wireless',
    '2026-05-30T22:00:00Z'::timestamptz
  ),
  (
    'Network Device Inventory',
    '- Every device seen on the network is now tracked in one place with its name, network, and owner
- Devices are auto-discovered from the firewall and WiFi; you can label them and mark them trusted
- New unknown devices on the network now raise an alert automatically',
    'v3.11.0',
    'feature',
    'Admin → Network → Devices',
    '2026-05-30T22:10:00Z'::timestamptz
  ),
  (
    'FortiGate Dashboard Reads Live Data',
    '- The firewall dashboard (WAN throughput, CPU/memory, threats) now reads from the reliable Home Assistant sensors
- Fixes the recurring "no data" panels — the security threat count and WAN stats now populate correctly',
    'v3.11.0',
    'improvement',
    'Admin → Network → Overview',
    '2026-05-30T22:20:00Z'::timestamptz
  ),
  (
    'Faster, More Reliable App',
    '- Cleaned up dead code and fixed a build issue affecting the home and productivity pages
- Reorganized the Network admin section for easier navigation and maintenance
- Honest "Awaiting Integration" placeholders for systems not yet connected (Starlink, MyQ)',
    'v3.11.0',
    'fix',
    'Across the app',
    '2026-05-30T22:30:00Z'::timestamptz
  )
) AS v(title, description, version, update_type, access_hint, published_at)
WHERE NOT EXISTS (
  SELECT 1 FROM system_updates su
  WHERE su.title = v.title AND su.version = v.version
);
