BEGIN;

CREATE TABLE procurement.supplier_invoice_reviews (
    review_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    supplier_invoice_id bigint NOT NULL REFERENCES procurement.supplier_invoices(supplier_invoice_id),
    decision text NOT NULL CHECK (decision IN ('APPROVED', 'CORRECTION_REQUESTED', 'VOIDED')),
    reason text NOT NULL CHECK (length(btrim(reason)) >= 5),
    actor_user_id bigint NOT NULL REFERENCES auth.users(user_id),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_supplier_invoice_reviews_invoice
    ON procurement.supplier_invoice_reviews(supplier_invoice_id, created_at DESC);

CREATE OR REPLACE FUNCTION procurement.enforce_owner_invoice_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED' THEN
        IF NEW.approved_by IS NULL OR NEW.approved_by IS DISTINCT FROM core.current_actor_id() THEN
            RAISE EXCEPTION 'Invoice approver must match the authenticated transaction actor';
        END IF;
        IF NEW.approved_by = NEW.recorded_by THEN
            RAISE EXCEPTION 'Invoice recorder cannot approve the same invoice';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM procurement.supplier_invoice_reviews r
            WHERE r.supplier_invoice_id = NEW.supplier_invoice_id
              AND r.actor_user_id = NEW.approved_by
              AND r.decision = 'APPROVED'
        ) THEN
            RAISE EXCEPTION 'A reasoned invoice approval review is required';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_owner_invoice_approval ON procurement.supplier_invoices;
CREATE TRIGGER trg_enforce_owner_invoice_approval
BEFORE UPDATE OF status, approved_by ON procurement.supplier_invoices
FOR EACH ROW EXECUTE FUNCTION procurement.enforce_owner_invoice_approval();

COMMIT;
