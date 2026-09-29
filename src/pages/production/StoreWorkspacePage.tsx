import React, { useState, useEffect, useCallback } from 'react';
import { db, functions } from '../../firebase';
import { collection, getDocs, query, where, orderBy, limit } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { Warehouse, Loader2, AlertTriangle } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';

const ISSUE_REASONS = ['DAMAGE_IN_TRANSIT', 'SIZE_MISMATCH', 'QUALITY_REJECT', 'BILLING_DISPUTE', 'OTHER'];

export default function StoreWorkspacePage() {
  const { user } = useAuth();
  const effectiveRole = (user?.staffRole || '') as any;
  // 'production.store' = read-only view of the Store pipeline (includes pm,
  // per the Final V1 Role Matrix); the two .out* permissions are the actual
  // Store-Out / issue-report ACTIONS, strictly store-only (matching
  // storeOutCreate/storeOutReportIssue's server gate) — kept separate so a
  // viewer can never see an action the server would reject.
  const canView = can(effectiveRole, 'production.store');
  const canStoreOut = can(effectiveRole, 'production.store.out');
  const canReportIssue = can(effectiveRole, 'production.store.out.issue');

  const [pieces, setPieces] = useState<any[]>([]);
  const [recentStoreOuts, setRecentStoreOuts] = useState<any[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [billNumber, setBillNumber] = useState('');
  const [party, setParty] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issueForm, setIssueForm] = useState<{ storeOutId: string; pieceId: string } | null>(null);
  const [issueReason, setIssueReason] = useState('');
  const [issueOther, setIssueOther] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [storeSnap, outsSnap] = await Promise.all([
        getDocs(query(collection(db, 'pieces'), where('stage', '==', 'STORE'))),
        getDocs(query(collection(db, 'storeOuts'), orderBy('createdAt', 'desc'), limit(10))),
      ]);
      setPieces(storeSnap.docs.map((d) => d.data()));
      setRecentStoreOuts(outsSnap.docs.map((d) => d.data()));
    } catch (err: any) {
      console.error('Failed to load Store workspace:', err);
      setError(err?.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const selectedIds = Object.keys(selected).filter((id) => selected[id]);

  const createStoreOut = async () => {
    if (selectedIds.length === 0 || !billNumber.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await httpsCallable(functions, 'storeOutCreate')({
        pieceIds: selectedIds, billNumber: billNumber.trim(), party: party.trim() || undefined,
      });
      setSelected({});
      setBillNumber('');
      setParty('');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to create Store-Out.');
    } finally {
      setSubmitting(false);
    }
  };

  const submitIssue = async () => {
    if (!issueForm || !issueReason) return;
    if (issueReason === 'OTHER' && !issueOther.trim()) {
      setError('otherText is mandatory when reason is OTHER.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await httpsCallable(functions, 'storeOutReportIssue')({
        storeOutId: issueForm.storeOutId, pieceId: issueForm.pieceId,
        reason: issueReason, otherText: issueReason === 'OTHER' ? issueOther.trim() : undefined,
      });
      setIssueForm(null);
      setIssueReason('');
      setIssueOther('');
    } catch (err: any) {
      setError(err?.message || 'Failed to report issue.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!canView) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-gray-500">You do not have permission to access the Store workspace.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 md:p-8">
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-black text-white rounded-xl flex items-center justify-center">
            <Warehouse size={18} />
          </div>
          <div>
            <h1 className="text-2xl font-display text-black tracking-wide">Store Workspace</h1>
            <p className="text-xs text-gray-500 font-sans mt-1">
              {pieces.length} piece{pieces.length === 1 ? '' : 's'} in Store{loading && ' · loading…'}
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 text-red-600 text-xs">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : (
        <div className="space-y-8">
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-sm font-bold text-black uppercase tracking-widest">{canStoreOut ? 'Create Store-Out' : 'Pieces at Store'}</h2>
            </div>
            {pieces.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-sm text-gray-500">No pieces are currently at STORE.</p>
              </div>
            ) : canStoreOut ? (
              <>
                <div className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
                  {pieces.map((piece) => (
                    <label key={piece.id} className="flex items-center gap-3 px-6 py-3 cursor-pointer hover:bg-gray-50/60">
                      <input
                        type="checkbox"
                        checked={!!selected[piece.id]}
                        onChange={(e) => setSelected((s) => ({ ...s, [piece.id]: e.target.checked }))}
                      />
                      <span className="font-mono text-xs font-medium text-black">{piece.id}</span>
                      <span className="text-xs text-gray-400 font-mono">{piece.prId || '—'}</span>
                    </label>
                  ))}
                </div>
                <div className="px-6 py-4 border-t border-gray-100 flex flex-col md:flex-row gap-3 items-start md:items-center">
                  <input
                    type="text"
                    placeholder="Bill Number (mandatory)"
                    className="text-xs border border-gray-200 rounded-lg px-3 py-2 flex-1"
                    value={billNumber}
                    onChange={(e) => setBillNumber(e.target.value)}
                  />
                  <input
                    type="text"
                    placeholder="Party (optional)"
                    className="text-xs border border-gray-200 rounded-lg px-3 py-2 flex-1"
                    value={party}
                    onChange={(e) => setParty(e.target.value)}
                  />
                  <button
                    disabled={submitting || selectedIds.length === 0 || !billNumber.trim()}
                    onClick={createStoreOut}
                    className="px-4 py-2 bg-black text-white rounded-lg text-[10px] font-bold uppercase tracking-widest hover:opacity-80 transition-opacity disabled:opacity-30 whitespace-nowrap"
                  >
                    Store-Out {selectedIds.length > 0 ? `(${selectedIds.length})` : ''}
                  </button>
                </div>
              </>
            ) : (
              // View-only (e.g. pm): the piece list without the select/bill/submit
              // controls — Store-Out remains a store-only action server-side.
              <div className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
                {pieces.map((piece) => (
                  <div key={piece.id} className="flex items-center gap-3 px-6 py-3">
                    <span className="font-mono text-xs font-medium text-black">{piece.id}</span>
                    <span className="text-xs text-gray-400 font-mono">{piece.prId || '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-sm font-bold text-black uppercase tracking-widest">Recent Store-Outs</h2>
            </div>
            {recentStoreOuts.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-sm text-gray-500">No Store-Outs yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {recentStoreOuts.map((so) => (
                  <div key={so.id} className="px-6 py-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-xs font-medium text-black">{so.id}</span>
                      <span className="text-xs text-gray-400">Bill {so.billNumber}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(so.pieceIds || []).map((pid: string) => (
                        canReportIssue ? (
                          <button
                            key={pid}
                            onClick={() => setIssueForm({ storeOutId: so.id, pieceId: pid })}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-gray-200 rounded-md text-gray-600 hover:bg-gray-50"
                          >
                            <AlertTriangle size={10} /> {pid}
                          </button>
                        ) : (
                          <span
                            key={pid}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-gray-100 rounded-md text-gray-400"
                          >
                            {pid}
                          </span>
                        )
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {issueForm && (
            <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 space-y-3">
              <h3 className="text-sm font-bold text-black">Report Issue — {issueForm.pieceId}</h3>
              <select
                className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2"
                value={issueReason}
                onChange={(e) => setIssueReason(e.target.value)}
              >
                <option value="">Select reason…</option>
                {ISSUE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              {issueReason === 'OTHER' && (
                <input
                  type="text"
                  placeholder="Describe the issue (mandatory)"
                  className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2"
                  value={issueOther}
                  onChange={(e) => setIssueOther(e.target.value)}
                />
              )}
              <div className="flex gap-2">
                <button
                  disabled={submitting || !issueReason}
                  onClick={submitIssue}
                  className="px-4 py-2 bg-black text-white rounded-lg text-[10px] font-bold uppercase tracking-widest hover:opacity-80 transition-opacity disabled:opacity-30"
                >
                  Submit
                </button>
                <button
                  onClick={() => { setIssueForm(null); setIssueReason(''); setIssueOther(''); }}
                  className="px-4 py-2 border border-gray-200 rounded-lg text-[10px] font-bold uppercase tracking-widest text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
