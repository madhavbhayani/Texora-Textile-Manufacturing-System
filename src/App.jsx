import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Login from './pages/auth/login';
import Signup from './pages/auth/signup';
import CustomerPage from './pages/customer/CustomerPage';
import Cart from './pages/customer/Customer_Orders/Cart';
import CustomerAccount from './pages/customer/CustomerAccount';
import TexoraLayout from './layout/TexoraLayout';
import InternalRoute from './layout/InternalRoute';
import ChangePassword from './pages/auth/ChangePassword';
import StoreManagerDashboard from './pages/StoreManager/StoreManagerDashboard';
import StoreManagerSection from './pages/StoreManager/StoreManagerSection';
import InternalWorkspacePage from './pages/StoreManager/InternalWorkspacePage';
import StoreManagerHandoffsPage from './pages/StoreManager/StoreManagerHandoffsPage';
import PurchaseWorkflow from './pages/StoreManager/PurchaseWorkflow';
import SupervisorWorkspacePage from './pages/supervisor/SupervisorWorkspacePage';
import './App.css';
import './pages/auth/auth.css';

export default function App() {
  return <BrowserRouter><Routes>
    <Route path="/" element={<Login />} />
    <Route path="/login" element={<Login />} />
    <Route path="/signup" element={<Signup />} />
    <Route path="/customer" element={<CustomerPage />} />
    <Route path="/customer/cart" element={<Cart />} />
    <Route path="/customer/account" element={<CustomerAccount />} />
    <Route path="/change-password" element={<InternalRoute roles={['OWNER','STORE_MANAGER','SUPERVISOR','WORKER','DISPATCH_OFFICER']}><ChangePassword /></InternalRoute>} />
    <Route path="/store-manager" element={<InternalRoute roles={['STORE_MANAGER','OWNER']}><TexoraLayout /></InternalRoute>}>
      <Route index element={<StoreManagerDashboard />} />
      <Route path="inventory" element={<StoreManagerSection />} /><Route path="raw-materials" element={<StoreManagerSection />} /><Route path="suppliers" element={<StoreManagerSection />} /><Route path="purchase-orders" element={<StoreManagerSection />} /><Route path="procurement" element={<PurchaseWorkflow />} /><Route path="goods-receipts" element={<Navigate to="/store-manager/procurement" replace />} /><Route path="supplier-invoices" element={<Navigate to="/store-manager/procurement" replace />} /><Route path="supplier-payments" element={<Navigate to="/store-manager/procurement" replace />} /><Route path="material-planning" element={<Navigate to="/store-manager/supervisor-handoffs" replace />} /><Route path="supervisor-handoffs" element={<StoreManagerHandoffsPage />} /><Route path="stock-movements" element={<StoreManagerSection />} />
      <Route path="*" element={<Navigate to="/store-manager" replace />} />
    </Route>
    <Route path="/owner" element={<InternalRoute roles={['OWNER']}><TexoraLayout /></InternalRoute>}><Route index element={<InternalWorkspacePage />} /></Route>
    <Route path="/supervisor" element={<InternalRoute roles={['SUPERVISOR']}><TexoraLayout /></InternalRoute>}>
      <Route index element={<SupervisorWorkspacePage view="dashboard"/>}/>
      <Route path="handoffs" element={<SupervisorWorkspacePage view="handoffs"/>}/>
      <Route path="jobs" element={<SupervisorWorkspacePage view="jobs"/>}/>
      <Route path="jobs/:jobId" element={<SupervisorWorkspacePage view="job"/>}/>
      <Route path="machines" element={<SupervisorWorkspacePage view="machines"/>}/>
      <Route path="workers" element={<SupervisorWorkspacePage view="workers"/>}/>
      <Route path="production-logs" element={<SupervisorWorkspacePage view="logs"/>}/>
      <Route path="rolls" element={<SupervisorWorkspacePage view="rolls"/>}/>
      <Route path="quality" element={<SupervisorWorkspacePage view="quality"/>}/>
      <Route path="rework" element={<SupervisorWorkspacePage view="rework"/>}/>
      <Route path="rejected" element={<SupervisorWorkspacePage view="rejected"/>}/>
      <Route path="breakdowns" element={<Navigate to="/supervisor/machines" replace/>}/>
      <Route path="reports" element={<SupervisorWorkspacePage view="reports"/>}/>
      <Route path="*" element={<Navigate to="/supervisor" replace/>}/>
    </Route>
    <Route path="/worker" element={<InternalRoute roles={['WORKER']}><TexoraLayout /></InternalRoute>}><Route index element={<InternalWorkspacePage />} /></Route>
    <Route path="/dispatch" element={<InternalRoute roles={['DISPATCH_OFFICER']}><TexoraLayout /></InternalRoute>}><Route index element={<InternalWorkspacePage />} /></Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></BrowserRouter>;
}
