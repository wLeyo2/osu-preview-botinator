import config from '@/utils/config';
import logger from '@/utils/logger';
import { getQueueBacklog } from './videoQueue';

let telemetryTimer: ReturnType<typeof setInterval> | null = null;
let previousBacklogSignature: string | null = null;

function getBacklogSignature(backlog: {
  waiting: number;
  active: number;
  delayed: number;
  prioritized: number;
  paused: number;
  totalPending: number;
}): string {
  return `${backlog.waiting}:${backlog.active}:${backlog.delayed}:${backlog.prioritized}:${backlog.paused}:${backlog.totalPending}`;
}

async function logQueueBacklog(): Promise<void> {
  try {
    const backlog = await getQueueBacklog();
    const signature = getBacklogSignature(backlog);

    if (
      config.queue.telemetryOnlyOnChange &&
      previousBacklogSignature === signature
    ) {
      return;
    }

    previousBacklogSignature = signature;

    if (backlog.totalPending >= config.queue.maxBacklog) {
      logger.warn(
        `[Queue] backlog high waiting=${backlog.waiting} active=${backlog.active} delayed=${backlog.delayed} prioritized=${backlog.prioritized} paused=${backlog.paused} total=${backlog.totalPending}`,
      );
      return;
    }

    logger.info(
      `[Queue] backlog waiting=${backlog.waiting} active=${backlog.active} delayed=${backlog.delayed} prioritized=${backlog.prioritized} paused=${backlog.paused} total=${backlog.totalPending}`,
    );
  } catch (error) {
    logger.error(
      `[Queue] telemetry failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function startQueueTelemetry(): void {
  if (telemetryTimer) return;
  if (config.queue.telemetryIntervalSec <= 0) return;

  const intervalMs = config.queue.telemetryIntervalSec * 1000;
  telemetryTimer = setInterval(() => {
    void logQueueBacklog();
  }, intervalMs);

  logger.info(
    `[Queue] telemetry interval ${config.queue.telemetryIntervalSec}s`,
  );
  void logQueueBacklog();
}

export function stopQueueTelemetry(): void {
  if (!telemetryTimer) return;

  clearInterval(telemetryTimer);
  telemetryTimer = null;
  previousBacklogSignature = null;
}
