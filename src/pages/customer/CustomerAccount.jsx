import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Clock3, LoaderCircle, LogOut, MapPin, Plus, ShoppingCart, Trash2, UserRound, Factory } from 'lucide-react';
import Brand from '../../components/auth/Brand';
import IndiaLocationFields from '../../components/forms/IndiaLocationFields';
import { authenticatedRequest, getAccessToken, signOut } from '../../config/auth';
import './customer.css';

const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const initialAddress = { label: '', line1: '', line2: '', city: '', state: '', pincode: '', country: 'India', isDefault: false };
function displayDate(value) {
  if (!value) return '';
  const raw = String(value);
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw);
  return Number.isNaN(parsed.valueOf()) ? '' : parsed.toLocaleDateString('en-IN');
}

function formatAddress(address) {
  return [address.line1, address.line2, address.city, address.state, address.pincode, address.country].filter(Boolean).join(', ');
}

export default function CustomerAccount() {
  const [user, setUser] = useState(null);
  const [addresses, setAddresses] = useState([]);
  const [orders, setOrders] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [form, setForm] = useState(initialAddress);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingAddressId, setDeletingAddressId] = useState('');
  const [paymentInvoiceId, setPaymentInvoiceId] = useState('');
  const [paymentMode, setPaymentMode] = useState('UPI');
  const [paymentDetails, setPaymentDetails] = useState('');
  const [payingInvoiceId, setPayingInvoiceId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadAccount = useCallback(async () => {
    const [profileData, addressData, orderData, invoiceData] = await Promise.all([
      authenticatedRequest('/auth/me'),
      authenticatedRequest('/orders/addresses'),
      authenticatedRequest('/orders/my'),
      authenticatedRequest('/dispatch/my-invoices'),
    ]);
    setUser(profileData.user);
    setAddresses(addressData.addresses || []);
    setOrders(orderData.orders || []);
    setInvoices(invoiceData.invoices || []);
  }, []);

  const downloadInvoice = async (invoiceId) => {
    let token = getAccessToken();
    if (!token) { await authenticatedRequest('/auth/me'); token = getAccessToken(); }
    const base = (import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/$/, '');
    const response = await fetch(`${base}/api/dispatch/invoices/${invoiceId}/pdf`, { credentials: 'include', headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error?.message || 'Invoice PDF could not be downloaded.'); }
    const blob = await response.blob();
    if (blob.type !== 'application/pdf') throw new Error('The server did not return a PDF.');
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url;
    link.download = response.headers.get('content-disposition')?.match(/filename="?([^";]+)"?/i)?.[1] || `texora-invoice-${invoiceId}.pdf`;
    link.click(); URL.revokeObjectURL(url);
  };

  useEffect(() => {
    let current = true;
    Promise.resolve().then(loadAccount).catch((requestError) => {
      if (current) setError(requestError.message || 'Could not load your account.');
    }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [loadAccount]);

  const updateForm = (event) => {
    const { name, type, value, checked } = event.target;
    setForm((current) => ({ ...current, [name]: type === 'checkbox' ? checked : value }));
  };

  const addAddress = async (event) => {
    event.preventDefault(); if (saving) return;
    setError(''); setNotice(''); setSaving(true);
    try {
      const { address } = await authenticatedRequest('/orders/addresses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      setAddresses((current) => [...current.filter((item) => !address.is_default || !item.is_default), address]);
      setForm(initialAddress);
      setNotice('Address saved to your account.');
    } catch (requestError) { setError(requestError.message || 'Address could not be saved.'); }
    finally { setSaving(false); }
  };

  const deleteAddress = async (address) => {
    if (deletingAddressId) return;
    setError(''); setNotice(''); setDeletingAddressId(String(address.address_id));
    try {
      await authenticatedRequest(`/orders/addresses/${encodeURIComponent(address.address_id)}`, { method: 'DELETE' });
      setAddresses((current) => current.filter((item) => String(item.address_id) !== String(address.address_id)));
      setNotice('Address removed from your account.');
    } catch (requestError) { setError(requestError.message || 'Address could not be deleted.'); }
    finally { setDeletingAddressId(''); }
  };

  const submitPayment = async (event, invoice) => {
    event.preventDefault();
    if (payingInvoiceId) return;
    setError(''); setNotice(''); setPayingInvoiceId(String(invoice.customer_invoice_id));
    try {
      const { invoice: updatedInvoice } = await authenticatedRequest(`/dispatch/my-invoices/${encodeURIComponent(invoice.customer_invoice_id)}/payments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMode, details: paymentDetails }),
      });
      setInvoices((current) => current.map((item) => String(item.customer_invoice_id) === String(updatedInvoice.customer_invoice_id) ? { ...item, ...updatedInvoice } : item));
      setPaymentInvoiceId(''); setPaymentDetails('');
      setNotice('Manual payment recorded. The invoice balance was updated from the saved payment record.');
    } catch (requestError) { setError(requestError.message || 'Payment could not be recorded.'); }
    finally { setPayingInvoiceId(''); }
  };

  const logout = async () => { try { await signOut(); window.location.assign('/login'); } catch (requestError) { setError(requestError.message || 'Sign out could not be completed.'); } };

  return <main className="customer-app">
    <header className="customer-topbar"><div className="customer-topbar-inner"><Brand /><nav className="customer-topbar-actions" aria-label="Customer navigation">
      <Link className="customer-nav-link" to="/customer"><Factory size={17} /> Catalogue</Link>
      <Link className="customer-nav-link" to="/customer/cart"><ShoppingCart size={17} /> Cart</Link>
      <Link className="customer-nav-link" to="/customer/account" aria-current="page"><UserRound size={17} /> Account</Link>
      <button className="logout-button" type="button" onClick={logout} aria-label="Sign out"><LogOut size={16} /><span>Sign out</span></button>
    </nav></div></header>
    <div className="customer-main customer-subpage">
      <div className="portal-heading"><div><span className="section-overline"><UserRound size={15} /> CUSTOMER ACCOUNT</span><h1>Account &amp; orders</h1><p>Your profile, saved delivery addresses and order history.</p></div></div>
      {error && <div className="portal-alert" role="alert">{error}{/session|sign in|access token|unauthorized/i.test(error) && <Link to="/login">Sign in again</Link>}</div>}
      {notice && <div className="portal-success" role="status"><Check size={17} /><span>{notice}</span></div>}
      {busy ? <div className="workspace-state"><LoaderCircle className="spinner" /><p>Loading your account…</p></div> : <div className="account-grid">
        <section className="account-panel profile-panel" aria-labelledby="profile-title">
          <div className="section-title-row"><div><span className="section-overline"><UserRound size={15} /> PROFILE</span><h2 id="profile-title">Account information</h2></div></div>
          <p className="profile-readonly-note">These details are linked to your verified account and can’t be changed here.</p>
          <div className="profile-fields">
            <label>Business name<input value={user?.companyName || '—'} readOnly /></label>
            <label>Contact name<input value={user?.fullName || '—'} readOnly /></label>
            <label>Business email<input type="email" value={user?.email || '—'} readOnly /></label>
            <label>Contact phone<input value={user?.phone || 'Not provided'} readOnly /></label>
          </div>
        </section>

        <section className="account-panel addresses-panel" aria-labelledby="addresses-title">
          <div className="section-title-row"><div><span className="section-overline"><MapPin size={15} /> DELIVERY DETAILS</span><h2 id="addresses-title">Saved addresses</h2></div><span className="line-count">{addresses.length}</span></div>
          {addresses.length ? <ul className="saved-address-list">{addresses.map((address) => <li key={address.address_id}><div><strong>{address.label || 'Delivery address'}</strong>{address.is_default && <span className="default-address-tag">Default</span>}<p>{formatAddress(address)}</p><button className="remove-address" type="button" onClick={() => deleteAddress(address)} disabled={Boolean(deletingAddressId)} aria-label={`Delete ${address.label || 'delivery address'}`}>{deletingAddressId === String(address.address_id) ? <LoaderCircle size={15} className="spinner" /> : <Trash2 size={15} />} {deletingAddressId === String(address.address_id) ? 'Deleting…' : 'Delete address'}</button></div></li>)}</ul> : <p className="account-empty-copy">No delivery addresses saved yet. Add an address to use it during checkout.</p>}
          <form className="address-form" onSubmit={addAddress}>
            <h3><Plus size={16} /> Add an address</h3>
            <label>Address label <span>(optional)</span><input name="label" value={form.label} onChange={updateForm} placeholder="e.g. Main warehouse" maxLength={60} /></label>
            <label>Address line 1<input name="line1" value={form.line1} onChange={updateForm} required maxLength={200} autoComplete="address-line1" /></label>
            <label>Address line 2 <span>(optional)</span><input name="line2" value={form.line2} onChange={updateForm} maxLength={200} autoComplete="address-line2" /></label>
            <IndiaLocationFields className="address-form-row" city={form.city} state={form.state} onCityChange={(city) => setForm((current) => ({ ...current, city }))} onStateChange={(state) => setForm((current) => ({ ...current, state }))} />
            <div className="address-form-row"><label>Postal / ZIP code<input name="pincode" value={form.pincode} onChange={updateForm} required maxLength={12} autoComplete="postal-code" /></label><label>Country<input name="country" value={form.country} onChange={updateForm} required maxLength={100} autoComplete="country-name" /></label></div>
            <label className="default-address-choice"><input type="checkbox" name="isDefault" checked={form.isDefault} onChange={updateForm} /> Make this my default delivery address</label>
            <button className="customer-primary" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spinner" size={17} /> : <Plus size={17} />}{saving ? 'Saving address…' : 'Save address'}</button>
          </form>
        </section>

        <section className="account-panel account-orders-panel" aria-labelledby="account-orders-title">
          <div className="section-title-row"><div><span className="section-overline"><Clock3 size={15} /> ORDER HISTORY</span><h2 id="account-orders-title">Recent orders</h2></div><span className="line-count">{orders.length}</span></div>
          {orders.length ? <div className="account-orders-list">{orders.map((order) => <article className="account-order-card" key={order.order_id}>
            <div className="order-card-heading"><div><strong className="order-number">{order.order_no}</strong><span className={`order-status order-status-${order.status?.toLowerCase()}`}>{order.status?.replaceAll('_', ' ')}</span></div>{displayDate(order.order_date) && <time>{displayDate(order.order_date)}</time>}</div>
            <p className="order-delivery">{displayDate(order.required_by_date) ? `Required by ${displayDate(order.required_by_date)}` : 'No delivery date requested'}</p>
            <ul>{order.items?.map((item) => <li key={item.order_item_id}><span>{item.title} · {item.colour_name} · {Number(item.quantity_m).toLocaleString('en-IN')} m</span><strong>{money.format(item.line_total)}</strong></li>)}</ul>
            {Number(order.dispatch_percent) > 0 && <div className="order-progress"><span>Dispatch progress</span><span>{Math.round(Number(order.dispatch_percent))}%</span><progress value={Number(order.dispatch_percent)} max="100" /></div>}
          </article>)}</div> : <p className="account-empty-copy">Your orders will appear here after you place them from the cart.</p>}
        </section>

        <section className="account-panel account-orders-panel" aria-labelledby="account-invoices-title">
          <div className="section-title-row"><div><span className="section-overline"><Clock3 size={15} /> BILLING</span><h2 id="account-invoices-title">Customer invoices</h2></div><span className="line-count">{invoices.length}</span></div>
          {invoices.length ? <div className="account-orders-list">{invoices.map((invoice) => <article className="account-order-card" key={invoice.customer_invoice_id}>
            <div className="order-card-heading"><div><strong className="order-number">{invoice.invoice_no}</strong><span className={`order-status order-status-${String(invoice.invoice_status).toLowerCase()}`}>{String(invoice.invoice_status).replaceAll('_', ' ')}</span><span className={`order-status order-status-${String(invoice.payment_status).toLowerCase()}`}>{String(invoice.payment_status || 'UNPAID').replaceAll('_', ' ')}</span></div>{displayDate(invoice.invoice_date) && <time>{displayDate(invoice.invoice_date)}</time>}</div>
            <p className="order-delivery">{invoice.order_no} · Shipment {invoice.shipment_no} · {invoice.payment_status?.replaceAll('_', ' ')}</p>
            <ul><li><span>{Number(invoice.total_meters || 0).toLocaleString('en-IN')} m · Balance due</span><strong>{money.format(invoice.balance_due)}</strong></li><li><span>Invoice total</span><strong>{money.format(invoice.total_amount)}</strong></li></ul>
            {invoice.invoice_status !== 'DRAFT' && <div className="billing-actions"><button className="customer-primary" type="button" disabled={Number(invoice.balance_due) <= 0 || Boolean(payingInvoiceId)} onClick={() => { setPaymentInvoiceId(current => current === String(invoice.customer_invoice_id) ? '' : String(invoice.customer_invoice_id)); setPaymentDetails(''); }}>Make payment</button><button className="customer-secondary" type="button" onClick={() => downloadInvoice(invoice.customer_invoice_id).catch((requestError) => setError(requestError.message || 'Invoice PDF could not be downloaded.'))}>Download invoice</button></div>}
            {paymentInvoiceId === String(invoice.customer_invoice_id) && Number(invoice.balance_due) > 0 && <form className="manual-payment-form" onSubmit={(event) => submitPayment(event, invoice)}>
              <p>Record a manual payment of <strong>{money.format(invoice.balance_due)}</strong>. This records the details you submit; no online payment gateway verifies it.</p>
              <label>Payment mode<select value={paymentMode} onChange={(event) => setPaymentMode(event.target.value)} required><option value="UPI">UPI</option><option value="BANK_TRANSFER">Bank transfer</option><option value="CASH">Cash</option><option value="OTHER">Other</option></select></label>
              <label>Payment details / reference<input value={paymentDetails} onChange={(event) => setPaymentDetails(event.target.value)} required minLength={3} maxLength={250} placeholder="UTR, transaction reference, or receipt details" /></label>
              <div className="billing-actions"><button className="customer-primary" type="submit" disabled={Boolean(payingInvoiceId)}>{payingInvoiceId === String(invoice.customer_invoice_id) ? 'Saving payment…' : 'Confirm payment'}</button><button className="customer-secondary" type="button" disabled={Boolean(payingInvoiceId)} onClick={() => setPaymentInvoiceId('')}>Cancel</button></div>
            </form>}
          </article>)}</div> : <p className="account-empty-copy">Issued customer invoices will appear here after dispatch.</p>}
        </section>
      </div>}
      <footer className="customer-footer">Texora · Connected textile manufacturing</footer>
    </div>
  </main>;
}
