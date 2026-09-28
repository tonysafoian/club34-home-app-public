-- Persist the resolved connection-method label per device MAC so
-- GET /api/fortigate/devices can read a cached value instead of
-- re-running the full 4-tier ladder (and the network_devices Ruckus
-- history scan) on every request.
--
-- resolved_connection      — the full ConnectionMethod object
--                            ({ method, ssid, source, confidence, ssid_certain }).
-- resolved_connection_at   — when it was last (re)computed; used for
--                            staleness checks + cache invalidation
--                            (set to NULL to force a recompute).
--
-- The cache is refreshed every 5 min by the Ruckus snapshot cron and
-- write-through-updated by the devices endpoint on any cache miss.

ALTER TABLE network_devices
  ADD COLUMN IF NOT EXISTS resolved_connection    jsonb,
  ADD COLUMN IF NOT EXISTS resolved_connection_at timestamptz;
