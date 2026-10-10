/* Calculate the Owner's indicative margin from collected customer cash rather
   than invoiced revenue. Cost categories include operating costs, but that
   category is excluded from the Owner portal's displayed finance fields. */
CREATE OR REPLACE VIEW reporting.monthly_financial_summary AS
WITH revenue AS (
    SELECT date_trunc('month', ci.invoice_date)::date AS month,
           SUM(l.line_subtotal) AS revenue_ex_tax
    FROM finance.customer_invoices ci
    JOIN finance.customer_invoice_lines l ON l.customer_invoice_id = ci.customer_invoice_id
    WHERE ci.status = 'ISSUED'
    GROUP BY date_trunc('month', ci.invoice_date)::date
), collections AS (
    SELECT date_trunc('month', p.completed_at)::date AS month,
           SUM(p.amount) AS customer_cash_collected
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
    SELECT date_trunc('month', occurred_on)::date AS month,
           SUM(amount) AS allocated_order_costs
    FROM finance.order_cost_entries
    GROUP BY date_trunc('month', occurred_on)::date
), expenses AS (
    SELECT date_trunc('month', expense_date)::date AS month,
           SUM(amount) AS operating_expenses
    FROM finance.operating_expenses
    GROUP BY date_trunc('month', expense_date)::date
), wages AS (
    SELECT date_trunc('month', paid_at)::date AS month,
           SUM(net_amount) AS wages_paid
    FROM hr.wage_payments
    WHERE status = 'PAID' AND paid_at IS NOT NULL
    GROUP BY date_trunc('month', paid_at)::date
), months AS (
    SELECT month FROM revenue
    UNION SELECT month FROM collections
    UNION SELECT month FROM material_cost
    UNION SELECT month FROM extra_cost
    UNION SELECT month FROM expenses
    UNION SELECT month FROM wages
)
SELECT m.month,
       COALESCE(r.revenue_ex_tax, 0) AS revenue_ex_tax,
       COALESCE(c.customer_cash_collected, 0) AS customer_cash_collected,
       COALESCE(mc.material_cost, 0) AS material_consumed_cost,
       COALESCE(ec.allocated_order_costs, 0) AS allocated_order_costs,
       COALESCE(e.operating_expenses, 0) AS operating_expenses,
       COALESCE(w.wages_paid, 0) AS wages_paid,
       COALESCE(c.customer_cash_collected, 0)
         - COALESCE(mc.material_cost, 0)
         - COALESCE(ec.allocated_order_costs, 0)
         - COALESCE(e.operating_expenses, 0)
         - COALESCE(w.wages_paid, 0) AS indicative_margin
FROM months m
LEFT JOIN revenue r ON r.month = m.month
LEFT JOIN collections c ON c.month = m.month
LEFT JOIN material_cost mc ON mc.month = m.month
LEFT JOIN extra_cost ec ON ec.month = m.month
LEFT JOIN expenses e ON e.month = m.month
LEFT JOIN wages w ON w.month = m.month;
