# opentracker — OctoWow launcher torrent swarm

BitTorrent tracker the launcher's webtorrent clients announce to. Runs
on your VPS alongside the companion update server. Tiny (~2 MB RSS),
near-zero CPU, zero disk IO after boot.

**Why your own tracker**: public trackers (opentrackr.org, etc.) are
reliable enough for hobby swarms but add a single-point-of-failure you
don't control, and often rate-limit new info-hashes. The launcher also
announces over DHT, so your tracker is redundant with DHT — but it's
the fastest path for a fresh peer to find the swarm before DHT has
warmed up.

## Deploy (VPS, Linux)

SSH into the VPS, clone this repo, run:

```
cd Tools/launcher/tracker
chmod +x install.sh
./install.sh
```

`install.sh` is idempotent — re-run to update. It builds opentracker
from CVS (only distribution upstream offers), installs it under
`/opt/opentracker/bin/`, drops a hardened systemd unit, and starts the
service bound to `0.0.0.0:6969`.

**Firewall**: open `6969/tcp` + `6969/udp`. On a typical Ubuntu VPS
with ufw: `sudo ufw allow 6969`.

## Verify

```
sudo systemctl status opentracker
curl http://127.0.0.1:6969/stats?mode=tpbs   # shows torrents / peers / bytes
```

The launcher's webtorrent client will announce to this URL the moment
a dev runs the companion server with `TRACKER_URL` set to match.

## Wire the companion server to use this tracker

Set the `TRACKER_URL` env var when running the companion server so
every `.torrent` it generates announces to your VPS:

```
TRACKER_URL=http://<your-vps-ip>:6969/announce npm run server
```

Default is `http://127.0.0.1:6969/announce` (assumes tracker + companion
server run on the same VPS, which is the normal deployment).

Clients pull the `.torrent` blob from the companion server — the URL
is already baked in by `create-torrent` at generation time, so no
launcher-side config needed.

## Uninstall

```
sudo systemctl stop opentracker
sudo systemctl disable opentracker
sudo rm /etc/systemd/system/opentracker.service
sudo rm -rf /opt/opentracker
sudo userdel opentracker
```
