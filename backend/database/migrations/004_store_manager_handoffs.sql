BEGIN;

CREATE SEQUENCE IF NOT EXISTS production.seq_store_handoff_no START 1;

CREATE TABLE IF NOT EXISTS production.store_handoffs (
    handoff_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    handoff_no text NOT NULL UNIQUE DEFAULT core.fmt_doc('HOF', nextval('production.seq_store_handoff_no')),
    order_item_id bigint NOT NULL REFERENCES sales.order_items(order_item_id),
    supervisor_user_id bigint NOT NULL REFERENCES auth.users(user_id),
    stage text NOT NULL CHECK (stage IN ('SPINNING','WEAVING','DYEING')),
    planned_meters numeric(12,2) NOT NULL CHECK (planned_meters > 0),
    status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','ACCEPTED','REJECTED','JOB_CREATED','ISSUED','CANCELLED')),
    production_job_id bigint UNIQUE REFERENCES production.jobs(job_id),
    created_by bigint NOT NULL REFERENCES auth.users(user_id),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    accepted_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status IN ('JOB_CREATED','ISSUED') AND production_job_id IS NOT NULL) OR status NOT IN ('JOB_CREATED','ISSUED'))
);
CREATE INDEX IF NOT EXISTS ix_store_handoffs_supervisor_status ON production.store_handoffs(supervisor_user_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS ix_store_handoffs_order_item ON production.store_handoffs(order_item_id,created_at DESC);

CREATE TABLE IF NOT EXISTS production.store_handoff_materials (
    handoff_id bigint NOT NULL REFERENCES production.store_handoffs(handoff_id),
    yarn_type_id bigint NOT NULL REFERENCES master.yarn_types(yarn_type_id),
    required_kg numeric(12,3) NOT NULL CHECK (required_kg > 0),
    reserved_kg numeric(12,3) NOT NULL DEFAULT 0 CHECK (reserved_kg >= 0),
    issued_kg numeric(12,3) NOT NULL DEFAULT 0 CHECK (issued_kg >= 0),
    PRIMARY KEY (handoff_id,yarn_type_id),
    CHECK (reserved_kg <= required_kg),
    CHECK (issued_kg <= required_kg)
);

CREATE TABLE IF NOT EXISTS production.store_handoff_history (
    history_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    handoff_id bigint NOT NULL REFERENCES production.store_handoffs(handoff_id),
    old_status text,
    new_status text NOT NULL,
    changed_by bigint REFERENCES auth.users(user_id),
    changed_at timestamptz NOT NULL DEFAULT now(),
    notes text
);

CREATE OR REPLACE FUNCTION production.validate_store_handoff()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM auth.assert_role(NEW.created_by, ARRAY['STORE_MANAGER','OWNER'], 'store handoff creator');
    END IF;
    IF NEW.supervisor_user_id IS DISTINCT FROM OLD.supervisor_user_id OR TG_OP = 'INSERT' THEN
        PERFORM auth.assert_role(NEW.supervisor_user_id, ARRAY['SUPERVISOR'], 'store handoff recipient');
    END IF;
    IF NEW.production_job_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM production.jobs j WHERE j.job_id=NEW.production_job_id AND j.order_item_id=NEW.order_item_id
    ) THEN RAISE EXCEPTION 'Handoff job must belong to the same order item'; END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_store_handoff ON production.store_handoffs;
CREATE TRIGGER trg_validate_store_handoff BEFORE INSERT OR UPDATE ON production.store_handoffs
FOR EACH ROW EXECUTE FUNCTION production.validate_store_handoff();

CREATE OR REPLACE FUNCTION production.log_store_handoff_status()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO production.store_handoff_history(handoff_id,old_status,new_status,changed_by)
        VALUES(NEW.handoff_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.status END,NEW.status,core.current_actor_id());
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_log_store_handoff_status ON production.store_handoffs;
CREATE TRIGGER trg_log_store_handoff_status AFTER INSERT OR UPDATE OF status ON production.store_handoffs
FOR EACH ROW EXECUTE FUNCTION production.log_store_handoff_status();

COMMIT;
