"use client";

import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";

import { supabase } from "@/lib/supabase-client";

export type UserRole = "teacher" | "student" | null;

export interface AuthedUser {
  uid: string;
  role: UserRole;
}

export async function signInUser(
  email: string,
  password: string
): Promise<AuthedUser> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;

  const uid = data.user.id;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", uid)
    .single();

  if (profileError || !profile) {
    throw new Error("No user profile found for this account.");
  }

  const role = (profile.role as UserRole) ?? null;
  return { uid, role };
}

export async function signOutUser(): Promise<void> {
  await supabase.auth.signOut();
}

export function onAuthChange(
  callback: (user: User | null) => void
): () => void {
  if (!supabase || typeof supabase.auth?.onAuthStateChange !== "function") {
    callback(null);
    return () => {};
  }

  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });

  return () => data.subscription.unsubscribe();
}

interface UseUserRoleResult {
  uid: string | null;
  role: UserRole;
  name: string | null;
  profile: Record<string, unknown> | null;
  loading: boolean;
}

export function useUserRole(): UseUserRoleResult {
  const [state, setState] = useState<UseUserRoleResult>({
    uid: null,
    role: null,
    name: null,
    profile: null,
    loading: true,
  });

  useEffect(() => {
    const unsubscribe = onAuthChange(async (user) => {
      if (!user) {
        setState({ uid: null, role: null, name: null, profile: null, loading: false });
        return;
      }

      const { data } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .single();

      setState({
        uid: user.id,
        role: (data?.role as UserRole) ?? null,
        name: (data?.name as string) ?? null,
        profile: data,
        loading: false,
      });
    });

    return unsubscribe;
  }, []);

  return state;
}
