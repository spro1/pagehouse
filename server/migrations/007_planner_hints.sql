-- hidden_pages() usually returns a handful of rows. Without this hint Postgres guesses thousands,
-- and then prefers a full table scan over the trigram indexes for search (44 ms vs 0.6 ms at 3,000 pages).
ALTER FUNCTION hidden_pages(BIGINT) ROWS 20;
