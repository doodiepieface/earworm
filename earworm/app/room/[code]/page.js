"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import RoundBoard from "@/components/RoundBoard";
import RoundOutcome from "@/components/RoundOutcome";
import Scoreboard from "@/components/Scoreboard";
import packs, { getPack } from "@/data/packs";
import { joinRoom, isRoomsEnabled } from "@/lib/room";
import { createHost } from "@/lib/roomHost";
import {
  MIN_PLAYERS,
  MAX_PLAYERS,
  MAX_CONTRIBUTIONS_PER_PLAYER,
  DEFAULT_ROUNDS,
  ROUND_CAP_MS,
  MIN_SUPERFAN_POOL,
  SUPERFAN_SAMPLE_SIZE,
  DEPTH_CAPS,
  dedupeContributions,
  shuffled,
} from "@/lib/roomGame";
import { pickSong, pickStartOffset } from "@/lib/gameState";
import SuperfanLobby from "@/components/SuperfanLobby";
import { resolveTracks, streamArtistPool, searchGuesses } from "@/lib/itunes";
import {
  getPlayerId,
  loadPlayerName,
  savePlayerName,
  loadPackCache,
  savePackCache,
  addRoomHistoryEntry,
  setActivePool,
} from "@/lib/storage";
import { getClient } from "@/lib/supabase";

const MIN_POOL_SIZE = 4;
const SCORE_AUTO_ADVANCE_MS = 8000;
// Breathing room between the last answer and the scoreboard. Without it the
// person who finishes last sees the song they just guessed for a few
// milliseconds before being yanked to the standings.
const REVEAL_MS = 2000;
// How long guests wait for a vanished host before giving up. Mobile browsers
// suspend backgrounded tabs and drop the socket, so a host who glances at
// another app looks exactly like a host who left — this is the difference
// between the two, and it has to be generous enough to cover a real glance.
const HOST_GRACE_MS = 45000;

// The guess list is keyed on song id, so a repeated id makes React warn and can
// drop rows. A crossover song can already be in your own pool (it's your artist
// being played), and a deep catalog walk can surface the same track from two
// albums — so both pools get deduped rather than trusting the source.
function dedupeById(songs) {
  const seen = new Set();
  const out = [];
  for (const s of songs || []) {
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

// The lobby and the game live in one component because they share the channel
// connection and the host's authoritative state. The host's browser IS the
// server: it owns the pool, builds the round list, and computes every score.
// Everyone else renders what it broadcasts and reports their own result.
function RoomPage() {
  const params = useParams();
  const search = useSearchParams();
  const router = useRouter();

  const code = String(params.code || "").toUpperCase();
  const isHost = search.get("host") === "1";
  const packId = search.get("pack");
  const artistName = search.get("artist");
  const mode = search.get("mode") === "superfan" ? "superfan" : "shared";

  // connecting | naming | lobby | playing | scores | ended | closed
  const [phase, setPhase] = useState("connecting");
  const [name, setName] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [roster, setRoster] = useState([]);
  const [poolCount, setPoolCount] = useState(0);
  const [poolName, setPoolName] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [locked, setLocked] = useState(false);
  const [rounds, setRounds] = useState(DEFAULT_ROUNDS);
  const [totalRounds, setTotalRounds] = useState(0);
  const [notice, setNotice] = useState("");

  // Contributions (lobby only)
  const [myAdds, setMyAdds] = useState([]);
  const [addQuery, setAddQuery] = useState("");
  const [addResults, setAddResults] = useState([]);
  const [addSearching, setAddSearching] = useState(false);

  // Game
  const [round, setRound] = useState(null);
  const [forceEnd, setForceEnd] = useState(false);
  const [myResult, setMyResult] = useState(null);
  const [lastScores, setLastScores] = useState(null);
  const [totals, setTotals] = useState([]);

  // The chosen pool starts from the host's URL but lives in state, so "new pool,
  // same room" can change it without a re-navigation. Re-navigating would drop
  // the host from presence for a moment, and every guest's host-left check would
  // fire and close the room out from under them.
  const [poolChoice, setPoolChoice] = useState(() =>
    packId ? { type: "pack", id: packId } : artistName ? { type: "artist", name: artistName } : null
  );
  const [newArtist, setNewArtist] = useState("");
  const poolChoiceRef = useRef(null);

  // Superfan lobby. `resolving` is this player pulling their OWN artist, which
  // is distinct from `preparing` (the host pulling the shared pool) — different
  // modes, different actors, so they stay separate flags.
  const [claims, setClaims] = useState([]);
  const [depth, setDepth] = useState("standard");
  const [withFinale, setWithFinale] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [resolveNote, setResolveNote] = useState("");
  // The host's connection has dropped but the grace period hasn't expired.
  // Deliberately NOT a phase: phases are destinations, this is a suspension of
  // whatever the player was already doing, and it has to be reversible.
  const [hostAway, setHostAway] = useState(false);

  const meId = useRef(null);
  const conn = useRef(null);
  const addDebounce = useRef(null);
  const capTimer = useRef(null);
  const advanceTimer = useRef(null);
  const revealTimer = useRef(null);
  const hostGraceTimer = useRef(null);
  const roundStartedAt = useRef(0);
  // Highest round index already scored, so a round can't be closed twice.
  const closedFor = useRef(-1);

  // Host-only authoritative state, all of it inside the engine. Never rendered —
  // showing the pool would put every answer on screen. The engine is React-free
  // and lives in lib/roomHost.js; this page only relays what it emits.
  const host = useRef(null);
  if (isHost && !host.current) host.current = createHost({ mode });
  const knownIds = useRef(new Set());

  // Superfan: this player's own artist pool. It is NEVER broadcast — mastery
  // rounds carry no song, so each client picks locally from here. Only a small
  // sample goes over the wire, for the crossover finale.
  const myPool = useRef([]);
  const myPlayed = useRef(new Set()); // shuffle-bag state across mastery rounds
  const myLastId = useRef(null);
  // Songs the guess box can offer during crossover rounds: this player's own
  // catalog plus every crossover song seen so far.
  const crossoverPool = useRef([]);
  const claimsRef = useRef([]);

  // Mirrors of state that memo-free handlers need to read without going stale.
  const poolNameRef = useRef("");
  const poolSpecRef = useRef(null);
  const rosterRef = useRef([]);
  const phaseRef = useRef("connecting");
  const roundRef = useRef(null);

  // The room's mode and depth are the HOST's — a joiner's URL is a bare
  // /room/CODE with no query params at all, so reading them from `search` would
  // silently give every guest the shared-pool lobby. They come off the host's
  // presence entry instead. Undefined until presence settles, which is why the
  // lobby renders neither mode's sections until it resolves.
  const hostEntry = roster.find((p) => p.isHost);
  const roomMode = isHost ? mode : hostEntry?.mode || undefined;
  const roomDepth = isHost ? depth : hostEntry?.depth || "standard";
  // Presence carries booleans as-is; `?? true` keeps the default before the
  // host's entry has landed rather than briefly claiming the finale is off.
  const roomFinale = isHost ? withFinale : hostEntry?.finale ?? true;

  const roomModeRef = useRef(undefined);
  const roomDepthRef = useRef("standard");
  const roomFinaleRef = useRef(true);

  useEffect(() => {
    poolNameRef.current = poolName;
    rosterRef.current = roster;
    phaseRef.current = phase;
    roundRef.current = round;
    claimsRef.current = claims;
    roomModeRef.current = roomMode;
    roomDepthRef.current = roomDepth;
    roomFinaleRef.current = roomFinale;
    poolChoiceRef.current = poolChoice;
  });

  // Host only: re-publish presence when the depth selector changes, so every
  // client resolves its artist against the same cap.
  useEffect(() => {
    if (!isHost || !conn.current) return;
    conn.current.track({ mode, depth, finale: withFinale });
  }, [isHost, mode, depth, withFinale, phase]);

  /* ---------------- Identity ---------------- */

  useEffect(() => {
    if (!isRoomsEnabled()) {
      setNotice("Multiplayer isn't available on this deployment.");
      setPhase("closed");
      return;
    }
    meId.current = getPlayerId();
    const saved = loadPlayerName();
    if (saved) setName(saved);
    else setPhase("naming");
  }, []);

  /* ---------------- Host: build the round list and drive rounds ---------------- */

  // The engine decides what happens; the page just puts it on the wire.
  function emit(directive) {
    if (!directive) return;
    conn.current?.send(directive.event, directive.payload);
  }

  function nextRound() {
    clearTimeout(advanceTimer.current);
    emit(host.current?.next());
  }

  // Superfan: every player resolves their OWN artist in their OWN browser. That
  // spread is what makes the mode viable — one host resolving five catalogs
  // through the shared iTunes proxy would crawl.
  async function claimArtist(artist) {
    // The host's depth, not this client's local default — an unequal cap would
    // quietly break the fairness the setting exists to provide.
    const cap = DEPTH_CAPS[roomDepthRef.current] ?? DEPTH_CAPS.standard;
    setResolveNote(`Pulling ${artist}…`);
    setResolving(true);
    myPool.current = [];
    myPlayed.current = new Set();
    myLastId.current = null;

    const collected = [];
    await streamArtistPool(artist, {
      // Doubles as the depth cap: streamArtistPool checks this between album
      // lookups, so a Hits game stops after roughly the first search instead of
      // walking the whole discography.
      isAborted: () => collected.length >= cap,
      onSong: (song) => {
        if (collected.length < cap) collected.push(song);
        if (collected.length % 10 === 0) {
          setResolveNote(`Pulling ${artist}… ${collected.length} songs`);
        }
      },
    });

    const playable = dedupeById(collected.filter((s) => s.previewUrl)).slice(0, cap);
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

  function startSuperfanGame() {
    closedFor.current = -1;
    const h = host.current;
    const claimMap = Object.fromEntries(claimsRef.current.map((c) => [c.playerId, c.artist]));
    const names = Object.fromEntries(rosterRef.current.map((p) => [p.id, p.name]));
    knownIds.current = new Set(rosterRef.current.map((p) => p.id));

    conn.current?.send("start", { rounds, poolName: "Superfan", poolSpec: null });

    const begin = () => emit(h.start({ rounds, claims: claimMap, names, withFinale }));
    if (!withFinale) {
      // No finale means no crossover list, so there are no samples to wait for.
      begin();
      return;
    }
    // Samples arrive as their own broadcasts in response to `start`; give them a
    // moment to land before the crossover list is built out of them.
    setTimeout(begin, 1500);
  }

  function startGame() {
    closedFor.current = -1;
    if (mode === "superfan") return startSuperfanGame();
    const h = host.current;
    if (!h || h.poolSize() < MIN_POOL_SIZE) return;
    knownIds.current = new Set(rosterRef.current.map((p) => p.id));

    conn.current?.send("pool", {
      count: h.poolSize(),
      poolName: poolNameRef.current,
      locked: true,
    });
    conn.current?.send("start", {
      rounds,
      poolName: poolNameRef.current,
      poolSpec: poolChoiceRef.current,
    });

    const names = Object.fromEntries(rosterRef.current.map((p) => [p.id, p.name]));
    emit(h.start({ rounds, names }));
  }

  // Idempotent per round. Two paths can close a round — everyone answering, and
  // the 60s cap expiring — and with the reveal delay below they can now overlap.
  // Closing twice would run the engine's scoring twice and double every total.
  function closeRound() {
    const h = host.current;
    if (!h) return;
    const idx = h.roundIndex();
    if (idx < 0 || closedFor.current === idx) return;
    closedFor.current = idx;
    clearTimeout(capTimer.current);
    clearTimeout(revealTimer.current);
    emit(h.close(rosterRef.current));
  }

  // Everyone has answered — but whoever finished last has only just seen the
  // answer. Hold the scoreboard back briefly so they get to read it, instead of
  // being thrown straight into the standings.
  function maybeCloseRound() {
    const h = host.current;
    if (!h || h.roundIndex() < 0) return;
    if (closedFor.current === h.roundIndex()) return;
    if (!h.hasAllReports(rosterRef.current.map((p) => p.id))) return;
    clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(closeRound, REVEAL_MS);
  }

  /* ---------------- Channel events ---------------- */

  function handleEvent(event, payload) {
    if (event === "pool") {
      setPoolCount(payload.count);
      if (payload.poolName) {
        setPoolName(payload.poolName);
        poolNameRef.current = payload.poolName;
      }
      setLocked(!!payload.locked);
      return;
    }

    if (event === "add" && isHost) {
      // The host is the authority on the pool, so the per-player cap is enforced
      // here too — not only in the sender's UI.
      const h = host.current;
      if (h.contributionCount(payload.playerId) >= MAX_CONTRIBUTIONS_PER_PLAYER) return;
      h.addContribution({ song: payload.song, by: payload.playerId, byName: payload.name });
      h.setContributions(dedupeContributions(h.contributions(), h.pool()));
      publishPool();
      return;
    }

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

    if (event === "mastery") {
      // No song came over the wire on purpose — pick our own, from our own pool.
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

    if (event === "start") {
      // Superfan: hand the host this player's slice of the crossover finale.
      // Sent on `start` rather than on claim, so re-picking an artist can't
      // leave a stale sample behind.
      if (roomModeRef.current === "superfan" && roomFinaleRef.current && myPool.current.length) {
        conn.current?.send("sample", {
          playerId: meId.current,
          songs: shuffled(myPool.current).slice(0, SUPERFAN_SAMPLE_SIZE),
        });
        crossoverPool.current = dedupeById([...myPool.current]);
      }
      setLocked(true);
      setTotals([]);
      setTotalRounds(payload.rounds);
      poolSpecRef.current = payload.poolSpec;
      if (payload.poolName) {
        setPoolName(payload.poolName);
        poolNameRef.current = payload.poolName;
      }
      return;
    }

    if (event === "round") {
      // Crossover rounds need something local for the guess box to filter, so
      // fold each one into the pool as it arrives.
      if (roomModeRef.current === "superfan") {
        crossoverPool.current = dedupeById([...crossoverPool.current, payload.song]);
      }
      setRound({
        key: `${payload.index}-${payload.song.id}-${Date.now()}`,
        kind: "round",
        ...payload,
      });
      setForceEnd(false);
      setMyResult(null);
      setLastScores(null);
      setPhase("playing");
      roundStartedAt.current = Date.now();
      // Everyone counts their own 60s from their own receipt, so clock skew
      // between phones can't shave anyone's timer.
      clearTimeout(capTimer.current);
      capTimer.current = setTimeout(() => {
        setForceEnd(true);
        if (isHost) closeRound();
      }, payload.capMs);
      return;
    }

    if (event === "done" && isHost) {
      // Stale-round and duplicate-report guards live in the engine.
      host.current?.record(payload);
      maybeCloseRound();
      return;
    }

    if (event === "unplayable" && isHost) {
      if (payload.roundIndex !== host.current?.roundIndex()) return;
      clearTimeout(capTimer.current);
      emit(host.current?.replaceDeadSong(payload.songId));
      return;
    }

    if (event === "scores") {
      clearTimeout(capTimer.current);
      setLastScores(payload);
      setTotals(payload.totals);
      setPhase("scores");
      if (isHost) {
        clearTimeout(advanceTimer.current);
        advanceTimer.current = setTimeout(nextRound, SCORE_AUTO_ADVANCE_MS);
      }
      return;
    }

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
        index: payload.index,
        song: payload.song,
        startAt: payload.startAt,
        capMs: payload.capMs,
      });
      setForceEnd(false);
      setMyResult(null);
      setPhase("playing");
      roundStartedAt.current = Date.now();
      clearTimeout(capTimer.current);
      capTimer.current = setTimeout(() => setForceEnd(true), payload.capMs);
      return;
    }

    if (event === "end") {
      clearTimeout(capTimer.current);
      clearTimeout(advanceTimer.current);
      setTotals(payload.totals || []);
      setPhase("ended");
      recordRoomHistory(payload);
      return;
    }

    if (event === "reset") {
      // Same room, same code, same people — only the pool goes. Everything the
      // finished game left behind has to clear, or the next one inherits it.
      clearTimeout(capTimer.current);
      clearTimeout(advanceTimer.current);
      clearTimeout(revealTimer.current);
      closedFor.current = -1;
      setRound(null);
      setMyResult(null);
      setForceEnd(false);
      setLastScores(null);
      setTotals([]);
      setTotalRounds(0);
      setLocked(false);
      setMyAdds([]);
      setAddQuery("");
      setAddResults([]);
      setPoolCount(0);
      setPoolName("");
      setNotice("");
      setPhase("lobby");

      if (roomModeRef.current === "superfan") {
        // Everyone re-claims, so drop the old artist and its shuffle-bag state.
        setClaims([]);
        myPool.current = [];
        myPlayed.current = new Set();
        myLastId.current = null;
        crossoverPool.current = [];
      }

      if (isHost) {
        // A fresh engine: the old one still holds the finished round list and
        // every player's running total.
        host.current = createHost({ mode });
        setPoolChoice(null);
        setNewArtist("");
      }
      return;
    }
  }

  function handleRoster(players) {
    setRoster(players);
    rosterRef.current = players;
    if (!isHost) return;

    // Someone new arrived mid-game — hand them the current state so they land
    // in the round in progress instead of an empty screen.
    for (const p of players) {
      if (knownIds.current.has(p.id)) continue;
      knownIds.current.add(p.id);

      // Broadcasts have no replay, so every claim sent before this player
      // arrived is gone as far as they're concerned. The host holds them all,
      // so re-send them to catch the newcomer up. Handlers key on playerId, so
      // everyone else just re-applies what they already had.
      if (roomModeRef.current === "superfan") {
        for (const c of claimsRef.current) conn.current?.send("claim", c);
      }

      if (host.current.roundIndex() < 0) continue; // still in the lobby, nothing to sync
      conn.current?.send("sync", {
        toPlayerId: p.id,
        totalRounds: host.current.totalRounds(),
        poolName: poolNameRef.current,
        poolSpec: poolChoiceRef.current,
        index: host.current.roundIndex(),
        song: host.current.currentEntry()?.song,
        // A rejoining player hears the clip from the start rather than an
        // offset they never heard the beginning of.
        startAt: 0,
        capMs: ROUND_CAP_MS,
        totals: host.current.standings(rosterRef.current),
      });
    }

    const present = new Set(players.map((p) => p.id));
    for (const id of [...knownIds.current]) {
      if (!present.has(id)) knownIds.current.delete(id);
    }

    // Someone left mid-round — stop waiting on them.
    if (phaseRef.current === "playing") maybeCloseRound();

    // A guest who joins after the pool was published would otherwise show 0.
    if (phaseRef.current === "lobby" && host.current.poolSize()) {
      publishPool();
    }
  }

  // Fires when the socket comes back — routinely, on mobile, because suspending
  // a tab drops it. The host has to actively repair the room here: while it was
  // gone nobody could advance a round, and guests may have been sitting on a
  // frozen screen.
  function handleStatus(state) {
    if (state !== "subscribed" || !isHost) return;

    // Forget who we'd already greeted, so the next roster sync re-sends claims
    // and re-syncs every player rather than assuming they're all up to date.
    knownIds.current = new Set();

    const h = host.current;
    const midGame = h && h.roundIndex() >= 0 && phaseRef.current !== "ended";
    if (!midGame) return;

    // Put everyone back on the current round. It restarts that round rather
    // than resuming mid-way, which is the honest outcome: the timers froze with
    // the tab, so nobody's elapsed time meant anything any more.
    closedFor.current = -1;
    clearTimeout(capTimer.current);
    clearTimeout(revealTimer.current);
    emit(h.currentDirective());
  }

  // Latest-ref pattern: the channel is joined once per room, but the handlers
  // must see current state. Declared before the join effect so it runs first.
  const eventHandler = useRef(handleEvent);
  const rosterHandler = useRef(handleRoster);
  const statusHandler = useRef(handleStatus);
  useEffect(() => {
    eventHandler.current = handleEvent;
    rosterHandler.current = handleRoster;
    statusHandler.current = handleStatus;
  });

  /* ---------------- Join the channel ---------------- */

  useEffect(() => {
    if (!name || !meId.current || phase === "closed") return;

    const c = joinRoom(code, {
      // Only the host's URL carries ?mode= and the depth selector, so both ride
      // in presence for everyone else to read off the host's entry.
      self: {
        id: meId.current,
        name,
        isHost,
        mode: isHost ? mode : null,
        depth: isHost ? depth : null,
        finale: isHost ? withFinale : null,
      },
      onEvent: (e, p) => eventHandler.current(e, p),
      onRoster: (r) => rosterHandler.current(r),
      onStatus: (st) => statusHandler.current(st),
    });
    conn.current = c;
    setPhase((prev) => (prev === "connecting" || prev === "naming" ? "lobby" : prev));

    return () => {
      c.leave();
      conn.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, code, isHost]);

  useEffect(
    () => () => {
      clearTimeout(capTimer.current);
      clearTimeout(advanceTimer.current);
      clearTimeout(revealTimer.current);
      clearTimeout(hostGraceTimer.current);
      clearTimeout(addDebounce.current);
    },
    []
  );

  /* ---------------- Host: resolve the pool ---------------- */

  function publishPool(songs, label) {
    const h = host.current;
    if (!h) return;
    if (songs) h.setPool(songs);
    const name = label ?? poolNameRef.current;
    poolNameRef.current = name;
    setPoolCount(h.poolSize());
    setPoolName(name);
    conn.current?.send("pool", { count: h.poolSize(), poolName: name, locked: false });
  }

  useEffect(() => {
    if (!isHost || phase !== "lobby") return;
    // Superfan has no shared pool — every player resolves their own artist.
    if (mode === "superfan") return;
    // No pool chosen yet: the host is at the picker after "new pool, same room".
    if (!poolChoice) return;
    let aborted = false;

    async function preparePack() {
      const pack = getPack(poolChoice.id);
      if (!pack) {
        setNotice("That pack no longer exists.");
        return;
      }
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
      setPreparing(true);
      const collected = [];
      await streamArtistPool(poolChoice.name, {
        isAborted: () => aborted,
        onSong: (song) => {
          collected.push(song);
          // Republish periodically so the lobby count visibly climbs.
          if (collected.length % 10 === 0) publishPool(collected, poolChoice.name);
        },
      });
      if (aborted) return;
      publishPool(collected, poolChoice.name);
      setPreparing(false);
    }

    if (poolChoice.type === "pack") preparePack();
    else if (poolChoice.type === "artist") prepareArtist();

    return () => {
      aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, phase, mode, poolChoice]);

  /* ---------------- Contributions ---------------- */

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
    if (locked || myAdds.length >= MAX_CONTRIBUTIONS_PER_PLAYER) return;
    if (myAdds.some((s) => s.id === song.id)) return;
    setMyAdds((list) => [...list, song]);
    setAddQuery("");
    setAddResults([]);
    conn.current?.send("add", { playerId: meId.current, name, song });
  }

  /* ---------------- Playing ---------------- */

  function handleRoundFinish({ won, guessCount }) {
    const ms = Date.now() - roundStartedAt.current;
    setMyResult({ won, guessCount });
    conn.current?.send("done", {
      playerId: meId.current,
      roundIndex: roundRef.current?.index,
      won,
      guessCount,
      ms,
    });
  }

  function handleRoundUnplayable() {
    conn.current?.send("unplayable", {
      playerId: meId.current,
      roundIndex: roundRef.current?.index,
      songId: roundRef.current?.song?.id,
    });
  }

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

  function replayPoolSolo() {
    if (!poolSpecRef.current) return;
    setActivePool(poolSpecRef.current);
    router.push("/play");
  }

  /* ---------------- Room membership guards ---------------- */

  // Presence gives every client the same roster, so a late arrival can see it's
  // past the cap and leave on its own — no host arbitration needed.
  useEffect(() => {
    if (phase !== "lobby" || isHost) return;
    const idx = roster.findIndex((p) => p.id === meId.current);
    if (idx >= MAX_PLAYERS) {
      conn.current?.leave();
      conn.current = null;
      setNotice(`That room is full (${MAX_PLAYERS} players max).`);
      setPhase("closed");
    }
  }, [roster, phase, isHost]);

  // The host's browser is the server, so losing it stops the room — but a
  // suspended mobile tab drops presence exactly like a closed one, and the old
  // behaviour (close immediately, permanently) meant glancing at another app
  // killed the game for everyone with no way back. Wait out a grace period, and
  // recover the moment the host reappears.
  useEffect(() => {
    if (isHost || phase === "connecting" || phase === "naming" || phase === "closed") return;
    if (roster.length === 0) return; // presence hasn't settled yet

    if (roster.some((p) => p.isHost)) {
      clearTimeout(hostGraceTimer.current);
      hostGraceTimer.current = null;
      setHostAway(false);
      return;
    }

    if (hostGraceTimer.current) return; // already counting down
    setHostAway(true);
    clearTimeout(capTimer.current); // don't score a round nobody can close
    hostGraceTimer.current = setTimeout(() => {
      hostGraceTimer.current = null;
      setNotice("The host left the room.");
      setPhase("closed");
    }, HOST_GRACE_MS);
  }, [roster, isHost, phase]);

  /* ---------------- Render ---------------- */

  if (phase === "closed") {
    return (
      <div className="page center">
        <p className="error-msg">{notice}</p>
        <Link href="/" className="btn btn-primary">
          Back to the game
        </Link>
      </div>
    );
  }

  if (phase === "naming") {
    const commit = () => {
      const clean = nameDraft.trim().slice(0, 20);
      if (!clean) return;
      savePlayerName(clean);
      setName(clean);
    };
    return (
      <div className="page center room-naming">
        <h1>
          Join room <span className="mono">{code}</span>
        </h1>
        <label className="field">
          <span>Your name</span>
          <input
            type="text"
            value={nameDraft}
            maxLength={20}
            placeholder="What should we call you?"
            autoComplete="off"
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commit()}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!nameDraft.trim()}
          onClick={commit}
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

  // Checked before the game screens but after `closed`, so it suspends whatever
  // was happening rather than ending it. State is untouched underneath: when
  // the host returns this simply stops rendering and the room carries on.
  if (hostAway) {
    return (
      <div className="page center">
        <div className="loader" aria-hidden="true" />
        <p className="load-note">
          Lost the host — probably switched apps. Waiting for them to come back…
        </p>
        <p className="dim">
          The room picks up where it left off if they return shortly.
        </p>
        <Link href="/" className="link-quiet">
          Leave the room
        </Link>
      </div>
    );
  }

  if (phase === "playing" && round) {
    return (
      <div className="page game room-game">
        <div className="game-top">
          <p className="eyebrow">
            Round <strong>{round.index + 1}</strong>
            {totalRounds ? <span className="dim"> of {totalRounds}</span> : null}
            {round.kind === "mastery" && <span className="dim"> · your artist</span>}
            <span className="dim"> · room {code}</span>
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
          forceEnd={forceEnd}
          capMs={round.capMs}
          localSongs={
            roomMode !== "superfan"
              ? null
              : round.kind === "mastery"
              ? myPool.current
              : crossoverPool.current
          }
          onFinish={handleRoundFinish}
          onUnplayable={handleRoundUnplayable}
        >
          {myResult && (
            <RoundOutcome
              won={myResult.won}
              guessCount={myResult.guessCount}
              song={round.song}
              note="Waiting for everyone else…"
            />
          )}
        </RoundBoard>
      </div>
    );
  }

  if (phase === "scores" && lastScores) {
    return (
      <div className="page room-scores">
        <p className="eyebrow">
          Round {lastScores.index + 1} of {totalRounds}
        </p>
        <Scoreboard
          results={lastScores.results}
          contributedBy={lastScores.contributedBy}
          ownerName={lastScores.ownerName}
          artist={lastScores.artist}
          totals={lastScores.totals}
          meId={meId.current}
        />
        {isHost ? (
          <button type="button" className="btn btn-primary" onClick={nextRound}>
            Next round
          </button>
        ) : (
          <p className="dim">Next round in a moment…</p>
        )}
      </div>
    );
  }

  if (phase === "ended") {
    const winner = totals[0];
    return (
      <div className="page room-ended">
        <h1>
          {winner?.id === meId.current ? (
            <>
              You <em>won.</em>
            </>
          ) : (
            `${winner?.name || "Nobody"} wins.`
          )}
        </h1>
        <Scoreboard totals={totals} meId={meId.current} final />
        <div className="room-actions">
          {isHost && (
            <>
              <button type="button" className="btn btn-primary" onClick={startGame}>
                Play again
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => conn.current?.send("reset", {})}
              >
                {roomMode === "superfan" ? "New artists, same room" : "New pool, same room"}
              </button>
            </>
          )}
          <button type="button" className="btn btn-ghost" onClick={replayPoolSolo}>
            Replay this pool solo
          </button>
          <Link href="/" className="link-quiet">
            Back to the game
          </Link>
        </div>
      </div>
    );
  }

  /* ---------------- Lobby ---------------- */

  const readyClaims = claims.filter((c) => c.ready);
  const canStart =
    isHost &&
    roster.length >= MIN_PLAYERS &&
    (mode === "superfan"
      ? readyClaims.length === roster.length
      : poolCount >= MIN_POOL_SIZE && !preparing);

  return (
    <div className="page room">
      <div className="room-head">
        <p className="eyebrow">Room code</p>
        <p className="room-code mono">{code}</p>
        <p className="dim">Share this code — or this page&rsquo;s link — to let friends in.</p>
      </div>

      <section className="section">
        <p className="eyebrow">
          In the room{" "}
          <span className="dim">
            · {roster.length}/{MAX_PLAYERS}
          </span>
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
      </section>

      {roomMode === "superfan" && (
        <SuperfanLobby
          claims={claims}
          meId={meId.current}
          myClaim={claims.find((c) => c.playerId === meId.current) || null}
          onClaim={claimArtist}
          depth={roomDepth}
          onDepth={setDepth}
          withFinale={roomFinale}
          onWithFinale={setWithFinale}
          isHost={isHost}
          resolving={resolving}
          resolveNote={resolveNote}
        />
      )}

      {roomMode === "shared" && isHost && !poolChoice && (
        <>
          <section className="section">
            <p className="eyebrow">Pick a pack</p>
            <div className="grid">
              {packs.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="card pool-card"
                  onClick={() => setPoolChoice({ type: "pack", id: p.id })}
                >
                  <span className="pool-name">{p.name}</span>
                  <span className="pool-blurb">{p.blurb}</span>
                  <span className="pool-count mono">{p.tracks.length} songs</span>
                </button>
              ))}
            </div>
          </section>

          <section className="section">
            <p className="eyebrow">Or an artist</p>
            <form
              className="artist-form"
              onSubmit={(e) => {
                e.preventDefault();
                const a = newArtist.trim();
                if (a) setPoolChoice({ type: "artist", name: a });
              }}
            >
              <input
                type="text"
                value={newArtist}
                placeholder="Any artist…"
                autoComplete="off"
                aria-label="Artist for the next round"
                onChange={(e) => setNewArtist(e.target.value)}
              />
              <button type="submit" className="btn btn-ghost" disabled={!newArtist.trim()}>
                Use artist
              </button>
            </form>
          </section>
        </>
      )}

      {roomMode === "shared" && (!isHost || poolChoice) && (
        <section className="section">
          <p className="eyebrow">Pool</p>
          <p>
            <strong>{poolName || "…"}</strong>
            <span className="dim"> · {poolCount} songs</span>
            {preparing && <span className="dim"> · preparing…</span>}
          </p>
        </section>
      )}

      {roomMode === undefined && <p className="dim">Finding the host…</p>}

      {roomMode === "shared" && !locked && (
        <section className="section">
          <p className="eyebrow">
            Add songs{" "}
            <span className="dim">
              · {myAdds.length}/{MAX_CONTRIBUTIONS_PER_PLAYER}
            </span>
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
                aria-label="Search for a song to add"
                onChange={(e) => setAddQuery(e.target.value)}
              />
              {addQuery.trim() && (
                <ul className="suggestions" role="listbox">
                  {addResults.map((s) => (
                    <li key={s.id}>
                      {/* onMouseDown fires before blur, so the click lands */}
                      <button
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          addSong(s);
                        }}
                      >
                        <span className="sg-title">{s.title}</span>
                        <span className="sg-artist">{s.artist}</span>
                      </button>
                    </li>
                  ))}
                  {addResults.length === 0 && (
                    <li className="sg-empty">
                      {addSearching ? "Searching…" : "No songs found."}
                    </li>
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

      {notice && <p className="error-msg">{notice}</p>}

      {isHost ? (
        <div className="room-actions">
          <label className="field inline">
            <span>Rounds</span>
            <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
              {[5, 10, 15, 20].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-primary" disabled={!canStart} onClick={startGame}>
            Start game
          </button>
          {!canStart && (
            <p className="dim">
              {roster.length < MIN_PLAYERS
                ? `Need at least ${MIN_PLAYERS} players.`
                : mode === "superfan"
                ? `Waiting on ${roster.length - readyClaims.length} player${
                    roster.length - readyClaims.length === 1 ? "" : "s"
                  } to claim an artist…`
                : preparing
                ? "Waiting for the pool to finish loading…"
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

// useSearchParams needs a Suspense boundary during prerender.
export default function RoomPageWrapper() {
  return (
    <Suspense
      fallback={
        <div className="page center">
          <div className="loader" aria-hidden="true" />
        </div>
      }
    >
      <RoomPage />
    </Suspense>
  );
}
