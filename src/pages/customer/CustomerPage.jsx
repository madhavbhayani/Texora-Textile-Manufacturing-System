import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Box, ChevronDown, Factory, LoaderCircle, LogOut, Search, ShoppingCart, SlidersHorizontal, UserRound, X, Plus } from 'lucide-react';
import Brand from '../../components/auth/Brand';
import { publicRequest, signOut } from '../../config/auth';
import { readCart, writeCart } from './cartStorage';
import './customer.css';

const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const fallbackDescription = 'Manufactured textile selected for consistent specifications and dependable production.';

function ProductImage({ product }) {
  const [failed, setFailed] = useState(false);
  return product.image_url && !failed
    ? <img className="catalog-image" src={product.image_url} alt={product.title} loading="lazy" onError={() => setFailed(true)} />
    : <div className="catalog-image-fallback" role="img" aria-label={`${product.title} product image unavailable`}><Box size={30} aria-hidden="true" /></div>;
}

function ProductCard({ product, onSelect }) {
  return <article className="catalog-card">
    <button className="catalog-card-open" type="button" onClick={() => onSelect(product)} aria-label={`View ${product.title} details`}><ProductImage product={product} /></button>
    <div className="catalog-card-body">
      <span className="catalog-category">{product.product_category?.replaceAll('_', ' ') || 'FABRIC'}</span>
      <h2>{product.title}</h2>
      <p className="catalog-description">{product.description || fallbackDescription}</p>
      <div className="spec-pills">{product.gsm && <span>{product.gsm} GSM</span>}{product.width_inch && <span>{product.width_inch}&quot; width</span>}{product.weave && <span>{product.weave} weave</span>}</div>
      <div className="catalog-card-bottom"><strong>{money.format(product.unit_price)} <span>/ metre</span></strong><span>{product.available_colours?.length || 0} colours</span></div>
      <button type="button" className="catalog-select-button" onClick={() => onSelect(product)}>Configure order <ArrowRight size={16} aria-hidden="true" /></button>
    </div>
  </article>;
}

function ProductDialog({ product, onClose, onAdd }) {
  const dialogRef = useRef(null);
  const [colourId, setColourId] = useState(product.available_colours?.find((colour) => colour.is_default)?.colour_id || product.available_colours?.[0]?.colour_id || '');
  const [quantity, setQuantity] = useState(String(product.minimum_order_quantity));
  const [attributeValues, setAttributeValues] = useState({});
  const [error, setError] = useState('');
  useEffect(() => { dialogRef.current?.querySelector('button')?.focus(); }, []);
  const configurable = (product.attributes || []).filter((item) => item.customer_configurable);
  const add = (event) => {
    event.preventDefault(); setError('');
    const amount = Number(quantity);
    if (!colourId) { setError('Select an available colour.'); return; }
    if (!Number.isFinite(amount) || amount < Number(product.minimum_order_quantity)) { setError(`Enter at least ${product.minimum_order_quantity} metres.`); return; }
    const attributes = [];
    for (const item of configurable) {
      const value = attributeValues[item.code] ?? '';
      if (item.required_for_order && !String(value).trim()) { setError(`${item.label} is required.`); return; }
      if (String(value).trim()) attributes.push({ attributeCode: item.code, value });
    }
    onAdd({ product, colourId: String(colourId), quantityMeters: amount, attributes });
    onClose();
  };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="product-dialog" role="dialog" aria-modal="true" aria-labelledby="product-dialog-title" onKeyDown={(event) => {
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href]')];
      if (!controls.length) return;
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <button className="icon-button dialog-close" type="button" onClick={onClose} aria-label="Close product details"><X size={19} /></button>
      <div className="dialog-product-image"><ProductImage product={product} /></div>
      <div className="dialog-product-content">
        <span className="catalog-category">{product.product_category?.replaceAll('_', ' ') || 'FABRIC'}</span>
        <h2 id="product-dialog-title">{product.title}</h2>
        <p className="catalog-description">{product.description || fallbackDescription}</p>
        <dl className="detail-specs"><div><dt>Weight</dt><dd>{product.gsm ? `${product.gsm} GSM` : '—'}</dd></div><div><dt>Width</dt><dd>{product.width_inch ? `${product.width_inch} inches` : '—'}</dd></div><div><dt>Weave</dt><dd>{product.weave || '—'}</dd></div><div><dt>Lead time</dt><dd>{product.lead_time_days} days</dd></div></dl>
        {!!product.attributes?.length && <div className="defined-specs"><h3>Product specifications</h3>{product.attributes.filter((attribute) => !attribute.customer_configurable).map((attribute) => <p key={attribute.code}><span>{attribute.label}</span><strong>{attribute.default_value || '—'}</strong></p>)}</div>}
        <form className="configure-form" onSubmit={add}>
          <label>Colour<select value={colourId} onChange={(event) => setColourId(event.target.value)} required><option value="">Choose a colour</option>{product.available_colours?.map((colour) => <option value={colour.colour_id} key={colour.colour_id}>{colour.name}</option>)}</select></label>
          <label>Quantity <span>(metres, minimum {product.minimum_order_quantity})</span><input type="number" min={product.minimum_order_quantity} step="0.01" value={quantity} onChange={(event) => setQuantity(event.target.value)} required /></label>
          {configurable.map((attribute) => <label key={attribute.code}>{attribute.label}{attribute.required_for_order && <span> (required)</span>}{attribute.data_type === 'SELECT' ? <select value={attributeValues[attribute.code] ?? ''} required={attribute.required_for_order} onChange={(event) => setAttributeValues({ ...attributeValues, [attribute.code]: event.target.value })}><option value="">{attribute.default_value ? `Default: ${attribute.default_value}` : 'Choose an option'}</option>{attribute.allowed_values?.map((option) => <option key={option} value={option}>{option}</option>)}</select> : <input type={attribute.data_type === 'NUMBER' ? 'number' : 'text'} maxLength={attribute.data_type === 'TEXT' ? 500 : undefined} value={attributeValues[attribute.code] ?? ''} required={attribute.required_for_order} onChange={(event) => setAttributeValues({ ...attributeValues, [attribute.code]: event.target.value })} placeholder={attribute.default_value || ''} />}</label>)}
          {configurable.some((attribute) => attribute.requires_owner_confirmation) && <p className="owner-review-note">Some custom requirements need Owner review and may affect the production plan.</p>}
          {error && <p className="inline-alert" role="alert">{error}</p>}
          <button className="customer-primary" type="submit"><Plus size={17} /> Add to cart</button>
        </form>
      </div>
    </section>
  </div>;
}

export default function CustomerPage() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState(readCart);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const categories = useMemo(() => [...new Set(products.map((product) => product.product_category).filter(Boolean))].sort(), [products]);

  useEffect(() => {
    let current = true;
    const params = new URLSearchParams();
    if (search.trim()) params.set('q', search.trim());
    if (category) params.set('category', category);
    Promise.resolve().then(() => publicRequest(`/products${params.size ? `?${params}` : ''}`)).then((data) => {
      if (current) setProducts(data.products || []);
    }).catch((requestError) => {
      if (current) setError(requestError.message || 'Could not load the product catalogue.');
    }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [search, category]);

  const addToCart = (line) => {
    const updated = [...cart.filter((entry) => `${entry.product.product_id}:${entry.colourId}` !== `${line.product.product_id}:${line.colourId}`), line];
    setCart(updated); writeCart(updated); setSelected(null);
  };
  const logout = async () => { try { await signOut(); window.location.assign('/login'); } catch (logoutError) { setError(logoutError.message || 'Sign out could not be completed. Please try again.'); } };

  return <main className="customer-app">
    <header className="customer-topbar"><div className="customer-topbar-inner"><Brand /><nav className="customer-topbar-actions" aria-label="Customer navigation">
      <Link className="customer-nav-link" to="/customer" aria-current="page"><Factory size={17} /> Catalogue</Link>
      <Link className="customer-nav-link" to="/customer/cart"><ShoppingCart size={17} /> Cart <span>{cart.length}</span></Link>
      <Link className="customer-nav-link" to="/customer/account"><UserRound size={17} /> Account</Link>
      <button className="logout-button" type="button" onClick={logout} aria-label="Sign out"><LogOut size={16} /><span>Sign out</span></button>
    </nav></div></header>
    <div className="customer-main">
      <section className="catalog-section" aria-labelledby="catalog-title">
        <div className="portal-heading"><div><span className="section-overline"><Factory size={15} /> TEXORA CUSTOMER PORTAL</span><h1 id="catalog-title">Fabric catalogue</h1><p>Choose a defined product and configure the order details.</p></div></div>
        <div className="catalog-tools"><label className="catalog-search"><Search size={17} aria-hidden="true" /><span className="sr-only">Search products</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search fabrics" /></label><label className="catalog-filter"><SlidersHorizontal size={16} aria-hidden="true" /><span className="sr-only">Filter by category</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{categories.map((item) => <option value={item} key={item}>{item.replaceAll('_', ' ')}</option>)}</select><ChevronDown size={15} aria-hidden="true" /></label></div>
        {error && <div className="portal-alert" role="alert">{error}</div>}
        {busy ? <div className="workspace-state"><LoaderCircle className="spinner" /><p>Loading catalogue…</p></div> : !products.length ? <div className="workspace-state"><Box size={25} /><h2>No products found</h2><p>Try another search or check back when new fabrics are published.</p></div> : <div className="catalog-grid">{products.map((product) => <ProductCard key={product.product_id} product={product} onSelect={setSelected} />)}</div>}
      </section>
      <footer className="customer-footer">Texora · Connected textile manufacturing</footer>
    </div>
    {selected && <ProductDialog product={selected} onClose={() => setSelected(null)} onAdd={addToCart} />}
  </main>;
}
