'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Offline-first write queue.
//
// Classroom wifi drops constantly, so every write that would otherwise be lost
// (an answer, a progress update, a scanned paper) is appended to IndexedDB
// first and flushed to Supabase when the connection comes back. Reads still
// need the network, but a student mid-quiz never loses work.
//
// IndexedDB rather than localStorage: writes are queued from async handlers,
// can exceed the ~5MB localStorage budget over a long lesson, and we want
// them to survive a tab crash.
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = 'mosaic-offline';
const DB_VERSION = 1;
const STORE = 'pending-writes';

/** Each queued item is a replayable POST to one of our own API routes. */
export interface QueuedWrite {
  id?: number;
  endpoint: string;
  body: unknown;
  queuedAt: number;
  /** Retry counter, so a permanently-bad payload can't block the queue forever. */
  attempts: number;
}

const MAX_ATTEMPTS = 5;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

/** Appends a write to the queue for replay once the connection returns. */
export async function enqueueWrite(endpoint: string, body: unknown): Promise<void> {
  try {
    const db = await openDb();
    await tx(db, 'readwrite', (store) =>
      store.add({ endpoint, body, queuedAt: Date.now(), attempts: 0 } as QueuedWrite),
    );
    db.close();
  } catch (err) {
    console.error('[offlineQueue] enqueue failed', err);
  }
}

export async function pendingCount(): Promise<number> {
  try {
    const db = await openDb();
    const count = await tx(db, 'readonly', (store) => store.count());
    db.close();
    return count;
  } catch {
    return 0;
  }
}

async function allWrites(): Promise<QueuedWrite[]> {
  const db = await openDb();
  const items = await tx<QueuedWrite[]>(db, 'readonly', (store) => store.getAll());
  db.close();
  return items;
}

async function removeWrite(id: number): Promise<void> {
  const db = await openDb();
  await tx(db, 'readwrite', (store) => store.delete(id));
  db.close();
}

async function bumpAttempts(item: QueuedWrite): Promise<void> {
  const db = await openDb();
  await tx(db, 'readwrite', (store) =>
    store.put({ ...item, attempts: item.attempts + 1 }),
  );
  db.close();
}

/**
 * Replays every queued write in order. Safe to call repeatedly — the API
 * routes it targets all upsert by a deterministic key, so a write that
 * actually landed before the connection dropped is idempotent on replay.
 */
export async function flushQueue(): Promise<{ sent: number; failed: number }> {
  if (!isOnline()) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  let items: QueuedWrite[];
  try {
    items = await allWrites();
  } catch (err) {
    console.error('[offlineQueue] read failed', err);
    return { sent: 0, failed: 0 };
  }

  for (const item of items.sort((a, b) => a.queuedAt - b.queuedAt)) {
    if (item.id === undefined) continue;

    try {
      const res = await fetch(item.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.body),
      });

      if (res.ok) {
        await removeWrite(item.id);
        sent += 1;
        continue;
      }

      // A 4xx means this payload will never succeed — drop it rather than
      // wedging every later write behind it.
      if (res.status >= 400 && res.status < 500) {
        console.warn('[offlineQueue] dropping rejected write', item.endpoint, res.status);
        await removeWrite(item.id);
        failed += 1;
        continue;
      }

      throw new Error(`HTTP ${res.status}`);
    } catch {
      failed += 1;
      if (item.attempts + 1 >= MAX_ATTEMPTS) {
        console.warn('[offlineQueue] giving up on write', item.endpoint);
        await removeWrite(item.id);
      } else {
        await bumpAttempts(item);
      }
      // Stop on the first network failure — we're probably offline again.
      if (!isOnline()) break;
    }
  }

  return { sent, failed };
}

/**
 * POSTs normally when online; queues for later when offline or when the
 * request fails outright. Returns the response if one was made.
 */
export async function postWithOfflineFallback(
  endpoint: string,
  body: unknown,
): Promise<Response | null> {
  if (!isOnline()) {
    await enqueueWrite(endpoint, body);
    return null;
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Server-side failures are worth retrying later; client errors are not.
    if (!res.ok && res.status >= 500) {
      await enqueueWrite(endpoint, body);
    }
    return res;
  } catch {
    await enqueueWrite(endpoint, body);
    return null;
  }
}
