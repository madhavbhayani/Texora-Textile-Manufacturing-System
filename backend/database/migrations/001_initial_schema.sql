/* ============================================================================
   TEXORA - TEXTILE MANUFACTURING MANAGEMENT SYSTEM
   PostgreSQL 13+ | Single setup script for pgAdmin Query Tool

   Recommended execution:
     1. Create a NEW empty database (for example: texora_db) in pgAdmin.
     2. Open Query Tool for that database and execute this entire file (F5).
     3. Run once on a fresh database. It intentionally does not DROP existing data.

   Schemas:
     core, auth, master, hr, sales, procurement, inventory, production,
     quality, dispatch, finance, notification, audit, reporting

   Application roles (exactly six): OWNER, BUYER, STORE_MANAGER, SUPERVISOR,
   WORKER, DISPATCH_OFFICER.

   Important integration notes:
     - Set `SET LOCAL app.current_user_id = '<auth.users.user_id>'` inside each
       authenticated backend transaction if you want actor IDs in audit events.
     - Store password HASHES only; hash passwords in Node.js (bcrypt/Argon2).
     - Never store card numbers, CVVs, gateway secrets, or raw card data here.
       Store only payment gateway identifiers, status, amount, and sanitized JSON.
     - `auth.role_permissions` is the permissions catalogue for the backend.
       Enforce authorization in Express middleware; database roles are app roles,
       not PostgreSQL login roles.
     - Use the receiving and invoice functions below for the validated workflows.

   Design principles:
     - BIGINT identity primary keys; human-readable document numbers are separate.
     - Explicit schemas, foreign keys, unique constraints and CHECK constraints.
     - Stock is updated only through append-only stock movement records.
     - Roll QC status is traceable; dispatch cannot use a non-passed roll.
     - Customer invoice is issued only after shipment is shipped.
     - Invoice/stock/payment summaries are calculated in reporting views.
   ============================================================================ */

SET LOCAL TIME ZONE 'Asia/Kolkata';

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS master;
CREATE SCHEMA IF NOT EXISTS hr;
CREATE SCHEMA IF NOT EXISTS sales;
CREATE SCHEMA IF NOT EXISTS procurement;
CREATE SCHEMA IF NOT EXISTS inventory;
CREATE SCHEMA IF NOT EXISTS production;
CREATE SCHEMA IF NOT EXISTS quality;
CREATE SCHEMA IF NOT EXISTS dispatch;
CREATE SCHEMA IF NOT EXISTS finance;
CREATE SCHEMA IF NOT EXISTS notification;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS reporting;

/* --------------------------------------------------------------------------
   1. Core helpers and business-number sequences
   -------------------------------------------------------------------------- */
CREATE TABLE core.app_settings (
    setting_key   text PRIMARY KEY,
    setting_value text NOT NULL,
    description   text,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION core.fmt_doc(p_prefix text, p_number bigint)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT p_prefix || '-' || CASE WHEN p_number < 10000
                                  THEN lpad(p_number::text, 4, '0')
                                  ELSE p_number::text END
$$;

CREATE FUNCTION core.current_actor_id()
RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '')::bigint
$$;

CREATE FUNCTION core.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE SEQUENCE master.seq_supplier_code START 1;
CREATE SEQUENCE master.seq_buyer_code START 1;
CREATE SEQUENCE master.seq_machine_code START 1;
CREATE SEQUENCE hr.seq_employee_code START 1;
CREATE SEQUENCE hr.seq_wage_no START 1;
CREATE SEQUENCE sales.seq_order_no START 1;
CREATE SEQUENCE procurement.seq_po_no START 1;
CREATE SEQUENCE procurement.seq_grn_no START 1;
CREATE SEQUENCE procurement.seq_supplier_invoice_no START 1;
CREATE SEQUENCE inventory.seq_lot_no START 1;
CREATE SEQUENCE inventory.seq_issue_no START 1;
CREATE SEQUENCE production.seq_job_no START 1;
CREATE SEQUENCE production.seq_roll_no START 1;
CREATE SEQUENCE quality.seq_inspection_no START 1;
CREATE SEQUENCE dispatch.seq_shipment_no START 1;
CREATE SEQUENCE finance.seq_customer_invoice_no START 1;
CREATE SEQUENCE procurement.seq_supplier_payment_no START 1;
CREATE SEQUENCE finance.seq_expense_no START 1;

INSERT INTO core.app_settings(setting_key, setting_value, description) VALUES
 ('standard_shift_hours', '8', 'Normal shift duration used by attendance calculations.'),
 ('low_stock_default_kg', '100', 'Default low-stock warning threshold when a yarn type has no custom threshold.'),
 ('currency_code', 'INR', 'Default currency used for operational reports.'),
 ('order_qty_tolerance_percent', '0', 'Default tolerance for order quantity fulfilment; zero means exact quantity.')
ON CONFLICT (setting_key) DO NOTHING;

/* --------------------------------------------------------------------------
   2. Authentication and six application roles
   -------------------------------------------------------------------------- */
CREATE TABLE auth.roles (
    role_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_code    text NOT NULL UNIQUE CHECK (role_code = upper(role_code)),
    role_name    text NOT NULL UNIQUE,
    description  text,
    is_active    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO auth.roles(role_code, role_name, description) VALUES
 ('OWNER', 'Owner', 'Full access to operations, dashboard, reports and financials.'),
 ('BUYER', 'Buyer / Customer', 'Places orders and views own order, shipment, invoice and payment details.'),
 ('STORE_MANAGER', 'Store Manager', 'Manages suppliers, purchase orders, raw-material stock and supplier payments.'),
 ('SUPERVISOR', 'Supervisor', 'Manages production, machines, roll inspection and defects.'),
 ('WORKER', 'Worker', 'Operates assigned jobs, records production output and attendance.'),
 ('DISPATCH_OFFICER', 'Dispatch Officer', 'Packs and dispatches approved rolls and issues customer invoices.')
ON CONFLICT (role_code) DO NOTHING;

CREATE TABLE auth.users (
    user_id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_id               bigint NOT NULL REFERENCES auth.roles(role_id),
    full_name             text NOT NULL CHECK (btrim(full_name) <> ''),
    email                 text NOT NULL UNIQUE,
    phone                 text UNIQUE,
    password_hash         text NOT NULL,
    is_active             boolean NOT NULL DEFAULT true,
    is_email_verified     boolean NOT NULL DEFAULT false,
    is_phone_verified     boolean NOT NULL DEFAULT false,
    must_change_password  boolean NOT NULL DEFAULT false,
    failed_login_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
    locked_until          timestamptz,
    last_login_at         timestamptz,
    password_changed_at   timestamptz NOT NULL DEFAULT now(),
    created_by            bigint REFERENCES auth.users(user_id),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CHECK (email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
    CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{10,15}$')
);
CREATE INDEX ix_users_role_active ON auth.users(role_id, is_active);

CREATE FUNCTION auth.normalize_user_contact()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.email := lower(btrim(NEW.email));
    IF NEW.phone IS NOT NULL THEN
        NEW.phone := regexp_replace(btrim(NEW.phone), '[[:space:]()-]', '', 'g');
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_normalize_user_contact
BEFORE INSERT OR UPDATE OF email, phone ON auth.users
FOR EACH ROW EXECUTE FUNCTION auth.normalize_user_contact();

CREATE TABLE auth.permissions (
    permission_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    permission_code text NOT NULL UNIQUE,
    module          text NOT NULL,
    description     text NOT NULL
);
CREATE TABLE auth.role_permissions (
    role_id       bigint NOT NULL REFERENCES auth.roles(role_id) ON DELETE CASCADE,
    permission_id bigint NOT NULL REFERENCES auth.permissions(permission_id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);
INSERT INTO auth.permissions(permission_code, module, description) VALUES
 ('dashboard.view_all','dashboard','View factory-wide dashboard and metrics.'),
 ('orders.create_own','orders','Place buyer orders.'),
 ('orders.view_own','orders','View own orders and order progress.'),
 ('orders.manage','orders','Confirm and manage customer orders.'),
 ('inventory.manage','inventory','Manage raw material, lots, stock and receipts.'),
 ('procurement.manage','procurement','Create purchase orders, receive goods and manage supplier bills.'),
 ('suppliers.manage','suppliers','Create and maintain suppliers.'),
 ('production.manage','production','Plan jobs, assign machines and manage production.'),
 ('production.log_own','production','Start/stop assigned work and record output.'),
 ('machines.manage','machines','Manage machine status and breakdown records.'),
 ('quality.inspect','quality','Inspect rolls and classify quality outcomes.'),
 ('dispatch.manage','dispatch','Pack, dispatch and track shipments.'),
 ('invoices.view_own','invoices','View invoices belonging to the buyer.'),
 ('invoices.manage','invoices','Create and issue invoices for dispatched shipments.'),
 ('payments.manage_own','payments','Initiate and track payments against own invoices.'),
 ('finance.view','finance','View costs, collections, supplier payables and profitability.'),
 ('finance.manage_supplier','finance','Record supplier payments and operational expenses.'),
 ('hr.manage','hr','Manage worker records, wages and attendance.'),
 ('attendance.mark_own','attendance','Record own attendance.'),
 ('reports.view','reports','View operational reports.'),
 ('users.manage','users','Manage users and role assignments.')
ON CONFLICT (permission_code) DO NOTHING;
INSERT INTO auth.role_permissions(role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM auth.roles r CROSS JOIN auth.permissions p
WHERE r.role_code = 'OWNER'
ON CONFLICT DO NOTHING;
INSERT INTO auth.role_permissions(role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
 ('BUYER','orders.create_own'), ('BUYER','orders.view_own'), ('BUYER','invoices.view_own'), ('BUYER','payments.manage_own'),
 ('STORE_MANAGER','inventory.manage'), ('STORE_MANAGER','procurement.manage'), ('STORE_MANAGER','suppliers.manage'), ('STORE_MANAGER','finance.manage_supplier'),
 ('SUPERVISOR','production.manage'), ('SUPERVISOR','machines.manage'), ('SUPERVISOR','quality.inspect'), ('SUPERVISOR','reports.view'),
 ('WORKER','production.log_own'), ('WORKER','attendance.mark_own'),
 ('DISPATCH_OFFICER','dispatch.manage'), ('DISPATCH_OFFICER','invoices.manage'), ('DISPATCH_OFFICER','orders.manage')
) AS x(role_code, permission_code)
JOIN auth.roles r ON r.role_code = x.role_code
JOIN auth.permissions p ON p.permission_code = x.permission_code
ON CONFLICT DO NOTHING;

CREATE TABLE auth.sessions (
    session_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id             bigint NOT NULL REFERENCES auth.users(user_id),
    refresh_token_hash  text NOT NULL UNIQUE,
    ip_address          inet,
    user_agent          text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_used_at        timestamptz,
    expires_at          timestamptz NOT NULL,
    revoked_at          timestamptz,
    CHECK (expires_at > created_at)
);
CREATE INDEX ix_sessions_active_user ON auth.sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE auth.login_events (
    login_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id        bigint REFERENCES auth.users(user_id),
    login_identifier text NOT NULL,
    success        boolean NOT NULL,
    failure_reason text,
    ip_address     inet,
    user_agent     text,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_login_events_user_time ON auth.login_events(user_id, created_at DESC);

CREATE FUNCTION auth.user_has_role(p_user_id bigint, p_role_codes text[])
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
        FROM auth.users u JOIN auth.roles r ON r.role_id = u.role_id
        WHERE u.user_id = p_user_id AND u.is_active AND r.is_active
          AND r.role_code = ANY (p_role_codes)
    )
$$;

CREATE FUNCTION auth.assert_role(p_user_id bigint, p_role_codes text[], p_context text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_user_id IS NULL OR NOT auth.user_has_role(p_user_id, p_role_codes) THEN
        RAISE EXCEPTION 'Role check failed for %; expected role in %', p_context, p_role_codes
            USING ERRCODE = '42501';
    END IF;
END;
$$;

/* --------------------------------------------------------------------------
   3. Master data: suppliers, buyers, materials, fabrics, machines and shifts
   -------------------------------------------------------------------------- */
CREATE TABLE master.suppliers (
    supplier_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    supplier_code      text NOT NULL UNIQUE DEFAULT core.fmt_doc('SUP', nextval('master.seq_supplier_code')),
    supplier_name      text NOT NULL,
    contact_person     text,
    phone              text,
    email              text,
    gst_no             text,
    address_line       text,
    city               text,
    state              text,
    pincode            text,
    payment_terms_days integer NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
    is_active          boolean NOT NULL DEFAULT true,
    created_by         bigint REFERENCES auth.users(user_id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (supplier_name)
);
CREATE INDEX ix_suppliers_active ON master.suppliers(is_active, supplier_name);

CREATE TABLE master.buyers (
    buyer_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    buyer_code    text NOT NULL UNIQUE DEFAULT core.fmt_doc('BUY', nextval('master.seq_buyer_code')),
    user_id       bigint NOT NULL UNIQUE REFERENCES auth.users(user_id),
    company_name  text NOT NULL,
    gst_no        text,
    pan_no        text,
    credit_limit  numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
    credit_days   integer NOT NULL DEFAULT 30 CHECK (credit_days >= 0),
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_buyers_active ON master.buyers(is_active, company_name);
CREATE FUNCTION master.check_buyer_user_role()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM auth.assert_role(NEW.user_id, ARRAY['BUYER'], 'master.buyers.user_id');
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_buyer_user_role BEFORE INSERT OR UPDATE OF user_id ON master.buyers
FOR EACH ROW EXECUTE FUNCTION master.check_buyer_user_role();

CREATE TABLE master.buyer_addresses (
    address_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    buyer_id      bigint NOT NULL REFERENCES master.buyers(buyer_id),
    address_type  text NOT NULL CHECK (address_type IN ('BILLING','SHIPPING','BOTH')),
    label         text,
    line1         text NOT NULL,
    line2         text,
    city          text NOT NULL,
    state         text NOT NULL,
    pincode       text NOT NULL,
    country       text NOT NULL DEFAULT 'India',
    is_default    boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_buyer_addresses_buyer ON master.buyer_addresses(buyer_id);
CREATE UNIQUE INDEX ux_buyer_default_address
ON master.buyer_addresses(buyer_id, address_type) WHERE is_default;

CREATE TABLE master.yarn_types (
    yarn_type_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    yarn_code          text NOT NULL UNIQUE,
    yarn_name          text NOT NULL UNIQUE,
    material           text NOT NULL,
    yarn_count         text,
    hsn_code           text,
    reorder_level_kg   numeric(12,3) CHECK (reorder_level_kg IS NULL OR reorder_level_kg >= 0),
    is_active          boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE master.colours (
    colour_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    colour_name  text NOT NULL UNIQUE,
    hex_code     text CHECK (hex_code IS NULL OR hex_code ~ '^#[0-9A-Fa-f]{6}$'),
    is_active    boolean NOT NULL DEFAULT true
);

CREATE TABLE master.fabric_types (
    fabric_type_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fabric_code            text NOT NULL UNIQUE,
    fabric_name            text NOT NULL UNIQUE,
    weave                  text,
    gsm                    integer CHECK (gsm IS NULL OR gsm > 0),
    width_inch             numeric(7,2) CHECK (width_inch IS NULL OR width_inch > 0),
    hsn_code               text,
    default_rate_per_meter numeric(12,2) NOT NULL DEFAULT 0 CHECK (default_rate_per_meter >= 0),
    default_tax_percent    numeric(5,2) NOT NULL DEFAULT 5 CHECK (default_tax_percent BETWEEN 0 AND 100),
    is_active              boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE master.fabric_bom (
    bom_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fabric_type_id   bigint NOT NULL REFERENCES master.fabric_types(fabric_type_id),
    yarn_type_id     bigint NOT NULL REFERENCES master.yarn_types(yarn_type_id),
    kg_per_meter     numeric(10,5) NOT NULL CHECK (kg_per_meter > 0),
    wastage_percent  numeric(5,2) NOT NULL DEFAULT 3 CHECK (wastage_percent BETWEEN 0 AND 100),
    UNIQUE (fabric_type_id, yarn_type_id)
);

CREATE TABLE master.shifts (
    shift_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shift_name  text NOT NULL UNIQUE,
    start_time  time NOT NULL,
    end_time    time NOT NULL,
    is_active   boolean NOT NULL DEFAULT true,
    CHECK (start_time <> end_time)
);

CREATE TABLE master.machines (
    machine_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    machine_code      text NOT NULL UNIQUE DEFAULT core.fmt_doc('MC', nextval('master.seq_machine_code')),
    machine_name      text NOT NULL,
    stage             text NOT NULL CHECK (stage IN ('SPINNING','WEAVING','DYEING')),
    capacity_per_hour numeric(12,3) CHECK (capacity_per_hour IS NULL OR capacity_per_hour > 0),
    location          text,
    status            text NOT NULL DEFAULT 'IDLE' CHECK (status IN ('RUNNING','IDLE','BREAKDOWN','MAINTENANCE')),
    commissioned_on   date,
    is_active         boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_machines_stage_status ON master.machines(stage, status, is_active);

CREATE TABLE master.defect_types (
    defect_type_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    defect_name      text NOT NULL UNIQUE,
    default_severity text NOT NULL DEFAULT 'MINOR' CHECK (default_severity IN ('MINOR','MAJOR','CRITICAL')),
    is_active        boolean NOT NULL DEFAULT true
);
INSERT INTO master.defect_types(defect_name, default_severity) VALUES
 ('Hole','MAJOR'), ('Colour Mismatch','MAJOR'), ('Uneven Weaving','MAJOR'),
 ('Stain','MINOR'), ('Broken Thread','MINOR'), ('Uneven Dyeing','MAJOR'), ('Other','MINOR')
ON CONFLICT (defect_name) DO NOTHING;

CREATE TABLE master.stock_locations (
    location_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    location_code text NOT NULL UNIQUE,
    location_name text NOT NULL UNIQUE,
    description   text,
    is_active     boolean NOT NULL DEFAULT true
);
INSERT INTO master.stock_locations(location_code, location_name) VALUES
 ('RAW-STORE','Raw Material Store'), ('FG-STORE','Finished Goods Store'), ('QC-HOLD','Quality Hold Area')
ON CONFLICT DO NOTHING;

/* --------------------------------------------------------------------------
   4. HR: workers, attendance, wages
   -------------------------------------------------------------------------- */
CREATE TABLE hr.workers (
    worker_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_code       text NOT NULL UNIQUE DEFAULT core.fmt_doc('EMP', nextval('hr.seq_employee_code')),
    user_id             bigint NOT NULL UNIQUE REFERENCES auth.users(user_id),
    designation         text,
    skill_stage         text CHECK (skill_stage IS NULL OR skill_stage IN ('SPINNING','WEAVING','DYEING')),
    default_shift_id    bigint REFERENCES master.shifts(shift_id),
    wage_type           text NOT NULL DEFAULT 'DAILY' CHECK (wage_type IN ('DAILY','HOURLY')),
    daily_rate          numeric(10,2) CHECK (daily_rate IS NULL OR daily_rate >= 0),
    hourly_rate         numeric(10,2) CHECK (hourly_rate IS NULL OR hourly_rate >= 0),
    overtime_multiplier numeric(4,2) NOT NULL DEFAULT 1.5 CHECK (overtime_multiplier >= 1),
    joined_on           date NOT NULL DEFAULT current_date,
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK ((wage_type = 'DAILY' AND daily_rate IS NOT NULL) OR
           (wage_type = 'HOURLY' AND hourly_rate IS NOT NULL))
);
CREATE FUNCTION hr.check_worker_user_role()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM auth.assert_role(NEW.user_id, ARRAY['WORKER'], 'hr.workers.user_id');
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_worker_user_role BEFORE INSERT OR UPDATE OF user_id ON hr.workers
FOR EACH ROW EXECUTE FUNCTION hr.check_worker_user_role();

CREATE TABLE hr.attendance (
    attendance_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_id       bigint NOT NULL REFERENCES hr.workers(worker_id),
    work_date       date NOT NULL DEFAULT current_date,
    shift_id        bigint NOT NULL REFERENCES master.shifts(shift_id),
    status          text NOT NULL DEFAULT 'PRESENT' CHECK (status IN ('PRESENT','ABSENT','HALF_DAY','LEAVE')),
    check_in        timestamptz,
    check_out       timestamptz,
    regular_hours   numeric(6,2) NOT NULL DEFAULT 0 CHECK (regular_hours >= 0),
    overtime_hours  numeric(6,2) NOT NULL DEFAULT 0 CHECK (overtime_hours >= 0),
    wage_amount     numeric(12,2) NOT NULL DEFAULT 0 CHECK (wage_amount >= 0),
    marked_by       bigint REFERENCES auth.users(user_id),
    remarks         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (worker_id, work_date, shift_id),
    CHECK (check_in IS NULL OR check_out IS NULL OR check_out >= check_in)
);
CREATE INDEX ix_attendance_work_date ON hr.attendance(work_date, shift_id);

CREATE FUNCTION hr.calculate_attendance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w hr.workers%ROWTYPE; v_std numeric;
BEGIN
    SELECT * INTO w FROM hr.workers WHERE worker_id = NEW.worker_id;
    SELECT setting_value::numeric INTO v_std FROM core.app_settings WHERE setting_key = 'standard_shift_hours';
    v_std := COALESCE(v_std, 8);
    IF NEW.check_in IS NOT NULL AND NEW.check_out IS NOT NULL THEN
        NEW.regular_hours := LEAST(v_std, round(EXTRACT(EPOCH FROM (NEW.check_out - NEW.check_in))/3600.0, 2));
        NEW.overtime_hours := GREATEST(0, round(EXTRACT(EPOCH FROM (NEW.check_out - NEW.check_in))/3600.0, 2) - v_std);
    END IF;
    IF NEW.status IN ('ABSENT','LEAVE') THEN
        NEW.wage_amount := 0;
    ELSIF w.wage_type = 'DAILY' THEN
        NEW.wage_amount := round(COALESCE(w.daily_rate,0) * CASE WHEN NEW.status='HALF_DAY' THEN 0.5 ELSE 1 END
          + NEW.overtime_hours * (COALESCE(w.daily_rate,0) / v_std) * w.overtime_multiplier, 2);
    ELSE
        NEW.wage_amount := round((NEW.regular_hours + NEW.overtime_hours) * COALESCE(w.hourly_rate,0)
          + NEW.overtime_hours * COALESCE(w.hourly_rate,0) * (w.overtime_multiplier - 1), 2);
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_calculate_attendance BEFORE INSERT OR UPDATE ON hr.attendance
FOR EACH ROW EXECUTE FUNCTION hr.calculate_attendance();

CREATE TABLE hr.wage_payments (
    wage_payment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wage_no         text NOT NULL UNIQUE DEFAULT core.fmt_doc('WAGE', nextval('hr.seq_wage_no')),
    worker_id       bigint NOT NULL REFERENCES hr.workers(worker_id),
    period_start    date NOT NULL,
    period_end      date NOT NULL,
    gross_amount    numeric(14,2) NOT NULL CHECK (gross_amount >= 0),
    deductions      numeric(14,2) NOT NULL DEFAULT 0 CHECK (deductions >= 0),
    net_amount      numeric(14,2) GENERATED ALWAYS AS (gross_amount - deductions) STORED,
    status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','CANCELLED')),
    paid_at         timestamptz,
    payment_method  text CHECK (payment_method IN ('CASH','BANK_TRANSFER','UPI','OTHER')),
    created_by      bigint REFERENCES auth.users(user_id),
    paid_by         bigint REFERENCES auth.users(user_id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (period_end >= period_start),
    CHECK (deductions <= gross_amount),
    CHECK (status <> 'PAID' OR (paid_at IS NOT NULL AND payment_method IS NOT NULL)),
    UNIQUE (worker_id, period_start, period_end)
);

/* --------------------------------------------------------------------------
   5. Sales: customer orders and line items
   -------------------------------------------------------------------------- */
CREATE TABLE sales.orders (
    order_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_no            text NOT NULL UNIQUE DEFAULT core.fmt_doc('ORD', nextval('sales.seq_order_no')),
    buyer_id            bigint NOT NULL REFERENCES master.buyers(buyer_id),
    placed_by           bigint NOT NULL REFERENCES auth.users(user_id),
    order_date          date NOT NULL DEFAULT current_date,
    required_by_date    date NOT NULL,
    shipping_address_id bigint REFERENCES master.buyer_addresses(address_id),
    ship_to_snapshot    jsonb,
    status              text NOT NULL DEFAULT 'PLACED' CHECK (status IN
       ('PLACED','CONFIRMED','AWAITING_MATERIAL','IN_PRODUCTION','IN_QC','READY_TO_SHIP',
        'PARTIALLY_SHIPPED','SHIPPED','DELIVERED','CANCELLED')),
    priority            text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
    confirmed_by        bigint REFERENCES auth.users(user_id),
    confirmed_at        timestamptz,
    cancel_reason       text,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (required_by_date >= order_date),
    CHECK (status <> 'CANCELLED' OR NULLIF(btrim(cancel_reason),'') IS NOT NULL)
);
CREATE INDEX ix_orders_buyer_date ON sales.orders(buyer_id, order_date DESC);
CREATE INDEX ix_orders_status_due ON sales.orders(status, required_by_date);

CREATE TABLE sales.order_items (
    order_item_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id       bigint NOT NULL REFERENCES sales.orders(order_id),
    line_no        integer NOT NULL CHECK (line_no > 0),
    fabric_type_id bigint NOT NULL REFERENCES master.fabric_types(fabric_type_id),
    colour_id      bigint NOT NULL REFERENCES master.colours(colour_id),
    quantity_m     numeric(12,2) NOT NULL CHECK (quantity_m > 0),
    rate_per_m     numeric(12,2) NOT NULL CHECK (rate_per_m >= 0),
    tax_percent    numeric(5,2) NOT NULL DEFAULT 5 CHECK (tax_percent BETWEEN 0 AND 100),
    line_subtotal  numeric(14,2) GENERATED ALWAYS AS (round(quantity_m * rate_per_m, 2)) STORED,
    line_tax       numeric(14,2) GENERATED ALWAYS AS (round(quantity_m * rate_per_m * tax_percent / 100, 2)) STORED,
    line_total     numeric(14,2) GENERATED ALWAYS AS
                   (round(quantity_m * rate_per_m, 2) + round(quantity_m * rate_per_m * tax_percent / 100, 2)) STORED,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (order_id, line_no)
);
CREATE INDEX ix_order_items_fabric_colour ON sales.order_items(fabric_type_id, colour_id);

CREATE TABLE sales.order_status_history (
    history_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id   bigint NOT NULL REFERENCES sales.orders(order_id),
    old_status text,
    new_status text NOT NULL,
    changed_by bigint REFERENCES auth.users(user_id),
    changed_at timestamptz NOT NULL DEFAULT now(),
    remarks    text
);
CREATE INDEX ix_order_history_order_time ON sales.order_status_history(order_id, changed_at DESC);

CREATE FUNCTION sales.validate_order()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_buyer_user bigint; v_address_buyer bigint; v_address_snapshot jsonb;
BEGIN
    SELECT user_id INTO v_buyer_user FROM master.buyers WHERE buyer_id = NEW.buyer_id AND is_active;
    IF v_buyer_user IS NULL THEN RAISE EXCEPTION 'Buyer is missing or inactive'; END IF;
    IF NOT auth.user_has_role(NEW.placed_by, ARRAY['BUYER','OWNER']) THEN
        RAISE EXCEPTION 'Only a buyer or owner may place an order' USING ERRCODE = '42501';
    END IF;
    IF auth.user_has_role(NEW.placed_by, ARRAY['BUYER']) AND NEW.placed_by <> v_buyer_user THEN
        RAISE EXCEPTION 'A buyer may only place orders for their own buyer account' USING ERRCODE = '42501';
    END IF;
    IF NEW.shipping_address_id IS NOT NULL THEN
        SELECT a.buyer_id,
               jsonb_build_object('address_type',a.address_type,'label',a.label,'line1',a.line1,'line2',a.line2,
                                  'city',a.city,'state',a.state,'pincode',a.pincode,'country',a.country)
          INTO v_address_buyer, v_address_snapshot
          FROM master.buyer_addresses a WHERE a.address_id = NEW.shipping_address_id;
        IF v_address_buyer IS DISTINCT FROM NEW.buyer_id THEN
            RAISE EXCEPTION 'Shipping address does not belong to this buyer';
        END IF;
        NEW.ship_to_snapshot := v_address_snapshot;
    ELSE
        NEW.ship_to_snapshot := NULL;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_order BEFORE INSERT ON sales.orders
FOR EACH ROW EXECUTE FUNCTION sales.validate_order();

CREATE FUNCTION sales.log_order_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO sales.order_status_history(order_id, old_status, new_status, changed_by, remarks)
    VALUES (NEW.order_id, NULL, NEW.status, NEW.placed_by, 'Order created');
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_order_insert_history AFTER INSERT ON sales.orders
FOR EACH ROW EXECUTE FUNCTION sales.log_order_insert();

CREATE FUNCTION sales.log_order_status_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO sales.order_status_history(order_id, old_status, new_status, changed_by)
        VALUES (NEW.order_id, OLD.status, NEW.status, COALESCE(core.current_actor_id(), NEW.confirmed_by, NEW.placed_by));
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_order_status_history AFTER UPDATE OF status ON sales.orders
FOR EACH ROW EXECUTE FUNCTION sales.log_order_status_change();

/* --------------------------------------------------------------------------
   6. Procurement: purchase orders and received goods
   -------------------------------------------------------------------------- */
CREATE TABLE procurement.purchase_orders (
    purchase_order_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    po_no             text NOT NULL UNIQUE DEFAULT core.fmt_doc('PO', nextval('procurement.seq_po_no')),
    supplier_id       bigint NOT NULL REFERENCES master.suppliers(supplier_id),
    purchase_type     text NOT NULL CHECK (purchase_type IN ('ORDER_SPECIFIC','GENERAL')),
    linked_order_id   bigint REFERENCES sales.orders(order_id),
    status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ISSUED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
    order_date        date NOT NULL DEFAULT current_date,
    expected_date     date,
    created_by        bigint NOT NULL REFERENCES auth.users(user_id),
    issued_by         bigint REFERENCES auth.users(user_id),
    issued_at         timestamptz,
    notes             text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CHECK ((purchase_type = 'ORDER_SPECIFIC' AND linked_order_id IS NOT NULL) OR
           (purchase_type = 'GENERAL' AND linked_order_id IS NULL)),
    CHECK (expected_date IS NULL OR expected_date >= order_date),
    CHECK (status <> 'ISSUED' OR (issued_by IS NOT NULL AND issued_at IS NOT NULL))
);
CREATE INDEX ix_purchase_orders_supplier_status ON procurement.purchase_orders(supplier_id, status, order_date DESC);

CREATE TABLE procurement.purchase_order_items (
    po_item_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    purchase_order_id bigint NOT NULL REFERENCES procurement.purchase_orders(purchase_order_id),
    line_no          integer NOT NULL CHECK (line_no > 0),
    yarn_type_id     bigint NOT NULL REFERENCES master.yarn_types(yarn_type_id),
    colour_id        bigint REFERENCES master.colours(colour_id),
    ordered_qty_kg   numeric(12,3) NOT NULL CHECK (ordered_qty_kg > 0),
    unit_rate        numeric(12,4) NOT NULL CHECK (unit_rate >= 0),
    tax_percent      numeric(5,2) NOT NULL DEFAULT 5 CHECK (tax_percent BETWEEN 0 AND 100),
    line_subtotal    numeric(14,2) GENERATED ALWAYS AS (round(ordered_qty_kg * unit_rate, 2)) STORED,
    line_tax         numeric(14,2) GENERATED ALWAYS AS (round(ordered_qty_kg * unit_rate * tax_percent / 100, 2)) STORED,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (purchase_order_id, line_no)
);
CREATE INDEX ix_po_items_yarn_type ON procurement.purchase_order_items(yarn_type_id);

CREATE FUNCTION procurement.validate_purchase_order()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM auth.assert_role(NEW.created_by, ARRAY['STORE_MANAGER','OWNER'], 'purchase order creator');
    IF NEW.issued_by IS NOT NULL THEN
        PERFORM auth.assert_role(NEW.issued_by, ARRAY['STORE_MANAGER','OWNER'], 'purchase order issuer');
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_purchase_order BEFORE INSERT OR UPDATE OF created_by, issued_by ON procurement.purchase_orders
FOR EACH ROW EXECUTE FUNCTION procurement.validate_purchase_order();

/* --------------------------------------------------------------------------
   7. Inventory ledger and raw material lots
   -------------------------------------------------------------------------- */
CREATE TABLE inventory.yarn_lots (
    yarn_lot_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    lot_code          text NOT NULL UNIQUE DEFAULT core.fmt_doc('LOT', nextval('inventory.seq_lot_no')),
    yarn_type_id      bigint NOT NULL REFERENCES master.yarn_types(yarn_type_id),
    colour_id         bigint REFERENCES master.colours(colour_id),
    supplier_id       bigint NOT NULL REFERENCES master.suppliers(supplier_id),
    location_id       bigint NOT NULL REFERENCES master.stock_locations(location_id),
    received_on       date NOT NULL DEFAULT current_date,
    received_qty_kg   numeric(12,3) NOT NULL CHECK (received_qty_kg > 0),
    on_hand_qty_kg    numeric(12,3) NOT NULL DEFAULT 0 CHECK (on_hand_qty_kg >= 0),
    unit_cost_per_kg  numeric(12,4) NOT NULL CHECK (unit_cost_per_kg >= 0),
    status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DEPLETED','QUARANTINED')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_yarn_lots_type_colour ON inventory.yarn_lots(yarn_type_id, colour_id, location_id);
CREATE INDEX ix_yarn_lots_available ON inventory.yarn_lots(yarn_type_id, status) WHERE on_hand_qty_kg > 0;

CREATE TABLE inventory.stock_movements (
    stock_movement_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    yarn_lot_id       bigint NOT NULL REFERENCES inventory.yarn_lots(yarn_lot_id),
    movement_type     text NOT NULL CHECK (movement_type IN
        ('RECEIPT','ISSUE','RETURN_IN','ADJUSTMENT_IN','ADJUSTMENT_OUT','TRANSFER_IN','TRANSFER_OUT')),
    quantity_delta_kg numeric(12,3) NOT NULL CHECK (quantity_delta_kg <> 0),
    unit_cost_snapshot numeric(12,4) NOT NULL CHECK (unit_cost_snapshot >= 0),
    source_type       text NOT NULL,
    source_id         bigint,
    source_line_id    bigint,
    remarks           text,
    moved_by          bigint REFERENCES auth.users(user_id),
    moved_at          timestamptz NOT NULL DEFAULT now(),
    CHECK ((movement_type IN ('RECEIPT','RETURN_IN','ADJUSTMENT_IN','TRANSFER_IN') AND quantity_delta_kg > 0) OR
           (movement_type IN ('ISSUE','ADJUSTMENT_OUT','TRANSFER_OUT') AND quantity_delta_kg < 0))
);
CREATE INDEX ix_stock_movement_lot_time ON inventory.stock_movements(yarn_lot_id, moved_at DESC);
CREATE INDEX ix_stock_movement_source ON inventory.stock_movements(source_type, source_id, source_line_id);

CREATE FUNCTION inventory.apply_stock_movement()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_new_balance numeric(12,3);
BEGIN
    UPDATE inventory.yarn_lots
       SET on_hand_qty_kg = on_hand_qty_kg + NEW.quantity_delta_kg,
           status = CASE WHEN on_hand_qty_kg + NEW.quantity_delta_kg = 0 THEN 'DEPLETED'
                         WHEN status = 'DEPLETED' AND on_hand_qty_kg + NEW.quantity_delta_kg > 0 THEN 'ACTIVE'
                         ELSE status END
     WHERE yarn_lot_id = NEW.yarn_lot_id
       AND on_hand_qty_kg + NEW.quantity_delta_kg >= 0
    RETURNING on_hand_qty_kg INTO v_new_balance;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Stock movement would make yarn lot % negative or lot does not exist', NEW.yarn_lot_id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_apply_stock_movement AFTER INSERT ON inventory.stock_movements
FOR EACH ROW EXECUTE FUNCTION inventory.apply_stock_movement();

CREATE FUNCTION inventory.prevent_stock_movement_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Stock movements are append-only; post a correcting movement instead.';
END;
$$;
CREATE TRIGGER trg_stock_movement_no_update_delete BEFORE UPDATE OR DELETE ON inventory.stock_movements
FOR EACH ROW EXECUTE FUNCTION inventory.prevent_stock_movement_mutation();

CREATE TABLE inventory.yarn_reservations (
    reservation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_item_id  bigint NOT NULL REFERENCES sales.order_items(order_item_id),
    yarn_type_id   bigint NOT NULL REFERENCES master.yarn_types(yarn_type_id),
    quantity_kg    numeric(12,3) NOT NULL CHECK (quantity_kg > 0),
    status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED','CONSUMED')),
    reserved_by    bigint REFERENCES auth.users(user_id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    released_at    timestamptz,
    notes          text,
    CHECK ((status = 'ACTIVE' AND released_at IS NULL) OR status <> 'ACTIVE')
);
CREATE INDEX ix_yarn_reservations_active ON inventory.yarn_reservations(yarn_type_id, status) WHERE status = 'ACTIVE';

/* Goods-receipt records are created by Store Manager. A receipt line is posted
   through procurement.receive_purchase_order_item(), which creates the lot and
   the stock-ledger movement in one transaction. */
CREATE TABLE procurement.goods_receipts (
    goods_receipt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    grn_no           text NOT NULL UNIQUE DEFAULT core.fmt_doc('GRN', nextval('procurement.seq_grn_no')),
    purchase_order_id bigint NOT NULL REFERENCES procurement.purchase_orders(purchase_order_id),
    received_at      timestamptz NOT NULL DEFAULT now(),
    delivery_note_no text,
    received_by      bigint NOT NULL REFERENCES auth.users(user_id),
    notes            text,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_grn_po ON procurement.goods_receipts(purchase_order_id, received_at DESC);

CREATE TABLE procurement.goods_receipt_items (
    goods_receipt_item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    goods_receipt_id      bigint NOT NULL REFERENCES procurement.goods_receipts(goods_receipt_id),
    po_item_id            bigint NOT NULL REFERENCES procurement.purchase_order_items(po_item_id),
    line_no               integer NOT NULL CHECK (line_no > 0),
    received_qty_kg       numeric(12,3) NOT NULL CHECK (received_qty_kg > 0),
    accepted_qty_kg       numeric(12,3) NOT NULL CHECK (accepted_qty_kg >= 0 AND accepted_qty_kg <= received_qty_kg),
    unit_cost_per_kg      numeric(12,4) NOT NULL CHECK (unit_cost_per_kg >= 0),
    yarn_lot_id           bigint UNIQUE REFERENCES inventory.yarn_lots(yarn_lot_id),
    recorded_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (goods_receipt_id, line_no)
);
CREATE INDEX ix_grn_items_po_item ON procurement.goods_receipt_items(po_item_id);

CREATE FUNCTION procurement.validate_goods_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM auth.assert_role(NEW.received_by, ARRAY['STORE_MANAGER','OWNER'], 'goods receipt operator');
    IF NOT EXISTS (
        SELECT 1 FROM procurement.purchase_orders po
        WHERE po.purchase_order_id = NEW.purchase_order_id AND po.status IN ('ISSUED','PARTIALLY_RECEIVED')
    ) THEN
        RAISE EXCEPTION 'Goods can only be received against an ISSUED or PARTIALLY_RECEIVED PO';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_goods_receipt BEFORE INSERT OR UPDATE OF received_by, purchase_order_id ON procurement.goods_receipts
FOR EACH ROW EXECUTE FUNCTION procurement.validate_goods_receipt();

/* --------------------------------------------------------------------------
   8. Production: jobs, machine assignments, worker assignments, logs and rolls
   -------------------------------------------------------------------------- */
CREATE TABLE production.jobs (
    job_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_no         text NOT NULL UNIQUE DEFAULT core.fmt_doc('JOB', nextval('production.seq_job_no')),
    order_item_id  bigint NOT NULL REFERENCES sales.order_items(order_item_id),
    stage          text NOT NULL CHECK (stage IN ('SPINNING','WEAVING','DYEING')),
    planned_meters numeric(12,2) NOT NULL CHECK (planned_meters > 0),
    status         text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','ASSIGNED','IN_PROGRESS','PAUSED','COMPLETED','CANCELLED')),
    planned_start  timestamptz,
    planned_end    timestamptz,
    started_at     timestamptz,
    completed_at   timestamptz,
    created_by     bigint NOT NULL REFERENCES auth.users(user_id),
    notes          text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (planned_end IS NULL OR planned_start IS NULL OR planned_end >= planned_start),
    CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL)
);
CREATE INDEX ix_jobs_order_status ON production.jobs(order_item_id, status);
CREATE INDEX ix_jobs_stage_status ON production.jobs(stage, status);

CREATE FUNCTION production.validate_job_creator()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM auth.assert_role(NEW.created_by, ARRAY['SUPERVISOR','OWNER'], 'production job creator');
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_job_creator BEFORE INSERT OR UPDATE OF created_by ON production.jobs
FOR EACH ROW EXECUTE FUNCTION production.validate_job_creator();

CREATE TABLE production.machine_assignments (
    machine_assignment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id               bigint NOT NULL REFERENCES production.jobs(job_id),
    machine_id           bigint NOT NULL REFERENCES master.machines(machine_id),
    shift_id             bigint NOT NULL REFERENCES master.shifts(shift_id),
    assigned_by          bigint NOT NULL REFERENCES auth.users(user_id),
    status               text NOT NULL DEFAULT 'ASSIGNED' CHECK (status IN ('ASSIGNED','RUNNING','PAUSED','COMPLETED','CANCELLED')),
    assigned_at          timestamptz NOT NULL DEFAULT now(),
    started_at           timestamptz,
    ended_at             timestamptz,
    started_by           bigint REFERENCES auth.users(user_id),
    ended_by             bigint REFERENCES auth.users(user_id),
    notes                text,
    CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX ix_machine_assignments_job ON production.machine_assignments(job_id, status);
CREATE UNIQUE INDEX ux_machine_one_active_assignment
ON production.machine_assignments(machine_id)
WHERE status IN ('ASSIGNED','RUNNING','PAUSED');
CREATE UNIQUE INDEX ux_job_one_active_machine
ON production.machine_assignments(job_id)
WHERE status IN ('ASSIGNED','RUNNING','PAUSED');

CREATE FUNCTION production.validate_machine_assignment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_stage text; v_machine_stage text;
BEGIN
    PERFORM auth.assert_role(NEW.assigned_by, ARRAY['SUPERVISOR','OWNER'], 'machine assignment creator');
    SELECT stage INTO v_stage FROM production.jobs WHERE job_id = NEW.job_id;
    SELECT stage INTO v_machine_stage FROM master.machines WHERE machine_id = NEW.machine_id AND is_active;
    IF v_machine_stage IS NULL THEN RAISE EXCEPTION 'Machine does not exist or is inactive'; END IF;
    IF v_stage <> v_machine_stage THEN
        RAISE EXCEPTION 'Job stage % cannot be assigned to machine stage %', v_stage, v_machine_stage;
    END IF;
    IF NEW.started_by IS NOT NULL THEN PERFORM auth.assert_role(NEW.started_by, ARRAY['WORKER','SUPERVISOR','OWNER'], 'job starter'); END IF;
    IF NEW.ended_by IS NOT NULL THEN PERFORM auth.assert_role(NEW.ended_by, ARRAY['WORKER','SUPERVISOR','OWNER'], 'job stopper'); END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_machine_assignment BEFORE INSERT OR UPDATE OF job_id, machine_id, assigned_by, started_by, ended_by
ON production.machine_assignments FOR EACH ROW EXECUTE FUNCTION production.validate_machine_assignment();

CREATE TABLE production.job_worker_assignments (
    job_worker_assignment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    machine_assignment_id    bigint NOT NULL REFERENCES production.machine_assignments(machine_assignment_id),
    worker_id                bigint NOT NULL REFERENCES hr.workers(worker_id),
    assigned_by              bigint NOT NULL REFERENCES auth.users(user_id),
    assigned_at              timestamptz NOT NULL DEFAULT now(),
    started_at               timestamptz,
    ended_at                 timestamptz,
    notes                    text,
    CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX ix_job_worker_assignment_worker ON production.job_worker_assignments(worker_id, ended_at);
CREATE UNIQUE INDEX ux_worker_one_active_job
ON production.job_worker_assignments(worker_id) WHERE ended_at IS NULL;

CREATE TABLE production.production_logs (
    production_log_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    machine_assignment_id bigint NOT NULL REFERENCES production.machine_assignments(machine_assignment_id),
    worker_id         bigint NOT NULL REFERENCES hr.workers(worker_id),
    shift_id          bigint NOT NULL REFERENCES master.shifts(shift_id),
    produced_meters   numeric(12,2) NOT NULL CHECK (produced_meters >= 0),
    waste_meters      numeric(12,2) NOT NULL DEFAULT 0 CHECK (waste_meters >= 0),
    downtime_minutes  integer NOT NULL DEFAULT 0 CHECK (downtime_minutes >= 0),
    logged_at         timestamptz NOT NULL DEFAULT now(),
    remarks           text,
    CHECK (produced_meters + waste_meters > 0 OR downtime_minutes > 0)
);
CREATE INDEX ix_production_logs_assignment_time ON production.production_logs(machine_assignment_id, logged_at DESC);

CREATE TABLE production.rolls (
    roll_id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    roll_no              text NOT NULL UNIQUE DEFAULT core.fmt_doc('ROLL', nextval('production.seq_roll_no')),
    order_item_id        bigint NOT NULL REFERENCES sales.order_items(order_item_id),
    job_id               bigint NOT NULL REFERENCES production.jobs(job_id),
    production_log_id    bigint REFERENCES production.production_logs(production_log_id),
    machine_id           bigint NOT NULL REFERENCES master.machines(machine_id),
    shift_id             bigint NOT NULL REFERENCES master.shifts(shift_id),
    produced_by_worker_id bigint REFERENCES hr.workers(worker_id),
    length_meters        numeric(12,2) NOT NULL CHECK (length_meters > 0),
    weight_kg            numeric(12,3) CHECK (weight_kg IS NULL OR weight_kg > 0),
    current_status       text NOT NULL DEFAULT 'PENDING_QC'
                         CHECK (current_status IN ('PENDING_QC','PASSED','REWORK','REJECTED','DISPATCHED')),
    produced_at          timestamptz NOT NULL DEFAULT now(),
    label_qr_value       text UNIQUE,
    notes                text
);
CREATE INDEX ix_rolls_order_item_status ON production.rolls(order_item_id, current_status);
CREATE INDEX ix_rolls_job ON production.rolls(job_id, produced_at DESC);

CREATE FUNCTION production.validate_roll()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_job_item bigint; v_assignment_machine bigint;
BEGIN
    SELECT order_item_id INTO v_job_item FROM production.jobs WHERE job_id = NEW.job_id;
    IF v_job_item IS DISTINCT FROM NEW.order_item_id THEN
        RAISE EXCEPTION 'Roll order item must match its production job';
    END IF;
    IF NEW.production_log_id IS NOT NULL THEN
        SELECT ma.machine_id INTO v_assignment_machine
        FROM production.production_logs pl
        JOIN production.machine_assignments ma ON ma.machine_assignment_id = pl.machine_assignment_id
        WHERE pl.production_log_id = NEW.production_log_id;
        IF v_assignment_machine IS DISTINCT FROM NEW.machine_id THEN
            RAISE EXCEPTION 'Roll machine must match the production log assignment';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_roll BEFORE INSERT OR UPDATE OF order_item_id, job_id, production_log_id, machine_id
ON production.rolls FOR EACH ROW EXECUTE FUNCTION production.validate_roll();

CREATE TABLE production.machine_status_events (
    machine_status_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    machine_id              bigint NOT NULL REFERENCES master.machines(machine_id),
    old_status              text CHECK (old_status IS NULL OR old_status IN ('RUNNING','IDLE','BREAKDOWN','MAINTENANCE')),
    new_status              text NOT NULL CHECK (new_status IN ('RUNNING','IDLE','BREAKDOWN','MAINTENANCE')),
    reason                  text,
    started_at              timestamptz NOT NULL DEFAULT now(),
    ended_at                timestamptz,
    reported_by             bigint NOT NULL REFERENCES auth.users(user_id),
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX ix_machine_status_events_time ON production.machine_status_events(machine_id, started_at DESC);

/* Material issue tables come after production.jobs because they reference jobs. */
CREATE TABLE inventory.material_issues (
    material_issue_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_no          text NOT NULL UNIQUE DEFAULT core.fmt_doc('ISS', nextval('inventory.seq_issue_no')),
    job_id            bigint NOT NULL REFERENCES production.jobs(job_id),
    issued_by         bigint NOT NULL REFERENCES auth.users(user_id),
    issued_at         timestamptz NOT NULL DEFAULT now(),
    remarks           text
);
CREATE TABLE inventory.material_issue_items (
    material_issue_item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    material_issue_id      bigint NOT NULL REFERENCES inventory.material_issues(material_issue_id),
    yarn_lot_id            bigint NOT NULL REFERENCES inventory.yarn_lots(yarn_lot_id),
    quantity_kg            numeric(12,3) NOT NULL CHECK (quantity_kg > 0),
    unit_cost_snapshot     numeric(12,4) NOT NULL CHECK (unit_cost_snapshot >= 0),
    created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_material_issue_job ON inventory.material_issues(job_id, issued_at DESC);
CREATE INDEX ix_material_issue_item_lot ON inventory.material_issue_items(yarn_lot_id);

CREATE FUNCTION inventory.validate_material_issue()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM auth.assert_role(NEW.issued_by, ARRAY['STORE_MANAGER','SUPERVISOR','OWNER'], 'material issue operator');
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_material_issue BEFORE INSERT OR UPDATE OF issued_by ON inventory.material_issues
FOR EACH ROW EXECUTE FUNCTION inventory.validate_material_issue();

CREATE FUNCTION inventory.post_material_issue_item()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_unit_cost numeric(12,4); v_lot_type bigint; v_fabric_type bigint; v_job_status text;
BEGIN
    SELECT yl.unit_cost_per_kg, yl.yarn_type_id INTO v_unit_cost, v_lot_type
    FROM inventory.yarn_lots yl WHERE yl.yarn_lot_id = NEW.yarn_lot_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Yarn lot not found'; END IF;
    IF NEW.unit_cost_snapshot IS NULL THEN NEW.unit_cost_snapshot := v_unit_cost; END IF;
    SELECT j.status, ft.fabric_type_id INTO v_job_status, v_fabric_type
    FROM inventory.material_issues mi
    JOIN production.jobs j ON j.job_id = mi.job_id
    JOIN sales.order_items oi ON oi.order_item_id = j.order_item_id
    JOIN master.fabric_types ft ON ft.fabric_type_id = oi.fabric_type_id
    WHERE mi.material_issue_id = NEW.material_issue_id;
    IF v_job_status IS NULL THEN RAISE EXCEPTION 'Material issue job not found'; END IF;
    IF NOT EXISTS (SELECT 1 FROM master.fabric_bom b WHERE b.fabric_type_id = v_fabric_type AND b.yarn_type_id = v_lot_type) THEN
        RAISE EXCEPTION 'Yarn type is not in the fabric bill of materials for this job';
    END IF;
    INSERT INTO inventory.stock_movements(yarn_lot_id, movement_type, quantity_delta_kg,
       unit_cost_snapshot, source_type, source_id, source_line_id, moved_by, remarks)
    SELECT NEW.yarn_lot_id, 'ISSUE', -NEW.quantity_kg, NEW.unit_cost_snapshot,
           'MATERIAL_ISSUE', NEW.material_issue_id, NEW.material_issue_item_id,
           mi.issued_by, 'Yarn issued to production job'
    FROM inventory.material_issues mi WHERE mi.material_issue_id = NEW.material_issue_id;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_post_material_issue_item BEFORE INSERT ON inventory.material_issue_items
FOR EACH ROW EXECUTE FUNCTION inventory.post_material_issue_item();

/* A validated receiving workflow: creates receipt line, accepted yarn lot,
   stock movement, and updates the PO state inside the caller's transaction. */
CREATE FUNCTION procurement.receive_purchase_order_item(
    p_goods_receipt_id bigint,
    p_po_item_id bigint,
    p_received_qty_kg numeric,
    p_accepted_qty_kg numeric,
    p_unit_cost_per_kg numeric,
    p_line_no integer,
    p_lot_code text DEFAULT NULL,
    p_colour_id bigint DEFAULT NULL
) RETURNS TABLE (out_goods_receipt_item_id bigint, out_yarn_lot_id bigint)
LANGUAGE plpgsql AS $$
DECLARE
    v_po_id bigint;
    v_supplier_id bigint;
    v_yarn_type_id bigint;
    v_po_colour_id bigint;
    v_ordered_qty numeric(12,3);
    v_previous_received numeric(12,3);
    v_received_by bigint;
    v_location_id bigint;
    v_receipt_item_id bigint;
    v_lot_id bigint;
BEGIN
    IF p_received_qty_kg IS NULL OR p_received_qty_kg <= 0 THEN
        RAISE EXCEPTION 'Received quantity must be greater than zero';
    END IF;
    IF p_accepted_qty_kg IS NULL OR p_accepted_qty_kg < 0 OR p_accepted_qty_kg > p_received_qty_kg THEN
        RAISE EXCEPTION 'Accepted quantity must be between zero and received quantity';
    END IF;
    IF p_unit_cost_per_kg IS NULL OR p_unit_cost_per_kg < 0 OR p_line_no IS NULL OR p_line_no <= 0 THEN
        RAISE EXCEPTION 'Unit cost must be non-negative and line number must be positive';
    END IF;

    SELECT gr.purchase_order_id, gr.received_by
      INTO v_po_id, v_received_by
      FROM procurement.goods_receipts gr
     WHERE gr.goods_receipt_id = p_goods_receipt_id
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Goods receipt % was not found', p_goods_receipt_id; END IF;
    PERFORM auth.assert_role(v_received_by, ARRAY['STORE_MANAGER','OWNER'], 'goods receipt operator');

    SELECT po.supplier_id, poi.yarn_type_id, poi.colour_id, poi.ordered_qty_kg
      INTO v_supplier_id, v_yarn_type_id, v_po_colour_id, v_ordered_qty
      FROM procurement.purchase_order_items poi
      JOIN procurement.purchase_orders po ON po.purchase_order_id = poi.purchase_order_id
     WHERE poi.po_item_id = p_po_item_id
       AND poi.purchase_order_id = v_po_id
       AND po.status IN ('ISSUED','PARTIALLY_RECEIVED')
     FOR UPDATE OF poi, po;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PO line does not belong to this receipt or PO is not open for receiving';
    END IF;

    SELECT COALESCE(SUM(gri.received_qty_kg), 0)
      INTO v_previous_received
      FROM procurement.goods_receipt_items gri
     WHERE gri.po_item_id = p_po_item_id;
    IF v_previous_received + p_received_qty_kg > v_ordered_qty THEN
        RAISE EXCEPTION 'Receipt would exceed the PO line quantity. Ordered %, previously received %, new quantity %',
            v_ordered_qty, v_previous_received, p_received_qty_kg;
    END IF;

    INSERT INTO procurement.goods_receipt_items(
        goods_receipt_id, po_item_id, line_no, received_qty_kg,
        accepted_qty_kg, unit_cost_per_kg
    ) VALUES (
        p_goods_receipt_id, p_po_item_id, p_line_no, p_received_qty_kg,
        p_accepted_qty_kg, p_unit_cost_per_kg
    ) RETURNING goods_receipt_item_id INTO v_receipt_item_id;

    IF p_accepted_qty_kg > 0 THEN
        SELECT location_id INTO v_location_id
          FROM master.stock_locations
         WHERE location_code = 'RAW-STORE' AND is_active;
        IF v_location_id IS NULL THEN RAISE EXCEPTION 'Active RAW-STORE location is missing'; END IF;

        INSERT INTO inventory.yarn_lots(
            lot_code, yarn_type_id, colour_id, supplier_id, location_id,
            received_on, received_qty_kg, on_hand_qty_kg, unit_cost_per_kg, status
        ) VALUES (
            COALESCE(NULLIF(btrim(p_lot_code), ''), core.fmt_doc('LOT', nextval('inventory.seq_lot_no'))),
            v_yarn_type_id, COALESCE(p_colour_id, v_po_colour_id), v_supplier_id, v_location_id,
            current_date, p_accepted_qty_kg, 0, p_unit_cost_per_kg, 'ACTIVE'
        ) RETURNING yarn_lot_id INTO v_lot_id;

        UPDATE procurement.goods_receipt_items
           SET yarn_lot_id = v_lot_id
         WHERE goods_receipt_item_id = v_receipt_item_id;

        INSERT INTO inventory.stock_movements(
            yarn_lot_id, movement_type, quantity_delta_kg, unit_cost_snapshot,
            source_type, source_id, source_line_id, moved_by, remarks
        ) VALUES (
            v_lot_id, 'RECEIPT', p_accepted_qty_kg, p_unit_cost_per_kg,
            'GOODS_RECEIPT', p_goods_receipt_id, v_receipt_item_id, v_received_by,
            'Accepted raw material posted from goods receipt'
        );
    END IF;

    UPDATE procurement.purchase_orders po
       SET status = CASE
          WHEN EXISTS (
             SELECT 1 FROM procurement.purchase_order_items poi2
             WHERE poi2.purchase_order_id = po.purchase_order_id
               AND (SELECT COALESCE(SUM(gri2.received_qty_kg),0)
                    FROM procurement.goods_receipt_items gri2 WHERE gri2.po_item_id = poi2.po_item_id)
                   < poi2.ordered_qty_kg
          ) THEN 'PARTIALLY_RECEIVED'
          ELSE 'RECEIVED'
       END
     WHERE po.purchase_order_id = v_po_id;

    out_goods_receipt_item_id := v_receipt_item_id;
    out_yarn_lot_id := v_lot_id;
    RETURN NEXT;
END;
$$;

/* --------------------------------------------------------------------------
   9. Quality control and defects
   -------------------------------------------------------------------------- */
CREATE TABLE quality.inspections (
    inspection_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inspection_no text NOT NULL UNIQUE DEFAULT core.fmt_doc('QC', nextval('quality.seq_inspection_no')),
    roll_id       bigint NOT NULL REFERENCES production.rolls(roll_id),
    result        text NOT NULL CHECK (result IN ('PASS','REWORK','REJECT')),
    inspected_by  bigint NOT NULL REFERENCES auth.users(user_id),
    inspected_at  timestamptz NOT NULL DEFAULT now(),
    reason        text,
    rework_instructions text,
    notes         text,
    CHECK (result = 'PASS' OR NULLIF(btrim(reason), '') IS NOT NULL)
);
CREATE INDEX ix_inspections_roll_time ON quality.inspections(roll_id, inspected_at DESC);
CREATE INDEX ix_inspections_result_time ON quality.inspections(result, inspected_at DESC);

CREATE TABLE quality.inspection_defects (
    inspection_defect_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inspection_id        bigint NOT NULL REFERENCES quality.inspections(inspection_id),
    defect_type_id       bigint NOT NULL REFERENCES master.defect_types(defect_type_id),
    severity             text NOT NULL CHECK (severity IN ('MINOR','MAJOR','CRITICAL')),
    defect_count         integer NOT NULL DEFAULT 1 CHECK (defect_count > 0),
    notes                text,
    UNIQUE (inspection_id, defect_type_id, severity)
);

CREATE FUNCTION quality.apply_inspection_result()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
    PERFORM auth.assert_role(NEW.inspected_by, ARRAY['SUPERVISOR','OWNER'], 'quality inspector');
    SELECT current_status INTO v_status FROM production.rolls WHERE roll_id = NEW.roll_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Roll not found'; END IF;
    IF v_status = 'DISPATCHED' THEN RAISE EXCEPTION 'A dispatched roll cannot be reinspected'; END IF;
    UPDATE production.rolls
       SET current_status = CASE NEW.result WHEN 'PASS' THEN 'PASSED'
                                 WHEN 'REWORK' THEN 'REWORK' ELSE 'REJECTED' END
     WHERE roll_id = NEW.roll_id;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_apply_inspection_result BEFORE INSERT ON quality.inspections
FOR EACH ROW EXECUTE FUNCTION quality.apply_inspection_result();

/* --------------------------------------------------------------------------
   10. Dispatch and shipment tracking
   -------------------------------------------------------------------------- */
CREATE TABLE dispatch.shipments (
    shipment_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shipment_no     text NOT NULL UNIQUE DEFAULT core.fmt_doc('SHP', nextval('dispatch.seq_shipment_no')),
    order_id        bigint NOT NULL REFERENCES sales.orders(order_id),
    status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PACKED','SHIPPED','DELIVERED','CANCELLED')),
    carrier_name    text,
    vehicle_number  text,
    tracking_number text,
    delivery_note_no text,
    created_by      bigint NOT NULL REFERENCES auth.users(user_id),
    dispatched_by   bigint REFERENCES auth.users(user_id),
    packed_at       timestamptz,
    shipped_at      timestamptz,
    delivered_at    timestamptz,
    cancelled_at    timestamptz,
    cancellation_reason text,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (status <> 'SHIPPED' OR (shipped_at IS NOT NULL AND dispatched_by IS NOT NULL)),
    CHECK (status <> 'DELIVERED' OR delivered_at IS NOT NULL),
    CHECK (status <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND NULLIF(btrim(cancellation_reason),'') IS NOT NULL))
);
CREATE INDEX ix_shipments_order_status ON dispatch.shipments(order_id, status, created_at DESC);
CREATE INDEX ix_shipments_tracking ON dispatch.shipments(tracking_number) WHERE tracking_number IS NOT NULL;

CREATE TABLE dispatch.shipment_items (
    shipment_item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shipment_id      bigint NOT NULL REFERENCES dispatch.shipments(shipment_id),
    roll_id          bigint NOT NULL REFERENCES production.rolls(roll_id),
    packed_by        bigint REFERENCES auth.users(user_id),
    packed_at        timestamptz NOT NULL DEFAULT now(),
    notes            text,
    UNIQUE (shipment_id, roll_id)
);
CREATE INDEX ix_shipment_items_roll ON dispatch.shipment_items(roll_id);

CREATE FUNCTION dispatch.validate_shipment_creator()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM auth.assert_role(NEW.created_by, ARRAY['DISPATCH_OFFICER','OWNER'], 'shipment creator');
    IF NEW.dispatched_by IS NOT NULL THEN
        PERFORM auth.assert_role(NEW.dispatched_by, ARRAY['DISPATCH_OFFICER','OWNER'], 'dispatch confirmer');
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_shipment_creator BEFORE INSERT OR UPDATE OF created_by, dispatched_by ON dispatch.shipments
FOR EACH ROW EXECUTE FUNCTION dispatch.validate_shipment_creator();

CREATE FUNCTION dispatch.validate_shipment_item()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_ship_order_id bigint;
    v_roll_order_item bigint;
    v_roll_status text;
    v_ordered_qty numeric(12,2);
    v_already_reserved numeric(12,2);
    v_roll_length numeric(12,2);
BEGIN
    SELECT order_id INTO v_ship_order_id FROM dispatch.shipments
    WHERE shipment_id = NEW.shipment_id AND status IN ('DRAFT','PACKED') FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Shipment must be DRAFT or PACKED to add rolls'; END IF;
    IF EXISTS (SELECT 1 FROM sales.orders WHERE order_id = v_ship_order_id AND status = 'CANCELLED') THEN
        RAISE EXCEPTION 'Cannot add rolls to a shipment for a cancelled order';
    END IF;

    SELECT order_item_id, current_status, length_meters
      INTO v_roll_order_item, v_roll_status, v_roll_length
      FROM production.rolls WHERE roll_id = NEW.roll_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Roll not found'; END IF;
    IF v_roll_status <> 'PASSED' THEN
        RAISE EXCEPTION 'Only QC-passed rolls can be packed. Roll status is %', v_roll_status;
    END IF;

    -- Lock the order line to prevent two concurrent shipments exceeding ordered quantity.
    SELECT oi.quantity_m INTO v_ordered_qty
    FROM sales.order_items oi
    WHERE oi.order_item_id = v_roll_order_item AND oi.order_id = v_ship_order_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Roll does not belong to the order for this shipment'; END IF;

    SELECT COALESCE(SUM(r.length_meters),0)
      INTO v_already_reserved
      FROM dispatch.shipment_items si
      JOIN dispatch.shipments sh ON sh.shipment_id = si.shipment_id
      JOIN production.rolls r ON r.roll_id = si.roll_id
     WHERE r.order_item_id = v_roll_order_item
       AND sh.status <> 'CANCELLED';
    IF EXISTS (
        SELECT 1 FROM dispatch.shipment_items si
        JOIN dispatch.shipments sh ON sh.shipment_id = si.shipment_id
        WHERE si.roll_id = NEW.roll_id AND sh.status <> 'CANCELLED'
    ) THEN
        RAISE EXCEPTION 'Roll is already reserved by another active shipment';
    END IF;
    IF v_already_reserved + v_roll_length > v_ordered_qty THEN
        RAISE EXCEPTION 'Packing this roll would exceed ordered quantity (% m)', v_ordered_qty;
    END IF;
    IF NEW.packed_by IS NOT NULL THEN
        PERFORM auth.assert_role(NEW.packed_by, ARRAY['DISPATCH_OFFICER','OWNER'], 'roll packer');
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_shipment_item BEFORE INSERT ON dispatch.shipment_items
FOR EACH ROW EXECUTE FUNCTION dispatch.validate_shipment_item();

CREATE FUNCTION dispatch.prepare_shipment_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_has_items boolean;
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'PACKED' THEN
        IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Only a DRAFT shipment can be marked PACKED'; END IF;
        SELECT EXISTS (SELECT 1 FROM dispatch.shipment_items WHERE shipment_id = NEW.shipment_id) INTO v_has_items;
        IF NOT v_has_items THEN RAISE EXCEPTION 'A shipment must contain at least one roll before packing'; END IF;
        IF NEW.packed_at IS NULL THEN NEW.packed_at := now(); END IF;
    ELSIF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'SHIPPED' THEN
        IF OLD.status <> 'PACKED' THEN RAISE EXCEPTION 'A shipment must be PACKED before it is SHIPPED'; END IF;
        PERFORM auth.assert_role(COALESCE(NEW.dispatched_by, core.current_actor_id()), ARRAY['DISPATCH_OFFICER','OWNER'], 'shipment dispatch');
        IF NEW.shipped_at IS NULL THEN NEW.shipped_at := now(); END IF;
        IF NEW.dispatched_by IS NULL THEN NEW.dispatched_by := core.current_actor_id(); END IF;
        SELECT EXISTS (SELECT 1 FROM dispatch.shipment_items WHERE shipment_id = NEW.shipment_id) INTO v_has_items;
        IF NOT v_has_items THEN RAISE EXCEPTION 'A shipment must contain at least one roll before shipping'; END IF;
        IF EXISTS (
            SELECT 1 FROM dispatch.shipment_items si
            JOIN production.rolls r ON r.roll_id = si.roll_id
            WHERE si.shipment_id = NEW.shipment_id AND r.current_status <> 'PASSED'
        ) THEN RAISE EXCEPTION 'Every roll must be QC-passed immediately before shipping'; END IF;
        IF EXISTS (SELECT 1 FROM sales.orders WHERE order_id = NEW.order_id AND status = 'CANCELLED') THEN
            RAISE EXCEPTION 'A cancelled customer order cannot be shipped';
        END IF;
    ELSIF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'DELIVERED' THEN
        IF OLD.status <> 'SHIPPED' THEN RAISE EXCEPTION 'Only a SHIPPED shipment can be marked DELIVERED'; END IF;
        IF NEW.delivered_at IS NULL THEN NEW.delivered_at := now(); END IF;
    ELSIF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'CANCELLED' THEN
        IF OLD.status IN ('SHIPPED','DELIVERED') THEN
            RAISE EXCEPTION 'A shipment that has shipped cannot be cancelled; handle it as a return or credit note';
        END IF;
        IF NEW.cancelled_at IS NULL THEN NEW.cancelled_at := now(); END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_prepare_shipment_status BEFORE UPDATE OF status ON dispatch.shipments
FOR EACH ROW EXECUTE FUNCTION dispatch.prepare_shipment_status();

CREATE FUNCTION dispatch.finish_shipment_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_total_order_qty numeric(14,2); v_total_shipped numeric(14,2);
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'SHIPPED' THEN
        UPDATE production.rolls r SET current_status = 'DISPATCHED'
        FROM dispatch.shipment_items si
        WHERE si.shipment_id = NEW.shipment_id AND si.roll_id = r.roll_id;

        SELECT COALESCE(SUM(oi.quantity_m),0) INTO v_total_order_qty
        FROM sales.order_items oi WHERE oi.order_id = NEW.order_id;
        SELECT COALESCE(SUM(r.length_meters),0) INTO v_total_shipped
        FROM dispatch.shipment_items si
        JOIN dispatch.shipments sh ON sh.shipment_id = si.shipment_id
        JOIN production.rolls r ON r.roll_id = si.roll_id
        WHERE sh.order_id = NEW.order_id AND sh.status IN ('SHIPPED','DELIVERED');
        UPDATE sales.orders
           SET status = CASE WHEN v_total_shipped >= v_total_order_qty THEN 'SHIPPED' ELSE 'PARTIALLY_SHIPPED' END
         WHERE order_id = NEW.order_id AND status NOT IN ('CANCELLED','DELIVERED');
    ELSIF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'DELIVERED' THEN
        UPDATE sales.orders o SET status = 'DELIVERED'
         WHERE o.order_id = NEW.order_id
           AND NOT EXISTS (
               SELECT 1 FROM dispatch.shipments sh
               WHERE sh.order_id = o.order_id AND sh.status NOT IN ('DELIVERED','CANCELLED')
           )
           AND EXISTS (
               SELECT 1 FROM dispatch.shipments sh
               WHERE sh.order_id = o.order_id AND sh.status = 'DELIVERED'
           );
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_finish_shipment_status AFTER UPDATE OF status ON dispatch.shipments
FOR EACH ROW EXECUTE FUNCTION dispatch.finish_shipment_status();

/* --------------------------------------------------------------------------
   11. Supplier invoice and payment tracking
   -------------------------------------------------------------------------- */
CREATE TABLE procurement.supplier_invoices (
    supplier_invoice_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    internal_invoice_no text NOT NULL UNIQUE DEFAULT core.fmt_doc('PINV', nextval('procurement.seq_supplier_invoice_no')),
    supplier_id         bigint NOT NULL REFERENCES master.suppliers(supplier_id),
    goods_receipt_id    bigint NOT NULL UNIQUE REFERENCES procurement.goods_receipts(goods_receipt_id),
    supplier_invoice_no text NOT NULL,
    invoice_date        date NOT NULL DEFAULT current_date,
    due_date            date,
    status              text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED','APPROVED','VOID')),
    recorded_by         bigint NOT NULL REFERENCES auth.users(user_id),
    approved_by         bigint REFERENCES auth.users(user_id),
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (supplier_id, supplier_invoice_no),
    CHECK (due_date IS NULL OR due_date >= invoice_date)
);
CREATE INDEX ix_supplier_invoices_supplier_status ON procurement.supplier_invoices(supplier_id, status, due_date);

CREATE TABLE procurement.supplier_invoice_items (
    supplier_invoice_item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    supplier_invoice_id     bigint NOT NULL REFERENCES procurement.supplier_invoices(supplier_invoice_id),
    goods_receipt_item_id   bigint NOT NULL REFERENCES procurement.goods_receipt_items(goods_receipt_item_id),
    billed_qty_kg            numeric(12,3) NOT NULL CHECK (billed_qty_kg > 0),
    unit_rate                numeric(12,4) NOT NULL CHECK (unit_rate >= 0),
    tax_percent              numeric(5,2) NOT NULL DEFAULT 5 CHECK (tax_percent BETWEEN 0 AND 100),
    line_subtotal            numeric(14,2) GENERATED ALWAYS AS (round(billed_qty_kg * unit_rate, 2)) STORED,
    line_tax                 numeric(14,2) GENERATED ALWAYS AS (round(billed_qty_kg * unit_rate * tax_percent / 100, 2)) STORED,
    line_total               numeric(14,2) GENERATED ALWAYS AS
                             (round(billed_qty_kg * unit_rate, 2) + round(billed_qty_kg * unit_rate * tax_percent / 100, 2)) STORED,
    UNIQUE (supplier_invoice_id, goods_receipt_item_id)
);

CREATE FUNCTION procurement.validate_supplier_invoice()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_supplier_id bigint; v_received_by bigint;
BEGIN
    PERFORM auth.assert_role(NEW.recorded_by, ARRAY['STORE_MANAGER','OWNER'], 'supplier invoice recorder');
    IF NEW.approved_by IS NOT NULL THEN PERFORM auth.assert_role(NEW.approved_by, ARRAY['STORE_MANAGER','OWNER'], 'supplier invoice approver'); END IF;
    SELECT po.supplier_id, gr.received_by INTO v_supplier_id, v_received_by
    FROM procurement.goods_receipts gr
    JOIN procurement.purchase_orders po ON po.purchase_order_id = gr.purchase_order_id
    WHERE gr.goods_receipt_id = NEW.goods_receipt_id;
    IF v_supplier_id IS DISTINCT FROM NEW.supplier_id THEN
        RAISE EXCEPTION 'Supplier invoice supplier must match the goods receipt PO supplier';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_supplier_invoice BEFORE INSERT OR UPDATE OF supplier_id, goods_receipt_id, recorded_by, approved_by
ON procurement.supplier_invoices FOR EACH ROW EXECUTE FUNCTION procurement.validate_supplier_invoice();

CREATE TABLE procurement.supplier_payments (
    supplier_payment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    payment_no          text NOT NULL UNIQUE DEFAULT core.fmt_doc('SPAY', nextval('procurement.seq_supplier_payment_no')),
    supplier_invoice_id bigint NOT NULL REFERENCES procurement.supplier_invoices(supplier_invoice_id),
    amount              numeric(14,2) NOT NULL CHECK (amount > 0),
    payment_date        date NOT NULL DEFAULT current_date,
    payment_method      text NOT NULL CHECK (payment_method IN ('BANK_TRANSFER','UPI','CHEQUE','CASH','OTHER')),
    payment_reference   text,
    status              text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('PENDING','COMPLETED','FAILED','CANCELLED')),
    recorded_by         bigint NOT NULL REFERENCES auth.users(user_id),
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_supplier_payments_invoice ON procurement.supplier_payments(supplier_invoice_id, status, payment_date);
CREATE FUNCTION procurement.validate_supplier_payment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM auth.assert_role(NEW.recorded_by, ARRAY['STORE_MANAGER','OWNER'], 'supplier payment recorder');
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_supplier_payment BEFORE INSERT OR UPDATE OF recorded_by ON procurement.supplier_payments
FOR EACH ROW EXECUTE FUNCTION procurement.validate_supplier_payment();

/* --------------------------------------------------------------------------
   12. Finance: customer invoices, gateway transactions, refunds, costs, expenses
   -------------------------------------------------------------------------- */
CREATE TABLE finance.customer_invoices (
    customer_invoice_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_no          text NOT NULL UNIQUE DEFAULT core.fmt_doc('INV', nextval('finance.seq_customer_invoice_no')),
    shipment_id         bigint NOT NULL UNIQUE REFERENCES dispatch.shipments(shipment_id),
    invoice_date        date NOT NULL DEFAULT current_date,
    due_date            date,
    status              text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ISSUED','VOID')),
    created_by          bigint NOT NULL REFERENCES auth.users(user_id),
    issued_at           timestamptz,
    voided_at           timestamptz,
    void_reason         text,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (due_date IS NULL OR due_date >= invoice_date),
    CHECK (status <> 'ISSUED' OR issued_at IS NOT NULL),
    CHECK (status <> 'VOID' OR (voided_at IS NOT NULL AND NULLIF(btrim(void_reason),'') IS NOT NULL))
);
CREATE INDEX ix_customer_invoices_status_due ON finance.customer_invoices(status, due_date);

CREATE TABLE finance.customer_invoice_lines (
    customer_invoice_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_invoice_id      bigint NOT NULL REFERENCES finance.customer_invoices(customer_invoice_id),
    shipment_item_id         bigint NOT NULL UNIQUE REFERENCES dispatch.shipment_items(shipment_item_id),
    description              text NOT NULL,
    quantity_m               numeric(12,2) NOT NULL CHECK (quantity_m > 0),
    rate_per_m               numeric(12,2) NOT NULL CHECK (rate_per_m >= 0),
    tax_percent              numeric(5,2) NOT NULL CHECK (tax_percent BETWEEN 0 AND 100),
    line_subtotal            numeric(14,2) GENERATED ALWAYS AS (round(quantity_m * rate_per_m, 2)) STORED,
    line_tax                 numeric(14,2) GENERATED ALWAYS AS (round(quantity_m * rate_per_m * tax_percent / 100, 2)) STORED,
    line_total               numeric(14,2) GENERATED ALWAYS AS
                            (round(quantity_m * rate_per_m, 2) + round(quantity_m * rate_per_m * tax_percent / 100, 2)) STORED
);
CREATE INDEX ix_customer_invoice_lines_invoice ON finance.customer_invoice_lines(customer_invoice_id);

CREATE FUNCTION finance.validate_customer_invoice()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_shipment_status text;
BEGIN
    PERFORM auth.assert_role(NEW.created_by, ARRAY['DISPATCH_OFFICER','OWNER'], 'customer invoice creator');
    SELECT status INTO v_shipment_status FROM dispatch.shipments WHERE shipment_id = NEW.shipment_id;
    IF v_shipment_status IS NULL THEN RAISE EXCEPTION 'Shipment does not exist'; END IF;
    IF TG_OP = 'INSERT' AND NEW.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Create customer invoice as DRAFT, add lines, then issue it';
    END IF;
    IF NEW.status = 'ISSUED' AND v_shipment_status NOT IN ('SHIPPED','DELIVERED') THEN
        RAISE EXCEPTION 'Customer invoice can only be issued after its shipment is shipped';
    END IF;
    IF NEW.status = 'ISSUED' AND NOT EXISTS (
        SELECT 1 FROM finance.customer_invoice_lines l WHERE l.customer_invoice_id = NEW.customer_invoice_id
    ) THEN
        RAISE EXCEPTION 'Cannot issue an invoice without invoice lines';
    END IF;
    IF NEW.status = 'ISSUED' AND NEW.issued_at IS NULL THEN NEW.issued_at := now(); END IF;
    IF NEW.status = 'VOID' AND NEW.voided_at IS NULL THEN NEW.voided_at := now(); END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_customer_invoice BEFORE INSERT OR UPDATE OF status, shipment_id, created_by
ON finance.customer_invoices FOR EACH ROW EXECUTE FUNCTION finance.validate_customer_invoice();

CREATE FUNCTION finance.validate_customer_invoice_line()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_invoice_status text; v_shipment_id bigint; v_roll_id bigint; v_order_item_id bigint;
        v_expected_qty numeric(12,2); v_expected_rate numeric(12,2); v_expected_tax numeric(5,2); v_expected_order bigint;
BEGIN
    SELECT ci.status, ci.shipment_id INTO v_invoice_status, v_shipment_id
    FROM finance.customer_invoices ci WHERE ci.customer_invoice_id = NEW.customer_invoice_id FOR UPDATE;
    IF v_invoice_status <> 'DRAFT' THEN RAISE EXCEPTION 'Invoice lines can only be added while invoice is DRAFT'; END IF;
    SELECT si.roll_id, r.order_item_id, r.length_meters, oi.rate_per_m, oi.tax_percent, o.order_id
      INTO v_roll_id, v_order_item_id, v_expected_qty, v_expected_rate, v_expected_tax, v_expected_order
      FROM dispatch.shipment_items si
      JOIN production.rolls r ON r.roll_id = si.roll_id
      JOIN sales.order_items oi ON oi.order_item_id = r.order_item_id
      JOIN sales.orders o ON o.order_id = oi.order_id
     WHERE si.shipment_item_id = NEW.shipment_item_id AND si.shipment_id = v_shipment_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice line shipment item must belong to the invoice shipment'; END IF;
    IF NEW.quantity_m IS DISTINCT FROM v_expected_qty OR NEW.rate_per_m IS DISTINCT FROM v_expected_rate
       OR NEW.tax_percent IS DISTINCT FROM v_expected_tax THEN
        RAISE EXCEPTION 'Invoice line quantity, rate and tax must match the shipped roll and accepted order price';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_customer_invoice_line BEFORE INSERT OR UPDATE ON finance.customer_invoice_lines
FOR EACH ROW EXECUTE FUNCTION finance.validate_customer_invoice_line();

CREATE TABLE finance.customer_payment_transactions (
    customer_payment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_invoice_id bigint NOT NULL REFERENCES finance.customer_invoices(customer_invoice_id),
    provider            text NOT NULL CHECK (provider IN ('PHONEPE','RAZORPAY','CASHFREE','UPI','BANK_TRANSFER','CASH','OTHER')),
    payment_method      text,
    amount              numeric(14,2) NOT NULL CHECK (amount > 0),
    currency_code       char(3) NOT NULL DEFAULT 'INR',
    status              text NOT NULL DEFAULT 'INITIATED' CHECK (status IN ('INITIATED','PENDING','SUCCESS','FAILED','CANCELLED')),
    gateway_order_id    text,
    gateway_payment_id  text,
    gateway_reference   text,
    signature_verified  boolean,
    gateway_response    jsonb,
    initiated_at        timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          bigint REFERENCES auth.users(user_id),
    notes               text,
    CHECK (status <> 'SUCCESS' OR completed_at IS NOT NULL)
);
CREATE INDEX ix_customer_payments_invoice_status ON finance.customer_payment_transactions(customer_invoice_id, status, initiated_at DESC);
CREATE UNIQUE INDEX ux_customer_payment_provider_id
ON finance.customer_payment_transactions(provider, gateway_payment_id)
WHERE gateway_payment_id IS NOT NULL;
CREATE UNIQUE INDEX ux_customer_payment_provider_order
ON finance.customer_payment_transactions(provider, gateway_order_id)
WHERE gateway_order_id IS NOT NULL;

CREATE FUNCTION finance.validate_customer_payment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_invoice_status text; v_buyer_user_id bigint;
BEGIN
    SELECT ci.status, b.user_id INTO v_invoice_status, v_buyer_user_id
    FROM finance.customer_invoices ci
    JOIN dispatch.shipments sh ON sh.shipment_id = ci.shipment_id
    JOIN sales.orders o ON o.order_id = sh.order_id
    JOIN master.buyers b ON b.buyer_id = o.buyer_id
    WHERE ci.customer_invoice_id = NEW.customer_invoice_id;
    IF v_invoice_status IS DISTINCT FROM 'ISSUED' THEN
        RAISE EXCEPTION 'Payment can only be initiated for an issued customer invoice';
    END IF;
    IF NEW.created_by IS NOT NULL AND auth.user_has_role(NEW.created_by, ARRAY['BUYER']) AND NEW.created_by <> v_buyer_user_id THEN
        RAISE EXCEPTION 'A buyer can only create a payment for their own invoice' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'SUCCESS' AND NEW.completed_at IS NULL THEN NEW.completed_at := now(); END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_customer_payment BEFORE INSERT OR UPDATE OF status, customer_invoice_id, created_by
ON finance.customer_payment_transactions FOR EACH ROW EXECUTE FUNCTION finance.validate_customer_payment();

CREATE TABLE finance.customer_refunds (
    customer_refund_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_payment_id bigint NOT NULL REFERENCES finance.customer_payment_transactions(customer_payment_id),
    amount              numeric(14,2) NOT NULL CHECK (amount > 0),
    status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCESS','FAILED')),
    provider_refund_id  text,
    reason              text,
    requested_at        timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz,
    processed_by        bigint REFERENCES auth.users(user_id),
    CHECK (status <> 'SUCCESS' OR completed_at IS NOT NULL)
);
CREATE UNIQUE INDEX ux_customer_refund_provider_id ON finance.customer_refunds(provider_refund_id) WHERE provider_refund_id IS NOT NULL;

CREATE TABLE finance.operating_expenses (
    expense_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    expense_no      text NOT NULL UNIQUE DEFAULT core.fmt_doc('EXP', nextval('finance.seq_expense_no')),
    expense_date    date NOT NULL DEFAULT current_date,
    category        text NOT NULL CHECK (category IN ('POWER','DYEING','MAINTENANCE','RENT','FREIGHT','ADMIN','OTHER')),
    description     text NOT NULL,
    amount          numeric(14,2) NOT NULL CHECK (amount >= 0),
    supplier_id     bigint REFERENCES master.suppliers(supplier_id),
    payment_status  text NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID','PARTIALLY_PAID','PAID')),
    payment_reference text,
    recorded_by     bigint NOT NULL REFERENCES auth.users(user_id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_expenses_date_category ON finance.operating_expenses(expense_date, category);

CREATE TABLE finance.order_cost_entries (
    order_cost_entry_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_item_id       bigint NOT NULL REFERENCES sales.order_items(order_item_id),
    job_id              bigint REFERENCES production.jobs(job_id),
    cost_type           text NOT NULL CHECK (cost_type IN ('LABOUR','POWER','DYEING','OVERHEAD','MAINTENANCE','FREIGHT','OTHER')),
    amount              numeric(14,2) NOT NULL CHECK (amount >= 0),
    occurred_on         date NOT NULL DEFAULT current_date,
    source_reference    text,
    notes               text,
    entered_by          bigint NOT NULL REFERENCES auth.users(user_id),
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_order_cost_entries_item_type ON finance.order_cost_entries(order_item_id, cost_type);

/* --------------------------------------------------------------------------
   13. Business functions: invoice generation and job start/stop helpers
   -------------------------------------------------------------------------- */
CREATE FUNCTION finance.create_customer_invoice(
    p_shipment_id bigint,
    p_created_by bigint,
    p_due_date date DEFAULT NULL,
    p_notes text DEFAULT NULL
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_invoice_id bigint; v_ship_status text;
BEGIN
    PERFORM auth.assert_role(p_created_by, ARRAY['DISPATCH_OFFICER','OWNER'], 'customer invoice creator');
    SELECT status INTO v_ship_status FROM dispatch.shipments WHERE shipment_id = p_shipment_id FOR UPDATE;
    IF v_ship_status NOT IN ('SHIPPED','DELIVERED') THEN
        RAISE EXCEPTION 'Shipment must be shipped before invoicing';
    END IF;
    IF EXISTS (SELECT 1 FROM finance.customer_invoices WHERE shipment_id = p_shipment_id) THEN
        RAISE EXCEPTION 'An invoice record already exists for this shipment; use a credit note for corrections';
    END IF;

    INSERT INTO finance.customer_invoices(shipment_id, invoice_date, due_date, status, created_by, notes)
    VALUES (p_shipment_id, current_date, p_due_date, 'DRAFT', p_created_by, p_notes)
    RETURNING customer_invoice_id INTO v_invoice_id;

    INSERT INTO finance.customer_invoice_lines(
        customer_invoice_id, shipment_item_id, description, quantity_m, rate_per_m, tax_percent
    )
    SELECT v_invoice_id, si.shipment_item_id,
           ft.fabric_name || ' / ' || c.colour_name || ' / ' || r.roll_no,
           r.length_meters, oi.rate_per_m, oi.tax_percent
    FROM dispatch.shipment_items si
    JOIN production.rolls r ON r.roll_id = si.roll_id
    JOIN sales.order_items oi ON oi.order_item_id = r.order_item_id
    JOIN master.fabric_types ft ON ft.fabric_type_id = oi.fabric_type_id
    JOIN master.colours c ON c.colour_id = oi.colour_id
    WHERE si.shipment_id = p_shipment_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'No shipment items found to invoice'; END IF;
    UPDATE finance.customer_invoices SET status = 'ISSUED', issued_at = now()
    WHERE customer_invoice_id = v_invoice_id;
    RETURN v_invoice_id;
END;
$$;

CREATE FUNCTION production.set_assignment_running(
    p_machine_assignment_id bigint,
    p_worker_user_id bigint
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_worker_id bigint;
BEGIN
    PERFORM auth.assert_role(p_worker_user_id, ARRAY['WORKER','SUPERVISOR','OWNER'], 'job starter');
    SELECT worker_id INTO v_worker_id FROM hr.workers WHERE user_id = p_worker_user_id AND is_active;
    UPDATE production.machine_assignments
       SET status = 'RUNNING', started_at = COALESCE(started_at, now()), started_by = p_worker_user_id
     WHERE machine_assignment_id = p_machine_assignment_id
       AND status IN ('ASSIGNED','PAUSED');
    IF NOT FOUND THEN RAISE EXCEPTION 'Assignment is not available to start'; END IF;
    UPDATE master.machines m SET status = 'RUNNING'
    FROM production.machine_assignments ma
    WHERE ma.machine_assignment_id = p_machine_assignment_id AND ma.machine_id = m.machine_id;
    UPDATE production.jobs j SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, now())
    FROM production.machine_assignments ma
    WHERE ma.machine_assignment_id = p_machine_assignment_id AND ma.job_id = j.job_id;
    IF v_worker_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM production.job_worker_assignments jwa
        WHERE jwa.machine_assignment_id = p_machine_assignment_id AND jwa.worker_id = v_worker_id AND jwa.ended_at IS NULL
    ) THEN
        INSERT INTO production.job_worker_assignments(machine_assignment_id, worker_id, assigned_by, started_at)
        VALUES (p_machine_assignment_id, v_worker_id, p_worker_user_id, now());
    END IF;
END;
$$;

CREATE FUNCTION production.stop_assignment(
    p_machine_assignment_id bigint,
    p_stopped_by bigint,
    p_mark_completed boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_machine_id bigint; v_job_id bigint; v_status text;
BEGIN
    PERFORM auth.assert_role(p_stopped_by, ARRAY['WORKER','SUPERVISOR','OWNER'], 'job stopper');
    SELECT machine_id, job_id, status INTO v_machine_id, v_job_id, v_status
    FROM production.machine_assignments WHERE machine_assignment_id = p_machine_assignment_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Machine assignment not found'; END IF;
    IF v_status NOT IN ('RUNNING','PAUSED','ASSIGNED') THEN RAISE EXCEPTION 'Assignment is already closed'; END IF;
    UPDATE production.machine_assignments
       SET status = CASE WHEN p_mark_completed THEN 'COMPLETED' ELSE 'PAUSED' END,
           ended_at = CASE WHEN p_mark_completed THEN now() ELSE NULL END,
           ended_by = p_stopped_by
     WHERE machine_assignment_id = p_machine_assignment_id;
    UPDATE production.job_worker_assignments SET ended_at = now()
    WHERE machine_assignment_id = p_machine_assignment_id AND ended_at IS NULL;
    UPDATE master.machines SET status = 'IDLE' WHERE machine_id = v_machine_id;
    IF p_mark_completed THEN
        UPDATE production.jobs SET status = 'COMPLETED', completed_at = now() WHERE job_id = v_job_id;
    ELSE
        UPDATE production.jobs SET status = 'PAUSED' WHERE job_id = v_job_id AND status <> 'COMPLETED';
    END IF;
END;
$$;

/* --------------------------------------------------------------------------
   14. Notifications and append-only audit trail
   -------------------------------------------------------------------------- */
CREATE TABLE notification.user_notifications (
    notification_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recipient_user_id bigint REFERENCES auth.users(user_id),
    recipient_role_code text REFERENCES auth.roles(role_code),
    category          text NOT NULL CHECK (category IN ('ORDER','STOCK','PRODUCTION','QUALITY','DISPATCH','PAYMENT','SYSTEM')),
    title             text NOT NULL,
    message           text NOT NULL,
    entity_type       text,
    entity_id         bigint,
    created_at        timestamptz NOT NULL DEFAULT now(),
    read_at           timestamptz,
    CHECK ((recipient_user_id IS NOT NULL) <> (recipient_role_code IS NOT NULL))
);
CREATE INDEX ix_notifications_user_unread ON notification.user_notifications(recipient_user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX ix_notifications_role_unread ON notification.user_notifications(recipient_role_code, created_at DESC) WHERE read_at IS NULL;

CREATE FUNCTION notification.notify_user(
    p_user_id bigint, p_category text, p_title text, p_message text,
    p_entity_type text DEFAULT NULL, p_entity_id bigint DEFAULT NULL
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
    INSERT INTO notification.user_notifications(recipient_user_id, category, title, message, entity_type, entity_id)
    VALUES (p_user_id, p_category, p_title, p_message, p_entity_type, p_entity_id)
    RETURNING notification_id INTO v_id;
    RETURN v_id;
END;
$$;

CREATE FUNCTION notification.notify_role(
    p_role_code text, p_category text, p_title text, p_message text,
    p_entity_type text DEFAULT NULL, p_entity_id bigint DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_count integer;
BEGIN
    INSERT INTO notification.user_notifications(recipient_role_code, category, title, message, entity_type, entity_id)
    SELECT p_role_code, p_category, p_title, p_message, p_entity_type, p_entity_id
    WHERE EXISTS (SELECT 1 FROM auth.roles WHERE role_code = p_role_code AND is_active);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

CREATE TABLE audit.change_log (
    audit_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id  bigint REFERENCES auth.users(user_id),
    action         text NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
    schema_name    text NOT NULL,
    table_name     text NOT NULL,
    record_key     text,
    old_data       jsonb,
    new_data       jsonb,
    changed_at     timestamptz NOT NULL DEFAULT now(),
    client_address inet
);
CREATE INDEX ix_audit_table_time ON audit.change_log(schema_name, table_name, changed_at DESC);
CREATE INDEX ix_audit_actor_time ON audit.change_log(actor_user_id, changed_at DESC);

CREATE FUNCTION audit.log_row_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_old jsonb; v_new jsonb; v_record jsonb; v_key text; v_actor bigint;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_new := to_jsonb(NEW); v_old := NULL; v_record := v_new;
    ELSIF TG_OP = 'UPDATE' THEN
        v_new := to_jsonb(NEW); v_old := to_jsonb(OLD); v_record := v_new;
    ELSE
        v_new := NULL; v_old := to_jsonb(OLD); v_record := v_old;
    END IF;
    v_key := v_record ->> TG_ARGV[0];
    v_actor := core.current_actor_id();
    INSERT INTO audit.change_log(actor_user_id, action, schema_name, table_name, record_key, old_data, new_data)
    VALUES (v_actor, TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, v_key, v_old, v_new);
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE FUNCTION audit.prevent_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Audit records are immutable';
END;
$$;
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit.change_log
FOR EACH ROW EXECUTE FUNCTION audit.prevent_audit_mutation();

/* Updated-at triggers are attached to every table that has updated_at. */
DO $$
DECLARE r record;
BEGIN
    FOR r IN
        SELECT table_schema, table_name
        FROM information_schema.columns
        WHERE column_name = 'updated_at'
          AND table_schema IN ('auth','master','hr','sales','procurement','inventory','production','dispatch','finance')
        GROUP BY table_schema, table_name
    LOOP
        EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION core.set_updated_at()',
                       r.table_schema, r.table_name);
    END LOOP;
END;
$$;

/* Keep an audit history on the most important business records. */
CREATE TRIGGER audit_orders AFTER INSERT OR UPDATE OR DELETE ON sales.orders
FOR EACH ROW EXECUTE FUNCTION audit.log_row_change('order_id');
CREATE TRIGGER audit_purchase_orders AFTER INSERT OR UPDATE OR DELETE ON procurement.purchase_orders
FOR EACH ROW EXECUTE FUNCTION audit.log_row_change('purchase_order_id');
CREATE TRIGGER audit_yarn_lots AFTER INSERT OR UPDATE OR DELETE ON inventory.yarn_lots
FOR EACH ROW EXECUTE FUNCTION audit.log_row_change('yarn_lot_id');
CREATE TRIGGER audit_jobs AFTER INSERT OR UPDATE OR DELETE ON production.jobs
FOR EACH ROW EXECUTE FUNCTION audit.log_row_change('job_id');
CREATE TRIGGER audit_rolls AFTER INSERT OR UPDATE OR DELETE ON production.rolls
FOR EACH ROW EXECUTE FUNCTION audit.log_row_change('roll_id');
CREATE TRIGGER audit_inspections AFTER INSERT OR UPDATE OR DELETE ON quality.inspections
FOR EACH ROW EXECUTE FUNCTION audit.log_row_change('inspection_id');
CREATE TRIGGER audit_shipments AFTER INSERT OR UPDATE OR DELETE ON dispatch.shipments
FOR EACH ROW EXECUTE FUNCTION audit.log_row_change('shipment_id');
CREATE TRIGGER audit_customer_invoices AFTER INSERT OR UPDATE OR DELETE ON finance.customer_invoices
FOR EACH ROW EXECUTE FUNCTION audit.log_row_change('customer_invoice_id');
CREATE TRIGGER audit_customer_payments AFTER INSERT OR UPDATE OR DELETE ON finance.customer_payment_transactions
FOR EACH ROW EXECUTE FUNCTION audit.log_row_change('customer_payment_id');

/* --------------------------------------------------------------------------
   15. Reporting views (derived totals reduce duplication and drift)
   -------------------------------------------------------------------------- */
CREATE VIEW reporting.raw_material_stock_by_type_colour AS
SELECT yt.yarn_type_id, yt.yarn_code, yt.yarn_name,
       yl.colour_id, c.colour_name,
       SUM(yl.received_qty_kg) AS total_received_kg,
       SUM(yl.on_hand_qty_kg) AS on_hand_kg,
       COUNT(*) FILTER (WHERE yl.on_hand_qty_kg > 0 AND yl.status <> 'QUARANTINED') AS lots_with_stock,
       COALESCE(yt.reorder_level_kg, (SELECT setting_value::numeric FROM core.app_settings WHERE setting_key='low_stock_default_kg')) AS reorder_level_kg
FROM inventory.yarn_lots yl
JOIN master.yarn_types yt ON yt.yarn_type_id = yl.yarn_type_id
LEFT JOIN master.colours c ON c.colour_id = yl.colour_id
GROUP BY yt.yarn_type_id, yt.yarn_code, yt.yarn_name, yl.colour_id, c.colour_name, yt.reorder_level_kg;

CREATE VIEW reporting.available_yarn_by_type AS
WITH stock AS (
    SELECT yl.yarn_type_id, SUM(yl.on_hand_qty_kg) AS on_hand_kg
    FROM inventory.yarn_lots yl
    WHERE yl.status <> 'QUARANTINED'
    GROUP BY yl.yarn_type_id
), reserved AS (
    SELECT yr.yarn_type_id, SUM(yr.quantity_kg) AS reserved_kg
    FROM inventory.yarn_reservations yr
    WHERE yr.status = 'ACTIVE'
    GROUP BY yr.yarn_type_id
)
SELECT yt.yarn_type_id, yt.yarn_code, yt.yarn_name,
       COALESCE(s.on_hand_kg,0) AS on_hand_kg,
       COALESCE(r.reserved_kg,0) AS reserved_kg,
       GREATEST(COALESCE(s.on_hand_kg,0) - COALESCE(r.reserved_kg,0), 0) AS available_kg,
       COALESCE(yt.reorder_level_kg, (SELECT setting_value::numeric FROM core.app_settings WHERE setting_key='low_stock_default_kg')) AS reorder_level_kg,
       (GREATEST(COALESCE(s.on_hand_kg,0) - COALESCE(r.reserved_kg,0), 0) <=
        COALESCE(yt.reorder_level_kg, (SELECT setting_value::numeric FROM core.app_settings WHERE setting_key='low_stock_default_kg'))) AS is_low_stock
FROM master.yarn_types yt
LEFT JOIN stock s ON s.yarn_type_id = yt.yarn_type_id
LEFT JOIN reserved r ON r.yarn_type_id = yt.yarn_type_id
WHERE yt.is_active;

CREATE VIEW reporting.order_material_requirements AS
SELECT oi.order_item_id, o.order_id, o.order_no, b.buyer_id, b.company_name,
       oi.quantity_m, ft.fabric_type_id, ft.fabric_name, bom.yarn_type_id, yt.yarn_name,
       round(oi.quantity_m * bom.kg_per_meter * (1 + bom.wastage_percent / 100), 3) AS required_kg,
       COALESCE(stock.on_hand_kg,0) AS on_hand_kg,
       COALESCE(reserved_other.reserved_kg,0) AS reserved_for_other_orders_kg,
       GREATEST(COALESCE(stock.on_hand_kg,0) - COALESCE(reserved_other.reserved_kg,0),0) AS available_to_this_order_kg,
       (GREATEST(COALESCE(stock.on_hand_kg,0) - COALESCE(reserved_other.reserved_kg,0),0) >=
        round(oi.quantity_m * bom.kg_per_meter * (1 + bom.wastage_percent / 100),3)) AS is_sufficient
FROM sales.order_items oi
JOIN sales.orders o ON o.order_id = oi.order_id
JOIN master.buyers b ON b.buyer_id = o.buyer_id
JOIN master.fabric_types ft ON ft.fabric_type_id = oi.fabric_type_id
JOIN master.fabric_bom bom ON bom.fabric_type_id = oi.fabric_type_id
JOIN master.yarn_types yt ON yt.yarn_type_id = bom.yarn_type_id
LEFT JOIN (
    SELECT yarn_type_id, SUM(on_hand_qty_kg) AS on_hand_kg
    FROM inventory.yarn_lots WHERE status <> 'QUARANTINED' GROUP BY yarn_type_id
) stock ON stock.yarn_type_id = bom.yarn_type_id
LEFT JOIN LATERAL (
    SELECT SUM(yr.quantity_kg) AS reserved_kg
    FROM inventory.yarn_reservations yr
    WHERE yr.yarn_type_id = bom.yarn_type_id
      AND yr.status = 'ACTIVE'
      AND yr.order_item_id <> oi.order_item_id
) reserved_other ON true;

CREATE VIEW reporting.order_progress_by_line AS
WITH roll_stats AS (
    SELECT r.order_item_id,
           COUNT(*) AS rolls_produced,
           COALESCE(SUM(r.length_meters),0) AS produced_meters,
           COALESCE(SUM(r.length_meters) FILTER (WHERE r.current_status IN ('PASSED','DISPATCHED')),0) AS qc_passed_meters,
           COALESCE(SUM(r.length_meters) FILTER (WHERE r.current_status = 'REJECTED'),0) AS rejected_meters,
           COALESCE(SUM(r.length_meters) FILTER (WHERE r.current_status = 'REWORK'),0) AS rework_meters,
           COALESCE(SUM(r.length_meters) FILTER (WHERE r.current_status = 'PENDING_QC'),0) AS pending_qc_meters
    FROM production.rolls r GROUP BY r.order_item_id
), shipped AS (
    SELECT r.order_item_id, SUM(r.length_meters) AS dispatched_meters
    FROM dispatch.shipment_items si
    JOIN dispatch.shipments sh ON sh.shipment_id = si.shipment_id
    JOIN production.rolls r ON r.roll_id = si.roll_id
    WHERE sh.status IN ('SHIPPED','DELIVERED')
    GROUP BY r.order_item_id
)
SELECT o.order_id, o.order_no, o.status AS stored_order_status, o.required_by_date,
       b.buyer_id, b.company_name, oi.order_item_id, oi.line_no,
       ft.fabric_name, c.colour_name, oi.quantity_m AS ordered_meters,
       COALESCE(rs.rolls_produced,0) AS rolls_produced,
       COALESCE(rs.produced_meters,0) AS produced_meters,
       COALESCE(rs.qc_passed_meters,0) AS qc_passed_meters,
       COALESCE(rs.pending_qc_meters,0) AS pending_qc_meters,
       COALESCE(rs.rework_meters,0) AS rework_meters,
       COALESCE(rs.rejected_meters,0) AS rejected_meters,
       COALESCE(sh.dispatched_meters,0) AS dispatched_meters,
       LEAST(100, round(COALESCE(rs.produced_meters,0) / NULLIF(oi.quantity_m,0) * 100, 2)) AS production_percent,
       LEAST(100, round(COALESCE(sh.dispatched_meters,0) / NULLIF(oi.quantity_m,0) * 100, 2)) AS dispatch_percent
FROM sales.orders o
JOIN master.buyers b ON b.buyer_id = o.buyer_id
JOIN sales.order_items oi ON oi.order_id = o.order_id
JOIN master.fabric_types ft ON ft.fabric_type_id = oi.fabric_type_id
JOIN master.colours c ON c.colour_id = oi.colour_id
LEFT JOIN roll_stats rs ON rs.order_item_id = oi.order_item_id
LEFT JOIN shipped sh ON sh.order_item_id = oi.order_item_id;

CREATE VIEW reporting.customer_order_tracking AS
SELECT o.order_id, o.order_no, o.order_date, o.required_by_date, o.status,
       b.buyer_id, b.buyer_code, b.company_name,
       COUNT(p.order_item_id) AS line_count,
       COALESCE(SUM(p.ordered_meters),0) AS ordered_meters,
       COALESCE(SUM(p.produced_meters),0) AS produced_meters,
       COALESCE(SUM(p.qc_passed_meters),0) AS qc_passed_meters,
       COALESCE(SUM(p.dispatched_meters),0) AS dispatched_meters,
       LEAST(100, round(COALESCE(SUM(p.produced_meters),0) / NULLIF(SUM(p.ordered_meters),0) * 100, 2)) AS production_percent,
       LEAST(100, round(COALESCE(SUM(p.dispatched_meters),0) / NULLIF(SUM(p.ordered_meters),0) * 100, 2)) AS dispatch_percent
FROM sales.orders o
JOIN master.buyers b ON b.buyer_id = o.buyer_id
LEFT JOIN reporting.order_progress_by_line p ON p.order_id = o.order_id
GROUP BY o.order_id, o.order_no, o.order_date, o.required_by_date, o.status,
         b.buyer_id, b.buyer_code, b.company_name;

CREATE VIEW reporting.customer_invoice_balances AS
WITH invoice_totals AS (
    SELECT ci.customer_invoice_id,
           COALESCE(SUM(l.line_subtotal),0) AS subtotal,
           COALESCE(SUM(l.line_tax),0) AS tax_amount,
           COALESCE(SUM(l.line_total),0) AS total_amount
    FROM finance.customer_invoices ci
    LEFT JOIN finance.customer_invoice_lines l ON l.customer_invoice_id = ci.customer_invoice_id
    GROUP BY ci.customer_invoice_id
), payments AS (
    SELECT p.customer_invoice_id, COALESCE(SUM(p.amount) FILTER (WHERE p.status='SUCCESS'),0) AS successful_payments
    FROM finance.customer_payment_transactions p GROUP BY p.customer_invoice_id
), refunds AS (
    SELECT p.customer_invoice_id, COALESCE(SUM(r.amount) FILTER (WHERE r.status='SUCCESS'),0) AS successful_refunds
    FROM finance.customer_refunds r
    JOIN finance.customer_payment_transactions p ON p.customer_payment_id = r.customer_payment_id
    GROUP BY p.customer_invoice_id
)
SELECT ci.customer_invoice_id, ci.invoice_no, ci.shipment_id, sh.shipment_no,
       o.order_id, o.order_no, o.buyer_id, b.company_name,
       ci.invoice_date, ci.due_date, ci.status AS invoice_status,
       it.subtotal, it.tax_amount, it.total_amount,
       COALESCE(p.successful_payments,0) AS successful_payments,
       COALESCE(r.successful_refunds,0) AS successful_refunds,
       GREATEST(COALESCE(p.successful_payments,0) - COALESCE(r.successful_refunds,0),0) AS net_paid,
       GREATEST(it.total_amount - GREATEST(COALESCE(p.successful_payments,0) - COALESCE(r.successful_refunds,0),0),0) AS balance_due,
       CASE WHEN ci.status = 'VOID' THEN 'VOID'
            WHEN it.total_amount <= GREATEST(COALESCE(p.successful_payments,0)-COALESCE(r.successful_refunds,0),0) THEN 'PAID'
            WHEN COALESCE(p.successful_payments,0)-COALESCE(r.successful_refunds,0) > 0 THEN 'PARTIALLY_PAID'
            ELSE 'UNPAID' END AS payment_status
FROM finance.customer_invoices ci
JOIN dispatch.shipments sh ON sh.shipment_id = ci.shipment_id
JOIN sales.orders o ON o.order_id = sh.order_id
JOIN master.buyers b ON b.buyer_id = o.buyer_id
JOIN invoice_totals it ON it.customer_invoice_id = ci.customer_invoice_id
LEFT JOIN payments p ON p.customer_invoice_id = ci.customer_invoice_id
LEFT JOIN refunds r ON r.customer_invoice_id = ci.customer_invoice_id;

CREATE VIEW reporting.supplier_payables AS
WITH invoice_totals AS (
    SELECT si.supplier_invoice_id, COALESCE(SUM(li.line_subtotal),0) AS subtotal,
           COALESCE(SUM(li.line_tax),0) AS tax_amount, COALESCE(SUM(li.line_total),0) AS total_amount
    FROM procurement.supplier_invoices si
    LEFT JOIN procurement.supplier_invoice_items li ON li.supplier_invoice_id = si.supplier_invoice_id
    GROUP BY si.supplier_invoice_id
), paid AS (
    SELECT supplier_invoice_id, COALESCE(SUM(amount) FILTER (WHERE status='COMPLETED'),0) AS paid_amount
    FROM procurement.supplier_payments GROUP BY supplier_invoice_id
)
SELECT si.supplier_invoice_id, si.internal_invoice_no, si.supplier_invoice_no,
       si.supplier_id, s.supplier_name, si.invoice_date, si.due_date, si.status,
       it.subtotal, it.tax_amount, it.total_amount, COALESCE(p.paid_amount,0) AS paid_amount,
       GREATEST(it.total_amount - COALESCE(p.paid_amount,0),0) AS balance_due,
       CASE WHEN si.status='VOID' THEN 'VOID'
            WHEN it.total_amount <= COALESCE(p.paid_amount,0) THEN 'PAID'
            WHEN COALESCE(p.paid_amount,0)>0 THEN 'PARTIALLY_PAID' ELSE 'UNPAID' END AS payment_status
FROM procurement.supplier_invoices si
JOIN master.suppliers s ON s.supplier_id = si.supplier_id
JOIN invoice_totals it ON it.supplier_invoice_id = si.supplier_invoice_id
LEFT JOIN paid p ON p.supplier_invoice_id = si.supplier_invoice_id;

CREATE VIEW reporting.production_output_today AS
SELECT m.machine_id, m.machine_code, m.machine_name, m.stage, m.status AS current_machine_status,
       COALESCE(SUM(pl.produced_meters),0) AS produced_meters_today,
       COALESCE(SUM(pl.waste_meters),0) AS waste_meters_today,
       COALESCE(SUM(pl.downtime_minutes),0) AS recorded_downtime_minutes_today,
       COUNT(pl.production_log_id) AS production_log_count
FROM master.machines m
LEFT JOIN production.machine_assignments ma ON ma.machine_id = m.machine_id
LEFT JOIN production.production_logs pl ON pl.machine_assignment_id = ma.machine_assignment_id
  AND (pl.logged_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
GROUP BY m.machine_id, m.machine_code, m.machine_name, m.stage, m.status;

CREATE VIEW reporting.machine_utilization_today AS
WITH bounds AS (
    SELECT (((now() AT TIME ZONE 'Asia/Kolkata')::date)::timestamp AT TIME ZONE 'Asia/Kolkata') AS day_start,
           ((((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)::timestamp) AT TIME ZONE 'Asia/Kolkata') AS day_end
), assigned AS (
    SELECT ma.machine_id,
           SUM(GREATEST(0, EXTRACT(EPOCH FROM
             (LEAST(COALESCE(ma.ended_at, now()), b.day_end) - GREATEST(COALESCE(ma.started_at,ma.assigned_at), b.day_start))) / 3600.0)) AS assigned_hours_today
    FROM production.machine_assignments ma CROSS JOIN bounds b
    WHERE COALESCE(ma.started_at,ma.assigned_at) < b.day_end
      AND COALESCE(ma.ended_at,now()) > b.day_start
      AND ma.status <> 'CANCELLED'
    GROUP BY ma.machine_id
)
SELECT m.machine_id, m.machine_code, m.machine_name, m.stage, m.status,
       round(COALESCE(a.assigned_hours_today,0)::numeric,2) AS assigned_hours_today,
       round(LEAST(100, COALESCE(a.assigned_hours_today,0) / 24.0 * 100)::numeric,2) AS utilization_pct_of_24h
FROM master.machines m LEFT JOIN assigned a ON a.machine_id = m.machine_id;

CREATE VIEW reporting.order_profitability AS
WITH material_cost AS (
    SELECT j.order_item_id, SUM(mii.quantity_kg * mii.unit_cost_snapshot) AS material_cost
    FROM inventory.material_issues mi
    JOIN inventory.material_issue_items mii ON mii.material_issue_id = mi.material_issue_id
    JOIN production.jobs j ON j.job_id = mi.job_id
    GROUP BY j.order_item_id
), extra_cost AS (
    SELECT order_item_id, SUM(amount) AS other_manufacturing_cost
    FROM finance.order_cost_entries GROUP BY order_item_id
), revenue AS (
    SELECT oi.order_item_id, SUM(l.line_subtotal) AS invoiced_revenue_ex_tax
    FROM finance.customer_invoice_lines l
    JOIN finance.customer_invoices ci ON ci.customer_invoice_id = l.customer_invoice_id AND ci.status = 'ISSUED'
    JOIN dispatch.shipment_items si ON si.shipment_item_id = l.shipment_item_id
    JOIN production.rolls r ON r.roll_id = si.roll_id
    JOIN sales.order_items oi ON oi.order_item_id = r.order_item_id
    GROUP BY oi.order_item_id
)
SELECT o.order_id, o.order_no, b.company_name, o.status,
       COALESCE(SUM(rev.invoiced_revenue_ex_tax),0) AS invoiced_revenue_ex_tax,
       COALESCE(SUM(mc.material_cost),0) AS recorded_raw_material_cost,
       COALESCE(SUM(ec.other_manufacturing_cost),0) AS other_manufacturing_cost,
       COALESCE(SUM(mc.material_cost),0) + COALESCE(SUM(ec.other_manufacturing_cost),0) AS recorded_manufacturing_cost,
       COALESCE(SUM(rev.invoiced_revenue_ex_tax),0) -
         COALESCE(SUM(mc.material_cost),0) - COALESCE(SUM(ec.other_manufacturing_cost),0) AS recorded_margin_before_unallocated_expenses
FROM sales.orders o
JOIN master.buyers b ON b.buyer_id = o.buyer_id
JOIN sales.order_items oi ON oi.order_id = o.order_id
LEFT JOIN material_cost mc ON mc.order_item_id = oi.order_item_id
LEFT JOIN extra_cost ec ON ec.order_item_id = oi.order_item_id
LEFT JOIN revenue rev ON rev.order_item_id = oi.order_item_id
GROUP BY o.order_id, o.order_no, b.company_name, o.status;

CREATE VIEW reporting.owner_dashboard_metrics AS
SELECT
  (SELECT COUNT(*) FROM sales.orders WHERE status NOT IN ('SHIPPED','DELIVERED','CANCELLED')) AS active_orders,
  (SELECT COUNT(*) FROM sales.orders WHERE status='PLACED') AS orders_awaiting_confirmation,
  (SELECT COUNT(*) FROM production.jobs WHERE status IN ('PLANNED','ASSIGNED','IN_PROGRESS','PAUSED')) AS active_production_jobs,
  (SELECT COUNT(*) FROM master.machines WHERE is_active AND status='RUNNING') AS machines_running,
  (SELECT COUNT(*) FROM master.machines WHERE is_active AND status='IDLE') AS machines_idle,
  (SELECT COUNT(*) FROM master.machines WHERE is_active AND status='BREAKDOWN') AS machines_in_breakdown,
  (SELECT COUNT(*) FROM reporting.available_yarn_by_type WHERE is_low_stock) AS yarn_types_below_reorder_level,
  (SELECT COALESCE(SUM(produced_meters_today),0) FROM reporting.production_output_today) AS production_meters_today,
  (SELECT COALESCE(SUM(balance_due),0) FROM reporting.customer_invoice_balances WHERE invoice_status='ISSUED') AS customer_receivables,
  (SELECT COALESCE(SUM(balance_due),0) FROM reporting.supplier_payables WHERE status <> 'VOID') AS supplier_payables;

/* --------------------------------------------------------------------------
   16. Helpful constraints and final indexes
   -------------------------------------------------------------------------- */
CREATE FUNCTION finance.validate_order_cost_entry()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_job_order_item bigint;
BEGIN
    PERFORM auth.assert_role(NEW.entered_by, ARRAY['OWNER','SUPERVISOR','STORE_MANAGER'], 'order cost entry creator');
    IF NEW.job_id IS NOT NULL THEN
        SELECT order_item_id INTO v_job_order_item FROM production.jobs WHERE job_id = NEW.job_id;
        IF v_job_order_item IS DISTINCT FROM NEW.order_item_id THEN
            RAISE EXCEPTION 'Cost entry job must belong to the selected order item';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_order_cost_entry BEFORE INSERT OR UPDATE OF order_item_id, job_id, entered_by
ON finance.order_cost_entries FOR EACH ROW EXECUTE FUNCTION finance.validate_order_cost_entry();

CREATE FUNCTION procurement.guard_po_item_edits()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; v_po_id bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN v_po_id := OLD.purchase_order_id; ELSE v_po_id := NEW.purchase_order_id; END IF;
    SELECT status INTO v_status FROM procurement.purchase_orders WHERE purchase_order_id = v_po_id;
    IF v_status <> 'DRAFT' THEN RAISE EXCEPTION 'PO lines can only be added, edited or deleted while PO is DRAFT'; END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER trg_guard_po_item_edits BEFORE INSERT OR UPDATE OR DELETE ON procurement.purchase_order_items
FOR EACH ROW EXECUTE FUNCTION procurement.guard_po_item_edits();

CREATE FUNCTION quality.prevent_inspection_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Quality inspections are append-only; add a new inspection to record rework or reinspection';
END;
$$;
CREATE TRIGGER trg_inspections_immutable BEFORE UPDATE OR DELETE ON quality.inspections
FOR EACH ROW EXECUTE FUNCTION quality.prevent_inspection_mutation();
CREATE TRIGGER trg_inspection_defects_immutable BEFORE UPDATE OR DELETE ON quality.inspection_defects
FOR EACH ROW EXECUTE FUNCTION quality.prevent_inspection_mutation();

CREATE FUNCTION finance.prevent_issued_invoice_line_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_invoice_id bigint; v_status text;
BEGIN
    IF TG_OP = 'DELETE' THEN v_invoice_id := OLD.customer_invoice_id; ELSE v_invoice_id := NEW.customer_invoice_id; END IF;
    SELECT status INTO v_status FROM finance.customer_invoices WHERE customer_invoice_id = v_invoice_id;
    IF v_status <> 'DRAFT' THEN RAISE EXCEPTION 'Issued/void invoice lines are immutable'; END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER trg_issued_invoice_line_guard BEFORE UPDATE OR DELETE ON finance.customer_invoice_lines
FOR EACH ROW EXECUTE FUNCTION finance.prevent_issued_invoice_line_mutation();

CREATE FUNCTION core.prevent_delete_from_ledger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'This record is historical/transactional; use a reversal or status change instead';
END;
$$;
CREATE TRIGGER trg_no_delete_orders_status_history BEFORE UPDATE OR DELETE ON sales.order_status_history
FOR EACH ROW EXECUTE FUNCTION core.prevent_delete_from_ledger();

/* Example shifts; edit these to match the actual factory schedule. */
INSERT INTO master.shifts(shift_name, start_time, end_time) VALUES
 ('Morning', '06:00', '14:00'),
 ('Evening', '14:00', '22:00'),
 ('Night', '22:00', '06:00')
ON CONFLICT (shift_name) DO NOTHING;


/* Additional aggregate-aware guards and role checks. These run in the same
   setup transaction as the objects above. */

CREATE FUNCTION procurement.validate_supplier_invoice_item()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_invoice_id bigint; v_grn_id bigint; v_status text; v_accepted_qty numeric(12,3); v_item_grn_id bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_invoice_id := OLD.supplier_invoice_id;
    ELSE
        v_invoice_id := NEW.supplier_invoice_id;
    END IF;
    SELECT goods_receipt_id, status INTO v_grn_id, v_status
    FROM procurement.supplier_invoices WHERE supplier_invoice_id = v_invoice_id FOR UPDATE;
    IF v_status <> 'RECORDED' THEN
        RAISE EXCEPTION 'Supplier invoice lines can only be edited while invoice status is RECORDED';
    END IF;
    IF TG_OP <> 'DELETE' THEN
        SELECT accepted_qty_kg, goods_receipt_id INTO v_accepted_qty, v_item_grn_id
        FROM procurement.goods_receipt_items WHERE goods_receipt_item_id = NEW.goods_receipt_item_id;
        IF NOT FOUND OR v_item_grn_id IS DISTINCT FROM v_grn_id THEN
            RAISE EXCEPTION 'Supplier invoice line must refer to a line on its own goods receipt';
        END IF;
        IF NEW.billed_qty_kg > v_accepted_qty THEN
            RAISE EXCEPTION 'Billed quantity cannot exceed accepted goods-receipt quantity';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER trg_validate_supplier_invoice_item BEFORE INSERT OR UPDATE OR DELETE
ON procurement.supplier_invoice_items FOR EACH ROW EXECUTE FUNCTION procurement.validate_supplier_invoice_item();

CREATE OR REPLACE FUNCTION procurement.validate_supplier_payment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_invoice_status text; v_invoice_total numeric(14,2); v_other_reserved numeric(14,2);
BEGIN
    PERFORM auth.assert_role(NEW.recorded_by, ARRAY['STORE_MANAGER','OWNER'], 'supplier payment recorder');
    SELECT status INTO v_invoice_status FROM procurement.supplier_invoices
    WHERE supplier_invoice_id = NEW.supplier_invoice_id FOR UPDATE;
    IF v_invoice_status IS DISTINCT FROM 'APPROVED' THEN
        RAISE EXCEPTION 'Supplier invoice must be APPROVED before payment can be recorded';
    END IF;
    SELECT COALESCE(SUM(line_total),0) INTO v_invoice_total
    FROM procurement.supplier_invoice_items WHERE supplier_invoice_id = NEW.supplier_invoice_id;
    SELECT COALESCE(SUM(amount),0) INTO v_other_reserved
    FROM procurement.supplier_payments
    WHERE supplier_invoice_id = NEW.supplier_invoice_id
      AND supplier_payment_id IS DISTINCT FROM NEW.supplier_payment_id
      AND status IN ('PENDING','COMPLETED');
    IF NEW.status IN ('PENDING','COMPLETED') AND v_other_reserved + NEW.amount > v_invoice_total THEN
        RAISE EXCEPTION 'Supplier payment would exceed invoice total (%)', v_invoice_total;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_supplier_payment ON procurement.supplier_payments;
CREATE TRIGGER trg_validate_supplier_payment BEFORE INSERT OR UPDATE ON procurement.supplier_payments
FOR EACH ROW EXECUTE FUNCTION procurement.validate_supplier_payment();

CREATE OR REPLACE FUNCTION finance.validate_customer_payment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_invoice_status text;
    v_buyer_user_id bigint;
    v_invoice_total numeric(14,2);
    v_other_paid numeric(14,2);
    v_other_refunded numeric(14,2);
    v_other_pending numeric(14,2);
BEGIN
    SELECT ci.status, b.user_id INTO v_invoice_status, v_buyer_user_id
    FROM finance.customer_invoices ci
    JOIN dispatch.shipments sh ON sh.shipment_id = ci.shipment_id
    JOIN sales.orders o ON o.order_id = sh.order_id
    JOIN master.buyers b ON b.buyer_id = o.buyer_id
    WHERE ci.customer_invoice_id = NEW.customer_invoice_id
    FOR UPDATE OF ci;
    IF v_invoice_status IS DISTINCT FROM 'ISSUED' THEN
        RAISE EXCEPTION 'Payment can only be initiated for an issued customer invoice';
    END IF;
    IF NEW.created_by IS NOT NULL THEN
        PERFORM auth.assert_role(NEW.created_by, ARRAY['BUYER','OWNER'], 'customer payment initiator');
        IF auth.user_has_role(NEW.created_by, ARRAY['BUYER']) AND NEW.created_by <> v_buyer_user_id THEN
            RAISE EXCEPTION 'A buyer can only create a payment for their own invoice' USING ERRCODE = '42501';
        END IF;
    END IF;

    SELECT COALESCE(SUM(l.line_total),0) INTO v_invoice_total
    FROM finance.customer_invoice_lines l WHERE l.customer_invoice_id = NEW.customer_invoice_id;

    SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status='SUCCESS'),0) INTO v_other_paid
    FROM finance.customer_payment_transactions p
    WHERE p.customer_invoice_id = NEW.customer_invoice_id
      AND p.customer_payment_id IS DISTINCT FROM NEW.customer_payment_id;
    SELECT COALESCE(SUM(r.amount),0) INTO v_other_refunded
    FROM finance.customer_refunds r
    JOIN finance.customer_payment_transactions p ON p.customer_payment_id = r.customer_payment_id
    WHERE p.customer_invoice_id = NEW.customer_invoice_id
      AND p.customer_payment_id IS DISTINCT FROM NEW.customer_payment_id
      AND r.status = 'SUCCESS';
    SELECT COALESCE(SUM(p.amount),0) INTO v_other_pending
    FROM finance.customer_payment_transactions p
    WHERE p.customer_invoice_id = NEW.customer_invoice_id
      AND p.customer_payment_id IS DISTINCT FROM NEW.customer_payment_id
      AND p.status IN ('INITIATED','PENDING');

    IF NEW.status IN ('INITIATED','PENDING','SUCCESS') THEN
        IF GREATEST(v_other_paid - v_other_refunded,0) + v_other_pending + NEW.amount > v_invoice_total THEN
            RAISE EXCEPTION 'Payment would exceed the remaining invoice balance (%)',
                GREATEST(v_invoice_total - GREATEST(v_other_paid - v_other_refunded,0) - v_other_pending,0);
        END IF;
    END IF;
    IF NEW.status = 'SUCCESS' AND NEW.completed_at IS NULL THEN NEW.completed_at := now(); END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION finance.validate_customer_refund()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_payment_amount numeric(14,2); v_payment_status text; v_other_refunds numeric(14,2);
BEGIN
    SELECT amount, status INTO v_payment_amount, v_payment_status
    FROM finance.customer_payment_transactions
    WHERE customer_payment_id = NEW.customer_payment_id FOR UPDATE;
    IF v_payment_status IS DISTINCT FROM 'SUCCESS' THEN
        RAISE EXCEPTION 'Only a successful customer payment can be refunded';
    END IF;
    SELECT COALESCE(SUM(amount),0) INTO v_other_refunds
    FROM finance.customer_refunds
    WHERE customer_payment_id = NEW.customer_payment_id
      AND customer_refund_id IS DISTINCT FROM NEW.customer_refund_id
      AND status IN ('PENDING','SUCCESS');
    IF NEW.status IN ('PENDING','SUCCESS') AND v_other_refunds + NEW.amount > v_payment_amount THEN
        RAISE EXCEPTION 'Refund amount exceeds the successful payment amount';
    END IF;
    IF NEW.status = 'SUCCESS' AND NEW.completed_at IS NULL THEN NEW.completed_at := now(); END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_customer_refund BEFORE INSERT OR UPDATE ON finance.customer_refunds
FOR EACH ROW EXECUTE FUNCTION finance.validate_customer_refund();

CREATE FUNCTION inventory.validate_yarn_reservation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_fabric_type_id bigint;
    v_order_qty_m numeric(12,2);
    v_order_status text;
    v_required_kg numeric(12,3);
    v_stock_kg numeric(12,3);
    v_other_reservations numeric(12,3);
    v_item_reservations numeric(12,3);
BEGIN
    IF NEW.status = 'ACTIVE' THEN
        PERFORM pg_advisory_xact_lock(NEW.yarn_type_id);
        SELECT oi.fabric_type_id, oi.quantity_m, o.status
          INTO v_fabric_type_id, v_order_qty_m, v_order_status
          FROM sales.order_items oi JOIN sales.orders o ON o.order_id = oi.order_id
         WHERE oi.order_item_id = NEW.order_item_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Order line for material reservation not found'; END IF;
        IF v_order_status IN ('CANCELLED','SHIPPED','DELIVERED') THEN
            RAISE EXCEPTION 'Cannot reserve materials for a cancelled or completed order';
        END IF;
        SELECT round(v_order_qty_m * b.kg_per_meter * (1 + b.wastage_percent / 100),3)
          INTO v_required_kg
          FROM master.fabric_bom b
         WHERE b.fabric_type_id = v_fabric_type_id AND b.yarn_type_id = NEW.yarn_type_id;
        IF v_required_kg IS NULL THEN RAISE EXCEPTION 'Yarn type is not in the fabric BOM for this order line'; END IF;

        SELECT COALESCE(SUM(yl.on_hand_qty_kg),0) INTO v_stock_kg
        FROM inventory.yarn_lots yl
        WHERE yl.yarn_type_id = NEW.yarn_type_id AND yl.status <> 'QUARANTINED';
        SELECT COALESCE(SUM(yr.quantity_kg),0) INTO v_other_reservations
        FROM inventory.yarn_reservations yr
        WHERE yr.yarn_type_id = NEW.yarn_type_id AND yr.status = 'ACTIVE'
          AND yr.reservation_id IS DISTINCT FROM NEW.reservation_id;
        IF v_other_reservations + NEW.quantity_kg > v_stock_kg THEN
            RAISE EXCEPTION 'Reservation exceeds available stock; on hand %, already reserved %', v_stock_kg, v_other_reservations;
        END IF;
        SELECT COALESCE(SUM(yr.quantity_kg),0) INTO v_item_reservations
        FROM inventory.yarn_reservations yr
        WHERE yr.order_item_id = NEW.order_item_id AND yr.yarn_type_id = NEW.yarn_type_id
          AND yr.status = 'ACTIVE' AND yr.reservation_id IS DISTINCT FROM NEW.reservation_id;
        IF v_item_reservations + NEW.quantity_kg > v_required_kg THEN
            RAISE EXCEPTION 'Reservation exceeds BOM requirement (%) for this order line', v_required_kg;
        END IF;
    END IF;
    IF NEW.reserved_by IS NOT NULL THEN
        PERFORM auth.assert_role(NEW.reserved_by, ARRAY['STORE_MANAGER','SUPERVISOR','OWNER'], 'material reservation creator');
    END IF;
    IF NEW.status <> 'ACTIVE' AND NEW.released_at IS NULL THEN NEW.released_at := now(); END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_yarn_reservation BEFORE INSERT OR UPDATE ON inventory.yarn_reservations
FOR EACH ROW EXECUTE FUNCTION inventory.validate_yarn_reservation();

CREATE FUNCTION hr.validate_attendance_actor()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_worker_user_id bigint;
BEGIN
    IF NEW.marked_by IS NOT NULL THEN
        PERFORM auth.assert_role(NEW.marked_by, ARRAY['WORKER','STORE_MANAGER','OWNER'], 'attendance marker');
        IF auth.user_has_role(NEW.marked_by, ARRAY['WORKER']) THEN
            SELECT user_id INTO v_worker_user_id FROM hr.workers WHERE worker_id = NEW.worker_id;
            IF v_worker_user_id IS DISTINCT FROM NEW.marked_by THEN
                RAISE EXCEPTION 'A worker may only mark their own attendance' USING ERRCODE = '42501';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_attendance_actor BEFORE INSERT OR UPDATE OF marked_by, worker_id ON hr.attendance
FOR EACH ROW EXECUTE FUNCTION hr.validate_attendance_actor();

CREATE FUNCTION production.validate_production_log()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; v_shift bigint; v_worker_user_id bigint;
BEGIN
    SELECT status, shift_id INTO v_status, v_shift
    FROM production.machine_assignments WHERE machine_assignment_id = NEW.machine_assignment_id;
    IF v_status IS DISTINCT FROM 'RUNNING' THEN RAISE EXCEPTION 'Output can only be logged against a RUNNING machine assignment'; END IF;
    IF v_shift IS DISTINCT FROM NEW.shift_id THEN RAISE EXCEPTION 'Production log shift must match the machine assignment shift'; END IF;
    SELECT user_id INTO v_worker_user_id FROM hr.workers WHERE worker_id = NEW.worker_id AND is_active;
    IF v_worker_user_id IS NULL THEN RAISE EXCEPTION 'Worker is not active or does not exist'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM production.job_worker_assignments jwa
        WHERE jwa.machine_assignment_id = NEW.machine_assignment_id
          AND jwa.worker_id = NEW.worker_id AND jwa.ended_at IS NULL
    ) THEN RAISE EXCEPTION 'Worker must be actively assigned to this machine job before logging output'; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_production_log BEFORE INSERT OR UPDATE ON production.production_logs
FOR EACH ROW EXECUTE FUNCTION production.validate_production_log();

CREATE OR REPLACE FUNCTION production.validate_roll()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_job_item bigint; v_assignment_machine bigint; v_log_job bigint; v_log_meters numeric(12,2); v_existing_roll_meters numeric(12,2);
BEGIN
    SELECT order_item_id INTO v_job_item FROM production.jobs WHERE job_id = NEW.job_id;
    IF v_job_item IS DISTINCT FROM NEW.order_item_id THEN
        RAISE EXCEPTION 'Roll order item must match its production job';
    END IF;
    IF NEW.production_log_id IS NOT NULL THEN
        SELECT ma.machine_id, ma.job_id, pl.produced_meters
          INTO v_assignment_machine, v_log_job, v_log_meters
          FROM production.production_logs pl
          JOIN production.machine_assignments ma ON ma.machine_assignment_id = pl.machine_assignment_id
         WHERE pl.production_log_id = NEW.production_log_id;
        IF v_assignment_machine IS DISTINCT FROM NEW.machine_id OR v_log_job IS DISTINCT FROM NEW.job_id THEN
            RAISE EXCEPTION 'Roll machine/job must match the production log assignment';
        END IF;
        SELECT COALESCE(SUM(r.length_meters),0) INTO v_existing_roll_meters
        FROM production.rolls r
        WHERE r.production_log_id = NEW.production_log_id
          AND r.roll_id IS DISTINCT FROM NEW.roll_id;
        IF v_existing_roll_meters + NEW.length_meters > v_log_meters THEN
            RAISE EXCEPTION 'Roll lengths exceed the production log output';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION production.apply_machine_status_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_old_status text;
BEGIN
    PERFORM auth.assert_role(NEW.reported_by, ARRAY['SUPERVISOR','WORKER','OWNER'], 'machine status reporter');
    SELECT status INTO v_old_status FROM master.machines WHERE machine_id = NEW.machine_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Machine not found'; END IF;
    IF v_old_status IS NOT DISTINCT FROM NEW.new_status THEN
        RAISE EXCEPTION 'Machine is already in status %', NEW.new_status;
    END IF;
    NEW.old_status := v_old_status;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_machine_status_event_before BEFORE INSERT ON production.machine_status_events
FOR EACH ROW EXECUTE FUNCTION production.apply_machine_status_event();

CREATE FUNCTION production.apply_machine_status_event_after()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE production.machine_status_events
       SET ended_at = NEW.started_at
     WHERE machine_id = NEW.machine_id AND machine_status_event_id <> NEW.machine_status_event_id
       AND ended_at IS NULL AND started_at <= NEW.started_at;
    UPDATE master.machines SET status = NEW.new_status WHERE machine_id = NEW.machine_id;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_machine_status_event_after AFTER INSERT ON production.machine_status_events
FOR EACH ROW EXECUTE FUNCTION production.apply_machine_status_event_after();

/* Emit notifications for new orders and order status changes. */
CREATE FUNCTION notification.notify_new_order()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM notification.notify_role('OWNER', 'ORDER', 'New order ' || NEW.order_no,
        'A customer placed a new order. Review its material needs and confirm it.', 'ORDER', NEW.order_id);
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_notify_new_order AFTER INSERT ON sales.orders
FOR EACH ROW EXECUTE FUNCTION notification.notify_new_order();

CREATE FUNCTION notification.notify_order_status_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_buyer_user_id bigint;
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        SELECT user_id INTO v_buyer_user_id FROM master.buyers WHERE buyer_id = NEW.buyer_id;
        PERFORM notification.notify_user(v_buyer_user_id, 'ORDER', 'Order ' || NEW.order_no || ' updated',
           'Your order status is now ' || NEW.status || '.', 'ORDER', NEW.order_id);
        IF NEW.status = 'AWAITING_MATERIAL' THEN
            PERFORM notification.notify_role('STORE_MANAGER', 'STOCK', 'Material shortage for ' || NEW.order_no,
               'Review stock availability and create a purchase order if required.', 'ORDER', NEW.order_id);
        ELSIF NEW.status = 'CONFIRMED' THEN
            PERFORM notification.notify_role('SUPERVISOR', 'PRODUCTION', 'Order ready for production: ' || NEW.order_no,
               'Review the order and create production jobs.', 'ORDER', NEW.order_id);
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_notify_order_status_change AFTER UPDATE OF status ON sales.orders
FOR EACH ROW EXECUTE FUNCTION notification.notify_order_status_change();

/* Finance summary at monthly granularity. Revenue excludes tax; cash collected
   is based on successful gateway/manual payment transactions, not invoices. */
CREATE VIEW reporting.monthly_financial_summary AS
WITH revenue AS (
    SELECT date_trunc('month', ci.invoice_date)::date AS month,
           SUM(l.line_subtotal) AS revenue_ex_tax
    FROM finance.customer_invoices ci
    JOIN finance.customer_invoice_lines l ON l.customer_invoice_id = ci.customer_invoice_id
    WHERE ci.status = 'ISSUED'
    GROUP BY date_trunc('month', ci.invoice_date)::date
), collections AS (
    SELECT date_trunc('month', p.completed_at)::date AS month, SUM(p.amount) AS customer_cash_collected
    FROM finance.customer_payment_transactions p
    WHERE p.status = 'SUCCESS' AND p.completed_at IS NOT NULL
    GROUP BY date_trunc('month', p.completed_at)::date
), material_cost AS (
    SELECT date_trunc('month', mi.issued_at)::date AS month,
           SUM(mii.quantity_kg * mii.unit_cost_snapshot) AS material_cost
    FROM inventory.material_issues mi
    JOIN inventory.material_issue_items mii ON mii.material_issue_id = mi.material_issue_id
    GROUP BY date_trunc('month', mi.issued_at)::date
), extra_cost AS (
    SELECT date_trunc('month', occurred_on)::date AS month, SUM(amount) AS allocated_order_costs
    FROM finance.order_cost_entries GROUP BY date_trunc('month', occurred_on)::date
), expenses AS (
    SELECT date_trunc('month', expense_date)::date AS month, SUM(amount) AS operating_expenses
    FROM finance.operating_expenses GROUP BY date_trunc('month', expense_date)::date
), wages AS (
    SELECT date_trunc('month', paid_at)::date AS month, SUM(net_amount) AS wages_paid
    FROM hr.wage_payments WHERE status='PAID' AND paid_at IS NOT NULL
    GROUP BY date_trunc('month', paid_at)::date
), months AS (
    SELECT month FROM revenue UNION SELECT month FROM collections UNION SELECT month FROM material_cost
    UNION SELECT month FROM extra_cost UNION SELECT month FROM expenses UNION SELECT month FROM wages
)
SELECT m.month,
       COALESCE(r.revenue_ex_tax,0) AS revenue_ex_tax,
       COALESCE(c.customer_cash_collected,0) AS customer_cash_collected,
       COALESCE(mc.material_cost,0) AS material_consumed_cost,
       COALESCE(ec.allocated_order_costs,0) AS allocated_order_costs,
       COALESCE(e.operating_expenses,0) AS operating_expenses,
       COALESCE(w.wages_paid,0) AS wages_paid,
       COALESCE(r.revenue_ex_tax,0) - COALESCE(mc.material_cost,0) - COALESCE(ec.allocated_order_costs,0)
          - COALESCE(e.operating_expenses,0) - COALESCE(w.wages_paid,0) AS indicative_margin
FROM months m
LEFT JOIN revenue r ON r.month = m.month
LEFT JOIN collections c ON c.month = m.month
LEFT JOIN material_cost mc ON mc.month = m.month
LEFT JOIN extra_cost ec ON ec.month = m.month
LEFT JOIN expenses e ON e.month = m.month
LEFT JOIN wages w ON w.month = m.month;



/* Further consistency: aggregate caps, worker ownership and protected workflow states. */

CREATE OR REPLACE FUNCTION inventory.apply_stock_movement()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_new_balance numeric(12,3);
BEGIN
    UPDATE inventory.yarn_lots
       SET on_hand_qty_kg = on_hand_qty_kg + NEW.quantity_delta_kg,
           status = CASE WHEN on_hand_qty_kg + NEW.quantity_delta_kg = 0 THEN 'DEPLETED'
                         WHEN status = 'DEPLETED' AND on_hand_qty_kg + NEW.quantity_delta_kg > 0 THEN 'ACTIVE'
                         ELSE status END
     WHERE yarn_lot_id = NEW.yarn_lot_id
       AND on_hand_qty_kg + NEW.quantity_delta_kg >= 0
       AND NOT (NEW.movement_type = 'ISSUE' AND status = 'QUARANTINED')
    RETURNING on_hand_qty_kg INTO v_new_balance;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Stock movement would make yarn lot negative, use a quarantined lot, or reference a missing lot';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION inventory.post_material_issue_item()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_unit_cost numeric(12,4); v_lot_type bigint; v_fabric_type bigint; v_job_status text;
BEGIN
    SELECT yl.unit_cost_per_kg, yl.yarn_type_id INTO v_unit_cost, v_lot_type
    FROM inventory.yarn_lots yl WHERE yl.yarn_lot_id = NEW.yarn_lot_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Yarn lot not found'; END IF;
    -- Snapshot the actual lot cost, not a cost supplied by the frontend.
    NEW.unit_cost_snapshot := v_unit_cost;
    SELECT j.status, ft.fabric_type_id INTO v_job_status, v_fabric_type
    FROM inventory.material_issues mi
    JOIN production.jobs j ON j.job_id = mi.job_id
    JOIN sales.order_items oi ON oi.order_item_id = j.order_item_id
    JOIN master.fabric_types ft ON ft.fabric_type_id = oi.fabric_type_id
    WHERE mi.material_issue_id = NEW.material_issue_id;
    IF v_job_status IS NULL THEN RAISE EXCEPTION 'Material issue job not found'; END IF;
    IF NOT EXISTS (SELECT 1 FROM master.fabric_bom b WHERE b.fabric_type_id = v_fabric_type AND b.yarn_type_id = v_lot_type) THEN
        RAISE EXCEPTION 'Yarn type is not in the fabric bill of materials for this job';
    END IF;
    INSERT INTO inventory.stock_movements(yarn_lot_id, movement_type, quantity_delta_kg,
       unit_cost_snapshot, source_type, source_id, source_line_id, moved_by, remarks)
    SELECT NEW.yarn_lot_id, 'ISSUE', -NEW.quantity_kg, NEW.unit_cost_snapshot,
           'MATERIAL_ISSUE', mi.material_issue_id, NEW.material_issue_item_id,
           mi.issued_by, 'Yarn issued to production job'
    FROM inventory.material_issues mi WHERE mi.material_issue_id = NEW.material_issue_id;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION production.set_assignment_running(
    p_machine_assignment_id bigint,
    p_worker_user_id bigint
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_worker_id bigint; v_machine_id bigint; v_machine_status text; v_assignment_status text;
BEGIN
    PERFORM auth.assert_role(p_worker_user_id, ARRAY['WORKER','SUPERVISOR','OWNER'], 'job starter');
    SELECT machine_id, status INTO v_machine_id, v_assignment_status
    FROM production.machine_assignments WHERE machine_assignment_id = p_machine_assignment_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Machine assignment not found'; END IF;
    IF v_assignment_status NOT IN ('ASSIGNED','PAUSED') THEN RAISE EXCEPTION 'Assignment is not available to start'; END IF;

    SELECT worker_id INTO v_worker_id FROM hr.workers WHERE user_id = p_worker_user_id AND is_active;
    IF auth.user_has_role(p_worker_user_id, ARRAY['WORKER']) THEN
        IF v_worker_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM production.job_worker_assignments jwa
            WHERE jwa.machine_assignment_id = p_machine_assignment_id AND jwa.worker_id = v_worker_id
        ) THEN
            RAISE EXCEPTION 'Worker can only start a machine job assigned to them' USING ERRCODE = '42501';
        END IF;
    END IF;
    SELECT status INTO v_machine_status FROM master.machines WHERE machine_id = v_machine_id FOR UPDATE;
    IF v_machine_status IN ('BREAKDOWN','MAINTENANCE') THEN
        RAISE EXCEPTION 'Machine cannot start while status is %', v_machine_status;
    END IF;

    UPDATE production.machine_assignments
       SET status = 'RUNNING', started_at = COALESCE(started_at, now()), started_by = p_worker_user_id
     WHERE machine_assignment_id = p_machine_assignment_id;
    IF v_worker_id IS NOT NULL THEN
        UPDATE production.job_worker_assignments
           SET started_at = COALESCE(started_at, now()), ended_at = NULL
         WHERE machine_assignment_id = p_machine_assignment_id AND worker_id = v_worker_id;
    END IF;
    UPDATE production.jobs j SET status = 'IN_PROGRESS', started_at = COALESCE(j.started_at, now())
    FROM production.machine_assignments ma
    WHERE ma.machine_assignment_id = p_machine_assignment_id AND ma.job_id = j.job_id;
    IF v_machine_status IS DISTINCT FROM 'RUNNING' THEN
        INSERT INTO production.machine_status_events(machine_id, new_status, reason, reported_by)
        VALUES (v_machine_id, 'RUNNING', 'Production assignment started', p_worker_user_id);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION production.stop_assignment(
    p_machine_assignment_id bigint,
    p_stopped_by bigint,
    p_mark_completed boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_machine_id bigint; v_job_id bigint; v_status text; v_worker_id bigint; v_machine_status text;
BEGIN
    PERFORM auth.assert_role(p_stopped_by, ARRAY['WORKER','SUPERVISOR','OWNER'], 'job stopper');
    SELECT machine_id, job_id, status INTO v_machine_id, v_job_id, v_status
    FROM production.machine_assignments WHERE machine_assignment_id = p_machine_assignment_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Machine assignment not found'; END IF;
    IF v_status NOT IN ('RUNNING','PAUSED','ASSIGNED') THEN RAISE EXCEPTION 'Assignment is already closed'; END IF;
    SELECT worker_id INTO v_worker_id FROM hr.workers WHERE user_id = p_stopped_by AND is_active;
    IF auth.user_has_role(p_stopped_by, ARRAY['WORKER']) AND NOT EXISTS (
        SELECT 1 FROM production.job_worker_assignments jwa
        WHERE jwa.machine_assignment_id = p_machine_assignment_id AND jwa.worker_id = v_worker_id
    ) THEN
        RAISE EXCEPTION 'Worker can only stop a job assigned to them' USING ERRCODE = '42501';
    END IF;
    UPDATE production.machine_assignments
       SET status = CASE WHEN p_mark_completed THEN 'COMPLETED' ELSE 'PAUSED' END,
           ended_at = CASE WHEN p_mark_completed THEN now() ELSE NULL END,
           ended_by = p_stopped_by
     WHERE machine_assignment_id = p_machine_assignment_id;
    UPDATE production.job_worker_assignments SET ended_at = now()
    WHERE machine_assignment_id = p_machine_assignment_id AND ended_at IS NULL;
    SELECT status INTO v_machine_status FROM master.machines WHERE machine_id = v_machine_id FOR UPDATE;
    IF v_machine_status = 'RUNNING' THEN
        INSERT INTO production.machine_status_events(machine_id, new_status, reason, reported_by)
        VALUES (v_machine_id, 'IDLE', 'Production assignment stopped', p_stopped_by);
    END IF;
    IF p_mark_completed THEN
        UPDATE production.jobs SET status = 'COMPLETED', completed_at = now() WHERE job_id = v_job_id;
    ELSE
        UPDATE production.jobs SET status = 'PAUSED' WHERE job_id = v_job_id AND status <> 'COMPLETED';
    END IF;
END;
$$;

CREATE FUNCTION production.validate_job_worker_assignment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_user_id bigint; v_job_stage text; v_skill_stage text;
BEGIN
    PERFORM auth.assert_role(NEW.assigned_by, ARRAY['SUPERVISOR','OWNER'], 'worker assignment creator');
    SELECT w.user_id, w.skill_stage INTO v_user_id, v_skill_stage
    FROM hr.workers w WHERE w.worker_id = NEW.worker_id AND w.is_active;
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'Worker not found or inactive'; END IF;
    SELECT j.stage INTO v_job_stage
    FROM production.machine_assignments ma JOIN production.jobs j ON j.job_id = ma.job_id
    WHERE ma.machine_assignment_id = NEW.machine_assignment_id;
    IF v_job_stage IS NULL THEN RAISE EXCEPTION 'Machine assignment not found'; END IF;
    IF v_skill_stage IS NOT NULL AND v_skill_stage <> v_job_stage THEN
        RAISE EXCEPTION 'Worker skill stage % does not match job stage %', v_skill_stage, v_job_stage;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_job_worker_assignment BEFORE INSERT OR UPDATE OF machine_assignment_id, worker_id, assigned_by
ON production.job_worker_assignments FOR EACH ROW EXECUTE FUNCTION production.validate_job_worker_assignment();

CREATE FUNCTION sales.guard_order_status_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_ordered_qty numeric(14,2); v_shipped_qty numeric(14,2); v_any_delivery boolean;
BEGIN
    IF OLD.status IN ('DELIVERED','CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Order % is terminal (%); create a separate return/credit workflow instead', OLD.order_no, OLD.status;
    END IF;
    IF NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED' THEN
        IF EXISTS (SELECT 1 FROM dispatch.shipments WHERE order_id = NEW.order_id AND status IN ('SHIPPED','DELIVERED')) THEN
            RAISE EXCEPTION 'An order with shipped goods cannot be cancelled';
        END IF;
    ELSIF NEW.status IN ('PARTIALLY_SHIPPED','SHIPPED','DELIVERED') AND OLD.status IS DISTINCT FROM NEW.status THEN
        SELECT COALESCE(SUM(quantity_m),0) INTO v_ordered_qty FROM sales.order_items WHERE order_id = NEW.order_id;
        SELECT COALESCE(SUM(r.length_meters),0) INTO v_shipped_qty
        FROM dispatch.shipment_items si
        JOIN dispatch.shipments sh ON sh.shipment_id = si.shipment_id
        JOIN production.rolls r ON r.roll_id = si.roll_id
        WHERE sh.order_id = NEW.order_id AND sh.status IN ('SHIPPED','DELIVERED');
        SELECT EXISTS (SELECT 1 FROM dispatch.shipments WHERE order_id = NEW.order_id AND status = 'DELIVERED') INTO v_any_delivery;
        IF NEW.status = 'PARTIALLY_SHIPPED' AND NOT (v_shipped_qty > 0 AND v_shipped_qty < v_ordered_qty) THEN
            RAISE EXCEPTION 'PARTIALLY_SHIPPED status must match actual shipped quantity';
        ELSIF NEW.status = 'SHIPPED' AND v_shipped_qty < v_ordered_qty THEN
            RAISE EXCEPTION 'SHIPPED status requires all ordered metres to have shipped';
        ELSIF NEW.status = 'DELIVERED' AND (NOT v_any_delivery OR EXISTS (
            SELECT 1 FROM dispatch.shipments WHERE order_id = NEW.order_id AND status NOT IN ('DELIVERED','CANCELLED')
        )) THEN
            RAISE EXCEPTION 'DELIVERED status requires every active shipment to be delivered';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_order_status BEFORE UPDATE OF status ON sales.orders
FOR EACH ROW EXECUTE FUNCTION sales.guard_order_status_change();

CREATE FUNCTION sales.release_cancelled_order_reservations()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'CANCELLED' THEN
        UPDATE inventory.yarn_reservations SET status = 'RELEASED', released_at = now()
        WHERE status = 'ACTIVE' AND order_item_id IN
          (SELECT order_item_id FROM sales.order_items WHERE order_id = NEW.order_id);
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_release_cancelled_order_reservations AFTER UPDATE OF status ON sales.orders
FOR EACH ROW EXECUTE FUNCTION sales.release_cancelled_order_reservations();

CREATE FUNCTION finance.guard_customer_invoice_header()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'ISSUED' THEN
        IF NEW.shipment_id IS DISTINCT FROM OLD.shipment_id
           OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
           OR NEW.due_date IS DISTINCT FROM OLD.due_date
           OR NEW.created_by IS DISTINCT FROM OLD.created_by
           OR NEW.invoice_no IS DISTINCT FROM OLD.invoice_no THEN
            RAISE EXCEPTION 'An issued invoice identity, shipment and dates are immutable';
        END IF;
        IF NEW.status NOT IN ('ISSUED','VOID') THEN RAISE EXCEPTION 'Issued invoices can only remain ISSUED or become VOID'; END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_customer_invoice_header BEFORE UPDATE ON finance.customer_invoices
FOR EACH ROW EXECUTE FUNCTION finance.guard_customer_invoice_header();

CREATE FUNCTION finance.validate_operating_expense()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM auth.assert_role(NEW.recorded_by, ARRAY['OWNER','STORE_MANAGER'], 'operating expense recorder');
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_operating_expense BEFORE INSERT OR UPDATE OF recorded_by ON finance.operating_expenses
FOR EACH ROW EXECUTE FUNCTION finance.validate_operating_expense();

CREATE FUNCTION hr.validate_wage_payment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.created_by IS NOT NULL THEN PERFORM auth.assert_role(NEW.created_by, ARRAY['OWNER','STORE_MANAGER'], 'wage payment creator'); END IF;
    IF NEW.paid_by IS NOT NULL THEN PERFORM auth.assert_role(NEW.paid_by, ARRAY['OWNER','STORE_MANAGER'], 'wage payment approver'); END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_wage_payment BEFORE INSERT OR UPDATE OF created_by, paid_by ON hr.wage_payments
FOR EACH ROW EXECUTE FUNCTION hr.validate_wage_payment();

CREATE FUNCTION hr.generate_wage_payment(
    p_worker_id bigint, p_period_start date, p_period_end date,
    p_created_by bigint, p_deductions numeric DEFAULT 0
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_gross numeric(14,2); v_id bigint;
BEGIN
    PERFORM auth.assert_role(p_created_by, ARRAY['OWNER','STORE_MANAGER'], 'wage run creator');
    IF p_period_end < p_period_start THEN RAISE EXCEPTION 'Wage period end cannot be before start'; END IF;
    IF p_deductions IS NULL OR p_deductions < 0 THEN RAISE EXCEPTION 'Deductions must be non-negative'; END IF;
    SELECT COALESCE(SUM(a.wage_amount),0) INTO v_gross
    FROM hr.attendance a WHERE a.worker_id = p_worker_id AND a.work_date BETWEEN p_period_start AND p_period_end;
    IF p_deductions > v_gross THEN RAISE EXCEPTION 'Deductions cannot exceed gross wage'; END IF;
    INSERT INTO hr.wage_payments(worker_id, period_start, period_end, gross_amount, deductions, created_by)
    VALUES (p_worker_id, p_period_start, p_period_end, v_gross, p_deductions, p_created_by)
    ON CONFLICT (worker_id, period_start, period_end) DO UPDATE
       SET gross_amount = EXCLUDED.gross_amount, deductions = EXCLUDED.deductions
     WHERE hr.wage_payments.status = 'PENDING'
    RETURNING wage_payment_id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Wage payment already exists and is not editable'; END IF;
    RETURN v_id;
END;
$$;

CREATE FUNCTION reporting.get_my_orders()
RETURNS SETOF reporting.customer_order_tracking LANGUAGE plpgsql STABLE AS $$
DECLARE v_user_id bigint := core.current_actor_id();
BEGIN
    IF auth.user_has_role(v_user_id, ARRAY['OWNER']) THEN
        RETURN QUERY SELECT * FROM reporting.customer_order_tracking;
    ELSIF auth.user_has_role(v_user_id, ARRAY['BUYER']) THEN
        RETURN QUERY SELECT * FROM reporting.customer_order_tracking t
        WHERE EXISTS (SELECT 1 FROM master.buyers b WHERE b.buyer_id = t.buyer_id AND b.user_id = v_user_id);
    ELSE
        RAISE EXCEPTION 'Role not permitted to use buyer order tracking';
    END IF;
END;
$$;

CREATE FUNCTION reporting.get_my_invoices()
RETURNS SETOF reporting.customer_invoice_balances LANGUAGE plpgsql STABLE AS $$
DECLARE v_user_id bigint := core.current_actor_id();
BEGIN
    IF auth.user_has_role(v_user_id, ARRAY['OWNER','DISPATCH_OFFICER']) THEN
        RETURN QUERY SELECT * FROM reporting.customer_invoice_balances;
    ELSIF auth.user_has_role(v_user_id, ARRAY['BUYER']) THEN
        RETURN QUERY SELECT * FROM reporting.customer_invoice_balances i
        WHERE EXISTS (SELECT 1 FROM master.buyers b WHERE b.buyer_id = i.buyer_id AND b.user_id = v_user_id);
    ELSE
        RAISE EXCEPTION 'Role not permitted to use buyer invoice view';
    END IF;
END;
$$;

/* Add the missing status check to supplier invoices: approval must name approver. */
ALTER TABLE procurement.supplier_invoices
ADD CONSTRAINT chk_supplier_invoice_approval CHECK (status <> 'APPROVED' OR approved_by IS NOT NULL);

/* Require any status change to a PO to match the underlying receiving records. */
CREATE FUNCTION procurement.guard_purchase_order_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_total_lines integer; v_any_received boolean; v_all_received boolean;
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF NEW.status = 'ISSUED' THEN
            IF OLD.status <> 'DRAFT' OR NEW.issued_by IS NULL OR NEW.issued_at IS NULL THEN
                RAISE EXCEPTION 'A PO can be issued only from DRAFT and must record issuer/time';
            END IF;
        ELSIF NEW.status IN ('PARTIALLY_RECEIVED','RECEIVED') THEN
            SELECT COUNT(*) INTO v_total_lines FROM procurement.purchase_order_items WHERE purchase_order_id = NEW.purchase_order_id;
            SELECT EXISTS (SELECT 1 FROM procurement.goods_receipts WHERE purchase_order_id = NEW.purchase_order_id) INTO v_any_received;
            SELECT NOT EXISTS (
                SELECT 1 FROM procurement.purchase_order_items poi
                WHERE poi.purchase_order_id = NEW.purchase_order_id
                  AND (SELECT COALESCE(SUM(gri.received_qty_kg),0) FROM procurement.goods_receipt_items gri WHERE gri.po_item_id=poi.po_item_id) < poi.ordered_qty_kg
            ) INTO v_all_received;
            IF v_total_lines = 0 OR NOT v_any_received THEN RAISE EXCEPTION 'PO receiving status requires PO lines and a goods receipt'; END IF;
            IF NEW.status = 'RECEIVED' AND NOT v_all_received THEN RAISE EXCEPTION 'PO cannot be RECEIVED until every line quantity is received'; END IF;
            IF NEW.status = 'PARTIALLY_RECEIVED' AND v_all_received THEN RAISE EXCEPTION 'PO is fully received and should use RECEIVED status'; END IF;
        ELSIF NEW.status = 'CANCELLED' THEN
            IF EXISTS (SELECT 1 FROM procurement.goods_receipts WHERE purchase_order_id=NEW.purchase_order_id) THEN
                RAISE EXCEPTION 'A PO with received goods cannot be cancelled; use a supplier-return workflow';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_purchase_order_status BEFORE UPDATE OF status ON procurement.purchase_orders
FOR EACH ROW EXECUTE FUNCTION procurement.guard_purchase_order_status();

/* Shipment lines are editable only while preparing; preserve shipped history. */
CREATE FUNCTION dispatch.guard_shipment_item_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; v_shipment_id bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN v_shipment_id := OLD.shipment_id; ELSE v_shipment_id := NEW.shipment_id; END IF;
    SELECT status INTO v_status FROM dispatch.shipments WHERE shipment_id = v_shipment_id;
    IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Shipment roll lines cannot be updated; delete/re-add before dispatch if correction is needed'; END IF;
    IF v_status NOT IN ('DRAFT','PACKED') THEN RAISE EXCEPTION 'Shipment lines can only be removed before shipping'; END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER trg_guard_shipment_item_mutation BEFORE UPDATE OR DELETE ON dispatch.shipment_items
FOR EACH ROW EXECUTE FUNCTION dispatch.guard_shipment_item_mutation();

/* Supplier invoice validation must run when status is updated too. */
DROP TRIGGER IF EXISTS trg_validate_supplier_invoice ON procurement.supplier_invoices;
CREATE TRIGGER trg_validate_supplier_invoice BEFORE INSERT OR UPDATE OF supplier_id, goods_receipt_id, recorded_by, approved_by, status
ON procurement.supplier_invoices FOR EACH ROW EXECUTE FUNCTION procurement.validate_supplier_invoice();

/* Customer payment amount changes must run through aggregate checks too. */
DROP TRIGGER IF EXISTS trg_validate_customer_payment ON finance.customer_payment_transactions;
CREATE TRIGGER trg_validate_customer_payment BEFORE INSERT OR UPDATE ON finance.customer_payment_transactions
FOR EACH ROW EXECUTE FUNCTION finance.validate_customer_payment();

/* Accurate column label: this view counts accepted material represented as lots. */
DROP VIEW reporting.raw_material_stock_by_type_colour;
CREATE VIEW reporting.raw_material_stock_by_type_colour AS
SELECT yt.yarn_type_id, yt.yarn_code, yt.yarn_name,
       yl.colour_id, c.colour_name,
       SUM(yl.received_qty_kg) AS accepted_received_kg,
       SUM(yl.on_hand_qty_kg) AS on_hand_kg,
       COUNT(*) FILTER (WHERE yl.on_hand_qty_kg > 0 AND yl.status <> 'QUARANTINED') AS lots_with_stock,
       COALESCE(yt.reorder_level_kg, (SELECT setting_value::numeric FROM core.app_settings WHERE setting_key='low_stock_default_kg')) AS reorder_level_kg
FROM inventory.yarn_lots yl
JOIN master.yarn_types yt ON yt.yarn_type_id = yl.yarn_type_id
LEFT JOIN master.colours c ON c.colour_id = yl.colour_id
GROUP BY yt.yarn_type_id, yt.yarn_code, yt.yarn_name, yl.colour_id, c.colour_name, yt.reorder_level_kg;



/* Final workflow-transition guards. */
CREATE FUNCTION sales.guard_order_item_edits()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_order_id bigint; v_status text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_order_id := OLD.order_id;
    ELSE
        v_order_id := NEW.order_id;
    END IF;
    SELECT status INTO v_status FROM sales.orders WHERE order_id = v_order_id;
    IF TG_OP = 'INSERT' THEN
        IF v_status IS DISTINCT FROM 'PLACED' THEN RAISE EXCEPTION 'Order lines can only be added while order is PLACED'; END IF;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        IF v_status IS DISTINCT FROM 'PLACED' THEN RAISE EXCEPTION 'Order lines can only be deleted while order is PLACED'; END IF;
        RETURN OLD;
    ELSE
        IF NEW.order_id IS DISTINCT FROM OLD.order_id AND v_status IS DISTINCT FROM 'PLACED' THEN
            RAISE EXCEPTION 'Order lines cannot be moved after order confirmation';
        END IF;
        IF (NEW.order_id, NEW.line_no, NEW.fabric_type_id, NEW.colour_id, NEW.quantity_m, NEW.rate_per_m, NEW.tax_percent)
            IS DISTINCT FROM
           (OLD.order_id, OLD.line_no, OLD.fabric_type_id, OLD.colour_id, OLD.quantity_m, OLD.rate_per_m, OLD.tax_percent)
           AND v_status IS DISTINCT FROM 'PLACED' THEN
            RAISE EXCEPTION 'Order line quantities, fabric, colour, price and tax are immutable after order confirmation';
        END IF;
        RETURN NEW;
    END IF;
END;
$$;
CREATE TRIGGER trg_guard_order_item_edits BEFORE INSERT OR UPDATE OR DELETE ON sales.order_items
FOR EACH ROW EXECUTE FUNCTION sales.guard_order_item_edits();

CREATE OR REPLACE FUNCTION sales.guard_order_status_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_ordered_qty numeric(14,2); v_shipped_qty numeric(14,2); v_any_delivery boolean;
BEGIN
    IF OLD.status IN ('DELIVERED','CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Order % is terminal (%); create a separate return/credit workflow instead', OLD.order_no, OLD.status;
    END IF;
    IF OLD.status = 'SHIPPED' AND NEW.status NOT IN ('SHIPPED','DELIVERED') THEN
        RAISE EXCEPTION 'A fully shipped order can only remain SHIPPED or become DELIVERED';
    END IF;
    IF OLD.status = 'PARTIALLY_SHIPPED' AND NEW.status NOT IN ('PARTIALLY_SHIPPED','SHIPPED','DELIVERED') THEN
        RAISE EXCEPTION 'A partially shipped order cannot return to an earlier production state';
    END IF;
    IF NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED' THEN
        IF EXISTS (SELECT 1 FROM dispatch.shipments WHERE order_id = NEW.order_id AND status IN ('SHIPPED','DELIVERED')) THEN
            RAISE EXCEPTION 'An order with shipped goods cannot be cancelled';
        END IF;
    ELSIF NEW.status IN ('PARTIALLY_SHIPPED','SHIPPED','DELIVERED') AND OLD.status IS DISTINCT FROM NEW.status THEN
        SELECT COALESCE(SUM(quantity_m),0) INTO v_ordered_qty FROM sales.order_items WHERE order_id = NEW.order_id;
        SELECT COALESCE(SUM(r.length_meters),0) INTO v_shipped_qty
        FROM dispatch.shipment_items si
        JOIN dispatch.shipments sh ON sh.shipment_id = si.shipment_id
        JOIN production.rolls r ON r.roll_id = si.roll_id
        WHERE sh.order_id = NEW.order_id AND sh.status IN ('SHIPPED','DELIVERED');
        SELECT EXISTS (SELECT 1 FROM dispatch.shipments WHERE order_id = NEW.order_id AND status = 'DELIVERED') INTO v_any_delivery;
        IF NEW.status = 'PARTIALLY_SHIPPED' AND NOT (v_shipped_qty > 0 AND v_shipped_qty < v_ordered_qty) THEN
            RAISE EXCEPTION 'PARTIALLY_SHIPPED status must match actual shipped quantity';
        ELSIF NEW.status = 'SHIPPED' AND v_shipped_qty < v_ordered_qty THEN
            RAISE EXCEPTION 'SHIPPED status requires all ordered metres to have shipped';
        ELSIF NEW.status = 'DELIVERED' AND (NOT v_any_delivery OR EXISTS (
            SELECT 1 FROM dispatch.shipments WHERE order_id = NEW.order_id AND status NOT IN ('DELIVERED','CANCELLED')
        )) THEN
            RAISE EXCEPTION 'DELIVERED status requires every active shipment to be delivered';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION procurement.guard_purchase_order_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_total_lines integer; v_any_received boolean; v_all_received boolean;
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF OLD.status = 'CANCELLED' OR OLD.status = 'RECEIVED' THEN
            RAISE EXCEPTION 'A % purchase order is terminal', OLD.status;
        END IF;
        IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('ISSUED','CANCELLED') THEN
            RAISE EXCEPTION 'A DRAFT PO can only be ISSUED or CANCELLED';
        ELSIF OLD.status = 'ISSUED' AND NEW.status NOT IN ('PARTIALLY_RECEIVED','RECEIVED','CANCELLED') THEN
            RAISE EXCEPTION 'An ISSUED PO can only be received or cancelled before goods arrive';
        ELSIF OLD.status = 'PARTIALLY_RECEIVED' AND NEW.status <> 'RECEIVED' THEN
            RAISE EXCEPTION 'A partially received PO can only become RECEIVED';
        END IF;
        IF NEW.status = 'ISSUED' THEN
            IF OLD.status <> 'DRAFT' OR NEW.issued_by IS NULL OR NEW.issued_at IS NULL THEN
                RAISE EXCEPTION 'A PO can be issued only from DRAFT and must record issuer/time';
            END IF;
        ELSIF NEW.status IN ('PARTIALLY_RECEIVED','RECEIVED') THEN
            SELECT COUNT(*) INTO v_total_lines FROM procurement.purchase_order_items WHERE purchase_order_id = NEW.purchase_order_id;
            SELECT EXISTS (SELECT 1 FROM procurement.goods_receipts WHERE purchase_order_id = NEW.purchase_order_id) INTO v_any_received;
            SELECT NOT EXISTS (
                SELECT 1 FROM procurement.purchase_order_items poi
                WHERE poi.purchase_order_id = NEW.purchase_order_id
                  AND (SELECT COALESCE(SUM(gri.received_qty_kg),0) FROM procurement.goods_receipt_items gri WHERE gri.po_item_id=poi.po_item_id) < poi.ordered_qty_kg
            ) INTO v_all_received;
            IF v_total_lines = 0 OR NOT v_any_received THEN RAISE EXCEPTION 'PO receiving status requires PO lines and a goods receipt'; END IF;
            IF NEW.status = 'RECEIVED' AND NOT v_all_received THEN RAISE EXCEPTION 'PO cannot be RECEIVED until every line quantity is received'; END IF;
            IF NEW.status = 'PARTIALLY_RECEIVED' AND v_all_received THEN RAISE EXCEPTION 'PO is fully received and should use RECEIVED status'; END IF;
        ELSIF NEW.status = 'CANCELLED' THEN
            IF EXISTS (SELECT 1 FROM procurement.goods_receipts WHERE purchase_order_id=NEW.purchase_order_id) THEN
                RAISE EXCEPTION 'A PO with received goods cannot be cancelled; use a supplier-return workflow';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dispatch.prepare_shipment_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_has_items boolean;
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF OLD.status IN ('DELIVERED','CANCELLED') THEN
            RAISE EXCEPTION 'A % shipment is terminal', OLD.status;
        ELSIF OLD.status = 'DRAFT' AND NEW.status NOT IN ('PACKED','CANCELLED') THEN
            RAISE EXCEPTION 'A DRAFT shipment can only be PACKED or CANCELLED';
        ELSIF OLD.status = 'PACKED' AND NEW.status NOT IN ('SHIPPED','CANCELLED') THEN
            RAISE EXCEPTION 'A PACKED shipment can only be SHIPPED or CANCELLED';
        ELSIF OLD.status = 'SHIPPED' AND NEW.status <> 'DELIVERED' THEN
            RAISE EXCEPTION 'A SHIPPED shipment can only become DELIVERED';
        END IF;
    END IF;

    IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'PACKED' THEN
        SELECT EXISTS (SELECT 1 FROM dispatch.shipment_items WHERE shipment_id = NEW.shipment_id) INTO v_has_items;
        IF NOT v_has_items THEN RAISE EXCEPTION 'A shipment must contain at least one roll before packing'; END IF;
        IF NEW.packed_at IS NULL THEN NEW.packed_at := now(); END IF;
    ELSIF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'SHIPPED' THEN
        PERFORM auth.assert_role(COALESCE(NEW.dispatched_by, core.current_actor_id()), ARRAY['DISPATCH_OFFICER','OWNER'], 'shipment dispatch');
        IF NEW.shipped_at IS NULL THEN NEW.shipped_at := now(); END IF;
        IF NEW.dispatched_by IS NULL THEN NEW.dispatched_by := core.current_actor_id(); END IF;
        SELECT EXISTS (SELECT 1 FROM dispatch.shipment_items WHERE shipment_id = NEW.shipment_id) INTO v_has_items;
        IF NOT v_has_items THEN RAISE EXCEPTION 'A shipment must contain at least one roll before shipping'; END IF;
        IF EXISTS (
            SELECT 1 FROM dispatch.shipment_items si
            JOIN production.rolls r ON r.roll_id = si.roll_id
            WHERE si.shipment_id = NEW.shipment_id AND r.current_status <> 'PASSED'
        ) THEN RAISE EXCEPTION 'Every roll must be QC-passed immediately before shipping'; END IF;
        IF EXISTS (SELECT 1 FROM sales.orders WHERE order_id = NEW.order_id AND status = 'CANCELLED') THEN
            RAISE EXCEPTION 'A cancelled customer order cannot be shipped';
        END IF;
    ELSIF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'DELIVERED' THEN
        IF NEW.delivered_at IS NULL THEN NEW.delivered_at := now(); END IF;
        IF NOT EXISTS (SELECT 1 FROM finance.customer_invoices WHERE shipment_id = NEW.shipment_id AND status = 'ISSUED') THEN
            RAISE EXCEPTION 'A shipment requires an issued customer invoice before it can be marked DELIVERED';
        END IF;
    ELSIF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'CANCELLED' THEN
        IF NEW.cancelled_at IS NULL THEN NEW.cancelled_at := now(); END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION quality.apply_inspection_result()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
    PERFORM auth.assert_role(NEW.inspected_by, ARRAY['SUPERVISOR','OWNER'], 'quality inspector');
    SELECT current_status INTO v_status FROM production.rolls WHERE roll_id = NEW.roll_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Roll not found'; END IF;
    IF v_status = 'DISPATCHED' THEN RAISE EXCEPTION 'A dispatched roll cannot be reinspected'; END IF;
    PERFORM set_config('app.allow_roll_status_change','true',true);
    UPDATE production.rolls
       SET current_status = CASE NEW.result WHEN 'PASS' THEN 'PASSED'
                                 WHEN 'REWORK' THEN 'REWORK' ELSE 'REJECTED' END
     WHERE roll_id = NEW.roll_id;
    PERFORM set_config('app.allow_roll_status_change','false',true);
    RETURN NEW;
END;
$$;

CREATE FUNCTION production.guard_roll_status_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.current_status IS DISTINCT FROM NEW.current_status
       AND current_setting('app.allow_roll_status_change', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'Roll QC/dispatch status is system-controlled; use QC inspection or shipment workflow';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_roll_status_change BEFORE UPDATE OF current_status ON production.rolls
FOR EACH ROW EXECUTE FUNCTION production.guard_roll_status_change();

CREATE OR REPLACE FUNCTION dispatch.finish_shipment_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_total_order_qty numeric(14,2); v_total_shipped numeric(14,2);
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'SHIPPED' THEN
        PERFORM set_config('app.allow_roll_status_change','true',true);
        UPDATE production.rolls r SET current_status = 'DISPATCHED'
        FROM dispatch.shipment_items si
        WHERE si.shipment_id = NEW.shipment_id AND si.roll_id = r.roll_id;
        PERFORM set_config('app.allow_roll_status_change','false',true);

        SELECT COALESCE(SUM(oi.quantity_m),0) INTO v_total_order_qty
        FROM sales.order_items oi WHERE oi.order_id = NEW.order_id;
        SELECT COALESCE(SUM(r.length_meters),0) INTO v_total_shipped
        FROM dispatch.shipment_items si
        JOIN dispatch.shipments sh ON sh.shipment_id = si.shipment_id
        JOIN production.rolls r ON r.roll_id = si.roll_id
        WHERE sh.order_id = NEW.order_id AND sh.status IN ('SHIPPED','DELIVERED');
        UPDATE sales.orders
           SET status = CASE WHEN v_total_shipped >= v_total_order_qty THEN 'SHIPPED' ELSE 'PARTIALLY_SHIPPED' END
         WHERE order_id = NEW.order_id AND status NOT IN ('CANCELLED','DELIVERED');
    ELSIF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'DELIVERED' THEN
        UPDATE sales.orders o SET status = 'DELIVERED'
         WHERE o.order_id = NEW.order_id
           AND NOT EXISTS (
               SELECT 1 FROM dispatch.shipments sh
               WHERE sh.order_id = o.order_id AND sh.status NOT IN ('DELIVERED','CANCELLED')
           )
           AND EXISTS (
               SELECT 1 FROM dispatch.shipments sh
               WHERE sh.order_id = o.order_id AND sh.status = 'DELIVERED'
           );
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE VIEW reporting.customer_order_tracking AS
SELECT o.order_id, o.order_no, o.order_date, o.required_by_date,
       CASE
         WHEN o.status IN ('CANCELLED','DELIVERED') THEN o.status
         WHEN COALESCE(SUM(p.dispatched_meters),0) >= COALESCE(SUM(p.ordered_meters),0)
              AND COALESCE(SUM(p.ordered_meters),0) > 0 THEN 'SHIPPED'
         WHEN COALESCE(SUM(p.dispatched_meters),0) > 0 THEN 'PARTIALLY_SHIPPED'
         WHEN COALESCE(SUM(p.qc_passed_meters),0) >= COALESCE(SUM(p.ordered_meters),0)
              AND COALESCE(SUM(p.ordered_meters),0) > 0 THEN 'READY_TO_SHIP'
         WHEN COALESCE(SUM(p.pending_qc_meters),0) > 0 THEN 'IN_QC'
         WHEN COALESCE(SUM(p.produced_meters),0) > 0 THEN 'IN_PRODUCTION'
         ELSE o.status
       END AS status,
       b.buyer_id, b.buyer_code, b.company_name,
       COUNT(p.order_item_id) AS line_count,
       COALESCE(SUM(p.ordered_meters),0) AS ordered_meters,
       COALESCE(SUM(p.produced_meters),0) AS produced_meters,
       COALESCE(SUM(p.qc_passed_meters),0) AS qc_passed_meters,
       COALESCE(SUM(p.dispatched_meters),0) AS dispatched_meters,
       LEAST(100, round(COALESCE(SUM(p.produced_meters),0) / NULLIF(SUM(p.ordered_meters),0) * 100, 2)) AS production_percent,
       LEAST(100, round(COALESCE(SUM(p.dispatched_meters),0) / NULLIF(SUM(p.ordered_meters),0) * 100, 2)) AS dispatch_percent
FROM sales.orders o
JOIN master.buyers b ON b.buyer_id = o.buyer_id
LEFT JOIN reporting.order_progress_by_line p ON p.order_id = o.order_id
GROUP BY o.order_id, o.order_no, o.order_date, o.required_by_date, o.status,
         b.buyer_id, b.buyer_code, b.company_name;



/* Consume reservations when yarn is issued and keep cost snapshots trustworthy. */
CREATE OR REPLACE FUNCTION inventory.post_material_issue_item()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_unit_cost numeric(12,4);
    v_lot_type bigint;
    v_fabric_type bigint;
    v_order_item_id bigint;
    v_job_status text;
    v_total_stock numeric(12,3);
    v_reserved_for_others numeric(12,3);
    v_remaining_issue numeric(12,3);
    v_res record;
BEGIN
    SELECT yl.unit_cost_per_kg, yl.yarn_type_id INTO v_unit_cost, v_lot_type
    FROM inventory.yarn_lots yl WHERE yl.yarn_lot_id = NEW.yarn_lot_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Yarn lot not found'; END IF;
    NEW.unit_cost_snapshot := v_unit_cost;

    SELECT j.status, j.order_item_id, ft.fabric_type_id
      INTO v_job_status, v_order_item_id, v_fabric_type
    FROM inventory.material_issues mi
    JOIN production.jobs j ON j.job_id = mi.job_id
    JOIN sales.order_items oi ON oi.order_item_id = j.order_item_id
    JOIN master.fabric_types ft ON ft.fabric_type_id = oi.fabric_type_id
    WHERE mi.material_issue_id = NEW.material_issue_id;
    IF v_job_status IS NULL THEN RAISE EXCEPTION 'Material issue job not found'; END IF;
    IF v_job_status IN ('COMPLETED','CANCELLED') THEN RAISE EXCEPTION 'Cannot issue material to a completed or cancelled job'; END IF;
    IF NOT EXISTS (SELECT 1 FROM master.fabric_bom b WHERE b.fabric_type_id = v_fabric_type AND b.yarn_type_id = v_lot_type) THEN
        RAISE EXCEPTION 'Yarn type is not in the fabric bill of materials for this job';
    END IF;

    -- Do not consume material already reserved for a different customer order line.
    PERFORM pg_advisory_xact_lock(v_lot_type);
    SELECT COALESCE(SUM(yl.on_hand_qty_kg),0) INTO v_total_stock
    FROM inventory.yarn_lots yl
    WHERE yl.yarn_type_id = v_lot_type AND yl.status <> 'QUARANTINED';
    SELECT COALESCE(SUM(yr.quantity_kg),0) INTO v_reserved_for_others
    FROM inventory.yarn_reservations yr
    WHERE yr.yarn_type_id = v_lot_type AND yr.status = 'ACTIVE'
      AND yr.order_item_id <> v_order_item_id;
    IF v_total_stock - NEW.quantity_kg < v_reserved_for_others THEN
        RAISE EXCEPTION 'Issue would consume yarn reserved for another order; stock %, reserved for others %, requested %',
            v_total_stock, v_reserved_for_others, NEW.quantity_kg;
    END IF;

    INSERT INTO inventory.stock_movements(yarn_lot_id, movement_type, quantity_delta_kg,
       unit_cost_snapshot, source_type, source_id, source_line_id, moved_by, remarks)
    SELECT NEW.yarn_lot_id, 'ISSUE', -NEW.quantity_kg, NEW.unit_cost_snapshot,
           'MATERIAL_ISSUE', mi.material_issue_id, NEW.material_issue_item_id,
           mi.issued_by, 'Yarn issued to production job'
    FROM inventory.material_issues mi WHERE mi.material_issue_id = NEW.material_issue_id;

    -- Reduce this order line's active reservation FIFO; consumed reservations remain as history.
    v_remaining_issue := NEW.quantity_kg;
    FOR v_res IN
        SELECT yr.reservation_id, yr.quantity_kg
        FROM inventory.yarn_reservations yr
        WHERE yr.order_item_id = v_order_item_id
          AND yr.yarn_type_id = v_lot_type AND yr.status = 'ACTIVE'
        ORDER BY yr.reservation_id
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining_issue <= 0;
        IF v_res.quantity_kg <= v_remaining_issue THEN
            UPDATE inventory.yarn_reservations
               SET status = 'CONSUMED', released_at = now()
             WHERE reservation_id = v_res.reservation_id;
            v_remaining_issue := v_remaining_issue - v_res.quantity_kg;
        ELSE
            UPDATE inventory.yarn_reservations
               SET quantity_kg = quantity_kg - v_remaining_issue
             WHERE reservation_id = v_res.reservation_id;
            v_remaining_issue := 0;
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;

CREATE FUNCTION inventory.prevent_material_issue_item_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Material issue records are append-only; correct stock with a return/reversal movement';
END;
$$;
CREATE TRIGGER trg_material_issue_item_immutable BEFORE UPDATE OR DELETE ON inventory.material_issue_items
FOR EACH ROW EXECUTE FUNCTION inventory.prevent_material_issue_item_mutation();

/* Replace the utilisation metric with actual RUNNING intervals, not merely
   machine assignments. Its denominator is a 24-hour day and is named as such. */
DROP VIEW reporting.machine_utilization_today;
CREATE VIEW reporting.machine_utilization_today AS
WITH bounds AS (
    SELECT (((now() AT TIME ZONE 'Asia/Kolkata')::date)::timestamp AT TIME ZONE 'Asia/Kolkata') AS day_start,
           ((((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)::timestamp) AT TIME ZONE 'Asia/Kolkata') AS day_end
), running AS (
    SELECT e.machine_id,
           SUM(GREATEST(0, EXTRACT(EPOCH FROM
              (LEAST(COALESCE(e.ended_at,now()), b.day_end) - GREATEST(e.started_at,b.day_start))) / 3600.0)) AS running_hours
    FROM production.machine_status_events e CROSS JOIN bounds b
    WHERE e.new_status = 'RUNNING'
      AND e.started_at < b.day_end
      AND COALESCE(e.ended_at,now()) > b.day_start
    GROUP BY e.machine_id
)
SELECT m.machine_id, m.machine_code, m.machine_name, m.stage, m.status,
       round(COALESCE(r.running_hours,0)::numeric,2) AS running_hours_today,
       round(LEAST(100, COALESCE(r.running_hours,0) / 24.0 * 100)::numeric,2) AS utilization_pct_of_24h
FROM master.machines m LEFT JOIN running r ON r.machine_id = m.machine_id;

/* Safe helper for starting a gateway or manual customer payment. The payment
   trigger also enforces the invoice aggregate cap on inserts/status updates. */
CREATE FUNCTION finance.start_customer_payment(
    p_customer_invoice_id bigint,
    p_provider text,
    p_amount numeric,
    p_created_by bigint,
    p_payment_method text DEFAULT NULL,
    p_gateway_order_id text DEFAULT NULL
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_payment_id bigint;
BEGIN
    INSERT INTO finance.customer_payment_transactions(
        customer_invoice_id, provider, payment_method, amount, status,
        gateway_order_id, created_by
    ) VALUES (
        p_customer_invoice_id, p_provider, p_payment_method, p_amount, 'INITIATED',
        p_gateway_order_id, p_created_by
    ) RETURNING customer_payment_id INTO v_payment_id;
    RETURN v_payment_id;
END;
$$;

/* Guarded order status and reservation triggers defined above are intentionally
   not bypassed by these helpers. */



/* Prevent output logging during a breakdown/maintenance interval. */
CREATE OR REPLACE FUNCTION production.apply_machine_status_event_after()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE production.machine_status_events
       SET ended_at = NEW.started_at
     WHERE machine_id = NEW.machine_id AND machine_status_event_id <> NEW.machine_status_event_id
       AND ended_at IS NULL AND started_at <= NEW.started_at;
    UPDATE master.machines SET status = NEW.new_status WHERE machine_id = NEW.machine_id;

    IF NEW.new_status <> 'RUNNING' THEN
        UPDATE production.machine_assignments
           SET status = 'PAUSED'
         WHERE machine_id = NEW.machine_id AND status = 'RUNNING';
        UPDATE production.job_worker_assignments jwa SET ended_at = NEW.started_at
        FROM production.machine_assignments ma
        WHERE ma.machine_assignment_id = jwa.machine_assignment_id
          AND ma.machine_id = NEW.machine_id AND jwa.ended_at IS NULL;
        UPDATE production.jobs j SET status = 'PAUSED'
        FROM production.machine_assignments ma
        WHERE ma.job_id = j.job_id AND ma.machine_id = NEW.machine_id AND j.status = 'IN_PROGRESS';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION sales.release_cancelled_order_reservations()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'CANCELLED' THEN
        UPDATE inventory.yarn_reservations SET status = 'RELEASED', released_at = now()
        WHERE status = 'ACTIVE' AND order_item_id IN
          (SELECT order_item_id FROM sales.order_items WHERE order_id = NEW.order_id);
        UPDATE dispatch.shipments
           SET status = 'CANCELLED', cancelled_at = COALESCE(cancelled_at, now()),
               cancellation_reason = COALESCE(cancellation_reason, 'Customer order cancelled')
         WHERE order_id = NEW.order_id AND status IN ('DRAFT','PACKED');
    END IF;
    RETURN NEW;
END;
$$;



/* Keep customer identity immutable and retain a transaction-time ship-to
   snapshot so later edits to an address book entry do not rewrite history. */
CREATE FUNCTION sales.guard_order_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_address_buyer bigint; v_address_snapshot jsonb;
BEGIN
    IF NEW.buyer_id IS DISTINCT FROM OLD.buyer_id THEN
        RAISE EXCEPTION 'The buyer on an existing order cannot be changed';
    END IF;
    IF NEW.placed_by IS DISTINCT FROM OLD.placed_by THEN
        RAISE EXCEPTION 'The order creator cannot be changed';
    END IF;
    IF NEW.shipping_address_id IS DISTINCT FROM OLD.shipping_address_id THEN
        IF OLD.status <> 'PLACED' THEN RAISE EXCEPTION 'Shipping address can only be changed before order confirmation'; END IF;
        IF NEW.shipping_address_id IS NULL THEN
            NEW.ship_to_snapshot := NULL;
        ELSE
            SELECT a.buyer_id,
                   jsonb_build_object('address_type',a.address_type,'label',a.label,'line1',a.line1,'line2',a.line2,
                                      'city',a.city,'state',a.state,'pincode',a.pincode,'country',a.country)
              INTO v_address_buyer, v_address_snapshot
              FROM master.buyer_addresses a WHERE a.address_id = NEW.shipping_address_id;
            IF v_address_buyer IS DISTINCT FROM NEW.buyer_id THEN RAISE EXCEPTION 'Shipping address does not belong to this buyer'; END IF;
            NEW.ship_to_snapshot := v_address_snapshot;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_order_identity BEFORE UPDATE OF buyer_id, placed_by, shipping_address_id ON sales.orders
FOR EACH ROW EXECUTE FUNCTION sales.guard_order_identity();

/* Supplier invoice lines are fixed once approved; approval must be explicit. */
ALTER TABLE hr.wage_payments
ADD CONSTRAINT chk_paid_wage_has_payer CHECK (status <> 'PAID' OR paid_by IS NOT NULL);
DROP TRIGGER IF EXISTS trg_validate_wage_payment ON hr.wage_payments;
CREATE TRIGGER trg_validate_wage_payment BEFORE INSERT OR UPDATE ON hr.wage_payments
FOR EACH ROW EXECUTE FUNCTION hr.validate_wage_payment();

/* Refuse reopening of a received PO and prevent fabricated receipt states. */
CREATE OR REPLACE FUNCTION procurement.guard_purchase_order_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_total_lines integer; v_any_received boolean; v_all_received boolean;
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF OLD.status IN ('CANCELLED','RECEIVED') THEN
            RAISE EXCEPTION 'A % purchase order is terminal', OLD.status;
        END IF;
        IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('ISSUED','CANCELLED') THEN
            RAISE EXCEPTION 'A DRAFT PO can only be ISSUED or CANCELLED';
        ELSIF OLD.status = 'ISSUED' AND NEW.status NOT IN ('PARTIALLY_RECEIVED','RECEIVED','CANCELLED') THEN
            RAISE EXCEPTION 'An ISSUED PO can only be received or cancelled before goods arrive';
        ELSIF OLD.status = 'PARTIALLY_RECEIVED' AND NEW.status <> 'RECEIVED' THEN
            RAISE EXCEPTION 'A partially received PO can only become RECEIVED';
        END IF;
        IF NEW.status = 'ISSUED' THEN
            IF OLD.status <> 'DRAFT' OR NEW.issued_by IS NULL OR NEW.issued_at IS NULL THEN
                RAISE EXCEPTION 'A PO can be issued only from DRAFT and must record issuer/time';
            END IF;
        ELSIF NEW.status IN ('PARTIALLY_RECEIVED','RECEIVED') THEN
            SELECT COUNT(*) INTO v_total_lines FROM procurement.purchase_order_items WHERE purchase_order_id = NEW.purchase_order_id;
            SELECT EXISTS (SELECT 1 FROM procurement.goods_receipts WHERE purchase_order_id = NEW.purchase_order_id) INTO v_any_received;
            SELECT NOT EXISTS (
                SELECT 1 FROM procurement.purchase_order_items poi
                WHERE poi.purchase_order_id = NEW.purchase_order_id
                  AND (SELECT COALESCE(SUM(gri.received_qty_kg),0) FROM procurement.goods_receipt_items gri WHERE gri.po_item_id=poi.po_item_id) < poi.ordered_qty_kg
            ) INTO v_all_received;
            IF v_total_lines = 0 OR NOT v_any_received THEN RAISE EXCEPTION 'PO receiving status requires PO lines and a goods receipt'; END IF;
            IF NEW.status = 'RECEIVED' AND NOT v_all_received THEN RAISE EXCEPTION 'PO cannot be RECEIVED until every line quantity is received'; END IF;
            IF NEW.status = 'PARTIALLY_RECEIVED' AND v_all_received THEN RAISE EXCEPTION 'PO is fully received and should use RECEIVED status'; END IF;
        ELSIF NEW.status = 'CANCELLED' THEN
            IF EXISTS (SELECT 1 FROM procurement.goods_receipts WHERE purchase_order_id=NEW.purchase_order_id) THEN
                RAISE EXCEPTION 'A PO with received goods cannot be cancelled; use a supplier-return workflow';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

/* Refund payment events and supplier payments are append/transition-oriented;
   the application should call them in transactions and verify gateway signatures. */


/* --------------------------------------------------------------------------
   FINAL HARDENING AND DASHBOARD VIEWS
   These final definitions tighten initial states and protect ledger integrity.
   -------------------------------------------------------------------------- */

CREATE OR REPLACE FUNCTION sales.validate_order()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_buyer_user bigint; v_address_buyer bigint; v_address_snapshot jsonb;
BEGIN
    SELECT user_id INTO v_buyer_user
    FROM master.buyers WHERE buyer_id = NEW.buyer_id AND is_active;
    IF v_buyer_user IS NULL THEN RAISE EXCEPTION 'Buyer is missing or inactive'; END IF;
    PERFORM auth.assert_role(NEW.placed_by, ARRAY['BUYER','OWNER'], 'order creator');
    IF auth.user_has_role(NEW.placed_by, ARRAY['BUYER']) AND NEW.placed_by <> v_buyer_user THEN
        RAISE EXCEPTION 'A buyer may only place orders for their own buyer account' USING ERRCODE = '42501';
    END IF;
    IF NEW.shipping_address_id IS NOT NULL THEN
        SELECT a.buyer_id,
               jsonb_build_object('address_type',a.address_type,'label',a.label,'line1',a.line1,'line2',a.line2,
                                  'city',a.city,'state',a.state,'pincode',a.pincode,'country',a.country)
          INTO v_address_buyer, v_address_snapshot
          FROM master.buyer_addresses a WHERE a.address_id = NEW.shipping_address_id;
        IF v_address_buyer IS DISTINCT FROM NEW.buyer_id THEN
            RAISE EXCEPTION 'Shipping address does not belong to this buyer';
        END IF;
        NEW.ship_to_snapshot := v_address_snapshot;
    ELSE
        NEW.ship_to_snapshot := NULL;
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.status := 'PLACED';
        NEW.confirmed_by := NULL;
        NEW.confirmed_at := NULL;
        NEW.cancel_reason := NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION procurement.validate_purchase_order()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM auth.assert_role(NEW.created_by, ARRAY['STORE_MANAGER','OWNER'], 'purchase order creator');
    IF TG_OP = 'INSERT' THEN
        NEW.status := 'DRAFT';
        NEW.issued_by := NULL;
        NEW.issued_at := NULL;
    END IF;
    IF NEW.issued_by IS NOT NULL THEN
        PERFORM auth.assert_role(NEW.issued_by, ARRAY['STORE_MANAGER','OWNER'], 'purchase order issuer');
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION production.validate_job_creator()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM auth.assert_role(NEW.created_by, ARRAY['SUPERVISOR','OWNER'], 'production job creator');
    IF TG_OP = 'INSERT' THEN
        NEW.status := 'PLANNED';
        NEW.started_at := NULL;
        NEW.completed_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION production.validate_machine_assignment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_job_stage text; v_machine_stage text;
BEGIN
    PERFORM auth.assert_role(NEW.assigned_by, ARRAY['SUPERVISOR','OWNER'], 'machine assignment creator');
    SELECT stage INTO v_job_stage FROM production.jobs WHERE job_id = NEW.job_id;
    SELECT stage INTO v_machine_stage FROM master.machines WHERE machine_id = NEW.machine_id AND is_active;
    IF v_machine_stage IS NULL THEN RAISE EXCEPTION 'Machine does not exist or is inactive'; END IF;
    IF v_job_stage IS DISTINCT FROM v_machine_stage THEN
        RAISE EXCEPTION 'Job stage % cannot be assigned to machine stage %', v_job_stage, v_machine_stage;
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.status := 'ASSIGNED';
        NEW.started_at := NULL;
        NEW.ended_at := NULL;
        NEW.started_by := NULL;
        NEW.ended_by := NULL;
    END IF;
    IF NEW.started_by IS NOT NULL THEN PERFORM auth.assert_role(NEW.started_by, ARRAY['WORKER','SUPERVISOR','OWNER'], 'job starter'); END IF;
    IF NEW.ended_by IS NOT NULL THEN PERFORM auth.assert_role(NEW.ended_by, ARRAY['WORKER','SUPERVISOR','OWNER'], 'job stopper'); END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dispatch.validate_shipment_creator()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM auth.assert_role(NEW.created_by, ARRAY['DISPATCH_OFFICER','OWNER'], 'shipment creator');
    IF TG_OP = 'INSERT' THEN
        NEW.status := 'DRAFT';
        NEW.dispatched_by := NULL;
        NEW.packed_at := NULL;
        NEW.shipped_at := NULL;
        NEW.delivered_at := NULL;
        NEW.cancelled_at := NULL;
        NEW.cancellation_reason := NULL;
    END IF;
    IF NEW.dispatched_by IS NOT NULL THEN
        PERFORM auth.assert_role(NEW.dispatched_by, ARRAY['DISPATCH_OFFICER','OWNER'], 'dispatch confirmer');
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION procurement.validate_supplier_invoice()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_supplier_id bigint; v_item_count bigint;
BEGIN
    PERFORM auth.assert_role(NEW.recorded_by, ARRAY['STORE_MANAGER','OWNER'], 'supplier invoice recorder');
    IF TG_OP = 'INSERT' THEN
        NEW.status := 'RECORDED';
        NEW.approved_by := NULL;
    END IF;
    IF NEW.approved_by IS NOT NULL THEN
        PERFORM auth.assert_role(NEW.approved_by, ARRAY['STORE_MANAGER','OWNER'], 'supplier invoice approver');
    END IF;
    SELECT po.supplier_id INTO v_supplier_id
    FROM procurement.goods_receipts gr
    JOIN procurement.purchase_orders po ON po.purchase_order_id = gr.purchase_order_id
    WHERE gr.goods_receipt_id = NEW.goods_receipt_id;
    IF v_supplier_id IS DISTINCT FROM NEW.supplier_id THEN
        RAISE EXCEPTION 'Supplier invoice supplier must match the goods receipt PO supplier';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF OLD.status = 'VOID' AND NEW.status <> 'VOID' THEN
            RAISE EXCEPTION 'A void supplier invoice cannot be reopened';
        END IF;
        IF OLD.status = 'APPROVED' AND NEW.status NOT IN ('APPROVED','VOID') THEN
            RAISE EXCEPTION 'An approved supplier invoice can only remain approved or be voided';
        END IF;
        IF OLD.status IN ('APPROVED','VOID') AND
           (NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR
            NEW.goods_receipt_id IS DISTINCT FROM OLD.goods_receipt_id OR
            NEW.supplier_invoice_no IS DISTINCT FROM OLD.supplier_invoice_no OR
            NEW.invoice_date IS DISTINCT FROM OLD.invoice_date OR
            NEW.due_date IS DISTINCT FROM OLD.due_date OR
            NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR
            NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
            RAISE EXCEPTION 'Supplier invoice identity and dates are immutable after approval/voiding';
        END IF;
    END IF;
    IF NEW.status = 'APPROVED' THEN
        IF NEW.approved_by IS NULL THEN RAISE EXCEPTION 'Supplier invoice approval must record approved_by'; END IF;
        SELECT COUNT(*) INTO v_item_count FROM procurement.supplier_invoice_items
        WHERE supplier_invoice_id = NEW.supplier_invoice_id;
        IF v_item_count = 0 THEN RAISE EXCEPTION 'Supplier invoice requires at least one invoice line before approval'; END IF;
    ELSIF NEW.status = 'VOID' THEN
        IF EXISTS (SELECT 1 FROM procurement.supplier_payments
                   WHERE supplier_invoice_id = NEW.supplier_invoice_id AND status IN ('PENDING','COMPLETED')) THEN
            RAISE EXCEPTION 'A supplier invoice with pending/completed payments cannot be voided';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION finance.validate_customer_payment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_invoice_status text;
    v_buyer_user_id bigint;
    v_invoice_total numeric(14,2);
    v_other_paid numeric(14,2);
    v_other_refunded numeric(14,2);
    v_other_pending numeric(14,2);
    v_current_refunded numeric(14,2) := 0;
    v_current_payment_commitment numeric(14,2) := 0;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.created_by IS NULL THEN RAISE EXCEPTION 'A payment initiator is required'; END IF;
        NEW.status := 'INITIATED';
        NEW.completed_at := NULL;
        NEW.signature_verified := NULL;
        NEW.gateway_payment_id := NULL;
        NEW.gateway_reference := NULL;
        NEW.gateway_response := NULL;
    ELSE
        IF (NEW.customer_invoice_id, NEW.provider, NEW.amount, NEW.currency_code, NEW.created_by, NEW.initiated_at)
           IS DISTINCT FROM
           (OLD.customer_invoice_id, OLD.provider, OLD.amount, OLD.currency_code, OLD.created_by, OLD.initiated_at) THEN
            RAISE EXCEPTION 'Payment invoice, provider, amount, currency, initiator and initiation time are immutable';
        END IF;
        IF OLD.gateway_order_id IS NOT NULL AND NEW.gateway_order_id IS DISTINCT FROM OLD.gateway_order_id THEN
            RAISE EXCEPTION 'Gateway order ID cannot be changed once assigned';
        END IF;
        IF OLD.status = 'SUCCESS' AND NEW.status <> 'SUCCESS' THEN
            RAISE EXCEPTION 'A successful payment cannot be moved to another status; use a refund record';
        ELSIF OLD.status IN ('FAILED','CANCELLED') AND NEW.status <> OLD.status THEN
            RAISE EXCEPTION 'A failed or cancelled payment is terminal';
        ELSIF OLD.status = 'PENDING' AND NEW.status NOT IN ('PENDING','SUCCESS','FAILED','CANCELLED') THEN
            RAISE EXCEPTION 'Invalid payment status transition';
        ELSIF OLD.status = 'INITIATED' AND NEW.status NOT IN ('INITIATED','PENDING','SUCCESS','FAILED','CANCELLED') THEN
            RAISE EXCEPTION 'Invalid payment status transition';
        END IF;
        SELECT COALESCE(SUM(r.amount),0) INTO v_current_refunded
        FROM finance.customer_refunds r
        WHERE r.customer_payment_id = NEW.customer_payment_id AND r.status = 'SUCCESS';
    END IF;

    SELECT ci.status, b.user_id INTO v_invoice_status, v_buyer_user_id
    FROM finance.customer_invoices ci
    JOIN dispatch.shipments sh ON sh.shipment_id = ci.shipment_id
    JOIN sales.orders o ON o.order_id = sh.order_id
    JOIN master.buyers b ON b.buyer_id = o.buyer_id
    WHERE ci.customer_invoice_id = NEW.customer_invoice_id
    FOR UPDATE OF ci;
    IF v_invoice_status IS DISTINCT FROM 'ISSUED' THEN
        RAISE EXCEPTION 'Payment can only be initiated for an issued customer invoice';
    END IF;
    PERFORM auth.assert_role(NEW.created_by, ARRAY['BUYER','OWNER'], 'customer payment initiator');
    IF auth.user_has_role(NEW.created_by, ARRAY['BUYER']) AND NEW.created_by <> v_buyer_user_id THEN
        RAISE EXCEPTION 'A buyer can only create a payment for their own invoice' USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(SUM(l.line_total),0) INTO v_invoice_total
    FROM finance.customer_invoice_lines l WHERE l.customer_invoice_id = NEW.customer_invoice_id;
    SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status='SUCCESS'),0) INTO v_other_paid
    FROM finance.customer_payment_transactions p
    WHERE p.customer_invoice_id = NEW.customer_invoice_id
      AND p.customer_payment_id IS DISTINCT FROM NEW.customer_payment_id;
    SELECT COALESCE(SUM(r.amount),0) INTO v_other_refunded
    FROM finance.customer_refunds r
    JOIN finance.customer_payment_transactions p ON p.customer_payment_id = r.customer_payment_id
    WHERE p.customer_invoice_id = NEW.customer_invoice_id
      AND p.customer_payment_id IS DISTINCT FROM NEW.customer_payment_id AND r.status = 'SUCCESS';
    SELECT COALESCE(SUM(p.amount),0) INTO v_other_pending
    FROM finance.customer_payment_transactions p
    WHERE p.customer_invoice_id = NEW.customer_invoice_id
      AND p.customer_payment_id IS DISTINCT FROM NEW.customer_payment_id
      AND p.status IN ('INITIATED','PENDING');

    /* Calculate this transaction's commitment separately. This is easier to
       validate and avoids nesting a CASE expression inside the IF condition. */
    v_current_payment_commitment := 0;
    IF NEW.status = 'SUCCESS' THEN
        v_current_payment_commitment := GREATEST(NEW.amount - v_current_refunded, 0);
    ELSIF NEW.status IN ('INITIATED','PENDING') THEN
        v_current_payment_commitment := NEW.amount;
    END IF;

    IF NEW.status IN ('INITIATED','PENDING','SUCCESS') THEN
        IF (GREATEST(v_other_paid - v_other_refunded, 0)
            + v_other_pending
            + v_current_payment_commitment) > v_invoice_total THEN
            RAISE EXCEPTION 'Payment would exceed the remaining invoice balance (%)',
                GREATEST(v_invoice_total - GREATEST(v_other_paid - v_other_refunded, 0) - v_other_pending, 0);
        END IF;
    END IF;
    IF NEW.status = 'SUCCESS' THEN
        IF NEW.provider IN ('PHONEPE','RAZORPAY','CASHFREE') AND NEW.signature_verified IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'Gateway payment can only be marked SUCCESS after its signature/webhook is verified';
        END IF;
        IF NEW.completed_at IS NULL THEN NEW.completed_at := now(); END IF;
    END IF;
    RETURN NEW;
END;
$$;

/* Protect the stock balance from direct edits; the ledger posting trigger is
   the only code path allowed to alter on_hand_qty_kg. */
CREATE OR REPLACE FUNCTION inventory.guard_yarn_lot_balance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.on_hand_qty_kg IS DISTINCT FROM OLD.on_hand_qty_kg
       AND current_setting('app.allow_stock_balance_update', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'Raw-material stock balance is ledger-controlled; insert a stock movement instead';
    END IF;
    IF (NEW.lot_code, NEW.yarn_type_id, NEW.colour_id, NEW.supplier_id, NEW.location_id,
        NEW.received_on, NEW.received_qty_kg, NEW.unit_cost_per_kg)
       IS DISTINCT FROM
       (OLD.lot_code, OLD.yarn_type_id, OLD.colour_id, OLD.supplier_id, OLD.location_id,
        OLD.received_on, OLD.received_qty_kg, OLD.unit_cost_per_kg) THEN
        RAISE EXCEPTION 'Yarn lot identity, receipt quantity and cost are immutable; record a new lot or correcting movement';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_yarn_lot_balance BEFORE UPDATE ON inventory.yarn_lots
FOR EACH ROW EXECUTE FUNCTION inventory.guard_yarn_lot_balance();

CREATE OR REPLACE FUNCTION inventory.apply_stock_movement()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_new_balance numeric(12,3);
BEGIN
    PERFORM set_config('app.allow_stock_balance_update','true',true);
    UPDATE inventory.yarn_lots
       SET on_hand_qty_kg = on_hand_qty_kg + NEW.quantity_delta_kg,
           status = CASE WHEN on_hand_qty_kg + NEW.quantity_delta_kg = 0 THEN 'DEPLETED'
                         WHEN status = 'DEPLETED' AND on_hand_qty_kg + NEW.quantity_delta_kg > 0 THEN 'ACTIVE'
                         ELSE status END
     WHERE yarn_lot_id = NEW.yarn_lot_id
       AND on_hand_qty_kg + NEW.quantity_delta_kg >= 0
       AND NOT (NEW.movement_type = 'ISSUE' AND status = 'QUARANTINED')
    RETURNING on_hand_qty_kg INTO v_new_balance;
    IF NOT FOUND THEN
        PERFORM set_config('app.allow_stock_balance_update','false',true);
        RAISE EXCEPTION 'Stock movement would make yarn lot negative, use a quarantined lot, or reference a missing lot';
    END IF;
    PERFORM set_config('app.allow_stock_balance_update','false',true);
    RETURN NEW;
END;
$$;

ALTER TABLE inventory.stock_movements ALTER COLUMN moved_by SET NOT NULL;
CREATE FUNCTION inventory.validate_stock_movement_actor()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM auth.assert_role(NEW.moved_by, ARRAY['STORE_MANAGER','SUPERVISOR','OWNER'], 'stock movement actor');
    IF NEW.movement_type IN ('RECEIPT','ADJUSTMENT_IN','ADJUSTMENT_OUT','RETURN_IN','TRANSFER_IN','TRANSFER_OUT')
       AND NOT auth.user_has_role(NEW.moved_by, ARRAY['STORE_MANAGER','OWNER']) THEN
        RAISE EXCEPTION 'Only Store Manager or Owner may post adjustments, returns or transfers';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_stock_movement_actor BEFORE INSERT ON inventory.stock_movements
FOR EACH ROW EXECUTE FUNCTION inventory.validate_stock_movement_actor();

/* Owner reporting: active work plus plan attainment and quality yield. */
CREATE VIEW reporting.production_job_efficiency AS
WITH logs AS (
    SELECT ma.job_id,
           COALESCE(SUM(pl.produced_meters),0) AS produced_meters,
           COALESCE(SUM(pl.waste_meters),0) AS waste_meters,
           COALESCE(SUM(pl.downtime_minutes),0) AS downtime_minutes
    FROM production.machine_assignments ma
    LEFT JOIN production.production_logs pl ON pl.machine_assignment_id = ma.machine_assignment_id
    GROUP BY ma.job_id
), qc AS (
    SELECT r.job_id,
           COALESCE(SUM(r.length_meters) FILTER (WHERE r.current_status IN ('PASSED','DISPATCHED')),0) AS qc_passed_meters,
           COALESCE(SUM(r.length_meters) FILTER (WHERE r.current_status = 'REJECTED'),0) AS rejected_meters,
           COALESCE(SUM(r.length_meters) FILTER (WHERE r.current_status = 'REWORK'),0) AS rework_meters
    FROM production.rolls r GROUP BY r.job_id
)
SELECT j.job_id, j.job_no, j.order_item_id, o.order_id, o.order_no,
       b.company_name, ft.fabric_name, c.colour_name, j.stage, j.status AS job_status,
       j.planned_meters, COALESCE(l.produced_meters,0) AS produced_meters,
       COALESCE(l.waste_meters,0) AS waste_meters,
       COALESCE(l.downtime_minutes,0) AS downtime_minutes,
       round(COALESCE(l.produced_meters,0) / NULLIF(j.planned_meters,0) * 100,2) AS plan_attainment_percent,
       COALESCE(q.qc_passed_meters,0) AS qc_passed_meters,
       COALESCE(q.rejected_meters,0) AS rejected_meters,
       COALESCE(q.rework_meters,0) AS rework_meters,
       round(COALESCE(q.qc_passed_meters,0) / NULLIF(l.produced_meters,0) * 100,2) AS qc_yield_percent
FROM production.jobs j
JOIN sales.order_items oi ON oi.order_item_id = j.order_item_id
JOIN sales.orders o ON o.order_id = oi.order_id
JOIN master.buyers b ON b.buyer_id = o.buyer_id
JOIN master.fabric_types ft ON ft.fabric_type_id = oi.fabric_type_id
JOIN master.colours c ON c.colour_id = oi.colour_id
LEFT JOIN logs l ON l.job_id = j.job_id
LEFT JOIN qc q ON q.job_id = j.job_id;

CREATE VIEW reporting.active_production_jobs AS
SELECT e.*, ma.machine_assignment_id, ma.machine_id, m.machine_code, m.machine_name,
       ma.shift_id, sh.shift_name, ma.status AS assignment_status, ma.started_at AS machine_started_at
FROM reporting.production_job_efficiency e
JOIN production.machine_assignments ma ON ma.job_id = e.job_id
JOIN master.machines m ON m.machine_id = ma.machine_id
JOIN master.shifts sh ON sh.shift_id = ma.shift_id
WHERE e.job_status IN ('PLANNED','ASSIGNED','IN_PROGRESS','PAUSED')
  AND ma.status IN ('ASSIGNED','RUNNING','PAUSED');

CREATE OR REPLACE VIEW reporting.owner_dashboard_metrics AS
SELECT
  (SELECT COUNT(*) FROM sales.orders WHERE status NOT IN ('SHIPPED','DELIVERED','CANCELLED')) AS active_orders,
  (SELECT COUNT(*) FROM sales.orders WHERE status='PLACED') AS orders_awaiting_confirmation,
  (SELECT COUNT(*) FROM production.jobs WHERE status IN ('PLANNED','ASSIGNED','IN_PROGRESS','PAUSED')) AS active_production_jobs,
  (SELECT COUNT(*) FROM master.machines WHERE is_active AND status='RUNNING') AS machines_running,
  (SELECT COUNT(*) FROM master.machines WHERE is_active AND status='IDLE') AS machines_idle,
  (SELECT COUNT(*) FROM master.machines WHERE is_active AND status='BREAKDOWN') AS machines_in_breakdown,
  (SELECT COUNT(*) FROM reporting.available_yarn_by_type WHERE is_low_stock) AS yarn_types_below_reorder_level,
  (SELECT COALESCE(SUM(produced_meters_today),0) FROM reporting.production_output_today) AS production_meters_today,
  (SELECT COALESCE(SUM(balance_due),0) FROM reporting.customer_invoice_balances WHERE invoice_status='ISSUED') AS customer_receivables,
  (SELECT COALESCE(SUM(balance_due),0) FROM reporting.supplier_payables WHERE status <> 'VOID') AS supplier_payables,
  (SELECT COUNT(*) FROM reporting.active_production_jobs WHERE assignment_status='RUNNING') AS active_running_assignments,
  (SELECT round(AVG(plan_attainment_percent),2) FROM reporting.production_job_efficiency
    WHERE job_status IN ('PLANNED','ASSIGNED','IN_PROGRESS','PAUSED') AND plan_attainment_percent IS NOT NULL) AS average_active_job_plan_attainment_percent,
  (SELECT round(SUM(qc_passed_meters) / NULLIF(SUM(produced_meters),0) * 100,2)
    FROM reporting.production_job_efficiency WHERE produced_meters > 0) AS overall_qc_yield_percent;


/* A delivery is only complete when the whole customer order has shipped, not
   merely when all shipments created so far have reached the customer. */
CREATE OR REPLACE FUNCTION sales.guard_order_status_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_ordered_qty numeric(14,2); v_shipped_qty numeric(14,2); v_any_delivery boolean;
BEGIN
    IF OLD.status IN ('DELIVERED','CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Order % is terminal (%); use a separate return/credit workflow instead', OLD.order_no, OLD.status;
    END IF;
    IF OLD.status = 'SHIPPED' AND NEW.status NOT IN ('SHIPPED','DELIVERED') THEN
        RAISE EXCEPTION 'A fully shipped order can only remain SHIPPED or become DELIVERED';
    END IF;
    IF OLD.status = 'PARTIALLY_SHIPPED' AND NEW.status NOT IN ('PARTIALLY_SHIPPED','SHIPPED','DELIVERED') THEN
        RAISE EXCEPTION 'A partially shipped order cannot return to an earlier production state';
    END IF;
    IF NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED' THEN
        IF EXISTS (SELECT 1 FROM dispatch.shipments WHERE order_id = NEW.order_id AND status IN ('SHIPPED','DELIVERED')) THEN
            RAISE EXCEPTION 'An order with shipped goods cannot be cancelled';
        END IF;
    ELSIF NEW.status IN ('PARTIALLY_SHIPPED','SHIPPED','DELIVERED') AND OLD.status IS DISTINCT FROM NEW.status THEN
        SELECT COALESCE(SUM(quantity_m),0) INTO v_ordered_qty
        FROM sales.order_items WHERE order_id = NEW.order_id;
        SELECT COALESCE(SUM(r.length_meters),0) INTO v_shipped_qty
        FROM dispatch.shipment_items si
        JOIN dispatch.shipments sh ON sh.shipment_id = si.shipment_id
        JOIN production.rolls r ON r.roll_id = si.roll_id
        WHERE sh.order_id = NEW.order_id AND sh.status IN ('SHIPPED','DELIVERED');
        SELECT EXISTS (SELECT 1 FROM dispatch.shipments WHERE order_id = NEW.order_id AND status = 'DELIVERED')
        INTO v_any_delivery;
        IF NEW.status = 'PARTIALLY_SHIPPED' AND NOT (v_shipped_qty > 0 AND v_shipped_qty < v_ordered_qty) THEN
            RAISE EXCEPTION 'PARTIALLY_SHIPPED status must match actual shipped quantity';
        ELSIF NEW.status = 'SHIPPED' AND v_shipped_qty < v_ordered_qty THEN
            RAISE EXCEPTION 'SHIPPED status requires all ordered metres to have shipped';
        ELSIF NEW.status = 'DELIVERED' AND (v_shipped_qty < v_ordered_qty OR NOT v_any_delivery OR EXISTS (
            SELECT 1 FROM dispatch.shipments WHERE order_id = NEW.order_id AND status NOT IN ('DELIVERED','CANCELLED')
        )) THEN
            RAISE EXCEPTION 'DELIVERED status requires the full order quantity to be shipped and all active shipments to be delivered';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dispatch.finish_shipment_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_total_order_qty numeric(14,2); v_total_shipped numeric(14,2);
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'SHIPPED' THEN
        PERFORM set_config('app.allow_roll_status_change','true',true);
        UPDATE production.rolls r SET current_status = 'DISPATCHED'
        FROM dispatch.shipment_items si
        WHERE si.shipment_id = NEW.shipment_id AND si.roll_id = r.roll_id;
        PERFORM set_config('app.allow_roll_status_change','false',true);

        SELECT COALESCE(SUM(oi.quantity_m),0) INTO v_total_order_qty
        FROM sales.order_items oi WHERE oi.order_id = NEW.order_id;
        SELECT COALESCE(SUM(r.length_meters),0) INTO v_total_shipped
        FROM dispatch.shipment_items si
        JOIN dispatch.shipments sh ON sh.shipment_id = si.shipment_id
        JOIN production.rolls r ON r.roll_id = si.roll_id
        WHERE sh.order_id = NEW.order_id AND sh.status IN ('SHIPPED','DELIVERED');
        UPDATE sales.orders
           SET status = CASE WHEN v_total_shipped >= v_total_order_qty THEN 'SHIPPED' ELSE 'PARTIALLY_SHIPPED' END
         WHERE order_id = NEW.order_id AND status NOT IN ('CANCELLED','DELIVERED');

    ELSIF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'DELIVERED' THEN
        SELECT COALESCE(SUM(oi.quantity_m),0) INTO v_total_order_qty
        FROM sales.order_items oi WHERE oi.order_id = NEW.order_id;
        SELECT COALESCE(SUM(r.length_meters),0) INTO v_total_shipped
        FROM dispatch.shipment_items si
        JOIN dispatch.shipments sh ON sh.shipment_id = si.shipment_id
        JOIN production.rolls r ON r.roll_id = si.roll_id
        WHERE sh.order_id = NEW.order_id AND sh.status IN ('SHIPPED','DELIVERED');
        IF v_total_shipped >= v_total_order_qty
           AND NOT EXISTS (
               SELECT 1 FROM dispatch.shipments sh
               WHERE sh.order_id = NEW.order_id AND sh.status NOT IN ('DELIVERED','CANCELLED')
           ) THEN
            UPDATE sales.orders SET status = 'DELIVERED'
            WHERE order_id = NEW.order_id AND status NOT IN ('CANCELLED','DELIVERED');
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


/* Keep order-linked purchase orders relevant to the linked buyer order. */
CREATE OR REPLACE FUNCTION procurement.validate_purchase_order()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_linked_order_status text;
BEGIN
    PERFORM auth.assert_role(NEW.created_by, ARRAY['STORE_MANAGER','OWNER'], 'purchase order creator');
    IF TG_OP = 'INSERT' THEN
        NEW.status := 'DRAFT';
        NEW.issued_by := NULL;
        NEW.issued_at := NULL;
    END IF;
    IF NEW.issued_by IS NOT NULL THEN
        PERFORM auth.assert_role(NEW.issued_by, ARRAY['STORE_MANAGER','OWNER'], 'purchase order issuer');
    END IF;
    IF NEW.purchase_type = 'ORDER_SPECIFIC' THEN
        SELECT status INTO v_linked_order_status FROM sales.orders WHERE order_id = NEW.linked_order_id;
        IF v_linked_order_status IS NULL OR v_linked_order_status IN ('CANCELLED','SHIPPED','DELIVERED') THEN
            RAISE EXCEPTION 'An order-specific PO must be linked to an active, uncompleted customer order';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION procurement.guard_po_item_edits()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text; v_po_id bigint; v_purchase_type text; v_order_id bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_po_id := OLD.purchase_order_id;
    ELSE
        v_po_id := NEW.purchase_order_id;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id THEN
        RAISE EXCEPTION 'A purchase order line cannot be moved to another PO';
    END IF;
    SELECT status, purchase_type, linked_order_id
      INTO v_status, v_purchase_type, v_order_id
      FROM procurement.purchase_orders WHERE purchase_order_id = v_po_id;
    IF v_status IS DISTINCT FROM 'DRAFT' THEN
        RAISE EXCEPTION 'PO lines can only be added, edited or deleted while PO is DRAFT';
    END IF;
    IF TG_OP <> 'DELETE' THEN
        IF v_purchase_type = 'ORDER_SPECIFIC' AND NOT EXISTS (
            SELECT 1 FROM sales.order_items oi
            JOIN master.fabric_bom bom ON bom.fabric_type_id = oi.fabric_type_id
            WHERE oi.order_id = v_order_id AND bom.yarn_type_id = NEW.yarn_type_id
        ) THEN
            RAISE EXCEPTION 'Yarn on an order-specific PO must be used by a fabric in the linked customer order BOM';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

/* Do not void an invoice while its payment is pending or money remains net-paid. */
CREATE OR REPLACE FUNCTION finance.guard_customer_invoice_header()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_net_paid numeric(14,2); v_pending numeric(14,2);
BEGIN
    IF OLD.status = 'ISSUED' THEN
        IF NEW.shipment_id IS DISTINCT FROM OLD.shipment_id
           OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
           OR NEW.due_date IS DISTINCT FROM OLD.due_date
           OR NEW.created_by IS DISTINCT FROM OLD.created_by
           OR NEW.invoice_no IS DISTINCT FROM OLD.invoice_no THEN
            RAISE EXCEPTION 'An issued invoice identity, shipment and dates are immutable';
        END IF;
        IF NEW.status NOT IN ('ISSUED','VOID') THEN
            RAISE EXCEPTION 'Issued invoices can only remain ISSUED or become VOID';
        END IF;
        IF NEW.status = 'VOID' THEN
            SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status='SUCCESS'),0)
                   - COALESCE(SUM(r.refunded_amount),0)
              INTO v_net_paid
              FROM finance.customer_payment_transactions p
              LEFT JOIN LATERAL (
                  SELECT SUM(cr.amount) AS refunded_amount
                  FROM finance.customer_refunds cr
                  WHERE cr.customer_payment_id = p.customer_payment_id AND cr.status='SUCCESS'
              ) r ON true
             WHERE p.customer_invoice_id = OLD.customer_invoice_id;
            SELECT COALESCE(SUM(amount),0) INTO v_pending
            FROM finance.customer_payment_transactions
            WHERE customer_invoice_id = OLD.customer_invoice_id AND status IN ('INITIATED','PENDING');
            IF COALESCE(v_net_paid,0) > 0 OR COALESCE(v_pending,0) > 0 THEN
                RAISE EXCEPTION 'Refund/resolve pending payments before voiding an issued invoice';
            END IF;
            IF NULLIF(btrim(NEW.void_reason),'') IS NULL THEN
                RAISE EXCEPTION 'A void reason is required';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;



/* Buyers should only see invoices that have been issued (or later voided),
   never a staff-only draft invoice. */
CREATE OR REPLACE FUNCTION reporting.get_my_invoices()
RETURNS SETOF reporting.customer_invoice_balances LANGUAGE plpgsql STABLE AS $$
DECLARE v_user_id bigint := core.current_actor_id();
BEGIN
    IF auth.user_has_role(v_user_id, ARRAY['OWNER','DISPATCH_OFFICER']) THEN
        RETURN QUERY SELECT * FROM reporting.customer_invoice_balances;
    ELSIF auth.user_has_role(v_user_id, ARRAY['BUYER']) THEN
        RETURN QUERY SELECT * FROM reporting.customer_invoice_balances i
        WHERE i.invoice_status IN ('ISSUED','VOID')
          AND EXISTS (SELECT 1 FROM master.buyers b WHERE b.buyer_id = i.buyer_id AND b.user_id = v_user_id);
    ELSE
        RAISE EXCEPTION 'Role not permitted to use buyer invoice view';
    END IF;
END;
$$;


/* --------------------------------------------------------------------------
   FIRST QUERIES TO RUN AFTER SETUP

   SELECT * FROM auth.roles ORDER BY role_id;
   SELECT * FROM reporting.owner_dashboard_metrics;
   SELECT * FROM reporting.available_yarn_by_type;
   SELECT * FROM reporting.customer_order_tracking;
   SELECT * FROM reporting.customer_invoice_balances;
   SELECT * FROM reporting.supplier_payables;
   SELECT * FROM reporting.order_profitability;

   To record accepted material against a goods receipt:
   SELECT * FROM procurement.receive_purchase_order_item(
       p_goods_receipt_id := 1,
       p_po_item_id := 1,
       p_received_qty_kg := 500,
       p_accepted_qty_kg := 490,
       p_unit_cost_per_kg := 120,
       p_line_no := 1,
       p_lot_code := 'YARN-LOT-2026-001'
   );

   After a shipment is PACKED and then changed to SHIPPED, create the invoice:
   SELECT finance.create_customer_invoice(p_shipment_id := 1, p_created_by := 6,
                                          p_due_date := CURRENT_DATE + 30);
   The invoice creator must be a DISPATCH_OFFICER or OWNER user ID.
   -------------------------------------------------------------------------- */
