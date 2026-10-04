import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, Eye, EyeOff, ShieldAlert, ArrowRight, LogOut, ShieldCheck } from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../firebase';
import { useAuth } from '../../context/AuthContext';
import { isLoomHost, getPostLogoutRedirectPath } from '../../utils/loomIdentity';
import FlowLogo from '../../components/FlowLogo';

/**
 * Mandatory first-login password change.
 *
 * Rendered by ProtectedProductionRoute IN PLACE OF the requested page
 * whenever staff/{uid}.mustChangePassword is true — there is no route that
 * bypasses it, since every /production/* path mounts through that same
 * guard. The server (staffChangePassword) is the only thing that can clear
 * the flag, and only after it has actually rotated the Firebase Auth
 * password — this screen never trusts a client-only "done" state.
 */
export default function ChangePasswordPage() {
  const { user, logout, updateLoomUser } = useAuth();
  const navigate = useNavigate();
  const effectiveRole = user?.staffRole || user?.role || '';

  // Same role-aware redirect as ProductionLayout.tsx's handleLogout — the
  // SAME shared helper, no duplicated role logic. This screen is only ever
  // reached pre-/production (mustChangePassword gate), so there is no "from"
  // location to return to; always land on the correct login page.
  const handleSignOut = async () => {
    await logout();
    navigate(getPostLogoutRedirectPath(effectiveRole, isLoomHost()));
  };

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      const changeFn = httpsCallable(functions, 'staffChangePassword');
      await changeFn({ newPassword });
      updateLoomUser({ mustChangePassword: false });
      setDone(true);
    } catch (err: any) {
      setError(err?.message || 'Could not update your password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <FlowLogo size="lg" className="mx-auto mb-4" />
          <p className="text-[10px] tracking-[0.4em] text-gray-500 mt-1">SECURITY REQUIRED</p>
        </div>

        <div className="bg-white border border-gray-200 rounded-2xl p-8 shadow-xl">
          <h2 className="font-display text-lg text-black text-center mb-1">
            {done ? 'Password Updated' : 'Change Your Password'}
          </h2>
          <p className="text-[11px] text-gray-500 text-center mb-6 leading-relaxed">
            {done
              ? 'You can now continue into LUXARDO FLOW.'
              : `You're signed in with a temporary password${user?.name ? `, ${user.name}` : ''}. Set a new password to continue.`}
          </p>

          {error && (
            <div className="bg-red-50 text-red-700 p-3 mb-4 text-xs border border-red-100 rounded-lg flex items-start gap-2">
              <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {done ? (
            <div className="flex flex-col items-center gap-4">
              <ShieldCheck size={40} className="text-green-600" />
              <p className="text-xs text-gray-500">Reloading your workspace…</p>
              {/* A full reload re-runs onAuthStateChanged, re-resolving from
                  staff/{uid} — belt-and-braces on top of updateLoomUser's
                  optimistic clear above. */}
              {(() => { window.location.reload(); return null; })()}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="New password (min. 8 characters)"
                  className="w-full border border-gray-300 rounded-lg pl-10 pr-10 py-3 text-sm focus:outline-none focus:border-black"
                  autoComplete="new-password"
                  autoFocus
                  required
                />
                <button type="button" onClick={() => setShowPwd(!showPwd)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-black">
                  {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  className="w-full border border-gray-300 rounded-lg pl-10 pr-3 py-3 text-sm focus:outline-none focus:border-black"
                  autoComplete="new-password"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-black text-white rounded-lg py-3 text-xs tracking-[0.3em] uppercase hover:bg-gray-900 transition-colors flex items-center justify-center gap-2 mt-2 shadow-md disabled:opacity-50"
              >
                {loading ? 'Updating...' : 'Set Password & Continue'} <ArrowRight size={14} />
              </button>
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full text-xs text-gray-500 hover:text-black tracking-wider mt-2 flex items-center justify-center gap-1"
              >
                <LogOut size={12} /> Sign out
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
