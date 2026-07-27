"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import RoundBoard from "@/components/RoundBoard";
import Scoreboard from "@/components/Scoreboard";
import { getPack } from "@/data/packs";
import { joinRoom, isRoomsEnabled } from "@/lib/room";
import {
  MIN_PLAYERS,
  MAX_PLAYERS,
  MAX_CONTRIBUTIONS_PER_PLAYER,
  DEFAULT_ROUNDS,
  ROUND_CAP_MS,
  buildRoundList,
  dedupeContributions,
  scoreForResult,
  sortStandings,
} from "@/lib/roomGame";
import { pickStartOffset } from "@/lib/gameState";
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

  const meId = useRef(null);
  const conn = useRef(null);
  const addDebounce = useRef(null);
  const capTimer = useRef(null);
  const advanceTimer = useRef(null);
  const roundStartedAt = useRef(0);

  // Host-only authoritative state. Never rendered — showing the pool would put
  // every answer on screen.
  const poolSongs = useRef([]);
  const contributions = useRef([]);
  const roundList = useRef([]);
  const roundIndex = useRef(-1);
  const roundResults = useRef(new Map());
  const totalsRef = useRef(new Map());
  const redrawnFor = useRef(-1);
  const knownIds = useRef(new Set());

  // Mirrors of state that memo-free handlers need to read without going stale.
  const poolNameRef = useRef("");
  const poolSpecRef = useRef(null);
  const rosterRef = useRef([]);
  const phaseRef = useRef("connecting");
  const roundRef = useRef(null);

  useEffect(() => {
    poolNameRef.current = poolName;
    rosterRef.current = roster;
    phaseRef.current = phase;
    roundRef.current = round;
  });

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

  function standingsFromRef() {
    return sortStandings(
      rosterRef.current.map((p) => {
        const t = totalsRef.current.get(p.id) || { score: 0, timeMs: 0 };
        return { id: p.id, name: p.name, score: t.score, timeMs: t.timeMs };
      })
    );
  }

  function broadcastRound(index, song) {
    conn.current?.send("round", {
      index,
      song,
      startAt: pickStartOffset(),
      capMs: ROUND_CAP_MS,
    });
  }

  function nextRound() {
    clearTimeout(advanceTimer.current);
    const i = roundIndex.current + 1;
    if (i >= roundList.current.length) {
      conn.current?.send("end", {
        totals: standingsFromRef(),
        poolName: poolNameRef.current,
        rounds: roundList.current.length,
      });
      return;
    }
    roundIndex.current = i;
    roundResults.current = new Map();
    redrawnFor.current = -1;
    broadcastRound(i, roundList.current[i].song);
  }

  function startGame() {
    const list = buildRoundList({
      poolSongs: poolSongs.current,
      contributions: contributions.current,
      rounds,
    });
    if (list.length < 1) return;
    roundList.current = list;
    roundIndex.current = -1;
    roundResults.current = new Map();
    totalsRef.current = new Map();
    knownIds.current = new Set(rosterRef.current.map((p) => p.id));

    conn.current?.send("pool", {
      count: poolSongs.current.length + contributions.current.length,
      poolName: poolNameRef.current,
      locked: true,
    });
    conn.current?.send("start", {
      rounds: list.length,
      poolName: poolNameRef.current,
      poolSpec: packId
        ? { type: "pack", id: packId }
        : { type: "artist", name: artistName },
    });
    nextRound();
  }

  function closeRound() {
    clearTimeout(capTimer.current);
    const entry = roundList.current[roundIndex.current];
    const contributedById = entry?.contributedBy || null;

    const results = rosterRef.current.map((p) => {
      const r = roundResults.current.get(p.id);
      const selfPick = contributedById === p.id;
      const won = !!r?.won;
      const guessCount = r?.guessCount ?? 6;
      const points = scoreForResult({ won, guessCount, isSelfPick: selfPick });
      const prev = totalsRef.current.get(p.id) || { score: 0, timeMs: 0 };
      totalsRef.current.set(p.id, {
        score: prev.score + points,
        timeMs: prev.timeMs + (r?.ms ?? ROUND_CAP_MS),
      });
      return {
        playerId: p.id,
        name: p.name,
        won,
        guessCount,
        points,
        selfPick,
        missing: !r,
      };
    });

    const byName = contributedById
      ? rosterRef.current.find((p) => p.id === contributedById)?.name || null
      : null;

    conn.current?.send("scores", {
      index: roundIndex.current,
      contributedBy: byName,
      results,
      totals: standingsFromRef(),
    });
  }

  function maybeCloseRound() {
    if (roundIndex.current < 0) return;
    const present = rosterRef.current.map((p) => p.id);
    if (!present.length) return;
    if (present.every((id) => roundResults.current.has(id))) closeRound();
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
      const already = contributions.current.filter((c) => c.by === payload.playerId).length;
      if (already >= MAX_CONTRIBUTIONS_PER_PLAYER) return;
      contributions.current = dedupeContributions(
        [...contributions.current, { song: payload.song, by: payload.playerId, byName: payload.name }],
        poolSongs.current
      );
      publishPool(poolSongs.current, poolNameRef.current);
      return;
    }

    if (event === "start") {
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
      setRound({ key: `${payload.index}-${payload.song.id}-${Date.now()}`, ...payload });
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
      if (payload.roundIndex !== roundIndex.current) return; // stale round
      if (roundResults.current.has(payload.playerId)) return; // first report wins
      roundResults.current.set(payload.playerId, payload);
      maybeCloseRound();
      return;
    }

    if (event === "unplayable" && isHost) {
      // Preview URLs are identical for everyone, so one dead report means the
      // round is dead for all. Redraw once — a second failure would loop.
      if (payload.roundIndex !== roundIndex.current) return;
      if (redrawnFor.current === roundIndex.current) return;
      redrawnFor.current = roundIndex.current;
      poolSongs.current = poolSongs.current.filter((s) => s.id !== payload.songId);
      const replacement = poolSongs.current.find(
        (s) => !roundList.current.some((r) => r.song.id === s.id)
      );
      if (!replacement) return;
      roundList.current[roundIndex.current] = { song: replacement, contributedBy: null };
      roundResults.current = new Map();
      clearTimeout(capTimer.current);
      broadcastRound(roundIndex.current, replacement);
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
      if (roundIndex.current < 0) continue; // still in the lobby, nothing to sync
      conn.current?.send("sync", {
        toPlayerId: p.id,
        totalRounds: roundList.current.length,
        poolName: poolNameRef.current,
        poolSpec: packId
          ? { type: "pack", id: packId }
          : { type: "artist", name: artistName },
        index: roundIndex.current,
        song: roundList.current[roundIndex.current]?.song,
        // A rejoining player hears the clip from the start rather than an
        // offset they never heard the beginning of.
        startAt: 0,
        capMs: ROUND_CAP_MS,
        totals: standingsFromRef(),
      });
    }

    const present = new Set(players.map((p) => p.id));
    for (const id of [...knownIds.current]) {
      if (!present.has(id)) knownIds.current.delete(id);
    }

    // Someone left mid-round — stop waiting on them.
    if (phaseRef.current === "playing") maybeCloseRound();

    // A guest who joins after the pool was published would otherwise show 0.
    if (phaseRef.current === "lobby" && poolSongs.current.length) {
      publishPool(poolSongs.current, poolNameRef.current);
    }
  }

  // Latest-ref pattern: the channel is joined once per room, but the handlers
  // must see current state. Declared before the join effect so it runs first.
  const eventHandler = useRef(handleEvent);
  const rosterHandler = useRef(handleRoster);
  useEffect(() => {
    eventHandler.current = handleEvent;
    rosterHandler.current = handleRoster;
  });

  /* ---------------- Join the channel ---------------- */

  useEffect(() => {
    if (!name || !meId.current || phase === "closed") return;

    const c = joinRoom(code, {
      self: { id: meId.current, name, isHost },
      onEvent: (e, p) => eventHandler.current(e, p),
      onRoster: (r) => rosterHandler.current(r),
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
      clearTimeout(addDebounce.current);
    },
    []
  );

  /* ---------------- Host: resolve the pool ---------------- */

  function publishPool(songs, label) {
    const playable = (songs || []).filter((s) => s.previewUrl);
    poolSongs.current = playable;
    poolNameRef.current = label;
    const total = playable.length + contributions.current.length;
    setPoolCount(total);
    setPoolName(label);
    conn.current?.send("pool", { count: total, poolName: label, locked: false });
  }

  useEffect(() => {
    if (!isHost || phase !== "lobby") return;
    let aborted = false;

    async function preparePack() {
      const pack = getPack(packId);
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
      await streamArtistPool(artistName, {
        isAborted: () => aborted,
        onSong: (song) => {
          collected.push(song);
          // Republish periodically so the lobby count visibly climbs.
          if (collected.length % 10 === 0) publishPool(collected, artistName);
        },
      });
      if (aborted) return;
      publishPool(collected, artistName);
      setPreparing(false);
    }

    if (packId) preparePack();
    else if (artistName) prepareArtist();
    else setNotice("This room has no pool — the host link is missing a pack or artist.");

    return () => {
      aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, phase, packId, artistName]);

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

  // The host's browser is the server, so its departure ends the room.
  useEffect(() => {
    if (isHost || phase === "connecting" || phase === "naming" || phase === "closed") return;
    if (roster.length === 0) return; // presence hasn't settled yet
    if (roster.some((p) => p.isHost)) return;
    clearTimeout(capTimer.current);
    setNotice("The host ended the room.");
    setPhase("closed");
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
        <h1 className="display">
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

  if (phase === "playing" && round) {
    return (
      <div className="page game room-game">
        <div className="game-top">
          <p className="eyebrow">
            Round <strong>{round.index + 1}</strong>
            {totalRounds ? <span className="dim"> of {totalRounds}</span> : null}
            <span className="dim"> · room {code}</span>
          </p>
        </div>

        <RoundBoard
          key={round.key}
          song={round.song}
          startAt={round.startAt}
          forceEnd={forceEnd}
          onFinish={handleRoundFinish}
          onUnplayable={handleRoundUnplayable}
        >
          {myResult && (
            <p className="room-waiting">
              {myResult.won ? `Got it in ${myResult.guessCount}.` : "Missed that one."}{" "}
              Waiting for everyone else…
            </p>
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
        <h1 className="display">
          {winner?.id === meId.current ? "You won." : `${winner?.name || "Nobody"} wins.`}
        </h1>
        <Scoreboard totals={totals} meId={meId.current} final />
        <div className="room-actions">
          {isHost && (
            <button type="button" className="btn btn-primary" onClick={startGame}>
              Play again
            </button>
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

  const canStart =
    isHost && roster.length >= MIN_PLAYERS && poolCount >= MIN_POOL_SIZE && !preparing;

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

      <section className="section">
        <p className="eyebrow">Pool</p>
        <p>
          <strong>{poolName || "…"}</strong>
          <span className="dim"> · {poolCount} songs</span>
          {preparing && <span className="dim"> · preparing…</span>}
        </p>
      </section>

      {!locked && (
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
              {preparing
                ? "Waiting for the pool to finish loading…"
                : roster.length < MIN_PLAYERS
                ? `Need at least ${MIN_PLAYERS} players.`
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
