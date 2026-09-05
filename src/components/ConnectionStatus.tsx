'use client';

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import { flushQueue, isOnline, pendingCount } from '@/lib/offlineQueue';

/**
 * Watches connectivity and drains the offline write queue when the network
 * returns. Renders a small status pill so a teacher (or a pitch audience) can
 * see that work is being held locally and then synced, rather than lost.
 */
export function useOfflineSync(): {
  online: boolean;
  pending: number;
  syncing: boolean;
  syncNow: () => Promise<void>;
} {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const refreshPending = useCallback(async () => {
    setPending(await pendingCount());
  }, []);

  const syncNow = useCallback(async () => {
    if (!isOnline()) return;
    setSyncing(true);
    try {
      await flushQueue();
    } finally {
      setSyncing(false);
      await refreshPending();
    }
  }, [refreshPending]);

  useEffect(() => {
    setOnline(isOnline());
    refreshPending();

    const handleOnline = () => {
      setOnline(true);
      void syncNow();
    };
    const handleOffline = () => setOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Catch writes queued by other tabs/components, and retry anything that
    // failed while the connection was flapping.
    const interval = setInterval(() => {
      void refreshPending();
      if (isOnline()) void syncNow();
    }, 15_000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(interval);
    };
  }, [refreshPending, syncNow]);

  return { online, pending, syncing, syncNow };
}

export default function ConnectionStatus({
  language = 'en',
}: {
  language?: 'en' | 'bm';
}) {
  const { online, pending, syncing, syncNow } = useOfflineSync();

  // Nothing worth saying when we're online and fully synced.
  if (online && pending === 0 && !syncing) return null;

  const label = !online
    ? language === 'en'
      ? 'Offline — work saved on this device'
      : 'Luar talian — kerja disimpan pada peranti ini'
    : syncing
      ? language === 'en'
        ? 'Syncing…'
        : 'Menyegerak…'
      : language === 'en'
        ? `${pending} waiting to sync`
        : `${pending} menunggu penyegerakan`;

  return (
    <AnimatePresence>
      <motion.button
        type="button"
        onClick={() => void syncNow()}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        className={[
          'fixed bottom-4 right-4 z-50 flex items-center gap-2',
          'rounded-full px-4 py-2 text-xs font-medium shadow-lg',
          online
            ? 'bg-amber-100 text-amber-900 border border-amber-200'
            : 'bg-slate-800 text-white border border-slate-700',
        ].join(' ')}
      >
        <span
          className={[
            'w-2 h-2 rounded-full',
            online ? 'bg-amber-500' : 'bg-red-400',
            syncing ? 'animate-pulse' : '',
          ].join(' ')}
        />
        {label}
        {pending > 0 && !syncing && (
          <span className="font-mono opacity-70">({pending})</span>
        )}
      </motion.button>
    </AnimatePresence>
  );
}
