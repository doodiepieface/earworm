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
export function buildRoundList({
  poolSongs,
  contributions,
  rounds = DEFAULT_ROUNDS,
  random = Math.random,
} = {}) {
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

/* ---------------- Superfan mode ---------------- */

// With the crossover finale switched off, every one of the longest game's 20
// rounds is a mastery round drawn from one player's own pool — so the pool has
// to cover all 20 or the shuffle bag wraps and starts repeating songs inside a
// single game. 20 songs for 20 rounds is exactly enough: the bag empties on the
// last pick rather than before it.
export const MIN_SUPERFAN_POOL = 20;

// How many songs each player contributes to the crossover finale.
export const SUPERFAN_SAMPLE_SIZE = 6;

// One room-wide depth, applied to every player equally — that equality is what
// keeps a 30-song artist comparable to a 400-song one.
export const DEPTH_CAPS = { hits: 25, standard: 60, deep: Infinity };

// Roughly two thirds mastery, one third crossover. The finale needs at least two
// rounds to feel like a finale, and mastery needs at least one to mean anything.
//
// `playerCount` (the number of distinct claimed artists) stretches the finale so
// every superfan gets at least one round defending their own artist — a plain
// one-third split gives a 5-round game only 2 crossover rounds, which silently
// leaves the third player's artist unplayed. Mastery always keeps one round, so
// a room with more players than rounds still can't feature everyone; the lobby
// warns about that rather than this function pretending otherwise.
export function splitPhases(rounds, playerCount = 0, withFinale = true) {
  const total = Math.max(3, rounds || 0);
  // Finale off: the whole game is everyone on their own artist, in parallel.
  if (!withFinale) return { mastery: total, finale: 0 };
  let finale = Math.max(2, Math.round(total / 3), playerCount || 0);
  finale = Math.min(finale, total - 1);
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
