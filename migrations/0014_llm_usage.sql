-- Per-completion LLM usage capture so we can finally answer "Janus cost
-- this week, by user / channel / model / tier" instead of guessing.
--
-- Schema designed for the common slice-and-dice queries the admin
-- endpoint exposes. cost_usd is nullable because OpenRouter only
-- returns it for providers that support it (most do, but some
-- summarize / free-tier paths come back without). Storing NULL is
-- preferred over making up a number — cost reconciliation against a
-- price table is a follow-up.

CREATE TABLE IF NOT EXISTS janus_llm_usage (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  user_id           text,
  channel           text,           -- 'chat' | 'whatsapp' | 'email' | 'cron' | 'external'
  model             text NOT NULL,
  tier              text,           -- 'simple' | 'default' | 'complex' | 'summarize'
  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer,
  cost_usd          numeric(10, 6), -- 6 decimals for sub-cent precision
  correlation_id    text,
  duration_ms       integer,
  request_type      text            -- 'chat' | 'tool_round' | 'summarize' | 'research'
);

CREATE INDEX IF NOT EXISTS llm_usage_created_idx
  ON janus_llm_usage (created_at);
CREATE INDEX IF NOT EXISTS llm_usage_user_idx
  ON janus_llm_usage (user_id, created_at);
CREATE INDEX IF NOT EXISTS llm_usage_correlation_idx
  ON janus_llm_usage (correlation_id) WHERE correlation_id IS NOT NULL;
