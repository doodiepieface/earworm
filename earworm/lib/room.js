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

// Explicit .js extension (unlike most of the codebase) so this module can be
// loaded by a plain `node` script for verification — Next accepts either form,
// node only resolves the explicit one. Same reasoning as lib/roomGame.js.
import { getClient, isAuthConfigured } from "./supabase.js";

// Multiplayer rides on the same Supabase project as optional accounts, so it's
// available exactly when that is configured.
export function isRoomsEnabled() {
  return isAuthConfigured();
}

// Every broadcast event the room uses. Listed explicitly rather than subscribing
// to a wildcard so an unknown event can't silently reach a handler.
export const ROOM_EVENTS = [
  "add", // player -> host: { playerId, name, song }
  "pool", // host -> all:    { count, poolName, locked }
  "start", // host -> all:    { rounds, poolName, poolSpec }
  "round", // host -> all:    { index, song, startAt, capMs }
  "done", // player -> host: { playerId, roundIndex, won, guessCount, ms }
  "unplayable", // player -> host: { playerId, roundIndex, songId }
  "scores", // host -> all:    { index, contributedBy, results, totals }
  "sync", // host -> one:    { toPlayerId, ...full state }
  "end", // host -> all:    { totals, poolName, rounds }

  // Superfan mode
  "claim", // player -> all:  { playerId, name, artist, songCount, ready }
  "sample", // player -> host: { playerId, songs } — the crossover contribution
  "mastery", // host -> all:   { index, capMs } — deliberately carries NO song,
  //                            each client picks its own from its own pool

  "reset", // host -> all:    {} — everyone back to the lobby, same room,
  //                            same players, so the host can pick a new pool
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

  const topic = `room:${code}`;

  // Supabase hands back the SAME channel object for a topic it already knows,
  // and adding listeners to an already-subscribed channel throws outright
  // ("cannot add `presence` callbacks ... after `subscribe()`"). A stale channel
  // for this topic is easy to hit: React StrictMode double-mounts effects in
  // dev, and navigating out of a room and back can race the cleanup. Drop any
  // leftover first so joining is always idempotent.
  for (const stale of client.getChannels()) {
    if (stale.topic === topic || stale.topic === `realtime:${topic}`) {
      client.removeChannel(stale);
    }
  }

  const channel = client.channel(topic, {
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
      // `mode` and `depth` are room-wide settings that only the host knows —
      // a joiner's URL is a bare /room/CODE. Carrying them in presence means
      // every client reads them off the host's entry, late joiners included,
      // with no extra message and no request/response round trip.
      .map((m) => ({
        id: m.id,
        name: m.name,
        isHost: !!m.isHost,
        mode: m.mode || null,
        depth: m.depth || null,
        // Explicitly boolean-checked: `m.finale || null` would turn a
        // deliberate `false` into `null`, and the reader's default would then
        // quietly switch the finale back on.
        finale: typeof m.finale === "boolean" ? m.finale : null,
      }));
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
    // Re-publish this client's presence metadata. The host uses it when a
    // room-wide setting changes (e.g. the depth selector) so everyone —
    // including whoever joins next — reads the current value.
    track(meta) {
      return channel.track({ ...self, ...meta });
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
