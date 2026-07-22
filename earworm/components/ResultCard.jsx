"use client";

export default function ResultCard({ won, song, guesses, streak, onNext }) {
  return (
    <div className={`card result-card ${won ? "result-won" : "result-lost"}`}>
      <p className="result-verdict">
        {won
          ? `Got it in ${guesses.length + 1} ${guesses.length === 0 ? "guess" : "guesses"}!`
          : "Out of guesses — it was:"}
      </p>

      <div className="result-song">
        {song.artworkUrl ? (
          <img src={song.artworkUrl} alt="" width={78} height={78} />
        ) : (
          <div className="art-fallback" aria-hidden="true">
            ♪
          </div>
        )}
        <div>
          <p className="result-title">{song.title}</p>
          <p className="result-artist">{song.artist}</p>
        </div>
      </div>

      <p className="result-streak mono">
        Streak: {streak} {streak > 2 ? "🔥" : ""}
      </p>
      <p className="result-hint">The full preview is unlocked above — have a listen.</p>

      <div className="result-actions">
        <button type="button" className="btn btn-primary" onClick={onNext}>
          Next song
        </button>
        {song.appleUrl && (
          <a
            className="apple-link"
            href={song.appleUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Listen on Apple Music
            <span aria-hidden="true"> ↗</span>
          </a>
        )}
      </div>
    </div>
  );
}
