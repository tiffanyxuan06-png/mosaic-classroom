import { initializeApp, getApps, cert, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

/**
 * Singleton Firebase Admin initialisation for Mosaic Classroom.
 *
 * Supports two credential strategies (checked in order):
 *
 * 1. **GOOGLE_APPLICATION_CREDENTIALS** — path to a service-account JSON file
 *    (preferred for local dev). Firebase Admin auto-detects this env var.
 *
 * 2. **Individual env vars** — FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and
 *    FIREBASE_PRIVATE_KEY. Useful in serverless / Vercel deployments where you
 *    can't easily drop a JSON file on disk.
 *
 * 3. **Application Default Credentials** — when running on GCP (Cloud Run,
 *    Cloud Functions), ADC is used automatically with no env vars at all.
 */
function getOrInitApp() {
  if (getApps().length > 0) {
    return getApps()[0];
  }

  // Strategy 2: explicit env vars (Vercel, Railway, etc.)
  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    const serviceAccount: ServiceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Vercel stores newlines as literal `\n` — convert them back
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };

    return initializeApp({ credential: cert(serviceAccount) });
  }

  // Strategy 1 & 3: GOOGLE_APPLICATION_CREDENTIALS or GCP ADC
  return initializeApp();
}

const app = getOrInitApp();

/** Firestore instance — import this in route handlers and server actions. */
export const db = getFirestore(app);
