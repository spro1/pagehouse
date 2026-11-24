-- A page with any rows here is restricted: only the listed users can reach it.
-- Restrictions inherit: to reach a page you must be listed on every restricted page above it too.
CREATE TABLE page_restrictions (
  page_id BIGINT NOT NULL REFERENCES pages(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('view', 'edit')),
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX page_restrictions_user ON page_restrictions (user_id);

-- 'edit', 'view' or NULL (no access) for one user on one page, ignoring admin rights.
-- Edit needs edit on every restricted page on the path; one view-only grant makes it view.
CREATE FUNCTION page_access(p_page BIGINT, p_user BIGINT) RETURNS TEXT LANGUAGE sql STABLE AS $$
  WITH RECURSIVE path(id, parent_id) AS (
    SELECT id, parent_id FROM pages WHERE id = p_page
    UNION ALL SELECT p.id, p.parent_id FROM pages p JOIN path ON p.id = path.parent_id
  ),
  restricted AS (SELECT DISTINCT r.page_id FROM page_restrictions r JOIN path ON r.page_id = path.id),
  mine AS (SELECT r.page_id, r.level FROM page_restrictions r JOIN path ON r.page_id = path.id WHERE r.user_id = p_user)
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM path) THEN NULL
    WHEN (SELECT count(*) FROM restricted) > (SELECT count(*) FROM mine) THEN NULL
    WHEN EXISTS (SELECT 1 FROM mine WHERE level = 'view') THEN 'view'
    ELSE 'edit'
  END
$$;
