"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { signOutUser, useUserRole } from "@/lib/auth";

type Language = "EN" | "BM";

const LANGUAGE_STORAGE_KEY = "mosaic-language";

export default function StudentLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { uid, role, name, loading } = useUserRole();
  const [language, setLanguage] = useState<Language>("EN");

  useEffect(() => {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === "EN" || stored === "BM") {
      setLanguage(stored);
    }
  }, []);

  useEffect(() => {
    if (!loading && (!uid || role !== "student")) {
      router.replace("/");
    }
  }, [loading, uid, role, router]);

  function toggleLanguage() {
    const next: Language = language === "EN" ? "BM" : "EN";
    setLanguage(next);
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
  }

  async function handleSignOut() {
    await signOutUser();
    router.replace("/");
  }

  if (loading || !uid || role !== "student") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <span className="text-lg font-semibold">🎓 Mosaic Classroom</span>
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={toggleLanguage}>
            {language === "EN" ? "EN / BM" : "BM / EN"}
          </Button>
          <span className="text-sm text-muted-foreground">{name ?? "Student"}</span>
          <Button variant="outline" size="sm" onClick={handleSignOut}>
            Sign Out
          </Button>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
