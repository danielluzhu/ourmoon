# Running Family Table

The app has **no runtime dependencies** — Bun plus the files in this repo is the whole thing.
(`bun install` only pulls TypeScript for `bun run typecheck`.)

## Locally

```bash
bun run dev          # http://localhost:3000, reloads on change
```

Data lands in `./data/` unless `DATA_DIR` says otherwise.

## Under systemd

```bash
sudo install -m 0644 deploy/familytable.service /etc/systemd/system/familytable.service
sudo systemctl daemon-reload
sudo systemctl enable --now familytable
```

Then:

```bash
systemctl status familytable
journalctl -u familytable -f
sudo systemctl restart familytable      # after changing anything under src/
```

Files in `public/` are read per request, so front-end edits are live without a restart.

### What the unit assumes

| | |
|---|---|
| App lives at | `/workspace` |
| Bun binary | `/home/ubuntu/.bun/bin/bun` |
| Runs as | `ubuntu` |
| Listens on | `0.0.0.0:3000` (`PORT`, `HOST`) |
| State | `/var/lib/familytable` — created by `StateDirectory=`, holds `familytable.sqlite` and `audio/` |

Change those with `sudo systemctl edit familytable` rather than editing the unit in place.

The unit is sandboxed: the whole filesystem is read-only to the service except its state
directory, and `SystemCallFilter=@system-service` applies. If you move the app somewhere the
service cannot read, it will fail to start with a permissions error rather than a missing-file one.

### Backups

Everything is in the state directory:

```bash
sudo systemctl stop familytable
sudo tar czf familytable-backup.tar.gz -C /var/lib familytable
sudo systemctl start familytable
```

## Putting it on the internet

Right now it serves plain HTTP. Two things matter before family members use it from their phones:

1. **TLS is not optional** — browsers only grant microphone access on `https://` (or
   `localhost`). Without it, the record button cannot work. Terminate TLS at Caddy or nginx and
   proxy to `127.0.0.1:3000`, and set `HOST=127.0.0.1` in the unit so the app is not directly
   reachable.
2. The `Secure` cookie flag turns itself on when the request arrives over HTTPS, including via
   `X-Forwarded-Proto` from a reverse proxy.
