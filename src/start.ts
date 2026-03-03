import { type ChildProcess, spawn } from 'node:child_process';

interface ManagedProcess {
  name: string;
  process: ChildProcess;
}

function spawnManagedProcess(name: string, script: string): ManagedProcess {
  const child = spawn('bun', ['run', script], {
    stdio: 'inherit',
    env: process.env,
  });

  return {
    name,
    process: child,
  };
}

const managed: ManagedProcess[] = [
  spawnManagedProcess('discord-bot', 'start:bot'),
  spawnManagedProcess('render-worker', 'start:worker'),
];

let shuttingDown = false;
let shutdownCode = 0;
let killTimer: ReturnType<typeof setTimeout> | null = null;

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function stopChildren(signal: NodeJS.Signals): void {
  for (const managedProcess of managed) {
    const child = managedProcess.process;
    if (hasExited(child) || child.killed) continue;
    child.kill(signal);
  }
}

function maybeExit(): void {
  if (!shuttingDown) return;
  if (managed.some((entry) => !hasExited(entry.process))) return;

  if (killTimer) {
    clearTimeout(killTimer);
    killTimer = null;
  }

  process.exit(shutdownCode);
}

function requestShutdown(code: number, signal: NodeJS.Signals): void {
  shutdownCode = Math.max(shutdownCode, code);
  if (shuttingDown) return;

  shuttingDown = true;
  stopChildren(signal);

  killTimer = setTimeout(() => {
    stopChildren('SIGKILL');
    process.exit(shutdownCode || 1);
  }, 5000);

  maybeExit();
}

for (const managedProcess of managed) {
  managedProcess.process.on('error', (error) => {
    console.error(
      `[start] Failed to run ${managedProcess.name}: ${error.message}`,
    );
    requestShutdown(1, 'SIGTERM');
  });

  managedProcess.process.on('exit', (code, signal) => {
    if (!shuttingDown) {
      const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`;
      console.error(`[start] ${managedProcess.name} exited with ${detail}`);
      const exitCode = code === 0 ? 1 : (code ?? 1);
      requestShutdown(exitCode, 'SIGTERM');
      return;
    }

    maybeExit();
  });
}

process.on('SIGINT', () => {
  requestShutdown(0, 'SIGINT');
});

process.on('SIGTERM', () => {
  requestShutdown(0, 'SIGTERM');
});
