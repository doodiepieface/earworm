"use client";

import { useState } from "react";
import { buildShareText } from "@/lib/gameState";

export default function ResultCard({ won, song, guesses, poolName, streak, onNext }) {
  const [copied, setCopied] = useState(false);

  async function copyResult() {
    const text = buildShareText({ poolName, guesses, won });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (e.g. non-secure context) — show it instead.
      window.prompt("Copy your result:", text);
    }
  }

  return (
    <div className={`card result-card ${won ? "result-won" : "result-lost"}`}>
      <p className="result-verdict">
        {won
          ? `Got it in ${guesses.length + 1} ${guesses.length === 0 ? "guess" : "guesses"}!`
          : "Out of guesses — it was:"}
      </p>

      <div className="result-song">
        {song.artworkUrl ? (
          <img src={song.artworkUrl} alt="" width={72} height={72} />
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
        <button type="button" className="btn btn-ghost" onClick={copyResult}>
          {copied ? "Copied!" : "Copy result"}
        </button>
      </div>
    </div>
  );
}
