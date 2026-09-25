import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { db } from '../../firebase';
import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { Package, Search, Loader2, Eye, User } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';

const STAGE_FILTERS = [
  'ALL', 'OPEN', 'IN_WORK', 'QC_PENDING', 'REWORK', 'QC_PASS', 'DISPATCH_READY',
  'STORE_OUT', 'REJECTED',
];

const FILTER_CHIP: Record<string, string> = {
  ALL: 'bg-black text-white',
  OPEN: 'bg-gray-100 text-gray-600',
  IN_WORK: 'bg-blue-50 text-blue-600',
  QC_PENDING: 'bg-amber-50 text-amber-600',
  REWORK: 'bg-orange-50 text-orange-600',
  QC_PASS: 'bg-emerald-50 text-emerald-600',
  DISPATCH_READY: 'bg-emerald-50 text-emerald-700',
  STORE_OUT: 'bg-teal-50 text-teal-700',
  REJECTED: 'bg-red-50 text-red-500',
};

const STAGE_COLORS: Record<string, string> = {
  OPEN: 'bg-gray-100 text-gray-600',
  IN_WORK: 'bg-blue-50 text-blue-600',
  QC_PENDING: 'bg-amber-50 text-amber-600',
  REWORK: 'bg-orange-50 text-orange-600',
  QC_PASS: 'bg-emerald-50 text-emerald-600',
  DISPATCH_READY: 'bg-emerald-50 text-emerald-700',
  REJECTED: 'bg-red-50 text-red-500',
};

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-600',
  in_rework: 'bg-orange-50 text-orange-600',
  closed: 'bg-gray-100 text-gray-500',
  replaced: 'bg-purple-50 text-purple-600',
};

export default function PieceListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const [pieces, setPieces] = useState<any[]>([]);
  const [karigars, setKarigars] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [karigarFilter, setKarigarFilter] = useState('ALL');

  const stageFilterRaw = searchParams.get('stage') || 'ALL';
  const stageFilter = STAGE_FILTERS.includes(stageFilterRaw) ? stageFilterRaw : 'ALL';

  const effectiveRole = (user?.staffRole || user?.role || '') as any;
  const canView = can(effectiveRole, 'production.pieces');
  const canReadKarigars = can(effectiveRole, 'production.karigars');

  const setStageFilter = (s: string) => {
    if (s === 'ALL') setSearchParams({});
    else setSearchParams({ stage: s });
  };

  const loadPieces = useCallback(async () => {
    try {
      const q = query(collection(db, 'pieces'), orderBy('createdAt', 'desc'));
      const snap = await getDocs(q);
      setPieces(snap.docs.map(d => d.data()));
    } catch (err) {
      console.error('Failed to load pieces:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadKarigars = useCallback(async () => {
    if (!canReadKarigars) return;
    try {
      const q = query(collection(db, 'karigars'), orderBy('createdAt', 'desc'));
      const snap = await getDocs(q);
      setKarigars(snap.docs.map(d => d.data()));
    } catch (err) {
      console.error('Failed to load karigars:', err);
    }
  }, [canReadKarigars]);

  useEffect(() => { loadPieces(); }, [loadPieces]);
  useEffect(() => { loadKarigars(); }, [loadKarigars]);

  const karigarName = (kid: string) =>
    karigars.find(k => k.id === kid)?.name || kid;

  const filtered = pieces.filter(p => {
    const matchesStage = stageFilter === 'ALL' || (p.stage || 'OPEN') === stageFilter;
    const matchesKarigar =
      karigarFilter === 'ALL' ||
      (Array.isArray(p.assignedKarigars) && p.assignedKarigars.includes(karigarFilter));
    const matchesSearch =
      p.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.prId || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.designId || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.stage || '').toLowerCase().includes(searchTerm.toLowerCase());
    return matchesStage && matchesKarigar && matchesSearch;
  });

  if (!canView) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-gray-500">You do not have permission to view production pieces.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 md:p-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-display text-black tracking-wide">Production Pieces</h1>
          <p className="text-xs text-gray-500 font-sans mt-1">Physical piece tracking — generated from approved PRs</p>
        </div>
      </div>

      {/* Stage filter chips (drill-down from the dashboard pipeline) */}
      <div className="flex flex-wrap gap-2 mb-4">
        {STAGE_FILTERS.map(s => (
          <button
            key={s}
            onClick={() => setStageFilter(s)}
            className={`inline-flex items-center px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-lg transition-colors ${
              stageFilter === s ? FILTER_CHIP[s] : 'bg-gray-50 text-gray-500 hover:bg-gray-100'
            }`}
          >
            {s}
            {s !== 'ALL' && (
              <span className="ml-1.5 opacity-60">{pieces.filter(p => (p.stage || 'OPEN') === s).length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Karigar filter */}
      {canReadKarigars && (
        <div className="mb-4 flex items-center gap-2">
          <User size={14} className="text-gray-400" />
          <select
            value={karigarFilter}
            onChange={e => setKarigarFilter(e.target.value)}
            className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all bg-white"
          >
            <option value="ALL">All karigars</option>
            {karigars.map(k => (
              <option key={k.id} value={k.id}>{k.name} · {k.id}</option>
            ))}
          </select>
          {karigarFilter !== 'ALL' && (
            <button
              onClick={() => setKarigarFilter('ALL')}
              className="text-xs text-gray-400 hover:text-black underline transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Search */}
      <div className="relative mb-6">
        <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Search by Piece ID, PR, design, or stage…"
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="w-full pl-10 pr-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20">
          <Package size={32} className="mx-auto text-gray-300 mb-3" />
          <p className="text-sm text-gray-500">
            {searchTerm ? 'No pieces match your search.' : 'No pieces yet. Generate from an approved Production Request.'}
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky-table-header">
                <tr className="border-b border-gray-100">
                  <th className="text-left px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">Piece ID</th>
                  <th className="text-left px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">PR</th>
                  <th className="text-left px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">Design</th>
                  <th className="text-left px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">Stage</th>
                  <th className="text-left px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">Status</th>
                  <th className="text-left px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">Karigars</th>
                  <th className="text-right px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">Labour (min)</th>
                  <th className="text-right px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400">Reworks</th>
                  <th className="text-right px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-gray-400"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(piece => (
                  <tr
                    key={piece.id}
                    onClick={() => navigate(`/production/pieces/${piece.id}`)}
                    className="border-b border-gray-50 hover:bg-gray-50/60 cursor-pointer transition-colors"
                  >
                    <td className="px-6 py-4 font-mono text-xs font-medium text-black">{piece.id}</td>
                    <td className="px-6 py-4 font-mono text-xs text-gray-600">{piece.prId || '—'}</td>
                    <td className="px-6 py-4 font-mono text-xs text-gray-600">{piece.designId || '—'}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest rounded-md ${STAGE_COLORS[piece.stage] || 'bg-gray-100 text-gray-500'}`}>
                        {piece.stage || 'OPEN'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest rounded-md ${STATUS_COLORS[piece.status] || 'bg-gray-100 text-gray-500'}`}>
                        {piece.status || 'active'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-xs text-gray-600">
                      {Array.isArray(piece.assignedKarigars) && piece.assignedKarigars.length > 0
                        ? piece.assignedKarigars.map(karigarName).join(', ')
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-6 py-4 text-xs text-gray-600 text-right">{piece.totalLabourMinutes || 0}</td>
                    <td className="px-6 py-4 text-xs text-gray-600 text-right">{piece.reworkCount || 0}</td>
                    <td className="px-6 py-4 text-right">
                      <Eye size={14} className="text-gray-400" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden divide-y divide-gray-100">
            {filtered.map(piece => (
              <div
                key={piece.id}
                onClick={() => navigate(`/production/pieces/${piece.id}`)}
                className="p-4 hover:bg-gray-50/60 cursor-pointer transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-xs font-medium text-black">{piece.id}</span>
                  <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest rounded-md ${STAGE_COLORS[piece.stage] || 'bg-gray-100 text-gray-500'}`}>
                    {piece.stage || 'OPEN'}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500">
                  {piece.prId && <span className="font-mono">{piece.prId}</span>}
                  {piece.designId && <span className="font-mono">{piece.designId}</span>}
                  <span>{piece.totalLabourMinutes || 0} min</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
