import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Lock, Mail, KeyRound, Eye, EyeOff, ShieldAlert, ArrowRight, Clock, Phone } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import FlowLogo from '../../components/FlowLogo';
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCustomToken,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  ConfirmationResult,
} from 'firebase/auth';
import { auth, db, functions } from '../../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { normalizeStaffRole, isCanonicalStaffRole, isLoomHost, isEligibleForPrivilegedLoginPage, isEligibleForMobileRecovery } from '../../utils/loomIdentity';
import PhoneInput from 'react-phone-input-2';
import 'react-phone-input-2/lib/style.css';

const MAX_FAILED_ATTEMPTS = 3;
const LOCKOUT_DURATION_MINUTES = 15;

export default function AdminLoginPage() {
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

  // ── P0-2: Mobile Number + Password (privileged tier only) ───────────────
  // A third, parallel credential-based login method alongside Email+Password
  // and Google — NOT an OTP flow. See functions/src/privilegedAuth.ts.
  const [authTab, setAuthTab] = useState<'password' | 'mobile'>('password');
  const [mobilePhone, setMobilePhone] = useState('');
  const [mobilePassword, setMobilePassword] = useState('');
  const [mobileShowPwd, setMobileShowPwd] = useState(false);

  // ── V1 Auth Stabilization: Mobile-OTP password recovery, privileged tier.
  // Owner/Admin/Super Admin already had the real Gmail-backed email reset
  // below (sendPasswordResetEmail); this adds the SAME mobile-OTP mechanism
  // RoleLoginPage.tsx's common mode already uses for operational staff —
  // identical callables (mobileResetLookup/mobileResetSendOtp), identical
  // steps, identical defense-in-depth re-check (isEligibleForMobileRecovery
  // already admits Owner/Admin/Super Admin — see loomIdentity.ts). The
  // requester never types a phone number; only the masked last-4 digits are
  // ever shown, and the full number is exchanged for only at the instant
  // "Send OTP" is clicked.
  const [resetTab, setResetTab] = useState<'email' | 'mobile'>('email');
  const [resetStep, setResetStep] = useState<'identify' | 'confirm' | 'otp'>('identify');
  const [resetEmailValue, setResetEmailValue] = useState('');
  const [resetLookupLoading, setResetLookupLoading] = useState(false);
  const [resetMaskedLast4, setResetMaskedLast4] = useState<string | null>(null);
  const resetRecoveryTokenRef = React.useRef<string | null>(null);
  const [otpValue, setOtpValue] = useState('');
  const [newPasswordValue, setNewPasswordValue] = useState('');
  const [confirmPasswordValue, setConfirmPasswordValue] = useState('');
  const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);
  const recaptchaVerifierRef = React.useRef<RecaptchaVerifier | null>(null);
  const recaptchaContainerId = React.useRef(`rcv-admin-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`).current;

  const fromPath = (location.state as any)?.from?.pathname as string | undefined;
  const from = fromPath || '/admin/dashboard';

  useEffect(() => {
    if (isAuthReady && user) {
      if (isLoomHost()) {
        // LUXARDO FLOW: this page authenticates the ONE privileged group —
        // Owner, Admin AND Super Admin all share it — and, like every other
        // identity, requires the resolved role to actually be one of the
        // three, resolved through an active staff/{uid} doc rather than
        // merely a recognised email (see AuthContext.tsx).
        if (isEligibleForPrivilegedLoginPage(user.role)) {
          navigate(fromPath || '/production', { replace: true });
        } else if (isCanonicalStaffRole(user.staffRole)) {
          // An ordinary operational staff member landed here — send them to
          // the common page.
          navigate('/login', { replace: true });
        }
      } else if (['admin', 'super_admin'].includes(user.role)) {
        navigate(from, { replace: true });
      }
    }
    checkLocalLock();
  }, [user, isAuthReady, navigate, from, fromPath]);

  // LOCAL STORAGE LOCK LOGIC
  const checkLocalLock = () => {
    const lockData = localStorage.getItem('admin_lock');
    if (lockData) {
      const lockedUntil = JSON.parse(lockData).lockedUntil;
      if (Date.now() < lockedUntil) {
        setIsLocked(true);
        setLockTimer(Math.ceil((lockedUntil - Date.now()) / 60000));
        return true;
      } else {
        localStorage.removeItem('admin_lock');
        localStorage.removeItem('admin_attempts');
        setIsLocked(false);
      }
    }
    return false;
  };

  const recordLocalFailure = () => {
    const attempts = parseInt(localStorage.getItem('admin_attempts') || '0') + 1;
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      const lockedUntil = Date.now() + LOCKOUT_DURATION_MINUTES * 60000;
      localStorage.setItem('admin_lock', JSON.stringify({ lockedUntil }));
      setIsLocked(true);
      setLockTimer(LOCKOUT_DURATION_MINUTES);
    } else {
      localStorage.setItem('admin_attempts', attempts.toString());
    }
  };

  // Returns 'admin' for the privileged group (Owner/Admin/Super Admin), or
  // 'staff' for any other canonical Loom staff role (only accepted on the
  // Loom host, which has no /backend).
  const verifyAdminRole = async (uid: string): Promise<'admin' | 'staff'> => {
    // ── LUXARDO FLOW: this is the ONE privileged page — Owner, Admin and
    // Super Admin all sign in here. Resolved via the SAME race-safe
    // waitForResolution() channel every other Loom page uses — never a
    // second, independent staff/{uid} read — and requires the resolved role
    // to actually be one of the three: the Gmail identifier alone (for
    // Admin/Super Admin) is never sufficient (AuthContext itself now also
    // requires a matching active staff/{uid} doc before resolving it at
    // all), and Owner resolves through its own staff/{uid} doc the same way
    // any operational role does.
    if (isLoomHost()) {
      let resolvedUser;
      try {
        resolvedUser = await waitForResolution(uid);
      } catch {
        resolvedUser = null;
      }
      if (resolvedUser && isEligibleForPrivilegedLoginPage(resolvedUser.role)) return 'admin';
      await signOut(auth);
      if (resolvedUser && isCanonicalStaffRole(resolvedUser.staffRole)) {
        throw new Error('This sign-in is for Owner, Admin and Super Admin only. Staff members use the LUXARDO FLOW staff login page.');
      }
      throw new Error('Account record not found. Sign in again or contact support.');
    }

    // Primary source of truth is customers/{uid} (shared AuthContext).
    const userDoc = await getDoc(doc(db, 'customers', uid));
    let role: string | undefined = userDoc.exists()
      ? userDoc.data()?.role?.toLowerCase()
      : undefined;

    // Fallback: Loom staff whose identity lives only in staff/{uid}.
    if (!role) {
      const staffDoc = await getDoc(doc(db, 'staff', uid));
      if (staffDoc.exists() && staffDoc.data()?.active !== false) {
        role = normalizeStaffRole(staffDoc.data()?.role) ?? undefined;
      }
    }

    if (!role) {
      await signOut(auth);
      throw new Error("Admin record not found. Sign-in again or contact support.");
    }

    if (['admin', 'super_admin'].includes(role)) {
      return 'admin';
    }
    // Loom host: any other canonical staff role is a valid production sign-in.
    if (isLoomHost() && isCanonicalStaffRole(role)) {
      return 'staff';
    }
    // B2C behaviour unchanged.
    if (['dispatch', 'accounts', 'owner'].includes(role)) {
      await signOut(auth);
      throw new Error('Please use the Backend Gateway (/backend) for your role.');
    }
    await signOut(auth);
    throw new Error('Access denied: Unauthorised account.');
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
      case 'auth/account-exists-with-different-credential':
        return 'This email already has a password login. Sign in with email and password first, then link Google.';
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

      // Verify role (throws + signs back out on any ineligible case). Does
      // NOT navigate here — see the useEffect above. Calling navigate()
      // immediately after this resolves races AuthContext's own setUser()
      // commit: this function's `await` is driven by a separate resolution
      // channel (waitForResolution) that can settle before React has
      // actually re-rendered with the new `user`, so a route mounted by an
      // imperative navigate() here could still see the OLD (pre-login)
      // user and bounce to the wrong page. The useEffect fires only after
      // `user` has genuinely updated in React state, so it can't race.
      await verifyAdminRole(cred.user.uid);

      // Success -> Clear lock. Navigation happens via the useEffect above
      // once `user` updates.
      localStorage.removeItem('admin_attempts');
      localStorage.removeItem('admin_lock');

    } catch (err: any) {
      // 🚀 FIX: Ab HAR error par strike count hoga (Password galat ho ya Database Role missing ho)
      recordLocalFailure();
      
      if (err?.message && (err.message.includes('Admin record not found') || err.message.includes('Access denied') || err.message.includes('Backend Gateway'))) {
        setError(err.message);
      } else {
        setError(err?.code ? errMsg(err.code) : (err?.message || 'Authentication failed.'));
      }
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
      // Validates + throws on failure; does NOT navigate — see handleEmailLogin's
      // comment above and the useEffect above for why.
      await verifyAdminRole(cred.user.uid);

      localStorage.removeItem('admin_attempts');
      localStorage.removeItem('admin_lock');
    } catch (err: any) {
      recordLocalFailure();
      if (err?.message && (err.message.includes('Admin record not found') || err.message.includes('Access denied') || err.message.includes('Backend Gateway'))) {
        setError(err.message);
      } else {
        setError(err?.code ? errMsg(err.code) : (err?.message || 'Google sign-in failed.'));
      }
    } finally {
      setLoading(false);
    }
  };

  // ── P0-2: Mobile Number + Password ───────────────────────────────────────
  // Server (privilegedMobilePasswordLogin) resolves phone -> uid, checks
  // staff/{uid} is an ACTIVE Owner/Admin/Super Admin, verifies the password
  // via Identity Toolkit, then returns a Firebase custom token for that SAME
  // uid — signInWithCustomToken() below establishes an ordinary Firebase
  // Auth session, so verifyAdminRole() and every downstream check run
  // completely unchanged, exactly as after Email+Password or Google.
  const handleMobilePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setOkMsg('');
    setLoading(true);
    try {
      if (checkLocalLock()) {
        setLoading(false);
        return;
      }

      const loginFn = httpsCallable(functions, 'privilegedMobilePasswordLogin');
      const result = await loginFn({ phoneNumber: '+' + mobilePhone, password: mobilePassword });
      const { token } = result.data as { token: string };

      const cred = await signInWithCustomToken(auth, token);
      // Validates + throws on failure; does NOT navigate — see handleEmailLogin's
      // comment above and the useEffect above for why.
      await verifyAdminRole(cred.user.uid);

      localStorage.removeItem('admin_attempts');
      localStorage.removeItem('admin_lock');
    } catch (err: any) {
      // The server already returns one fixed, generic message for every
      // failure reason (unknown number, wrong tier, inactive, wrong
      // password, rate-limited) — never distinguish further here.
      recordLocalFailure();
      setError(err?.message || 'Invalid mobile number or password.');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setOkMsg('');
    setLoading(true);
    try {
      await sendPasswordResetEmail(auth, email.trim().toLowerCase());
      setOkMsg('Password reset link sent. Check your inbox.');
      setTimeout(() => setMode('login'), 3000);
    } catch (err: any) {
      setError(err?.code ? errMsg(err.code) : (err?.message || 'Failed to send reset link.'));
    } finally {
      setLoading(false);
    }
  };

  // ── V1 Auth Stabilization: Mobile-OTP password recovery (privileged) ────
  const initRecaptcha = () => {
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
      console.error('[AdminLoginPage] Failed to initialize RecaptchaVerifier:', e);
    }
  };

  useEffect(() => {
    if (mode !== 'reset' || resetTab !== 'mobile') return;
    const timerId = setTimeout(() => initRecaptcha(), 0);
    return () => {
      clearTimeout(timerId);
      if (recaptchaVerifierRef.current) {
        try { recaptchaVerifierRef.current.clear(); } catch {}
        recaptchaVerifierRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, resetTab]);

  const resetPhoneFlowState = () => {
    setOtpValue(''); setNewPasswordValue(''); setConfirmPasswordValue('');
    setConfirmationResult(null); setError(''); setOkMsg('');
    setResetStep('identify'); setResetEmailValue(''); setResetMaskedLast4(null);
    resetRecoveryTokenRef.current = null;
  };

  // STEP 2-4: identify by email, resolve the AUTHORITATIVE stored mobile
  // number server-side (mobileResetLookup) — never a phone number typed by
  // the requester, never the full number in the response.
  const handleIdentifyForReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setOkMsg('');
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
        if (data.reason === 'inactive') setError('This account is inactive. Contact your administrator.');
        else if (data.reason === 'no_mobile') setError('No mobile number is configured for this account. Contact your administrator.');
        else setError('This mobile number is not registered for this account.');
        return;
      }
      resetRecoveryTokenRef.current = data.recoveryToken!;
      setResetMaskedLast4(data.maskedLast4 || null);
      setResetStep('confirm');
    } catch (err: any) {
      setError(err?.message || 'Could not look up this account. Please try again.');
    } finally {
      setResetLookupLoading(false);
    }
  };

  // STEP 5-6: only on explicit "Send OTP" do we exchange the recoveryToken
  // for the real number (mobileResetSendOtp) — passed straight into
  // signInWithPhoneNumber(), never stored in React state or rendered.
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
      // already established eligibility before any OTP was sent.
      // isEligibleForMobileRecovery admits Owner/Admin/Super Admin — this
      // only guards the narrow window between OTP send and verification.
      const staffSnap = await getDoc(doc(db, 'staff', cred.user.uid));
      const data = staffSnap.exists() ? staffSnap.data() : null;
      if (!isEligibleForMobileRecovery(data?.role, data?.active)) {
        await signOut(auth);
        throw new Error('This mobile number is not registered for this account.');
      }

      const changeFn = httpsCallable(functions, 'staffChangePassword');
      await changeFn({ newPassword: newPasswordValue });
      await signOut(auth);
      resetPhoneFlowState();
      setMode('login');
      setOkMsg('Password updated. Please sign in with your new password.');
    } catch (err: any) {
      if (err.code === 'auth/invalid-verification-code') setError('Incorrect code. Please double-check and try again.');
      else if (err.code === 'auth/code-expired') setError('Code expired. Please request a new one.');
      else setError(err?.message || 'Password reset failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          {isLoomHost() ? (
            <FlowLogo size="lg" className="mx-auto mb-4" />
          ) : (
            <>
              <div className="inline-flex items-center justify-center w-14 h-14 bg-black rounded-full mb-4 shadow-md">
                <Lock size={20} className="text-white" />
              </div>
              <h1 className="font-display text-2xl text-black tracking-[0.3em] uppercase">
                LUXARDO
              </h1>
            </>
          )}
          <p className="text-[10px] tracking-[0.4em] text-gray-500 mt-1">
            ADMIN ACCESS
          </p>
        </div>

        <div className="bg-white border border-gray-200 rounded-2xl p-8 shadow-xl relative overflow-hidden">
          
          {/* Security Overlay when Locked */}
          {isLocked && mode === 'login' && (
             <div className="absolute inset-0 bg-white/95 backdrop-blur-sm z-10 flex flex-col items-center justify-center p-6 text-center border-t-4 border-red-600">
               <Clock size={40} className="text-red-500 mb-4 animate-pulse" />
               <h3 className="font-display text-lg text-black uppercase mb-2 tracking-widest">Security Lock</h3>
               <p className="text-xs text-gray-500 mb-6 leading-relaxed">
                 Multiple failed login attempts detected. This account is temporarily locked for <span className="font-bold text-red-600">{lockTimer} minutes</span>.
               </p>
               <button
                  onClick={() => { setMode('reset'); setIsLocked(false); }}
                  className="w-full bg-black text-white py-3 text-xs tracking-[0.3em] uppercase hover:bg-gray-900 transition-colors flex items-center justify-center gap-2 rounded-lg"
                >
                  Reset Password
                </button>
             </div>
          )}

          <h2 className="font-display text-lg text-black text-center mb-1">
            {mode === 'login' ? 'Sign In' : 'Reset Password'}
          </h2>
          <p className="text-[10px] tracking-widest uppercase text-gray-400 text-center mb-6">
            {isLoomHost() ? 'Owner, Admin & Super Admin' : 'Admin personnel only'}
          </p>

          {error && (
            <div className="bg-red-50 text-red-700 p-3 mb-4 text-xs border border-red-100 rounded-lg flex items-start gap-2">
              <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {okMsg && <div className="bg-green-50 text-green-700 p-3 mb-4 text-xs border border-green-100 rounded-lg">{okMsg}</div>}

          {mode === 'login' && (
            <>
              <button type="button" onClick={handleGoogleLogin} disabled={loading || isLocked} className="w-full flex items-center justify-center gap-3 border border-gray-200 rounded-lg py-3 text-sm text-black hover:bg-gray-50 transition-all shadow-sm disabled:opacity-50">
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

              <div className="flex mb-6 border border-gray-200 rounded-lg p-1 bg-gray-50">
                <button
                  type="button"
                  onClick={() => { setAuthTab('password'); setError(''); }}
                  className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-widest rounded-md transition-colors ${authTab === 'password' ? 'bg-black text-white' : 'text-gray-500 hover:text-black'}`}
                >
                  Email &amp; Password
                </button>
                <button
                  type="button"
                  onClick={() => { setAuthTab('mobile'); setError(''); }}
                  className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-widest rounded-md transition-colors ${authTab === 'mobile' ? 'bg-black text-white' : 'text-gray-500 hover:text-black'}`}
                >
                  Mobile Number
                </button>
              </div>

              {authTab === 'password' && (
                <form onSubmit={handleEmailLogin} className="space-y-4" autoComplete="off">
                  <input type="text" style={{ display: 'none' }} />
                  <input type="password" style={{ display: 'none' }} />

                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Admin email" className="w-full border border-gray-300 rounded-lg pl-10 pr-3 py-3 text-sm focus:outline-none focus:border-black" required autoComplete="nope" />
                  </div>
                  <div className="relative">
                    <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                    <input type={showPwd ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className="w-full border border-gray-300 rounded-lg pl-10 pr-10 py-3 text-sm focus:outline-none focus:border-black" required autoComplete="new-password" />
                    <button type="button" onClick={() => setShowPwd(!showPwd)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-black">
                      {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <button type="submit" disabled={loading || isLocked} className="w-full bg-black text-white rounded-lg py-3 text-xs tracking-[0.3em] uppercase hover:bg-gray-900 transition-colors flex items-center justify-center gap-2 mt-2 shadow-md disabled:opacity-50">
                    {loading ? 'Verifying...' : 'Sign In'} <ArrowRight size={14} />
                  </button>
                  <div className="text-center pt-1">
                    <button type="button" onClick={() => setMode('reset')} className="text-xs text-gray-500 hover:text-black tracking-wider">Forgot password?</button>
                  </div>
                </form>
              )}

              {authTab === 'mobile' && (
                <form onSubmit={handleMobilePasswordLogin} className="space-y-4" autoComplete="off">
                  <div>
                    <label className="text-[10px] uppercase tracking-widest font-bold text-gray-500 mb-2 block">Mobile Number</label>
                    <PhoneInput
                      country={'in'}
                      value={mobilePhone}
                      onChange={(phone) => setMobilePhone(phone)}
                      enableSearch
                      disableSearchIcon
                      inputProps={{ name: 'phone', required: true }}
                      containerClass="!w-full font-sans"
                      inputClass="!w-full !h-[46px] !pl-14 !bg-white !border !border-gray-300 focus:!border-black transition-colors !rounded-lg !text-sm"
                      buttonClass="!bg-white !border-0 !border-r !border-gray-300 !rounded-l-lg hover:!bg-gray-50"
                      dropdownClass="!shadow-2xl !border !border-gray-200 !rounded-xl text-sm !max-h-56 !overflow-y-auto"
                    />
                  </div>
                  <div className="relative">
                    <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                    <input type={mobileShowPwd ? 'text' : 'password'} value={mobilePassword} onChange={(e) => setMobilePassword(e.target.value)} placeholder="Password" className="w-full border border-gray-300 rounded-lg pl-10 pr-10 py-3 text-sm focus:outline-none focus:border-black" required autoComplete="new-password" />
                    <button type="button" onClick={() => setMobileShowPwd(!mobileShowPwd)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-black">
                      {mobileShowPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <button type="submit" disabled={loading || isLocked} className="w-full bg-black text-white rounded-lg py-3 text-xs tracking-[0.3em] uppercase hover:bg-gray-900 transition-colors flex items-center justify-center gap-2 mt-2 shadow-md disabled:opacity-50">
                    {loading ? 'Verifying...' : 'Sign In'} <Phone size={14} />
                  </button>
                </form>
              )}
            </>
          )}

          {mode === 'reset' && (
            <>
              <div className="flex mb-6 border border-gray-200 rounded-lg p-1 bg-gray-50 relative z-20">
                <button
                  type="button"
                  onClick={() => { setResetTab('email'); setError(''); setOkMsg(''); }}
                  className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-widest rounded-md transition-colors ${resetTab === 'email' ? 'bg-black text-white' : 'text-gray-500 hover:text-black'}`}
                >
                  Email Link
                </button>
                <button
                  type="button"
                  onClick={() => { setResetTab('mobile'); resetPhoneFlowState(); }}
                  className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-widest rounded-md transition-colors ${resetTab === 'mobile' ? 'bg-black text-white' : 'text-gray-500 hover:text-black'}`}
                >
                  Mobile OTP
                </button>
              </div>

              {resetTab === 'email' && (
                <form onSubmit={handleReset} className="space-y-4 relative z-20" autoComplete="off">
                  <input type="text" style={{ display: 'none' }} />
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Admin email" className="w-full border border-gray-300 rounded-lg pl-10 pr-3 py-3 text-sm focus:outline-none focus:border-black" required autoComplete="nope" />
                  </div>
                  <button type="submit" disabled={loading} className="w-full bg-black text-white rounded-lg py-3 text-xs tracking-[0.3em] uppercase hover:bg-gray-900 shadow-md disabled:opacity-50">Send Recovery Link</button>
                  <button type="button" onClick={() => { setMode('login'); setIsLocked(false); }} className="w-full text-xs text-gray-500 hover:text-black tracking-wider mt-2">Back to sign in</button>
                </form>
              )}

              {resetTab === 'mobile' && resetStep === 'identify' && (
                <form onSubmit={handleIdentifyForReset} className="space-y-4 relative z-20">
                  <p className="text-[11px] text-gray-500 leading-relaxed mb-2">
                    Enter your account email. If it has a registered mobile number, we'll ask you to confirm it before sending a code.
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
                  <button type="button" onClick={() => { setMode('login'); setIsLocked(false); }} className="w-full text-xs text-gray-500 hover:text-black tracking-wider mt-2">Back to sign in</button>
                </form>
              )}

              {resetTab === 'mobile' && resetStep === 'confirm' && (
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

              {resetTab === 'mobile' && resetStep === 'otp' && (
                <form onSubmit={handleConfirmResetOtp} className="space-y-4 relative z-20">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] uppercase tracking-widest font-bold text-gray-500">Verification Code</label>
                    <button type="button" onClick={() => { setResetStep('confirm'); setOtpValue(''); setError(''); }} className="text-[10px] text-gray-400 hover:text-black uppercase flex items-center gap-1">
                      Back
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
            </>
          )}
        </div>

        {mode === 'reset' && resetTab === 'mobile' && (
          <div
            id={recaptchaContainerId}
            aria-hidden="true"
            style={{ position: 'absolute', bottom: 0, left: 0, opacity: 0, pointerEvents: 'none' }}
          />
        )}
      </div>
    </div>
  );
}