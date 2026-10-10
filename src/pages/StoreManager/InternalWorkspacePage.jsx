import { useOutletContext } from 'react-router-dom';
import { useLocation } from 'react-router-dom';
import StoreManagerDashboard from './StoreManagerDashboard';
import SupervisorHandoffsPage from './SupervisorHandoffsPage';

export default function InternalWorkspacePage() {
  const { user } = useOutletContext(); const location = useLocation();
  if (user?.role === 'OWNER') return <StoreManagerDashboard />;
  if (user?.role === 'SUPERVISOR' && location.pathname.endsWith('/handoffs')) return <SupervisorHandoffsPage />;
  return <section className="admin-page"><header className="admin-page-heading"><div><h1>{user?.role === 'SUPERVISOR' ? 'Supervisor workspace' : user?.role === 'WORKER' ? 'Worker workspace' : 'Dispatch workspace'}</h1><p>Your Texora workspace is ready. Operational pages for this role are not configured yet.</p></div></header></section>;
}
