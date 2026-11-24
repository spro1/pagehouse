-- Several app instances: Yjs updates one instance's room relays to the same room on the others (cluster.ts).
-- A room opening on any instance also applies these on top of the stored state, so nothing in flight is missed.
CREATE TABLE collab_updates (
  id BIGSERIAL PRIMARY KEY,
  page_id BIGINT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX collab_updates_page ON collab_updates (page_id, id);
-- The stored room state is now kept current by every save, so it's valid whenever present; drop stale ones.
UPDATE pages SET ydoc = NULL WHERE ydoc_version IS DISTINCT FROM version;
