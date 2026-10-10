/* Preserve migration 004's checksum while correcting handoff audit attribution
   and ensuring updated_at is changed by a BEFORE UPDATE trigger. */

CREATE OR REPLACE FUNCTION production.log_store_handoff_status()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO production.store_handoff_history(
            handoff_id, old_status, new_status, changed_by
        )
        VALUES (
            NEW.handoff_id,
            CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
            NEW.status,
            COALESCE(
                core.current_actor_id(),
                CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by ELSE NULL END
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_updated_at_store_handoff ON production.store_handoffs;
CREATE TRIGGER trg_set_updated_at_store_handoff
BEFORE UPDATE ON production.store_handoffs
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
