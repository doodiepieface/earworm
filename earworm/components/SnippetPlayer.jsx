"use client";

import { useEffect, useRef, useState } from "react";
import { LADDER } from "@/lib/gameState";
import { loadVolume, saveVolume } from "@/lib/storage";
import EqIcon from "./EqIcon";

// Plays the first `unlockedSeconds` of a song's 30s preview.
//
// The dial draws the whole `maxSeconds` window as a disc: the unlocked
// wedge is what you've earned, the sweep is what you've heard this play,
// and the hand tracks the playhead like a tonearm. Ladder marks sit around
// the rim at each stage, so you can see the next one coming.

export default function SnippetPlayer({
  song,
  unlockedSeconds,
  maxSeconds,
  startAt = 0,
  onUnplayable,
}) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [audioError, setAudioError] = useState(false);

  // Keep the latest callback in a ref so the error effect can fire it without
  // re-running every render (the parent passes a fresh function each time).
  const onUnplayableRef = useRef(onUnplayable);
  onUnplayableRef.current = onUnplayable;

  // When a preview fails to load there's nothing to guess, so tell the parent —
  // it swaps in a playable song without ending the round (the streak is safe).
  useEffect(() => {
    if (audioError) onUnplayableRef.current?.();
  }, [audioError]);

  // Load saved volume once on mount.
  useEffect(() => {
    setVolume(loadVolume());
  }, []);

  // Reset when the song changes.
  useEffect(() => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
    startPosRef.current = null;
    setElapsed(0);
    setPlaying(false);
    setAudioError(false);
  }, [song?.id]);

  useEffect(() => {
    const a = audioRef.current;
    if (a) a.volume = volume;
  }, [volume]);

  // The media position where playback ACTUALLY began, captured on the `playing`
  // event. We measure the snippet from here, not from the intended `startAt`:
  // on mobile, seeking to an offset then calling play() can leave currentTime
  // reading slightly past the target before audio truly starts, which made a
  // tiny 0.1s snippet stop almost immediately. Anchoring to the real start
  // point means every stage plays its full length. Null until playback starts.
  const startPosRef = useRef(null);

  // Stop playback at the unlock point. The rAF loop below does this smoothly
  // while the tab is visible, but browsers pause requestAnimationFrame in a
  // backgrounded tab — so on its own it lets the whole preview play out while
  // you're tabbed away. The audio element's `timeupdate` event keeps firing
  // for playing media even when hidden, so it's the reliable backstop.
  function enforceCap() {
    const a = audioRef.current;
    const start = startPosRef.current;
    if (a && start != null && a.currentTime - start >= unlockedSeconds) {
      a.pause();
      setElapsed(unlockedSeconds);
    }
  }

  // Drive the readout and the dial from requestAnimationFrame while playing,
  // not from the audio element's `timeupdate` event. `timeupdate` only fires
  // every ~200ms, which makes the counter jump in coarse steps and lets a
  // short snippet run past its unlock point before we can stop it. A rAF loop
  // updates ~60x/second and stops within a frame (~16ms) of the target.
  useEffect(() => {
    if (!playing) return;
    let raf;
    const tick = () => {
      const a = audioRef.current;
      if (!a) return;
      const start = startPosRef.current;
      if (start == null) {
        // Audio hasn't actually started yet — wait for the `playing` event to
        // anchor the start point rather than counting from a stale currentTime.
        raf = requestAnimationFrame(tick);
        return;
      }
      const played = a.currentTime - start; // seconds heard this play
      if (played >= unlockedSeconds) {
        a.pause();
        setElapsed(unlockedSeconds); // land exactly on the target, not past it
        return; // stop scheduling; onPause will flip `playing` off
      }
      setElapsed(played);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, unlockedSeconds]);

  function togglePlay() {
    const a = audioRef.current;
    if (!a || audioError) return;
    if (playing) {
      a.pause();
      return;
    }
    startPosRef.current = null; // re-anchor when playback actually starts
    a.currentTime = startAt; // begin at this round's random offset
    a.volume = volume;
    a.play().catch(() => setAudioError(true));
  }

  function onVolumeInput(e) {
    const v = Number(e.target.value);
    setVolume(v);
    saveVolume(v);
  }

  const clampedElapsed = Math.min(elapsed, maxSeconds);
  const open = Math.min(unlockedSeconds, maxSeconds);
  const sweepDeg = (clampedElapsed / maxSeconds) * 360;
  const openDeg = (open / maxSeconds) * 360;
  const showTicks = maxSeconds <= 16; // the full 30s player has no stages left

  return (
    <div className="player card">
      <audio
        ref={audioRef}
        src={song?.previewUrl}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPlaying={() => {
          // Audio is now truly producing sound — anchor the snippet timer to
          // the real playback position so the full unlock window is heard.
          const a = audioRef.current;
          if (a && startPosRef.current == null) startPosRef.current = a.currentTime;
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={enforceCap}
        onError={() => setAudioError(true)}
      />

      <div
        className="dial"
        style={{ "--sweep": `${sweepDeg}deg`, "--open": `${openDeg}deg` }}
      >
        <div className="dial-open" />
        <div className="dial-sweep" />
        <div className="dial-grooves" />

        {showTicks &&
          LADDER.map((s) => (
            <div
              key={s}
              className={`dial-tick ${s <= unlockedSeconds ? "is-open" : ""}`}
              style={{ "--deg": `${(s / maxSeconds) * 360}deg` }}
            >
              <i />
              <b>{s}</b>
            </div>
          ))}

        <div className={`dial-hand ${playing ? "" : "is-idle"}`} />

        <button
          type="button"
          className={`play-btn ${playing ? "is-playing" : ""}`}
          onClick={togglePlay}
          disabled={audioError}
          aria-label={playing ? "Stop snippet" : "Play snippet"}
        >
          {playing ? (
            <span className="icon-stop" aria-hidden="true" />
          ) : (
            <span className="icon-play" aria-hidden="true" />
          )}
        </button>
      </div>

      <div className="player-right">
        <p className="player-readout">
          {clampedElapsed.toFixed(1)}
          <small>s</small>
        </p>
        <p className="player-caption">
          {open >= maxSeconds ? "Full preview unlocked" : `${open}s unlocked`}
        </p>

        <div className="player-vol">
          <EqIcon active={playing} />
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            onInput={onVolumeInput}
            aria-label="Volume"
          />
        </div>

        {audioError && (
          <p className="player-error">
            This preview wouldn&rsquo;t load. Skip to move on, or start a new song.
          </p>
        )}
      </div>
    </div>
  );
}
