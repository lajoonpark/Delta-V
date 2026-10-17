# Delta-V

<div align="center">

**Repo terminal launcher for coding agents**

[![Electron](https://img.shields.io/badge/Electron-33-2B2E3A?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-3-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## Overview

**Delta-V** is a cross-platform desktop application (macOS, Windows, Linux) that lets developers manage and launch terminal-based coding agents directly into their repositories.

Point Delta-V at folders containing your projects, and it displays each immediate subfolder as a launchable tile. Click a tile, pick an agent (Kilo, OpenCode, Claude Code, Aider, or your own custom commands), and a live terminal opens already `cd`'d into that repo — ready to code.

---

## Features

### 🏗️ Repository Management
- **Root folders** — Add one or more parent directories; Delta-V scans their immediate children as repos
- **Smart scanning** — Chunked, debounced, cancellable scans handle 10k+ folders without blocking the UI
- **Flexible sorting** — Recently opened (default), alphabetical, or manual order
- **Live progress** — Real-time scan progress badges on each root folder

### 🤖 Built-in Agents
| Agent | Command | Description |
|-------|---------|-------------|
| **Kilo CLI** | `kilo` | Kilo coding agent |
| **OpenCode** | `opencode` | OpenCode agent |
| **Pi Coding Agent** | `pi` | Pi agent |
| **Claude Code** | `claude` | Anthropic's Claude Code |
| **Aider** | `aider` | Aider AI pair programmer |
| **Cursor Agent** | `cursor-agent` | Cursor's agent mode |

> All built-in agents run via shell (`useShell: true`) so aliases and PATH resolution work out of the box.

### ⚙️ Custom Agents
Define your own agents with full control:
- **Command + arguments** — Any executable in your PATH
- **Environment variables** — Per-agent env overrides
- **Shell vs direct exec** — Toggle `useShell` for aliases/functions or direct spawn
- **Working directory override** — Rarely needed, but available
- **CRUD UI** — Add, edit, disable, delete in Settings → Agents

### 🖥️ Terminal Experience
- **xterm.js** — Full-featured terminal with 10k line scrollback
- **Web links addon** — Clickable URLs, file paths, and stack traces
- **Fit addon** — Automatic resize on window/tab changes
- **OSC title detection** — Terminal title updates from agent output (e.g., `kilo @ deltav`)
- **Graceful shutdown** — SIGTERM → 1s grace → SIGKILL on close/quit

### 📱 Delta-V Remote (mobile mirror)
- **Read-only live mirror** — Watch active agent sessions from a phone browser on the same Wi-Fi. iOS Safari is the primary target; Android Chrome is also supported. No cloud, relay, accounts, or push notifications.
- **Pair once via QR** — The pairing token travels in the URL fragment (`http://<LAN-IP>:<port>/#<token>`) and is stored in `localStorage`; the hash disappears from the address bar after pairing.
- **Session list + exact desktop grid** — A read-only xterm.js view at the session's real cols×rows. The font auto-fits the screen (or pick 4–20 px), but the grid never changes, so wrapping matches the desktop exactly.
- **Follow / jump to latest** — A "Following" indicator while pinned to the bottom; scroll back and a "Jump to latest" button appears.
- **Watch mode** — Keep the phone awake from the session header: native Wake Lock API where available, otherwise the nosleep.js video fallback (the LAN origin is plain HTTP, so it is not a secure context).
- **Installable PWA** — Add to Home Screen from Safari/Chrome for a standalone, safe-area-aware layout.
- **Automatic reconnect + resync** — Visibility-driven reconnects (500 ms → 1 s → 2 s → 5 s backoff cap), a transient "Reconnecting…" pill, and an honest "Can't reach Delta-V — retrying" screen with a Retry button.
- **Bounded history** — A 256 KB per-session ring buffer (262,144 UTF-16 code units); exited sessions stay listed for 5 minutes with their exit code.
- **Strictly read-only** — The phone cannot type, spawn, kill, or change settings; it only receives PTY output and session metadata.
- **Off by default** — Enable it in Settings → Remote; it listens only while Delta-V is running.

### 🪟 Window Modes
| Mode | Behavior |
|------|----------|
| **Tabs** | Single window, collapsible sidebar + tabbed terminals |
| **Windows** | Each session opens in a new native window (macOS native tab groups) |
| **Both** *(default)* | Choose per launch: click for tab, <kbd>⌘</kbd>+click (macOS) / <kbd>Ctrl</kbd>+click (Win/Linux) for window |

### 🔍 Local Repo Indexing (LanceDB)
- **Offline full-text search** — Tantivy/BM25 indexes per repo, stored in `<userData>/repo-index.lance`
- **Auto-index on open** — Background indexing when you launch an agent in a repo
- **Manual reindex** — Force refresh from Settings → Advanced or repo tile context
- **Search API** — Programmatic search for agents/tools (IPC: `index:search`)
- **Zero network** — Runs entirely locally, no telemetry, no external calls

### 🎨 Appearance & UX
- **Themes** — System / Light / Dark with instant switching
- **Terminal font** — Size slider (8–24px), presets (Menlo, System mono, custom)
- **Keyboard shortcuts** — <kbd>⌘,</kbd> Settings, <kbd>⌘W</kbd> Close tab, <kbd>⌘B</kbd> Toggle sidebar, <kbd>⌘K</kbd> Search repos
- **Responsive grid** — Auto columns from 1 (mobile) to 5+ (ultrawide)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron App                             │
├──────────────────────┬──────────────────────┬───────────────────┤
│    Main Process      │    Preload Bridge    │   Renderer (React)│
│  (Node.js + Electron)│  (contextBridge)     │   (Vite + TSX)    │
├──────────────────────┼──────────────────────┼───────────────────┤
│ • windowManager      │ • settings:get/set   │ • AppProvider     │
│ • scannerService     │ • folders:add/remove │ • MainWindow      │
│ • agentService       │ • agents:list/add/.. │ • TerminalWindow  │
│ • ptyManager         │ • terminal:spawn/..  │ • Components:     │
│ • repoIndexService   │ • window:create/..   │   - RepoGrid      │
│ • settingsService    │ • index:search/..    │   - AgentPicker   │
│ • ipcMain handlers   │ • on: terminal:data  │   - TerminalPane  │
│ • remoteBridge       │   terminal:exit      │   - SettingsDialog│
└──────────────────────┴──────────────────────┴───────────────────┘
```

### Delta-V Remote data flow

The bridge is a second, in-process subscriber to the same PTY stream. Both fan-out paths are one-way: the bridge reads from `PtyManager.publish` and never writes back to a PTY.

```
node-pty
  └─ PtyManager.publish
       ├─ renderer windows (Electron IPC: terminal:data / exit / title / status)
       └─ RemoteBridge (per-session ring buffers)
            └─ RemoteServer (HTTP + WebSocket)
                 └─ phone browser (read-only mirror)
```

### Key Technologies
| Layer | Stack |
|-------|-------|
| **Framework** | Electron 33 |
| **Frontend** | React 18 + TypeScript |
| **Build** | Vite 5 + electron-vite |
| **Terminal** | xterm.js 6 + @xterm/addon-fit + @xterm/addon-web-links + node-pty |
| **Remote** | Node.js `http` + `ws`, `qrcode`, `nosleep.js` |
| **Styling** | Tailwind CSS 3 |
| **State** | React Context + useReducer |
| **Settings** | electron-store (JSON in userData) |
| **Search Index** | LanceDB (embedded, Tantivy FTS) |
| **Packaging** | electron-builder (DMG, NSIS, AppImage) |

---

## Quick Start

### Prerequisites
- **Node.js 22 LTS** (recommended via [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm))
- **npm** (bundled with Node) or **pnpm**
- **Python 3 + build tools** (for `node-pty` native compilation)
  - macOS: `xcode-select --install`
  - Windows: `npm install -g windows-build-tools` (admin PowerShell)
  - Linux: `build-essential` / `python3` / `libtool` / `pkg-config`

### Development
```bash
# Clone and install
git clone https://github.com/your-org/deltav.git
cd deltav
npm install

# Start dev servers (Vite + Electron)
npm run dev
```

### Type Checking
```bash
npm run typecheck        # both main + renderer
npm run typecheck:node   # main process only
npm run typecheck:web    # renderer only
```

### Production Build
```bash
# Build renderer + main bundles
npm run build

# Package for current platform
npm run dist:mac    # macOS DMG (arm64)
npm run dist:win    # Windows NSIS
npm run dist:linux  # Linux AppImage

# Or all platforms (requires CI/multi-arch runners)
npm run dist
```

---

## Project Structure

```
deltav/
├── .github/                    # CI workflows (if any)
├── build/                      # electron-builder assets (icons, etc.)
├── dist/                       # Packaged outputs (gitignored)
├── out/                        # Compiled main/preload (gitignored)
├── src/
│   ├── main/                   # Main process (Node + Electron APIs)
│   │   ├── index.ts            # App entry, lifecycle, single-instance lock
│   │   ├── windows.ts          # BrowserWindow lifecycle & multi-window mgmt
│   │   ├── ipc.ts              # IPC handler registration (all channels)
│   │   ├── settings.ts         # electron-store persistence + defaults
│   │   ├── scanner.ts          # Folder scanning (debounced, chunked, progress)
│   │   ├── agents.ts           # Built-in + custom agent registry
│   │   ├── pty.ts              # node-pty session manager (spawn/kill/resize)
│   │   ├── repoIndex.ts        # LanceDB indexing + search service
│   │   ├── remoteBridge.ts     # Remote bridge: rings, status, QR, settings wiring
│   │   └── remote/             # Read-only Remote HTTP + WebSocket server
│   │       ├── ring.ts         # Per-session output ring + terminal mode tracker
│   │       ├── net.ts          # LAN address discovery + constant-time auth
│   │       └── server.ts       # HTTP static/API + WebSocket fan-out
│   ├── preload/                # Secure preload script (contextBridge)
│   │   └── index.ts            # IPC channel allowlist + type-safe API
│   ├── shared/                 # Types shared between main & renderer
│   │   ├── types.ts            # All interfaces (settings, agents, tiles, IPC)
│   │   ├── ipc.ts              # IPC channel name constants
│   │   └── api.ts              # Type-safe preload API shape
│   └── renderer/               # React frontend (Vite + TSX)
│       ├── index.html          # Desktop entry HTML
│       ├── remote.html         # Phone mirror entry HTML
│       ├── public/             # PWA assets for the phone mirror
│       │   ├── manifest.webmanifest
│       │   └── remote-icons/   # 192/512 + apple-touch icons
│       ├── src/
│       │   ├── main.tsx        # React root
│       │   ├── App.tsx         # Window kind router (main vs terminal)
│       │   ├── windows/
│       │   │   ├── MainWindow.tsx      # Repo grid + sidebar + tabs
│       │   │   ├── TerminalPane.tsx    # xterm.js wrapper per session
│       │   │   └── TerminalWindow.tsx  # Standalone terminal window
│       │   ├── components/
│       │   │   ├── RepoGrid.tsx        # Filterable, sortable tile grid
│       │   │   ├── RepoTile.tsx        # Individual repo card
│       │   │   ├── AgentPicker.tsx     # Modal agent selector
│       │   │   ├── TabBar.tsx          # Session tabs
│       │   │   ├── Sidebar.tsx         # Collapsible repo list
│       │   │   ├── TitleBar.tsx        # Custom title bar (macOS traffic lights)
│       │   │   ├── SettingsDialog.tsx  # 5-tab settings modal
│       │   │   ├── Terminal.tsx        # xterm.js component
│       │   │   └── ui.tsx              # Primitive UI components
│       │   ├── state/
│       │   │   └── AppProvider.tsx     # Global state + actions (Context)
│       │   ├── hooks/
│       │   │   └── useTheme.ts         # Theme resolution + sync
│       │   ├── styles/
│       │   │   └── index.css           # Tailwind imports + globals
│       │   └── remote/                 # Read-only phone client (served at /)
│       │       ├── main.tsx            # React root for remote.html
│       │       ├── RemoteApp.tsx       # Pairing / session-list / session-view router
│       │       ├── PairingScreen.tsx   # QR instructions + paste-the-link fallback
│       │       ├── SessionList.tsx     # Session cards + status chips
│       │       ├── SessionView.tsx     # Header, exit banner, font + watch toggles
│       │       ├── RemoteTerminal.tsx  # Read-only xterm.js mirror + touch scrollback
│       │       ├── ConnectionStatus.tsx # Connecting splash, pill, unreachable overlay
│       │       ├── connection.ts       # WS transport, resync, reconnect engine
│       │       ├── viewerSync.ts       # Offset-based duplicate/gap detection
│       │       ├── env.ts              # Browser env adapter + timing constants
│       │       ├── pairing.ts          # Token extraction + localStorage key
│       │       ├── format.ts           # Repo name / relative time / exit labels
│       │       ├── useRemoteState.ts   # useSyncExternalStore wrapper
│       │       ├── useWakeLock.ts      # Native Wake Lock + nosleep.js fallback
│       │       └── remote.css          # Tailwind entry + mobile terminal fixes
├── tools/                      # Standalone Node check scripts (esbuild + node)
│   ├── camera-dolly-check.ts   # Camera dolly projection/solve checks
│   ├── remote-bridge-check.ts  # Ring/net/server integration checks
│   ├── remote-client-check.ts  # Connection-engine simulation checks
│   └── remote-client-pure-check.ts # Pure client-module checks
├── electron.vite.config.ts     # Vite config for main/preload/renderer
├── tsconfig.json               # Project references
├── tsconfig.node.json          # Main/preload TS config
├── tsconfig.web.json           # Renderer TS config
├── tailwind.config.js          # Tailwind theme + content paths
├── postcss.config.js           # PostCSS plugins
├── electron-builder.yml        # Packaging config
├── package.json
└── README.md
```

---

## Configuration

### Settings File
Persisted to `electron-store` at:
- **macOS**: `~/Library/Application Support/Delta-V/deltav-settings.json`
- **Windows**: `%APPDATA%/Delta-V/deltav-settings.json`
- **Linux**: `~/.config/Delta-V/deltav-settings.json`

```json
{
  "rootFolders": ["/Users/you/code", "/Users/you/work"],
  "customAgents": [
    {
      "id": "uuid",
      "name": "My Linter",
      "command": "eslint",
      "args": ["--fix"],
      "env": {},
      "useShell": true,
      "workingDirOverride": ""
    }
  ],
  "sortOrder": "recent",
  "windowMode": "both",
  "theme": "system",
  "terminalFontSize": 13,
  "terminalFontFamily": "Menlo, Consolas, monospace",
  "disabledBuiltinAgents": ["cursor"],
  "repoIndexEnabled": true,
  "remoteEnabled": false,
  "remotePort": 4137
}
```

> `remoteToken` (a UUID pairing secret) is also persisted in this file, but it is never sent to the renderer UI except inside pairing URLs/QR codes. Change it only via Settings → Remote → Regenerate token.

### Repo Indexes
LanceDB database at:
- **macOS**: `~/Library/Application Support/Delta-V/repo-index.lance/`
- **Windows**: `%APPDATA%/Delta-V/repo-index.lance/`
- **Linux**: `~/.config/Delta-V/repo-index.lance/`

Each repo gets a table `repo_<tileId>` with columns: `path`, `startLine`, `endLine`, `lang`, `content`.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| <kbd>⌘,</kbd> / <kbd>Ctrl+,</kbd> | Open Settings |
| <kbd>⌘W</kbd> / <kbd>Ctrl+W</kbd> | Close active terminal tab |
| <kbd>⌘B</kbd> / <kbd>Ctrl+B</kbd> | Toggle sidebar (when sessions exist) |
| <kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd> | Search repos in the solar-system view (fuzzy; Enter launches the top match) |
| <kbd>⌘</kbd>+Click agent | Open in new window (Both mode) |
| <kbd>Ctrl/Cmd+Click</kbd> link | Open URL/file in system browser/editor |

---

## IPC Channel Reference

### Main → Renderer (invoke)
| Channel | Payload | Returns |
|---------|---------|---------|
| `settings:get` | — | `AppSettings` |
| `settings:set` | `Partial<AppSettings>` | `{ ok, data?, error? }` |
| `settings:reset` | — | `{ ok, data?, error? }` |
| `folders:add` | — | `RootFolder[]` |
| `folders:remove` | `rootFolderId: string` | `{ ok, error? }` |
| `folders:scan` | `rootFolderId?: string` | `{ ok, error? }` |
| `roots:list` | — | `RootFolder[]` |
| `agents:list` | — | `AgentDefinition[]` |
| `agents:add` | `NewAgentPayload` | `{ ok, data?: AgentDefinition, error? }` |
| `agents:update` | `AgentDefinition` | `{ ok, error? }` |
| `agents:delete` | `agentId: string` | `{ ok, error? }` |
| `agents:toggleBuiltin` | `agentId, disabled: boolean` | `{ ok, error? }` |
| `tiles:list` | — | `RepoTile[]` |
| `terminal:list` | — | `TerminalSessionInfo[]` |
| `terminal:spawn` | `SpawnRequest` | `{ ok, data?: SpawnResult, error? }` |
| `terminal:resize` | `sessionId, cols, rows` | `{ ok, error? }` |
| `terminal:kill` | `sessionId` | `{ ok, error? }` |
| `window:create` | `kind?: 'main' \| 'terminal'` | `{ ok, data?: windowId, error? }` |
| `window:close` | `windowId` | `{ ok, error? }` |
| `index:status` | `repoTileId?` | `RepoIndexStatus[]` |
| `index:reindex` | `repoTileId` | `{ ok, error? }` |
| `index:search` | `RepoSearchRequest` | `RepoSearchResponse` |
| `index:remove` | `repoTileId` | `{ ok, error? }` |
| `remote:status` | — | `{ ok, data?: RemoteStatus, error? }` |
| `remote:configure` | `{ enabled?, port? }` | `{ ok, data?: RemoteStatus, error? }` |
| `remote:regenerateToken` | — | `{ ok, data?: RemoteStatus, error? }` |

> `settings:set` cannot change remote settings (`remoteEnabled`, `remotePort`, `remoteToken` are excluded from `SETTING_KEYS`); use the `remote:*` channels.

### Renderer → Main (on)
| Channel | Payload |
|---------|---------|
| `terminal:data` | `{ sessionId, data }` |
| `terminal:exit` | `TerminalExitEvent` |
| `terminal:title` | `TerminalTitleEvent` |
| `folder:scanProgress` | `ScanProgress` |
| `folder:scanComplete` | `ScanResult` |
| `index:progress` | `RepoIndexProgress` |
| `index:complete` | `RepoIndexCompleteEvent` |
| `grid:invalidate` | `{ reason }` |
| `window:toggleSidebar` | — |
| `remote:statusChanged` | `RemoteStatus` |

---

## Delta-V Remote — HTTP & WebSocket API

Delta-V Remote is a LAN-only HTTP + WebSocket server (`src/main/remote/server.ts`) driven by an Electron-integrated bridge (`src/main/remoteBridge.ts`). It mirrors PTY output and never accepts terminal input.

### Pairing URL

```
http://<LAN-IP>:<port>/#<token>
```

- `<LAN-IP>` comes from `os.networkInterfaces()`: non-internal IPv4 addresses, private RFC1918 ranges first, then interface rank (`en*` / `eth*` / `wl*` before tunnels, Docker and bridges). Link-local `169.254.*` addresses are skipped.
- The token is a UUID in the URL **fragment**. Browsers never send the fragment in an HTTP request or WebSocket URL, so it appears in no path or query string. The client stores it in `localStorage` under `deltav.remote.token` and removes the hash with `history.replaceState`.
- Settings → Remote shows an SVG QR code (generated by `qrcode`) plus a copyable URL for the selected LAN interface (a selector appears when several are available).

### Authentication

| Transport | Credential |
|-----------|------------|
| HTTP | `Authorization: Bearer <token>` |
| WebSocket | subprotocols `deltav.v1` + `auth.<token>` (browser `WebSocket` cannot set headers; the server requires `deltav.v1` and parses the token from the second subprotocol) |

- Tokens are compared in constant time: both sides are SHA-256 hashed and compared with `crypto.timingSafeEqual`; empty tokens never match.
- Every unauthenticated `/api/*` request returns the same `401 {"error":"unauthorized"}` (the method is checked only after authentication).
- Defence in depth: connections are accepted only from loopback, RFC1918 private, link-local, CGNAT (`100.64/10`) and IPv6 loopback/ULA/link-local addresses; anything else has its socket destroyed before a response.

### Endpoints

| Endpoint | Auth | Response |
|----------|------|----------|
| `GET /` | none | `remote.html` PWA shell. It contains no session data, which is why serving it unauthenticated is safe: the token lives in the URL fragment, and browsers never send the fragment to the server. |
| `GET /remote.html`, `GET /manifest.webmanifest`, `GET /remote-icons/<file>`, `GET /assets/<file>` | none | Static allowlist from `out/renderer`; path traversal is rejected. `HEAD` is also allowed. |
| `GET /api/sessions` | Bearer | `RemoteSessionInfo[]` (newest first), including agent display name, cols×rows, status and exit info. |
| `GET /api/sessions/:id/buffer` | Bearer | `RemoteBufferSnapshot`, or 404 when the session was purged. |
| `GET /ws` (WebSocket upgrade) | `deltav.v1` + `auth.<token>` | Upgrade for live events. |

All other methods on `/api/*` and known static routes return 405 (with an `Allow` header); unknown paths return 404. Production HTML responses carry a CSP (`default-src 'self'`, no framing, `connect-src 'self' ws: wss:`), plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and `Cross-Origin-Resource-Policy: same-origin`.

**`RemoteBufferSnapshot` fields:**

| Field | Type | Meaning |
|-------|------|---------|
| `data` | `string` | Raw PTY output (ANSI included) to replay into a freshly reset terminal. |
| `end` | `number` | Output offset just past the last retained code unit. Live chunks with `offset + data.length <= end` are already included. |
| `truncated` | `boolean` | True once older output fell out of the ring; `data` then starts with a mode-restoring prefix. |
| `cols` / `rows` | `number` | Desktop grid size the viewer must resize to. |
| `exit` | `RemoteExitInfo?` | Exit code/signal/time once the session ended. |

### WebSocket messages

Server → client:

| Channel | Payload |
|---------|---------|
| `terminal:data` | `{ sessionId, data, offset }` (`RemoteDataEvent`) |
| `terminal:exit` | `TerminalExitEvent` |
| `terminal:title` | `TerminalTitleEvent` |
| `terminal:status` | `TerminalStatusEvent` |
| `remote:session` | `RemoteSessionInfo` — session added/updated (including desktop resizes) |
| `remote:gone` | `{ sessionId }` — purged after the 5-minute exit retention |
| `remote:heartbeat` | `{ t }` — every 5 s |
| `remote:pong` | `{ t }` — reply to a client ping |

Client → server: the only accepted message is `{"type":"ping","t":<number>}`. Everything else is ignored, and 20 invalid messages on one socket terminate it.

### Offsets and resync

Each output chunk is stamped with `offset`, the number of UTF-16 code units emitted for that session before the chunk. A buffer snapshot reports `end`, the total emitted so far. The viewer keeps the next expected offset and reconciles live chunks as follows:

| Situation | Action |
|-----------|--------|
| `offset + data.length <= end` | Skip — the chunk is already inside the snapshot (no duplicates). |
| `offset === end` | Append the whole chunk. |
| `offset < end < offset + data.length` | Append only the unseen tail (overlapping resync). |
| `offset > end` | Gap detected — refetch the buffer and replay it (no missing lines). |

Ring buffer semantics:

- **256 K UTF-16 code units per session** (`RING_CAP = 256 * 1024`). Chunks are dropped whole from the oldest end; a single oversized chunk keeps its last 256 K units.
- Once anything was dropped, `truncated` is true and the snapshot is prefixed with `\x1b[0m` plus mode-restoring sequences for the terminal modes currently in effect (tracked from output seen so far): alt screen (`1049`/`1047`/`47`), hidden cursor (`25`) and autowrap (`7`).
- Buffers are recorded in memory from app start even when Remote is off, so enabling it mid-session still has history. Exited sessions are retained for 5 minutes, then a `remote:gone` event removes them.

### Read-only invariant

The bridge only calls `ptyManager.list()` and subscribes to the `broadcast` and `resized` events. It never spawns, kills, writes to, or resizes a PTY, and it exposes nothing about settings, the repo index, or agent environment — agent display names are copied as strings only. The single client → server message is the liveness ping.

### Development vs production serving

- **Production** serves `out/renderer` (`path.join(__dirname, '../renderer')`).
- **`npm run dev`** proxies page assets from the Vite dev server (`ELECTRON_RENDERER_URL`); `/` and `/remote.html` both map to `/remote.html`. Vite HMR does not reach the phone — reload the page manually.

### Client reconnect behaviour

- Hidden for **≥ 3 s** → on return, force a fresh WebSocket and a full resync (session list + viewed buffer).
- Hidden for **< 3 s** → send a ping; if no pong arrives within **1 s**, force a reconnect.
- A visible live socket uses a **15 s** heartbeat watchdog (any message counts); silence forces a reconnect.
- Failed attempts back off **500 ms → 1 s → 2 s → 5 s cap**. After **6** consecutive failures the app shows the full "Can't reach Delta-V — retrying" overlay and keeps retrying every 5 s until success or Retry.

### Known limitations

- The LAN origin is **plain HTTP**, so it is not a secure context: native Wake Lock and service workers are unavailable on the phone. Watch mode therefore uses the nosleep.js video fallback, which is browser-version dependent — verify it on the target iOS version.
- iOS Home-Screen apps keep **separate storage**, so the pairing screen may reappear; paste the pairing link into the field to recover.
- Replay after ring truncation is **best-effort for full-screen TUIs**: the mode prefix restores common terminal modes, but there is no full terminal-state snapshot.
- macOS may prompt to allow incoming connections the first time Remote is enabled.

### Manual validation (two devices)

1. `npm run dev` on the Mac → Settings → Remote → enable; accept the firewall prompt; status shows "Listening", and the QR URL uses a LAN IP, not localhost.
2. Launch two agents.
3. iPhone camera → open the link in Safari: both sessions appear within ~1 s, the hash is removed from the address bar, and reload stays paired.
4. Negative: open `http://<ip>:<port>/` in a private tab → pairing screen. `curl http://<ip>:<port>/api/sessions` → 401; with the Bearer header → JSON.
5. Open a session: live output, wrapping identical to desktop (same cols×rows), tapping the terminal shows no keyboard, finger scroll-back works, and "Jump to latest" appears/disappears.
6. Resize the desktop window → the phone grid adopts the new cols×rows.
7. Launch a third agent → its card appears live.
8. Exit an agent → "exited (exit code N)" banner; dismiss it, and it stays dismissed after step 9. The exited session disappears from the list after ~5 min.
9. Background & return: with output streaming, leave Safari for ≥ 60 s (and separately ~5 s) → on return it is live and caught up in < 1 s, with no duplicated or missing lines.
10. Watch mode: set Auto-Lock to 30 s, enable the eye toggle, and prop the phone up for > 30 s → the screen stays on (note which method the tooltip reports). Background/return keeps the toggle on.
11. Unreachable: sleep the Mac / turn off its Wi-Fi / disable Remote → the phone shows the "Reconnecting…" pill, then after ~20 s the full "Can't reach Delta-V — retrying" screen (terminal covered, never looks live). Wake/re-enable → it auto-reconnects (or tap Retry) and catches up.
12. Settings → Regenerate token → the phone drops to pairing with "This pairing is no longer valid"; re-scan.
13. Add to Home Screen → launches standalone (paste the link if the pairing screen shows).
14. Port already in use → red error in Settings → Remote.

### Automated checks

```bash
npx esbuild tools/remote-bridge-check.ts --bundle --format=cjs --platform=node --alias:@shared=./src/shared --outfile=/tmp/remote-bridge-check.cjs && node /tmp/remote-bridge-check.cjs
npx esbuild tools/remote-client-pure-check.ts --bundle --format=cjs --platform=node --alias:@shared=./src/shared --outfile=/tmp/remote-client-pure-check.cjs && node /tmp/remote-client-pure-check.cjs
npx esbuild tools/remote-client-check.ts --bundle --format=cjs --platform=node --alias:@shared=./src/shared --outfile=/tmp/remote-client-check.cjs && node /tmp/remote-client-check.cjs
```

---

## Troubleshooting

### `node-pty` fails to build
```bash
# macOS: ensure Xcode CLI tools
xcode-select --install

# Rebuild native deps
npm rebuild node-pty

# Or force clean rebuild
rm -rf node_modules package-lock.json
npm install
```

### "Command not found" in terminal (exit code 127)
- Ensure the agent CLI is in your shell's PATH
- For GUI-launched apps on macOS, PATH may not include `/opt/homebrew/bin` — use `useShell: true` (default for built-ins) or set `workingDirOverride`
- Check Settings → Advanced → "Repo indexing" for LanceDB native deps issues

### Blank/white window on Linux
- Try disabling GPU sandbox: `electron --disable-gpu-sandbox` (already set in `main/index.ts`)
- Ensure `libwebkit2gtk-4.0` / `libgtk-3` are installed

### Settings not persisting
- Check write permissions on userData folder
- Run `npm run dev` and open DevTools → Console for `electron-store` errors

### "Delta-V is damaged and can't be opened" (macOS)
- This is Gatekeeper rejecting an **unsigned / ad-hoc signed** app. Unlike the usual "unidentified developer" warning, it has no Open Anyway bypass.
- **Immediate workaround** for the downloaded DMG (until a signed release ships):
```bash
xattr -dr com.apple.quarantine /Applications/Delta-V.app
```
- **Proper fix**: sign with a Developer ID Application certificate and notarize (see Packaging Details). Releases built without `APPLE_CERTIFICATE_BASE64` secrets are ad-hoc signed and will trigger this on other Macs.

### Scan shows 0 repos
- Root folder must contain **immediate subdirectories** (not files)
- Hidden folders (starting with `.`) and common noise (`node_modules`, `.git`, etc.) are ignored
- Click "Rescan folders" in header or Settings → General

### Phone can't connect to Delta-V Remote
- Confirm both devices are on the same Wi-Fi **and VLAN**; guest networks often enable client isolation, which blocks phone → Mac traffic
- Allow incoming connections for Delta-V in the OS firewall (macOS may prompt on first enable)
- Keep the Mac awake and Delta-V running with Settings → Remote enabled
- Check that the configured port is free; "Port … is already in use" appears in Settings → Remote
- VPN/tunnel interfaces can advertise the wrong address — choose the real LAN address from the QR address selector (not `localhost`, `utun*`, Docker or `vEthernet`)

### Screen still locks in watch mode
- Native Wake Lock needs a secure context; the plain-HTTP LAN origin falls back to the nosleep.js video loop, which some browser versions block or throttle — verify on the target iOS version
- Keep the page in the foreground and the eye toggle enabled; if playback was blocked, the header shows "Tap to keep screen on" — tap the toggle again
- The toggle stays enabled across backgrounding and reacquires the lock when the page becomes visible again

---

## Development Notes

### Adding a New Built-in Agent
Edit `src/shared/types.ts`:
```typescript
export const BUILTIN_AGENTS: CustomAgent[] = [
  // ...existing
  { id: 'myagent', name: 'My Agent', command: 'myagent', args: [], useShell: true },
]
```

### Extending IPC
1. Add channel constant to `src/shared/ipc.ts`
2. Add handler in `src/main/ipc.ts` (use `wrap()` for error normalization)
3. Expose in `src/preload/index.ts` via `contextBridge.exposeInMainWorld`
4. Add TypeScript types in `src/shared/api.ts`
5. Call from renderer via `window.deltav.<channel>(...)`

### Remote bridge invariants
- Never add a write path to the Remote bridge: it may only read `ptyManager.list()` and subscribe to `broadcast` / `resized` events
- Publish new remote events through `PtyManager.publish` and handle them in `RemoteBridge.onPtyEvent`; do not push PTY data from the HTTP layer
- Keep wire types in `src/shared/types.ts` and channel/path constants in `src/shared/ipc.ts` so main and the phone client stay in sync

### Debugging Main Process
```bash
# In one terminal
npm run dev

# In another, attach VS Code debugger to "Electron: Main" launch config
# Or use: node --inspect=5858 out/main/index.js
```

---

## Packaging Details

### macOS (DMG)
- `appId: com.deltav.app`
- Category: `public.app-category.developer-tools`
- ARM64 only (Intel deprecated)
- `hardenedRuntime: true` with entitlements in `build/entitlements.mac.plist` (+ inherit variant for helpers) — required for notarization; `disable-library-validation` covers node-pty/LanceDB native binaries
- **Signing + notarization** (required for Gatekeeper to accept the app on other Macs):
  - Needs Apple Developer Program membership ($99/yr) + a Developer ID Application certificate
  - CI (`.github/workflows/release.yml`) signs via `APPLE_CERTIFICATE_BASE64` / `APPLE_CERTIFICATE_PASSWORD` secrets (electron-builder `CSC_LINK` / `CSC_KEY_PASSWORD`) and notarizes via `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`
  - Local `npm run dist:mac` without those env vars produces an ad-hoc signed build — runs on your Mac, shows "damaged" on anyone else's

### Windows (NSIS)
- Standard installer with uninstaller
- `npmRebuild: true` ensures `node-pty` rebuilds for target Electron version

### Linux (AppImage)
- Category: `Development`
- Runs on most glibc-based distros

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Credits

Built with:
- [Electron](https://www.electronjs.org/)
- [React](https://react.dev/)
- [Vite](https://vitejs.dev/) + [electron-vite](https://electron-vite.org/)
- [xterm.js](https://xtermjs.org/)
- [node-pty](https://github.com/microsoft/node-pty)
- [LanceDB](https://lancedb.com/)
- [Tailwind CSS](https://tailwindcss.com/)
- [lucide-react](https://lucide.dev/)

---

<div align="center">

**Made for developers who live in the terminal.**

</div>