// Server-side proxy for Apple's iTunes APIs (Search + Lookup).
//
// Why this exists: the iTunes API doesn't send CORS headers, so the browser
// can't call it directly — but our server can. We also cache responses in
// memory to stay well under Apple's ~20 requests/minute guidance.
//
// Two modes:
//   ?term=...            -> Search API (find songs by name/artist)
//   ?id=...&entity=...   -> Lookup API (an artist's albums, an album's songs)

const cache = new Map(); // key -> { ts, data }
const TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_ENTRIES = 500;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const id = (searchParams.get("id") || "").trim();
  const term = (searchParams.get("term") || "").trim();
  if (!id && !term) return Response.json({ results: [] });

  // 200 is Apple's own maximum for both endpoints.
  const limit = String(Math.min(Number(searchParams.get("limit")) || 25, 200));
  const attribute = searchParams.get("attribute") || "";
  const entity = searchParams.get("entity") || "";
  const country = searchParams.get("country") || "US";

  const key = [id || term.toLowerCase(), limit, attribute, entity, country].join("|");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) {
    return Response.json(hit.data);
  }

  // Build the upstream URL for whichever mode we're in.
  let upstream;
  if (id) {
    const p = new URLSearchParams({ id, country, limit });
    if (entity) p.set("entity", entity);
    upstream = `https://itunes.apple.com/lookup?${p.toString()}`;
  } else {
    const p = new URLSearchParams({
      term,
      media: "music",
      entity: entity || "song",
      limit,
      country,
    });
    if (attribute) p.set("attribute", attribute);
    upstream = `https://itunes.apple.com/search?${p.toString()}`;
  }

  try {
    const res = await fetch(upstream, { headers: { Accept: "application/json" } });

    if (!res.ok) {
      // 403/429 mean Apple is throttling us. Flag it explicitly: an empty
      // result set that means "slow down" must never be mistaken for one
      // that means "nothing found" — the client caches misses permanently,
      // so a silent throttle would poison the cache.
      return Response.json({
        results: [],
        error: `iTunes responded ${res.status}`,
        throttled: res.status === 429 || res.status === 403,
      });
    }

    // iTunes sometimes serves JSON with a text/javascript content type,
    // so parse the body manually instead of res.json().
    const data = JSON.parse(await res.text());

    // Trim each result to the fields the game needs. We keep both song fields
    // (trackId, previewUrl…) and collection fields (collectionId, trackCount…)
    // so the same slim shape works for songs, albums, and the artist header
    // row. Callers filter by what they need (e.g. previewUrl for songs).
    const slim = {
      results: (data.results || []).map((r) => ({
        wrapperType: r.wrapperType || "",
        kind: r.kind || "",
        trackId: r.trackId,
        trackName: r.trackName,
        artistId: r.artistId,
        artistName: r.artistName,
        collectionId: r.collectionId,
        collectionName: r.collectionName,
        trackCount: r.trackCount,
        trackTimeMillis: r.trackTimeMillis,
        previewUrl: r.previewUrl || null,
        artworkUrl100: r.artworkUrl100 || "",
        primaryGenreName: r.primaryGenreName || "",
      })),
    };

    cache.set(key, { ts: Date.now(), data: slim });
    if (cache.size > MAX_CACHE_ENTRIES) {
      cache.delete(cache.keys().next().value); // evict oldest
    }

    return Response.json(slim);
  } catch {
    // A network failure is also "unknown", not "nothing found" — same rule.
    return Response.json({
      results: [],
      error: "Could not reach iTunes.",
      throttled: true,
    });
  }
}
