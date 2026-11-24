-- The selected text an inline comment was made on; the page doc marks the same range with the comment id.
ALTER TABLE comments ADD COLUMN quote TEXT;
