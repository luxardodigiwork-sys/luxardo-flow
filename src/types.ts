export type PagePath =
  | "/"
  | "/collections"
  | "/collections/kurta-editions"
  | "/collections/formal-tailoring"
  | "/collections/tailored-sets"
  | "/collections/koti-ensembles"
  | "/collections/bomber-jackets"
  | "/prime-membership"
  | "/private-client-services"
  | "/private-client-services/bespoke-request"
  | "/private-client-services/style-consultation"
  | "/private-client-services/fabric-library"
  | "/private-client-services/member-benefits"
  | "/craftsmanship"
  | "/our-story"
  | "/wholesale"
  | "/contact"
  | "/faq"
  | "/policies/shipping"
  | "/policies/returns"
  | "/policies/privacy"
  | "/policies/terms"
  | "/cart"
  | "/checkout"
  | "/account"
  | "/sign-in"
  | "/product"
  | "/admin/media"
  | "/admin/dispatch"
  | "/admin/backend-management"
  | "/admin/settings";

export interface Currency {
  code: string;
  symbol: string;
  rate: number;
}

export interface Country {
  name: string;
  code: string;
  language: Language;
  currency: Currency;
  active: boolean;
}

export type Language = "English (US)" | "French" | "Arabic";

export interface Product {
  id: string;
  name: string;
  slug?: string;
  price: number; // Base price in INR
  category: string;
  collection?: string;
  image: string;
  images?: string[];
  description: string;
  fabricOrigin?: string;
  productStory?: string;
  composition?: string;
  washingCare?: string;
  shipping?: string;
  returns?: string;
  garmentFormat?: string;
  stock?: number;
  lowStockThreshold?: number;
  visibility?: "public" | "hidden";
  featured?: boolean;
  readyToStitch?: boolean;
  readyToStitchInfo?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role:
    | "admin"
    | "customer"
    | "super_admin"
    | "dispatch"
    | "owner"
    | "analysis";
  isPrimeMember: boolean;
  membershipActivation?: string;
  membershipExpiry?: string;
  phone?: string;
  country?: string;
  language?: string;
  currency?: string;
  createdAt?: string;
  forcePasswordReset?: boolean;
  permissions?: BackendPermissions;
  primePrivileges?: {
    consultation: boolean;
    bespoke: boolean;
    fabricLibrary: boolean;
    prioritySupport: boolean;
  };
  notes?: string;
}

export interface Order {
  id: string;
  userId?: string;
  userName: string;
  userEmail: string;
  totalAmount: number;
  status:
    | "pending"
    | "processing"
    | "packed"
    | "shipped"
    | "delivered"
    | "cancelled"
    | "returned"
    | "failed_delivery";
  verificationStatus?: "verified" | "packing_ready" | "dispatch_ready";
  isAccountsApproved?: boolean;
  paymentStatus?: "pending" | "paid" | "failed" | "refunded" | "confirmed";
  paymentMethod?: "cod" | "prepaid" | "razorpay";
  paymentId?: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  trackingId?: string;
  trackingUrl?: string;
  courierName?: string;
  courierService?: string;
  dispatchDate?: string;
  dispatchNote?: string;
  assignedStaffId?: string;
  assignedStaffName?: string;
  internalRemarks?: string;
  statusHistory?: {
    status: string;
    timestamp: string;
    note?: string;
  }[];
  createdAt: string;
  items: {
    productId: string;
    name: string;
    price: number;
    quantity: number;
    image?: string;
    category?: string;
  }[];
  shippingAddress?: {
    fullName: string;
    email: string;
    phone: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
}

export interface MediaItem {
  id: string;
  url: string;
  name: string;
  type: "product" | "homepage" | "content" | "other";
  uploadDate: string;
  size?: string;
  dimensions?: string;
}

export interface BackendPermissions {
  dashboard: boolean;
  orders: boolean;
  products: boolean;
  collections: boolean;
  media: boolean;
  content: boolean;
  backend_management: boolean;
  settings: boolean;
  dispatch_actions: boolean;
  accounts_finance?: boolean;
  analysis_reports: boolean;
  customer_details: boolean;
  export_data: boolean;
  tracking_controls: boolean;
  delivery_update_controls: boolean;
  // ⚡ FIX APPLIED: Allows dynamic string checking in App.tsx without TS throwing errors
  [key: string]: boolean | undefined;
}

export interface BackendUser {
  id: string;
  fullName: string;
  username: string;
  password?: string;
  email: string;
  phone?: string;
  role: "dispatch" | "owner" | "analysis" | "admin";
  status: "active" | "disabled";
  accessScope?: string[];
  permissions?: BackendPermissions;
  createdAt: string;
  lastLogin?: string;
  createdBy?: string;
  forcePasswordReset?: boolean;
}

export interface CourierSettings {
  enabled: boolean;
  provider: "DTDC" | "Delhivery" | "Shiprocket" | "Other";
  apiKey: string;
  clientId: string;
  environment: "sandbox" | "production";
  originPincode: string;
}

export interface BackendSettings {
  defaultStatuses: string[];
  verificationWorkflow: "simple" | "strict";
  courierFieldsVisible: boolean;
  trackingIdRequired: boolean;
  dispatchNotesEnabled: boolean;
  courierIntegration?: CourierSettings;
  visibleCountries?: string[];
}