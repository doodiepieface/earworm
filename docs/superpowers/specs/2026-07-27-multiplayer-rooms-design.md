# Multiplayer Rooms — Design

Date: 2026-07-27
Status: Approved, ready for implementation planning

## Summary

Add live multiplayer rooms to Earworm. A host creates a room with a short code;
friends join on their own phones, contribute songs to a shared pool during the
lobby, then play the same songs simultaneously — each player running their own
six-guess ladder, scored on how few guesses they needed, with speed as the
tiebreak.

No new server code and no new database tables. Supabase Realtime carries the
room; the host's browser is the authority.

## Goals

- Friends in the same room (or on a call) can play the same songs together.
- Joining takes seconds: a code and a name, no account required.
- Everyone shapes the pool, not just the host.
- Accounts gain a concrete benefit (saved room history) without gating play.

## Non-goals

Host migration, spectators, a public room browser, chat, reactions,
cross-session leaderboards, and any form of cheat prevention. See
"Anti-cheat posture" below.

## Architecture

### Transport: Supabase Realtime, no tables

A room is a Realtime channel named `room:<CODE>`.

- **Presence** tracks the roster (who is in the lobby/game right now).
- **Broadcast** carries game events.
- **No database table.** No migration, no row-level security, no cleanup job
  for abandoned rooms. A room exists only while clients are subscribed to its
  channel, then evaporates.

Channels are public (anon key, no auth required), so guests can join. Supabase's
free tier allows 200 concurrent Realtime connections — roughly 40 simultaneous
rooms at the 8-player cap.

**Consequence:** multiplayer requires `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY`. When they are absent, `isAuthConfigured()` is
already false; the multiplayer entry points must hide themselves the same way
`SpotifyNavLink` hides when Spotify isn't connected. With no Supabase config the
app behaves exactly as it does today.

**Security posture:** anyone who guesses a 4-character code can join a room.
With ~457,000 combinations and rooms that live for minutes, this is acceptable
for a party game. Rooms are not private channels and must not be described as
such.

### Authority: the host's browser

The host's tab is the game server. It:

- owns the resolved song pool and the locked round list,
- picks each round's song and broadcasts it,
- collects every player's result,
- computes scores and the scoreboard,
- advances rounds.

Every other client is thin: render the round, run the local ladder, report the
result.

**If the host closes the tab, the room ends.** Remaining players see "the host
ended the room" and a link home. Host migration is explicitly out of scope.

### Anti-cheat posture: none, deliberately

Each client must know the answer to run `isCorrectGuess` locally, and each
client self-reports its own result. A determined player can cheat. This is
acceptable for a room of friends. The alternative — moving answer-checking
server-side — contradicts the app's entirely-client-side architecture and is not
being built.

### Answer secrecy

The pool list is **never rendered**. The lobby shows a song *count* and the
player's own additions only. Earworm's guess design depends on the pool staying
secret (guess suggestions come from the whole iTunes catalog, not the pool);
showing 25 titles in the lobby would put every answer on screen.

A player necessarily knows the songs they personally added. This is bounded (10
max per player), symmetric across players, and neutralized in scoring by the
self-pick rule below.

## Game rules

### Round model

Every player hears the same song at the same time and runs their **own**
six-guess ladder at their own pace — the existing `LADDER` and `MAX_GUESSES`
from `lib/gameState.js`, unchanged.

A round ends when the last player finishes, or after a **60-second cap**,
whichever comes first. A player who has not finished when the cap expires is
scored as a loss for that round.

Each client counts its 60 seconds from **its own receipt** of the round message,
not from a host timestamp, so clock skew between devices cannot shorten anyone's
timer.

### Scoring

- Win on guess N → **7 − N** points (6 for the first guess, 1 for the sixth).
- Loss or timeout → 0 points.
- **Self-pick → 0 points**, regardless of performance.
- Ties on total points break on **lowest total elapsed time** across the game.

### The round list

Built once, at Start, and fixed for the game.

For `R` rounds (default 10):

1. Take up to `floor(R/2)` songs from the contribution set, shuffled.
2. Fill the remaining slots from the host's pool.
3. If there are fewer contributions than half of `R`, the host's pool fills the
   gap.
4. Interleave the two sources so contributions are spread across the game rather
   than front-loaded.

Contributions are deduped against the host's pool and against each other by
normalized title + artist (reusing `normalize()`/`artistsMatch()` from
`lib/itunes.js`), so adding a Drake track to a Drake room cannot create a
duplicate.

### Pool sources

The host's base pool may be a **curated pack** or **artist mode** only. Custom
lists and Spotify imports are not offered as room pools — a large import can
take minutes to resolve and only the host can resolve it.

Packs are typically already cached and start instantly. Artist mode streams in
via `streamArtistPool`; the room code is issued immediately and the lobby shows
a "preparing songs…" state while it fills. Start is disabled until the pool
reaches the minimum size.

### Contributions

- Available **in the lobby only**. The pool locks when the host presses Start.
- Each player searches the iTunes catalog from their own browser using the same
  `searchGuesses` path the guess box uses. That search returns a fully resolved
  song (preview URL, artwork, album, Apple link), so the contributor does the
  resolving work and hands a finished object to the host. No extra load on the
  host, and search cost spreads across devices.
- Cap: **10 songs per player**.
- A player can see and undo their own additions; never anyone else's.
- The host receives `add`, dedupes, appends to the pool, and rebroadcasts the
  authoritative count.

## Message protocol

All messages are Realtime broadcasts on `room:<CODE>`.

| Event        | Direction     | Payload |
|--------------|---------------|---------|
| `add`        | player → host | `{ playerId, song }` |
| `pool`       | host → all    | `{ count, locked }` |
| `start`      | host → all    | `{ rounds, poolName }` |
| `round`      | host → all    | `{ index, song, startAt, capMs }` |
| `done`       | player → host | `{ playerId, roundIndex, won, guessCount, ms }` |
| `unplayable` | player → host | `{ playerId, roundIndex, songId }` |
| `scores`     | host → all    | `{ index, roundResults, totals, contributedBy }` |
| `sync`       | host → player | full current state, for a rejoining client |
| `end`        | host → all    | `{ totals }` |

`contributedBy` is only sent with `scores` — after the round closes — so the
reveal ("Sam's pick") is a payoff, not a hint.

## Screens and flow

### `/room` — host or join

- "Host a room": pick a pack or type an artist → room created, code issued
  immediately, pool resolves in the background.
- "Join a room": enter code + name.
- Hidden entirely when Supabase isn't configured.

### `/room/[code]` — lobby then game

Opening this URL directly with no name set prompts for a name, so a shared link
works as an invite.

**Lobby:** live roster, pool name, song count (`31 songs · you added 4`), the
add-a-song search with the player's own additions listed, and — for the host —
a round-count control and Start. Minimum 2 players, maximum 8.

**Game:** the round board (dial, ladder, guess box, result), a compact live
status of who has finished, and the between-round scoreboard.

**End:** final scoreboard, "Play again" (same room, same players, same locked
pool, fresh round list), and for signed-in players a note that the room was
saved.

### Between-round scoreboard

Per-player result for the round (guess count or a miss), the contributor reveal,
and running totals. Auto-advances after ~8 seconds; the host can advance sooner.

## Edge cases

| Situation | Behavior |
|-----------|----------|
| Dead preview URL | First `unplayable` report causes the host to abandon the round **for everyone** and redraw once. Preview URLs are identical across clients, so failures are near-always universal. Bounded to one redraw per round to prevent loops. |
| Player refreshes | Client rejoins the channel; host replies with `sync`; player lands back in the current round with the time remaining. |
| Player leaves mid-round | Presence drop. Host stops waiting on them, scores that round 0, removes them from the roster. |
| Host leaves | Presence drop of the host key. Clients show "the host ended the room" and a link home. |
| Everyone but host leaves | Host sees "everyone left" with an option to end the room. |
| Duplicate names | Allowed. Presence keys are random ids; a color dot disambiguates. |
| Pool too small at Start | Start stays disabled below `MIN_POOL_SIZE` (4). |

## Room history

On `end`, each **signed-in** client writes a record to a new
`earworm-room-history` key:

```js
{ code, endedAt, poolName, poolSpec, rounds,
  players: [{ name, score }], you: { score, place } }
```

Capped at 20 entries, newest first. Registered as a fourth synced key in
`lib/sync.js`, merged by union on `code + endedAt`.

The stored `poolSpec` powers a **"Replay this pool"** action: pass it to
`setActivePool` and navigate to `/play` for a solo game with the same songs.

Guests persist nothing. This is the concrete reason to create an account.

## Files

### New

- `lib/room.js` — the only module aware of Supabase Realtime. Channel connect,
  join, leave, send, subscribe, room-code generation (avoiding visually
  confusable characters).
- `lib/roomGame.js` — pure functions with no I/O: score for a result, round-list
  construction (the half-and-half interleave), scoreboard sorting with the time
  tiebreak, contribution dedupe. Verifiable with a throwaway Node script, which
  matches this project's established verification pattern.
- `components/RoundBoard.jsx` — one round of guessing: dial, ladder, guess box,
  result. Extracted from `app/play/page.js`.
- `components/Scoreboard.jsx` — between-round and final standings.
- `app/room/page.js` — host-or-join screen.
- `app/room/[code]/page.js` — lobby and game.

### Modified

- `app/play/page.js` — round UI extracted into `RoundBoard`; the page keeps pool
  loading, the shuffle bag, and stats. Behavior unchanged.
- `lib/storage.js` — `earworm-player-name`, `earworm-room-history` accessors.
- `lib/sync.js` — add room history to the synced key set.
- `app/globals.css` — lobby, roster, and scoreboard styles inside the existing
  Nocturne token system.
- Home page / nav — a "Play with friends" entry, hidden when Supabase is
  unconfigured.

The `RoundBoard` extraction is the one refactor folded in, and it is load-bearing:
without it, single-player and room rounds are two copies of the same ladder logic
that will drift.

## Testing

There is no test suite and browser testing is not routine in this project, so
verification follows the established pattern:

- `lib/roomGame.js` is pure and gets a throwaway Node script covering: scoring
  at each ladder position, self-pick zeroing, the tiebreak, half-and-half
  construction when contributions are plentiful / scarce / absent, and dedupe.
- The realtime layer and UI are verified by hand with two browser profiles (or a
  phone plus a desktop): join, contribute, play a full game, then deliberately
  refresh a client, drop a client mid-round, and close the host tab.

## Prerequisites

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` must be present
in the Vercel project. Confirm before implementation; the account layer already
uses them, so they may already be set.
