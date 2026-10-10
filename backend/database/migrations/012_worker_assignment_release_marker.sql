/* Keep a durable distinction between a paused worker interval and an explicit unassignment. */
ALTER TABLE production.job_worker_assignments
    ADD COLUMN unassigned_at timestamptz;

CREATE INDEX ix_job_worker_assignment_available
    ON production.job_worker_assignments(worker_id, machine_assignment_id)
    WHERE unassigned_at IS NULL;
