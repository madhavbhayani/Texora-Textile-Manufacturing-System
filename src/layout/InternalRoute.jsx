import { cloneElement, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { authenticatedRequest } from '../config/auth';

export default function InternalRoute({ roles, children }) {
  const [state, setState] = useState({ busy: true, user: null, error: '' });
  const location = useLocation();
  useEffect(() => {
    let current = true;
    authenticatedRequest('/auth/me').then(({ user }) => { if (current) setState({ busy: false, user, error: '' }); })
      .catch(() => { if (current) setState({ busy: false, user: null, error: 'Sign in to continue.' }); });
    return () => { current = false; };
  }, []);
  if (state.busy) return <main className="internal-loading" role="status">Loading workspace…</main>;
  if (!state.user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (state.user.mustChangePassword && location.pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  if (!state.user.mustChangePassword && location.pathname === '/change-password') return <Navigate to={state.user.role === 'OWNER' ? '/owner' : '/store-manager'} replace />;
  if (roles?.length && !roles.includes(state.user.role)) {
    const destination = { OWNER: '/owner', STORE_MANAGER: '/store-manager', SUPERVISOR: '/supervisor', WORKER: '/worker', DISPATCH_OFFICER: '/dispatch', BUYER: '/customer' }[state.user.role] || '/login';
    return <Navigate to={destination} replace />;
  }
  return typeof children === 'function' ? children(state.user) : cloneElement(children, { user: state.user });
}
