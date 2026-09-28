-- Reclassify misclassified LPR events in verkada_events.
-- Run this once against production to fix events that were stored under the wrong event_type
-- because the webhook handler did not recognise Verkada's actual LPR payload format.
--
-- Usage (production):
--   psql $DATABASE_URL -f scripts/reclassify-lpr-events.sql
--
-- The query identifies rows where raw_data contains license plate information
-- (license_plate, plate_number, lpr_plate, or a nested "lpr" object) but the
-- event_type was NOT set to 'license_plate', then:
--   1. Sets event_type = 'license_plate'
--   2. Populates vehicle_plate from whichever field holds the plate value
--   3. Reports exactly how many rows were reclassified

WITH reclassified AS (
  UPDATE verkada_events
  SET
    event_type    = 'license_plate',
    vehicle_plate = COALESCE(
      vehicle_plate,
      raw_data::jsonb ->> 'license_plate',
      raw_data::jsonb ->> 'plate_number',
      raw_data::jsonb ->> 'lpr_plate',
      raw_data::jsonb -> 'lpr' ->> 'plate',
      raw_data::jsonb -> 'lpr' ->> 'plate_number'
    )
  WHERE event_type != 'license_plate'
    AND (
      raw_data::jsonb ? 'license_plate'
      OR raw_data::jsonb ? 'plate_number'
      OR raw_data::jsonb ? 'lpr_plate'
      OR raw_data::jsonb ? 'lpr'
      OR raw_data::text ILIKE '%license_plate%'
    )
  RETURNING id
)
SELECT 'Rows reclassified in this run' AS action, COUNT(*) AS count
FROM reclassified;
