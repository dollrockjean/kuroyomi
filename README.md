# KuroYomi · Modern Web Novel Reader

A clean, minimalist web novel reader inspired by services like **WebNovel**. Built with an elegant **monochrome theme (black, grey, white)**, classic **Times New Roman** typography, subtle soft curves, smooth auto-hiding menus, natural human-like voice narration with a sleep timer, context-aware navigation, and cloud progress synchronization across devices.

---

## What's New & Refined

1. **Rebuilt Neural Audio (TTS)**:
   - **Zero Setup Required**: Does not rely on robotic local browser synthesizers or manual system downloads.
   - **Built-in Studio Neural Voices**: Generates real neural speech streams on the fly:
     - **Jenny** (`en-US-JennyNeural`): US Female · Natural & Expressive
     - **Guy** (`en-US-GuyNeural`): US Male · Warm & Narrative
     - **Aria** (`en-US-AriaNeural`): US Female · Smooth & Clear
     - **Christopher** (`en-US-ChristopherNeural`): US Male · Deep Storyteller
     - **Sonia** (`en-GB-SoniaNeural`): UK Female · Refined & Melodic
     - **Ryan** (`en-GB-RyanNeural`): UK Male · Classic Narrator
     - **Natasha** (`en-AU-NatashaNeural`): AU Female · Calm & Relaxed
   - **Blob-Based Streaming**: Plays via in-memory audio blobs for 100% compatibility on iOS Safari, macOS, Chrome, Firefox, Edge, and Android without media-range streaming stalls.
   - **Instant Pre-Fetching**: Pre-fetches the next paragraph while current one is playing for zero latency between sentences.
   - **Reads Where You Are**: Automatically detects the exact paragraph currently visible in your reading viewport and starts speaking from there.

2. **Context-Aware Master Side Panel**:
   - **Main Menu (Library Mode)**: Shows only application-wide options: Display/Themes, Cloud Sync, Backup/Restore safeguards, and Novel Ingestion. Hides book-specific chapter/reading controls.
   - **Book Menu (Reader Mode)**: Bound strictly to the **active novel**, showing that book's title, chapter info, Table of Contents, Read Aloud, and Auto-Scroll controls. Switching books immediately resets and rebinds all options to the new book.
   - **Center Screen Tap**: Tapping the center reading area on phones or tablets slides out the menu instantly.

3. **Silent Position Detection**:
   - No tapping required to save. As you scroll, the app silently detects your position and syncs it to local storage and your cloud profile.

4. **Monochrome Minimalism**:
   - Clean black (`#0a0a0a`), slate (`#1c1c1c`), and crisp white palette with 1px borders and gentle rounded corners.
   - Zero emojis across the entire UI.
   - Top header is clean with no distracting sync badges.

---

## Free 24/7 Cloud Hosting Guide & Safeguards

KuroYomi is engineered to run seamlessly on free cloud platforms without requiring you to keep your Mac turned on.

### Safeguards for Free Ephemeral Hosting
Most free cloud hosts (like Render free web services or Railway starter tiers) use ephemeral containers—meaning if the container sleeps or restarts, local files can be reset. We built in multiple safeguards to protect your data:

1. **One-Click Library Backup & Restore (JSON)**:
   - In the **Menu > Sync & Backup** tab, click **Export Backup (JSON)** to download a complete backup file containing all your novels, volumes, chapters, and exact reading positions.
   - If your free container ever restarts or you deploy to a new instance, click **Restore Backup** and select your file. Everything is restored in seconds.
2. **Environment Variable Database Path**:
   - Set `READER_DB_PATH=/data/reader.db` if you attach a persistent volume (e.g., Fly.io or Render paid disk).
3. **Automated Healthcheck Endpoint**:
   - `GET /health` and `GET /api/health` return HTTP 200 with service status so cloud load balancers and container orchestrators know the app is healthy.
4. **Threaded Concurrency & WAL Mode**:
   - Multi-threaded HTTP server with SQLite `WAL` mode and `busy_timeout = 5000` to handle simultaneous audio streaming, chapter fetching, and progress saves without locking.

---

### Option A: Deploy to Render.com (100% Free)

1. Fork or push this repository to your GitHub account.
2. Go to [Render.com](https://render.com) and sign in.
3. Click **New + > Blueprint**, connect your GitHub repo, and select `render.yaml`.
   - *Alternatively*, click **New + > Web Service**, select your repo, choose **Docker** environment, and set Health Check Path to `/health`.
4. Click **Deploy**. Render will build the Docker container and give you a free permanent HTTPS URL (e.g. `https://kuroyomi-reader.onrender.com`).
5. Open this URL on your iPhone Safari, tap **Share > Add to Home Screen**, and read anytime!

---

### Option B: Deploy to Railway.app

1. Install the Railway CLI: `npm i -g @railway/cli` (or use the web dashboard).
2. Run `railway login` then `railway init`.
3. Run `railway up`. Railway uses the included `railway.json` and `Dockerfile` to launch your service with a free domain.

---

### Option C: Deploy to Fly.io

1. Install Flyctl: `brew install flyctl`.
2. Run `fly launch` in this directory. Fly will detect the included `fly.toml` and `Dockerfile`.
3. Run `fly deploy`.

---

## Local Quick Start

```bash
cd /Users/rdoll/.gemini/antigravity/scratch/novel-reader
./start.sh
```

- Open `http://localhost:8000` on your Mac.
- Open `http://<your-mac-ip>:8000` on your iPhone/iPad connected to the same Wi-Fi.
