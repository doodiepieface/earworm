// Core game rules, shared by the play screen and result card.

// How many seconds of the snippet are unlocked at each guess stage.
// Guess 1 hears 1s, guess 2 hears 2s, and so on (the classic Heardle ladder).
export const LADDER = [0.1, 0.5, 2, 4, 8, 15];

export const MAX_GUESSES = LADDER.length;

// Full preview length once the round is over.
export const FULL_PREVIEW_SECONDS = 30;

// Label for the Skip button: how many extra seconds the next stage unlocks.
export function skipLabel(guessCount) {
  const next = LADDER[guessCount + 1];
  if (next === undefined) return "Skip";
  return `Skip (+${next - LADDER[guessCount]}s)`;
}

// Wordle-style shareable summary. `guesses` is the list of wrong/skipped
// attempts made BEFORE the round ended (a winning guess isn't in the list).
export function buildShareText({ poolName, guesses, won }) {
  const squares = guesses
    .map((g) => (g.type === "skip" ? "⬜" : "🟥"))
    .join("");
  const count = won ? `${guesses.length + 1}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
  const line = won ? `${squares}🟩` : squares;
  return `Earworm 🎵 ${poolName}\n${count} ${line}`;
}

// Pick a random song from the pool, avoiding recently played ids.
export function pickSong(songs, recentIds) {
  const avoid = new Set(recentIds);
  const fresh = songs.filter((s) => !avoid.has(s.id));
  const candidates = fresh.length > 0 ? fresh : songs;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
