-- Defensive: ensure grocery_staples.image_url uses the _SL1500_ Amazon
-- variant (which exists) instead of _AC_SL300_ (which 404s). The seed
-- in 0025 has the bad variant; this migration enforces the good one
-- and is a no-op if rows are already correct.
--
-- Production currently has 25/25 rows with _AC_SL300_ (broken).
-- Dev was manually fixed to _SL1500_ at some point. This migration
-- makes both environments converge to the working variant.

UPDATE grocery_staples
SET image_url = REPLACE(image_url, '_AC_SL300_', '_SL1500_'),
    updated_at = NOW()
WHERE image_url LIKE '%_AC_SL300_%';
