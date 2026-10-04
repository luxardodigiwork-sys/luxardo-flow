import React, { useState } from 'react';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../../firebase';
import { Camera, Loader2, CheckCircle2 } from 'lucide-react';

/**
 * Mobile-first camera/gallery photo upload, factored out of the proven
 * Tailor Workspace pattern (TailorWorkspacePage.tsx's garment-photo upload)
 * so Design / Sample Design / Sample Piece reuse the exact same upload
 * logic instead of re-implementing it. A single `<input type="file"
 * accept="image/*" capture="environment">` gives camera capture on mobile
 * and falls back to a normal file/gallery picker on desktop — one input
 * covers both required interaction modes.
 *
 * Client-side validation (image/*, <10 MB) mirrors the storage.loom.rules
 * isImage()+maxSize(10) boundary already enforced server-side for every
 * production/{designs,sampleDesigns,samplePieces}/** path, so a rejected
 * upload fails fast instead of round-tripping to Storage first.
 *
 * Uploads to `${storagePathPrefix}/${uid}/${Date.now()}.{ext}` — scoped to
 * the authenticated user, matching Tailor's own uid-scoped path shape
 * (production/tailor/{uid}/{pieceId}/...). The manual "paste a URL" input
 * is kept alongside the upload button (same as Tailor) so existing
 * image-URL compatibility is preserved — a pasted URL carries no storage
 * path (`path` is null), only an uploaded photo does.
 */
export interface PhotoUploadFieldProps {
  /** Storage path prefix, e.g. 'production/designs' — must match an
   *  existing storage.loom.rules match block. */
  storagePathPrefix: string;
  uid: string;
  /** Current image URL (uploaded download URL or a manually pasted one). */
  value: string;
  /** Current storage path, if `value` came from an upload (null if pasted
   *  or empty) — controls whether the paste box echoes the (long) download
   *  URL back at the user. */
  imagePath?: string | null;
  onChange: (url: string, path: string | null) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  /** Show the manual "paste a URL" fallback input. Default true. */
  allowUrlPaste?: boolean;
}

export default function PhotoUploadField({
  storagePathPrefix,
  uid,
  value,
  imagePath,
  onChange,
  label = 'Photo',
  required,
  disabled,
  allowUrlPaste = true,
}: PhotoUploadFieldProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('Please choose a photo (image file).'); return; }
    if (file.size >= 10 * 1024 * 1024) { setError('Photo is too large (max 10 MB).'); return; }
    setUploading(true);
    setError('');
    try {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `${storagePathPrefix}/${uid}/${Date.now()}.${ext}`;
      const r = storageRef(storage, path);
      await uploadBytes(r, file, { contentType: file.type });
      const url = await getDownloadURL(r);
      onChange(url, path);
    } catch (err: any) {
      console.error('Photo upload failed:', err);
      setError(err?.message || 'Photo upload failed. Try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500">
        <Camera size={12} /> {label}{required && <span className="text-red-500 ml-1">(required)</span>}
      </label>
      <label className={`flex items-center justify-center gap-2 w-full px-4 py-3 border-2 border-dashed rounded-lg text-xs transition-colors ${
        disabled
          ? 'opacity-50 cursor-not-allowed border-gray-200 text-gray-400'
          : value
            ? 'border-green-300 bg-green-50 text-green-700 cursor-pointer'
            : 'border-gray-300 text-gray-600 hover:bg-gray-50 cursor-pointer'
      }`}>
        {uploading ? (
          <><Loader2 size={14} className="animate-spin" /> Uploading photo…</>
        ) : value ? (
          <><CheckCircle2 size={14} /> Photo added — tap to change</>
        ) : (
          <><Camera size={14} /> Take / choose photo</>
        )}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          disabled={disabled || uploading}
          onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }}
        />
      </label>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {value && (
        <img src={value} alt="" className="h-24 w-24 object-cover rounded-lg border border-gray-200" />
      )}
      {allowUrlPaste && (
        <input
          type="text"
          placeholder="…or paste image link (optional)"
          disabled={disabled}
          className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2 disabled:bg-gray-50"
          value={imagePath ? '' : value}
          onChange={(e) => onChange(e.target.value, null)}
        />
      )}
    </div>
  );
}
