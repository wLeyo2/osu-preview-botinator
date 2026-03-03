import { bool, cleanEnv, num, str } from 'envalid';

const env = cleanEnv(process.env, {
  TOKEN: str(),
  CLIENT_ID: str(),
  GUILD_ID: str({ default: '' }),
  SHOW_DEBUG: bool({ default: false }),
  REDIS_URL: str({ default: 'redis://127.0.0.1:6379' }),
  REDIS_KEY_PREFIX: str({ default: 'osu-preview-botinator' }),
  REDIS_CONNECT_TIMEOUT_MS: num({ default: 5_000 }),
  REDIS_MAX_RETRIES: num({ default: 10 }),
  REDIS_RETRY_DELAY_MS: num({ default: 500 }),
  QUEUE_NAME: str({ default: 'osu-preview-renders' }),
  WORKER_CONCURRENCY: num({ default: 1 }),
  FFMPEG_THREADS: num({ default: 2 }),
  JOB_ATTEMPTS: num({ default: 3 }),
  JOB_BACKOFF_MS: num({ default: 5_000 }),
  RENDER_CACHE_TTL_SEC: num({ default: 2_592_000 }),
  DELIVERY_DEDUP_WINDOW_SEC: num({ default: 300 }),
  QUEUE_NOTICE_COOLDOWN_SEC: num({ default: 30 }),
  REQUEST_COOLDOWN_SEC: num({ default: 3 }),
  RENDERER_VERSION: str({ default: 'v1' }),
  CLOUD_ENDPOINT: str(),
  CLOUD_ACCESKEY: str(),
  CLOUD_SECRETKEY: str(),
  R2_PUBLIC_URL: str(),
  R2_BUCKET: str(),
});

const workerConcurrency = Math.max(1, Math.min(2, env.WORKER_CONCURRENCY));
const ffmpegThreads = Math.max(1, Math.min(2, env.FFMPEG_THREADS));

export default {
  token: env.TOKEN,
  clientId: env.CLIENT_ID,
  guildId: env.GUILD_ID,
  showDebug: env.SHOW_DEBUG,
  redis: {
    url: env.REDIS_URL,
    keyPrefix: env.REDIS_KEY_PREFIX,
    connectTimeoutMs: Math.max(500, env.REDIS_CONNECT_TIMEOUT_MS),
    maxRetries: Math.max(0, env.REDIS_MAX_RETRIES),
    retryDelayMs: Math.max(100, env.REDIS_RETRY_DELAY_MS),
  },
  queue: {
    name: env.QUEUE_NAME,
    workerConcurrency,
    jobAttempts: Math.max(1, env.JOB_ATTEMPTS),
    jobBackoffMs: Math.max(0, env.JOB_BACKOFF_MS),
    queueNoticeCooldownSec: Math.max(5, env.QUEUE_NOTICE_COOLDOWN_SEC),
    requestCooldownSec: Math.max(0, env.REQUEST_COOLDOWN_SEC),
  },
  render: {
    ffmpegThreads,
    cacheTtlSec: Math.max(60, env.RENDER_CACHE_TTL_SEC),
    deliveryDedupWindowSec: Math.max(10, env.DELIVERY_DEDUP_WINDOW_SEC),
    rendererVersion: env.RENDERER_VERSION,
  },
  r2: {
    endpoint: env.CLOUD_ENDPOINT,
    accessKeyId: env.CLOUD_ACCESKEY,
    secretAccessKey: env.CLOUD_SECRETKEY,
    publicUrl: env.R2_PUBLIC_URL,
    bucket: env.R2_BUCKET,
  },
};
