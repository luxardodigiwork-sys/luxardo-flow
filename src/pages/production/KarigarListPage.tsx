import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../../firebase';
import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { Users, Plus, Search, Loader2, Phone, Tag, IndianRupee } from 'lucide-react';
import type { KarigarDoc } from '../../types/production';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';

export default function KarigarListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const effectiveRole = (user?.staffRole || user?.role || '') as any;
  // View-only roles (e.g. Dispatch) can see this registry via
  // production.karigars but must never see a create entry point the
  // backend's requireAdmin()-gated karigarCreate would reject anyway.
  const canWrite = can(effectiveRole, 'production.karigars.write');
  const [karigars, setKarigars] = useState<KarigarDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  const loadKarigars = useCallback(async () => {
    try {
      const q = query(collection(db, 'karigars'), orderBy('createdAt', 'desc'));
      const snap = await getDocs(q);
      setKarigars(snap.docs.map(d => d.data() as KarigarDoc));
    } catch (err) {
      console.error('Failed to load karigars:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadKarigars(); }, [loadKarigars]);

  const filtered = karigars.filter(k =>
    k.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    k.mobile.includes(searchTerm) ||
    k.skillTags.some(t => t.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div className="min-h-screen p-6 md:p-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-display text-black tracking-wide">Karigar Registry</h1>
          <p className="text-xs text-gray-500 font-sans mt-1">Skilled labour database</p>
        </div>
        {canWrite && (
          <button
            onClick={() => navigate('/production/karigars/new')}
            className="flex items-center gap-2 px-5 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 transition-colors"
          >
            <Plus size={16} />
            Add Karigar
          </button>
        )}
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Search by name, mobile, or skill tag…"
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
            <Users size={32} className="mx-auto text-gray-300 mb-4" />
            <p className="text-sm text-gray-500">{searchTerm ? 'No karigars match your search.' : 'No karigars registered yet.'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="sticky-table-header">
                <tr className="border-b border-gray-100">
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">ID</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Name</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Mobile</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Skills</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Rate (₹/hr)</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(k => (
                  <tr key={k.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                    <td className="px-6 py-4 text-xs font-mono text-gray-500">{k.id}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-gray-100 rounded-full flex items-center justify-center text-xs font-bold text-gray-500">
                          {k.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm font-medium text-black">{k.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500 flex items-center gap-1">
                      <Phone size={12} className="text-gray-400" />
                      {k.mobile}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1">
                        {k.skillTags.map(tag => (
                          <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-[10px] font-medium text-gray-600 rounded">
                            <Tag size={10} />
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500 flex items-center gap-1">
                      <IndianRupee size={12} className="text-gray-400" />
                      {k.hourlyRate}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md ${
                        k.active ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'
                      }`}>
                        {k.active ? 'Active' : 'Inactive'}
                      </span>
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
