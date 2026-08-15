# Installing OctoLauncher on Linux

This guide is for players — no building from source, no terminal skills
required beyond a couple of copy-paste commands.

> Don't want to run a prebuilt binary you can't fully verify? You don't have
> to — see [BUILD.md](BUILD.md) for building OctoLauncher from source
> yourself. It's the exact same code, `npm run dist` produces the identical
> AppImage.

## 1. Prerequisite: aria2

The game client downloads over BitTorrent, so the launcher needs `aria2c`
installed on your system (it's a small, common download tool — nothing to
configure, the launcher drives it automatically):

```bash
sudo apt install aria2
```

(use your distro's package manager — `dnf install aria2`, `pacman -S aria2`,
etc. if you're not on a Debian-based distro)

While the client is downloading, and for a little while after, the launcher
also shares pieces back to other players — the same thing the official
Windows client does.

## 2. Prerequisite: Steam + Proton

The actual WoW client is a Windows program, so it needs
[Proton](https://github.com/ValveSoftware/Proton) (the same compatibility
layer Steam uses to run Windows games on Linux) to run it. You do **not**
need to add WoW as a Steam game or create a shortcut — the launcher finds
Proton and manages everything itself.

All you need is:

1. Steam installed (from your distro's package manager, Flatpak, or
   [steampowered.com](https://store.steampowered.com/about/)).
2. At least one Proton version installed. If you've never played any
   Windows game through Steam before, install one manually:
   - Open Steam → **Settings** → **Compatibility**
   - Or right-click any game → **Properties** → **Compatibility**, and pick
     a Proton version from the dropdown (this downloads it).

That's it — you don't need to launch or configure anything else in Steam.

## 3. Download

Grab `OctoLauncher.AppImage` from the
[Releases page](../../releases/latest).

An AppImage is a single self-contained file — there's nothing to install or
unpack.

## 4. Make it executable and run it

Right-click the downloaded file → **Properties** → **Permissions** → check
**"Allow executing file as program"**, then double-click it to launch.

Or, from a terminal:

```bash
chmod +x OctoLauncher.AppImage
./OctoLauncher.AppImage
```

## 5. First launch

The launcher will ask you where to put (or where you already have) the
OctoWoW client files. Pick any folder — the launcher downloads and updates
the game client there automatically over BitTorrent. Click **Verify** if it
doesn't start downloading on its own, then **Play** once it finishes.

## 6. Addons, mods, and tweaks

Everything is managed from inside the launcher, same as the Windows version:

- **Addons** tab — install/remove addons, check for updates.
- **Mods** tab — optional client modifications (better rendering via DXVK,
  reduced input lag via nampower, SuperWoW for addon compatibility, etc.).
  Recommended ones are highlighted; hover the info icons for details.
- **Tweaks** tab — camera distance, field of view, nameplate range, and
  similar client-side settings.

## Troubleshooting

- **"No Proton installation found"** — install a Proton version through
  Steam as described in step 2, then restart the launcher.
- **Stuck on "Connecting..." and never starts downloading** — make sure
  `aria2` is installed (step 1), then click **Verify** again.
- **Something looks broken / a mod or addon didn't apply** — click
  **Verify** (or the repair option on the Mods tab) to re-check files.
- **Still stuck** — check the log file at:
  ```
  ~/.config/octo-launcher/logs/main.log
  ```
  This is the most useful thing to include if you report a problem.

## Uninstalling

Delete the AppImage file. Launcher settings live in
`~/.config/octo-launcher/` and your game files stay wherever you pointed
the launcher — delete either manually if you want a full clean removal.
