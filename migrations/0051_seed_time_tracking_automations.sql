-- Seed family_automations rows for the three Club34 Time Tracking crons so
-- they appear in the Automations UI with a pause/resume (vacation) toggle.
INSERT INTO family_automations (name, automation_type, schedule, is_active, description)
SELECT v.name, v.automation_type, v.schedule, true, v.description
FROM (VALUES
  ('Time Worker Daily Digest', 'time-worker-digest', '0 18 * * 1-6',
   'Emails workers whose time entries were approved or rejected that day (6 PM PT Mon-Sat)'),
  ('Time Admin Pending Digest', 'time-admin-pending-digest', '0 7 * * 1-6',
   'Emails admins a summary of workers with pending time entries awaiting approval (7 AM PT Mon-Sat)'),
  ('Time Weekly Close-Out', 'time-weekly-closeout', '0 7 * * 1',
   'Emails admins last week''s hours, ready-to-pay and still-pending totals (Mon 7 AM PT)')
) AS v(name, automation_type, schedule, description)
WHERE NOT EXISTS (
  SELECT 1 FROM family_automations fa WHERE fa.name = v.name
);
