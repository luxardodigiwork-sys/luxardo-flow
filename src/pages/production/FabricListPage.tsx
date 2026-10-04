import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../../firebase';
import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { Layers, Plus, Search, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { can, type Role } from '../../utils/rolePermissions';
import type { FabricMasterDoc } from '../../types/production';

export default function FabricListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const effectiveRole = (user?.staffRole || user?.role || '') as Role;
  const canWrite = can(effectiveRole, 'production.fabric.write');

  const [fabrics, setFabrics] = useState<FabricMasterDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  const loadFabrics = useCallback(async () => {
    try {
      const q = query(collection(db, 'fabricMasters'), orderBy('createdAt', 'desc'));
      const snap = await getDocs(q);
      setFabrics(snap.docs.map(d => d.data() as FabricMasterDoc));
    } catch (err) {
      console.error('Failed to load fabrics:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadFabrics(); }, [loadFabrics]);

  const filtered = fabrics.filter(f =>
    f.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    f.colour.toLowerCase().includes(searchTerm.toLowerCase()) ||
    f.id.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="min-h-screen p-6 md:p-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-display text-black tracking-wide">Fabric Inventory</h1>
          <p className="text-xs text-gray-500 font-sans mt-1">Fabric masters &amp; current stock</p>
        </div>
        {canWrite && (
          <button
            onClick={() => navigate('/production/fabric/new')}
            className="flex items-center gap-2 px-5 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 transition-colors"
          >
            <Plus size={16} />
            Add Fabric
          </button>
        )}
      </div>

      <div className="relative mb-6">
        <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Search by name, colour, or ID…"
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="w-full pl-11 pr-4 py-3 text-sm border border-gray-200 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all"
        />
      </div>

      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20">
            <Layers size={32} className="mx-auto text-gray-300 mb-4" />
            <p className="text-sm text-gray-500">{searchTerm ? 'No fabrics match your search.' : 'No fabrics registered yet.'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="sticky-table-header">
                <tr className="border-b border-gray-100">
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">ID</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Name</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Colour</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">GSM</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Stock (m)</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(f => (
                  <tr
                    key={f.id}
                    className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors cursor-pointer"
                    onClick={() => navigate(`/production/fabric/${f.id}`)}
                  >
                    <td className="px-6 py-4 text-xs font-mono text-gray-500">{f.id}</td>
                    <td className="px-6 py-4 text-sm font-medium text-black">{f.name}</td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      <span className="inline-flex items-center gap-2">
                        {f.colourCode && (
                          <span className="w-3 h-3 rounded-full border border-gray-200" style={{ backgroundColor: f.colourCode }} />
                        )}
                        {f.colour}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">{f.gsm}</td>
                    <td className="px-6 py-4 text-sm font-mono text-black">{(f.stockQtyMeters ?? 0).toFixed(2)}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md ${
                        f.active ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'
                      }`}>
                        {f.active ? 'Active' : 'Inactive'}
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
