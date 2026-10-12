/**
 * Single-instance guard. Two copies of a bot on the same account will cancel
 * each other's orders and double-size entries, and the failure looks like a
 * strategy bug rather than an ops mistake. Cheap insurance.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const LOCK_PATH = '.bot.lock';

function processAlive(pid: number): boolean {
  try {
    // Signal 0 performs permission/existence checks without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(): void {
  if (existsSync(LOCK_PATH)) {
    const raw = readFileSync(LOCK_PATH, 'utf8').trim();
    const pid = Number(raw);
    if (Number.isFinite(pid) && pid > 0 && processAlive(pid)) {
      throw new Error(
        `Another instance is already running (pid ${pid}, lock ${LOCK_PATH}). ` +
          'Stop it first, or remove the lock file if you are sure it is stale.',
      );
    }
    // Stale lock from a crashed run.
    unlinkSync(LOCK_PATH);
  }
  writeFileSync(LOCK_PATH, String(process.pid), 'utf8');
}

export function releaseLock(): void {
  try {
    if (!existsSync(LOCK_PATH)) return;
    const pid = Number(readFileSync(LOCK_PATH, 'utf8').trim());
    // Only remove our own lock — never clear a live sibling's.
    if (pid === process.pid) unlinkSync(LOCK_PATH);
  } catch {
    // Best effort on shutdown.
  }
}
