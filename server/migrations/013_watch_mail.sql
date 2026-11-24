-- Watching a page: hear about edits by others (one unread "updated" notice per page at a time).
CREATE TABLE page_watches (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX page_watches_user ON page_watches (user_id);
-- Creators watch their pages.
INSERT INTO page_watches (user_id, page_id) SELECT created_by, id FROM pages ON CONFLICT DO NOTHING;

-- Email: unread notifications are mailed in one batch a few minutes after they arrive.
ALTER TABLE notifications ADD COLUMN emailed_at TIMESTAMPTZ;
UPDATE notifications SET emailed_at = now();
CREATE INDEX notifications_unmailed ON notifications (created_at) WHERE emailed_at IS NULL AND read_at IS NULL;
ALTER TABLE users ADD COLUMN email_notify BOOLEAN NOT NULL DEFAULT true;
