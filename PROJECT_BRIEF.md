# BYoB (Bring Your Own Books) - Comprehensive Project Brief

This document provides complete architecture, context, constraints, and operational details for any AI agent or developer continuing work on this project.

---

## 1. Project Overview & Goals

- **Name**: BYoB (Bring Your Own Books), formerly referenced as Kuroyomi.
- **Purpose**: A minimalist, high-performance web novel and ebook reader inspired by platforms like WebNovel. Engineered for seamless mobile and desktop reading, with high-quality text-to-speech (TTS), offline progressive web app (PWA) support, continuous chapter reading, and cross-device synchronization.
- **Core Design Ethos**:
  - Clean monochrome aesthetic (pure black `#0a0a0a`, slate `#1c1c1c`, crisp white text).
  - Elegant typography (default Times New Roman, adjustable font sizes, line heights, letter spacing, and margins).
  - Strict zero-emoji policy across all UI elements, icons, logs, commit messages, and agent outputs.
  - No bloated frontend frameworks; written in vanilla HTML/CSS/JavaScript with zero build step.
  - Fast, responsive reading engine with silent scroll and paragraph-level progress saving.

---

## 2. Repository & Directory Structure

- **Physical Directory**: `/Users/rdoll/.gemini/antigravity/scratch/novel-reader`
- **Convenience Symlinks**:
  - `/Users/rdoll/Claude Projects/novel-reader` -> points to physical directory
  - `/Users/rdoll/novel-reader` -> points to physical directory
- **Git Remote**: `https://github.com/dollrockjean/kuroyomi.git` (branch: `main`)

### Key Files & Directories

- `server.py`: Multi-threaded Python HTTP server using standard library `http.server`. Handles routing, Edge-TTS streaming (`/api/tts/speak`), book ingestion (EPUB/PDF), user sessions, reading progress, and cloud sync endpoints.
- `database.py`: SQLite database layer operating in WAL mode (`PRAGMA journal_mode=WAL`). Contains schemas for `users`, `user_devices`, `user_settings`, `novels`, `volumes`, `chapters`, `reading_progress`, and `bookmarks`.
- `epub_parser.py`: Ingests EPUB files, extracts metadata, volume breakdown, chapter order, and cleans HTML content.
- `pdf_parser.py`: Ingests PDF documents and formats them into structured paragraphs and chapters.
- `sample_books.py`: Seeds demonstration novels for first-time or guest users.
- `start.sh`: Local server startup script with automatic port fallback (default port: `8000`).
- `app.py`: Hugging Face Spaces compatibility entrypoint wrapping the server via Gradio.
- `Dockerfile`, `render.yaml`, `railway.json`, `fly.toml`, `Procfile`: Cloud deployment configurations for zero-cost 24/7 hosting.
- `tests/`: Automated unit and integration test suite (`test_api_direct.py`, `test_ui_improvements.py`).
- `public/`:
  - `index.html`: Responsive mobile/desktop layout, master slide-out drawer, middle quick-sheet menu, full-screen audiobook modal, sleep timer modal, and library views.
  - `css/brutalist.css`: Monochrome theme definitions, layout rules, custom touch sliders, floating badge positioning, typography.
  - `sw.js`: Service worker handling offline asset caching and PWA functionality (current cache version: `byob-v39`).
  - `manifest.json`: Web app manifest configured for standalone PWA installation.
  - `js/app.js`: Application lifecycle controller, view switching (`library` vs `reader`), global settings application, quick sheet interaction, sync service coordination.
  - `js/reader.js`: Chapter rendering, continuous scroll tracking, visible paragraph detection, bionic reading formatting, overscroll chapter transitions, silent progress saving.
  - `js/tts.js`: Neural TTS audio player, Edge-TTS cloud audio fetcher, offline Web Speech API fallback, MediaSession API integration (lock screen / car Bluetooth), draggable mini-badge, full-screen player, synchronized word-by-word visual highlight, sleep timer.
  - `js/autoscroll.js`: Smooth pixel-by-pixel automatic scrolling with automatic menu pause/resume.
  - `js/storage.js`: Browser local storage manager with caching safeguards.
  - `js/sync.js`: Device token authentication, background setting synchronization, and cloud progress sync.

---

## 3. Technology Stack & Architecture

### Backend
- **Language**: Python 3 (standard library preferred, minimal external dependencies).
- **Concurrency**: `socketserver.ThreadingMixIn` with `threading.Semaphore(6)` for rate-limiting concurrent TTS requests.
- **Database**: SQLite3 with `PRAGMA synchronous=NORMAL`, `PRAGMA busy_timeout=5000`, and WAL mode.
- **Neural TTS**: `edge-tts` Python library for high-fidelity Microsoft Azure/Edge neural voice synthesis without external API keys. Synthesizes at base rate `+0%` with client-side playback rate scaling for instant zero-buffering speed adjustments.
- **Audio Caching**: SHA-256 hashed MP3 disk cache located in `tts_cache/` to eliminate duplicate synthesis requests.

### Frontend
- **Framework**: None (pure Vanilla JavaScript ES6+, HTML5, CSS3).
- **Styling**: Modern CSS variables, flexbox, CSS grid, touch-friendly hit targets, iOS safe-area insets.
- **Offline / PWA**: Service Worker with cache-first static asset strategy, network-first API strategy, and fast offline fallback.

---

## 4. Key Subsystems & How They Work

### 4.1 Text-to-Speech (TTS) Engine
- **Cloud Voices**: High-quality natural neural voices (e.g., `en-US-BrianNeural`, `en-US-AvaNeural`, `en-US-AndrewNeural`, `en-GB-RyanNeural`).
- **Text Normalization**:
  - Web novels often contain complex bracketed names, status screens, and evolution markers (e.g., `<<Herald>>`, `<Herald>`, `[Lich Lord] (15/15):: Abilities >> [Abhorred Lich Emperor](45/45)`).
  - `server.py` (`normalize_text_for_narration`) unescapes HTML entities (`&lt;&lt;Example&gt;&gt;` -> `<<Example>>`), unwraps bracketed words into plain speech tokens, converts arrows (`>>`) to verbal pauses ("evolving to"), formats level fractions (`15 of 15`), and strips stray angle brackets so Azure SSML never encounters raw XML tags.
  - `public/js/tts.js` (`normalizeForSpeech`) applies identical normalization on the client before passing text to the server or to device voice synthesis (`speakWithDeviceVoice`).
- **Single Audio Element Architecture**:
  - TTS strictly uses a single `HTMLAudioElement` (`this.audioElement`) to prevent dual audio streams from ever playing simultaneously.
  - iOS audio priming runs on the first user interaction (`touchstart` / `click`).
  - Pre-fetching: As paragraph `N` plays, paragraph `N+1` through `N+6` are pre-fetched into `blobCache` in the background for zero-latency gapless playback.
- **Speech Speed (Rate) Persistence**:
  - Rate is saved immediately to dedicated `localStorage` keys: `byob_tts_rate` and `kuroyomi_tts_rate`, in addition to `window.ReaderSettings.tts_rate` and cloud sync.
  - On app launch, `TTSEngine.init()` loads `byob_tts_rate` with top priority, preventing the speed slider (`#audiobookModalSpeedSlider`) from ever resetting to 0 or defaulting to 1.0 when reopening the app.
  - `syncRateUI()` updates `#audiobookModalSpeedSlider`, `#ttsRateSlider`, `#quickSheetSpeedSlider`, and their numerical text labels synchronously.
- **Sleep Timer**:
  - Supports minute countdown timers (5, 15, 30, 45, 60 minutes, +5m, +15m) and "End of Chapter" mode.
  - Displays remaining countdown on mini badges and within the full-screen modal.
- **Lock Screen & Bluetooth Car Controls**:
  - Integrates `navigator.mediaSession` with handlers for `play`, `pause`, `stop`, `nexttrack` (next paragraph), and `previoustrack` (previous paragraph).
  - Updates title, artist (novel title), and album cover art for car displays and mobile lock screens.

### 4.2 Reader & Progress Tracking
- **Silent Position Tracking**:
  - While reading, scroll position and visible paragraph index are detected dynamically via `getVisibleParagraphIndex()`.
  - Progress is debounced and saved automatically to `reading_progress` table and local storage.
  - Reader remembers exact paragraph index, scroll percentage, and global chapter index.
- **Continuous Reading & Overscroll Navigation**:
  - At the bottom of a chapter, scrolling past the end or releasing overscroll loads the next chapter seamlessly.
  - Pulling down past the top reloads the previous chapter positioned at the bottom.
- **Bionic Reading Mode**:
  - Emphasizes the initial characters of words to facilitate fast scanning.
  - Includes a prominence/fixation size slider accessible from the middle-screen quick sheet.

### 4.3 Device Synchronization & Safeguards
- **Device Sessions**: Each browser/device generates and stores a persistent `device_token` (`Storage.getDeviceToken()`) and registers with `/api/auth/register-device`.
- **Sync Protocol**: Settings, bookmarks, and reading progress are synced automatically when online.
- **Backup & Restore**:
  - Full database export available via `/api/backup/export` (downloads a single JSON payload).
  - Restoration via `/api/backup/restore` handles complete library and progress recovery in case of ephemeral cloud container teardowns.

---

## 5. Hosting & Deployment Environments

The repository contains preconfigured manifests for free, persistent, or serverless deployment:

1. **Render.com**:
   - Configured via `render.yaml` (Docker blueprint).
   - Healthcheck endpoint: `/health` or `/api/health`.
2. **Railway.app**:
   - Configured via `railway.json` and `Dockerfile`.
3. **Fly.io**:
   - Configured via `fly.toml` and `Dockerfile`.
   - Supports persistent volume mounting at `/data` via `READER_DB_PATH=/data/reader.db`.
4. **Hugging Face Spaces**:
   - Configured via `app.py` using Gradio SDK wrapper.
5. **Local Run**:
   ```bash
   cd /Users/rdoll/.gemini/antigravity/scratch/novel-reader
   ./start.sh
   # Access at http://localhost:8000
   ```

---

## 6. Strict Rules & Constraints

Any agent or contributor working on this codebase must adhere to the following rules:

1. **Strictly Zero Emojis**:
   - Never use emojis anywhere: not in code, HTML, CSS, JavaScript, UI copy, commit messages, unit tests, or user responses.
2. **macOS Developer Directory Prefix**:
   - When executing Python, Git, or build tools on this host system, always prefix commands with:
     ```bash
     DEVELOPER_DIR=/Library/Developer/CommandLineTools
     ```
   - Example: `DEVELOPER_DIR=/Library/Developer/CommandLineTools python3 -m unittest discover tests`
3. **PWA & Cache Busting Protocol**:
   - When modifying files in `public/` (such as `app.js`, `tts.js`, `reader.js`, `brutalist.css`), you MUST bump the cache version query string in both:
     - `public/sw.js` (e.g., `CACHE_NAME = 'byob-v40'`, asset query `?v=40.0`)
     - `public/index.html` (all script and link `?v=40.0` query parameters)
   - Failure to do this causes Safari and mobile PWAs to serve stale cached JavaScript.
4. **Testing Before Completion**:
   - Always run the full test suite before finishing any task:
     ```bash
     DEVELOPER_DIR=/Library/Developer/CommandLineTools python3 -m unittest discover tests
     ```
   - Ensure all tests pass without errors.
