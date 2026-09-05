"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { collection, getDocs, query, where } from "firebase/firestore";

import { db } from "@/lib/firebase-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function KioskEntryPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const kioskCode = code.trim().toUpperCase();
    if (kioskCode.length !== 6) {
      setError("Enter the 6-character class code.");
      return;
    }

    setLoading(true);
    try {
      const classesRef = collection(db, "classes");
      const matchingClass = query(classesRef, where("kioskCode", "==", kioskCode));
      const snap = await getDocs(matchingClass);

      if (snap.empty) {
        setError("No class found with that code. Check with your teacher.");
        return;
      }

      router.push(`/kiosk/${snap.docs[0].id}`);
    } catch (err) {
      console.error("[kiosk] class lookup error", err);
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl">🎓 Mosaic Classroom</CardTitle>
          <CardDescription className="text-base">
            Enter your class code to join
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <Alert variant="destructive">
                <AlertTitle>Couldn&apos;t join</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Input
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              maxLength={6}
              placeholder="ABC123"
              autoFocus
              autoCapitalize="characters"
              autoComplete="off"
              className="h-20 text-center text-4xl font-bold tracking-[0.3em]"
            />

            <Button type="submit" className="h-14 w-full text-lg" disabled={loading}>
              {loading ? "Joining..." : "Join Class"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
