-- Pin the three RainBird irrigation controllers into the Smart Sprinklers category.
--
-- Two devices share the RainBird OUI (14:33:5c) and will auto-classify via the
-- updated OUI_MAP, but we pin all three explicitly so they are immune to
-- hostname/vendor-string changes and so the third device (ac:15:18 OUI,
-- non-RainBird vendor prefix) always lands in the correct group.

INSERT INTO device_overrides (mac, custom_name, custom_category, custom_subcategory, original_hostname, updated_at)
VALUES
  ('14:33:5c:ec:57:5c', 'RainBird', 'Smart Sprinklers', 'Smart Sprinklers', 'RainBird', NOW()),
  ('14:33:5c:ec:6c:f0', 'RainBird', 'Smart Sprinklers', 'Smart Sprinklers', 'RainBird', NOW()),
  ('ac:15:18:c7:31:b4', 'RainBird', 'Smart Sprinklers', 'Smart Sprinklers', 'RainBird', NOW())
ON CONFLICT (mac) DO UPDATE
  SET custom_category    = EXCLUDED.custom_category,
      custom_subcategory = EXCLUDED.custom_subcategory,
      custom_name        = EXCLUDED.custom_name,
      updated_at         = NOW();
