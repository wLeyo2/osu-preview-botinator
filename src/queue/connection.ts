import type { ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import config from '@/utils/config';
import logger from '@/utils/logger';

function retryStrategy(attempt: number): number | null {
  if (attempt > config.redis.maxRetries) return null;
  return Math.min(attempt * config.redis.retryDelayMs, 5_000);
}

function buildBullConnection(urlString: string): ConnectionOptions {
  const url = new URL(urlString);

  const dbFromPath = url.pathname.replace('/', '');
  const db = dbFromPath ? Number(dbFromPath) : 0;

  const base: ConnectionOptions = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    db: Number.isNaN(db) ? 0 : db,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    connectTimeout: config.redis.connectTimeoutMs,
    retryStrategy,
  };

  if (url.protocol === 'rediss:') {
    return {
      ...base,
      tls: {},
    };
  }

  return base;
}

export const bullConnection = buildBullConnection(config.redis.url);

export function createRedisConnection(clientName = 'redis'): IORedis {
  const redis = new IORedis(config.redis.url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    connectTimeout: config.redis.connectTimeoutMs,
    retryStrategy,
    connectionName: clientName,
  });

  redis.on('connect', () => {
    logger.info(`[Redis] ${clientName} connected`);
  });
  redis.on('ready', () => {
    logger.debug(`[Redis] ${clientName} ready`);
  });
  redis.on('reconnecting', (delayMs: number) => {
    logger.warn(`[Redis] ${clientName} reconnecting in ${delayMs}ms`);
  });
  redis.on('end', () => {
    logger.warn(`[Redis] ${clientName} connection closed`);
  });

  return redis;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Redis preflight timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function preflightRedisConnection(
  clientName = 'redis-preflight',
): Promise<void> {
  let attempt = 0;

  while (attempt <= config.redis.preflightRetries) {
    attempt += 1;
    const redis = createRedisConnection(clientName);

    try {
      await withTimeout(redis.ping(), config.redis.preflightTimeoutMs);
      await redis.quit().catch(() => {
        redis.disconnect();
      });
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error(
        `[Redis preflight] attempt ${attempt}/${config.redis.preflightRetries + 1} failed: ${reason}`,
      );

      await redis.quit().catch(() => {
        redis.disconnect();
      });

      if (attempt > config.redis.preflightRetries) {
        throw error;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, config.redis.preflightRetryDelayMs);
      });
    }
  }
}
