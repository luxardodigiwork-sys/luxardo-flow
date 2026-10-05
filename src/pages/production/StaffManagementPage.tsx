import React, { useState, useEffect, useCallback } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { db, functions } from '../../firebase';
import { collection, getDocs, doc, updateDoc, query, orderBy, where, limitToLast } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  Users, Plus, Search, ShieldCheck, XCircle, Loader2, CheckCircle, X, Phone, UserRound, KeyRound,
  Mail, RotateCcw, Archive, History, Copy, ChevronDown,
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
  // staff/{uid} read rule + staffCreate/staffUpdate's requireAdmin) — this is
  // the matching CLIENT-side gate so an ordinary staff member who navigates
  // here directly sees a clear redirect instead of a broken admin UI whose
  // Firestore list query would fail silently and whose actions would all be
  // rejected server-side anyway.
  const { user } = useAuth();
  const effectiveRole = (user?.staffRole || user?.role || '') as any;
  const isAuthorized = can(effectiveRole, 'production.staff');
  // Strict, literal match — never elevated from 'admin' (unlike can()'s
  // blanket admin/super_admin bypass). Gates ONLY the new privileged
  // operations added by the User Management extension (email edit,
  // password reset, force-password-change) — see functions/src/
  // production.ts's requireSuperAdmin for the server-side mirror of this
  // exact gate. Every pre-existing admin/owner capability on this page
  // (role change, activate/deactivate, mobile edit) is unaffected.
  const isSuperAdmin = String(effectiveRole).toLowerCase() === 'super_admin';

  const [staff, setStaff] = useState<StaffDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  useScrollLock(showCreateModal);

  // Live (never persisted) Auth-existence map — see
  // functions/src/production.ts's staffCheckAuthExists. A uid absent from
  // this map is treated as "still checking" (never silently archived).
  const [authExists, setAuthExists] = useState<Record<string, boolean>>({});
  const [showArchived, setShowArchived] = useState(false);

  // Edit Email modal state (Super Admin only)
  const [emailTarget, setEmailTarget] = useState<StaffDoc | null>(null);
  const [emailValue, setEmailValue] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailError, setEmailError] = useState('');
  useScrollLock(!!emailTarget);

  // Change Role modal state
  const [roleTarget, setRoleTarget] = useState<StaffDoc | null>(null);
  const [roleValue, setRoleValue] = useState<StaffRole>('designer');
  const [savingRole, setSavingRole] = useState(false);
  useScrollLock(!!roleTarget);

  // Reset Password (Super Admin only) — the one-time reveal after success
  const [resetTarget, setResetTarget] = useState<StaffDoc | null>(null);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [revealedPassword, setRevealedPassword] = useState<{ name: string; password: string } | null>(null);
  useScrollLock(!!resetTarget || !!revealedPassword);

  // Recent Activity modal (read-only, any viewer of this page)
  const [activityTarget, setActivityTarget] = useState<StaffDoc | null>(null);
  const [activityEntries, setActivityEntries] = useState<AuditLogDoc[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(false);
  useScrollLock(!!activityTarget);

  // Create form state
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<StaffRole>('designer');
  const [newPassword, setNewPassword] = useState('');
  const [newPhoneNumber, setNewPhoneNumber] = useState('');
  const newPhoneValid = newPhoneNumber.trim() === '' || isValidE164(newPhoneNumber);

  // Set/Edit Mobile Number modal state
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
      const docs = snap.docs.map(d => d.data() as StaffDoc);
      setStaff(docs);

      // Live Auth-existence check (never persisted — see staffCheckAuthExists)
      // so a staff/{uid} whose Firebase Auth user was removed outside the
      // app (e.g. via Console) is shown as archived instead of as a normal,
      // editable account whose mutations would all fail server-side.
      if (docs.length > 0) {
        try {
          const checkFn = httpsCallable(functions, 'staffCheckAuthExists');
          const res: any = await checkFn({ uids: docs.map(d => d.uid) });
          setAuthExists(res.data?.authExists || {});
        } catch (err) {
          console.error('Failed to check Auth existence:', err);
          // Fail open to "unknown, assume active" rather than hiding every
          // row on a transient error — never silently mass-archives.
        }
      }
    } catch (err) {
      console.error('Failed to load staff:', err);
    } finally {
      setLoading(false);
    }
  }, [isAuthorized]);

  useEffect(() => { loadStaff(); }, [loadStaff]);

  // Server-side authorization (firestore.loom.rules + requireAdmin) is the
  // real boundary; this is only the matching client-side redirect so an
  // ordinary staff member never sees the admin UI at all.
  if (!isAuthorized) {
    return <Navigate to="/production" replace />;
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newEmail.trim() || !newPassword.trim()) return;
    if (!newPhoneValid) return; // guarded by disabled submit too; belt-and-braces
    setCreating(true);
    setToast(null);

    try {
      const staffCreateFn = httpsCallable(functions, 'staffCreate');
      const result = await staffCreateFn({
        displayName: newName.trim(),
        email: newEmail.trim(),
        role: newRole,
        password: newPassword.trim() || undefined,
        phoneNumber: newPhoneNumber.trim() || undefined,
      });
      const uid = (result.data as any)?.uid || '';

      setToast({
        type: 'success',
        message: `Staff "${newName.trim()}" created (${roleLabel(newRole)}). They can now sign in at /production with the password you set.`,
      });
      setShowCreateModal(false);
      setNewName(''); setNewEmail(''); setNewRole('designer'); setNewPassword(''); setNewPhoneNumber('');
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
      // "already in use" error (still the fallback below if this check
      // itself fails or races).
      if (value) {
        const lookupFn = httpsCallable(functions, 'staffLookupByPhone');
        const lookupRes: any = await lookupFn({ phoneNumber: value });
        if (lookupRes.data?.exists && lookupRes.data.uid !== s.uid) {
          const holderName = lookupRes.data.staff?.displayName || lookupRes.data.email || lookupRes.data.uid;
          setToast({ type: 'error', message: `This number is already in use by ${holderName}.` });
          setSavingMobile(false);
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
      // Firebase Auth already enforces phone-number uniqueness across
      // accounts — its own error message (e.g. "already in use by another
      // user") surfaces here as-is if the proactive check above didn't
      // already catch it (e.g. a race, or the lookup call itself failing).
      setToast({ type: 'error', message: err.message || 'Failed to update mobile number.' });
    } finally {
      setSavingMobile(false);
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

  // ── Change Role (existing admin/owner/super_admin tier, unchanged) ──
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

  // A uid absent from the authExists map is treated as visible (still
  // checking, or the check failed open) — never hidden by default.
  const isArchived = (s: StaffDoc) => authExists[s.uid] === false;
  const visibleStaff = staff.filter(s => !isArchived(s));
  const archivedStaff = staff.filter(isArchived);

  const filtered = visibleStaff.filter(s =>
    s.displayName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.role.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="min-h-screen p-6 md:p-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-display text-black tracking-wide">Staff Management</h1>
          <p className="text-xs text-gray-500 font-sans mt-1">Production staff roles and access control</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-5 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 transition-colors"
        >
          <Plus size={16} />
          Add Staff
        </button>
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
                      <button
                        onClick={() => openRoleModal(s)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-[10px] font-bold uppercase tracking-widest rounded-md text-gray-600 transition-colors"
                        title="Change role"
                      >
                        <ShieldCheck size={12} />
                        {roleLabel(s.role)}
                        <ChevronDown size={10} />
                      </button>
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
                      <div className="flex flex-wrap justify-end gap-1 max-w-xs ml-auto">
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
                        <button
                          onClick={() => openMobileModal(s)}
                          disabled={busyUid === s.uid}
                          className="text-xs font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                        >
                          <Phone size={12} /> {s.phoneNumber ? 'Edit Mobile' : 'Set Mobile'}
                        </button>
                        {isSuperAdmin && (
                          <button
                            onClick={() => openEmailModal(s)}
                            disabled={busyUid === s.uid}
                            className="text-xs font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                          >
                            <Mail size={12} /> Edit Email
                          </button>
                        )}
                        {isSuperAdmin && (
                          <button
                            onClick={() => setResetTarget(s)}
                            disabled={busyUid === s.uid}
                            className="text-xs font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                          >
                            <RotateCcw size={12} /> Reset Password
                          </button>
                        )}
                        {isSuperAdmin && !s.mustChangePassword && (
                          <button
                            onClick={() => forcePasswordChange(s)}
                            disabled={busyUid === s.uid}
                            className="text-xs font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                          >
                            {busyUid === s.uid ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />} Force Change
                          </button>
                        )}
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
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Archived — staff/{uid} docs whose Firebase Auth user no longer
          exists (e.g. deleted via Console). Never auto-deleted: the record,
          its audit history, and any production references stay intact —
          this view is read-only and excluded from the normal list above. */}
      {archivedStaff.length > 0 && (
        <div className="mt-6">
          <button
            onClick={() => setShowArchived(v => !v)}
            className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-gray-500 hover:text-black transition-colors mb-3"
          >
            <Archive size={14} />
            Archived ({archivedStaff.length}) — Auth account no longer exists
            <ChevronDown size={12} className={`transition-transform ${showArchived ? 'rotate-180' : ''}`} />
          </button>
          {showArchived && (
            <div className="bg-amber-50/50 border border-amber-100 rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-amber-100">
                      <th className="text-left text-[10px] font-bold uppercase tracking-widest text-amber-700 px-6 py-3">Name</th>
                      <th className="text-left text-[10px] font-bold uppercase tracking-widest text-amber-700 px-6 py-3">UID</th>
                      <th className="text-left text-[10px] font-bold uppercase tracking-widest text-amber-700 px-6 py-3">Email</th>
                      <th className="text-left text-[10px] font-bold uppercase tracking-widest text-amber-700 px-6 py-3">Role</th>
                      <th className="text-right text-[10px] font-bold uppercase tracking-widest text-amber-700 px-6 py-3">History</th>
                    </tr>
                  </thead>
                  <tbody>
                    {archivedStaff.map(s => (
                      <tr key={s.uid} className="border-b border-amber-100/60">
                        <td className="px-6 py-3 text-sm text-amber-900">{s.displayName}</td>
                        <td className="px-6 py-3 text-xs font-mono text-amber-700">{s.uid}</td>
                        <td className="px-6 py-3 text-sm text-amber-800">{s.email}</td>
                        <td className="px-6 py-3 text-xs uppercase tracking-widest text-amber-700">{roleLabel(s.role)}</td>
                        <td className="px-6 py-3 text-right">
                          <button
                            onClick={() => openActivity(s)}
                            className="text-xs font-medium px-3 py-1.5 rounded-lg text-amber-700 hover:bg-amber-100 transition-colors inline-flex items-center gap-1"
                          >
                            <History size={12} /> Activity
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Modal */}
      <AnimatePresence>
        {showCreateModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
            onClick={() => !creating && setShowCreateModal(false)}
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
                <button onClick={() => setShowCreateModal(false)} className="p-2 text-gray-400 hover:text-black hover:bg-gray-100 rounded-lg transition-colors">
                  <X size={18} />
                </button>
              </div>
              <form onSubmit={handleCreate} className="p-6 space-y-5">
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Full Name</label>
                  <input type="text" required value={newName} onChange={e => setNewName(e.target.value)}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Email</label>
                  <input type="email" required value={newEmail} onChange={e => setNewEmail(e.target.value)}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
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
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Mobile Number (optional)</label>
                  <input type="tel" value={newPhoneNumber} onChange={e => setNewPhoneNumber(e.target.value)}
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
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Temporary Password</label>
                  <input type="text" required value={newPassword} onChange={e => setNewPassword(e.target.value)}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl font-mono focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
                  <p className="text-[10px] text-gray-400 mt-1">Staff must change on first login.</p>
                </div>
                <div className="flex justify-end gap-3 pt-2">
                  <button type="button" onClick={() => setShowCreateModal(false)}
                    className="px-5 py-2.5 text-sm text-gray-500 hover:text-black transition-colors">
                    Cancel
                  </button>
                  <button type="submit" disabled={creating || !newPhoneValid}
                    className="flex items-center gap-2 px-6 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors">
                    {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                    {creating ? 'Creating…' : 'Create Staff'}
                  </button>
                </div>
              </form>
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

      {/* Change Role Modal (existing admin/owner/super_admin tier, unchanged) */}
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
