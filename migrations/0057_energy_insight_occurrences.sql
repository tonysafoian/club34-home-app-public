ALTER TABLE energy_insight_investigations
  ADD COLUMN IF NOT EXISTS occurrence_id text,
  ADD COLUMN IF NOT EXISTS finding_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS scope_type text NOT NULL DEFAULT 'property',
  ADD COLUMN IF NOT EXISTS scope_label text NOT NULL DEFAULT 'Whole property',
  ADD COLUMN IF NOT EXISTS scope_entity_ids text[] NOT NULL DEFAULT '{}';

UPDATE energy_insight_investigations
SET occurrence_id = finding_id || ':legacy'
WHERE occurrence_id IS NULL;

ALTER TABLE energy_insight_investigations
  ALTER COLUMN occurrence_id SET NOT NULL;

ALTER TABLE energy_insight_investigations
  DROP CONSTRAINT IF EXISTS energy_insight_investigations_pkey;

ALTER TABLE energy_insight_investigations
  ADD CONSTRAINT energy_insight_investigations_pkey PRIMARY KEY (occurrence_id);

CREATE INDEX IF NOT EXISTS energy_insight_investigations_finding_id_idx
  ON energy_insight_investigations (finding_id);