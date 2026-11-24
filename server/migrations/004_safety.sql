-- Comments are hidden, never erased, so a delete can be undone.
ALTER TABLE comments ADD COLUMN deleted_at TIMESTAMPTZ;

-- Every page gets a first history entry holding its current content,
-- so the state before the next edit is always recoverable (pages created before this had none).
INSERT INTO page_versions (page_id, version, title, doc, author_id, created_at)
SELECT p.id, p.version, p.title, p.doc, p.updated_by, p.updated_at
FROM pages p
WHERE NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.page_id = p.id);
