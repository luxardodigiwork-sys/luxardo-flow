/* eslint-disable */
import { onCall, HttpsError, onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { setGlobalOptions } from "firebase-functions/v2";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import Razorpay from "razorpay";

admin.initializeApp();

setGlobalOptions({ region: "us-central1", maxInstances: 10 });

// Razorpay secrets (set via: firebase functions:secrets:set RAZORPAY_KEY_SECRET)
const RAZORPAY_KEY_ID = defineSecret("RAZORPAY_KEY_ID");
const RAZORPAY_KEY_SECRET = defineSecret("RAZORPAY_KEY_SECRET");
const RAZORPAY_WEBHOOK_SECRET = defineSecret("RAZORPAY_WEBHOOK_SECRET");

/* ──────────────────────────────────────────────────────────────
 * createRazorpayOrder (callable)
 * Frontend calls: httpsCallable(functions, "createRazorpayOrder")
 * Input : { amount, currency, receipt, notes }
 * Output: { razorpayOrderId, amount, currency }
 * ─────────────────────────────────────────────────────────────*/
export const createRazorpayOrder = onCall(
  { secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in (or anonymous auth) required.");
    }

    const { amount, currency = "INR", receipt, notes } = request.data as any;

    if (!amount || typeof amount !== "number" || amount <= 0) {
      throw new HttpsError("invalid-argument", "Valid amount (in paise) required.");
    }
    if (amount < 100) {
      throw new HttpsError("invalid-argument", "Amount must be at least ₹1 (100 paise).");
    }

    const keyId = RAZORPAY_KEY_ID.value();
    const keySecret = RAZORPAY_KEY_SECRET.value();
    if (!keyId || !keySecret) {
      throw new HttpsError("failed-precondition", "Razorpay secrets not configured on server.");
    }

    try {
      const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
      const order = await rzp.orders.create({
        amount: Math.round(amount), // already in paise from client
        currency,
        receipt: receipt || `LXF-${request.auth.uid}-${Date.now()}`,
        notes: notes || {},
      });

      return {
        razorpayOrderId: order.id,
        amount: order.amount,
        currency: order.currency,
      };
    } catch (err: any) {
      console.error("createRazorpayOrder failed:", err);
      throw new HttpsError("internal", err?.error?.description || err?.message || "Razorpay order failed");
    }
  }
);

/* ──────────────────────────────────────────────────────────────
 * verifyRazorpayPayment (callable)
 * Frontend calls after Razorpay checkout success.
 * Input : { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * Output: { verified: boolean }
 * ─────────────────────────────────────────────────────────────*/
export const verifyRazorpayPayment = onCall(
  { secrets: [RAZORPAY_KEY_SECRET] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Auth required.");
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = request.data as any;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      throw new HttpsError("invalid-argument", "Missing payment fields.");
    }

    const keySecret = RAZORPAY_KEY_SECRET.value();
    const expected = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    let verified = false;
    try {
      verified = crypto.timingSafeEqual(
        Buffer.from(expected, "hex"),
        Buffer.from(razorpay_signature, "hex")
      );
    } catch {
      verified = false;
    }

    if (!verified) {
      console.error("Razorpay signature mismatch", { razorpay_order_id, razorpay_payment_id });
    }

    return { verified };
  }
);

/* ──────────────────────────────────────────────────────────────
 * razorpayWebhook (HTTP)
 * Configure URL in Razorpay Dashboard > Settings > Webhooks
 * Updates Firestore order on payment.captured / order.paid
 * ─────────────────────────────────────────────────────────────*/
export const razorpayWebhook = onRequest(
  { secrets: [RAZORPAY_WEBHOOK_SECRET] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const signature = req.headers["x-razorpay-signature"];
    if (!signature || typeof signature !== "string") {
      res.status(401).send("Missing signature.");
      return;
    }

    try {
      const webhookSecret = RAZORPAY_WEBHOOK_SECRET.value();
      const rawBody = (req as any).rawBody || Buffer.from(JSON.stringify(req.body));
      const expectedSignature = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");

      const ok = expectedSignature.length === signature.length &&
        crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));
      if (!ok) {
        res.status(400).send("Invalid signature.");
        return;
      }

      const event = req.body.event;
      const paymentEntity = req.body.payload?.payment?.entity;

      if ((event === "payment.captured" || event === "order.paid") && paymentEntity) {
        const razorpayOrderId = paymentEntity.order_id;
        const paymentId = paymentEntity.id;

        if (!razorpayOrderId) {
          res.status(400).send("Order ID missing.");
          return;
        }

        const snapshot = await admin.firestore()
          .collection("orders")
          .where("razorpay.orderId", "==", razorpayOrderId)
          .limit(1)
          .get();

        if (snapshot.empty) {
          console.warn(`Webhook: order with razorpay.orderId=${razorpayOrderId} not found`);
          res.status(200).json({ status: "ignored" });
          return;
        }

        await snapshot.docs[0].ref.update({
          paymentStatus: "paid",
          "razorpay.paymentId": paymentId,
          "razorpay.verifiedAt": admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      res.status(200).json({ status: "ok" });
    } catch (error) {
      console.error("Razorpay webhook failure:", error);
      res.status(500).send("Internal Server Error.");
    }
  }
);

// Email notifications (Day 3 — existing)
export { sendOrderEmail } from "./emailSender";

// V1 Production System — master-data CRUD + atomic ID generation
export { nextId, staffCreate, staffUpdate, karigarCreate, karigarUpdate, userProfileSelfUpdate, mobileResetLookup, mobileResetSendOtp } from "./production";

// Phase 2 · Block 2.1 — Catalogue Design management + version preservation
export {
  designCreate,
  designUpdate,
  designSubmit,
  designApprove,
  designSetCatalogueMeta,
  designNewVersion,
} from "./designs";

// Phase 2 · Block 2.2/2.3 — Sample Design (fabric swatch) + Sample Piece (garment)
export {
  sampleDesignCreate,
  sampleDesignUpdate,
  sampleDesignSubmit,
  sampleDesignApprove,
  samplePieceCreate,
  samplePieceComplete,
  samplePieceApprove,
} from "./samples";

// Phase 2 · Block 2.4 — Production Request foundation
export {
  prCreate,
  prUpdate,
  prSubmit,
  prApprove,
  prReject,
  prEditApproved,
  prReproduce,
  prGeneratePieces,
} from "./productionRequests";

// Phase 2 · Block 3 — Physical Piece domain
export {
  pieceAssignKarigar,
  pieceRemoveKarigar,
  recordRework,
  completeRejectPiece,
  createManualReplacementPiece,
  recordPieceMovement,
} from "./pieces";

// Phase 2 · Block 4 — Karigar + Labour domain
export {
  labourStart,
  labourStop,
} from "./labour";

// Phase 3 · Block 5 — Guard QC domain
export {
  guardQcPerform,
} from "./guardQc";
