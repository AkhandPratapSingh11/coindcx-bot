/**
 * Line-structured logging. Every line is one JSON object so you can grep,
 * `jq`, or ship the file somewhere without a parsing step.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LOG_DIR = 'logs';
let logFile: string | null = null;

function ensureLogFile(): string {
  if (logFile) return logFile;
  mkdirSync(LOG_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  logFile = join(LOG_DIR, `bot-${day}.jsonl`);
  return logFile;
}

/** Keys whose values are redacted before anything is printed or written. */
const SECRET_KEYS = /^(api_?key|api_?secret|secret|authorization|token|password)$/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out;
}

/**
 * Error counting is injected rather than imported, so logger.ts stays free of
 * project imports and can be used from anywhere without a cycle.
 */
let onError: ((msg: string) => void) | null = null;
export function setErrorHook(fn: (msg: string) => void): void {
  onError = fn;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ? (scrub(fields) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(record);

  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  sink(line);

  if (level === 'error' && onError) {
    try {
      onError(msg);
    } catch {
      // A broken hook must never suppress a log line.
    }
  }

  try {
    appendFileSync(ensureLogFile(), line + '\n');
  } catch {
    // Never let a full disk or read-only mount take the bot down mid-trade.
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
