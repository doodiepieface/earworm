"use client";

import { useEffect, useRef, useState } from "react";

// The visible half of a multiplayer round's time cap. Only rendered when a cap
// actually exists, so solo play — which has no cap — never shows one.
//
// This does NOT enforce the cap. The room page owns the authoritative timer and
// settles the round via RoundBoard's `forceEnd`; this only draws the countdown.
// Both anchor at the same moment (RoundBoard is keyed per round, so it mounts
// when the round arrives), which is why the bar and the cutoff agree.
//
// Ticks on a 100ms interval rather than requestAnimationFrame: a draining bar
// over 60 seconds needs nothing finer, and unlike the dial it doesn't have to be
// frame-accurate. It also keeps running in a backgrounded tab, where rAF stops.

const TICK_MS = 100;
const WARN_MS = 15000;
const URGENT_MS = 5000;

export default function RoundTimer({ capMs }) {
  const startedAt = useRef(Date.now());
  const [remaining, setRemaining] = useState(capMs);

  useEffect(() => {
    startedAt.current = Date.now();
    setRemaining(capMs);
    const id = setInterval(() => {
      const left = Math.max(0, capMs - (Date.now() - startedAt.current));
      setRemaining(left);
      if (left <= 0) clearInterval(id);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [capMs]);

  const pct = capMs > 0 ? Math.max(0, Math.min(100, (remaining / capMs) * 100)) : 0;
  const seconds = Math.ceil(remaining / 1000);
  const label = `0:${String(seconds).padStart(2, "0")}`;
  const level =
    remaining <= URGENT_MS ? "is-urgent" : remaining <= WARN_MS ? "is-warn" : "";

  return (
    <div className={`round-timer ${level}`}>
      <div className="rt-track" aria-hidden="true">
        <div className="rt-fill" style={{ width: `${pct}%` }} />
      </div>
      {/* The bar carries the urgency; the readout carries the number. Only the
          readout is exposed to assistive tech, and not as a live region — a
          per-second announcement would bury everything else. */}
      <span className="rt-readout mono" role="timer" aria-label={`${seconds} seconds left`}>
        {label}
      </span>
    </div>
  );
}
