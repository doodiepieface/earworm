// Public site identity, shared by metadata, the sitemap, robots, and social
// cards. Set NEXT_PUBLIC_SITE_URL in your Vercel env to your real domain — the
// fallback is the current deployment, but a canonical URL matters for SEO, so
// update it the moment a custom domain is live.
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || "https://earworm-doodiepieface-studio.vercel.app"
).replace(/\/$/, "");

export const SITE_NAME = "Earworm";
export const SITE_TAGLINE = "The song guessing game";

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
