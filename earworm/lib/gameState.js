// Core game rules, shared by the play screen and result card.

// How many seconds of the snippet are unlocked at each guess stage.
// Guess 1 hears 1s, guess 2 hears 2s, and so on (the classic Heardle ladder).
export const LADDER = [0.1, 0.5, 2, 4, 8, 15];

export const MAX_GUESSES = LADDER.length;

// Full preview length once the round is over.
export const FULL_PREVIEW_SECONDS = 30;

// The longest snippet any guessing stage plays (the final ladder step).
export const MAX_STAGE_SECONDS = LADDER[LADDER.length - 1];

// Pick a random start offset into the preview so the same song feels fresh
// each play. Capped so the longest stage still has room to play in full: if
// the last stage is 15s and the preview is 30s, the clip starts somewhere in
// the first 15s. Returns 0 if there's no headroom.
export function pickStartOffset() {
  const room = Math.max(0, FULL_PREVIEW_SECONDS - MAX_STAGE_SECONDS);
  return Math.random() * room;
}

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

// Pick the next song using a shuffle-bag: no song repeats until every song in
// the pool has been played once. `playedIds` is a Set of ids used this cycle —
// this function MUTATES it (adds the chosen id, and clears it when the bag is
// empty). `lastId` is the previous song's id, avoided on a fresh cycle so the
// pool doesn't play the same track twice across the seam.
//
// The pool can grow while you play (streamed imports): new songs simply aren't
// in `playedIds` yet, so they join the current cycle as eligible picks.
export function pickSong(songs, playedIds, lastId) {
  let candidates = songs.filter((s) => !playedIds.has(s.id));
  if (candidates.length === 0) {
    // Every song has been played — start a new cycle.
    playedIds.clear();
    candidates = songs.length > 1 ? songs.filter((s) => s.id !== lastId) : songs;
  }
  const song = candidates[Math.floor(Math.random() * candidates.length)];
  playedIds.add(song.id);
  return song;
}
