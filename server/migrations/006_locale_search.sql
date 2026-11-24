-- Interface language per account ('en', 'ko'); NULL until the user picks one.
ALTER TABLE users ADD COLUMN locale TEXT;

-- Search filters by author and sorts by recency within a space.
CREATE INDEX pages_space_updated ON pages (space_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX pages_updated_by ON pages (updated_by);
