import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../firebase';
import { ArrowLeft, Loader2, Plus, X } from 'lucide-react';

export default function FabricCreatePage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [name, setName] = useState('');
  const [gsm, setGsm] = useState<number>(120);
  const [colour, setColour] = useState('');
  const [colourCode, setColourCode] = useState('');
  const [notes, setNotes] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !colour.trim() || !gsm) return;
    setCreating(true);
    setToast(null);

    try {
      const fabricMasterCreateFn = httpsCallable(functions, 'fabricMasterCreate');
      const result = await fabricMasterCreateFn({
        name: name.trim(),
        gsm,
        colour: colour.trim(),
        colourCode: colourCode.trim() || undefined,
        notes: notes.trim() || undefined,
      });

      setToast({ type: 'success', message: `Fabric "${name.trim()}" created (ID: ${(result.data as any).id}).` });
      setTimeout(() => navigate('/production/fabric'), 1200);
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Failed to create fabric.' });
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen p-6 md:p-8 max-w-2xl">
      <button
        onClick={() => navigate('/production/fabric')}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-black transition-colors mb-6"
      >
        <ArrowLeft size={16} />
        Back to Fabric Inventory
      </button>

      <h1 className="text-2xl font-display text-black tracking-wide mb-8">Add Fabric</h1>

      <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 space-y-6">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Fabric Name *</label>
          <input type="text" required value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. Cotton Poplin"
            className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">GSM *</label>
            <input type="number" required min={1} value={gsm} onChange={e => setGsm(Number(e.target.value))}
              className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Colour *</label>
            <input type="text" required value={colour} onChange={e => setColour(e.target.value)} placeholder="e.g. Ivory"
              className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Colour Code (optional)</label>
          <div className="flex items-center gap-3">
            <input type="text" value={colourCode} onChange={e => setColourCode(e.target.value)} placeholder="#F5F0E6"
              className="flex-1 px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
            {colourCode && (
              <span className="w-10 h-10 rounded-lg border border-gray-200 shrink-0" style={{ backgroundColor: colourCode }} />
            )}
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Notes (optional)</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
        </div>

        <p className="text-[10px] text-gray-400">Stock starts at 0m — use "Receive Stock" on the fabric's detail page to add it.</p>

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={() => navigate('/production/fabric')}
            className="px-5 py-2.5 text-sm text-gray-500 hover:text-black transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={creating || !name.trim() || !colour.trim() || !gsm}
            className="flex items-center gap-2 px-6 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors">
            {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {creating ? 'Creating…' : 'Create Fabric'}
          </button>
        </div>
      </form>

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
