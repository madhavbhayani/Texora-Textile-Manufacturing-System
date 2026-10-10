/* Job planning notes are no longer part of the production job record. */
ALTER TABLE production.jobs
    DROP COLUMN IF EXISTS notes;
