-- Update the Morning Sauna family_automations row to reflect the split cron.
--
-- The cron in server/routes/cron.ts now fires at:
--   * MWF 8:30 AM PT  ('30 8 * * 1,3,5')
--   * Tu/Th 8:50 AM PT ('50 8 * * 2,4')
-- A single cron expression can't represent both, so the `schedule` column
-- (free-form text used purely for display) now holds a descriptive label.
--
-- Idempotent — safe to re-run.

UPDATE family_automations
SET
  schedule = 'MWF 8:30 AM · Tu/Th 8:50 AM PT',
  description = 'Turns on sauna at 190°F on weekday mornings (MWF 8:30 AM, Tu/Th 8:50 AM PT)'
WHERE name = 'Morning Sauna';
