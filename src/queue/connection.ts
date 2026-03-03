import type { ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import config from '@/utils/config';

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

export function createRedisConnection(): IORedis {
  return new IORedis(config.redis.url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    connectTimeout: config.redis.connectTimeoutMs,
    retryStrategy,
  });
}
