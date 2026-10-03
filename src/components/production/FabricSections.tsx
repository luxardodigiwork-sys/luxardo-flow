import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, orderBy, query } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { Layers, Loader2, Plus, Save, Send, Trash2 } from 'lucide-react';
import { db, functions } from '../../firebase';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';

const card = 'bg-white border border-gray-200 rounded-2xl shadow-sm p-6';
const h2 = 'flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-gray-400 mb-4';
const btn = 'inline-flex items-center gap-2 px-4 py-2 bg-black text-white text-[10px] font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-40';
const inputCls = 'px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20';

/**
 * Design page: the fixed fabric requirement per piece for this design.
 * Editable by Designer / Dispatch / Owner / Admin ('production.fabric.guide').
 */
export function DesignFabricGuideSection({ designId }: { designId: string }) {
  const { user } = useAuth();
  const role = (user?.staffRole || '') as any;
  const canEdit = can(role, 'production.fabric.guide');
  const [fabrics, setFabrics] = useState<any[]>([]);
  const [lines, setLines] = useState<Array<{ fabricId: string; metersPerPiece: string }>>([]);
  const [saved, setSaved] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [g, f] = await Promise.all([
        getDoc(doc(db, 'designFabricGuides', designId)),
        getDocs(query(collection(db, 'fabricMasters'), orderBy('name'))),
      ]);
      setFabrics(f.docs.map(d => d.data()).filter(x => x.active !== false));
      const data = g.exists() ? g.data() : null;
      setSaved(data);
      setLines((data?.lines || []).map((l: any) => ({ fabricId: l.fabricId, metersPerPiece: String(l.metersPerPiece) })));
    } catch (err) {
      console.error('Failed to load fabric guide:', err);
    }
  }, [designId]);

  useEffect(() => { if (can(role, 'production.fabric')) load(); }, [load, role]);

  if (!can(role, 'production.fabric')) return null;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await httpsCallable(functions, 'designFabricGuideSet')({
        designId,
        lines: lines.map(l => ({ fabricId: l.fabricId, metersPerPiece: Number(l.metersPerPiece) })),
      });
      setMsg({ ok: true, text: 'Fabric per piece saved.' });
      await load();
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Save failed.' });
    } finally {
      setBusy(false);
    }
  };

  const valid = lines.length > 0 && lines.every(l => l.fabricId && Number(l.metersPerPiece) > 0);

  return (
    <div className={card} data-testid="fabric-guide-section">
      <h2 className={h2}><Layers size={14} /> Fabric per piece</h2>
      {!canEdit && (
        saved?.lines?.length ? (
          <ul className="text-sm space-y-1">
            {saved.lines.map((l: any) => <li key={l.fabricId}>{l.fabricName}: <b>{l.metersPerPiece} m</b> per piece</li>)}
          </ul>
        ) : <p className="text-sm text-gray-400">Not set yet.</p>
      )}
      {canEdit && (
        <div className="space-y-2">
          {fabrics.length === 0 && <p className="text-sm text-gray-400">No fabrics in inventory yet. Dispatch adds them on the <Link to="/production/fabric" className="underline">Fabric Inventory</Link> page.</p>}
          {lines.map((l, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select className={inputCls} value={l.fabricId} data-testid={`guide-fabric-${i}`}
                onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, fabricId: e.target.value } : x))}>
                <option value="">Select fabric…</option>
                {fabrics.map(f => <option key={f.id} value={f.id}>{f.name} ({f.id})</option>)}
              </select>
              <input className={`${inputCls} w-32`} placeholder="Meters / piece" inputMode="decimal" value={l.metersPerPiece} data-testid={`guide-meters-${i}`}
                onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, metersPerPiece: e.target.value } : x))} />
              <button type="button" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-600" aria-label="Remove fabric line"><Trash2 size={14} /></button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" disabled={fabrics.length === 0} onClick={() => setLines(ls => [...ls, { fabricId: '', metersPerPiece: '' }])}
              className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest underline disabled:opacity-40"><Plus size={12} /> Add fabric</button>
            <button type="button" disabled={busy || !valid} onClick={save} className={btn}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save fabric per piece
            </button>
          </div>
        </div>
      )}
      {msg && <p className={`mt-3 text-xs ${msg.ok ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</p>}
    </div>
  );
}

/**
 * Production Request page: fabric needed (guide x ordered qty) and the
 * Dispatch action to issue it to a Guard. Stock is deducted by the server.
 */
export function PrFabricIssueSection({ pr, onChanged }: { pr: any; onChanged?: () => void }) {
  const { user } = useAuth();
  const role = (user?.staffRole || '') as any;
  const canSee = can(role, 'production.fabric.issues') || can(role, 'production.fabric');
  const canIssue = can(role, 'production.fabric.manage');
  const [guide, setGuide] = useState<any | null>(null);
  const [stock, setStock] = useState<Record<string, number>>({});
  const [issue, setIssue] = useState<any | null>(null);
  const [guards, setGuards] = useState<Array<{ uid: string; name: string }>>([]);
  const [guardUid, setGuardUid] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const live = pr?.originalQtyFrozen && ['APPROVED', 'IN_PRODUCTION'].includes(pr?.status);
  const qty = Number(pr?.originalOrderedQty) || 0;

  const load = useCallback(async () => {
    if (!pr?.id) return;
    try {
      const g = await getDoc(doc(db, 'designFabricGuides', pr.designId));
      const gd = g.exists() ? g.data() : null;
      setGuide(gd);
      if (pr.fabricIssueId) {
        const i = await getDoc(doc(db, 'fabricIssues', pr.fabricIssueId));
        setIssue(i.exists() ? i.data() : null);
      } else {
        setIssue(null);
        if (gd?.lines?.length && can(role, 'production.fabric')) {
          const snaps = await Promise.all(gd.lines.map((l: any) => getDoc(doc(db, 'fabricMasters', l.fabricId))));
          const s: Record<string, number> = {};
          snaps.forEach(x => { if (x.exists()) s[x.id] = Number(x.data().stockMeters) || 0; });
          setStock(s);
        }
        if (canIssue && live) {
          const r: any = await httpsCallable(functions, 'listActiveGuards')({});
          setGuards(r.data.guards || []);
        }
      }
    } catch (err) {
      console.error('Failed to load PR fabric:', err);
    }
  }, [pr?.id, pr?.designId, pr?.fabricIssueId, canIssue, live, role]);

  useEffect(() => { if (canSee) load(); }, [canSee, load]);

  if (!canSee || !pr?.originalQtyFrozen) return null;

  const doIssue = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r: any = await httpsCallable(functions, 'fabricIssueCreate')({ prId: pr.id, guardUid });
      const low = r.data.lowStockAlerts || [];
      setMsg({ ok: true, text: `Fabric issued (${r.data.id}).${low.length ? ` Low stock now: ${low.join(', ')} — Dispatch and Owner alerted.` : ''}` });
      onChanged?.();
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Issue failed.' });
    } finally {
      setBusy(false);
    }
  };

  const req = (guide?.lines || []).map((l: any) => ({ ...l, meters: Math.round(l.metersPerPiece * qty * 100) / 100 }));
  const short = req.some((l: any) => stock[l.fabricId] !== undefined && stock[l.fabricId] < l.meters);

  return (
    <div className={card} data-testid="pr-fabric-section">
      <h2 className={h2}><Layers size={14} /> Fabric</h2>
      {issue ? (
        <div className="text-sm space-y-1">
          <p><Link to="/production/fabric-issues" className="font-mono underline">{issue.id}</Link> · {issue.totalMeters} m issued to <b>{issue.issuedToName}</b> by {issue.issuedByName}</p>
          {(issue.lines || []).map((l: any) => <p key={l.fabricId} className="text-gray-600">{l.fabricName}: {l.metersPerPiece} m × {l.qty} = <b>{l.meters} m</b></p>)}
          <p className={issue.status === 'RECEIVED' ? 'text-green-700 text-xs font-bold uppercase' : 'text-amber-700 text-xs font-bold uppercase'}>
            {issue.status === 'RECEIVED' ? `Received by ${issue.receivedByName}` : 'Waiting for Guard to confirm receipt'}
          </p>
        </div>
      ) : !req.length ? (
        <p className="text-sm text-gray-400">This design has no “fabric per piece” yet. Set it on the <Link to={`/production/designs/${pr.designId}`} className="underline">design page</Link> before issuing fabric.</p>
      ) : (
        <div className="space-y-3">
          <ul className="text-sm space-y-1">
            {req.map((l: any) => (
              <li key={l.fabricId} className="flex flex-wrap justify-between gap-2">
                <span>{l.fabricName}: {l.metersPerPiece} m × {qty} = <b>{l.meters} m</b></span>
                {stock[l.fabricId] !== undefined && (
                  <span className={stock[l.fabricId] < l.meters ? 'text-red-600 text-xs' : 'text-gray-400 text-xs'}>in stock {stock[l.fabricId]} m</span>
                )}
              </li>
            ))}
          </ul>
          {short && <p className="text-xs text-red-600">Not enough stock — add fabric on the Fabric Inventory page first.</p>}
          {canIssue && live && (
            <div className="flex flex-wrap gap-2 items-center">
              <select className={inputCls} value={guardUid} onChange={e => setGuardUid(e.target.value)} data-testid="issue-guard-select">
                <option value="">Issue to Guard…</option>
                {guards.map(g => <option key={g.uid} value={g.uid}>{g.name}</option>)}
              </select>
              <button disabled={busy || !guardUid || short} onClick={doIssue} className={btn}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Issue fabric
              </button>
            </div>
          )}
        </div>
      )}
      {msg && <p className={`mt-3 text-xs ${msg.ok ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</p>}
    </div>
  );
}
