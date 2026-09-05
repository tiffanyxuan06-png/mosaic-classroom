"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { signOutUser, useUserRole } from "@/lib/auth";
import { LanguageProvider, useLanguage } from "@/lib/LanguageContext";

function StudentHeader({ name, onSignOut }: { name: string | null; onSignOut: () => void }) {
  const { language, toggleLanguage } = useLanguage();

  return (
    <header className="flex items-center justify-between border-b px-6 py-4">
      <span className="text-lg font-semibold">🎓 Mosaic Classroom</span>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={toggleLanguage}>
          {language === "en" ? "EN | BM" : "BM | EN"}
        </Button>
        <span className="text-sm text-muted-foreground">{name ?? "Student"}</span>
        <Button variant="outline" size="sm" onClick={onSignOut}>
          Sign Out
        </Button>
      </div>
    </header>
  );
}

function StudentLayoutContent({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { uid, role, name, loading } = useUserRole();

  useEffect(() => {
    if (!loading && (!uid || role !== "student")) {
      router.replace("/");
    }
  }, [loading, uid, role, router]);

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
      <StudentHeader name={name} onSignOut={handleSignOut} />
      <main>{children}</main>
    </div>
  );
}

export default function StudentLayout({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <StudentLayoutContent>{children}</StudentLayoutContent>
    </LanguageProvider>
  );
}
