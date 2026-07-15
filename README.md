# OctoLauncher (Linux)

Native Linux port of the desktop launcher for the OctoWoW (World of Warcraft
1.12.1 private server) client. Built with Electron, React, and tRPC. Runs the
Windows-only WoW client through [Proton](https://github.com/ValveSoftware/Proton)
in a dedicated, self-managed prefix — no manual Steam shortcut or Wine setup
required.

**What it does:**
- Downloads and patches the OctoWoW game client via a manifest-based CDN updater
- Rewrites `Config.wtf` with the correct realm/patch-list on every launch
- Optionally applies binary tweaks to `WoW.exe` (FOV, far-clip, large-address flag, etc.)
- Injects client mods (VanillaFixes, DXVK, nampower, SuperWoW, etc.) via a DLL chainloader
- Manages git-based addon installations
- Auto-detects and launches through your existing Proton install via Steam

---

## Quick start (players)

See **[INSTALL.md](INSTALL.md)** for the full step-by-step guide. Short version:

1. Grab `OctoLauncher.AppImage` from the [Releases](../../releases/latest) page.
2. `chmod +x OctoLauncher.AppImage` and run it.
3. Set your WoW client directory when prompted, click **Verify**, then **Play**.

Requires Steam with at least one Proton version installed — see INSTALL.md for details.

---

## Building from source

See **[BUILD.md](BUILD.md)** for full prerequisites (Node 20, `cmake`,
Steam/Proton) and build/dev commands.

---

## Running the dev backend

The `server/` subdirectory is a standalone Express server that simulates the production CDN for local development. It is **not** bundled into the Electron app.

```powershell
cd server
npm install
```

Create `server/.env` from `server/.env.example` and set `SOURCE_DIR` to your local WoW client directory, then:

```powershell
npm run dev
```

The server listens on `http://localhost:5000` and serves:
- `GET /api/file/:version/manifest.json`
- `GET /client/:version/*` — per-file downloads
- `GET /api/addons.json`

---

## Architecture overview

Three Vite bundles tied together by tRPC over Electron IPC:

- **Main** ([src/main/](src/main/)) — Electron main process; owns all filesystem/native work and the tRPC router
- **Preload** ([src/preload/](src/preload/)) — secure IPC bridge via `exposeElectronTRPC()`
- **Renderer** ([src/renderer/](src/renderer/)) — React 18 + Tailwind UI; no direct Node access

All cross-process data shapes are Zod schemas in [src/common/schemas.ts](src/common/schemas.ts). All renderer→main calls go through tRPC procedures in [src/main/api/routers/](src/main/api/routers/) — never raw `ipcMain.handle`.

---

## License

MIT
