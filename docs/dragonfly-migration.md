# Redis → Dragonfly migration

Dragonfly is a RESP-compatible, multi-threaded Redis replacement. No
application code changes are required: BullMQ, ioredis, and every key the bot
uses (queue, render cache, user prefs) work unchanged — `REDIS_URL` stays
`redis://127.0.0.1:6379`.

## Required server flags

| Flag | Why |
|---|---|
| `--default_lua_flags=allow-undeclared-keys` | BullMQ's Lua scripts touch keys they do not declare, which Dragonfly rejects by default. |
| `--bind=127.0.0.1` | Dragonfly has no protected mode. Without it, it listens on every interface with no password. |
| `--dbfilename=dump` | The default name is `dump-{timestamp}`, which never matches a Redis `dump.rdb`, so existing data would not load. |
| `--df_snapshot_format=false` | Writes snapshots as Redis RDB (`dump.rdb`) instead of Dragonfly's `.dfs`, so Redis can read them on rollback. |
| `--snapshot_cron=*/30 * * * *` | Dragonfly only snapshots on shutdown by default. This caps a crash to 30 minutes of lost data. |

Both `process-compose.yaml` and `ecosystem.config.cjs` include all of them.

## Install (Ubuntu ARM64 / OCI)

```bash
curl -L https://dragonflydb.gateway.scarf.sh/latest/dragonfly-aarch64.tar.gz \
  -o /tmp/dragonfly.tar.gz
tar xzf /tmp/dragonfly.tar.gz -C /tmp
sudo mv /tmp/dragonfly-aarch64 /usr/local/bin/dragonfly
sudo chmod +x /usr/local/bin/dragonfly
dragonfly --version
```

(For x86 machines use `dragonfly-x86_64.tar.gz`; the same tarballs are also on
the GitHub releases page: `github.com/dragonflydb/dragonfly/releases`.)

## Migrating existing data

Dragonfly loads Redis RDB snapshots directly. This swap keeps the bots running: ioredis
reconnects on its own, and the store is down for under a second.

1. `mkdir -p data/dragonfly`
2. `redis-cli SHUTDOWN SAVE` writes a final `dump.rdb` into Redis's working directory and stops it.
3. Copy that `dump.rdb` into `data/dragonfly/`.
4. `pm2 start ecosystem.config.cjs --only dragonfly`, then `pm2 save`.
5. Verify: `redis-cli ping`, `redis-cli dbsize` (same count as before), and
   `ss -tln | grep 6379` shows only `127.0.0.1`.

Losing this data is low-stakes (user prefs + render cache with TTL), so a
clean start is also acceptable.

## Running under pm2

- The app names in `ecosystem.config.cjs` match the running processes (`o!preview`,
  `o!preview-worker`). Keep them in sync: a new name starts a duplicate bot on the same token.
- After adding or removing an app, run `pm2 save`, or it will not come back after a reboot.
- Boot start is a one-time `pm2 startup systemd -u ubuntu --hp /home/ubuntu` (run with `sudo`
  and a `PATH` that contains `node`).

## Resource sizing (3-CPU / 24 GB VM)

- `--proactor_threads=2` — leaves CPU headroom for the render worker and ffmpeg.
- `--maxmemory=2gb` — far above expected usage; Dragonfly evicts before OOM.

## Rollback

Stop Dragonfly (`pm2 delete dragonfly`), copy `data/dragonfly/dump.rdb` to Redis's working
directory and start Redis again with `--bind 127.0.0.1`. Because of `--df_snapshot_format=false`
that file is plain Redis RDB, so data flows back the same way.
