/**
 * A single mutable snapshot of what the bot is doing, for the dashboard to
 * read. Deliberately passive: modules push into it as a side effect of work
 * they were doing anyway, and nothing in the trading path ever reads from it.
 * If this file were deleted the bot would still trade identically.
 */

import type { OpenPosition } from './broker.js';
import type { Instrument } from './instrument.js';
import type { Target } from './strategy.js';

export interface Snapshot {
  startedAt: number;
  mode: string;
  dryRun: boolean;
  pair: string;
  interval: string;
  intervalMs: number;
  strategy: string;
  leverage: number;

  wsConnected: boolean;
  quote: { bid: number; ask: number } | null;
  quoteAt: number | null;
  quoteStale: boolean;

  instrument: Pick<Instrument, 'minQuantity' | 'minNotional' | 'quantityIncrement'> | null;

  equity: number | null;
  equityAt: number | null;
  equityBasis: 'available-balance' | 'wallet-balance' | 'paper-equity' | null;
  candleHistory: { openTime: number; close: number }[];
  candleDataBlocked: boolean;

  position: OpenPosition | null;
  positionAt: number | null;

  target: Target | null;
  lastCandle: { openTime: number; close: number } | null;
  lastSignalChange: { at: number; from: Target; to: Target } | null;

  counters: { candles: number; entries: number; exits: number; errors: number };
  lastError: { at: number; msg: string } | null;
}

const snapshot: Snapshot = {
  startedAt: Date.now(),
  mode: 'unknown',
  dryRun: true,
  pair: '',
  interval: '',
  intervalMs: 0,
  strategy: '',
  leverage: 0,
  wsConnected: false,
  quote: null,
  quoteAt: null,
  quoteStale: true,
  instrument: null,
  equity: null,
  equityAt: null,
  equityBasis: null,
  candleHistory: [],
  candleDataBlocked: false,
  position: null,
  positionAt: null,
  target: null,
  lastCandle: null,
  lastSignalChange: null,
  counters: { candles: 0, entries: 0, exits: 0, errors: 0 },
  lastError: null,
};

export function update(patch: Partial<Snapshot>): void {
  Object.assign(snapshot, patch);
}

export function bump(counter: keyof Snapshot['counters']): void {
  snapshot.counters[counter] += 1;
}

export function get(): Readonly<Snapshot> {
  return snapshot;
}

/** When the candle currently forming is due to close. */
export function nextCloseAt(): number | null {
  const { lastCandle, intervalMs } = snapshot;
  if (!lastCandle || intervalMs <= 0) return null;
  // lastCandle is the most recent *closed* bar, so the forming one closes two
  // intervals after its open.
  const next = lastCandle.openTime + intervalMs * 2;
  // After a long idle gap, project forward to the next real boundary.
  if (next > Date.now()) return next;
  const elapsed = Date.now() - lastCandle.openTime;
  const periods = Math.ceil(elapsed / intervalMs);
  return lastCandle.openTime + periods * intervalMs;
}
