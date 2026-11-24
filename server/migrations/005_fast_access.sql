-- Pages a user may not see: restricted pages that don't list them, plus everything under those.
-- Computed once per query as a set, instead of walking each page's ancestors one by one.
CREATE FUNCTION hidden_pages(p_user BIGINT) RETURNS TABLE (id BIGINT) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE blocked(id) AS (
    SELECT r.page_id FROM page_restrictions r GROUP BY r.page_id HAVING NOT bool_or(r.user_id = p_user)
    UNION
    SELECT p.id FROM pages p JOIN blocked b ON p.parent_id = b.id
  )
  SELECT id FROM blocked
$$;

-- Child lookups (the recursion above, subtree deletes and restores) by parent alone.
CREATE INDEX pages_parent ON pages (parent_id);
CREATE INDEX comments_parent ON comments (parent_id);
