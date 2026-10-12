/**
 * EMA crossover — the shipped example. Replace it; do not trade it.
 *
 * Long while the fast EMA is above the slow EMA, flat otherwise. Long/flat
 * rather than long/short, because a trend filter this naive flips often and
 * each flip pays the spread twice. To allow shorts, return 'short' instead of
 * 'flat' in the else branch and re-run the backtest you have not written yet.
 */

import type { Candle, Strategy, Target } from '../strategy.js';
import { log } from '../logger.js';

function emaAlpha(period: number): number {
  return 2 / (period + 1);
}

class Ema {
  private value: number | null = null;
  private readonly alpha: number;
  private seen = 0;

  constructor(private readonly period: number) {
    this.alpha = emaAlpha(period);
  }

  push(price: number): number | null {
    this.seen += 1;
    if (this.value === null) {
      this.value = price;
    } else {
      this.value = price * this.alpha + this.value * (1 - this.alpha);
    }
    // An EMA seeded from a single price is meaningless until it has consumed
    // at least `period` samples; report nothing until then.
    return this.seen >= this.period ? this.value : null;
  }

  get current(): number | null {
    return this.seen >= this.period ? this.value : null;
  }
}

export class EmaCrossStrategy implements Strategy {
  readonly name: string;
  readonly requiredCandles: number;
  private readonly fast: Ema;
  private readonly slow: Ema;
  private lastTarget: Target = 'flat';

  constructor(fastPeriod: number, slowPeriod: number) {
    this.name = `ema-cross(${fastPeriod}/${slowPeriod})`;
    this.requiredCandles = slowPeriod + 1;
    this.fast = new Ema(fastPeriod);
    this.slow = new Ema(slowPeriod);
  }

  warmup(candles: readonly Candle[]): void {
    for (const c of candles) {
      this.fast.push(c.close);
      this.slow.push(c.close);
    }
    const f = this.fast.current;
    const s = this.slow.current;
    if (f !== null && s !== null) {
      // Seed the target from history so a restart mid-trend does not read as
      // a fresh crossover and re-enter a position the engine already holds.
      this.lastTarget = f > s ? 'long' : 'flat';
    }
    log.info('strategy warmed up', {
      strategy: this.name,
      candles: candles.length,
      fast: f,
      slow: s,
      seededTarget: this.lastTarget,
    });
  }

  isReady(): boolean {
    return this.fast.current !== null && this.slow.current !== null;
  }

  currentTarget(): Target | null {
    return this.isReady() ? this.lastTarget : null;
  }

  onClosedCandle(candle: Candle): Target {
    const f = this.fast.push(candle.close);
    const s = this.slow.push(candle.close);
    if (f === null || s === null) return 'flat';

    const target: Target = f > s ? 'long' : 'flat';
    if (target !== this.lastTarget) {
      log.info('signal change', {
        strategy: this.name,
        from: this.lastTarget,
        to: target,
        close: candle.close,
        fast: f,
        slow: s,
      });
    }
    this.lastTarget = target;
    return target;
  }
}
