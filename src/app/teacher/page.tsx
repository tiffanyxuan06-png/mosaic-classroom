"use client";

import { useUserRole } from "@/lib/auth";

export default function TeacherHomePage() {
  const { name } = useUserRole();

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">Welcome, {name ?? "Teacher"}!</h1>
    </div>
  );
}
