-- 0052: seed the Bathroom Light Timer exclusion list.
--
-- Enzo's bathroom was excluded from the 15-minute bathroom timer by a
-- hardcoded name check in server/routes/energySavings.ts. That check is now
-- replaced by an admin-editable config.excluded_terms list (case-insensitive
-- substring match against entity_id + friendly name) on the timer's
-- family_automations row, honored by both the closet and bathroom timers.
-- Seed "enzo" here so current behavior is preserved on deploy.
UPDATE family_automations
SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{excluded_terms}', '["enzo"]'::jsonb, true),
    updated_at = NOW()
WHERE name = 'Bathroom Light Timer'
  AND NOT (COALESCE(config, '{}'::jsonb) ? 'excluded_terms');
