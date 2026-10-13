import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';

export interface EntryBlockStore {
  read(): string | null;
  write(reason: string | null): void;
}

export class MemoryEntryBlockStore implements EntryBlockStore {
  private reason: string | null = null;
  read(): string | null { return this.reason; }
  write(reason: string | null): void { this.reason = reason; }
}

/** An entry is journaled before submission, and remains blocked after a crash. */
export class FileEntryBlockStore implements EntryBlockStore {
  constructor(readonly path: string) {}

  read(): string | null {
    let raw: string;
    try { raw = readFileSync(this.path, 'utf8'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const record = JSON.parse(raw) as { version?: unknown; reason?: unknown };
    if (record?.version !== 1 || typeof record.reason !== 'string' || !record.reason.trim()) {
      throw new Error(`Invalid entry journal ${this.path}; inspect the venue before recovery`);
    }
    return record.reason;
  }

  write(reason: string | null): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (reason === null) {
      try { unlinkSync(this.path); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    } else {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const fd = openSync(temporary, 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ version: 1, reason, at: Date.now() }) + '\n');
          fsyncSync(fd);
        } finally { closeSync(fd); }
        renameSync(temporary, this.path);
      } finally {
        try { unlinkSync(temporary); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      }
    }
    const directoryFd = openSync(directory, 'r');
    try { fsyncSync(directoryFd); }
    finally { closeSync(directoryFd); }
  }
}

export function entryBlockStore(cfg: Config): EntryBlockStore {
  if (cfg.mode !== 'live') return new MemoryEntryBlockStore();
  // Scope journals to account and instrument without saving credentials.
  const identity = createHash('sha256').update(JSON.stringify([
    cfg.apiKey, cfg.pair, cfg.quoteCurrency,
  ])).digest('hex');
  return new FileEntryBlockStore(join('.bot-state', `entry-${identity}.json`));
}
