-- Webhooks. Admins send page and comment events to other systems (signed JSON); each person can also have
-- their own notifications posted to a chat webhook (Slack, Mattermost, Teams, ...).
CREATE TABLE webhooks (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT[] NOT NULL,
  space_id BIGINT REFERENCES spaces(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at TIMESTAMPTZ,
  last_status INT,
  last_error TEXT
);

ALTER TABLE users ADD COLUMN webhook_url TEXT;
ALTER TABLE notifications ADD COLUMN hooked_at TIMESTAMPTZ;
UPDATE notifications SET hooked_at = now();
CREATE INDEX notifications_unhooked ON notifications (id) WHERE hooked_at IS NULL;
