"use client";

import { MIN_SUPERFAN_POOL } from "@/lib/roomGame";

// Shown to everyone between "Start" and round one, while each player's browser
// pulls their own artist's catalog.
//
// This step exists because resolving at claim time froze each pool at whatever
// depth was set in that moment — change the depth afterwards and anyone who had
// already claimed kept their old pool. Resolving here means every pool is built
// from the settings the game actually starts with.
//
// Progress is broadcast, so the wait is a shared moment rather than five people
// staring at private spinners.
export default function ArtistLoading({ players, meId }) {
  const done = players.filter((p) => p.done).length;

  return (
    <div className="page center artist-loading">
      <h1>
        Pulling <em>everyone&rsquo;s</em> artists
      </h1>
      <p className="hero-sub">
        {done}/{players.length} ready
      </p>

      <ul className="al-list">
        {players.map((p) => {
          const short = p.done && (p.count || 0) < MIN_SUPERFAN_POOL;
          return (
            <li key={p.playerId} className={p.playerId === meId ? "me" : ""}>
              <span className="al-who">{p.name}</span>
              <span className="al-artist">{p.artist || "…"}</span>
              <span className={`al-count mono ${p.done ? "is-done" : ""} ${short ? "is-short" : ""}`}>
                {p.done ? `${p.count} songs` : `${p.count || 0}…`}
              </span>
            </li>
          );
        })}
      </ul>

      {players.some((p) => p.done && (p.count || 0) < MIN_SUPERFAN_POOL) && (
        <p className="dim">
          A thin catalog is fine — the game just shortens so nobody hears the
          same song twice.
        </p>
      )}
    </div>
  );
}
