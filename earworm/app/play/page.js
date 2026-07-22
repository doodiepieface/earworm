"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SnippetPlayer from "@/components/SnippetPlayer";
import GuessInput from "@/components/GuessInput";
import GuessLadder from "@/components/GuessLadder";
import ResultCard from "@/components/ResultCard";
import { getPack } from "@/data/packs";
import { streamArtistPool, resolveTracks, isCorrectGuess } from "@/lib/itunes";
import {
  LADDER,
  MAX_GUESSES,
  FULL_PREVIEW_SECONDS,
  skipLabel,
  pickSong,
  pickStartOffset,
} from "@/lib/gameState";
import {
  getActivePool,
  loadLists,
  loadSpotifyPools,
  saveSpotifyPools,
  loadPackCache,
  savePackCache,
  loadStats,
  recordResult,
} from "@/lib/storage";

const MIN_POOL_SIZE = 4;
// For a streamed import, start the game once this many songs are matched —
// enough variety to begin, small enough that you're playing within seconds.
const STREAM_START_AT = 8;

export default function PlayPage() {
  const router = useRouter();

  const [phase, setPhase] = useState("loading"); // loading | error | ready
  const [loadNote, setLoadNote] = useState("Loading your pool…");
  const [errorMsg, setErrorMsg] = useState("");
  const [pool, setPool] = useState(null); // { name, songs }
  const [round, setRound] = useState(null); // { song, guesses, status }
  const [streak, setStreak] = useState(0);
  const [resolving, setResolving] = useState(false); // still matching more songs
  const [guessArtist, setGuessArtist] = useState(null); // scope guesses in artist mode

  // Shuffle-bag state: ids played in the current cycle, and the last pick.
  // No song repeats until every song in the pool has been played once.
  const playedIds = useRef(new Set());
  const lastId = useRef(null);

  /* ---------- Load & resolve the active pool ---------- */

  useEffect(() => {
    // `aborted` flips true when this page unmounts (e.g. "Change pool"). Any
    // in-flight resolution checks it and stops, so we never keep matching songs
    // for a pool the player has left — and it makes React 18 StrictMode's
    // double-mount harmless: the first run aborts, the second does the work.
    let aborted = false;

    const spec = getActivePool();
    if (!spec) {
      router.replace("/");
      return;
    }

    // Kick off a game from the first batch of matched songs, then let the rest
    // stream in. Shared by the streaming branches below.
    function begin(name, songs) {
      setPool({ name, songs: songs.slice() });
      setStreak(loadStats().streak);
      startRound(songs);
      setPhase("ready");
    }

    // Shared plumbing for streaming sources (Spotify import, artist mode):
    // collect songs as they arrive, start the game once there are enough, then
    // keep appending to the live pool so it grows while you play.
    function streamSink(name) {
      const collected = [];
      const state = { started: false };
      return {
        collected,
        isStarted: () => state.started,
        onSong: (song) => {
          collected.push(song);
          if (state.started) {
            setPool((p) =>
              p ? { ...p, songs: [...p.songs, song] } : { name, songs: [song] }
            );
          } else if (collected.length >= STREAM_START_AT) {
            state.started = true;
            begin(name, collected);
          }
        },
      };
    }

    async function load() {
      try {
        let name = "";
        let songs = [];

        if (spec.type === "resolved") {
          name = spec.name;
          songs = spec.songs || [];
        } else if (spec.type === "stream") {
          // Big imports (e.g. Liked Songs): match previews progressively so the
          // player starts almost immediately and the pool fills while they play.
          name = spec.name;
          const sink = streamSink(name);
          setResolving(true);

          await resolveTracks(spec.tracks || [], {
            isAborted: () => aborted,
            onProgress: () => {
              if (!sink.isStarted())
                setLoadNote(
                  `Matching your songs to previews… ${sink.collected.length} ready`
                );
            },
            onSong: sink.onSong,
          });

          if (aborted) return;
          setResolving(false);

          if (!sink.isStarted()) {
            // Never reached the start threshold — begin anyway if playable,
            // otherwise this pool just doesn't have enough matchable songs.
            if (sink.collected.length >= MIN_POOL_SIZE) begin(name, sink.collected);
            else
              throw new Error(
                `Only ${sink.collected.length} of those songs matched a playable preview — not enough to play.`
              );
          }

          // Cache the finished result so replaying is instant and it appears
          // under "Already imported" and on the home screen.
          if (spec.cacheId && sink.collected.length) {
            const others = loadSpotifyPools().filter((p) => p.id !== spec.cacheId);
            saveSpotifyPools([
              { id: spec.cacheId, name, songs: sink.collected, misses: [], importedAt: Date.now() },
              ...others,
            ]);
          }
          return; // this branch manages its own phase/round
        } else if (spec.type === "pack") {
          const pack = getPack(spec.id);
          if (!pack) throw new Error("That pack no longer exists.");
          name = pack.name;
          const cached = loadPackCache(pack.id);
          if (cached?.songs?.length) {
            songs = cached.songs;
          } else {
            setLoadNote(`Finding previews for “${pack.name}”… 0/${pack.tracks.length}`);
            const { songs: resolved, misses } = await resolveTracks(pack.tracks, {
              isAborted: () => aborted,
              onProgress: (done, total, missCount) =>
                setLoadNote(
                  `Finding previews for “${pack.name}”… ${done}/${total}` +
                    (missCount ? ` (${missCount} unavailable)` : "")
                ),
            });
            songs = resolved;
            if (!aborted) savePackCache(pack.id, { songs: resolved, misses });
          }
        } else if (spec.type === "artist") {
          // Start from the artist's most popular ~120 songs, then keep pulling
          // the deep catalog album by album in the background while you play.
          name = spec.name;
          setGuessArtist(spec.name); // scope the guess box to this artist
          const sink = streamSink(name);
          setResolving(true);
          setLoadNote(`Pulling songs by ${spec.name}…`);

          await streamArtistPool(spec.name, {
            isAborted: () => aborted,
            onSong: sink.onSong,
          });

          if (aborted) return;
          setResolving(false);

          if (!sink.isStarted()) {
            if (sink.collected.length >= MIN_POOL_SIZE) begin(name, sink.collected);
            else
              throw new Error(
                `Couldn't find playable songs for “${spec.name}”. Check the spelling, or try a bigger-name artist.`
              );
          }
          return; // this branch manages its own phase/round
        } else if (spec.type === "list") {
          const list = loadLists().find((l) => l.id === spec.id);
          if (!list) throw new Error("That list no longer exists.");
          name = list.name;
          songs = list.songs;
        } else if (spec.type === "spotify") {
          const sp = loadSpotifyPools().find((p) => p.id === spec.id);
          if (!sp) throw new Error("That imported pool no longer exists.");
          name = sp.name;
          songs = sp.songs;
        } else {
          throw new Error("Unknown pool type.");
        }

        if (aborted) return;

        songs = (songs || []).filter((s) => s.previewUrl);
        if (songs.length < MIN_POOL_SIZE) {
          throw new Error(
            `This pool only has ${songs.length} playable song${songs.length === 1 ? "" : "s"} — pick one with at least ${MIN_POOL_SIZE} so guessing stays interesting.`
          );
        }

        begin(name, songs);
      } catch (err) {
        if (aborted) return;
        setErrorMsg(err?.message || "Something went wrong loading this pool.");
        setPhase("error");
      }
    }

    load();
    return () => {
      aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Round lifecycle ---------- */

  function startRound(songs) {
    const song = pickSong(songs, playedIds.current, lastId.current);
    lastId.current = song.id;
    setRound({ song, guesses: [], status: "playing", startAt: pickStartOffset() });
  }

  function finishRound(won, guesses) {
    const stats = recordResult(won, guesses.length + 1);
    setStreak(stats.streak);
    setRound((r) => ({ ...r, guesses, status: won ? "won" : "lost" }));
  }

  function addAttempt(attempt) {
    setRound((r) => {
      if (!r || r.status !== "playing") return r;
      const guesses = [...r.guesses, attempt];
      if (guesses.length >= MAX_GUESSES) {
        // Out of guesses — loss. (Record outside the updater on next tick.)
        setTimeout(() => finishRoundLoss(guesses), 0);
        return { ...r, guesses, status: "lost" };
      }
      return { ...r, guesses };
    });
  }

  function finishRoundLoss(guesses) {
    const stats = recordResult(false, guesses.length);
    setStreak(stats.streak);
  }

  function handleGuess(song) {
    if (!round || round.status !== "playing") return;
    if (isCorrectGuess(song, round.song)) {
      finishRound(true, round.guesses);
    } else {
      addAttempt({ type: "wrong", label: `${song.title} — ${song.artist}` });
    }
  }

  function handleSkip() {
    if (!round || round.status !== "playing") return;
    addAttempt({ type: "skip" });
  }

  // A song whose preview won't load isn't a fair round — drop it from the pool
  // and move on to a fresh song without recording a loss, so the streak holds.
  function handleUnplayable() {
    if (!round || round.status !== "playing") return;
    const badId = round.song.id;
    const remaining = pool.songs.filter((s) => s.id !== badId);
    setPool((p) => (p ? { ...p, songs: remaining } : p));
    if (remaining.length >= 1) {
      startRound(remaining);
    } else {
      setErrorMsg("None of the songs left in this pool will play — try another pool.");
      setPhase("error");
    }
  }

  /* ---------- Render ---------- */

  if (phase === "loading") {
    return (
      <div className="page center">
        <div className="loader" aria-hidden="true" />
        <p className="load-note">{loadNote}</p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="page center">
        <p className="error-msg">{errorMsg}</p>
        <Link href="/" className="btn btn-primary">
          Pick another pool
        </Link>
      </div>
    );
  }

  const ended = round.status !== "playing";
  const unlocked = ended ? FULL_PREVIEW_SECONDS : LADDER[round.guesses.length];
  const maxSeconds = ended ? FULL_PREVIEW_SECONDS : LADDER[LADDER.length - 1];

  return (
    <div className="page game">
      <div className="game-top">
        <p className="eyebrow">
          Playing: <strong>{pool.name}</strong>
          <span className="dim"> · {pool.songs.length} songs</span>
          {resolving && <span className="dim"> · adding more…</span>}
        </p>
        <Link href="/" className="link-quiet">
          Change pool
        </Link>
      </div>

      <SnippetPlayer
        song={round.song}
        unlockedSeconds={unlocked}
        maxSeconds={maxSeconds}
        startAt={ended ? 0 : round.startAt}
        onUnplayable={handleUnplayable}
      />

      <GuessLadder guesses={round.guesses} status={round.status} />

      {!ended && (
        <GuessInput
          onGuess={handleGuess}
          onSkip={handleSkip}
          disabled={ended}
          skipText={skipLabel(round.guesses.length)}
          answer={round.song}
          localSongs={guessArtist ? pool.songs : null}
        />
      )}

      {ended && (
        <ResultCard
          won={round.status === "won"}
          song={round.song}
          guesses={round.guesses}
          streak={streak}
          onNext={() => startRound(pool.songs)}
        />
      )}
    </div>
  );
}
