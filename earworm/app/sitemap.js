import { SITE_URL } from "@/lib/site";

// Generates /sitemap.xml. Only the real, content-bearing routes — /play needs a
// chosen pool and /callback is a redirect, so neither belongs here.
export default function sitemap() {
  const now = new Date();
  return [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/lists`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${SITE_URL}/spotify`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
  ];
}
