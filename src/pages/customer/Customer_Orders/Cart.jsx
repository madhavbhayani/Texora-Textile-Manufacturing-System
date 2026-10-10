import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Factory, LoaderCircle, LogOut, ShoppingCart, Trash2, UserRound } from 'lucide-react';
import Brand from '../../../components/auth/Brand';
import { authenticatedRequest, signOut } from '../../../config/auth';
import { clearCart, readCart, writeCart } from '../cartStorage';
import '../customer.css';

const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });

export default function Cart() {
  const [cart, setCart] = useState(readCart);
  const [addresses, setAddresses] = useState([]);
  const [addressId, setAddressId] = useState('');
  const [requiredByDate, setRequiredByDate] = useState('');
  const [busy, setBusy] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [successOrder, setSuccessOrder] = useState(null);
  const estimate = useMemo(() => cart.reduce((sum, line) => sum + Number(line.quantityMeters) * Number(line.product.unit_price) * (1 + Number(line.product.tax_percent) / 100), 0), [cart]);

  useEffect(() => {
    let current = true;
    Promise.resolve().then(() => authenticatedRequest('/orders/addresses')).then((data) => {
      if (current) {
        const list = data.addresses || [];
        setAddresses(list);
        setAddressId((selected) => selected || list.find((item) => item.is_default)?.address_id || list[0]?.address_id || '');
      }
    }).catch((requestError) => { if (current) setError(requestError.message || 'Could not load your saved addresses.'); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, []);

  const updateCart = (items) => { setCart(items); writeCart(items); };
  const changeQuantity = (line, value) => {
    const amount = Number(value);
    updateCart(cart.map((item) => item === line ? { ...item, quantityMeters: Number.isFinite(amount) ? amount : '' } : item));
  };
  const removeLine = (line) => updateCart(cart.filter((item) => item !== line));
  const placeOrder = async (event) => {
    event.preventDefault();
    if (submitting) return;
    setError('');
    if (!cart.length) { setError('Your cart is empty. Choose a fabric from the catalogue first.'); return; }
    if (!addressId) { setError('Add a shipping address to your account before placing this order.'); return; }
    const invalid = cart.find((line) => !Number.isFinite(Number(line.quantityMeters)) || Number(line.quantityMeters) < Number(line.product.minimum_order_quantity));
    if (invalid) { setError(`Enter at least ${invalid.product.minimum_order_quantity} metres for ${invalid.product.title}.`); return; }
    setSubmitting(true);
    try {
      const data = await authenticatedRequest('/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shippingAddressId: addressId, requiredByDate: requiredByDate || undefined, items: cart.map((line) => ({ productId: line.product.product_id, colourId: line.colourId, quantityMeters: Number(line.quantityMeters), attributes: line.attributes })) }) });
      setSuccessOrder(data.order);
      setCart([]); clearCart();
    } catch (requestError) { setError(requestError.message || 'The order could not be placed. Your cart has been kept.'); }
    finally { setSubmitting(false); }
  };
  const logout = async () => { try { await signOut(); window.location.assign('/login'); } catch (requestError) { setError(requestError.message || 'Sign out could not be completed.'); } };

  return <main className="customer-app">
    <header className="customer-topbar"><div className="customer-topbar-inner"><Brand /><nav className="customer-topbar-actions" aria-label="Customer navigation">
      <Link className="customer-nav-link" to="/customer"><Factory size={17} /> Catalogue</Link>
      <Link className="customer-nav-link" to="/customer/cart" aria-current="page"><ShoppingCart size={17} /> Cart <span>{cart.length}</span></Link>
      <Link className="customer-nav-link" to="/customer/account"><UserRound size={17} /> Account</Link>
      <button className="logout-button" type="button" onClick={logout} aria-label="Sign out"><LogOut size={16} /><span>Sign out</span></button>
    </nav></div></header>
    <div className="customer-main customer-subpage">
      <div className="portal-heading"><div><span className="section-overline"><ShoppingCart size={15} /> ORDER CHECKOUT</span><h1>Your cart</h1><p>Review quantities and delivery details before placing your order.</p></div></div>
      {error && <div className="portal-alert" role="alert">{error}{/session|sign in|access token|unauthorized/i.test(error) && <Link to="/login">Sign in again</Link>}</div>}
      {successOrder && <section className="cart-success" role="status"><Check size={20} /><div><h2>Order {successOrder.order_no} placed</h2><p>Status: {successOrder.status}. Your confirmed total is {money.format(successOrder.lines.reduce((sum, line) => sum + Number(line.line_total), 0))} including tax.</p>{successOrder.requiresOwnerConfirmation && <p>Some custom requirements need Owner confirmation.</p>}</div></section>}
      {busy ? <div className="workspace-state"><LoaderCircle className="spinner" /><p>Loading your saved addresses…</p></div> : <>
        {!cart.length && !successOrder ? <section className="empty-cart"><span><ShoppingCart size={21} /></span><strong>Your cart is empty</strong><p>Choose a fabric and configure the colour and quantity.</p><Link className="customer-primary" to="/customer">Browse catalogue</Link></section> : null}
        {!!cart.length && <form className="cart-checkout" onSubmit={placeOrder}>
          <section className="cart-panel" aria-labelledby="cart-items-title"><div className="section-title-row"><h2 id="cart-items-title">Items <span>({cart.length})</span></h2></div>
            <ul className="checkout-lines">{cart.map((line) => {
              const colour = line.product.available_colours?.find((item) => String(item.colour_id) === String(line.colourId));
              const subtotal = Number(line.quantityMeters) * Number(line.product.unit_price);
              const total = subtotal * (1 + Number(line.product.tax_percent) / 100);
              return <li key={`${line.product.product_id}:${line.colourId}`}><div className="checkout-product-image">{line.product.image_url ? <img src={line.product.image_url} alt={line.product.title} loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} /> : <ShoppingCart size={20} aria-hidden="true" />}</div><div className="checkout-product-details"><strong>{line.product.title}</strong><span>{colour?.name || 'Colour selected'} · {line.product.gsm ? `${line.product.gsm} GSM` : 'Fabric'}{line.product.width_inch ? ` · ${line.product.width_inch}″` : ''}</span>{line.attributes?.map((attribute) => <small key={attribute.attributeCode}>{attribute.attributeCode === 'SPECIAL_INSTRUCTIONS' ? 'Special instructions' : attribute.attributeCode}: {attribute.value}</small>)}<label>Quantity in metres<input type="number" min={line.product.minimum_order_quantity} step="0.01" value={line.quantityMeters} onChange={(event) => changeQuantity(line, event.target.value)} /></label></div><div className="checkout-line-total"><strong>{money.format(total)}</strong><span>{money.format(line.product.unit_price)} / m</span><button className="remove-line" type="button" onClick={() => removeLine(line)} aria-label={`Remove ${line.product.title}`}><Trash2 size={16} /> Remove</button></div></li>;
            })}</ul>
          </section>
          <aside className="cart-panel checkout-details"><h2>Delivery details</h2>
            {addresses.length ? <label className="builder-field">Ship to<select value={addressId} onChange={(event) => setAddressId(event.target.value)} required>{addresses.map((address) => <option value={address.address_id} key={address.address_id}>{address.label || 'Address'}{address.is_default ? ' · Default' : ''} — {address.line1}, {address.city}</option>)}</select></label> : <div className="address-empty-box"><p>You need a saved shipping address before checkout.</p><Link to="/customer/account">Add an address</Link></div>}
            <label className="builder-field">Required delivery date <span>(optional)</span><input type="date" value={requiredByDate} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setRequiredByDate(event.target.value)} /></label>
            <div className="checkout-totals"><div><span>Estimated total including tax</span><strong>{money.format(estimate)}</strong></div><p>Final price, tax and accepted order status are confirmed by Texora when you place the order.</p></div>
            <button className="customer-primary place-order-button" type="submit" disabled={submitting || busy || !addresses.length}>{submitting ? <LoaderCircle size={17} className="spinner" /> : <Check size={17} />}{submitting ? 'Placing order…' : 'Place order'}</button>
          </aside>
        </form>}
      </>}
      <footer className="customer-footer">Texora · Connected textile manufacturing</footer>
    </div>
  </main>;
}
