-- ============================================================
-- Re-seed grocery_staples with Tony's real Amazon Fresh staples.
-- Replaces the invented list from 0025 + 0029.
--
-- All ASINs and image URLs were verified by Tony's product team
-- (Computer/Comet) on 2026-05-17:
--   - HEAD https://www.amazon.com/gp/product/{ASIN} → 200
--   - GET <image_url> → 200, image/jpeg, no auth required, no referer required
--
-- Idempotent via WHERE NOT EXISTS on amazon_asin. Safe to re-apply.
--
-- Note: numbered 0031 (not 0030 as the original spec suggested) because
-- 0030_remove_topo_chico_staple.sql already exists and was applied — per
-- the spec's own "check migrations/ for the next available number" check.
-- ============================================================

BEGIN;

-- 1. Deactivate the WRONG rows from previous seeds so the UI stops showing them.
--    Match by the specific (wrong) ASINs that 0025 and 0029 inserted.
UPDATE grocery_staples SET is_active = false, updated_at = NOW()
WHERE amazon_asin IN (
  -- From 0025 (invented):
  'B07MF6G41K','B00JJC3FE2','B001AO5VZW','B005K2XHVO','B07C6BZDL8',
  'B00CHMN5G8','B00B3QPUG8','B00CML2G7Y','B00Z8GRPOW','B07BHB5JNV',
  'B000YZ6R3K','B00Z8QHBNI','B07MKNMT8G','B00YFKR7KE','B07MF6M1RS',
  'B07P5XPR94','B07K47QNHX','B00J074W5A','B00473DLXQ'
)
-- Also deactivate any rows where amazon_asin IS NULL and brand IS NULL — those came from 0029 stub rows.
OR (amazon_asin IS NULL AND brand IS NULL);

ALTER TABLE grocery_staples ADD COLUMN IF NOT EXISTS amazon_url text;

-- Also deactivate the 0029 rows that have brand but NULL ASIN — those are also invented stubs:
UPDATE grocery_staples SET is_active = false, updated_at = NOW()
WHERE amazon_asin IS NULL
  AND name IN (
    'Boneless Skinless Chicken Thighs',
    'Canned Diced Tomatoes',
    'Penne Pasta',
    'Coconut Water',
    'Almond Milk Unsweetened',
    'Hummus Classic',
    'Paper Towels',
    'Toilet Paper',
    'Dish Soap',
    'Trash Bags'
  );

-- 2. Insert the real 25-item list. WHERE NOT EXISTS keyed by amazon_asin so safe to re-run.
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Horizon Organic Grassfed Whole Milk', 1, 'dairy', 'amazon-fresh', true, 'Horizon Organic', 'Half Gallon, 59 Fl Oz', 'B077X7K81W', 'https://www.amazon.com/gp/product/B077X7K81W', 'https://m.media-amazon.com/images/I/712qtUjtMNL._SL1500_.jpg', 7.47
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B077X7K81W');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Apricots, 2 lb Package', 1, 'produce', 'amazon-fresh', true, 'Washington', '2 lb', 'B000P6J2RG', 'https://www.amazon.com/gp/product/B000P6J2RG', 'https://m.media-amazon.com/images/I/71NSURHdJOL._SL1500_.jpg', 1.00
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B000P6J2RG');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Cantaloupe Melon', 1, 'produce', 'amazon-fresh', true, 'Fresh Produce', '1 Each', 'B000NSGULC', 'https://www.amazon.com/gp/product/B000NSGULC', 'https://m.media-amazon.com/images/I/81l25K4fZ7L._SL1500_.jpg', 2.97
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B000NSGULC');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Gold Pineapple', 1, 'produce', 'amazon-fresh', true, 'Fresh Produce', '1 Each', 'B000P6L3V4', 'https://www.amazon.com/gp/product/B000P6L3V4', 'https://m.media-amazon.com/images/I/71twrl8ehjL._SL1500_.jpg', 2.29
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B000P6L3V4');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Honeydew Melon', 1, 'produce', 'amazon-fresh', true, 'Fresh Produce', '1 Each', 'B003IMCOD8', 'https://www.amazon.com/gp/product/B003IMCOD8', 'https://m.media-amazon.com/images/I/71fVffJ52gL._SL1500_.jpg', 4.46
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B003IMCOD8');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'FAGE Total Greek Yogurt 5% Whole', 1, 'dairy', 'amazon-fresh', true, 'FAGE', '32 oz', 'B00WTR0CDM', 'https://www.amazon.com/gp/product/B00WTR0CDM', 'https://m.media-amazon.com/images/I/81aXh9dwshL._SL1500_.jpg', 6.96
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B00WTR0CDM');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Oikos Triple Zero Vanilla Greek Yogurt', 1, 'dairy', 'amazon-fresh', true, 'Oikos', '4 ct, 5.3 oz', 'B01ITHOI80', 'https://www.amazon.com/gp/product/B01ITHOI80', 'https://m.media-amazon.com/images/I/71vwCovK29L._SL1500_.jpg', 3.97
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B01ITHOI80');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Triple Cheddar Cheese Blend Shredded', 1, 'dairy', 'amazon-fresh', true, 'Amazon Grocery', '8 Oz', 'B0D64C5TH2', 'https://www.amazon.com/gp/product/B0D64C5TH2', 'https://m.media-amazon.com/images/I/71zWJxXdxFL._SL1500_.jpg', 1.97
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B0D64C5TH2');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT '365 Greek Yogurt Plain Nonfat', 1, 'dairy', 'amazon-fresh', true, '365 by Whole Foods', '32 oz', 'B0D7J7595Z', 'https://www.amazon.com/gp/product/B0D7J7595Z', 'https://m.media-amazon.com/images/I/719ojONESfL._SL1500_.jpg', 4.79
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B0D7J7595Z');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Vital Farms Pasture Raised Eggs Large', 1, 'dairy', 'amazon-fresh', true, 'Vital Farms', '18 Count', 'B01MZHDHVM', 'https://www.amazon.com/gp/product/B01MZHDHVM', 'https://m.media-amazon.com/images/I/61iXxZtV7vL._SL1000_.jpg', 10.99
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B01MZHDHVM');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Broccoli Crowns', 1, 'produce', 'amazon-fresh', true, 'Tanimura & Antle', '16 oz', 'B079D5RY71', 'https://www.amazon.com/gp/product/B079D5RY71', 'https://m.media-amazon.com/images/I/71SJEb4DMfL._SL1500_.jpg', 2.02
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B079D5RY71');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Asparagus', 1, 'produce', 'amazon-fresh', true, 'Fresh Produce', '1 Bunch', 'B00E3J9QSG', 'https://www.amazon.com/gp/product/B00E3J9QSG', 'https://m.media-amazon.com/images/I/71xbZj3wP2L._SL1500_.jpg', 3.57
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B00E3J9QSG');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Mini Cucumbers', 1, 'produce', 'amazon-fresh', true, 'Amazon Grocery', '16 Oz', 'B086WXSSQV', 'https://www.amazon.com/gp/product/B086WXSSQV', 'https://m.media-amazon.com/images/I/71QBIEu5sBL._SL1500_.jpg', 2.08
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B086WXSSQV');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Large Hass Avocado', 1, 'produce', 'amazon-fresh', true, 'Fresh Produce', '1 Each', 'B000P72UZG', 'https://www.amazon.com/gp/product/B000P72UZG', 'https://m.media-amazon.com/images/I/71K-NInNpKL._SL1500_.jpg', 1.65
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B000P72UZG');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Cherub Cherry Tomatoes', 1, 'produce', 'amazon-fresh', true, 'NatureSweet', '10 Oz', 'B07WNSHZVC', 'https://www.amazon.com/gp/product/B07WNSHZVC', 'https://m.media-amazon.com/images/I/81d4R7YHjfL._SL1500_.jpg', 2.57
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B07WNSHZVC');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Organic Blueberries', 1, 'produce', 'amazon-fresh', true, 'Fresh Produce', 'Pint', 'B077N7TR5G', 'https://www.amazon.com/gp/product/B077N7TR5G', 'https://m.media-amazon.com/images/I/71PK6BOLxCL._SL1500_.jpg', 5.96
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B077N7TR5G');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Organic Strawberries', 1, 'produce', 'amazon-fresh', true, 'Fresh Produce', '1 Lb', 'B002B8Z98W', 'https://www.amazon.com/gp/product/B002B8Z98W', 'https://m.media-amazon.com/images/I/81knc9-4RHL._SL1500_.jpg', 3.62
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B002B8Z98W');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Lemon', 1, 'produce', 'amazon-fresh', true, 'Fresh Produce', '1 Each', 'B001L1KRNC', 'https://www.amazon.com/gp/product/B001L1KRNC', 'https://m.media-amazon.com/images/I/71MckCseqVL._SL1500_.jpg', 0.64
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B001L1KRNC');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Yellow Nectarine', 1, 'produce', 'amazon-fresh', true, 'Fresh Produce', '1 Each', 'B000P6J1M2', 'https://www.amazon.com/gp/product/B000P6J1M2', 'https://m.media-amazon.com/images/I/71+KZkY3zvL._SL1500_.jpg', 0.97
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B000P6J1M2');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Chobani Blueberry Greek Yogurt', 1, 'dairy', 'amazon-fresh', true, 'Chobani', '5.3 oz', 'B002GVJZS4', 'https://www.amazon.com/gp/product/B002GVJZS4', 'https://m.media-amazon.com/images/I/71lHoVCq1QL._SL1500_.jpg', 1.00
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B002GVJZS4');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Navel Orange', 1, 'produce', 'amazon-fresh', true, 'Fresh Produce', '1 Each', 'B000SE9NUG', 'https://www.amazon.com/gp/product/B000SE9NUG', 'https://m.media-amazon.com/images/I/71ohLOFjl0L._SL1080_.jpg', 0.88
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B000SE9NUG');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Organic Honeycrisp Apple', 1, 'produce', 'amazon-fresh', true, 'Fresh Produce', '1 Each', 'B001GIP2A8', 'https://www.amazon.com/gp/product/B001GIP2A8', 'https://m.media-amazon.com/images/I/71mV3we6JIL._SL1500_.jpg', 1.57
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B001GIP2A8');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Granny Smith Organic Apple', 1, 'produce', 'amazon-fresh', true, 'Fresh Produce', '1 Each', 'B003TQA73M', 'https://www.amazon.com/gp/product/B003TQA73M', 'https://m.media-amazon.com/images/I/71BuUTVQU4L._SL1500_.jpg', 0.99
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B003TQA73M');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Daves Killer Bread White Bread Done Right', 1, 'bakery', 'amazon-fresh', true, 'Dave''s Killer Bread', '24 oz Loaf', 'B00UGBUZ1M', 'https://www.amazon.com/gp/product/B00UGBUZ1M', 'https://m.media-amazon.com/images/I/81cahQJxMiL._SL1500_.jpg', 5.97
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B00UGBUZ1M');
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, amazon_url, image_url, unit_price)
  SELECT 'Organic Banana Bunch', 1, 'produce', 'amazon-fresh', true, 'Dole', '4-5 Count', 'B07ZLF9G83', 'https://www.amazon.com/gp/product/B07ZLF9G83', 'https://m.media-amazon.com/images/I/71gI-IUNUkL._SL1500_.jpg', 1.49
  WHERE NOT EXISTS (SELECT 1 FROM grocery_staples WHERE amazon_asin = 'B07ZLF9G83');

COMMIT;
