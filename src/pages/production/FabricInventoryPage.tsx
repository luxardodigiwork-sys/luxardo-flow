import React, { useCallback, useEffect, useState } from 'react';
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { AlertTriangle, Layers, Loader2, Plus, PackagePlus, X } from 'lucide-react';
import { db, functions } from '../../firebase';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';

/**
 * Fabric Inventory (V1). Stock in meters. Dispatch/Owner/Admin add fabrics
 * and stock-in; everyone allowed by 'production.fabric' can view stock.
 * Low-stock fabrics and unresolved alerts are shown at the top for
 * Dispatch/Owner.
 */
const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20';
const btnCls = 'inline-flex items-center gap-2 px-4 py-2 bg-black text-white text-[10px] font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-40';

export default function FabricInventoryPage() {
  const { user } = useAuth();
  const role = (user?.staffRole || '') as any;
  const canView = can(role, 'production.fabric');
  const canManage = can(role, 'production.fabric.manage');

  const [fabrics, setFabrics] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [ledger, setLedger] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', colour: '', gsm: '', lowStockMeters: '', openingMeters: '' });
  const [stockInFor, setStockInFor] = useState<string | null>(null);
  const [stockIn, setStockIn] = useState({ meters: '', supplier: '', billNumber: '' });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const fSnap = await getDocs(query(collection(db, 'fabricMasters'), orderBy('name')));
      setFabrics(fSnap.docs.map(d => d.data()));
      if (canManage) {
        const [aSnap, lSnap] = await Promise.all([
          getDocs(query(collection(db, 'fabricAlerts'), where('resolved', '==', false))),
          getDocs(query(collection(db, 'fabricLedger'), orderBy('createdAt', 'desc'), limit(30))),
        ]);
        setAlerts(aSnap.docs.map(d => d.data()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
        setLedger(lSnap.docs.map(d => d.data()));
      }
    } catch (err: any) {
      console.error('Failed to load fabric inventory:', err);
      setError(err?.message || 'Failed to load fabric inventory.');
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => { if (canView) load(); }, [canView, load]);

  const call = async (name: string, data: any, okMsg: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await httpsCallable(functions, name)(data);
      setNotice(okMsg);
      await load();
      return true;
    } catch (err: any) {
      setError(err?.message || 'Action failed.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addFabric = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await call('fabricCreate', {
      name: form.name,
      colour: form.colour,
      gsm: form.gsm ? Number(form.gsm) : undefined,
      lowStockMeters: Number(form.lowStockMeters || 0),
      openingMeters: Number(form.openingMeters || 0),
    }, `Fabric "${form.name}" added.`);
    if (ok) { setForm({ name: '', colour: '', gsm: '', lowStockMeters: '', openingMeters: '' }); setShowAdd(false); }
  };

  const doStockIn = async (fabricId: string) => {
    const ok = await call('fabricStockIn', { fabricId, meters: Number(stockIn.meters), supplier: stockIn.supplier, billNumber: stockIn.billNumber },
      `${stockIn.meters} m added to stock.`);
    if (ok) { setStockIn({ meters: '', supplier: '', billNumber: '' }); setStockInFor(null); }
  };

  if (!canView) {
    return <div className="text-center py-20"><p className="text-sm text-gray-500">You do not have permission to view fabric inventory.</p></div>;
  }

  const lowFabrics = fabrics.filter(f => f.active !== false && f.lowStock);

  return (
    <div className="min-h-screen p-6 md:p-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-black text-white rounded-xl flex items-center justify-center"><Layers size={18} /></div>
          <div>
            <h1 className="text-2xl font-display text-black tracking-wide">Fabric Inventory</h1>
            <p className="text-xs text-gray-500 mt-1">Stock in meters{loading && ' · loading…'}</p>
          </div>
        </div>
        {canManage && (
          <button onClick={() => setShowAdd(v => !v)} className={btnCls}>
            {showAdd ? <X size={14} /> : <Plus size={14} />} {showAdd ? 'Close' : 'Add fabric'}
          </button>
        )}
      </div>

      {error && <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 text-red-600 text-xs">{error}</div>}
      {notice && <div className="mb-4 px-4 py-3 rounded-lg bg-green-50 text-green-700 text-xs">{notice}</div>}

      {canManage && lowFabrics.length > 0 && (
        <div className="mb-6 p-4 rounded-2xl border border-amber-200 bg-amber-50" data-testid="low-stock-banner">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-amber-800"><AlertTriangle size={14} /> Low stock</p>
          <ul className="mt-2 space-y-1">
            {lowFabrics.map(f => (
              <li key={f.id} className="text-sm text-amber-900">{f.name}: <b>{f.stockMeters} m</b> left (alert at {f.lowStockMeters} m)</li>
            ))}
          </ul>
          {alerts.length > 0 && (
            <div className="mt-3 space-y-1">
              {alerts.map(a => (
                <div key={a.id} className="flex items-center justify-between gap-3 text-xs text-amber-800">
                  <span>{new Date(a.createdAt).toLocaleString()} — {a.message}</span>
                  <button disabled={busy} onClick={() => call('fabricAlertResolve', { alertId: a.id }, 'Alert marked as seen.')}
                    className="underline disabled:opacity-40">Mark seen</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {canManage && showAdd && (
        <form onSubmit={addFabric} className="mb-6 bg-white border border-gray-200 rounded-2xl p-5 grid grid-cols-1 md:grid-cols-5 gap-3">
          <input className={inputCls} placeholder="Fabric name *" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
          <input className={inputCls} placeholder="Colour" value={form.colour} onChange={e => setForm({ ...form, colour: e.target.value })} />
          <input className={inputCls} placeholder="GSM" inputMode="numeric" value={form.gsm} onChange={e => setForm({ ...form, gsm: e.target.value })} />
          <input className={inputCls} placeholder="Low-stock alert at (m) *" inputMode="decimal" value={form.lowStockMeters} onChange={e => setForm({ ...form, lowStockMeters: e.target.value })} required />
          <input className={inputCls} placeholder="Opening stock (m)" inputMode="decimal" value={form.openingMeters} onChange={e => setForm({ ...form, openingMeters: e.target.value })} />
          <div className="md:col-span-5 flex justify-end">
            <button type="submit" disabled={busy || !form.name.trim()} className={btnCls}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Save fabric</button>
          </div>
        </form>
      )}

      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-widest text-gray-400 border-b border-gray-100">
              <th className="px-4 py-3">Fabric</th><th className="px-4 py-3">Colour</th>
              <th className="px-4 py-3 text-right">Stock (m)</th><th className="px-4 py-3 text-right">Alert at (m)</th>
              <th className="px-4 py-3">Status</th>{canManage && <th className="px-4 py-3" />}
            </tr>
          </thead>
          <tbody>
            {fabrics.length === 0 && !loading && (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">No fabrics yet.{canManage && ' Use “Add fabric” to start.'}</td></tr>
            )}
            {fabrics.map(f => (
              <React.Fragment key={f.id}>
                <tr className="border-b border-gray-50" data-testid={`fabric-row-${f.id}`}>
                  <td className="px-4 py-3"><span className="font-medium">{f.name}</span><span className="block text-[10px] text-gray-400 font-mono">{f.id}</span></td>
                  <td className="px-4 py-3 text-gray-600">{f.colour || '—'}</td>
                  <td className="px-4 py-3 text-right font-mono">{Number(f.stockMeters).toFixed(2)}</td>
                  <td className="px-4 py-3 text-right font-mono text-gray-500">{Number(f.lowStockMeters).toFixed(2)}</td>
                  <td className="px-4 py-3">
                    {f.active === false ? <span className="text-[10px] font-bold uppercase text-gray-400">Inactive</span>
                      : f.lowStock ? <span className="text-[10px] font-bold uppercase text-amber-700 bg-amber-50 px-2 py-0.5 rounded">Low stock</span>
                      : <span className="text-[10px] font-bold uppercase text-green-700 bg-green-50 px-2 py-0.5 rounded">OK</span>}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => { setStockInFor(stockInFor === f.id ? null : f.id); setStockIn({ meters: '', supplier: '', billNumber: '' }); }}
                        className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-black underline">
                        <PackagePlus size={12} /> Stock in
                      </button>
                    </td>
                  )}
                </tr>
                {canManage && stockInFor === f.id && (
                  <tr className="bg-gray-50">
                    <td colSpan={6} className="px-4 py-3">
                      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                        <input className={inputCls} placeholder="Meters received *" inputMode="decimal" value={stockIn.meters} onChange={e => setStockIn({ ...stockIn, meters: e.target.value })} />
                        <input className={inputCls} placeholder="Supplier" value={stockIn.supplier} onChange={e => setStockIn({ ...stockIn, supplier: e.target.value })} />
                        <input className={inputCls} placeholder="Bill number" value={stockIn.billNumber} onChange={e => setStockIn({ ...stockIn, billNumber: e.target.value })} />
                        <button disabled={busy || !(Number(stockIn.meters) > 0)} onClick={() => doStockIn(f.id)} className={btnCls}>
                          {busy ? <Loader2 size={14} className="animate-spin" /> : <PackagePlus size={14} />} Add to stock
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && ledger.length > 0 && (
        <div className="mt-8 bg-white border border-gray-200 rounded-2xl shadow-sm p-5">
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-3">Recent stock movements</h2>
          <div className="space-y-1">
            {ledger.map(l => (
              <div key={l.id} className="flex flex-wrap justify-between gap-2 text-xs border-b border-gray-50 py-1.5">
                <span><span className={l.meters >= 0 ? 'text-green-700 font-bold' : 'text-red-600 font-bold'}>{l.meters >= 0 ? '+' : ''}{l.meters} m</span> · {l.fabricName} · {l.type === 'IN' ? (l.supplier ? `from ${l.supplier}` : 'stock in') : (l.note || 'issued')}</span>
                <span className="text-gray-400">balance {l.balanceAfter} m · {l.actorName} · {new Date(l.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
