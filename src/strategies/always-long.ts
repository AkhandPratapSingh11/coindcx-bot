/**
 * Always wants to be long. Not a strategy — a plumbing test.
 *
 * Use it in paper mode to prove the whole order path works end to end
 * (sizing, pre-trade checks, submission, fill, position read-back,
 * reconciliation on restart) without waiting for a real signal to fire.
 *
 *   STRATEGY=always-long DRY_RUN=false npm run paper
 */

import type { Candle, Strategy, Target } from '../strategy.js';

export class AlwaysLongStrategy implements Strategy {
  readonly name = 'always-long (smoke test)';
  readonly requiredCandles = 1;

  warmup(_candles: readonly Candle[]): void {
    // Nothing to seed.
  }

  isReady(): boolean {
    return true;
  }

  onClosedCandle(_candle: Candle): Target {
    return 'long';
  }

  currentTarget(): Target {
    return 'long';
  }
}
