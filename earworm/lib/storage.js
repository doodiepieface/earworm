// All browser-storage access lives here so pages/components stay tidy.
// Everything is defensive: storage can be full, blocked, or contain junk.

import { mergeRoomHistory } from "./roomGame";

function read(key, fallback) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked — the app still works, we just don't persist.
  }
  // Mirror to the signed-in account, if the optional sync layer is active.
  try {
    syncHook?.(key, value);
  } catch {
    // Never let a sync problem break a local save.
  }
}

/* ---------------- Optional account sync ---------------- */
// lib/sync.js registers a hook here; it fires after every local write so a
// signed-in user's data can mirror to their account. No-op when signed out or
// when the account layer isn't configured — the app is local-first either way.
// (Spotify tokens never pass through here — they're written straight to
// localStorage in lib/spotify.js — so credentials never sync.)

let syncHook = null;

export function registerSyncHook(fn) {
  syncHook = fn;
}

// Generic key access for the sync layer's merge step.
export function readKey(key) {
  return read(key, null);
}

export function writeKey(key, value) {
  write(key, value);
}

/* ---------------- Active pool (what the /play screen loads) ---------------- */
// Stored in sessionStorage so a stale pool doesn't linger between visits.

const ACTIVE_KEY = "earworm-active-pool";

export function setActivePool(spec) {
  try {
    sessionStorage.setItem(ACTIVE_KEY, JSON.stringify(spec));
  } catch {}
}

export function getActivePool() {
  try {
    const raw = sessionStorage.getItem(ACTIVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/* ---------------- Player stats ---------------- */

export const STATS_KEY = "earworm-stats";

const EMPTY_STATS = {
  played: 0,
  wins: 0,
  streak: 0,
  maxStreak: 0,
  // dist[i] = number of wins that took i+1 guesses
  dist: [0, 0, 0, 0, 0, 0],
};

export function loadStats() {
  const s = read(STATS_KEY, EMPTY_STATS);
  return { ...EMPTY_STATS, ...s, dist: s.dist || [...EMPTY_STATS.dist] };
}

// `guessNumber` is 1-based (won on guess 3 => 3). Ignored on a loss.
export function recordResult(won, guessNumber) {
  const s = loadStats();
  s.played += 1;
  if (won) {
    s.wins += 1;
    s.streak += 1;
    s.maxStreak = Math.max(s.maxStreak, s.streak);
    const idx = Math.min(Math.max(guessNumber - 1, 0), s.dist.length - 1);
    s.dist[idx] += 1;
  } else {
    s.streak = 0;
  }
  write(STATS_KEY, s);
  return s;
}

/* ---------------- Custom lists ---------------- */

export const LISTS_KEY = "earworm-lists";

export function loadLists() {
  return read(LISTS_KEY, []);
}

export function saveLists(lists) {
  write(LISTS_KEY, lists);
}

/* ---------------- Imported Spotify pools ---------------- */

export const SPOTIFY_POOLS_KEY = "earworm-spotify-pools";

export function loadSpotifyPools() {
  return read(SPOTIFY_POOLS_KEY, []);
}

export function saveSpotifyPools(pools) {
  write(SPOTIFY_POOLS_KEY, pools);
}

/* ---------------- Resolved genre-pack cache ---------------- */
// Packs ship as title+artist only; the first load resolves preview URLs
// through the iTunes proxy, then we cache the playable pool here.

export function loadPackCache(packId) {
  return read(`earworm-pack-${packId}`, null);
}

export function savePackCache(packId, data) {
  write(`earworm-pack-${packId}`, { ...data, ts: Date.now() });
}

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
// rejoins as the same player instead of appearing as a second one. Deliberately
// not synced — a device id must not follow you to another device.
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

// Newest first, capped. Re-uses the same merge the account layer uses so a
// local append and a remote merge can never disagree about ordering or limit.
export function addRoomHistoryEntry(entry) {
  const merged = mergeRoomHistory([entry], loadRoomHistory());
  saveRoomHistory(merged);
  return merged;
}

/* ---------------- Misc ---------------- */

const VOLUME_KEY = "earworm-volume";

export function loadVolume() {
  const v = read(VOLUME_KEY, 0.8);
  return typeof v === "number" && v >= 0 && v <= 1 ? v : 0.8;
}

export function saveVolume(v) {
  write(VOLUME_KEY, v);
}
