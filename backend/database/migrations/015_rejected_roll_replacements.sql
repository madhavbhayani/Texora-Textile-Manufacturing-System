/* Track rejected-roll replacement requests and tie replacement output and
   material issues back to the specific rejected roll and its original job. */
BEGIN;

CREATE SEQUENCE IF NOT EXISTS production.seq_replacement_request_no START 1;

CREATE TABLE IF NOT EXISTS production.replacement_material_requests (
    replacement_request_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_no text NOT NULL UNIQUE DEFAULT core.fmt_doc('RMR', nextval('production.seq_replacement_request_no')),
    job_id bigint NOT NULL REFERENCES production.jobs(job_id),
    rejected_roll_id bigint NOT NULL UNIQUE REFERENCES production.rolls(roll_id),
    requested_by bigint NOT NULL REFERENCES auth.users(user_id),
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ISSUED','PRODUCED','COMPLETED')),
    material_issue_id bigint UNIQUE REFERENCES inventory.material_issues(material_issue_id),
    requested_at timestamptz NOT NULL DEFAULT now(),
    approved_by bigint REFERENCES auth.users(user_id),
    approved_at timestamptz,
    produced_at timestamptz,
    completed_at timestamptz,
    CHECK ((status = 'PENDING' AND approved_by IS NULL AND material_issue_id IS NULL)
        OR (status <> 'PENDING' AND approved_by IS NOT NULL AND material_issue_id IS NOT NULL)),
    CHECK ((status IN ('PRODUCED','COMPLETED')) = (produced_at IS NOT NULL)),
    CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_replacement_requests_status ON production.replacement_material_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS ix_replacement_requests_job ON production.replacement_material_requests(job_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS production.replacement_material_request_items (
    replacement_request_id bigint NOT NULL REFERENCES production.replacement_material_requests(replacement_request_id),
    yarn_type_id bigint NOT NULL REFERENCES master.yarn_types(yarn_type_id),
    required_kg numeric(12,3) NOT NULL CHECK (required_kg > 0),
    PRIMARY KEY (replacement_request_id, yarn_type_id)
);

ALTER TABLE production.machine_assignments
    ADD COLUMN IF NOT EXISTS replacement_request_id bigint REFERENCES production.replacement_material_requests(replacement_request_id);
ALTER TABLE production.production_logs
    ADD COLUMN IF NOT EXISTS replacement_request_id bigint REFERENCES production.replacement_material_requests(replacement_request_id);
ALTER TABLE production.rolls
    ADD COLUMN IF NOT EXISTS replacement_request_id bigint REFERENCES production.replacement_material_requests(replacement_request_id);
ALTER TABLE inventory.material_issues
    ADD COLUMN IF NOT EXISTS replacement_request_id bigint UNIQUE REFERENCES production.replacement_material_requests(replacement_request_id);

CREATE INDEX IF NOT EXISTS ix_machine_assignment_replacement_request
    ON production.machine_assignments(replacement_request_id) WHERE replacement_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_production_logs_replacement_request
    ON production.production_logs(replacement_request_id) WHERE replacement_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_rolls_replacement_request
    ON production.rolls(replacement_request_id) WHERE replacement_request_id IS NOT NULL;

/* Queue previously rejected rolls too, so deploying this workflow does not
   strand rejections that were recorded before the migration. */
INSERT INTO production.replacement_material_requests(job_id,rejected_roll_id,requested_by)
SELECT r.job_id,r.roll_id,inspection.inspected_by
FROM production.rolls r
JOIN LATERAL(SELECT inspected_by FROM quality.inspections qi WHERE qi.roll_id=r.roll_id ORDER BY qi.inspected_at DESC,qi.inspection_id DESC LIMIT 1) inspection ON true
WHERE r.current_status='REJECTED'
ON CONFLICT (rejected_roll_id) DO NOTHING;

INSERT INTO production.replacement_material_request_items(replacement_request_id,yarn_type_id,required_kg)
SELECT q.replacement_request_id,fb.yarn_type_id,
       ROUND(GREATEST(r.length_meters*fb.kg_per_meter*(1+fb.wastage_percent/100),0.001),3)
FROM production.replacement_material_requests q
JOIN production.rolls r ON r.roll_id=q.rejected_roll_id
JOIN production.jobs j ON j.job_id=q.job_id
JOIN sales.order_items oi ON oi.order_item_id=j.order_item_id
JOIN master.fabric_bom fb ON fb.fabric_type_id=oi.fabric_type_id
JOIN master.yarn_types yt ON yt.yarn_type_id=fb.yarn_type_id AND yt.is_active
ON CONFLICT (replacement_request_id,yarn_type_id) DO NOTHING;

SELECT notification.notify_role('STORE_MANAGER','STOCK','Rejected-roll replacement materials pending',
       'A rejected fabric roll has a replacement material request awaiting approval.','REPLACEMENT_REQUEST',q.replacement_request_id)
FROM production.replacement_material_requests q
WHERE q.status='PENDING';

COMMIT;
