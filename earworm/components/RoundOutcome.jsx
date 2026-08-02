"use client";

import { withAppleAffiliate } from "@/lib/site";

// What you see the moment your own round ends in a room, before the scoreboard.
//
// Multiplayer used to show a single line of grey text here — no colour, no
// answer — so a win read almost the same as a loss and you never learned the
// song you missed. Both are fixed: the card is unmistakably green or red, and
// it always names the track either way.
export default function RoundOutcome({ won, guessCount, song, note }) {
  return (
    <div className={`card round-outcome ${won ? "outcome-won" : "outcome-lost"}`}>
      <p className="outcome-verdict">
        {won
          ? `Got it in ${guessCount} ${guessCount === 1 ? "guess" : "guesses"}!`
          : "Missed that one."}
      </p>

      <div className="result-song">
        {song?.artworkUrl ? (
          <img src={song.artworkUrl} alt="" width={64} height={64} />
        ) : (
          <div className="art-fallback" aria-hidden="true">
            ♪
          </div>
        )}
        <div>
          <p className="result-title">{song?.title}</p>
          <p className="result-artist">{song?.artist}</p>
        </div>
      </div>

      <div className="outcome-actions">
        {/* Apple's terms expect this attribution wherever we surface a preview,
            so a room round earns it just as much as a solo one. Absent only for
            songs matched before appleUrl was carried through. */}
        {song?.appleUrl && (
          <a
            className="apple-link"
            href={withAppleAffiliate(song.appleUrl)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Listen on Apple Music
            <span aria-hidden="true"> ↗</span>
          </a>
        )}
        {note && <p className="outcome-note">{note}</p>}
      </div>
    </div>
  );
}
