import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { db, functions } from '../../firebase';
import { doc, getDoc, collection, query, where, orderBy, getDocs } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { ArrowLeft, Loader2, Layers, ArrowDownCircle, ArrowUpCircle, Ban } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { can, type Role } from '../../utils/rolePermissions';
import type { FabricMasterDoc, FabricLedgerEntryDoc } from '../../types/production';

export default function FabricDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const effectiveRole = (user?.staffRole || user?.role || '') as Role;
  const canWrite = can(effectiveRole, 'production.fabric.write');

  const [fabric, setFabric] = useState<FabricMasterDoc | null>(null);
  const [ledger, setLedger] = useState<FabricLedgerEntryDoc[]>([]);
  const [loading, setLoading] = useState(true);

  const [receiveQty, setReceiveQty] = useState<number>(0);
  const [receiveSupplier, setReceiveSupplier] = useState('');
  const [receiveNotes, setReceiveNotes] = useState('');
  const [receiveBusy, setReceiveBusy] = useState(false);
  const [receiveNotice, setReceiveNotice] = useState('');

  const [issuePrId, setIssuePrId] = useState('');
  const [issueQty, setIssueQty] = useState<number>(0);
  const [issueReason, setIssueReason] = useState('');
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueNotice, setIssueNotice] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const snap = await getDoc(doc(db, 'fabricMasters', id));
      setFabric(snap.exists() ? (snap.data() as FabricMasterDoc) : null);

      const ledgerSnap = await getDocs(
        query(collection(db, 'fabricLedger'), where('fabricId', '==', id), orderBy('at', 'desc'))
      );
      setLedger(ledgerSnap.docs.map(d => d.data() as FabricLedgerEntryDoc));
    } catch (err) {
      console.error('Failed to load fabric:', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const handleReceive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || receiveBusy || !receiveQty || receiveQty <= 0) return;
    setReceiveBusy(true);
    setReceiveNotice('');
    try {
      await httpsCallable(functions, 'fabricStockReceive')({
        fabricId: id,
        qtyMeters: receiveQty,
        supplier: receiveSupplier.trim() || undefined,
        notes: receiveNotes.trim() || undefined,
      });
      setReceiveQty(0);
      setReceiveSupplier('');
      setReceiveNotes('');
      await load();
    } catch (err: any) {
      setReceiveNotice(err?.message || 'Receipt failed.');
    } finally {
      setReceiveBusy(false);
    }
  };

  const handleIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || issueBusy || !issuePrId.trim() || !issueQty || issueQty <= 0) return;
    setIssueBusy(true);
    setIssueNotice('');
    try {
      await httpsCallable(functions, 'fabricStockIssue')({
        fabricId: id,
        prId: issuePrId.trim(),
        qtyMeters: issueQty,
        reason: issueReason.trim() || undefined,
      });
      setIssuePrId('');
      setIssueQty(0);
      setIssueReason('');
      await load();
    } catch (err: any) {
      setIssueNotice(err?.message || 'Issue failed.');
    } finally {
      setIssueBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!fabric) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-gray-500">Fabric not found.</p>
        <button onClick={() => navigate('/production/fabric')} className="mt-4 text-sm text-black underline">
          Back to Fabric Inventory
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 md:p-8 max-w-4xl">
      <button
        onClick={() => navigate('/production/fabric')}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-black transition-colors mb-6"
      >
        <ArrowLeft size={16} />
        Back to Fabric Inventory
      </button>

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          {fabric.colourCode && (
            <span className="w-8 h-8 rounded-full border border-gray-200" style={{ backgroundColor: fabric.colourCode }} />
          )}
          <div>
            <h1 className="text-2xl font-display text-black tracking-wide">{fabric.name}</h1>
            <p className="text-xs text-gray-500 font-mono">{fabric.id} · {fabric.colour} · {fabric.gsm} GSM</p>
          </div>
        </div>
        <span className={`inline-flex items-center px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md ${
          fabric.active ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'
        }`}>
          {fabric.active ? 'Active' : 'Inactive'}
        </span>
      </div>

      <div className="bg-black text-white p-6 rounded-2xl shadow-xl mb-6">
        <p className="text-[10px] font-bold uppercase tracking-widest text-white/60 mb-2">Current Stock</p>
        <p className="text-4xl font-display">{fabric.stockQtyMeters.toFixed(2)} m</p>
      </div>

      {canWrite && fabric.active && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <form onSubmit={handleReceive} className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 space-y-4">
            <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 flex items-center gap-2">
              <ArrowDownCircle size={14} className="text-emerald-500" /> Receive Stock
            </h2>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Quantity (m) *</label>
              <input type="number" required min={0.01} step={0.01} value={receiveQty || ''} onChange={e => setReceiveQty(Number(e.target.value))}
                className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Supplier (optional)</label>
              <input type="text" value={receiveSupplier} onChange={e => setReceiveSupplier(e.target.value)}
                className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Notes (optional)</label>
              <input type="text" value={receiveNotes} onChange={e => setReceiveNotes(e.target.value)}
                className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
            </div>
            {receiveNotice && <p className="text-xs text-red-500">{receiveNotice}</p>}
            <button type="submit" disabled={receiveBusy || !receiveQty || receiveQty <= 0}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors">
              {receiveBusy ? <Loader2 size={14} className="animate-spin" /> : <ArrowDownCircle size={14} />}
              {receiveBusy ? 'Receiving…' : 'Receive Stock'}
            </button>
          </form>

          <form onSubmit={handleIssue} className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 space-y-4">
            <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 flex items-center gap-2">
              <ArrowUpCircle size={14} className="text-amber-500" /> Issue to Production Request
            </h2>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">PR ID *</label>
              <input type="text" required placeholder="PR-0001" value={issuePrId} onChange={e => setIssuePrId(e.target.value)}
                className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Quantity (m) *</label>
              <input type="number" required min={0.01} step={0.01} max={fabric.stockQtyMeters} value={issueQty || ''} onChange={e => setIssueQty(Number(e.target.value))}
                className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
              <p className="text-[10px] text-gray-400 mt-1">Available: {fabric.stockQtyMeters.toFixed(2)}m</p>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Reason (optional)</label>
              <input type="text" value={issueReason} onChange={e => setIssueReason(e.target.value)}
                className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
            </div>
            {issueNotice && <p className="text-xs text-red-500">{issueNotice}</p>}
            <button type="submit" disabled={issueBusy || !issuePrId.trim() || !issueQty || issueQty <= 0 || issueQty > fabric.stockQtyMeters}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-600 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors">
              {issueBusy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUpCircle size={14} />}
              {issueBusy ? 'Issuing…' : 'Issue Stock'}
            </button>
          </form>
        </div>
      )}

      {canWrite && !fabric.active && (
        <div className="flex items-center gap-2 text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-xl p-4 mb-6">
          <Ban size={14} />
          This fabric is inactive — receive/issue is disabled.
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6">
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
          <Layers size={14} /> Ledger History
        </h2>
        {ledger.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-8">No stock movements yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-4 py-3">When</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-4 py-3">Type</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-4 py-3">Qty (m)</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-4 py-3">Balance After</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-4 py-3">PR</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-4 py-3">By</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map(entry => (
                  <tr key={entry.id} className="border-b border-gray-50">
                    <td className="px-4 py-3 text-xs text-gray-500">{new Date(entry.at).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded ${
                        entry.type === 'RECEIPT' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                      }`}>
                        {entry.type === 'RECEIPT' ? <ArrowDownCircle size={10} /> : <ArrowUpCircle size={10} />}
                        {entry.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-black">
                      {entry.type === 'RECEIPT' ? '+' : '-'}{entry.qtyMeters.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-gray-600">{entry.balanceAfterMeters.toFixed(2)}</td>
                    <td className="px-4 py-3 text-xs font-mono text-gray-500">{entry.relatedPrId || '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{entry.actorName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
