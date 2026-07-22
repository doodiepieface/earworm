import { SITE_URL } from "@/lib/site";

// Generates /robots.txt. Everything is crawlable except the OAuth callback,
// which is a transient redirect page with no content worth indexing.
export default function robots() {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: "/callback",
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
