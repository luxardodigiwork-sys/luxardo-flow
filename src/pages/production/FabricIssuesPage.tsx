import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { CheckCircle2, Loader2, PackageCheck } from 'lucide-react';
import { db, functions } from '../../firebase';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';

/**
 * Fabric Issues. A Guard sees the fabric issued to them and confirms
 * receipt; Dispatch/Owner/PM see every issue.
 */
export default function FabricIssuesPage() {
  const { user } = useAuth();
  const role = (user?.staffRole || '') as any;
  const canView = can(role, 'production.fabric.issues');
  const canReceive = can(role, 'production.fabric.receive');
  const isGuard = role === 'guard';

  const [issues, setIssues] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    setError('');
    try {
      const q = isGuard
        ? query(collection(db, 'fabricIssues'), where('issuedTo', '==', user.id))
        : query(collection(db, 'fabricIssues'), orderBy('createdAt', 'desc'), limit(100));
      const snap = await getDocs(q);
      setIssues(snap.docs.map(d => d.data()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
    } catch (err: any) {
      console.error('Failed to load fabric issues:', err);
      setError(err?.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [user?.id, isGuard]);

  useEffect(() => { if (canView) load(); }, [canView, load]);

  const receive = async (issueId: string) => {
    setBusyId(issueId);
    setError('');
    try {
      await httpsCallable(functions, 'fabricIssueReceive')({ issueId });
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to confirm receipt.');
    } finally {
      setBusyId(null);
    }
  };

  if (!canView) {
    return <div className="text-center py-20"><p className="text-sm text-gray-500">You do not have permission to view fabric issues.</p></div>;
  }

  const pending = issues.filter(i => i.status === 'ISSUED').length;

  return (
    <div className="min-h-screen p-6 md:p-8">
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 bg-black text-white rounded-xl flex items-center justify-center"><PackageCheck size={18} /></div>
        <div>
          <h1 className="text-2xl font-display text-black tracking-wide">Fabric Issues</h1>
          <p className="text-xs text-gray-500 mt-1">
            {isGuard ? `${pending} waiting for you to confirm` : `${issues.length} issues · ${pending} not yet received`}{loading && ' · loading…'}
          </p>
        </div>
      </div>

      {error && <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 text-red-600 text-xs">{error}</div>}

      {loading ? (
        <div className="flex justify-center py-24"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
      ) : issues.length === 0 ? (
        <p className="text-center py-24 text-sm text-gray-500">{isGuard ? 'No fabric has been issued to you yet.' : 'No fabric issued yet.'}</p>
      ) : (
        <div className="space-y-4">
          {issues.map(i => (
            <div key={i.id} className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5" data-testid={`fabric-issue-${i.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="text-sm">
                  <span className="font-mono font-medium">{i.id}</span>
                  <span className="text-gray-400"> · </span>
                  <Link to={`/production/requests/${i.prId}`} className="underline">{i.prId}</Link>
                  <span className="text-gray-500"> · {i.qty} pieces · to {i.issuedToName}</span>
                </div>
                {i.status === 'RECEIVED'
                  ? <span className="text-[10px] font-bold uppercase text-green-700 bg-green-50 px-2 py-0.5 rounded">Received</span>
                  : <span className="text-[10px] font-bold uppercase text-amber-700 bg-amber-50 px-2 py-0.5 rounded">Issued — not received</span>}
              </div>
              <ul className="text-sm space-y-1 mb-3">
                {(i.lines || []).map((l: any) => (
                  <li key={l.fabricId} className="flex justify-between border-b border-gray-50 py-1">
                    <span>{l.fabricName}</span>
                    <span className="font-mono">{l.metersPerPiece} m × {l.qty} = <b>{l.meters} m</b></span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-gray-500">
                Total <b>{i.totalMeters} m</b> · issued by {i.issuedByName} on {new Date(i.issuedAt).toLocaleString()}
                {i.receivedAt && <> · received by {i.receivedByName} on {new Date(i.receivedAt).toLocaleString()}</>}
              </p>
              {canReceive && i.status === 'ISSUED' && i.issuedTo === user?.id && (
                <button disabled={busyId === i.id} onClick={() => receive(i.id)}
                  className="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-black text-white text-[10px] font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-40">
                  {busyId === i.id ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Confirm received
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
