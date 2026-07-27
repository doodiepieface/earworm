# Multiplayer Rooms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a host create a code-joined room where friends contribute songs in the lobby, then all play the same songs simultaneously — each running their own six-guess ladder, scored on fewest guesses with speed as the tiebreak.

**Architecture:** A room is a Supabase Realtime channel (`room:<CODE>`) — presence carries the roster, broadcast carries the game. There is no database table, no server route, and no persisted room. The host's browser is the authority: it owns the pool, builds the round list, picks each song, collects results, and computes scores. Every other client renders the round and reports its own outcome.

**Tech Stack:** Next.js 15 App Router, plain JavaScript (no TypeScript), React 19, hand-rolled CSS, `@supabase/supabase-js` Realtime. No new dependencies.

## Global Constraints

- **Plain JavaScript only.** No TypeScript, no Tailwind, no test framework, no new npm dependencies. These exclusions are deliberate project policy.
- **No automated test suite exists.** Pure logic is verified with throwaway Node scripts written to the scratchpad; UI is verified by hand in two browser profiles. Never claim a UI task is verified without actually running it.
- **Never run `npm run build` while `npm run dev` is running** — they share `.next` and it corrupts the dev server.
- **Dev server URL is `http://127.0.0.1:3000`, not `localhost`** — origin and localStorage differ between the two.
- **The pool list is never rendered.** Lobby shows a song *count* plus the player's own additions only. Showing pool titles puts every answer on screen.
- **Multiplayer is hidden when Supabase is unconfigured.** `isAuthConfigured()` false → no "Play with friends" entry anywhere, and the app behaves exactly as it does today.
- **Design system is "Nocturne."** Use the existing tokens in `app/globals.css` (`--accent` `#a98bff`, `--win` `#5ee6a8`, `--wrong` `#ff6b6b`, surfaces `#16131f`/`#1f1a2b`, ink `#f3eef9`, muted `#9c95ad`). Fonts: Fraunces (display), Manrope (body), JetBrains Mono (`.mono`, for counters and codes).
- **All browser-storage access goes through `lib/storage.js`.** No direct `localStorage` calls in pages or components.
- **Fixed values:** room code length 4, alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, min 2 players, max 8 players, max 10 contributions per player, 60000ms round cap, default 10 rounds, room history capped at 20 entries.
- **Scoring:** win on guess N scores `7 − N`; loss, timeout, or self-pick scores 0; ties break on lower total elapsed ms.
- Commit after every task. Do not skip commits.

## File Structure

**Create:**
- `earworm/lib/roomGame.js` — pure game logic: codes, scoring, round-list construction, dedupe, standings, history merge. No I/O, no React, no Supabase.
- `earworm/lib/room.js` — the only module aware of Supabase Realtime: join, send, leave, presence.
- `earworm/components/RoundBoard.jsx` — one round of guessing (dial + ladder + guess box), extracted from `app/play/page.js`.
- `earworm/components/Scoreboard.jsx` — between-round and final standings.
- `earworm/app/room/page.js` — host-or-join entry screen.
- `earworm/app/room/[code]/page.js` — lobby and game.

**Modify:**
- `earworm/lib/storage.js` — player name, stable player id, room history accessors.
- `earworm/lib/sync.js` — room history as a fourth synced key.
- `earworm/app/play/page.js` — use `RoundBoard`; behavior unchanged.
- `earworm/app/page.js` — "Play with friends" entry, gated.
- `earworm/app/globals.css` — lobby, roster, scoreboard styles.
- `earworm/app/sitemap.js` — add `/room`.
- `earworm/CLAUDE.md` — document the feature.

---

### Task 1: Pure room logic (`lib/roomGame.js`)

Everything here is a plain function with no I/O so it can be checked with a Node script — this project has no test runner, on purpose.

**Files:**
- Create: `earworm/lib/roomGame.js`
- Test: `<scratchpad>/roomGame.test.mjs` (throwaway, not committed)

**Interfaces:**
- Consumes: `MAX_GUESSES` from `lib/gameState.js`, `normalize` from `lib/itunes.js`.
- Produces:
  - `ROOM_CODE_LENGTH`, `MIN_PLAYERS`, `MAX_PLAYERS`, `MAX_CONTRIBUTIONS_PER_PLAYER`, `ROUND_CAP_MS`, `DEFAULT_ROUNDS`, `MAX_ROOM_HISTORY` (constants)
  - `makeRoomCode(random?) -> string`
  - `songKey(song) -> string`
  - `shuffled(list, random?) -> array`
  - `scoreForResult({ won, guessCount, isSelfPick }) -> number`
  - `dedupeContributions(contributions, poolSongs) -> [{ song, by }]`
  - `buildRoundList({ poolSongs, contributions, rounds, random? }) -> [{ song, contributedBy }]`
  - `sortStandings(players) -> [{ id, name, score, timeMs }]`
  - `mergeRoomHistory(local, remote) -> array`

- [ ] **Step 1: Write the failing test script**

Create `<scratchpad>/roomGame.test.mjs`. Note the import path — run this from the `earworm/` directory.

```js
import assert from "node:assert/strict";
import {
  makeRoomCode, songKey, shuffled, scoreForResult, dedupeContributions,
  buildRoundList, sortStandings, mergeRoomHistory,
  ROOM_CODE_LENGTH, MAX_ROOM_HISTORY,
} from "./lib/roomGame.js";

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { console.error("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; }
}

const song = (id, title, artist) => ({ id, title, artist, previewUrl: "x" });

check("code is the right length and avoids confusable characters", () => {
  for (let i = 0; i < 200; i++) {
    const c = makeRoomCode();
    assert.equal(c.length, ROOM_CODE_LENGTH);
    assert.ok(!/[01OIL]/.test(c), "contains a confusable character: " + c);
  }
});

check("scoring runs 6 down to 1 across the ladder", () => {
  assert.equal(scoreForResult({ won: true, guessCount: 1 }), 6);
  assert.equal(scoreForResult({ won: true, guessCount: 3 }), 4);
  assert.equal(scoreForResult({ won: true, guessCount: 6 }), 1);
});

check("a loss scores nothing", () => {
  assert.equal(scoreForResult({ won: false, guessCount: 6 }), 0);
});

check("your own contributed song scores nothing even if you nail it", () => {
  assert.equal(scoreForResult({ won: true, guessCount: 1, isSelfPick: true }), 0);
});

check("dedupe drops contributions already in the host pool", () => {
  const pool = [song("it-1", "Hotline Bling", "Drake")];
  const contrib = [
    { song: song("it-2", "hotline bling", "drake"), by: "p1" },
    { song: song("it-3", "One Dance", "Drake"), by: "p2" },
  ];
  const out = dedupeContributions(contrib, pool);
  assert.equal(out.length, 1);
  assert.equal(out[0].song.id, "it-3");
});

check("dedupe drops duplicate contributions from different players", () => {
  const contrib = [
    { song: song("it-2", "One Dance", "Drake"), by: "p1" },
    { song: song("it-9", "One Dance", "Drake"), by: "p2" },
  ];
  assert.equal(dedupeContributions(contrib, []).length, 1);
});

check("round list is half contributions, half pool", () => {
  const pool = Array.from({ length: 50 }, (_, i) => song("p" + i, "Pool " + i, "A"));
  const contrib = Array.from({ length: 20 }, (_, i) => ({ song: song("c" + i, "Con " + i, "B"), by: "p" + i }));
  const list = buildRoundList({ poolSongs: pool, contributions: contrib, rounds: 10 });
  assert.equal(list.length, 10);
  assert.equal(list.filter((r) => r.contributedBy).length, 5);
});

check("pool fills the gap when contributions are scarce", () => {
  const pool = Array.from({ length: 50 }, (_, i) => song("p" + i, "Pool " + i, "A"));
  const contrib = [{ song: song("c0", "Con", "B"), by: "p1" }];
  const list = buildRoundList({ poolSongs: pool, contributions: contrib, rounds: 10 });
  assert.equal(list.length, 10);
  assert.equal(list.filter((r) => r.contributedBy).length, 1);
});

check("works with no contributions at all", () => {
  const pool = Array.from({ length: 12 }, (_, i) => song("p" + i, "Pool " + i, "A"));
  const list = buildRoundList({ poolSongs: pool, contributions: [], rounds: 10 });
  assert.equal(list.length, 10);
  assert.ok(list.every((r) => r.contributedBy === null));
});

check("a short pool yields a short game rather than repeating a song", () => {
  const pool = [song("p0", "A", "X"), song("p1", "B", "X")];
  const list = buildRoundList({ poolSongs: pool, contributions: [], rounds: 10 });
  assert.equal(list.length, 2);
  assert.equal(new Set(list.map((r) => r.song.id)).size, 2);
});

check("contributions are spread through the game, not front-loaded", () => {
  const pool = Array.from({ length: 50 }, (_, i) => song("p" + i, "Pool " + i, "A"));
  const contrib = Array.from({ length: 2 }, (_, i) => ({ song: song("c" + i, "Con " + i, "B"), by: "p" + i }));
  const list = buildRoundList({ poolSongs: pool, contributions: contrib, rounds: 10 });
  const positions = list.map((r, i) => (r.contributedBy ? i : -1)).filter((i) => i >= 0);
  assert.equal(positions.length, 2);
  assert.ok(positions[1] - positions[0] >= 3, "contributions clustered: " + positions.join(","));
});

check("standings sort by points, then by time", () => {
  const out = sortStandings([
    { id: "a", name: "A", score: 4, timeMs: 9000 },
    { id: "b", name: "B", score: 9, timeMs: 5000 },
    { id: "c", name: "C", score: 4, timeMs: 3000 },
  ]);
  assert.deepEqual(out.map((p) => p.id), ["b", "c", "a"]);
});

check("history merges by code+endedAt, newest first, capped", () => {
  const local = [{ code: "AAAA", endedAt: 3 }, { code: "BBBB", endedAt: 1 }];
  const remote = [{ code: "AAAA", endedAt: 3 }, { code: "CCCC", endedAt: 2 }];
  const out = mergeRoomHistory(local, remote);
  assert.deepEqual(out.map((e) => e.code), ["AAAA", "CCCC", "BBBB"]);

  const many = Array.from({ length: 40 }, (_, i) => ({ code: "R" + i, endedAt: i }));
  assert.equal(mergeRoomHistory(many, []).length, MAX_ROOM_HISTORY);
});

check("shuffle keeps every element exactly once", () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = shuffled(input);
  assert.deepEqual(out.slice().sort((a, b) => a - b), input);
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8], "shuffled() mutated its input");
});

check("songKey ignores case and punctuation", () => {
  assert.equal(songKey(song("1", "Don't Stop", "AC/DC")), songKey(song("2", "dont stop", "ACDC")));
});

console.log("\n" + passed + " checks passed");
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd earworm && node "$SCRATCHPAD/roomGame.test.mjs"
```

Expected: FAIL — `Cannot find module` for `./lib/roomGame.js`.

- [ ] **Step 3: Write the implementation**

Create `earworm/lib/roomGame.js`:

```js
// Pure game logic for multiplayer rooms. No I/O, no React, no Supabase — every
// function here is plain and deterministic (given a `random`), so it can be
// checked with a throwaway Node script. This project has no test runner by
// design, so keeping the rules in one side-effect-free file is how they stay
// verifiable.
//
// The two imports below carry explicit .js extensions, unlike the rest of the
// codebase. Next's bundler accepts either, but plain `node` only resolves the
// explicit form — and being runnable under plain node is the entire point of
// this file. Both targets are safe to import outside a browser: gameState has
// no dependencies, and itunes.js touches localStorage only lazily inside
// getCache(), behind a try/catch.

import { MAX_GUESSES } from "./gameState.js";
import { normalize } from "./itunes.js";

export const ROOM_CODE_LENGTH = 4;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const MAX_CONTRIBUTIONS_PER_PLAYER = 10;
export const ROUND_CAP_MS = 60000;
export const DEFAULT_ROUNDS = 10;
export const MAX_ROOM_HISTORY = 20;

// No 0/O/1/I/L — a room code gets read aloud across a table or squinted at on
// someone else's screen, so the characters have to survive both.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function makeRoomCode(random = Math.random) {
  let out = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return out;
}

// Identity for dedupe. Both sides are always iTunes-sourced here (contributions
// come from the same catalog search the guess box uses), so the artist strings
// are formatted consistently and a plain normalize on both fields is enough —
// no need for the performer-by-performer artistsMatch used for Spotify data.
export function songKey(song) {
  return `${normalize(song?.title)}|${normalize(song?.artist)}`;
}

// Fisher-Yates on a copy. `random` is injectable so tests can be deterministic.
export function shuffled(list, random = Math.random) {
  const a = (list || []).slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Win on guess N scores 7-N: 6 points for catching it in the first 0.1s, 1 for
// scraping it on the last guess. A loss, a timeout, or a song you added
// yourself scores nothing — you already knew that one.
export function scoreForResult({ won, guessCount, isSelfPick } = {}) {
  if (!won || isSelfPick) return 0;
  const n = Math.min(Math.max(guessCount || 1, 1), MAX_GUESSES);
  return MAX_GUESSES + 1 - n;
}

// `contributions` is [{ song, by }]. Drops anything already in the host's pool
// and anything two players happened to add independently.
export function dedupeContributions(contributions, poolSongs) {
  const seen = new Set();
  for (const s of poolSongs || []) {
    if (!s) continue;
    seen.add(s.id);
    seen.add(songKey(s));
  }
  const out = [];
  for (const c of contributions || []) {
    if (!c?.song) continue;
    const key = songKey(c.song);
    if (seen.has(c.song.id) || seen.has(key)) continue;
    seen.add(c.song.id);
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Place the smaller group at evenly spaced positions across the whole game, then
// let the larger group fill the gaps. Straight alternation would dump both of
// two contributions into rounds 1 and 2 and leave the rest of the game flat.
function interleave(a, b) {
  const [few, many] = a.length <= b.length ? [a, b] : [b, a];
  const total = few.length + many.length;
  if (!few.length) return many.slice();

  const out = new Array(total).fill(null);
  for (let i = 0; i < few.length; i++) {
    let pos = Math.min(total - 1, Math.floor(((i + 0.5) * total) / few.length));
    while (out[pos] !== null) pos = (pos + 1) % total; // nudge past a taken slot
    out[pos] = few[i];
  }
  let m = 0;
  for (let i = 0; i < total; i++) if (out[i] === null) out[i] = many[m++];
  return out;
}

// Half the rounds come from what players added, half from the host's pool. If
// there aren't enough contributions, the pool fills the gap. If the pool itself
// is short, the game is short — a song never repeats within one game.
export function buildRoundList({ poolSongs, contributions, rounds = DEFAULT_ROUNDS, random = Math.random } = {}) {
  const clean = dedupeContributions(contributions, poolSongs);
  const wantContributed = Math.floor(rounds / 2);

  const picked = shuffled(clean, random)
    .slice(0, wantContributed)
    .map((c) => ({ song: c.song, contributedBy: c.by }));

  const usedIds = new Set(picked.map((r) => r.song.id));
  const fromPool = shuffled(poolSongs, random)
    .filter((s) => s && !usedIds.has(s.id))
    .slice(0, rounds - picked.length)
    .map((s) => ({ song: s, contributedBy: null }));

  return interleave(picked, fromPool).slice(0, rounds);
}

// Most points wins; ties go to the lower total time. The id fallback is only so
// the order can't flicker between renders when two players are truly identical.
export function sortStandings(players) {
  return (players || [])
    .slice()
    .sort(
      (a, b) =>
        (b.score || 0) - (a.score || 0) ||
        (a.timeMs || 0) - (b.timeMs || 0) ||
        String(a.id).localeCompare(String(b.id))
    );
}

// Room history is append-only per device, so a union keyed on the room and when
// it ended is the whole merge. Newest first, capped.
export function mergeRoomHistory(local, remote) {
  const out = [];
  const seen = new Set();
  for (const e of [...(remote || []), ...(local || [])]) {
    if (!e || !e.code || !e.endedAt) continue;
    const key = `${e.code}|${e.endedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  out.sort((a, b) => b.endedAt - a.endedAt);
  return out.slice(0, MAX_ROOM_HISTORY);
}
```

- [ ] **Step 4: Run the test script again**

```bash
cd earworm && node "$SCRATCHPAD/roomGame.test.mjs"
```

Expected: all checks pass, `17 checks passed`.

If an import fails under plain Node, the cause is almost certainly a missing `.js` extension — Node's ESM resolver requires it, Next's bundler does not. Fix the extension. Do **not** work around it by duplicating `normalize` into `roomGame.js`; two copies of the matching rules is exactly the drift this file exists to prevent.

- [ ] **Step 5: Commit**

```bash
git add earworm/lib/roomGame.js
git commit -m "Add pure room game logic: codes, scoring, round list, standings"
```

---

### Task 2: Player identity and room history storage

**Files:**
- Modify: `earworm/lib/storage.js` (append a new section before `/* ---- Misc ---- */`)
- Modify: `earworm/lib/sync.js:9-18` (imports and `SYNCABLE`), `earworm/lib/sync.js:99-104` (`mergeValue`)

**Interfaces:**
- Consumes: `mergeRoomHistory`, `MAX_ROOM_HISTORY` from `lib/roomGame.js` (Task 1).
- Produces: `loadPlayerName()`, `savePlayerName(name)`, `getPlayerId()`, `loadRoomHistory()`, `addRoomHistoryEntry(entry)`, `ROOM_HISTORY_KEY` from `lib/storage.js`.

- [ ] **Step 1: Add the storage accessors**

In `earworm/lib/storage.js`, insert before the `/* ---------------- Misc ---------------- */` section:

```js
/* ---------------- Multiplayer rooms ---------------- */

const PLAYER_NAME_KEY = "earworm-player-name";
const PLAYER_ID_KEY = "earworm-player-id";
export const ROOM_HISTORY_KEY = "earworm-room-history";

export function loadPlayerName() {
  const n = read(PLAYER_NAME_KEY, "");
  return typeof n === "string" ? n : "";
}

export function savePlayerName(name) {
  write(PLAYER_NAME_KEY, String(name || "").slice(0, 20));
}

// A stable id for this browser. Presence is keyed on it, so refreshing mid-game
// rejoins as the same player instead of appearing as a second one.
export function getPlayerId() {
  let id = read(PLAYER_ID_KEY, null);
  if (typeof id !== "string" || !id) {
    id = `p-${Math.random().toString(36).slice(2, 10)}`;
    write(PLAYER_ID_KEY, id);
  }
  return id;
}

export function loadRoomHistory() {
  const h = read(ROOM_HISTORY_KEY, []);
  return Array.isArray(h) ? h : [];
}

export function saveRoomHistory(entries) {
  write(ROOM_HISTORY_KEY, entries);
}
```

Note: name and id are written through `write()`, so they hit the sync hook — but neither key is in `SYNCABLE`, so they stay local. That's intended; a device id must not follow you to another device.

- [ ] **Step 2: Add the capped-append helper**

Also in `earworm/lib/storage.js`, immediately after `saveRoomHistory`:

```js
// Newest first, capped. Re-uses the same merge the account layer uses so a
// local append and a remote merge can never disagree about ordering or limit.
export function addRoomHistoryEntry(entry) {
  const merged = mergeRoomHistory([entry], loadRoomHistory());
  saveRoomHistory(merged);
  return merged;
}
```

And add the import at the top of `lib/storage.js`:

```js
import { mergeRoomHistory } from "./roomGame";
```

- [ ] **Step 3: Register room history as a synced key**

In `earworm/lib/sync.js`, change the import block (currently lines 9-16) to include the new key, and extend `SYNCABLE`:

```js
import { mergeRoomHistory } from "./roomGame";
import {
  registerSyncHook,
  readKey,
  writeKey,
  SPOTIFY_POOLS_KEY,
  LISTS_KEY,
  STATS_KEY,
  ROOM_HISTORY_KEY,
} from "./storage";

const SYNCABLE = new Set([SPOTIFY_POOLS_KEY, LISTS_KEY, STATS_KEY, ROOM_HISTORY_KEY]);
```

Then update the header comment at the top of the file — it currently says "Only three things sync". Change it to:

```js
// Mirrors a signed-in user's data to their Supabase account and back.
// Only four things sync — imported Spotify pools, custom lists, play stats, and
// multiplayer room history. Everything else (volume, pack caches, the player's
// device id, and crucially the Spotify OAuth tokens) stays local-only.
```

- [ ] **Step 4: Add the merge rule**

In `earworm/lib/sync.js`, `mergeValue` (currently lines 99-104) becomes:

```js
function mergeValue(key, local, remote) {
  if (remote == null) return local;
  if (local == null) return remote;
  if (key === STATS_KEY) return mergeStats(local, remote);
  if (key === ROOM_HISTORY_KEY) return mergeRoomHistory(local, remote);
  return mergeById(local, remote);
}
```

`mergeById` would silently drop every room entry — history rows have no `id` field — so this branch is required, not cosmetic.

- [ ] **Step 5: Verify the merge wiring with a Node script**

Write `<scratchpad>/syncMerge.test.mjs`:

```js
import assert from "node:assert/strict";
import { mergeRoomHistory } from "./lib/roomGame.js";

// The exact shape addRoomHistoryEntry produces.
const entry = {
  code: "QK4T", endedAt: 1753600000000, poolName: "2020s Hits",
  poolSpec: { type: "pack", id: "2020s" }, rounds: 10,
  players: [{ name: "Sam", score: 31 }, { name: "you", score: 28 }],
  you: { score: 28, place: 2 },
};
const merged = mergeRoomHistory([entry], []);
assert.equal(merged.length, 1);
assert.equal(merged[0].poolSpec.type, "pack");
assert.equal(mergeRoomHistory([entry], [entry]).length, 1, "same room merged twice");
console.log("ok — room history entry shape survives a merge");
```

Run: `cd earworm && node "$SCRATCHPAD/syncMerge.test.mjs"` — expected: `ok — room history entry shape survives a merge`.

- [ ] **Step 6: Commit**

```bash
git add earworm/lib/storage.js earworm/lib/sync.js
git commit -m "Add player identity and synced room history storage"
```

---

### Task 3: Extract `RoundBoard` from the play page

Pure refactor. Single-player behavior must be **identical** after this task — this exists so room rounds and solo rounds can't drift apart.

**Files:**
- Create: `earworm/components/RoundBoard.jsx`
- Modify: `earworm/app/play/page.js` (round state and render)

**Interfaces:**
- Consumes: `SnippetPlayer`, `GuessLadder`, `GuessInput`, `LADDER`, `MAX_GUESSES`, `FULL_PREVIEW_SECONDS`, `skipLabel`, `isCorrectGuess`.
- Produces: `<RoundBoard song startAt localSongs forceEnd onFinish onUnplayable>{children}</RoundBoard>`, where `onFinish({ won, guessCount, guesses })` fires once per round and `guessCount` is the **1-based number of the winning guess** (6 on a loss). Parent must pass a `key` that changes per round so internal state resets.

- [ ] **Step 1: Create the component**

Create `earworm/components/RoundBoard.jsx`:

```jsx
"use client";

import { useEffect, useRef, useState } from "react";
import SnippetPlayer from "@/components/SnippetPlayer";
import GuessLadder from "@/components/GuessLadder";
import GuessInput from "@/components/GuessInput";
import { isCorrectGuess } from "@/lib/itunes";
import { LADDER, MAX_GUESSES, FULL_PREVIEW_SECONDS, skipLabel } from "@/lib/gameState";

// One round of guessing: the dial, the ladder, and the guess box. Owns the
// guess list and the win/loss decision, and nothing else — no pool, no stats,
// no networking. Both the solo play page and a multiplayer room render this, so
// the rules can't drift between the two.
//
// The parent MUST pass a `key` that changes each round; internal state resets
// on remount rather than through an effect that could race the first render.
//
// `forceEnd` is for rooms: when the 60s cap expires the parent flips it true and
// an unfinished round is settled as a loss. It does nothing in solo play.
//
// `children` renders below the ladder — that's where the parent puts its own
// result card, which differs between solo and room play.
export default function RoundBoard({
  song,
  startAt = 0,
  localSongs = null,
  forceEnd = false,
  onFinish,
  onUnplayable,
  children,
}) {
  const [guesses, setGuesses] = useState([]);
  const [status, setStatus] = useState("playing"); // playing | won | lost
  const firedRef = useRef(false); // onFinish is once per round, never twice

  function settle(won, finalGuesses) {
    if (firedRef.current) return;
    firedRef.current = true;
    setGuesses(finalGuesses);
    setStatus(won ? "won" : "lost");
    onFinish?.({
      won,
      guessCount: won ? finalGuesses.length + 1 : MAX_GUESSES,
      guesses: finalGuesses,
    });
  }

  function addAttempt(attempt) {
    if (status !== "playing" || firedRef.current) return;
    const next = [...guesses, attempt];
    if (next.length >= MAX_GUESSES) settle(false, next);
    else setGuesses(next);
  }

  function handleGuess(guess) {
    if (status !== "playing") return;
    if (isCorrectGuess(guess, song)) settle(true, guesses);
    else addAttempt({ type: "wrong", label: `${guess.title} — ${guess.artist}` });
  }

  function handleSkip() {
    if (status !== "playing") return;
    addAttempt({ type: "skip" });
  }

  // Room timeout: settle as a loss with whatever guesses were made.
  useEffect(() => {
    if (forceEnd && !firedRef.current) settle(false, guesses);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceEnd]);

  const ended = status !== "playing";
  const unlocked = ended ? FULL_PREVIEW_SECONDS : LADDER[guesses.length];
  const maxSeconds = ended ? FULL_PREVIEW_SECONDS : LADDER[LADDER.length - 1];

  return (
    <>
      <SnippetPlayer
        song={song}
        unlockedSeconds={unlocked}
        maxSeconds={maxSeconds}
        startAt={ended ? 0 : startAt}
        onUnplayable={onUnplayable}
      />

      <GuessLadder guesses={guesses} status={status} />

      {!ended && (
        <GuessInput
          onGuess={handleGuess}
          onSkip={handleSkip}
          disabled={ended}
          skipText={skipLabel(guesses.length)}
          answer={song}
          localSongs={localSongs}
        />
      )}

      {children}
    </>
  );
}
```

- [ ] **Step 2: Rewire the play page to use it**

In `earworm/app/play/page.js`:

Replace the component imports (lines 6-9) so `SnippetPlayer`, `GuessInput`, and `GuessLadder` are no longer imported directly:

```js
import RoundBoard from "@/components/RoundBoard";
import ResultCard from "@/components/ResultCard";
```

Change the `lib` imports (lines 11-19) — `isCorrectGuess` moves into `RoundBoard`, and `LADDER`/`FULL_PREVIEW_SECONDS`/`skipLabel` are no longer used here:

```js
import { streamArtistPool, resolveTracks } from "@/lib/itunes";
import { pickSong, pickStartOffset } from "@/lib/gameState";
```

Replace `startRound`, `finishRound`, `addAttempt`, `finishRoundLoss`, `handleGuess`, and `handleSkip` (lines 234-276) with:

```js
  const roundSeq = useRef(0);

  function startRound(songs) {
    const song = pickSong(songs, playedIds.current, lastId.current);
    lastId.current = song.id;
    roundSeq.current += 1;
    setRound({ key: roundSeq.current, song, startAt: pickStartOffset(), result: null });
  }

  function handleFinish({ won, guessCount, guesses }) {
    const stats = recordResult(won, guessCount);
    setStreak(stats.streak);
    setRound((r) => (r ? { ...r, result: { won, guesses } } : r));
  }
```

Replace the render block (lines 332-361) with:

```jsx
      <RoundBoard
        key={round.key}
        song={round.song}
        startAt={round.startAt}
        localSongs={guessArtist ? pool.songs : null}
        onFinish={handleFinish}
        onUnplayable={handleUnplayable}
      >
        {round.result && (
          <ResultCard
            won={round.result.won}
            song={round.song}
            guesses={round.result.guesses}
            streak={streak}
            onNext={() => startRound(pool.songs)}
          />
        )}
      </RoundBoard>
```

Also delete the now-unused `ended`, `unlocked`, and `maxSeconds` locals just above the return (lines 315-317), and update `handleUnplayable` (line 281) — it currently checks `round.status !== "playing"`, which no longer exists. It becomes:

```js
  // A song whose preview won't load isn't a fair round — drop it from the pool
  // and move on to a fresh song without recording a loss, so the streak holds.
  function handleUnplayable() {
    if (!round || round.result) return;
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
```

- [ ] **Step 3: Verify nothing changed for solo play**

Start the dev server (`npm run dev`) and open `http://127.0.0.1:3000`. Confirm, on a genre pack:

1. A round starts and the 0.1s snippet plays from a random offset.
2. A wrong guess adds a red ladder row and unlocks the next stage.
3. Skip adds a grey row with the correct `+Ns` label.
4. A correct guess shows the win card with the right guess count, and the streak increments.
5. Six wrong guesses shows the loss card and resets the streak.
6. "Next song" starts a fresh round with a different song.

Also confirm artist mode still filters guesses locally (type a partial title — suggestions should appear instantly with no network round-trip).

Report exactly what you observed. Do not mark this step complete without running it.

- [ ] **Step 4: Commit**

```bash
git add earworm/components/RoundBoard.jsx earworm/app/play/page.js
git commit -m "Extract RoundBoard so solo and room rounds share one implementation"
```

---

### Task 4: Realtime transport (`lib/room.js`)

**Files:**
- Create: `earworm/lib/room.js`
- Test: `<scratchpad>/roomChannel.test.mjs` (throwaway)

**Interfaces:**
- Consumes: `getClient`, `isAuthConfigured` from `lib/supabase.js`.
- Produces: `isRoomsEnabled()`, `ROOM_EVENTS`, `joinRoom(code, { self, onEvent, onRoster }) -> { send(event, payload), leave() }`.

- [ ] **Step 1: Write the module**

Create `earworm/lib/room.js`:

```js
"use client";

// The only module that knows Supabase Realtime exists. A room is a channel
// named `room:<CODE>`: presence carries the roster, broadcast carries the game.
//
// Nothing is stored server-side. There is no table, no row, no cleanup job —
// close every tab and the room is gone. That's why the host's browser has to be
// the authority (see app/room/[code]/page.js).
//
// Channels are public: anyone who knows the code can join, which is fine for a
// party game and must not be described as private.

import { getClient, isAuthConfigured } from "./supabase";

// Multiplayer rides on the same Supabase project as optional accounts, so it's
// available exactly when that is configured.
export function isRoomsEnabled() {
  return isAuthConfigured();
}

// Every broadcast event the room uses. Listed explicitly rather than subscribing
// to a wildcard so an unknown event can't silently reach a handler.
export const ROOM_EVENTS = [
  "add", // player -> host: { playerId, name, song }
  "pool", // host -> all:    { count, locked }
  "start", // host -> all:    { rounds, poolName }
  "round", // host -> all:    { index, song, startAt, capMs }
  "done", // player -> host: { playerId, roundIndex, won, guessCount, ms }
  "unplayable", // player -> host: { playerId, roundIndex, songId }
  "scores", // host -> all:    { index, contributedBy, results, totals }
  "sync", // host -> one:    { toPlayerId, ...full state }
  "end", // host -> all:    { totals, poolName, rounds }
];

// `self` is { id, name, isHost }. `onEvent(event, payload)` receives every
// broadcast including this client's own — the host runs the same handlers as
// everyone else, so there's one code path for rendering a round rather than two.
// `onRoster(players)` fires on every presence change.
export function joinRoom(code, { self, onEvent, onRoster }) {
  const client = getClient();
  if (!client) {
    throw new Error("Multiplayer isn't configured on this deployment.");
  }

  const channel = client.channel(`room:${code}`, {
    config: {
      presence: { key: self.id },
      broadcast: { self: true },
    },
  });

  for (const event of ROOM_EVENTS) {
    channel.on("broadcast", { event }, (msg) => onEvent?.(event, msg.payload));
  }

  channel.on("presence", { event: "sync" }, () => {
    const state = channel.presenceState();
    // presenceState() gives { key: [meta, ...] }; one meta per connection, and a
    // reconnecting client can briefly have two. Keep the first per key.
    const players = Object.values(state)
      .map((metas) => metas[0])
      .filter(Boolean)
      .map((m) => ({ id: m.id, name: m.name, isHost: !!m.isHost }));
    onRoster?.(players);
  });

  channel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") {
      await channel.track(self);
    }
  });

  return {
    send(event, payload) {
      return channel.send({ type: "broadcast", event, payload });
    },
    leave() {
      try {
        client.removeChannel(channel);
      } catch {
        // Already gone (tab closing) — nothing to clean up.
      }
    },
  };
}
```

- [ ] **Step 2: Write a two-client Node script**

This talks to the real Supabase project, so read the env vars from `.env.local`. Write `<scratchpad>/roomChannel.test.mjs`:

```js
// Two clients join one room channel and exchange a broadcast + presence.
// Needs Node 20+ (global WebSocket). Reads .env.local from the earworm dir.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) throw new Error("Supabase env vars missing from .env.local");

function member(name, id) {
  const c = createClient(url, key);
  const ch = c.channel("room:TEST", {
    config: { presence: { key: id }, broadcast: { self: true } },
  });
  return { c, ch, name, id };
}

const host = member("host", "p-host");
const guest = member("guest", "p-guest");

let gotBroadcast = false;
let sawBothInPresence = false;

guest.ch.on("broadcast", { event: "round" }, (msg) => {
  console.log("guest received round:", msg.payload);
  gotBroadcast = msg.payload?.index === 0;
});

guest.ch.on("presence", { event: "sync" }, () => {
  const keys = Object.keys(guest.ch.presenceState());
  if (keys.length === 2) sawBothInPresence = true;
});

await new Promise((res) => host.ch.subscribe((s) => s === "SUBSCRIBED" && res()));
await host.ch.track({ id: host.id, name: "Host", isHost: true });
await new Promise((res) => guest.ch.subscribe((s) => s === "SUBSCRIBED" && res()));
await guest.ch.track({ id: guest.id, name: "Guest", isHost: false });

await new Promise((r) => setTimeout(r, 1500));
await host.ch.send({ type: "broadcast", event: "round", payload: { index: 0, songId: "it-1" } });
await new Promise((r) => setTimeout(r, 1500));

console.log("broadcast delivered:", gotBroadcast);
console.log("presence saw both players:", sawBothInPresence);
process.exitCode = gotBroadcast && sawBothInPresence ? 0 : 1;
host.c.removeChannel(host.ch);
guest.c.removeChannel(guest.ch);
process.exit(process.exitCode);
```

- [ ] **Step 3: Run it**

```bash
cd earworm && node "$SCRATCHPAD/roomChannel.test.mjs"
```

Expected: `broadcast delivered: true` and `presence saw both players: true`, exit 0.

If `.env.local` has no Supabase vars, stop and report it — this is the prerequisite named in the spec, and the rest of the feature cannot be verified without it. Do not stub it out.

- [ ] **Step 4: Commit**

```bash
git add earworm/lib/room.js
git commit -m "Add Supabase Realtime room transport"
```

---

### Task 5: The `/room` entry screen

**Files:**
- Create: `earworm/app/room/page.js`
- Modify: `earworm/app/sitemap.js`

**Interfaces:**
- Consumes: `makeRoomCode`, `MAX_PLAYERS` from `lib/roomGame.js`; `isRoomsEnabled` from `lib/room.js`; `loadPlayerName`, `savePlayerName` from `lib/storage.js`; `packs` (default export) and `getPack` from `data/packs.js`.
- Produces: navigation to `/room/<CODE>?host=1&pack=<id>` or `/room/<CODE>?host=1&artist=<name>` for a host, `/room/<CODE>` for a joiner. The lobby reads those query params to know what pool to build.

- [ ] **Step 1: Build the page**

Create `earworm/app/room/page.js`:

```jsx
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
  const [enabled, setEnabled] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [artist, setArtist] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setEnabled(isRoomsEnabled());
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
      <h1 className="display">Play with friends</h1>
      <p className="lede">
        One person hosts, everyone else joins with the code. You all hear the
        same songs — fewest guesses wins.
      </p>

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
        <form className="join-form" onSubmit={join}>
          <input
            type="text"
            className="code-input mono"
            value={code}
            maxLength={4}
            placeholder="CODE"
            autoCapitalize="characters"
            autoComplete="off"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button type="submit" className="btn btn-primary">
            Join
          </button>
        </form>
      </section>

      <section className="section">
        <p className="eyebrow">Or host one — pick a pack</p>
        <div className="grid">
          {packs.map((p) => (
            <button key={p.id} type="button" className="card pack-card" onClick={() => hostWithPack(p.id)}>
              <span className="pack-name">{p.name}</span>
              <span className="pack-count mono">{p.tracks.length} songs</span>
            </button>
          ))}
        </div>
      </section>

      <section className="section">
        <p className="eyebrow">Or host with an artist</p>
        <form className="join-form" onSubmit={hostWithArtist}>
          <input
            type="text"
            value={artist}
            placeholder="Any artist…"
            autoComplete="off"
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
```

Check `data/packs.js` for the actual field names on a pack before wiring `p.name` and `p.tracks` — mirror whatever `app/page.js` already renders for the genre-pack grid, including its class names, so the two grids look identical.

- [ ] **Step 2: Add `/room` to the sitemap**

In `earworm/app/sitemap.js`, add an entry for `/room` alongside the existing home, `/lists`, and `/spotify` entries, following the exact object shape already used there.

- [ ] **Step 3: Verify**

With the dev server running, open `http://127.0.0.1:3000/room`:

1. Name field is empty on first visit; after typing a name and hosting, reloading `/room` pre-fills it.
2. Submitting with an empty name shows the error and does not navigate.
3. Entering a 3-character code shows the length error.
4. Clicking a pack navigates to `/room/XXXX?host=1&pack=...` with a 4-character code containing no `0`, `O`, `1`, `I`, or `L`.
5. Hosting with an artist navigates with `?host=1&artist=...`.

The lobby route doesn't exist yet, so a 404 after navigation is expected. Confirm the URL is correct.

- [ ] **Step 4: Commit**

```bash
git add earworm/app/room/page.js earworm/app/sitemap.js
git commit -m "Add room host-or-join entry screen"
```

---

### Task 6: Lobby — roster, pool resolution, start gating

**Files:**
- Create: `earworm/app/room/[code]/page.js`

**Interfaces:**
- Consumes: `joinRoom` from `lib/room.js`; `MIN_PLAYERS`, `MAX_PLAYERS`, `DEFAULT_ROUNDS` from `lib/roomGame.js`; `getPlayerId`, `loadPlayerName`, `savePlayerName` from `lib/storage.js`; `getPack` from `data/packs.js`; `resolveTracks`, `streamArtistPool` from `lib/itunes.js`; `loadPackCache`, `savePackCache` from `lib/storage.js`.
- Produces: the room page component. Later tasks extend this same file with contributions (Task 7), the game loop (Task 8), scoring (Task 9), and rejoin handling (Task 10).

- [ ] **Step 1: Build the lobby**

Create `earworm/app/room/[code]/page.js`:

```jsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { getPack } from "@/data/packs";
import { joinRoom, isRoomsEnabled } from "@/lib/room";
import { MIN_PLAYERS, MAX_PLAYERS, DEFAULT_ROUNDS } from "@/lib/roomGame";
import { resolveTracks, streamArtistPool } from "@/lib/itunes";
import {
  getPlayerId, loadPlayerName, savePlayerName,
  loadPackCache, savePackCache,
} from "@/lib/storage";

const MIN_POOL_SIZE = 4;

// The lobby and the game live in one component because they share the channel
// connection and the host's authoritative state. The host's browser is the
// server: it owns the pool, builds the round list, and computes every score.
export default function RoomPage() {
  const params = useParams();
  const search = useSearchParams();
  const router = useRouter();

  const code = String(params.code || "").toUpperCase();
  const isHost = search.get("host") === "1";
  const packId = search.get("pack");
  const artistName = search.get("artist");

  const [phase, setPhase] = useState("connecting"); // connecting | naming | lobby | closed
  const [name, setName] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [roster, setRoster] = useState([]);
  const [poolCount, setPoolCount] = useState(0);
  const [poolName, setPoolName] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [rounds, setRounds] = useState(DEFAULT_ROUNDS);
  const [notice, setNotice] = useState("");

  const meId = useRef(null);
  const conn = useRef(null); // { send, leave }
  const poolSongs = useRef([]); // host only — never rendered

  /* ---------- Identity ---------- */

  useEffect(() => {
    if (!isRoomsEnabled()) {
      setPhase("closed");
      setNotice("Multiplayer isn't available on this deployment.");
      return;
    }
    meId.current = getPlayerId();
    const saved = loadPlayerName();
    if (saved) setName(saved);
    else setPhase("naming");
  }, []);

  /* ---------- Channel ---------- */

  const handleEvent = useCallback((event, payload) => {
    if (event === "pool") {
      setPoolCount(payload.count);
      if (payload.poolName) setPoolName(payload.poolName);
    }
  }, []);

  useEffect(() => {
    if (!name || !meId.current || phase === "closed") return;

    const c = joinRoom(code, {
      self: { id: meId.current, name, isHost },
      onEvent: handleEvent,
      onRoster: setRoster,
    });
    conn.current = c;
    setPhase("lobby");

    return () => {
      c.leave();
      conn.current = null;
    };
  }, [name, code, isHost, phase === "closed", handleEvent]);

  /* ---------- Host: resolve the pool ---------- */

  useEffect(() => {
    if (!isHost || phase !== "lobby") return;
    let aborted = false;

    async function preparePack() {
      const pack = getPack(packId);
      if (!pack) {
        setNotice("That pack no longer exists.");
        return;
      }
      setPoolName(pack.name);
      setPreparing(true);
      const cached = loadPackCache(pack.id);
      if (cached?.songs?.length) {
        publishPool(cached.songs, pack.name);
      } else {
        const { songs, misses } = await resolveTracks(pack.tracks, {
          isAborted: () => aborted,
          onProgress: () => {},
        });
        if (aborted) return;
        savePackCache(pack.id, { songs, misses });
        publishPool(songs, pack.name);
      }
      setPreparing(false);
    }

    async function prepareArtist() {
      setPoolName(artistName);
      setPreparing(true);
      const collected = [];
      await streamArtistPool(artistName, {
        isAborted: () => aborted,
        onSong: (song) => {
          collected.push(song);
          // Republish periodically so the lobby count climbs visibly.
          if (collected.length % 10 === 0) publishPool(collected, artistName);
        },
      });
      if (aborted) return;
      publishPool(collected, artistName);
      setPreparing(false);
    }

    function publishPool(songs, label) {
      const playable = songs.filter((s) => s.previewUrl);
      poolSongs.current = playable;
      setPoolCount(playable.length);
      conn.current?.send("pool", { count: playable.length, poolName: label, locked: false });
    }

    if (packId) preparePack();
    else if (artistName) prepareArtist();
    else setNotice("This room has no pool — the host link is missing a pack or artist.");

    return () => {
      aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, phase, packId, artistName]);

  /* ---------- Render ---------- */

  if (phase === "closed") {
    return (
      <div className="page center">
        <p className="error-msg">{notice}</p>
        <Link href="/" className="btn btn-primary">Back to the game</Link>
      </div>
    );
  }

  if (phase === "naming") {
    return (
      <div className="page center room-naming">
        <h1 className="display">Join room <span className="mono">{code}</span></h1>
        <label className="field">
          <span>Your name</span>
          <input
            type="text"
            value={nameDraft}
            maxLength={20}
            placeholder="What should we call you?"
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && nameDraft.trim()) {
                savePlayerName(nameDraft.trim());
                setName(nameDraft.trim());
              }
            }}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!nameDraft.trim()}
          onClick={() => {
            savePlayerName(nameDraft.trim());
            setName(nameDraft.trim());
          }}
        >
          Join
        </button>
      </div>
    );
  }

  if (phase === "connecting") {
    return (
      <div className="page center">
        <div className="loader" aria-hidden="true" />
        <p className="load-note">Connecting to room {code}…</p>
      </div>
    );
  }

  const full = roster.length >= MAX_PLAYERS;
  const canStart = isHost && roster.length >= MIN_PLAYERS && poolCount >= MIN_POOL_SIZE && !preparing;

  return (
    <div className="page room">
      <div className="room-head">
        <p className="eyebrow">Room code</p>
        <p className="room-code mono">{code}</p>
        <p className="dim">Share this code — or the page link — to let friends in.</p>
      </div>

      <section className="section">
        <p className="eyebrow">
          In the room <span className="dim">· {roster.length}/{MAX_PLAYERS}</span>
        </p>
        <ul className="roster">
          {roster.map((p) => (
            <li key={p.id} className={p.id === meId.current ? "me" : ""}>
              <span className="dot" aria-hidden="true" />
              <span className="roster-name">{p.name}</span>
              {p.isHost && <span className="tag">host</span>}
            </li>
          ))}
        </ul>
        {full && <p className="dim">The room is full.</p>}
      </section>

      <section className="section">
        <p className="eyebrow">Pool</p>
        <p>
          <strong>{poolName || "…"}</strong>
          <span className="dim"> · {poolCount} songs</span>
          {preparing && <span className="dim"> · preparing…</span>}
        </p>
      </section>

      {notice && <p className="error-msg">{notice}</p>}

      {isHost ? (
        <div className="room-actions">
          <label className="field inline">
            <span>Rounds</span>
            <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
              {[5, 10, 15, 20].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-primary" disabled={!canStart}>
            Start game
          </button>
          {!canStart && (
            <p className="dim">
              {preparing
                ? "Waiting for the pool to finish loading…"
                : roster.length < MIN_PLAYERS
                ? `Need at least ${MIN_PLAYERS} players.`
                : "Not enough playable songs yet."}
            </p>
          )}
        </div>
      ) : (
        <p className="dim">Waiting for the host to start…</p>
      )}
    </div>
  );
}
```

The Start button is intentionally inert in this task — Task 8 wires it up.

- [ ] **Step 2: Enforce the player cap**

Rendering "the room is full" isn't enforcement — a ninth player would still be tracked in presence and scored. Add an effect that makes a late arrival bounce itself out. Presence rosters are ordered consistently for everyone, so "am I past the cap" is a decision each client can make alone, without the host arbitrating:

```js
  // Presence gives every client the same roster, so a late arrival can see it's
  // past the cap and leave on its own — no host round-trip needed.
  useEffect(() => {
    if (phase !== "lobby" || isHost) return;
    const idx = roster.findIndex((p) => p.id === meId.current);
    if (idx >= 0 && idx >= MAX_PLAYERS) {
      conn.current?.leave();
      conn.current = null;
      setNotice(`That room is full (${MAX_PLAYERS} players max).`);
      setPhase("closed");
    }
  }, [roster, phase, isHost]);
```

The host is exempt: it can never be the one bounced from its own room.

`useSearchParams` requires a Suspense boundary during static rendering in the App Router. If the build complains, wrap the component body in a child component rendered inside `<Suspense>` from the default export — do **not** switch to reading `window.location`, because unlike `app/callback/page.js` this route legitimately needs reactive params.

- [ ] **Step 3: Verify with two browser profiles**

Open `http://127.0.0.1:3000/room` in a normal window and an incognito/second-profile window (they need separate localStorage for separate player ids).

1. Host from the normal window with a genre pack. Confirm the code shows, the pool name appears, and the count climbs to the pack size.
2. In the second window, go to `/room`, enter the same code, enter a different name, join.
3. Both windows show both players in the roster within a second or two, with `host` tagged on the right one.
4. Start is disabled with one player and becomes enabled once the second joins and the pool has resolved.
5. Close the second window — the host's roster drops back to one within a few seconds.
6. Host with an artist instead and confirm the count climbs while `preparing…` shows.

Report what you actually observed, including roster propagation delay.

To check the cap without opening nine windows, temporarily set `MAX_PLAYERS` to `2` in `lib/roomGame.js`, join with a third window, confirm it bounces with "That room is full", then **restore the value to 8** and re-verify a normal two-player join still works.

- [ ] **Step 4: Commit**

```bash
git add "earworm/app/room/[code]/page.js"
git commit -m "Add room lobby with presence roster and host pool resolution"
```

Before committing, confirm `MAX_PLAYERS` is back to `8` — `git diff earworm/lib/roomGame.js` must be empty.

---

### Task 7: Lobby song contributions

**Files:**
- Modify: `earworm/app/room/[code]/page.js`

**Interfaces:**
- Consumes: `searchGuesses` from `lib/itunes.js`; `MAX_CONTRIBUTIONS_PER_PLAYER`, `dedupeContributions` from `lib/roomGame.js`.
- Produces: host-side `contributions` ref of `[{ song, by, byName }]`, consumed by Task 8's round-list build.

- [ ] **Step 1: Add contribution state and the `add` handler**

In `earworm/app/room/[code]/page.js`, add to the imports:

```js
import { searchGuesses } from "@/lib/itunes";
import { MAX_CONTRIBUTIONS_PER_PLAYER, dedupeContributions } from "@/lib/roomGame";
```

Add state and refs alongside the existing ones:

```js
  const [myAdds, setMyAdds] = useState([]); // only ever this player's own
  const [addQuery, setAddQuery] = useState("");
  const [addResults, setAddResults] = useState([]);
  const [addSearching, setAddSearching] = useState(false);
  const [locked, setLocked] = useState(false);

  const contributions = useRef([]); // host only: [{ song, by, byName }]
  const addDebounce = useRef(null);
```

Extend `handleEvent` to receive additions (host) and lock state (everyone):

```js
  const handleEvent = useCallback((event, payload) => {
    if (event === "pool") {
      setPoolCount(payload.count);
      if (payload.poolName) setPoolName(payload.poolName);
      setLocked(!!payload.locked);
      return;
    }

    if (event === "add" && isHost) {
      // Host is the authority on the pool: enforce the per-player cap here, not
      // just in the sender's UI, then republish the authoritative count.
      const already = contributions.current.filter((c) => c.by === payload.playerId).length;
      if (already >= MAX_CONTRIBUTIONS_PER_PLAYER) return;
      contributions.current.push({
        song: payload.song,
        by: payload.playerId,
        byName: payload.name,
      });
      const clean = dedupeContributions(contributions.current, poolSongs.current);
      contributions.current = clean;
      conn.current?.send("pool", {
        count: poolSongs.current.length + clean.length,
        poolName: poolNameRef.current,
        locked: false,
      });
    }
  }, [isHost]);
```

`poolNameRef` is needed because `handleEvent` is memoized and would otherwise close over a stale `poolName`. Add it next to the other refs and keep it current:

```js
  const poolNameRef = useRef("");
  useEffect(() => { poolNameRef.current = poolName; }, [poolName]);
```

Also update `publishPool` in the host effect so it counts contributions too:

```js
    function publishPool(songs, label) {
      const playable = songs.filter((s) => s.previewUrl);
      poolSongs.current = playable;
      poolNameRef.current = label;
      const total = playable.length + contributions.current.length;
      setPoolCount(total);
      conn.current?.send("pool", { count: total, poolName: label, locked: false });
    }
```

- [ ] **Step 2: Add the search-and-add UI**

Add the debounced catalog search — the same `searchGuesses` path the guess box uses, which returns fully resolved songs so the contributor does the resolving work:

```js
  useEffect(() => {
    const q = addQuery.trim();
    clearTimeout(addDebounce.current);
    if (!q) {
      setAddResults([]);
      setAddSearching(false);
      return;
    }
    setAddSearching(true);
    addDebounce.current = setTimeout(async () => {
      try {
        const found = await searchGuesses(q, { withAlbum: false });
        setAddResults(found.filter((s) => s.previewUrl));
      } catch {
        setAddResults([]);
      } finally {
        setAddSearching(false);
      }
    }, 250);
    return () => clearTimeout(addDebounce.current);
  }, [addQuery]);

  function addSong(song) {
    if (myAdds.length >= MAX_CONTRIBUTIONS_PER_PLAYER || locked) return;
    if (myAdds.some((s) => s.id === song.id)) return;
    setMyAdds((list) => [...list, song]);
    setAddQuery("");
    setAddResults([]);
    conn.current?.send("add", { playerId: meId.current, name, song });
  }
```

There is deliberately no undo. By the time a song appears in "you added", the `add` has already been broadcast and folded into the host's deduped pool, so a remove would need its own unwind path on the host — and an undo that only clears the local list while the song stays in the pool is worse than no undo at all. The per-player cap and the visible count are the guard rails instead. (The spec sketched an undo; it's dropped here, and the spec has been corrected to match.)

Render the section in the lobby, between the Pool section and the actions:

```jsx
      {!locked && (
        <section className="section">
          <p className="eyebrow">
            Add songs <span className="dim">· {myAdds.length}/{MAX_CONTRIBUTIONS_PER_PLAYER}</span>
          </p>
          <p className="dim">
            Sneak in something nobody will get. Nobody sees what you added — and
            if your song comes up as your round, it scores you nothing.
          </p>

          {myAdds.length < MAX_CONTRIBUTIONS_PER_PLAYER && (
            <div className="guess-box">
              <input
                type="text"
                value={addQuery}
                placeholder="Search any song…"
                autoComplete="off"
                onChange={(e) => setAddQuery(e.target.value)}
                aria-label="Search for a song to add"
              />
              {addQuery.trim() && (
                <ul className="suggestions" role="listbox">
                  {addResults.map((s) => (
                    <li key={s.id}>
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); addSong(s); }}>
                        <span className="sg-title">{s.title}</span>
                        <span className="sg-artist">{s.artist}</span>
                      </button>
                    </li>
                  ))}
                  {addResults.length === 0 && (
                    <li className="sg-empty">{addSearching ? "Searching…" : "No songs found."}</li>
                  )}
                </ul>
              )}
            </div>
          )}

          {myAdds.length > 0 && (
            <ul className="my-adds">
              {myAdds.map((s) => (
                <li key={s.id}>
                  <span className="sg-title">{s.title}</span>
                  <span className="sg-artist">{s.artist}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
```

- [ ] **Step 3: Verify**

With two windows in one room:

1. Guest adds a song — the host's pool count increases by 1 in both windows.
2. The guest sees it under "you added"; the **host's window never shows the guest's song title anywhere**. Check this deliberately, including the roster area.
3. Adding the same song twice from the same window is refused (no count change).
4. Adding the same song from both windows increases the count by only 1 (host-side dedupe).
5. Add 10 songs from one window — the search box disappears and the counter reads 10/10.
6. Adding a song that's already in the host's pack does not increase the count.

Check 2 is the one that matters most: rendering another player's contribution anywhere leaks answers.

- [ ] **Step 4: Commit**

```bash
git add "earworm/app/room/[code]/page.js"
git commit -m "Let every player contribute songs to the room pool in the lobby"
```

---

### Task 8: The game loop

**Files:**
- Modify: `earworm/app/room/[code]/page.js`

**Interfaces:**
- Consumes: `RoundBoard` (Task 3); `buildRoundList`, `scoreForResult`, `sortStandings`, `ROUND_CAP_MS` from `lib/roomGame.js`.
- Produces: `scores` and `end` broadcasts consumed by Task 9's scoreboard.

- [ ] **Step 1: Add game state**

Add imports:

```js
import RoundBoard from "@/components/RoundBoard";
import { buildRoundList, scoreForResult, sortStandings, ROUND_CAP_MS } from "@/lib/roomGame";
```

Add state and refs:

```js
  const [round, setRound] = useState(null); // { index, song, startAt, capMs, key }
  const [forceEnd, setForceEnd] = useState(false);
  const [myResult, setMyResult] = useState(null);
  const [totals, setTotals] = useState([]);

  const roundList = useRef([]); // host only
  const roundIndex = useRef(-1); // host only
  const roundResults = useRef(new Map()); // host only: playerId -> result
  const totalsRef = useRef(new Map()); // host only: playerId -> { score, timeMs }
  const rosterRef = useRef([]);
  const capTimer = useRef(null);
  const roundStartedAt = useRef(0);
  const redrawnFor = useRef(-1); // host only: one unplayable redraw per round

  useEffect(() => { rosterRef.current = roster; }, [roster]);
```

`phase` gains `"playing"` and `"ended"`.

- [ ] **Step 2: Host — start the game and drive rounds**

```js
  function startGame() {
    const list = buildRoundList({
      poolSongs: poolSongs.current,
      contributions: contributions.current,
      rounds,
    });
    if (list.length < 1) return;
    roundList.current = list;
    roundIndex.current = -1;
    roundResults.current = new Map();
    totalsRef.current = new Map();
    conn.current?.send("pool", {
      count: poolSongs.current.length + contributions.current.length,
      poolName: poolNameRef.current,
      locked: true,
    });
    conn.current?.send("start", { rounds: list.length, poolName: poolNameRef.current });
    nextRound();
  }

  function nextRound() {
    const i = roundIndex.current + 1;
    if (i >= roundList.current.length) {
      conn.current?.send("end", {
        totals: standingsFromRef(),
        poolName: poolNameRef.current,
        rounds: roundList.current.length,
      });
      return;
    }
    roundIndex.current = i;
    roundResults.current = new Map();
    redrawnFor.current = -1;
    const entry = roundList.current[i];
    conn.current?.send("round", {
      index: i,
      song: entry.song,
      startAt: pickStartOffset(),
      capMs: ROUND_CAP_MS,
    });
  }

  function standingsFromRef() {
    return sortStandings(
      rosterRef.current.map((p) => {
        const t = totalsRef.current.get(p.id) || { score: 0, timeMs: 0 };
        return { id: p.id, name: p.name, score: t.score, timeMs: t.timeMs };
      })
    );
  }
```

`pickStartOffset()` comes from `lib/gameState.js` — add it to the imports. The host picks the offset once and broadcasts it, so everyone hears the identical clip; letting each client roll its own would make the same "song" a different puzzle per player.

```js
import { pickStartOffset } from "@/lib/gameState";
```

- [ ] **Step 3: Host — collect results and close the round**

Extend `handleEvent` with the host-side branches:

```js
    if (event === "done" && isHost) {
      if (payload.roundIndex !== roundIndex.current) return; // stale round
      if (roundResults.current.has(payload.playerId)) return; // first report wins
      roundResults.current.set(payload.playerId, payload);
      maybeCloseRound();
      return;
    }

    if (event === "unplayable" && isHost) {
      // Preview URLs are identical for everyone, so one dead report means the
      // round is dead for all. Redraw once — a second failure would loop.
      if (payload.roundIndex !== roundIndex.current) return;
      if (redrawnFor.current === roundIndex.current) return;
      redrawnFor.current = roundIndex.current;
      const dead = payload.songId;
      poolSongs.current = poolSongs.current.filter((s) => s.id !== dead);
      const replacement = poolSongs.current.find(
        (s) => !roundList.current.some((r) => r.song.id === s.id)
      );
      if (!replacement) return;
      roundList.current[roundIndex.current] = { song: replacement, contributedBy: null };
      roundResults.current = new Map();
      clearTimeout(capTimer.current);
      conn.current?.send("round", {
        index: roundIndex.current,
        song: replacement,
        startAt: pickStartOffset(),
        capMs: ROUND_CAP_MS,
      });
      return;
    }
```

And the close logic:

```js
  function maybeCloseRound() {
    const present = rosterRef.current.map((p) => p.id);
    const allIn = present.every((id) => roundResults.current.has(id));
    if (!allIn) return;
    closeRound();
  }

  function closeRound() {
    clearTimeout(capTimer.current);
    const entry = roundList.current[roundIndex.current];
    const contributedBy = entry?.contributedBy || null;

    const results = rosterRef.current.map((p) => {
      const r = roundResults.current.get(p.id);
      const selfPick = contributedBy === p.id;
      const won = !!r?.won;
      const guessCount = r?.guessCount ?? 6;
      const points = scoreForResult({ won, guessCount, isSelfPick: selfPick });
      const prev = totalsRef.current.get(p.id) || { score: 0, timeMs: 0 };
      totalsRef.current.set(p.id, {
        score: prev.score + points,
        timeMs: prev.timeMs + (r?.ms ?? ROUND_CAP_MS),
      });
      return {
        playerId: p.id, name: p.name, won, guessCount, points,
        selfPick, missing: !r,
      };
    });

    const byName = contributedBy
      ? rosterRef.current.find((p) => p.id === contributedBy)?.name || null
      : null;

    conn.current?.send("scores", {
      index: roundIndex.current,
      contributedBy: byName,
      results,
      totals: standingsFromRef(),
    });
  }
```

Wire the cap timer on the host whenever a round is broadcast, so a player who wandered off can't stall the room. Add to `handleEvent` for the `round` event (host branch):

```js
    if (event === "round") {
      setRound({ key: `${payload.index}-${payload.song.id}-${Date.now()}`, ...payload });
      setForceEnd(false);
      setMyResult(null);
      setPhase("playing");
      roundStartedAt.current = Date.now();
      // Everyone runs their own 60s from their own receipt, so clock skew
      // between phones can't shave anyone's timer.
      clearTimeout(capTimer.current);
      capTimer.current = setTimeout(() => {
        setForceEnd(true);
        if (isHost) closeRound();
      }, payload.capMs);
      return;
    }
```

Note `broadcast: { self: true }` means the host takes this same path — one code path for rendering a round, host and guest alike.

- [ ] **Step 4: Every client — play the round and report**

```js
  function handleRoundFinish({ won, guessCount }) {
    const ms = Date.now() - roundStartedAt.current;
    setMyResult({ won, guessCount });
    conn.current?.send("done", {
      playerId: meId.current,
      roundIndex: round.index,
      won, guessCount, ms,
    });
  }

  function handleRoundUnplayable() {
    conn.current?.send("unplayable", {
      playerId: meId.current,
      roundIndex: round.index,
      songId: round.song.id,
    });
  }
```

Handle `start` and `end` in `handleEvent` for all clients:

```js
    if (event === "start") {
      setLocked(true);
      setTotals([]);
      return;
    }

    if (event === "end") {
      clearTimeout(capTimer.current);
      setTotals(payload.totals);
      setPhase("ended");
      return;
    }
```

Wire the Start button: `onClick={startGame}`.

- [ ] **Step 5: Render the playing phase**

```jsx
  if (phase === "playing" && round) {
    return (
      <div className="page game room-game">
        <div className="game-top">
          <p className="eyebrow">
            Round <strong>{round.index + 1}</strong>
            <span className="dim"> · room {code}</span>
          </p>
        </div>

        <RoundBoard
          key={round.key}
          song={round.song}
          startAt={round.startAt}
          forceEnd={forceEnd}
          onFinish={handleRoundFinish}
          onUnplayable={handleRoundUnplayable}
        >
          {myResult && (
            <p className="room-waiting">
              {myResult.won
                ? `Got it in ${myResult.guessCount}.`
                : "Missed that one."}{" "}
              Waiting for everyone else…
            </p>
          )}
        </RoundBoard>
      </div>
    );
  }
```

- [ ] **Step 6: Verify**

Two windows, one room, a genre pack, 5 rounds:

1. Host presses Start — both windows show round 1 with the same song and the guess box works independently in each.
2. Finish in one window; it shows "Waiting for everyone else…" while the other keeps playing.
3. Finish in the second window — both advance (Task 9 renders the scoreboard, so for now confirm via the browser console that a `scores` broadcast arrived).
4. Let a round hit 60 seconds untouched in one window — it settles as a loss and the game moves on.
5. Confirm the songs across rounds never repeat.

- [ ] **Step 7: Commit**

```bash
git add "earworm/app/room/[code]/page.js"
git commit -m "Add the room game loop: rounds, results, and the 60s cap"
```

---

### Task 9: Scoreboard, game end, and room history

**Files:**
- Create: `earworm/components/Scoreboard.jsx`
- Modify: `earworm/app/room/[code]/page.js`

**Interfaces:**
- Consumes: `scores` / `end` payloads (Task 8); `addRoomHistoryEntry` from `lib/storage.js` (Task 2); `getClient` from `lib/supabase.js` to detect a signed-in user; `setActivePool` from `lib/storage.js`.
- Produces: `<Scoreboard results contributedBy totals meId final />`.

- [ ] **Step 1: Build the component**

Create `earworm/components/Scoreboard.jsx`:

```jsx
"use client";

// Between-round and final standings. `results` is this round's per-player
// outcome (absent on the final board); `totals` is the running order.
export default function Scoreboard({ results, contributedBy, totals, meId, final }) {
  return (
    <div className="card scoreboard">
      {contributedBy && (
        <p className="sb-pick">
          <strong>{contributedBy}</strong>&rsquo;s pick
        </p>
      )}

      {results && (
        <ul className="sb-round">
          {results.map((r) => (
            <li key={r.playerId} className={r.playerId === meId ? "me" : ""}>
              <span className="sb-name">{r.name}</span>
              <span className="sb-detail">
                {r.selfPick
                  ? "own pick"
                  : r.missing
                  ? "ran out of time"
                  : r.won
                  ? `${r.guessCount} ${r.guessCount === 1 ? "guess" : "guesses"}`
                  : "missed"}
              </span>
              <span className="sb-points mono">{r.points > 0 ? `+${r.points}` : "—"}</span>
            </li>
          ))}
        </ul>
      )}

      <ol className="sb-totals">
        {(totals || []).map((p, i) => (
          <li key={p.id} className={p.id === meId ? "me" : ""}>
            <span className="sb-place mono">{i + 1}</span>
            <span className="sb-name">{p.name}</span>
            <span className="sb-points mono">{p.score}</span>
          </li>
        ))}
      </ol>

      {final && <p className="sb-final">Final</p>}
    </div>
  );
}
```

- [ ] **Step 2: Handle `scores` and auto-advance**

In the room page, add state:

```js
  const [lastScores, setLastScores] = useState(null); // { index, contributedBy, results, totals }
  const [totalRounds, setTotalRounds] = useState(0);
  const advanceTimer = useRef(null);

  // The host knows the round count and pool spec from its own state, but guests
  // only learn them from the `start` broadcast — and every client needs both to
  // render "round 3 of 10" and to save room history. Keep them in a ref because
  // the memoized event handler would otherwise close over stale values.
  const poolSpecRef = useRef(null);
```

Extend the `start` branch added in Task 8 to record both:

```js
    if (event === "start") {
      setLocked(true);
      setTotals([]);
      setTotalRounds(payload.rounds);
      poolSpecRef.current = payload.poolSpec;
      return;
    }
```

And extend `startGame` in Task 8 to broadcast the spec, so guests can save history and replay the pool solo:

```js
    conn.current?.send("start", {
      rounds: list.length,
      poolName: poolNameRef.current,
      poolSpec: packId ? { type: "pack", id: packId } : { type: "artist", name: artistName },
    });
```

Add the handler branch:

```js
    if (event === "scores") {
      clearTimeout(capTimer.current);
      setLastScores(payload);
      setTotals(payload.totals);
      setPhase("scores");
      if (isHost) {
        clearTimeout(advanceTimer.current);
        advanceTimer.current = setTimeout(() => nextRound(), 8000);
      }
      return;
    }
```

Clear both timers on unmount so a leaving host can't fire a round into a dead channel:

```js
  useEffect(() => () => {
    clearTimeout(capTimer.current);
    clearTimeout(advanceTimer.current);
  }, []);
```

- [ ] **Step 3: Render the scores and ended phases**

```jsx
  if (phase === "scores" && lastScores) {
    return (
      <div className="page room-scores">
        <p className="eyebrow">
          Round {lastScores.index + 1} of {totalRounds}
        </p>
        <Scoreboard
          results={lastScores.results}
          contributedBy={lastScores.contributedBy}
          totals={lastScores.totals}
          meId={meId.current}
        />
        {isHost ? (
          <button type="button" className="btn btn-primary" onClick={() => {
            clearTimeout(advanceTimer.current);
            nextRound();
          }}>
            Next round
          </button>
        ) : (
          <p className="dim">Next round in a moment…</p>
        )}
      </div>
    );
  }

  if (phase === "ended") {
    return (
      <div className="page room-ended">
        <h1 className="display">
          {totals[0]?.id === meId.current ? "You won." : `${totals[0]?.name || "Nobody"} wins.`}
        </h1>
        <Scoreboard totals={totals} meId={meId.current} final />
        <div className="room-actions">
          {isHost && (
            <button type="button" className="btn btn-primary" onClick={startGame}>
              Play again
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={replayPoolSolo}>
            Replay this pool solo
          </button>
          <Link href="/" className="link-quiet">Back to the game</Link>
        </div>
      </div>
    );
  }
```

`totalRounds` (not `roundList.current.length`) is deliberate: `roundList` is host-only state, so a guest would render "round 3 of 0".

- [ ] **Step 4: Write room history on game end**

Add to the room page:

```js
  import { addRoomHistoryEntry, setActivePool } from "@/lib/storage";
  import { getClient } from "@/lib/supabase";
```

In the `end` branch of `handleEvent`, after setting phase, call:

```js
      // Signed-in players keep the room; guests don't. This is the concrete
      // reason to have an account.
      recordRoomHistory(payload);
```

defined as:

```js
  async function recordRoomHistory(payload) {
    const client = getClient();
    if (!client) return;
    const { data } = await client.auth.getSession();
    if (!data?.session?.user) return; // guests persist nothing

    const standings = payload.totals || [];
    const mine = standings.findIndex((p) => p.id === meId.current);
    addRoomHistoryEntry({
      code,
      endedAt: Date.now(),
      poolName: payload.poolName || poolNameRef.current,
      poolSpec: poolSpecRef.current,
      rounds: payload.rounds,
      players: standings.map((p) => ({ name: p.name, score: p.score })),
      you: { score: standings[mine]?.score ?? 0, place: mine >= 0 ? mine + 1 : null },
    });
  }
```

Reading `poolSpecRef` rather than the URL params is required, not stylistic: only the host's URL carries `?pack=` or `?artist=`, so a guest deriving the spec locally would save `{ type: "artist", name: null }` and its "replay solo" button would break.

- [ ] **Step 5: Add "Replay this pool solo"**

```js
  function replayPoolSolo() {
    if (!poolSpecRef.current) return;
    setActivePool(poolSpecRef.current);
    router.push("/play");
  }
```

- [ ] **Step 6: Verify**

Two windows, 3 rounds, one contributed song from each player:

1. After a round, both windows show the same scoreboard with matching points.
2. A player who won in 2 guesses shows `+5`; 1 guess shows `+6`; a miss shows `—`.
3. When a contributed song comes up, the board captions it with the contributor's name **and only after the round**, and that player's row reads "own pick" with `—` points.
4. Auto-advance fires after ~8 seconds; the host's "Next round" cuts it short for everyone.
5. After the last round, the final board shows and the winner line names the right player.
6. Signed in on one window: after the game, `localStorage.getItem("earworm-room-history")` has one entry with the right code, scores, and `poolSpec`. Signed out: the key is absent or unchanged.
7. "Replay this pool solo" loads `/play` with the same pack.

- [ ] **Step 7: Commit**

```bash
git add earworm/components/Scoreboard.jsx "earworm/app/room/[code]/page.js"
git commit -m "Add room scoreboards, game end, and saved room history"
```

---

### Task 10: Rejoin and disconnect handling

**Files:**
- Modify: `earworm/app/room/[code]/page.js`

**Interfaces:**
- Consumes: the `sync` event from `ROOM_EVENTS`.
- Produces: no new exports.

- [ ] **Step 1: Host sends state to a new arrival**

The host detects a roster addition after the game has started and replies with the current state.

```js
  const knownIds = useRef(new Set());

  const handleRoster = useCallback((players) => {
    setRoster(players);
    if (!isHost) return;
    for (const p of players) {
      if (knownIds.current.has(p.id)) continue;
      knownIds.current.add(p.id);
      if (roundIndex.current < 0) continue; // still in the lobby, nothing to sync
      conn.current?.send("sync", {
        toPlayerId: p.id,
        phase: "playing",
        totalRounds: roundList.current.length,
        poolName: poolNameRef.current,
        poolSpec: packId ? { type: "pack", id: packId } : { type: "artist", name: artistName },
        index: roundIndex.current,
        song: roundList.current[roundIndex.current]?.song,
        startAt: 0,
        capMs: ROUND_CAP_MS,
        totals: standingsFromRef(),
      });
    }
    // Someone left mid-round — stop waiting on them.
    const present = new Set(players.map((p) => p.id));
    for (const id of [...knownIds.current]) {
      if (!present.has(id)) knownIds.current.delete(id);
    }
    if (roundIndex.current >= 0 && phaseRef.current === "playing") maybeCloseRound();
  }, [isHost, packId, artistName]);
```

Pass `onRoster: handleRoster` to `joinRoom` instead of `setRoster`. Add `phaseRef` kept in sync with `phase` the same way `poolNameRef` is, since this callback is memoized.

`startAt: 0` on a resync is deliberate — a rejoining player gets the clip from the start rather than a random offset they never heard.

- [ ] **Step 2: Client applies `sync`**

```js
    if (event === "sync") {
      if (payload.toPlayerId !== meId.current) return; // addressed to someone else
      setTotalRounds(payload.totalRounds);
      setPoolName(payload.poolName);
      poolNameRef.current = payload.poolName;
      poolSpecRef.current = payload.poolSpec;
      setTotals(payload.totals || []);
      setLocked(true);
      setRound({
        key: `sync-${payload.index}-${Date.now()}`,
        index: payload.index, song: payload.song,
        startAt: payload.startAt, capMs: payload.capMs,
      });
      setForceEnd(false);
      setMyResult(null);
      setPhase("playing");
      roundStartedAt.current = Date.now();
      clearTimeout(capTimer.current);
      capTimer.current = setTimeout(() => setForceEnd(true), payload.capMs);
      return;
    }
```

- [ ] **Step 3: Detect the host leaving**

Every client watches for the host disappearing from the roster:

```js
  useEffect(() => {
    if (isHost || phase === "connecting" || phase === "naming") return;
    if (roster.length === 0) return; // presence not settled yet
    if (roster.some((p) => p.isHost)) return;
    clearTimeout(capTimer.current);
    setNotice("The host ended the room.");
    setPhase("closed");
  }, [roster, isHost, phase]);
```

And the host sees an empty room:

```js
  useEffect(() => {
    if (!isHost || phase === "connecting" || phase === "naming") return;
    if (roster.length > 1) return;
    if (phase === "playing" || phase === "scores") {
      setNotice("Everyone left the room.");
    }
  }, [roster, isHost, phase]);
```

- [ ] **Step 4: Verify**

1. Mid-game, refresh the guest window. It rejoins with the same name, lands in the current round, and its score continues from where it was (check the next scoreboard).
2. Mid-round, close the guest window. The host stops waiting and the round closes within a few seconds instead of hanging for the full 60.
3. Mid-game, close the host window. The guest shows "The host ended the room."
4. Rejoin after the host left — the guest sees the closed state, not a hang.

- [ ] **Step 5: Commit**

```bash
git add "earworm/app/room/[code]/page.js"
git commit -m "Handle room rejoin, player drops, and host departure"
```

---

### Task 11: Styles, entry points, and documentation

**Files:**
- Modify: `earworm/app/globals.css`, `earworm/app/page.js`, `earworm/CLAUDE.md`

- [ ] **Step 1: Add the styles**

Append to `earworm/app/globals.css`, using existing tokens only:

```css
/* ---------- Multiplayer rooms ---------- */

.room-code {
  font-size: 3rem;
  letter-spacing: 0.28em;
  color: var(--accent);
  margin: 0.2rem 0 0.4rem;
}

.code-input {
  text-transform: uppercase;
  letter-spacing: 0.28em;
  text-align: center;
  font-size: 1.4rem;
}

.join-form {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  flex-wrap: wrap;
}

.roster {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.roster li {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  background: var(--surface-2);
  border-radius: 999px;
  padding: 0.35rem 0.8rem;
}

.roster li.me {
  outline: 1px solid var(--accent);
}

.roster .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--win);
}

.roster .tag {
  font-size: 0.72rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.my-adds {
  list-style: none;
  padding: 0;
  margin: 0.7rem 0 0;
  display: grid;
  gap: 0.3rem;
}

.my-adds li {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  color: var(--muted);
  font-size: 0.92rem;
}

.scoreboard {
  display: grid;
  gap: 0.9rem;
}

.sb-pick {
  color: var(--accent);
  margin: 0;
}

.sb-round,
.sb-totals {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 0.35rem;
}

.sb-round li,
.sb-totals li {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 0.7rem;
  align-items: baseline;
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--surface-2);
}

.sb-round li {
  grid-template-columns: 1fr auto auto;
}

.sb-round li.me,
.sb-totals li.me {
  color: var(--ink);
  font-weight: 600;
}

.sb-detail {
  color: var(--muted);
  font-size: 0.9rem;
}

.sb-points {
  color: var(--win);
}

.sb-final {
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.78rem;
  margin: 0;
}

.room-waiting {
  color: var(--muted);
  text-align: center;
  margin: 1rem 0 0;
}

.room-actions {
  display: flex;
  gap: 0.7rem;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 1rem;
}

@media (max-width: 520px) {
  .room-code {
    font-size: 2.2rem;
  }
}
```

Check the actual token names at the top of `globals.css` before saving — if surfaces are named something other than `--surface-2`, use the real names. Do not introduce new tokens.

- [ ] **Step 2: Add the home-page entry**

In `earworm/app/page.js`, add a "Play with friends" call to action, rendered only when rooms are available. Import `isRoomsEnabled` from `@/lib/room` and hold it in state set inside an effect (it reads env-derived config, and the page is SSR'd):

```js
  const [roomsOn, setRoomsOn] = useState(false);
  useEffect(() => { setRoomsOn(isRoomsEnabled()); }, []);
```

Render near the top of the page, in the same visual style as the existing primary actions:

```jsx
      {roomsOn && (
        <section className="section">
          <p className="eyebrow">With friends</p>
          <Link href="/room" className="btn btn-primary">
            Play with friends
          </Link>
          <p className="dim">
            Host a room, share the code, everyone adds songs and guesses together.
          </p>
        </section>
      )}
```

Match the surrounding markup's class names and placement — read the file and follow its existing structure rather than pasting this verbatim.

- [ ] **Step 3: Document it in CLAUDE.md**

Add a `## Multiplayer rooms` section to `earworm/CLAUDE.md` after the "Song identity rules" section, covering: channel-per-room with no table, host-as-authority and what breaks if the host leaves, the deliberate absence of anti-cheat, the pool-secrecy rule, lobby-only contributions with the 10-per-player cap, the half-and-half round list, `7 − N` scoring with self-picks at zero, the 60s cap measured per client, and the fact that multiplayer requires the Supabase env vars. Also add `earworm-room-history` and `earworm-player-name`/`earworm-player-id` to the storage-keys description in the `lib/storage.js` bullet, and note the new fourth synced key in the `lib/sync.js` bullet.

- [ ] **Step 4: Build and verify**

Stop the dev server first — building while it runs corrupts `.next`.

```bash
cd earworm && npm run build
```

Expected: a clean build. Then `npm run dev` and walk one complete game end to end in two windows: host a pack room, join, both add two songs, play 5 rounds, reach the final board.

- [ ] **Step 5: Commit**

```bash
git add earworm/app/globals.css earworm/app/page.js earworm/CLAUDE.md
git commit -m "Style multiplayer rooms, add the home entry point, and document it"
```

---

## Verification summary

| Layer | How it's verified |
|---|---|
| `lib/roomGame.js` | Node script, 17 checks (Task 1) |
| Room history merge | Node script (Task 2) |
| `RoundBoard` extraction | Manual solo regression, 6 checks (Task 3) |
| `lib/room.js` transport | Two-client Node script against the real project (Task 4) |
| Lobby, contributions, game, scores, rejoin | Two browser profiles, per-task checklists (Tasks 5-10) |
| Whole feature | `npm run build` plus one full game (Task 11) |

## Known limitations (intended, not bugs)

- Closing the host tab ends the room. No host migration.
- No cheat prevention; clients know the answer and self-report.
- Contributions cannot be undone once added.
- No per-player "still guessing" indicator during a round.
- Rooms need `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in Vercel.
