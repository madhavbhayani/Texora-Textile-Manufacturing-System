BEGIN;

ALTER TABLE procurement.supplier_invoice_reviews
    DROP CONSTRAINT IF EXISTS supplier_invoice_reviews_decision_check;
ALTER TABLE procurement.supplier_invoice_reviews
    ADD CONSTRAINT supplier_invoice_reviews_decision_check
    CHECK (decision IN ('APPROVED', 'CORRECTION_REQUESTED', 'CORRECTION_SUBMITTED', 'VOIDED'));

COMMIT;
