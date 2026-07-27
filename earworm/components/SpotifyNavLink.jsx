"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { isConnected } from "@/lib/spotify";

// The Spotify integration is stuck in Spotify's development mode (a 25-user
// manual allowlist), so we don't advertise it to the public — it would look
// like a working feature that most visitors can't actually use. The nav link
// only appears once THIS browser has connected. The /spotify page itself still
// works by direct URL, so allowlisted users can reach it to connect the first
// time. (OAuth is a full page reload, so this re-checks and reveals the link.)
export default function SpotifyNavLink() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setConnected(isConnected());
  }, []);

  if (!connected) return null;
  return <Link href="/spotify">Spotify</Link>;
}
