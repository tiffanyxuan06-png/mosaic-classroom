"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { signOutUser, useUserRole } from "@/lib/auth";

export default function TeacherLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { uid, role, name, profile, loading } = useUserRole();

  useEffect(() => {
    if (!loading && (!uid || role !== "teacher")) {
      router.replace("/");
    }
  }, [loading, uid, role, router]);

  async function handleSignOut() {
    await signOutUser();
    router.replace("/");
  }

  if (loading || !uid || role !== "teacher") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  const className = (profile?.className as string) ?? "";

  return (
    <div className="min-h-screen">
      <header className="grid grid-cols-3 items-center border-b px-6 py-4">
        <span className="text-lg font-semibold">🎓 Mosaic Classroom</span>
        <span className="text-center text-sm font-medium text-muted-foreground">
          {className}
        </span>
        <div className="flex items-center justify-end gap-3">
          <span className="text-sm text-muted-foreground">{name ?? "Teacher"}</span>
          <Button variant="outline" size="sm" onClick={handleSignOut}>
            Sign Out
          </Button>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
