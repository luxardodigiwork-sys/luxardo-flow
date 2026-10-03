import React, { useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { BackendPermissions } from "./types";
import Lenis from "lenis";

import Layout from "./components/Layout";
import ProtectedRoute from "./components/ProtectedRoute";

import HomePage from "./pages/HomePage";
import CollectionsPage from "./pages/CollectionsPage";
import CollectionDetailPage from "./pages/CollectionDetailPage";
import PrimePage from "./pages/PrimePage";
import PrimeMembershipCheckoutPage from "./pages/PrimeMembershipCheckoutPage";
import PrimeMembershipSuccessPage from "./pages/PrimeMembershipSuccessPage";
import PrimeMembershipFailedPage from "./pages/PrimeMembershipFailedPage";
import PrimeDashboardPage from "./pages/PrimeDashboardPage";
import MembershipTermsPage from "./pages/MembershipTermsPage";
import CraftsmanshipPage from "./pages/CraftsmanshipPage";
import OurStoryPage from "./pages/OurStoryPage";
import WholesalePage from "./pages/WholesalePage";
import ContactPage from "./pages/ContactPage";
import AboutPage from "./pages/AboutPage";
import FAQPage from "./pages/FAQPage";
import ShippingPolicyPage from "./pages/ShippingPolicyPage";
import ReturnsPolicyPage from "./pages/ReturnsPolicyPage";
import PrivacyPolicyPage from "./pages/PrivacyPolicyPage";
import TermsPage from "./pages/TermsPage";
import CartPage from "./pages/CartPage";
import CheckoutPage from "./pages/CheckoutPage";
import OrderConfirmationPage from "./pages/OrderConfirmationPage";
import TrackOrderPage from "./pages/TrackOrderPage";
import AccountPage from "./pages/AccountPage";
import OrderDetailsPage from "./pages/OrderDetailsPage";
import LoginPage from "./pages/LoginPage";
import ProductPage from "./pages/ProductPage";
import BespokeRequestPage from "./pages/BespokeRequestPage";
import StyleConsultationPage from "./pages/StyleConsultationPage";
import FabricLibraryPage from "./pages/FabricLibraryPage";

import { WishlistProvider } from "./context/WishlistContext";
import { CountryProvider, useCountry } from "./context/CountryContext";
import { FirstVisitModal } from "./components/FirstVisitModal";
import { AuthProvider, useAuth } from "./context/AuthContext";

function CountryModalBridge() {
  const { showModal, setCountry } = useCountry();
  if (!showModal) return null;
  return <FirstVisitModal onSelect={setCountry} />;
}
import { CartProvider } from "./context/CartContext";
import { ProductsProvider } from "./context/ProductsContext";
import { syncSiteContentFromFirestore, subscribeSiteContent } from "./utils/siteContentSync";
import { fetchProductsFromFirestore } from "./utils/productsFirestore";

import RegisterPage from "./pages/RegisterPage";

// Admin + role login pages (each role has dedicated login route)
import AdminLoginPage from "./pages/admin/AdminLoginPage";
import StaffLoginPage from "./pages/staff/StaffLoginPage";
import OwnerLoginPage from "./pages/owner/OwnerLoginPage";
import DispatchLoginPage from "./pages/dispatch/DispatchLoginPage";
import AccountsLoginPage from "./pages/accounts/AccountsLoginPage";
import AdminDashboardPage from "./pages/admin/AdminDashboardPage";
import AdminDispatchPage from "./pages/admin/AdminDispatchPage";
import AdminOrderDetailsPage from "./pages/admin/AdminOrderDetailsPage";
import AdminProductsPage from "./pages/admin/AdminProductsPage";
import AdminCollectionsPage from "./pages/admin/AdminCollectionsPage";
import AdminAddProductPage from "./pages/admin/AdminAddProductPage";
import AdminEditProductPage from "./pages/admin/AdminEditProductPage";
import AdminContentPage from "./pages/admin/AdminContentPage";
import AdminMediaPage from "./pages/admin/AdminMediaPage";
import AdminPoliciesPage from "./pages/admin/AdminPoliciesPage";
import AdminPrimeContentPage from "./pages/admin/AdminPrimeContentPage";
import AdminBespokeRequestsPage from "./pages/admin/AdminBespokeRequestsPage";
import AdminPrimeMembersPage from "./pages/admin/AdminPrimeMembersPage";
import AdminBackendManagementPage from "./pages/admin/BackendManagementPage";
import AdminPartnersPage from "./pages/admin/AdminPartnersPage";
import AdminContactMessagesPage from "./pages/admin/AdminContactMessagesPage";
import AdminSettingsPage from "./pages/admin/AdminSettingsPage";
import AdminNewsletterPage from "./pages/admin/AdminNewsletterPage";
import DispatchDashboardPage from "./pages/dispatch/DispatchDashboardPage";
import BackendGatewayPage from "./pages/BackendGatewayPage";
import DispatchLayout from "./components/dispatch/DispatchLayout";

import AdminLayout from "./components/admin/AdminLayout";
import ProtectedAdminRoute from "./components/admin/ProtectedAdminRoute";

import OwnerLayout from "./components/owner/OwnerLayout";
import OwnerDashboardPage from "./pages/owner/OwnerDashboardPage";
import AnalysisLayout from "./components/analysis/AnalysisLayout";
import AnalysisDashboardPage from "./pages/analysis/AnalysisDashboardPage";

// V1 Production System
import ProtectedProductionRoute from "./components/production/ProtectedProductionRoute";
import ProductionLayout from "./components/production/ProductionLayout";
import ProductionHomePage from "./pages/production/ProductionHomePage";
import StaffManagementPage from "./pages/production/StaffManagementPage";
import UserProfilePage from "./pages/production/UserProfilePage";
import KarigarListPage from "./pages/production/KarigarListPage";
import KarigarCreatePage from "./pages/production/KarigarCreatePage";
// Phase 2 — Design → Sample Design → Sample Piece → Production Request
import DesignListPage from "./pages/production/DesignListPage";
import DesignCreatePage from "./pages/production/DesignCreatePage";
import DesignDetailPage from "./pages/production/DesignDetailPage";
import SampleDesignListPage from "./pages/production/SampleDesignListPage";
import SampleDesignCreatePage from "./pages/production/SampleDesignCreatePage";
import SampleDesignDetailPage from "./pages/production/SampleDesignDetailPage";
import SamplePieceListPage from "./pages/production/SamplePieceListPage";
import SamplePieceCreatePage from "./pages/production/SamplePieceCreatePage";
import SamplePieceDetailPage from "./pages/production/SamplePieceDetailPage";
import ProductionRequestListPage from "./pages/production/ProductionRequestListPage";
import ProductionRequestCreatePage from "./pages/production/ProductionRequestCreatePage";
import ProductionRequestDetailPage from "./pages/production/ProductionRequestDetailPage";
import PieceListPage from "./pages/production/PieceListPage";
import PieceDetailPage from "./pages/production/PieceDetailPage";
import GuardQcWorkspacePage from "./pages/production/GuardQcWorkspacePage";
import DispatchWorkspacePage from "./pages/production/DispatchWorkspacePage";
import TailorWorkspacePage from "./pages/production/TailorWorkspacePage";
import StoreWorkspacePage from "./pages/production/StoreWorkspacePage";
import TailorRequestReviewPage from "./pages/production/TailorRequestReviewPage";
import FabricInventoryPage from "./pages/production/FabricInventoryPage";
import FabricIssuesPage from "./pages/production/FabricIssuesPage";

const ProtectedBackendRoute = ({
  role,
  permission,
  children,
}: {
  role: string;
  permission?: string;
  children: React.ReactNode;
}) => {
  const { user, isAuthReady } = useAuth();
  const location = useLocation();

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-brand-bg flex items-center justify-center">
        Loading...
      </div>
    );
  }

  const isSuperAdmin = user && ["super_admin", "admin"].includes(user.role);
  const hasRole = user && user.role === role;
  const hasPermission = !permission || user?.permissions?.[permission];

  // 🚀 FIXED: Agar login nahi hai toh /backend par bhejo
  if (!user || (!isSuperAdmin && (!hasRole || !hasPermission))) {
    return <Navigate to="/backend" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};

/* Loom production route subtree — shared by the full B2C SPA and the Loom-only
 * host gate (luxardo-flow). Defined once so both build paths stay identical. */
function ProductionRoutes() {
  return (
    <>
      <Route
        path="/production"
        element={
          <ProtectedProductionRoute>
            <ProductionLayout />
          </ProtectedProductionRoute>
        }
      >
        <Route index element={<ProductionHomePage />} />
        <Route path="staff" element={<StaffManagementPage />} />
        <Route path="profile" element={<UserProfilePage />} />
        <Route path="profile/:uid" element={<UserProfilePage />} />
        <Route path="karigars" element={<KarigarListPage />} />
        <Route path="karigars/new" element={<KarigarCreatePage />} />
        {/* Phase 2 — Design chain */}
        <Route path="designs" element={<DesignListPage />} />
        <Route path="designs/new" element={<DesignCreatePage />} />
        <Route path="designs/:id" element={<DesignDetailPage />} />
        <Route path="sample-designs" element={<SampleDesignListPage />} />
        <Route path="sample-designs/new" element={<SampleDesignCreatePage />} />
        <Route path="sample-designs/:id" element={<SampleDesignDetailPage />} />
        <Route path="sample-pieces" element={<SamplePieceListPage />} />
        <Route path="sample-pieces/new" element={<SamplePieceCreatePage />} />
        <Route path="sample-pieces/:id" element={<SamplePieceDetailPage />} />
        <Route path="requests" element={<ProductionRequestListPage />} />
        <Route path="requests/new" element={<ProductionRequestCreatePage />} />
        <Route path="requests/:id" element={<ProductionRequestDetailPage />} />
        {/* Phase 2 — Production Pieces */}
        <Route path="pieces" element={<PieceListPage />} />
        <Route path="pieces/:id" element={<PieceDetailPage />} />
        <Route path="qc" element={<GuardQcWorkspacePage />} />
        {/* Phase 4 — Dispatch / Tailor / Store */}
        <Route path="dispatch" element={<DispatchWorkspacePage />} />
        <Route path="tailor" element={<TailorWorkspacePage />} />
        <Route path="store" element={<StoreWorkspacePage />} />
        <Route path="tailor-requests" element={<TailorRequestReviewPage />} />
        {/* Fabric Inventory (V1) */}
        <Route path="fabric" element={<FabricInventoryPage />} />
        <Route path="fabric-issues" element={<FabricIssuesPage />} />
      </Route>
    </>
  );
}

/* True when this is the LUXARDO FLOW (Loom) app: either the Loom build
 * (`vite build --mode loom`, whose dist-loom/ output only ever deploys to the
 * luxardo-flow project) or the app served from the dedicated Loom host. On the
 * Loom app only the production system + its logins are mounted; the B2C
 * storefront is never reachable. The B2C build is unaffected — its MODE is not
 * "loom" and its hostname does not match. */
const isLoomHost =
  (import.meta as ImportMeta).env?.MODE === "loom" ||
  (typeof window !== "undefined" &&
    /(^|\.)luxardo-flow\.(web\.app|firebaseapp\.com)$/.test(window.location.hostname));

export default function App() {
  useEffect(() => {
    if (isLoomHost) {
      document.title = "LUXARDO LOOM | Production System";
    }
  }, []);

  useEffect(() => {
    if (isLoomHost) return; // B2C site-content/products sync is website-only

    syncSiteContentFromFirestore();
    fetchProductsFromFirestore();
    
    const unsubSiteContent = subscribeSiteContent(() => {
      window.dispatchEvent(new Event('siteContentUpdated'));
    });
    
    return () => unsubSiteContent();
  }, []);

  useEffect(() => {
    // Loom is a data-dense internal tool with its own independently
    // scrolling sidebar/content regions — cinematic window-level smooth
    // scroll fights those nested panels and never gets reset on route
    // change (that reset only happens in the B2C-only Layout.tsx), which is
    // the root cause of the reported vertical/nested/sidebar scroll bugs.
    if (isLoomHost) return;

    if ("scrollRestoration" in history) {
      history.scrollRestoration = "manual";
    }

    const lenis = new Lenis({
      duration: 2.2,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -8 * t)),
      orientation: "vertical",
      gestureOrientation: "vertical",
      smoothWheel: true,
      wheelMultiplier: 0.8,
      touchMultiplier: 1.0,
      infinite: false,
    });

    (window as any).lenis = lenis;

    function raf(time: number) {
      lenis.raf(time);
      requestAnimationFrame(raf);
    }

    requestAnimationFrame(raf);
    return () => {
      lenis.destroy();
      delete (window as any).lenis;
    };
  }, []);

  /* Loom-only host: mount the production system + role logins and redirect
   * every other path to /production. The B2C storefront/provider tree is not
   * mounted here, so nothing from the website is reachable on luxardo-flow. */
  if (isLoomHost) {
    return (
      <AuthProvider>
        <Routes>
          {/* Owner / Super Admin / Admin — the ONE privileged entry point.
              Google Sign-In + email/password, resolved via staff/{uid}. */}
          <Route path="/admin/login" element={<AdminLoginPage />} />
          {/* The ONE common staff login for every operational role */}
          <Route path="/login" element={<StaffLoginPage />} />
          {/* Legacy per-role login paths all funnel into one of the two pages above */}
          <Route path="/owner/login" element={<Navigate to="/admin/login" replace />} />
          <Route path="/dispatch/login" element={<Navigate to="/login" replace />} />
          <Route path="/accounts/login" element={<Navigate to="/login" replace />} />
          <Route path="/analysis/login" element={<Navigate to="/login" replace />} />
          <Route path="/staff/login" element={<Navigate to="/login" replace />} />
          {ProductionRoutes()}
          <Route path="*" element={<Navigate to="/production" replace />} />
        </Routes>
      </AuthProvider>
    );
  }

  return (
    <AuthProvider>
      <CountryProvider>
        <CountryModalBridge />
      <ProductsProvider>
      <CartProvider>
        <WishlistProvider>
          <Routes>
            {/* Dedicated login pages — one per role */}
            <Route path="/admin/login" element={<AdminLoginPage />} />
            <Route path="/owner/login" element={<OwnerLoginPage />} />
            <Route path="/dispatch/login" element={<DispatchLoginPage />} />
            <Route path="/accounts/login" element={<AccountsLoginPage />} />
            <Route path="/analysis/login" element={<Navigate to="/accounts/login" replace />} />

            <Route path="/admin">
              <Route element={<ProtectedAdminRoute />}>
              <Route element={<AdminLayout />}>
                <Route
                  index
                  element={<Navigate to="/admin/dashboard" replace />}
                />
                <Route path="dashboard" element={<AdminDashboardPage />} />
                <Route path="dispatch" element={<AdminDispatchPage />} />
                <Route path="orders" element={<Navigate to="/admin/dispatch" replace />} />
                <Route path="orders/:id" element={<AdminOrderDetailsPage />} />
                <Route path="products" element={<AdminProductsPage />} />
                <Route path="collections" element={<AdminCollectionsPage />} />
                <Route path="products/new" element={<AdminAddProductPage />} />
                <Route
                  path="products/:id/edit"
                  element={<AdminEditProductPage />}
                />
                <Route path="content" element={<AdminContentPage />} />
                <Route path="media" element={<AdminMediaPage />} />
                <Route
                  path="prime-content"
                  element={<AdminPrimeContentPage />}
                />
                <Route path="policies" element={<AdminPoliciesPage />} />
                <Route
                  path="bespoke-requests"
                  element={<AdminBespokeRequestsPage />}
                />
                <Route
                  path="prime-members"
                  element={<AdminPrimeMembersPage />}
                />
                <Route path="partners" element={<AdminPartnersPage />} />
                <Route
                  path="contact-messages"
                  element={<AdminContactMessagesPage />}
                />
                <Route
                  path="newsletter"
                  element={<AdminNewsletterPage />}
                />
                <Route
                  path="backend-management"
                  element={<AdminBackendManagementPage />}
                />
                <Route path="settings" element={<AdminSettingsPage />} />
              </Route>
              </Route>
            </Route>

            <Route
              path="/dispatch"
              element={
                <ProtectedBackendRoute
                  role="dispatch"
                  permission="dispatch_actions"
                >
                  <DispatchLayout />
                </ProtectedBackendRoute>
              }
            >
              <Route
                index
                element={<Navigate to="/dispatch/dashboard" replace />}
              />
              <Route path="dashboard" element={<DispatchDashboardPage />} />
            </Route>

            <Route path="/backend" element={<BackendGatewayPage />} />
            <Route path="/admin-access" caseSensitive={false} element={<Navigate to="/admin/login" replace />} />
            <Route path="/ADMIN-ACCESS" element={<Navigate to="/admin/login" replace />} />


            <Route
              path="/owner"
              element={
                <ProtectedBackendRoute
                  role="owner"
                  permission="backend_management"
                >
                  <OwnerLayout />
                </ProtectedBackendRoute>
              }
            >
              <Route
                index
                element={<Navigate to="/owner/dashboard" replace />}
              />
              <Route path="dashboard" element={<OwnerDashboardPage />} />
              <Route path="orders/:id" element={<AdminOrderDetailsPage />} />
            </Route>
            
            <Route
              path="/analysis"
              element={
                <ProtectedBackendRoute
                  role="analysis"
                  permission="analysis_reports"
                >
                  <AnalysisLayout />
                </ProtectedBackendRoute>
              }
            >
              <Route
                index
                element={<Navigate to="/analysis/dashboard" replace />}
              />
              <Route path="dashboard" element={<AnalysisDashboardPage />} />
            </Route>

            {/* ── V1 Production System (Loom) ────────────────────────── */}
            {ProductionRoutes()}

            <Route path="/" element={<Layout />}>
              <Route index element={<HomePage />} />
              <Route path="collections" element={<CollectionsPage />} />
              <Route
                path="collections/:category"
                element={<CollectionDetailPage />}
              />
              <Route path="prime-membership" element={<PrimePage />} />
              <Route
                path="prime-dashboard"
                element={
                  <ProtectedRoute>
                    <PrimeDashboardPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="prime-membership/checkout"
                element={
                  <ProtectedRoute>
                    <PrimeMembershipCheckoutPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="prime-membership/success"
                element={
                  <ProtectedRoute>
                    <PrimeMembershipSuccessPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="prime-membership/failed"
                element={<PrimeMembershipFailedPage />}
              />
              <Route
                path="prime-membership/bespoke-request"
                element={
                  <ProtectedRoute>
                    <BespokeRequestPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="prime-membership/style-consultation"
                element={
                  <ProtectedRoute>
                    <StyleConsultationPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="prime-membership/fabric-library"
                element={
                  <ProtectedRoute>
                    <FabricLibraryPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="policies/membership-terms"
                element={<MembershipTermsPage />}
              />
              <Route
                path="private-client-services/*"
                element={<Navigate to="/prime-membership" replace />}
              />
              <Route path="craftsmanship" element={<CraftsmanshipPage />} />
              <Route path="our-story" element={<OurStoryPage />} />
              <Route path="wholesale" element={<WholesalePage />} />
              <Route path="contact" element={<ContactPage />} />
              <Route path="about" element={<AboutPage />} />
              <Route path="faq" element={<FAQPage />} />
              <Route
                path="policies/shipping"
                element={<ShippingPolicyPage />}
              />
              <Route path="policies/returns" element={<ReturnsPolicyPage />} />
              <Route path="policies/privacy" element={<PrivacyPolicyPage />} />
              <Route path="policies/terms" element={<TermsPage />} />
              <Route path="cart" element={<CartPage />} />
              <Route
                path="checkout"
                element={
                  <ProtectedRoute>
                    <CheckoutPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="order-confirmation"
                element={<OrderConfirmationPage />}
              />
              <Route path="track-order/:orderId" element={<TrackOrderPage />} />
              <Route
                path="account"
                caseSensitive={false}
                element={
                  <ProtectedRoute>
                    <AccountPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="account/orders/:orderId"
                element={
                  <ProtectedRoute>
                    <OrderDetailsPage />
                  </ProtectedRoute>
                }
              />
              <Route path="login" element={<LoginPage />} />
              <Route path="register" element={<RegisterPage />} />
              <Route path="product/:id" element={<ProductPage />} />
            </Route>
          </Routes>
        </WishlistProvider>
      </CartProvider>
      </ProductsProvider>
      </CountryProvider>
    </AuthProvider>
  );
}