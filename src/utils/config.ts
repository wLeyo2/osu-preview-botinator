import { bool, cleanEnv, num, str } from 'envalid';

type GcMode = 'off' | 'incremental' | 'aggressive';

function parseGcMode(value: string): GcMode {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'off' ||
    normalized === 'incremental' ||
    normalized === 'aggressive'
  ) {
    return normalized;
  }

  return 'incremental';
}

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
  REDIS_PREFLIGHT_TIMEOUT_MS: num({ default: 4_000 }),
  REDIS_PREFLIGHT_RETRIES: num({ default: 2 }),
  REDIS_PREFLIGHT_RETRY_DELAY_MS: num({ default: 1_000 }),
  QUEUE_NAME: str({ default: 'osu-preview-renders' }),
  WORKER_CONCURRENCY: num({ default: 1 }),
  QUEUE_MAX_BACKLOG: num({ default: 150 }),
  QUEUE_ESTIMATED_JOB_SEC: num({ default: 180 }),
  QUEUE_TELEMETRY_INTERVAL_SEC: num({ default: 30 }),
  FFMPEG_THREADS: num({ default: 2 }),
  JOB_ATTEMPTS: num({ default: 3 }),
  JOB_BACKOFF_MS: num({ default: 5_000 }),
  RENDER_CACHE_TTL_SEC: num({ default: 2_592_000 }),
  DELIVERY_DEDUP_WINDOW_SEC: num({ default: 300 }),
  QUEUE_NOTICE_COOLDOWN_SEC: num({ default: 30 }),
  REQUEST_COOLDOWN_SEC: num({ default: 3 }),
  RENDERER_VERSION: str({ default: 'v1' }),
  AUDIO_HEADER_TIMEOUT_MS: num({ default: 8_000 }),
  AUDIO_TOTAL_TIMEOUT_MS: num({ default: 45_000 }),
  AUDIO_STALL_TIMEOUT_MS: num({ default: 8_000 }),
  AUDIO_HEDGE_DELAY_MS: num({ default: 2_000 }),
  MIRROR_COOLDOWN_SEC: num({ default: 300 }),
  COVER_FETCH_TIMEOUT_MS: num({ default: 3_000 }),
  GC_MODE: str({ default: 'incremental' }),
  GC_EVERY_N_JOBS: num({ default: 2 }),
  GC_RSS_THRESHOLD_MB: num({ default: 0 }),
  WORKER_MAX_JOBS_BEFORE_RESTART: num({ default: 0 }),
  WORKER_RESTART_RSS_MB: num({ default: 0 }),
  WORKER_REDIS_ERROR_BUDGET: num({ default: 5 }),
  WORKER_REDIS_ERROR_WINDOW_MS: num({ default: 15_000 }),
  WORKER_BEATMAP_CACHE_SIZE: num({ default: 128 }),
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
    preflightTimeoutMs: Math.max(500, env.REDIS_PREFLIGHT_TIMEOUT_MS),
    preflightRetries: Math.max(0, env.REDIS_PREFLIGHT_RETRIES),
    preflightRetryDelayMs: Math.max(100, env.REDIS_PREFLIGHT_RETRY_DELAY_MS),
  },
  queue: {
    name: env.QUEUE_NAME,
    workerConcurrency,
    jobAttempts: Math.max(1, env.JOB_ATTEMPTS),
    jobBackoffMs: Math.max(0, env.JOB_BACKOFF_MS),
    maxBacklog: Math.max(1, env.QUEUE_MAX_BACKLOG),
    estimatedJobSec: Math.max(1, env.QUEUE_ESTIMATED_JOB_SEC),
    telemetryIntervalSec: Math.max(0, env.QUEUE_TELEMETRY_INTERVAL_SEC),
    queueNoticeCooldownSec: Math.max(5, env.QUEUE_NOTICE_COOLDOWN_SEC),
    requestCooldownSec: Math.max(0, env.REQUEST_COOLDOWN_SEC),
  },
  render: {
    ffmpegThreads,
    cacheTtlSec: Math.max(60, env.RENDER_CACHE_TTL_SEC),
    deliveryDedupWindowSec: Math.max(10, env.DELIVERY_DEDUP_WINDOW_SEC),
    rendererVersion: env.RENDERER_VERSION,
    audioHeaderTimeoutMs: Math.max(1_000, env.AUDIO_HEADER_TIMEOUT_MS),
    audioTotalTimeoutMs: Math.max(5_000, env.AUDIO_TOTAL_TIMEOUT_MS),
    audioStallTimeoutMs: Math.max(1_000, env.AUDIO_STALL_TIMEOUT_MS),
    audioHedgeDelayMs: Math.max(0, env.AUDIO_HEDGE_DELAY_MS),
    mirrorCooldownSec: Math.max(0, env.MIRROR_COOLDOWN_SEC),
    coverFetchTimeoutMs: Math.max(500, env.COVER_FETCH_TIMEOUT_MS),
    gcMode: parseGcMode(env.GC_MODE),
    gcEveryNJobs: Math.max(1, env.GC_EVERY_N_JOBS),
    gcRssThresholdMb: Math.max(0, env.GC_RSS_THRESHOLD_MB),
    workerMaxJobsBeforeRestart: Math.max(0, env.WORKER_MAX_JOBS_BEFORE_RESTART),
    workerRestartRssMb: Math.max(0, env.WORKER_RESTART_RSS_MB),
    workerRedisErrorBudget: Math.max(1, env.WORKER_REDIS_ERROR_BUDGET),
    workerRedisErrorWindowMs: Math.max(1_000, env.WORKER_REDIS_ERROR_WINDOW_MS),
    workerBeatmapCacheSize: Math.max(0, env.WORKER_BEATMAP_CACHE_SIZE),
  },
  r2: {
    endpoint: env.CLOUD_ENDPOINT,
    accessKeyId: env.CLOUD_ACCESKEY,
    secretAccessKey: env.CLOUD_SECRETKEY,
    publicUrl: env.R2_PUBLIC_URL,
    bucket: env.R2_BUCKET,
  },
};
