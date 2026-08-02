# Superfan Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second multiplayer room mode where every player claims their own artist, plays mastery rounds on it, then defends it in a shared crossover finale where outsiders who beat the owner score double.

**Architecture:** Host authority moves out of `app/room/[code]/page.js` into a plain React-free `lib/roomHost.js` engine that serves both modes and is testable under plain Node. The engine emits *directives* (`{ event, payload }`) that the page broadcasts verbatim, so the page becomes wiring rather than game logic. Mastery rounds deliberately carry no song — each client picks its own from its own pool using the existing shuffle bag.

**Tech Stack:** Next.js 15 App Router, plain JavaScript, React 19, hand-rolled CSS, `@supabase/supabase-js` Realtime. No new dependencies.

## Global Constraints

- **Plain JavaScript only.** No TypeScript, no Tailwind, no test framework, no new npm dependencies. Deliberate project policy.
- **No test suite exists.** Pure logic is verified with throwaway Node scripts in the scratchpad; UI is verified by hand. Never claim a UI task is verified without running it.
- **Node scripts need explicit `.js` import extensions.** `lib/roomGame.js` and `lib/room.js` already use them for this reason; `lib/roomHost.js` must too. Next accepts either form, plain `node` only resolves the explicit one.
- **Scratchpad test scripts must import via an absolute `file:///` URL** — relative imports resolve against the *script's* directory, not the cwd.
- **Never run `npm run build` while `npm run dev` is running** — they share `.next`. Kill the dev server first, and verify port 3000 is actually free (stopping the shell does not always kill the node child).
- **Dev server is `http://127.0.0.1:3000`, not `localhost`.**
- **The pool is never rendered.** Only counts. Showing pool titles puts answers on screen.
- **Design system is "Nocturne."** Only existing tokens in `app/globals.css`: `--accent` `#a98bff`, `--accent-wash`, `--win` `#5ee6a8`, `--wrong` `#ff6b6b`, `--surface` `#16131f`, `--surface-2` `#1f1a2b`, `--ink` `#f3eef9`, `--muted` `#9c95ad`, `--line`, `--radius`, `--radius-sm`, `--pill`, `--glow`, `--font-display`, `--font-mono`. Do not invent tokens or class names — check that a class exists before using it.
- **Fixed values:** `MIN_SUPERFAN_POOL = 15`, depth caps Hits 25 / Standard 60 / Deep cuts unlimited, crossover minimum 2 rounds, mastery minimum 1 round, sample size 6 songs per player, existing `ROUND_CAP_MS = 60000`, `MAX_PLAYERS = 8`, `MIN_PLAYERS = 2`.
- **Scoring:** mastery is the existing `7 − N`. Crossover: owner scores `7 − N`; a non-owner who won with strictly fewer guesses than the owner (or when the owner missed) scores double; other winners score normally; nobody wins means nobody scores.
- Commit after every task.

## File Structure

**Create:**
- `earworm/lib/roomHost.js` — host-authority engine for both modes. No React, no Supabase, no DOM. Emits directives.
- `earworm/components/SuperfanLobby.jsx` — artist claim UI, claim roster, depth selector, ready state.

**Modify:**
- `earworm/lib/roomGame.js` — `splitPhases`, `buildCrossoverList`, `scoreFinaleRound`, superfan constants.
- `earworm/lib/room.js` — three new event names.
- `earworm/app/room/[code]/page.js` — host logic replaced by the engine; superfan mode branch.
- `earworm/components/Scoreboard.jsx` — steal badge and owner marker.
- `earworm/app/room/page.js` — Superfan as a third hosting option.
- `earworm/app/globals.css` — claim list, steal badge.
- `earworm/CLAUDE.md` — document the mode.

**Unchanged:** `components/RoundBoard.jsx`, `lib/gameState.js`, `lib/storage.js`, `lib/sync.js`, all of solo play.

---

### Task 1: Superfan pure functions

Pure additions to the existing pure module. No I/O, so they get real Node coverage.

**Files:**
- Modify: `earworm/lib/roomGame.js`
- Test: `<scratchpad>/superfan.test.mjs`

**Interfaces:**
- Consumes: existing `shuffled`, `scoreForResult`, `MAX_GUESSES` from `lib/roomGame.js`.
- Produces:
  - `MIN_SUPERFAN_POOL = 15`, `SUPERFAN_SAMPLE_SIZE = 6`, `DEPTH_CAPS = { hits: 25, standard: 60, deep: Infinity }`
  - `splitPhases(rounds) -> { mastery, finale }`
  - `buildCrossoverList(samples, count, random?) -> [{ kind: "round", song, ownerId, contributedBy: null }]` where `samples` is `[{ playerId, songs }]`
  - `scoreFinaleRound(results, ownerId) -> results` — each entry gains `points`, `stole`, `isOwner`

- [ ] **Step 1: Write the failing test**

Create `<scratchpad>/superfan.test.mjs`:

```js
import assert from "node:assert/strict";
import {
  splitPhases, buildCrossoverList, scoreFinaleRound,
  MIN_SUPERFAN_POOL, SUPERFAN_SAMPLE_SIZE, DEPTH_CAPS,
} from "file:///C:/Users/yinin/Downloads/earworm/earworm/lib/roomGame.js";

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { console.error("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; }
}
const song = (id) => ({ id, title: "T" + id, artist: "A", previewUrl: "x" });
const res = (playerId, won, guessCount) => ({ playerId, name: playerId, won, guessCount });

check("phases split roughly two thirds / one third", () => {
  assert.deepEqual(splitPhases(10), { mastery: 7, finale: 3 });
  assert.deepEqual(splitPhases(15), { mastery: 10, finale: 5 });
});

check("the longest game leaves fewer mastery rounds than the pool minimum", () => {
  const { mastery } = splitPhases(20);
  assert.ok(mastery < MIN_SUPERFAN_POOL,
    `mastery ${mastery} must stay under MIN_SUPERFAN_POOL ${MIN_SUPERFAN_POOL} or the shuffle bag wraps`);
});

check("finale never drops below two rounds", () => {
  for (const r of [3, 4, 5, 6]) {
    const { mastery, finale } = splitPhases(r);
    assert.ok(finale >= 2, `rounds=${r} gave finale=${finale}`);
    assert.ok(mastery >= 1, `rounds=${r} gave mastery=${mastery}`);
    assert.equal(mastery + finale, r);
  }
});

check("crossover rotates between owners", () => {
  const samples = [
    { playerId: "sam", songs: [song("s1"), song("s2"), song("s3")] },
    { playerId: "ali", songs: [song("a1"), song("a2"), song("a3")] },
  ];
  const list = buildCrossoverList(samples, 4);
  assert.equal(list.length, 4);
  const owners = list.map((r) => r.ownerId);
  assert.notEqual(owners[0], owners[1], "two consecutive rounds had the same owner");
  assert.notEqual(owners[1], owners[2], "two consecutive rounds had the same owner");
});

check("crossover never repeats a song", () => {
  const samples = [
    { playerId: "sam", songs: [song("s1"), song("s2")] },
    { playerId: "ali", songs: [song("a1"), song("a2")] },
  ];
  const list = buildCrossoverList(samples, 4);
  assert.equal(new Set(list.map((r) => r.song.id)).size, list.length);
});

check("crossover stops short rather than inventing rounds", () => {
  const samples = [{ playerId: "sam", songs: [song("s1")] }];
  assert.equal(buildCrossoverList(samples, 5).length, 1);
});

check("owner who wins scores normally", () => {
  const out = scoreFinaleRound([res("sam", true, 2)], "sam");
  assert.equal(out[0].points, 5);
  assert.equal(out[0].stole, false);
  assert.equal(out[0].isOwner, true);
});

check("outsider who beats the owner scores double", () => {
  const out = scoreFinaleRound([res("sam", true, 4), res("jo", true, 2)], "sam");
  const jo = out.find((r) => r.playerId === "jo");
  assert.equal(jo.stole, true);
  assert.equal(jo.points, 10, "won on guess 2 = 5 points, doubled");
});

check("outsider who ties the owner does NOT steal", () => {
  const out = scoreFinaleRound([res("sam", true, 3), res("jo", true, 3)], "sam");
  const jo = out.find((r) => r.playerId === "jo");
  assert.equal(jo.stole, false);
  assert.equal(jo.points, 4);
});

check("outsider slower than the owner scores normally", () => {
  const out = scoreFinaleRound([res("sam", true, 2), res("jo", true, 5)], "sam");
  const jo = out.find((r) => r.playerId === "jo");
  assert.equal(jo.stole, false);
  assert.equal(jo.points, 2);
});

check("owner misses, so any winner steals", () => {
  const out = scoreFinaleRound([res("sam", false, 6), res("jo", true, 5)], "sam");
  const jo = out.find((r) => r.playerId === "jo");
  assert.equal(jo.stole, true);
  assert.equal(jo.points, 4);
  assert.equal(out.find((r) => r.playerId === "sam").points, 0);
});

check("nobody wins, nobody scores", () => {
  const out = scoreFinaleRound([res("sam", false, 6), res("jo", false, 6)], "sam");
  assert.ok(out.every((r) => r.points === 0));
  assert.ok(out.every((r) => r.stole === false));
});

check("an owner who left the room does not break scoring", () => {
  const out = scoreFinaleRound([res("jo", true, 3)], "sam");
  const jo = out.find((r) => r.playerId === "jo");
  assert.equal(jo.stole, true, "absent owner counts as a miss");
  assert.equal(jo.points, 8);
});

check("constants are the agreed values", () => {
  assert.equal(MIN_SUPERFAN_POOL, 15);
  assert.equal(SUPERFAN_SAMPLE_SIZE, 6);
  assert.equal(DEPTH_CAPS.hits, 25);
  assert.equal(DEPTH_CAPS.standard, 60);
  assert.equal(DEPTH_CAPS.deep, Infinity);
});

console.log("\n" + passed + " checks passed");
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node "$SCRATCHPAD/superfan.test.mjs"
```

Expected: FAIL — `splitPhases` is not exported.

- [ ] **Step 3: Implement**

Append to `earworm/lib/roomGame.js`:

```js
/* ---------------- Superfan mode ---------------- */

// The longest game a host can pick is 20 rounds, which splits to 13 mastery
// rounds. A pool smaller than that would exhaust the shuffle bag and start
// repeating songs inside one game, so the floor sits just above it.
export const MIN_SUPERFAN_POOL = 15;

// How many songs each player contributes to the crossover finale.
export const SUPERFAN_SAMPLE_SIZE = 6;

// One room-wide depth, applied to every player equally — that equality is what
// keeps a 30-song artist comparable to a 400-song one.
export const DEPTH_CAPS = { hits: 25, standard: 60, deep: Infinity };

// Roughly two thirds mastery, one third crossover. The finale needs at least two
// rounds to feel like a finale, and mastery needs at least one to mean anything.
export function splitPhases(rounds) {
  const total = Math.max(3, rounds || 0);
  let finale = Math.max(2, Math.round(total / 3));
  let mastery = total - finale;
  if (mastery < 1) {
    mastery = 1;
    finale = total - 1;
  }
  return { mastery, finale };
}

// Round-robin through the owners so no two consecutive rounds belong to the same
// player. `samples` is [{ playerId, songs }]. Stops short if the samples run out
// rather than repeating a song.
export function buildCrossoverList(samples, count, random = Math.random) {
  const queues = shuffled(samples || [], random)
    .filter((s) => s && s.songs?.length)
    .map((s) => ({ playerId: s.playerId, songs: shuffled(s.songs, random) }));
  if (!queues.length) return [];

  const out = [];
  let i = 0;
  while (out.length < count && queues.some((q) => q.songs.length)) {
    const q = queues[i % queues.length];
    const song = q.songs.shift();
    if (song) out.push({ kind: "round", song, ownerId: q.playerId, contributedBy: null });
    i++;
  }
  return out;
}

// Crossover scoring. The owner is meant to get their own artist, so they score
// normally — the drama is an outsider beating them on their own turf, which pays
// double. An owner who left the room counts as a miss, so everyone can steal.
export function scoreFinaleRound(results, ownerId) {
  const owner = (results || []).find((r) => r.playerId === ownerId);
  const ownerGuesses = owner?.won ? owner.guessCount : Infinity;

  return (results || []).map((r) => {
    const isOwner = r.playerId === ownerId;
    if (!r.won) return { ...r, points: 0, stole: false, isOwner };
    const base = scoreForResult({ won: true, guessCount: r.guessCount });
    if (isOwner) return { ...r, points: base, stole: false, isOwner };
    const stole = r.guessCount < ownerGuesses;
    return { ...r, points: stole ? base * 2 : base, stole, isOwner };
  });
}
```

- [ ] **Step 4: Run the test**

```bash
node "$SCRATCHPAD/superfan.test.mjs"
```

Expected: `13 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add earworm/lib/roomGame.js
git commit -m "Add superfan scoring, phase split, and crossover round list"
```

---

### Task 2: Extract the host engine (`lib/roomHost.js`)

Pure refactor of working code. The existing shared-pool mode must behave **identically** afterward. Superfan support goes in the same engine because the two modes share the results/standings machinery — but no superfan behavior is wired to the UI in this task.

**Files:**
- Create: `earworm/lib/roomHost.js`
- Modify: `earworm/app/room/[code]/page.js`
- Test: `<scratchpad>/roomHost.test.mjs`

**Interfaces:**
- Consumes: `buildRoundList`, `buildCrossoverList`, `splitPhases`, `scoreForResult`, `scoreFinaleRound`, `sortStandings`, `ROUND_CAP_MS` from `lib/roomGame.js`; `pickStartOffset` from `lib/gameState.js`.
- Produces `createHost(options) -> host` with:
  - `setPool(songs)`, `addContribution({ song, by, byName })`, `contributionCount(playerId)`, `poolSize()`
  - `setSample(playerId, songs)`, `sampleCount()`
  - `start({ rounds, claims }) -> directive`
  - `next() -> directive`
  - `record(report) -> void`, `hasAllReports(playerIds) -> boolean`
  - `close(roster) -> directive`
  - `replaceDeadSong(songId) -> directive | null`
  - `standings(roster) -> [{ id, name, score, timeMs }]`
  - `roundIndex() -> number`, `totalRounds() -> number`, `currentEntry() -> entry | null`
- A **directive** is `{ event, payload }` ready to hand straight to `conn.send(event, payload)`. `event` is one of `"mastery"`, `"round"`, `"scores"`, `"end"`.

- [ ] **Step 1: Write the failing test**

Create `<scratchpad>/roomHost.test.mjs`:

```js
import assert from "node:assert/strict";
import { createHost } from "file:///C:/Users/yinin/Downloads/earworm/earworm/lib/roomHost.js";

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { console.error("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; }
}
const song = (id) => ({ id, title: "T" + id, artist: "A", previewUrl: "x" });
const roster = (...ids) => ids.map((id) => ({ id, name: id.toUpperCase(), isHost: id === "sam" }));

check("shared mode: a full game runs to an end directive", () => {
  const host = createHost({ mode: "shared" });
  host.setPool(Array.from({ length: 30 }, (_, i) => song("p" + i)));
  const people = roster("sam", "jo");

  let d = host.start({ rounds: 5 });
  assert.equal(d.event, "round");
  assert.equal(d.payload.index, 0);
  assert.ok(d.payload.song, "a shared round must carry its song");
  assert.ok(typeof d.payload.capMs === "number");

  for (let r = 0; r < 5; r++) {
    host.record({ playerId: "sam", roundIndex: r, won: true, guessCount: 1, ms: 1000 });
    host.record({ playerId: "jo", roundIndex: r, won: false, guessCount: 6, ms: 60000 });
    assert.equal(host.hasAllReports(["sam", "jo"]), true);
    const scores = host.close(people);
    assert.equal(scores.event, "scores");
    d = host.next();
  }
  assert.equal(d.event, "end");
  const totals = d.payload.totals;
  assert.equal(totals[0].id, "sam");
  assert.equal(totals[0].score, 30, "5 rounds won on guess 1 = 5 x 6");
  assert.equal(totals[1].score, 0);
});

check("shared mode: a stale or duplicate report is ignored", () => {
  const host = createHost({ mode: "shared" });
  host.setPool(Array.from({ length: 10 }, (_, i) => song("p" + i)));
  host.start({ rounds: 3 });
  host.record({ playerId: "sam", roundIndex: 0, won: true, guessCount: 1, ms: 100 });
  host.record({ playerId: "sam", roundIndex: 0, won: true, guessCount: 6, ms: 100 }); // duplicate
  host.record({ playerId: "sam", roundIndex: 9, won: true, guessCount: 1, ms: 100 }); // stale
  const out = host.close(roster("sam"));
  assert.equal(out.payload.results[0].guessCount, 1, "first report must win");
});

check("shared mode: a contributed song zeroes its contributor", () => {
  const host = createHost({ mode: "shared" });
  host.setPool([]);
  host.addContribution({ song: song("c1"), by: "jo", byName: "JO" });
  host.addContribution({ song: song("c2"), by: "jo", byName: "JO" });
  const d = host.start({ rounds: 2 });
  const owner = d.payload.contributedBy;
  assert.equal(owner, "jo");
  host.record({ playerId: "jo", roundIndex: 0, won: true, guessCount: 1, ms: 100 });
  host.record({ playerId: "sam", roundIndex: 0, won: true, guessCount: 3, ms: 100 });
  const out = host.close(roster("sam", "jo"));
  const jo = out.payload.results.find((r) => r.playerId === "jo");
  assert.equal(jo.points, 0, "you don't score on a song you added");
  assert.equal(jo.selfPick, true);
});

check("superfan mode: mastery rounds carry no song", () => {
  const host = createHost({ mode: "superfan" });
  host.setSample("sam", [song("s1"), song("s2"), song("s3")]);
  host.setSample("jo", [song("j1"), song("j2"), song("j3")]);
  const d = host.start({ rounds: 6, claims: { sam: "Drake", jo: "Adele" } });
  assert.equal(d.event, "mastery");
  assert.equal(d.payload.index, 0);
  assert.equal(d.payload.song, undefined, "a mastery round must never broadcast a song");
});

check("superfan mode: the game switches to crossover rounds", () => {
  const host = createHost({ mode: "superfan" });
  host.setSample("sam", [song("s1"), song("s2"), song("s3")]);
  host.setSample("jo", [song("j1"), song("j2"), song("j3")]);
  const people = roster("sam", "jo");
  let d = host.start({ rounds: 6, claims: { sam: "Drake", jo: "Adele" } });

  const kinds = [d.event];
  for (let r = 0; r < 6; r++) {
    host.record({ playerId: "sam", roundIndex: r, won: true, guessCount: 2, ms: 100 });
    host.record({ playerId: "jo", roundIndex: r, won: true, guessCount: 2, ms: 100 });
    host.close(people);
    d = host.next();
    kinds.push(d.event);
  }
  assert.equal(kinds.filter((k) => k === "mastery").length, 4);
  assert.equal(kinds.filter((k) => k === "round").length, 2);
  assert.equal(kinds[kinds.length - 1], "end");
});

check("superfan mode: crossover rounds name their owner and artist", () => {
  const host = createHost({ mode: "superfan" });
  host.setSample("sam", [song("s1"), song("s2"), song("s3")]);
  host.setSample("jo", [song("j1"), song("j2"), song("j3")]);
  const people = roster("sam", "jo");
  let d = host.start({ rounds: 6, claims: { sam: "Drake", jo: "Adele" } });
  let crossover = null;
  for (let r = 0; r < 6 && !crossover; r++) {
    host.record({ playerId: "sam", roundIndex: r, won: true, guessCount: 2, ms: 100 });
    host.record({ playerId: "jo", roundIndex: r, won: true, guessCount: 2, ms: 100 });
    host.close(people);
    d = host.next();
    if (d.event === "round") crossover = d;
  }
  assert.ok(crossover, "never reached a crossover round");
  assert.ok(crossover.payload.song, "a crossover round must carry its song");
  assert.ok(crossover.payload.ownerId);
  assert.ok(["Drake", "Adele"].includes(crossover.payload.artist));
  assert.equal(crossover.payload.ownerName, crossover.payload.ownerId.toUpperCase());
});

check("superfan mode: stealing doubles points in the standings", () => {
  const host = createHost({ mode: "superfan" });
  host.setSample("sam", [song("s1"), song("s2")]);
  host.setSample("jo", [song("j1"), song("j2")]);
  const people = roster("sam", "jo");
  let d = host.start({ rounds: 3, claims: { sam: "Drake", jo: "Adele" } });
  // rounds=3 -> 1 mastery, 2 crossover
  for (let r = 0; r < 3; r++) {
    const entry = host.currentEntry();
    if (entry.kind === "round") {
      const owner = entry.ownerId;
      const other = owner === "sam" ? "jo" : "sam";
      host.record({ playerId: owner, roundIndex: r, won: true, guessCount: 4, ms: 100 });
      host.record({ playerId: other, roundIndex: r, won: true, guessCount: 1, ms: 100 });
      const out = host.close(people);
      const thief = out.payload.results.find((x) => x.playerId === other);
      assert.equal(thief.stole, true);
      assert.equal(thief.points, 12, "guess 1 = 6 points, doubled for the steal");
    } else {
      host.record({ playerId: "sam", roundIndex: r, won: false, guessCount: 6, ms: 100 });
      host.record({ playerId: "jo", roundIndex: r, won: false, guessCount: 6, ms: 100 });
      host.close(people);
    }
    d = host.next();
  }
  assert.equal(d.event, "end");
});

check("standings break ties on lower total time", () => {
  const host = createHost({ mode: "shared" });
  host.setPool(Array.from({ length: 10 }, (_, i) => song("p" + i)));
  host.start({ rounds: 1 });
  host.record({ playerId: "sam", roundIndex: 0, won: true, guessCount: 3, ms: 9000 });
  host.record({ playerId: "jo", roundIndex: 0, won: true, guessCount: 3, ms: 2000 });
  const out = host.close(roster("sam", "jo"));
  assert.equal(out.payload.totals[0].id, "jo");
});

check("a dead preview is replaced once, then not again", () => {
  const host = createHost({ mode: "shared" });
  host.setPool(Array.from({ length: 10 }, (_, i) => song("p" + i)));
  const first = host.start({ rounds: 3 });
  const deadId = first.payload.song.id;
  const redraw = host.replaceDeadSong(deadId);
  assert.ok(redraw, "first report should redraw");
  assert.notEqual(redraw.payload.song.id, deadId);
  assert.equal(redraw.payload.index, 0, "the redraw stays on the same round");
  assert.equal(host.replaceDeadSong(redraw.payload.song.id), null, "second redraw must be refused");
});

console.log("\n" + passed + " checks passed");
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node "$SCRATCHPAD/roomHost.test.mjs"
```

Expected: FAIL — cannot find `lib/roomHost.js`.

- [ ] **Step 3: Write the engine**

Create `earworm/lib/roomHost.js`:

```js
// Host-authority engine for multiplayer rooms. Deliberately free of React,
// Supabase, and the DOM: the room page owns the channel and the UI, this owns
// the game. That split is what lets a whole game be driven from a plain Node
// script, which is the only way the crossover scoring rules get real coverage.
//
// Everything it wants broadcast comes back as a DIRECTIVE — { event, payload } —
// ready to hand straight to conn.send(event, payload). The page never decides
// what a round is; it just relays.
//
// Explicit .js extensions, as in roomGame.js: node requires them, Next accepts
// them either way.

import {
  buildRoundList,
  buildCrossoverList,
  splitPhases,
  scoreForResult,
  scoreFinaleRound,
  sortStandings,
  ROUND_CAP_MS,
} from "./roomGame.js";
import { pickStartOffset } from "./gameState.js";

export function createHost({ mode = "shared", random = Math.random } = {}) {
  const s = {
    mode,
    random,
    rounds: 0,
    poolSongs: [],
    contributions: [],
    claims: {}, // playerId -> artist name (superfan)
    samples: new Map(), // playerId -> songs[] (superfan)
    list: [],
    index: -1,
    results: new Map(), // playerId -> report, cleared each round
    totals: new Map(), // playerId -> { score, timeMs }
    redrawnFor: -1,
  };

  /* ---------- Lobby accumulation ---------- */

  function setPool(songs) {
    s.poolSongs = (songs || []).filter((x) => x && x.previewUrl);
  }

  function addContribution(entry) {
    if (!entry?.song) return;
    s.contributions.push(entry);
  }

  function contributionCount(playerId) {
    return s.contributions.filter((c) => c.by === playerId).length;
  }

  function setContributions(list) {
    s.contributions = list || [];
  }

  function poolSize() {
    return s.poolSongs.length + s.contributions.length;
  }

  function setSample(playerId, songs) {
    s.samples.set(playerId, (songs || []).filter((x) => x && x.previewUrl));
  }

  function sampleCount() {
    return s.samples.size;
  }

  /* ---------- Round list ---------- */

  function buildList() {
    if (s.mode === "superfan") {
      const { mastery, finale } = splitPhases(s.rounds);
      const masteryRounds = Array.from({ length: mastery }, () => ({ kind: "mastery" }));
      const samples = [...s.samples.entries()].map(([playerId, songs]) => ({ playerId, songs }));
      s.list = [...masteryRounds, ...buildCrossoverList(samples, finale, s.random)];
      return;
    }
    s.list = buildRoundList({
      poolSongs: s.poolSongs,
      contributions: s.contributions,
      rounds: s.rounds,
      random: s.random,
    }).map((r) => ({ kind: "round", song: r.song, contributedBy: r.contributedBy, ownerId: null }));
  }

  function directiveFor(index) {
    const entry = s.list[index];
    if (!entry) return { event: "end", payload: { totals: standingsFromTotals() } };

    if (entry.kind === "mastery") {
      // No song, on purpose: each client picks its own from its own pool, so a
      // player's mastery songs are never put on the wire at all.
      return { event: "mastery", payload: { index, capMs: ROUND_CAP_MS } };
    }

    return {
      event: "round",
      payload: {
        index,
        song: entry.song,
        startAt: pickStartOffset(),
        capMs: ROUND_CAP_MS,
        contributedBy: entry.contributedBy || null,
        ownerId: entry.ownerId || null,
        ownerName: entry.ownerId ? nameFor(entry.ownerId) : null,
        artist: entry.ownerId ? s.claims[entry.ownerId] || null : null,
      },
    };
  }

  let nameLookup = {};
  function nameFor(id) {
    return nameLookup[id] || id;
  }

  /* ---------- Lifecycle ---------- */

  function start({ rounds, claims, names } = {}) {
    s.rounds = rounds || s.rounds || 10;
    if (claims) s.claims = claims;
    if (names) nameLookup = names;
    s.index = 0;
    s.results = new Map();
    s.totals = new Map();
    s.redrawnFor = -1;
    buildList();
    return directiveFor(0);
  }

  function next() {
    s.index += 1;
    s.results = new Map();
    s.redrawnFor = -1;
    return directiveFor(s.index);
  }

  function record(report) {
    if (!report) return;
    if (report.roundIndex !== s.index) return; // stale round
    if (s.results.has(report.playerId)) return; // first report wins
    s.results.set(report.playerId, report);
  }

  function hasAllReports(playerIds) {
    const ids = playerIds || [];
    if (!ids.length) return false;
    return ids.every((id) => s.results.has(id));
  }

  function close(roster) {
    const people = roster || [];
    nameLookup = Object.fromEntries(people.map((p) => [p.id, p.name]));
    const entry = s.list[s.index] || {};

    let results = people.map((p) => {
      const r = s.results.get(p.id);
      return {
        playerId: p.id,
        name: p.name,
        won: !!r?.won,
        guessCount: r?.guessCount ?? 6,
        ms: r?.ms ?? ROUND_CAP_MS,
        missing: !r,
      };
    });

    if (s.mode === "superfan" && entry.kind === "round") {
      results = scoreFinaleRound(results, entry.ownerId);
    } else {
      results = results.map((r) => {
        const selfPick = !!entry.contributedBy && entry.contributedBy === r.playerId;
        return {
          ...r,
          selfPick,
          stole: false,
          isOwner: false,
          points: scoreForResult({ won: r.won, guessCount: r.guessCount, isSelfPick: selfPick }),
        };
      });
    }

    for (const r of results) {
      const prev = s.totals.get(r.playerId) || { score: 0, timeMs: 0 };
      s.totals.set(r.playerId, { score: prev.score + r.points, timeMs: prev.timeMs + r.ms });
    }

    return {
      event: "scores",
      payload: {
        index: s.index,
        kind: entry.kind || "round",
        contributedBy: entry.contributedBy ? nameFor(entry.contributedBy) : null,
        ownerId: entry.ownerId || null,
        ownerName: entry.ownerId ? nameFor(entry.ownerId) : null,
        artist: entry.ownerId ? s.claims[entry.ownerId] || null : null,
        results,
        totals: standingsFromTotals(people),
      },
    };
  }

  function standingsFromTotals(roster) {
    const people = roster || [...s.totals.keys()].map((id) => ({ id, name: nameFor(id) }));
    return sortStandings(
      people.map((p) => {
        const t = s.totals.get(p.id) || { score: 0, timeMs: 0 };
        return { id: p.id, name: p.name, score: t.score, timeMs: t.timeMs };
      })
    );
  }

  // Preview URLs are identical for every client, so one dead report means the
  // round is dead for everyone. Redraw once per round — a second failure would
  // loop. Only meaningful for rounds that carry a song.
  function replaceDeadSong(songId) {
    const entry = s.list[s.index];
    if (!entry || entry.kind !== "round") return null;
    if (s.redrawnFor === s.index) return null;
    s.redrawnFor = s.index;

    s.poolSongs = s.poolSongs.filter((x) => x.id !== songId);
    const used = new Set(s.list.map((r) => r.song?.id).filter(Boolean));
    const replacement = s.poolSongs.find((x) => !used.has(x.id));
    if (!replacement) return null;

    s.list[s.index] = { ...entry, song: replacement, contributedBy: null };
    s.results = new Map();
    return directiveFor(s.index);
  }

  return {
    setPool,
    addContribution,
    setContributions,
    contributionCount,
    poolSize,
    // Read-only views, so the page can re-run dedupe without owning the arrays.
    contributions: () => s.contributions,
    pool: () => s.poolSongs,
    setSample,
    sampleCount,
    start,
    next,
    record,
    hasAllReports,
    close,
    replaceDeadSong,
    standings: standingsFromTotals,
    roundIndex: () => s.index,
    totalRounds: () => s.list.length,
    currentEntry: () => s.list[s.index] || null,
  };
}
```

- [ ] **Step 4: Run the test**

```bash
node "$SCRATCHPAD/roomHost.test.mjs"
```

Expected: `9 checks passed`.

If a check fails, fix `roomHost.js` — not the test — unless the test's expectation contradicts the spec. If it does, say so explicitly rather than quietly weakening the assertion.

- [ ] **Step 5: Rewire the room page onto the engine**

In `earworm/app/room/[code]/page.js`:

Add the import and replace the host-only refs. Delete `roundList`, `roundIndex`, `roundResults`, `totalsRef`, `redrawnFor`, `poolSongs`, and `contributions`, replacing all seven with one engine ref:

```js
import { createHost } from "@/lib/roomHost";
// ...
const host = useRef(null);
if (isHost && !host.current) host.current = createHost({ mode: "shared" });
```

Then replace the host functions:

- `standingsFromRef()` → delete; use `host.current.standings(rosterRef.current)`.
- `broadcastRound(index, song)` → delete; directives already carry everything.
- `startGame()` becomes:

```js
  function startGame() {
    const h = host.current;
    if (!h || h.poolSize() < MIN_POOL_SIZE) return;
    conn.current?.send("pool", {
      count: h.poolSize(),
      poolName: poolNameRef.current,
      locked: true,
    });
    conn.current?.send("start", {
      rounds,
      poolName: poolNameRef.current,
      poolSpec: packId ? { type: "pack", id: packId } : { type: "artist", name: artistName },
    });
    const names = Object.fromEntries(rosterRef.current.map((p) => [p.id, p.name]));
    emit(h.start({ rounds, names }));
  }
```

- `nextRound()` becomes:

```js
  function nextRound() {
    clearTimeout(advanceTimer.current);
    emit(host.current?.next());
  }
```

- `closeRound()` becomes:

```js
  function closeRound() {
    clearTimeout(capTimer.current);
    emit(host.current?.close(rosterRef.current));
  }
```

- `maybeCloseRound()` becomes:

```js
  function maybeCloseRound() {
    const h = host.current;
    if (!h || h.roundIndex() < 0) return;
    if (h.hasAllReports(rosterRef.current.map((p) => p.id))) closeRound();
  }
```

- Add the relay helper next to them:

```js
  // The engine decides what happens; the page just puts it on the wire.
  function emit(directive) {
    if (!directive) return;
    conn.current?.send(directive.event, directive.payload);
  }
```

In `handleEvent`, the `done` branch becomes:

```js
    if (event === "done" && isHost) {
      host.current?.record(payload);
      maybeCloseRound();
      return;
    }
```

(the stale-round and duplicate guards now live in the engine), and the `unplayable` branch becomes:

```js
    if (event === "unplayable" && isHost) {
      if (payload.roundIndex !== host.current?.roundIndex()) return;
      clearTimeout(capTimer.current);
      emit(host.current?.replaceDeadSong(payload.songId));
      return;
    }
```

In the `add` branch, replace the direct array manipulation with the engine:

```js
    if (event === "add" && isHost) {
      const h = host.current;
      if (h.contributionCount(payload.playerId) >= MAX_CONTRIBUTIONS_PER_PLAYER) return;
      h.addContribution({ song: payload.song, by: payload.playerId, byName: payload.name });
      h.setContributions(dedupeContributions(h.contributions(), h.pool()));
      publishPool();
      return;
    }
```

`publishPool` loses its arguments and reads from the engine instead:

```js
  function publishPool(songs, label) {
    const h = host.current;
    if (songs) h.setPool(songs);
    const name = label ?? poolNameRef.current;
    poolNameRef.current = name;
    setPoolCount(h.poolSize());
    setPoolName(name);
    conn.current?.send("pool", { count: h.poolSize(), poolName: name, locked: false });
  }
```

In `handleRoster`, the host's `sync` send reads from the engine:

```js
      conn.current?.send("sync", {
        toPlayerId: p.id,
        totalRounds: host.current.totalRounds(),
        poolName: poolNameRef.current,
        poolSpec: packId ? { type: "pack", id: packId } : { type: "artist", name: artistName },
        index: host.current.roundIndex(),
        song: host.current.currentEntry()?.song,
        startAt: 0,
        capMs: ROUND_CAP_MS,
        totals: host.current.standings(rosterRef.current),
      });
```

- [ ] **Step 6: Verify the existing mode is unchanged**

Start the dev server and run a **full two-window game** of the existing shared-pool mode — this task rewrites working production code, so a compile check is not sufficient:

1. Host a genre pack, join from a second profile, both add a song.
2. Play a 5-round game to the final scoreboard.
3. Points match what they did before: a first-guess win is 6, a sixth-guess win is 1, a miss is 0.
4. A contributed song still shows "X's pick" and scores its contributor 0.
5. Auto-advance still fires after ~8s; the host's "Next round" still cuts it short.
6. Refresh a guest mid-game — it still rejoins into the current round.

Report what you actually observed.

- [ ] **Step 7: Commit**

```bash
git add earworm/lib/roomHost.js "earworm/app/room/[code]/page.js"
git commit -m "Extract host authority into a React-free, testable engine"
```

---

### Task 3: Protocol and superfan lobby

**Files:**
- Modify: `earworm/lib/room.js`, `earworm/app/room/page.js`
- Create: `earworm/components/SuperfanLobby.jsx`

**Interfaces:**
- Consumes: `MIN_SUPERFAN_POOL`, `DEPTH_CAPS`, `SUPERFAN_SAMPLE_SIZE` from `lib/roomGame.js`; `streamArtistPool` from `lib/itunes.js`.
- Produces: `<SuperfanLobby claims myClaim onClaim depth onDepth isHost resolving progress />`, and the room-entry route `/room/<CODE>?host=1&mode=superfan`.

- [ ] **Step 1: Add the events**

In `earworm/lib/room.js`, extend `ROOM_EVENTS`:

```js
  "claim", // player -> all:  { playerId, name, artist, songCount, ready }
  "sample", // player -> host: { playerId, songs }
  "mastery", // host -> all:   { index, capMs } — deliberately carries no song
```

- [ ] **Step 2: Add Superfan to the entry screen**

In `earworm/app/room/page.js`, add a third hosting section above the pack grid:

```jsx
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
```

- [ ] **Step 3: Build the lobby component**

Create `earworm/components/SuperfanLobby.jsx`:

```jsx
"use client";

import { useState } from "react";
import { MIN_SUPERFAN_POOL } from "@/lib/roomGame";

// Superfan lobby: everyone claims their own artist. An artist can only be
// claimed once — shared ownership would wreck the crossover steal rule, since
// "the owner" would be ambiguous.
//
// Only counts are shown, never song titles. Same rule as the shared pool.
export default function SuperfanLobby({
  claims, // [{ playerId, name, artist, songCount, ready }]
  meId,
  myClaim,
  onClaim,
  depth,
  onDepth,
  isHost,
  resolving,
  resolveNote,
}) {
  const [draft, setDraft] = useState("");

  const takenBySomeoneElse = (artist) =>
    claims.some(
      (c) => c.playerId !== meId && c.artist?.toLowerCase() === artist.trim().toLowerCase()
    );

  const [error, setError] = useState("");

  function submit(e) {
    e.preventDefault();
    const artist = draft.trim();
    if (!artist) return;
    if (takenBySomeoneElse(artist)) {
      setError(`Someone already claimed ${artist}. Pick another.`);
      return;
    }
    setError("");
    onClaim(artist);
  }

  return (
    <>
      <section className="section">
        <p className="eyebrow">Your artist</p>
        {myClaim?.ready ? (
          <p>
            You&rsquo;re repping <strong>{myClaim.artist}</strong>
            <span className="dim"> · {myClaim.songCount} songs ready</span>
          </p>
        ) : (
          <>
            <form className="artist-form" onSubmit={submit}>
              <input
                type="text"
                value={draft}
                placeholder="Who are you a superfan of?"
                autoComplete="off"
                aria-label="Your artist"
                disabled={resolving}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button type="submit" className="btn btn-primary" disabled={resolving || !draft.trim()}>
                {resolving ? "Loading…" : "Claim"}
              </button>
            </form>
            {resolving && <p className="dim">{resolveNote}</p>}
            {error && <p className="error-msg">{error}</p>}
            {myClaim && !myClaim.ready && !resolving && (
              <p className="error-msg">
                {myClaim.artist} only turned up {myClaim.songCount} playable songs — needs at
                least {MIN_SUPERFAN_POOL}. Try a different artist.
              </p>
            )}
          </>
        )}
      </section>

      <section className="section">
        <p className="eyebrow">Claimed so far</p>
        <ul className="claims">
          {claims.map((c) => (
            <li key={c.playerId} className={c.playerId === meId ? "me" : ""}>
              <span className="claim-who">{c.name}</span>
              <span className="claim-artist">{c.artist || "still choosing…"}</span>
              <span className="claim-state mono">
                {c.ready ? `${c.songCount} songs` : "—"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {isHost && (
        <section className="section">
          <p className="eyebrow">Depth</p>
          <label className="field inline">
            <span>Catalog</span>
            <select value={depth} onChange={(e) => onDepth(e.target.value)}>
              <option value="hits">Hits — top 25 each</option>
              <option value="standard">Standard — top 60 each</option>
              <option value="deep">Deep cuts — everything</option>
            </select>
          </label>
          <p className="dim">
            Everyone gets the same depth, so a 30-song artist stays comparable to a
            400-song one.
            {depth === "deep" &&
              " Deep cuts pulls every album for every player — expect a slow lobby."}
          </p>
        </section>
      )}
    </>
  );
}
```

- [ ] **Step 4: Add the styles**

Append to `earworm/app/globals.css`, using only existing tokens:

```css
/* ---- Superfan claims ---- */

.claims {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 2px;
}

.claims li {
  display: grid;
  grid-template-columns: 1fr 1.2fr auto;
  gap: 12px;
  align-items: baseline;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}

.claims li:last-child {
  border-bottom: 0;
}

.claims li.me {
  color: var(--ink);
  font-weight: 600;
}

.claim-who {
  color: var(--muted);
}

.claim-artist {
  font-family: var(--font-display), serif;
  font-size: 1.05rem;
}

.claim-state {
  color: var(--muted);
  font-size: 0.8rem;
}
```

- [ ] **Step 5: Verify**

With the dev server running, open `/room`:

1. "Host superfan mode" navigates to `/room/XXXX?host=1&mode=superfan`.
2. The lobby shows the claim form, an empty claims list, and (host only) the depth selector.
3. Typing an artist and claiming shows a loading state, then either the ready line with a song count or the "not enough songs" message.
4. From a second window, claiming the **same** artist is refused with "Someone already claimed…".
5. The depth selector shows the deep-cuts warning only on "Deep cuts".

The game itself isn't wired yet — Start does nothing. Confirm the lobby only.

- [ ] **Step 6: Commit**

```bash
git add earworm/lib/room.js earworm/app/room/page.js earworm/components/SuperfanLobby.jsx earworm/app/globals.css
git commit -m "Add superfan lobby: artist claims, depth setting, entry point"
```

---

### Task 4: Wire superfan into the room page

**Files:**
- Modify: `earworm/app/room/[code]/page.js`

**Interfaces:**
- Consumes: `createHost` (Task 2), `SuperfanLobby` (Task 3), `MIN_SUPERFAN_POOL`, `DEPTH_CAPS`, `SUPERFAN_SAMPLE_SIZE`, `shuffled` from `lib/roomGame.js`, `streamArtistPool` from `lib/itunes.js`, `pickSong` from `lib/gameState.js`.
- Produces: a playable superfan game.

- [ ] **Step 1: Mode detection and superfan state**

Read the mode from the URL and create the engine accordingly:

```js
  const mode = search.get("mode") === "superfan" ? "superfan" : "shared";
  // ...
  if (isHost && !host.current) host.current = createHost({ mode });
```

Add state and refs:

```js
  const [claims, setClaims] = useState([]); // [{ playerId, name, artist, songCount, ready }]
  const [depth, setDepth] = useState("standard");
  const [resolveNote, setResolveNote] = useState("");
  const myPool = useRef([]); // this player's own artist songs — never broadcast
  const myPlayed = useRef(new Set()); // shuffle-bag state for mastery rounds
  const myLastId = useRef(null);
  const claimsRef = useRef([]);
  useEffect(() => { claimsRef.current = claims; });
```

- [ ] **Step 2: Resolve the claimed artist locally**

```js
  async function claimArtist(artist) {
    setResolveNote(`Pulling ${artist}…`);
    setResolving(true);
    const cap = DEPTH_CAPS[depth] ?? DEPTH_CAPS.standard;
    const collected = [];
    await streamArtistPool(artist, {
      isAborted: () => collected.length >= cap,
      onSong: (song) => {
        if (collected.length < cap) collected.push(song);
        if (collected.length % 10 === 0) setResolveNote(`Pulling ${artist}… ${collected.length} songs`);
      },
    });
    const playable = collected.filter((s) => s.previewUrl).slice(0, cap);
    myPool.current = playable;
    setResolving(false);
    setResolveNote("");
    conn.current?.send("claim", {
      playerId: meId.current,
      name,
      artist,
      songCount: playable.length,
      ready: playable.length >= MIN_SUPERFAN_POOL,
    });
  }
```

`isAborted` doubles as the depth cap here — `streamArtistPool` checks it between album lookups, so a Hits-level game stops after roughly one search instead of walking the whole discography. That is the same lever that keeps the lobby fast.

- [ ] **Step 3: Handle claims and samples**

Add to `handleEvent`:

```js
    if (event === "claim") {
      setClaims((prev) => {
        const rest = prev.filter((c) => c.playerId !== payload.playerId);
        return [...rest, payload].sort((a, b) => a.name.localeCompare(b.name));
      });
      return;
    }

    if (event === "sample" && isHost) {
      host.current?.setSample(payload.playerId, payload.songs);
      return;
    }
```

- [ ] **Step 4: Send the sample and start**

Every client sends its finale sample when the host locks the lobby. Add to the `start` branch of `handleEvent`, before anything else:

```js
    if (event === "start") {
      // Superfan: contribute this player's slice of the crossover finale. Sent
      // on `start` rather than on claim so a player who re-picks their artist
      // can't leave a stale sample behind.
      if (mode === "superfan" && myPool.current.length) {
        conn.current?.send("sample", {
          playerId: meId.current,
          songs: shuffled(myPool.current).slice(0, SUPERFAN_SAMPLE_SIZE),
        });
      }
      // ...existing start handling...
    }
```

The host must not build its round list until the samples land, so `startGame` in superfan mode broadcasts `start`, waits briefly, then starts:

```js
  function startGame() {
    const h = host.current;
    const names = Object.fromEntries(rosterRef.current.map((p) => [p.id, p.name]));

    if (mode === "superfan") {
      const claimMap = Object.fromEntries(claimsRef.current.map((c) => [c.playerId, c.artist]));
      conn.current?.send("start", { rounds, poolName: "Superfan", poolSpec: null });
      // Samples arrive as their own broadcasts; give them a moment to land
      // before the round list is built from them.
      setTimeout(() => emit(h.start({ rounds, claims: claimMap, names })), 1200);
      return;
    }
    // ...existing shared-mode startGame...
  }
```

- [ ] **Step 5: Play mastery rounds**

Add the `mastery` branch to `handleEvent`. Each client picks its own song locally:

```js
    if (event === "mastery") {
      const song = pickSong(myPool.current, myPlayed.current, myLastId.current);
      myLastId.current = song?.id ?? null;
      setRound({
        key: `m-${payload.index}-${song?.id}-${Date.now()}`,
        index: payload.index,
        song,
        startAt: pickStartOffset(),
        capMs: payload.capMs,
        kind: "mastery",
        ownerName: null,
        artist: null,
      });
      setForceEnd(false);
      setMyResult(null);
      setLastScores(null);
      setPhase("playing");
      roundStartedAt.current = Date.now();
      clearTimeout(capTimer.current);
      capTimer.current = setTimeout(() => {
        setForceEnd(true);
        if (isHost) closeRound();
      }, payload.capMs);
      return;
    }
```

Extend the existing `round` branch to carry `kind: "round"`, `ownerName`, and `artist` onto the round object so the playing screen can label crossover rounds.

- [ ] **Step 6: Scope guesses and label the round**

In the playing render, pass the right local pool to `RoundBoard` and label crossover rounds:

```jsx
        <div className="game-top">
          <p className="eyebrow">
            Round <strong>{round.index + 1}</strong>
            {totalRounds ? <span className="dim"> of {totalRounds}</span> : null}
            {round.kind === "mastery" && <span className="dim"> · your artist</span>}
          </p>
          {round.ownerName && (
            <p className="round-owner">
              ♪ from <strong>{round.ownerName}</strong>&rsquo;s artist —{" "}
              <span className="round-artist">{round.artist}</span>
            </p>
          )}
        </div>

        <RoundBoard
          key={round.key}
          song={round.song}
          startAt={round.startAt}
          localSongs={
            mode === "superfan"
              ? round.kind === "mastery"
                ? myPool.current
                : crossoverPool.current
              : null
          }
          forceEnd={forceEnd}
          onFinish={handleRoundFinish}
          onUnplayable={handleRoundUnplayable}
        />
```

`crossoverPool` is a ref accumulating every song seen in crossover rounds plus this player's own pool, so the guess box has something local to filter. Populate it in the `round` branch:

```js
  const crossoverPool = useRef([]);
  // in the `round` branch, for superfan:
  crossoverPool.current = [...crossoverPool.current, payload.song, ...myPool.current];
```

This is intentionally generous — the guess list for a crossover round includes the answer plus the player's own catalog. `withAnswer` in `GuessInput` already pins the real answer once four letters match, so the round stays winnable for someone who knows the song and unwinnable for someone guessing blind.

- [ ] **Step 7: Render the superfan lobby**

In the lobby render, branch on mode: superfan shows `<SuperfanLobby …>` instead of the pool and contribution sections. Start gating becomes:

```js
  const readyClaims = claims.filter((c) => c.ready);
  const canStart =
    isHost &&
    roster.length >= MIN_PLAYERS &&
    (mode === "superfan"
      ? readyClaims.length === roster.length && readyClaims.length >= MIN_PLAYERS
      : poolCount >= MIN_POOL_SIZE && !preparing);
```

The host's pool-resolution effect must be skipped entirely in superfan mode — guard it with `if (mode === "superfan") return;` at the top.

- [ ] **Step 8: Verify with three windows**

Superfan needs three players for the steal rule to mean anything. Use a normal window, an incognito window, and a second browser.

1. Host superfan mode, all three claim different artists, all reach "ready".
2. Claiming an already-claimed artist is refused.
3. Start a 6-round game (4 mastery, 2 crossover).
4. **Mastery rounds:** each window plays a *different* song at the same time, and the guess box only suggests that player's own artist.
5. **Crossover rounds:** all three hear the *same* song, and the header names whose artist it is.
6. Deliberately have a non-owner beat the owner on a crossover round — the scoreboard shows the steal and double points.
7. Final standings add both phases.

- [ ] **Step 9: Commit**

```bash
git add "earworm/app/room/[code]/page.js"
git commit -m "Wire superfan mode: local artist pools, mastery rounds, crossover finale"
```

---

### Task 5: Scoreboard, styles, and docs

**Files:**
- Modify: `earworm/components/Scoreboard.jsx`, `earworm/app/globals.css`, `earworm/CLAUDE.md`

- [ ] **Step 1: Show steals on the scoreboard**

In `earworm/components/Scoreboard.jsx`, add an `owner` header and a steal badge. Replace the `sb-detail` cell content with:

```jsx
              <span className="sb-detail">
                {r.selfPick
                  ? "own pick"
                  : r.missing
                  ? "ran out of time"
                  : r.won
                  ? `${r.guessCount} ${r.guessCount === 1 ? "guess" : "guesses"}`
                  : "missed"}
                {r.isOwner && <span className="sb-owner"> · their artist</span>}
                {r.stole && <span className="sb-steal"> STEAL</span>}
              </span>
```

and add an owner line above the round list, alongside the existing `contributedBy` line:

```jsx
      {ownerName && (
        <p className="sb-pick">
          <strong>{ownerName}</strong>&rsquo;s artist — {artist}
        </p>
      )}
```

Accept `ownerName` and `artist` as new props and pass them from the scores payload in the room page.

- [ ] **Step 2: Style the badge**

Append to `earworm/app/globals.css`:

```css
.sb-steal {
  color: var(--accent);
  font-family: var(--font-mono), monospace;
  font-size: 0.68rem;
  letter-spacing: 0.12em;
  margin-left: 6px;
}

.sb-owner {
  color: var(--muted);
}

.round-owner {
  margin: 6px 0 0;
  color: var(--muted);
}

.round-artist {
  color: var(--accent);
  font-family: var(--font-display), serif;
}
```

- [ ] **Step 3: Document it**

Add a `### Superfan mode` subsection under the existing `## Multiplayer rooms` section in `earworm/CLAUDE.md` covering: the two phases and their split, that mastery rounds carry no song over the wire (each client picks locally from its own pool, so they are more private than shared-mode rounds), the owner/steal scoring rule, the one-claim-per-artist rule and why, `MIN_SUPERFAN_POOL = 15` and the arithmetic behind it, the room-wide depth setting as both a fairness and a throughput lever, and that `lib/roomHost.js` is the React-free host engine both modes share and the only place round/scoring logic should be added.

- [ ] **Step 4: Build and full verification**

Stop the dev server, confirm port 3000 is free, then:

```bash
cd earworm && npm run build
```

Expected: clean build. Then restart dev and play one full game of **each** mode — shared-pool and superfan — end to end.

- [ ] **Step 5: Commit**

```bash
git add earworm/components/Scoreboard.jsx earworm/app/globals.css earworm/CLAUDE.md
git commit -m "Show steals on the scoreboard, style superfan rounds, document the mode"
```

---

## Verification summary

| Layer | How it's verified |
|---|---|
| Superfan pure functions | Node script, 13 checks (Task 1) |
| Host engine, both modes | Node script, 9 checks driving whole games (Task 2) |
| Existing shared mode after refactor | Two-window playthrough (Task 2 Step 6) |
| Superfan lobby | Two-window claim flow (Task 3) |
| Superfan game | **Three-window** playthrough — the steal rule needs 3 players (Task 4) |
| Whole feature | `npm run build` plus one full game of each mode (Task 5) |

## Known limitations (intended)

- Crossover songs are visible in devtools; mastery songs are not, since they never go over the wire. No anti-cheat either way.
- An artist can only be claimed by one player per room.
- Depth is room-wide, not per player — that's the fairness mechanism, not an oversight.
- Deep cuts with 5+ players will be slow. Warned in the lobby, not prevented.
