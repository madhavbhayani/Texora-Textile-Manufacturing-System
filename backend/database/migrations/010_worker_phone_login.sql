/* Permit provisioned workers to use a phone number as their login identifier. */
ALTER TABLE auth.users
    ALTER COLUMN email DROP NOT NULL,
    DROP CONSTRAINT IF EXISTS users_email_check;

ALTER TABLE auth.users
    ADD CONSTRAINT ck_auth_users_email_format
    CHECK (email IS NULL OR email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$');
