/* Buyer tax identifiers are not collected or used by the customer portal. */
ALTER TABLE master.buyers
    DROP COLUMN IF EXISTS gst_no,
    DROP COLUMN IF EXISTS pan_no;
