import React, { useState, useEffect, useCallback } from 'react';
import { db, functions, storage } from '../../firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { Scissors, Loader2, Camera, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';

export default function TailorWorkspacePage() {
  const { user } = useAuth();
  const effectiveRole = (user?.staffRole || '') as any;
  // 'production.tailor' = read-only view of the Tailor pipeline (includes
  // pm, per the Final V1 Role Matrix); 'production.tailor.startComplete' =
  // actually starting/completing stitching, strictly tailor-only (matches
  // tailorStartStitching/tailorCompleteStitching's server gate) — kept
  // separate so a viewer can never see an action the server would reject.
  const canView = can(effectiveRole, 'production.tailor');
  const canWork = can(effectiveRole, 'production.tailor.startComplete');

  const [pieces, setPieces] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  // Storage path of a photo uploaded from the device (camera/gallery). The
  // backend (tailorCompleteStitching) already accepts garmentImagePath.
  const [imagePath, setImagePath] = useState<Record<string, string>>({});
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  /* Tailors work from a phone: let them take/choose a photo instead of
   * pasting a URL. Uploads to production/tailor/{uid}/{pieceId}/… — the
   * self-scoped path in storage.loom.rules (image, <10 MB). */
  const uploadPhoto = async (pieceId: string, file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('Please choose a photo (image file).'); return; }
    if (file.size >= 10 * 1024 * 1024) { setError('Photo is too large (max 10 MB).'); return; }
    setUploadingId(pieceId);
    setError(null);
    try {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `production/tailor/${user?.id}/${pieceId}/${Date.now()}.${ext}`;
      const r = storageRef(storage, path);
      await uploadBytes(r, file, { contentType: file.type });
      const url = await getDownloadURL(r);
      setImageUrl((s) => ({ ...s, [pieceId]: url }));
      setImagePath((s) => ({ ...s, [pieceId]: path }));
    } catch (err: any) {
      console.error('Garment photo upload failed:', err);
      setError(err?.message || 'Photo upload failed. Try again.');
    } finally {
      setUploadingId(null);
    }
  };

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    setError(null);
    try {
      // An actual Tailor sees only pieces assigned to them (their own
      // worklist). A view-only visitor (e.g. pm) has no assignedTailorUid
      // pieces at all, so instead show the whole Tailor-stage pipeline —
      // 'pieces' read access is already role-gated (not per-document) in
      // firestore.loom.rules, so this is not a wider grant than intended.
      const data = canWork
        ? (await Promise.all([
            getDocs(query(collection(db, 'pieces'), where('assignedTailorUid', '==', user.id), where('stage', '==', 'TAILOR_ASSIGNED'))),
            getDocs(query(collection(db, 'pieces'), where('assignedTailorUid', '==', user.id), where('stage', '==', 'STITCHING'))),
          ])).flatMap((snap) => snap.docs).map((d) => d.data())
        : (await getDocs(query(collection(db, 'pieces'), where('stage', 'in', ['TAILOR_ASSIGNED', 'STITCHING'])))).docs.map((d) => d.data());
      data.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      setPieces(data);
    } catch (err: any) {
      console.error('Failed to load Tailor workspace:', err);
      setError(err?.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [user?.id, canWork]);

  useEffect(() => { load(); }, [load]);

  const startStitching = async (pieceId: string) => {
    setBusyId(pieceId);
    setError(null);
    try {
      await httpsCallable(functions, 'tailorStartStitching')({ pieceId });
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to start stitching.');
    } finally {
      setBusyId(null);
    }
  };

  const completeStitching = async (pieceId: string) => {
    const url = (imageUrl[pieceId] || '').trim();
    if (!url) {
      setError('A garment photo is mandatory to complete stitching.');
      return;
    }
    setBusyId(pieceId);
    setError(null);
    try {
      await httpsCallable(functions, 'tailorCompleteStitching')({
        pieceId, garmentImageUrl: url, note: note[pieceId] || '',
        ...(imagePath[pieceId] ? { garmentImagePath: imagePath[pieceId] } : {}),
      });
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to complete stitching.');
    } finally {
      setBusyId(null);
    }
  };

  if (!canView) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-gray-500">You do not have permission to access the Tailor workspace.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 md:p-8">
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-black text-white rounded-xl flex items-center justify-center">
            <Scissors size={18} />
          </div>
          <div>
            <h1 className="text-2xl font-display text-black tracking-wide">Tailor Workspace</h1>
            <p className="text-xs text-gray-500 font-sans mt-1">
              {pieces.length} piece{pieces.length === 1 ? '' : 's'} {canWork ? 'assigned to you' : 'in the Tailor pipeline'}{loading && ' · loading…'}
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
      ) : pieces.length === 0 ? (
        <div className="text-center py-24">
          <Scissors size={32} className="mx-auto text-gray-300 mb-3" />
          <p className="text-sm text-gray-500">{canWork ? 'No pieces are currently assigned to you.' : 'No pieces are currently in the Tailor pipeline.'}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {pieces.map((piece) => (
            <div key={piece.id} className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="font-mono text-xs font-medium text-black">{piece.id}</span>
                <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest rounded-md bg-indigo-50 text-indigo-600">
                  {piece.stage}
                </span>
              </div>
              {canWork && piece.stage === 'TAILOR_ASSIGNED' && (
                <button
                  disabled={busyId === piece.id}
                  onClick={() => startStitching(piece.id)}
                  className="px-4 py-2 bg-black text-white rounded-lg text-[10px] font-bold uppercase tracking-widest hover:opacity-80 transition-opacity disabled:opacity-30"
                >
                  Start Stitching
                </button>
              )}
              {canWork && piece.stage === 'STITCHING' && (
                <div className="space-y-2">
                  <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                    <Camera size={12} /> Garment Photo (mandatory)
                  </label>
                  <label className={`flex items-center justify-center gap-2 w-full px-4 py-3 border-2 border-dashed rounded-lg text-xs cursor-pointer transition-colors ${imageUrl[piece.id] ? 'border-green-300 bg-green-50 text-green-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
                    {uploadingId === piece.id ? (
                      <><Loader2 size={14} className="animate-spin" /> Uploading photo…</>
                    ) : imageUrl[piece.id] ? (
                      <><CheckCircle2 size={14} /> Photo added — tap to change</>
                    ) : (
                      <><Camera size={14} /> Take / choose photo</>
                    )}
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      data-testid={`garment-photo-${piece.id}`}
                      disabled={uploadingId === piece.id}
                      onChange={(e) => { uploadPhoto(piece.id, e.target.files?.[0]); e.target.value = ''; }}
                    />
                  </label>
                  {imageUrl[piece.id] && (
                    <img src={imageUrl[piece.id]} alt="Garment" className="h-24 w-24 object-cover rounded-lg border border-gray-200" />
                  )}
                  <input
                    type="text"
                    placeholder="…or paste image link (optional)"
                    className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2"
                    value={imagePath[piece.id] ? '' : (imageUrl[piece.id] || '')}
                    onChange={(e) => {
                      setImageUrl((s) => ({ ...s, [piece.id]: e.target.value }));
                      setImagePath((s) => { const n = { ...s }; delete n[piece.id]; return n; });
                    }}
                  />
                  <input
                    type="text"
                    placeholder="Note (optional)"
                    className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2"
                    value={note[piece.id] || ''}
                    onChange={(e) => setNote((s) => ({ ...s, [piece.id]: e.target.value }))}
                  />
                  <button
                    disabled={busyId === piece.id || uploadingId === piece.id}
                    onClick={() => completeStitching(piece.id)}
                    className="px-4 py-2 bg-black text-white rounded-lg text-[10px] font-bold uppercase tracking-widest hover:opacity-80 transition-opacity disabled:opacity-30"
                  >
                    Complete Stitching
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
