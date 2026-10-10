/* A production assignment linked to a Store Manager handoff may only start or
   resume after the inventory issue workflow marks that handoff ISSUED. Legacy
   jobs without a handoff retain their existing workflow. */
BEGIN;

CREATE OR REPLACE FUNCTION production.require_issued_handoff_before_running()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_handoff_status text;
BEGIN
    IF NEW.status = 'RUNNING' AND OLD.status IS DISTINCT FROM NEW.status THEN
        SELECT h.status INTO v_handoff_status
        FROM production.store_handoffs h
        WHERE h.production_job_id = NEW.job_id
        FOR UPDATE;

        IF FOUND AND v_handoff_status IS DISTINCT FROM 'ISSUED' THEN
            RAISE EXCEPTION 'Production cannot start until the Store Manager issues the required materials'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_require_issued_handoff_before_running ON production.machine_assignments;
CREATE TRIGGER trg_require_issued_handoff_before_running
BEFORE UPDATE OF status ON production.machine_assignments
FOR EACH ROW EXECUTE FUNCTION production.require_issued_handoff_before_running();

COMMIT;
