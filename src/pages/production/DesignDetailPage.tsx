import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { db, functions } from '../../firebase';
import { doc, getDoc, collection, query, where, orderBy, getDocs } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';
import {
  ArrowLeft, Loader2, Lock, Unlock, Send, Check, Tag, Plus,
  Clock, User, FileText
} from 'lucide-react';
import type { DesignDoc, DesignVersionDoc } from '../../types/production';
import { DesignFabricGuideSection } from '../../components/production/FabricSections';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  PENDING_APPROVAL: 'bg-amber-50 text-amber-600',
  APPROVED: 'bg-emerald-50 text-emerald-600',
  FROZEN: 'bg-blue-50 text-blue-600',
};

export default function DesignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [design, setDesign] = useState<DesignDoc | null>(null);
  const [versions, setVersions] = useState<DesignVersionDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Catalogue meta form
  const [catalogueShortName, setCatalogueShortName] = useState('');
  const [designNumber, setDesignNumber] = useState('');

  const effectiveRole = user?.staffRole || user?.role || '';
  const canWrite = can(effectiveRole as any, 'production.designs.write');
  const canApprove = can(effectiveRole as any, 'production.designs.approve');

  const loadDesign = useCallback(async () => {
    if (!id) return;
    try {
      const snap = await getDoc(doc(db, 'catalogueDesigns', id));
      if (snap.exists()) {
        const d = snap.data() as DesignDoc;
        setDesign(d);
        setCatalogueShortName(d.catalogueShortName || '');
        setDesignNumber(d.designNumber || '');

        // Load versions
        const vq = query(
          collection(db, 'designVersions'),
          where('designId', '==', id),
          orderBy('versionNo', 'desc')
        );
        const vsnap = await getDocs(vq);
        setVersions(vsnap.docs.map(v => v.data() as DesignVersionDoc));
      }
    } catch (err) {
      console.error('Failed to load design:', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadDesign(); }, [loadDesign]);

  const callFn = async (fnName: string, data: Record<string, unknown>) => {
    setActing(true);
    setToast(null);
    try {
      const fn = httpsCallable(functions, fnName);
      await fn(data);
      setToast({ type: 'success', message: 'Action completed.' });
      await loadDesign();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Action failed.' });
    } finally {
      setActing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!design) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-gray-500">Design not found.</p>
        <button onClick={() => navigate('/production/designs')} className="mt-4 text-sm text-black underline">
          Back to Designs
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 md:p-8 max-w-4xl">
      <button
        onClick={() => navigate('/production/designs')}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-black transition-colors mb-6"
      >
        <ArrowLeft size={16} />
        Back to Designs
      </button>

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div className="flex items-center gap-4">
          {design.image ? (
            <img src={design.image} alt="" className="w-16 h-16 rounded-xl object-cover bg-gray-100" />
          ) : (
            <div className="w-16 h-16 bg-gray-100 rounded-xl flex items-center justify-center">
              <FileText size={24} className="text-gray-400" />
            </div>
          )}
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-display text-black tracking-wide">{design.name}</h1>
              <span className={`inline-flex items-center px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md ${STATUS_COLORS[design.status]}`}>
                {design.status}
              </span>
              {design.isFrozen ? (
                <Lock size={16} className="text-blue-500" />
              ) : (
                <Unlock size={16} className="text-gray-300" />
              )}
            </div>
            <p className="text-xs text-gray-500 font-mono mt-1">{design.id} · v{design.currentVersion}</p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mb-6">
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">Actions</h2>
        <div className="flex flex-wrap gap-3">
          {design.status === 'DRAFT' && canWrite && (
            <button
              disabled={acting}
              onClick={() => callFn('designSubmit', { id: design.id })}
              className="flex items-center gap-2 px-4 py-2 bg-amber-500 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-colors"
            >
              {acting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Submit for Approval
            </button>
          )}
          {design.status === 'PENDING_APPROVAL' && canApprove && (
            <button
              disabled={acting}
              onClick={() => callFn('designApprove', { id: design.id })}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            >
              {acting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Approve & Freeze
            </button>
          )}
          {design.isFrozen && canWrite && (
            <button
              disabled={acting}
              onClick={() => callFn('designNewVersion', { id: design.id })}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {acting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              Start V{design.currentVersion + 1}
            </button>
          )}
        </div>
      </div>

      {/* Catalogue Meta (only for frozen/approved) */}
      {design.isFrozen && (
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mb-6">
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">Catalogue Reference</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
                Catalogue Short Name
              </label>
              <input
                type="text"
                value={catalogueShortName}
                onChange={e => setCatalogueShortName(e.target.value)}
                placeholder="e.g. PS-001"
                disabled={!canWrite}
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all disabled:bg-gray-50"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
                Design Number
              </label>
              <input
                type="text"
                value={designNumber}
                onChange={e => setDesignNumber(e.target.value)}
                placeholder="e.g. D-2024-001"
                disabled={!canWrite}
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all disabled:bg-gray-50"
              />
            </div>
          </div>
          {canWrite && (
            <button
              disabled={acting || (!catalogueShortName.trim() && !designNumber.trim())}
              onClick={() => callFn('designSetCatalogueMeta', {
                id: design.id,
                catalogueShortName: catalogueShortName.trim() || undefined,
                designNumber: designNumber.trim() || undefined,
              })}
              className="mt-4 flex items-center gap-2 px-4 py-2 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
            >
              {acting ? <Loader2 size={14} className="animate-spin" /> : <Tag size={14} />}
              Save Catalogue Info
            </button>
          )}
        </div>
      )}

      {/* Details */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mb-6">
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">Details</h2>
        <div className="space-y-3 text-sm">
          {design.description && (
            <p className="text-gray-600">{design.description}</p>
          )}
          <div className="flex items-center gap-2 text-gray-500">
            <User size={14} />
            Created by {design.createdByName || design.createdBy}
          </div>
          <div className="flex items-center gap-2 text-gray-500">
            <Clock size={14} />
            {new Date(design.createdAt).toLocaleDateString()}
          </div>
          {design.approvedByName && (
            <div className="flex items-center gap-2 text-emerald-600">
              <Check size={14} />
              Approved by {design.approvedByName} on {design.approvedAt ? new Date(design.approvedAt).toLocaleDateString() : '—'}
            </div>
          )}
        </div>
      </div>

      {/* Version History */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6">
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">Version History</h2>
        {versions.length === 0 ? (
          <p className="text-sm text-gray-400">No versions archived yet.</p>
        ) : (
          <div className="space-y-3">
            {versions.map(v => (
              <div key={v.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                <div>
                  <span className="text-sm font-medium text-black">v{v.versionNo}</span>
                  <span className="text-xs text-gray-500 ml-3">{v.approvedByName} · {new Date(v.approvedAt).toLocaleDateString()}</span>
                </div>
                <span className="text-[10px] font-mono text-gray-400">{v.id}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {design && (
        <div className="mt-6">
          <DesignFabricGuideSection designId={design.id} />
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-4 rounded-xl shadow-xl ${
          toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          <span className="text-sm">{toast.message}</span>
          <button onClick={() => setToast(null)} className="ml-2 text-white/70 hover:text-white">×</button>
        </div>
      )}
    </div>
  );
}
