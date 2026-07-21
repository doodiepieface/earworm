"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  hasClientId,
  isConnected,
  beginLogin,
  disconnect,
  getProfile,
  getLikedSongs,
  getTopTracks,
} from "@/lib/spotify";
import {
  loadSpotifyPools,
  saveSpotifyPools,
  setActivePool,
} from "@/lib/storage";

// Turn Spotify playlists / liked songs / top tracks into playable pools.
// Spotify supplies the metadata; iTunes supplies the actual audio previews.

export default function SpotifyPage() {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const [profile, setProfile] = useState(null);
  const [pools, setPools] = useState([]);
  const [importing, setImporting] = useState(null); // { label, done, total, misses }
  const [error, setError] = useState("");
  const configured = hasClientId();

  useEffect(() => {
    setPools(loadSpotifyPools());
    if (!isConnected()) return;
    setConnected(true);
    (async () => {
      try {
        // Playlists are intentionally not fetched: Spotify withholds playlist
        // track contents from development-mode apps (see the Playlists note in
        // the render below), so there's nothing importable to list.
        const me = await getProfile();
        setProfile(me);
      } catch (err) {
        setError(err?.message || "Couldn't reach Spotify.");
        setConnected(isConnected());
      }
    })();
  }, []);

  async function importSource({ id, name, fetchTracks }) {
    setError("");
    setImporting({ label: name });
    try {
      // Only fetch the track list here (fast). Matching each song to a playable
      // preview is slow, so the play page does it progressively — you start
      // playing after the first few and the pool fills in as you go.
      const tracks = await fetchTracks();
      if (tracks.length === 0) throw new Error(`“${name}” has no importable tracks.`);

      setActivePool({ type: "stream", name, tracks, cacheId: id });
      router.push("/play");
    } catch (err) {
      setError(err?.message || "Import failed.");
      setImporting(null);
    }
  }

  function playPool(pool) {
    setActivePool({ type: "spotify", id: pool.id });
    router.push("/play");
  }

  function removePool(id) {
    const next = pools.filter((p) => p.id !== id);
    saveSpotifyPools(next);
    setPools(next);
  }

  /* ---------- Not configured yet ---------- */
  if (!configured) {
    return (
      <div className="page">
        <section className="hero-small">
          <h1>Connect Spotify</h1>
          <p className="hero-sub">One-time setup needed before this works:</p>
        </section>
        <div className="card setup-card">
          <ol className="setup-steps">
            <li>
              Create an app at <strong>developer.spotify.com/dashboard</strong>.
            </li>
            <li>
              In its settings, add this exact Redirect URI:{" "}
              <code>http://127.0.0.1:3000/callback</code>
            </li>
            <li>
              Copy the Client ID into <code>.env.local</code> as{" "}
              <code>NEXT_PUBLIC_SPOTIFY_CLIENT_ID</code>, then restart{" "}
              <code>npm run dev</code>.
            </li>
            <li>
              Open the app at <code>http://127.0.0.1:3000</code> (not localhost) so
              the addresses match.
            </li>
          </ol>
          <p className="dim">Full walkthrough in the README.</p>
        </div>
      </div>
    );
  }

  /* ---------- Configured but not connected ---------- */
  if (!connected) {
    return (
      <div className="page center">
        <section className="hero-small">
          <h1>Connect Spotify</h1>
          <p className="hero-sub">
            Earworm reads your playlists, liked songs, and top tracks to build
            song pools. It never plays audio from Spotify and can't change
            anything in your account.
          </p>
        </section>
        <button type="button" className="btn btn-primary" onClick={() => beginLogin()}>
          Connect Spotify
        </button>
        {error && <p className="error-msg">{error}</p>}
      </div>
    );
  }

  /* ---------- Connected ---------- */
  return (
    <div className="page">
      <section className="hero-small">
        <h1>Your Spotify</h1>
        <p className="hero-sub">
          {profile ? `Connected as ${profile.display_name || "you"}. ` : ""}
          Pick a source to import — matching previews takes a moment for big
          playlists.
        </p>
        <button
          type="button"
          className="link-quiet as-button"
          onClick={() => {
            disconnect();
            setConnected(false);
            setProfile(null);
          }}
        >
          Disconnect
        </button>
      </section>

      {error && <p className="error-msg">{error}</p>}

      {importing && (
        <div className="card import-card center-row">
          <span className="loader" aria-hidden="true" />
          <p>
            Fetching <strong>{importing.label}</strong>… you&rsquo;ll start playing
            in a moment, and the rest load as you go.
          </p>
        </div>
      )}

      {!importing && (
        <>
          <section className="section">
            <p className="eyebrow">Quick imports</p>
            <div className="grid">
              <button
                type="button"
                className="card pool-card"
                onClick={() =>
                  importSource({
                    id: "sp-liked",
                    name: "Liked Songs",
                    fetchTracks: () => getLikedSongs(1000),
                  })
                }
              >
                <span className="pool-name">Liked Songs</span>
                <span className="pool-blurb">Up to 1,000 of your most recent likes.</span>
              </button>
              <button
                type="button"
                className="card pool-card"
                onClick={() =>
                  importSource({
                    id: "sp-top",
                    name: "Your Top Tracks",
                    fetchTracks: () => getTopTracks(),
                  })
                }
              >
                <span className="pool-name">Your Top Tracks</span>
                <span className="pool-blurb">The 50 songs you play most.</span>
              </button>
            </div>
          </section>

          <section className="section">
            <p className="eyebrow">Playlists</p>
            <div className="card note-card">
              <p className="note-title">Playlists can&rsquo;t be imported</p>
              <p className="dim">
                Spotify no longer lets personal apps read the songs inside a
                playlist — it&rsquo;s a restriction on their end, not something
                this app can fix. Liked Songs and Top Tracks above still work,
                and you can build the same thing by hand as a{" "}
                <Link href="/lists">custom list</Link> or by playing{" "}
                <Link href="/">any artist</Link>.
              </p>
            </div>
          </section>

          {pools.length > 0 && (
            <section className="section">
              <p className="eyebrow">Already imported</p>
              <ul className="song-rows">
                {pools.map((p) => (
                  <li key={p.id} className="song-row">
                    <span className="sg-title">{p.name}</span>
                    <span className="sg-artist">
                      {p.songs.length} playable
                      {p.misses?.length ? ` · ${p.misses.length} not found` : ""}
                    </span>
                    <span className="row-actions">
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => playPool(p)}
                        disabled={p.songs.length < 4}
                      >
                        Play
                      </button>
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        onClick={() => removePool(p.id)}
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
