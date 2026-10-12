/**
 * Connors RSI(2) mean reversion.
 *
 * Lineage: Larry Connors' "Short Term Trading Strategies That Work". The
 * canonical published rules, per StockCharts' ChartSchool and LuxAlgo:
 *
 *   - Trend filter: longs only while price is above the 200-period SMA,
 *     shorts only while below it. This filter is the strategy — without it,
 *     RSI(2) buys every step of a downtrend.
 *   - Entry: RSI(2) below 10 (some sources use 5) for longs; above 90 (or 95)
 *     for shorts.
 *   - Exit: close back above the 5-period SMA for longs, below it for shorts.
 *     Note the exit is the 5-SMA, *not* the 200-SMA — a common misreading.
 *
 * Sources disagree on the entry threshold (10 vs 5) and on the short-side
 * exit, so all four are configurable.
 *
 * Behaviour: the opposite profile to breakout — higher win rate, small
 * winners, smooth equity curve until a trend runs through it. Published
 * crypto drawdowns for this family vary wildly between sources (25% to 65%),
 * which tells you how parameter- and period-sensitive it is. The stated
 * danger is real: an asset can stay oversold while price keeps falling, and
 * the 200-SMA filter is the only thing standing between you and that.
 */

import { CandleBuffer } from './buffer.js';
import { rsi, sma } from './indicators.js';
import { log } from '../logger.js';
import type { Candle, Strategy, Target } from '../strategy.js';

export interface Rsi2Options {
  rsiPeriod: number;
  oversold: number;
  overbought: number;
  trendSmaPeriod: number;
  exitSmaPeriod: number;
  allowShorts: boolean;
}

export class Rsi2ReversionStrategy implements Strategy {
  readonly name: string;
  readonly requiredCandles: number;

  private readonly buffer: CandleBuffer;
  private target: Target = 'flat';

  constructor(private readonly opts: Rsi2Options) {
    this.name = `rsi${opts.rsiPeriod}-reversion(${opts.oversold}/${opts.overbought},sma${opts.trendSmaPeriod}${opts.allowShorts ? ',short' : ''})`;
    this.requiredCandles = Math.max(opts.trendSmaPeriod, opts.rsiPeriod + 1, opts.exitSmaPeriod) + 1;
    this.buffer = new CandleBuffer(this.requiredCandles + 100);
  }

  warmup(candles: readonly Candle[]): void {
    this.buffer.pushAll(candles);

    // Replay so a restart does not re-enter a trade the strategy would
    // already be holding, nor hold one it would have exited.
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

  private evaluate(candles: readonly Candle[]): Target {
    const closes = candles.map(c => c.close);
    const close = closes[closes.length - 1];
    const trendSma = sma(closes, this.opts.trendSmaPeriod);
    const exitSma = sma(closes, this.opts.exitSmaPeriod);
    const value = rsi(closes, this.opts.rsiPeriod);

    if (close === undefined || trendSma === null || exitSma === null || value === null) {
      return this.target;
    }

    const uptrend = close > trendSma;

    // Exits are checked first: an open position leaves on the 5-SMA cross
    // even if the RSI would re-arm an entry on the same bar.
    if (this.target === 'long' && close > exitSma) return 'flat';
    if (this.target === 'short' && close < exitSma) return 'flat';

    // A position whose trend filter has flipped is no longer the trade we
    // took; close it rather than hold against the filter.
    if (this.target === 'long' && !uptrend) return 'flat';
    if (this.target === 'short' && uptrend) return 'flat';

    if (this.target === 'flat') {
      if (uptrend && value < this.opts.oversold) return 'long';
      if (!uptrend && value > this.opts.overbought) {
        return this.opts.allowShorts ? 'short' : 'flat';
      }
    }

    return this.target;
  }
}
