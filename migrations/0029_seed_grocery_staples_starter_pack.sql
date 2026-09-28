-- Seed: 12 new Club 34 grocery staples across pantry, beverages, snacks, frozen, and household.
--
-- Idempotent via WHERE NOT EXISTS (matching on name + brand).
-- For rows with NULL brand the WHERE clause uses "brand IS NULL".
-- ASINs and image_url are intentionally left NULL — Stagehand resolves these
-- later, or Tony fills them via the CatalogManager UI.
--
-- Requires 0026_align_grocery_staples_schema.sql to have run first (size, unit_price, image_url).
-- SELECT COUNT(*) FROM grocery_staples WHERE is_active = true should return >= 37 after this runs.
--
-- Category breakdown for new rows: meat=2, pantry=2, beverages=2, snacks=1, frozen=1, household=4.
-- Items: Boneless Skinless Chicken Thighs (Bell & Evans), Ground Beef 85/15,
--        Canned Diced Tomatoes (Muir Glen), Penne Pasta (De Cecco),
--        Coconut Water (Vita Coco), Almond Milk Unsweetened (Califia Farms),
--        Hummus Classic (Sabra), Frozen Mixed Berries,
--        Paper Towels (Bounty), Toilet Paper (Charmin Ultra Soft),
--        Dish Soap (Dawn Ultra), Trash Bags 13 gal (Hefty).

-- meat: Boneless Skinless Chicken Thighs (Bell & Evans, ~2 lb)
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, image_url, unit_price)
SELECT 'Boneless Skinless Chicken Thighs', 1, 'meat', 'amazon-fresh', true, 'Bell & Evans', '~2 lb', NULL, NULL, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM grocery_staples WHERE name = 'Boneless Skinless Chicken Thighs' AND brand = 'Bell & Evans'
);

-- meat: Ground Beef 85/15 (NULL brand, 1 lb)
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, image_url, unit_price)
SELECT 'Ground Beef 85/15', 1, 'meat', 'amazon-fresh', true, NULL, '1 lb', NULL, NULL, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM grocery_staples WHERE name = 'Ground Beef 85/15' AND brand IS NULL
);

-- pantry: Canned Diced Tomatoes (Muir Glen, 14.5 oz)
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, image_url, unit_price)
SELECT 'Canned Diced Tomatoes', 3, 'pantry', 'amazon-fresh', true, 'Muir Glen', '14.5 oz', NULL, NULL, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM grocery_staples WHERE name = 'Canned Diced Tomatoes' AND brand = 'Muir Glen'
);

-- pantry: Penne Pasta (De Cecco, 1 lb box)
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, image_url, unit_price)
SELECT 'Penne Pasta', 2, 'pantry', 'amazon-fresh', true, 'De Cecco', '1 lb box', NULL, NULL, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM grocery_staples WHERE name = 'Penne Pasta' AND brand = 'De Cecco'
);

-- beverages: Coconut Water (Vita Coco, 11.1 oz 12-pack)
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, image_url, unit_price)
SELECT 'Coconut Water', 1, 'beverages', 'amazon-fresh', true, 'Vita Coco', '11.1 oz 12-pack', NULL, NULL, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM grocery_staples WHERE name = 'Coconut Water' AND brand = 'Vita Coco'
);

-- beverages: Almond Milk Unsweetened (Califia Farms, 48 oz)
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, image_url, unit_price)
SELECT 'Almond Milk Unsweetened', 2, 'beverages', 'amazon-fresh', true, 'Califia Farms', '48 oz', NULL, NULL, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM grocery_staples WHERE name = 'Almond Milk Unsweetened' AND brand = 'Califia Farms'
);

-- snacks: Hummus Classic (Sabra, 10 oz)
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, image_url, unit_price)
SELECT 'Hummus Classic', 1, 'snacks', 'amazon-fresh', true, 'Sabra', '10 oz', NULL, NULL, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM grocery_staples WHERE name = 'Hummus Classic' AND brand = 'Sabra'
);

-- frozen: Frozen Mixed Berries (NULL brand, 16 oz bag)
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, image_url, unit_price)
SELECT 'Frozen Mixed Berries', 2, 'frozen', 'amazon-fresh', true, NULL, '16 oz bag', NULL, NULL, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM grocery_staples WHERE name = 'Frozen Mixed Berries' AND brand IS NULL
);

-- household: Paper Towels (Bounty, 6 mega rolls)
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, image_url, unit_price)
SELECT 'Paper Towels', 1, 'household', 'amazon-fresh', true, 'Bounty', '6 mega rolls', NULL, NULL, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM grocery_staples WHERE name = 'Paper Towels' AND brand = 'Bounty'
);

-- household: Toilet Paper (Charmin Ultra Soft, 12 mega rolls)
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, image_url, unit_price)
SELECT 'Toilet Paper', 1, 'household', 'amazon-fresh', true, 'Charmin Ultra Soft', '12 mega rolls', NULL, NULL, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM grocery_staples WHERE name = 'Toilet Paper' AND brand = 'Charmin Ultra Soft'
);

-- household: Dish Soap (Dawn Ultra, 28 oz)
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, image_url, unit_price)
SELECT 'Dish Soap', 1, 'household', 'amazon-fresh', true, 'Dawn Ultra', '28 oz', NULL, NULL, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM grocery_staples WHERE name = 'Dish Soap' AND brand = 'Dawn Ultra'
);

-- household: Trash Bags 13 gal (Hefty, 80 ct kitchen drawstring)
INSERT INTO grocery_staples (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, image_url, unit_price)
SELECT 'Trash Bags 13 gal', 1, 'household', 'amazon-fresh', true, 'Hefty', '80 ct kitchen drawstring', NULL, NULL, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM grocery_staples WHERE name = 'Trash Bags 13 gal' AND brand = 'Hefty'
);
