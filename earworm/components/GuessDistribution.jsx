"use client";

import { LADDER, MAX_GUESSES } from "@/lib/gameState";

// End-of-game breakdown: for each player, how many rounds they won on each
// guess, and how many they missed entirely.
//
// Bars are scaled to the busiest single column across the WHOLE room, not per
// player — otherwise everyone's tallest bar looks identical and the chart stops
// saying anything about who did better.
export default function GuessDistribution({ players, meId }) {
  const peak = Math.max(
    1,
    ...(players || []).flatMap((p) => p.dist || []),
    ...(players || []).map((p) => p.misses || 0)
  );

  return (
    <div className="card gd">
      <p className="eyebrow">Guess breakdown</p>

      <ol className="gd-list">
        {(players || []).map((p) => {
          const dist = p.dist || [];
          const wins = dist.reduce((a, b) => a + b, 0);
          return (
            <li key={p.id} className={p.id === meId ? "me" : ""}>
              <div className="gd-head">
                <span className="gd-name">{p.name}</span>
                <span className="gd-summary dim">
                  {wins} correct{p.misses ? ` · ${p.misses} missed` : ""}
                </span>
              </div>

              <div className="gd-bars">
                {Array.from({ length: MAX_GUESSES }, (_, i) => {
                  const n = dist[i] || 0;
                  return (
                    <div
                      key={i}
                      className={`gd-col ${n ? "has" : ""}`}
                      title={`${n} won on guess ${i + 1} (${LADDER[i]}s)`}
                    >
                      <span className="gd-count mono">{n || ""}</span>
                      <span className="gd-bar" style={{ "--h": `${(n / peak) * 100}%` }} />
                      <span className="gd-tick mono">{i + 1}</span>
                    </div>
                  );
                })}

                <div className={`gd-col gd-miss ${p.misses ? "has" : ""}`} title={`${p.misses || 0} missed`}>
                  <span className="gd-count mono">{p.misses || ""}</span>
                  <span className="gd-bar" style={{ "--h": `${((p.misses || 0) / peak) * 100}%` }} />
                  <span className="gd-tick mono">✗</span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="dim gd-note">Which guess they got it on. ✗ is a miss.</p>
    </div>
  );
}
