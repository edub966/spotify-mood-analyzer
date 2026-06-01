# Spotify Mood Analyzer

Analyzes your Spotify listening history and scores each track across 22 mood dimensions — energy, chaos, emotional depth, club drive, underground factor, and more — then maps the results to one of 25 mood profiles including Rave, Clouded, Bittersweet, Street Heat, and Ambient Drift.

Built with vanilla JavaScript, the Spotify Web API, and OAuth 2.0 PKCE authentication. No frameworks, no backend, no build step.

## Why you can't just visit a link

Spotify's Extended Quota Mode — which allows unlimited users — requires a legally registered business with 250k+ monthly active users as of May 2025. This app runs in Spotify's Development Mode, which caps access at 5 manually whitelisted accounts. The only way to use it without being on that list is to clone it and run it with your own Spotify developer app, which takes about 3 minutes.

## Setup

**1. Create a Spotify developer app**

- Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and log in
- Click **Create app**
- Set the redirect URI to `http://127.0.0.1:5500`
- Copy your **Client ID**

**2. Clone and configure**

```bash
git clone https://github.com/edub966/spotify-mood-analyzer.git
cd spotify-mood-analyzer
cp config.example.js config.js
```

Open `config.js` and replace `YOUR_CLIENT_ID_HERE` with your actual Client ID.

**3. Run it**

Open `index.html` with VS Code Live Server (right-click → Open with Live Server/Alt + L + O). Log in with your Spotify account and the analyzer will pull your listening history automatically.

## How the scoring works

The app pulls three data sources in parallel:

- **Recently played tracks** — up to 150 plays across 3 pages
- **Top tracks** — up to 200 tracks across short-term, medium-term, and long-term ranges
- **Top artists** — used to build a genre map for cross-referencing

Each track is scored across 22 dimensions built from available Spotify metadata:

| Signal | What it drives |
|---|---|
| Explicit flag | Intensity, chaos, rap grit |
| Duration | Focus, chaos, exploration |
| Album type and track position | Exploration, momentum, deep cut detection |
| Release date | Freshness, nostalgia |
| Top-track range presence | Replay strength, momentum |
| Recent play count | Replay strength, chaos |
| Time of day played | Darkness, chill, emotional depth |
| Day of week | Energy, momentum |
| Artist/track/album name matching | Style taxonomy (14 genre clusters) |

The style taxonomy matches against 14 clusters — hard club, classic dance, bass chaos, rap grit, cloud rap, pop spark, indie glow, mellow classic, R&B/soul, latin/afro, metal/punk, ambient/focus, sparse alternative, and emotional electronic — using artist name and track metadata pattern matching since Spotify's audio features and genre endpoints are restricted for new developer apps.

Dimension scores feed into 25 mood profiles. Each profile has a weighted formula. The highest-scoring profile wins, with a `Balanced` fallback when the top two profiles are within 5 points and neither exceeds 64.

## Mood profiles

Euphoric · Hyped · Rave · Club Heat · Bass Rush · Street Heat · Clouded · Chaotic · Dark · Melancholic · Focused · Ambient Drift · Dreamy · Velvet · Bittersweet · Golden Hour · Indie Glow · Nostalgic · Underground · Mainstream · Pop Pulse · Global Heat · Dance Classic · Fresh · Heavy · Deep Cut · Balanced

## Stack

- Vanilla JavaScript (ES2020)
- Spotify Web API
- OAuth 2.0 with PKCE — no backend required
- Session storage caching with 5-minute TTL
- Live Server for local development

## Notes

Audio features (`valence`, `energy`, `danceability`) and batch track endpoints are blocked for new Spotify developer apps as of 2024. This app derives all mood signals from metadata that is still accessible.
