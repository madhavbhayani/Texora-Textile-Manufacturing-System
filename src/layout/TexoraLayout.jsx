import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Activity, Boxes, ClipboardList, ClipboardCheck, Factory, LayoutDashboard, LogOut, Menu, Package, ShieldCheck, Truck, Users, Warehouse, Workflow } from 'lucide-react';
import { signOut } from '../config/auth';
import './TexoraLayout.css';

const storeLinks = [
  ['Overview', '/store-manager', LayoutDashboard], ['Inventory', '/store-manager/inventory', Warehouse], ['Raw Materials', '/store-manager/raw-materials', Package], ['Supervisor Handoffs', '/store-manager/supervisor-handoffs', Truck], ['Suppliers', '/store-manager/suppliers', Users], ['Purchase Orders', '/store-manager/purchase-orders', ClipboardList], ['Receiving & Payables', '/store-manager/procurement', Workflow], ['Stock Movement History', '/store-manager/stock-movements', Boxes],
];
const ownerLinks = [['Overview', '/owner', LayoutDashboard], ...storeLinks.slice(1)];
const supervisorLinks = [
  ['Overview','/supervisor',LayoutDashboard],['Incoming Handoffs','/supervisor/handoffs',Truck],['Production Jobs','/supervisor/jobs',ClipboardList],
  ['Machine Floor','/supervisor/machines',Factory],['Worker Assignments','/supervisor/workers',Users],['Production Logs','/supervisor/production-logs',Activity],
  ['Fabric Rolls','/supervisor/rolls',Package],['Quality Inspection','/supervisor/quality',ShieldCheck],['Rework Queue','/supervisor/rework',Workflow],
  ['Rejected Rolls','/supervisor/rejected',ClipboardCheck],['Production Reports','/supervisor/reports',ClipboardList],
];
const roleNames = { OWNER: 'Owner', STORE_MANAGER: 'Store Manager', SUPERVISOR: 'Supervisor', WORKER: 'Worker', DISPATCH_OFFICER: 'Dispatch Officer' };

export default function TexoraLayout({ user }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const links = user?.role === 'OWNER' ? ownerLinks : user?.role === 'STORE_MANAGER' ? storeLinks : user?.role === 'SUPERVISOR' ? supervisorLinks : user?.role === 'WORKER' ? [['Overview', '/worker', LayoutDashboard]] : [['Overview', '/dispatch', LayoutDashboard]];
  const onStorePath = location.pathname.startsWith('/store-manager');
  const basePath = onStorePath ? '/store-manager' : `/${user?.role?.toLowerCase().replaceAll('_', '-') || 'workspace'}`;
  const logout = async () => { try { await signOut(); navigate('/login', { replace: true }); } catch (error) { window.alert(error.message || 'Sign out could not be completed.'); } };

  return <div className="texora-admin-shell">
    {open && <button className="admin-drawer-backdrop" type="button" aria-label="Close navigation" onClick={() => setOpen(false)} />}
    <aside className={`admin-sidebar${open ? ' is-open' : ''}`} aria-label="Internal workspace navigation">
      <NavLink className="admin-brand" to={basePath} onClick={() => setOpen(false)}><span className="admin-brand-mark"><Boxes size={21} /></span><span>texora</span></NavLink>
      <div className="admin-role-label">{roleNames[user?.role] || 'Workspace'}</div>
      <nav className="admin-nav" aria-label="Workspace pages">{links.map(([label, to, Icon]) => <NavLink key={to} to={to} end={to === '/store-manager' || to === '/owner'} onClick={() => setOpen(false)} className={({ isActive }) => `admin-nav-link${isActive ? ' active' : ''}`}><Icon size={17} aria-hidden="true" /><span>{label}</span></NavLink>)}</nav>
      <div className="admin-sidebar-bottom"><div className="admin-user"><span className="admin-avatar">{(user?.fullName || 'T').trim().slice(0,1).toUpperCase()}</span><span><strong>{user?.fullName || 'Texora user'}</strong><small>{roleNames[user?.role] || user?.role}</small></span></div><button type="button" className="admin-logout" onClick={logout}><LogOut size={17} /><span>Sign out</span></button></div>
    </aside>
    <main className="admin-workspace"><button type="button" className="admin-mobile-menu" onClick={() => setOpen(true)} aria-label="Open navigation"><Menu size={20} /></button><Outlet context={{ user }} /></main>
  </div>;
}

