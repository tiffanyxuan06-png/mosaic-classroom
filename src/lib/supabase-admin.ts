import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const SUPABASE_ADMIN_MISSING_MESSAGE =
  "Server is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local (see .env.local.example).";

let client: SupabaseClient | null = null;

if (supabaseUrl && serviceRoleKey) {
  client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
} else {
  console.warn(`[supabase-admin] ${SUPABASE_ADMIN_MISSING_MESSAGE}`);
}

/** The service-role client, or null when the env vars are missing. */
export function getSupabaseAdmin(): SupabaseClient | null {
  return client;
}

/**
 * Call at the top of every route handler that uses `supabaseAdmin`.
 * Returns a 503 JSON response when the admin client is not configured,
 * otherwise null so the handler can continue.
 */
export function requireSupabaseAdmin(): NextResponse | null {
  if (client) return null;
  return NextResponse.json(
    { error: "server_not_configured", message: SUPABASE_ADMIN_MISSING_MESSAGE },
    { status: 503 },
  );
}

/**
 * When unconfigured this is a proxy that throws a descriptive error on first
 * use, instead of the opaque "Cannot read properties of undefined (reading
 * 'from')" that an `undefined` export produced.
 */
export const supabaseAdmin: SupabaseClient =
  client ??
  (new Proxy(
    {},
    {
      get(_target, prop) {
        // Let `await supabaseAdmin` and similar thenable checks pass through.
        if (prop === "then") return undefined;
        throw new Error(SUPABASE_ADMIN_MISSING_MESSAGE);
      },
    },
  ) as SupabaseClient);
