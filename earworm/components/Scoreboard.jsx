"use client";

// Dense ranking: players level on points share a place number, and the next
// distinct score skips ahead (1, 1, 3). `totals` arrives already sorted.
function withPlaces(totals) {
  const list = totals || [];
  let place = 0;
  return list.map((p, i) => {
    if (i === 0 || p.score !== list[i - 1].score) place = i + 1;
    return { ...p, place };
  });
}

// Between-round and final standings. `results` is this round's per-player
// outcome (absent on the final board); `totals` is the running order.
//
// `contributedBy` only ever arrives with the round's scores — after the round
// has closed — so revealing whose pick it was is a payoff, never a hint.
export default function Scoreboard({
  results,
  contributedBy,
  ownerName,
  artist,
  totals,
  meId,
  final,
}) {
  return (
    <div className="card scoreboard">
      {contributedBy && (
        <p className="sb-pick">
          <strong>{contributedBy}</strong>&rsquo;s pick
        </p>
      )}

      {ownerName && (
        <p className="sb-pick">
          <strong>{ownerName}</strong>&rsquo;s artist — {artist}
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
                {r.isOwner && <span className="sb-owner"> · their artist</span>}
                {r.stole && <span className="sb-steal"> STEAL</span>}
              </span>
              <span className="sb-points mono">{r.points > 0 ? `+${r.points}` : "—"}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Equal scores share a place (1, 1, 3) rather than being numbered off in
          whatever order the speed tiebreak produced — the list stays sorted, but
          it stops implying a ranking that the points don't support. */}
      <ol className="sb-totals">
        {withPlaces(totals).map((p) => (
          <li key={p.id} className={p.id === meId ? "me" : ""}>
            <span className="sb-place mono">{p.place}</span>
            <span className="sb-name">{p.name}</span>
            <span className="sb-points mono">{p.score}</span>
          </li>
        ))}
      </ol>

      {final && <p className="sb-final">Final</p>}
    </div>
  );
}
