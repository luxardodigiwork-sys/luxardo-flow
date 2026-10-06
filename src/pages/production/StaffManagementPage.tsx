import React, { useState, useEffect, useCallback } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { db, functions } from '../../firebase';
import { collection, getDocs, query, orderBy, where, limitToLast } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  Users, Plus, Search, ShieldCheck, XCircle, Loader2, CheckCircle, X, Phone, UserRound, KeyRound,
  Mail, RotateCcw, History, Copy, ChevronDown, Trash2, AlertTriangle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { StaffDoc, AuditLogDoc } from '../../types/production';
import { PRODUCTION_CONFIG } from '../../constants/businessConfig';
import { can, roleLabel } from '../../utils/rolePermissions';
import { useAuth } from '../../context/AuthContext';
import { useScrollLock } from '../../utils/useScrollLock';
import { isValidE164 } from '../../utils/phone';

type StaffRole = StaffDoc['role'];

export default function StaffManagementPage() {
  // Server-side authorization is already mandatory (firestore.loom.rules'
  // staff/{uid} read rule + staffCreate/staffUpdate/staffDelete's
  // requireSuperAdmin) — this is the matching CLIENT-side gate so an
  // ordinary staff member who navigates here directly sees a clear
  // redirect instead of a broken admin UI.
  const { user } = useAuth();
  const effectiveRole = (user?.staffRole || user?.role || '') as any;
  const isAuthorized = can(effectiveRole, 'production.staff'); // view-only gate: admin/owner/super_admin
  // Every MUTATION on this page — create, delete, edit email/mobile/role/
  // post/salary, activate/deactivate, reset password, force password
  // change — is Super-Admin-only. Admin/owner keep read-only visibility.
  // See functions/src/production.ts's requireSuperAdmin for the exact
  // server-side mirror of this gate.
  const canManage = can(effectiveRole, 'production.staff.manage');

  const [staff, setStaff] = useState<StaffDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  useScrollLock(showCreateModal);

  // Edit Email modal state (Super Admin only)
  const [emailTarget, setEmailTarget] = useState<StaffDoc | null>(null);
  const [emailValue, setEmailValue] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailError, setEmailError] = useState('');
  useScrollLock(!!emailTarget);

  // Change Role modal state (Super Admin only)
  const [roleTarget, setRoleTarget] = useState<StaffDoc | null>(null);
  const [roleValue, setRoleValue] = useState<StaffRole>('designer');
  const [savingRole, setSavingRole] = useState(false);
  useScrollLock(!!roleTarget);

  // Edit Post modal state (Super Admin only)
  const [postTarget, setPostTarget] = useState<StaffDoc | null>(null);
  const [postValue, setPostValue] = useState('');
  const [savingPost, setSavingPost] = useState(false);
  useScrollLock(!!postTarget);

  // Reset Password (Super Admin only) — the one-time reveal after success
  const [resetTarget, setResetTarget] = useState<StaffDoc | null>(null);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [revealedPassword, setRevealedPassword] = useState<{ name: string; password: string } | null>(null);
  useScrollLock(!!resetTarget || !!revealedPassword);

  // Delete (Super Admin only) — permanent, confirm modal
  const [deleteTarget, setDeleteTarget] = useState<StaffDoc | null>(null);
  const [deleting, setDeleting] = useState(false);
  useScrollLock(!!deleteTarget);

  // Recent Activity modal (read-only, any viewer of this page)
  const [activityTarget, setActivityTarget] = useState<StaffDoc | null>(null);
  const [activityEntries, setActivityEntries] = useState<AuditLogDoc[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(false);
  useScrollLock(!!activityTarget);

  // Create form state (Super Admin only)
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<StaffRole>('designer');
  const [newPassword, setNewPassword] = useState('');
  const [newPhoneNumber, setNewPhoneNumber] = useState('');
  const newPhoneValid = newPhoneNumber.trim() === '' || isValidE164(newPhoneNumber);

  // Link Existing Auth Account — optional, assistive pre-check on the SAME
  // "Add Staff" form. If the admin never clicks "Check", behavior is exactly
  // as before (staffCreate). If the check finds an existing Auth account with
  // no staff profile, the form switches to staffLinkExistingAccount instead
  // (no password field — no credential is created or changed).
  const [identityChecked, setIdentityChecked] = useState(false);
  const [checkingIdentity, setCheckingIdentity] = useState(false);
  const [identityResult, setIdentityResult] = useState<any>(null);
  const linkMode = identityChecked && !!identityResult?.found && !identityResult.conflict && !identityResult.existingStaffDoc;
  const conflictMode = identityChecked && !!identityResult?.found && !!identityResult.conflict;
  const alreadyLinkedMode = identityChecked && !!identityResult?.found && !identityResult.conflict && !!identityResult.existingStaffDoc;

  // Transfer Mobile Number (Super Admin only) — reached from the Edit Mobile
  // Number modal below when the number already belongs to a DIFFERENT uid.
  const [transferTarget, setTransferTarget] = useState<StaffDoc | null>(null);
  const [transferPhone, setTransferPhone] = useState('');
  const [transferPreview, setTransferPreview] = useState<any>(null);
  const [transferLoading, setTransferLoading] = useState(false);
  const [transferring, setTransferring] = useState(false);
  useScrollLock(!!transferTarget);

  // Set/Edit Mobile Number modal state (Super Admin only)
  const [mobileTarget, setMobileTarget] = useState<StaffDoc | null>(null);
  const [mobileValue, setMobileValue] = useState('');
  const [savingMobile, setSavingMobile] = useState(false);
  const mobileValid = mobileValue.trim() === '' || isValidE164(mobileValue);
  useScrollLock(!!mobileTarget);

  const loadStaff = useCallback(async () => {
    if (!isAuthorized) { setLoading(false); return; }
    try {
      // No role filter — every LUXARDO FLOW identity (Super Admin, Admin,
      // Owner, and all 8 operational roles) has a staff/{uid} doc, and this
      // query intentionally fetches all of them. Owner must never disappear
      // from this list.
      const q = query(collection(db, 'staff'), orderBy('createdAt', 'desc'));
      const snap = await getDocs(q);
      setStaff(snap.docs.map(d => d.data() as StaffDoc));
    } catch (err) {
      console.error('Failed to load staff:', err);
    } finally {
      setLoading(false);
    }
  }, [isAuthorized]);

  useEffect(() => { loadStaff(); }, [loadStaff]);

  // Server-side authorization (firestore.loom.rules + requireStaff) is the
  // real boundary; this is only the matching client-side redirect so an
  // ordinary staff member never sees the admin UI at all.
  if (!isAuthorized) {
    return <Navigate to="/production" replace />;
  }

  const closeCreateModal = () => {
    if (creating) return;
    setShowCreateModal(false);
    setIdentityChecked(false);
    setIdentityResult(null);
  };

  const resetCreateForm = () => {
    setShowCreateModal(false);
    setNewName(''); setNewEmail(''); setNewRole('designer'); setNewPassword(''); setNewPhoneNumber('');
    setIdentityChecked(false); setIdentityResult(null);
  };

  // Optional, assistive pre-check — resolves email/mobile to an existing
  // Auth account (if any) BEFORE the admin decides whether to create a new
  // account or link an existing one. Never attempts to create anything.
  const checkIdentity = async () => {
    if (!newEmail.trim() && !newPhoneNumber.trim()) return;
    setCheckingIdentity(true);
    setToast(null);
    try {
      const lookupFn = httpsCallable(functions, 'staffLookupIdentity');
      const res: any = await lookupFn({
        email: newEmail.trim() || undefined,
        phoneNumber: newPhoneNumber.trim() || undefined,
      });
      setIdentityResult(res.data);
      setIdentityChecked(true);
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Could not check this email/mobile.' });
    } finally {
      setCheckingIdentity(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newEmail.trim()) return;
    if (!newPhoneValid) return; // guarded by disabled submit too; belt-and-braces
    if (conflictMode || alreadyLinkedMode) return; // guarded by disabled submit too

    setCreating(true);
    setToast(null);

    // Link Existing Account — an Auth account was found with no staff
    // profile yet. No password field, no admin.auth().createUser() call —
    // staffLinkExistingAccount only ever attaches a profile to the EXACT
    // uid staffLookupIdentity just resolved.
    if (linkMode) {
      try {
        const linkFn = httpsCallable(functions, 'staffLinkExistingAccount');
        await linkFn({
          uid: identityResult.uid,
          displayName: newName.trim(),
          role: newRole,
          phoneNumber: newPhoneNumber.trim() || undefined,
        });
        setToast({
          type: 'success',
          message: `Linked existing account for "${newName.trim()}" (${roleLabel(newRole)}). No new password was created — they already have one.`,
        });
        resetCreateForm();
        await loadStaff();
      } catch (err: any) {
        setToast({ type: 'error', message: err.message || 'Failed to link existing account.' });
      } finally {
        setCreating(false);
      }
      return;
    }

    if (!newPassword.trim()) { setCreating(false); return; }

    try {
      const staffCreateFn = httpsCallable(functions, 'staffCreate');
      await staffCreateFn({
        displayName: newName.trim(),
        email: newEmail.trim(),
        role: newRole,
        password: newPassword.trim() || undefined,
        phoneNumber: newPhoneNumber.trim() || undefined,
      });

      setToast({
        type: 'success',
        message: `Staff "${newName.trim()}" created (${roleLabel(newRole)}). They can now sign in at /production with the password you set.`,
      });
      resetCreateForm();
      await loadStaff();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Failed to create staff.' });
    } finally {
      setCreating(false);
    }
  };

  const toggleActive = async (s: StaffDoc) => {
    if (busyUid) return;
    setBusyUid(s.uid);
    try {
      const staffUpdateFn = httpsCallable(functions, 'staffUpdate');
      await staffUpdateFn({ uid: s.uid, updates: { active: !s.active } });
      setToast({ type: 'success', message: `${s.displayName} ${s.active ? 'deactivated' : 'activated'}.` });
      await loadStaff();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Update failed.' });
    } finally {
      setBusyUid(null);
    }
  };

  const openMobileModal = (s: StaffDoc) => {
    if (busyUid) return;
    setMobileValue(s.phoneNumber || '');
    setMobileTarget(s);
  };

  const closeMobileModal = () => {
    if (savingMobile) return;
    setMobileTarget(null);
    setMobileValue('');
  };

  const saveMobileNumber = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mobileTarget || !mobileValid) return;
    const s = mobileTarget;
    const value = mobileValue.trim();
    setSavingMobile(true);
    try {
      // Proactively resolve who currently holds this number BEFORE
      // attempting the update, so a conflict is reported clearly (who has
      // it) rather than only as Firebase Auth's own after-the-fact
      // "already in use" error. staffUpdate's own assertPhoneNotTaken
      // check is the real, race-safe enforcement — this is just a
      // friendlier, earlier message for the common case.
      if (value) {
        const lookupFn = httpsCallable(functions, 'staffLookupByPhone');
        const lookupRes: any = await lookupFn({ phoneNumber: value });
        if (lookupRes.data?.exists && lookupRes.data.uid !== s.uid) {
          // Held by a DIFFERENT Auth account — offer the explicit Transfer
          // Mobile Number flow instead of a dead-end error. Never attempted
          // automatically; the admin must review the preview and confirm.
          setSavingMobile(false);
          setMobileTarget(null); setMobileValue('');
          await openTransferModal(s, lookupRes.data.uid, value);
          return;
        }
      }
      const staffUpdateFn = httpsCallable(functions, 'staffUpdate');
      await staffUpdateFn({ uid: s.uid, updates: { phoneNumber: value } });
      setToast({ type: 'success', message: `Mobile number ${value ? 'updated' : 'removed'} for ${s.displayName}.` });
      setMobileTarget(null);
      setMobileValue('');
      await loadStaff();
    } catch (err: any) {
      // Firebase Auth's own uniqueness constraint (via assertPhoneNotTaken
      // server-side) surfaces here as-is if the proactive check above
      // didn't already catch it (e.g. a race, or the lookup call itself
      // failing) — never silently creates a duplicate identity.
      setToast({ type: 'error', message: err.message || 'Failed to update mobile number.' });
    } finally {
      setSavingMobile(false);
    }
  };

  // ── Transfer Mobile Number (Super Admin only) ──
  // Reached only from saveMobileNumber's conflict branch above. Always
  // opens with a fresh, server-verified dryRun preview (staffTransferPhone-
  // Number's own re-check, not a client guess) — the admin confirms THAT
  // preview before anything is written.
  const openTransferModal = async (target: StaffDoc, sourceUid: string, phone: string) => {
    setTransferTarget(target);
    setTransferPhone(phone);
    setTransferPreview(null);
    setTransferLoading(true);
    try {
      const transferFn = httpsCallable(functions, 'staffTransferPhoneNumber');
      const res: any = await transferFn({ sourceUid, targetUid: target.uid, phoneNumber: phone, dryRun: true });
      setTransferPreview(res.data?.preview || null);
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Could not preview this transfer.' });
      setTransferTarget(null);
    } finally {
      setTransferLoading(false);
    }
  };
  const closeTransferModal = () => {
    if (transferring) return;
    setTransferTarget(null);
    setTransferPhone('');
    setTransferPreview(null);
  };
  const confirmTransfer = async () => {
    if (!transferTarget || !transferPreview) return;
    setTransferring(true);
    try {
      const transferFn = httpsCallable(functions, 'staffTransferPhoneNumber');
      await transferFn({
        sourceUid: transferPreview.sourceUid,
        targetUid: transferTarget.uid,
        phoneNumber: transferPhone,
        dryRun: false,
      });
      setToast({
        type: 'success',
        message: `Transferred ••••${transferPreview.phoneNumberMaskedLast4} from the source account to ${transferTarget.displayName}.`,
      });
      setTransferTarget(null); setTransferPhone(''); setTransferPreview(null);
      await loadStaff();
    } catch (err: any) {
      // staffTransferPhoneNumber's HttpsError.details.stepReached names
      // exactly how far the transfer got — surfaced verbatim rather than a
      // generic failure message, per "report the exact partial state."
      const details = (err && (err.details as Record<string, unknown> | undefined)) || undefined;
      const step = details && typeof details.stepReached === 'string' ? ` (step: ${details.stepReached})` : '';
      setToast({ type: 'error', message: `${err.message || 'Transfer failed.'}${step}` });
    } finally {
      setTransferring(false);
    }
  };

  // ── Edit Email (Super Admin only) ──
  const openEmailModal = (s: StaffDoc) => {
    if (busyUid) return;
    setEmailError('');
    setEmailValue(s.email || '');
    setEmailTarget(s);
  };
  const closeEmailModal = () => {
    if (savingEmail) return;
    setEmailTarget(null);
    setEmailValue('');
    setEmailError('');
  };
  const saveEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailTarget) return;
    const value = emailValue.trim();
    setEmailError('');
    setSavingEmail(true);
    try {
      const staffUpdateFn = httpsCallable(functions, 'staffUpdate');
      await staffUpdateFn({ uid: emailTarget.uid, updates: { email: value } });
      setToast({ type: 'success', message: `Email updated for ${emailTarget.displayName}.` });
      setEmailTarget(null);
      setEmailValue('');
      await loadStaff();
    } catch (err: any) {
      // Firebase Auth's own "already in use" error (or any other Auth
      // rejection) surfaces here as-is, same precedent as mobile/phone.
      setEmailError(err.message || 'Failed to update email.');
    } finally {
      setSavingEmail(false);
    }
  };

  // ── Change Role (Super Admin only) ──
  const openRoleModal = (s: StaffDoc) => {
    if (busyUid) return;
    setRoleValue(s.role);
    setRoleTarget(s);
  };
  const closeRoleModal = () => {
    if (savingRole) return;
    setRoleTarget(null);
  };
  const saveRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roleTarget) return;
    setSavingRole(true);
    try {
      const staffUpdateFn = httpsCallable(functions, 'staffUpdate');
      await staffUpdateFn({ uid: roleTarget.uid, updates: { role: roleValue } });
      setToast({ type: 'success', message: `${roleTarget.displayName}'s role changed to ${roleLabel(roleValue)}.` });
      setRoleTarget(null);
      await loadStaff();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Failed to change role.' });
    } finally {
      setSavingRole(false);
    }
  };

  // ── Edit Post (Super Admin only) — job title, separate from role ──
  const openPostModal = (s: StaffDoc) => {
    if (busyUid) return;
    setPostValue(s.post || '');
    setPostTarget(s);
  };
  const closePostModal = () => {
    if (savingPost) return;
    setPostTarget(null);
  };
  const savePost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!postTarget) return;
    setSavingPost(true);
    try {
      const staffUpdateFn = httpsCallable(functions, 'staffUpdate');
      await staffUpdateFn({ uid: postTarget.uid, updates: { post: postValue.trim() || null } });
      setToast({ type: 'success', message: `Post updated for ${postTarget.displayName}.` });
      setPostTarget(null);
      await loadStaff();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Failed to update post.' });
    } finally {
      setSavingPost(false);
    }
  };

  // ── Reset Password (Super Admin only) — one-time reveal ──
  const confirmResetPassword = async () => {
    if (!resetTarget) return;
    setResettingPassword(true);
    try {
      const resetFn = httpsCallable(functions, 'staffResetPassword');
      const res: any = await resetFn({ uid: resetTarget.uid });
      setRevealedPassword({ name: resetTarget.displayName, password: res.data?.temporaryPassword || '' });
      setResetTarget(null);
      await loadStaff();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Failed to reset password.' });
      setResetTarget(null);
    } finally {
      setResettingPassword(false);
    }
  };

  // ── Force password change on next login (Super Admin only) ──
  const forcePasswordChange = async (s: StaffDoc) => {
    if (busyUid) return;
    setBusyUid(s.uid);
    try {
      const staffUpdateFn = httpsCallable(functions, 'staffUpdate');
      await staffUpdateFn({ uid: s.uid, updates: { mustChangePassword: true } });
      setToast({ type: 'success', message: `${s.displayName} must change their password on next login.` });
      await loadStaff();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Update failed.' });
    } finally {
      setBusyUid(null);
    }
  };

  // ── Permanently delete (Super Admin only) ──
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const deleteFn = httpsCallable(functions, 'staffDelete');
      await deleteFn({ uid: deleteTarget.uid });
      setToast({ type: 'success', message: `${deleteTarget.displayName} permanently deleted.` });
      setDeleteTarget(null);
      await loadStaff();
    } catch (err: any) {
      // Surfaces the self-delete / last-Owner safety-guard messages as-is.
      setToast({ type: 'error', message: err.message || 'Failed to delete staff account.' });
    } finally {
      setDeleting(false);
    }
  };

  // ── Recent Activity (read-only, any viewer of this page) ──
  const openActivity = async (s: StaffDoc) => {
    setActivityTarget(s);
    setLoadingActivity(true);
    try {
      // orderBy + limitToLast (ascending index, reversed client-side for
      // display) — matches the EXISTING auditLogs composite index
      // (entity, entityId, ts ASC) exactly, so no new index is needed.
      const q = query(
        collection(db, 'auditLogs'),
        where('entity', '==', 'staff'),
        where('entityId', '==', s.uid),
        orderBy('ts', 'asc'),
        limitToLast(10),
      );
      const snap = await getDocs(q);
      setActivityEntries(snap.docs.map(d => d.data() as AuditLogDoc).reverse());
    } catch (err) {
      console.error('Failed to load activity:', err);
      setActivityEntries([]);
    } finally {
      setLoadingActivity(false);
    }
  };
  const closeActivity = () => {
    setActivityTarget(null);
    setActivityEntries([]);
  };

  const copyUid = async (uid: string) => {
    try {
      await navigator.clipboard.writeText(uid);
      setToast({ type: 'success', message: 'UID copied.' });
    } catch {
      // Clipboard access can be denied in some contexts — non-fatal, the
      // UID is already visible on screen to copy by hand.
    }
  };

  const filtered = staff.filter(s =>
    s.displayName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.role.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="min-h-screen p-6 md:p-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-display text-black tracking-wide">Staff Management</h1>
          <p className="text-xs text-gray-500 font-sans mt-1">
            {canManage ? 'Production staff roles and access control' : 'Production staff roles and access control (read-only)'}
          </p>
        </div>
        {canManage && (
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-5 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 transition-colors"
          >
            <Plus size={16} />
            Add Staff
          </button>
        )}
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Search by name, email, or role…"
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="w-full pl-11 pr-4 py-3 text-sm border border-gray-200 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all"
        />
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20">
            <Users size={32} className="mx-auto text-gray-300 mb-4" />
            <p className="text-sm text-gray-500">{searchTerm ? 'No staff match your search.' : 'No staff members yet.'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="sticky-table-header">
                <tr className="border-b border-gray-100">
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Name</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">UID</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Email</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Mobile</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Post</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Role</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Status</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Password</th>
                  <th className="text-right text-[10px] font-bold uppercase tracking-widest text-gray-400 px-6 py-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(s => (
                  <tr key={s.uid} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-gray-100 rounded-full flex items-center justify-center text-xs font-bold text-gray-500">
                          {s.displayName.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm font-medium text-black">{s.displayName}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => copyUid(s.uid)}
                        title={s.uid}
                        className="text-xs font-mono text-gray-400 hover:text-black transition-colors inline-flex items-center gap-1"
                      >
                        {s.uid.slice(0, 8)}… <Copy size={10} />
                      </button>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">{s.email}</td>
                    <td className="px-6 py-4 text-sm text-gray-500">{s.phoneNumber || '—'}</td>
                    <td className="px-6 py-4">
                      {canManage ? (
                        <button
                          onClick={() => openPostModal(s)}
                          className="text-xs text-gray-600 hover:text-black transition-colors"
                        >
                          {s.post || <span className="text-gray-400">— set post —</span>}
                        </button>
                      ) : (
                        <span className="text-xs text-gray-500">{s.post || '—'}</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      {canManage ? (
                        <button
                          onClick={() => openRoleModal(s)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-[10px] font-bold uppercase tracking-widest rounded-md text-gray-600 transition-colors"
                          title="Change role"
                        >
                          <ShieldCheck size={12} />
                          {roleLabel(s.role)}
                          <ChevronDown size={10} />
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 text-[10px] font-bold uppercase tracking-widest rounded-md text-gray-600">
                          <ShieldCheck size={12} />
                          {roleLabel(s.role)}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md ${
                        s.active ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'
                      }`}>
                        {s.active ? <><CheckCircle size={12} /> Active</> : <><XCircle size={12} /> Inactive</>}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {s.mustChangePassword ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-amber-50 text-amber-600 text-[10px] font-bold uppercase tracking-widest rounded-md" title="Still using a temporary password — will be forced to change it on next login.">
                          <KeyRound size={12} /> Must Change
                        </span>
                      ) : (
                        <span className="text-[10px] text-gray-400 uppercase tracking-widest">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right whitespace-nowrap">
                      <div className="flex flex-wrap justify-end gap-1 max-w-sm ml-auto">
                        <Link
                          to={`/production/profile/${s.uid}`}
                          className="text-xs font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors inline-flex items-center gap-1"
                        >
                          <UserRound size={12} /> Profile
                        </Link>
                        <button
                          onClick={() => openActivity(s)}
                          className="text-xs font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors inline-flex items-center gap-1"
                        >
                          <History size={12} /> Activity
                        </button>
                        {canManage && (
                          <button
                            onClick={() => openMobileModal(s)}
                            disabled={busyUid === s.uid}
                            className="text-xs font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                          >
                            <Phone size={12} /> {s.phoneNumber ? 'Edit Mobile' : 'Set Mobile'}
                          </button>
                        )}
                        {canManage && (
                          <button
                            onClick={() => openEmailModal(s)}
                            disabled={busyUid === s.uid}
                            className="text-xs font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                          >
                            <Mail size={12} /> Edit Email
                          </button>
                        )}
                        {canManage && (
                          <button
                            onClick={() => setResetTarget(s)}
                            disabled={busyUid === s.uid}
                            className="text-xs font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                          >
                            <RotateCcw size={12} /> Reset Password
                          </button>
                        )}
                        {canManage && !s.mustChangePassword && (
                          <button
                            onClick={() => forcePasswordChange(s)}
                            disabled={busyUid === s.uid}
                            className="text-xs font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                          >
                            {busyUid === s.uid ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />} Force Change
                          </button>
                        )}
                        {canManage && (
                          <button
                            onClick={() => toggleActive(s)}
                            disabled={busyUid === s.uid}
                            className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 ${
                              s.active
                                ? 'text-red-600 hover:bg-red-50'
                                : 'text-emerald-600 hover:bg-emerald-50'
                            }`}
                          >
                            {busyUid === s.uid ? <Loader2 size={12} className="inline animate-spin" /> : (s.active ? 'Deactivate' : 'Activate')}
                          </button>
                        )}
                        {canManage && (
                          <button
                            onClick={() => setDeleteTarget(s)}
                            disabled={busyUid === s.uid}
                            className="text-xs font-medium px-3 py-1.5 rounded-lg text-red-600 hover:bg-red-50 transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                          >
                            <Trash2 size={12} /> Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Modal */}
      <AnimatePresence>
        {showCreateModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
            onClick={closeCreateModal}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
                <h2 className="text-lg font-display text-black">Add Staff Member</h2>
                <button onClick={closeCreateModal} className="p-2 text-gray-400 hover:text-black hover:bg-gray-100 rounded-lg transition-colors">
                  <X size={18} />
                </button>
              </div>
              <form onSubmit={handleCreate} className="p-6 space-y-5" autoComplete="off">
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Full Name</label>
                  <input type="text" required autoComplete="off" value={newName} onChange={e => setNewName(e.target.value)}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Email</label>
                  <input type="email" required autoComplete="off" value={newEmail}
                    onChange={e => { setNewEmail(e.target.value); setIdentityChecked(false); setIdentityResult(null); }}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Mobile Number (optional)</label>
                  <input type="tel" autoComplete="off" value={newPhoneNumber}
                    onChange={e => { setNewPhoneNumber(e.target.value); setIdentityChecked(false); setIdentityResult(null); }}
                    placeholder="+919876543210"
                    aria-invalid={!newPhoneValid}
                    className={`w-full px-4 py-3 text-sm border rounded-xl font-mono focus:outline-none focus:ring-2 transition-all ${
                      newPhoneValid ? 'border-gray-200 focus:ring-black/5 focus:border-black/20' : 'border-red-300 focus:ring-red-100 focus:border-red-400'
                    }`} />
                  {newPhoneValid ? (
                    <p className="text-[10px] text-gray-400 mt-1">E.164 format with country code. Required for mobile sign-in and OTP password recovery.</p>
                  ) : (
                    <p className="text-[10px] text-red-500 mt-1">Enter a valid E.164 number, e.g. +919876543210.</p>
                  )}
                </div>

                {/* Link Existing Auth Account — optional pre-check */}
                <div>
                  <button
                    type="button"
                    onClick={checkIdentity}
                    disabled={checkingIdentity || (!newEmail.trim() && !newPhoneNumber.trim())}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50 disabled:opacity-50 transition-colors"
                  >
                    {checkingIdentity ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                    {checkingIdentity ? 'Checking…' : 'Check Email / Mobile for an Existing Account'}
                  </button>

                  {identityChecked && !identityResult?.found && (
                    <p className="text-[10px] text-gray-400 mt-2">No existing sign-in account found — a new one will be created.</p>
                  )}

                  {linkMode && (
                    <div className="mt-3 p-3 bg-blue-50 border border-blue-100 rounded-xl text-[11px] text-blue-900 leading-relaxed">
                      <strong>Existing sign-in account found.</strong> No new login will be created — this will attach a staff
                      profile to the account already registered as{' '}
                      {identityResult.email && <span className="font-mono">{identityResult.email}</span>}
                      {identityResult.email && identityResult.phoneNumber && ' / '}
                      {identityResult.phoneNumber && <span className="font-mono">{identityResult.phoneNumber}</span>}
                      {identityResult.displayName ? ` (${identityResult.displayName})` : ''}.
                    </div>
                  )}

                  {alreadyLinkedMode && (
                    <div className="mt-3 p-3 bg-amber-50 border border-amber-100 rounded-xl text-[11px] text-amber-900 leading-relaxed">
                      <strong>Already linked.</strong> This account is already a staff profile:{' '}
                      {identityResult.existingStaffDoc?.displayName} ({roleLabel(identityResult.existingStaffDoc?.role)}).
                      Edit that row below instead of creating a duplicate.
                    </div>
                  )}

                  {conflictMode && (
                    <div className="mt-3 p-3 bg-red-50 border border-red-100 rounded-xl text-[11px] text-red-900 leading-relaxed">
                      <strong>Conflict.</strong> This email and mobile number belong to TWO DIFFERENT sign-in accounts
                      (uid …{String(identityResult.emailUid).slice(-6)} vs …{String(identityResult.phoneUid).slice(-6)}).
                      Clear one of the two fields above and check again to link just that one identifier.
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Role</label>
                  <select value={newRole} onChange={e => setNewRole(e.target.value as StaffRole)}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all">
                    {PRODUCTION_CONFIG.productionRoles.map(r => (
                      <option key={r} value={r}>{roleLabel(r)}</option>
                    ))}
                  </select>
                </div>
                {/* Kept structurally mounted at all times (CSS-hidden via
                    className rather than conditionally unmounted) so the
                    form's set of controls never changes shape when switching
                    into link mode. Requiredness is enforced purely in JS
                    (handleCreate's `if (!newPassword.trim())` guard below,
                    reached only on the non-link path), so no native HTML5
                    `required` attribute needs to toggle either. */}
                <div className={linkMode ? 'hidden' : ''}>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Temporary Password</label>
                  <input type="text" autoComplete="off" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl font-mono focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
                  <p className="text-[10px] text-gray-400 mt-1">Staff must change on first login.</p>
                </div>
                <div className="flex justify-end gap-3 pt-2">
                  <button type="button" onClick={closeCreateModal}
                    className="px-5 py-2.5 text-sm text-gray-500 hover:text-black transition-colors">
                    Cancel
                  </button>
                  <button type="submit" disabled={creating || !newPhoneValid || conflictMode || alreadyLinkedMode}
                    className="flex items-center gap-2 px-6 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors">
                    {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                    {creating ? (linkMode ? 'Linking…' : 'Creating…') : (linkMode ? 'Link Existing Account' : 'Create Staff')}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Transfer Mobile Number Modal (Super Admin only) */}
      <AnimatePresence>
        {transferTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
            onClick={closeTransferModal}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
                <h2 className="text-lg font-display text-black">Transfer Mobile Number</h2>
                <button onClick={closeTransferModal} className="p-2 text-gray-400 hover:text-black hover:bg-gray-100 rounded-lg transition-colors">
                  <X size={18} />
                </button>
              </div>
              <div className="p-6 space-y-4">
                {transferLoading && (
                  <div className="flex items-center justify-center py-6 text-gray-400">
                    <Loader2 size={20} className="animate-spin" />
                  </div>
                )}
                {!transferLoading && transferPreview && (
                  <>
                    <div className="p-3 bg-amber-50 border border-amber-100 rounded-xl text-[11px] text-amber-900 leading-relaxed flex items-start gap-2">
                      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                      <span>
                        Number <span className="font-mono">••••{transferPreview.phoneNumberMaskedLast4}</span> is currently
                        held by a different sign-in account. Review carefully — both accounts and their email identities
                        are preserved; only the phone number moves.
                      </span>
                    </div>
                    <div className="grid grid-cols-1 gap-3 text-xs">
                      <div className="p-3 border border-gray-200 rounded-xl">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">From (source)</p>
                        <p className="font-mono text-gray-800">{transferPreview.sourceEmail || transferPreview.sourceUid}</p>
                        <p className="text-gray-400 mt-1">
                          {transferPreview.sourceHasStaffDoc ? 'Has a staff profile' : 'No staff profile — not shown in this list'}
                        </p>
                      </div>
                      <div className="p-3 border border-gray-200 rounded-xl">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">To (target)</p>
                        <p className="font-mono text-gray-800">{transferTarget.displayName} — {transferTarget.email}</p>
                        <p className="text-gray-400 mt-1">{roleLabel(transferTarget.role)}</p>
                      </div>
                    </div>
                  </>
                )}
                <div className="flex justify-end gap-3 pt-2">
                  <button type="button" onClick={closeTransferModal} disabled={transferring}
                    className="px-5 py-2.5 text-sm text-gray-500 hover:text-black transition-colors disabled:opacity-50">
                    Cancel
                  </button>
                  <button type="button" onClick={confirmTransfer} disabled={transferring || transferLoading || !transferPreview}
                    className="flex items-center gap-2 px-6 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors">
                    {transferring ? <Loader2 size={14} className="animate-spin" /> : <Phone size={14} />}
                    {transferring ? 'Transferring…' : 'Confirm Transfer'}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Set/Edit Mobile Number Modal */}
      <AnimatePresence>
        {mobileTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
            onClick={closeMobileModal}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
            >
              <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
                <h2 className="text-lg font-display text-black">
                  {mobileTarget.phoneNumber ? 'Edit' : 'Set'} Mobile Number
                </h2>
                <button onClick={closeMobileModal} className="p-2 text-gray-400 hover:text-black hover:bg-gray-100 rounded-lg transition-colors">
                  <X size={18} />
                </button>
              </div>
              <form onSubmit={saveMobileNumber} className="p-6 space-y-5">
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
                    {mobileTarget.displayName}
                  </label>
                  <input
                    type="tel"
                    autoFocus
                    value={mobileValue}
                    onChange={e => setMobileValue(e.target.value)}
                    placeholder="+919876543210"
                    aria-invalid={!mobileValid}
                    className={`w-full px-4 py-3 text-sm border rounded-xl font-mono focus:outline-none focus:ring-2 transition-all ${
                      mobileValid ? 'border-gray-200 focus:ring-black/5 focus:border-black/20' : 'border-red-300 focus:ring-red-100 focus:border-red-400'
                    }`}
                  />
                  {mobileValid ? (
                    <p className="text-[10px] text-gray-400 mt-1">E.164 format with country code. Leave blank to remove. Required for mobile sign-in and OTP password recovery.</p>
                  ) : (
                    <p className="text-[10px] text-red-500 mt-1">Enter a valid E.164 number, e.g. +919876543210, or leave blank to remove.</p>
                  )}
                </div>
                <div className="flex justify-end gap-3 pt-2">
                  <button type="button" onClick={closeMobileModal}
                    className="px-5 py-2.5 text-sm text-gray-500 hover:text-black transition-colors">
                    Cancel
                  </button>
                  <button type="submit" disabled={savingMobile || !mobileValid}
                    className="flex items-center gap-2 px-6 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors">
                    {savingMobile ? <Loader2 size={14} className="animate-spin" /> : <Phone size={14} />}
                    {savingMobile ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Edit Email Modal (Super Admin only) */}
      <AnimatePresence>
        {emailTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
            onClick={closeEmailModal}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
            >
              <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
                <h2 className="text-lg font-display text-black">Edit Email</h2>
                <button onClick={closeEmailModal} className="p-2 text-gray-400 hover:text-black hover:bg-gray-100 rounded-lg transition-colors">
                  <X size={18} />
                </button>
              </div>
              <form onSubmit={saveEmail} className="p-6 space-y-5">
                {emailError && (
                  <div className="bg-red-50 text-red-700 p-3 text-xs border border-red-100 rounded-lg">{emailError}</div>
                )}
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
                    {emailTarget.displayName}
                  </label>
                  <input
                    type="email"
                    autoFocus
                    required
                    value={emailValue}
                    onChange={e => setEmailValue(e.target.value)}
                    placeholder="name@example.com"
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all"
                  />
                  <p className="text-[10px] text-gray-400 mt-1">Updates the real Firebase Authentication sign-in email, not just this record.</p>
                </div>
                <div className="flex justify-end gap-3 pt-2">
                  <button type="button" onClick={closeEmailModal}
                    className="px-5 py-2.5 text-sm text-gray-500 hover:text-black transition-colors">
                    Cancel
                  </button>
                  <button type="submit" disabled={savingEmail || !emailValue.trim()}
                    className="flex items-center gap-2 px-6 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors">
                    {savingEmail ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
                    {savingEmail ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Change Role Modal (Super Admin only) */}
      <AnimatePresence>
        {roleTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
            onClick={closeRoleModal}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
            >
              <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
                <h2 className="text-lg font-display text-black">Change Role</h2>
                <button onClick={closeRoleModal} className="p-2 text-gray-400 hover:text-black hover:bg-gray-100 rounded-lg transition-colors">
                  <X size={18} />
                </button>
              </div>
              <form onSubmit={saveRole} className="p-6 space-y-5">
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
                    {roleTarget.displayName}
                  </label>
                  <select value={roleValue} onChange={e => setRoleValue(e.target.value as StaffRole)}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all">
                    {PRODUCTION_CONFIG.productionRoles.map(r => (
                      <option key={r} value={r}>{roleLabel(r)}</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-gray-400 mt-1">Super Admin is never assignable here — it is tied to a fixed account, not a role you can grant.</p>
                </div>
                <div className="flex justify-end gap-3 pt-2">
                  <button type="button" onClick={closeRoleModal}
                    className="px-5 py-2.5 text-sm text-gray-500 hover:text-black transition-colors">
                    Cancel
                  </button>
                  <button type="submit" disabled={savingRole || roleValue === roleTarget.role}
                    className="flex items-center gap-2 px-6 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors">
                    {savingRole ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                    {savingRole ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Edit Post Modal (Super Admin only) */}
      <AnimatePresence>
        {postTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
            onClick={closePostModal}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
            >
              <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
                <h2 className="text-lg font-display text-black">Edit Post</h2>
                <button onClick={closePostModal} className="p-2 text-gray-400 hover:text-black hover:bg-gray-100 rounded-lg transition-colors">
                  <X size={18} />
                </button>
              </div>
              <form onSubmit={savePost} className="p-6 space-y-5">
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
                    {postTarget.displayName}
                  </label>
                  <input
                    type="text"
                    autoFocus
                    value={postValue}
                    onChange={e => setPostValue(e.target.value)}
                    placeholder="e.g. Production Manager"
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all"
                  />
                  <p className="text-[10px] text-gray-400 mt-1">Job title — separate from Role ({roleLabel(postTarget.role)}), purely descriptive.</p>
                </div>
                <div className="flex justify-end gap-3 pt-2">
                  <button type="button" onClick={closePostModal}
                    className="px-5 py-2.5 text-sm text-gray-500 hover:text-black transition-colors">
                    Cancel
                  </button>
                  <button type="submit" disabled={savingPost}
                    className="flex items-center gap-2 px-6 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors">
                    {savingPost ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                    {savingPost ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reset Password — confirm (Super Admin only) */}
      <AnimatePresence>
        {resetTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
            onClick={() => !resettingPassword && setResetTarget(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
            >
              <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
                <h2 className="text-lg font-display text-black">Reset Password</h2>
                <button onClick={() => !resettingPassword && setResetTarget(null)} className="p-2 text-gray-400 hover:text-black hover:bg-gray-100 rounded-lg transition-colors">
                  <X size={18} />
                </button>
              </div>
              <div className="p-6 space-y-5">
                <p className="text-sm text-gray-600">
                  This generates a new temporary password for <strong>{resetTarget.displayName}</strong> and forces them to change it on next login. Their current password stops working immediately.
                </p>
                <div className="flex justify-end gap-3 pt-2">
                  <button type="button" onClick={() => setResetTarget(null)} disabled={resettingPassword}
                    className="px-5 py-2.5 text-sm text-gray-500 hover:text-black transition-colors disabled:opacity-50">
                    Cancel
                  </button>
                  <button type="button" onClick={confirmResetPassword} disabled={resettingPassword}
                    className="flex items-center gap-2 px-6 py-2.5 bg-red-600 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors">
                    {resettingPassword ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                    {resettingPassword ? 'Resetting…' : 'Reset Password'}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Revealed temporary password — shown EXACTLY ONCE, never stored or re-fetchable */}
      <AnimatePresence>
        {revealedPassword && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
            >
              <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
                <h2 className="text-lg font-display text-black">New Temporary Password</h2>
              </div>
              <div className="p-6 space-y-5">
                <p className="text-xs text-amber-600 font-medium">This will not be shown again — copy it now and hand it to {revealedPassword.name}.</p>
                <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl font-mono text-sm text-center tracking-wide select-all">
                  {revealedPassword.password}
                </div>
                <div className="flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={async () => {
                      try { await navigator.clipboard.writeText(revealedPassword.password); setToast({ type: 'success', message: 'Password copied.' }); } catch {}
                    }}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm text-gray-500 hover:text-black transition-colors"
                  >
                    <Copy size={14} /> Copy
                  </button>
                  <button type="button" onClick={() => setRevealedPassword(null)}
                    className="flex items-center gap-2 px-6 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 transition-colors">
                    Done
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Permanently Delete — confirm (Super Admin only) */}
      <AnimatePresence>
        {deleteTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
            onClick={() => !deleting && setDeleteTarget(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
            >
              <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
                <h2 className="text-lg font-display text-red-600 flex items-center gap-2">
                  <AlertTriangle size={18} /> Delete Staff Account
                </h2>
                <button onClick={() => !deleting && setDeleteTarget(null)} className="p-2 text-gray-400 hover:text-black hover:bg-gray-100 rounded-lg transition-colors">
                  <X size={18} />
                </button>
              </div>
              <div className="p-6 space-y-5">
                <p className="text-sm text-gray-600">
                  This permanently deletes <strong>{deleteTarget.displayName}</strong>'s sign-in account and staff profile. This cannot be undone — they will no longer be able to log in. Their historical audit log entries are preserved.
                </p>
                <div className="flex justify-end gap-3 pt-2">
                  <button type="button" onClick={() => setDeleteTarget(null)} disabled={deleting}
                    className="px-5 py-2.5 text-sm text-gray-500 hover:text-black transition-colors disabled:opacity-50">
                    Cancel
                  </button>
                  <button type="button" onClick={confirmDelete} disabled={deleting}
                    className="flex items-center gap-2 px-6 py-2.5 bg-red-600 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors">
                    {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    {deleting ? 'Deleting…' : 'Permanently Delete'}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Recent Activity (read-only) */}
      <AnimatePresence>
        {activityTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
            onClick={closeActivity}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden max-h-[80vh] flex flex-col"
            >
              <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 shrink-0">
                <h2 className="text-lg font-display text-black">{activityTarget.displayName} — Recent Activity</h2>
                <button onClick={closeActivity} className="p-2 text-gray-400 hover:text-black hover:bg-gray-100 rounded-lg transition-colors">
                  <X size={18} />
                </button>
              </div>
              <div className="p-6 overflow-y-auto">
                {loadingActivity ? (
                  <div className="flex items-center justify-center py-10">
                    <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                  </div>
                ) : activityEntries.length === 0 ? (
                  <p className="text-sm text-gray-500 text-center py-10">No recorded activity for this account yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {activityEntries.map(entry => (
                      <li key={entry.id} className="border border-gray-100 rounded-xl p-4">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold uppercase tracking-widest text-gray-700">{entry.action.replace(/_/g, ' ')}</span>
                          <span className="text-[10px] text-gray-400">{new Date(entry.ts).toLocaleString()}</span>
                        </div>
                        <p className="text-[11px] text-gray-500 mt-1">by {entry.actorName} ({roleLabel(entry.actorRole)})</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-4 rounded-xl shadow-xl ${
              toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
            }`}
          >
            {toast.type === 'success' ? <CheckCircle size={18} /> : <XCircle size={18} />}
            <span className="text-sm">{toast.message}</span>
            <button onClick={() => setToast(null)} className="ml-2 text-white/70 hover:text-white"><X size={16} /></button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
