# Superfan Mode — Design

Date: 2026-07-31
Status: Approved, ready for implementation planning

## Summary

A second multiplayer room mode. Instead of one shared pool, every player claims
**their own artist** and the game asks who knows theirs best.

It runs in two phases. **Mastery** (the first two thirds of the rounds) has each
player hearing songs from their own artist, simultaneously but separately.
**Crossover** (the last third) puts everyone on the same song, drawn round-robin
from the claimed artists — the owner defends their turf, and anyone who beats
them on it scores double.

Builds on the multiplayer rooms shipped 2026-07-29
(`2026-07-27-multiplayer-rooms-design.md`). Same channel transport, same
host-as-authority model, same `RoundBoard`.

## Goals

- Let a group of friends who are each into different artists compete on a
  comparable footing.
- Keep the shared-audio social moment that the existing room mode is built on,
  rather than degrading into parallel solitaire with a scoreboard.
- Reuse the existing room infrastructure rather than forking it.

## Non-goals

Cheat prevention, host migration, cross-session superfan rankings, per-artist
difficulty rating, and any change to solo play.

## Game design

### Lobby

The host creates a room and picks **Superfan** instead of a pack or artist.

Each player then types **their own** artist. **Each player's own browser
resolves their own artist** — this spreads iTunes work across devices instead of
concentrating it on the host, which is what makes the mode viable at all.

**Depth** is a single room-wide setting chosen by the host and applied equally to
everyone:

| Level | Songs per player | Source |
|---|---|---|
| Hits | ~25 | first artist search, truncated |
| Standard (default) | ~60 | first artist search, truncated |
| Deep cuts | full catalog | full `streamArtistPool` walk |

An equal cap is what keeps a 30-song artist and a 400-song artist comparable.
Deep cuts shows a slow-lobby warning, because it is N simultaneous album walks
through one shared proxy.

**An artist can only be claimed once.** If Ali claims Taylor Swift, Sam sees it
as claimed and picks something else. Shared ownership would break the finale's
owner/steal distinction.

Start unlocks when every player has a resolved artist of at least
`MIN_SUPERFAN_POOL` (15) playable songs, with at least 2 players.

15 is not arbitrary: the longest game the host can pick is 20 rounds, which is 13
mastery rounds, and a pool smaller than that would exhaust the shuffle bag and
start repeating songs inside a single game.

### Phase 1 — Mastery

Two thirds of the rounds, rounded down, minimum 1.

Every round, each player hears a song from **their own** artist, all at the same
time. Different audio per person. Standard `7 − N` scoring and the standard 60s
cap. The guess box scopes to the player's own artist pool (`localSongs`), which
is exactly how solo artist mode already behaves — instant, no network, and the
player already knows the artist.

The shared moment each round is the scoreboard, not the audio.

### Phase 2 — Crossover

The remaining rounds, minimum 2.

Everyone hears the **same** song, drawn round-robin across the claimed artists.
The round announces whose turf it is ("♪ from Sam's artist: Drake") and the guess
box scopes to that artist's sampled songs — so it tests naming the song, not
guessing the artist.

Scoring for a crossover round on artist owned by O:

- **O scores normally** (`7 − N`). It is their artist; they are meant to get it.
- **Any non-owner who beats O scores double.** "Beats" means: the non-owner won
  and either O missed, or the non-owner used strictly fewer guesses than O.
- A non-owner who wins without beating O scores normally.
- If nobody wins, nobody scores.

### Winner

Total points across both phases. Ties break on lower total elapsed time, the same
rule the existing mode uses.

## Architecture

### Prerequisite refactor: `lib/roomHost.js`

`app/room/[code]/page.js` is already ~900 lines. Superfan mode is a second game
engine; added in place it would push that file past 1400 lines holding two modes'
host logic, all the UI, and the channel wiring.

So host authority is extracted first into **`lib/roomHost.js`** — a plain,
React-free module with no Supabase and no DOM:

```js
createHost({ mode, rounds, poolSongs, contributions, claims, samples })
  -> {
       start(),            // build the round list, return the first directive
       recordResult(r),    // fold in one player's `done` report
       allReported(ids),   // has everyone present reported?
       closeRound(roster), // -> { results, totals, contributedBy|owner }
       nextRound(),        // -> { kind: "mastery"|"round"|"end", ... }
     }
```

The page becomes wiring: channel → engine → UI. Two payoffs beyond tidiness —
the steal rule becomes testable under plain Node, and the existing mode's host
logic gets test coverage it does not have today.

This refactor lands **first and separately**, verified against the existing room
mode before any superfan logic goes near it.

### New pure functions in `lib/roomGame.js`

Both Node-testable, joining the existing pure set:

- `splitPhases(rounds) -> { mastery, finale }` — two thirds / one third, finale
  at least 2, mastery at least 1.
- `scoreFinaleRound(results, ownerId) -> results` — applies the steal doubling.

### Protocol additions

Four additions to `ROOM_EVENTS` in `lib/room.js`:

| Event | Direction | Payload |
|---|---|---|
| `claim` | player → all | `{ playerId, artist, songCount, ready }` |
| `sample` | player → host | `{ playerId, songs }` — ~6 songs, sent at lock |
| `mastery` | host → all | `{ index }` — no song, deliberately |
| `round` | host → all | existing, plus `{ ownerId, ownerName, artist }` |

**Phase 1 carries no song.** The host sends only "round 4, go"; each client picks
its own next song locally from its own pool using the existing shuffle bag in
`lib/gameState.js`, untouched. Payloads stay tiny, no new selection logic is
needed, and those songs are never broadcast at all — phase 1 is strictly more
private than anything in the existing mode.

For the finale, each client sends ~6 sampled songs at lobby-lock and the host
builds the round-robin list. Roughly 12KB total for four players, well inside the
256KB broadcast limit.

### Honest limit

Realtime broadcast is public to the channel, so **crossover songs are visible in
devtools** to anyone who looks. Same posture as the existing mode: no anti-cheat,
stated rather than pretended.

## Edge cases

| Situation | Behavior |
|---|---|
| Two players want the same artist | Second sees it claimed and must pick another. Host arbitrates on `claim`, first claim wins. |
| Artist resolves under 15 playable songs | That player cannot ready up; prompted to pick another artist. |
| Owner leaves mid-game | Their remaining crossover rounds are dropped from the list; their phase-1 results stay in the standings up to that point. |
| Fewer than 2 players ready | Start stays disabled. |
| Deep cuts with 5+ players | Lobby warning before start — that is five simultaneous catalog walks through one proxy. |
| A player's pool empties mid-game | Cannot happen: `MIN_SUPERFAN_POOL` (15) exceeds the 13 mastery rounds of the longest (20-round) game, so the shuffle bag never wraps. |

## Files

### New
- `lib/roomHost.js` — host-authority engine, React-free, Node-testable.
- `components/SuperfanLobby.jsx` — artist claim UI, claimed-artist roster, depth
  selector, ready state.

### Modified
- `lib/roomGame.js` — `splitPhases`, `scoreFinaleRound`, superfan constants.
- `lib/room.js` — three new event names.
- `app/room/[code]/page.js` — mode branch; host logic moves out to `roomHost.js`.
- `components/Scoreboard.jsx` — steal badge, owner marker.
- `app/room/page.js` — Superfan as a third way to host.
- `app/globals.css` — claim list and steal badge, existing tokens only.
- `earworm/CLAUDE.md` — document the mode.

### Unchanged
`components/RoundBoard.jsx`, `lib/gameState.js`, `lib/storage.js`, `lib/sync.js`,
and all of solo play.

## Testing

Same pattern as the rest of the project — no test runner, throwaway Node scripts
for pure logic, hands-on for UI.

- `splitPhases` and `scoreFinaleRound` get Node coverage: owner wins outright,
  outsider beats owner by one guess, outsider ties owner, owner misses and an
  outsider wins, nobody wins, single-player-artist edge.
- `lib/roomHost.js` gets Node coverage driving a whole synthetic game of each
  mode, asserting the standings.
- The refactor is verified against the **existing** room mode by a two-window
  playthrough before superfan work begins.
- Superfan itself needs a three-device pass, since the steal rule is meaningless
  with two players.

## Rollout

The `roomHost.js` extraction ships and is verified first. Superfan mode is
additive after that — the existing shared-pool mode remains the default and is
untouched by the feature.
