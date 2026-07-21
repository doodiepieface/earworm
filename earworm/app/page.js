"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import packs from "@/data/packs";
import {
  setActivePool,
  loadLists,
  loadSpotifyPools,
  loadStats,
} from "@/lib/storage";
import { onSyncUpdate } from "@/lib/sync";

export default function HomePage() {
  const router = useRouter();
  const [artist, setArtist] = useState("");
  const [lists, setLists] = useState([]);
  const [spotifyPools, setSpotifyPools] = useState([]);
  const [stats, setStats] = useState(null);

  // Browser storage is only available after mount. Re-read whenever an account
  // sign-in merges new data in, so the home screen updates without a reload.
  useEffect(() => {
    const refresh = () => {
      setLists(loadLists());
      setSpotifyPools(loadSpotifyPools());
      setStats(loadStats());
    };
    refresh();
    return onSyncUpdate(refresh);
  }, []);

  function play(spec) {
    setActivePool(spec);
    router.push("/play");
  }

  function onArtistSubmit(e) {
    e.preventDefault();
    const name = artist.trim();
    if (!name) return;
    play({ type: "artist", name });
  }

  return (
    <div className="page">
      {stats && stats.played > 0 && (
        <div className="stats-strip">
          <span className="stat">
            <span className="stat-k">Played</span>
            <span className="stat-v">{stats.played}</span>
          </span>
          <span className="stat">
            <span className="stat-k">Won</span>
            <span className="stat-v">
              {Math.round((stats.wins / stats.played) * 100)}%
            </span>
          </span>
          <span className="stat">
            <span className="stat-k">Streak</span>
            <span className="stat-v">{stats.streak}</span>
          </span>
          <span className="stat">
            <span className="stat-k">Best</span>
            <span className="stat-v">{stats.maxStreak}</span>
          </span>
        </div>
      )}

      <section className="section section-first">
        <p className="eyebrow">Play by artist</p>
        <form className="artist-form" onSubmit={onArtistSubmit}>
          <input
            type="text"
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            placeholder="Any artist — try Fleetwood Mac"
            aria-label="Artist name"
          />
          <button type="submit" className="btn btn-primary" disabled={!artist.trim()}>
            Play
          </button>
        </form>
      </section>

      <section className="section">
        <p className="eyebrow">Genre packs</p>
        <div className="grid">
          {packs.map((p) => (
            <button
              key={p.id}
              type="button"
              className="card pool-card"
              onClick={() => play({ type: "pack", id: p.id })}
            >
              <span className="pool-name">{p.name}</span>
              <span className="pool-blurb">{p.blurb}</span>
              <span className="pool-count mono">{p.tracks.length} songs</span>
            </button>
          ))}
        </div>
      </section>

      <section className="section">
        <p className="eyebrow">Your lists</p>
        {lists.length === 0 ? (
          <p className="empty">
            No lists yet. <Link href="/lists">Build one</Link> by hand-picking any
            songs you want in the pool.
          </p>
        ) : (
          <div className="grid">
            {lists.map((l) => (
              <button
                key={l.id}
                type="button"
                className="card pool-card"
                onClick={() => play({ type: "list", id: l.id })}
                disabled={l.songs.length < 4}
              >
                <span className="pool-name">{l.name}</span>
                <span className="pool-count mono">
                  {l.songs.length} songs{l.songs.length < 4 ? " — add at least 4" : ""}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <p className="eyebrow">Your Spotify</p>
        {spotifyPools.length === 0 ? (
          <p className="empty">
            <Link href="/spotify">Connect Spotify</Link> to turn your playlists,
            liked songs, and top tracks into pools.
          </p>
        ) : (
          <div className="grid">
            {spotifyPools.map((p) => (
              <button
                key={p.id}
                type="button"
                className="card pool-card"
                onClick={() => play({ type: "spotify", id: p.id })}
                disabled={p.songs.length < 4}
              >
                <span className="pool-name">{p.name}</span>
                <span className="pool-count mono">{p.songs.length} playable songs</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
