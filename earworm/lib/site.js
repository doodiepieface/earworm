// Public site identity, shared by metadata, the sitemap, robots, and social
// cards. Set NEXT_PUBLIC_SITE_URL in your Vercel env to your real domain — the
// fallback is the current deployment, but a canonical URL matters for SEO, so
// update it the moment a custom domain is live.
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || "https://www.earwormgame.net"
).replace(/\/$/, "");

export const SITE_NAME = "Earworm";
export const SITE_TAGLINE = "The song guessing game";

// Buy Me a Coffee donation link. Defaults to this project's page; override with
// NEXT_PUBLIC_BUYMEACOFFEE (a username, @username, or full URL) to change it
// without editing code, or set it empty to hide the donation link entirely.
export const BUYMEACOFFEE_URL = (() => {
  const raw = process.env.NEXT_PUBLIC_BUYMEACOFFEE;
  const v = (raw === undefined ? "doodiepieface" : raw).trim();
  if (!v) return "";
  return v.startsWith("http")
    ? v
    : `https://www.buymeacoffee.com/${v.replace(/^@/, "")}`;
})();

// Apple Music affiliate (Services Performance Partners Program). Set
// NEXT_PUBLIC_APPLE_AFFILIATE_TOKEN to your `at` token once approved; the
// campaign token just labels traffic as coming from this game. With no token
// set, links stay as plain (still-valid) Apple Music links.
const APPLE_AFFILIATE_TOKEN = process.env.NEXT_PUBLIC_APPLE_AFFILIATE_TOKEN || "";
const APPLE_CAMPAIGN_TOKEN = process.env.NEXT_PUBLIC_APPLE_CAMPAIGN_TOKEN || "earworm";

// Tag an Apple Music URL with the affiliate token so clicks are credited to
// you. Appends to whatever query params the URL already has, and no-ops safely
// if there's no token or the URL is malformed.
export function withAppleAffiliate(url) {
  if (!url || !APPLE_AFFILIATE_TOKEN) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("at", APPLE_AFFILIATE_TOKEN);
    if (APPLE_CAMPAIGN_TOKEN) u.searchParams.set("ct", APPLE_CAMPAIGN_TOKEN);
    return u.toString();
  } catch {
    return url;
  }
}

export const SITE_DESCRIPTION =
  "Earworm is a free song guessing game — hear one second of a track and name it, " +
  "unlocking more with each miss. Play by artist, genre pack, a custom list, or your " +
  "own Spotify library.";

// Phrases real people actually type. The head term "song guessing game" is
// fiercely contested; the long-tail ones are where a new site can realistically
// rank, so lead with those.
export const SITE_KEYWORDS = [
  "song guessing game",
  "guess the song",
  "guess the song by artist",
  "music guessing game",
  "guess the song from one second",
  "heardle alternative",
  "guess the song from your Spotify",
  "name that tune game",
  "music quiz game",
];
