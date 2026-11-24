-- Space permissions -----------------------------------------------------------------------------
-- default_access: what everyone who is not a member gets. 'none' makes the space private.
ALTER TABLE spaces ADD COLUMN default_access TEXT NOT NULL DEFAULT 'edit' CHECK (default_access IN ('edit', 'view', 'none'));
ALTER TABLE spaces ADD COLUMN created_by BIGINT REFERENCES users(id);

CREATE TABLE space_members (
  space_id BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'edit', 'view')),
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX space_members_user ON space_members (user_id);

-- 'admin' | 'edit' | 'view' | NULL (no access) for one user in one space, ignoring site admin rights.
-- A membership always wins over the default, so a member can also be limited to view in an open space.
CREATE FUNCTION space_access(p_space BIGINT, p_user BIGINT) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT role FROM space_members WHERE space_id = p_space AND user_id = p_user),
    (SELECT nullif(default_access, 'none') FROM spaces WHERE id = p_space)
  )
$$;

-- Pages hidden from a user: restricted pages they're not listed on (and everything under them),
-- plus every page in a space they can't enter.
CREATE OR REPLACE FUNCTION hidden_pages(p_user BIGINT) RETURNS TABLE (id BIGINT) LANGUAGE sql STABLE ROWS 20 AS $$
  WITH RECURSIVE blocked(id) AS (
    SELECT r.page_id FROM page_restrictions r GROUP BY r.page_id HAVING NOT bool_or(r.user_id = p_user)
    UNION
    SELECT p.id FROM pages p JOIN blocked b ON p.parent_id = b.id
  )
  SELECT id FROM blocked
  UNION
  SELECT p.id FROM pages p WHERE p.space_id IN (SELECT s.id FROM spaces s WHERE space_access(s.id, p_user) IS NULL)
$$;

-- Home and notifications ------------------------------------------------------------------------
CREATE TABLE page_views (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, page_id)
);
CREATE INDEX page_views_recent ON page_views (user_id, viewed_at DESC);
CREATE INDEX pages_created ON pages (created_at DESC) WHERE deleted_at IS NULL;

-- kind: mention (in a page), comment_mention, reply (to my comment), comment (on a page I created)
CREATE TABLE notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  actor_id BIGINT REFERENCES users(id),
  page_id BIGINT REFERENCES pages(id) ON DELETE CASCADE,
  comment_id BIGINT REFERENCES comments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX notifications_user ON notifications (user_id, id DESC);
CREATE INDEX notifications_unread ON notifications (user_id) WHERE read_at IS NULL;

-- Interface theme per account: 'system' (default), 'light', 'dark'.
ALTER TABLE users ADD COLUMN theme TEXT;
