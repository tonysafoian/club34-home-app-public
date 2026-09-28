CREATE TABLE IF NOT EXISTS energy_insight_investigations (
  finding_id text PRIMARY KEY,
  action_date date NOT NULL,
  investigated_at timestamp with time zone NOT NULL DEFAULT now(),
  investigated_by text,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

COMMENT ON TABLE energy_insight_investigations IS
  'Admin-recorded dates for energy finding investigations; records observations only and never controls equipment.';