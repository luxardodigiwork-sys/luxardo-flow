import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { db, functions } from '../../firebase';
import { doc, getDoc, collection, query, orderBy, getDocs } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';
import {
  ArrowLeft, Loader2, Send, Check, X, Clock, User, FileText,
  Pencil, AlertCircle, Package, ChevronRight
} from 'lucide-react';
import type { ProductionRequestDoc, PRAuditDoc } from '../../types/production';
import { useScrollLock } from '../../utils/useScrollLock';
import { PrFabricIssueSection } from '../../components/production/FabricSections';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  SUBMITTED: 'bg-amber-50 text-amber-600',
  PENDING_APPROVAL: 'bg-amber-50 text-amber-600',
  APPROVED: 'bg-emerald-50 text-emerald-600',
  IN_PRODUCTION: 'bg-blue-50 text-blue-600',
  COMPLETED: 'bg-teal-50 text-teal-600',
  REJECTED_BY_OWNER: 'bg-red-50 text-red-500',
  CANCELLED: 'bg-gray-100 text-gray-400',
};

const URGENCY_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;

export default function ProductionRequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [request, setRequest] = useState<ProductionRequestDoc | null>(null);
  const [audits, setAudits] = useState<PRAuditDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Edit state
  const [quantity, setQuantity] = useState<number>(0);
  const [urgency, setUrgency] = useState<'HIGH' | 'MEDIUM' | 'LOW'>('MEDIUM');
  const [requiredDate, setRequiredDate] = useState('');
  const [garmentType, setGarmentType] = useState('');

  // Reject dialog
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  // Post-approval edit dialog
  const [showPostEdit, setShowPostEdit] = useState(false);
  const [postUrgency, setPostUrgency] = useState<'HIGH' | 'MEDIUM' | 'LOW'>('MEDIUM');
  const [postRequiredDate, setPostRequiredDate] = useState('');

  // Generate Pieces dialog
  const [showGenerate, setShowGenerate] = useState(false);
  const [genCount, setGenCount] = useState<number>(0);

  useScrollLock(showReject || showPostEdit || showGenerate);

  const effectiveRole = user?.staffRole || user?.role || '';
  const isPM = effectiveRole === 'pm';
  const canEdit = can(effectiveRole as any, 'production.requests.edit');
  const canApprove = can(effectiveRole as any, 'production.requests.approve');
  const canReject = can(effectiveRole as any, 'production.requests.reject');
  // Submit is allowed for the creator roles (dispatch/admin/owner), not PM
  const canSubmit = can(effectiveRole as any, 'production.requests') && !isPM;
  const canGeneratePieces = can(effectiveRole as any, 'production.pieces');

  const loadRequest = useCallback(async () => {
    if (!id) return;
    try {
      const snap = await getDoc(doc(db, 'productionRequests', id));
      if (snap.exists()) {
        const r = snap.data() as ProductionRequestDoc;
        setRequest(r);
        setQuantity(r.originalOrderedQty || 0);
        setUrgency(r.urgency || 'MEDIUM');
        setRequiredDate(r.requiredDate || '');
        setGarmentType(r.garmentType || '');
        setPostUrgency(r.urgency || 'MEDIUM');
        setPostRequiredDate(r.requiredDate || '');

        // Load post-approval audit trail
        try {
          const aq = query(collection(db, 'productionRequests', id, 'audit'), orderBy('at', 'desc'));
          const asnap = await getDocs(aq);
          setAudits(asnap.docs.map(a => a.data() as PRAuditDoc));
        } catch (err) {
          console.error('Failed to load PR audit:', err);
        }
      }
    } catch (err) {
      console.error('Failed to load production request:', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadRequest(); }, [loadRequest]);

  const callFn = async (fnName: string, data: Record<string, unknown>, successMsg?: string) => {
    setActing(true);
    setToast(null);
    try {
      const fn = httpsCallable(functions, fnName);
      await fn(data);
      setToast({ type: 'success', message: successMsg || 'Action completed.' });
      await loadRequest();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Action failed.' });
    } finally {
      setActing(false);
    }
  };

  const handleSaveEdits = async () => {
    setActing(true);
    setToast(null);
    try {
      const fn = httpsCallable(functions, 'prUpdate');
      await fn({
        id,
        quantity: quantity,
        urgency,
        requiredDate: requiredDate || undefined,
        garmentType: garmentType || undefined,
      });
      setToast({ type: 'success', message: 'Request updated.' });
      await loadRequest();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Failed to update request.' });
    } finally {
      setActing(false);
    }
  };

  const handlePostEdit = async () => {
    setActing(true);
    setToast(null);
    try {
      const fn = httpsCallable(functions, 'prEditApproved');
      await fn({
        id,
        urgency: postUrgency,
        requiredDate: postRequiredDate || undefined,
      });
      setShowPostEdit(false);
      setToast({ type: 'success', message: 'Approved request updated (audited).' });
      await loadRequest();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Failed to update approved request.' });
    } finally {
      setActing(false);
    }
  };

  const handleGeneratePieces = async () => {
    setActing(true);
    setToast(null);
    try {
      const fn = httpsCallable(functions, 'prGeneratePieces');
      await fn({ prId: request!.id, count: genCount || undefined });
      setShowGenerate(false);
      setToast({ type: 'success', message: `${genCount || 'All remaining'} piece(s) generated.` });
      await loadRequest();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Failed to generate pieces.' });
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

  if (!request) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-gray-500">Production request not found.</p>
        <button onClick={() => navigate('/production/requests')} className="mt-4 text-sm text-black underline">
          Back to Production Requests
        </button>
      </div>
    );
  }

  const isEditable = !request.originalQtyFrozen && !['APPROVED', 'IN_PRODUCTION', 'COMPLETED'].includes(request.status);
  // APPROVED and IN_PRODUCTION are both live, Owner-approved states (status
  // auto-advances to IN_PRODUCTION once pieces start moving).
  const isApproved = request.originalQtyFrozen && ['APPROVED', 'IN_PRODUCTION'].includes(request.status);

  return (
    <div className="min-h-screen p-6 md:p-8 max-w-4xl">
      <button
        onClick={() => navigate('/production/requests')}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-black transition-colors mb-6"
      >
        <ArrowLeft size={16} />
        Back to Production Requests
      </button>

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 bg-gray-100 rounded-xl flex items-center justify-center">
            <FileText size={24} className="text-gray-400" />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-display text-black tracking-wide">{request.id}</h1>
              <span className={`inline-flex items-center px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md ${STATUS_COLORS[request.status]}`}>
                {request.status}
              </span>
            </div>
            <p className="text-xs text-gray-500 font-mono mt-1">
              {request.designId || '—'} · {request.designVersionId || ''}
            </p>
          </div>
        </div>

        {/* Workflow actions */}
        <div className="flex flex-wrap gap-2">
          {isEditable && canEdit && (
            <button
              disabled={acting}
              onClick={handleSaveEdits}
              className="flex items-center gap-2 px-4 py-2 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
            >
              {acting ? <Loader2 size={14} className="animate-spin" /> : <Pencil size={14} />}
              Save Edits
            </button>
          )}

          {isEditable && canSubmit && request.status !== 'SUBMITTED' && request.status !== 'PENDING_APPROVAL' && (
            <button
              disabled={acting}
              onClick={() => callFn('prSubmit', { id: request.id }, 'Request submitted for Owner approval.')}
              className="flex items-center gap-2 px-4 py-2 bg-amber-500 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-colors"
            >
              {acting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Submit
            </button>
          )}

          {(request.status === 'SUBMITTED' || request.status === 'PENDING_APPROVAL') && canApprove && (
            <button
              disabled={acting}
              onClick={() => callFn('prApprove', { id: request.id }, 'Request approved. Quantity + design version frozen.')}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            >
              {acting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Approve
            </button>
          )}

          {(request.status === 'SUBMITTED' || request.status === 'PENDING_APPROVAL') && canReject && (
            <button
              disabled={acting}
              onClick={() => setShowReject(true)}
              className="flex items-center gap-2 px-4 py-2 bg-red-500 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-red-600 disabled:opacity-50 transition-colors"
            >
              <X size={14} />
              Reject
            </button>
          )}

          {isApproved && canApprove && (
            <button
              disabled={acting}
              onClick={() => setShowPostEdit(true)}
              className="flex items-center gap-2 px-4 py-2 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
            >
              {acting ? <Loader2 size={14} className="animate-spin" /> : <Pencil size={14} />}
              Edit Urgency/Date
            </button>
          )}
        </div>
      </div>

      {/* Reject dialog */}
      {showReject && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 max-w-md w-full">
            <h3 className="text-lg font-display text-black tracking-wide mb-2">Reject {request.id}</h3>
            <p className="text-sm text-gray-500 mb-4">Rejection reason is mandatory and permanently recorded.</p>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              rows={3}
              placeholder="Why is this request rejected?"
              className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all"
            />
            <div className="flex justify-end gap-3 mt-4">
              <button onClick={() => { setShowReject(false); setRejectReason(''); }}
                className="px-4 py-2 text-sm text-gray-500 hover:text-black transition-colors">
                Cancel
              </button>
              <button
                disabled={acting || !rejectReason.trim()}
                onClick={() => {
                  const reason = rejectReason.trim();
                  setShowReject(false);
                  setRejectReason('');
                  callFn('prReject', { id: request.id, reason }, 'Request rejected.');
                }}
                className="flex items-center gap-2 px-4 py-2 bg-red-500 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-red-600 disabled:opacity-50 transition-colors"
              >
                {acting ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
                Confirm Reject
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Post-approval edit dialog */}
      {showPostEdit && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 max-w-md w-full">
            <h3 className="text-lg font-display text-black tracking-wide mb-2">Edit Approved Request</h3>
            <p className="text-sm text-gray-500 mb-4">Quantity + design version are frozen. Only urgency & required date, fully audited.</p>
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Urgency</label>
                <select
                  value={postUrgency}
                  onChange={e => setPostUrgency(e.target.value as 'HIGH' | 'MEDIUM' | 'LOW')}
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all bg-white"
                >
                  {URGENCY_LEVELS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Required By</label>
                <input
                  type="date"
                  value={postRequiredDate}
                  onChange={e => setPostRequiredDate(e.target.value)}
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button onClick={() => setShowPostEdit(false)}
                className="px-4 py-2 text-sm text-gray-500 hover:text-black transition-colors">
                Cancel
              </button>
              <button
                disabled={acting}
                onClick={handlePostEdit}
                className="flex items-center gap-2 px-4 py-2 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
              >
                {acting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Save (Audited)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit form (pre-approval) */}
      {isEditable && (
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mb-6">
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">Edit Request (pre-approval)</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Quantity</label>
              <input
                type="number"
                min={0}
                value={quantity}
                onChange={e => setQuantity(Math.max(0, Number(e.target.value)))}
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all"
              />
              <p className="text-[10px] text-amber-500 mt-1">Submit requires quantity &gt; 0.</p>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Urgency</label>
              <select
                value={urgency}
                onChange={e => setUrgency(e.target.value as 'HIGH' | 'MEDIUM' | 'LOW')}
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all bg-white"
              >
                {URGENCY_LEVELS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Required By</label>
              <input
                type="date"
                value={requiredDate}
                onChange={e => setRequiredDate(e.target.value)}
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Garment Type</label>
              <input
                type="text"
                value={garmentType}
                onChange={e => setGarmentType(e.target.value)}
                placeholder="e.g. Kurti"
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all"
              />
            </div>
          </div>
        </div>
      )}

      {/* Quantity panel (frozen after approval) */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mb-6">
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">
          Quantity {request.originalQtyFrozen && <span className="text-blue-500">· Frozen</span>}
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {([
            ['Ordered', request.originalOrderedQty],
            ['Pending', request.pendingQty],
            ['In Production', request.currentActiveQty],
            ['Completed', request.completedQty],
            ['Rework', request.reworkQty],
            ['Rejected', request.rejectedQty],
          ] as const).map(([label, value]) => (
            <div key={label} className="p-4 bg-gray-50 rounded-xl">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{label}</p>
              <p className="text-2xl font-display text-black mt-1">{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Generate Pieces (post-approval) */}
      {isApproved && canGeneratePieces && (
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mb-6">
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">Generate Pieces</h2>
          {(() => {
            const ordered = Number(request.originalOrderedQty) || 0;
            const generated = Number(request.piecesGeneratedCount) || 0;
            const remaining = Math.max(0, ordered - generated);
            return (
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-baseline gap-3">
                    <span className="text-3xl font-display text-black">{remaining}</span>
                    <span className="text-xs text-gray-500">remaining of {ordered} ordered</span>
                  </div>
                  <p className="text-[10px] text-gray-400 uppercase tracking-widest mt-1">{generated} already generated</p>
                </div>
                {remaining > 0 && (
                  <button
                    disabled={acting}
                    onClick={() => { setGenCount(remaining); setShowGenerate(true); }}
                    className="flex items-center gap-2 px-5 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors shrink-0"
                  >
                    <Package size={14} />
                    Generate Pieces ({remaining})
                  </button>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Generate Pieces dialog */}
      {showGenerate && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 max-w-md w-full">
            <h3 className="text-lg font-display text-black tracking-wide mb-2">Generate Pieces</h3>
            <p className="text-sm text-gray-500 mb-4">
              Create physical PIECE records for this approved request. Quantity is immutable and frozen.
            </p>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Number of pieces</label>
              <input
                type="number"
                min={1}
                max={Number(request.originalOrderedQty) - (Number(request.piecesGeneratedCount) || 0)}
                value={genCount}
                onChange={e => setGenCount(Math.max(1, Number(e.target.value)))}
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all"
              />
              <p className="text-[10px] text-gray-400 mt-1">
                Max: {Math.max(0, (Number(request.originalOrderedQty) || 0) - (Number(request.piecesGeneratedCount) || 0))}
              </p>
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button onClick={() => { setShowGenerate(false); setGenCount(0); }}
                className="px-4 py-2 text-sm text-gray-500 hover:text-black transition-colors">
                Cancel
              </button>
              <button
                disabled={acting || genCount <= 0}
                onClick={handleGeneratePieces}
                className="flex items-center gap-2 px-4 py-2 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
              >
                {acting ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />}
                Generate {genCount} Piece{genCount !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Requestor info */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mb-6">
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">Details</h2>
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2 text-gray-500">
            <User size={14} />
            Requested by {request.requestedByName || request.createdByName} · {request.requestedByRole || request.createdBy}
            {request.requestedBy && <span className="font-mono text-gray-400">({request.requestedBy})</span>}
          </div>
          <div className="flex items-center gap-2 text-gray-500">
            <Clock size={14} />
            Created {new Date(request.createdAt).toLocaleDateString()} · Updated {new Date(request.updatedAt).toLocaleDateString()}
          </div>
          {request.approvedByName && (
            <div className="flex items-center gap-2 text-emerald-600">
              <Check size={14} />
              Approved by {request.approvedByName} on {request.approvedAt ? new Date(request.approvedAt).toLocaleDateString() : '—'}
            </div>
          )}
          {request.rejectionReason && (
            <div className="flex items-start gap-2 text-red-500">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>Rejected by {request.rejectedByName}: {request.rejectionReason}</span>
            </div>
          )}
        </div>
      </div>

      {/* Fabric (V1): requirement from the design's fabric guide + issue to Guard */}
      <PrFabricIssueSection pr={request} onChanged={loadRequest} />

      {/* Post-approval audit trail */}
      {(isApproved || request.status === 'COMPLETED') && (
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6">
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">Post-Approval Edit History</h2>
          {audits.length === 0 ? (
            <p className="text-sm text-gray-400">No post-approval edits yet.</p>
          ) : (
            <div className="space-y-2">
              {audits.map(a => (
                <div key={a.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl text-sm">
                  <div>
                    <span className="font-medium text-black capitalize">{a.field}</span>
                    <span className="text-gray-500 ml-2">
                      {String(a.oldValue) || '—'} → {String(a.newValue)}
                    </span>
                  </div>
                  <div className="text-xs text-gray-400">
                    {a.editedByName} · {new Date(a.at).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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