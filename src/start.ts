import { type ChildProcess, spawn } from 'node:child_process';
import { preflightRedisConnection } from '@/queue/connection';
import logger from '@/utils/logger';

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;
const RESTART_DELAY_MS = 1_000;
const FORCE_KILL_DELAY_MS = 5_000;

interface ProcessSpec {
  name: string;
  script: string;
}

interface ManagedProcess {
  spec: ProcessSpec;
  process: ChildProcess | null;
  restartTimestamps: number[];
}

const processSpecs: ProcessSpec[] = [
  { name: 'discord-bot', script: 'start:bot' },
  { name: 'render-worker', script: 'start:worker' },
];

const managed = new Map<string, ManagedProcess>();
for (const spec of processSpecs) {
  managed.set(spec.name, {
    spec,
    process: null,
    restartTimestamps: [],
  });
}

let shuttingDown = false;
let shutdownCode = 0;
let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
const orchestratorLogger = logger.child({ service: 'orchestrator' });

function isExited(child: ChildProcess | null): boolean {
  if (!child) return true;
  return child.exitCode !== null || child.signalCode !== null;
}

function runningChildrenCount(): number {
  let count = 0;
  for (const item of managed.values()) {
    if (!isExited(item.process)) count += 1;
  }
  return count;
}

function pruneRestartHistory(history: number[], now: number): number[] {
  return history.filter((timestamp) => now - timestamp <= RESTART_WINDOW_MS);
}

function canRestartProcess(item: ManagedProcess): boolean {
  const now = Date.now();
  item.restartTimestamps = pruneRestartHistory(item.restartTimestamps, now);
  return item.restartTimestamps.length < MAX_RESTARTS;
}

function recordRestart(item: ManagedProcess): void {
  const now = Date.now();
  item.restartTimestamps = pruneRestartHistory(item.restartTimestamps, now);
  item.restartTimestamps.push(now);
}

function spawnManagedProcess(item: ManagedProcess): void {
  if (shuttingDown) return;

  const child = spawn('bun', ['run', item.spec.script], {
    stdio: 'inherit',
    env: process.env,
  });

  item.process = child;
  orchestratorLogger.info(
    { process: item.spec.name },
    'Managed process started',
  );

  child.on('error', (error) => {
    orchestratorLogger.error(
      { process: item.spec.name, reason: error.message },
      'Managed process failed to start',
    );
    scheduleRestartOrShutdown(item, 1, null);
  });

  child.on('exit', (code, signal) => {
    item.process = null;
    if (shuttingDown) {
      maybeExit();
      return;
    }

    const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    orchestratorLogger.error(
      { process: item.spec.name, detail },
      'Managed process exited unexpectedly',
    );
    scheduleRestartOrShutdown(item, code ?? 1, signal);
  });
}

function scheduleRestartOrShutdown(
  item: ManagedProcess,
  code: number,
  signal: NodeJS.Signals | null,
): void {
  if (shuttingDown) return;

  if (!canRestartProcess(item)) {
    orchestratorLogger.error(
      {
        process: item.spec.name,
        maxRestarts: MAX_RESTARTS,
        restartWindowSec: RESTART_WINDOW_MS / 1000,
      },
      'Managed process exceeded restart limit',
    );
    requestShutdown(code === 0 ? 1 : code, signal ?? 'SIGTERM');
    return;
  }

  recordRestart(item);
  const attempts = item.restartTimestamps.length;
  orchestratorLogger.warn(
    {
      process: item.spec.name,
      delayMs: RESTART_DELAY_MS,
      attempt: attempts,
      maxRestarts: MAX_RESTARTS,
    },
    'Scheduling managed process restart',
  );

  setTimeout(() => {
    if (shuttingDown) return;
    spawnManagedProcess(item);
  }, RESTART_DELAY_MS);
}

function stopChildren(signal: NodeJS.Signals): void {
  for (const item of managed.values()) {
    const child = item.process;
    if (!child || isExited(child) || child.killed) continue;
    child.kill(signal);
  }
}

function maybeExit(): void {
  if (!shuttingDown) return;
  if (runningChildrenCount() > 0) return;

  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
    forceKillTimer = null;
  }

  process.exit(shutdownCode);
}

function requestShutdown(code: number, signal: NodeJS.Signals): void {
  shutdownCode = Math.max(shutdownCode, code);
  if (shuttingDown) return;
  shuttingDown = true;

  orchestratorLogger.info({ signal }, 'Shutting down managed processes');
  stopChildren(signal);

  forceKillTimer = setTimeout(() => {
    stopChildren('SIGKILL');
    process.exit(shutdownCode || 1);
  }, FORCE_KILL_DELAY_MS);

  maybeExit();
}

async function main(): Promise<void> {
  try {
    orchestratorLogger.info('Running Redis preflight');
    await preflightRedisConnection('redis-start-preflight');
    orchestratorLogger.info('Redis preflight passed');
  } catch (error) {
    orchestratorLogger.error(
      { reason: error instanceof Error ? error.message : String(error) },
      'Redis preflight failed',
    );
    process.exit(1);
  }

  for (const item of managed.values()) {
    spawnManagedProcess(item);
  }
}

process.on('SIGINT', () => {
  requestShutdown(0, 'SIGINT');
});

process.on('SIGTERM', () => {
  requestShutdown(0, 'SIGTERM');
});

void main();
