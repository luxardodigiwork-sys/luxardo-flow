import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { db, functions } from '../../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';
import { ArrowLeft, Loader2, Check, Clock, User, Camera, Shirt } from 'lucide-react';
import PhotoUploadField from '../../components/production/PhotoUploadField';
import type { SamplePieceDoc } from '../../types/production';

const STATUS_COLORS: Record<string, string> = {
  IN_WORK: 'bg-gray-100 text-gray-600',
  COMPLETE: 'bg-amber-50 text-amber-600',
  APPROVED: 'bg-emerald-50 text-emerald-600',
};

export default function SamplePieceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [piece, setPiece] = useState<SamplePieceDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Completion form
  const [image, setImage] = useState('');
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [notes, setNotes] = useState('');

  const effectiveRole = user?.staffRole || user?.role || '';
  const canWrite = can(effectiveRole as any, 'production.samplePieces');
  const canApprove = can(effectiveRole as any, 'production.designs.approve');

  const loadPiece = useCallback(async () => {
    if (!id) return;
    try {
      const snap = await getDoc(doc(db, 'samplePieces', id));
      if (snap.exists()) {
        const p = snap.data() as SamplePieceDoc;
        setPiece(p);
        setImage(p.image || '');
        setImagePath(p.imagePath || null);
        setNotes(p.notes || '');
      }
    } catch (err) {
      console.error('Failed to load sample piece:', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadPiece(); }, [loadPiece]);

  const callFn = async (fnName: string, data: Record<string, unknown>) => {
    setActing(true);
    setToast(null);
    try {
      const fn = httpsCallable(functions, fnName);
      await fn(data);
      setToast({ type: 'success', message: 'Action completed.' });
      await loadPiece();
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

  if (!piece) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-gray-500">Sample piece not found.</p>
        <button onClick={() => navigate('/production/sample-pieces')} className="mt-4 text-sm text-black underline">
          Back to Sample Pieces
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 md:p-8 max-w-4xl">
      <button
        onClick={() => navigate('/production/sample-pieces')}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-black transition-colors mb-6"
      >
        <ArrowLeft size={16} />
        Back to Sample Pieces
      </button>

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div className="flex items-center gap-4">
          {piece.image ? (
            <img src={piece.image} alt="" className="w-16 h-16 rounded-xl object-cover bg-gray-100" />
          ) : (
            <div className="w-16 h-16 bg-gray-100 rounded-xl flex items-center justify-center">
              <Shirt size={24} className="text-gray-400" />
            </div>
          )}
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-display text-black tracking-wide">{piece.id}</h1>
              <span className={`inline-flex items-center px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md ${STATUS_COLORS[piece.status]}`}>
                {piece.status}
              </span>
            </div>
            <p className="text-xs text-gray-500 font-mono mt-1">Design: {piece.designId}</p>
          </div>
        </div>
      </div>

      {/* In-work → Complete form */}
      {piece.status === 'IN_WORK' && canWrite && (
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mb-6">
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">Mark Garment Complete</h2>
          <div className="space-y-4">
            <div>
              <PhotoUploadField
                storagePathPrefix="production/samplePieces"
                uid={user?.id || ''}
                value={image}
                imagePath={imagePath}
                onChange={(url, path) => { setImage(url); setImagePath(path); }}
                label="Completed Garment Photo"
                required
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Notes (optional)</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
            </div>
            <button
              disabled={acting || !image.trim()}
              onClick={() => callFn('samplePieceComplete', { id: piece.id, image: image.trim(), imagePath: imagePath || undefined, notes: notes.trim() || undefined })}
              className="flex items-center gap-2 px-4 py-2 bg-amber-500 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-colors"
            >
              {acting ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
              Mark Complete
            </button>
          </div>
        </div>
      )}

      {/* Actions */}
      {piece.status === 'COMPLETE' && canApprove && (
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mb-6">
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">Approval</h2>
          <button
            disabled={acting}
            onClick={() => callFn('samplePieceApprove', { id: piece.id })}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
          >
            {acting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Approve for Catalogue
          </button>
        </div>
      )}

      {/* Details */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6">
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">Details</h2>
        <div className="space-y-3 text-sm">
          {piece.notes && <p className="text-gray-600">{piece.notes}</p>}
          {piece.sampleDesignId && (
            <p className="text-gray-500">
              <span className="font-medium">Based on Sample Design:</span> {piece.sampleDesignId}
            </p>
          )}
          <div className="flex items-center gap-2 text-gray-500">
            <User size={14} />
            Created by {piece.createdByName || piece.createdBy}
          </div>
          <div className="flex items-center gap-2 text-gray-500">
            <Clock size={14} />
            {new Date(piece.createdAt).toLocaleDateString()}
          </div>
          {piece.approvedByName && (
            <div className="flex items-center gap-2 text-emerald-600">
              <Check size={14} />
              Approved by {piece.approvedByName} on {piece.approvedAt ? new Date(piece.approvedAt).toLocaleDateString() : '—'}
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