import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Lock, Mail, KeyRound, Eye, EyeOff, ShieldAlert, ArrowRight, Clock, ArrowLeft, Phone } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  ConfirmationResult,
  updatePassword,
} from 'firebase/auth';
import { auth, db, functions } from '../../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { normalizeStaffRole, isCanonicalStaffRole, isPrivilegedEmail, isEligibleLoomIdentity, isEligibleForMobileRecovery } from '../../utils/loomIdentity';
import { isValidE164, toE164 } from '../../utils/phone';
import PhoneInput from 'react-phone-input-2';
import 'react-phone-input-2/lib/style.css';

const MAX_FAILED_ATTEMPTS = 3;
const LOCKOUT_DURATION_MINUTES = 15;

export interface RoleLoginConfig {
  /** Display title above logo. e.g. "OWNER", "DISPATCH", "ACCOUNTS" */
  roleLabel: string;
  /** Allowed customer doc roles to enter this page. */
  allowedRoles: string[];
  /** Default redirect after success. e.g. "/owner/dashboard" */
  redirectPath: string;
  /** Unique localStorage key for lock state (avoid clobbering admin lock). */
  lockKey: string;
  /** Unique localStorage key for attempts counter. */
  attemptsKey: string;
  /** Subtitle copy. e.g. "Operations staff only" */
  tagline?: string;
  /** Where to send wrong-role users (default /backend). */
  wrongRoleRedirect?: string;
  /**
   * Common LUXARDO FLOW staff login: accept ANY canonical staff role except
   * Super Admin (who has a dedicated page), resolve identity from staff/{uid},
   * always land on /production, and hide the (inoperable) email-reset flow —
   * the staff identifiers are not real mailboxes.
   */
  common?: boolean;
}

export default function RoleLoginPage({
  roleLabel,
  allowedRoles,
  redirectPath,
  lockKey,
  attemptsKey,
  tagline = 'Authorised personnel only',
  wrongRoleRedirect = '/backend',
  common = false,
}: RoleLoginConfig) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isAuthReady, waitForResolution } = useAuth();

  const [mode, setMode] = useState<'login' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState('');
  const [okMsg, setOkMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [lockTimer, setLockTimer] = useState<number>(0);

  // ── LUXARDO FLOW (common) only: mobile-number sign-in + mobile-OTP
  // password recovery. Firebase's native phone auth already resolves to the
  // SAME staff/{uid} Firestore-role-gated identity once an admin has set a
  // matching phoneNumber on that staff member's Auth record (staffCreate /
  // staffUpdate) — no separate backend/lookup mechanism is introduced.
  const [loginTab, setLoginTab] = useState<'password' | 'phone'>('password');
  const [phoneLoginStep, setPhoneLoginStep] = useState<'enter' | 'otp'>('enter');
  // Mobile-OTP password recovery (common/LUXARDO FLOW only) — the phone
  // number is NEVER something the requester types. 'identify': enter the
  // account email. 'confirm': show only the masked last-4 digits of the
  // AUTHORITATIVE stored number and require explicit confirmation before
  // anything is sent. 'otp': verify the code + set the new password.
  const [resetStep, setResetStep] = useState<'identify' | 'confirm' | 'otp'>('identify');
  const [resetEmailValue, setResetEmailValue] = useState('');
  const [resetLookupLoading, setResetLookupLoading] = useState(false);
  const [resetMaskedLast4, setResetMaskedLast4] = useState<string | null>(null);
  // Opaque, short-lived, single-use token from mobileResetLookup — NOT the
  // phone number. Exchanged for the real number (mobileResetSendOtp) only
  // at the instant "Send OTP" is clicked; that number is passed straight
  // into signInWithPhoneNumber() and never stored in any React state or
  // rendered anywhere.
  const resetRecoveryTokenRef = useRef<string | null>(null);
  const [phoneValue, setPhoneValue] = useState('');
  const [otpValue, setOtpValue] = useState('');
  const [newPasswordValue, setNewPasswordValue] = useState('');
  const [confirmPasswordValue, setConfirmPasswordValue] = useState('');
  const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);
  const recaptchaVerifierRef = useRef<RecaptchaVerifier | null>(null);
  const recaptchaContainerId = useRef(`rcv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`).current;

  const from = (location.state as any)?.from?.pathname || redirectPath;
  // Common staff page always lands on /production; role decides what renders.
  const successTarget = common
    ? ((location.state as any)?.from?.pathname || '/production')
    : from;

  useEffect(() => {
    if (isAuthReady && user) {
      const alreadyAllowed = common
        // Common page = ordinary staff only. Super Admin and Admin both have
        // the dedicated privileged page.
        ? (isCanonicalStaffRole(user.staffRole) && !isPrivilegedEmail(user.email))
        : allowedRoles.includes(user.role);
      if (alreadyAllowed) navigate(successTarget, { replace: true });
    }
    checkLocalLock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, isAuthReady, navigate, successTarget]);

  const checkLocalLock = () => {
    const lockData = localStorage.getItem(lockKey);
    if (lockData) {
      try {
        const lockedUntil = JSON.parse(lockData).lockedUntil;
        if (Date.now() < lockedUntil) {
          setIsLocked(true);
          setLockTimer(Math.ceil((lockedUntil - Date.now()) / 60000));
          return true;
        }
      } catch {}
      localStorage.removeItem(lockKey);
      localStorage.removeItem(attemptsKey);
      setIsLocked(false);
    }
    return false;
  };

  const recordLocalFailure = () => {
    const attempts = parseInt(localStorage.getItem(attemptsKey) || '0', 10) + 1;
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      const lockedUntil = Date.now() + LOCKOUT_DURATION_MINUTES * 60_000;
      localStorage.setItem(lockKey, JSON.stringify({ lockedUntil }));
      setIsLocked(true);
      setLockTimer(LOCKOUT_DURATION_MINUTES);
    } else {
      localStorage.setItem(attemptsKey, attempts.toString());
    }
  };

  // ── reCAPTCHA lifecycle for phone auth (common/LUXARDO FLOW only) ───────
  const initRecaptcha = useCallback(() => {
    if (recaptchaVerifierRef.current) {
      try { recaptchaVerifierRef.current.clear(); } catch {}
      recaptchaVerifierRef.current = null;
    }
    const container = document.getElementById(recaptchaContainerId);
    if (!container) return;
    try {
      recaptchaVerifierRef.current = new RecaptchaVerifier(auth, recaptchaContainerId, {
        size: 'invisible',
        callback: () => {},
        'expired-callback': () => {
          setError('Security verification expired. Please try again.');
          setLoading(false);
          initRecaptcha();
        },
      });
    } catch (e) {
      console.error('[RoleLoginPage] Failed to initialize RecaptchaVerifier:', e);
    }
  }, [recaptchaContainerId]);

  useEffect(() => {
    if (!common) return;
    const timerId = setTimeout(() => initRecaptcha(), 0);
    return () => {
      clearTimeout(timerId);
      if (recaptchaVerifierRef.current) {
        try { recaptchaVerifierRef.current.clear(); } catch {}
        recaptchaVerifierRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [common]);

  const resetPhoneFlowState = () => {
    setPhoneValue(''); setOtpValue(''); setNewPasswordValue(''); setConfirmPasswordValue('');
    setConfirmationResult(null); setPhoneLoginStep('enter'); setError(''); setOkMsg('');
    // STEP 9 — invalidate all temporary recovery state, including the
    // never-displayed authoritative number, on completion/cancel/back-nav.
    setResetStep('identify'); setResetEmailValue(''); setResetMaskedLast4(null);
    resetRecoveryTokenRef.current = null;
  };

  const verifyRole = async (uid: string) => {
    // ── Common LUXARDO FLOW staff login ──────────────────────────────
    // Ordinary staff only. Super Admin and Admin are turned away — they use
    // the dedicated privileged page. That check is a plain string compare
    // (no Firestore round-trip), so it's done immediately and can't race.
    //
    // The actual staff/{uid} identity check is NOT re-read here. It is read
    // exactly once, by AuthContext's onAuthStateChanged listener — the single
    // authoritative resolver — and awaited via waitForResolution(). A prior
    // version of this function did its own independent getDoc(staff/{uid})
    // read here too: AuthContext could approve the user and navigate to
    // /production while this second, redundant read was still in flight, and
    // if that second read then hit a transient failure it called signOut()
    // and killed the session AuthContext had already approved. Awaiting the
    // one shared resolution removes that race entirely.
    if (common) {
      if (isPrivilegedEmail(auth.currentUser?.email)) {
        await signOut(auth);
        throw new Error('Super Admin / Admin: please sign in on the dedicated admin page.');
      }
      let resolvedUser;
      try {
        resolvedUser = await waitForResolution(uid);
      } catch {
        // waitForResolution's own timeout — treated as "no identity" below.
        resolvedUser = null;
      }
      const eligible = !!resolvedUser && isEligibleLoomIdentity(resolvedUser.email, resolvedUser.staffRole);
      const staffRole = eligible ? resolvedUser!.staffRole : undefined;
      if (!staffRole) {
        await signOut(auth);
        throw new Error('This account is not a recognised LUXARDO FLOW staff member. Contact your administrator.');
      }
      return true;
    }

    // ── Dedicated per-role page (B2C) ───────────────────────────────
    // Primary source of truth is `customers/{uid}` (shared B2C AuthContext).
    let role: string | undefined;
    try {
      const userDoc = await getDoc(doc(db, 'customers', uid));
      role = userDoc.exists() ? userDoc.data()?.role?.toLowerCase() : undefined;
    } catch {
      role = undefined; // customers/{uid} not readable here → fall through to staff/{uid}
    }

    // Fallback: Loom staff whose identity lives only in `staff/{uid}`
    // (no customers mirror yet). Only triggers when the customer doc is
    // absent, so existing B2C behaviour is unchanged.
    if (!role) {
      const staffDoc = await getDoc(doc(db, 'staff', uid));
      if (staffDoc.exists() && staffDoc.data()?.active !== false) {
        role = normalizeStaffRole(staffDoc.data()?.role) ?? undefined;
      }
    }

    if (!role) {
      await signOut(auth);
      throw new Error('Account record not found. Contact support.');
    }
    if (allowedRoles.includes(role)) return true;

    // Recognised but wrong-role users get a friendly redirect
    await signOut(auth);
    if (isCanonicalStaffRole(role) || ['admin', 'super_admin'].includes(role)) {
      throw new Error(`This page is for "${roleLabel}". Your role is "${role.toUpperCase()}". Use the right portal.`);
    }
    throw new Error('Access denied: this account is not authorised for staff portal.');
  };

  const errMsg = (code: string) => {
    switch (code) {
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
        return 'Incorrect email or password.';
      case 'auth/user-not-found':
        return 'No account found.';
      case 'auth/invalid-email':
        return 'Invalid email format.';
      case 'auth/too-many-requests':
        return 'Too many attempts. Try again later.';
      case 'auth/network-request-failed':
        return 'Network error. Check your connection.';
      case 'auth/popup-closed-by-user':
        return 'Sign-in cancelled.';
      case 'auth/popup-blocked':
        return 'Popup blocked. Allow popups and try again.';
      case 'auth/account-exists-with-different-credential':
        return 'This email already has a password login. Sign in with your email and password first, then link Google from your account.';
      default:
        return 'Authentication failed.';
    }
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setOkMsg('');
    setLoading(true);
    try {
      if (checkLocalLock()) {
        setLoading(false);
        return;
      }
      const submitEmail = email.trim().toLowerCase();
      const cred = await signInWithEmailAndPassword(auth, submitEmail, password);
      await verifyRole(cred.user.uid);
      localStorage.removeItem(attemptsKey);
      localStorage.removeItem(lockKey);
      navigate(successTarget, { replace: true });
    } catch (err: any) {
      recordLocalFailure();
      setError(err?.code ? errMsg(err.code) : (err?.message || 'Authentication failed.'));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setError('');
    setOkMsg('');
    setLoading(true);
    try {
      if (checkLocalLock()) {
        setLoading(false);
        return;
      }
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const cred = await signInWithPopup(auth, provider);
      await verifyRole(cred.user.uid);
      localStorage.removeItem(attemptsKey);
      localStorage.removeItem(lockKey);
      navigate(successTarget, { replace: true });
    } catch (err: any) {
      recordLocalFailure();
      setError(err?.code ? errMsg(err.code) : (err?.message || 'Google sign-in failed.'));
    } finally {
      setLoading(false);
    }
  };

  // ── Mobile-number sign-in (common/LUXARDO FLOW only) ────────────────────
  const handleSendLoginOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setOkMsg('');
    if (!phoneValue || phoneValue.length < 8) {
      setError('Please enter a valid mobile number with country code.');
      return;
    }
    setLoading(true);
    try {
      if (checkLocalLock()) { setLoading(false); return; }
      if (!recaptchaVerifierRef.current) {
        initRecaptcha();
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!recaptchaVerifierRef.current) throw new Error('Could not initialize security check. Please refresh the page.');
      const confirmation = await signInWithPhoneNumber(auth, '+' + phoneValue, recaptchaVerifierRef.current);
      setConfirmationResult(confirmation);
      setPhoneLoginStep('otp');
    } catch (err: any) {
      if (recaptchaVerifierRef.current) {
        try { recaptchaVerifierRef.current.clear(); } catch {}
        recaptchaVerifierRef.current = null;
      }
      initRecaptcha();
      if (err.code === 'auth/too-many-requests') setError('Too many attempts. Please wait a few minutes and try again.');
      else if (err.code === 'auth/invalid-phone-number') setError('Invalid mobile number. Please include your country code.');
      else setError(err.message || 'Failed to send OTP. Please check your connection.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyLoginOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!otpValue || otpValue.length !== 6) {
      setError('Please enter the 6-digit verification code.');
      return;
    }
    setLoading(true);
    try {
      if (!confirmationResult) throw new Error('Session lost. Please request a new code.');
      const cred = await confirmationResult.confirm(otpValue);
      await verifyRole(cred.user.uid);
      localStorage.removeItem(attemptsKey);
      localStorage.removeItem(lockKey);
      navigate(successTarget, { replace: true });
    } catch (err: any) {
      recordLocalFailure();
      if (err.code === 'auth/invalid-verification-code') setError('Incorrect code. Please double-check and try again.');
      else if (err.code === 'auth/code-expired') setError('Code expired. Please request a new one.');
      else setError(err?.message || 'Verification failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Mobile-OTP password recovery (common/LUXARDO FLOW only) ─────────────
  //
  // STEP 2-4: identify the User by email, resolve the AUTHORITATIVE stored
  // mobile number server-side (mobileResetLookup — see functions/src/
  // production.ts), and check eligibility (exists / active / has a mobile
  // number). The requester never types a phone number here, and the
  // response NEVER contains the full number — only its last 4 digits and
  // an opaque, short-lived, single-use recoveryToken. The number itself
  // stays server-side until the explicit "Send OTP" confirmation below.
  const handleIdentifyForReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setOkMsg('');
    if (checkLocalLock()) return;
    const target = resetEmailValue.trim().toLowerCase();
    if (!target) {
      setError('Please enter your account email.');
      return;
    }
    setResetLookupLoading(true);
    try {
      const lookupFn = httpsCallable(functions, 'mobileResetLookup');
      const result = await lookupFn({ email: target });
      const data = result.data as { eligible: boolean; reason?: string; maskedLast4?: string; recoveryToken?: string };
      if (!data.eligible) {
        recordLocalFailure();
        if (data.reason === 'inactive') setError('This User account is inactive. Contact your administrator.');
        else if (data.reason === 'no_mobile') setError('No mobile number is configured for this User. Contact your administrator.');
        else setError('This mobile number is not registered for this User.');
        return;
      }
      resetRecoveryTokenRef.current = data.recoveryToken!;
      setResetMaskedLast4(data.maskedLast4 || null);
      setResetStep('confirm');
    } catch (err: any) {
      recordLocalFailure();
      setError(err?.message || 'Could not look up this account. Please try again.');
    } finally {
      setResetLookupLoading(false);
    }
  };

  // STEP 5-6: only when the User explicitly clicks "Send OTP" do we exchange
  // the recoveryToken for the real number (mobileResetSendOtp — single-use,
  // re-validates eligibility fresh, server-side). The result is passed
  // straight into signInWithPhoneNumber() in the same expression — it is
  // never assigned to a React state variable and never rendered anywhere.
  const handleConfirmSendOtp = async () => {
    setError(''); setOkMsg('');
    const token = resetRecoveryTokenRef.current;
    if (!token) {
      setError('Session expired. Please start again.');
      setResetStep('identify');
      return;
    }
    setLoading(true);
    try {
      if (!recaptchaVerifierRef.current) {
        initRecaptcha();
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!recaptchaVerifierRef.current) throw new Error('Could not initialize security check. Please refresh the page.');
      const sendOtpFn = httpsCallable(functions, 'mobileResetSendOtp');
      const exchangeResult = await sendOtpFn({ recoveryToken: token });
      const { phoneNumber } = exchangeResult.data as { phoneNumber: string };
      const confirmation = await signInWithPhoneNumber(auth, phoneNumber, recaptchaVerifierRef.current);
      setConfirmationResult(confirmation);
      setResetStep('otp');
    } catch (err: any) {
      if (recaptchaVerifierRef.current) {
        try { recaptchaVerifierRef.current.clear(); } catch {}
        recaptchaVerifierRef.current = null;
      }
      initRecaptcha();
      if (err.code === 'auth/too-many-requests') setError('Too many attempts. Please wait a few minutes and try again.');
      else setError(err.message || 'Failed to send OTP. Please check your connection.');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmResetOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!otpValue || otpValue.length !== 6) {
      setError('Please enter the 6-digit verification code.');
      return;
    }
    if (newPasswordValue.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPasswordValue !== confirmPasswordValue) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      if (!confirmationResult) throw new Error('Session lost. Please request a new code.');
      const cred = await confirmationResult.confirm(otpValue);

      // Defense-in-depth re-check: mobileResetLookup + mobileResetSendOtp
      // already established eligibility (STEP 2-6) before any OTP was ever
      // sent. This uses isEligibleForMobileRecovery — deliberately NOT
      // isEligibleLoomIdentity (the LOGIN gate, which excludes Admin/Super
      // Admin) — password recovery must work for every eligible User
      // including Owner, Admin and Super Admin; only LOGIN stays routed to
      // /admin/login for the latter two. This final check only guards the
      // (narrow) window between OTP send and OTP verification completing,
      // e.g. an admin deactivating the account in between. Fails closed.
      const staffSnap = await getDoc(doc(db, 'staff', cred.user.uid));
      const data = staffSnap.exists() ? staffSnap.data() : null;
      if (!isEligibleForMobileRecovery(data?.role, data?.active)) {
        await signOut(auth);
        throw new Error('This mobile number is not registered for this User.');
      }

      await updatePassword(cred.user, newPasswordValue);
      await signOut(auth);
      resetPhoneFlowState();
      setMode('login');
      setOkMsg('Password updated. Please sign in with your new password.');
    } catch (err: any) {
      recordLocalFailure();
      if (err.code === 'auth/invalid-verification-code') setError('Incorrect code. Please double-check and try again.');
      else if (err.code === 'auth/code-expired') setError('Code expired. Please request a new one.');
      else setError(err?.message || 'Password reset failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setOkMsg('');
    const target = email.trim().toLowerCase();
    // The common staff page has no email-reset workflow at all — the staff
    // identifiers are not mailboxes. (This handler is only reachable from the
    // non-common per-role pages and the privileged admin page.)
    if (common) {
      setError('Ask your administrator to reset your staff password.');
      return;
    }
    setLoading(true);
    try {
      await sendPasswordResetEmail(auth, target);
      setOkMsg('Password reset link sent. Check your inbox.');
      setTimeout(() => setMode('login'), 3000);
    } catch (err: any) {
      setError(err?.code ? errMsg(err.code) : (err?.message || 'Failed to send reset link.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        {!common && (
          <Link to={wrongRoleRedirect} className="inline-flex items-center gap-2 text-xs text-gray-500 hover:text-black mb-6">
            <ArrowLeft size={14} /> Back to portal selection
          </Link>
        )}

        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-black rounded-full mb-4 shadow-md">
            <Lock size={20} className="text-white" />
          </div>
          <h1 className="font-display text-2xl text-black tracking-[0.3em] uppercase">
            {common ? 'LUXARDO FLOW' : 'LUXARDO'}
          </h1>
          <p className="text-[10px] tracking-[0.4em] text-gray-500 mt-1">
            {common ? 'SIGN IN' : `${roleLabel} ACCESS`}
          </p>
        </div>

        <div className="bg-white border border-gray-200 rounded-2xl p-8 shadow-xl relative overflow-hidden">
          {/* Security overlay when locked */}
          {isLocked && mode === 'login' && (
            <div className="absolute inset-0 bg-white/95 backdrop-blur-sm z-10 flex flex-col items-center justify-center p-6 text-center border-t-4 border-red-600">
              <Clock size={40} className="text-red-500 mb-4 animate-pulse" />
              <h3 className="font-display text-lg text-black uppercase mb-2 tracking-widest">Security Lock</h3>
              <p className="text-xs text-gray-500 mb-6 leading-relaxed">
                Multiple failed login attempts detected. This portal is temporarily locked for
                <span className="font-bold text-red-600"> {lockTimer} minutes</span>.
              </p>
              <button
                onClick={() => { resetPhoneFlowState(); setMode('reset'); setIsLocked(false); }}
                className="w-full bg-black text-white py-3 text-xs tracking-[0.3em] uppercase hover:bg-gray-900 transition-colors flex items-center justify-center gap-2 rounded-lg"
              >
                Reset Password
              </button>
            </div>
          )}

          <h2 className="font-display text-lg text-black text-center mb-1">
            {mode === 'login' ? 'Sign In' : 'Reset Password'}
          </h2>
          <p className="text-[10px] tracking-widest uppercase text-gray-400 text-center mb-6">{tagline}</p>

          {error && (
            <div className="bg-red-50 text-red-700 p-3 mb-4 text-xs border border-red-100 rounded-lg flex items-start gap-2">
              <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {okMsg && <div className="bg-green-50 text-green-700 p-3 mb-4 text-xs border border-green-100 rounded-lg">{okMsg}</div>}

          {mode === 'login' && (
            <>
              {!common && (
                <>
                  <button
                    type="button"
                    onClick={handleGoogleLogin}
                    disabled={loading || isLocked}
                    className="w-full flex items-center justify-center gap-3 border border-gray-200 rounded-lg py-3 text-sm text-black hover:bg-gray-50 transition-all shadow-sm disabled:opacity-50"
                  >
                    <svg width="16" height="16" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
                      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" fill="#4285F4"/>
                      <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
                      <path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/>
                      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" fill="#EA4335"/>
                    </svg>
                    Sign in with Google
                  </button>

                  <div className="flex items-center my-5">
                    <div className="flex-1 h-px bg-gray-200"></div>
                    <span className="px-3 text-[9px] tracking-[0.3em] uppercase text-gray-400">or use credentials</span>
                    <div className="flex-1 h-px bg-gray-200"></div>
                  </div>
                </>
              )}

              {common && (
                <div className="flex mb-6 border border-gray-200 rounded-lg p-1 bg-gray-50">
                  <button
                    type="button"
                    onClick={() => { setLoginTab('password'); setError(''); }}
                    className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-widest rounded-md transition-colors ${loginTab === 'password' ? 'bg-black text-white' : 'text-gray-500 hover:text-black'}`}
                  >
                    Email &amp; Password
                  </button>
                  <button
                    type="button"
                    onClick={() => { setLoginTab('phone'); setError(''); }}
                    className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-widest rounded-md transition-colors ${loginTab === 'phone' ? 'bg-black text-white' : 'text-gray-500 hover:text-black'}`}
                  >
                    Mobile Number
                  </button>
                </div>
              )}

              {(!common || loginTab === 'password') && (
                <form onSubmit={handleEmailLogin} className="space-y-4" autoComplete="off">
                  <input type="text" style={{ display: 'none' }} />
                  <input type="password" style={{ display: 'none' }} />

                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={`${roleLabel.toLowerCase()} email`}
                      className="w-full border border-gray-300 rounded-lg pl-10 pr-3 py-3 text-sm focus:outline-none focus:border-black"
                      required
                      autoComplete="nope"
                    />
                  </div>
                  <div className="relative">
                    <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                    <input
                      type={showPwd ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Password"
                      className="w-full border border-gray-300 rounded-lg pl-10 pr-10 py-3 text-sm focus:outline-none focus:border-black"
                      required
                      autoComplete="new-password"
                    />
                    <button type="button" onClick={() => setShowPwd(!showPwd)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-black">
                      {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <button
                    type="submit"
                    disabled={loading || isLocked}
                    className="w-full bg-black text-white rounded-lg py-3 text-xs tracking-[0.3em] uppercase hover:bg-gray-900 transition-colors flex items-center justify-center gap-2 mt-2 shadow-md disabled:opacity-50"
                  >
                    {loading ? 'Verifying...' : 'Sign In'} <ArrowRight size={14} />
                  </button>
                  <div className="text-center pt-1">
                    {common ? (
                      <button
                        type="button"
                        onClick={() => { resetPhoneFlowState(); setMode('reset'); }}
                        className="text-xs text-gray-500 hover:text-black tracking-wider"
                      >
                        Forgot password? Reset via mobile OTP
                      </button>
                    ) : (
                      <button type="button" onClick={() => setMode('reset')} className="text-xs text-gray-500 hover:text-black tracking-wider">Forgot password?</button>
                    )}
                  </div>
                </form>
              )}

              {common && loginTab === 'phone' && phoneLoginStep === 'enter' && (
                <form onSubmit={handleSendLoginOtp} className="space-y-4">
                  <div>
                    <label className="text-[10px] uppercase tracking-widest font-bold text-gray-500 mb-2 block">Mobile Number</label>
                    <PhoneInput
                      country={'in'}
                      value={phoneValue}
                      onChange={(phone) => setPhoneValue(phone)}
                      enableSearch
                      disableSearchIcon
                      inputProps={{ name: 'phone', required: true }}
                      containerClass="!w-full font-sans"
                      inputClass="!w-full !h-[46px] !pl-14 !bg-white !border !border-gray-300 focus:!border-black transition-colors !rounded-lg !text-sm"
                      buttonClass="!bg-white !border-0 !border-r !border-gray-300 !rounded-l-lg hover:!bg-gray-50"
                      dropdownClass="!shadow-2xl !border !border-gray-200 !rounded-xl text-sm !max-h-56 !overflow-y-auto"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading || isLocked}
                    className="w-full bg-black text-white rounded-lg py-3 text-xs tracking-[0.3em] uppercase hover:bg-gray-900 transition-colors flex items-center justify-center gap-2 mt-2 shadow-md disabled:opacity-50"
                  >
                    {loading ? 'Sending...' : 'Send OTP'} <Phone size={14} />
                  </button>
                </form>
              )}

              {common && loginTab === 'phone' && phoneLoginStep === 'otp' && (
                <form onSubmit={handleVerifyLoginOtp} className="space-y-4">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] uppercase tracking-widest font-bold text-gray-500">Verification Code</label>
                    <button type="button" onClick={() => { setPhoneLoginStep('enter'); setOtpValue(''); setError(''); }} className="text-[10px] text-gray-400 hover:text-black uppercase flex items-center gap-1">
                      <ArrowLeft size={10} /> Change Number
                    </button>
                  </div>
                  <div className="relative">
                    <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                    <input
                      type="text"
                      inputMode="numeric"
                      value={otpValue}
                      onChange={(e) => setOtpValue(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                      placeholder="• • • • • •"
                      className="w-full border border-gray-300 rounded-lg pl-10 pr-3 py-3 text-lg tracking-[0.4em] focus:outline-none focus:border-black"
                      autoFocus
                    />
                  </div>
                  <p className="text-[10px] text-gray-400">Code sent to +{phoneValue}</p>
                  <button
                    type="submit"
                    disabled={loading || isLocked || otpValue.length !== 6}
                    className="w-full bg-black text-white rounded-lg py-3 text-xs tracking-[0.3em] uppercase hover:bg-gray-900 transition-colors flex items-center justify-center gap-2 mt-2 shadow-md disabled:opacity-50"
                  >
                    {loading ? 'Verifying...' : 'Verify & Sign In'} <ArrowRight size={14} />
                  </button>
                </form>
              )}
            </>
          )}

          {mode === 'reset' && !common && (
            <form onSubmit={handleReset} className="space-y-4 relative z-20" autoComplete="off">
              <input type="text" style={{ display: 'none' }} />
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={`${roleLabel.toLowerCase()} email`}
                  className="w-full border border-gray-300 rounded-lg pl-10 pr-3 py-3 text-sm focus:outline-none focus:border-black"
                  required
                  autoComplete="nope"
                />
              </div>
              <button type="submit" disabled={loading} className="w-full bg-black text-white rounded-lg py-3 text-xs tracking-[0.3em] uppercase hover:bg-gray-900 shadow-md disabled:opacity-50">
                Send Recovery Link
              </button>
              <button type="button" onClick={() => { setMode('login'); setIsLocked(false); }} className="w-full text-xs text-gray-500 hover:text-black tracking-wider mt-2">Back to sign in</button>
            </form>
          )}

          {/* STEP 1-2: identify the User by email — never a phone number. */}
          {mode === 'reset' && common && resetStep === 'identify' && (
            <form onSubmit={handleIdentifyForReset} className="space-y-4 relative z-20">
              <p className="text-[11px] text-gray-500 leading-relaxed mb-2">
                Enter your LUXARDO FLOW account email. If it has a registered mobile number, we'll ask you to confirm it before sending a code.
              </p>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                <input
                  type="email"
                  value={resetEmailValue}
                  onChange={(e) => setResetEmailValue(e.target.value)}
                  placeholder="account email"
                  className="w-full border border-gray-300 rounded-lg pl-10 pr-3 py-3 text-sm focus:outline-none focus:border-black"
                  required
                  autoComplete="email"
                  autoFocus
                />
              </div>
              <button type="submit" disabled={resetLookupLoading} className="w-full bg-black text-white rounded-lg py-3 text-xs tracking-[0.3em] uppercase hover:bg-gray-900 shadow-md disabled:opacity-50 flex items-center justify-center gap-2">
                {resetLookupLoading ? 'Checking...' : 'Continue'} <ArrowRight size={14} />
              </button>
              <button type="button" onClick={() => { resetPhoneFlowState(); setMode('login'); }} className="w-full text-xs text-gray-500 hover:text-black tracking-wider mt-2">Back to sign in</button>
            </form>
          )}

          {/* STEP 5: masked last-4 confirmation — the full number is never rendered. */}
          {mode === 'reset' && common && resetStep === 'confirm' && (
            <div className="space-y-4 relative z-20">
              <p className="text-[11px] text-gray-500 leading-relaxed mb-2">Confirm this is your registered mobile number.</p>
              <div className="flex items-center justify-center gap-2 border border-gray-200 rounded-xl py-5 bg-gray-50">
                <Phone size={16} className="text-gray-400" />
                <span className="text-lg font-mono tracking-widest text-black">•••••••• {resetMaskedLast4}</span>
              </div>
              <button
                type="button"
                onClick={handleConfirmSendOtp}
                disabled={loading}
                className="w-full bg-black text-white rounded-lg py-3 text-xs tracking-[0.3em] uppercase hover:bg-gray-900 shadow-md disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? 'Sending...' : 'Send OTP'} <Phone size={14} />
              </button>
              <button
                type="button"
                onClick={() => { setResetStep('identify'); setResetMaskedLast4(null); resetRecoveryTokenRef.current = null; setError(''); }}
                className="w-full text-xs text-gray-500 hover:text-black tracking-wider mt-2"
              >
                Change / Cancel
              </button>
            </div>
          )}

          {mode === 'reset' && common && resetStep === 'otp' && (
            <form onSubmit={handleConfirmResetOtp} className="space-y-4 relative z-20">
              <div className="flex items-center justify-between">
                <label className="text-[10px] uppercase tracking-widest font-bold text-gray-500">Verification Code</label>
                <button type="button" onClick={() => { setResetStep('confirm'); setOtpValue(''); setError(''); }} className="text-[10px] text-gray-400 hover:text-black uppercase flex items-center gap-1">
                  <ArrowLeft size={10} /> Back
                </button>
              </div>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                <input
                  type="text"
                  inputMode="numeric"
                  value={otpValue}
                  onChange={(e) => setOtpValue(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                  placeholder="• • • • • •"
                  className="w-full border border-gray-300 rounded-lg pl-10 pr-3 py-3 text-lg tracking-[0.4em] focus:outline-none focus:border-black"
                  autoFocus
                />
              </div>
              <p className="text-[10px] text-gray-400">Code sent to •••••••• {resetMaskedLast4}</p>

              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={newPasswordValue}
                  onChange={(e) => setNewPasswordValue(e.target.value)}
                  placeholder="New password (min. 8 characters)"
                  className="w-full border border-gray-300 rounded-lg pl-10 pr-10 py-3 text-sm focus:outline-none focus:border-black"
                  autoComplete="new-password"
                />
                <button type="button" onClick={() => setShowPwd(!showPwd)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-black">
                  {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={confirmPasswordValue}
                  onChange={(e) => setConfirmPasswordValue(e.target.value)}
                  placeholder="Confirm new password"
                  className="w-full border border-gray-300 rounded-lg pl-10 pr-3 py-3 text-sm focus:outline-none focus:border-black"
                  autoComplete="new-password"
                />
              </div>

              <button
                type="submit"
                disabled={loading || otpValue.length !== 6}
                className="w-full bg-black text-white rounded-lg py-3 text-xs tracking-[0.3em] uppercase hover:bg-gray-900 shadow-md disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? 'Updating...' : 'Verify & Reset Password'} <ArrowRight size={14} />
              </button>
              <button type="button" onClick={() => { resetPhoneFlowState(); setMode('login'); }} className="w-full text-xs text-gray-500 hover:text-black tracking-wider mt-2">Back to sign in</button>
            </form>
          )}
        </div>

        {common && (
          <div
            id={recaptchaContainerId}
            aria-hidden="true"
            style={{ position: 'absolute', bottom: 0, left: 0, opacity: 0, pointerEvents: 'none' }}
          />
        )}

        <p className="text-center text-[10px] tracking-[0.3em] text-gray-400 uppercase mt-6">Restricted Access</p>
      </div>
    </div>
  );
}
