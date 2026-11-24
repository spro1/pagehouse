-- Labels group pages across the tree ("meeting-notes", "runbook"); search filters by them.
CREATE TABLE page_labels (
  page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  PRIMARY KEY (page_id, label)
);
CREATE INDEX page_labels_label ON page_labels (label);
