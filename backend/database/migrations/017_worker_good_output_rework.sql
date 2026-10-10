BEGIN;

/* Production log output is gross metres. Good metres exclude logged waste. */
ALTER TABLE production.production_logs
    ADD COLUMN IF NOT EXISTS good_meters numeric(12,2)
    GENERATED ALWAYS AS (GREATEST(produced_meters - waste_meters, 0)) STORED;

ALTER TABLE production.production_logs
    DROP CONSTRAINT IF EXISTS ck_production_log_waste_not_over_output;
ALTER TABLE production.production_logs
    ADD CONSTRAINT ck_production_log_waste_not_over_output
    CHECK (waste_meters <= produced_meters) NOT VALID;

/* A rework assignment owns an explicit set of existing rolls. Rework logs
   allocate good metres back to those rolls instead of creating duplicate rolls. */
CREATE TABLE IF NOT EXISTS production.machine_assignment_rework_rolls (
    machine_assignment_id bigint NOT NULL REFERENCES production.machine_assignments(machine_assignment_id),
    roll_id               bigint NOT NULL REFERENCES production.rolls(roll_id),
    source_inspection_id  bigint NOT NULL REFERENCES quality.inspections(inspection_id),
    assigned_by           bigint NOT NULL REFERENCES auth.users(user_id),
    assigned_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (machine_assignment_id, roll_id)
);
CREATE INDEX IF NOT EXISTS ix_assignment_rework_roll_roll
    ON production.machine_assignment_rework_rolls(roll_id, source_inspection_id);

CREATE TABLE IF NOT EXISTS production.rework_roll_log_allocations (
    production_log_id bigint NOT NULL REFERENCES production.production_logs(production_log_id),
    roll_id           bigint NOT NULL REFERENCES production.rolls(roll_id),
    allocated_meters  numeric(12,2) NOT NULL CHECK (allocated_meters > 0),
    PRIMARY KEY (production_log_id, roll_id)
);
CREATE INDEX IF NOT EXISTS ix_rework_roll_log_allocations_roll
    ON production.rework_roll_log_allocations(roll_id, production_log_id);

CREATE OR REPLACE FUNCTION production.validate_assignment_rework_roll()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_job_id bigint; v_roll_job bigint; v_status text; v_latest_inspection bigint;
BEGIN
    SELECT job_id INTO v_job_id FROM production.machine_assignments
    WHERE machine_assignment_id=NEW.machine_assignment_id;
    SELECT job_id,current_status INTO v_roll_job,v_status FROM production.rolls
    WHERE roll_id=NEW.roll_id FOR UPDATE;
    SELECT inspection_id INTO v_latest_inspection FROM quality.inspections
    WHERE roll_id=NEW.roll_id ORDER BY inspected_at DESC,inspection_id DESC LIMIT 1;
    IF v_roll_job IS DISTINCT FROM v_job_id OR v_status IS DISTINCT FROM 'REWORK'
       OR v_latest_inspection IS DISTINCT FROM NEW.source_inspection_id THEN
        RAISE EXCEPTION 'Only a currently rework-marked roll from this job can be assigned';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_assignment_rework_roll ON production.machine_assignment_rework_rolls;
CREATE TRIGGER trg_validate_assignment_rework_roll
BEFORE INSERT OR UPDATE ON production.machine_assignment_rework_rolls
FOR EACH ROW EXECUTE FUNCTION production.validate_assignment_rework_roll();

CREATE OR REPLACE FUNCTION production.validate_rework_roll_log_allocation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_assignment_id bigint; v_roll_meters numeric(12,2); v_already_allocated numeric(12,2);
BEGIN
    SELECT pl.machine_assignment_id INTO v_assignment_id
    FROM production.production_logs pl WHERE pl.production_log_id=NEW.production_log_id;
    IF NOT EXISTS (
        SELECT 1 FROM production.machine_assignment_rework_rolls ar
        WHERE ar.machine_assignment_id=v_assignment_id AND ar.roll_id=NEW.roll_id
    ) THEN RAISE EXCEPTION 'Rework output must target a roll assigned to this machine job'; END IF;
    SELECT r.length_meters INTO v_roll_meters FROM production.rolls r
    WHERE r.roll_id=NEW.roll_id FOR UPDATE;
    SELECT COALESCE(sum(a.allocated_meters),0) INTO v_already_allocated
    FROM production.rework_roll_log_allocations a
    JOIN production.production_logs pl ON pl.production_log_id=a.production_log_id
    JOIN production.machine_assignment_rework_rolls ar
      ON ar.machine_assignment_id=pl.machine_assignment_id AND ar.roll_id=a.roll_id
    WHERE a.roll_id=NEW.roll_id AND ar.source_inspection_id=(
        SELECT max(i.inspection_id) FROM quality.inspections i WHERE i.roll_id=NEW.roll_id
    ) AND a.production_log_id IS DISTINCT FROM NEW.production_log_id;
    IF v_already_allocated+NEW.allocated_meters>v_roll_meters THEN
        RAISE EXCEPTION 'Rework allocation exceeds the selected roll length';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_rework_roll_log_allocation ON production.rework_roll_log_allocations;
CREATE TRIGGER trg_validate_rework_roll_log_allocation
BEFORE INSERT OR UPDATE ON production.rework_roll_log_allocations
FOR EACH ROW EXECUTE FUNCTION production.validate_rework_roll_log_allocation();

CREATE OR REPLACE FUNCTION production.validate_rework_log_allocations_complete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_good numeric(12,2); v_rework boolean; v_allocated numeric(12,2);
BEGIN
    SELECT pl.good_meters,EXISTS(SELECT 1 FROM production.machine_assignment_rework_rolls ar
        WHERE ar.machine_assignment_id=pl.machine_assignment_id)
    INTO v_good,v_rework FROM production.production_logs pl WHERE pl.production_log_id=NEW.production_log_id;
    IF v_rework AND v_good>0 THEN
        SELECT COALESCE(sum(allocated_meters),0) INTO v_allocated
        FROM production.rework_roll_log_allocations WHERE production_log_id=NEW.production_log_id;
        IF v_allocated<>v_good THEN
            RAISE EXCEPTION 'Good rework metres must be allocated to the selected rolls';
        END IF;
    END IF;
    RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_rework_log_allocations_complete ON production.production_logs;
CREATE CONSTRAINT TRIGGER trg_validate_rework_log_allocations_complete
AFTER INSERT ON production.production_logs DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION production.validate_rework_log_allocations_complete();

/* A roll cannot pass inspection until its current rework cycle is fully logged. */
CREATE OR REPLACE FUNCTION quality.apply_inspection_result()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; v_roll_length numeric(12,2); v_source_inspection bigint; v_allocated numeric(12,2);
BEGIN
    PERFORM auth.assert_role(NEW.inspected_by, ARRAY['SUPERVISOR','OWNER'], 'quality inspector');
    SELECT current_status,length_meters INTO v_status,v_roll_length FROM production.rolls
    WHERE roll_id=NEW.roll_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Roll not found'; END IF;
    IF v_status='DISPATCHED' THEN RAISE EXCEPTION 'A dispatched roll cannot be reinspected'; END IF;
    IF NEW.result='PASS' AND v_status='REWORK' THEN
        SELECT inspection_id INTO v_source_inspection FROM quality.inspections
        WHERE roll_id=NEW.roll_id AND inspection_id<>NEW.inspection_id
        ORDER BY inspected_at DESC,inspection_id DESC LIMIT 1;
        SELECT COALESCE(sum(a.allocated_meters),0) INTO v_allocated
        FROM production.rework_roll_log_allocations a
        JOIN production.production_logs pl ON pl.production_log_id=a.production_log_id
        JOIN production.machine_assignment_rework_rolls ar
          ON ar.machine_assignment_id=pl.machine_assignment_id AND ar.roll_id=a.roll_id
        WHERE a.roll_id=NEW.roll_id AND ar.source_inspection_id=v_source_inspection;
        IF v_allocated<v_roll_length THEN
            RAISE EXCEPTION 'The full rework quantity must be logged before this roll can pass inspection';
        END IF;
    END IF;
    PERFORM set_config('app.allow_roll_status_change','true',true);
    UPDATE production.rolls SET current_status=CASE NEW.result WHEN 'PASS' THEN 'PASSED'
        WHEN 'REWORK' THEN 'REWORK' ELSE 'REJECTED' END WHERE roll_id=NEW.roll_id;
    PERFORM set_config('app.allow_roll_status_change','false',true);
    RETURN NEW;
END;
$$;

/* Roll records represent net good metres, never gross output that includes waste. */
CREATE OR REPLACE FUNCTION production.validate_roll()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_job_item bigint; v_assignment_machine bigint; v_log_job bigint; v_log_meters numeric(12,2); v_existing_roll_meters numeric(12,2);
BEGIN
    SELECT order_item_id INTO v_job_item FROM production.jobs WHERE job_id=NEW.job_id;
    IF v_job_item IS DISTINCT FROM NEW.order_item_id THEN
        RAISE EXCEPTION 'Roll order item must match its production job';
    END IF;
    IF NEW.production_log_id IS NOT NULL THEN
        SELECT ma.machine_id,ma.job_id,pl.good_meters
          INTO v_assignment_machine,v_log_job,v_log_meters
          FROM production.production_logs pl JOIN production.machine_assignments ma USING(machine_assignment_id)
         WHERE pl.production_log_id=NEW.production_log_id;
        IF v_assignment_machine IS DISTINCT FROM NEW.machine_id OR v_log_job IS DISTINCT FROM NEW.job_id THEN
            RAISE EXCEPTION 'Roll machine/job must match the production log assignment';
        END IF;
        SELECT COALESCE(SUM(r.length_meters),0) INTO v_existing_roll_meters
        FROM production.rolls r WHERE r.production_log_id=NEW.production_log_id AND r.roll_id IS DISTINCT FROM NEW.roll_id;
        IF v_existing_roll_meters+NEW.length_meters>v_log_meters THEN
            RAISE EXCEPTION 'Roll lengths exceed net good output after waste';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

/* Rejects are not deliverable order output. */
CREATE OR REPLACE VIEW reporting.order_progress_by_line AS
WITH roll_stats AS (
    SELECT r.order_item_id,
           COUNT(*) FILTER (WHERE r.current_status<>'REJECTED') AS rolls_produced,
           COALESCE(SUM(r.length_meters) FILTER (WHERE r.current_status<>'REJECTED'),0) AS produced_meters,
           COALESCE(SUM(r.length_meters) FILTER (WHERE r.current_status IN ('PASSED','DISPATCHED')),0) AS qc_passed_meters,
           COALESCE(SUM(r.length_meters) FILTER (WHERE r.current_status='REJECTED'),0) AS rejected_meters,
           COALESCE(SUM(r.length_meters) FILTER (WHERE r.current_status='REWORK'),0) AS rework_meters,
           COALESCE(SUM(r.length_meters) FILTER (WHERE r.current_status='PENDING_QC'),0) AS pending_qc_meters
    FROM production.rolls r GROUP BY r.order_item_id
), logged_output AS (
    SELECT j.order_item_id,
           COALESCE(SUM(pl.good_meters) FILTER (WHERE COALESCE(ma.notes,'') NOT LIKE 'REWORK:%'),0) AS good_meters
    FROM production.production_logs pl
    JOIN production.machine_assignments ma USING(machine_assignment_id)
    JOIN production.jobs j USING(job_id)
    GROUP BY j.order_item_id
), shipped AS (
    SELECT r.order_item_id,SUM(r.length_meters) AS dispatched_meters
    FROM dispatch.shipment_items si JOIN dispatch.shipments sh USING(shipment_id)
    JOIN production.rolls r USING(roll_id) WHERE sh.status IN ('SHIPPED','DELIVERED')
    GROUP BY r.order_item_id
)
SELECT o.order_id,o.order_no,o.status AS stored_order_status,o.required_by_date,
       b.buyer_id,b.company_name,oi.order_item_id,oi.line_no,ft.fabric_name,c.colour_name,
       oi.quantity_m AS ordered_meters,COALESCE(rs.rolls_produced,0) AS rolls_produced,
       GREATEST(COALESCE(lo.good_meters,0)-COALESCE(rs.rejected_meters,0),0) AS produced_meters,COALESCE(rs.qc_passed_meters,0) AS qc_passed_meters,
       COALESCE(rs.pending_qc_meters,0) AS pending_qc_meters,COALESCE(rs.rework_meters,0) AS rework_meters,
       COALESCE((SELECT SUM(r.length_meters) FROM production.rolls r WHERE r.order_item_id=oi.order_item_id AND r.current_status='REJECTED'),0) AS rejected_meters,
       COALESCE(sh.dispatched_meters,0) AS dispatched_meters,
       LEAST(100,round(GREATEST(COALESCE(lo.good_meters,0)-COALESCE(rs.rejected_meters,0),0)/NULLIF(oi.quantity_m,0)*100,2)) AS production_percent,
       LEAST(100,round(COALESCE(sh.dispatched_meters,0)/NULLIF(oi.quantity_m,0)*100,2)) AS dispatch_percent
FROM sales.orders o JOIN master.buyers b USING(buyer_id) JOIN sales.order_items oi USING(order_id)
JOIN master.fabric_types ft USING(fabric_type_id) JOIN master.colours c USING(colour_id)
LEFT JOIN roll_stats rs USING(order_item_id) LEFT JOIN logged_output lo USING(order_item_id) LEFT JOIN shipped sh USING(order_item_id);

/* Production efficiency reports net output, while retaining waste as a separate measure. */
CREATE OR REPLACE VIEW reporting.production_job_efficiency AS
WITH logs AS (
    SELECT ma.job_id,
           COALESCE(SUM(pl.good_meters),0) AS produced_meters,
           COALESCE(SUM(pl.produced_meters),0) AS gross_meters,
           COALESCE(SUM(pl.waste_meters),0) AS waste_meters,
           COALESCE(SUM(pl.downtime_minutes),0) AS downtime_minutes
    FROM production.machine_assignments ma LEFT JOIN production.production_logs pl USING(machine_assignment_id)
    GROUP BY ma.job_id
), qc AS (
    SELECT r.job_id,
       COALESCE(SUM(r.length_meters) FILTER (WHERE r.current_status IN ('PASSED','DISPATCHED')),0) AS qc_passed_meters,
       COALESCE(SUM(r.length_meters) FILTER (WHERE r.current_status='REJECTED'),0) AS rejected_meters,
       COALESCE(SUM(r.length_meters) FILTER (WHERE r.current_status='REWORK'),0) AS rework_meters
    FROM production.rolls r GROUP BY r.job_id
)
SELECT j.job_id,j.job_no,j.order_item_id,o.order_id,o.order_no,b.company_name,ft.fabric_name,c.colour_name,
       j.stage,j.status AS job_status,j.planned_meters,COALESCE(l.produced_meters,0) AS produced_meters,
       COALESCE(l.waste_meters,0) AS waste_meters,
       COALESCE(l.downtime_minutes,0) AS downtime_minutes,
       round(COALESCE(l.produced_meters,0)/NULLIF(j.planned_meters,0)*100,2) AS plan_attainment_percent,
       COALESCE(q.qc_passed_meters,0) AS qc_passed_meters,COALESCE(q.rejected_meters,0) AS rejected_meters,
       COALESCE(q.rework_meters,0) AS rework_meters,
       round(COALESCE(q.qc_passed_meters,0)/NULLIF(l.produced_meters,0)*100,2) AS qc_yield_percent,
       COALESCE(l.gross_meters,0) AS gross_meters
FROM production.jobs j JOIN sales.order_items oi USING(order_item_id) JOIN sales.orders o USING(order_id)
JOIN master.buyers b USING(buyer_id) JOIN master.fabric_types ft USING(fabric_type_id)
JOIN master.colours c USING(colour_id) LEFT JOIN logs l USING(job_id) LEFT JOIN qc q USING(job_id);

COMMIT;
