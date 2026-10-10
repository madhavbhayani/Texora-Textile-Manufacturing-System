/* Texora product catalogue migration. Run against an existing initialized Texora database.
   Designed to be re-runnable; does not drop application tables or schemas.
   Seed rates, costs, BOM quantities, and image URLs are demonstration defaults.
   Seed inserts never overwrite existing catalogue or owner-maintained values. */
SET LOCAL TIME ZONE 'Asia/Kolkata';

/* --------------------------------------------------------------------------
   17. Owner-managed finished-fabric catalogue and configurable specifications

   master.fabric_types remains the canonical sellable fabric table because
   sales.order_items and master.fabric_bom already reference it. This avoids a
   duplicate products table and keeps orders, production recipes and costing
   connected to one product identity.
   -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS master.units_of_measure (
    unit_code   text PRIMARY KEY,
    unit_name   text NOT NULL UNIQUE,
    symbol      text NOT NULL,
    dimension   text NOT NULL,
    is_active   boolean NOT NULL DEFAULT true
);

INSERT INTO master.units_of_measure(unit_code, unit_name, symbol, dimension) VALUES
    ('MTR', 'Metre', 'm', 'LENGTH'),
    ('KG', 'Kilogram', 'kg', 'MASS'),
    ('ROLL', 'Roll', 'roll', 'COUNT'),
    ('GSM', 'Grams per square metre', 'g/m²', 'MASS_PER_AREA'),
    ('IN', 'Inch', 'in', 'LENGTH'),
    ('CM', 'Centimetre', 'cm', 'LENGTH'),
    ('PCT', 'Percent', '%', 'RATIO')
ON CONFLICT (unit_code) DO UPDATE
SET unit_name = EXCLUDED.unit_name,
    symbol = EXCLUDED.symbol,
    dimension = EXCLUDED.dimension,
    is_active = true;

ALTER TABLE master.fabric_types
    ADD COLUMN IF NOT EXISTS product_description text,
    ADD COLUMN IF NOT EXISTS image_url text,
    ADD COLUMN IF NOT EXISTS estimated_cost_per_meter numeric(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS minimum_order_quantity numeric(12,2) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS order_unit_code text NOT NULL DEFAULT 'MTR',
    ADD COLUMN IF NOT EXISTS product_category text NOT NULL DEFAULT 'WOVEN_FABRIC',
    ADD COLUMN IF NOT EXISTS lead_time_days integer NOT NULL DEFAULT 14,
    ADD COLUMN IF NOT EXISTS is_published boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS catalog_created_by bigint REFERENCES auth.users(user_id),
    ADD COLUMN IF NOT EXISTS catalog_updated_by bigint REFERENCES auth.users(user_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_fabric_types_order_unit'
          AND conrelid = 'master.fabric_types'::regclass
    ) THEN
        ALTER TABLE master.fabric_types
            ADD CONSTRAINT fk_fabric_types_order_unit
            FOREIGN KEY (order_unit_code) REFERENCES master.units_of_measure(unit_code);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_fabric_types_image_url'
          AND conrelid = 'master.fabric_types'::regclass
    ) THEN
        ALTER TABLE master.fabric_types
            ADD CONSTRAINT ck_fabric_types_image_url
            CHECK (image_url IS NULL OR image_url ~* '^https?://');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_fabric_types_estimated_cost'
          AND conrelid = 'master.fabric_types'::regclass
    ) THEN
        ALTER TABLE master.fabric_types
            ADD CONSTRAINT ck_fabric_types_estimated_cost
            CHECK (estimated_cost_per_meter >= 0);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_fabric_types_minimum_order'
          AND conrelid = 'master.fabric_types'::regclass
    ) THEN
        ALTER TABLE master.fabric_types
            ADD CONSTRAINT ck_fabric_types_minimum_order
            CHECK (minimum_order_quantity > 0);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_fabric_types_lead_time'
          AND conrelid = 'master.fabric_types'::regclass
    ) THEN
        ALTER TABLE master.fabric_types
            ADD CONSTRAINT ck_fabric_types_lead_time
            CHECK (lead_time_days >= 0);
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS ix_fabric_catalog_published
    ON master.fabric_types(is_published, is_active, fabric_name);

/* Drop catalogue audit/owner triggers while idempotent seed upserts run; they are re-created below. */
DROP TRIGGER IF EXISTS trg_owner_fabric_catalog ON master.fabric_types;
DROP TRIGGER IF EXISTS audit_catalog_products ON master.fabric_types;

CREATE TABLE IF NOT EXISTS master.product_attribute_definitions (
    attribute_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    attribute_code text NOT NULL UNIQUE CHECK (attribute_code = upper(attribute_code)),
    label          text NOT NULL,
    data_type      text NOT NULL CHECK (data_type IN ('TEXT','NUMBER','BOOLEAN','SELECT')),
    unit_code      text REFERENCES master.units_of_measure(unit_code),
    description    text,
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS master.fabric_type_attributes (
    fabric_type_id                 bigint NOT NULL REFERENCES master.fabric_types(fabric_type_id),
    attribute_id                   bigint NOT NULL REFERENCES master.product_attribute_definitions(attribute_id),
    default_value_text             text,
    default_value_numeric          numeric(14,4),
    default_value_boolean          boolean,
    allowed_values                 jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_values) = 'array'),
    customer_configurable          boolean NOT NULL DEFAULT false,
    required_for_order             boolean NOT NULL DEFAULT false,
    minimum_numeric_value          numeric(14,4),
    maximum_numeric_value          numeric(14,4),
    requires_owner_confirmation    boolean NOT NULL DEFAULT false,
    display_order                  integer NOT NULL DEFAULT 0,
    is_active                      boolean NOT NULL DEFAULT true,
    created_at                     timestamptz NOT NULL DEFAULT now(),
    updated_at                     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (fabric_type_id, attribute_id),
    CHECK (num_nonnulls(default_value_text, default_value_numeric, default_value_boolean) <= 1),
    CHECK (minimum_numeric_value IS NULL OR maximum_numeric_value IS NULL OR minimum_numeric_value <= maximum_numeric_value)
);
CREATE INDEX IF NOT EXISTS ix_fabric_type_attributes_attribute
    ON master.fabric_type_attributes(attribute_id, is_active);

CREATE TABLE IF NOT EXISTS master.fabric_type_colours (
    fabric_type_id bigint NOT NULL REFERENCES master.fabric_types(fabric_type_id),
    colour_id      bigint NOT NULL REFERENCES master.colours(colour_id),
    is_default     boolean NOT NULL DEFAULT false,
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (fabric_type_id, colour_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_fabric_type_one_default_colour
    ON master.fabric_type_colours(fabric_type_id) WHERE is_default AND is_active;
CREATE INDEX IF NOT EXISTS ix_fabric_type_colours_colour
    ON master.fabric_type_colours(colour_id, is_active);

/* Add updated_at behavior for new master tables created after the base trigger pass. */
DROP TRIGGER IF EXISTS trg_set_updated_at_product_attribute_definitions ON master.product_attribute_definitions;
CREATE TRIGGER trg_set_updated_at_product_attribute_definitions
BEFORE UPDATE ON master.product_attribute_definitions
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
DROP TRIGGER IF EXISTS trg_set_updated_at_fabric_type_attributes ON master.fabric_type_attributes;
CREATE TRIGGER trg_set_updated_at_fabric_type_attributes
BEFORE UPDATE ON master.fabric_type_attributes
FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

/* Order-time configurable options are captured as snapshots so later changes
   to the catalogue do not rewrite a customer's historical order. */
CREATE TABLE IF NOT EXISTS sales.order_item_attributes (
    order_item_id            bigint NOT NULL REFERENCES sales.order_items(order_item_id),
    attribute_id             bigint NOT NULL REFERENCES master.product_attribute_definitions(attribute_id),
    attribute_label_snapshot text NOT NULL,
    unit_code_snapshot       text,
    value_text               text,
    value_numeric            numeric(14,4),
    value_boolean            boolean,
    requires_owner_confirmation_snapshot boolean NOT NULL DEFAULT false,
    created_at               timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (order_item_id, attribute_id),
    CHECK (num_nonnulls(value_text, value_numeric, value_boolean) = 1)
);
CREATE INDEX IF NOT EXISTS ix_order_item_attributes_attribute
    ON sales.order_item_attributes(attribute_id);

/* Seed common yarn types used by the initial five catalogue products. Costs and
   rates below are demonstration values; the Owner must confirm local rates. */
INSERT INTO master.yarn_types(yarn_code, yarn_name, material, yarn_count, reorder_level_kg, is_active) VALUES
    ('YARN-COT-30S', 'Combed Cotton Yarn 30s', 'Cotton', '30s', 100, true),
    ('YARN-PES-150D', 'Polyester Filament Yarn 150D', 'Polyester', '150D', 100, true),
    ('YARN-PES-30S', 'Polyester Spun Yarn 30s', 'Polyester', '30s', 100, true),
    ('YARN-IND-COT-10S', 'Indigo Dyed Cotton Warp Yarn 10s', 'Cotton', '10s', 100, true),
    ('YARN-COT-10S', 'Cotton Weft Yarn 10s', 'Cotton', '10s', 100, true)
ON CONFLICT DO NOTHING;

/* These are five manufacturable fabric SKUs, not arbitrary customer-entered
   recipes. GSM and width are product specifications; customers choose a SKU,
   colour and order quantity in metres. */
INSERT INTO master.fabric_types(
    fabric_code, fabric_name, weave, gsm, width_inch, hsn_code,
    default_rate_per_meter, default_tax_percent, product_description,
    image_url, estimated_cost_per_meter, minimum_order_quantity,
    order_unit_code, product_category, lead_time_days, is_active, is_published
) VALUES
    ('FAB-COT-POP-120', 'Premium Cotton Poplin', 'Plain', 120, 58, NULL,
     110.00, 5.00, 'Lightweight woven cotton fabric for shirts, uniforms and everyday apparel.',
     'https://placehold.co/800x600/5347CE/FFFFFF?text=Cotton+Poplin', 78.00, 50, 'MTR', 'COTTON_FABRIC', 10, true, true),
    ('FAB-PES-PLAIN-110', 'Polyester Plain-Weave Fabric', 'Plain', 110, 58, NULL,
     75.00, 5.00, 'Lightweight polyester fabric for linings, uniforms and general textile applications.',
     'https://placehold.co/800x600/4896FE/FFFFFF?text=Polyester+Fabric', 52.00, 50, 'MTR', 'POLYESTER_FABRIC', 10, true, true),
    ('FAB-TC-BLEND-180', 'Cotton-Polyester Blend Fabric', 'Plain', 180, 58, NULL,
     140.00, 5.00, 'Durable cotton-polyester blend fabric suitable for workwear and uniforms.',
     'https://placehold.co/800x600/887CFD/FFFFFF?text=Cotton+Polyester+Blend', 105.00, 50, 'MTR', 'BLENDED_FABRIC', 14, true, true),
    ('FAB-DENIM-300', 'Denim Fabric', 'Twill', 300, 60, NULL,
     260.00, 5.00, 'Heavy woven denim fabric with indigo warp and cotton weft yarn.',
     'https://placehold.co/800x600/1E3A8A/FFFFFF?text=Denim+Fabric', 205.00, 50, 'MTR', 'DENIM', 18, true, true),
    ('FAB-CANVAS-280', 'Cotton Canvas Fabric', 'Plain', 280, 60, NULL,
     220.00, 5.00, 'Heavy-duty cotton canvas for bags, covers and durable textile products.',
     'https://placehold.co/800x600/16C8C7/020617?text=Cotton+Canvas', 170.00, 50, 'MTR', 'CANVAS', 14, true, true)
ON CONFLICT DO NOTHING;

INSERT INTO master.colours(colour_name, hex_code, is_active) VALUES
    ('White', '#FFFFFF', true),
    ('Black', '#020617', true),
    ('Navy Blue', '#1E3A8A', true),
    ('Indigo', '#4338CA', true),
    ('Natural', '#D6C5A6', true),
    ('Grey', '#64748B', true),
    ('Beige', '#E7D3B1', true),
    ('Light Blue', '#93C5FD', true)
ON CONFLICT DO NOTHING;

/* Product recipes connect each finished fabric to the raw yarn required to
   manufacture it. Consumption figures are starting estimates including the
   stated wastage allowance, not certified engineering specifications. */
INSERT INTO master.fabric_bom(fabric_type_id, yarn_type_id, kg_per_meter, wastage_percent)
SELECT ft.fabric_type_id, yt.yarn_type_id, v.kg_per_meter, v.wastage_percent
FROM (VALUES
    ('FAB-COT-POP-120', 'YARN-COT-30S', 0.17140::numeric, 5.00::numeric),
    ('FAB-PES-PLAIN-110', 'YARN-PES-150D', 0.15430::numeric, 5.00::numeric),
    ('FAB-TC-BLEND-180', 'YARN-COT-30S', 0.09700::numeric, 5.00::numeric),
    ('FAB-TC-BLEND-180', 'YARN-PES-30S', 0.16600::numeric, 5.00::numeric),
    ('FAB-DENIM-300', 'YARN-IND-COT-10S', 0.30000::numeric, 6.00::numeric),
    ('FAB-DENIM-300', 'YARN-COT-10S', 0.13500::numeric, 6.00::numeric),
    ('FAB-CANVAS-280', 'YARN-COT-10S', 0.40500::numeric, 5.00::numeric)
) AS v(fabric_code, yarn_code, kg_per_meter, wastage_percent)
JOIN master.fabric_types ft ON ft.fabric_code = v.fabric_code
JOIN master.yarn_types yt ON yt.yarn_code = v.yarn_code
ON CONFLICT DO NOTHING;

/* Available colour options per sellable product. */
INSERT INTO master.fabric_type_colours(fabric_type_id, colour_id, is_default, is_active)
SELECT ft.fabric_type_id, c.colour_id, v.is_default, true
FROM (VALUES
    ('FAB-COT-POP-120', 'White', true), ('FAB-COT-POP-120', 'Light Blue', false),
    ('FAB-COT-POP-120', 'Navy Blue', false), ('FAB-COT-POP-120', 'Black', false),
    ('FAB-PES-PLAIN-110', 'White', true), ('FAB-PES-PLAIN-110', 'Black', false),
    ('FAB-PES-PLAIN-110', 'Navy Blue', false), ('FAB-PES-PLAIN-110', 'Grey', false),
    ('FAB-TC-BLEND-180', 'Navy Blue', true), ('FAB-TC-BLEND-180', 'Grey', false),
    ('FAB-TC-BLEND-180', 'Black', false), ('FAB-TC-BLEND-180', 'White', false),
    ('FAB-DENIM-300', 'Indigo', true), ('FAB-DENIM-300', 'Black', false),
    ('FAB-CANVAS-280', 'Natural', true), ('FAB-CANVAS-280', 'Beige', false),
    ('FAB-CANVAS-280', 'Black', false)
) AS v(fabric_code, colour_name, is_default)
JOIN master.fabric_types ft ON ft.fabric_code = v.fabric_code
JOIN master.colours c ON c.colour_name = v.colour_name
ON CONFLICT DO NOTHING;

INSERT INTO master.product_attribute_definitions(attribute_code, label, data_type, unit_code, description, is_active) VALUES
    ('FINISH', 'Fabric Finish', 'SELECT', NULL, 'Surface finish offered for the fabric SKU.', true),
    ('PATTERN', 'Pattern', 'SELECT', NULL, 'Pattern supported by the fabric SKU.', true),
    ('SPECIAL_INSTRUCTIONS', 'Special Instructions', 'TEXT', NULL, 'Optional buyer instructions. Non-standard requests may require owner confirmation.', true)
ON CONFLICT DO NOTHING;

INSERT INTO master.fabric_type_attributes(
    fabric_type_id, attribute_id, default_value_text, allowed_values,
    customer_configurable, required_for_order, requires_owner_confirmation, display_order, is_active
)
SELECT ft.fabric_type_id, ad.attribute_id, v.default_value, v.allowed_values::jsonb,
       v.customer_configurable, v.required_for_order, v.requires_owner_confirmation, v.display_order, true
FROM (VALUES
    ('FAB-COT-POP-120','FINISH','Standard','["Standard"]',false,false,false,1),
    ('FAB-COT-POP-120','PATTERN','Plain','["Plain"]',false,false,false,2),
    ('FAB-PES-PLAIN-110','FINISH','Standard','["Standard"]',false,false,false,1),
    ('FAB-PES-PLAIN-110','PATTERN','Plain','["Plain"]',false,false,false,2),
    ('FAB-TC-BLEND-180','FINISH','Standard','["Standard"]',false,false,false,1),
    ('FAB-TC-BLEND-180','PATTERN','Plain','["Plain"]',false,false,false,2),
    ('FAB-DENIM-300','FINISH','Standard','["Standard"]',false,false,false,1),
    ('FAB-DENIM-300','PATTERN','Twill','["Twill"]',false,false,false,2),
    ('FAB-CANVAS-280','FINISH','Standard','["Standard"]',false,false,false,1),
    ('FAB-CANVAS-280','PATTERN','Plain','["Plain"]',false,false,false,2)
) AS v(fabric_code, attribute_code, default_value, allowed_values, customer_configurable, required_for_order, requires_owner_confirmation, display_order)
JOIN master.fabric_types ft ON ft.fabric_code = v.fabric_code
JOIN master.product_attribute_definitions ad ON ad.attribute_code = v.attribute_code
ON CONFLICT DO NOTHING;

/* Validate selected product attributes and preserve their labels/units at order
   time. Options flagged for owner confirmation must be reviewed before the order
   is confirmed; customer input never sets prices or tax. */
CREATE OR REPLACE FUNCTION master.validate_fabric_type_attribute()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_type text; v_label text; v_allowed jsonb;
BEGIN
    SELECT data_type, label INTO v_type, v_label
    FROM master.product_attribute_definitions
    WHERE attribute_id = NEW.attribute_id AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Attribute definition is missing or inactive'; END IF;

    IF num_nonnulls(NEW.default_value_text, NEW.default_value_numeric, NEW.default_value_boolean) > 1 THEN
        RAISE EXCEPTION 'Only one default value type may be supplied';
    END IF;
    IF num_nonnulls(NEW.default_value_text, NEW.default_value_numeric, NEW.default_value_boolean) = 1 THEN
        IF v_type IN ('TEXT','SELECT') AND (NEW.default_value_text IS NULL OR NEW.default_value_numeric IS NOT NULL OR NEW.default_value_boolean IS NOT NULL) THEN
            RAISE EXCEPTION 'Attribute % requires a text default value', v_label;
        ELSIF v_type = 'NUMBER' AND (NEW.default_value_numeric IS NULL OR NEW.default_value_text IS NOT NULL OR NEW.default_value_boolean IS NOT NULL) THEN
            RAISE EXCEPTION 'Attribute % requires a numeric default value', v_label;
        ELSIF v_type = 'BOOLEAN' AND (NEW.default_value_boolean IS NULL OR NEW.default_value_text IS NOT NULL OR NEW.default_value_numeric IS NOT NULL) THEN
            RAISE EXCEPTION 'Attribute % requires a boolean default value', v_label;
        END IF;
    END IF;
    IF v_type = 'SELECT' AND NEW.default_value_text IS NOT NULL
       AND NOT (NEW.allowed_values ? NEW.default_value_text) THEN
        RAISE EXCEPTION 'Default value for % must appear in allowed_values', v_label;
    END IF;
    IF v_type = 'NUMBER' AND NEW.default_value_numeric IS NOT NULL AND
       ((NEW.minimum_numeric_value IS NOT NULL AND NEW.default_value_numeric < NEW.minimum_numeric_value) OR
        (NEW.maximum_numeric_value IS NOT NULL AND NEW.default_value_numeric > NEW.maximum_numeric_value)) THEN
        RAISE EXCEPTION 'Default numeric value for % is outside the allowed range', v_label;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_fabric_type_attribute ON master.fabric_type_attributes;
CREATE TRIGGER trg_validate_fabric_type_attribute
BEFORE INSERT OR UPDATE ON master.fabric_type_attributes
FOR EACH ROW EXECUTE FUNCTION master.validate_fabric_type_attribute();

CREATE OR REPLACE FUNCTION sales.validate_order_item_attribute()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_type text;
    v_label text;
    v_unit text;
    v_configurable boolean;
    v_allowed jsonb;
    v_min numeric;
    v_max numeric;
    v_owner_confirmation boolean;
BEGIN
    SELECT d.data_type, d.label, d.unit_code,
           fta.customer_configurable, fta.allowed_values,
           fta.minimum_numeric_value, fta.maximum_numeric_value,
           fta.requires_owner_confirmation
      INTO v_type, v_label, v_unit, v_configurable, v_allowed, v_min, v_max, v_owner_confirmation
    FROM sales.order_items oi
    JOIN master.fabric_type_attributes fta
      ON fta.fabric_type_id = oi.fabric_type_id AND fta.attribute_id = NEW.attribute_id AND fta.is_active
    JOIN master.product_attribute_definitions d
      ON d.attribute_id = fta.attribute_id AND d.is_active
    WHERE oi.order_item_id = NEW.order_item_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'Attribute is not defined for the selected product'; END IF;
    IF NOT v_configurable THEN RAISE EXCEPTION 'Attribute % is not customer-configurable', v_label; END IF;

    IF v_type IN ('TEXT','SELECT') AND (NEW.value_text IS NULL OR NEW.value_numeric IS NOT NULL OR NEW.value_boolean IS NOT NULL) THEN
        RAISE EXCEPTION 'Attribute % requires a text value', v_label;
    ELSIF v_type = 'NUMBER' AND (NEW.value_numeric IS NULL OR NEW.value_text IS NOT NULL OR NEW.value_boolean IS NOT NULL) THEN
        RAISE EXCEPTION 'Attribute % requires a numeric value', v_label;
    ELSIF v_type = 'BOOLEAN' AND (NEW.value_boolean IS NULL OR NEW.value_text IS NOT NULL OR NEW.value_numeric IS NOT NULL) THEN
        RAISE EXCEPTION 'Attribute % requires a boolean value', v_label;
    END IF;

    IF v_type = 'SELECT' AND NOT (v_allowed ? NEW.value_text) THEN
        RAISE EXCEPTION 'Invalid value for attribute %', v_label;
    END IF;
    IF v_type = 'NUMBER' AND
       ((v_min IS NOT NULL AND NEW.value_numeric < v_min) OR (v_max IS NOT NULL AND NEW.value_numeric > v_max)) THEN
        RAISE EXCEPTION 'Value for attribute % is outside its allowed range', v_label;
    END IF;

    NEW.attribute_label_snapshot := v_label;
    NEW.unit_code_snapshot := v_unit;
    NEW.requires_owner_confirmation_snapshot := v_owner_confirmation;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_order_item_attribute ON sales.order_item_attributes;
CREATE TRIGGER trg_validate_order_item_attribute
BEFORE INSERT OR UPDATE ON sales.order_item_attributes
FOR EACH ROW EXECUTE FUNCTION sales.validate_order_item_attribute();

/* Keep catalogue changes Owner-only. The backend must set
   app.current_user_id transaction-locally from the verified access token. */
CREATE OR REPLACE FUNCTION master.enforce_owner_catalog_changes()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_actor bigint := core.current_actor_id();
BEGIN
    IF v_actor IS NULL OR NOT auth.user_has_role(v_actor, ARRAY['OWNER']) THEN
        RAISE EXCEPTION 'Only an active OWNER can manage the product catalogue'
            USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Products cannot be deleted; deactivate or unpublish them instead';
    ELSIF TG_OP = 'INSERT' THEN
        NEW.catalog_created_by := COALESCE(NEW.catalog_created_by, v_actor);
        NEW.catalog_updated_by := v_actor;
        RETURN NEW;
    ELSE
        NEW.catalog_created_by := OLD.catalog_created_by;
        NEW.catalog_updated_by := v_actor;
        RETURN NEW;
    END IF;
END;
$$;
DROP TRIGGER IF EXISTS trg_owner_fabric_catalog ON master.fabric_types;
CREATE TRIGGER trg_owner_fabric_catalog
BEFORE INSERT OR UPDATE OR DELETE ON master.fabric_types
FOR EACH ROW EXECUTE FUNCTION master.enforce_owner_catalog_changes();

CREATE OR REPLACE FUNCTION master.validate_order_item_colour()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM master.fabric_type_colours ftc
        WHERE ftc.fabric_type_id = NEW.fabric_type_id
          AND ftc.colour_id = NEW.colour_id
          AND ftc.is_active
    ) THEN
        RAISE EXCEPTION 'Selected colour is not available for this product';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_validate_order_item_colour ON sales.order_items;
CREATE TRIGGER trg_validate_order_item_colour
BEFORE INSERT OR UPDATE OF fabric_type_id, colour_id ON sales.order_items
FOR EACH ROW EXECUTE FUNCTION master.validate_order_item_colour();

/* Do not accept buyer-supplied prices. Snapshot the active catalogue rate and
   tax at line creation; estimated_cost_per_meter remains internal-only. */
CREATE OR REPLACE FUNCTION sales.apply_catalog_price_to_order_item()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_rate numeric(12,2);
    v_tax numeric(5,2);
    v_minimum numeric(12,2);
    v_unit text;
    v_active boolean;
    v_published boolean;
BEGIN
    SELECT default_rate_per_meter, default_tax_percent, minimum_order_quantity,
           order_unit_code, is_active, is_published
      INTO v_rate, v_tax, v_minimum, v_unit, v_active, v_published
    FROM master.fabric_types WHERE fabric_type_id = NEW.fabric_type_id;

    IF NOT FOUND OR NOT v_active OR NOT v_published THEN
        RAISE EXCEPTION 'Product is not available for ordering';
    END IF;
    IF v_unit <> 'MTR' THEN
        RAISE EXCEPTION 'Customer orders currently support metre-based fabric products only';
    END IF;
    IF NEW.quantity_m < v_minimum THEN
        RAISE EXCEPTION 'Minimum order quantity for this product is % metres', v_minimum;
    END IF;

    NEW.rate_per_m := v_rate;
    NEW.tax_percent := v_tax;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_apply_catalog_price_to_order_item ON sales.order_items;
CREATE TRIGGER trg_apply_catalog_price_to_order_item
BEFORE INSERT ON sales.order_items
FOR EACH ROW EXECUTE FUNCTION sales.apply_catalog_price_to_order_item();

/* Safe, buyer-facing catalogue view: deliberately omits estimated cost and
   raw-material recipe details. The owner API can query those protected tables. */
CREATE OR REPLACE VIEW reporting.product_catalog AS
SELECT
    ft.fabric_type_id AS product_id,
    ft.fabric_code AS sku,
    ft.fabric_name AS title,
    ft.product_description AS description,
    ft.image_url,
    ft.product_category,
    ft.weave,
    ft.gsm,
    ft.width_inch,
    ft.default_rate_per_meter AS unit_price,
    ft.default_tax_percent AS tax_percent,
    ft.minimum_order_quantity,
    ft.order_unit_code,
    u.unit_name AS order_unit_name,
    ft.lead_time_days,
    COALESCE(
        jsonb_agg(DISTINCT jsonb_build_object(
            'colour_id', c.colour_id,
            'name', c.colour_name,
            'hex_code', c.hex_code,
            'is_default', ftc.is_default
        )) FILTER (WHERE c.colour_id IS NOT NULL), '[]'::jsonb
    ) AS available_colours,
    COALESCE(
        jsonb_agg(DISTINCT jsonb_build_object(
            'attribute_id', ad.attribute_id,
            'code', ad.attribute_code,
            'label', ad.label,
            'data_type', ad.data_type,
            'unit_code', ad.unit_code,
            'default_value', COALESCE(fta.default_value_text,
                                      fta.default_value_numeric::text,
                                      fta.default_value_boolean::text),
            'allowed_values', fta.allowed_values,
            'customer_configurable', fta.customer_configurable,
            'required_for_order', fta.required_for_order,
            'minimum_numeric_value', fta.minimum_numeric_value,
            'maximum_numeric_value', fta.maximum_numeric_value,
            'requires_owner_confirmation', fta.requires_owner_confirmation,
            'display_order', fta.display_order
        )) FILTER (WHERE ad.attribute_id IS NOT NULL), '[]'::jsonb
    ) AS attributes
FROM master.fabric_types ft
JOIN master.units_of_measure u ON u.unit_code = ft.order_unit_code
LEFT JOIN master.fabric_type_colours ftc
  ON ftc.fabric_type_id = ft.fabric_type_id AND ftc.is_active
LEFT JOIN master.colours c
  ON c.colour_id = ftc.colour_id AND c.is_active
LEFT JOIN master.fabric_type_attributes fta
  ON fta.fabric_type_id = ft.fabric_type_id AND fta.is_active
LEFT JOIN master.product_attribute_definitions ad
  ON ad.attribute_id = fta.attribute_id AND ad.is_active
WHERE ft.is_active AND ft.is_published
GROUP BY ft.fabric_type_id, ft.fabric_code, ft.fabric_name,
         ft.product_description, ft.image_url, ft.product_category,
         ft.weave, ft.gsm, ft.width_inch, ft.default_rate_per_meter,
         ft.default_tax_percent, ft.minimum_order_quantity,
         ft.order_unit_code, u.unit_name, ft.lead_time_days;

/* Catalogue permissions are added after the base role permissions are seeded. */
INSERT INTO auth.permissions(permission_code, module, description) VALUES
    ('catalog.view', 'catalog', 'View published fabric products and their orderable specifications.'),
    ('catalog.manage', 'catalog', 'Create, update, publish, unpublish and manage product recipes and colours.')
ON CONFLICT (permission_code) DO NOTHING;
INSERT INTO auth.role_permissions(role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM auth.roles r
JOIN auth.permissions p ON p.permission_code IN ('catalog.view','catalog.manage')
WHERE r.role_code = 'OWNER'
ON CONFLICT DO NOTHING;
INSERT INTO auth.role_permissions(role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM auth.roles r
JOIN auth.permissions p ON p.permission_code = 'catalog.view'
WHERE r.role_code = 'BUYER'
ON CONFLICT DO NOTHING;

/* Product catalogue mutations are part of the existing master-data audit trail. */
DROP TRIGGER IF EXISTS audit_catalog_products ON master.fabric_types;
CREATE TRIGGER audit_catalog_products
AFTER INSERT OR UPDATE OR DELETE ON master.fabric_types
FOR EACH ROW EXECUTE FUNCTION audit.log_row_change('fabric_type_id');


