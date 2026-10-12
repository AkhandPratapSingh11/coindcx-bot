/**
 * Rolling candle history shared by the indicator-based strategies.
 *
 * Indicators are recomputed over the retained window on each closed candle
 * rather than being updated incrementally. That is marginally more work for a
 * few hundred candles — and far harder to get wrong. Incremental indicator
 * state is where stale-value and double-update bugs live, and those produce
 * losses that look like bad luck rather than bad code.
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
