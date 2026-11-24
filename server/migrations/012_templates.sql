-- Templates people save from pages. space_id NULL: offered in every space (site admins only).
CREATE TABLE templates (
  id BIGSERIAL PRIMARY KEY,
  space_id BIGINT REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '📄',
  title TEXT NOT NULL,
  doc JSONB NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX templates_space ON templates (space_id) WHERE deleted_at IS NULL;
