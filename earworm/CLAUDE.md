# CLAUDE.md — Earworm project handoff

## What this is

A Songless/Heardle-style guess-the-song web game. Play a snippet, guess the track; each wrong guess or skip unlocks a longer snippet. Pools come from curated genre packs, artist search, hand-built custom lists, or an imported Spotify library.

## Current state — important

**Live in production** at **https://www.earwormgame.net** (custom domain via Cloudflare DNS → Vercel; GitHub repo `doodiepieface/earworm`, deploys on push to `main`). The app has been run, built, deployed, and played. The original "never been run" caveat no longer applies.

The owner is comfortable with coding basics but not an expert: explain changes in plain terms, avoid introducing heavy tooling (TypeScript, Tailwind, test frameworks) unless asked.

**No browser/build is run during most edits.** There's no automated test suite, and building while `npm run dev` is running corrupts `.next` — so logic changes are typically verified with throwaway Node scripts against the live iTunes API (matching, dedupe, guess correctness, etc.) rather than in-app. Prefer that pattern.

**Working style:** the owner has connected the Vercel + Cloudflare (+ Supabase) MCP servers and asked that env-var and domain/DNS tasks be done directly through those tools rather than handed back as manual dashboard steps. MCP tools only load after a session reload once authorized.

## Commands

- `npm install` — deps are deliberately minimal: next ^15, react ^19, react-dom ^19, `@supabase/supabase-js` (optional accounts), `@vercel/analytics` (web analytics). No CSS/test/TS tooling, on purpose.
- `npm run dev` — then open **http://127.0.0.1:3000** (must be 127.0.0.1, NOT localhost — Spotify's redirect-URI rules only allow the loopback IP, and localStorage/origin differ between the two hostnames).
- **Do NOT run `npm run build` while `npm run dev` is running** — they share `.next` and it breaks the dev server.
- No test suite exists (see the verification note above).

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
- Design system ("Nocturne" — violet jewel tones, soft depth): tokens at the top of `globals.css` — bg `#0c0a12`, surfaces `#16131f`/`#1f1a2b`, ink `#f3eef9`, muted `#9c95ad`, accent `#a98bff` (periwinkle), win `#5ee6a8`, wrong `#ff6b6b`, and a `--spectrum` gradient used on the dial. Fonts via next/font/google: **Fraunces** (display serif — carries the personality), **Manrope** (body), **JetBrains Mono** (counters/labels). Keep new UI inside this system. (This replaced an earlier flat "late-night FM" amber theme.)

## File map

- `lib/gameState.js` — `LADDER = [0.1, 0.5, 2, 4, 8, 15]` (seconds unlocked per stage), `MAX_GUESSES = 6`, `FULL_PREVIEW_SECONDS = 30`, `MAX_STAGE_SECONDS` (the last ladder step), share-text builder.
  - **`pickSong` is a shuffle-bag, not "avoid recents":** it takes a mutable `playedIds` Set + `lastId` and guarantees no song repeats until the whole pool has been played once, then reshuffles (avoiding an immediate repeat across the seam). Songs that stream in mid-game join the current cycle as eligible picks. The play page owns the `playedIds`/`lastId` refs.
  - **`pickStartOffset()`** returns a random start point in the first `FULL_PREVIEW_SECONDS − MAX_STAGE_SECONDS` seconds (i.e. first 15s), so each round starts the clip at a different spot while still leaving room for the longest stage to play in full. The play page stores it per-round as `round.startAt` (0 for the post-round full reveal).
- `lib/itunes.js` — client search via proxy, `normalize()`/fuzzy matching, `findPreview()` (localStorage cache `earworm-match-cache-v2`, `"miss"` sentinel = known-unmatchable), `resolveTracks()` (bulk, sequential, progress callback), `streamArtistPool()` (artist mode — see below), `searchGuesses()`/`isCorrectGuess()` (the guess box + correctness). **Bump the cache version whenever matching rules change**, or old `"miss"` entries hide the improvement.
  - `artistsMatch()` compares performer-by-performer: Spotify joins every credit with `", "` while iTunes uses `" & "` and often lists only the lead, so comparing joined strings fails on every collaboration.
  - `pickBest()`/`versionPenalty()` rank candidates because `normalize()` strips parentheses — without it `"(Instrumental)"` and `"(Karaoke)"` match perfectly and then play the wrong audio.
  - `toSong()` carries `album` (collectionName) and `appleUrl` (the iTunes `trackViewUrl`, passed through by the proxy) in addition to title/artist/previewUrl/artwork. `album` powers album-name guessing; `appleUrl` powers the "Listen on Apple Music" link.
  - **Artist mode** is `streamArtistPool()`, not a single search. The search endpoint caps at 200 results (~120 after dedupe), so for a deep catalog it grabs the artist id from the first search, then walks their albums via the **Lookup** API (`/api/itunes?id=...&entity=album` then `&entity=song`), emitting songs through `onSong` as it goes. Albums are deduped by title keeping the highest `trackCount` (deluxe over standard), capped at `MAX_ALBUMS`. The proxy supports both Search (`?term=`) and Lookup (`?id=`) modes and no longer filters to `kind==="song"` — callers filter by `previewUrl`.
  - **Featured tracks are included:** after the primary (`artistTerm`) search, a second general `term=<artist>` search surfaces songs where the artist is only a *featured* guest (credited to the lead artist, so an artist-field search misses them). `featuredArtists()` parses "(feat. …)"/"[ft. …]"/"featuring …" out of titles and `trackByArtist()` accepts a track if the artist leads it OR is a named guest. Coverage is best-effort — iTunes has no "appears on" endpoint, so only what that 200-result search returns.
  - **Skit/interlude filter (`isSkit`):** deep catalog walks pull intros/skits/interludes. Many aren't labelled, so the filter is a duration floor (`MIN_SONG_MS = 70000`, ~70s) plus a `\bskit\b` name check. Applied in `streamArtistPool` and in album-expansion guesses.
- `lib/spotify.js` — PKCE auth (token exchange happens in-browser; Spotify's token endpoint allows CORS), token refresh, 429 Retry-After handling, library fetchers. Scopes: user-library-read, playlist-read-private, playlist-read-collaborative, user-top-read. Sends a random `state` on login and verifies it in `handleCallback` (CSRF protection) — keep both halves in sync (`beginLogin` sets `STATE_KEY`, the callback passes `?state` back to verify). Don't drop it.
  - **Playlist import is disabled — Spotify blocks playlist track contents for development-mode apps, with no workaround.** Verified July 2026 on the owner's own public *and* private playlists after a clean reconnect: `/playlists/{id}/tracks` → bare `403 {"message":"Forbidden"}` (note: *not* "Insufficient client scope" — an access-tier block, not scope/redirect/hosting), and `GET /playlists/{id}` returns 200 but with the entire `tracks` field **stripped from the response** (`d.tracks` is undefined). `/me/playlists` still returns playlist *names* but with no `tracks.total`. So names are readable; contents are not, by any endpoint. The Spotify page shows an explanatory note instead of playlist cards. `getPlaylists`/`getPlaylistTracks` remain in `lib/spotify.js` (unused) documenting the dead ends in case Spotify ever grants extended access. Liked Songs (`/me/tracks`) and Top Tracks (`/me/top/tracks`) are `/me/*` endpoints and still work fully.
- `lib/storage.js` — every localStorage/sessionStorage key lives here. Active pool spec is in **sessionStorage** (`earworm-active-pool`); stats, lists, spotify pools, pack caches, volume, plus the multiplayer keys (`earworm-player-name`, `earworm-player-id`, `earworm-room-history`) in localStorage (all keys prefixed `earworm-`). `write()` fires an optional `syncHook` after every save — that's the single seam the account layer hooks into.
- `lib/supabase.js` + `lib/sync.js` + `components/AuthButton.jsx` — **optional accounts** (Google sign-in via Supabase; Apple-ready — add `"apple"` to `AUTH_PROVIDERS` and enable it in Supabase). Entirely opt-in: with no `NEXT_PUBLIC_SUPABASE_*` env vars, `isAuthConfigured()` is false, `AuthButton` renders nothing, and the app is unchanged (local-first). When signed in, only four keys sync (spotify pools, lists, stats, room history) to a Supabase `user_data(user_id, key, value jsonb)` table with row-level security. `mergeOnLogin` reconciles local+remote (union by `id` for pools/lists, higher `played` wins for stats, union by `code+endedAt` for room history) then dispatches `earworm:synced` so the home/lists pages re-read. **Room history needs its own merge branch** — its entries have no `id`, so `mergeById` would silently drop every row. **Spotify OAuth tokens never sync** — they're written straight to localStorage in `spotify.js`, bypassing `storage.js`'s `write()` hook. Setup steps are in the README.
- `app/play/page.js` — resolves the active pool spec by type (`resolved | stream | pack | artist | list | spotify`), runs rounds. Min pool size = 4.
  - **Streaming sources** — Spotify imports (`type: "stream"`, raw `{id,title,artist}` tracks + `cacheId`, resolved via `resolveTracks`) and **artist mode** (`type: "artist"`, via `streamArtistPool`) share one `streamSink(name)` helper. Both start the game at `STREAM_START_AT` (8) songs, then append each new one to the live `pool.songs` so the pool grows *while you play*; a "· adding more…" hint shows during resolution. Artist mode has no `cacheId`, so it isn't persisted. On completion it caches the result to `saveSpotifyPools` under `cacheId` (instant replay + appears on home/Spotify). This is why import feels instant — the slow iTunes matching moved here from the Spotify page.
  - **Abort on unmount:** the load effect uses a local `aborted` closure flag flipped in cleanup (not the old `startedRef`), passed to `resolveTracks` as `isAborted`. Leaving the page (or React StrictMode's double-mount) stops resolution cleanly instead of matching songs for an abandoned pool. All state-sets after an `await` are guarded by `if (aborted) return`.
  - **Round selection:** owns the shuffle-bag state (`playedIds` Set + `lastId` refs) passed to `pickSong`, and stamps each round with a random `round.startAt` from `pickStartOffset()`. `SnippetPlayer` gets `startAt={ended ? 0 : round.startAt}`.
  - **Unplayable previews don't cost the streak:** `SnippetPlayer` reports load failures via `onUnplayable`; `handleUnplayable` drops the dead song from the live pool and starts a fresh round **without recording a result**, so the streak holds. It self-heals (each failure removes one song) and shows a "try another pool" error only if the pool empties.
- `app/spotify/page.js` — connect + import UI. Import only *fetches* the track list (fast) then hands it to the play page as a `stream` pool; matching happens there. Caps: 1000 liked songs, 50 top tracks. (Playlists disabled — see spotify.js note.)
- `app/callback/page.js` — reads `?code` via `window.location` (deliberately avoids `useSearchParams` → no Suspense boundary needed); `ranRef` guard because the auth code is single-use.
- `components/SnippetPlayer.jsx` — the signature UI (the dial). Plays `unlockedSeconds` starting at `startAt` (the round's random offset); after a round ends the parent passes 30s and `startAt=0` to unlock the full preview from the start. Three timing subtleties, each fixing a real bug — keep them:
  - **Anchor to real playback start, not `startAt`.** On mobile, seeking to an offset then `play()` can leave `currentTime` reading *past* the target before audio truly starts, which made a 0.1s snippet stop almost immediately. So it captures `startPosRef` on the audio's **`playing`** event (when sound actually begins) and measures `played = currentTime − startPosRef`. Don't go back to measuring from `startAt`.
  - **`requestAnimationFrame`** loop (gated on `playing`) drives the readout + dial ~60x/sec and stops within ~16ms of the target while the tab is visible.
  - **`timeupdate` is the background backstop** — browsers pause rAF in a hidden tab, so without this a backgrounded tab plays the whole preview. `enforceCap` (on `timeupdate`, which keeps firing for playing media when hidden) stops at the cap too. Both use the `startPosRef` anchor. (This reverses the old "never use timeupdate" note — it's now a deliberate second layer, not the primary timer.)
  - **`onUnplayable`** fires (once per failed track, via a ref) when the audio errors, so the parent can swap the song without ending the round.
- `components/GuessInput.jsx` — suggestions come from a **debounced (250ms) search of the whole iTunes catalog** (`searchGuesses`), not the pool — so a player can guess any song, like real Heardle, and the pool is never revealed. Players still pick a suggestion (no raw free text). Three refinements worth preserving:
  - **Client cache + prefix narrowing:** results are cached per query (`cacheRef`) and, while typing, the closest cached prefix is filtered locally for instant feedback before the network refines — this is what keeps it from feeling laggy.
  - **Answer injection (pinned to top):** once ≥4 correct letters of the answer's title are typed, `withAnswer` hoists the round's answer to the **top** of the list (passed via `answer={round.song}`), removing any duplicate the search returned. Hoisting (not just "ensure present") keeps it visible as you keep typing. `foldTitle` strips punctuation/accents entirely (so "Don't"→"dont", "Café"→"cafe") — an earlier version turned the apostrophe into a space and broke the prefix match when players typed "dont".
  - **Album-name guessing:** typing an album title lists that album's tracks. In artist mode this is free (each song carries `album`, added to the local filter haystack). In catalog mode, `searchGuesses` calls `albumIdForQuery` — if the typed text matches a collection name already present in the song results, it pulls that album's full track list with one extra Lookup (up to 24 rows). A normal title query matches no album name, so it costs nothing. Correctness is unaffected: `isCorrectGuess` still judges the *selected* song, and `withAnswer` still pins the real answer on top — so an album that shares a name with the answer's title can't break scoring.
  - **Artist mode is local, not catalog:** the play page passes `localSongs={pool.songs}` for artist pools, and GuessInput filters that pool locally (instant, no network) — the answer is always one of the artist's songs and the player knows the artist. Every other pool type passes no `localSongs` and uses the catalog search. (`searchGuesses` still accepts an unused `artist` scope option in case catalog scoping is wanted again.)
- `data/packs.js` — curated packs as title+artist only; previews resolve on first play and cache per pack (`earworm-pack-<id>`). Adding a pack = just append here. Current packs: **2020s Hits** (newest, listed first), 2010s Pop Hits, Classic Rock, 90s & 2000s Hip-Hop/R&B, 80s Hits. When adding tracks, verify each resolves against the live iTunes API first (recent titles have quirky naming — "drivers license", "INDUSTRY BABY", "abcdefu").
- `components/ResultCard.jsx` — end-of-round card: verdict, song, streak, "Next song", and a **"Listen on Apple Music ↗"** link (only when `song.appleUrl` exists), run through `withAppleAffiliate`. The old "Copy result" share button was removed.
- `components/SpotifyNavLink.jsx` — renders the nav "Spotify" link **only if this browser has connected** (`isConnected()`). See the Spotify-UI-gating section below.
- `lib/site.js` — site identity + config used by metadata, sitemap, robots, and social cards: `SITE_URL` (defaults to `https://www.earwormgame.net`, override with `NEXT_PUBLIC_SITE_URL`), name/tagline/description/keywords, `withAppleAffiliate(url)` (appends the affiliate `at`/`ct` tokens when `NEXT_PUBLIC_APPLE_AFFILIATE_TOKEN` is set, else returns the plain link), and `BUYMEACOFFEE_URL` (defaults to the project's page, override/hide with `NEXT_PUBLIC_BUYMEACOFFEE`).

## Song identity rules (guess correctness depends on this)

- iTunes-sourced songs get id `it-<trackId>`; Spotify-sourced keep `sp-<spotifyId>` even after matching (see `resolveTracks` — it preserves the caller's id). Because guesses now come from the whole catalog (different ids than the pool), correctness is **`isCorrectGuess(guess, answer)` in `lib/itunes.js`**: an id match is an instant yes, otherwise it accepts any recording whose `normalize()`d title is identical *and* whose artist passes `artistsMatch` — so a different album/version of the right song counts, but a same-titled cover by someone else doesn't. All pool songs carry iTunes `title`/`artist` (even Spotify-sourced ones, from the match), so answers are always reachable by a catalog search.

## Multiplayer rooms

Live rooms at `/room` (host or join) and `/room/[code]` (lobby + game). Design and plan docs live in `docs/superpowers/` at the repo root.

- **No server, no tables.** A room is a Supabase Realtime channel named `room:<CODE>` — presence carries the roster, broadcast carries the game. Nothing is persisted server-side; close every tab and the room is gone. There's no migration, no RLS, and no cleanup job to maintain.
- **The host's browser IS the server.** It owns the pool, builds the round list, picks each song, collects results, and computes every score. Everyone else is a thin client. **If the host closes the tab, the room ends** — there is deliberately no host migration.
- **Requires the Supabase env vars.** `isRoomsEnabled()` is just `isAuthConfigured()`, and every entry point (home CTA, `/room`) hides itself when it's false — same gating pattern as `SpotifyNavLink`.
- **`lib/room.js` clears stale channels before joining.** Supabase returns the *same* channel object for a repeated topic and throws if listeners are added after `subscribe()`. Without the cleanup, React StrictMode's double-mount crashes the lobby on every dev load. Don't remove it.
- **`lib/roomGame.js` is pure** (codes, scoring, round list, standings, history merge) so it can be checked with a throwaway Node script. It and `lib/room.js` use **explicit `.js` import extensions** — unlike the rest of the codebase — because plain `node` won't resolve the extensionless form and being node-runnable is the point.
- **The pool list is never rendered — only a count.** Guess suggestions come from the whole catalog precisely so the pool stays secret; showing 25 lobby titles would put every answer on screen. Players see only their own additions.
- **Contributions are lobby-only**, 10 per player, capped host-side as well as in the sender's UI, deduped by id and normalized title+artist. No undo — an `add` is already folded into the host's pool by the time it renders.
- **Round list is half contributions, half host pool**, interleaved so the adds spread across the game instead of front-loading. A song never repeats within a game; a short pool just makes a short game.
- **Scoring is `7 − N`** (6 for a first-guess win, 1 for the sixth), 0 for a loss or timeout, ties broken on lower total time. **Your own contributed song scores you 0** and is revealed as "Sam's pick" only *after* the round closes.
- **The 60s round cap is counted per client from its own receipt** of the `round` broadcast, so clock skew between phones can't shave anyone's timer. The host runs its own copy so an AFK player can't stall the room.
- **No anti-cheat, deliberately.** Every client must know the answer to run `isCorrectGuess`, and each self-reports. Fine among friends; the alternative is server-side answer checking, which fights the app's entirely-client-side architecture.
- `components/RoundBoard.jsx` is the shared single-round UI (dial + ladder + guess box), used by **both** `/play` and rooms so the rules can't drift. `app/play/page.js` keeps pool loading, the shuffle bag, and stats.
- **`lib/roomHost.js` is the host-authority engine** — React-free, Supabase-free, DOM-free. It owns the pool, round list, results, and scoring for *both* room modes and returns **directives** (`{ event, payload }`) that the page relays verbatim via `conn.send`. Round and scoring logic belongs here, not in the page: it's the only part that can be driven end-to-end by a plain Node script.
- `components/RoundTimer.jsx` draws the round countdown but does **not** enforce it — the page still owns the authoritative cap timer and settles via `RoundBoard`'s `forceEnd`. Both anchor on the same round mount (RoundBoard is keyed per round), which is why the bar and the cutoff agree. It renders only when `capMs > 0`, so solo play never shows one.

### Superfan mode

A second room mode (`/room/<CODE>?host=1&mode=superfan`) where every player claims **their own artist**.

- **Two phases.** `splitPhases(rounds)` gives roughly two thirds **mastery** (each player hears songs from their own artist, simultaneously but separately) and one third **crossover** (everyone on the same song, drawn round-robin from the claimed artists). Finale is never under 2 rounds, mastery never under 1.
- **Mastery rounds carry no song over the wire.** The host broadcasts only `mastery { index, capMs }`; each client picks its own next song locally from its own pool via the existing shuffle bag. This makes mastery rounds *more* private than shared-mode rounds — those songs are never broadcast at all. Crossover songs are broadcast and so are visible in devtools, same no-anti-cheat posture as everywhere else.
- **Crossover scoring — the owner defends, outsiders steal.** The owner scores the normal `7 − N`. A non-owner who won with *strictly fewer* guesses than the owner (or when the owner missed) scores **double**. Ties don't steal. An owner who left the room counts as a miss, so everyone can steal — the round still plays rather than being dropped, because splicing the list would break the `totalRounds` clients already received.
- **One claim per artist.** Shared ownership would make "the owner" of a crossover round ambiguous.
- **`MIN_SUPERFAN_POOL = 15` is not arbitrary:** the longest game (20 rounds) is 13 mastery rounds, and a smaller pool would exhaust the shuffle bag and repeat songs inside one game.
- **Depth (`DEPTH_CAPS`: hits 25 / standard 60 / deep ∞) is one room-wide setting**, and it is doing two jobs. Fairness — an equal cap keeps a 30-song artist comparable to a 400-song one. And throughput — it's passed as `streamArtistPool`'s `isAborted`, so a Hits game stops after roughly the first search instead of walking a whole discography. Every player resolves their own artist in their own browser; without the cap, five simultaneous deep walks through the single shared iTunes proxy would crawl.

## SEO & metadata

Driven from `lib/site.js`. App Router auto-detects these files — don't hand-wire `<link>`/`<meta>`:
- `app/layout.js` — `metadata` (title template, description, keywords, canonical, Open Graph, Twitter) + a JSON-LD `VideoGame` `<script>` (static object, safe use of `dangerouslySetInnerHTML`).
- `app/opengraph-image.js` — generates the 1200×630 social card via `next/og` `ImageResponse` (runs at build; if it ever errors, the Vercel build fails).
- `app/icon.svg` — the vinyl-record favicon (auto-wired by App Router).
- `app/robots.js` + `app/sitemap.js` — `/robots.txt` and `/sitemap.xml` (home, /lists, /spotify; disallows /callback).
- `app/page.js` — a real crawlable `<h1>` + intro (client component, but SSR'd into initial HTML). The homepage previously had no heading, which is fatal for SEO.

Honest expectation: the site is indexed and metadata renders correctly, but ranking for competitive terms ("song guessing game") needs authority/backlinks/time; there's also a brand collision with a Steam game named "EarWorm." Off-page work (Search Console, backlinks) is the lever, not more tags.

## Monetization

- **Apple Music affiliate** — `withAppleAffiliate` tags the "Listen on Apple Music" link when `NEXT_PUBLIC_APPLE_AFFILIATE_TOKEN` is set (Apple's Services Performance Partners Program; not yet approved — link works as plain attribution until then). This is the platform-*aligned* model; a hard paywall on a preview-based game is the risky one and was deliberately avoided.
- **Buy Me a Coffee** — footer link, `buymeacoffee.com/doodiepieface` (default in code).

## Spotify UI is gated (dev-mode 25-user cap)

Spotify is stuck in development mode (a 25-user manual allowlist), so the integration is **hidden from the public** to avoid advertising a feature most visitors can't use — but the backend is fully intact:
- The nav link (`SpotifyNavLink`) and the homepage "Your Spotify" section only render when `isConnected()` is true (or imported pools already exist, which are just playable data).
- `/spotify`, the OAuth flow, and all import logic are unchanged and reachable by direct URL, so allowlisted users can still connect (OAuth is a full reload, which re-reveals the UI).
Getting out of the cap needs Spotify's Extended Quota Mode review (routinely declined for personal projects), and even if granted, playlist contents stay blocked.

## Deployment & env vars

- **Vercel** (Hobby tier), root directory `earworm`, deploys on push to `main`. Custom domain `www.earwormgame.net` (Cloudflare DNS-only / grey-cloud → Vercel). Deployment Protection is off (public). `<Analytics />` from `@vercel/analytics` is in the layout — **Web Analytics must also be enabled in the Vercel dashboard** to collect.
- **Env vars** (all `NEXT_PUBLIC_*`, so build-time and public; real values live in `.env.local` locally and Vercel's env settings — never commit `.env.local`). See `.env.local.example`:
  - `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` — Spotify import.
  - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — optional accounts.
  - `NEXT_PUBLIC_SITE_URL` — canonical base URL (optional; code already defaults to the live domain).
  - `NEXT_PUBLIC_APPLE_AFFILIATE_TOKEN` (+ optional `NEXT_PUBLIC_APPLE_CAMPAIGN_TOKEN`) — Apple affiliate.
  - `NEXT_PUBLIC_BUYMEACOFFEE` — override/hide the donation link.
- On a domain change, update redirect URLs in **three** places or logins break: Spotify dashboard (`/callback`), Supabase Auth (Site URL + redirect URLs), and Google OAuth authorized domains.

## Spotify setup (if debugging auth)

Dashboard app must have Redirect URI **exactly** `http://127.0.0.1:3000/callback` (dev) and `https://www.earwormgame.net/callback` (prod). Client ID goes in `.env.local` as `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` (see `.env.local.example`); restart dev server after changing it. New Spotify apps are in development mode — testers must be allowlisted under User Management. Tokens live in localStorage `earworm-spotify-tokens`.

## Watch areas (prioritize when issues appear)

1. **Mobile snippet timing** — the 0.1s stage is at the edge of what mobile audio can do; the `startPosRef`/`playing`-event anchor fixed the cut-off, but startup latency (seek + decode) is inherent. If it regresses, check the anchoring, not the ladder.
2. The full Spotify PKCE round-trip (login → callback → token exchange → refresh).
3. `resolveTracks` progress UI + pacing on large imports.
4. Match-cache staleness — songs cached before `album`/`appleUrl` were added lack those fields (local album-guessing and the Apple link won't show for them until re-resolved; catalog search always has them). Bump the cache version if matching rules change.
5. CSS details across browsers/mobile.

## Legal footnote

Apple previews must be streamed (they are — plain `<audio>` src), not downloaded/cached as files. Keep the footer attribution ("Not affiliated with Apple or Spotify"). The **"Listen on Apple Music" link is now present** (the attribution Apple's terms expect); switching to Apple's official badge asset would be the stricter, fuller-compliance step if the project scales. A preview-based game with no music license is fine as a hobby project but caps how aggressively it can be monetized — keep that in mind before adding heavy ads or a paywall.
