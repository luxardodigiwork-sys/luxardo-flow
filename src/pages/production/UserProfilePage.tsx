import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, functions, storage } from '../../firebase';
import { useAuth } from '../../context/AuthContext';
import { can, roleLabel } from '../../utils/rolePermissions';
import { PRODUCTION_CONFIG } from '../../constants/businessConfig';
import { isValidE164 } from '../../utils/phone';
import type { StaffDoc, Department } from '../../types/production';
import {
  User, Camera, Loader2, CheckCircle, XCircle, X, ArrowLeft, Phone, Briefcase,
  Calendar, IndianRupee, Clock, Hash, FileText, ShieldCheck,
} from 'lucide-react';

/**
 * The authoritative LUXARDO FLOW User Profile page.
 *
 * /production/profile        — the signed-in User's own profile.
 * /production/profile/:uid   — an admin/owner viewing/editing another
 *                               User's profile (requires production.staff).
 *
 * Self-editable (any signed-in User, via userProfileSelfUpdate — low-risk
 * personal fields only): display name, photo, mobile number.
 * Admin-only (via the existing admin-gated staffUpdate): department,
 * rate/day, working hours, joining date, employee ID, notes. Role stays
 * read-only here entirely — role changes go through Staff Management only,
 * unchanged by this page.
 */
export default function UserProfilePage() {
  const { uid: paramUid } = useParams<{ uid?: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const effectiveRole = (user?.staffRole || user?.role || '') as any;
  const isAdminViewer = can(effectiveRole, 'production.staff');
  const targetUid = paramUid || user?.id || '';
  const isSelf = !!user && targetUid === user.id;
  const canView = isSelf || isAdminViewer;
  const canEdit = canView; // same gate today — self edits own subset, admin edits everything

  const [profile, setProfile] = useState<StaffDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Form state
  const [displayName, setDisplayName] = useState('');
  const [phoneValue, setPhoneValue] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [department, setDepartment] = useState('');
  const [ratePerDay, setRatePerDay] = useState('');
  const [whStart, setWhStart] = useState('');
  const [whEnd, setWhEnd] = useState('');
  const [joiningDate, setJoiningDate] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [notes, setNotes] = useState('');

  const phoneValid = phoneValue.trim() === '' || isValidE164(phoneValue);

  const load = useCallback(async () => {
    if (!targetUid) { setLoading(false); return; }
    if (paramUid && !isAdminViewer) { setDenied(true); setLoading(false); return; }
    setLoading(true);
    try {
      const snap = await getDoc(doc(db, 'staff', targetUid));
      if (!snap.exists()) { setDenied(true); return; }
      const data = snap.data() as StaffDoc;
      setProfile(data);
      setDisplayName(data.displayName || '');
      setPhoneValue(data.phoneNumber || '');
      setPhotoUrl(data.profilePhotoUrl || '');
      setDepartment(data.department || '');
      setRatePerDay(data.ratePerDay != null ? String(data.ratePerDay) : '');
      setWhStart(data.workingHours?.start || '');
      setWhEnd(data.workingHours?.end || '');
      setJoiningDate(data.joiningDate || '');
      setEmployeeId(data.employeeId || '');
      setNotes(data.notes || '');
    } catch (err) {
      console.error('Failed to load profile:', err);
      setDenied(true);
    } finally {
      setLoading(false);
    }
  }, [targetUid, paramUid, isAdminViewer]);

  useEffect(() => { load(); }, [load]);

  const callUpdate = async (updates: Record<string, unknown>) => {
    const fn = httpsCallable(functions, isAdminViewer ? 'staffUpdate' : 'userProfileSelfUpdate');
    const payload = isAdminViewer ? { uid: targetUid, updates } : { updates };
    await fn(payload);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneValid) return;
    setSaving(true);
    setToast(null);
    try {
      const updates: Record<string, unknown> = { displayName: displayName.trim() };
      if (phoneValue.trim() !== (profile?.phoneNumber || '')) {
        updates.phoneNumber = phoneValue.trim();
      }
      if (isAdminViewer) {
        updates.department = department || null;
        updates.ratePerDay = ratePerDay === '' ? null : Number(ratePerDay);
        updates.workingHours = whStart && whEnd ? { start: whStart, end: whEnd } : null;
        updates.joiningDate = joiningDate || null;
        updates.employeeId = employeeId.trim() || null;
        updates.notes = notes.trim() || null;
      }
      await callUpdate(updates);
      setToast({ type: 'success', message: 'Profile updated.' });
      await load();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Failed to update profile.' });
    } finally {
      setSaving(false);
    }
  };

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // allow re-selecting the same file later
    if (!file.type.startsWith('image/')) {
      setToast({ type: 'error', message: 'Please choose an image file.' });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setToast({ type: 'error', message: 'Image must be under 5MB.' });
      return;
    }
    setUploadingPhoto(true);
    setToast(null);
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `production/profiles/${targetUid}/${Date.now()}-${safeName}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file, { contentType: file.type });
      const url = await getDownloadURL(storageRef);
      await callUpdate({ profilePhotoUrl: url });
      setPhotoUrl(url);
      setToast({ type: 'success', message: 'Profile photo updated.' });
      await load();
    } catch (err: any) {
      setToast({ type: 'error', message: err.message || 'Failed to upload photo.' });
    } finally {
      setUploadingPhoto(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (denied || !profile) {
    return (
      <div className="text-center py-24">
        <User size={32} className="mx-auto text-gray-300 mb-3" />
        <p className="text-sm text-gray-500">
          {paramUid ? 'You do not have permission to view this profile.' : 'Profile not found.'}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 md:p-8 max-w-3xl mx-auto">
      {paramUid && (
        <button onClick={() => navigate('/production/staff')} className="inline-flex items-center gap-2 text-xs text-gray-500 hover:text-black mb-6">
          <ArrowLeft size={14} /> Back to Staff Management
        </button>
      )}

      <div className="flex items-center gap-3 mb-8">
        <div>
          <h1 className="text-2xl font-display text-black tracking-wide">
            {isSelf ? 'My Profile' : `${profile.displayName}'s Profile`}
          </h1>
          <p className="text-xs text-gray-500 font-sans mt-1">
            LUXARDO FLOW User Profile — {roleLabel(profile.role)}
            {profile.role === 'owner' && <span className="ml-2 text-[10px] font-bold uppercase tracking-widest text-amber-600">Owner</span>}
          </p>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Photo + identity card */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 flex items-center gap-6">
          <div className="relative">
            <div className="w-20 h-20 rounded-full bg-gray-100 overflow-hidden flex items-center justify-center border border-gray-200">
              {photoUrl ? (
                <img src={photoUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-xl font-bold text-gray-400">{(displayName || profile.displayName).charAt(0).toUpperCase()}</span>
              )}
            </div>
            {canEdit && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingPhoto}
                className="absolute -bottom-1 -right-1 w-8 h-8 bg-black text-white rounded-full flex items-center justify-center hover:bg-gray-800 transition-colors disabled:opacity-50"
                title="Change profile picture"
              >
                {uploadingPhoto ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
              </button>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handlePhotoChange} />
          </div>
          <div className="flex-1 min-w-0">
            {canEdit ? (
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                className="w-full text-lg font-medium text-black border-b border-transparent hover:border-gray-200 focus:border-black focus:outline-none transition-colors bg-transparent"
              />
            ) : (
              <p className="text-lg font-medium text-black">{profile.displayName}</p>
            )}
            <p className="text-sm text-gray-500 truncate">{profile.email}</p>
            <span className={`inline-flex items-center gap-1 mt-2 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest rounded-md ${
              profile.active ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'
            }`}>
              {profile.active ? <><CheckCircle size={12} /> Active</> : <><XCircle size={12} /> Inactive</>}
            </span>
          </div>
        </div>

        {/* Contact */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6">
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">Contact</h2>
          <div>
            <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
              <Phone size={12} /> Mobile Number
            </label>
            {canEdit ? (
              <>
                <input
                  type="tel"
                  value={phoneValue}
                  onChange={(e) => setPhoneValue(e.target.value)}
                  placeholder="+919876543210"
                  aria-invalid={!phoneValid}
                  className={`w-full px-4 py-3 text-sm border rounded-xl font-mono focus:outline-none focus:ring-2 transition-all ${
                    phoneValid ? 'border-gray-200 focus:ring-black/5 focus:border-black/20' : 'border-red-300 focus:ring-red-100 focus:border-red-400'
                  }`}
                />
                {phoneValid ? (
                  <p className="text-[10px] text-gray-400 mt-1">
                    E.164 format with country code. This is the ONLY number used for mobile sign-in and OTP password recovery — kept unique across every LUXARDO FLOW User.
                  </p>
                ) : (
                  <p className="text-[10px] text-red-500 mt-1">Enter a valid E.164 number, e.g. +919876543210.</p>
                )}
              </>
            ) : (
              <p className="text-sm text-gray-700">{profile.phoneNumber || '— not set —'}</p>
            )}
          </div>
        </div>

        {/* Work details — admin-only editable; read-only display for self */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6">
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-1.5">
            <Briefcase size={12} /> Work Details
            {!isAdminViewer && <span className="normal-case font-normal text-gray-400">(set by an administrator)</span>}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Role</label>
              <p className="text-sm text-gray-700 px-4 py-3 bg-gray-50 rounded-xl">{roleLabel(profile.role)}</p>
              {isAdminViewer && <p className="text-[10px] text-gray-400 mt-1">Change role from Staff Management, not here.</p>}
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Department</label>
              {isAdminViewer ? (
                <select value={department} onChange={(e) => setDepartment(e.target.value)}
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all">
                  <option value="">— not set —</option>
                  {PRODUCTION_CONFIG.departments.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              ) : (
                <p className="text-sm text-gray-700 px-4 py-3 bg-gray-50 rounded-xl">{profile.department || '— not set —'}</p>
              )}
            </div>
            <div>
              <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
                <IndianRupee size={12} /> Rate / Day
              </label>
              {isAdminViewer ? (
                <input type="number" min={0} step="0.01" value={ratePerDay} onChange={(e) => setRatePerDay(e.target.value)}
                  placeholder="— not set —"
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
              ) : (
                <p className="text-sm text-gray-700 px-4 py-3 bg-gray-50 rounded-xl">{profile.ratePerDay != null ? `₹${profile.ratePerDay}` : '— not set —'}</p>
              )}
            </div>
            <div>
              <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
                <Calendar size={12} /> Joining Date
              </label>
              {isAdminViewer ? (
                <input type="date" value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)}
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
              ) : (
                <p className="text-sm text-gray-700 px-4 py-3 bg-gray-50 rounded-xl">{profile.joiningDate || '— not set —'}</p>
              )}
            </div>
            <div>
              <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
                <Hash size={12} /> Employee ID
              </label>
              {isAdminViewer ? (
                <input type="text" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}
                  placeholder="— not set —"
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl font-mono focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
              ) : (
                <p className="text-sm text-gray-700 px-4 py-3 bg-gray-50 rounded-xl font-mono">{profile.employeeId || '— not set —'}</p>
              )}
            </div>
            <div>
              <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
                <Clock size={12} /> Working Hours
              </label>
              {isAdminViewer ? (
                <div className="flex items-center gap-2">
                  <input type="time" value={whStart} onChange={(e) => setWhStart(e.target.value)}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
                  <span className="text-gray-400 text-xs">to</span>
                  <input type="time" value={whEnd} onChange={(e) => setWhEnd(e.target.value)}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
                </div>
              ) : (
                <p className="text-sm text-gray-700 px-4 py-3 bg-gray-50 rounded-xl">
                  {profile.workingHours ? `${profile.workingHours.start} – ${profile.workingHours.end} (${profile.workingHours.totalHours}h)` : '— not set —'}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Notes — admin-only visibility AND editability */}
        {isAdminViewer && (
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6">
            <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-1.5">
              <FileText size={12} /> Notes <span className="normal-case font-normal text-gray-400">(admin-only, never shown to the User)</span>
            </h2>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4}
              placeholder="Internal notes…"
              className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-black/20 transition-all" />
          </div>
        )}

        {canEdit && (
          <div className="flex justify-end">
            <button type="submit" disabled={saving || !phoneValid}
              className="flex items-center gap-2 px-6 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              {saving ? 'Saving…' : 'Save Profile'}
            </button>
          </div>
        )}
      </form>

      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-4 rounded-xl shadow-xl ${
          toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {toast.type === 'success' ? <CheckCircle size={18} /> : <XCircle size={18} />}
          <span className="text-sm">{toast.message}</span>
          <button onClick={() => setToast(null)} className="ml-2 text-white/70 hover:text-white"><X size={16} /></button>
        </div>
      )}
    </div>
  );
}
