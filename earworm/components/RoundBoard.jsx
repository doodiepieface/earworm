"use client";

import { useEffect, useRef, useState } from "react";
import SnippetPlayer from "@/components/SnippetPlayer";
import GuessLadder from "@/components/GuessLadder";
import GuessInput from "@/components/GuessInput";
import RoundTimer from "@/components/RoundTimer";
import { isCorrectGuess } from "@/lib/itunes";
import { LADDER, MAX_GUESSES, FULL_PREVIEW_SECONDS, skipLabel } from "@/lib/gameState";

// One round of guessing: the dial, the ladder, and the guess box. Owns the
// guess list and the win/loss decision, and nothing else — no pool, no stats,
// no networking. Both the solo play page and a multiplayer room render this, so
// the rules can't drift between the two.
//
// The parent MUST pass a `key` that changes each round; internal state resets
// on remount rather than through an effect that could race the first render.
//
// `forceEnd` is for rooms: when the 60s cap expires the parent flips it true and
// an unfinished round is settled as a loss. It does nothing in solo play.
//
// `children` renders below the ladder — that's where the parent puts its own
// result card, which differs between solo and room play.
export default function RoundBoard({
  song,
  startAt = 0,
  localSongs = null,
  forceEnd = false,
  capMs = 0,
  onFinish,
  onUnplayable,
  children,
}) {
  const [guesses, setGuesses] = useState([]);
  const [status, setStatus] = useState("playing"); // playing | won | lost
  const firedRef = useRef(false); // onFinish is once per round, never twice

  function settle(won, finalGuesses) {
    if (firedRef.current) return;
    firedRef.current = true;
    setGuesses(finalGuesses);
    setStatus(won ? "won" : "lost");
    onFinish?.({
      won,
      guessCount: won ? finalGuesses.length + 1 : MAX_GUESSES,
      guesses: finalGuesses,
    });
  }

  function addAttempt(attempt) {
    if (status !== "playing" || firedRef.current) return;
    const next = [...guesses, attempt];
    if (next.length >= MAX_GUESSES) settle(false, next);
    else setGuesses(next);
  }

  function handleGuess(guess) {
    if (status !== "playing") return;
    if (isCorrectGuess(guess, song)) settle(true, guesses);
    else addAttempt({ type: "wrong", label: `${guess.title} — ${guess.artist}` });
  }

  function handleSkip() {
    if (status !== "playing") return;
    addAttempt({ type: "skip" });
  }

  // Room timeout: settle as a loss with whatever guesses were made.
  useEffect(() => {
    if (forceEnd && !firedRef.current) settle(false, guesses);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceEnd]);

  const ended = status !== "playing";
  const unlocked = ended ? FULL_PREVIEW_SECONDS : LADDER[guesses.length];
  const maxSeconds = ended ? FULL_PREVIEW_SECONDS : LADDER[LADDER.length - 1];

  return (
    <>
      <SnippetPlayer
        song={song}
        unlockedSeconds={unlocked}
        maxSeconds={maxSeconds}
        startAt={ended ? 0 : startAt}
        onUnplayable={onUnplayable}
      />

      <GuessLadder guesses={guesses} status={status} />

      {/* Only multiplayer passes a cap, so solo play never shows a countdown.
          It disappears the moment the round settles — once you've locked in an
          answer you're waiting on other people, not racing a clock. */}
      {!ended && capMs > 0 && <RoundTimer capMs={capMs} />}

      {!ended && (
        <GuessInput
          onGuess={handleGuess}
          onSkip={handleSkip}
          disabled={ended}
          skipText={skipLabel(guesses.length)}
          answer={song}
          localSongs={localSongs}
        />
      )}

      {children}
    </>
  );
}
