CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE spaces (
  id BIGSERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pages (
  id BIGSERIAL PRIMARY KEY,
  space_id BIGINT NOT NULL REFERENCES spaces(id),
  parent_id BIGINT REFERENCES pages(id),
  kind TEXT NOT NULL DEFAULT 'page',
  title TEXT NOT NULL,
  doc JSONB NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  version INT NOT NULL DEFAULT 1,
  position DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_by BIGINT NOT NULL REFERENCES users(id),
  updated_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX pages_tree ON pages (space_id, parent_id, position);
CREATE INDEX pages_title_trgm ON pages USING gin (title gin_trgm_ops);
CREATE INDEX pages_text_trgm ON pages USING gin (text gin_trgm_ops);

CREATE TABLE page_versions (
  id BIGSERIAL PRIMARY KEY,
  page_id BIGINT NOT NULL REFERENCES pages(id),
  version INT NOT NULL,
  title TEXT NOT NULL,
  doc JSONB NOT NULL,
  author_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX page_versions_page ON page_versions (page_id, id);

CREATE TABLE attachments (
  id BIGSERIAL PRIMARY KEY,
  page_id BIGINT NOT NULL REFERENCES pages(id),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
