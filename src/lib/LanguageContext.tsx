'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type Language = 'en' | 'bm';

interface LanguageContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  /** Convenience toggle — swaps between 'en' and 'bm'. */
  toggleLanguage: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

const LanguageContext = createContext<LanguageContextValue>({
  language: 'en',
  setLanguage: () => {},
  toggleLanguage: () => {},
});

// ─────────────────────────────────────────────────────────────────────────────
// localStorage key
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'mosaic_language';

function readFromStorage(): Language {
  if (typeof window === 'undefined') return 'en';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'bm' ? 'bm' : 'en';
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export function LanguageProvider({ children }: { children: ReactNode }) {
  // Initialise from localStorage; default to 'en' on the server pass.
  const [language, setLanguageState] = useState<Language>('en');

  // Hydrate from localStorage after mount to avoid SSR mismatch.
  useEffect(() => {
    setLanguageState(readFromStorage());
  }, []);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // localStorage may be blocked in private browsing — fail silently.
    }
  }, []);

  const toggleLanguage = useCallback(() => {
    setLanguageState((prev) => {
      const next: Language = prev === 'en' ? 'bm' : 'en';
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, toggleLanguage }}>
      {children}
    </LanguageContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hook to read and update the active language from any component inside a
 * LanguageProvider.
 *
 * @example
 * const { language, toggleLanguage } = useLanguage();
 */
export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext);
}
