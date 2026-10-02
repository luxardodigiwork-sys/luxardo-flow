import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../../firebase';
import { collection, getDocs, query, orderBy, where } from 'firebase/firestore';
import { useAuth } from '../../context/AuthContext';
import { roleLabel, can, type Role } from '../../utils/rolePermissions';
import { isLoomHost } from '../../utils/loomIdentity';
import {
  Layers, Users, Package, FileText, TrendingUp, Palette, Scissors, Shirt, ClipboardList,
  Loader2, Clock, AlertCircle, ArrowRight
} from 'lucide-react';

const STAGE_ORDER = [
  'OPEN', 'IN_WORK', 'QC_PENDING', 'REWORK', 'QC_PASS', 'DISPATCH_READY',
  'TAILOR_ASSIGNED', 'STITCHING', 'STITCH_COMPLETE', 'STORE', 'STORE_OUT', 'REJECTED',
];

const STAGE_CHIP: Record<string, string> = {
  OPEN: 'bg-gray-100 text-gray-600',
  IN_WORK: 'bg-blue-50 text-blue-600',
  QC_PENDING: 'bg-amber-50 text-amber-600',
  REWORK: 'bg-orange-50 text-orange-600',
  QC_PASS: 'bg-emerald-50 text-emerald-600',
  DISPATCH_READY: 'bg-emerald-50 text-emerald-700',
  STORE_OUT: 'bg-teal-50 text-teal-700',
  REJECTED: 'bg-red-50 text-red-500',
};

const PR_STATUS_COLORS: Record<string, string> = {
  APPROVED: 'bg-emerald-50 text-emerald-600',
  IN_PRODUCTION: 'bg-blue-50 text-blue-600',
  COMPLETED: 'bg-teal-50 text-teal-600',
};

/** Card shell for the KPI strip. */
function KpiCard({
  icon, label, value, sub, accent = 'white',
}: {
  icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string; accent?: 'black' | 'white';
}) {
  if (accent === 'black') {
    return (
      <div className="bg-black text-white p-6 rounded-2xl shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-bl-full -mr-8 -mt-8 pointer-events-none" />
        <div className="flex items-center gap-3 mb-4 text-white/70">
          {icon}
          <h3 className="text-[10px] font-bold uppercase tracking-widest">{label}</h3>
        </div>
        <p className="text-3xl font-display mb-2">{value}</p>
        {sub && <p className="text-[10px] text-white/50 uppercase tracking-widest">{sub}</p>}
      </div>
    );
  }
  return (
    <div className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm">
      <div className="flex items-center gap-3 mb-4 text-gray-500">
        {icon}
        <h3 className="text-[10px] font-bold uppercase tracking-widest">{label}</h3>
      </div>
      <p className="text-3xl font-display text-black mb-2">{value}</p>
      {sub && <p className="text-[10px] text-gray-400 uppercase tracking-widest">{sub}</p>}
    </div>
  );
}

export default function ProductionHomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const staffRole = user?.staffRole || user?.role || '';
  const effectiveRole = (staffRole || '') as Role;

  const [pieces, setPieces] = useState<any[]>([]);
  const [prs, setPrs] = useState<any[]>([]);
  const [karigars, setKarigars] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Read gates mirror the Firestore rules so a role never queries a collection
  // it is not allowed to read. Guard/tailor/store → piece pipeline only.
  const canReadPieces = can(effectiveRole, 'production.pieces');
  const canReadPrs = can(effectiveRole, 'production.requests');
  const canReadKarigars = can(effectiveRole, 'production.karigars');

  const load = useCallback(async () => {
    try {
      const jobs: Promise<void>[] = [];

      if (canReadPieces) {
        jobs.push(
          getDocs(query(collection(db, 'pieces'), orderBy('createdAt', 'desc')))
            .then(snap => setPieces(snap.docs.map(d => d.data())))
            .catch(err => console.error('Failed to load pieces:', err))
        );
      }
      if (canReadPrs) {
        // PM/others must constrain by status so rules permit the query.
        jobs.push(
          getDocs(query(collection(db, 'productionRequests'), where('status', 'in', ['APPROVED', 'IN_PRODUCTION', 'COMPLETED'])))
            .then(snap => {
              const data = snap.docs.map(d => d.data());
              data.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
              setPrs(data);
            })
            .catch(err => console.error('Failed to load PRs:', err))
        );
      }
      if (canReadKarigars) {
        jobs.push(
          getDocs(query(collection(db, 'karigars'), orderBy('createdAt', 'desc')))
            .then(snap => setKarigars(snap.docs.map(d => d.data())))
            .catch(err => console.error('Failed to load karigars:', err))
        );
      }
      await Promise.all(jobs);
    } finally {
      setLoading(false);
    }
  }, [canReadPieces, canReadPrs, canReadKarigars]);

  useEffect(() => { load(); }, [load]);

  // ── Derived KPIs (all from `pieces`, which every production role may read) ──
  const totalPieces = pieces.length;
  const inProduction = pieces.filter(p => (p.stage === 'IN_WORK')).length;
  const openPieces = pieces.filter(p => (p.stage || 'OPEN') === 'OPEN').length;
  const reworkPieces = pieces.filter(p => p.stage === 'REWORK' || p.status === 'in_rework').length;
  // Only genuinely rejected pieces. status 'closed' is ALSO set when a piece
  // leaves via Store-Out (sold/delivered), so counting it here reported every
  // delivered piece as a "reject" on the Owner dashboard.
  const rejectedPieces = pieces.filter(p => p.stage === 'REJECTED').length;
  const totalLabourMinutes = pieces.reduce((s, p) => s + (Number(p.totalLabourMinutes) || 0), 0);
  const totalLabourCost = pieces.reduce((s, p) => s + (Number(p.totalLabourCost) || 0), 0);
  const totalReworks = pieces.reduce((s, p) => s + (Number(p.reworkCount) || 0), 0);
  const activeKarigars = karigars.filter(k => k.active !== false).length;

  const pipeline = STAGE_ORDER.map(stage => ({ stage, count: pieces.filter(p => (p.stage || 'OPEN') === stage).length }))
    .filter(g => g.count > 0);

  return (
    <div className="min-h-screen p-6 md:p-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-display text-black tracking-wide">Production Dashboard</h1>
        <p className="text-xs text-gray-500 font-sans mt-1">
          {roleLabel(staffRole)} · Loom Production Overview{loading && ' · loading…'}
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            <div className="bg-black text-white p-6 rounded-2xl shadow-xl relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-bl-full -mr-8 -mt-8 pointer-events-none" />
              <div className="flex items-center gap-3 mb-4 text-white/70">
                <Layers size={18} />
                <h3 className="text-[10px] font-bold uppercase tracking-widest">Physical Pieces</h3>
              </div>
              <p className="text-3xl font-display mb-2">{totalPieces}</p>
              <p className="text-[10px] text-white/50 uppercase tracking-widest">Generated from approved PRs</p>
            </div>
            <KpiCard icon={<Package size={18} />} label="In Production" value={inProduction} sub="stage IN_WORK" />
            <KpiCard icon={<Clock size={18} />} label="Open Pieces" value={openPieces} sub="not yet started" />
            {canReadKarigars && (
              <KpiCard icon={<Users size={18} />} label="Active Karigars" value={activeKarigars} sub="registry · non-login" />
            )}
            <KpiCard icon={<AlertCircle size={18} />} label="Rework / Rejects" value={`${reworkPieces} / ${rejectedPieces}`} sub={`${totalReworks} rework cycles`} />
            <KpiCard icon={<FileText size={18} />} label="Labour" value={totalLabourMinutes} sub={`₹${totalLabourCost.toFixed(2)}`} />
            {canReadPrs && (
              <KpiCard icon={<TrendingUp size={18} />} label="Active Requests" value={prs.filter(p => p.status !== 'COMPLETED').length} sub={`${prs.length} approved total`} />
            )}
            <div className="p-6 rounded-2xl border border-gray-200 shadow-sm bg-gray-50/60 flex flex-col justify-center">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Piece Pipeline</p>
              {pipeline.length === 0 ? (
                <p className="text-sm text-gray-400">No pieces generated yet.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {pipeline.map(g => (
                    <button
                      key={g.stage}
                      onClick={() => navigate(`/production/pieces?stage=${g.stage}`)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md ${STAGE_CHIP[g.stage] || 'bg-gray-100 text-gray-600'} hover:opacity-80 transition-opacity`}
                    >
                      {g.stage}
                      <span className="bg-white/70 rounded px-1">{g.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Running Production (approved PRs with generation progress) */}
          {canReadPrs && (
            <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mb-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-bold text-sm uppercase tracking-widest text-black">Running Production</h2>
                <button
                  onClick={() => navigate('/production/requests')}
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-black transition-colors"
                >
                  All requests <ArrowRight size={12} />
                </button>
              </div>
              {prs.length === 0 ? (
                <p className="text-sm text-gray-400">No Owner-approved production requests yet.</p>
              ) : (
                <div className="space-y-3">
                  {prs.map(pr => {
                    const total = Number(pr.totalPieceCount) || Number(pr.originalOrderedQty) || 0;
                    const generated = Number(pr.piecesGeneratedCount) || 0;
                    const pct = total > 0 ? Math.min(100, Math.round((generated / total) * 100)) : 0;
                    return (
                      <button
                        key={pr.id}
                        onClick={() => navigate(`/production/requests/${pr.id}`)}
                        className="w-full text-left p-4 rounded-xl border border-gray-100 hover:bg-gray-50/70 transition-colors"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-mono text-xs font-medium text-black">{pr.id}</span>
                          <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest rounded-md ${PR_STATUS_COLORS[pr.status] || 'bg-gray-100 text-gray-500'}`}>
                            {pr.status}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 mb-2">
                          {pr.designId || '—'} · {pr.garmentType || 'garment'} · required {pr.requiredDate || '—'} · {pr.urgency}
                        </p>
                        <div className="flex items-center gap-3">
                          <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full bg-black rounded-full transition-all" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-[10px] font-mono text-gray-500">{generated} / {total} pieces</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Role-specific quick links */}
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mt-6">
            <h3 className="font-bold text-sm uppercase tracking-widest text-black mb-4">Quick Links</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {canReadPieces && (
              <a
                href="/production/pieces"
                className="flex items-center gap-3 p-4 border border-gray-100 rounded-xl hover:bg-gray-50 transition-colors"
              >
                <Package size={18} className="text-gray-400" />
                <div>
                  <p className="text-sm font-medium text-black">Production Pieces</p>
                  <p className="text-[10px] text-gray-400 uppercase tracking-widest">PIECE-XXXX · pipeline</p>
                </div>
              </a>
              )}
              {canReadKarigars && (
                <a
                  href="/production/karigars"
                  className="flex items-center gap-3 p-4 border border-gray-100 rounded-xl hover:bg-gray-50 transition-colors"
                >
                  <Users size={18} className="text-gray-400" />
                  <div>
                    <p className="text-sm font-medium text-black">Karigar Registry</p>
                    <p className="text-[10px] text-gray-400 uppercase tracking-widest">Labour & skill database</p>
                  </div>
                </a>
              )}
              {canReadPrs && (
                <a
                  href="/production/requests"
                  className="flex items-center gap-3 p-4 border border-gray-100 rounded-xl hover:bg-gray-50 transition-colors"
                >
                  <ClipboardList size={18} className="text-gray-400" />
                  <div>
                    <p className="text-sm font-medium text-black">Production Requests</p>
                    <p className="text-[10px] text-gray-400 uppercase tracking-widest">PR-XXXX · approvals</p>
                  </div>
                </a>
              )}
              {can(effectiveRole, 'production.staff') && (
                <a
                  href="/production/staff"
                  className="flex items-center gap-3 p-4 border border-gray-100 rounded-xl hover:bg-gray-50 transition-colors"
                >
                  <Users size={18} className="text-gray-400" />
                  <div>
                    <p className="text-sm font-medium text-black">Staff Management</p>
                    <p className="text-[10px] text-gray-400 uppercase tracking-widest">Create & manage staff roles</p>
                  </div>
                </a>
              )}
              {!isLoomHost() && can(effectiveRole, 'admin.dashboard') && (
                <a
                  href="/admin/dashboard"
                  className="flex items-center gap-3 p-4 border border-gray-100 rounded-xl hover:bg-gray-50 transition-colors"
                >
                  <TrendingUp size={18} className="text-gray-400" />
                  <div>
                    <p className="text-sm font-medium text-black">Admin Portal</p>
                    <p className="text-[10px] text-gray-400 uppercase tracking-widest">E-commerce admin dashboard</p>
                  </div>
                </a>
              )}
            </div>
          </div>

          {/* Design → Production Request links */}
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mt-6">
            <h3 className="font-bold text-sm uppercase tracking-widest text-black mb-4">Design Chain</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {can(effectiveRole, 'production.designs') && (
                <a
                  href="/production/designs"
                  className="flex items-center gap-3 p-4 border border-gray-100 rounded-xl hover:bg-gray-50 transition-colors"
                >
                  <Palette size={18} className="text-gray-400" />
                  <div>
                    <p className="text-sm font-medium text-black">Catalogue Designs</p>
                    <p className="text-[10px] text-gray-400 uppercase tracking-widest">KL-XXXX · versions</p>
                  </div>
                </a>
              )}
              {can(effectiveRole, 'production.sampleDesigns') && (
                <a
                  href="/production/sample-designs"
                  className="flex items-center gap-3 p-4 border border-gray-100 rounded-xl hover:bg-gray-50 transition-colors"
                >
                  <Scissors size={18} className="text-gray-400" />
                  <div>
                    <p className="text-sm font-medium text-black">Sample Designs</p>
                    <p className="text-[10px] text-gray-400 uppercase tracking-widest">fabric swatches</p>
                  </div>
                </a>
              )}
              {can(effectiveRole, 'production.samplePieces') && (
                <a
                  href="/production/sample-pieces"
                  className="flex items-center gap-3 p-4 border border-gray-100 rounded-xl hover:bg-gray-50 transition-colors"
                >
                  <Shirt size={18} className="text-gray-400" />
                  <div>
                    <p className="text-sm font-medium text-black">Sample Pieces</p>
                    <p className="text-[10px] text-gray-400 uppercase tracking-widest">catalogue garments</p>
                  </div>
                </a>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}