/**
 * Instrument metadata, read straight from CoinDCX.
 *
 * The SDK's `getInstrumentDetails()` maps the wrong field names: it looks for
 * `max_leverage`, `tick_size` and `lot_size`, while the API actually returns
 * `max_leverage_long` / `max_leverage_short`, `price_increment` and
 * `quantity_increment`. The result is `max_leverage: 0` and null increments
 * for every pair, and `ops.sizing.quantizeQuantity()` silently falls back to a
 * hardcoded 0.001 lot — which happens to be right for BTC and wrong elsewhere.
 *
 * So we read the payload ourselves. This also surfaces `min_notional`, which
 * the SDK drops entirely and which rejects small orders outright: BTC requires
 * 60 USDT of notional, so a risk-sized order on a small account is refused by
 * the venue with no hint as to why.
 */

import { log } from './logger.js';

const INSTRUMENT_URL = 'https://api.coindcx.com/exchange/v1/derivatives/futures/data/instrument';

/**
 * CoinDCX rejects `client_order_id` longer than this with
 * "Client order is too long (maximum is 36 characters)".
 *
 * This limit is NOT in the instrument payload, so it cannot be discovered the
 * way min notional and lot size are — it only surfaces on a real submission.
 * A dashed UUID is exactly 36 characters, so any prefix overflows it: the
 * original `bot-${randomUUID()}` was 40 and every live order was rejected.
 * Asserted locally now so the failure is a clear local error, not an opaque
 * venue rejection mid-trade.
 */
export const MAX_CLIENT_ORDER_ID_LENGTH = 36;

export function assertClientOrderId(id: string): void {
  if (id.length === 0) throw new Error('client_order_id must not be empty');
  if (id.length > MAX_CLIENT_ORDER_ID_LENGTH) {
    throw new Error(
      `client_order_id is ${id.length} characters; the venue maximum is ` +
        `${MAX_CLIENT_ORDER_ID_LENGTH}. Shorten the prefix or strip UUID dashes.`,
    );
  }
}

export interface Instrument {
  pair: string;
  status: string;
  /** Quantity step. Order quantities must be a multiple of this. */
  quantityIncrement: number;
  /** Price step. */
  priceIncrement: number;
  minQuantity: number;
  maxQuantity: number;
  /** Minimum order value in quote currency. Orders below this are rejected. */
  minNotional: number;
  maxMarketOrderQuantity: number | null;
  maxLeverageLong: number;
  maxLeverageShort: number;
  takerFee: number | null;
  exitOnly: boolean;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function fetchInstrument(pair: string, marginCurrency: string): Promise<Instrument> {
  const url = `${INSTRUMENT_URL}?pair=${encodeURIComponent(pair)}&margin_currency_short_name[]=${encodeURIComponent(marginCurrency)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Instrument lookup for ${pair} failed: HTTP ${res.status}`);
  }

  const body = (await res.json()) as { instrument?: Record<string, unknown> };
  const i = body.instrument;
  if (!i || typeof i !== 'object') {
    throw new Error(`Instrument lookup for ${pair} returned no instrument payload`);
  }

  const quantityIncrement = num(i['quantity_increment']);
  const priceIncrement = num(i['price_increment']);
  if (quantityIncrement === null || quantityIncrement <= 0) {
    throw new Error(`Instrument ${pair} has no usable quantity_increment`);
  }
  if (priceIncrement === null || priceIncrement <= 0) {
    throw new Error(`Instrument ${pair} has no usable price_increment`);
  }

  const instrument: Instrument = {
    pair: String(i['pair'] ?? pair),
    status: String(i['status'] ?? 'unknown'),
    quantityIncrement,
    priceIncrement,
    minQuantity: num(i['min_quantity']) ?? num(i['min_trade_size']) ?? quantityIncrement,
    maxQuantity: num(i['max_quantity']) ?? Number.POSITIVE_INFINITY,
    minNotional: num(i['min_notional']) ?? 0,
    maxMarketOrderQuantity: num(i['max_market_order_quantity']),
    maxLeverageLong: num(i['max_leverage_long']) ?? 1,
    maxLeverageShort: num(i['max_leverage_short']) ?? 1,
    takerFee: num(i['taker_fee']),
    exitOnly: i['exit_only'] === true,
  };

  log.info('instrument loaded', { ...instrument });
  return instrument;
}

/** Decimal places implied by a step like 0.001 — needed to kill float dust. */
function decimalsOf(step: number): number {
  const s = step.toString();
  if (s.includes('e-')) return Number(s.split('e-')[1] ?? 0);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/**
 * Rounds a quantity DOWN to the instrument's step. Down, not nearest: rounding
 * up can push an order past a size cap or past available margin.
 */
export function quantizeQuantity(instrument: Instrument, quantity: number): number {
  const step = instrument.quantityIncrement;
  const steps = Math.floor(quantity / step + 1e-9);
  return Number((steps * step).toFixed(decimalsOf(step)));
}

export function quantizePrice(instrument: Instrument, price: number): number {
  const step = instrument.priceIncrement;
  return Number((Math.round(price / step) * step).toFixed(decimalsOf(step)));
}

export interface OrderCheck {
  ok: boolean;
  reason: string | undefined;
}

/**
 * Venue-side validity of an order, checked before it is built. Each of these
 * comes back from the API as an opaque rejection, so catching them here is the
 * difference between a clear log line and a strategy that looks broken.
 */
export function checkOrder(
  instrument: Instrument,
  quantity: number,
  price: number,
  leverage: number,
  side: 'buy' | 'sell',
): OrderCheck {
  if (instrument.status !== 'active') {
    return { ok: false, reason: `instrument status is "${instrument.status}", not active` };
  }
  if (instrument.exitOnly) {
    return { ok: false, reason: 'instrument is exit-only; new positions are blocked' };
  }
  if (![quantity, price, leverage].every(Number.isFinite) || quantity <= 0 || price <= 0 || leverage < 1) {
    return { ok: false, reason: 'quantity, price and leverage must be finite and positive' };
  }
  const steps = quantity / instrument.quantityIncrement;
  if (Math.abs(steps - Math.round(steps)) > 1e-7) {
    return { ok: false, reason: 'quantity is not a multiple of the instrument step' };
  }
  if (quantity <= 0) {
    return { ok: false, reason: 'quantity rounded to zero at the instrument step' };
  }
  if (quantity < instrument.minQuantity) {
    return {
      ok: false,
      reason: `quantity ${quantity} is below the minimum ${instrument.minQuantity}`,
    };
  }
  if (quantity > instrument.maxQuantity) {
    return {
      ok: false,
      reason: `quantity ${quantity} exceeds the maximum ${instrument.maxQuantity}`,
    };
  }
  if (
    instrument.maxMarketOrderQuantity !== null &&
    instrument.maxMarketOrderQuantity > 0 &&
    quantity > instrument.maxMarketOrderQuantity
  ) {
    return {
      ok: false,
      reason: `quantity ${quantity} exceeds the market-order maximum ${instrument.maxMarketOrderQuantity}`,
    };
  }

  const notional = quantity * price;
  if (instrument.minNotional > 0 && notional < instrument.minNotional) {
    return {
      ok: false,
      reason:
        `notional ${notional.toFixed(2)} is below the venue minimum ${instrument.minNotional}. ` +
        'Raise RISK_PERCENT, raise LEVERAGE, or fund the account further — the ' +
        'venue will not accept an order this small.',
    };
  }

  const maxLeverage = side === 'buy' ? instrument.maxLeverageLong : instrument.maxLeverageShort;
  if (maxLeverage > 0 && leverage > maxLeverage) {
    return { ok: false, reason: `leverage ${leverage} exceeds the maximum ${maxLeverage}` };
  }

  return { ok: true, reason: undefined };
}
