/**
 * Indicator primitives.
 *
 * Pure functions over arrays, so every one of them is unit-testable against
 * hand-computed values — which matters because the usual way a bot loses money
 * quietly is an indicator that is subtly wrong rather than a logic error.
 *
 * Conventions:
 *  - Series are oldest-first.
 *  - `null` means "not enough data yet", never 0. A zero-valued indicator and
 *    an unwarmed one must never be confused.
 *  - RSI and ATR use Wilder smoothing (the standard), not a simple average.
 *  - Anything that looks backwards excludes the current bar where the textbook
 *    definition requires it, so no function can see data the engine would not
 *    have had at that candle's close.
 */

import type { Candle } from '../strategy.js';

/** Simple moving average of the last `period` values. */
export function sma(values: readonly number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    sum += values[i] as number;
  }
  return sum / period;
}

/**
 * EMA series, seeded with an SMA of the first `period` values (the standard
 * seeding; seeding with the first value alone biases the early series).
 * Entries before the seed are null.
 */
export function emaSeries(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  const alpha = 2 / (period + 1);
  let prev = sma(values.slice(0, period), period) as number;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i += 1) {
    prev = (values[i] as number) * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

export function ema(values: readonly number[], period: number): number | null {
  const series = emaSeries(values, period);
  return series.length > 0 ? (series[series.length - 1] ?? null) : null;
}

/**
 * Wilder RSI. Returns the latest value, or null before warmup.
 * An all-gains window yields 100 rather than dividing by zero.
 */
export function rsi(values: readonly number[], period: number): number | null {
  if (period <= 0 || values.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = (values[i] as number) - (values[i - 1] as number);
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < values.length; i += 1) {
    const change = (values[i] as number) - (values[i - 1] as number);
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** True range of `candle` given the previous close. */
export function trueRange(candle: Candle, prevClose: number | null): number {
  if (prevClose === null) return candle.high - candle.low;
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - prevClose),
    Math.abs(candle.low - prevClose),
  );
}

/** Wilder ATR series. Entries before warmup are null. */
export function atrSeries(candles: readonly Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (period <= 0 || candles.length < period + 1) return out;

  const trs: number[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const prevClose = i === 0 ? null : (candles[i - 1] as Candle).close;
    trs.push(trueRange(candles[i] as Candle, prevClose));
  }

  // Seed from TRs 1..period; index 0's range has no previous close to use.
  let atr = 0;
  for (let i = 1; i <= period; i += 1) atr += trs[i] as number;
  atr /= period;
  out[period] = atr;

  for (let i = period + 1; i < candles.length; i += 1) {
    atr = (atr * (period - 1) + (trs[i] as number)) / period;
    out[i] = atr;
  }
  return out;
}

export function atr(candles: readonly Candle[], period: number): number | null {
  const series = atrSeries(candles, period);
  return series.length > 0 ? (series[series.length - 1] ?? null) : null;
}

export interface DonchianChannel {
  upper: number;
  lower: number;
}

/**
 * Highest high and lowest low over the `period` bars ENDING BEFORE the last
 * candle. Excluding the current bar is what makes "close above the channel" a
 * real breakout rather than a tautology — a bar's close can never exceed its
 * own high.
 */
export function donchianExcludingLast(
  candles: readonly Candle[],
  period: number,
): DonchianChannel | null {
  if (period <= 0 || candles.length < period + 1) return null;
  const end = candles.length - 1; // exclusive: drops the current bar
  const start = end - period;

  let upper = -Infinity;
  let lower = Infinity;
  for (let i = start; i < end; i += 1) {
    const c = candles[i] as Candle;
    if (c.high > upper) upper = c.high;
    if (c.low < lower) lower = c.low;
  }
  return { upper, lower };
}

export interface MacdValue {
  macd: number;
  signal: number;
  histogram: number;
}

/** MACD line, signal line and histogram at the latest candle. */
export function macd(
  values: readonly number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): MacdValue | null {
  if (fastPeriod >= slowPeriod) return null;
  const fast = emaSeries(values, fastPeriod);
  const slow = emaSeries(values, slowPeriod);

  // The MACD line only exists where both EMAs do; the signal EMA must be
  // seeded from that truncated series, not from index 0.
  const line: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const f = fast[i];
    const s = slow[i];
    if (f === null || f === undefined || s === null || s === undefined) continue;
    line.push(f - s);
  }
  if (line.length < signalPeriod) return null;

  const signalSeries = emaSeries(line, signalPeriod);
  const macdLine = line[line.length - 1] as number;
  const signal = signalSeries[signalSeries.length - 1];
  if (signal === null || signal === undefined) return null;

  return { macd: macdLine, signal, histogram: macdLine - signal };
}

export type TrendDirection = 'up' | 'down';

/**
 * Supertrend direction series.
 *
 * The canonical recursion, which the popular implementations often get wrong:
 * each final band is carried forward until price closes through it, and the
 * direction flips only when the close crosses the *active* band. Without the
 * carry-forward the indicator whipsaws on every ATR wobble.
 */
export function supertrendSeries(
  candles: readonly Candle[],
  period: number,
  multiplier: number,
): (TrendDirection | null)[] {
  const out: (TrendDirection | null)[] = new Array(candles.length).fill(null);
  const atrs = atrSeries(candles, period);

  let finalUpper: number | null = null;
  let finalLower: number | null = null;
  let direction: TrendDirection | null = null;

  for (let i = 0; i < candles.length; i += 1) {
    const a = atrs[i];
    if (a === null || a === undefined) continue;

    const c = candles[i] as Candle;
    const mid = (c.high + c.low) / 2;
    const basicUpper = mid + multiplier * a;
    const basicLower = mid - multiplier * a;
    const prevClose = i > 0 ? (candles[i - 1] as Candle).close : c.close;

    // Carry the previous band forward unless the new one is tighter or price
    // has already closed through it.
    finalUpper =
      finalUpper === null || basicUpper < finalUpper || prevClose > finalUpper
        ? basicUpper
        : finalUpper;
    finalLower =
      finalLower === null || basicLower > finalLower || prevClose < finalLower
        ? basicLower
        : finalLower;

    if (direction === null) {
      direction = c.close >= finalLower ? 'up' : 'down';
    } else if (direction === 'up') {
      direction = c.close < finalLower ? 'down' : 'up';
    } else {
      direction = c.close > finalUpper ? 'up' : 'down';
    }

    out[i] = direction;
  }
  return out;
}

/** Standard deviation of the last `period` values (population form). */
export function stddev(values: readonly number[], period: number): number | null {
  const mean = sma(values, period);
  if (mean === null) return null;
  let acc = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const d = (values[i] as number) - mean;
    acc += d * d;
  }
  return Math.sqrt(acc / period);
}
