"use client";

// Mirrors a signed-in user's data to their Supabase account and back.
// Only three things sync — imported Spotify pools, custom lists, and play
// stats. Everything else (volume, pack caches, and crucially the Spotify
// OAuth tokens) stays local-only.

import { getClient, isAuthConfigured } from "./supabase";
import {
  registerSyncHook,
  readKey,
  writeKey,
  SPOTIFY_POOLS_KEY,
  LISTS_KEY,
  STATS_KEY,
} from "./storage";

const SYNCABLE = new Set([SPOTIFY_POOLS_KEY, LISTS_KEY, STATS_KEY]);
const TABLE = "user_data";
const SYNC_EVENT = "earworm:synced";

let currentUser = null;
const pushTimers = {};

export function setSyncUser(user) {
  currentUser = user;
}

/* ---------------- Push: local -> account (debounced per key) ---------------- */

async function pushNow(key, value) {
  const c = getClient();
  if (!c || !currentUser) return;
  try {
    await c.from(TABLE).upsert(
      {
        user_id: currentUser.id,
        key,
        value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,key" }
    );
  } catch {
    // Offline or transient — the local save already succeeded; the next write
    // to this key will push again.
  }
}

// Registered as the storage write-hook. Coalesces bursts (e.g. a stats write
// after every round) into one request per key.
function schedulePush(key, value) {
  if (!currentUser || !SYNCABLE.has(key)) return;
  clearTimeout(pushTimers[key]);
  pushTimers[key] = setTimeout(() => pushNow(key, value), 800);
}

/* ---------------- Pull: account -> local ---------------- */

async function pullRemote(userId) {
  const c = getClient();
  if (!c) return {};
  const { data, error } = await c
    .from(TABLE)
    .select("key,value")
    .eq("user_id", userId);
  if (error) return {};
  const map = {};
  (data || []).forEach((row) => {
    map[row.key] = row.value;
  });
  return map;
}

/* ---------------- Merge rules ---------------- */

// Pools and lists are arrays of objects with a stable `id`. Union them,
// letting the account copy win on id conflicts, then fold in anything that
// only existed locally — so a first sign-in never loses local imports.
function mergeById(local, remote) {
  const out = [];
  const seen = new Set();
  for (const item of [...(remote || []), ...(local || [])]) {
    if (!item || item.id == null || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

// Stats can't be added up without double-counting, so keep whichever record
// has more games played — that's the one with more history to lose.
function mergeStats(local, remote) {
  const lp = local?.played || 0;
  const rp = remote?.played || 0;
  return rp > lp ? remote : local || remote || null;
}

function mergeValue(key, local, remote) {
  if (remote == null) return local;
  if (local == null) return remote;
  if (key === STATS_KEY) return mergeStats(local, remote);
  return mergeById(local, remote);
}

/* ---------------- Lifecycle ---------------- */

// Run once right after sign-in: reconcile local and account both ways, so the
// account ends up with the union and this device shows it immediately.
export async function mergeOnLogin(user) {
  if (!isAuthConfigured() || !user) return;
  currentUser = user;
  const remote = await pullRemote(user.id);

  for (const key of SYNCABLE) {
    const merged = mergeValue(key, readKey(key), remote[key]);
    if (merged == null) continue;
    writeKey(key, merged); // updates local; the write-hook pushes it to remote
  }

  // Nudge mounted pages to re-read localStorage so merged data shows at once.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SYNC_EVENT));
  }
}

// Called once from the auth control to start mirroring local writes.
export function initSync() {
  registerSyncHook(schedulePush);
}

// Pages that display synced data subscribe to re-read after a merge.
export function onSyncUpdate(cb) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(SYNC_EVENT, cb);
  return () => window.removeEventListener(SYNC_EVENT, cb);
}
