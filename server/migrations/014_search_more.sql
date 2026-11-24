-- Searching comments and attachment names.
CREATE INDEX comments_body_trgm ON comments USING gin (body gin_trgm_ops);
CREATE INDEX attachments_name_trgm ON attachments USING gin (name gin_trgm_ops);
CREATE INDEX attachments_page ON attachments (page_id);
