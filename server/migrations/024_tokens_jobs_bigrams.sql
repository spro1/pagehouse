-- API tokens can expire. Tokens made before this version have none (NULL) and keep working until revoked.
ALTER TABLE api_tokens ADD COLUMN expires_at TIMESTAMPTZ;

-- Last single sign-on. An account that stops signing in through the provider (likely removed there) has its API tokens
-- stop after a grace period. NULL (never signed in by SSO since this version) is not checked.
ALTER TABLE users ADD COLUMN last_sso_at TIMESTAMPTZ;

-- 'oidc' marks a membership that sign-in copied from the provider's groups claim; sign-in only ever adds or removes
-- those. Memberships an admin made (NULL) are left alone.
ALTER TABLE group_members ADD COLUMN source TEXT;

-- Admin webhook deliveries waiting to be sent or retried, so a restart doesn't drop them.
-- Claiming a job pushes run_at forward (a lease): a job whose instance died is picked up again later.
CREATE TABLE webhook_jobs (
  id BIGSERIAL PRIMARY KEY,
  hook_id BIGINT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  body TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_jobs_due ON webhook_jobs (run_at) WHERE done_at IS NULL;

-- Korean words are often two syllables ("배포", "장애"), too short for pg_trgm's index, so such searches read every
-- page. Every pair of adjacent Hangul syllables goes into an indexed array; a search narrows by the pairs of its term
-- first, then checks the real text. Cut into Hangul runs first so long pages stay linear time.
CREATE FUNCTION hangul_bigrams(t text) RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT substr(w[1], i, 2)), '{}')
  FROM regexp_matches(t, '[가-힣]{2,}', 'g') AS w, generate_series(1, length(w[1]) - 1) AS i
$$;
ALTER TABLE pages ADD COLUMN grams text[] GENERATED ALWAYS AS (hangul_bigrams(title || ' ' || text)) STORED;
CREATE INDEX pages_grams ON pages USING gin (grams);
ALTER TABLE comments ADD COLUMN grams text[] GENERATED ALWAYS AS (hangul_bigrams(body)) STORED;
CREATE INDEX comments_grams ON comments USING gin (grams);
