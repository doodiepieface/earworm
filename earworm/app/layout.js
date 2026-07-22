import Link from "next/link";
import { Fraunces, Manrope, JetBrains_Mono } from "next/font/google";
import EqIcon from "@/components/EqIcon";
import AuthButton from "@/components/AuthButton";
import {
  SITE_URL,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_DESCRIPTION,
  SITE_KEYWORDS,
} from "@/lib/site";
import "./globals.css";

// Fraunces is an elegant high-contrast serif — it carries the personality and
// the "premium" feel. Manrope stays clean and quiet underneath. JetBrains Mono
// handles counters, labels, and anything that should read like an instrument.
const display = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-display",
});

const body = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-mono",
});

export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — ${SITE_TAGLINE}`,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  applicationName: SITE_NAME,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
};

// Structured data helps Google understand the page is a free web game, which
// can earn a richer result listing.
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "VideoGame",
  name: SITE_NAME,
  alternateName: `${SITE_NAME} — ${SITE_TAGLINE}`,
  url: SITE_URL,
  description: SITE_DESCRIPTION,
  genre: ["Music", "Trivia", "Guessing game"],
  applicationCategory: "GameApplication",
  gamePlatform: "Web browser",
  operatingSystem: "Any",
  browserRequirements: "Requires JavaScript",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <header className="site-header">
          <Link href="/" className="wordmark">
            <EqIcon active size={18} />
            <span>Earworm</span>
          </Link>
          <nav className="site-nav">
            <Link href="/lists">My lists</Link>
            <Link href="/spotify">Spotify</Link>
            <AuthButton />
          </nav>
        </header>
        <main className="site-main">{children}</main>
        <footer className="site-footer">
          Previews stream from Apple&rsquo;s iTunes catalog · Not affiliated with
          Apple or Spotify
        </footer>
      </body>
    </html>
  );
}
