/**
 * Donchian channel breakout — the Turtle Traders' entry rule.
 *
 * Lineage: Richard Dennis / the Turtle system (1983), the most documented
 * trend-following rule in existence. Classic parameters are a 20-bar entry
 * channel and a 10-bar exit channel: you enter on a breakout of the recent
 * range and leave on a breakout of a *tighter* opposite range, so exits come
 * sooner than a symmetric rule would give.
 *
 * Expected behaviour, so you are not surprised by it: low win rate, long
 * flat stretches, and the occasional large winner that pays for everything
 * else. Vendor backtests on BTC put it at the high-return / deep-drawdown end
 * of the spectrum — roughly 40-50% peak-to-trough on daily bars. If you cannot
 * sit through that, this is the wrong family.
 *
 * Both channels exclude the current bar (see `donchianExcludingLast`), so a
 * "close above the 20-bar high" is a genuine breakout rather than a bar
 * comparing against its own high.
 */

import { CandleBuffer } from './buffer.js';
import { donchianExcludingLast } from './indicators.js';
import { log } from '../logger.js';
import type { Candle, Strategy, Target } from '../strategy.js';

export interface DonchianOptions {
  entryPeriod: number;
  exitPeriod: number;
  allowShorts: boolean;
}

export class DonchianBreakoutStrategy implements Strategy {
  readonly name: string;
  readonly requiredCandles: number;

  private readonly buffer: CandleBuffer;
  private target: Target = 'flat';

  constructor(private readonly opts: DonchianOptions) {
    this.name = `donchian-breakout(${opts.entryPeriod}/${opts.exitPeriod}${opts.allowShorts ? ',short' : ''})`;
    // +1 for the excluded current bar, plus a little headroom.
    this.requiredCandles = Math.max(opts.entryPeriod, opts.exitPeriod) + 2;
    this.buffer = new CandleBuffer(this.requiredCandles + 50);
  }

  warmup(candles: readonly Candle[]): void {
    this.buffer.pushAll(candles);
    // Replay the rule over history so a restart mid-trend inherits the
    // position the strategy would already be holding, instead of reading the
    // next bar as a fresh breakout.
    this.target = 'flat';
    const all = this.buffer.all();
    for (let i = this.requiredCandles; i <= all.length; i += 1) {
      this.target = this.evaluate(all.slice(0, i));
    }
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

    const next = this.evaluate(this.buffer.all());
    if (next !== this.target) {
      log.info('signal change', { strategy: this.name, from: this.target, to: next });
    }
    this.target = next;
    return next;
  }

  /** Pure given a candle history and the prior target — easy to test. */
  private evaluate(candles: readonly Candle[]): Target {
    const entry = donchianExcludingLast(candles, this.opts.entryPeriod);
    const exit = donchianExcludingLast(candles, this.opts.exitPeriod);
    const last = candles[candles.length - 1];
    if (!entry || !exit || !last) return this.target;

    const close = last.close;

    // Entry breakouts take precedence: a bar that breaks the wide channel is
    // a reversal signal, not an exit.
    if (close > entry.upper) return 'long';
    if (close < entry.lower) return this.opts.allowShorts ? 'short' : 'flat';

    // Otherwise the tighter channel governs when to leave an open position.
    if (this.target === 'long' && close < exit.lower) return 'flat';
    if (this.target === 'short' && close > exit.upper) return 'flat';

    return this.target;
  }
}
