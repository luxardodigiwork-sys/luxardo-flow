import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../../firebase';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { roleLabel } from '../../utils/rolePermissions';
import { isLoomHost, getPostLogoutRedirectPath } from '../../utils/loomIdentity';
import type { ThemePreference } from '../../utils/theme';
import type { StaffDoc } from '../../types/production';
import {
  User, KeyRound, Eye, EyeOff, Sun, Moon, Monitor, LogOut, Loader2,
  CheckCircle, XCircle, X, ArrowRight, ShieldCheck,
} from 'lucide-react';

/**
 * LUXARDO FLOW — Account Settings (V1 Auth + Settings Stabilization).
 *
 * /production/settings — reachable by every authenticated Flow role, no
 * can() permission gate (this is the User's own account, never a
 * business-data permission). Four sections:
 *   1. Profile information — a compact read-only summary sourced from the
 *      SAME staff/{uid} doc UserProfilePage.tsx reads; full editing stays
 *      on that existing page (linked here) rather than being duplicated.
 *   2. Change Password — calls the SAME staffChangePassword callable the
 *      mandatory first-login flow (ChangePasswordPage.tsx) uses, but as a
 *      voluntary action with no forced reload.
 *   3. Theme — System / Light / Dark, via ThemeContext (scoped to this
 *      Loom app only, never touches the separate B2C storefront).
 *   4. Secure Sign Out — the same logout() + role-aware redirect every
 *      other Sign Out button in the app already uses (ProductionLayout.tsx,
 *      ChangePasswordPage.tsx) — one implementation, not duplicated logic.
 */
export default function SettingsPage() {
  const { user, logout } = useAuth();
  const { preference, resolvedTheme, setPreference } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const navigate = useNavigate();
  const effectiveRole = user?.staffRole || user?.role || '';
  const loom = isLoomHost();

  const [profile, setProfile] = useState<StaffDoc | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdError, setPwdError] = useState('');
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const load = useCallback(async () => {
    if (!user?.id) { setLoadingProfile(false); return; }
    try {
      const snap = await getDoc(doc(db, 'staff', user.id));
      if (snap.exists()) setProfile(snap.data() as StaffDoc);
    } catch (err) {
      console.error('[SettingsPage] Failed to load profile summary:', err);
    } finally {
      setLoadingProfile(false);
    }
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwdError('');
    if (newPassword.length < 8) {
      setPwdError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwdError('Passwords do not match.');
      return;
    }
    setPwdSaving(true);
    try {
      const changeFn = httpsCallable(functions, 'staffChangePassword');
      await changeFn({ newPassword });
      setNewPassword('');
      setConfirmPassword('');
      setToast({ type: 'success', message: 'Password updated.' });
    } catch (err: any) {
      setPwdError(err?.message || 'Could not update your password. Please try again.');
    } finally {
      setPwdSaving(false);
    }
  };

  const handleSignOut = async () => {
    await logout();
    navigate(getPostLogoutRedirectPath(effectiveRole, loom));
  };

  const cardCls = `rounded-2xl shadow-sm p-6 border ${isDark ? 'bg-gray-900 border-gray-800' : 'bg-white border-gray-200'}`;
  const headingCls = `text-xs font-bold uppercase tracking-widest mb-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`;
  const labelCls = `block text-[10px] font-bold uppercase tracking-widest mb-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`;
  const inputCls = `w-full px-4 py-3 text-sm border rounded-xl focus:outline-none focus:ring-2 transition-all ${
    isDark ? 'bg-gray-800 border-gray-700 text-white focus:ring-white/10 focus:border-gray-500' : 'border-gray-200 focus:ring-black/5 focus:border-black/20'
  }`;

  const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Monitor }[] = [
    { value: 'system', label: 'System', icon: Monitor },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
  ];

  return (
    <div className={`min-h-screen max-w-3xl mx-auto ${isDark ? 'text-white' : ''}`}>
      <div className="mb-8">
        <h1 className={`text-2xl font-display tracking-wide ${isDark ? 'text-white' : 'text-black'}`}>Settings</h1>
        <p className={`text-xs font-sans mt-1 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>Your LUXARDO FLOW account</p>
      </div>

      <div className="space-y-6">
        {/* ── Profile information ── */}
        <div className={cardCls}>
          <h2 className={headingCls}>Profile Information</h2>
          {loadingProfile ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className={`w-5 h-5 animate-spin ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
            </div>
          ) : (
            <div className="flex items-center gap-4">
              <div className={`w-14 h-14 rounded-full overflow-hidden flex items-center justify-center border shrink-0 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-gray-100 border-gray-200'}`}>
                {profile?.profilePhotoUrl ? (
                  <img src={profile.profilePhotoUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <User size={22} className={isDark ? 'text-gray-500' : 'text-gray-400'} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium truncate ${isDark ? 'text-white' : 'text-black'}`}>{profile?.displayName || user?.name}</p>
                <p className={`text-xs truncate ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>{profile?.email || user?.email}</p>
                <p className={`text-xs truncate ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>{profile?.phoneNumber || 'No mobile number on file'}</p>
              </div>
              <span className="inline-flex items-center px-2.5 py-1 bg-black text-white text-[10px] font-bold uppercase tracking-widest rounded-md shrink-0">
                {roleLabel(profile?.role || effectiveRole)}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={() => navigate('/production/profile')}
            className={`mt-4 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest transition-colors ${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-black'}`}
          >
            Edit Full Profile <ArrowRight size={12} />
          </button>
        </div>

        {/* ── Change Password ── */}
        <div className={cardCls}>
          <h2 className={headingCls}>Change Password</h2>
          {pwdError && (
            <div className="bg-red-50 text-red-700 p-3 mb-4 text-xs border border-red-100 rounded-lg">{pwdError}</div>
          )}
          <form onSubmit={handleChangePassword} className="space-y-4" autoComplete="off">
            <div>
              <label className={labelCls}>New Password</label>
              <div className="relative">
                <KeyRound className={`absolute left-3 top-1/2 -translate-y-1/2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} size={16} />
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min. 8 characters"
                  className={`${inputCls} pl-10 pr-10`}
                  autoComplete="new-password"
                />
                <button type="button" onClick={() => setShowPwd(!showPwd)} className={`absolute right-3 top-1/2 -translate-y-1/2 ${isDark ? 'text-gray-500 hover:text-white' : 'text-gray-400 hover:text-black'}`}>
                  {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div>
              <label className={labelCls}>Confirm New Password</label>
              <div className="relative">
                <KeyRound className={`absolute left-3 top-1/2 -translate-y-1/2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} size={16} />
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter new password"
                  className={`${inputCls} pl-10`}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={pwdSaving || !newPassword || !confirmPassword}
                className="flex items-center gap-2 px-6 py-2.5 bg-black text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
              >
                {pwdSaving ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                {pwdSaving ? 'Updating…' : 'Update Password'}
              </button>
            </div>
          </form>
        </div>

        {/* ── Theme ── */}
        <div className={cardCls}>
          <h2 className={headingCls}>Theme</h2>
          <div className={`flex border rounded-lg p-1 ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'}`}>
            {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setPreference(value)}
                aria-pressed={preference === value}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[10px] font-bold uppercase tracking-widest rounded-md transition-colors ${
                  preference === value
                    ? 'bg-black text-white'
                    : isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-black'
                }`}
              >
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>
          <p className={`text-[10px] mt-3 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            "System" follows your device's appearance setting automatically.
          </p>
        </div>

        {/* ── Secure Sign Out ── */}
        <div className={cardCls}>
          <h2 className={headingCls}>Secure Sign Out</h2>
          <p className={`text-xs mb-4 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
            Ends your LUXARDO FLOW session on this device. You'll need to sign in again to continue.
          </p>
          <button
            type="button"
            onClick={handleSignOut}
            className="flex items-center gap-2 px-6 py-2.5 bg-red-600 text-white text-xs font-bold uppercase tracking-widest rounded-lg hover:bg-red-700 transition-colors"
          >
            <LogOut size={14} /> Sign Out
          </button>
        </div>
      </div>

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
