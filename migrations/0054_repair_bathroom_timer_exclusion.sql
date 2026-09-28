-- One-time repair for environments where Bathroom Light Timer already existed
-- with an empty excluded_terms array before migration 0052 ran. Preserve the
-- requested Enzo exclusion. Future admin edits (including intentionally
-- clearing the list) remain untouched because this migration runs only once.

UPDATE family_automations
SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{excluded_terms}', '["enzo"]'::jsonb, true),
    updated_at = NOW()
WHERE name = 'Bathroom Light Timer'
  AND COALESCE(jsonb_array_length(
    CASE
      WHEN jsonb_typeof(COALESCE(config, '{}'::jsonb)->'excluded_terms') = 'array'
      THEN COALESCE(config, '{}'::jsonb)->'excluded_terms'
      ELSE '[]'::jsonb
    END
  ), 0) = 0;