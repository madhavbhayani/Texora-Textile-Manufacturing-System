import { useEffect, useState } from 'react';
import { AlertTriangle, ClipboardList, CreditCard, Package, Truck } from 'lucide-react';
import { authenticatedRequest } from '../../config/auth';
import './storeManager.css';

const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const labels = [['active_stock_kg','Active raw-material stock',' kg',Package],['raw_material_types','Raw-material types','',Package],['low_stock_types','Below reorder level','',AlertTriangle],['open_purchase_orders','Open purchase orders','',ClipboardList],['awaiting_receipt','Awaiting receipt','',Truck],['pending_invoices','Pending supplier invoices','',CreditCard],['payable_balance','Outstanding payable','',CreditCard],['pending_handoffs','Pending Supervisor handoffs','',Truck]];
const alertLabels = [['low_stock_types','Material below reorder level'],['overdue_purchase_orders','Overdue purchase orders'],['receipts_without_invoice','Receipts without supplier invoice'],['overdue_supplier_invoices','Overdue supplier invoices']];
function Table({ columns, rows, empty = 'No records yet.' }) { return rows?.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr>{columns.map(([key,label])=><th key={key}>{label}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={row.stock_movement_id||row.purchase_order_id||row.goods_receipt_id||row.supplier_id||row.yarn_type_id||row.handoff_id||index}>{columns.map(([key,,render])=><td key={key}>{render?render(row):row[key] ?? '—'}</td>)}</tr>)}</tbody></table></div> : <div className="admin-state">{empty}</div>; }
export { Table };
export default function StoreManagerDashboard() {
  const [data,setData]=useState(null);const [error,setError]=useState('');const [busy,setBusy]=useState(true);
  useEffect(()=>{let active=true;authenticatedRequest('/store-manager/dashboard').then((result)=>{if(active)setData(result.dashboard);}).catch((e)=>{if(active)setError(e.message||'Dashboard data could not be loaded.');}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[]);
  const metrics=data?.metrics;
  return <section className="admin-page"><header className="admin-page-heading"><div><h1>Store overview</h1><p>Current raw-material stock, procurement and production handoffs.</p></div></header>
    {error&&<div className="admin-alert" role="alert">{error}</div>}{busy?<div className="admin-state">Loading overview…</div>:metrics&&<div className="admin-metrics">{labels.map(([key,label,suffix,Icon])=><article className="admin-metric" key={key}><span><Icon size={14} aria-hidden="true" /> {label}</span><strong>{key==='payable_balance'?money.format(Number(metrics[key]||0)):`${Number(metrics[key]||0).toLocaleString('en-IN')}${suffix}`}</strong></article>)}</div>}
    {data&&<><section className="admin-card sm-alerts"><h2>Operational alerts</h2>{alertLabels.filter(([key])=>Number(data.alerts?.[key]||0)>0).length?<ul>{alertLabels.filter(([key])=>Number(data.alerts?.[key]||0)>0).map(([key,label])=><li key={key}><AlertTriangle size={14}/><span>{label}</span><strong>{Number(data.alerts[key]).toLocaleString('en-IN')}</strong></li>)}</ul>:<p>No current stock or procurement alerts.</p>}</section><div className="admin-two-column"><section className="admin-card"><h2>Recent stock movements</h2><Table columns={[["movement_type","Movement"],["yarn_name","Raw material"],["quantity_delta_kg","Quantity (kg)"],["lot_code","Lot"],["moved_by_name","Recorded by"]]} rows={data.recentMovements}/></section><section className="admin-card"><h2>Recent procurement activity</h2><Table columns={[["activity_type","Activity"],["reference","Reference"],["status","Status"],["detail","Supplier"]]} rows={data.recentProcurement}/></section></div></>}
  </section>;
}
