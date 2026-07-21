"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { searchSongs, toSong } from "@/lib/itunes";
import { loadLists, saveLists, setActivePool } from "@/lib/storage";
import { onSyncUpdate } from "@/lib/sync";

// Hand-pick exactly the songs you want in a pool. Lists live in localStorage.

export default function ListsPage() {
  const router = useRouter();
  const [lists, setLists] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [newName, setNewName] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    const refresh = () => {
      const stored = loadLists();
      setLists(stored);
      setActiveId((cur) => cur ?? stored[0]?.id ?? null);
    };
    refresh();
    // An account sign-in can merge in lists from other devices.
    return onSyncUpdate(refresh);
  }, []);

  const active = lists.find((l) => l.id === activeId) || null;

  function persist(next) {
    setLists(next);
    saveLists(next);
  }

  function createList(e) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const list = { id: `list-${Date.now()}`, name, songs: [] };
    const next = [...lists, list];
    persist(next);
    setActiveId(list.id);
    setNewName("");
  }

  function deleteList(id) {
    const next = lists.filter((l) => l.id !== id);
    persist(next);
    if (activeId === id) setActiveId(next[0]?.id ?? null);
  }

  function addSong(song) {
    if (!active) return;
    if (active.songs.some((s) => s.id === song.id)) return; // no duplicates
    persist(
      lists.map((l) =>
        l.id === active.id ? { ...l, songs: [...l.songs, song] } : l
      )
    );
  }

  function removeSong(songId) {
    persist(
      lists.map((l) =>
        l.id === active.id
          ? { ...l, songs: l.songs.filter((s) => s.id !== songId) }
          : l
      )
    );
  }

  // Debounced search-as-you-type (waits 400ms so we respect rate limits).
  function onQueryChange(e) {
    const q = e.target.value;
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const found = await searchSongs(q, { limit: 10 });
        setResults(found.map(toSong));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
  }

  function playList(list) {
    setActivePool({ type: "list", id: list.id });
    router.push("/play");
  }

  return (
    <div className="page">
      <section className="hero-small">
        <h1>My lists</h1>
        <p className="hero-sub">
          Build a pool from exactly the songs you choose. You need at least 4 to
          play — more makes guessing harder.
        </p>
      </section>

      <form className="artist-form" onSubmit={createList}>
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New list name — e.g. Road trip bangers"
          aria-label="New list name"
        />
        <button type="submit" className="btn btn-primary" disabled={!newName.trim()}>
          Create list
        </button>
      </form>

      {lists.length > 0 && (
        <div className="list-tabs">
          {lists.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`tab ${l.id === activeId ? "tab-active" : ""}`}
              onClick={() => setActiveId(l.id)}
            >
              {l.name} <span className="mono dim">{l.songs.length}</span>
            </button>
          ))}
        </div>
      )}

      {active && (
        <div className="list-editor">
          <div className="card">
            <p className="eyebrow">Add songs</p>
            <input
              type="text"
              value={query}
              onChange={onQueryChange}
              placeholder="Search any song or artist…"
              aria-label="Search songs to add"
            />
            {searching && <p className="dim">Searching…</p>}
            <ul className="song-rows">
              {results.map((s) => {
                const added = active.songs.some((x) => x.id === s.id);
                return (
                  <li key={s.id} className="song-row">
                    <span className="sg-title">{s.title}</span>
                    <span className="sg-artist">{s.artist}</span>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={added}
                      onClick={() => addSong(s)}
                    >
                      {added ? "Added" : "Add"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="card">
            <p className="eyebrow">
              In “{active.name}” ({active.songs.length})
            </p>
            {active.songs.length === 0 ? (
              <p className="empty">Nothing yet — search on the left to add songs.</p>
            ) : (
              <ul className="song-rows">
                {active.songs.map((s) => (
                  <li key={s.id} className="song-row">
                    <span className="sg-title">{s.title}</span>
                    <span className="sg-artist">{s.artist}</span>
                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      onClick={() => removeSong(s.id)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="result-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={active.songs.length < 4}
                onClick={() => playList(active)}
              >
                {active.songs.length < 4
                  ? `Add ${4 - active.songs.length} more to play`
                  : "Play this list"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => deleteList(active.id)}
              >
                Delete list
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
