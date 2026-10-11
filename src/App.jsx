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
import StoreManagerHandoffsPage from './pages/StoreManager/StoreManagerHandoffsPage';
import ReplacementMaterialRequests from './pages/StoreManager/ReplacementMaterialRequests';
import PurchaseWorkflow from './pages/StoreManager/PurchaseWorkflow';
import SupervisorWorkspacePage from './pages/supervisor/SupervisorWorkspacePage';
import WorkerWorkspacePage from './pages/worker/WorkerWorkspacePage';
import OwnerWorkspacePage from './pages/owner/OwnerWorkspacePage';
import DispatchWorkspacePage from './pages/dispatch/DispatchWorkspacePage';
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
      <Route path="inventory" element={<StoreManagerSection />} /><Route path="raw-materials" element={<StoreManagerSection />} /><Route path="suppliers" element={<StoreManagerSection />} /><Route path="purchase-orders" element={<StoreManagerSection />} /><Route path="procurement" element={<PurchaseWorkflow />} /><Route path="goods-receipts" element={<Navigate to="/store-manager/procurement" replace />} /><Route path="supplier-invoices" element={<Navigate to="/store-manager/procurement" replace />} /><Route path="supplier-payments" element={<Navigate to="/store-manager/procurement" replace />} /><Route path="material-planning" element={<Navigate to="/store-manager/supervisor-handoffs" replace />} /><Route path="supervisor-handoffs" element={<StoreManagerHandoffsPage />} /><Route path="rework-material-requests" element={<ReplacementMaterialRequests />} /><Route path="stock-movements" element={<StoreManagerSection />} />
      <Route path="*" element={<Navigate to="/store-manager" replace />} />
    </Route>
    <Route path="/owner" element={<InternalRoute roles={['OWNER']}><TexoraLayout /></InternalRoute>}>
      <Route index element={<OwnerWorkspacePage/>}/>
      <Route path="orders" element={<OwnerWorkspacePage section="orders"/>}/>
      <Route path="catalog" element={<OwnerWorkspacePage section="catalog"/>}/>
      <Route path="inventory" element={<OwnerWorkspacePage section="inventory"/>}/>
      <Route path="suppliers" element={<OwnerWorkspacePage section="suppliers"/>}/>
      <Route path="purchase-orders" element={<OwnerWorkspacePage section="purchase-orders"/>}/>
      <Route path="goods-receipts" element={<OwnerWorkspacePage section="goods-receipts"/>}/>
      <Route path="supplier-invoice-approvals" element={<OwnerWorkspacePage section="supplier-invoice-approvals"/>}/>
      <Route path="supplier-payments" element={<OwnerWorkspacePage section="supplier-payments"/>}/>
      <Route path="production" element={<OwnerWorkspacePage section="production"/>}/>
      <Route path="machines" element={<OwnerWorkspacePage section="machines"/>}/>
      <Route path="quality" element={<OwnerWorkspacePage section="quality"/>}/>
      <Route path="dispatch" element={<OwnerWorkspacePage section="dispatch"/>}/>
      <Route path="customer-invoices" element={<OwnerWorkspacePage section="customer-invoices"/>}/>
      <Route path="finance" element={<OwnerWorkspacePage section="finance"/>}/>
      <Route path="workforce" element={<OwnerWorkspacePage section="workforce"/>}/>
      <Route path="reports" element={<OwnerWorkspacePage section="reports"/>}/>
      <Route path="users" element={<OwnerWorkspacePage section="users"/>}/>
      <Route path="audit-log" element={<OwnerWorkspacePage section="audit-log"/>}/>
      <Route path="notifications" element={<OwnerWorkspacePage section="notifications"/>}/>
      <Route path="settings" element={<OwnerWorkspacePage section="settings"/>}/>
      <Route path="*" element={<Navigate to="/owner" replace/>}/>
    </Route>
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
    <Route path="/worker" element={<InternalRoute roles={['WORKER']}><TexoraLayout /></InternalRoute>}>
      <Route index element={<WorkerWorkspacePage view="dashboard"/>}/>
      <Route path="attendance" element={<WorkerWorkspacePage view="attendance"/>}/>
      <Route path="jobs" element={<WorkerWorkspacePage view="jobs"/>}/>
      <Route path="jobs/:jobId" element={<WorkerWorkspacePage view="job"/>}/>
      <Route path="machines" element={<WorkerWorkspacePage view="machines"/>}/>
      <Route path="production-logs" element={<WorkerWorkspacePage view="logs"/>}/>
      <Route path="profile" element={<WorkerWorkspacePage view="profile"/>}/>
      <Route path="*" element={<Navigate to="/worker" replace/>}/>
    </Route>
    <Route path="/dispatch" element={<InternalRoute roles={['DISPATCH_OFFICER']}><TexoraLayout /></InternalRoute>}>
      <Route index element={<DispatchWorkspacePage view="overview"/>}/>
      <Route path="queue" element={<DispatchWorkspacePage view="queue"/>}/>
      <Route path="queue/:orderId" element={<DispatchWorkspacePage view="order"/>}/>
      <Route path="packing" element={<Navigate to="/dispatch/shipments" replace/>}/>
      <Route path="shipments" element={<DispatchWorkspacePage view="shipments"/>}/>
      <Route path="shipments/:shipmentId" element={<DispatchWorkspacePage view="shipment"/>}/>
      <Route path="invoices" element={<DispatchWorkspacePage view="invoices"/>}/>
      <Route path="invoices/:invoiceId" element={<DispatchWorkspacePage view="invoice"/>}/>
      <Route path="delivery-tracking" element={<DispatchWorkspacePage view="tracking"/>}/>
      <Route path="reports" element={<DispatchWorkspacePage view="reports"/>}/>
      <Route path="notifications" element={<DispatchWorkspacePage view="notifications"/>}/>
      <Route path="profile" element={<DispatchWorkspacePage view="profile"/>}/>
      <Route path="*" element={<Navigate to="/dispatch" replace/>}/>
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></BrowserRouter>;
}
