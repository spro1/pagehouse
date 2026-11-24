-- Favorite pages, shown at the top of each person's sidebar.
CREATE TABLE page_stars (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, page_id)
);
