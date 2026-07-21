# CLAUDE.md — Earworm project handoff

## What this is

A Songless/Heardle-style guess-the-song web game. Play a snippet, guess the track; each wrong guess or skip unlocks a longer snippet. Pools come from curated genre packs, artist search, hand-built custom lists, or an imported Spotify library.

## Current state — important

**This codebase was generated in one pass by Claude (chat) in a sandbox with no network access. It has NEVER been run, built, or tested.** `npm install` and `npm run dev` have not been executed. Assume there may be small bugs — treat "get it running cleanly" as the implicit first task. The owner has already run `npm install` locally at least once.

The owner is comfortable with coding basics but not an expert: explain changes in plain terms, avoid introducing heavy tooling (TypeScript, Tailwind, test frameworks) unless asked.

## Commands

- `npm install` — only deps are next ^15.1.0, react ^19, react-dom ^19. Nothing else, on purpose.
- `npm run dev` — then open **http://127.0.0.1:3000** (must be 127.0.0.1, NOT localhost — Spotify's redirect-URI rules only allow the loopback IP, and localStorage/origin differ between the two hostnames).
- No test suite exists.

## Architecture — the one decision that explains everything

Spotify removed 30-second preview URLs from its Web API (Nov 2024). Therefore:

- **All audio comes from Apple's iTunes Search API** — free 30s previews, no auth.
- **Spotify (optional login) supplies metadata only** (playlist/liked/top track titles + artists), which get fuzzy-matched against iTunes to find playable previews.
- The iTunes API has **no CORS headers**, so the browser never calls it directly — everything goes through the server proxy at `app/api/itunes/route.js` (in-memory cache, 30-min TTL). Do not bypass this proxy from client code.
- iTunes throttles aggressively and the real ceiling isn't published. Bulk matching (`resolveTracks` in `lib/itunes.js`) is deliberately sequential with **adaptive** pacing: starts at 400ms, doubles on every throttled response (max 8s), eases back 20% on success. Don't parallelize it.
- A throttled response must never be recorded as "this song has no preview" — the proxy flags it with `throttled: true`, `searchSongs` raises `ThrottledError`, and `resolveTracks` retries up to 3x. Misses are cached permanently, so conflating the two silently poisons the cache.

## Explicit versions are not available — don't retry this

Every preview the iTunes Search API returns is clean. Verified July 2026 across Drake/21 Savage, Kendrick Lamar, Travis Scott, Eminem: results are only ever `trackExplicitness: "cleaned"` or `"notExplicit"`, never `"explicit"`. Specifically:

- The documented `explicit=Yes` parameter is a **no-op** on `/search` — byte-identical results with and without it.
- It isn't a search-ranking issue. The album entries are `collectionExplicitness: "cleaned"`, and `/lookup?id=<collectionId>&entity=song` returns the clean edition track for track.

So "match the explicit/clean version the player has in Spotify" is not implementable, and neither is defaulting artist searches to explicit. Spotify's `track.explicit` flag is real and could be captured in `trackToEntry`, but there is nothing on the iTunes side to match it against.

## Stack & conventions

- Next.js 15 App Router, **plain JavaScript** (no TS), **hand-rolled CSS** in `app/globals.css` (no Tailwind). Path alias `@/*` → project root (jsconfig.json).
- All pages are client components; all browser-storage access is wrapped in `lib/storage.js` and only touched in effects/handlers (SSR-safe).
- Design system ("late-night FM"): tokens at the top of `globals.css` — bg `#141322`, amber accent `#FFB454`, coral `#F26D5B` (wrong), green `#5FD68B` (win). Fonts via next/font/google: Bricolage Grotesque (display), Instrument Sans (body), Space Mono (mono). Keep new UI inside this system.

## File map

- `lib/gameState.js` — `LADDER = [1,2,4,7,11,16]`, `MAX_GUESSES = 6`, share-text builder, random song picker (avoids recents).
- `lib/itunes.js` — client search via proxy, `normalize()`/fuzzy matching, `findPreview()` (localStorage cache `earworm-match-cache-v2`, `"miss"` sentinel = known-unmatchable), `resolveTracks()` (bulk, sequential, progress callback), `buildArtistPool()`. **Bump the cache version whenever matching rules change**, or old `"miss"` entries hide the improvement.
  - `artistsMatch()` compares performer-by-performer: Spotify joins every credit with `", "` while iTunes uses `" & "` and often lists only the lead, so comparing joined strings fails on every collaboration.
  - `pickBest()`/`versionPenalty()` rank candidates because `normalize()` strips parentheses — without it `"(Instrumental)"` and `"(Karaoke)"` match perfectly and then play the wrong audio.
  - **Artist mode** is `streamArtistPool()`, not a single search. The search endpoint caps at 200 results (~120 after dedupe), so for a deep catalog it grabs the artist id from the first search, then walks their albums via the **Lookup** API (`/api/itunes?id=...&entity=album` then `&entity=song`), emitting songs through `onSong` as it goes. Albums are deduped by title keeping the highest `trackCount` (deluxe over standard), capped at `MAX_ALBUMS`. The proxy supports both Search (`?term=`) and Lookup (`?id=`) modes and no longer filters to `kind==="song"` — callers filter by `previewUrl`.
- `lib/spotify.js` — PKCE auth (token exchange happens in-browser; Spotify's token endpoint allows CORS), token refresh, 429 Retry-After handling, library fetchers. Scopes: user-library-read, playlist-read-private, playlist-read-collaborative, user-top-read.
  - **Playlist import is disabled — Spotify blocks playlist track contents for development-mode apps, with no workaround.** Verified July 2026 on the owner's own public *and* private playlists after a clean reconnect: `/playlists/{id}/tracks` → bare `403 {"message":"Forbidden"}` (note: *not* "Insufficient client scope" — an access-tier block, not scope/redirect/hosting), and `GET /playlists/{id}` returns 200 but with the entire `tracks` field **stripped from the response** (`d.tracks` is undefined). `/me/playlists` still returns playlist *names* but with no `tracks.total`. So names are readable; contents are not, by any endpoint. The Spotify page shows an explanatory note instead of playlist cards. `getPlaylists`/`getPlaylistTracks` remain in `lib/spotify.js` (unused) documenting the dead ends in case Spotify ever grants extended access. Liked Songs (`/me/tracks`) and Top Tracks (`/me/top/tracks`) are `/me/*` endpoints and still work fully.
- `lib/storage.js` — every localStorage/sessionStorage key lives here. Active pool spec is in **sessionStorage** (`earworm-active-pool`); stats, lists, spotify pools, pack caches, volume in localStorage (all keys prefixed `earworm-`). `write()` fires an optional `syncHook` after every save — that's the single seam the account layer hooks into.
- `lib/supabase.js` + `lib/sync.js` + `components/AuthButton.jsx` — **optional accounts** (Google sign-in via Supabase; Apple-ready — add `"apple"` to `AUTH_PROVIDERS` and enable it in Supabase). Entirely opt-in: with no `NEXT_PUBLIC_SUPABASE_*` env vars, `isAuthConfigured()` is false, `AuthButton` renders nothing, and the app is unchanged (local-first). When signed in, only three keys sync (spotify pools, lists, stats) to a Supabase `user_data(user_id, key, value jsonb)` table with row-level security. `mergeOnLogin` reconciles local+remote (union by `id` for pools/lists, higher `played` wins for stats) then dispatches `earworm:synced` so the home/lists pages re-read. **Spotify OAuth tokens never sync** — they're written straight to localStorage in `spotify.js`, bypassing `storage.js`'s `write()` hook. Setup steps are in the README.
- `app/play/page.js` — resolves the active pool spec by type (`resolved | stream | pack | artist | list | spotify`), runs rounds. Min pool size = 4.
  - **Streaming sources** — Spotify imports (`type: "stream"`, raw `{id,title,artist}` tracks + `cacheId`, resolved via `resolveTracks`) and **artist mode** (`type: "artist"`, via `streamArtistPool`) share one `streamSink(name)` helper. Both start the game at `STREAM_START_AT` (8) songs, then append each new one to the live `pool.songs` so the pool grows *while you play*; a "· adding more…" hint shows during resolution. Artist mode has no `cacheId`, so it isn't persisted. On completion it caches the result to `saveSpotifyPools` under `cacheId` (instant replay + appears on home/Spotify). This is why import feels instant — the slow iTunes matching moved here from the Spotify page.
  - **Abort on unmount:** the load effect uses a local `aborted` closure flag flipped in cleanup (not the old `startedRef`), passed to `resolveTracks` as `isAborted`. Leaving the page (or React StrictMode's double-mount) stops resolution cleanly instead of matching songs for an abandoned pool. All state-sets after an `await` are guarded by `if (aborted) return`.
- `app/spotify/page.js` — connect + import UI. Import only *fetches* the track list (fast) then hands it to the play page as a `stream` pool; matching happens there. Caps: 1000 liked songs, 50 top tracks. (Playlists disabled — see spotify.js note.)
- `app/callback/page.js` — reads `?code` via `window.location` (deliberately avoids `useSearchParams` → no Suspense boundary needed); `ranRef` guard because the auth code is single-use.
- `components/SnippetPlayer.jsx` — the signature UI (the dial). A `requestAnimationFrame` loop (gated on `playing`) reads `audio.currentTime` ~60x/sec to update the readout + dial and to pause the moment `currentTime >= unlockedSeconds` — stops within ~16ms, so even the 1s snippet lands clean. Do **not** move the stop back onto the audio `timeupdate` event: it fires only every ~200ms, which made the counter choppy and overshot short snippets. After a round ends the parent passes 30s to unlock the full preview.
- `components/GuessInput.jsx` — suggestions come from a **debounced (250ms) search of the whole iTunes catalog** (`searchGuesses`), not the pool — so a player can guess any song, like real Heardle, and the pool is never revealed. Players still pick a suggestion (no raw free text). Three refinements worth preserving:
  - **Client cache + prefix narrowing:** results are cached per query (`cacheRef`) and, while typing, the closest cached prefix is filtered locally for instant feedback before the network refines — this is what keeps it from feeling laggy.
  - **Answer injection:** once ≥4 letters of the answer's title are typed, `withAnswer` guarantees the round's answer is in the list (passed via `answer={round.song}`). Common titles ("Make It Back") otherwise return many songs and the actual answer may not appear.
  - **Artist mode is local, not catalog:** the play page passes `localSongs={pool.songs}` for artist pools, and GuessInput filters that pool locally (instant, no network) — the answer is always one of the artist's songs and the player knows the artist. Every other pool type passes no `localSongs` and uses the catalog search. (`searchGuesses` still accepts an unused `artist` scope option in case catalog scoping is wanted again.)
- `data/packs.js` — curated packs as title+artist only; previews resolve on first play and cache per pack (`earworm-pack-<id>`). Adding a pack = just append here.

## Song identity rules (guess correctness depends on this)

- iTunes-sourced songs get id `it-<trackId>`; Spotify-sourced keep `sp-<spotifyId>` even after matching (see `resolveTracks` — it preserves the caller's id). Because guesses now come from the whole catalog (different ids than the pool), correctness is **`isCorrectGuess(guess, answer)` in `lib/itunes.js`**: an id match is an instant yes, otherwise it accepts any recording whose `normalize()`d title is identical *and* whose artist passes `artistsMatch` — so a different album/version of the right song counts, but a same-titled cover by someone else doesn't. All pool songs carry iTunes `title`/`artist` (even Spotify-sourced ones, from the match), so answers are always reachable by a catalog search.

## Spotify setup (if debugging auth)

Dashboard app must have Redirect URI **exactly** `http://127.0.0.1:3000/callback` (dev). Client ID goes in `.env.local` as `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` (see `.env.local.example`); restart dev server after changing it. New Spotify apps are in development mode — testers must be allowlisted under User Management. Tokens live in localStorage `earworm-spotify-tokens`.

## Untested / most-likely-buggy areas (prioritize when issues appear)

1. The full Spotify PKCE round-trip (login → callback → token exchange → refresh).
2. `resolveTracks` progress UI + pacing on large playlists.
3. SnippetPlayer edge cases: preview URL 404s, rapid song changes, replay after round end.
4. CSS details across browsers/mobile — written blind, never rendered.

## Legal footnote

Apple previews must be streamed (they are — plain `<audio>` src), not downloaded/cached as files. Keep the footer attribution. Fine for personal use; add "View on Apple Music" links before any public launch.
