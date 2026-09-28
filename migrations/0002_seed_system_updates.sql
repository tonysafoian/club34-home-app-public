-- Seed 10 system_updates entries for features shipped March 19–22, 2026
-- This migration is idempotent: it skips rows that already exist by title+version.

INSERT INTO system_updates (title, description, version, update_type, access_hint, published_at)
SELECT * FROM (VALUES
  (
    'FortiGate Network Dashboard',
    '- Full firewall monitoring dashboard with real-time interface stats, CPU/memory usage, and session counts
- VPN tunnel status and connected client visibility
- Integrated into the Network section of the sidebar',
    'v3.10.0',
    'feature',
    'Network → FortiGate',
    '2026-03-21T00:00:00Z'::timestamptz
  ),
  (
    'Real-Time Smart Home Updates',
    '- Replaced 15-second polling with instant WebSocket push updates for all 1,286 Home Assistant devices
- Near-instant (1–2 second) state changes across lights, sensors, locks, and climate controls
- Significantly reduced server load and bandwidth usage',
    'v3.9.0',
    'improvement',
    'All smart home pages now update in real time',
    '2026-03-19T00:00:00Z'::timestamptz
  ),
  (
    'People Tracker',
    '- Track recognized individuals across Verkada cameras with automatic face matching
- POI (Person of Interest) profiles with sighting history and last-seen timestamps
- Accurate people counters on the Activity dashboard',
    'v3.8.0',
    'feature',
    'Activity → People Tracker',
    '2026-03-21T00:00:00Z'::timestamptz
  ),
  (
    'Janus Reads & Replies to Email',
    '- Janus now monitors incoming emails and can compose intelligent replies
- Automatic email polling every 30 seconds with duplicate prevention
- Handles threads, attachments, and context-aware responses',
    'v3.7.0',
    'feature',
    'Send Janus an email or check Janus Logs',
    '2026-03-22T00:00:00Z'::timestamptz
  ),
  (
    'WhatsApp Document Processing',
    '- Send PDFs and documents to Janus via WhatsApp and get intelligent summaries
- Full text extraction from PDF attachments
- Works alongside existing image and voice message processing',
    'v3.6.0',
    'feature',
    'Send a PDF to Janus on WhatsApp',
    '2026-03-22T00:00:00Z'::timestamptz
  ),
  (
    'School Broadcast Reliability Upgrade',
    '- Morning school broadcasts now fall back to WhatsApp if all speakers fail
- Automatic failure alerts sent to Tony when speaker TTS encounters errors
- Configurable fallback phone number in system settings',
    'v3.5.0',
    'improvement',
    'Automations → Broadcasts',
    '2026-03-20T00:00:00Z'::timestamptz
  ),
  (
    'Full System Audit Trail',
    '- Every critical action is now logged — Home Assistant commands, network changes, auth events, and cron jobs
- User identity tracked across all channels (web, WhatsApp, email)
- Searchable audit log with severity levels and detailed metadata',
    'v3.4.0',
    'feature',
    'Admin → System Audit Logs',
    '2026-03-19T00:00:00Z'::timestamptz
  ),
  (
    'WhatsApp Stranger Alerts',
    '- Instant alert to Tony when an unrecognized phone number messages Janus for the first time
- Notifications via both WhatsApp and email with the sender''s number and message
- Existing abuse escalation at 3+ messages still active',
    'v3.3.0',
    'feature',
    'Automatic — alerts sent to Tony',
    '2026-03-19T00:00:00Z'::timestamptz
  ),
  (
    'Smarter Janus with New Tools',
    '- Janus can now search the web in real time using Perplexity
- New home troubleshooting tool for diagnosing smart home issues
- Available across both WhatsApp and email channels',
    'v3.2.0',
    'feature',
    'Ask Janus to search for something or troubleshoot a device',
    '2026-03-22T00:00:00Z'::timestamptz
  ),
  (
    'Package Delivery Alerts',
    '- Automatic detection of package delivery emails from carriers
- WhatsApp notification to Tony and email alerts to household staff (Jesse & Sandra)
- Works with major carriers including UPS, FedEx, and Amazon',
    'v3.1.0',
    'feature',
    'Automatic — notifications sent when packages arrive',
    '2026-03-20T00:00:00Z'::timestamptz
  )
) AS v(title, description, version, update_type, access_hint, published_at)
WHERE NOT EXISTS (
  SELECT 1 FROM system_updates su
  WHERE su.title = v.title AND su.version = v.version
);
