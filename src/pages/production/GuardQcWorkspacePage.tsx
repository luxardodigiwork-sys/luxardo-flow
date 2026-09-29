import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../../firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { ShieldCheck, Loader2, Package, Users, Clock, ArrowRight } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';

const STAGE_COLORS: Record<string, string> = {
  OPEN: 'bg-gray-100 text-gray-600',
  IN_WORK: 'bg-blue-50 text-blue-600',
  QC_PENDING: 'bg-amber-50 text-amber-600',
  REWORK: 'bg-orange-50 text-orange-600',
  QC_PASS: 'bg-emerald-50 text-emerald-600',
  DISPATCH_READY: 'bg-emerald-50 text-emerald-700',
  TAILOR_ASSIGNED: 'bg-indigo-50 text-indigo-600',
  STITCHING: 'bg-indigo-50 text-indigo-700',
  STITCH_COMPLETE: 'bg-violet-50 text-violet-600',
  STORE: 'bg-teal-50 text-teal-600',
  STORE_OUT: 'bg-teal-50 text-teal-700',
  REJECTED: 'bg-red-50 text-red-500',
};

export default function GuardQcWorkspacePage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const effectiveRole = (user?.staffRole || user?.role || '') as any;
  // 'production.qc' = read-only view of the Guard QC queue (includes pm,
  // per the Final V1 Role Matrix); 'production.qc.perform' = actually
  // performing QC, strictly guard-only — never elevated, kept separate so a
  // viewer can never see an action affordance the server would reject.
  const canView = can(effectiveRole, 'production.qc');
  const canPerformQc = can(effectiveRole, 'production.qc.perform');
  const canReadKarigars = can(effectiveRole, 'production.karigars');

  const [pieces, setPieces] = useState<any[]>([]);
  const [karigars, setKarigars] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadKarigars = useCallback(async () => {
    if (!canReadKarigars) return;
    try {
      const snap = await getDocs(query(collection(db, 'karigars')));
      setKarigars(snap.docs.map(d => d.data()));
    } catch (err) {
      console.error('Failed to load karigars:', err);
    }
  }, [canReadKarigars]);

  const load = useCallback(async () => {
    try {
      // Pieces awaiting Guard QC = currently in QC_PENDING.
      const q = query(collection(db, 'pieces'), where('stage', '==', 'QC_PENDING'));
      const snap = await getDocs(q);
      const data = snap.docs.map(d => d.data());
      data.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      setPieces(data);
      loadKarigars();
    } catch (err) {
      console.error('Failed to load QC workspace:', err);
    } finally {
      setLoading(false);
    }
  }, [loadKarigars]);

  useEffect(() => { load(); }, [load]);

  if (!canView) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-gray-500">You do not have permission to access the Guard QC workspace.</p>
      </div>
    );
  }

  const karigarName = (kid: string) => karigars.find(k => k.id === kid)?.name || kid;

  return (
    <div className="min-h-screen p-6 md:p-8">
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-black text-white rounded-xl flex items-center justify-center">
            <ShieldCheck size={18} />
          </div>
          <div>
            <h1 className="text-2xl font-display text-black tracking-wide">Guard QC Workspace</h1>
            <p className="text-xs text-gray-500 font-sans mt-1">
              {pieces.length} piece{pieces.length === 1 ? '' : 's'} awaiting Guard QC{loading && ' · loading…'}
            </p>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : pieces.length === 0 ? (
        <div className="text-center py-24">
          <ShieldCheck size={32} className="mx-auto text-gray-300 mb-3" />
          <p className="text-sm text-gray-500">No pieces are currently awaiting Guard QC.</p>
          <p className="text-xs text-gray-400 mt-1">Pieces move to QC_PENDING before they reach this queue.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky-table-header">
                <tr className="border-b border-gray-100">
                  <th className="text-left px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">Piece ID</th>
                  <th className="text-left px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">Design</th>
                  <th className="text-left px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">Version</th>
                  <th className="text-left px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">PR</th>
                  <th className="text-left px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">Karigars</th>
                  <th className="text-right px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">Labour</th>
                  <th className="text-right px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400"></th>
                </tr>
              </thead>
              <tbody>
                {pieces.map(piece => (
                  <tr
                    key={piece.id}
                    className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors"
                  >
                    <td className="px-6 py-4 font-mono text-xs font-medium text-black">{piece.id}</td>
                    <td className="px-6 py-4 font-mono text-xs text-gray-600">{piece.designId || '—'}</td>
                    <td className="px-6 py-4 font-mono text-xs text-gray-600">{piece.designVersionId || '—'}</td>
                    <td className="px-6 py-4 font-mono text-xs text-gray-600">{piece.prId || '—'}</td>
                    <td className="px-6 py-4 text-xs text-gray-600">
                      {Array.isArray(piece.assignedKarigars) && piece.assignedKarigars.length > 0
                        ? piece.assignedKarigars.map(karigarName).join(', ')
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-6 py-4 text-xs text-gray-600 text-right">{piece.totalLabourMinutes || 0} min</td>
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={() => navigate(`/production/pieces/${piece.id}`)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-black text-white rounded-lg text-[10px] font-bold uppercase tracking-widest hover:opacity-80 transition-opacity"
                      >
                        {canPerformQc ? 'Open for QC' : 'View'}
                        <ArrowRight size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden divide-y divide-gray-100">
            {pieces.map(piece => (
              <div key={piece.id} className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-xs font-medium text-black">{piece.id}</span>
                  <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest rounded-md ${STAGE_COLORS[piece.stage] || 'bg-gray-100 text-gray-500'}`}>
                    {piece.stage || 'OPEN'}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500 mb-3 flex-wrap">
                  {piece.designId && <span className="font-mono">{piece.designId}</span>}
                  {piece.designVersionId && <span className="font-mono">v{piece.designVersionId}</span>}
                  {piece.prId && <span className="font-mono">{piece.prId}</span>}
                  <span className="flex items-center gap-1"><Clock size={12} />{piece.totalLabourMinutes || 0} min</span>
                </div>
                {Array.isArray(piece.assignedKarigars) && piece.assignedKarigars.length > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-3">
                    <Users size={12} className="text-gray-400" />
                    {piece.assignedKarigars.map(karigarName).join(', ')}
                  </div>
                )}
                <button
                  onClick={() => navigate(`/production/pieces/${piece.id}`)}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-black text-white rounded-lg text-[10px] font-bold uppercase tracking-widest hover:opacity-80 transition-opacity"
                >
                  {canPerformQc ? 'Open for QC' : 'View'}
                  <ArrowRight size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
