import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../../firebase';
import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { Layers, Plus, Search, Loader2, Eye } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';
import type { SampleDesignDoc } from '../../types/production';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  PENDING_APPROVAL: 'bg-amber-50 text-amber-600',
  APPROVED: 'bg-emerald-50 text-emerald-600',
  FROZEN: 'bg-blue-50 text-blue-600',
};

export default function SampleDesignListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [samples, setSamples] = useState<SampleDesignDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  const effectiveRole = user?.staffRole || user?.role || '';
  const canCreate = can(effectiveRole as any, 'production.sampleDesigns');

  const loadSamples = useCallback(async () => {
    try {
      const q = query(collection(db, 'sampleDesigns'), orderBy('createdAt', 'desc'));
      const snap = await getDocs(q);
      setSamples(snap.docs.map(d => d.data() as SampleDesignDoc));
    } catch (err) {
      console.error('Failed to load sample designs:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSamples(); }, [loadSamples]);

  const filtered = samples.filter(s =>
    s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.id.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="min-h-screen p-6 md:p-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-display text-black tracking-wide">Sample Designs</h1>
          <p className="text-xs text-gray-500 font-sans mt-1">Fabric swatches showing design portions</p>
        </div>
        {canCreate && (
          <button
            onClick={() => navigate('/production/sample-designs/new')}
            className="flex items-center gap-2 px-5 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 transition-colors"
          >
            <Plus size={16} />
            New Sample Design
          </button>
        )}
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Search by name or ID…"
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
            <Layers size={32} className="mx-auto text-gray-300 mb-4" />
            <p className="text-sm text-gray-500">{searchTerm ? 'No sample designs match your search.' : 'No sample designs created yet.'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="sticky-table-header">
                <tr className="border-b border-gray-100">
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">ID</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Name</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Linked Design</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Status</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(s => (
                  <tr key={s.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                    <td className="px-6 py-4 text-xs font-mono text-gray-500">{s.id}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        {s.image ? (
                          <img src={s.image} alt="" className="w-10 h-10 rounded-lg object-cover bg-gray-100" />
                        ) : (
                          <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                            <Layers size={16} className="text-gray-400" />
                          </div>
                        )}
                        <span className="text-sm font-medium text-black">{s.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-xs text-gray-500">
                      {s.catalogDesignId || <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md ${STATUS_COLORS[s.status] || 'bg-gray-100 text-gray-500'}`}>
                        {s.status}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => navigate(`/production/sample-designs/${s.id}`)}
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
