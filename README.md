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
│                      │   terminal:exit      │   - SettingsDialog│
└──────────────────────┴──────────────────────┴───────────────────┘
```

### Key Technologies
| Layer | Stack |
|-------|-------|
| **Framework** | Electron 33 |
| **Frontend** | React 18 + TypeScript |
| **Build** | Vite 5 + electron-vite |
| **Terminal** | xterm.js 6 + @xterm/addon-fit + @xterm/addon-web-links + node-pty |
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
│   │   └── repoIndex.ts        # LanceDB indexing + search service
│   ├── preload/                # Secure preload script (contextBridge)
│   │   └── index.ts            # IPC channel allowlist + type-safe API
│   ├── shared/                 # Types shared between main & renderer
│   │   ├── types.ts            # All interfaces (settings, agents, tiles, IPC)
│   │   ├── ipc.ts              # IPC channel name constants
│   │   └── api.ts              # Type-safe preload API shape
│   └── renderer/               # React frontend (Vite + TSX)
│       ├── index.html          # Entry HTML
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
│       │   │   ├── SettingsDialog.tsx  # 4-tab settings modal
│       │   │   ├── Terminal.tsx        # xterm.js component
│       │   │   └── ui.tsx              # Primitive UI components
│       │   ├── state/
│       │   │   └── AppProvider.tsx     # Global state + actions (Context)
│       │   ├── hooks/
│       │   │   └── useTheme.ts         # Theme resolution + sync
│       │   └── styles/
│       │       └── index.css           # Tailwind imports + globals
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
  "repoIndexEnabled": true
}
```

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