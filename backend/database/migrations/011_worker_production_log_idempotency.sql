/* Request-level idempotency protects worker output from browser/network retries. */
ALTER TABLE production.production_logs
    ADD COLUMN client_request_id uuid;

CREATE UNIQUE INDEX ux_production_logs_worker_request
    ON production.production_logs(worker_id, client_request_id);
