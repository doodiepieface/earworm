"use client";

// Between-round and final standings. `results` is this round's per-player
// outcome (absent on the final board); `totals` is the running order.
//
// `contributedBy` only ever arrives with the round's scores — after the round
// has closed — so revealing whose pick it was is a payoff, never a hint.
export default function Scoreboard({ results, contributedBy, totals, meId, final }) {
  return (
    <div className="card scoreboard">
      {contributedBy && (
        <p className="sb-pick">
          <strong>{contributedBy}</strong>&rsquo;s pick
        </p>
      )}

      {results && (
        <ul className="sb-round">
          {results.map((r) => (
            <li key={r.playerId} className={r.playerId === meId ? "me" : ""}>
              <span className="sb-name">{r.name}</span>
              <span className="sb-detail">
                {r.selfPick
                  ? "own pick"
                  : r.missing
                  ? "ran out of time"
                  : r.won
                  ? `${r.guessCount} ${r.guessCount === 1 ? "guess" : "guesses"}`
                  : "missed"}
              </span>
              <span className="sb-points mono">{r.points > 0 ? `+${r.points}` : "—"}</span>
            </li>
          ))}
        </ul>
      )}

      <ol className="sb-totals">
        {(totals || []).map((p, i) => (
          <li key={p.id} className={p.id === meId ? "me" : ""}>
            <span className="sb-place mono">{i + 1}</span>
            <span className="sb-name">{p.name}</span>
            <span className="sb-points mono">{p.score}</span>
          </li>
        ))}
      </ol>

      {final && <p className="sb-final">Final</p>}
    </div>
  );
}
