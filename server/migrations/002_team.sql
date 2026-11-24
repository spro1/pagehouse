ALTER TABLE users ADD COLUMN disabled_at TIMESTAMPTZ;

-- One-time links: purpose 'invite' creates an account with role; 'reset' sets a new password for user_id.
CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL DEFAULT 'invite',
  role TEXT NOT NULL DEFAULT 'member',
  user_id BIGINT REFERENCES users(id),
  created_by BIGINT NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  used_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE comments (
  id BIGSERIAL PRIMARY KEY,
  page_id BIGINT NOT NULL REFERENCES pages(id),
  parent_id BIGINT REFERENCES comments(id) ON DELETE CASCADE,
  author_id BIGINT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX comments_page ON comments (page_id, id);

CREATE INDEX pages_recent ON pages (updated_at DESC) WHERE deleted_at IS NULL;
