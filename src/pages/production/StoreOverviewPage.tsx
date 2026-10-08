import React, { useState, useEffect, useCallback } from 'react';
import { functions } from '../../firebase';
import { httpsCallable } from 'firebase/functions';
import { Warehouse, Loader2, TrendingUp } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';

interface DesignRow {
  designId: string;
  name: string;
  catalogueShortName: string | null;
  atStore: number;
  totalProduced: number;
  inProduction: number;
  completed: number;
  stored: number;
  storeOutCount: number;
}

interface DemandRow {
  designId: string;
  name: string;
  catalogueShortName: string | null;
  orderedQty: number;
  generatedQty: number;
}

/**
 * Read-only, cross-role Store Overview. Deliberately separate from
 * StoreWorkspacePage (which keeps the real Store-Out controls restricted to
 * the store role) — this page never calls storeOutCreate/storeOutReportIssue
 * and never shows a Store-Out action. Data comes from the server-side
 * storeOverviewReport callable (functions/src/reports.ts) so roles like
 * designer/analysis/dispatch/guard — none of which have raw `pieces` read
 * access — can see design-level Store standing without being granted
 * broader (and labour-cost-bearing) Firestore read access.
 */
export default function StoreOverviewPage() {
  const { user } = useAuth();
  const effectiveRole = (user?.staffRole || user?.role || '') as any;
  const canView = can(effectiveRole, 'production.storeOverview');

  const [designs, setDesigns] = useState<DesignRow[]>([]);
  const [topDemand, setTopDemand] = useState<DemandRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canView) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const res: any = await httpsCallable(functions, 'storeOverviewReport')({});
      setDesigns(res?.data?.designs || []);
      setTopDemand(res?.data?.topDemand || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load Store Overview.');
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => { load(); }, [load]);

  if (!canView) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-gray-500">You do not have permission to view the Store Overview.</p>
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
            <h1 className="text-2xl font-display text-black tracking-wide">Store Overview</h1>
            <p className="text-xs text-gray-500 font-sans mt-1">
              Read-only · per-design Store standing{loading && ' · loading…'}
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
              <h2 className="text-sm font-bold text-black uppercase tracking-widest">Designs — by pieces currently at Store</h2>
            </div>
            {designs.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-sm text-gray-500">No pieces have been produced yet.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="sticky-table-header">
                    <tr className="border-b border-gray-100">
                      <th className="text-left px-6 py-3 text-[10px] font-bold uppercase tracking-widest text-gray-400">Design</th>
                      <th className="text-right px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-gray-400">At Store</th>
                      <th className="text-right px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-gray-400">Total Produced</th>
                      <th className="text-right px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-gray-400">In Production</th>
                      <th className="text-right px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-gray-400">Completed</th>
                      <th className="text-right px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-gray-400">Stored (ever)</th>
                      <th className="text-right px-6 py-3 text-[10px] font-bold uppercase tracking-widest text-gray-400">Store-Outs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {designs.map((d) => (
                      <tr key={d.designId} className="border-b border-gray-50 hover:bg-gray-50/50">
                        <td className="px-6 py-3">
                          <span className="text-sm font-medium text-black">{d.catalogueShortName || d.name}</span>
                          <span className="ml-2 font-mono text-[10px] text-gray-400">{d.designId}</span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-sm font-bold text-black">{d.atStore}</td>
                        <td className="px-4 py-3 text-right font-mono text-sm text-gray-600">{d.totalProduced}</td>
                        <td className="px-4 py-3 text-right font-mono text-sm text-gray-600">{d.inProduction}</td>
                        <td className="px-4 py-3 text-right font-mono text-sm text-gray-600">{d.completed}</td>
                        <td className="px-4 py-3 text-right font-mono text-sm text-gray-600">{d.stored}</td>
                        <td className="px-6 py-3 text-right font-mono text-sm text-gray-600">{d.storeOutCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
              <TrendingUp size={16} className="text-gray-400" />
              <h2 className="text-sm font-bold text-black uppercase tracking-widest">Top Demand / Highest Production Designs</h2>
            </div>
            <p className="px-6 pt-3 text-[10px] text-amber-600 uppercase tracking-widest font-bold">
              Based on production request &amp; generated piece quantities — NOT sales demand
            </p>
            {topDemand.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-sm text-gray-500">No production requests yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100 mt-2">
                {topDemand.map((d, i) => (
                  <div key={d.designId} className="flex items-center justify-between px-6 py-3">
                    <div className="flex items-center gap-3">
                      <span className="w-6 h-6 rounded-full bg-gray-100 text-gray-500 text-[10px] font-bold flex items-center justify-center">{i + 1}</span>
                      <div>
                        <span className="text-sm font-medium text-black">{d.catalogueShortName || d.name}</span>
                        <span className="ml-2 font-mono text-[10px] text-gray-400">{d.designId}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-mono font-bold text-black">{d.orderedQty} ordered</p>
                      <p className="text-[10px] text-gray-400 font-mono">{d.generatedQty} generated</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
