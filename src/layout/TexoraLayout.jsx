import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Activity, Boxes, Bell, ClipboardList, ClipboardCheck, Clock3, Factory, FileBarChart, LayoutDashboard, LogOut, Menu, Package, Settings, ShieldCheck, Truck, Users, Wallet, Warehouse, Workflow, UserCog, CreditCard, BadgeDollarSign } from 'lucide-react';
import { signOut } from '../config/auth';
import './TexoraLayout.css';

const storeLinks = [
  ['Overview', '/store-manager', LayoutDashboard], ['Inventory', '/store-manager/inventory', Warehouse], ['Raw Materials', '/store-manager/raw-materials', Package], ['Supervisor Handoffs', '/store-manager/supervisor-handoffs', Truck], ['Rejected Roll Materials', '/store-manager/rework-material-requests', ClipboardCheck], ['Suppliers', '/store-manager/suppliers', Users], ['Purchase Orders', '/store-manager/purchase-orders', ClipboardList], ['Receiving & Payables', '/store-manager/procurement', Workflow], ['Stock Movement History', '/store-manager/stock-movements', Boxes],
];
const ownerGroups = [
  { title: 'OVERVIEW', items: [['Executive dashboard','/owner',LayoutDashboard]] },
  { title: 'BUSINESS OPERATIONS', items: [
    ['Customers & orders','/owner/orders',ClipboardList],['Product catalogue & BOM','/owner/catalog',Package],['Inventory & raw materials','/owner/inventory',Warehouse],['Suppliers','/owner/suppliers',Users],['Purchase orders','/owner/purchase-orders',ClipboardCheck],['Goods receipts','/owner/goods-receipts',Boxes],['Invoice approvals','/owner/supplier-invoice-approvals',ShieldCheck],['Supplier payments','/owner/supplier-payments',CreditCard],['Production & jobs','/owner/production',Factory],['Machines & downtime','/owner/machines',Activity],['Quality control','/owner/quality',ClipboardCheck],['Dispatch & shipments','/owner/dispatch',Truck],
  ] },
  { title: 'FINANCE & PEOPLE', items: [['Customer invoices','/owner/customer-invoices',BadgeDollarSign],['Finance & profitability','/owner/finance',Wallet],['Workforce & wages','/owner/workforce',Users]] },
  { title: 'ADMINISTRATION', items: [['Reports & analytics','/owner/reports',FileBarChart],['Users & roles','/owner/users',UserCog],['Audit log & activity','/owner/audit-log',FileBarChart],['Notifications','/owner/notifications',Bell],['System settings','/owner/settings',Settings]] },
];
const supervisorLinks = [
  ['Overview','/supervisor',LayoutDashboard],['Incoming Handoffs','/supervisor/handoffs',Truck],['Production Jobs','/supervisor/jobs',ClipboardList],
  ['Machine Floor','/supervisor/machines',Factory],['Worker Assignments','/supervisor/workers',Users],['Production Logs','/supervisor/production-logs',Activity],
  ['Quality Inspection','/supervisor/quality',ShieldCheck],['Rework Queue','/supervisor/rework',Workflow],
  ['Rejected Rolls','/supervisor/rejected',ClipboardCheck],['Production Reports','/supervisor/reports',ClipboardList],
];
const workerLinks = [['Overview','/worker',LayoutDashboard],['My Attendance','/worker/attendance',Clock3],['My Jobs','/worker/jobs',ClipboardList],['Production Work','/worker/production-logs',Factory],['My Profile','/worker/profile',Users]];
const dispatchLinks = [['Overview','/dispatch',LayoutDashboard],['Dispatch Queue','/dispatch/queue',ClipboardList],['Packing','/dispatch/packing',Package],['Shipments','/dispatch/shipments',Truck],['Customer Invoices','/dispatch/invoices',BadgeDollarSign],['Delivery Tracking','/dispatch/delivery-tracking',Activity]];
const roleNames = { OWNER: 'Owner', STORE_MANAGER: 'Store Manager', SUPERVISOR: 'Supervisor', WORKER: 'Worker', DISPATCH_OFFICER: 'Dispatch Officer' };

export default function TexoraLayout({ user }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const links = user?.role === 'STORE_MANAGER' ? storeLinks : user?.role === 'SUPERVISOR' ? supervisorLinks : user?.role === 'WORKER' ? workerLinks : user?.role === 'DISPATCH_OFFICER' ? dispatchLinks : [['Overview', '/dispatch', LayoutDashboard]];
  const navGroups = user?.role === 'OWNER' ? ownerGroups : [{title:null,items:links}];
  const onStorePath = location.pathname.startsWith('/store-manager');
  const basePath = onStorePath ? '/store-manager' : user?.role === 'DISPATCH_OFFICER' ? '/dispatch' : `/${user?.role?.toLowerCase().replaceAll('_', '-') || 'workspace'}`;
  const logout = async () => { try { await signOut(); navigate('/login', { replace: true }); } catch (error) { window.alert(error.message || 'Sign out could not be completed.'); } };

  return <div className="texora-admin-shell">
    {open && <button className="admin-drawer-backdrop" type="button" aria-label="Close navigation" onClick={() => setOpen(false)} />}
    <aside className={`admin-sidebar${open ? ' is-open' : ''}`} aria-label="Internal workspace navigation">
      <NavLink className="admin-brand" to={basePath} onClick={() => setOpen(false)}><span className="admin-brand-mark"><Boxes size={21} /></span><span>texora</span></NavLink>
      <div className="admin-role-label">{roleNames[user?.role] || 'Workspace'}</div>
      <nav className="admin-nav" aria-label="Workspace pages">{navGroups.map(group=><div className="admin-nav-group" key={group.title||'workspace'}>{group.title&&<span className="admin-nav-heading">{group.title}</span>}{group.items.map(([label,to,Icon])=><NavLink key={to} to={to} end={to==='/store-manager'||to==='/owner'||to==='/worker'} onClick={()=>setOpen(false)} className={({isActive})=>`admin-nav-link${isActive?' active':''}`}><Icon size={17} aria-hidden="true"/><span>{label}</span></NavLink>)}</div>)}</nav>
      <div className="admin-sidebar-bottom"><div className="admin-user"><span className="admin-avatar">{(user?.fullName || 'T').trim().slice(0,1).toUpperCase()}</span><span><strong>{user?.fullName || 'Texora user'}</strong><small>{roleNames[user?.role] || user?.role}</small></span></div><button type="button" className="admin-logout" onClick={logout}><LogOut size={17} /><span>Sign out</span></button></div>
    </aside>
    <main className="admin-workspace"><button type="button" className="admin-mobile-menu" onClick={() => setOpen(true)} aria-label="Open navigation"><Menu size={20} /></button><Outlet context={{ user }} /></main>
  </div>;
}

