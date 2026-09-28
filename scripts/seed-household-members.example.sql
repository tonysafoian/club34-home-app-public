-- Example Seed Script: Household Members
--
-- Populates default household members and invited emails.

INSERT INTO household_members (display_name, email, whatsapp_number, role, is_active, aliases)
VALUES
  ('Admin User',     'admin@example.com',  '15550100', 'admin',  true, ARRAY['Admin']),
  ('Family Member',  'member@example.com', '15550101', 'member', true, ARRAY['Family'])
ON CONFLICT DO NOTHING;

INSERT INTO invited_emails (email, invited_by, phone_number)
VALUES
  ('admin@example.com',  'system', '15550100'),
  ('member@example.com', 'system', '15550101')
ON CONFLICT DO NOTHING;
