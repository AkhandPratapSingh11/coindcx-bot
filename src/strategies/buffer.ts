/**
 * Rolling candle history shared by the indicator-based strategies.
 *
 * Most strategies recompute indicators over this retained window. MACD keeps
 * continuous EMA state separately so rolling the buffer cannot reseed it;
 * its optional SMA filter still uses this trailing history.
 */

import type { Candle } from '../strategy.js';

export class CandleBuffer {
  private readonly candles: Candle[] = [];

  constructor(private readonly capacity: number) {}

  push(candle: Candle): void {
    const last = this.candles[this.candles.length - 1];
    // Re-deliveries of the same bar replace rather than append; the engine
    // already dedupes, but a strategy must not corrupt its own history if an
    // upstream change ever lets one through.
    if (last && last.openTime === candle.openTime) {
      this.candles[this.candles.length - 1] = candle;
      return;
    }
    this.candles.push(candle);
    if (this.candles.length > this.capacity) {
      this.candles.splice(0, this.candles.length - this.capacity);
    }
  }

  pushAll(candles: readonly Candle[]): void {
    for (const c of candles) this.push(c);
  }

  get length(): number {
    return this.candles.length;
  }

  all(): readonly Candle[] {
    return this.candles;
  }

  closes(): number[] {
    return this.candles.map(c => c.close);
  }

  last(): Candle | null {
    return this.candles[this.candles.length - 1] ?? null;
  }
}
