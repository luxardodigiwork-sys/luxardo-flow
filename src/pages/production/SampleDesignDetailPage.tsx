import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { db, functions } from '../../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';
import { ArrowLeft, Loader2, Send, Check, Clock, User, FileText, Save } from 'lucide-react';
import PhotoUploadField from '../../components/production/PhotoUploadField';
import type { SampleDesignDoc } from '../../types/production';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  PENDING_APPROVAL: 'bg-amber-50 text-amber-600',
  APPROVED: 'bg-emerald-50 text-emerald-600',
  FROZEN: 'bg-blue-50 text-blue-600',
};

export default function SampleDesignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [sample, setSample] = useState<SampleDesignDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const effectiveRole = user?.staffRole || user?.role || '';
  const canWrite = can(effectiveRole as any, 'production.sampleDesigns');
  const canApprove = can(effectiveRole as any, 'production.designs.approve');
  // Correct write gate for the NEW photo-edit section below — matches
  // sampleDesignUpdate's own SAMPLE_WRITERS server gate exactly (admin/
  // owner/designer). `canWrite` above is the broader view permission
  // (pre-existing on this page's Submit button; left as-is, out of scope).
  const canEditSample = can(effectiveRole as any, 'production.sampleDesigns.write');

  // Photo edit form (DRAFT only — matches sampleDesignUpdate's own precondition)
  const [editImage, setEditImage] = useState('');
  const [editImagePath, setEditImagePath] = useState<string | null>(null);

  const loadSample = useCallback(async () => {
    if (!id) return;
    try {
      const snap = await getDoc(doc(db, 'sampleDesigns', id));
      if (snap.exists()) {
        const s = snap.data() as SampleDesignDoc;
        setSample(s);
        setEditImage(s.image || '');
        setEditImagePath(s.imagePath || null);
      }
    } catch (err) {
      console.error('Failed to load sample design:', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadSample(); }, [loadSample]);

  const callFn = async (fnName: string, data: Record<string, unknown>) => {
    setActing(true);
    setToast(null);
    try {
      const fn = httpsCallable(functions, fnName);
      await fn(data);
      setToast({ type: 'success', message: 'Action completed.' });
      await loadSample();
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

  if (!sample) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-gray-500">Sample design not found.</p>
        <button onClick={() => navigate('/production/sample-designs')} className="mt-4 text-sm text-black underline">
          Back to Sample Designs
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 md:p-8 max-w-4xl">
      <button
        onClick={() => navigate('/production/sample-designs')}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-black transition-colors mb-6"
      >
        <ArrowLeft size={16} />
        Back to Sample Designs
      </button>

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div className="flex items-center gap-4">
          {sample.image ? (
            <img src={sample.image} alt="" className="w-16 h-16 rounded-xl object-cover bg-gray-100" />
          ) : (
            <div className="w-16 h-16 bg-gray-100 rounded-xl flex items-center justify-center">
              <FileText size={24} className="text-gray-400" />
            </div>
          )}
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-display text-black tracking-wide">{sample.name}</h1>
              <span className={`inline-flex items-center px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md ${STATUS_COLORS[sample.status]}`}>
                {sample.status}
              </span>
            </div>
            <p className="text-xs text-gray-500 font-mono mt-1">{sample.id}</p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mb-6">
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">Actions</h2>
        <div className="flex flex-wrap gap-3">
          {sample.status === 'DRAFT' && canWrite && (
            <button
              disabled={acting}
              onClick={() => callFn('sampleDesignSubmit', { id: sample.id })}
              className="flex items-center gap-2 px-4 py-2 bg-amber-500 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-colors"
            >
              {acting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Submit for Approval
            </button>
          )}
          {sample.status === 'PENDING_APPROVAL' && canApprove && (
            <button
              disabled={acting}
              onClick={() => callFn('sampleDesignApprove', { id: sample.id })}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            >
              {acting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Approve Sample Design
            </button>
          )}
        </div>
      </div>

      {/* Photo (DRAFT only — same precondition sampleDesignUpdate enforces server-side) */}
      {sample.status === 'DRAFT' && canEditSample && (
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mb-6">
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">Swatch Photo</h2>
          <PhotoUploadField
            storagePathPrefix="production/sampleDesigns"
            uid={user?.id || ''}
            value={editImage}
            imagePath={editImagePath}
            onChange={(url, path) => { setEditImage(url); setEditImagePath(path); }}
            label="Swatch Photo (optional)"
          />
          <button
            disabled={acting || (editImage === (sample.image || '') && editImagePath === (sample.imagePath || null))}
            onClick={() => callFn('sampleDesignUpdate', { id: sample.id, image: editImage.trim(), imagePath: editImagePath || undefined })}
            className="mt-4 flex items-center gap-2 px-4 py-2 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            {acting ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save Photo
          </button>
        </div>
      )}

      {/* Details */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6">
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">Details</h2>
        <div className="space-y-3 text-sm">
          {sample.description && (
            <p className="text-gray-600">{sample.description}</p>
          )}
          {sample.catalogDesignId && (
            <p className="text-gray-500">
              <span className="font-medium">Linked Design:</span> {sample.catalogDesignId}
            </p>
          )}
          {sample.designVersionId && (
            <p className="text-gray-500">
              <span className="font-medium">Design Version:</span> {sample.designVersionId}
            </p>
          )}
          <div className="flex items-center gap-2 text-gray-500">
            <User size={14} />
            Created by {sample.createdByName || sample.createdBy}
          </div>
          <div className="flex items-center gap-2 text-gray-500">
            <Clock size={14} />
            {new Date(sample.createdAt).toLocaleDateString()}
          </div>
          {sample.approvedByName && (
            <div className="flex items-center gap-2 text-emerald-600">
              <Check size={14} />
              Approved by {sample.approvedByName}
            </div>
          )}
        </div>
      </div>

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
