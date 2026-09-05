import { getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

const firebaseConfig: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let app: FirebaseApp | undefined;
let authObj: Auth | undefined;
let dbObj: Firestore | undefined;

try {
  app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  if (app) {
    authObj = getAuth(app);
    dbObj = getFirestore(app);
  }
} catch (error) {
  console.warn("Firebase client init warning:", error);
}

export const firebaseApp = app;
export const auth = (authObj ?? {}) as Auth;
export const db = (dbObj ?? {}) as Firestore;
