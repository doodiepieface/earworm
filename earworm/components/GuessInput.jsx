"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { searchGuesses } from "@/lib/itunes";

// Two ways to gather suggestions:
//   • Artist mode passes `localSongs` (that artist's pool). We filter it
//     locally — instant, no network — because the answer is always one of
//     these songs and the player already knows the artist.
//   • Every other mode searches Apple's whole catalog (`searchGuesses`), so a
//     player can guess any song. Results are cached and narrowed locally as
//     you type so it still feels snappy.
//
// Either way, once ≥4 letters of the answer's title are typed we inject the
// answer so a common title always offers the actual song.

const CACHE_MAX = 60;
const ANSWER_HINT_MIN = 4;

// Loose fold for prefix comparison: strip accents, keep letters/digits only.
// Spaces and punctuation are dropped entirely (not turned into spaces) so a
// title like "Don't" folds to "dont" — otherwise the apostrophe becomes a
// space and a player typing "dont" no longer prefix-matches "don t".
function foldTitle(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

// Same, plus accent stripping — for matching typed text against song fields.
function foldSearch(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Once 4 or more correct letters of the answer's title are typed, pin the
// answer to the TOP of the list — dropping any equivalent row the search may
// have returned so it isn't duplicated. Hoisting (rather than just ensuring
// it's present) keeps it visible as you keep typing more correct letters,
// instead of it sliding down once the catalog search starts returning it too.
function withAnswer(list, query, answer) {
  if (!answer) return list;
  const fq = foldTitle(query);
  if (fq.length < ANSWER_HINT_MIN) return list;
  const ft = foldTitle(answer.title);
  if (!ft.startsWith(fq)) return list;
  const rest = list.filter(
    (s) =>
      !(
        s.id === answer.id ||
        (foldTitle(s.title) === ft && foldTitle(s.artist) === foldTitle(answer.artist))
      )
  );
  return [answer, ...rest];
}

export default function GuessInput({ onGuess, onSkip, disabled, skipText, answer, localSongs }) {
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState([]); // catalog-mode results
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef(null);
  const reqRef = useRef(0); // ignore out-of-order responses
  const cacheRef = useRef(new Map()); // lowercased query -> songs[]

  const localMode = Array.isArray(localSongs) && localSongs.length > 0;

  // Local (artist) mode: filter the pool as you type. Recomputes as the pool
  // streams in, so more songs become guessable while you play.
  const localFiltered = useMemo(() => {
    if (!localMode) return [];
    const fq = foldSearch(q);
    if (!fq) return [];
    const tokens = fq.split(" ");
    const out = [];
    // Include the album name in the haystack so typing an album title lists
    // its tracks from the pool (e.g. "music to be murdered by").
    for (const s of localSongs) {
      const hay = foldSearch(`${s.title} ${s.artist} ${s.album || ""}`);
      if (tokens.every((t) => hay.includes(t))) {
        out.push(s);
        if (out.length >= 12) break;
      }
    }
    return out;
  }, [q, localSongs, localMode]);

  // Catalog-mode helper: filter the closest cached query for instant feedback.
  function instantFrom(query) {
    const cache = cacheRef.current;
    let bestKey = null;
    for (const key of cache.keys()) {
      if (query.startsWith(key) && (!bestKey || key.length > bestKey.length)) {
        bestKey = key;
      }
    }
    if (!bestKey) return null;
    const tokens = query.split(/\s+/).filter(Boolean);
    return cache.get(bestKey).filter((s) => {
      const hay = `${s.title} ${s.artist}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }

  function remember(query, songs) {
    const cache = cacheRef.current;
    cache.set(query, songs);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  // Catalog search (skipped entirely in local/artist mode).
  useEffect(() => {
    if (localMode) {
      setSearching(false);
      return;
    }
    const query = q.trim().toLowerCase();
    clearTimeout(debounceRef.current);
    if (!query) {
      setSuggestions([]);
      setSearching(false);
      return;
    }

    if (cacheRef.current.has(query)) {
      setSuggestions(cacheRef.current.get(query));
      setSearching(false);
      return;
    }

    const instant = instantFrom(query);
    if (instant && instant.length) {
      setSuggestions(instant);
      setSearching(false);
    } else {
      setSearching(true);
    }

    debounceRef.current = setTimeout(async () => {
      const reqId = ++reqRef.current;
      try {
        const found = await searchGuesses(query);
        remember(query, found);
        if (reqId === reqRef.current) setSuggestions(found);
      } catch {
        if (reqId === reqRef.current && !(instant && instant.length)) {
          setSuggestions([]);
        }
      } finally {
        if (reqId === reqRef.current) setSearching(false);
      }
    }, 250);

    return () => clearTimeout(debounceRef.current);
  }, [q, localMode]);

  function choose(song) {
    setQ("");
    setSuggestions([]);
    onGuess(song);
  }

  // The list actually shown: results (local or catalog) with the round's
  // answer injected once enough of its title is typed.
  const baseList = localMode ? localFiltered : suggestions;
  const displayed = withAnswer(baseList, q, answer);

  function onKeyDown(e) {
    if (e.key === "Enter" && displayed.length > 0) {
      e.preventDefault();
      choose(displayed[0]);
    }
  }

  const showList = focused && q.trim().length > 0;

  return (
    <div className="guess-area">
      <div className="guess-box">
        <input
          type="text"
          value={q}
          disabled={disabled}
          placeholder="Know it? Type any song…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-label="Guess the song"
          autoComplete="off"
        />
        {showList && (
          <ul className="suggestions" role="listbox">
            {displayed.map((s) => (
              <li key={s.id}>
                {/* onMouseDown fires before the input's blur, so the click lands */}
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(s);
                  }}
                >
                  <span className="sg-title">{s.title}</span>
                  <span className="sg-artist">{s.artist}</span>
                </button>
              </li>
            ))}
            {displayed.length === 0 && (
              <li className="sg-empty">
                {!localMode && searching ? "Searching…" : "No songs found."}
              </li>
            )}
          </ul>
        )}
      </div>
      <button type="button" className="btn btn-ghost" onClick={onSkip} disabled={disabled}>
        {skipText}
      </button>
    </div>
  );
}
