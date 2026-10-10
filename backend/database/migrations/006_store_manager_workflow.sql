/* Additive procurement linkage and material-hold state for the unified store workflow. */
BEGIN;

ALTER TABLE procurement.supplier_invoices
    ADD COLUMN IF NOT EXISTS purchase_order_id bigint REFERENCES procurement.purchase_orders(purchase_order_id);

UPDATE procurement.supplier_invoices si
SET purchase_order_id = gr.purchase_order_id
FROM procurement.goods_receipts gr
WHERE gr.goods_receipt_id = si.goods_receipt_id
  AND si.purchase_order_id IS NULL;

ALTER TABLE procurement.supplier_invoices
    ALTER COLUMN purchase_order_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS ix_supplier_invoices_purchase_order
    ON procurement.supplier_invoices(purchase_order_id, invoice_date DESC);

CREATE OR REPLACE FUNCTION procurement.validate_supplier_invoice()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_supplier_id bigint; v_purchase_order_id bigint; v_item_count bigint;
BEGIN
    PERFORM auth.assert_role(NEW.recorded_by, ARRAY['STORE_MANAGER','OWNER'], 'supplier invoice recorder');
    IF TG_OP = 'INSERT' THEN
        NEW.status := 'RECORDED';
        NEW.approved_by := NULL;
    END IF;
    IF NEW.approved_by IS NOT NULL THEN
        PERFORM auth.assert_role(NEW.approved_by, ARRAY['STORE_MANAGER','OWNER'], 'supplier invoice approver');
    END IF;
    SELECT po.supplier_id, po.purchase_order_id INTO v_supplier_id, v_purchase_order_id
    FROM procurement.goods_receipts gr
    JOIN procurement.purchase_orders po ON po.purchase_order_id = gr.purchase_order_id
    WHERE gr.goods_receipt_id = NEW.goods_receipt_id;
    IF v_supplier_id IS DISTINCT FROM NEW.supplier_id OR v_purchase_order_id IS DISTINCT FROM NEW.purchase_order_id THEN
        RAISE EXCEPTION 'Supplier invoice must match the supplier and purchase order for its goods receipt';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF OLD.status = 'VOID' AND NEW.status <> 'VOID' THEN
            RAISE EXCEPTION 'A void supplier invoice cannot be reopened';
        END IF;
        IF OLD.status = 'APPROVED' AND NEW.status NOT IN ('APPROVED','VOID') THEN
            RAISE EXCEPTION 'An approved supplier invoice can only remain approved or be voided';
        END IF;
        IF OLD.status IN ('APPROVED','VOID') AND
           (NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id OR
            NEW.goods_receipt_id IS DISTINCT FROM OLD.goods_receipt_id OR NEW.supplier_invoice_no IS DISTINCT FROM OLD.supplier_invoice_no OR
            NEW.invoice_date IS DISTINCT FROM OLD.invoice_date OR NEW.due_date IS DISTINCT FROM OLD.due_date OR
            NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
            RAISE EXCEPTION 'Supplier invoice identity and dates are immutable after approval/voiding';
        END IF;
    END IF;
    IF NEW.status = 'APPROVED' THEN
        IF NEW.approved_by IS NULL THEN RAISE EXCEPTION 'Supplier invoice approval must record approved_by'; END IF;
        SELECT COUNT(*) INTO v_item_count FROM procurement.supplier_invoice_items WHERE supplier_invoice_id = NEW.supplier_invoice_id;
        IF v_item_count = 0 THEN RAISE EXCEPTION 'Supplier invoice requires at least one invoice line before approval'; END IF;
    ELSIF NEW.status = 'VOID' AND EXISTS (
        SELECT 1 FROM procurement.supplier_payments WHERE supplier_invoice_id = NEW.supplier_invoice_id AND status IN ('PENDING','COMPLETED')
    ) THEN
        RAISE EXCEPTION 'A supplier invoice with pending/completed payments cannot be voided';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_supplier_invoice ON procurement.supplier_invoices;
CREATE TRIGGER trg_validate_supplier_invoice
BEFORE INSERT OR UPDATE OF supplier_id, purchase_order_id, goods_receipt_id, recorded_by, approved_by, status
ON procurement.supplier_invoices FOR EACH ROW EXECUTE FUNCTION procurement.validate_supplier_invoice();

ALTER TABLE production.store_handoffs DROP CONSTRAINT IF EXISTS store_handoffs_status_check;
ALTER TABLE production.store_handoffs ADD CONSTRAINT store_handoffs_status_check
    CHECK (status IN ('REQUESTED','ON_HOLD','ACCEPTED','REJECTED','JOB_CREATED','ISSUED','CANCELLED'));

COMMIT;
