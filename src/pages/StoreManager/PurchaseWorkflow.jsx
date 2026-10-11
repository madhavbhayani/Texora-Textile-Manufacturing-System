import { useCallback, useEffect, useMemo, useState } from 'react';
import { LoaderCircle, RefreshCw, X } from 'lucide-react';
import { authenticatedRequest } from '../../config/auth';
import { Table } from './StoreManagerDashboard';
import './storeManager.css';

const request = (path, body) => authenticatedRequest(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = value => currency.format(Number(value || 0));
const receivingStatuses = ['ISSUED', 'PARTIALLY_RECEIVED'];

export default function PurchaseWorkflow() {
  const [orders, setOrders] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [payments, setPayments] = useState([]);
  const [workflowData, setWorkflowData] = useState({orders:[],receipts:[],invoices:[],payments:[]});
  const [activeTab, setActiveTab] = useState('purchase-orders');
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [hasMore, setHasMore] = useState({});
  const [po, setPo] = useState(null);
  const [correctionDetail, setCorrectionDetail] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [receiptItemId, setReceiptItemId] = useState('');
  const [invoiceQty, setInvoiceQty] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const query = new URLSearchParams({ limit: '20', offset: String(offset) });
      if (search.trim()) query.set('search', search.trim());
      const [o, r, i, p, wo, wr, wi, wp] = await Promise.all([
        authenticatedRequest(`/store-manager/purchase-orders?${query}`),
        authenticatedRequest(`/store-manager/goods-receipts?${query}`),
        authenticatedRequest(`/store-manager/supplier-invoices?${query}`),
        authenticatedRequest(`/store-manager/supplier-payments?${query}`),
        authenticatedRequest('/store-manager/purchase-orders?limit=100'),
        authenticatedRequest('/store-manager/goods-receipts?limit=100'),
        authenticatedRequest('/store-manager/supplier-invoices?limit=100'),
        authenticatedRequest('/store-manager/supplier-payments?limit=100'),
      ]);
      const next = { orders: o.purchaseOrders || [], receipts: r.goodsReceipts || [], invoices: i.invoices || [], payments: p.payments || [] };
      setOrders(next.orders); setReceipts(next.receipts); setInvoices(next.invoices); setPayments(next.payments);
      setHasMore(Object.fromEntries(Object.entries(next).map(([key, rows]) => [key, rows.length === 20])));
      setWorkflowData({orders:wo.purchaseOrders||[],receipts:wr.goodsReceipts||[],invoices:wi.invoices||[],payments:wp.payments||[]});
    } catch (e) {
      setError(e.message || 'Could not load purchase order workflow.');
    } finally {
      setBusy(false);
    }
  }, [offset, search]);

  useEffect(() => { load(); }, [load]);

  const applyCorrectionUsage = (detail, receiptData) => {
    const correctedLines = new Map((detail?.items || []).map(item => [String(item.goods_receipt_item_id), Number(item.billed_qty_kg)]));
    const items = (receiptData.items || []).map(item => ({
      ...item,
      billed_qty_kg: Math.max(0, Number(item.billed_qty_kg || 0) - (correctedLines.get(String(item.goods_receipt_item_id)) || 0)),
    }));
    setReceipt({ ...receiptData, items });
    const preferred = detail?.items?.[0]?.goods_receipt_item_id;
    const first = items.find(item => Number(item.accepted_qty_kg) > Number(item.billed_qty_kg || 0));
    const selectedLine = items.find(item => String(item.goods_receipt_item_id) === String(preferred)) || first;
    setReceiptItemId(selectedLine ? String(selectedLine.goods_receipt_item_id) : '');
    setInvoiceQty(preferred ? String(detail.items.find(item => String(item.goods_receipt_item_id) === String(preferred))?.billed_qty_kg || '') : '');
  };

  const openWorkflow = async (order, correction = null) => {
    if (!order) {
      setError('The purchase order for this invoice is unavailable. Refresh the list and try again.');
      return;
    }
    setDialogOpen(true);
    setPo(null);
    setCorrectionDetail(null);
    setReceipt(null);
    setReceiptItemId('');
    setInvoiceQty('');
    setError('');
    setNotice('');
    try {
      const result = await authenticatedRequest(`/store-manager/purchase-orders/${order.purchase_order_id}`);
      setPo(result.purchaseOrder);
      if (correction) {
        const invoiceResult = await authenticatedRequest(`/store-manager/supplier-invoices/${correction.supplier_invoice_id}`);
        const detail = invoiceResult.invoice;
        setCorrectionDetail(detail);
        const receiptResult = await authenticatedRequest(`/store-manager/goods-receipts/${detail.goods_receipt_id}`);
        applyCorrectionUsage(detail, receiptResult.goodsReceipt);
      }
    } catch (e) {
      setError(e.message || 'Could not open this purchase workflow.');
    }
  };

  const selectReceipt = async id => {
    setReceipt(null);
    setReceiptItemId('');
    setInvoiceQty('');
    setError('');
    if (!id) return;
    try {
      const result = await authenticatedRequest(`/store-manager/goods-receipts/${id}`);
      const detail = result.goodsReceipt;
      if (correctionDetail && String(correctionDetail.goods_receipt_id) === String(id)) applyCorrectionUsage(correctionDetail, detail);
      else {
        setReceipt(detail);
        const first = detail.items.find(item => Number(item.accepted_qty_kg) > Number(item.billed_qty_kg || 0));
        if (first) setReceiptItemId(String(first.goods_receipt_item_id));
      }
    } catch (e) {
      setError(e.message || 'Could not load receipt details.');
    }
  };

  const refreshWorkflow = async () => {
    const currentPoId = po?.purchase_order_id;
    const currentCorrectionId = correctionDetail?.supplier_invoice_id;
    await load();
    if (currentPoId) {
      const nextOrder = { purchase_order_id: currentPoId };
      const nextCorrection = currentCorrectionId ? { supplier_invoice_id: currentCorrectionId } : null;
      await openWorkflow(nextOrder, nextCorrection);
    }
  };

  const submit = async (event, fn) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await fn(new FormData(event.currentTarget));
      setNotice(result || 'Workflow step saved.');
      await load();
      if (po) {
        const refreshed = await authenticatedRequest(`/store-manager/purchase-orders/${po.purchase_order_id}`);
        setPo(refreshed.purchaseOrder);
      }
      if (correctionDetail && result?.startsWith('Correction')) {
        setCorrectionDetail(null);
        setReceipt(null);
        setReceiptItemId('');
        setInvoiceQty('');
      }
    } catch (e) {
      setError(e.message || 'Could not save this purchase workflow step.');
    } finally {
      setSaving(false);
    }
  };

  const receive = event => submit(event, async form => {
    if (!po) throw new Error('Choose a purchase order first.');
    await request(`/store-manager/purchase-orders/${po.purchase_order_id}/receive`, {
      deliveryNoteNo: form.get('deliveryNoteNo'),
      items: [{ poItemId: form.get('poItemId'), receivedQtyKg: form.get('receivedQtyKg'), acceptedQtyKg: form.get('acceptedQtyKg'), unitCost: form.get('unitCost') }],
    });
    return 'Goods receipt posted to inventory.';
  });

  const billable = useMemo(() => (receipt?.items || []).filter(item => Number(item.accepted_qty_kg) > Number(item.billed_qty_kg || 0)), [receipt]);
  const selectedReceiptItem = billable.find(item => String(item.goods_receipt_item_id) === receiptItemId);
  const invoicePreview = selectedReceiptItem && Number(invoiceQty) > 0 ? Number(invoiceQty) * Number(selectedReceiptItem.unit_rate) * (1 + Number(selectedReceiptItem.tax_percent) / 100) : null;

  const invoice = event => submit(event, async form => {
    if (!po) throw new Error('Choose a purchase order first.');
    const response = await request('/store-manager/supplier-invoices', {
      purchaseOrderId: po.purchase_order_id,
      goodsReceiptId: form.get('goodsReceiptId'),
      correctionInvoiceId: correctionDetail?.supplier_invoice_id || null,
      invoiceDate: form.get('invoiceDate') || null,
      dueDate: form.get('dueDate') || null,
      supplierInvoiceNo: form.get('supplierInvoiceNo') || null,
      notes: form.get('notes') || null,
      items: [{ goodsReceiptItemId: form.get('receiptItemId'), quantityKg: form.get('quantityKg') }],
    });
    return response.invoice.correction_resubmitted
      ? `Correction resubmitted for ${response.invoice.internal_invoice_no}. Owner review is pending.`
      : `Invoice ${response.invoice.internal_invoice_no} recorded. Server calculated amount: ${fmt(response.invoice.invoice_total)}.`;
  });

  const payment = event => submit(event, async form => {
    const result = await request('/store-manager/supplier-payments', { supplierInvoiceId: form.get('supplierInvoiceId'), payOutstanding: true, paymentMethod: form.get('paymentMethod'), paymentReference: form.get('paymentReference') });
    return `Payment ${result.payment.payment_no} recorded for ${fmt(result.payment.amount)} (pending confirmation).`;
  });

  const confirmPayment = async item => {
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await authenticatedRequest(`/store-manager/supplier-payments/${item.supplier_payment_id}/complete`, { method: 'POST' });
      setNotice(`${item.payment_no} confirmed as completed.`);
      await load();
    } catch (e) {
      setError(e.message || 'Could not confirm payment.');
    } finally {
      setSaving(false);
    }
  };

  const invoiceOptions = workflowData.invoices.filter(item => item.status === 'APPROVED' && Number(item.outstanding) > 0 && (!po || String(item.purchase_order_id) === String(po.purchase_order_id)));
  const previousReceiptItems = correctionDetail?.items || [];
  const canReceive = po && receivingStatuses.includes(po.status);
  const purchaseOrderRows = orders.map(order => {
    const correction = workflowData.invoices.find(item => String(item.purchase_order_id) === String(order.purchase_order_id) && item.status === 'CORRECTION_REQUESTED');
    return { ...order, display_status: correction ? 'CORRECTION_REQUESTED' : order.status, correction };
  });

  return <section className="admin-page sm-receiving-page">
    <header className="admin-page-heading"><div><h1>Receiving &amp; payables</h1><p>Open a purchase order to review its receiving, invoice, and payment workflow.</p></div><button className="admin-button secondary" type="button" onClick={refreshWorkflow} disabled={busy}><RefreshCw size={14}/> Refresh</button></header>
    {error && !dialogOpen && <div className="admin-alert" role="alert">{error}</div>}
    {notice && !dialogOpen && <div className="sm-notice" role="status">{notice}</div>}

    <div className="sm-payables-tabs" role="tablist" aria-label="Receiving and payables">
      {[
        ['purchase-orders', 'Purchase orders', orders.length],
        ['supplier-invoices', 'Recent supplier invoices', invoices.length],
        ['supplier-payments', 'Recent supplier payments', payments.length],
      ].map(([id, label, count]) => <button key={id} id={`sm-tab-${id}`} className="sm-payables-tab" type="button" role="tab" aria-selected={activeTab === id} aria-controls={`sm-panel-${id}`} onClick={() => { setActiveTab(id); setOffset(0); }}>
        {label}<span>{count}</span>
      </button>)}
    </div>
    <div className="admin-toolbar sm-list-toolbar"><input value={search} onChange={event => { setOffset(0); setSearch(event.target.value); }} placeholder={`Search ${activeTab === 'purchase-orders' ? 'purchase orders' : activeTab === 'supplier-invoices' ? 'supplier invoices' : 'supplier payments'}`} aria-label="Search current list"/><div className="admin-pager"><button className="admin-button secondary" type="button" disabled={offset===0||busy} onClick={()=>setOffset(Math.max(0,offset-20))}>Previous</button><span>{offset+1}–{offset+Math.max(orders.length,invoices.length,payments.length,receipts.length)} shown</span><button className="admin-button secondary" type="button" disabled={!hasMore[{ 'purchase-orders':'orders','supplier-invoices':'invoices','supplier-payments':'payments' }[activeTab]]||busy} onClick={()=>setOffset(offset+20)}>Next</button></div></div>

    {activeTab === 'purchase-orders' && <section className="admin-card sm-content" role="tabpanel" id="sm-panel-purchase-orders" aria-labelledby="sm-tab-purchase-orders">
      <div className="owner-card-heading"><div><h2>Purchase orders</h2><p>Open an order to review receiving, supplier invoices, and payments.</p></div></div>
      {busy ? <div className="admin-state"><LoaderCircle size={18}/> Loading purchase orders…</div> : purchaseOrderRows.length ? <Table columns={[
        ['po_no', 'Purchase order'],
        ['purchase_type', 'Type', item => item.purchase_type === 'ORDER_SPECIFIC' ? 'Customer order' : 'General purchase'],
        ['supplier_name', 'Supplier'],
        ['line_count', 'Lines'],
        ['total', 'Total', item => fmt(item.total)],
        ['display_status', 'Status', item => <span className={`sm-tag sm-status-${String(item.display_status || '').toLowerCase()}`}>{String(item.display_status || '—').replaceAll('_', ' ')}</span>],
        ['actions', 'Action', item => <button className="admin-button secondary" type="button" onClick={() => openWorkflow(item, item.correction)}>{item.correction ? 'Continue correction' : 'Open workflow'}</button>],
      ]} rows={purchaseOrderRows}/> : <div className="admin-state">No purchase orders to display.</div>}
    </section>}

    {dialogOpen && <div className="sm-workflow-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setDialogOpen(false); }}>
      <section className="sm-workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="sm-workflow-title" onKeyDown={event => { if (event.key === 'Escape') setDialogOpen(false); }}>
        <header className="sm-workflow-dialog-header"><div><span className="owner-kicker">RECEIVING &amp; PAYABLES</span><h2 id="sm-workflow-title">{po ? `${po.po_no} · ${po.supplier_name}` : 'Purchase order workflow'}</h2><p>{correctionDetail ? 'Review the original values, update the invoice, and resubmit it for Owner review.' : 'Complete receiving and invoice steps for this purchase order.'}</p></div><button type="button" className="owner-icon-button" aria-label="Close purchase order workflow" onClick={() => setDialogOpen(false)}><X size={19}/></button></header>
        <div className="sm-workflow-dialog-body">
          {error && <div className="admin-alert" role="alert">{error}</div>}{notice && <div className="sm-notice" role="status">{notice}</div>}
          {!po ? <div className="admin-state"><LoaderCircle size={18}/> Loading purchase order…</div> : <>
            <div className="sm-po-summary"><strong>{po.po_no}</strong><span>{po.supplier_name}</span><span className="sm-tag">{po.status}</span><span>Total {fmt(po.total)}</span></div>
            <Table columns={[["yarn_name","Raw material"],["ordered_qty_kg","Ordered kg"],["received_qty_kg","Previously received kg"],["unit_rate","PO rate / kg"],["tax_percent","Tax %"]]} rows={po.items || []}/>

            {correctionDetail && <section className="admin-card sm-prior-values"><div><h3>Previous invoice and receiving values</h3><p>{correctionDetail.internal_invoice_no} · GRN {correctionDetail.grn_no} · {correctionDetail.latest_review_reason}</p></div><Table columns={[["yarn_name","Material"],["received_qty_kg","Received kg"],["accepted_qty_kg","Accepted kg"],["unit_cost_per_kg","Receiving cost / kg"],["billed_qty_kg","Previously billed kg"],["unit_rate","Invoice rate / kg"],["line_total","Previous line total"]]} rows={previousReceiptItems}/></section>}

            <div className="sm-workflow-grid sm-workflow-dialog-grid">
              <section className="admin-card sm-form-card"><h3>1. Receive goods</h3>
                {!canReceive && <p className="sm-muted">Goods receipt values already posted to inventory are shown above and cannot be overwritten. Record a new receipt only if the purchase order still has an open quantity.</p>}
                {canReceive ? <form className="admin-form" onSubmit={receive}>
                  <label>PO line<select name="poItemId" required defaultValue=""><option value="">Select remaining line</option>{po.items.filter(item => Number(item.ordered_qty_kg) > Number(item.received_qty_kg || 0)).map(item => <option value={item.po_item_id} key={item.po_item_id}>{item.yarn_name} · remaining {(Number(item.ordered_qty_kg) - Number(item.received_qty_kg || 0)).toFixed(3)} kg</option>)}</select></label>
                  <label>Delivery note<input name="deliveryNoteNo"/></label><label>Received kg<input name="receivedQtyKg" type="number" min="0.001" step="0.001" required/></label><label>Accepted kg<input name="acceptedQtyKg" type="number" min="0" step="0.001" required/></label><label>PO unit rate / kg<input name="unitCost" type="number" min="0" step="0.0001" required/></label><p className="sm-muted">Texora generates the inventory lot code when the receipt is posted.</p><button className="admin-button" disabled={saving}>Post receipt</button>
                </form> : <Table columns={[["grn_no","Goods receipt"],["accepted_kg","Accepted kg"],["received_at","Received"]]} rows={workflowData.receipts.filter(item => String(item.purchase_order_id) === String(po.purchase_order_id))}/>}
              </section>

              <section className="admin-card sm-form-card"><h3>2. Record supplier invoice</h3>
                <form className="admin-form" onSubmit={invoice} key={`${correctionDetail?.supplier_invoice_id || 'new'}-${receipt?.goods_receipt_id || ''}`}>
                  <label>Goods receipt<select name="goodsReceiptId" required value={correctionDetail?.goods_receipt_id || receipt?.goods_receipt_id || ''} disabled={Boolean(correctionDetail)} onChange={event => selectReceipt(event.target.value)}><option value="">Select receipt from this PO</option>{workflowData.receipts.filter(item => String(item.purchase_order_id) === String(po.purchase_order_id)).map(item => <option value={item.goods_receipt_id} key={item.goods_receipt_id}>{item.grn_no} · {item.accepted_kg} kg accepted</option>)}</select></label>
                  <label>Accepted receipt line<select name="receiptItemId" required value={receiptItemId} onChange={event => { setReceiptItemId(event.target.value); const prior=correctionDetail?.items.find(item=>String(item.goods_receipt_item_id)===event.target.value); if(prior)setInvoiceQty(String(prior.billed_qty_kg)); }}><option value="">Select accepted line</option>{(correctionDetail ? (receipt?.items || []) : billable).map(item => <option value={item.goods_receipt_item_id} key={item.goods_receipt_item_id}>{item.yarn_name} · accepted {Number(item.accepted_qty_kg).toFixed(3)} kg</option>)}</select></label>
                  <label>Supplier invoice reference (optional)<input name="supplierInvoiceNo" defaultValue={correctionDetail?.supplier_invoice_no || ''}/></label>
                  <label>Invoice date<input name="invoiceDate" type="date" defaultValue={correctionDetail?.invoice_date ? String(correctionDetail.invoice_date).slice(0,10) : ''}/></label><label>Due date<input name="dueDate" type="date" defaultValue={correctionDetail?.due_date ? String(correctionDetail.due_date).slice(0,10) : ''}/></label>
                  <label>Bill quantity kg<input name="quantityKg" type="number" min="0.001" step="0.001" max={selectedReceiptItem ? Number(selectedReceiptItem.accepted_qty_kg) : undefined} value={invoiceQty} onChange={event => setInvoiceQty(event.target.value)} required/></label>
                  <label>Correction notes (optional)<input name="notes" defaultValue={correctionDetail?.notes || ''}/></label>
                  {selectedReceiptItem && <p className="sm-muted">PO rate {fmt(selectedReceiptItem.unit_rate)} per kg and PO tax {selectedReceiptItem.tax_percent}% are applied by the server.</p>}
                  {invoicePreview != null && <p className="sm-balance">Invoice line estimate: {fmt(invoicePreview)} <small>Server calculates the authoritative total from PO rate and tax.</small></p>}
                  <button className="admin-button" disabled={saving || !receipt || !receiptItemId}>{correctionDetail ? 'Resubmit corrected invoice' : 'Create invoice'}</button>
                </form>
              </section>

              <section className="admin-card sm-form-card"><h3>3. Record payment</h3>
                {correctionDetail && <p className="sm-muted">A corrected invoice must be approved by the Owner before payment can be recorded.</p>}
                <form className="admin-form" onSubmit={payment}><label>Approved outstanding invoice<select name="supplierInvoiceId" required value={invoiceId} onChange={event => setInvoiceId(event.target.value)}><option value="">Select approved invoice</option>{invoiceOptions.map(item => <option value={item.supplier_invoice_id} key={item.supplier_invoice_id}>{item.internal_invoice_no} · balance {fmt(item.outstanding)}</option>)}</select></label>{invoiceId && <p className="sm-balance">Amount to pay: {fmt(invoiceOptions.find(item => String(item.supplier_invoice_id) === invoiceId)?.outstanding)} <small>Loaded from current invoice balance.</small></p>}<label>Payment method<select name="paymentMethod"><option>BANK_TRANSFER</option><option>UPI</option><option>CHEQUE</option><option>CASH</option><option>OTHER</option></select></label><label>Reference<input name="paymentReference"/></label><button className="admin-button" disabled={saving || !invoiceId}>Pay outstanding amount</button></form>
                <h4>Previous payments</h4><Table columns={[["payment_no","Payment"],["internal_invoice_no","Invoice"],["amount","Amount"],["status","Status"]]} rows={workflowData.payments.filter(item => workflowData.invoices.some(invoiceItem => String(invoiceItem.supplier_invoice_id) === String(item.supplier_invoice_id) && String(invoiceItem.purchase_order_id) === String(po.purchase_order_id)))}/>
              </section>
            </div>
          </>}
        </div>
        <footer className="sm-workflow-dialog-footer"><button type="button" className="admin-button secondary" onClick={() => setDialogOpen(false)}>Close</button></footer>
      </section>
    </div>}

    {activeTab === 'supplier-invoices' && <section className="admin-card sm-content" role="tabpanel" id="sm-panel-supplier-invoices" aria-labelledby="sm-tab-supplier-invoices"><div className="owner-card-heading"><div><h2>Recent supplier invoices</h2><p>Review invoice balances and continue any correction requests.</p></div></div><Table columns={[["internal_invoice_no","Invoice"],["purchase_order_no","Purchase order"],["supplier_name","Supplier"],["invoice_total","Total",item => fmt(item.invoice_total)],["paid_amount","Paid",item => fmt(item.paid_amount)],["outstanding","Outstanding",item => fmt(item.outstanding)],["status","Status"],["correction_reason","Correction reason"],["actions","Action",item => item.status === 'CORRECTION_REQUESTED' ? <button className="admin-button secondary" type="button" onClick={() => openWorkflow(orders.find(order => String(order.purchase_order_id) === String(item.purchase_order_id)) || { purchase_order_id: item.purchase_order_id }, item)}>Continue correction</button> : '—']]} rows={invoices}/></section>}
    {activeTab === 'supplier-payments' && <section className="admin-card sm-content" role="tabpanel" id="sm-panel-supplier-payments" aria-labelledby="sm-tab-supplier-payments"><div className="owner-card-heading"><div><h2>Recent supplier payments</h2><p>Track recorded payments and confirm pending transfers.</p></div></div><Table columns={[["payment_no","Payment"],["internal_invoice_no","Invoice"],["amount","Amount",item => fmt(item.amount)],["payment_date","Date"],["payment_method","Method"],["status","Status"],["actions","Action",item => item.status === 'PENDING' ? <button type="button" className="admin-button" disabled={saving} onClick={() => confirmPayment(item)}>Confirm completed</button> : <span className="sm-tag">Completed</span>]]} rows={payments}/></section>}
  </section>;
}
