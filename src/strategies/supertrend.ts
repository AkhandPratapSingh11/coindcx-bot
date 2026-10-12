/**
 * Supertrend — ATR-banded trend following.
 *
 * Lineage: Olivier Seban's indicator, and by far the most popular trend tool
 * in retail crypto. It is in freqtrade's official strategy collection, though
 * note that repo states plainly that its own implementation "is not
 * validated" against the original. This one implements the canonical
 * recursion with band carry-forward and is unit-tested — see
 * `supertrendSeries`.
 *
 * Behaviour: always in the market when shorts are enabled (it flips rather
 * than going flat), so it trades more than Donchian and pays more in fees.
 * Tightening the multiplier increases whipsaw sharply; 3.0 with a 10-period
 * ATR is the common default and a sane starting point.
 */

import { CandleBuffer } from './buffer.js';
import { supertrendSeries } from './indicators.js';
import { log } from '../logger.js';
import type { Candle, Strategy, Target } from '../strategy.js';

export interface SupertrendOptions {
  period: number;
  multiplier: number;
  allowShorts: boolean;
}

export class SupertrendStrategy implements Strategy {
  readonly name: string;
  readonly requiredCandles: number;

  private readonly buffer: CandleBuffer;
  private target: Target = 'flat';

  constructor(private readonly opts: SupertrendOptions) {
    this.name = `supertrend(${opts.period},${opts.multiplier}${opts.allowShorts ? ',short' : ''})`;
    // The recursion needs room to settle; the direction immediately after the
    // ATR seed is not yet meaningful.
    this.requiredCandles = opts.period * 3 + 1;
    this.buffer = new CandleBuffer(this.requiredCandles + 100);
  }

  warmup(candles: readonly Candle[]): void {
    this.buffer.pushAll(candles);
    this.target = this.evaluate();
    log.info('strategy warmed up', {
      strategy: this.name,
      candles: candles.length,
      seededTarget: this.target,
    });
  }

  isReady(): boolean {
    return this.buffer.length >= this.requiredCandles;
  }

  currentTarget(): Target | null {
    return this.isReady() ? this.target : null;
  }

  onClosedCandle(candle: Candle): Target {
    this.buffer.push(candle);
    if (!this.isReady()) return 'flat';

    const next = this.evaluate();
    if (next !== this.target) {
      log.info('signal change', { strategy: this.name, from: this.target, to: next });
    }
    this.target = next;
    return next;
  }

  private evaluate(): Target {
    if (!this.isReady()) return 'flat';
    const series = supertrendSeries(this.buffer.all(), this.opts.period, this.opts.multiplier);
    const direction = series[series.length - 1];
    if (direction === null || direction === undefined) return 'flat';
    if (direction === 'up') return 'long';
    return this.opts.allowShorts ? 'short' : 'flat';
  }
}
