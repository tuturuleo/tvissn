CREATE TABLE IF NOT EXISTS tvissn_state (
  id integer PRIMARY KEY CHECK (id=1),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tvissn_state ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies: only backend DB credentials may access state.
