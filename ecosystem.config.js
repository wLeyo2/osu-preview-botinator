module.exports = {
  apps: [
    {
      // Dragonfly replaces Redis; allow-undeclared-keys is required by BullMQ
      name: 'dragonfly',
      script: 'dragonfly',
      args: [
        '--logtostderr',
        '--port=6379',
        '--default_lua_flags=allow-undeclared-keys',
        '--proactor_threads=2',
        '--maxmemory=2gb',
        '--dir=/home/ubuntu/downloads/repositories/osu-preview-botinator/data/dragonfly',
      ],
      max_restarts: 10,
      restart_delay: 3000,
      autorestart: true,
      watch: false,
    },
    {
      name: 'osu-preview-bot',
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
      name: 'osu-preview-worker',
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
