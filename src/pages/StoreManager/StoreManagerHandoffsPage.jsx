import { useCallback, useEffect, useState } from 'react';
import { Check, LoaderCircle, RefreshCw } from 'lucide-react';
import { authenticatedRequest } from '../../config/auth';
import { Table } from './StoreManagerDashboard';
import './storeManager.css';

const moneyKg = (value) => `${Number(value || 0).toFixed(3)} kg`;

export default function StoreManagerHandoffsPage() {
  const [orders, setOrders] = useState([]);
  const [supervisors, setSupervisors] = useState([]);
  const [handoffs, setHandoffs] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [supervisorId, setSupervisorId] = useState('');
  const [stage, setStage] = useState('WEAVING');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [issuingId, setIssuingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [hasMore, setHasMore] = useState({orders:false,handoffs:false});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({limit:'20',offset:String(offset)}); if(search.trim()) query.set('search',search.trim());
      const [o, s, h] = await Promise.all([
        authenticatedRequest(`/store-manager/supervisor-handoffs/orders?${query}`),
        authenticatedRequest('/store-manager/supervisors'),
        authenticatedRequest(`/store-manager/supervisor-handoffs?${query}`),
      ]);
      setOrders(o.orders || []);
      setSupervisors(s.supervisors || []);
      setHandoffs(h.handoffs || []);
      setHasMore({orders:(o.orders||[]).length===20,handoffs:(h.handoffs||[]).length===20});
    } catch (e) {
      setError(e.message || 'Could not load customer orders and handoffs.');
    } finally {
      setLoading(false);
    }
  }, [offset,search]);

  useEffect(() => { load(); }, [load]);

  const selected = orders.find((order) => String(order.order_item_id) === selectedId);

  const create = async (supervisorUserId) => {
    if (!selected || !supervisorUserId || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await authenticatedRequest('/store-manager/supervisor-handoffs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderItemId: selected.order_item_id,
          supervisorUserId,
          plannedMeters: Number(selected.quantity_m) - Number(selected.planned_meters),
          stage,
          notes,
        }),
      });
      setNotice(`${response.handoff.handoff_no} created and sent to the Supervisor as pending.`);
      setSelectedId('');
      setSupervisorId('');
      setNotes('');
      await load();
    } catch (e) {
      setError(e.message || 'Could not create the handoff.');
    } finally {
      setSaving(false);
    }
  };

  const issueMaterials = async (row) => {
    if (saving || issuingId) return;
    setIssuingId(row.handoff_id);
    setError('');
    setNotice('');
    try {
      const response = await authenticatedRequest(`/store-manager/supervisor-handoffs/${row.handoff_id}/issue-materials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const issueNo = response?.issue?.issue_no;
      setNotice(`Materials successfully issued for ${row.handoff_no}${row.job_no ? ` (${row.job_no})` : ''}.${issueNo ? ` Material issue slip ${issueNo} recorded.` : ''}`);
      await load();
    } catch (e) {
      setError(e.message || `Failed to issue materials for ${row.handoff_no}.`);
    } finally {
      setIssuingId('');
    }
  };

  const columns = [
    ['handoff_no', 'Handoff'],
    ['job_no', 'Production job', (row) => row.job_no ? <strong>{row.job_no}</strong> : <span className="sm-muted">—</span>],
    ['order_no', 'Customer order'],
    ['company_name', 'Buyer'],
    ['fabric_name', 'Product', (row) => row.colour_name ? `${row.fabric_name} (${row.colour_name})` : row.fabric_name],
    ['planned_meters', 'Metres', (row) => `${Number(row.planned_meters || 0).toLocaleString('en-IN')} m`],
    ['supervisor_name', 'Supervisor'],
    ['stage', 'Stage'],
    ['status', 'Status', (row) => (
      <span className={`sm-status sm-status-${(row.status || '').toLowerCase()}`}>
        {row.status === 'REQUESTED' ? 'Pending' :
         row.status === 'ON_HOLD' ? 'On hold for material' :
         row.status === 'ACCEPTED' ? 'Approved' :
         row.status === 'JOB_CREATED' ? 'Job created' :
         row.status === 'ISSUED' ? 'Materials issued' :
         (row.status || '').replaceAll('_', ' ')}
      </span>
    )],
    ['actions', 'Actions', (row) => (
      <div className="sm-row-actions">
        {row.status === 'JOB_CREATED' && (
          <button
            type="button"
            className="admin-button"
            disabled={Boolean(saving || issuingId)}
            onClick={() => issueMaterials(row)}
          >
            {issuingId === row.handoff_id ? 'Issuing...' : 'Issue materials'}
          </button>
        )}
        {row.status === 'ISSUED' && (
          <span className="sm-tag">Issued</span>
        )}
        {['REQUESTED', 'ON_HOLD', 'ACCEPTED'].includes(row.status) && (
          <span className="sm-muted">—</span>
        )}
      </div>
    )],
  ];

  return (
    <section className="admin-page">
      <header className="admin-page-heading">
        <div>
          <h1>Supervisor handoffs</h1>
          <p>Choose a placed customer order, route production work to a Supervisor, and issue reserved materials.</p>
        </div>
        <button type="button" className="admin-button secondary" onClick={load} disabled={loading}>
          <RefreshCw size={14} /> Refresh
        </button>
      </header>
      {error && <div className="admin-alert" role="alert">{error}</div>}
      {notice && <div className="sm-notice" role="status"><Check size={14} /> {notice}</div>}
      <div className="admin-toolbar sm-handoff-list-toolbar"><input value={search} onChange={event=>{setOffset(0);setSearch(event.target.value);}} placeholder="Search customer orders and handoffs" aria-label="Search customer orders and handoffs"/><div className="admin-pager"><button className="admin-button secondary" type="button" disabled={offset===0||loading} onClick={()=>setOffset(Math.max(0,offset-20))}>Previous</button><span>{offset+1}–{Math.max(offset+orders.length,offset+handoffs.length)} shown</span><button className="admin-button secondary" type="button" disabled={!(hasMore.orders||hasMore.handoffs)||loading} onClick={()=>setOffset(offset+20)}>Next</button></div></div>
      <section className="admin-card sm-form-card">
        <h2>Route customer order</h2>
        {loading ? (
          <div className="admin-state"><LoaderCircle size={18} /> Loading customer orders...</div>
        ) : (
          <div className="sm-route-form">
            <label className="sm-route-order-field">
              Customer order
              <select required value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                <option value="">Select an order and product</option>
                {orders.map((order) => (
                  <option value={order.order_item_id} key={order.order_item_id}>
                    {order.order_no} | {order.company_name} | {order.fabric_name} | {order.colour_name || 'Standard'} | {Number(order.quantity_m) - Number(order.planned_meters)} m remaining
                  </option>
                ))}
              </select>
            </label>
            {selected && (
              <>
                <div className="sm-material-review">
                  <strong>{selected.fabric_name} | {selected.colour_name || 'Standard'}</strong>
                  <span>{selected.order_no} | {selected.company_name}</span>
                  <span>Order quantity: {selected.quantity_m} m | Already planned: {selected.planned_meters} m</span>
                  <h3>Material requirement for remaining order quantity</h3>
                  {(selected.materials || []).map((material) => (
                    <div className="sm-material-line" key={material.yarn_type_id}>
                      <span>{material.yarn_name}</span>
                      <span>
                        Need {moneyKg(material.required_kg)} | Available {moneyKg(material.available_kg)} | Short {moneyKg(Math.max(0, Number(material.required_kg) - Number(material.available_kg)))}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="sm-route-fields">
                  <label>
                    Production stage
                    <select value={stage} onChange={(e) => setStage(e.target.value)}>
                      <option>WEAVING</option>
                      <option>SPINNING</option>
                      <option>DYEING</option>
                    </select>
                  </label>
                  <label>
                    Notes
                    <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
                  </label>
                  <label>
                    Assign Supervisor
                    <select
                      required
                      value={supervisorId}
                      disabled={saving}
                      onChange={(e) => {
                        setSupervisorId(e.target.value);
                        create(e.target.value);
                      }}
                    >
                      <option value="">Select Supervisor to send pending handoff</option>
                      {supervisors.map((person) => (
                        <option value={person.user_id} key={person.user_id}>
                          {person.full_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {saving && <p className="sm-muted">Sending handoff...</p>}
                </div>
              </>
            )}
            {orders.length === 0 && <p className="admin-state">No eligible customer orders are available for production handoff.</p>}
          </div>
        )}
      </section>
      <section className="admin-card sm-content">
        <h2>Handoff requests</h2>
        {loading ? (
          <div className="admin-state">Loading...</div>
        ) : (
          <Table columns={columns} rows={handoffs} empty="No handoffs have been created." />
        )}
      </section>
    </section>
  );
}
