-- Accounts (users, sessions, groups) can be shared with Taskhouse in one database: see prepare() in db.ts.
-- Taskhouse writes SSO-only accounts without a password, and reads last_login_at for its API tokens.
-- From here on, changes to these four tables use IF NOT EXISTS: the other product may have made them already.
ALTER TABLE users ALTER COLUMN password_hash SET DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
