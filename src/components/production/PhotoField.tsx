import React, { useState } from 'react';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { Camera, CheckCircle2, Loader2 } from 'lucide-react';
import { storage } from '../../firebase';
import { useAuth } from '../../context/AuthContext';

/**
 * Camera / gallery photo picker with an optional pasted-link fallback.
 * Uploads to production/uploads/{uid}/{folder}/{timestamp}.{ext} — a
 * self-scoped path in storage.loom.rules (image only, < 10 MB), so it works
 * for every signed-in staff role without a cross-service role lookup.
 * The calling page still sends the resulting URL to its callable, which
 * re-checks the caller's role server-side.
 */
export default function PhotoField({
  label,
  value,
  onChange,
  folder,
  required = false,
  testId,
}: {
  label: string;
  value: string;
  onChange: (url: string) => void;
  folder: string;
  required?: boolean;
  testId?: string;
}) {
  const { user } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [uploaded, setUploaded] = useState(false);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('Please choose a photo (image file).'); return; }
    if (file.size >= 10 * 1024 * 1024) { setError('Photo is too large (max 10 MB).'); return; }
    if (!user?.id) { setError('Please sign in again.'); return; }
    setUploading(true);
    setError('');
    try {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const r = storageRef(storage, `production/uploads/${user.id}/${folder}/${Date.now()}.${ext}`);
      await uploadBytes(r, file, { contentType: file.type });
      onChange(await getDownloadURL(r));
      setUploaded(true);
    } catch (err: any) {
      console.error('Photo upload failed:', err);
      setError(err?.message || 'Photo upload failed. Try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-2">
      <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500">
        {label} {required ? <span className="text-red-500">(required)</span> : <span className="text-gray-400">(optional)</span>}
      </label>
      <label className={`flex items-center justify-center gap-2 w-full px-4 py-3 border-2 border-dashed rounded-xl text-xs cursor-pointer transition-colors ${value ? 'border-green-300 bg-green-50 text-green-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
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
          data-testid={testId}
          disabled={uploading}
          onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }}
        />
      </label>
      {value && <img src={value} alt={label} className="h-24 w-24 object-cover rounded-lg border border-gray-200" />}
      <input
        type="url"
        placeholder="…or paste image link"
        value={uploaded ? '' : value}
        onChange={(e) => { setUploaded(false); onChange(e.target.value); }}
        className="w-full px-4 py-2 text-xs border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20"
      />
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
