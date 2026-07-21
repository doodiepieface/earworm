"use client";

// Optional account layer, backed by Supabase (hosted auth + database).
//
// This is entirely opt-in: if the two NEXT_PUBLIC_SUPABASE_* env vars aren't
// set, every function here no-ops and the app runs exactly as before, purely
// on localStorage. Nothing about signed-out play depends on this file.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

// Sign-in methods to offer, in order. Google today. To turn on Apple later:
// add "apple" to this array AND enable the Apple provider in the Supabase
// dashboard — no other code changes needed. (Apple also needs a paid Apple
// Developer account and a public HTTPS domain; it can't run on localhost.)
export const AUTH_PROVIDERS = ["google"];

// Human labels for the provider buttons.
export const PROVIDER_LABELS = {
  google: "Google",
  apple: "Apple",
};

export function isAuthConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

let client = null;

export function getClient() {
  if (!isAuthConfigured()) return null;
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true, // finishes the OAuth redirect automatically
        flowType: "pkce",
      },
    });
  }
  return client;
}

export async function signIn(provider = "google") {
  const c = getClient();
  if (!c) return;
  await c.auth.signInWithOAuth({
    provider,
    // Come back to wherever the user started the sign-in from.
    options: { redirectTo: window.location.origin },
  });
}

export async function signOut() {
  const c = getClient();
  if (!c) return;
  await c.auth.signOut();
}

// Fires `cb(user | null)` now-ish and on every future auth change.
// Returns an unsubscribe function.
export function onAuthChange(cb) {
  const c = getClient();
  if (!c) {
    cb(null);
    return () => {};
  }
  const { data } = c.auth.onAuthStateChange((_event, session) => {
    cb(session?.user || null);
  });
  return () => data.subscription.unsubscribe();
}
