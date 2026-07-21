import Link from "next/link";
import { Fraunces, Manrope, JetBrains_Mono } from "next/font/google";
import EqIcon from "@/components/EqIcon";
import AuthButton from "@/components/AuthButton";
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
  title: "Earworm — guess the song",
  description:
    "A guess-the-song game. Hear one second, name the track. Play by artist, genre pack, custom list, or your own Spotify library.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
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
