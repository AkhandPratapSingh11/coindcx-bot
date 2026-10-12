/**
 * MACD signal-line cross, with an optional long-term trend filter.
 *
 * Lineage: Gerald Appel's MACD (1979). Present in freqtrade's official
 * collection as `UniversalMACD.py` and in roughly every charting package
 * ever shipped. Included here as the "smoother EMA cross" family: it reacts
 * later than a raw EMA crossover but chops less.
 *
 * The trend filter (price above/below a long SMA) is off by default to keep
 * the textbook rule intact, but turning it on is the single most common
 * improvement applied to MACD in practice — it suppresses the counter-trend
 * crosses that generate most of the losing trades.
 */

import { CandleBuffer } from './buffer.js';
import { macd, sma } from './indicators.js';
import { log } from '../logger.js';
import type { Candle, Strategy, Target } from '../strategy.js';

export interface MacdOptions {
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
  /** 0 disables the filter. */
  trendSmaPeriod: number;
  allowShorts: boolean;
}

export class MacdTrendStrategy implements Strategy {
  readonly name: string;
  readonly requiredCandles: number;

  private readonly buffer: CandleBuffer;
  private target: Target = 'flat';

  constructor(private readonly opts: MacdOptions) {
    const filter = opts.trendSmaPeriod > 0 ? `,sma${opts.trendSmaPeriod}` : '';
    this.name = `macd(${opts.fastPeriod}/${opts.slowPeriod}/${opts.signalPeriod}${filter}${opts.allowShorts ? ',short' : ''})`;
    this.requiredCandles = Math.max(opts.slowPeriod + opts.signalPeriod, opts.trendSmaPeriod) + 2;
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

    const closes = this.buffer.closes();
    const value = macd(closes, this.opts.fastPeriod, this.opts.slowPeriod, this.opts.signalPeriod);
    if (!value) return 'flat';

    const side = this.crossSide(value.macd, value.signal);
    if (side === null) return this.target; // a tie is not a cross

    const close = closes[closes.length - 1] as number;
    if (this.opts.trendSmaPeriod > 0) {
      const trend = sma(closes, this.opts.trendSmaPeriod);
      if (trend === null) return 'flat';
      if (side === 'above' && close > trend) return 'long';
      if (side === 'below' && close < trend) {
        return this.opts.allowShorts ? 'short' : 'flat';
      }
      return 'flat';
    }

    if (side === 'above') return 'long';
    return this.opts.allowShorts ? 'short' : 'flat';
  }

  /**
   * Which side of the signal line the MACD sits on, or null when they are
   * equal to within floating-point noise.
   *
   * This deadband is not pedantry. On a smoothly trending series the MACD
   * converges to exactly its signal line, and the subtraction leaves residue
   * on the order of 1e-15 whose sign is arbitrary. Comparing with a bare `>`
   * turns that noise into a position.
   */
  private crossSide(macdLine: number, signal: number): 'above' | 'below' | null {
    const scale = Math.max(Math.abs(macdLine), Math.abs(signal), 1);
    const epsilon = scale * 1e-9;
    const diff = macdLine - signal;
    if (Math.abs(diff) <= epsilon) return null;
    return diff > 0 ? 'above' : 'below';
  }
}
