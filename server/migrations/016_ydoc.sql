-- The live-editing room's Yjs state, so a restarted server resumes with the same document identity and
-- reconnecting editors merge cleanly. Only used while ydoc_version equals the page version.
ALTER TABLE pages ADD COLUMN ydoc BYTEA;
ALTER TABLE pages ADD COLUMN ydoc_version INT;
