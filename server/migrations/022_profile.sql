-- Profile photos (content-addressed like attachments) and admin-issued temporary passwords.
ALTER TABLE users ADD COLUMN avatar TEXT;
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;
