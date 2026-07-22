// Client-side helpers for finding playable 30-second previews.
// All requests go through our own /api/itunes proxy (Apple's API has no CORS
// headers, so the browser can't call it directly).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pacing between network lookups. Apple throttles aggressively but the exact
// ceiling isn't published and moves around, so instead of guessing one safe
// number we start brisk and let real responses tune it: every throttle doubles
// the gap, every success eases it back down.
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 8000;
let lookupDelay = BASE_DELAY_MS;

// Raised when the server reports throttling so callers can back off.
export class ThrottledError extends Error {
  constructor() {
    super("iTunes is rate limiting us.");
    this.name = "ThrottledError";
  }
}

function noteThrottled() {
  lookupDelay = Math.min(lookupDelay * 2, MAX_DELAY_MS);
}

function noteSuccess() {
  // Ease back gradually rather than snapping to the floor, so one lucky
  // response doesn't undo a backoff we clearly needed.
  lookupDelay = Math.max(BASE_DELAY_MS, Math.round(lookupDelay * 0.8));
}

/* ---------------- Search ---------------- */

// Throws ThrottledError when Apple is rate limiting, so callers can tell
// "slow down and retry" apart from "this song genuinely has no preview".
export async function searchSongs(term, { limit = 25, attribute = "" } = {}) {
  const params = new URLSearchParams({ term, limit: String(limit) });
  if (attribute) params.set("attribute", attribute);
  const res = await fetch(`/api/itunes?${params.toString()}`);
  if (!res.ok) throw new ThrottledError();

  const data = await res.json();
  if (data.throttled) {
    noteThrottled();
    throw new ThrottledError();
  }

  noteSuccess();
  return (data.results || []).filter((r) => r.previewUrl);
}

// Convert a raw iTunes result into the song shape the game uses everywhere.
export function toSong(r) {
  return {
    id: `it-${r.trackId}`,
    title: r.trackName,
    artist: r.artistName,
    album: r.collectionName || "",
    previewUrl: r.previewUrl,
    artworkUrl: (r.artworkUrl100 || "").replace("100x100", "300x300"),
    appleUrl: r.trackViewUrl || "", // opens the song on Apple Music
    genre: r.primaryGenreName || "",
  };
}

/* ---------------- Fuzzy matching ---------------- */
// Titles differ between services: "(feat. X)", "- Remastered 2011", accents,
// punctuation. Normalize both sides before comparing.

export function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ") // drop "(feat. …)", "[Remix]"
    .replace(/\s-\s.*$/, " ") // drop "- Remastered", "- Radio Edit"
    .replace(/\b(feat|ft|featuring)\.?\b.*$/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/&/g, "and")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titlesMatch(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// Split a credit line into individual performers. Spotify joins every
// credited artist with ", " ("Drake, 21 Savage"); iTunes uses " & " and
// often lists only the lead. Comparing the joined strings fails on every
// collaboration, so compare performer by performer instead.
function artistParts(s) {
  return (s || "")
    .split(/,|&|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bwith\b|\bx\b/i)
    .map(normalize)
    .filter(Boolean);
}

// Containment is generous, so only allow it for names long enough that a
// coincidental substring is unlikely ("Sia" must not match "Asia").
function nameNear(x, y) {
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x));
}

export function artistsMatch(a, b) {
  const xs = artistParts(a);
  const ys = artistParts(b);
  if (!xs.length || !ys.length) return false;
  // One shared performer is enough to call it the same recording.
  return xs.some((x) => ys.some((y) => nameNear(x, y)));
}

// Featured performers named in a track title: "(feat. A & B)", "[ft. C]",
// "Song featuring D". iTunes credits a guest verse to the lead artist, so the
// only place the guest's name appears is here in the title.
function featuredArtists(trackName) {
  const m = (trackName || "").match(/\b(?:feat|ft|featuring)\.?\s+(.+)$/i);
  if (!m) return [];
  const tail = m[1].replace(/[)\]].*$/, ""); // stop at the closing ) or ]
  return artistParts(tail);
}

// True if `name` performs on this track — either as the credited artist or as
// a featured guest named in the title. Lets artist mode include songs the
// artist only guests on, not just ones they lead.
function trackByArtist(r, name) {
  if (artistsMatch(r.artistName, name)) return true;
  const guests = featuredArtists(r.trackName);
  if (!guests.length) return false;
  const target = artistParts(name);
  return guests.some((g) => target.some((t) => nameNear(g, t)));
}

// The lead artist alone makes a much cleaner search term than the full
// credit line — extra names drag iTunes' relevance ranking off target.
function primaryArtist(s) {
  return artistParts(s)[0] || normalize(s);
}

// normalize() deletes everything in parentheses, which is what makes title
// matching work — but it also hides "(Instrumental)" and "(Karaoke)". Those
// match perfectly and then play the wrong audio, so rank them last instead.
const BAD_VERSION = /instrumental|karaoke|backing track|made famous by|made popular by|tribute|cover version|originally performed/i;
const WEAK_VERSION = /\blive\b|remix|acoustic|sped up|slowed|reverb|demo|commentary/i;

function versionPenalty(name) {
  if (BAD_VERSION.test(name)) return 2; // wrong audio entirely
  if (WEAK_VERSION.test(name)) return 1; // right song, harder to recognise
  return 0;
}

// Among everything that matches, prefer the plainest studio version.
// Ties keep iTunes' own relevance order, which is usually the popular cut.
function pickBest(results, matches) {
  let best = null;
  let bestPenalty = Infinity;
  for (const r of results) {
    if (!matches(r)) continue;
    const penalty = versionPenalty(r.trackName || "");
    if (penalty < bestPenalty) {
      best = r;
      bestPenalty = penalty;
      if (penalty === 0) break; // can't do better
    }
  }
  return best;
}

/* ---------------- Preview lookup with cache ---------------- */
// Cache lives in localStorage so re-importing a playlist is instant.
// A value of "miss" means we looked and found nothing playable.

// Bump this version whenever the matching rules change — old "miss" entries
// are permanent, so a stale cache would hide any improvement.
const CACHE_KEY = "earworm-match-cache-v2";
let matchCache = null;

function getCache() {
  if (matchCache) return matchCache;
  try {
    matchCache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
  } catch {
    matchCache = {};
  }
  return matchCache;
}

function persistCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(matchCache));
  } catch {
    // If storage is full, drop the cache and carry on.
    matchCache = {};
  }
}

// Returns { song: Song | null, network: boolean }.
// `network` tells callers whether to pause before the next lookup.
export async function findPreview(title, artist) {
  const cache = getCache();
  const key = `${normalize(title)}|${normalize(artist)}`;
  const cached = cache[key];
  if (cached === "miss") return { song: null, network: false };
  if (cached) return { song: cached, network: false };

  const matches = (r) =>
    titlesMatch(r.trackName, title) && artistsMatch(r.artistName, artist);

  // First try: title + lead artist. Searching with every featured artist
  // included pushes the right track down iTunes' relevance ranking.
  let results = await searchSongs(`${title} ${primaryArtist(artist)}`, { limit: 20 });
  let hit = pickBest(results, matches);

  // Fallback: search the title alone, then require the artist to match.
  // A generous limit costs nothing extra — it's the same single request.
  if (!hit) {
    await sleep(lookupDelay);
    results = await searchSongs(title, { limit: 25, attribute: "songTerm" });
    hit = pickBest(results, matches);
  }

  const song = hit ? toSong(hit) : null;
  cache[key] = song || "miss";
  persistCache();
  return { song, network: true };
}

/* ---------------- Bulk resolution ---------------- */
// Turn a list of { id?, title, artist } into playable songs. Sequential on
// purpose (rate limits). Options:
//   onProgress(done, total, missCount) — called after every track.
//   onSong(song)                       — called the moment a song is matched,
//                                        so callers can stream results into a
//                                        pool instead of waiting for the end.
//   isAborted()                        — checked each loop; returning true stops
//                                        resolution cleanly (e.g. user navigated
//                                        away mid-import).

export async function resolveTracks(tracks, { onProgress, onSong, isAborted } = {}) {
  const songs = [];
  const misses = [];
  const seen = new Set();

  for (let i = 0; i < tracks.length; i++) {
    if (isAborted?.()) break;
    const t = tracks[i];
    const dedupeKey = `${normalize(t.title)}|${normalize(t.artist)}`;
    if (seen.has(dedupeKey)) {
      onProgress?.(i + 1, tracks.length, misses.length);
      continue;
    }
    seen.add(dedupeKey);

    // Being throttled means "ask again later", not "no preview exists", so
    // wait out the backoff and retry before giving up on the track.
    let result = { song: null, network: false };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await findPreview(t.title, t.artist);
        break;
      } catch (err) {
        if (!(err instanceof ThrottledError)) break; // real failure — move on
        await sleep(lookupDelay);
      }
    }

    if (isAborted?.()) break; // don't emit results the caller no longer wants

    if (result.song) {
      // Keep the caller's id (e.g. the Spotify track id) when provided so
      // guessing compares consistently within a pool.
      const song = { ...result.song, id: t.id || result.song.id };
      songs.push(song);
      onSong?.(song);
    } else {
      misses.push({ title: t.title, artist: t.artist });
    }

    onProgress?.(i + 1, tracks.length, misses.length);
    if (result.network && i < tracks.length - 1) await sleep(lookupDelay);
  }

  return { songs, misses };
}

/* ---------------- Lookup (catalog walk) ---------------- */
// Look up the iTunes catalog by id: an artist's albums, or an album's songs.
// Throws ThrottledError like searchSongs so callers can back off.

export async function lookupById(id, { entity = "", limit = 200 } = {}) {
  const params = new URLSearchParams({ id: String(id), limit: String(limit) });
  if (entity) params.set("entity", entity);
  const res = await fetch(`/api/itunes?${params.toString()}`);
  if (!res.ok) throw new ThrottledError();

  const data = await res.json();
  if (data.throttled) {
    noteThrottled();
    throw new ThrottledError();
  }
  noteSuccess();
  return data.results || [];
}

// Retry wrapper: tolerate a couple of throttles, give up on a real failure.
async function lookupRetry(id, opts) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await lookupById(id, opts);
    } catch (err) {
      if (!(err instanceof ThrottledError)) return [];
      await sleep(lookupDelay);
    }
  }
  return [];
}

/* ---------------- Artist mode ---------------- */
// The iTunes search endpoint caps at 200 results, which after filtering and
// title-deduping only covers an artist's most popular ~120 tracks. To reach a
// deep catalog we identify the artist's id, then walk their albums one lookup
// at a time. It's many requests, so it streams: `onSong` fires as songs are
// found and `isAborted` stops it if the player leaves.

// The artist id iTunes attaches to search hits — take the most common one
// among results whose artist name actually matches (features by others carry
// their own ids and shouldn't hijack the walk).
function topArtistId(results, name) {
  const counts = {};
  for (const r of results) {
    if (!r.artistId || !artistsMatch(r.artistName, name)) continue;
    counts[r.artistId] = (counts[r.artistId] || 0) + 1;
  }
  let best = null;
  let bestN = 0;
  for (const [id, n] of Object.entries(counts)) {
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

// Albums come back with standard / deluxe / explicit / clean variants of the
// same title. Keep one per title — the one with the most tracks (usually the
// deluxe) — so we fetch fewer albums but still catch bonus tracks.
function dedupeAlbums(results) {
  const best = new Map(); // normalized name -> { id, trackCount }
  for (const r of results) {
    if (r.wrapperType !== "collection" || !r.collectionId) continue;
    const key = normalize(r.collectionName || "");
    if (!key) continue;
    const count = r.trackCount || 0;
    const cur = best.get(key);
    if (!cur || count > cur.trackCount) {
      best.set(key, { id: r.collectionId, trackCount: count });
    }
  }
  return [...best.values()].map((a) => a.id);
}

const MAX_ALBUMS = 100; // bound the walk for absurdly deep catalogs

// Skits/interludes/intros pollute a deep catalog walk. Many aren't labelled,
// but they're almost always short — so a duration floor catches the unlabelled
// ones, and the name check catches the odd long one that says "skit".
const MIN_SONG_MS = 70000; // ~70s; below this it's almost never a real song
function isSkit(r) {
  if (/\bskit\b/i.test(r.trackName || "")) return true;
  const ms = r.trackTimeMillis;
  return typeof ms === "number" && ms > 0 && ms < MIN_SONG_MS;
}

export async function streamArtistPool(name, { onSong, isAborted } = {}) {
  const seen = new Set();

  // Emit a raw iTunes result as a song if it's a fresh, playable, plain
  // studio cut this artist performs on — leading OR featured — and not a
  // skit/interlude.
  const consider = (r) => {
    if (!r || !r.previewUrl) return;
    if (!trackByArtist(r, name)) return;
    if (isSkit(r)) return;
    const key = normalize(r.trackName);
    if (!key || seen.has(key)) return;
    if (versionPenalty(r.trackName || "") >= 2) return; // instrumental/karaoke
    seen.add(key);
    onSong?.(toSong(r));
  };

  // 1) Fast first batch — a direct artist search, most popular first. Usually
  //    ~120 songs, enough to start the game instantly.
  let firstBatch = [];
  try {
    firstBatch = await searchSongs(name, { limit: 200, attribute: "artistTerm" });
  } catch {
    // Throttled on the very first call — nothing to show yet.
  }
  firstBatch.forEach(consider);
  if (isAborted?.()) return;

  // 1b) A general term search (no artistTerm attribute) matches the track
  //     title too, so it surfaces songs where this artist is only a featured
  //     guest — those are credited to the lead artist and an artist-field
  //     search never returns them. `consider`'s featured-credit check keeps
  //     the real guest spots and drops tracks that merely mention the name.
  try {
    const featured = await searchSongs(name, { limit: 200 });
    featured.forEach(consider);
  } catch {
    // Throttled — skip the feature pass; the primary catalog still loads.
  }
  if (isAborted?.()) return;

  const artistId = topArtistId(firstBatch, name);
  if (!artistId) return; // couldn't identify the artist; first batch is all we get

  // 2) Walk the catalog album by album for everything past the first 200.
  const albums = await lookupRetry(artistId, { entity: "album" });
  const albumIds = dedupeAlbums(albums).slice(0, MAX_ALBUMS);

  for (const albumId of albumIds) {
    if (isAborted?.()) return;
    const songs = await lookupRetry(albumId, { entity: "song" });
    songs.forEach(consider);
    await sleep(lookupDelay);
  }
}

/* ---------------- Guessing ---------------- */
// The guess box searches the whole iTunes catalog (not just the pool), so a
// player can name any song. A guess is judged against the round's answer, not
// by pool membership.

// If the typed text names an album that appears among the search results,
// return that album's collectionId so we can pull its full track list. The
// results already carry collectionId/Name, so this costs no extra request —
// and a normal song-title query matches no album name, so it stays null then.
const ALBUM_QUERY_MIN = 4;
function albumIdForQuery(raw, query) {
  const nq = normalize(query);
  if (nq.length < ALBUM_QUERY_MIN) return null;
  const hits = new Map(); // collectionId -> tracks-from-it seen in results
  for (const r of raw) {
    if (!r.collectionId || !r.collectionName) continue;
    const na = normalize(r.collectionName);
    // The typed text is the album's name, or the start of it.
    if (na !== nq && !na.startsWith(nq)) continue;
    hits.set(r.collectionId, (hits.get(r.collectionId) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [id, n] of hits) {
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

// Suggestions for the guess box: search the catalog, drop instrumental/karaoke
// cuts, and dedupe the version spam down to one row per title+artist. If the
// query names an album, append that album's full track list too, so a player
// can guess by album. `withAlbum: false` skips that (e.g. for pure title
// lookups). In artist mode, pass `artist` to scope results to that artist.
export async function searchGuesses(query, { limit = 8, artist = "", withAlbum = true } = {}) {
  // Bias the search toward the artist when scoped, then filter to be sure.
  const term = artist ? `${query} ${artist}` : query;
  const raw = await searchSongs(term, { limit: artist ? 25 : 15 }); // may throw ThrottledError
  const seen = new Set();
  const out = [];
  const take = (r, cap) => {
    if (out.length >= cap) return;
    if (!r.previewUrl) return;
    if (versionPenalty(r.trackName || "") >= 2) return;
    if (isSkit(r)) return;
    if (artist && !artistsMatch(r.artistName, artist)) return;
    const key = `${normalize(r.trackName)}|${normalize(r.artistName)}`;
    if (!normalize(r.trackName) || seen.has(key)) return;
    seen.add(key);
    out.push(toSong(r));
  };

  for (const r of raw) take(r, limit);

  // Album expansion: only fires when the text actually matches an album name,
  // so ordinary title guesses pay nothing. Pulls the whole album (one lookup)
  // and shows more rows than a normal title search since a full album is the
  // point here.
  if (withAlbum) {
    const albumId = albumIdForQuery(raw, query);
    if (albumId) {
      const albumTracks = await lookupRetry(albumId, { entity: "song" });
      const albumCap = 24;
      for (const r of albumTracks) {
        if (r.wrapperType && r.wrapperType !== "track") continue; // skip album header
        take(r, albumCap);
      }
    }
  }

  return out;
}

// Is the picked song the round's answer? Same iTunes track id is an instant
// yes; otherwise accept any recording with the same (normalized) title by a
// matching artist — so guessing a different album/version of the right song
// still counts, but a same-titled song by someone else doesn't.
export function isCorrectGuess(guess, answer) {
  if (!guess || !answer) return false;
  if (guess.id === answer.id) return true;
  if (normalize(guess.title) !== normalize(answer.title)) return false;
  return artistsMatch(guess.artist, answer.artist);
}
