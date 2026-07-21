# Earworm 🎵

A Songless/Heardle-style game: hear one second of a song and try to name it. Each wrong guess or skip unlocks a longer snippet (1s → 2s → 4s → 7s → 11s → 16s, six guesses total).

You choose what you play from:

- **Genre packs** — curated sets that ship with the app (2010s Pop, Classic Rock, Hip-Hop/R&B, 80s Hits)
- **Artist mode** — type any artist, play their catalog
- **My lists** — hand-pick exact songs via search
- **Your Spotify** *(optional)* — log in and turn your playlists, liked songs, and top tracks into pools

## How the audio works (worth knowing)

Spotify removed preview audio from its API in late 2024, so **all audio comes from Apple's free iTunes Search API** — 30-second previews, no account needed. Spotify (if you connect it) supplies only *metadata*: track titles and artists, which the app then matches against iTunes to find a playable preview. Matching succeeds for roughly 85–95% of a typical library; misses are shown, not silently dropped.

The iTunes API blocks direct browser calls (no CORS), so requests go through a small server route at `app/api/itunes/route.js`, which also caches responses.

## Run it

Requires Node.js 18.18 or newer (get it at nodejs.org).

```bash
npm install
npm run dev
```

Then open **http://127.0.0.1:3000** — use `127.0.0.1`, not `localhost`, so Spotify login works later (Spotify only allows that exact address for local apps).

Everything except Spotify import works immediately, no configuration needed.

## Optional: enable Spotify import

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), log in, and click **Create app**. Name and description can be anything; check *Web API*.
2. In the app's **Settings**, add this exact Redirect URI and save:
   ```
   http://127.0.0.1:3000/callback
   ```
3. Copy the **Client ID**. In the project folder, copy `.env.local.example` to `.env.local` and paste it in:
   ```
   NEXT_PUBLIC_SPOTIFY_CLIENT_ID=paste_your_client_id_here
   ```
4. Restart `npm run dev`, open http://127.0.0.1:3000/spotify, and click **Connect Spotify**.

**Letting friends log in:** new Spotify apps run in *development mode* — only users you add under **Settings → User Management** (name + Spotify account email, up to ~25) can authenticate. Everything else in the game works for everyone regardless.

## Optional: enable accounts (save across devices)

By default your imports, lists, and stats live in this browser only. Turning on
accounts adds a **Sign in with Google** button that saves them to your account,
so they follow you to another browser or device. It's fully optional — signed
out, nothing changes. Uses [Supabase](https://supabase.com) (free tier) so
there's no password system to build or run.

1. **Create a Supabase project** at [supabase.com](https://supabase.com) (free).
   In **Project Settings → API**, copy the **Project URL** and the **anon public**
   key into `.env.local`:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_public_key
   ```
2. **Create the data table.** In Supabase, open **SQL Editor** and run:
   ```sql
   create table if not exists public.user_data (
     user_id uuid not null references auth.users on delete cascade,
     key text not null,
     value jsonb not null,
     updated_at timestamptz not null default now(),
     primary key (user_id, key)
   );
   alter table public.user_data enable row level security;
   create policy "own rows" on public.user_data
     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
   ```
   (Row-level security means each person can only ever read or write their own rows.)
3. **Turn on Google sign-in.** In Supabase: **Authentication → Providers → Google**,
   enable it. It shows a **Callback URL** like
   `https://YOUR-PROJECT.supabase.co/auth/v1/callback` — you'll need it in the next step.
4. **Create Google credentials.** At [console.cloud.google.com](https://console.cloud.google.com)
   → **APIs & Services → Credentials → Create OAuth client ID → Web application**.
   Under *Authorized redirect URIs* paste the Supabase Callback URL from step 3.
   Copy the **Client ID** and **Client secret** back into Supabase's Google provider
   settings and save.
5. **Allow your app's address.** In Supabase **Authentication → URL Configuration**,
   set **Site URL** to `http://127.0.0.1:3000` and add it under **Redirect URLs**.
   (Add your production URL here too once you deploy.)
6. Restart `npm run dev`, and a **Sign in** button appears in the header.

**Adding Apple later:** it's wired to be a one-line change — add `"apple"` to
`AUTH_PROVIDERS` in `lib/supabase.js` and enable the Apple provider in Supabase.
Note Apple sign-in needs a paid Apple Developer account and a public HTTPS
domain, and can't run on `localhost` — so you'll only be able to test it once
deployed.

## Deploying (optional)

The app deploys to [Vercel](https://vercel.com) as-is: import the repo, add the `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` environment variable, deploy. Then add your production callback (e.g. `https://your-app.vercel.app/callback`) as a second Redirect URI in the Spotify dashboard.

## Project tour

```
app/
  page.js               Home — pick a pool (packs, artist, lists, Spotify)
  play/page.js          The game screen
  lists/page.js         Custom list builder
  spotify/page.js       Connect + import your library
  callback/page.js      Spotify OAuth landing page
  api/itunes/route.js   Server proxy for the iTunes Search API
components/
  SnippetPlayer.jsx     Timed snippet playback + unlock ladder visualization
  GuessInput.jsx        Autocomplete guessing (must pick from the pool)
  GuessLadder.jsx       The six guess rows
  ResultCard.jsx        Reveal, streak, share-to-clipboard
components/
  AuthButton.jsx        Optional account control (Google sign-in)
lib/
  gameState.js          Ladder, share text, song picking
  itunes.js             Search, fuzzy matching, bulk preview resolution
  spotify.js            PKCE login + library fetching
  storage.js            Stats, lists, pools, caches (localStorage)
  supabase.js           Optional account layer (auth) — no-op if unconfigured
  sync.js               Mirrors imports/lists/stats to the signed-in account
data/
  packs.js              Curated genre packs — add your own!
```

## Tweaks you'll probably want to make

- **Add a pack:** edit `data/packs.js` — just titles and artists; previews resolve automatically on first play.
- **Change difficulty:** edit `LADDER` in `lib/gameState.js` (e.g. `[2, 4, 6, 9, 13, 18]` for easier).
- **Bigger Spotify imports:** the caps (200 liked songs, 300 per playlist) are in `app/spotify/page.js` — raise them if you don't mind longer import times (~3 songs/second).

## Known limitations

- A few songs have no iTunes preview (region gaps, some catalogs) — they're skipped with a note.
- Apple's terms require previews to be *streamed* (which this app does) and used to promote the catalog; keep that in mind if you publish beyond personal use.
- Without an account, stats and lists live in your browser's localStorage — clearing site data resets them. Sign in (if configured) to keep them across devices.
