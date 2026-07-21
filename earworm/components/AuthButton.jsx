"use client";

import { useEffect, useRef, useState } from "react";
import {
  isAuthConfigured,
  AUTH_PROVIDERS,
  PROVIDER_LABELS,
  signIn,
  signOut,
  onAuthChange,
} from "@/lib/supabase";
import { initSync, setSyncUser, mergeOnLogin } from "@/lib/sync";

// Header account control. Renders nothing unless the account layer is
// configured (NEXT_PUBLIC_SUPABASE_* env vars), so the app is unchanged for
// anyone who hasn't set it up.

export default function AuthButton() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(null);
  const [open, setOpen] = useState(false);
  const lastUid = useRef(null);

  useEffect(() => {
    if (!isAuthConfigured()) {
      setReady(true);
      return;
    }
    initSync(); // start mirroring local writes for whoever signs in
    const unsub = onAuthChange((u) => {
      setUser(u);
      setSyncUser(u);
      const uid = u?.id || null;
      // Reconcile local + account only on a fresh sign-in, not on every token
      // refresh (which also fires this callback with the same user).
      if (uid && uid !== lastUid.current) mergeOnLogin(u);
      lastUid.current = uid;
      setReady(true);
    });
    return unsub;
  }, []);

  if (!isAuthConfigured() || !ready) return null;

  const name =
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    user?.email ||
    "Account";
  const initial = (name[0] || "?").toUpperCase();

  return (
    <div className="auth">
      <button
        type="button"
        className="auth-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
      >
        {user ? (
          <>
            <span className="auth-avatar" aria-hidden="true">
              {initial}
            </span>
            <span className="auth-name">{name}</span>
          </>
        ) : (
          "Sign in"
        )}
      </button>

      {open && (
        <>
          <div className="auth-backdrop" onClick={() => setOpen(false)} />
          <div className="auth-menu" role="menu">
            {user ? (
              <>
                <p className="auth-menu-head">{user.email}</p>
                <p className="auth-note dim">
                  Your imports, lists, and stats are saved to this account.
                </p>
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  onClick={() => {
                    setOpen(false);
                    signOut();
                  }}
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <p className="auth-menu-head">Save your progress</p>
                <p className="auth-note dim">
                  Keep your imports, lists, and stats across devices. Playing
                  without an account still works.
                </p>
                {AUTH_PROVIDERS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="btn btn-small"
                    onClick={() => signIn(p)}
                  >
                    Continue with {PROVIDER_LABELS[p] || p}
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
