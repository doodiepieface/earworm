"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { handleCallback } from "@/lib/spotify";

// Spotify redirects here with ?code=… after login. We swap the code for
// tokens (PKCE — happens right in the browser) and head back to /spotify.

export default function CallbackPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return; // the code is single-use; don't run twice
    ranRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const denied = params.get("error");
    const code = params.get("code");

    if (denied) {
      setError("Spotify login was cancelled.");
      return;
    }
    if (!code) {
      setError("No login code found — try connecting again.");
      return;
    }

    handleCallback(code)
      .then(() => router.replace("/spotify"))
      .catch((err) => setError(err?.message || "Login failed."));
  }, [router]);

  return (
    <div className="page center">
      {error ? (
        <>
          <p className="error-msg">{error}</p>
          <Link href="/spotify" className="btn btn-primary">
            Back to Spotify setup
          </Link>
        </>
      ) : (
        <>
          <div className="loader" aria-hidden="true" />
          <p className="load-note">Finishing Spotify login…</p>
        </>
      )}
    </div>
  );
}
