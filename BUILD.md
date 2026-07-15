# OctoLauncher Build Guide (Linux)

This is a Linux-only fork of OctoLauncher. The actual WoW 1.12 client is a
Windows binary, so the launcher runs it through [Proton](https://github.com/ValveSoftware/Proton)
(the compatibility layer Steam uses to run Windows games). The launcher itself
is a native Electron app — only the game process runs under Proton.

## Prerequisites

### 1. Node.js 20 LTS

Native modules in this project (`stormlib-node`) are built via `node-gyp`
against whatever Node you run `npm install` with. Node 20 LTS is the known-good
version; use `nvm` if you want it isolated from your system Node:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
nvm use 20
```

### 2. Build tools

`stormlib-node` compiles the upstream StormLib C++ library via `cmake`/`make`
on Linux. On Debian/Ubuntu/Mint:

```bash
sudo apt install build-essential cmake python3
```

`build-essential` (gcc/g++/make) and `python3` are prerequisites for
`node-gyp` in general; `cmake` is specifically needed for `stormlib-node`'s
Linux build step.

### 3. Steam + Proton

The launcher needs at least one Proton install to find at runtime. The
simplest way to get one is to install Steam normally
(`sudo apt install steam` or your distro's package/Flatpak) and install a
Proton version from Steam's Compatibility Tools (Steam > Settings >
Compatibility, or right-click any game > Properties > Compatibility). The
launcher auto-detects installs under:

- `~/.local/share/Steam/steamapps/common/Proton */proton`
- `~/.steam/steam/steamapps/common/Proton */proton`
- Flatpak Steam's equivalent paths
- Any additional Steam library folders (via `libraryfolders.vdf`)
- `compatibilitytools.d/` in any of the above (for GE-Proton and other
  community Proton builds)

The launcher manages its own dedicated Proton prefix (separate from any Steam
shortcut you may already have) so it works out of the box for anyone who
installs it, without depending on prior per-machine Steam setup.

## Install dependencies

From the repo root:

```bash
npm install
```

This runs `stormlib-node`'s native build (cmake + make) and then
`electron-builder install-app-deps` to rebuild native modules against
Electron's bundled Node/V8 ABI.

Then the server (only needed if running a local CDN, see `server/.env.example`):

```bash
cd server
npm install
cd ..
```

## Running in dev

```bash
npm run dev
```

Starts electron-vite, builds main + preload + renderer, and opens an Electron
window on `http://localhost:5173` (or `5174` if 5173 is taken). Closing the
window ends the session.

## Building for distribution

```bash
npm run dist
```

Runs `tsc && npm run build && npm run pack`. Output lands in `distprod/` as an
AppImage (`OctoLauncher.AppImage`), configured in
[electron-builder.yml](electron-builder.yml). `electron-updater` uses the same
generic publish feed as before (`latest-linux.yml`, generated automatically
alongside the AppImage).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `stormlib-node` fails to build (`cmake: command not found`) | `cmake` not installed | `sudo apt install cmake` |
| `node-gyp` fails to find a compiler | Missing build tools | `sudo apt install build-essential python3` |
| Play button fails with "No Proton installation found" | No Proton installed via Steam | Install Steam and a Proton version from Compatibility Tools, or set a custom path in the launcher's Compatibility settings |
| `Port 5173 is in use` | Prior dev server didn't exit cleanly | Ignore (vite falls back to 5174) or kill the stale process |
