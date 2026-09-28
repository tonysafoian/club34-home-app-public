-- Seed: 25 Club 34 grocery staples with ASINs and Amazon CDN images.
--
-- Idempotent via ON CONFLICT (amazon_asin) DO UPDATE — safe to re-run.
-- Requires 0024_grocery_helper_cycle.sql to have run first (amazon_asin column).
-- SELECT COUNT(*) FROM grocery_staples should return >= 25 after this runs.
--
-- NOTE: ASINs and image codes should be verified against the live Amazon catalog
-- before the first production order run. Update via:
--   UPDATE grocery_staples SET amazon_asin=..., image_url=... WHERE name=...;

INSERT INTO grocery_staples
  (name, default_quantity, category, platform, is_active, brand, size, amazon_asin, image_url)
VALUES
  -- Dairy & Eggs
  ('Organic Whole Milk', 2, 'dairy', 'amazon-fresh', true,
   'Horizon Organic', '1 gallon', 'B07MF6G41K',
   'https://m.media-amazon.com/images/I/71WY3bkq9DL._AC_SL300_.jpg'),

  ('Large Brown Eggs', 1, 'dairy', 'amazon-fresh', true,
   'Vital Farms', '12 count', 'B00JJC3FE2',
   'https://m.media-amazon.com/images/I/81fBk5XPJML._AC_SL300_.jpg'),

  ('Salted Butter', 2, 'dairy', 'amazon-fresh', true,
   'Kerrygold', '8 oz (2 sticks)', 'B001AO5VZW',
   'https://m.media-amazon.com/images/I/71K6H8Y5GkL._AC_SL300_.jpg'),

  ('Greek Yogurt Plain 0%', 2, 'dairy', 'amazon-fresh', true,
   'Fage Total', '32 oz', 'B005K2XHVO',
   'https://m.media-amazon.com/images/I/61ZjqKfCMSL._AC_SL300_.jpg'),

  ('Shredded Cheddar Cheese', 1, 'dairy', 'amazon-fresh', true,
   'Tillamook', '16 oz', 'B07C6BZDL8',
   'https://m.media-amazon.com/images/I/71I44I3HZXL._AC_SL300_.jpg'),

  -- Produce
  ('Baby Spinach', 1, 'produce', 'amazon-fresh', true,
   'Earthbound Farm', '5 oz', 'B00CHMN5G8',
   'https://m.media-amazon.com/images/I/71YRG1Ua53L._AC_SL300_.jpg'),

  ('Romaine Lettuce Hearts', 1, 'produce', 'amazon-fresh', true,
   'Earthbound Farm', '3 count', 'B00B3QPUG8',
   'https://m.media-amazon.com/images/I/61MhY5HCNKL._AC_SL300_.jpg'),

  ('Cherry Tomatoes', 2, 'produce', 'amazon-fresh', true,
   'Sunset', '1 pint', 'B00CML2G7Y',
   'https://m.media-amazon.com/images/I/81GEjGQlOUL._AC_SL300_.jpg'),

  ('Broccoli Crowns', 2, 'produce', 'amazon-fresh', true,
   NULL, '12 oz', 'B00Z8GRPOW',
   'https://m.media-amazon.com/images/I/71Ge2lRGSFL._AC_SL300_.jpg'),

  ('Avocados', 4, 'produce', 'amazon-fresh', true,
   NULL, '4 count', 'B07BHB5JNV',
   'https://m.media-amazon.com/images/I/61q8sE5FBPL._AC_SL300_.jpg'),

  ('Baby Carrots', 1, 'produce', 'amazon-fresh', true,
   'Bolthouse Farms', '2 lb bag', 'B000YZ6R3K',
   'https://m.media-amazon.com/images/I/61qDBOKzNFL._AC_SL300_.jpg'),

  ('Bananas', 1, 'produce', 'amazon-fresh', true,
   NULL, 'bunch (~3 lb)', 'B00Z8QHBNI',
   'https://m.media-amazon.com/images/I/61FhbhMaCPL._AC_SL300_.jpg'),

  ('Lemons', 1, 'produce', 'amazon-fresh', true,
   NULL, '2 lb bag', 'B07MKNMT8G',
   'https://m.media-amazon.com/images/I/51vkqRh9JlL._AC_SL300_.jpg'),

  ('Navel Oranges', 1, 'produce', 'amazon-fresh', true,
   NULL, '4 lb bag', 'B00YFKR7KE',
   'https://m.media-amazon.com/images/I/71Cr4b6t3nL._AC_SL300_.jpg'),

  -- Meat & Seafood
  ('Boneless Skinless Chicken Breast', 2, 'meat', 'amazon-fresh', true,
   'Bell & Evans', '~3 lb', 'B07MF6M1RS',
   'https://m.media-amazon.com/images/I/71YDJ6UkW8L._AC_SL300_.jpg'),

  ('Atlantic Salmon Fillets', 1, 'meat', 'amazon-fresh', true,
   NULL, '1 lb', 'B07P5XPR94',
   'https://m.media-amazon.com/images/I/71vmJ9o1FBL._AC_SL300_.jpg'),

  ('Ground Beef 80/20', 2, 'meat', 'amazon-fresh', true,
   NULL, '1 lb', 'B07K47QNHX',
   'https://m.media-amazon.com/images/I/61-+UyKELkL._AC_SL300_.jpg'),

  -- Bread & Grains
  ('Sourdough Bread', 1, 'bakery', 'amazon-fresh', true,
   'Dave''s Killer Bread', '27 oz loaf', 'B00J074W5A',
   'https://m.media-amazon.com/images/I/81nJkZ8gEL._AC_SL300_.jpg'),

  ('Spaghetti Pasta', 2, 'pantry', 'amazon-fresh', true,
   'Barilla', '16 oz', 'B00473DLXQ',
   'https://m.media-amazon.com/images/I/71RkAq73BFL._AC_SL300_.jpg'),

  ('Organic Quinoa', 1, 'pantry', 'amazon-fresh', true,
   'Ancient Harvest', '12 oz', 'B001E0JKHI',
   'https://m.media-amazon.com/images/I/81x63WEyj7L._AC_SL300_.jpg'),

  -- Pantry & Oils
  ('Extra Virgin Olive Oil', 1, 'pantry', 'amazon-fresh', true,
   'California Olive Ranch', '16.9 fl oz', 'B01N5IQ3H8',
   'https://m.media-amazon.com/images/I/71S0P7VNWZL._AC_SL300_.jpg'),

  ('Almond Butter', 1, 'pantry', 'amazon-fresh', true,
   'Justin''s', '16 oz', 'B00KBDL2YE',
   'https://m.media-amazon.com/images/I/71hJJbgUUVL._AC_SL300_.jpg'),

  ('Raw Honey', 1, 'pantry', 'amazon-fresh', true,
   'Nature Nate''s', '16 oz', 'B00DS842HS',
   'https://m.media-amazon.com/images/I/81fBvJqU2nL._AC_SL300_.jpg'),

  -- Beverages
  ('Sparkling Water', 2, 'beverages', 'amazon-fresh', true,
   'Topo Chico', '12 x 12 fl oz', 'B07D2YGQHB',
   'https://m.media-amazon.com/images/I/71Yf5hP79kL._AC_SL300_.jpg'),

  -- Household
  ('Dish Soap', 1, 'household', 'amazon-fresh', true,
   'Mrs. Meyer''s Clean Day', '16 fl oz', 'B01MUGZM15',
   'https://m.media-amazon.com/images/I/71mZ5BFVIOL._AC_SL300_.jpg')

ON CONFLICT (amazon_asin) WHERE amazon_asin IS NOT NULL DO UPDATE SET
  name          = EXCLUDED.name,
  brand         = EXCLUDED.brand,
  size          = EXCLUDED.size,
  image_url     = EXCLUDED.image_url,
  category      = EXCLUDED.category,
  updated_at    = NOW();
