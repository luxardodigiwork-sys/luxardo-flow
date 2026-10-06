export const BUSINESS_CONFIG = {
  brandName: "LUXARDO FASHION",
  legalEntityName: "LUXARDO FASHION WORLD PRIVATE LIMITED",
  domain: "luxardofashion.com",
  gstin: "08AAGCL8467K1ZT",
  cinNumber: "U47711RJ2026PTC113529",
  phone: "+919664040699",
  whatsapp: "919664040699",
  email: "connect@luxardofashion.com",
  businessAddress: {
    line1: "First Floor, Plot No. 6, Aaraji No. 3608",
    line2: "Engineers Colony, BSL Road",
    city: "Bhilwara",
    state: "Rajasthan",
    pinCode: "311001",
    country: "India"
  },
  pickupAddress: {
    line1: "First Floor, Plot No. 6, Aaraji No. 3608",
    line2: "Engineers Colony, BSL Road",
    city: "Bhilwara",
    state: "Rajasthan",
    pinCode: "311001",
    country: "India"
  },
  CODAvailablePINs: [
    "311001", "312001", "305008",
    "302001", "302002", "302003", "302004", "302005", "302006",
    "302012", "302013", "302015", "302016", "302017", "302018",
    "302020", "302021", "302022", "302026", "302027", "302029",
    "302031", "303033", "302039", "302040", "302041", "302042",
    "302044", "302046", "302048",
    "303001", "303050"
  ],
  socials: {
    instagram: "https://instagram.com/luxardofashion",
    facebook: "https://facebook.com/luxardofashion",
    twitter: "https://twitter.com/luxardofashion",
    youtube: "https://youtube.com/@luxardofashion",
    linkedin: "https://linkedin.com/company/luxardofashion",
    pinterest: "",
  },
  upiId: "",
  bankAccount: { 
    name: "LUXARDO FASHION WORLD PRIVATE LIMITED",
    number: "2243102100003569",
    ifsc: "PUNB0224310",
    bank: "PUNJAB NATIONAL BANK",
    branch: "SIDDHARTH SQUARE, GANDHI NAGAR, BHILWARA"
  },
  CODFeeAmount: 0,
  CODMaxOrderValue: 200000,
  freeShippingMinAmount: 7500,
  shippingFlatRate: 100,
  GSTRate: 0.18,
  defaultCurrency: "INR",
  currencySymbol: "INR"
};

/**
 * LUXARDO FASHION — V1 PRODUCTION SYSTEM configuration.
 * Additive block for the production-management workflow. Values mirror the
 * finalized business rules: controlled urgency levels, controlled store-out
 * reasons (5 controlled + OTHER), and karigar hourly-rate defaults.
 */
export const PRODUCTION_CONFIG = {
  urgencyLevels: [
    { value: "HIGH", label: "High" },
    { value: "MEDIUM", label: "Medium" },
    { value: "LOW", label: "Low" },
  ] as const,
  storeOutReasons: [
    { value: "DAMAGE_IN_TRANSIT", label: "Damage in transit" },
    { value: "SIZE_MISMATCH", label: "Size mismatch" },
    { value: "QUALITY_REJECT", label: "Quality reject" },
    { value: "BILLING_DISPUTE", label: "Billing dispute" },
    { value: "OTHER", label: "Other" },
  ] as const,
  defaultHourlyRateRange: { min: 50, max: 500 },
  qcChecklistDefaults: ["fabric_integrity", "pattern_accuracy", "finish_quality"],
  // The complete set of roles assignable via Staff Management (Add Staff /
  // Link Existing Account / Change Role) — kept in exact sync with the
  // server's own CANONICAL_STAFF_ROLES (functions/src/staffAuth.ts) and the
  // client StaffRole union (src/types/production.ts), which is what
  // staffCreate/staffUpdate/staffLinkExistingAccount actually validate
  // against. Deliberately excludes "super_admin": that identity is tied to
  // one hardcoded Gmail account (src/utils/loomIdentity.ts) and is never
  // assignable via any staff-mutating callable — Admin and Owner ARE
  // ordinary assignable roles here (Admin's real identity still resolves by
  // hardcoded email too, but login additionally requires this staff/{uid}
  // role to actually say "admin" — see isEligiblePrivilegedStaffDoc).
  productionRoles: [
    "owner", "admin", "designer", "pm", "dispatch", "guard", "tailor",
    "store", "accounts", "analysis",
  ] as const,
  // Purely descriptive User Profile field — kept in sync with
  // functions/src/staffAuth.ts CANONICAL_DEPARTMENTS. Never consulted by
  // any authorization check; changing a User's department never grants a
  // permission.
  departments: [
    "Management", "Design", "Production", "Planning", "Dispatch",
    "Quality Control", "Tailoring", "Store", "Accounts", "Analysis",
  ] as const,
};

export function isCODEligible(pinCode: string): boolean {
  return BUSINESS_CONFIG.CODAvailablePINs.includes(pinCode.trim());
}

export function whatsappLink(message?: string): string {
  const defaultMsg = "Hi LUXARDO FASHION, I want to know more.";
  const text = encodeURIComponent(message || defaultMsg);
  return "https://wa.me/" + BUSINESS_CONFIG.whatsapp + "?text=" + text;
}