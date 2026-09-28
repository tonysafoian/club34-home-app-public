-- Remove Topo Chico Sparkling Water from grocery_staples.
-- Seeded in 0025_seed_grocery_staples.sql; user requested removal from
-- the Beverages section of the grocery page.
--
-- Hard delete is safe: this row is a catalog entry, not a transactional
-- record. Any prior cart/run items that referenced it via staple_id are
-- already copied into grocery_order_items as their own rows.

DELETE FROM grocery_staples
WHERE name = 'Sparkling Water'
  AND brand = 'Topo Chico';
