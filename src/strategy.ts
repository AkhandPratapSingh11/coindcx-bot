/**
 * Strategy contract.
 *
 * A strategy returns the position it *wants to be in*, not an order to send.
 * The engine diffs that target against the venue's actual position and emits
 * whatever order closes the gap.
 *
 * This is the whole reason the bot is restart-safe: replaying the same signal
 * twice, or booting into an existing position, converges instead of stacking a
 * second entry. Strategies that emit orders directly cannot make that promise.
 */

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number;
  closeTime: number;
}

export type Target = 'long' | 'short' | 'flat';

export interface Strategy {
  readonly name: string;

  /**
   * Minimum closed candles this strategy needs before it can produce a signal.
   * The engine refuses to start if warmup history is shorter, because a
   * strategy acting on a half-warm 200-period average is not the strategy you
   * backtested — it is a different, worse one.
   */
  readonly requiredCandles: number;

  /**
   * Seeds indicators from history. Called once before the first live candle,
   * with oldest candle first. Must not place orders.
   */
  warmup(candles: readonly Candle[]): void;

  /** True once `warmup` has supplied enough history to act on. */
  isReady(): boolean;

  /**
   * Called once per *closed* candle — never on an in-progress one, so a
   * signal cannot flicker within a bar. Returns the desired position.
   */
  onClosedCandle(candle: Candle): Target;

  /**
   * Optional. The target the strategy currently holds, including the one
   * seeded during `warmup`. Purely for reporting — the engine acts on
   * `onClosedCandle` return values, never on this.
   */
  currentTarget?(): Target | null;
}
