-- The provider's stable id (the OIDC "sub" claim) of the person an account belongs to. Sign-in finds the account by it,
-- so a changed email at the provider still reaches the same account. NULL until the next SSO sign-in links it by email.
ALTER TABLE users ADD COLUMN oidc_sub TEXT UNIQUE;
