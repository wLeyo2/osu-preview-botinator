# Redis → Dragonfly migration

Dragonfly is a RESP-compatible, multi-threaded Redis replacement. No
application code changes are required: BullMQ, ioredis, and every key the bot
uses (queue, render cache, user prefs) work unchanged — `REDIS_URL` stays
`redis://127.0.0.1:6379`.

## Required server flag

BullMQ's Lua scripts access keys without declaring them, which Dragonfly
rejects by default. Start Dragonfly with:

```
--default_lua_flags=allow-undeclared-keys
```

Both `process-compose.yaml` and `ecosystem.config.js` already include it.

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

Dragonfly loads Redis RDB snapshots directly:

1. `redis-cli SAVE` — write a fresh `dump.rdb`.
2. Stop Redis (`sudo systemctl stop redis` or equivalent).
3. `mkdir -p data/dragonfly && cp /var/lib/redis/dump.rdb data/dragonfly/`
4. Start Dragonfly pointing `--dir` at that folder (already configured); it
   picks up `dump.rdb` on boot.
5. Verify: `redis-cli ping`, then `redis-cli --scan --pattern 'osu-preview-botinator*' | head`.

Losing this data is low-stakes (user prefs + render cache with TTL), so a
clean start is also acceptable.

## Resource sizing (3-CPU / 24 GB VM)

- `--proactor_threads=2` — leaves CPU headroom for the render worker and ffmpeg.
- `--maxmemory=2gb` — far above expected usage; Dragonfly evicts before OOM.

## Rollback

Stop Dragonfly, start Redis again. The RDB Dragonfly writes on shutdown is
Redis-compatible (`data/dragonfly/dump.rdb`), so data flows back the same way.
