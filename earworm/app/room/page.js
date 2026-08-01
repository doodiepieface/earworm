"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import packs from "@/data/packs";
import { isRoomsEnabled } from "@/lib/room";
import { makeRoomCode } from "@/lib/roomGame";
import { loadPlayerName, savePlayerName } from "@/lib/storage";

// Host-or-join. The host picks a pool here, but the room code is issued
// immediately and the pool resolves in the lobby — so friends can join and start
// adding songs while an artist catalog is still pulling.
export default function RoomEntryPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [artist, setArtist] = useState("");
  const [error, setError] = useState("");

  // Env-only check, so it's safe during SSR — no effect needed. The saved name
  // does come from localStorage, so that part stays in one.
  const enabled = isRoomsEnabled();

  useEffect(() => {
    setName(loadPlayerName());
  }, []);

  function commitName() {
    const clean = name.trim().slice(0, 20);
    if (!clean) {
      setError("Pick a name first — that's how everyone finds you on the scoreboard.");
      return null;
    }
    savePlayerName(clean);
    setError("");
    return clean;
  }

  function hostWithPack(packId) {
    if (!commitName()) return;
    router.push(`/room/${makeRoomCode()}?host=1&pack=${encodeURIComponent(packId)}`);
  }

  function hostWithArtist(e) {
    e.preventDefault();
    if (!commitName()) return;
    const a = artist.trim();
    if (!a) {
      setError("Type an artist name.");
      return;
    }
    router.push(`/room/${makeRoomCode()}?host=1&artist=${encodeURIComponent(a)}`);
  }

  function join(e) {
    e.preventDefault();
    if (!commitName()) return;
    const c = code.trim().toUpperCase();
    if (c.length !== 4) {
      setError("A room code is 4 characters.");
      return;
    }
    router.push(`/room/${c}`);
  }

  if (!enabled) {
    return (
      <div className="page center">
        <p className="error-msg">Multiplayer isn&rsquo;t available on this deployment.</p>
        <Link href="/" className="btn btn-primary">
          Back to the game
        </Link>
      </div>
    );
  }

  return (
    <div className="page room-entry">
      <header className="hero-small">
        <h1>
          Play <em>with friends</em>
        </h1>
        <p className="hero-sub">
          One person hosts, everyone else joins with the code. You all hear the
          same songs — fewest guesses wins.
        </p>
      </header>

      <label className="field">
        <span>Your name</span>
        <input
          type="text"
          value={name}
          maxLength={20}
          placeholder="What should we call you?"
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      {error && <p className="error-msg">{error}</p>}

      <section className="section">
        <p className="eyebrow">Join a room</p>
        <form className="artist-form" onSubmit={join}>
          <input
            type="text"
            className="code-input mono"
            value={code}
            maxLength={4}
            placeholder="CODE"
            autoCapitalize="characters"
            autoComplete="off"
            aria-label="Room code"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button type="submit" className="btn btn-primary">
            Join
          </button>
        </form>
      </section>

      <section className="section">
        <p className="eyebrow">Or host a superfan showdown</p>
        <p className="dim">
          Everyone picks their own artist and finds out who really knows theirs.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (!commitName()) return;
            router.push(`/room/${makeRoomCode()}?host=1&mode=superfan`);
          }}
        >
          Host superfan mode
        </button>
      </section>

      <section className="section">
        <p className="eyebrow">Or host a shared pool — pick a pack</p>
        <div className="grid">
          {packs.map((p) => (
            <button
              key={p.id}
              type="button"
              className="card pool-card"
              onClick={() => hostWithPack(p.id)}
            >
              <span className="pool-name">{p.name}</span>
              <span className="pool-blurb">{p.blurb}</span>
              <span className="pool-count mono">{p.tracks.length} songs</span>
            </button>
          ))}
        </div>
      </section>

      <section className="section">
        <p className="eyebrow">Or host with an artist</p>
        <form className="artist-form" onSubmit={hostWithArtist}>
          <input
            type="text"
            value={artist}
            placeholder="Any artist…"
            autoComplete="off"
            aria-label="Artist to host with"
            onChange={(e) => setArtist(e.target.value)}
          />
          <button type="submit" className="btn btn-ghost">
            Host
          </button>
        </form>
      </section>
    </div>
  );
}
