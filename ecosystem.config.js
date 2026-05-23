module.exports = {
  apps: [
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
