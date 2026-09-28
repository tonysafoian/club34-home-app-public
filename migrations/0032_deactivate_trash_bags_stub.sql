-- Deactivate the leftover "Trash Bags 13 gal" stub from 0029.
--
-- 0031_reseed_grocery_staples_real_list.sql tried to deactivate it via
-- name IN ('Trash Bags', ...) but the actual seeded name in 0029 is
-- "Trash Bags 13 gal", so the row stayed active and the post-migration
-- active_count was 26 instead of the expected 25.
--
-- Pattern matches 0031: is_active=false (deactivation, not deletion) so
-- the audit trail is preserved per the append-only migrations rule.

UPDATE grocery_staples
SET is_active = false, updated_at = NOW()
WHERE name = 'Trash Bags 13 gal'
  AND amazon_asin IS NULL;
