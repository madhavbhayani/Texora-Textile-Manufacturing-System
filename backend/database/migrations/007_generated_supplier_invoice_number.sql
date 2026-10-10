/* Texora's generated internal PINV number is the invoice reference used by the
   procurement workflow. The supplier's own reference is optional. */
BEGIN;

ALTER TABLE procurement.supplier_invoices
    ALTER COLUMN supplier_invoice_no DROP NOT NULL;

COMMIT;
