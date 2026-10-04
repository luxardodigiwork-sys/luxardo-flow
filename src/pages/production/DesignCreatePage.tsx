import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../firebase';
import { ArrowLeft, Loader2, Plus, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import PhotoUploadField from '../../components/production/PhotoUploadField';

export default function DesignCreatePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [image, setImage] = useState('');
  const [imagePath, setImagePath] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setToast(null);

    try {
      const fn = httpsCallable(functions, 'designCreate');
      const result = await fn({
        name: name.trim(),
        description: description.trim() || undefined,
        image: image.trim() || undefined,
        imagePath: imagePath || undefined,
      });

      setToast({ type: 'success', message: `Design "${name.trim()}" created (ID: ${(result.data as any).id}).` });
      setTimeout(() => navigate('/production/designs'), 1200);
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Failed to create design.' });
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen p-6 md:p-8 max-w-2xl">
      <button
        onClick={() => navigate('/production/designs')}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-black transition-colors mb-6"
      >
        <ArrowLeft size={16} />
        Back to Designs
      </button>

      <h1 className="text-2xl font-display text-black tracking-wide mb-8">New Catalogue Design</h1>

      <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 space-y-6">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Design Name *</label>
          <input type="text" required value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. Paisley Stripe, Geometric Wave"
            className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
        </div>

        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Description (optional)</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
            placeholder="Brief description of the design pattern…"
            className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
        </div>

        <div>
          <PhotoUploadField
            storagePathPrefix="production/designs"
            uid={user?.id || ''}
            value={image}
            imagePath={imagePath}
            onChange={(url, path) => { setImage(url); setImagePath(path); }}
            label="Design Photo (optional)"
          />
          <p className="text-[10px] text-gray-400 mt-1">Primary image for the design. Additional images can be added later.</p>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={() => navigate('/production/designs')}
            className="px-5 py-2.5 text-sm text-gray-500 hover:text-black transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={creating || !name.trim()}
            className="flex items-center gap-2 px-6 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors">
            {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {creating ? 'Creating…' : 'Create Design'}
          </button>
        </div>
      </form>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-4 rounded-xl shadow-xl ${
          toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          <span className="text-sm">{toast.message}</span>
          <button onClick={() => setToast(null)} className="ml-2 text-white/70 hover:text-white"><X size={16} /></button>
        </div>
      )}
    </div>
  );
}
