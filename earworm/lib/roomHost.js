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

  let nameLookup = {};
  function nameFor(id) {
    return nameLookup[id] || id;
  }

  /* ---------- Lobby accumulation ---------- */

  function setPool(songs) {
    s.poolSongs = (songs || []).filter((x) => x && x.previewUrl);
  }

  function addContribution(entry) {
    if (!entry?.song) return;
    s.contributions.push(entry);
  }

  function setContributions(list) {
    s.contributions = list || [];
  }

  function contributionCount(playerId) {
    return s.contributions.filter((c) => c.by === playerId).length;
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
    if (people.length) nameLookup = Object.fromEntries(people.map((p) => [p.id, p.name]));
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
    const people =
      roster && roster.length
        ? roster
        : [...s.totals.keys()].map((id) => ({ id, name: nameFor(id) }));
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
