// Spotify integration: Authorization Code with PKCE (the official flow for
// browser apps — no client secret involved) plus library fetching.
//
// Spotify's API no longer returns preview audio, so we only use it for
// METADATA (playlists, liked songs, top tracks). Audio comes from iTunes.

const CLIENT_ID = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID || "";
const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";
const SCOPES =
  "user-library-read playlist-read-private playlist-read-collaborative user-top-read";

const TOKEN_KEY = "earworm-spotify-tokens";
const VERIFIER_KEY = "earworm-spotify-verifier";
const STATE_KEY = "earworm-spotify-state";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function hasClientId() {
  return Boolean(CLIENT_ID);
}

function redirectUri() {
  // Must exactly match a Redirect URI registered in your Spotify dashboard.
  // Use http://127.0.0.1:3000/callback in development (Spotify does not
  // accept "localhost" for new apps) and your https URL in production.
  return `${window.location.origin}/callback`;
}

/* ---------------- PKCE plumbing ---------------- */

function randomString(length) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function sha256Base64Url(input) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/* ---------------- Token storage ---------------- */

function loadTokens() {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY));
  } catch {
    return null;
  }
}

function saveTokens(data, previous) {
  const tokens = {
    access_token: data.access_token,
    // A refresh response may omit refresh_token — keep the old one.
    refresh_token: data.refresh_token || previous?.refresh_token || null,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  return tokens;
}

export function isConnected() {
  return Boolean(loadTokens()?.access_token);
}

export function disconnect() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

/* ---------------- Login flow ---------------- */

export async function beginLogin() {
  if (!CLIENT_ID) throw new Error("Missing NEXT_PUBLIC_SPOTIFY_CLIENT_ID.");
  const verifier = randomString(64);
  localStorage.setItem(VERIFIER_KEY, verifier);
  // Random `state` binds this login to this browser session. Spotify echoes it
  // back on the callback; we reject the callback if it doesn't match, which
  // blocks CSRF / authorization-code injection.
  const state = randomString(32);
  localStorage.setItem(STATE_KEY, state);
  const challenge = await sha256Base64Url(verifier);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  window.location.href = `${AUTH_URL}?${params.toString()}`;
}

// Called on the /callback page with the ?code= and ?state= from Spotify.
export async function handleCallback(code, returnedState) {
  // Verify the state first — a mismatch means this callback wasn't started by
  // this browser, so refuse it (CSRF protection). Clear it either way so it
  // can't be replayed.
  const expectedState = localStorage.getItem(STATE_KEY);
  localStorage.removeItem(STATE_KEY);
  if (!expectedState || returnedState !== expectedState) {
    throw new Error("Login couldn't be verified — please try connecting again.");
  }

  const verifier = localStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error("Login session expired — try connecting again.");
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    // Surface Spotify's own reason — "invalid_grant", "redirect_uri_mismatch"
    // etc. tell you exactly what to fix in the dashboard.
    let detail = "";
    try {
      const err = await res.json();
      detail = err.error_description || err.error || "";
    } catch {}
    throw new Error(
      `Spotify rejected the login${detail ? ` (${detail})` : ""}. Check that your Redirect URI in the Spotify dashboard is exactly ${redirectUri()}`
    );
  }
  saveTokens(await res.json(), null);
  localStorage.removeItem(VERIFIER_KEY);
}

async function refreshAccessToken(tokens) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    disconnect();
    throw new Error("Spotify session expired — please connect again.");
  }
  return saveTokens(await res.json(), tokens);
}

async function getAccessToken() {
  let tokens = loadTokens();
  if (!tokens) throw new Error("Not connected to Spotify.");
  // Refresh 30s before expiry.
  if (Date.now() > tokens.expires_at - 30_000) {
    if (!tokens.refresh_token) {
      disconnect();
      throw new Error("Spotify session expired — please connect again.");
    }
    tokens = await refreshAccessToken(tokens);
  }
  return tokens.access_token;
}

/* ---------------- API calls ---------------- */

async function apiGet(pathOrUrl) {
  const token = await getAccessToken();
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get("Retry-After") || 1);
    await sleep((wait + 1) * 1000);
    return apiGet(pathOrUrl);
  }
  if (res.status === 401) {
    disconnect();
    throw new Error("Spotify session expired — please connect again.");
  }
  if (!res.ok) {
    // Pull Spotify's own explanation out of the body — a 403 in particular is
    // ambiguous without it (missing scope vs. restricted resource).
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message || "";
    } catch {}

    // 403 here almost always means the saved login predates the playlist
    // scopes. Reading playlist contents needs playlist-read-private, even
    // though listing playlist names does not — so a stale token shows every
    // playlist but can't open any of them. Reconnecting re-grants the scope.
    if (res.status === 403) {
      throw new Error(
        `Spotify won't let this login read playlist contents${
          detail ? ` (${detail})` : ""
        }. Disconnect and reconnect to grant playlist access, then try again.`
      );
    }
    throw new Error(`Spotify error ${res.status}${detail ? `: ${detail}` : ""}.`);
  }
  return res.json();
}

// Follow `next` links until done or we hit `cap` items.
async function fetchAllPages(firstUrl, cap = Infinity) {
  const items = [];
  let url = firstUrl;
  while (url && items.length < cap) {
    const page = await apiGet(url);
    items.push(...(page.items || []));
    url = page.next;
  }
  return items.slice(0, cap);
}

function trackToEntry(track) {
  if (!track || !track.id || track.type === "episode") return null;
  return {
    id: `sp-${track.id}`,
    title: track.name,
    artist: (track.artists || []).map((a) => a.name).join(", ") || "Unknown",
  };
}

export async function getProfile() {
  return apiGet("/me");
}

export async function getPlaylists() {
  const items = await fetchAllPages("/me/playlists?limit=50", 200);
  return items
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      name: p.name,
      // Spotify now omits tracks.total from the playlist list for dev-mode
      // apps, so this is usually unknown — null, not a misleading 0.
      count: p.tracks?.total ?? null,
      imageUrl: p.images?.[0]?.url || "",
    }));
}

export async function getPlaylistTracks(playlistId, cap = 300) {
  // Spotify blocks the dedicated /playlists/{id}/tracks endpoint for
  // development-mode apps (a bare 403 "Forbidden"), but the Get Playlist
  // endpoint /playlists/{id} still works and embeds the first page of tracks.
  // So we read from there. `fields` trims the payload to just what we need.
  //
  // Deliberately no `market` param: passing one makes Spotify relink tracks to
  // a region and null out anything unavailable there, which emptied the whole
  // import. We match titles against iTunes anyway, so regional playback
  // availability is irrelevant — we want every track's title + artist.
  const fields = "tracks.next,tracks.items(track(id,name,type,artists(name)))";
  const data = await apiGet(
    `/playlists/${playlistId}?fields=${encodeURIComponent(fields)}`
  );

  let items = data.tracks?.items || [];
  let next = data.tracks?.next || null;

  // The `next` link points back at the blocked /tracks endpoint, so following
  // it usually 403s. Try anyway in case the account has fuller access, but
  // stop quietly at the first refusal instead of failing the whole import —
  // the embedded first page (up to 100 songs) is already plenty for a pool.
  while (next && items.length < cap) {
    try {
      const page = await apiGet(next);
      items.push(...(page.items || []));
      next = page.next;
    } catch {
      break;
    }
  }

  return items
    .slice(0, cap)
    .map((i) => trackToEntry(i.track))
    .filter(Boolean);
}

export async function getLikedSongs(cap = 200) {
  const items = await fetchAllPages("/me/tracks?limit=50", cap);
  return items.map((i) => trackToEntry(i.track)).filter(Boolean);
}

export async function getTopTracks() {
  const data = await apiGet("/me/top/tracks?limit=50&time_range=medium_term");
  return (data.items || []).map(trackToEntry).filter(Boolean);
}
