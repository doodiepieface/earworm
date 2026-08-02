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

// --- The cushion, for the very short stages ---
//
// play() and pause() are the slow operations on mobile: the browser ramps audio
// in over tens of milliseconds and takes its time silencing a decoder that has
// already buffered ahead. At the 0.1s stage that ramp IS the whole snippet, so
// you hear a blip instead of music.
//
// So for short stages the transport no longer defines the snippet. Playback
// starts MUTED a little before the target, runs at full tilt through the
// audible window, and keeps running muted afterwards — only the mute flag flips
// at the boundaries, and that is instantaneous. pause() still happens, but by
// then nothing is audible, so its latency stops mattering.
//
// It has to be `muted`, not `volume`: iOS Safari makes HTMLMediaElement.volume
// read-only, so a volume ramp would work on Android and desktop and silently do
// nothing on an iPhone — the exact device this is for.
const LEAD_IN_SECONDS = 0.25; // muted run-up before the audible window
const TAIL_MS = 250; // muted run-on after it, so pause() is never the stopper
// Only the stages where start/stop latency is comparable to the snippet itself.
// Longer stages keep the original, proven path untouched.
const CUSHION_MAX_SECONDS = 2;

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
      a.muted = false; // never carry a mute across songs — that would be silence
    }
    clearTail();
    startPosRef.current = null;
    audibleStartRef.current = null;
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

  // Short stages only. Everything above CUSHION_MAX_SECONDS keeps the original
  // path, so the 30s reveal and the long stages are untouched by any of this.
  const cushioned = unlockedSeconds <= CUSHION_MAX_SECONDS;

  // The media position where the AUDIBLE window opened — i.e. where we unmuted.
  // Distinct from startPosRef, which is where the muted run-up began. The
  // snippet, the readout and the dial are all measured from here.
  const audibleStartRef = useRef(null);
  const tailTimer = useRef(null);

  function clearTail() {
    clearTimeout(tailTimer.current);
    tailTimer.current = null;
  }

  useEffect(() => clearTail, []);

  // Stop playback at the unlock point. The rAF loop below does this smoothly
  // while the tab is visible, but browsers pause requestAnimationFrame in a
  // backgrounded tab — so on its own it lets the whole preview play out while
  // you're tabbed away. The audio element's `timeupdate` event keeps firing
  // for playing media even when hidden, so it's the reliable backstop.
  function enforceCap() {
    const a = audioRef.current;
    // Measure from wherever the audible window actually opened. When cushioned
    // that's the unmute point; otherwise it's where playback began.
    const start = cushioned ? audibleStartRef.current : startPosRef.current;
    if (a && start != null && a.currentTime - start >= unlockedSeconds) {
      if (cushioned) a.muted = true; // silence first — pausing can lag
      clearTail();
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

      if (cushioned) {
        const now = a.currentTime;

        // Still in the muted run-up: nothing is audible yet, so the readout
        // stays at zero and the snippet clock hasn't started.
        if (audibleStartRef.current == null) {
          if (now < startAt) {
            raf = requestAnimationFrame(tick);
            return;
          }
          a.muted = false;
          // Anchor to where sound actually opened, not to the nominal startAt —
          // the same reason the non-cushioned path anchors on `playing`.
          audibleStartRef.current = now;
        }

        const heard = now - audibleStartRef.current;
        if (heard >= unlockedSeconds) {
          a.muted = true; // instant; this is what ends the snippet
          setElapsed(unlockedSeconds);
          // Let the element run on muted for a moment before pausing. pause()
          // is the slow call, and nothing is audible now, so its lag is free.
          if (!tailTimer.current) {
            tailTimer.current = setTimeout(() => {
              tailTimer.current = null;
              audioRef.current?.pause();
            }, TAIL_MS);
          }
          return; // stop scheduling
        }
        setElapsed(heard);
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
    // `startAt` is read inside the loop now (it's where the cushion unmutes),
    // so it belongs here or the closure could hold a stale offset.
  }, [playing, unlockedSeconds, startAt, cushioned]);

  function togglePlay() {
    const a = audioRef.current;
    if (!a || audioError) return;
    if (playing) {
      clearTail();
      a.muted = false;
      a.pause();
      return;
    }
    clearTail();
    startPosRef.current = null; // re-anchor when playback actually starts
    audibleStartRef.current = null;

    // Back up before the target so the device is at full speed by the time the
    // audible window opens. Clamped at the start of the preview — if there's no
    // room for a run-up, the tail cushion still does its half of the job.
    const lead = cushioned ? Math.min(LEAD_IN_SECONDS, startAt) : 0;
    a.currentTime = Math.max(0, startAt - lead);
    // Set explicitly every time, so a mute can never leak into a later stage.
    a.muted = cushioned;
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
