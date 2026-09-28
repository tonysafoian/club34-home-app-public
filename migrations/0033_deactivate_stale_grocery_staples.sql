-- Defensive cleanup: deactivate any active grocery_staples row whose
-- amazon_asin is NOT in the canonical 25-item list from 0031.
--
-- Why: 0031's deactivation block listed 19 ASINs by hand but
-- migrations/0025_seed_grocery_staples.sql actually seeded 25 ASINs.
-- The 6 missed ASINs (B001E0JKHI, B00DS842HS, B00KBDL2YE, B01MUGZM15,
-- B01N5IQ3H8, B07D2YGQHB) stayed active in production, and their
-- image URLs are now 404 on Amazon — surfacing as 502s through the
-- /api/grocery/image proxy on application domain.
--
-- Dev's DB happened to be clean (different prior state), but prod
-- leaked. This migration is set-based against the canonical 25 ASINs,
-- so it self-corrects regardless of what each environment's DB looked
-- like before, and is safe to re-apply.
--
-- Pattern matches 0031 / 0032: is_active=false (deactivation, not
-- deletion) so the audit trail is preserved per the append-only
-- migrations rule.

UPDATE grocery_staples
SET is_active = false, updated_at = NOW()
WHERE is_active = true
  AND (
    amazon_asin IS NULL
    OR amazon_asin NOT IN (
      'B077X7K81W','B000P6J2RG','B000NSGULC','B000P6L3V4','B003IMCOD8',
      'B00WTR0CDM','B01ITHOI80','B0D64C5TH2','B0D7J7595Z','B01MZHDHVM',
      'B079D5RY71','B00E3J9QSG','B086WXSSQV','B000P72UZG','B07WNSHZVC',
      'B077N7TR5G','B002B8Z98W','B001L1KRNC','B000P6J1M2','B002GVJZS4',
      'B000SE9NUG','B001GIP2A8','B003TQA73M','B00UGBUZ1M','B07ZLF9G83'
    )
  );
