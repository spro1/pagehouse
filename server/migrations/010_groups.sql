-- Groups: grant space roles and page restrictions to many people at once.
CREATE TABLE groups (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE group_members (
  group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members (user_id);

-- A grant row names either one user or one group. Group grants have no ON DELETE CASCADE on purpose:
-- dropping a group's row from a restriction would open the page to everyone, so a group in use can't be deleted.
ALTER TABLE page_restrictions DROP CONSTRAINT page_restrictions_pkey;
ALTER TABLE page_restrictions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE page_restrictions ADD COLUMN group_id BIGINT REFERENCES groups(id);
ALTER TABLE page_restrictions ADD CONSTRAINT page_restrictions_who CHECK ((user_id IS NULL) <> (group_id IS NULL));
CREATE UNIQUE INDEX page_restrictions_user_key ON page_restrictions (page_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX page_restrictions_group_key ON page_restrictions (page_id, group_id) WHERE group_id IS NOT NULL;
CREATE INDEX page_restrictions_page ON page_restrictions (page_id);

ALTER TABLE space_members DROP CONSTRAINT space_members_pkey;
ALTER TABLE space_members ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE space_members ADD COLUMN group_id BIGINT REFERENCES groups(id);
ALTER TABLE space_members ADD CONSTRAINT space_members_who CHECK ((user_id IS NULL) <> (group_id IS NULL));
CREATE UNIQUE INDEX space_members_user_key ON space_members (space_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX space_members_group_key ON space_members (space_id, group_id) WHERE group_id IS NOT NULL;

-- Grant rows that apply to a user: their own, plus those of every group they're in.
CREATE FUNCTION my_groups(p_user BIGINT) RETURNS SETOF BIGINT LANGUAGE sql STABLE AS $$
  SELECT group_id FROM group_members WHERE user_id = p_user
$$;

-- A personal membership wins (so one person can be limited below their group); otherwise the best group role;
-- otherwise the space default.
CREATE OR REPLACE FUNCTION space_access(p_space BIGINT, p_user BIGINT) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT role FROM space_members WHERE space_id = p_space AND user_id = p_user),
    (SELECT role FROM space_members WHERE space_id = p_space AND group_id IN (SELECT my_groups(p_user))
     ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'edit' THEN 1 ELSE 2 END LIMIT 1),
    (SELECT nullif(default_access, 'none') FROM spaces WHERE id = p_space)
  )
$$;

-- Every restricted page on the path must grant the user (directly or through a group);
-- edit needs an edit grant on each of them.
CREATE OR REPLACE FUNCTION page_access(p_page BIGINT, p_user BIGINT) RETURNS TEXT LANGUAGE sql STABLE AS $$
  WITH RECURSIVE path(id, parent_id) AS (
    SELECT id, parent_id FROM pages WHERE id = p_page
    UNION ALL SELECT p.id, p.parent_id FROM pages p JOIN path ON p.id = path.parent_id
  ),
  restricted AS (SELECT DISTINCT r.page_id FROM page_restrictions r JOIN path ON r.page_id = path.id),
  mine AS (
    SELECT r.page_id, bool_or(r.level = 'edit') AS can_edit FROM page_restrictions r JOIN path ON r.page_id = path.id
    WHERE r.user_id = p_user OR r.group_id IN (SELECT my_groups(p_user)) GROUP BY r.page_id
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM path) THEN NULL
    WHEN (SELECT count(*) FROM restricted) > (SELECT count(*) FROM mine) THEN NULL
    WHEN EXISTS (SELECT 1 FROM mine WHERE NOT can_edit) THEN 'view'
    ELSE 'edit'
  END
$$;

CREATE OR REPLACE FUNCTION hidden_pages(p_user BIGINT) RETURNS TABLE (id BIGINT) LANGUAGE sql STABLE ROWS 20 AS $$
  WITH RECURSIVE g AS (SELECT my_groups(p_user) AS id),
  blocked(id) AS (
    SELECT r.page_id FROM page_restrictions r GROUP BY r.page_id
    HAVING NOT bool_or(r.user_id IS NOT DISTINCT FROM p_user OR coalesce(r.group_id IN (SELECT id FROM g), false))
    UNION
    SELECT p.id FROM pages p JOIN blocked b ON p.parent_id = b.id
  )
  SELECT id FROM blocked
  UNION
  SELECT p.id FROM pages p WHERE p.space_id IN (SELECT s.id FROM spaces s WHERE space_access(s.id, p_user) IS NULL)
$$;
