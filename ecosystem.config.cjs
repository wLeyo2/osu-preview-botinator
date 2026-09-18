module.exports = {
  apps: [
    {
      // Dragonfly replaces Redis. See docs/dragonfly-migration.md for why each flag is here.
      name: 'dragonfly',
      script: 'dragonfly',
      interpreter: 'none',
      args: [
        '--logtostderr',
        // Dragonfly has no protected mode: without this it serves every interface, unauthenticated.
        '--bind=127.0.0.1',
        '--port=6379',
        '--default_lua_flags=allow-undeclared-keys',
        '--proactor_threads=2',
        '--maxmemory=2gb',
        '--dir=/home/ubuntu/downloads/repositories/osu-preview-botinator/data/dragonfly',
        // Load and write dump.rdb in Redis format, so Redis can read it back on rollback.
        '--dbfilename=dump',
        '--df_snapshot_format=false',
        '--snapshot_cron=*/30 * * * *',
      ],
      max_restarts: 10,
      restart_delay: 3000,
      autorestart: true,
      watch: false,
    },
    {
      // Names match the running pm2 processes. A different name makes `pm2 start` launch a
      // second bot on the same Discord token instead of reusing the existing one.
      name: 'o!preview',
      script: 'bun',
      args: ['run', 'start:bot'],
      cwd: '/home/ubuntu/downloads/repositories/osu-preview-botinator',
      env_file:
        '/home/ubuntu/downloads/repositories/osu-preview-botinator/.env',
      max_restarts: 10,
      restart_delay: 3000,
      autorestart: true,
      watch: false,
    },
    {
      name: 'o!preview-worker',
      script: 'bun',
      args: ['run', 'start:worker'],
      cwd: '/home/ubuntu/downloads/repositories/osu-preview-botinator',
      env_file:
        '/home/ubuntu/downloads/repositories/osu-preview-botinator/.env',
      max_restarts: 10,
      restart_delay: 3000,
      autorestart: true,
      watch: false,
    },
  ],
};
