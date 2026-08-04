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
import { pickStartOffset, MAX_GUESSES } from "./gameState.js";

export function createHost({ mode = "shared", random = Math.random } = {}) {
  const s = {
    mode,
    random,
    rounds: 0,
    poolSongs: [],
    contributions: [],
    claims: {}, // playerId -> artist name (superfan)
    withFinale: true, // superfan: run the crossover finale at all
    maxMastery: 0, // superfan: smallest personal pool; 0 = unknown/no clamp
    samples: new Map(), // playerId -> songs[] (superfan)
    list: [],
    index: -1,
    results: new Map(), // playerId -> report, cleared each round
    totals: new Map(), // playerId -> { score, timeMs }
    redrawnFor: -1,
    closedIndex: -1, // last round already scored; guards double-counting
  };

  // dist[i] = rounds won on guess i+1, matching the shape solo stats already use.
  const emptyTotal = () => ({ score: 0, timeMs: 0, dist: [0, 0, 0, 0, 0, 0], misses: 0 });

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
      // Size the finale to the number of distinct artists, so each superfan gets
      // at least one round on their own turf. The host can switch it off, in
      // which case every round is a mastery round.
      let { mastery, finale } = splitPhases(s.rounds, s.samples.size, s.withFinale);
      // Nobody can play more mastery rounds than the smallest personal pool has
      // songs, or that player's shuffle bag wraps and repeats mid-game. Pool
      // sizes are only known once everyone has resolved, which is why this is a
      // clamp here rather than a gate in the lobby.
      if (s.maxMastery > 0) mastery = Math.min(mastery, s.maxMastery);
      s.list = [
        ...Array.from({ length: mastery }, () => ({ kind: "mastery" })),
        // Placeholders, not rounds. Which artist defends the spare finale round
        // depends on who's losing, and at kickoff nobody has scored anything —
        // so the crossover rounds are drawn later, by fillFinale().
        ...Array.from({ length: finale }, () => ({ kind: "pending" })),
      ];
      return;
    }
    s.list = buildRoundList({
      poolSongs: s.poolSongs,
      contributions: s.contributions,
      rounds: s.rounds,
      random: s.random,
    }).map((r) => ({ kind: "round", song: r.song, contributedBy: r.contributedBy, ownerId: null }));
  }

  // Draw the crossover rounds, now that the mastery phase has produced a
  // scoreboard for finaleQuotas to read. Runs once — the placeholders it
  // replaces are the only trigger, so a host reconnect re-emitting the current
  // round can't reshuffle a finale that's already underway.
  function fillFinale() {
    const first = s.list.findIndex((e) => e.kind === "pending");
    if (first < 0) return;
    const count = s.list.length - first;
    const samples = [...s.samples.entries()].map(([playerId, songs]) => ({ playerId, songs }));
    const drawn = buildCrossoverList(samples, count, s.random, standingsFromTotals());
    // A short draw (someone's sample thinner than the finale needs) ends the
    // game early rather than leaving unplayable placeholders in the list.
    s.list = [...s.list.slice(0, first), ...drawn];
  }

  function directiveFor(index) {
    if (s.list[index]?.kind === "pending") fillFinale();
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

  function start({ rounds, claims, names, withFinale, maxMastery } = {}) {
    s.rounds = rounds || s.rounds || 10;
    if (claims) s.claims = claims;
    if (names) nameLookup = names;
    if (withFinale !== undefined) s.withFinale = !!withFinale;
    if (maxMastery !== undefined) s.maxMastery = maxMastery || 0;
    s.index = 0;
    s.results = new Map();
    s.totals = new Map();
    s.redrawnFor = -1;
    s.closedIndex = -1;
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

  // Returns null if this round has already been scored. Two callers can race to
  // close a round — everyone answering, and the time cap expiring — and scoring
  // twice would double every total. The room page guards this as well; this is
  // the layer that makes it impossible rather than merely unlikely.
  function close(roster) {
    if (s.closedIndex === s.index) return null;
    s.closedIndex = s.index;
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
      const prev = s.totals.get(r.playerId) || emptyTotal();
      const dist = prev.dist.slice();
      let misses = prev.misses;
      // Counted on the guess, not the points: a superfan's own pick scores zero
      // but they still named it, and the distribution is about how well people
      // guessed rather than how the scoring treated it.
      if (r.won) dist[Math.min(Math.max(r.guessCount, 1), MAX_GUESSES) - 1] += 1;
      else misses += 1;
      s.totals.set(r.playerId, {
        score: prev.score + r.points,
        timeMs: prev.timeMs + r.ms,
        dist,
        misses,
      });
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
        const t = s.totals.get(p.id) || emptyTotal();
        return {
          id: p.id,
          name: p.name,
          score: t.score,
          timeMs: t.timeMs,
          dist: t.dist,
          misses: t.misses,
        };
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
    // Re-emit the round already in progress, without advancing. Used when the
    // host's tab is restored after being suspended: everyone gets put back on
    // the same round instead of the room sitting frozen.
    currentDirective: () => (s.index < 0 ? null : directiveFor(s.index)),
    roundIndex: () => s.index,
    totalRounds: () => s.list.length,
    currentEntry: () => s.list[s.index] || null,
  };
}
