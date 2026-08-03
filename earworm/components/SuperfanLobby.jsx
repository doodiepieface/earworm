"use client";

import { useState } from "react";
import { MIN_SUPERFAN_POOL } from "@/lib/roomGame";

// Superfan lobby: everyone claims their own artist. An artist can only be
// claimed once — shared ownership would wreck the crossover steal rule, since
// "the owner" of that round would be ambiguous.
//
// Only counts are shown, never song titles. Same rule as the shared pool.
export default function SuperfanLobby({
  claims, // [{ playerId, name, artist, songCount, ready }]
  meId,
  myClaim,
  onClaim,
  depth,
  onDepth,
  withFinale,
  onWithFinale,
  isHost,
  resolving,
  resolveNote,
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  function takenBySomeoneElse(artist) {
    const want = artist.trim().toLowerCase();
    return claims.some((c) => c.playerId !== meId && c.artist?.toLowerCase() === want);
  }

  function submit(e) {
    e.preventDefault();
    const artist = draft.trim();
    if (!artist) return;
    if (takenBySomeoneElse(artist)) {
      setError(`Someone already claimed ${artist}. Pick another.`);
      return;
    }
    setError("");
    onClaim(artist);
  }

  return (
    <>
      <section className="section">
        <p className="eyebrow">Your artist</p>
        {myClaim?.ready ? (
          <p>
            You&rsquo;re repping <strong>{myClaim.artist}</strong>
            <span className="dim"> · {myClaim.songCount} songs ready</span>
          </p>
        ) : (
          <>
            <form className="artist-form" onSubmit={submit}>
              <input
                type="text"
                value={draft}
                placeholder="Who are you a superfan of?"
                autoComplete="off"
                aria-label="Your artist"
                disabled={resolving}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={resolving || !draft.trim()}
              >
                {resolving ? "Loading…" : "Claim"}
              </button>
            </form>
            {resolving && <p className="dim">{resolveNote}</p>}
            {error && <p className="error-msg">{error}</p>}
            {myClaim && !myClaim.ready && !resolving && (
              <p className="error-msg">
                {myClaim.artist} only turned up {myClaim.songCount} playable songs — needs
                at least {MIN_SUPERFAN_POOL}. Try a different artist.
              </p>
            )}
          </>
        )}
      </section>

      <section className="section">
        <p className="eyebrow">Claimed so far</p>
        <ul className="claims">
          {claims.map((c) => (
            <li key={c.playerId} className={c.playerId === meId ? "me" : ""}>
              <span className="claim-who">{c.name}</span>
              <span className="claim-artist">{c.artist || "still choosing…"}</span>
              <span className="claim-state mono">{c.ready ? `${c.songCount} songs` : "—"}</span>
            </li>
          ))}
          {claims.length === 0 && <li className="dim">Nobody&rsquo;s claimed yet.</li>}
        </ul>
      </section>

      {/* Everyone sees what the format is, not just the host — otherwise the
          rules of the game they're about to play are invisible to them. */}
      <section className="section">
        <p className="eyebrow">Format</p>
        {isHost ? (
          <label className="check">
            <input
              type="checkbox"
              checked={withFinale}
              onChange={(e) => onWithFinale(e.target.checked)}
            />
            <span>Finish with a crossover finale</span>
          </label>
        ) : (
          <p>
            <strong>{withFinale ? "Mastery, then a crossover finale" : "Mastery only"}</strong>
          </p>
        )}

        {withFinale ? (
          <p className="dim">
            Most rounds you each hear a song from your <em>own</em> artist at the
            same time — that&rsquo;s the mastery half, and it asks whether you
            really know your pick. The last few rounds are the finale: everyone
            hears the <em>same</em> song, pulled from one player&rsquo;s artist.
            The owner is expected to get it, so anyone who beats them on their
            own artist scores <strong>double</strong>. Every player&rsquo;s
            artist gets at least one finale round.
          </p>
        ) : (
          <p className="dim">
            Every round, you each hear a song from your <em>own</em> artist at
            the same time. Purely who knows their own pick best — nobody ever
            guesses anyone else&rsquo;s artist, and there are no steals.
          </p>
        )}
      </section>

      {isHost && (
        <section className="section">
          <p className="eyebrow">Depth</p>
          <label className="field inline">
            <span>Catalog</span>
            <select value={depth} onChange={(e) => onDepth(e.target.value)}>
              <option value="hits">Hits — top 25 each</option>
              <option value="standard">Standard — top 60 each</option>
              <option value="deep">Deep cuts — everything</option>
            </select>
          </label>
          <p className="dim">
            Everyone gets the same depth, so a 30-song artist stays comparable to a
            400-song one.
            {depth === "deep" &&
              " Deep cuts pulls every album for every player — expect a slow lobby."}
          </p>
        </section>
      )}
    </>
  );
}
