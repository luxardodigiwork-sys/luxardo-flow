import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { onAuthStateChanged, signOut, signInWithEmailAndPassword } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { normalizeStaffRole, isLoomHost, privilegedRoleForEmail } from '../utils/loomIdentity';
import { ResolutionChannel } from '../utils/resolutionChannel';

const MASTER_ADMIN_EMAIL = 'luxardodigiwork@gmail.com';
// Loom-only localStorage key (no B2C branding; distinct from the B2C key so the
// two apps never read each other's cached identity).
const LOOM_USER_KEY = 'LUXARDO_FLOW_user';

export interface User {
  id: string;
  name: string;
  email?: string;
  role: string;
  staffRole?: string | null; // V1 production role (designer/pm/guard/tailor/store) from staff/{uid} doc
  isPrimeMember: boolean;
  permissions?: Record<string, boolean>;
  country?: string;
  language?: string;
  currency?: string;
  phone?: string;
  createdAt?: string;
  membershipActivation?: string;
  membershipExpiry?: string;
  forcePasswordReset?: boolean;
  primePrivileges?: {
    bespoke?: boolean;
    fabricLibrary?: boolean;
    consultation?: boolean;
    prioritySupport?: boolean;
  };
  notes?: string;
}

interface AuthContextType {
  user: User | null;
  isLoggedIn: boolean;
  isAuthReady: boolean;
  logout: () => Promise<void>;
  login: (userData: User) => void;
  updateUserPreferences: (preferences: Partial<User>) => void;
  loginAdmin: (email: string, password: string) => Promise<void>;
  resetPassword: (email: string, resetCode: string, newPassword: string) => Promise<void>;
  upgradeToPrime: () => void;
  /**
   * LUXARDO FLOW (Loom) only — awaits the SINGLE authoritative staff-identity
   * resolution (the same one `onAuthStateChanged` below performs and stores
   * in `user`) for a given Firebase uid, instead of re-reading staff/{uid}
   * independently. See RoleLoginPage's `common` verifyRole() branch: a caller
   * must never do its own redundant getDoc + signOut() on top of this — that
   * was the auth race (two independent reads of the same doc, one of
   * which could sign the user back out after the other had already approved
   * and navigated them in). Resolves to the resolved Loom `User` (or `null`
   * if not a recognised staff identity) once AuthContext's own resolution for
   * that uid completes; rejects if it doesn't complete within `timeoutMs`.
   */
  waitForResolution: (uid: string, timeoutMs?: number) => Promise<User | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  // Loom-only single-resolution channel (see `waitForResolution` in
  // AuthContextType above, and src/utils/resolutionChannel.ts for the race
  // this exists to close). settle() is called exactly once, by
  // onAuthStateChanged below — the one authoritative resolver.
  const loomResolutionRef = useRef(new ResolutionChannel<User | null>());
  const waitForResolution = (uid: string, timeoutMs?: number) =>
    loomResolutionRef.current.wait(uid, timeoutMs);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      try {
        if (firebaseUser) {
          // ══════════════════════════════════════════════════════════════
          // LUXARDO FLOW (Loom) identity resolution.
          //
          // On the Loom project (luxardo-flow) the client can ONLY read
          // staff/{uid} — there is no readable customers/{uid} (the mirror is
          // denied by firestore.loom.rules). Resolving identity here, from
          // staff/{uid} + the two privileged identifiers only, avoids the
          // permission-denied throw that previously aborted sign-in.
          // ══════════════════════════════════════════════════════════════
          if (isLoomHost()) {
            let loomUser: User | null = null;

            const privRole = privilegedRoleForEmail(firebaseUser.email);
            if (privRole) {
              // Super Admin / Admin: recognised by identifier (a real Gmail
              // mailbox), never by a role doc — so Google Sign-In and
              // email/password both resolve with no Firestore dependency.
              loomUser = {
                id: firebaseUser.uid,
                name: firebaseUser.displayName || (privRole === 'super_admin' ? 'Super Admin' : 'Admin'),
                email: firebaseUser.email || '',
                role: privRole,
                staffRole: privRole,
                isPrimeMember: false,
              };
            } else {
              try {
                const staffDoc = await getDoc(doc(db, 'staff', firebaseUser.uid));
                if (staffDoc.exists()) {
                  const s = staffDoc.data();
                  const role = normalizeStaffRole(s.role); // null → fail closed
                  if (role && s.active !== false) {
                    loomUser = {
                      id: firebaseUser.uid,
                      name: s.displayName || s.name || firebaseUser.displayName || 'Staff',
                      email: s.email || firebaseUser.email || '',
                      role,          // customers-style role mirrors the staff role
                      staffRole: role,
                      isPrimeMember: false,
                    };
                  }
                }
              } catch (e) {
                console.error('[LUXARDO FLOW] staff/{uid} read failed:', e);
              }
            }

            if (loomUser) {
              setUser(loomUser);
              try { localStorage.setItem(LOOM_USER_KEY, JSON.stringify(loomUser)); } catch {}
            } else {
              // Authenticated but no recognised staff identity → fail closed.
              setUser(null);
              try { localStorage.removeItem(LOOM_USER_KEY); } catch {}
            }
            // Hand the SAME resolution to anyone awaiting it (RoleLoginPage's
            // common login) instead of letting them re-read staff/{uid} on
            // their own — that redundant second read was the race that could
            // sign a just-approved session back out.
            loomResolutionRef.current.settle(firebaseUser.uid, loomUser);
            return; // finally{} still runs setIsAuthReady(true)
          }

          // 🔐 AUTO-PROVISION ADMIN: If master email logs in but no customer doc, create one with role:admin
          const isMasterAdmin = firebaseUser.email?.toLowerCase() === MASTER_ADMIN_EMAIL.toLowerCase();
          const customerRef = doc(db, 'customers', firebaseUser.uid);
          let customerDoc = await getDoc(customerRef);

          if (!customerDoc.exists() && isMasterAdmin) {
            console.log('[AuthContext] Master admin login — auto-provisioning customer doc with role:admin');
            const adminData = {
              id: firebaseUser.uid,
              name: 'Admin',
              email: firebaseUser.email,
              role: 'admin',
              isPrimeMember: false,
              createdAt: new Date().toISOString(),
              permissions: {
                products: true, orders: true, content: true, media: true,
                customers: true, dispatch: true, settings: true,
              },
            };
            await setDoc(customerRef, adminData);
            customerDoc = await getDoc(customerRef);
          } else if (customerDoc.exists() && isMasterAdmin) {
            // Force-promote master admin every login (handles previously-created customer docs with wrong role)
            const existing = customerDoc.data();
            if (existing.role !== 'admin' && existing.role !== 'super_admin') {
              console.log('[AuthContext] Master admin doc had role:' + existing.role + ' — promoting to admin');
              await setDoc(customerRef, {
                role: 'admin',
                permissions: {
                  products: true, orders: true, content: true, media: true,
                  customers: true, dispatch: true, settings: true,
                },
                updatedAt: new Date().toISOString(),
              }, { merge: true });
              customerDoc = await getDoc(customerRef);
            }
          }

          if (customerDoc.exists()) {
            const data = customerDoc.data();

            // ── V1 production staff identity ──────────────────────────────
            // Read staff/{uid} to get the production role (designer/pm/guard/tailor/store).
            // This is additive — does not modify the existing customer flow.
            // A legacy / unknown role (e.g. "grade") normalises to null and
            // therefore fails closed.
            let staffRole: string | null = null;
            try {
              const staffRef = doc(db, 'staff', firebaseUser.uid);
              const staffDoc = await getDoc(staffRef);
              if (staffDoc.exists()) {
                const s = staffDoc.data();
                if (s.active !== false) staffRole = normalizeStaffRole(s.role);
              }
            } catch (e) {
              // Non-fatal: staff doc may not exist for non-production users
            }
            // Admin / super_admin customers are implicit production staff
            // (mirrors functions/src/staffAuth.ts requireStaff fallback) so the
            // master admin can reach /production even without a staff/{uid} doc.
            if (!staffRole) {
              const custRole = String(data.role || '').toLowerCase();
              if (custRole === 'admin' || custRole === 'super_admin') staffRole = custRole;
            }

            const userData: User = {
              id: firebaseUser.uid,
              name: data.firstName ? `${data.firstName} ${data.lastName || ''}`.trim() : data.name || 'User',
              email: data.email || firebaseUser.email || '',
              role: data.role || 'customer',
              staffRole,
              isPrimeMember: data.isPrimeMember || false,
              phone: data.phone || firebaseUser.phoneNumber || '',
              country: data.country, language: data.language, currency: data.currency,
              createdAt: data.createdAt,
              membershipActivation: data.membershipActivation,
              membershipExpiry: data.membershipExpiry,
              forcePasswordReset: data.forcePasswordReset,
              permissions: data.permissions,
              primePrivileges: data.primePrivileges,
              notes: data.notes,
            };
            setUser(userData);
            localStorage.setItem('LUXARDO FASHION_user', JSON.stringify(userData));
            localStorage.removeItem('LUXARDO FASHION_logged_out');
          } else {
            // ── No customers/{uid} — resolve from staff/{uid} ───────────────
            // On the Loom project (luxardo-flow) staff are provisioned with a
            // staff/{uid} doc; a customers/{uid} mirror is written alongside by
            // staffCreate, but older records / bootstrap accounts may only have
            // the staff doc. Resolve the Loom identity directly from it.
            let staffUser: User | null = null;
            try {
              const staffDoc = await getDoc(doc(db, 'staff', firebaseUser.uid));
              if (staffDoc.exists()) {
                const s = staffDoc.data();
                const role = normalizeStaffRole(s.role); // null for legacy/unknown → fail closed
                if (role && s.active !== false) {
                  staffUser = {
                    id: firebaseUser.uid,
                    name: s.displayName || s.name || firebaseUser.displayName || 'Staff',
                    email: s.email || firebaseUser.email || '',
                    role,          // customers-style role mirrors the staff role
                    staffRole: role,
                    isPrimeMember: false,
                    phone: firebaseUser.phoneNumber || '',
                  };
                }
              }
            } catch (e) {
              // Non-fatal: fall through to the generic customer fallback
            }

            const resolved: User = staffUser ?? {
              id: firebaseUser.uid,
              name: firebaseUser.displayName || 'User',
              email: firebaseUser.email || '',
              role: 'customer',
              staffRole: null,
              isPrimeMember: false,
              phone: firebaseUser.phoneNumber || '',
            };
            setUser(resolved);
            localStorage.setItem('LUXARDO FASHION_user', JSON.stringify(resolved));
          }
        } else {
          setUser(null);
          localStorage.removeItem('LUXARDO FASHION_user');
        }
      } catch (err) {
        console.error('Auth state change error:', err);
      } finally {
        setIsAuthReady(true);
      }
    });
    return () => {
      unsubscribe();
      // Don't leave any in-flight waitForResolution() caller hanging until its
      // own timeout if the provider itself unmounts.
      loomResolutionRef.current.dispose(null);
    };
  }, []);

  const login = (userData: User) => {
    setUser(userData);
    localStorage.setItem('LUXARDO FASHION_user', JSON.stringify(userData));
    localStorage.removeItem('LUXARDO FASHION_logged_out');
  };

  const logout = async () => {
    try { if (auth.currentUser) await signOut(auth); } catch (err) {}
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (err) {}
    setUser(null);
    localStorage.removeItem('LUXARDO FASHION_user');
    try { localStorage.removeItem(LOOM_USER_KEY); } catch {}
    localStorage.setItem('LUXARDO FASHION_logged_out', 'true');
  };

  const updateUserPreferences = (preferences: Partial<User>) => {
    if (!user) return;
    const updated = { ...user, ...preferences };
    setUser(updated);
    localStorage.setItem('LUXARDO FASHION_user', JSON.stringify(updated));
    if (auth.currentUser && user.role === 'customer') {
      const updateData: Record<string, any> = { lastUpdated: new Date().toISOString() };
      Object.keys(preferences).forEach(k => {
        if ((preferences as any)[k] !== undefined) updateData[k] = (preferences as any)[k];
      });
      setDoc(doc(db, 'customers', auth.currentUser.uid), updateData, { merge: true })
        .catch(e => console.error('Sync error:', e));
    }
  };

  const loginAdmin = async (email: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'include',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Invalid credentials or unauthorized access');
    const userData: User = {
      id: String(data.user.id),
      name: data.user.full_name || data.user.email,
      email: data.user.email,
      role: data.user.role,
      staffRole: null, // SQLite JWT login — no production staff role
      isPrimeMember: false,
      permissions: data.user.permissions || {},
      forcePasswordReset: data.user.force_password_reset === 1,
    };
    login(userData);
  };

  const resetPassword = async (email: string, resetCode: string, newPassword: string) => {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: resetCode, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to reset password');
  };

  const upgradeToPrime = () => {
    if (user) updateUserPreferences({ isPrimeMember: true });
  };

  return (
    <AuthContext.Provider value={{
      user, isLoggedIn: !!user, isAuthReady, logout, login,
      updateUserPreferences, loginAdmin, resetPassword, upgradeToPrime,
      waitForResolution,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
