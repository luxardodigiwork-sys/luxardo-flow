import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../../firebase';
import { collection, getDocs, query, orderBy, where } from 'firebase/firestore';
import { FileText, Plus, Search, Loader2, Eye } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';
import type { ProductionRequestDoc } from '../../types/production';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  SUBMITTED: 'bg-amber-50 text-amber-600',
  PENDING_APPROVAL: 'bg-amber-50 text-amber-600',
  APPROVED: 'bg-emerald-50 text-emerald-600',
  IN_PRODUCTION: 'bg-blue-50 text-blue-600',
  COMPLETED: 'bg-teal-50 text-teal-600',
  REJECTED_BY_OWNER: 'bg-red-50 text-red-500',
  CANCELLED: 'bg-gray-100 text-gray-400',
};

const URGENCY_COLORS: Record<string, string> = {
  HIGH: 'bg-red-50 text-red-500',
  MEDIUM: 'bg-amber-50 text-amber-600',
  LOW: 'bg-emerald-50 text-emerald-600',
};

export default function ProductionRequestListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [requests, setRequests] = useState<ProductionRequestDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  const effectiveRole = user?.staffRole || user?.role || '';
  const isPM = effectiveRole === 'pm';
  // Dispatch creates reproduction requests; PM is read-only (approved only)
  const canCreate = can(effectiveRole as any, 'production.requests') && !isPM;

  const loadRequests = useCallback(async () => {
    try {
      // PM must constrain the query by status so Firestore rules can prove
      // it only returns Owner-approved PRs. Sort client-side (avoids a
      // composite index on status+createdAt).
      const q = isPM
        ? query(collection(db, 'productionRequests'), where('status', 'in', ['APPROVED', 'IN_PRODUCTION', 'COMPLETED']))
        : query(collection(db, 'productionRequests'), orderBy('createdAt', 'desc'));
      const snap = await getDocs(q);
      let data = snap.docs.map(d => d.data() as ProductionRequestDoc);
      if (isPM) data = [...data].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setRequests(data);
    } catch (err) {
      console.error('Failed to load production requests:', err);
    } finally {
      setLoading(false);
    }
  }, [isPM]);

  useEffect(() => { loadRequests(); }, [loadRequests]);

  const filtered = requests.filter(r =>
    r.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (r.designId && r.designId.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div className="min-h-screen p-6 md:p-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-display text-black tracking-wide">Production Requests</h1>
          <p className="text-xs text-gray-500 font-sans mt-1">
            {isPM ? 'Owner-approved requests only' : 'Dispatch creates, Owner approves'}
          </p>
        </div>
        {canCreate && (
          <button
            onClick={() => navigate('/production/requests/new')}
            className="flex items-center gap-2 px-5 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 transition-colors"
          >
            <Plus size={16} />
            New Request
          </button>
        )}
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Search by PR ID or design ID…"
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="w-full pl-11 pr-4 py-3 text-sm border border-gray-200 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all"
        />
      </div>

      {/* Grid */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20">
            <FileText size={32} className="mx-auto text-gray-300 mb-4" />
            <p className="text-sm text-gray-500">{searchTerm ? 'No requests match your search.' : 'No production requests yet.'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="sticky-table-header">
                <tr className="border-b border-gray-100">
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">PR ID</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Design</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Qty</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Urgency</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Required By</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Status</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                    <td className="px-6 py-4 text-xs font-mono text-gray-500">{r.id}</td>
                    <td className="px-6 py-4 text-xs text-gray-500">{r.designId || '—'}</td>
                    <td className="px-6 py-4 text-sm font-medium text-black">{r.originalOrderedQty}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold rounded ${URGENCY_COLORS[r.urgency] || 'bg-gray-100 text-gray-500'}`}>
                        {r.urgency}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-xs text-gray-500">{r.requiredDate || '—'}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md ${STATUS_COLORS[r.status] || 'bg-gray-100 text-gray-500'}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => navigate(`/production/requests/${r.id}`)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-500 hover:text-black hover:bg-gray-100 rounded-lg transition-colors"
                      >
                        <Eye size={14} />
                        View
                      </button>
                    </td>
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