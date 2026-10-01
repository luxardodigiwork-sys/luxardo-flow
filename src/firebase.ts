import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getStorage, connectStorageEmulator } from "firebase/storage";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";

/*
 * Dual-project Firebase config.
 *
 * Defaults are the B2C e-commerce website (luxardo-fashion-website).
 * When the Loom production SPA is built with `.env.loom`, Vite injects the
 * Loom (luxardo-flow) project values via the VITE_FIREBASE_* vars below, so
 * the SAME source produces either app without code changes.
 *
 * B2C build:  `vite build`                      (reads .env / defaults)
 * Loom build: `vite build --mode loom`          (reads .env.loom)
 */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "AIzaSyAfqktiFGPeb4gxk83SzeEb6XhVGBDwrsY",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "luxardo-fashion-website.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "luxardo-fashion-website",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "luxardo-fashion-website.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "654297681314",
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "1:654297681314:web:64381a856ae8d3f36236fb",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID ?? "G-4B6F1EXHKT",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app);

/*
 * Local-only emulator redirect, gated behind VITE_USE_EMULATOR so production
 * and normal dev builds are completely unaffected unless this is explicitly
 * set in a local .env. Ports match the Firebase CLI defaults (and the
 * firestore/auth ports declared in firebase.json's "emulators" block).
 */
if (import.meta.env.VITE_USE_EMULATOR === "true") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectStorageEmulator(storage, "127.0.0.1", 9199);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}
