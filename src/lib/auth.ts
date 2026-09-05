"use client";

import { useEffect, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";

import { auth, db } from "@/lib/firebase-client";

export type UserRole = "teacher" | "student" | null;

export interface AuthedUser {
  uid: string;
  role: UserRole;
}

export async function signInUser(
  email: string,
  password: string
): Promise<AuthedUser> {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const uid = credential.user.uid;

  const userSnap = await getDoc(doc(db, "users", uid));
  if (!userSnap.exists()) {
    throw new Error("No user profile found for this account.");
  }

  const role = (userSnap.data().role as UserRole) ?? null;
  return { uid, role };
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

export function onAuthChange(
  callback: (user: User | null) => void
): () => void {
  if (!auth || typeof auth.onAuthStateChanged !== "function") {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
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

      const userSnap = await getDoc(doc(db, "users", user.uid));
      const data = userSnap.exists() ? userSnap.data() : null;

      setState({
        uid: user.uid,
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
