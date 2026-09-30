import React, { useState, useEffect, useCallback } from 'react';
import { db, functions } from '../../firebase';
import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { UserCheck, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-600',
  APPROVED: 'bg-emerald-50 text-emerald-600',
  REJECTED: 'bg-red-50 text-red-500',
};

export default function TailorRequestReviewPage() {
  const { user } = useAuth();
  const effectiveRole = (user?.staffRole || '') as any;
  const canReview = can(effectiveRole, 'production.tailorRequests.review');

  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snap = await getDocs(query(collection(db, 'tailorRequests'), orderBy('requestedAt', 'desc')));
      setRequests(snap.docs.map((d) => d.data()));
    } catch (err: any) {
      console.error('Failed to load Tailor requests:', err);
      setError(err?.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (canReview) load(); }, [load, canReview]);

  const approve = async (requestId: string) => {
    setBusyId(requestId);
    setError(null);
    try {
      await httpsCallable(functions, 'approveTailorRequest')({ requestId });
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to approve request.');
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (requestId: string) => {
    if (!rejectReason.trim()) return;
    setBusyId(requestId);
    setError(null);
    try {
      await httpsCallable(functions, 'rejectTailorRequest')({ requestId, rejectionReason: rejectReason.trim() });
      setRejectingId(null);
      setRejectReason('');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to reject request.');
    } finally {
      setBusyId(null);
    }
  };

  if (!canReview) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-gray-500">You do not have permission to review Tailor requests.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 md:p-8">
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-black text-white rounded-xl flex items-center justify-center">
            <UserCheck size={18} />
          </div>
          <div>
            <h1 className="text-2xl font-display text-black tracking-wide">New Tailor Requests</h1>
            <p className="text-xs text-gray-500 font-sans mt-1">
              {requests.length} request{requests.length === 1 ? '' : 's'}{loading && ' · loading…'}
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
      ) : requests.length === 0 ? (
        <div className="text-center py-24">
          <UserCheck size={32} className="mx-auto text-gray-300 mb-3" />
          <p className="text-sm text-gray-500">No Tailor requests yet.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm divide-y divide-gray-100">
          {requests.map((r) => (
            <div key={r.id} className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <div>
                  <span className="text-sm font-medium text-black">{r.name}</span>
                  <span className="ml-2 text-xs text-gray-400">{r.email}</span>
                </div>
                <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest rounded-md ${STATUS_COLORS[r.status] || 'bg-gray-100 text-gray-500'}`}>
                  {r.status}
                </span>
              </div>
              <p className="text-xs text-gray-600 mb-2">{r.reason}</p>
              <p className="text-[11px] text-gray-400 mb-3">
                Requested by {r.requestedByName || r.requestedByUid} · {r.requestedAt ? new Date(r.requestedAt).toLocaleString() : '—'}
              </p>
              {r.status === 'REJECTED' && r.rejectionReason && (
                <p className="text-[11px] text-red-500 mb-3">Rejection reason: {r.rejectionReason}</p>
              )}
              {r.status === 'APPROVED' && r.createdTailorUid && (
                <p className="text-[11px] text-emerald-600 mb-3">Tailor account created: {r.createdTailorUid}</p>
              )}

              {r.status === 'PENDING' && (
                <div className="flex flex-col gap-2">
                  {rejectingId === r.id ? (
                    <div className="flex flex-col md:flex-row gap-2">
                      <input
                        type="text"
                        placeholder="Rejection reason (mandatory)"
                        className="text-xs border border-gray-200 rounded-lg px-3 py-2 flex-1"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                      />
                      <button
                        disabled={busyId === r.id || !rejectReason.trim()}
                        onClick={() => reject(r.id)}
                        className="px-4 py-2 bg-red-600 text-white rounded-lg text-[10px] font-bold uppercase tracking-widest hover:opacity-80 transition-opacity disabled:opacity-30"
                      >
                        Confirm Reject
                      </button>
                      <button
                        onClick={() => { setRejectingId(null); setRejectReason(''); }}
                        className="px-4 py-2 border border-gray-200 rounded-lg text-[10px] font-bold uppercase tracking-widest text-gray-600 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        disabled={busyId === r.id}
                        onClick={() => approve(r.id)}
                        className="px-4 py-2 bg-black text-white rounded-lg text-[10px] font-bold uppercase tracking-widest hover:opacity-80 transition-opacity disabled:opacity-30"
                      >
                        Approve
                      </button>
                      <button
                        disabled={busyId === r.id}
                        onClick={() => setRejectingId(r.id)}
                        className="px-4 py-2 border border-gray-200 rounded-lg text-[10px] font-bold uppercase tracking-widest text-gray-600 hover:bg-gray-50"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
