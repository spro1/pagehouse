-- Who did what to accounts, permissions, pages and settings, for admins to review.
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_id BIGINT,
  ok BOOLEAN NOT NULL,
  ip TEXT NOT NULL,
  detail JSONB
);
CREATE INDEX audit_log_actor ON audit_log (actor_id, id DESC);
CREATE INDEX audit_log_action ON audit_log (action, id DESC);
